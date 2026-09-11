import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
}

test("profile explicit save protects navigation and browser history, and retains a rejected draft", async ({ page }) => {
  await signIn(page);
  const bootstrap = await (await page.request.get("/api/workspace/bootstrap")).json();
  const originalNickname = bootstrap.auth.currentUser.nickname ?? "";
  const navigation = page.getByRole("navigation", { name: "共享空间视图" });
  const changedNickname = `设计回归 ${randomUUID().slice(0, 8)}`;
  let writes = 0;
  let logouts = 0;
  page.on("request", (request) => { if (request.method() === "PATCH" && request.url().endsWith("/api/workspace/me/profile")) writes += 1; });
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/auth/logout")) logouts += 1; });
  try {
    await navigation.getByRole("button", { name: "文件", exact: true }).click();
    await navigation.getByRole("button", { name: "个人", exact: true }).click();
    await page.getByRole("navigation", { name: "个人设置分类" }).getByRole("button", { name: /资料/ }).click();
    const nickname = page.getByRole("textbox", { name: "公开昵称", exact: true });
    await nickname.fill(changedNickname);
    await expect(page.getByText("有未保存的修改", { exact: true })).toBeVisible();
    // A route request arrives after the old autosave interval. It must still be a draft.
    await page.waitForTimeout(750);
    expect(writes).toBe(0);
    await navigation.getByRole("button", { name: "文件", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "保存当前修改？" });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "继续留在这里" }).click();
    await expect(nickname).toHaveValue(changedNickname);

    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "继续留在这里" }).click();
    await expect(nickname).toHaveValue(changedNickname);
    expect(logouts).toBe(0);
    await page.goBack();
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "继续留在这里" }).click();
    await expect(page).toHaveURL(/\/workspace\/account\/profile$/);
    await expect(nickname).toHaveValue(changedNickname);

    await page.route("**/api/workspace/me/profile", async (route) => {
      if (route.request().method() === "PATCH") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "暂时无法保存" }) });
      else await route.continue();
    });
    await navigation.getByRole("button", { name: "文件", exact: true }).click();
    await confirmation.getByRole("button", { name: "保存并继续" }).click();
    await expect(confirmation.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/workspace\/account\/profile$/);
    await confirmation.getByRole("button", { name: "继续留在这里" }).click();
    await expect(nickname).toHaveValue(changedNickname);
    await page.unroute("**/api/workspace/me/profile");
    const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith("/api/workspace/me/profile"));
    await page.getByRole("button", { name: "重试保存资料", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByText("资料已保存", { exact: true })).toBeVisible();
    await navigation.getByRole("button", { name: "文件", exact: true }).click();
    await expect(page).toHaveURL(/\/workspace\/files$/);
    await expect(confirmation).toHaveCount(0);
  } finally {
    await page.unroute("**/api/workspace/me/profile");
    await page.request.patch("/api/workspace/me/profile", { data: { nickname: originalNickname } });
  }
});

test("appearance is a durable route and mobile settings keep one level visible", async ({ page }) => {
  await signIn(page);
  await page.goto("/workspace/account/appearance");
  await expect(page.getByRole("heading", { name: "外观", exact: true })).toBeVisible();
  await page.getByRole("radiogroup", { name: "显示模式", exact: true }).getByRole("radio", { name: "深色", exact: true }).click();
  for (const [name, id] of [["米色", "beige"], ["极简", "minimal"]]) {
    await page.getByRole("group", { name: "主题", exact: true }).getByRole("button", { name: `${name}主题`, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme-family", id);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme-family", id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "个人设置分类" })).not.toBeVisible();
  await page.getByRole("button", { name: "返回个人设置", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "个人设置分类" })).toBeVisible();
  await page.getByRole("navigation", { name: "个人设置分类" }).getByRole("button", { name: /通知/ }).click();
  await page.getByRole("button", { name: /邮件通知/ }).click();
  await expect(page).toHaveURL(/\/workspace\/account\/notifications\/email$/);
  await page.getByRole("button", { name: "返回通知", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/account\/notifications$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "返回个人设置", exact: true }).click();
  const loggedOut = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/auth/logout"));
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  expect((await loggedOut).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "使用 GitHub 登录", exact: true })).toBeVisible();
});

test("emote settings stay readable and explicit management closes to the same page", async ({ page }, testInfo) => {
  await signIn(page);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/workspace/account");
    await page.getByRole("navigation", { name: "个人设置分类" }).getByRole("button", { name: /^表情/ }).click();
    await expect(page).toHaveURL(/\/workspace\/account\/emotes$/);
    const manager = page.getByRole("dialog", { name: "我的表情", exact: true });
    const trigger = page.getByRole("button", { name: /^管理我的表情/ });
    await expect(manager).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "表情", exact: true })).toBeVisible();
    await expect(trigger).toBeVisible();
    expect(await page.locator("#root").evaluate((root) => root.inert)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`emote-settings-${width}.png`) });
    const historyLength = await page.evaluate(() => history.length);
    await trigger.click();
    await expect(manager).toBeVisible();
    await expect(manager.getByRole("button", { name: "关闭我的表情管理", exact: true })).toBeFocused();
    await manager.getByRole("button", { name: "关闭我的表情管理", exact: true }).click();
    await expect(manager).toHaveCount(0);
    await expect(page).toHaveURL(/\/workspace\/account\/emotes$/);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await trigger.click();
    await expect(manager).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(manager).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.reload();
    await expect(trigger).toBeVisible();
    await expect(manager).toHaveCount(0);
    await trigger.click();
    await expect(manager).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/workspace\/account$/);
    await expect(manager).toHaveCount(0);
    await page.goForward();
    await expect(trigger).toBeVisible();
    await expect(manager).toHaveCount(0);
  }
});

test("collection removal cancellation performs no deletion and explicit keep removes only the collection", async ({ page }) => {
  await signIn(page);
  const name = `确认回归 ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post("/api/workspace/me/emote-collections", { data: { name } });
  expect(created.ok()).toBe(true);
  await page.goto("/workspace/account/emotes");
  const manager = page.getByRole("dialog", { name: "我的表情", exact: true });
  await page.getByRole("button", { name: /^管理我的表情/ }).click();
  await expect(manager).toBeVisible();
  await manager.getByRole("button", { name: "整理", exact: true }).click();
  const row = manager.locator(".workspace-emote-library-tile.collection").filter({ hasText: name });
  let deletions = 0;
  page.on("request", (request) => { if (request.method() === "DELETE" && request.url().includes("/emote-collections/")) deletions += 1; });
  await row.getByRole("button", { name: /删除/ }).click();
  const dialog = page.getByRole("dialog", { name: "删除表情合集", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();
  expect(deletions).toBe(0);
  await row.getByRole("button", { name: /删除/ }).click();
  const deleted = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().includes("/emote-collections/"));
  await dialog.getByRole("button", { name: "仅删除合集，保留表情", exact: true }).click();
  const response = await deleted;
  expect(response.ok()).toBe(true);
  expect(new URL(response.url()).searchParams.get("itemDisposition")).toBe("keep");
  await expect(row).toHaveCount(0);
  expect(deletions).toBe(1);
});
