import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const server = await createServer({ root: fileURLToPath(new URL("../../../", import.meta.url)), cacheDir: "node_modules/.vite-confirmation-test", server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/src/ui/patterns/confirmation-harness.html`);
  const trigger = page.getByRole("button", { name: "移除对象", exact: true });
  const dialog = page.getByRole("dialog");
  await trigger.click();
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toHaveText("cancelled");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.evaluate(() => window.dispatchEvent(new Event("test:session-ended")));
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("cancelled");
  await trigger.click();
  // Invalidate in the same task after approval; the awaiting old command must still cancel.
  await page.evaluate(() => { document.querySelector("dialog .primary").click(); window.dispatchEvent(new Event("test:session-ended")); });
  await expect(page.getByRole("status")).toHaveText("cancelled");
  await trigger.click();
  await dialog.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("mutated");
  await page.getByRole("button", { name: "删除合集", exact: true }).click();
  await dialog.getByRole("button", { name: "仅删除合集", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("alternative");
  assert.deepEqual(errors, []);
  console.log("Confirmation passed: cancel, focus, session invalidation including same-task approval, explicit alternative.");
} finally { await browser.close(); await server.close(); }
