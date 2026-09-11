import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer as createPortProbe } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="workspace-mode"><div id="root"></div><script type="module">
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
import { ViewModeSwitch } from '/src/ui/primitives/ViewModeSwitch.tsx';
import { initializeAppearance } from '/src/ui/theme/index.ts';
initializeAppearance();
const h = React.createElement;
window.checks = { changes: [], submits: 0 };
function Fixture() {
  const [value, setValue] = useState('list');
  const [disabled, setDisabled] = useState(false);
  window.checks.disable = setDisabled;
  return h('main', { style: { padding: 16, width: '100%', boxSizing: 'border-box' } },
    h('form', { style: { display: 'grid', width: '100%' }, onSubmit: event => { event.preventDefault(); window.checks.submits++; } },
      h(ViewModeSwitch, { value, disabled, label: '相册展示方式', onValueChange: next => { window.checks.changes.push(next); setValue(next); } }),
      h('button', { type: 'button', style: { marginTop: 16 } }, '下一项')));
}
createRoot(document.getElementById('root')).render(h(React.StrictMode, null, h(Fixture)));
</script></body></html>`;
const portProbe = createPortProbe();
await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const server = await createServer({
  root, cacheDir: "node_modules/.vite-view-mode-verification", logLevel: "error",
  server: { host: "127.0.0.1", port, strictPort: true },
  plugins: [{ name: "view-mode-fixture", configureServer(instance) {
    instance.middlewares.use("/__view-mode", async (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(await instance.transformIndexHtml("/__view-mode", html));
    });
  } }]
});
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__view-mode`);
  const group = page.getByRole("radiogroup", { name: "相册展示方式" });
  const list = group.getByRole("radio", { name: "列表视图" });
  const grid = group.getByRole("radio", { name: "卡片视图" });
  await expect(list).toHaveAttribute("aria-checked", "true");
  await list.focus(); await page.keyboard.press("ArrowRight"); await expect(grid).toBeFocused();
  assert.equal(await grid.evaluate(element => getComputedStyle(element).outlineStyle), "solid");
  await grid.press("Space"); await expect(grid).toHaveAttribute("aria-checked", "true");
  await expect(list).toHaveAttribute("aria-checked", "false");
  await grid.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.checks.changes), ["grid"]);
  assert.equal(await page.evaluate(() => window.checks.submits), 0);
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "下一项" })).toBeFocused();
  await page.evaluate(() => window.checks.disable(true));
  await expect(list).toBeDisabled(); await expect(grid).toBeDisabled();
  await page.evaluate(() => window.checks.disable(false));
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await group.evaluate(element => ({
      width: element.getBoundingClientRect().width,
      buttons: [...element.querySelectorAll('button')].map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
      overflow: document.documentElement.scrollWidth > window.innerWidth
    }));
    assert(geometry.width < 210, `mode switch should remain compact at ${width}px`);
    assert.equal(geometry.overflow, false);
    for (const hit of geometry.buttons) { assert(hit.width >= 44); assert(hit.height >= 44); }
    assert.equal(geometry.buttons[0].width, geometry.buttons[1].width);
    assert.equal(geometry.buttons[0].height, geometry.buttons[1].height);
  }
  assert.deepEqual(errors, []);
  console.log("ViewModeSwitch: compact geometry at 1280/390/320px; 44px targets; keyboard/focus; exclusive pressed state; no repeated change or form submission; disabled passed.");
} finally { await browser.close(); await server.close(); }
