import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";

test.describe.configure({ timeout: 240_000 });

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".workspace-user-trigger").getByText("timeStarry", { exact: true })).toBeVisible();
  await expect(page.locator(".workspace-product-shell")).toBeVisible();
  await expect(page.locator(".workspace-connection-state")).toHaveCount(0);
}

test("public about page exposes the current release and accessible history", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "关于 DualLane 与版本更新" }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { name: "两种边界，一处沟通。" })).toBeVisible();
  await expect(page.locator(".latest-release").getByText("v0.11.0", { exact: true })).toBeVisible();

  const history = page.locator(".release-history");
  await expect(history).not.toHaveAttribute("open", "");
  await history.getByText("查看历史版本", { exact: true }).click();
  await expect(history).toHaveAttribute("open", "");
  await expect(page.locator(".historical-release").filter({ hasText: "v0.7.0" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "选择沟通方式" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/about$/);
  await page.reload();
  await expect(page.locator(".latest-release").getByText("v0.11.0", { exact: true })).toBeVisible();
});

test("workspace semantic routes survive OAuth, refresh, history, and invalid resources", async ({ page }) => {
  await page.goto("/workspace/space/email");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page).toHaveURL(/\/workspace\/space\/email$/);
  await expect(page.getByRole("tab", { name: "邮件", exact: true })).toHaveAttribute("aria-selected", "true");

  await page.reload();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.getByRole("tab", { name: "邮件", exact: true })).toHaveAttribute("aria-selected", "true");

  const bootstrapResponse = await page.request.get("/api/workspace/bootstrap");
  expect(bootstrapResponse.ok()).toBe(true);
  const bootstrap = await bootstrapResponse.json() as { members: Array<{ id: string; kind: string }> };
  const beacon = bootstrap.members.find((member) => member.kind === "bot");
  expect(beacon).toBeTruthy();
  const conversationResponse = await page.request.post("/api/workspace/conversations", {
    data: { type: "direct", targetUserId: beacon!.id }
  });
  expect(conversationResponse.ok()).toBe(true);
  const conversation = await conversationResponse.json() as { conversation: { id: string } };
  await page.goto(`/workspace/chat/${conversation.conversation.id}`);
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page).toHaveURL(new RegExp(`/workspace/chat/${conversation.conversation.id}$`));
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/workspace/chat/${conversation.conversation.id}$`));

  await page.getByRole("navigation", { name: "共享空间视图" }).getByRole("button", { name: "文件", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/files$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "共享文件" })).toBeVisible();
  await page.getByRole("navigation", { name: "共享空间视图" }).getByRole("button", { name: "成员", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/members$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "空间成员" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/workspace\/files$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/workspace\/members$/);

  await page.locator(".workspace-user-trigger").click();
  await page.locator(".workspace-user-menu").getByRole("menuitem", { name: "个人设置", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/account$/);
    await page.reload();
    await expect(page.getByRole("heading", { name: "个人设置" })).toBeVisible();
    await page.getByRole("button", { name: /通知/ }).click();
    await expect(page).toHaveURL(/\/workspace\/account\/notifications$/);
    await page.getByRole("button", { name: /邮件通知/ }).click();
    await expect(page).toHaveURL(/\/workspace\/account\/notifications\/email$/);
    await page.reload();
    await expect(page.getByRole("heading", { name: "邮件通知", level: 2 })).toBeVisible();
    await page.getByRole("button", { name: "返回通知" }).click();
    await page.getByRole("button", { name: "返回个人设置" }).click();

  await page.goto("/workspace/files/not-a-real-file");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page).toHaveURL(/\/workspace\/files$/);
  await expect(page.getByText("该文件不存在或无权访问，已返回文件库")).toBeVisible();

  await page.goto("/?lane=workspace");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page).not.toHaveURL(/lane=workspace/);
});

async function openWorkspaceCreateMenu(page: Page, action: "发起私聊" | "创建群聊") {
  await page.getByTitle("新建").click();
  await page.locator(".workspace-create-menu").getByRole("menuitem", { name: action, exact: true }).click();
}

async function openWorkspaceSpaceSettings(page: Page) {
  await page.locator(".workspace-user-trigger").click();
  await page.locator(".workspace-user-menu").getByRole("menuitem", { name: "空间信息与设置", exact: true }).click();
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

test("workspace loading, navigation and menu focus semantics are stable", async ({ page }) => {
  let releaseBootstrap = () => {};
  const bootstrapGate = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  let holdFirstBootstrap = true;
  await page.route("**/api/workspace/bootstrap", async (route) => {
    if (holdFirstBootstrap) {
      holdFirstBootstrap = false;
      await bootstrapGate;
    }
    await route.continue();
  });

  await page.goto("/?lane=workspace");
  const shell = page.locator(".workspace-shell");
  await expect(shell).toHaveAttribute("data-app-state", "loading");
  await expect(shell).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("status").filter({ hasText: "正在加载共享空间" })).toBeVisible();
  releaseBootstrap();

  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(shell).toHaveAttribute("data-app-state", "ready");
  await expect(shell).toHaveAttribute("aria-busy", "false");

  const spaceLogo = page.locator(".workspace-space-logo");
  await expect(spaceLogo).toHaveAttribute("src", "/icon-512.png");
  await expect(spaceLogo).toHaveCSS("width", "36px");
  await expect(spaceLogo).toHaveCSS("height", "36px");

  const viewNavigation = page.getByRole("navigation", { name: "共享空间视图" });
  const chatTab = viewNavigation.getByRole("button", { name: "聊天", exact: true });
  const memberTab = viewNavigation.getByRole("button", { name: "成员", exact: true });
  await expect(chatTab).toHaveAttribute("aria-current", "page");
  await expect(chatTab).toHaveAttribute("aria-controls", "workspace-main-panel");
  await memberTab.click();
  await expect(memberTab).toHaveAttribute("aria-current", "page");
  await expect(chatTab).not.toHaveAttribute("aria-current", "page");

  const createTrigger = page.getByTitle("新建");
  await createTrigger.click();
  const createMenu = page.getByRole("menu", { name: "新建菜单" });
  const directMenuItem = createMenu.getByRole("menuitem", { name: "发起私聊" });
  await expect(directMenuItem).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createTrigger).toBeFocused();

  await createTrigger.click();
  await directMenuItem.click();
  const createTask = page.getByRole("region", { name: "发起私聊" });
  await expect(createTask.getByPlaceholder("输入昵称或 GitHub 登录名")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createTask).toHaveCount(0);
  await expect(createTrigger).toBeFocused();

  const userTrigger = page.locator(".workspace-user-trigger");
  await userTrigger.click();
  const userMenu = page.getByRole("menu", { name: "账号菜单" });
  await expect(userMenu.getByRole("menuitem", { name: "个人设置" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(userMenu.getByRole("menuitem", { name: "退出共享空间" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(userTrigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileNavigation = page.getByRole("navigation", { name: "共享空间移动导航" });
  await expect(mobileNavigation).toBeVisible();
  const mobileChat = mobileNavigation.getByRole("button", { name: "聊天", exact: true });
  const mobileChatBox = await mobileChat.boundingBox();
  expect(mobileChatBox?.height).toBeGreaterThanOrEqual(44);
  expect(mobileChatBox?.width).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test("two workspace users complete direct, group, file, unread, and reconnect flows", async ({ browser }) => {
  const memberSuffix = randomUUID().slice(0, 8);
  const memberDisplayName = `E2E 成员 ${memberSuffix}`;
  const ownerContext = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const memberContext = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const outsiderContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  const outsiderPage = await outsiderContext.newPage();

  try {
    await installWorkspaceSocketControl(memberPage);
    await enterWorkspaceAsSeededOwner(ownerPage);

    await openWorkspaceSpaceSettings(ownerPage);
    await ownerPage.getByRole("tablist", { name: "空间设置" }).getByRole("tab", { name: "邀请", exact: true }).click();
    await ownerPage.getByRole("button", { name: "创建成员邀请" }).click();
    await expect(ownerPage.getByText("邀请已创建，可以复制发送给成员。", { exact: true })).toBeVisible();

    const inviteLink = (await ownerPage.locator(".compact-copy > span").textContent())?.trim() ?? "";
    const inviteUrl = new URL(inviteLink);
    expect(inviteUrl.origin).toBe(new URL(ownerPage.url()).origin);
    expect(inviteUrl.pathname).toBe("/workspace");
    const inviteCode = inviteUrl.searchParams.get("invite");
    expect(inviteCode).toBeTruthy();
    await expect(ownerPage.getByRole("definition")).toHaveCount(4);

    await memberPage.goto(inviteLink);
    await expect(memberPage.getByRole("button", { name: "使用 GitHub 登录" })).toBeVisible();
    await expect(memberPage.locator("p.quiet").filter({ hasText: "进入权限由服务端校验" })).toBeVisible();

    const acceptResponse = await memberPage.request.post(`/api/workspace/invites/${encodeURIComponent(inviteCode!)}/accept`, {
      data: {
        githubId: `duallane-e2e-member-id-${memberSuffix}`,
        githubLogin: `duallane-e2e-${memberSuffix}`,
        email: `duallane-e2e-${memberSuffix}@example.test`,
        displayName: memberDisplayName
      }
    });
    expect(acceptResponse.status()).toBe(201);
    const acceptedMember = (await acceptResponse.json() as { user: { id: string } }).user;

    await ownerPage.reload();
    await expect(ownerPage.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const inviteHistory = ownerPage.locator(".workspace-invite-history");
    await expect(inviteHistory).not.toHaveAttribute("open", "");
    await inviteHistory.locator("summary").click();
    const usedInviteRow = inviteHistory.locator(".workspace-invite-row").filter({ hasText: memberDisplayName });
    await expect(usedInviteRow).toBeVisible();
    await expect(usedInviteRow.getByText(memberDisplayName, { exact: true })).toBeVisible();

    const memberBootstrapResponse = memberPage.waitForResponse((response) => response.url().endsWith("/api/workspace/bootstrap"));
    const memberWorkspaceHello = waitForWorkspaceHello(memberPage);
    await memberPage.goto("/?lane=workspace");
    const bootstrapPayload = await (await memberBootstrapResponse).json() as { eventCursor?: number };
    expect(await memberWorkspaceHello).toBe(bootstrapPayload.eventCursor);
    await expect(memberPage.locator(".workspace-user-trigger").getByText(memberDisplayName, { exact: true })).toBeVisible();
    await expect(memberPage.locator(".workspace-connection-state")).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "创建群聊" })).toHaveCount(0);

    const initialMemberDirectory = await memberPage.request.get("/api/workspace/members");
    expect(initialMemberDirectory.status()).toBe(200);
    const initialMembers = (await initialMemberDirectory.json() as {
      members: Array<{
        id: string;
        displayName: string;
        description?: string;
        kind: string;
        capabilities?: { canStartDirectConversation?: boolean; canJoinGroups?: boolean };
      }>;
    }).members;
    expect(initialMembers.map((member) => member.id)).toEqual([acceptedMember.id, "usr_system_beacon"]);
    expect(initialMembers.find((member) => member.id === "usr_system_beacon")).toMatchObject({
      displayName: "信标",
      description: "文件传输助手",
      kind: "bot",
      capabilities: {
        canStartDirectConversation: true,
        canJoinGroups: false
      }
    });

    await openWorkspaceCreateMenu(memberPage, "发起私聊");
    const memberDirectPicker = memberPage.getByRole("region", { name: "发起私聊" });
    const beaconPickerRow = memberDirectPicker.getByRole("button", { name: /信标/ });
    await expect(beaconPickerRow.getByText("BOT", { exact: true })).toBeVisible();
    await expect(beaconPickerRow.getByText("文件传输助手", { exact: true })).toBeVisible();
    await beaconPickerRow.click();

    const beaconRegion = memberPage.getByRole("region", { name: "信标" });
    await expect(beaconRegion).toBeVisible();
    const beaconHeaderBadge = beaconRegion.locator(".workspace-chat-heading").getByText("BOT", { exact: true });
    await expect(beaconHeaderBadge).toBeVisible();
    const beaconHeaderBadgeBox = await beaconHeaderBadge.boundingBox();
    expect(beaconHeaderBadgeBox?.width).toBeLessThan(50);
    expect(beaconHeaderBadgeBox?.height).toBeLessThanOrEqual(20);
    await expect(beaconRegion.locator(".workspace-chat-heading").getByText("文件传输助手", { exact: true })).toBeVisible();
    const beaconText = "workspace-e2e-beacon-private";
    const beaconComposer = beaconRegion.getByLabel("输入消息");
    await beaconComposer.fill(beaconText);
    await sendWorkspaceComposer(beaconRegion);
    await expect(beaconRegion.locator(".workspace-message-list").getByText(beaconText, { exact: true })).toBeVisible();
    await expect(beaconComposer).toBeFocused();

    const codeOnlyMarkdown = "~~~python\nimport stdio\nmain() {}\n~~~";
    await beaconRegion.getByLabel("输入消息").fill(codeOnlyMarkdown);
    const codeMessageResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await sendWorkspaceComposer(beaconRegion);
    expect((await codeMessageResponse).status()).toBe(201);
    await expect(beaconRegion.locator("pre code").filter({ hasText: "import stdio" })).toBeVisible();

    await beaconRegion.getByLabel("输入消息").fill("[链接文本](https://)");
    const incompleteLinkResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await sendWorkspaceComposer(beaconRegion);
    expect((await incompleteLinkResponse).status()).toBe(201);
    await expect(beaconRegion.getByText("链接文本", { exact: true })).toBeVisible();

    const literalUrl = "https://example.test/files?id=42";
    await beaconRegion.getByLabel("输入消息").fill(`访问 ${literalUrl} 查看文件`);
    const literalUrlResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await sendWorkspaceComposer(beaconRegion);
    expect((await literalUrlResponse).status()).toBe(201);
    const literalUrlBody = beaconRegion.locator(".workspace-markdown").filter({ hasText: literalUrl }).last();
    const literalUrlLink = literalUrlBody.getByRole("link", { name: literalUrl, exact: true });
    await expect(literalUrlLink).toHaveAttribute("href", literalUrl);
    await expect(literalUrlBody).toHaveText(`访问 ${literalUrl} 查看文件`);

    const beaconConversationId = await workspaceConversationId(memberPage, "信标");
    const reusedBeacon = await memberPage.request.post("/api/workspace/conversations", {
      data: { type: "direct", targetUserId: "usr_system_beacon" }
    });
    expect(reusedBeacon.status()).toBe(201);
    expect((await reusedBeacon.json() as { conversation: { id: string } }).conversation.id).toBe(beaconConversationId);
    const forbiddenBeaconMessages = await ownerPage.request.get(
      `/api/workspace/conversations/${encodeURIComponent(beaconConversationId)}/messages`
    );
    expect(forbiddenBeaconMessages.status()).toBe(403);

    await openWorkspaceCreateMenu(ownerPage, "发起私聊");
    const directPicker = ownerPage.getByRole("region", { name: "发起私聊" });
    await directPicker.getByRole("button", { name: new RegExp(memberDisplayName) }).click();

    const ownerConversation = ownerPage
      .getByLabel("共享空间导航")
      .locator("button.conversation")
      .filter({ hasText: memberDisplayName });
    await expect(ownerConversation).toBeVisible();
    await expect(ownerPage.getByRole("region", { name: memberDisplayName })).toBeVisible();

    const memberConversation = memberPage
      .getByLabel("共享空间导航")
      .getByRole("button", { name: /^timeStarry(?:\s|$)/ });
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
    const beaconMemberRow = memberPage.locator(".workspace-member-card").filter({ hasText: "信标" });
    await expect(beaconMemberRow.getByText("BOT", { exact: true })).toBeVisible();
    await expect(beaconMemberRow.getByText("文件传输助手", { exact: true })).toBeVisible();
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
    await expect(ownerPage.getByRole("region", { name: memberDisplayName }).getByText(memberMessage, { exact: true })).toBeVisible();

    const ownerMessage = "workspace-e2e-owner-message";
    await ownerPage.getByLabel("输入消息").fill(ownerMessage);
    await sendWorkspaceComposer(ownerPage);
    const memberDirectRegion = memberPage.getByRole("region", { name: "timeStarry" });
    await expect(memberDirectRegion.getByText(ownerMessage, { exact: true })).toBeVisible();

    const directConversationId = await workspaceConversationId(ownerPage, memberDisplayName);
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
    await expect(memberDirectRegion.getByLabel("输入消息")).toBeFocused();
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

    const groupTitle = `E2E 双用户群聊 ${memberSuffix}`;
    await openWorkspaceCreateMenu(ownerPage, "创建群聊");
    const groupDialog = ownerPage.getByRole("region", { name: "创建群聊" });
    await groupDialog.getByLabel("群聊名称").fill(groupTitle);
    const groupAvatarEmoji = "🧭";
    await groupDialog.getByRole("button", { name: `使用 ${groupAvatarEmoji} 作为群头像` }).click();
    await expect(groupDialog.getByRole("button", { name: /信标/ })).toHaveCount(0);
    await groupDialog.getByRole("button", { name: new RegExp(memberDisplayName) }).click();
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
    await expect(ownerPage).toHaveURL(new RegExp(`/workspace/chat/${groupId}$`));

    const ownerGroupRegion = ownerPage.getByRole("region", { name: groupTitle });
    await expect(ownerGroupRegion).toBeVisible();
    await expect(ownerGroupRegion.locator(".workspace-chat-header .workspace-group-avatar")).toHaveText(groupAvatarEmoji);
    await expect(ownerPage.getByLabel("共享空间导航")
      .locator("button.conversation")
      .filter({ hasText: groupTitle })
      .locator(".workspace-group-avatar")).toHaveText(groupAvatarEmoji);
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
    await expect(ownerPage.getByLabel("当前会话详情").getByText(memberDisplayName, { exact: true })).toBeVisible();

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

    const ownerGroupConversation = ownerPage
      .getByLabel("共享空间导航")
      .locator("button.conversation")
      .filter({ hasText: groupTitle });
    const ownerComposerInput = ownerGroupRegion.getByLabel("输入消息");
    await ownerComposerInput.fill("原子草稿 @");
    const mentionPicker = ownerPage.getByRole("dialog", { name: "提及成员" });
    await expect(mentionPicker).toBeVisible();
    await expect(mentionPicker.getByRole("button").first()).toHaveAttribute("aria-current", "true");
    await ownerComposerInput.press("ArrowDown");
    await ownerComposerInput.press("ArrowUp");
    await ownerComposerInput.press("Enter");
    await expect(mentionPicker).toHaveCount(0);
    await expect(ownerGroupRegion.locator(".workspace-editor-token.mention")).toHaveCount(1);
    await expect(ownerGroupRegion.locator(".workspace-message-list").getByText("原子草稿", { exact: true })).toHaveCount(0);

    await ownerGroupRegion.getByTitle("插入表情").click();
    const composerEmotePicker = ownerPage.getByRole("dialog", { name: "选择表情" });
    await composerEmotePicker.getByRole("tab", { name: "飞书", exact: true }).click();
    await composerEmotePicker.getByRole("button", { name: "OK", exact: true }).click();
    await expect(ownerGroupRegion.locator(".workspace-editor-token.emote")).toHaveCount(1);

    await ownerConversation.click();
    const ownerDirectRegion = ownerPage.getByRole("region", { name: memberDisplayName });
    await expect(ownerDirectRegion.getByTitle("提及成员")).toHaveCount(0);
    const ownerDirectComposer = ownerDirectRegion.getByLabel("输入消息");
    await ownerDirectComposer.fill("@");
    await expect(ownerPage.getByRole("dialog", { name: "提及成员" })).toHaveCount(0);
    await ownerDirectComposer.press("Control+A");
    await ownerDirectComposer.press("Backspace");

    await ownerGroupConversation.click();
    await expect(ownerGroupRegion.locator(".workspace-editor-token.mention")).toHaveCount(1);
    await expect(ownerGroupRegion.locator(".workspace-editor-token.emote")).toHaveCount(1);
    await ownerComposerInput.press("Control+A");
    await ownerComposerInput.press("Backspace");
    await expect(ownerGroupRegion.locator(".workspace-editor-token.mention")).toHaveCount(0);
    await expect(ownerGroupRegion.locator(".workspace-editor-token.emote")).toHaveCount(0);

    await ownerGroupRegion.getByTitle("插入表情").click();
    await expect(ownerPage.getByRole("dialog", { name: "选择表情" })).toBeVisible();
    await ownerGroupRegion.locator(".workspace-chat-header").click();
    await expect(ownerPage.getByRole("dialog", { name: "选择表情" })).toHaveCount(0);
    await ownerGroupRegion.getByTitle("提及成员").click();
    await expect(ownerPage.getByRole("dialog", { name: "提及成员" })).toBeVisible();
    await ownerGroupRegion.locator(".workspace-message-list").click({ position: { x: 8, y: 8 } });
    await expect(ownerPage.getByRole("dialog", { name: "提及成员" })).toHaveCount(0);

    await expect(ownerGroupRegion.getByRole("toolbar", { name: "消息格式" })).toHaveCount(0);
    await ownerComposerInput.fill("Toolbar test");
    await ownerComposerInput.press("Control+A");
    await ownerGroupRegion.getByRole("button", { name: "显示格式工具栏" }).click();
    const formatToolbar = ownerGroupRegion.getByRole("toolbar", { name: "消息格式" });
    await expect(formatToolbar).toBeVisible();
    await formatToolbar.getByRole("button", { name: "粗体" }).click();
    await expect(ownerComposerInput).toHaveText("**Toolbar test**");

    const compactComposerHeight = await ownerComposerInput.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).height)
    );
    await ownerGroupRegion.getByRole("button", { name: "扩大编辑区" }).click();
    await expect.poll(() => ownerComposerInput.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).height)
    )).toBeGreaterThan(compactComposerHeight + 40);
    await ownerGroupRegion.getByRole("button", { name: "缩小编辑区" }).click();
    await expect.poll(() => ownerComposerInput.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).height)
    )).toBeLessThanOrEqual(compactComposerHeight + 1);
    await ownerGroupRegion.getByRole("button", { name: "隐藏格式工具栏" }).click();
    await expect(formatToolbar).toHaveCount(0);
    await ownerComposerInput.press("Control+A");
    await ownerComposerInput.press("Backspace");
    const markdownSource = "**Workspace Markdown**\n\n- 第一项\n- 第二项";
    await ownerGroupRegion.getByLabel("输入消息").fill(markdownSource);
    await sendWorkspaceComposer(ownerGroupRegion);
    const markdownMessage = memberGroupRegion.locator("article.workspace-message").filter({ hasText: "Workspace Markdown" });
    await expect(markdownMessage.locator(".workspace-markdown strong").getByText("Workspace Markdown", { exact: true })).toBeVisible();
    await expect(markdownMessage.locator(".workspace-markdown li")).toHaveCount(2);
    const ownerMarkdownMessage = ownerGroupRegion.locator("article.workspace-message").filter({ hasText: "Workspace Markdown" });
    await ownerMarkdownMessage.getByTitle("复制消息").click();
    await expect.poll(async () => (await ownerPage.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"))
      .toBe(markdownSource);

    const dividerCount = await memberGroupRegion.locator(".workspace-markdown-divider").count();
    await ownerGroupRegion.getByLabel("输入消息").fill("---");
    await sendWorkspaceComposer(ownerGroupRegion);
    await expect(memberGroupRegion.locator(".workspace-markdown-divider")).toHaveCount(dividerCount + 1);

    const recalledMessageText = `workspace-e2e-recall-${memberSuffix}`;
    await ownerGroupRegion.getByLabel("输入消息").fill(recalledMessageText);
    await sendWorkspaceComposer(ownerGroupRegion);
    const recalledMessage = ownerGroupRegion.locator("article.workspace-message").filter({ hasText: recalledMessageText });
    await ownerPage.once("dialog", (dialog) => dialog.accept());
    await recalledMessage.getByTitle("撤回消息").click();
    await expect(ownerGroupRegion.locator(".workspace-message-list").getByText(recalledMessageText, { exact: true })).toHaveCount(0);
    await expect(ownerGroupRegion.locator(".workspace-message-list").getByText("timeStarry因内容有误撤回了一条消息", { exact: true })).toBeVisible();
    await expect(memberGroupRegion.locator(".workspace-message-list").getByText("timeStarry因内容有误撤回了一条消息", { exact: true })).toBeVisible();

    const reactionMessage = memberGroupRegion.locator("article.workspace-message").filter({ hasText: groupOwnerMessage });
    const reactionTrigger = reactionMessage.getByTitle("添加表情回复");
    await reactionTrigger.click();
    const reactionPicker = memberPage.getByRole("dialog", { name: "选择消息表情回复" });
    await expect(reactionPicker).toBeVisible();
    await memberGroupRegion.locator(".workspace-chat-header").click();
    await expect(reactionPicker).toHaveCount(0);
    await reactionTrigger.click();
    await reactionPicker.getByRole("tab", { name: "飞书", exact: true }).click();
    await reactionPicker.getByRole("button", { name: "OK", exact: true }).click();
    await expect(reactionTrigger).toBeFocused();
    const memberReaction = reactionMessage.getByRole("button", { name: /OK，你/ });
    await expect(memberReaction).toHaveAttribute("aria-pressed", "true");

    const ownerReactionMessage = ownerGroupRegion.locator("article.workspace-message").filter({ hasText: groupOwnerMessage });
    const ownerReaction = ownerReactionMessage.getByRole("button", { name: new RegExp(`OK，${memberDisplayName}`) });
    await expect(ownerReaction).toBeVisible();
    await ownerReaction.click();
    await expect(memberReaction).toHaveAccessibleName(/OK，你、timeStarry/);
    await memberReaction.click();
    await expect(ownerReactionMessage.getByRole("button", { name: /OK，你/ })).toBeVisible();

    const collapsibleText = `workspace-e2e-collapsible-${"长".repeat(720)}`;
    const collapsibleResponse = await ownerPage.request.post("/api/workspace/messages", {
      data: {
        conversationId: groupId,
        clientMessageId: `workspace-e2e-collapsible-${memberSuffix}`,
        content: {
          format: "duallane.message+json;v=1",
          plainText: collapsibleText,
          blocks: [{ type: "text", text: collapsibleText }]
        }
      }
    });
    expect(collapsibleResponse.status()).toBe(201);
    const collapsibleMessage = memberGroupRegion.locator("article.workspace-message").filter({ hasText: "workspace-e2e-collapsible" });
    const expandLongMessage = collapsibleMessage.getByRole("button", { name: "展开全文", exact: true });
    await expect(expandLongMessage).toHaveAttribute("aria-expanded", "false");
    await expandLongMessage.click();
    const collapseLongMessage = collapsibleMessage.getByRole("button", { name: "收起", exact: true });
    await expect(collapseLongMessage).toHaveAttribute("aria-expanded", "true");
    await collapseLongMessage.click();

    let rejectedGeneratedTxt = false;
    await ownerPage.route("**/api/workspace/files/uploads/reserve", async (route) => {
      const payload = route.request().postDataJSON() as { fileName?: string };
      if (!rejectedGeneratedTxt && payload.fileName?.endsWith(".txt")) {
        rejectedGeneratedTxt = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "internal.error", message: "E2E long message upload failure" } })
        });
        return;
      }
      await route.continue();
    });
    await ownerComposerInput.fill("超长" + "字".repeat(30_000));
    await sendWorkspaceComposer(ownerGroupRegion);
    const generatedTxtStage = ownerGroupRegion.locator(".workspace-staged-file.failed").filter({ hasText: "长消息-" });
    await expect(generatedTxtStage).toBeVisible();
    const editedAfterFailure = `workspace-e2e-long-message-edited-${memberSuffix}`;
    await ownerComposerInput.fill(editedAfterFailure);
    const editedMessageRequest = ownerPage.waitForRequest((request) =>
      request.url().endsWith("/api/workspace/messages") && request.method() === "POST"
    );
    await sendWorkspaceComposer(ownerGroupRegion);
    const editedMessagePayload = (await editedMessageRequest).postDataJSON() as {
      content: { blocks: Array<{ type: string; text?: string }> };
    };
    expect(editedMessagePayload.content.blocks).toEqual([{ type: "text", text: editedAfterFailure }]);
    await expect(ownerGroupRegion.locator(".workspace-staged-file").filter({ hasText: "长消息-" })).toHaveCount(0);
    await expect(memberGroupRegion.getByText(editedAfterFailure, { exact: true })).toBeVisible();
    await ownerPage.unroute("**/api/workspace/files/uploads/reserve");

    await memberConversation.click();
    await directMessageList.evaluate((list) => {
      list.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      list.scrollTop = Math.min(180, Math.max(0, list.scrollHeight - list.clientHeight - 120));
      list.dispatchEvent(new Event("scroll"));
    });
    await memberGroupConversation.click();
    await memberConversation.click();
    await expect.poll(() => directMessageList.evaluate((list) =>
      list.scrollHeight - list.scrollTop - list.clientHeight
    )).toBeLessThanOrEqual(2);

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

    const clipboardImageName = "image.png";
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
    }, { name: clipboardImageName, bytes: Array.from(pastedImageBytes) });

    const fileName = "workspace-e2e-long-file-name-for-detail-panel-overflow-regression.bin";
    const fileBytes = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255, 68, 117, 97, 108, 76, 97, 110, 101]);
    await ownerGroupRegion.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "application/octet-stream",
      buffer: fileBytes
    });
    const stagedFiles = ownerGroupRegion.getByLabel("待发送附件");
    const stagedImage = stagedFiles.locator(".workspace-staged-file").first();
    await expect(stagedImage.locator("img")).toBeVisible();
    await expect(stagedImage.locator("strong")).toHaveText(/^粘贴图片-\d{8}-\d{6}\.png$/);
    const pastedImageName = (await stagedImage.locator("strong").textContent())!;
    await expect(stagedFiles.getByText(fileName, { exact: true })).toBeVisible();
    expect(attachmentReserveCount).toBe(0);
    await expect(memberGroupRegion.getByRole("button", { name: `预览图片 ${pastedImageName}` })).toHaveCount(0);
    await expect(memberGroupRegion.getByRole("button").filter({ hasText: fileName })).toHaveCount(0);

    await sendWorkspaceComposer(ownerGroupRegion);
    await expect(stagedFiles.locator(".workspace-staged-file.failed")).toHaveCount(1);
    await expect(stagedFiles.locator(".workspace-staged-file.uploaded")).toHaveCount(1);
    expect(attachmentReserveCount).toBe(2);
    await expect(memberGroupRegion.getByRole("button", { name: `预览图片 ${pastedImageName}` })).toHaveCount(0);
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

    const pastedImageCard = memberGroupRegion.getByRole("button", { name: `预览图片 ${pastedImageName}` });
    await expect(pastedImageCard).toBeVisible();
    const pastedImagePreview = pastedImageCard.locator("img.message-image-preview");
    await expect(pastedImagePreview).toBeVisible();
    await expect.poll(() => pastedImagePreview.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await pastedImageCard.click();
    const imageViewer = memberPage.getByRole("dialog", { name: pastedImageName });
    await expect(imageViewer).toBeVisible();
    const imageCloseButton = imageViewer.getByTitle("关闭预览");
    await expect(imageCloseButton).toBeFocused();
    await memberPage.keyboard.press("Tab");
    await expect(imageViewer.getByTitle("下载图片")).toBeFocused();
    await memberPage.keyboard.press("Shift+Tab");
    await expect(imageCloseButton).toBeFocused();
    await memberPage.keyboard.press("Escape");
    await expect(imageViewer).toHaveCount(0);
    await expect(pastedImageCard).toBeFocused();

    const memberNavigation = memberPage.getByRole("navigation", { name: "共享空间视图" });
    await memberNavigation.getByRole("button", { name: "文件", exact: true }).click();
    const fileCategoryTabs = memberPage.getByLabel("文件类型筛选");
    await fileCategoryTabs.getByRole("button", { name: "图片", exact: true }).click();
    const imageLibraryRow = memberPage.locator(".workspace-file-row").filter({ hasText: pastedImageName });
    const imageLibraryThumbnail = imageLibraryRow.locator(".workspace-file-thumbnail img");
    await expect(imageLibraryThumbnail).toBeVisible();
    await expect.poll(() => imageLibraryThumbnail.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(memberPage.locator(".workspace-file-row").filter({ hasText: fileName })).toHaveCount(0);
    await memberPage.getByRole("button", { name: "方格视图", exact: true }).click();
    await expect(memberPage.getByRole("button", { name: "方格视图", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(imageLibraryRow).toHaveClass(/media-card/);
    await memberPage.getByRole("button", { name: "列表视图", exact: true }).click();
    await fileCategoryTabs.getByRole("button", { name: "其它", exact: true }).click();
    await expect(memberPage.locator(".workspace-file-row").filter({ hasText: fileName })).toBeVisible();
    await expect(memberPage.locator(".workspace-file-row").filter({ hasText: pastedImageName })).toHaveCount(0);
    await fileCategoryTabs.getByRole("button", { name: "全部", exact: true }).click();
    await memberNavigation.getByRole("button", { name: "聊天", exact: true }).click();
    await expect(memberGroupRegion).toBeVisible();

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

    await memberPage.getByRole("navigation", { name: "共享空间视图" }).getByRole("button", { name: "聊天", exact: true }).click();
    await expect(memberGroupRegion).toBeVisible();

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
    const reconnectNewMessages = memberGroupRegion.getByRole("button", { name: /\d+ 条新消息/ });
    await expect.poll(async () =>
      (await reconnectNewMessages.isVisible()) || (await workspaceConversationUnreadCount(memberPage, groupId)) === 0
    ).toBe(true);
    if (await reconnectNewMessages.isVisible()) {
      await reconnectNewMessages.click();
    }
    await expect.poll(() => workspaceConversationUnreadCount(memberPage, groupId)).toBe(0);
    await expect(memberGroupConversation.locator(".unread-badge")).toHaveCount(0);

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

    await memberPage.setViewportSize({ width: 1280, height: 720 });
    await memberGroupRegion.getByTitle("收起详情").click();
    await expect.poll(() => memberPage.evaluate(() => localStorage.getItem("duallane.workspace.context-open"))).toBe("false");

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
      await expect(memberGroupRegion.getByText(replayedMessage, { exact: true })).toBeVisible();
      await memberGroupRegion.getByRole("button", { name: "详情", exact: true }).click();
      await expect(memberPage.getByLabel("当前会话详情")).toBeVisible();
      await memberPage.getByTitle("返回聊天").click();
      await expect(memberGroupRegion).toBeVisible();
      const mobileComposerInput = memberGroupRegion.getByLabel("输入消息");
      await expect(mobileComposerInput).toBeInViewport();
      await memberGroupRegion.getByRole("button", { name: "显示格式工具栏" }).click();
      const mobileFormatToolbar = memberGroupRegion.getByRole("toolbar", { name: "消息格式" });
      await expect(mobileFormatToolbar).toBeVisible();
      const mobileBoldButtonBox = await mobileFormatToolbar.getByRole("button", { name: "粗体" }).boundingBox();
      expect(mobileBoldButtonBox?.width).toBeGreaterThanOrEqual(44);
      expect(mobileBoldButtonBox?.height).toBeGreaterThanOrEqual(44);
      await memberGroupRegion.getByRole("button", { name: "扩大编辑区" }).click();
      const expandedComposerLayout = await memberGroupRegion.locator(".workspace-composer").evaluate((composer) => {
        const bounds = composer.getBoundingClientRect();
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          viewportHeight: window.innerHeight
        };
      });
      expect(expandedComposerLayout.top).toBeGreaterThanOrEqual(0);
      expect(expandedComposerLayout.bottom).toBeLessThanOrEqual(expandedComposerLayout.viewportHeight + 1);
      expect(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await memberGroupRegion.getByRole("button", { name: "缩小编辑区" }).click();
      await memberGroupRegion.getByRole("button", { name: "隐藏格式工具栏" }).click();
    }

    await memberPage.setViewportSize({ width: 1280, height: 720 });
    await memberPage.locator(".workspace-user-trigger").click();
    await memberPage.getByRole("menuitem", { name: "个人设置" }).click();
    await expect(memberPage.getByRole("heading", { name: "个人设置" })).toBeVisible();
    await memberPage.getByRole("button", { name: /通知/ }).click();
    await memberPage.getByRole("button", { name: /邮件通知/ }).click();
    await expect(memberPage.getByRole("switch", { name: /接受邮件通知/ })).toHaveAttribute("aria-checked", "true");
    await expect(memberPage.getByRole("switch", { name: /每条消息都通知我/ })).toHaveAttribute("aria-checked", "false");
    await expect(memberPage.getByRole("switch", { name: /超过 2 小时仍未读时通知我/ })).toHaveAttribute("aria-checked", "true");
    await memberPage.getByRole("button", { name: "返回通知" }).click();
    await memberPage.getByRole("button", { name: /移动推送/ }).click();
    await expect(memberPage.getByRole("switch", { name: /接受移动推送/ })).toHaveAttribute("aria-checked", "true");
    const ntfyHelpTrigger = memberPage.getByRole("button", { name: /配置 ntfy 客户端/ });
    await ntfyHelpTrigger.click();
    const ntfyDialog = memberPage.getByRole("dialog", { name: "订阅 ntfy 通知" });
    await expect(ntfyDialog).toBeVisible();
    await expect(ntfyDialog.getByRole("button", { name: "关闭 ntfy 使用说明" })).toBeFocused();
    await expect(ntfyDialog.getByText("https://ntfy.tsio.top", { exact: true })).toBeVisible();
    await expect(ntfyDialog.getByRole("link", { name: /查看 ntfy 下载指引/ })).toHaveAttribute("href", "https://ntfy.sh/");
    await expect(ntfyDialog.getByRole("link", { name: /直接下载 ntfy 安装包/ })).toHaveAttribute(
      "href",
      "https://f-droid.org/repo/io.heckel.ntfy_63.apk"
    );
    const ntfyTopic = ntfyDialog.locator(".workspace-ntfy-copy-list > div").filter({ hasText: "我的 topic" }).locator("code");
    const originalNtfyTopic = await ntfyTopic.textContent();
    expect(originalNtfyTopic).toMatch(new RegExp(`^duallane-duallane-e2e-${memberSuffix}-[A-Za-z0-9]{6}$`));
    await ntfyDialog.getByRole("button", { name: "重新生成推送凭据" }).click();
    const rotateResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/me/ntfy/rotate") && response.request().method() === "POST"
    );
    await ntfyDialog.getByRole("button", { name: "确认重新生成" }).click();
    expect((await rotateResponse).status()).toBe(200);
    await expect(ntfyTopic).not.toHaveText(originalNtfyTopic!);
    await expect(memberPage.getByText(/所有设备需要重新配置/)).toBeVisible();
    await memberPage.keyboard.press("Escape");
    await expect(ntfyDialog).toHaveCount(0);
    await expect(ntfyHelpTrigger).toBeFocused();
    await memberPage.getByRole("button", { name: "返回通知" }).click();
    await memberPage.getByRole("button", { name: "返回个人设置" }).click();
    await memberPage.getByRole("button", { name: /账户与资料/ }).click();

    await memberPage.locator('input[type="file"][accept="image/jpeg,image/png,image/webp"]').setInputFiles({
      name: "workspace-avatar.png",
      mimeType: "image/png",
      buffer: pastedImageBytes
    });
    const avatarDialog = memberPage.getByRole("dialog", { name: "调整头像" });
    await expect(avatarDialog).toBeVisible();
    await expect(avatarDialog.getByTitle("关闭")).toBeFocused();
    const saveAvatarButton = avatarDialog.getByRole("button", { name: "保存头像", exact: true });
    await expect(saveAvatarButton).toBeEnabled();
    const avatarUploadResponse = memberPage.waitForResponse((response) =>
      response.url().includes("/api/workspace/me/avatar") && response.request().method() === "PUT"
    );
    await saveAvatarButton.click();
    expect((await avatarUploadResponse).status()).toBe(200);
    await expect(avatarDialog).toHaveCount(0);
    const customAvatar = memberPage.locator(".workspace-account-avatar img");
    await expect(customAvatar).toBeVisible();
    const customAvatarPath = await customAvatar.getAttribute("src");
    expect(customAvatarPath).toMatch(new RegExp(`/api/workspace/avatars/${acceptedMember.id}/`));
    const customAvatarResponse = await memberPage.request.get(customAvatarPath!);
    expect(customAvatarResponse.status()).toBe(200);
    expect(customAvatarResponse.headers()["content-type"]).toContain("image/webp");
    const restoreGitHubAvatar = memberPage.getByRole("button", { name: "恢复 GitHub 头像", exact: true });
    const avatarDeleteResponse = memberPage.waitForResponse((response) =>
      response.url().includes("/api/workspace/me/avatar") && response.request().method() === "DELETE"
    );
    await restoreGitHubAvatar.click();
    expect((await avatarDeleteResponse).status()).toBe(200);
    await expect(restoreGitHubAvatar).toHaveCount(0);

    const publicNickname = `公开昵称 ${memberSuffix}`;
    const nicknameResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/me/profile") && response.request().method() === "PATCH"
    );
    await memberPage.getByRole("textbox", { name: "公开昵称", exact: true }).fill(publicNickname);
    expect((await nicknameResponse).status()).toBe(200);
    await memberPage.getByRole("button", { name: "返回个人设置" }).click();
    await memberPage.getByRole("button", { name: /隐私与发现/ }).click();
    const discoverabilityToggle = memberPage.getByRole("switch", { name: /允许其他成员搜索到我/ });
    await expect(discoverabilityToggle).toHaveAttribute("aria-checked", "false");
    const discoverabilityResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/me/profile") && response.request().method() === "PATCH"
    );
    await discoverabilityToggle.click();
    expect((await discoverabilityResponse).status()).toBe(200);
    await expect(memberPage.locator(".workspace-user-trigger").getByText(publicNickname, { exact: true })).toBeVisible();
    await expect(discoverabilityToggle).toHaveAttribute("aria-checked", "true");

    const outsiderInviteResponse = await ownerPage.request.post("/api/workspace/invites", {
      data: { defaultRole: "member", maxUses: 1 }
    });
    expect(outsiderInviteResponse.status()).toBe(201);
    const outsiderInvite = (await outsiderInviteResponse.json() as { invite: { code: string } }).invite;
    const outsiderSuffix = randomUUID().slice(0, 8);
    const outsiderAcceptResponse = await outsiderPage.request.post(
      `/api/workspace/invites/${encodeURIComponent(outsiderInvite.code)}/accept`,
      {
        data: {
          githubId: `duallane-e2e-outsider-id-${outsiderSuffix}`,
          githubLogin: `duallane-e2e-outsider-${outsiderSuffix}`,
          displayName: `E2E 陌生成员 ${outsiderSuffix}`
        }
      }
    );
    expect(outsiderAcceptResponse.status()).toBe(201);
    await outsiderPage.goto("/workspace/members");
    await expect(outsiderPage.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const outsiderMemberSearch = outsiderPage.getByLabel("查找成员");
    await outsiderMemberSearch.fill(Array.from(publicNickname)[0]);
    await expect(outsiderPage.locator(".workspace-member-card").filter({ hasText: publicNickname })).toHaveCount(0);
    const discoverableSearchResponse = outsiderPage.waitForResponse((response) =>
      response.url().includes("/api/workspace/members?") && response.url().includes("q=")
    );
    await outsiderMemberSearch.fill(Array.from(publicNickname).slice(0, 2).join(""));
    expect((await discoverableSearchResponse).status()).toBe(200);
    const discoverableMemberRow = outsiderPage.locator(".workspace-member-card").filter({ hasText: publicNickname });
    await expect(discoverableMemberRow).toBeVisible();
    await discoverableMemberRow.getByRole("button", { name: `与 ${publicNickname} 私聊`, exact: true }).click();
    await expect(outsiderPage.getByRole("region", { name: publicNickname })).toBeVisible();

    await memberPage.setViewportSize({ width: 390, height: 844 });
    await expect(memberPage.getByRole("heading", { name: "隐私与发现" })).toBeVisible();
    expect(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await ownerPage.setViewportSize({ width: 1280, height: 720 });
    await ownerPage.getByRole("button", { name: "成员", exact: true }).click();
    const memberFilterTrigger = ownerPage.getByRole("button", { name: "筛选", exact: true });
    await memberFilterTrigger.click();
    const memberFilterMenu = ownerPage.getByRole("menu", { name: "筛选" });
    const memberRoleFilter = memberFilterMenu.getByRole("menuitemradio", { name: "管理员", exact: true });
    await expect(memberRoleFilter).toBeVisible();
    expect(await memberRoleFilter.locator("span:last-child").evaluate((label) => getComputedStyle(label).whiteSpace)).toBe("nowrap");
    expect(await memberRoleFilter.evaluate((item) => getComputedStyle(item).gridTemplateColumns)).toMatch(/^16px /);
    await memberFilterTrigger.click();
    await expect(memberFilterMenu).toHaveCount(0);
    const ownerMemberList = ownerPage.getByRole("region", { name: "共享空间主视图" }).getByRole("list");
    const publicMemberRow = ownerMemberList.getByRole("button", { name: new RegExp(publicNickname) }).first();
    await expect(publicMemberRow).toBeVisible();
    await publicMemberRow.click();
    const memberDetail = ownerPage.getByRole("complementary", { name: "成员详情" });
    await expect(memberDetail.getByText(`@duallane-e2e-${memberSuffix}`, { exact: true })).toBeVisible();
    const privateRemark = `私人备注 ${memberSuffix}`;
    await memberDetail.getByLabel("私人备注").fill(privateRemark);
    await memberDetail.getByRole("button", { name: "保存备注" }).click();
    await expect(memberDetail.getByRole("definition").filter({ hasText: privateRemark })).toHaveText(privateRemark);
    await expect(ownerMemberList.getByRole("button", { name: new RegExp(privateRemark) }).first()).toBeVisible();

    const mentionProjectionMarker = `mention-projection-${memberSuffix}`;
    const mentionProjectionResponse = await ownerPage.request.post("/api/workspace/messages", {
      data: {
        conversationId: groupId,
        clientMessageId: mentionProjectionMarker,
        content: {
          format: "duallane.message+json;v=1",
          plainText: mentionProjectionMarker,
          blocks: [
            { type: "mention", userId: acceptedMember.id, label: publicNickname },
            { type: "text", text: ` ${mentionProjectionMarker}` }
          ]
        }
      }
    });
    expect(mentionProjectionResponse.status()).toBe(201);

    await ownerPage.getByRole("button", { name: "聊天", exact: true }).click();
    await ownerPage.getByLabel("共享空间导航").locator("button.conversation").filter({ hasText: groupTitle }).first().click();
    const ownerProjectedMention = ownerPage.getByRole("region", { name: groupTitle })
      .locator("article.workspace-message")
      .filter({ hasText: mentionProjectionMarker });
    await expect(ownerProjectedMention.locator(".message-mention")).toHaveText(`@${privateRemark}`);

    await memberPage.setViewportSize({ width: 1280, height: 720 });
    await memberPage.getByRole("button", { name: "聊天", exact: true }).click();
    await memberPage.getByLabel("共享空间导航").locator("button.conversation").filter({ hasText: groupTitle }).first().click();
    const memberProjectedMention = memberPage.getByRole("region", { name: groupTitle })
      .locator("article.workspace-message")
      .filter({ hasText: mentionProjectionMarker });
    await expect(memberProjectedMention.locator(".message-mention")).toHaveText(`@${publicNickname}`);

    await memberPage.goto("/workspace/account");
    await expect(memberPage.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    await memberPage.getByRole("button", { name: /聊天与表情/ }).click();
    const emoteSettingsSection = memberPage.locator("section.workspace-settings-detail").filter({
      has: memberPage.getByRole("heading", { name: "表情面板", exact: true })
    });
    const emojiPackToggle = emoteSettingsSection.getByRole("button", { name: "Emoji", exact: true });
    await expect(emojiPackToggle).toHaveAttribute("aria-pressed", "true");
    for (const packLabel of ["B站", "微信", "飞书"]) {
      const toggle = emoteSettingsSection.getByRole("button", { name: packLabel, exact: true });
      if (await toggle.getAttribute("aria-pressed") === "true") {
        const updateResponse = memberPage.waitForResponse((response) =>
          response.url().endsWith("/api/workspace/me/emote-settings") && response.request().method() === "PUT"
        );
        await toggle.click();
        expect((await updateResponse).status()).toBe(200);
      }
    }
    await expect(emojiPackToggle).toBeDisabled();

    await memberPage.getByRole("button", { name: "聊天", exact: true }).click();
    await memberPage.getByLabel("共享空间导航").locator("button.conversation").filter({ hasText: groupTitle }).first().click();
    await memberGroupRegion.getByTitle("插入表情").click();
    const memberComposerEmotePicker = memberPage.getByRole("dialog", { name: "选择表情" });
    await expect(memberComposerEmotePicker.getByRole("tab", { name: "Emoji", exact: true })).toBeVisible();
    await expect(memberComposerEmotePicker.getByRole("tab", { name: "收藏", exact: true })).toBeVisible();
    await expect(memberComposerEmotePicker.getByRole("tab", { name: "飞书", exact: true })).toHaveCount(0);
    await memberComposerEmotePicker.getByRole("tab", { name: "收藏", exact: true }).click();

    const customEmoteFileName = `e2e-custom-emote-${memberSuffix}.png`;
    const customEmoteLabel = customEmoteFileName.replace(/\.png$/, "");
    const customEmoteUploadResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/me/emotes") && response.request().method() === "POST"
    );
    await memberComposerEmotePicker.getByLabel("上传收藏表情").setInputFiles({
      name: customEmoteFileName,
      mimeType: "image/png",
      buffer: pastedImageBytes
    });
    const uploadedCustomEmote = await customEmoteUploadResponse;
    expect(uploadedCustomEmote.status()).toBe(201);
    const uploadedCustomEmotePayload = await uploadedCustomEmote.json() as { emote: { id: string } };
    await memberComposerEmotePicker.getByRole("button", { name: customEmoteLabel, exact: true }).click();
    await expect(memberGroupRegion.locator(".workspace-editor-token.emote img")).toBeVisible();

    const memberCustomMessageResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await sendWorkspaceComposer(memberGroupRegion);
    const memberCustomMessagePayload = await (await memberCustomMessageResponse).json() as { message: { id: string } };
    const ownerCustomMessage = ownerGroupRegion.locator(
      `article.workspace-message[data-message-id="${memberCustomMessagePayload.message.id}"]`
    );
    const ownerCustomImage = ownerCustomMessage.locator("img.workspace-custom-emote-image");
    await expect(ownerCustomImage).toBeVisible();
    await expect.poll(() => ownerCustomImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const favoriteCustomEmoteResponse = ownerPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/me/emotes/favorite") && response.request().method() === "POST"
    );
    await ownerCustomMessage.getByTitle("收藏表情").click();
    expect((await favoriteCustomEmoteResponse).status()).toBe(201);

    await memberGroupRegion.getByTitle("插入表情").click();
    const memberFavoritesAfterSend = memberPage.getByRole("dialog", { name: "选择表情" });
    await memberFavoritesAfterSend.getByRole("tab", { name: "收藏", exact: true }).click();
    const deleteOriginalCustomEmote = memberPage.waitForResponse((response) =>
      response.url().endsWith(`/api/workspace/me/emotes/${uploadedCustomEmotePayload.emote.id}`)
        && response.request().method() === "DELETE"
    );
    await memberFavoritesAfterSend.getByRole("button", {
      name: `删除收藏表情 ${customEmoteLabel}`,
      exact: true
    }).click();
    expect((await deleteOriginalCustomEmote).status()).toBe(200);
    await memberGroupRegion.locator(".workspace-chat-header").click();

    await ownerGroupRegion.getByTitle("插入表情").click();
    const ownerComposerFavorites = ownerPage.getByRole("dialog", { name: "选择表情" });
    await ownerComposerFavorites.getByRole("tab", { name: "收藏", exact: true }).click();
    await ownerComposerFavorites.getByRole("button", { name: customEmoteLabel, exact: true }).click();
    const ownerCopiedCustomMessageResponse = ownerPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await sendWorkspaceComposer(ownerGroupRegion);
    const ownerCopiedCustomMessagePayload = await (await ownerCopiedCustomMessageResponse).json() as { message: { id: string } };
    const memberCopiedCustomMessage = memberGroupRegion.locator(
      `article.workspace-message[data-message-id="${ownerCopiedCustomMessagePayload.message.id}"]`
    );
    const memberCopiedCustomImage = memberCopiedCustomMessage.locator("img.workspace-custom-emote-image");
    await expect(memberCopiedCustomImage).toBeVisible();
    await expect.poll(() => memberCopiedCustomImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const largeFileName = `workspace-e2e-chunked-${memberSuffix}.bin`;
    const largeFileBytes = Buffer.alloc(4 * 1024 * 1024 + 257, 0x5a);
    const largeFileUploadRequests: string[] = [];
    const trackLargeFileUpload = (request: { url(): string; method(): string }) => {
      if (request.method() === "PUT" && /\/api\/workspace\/files\/uploads\/[^/]+\/(?:parts\/\d+|content)$/.test(request.url())) {
        largeFileUploadRequests.push(request.url());
      }
    };
    ownerPage.on("request", trackLargeFileUpload);
    await ownerGroupRegion.getByLabel("添加附件").setInputFiles({
      name: largeFileName,
      mimeType: "application/octet-stream",
      buffer: largeFileBytes
    });
    await sendWorkspaceComposer(ownerGroupRegion);
    await expect(memberGroupRegion.getByRole("button").filter({ hasText: largeFileName })).toBeVisible();
    ownerPage.off("request", trackLargeFileUpload);
    expect(largeFileUploadRequests.filter((url) => /\/parts\/1$/.test(url))).toHaveLength(1);
    expect(largeFileUploadRequests.filter((url) => /\/parts\/2$/.test(url))).toHaveLength(1);
    expect(largeFileUploadRequests.filter((url) => /\/content$/.test(url))).toHaveLength(0);

    const groupHistoryPinMessage = "workspace-e2e-group-history-26";
    for (let index = 0; index < 45; index += 1) {
      const text = `workspace-e2e-group-history-${String(index).padStart(2, "0")}`;
      const response = await ownerPage.request.post("/api/workspace/messages", {
        data: {
          conversationId: groupId,
          clientMessageId: `workspace-e2e-group-history-${index}`,
          content: {
            format: "duallane.message+json;v=1",
            plainText: text,
            blocks: [{ type: "text", text }]
          }
        }
      });
      expect(response.status()).toBe(201);
    }
    await expect(ownerGroupRegion.getByText("workspace-e2e-group-history-44", { exact: true })).toBeVisible();

    const ownerGroupMessageList = ownerGroupRegion.locator(".workspace-message-list");
    const ownerPinnedMessage = ownerGroupRegion.locator("article.workspace-message").filter({ hasText: groupHistoryPinMessage });
    await expect(ownerPinnedMessage).toBeAttached();
    await ownerPinnedMessage.getByTitle("设为常驻消息").click();
    await expect(ownerPinnedMessage.locator(".workspace-message-pin-indicator")).toHaveText("常驻");
    const memberPinnedMessage = memberGroupRegion.locator("article.workspace-message").filter({ hasText: groupHistoryPinMessage });
    await expect(memberPinnedMessage.locator(".workspace-message-pin-indicator")).toHaveText("常驻");
    await expect(memberPinnedMessage.getByTitle("取消常驻")).toHaveCount(0);

    const currentConversationDetails = ownerPage.getByLabel("当前会话详情");
    if (!(await currentConversationDetails.isVisible())) {
      await ownerGroupRegion.getByTitle("查看详情").click();
    }
    await ownerPage.getByRole("tablist", { name: "会话详情" }).getByRole("tab", { name: "概览" }).click();
    const pinnedOverview = ownerPage.getByRole("region", { name: "常驻消息" });
    await expect(pinnedOverview.getByText(groupHistoryPinMessage, { exact: true })).toBeVisible();
    await pinnedOverview.getByRole("button").filter({ hasText: groupHistoryPinMessage }).click();
    await expect(ownerGroupRegion.getByText("正在查看常驻消息上下文", { exact: true })).toBeVisible();
    await expect(ownerPinnedMessage).toHaveClass(/history-target/);
    await ownerGroupRegion.getByRole("button", { name: "返回最新消息", exact: true }).click();
    await expect(ownerGroupRegion.getByText("正在查看常驻消息上下文", { exact: true })).toHaveCount(0);
    await expect.poll(() => ownerGroupMessageList.evaluate((list) =>
      list.scrollHeight - list.scrollTop - list.clientHeight
    )).toBeLessThanOrEqual(80);
    await ownerPinnedMessage.getByTitle("取消常驻").click();
    await expect(ownerPinnedMessage.locator(".workspace-message-pin-indicator")).toHaveCount(0);

    await expect(ownerGroupRegion.getByText("workspace-e2e-group-history-00", { exact: true })).toHaveCount(0);
    const loadEarlierButton = ownerGroupRegion.getByRole("button", { name: "加载更早消息", exact: true });
    await expect(loadEarlierButton).toBeAttached();
    const loadEarlierButtonHandle = await loadEarlierButton.elementHandle();
    expect(loadEarlierButtonHandle).not.toBeNull();
    const olderMessagesResponse = ownerPage.waitForResponse((response) =>
      response.url().includes(`/api/workspace/conversations/${groupId}/messages?`)
        && response.url().includes("before=")
        && response.request().method() === "GET"
    );
    await loadEarlierButtonHandle!.evaluate((button) => (button as HTMLButtonElement).click());
    const olderMessagesPayload = await (await olderMessagesResponse).json() as {
      messages: Array<{ id: string; plainText: string }>;
    };
    const loadedHistoryMessage = olderMessagesPayload.messages.find((message) =>
      message.plainText === "workspace-e2e-group-history-00"
    );
    expect(loadedHistoryMessage).toBeTruthy();
    await expect(ownerGroupRegion.locator(
      `article.workspace-message[data-message-id="${loadedHistoryMessage!.id}"]`
    )).toBeAttached();
    await ownerGroupMessageList.evaluate((list) => {
      list.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const groupReturnToLatest = ownerGroupRegion.getByRole("button", { name: "回到最新消息", exact: true });
    await expect(groupReturnToLatest).toBeVisible();
    await groupReturnToLatest.click();
    await expect.poll(() => ownerGroupMessageList.evaluate((list) =>
      list.scrollHeight - list.scrollTop - list.clientHeight
    )).toBeLessThanOrEqual(80);

    const isolatedDirectoryResponse = await memberPage.request.get("/api/workspace/members");
    expect(isolatedDirectoryResponse.status()).toBe(200);
    const isolatedMember = ((await isolatedDirectoryResponse.json()) as {
      members: Array<{ id: string; displayName: string; nickname?: string | null; remark?: string }>;
    }).members.find((candidate) => candidate.id === acceptedMember.id);
    expect(isolatedMember).toMatchObject({ displayName: publicNickname, nickname: publicNickname });
    expect(isolatedMember?.remark).toBeUndefined();
  } finally {
    await Promise.allSettled([ownerContext.close(), memberContext.close(), outsiderContext.close()]);
  }
});
