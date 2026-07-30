import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/?lane=workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.getByLabel("空间状态").getByText("timeStarry", { exact: true })).toBeVisible();
  await expect(page.getByLabel("空间状态").getByText("实时同步", { exact: true })).toBeVisible();
}

async function installWorkspaceSocketControl(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const workspaceSockets: WebSocket[] = [];
    const TrackedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        if (socket.url.includes("/ws/workspace")) {
          workspaceSockets.push(socket);
        }
        return socket;
      }
    });
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: TrackedWebSocket
    });
    Object.defineProperty(window, "__closeWorkspaceSocketForE2E", {
      configurable: true,
      value: () => {
        const socket = [...workspaceSockets].reverse().find((candidate) => candidate.readyState === NativeWebSocket.OPEN);
        if (!socket) {
          return false;
        }
        socket.close(4000, "workspace e2e reconnect");
        return true;
      }
    });
  });
}

async function workspaceConversationId(page: Page, title: string) {
  const response = await page.request.get("/api/workspace/conversations");
  expect(response.ok()).toBe(true);
  const payload = await response.json() as {
    conversations: Array<{ id: string; displayTitle?: string; title?: string }>;
  };
  const conversation = payload.conversations.find((item) => item.displayTitle === title || item.title === title);
  expect(conversation).toBeTruthy();
  return conversation!.id;
}

async function workspaceConversationUnreadCount(page: Page, conversationId: string) {
  const response = await page.request.get("/api/workspace/conversations");
  if (!response.ok()) {
    return -1;
  }
  const payload = await response.json() as {
    conversations: Array<{ id: string; unreadCount?: number }>;
  };
  return payload.conversations.find((conversation) => conversation.id === conversationId)?.unreadCount ?? -1;
}

function waitForWorkspaceHello(page: Page) {
  return new Promise<number>((resolve) => {
    page.on("websocket", (socket) => {
      if (!socket.url().includes("/ws/workspace")) {
        return;
      }
      socket.on("framesent", (frame) => {
        if (typeof frame.payload !== "string") {
          return;
        }
        try {
          const envelope = JSON.parse(frame.payload) as { type?: string; lastSeq?: number };
          if (envelope.type === "hello" && Number.isFinite(envelope.lastSeq)) {
            resolve(Number(envelope.lastSeq));
          }
        } catch {
          // Ignore non-JSON WebSocket frames.
        }
      });
    });
  });
}

