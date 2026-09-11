import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createPortProbe } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
// Synthetic transport fixtures exercise the real production components. Real Go
// authorization, persistence and Gateway behavior remain the separate E2E gate.
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="workspace-mode"><main id="frame"></main><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
import '/src/features/settings/settings.css';
import { WorkspaceBotSettings } from '/src/WorkspaceBotSettings.tsx';
import { WorkspaceEchoRequirements } from '/src/WorkspaceEchoRequirements.tsx';
import { WorkspaceEchoInteraction } from '/src/WorkspaceEchoInteraction.tsx';
import { initializeAppearance } from '/src/ui/theme/index.ts';
initializeAppearance();
const h = React.createElement;
const bot = { id:'layout-bot',botUserId:'bot-user',ownerUserId:'owner',name:'映河协作助手',status:'active' };
const settings = {botId:bot.id,visibilityPolicy:'private',allowDirect:true,allowGroup:true,requireOwnerApproval:true,allowedMemberIds:[],description:'整理群聊反馈，协助成员跟进需求。',welcomeMessage:'你好，请说明你希望处理的事项。',showCreator:true,context:{maxMessages:50},limits:{requestsPerMinute:30,memberDailyRequests:100,inputTokenLimit:6000,outputTokenLimit:2000,maxConcurrency:3,eventBacklogLimit:100}};
const requirement = {id:'req-1',publicId:'R-001',submitterUserId:'member',submitterDisplayName:'林澈',type:'suggestion',title:'相册增加按月份快速查找',detail:'图片数量较多时，希望可以按月份快速回到某一段时间。',scenario:'回看每月活动照片',expectedResult:'从相册直接选择月份',phase:'proposal',status:'pending_review',revision:1,createdAt:'2026-09-11T03:00:00Z',updatedAt:'2026-09-11T03:00:00Z'};
window.checks = {writes:[],reads:[],guard:null};
const json = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
window.fetch = async (path,options={}) => {
 const url = new URL(path,location.origin); const p=url.pathname;
 if(p==='/api/workspace/interactions/commands') return json({command:{ok:true,result:{}}});
 if(options.method && options.method!=='GET') {
   window.checks.writes.push({path:p,body:options.body?JSON.parse(options.body):null});
   return json({error:{code:'test.unavailable',message:'测试网络暂不可用'}},503);
 }
 window.checks.reads.push(url.pathname+url.search);
 if(p.startsWith('/api/workspace/workflows/')) return json({workflow:{id:'workflow-'+workflowStep,type:workflowStep==='options'?'echo.publish':'echo.requirement',version:1,status:'active',revision:1,expiresAt:'2099-01-01T00:00:00Z',state:{step:workflowStep,fields:{type:'requirement',choiceMode:'single'}}}});
 if(p==='/api/workspace/bots') return json({bots:[bot]});
 if(p.endsWith('/settings')) return json({settings});
 if(p.endsWith('/tokens')) return json({tokens:[{id:'token-metadata',botId:bot.id,scopes:['messages:read_context'],createdAt:'2026-09-11T03:00:00Z'}]});
 if(p.endsWith('/connection')) return json({connection:{status:'connected',adapterVersion:'1.0',lastHeartbeatAt:'2026-09-11T03:00:00Z'}});
 if(p.endsWith('/group-policies')) return json({policies:[]});
 if(p==='/api/workspace/conversations') return json({conversations:[{id:'direct',type:'direct',members:[{id:'owner'},{id:'bot-user'}]}]});
 if(p.endsWith('/requirements/stats')) return json({stats:{total:2,byPhase:{proposal:2},byStatus:{pending_review:2}}});
 if(p.endsWith('/requirements')) return json({requirements:[requirement,{...requirement,id:'req-2',publicId:'R-002',title:'分享文件时保留简短说明'}]});
 if(p.endsWith('/history')) return json({history:[]});
 if(p.endsWith('/requirements/R-001')) return json({requirement});
 if(p.endsWith('/solicitations')) return json({solicitations:[]});
 throw new Error('Unexpected fixture request: '+p);
};
const surface = new URLSearchParams(location.search).get('surface');
const workflowStep = new URLSearchParams(location.search).get('step');
createRoot(document.getElementById('frame')).render(surface==='bot'
 ? h('div',{className:'dl-settings-page-body',style:{height:'100%',overflow:'auto'}},h(WorkspaceBotSettings,{embedded:true,onBack:()=>{},onNotice:()=>{},registerNavigationGuard:guard=>{window.checks.guard=guard;}}))
 : surface==='workflow' ? h(WorkspaceEchoInteraction,{slot:{activeWorkflowId:'workflow-'+workflowStep,request:{commandName:'help',source:'/help',mentionedBotIds:[],conversationId:'echo-direct',botUserId:'usr_system_echo',clientInvocationId:'fixture-'+workflowStep,draftSignature:'fixture'}},onCommandAccepted:()=>{},onWorkflowIdChange:()=>{},onDismiss:()=>{},onRestoreFocus:()=>{}})
 : h('div',{className:'workspace-content-panel workspace-space-panel',style:{height:'100%'}},h('div',{className:'workspace-space-tab-panel workspace-requirements-panel'},h(WorkspaceEchoRequirements,{onBack:()=>{},onNotice:()=>{}}))));
