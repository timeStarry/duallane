import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Real pointer input and the production object-action controller. Only the JS
// clock is controlled: a finger may stay down arbitrarily long after recognition.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../../../../../.private-test-results/longpress-release/", import.meta.url));
await mkdir(output, { recursive: true });
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ObjectActionMenu} from '/src/ui/primitives/index.ts';
import {useObjectActionScope} from '/src/ui/patterns/index.ts';
import {initializeAppearance} from '/src/ui/theme/index.ts';
import '/src/styles.css';
initializeAppearance();
const h=React.createElement;
window.checks={primary:[],executed:[]};
function Fixture(){
  const list=useRef(null),[ids,setIds]=useState(['a','b']);
  const actions=useObjectActionScope('gesture-fixture',ids,list);
  window.checks.remove=()=>setIds(['b']);
  return h('main',{style:{padding:24}},h('section',{ref:list,tabIndex:0,'aria-label':'对象列表'},
    ...ids.map(id=>h('button',{key:id,...actions.bindObject(id),'data-object-action-root':true,'aria-label':'对象 '+id,onClick:()=>window.checks.primary.push(id),style:{minWidth:120,minHeight:48,marginRight:8}},'对象 '+id))),
    h(ObjectActionMenu,{...actions.menuProps,label:'对象操作',summary:actions.targetId,actions:[{id:'inspect',label:'检查 '+actions.targetId,onSelect:()=>window.checks.executed.push(actions.targetId)}]}));
}
const app=createRoot(document.getElementById('root'));
window.unmount=()=>app.unmount();
app.render(h(React.StrictMode,null,h(Fixture)));
</script></body></html>`;
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false }, logLevel: "error", plugins: [{ name: "longpress-release-fixture", configureServer(server) { server.middlewares.use(async (request, response, next) => { if (request.url !== "/__longpress-release") return next(); response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(await server.transformIndexHtml("/__longpress-release", html)); }); } }] });
await server.listen();
const browser = await chromium.launch();
const errors = [], results = [];
try {
  const setup = async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__longpress-release`);
    const cdp = await page.context().newCDPSession(page);
    const point = async (id) => {
      const button = page.getByRole("button", { name: `对象 ${id}`, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      return { x: box.x + 12, y: box.y + 12, id: id === "a" ? 1 : 2 };
    };
    const start = async (id = "a") => {
      const touch = await point(id);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
      return touch;
    };
    const end = () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return { page, cdp, point, start, end, menu: page.getByRole("dialog", { name: "对象操作" }) };
  };
  for (const hold of [500, 1600, 10000]) {
    const { page, cdp, start, end, menu } = await setup();
    await start();
    await page.clock.runFor(500);
    await expect(menu).toBeVisible();
    if (hold > 500) await page.clock.runFor(hold - 500);
    await end();
    await cdp.detach();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    assert.deepEqual(await page.evaluate(() => window.checks.primary), []);
    assert.deepEqual(await page.evaluate(() => window.checks.executed), []);
    // A new deliberate tap is immediately usable; suppression belongs only to
    // the release above and cannot swallow subsequent menu actions.
    await menu.getByRole("menuitem", { name: "检查 a", exact: true }).tap();
    await expect(menu).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.checks.executed), ["a"]);
    await page.getByRole("button", { name: "对象 b", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.checks.primary), ["b"]);
    results.push({ hold, releasePreservedMenu: true, subsequentTouchAndMouse: true });
    await page.close();
  }
  for (const interruption of ["blur", "visibilitychange"]) {
    const { page, cdp, start, end, menu } = await setup();
    await start(); await page.clock.runFor(1600); await expect(menu).toBeVisible();
    // No pointerup is delivered while switching away. The old target must not
    // retain an unbounded native-context block when the document returns.
    await page.evaluate(name => (name === "blur" ? window : document).dispatchEvent(new Event(name)), interruption);
    await page.keyboard.press("Escape");
    const nativePrevented = await page.getByRole("button", { name: "对象 a", exact: true }).evaluate(element => {
      element.setAttribute("data-native-context", "");
      const prevented = !element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      element.removeAttribute("data-native-context");
      return prevented;
    });
    assert.equal(nativePrevented, false);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await start(); await page.clock.runFor(1600); await end();
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "检查 a", exact: true }).tap();
    await expect(menu).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.checks.executed), ["a"]);
    await cdp.detach();
    results.push({ interruption, nativeContextRestored: true, subsequentLongPress: true });
    await page.close();
  }
  for (const cancel of ["move", "pointercancel", "second-finger"]) {
    const { page, cdp, point, start, end, menu } = await setup();
    const touch = await start();
    await page.clock.runFor(100);
    if (cancel === "move") await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...touch, y: touch.y + 60 }] });
    else if (cancel === "pointercancel") await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    else await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch, await point("b")] });
    await page.clock.runFor(1000);
    await expect(menu).toHaveCount(0);
    if (cancel !== "pointercancel") await end();
    await cdp.detach();
    await page.getByRole("button", { name: "对象 b", exact: true }).click();
    assert.equal((await page.evaluate(() => window.checks.primary)).at(-1), "b");
    results.push({ cancel, menuOpened: false, subsequentMouse: true });
    await page.close();
  }
  {
    const { page, cdp, start, end, menu } = await setup();
    await start(); await page.clock.runFor(1600); await expect(menu).toBeVisible();
    await page.evaluate(() => window.checks.remove());
    await expect(menu).toHaveCount(0);
    await end();
    assert.deepEqual(await page.evaluate(() => window.checks.primary), []);
    await start("b"); await page.clock.runFor(1600); await end();
    await expect(menu.getByRole("menuitem", { name: "检查 b", exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.checks.executed), ["b"]);
    await cdp.detach();
    await page.evaluate(() => window.unmount());
    results.push({ removedObjectReleaseIgnored: true, subsequentObjectAndKeyboard: true, strictModeUnmount: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2));
  console.log("Long-press release passed: 0.5/1.6/10s hold, release/focus protection, subsequent touch/mouse/keyboard, movement/cancel/multiple fingers, blur/visibility interruption, removed/new object, StrictMode cleanup.");
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2));
  await browser.close(); await server.close();
}
