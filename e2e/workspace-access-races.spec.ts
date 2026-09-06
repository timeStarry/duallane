import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

type Gate = {
  promise: Promise<void>;
  release: () => void;
};

type WorkspaceConversation = {
  id: string;
};

type WorkspaceMessage = {
  id: string;
};

type WorkspaceEvent = {
  id: string;
  spaceId: string;
  seq: number;
  type: string;
  conversationId?: string;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
};

function createGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function frameText(frame: string | Buffer) {
  return typeof frame === "string" ? frame : frame.toString("utf8");
}

function parseFrame(frame: string | Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(frameText(frame)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator(".workspace-connection-state")).toHaveCount(0);
}

async function createSyntheticMember(ownerPage: Page, memberPage: Page, suffix: string) {
  const inviteResponse = await ownerPage.request.post("/api/workspace/invites", {
    data: { defaultRole: "member", maxUses: 1 }
  });
  expect(inviteResponse.status()).toBe(201);
  const invitePayload = await inviteResponse.json() as {
    invite: { code: string; inviteUrl: string };
  };

  await memberPage.goto(invitePayload.invite.inviteUrl);
  await expect(memberPage.getByRole("button", { name: "使用 GitHub 登录" })).toBeVisible();
  const acceptResponse = await memberPage.request.post(
    `/api/workspace/invites/${encodeURIComponent(invitePayload.invite.code)}/accept`,
    {
      data: {
        githubId: `workspace-access-race-${suffix}`,
        githubLogin: `workspace-access-race-${suffix}`,
        email: `workspace-access-race-${suffix}@example.test`,
        displayName: `访问竞态成员 ${suffix}`
      }
    }
  );
  expect(acceptResponse.status()).toBe(201);
  const accepted = await acceptResponse.json() as { user: { id: string } };
  return accepted.user.id;
}