</script><style>#frame{height:calc(100dvh - 32px);width:calc(100% - 104px);margin:16px 16px 16px 88px;min-width:0} @media(max-width:760px){#frame{width:calc(100% - 24px);margin:12px;height:calc(100dvh - 24px)}}</style></body></html>`;
const portProbe = createPortProbe();
await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const server = await createServer({ root, cacheDir: "node_modules/.vite-management-verification", logLevel: "error", server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false }, plugins: [{ name: "management-layout", configureServer(instance) {
  instance.middlewares.use("/__management", async (_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(await instance.transformIndexHtml("/__management", html)); });
} }] });
await server.listen();
const browser = await chromium.launch();
const output = process.env.DESIGN_SCREENSHOT_DIR;
if (output) await mkdir(output, { recursive: true });
async function chooseFixed(page, label, option) {
  // Hidden tab/filter panels receive their measured presentation on the next
  // layout observation; query the active control after that layout settles.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const group = page.getByRole("radiogroup", { name: label, exact: true });
  if (await group.isVisible()) await group.getByRole("radio", { name: option, exact: true }).click();
  else {
    await page.getByRole("combobox", { name: new RegExp(`^${label}`) }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
}
async function checkSingleRows(page) {
  for (const group of await page.getByRole("radiogroup").all()) {
    if (!await group.isVisible()) continue;
    const bounds = await group.getByRole("radio").evaluateAll(radios => radios.map(radio => { const rect=radio.getBoundingClientRect();return {x:rect.x,y:rect.y,right:rect.right,width:rect.width,height:rect.height}; }));
    assert(bounds.every(rect => rect.width>=44 && rect.height>=44 && rect.x>=0 && rect.right<=innerWidthFor(page)), "Segmented choices retain 44px targets inside the viewport");
    assert(new Set(bounds.map(rect=>rect.y)).size<=1, "Insufficient width falls back to Select rather than wrapping choices");
  }
}
function innerWidthFor(page) { return page.viewportSize().width; }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const width of [1280, 780, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/__management?surface=echo`);
    await expect(page.getByRole("button", { name: /R-001/ })).toBeVisible();
    await chooseFixed(page, "阶段", "正式需求");
    await expect.poll(()=>page.evaluate(()=>window.checks.reads.some(url=>new URL(url,location.origin).searchParams.get('phase')==='formal'))).toBe(true);
    await chooseFixed(page, "阶段", "全部");
    await page.getByRole("button", { name: "更多筛选", exact: true }).click();
    await chooseFixed(page, "类型", "问题");
    await expect.poll(()=>page.evaluate(()=>window.checks.reads.some(url=>new URL(url,location.origin).searchParams.get('type')==='problem'))).toBe(true);
    await chooseFixed(page, "类型", "全部");
    await expect(page.getByLabel("开始日期", { exact: true })).toBeVisible();
    const height = await page.getByLabel("开始日期", { exact: true }).evaluate(el => el.getBoundingClientRect().height);
    assert(height >= 44);
    await checkSingleRows(page);
    if (output) await page.screenshot({ path: `${output}/echo-filters-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole("button", { name: "更多筛选", exact: true }).click();
    await page.getByRole("button", { name: /R-001/ }).click();
    await expect(page.getByText("图片数量较多时，希望可以按月份快速回到某一段时间。", { exact: true })).toBeVisible();
    if (width <= 780) await expect(page.getByRole("button", { name: /R-002/ })).toBeHidden();
    assert.equal(await page.locator('.workspace-echo-body').evaluate(el => el.scrollWidth > el.clientWidth), false);
    if (output) await page.screenshot({ path: `${output}/echo-detail-${width}.png` });
    await page.getByRole("tab", { name: "公开征集", exact: true }).click();
    await page.getByRole("button", { name: "新建征集", exact: true }).click();
    await page.getByLabel("标题", { exact: true }).fill("活动安排投票草稿");
    await chooseFixed(page, "投票方式", "多选");
    await page.getByRole("tab", { name: "需求", exact: true }).click();
    await page.getByRole("tab", { name: "公开征集", exact: true }).click();
    await expect(page.getByLabel("标题", { exact: true })).toHaveValue("活动安排投票草稿");
    const choiceMode = page.getByRole("radiogroup", { name: "投票方式", exact: true });
    if (await choiceMode.isVisible()) await expect(choiceMode.getByRole("radio", { name: "多选", exact: true })).toHaveAttribute("aria-checked", "true");
    else await expect(page.getByRole("combobox", { name: /^投票方式/ })).toContainText("多选");
    await checkSingleRows(page);
    await page.getByRole("button", { name: "创建预览", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "创建预览", exact: true })).toBeInViewport();
    if (output) await page.screenshot({ path: `${output}/echo-solicitation-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.goto(`${origin}/__management?surface=bot`);
    await expect(page.getByRole("heading", { name: "映河协作助手", exact: true })).toBeVisible();
    await chooseFixed(page, "成员发现", "指定成员");
    await expect(page.getByText("指定成员 ID", { exact: true })).toBeVisible();
    await checkSingleRows(page);
    await page.getByPlaceholder("告诉成员这个 Bot 负责什么").fill("未能保存时保留的资料草稿");
    await expect(page.getByText("保存失败，请继续修改后重试", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看 Bot 连接状态", exact: true }).click();
    await expect(page.getByRole("tab", { name: "连接", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "连接 Agent", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "资料", exact: true }).click();
    await expect(page.getByPlaceholder("告诉成员这个 Bot 负责什么")).toHaveValue("未能保存时保留的资料草稿");
    if (output) await page.screenshot({ path: `${output}/bot-profile-${width}.png` });
    await page.getByRole("tab", { name: "授权", exact: true }).click();
    await page.getByRole("combobox", { name: /^群聊策略/ }).click();
    await page.getByRole("option", { name: /^允许群聊/ }).click();
    await expect.poll(()=>page.evaluate(()=>window.checks.writes.some(write=>write.body?.allowGroup===true&&write.body?.requireOwnerApproval===false))).toBe(true);
    const grant = page.getByRole("region", { name: "会话上下文授权", exact: true });
    await grant.getByRole("combobox", { name: /^授权会话/ }).click();
    await page.getByRole("option", { name: /^私聊/ }).click();
    await grant.getByRole("button", { name: "设置私聊授权", exact: true }).click();
    await grant.getByRole("spinbutton", { name: "本会话最多读取消息数" }).fill("7");
    await expect.poll(() => page.evaluate(() => Boolean(window.checks.guard))).toBe(true);
    await page.getByRole("tab", { name: "凭据", exact: true }).click();
    await expect(page.getByRole("button", { name: "生成 Token", exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => Boolean(window.checks.guard)), true);
    await page.getByRole("tab", { name: "授权", exact: true }).click();
    await expect(grant.getByRole("spinbutton", { name: "本会话最多读取消息数" })).toHaveValue("7");
    if (output) { await page.locator('.dl-settings-page-body').evaluate(el => { el.scrollTop = 0; }); await page.screenshot({ path: `${output}/bot-authorization-${width}.png` }); }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const step of ["type", "title", "options"]) {
      try {
      await page.goto(`${origin}/__management?surface=workflow&step=${step}`);
      await expect(page.locator(".workspace-echo-workflow")).toBeVisible();
      const label = step === "type" ? "反馈类型" : step === "title" ? "类型" : "投票方式";
      await chooseFixed(page, label, step === "options" ? "多选" : "问题反馈");
      if (step === "title") await page.getByLabel("标题", { exact: true }).fill("表单名称与选择保持");
      if (step === "options") await page.locator('.workspace-echo-workflow textarea[name="options"]').fill("选项一\n选项二");
      await checkSingleRows(page);
      const field = step === "options" ? "choiceMode" : "type", expected = step === "options" ? "multiple" : "problem";
      assert.equal(await page.locator(".workspace-echo-workflow").evaluate((form, field) => new FormData(form).get(field), field), expected);
      await page.getByRole("button", { name: "继续", exact: true }).click();
      await expect.poll(()=>page.evaluate(({field,expected})=>window.checks.writes.some(write=>write.path.endsWith('/continue')&&write.body?.input?.[field]===expected),{field,expected})).toBe(true);
      await expect(page.getByText("测试网络暂不可用", { exact: true })).toBeVisible();
      assert.equal(await page.locator(".workspace-echo-workflow").evaluate((form, field) => new FormData(form).get(field), field), expected);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (output) await page.screenshot({ path: `${output}/echo-workflow-${step}-${width}.png` });
      } catch (error) {
        if (output) { await page.screenshot({ path: `${output}/workflow-failure-${step}-${width}.png` }); await writeFile(`${output}/workflow-failure-${step}-${width}.txt`, await page.locator('body').innerText()); }
        throw error;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log("Management layout passed at 1280/780/390/320px: single-row choices or Select fallback, real filter/policy callbacks, preserved cross-tab drafts, reachable Echo submit, Bot grant guard and 12 workflow form-name/failure-preservation scenarios.");
} finally { await browser.close(); await server.close(); }
