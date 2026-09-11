import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ timeout: 60_000 });

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
}

test("two members create, join, sync, close, and archive a group topic", async ({ browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const memberName = `话题成员 ${suffix}`;
  const groupTitle = `话题验收群 ${suffix}`;
  const topicTitle = `发布检查 ${suffix}`;
  const topicDescription = "确认双用户话题、同步投影和状态变更。";
  const topicMessageText = `话题进展 ${suffix}`;
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  let memberId: string | null = null;

  try {
    await enterWorkspaceAsSeededOwner(ownerPage);

    const inviteResponse = await ownerPage.request.post("/api/workspace/invites", {
      data: { defaultRole: "member", maxUses: 1 }
    });
    expect(inviteResponse.status()).toBe(201);
    const invite = (await inviteResponse.json() as { invite: { code: string } }).invite;

    const acceptResponse = await memberPage.request.post(
      `/api/workspace/invites/${encodeURIComponent(invite.code)}/accept`,
      {
        data: {
          githubId: `topic-e2e-${suffix}`,
          githubLogin: `topic-e2e-${suffix}`,
          email: `topic-e2e-${suffix}@example.test`,
          displayName: memberName
        }
      }
    );
    expect(acceptResponse.status()).toBe(201);
    const member = (await acceptResponse.json() as { user: { id: string } }).user;
    memberId = member.id;

    const groupResponse = await ownerPage.request.post("/api/workspace/conversations", {
      data: { type: "group", title: groupTitle, memberIds: [member.id] }
    });
    expect(groupResponse.status()).toBe(201);
    const group = (await groupResponse.json() as { conversation: { id: string } }).conversation;

    await ownerPage.goto(`/workspace/chat/${group.id}`);
    await expect(ownerPage.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const ownerGroup = ownerPage.getByRole("region", { name: groupTitle });
    await expect(ownerGroup).toBeVisible();

    const topicSource = `#[${topicTitle}](${topicDescription})`;
    await ownerGroup.getByLabel("输入消息").fill(topicSource);
    const topicCreateResponse = ownerPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await ownerGroup.locator("form.workspace-composer button.workspace-send-button").click();
    expect((await topicCreateResponse).status()).toBe(201);

    const topicsResponse = await ownerPage.request.get(
      `/api/workspace/conversations/${encodeURIComponent(group.id)}/topics`
    );
    expect(topicsResponse.status()).toBe(200);
    const topics = (await topicsResponse.json() as {
      topics: Array<{ id: string; title: string; allowSyncToGroup: boolean }>;
    }).topics;
    const topic = topics.find((candidate) => candidate.title === topicTitle);
    expect(topic).toMatchObject({ title: topicTitle, allowSyncToGroup: true });
    await expect(ownerGroup.getByRole("group", { name: `群聊话题 ${topicTitle}` })).toBeVisible();

    await memberPage.goto(`/workspace/topics/${topic!.id}`);
    await expect(memberPage.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const memberTopic = memberPage.getByRole("region", { name: `话题 ${topicTitle}` });
    await memberTopic.getByRole("button", { name: "话题详情", exact: true }).click();
    const memberDetails = memberPage.getByRole("dialog", { name: "话题详情", exact: true });
    await expect(memberDetails.getByText(topicDescription, { exact: true })).toBeVisible();
    await memberDetails.getByRole("button", { name: "关闭话题详情", exact: true }).click();
    await expect(memberTopic.getByText("加入后参与讨论", { exact: true })).toBeVisible();
    await memberTopic.getByRole("button", { name: "加入话题", exact: true }).click();
    await memberTopic.getByRole("button", { name: "话题详情", exact: true }).click();
    await expect(memberDetails.getByRole("button", { name: "退出话题", exact: true })).toBeVisible();
    await expect(memberDetails.getByRole("radiogroup", { name: "话题提醒" })).toBeVisible();
    await memberDetails.getByRole("radio", { name: "仅提及", exact: true }).click();
    await expect(memberDetails.getByRole("radio", { name: "仅提及", exact: true })).toHaveAttribute("aria-checked", "true");
    await memberDetails.getByRole("button", { name: "关闭话题详情", exact: true }).click();

    const firstTopicMessage = memberTopic.locator("article.workspace-message").first();
    await firstTopicMessage.getByRole("button", { name: "更多消息操作", exact: true }).click();
    const topicMenu = memberPage.getByRole("menu", { name: "消息操作", exact: true });
    await expect(topicMenu.getByRole("menuitem", { name: "同步到群聊", exact: true })).toBeEnabled();
    await expect(topicMenu.getByRole("menuitem", { name: /撤回|常驻/ })).toHaveCount(0);
    await expect(topicMenu.getByRole("menuitem", { name: "添加表情回复", exact: true })).toBeEnabled();
    await expect(topicMenu.getByRole("menuitem", { name: "隐藏消息", exact: true })).toBeEnabled();
    await topicMenu.getByRole("menuitem", { name: "回复", exact: true }).click();
    await expect(memberTopic.locator(".composer-reply")).toContainText(topicDescription);
    await expect(memberTopic.getByTitle("上传文件", { exact: true })).toHaveCount(0);

    const topicEditor = memberTopic.getByLabel("输入消息");
    await topicEditor.click();
    await memberPage.keyboard.insertText(topicMessageText);
    await expect(topicEditor).toHaveText(topicMessageText);
    await memberTopic.getByRole("switch", { name: "同步到群聊", exact: true }).click();
    await expect(memberTopic.getByRole("switch", { name: "同步到群聊", exact: true })).toHaveAttribute("aria-checked", "true");
    const topicMessageResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith(`/api/workspace/topics/${topic!.id}/messages`) &&
      response.request().method() === "POST"
    );
    await memberTopic.getByTitle("发送消息").click();
    expect((await topicMessageResponse).status()).toBe(201);
    await expect(topicEditor).toHaveText("");
    await expect(topicEditor).toBeFocused();
    const memberMessage = memberTopic.locator("article.workspace-message").filter({ hasText: topicMessageText });
    await expect(memberMessage).toBeVisible();
    const moreAction = memberMessage.getByRole("button", { name: "更多消息操作", exact: true });
    await expect(moreAction).toBeEnabled();
    await expect(moreAction).toHaveAttribute("aria-haspopup", "menu");
    await moreAction.click();
    const syncedAction = topicMenu.getByRole("menuitem", { name: "取消同步到群聊", exact: true });
    await expect(syncedAction).toBeEnabled();
    await expect(topicMenu.getByRole("menuitem", { name: "回复", exact: true })).toBeEnabled();
    if (process.env.DUALLANE_UI_REVIEW_DIR) {
      await memberMessage.hover();
      await memberPage.screenshot({ path: `${process.env.DUALLANE_UI_REVIEW_DIR}/topic-actions-desktop.png` });
    }

    await ownerPage.goto(`/workspace/chat/${group.id}`);
    await expect(ownerPage.getByRole("region", { name: groupTitle })
      .getByRole("group", { name: `群聊同步话题 ${topicTitle}` })).toBeVisible();

    await syncedAction.click();
    await moreAction.click();
    await expect(topicMenu.getByRole("menuitem", { name: "同步到群聊", exact: true })).toBeEnabled();
    await memberPage.keyboard.press("Escape");
    await expect(ownerPage.getByRole("region", { name: groupTitle })
      .getByRole("group", { name: `群聊同步话题 ${topicTitle}` })).toHaveCount(0);

    await memberPage.setViewportSize({ width: 390, height: 844 });
    await memberPage.reload();
    const mobileTopic = memberPage.getByRole("region", { name: `话题 ${topicTitle}` });
    const mobileMessage = mobileTopic.locator("article.workspace-message").filter({ hasText: topicMessageText });
    await expect(mobileMessage).toBeVisible();
    const mobileMore = mobileMessage.getByRole("button", { name: "更多消息操作", exact: true });
    await expect(mobileMore).toBeVisible();
    await expect(mobileMessage.getByRole("button", { name: "回复", exact: true })).toHaveCount(0);
    await expect(mobileMessage.getByRole("button", { name: "同步到群聊", exact: true })).toHaveCount(0);
    const moreGeometry = await mobileMore.boundingBox();
    expect(moreGeometry).toBeTruthy();
    expect(moreGeometry!.width).toBeGreaterThanOrEqual(44);
    expect(moreGeometry!.height).toBeGreaterThanOrEqual(44);
    expect(moreGeometry!.x).toBeGreaterThanOrEqual(0);
    expect(moreGeometry!.x + moreGeometry!.width).toBeLessThanOrEqual(390);
    await mobileMore.click();
    const mobileMenu = memberPage.getByRole("menu", { name: "消息操作", exact: true });
    const mobileReply = mobileMenu.getByRole("menuitem", { name: "回复", exact: true });
    const mobileSync = mobileMenu.getByRole("menuitem", { name: "同步到群聊", exact: true });
    await expect(mobileReply).toBeEnabled();
    await expect(mobileSync).toBeEnabled();
    for (const action of [mobileReply, mobileSync]) {
      const bounds = await action.boundingBox();
      expect(bounds).toBeTruthy();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    }
    await memberPage.keyboard.press("Escape");
    await expect(mobileMenu).toHaveCount(0);
    await expect(mobileMore).toBeFocused();
    expect(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.DUALLANE_UI_REVIEW_DIR) await memberPage.screenshot({ path: `${process.env.DUALLANE_UI_REVIEW_DIR}/topic-actions-mobile.png` });

    await ownerPage.goto(`/workspace/topics/${topic!.id}`);
    const ownerTopic = ownerPage.getByRole("region", { name: `话题 ${topicTitle}` });
    await expect(ownerTopic).toBeVisible();
    await ownerTopic.getByRole("button", { name: "话题详情", exact: true }).click();
    const ownerDetails = ownerPage.getByRole("dialog", { name: "话题详情", exact: true });
    await ownerDetails.getByRole("button", { name: "关闭话题", exact: true }).click();
    await ownerDetails.getByRole("button", { name: "关闭话题详情", exact: true }).click();
    await expect(ownerTopic.getByText("话题已关闭，当前为只读状态。", { exact: true })).toBeVisible();
    await ownerTopic.getByRole("button", { name: "话题详情", exact: true }).click();
    await ownerDetails.getByRole("button", { name: "归档话题", exact: true }).click();
    await ownerDetails.getByRole("button", { name: "关闭话题详情", exact: true }).click();
    await expect(ownerTopic.getByText("已归档", { exact: true })).toBeVisible();

    await memberPage.reload();
    await expect(memberPage.getByRole("region", { name: `话题 ${topicTitle}` })
      .getByText("话题已归档，当前为只读状态。", { exact: true })).toBeVisible();
  } finally {
    if (memberId) {
      await ownerPage.request.delete(`/api/workspace/members/${encodeURIComponent(memberId)}`).catch(() => null);
    }
    await Promise.allSettled([ownerContext.close(), memberContext.close()]);
  }
});

test("Echo commands preserve ordinary messages and complete or cancel guided workflows", async ({ page }) => {
  await enterWorkspaceAsSeededOwner(page);
  const bootstrapResponse = await page.request.get("/api/workspace/bootstrap");
  expect(bootstrapResponse.status()).toBe(200);
  const bootstrap = await bootstrapResponse.json() as {
    members: Array<{ id: string; displayName: string }>;
  };
  const echo = bootstrap.members.find((member) => member.id === "usr_system_echo");
  expect(echo?.displayName).toBe("回声");

  const conversationResponse = await page.request.post("/api/workspace/conversations", {
    data: { type: "direct", targetUserId: echo!.id }
  });
  expect(conversationResponse.status()).toBe(201);
  const conversation = (await conversationResponse.json() as { conversation: { id: string } }).conversation;
  await page.goto(`/workspace/chat/${conversation.id}`);
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  const chat = page.getByRole("region", { name: "回声" });
  const composer = chat.getByLabel("输入消息");

  await composer.fill("/help");
  const helpResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/workspace/interactions/commands") && response.request().method() === "POST"
  );
  await chat.locator("form.workspace-composer button.workspace-send-button").click();
  expect((await helpResponse).status()).toBe(200);
  const help = chat.getByRole("region", { name: "回声交互" });
  await expect(help.getByText("可用命令", { exact: true }).first()).toBeVisible();
  await expect(help.getByText("/need", { exact: true })).toBeVisible();
  await help.getByRole("button", { name: "完成", exact: true }).click();
  await expect(help).toHaveCount(0);
  await expect(composer).toBeFocused();

  await composer.fill("/not-a-command");
  const ordinaryResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
  );
  await chat.locator("form.workspace-composer button.workspace-send-button").click();
  const ordinaryMessageResponse = await ordinaryResponse;
  expect(ordinaryMessageResponse.status()).toBe(201);
  const ordinaryMessage = await ordinaryMessageResponse.json() as { message: { id: string } };
  await expect(chat.locator(`[data-message-id="${ordinaryMessage.message.id}"]`).getByText("/not-a-command", { exact: true })).toBeVisible();

  await composer.fill("/need");
  const needCommandResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/workspace/interactions/commands") && response.request().method() === "POST"
  );
  const workflowStartResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/workspace/workflows") && response.request().method() === "POST"
  );
  await chat.locator("form.workspace-composer button.workspace-send-button").click();
  expect((await needCommandResponse).status()).toBe(200);
  expect((await workflowStartResponse).status()).toBe(200);

  const workflow = chat.getByRole("region", { name: "回声交互" });
  await expect(workflow.getByText("简短标题", { exact: true }).first()).toBeVisible();
  await workflow.getByLabel("标题", { exact: true }).fill("浏览器工作流验收");
  await workflow.getByRole("button", { name: "继续", exact: true }).click();
  await workflow.getByLabel("详细描述", { exact: true }).fill("从真实消息输入框完成一条需求引导。");
  await workflow.getByRole("button", { name: "继续", exact: true }).click();
  await workflow.getByLabel("使用场景", { exact: true }).fill("发布候选版本的双用户浏览器回归。");
  await workflow.getByRole("button", { name: "继续", exact: true }).click();
  await workflow.getByLabel("期望结果", { exact: true }).fill("命令、草稿、焦点和终态保持一致。");
  await workflow.getByRole("button", { name: "继续", exact: true }).click();
  await expect(workflow.getByText("确认提交", { exact: true })).toBeVisible();
  await workflow.getByRole("button", { name: "确认", exact: true }).click();
  await expect(workflow.getByText("引导已完成", { exact: true })).toBeVisible();
  await workflow.getByTitle("关闭", { exact: true }).click();
  await expect(workflow).toHaveCount(0);
  await expect(composer).toBeFocused();

  await composer.fill("/feedback");
  await chat.locator("form.workspace-composer button.workspace-send-button").click();
  const cancellable = chat.getByRole("region", { name: "回声交互" });
  await expect(cancellable.getByText("简短标题", { exact: true }).first()).toBeVisible();
  await cancellable.getByLabel("标题", { exact: true }).press("Escape");
  await expect(cancellable.getByText("引导已取消", { exact: true }).first()).toBeVisible();
  await cancellable.getByTitle("关闭", { exact: true }).click();
  await expect(composer).toBeFocused();
});
