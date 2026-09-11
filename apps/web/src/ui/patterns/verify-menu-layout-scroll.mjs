import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Production object scope/menu under StrictMode. Layout changes are controlled;
// dismissal checks use actual browser wheel, keyboard, touch and scrollbar input.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useObjectActionScope } from '/src/ui/patterns/index.ts';
import { ObjectActionMenu } from '/src/ui/primitives/index.ts';
import { initializeAppearance } from '/src/ui/theme/index.ts';
import '/src/styles.css';
initializeAppearance();
const h = React.createElement;
const control = window.fixture = { selected: [] };
function Objects() {
  const list = useRef(null), pending = useRef(null);
  const [spacer, setSpacer] = useState(400);
  const [scopeKey, setScopeKey] = useState('account-a');
  const [ids, setIds] = useState(['first', 'second']);
  const scope = useObjectActionScope(scopeKey, ids, list);
  control.remove = () => setIds(['second']);
  control.revoke = () => setScopeKey('account-b');
  control.shift = (added, displacement) => {
    pending.current = list.current.scrollTop + added - displacement;
    setSpacer(value => value + added);
  };
  useLayoutEffect(() => { list.current.scrollTop = pending.current ?? 380; pending.current = null; }, [spacer]);
  return h('section', {ref:list, tabIndex:0, 'aria-label':'滚动列表', style:{height:300,width:560,overflow:'auto',scrollbarGutter:'stable',border:'1px solid',margin:40}},
    h('div', {style:{height:spacer}}),
    ...ids.map(id => h('article', {...scope.bindObject(id),key:id,'aria-label':'对象 '+id,style:{padding:16,height:90,display:'flex',alignItems:'center',justifyContent:'space-between'}},
      h('span',null,'对象 '+id), h('button',{'aria-label':'更多 '+id,onClick:event=>scope.openFromTrigger(id,event.currentTarget),style:{minHeight:44,padding:12}},'更多'))),
    h('div', {style:{height:1200}}),
    h(ObjectActionMenu, {...scope.menuProps,label:'对象操作',actions:[
      {id:'inspect',label:'查看对象',onSelect:()=>control.selected.push(scope.targetId)},
      {id:'reply',label:'回复',onSelect:()=>control.selected.push(scope.targetId)}
    ]}));
}
function Harness() { const [mounted,setMounted] = useState(true); control.mount=setMounted; return mounted ? h(Objects) : h('p',null,'已卸载'); }
createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(Harness)));
</script><style>section::-webkit-scrollbar{width:14px}section::-webkit-scrollbar-thumb{background:#777}section::-webkit-scrollbar-track{background:#eee}</style></body></html>`;
const server = await createServer({ root, server: { host:"127.0.0.1",port:0,strictPort:false,watch:null,hmr:false },logLevel:"error",plugins:[{name:"menu-layout-fixture",configureServer(server){server.middlewares.use(async(request,response,next)=>{if(request.url!=="/__menu-layout")return next();response.setHeader("Content-Type","text/html; charset=utf-8");response.end(await server.transformIndexHtml("/__menu-layout",html));});}}] });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:1280,height:900},reducedMotion:"reduce"});
  page.setDefaultTimeout(8000);
  page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const watched = new Set(['wheel','touchmove','keydown','scroll','pointermove','pointerdown','pointerup','pointercancel','click','visibilitychange']);
    const active = new Map();
    const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);
    document.addEventListener=(name,listener,options)=>{if(watched.has(name)){if(!active.has(name))active.set(name,new Set());active.get(name).add(listener);}add(name,listener,options);};
    document.removeEventListener=(name,listener,options)=>{active.get(name)?.delete(listener);remove(name,listener,options);};
    window.listenerCount=()=>[...active.values()].reduce((count,set)=>count+set.size,0);
  });
  await page.goto(origin+"/__menu-layout");
  const list=page.getByRole("region",{name:"滚动列表"});
  const object=page.getByRole("article",{name:"对象 first"});
  const trigger=page.getByRole("button",{name:"更多 first"});
  const menu=page.getByRole("menu",{name:"对象操作"});
  await expect(trigger).toBeVisible();
  const closedListeners=await page.evaluate(()=>window.listenerCount());
  await trigger.click();
  await expect(menu).toBeVisible();
  const before={menu:await menu.boundingBox(),trigger:await trigger.boundingBox()};
  await page.evaluate(()=>window.fixture.shift(240,36));
  await expect.poll(async()=>Math.abs((await trigger.boundingBox()).y-before.trigger.y-36)).toBeLessThan(1);
  await expect(menu).toBeVisible();
  await expect.poll(async()=>Math.abs((await menu.boundingBox()).y-before.menu.y-36)).toBeLessThan(1);
  await page.keyboard.press("End"); await expect(menu.getByRole("menuitem",{name:"回复",exact:true})).toBeFocused();
  await page.evaluate(()=>window.fixture.shift(150,12));
  await expect(menu).toBeVisible();
  await page.keyboard.press("Home"); await expect(menu.getByRole("menuitem",{name:"查看对象"})).toBeFocused();
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await expect.poll(()=>page.evaluate(()=>window.listenerCount())).toBe(closedListeners);

  await object.click({button:"right",position:{x:8,y:8}}); await expect(menu).toBeVisible();
  const point=await menu.boundingBox();
  await page.evaluate(()=>window.fixture.shift(200,36));
  await expect(menu).toBeVisible();
  assert.ok(Math.abs((await menu.boundingBox()).y-point.y)<1,"point anchor must remain at the opening position");
  let top=await list.evaluate(element=>element.scrollTop);
  await list.hover({position:{x:25,y:220}}); await page.mouse.wheel(0,60);
  await expect.poll(()=>list.evaluate(element=>element.scrollTop)).not.toBe(top); await expect(menu).toHaveCount(0);

  await trigger.click(); await expect(menu).toBeVisible();
  top=await list.evaluate(element=>element.scrollTop);
  await list.focus(); await page.keyboard.press("PageDown");
  await expect.poll(()=>list.evaluate(element=>element.scrollTop)).not.toBe(top); await expect(menu).toHaveCount(0);

  await trigger.click(); await expect(menu).toBeVisible();
  top=await list.evaluate(element=>element.scrollTop);
  const scrollbar=await list.evaluate(element=>{const rect=element.getBoundingClientRect();const track=element.clientHeight;const thumb=track*track/element.scrollHeight;return{x:rect.right-6,y:rect.top+1+element.scrollTop/element.scrollHeight*track+thumb/2};});
  await page.mouse.move(scrollbar.x,scrollbar.y); await page.mouse.down(); await page.mouse.move(scrollbar.x,scrollbar.y+60,{steps:8}); await page.mouse.up();
  await expect.poll(()=>list.evaluate(element=>element.scrollTop)).not.toBe(top); await expect(menu).toHaveCount(0);

  const touchPage=await browser.newPage({viewport:{width:1280,height:900},hasTouch:true,reducedMotion:"reduce"});
  touchPage.on("pageerror",error=>errors.push(error.message));
  await touchPage.goto(origin+"/__menu-layout");
  const touchList=touchPage.getByRole("region",{name:"滚动列表"});
  await touchPage.getByRole("button",{name:"更多 first"}).click();
  await expect(touchPage.getByRole("menu",{name:"对象操作"})).toBeVisible();
  top=await touchList.evaluate(element=>element.scrollTop);
  const box=await touchList.boundingBox(), cdp=await touchPage.context().newCDPSession(touchPage);
  await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:box.x+30,y:box.y+230}]});
  await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:box.x+30,y:box.y+130}]});
  await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  await expect.poll(()=>touchList.evaluate(element=>element.scrollTop)).not.toBe(top);
  await expect(touchPage.getByRole("menu",{name:"对象操作"})).toHaveCount(0);
  await touchPage.close();

  await trigger.click(); await expect(menu).toBeVisible(); await page.evaluate(()=>window.fixture.remove());
  await expect(menu).toHaveCount(0); await expect(list).toBeFocused();
  await page.getByRole("button",{name:"更多 second"}).click(); await expect(menu).toBeVisible();
  await page.evaluate(()=>window.fixture.revoke()); await expect(menu).toHaveCount(0);
  await page.evaluate(()=>window.fixture.mount(false)); await expect(page.getByText("已卸载")).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.listenerCount())).toBe(0);
  await page.evaluate(()=>window.fixture.mount(true)); await expect(trigger).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.listenerCount())).toBe(closedListeners);
  await trigger.click(); await expect(menu).toBeVisible();
  await page.evaluate(()=>window.fixture.mount(false)); await expect(menu).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>window.listenerCount())).toBe(0);
  assert.deepEqual(await page.evaluate(()=>window.fixture.selected),[]);
  assert.deepEqual(errors,[]);
  console.log("Menu layout passed: 36px/12px programmatic compensation, button re-anchor, fixed pointer anchor, keyboard menu navigation, real wheel/PageDown/scrollbar/touch dismissal, removal/revocation and StrictMode cleanup.");
} finally { await browser.close(); await server.close(); }