test("two workspace users complete direct, group, file, unread, and reconnect flows", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();

  try {
    await installWorkspaceSocketControl(memberPage);
    await enterWorkspaceAsSeededOwner(ownerPage);

    await ownerPage.getByRole("button", { name: "空间", exact: true }).click();
    await ownerPage.getByRole("tablist", { name: "空间设置" }).getByRole("tab", { name: "邀请", exact: true }).click();
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
    const acceptedMember = (await acceptResponse.json() as { user: { id: string } }).user;

    const memberBootstrapResponse = memberPage.waitForResponse((response) => response.url().endsWith("/api/workspace/bootstrap"));
    const memberWorkspaceHello = waitForWorkspaceHello(memberPage);
    await memberPage.goto("/?lane=workspace");
    const bootstrapPayload = await (await memberBootstrapResponse).json() as { eventCursor?: number };
    expect(await memberWorkspaceHello).toBe(bootstrapPayload.eventCursor);
    await expect(memberPage.getByLabel("空间状态").getByText("E2E 成员", { exact: true })).toBeVisible();
    await expect(memberPage.getByLabel("空间状态").getByText("实时同步", { exact: true })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "创建群聊" })).toHaveCount(0);
    await expect(ownerPage.getByLabel("空间状态").getByText("2 位成员", { exact: true })).toBeVisible();

    const initialMemberDirectory = await memberPage.request.get("/api/workspace/members");
    expect(initialMemberDirectory.status()).toBe(200);
    expect((await initialMemberDirectory.json() as { members: Array<{ id: string }> }).members.map((member) => member.id))
      .toEqual([acceptedMember.id]);

    await ownerPage.getByLabel("共享空间导航").getByRole("button", { name: "发起私聊" }).click();
    const directPicker = ownerPage.getByRole("dialog", { name: "发起私聊" });
    await directPicker.getByRole("button", { name: /E2E 成员/ }).click();

    const ownerConversation = ownerPage
      .getByLabel("共享空间导航")
      .locator("button.conversation")
      .filter({ hasText: "E2E 成员" });
    await expect(ownerConversation).toBeVisible();
    await expect(ownerPage.getByRole("region", { name: "E2E 成员" })).toBeVisible();

    const memberConversation = memberPage
      .getByLabel("共享空间导航")
      .locator("button.conversation")
      .filter({ hasText: "timeStarry" });
    await expect(memberConversation).toBeVisible();
    await memberConversation.click();
    await expect(memberPage.getByRole("region", { name: "timeStarry" })).toBeVisible();

    const contactDirectory = await memberPage.request.get("/api/workspace/members");
    expect(contactDirectory.status()).toBe(200);
    const contactMembers = (await contactDirectory.json() as {
      members: Array<{ id: string; role: string; roleLabel: string }>;
    }).members;
    expect(contactMembers.find((member) => member.id === "usr_owner")).toMatchObject({
      role: "admin",
      roleLabel: "管理员"
    });

    const memberWorkspaceNavigation = memberPage.getByRole("navigation", { name: "共享空间视图" });
    await memberWorkspaceNavigation.getByRole("button", { name: "成员", exact: true }).click();
    await expect(memberPage.getByRole("heading", { name: "可联系成员" })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "主人", exact: true })).toHaveCount(0);
    await expect(memberPage.locator(".workspace-member-card").filter({ hasText: "timeStarry" }).getByText("管理员", { exact: false })).toBeVisible();
    await memberWorkspaceNavigation.getByRole("button", { name: "聊天", exact: true }).click();
    await memberConversation.click();

    const ownerWorkspaceNavigation = ownerPage.getByRole("navigation", { name: "共享空间视图" });
    await ownerWorkspaceNavigation.getByRole("button", { name: "空间", exact: true }).click();
    await ownerPage.getByRole("tablist", { name: "空间设置" }).getByRole("tab", { name: "可见范围", exact: true }).click();
    const automaticOwnerContact = ownerPage.locator(".workspace-visibility-row").filter({ hasText: "timeStarry" });
    await expect(automaticOwnerContact.getByText("已有私聊", { exact: false })).toBeVisible();
    await expect(automaticOwnerContact.locator('input[type="checkbox"]')).toBeChecked();
    await expect(automaticOwnerContact.locator('input[type="checkbox"]')).toBeDisabled();
    await ownerWorkspaceNavigation.getByRole("button", { name: "聊天", exact: true }).click();
    await ownerConversation.click();

    const memberMessage = "workspace-e2e-member-message";
    await memberPage.getByLabel("输入消息").fill(memberMessage);
    await memberPage.locator("form.composer button.send-button").click();
    await expect(ownerPage.getByRole("region", { name: "E2E 成员" }).getByText(memberMessage, { exact: true })).toBeVisible();

    const ownerMessage = "workspace-e2e-owner-message";
    await ownerPage.getByLabel("输入消息").fill(ownerMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    const memberDirectRegion = memberPage.getByRole("region", { name: "timeStarry" });
    await expect(memberDirectRegion.getByText(ownerMessage, { exact: true })).toBeVisible();

    const directConversationId = await workspaceConversationId(ownerPage, "E2E 成员");
    for (let index = 0; index < 28; index += 1) {
      const text = "workspace-e2e-history-" + String(index).padStart(2, "0");
      const response = await ownerPage.request.post("/api/workspace/messages", {
        data: {
          conversationId: directConversationId,
          clientMessageId: "workspace-e2e-history-" + index,
          content: {
            format: "duallane.message+json;v=1",
            plainText: text,
            blocks: [{ type: "text", text }]
          }
        }
      });
      expect(response.status()).toBe(201);
    }
    await expect(memberDirectRegion.getByText("workspace-e2e-history-27", { exact: true })).toBeVisible();
    const directMessageList = memberDirectRegion.locator(".message-list");
    await expect.poll(() => directMessageList.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
    await expect(memberDirectRegion.getByLabel("输入消息")).toBeInViewport();

    await memberDirectRegion.locator(".message-reply").last().click();
    await expect(memberDirectRegion.locator(".composer-reply")).toBeVisible();
    await expect(memberDirectRegion.getByLabel("输入消息")).toBeInViewport();

    await memberPage.setViewportSize({ width: 390, height: 844 });
    await expect(memberDirectRegion).toBeVisible();
    await expect(memberDirectRegion.getByLabel("输入消息")).toBeInViewport();
    await expect(memberDirectRegion.locator(".composer-reply")).toBeInViewport();
    const mobileTitle = memberDirectRegion.getByRole("heading", { name: "timeStarry" });
    await expect(mobileTitle).toBeVisible();
    const mobileHeaderLayout = await memberDirectRegion.locator(".chat-header").evaluate((header) => {
      const heading = header.querySelector<HTMLElement>(".chat-heading");
      const status = header.querySelector<HTMLElement>(".chat-status");
      if (!heading || !status) {
        throw new Error("移动聊天标题或状态区缺失");
      }
      return {
        headingRight: heading.getBoundingClientRect().right,
        headingWidth: heading.getBoundingClientRect().width,
        statusLeft: status.getBoundingClientRect().left
      };
    });
    expect(mobileHeaderLayout.headingWidth).toBeGreaterThan(0);
    expect(mobileHeaderLayout.headingRight).toBeLessThanOrEqual(mobileHeaderLayout.statusLeft + 1);
    await memberDirectRegion.getByRole("button", { name: "取消回复" }).click();
    await memberPage.setViewportSize({ width: 1280, height: 720 });

    const groupTitle = "E2E 双用户群聊";
    await ownerPage.getByRole("button", { name: "创建群聊" }).click();
    const groupDialog = ownerPage.getByRole("dialog", { name: "创建群聊" });
    await groupDialog.getByLabel("群聊名称").fill(groupTitle);
    await groupDialog.getByRole("button", { name: /E2E 成员/ }).click();
    await expect(groupDialog.getByText("已选 1 位", { exact: true })).toBeVisible();
    const groupResponsePromise = ownerPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/conversations") &&
      response.request().method() === "POST"
    );
    await groupDialog.getByRole("button", { name: "创建群聊", exact: true }).click();
    const groupResponse = await groupResponsePromise;
    expect(groupResponse.status()).toBe(201);
    const groupPayload = await groupResponse.json() as { conversation: { id: string } };
    const groupId = groupPayload.conversation.id;

    const ownerGroupRegion = ownerPage.getByRole("region", { name: groupTitle });
    await expect(ownerGroupRegion).toBeVisible();
    await expect(ownerPage.getByLabel("当前会话详情").getByText("E2E 成员", { exact: true })).toBeVisible();
    const detailTabs = ownerPage.getByRole("tablist", { name: "会话详情" });
    const overviewTab = detailTabs.getByRole("tab", { name: "概览" });
    const membersTab = detailTabs.getByRole("tab", { name: "成员" });
    const selectedDetailTab = detailTabs.locator('[role="tab"][aria-selected="true"]');
    await selectedDetailTab.focus();
    await selectedDetailTab.press("Home");
    await expect(overviewTab).toHaveAttribute("aria-selected", "true");
    await overviewTab.press("ArrowRight");
    await expect(membersTab).toHaveAttribute("aria-selected", "true");

    const memberGroupConversation = memberPage
      .getByLabel("共享空间导航")
      .locator("button.conversation")
      .filter({ hasText: groupTitle });
    await expect(memberGroupConversation).toBeVisible();
    await memberGroupConversation.click();
    const memberGroupRegion = memberPage.getByRole("region", { name: groupTitle });
    await expect(memberGroupRegion).toBeVisible();

    const groupMemberMessage = "workspace-e2e-group-member-message";
    await memberGroupRegion.getByLabel("输入消息").fill(groupMemberMessage);
    await memberGroupRegion.locator("form.composer button.send-button").click();
    await expect(ownerGroupRegion.getByText(groupMemberMessage, { exact: true })).toBeVisible();

    const groupOwnerMessage = "workspace-e2e-group-owner-message";
    await ownerGroupRegion.getByLabel("输入消息").fill(groupOwnerMessage);
    await ownerGroupRegion.locator("form.composer button.send-button").click();
    await expect(memberGroupRegion.getByText(groupOwnerMessage, { exact: true })).toBeVisible();
    await expect(memberGroupConversation.locator(".unread-badge")).toHaveCount(0);
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(0);

    const workspaceViewNavigation = memberPage.getByRole("navigation", { name: "共享空间视图" });
    await workspaceViewNavigation.getByRole("button", { name: "文件", exact: true }).click();
    const messageOutsideChatView = "workspace-e2e-message-while-files-view-is-open";
    const hiddenViewMessageResponse = ownerPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await ownerGroupRegion.getByLabel("输入消息").fill(messageOutsideChatView);
    await ownerGroupRegion.locator("form.composer button.send-button").click();
    expect((await hiddenViewMessageResponse).status()).toBe(201);
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(1);

    await workspaceViewNavigation.getByRole("button", { name: "聊天", exact: true }).click();
    await expect(memberGroupRegion.getByText(messageOutsideChatView, { exact: true })).toBeVisible();
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(0);

    const fileName = "workspace-e2e-long-file-name-for-detail-panel-overflow-regression.bin";
    const fileBytes = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255, 68, 117, 97, 108, 76, 97, 110, 101]);
    await ownerGroupRegion.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "application/octet-stream",
      buffer: fileBytes
    });
    const memberFileCard = memberGroupRegion.getByRole("button").filter({ hasText: fileName });
    await expect(memberFileCard).toBeVisible();
    await memberFileCard.click();
    const fileDetails = memberPage.getByLabel("文件详情");
    await expect(fileDetails.getByText(fileName, { exact: true }).first()).toBeVisible();
    await expect(fileDetails.getByTitle("收起详情")).toBeVisible();
    const fileDetailLayout = await fileDetails.evaluate((panel) => {
      const panelRect = panel.getBoundingClientRect();
      const title = panel.querySelector<HTMLElement>(".workspace-context-title");
      const closeButton = panel.querySelector<HTMLElement>('.workspace-context-header [title="收起详情"]');

      const body = panel.querySelector<HTMLElement>(".workspace-context-body");
      if (!title || !closeButton || !body) {
        throw new Error("文件详情标题或收起按钮缺失");
      }

      const titleRect = title.getBoundingClientRect();
      const closeButtonRect = closeButton.getBoundingClientRect();

      return {
        panelRight: panelRect.right,
        titleRight: titleRect.right,
        closeButtonRight: closeButtonRect.right,
        titleClientWidth: title.clientWidth,
        titleScrollWidth: title.scrollWidth,
        bodyScrollTop: body.scrollTop
      };
    });
    expect(fileDetailLayout.titleRight).toBeLessThanOrEqual(fileDetailLayout.panelRight + 1);
    expect(fileDetailLayout.closeButtonRight).toBeLessThanOrEqual(fileDetailLayout.panelRight + 1);
    expect(fileDetailLayout.titleScrollWidth).toBeLessThanOrEqual(fileDetailLayout.titleClientWidth + 1);


    expect(fileDetailLayout.bodyScrollTop).toBe(0);
    const downloadPromise = memberPage.waitForEvent("download");
    await fileDetails.getByRole("button", { name: "下载文件", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(fileName);
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    expect(await readFile(downloadPath!)).toEqual(fileBytes);

    const socketClosed = await memberPage.evaluate(() =>
      (window as Window & { __closeWorkspaceSocketForE2E?: () => boolean }).__closeWorkspaceSocketForE2E?.() ?? false
    );
    expect(socketClosed).toBe(true);
    await memberContext.setOffline(true);
    await expect(memberPage.getByLabel("空间状态").getByText("实时同步已断开", { exact: true })).toBeVisible();

    const replayedMessage = "workspace-e2e-message-during-reconnect";
    const replayedMessageResponse = ownerPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await ownerGroupRegion.getByLabel("输入消息").fill(replayedMessage);
    await ownerGroupRegion.locator("form.composer button.send-button").click();
    expect((await replayedMessageResponse).status()).toBe(201);
    await expect(memberGroupRegion.getByText(replayedMessage, { exact: true })).toHaveCount(0);
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(1);

    await memberContext.setOffline(false);
    await expect(memberGroupRegion.getByText(replayedMessage, { exact: true })).toBeVisible();
    await expect(memberPage.getByLabel("空间状态").getByText("实时同步", { exact: true })).toBeVisible();
    await expect(memberGroupConversation.locator(".unread-badge")).toHaveCount(0);
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(0);
  } finally {
    await Promise.all([ownerContext.close(), memberContext.close()]);
  }
});
