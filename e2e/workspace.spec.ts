import { expect, test, type Page } from "@playwright/test";

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/?lane=workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.getByLabel("空间状态").getByText("timeStarry", { exact: true })).toBeVisible();
  await expect(page.getByLabel("空间状态").getByText("实时同步", { exact: true })).toBeVisible();
}

test("an invited member starts a direct chat and exchanges realtime messages with the owner", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();

  try {
    await enterWorkspaceAsSeededOwner(ownerPage);

    await ownerPage.getByRole("button", { name: "空间", exact: true }).click();
    await ownerPage.getByRole("tablist", { name: "空间设置" }).getByRole("button", { name: "邀请", exact: true }).click();
    await ownerPage.getByRole("button", { name: "创建成员邀请" }).click();
    await expect(ownerPage.getByText("邀请已创建，可以复制发送给成员。", { exact: true })).toBeVisible();

    const inviteLink = (await ownerPage.locator(".compact-copy > span").textContent())?.trim() ?? "";
    const inviteUrl = new URL(inviteLink);
    const inviteCode = inviteUrl.searchParams.get("invite");
    expect(inviteCode).toBeTruthy();

    await memberPage.goto(inviteLink);
    await expect(memberPage.getByRole("button", { name: "使用 GitHub 登录" })).toBeVisible();
    await expect(memberPage.locator("p.quiet").filter({ hasText: "进入权限由服务端校验" })).toBeVisible();

    const acceptResponse = await memberPage.request.post(`/api/workspace/invites/${encodeURIComponent(inviteCode!)}/accept`, {
      data: {
        githubId: "duallane-e2e-member-id",
        githubLogin: "duallane-e2e-member",
        email: "duallane-e2e-member@example.test",
        displayName: "E2E 成员"
      }
    });
    expect(acceptResponse.status()).toBe(201);

    await memberPage.goto("/?lane=workspace");
    await expect(memberPage.getByLabel("空间状态").getByText("E2E 成员", { exact: true })).toBeVisible();
    await expect(memberPage.getByLabel("空间状态").getByText("实时同步", { exact: true })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "创建群聊" })).toHaveCount(0);
    await expect(ownerPage.getByLabel("空间状态").getByText("2 位成员", { exact: true })).toBeVisible();

    await memberPage.getByLabel("共享空间主视图").getByRole("button", { name: "发起私聊" }).click();
    const directPicker = memberPage.getByRole("dialog", { name: "发起私聊" });
    await directPicker.getByRole("button", { name: /timeStarry/ }).click();

    await expect(memberPage.getByRole("region", { name: "timeStarry" })).toBeVisible();
    const ownerConversation = ownerPage
      .getByLabel("共享空间导航")
      .locator("button.conversation")
      .filter({ hasText: "E2E 成员" });
    await expect(ownerConversation).toBeVisible();
    await ownerConversation.click();
    await expect(ownerPage.getByRole("region", { name: "E2E 成员" })).toBeVisible();

    const memberMessage = "workspace-e2e-member-message";
    await memberPage.getByLabel("输入消息").fill(memberMessage);
    await memberPage.locator("form.composer button.send-button").click();
    await expect(ownerPage.getByRole("region", { name: "E2E 成员" }).getByText(memberMessage, { exact: true })).toBeVisible();

    const ownerMessage = "workspace-e2e-owner-message";
    await ownerPage.getByLabel("输入消息").fill(ownerMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    await expect(memberPage.getByRole("region", { name: "timeStarry" }).getByText(ownerMessage, { exact: true })).toBeVisible();
  } finally {
    await Promise.all([ownerContext.close(), memberContext.close()]);
  }
});
