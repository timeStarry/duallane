import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";

type WorkspaceConversation = {
  id: string;
};

type WorkspaceMessage = {
  id: string;
  plainText: string;
  pin?: WorkspacePin;
};

type WorkspacePin = {
  pinnedByUserId: string;
  pinnedAt: string;
  canUnpin: boolean;
};

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("aria-busy", "false");
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
        githubId: `workspace-pin-sync-${suffix}`,
        githubLogin: `workspace-pin-sync-${suffix}`,
        email: `workspace-pin-sync-${suffix}@example.test`,
        displayName: `置顶同步成员 ${suffix}`
      }
    }
  );
  expect(acceptResponse.status()).toBe(201);
  return (await acceptResponse.json() as { user: { id: string } }).user.id;
}

async function createGroup(ownerPage: Page, memberId: string, suffix: string): Promise<WorkspaceConversation> {
  const response = await ownerPage.request.post("/api/workspace/conversations", {
    data: {
      type: "group",
      title: `置顶同步 ${suffix}`,
      memberIds: [memberId]
    }
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { conversation: WorkspaceConversation }).conversation;
}

async function currentUserId(page: Page) {
  const response = await page.request.get("/api/workspace/bootstrap");
  expect(response.status()).toBe(200);
  const payload = await response.json() as { auth: { currentUser: { id: string } } };
  return payload.auth.currentUser.id;
}

async function seedHistory(page: Page, conversationId: string, suffix: string) {
  let targetMessageId = "";
  for (let index = 0; index < 45; index += 1) {
    const text = `workspace-pin-sync-${suffix}-${String(index).padStart(2, "0")}`;
    const response = await page.request.post("/api/workspace/messages", {
      data: {
        conversationId,
        clientMessageId: `workspace-pin-sync-${suffix}-${randomUUID()}`,
        content: {
          format: "duallane.message+json;v=1",
          plainText: text,
          blocks: [{ type: "text", text }]
        }
      }
    });
    expect(response.status()).toBe(201);
    const payload = await response.json() as { message: { id: string } };
    if (index === 26) {
      targetMessageId = payload.message.id;
    }
  }
  expect(targetMessageId).not.toBe("");
  return {
    latestText: `workspace-pin-sync-${suffix}-44`,
    targetText: `workspace-pin-sync-${suffix}-26`,
    targetMessageId
  };
}

async function openConversation(page: Page, conversationId: string) {
  await page.goto(`/workspace/chat/${encodeURIComponent(conversationId)}`);
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  const chat = page.locator("section.workspace-chat-panel");
  await expect(chat).toBeVisible();
  return chat;
}

async function chooseMessageAction(page: Page, message: Locator, actionName: string) {
  await message.getByTitle("更多消息操作").click();
  const menu = page.getByRole("menu", { name: "消息操作" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: actionName, exact: true }).click();
}

async function getMessageAround(page: Page, conversationId: string, messageId: string) {
  const response = await page.request.get(
    `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?around=${encodeURIComponent(messageId)}&limit=3`
  );
  expect(response.status()).toBe(200);
  const payload = await response.json() as { messages: WorkspaceMessage[] };
  const message = payload.messages.find((candidate) => candidate.id === messageId);
  expect(message).toBeTruthy();
  return message!;
}

test("pins seeded group history for owner and member with matching message state", async ({ browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  let memberId = "";

  try {
    await enterWorkspaceAsSeededOwner(ownerPage);
    const ownerId = await currentUserId(ownerPage);
    memberId = await createSyntheticMember(ownerPage, memberPage, suffix);
    const conversation = await createGroup(ownerPage, memberId, suffix);
    const history = await seedHistory(ownerPage, conversation.id, suffix);

    const [ownerChat, memberChat] = await Promise.all([
      openConversation(ownerPage, conversation.id),
      openConversation(memberPage, conversation.id)
    ]);
    await expect(ownerChat.getByText(history.latestText, { exact: true })).toBeVisible();
    await expect(memberChat.getByText(history.latestText, { exact: true })).toBeVisible();

    const ownerTarget = ownerChat.locator(`article.workspace-message[data-message-id="${history.targetMessageId}"]`);
    await expect(ownerTarget).toBeVisible();
    await expect(ownerTarget.getByText(history.targetText, { exact: true })).toBeVisible();
    const pinResponsePromise = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/workspace/groups/${conversation.id}/pins`) &&
      response.request().method() === "POST"
    );
    await chooseMessageAction(ownerPage, ownerTarget, "设为常驻消息");
    const pinResponse = await pinResponsePromise;
    expect(pinResponse.status()).toBe(201);
    expect((await pinResponse.json() as { pin: { messageId: string } }).pin.messageId).toBe(history.targetMessageId);

    await expect(ownerTarget.locator(".workspace-message-pin-indicator")).toHaveText("常驻");
    const memberTarget = memberChat.locator(`article.workspace-message[data-message-id="${history.targetMessageId}"]`);
    await expect(memberTarget.locator(".workspace-message-pin-indicator")).toHaveText("常驻");

    const [ownerMessage, memberMessage] = await Promise.all([
      getMessageAround(ownerPage, conversation.id, history.targetMessageId),
      getMessageAround(memberPage, conversation.id, history.targetMessageId)
    ]);
    expect(ownerMessage.pin).toMatchObject({
      pinnedByUserId: ownerId,
      canUnpin: true
    });
    expect(memberMessage.pin).toMatchObject({
      pinnedByUserId: ownerId,
      canUnpin: false
    });
    expect(ownerMessage.pin?.pinnedAt).toEqual(expect.any(String));
    expect(memberMessage.pin?.pinnedAt).toEqual(expect.any(String));
  } finally {
    if (memberId) {
      await ownerPage.request.delete(`/api/workspace/members/${encodeURIComponent(memberId)}`).catch(() => undefined);
    }
    await Promise.all([ownerContext.close(), memberContext.close()]);
  }
});
