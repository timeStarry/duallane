import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Production menu/scope/style components with controlled layout changes. No API
// or synthetic pin writer: Go flows independently verify the action's authority.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../../../../../.private-test-results/menu-viewport/", import.meta.url));
await mkdir(output, { recursive: true });
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React, {useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ObjectActionMenu} from '/src/ui/primitives/index.ts';
import {useObjectActionScope} from '/src/ui/patterns/index.ts';
import {initializeAppearance} from '/src/ui/theme/index.ts';
import '/src/styles.css';
initializeAppearance();
const h=React.createElement;
window.checks={executed:[]};
function Fixture(){
  const list=useRef(null),trigger=useRef(null);
  const [present,setPresent]=useState(true);
  const actions=useObjectActionScope('history',present?['history-26']:[],list);
  useLayoutEffect(()=>{list.current.scrollTop=1000;},[]);
  window.checks.moveBelow=()=>{list.current.scrollTop=0;};
  window.checks.moveAbove=()=>{list.current.scrollTop=1700;};
  window.checks.restore=()=>{list.current.scrollTop=1000;};
  window.checks.remove=()=>setPresent(false);
  window.checks.open=()=>actions.openFromTrigger('history-26',trigger.current);
  const entries=Array.from({length:12},(_,index)=>({id:'action-'+index,label:index===11?'设为常驻消息':'消息操作 '+index,onSelect:()=>window.checks.executed.push({id:actions.targetId,index})}));
  return h('main',{style:{padding:32}},
    h('section',{ref:list,tabIndex:0,'aria-label':'消息历史',style:{height:480,maxWidth:600,overflow:'auto',overflowAnchor:'none'}},
      h('div',{style:{height:1000},'aria-hidden':true}),
      present&&h('button',{ref:trigger,...actions.bindObject('history-26'),'data-object-action-root':true,title:'更多消息操作',onClick:event=>actions.openFromTrigger('history-26',event.currentTarget),style:{height:44}},'历史消息 26'),
      h('div',{style:{height:1600},'aria-hidden':true})),
    h(ObjectActionMenu,{...actions.menuProps,label:'消息操作',summary:'历史消息 26',actions:entries}));
}
const app=createRoot(document.getElementById('root'));
window.unmount=()=>app.unmount();
app.render(h(React.StrictMode,null,h(Fixture)));
</script></body></html>`;
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false }, logLevel: "error", plugins: [{ name: "menu-viewport-fixture", configureServer(server) { server.middlewares.use(async (request, response, next) => { if (request.url !== "/__menu-viewport") return next(); response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(await server.transformIndexHtml("/__menu-viewport", html)); }); } }] });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const errors = [], results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/__menu-viewport`);
  const menu = page.getByRole("menu", { name: "消息操作" });
  const trigger = page.getByTitle("更多消息操作");
  const history = page.getByRole("region", { name: "消息历史" });
  const measure = () => page.evaluate(() => {
    const rect = document.querySelector('[role="menu"]').getBoundingClientRect();
    const anchor = document.querySelector('[title="更多消息操作"]').getBoundingClientRect();
    return { menu: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, anchor: { top: anchor.top, bottom: anchor.bottom }, viewport: { width: innerWidth, height: innerHeight } };
  });
  const inside = async () => {
    await expect.poll(async () => {
      const { menu: rect, viewport } = await measure();
      return rect.top >= 12 && rect.bottom <= viewport.height - 12 && rect.left >= 12 && rect.right <= viewport.width - 12;
    }).toBe(true);
  };
  for (const direction of ["below", "above"]) {
    await page.evaluate(() => window.checks.restore());
    await trigger.click();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    // The same connected object survives a programmatic history scroll. It is
    // deliberately moved by >600px, not a rounding tolerance or user gesture.
    await page.evaluate(direction => window.checks[direction === "below" ? "moveBelow" : "moveAbove"](), direction);
    await expect.poll(() => history.evaluate(element => element.scrollTop)).toBe(direction === "below" ? 0 : 1700);
    await expect(menu).toBeVisible();
    await page.screenshot({ path: `${output}/anchor-${direction}.png` });
    results.push({ direction, ...await measure() });
    await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2));
    await inside();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "设为常驻消息", exact: true })).toBeFocused();
    await menu.getByRole("menuitem", { name: "设为常驻消息", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  assert.deepEqual(await page.evaluate(() => window.checks.executed), [{ id: "history-26", index: 11 }, { id: "history-26", index: 11 }]);
  // A visible menu becomes internally scrollable when the viewport contracts.
  // End/Home must keep focus inside the menu without dismissing it as a user
  // scroll of the history behind it.
  await page.evaluate(() => window.checks.restore());
  await trigger.press("Shift+F10");
  await page.setViewportSize({ width: 800, height: 300 });
  await inside();
  await page.keyboard.press("End");
  const pin = menu.getByRole("menuitem", { name: "设为常驻消息", exact: true });
  await expect(pin).toBeFocused();
  await expect(pin).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await expect(menu.getByRole("menuitem").first()).toBeInViewport({ ratio: 1 });
  await inside();
  await page.screenshot({ path: `${output}/short-viewport-keyboard.png` });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.checks.restore());
  await trigger.click();
  await history.hover({ position: { x: 450, y: 300 } });
  await page.mouse.wheel(0, 160);
  await expect(menu).toHaveCount(0);
  await page.evaluate(() => window.checks.restore());
  await trigger.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.evaluate(() => window.checks.remove());
  await expect(menu).toHaveCount(0);
  await expect(history).toBeFocused();
  await page.evaluate(() => window.unmount());
  for (const width of [390, 320]) {
    const phone = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
    phone.on("pageerror", error => errors.push(error.message));
    await phone.goto(`${origin}/__menu-viewport`);
    await phone.getByTitle("更多消息操作").click();
    const sheet = phone.getByRole("dialog", { name: "消息操作" });
    await expect(sheet).toBeVisible();
    await phone.getByRole("menuitem").first().press("End");
    await expect(phone.getByRole("menuitem", { name: "设为常驻消息", exact: true })).toBeFocused();
    await expect(phone.getByRole("menuitem", { name: "设为常驻消息", exact: true })).toBeInViewport({ ratio: 1 });
    await phone.screenshot({ path: `${output}/mobile-sheet-${width}.png` });
    await phone.getByRole("button", { name: "关闭操作面板", exact: true }).click();
    await expect(phone.getByTitle("更多消息操作")).toBeFocused();
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await phone.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2));
  console.log("Menu viewport passed: offscreen retained anchors, keyboard End/click/focus, deliberate wheel dismissal, removed-object invalidation, StrictMode unmount.");
} finally { await browser.close(); await server.close(); }
