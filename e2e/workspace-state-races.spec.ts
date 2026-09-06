import { expect, test, type Page } from "@playwright/test";
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

function createGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
        githubId: `workspace-state-race-${suffix}`,
        githubLogin: `workspace-state-race-${suffix}`,
        email: `workspace-state-race-${suffix}@example.test`,
        displayName: `状态竞态成员 ${suffix}`
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
      title: `状态竞态群 ${suffix}`,
      memberIds: [memberId]
    }
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { conversation: WorkspaceConversation }).conversation;
}

async function createMessage(
  page: Page,
  conversationId: string,
  text: string,
  replyToMessageId?: string
): Promise<WorkspaceMessage> {
  const response = await page.request.post("/api/workspace/messages", {
    data: {
      conversationId,
      clientMessageId: `workspace-state-race-${randomUUID()}`,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      content: {
        format: "duallane.message+json;v=1",
        plainText: text,
        blocks: [{ type: "text", text }]
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

test("around target survives a concurrent mark-read response", async ({ browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  let memberId: string | null = null;
  const aroundStarted = createGate();
  const aroundFetched = createGate();
  const releaseAround = createGate();
  const readStarted = createGate();
  const readFetched = createGate();
  const releaseRead = createGate();
  const readFulfilled = createGate();
  const aroundFulfilled = createGate();
  let aroundStatus = 0;
  let readStatus = 0;
  let readRouteArmed = false;

  try {
    await enterWorkspaceAsSeededOwner(ownerPage);
    memberId = await createSyntheticMember(ownerPage, memberPage, suffix);
    const conversation = await createGroup(ownerPage, memberId, suffix);

    const targetText = `around-target-${suffix}`;
    const target = await createMessage(ownerPage, conversation.id, targetText);
    for (let batchStart = 0; batchStart < 81; batchStart += 8) {
      const batchEnd = Math.min(batchStart + 8, 81);
      await Promise.all(Array.from({ length: batchEnd - batchStart }, (_, offset) =>
        createMessage(ownerPage, conversation.id, `around-filler-${suffix}-${batchStart + offset}`)
      ));
    }
    const replyText = `around-reply-${suffix}`;
    await createMessage(ownerPage, conversation.id, replyText, target.id);

    await memberPage.goto(`/workspace/chat/${conversation.id}`);
    const memberChat = memberPage.getByRole("region", { name: `状态竞态群 ${suffix}` });
    await expect(memberChat).toBeVisible();
    await expect(memberPage.locator(".workspace-connection-state")).toHaveCount(0);

    await ownerPage.route(/\/api\/workspace\/conversations\/[^/]+\/messages\?/, async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("around")) {
        await route.continue();
        return;
      }
      aroundStarted.release();
      const response = await route.fetch();
      aroundStatus = response.status();
      aroundFetched.release();
      await releaseAround.promise;
      await route.fulfill({ response });
      aroundFulfilled.release();
    });
    await ownerPage.route(/\/api\/workspace\/conversations\/[^/]+\/read$/, async (route) => {
      if (!readRouteArmed) {
        await route.continue();
        return;
      }
      readStarted.release();
      const response = await route.fetch();
      readStatus = response.status();
      readFetched.release();
      await releaseRead.promise;
      await route.fulfill({ response });
      readFulfilled.release();
    });

    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await ownerPage.goto(`/workspace/chat/${conversation.id}`);
    const chat = ownerPage.getByRole("region", { name: `状态竞态群 ${suffix}` });
    await expect(chat).toBeVisible();
    await expect(chat.locator(".workspace-message-list").locator(`[data-message-id="${target.id}"]`)).toHaveCount(0);
    const reply = chat.locator("article.workspace-message").filter({ hasText: replyText });
    await expect(reply).toBeVisible();

    const messageList = chat.locator(".workspace-message-list");
    await messageList.evaluate((element) => {
      const list = element as HTMLElement;
      list.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await reply.getByRole("button", { name: /跳转到/ }).click();
    await aroundStarted.promise;
    await aroundFetched.promise;

    const concurrentMessageText = `around-concurrent-${suffix}`;
    readRouteArmed = true;
    await memberChat.getByLabel("输入消息").fill(concurrentMessageText);
    const concurrentMessageResponse = memberPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await memberChat.locator("form.workspace-composer button.workspace-send-button").click();
    const concurrentMessageResult = await concurrentMessageResponse;
    expect(concurrentMessageResult.status()).toBe(201);
    await messageList.evaluate((element) => {
      const list = element as HTMLElement;
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await readStarted.promise;
    await readFetched.promise;

    releaseRead.release();
    await readFulfilled.promise;
    releaseAround.release();
    await aroundFulfilled.promise;

    expect(aroundStatus).toBe(200);
    expect(readStatus).toBe(200);
    const targetLocator = chat.locator(`article.workspace-message[data-message-id="${target.id}"]`);
    await expect(targetLocator).toHaveCount(1);
    await expect(targetLocator).toHaveClass(/message-locate/);
    expect((await concurrentMessageResult.json() as { message: WorkspaceMessage }).message.id).toBeTruthy();
  } finally {
    releaseRead.release();
    releaseAround.release();
    await closeOwnedMember(ownerPage, memberId);
    await Promise.allSettled([ownerContext.close(), memberContext.close()]);
  }
});

test("a delayed read response cannot reinsert a removed conversation", async ({ browser }) => {
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
    await createMessage(ownerPage, conversation.id, `member-read-race-${suffix}`);
    const memberConversationsResponse = await memberPage.request.get("/api/workspace/conversations");
    expect(memberConversationsResponse.status()).toBe(200);
    const memberConversations = await memberConversationsResponse.json() as {
      conversations: Array<{ id: string; unreadCount?: number }>;
    };
    expect(memberConversations.conversations.find((item) => item.id === conversation.id)?.unreadCount).toBeGreaterThan(0);

    const readPath = `/api/workspace/conversations/${encodeURIComponent(conversation.id)}/read`;
    await memberPage.route((url) => url.pathname === readPath, async (route) => {
      readStarted.release();
      const response = await route.fetch();
      readStatus = response.status();
      readFetched.release();
      await releaseRead.promise;
      await route.fulfill({ response });
      readFulfilled.release();
    });

    await memberPage.setViewportSize({ width: 390, height: 844 });
    await memberPage.goto(`/workspace/chat/${conversation.id}`);
    const chat = memberPage.getByRole("region", { name: `状态竞态群 ${suffix}` });
    await expect(chat).toBeVisible();
    await expect(memberPage.locator(".workspace-connection-state")).toHaveCount(0);
    await chat.locator(".workspace-message-list").evaluate((element) => {
      const list = element as HTMLElement;
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await readStarted.promise;
    await readFetched.promise;

    const removalResponse = await ownerPage.request.delete(
      `/api/workspace/groups/${encodeURIComponent(conversation.id)}/members/${encodeURIComponent(memberId)}`
    );
    expect(removalResponse.status()).toBe(200);
    await expect(memberPage.getByText("你已不在此群聊中。", { exact: true })).toBeVisible();
    await expect(memberPage.getByRole("region", { name: `状态竞态群 ${suffix}` })).toHaveCount(0);

    const deliveredReadResponse = memberPage.waitForResponse((response) =>
      new URL(response.url()).pathname === readPath && response.request().method() === "POST"
    );
    releaseRead.release();
    await readFulfilled.promise;
    const clientReadResponse = await deliveredReadResponse;
    expect(clientReadResponse.status()).toBe(200);
    await clientReadResponse.finished();
    await memberPage.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    expect(readStatus).toBe(200);
    await expect(memberPage.locator(".workspace-conversation-list button").filter({ hasText: `状态竞态群 ${suffix}` })).toHaveCount(0);
    await expect(memberPage.getByRole("region", { name: `状态竞态群 ${suffix}` })).toHaveCount(0);
  } finally {
    releaseRead.release();
    await closeOwnedMember(ownerPage, memberId);
    await Promise.allSettled([ownerContext.close(), memberContext.close()]);
  }
});
