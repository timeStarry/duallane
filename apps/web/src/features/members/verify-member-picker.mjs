import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox, webkit, expect } from "@playwright/test";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const server = await createServer({ root: fileURLToPath(new URL("../../../", import.meta.url)), cacheDir: "node_modules/.vite-member-picker-test", server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/src/features/members/member-picker-harness.html`;
const artifacts = fileURLToPath(new URL("../../../../../.private-test-results/member-picker/", import.meta.url));
await mkdir(artifacts, { recursive: true });
const control = (page, action, id) => page.evaluate((detail) => window.dispatchEvent(new CustomEvent("test:member-picker", { detail })), { action, id });
const state = async (page) => JSON.parse(await page.locator("#picker-test-state").textContent());
const open = async (page) => { await page.getByRole("button", { name: "打开成员选择" }).click(); await expect(page.getByRole("dialog")).toBeVisible(); };

try {
  for (const engine of [chromium, firefox, webkit].filter((engine) => !process.env.MEMBER_PICKER_ENGINE || engine.name() === process.env.MEMBER_PICKER_ENGINE)) {
    const browser = await engine.launch();
    try {
      for (const width of [1440, 390, 320]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await open(page);
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByRole("heading", { name: "邀请成员" })).toBeFocused();
        await expect(dialog.getByRole("checkbox", { name: "已有成员", exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("checkbox", { name: "服务助手", exact: true })).toBeDisabled();
        await expect(dialog.getByRole("button", { name: "邀请成员", exact: true })).toBeDisabled();
        await dialog.getByRole("checkbox", { name: "安宁", exact: true }).check();
        const search = dialog.getByRole("searchbox", { name: "搜索成员" });
        await search.fill("林予");
        await expect(dialog.getByRole("checkbox")).toHaveCount(1);
        await dialog.getByRole("checkbox", { name: "林予", exact: true }).check();
        await expect(dialog.locator(".dl-member-picker-count")).toHaveText("已选 2 人");
        await search.fill("没有此成员");
        await expect(dialog.getByText("没有找到匹配的成员", { exact: true })).toBeVisible();
        await expect(dialog.locator(".dl-member-picker-count")).toHaveText("已选 2 人");
        await dialog.getByRole("button", { name: "清除搜索" }).click();
        await expect(search).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("checkbox", { name: "安宁", exact: true })).toBeFocused();
        await page.keyboard.press("Space");
        await expect(dialog.locator(".dl-member-picker-count")).toHaveText("已选 1 人");
        await page.keyboard.press("Space");
        const geometry = await dialog.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const footer = element.querySelector("footer").getBoundingClientRect();
          const controls = [...element.querySelectorAll("button,input")].map((control) => {
            const rect = control.getBoundingClientRect(); return { width: rect.width, height: rect.height };
          });
          return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, footerBottom: footer.bottom, overflow: element.scrollWidth > element.clientWidth, controls };
        });
        assert(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= 844);
        assert(geometry.footerBottom <= 844 && !geometry.overflow);
        assert(geometry.controls.every((rect) => rect.width >= 44 && rect.height >= 44), `${engine.name()} ${width}: controls ${JSON.stringify(geometry.controls)}`);
        await page.screenshot({ path: `${artifacts}/${engine.name()}-${width}.png` });
        await dialog.getByRole("button", { name: "邀请成员", exact: true }).focus();
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("button", { name: "取消邀请", exact: true })).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(dialog.getByRole("button", { name: "邀请成员", exact: true })).toBeFocused();
        if (width === 320) {
          await page.setViewportSize({ width, height: 420 });
          await search.focus();
          await expect.poll(() => dialog.locator("footer").evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(420);
          await expect(dialog.getByRole("button", { name: "邀请成员", exact: true })).toBeInViewport();
        }
        await search.fill("保留选择");
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole("button", { name: "打开成员选择" })).toBeFocused();
        assert.equal((await state(page)).closeReason, "cancel");
        await open(page);
        await expect(dialog.locator(".dl-member-picker-count")).toHaveText("已选 0 人");
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        assert.deepEqual(errors, []);
        await page.close();
      }

      const page = await browser.newPage();
      await page.goto(url);
      await open(page);
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("checkbox", { name: "安宁", exact: true }).check();
      await dialog.getByRole("checkbox", { name: "林予", exact: true }).check();
      await dialog.getByRole("button", { name: "邀请成员", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "邀请中", exact: true })).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      assert.equal((await state(page)).calls.length, 1);
      // Partial success removes that member; retry must only send remaining selections.
      await control(page, "existing", "a");
      await expect(dialog.getByRole("checkbox", { name: "安宁", exact: true })).toHaveCount(0);
      await control(page, "reject");
      await expect(dialog.getByRole("alert")).toContainText("邀请失败");
      await expect(dialog.getByRole("checkbox", { name: "林予", exact: true })).toBeChecked();
      await expect(dialog.locator(".dl-member-picker-count")).toHaveText("已选 1 人");
      await dialog.getByRole("button", { name: "重试邀请" }).click();
      await control(page, "resolve");
      await expect.poll(async () => (await state(page)).consumed).toBe(2);
      await expect.poll(async () => (await state(page)).closeReason).toBe("complete");
      await expect(page.locator("dialog")).toHaveCount(0);
      assert.deepEqual((await state(page)).calls, [["a", "b"], ["b"]]);
      assert.deepEqual((await state(page)).writes, ["b"], JSON.stringify(await state(page)));
      await expect(page.getByRole("button", { name: "打开成员选择" })).toBeFocused();

      // Availability changes before and during submission cannot reach the writer.
      await page.reload();
      await open(page);
      await dialog.getByRole("checkbox", { name: "安宁", exact: true }).check();
      await dialog.getByRole("checkbox", { name: "林予", exact: true }).check();
      await control(page, "remove", "a");
      await expect(dialog.locator(".dl-member-picker-count")).toHaveText("已选 1 人");
      await dialog.getByRole("button", { name: "邀请成员", exact: true }).click();
      await control(page, "disable", "b");
      await expect(dialog.getByText("成员权限已更新", { exact: true })).toBeVisible();
      await expect(dialog.locator(".dl-member-picker-count")).toHaveText("已选 0 人");
      await expect(dialog.getByRole("checkbox", { name: "林予", exact: true })).toBeDisabled();
      await control(page, "resolve");
      await expect.poll(async () => (await state(page)).consumed).toBe(1);
      await expect.poll(async () => (await state(page)).closeReason).toBe("complete");
      await expect(page.locator("dialog")).toHaveCount(0);
      assert.deepEqual((await state(page)).calls, [["b"]]);
      assert.deepEqual((await state(page)).writes, []);

      // Observe actual consumption of late success after scope change, and after external close.
      for (const invalidation of ["scope", "close"]) {
        await page.reload();
        await open(page);
        await dialog.getByRole("checkbox", { name: "安宁", exact: true }).check();
        await dialog.getByRole("button", { name: "邀请成员", exact: true }).click();
        await control(page, invalidation);
        await expect(dialog).toHaveCount(0);
        assert.equal((await state(page)).aborted, true);
        await control(page, "resolve");
        await expect.poll(async () => (await state(page)).consumed).toBe(1);
        assert.deepEqual((await state(page)).writes, []);
        assert.notEqual((await state(page)).closeReason, "complete");
        await expect(page.getByRole("button", { name: "打开成员选择" })).toBeFocused();
      }
      await page.close();
      console.log(`${engine.name()}: 1440/390/320 layout and 44px controls; search, multi-select, keyboard, focus, failure/retry, partial success, live availability, scope/external-close late-response guards passed.`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
