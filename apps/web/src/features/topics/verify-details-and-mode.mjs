import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../../../../../.private-test-results/topic-details-mode/", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const html = String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="workspace-mode"><div id="root" style="height:100dvh;width:100%"></div><script type="module">
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '/src/styles.css';
import {AppearanceProvider,initializeAppearance} from '/src/ui/theme/index.ts';
import {AppearanceSettings} from '/src/features/settings/AppearanceSettings.tsx';
import {SettingsLayout} from '/src/features/settings/SettingsLayout.tsx';
import {TopicDetails} from '/src/features/topics/TopicDetails.tsx';
initializeAppearance();
const h=React.createElement;
const initial={id:'topic-1',title:'集中讨论阅读与输入体验的细节',description:'把通知、参与和管理动作放在需要时打开的详情里。\n主会话专注阅读与发送。',status:'open',joined:true,canJoin:false,participantCount:12,creator:{displayName:'合成验收成员'},createdAt:'2026-09-11T08:00:00Z',notificationLevel:'all'};
window.fixture={actions:[]};
function Fixture(){
 const [topic,setTopic]=useState(initial),[scope,setScope]=useState('actor-1:topic-1');
 const [rights,setRights]=useState({canJoin:false,canLeave:true,canClose:true,canArchive:true});
 window.fixture.patch=(change)=>setTopic(current=>({...current,...change}));
 window.fixture.rights=setRights;
 window.fixture.scope=()=>setScope(current=>current+'-next');
 const action=(name,change)=>async()=>{window.fixture.actions.push(name);if(window.fixture.delay){window.fixture.delay=false;await new Promise((resolve,reject)=>{window.fixture.resolve=resolve;window.fixture.reject=reject;});}if(change)setTopic(current=>({...current,...change}));};
 if(new URLSearchParams(location.search).get('view')==='appearance')return h(SettingsLayout,{section:'appearance',currentUser:{displayName:'合成验收成员',githubLogin:'fixture'},onNavigate:()=>{},onBack:()=>{}},h(AppearanceSettings));
 return h('main',{style:{display:'grid',gridTemplateRows:'auto 1fr auto',height:'100%',background:'var(--surface)'}},
 h('header',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,padding:12,borderBottom:'1px solid var(--line)'}},h('strong',null,'话题组件验收'),h(TopicDetails,{scopeKey:scope,topic,groupTitle:'跨端设计讨论',...rights,onOpenConversation:action('open-group'),onJoin:action('join',{joined:true,canJoin:false}),onLeave:action('leave',{joined:false,canJoin:true}),onNotificationChange:level=>action('notification:'+level,{notificationLevel:level})(),onCloseTopic:action('close',{status:'closed'}),onArchiveTopic:action('archive',{status:'archived'})})),
 h('p',{style:{padding:20}},'此处是受控组件验证，服务端权限由真实 API 另行校验。'),
 h('div',{className:'workspace-composer-dock'},h('form',{className:'workspace-composer'},h('textarea',{'aria-label':'保留草稿',defaultValue:'尚未发送的话题草稿',style:{width:'100%',gridColumn:'1 / -1'}}))));
}
createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(AppearanceProvider,null,h(Fixture))));
</script></body></html>`;
const probe = createPortProbe();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
assert(![5173, 5198].includes(port));
const server = await createServer({ root, cacheDir: "node_modules/.vite-topic-details-mode", server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false }, logLevel: "error", plugins: [{ name: "topic-details-mode-fixture", configureServer(instance) {
  instance.middlewares.use("/__details", async (_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(await instance.transformIndexHtml("/__details", html)); });
} }] });
await server.listen();
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = { modes: [], details: [], errors: [], note: "Production components and CSS in a controlled fixture; no real authentication, notifications, membership or moderation requests." };
const prefs = page => page.evaluate(() => JSON.parse(localStorage.getItem("duallane-appearance")));
async function appearance(page, patch) {
  await page.evaluate(patch => { const key='duallane-appearance', oldValue=localStorage.getItem(key), newValue=JSON.stringify({...JSON.parse(oldValue),...patch});localStorage.setItem(key,newValue);window.dispatchEvent(new StorageEvent('storage',{key,oldValue,newValue,storageArea:localStorage})); }, patch);
  if (patch.themeId) await expect(page.locator("html")).toHaveAttribute("data-theme-family", patch.themeId);
  if (patch.mode !== "system") await expect(page.locator("html")).toHaveAttribute("data-theme", patch.mode);
}
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width <= 760, hasTouch: width <= 760, reducedMotion: "reduce", colorScheme: "light" });
    page.on("pageerror", error => results.errors.push(error.message));
    await page.addInitScript(() => { if(!localStorage.getItem('duallane-appearance'))localStorage.setItem('duallane-appearance',JSON.stringify({version:1,themeId:'original',mode:'light',density:'comfortable',motion:'reduced',transparency:'opaque'})); });
    try {
      await page.goto(`http://127.0.0.1:${port}/__details?view=appearance`);
      const group = page.getByRole("radiogroup", { name: "显示模式" });
      const light = group.getByRole("radio", { name: "浅色", exact: true });
      const dark = group.getByRole("radio", { name: "深色", exact: true });
      const system = group.getByRole("radio", { name: "跟随系统", exact: true });
      const before = await prefs(page);
      await dark.click();
      assert.deepEqual(await prefs(page), { ...before, mode: "dark" }, "Mode cannot change theme/density/material preferences");
      await dark.press("ArrowRight"); await expect(system).toBeFocused();
      await expect(system).toHaveAttribute("aria-checked", "true");
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      assert.equal((await prefs(page)).mode, "system");
      await page.reload();
      await expect(system).toHaveAttribute("aria-checked", "true");
      await system.press("Home"); await expect(system).toBeFocused();
      await system.press("End"); await expect(dark).toBeFocused();
      await dark.press("ArrowLeft"); await expect(light).toBeFocused();
      for (const themeId of ["original", "grove", "dusk", "beige", "minimal"]) for (const mode of ["light", "dark"]) {
        await appearance(page, { themeId, mode });
        await group.scrollIntoViewIfNeeded();
        const geometry = await group.evaluate(element => ({ viewportWidth:innerWidth, pageWidth:document.documentElement.scrollWidth, width:element.getBoundingClientRect().width, controls:[...element.querySelectorAll('button')].map(button=>{const r=button.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right};}) }));
        assert(geometry.pageWidth<=width);
        for (const control of geometry.controls) assert(control.width>=44 && control.height>=44 && control.left>=0 && control.right<=width);
        assert.equal(await group.locator('[tabindex="0"]').count(),1);
        results.modes.push({themeId,mode,...geometry});
        if (["beige","minimal"].includes(themeId)) await page.screenshot({path:`${output}/mode-${themeId}-${mode}-${width}.png`});
      }
      await page.goto(`http://127.0.0.1:${port}/__details`);
      const trigger=page.getByRole('button',{name:'话题详情',exact:true});
      const dialog=page.getByRole('dialog',{name:'话题详情',exact:true});
      await expect(dialog).toHaveCount(0);
      await page.getByRole('textbox',{name:'保留草稿'}).fill('详情开关不应清空草稿');
      for (const themeId of ["original", "grove", "dusk", "beige", "minimal"]) for (const mode of ["light", "dark"]) {
        await appearance(page,{themeId,mode});
        await trigger.click();await expect(dialog).toBeVisible();
        await expect(page.getByRole('button',{name:'关闭话题详情',exact:true})).toBeFocused();
        await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('button',{name:'归档话题',exact:true})).toBeFocused();
        await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'关闭话题详情',exact:true})).toBeFocused();
        for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert(await dialog.evaluate(element=>element.contains(document.activeElement)),`Dialog retains keyboard focus after Tab ${i+1}: ${await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,240))}`);}
        const geometry=await dialog.evaluate(element=>{const r=element.getBoundingClientRect();return {viewportWidth:innerWidth,pageWidth:document.documentElement.scrollWidth,left:r.left,right:r.right,width:r.width,height:r.height,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth};});
        assert(geometry.pageWidth<=width && geometry.scrollWidth<=geometry.clientWidth+1);
        assert.equal(geometry.width,width>760?360:width);assert.equal(geometry.right,width);
        await dialog.locator('.dl-topic-details-body').evaluate(element=>element.scrollTop=0);
        if (["beige","minimal"].includes(themeId)) await page.screenshot({path:`${output}/details-${themeId}-${mode}-${width}.png`});
        for(const button of await dialog.getByRole('button').all()){const r=await button.boundingBox();assert(r.width>=44 && r.height>=44);}
        await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused();
        await expect(page.getByRole('textbox',{name:'保留草稿'})).toHaveValue('详情开关不应清空草稿');
        results.details.push({themeId,mode,...geometry});
      }
      await trigger.click();
      await dialog.getByRole('radio',{name:'免打扰',exact:true}).click();
      await expect(dialog.getByRole('radio',{name:'免打扰',exact:true})).toHaveAttribute('aria-checked','true');
      await page.getByRole('button',{name:'关闭话题详情',exact:true}).click();await expect(trigger).toBeFocused();
      await page.evaluate(()=>{window.fixture.patch({joined:false,canJoin:true});window.fixture.rights({canJoin:true,canLeave:false,canClose:false,canArchive:false});});
      await trigger.click();await expect(dialog.getByRole('radiogroup',{name:'话题提醒'})).toHaveCount(0);
      await expect(dialog.getByRole('button',{name:'关闭话题',exact:true})).toHaveCount(0);
      await dialog.getByRole('button',{name:'加入话题',exact:true}).click();await expect(dialog.getByRole('radiogroup',{name:'话题提醒'})).toBeVisible();
      await page.keyboard.press('Escape');
      await page.evaluate(()=>{window.fixture.patch({status:'closed'});window.fixture.rights({canJoin:true,canLeave:true,canClose:true,canArchive:true});});
      await trigger.click();
      for(const name of ['加入话题','退出话题','关闭话题'])await expect(dialog.getByRole('button',{name,exact:true})).toHaveCount(0);
      await expect(dialog.getByRole('button',{name:'归档话题',exact:true})).toBeVisible();
      await page.evaluate(()=>{window.fixture.delay=true;});
      await dialog.getByRole('radio',{name:'全部',exact:true}).click();
      await expect(dialog.getByRole('button',{name:'归档话题',exact:true})).toBeDisabled();
      await page.evaluate(()=>window.fixture.scope());await expect(dialog).toHaveCount(0);await expect(trigger).toHaveCount(1);
      await page.evaluate(()=>window.fixture.reject(new Error('旧scope迟到失败')));
      await trigger.click();await expect(dialog.getByRole('alert')).toHaveCount(0);
      if(width>760){await page.mouse.click(20,100);await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused();}else await page.keyboard.press('Escape');
      console.log(`Details/mode verified at ${width}px.`);
    } finally {await page.close();}
  }
  assert.deepEqual(results.errors,[]);
  console.log(`Details/mode passed: ${results.modes.length} mode layouts, ${results.details.length} drawer layouts, preference/keyboard/scope/focus/permission-state checks. Controlled production components only.`);
} finally {await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));await browser.close();await server.close();}
