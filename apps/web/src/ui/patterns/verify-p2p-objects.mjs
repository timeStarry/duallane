import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
// Export the actual private ChatPanel only inside this temporary verifier.
// Synthetic callbacks record explicit actions; production exports stay unchanged.
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatPanel} from '/src/App.tsx';
import {AppearanceProvider,initializeAppearance} from '/src/ui/theme/index.ts';
import '/src/styles.css';
initializeAppearance();
const h=React.createElement;
const transfer=(id,status,self,extra={})=>({id,author:self?'自己':'对方',body:'',lane:'p2p',at:'12:00',self,fileTransfer:{id:'transfer-'+id,name:'文件-'+id+'.txt',size:1024,mimeType:'text/plain',status,progress:0,...extra}});
const initial=[{id:'text',author:'对方',body:'仅保留在本机内存的直连正文',lane:'p2p',at:'12:00'},{id:'failed',author:'自己',body:'待重试的直连消息',lane:'p2p',at:'12:01',self:true,localState:'failed'},transfer('offered','offered',false),transfer('saved','complete',false),transfer('retry','failed',true,{retryable:true}),transfer('outgoing','complete',true),transfer('incoming-failed','failed',false,{retryable:true})];
const checks=window.p2pChecks={events:[]};
function Fixture(){
 const [scope,setScope]=useState('p2p:room-a'),[messages,setMessages]=useState(initial),[draft,setDraft]=useState('保留草稿');
 const list=useRef(null);checks.setScope=setScope;checks.remove=id=>setMessages(current=>current.filter(message=>message.id!==id));
 const record=(kind,id)=>checks.events.push({kind,id});
 return h('main',{className:'p2p-mode',style:{height:'100dvh',padding:12}},h(ChatPanel,{scopeKey:scope,title:'直连组件验证',subtitle:'合成房间',status:'已连接',messages,messageListRef:list,draft,onDraft:setDraft,onSend:event=>event.preventDefault(),onFile:()=>{},onRetryMessage:id=>record('retry-message',id),onAcceptFile:id=>record('accept',id),onRejectFile:id=>record('reject',id),onSaveFile:file=>record('save',file.id),onRetryFile:id=>record('retry-file',id),fileLabel:'选择文件'}));
}
createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(AppearanceProvider,null,h(Fixture))));
</script></body></html>`;
const server = await createServer({ root, server: { host: "127.0.0.1", port: 5196, strictPort: true, watch: null, hmr: false }, logLevel: "error", plugins: [{
  name: "p2p-objects-fixture", enforce: "pre",
  transform(source, id) { if (id.replaceAll("\\", "/").endsWith("/src/App.tsx")) return `${source}\nexport {ChatPanel};`; },
  configureServer(server) { server.middlewares.use(async (request, response, next) => { if (request.url !== "/__p2p-objects") return next(); response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(await server.transformIndexHtml("/__p2p-objects", html)); }); }
}] });
await server.listen();
const browser = await chromium.launch();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const errors = [], apiRequests = [];
try {
  for (const width of [1440,390,320]) {
    const page = await browser.newPage({viewport:{width,height:900},hasTouch:width<=760,isMobile:width<=760,reducedMotion:"reduce"});
    page.setDefaultTimeout(10000);
    page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/api/**",route=>{apiRequests.push(new URL(route.request().url()).pathname);return route.abort();});
    await page.addInitScript(()=>{
      window.copied=[]; window.failCopy=false;
      Object.defineProperty(navigator,"clipboard",{value:{writeText:async value=>{if(window.failCopy)throw new Error('denied');window.copied.push(value);}},configurable:true});
      document.execCommand=()=>false;
    });
    await page.goto(origin+"/__p2p-objects");
    const row=id=>page.locator(`article[data-message-id="${id}"]`);
    const menu=page.getByRole("menu",{name:"直连消息操作"});
    await expect(row("text")).toBeVisible();
    await row("text").getByTitle("更多直连消息操作").click();
    await expect(menu.getByRole("menuitem")).toHaveCount(1);
    await menu.getByRole("menuitem",{name:"复制正文",exact:true}).click();
    await expect(page.getByRole("status")).toHaveText("正文已复制");
    assert.deepEqual(await page.evaluate(()=>window.copied),["仅保留在本机内存的直连正文"]);
    await page.evaluate(()=>window.failCopy=true);
    await row("text").getByTitle("更多直连消息操作").click();
    await menu.getByRole("menuitem",{name:"复制正文",exact:true}).click();
    await expect(page.getByRole("status")).toHaveText("复制失败，请选择正文后手动复制");
    await expect(row("text").getByTitle("更多直连消息操作")).toBeFocused();
    const native=row("text").locator("[data-native-context]");
    assert.equal(await native.evaluate(element=>!element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),false);
    await expect(menu).toHaveCount(0);
    await row("failed").press("Shift+F10");
    await menu.getByRole("menuitem",{name:"重试发送",exact:true}).click();
    for(const [id,label,kind] of [["offered","接受文件","accept"],["offered","拒绝文件","reject"],["saved","保存到本机","save"],["retry","重新发送文件","retry-file"]]){
      await row(id).getByTitle("更多直连消息操作").click();
      await menu.getByRole("menuitem",{name:label,exact:true}).click();
      assert.ok((await page.evaluate(()=>window.p2pChecks.events)).some(event=>event.kind===kind&&event.id==='transfer-'+id));
    }
    assert.ok((await page.evaluate(()=>window.p2pChecks.events)).some(event=>event.kind==='retry-message'&&event.id==='failed'));
    await expect(row("outgoing").getByTitle("更多直连消息操作")).toHaveCount(0);
    await expect(row("incoming-failed").getByTitle("更多直连消息操作")).toHaveCount(0);
    await row("text").getByTitle("更多直连消息操作").click();
    await page.evaluate(()=>window.p2pChecks.setScope('p2p:room-b'));
    await expect(menu).toHaveCount(0);await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.locator("textarea")).toHaveValue("保留草稿");
    await row("failed").getByTitle("更多直连消息操作").click();
    await page.evaluate(()=>window.p2pChecks.remove('failed'));
    await expect(menu).toHaveCount(0);await expect(page.getByLabel("直连消息列表",{exact:true})).toBeFocused();
    if(width<=760){
      await page.clock.install();
      await row("text").scrollIntoViewIfNeeded();
      await row("text").locator(".message-meta").dispatchEvent("pointerdown",{pointerType:"touch",pointerId:1,isPrimary:true,button:0,clientX:80,clientY:160});
      await page.clock.runFor(500);await expect(page.getByRole("dialog",{name:"直连消息操作"})).toBeVisible();
      await page.getByRole("button",{name:"关闭操作面板"}).click();await expect(row("text")).toBeFocused();
      await native.dispatchEvent("pointerdown",{pointerType:"touch",pointerId:2,isPrimary:true,button:0,clientX:80,clientY:200});
      await page.clock.runFor(500);await expect(menu).toHaveCount(0);
    }
    const geometry=await page.locator('.p2p-object-heading > .dl-object-more').evaluateAll(buttons=>buttons.map(button=>{const rect=button.getBoundingClientRect(),body=button.closest('article').getBoundingClientRect();return{width:rect.width,height:rect.height,right:rect.right,bound:body.right};}));
    for(const item of geometry){assert.ok(item.width>=44&&item.height>=44);assert.ok(item.right<=item.bound+1);}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.equal(await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>value.includes('仅保留在本机内存的直连正文'))),false);
    await page.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(apiRequests,[]);
  console.log("P2P objects passed: actual ChatPanel at 1440/390/320, copy success/failure, native text, retry and ownership/state-gated file callbacks, scope/removal focus, mobile long press, 44px geometry, draft preserved, no API request or content persistence.");
} finally {await browser.close();await server.close();}
