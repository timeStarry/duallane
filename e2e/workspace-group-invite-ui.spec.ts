import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";

test("group member picker searches, retains partial failures and retries only remaining members", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = randomUUID().slice(0, 8);
  const contexts: BrowserContext[] = [];
  try {
    await page.goto("/workspace");
    await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const members: { id: string; name: string }[] = [];
    for (let index = 0; index < 3; index += 1) {
      const context = await browser.newContext();
      contexts.push(context);
      const invite = await page.request.post("/api/workspace/invites", { data: { defaultRole: "member", maxUses: 1 } });
      expect(invite.status()).toBe(201);
      const code = (await invite.json()).invite.code as string;
      const login = `picker-${suffix}-${index}`;
      const name = `邀请验收 ${suffix} ${index}`;
      const accepted = await context.request.post(`/api/workspace/invites/${code}/accept`, { data: { githubId: login, githubLogin: login, email: `${login}@example.test`, displayName: name } });
      expect(accepted.status()).toBe(201);
      members.push({ id: (await accepted.json()).user.id as string, name });
    }
    const title = `成员邀请 ${suffix}`;
    const created = await page.request.post("/api/workspace/conversations", { data: { type: "group", title, memberIds: [members[0].id] } });
    expect(created.status()).toBe(201);
    const groupId = (await created.json()).conversation.id as string;
    const path = `/api/workspace/groups/${groupId}/members`;
    await page.goto(`/workspace/chat/${groupId}`);
    const details = page.getByLabel("当前会话详情", { exact: true });
    if (!(await details.isVisible())) await page.getByRole("region", { name: title, exact: true }).getByTitle("查看详情", { exact: true }).click();
    await details.getByRole("tab", { name: "成员", exact: true }).click();
    const inviteButton = details.getByRole("button", { name: "邀请成员", exact: true });
    await inviteButton.click();
    const picker = page.getByRole("dialog", { name: "邀请成员", exact: true });
    await expect(picker.getByRole("checkbox", { name: members[0].name, exact: true })).toHaveCount(0);
    for (const member of members.slice(1)) {
      await picker.getByRole("searchbox", { name: "搜索成员" }).fill(member.name);
      await picker.getByRole("checkbox", { name: member.name, exact: true }).check();
    }
    const writes: string[] = [];
    let rejectSecond = true;
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      const id = (route.request().postDataJSON() as { userId: string }).userId;
      writes.push(id);
      if (id === members[2].id && rejectSecond) {
        rejectSecond = false;
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "test.unavailable", message: "暂时无法邀请" } }) });
      }
      await route.continue();
    });
    await picker.getByRole("button", { name: "邀请成员", exact: true }).click();
    await expect(picker.getByRole("alert")).toContainText("其余选择已保留");
    await expect(picker.getByRole("checkbox", { name: members[2].name, exact: true })).toBeChecked();
    await picker.getByRole("searchbox", { name: "搜索成员" }).fill("");
    await expect(picker.getByRole("checkbox", { name: members[1].name, exact: true })).toHaveCount(0);
    expect(writes).toEqual([members[1].id, members[2].id]);
    await picker.getByRole("button", { name: "重试邀请" }).click();
    await expect(picker).toHaveCount(0);
    await expect(inviteButton).toBeFocused();
    expect(writes).toEqual([members[1].id, members[2].id, members[2].id]);
    await page.reload();
    await details.getByRole("tab", { name: "成员", exact: true }).click();
    for (const member of members) await expect(details.getByText(member.name, { exact: true })).toBeVisible();
    await inviteButton.click();
    await picker.getByRole("button", { name: "取消", exact: true }).click();
    await expect(picker).toHaveCount(0);
    expect(writes).toHaveLength(3);

    const memberPage = await contexts[0].newPage();
    await memberPage.goto(`/workspace/chat/${groupId}`);
    await expect(memberPage.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    await expect(memberPage.getByRole("navigation", { name: "共享空间视图" }).getByRole("button", { name: "空间", exact: true })).toHaveCount(0);
    const memberDetails = memberPage.getByLabel("当前会话详情", { exact: true });
    if (!(await memberDetails.isVisible())) await memberPage.getByRole("region", { name: title, exact: true }).getByTitle("查看详情", { exact: true }).click();
    await memberDetails.getByRole("tab", { name: "成员", exact: true }).click();
    await expect(memberDetails.getByRole("button", { name: "邀请成员", exact: true })).toHaveCount(0);
    expect((await contexts[0].request.post(path, { data: { userId: members[2].id } })).status()).toBe(403);
  } finally {
    for (const context of contexts) await context.close();
  }
});
