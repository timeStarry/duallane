import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("Echo management keeps solicitation drafts across peer views and retries the real create command", async ({ page }) => {
  const title = `征集布局回归 ${randomUUID().slice(0, 8)}`;
  let publicId = "";
  let revision = 0;
  let releaseFailure!: () => void;
  let reportCreateStarted!: () => void;
  const heldFailure = new Promise<void>(resolve => { releaseFailure = resolve; });
  const createStarted = new Promise<void>(resolve => { reportCreateStarted = resolve; });
  try {
    await page.goto("/workspace");
    await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    await page.goto("/workspace/space/requirements");
    const views = page.getByRole("tablist", { name: "回声管理视图" });
    await views.getByRole("tab", { name: "公开征集", exact: true }).click();
    await page.getByRole("button", { name: "新建征集", exact: true }).click();
    await page.getByLabel("标题", { exact: true }).fill(title);
    await page.getByLabel("说明", { exact: true }).fill("仅用于隔离环境的布局和草稿回归，不公开投递。");
    await page.getByLabel("投票问题", { exact: true }).fill("优先安排哪一天？");
    await page.getByLabel("选项 1", { exact: true }).fill("周六");
    await page.getByLabel("选项 2", { exact: true }).fill("周日");
    await views.getByRole("tab", { name: "需求", exact: true }).click();
    await expect(page.getByRole("button", { name: "更多筛选", exact: true })).toBeVisible();
    await views.getByRole("tab", { name: "公开征集", exact: true }).click();
    await expect(page.getByLabel("标题", { exact: true })).toHaveValue(title);
    await expect(page.getByLabel("选项 2", { exact: true })).toHaveValue("周日");
    await page.setViewportSize({ width: 390, height: 844 });
    const submit = page.getByRole("button", { name: "创建预览", exact: true });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.route("**/api/workspace/echo/solicitations", async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      reportCreateStarted();
      await heldFailure;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "test.unavailable", message: "暂时无法创建征集" } }) });
    });
    await submit.click();
    await createStarted;
    await expect(page.getByLabel("标题", { exact: true })).toBeDisabled();
    await views.getByRole("tab", { name: "需求", exact: true }).click();
    await views.getByRole("tab", { name: "公开征集", exact: true }).click();
    await expect(page.getByLabel("标题", { exact: true })).toHaveValue(title);
    await expect(page.getByLabel("标题", { exact: true })).toBeDisabled();
    releaseFailure();
    await expect(page.getByText("暂时无法创建征集", { exact: true })).toBeVisible();
    await expect(page.getByLabel("标题", { exact: true })).toHaveValue(title);
    await page.unroute("**/api/workspace/echo/solicitations");
    const created = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/workspace/echo/solicitations"));
    await submit.click();
    const response = await created;
    expect(response.status()).toBe(201);
    const data = await response.json() as { solicitation: { publicId: string; title: string; status: string; revision: number } };
    expect(data.solicitation).toMatchObject({ title, status: "draft" });
    publicId = data.solicitation.publicId;
    revision = data.solicitation.revision;
    await expect(page.locator(".workspace-echo-solicitation-list article").filter({ hasText: title })).toBeVisible();
    await expect(submit).toHaveCount(0);
  } finally {
    releaseFailure();
    await page.unrouteAll({ behavior: "wait" });
    if (publicId) await page.request.post(`/api/workspace/echo/solicitations/${encodeURIComponent(publicId)}/withdraw`, { data: { expectedRevision: revision, idempotencyKey: `layout-cleanup-${randomUUID()}` } }).catch(() => null);
  }
});
