import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("member visibility ignores delayed reads and a previous workspace session's save response", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = randomUUID().slice(0, 8);
  const contexts: BrowserContext[] = [];
  const members: Array<{ id: string; name: string }> = [];
  const readGate = gate();
  const writeGate = gate();
  try {
    await page.goto("/workspace");
    await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    for (const label of ["甲", "乙", "目标"]) {
      const context = await browser.newContext(); contexts.push(context);
      const invited = await page.request.post("/api/workspace/invites", { data: { defaultRole: "member", maxUses: 1 } });
      expect(invited.status()).toBe(201);
      const code = (await invited.json() as { invite: { code: string } }).invite.code;
      const name = `可见范围${label} ${suffix}`;
      const accepted = await context.request.post(`/api/workspace/invites/${code}/accept`, { data: { githubId: `visibility-${members.length}-${suffix}`, githubLogin: `visibility-${members.length}-${suffix}`, email: `visibility-${members.length}-${suffix}@example.test`, displayName: name } });
      expect(accepted.status()).toBe(201);
      members.push({ id: (await accepted.json() as { user: { id: string } }).user.id, name });
    }
    const [viewerA, viewerB, target] = members;
    const pathA = `/api/workspace/member-visibility/${viewerA.id}`;
    expect((await page.request.put(pathA, { data: { visibleUserIds: [target.id] } })).status()).toBe(200);
    expect((await page.request.put(`/api/workspace/member-visibility/${viewerB.id}`, { data: { visibleUserIds: [] } })).status()).toBe(200);
    await page.goto("/workspace/space/visibility");
    const selector = page.getByRole("combobox", { name: /^查看者\s/ });
    const targetCheckbox = page.locator(".workspace-visibility-row").filter({ hasText: target.name }).getByRole("checkbox");
    const selectViewer = async (name: string) => {
      await selector.click();
      await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
      await expect(selector).toContainText(name);
    };
    await selectViewer(viewerB.name);
    await expect(targetCheckbox).not.toBeChecked();
    // Committing the already-selected option must preserve the loaded rows.
    await selectViewer(viewerB.name);
    await expect(targetCheckbox).toBeVisible();
    await expect(targetCheckbox).not.toBeChecked();
    await expect(page.locator(".workspace-visibility-list")).toHaveAttribute("aria-busy", "false");
    const readStarted = gate();
    let holdRead = true;
    await page.route(`**${pathA}`, async route => {
      if (route.request().method() !== "GET" || !holdRead) { await route.continue(); return; }
      holdRead = false;
      const response = await route.fetch();
      readStarted.release();
      await readGate.promise;
      await route.fulfill({ response });
    });
    await selectViewer(viewerA.name);
    await readStarted.promise;
    await selectViewer(viewerB.name);
    await expect(targetCheckbox).not.toBeChecked();
    const oldReadFinished = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(pathA));
    readGate.release(); await oldReadFinished;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(selector).toContainText(viewerB.name);
    await expect(targetCheckbox).not.toBeChecked();
    await page.unroute(`**${pathA}`);

    await selectViewer(viewerA.name);
    await expect(targetCheckbox).toBeChecked();
    await targetCheckbox.uncheck();
    // The same no-op also preserves a pending manual edit before explicit save.
    await selectViewer(viewerA.name);
    await expect(targetCheckbox).not.toBeChecked();
    const writeStarted = gate();
    let holdWrite = true;
    await page.route(`**${pathA}`, async route => {
      if (route.request().method() !== "PUT" || !holdWrite) { await route.continue(); return; }
      holdWrite = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      writeStarted.release();
      await writeGate.promise;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await writeStarted.promise;
    await expect(selector).toBeDisabled();

    // The PUT is already committed. Leaving the workspace clears its client session.
    // Returning through the SPA must not let this response enter the new session,
    // even when the account and selected viewer are unchanged.
    const navigation = page.getByRole("navigation", { name: "共享空间视图" });
    await navigation.getByRole("button", { name: "聊天", exact: true }).click();
    await page.locator("#workspace-user-menu-trigger").click();
    await page.getByRole("menuitem", { name: "返回入口", exact: true }).click();
    await expect(page.getByRole("heading", { name: "选择沟通方式", exact: true })).toBeVisible();
    expect((await page.request.put(pathA, { data: { visibleUserIds: [target.id] } })).status()).toBe(200);
    await page.getByRole("button", { name: /进入共享空间/ }).click();
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    await navigation.getByRole("button", { name: "空间", exact: true }).click();
    await page.getByRole("tab", { name: "可见范围", exact: true }).click();
    await selectViewer(viewerA.name);
    await expect(targetCheckbox).toBeChecked();
    const oldWriteFinished = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(pathA));
    writeGate.release(); await oldWriteFinished;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(selector).toBeEnabled();
    await expect(targetCheckbox).toBeChecked();
    const current = await (await page.request.get(pathA)).json() as { visibility: { viewerUserId: string; grantedUserIds: string[] } };
    expect(current.visibility.viewerUserId).toBe(viewerA.id);
    expect(current.visibility.grantedUserIds).toContain(target.id);
  } finally {
    readGate.release(); writeGate.release();
    await page.unrouteAll({ behavior: "wait" });
    for (const member of members) await page.request.delete(`/api/workspace/members/${member.id}`).catch(() => null);
    await Promise.all(contexts.map(context => context.close()));
  }
});
