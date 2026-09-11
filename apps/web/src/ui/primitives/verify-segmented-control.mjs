import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer as createPortProbe } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import '/src/styles.css';import{SegmentedControl}from'/src/ui/primitives/index.ts';import{initializeAppearance}from'/src/ui/theme/index.ts';initializeAppearance();
const h=React.createElement;window.checks={changes:[],submits:0};
function Fixture(){const[value,setValue]=useState('a'),[width,setWidth]=useState(400),[disabled,setDisabled]=useState(false),[long,setLong]=useState(false);
Object.assign(window.checks,{setWidth,setDisabled,setLong});
return h('main',{style:{padding:16,width:'100%',boxSizing:'border-box'}},h('form',{id:'sample',onSubmit:e=>{e.preventDefault();window.checks.submits++;}},
h('div',{id:'frame',style:{width,maxWidth:'100%'}},h(SegmentedControl,{label:'固定选项',name:'preference',value,disabled,description:'保留完整的说明与表单值',onValueChange:next=>{setValue(next);window.checks.changes.push(next);},options:[{value:'a',label:long?'较长的选项说明需要完整展示':'全部'},{value:'b',label:'受限',disabled:true},{value:'c',label:'图片'},{value:'d',label:'文档'}]})),h('button',{type:'button',id:'next'},'下一项')));}
createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(Fixture)));
</script></body></html>`;
const probe = createPortProbe();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = await createServer({ root, cacheDir: "node_modules/.vite-segmented-verification", logLevel: "error", server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false }, plugins: [{ name: "segmented-fixture", configureServer(instance) { instance.middlewares.use("/__segmented", async (_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(await instance.transformIndexHtml("/__segmented", html)); }); } }] });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__segmented`);
  const group = page.getByRole("radiogroup", { name: "固定选项" });
  const all = group.getByRole("radio", { name: "全部", exact: true });
  const pictures = group.getByRole("radio", { name: "图片", exact: true });
  const documents = group.getByRole("radio", { name: "文档", exact: true });
  await all.focus(); await all.press("ArrowRight"); await expect(pictures).toBeFocused();
  await expect(pictures).toHaveAttribute("aria-checked", "true");
  await pictures.press("End"); await expect(documents).toBeFocused();
  await documents.press("Home"); await expect(all).toBeFocused();
  await page.locator("#frame").evaluate(element => { element.dir = "rtl"; });
  await all.press("ArrowLeft"); await expect(pictures).toBeFocused();
  await pictures.press("ArrowRight"); await expect(all).toBeFocused();
  const count = await page.evaluate(() => window.checks.changes.length);
  await all.press("Space"); await all.press("Enter");
  assert.equal(await page.evaluate(() => window.checks.changes.length), count);
  assert.equal(await page.evaluate(() => window.checks.submits), 0);
  await all.press("Tab"); await expect(page.locator("#next")).toBeFocused();
  await pictures.click();
  await page.evaluate(() => window.checks.setWidth(160));
  const select = page.getByRole("combobox", { name: /固定选项/ });
  await expect(select).toBeVisible(); await expect(select).toBeFocused();
  assert.equal(await page.evaluate(() => new FormData(document.querySelector("form")).get("preference")), "c");
  await select.click();
  await page.getByRole("option", { name: "文档", exact: true }).click();
  await page.evaluate(() => window.checks.setWidth(400));
  await expect(documents).toHaveAttribute("aria-checked", "true"); await expect(documents).toBeFocused();
  await page.evaluate(() => window.checks.setLong(true));
  await expect(select).toBeVisible();
  await select.click(); await expect(page.getByRole("option", { name: "较长的选项说明需要完整展示", exact: true })).toBeVisible(); await select.press("Escape");
  await page.evaluate(() => window.checks.setDisabled(true));
  await expect(select).toBeDisabled();
  assert.equal(await page.evaluate(() => new FormData(document.querySelector("form")).has("preference")), false);
  await page.evaluate(() => { window.checks.setDisabled(false); window.checks.setLong(false); });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(group).toBeVisible();
    const geometry = await group.evaluate(element => ({ overflow: document.documentElement.scrollWidth > innerWidth, buttons: [...element.querySelectorAll("button")].map(button => { const r = button.getBoundingClientRect(); return { width: r.width, height: r.height, scroll: button.scrollWidth > button.clientWidth }; }) }));
    assert.equal(geometry.overflow, false);
    for (const rect of geometry.buttons) assert(rect.width >= 44 && rect.height >= 44 && !rect.scroll);
  }
  assert.deepEqual(errors, []);
  console.log("SegmentedControl passed: disabled skipping, RTL/Home/End, one Tab entry, form value/no accidental submit, repeat suppression, resize/long-text Select fallback and focus/value continuity, 1280/390/320px targets.");
} finally { await browser.close(); await server.close(); }
