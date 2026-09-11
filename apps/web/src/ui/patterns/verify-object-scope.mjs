import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { File } from 'lucide-react';
import { useObjectActionScope } from '/src/ui/patterns/index.ts';
import { ObjectActionMenu } from '/src/ui/primitives/index.ts';
import { initializeAppearance } from '/src/ui/theme/index.ts';
import '/src/styles.css';
initializeAppearance();
const h = React.createElement;
const checks = window.checks = { primary: [], executed: [] };
function Fixture() {
  const [scopeKey, setScope] = useState('first');
  const [ids, setIds] = useState(['a', 'b', 'native', 'disabled']);
  const list = useRef(null);
  const scope = useObjectActionScope(scopeKey, ids, list);
  checks.targetId = scope.targetId;
  checks.remove = id => setIds(current => current.filter(value => value !== id));
  checks.addRows = () => setIds(current => [...current, ...Array.from({length: 100}, (_, index) => 'extra-' + index)]);
  checks.changeScope = () => { setScope('second'); setIds(['c', 'native']); };
  checks.returnScope = () => { setScope('first'); setIds(['a', 'b', 'native', 'disabled']); };
  const actions = [{ id: 'inspect', label: '查看对象 ' + scope.targetId, onSelect: () => checks.executed.push(scope.targetId) }];
  return h('main', {style: {padding: 24}},
    h('input', { 'aria-label': '列表外输入', placeholder: '外部输入' }),
    h('section', {ref: list, tabIndex: 0, 'aria-label': '对象列表', style: {maxHeight: 450, overflow: 'auto', marginTop: 20}},
      ...ids.map(id => id === 'native' ? h('article', {key: id, ...scope.bindObject(id), 'data-native-row': true},
        h('button', {'data-ordinary': true}, '普通按钮'),
        h('a', {href: '#native', 'data-object-action-root': true}, '原生链接'),
        h('input', {'aria-label': '原生输入'}),
        h('p', {'data-native-context': true}, '原生正文可以选择')) : h('div', {key: id, style: {display:'flex', gap:12, margin: 12}},
        h('button', {...scope.bindObject(id), 'data-object-action-root': true, 'data-object': id, disabled: id === 'disabled', 'aria-label': '打开对象 ' + id, onClick: () => checks.primary.push(id), style: {minHeight:44,display:'flex',alignItems:'center',gap:8}}, h(File, {size:18}), h('span',null,'文件 ' + id)),
        h('button', {onClick: event => scope.openFromTrigger(id,event.currentTarget)}, '更多 ' + id))),
      h(ObjectActionMenu, {...scope.menuProps, label: '对象操作', summary: '对象 ' + scope.targetId, actions})))
}
createRoot(document.getElementById('root')).render(h(React.StrictMode, null, h(Fixture)));
</script></body></html>`;
const server = await createServer({ root, server: {host: "127.0.0.1", port: 0, strictPort: false}, logLevel: "error", plugins: [{name:"object-scope-fixture", configureServer(server) { server.middlewares.use(async (request,response,next) => { if (request.url !== "/__object-scope") return next(); response.setHeader("Content-Type","text/html; charset=utf-8"); response.end(await server.transformIndexHtml("/__object-scope", html)); }); }}] });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const events = new Set(["pointermove", "pointerdown", "click", "pointerup", "pointercancel", "scroll", "visibilitychange"]);
    const active = new Map();
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    document.addEventListener = (name, listener, options) => { if (events.has(name)) { if (!active.has(name)) active.set(name,new Set()); active.get(name).add(listener); } add(name,listener,options); };
    document.removeEventListener = (name, listener, options) => { active.get(name)?.delete(listener); remove(name,listener,options); };
    window.listenerCount = () => [...active.values()].reduce((count,listeners) => count + listeners.size,0);
  });
  await page.goto(`${origin}/__object-scope`);
  const menu = page.getByRole("menu", {name:"对象操作"});
  const first = page.getByRole("button", {name:"打开对象 a",exact:true});
  const second = page.getByRole("button", {name:"打开对象 b",exact:true});
  await first.click(); assert.deepEqual(await page.evaluate(() => window.checks.primary), ["a"]);
  await first.locator("svg").click({button:"right"});
  await expect(menu.getByRole("menuitem", {name:"查看对象 a"})).toBeFocused();
  assert.deepEqual(await page.evaluate(() => window.checks.primary), ["a"]);
  await page.keyboard.press("Escape"); await expect(first).toBeFocused();
  await second.press("Shift+F10"); await expect(menu.getByRole("menuitem", {name:"查看对象 b"})).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name:"更多 a",exact:true}).click(); await expect(menu.getByRole("menuitem", {name:"查看对象 a"})).toBeVisible();
  await page.keyboard.press("Escape");

  for (const locator of [page.getByRole("button", {name:"普通按钮"}),page.getByRole("link",{name:"原生链接"}),page.getByRole("textbox",{name:"原生输入"}),page.locator("[data-native-context]"),page.getByRole("button",{name:"打开对象 disabled"})]) {
    const prevented = await locator.evaluate(element => !element.dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,cancelable:true})));
    assert.equal(prevented,false);
    await expect(menu).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.checks.targetId), "a");
  }
  await second.locator("span").evaluate(element => { const selection = document.getSelection(); const range=document.createRange(); range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range); });
  assert.equal(await second.evaluate(element => !element.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))),false);
  await expect(menu).toHaveCount(0); assert.equal(await page.evaluate(() => window.checks.targetId),"a");
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await first.press("Shift+F10"); await expect(menu).toBeVisible();
  await page.evaluate(() => window.checks.remove("a")); await expect(menu).toHaveCount(0);
  await expect(page.getByRole("region", {name:"对象列表"})).toBeFocused();
  await second.press("Shift+F10"); await expect(menu).toBeVisible();
  await page.evaluate(() => window.checks.changeScope()); await expect(menu).toHaveCount(0);
  await page.evaluate(() => window.checks.returnScope()); await expect(menu).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.checks.targetId), "");
  const initialListeners = await page.evaluate(() => window.listenerCount());
  await page.evaluate(() => window.checks.addRows());
  await expect(page.locator("[data-object]")).toHaveCount(103);
  assert.equal(await page.evaluate(() => window.listenerCount()), initialListeners);

  const phone = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  phone.on("pageerror", error => errors.push(error.message));
  await phone.goto(`${origin}/__object-scope`);
  await phone.clock.install();
  const marked = phone.getByRole("button", {name:"打开对象 a",exact:true});
  await marked.dispatchEvent("pointerdown",{pointerType:"touch",pointerId:1,isPrimary:true,button:0,clientX:60,clientY:140});
  await phone.clock.runFor(500);
  await expect(phone.getByRole("dialog",{name:"对象操作"})).toBeVisible();
  await expect(phone.getByRole("menuitem",{name:"查看对象 a"})).toBeFocused();
  await phone.getByRole("button",{name:"关闭操作面板"}).click();
  await expect(marked).toBeFocused();
  assert.deepEqual(await phone.evaluate(()=>window.checks.primary),[]);
  const next = phone.getByRole("button",{name:"打开对象 b",exact:true});
  await next.dispatchEvent("pointerdown",{pointerType:"touch",pointerId:2,isPrimary:true,button:0,clientX:60,clientY:200});
  await phone.evaluate(() => window.checks.remove("b"));
  await phone.clock.runFor(500); await expect(phone.getByRole("dialog",{name:"对象操作"})).toHaveCount(0);
  await marked.locator("span").evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);});
  await marked.dispatchEvent("pointerdown",{pointerType:"touch",pointerId:3,isPrimary:true,button:0,clientX:60,clientY:140});
  await phone.clock.runFor(500); await expect(phone.getByRole("dialog",{name:"对象操作"})).toHaveCount(0);
  assert.deepEqual(errors,[]);
  console.log("Object scope passed: opt-in button icon/text, native controls/selection, stable target, keyboard/more/touch, removed-object focus, scope replacement, pending invalidation, fixed document listener count across 100 added rows.");
} finally { await browser.close(); await server.close(); }