async function createGroup(ownerPage: Page, memberId: string, suffix: string): Promise<WorkspaceConversation> {
  const response = await ownerPage.request.post("/api/workspace/conversations", {
    data: {
      type: "group",
      title: `访问竞态群 ${suffix}`,
      memberIds: [memberId]
    }
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { conversation: WorkspaceConversation }).conversation;
}

async function createMessage(page: Page, conversationId: string, suffix: string): Promise<WorkspaceMessage> {
  const response = await page.request.post("/api/workspace/messages", {
    data: {
      conversationId,
      clientMessageId: `workspace-access-race-${randomUUID()}`,
      content: {
        format: "duallane.message+json;v=1",
        plainText: `访问竞态消息 ${suffix}`,
        blocks: [{ type: "text", text: `访问竞态消息 ${suffix}` }]
      }
    }
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { message: WorkspaceMessage }).message;
}

async function closeOwnedMember(ownerPage: Page, memberId: string | null) {
  if (!memberId) return;
  await ownerPage.request.delete(`/api/workspace/members/${encodeURIComponent(memberId)}`).catch(() => undefined);
}

async function hideConversationFromInitialBootstrap(page: Page, conversationId: string) {
  await page.route((url) => url.pathname === "/api/workspace/bootstrap", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as {
      conversations?: Array<{ id: string }>;
    };
    await route.fulfill({
      response,
      json: {
        ...payload,
        conversations: (payload.conversations ?? []).filter((conversation) => conversation.id !== conversationId)
      }
    });
  });
}

async function installWorkspaceEventProxy(context: BrowserContext) {
  const socketReady = createGate();
  const memberRemoved = createGate();
  let latestHelloSeq = 0;
  let sendEvent: ((event: WorkspaceEvent) => void) | null = null;
  let lastMemberRemoved: { conversationId?: string; userId?: string } | null = null;

  await context.routeWebSocket(/\/ws\/workspace$/, (webSocket) => {
    const server = webSocket.connectToServer();
    sendEvent = (event) => {
      webSocket.send(JSON.stringify({ version: 1, type: "event", event }));
    };

    webSocket.onMessage((message) => {
      const envelope = parseFrame(message);
      if (envelope?.type === "hello") {
        latestHelloSeq = Number(envelope.lastSeq) || 0;
      }
      server.send(message);
    });

    server.onMessage((message) => {
      const envelope = parseFrame(message);
      if (envelope?.type === "ready") {
        socketReady.release();
      }
      if (envelope?.type === "event" && envelope.event && typeof envelope.event === "object") {
        const event = envelope.event as Record<string, unknown>;
        if (event.type === "conversation.member_removed") {
          const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? event.payload as Record<string, unknown>
            : {};
          lastMemberRemoved = {
            conversationId: typeof event.conversationId === "string" ? event.conversationId : undefined,
            userId: typeof payload.userId === "string" ? payload.userId : undefined
          };
          memberRemoved.release();
        }
      }
      webSocket.send(message);
    });
  });

  return {
    socketReady: socketReady.promise,
    memberRemoved: memberRemoved.promise,
    lastMemberRemoved: () => lastMemberRemoved,
    sendRefreshEvent(conversationId: string) {
      if (!sendEvent) {
        throw new Error("Workspace WebSocket proxy is not connected");
      }
      sendEvent({
        id: `workspace-access-race-refresh-${randomUUID()}`,
        spaceId: "spc_default",
        seq: latestHelloSeq + 1,
        type: "conversation.updated",
        conversationId,
        targetType: "conversation",
        targetId: conversationId,
        createdAt: new Date().toISOString()
      });
    }
  };
}

async function holdNextConversationList(page: Page, conversationId: string) {
  const responseFetched = createGate();
  const releaseResponse = createGate();
  const responseFulfilled = createGate();
  let held = true;
  let responseContainsConversation = false;

  await page.route(
    (url) => url.pathname === "/api/workspace/conversations" && url.search === "",
    async (route) => {
      if (!held) {
        await route.continue();
        return;
      }
      held = false;
      const response = await route.fetch();
      const payload = await response.json() as {
        conversations: Array<{ id: string }>;
      };
      responseContainsConversation = payload.conversations.some((conversation) => conversation.id === conversationId);
      responseFetched.release();
      await releaseResponse.promise;
      await route.fulfill({ response, json: payload });
      responseFulfilled.release();
    }
  );

  return {
    responseFetched: responseFetched.promise,
    releaseResponse: releaseResponse.release,
    responseFulfilled: responseFulfilled.promise,
    hasConversation: () => responseContainsConversation
  };
}

async function waitForTwoAnimationFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test("does not re-add a conversation after member removal beats a delayed list response", async ({ browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  let memberId: string | null = null;
  let releaseList = () => {};

  try {
    await enterWorkspaceAsSeededOwner(ownerPage);
    memberId = await createSyntheticMember(ownerPage, memberPage, suffix);
    const conversation = await createGroup(ownerPage, memberId, suffix);
    await hideConversationFromInitialBootstrap(memberPage, conversation.id);
    const workspaceSocket = await installWorkspaceEventProxy(memberContext);

    await memberPage.goto("/workspace");
    await expect(memberPage.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    await expect(memberPage.locator(".workspace-conversation-list button").filter({ hasText: `访问竞态群 ${suffix}` })).toHaveCount(0);
    await workspaceSocket.socketReady;

    const delayedList = await holdNextConversationList(memberPage, conversation.id);
    releaseList = delayedList.releaseResponse;
    workspaceSocket.sendRefreshEvent(conversation.id);
    await delayedList.responseFetched;
    expect(delayedList.hasConversation()).toBe(true);

    const removalResponse = await ownerPage.request.delete(
      `/api/workspace/groups/${encodeURIComponent(conversation.id)}/members/${encodeURIComponent(memberId)}`
    );
    expect(removalResponse.status()).toBe(200);
    await workspaceSocket.memberRemoved;
    expect(workspaceSocket.lastMemberRemoved()).toEqual({
      conversationId: conversation.id,
      userId: memberId
    });
    await waitForTwoAnimationFrames(memberPage);

    const deliveredListResponse = memberPage.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/workspace/conversations" && response.request().method() === "GET"
    );
    delayedList.releaseResponse();
    await delayedList.responseFulfilled;
    const listResult = await deliveredListResponse;
    expect(listResult.status()).toBe(200);
    await listResult.finished();
    await waitForTwoAnimationFrames(memberPage);

    await expect(memberPage.locator(".workspace-conversation-list button").filter({ hasText: `访问竞态群 ${suffix}` })).toHaveCount(0);
    await expect(memberPage.getByRole("region", { name: `访问竞态群 ${suffix}` })).toHaveCount(0);
  } finally {
    releaseList();
    await closeOwnedMember(ownerPage, memberId);
    await Promise.allSettled([ownerContext.close(), memberContext.close()]);
  }
});

test("does not re-add a conversation after explicit leave beats a delayed read response", async ({ browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  let memberId: string | null = null;
  const readStarted = createGate();
  const readFetched = createGate();
  const releaseRead = createGate();
  const readFulfilled = createGate();
  let readStatus = 0;

  try {
    await enterWorkspaceAsSeededOwner(ownerPage);
    memberId = await createSyntheticMember(ownerPage, memberPage, suffix);
    const conversation = await createGroup(ownerPage, memberId, suffix);
    await createMessage(ownerPage, conversation.id, suffix);

    const readPath = `/api/workspace/conversations/${encodeURIComponent(conversation.id)}/read`;
    await memberPage.route(
      (url) => url.pathname === readPath,
      async (route) => {
        readStarted.release();
        const response = await route.fetch();
        readStatus = response.status();
        readFetched.release();
        await releaseRead.promise;
        await route.fulfill({ response });
        readFulfilled.release();
      }
    );

    await memberPage.setViewportSize({ width: 390, height: 844 });
    await memberPage.goto(`/workspace/chat/${conversation.id}`);
    const chat = memberPage.getByRole("region", { name: `访问竞态群 ${suffix}` });
    await expect(chat).toBeVisible();
    await expect(memberPage.locator(".workspace-connection-state")).toHaveCount(0);
    await chat.locator(".workspace-message-list").evaluate((element) => {
      const list = element as HTMLElement;
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await readStarted.promise;
    await readFetched.promise;

    await memberPage.setViewportSize({ width: 1280, height: 900 });
    await memberPage.getByTitle("查看详情").click();
    await memberPage.getByRole("tab", { name: "设置", exact: true }).click();
    memberPage.once("dialog", (dialog) => dialog.accept());
    const leaveResponse = memberPage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/workspace/groups/${encodeURIComponent(conversation.id)}/leave` &&
      response.request().method() === "POST"
    );
    await memberPage.getByRole("button", { name: "离开群聊", exact: true }).click();
    const leaveResult = await leaveResponse;
    expect(leaveResult.status()).toBe(200);
    await leaveResult.finished();
    await expect(memberPage.locator(".workspace-conversation-list button").filter({ hasText: `访问竞态群 ${suffix}` })).toHaveCount(0);
    await expect(memberPage.getByRole("region", { name: `访问竞态群 ${suffix}` })).toHaveCount(0);

    const deliveredReadResponse = memberPage.waitForResponse((response) =>
      new URL(response.url()).pathname === readPath && response.request().method() === "POST"
    );
    releaseRead.release();
    await readFulfilled.promise;
    const readResult = await deliveredReadResponse;
    expect(readResult.status()).toBe(200);
    await readResult.finished();
    await waitForTwoAnimationFrames(memberPage);
    expect(readStatus).toBe(200);
    await expect(memberPage.locator(".workspace-conversation-list button").filter({ hasText: `访问竞态群 ${suffix}` })).toHaveCount(0);
    await expect(memberPage.getByRole("region", { name: `访问竞态群 ${suffix}` })).toHaveCount(0);
  } finally {
    releaseRead.release();
    await closeOwnedMember(ownerPage, memberId);
    await Promise.allSettled([ownerContext.close(), memberContext.close()]);
  }
});
