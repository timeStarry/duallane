import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/?lane=workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-user-trigger").getByText("timeStarry", { exact: true })).toBeVisible();
  await expect(page.locator(".workspace-product-shell")).toBeVisible();
  await expect(page.locator(".workspace-connection-state")).toHaveCount(0);
}

async function openWorkspaceCreateMenu(page: Page, action: "发起私聊" | "创建群聊") {
  await page.getByTitle("新建").click();
  await page.locator(".workspace-create-menu").getByRole("button", { name: action, exact: true }).click();
}

async function openWorkspaceSpaceSettings(page: Page) {
  await page.locator(".workspace-user-trigger").click();
  await page.locator(".workspace-user-menu").getByRole("button", { name: "空间信息与设置", exact: true }).click();
}

async function sendWorkspaceComposer(page: Page | Locator) {
  await page.locator("form.workspace-composer button.workspace-send-button").click();
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

    await openWorkspaceSpaceSettings(ownerPage);
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
    await expect(memberPage.locator(".workspace-user-trigger").getByText("E2E 成员", { exact: true })).toBeVisible();
    await expect(memberPage.locator(".workspace-connection-state")).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "创建群聊" })).toHaveCount(0);

    const initialMemberDirectory = await memberPage.request.get("/api/workspace/members");
    expect(initialMemberDirectory.status()).toBe(200);
    expect((await initialMemberDirectory.json() as { members: Array<{ id: string }> }).members.map((member) => member.id))
      .toEqual([acceptedMember.id]);

    await openWorkspaceCreateMenu(ownerPage, "发起私聊");
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
    await openWorkspaceSpaceSettings(ownerPage);
    await ownerPage.getByRole("tablist", { name: "空间设置" }).getByRole("tab", { name: "可见范围", exact: true }).click();
    const automaticOwnerContact = ownerPage.locator(".workspace-visibility-row").filter({ hasText: "timeStarry" });
    await expect(automaticOwnerContact.getByText("已有私聊", { exact: false })).toBeVisible();
    await expect(automaticOwnerContact.locator('input[type="checkbox"]')).toBeChecked();
    await expect(automaticOwnerContact.locator('input[type="checkbox"]')).toBeDisabled();
    await ownerWorkspaceNavigation.getByRole("button", { name: "聊天", exact: true }).click();
    await ownerConversation.click();

    const memberMessage = "workspace-e2e-member-message";
    await memberPage.getByLabel("输入消息").fill(memberMessage);
    await sendWorkspaceComposer(memberPage);
    await expect(ownerPage.getByRole("region", { name: "E2E 成员" }).getByText(memberMessage, { exact: true })).toBeVisible();

    const ownerMessage = "workspace-e2e-owner-message";
    await ownerPage.getByLabel("输入消息").fill(ownerMessage);
    await sendWorkspaceComposer(ownerPage);
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
    const directMessageList = memberDirectRegion.locator(".workspace-message-list");
    await expect.poll(() => directMessageList.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
    await expect(memberDirectRegion.getByLabel("输入消息")).toBeInViewport();

    await memberDirectRegion.getByTitle("回复").last().click();
    await expect(memberDirectRegion.locator(".composer-reply")).toBeVisible();
    await expect(memberDirectRegion.getByLabel("输入消息")).toBeInViewport();

    await memberPage.setViewportSize({ width: 390, height: 844 });
    await expect(memberDirectRegion).toBeVisible();
    await expect(memberDirectRegion.getByLabel("输入消息")).toBeInViewport();
    await expect(memberDirectRegion.locator(".composer-reply")).toBeInViewport();
    const mobileTitle = memberDirectRegion.locator(".workspace-chat-heading strong").filter({ hasText: "timeStarry" });
    await expect(mobileTitle).toBeVisible();
    const mobileHeaderLayout = await memberDirectRegion.locator(".workspace-chat-header").evaluate((header) => {
      const heading = header.querySelector<HTMLElement>(".workspace-chat-heading");
      const actions = header.querySelector<HTMLElement>(".workspace-chat-actions");
      if (!heading || !actions) {
        throw new Error("移动聊天标题或操作区缺失");
      }
      return {
        headingRight: heading.getBoundingClientRect().right,
        headingWidth: heading.getBoundingClientRect().width,
        actionsLeft: actions.getBoundingClientRect().left
      };
    });
    expect(mobileHeaderLayout.headingWidth).toBeGreaterThan(0);
    expect(mobileHeaderLayout.headingRight).toBeLessThanOrEqual(mobileHeaderLayout.actionsLeft + 1);
    await memberDirectRegion.getByRole("button", { name: "取消回复" }).click();
    await memberPage.setViewportSize({ width: 1280, height: 720 });

    const groupTitle = "E2E 双用户群聊";
    await openWorkspaceCreateMenu(ownerPage, "创建群聊");
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
    await expect(ownerPage.getByLabel("当前会话详情")).toHaveCount(0);
    await expect.poll(() => ownerPage.evaluate(() => localStorage.getItem("duallane.workspace.context-open"))).toBe("false");
    await ownerGroupRegion.getByTitle("查看详情").click();
    await expect(ownerPage.getByLabel("当前会话详情").getByText("2 位成员", { exact: true })).toBeVisible();
    await expect.poll(() => ownerPage.evaluate(() => localStorage.getItem("duallane.workspace.context-open"))).toBe("true");
    const detailTabs = ownerPage.getByRole("tablist", { name: "会话详情" });
    const overviewTab = detailTabs.getByRole("tab", { name: "概览" });
    const membersTab = detailTabs.getByRole("tab", { name: "成员" });
    const selectedDetailTab = detailTabs.locator('[role="tab"][aria-selected="true"]');
    await selectedDetailTab.focus();
    await selectedDetailTab.press("Home");
    await expect(overviewTab).toHaveAttribute("aria-selected", "true");
    await overviewTab.press("ArrowRight");
    await expect(membersTab).toHaveAttribute("aria-selected", "true");
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
    await sendWorkspaceComposer(memberGroupRegion);
    await expect(ownerGroupRegion.getByText(groupMemberMessage, { exact: true })).toBeVisible();

    const groupOwnerMessage = "workspace-e2e-group-owner-message";
    await ownerGroupRegion.getByLabel("输入消息").fill(groupOwnerMessage);
    await sendWorkspaceComposer(ownerGroupRegion);
    await expect(memberGroupRegion.getByText(groupOwnerMessage, { exact: true })).toBeVisible();
    await expect(memberGroupConversation.locator(".unread-badge")).toHaveCount(0);
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(0);

    await memberConversation.click();
    await directMessageList.evaluate((list) => {
      list.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      list.scrollTop = Math.min(180, Math.max(0, list.scrollHeight - list.clientHeight - 120));
      list.dispatchEvent(new Event("scroll"));
    });
    const savedDirectScrollTop = await directMessageList.evaluate((list) => list.scrollTop);
    await memberGroupConversation.click();
    await memberConversation.click();
    await expect.poll(() => directMessageList.evaluate((list) => list.scrollTop)).toBeCloseTo(savedDirectScrollTop, 0);

    await directMessageList.evaluate((list) => {
      list.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll"));
    });
    const historyMessage = "workspace-e2e-new-message-while-reading-history";
    const historyMessageResponse = await ownerPage.request.post("/api/workspace/messages", {
      data: {
        conversationId: directConversationId,
        clientMessageId: "workspace-e2e-reading-history",
        content: {
          format: "duallane.message+json;v=1",
          plainText: historyMessage,
          blocks: [{ type: "text", text: historyMessage }]
        }
      }
    });
    expect(historyMessageResponse.status()).toBe(201);
    await expect(memberDirectRegion.getByText(historyMessage, { exact: true })).toBeVisible();
    await expect(memberDirectRegion.getByText("以下为未读消息", { exact: true })).toBeVisible();
    const jumpToLatest = memberDirectRegion.getByRole("button", { name: "1 条新消息", exact: true });
    await expect(jumpToLatest).toBeVisible();
    expect(await directMessageList.evaluate((list) => list.scrollTop)).toBeLessThanOrEqual(2);
    await jumpToLatest.click();
    await expect(jumpToLatest).toHaveCount(0);
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, directConversationId)).toBe(0);
    await memberGroupConversation.click();

    const workspaceViewNavigation = memberPage.getByRole("navigation", { name: "共享空间视图" });
    await workspaceViewNavigation.getByRole("button", { name: "文件", exact: true }).click();
    const messageOutsideChatView = "workspace-e2e-message-while-files-view-is-open";
    const hiddenViewMessageResponse = ownerPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await ownerGroupRegion.getByLabel("输入消息").fill(messageOutsideChatView);
    await sendWorkspaceComposer(ownerGroupRegion);
    expect((await hiddenViewMessageResponse).status()).toBe(201);
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(1);

    await workspaceViewNavigation.getByRole("button", { name: "聊天", exact: true }).click();
    await expect(memberGroupRegion.getByText(messageOutsideChatView, { exact: true })).toBeVisible();
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(0);

    const pastedImageName = "workspace-e2e-pasted-image.png";
    const pastedImageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    let attachmentReserveCount = 0;
    let rejectNextAttachment = true;
    await ownerPage.route("**/api/workspace/files/uploads/reserve", async (route) => {
      attachmentReserveCount += 1;
      if (rejectNextAttachment) {
        rejectNextAttachment = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "internal.error", message: "E2E upload failure" } })
        });
        return;
      }
      await route.continue();
    });
    await ownerGroupRegion.getByLabel("输入消息").evaluate((textarea, image) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(image.bytes)], image.name, { type: "image/png" }));
      textarea.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer
      }));
    }, { name: pastedImageName, bytes: Array.from(pastedImageBytes) });

    const fileName = "workspace-e2e-long-file-name-for-detail-panel-overflow-regression.bin";
    const fileBytes = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255, 68, 117, 97, 108, 76, 97, 110, 101]);
    await ownerGroupRegion.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "application/octet-stream",
      buffer: fileBytes
    });
    const stagedFiles = ownerGroupRegion.getByLabel("待发送附件");
    await expect(stagedFiles.getByText(pastedImageName, { exact: true })).toBeVisible();
    await expect(stagedFiles.getByText(fileName, { exact: true })).toBeVisible();
    expect(attachmentReserveCount).toBe(0);
    await expect(memberGroupRegion.getByRole("button").filter({ hasText: pastedImageName })).toHaveCount(0);
    await expect(memberGroupRegion.getByRole("button").filter({ hasText: fileName })).toHaveCount(0);

    await sendWorkspaceComposer(ownerGroupRegion);
    await expect(stagedFiles.locator(".workspace-staged-file.failed")).toHaveCount(1);
    await expect(stagedFiles.locator(".workspace-staged-file.uploaded")).toHaveCount(1);
    expect(attachmentReserveCount).toBe(2);
    await expect(memberGroupRegion.getByRole("button").filter({ hasText: pastedImageName })).toHaveCount(0);
    await expect(memberGroupRegion.getByRole("button").filter({ hasText: fileName })).toHaveCount(0);

    const attachmentMessageRequest = ownerPage.waitForRequest((request) =>
      request.url().endsWith("/api/workspace/messages") && request.method() === "POST"
    );
    await sendWorkspaceComposer(ownerGroupRegion);
    const attachmentPayload = (await attachmentMessageRequest).postDataJSON() as {
      content: { blocks: Array<{ type: string }> };
    };
    expect(attachmentPayload.content.blocks.filter((block) => block.type === "attachment")).toHaveLength(2);
    expect(attachmentReserveCount).toBe(3);
    await ownerPage.unroute("**/api/workspace/files/uploads/reserve");

    const pastedImageCard = memberGroupRegion.getByRole("button").filter({ hasText: pastedImageName });
    await expect(pastedImageCard).toBeVisible();
    const pastedImagePreview = pastedImageCard.locator("img.message-image-preview");
    await expect(pastedImagePreview).toBeVisible();
    await expect.poll(() => pastedImagePreview.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await pastedImageCard.click();
    const imageViewer = memberPage.getByRole("dialog", { name: pastedImageName });
    await expect(imageViewer).toBeVisible();
    await memberPage.keyboard.press("Escape");
    await expect(imageViewer).toHaveCount(0);

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
    const downloadToast = memberPage.getByRole("status").filter({ hasText: `已开始下载 ${fileName}` });
    await expect(downloadToast).toBeVisible();
    await downloadToast.getByRole("button", { name: "关闭提示" }).click();
    await expect(downloadToast).toHaveCount(0);

    const socketClosed = await memberPage.evaluate(() =>
      (window as Window & { __closeWorkspaceSocketForE2E?: () => boolean }).__closeWorkspaceSocketForE2E?.() ?? false
    );
    expect(socketClosed).toBe(true);
    await memberContext.setOffline(true);
    await expect(memberPage.locator(".workspace-connection-state").getByText("实时同步已断开", { exact: true })).toBeVisible();

    const replayedMessage = "workspace-e2e-message-during-reconnect";
    const replayedMessageResponse = ownerPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await ownerGroupRegion.getByLabel("输入消息").fill(replayedMessage);
    await sendWorkspaceComposer(ownerGroupRegion);
    expect((await replayedMessageResponse).status()).toBe(201);
    await expect(memberGroupRegion.getByText(replayedMessage, { exact: true })).toHaveCount(0);
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(1);

    await memberContext.setOffline(false);
    await expect(memberGroupRegion.getByText(replayedMessage, { exact: true })).toBeVisible();
    await expect(memberPage.locator(".workspace-connection-state")).toHaveCount(0);
    await expect(memberGroupConversation.locator(".unread-badge")).toHaveCount(0);
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(0);

    for (const viewport of [
      { width: 2048, height: 1152 },
      { width: 1440, height: 900 },
      { width: 1024, height: 768 }
    ]) {
      await memberPage.setViewportSize(viewport);
      await expect(memberPage.locator(".workspace-product-shell")).toBeVisible();
      expect(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const shellBox = await memberPage.locator(".workspace-product-shell").boundingBox();
      expect(shellBox?.width).toBeGreaterThanOrEqual(viewport.width - 1);
    }

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 360, height: 800 }
    ]) {
      await memberPage.setViewportSize(viewport);
      const mobileNavigation = memberPage.getByRole("navigation", { name: "共享空间移动导航" });
      await expect(mobileNavigation).toBeVisible();
      await mobileNavigation.getByRole("button", { name: "聊天", exact: true }).click();
      await expect(memberPage.getByLabel("共享空间导航")).toBeVisible();
      await memberGroupConversation.click();
      await expect(memberGroupRegion.getByText(replayedMessage, { exact: true })).toBeInViewport();
      await expect(memberGroupRegion.getByLabel("输入消息")).toBeInViewport();
      expect(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  } finally {
    await Promise.all([ownerContext.close(), memberContext.close()]);
  }
});
