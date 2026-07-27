import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

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

    const memberBootstrapResponse = memberPage.waitForResponse((response) => response.url().endsWith("/api/workspace/bootstrap"));
    const memberWorkspaceHello = waitForWorkspaceHello(memberPage);
    await memberPage.goto("/?lane=workspace");
    const bootstrapPayload = await (await memberBootstrapResponse).json() as { eventCursor?: number };
    expect(await memberWorkspaceHello).toBe(bootstrapPayload.eventCursor);
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

    const fileName = "workspace-e2e-bytes.bin";
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
