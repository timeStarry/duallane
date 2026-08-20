import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type BrowserContext, type Page } from "@playwright/test";

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000 });

type CreatedBot = {
  id: string;
  botUserId: string;
  name: string;
};

type IssuedToken = {
  token: string;
  tokenRecord: {
    id: string;
    scopes: string[];
  };
};

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
}

function botGatewayHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function expectApiError(response: APIResponse, status: number, code: string) {
  expect(response.status()).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

test("owner configures an Agent Bot and its Gateway REST authorization boundaries", async ({ browser, page }) => {
  const suffix = randomUUID().slice(0, 8);
  const botName = `浏览器 Bot ${suffix}`;
  const messageText = `Agent Gateway 私聊消息 ${suffix}`;
  const cardFallback = `Agent 卡片 ${suffix}`;
  const updatedCardFallback = `Agent 卡片已更新 ${suffix}`;
  let bot: CreatedBot | null = null;
  let memberContext: BrowserContext | null = null;
  let memberId: string | null = null;

  try {
    await enterWorkspaceAsSeededOwner(page);
    await page.goto("/workspace/account/bot");
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    await expect(page.getByRole("heading", { name: "我的 Bot", level: 2 })).toBeVisible();

    await page.getByLabel("Bot 名称", { exact: true }).fill(botName);
    const createResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/bots") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    bot = (await createResponse.json() as { bot: CreatedBot }).bot;
    expect(bot).toMatchObject({ name: botName });
    await expect(page.getByRole("heading", { name: botName, level: 2 })).toBeVisible();

    await page.getByRole("combobox", { name: /^成员发现/u }).selectOption("space_members");
    await page.getByLabel("简介", { exact: true }).fill("用于验证受控私聊、群聊和卡片 Gateway。 ");
    const identityResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/workspace/bots/${bot!.id}/settings`) &&
      response.request().method() === "PATCH"
    );
    await page.getByRole("button", { name: "保存身份设置", exact: true }).click();
    const identityResponse = await identityResponsePromise;
    expect(identityResponse.status()).toBe(200);
    expect(await identityResponse.json()).toMatchObject({
      settings: { visibilityPolicy: "space_members", allowDirect: true }
    });

    await page.getByRole("radio", { name: /允许群聊/u }).check();
    const groupSettingsResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/workspace/bots/${bot!.id}/settings`) &&
      response.request().method() === "PATCH"
    );
    await page.getByRole("button", { name: "保存群聊策略", exact: true }).click();
    const groupSettingsResponse = await groupSettingsResponsePromise;
    expect(groupSettingsResponse.status()).toBe(200);
    expect(await groupSettingsResponse.json()).toMatchObject({
      settings: { allowDirect: true, allowGroup: true, requireOwnerApproval: false }
    });

    const limitedTokenResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/workspace/bots/${bot!.id}/tokens`) &&
      response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "生成 Token", exact: true }).click();
    const limitedTokenResponse = await limitedTokenResponsePromise;
    expect(limitedTokenResponse.status()).toBe(201);
    const limitedToken = await limitedTokenResponse.json() as IssuedToken;
    expect(limitedToken.tokenRecord.scopes).toEqual([
      "messages:read_trigger",
      "messages:send",
      "commands:receive"
    ]);
    await expect(page.locator(".workspace-bot-token-reveal code")).toHaveText(limitedToken.token);

    // The current UI intentionally issues the conservative default scopes. Use
    // the same authenticated browser session to request the explicit card scope
    // needed for the Gateway card portion of this acceptance path.
    const authorizedTokenResponse = await page.request.post(
      `/api/workspace/bots/${encodeURIComponent(bot.id)}/tokens`,
      { data: { scopes: ["messages:send", "cards:write"] } }
    );
    expect(authorizedTokenResponse.status()).toBe(201);
    const authorizedToken = await authorizedTokenResponse.json() as IssuedToken;
    expect(authorizedToken.tokenRecord.scopes).toEqual(["messages:send", "cards:write"]);

    const identityResponseFromGateway = await page.request.get("/api/bot-gateway/v1/me", {
      headers: botGatewayHeaders(authorizedToken.token)
    });
    expect(identityResponseFromGateway.status()).toBe(200);
    expect(await identityResponseFromGateway.json()).toMatchObject({
      bot: { id: bot.id, botUserId: bot.botUserId, name: botName, kind: "bot" },
      scopes: ["messages:send", "cards:write"],
      settings: { allowDirect: true, allowGroup: true }
    });

    const directConversationResponse = await page.request.post("/api/workspace/conversations", {
      data: { type: "direct", targetUserId: bot.botUserId }
    });
    expect(directConversationResponse.status()).toBe(201);
    const directConversation = await directConversationResponse.json() as {
      conversation: { id: string };
    };

    const messageIdempotencyKey = `agent-e2e-message-${suffix}`;
    const messageResponse = await page.request.post("/api/bot-gateway/v1/messages", {
      headers: botGatewayHeaders(authorizedToken.token),
      data: {
        conversationId: directConversation.conversation.id,
        clientMessageId: messageIdempotencyKey,
        idempotencyKey: messageIdempotencyKey,
        text: messageText
      }
    });
    expect(messageResponse.status()).toBe(201);
    expect(await messageResponse.json()).toMatchObject({
      message: {
        conversationId: directConversation.conversation.id,
        plainText: messageText
      }
    });

    const deniedCardResponse = await page.request.post("/api/bot-gateway/v1/cards", {
      headers: botGatewayHeaders(limitedToken.token),
      data: {
        conversationId: directConversation.conversation.id,
        clientMessageId: `agent-e2e-denied-card-${suffix}`,
        idempotencyKey: `agent-e2e-denied-card-${suffix}`,
        cardType: "future.poll",
        schemaVersion: 1,
        fallbackText: "Scope 不足的卡片",
        payload: { question: "不应创建", options: ["A", "B"] }
      }
    });
    await expectApiError(deniedCardResponse, 403, "bot.scope_denied");

    const cardIdempotencyKey = `agent-e2e-card-${suffix}`;
    const cardResponse = await page.request.post("/api/bot-gateway/v1/cards", {
      headers: botGatewayHeaders(authorizedToken.token),
      data: {
        conversationId: directConversation.conversation.id,
        clientMessageId: cardIdempotencyKey,
        idempotencyKey: cardIdempotencyKey,
        cardType: "future.poll",
        schemaVersion: 1,
        fallbackText: cardFallback,
        payload: { question: "当前状态？", options: ["正常", "需处理"] }
      }
    });
    expect(cardResponse.status()).toBe(201);
    const sentCard = await cardResponse.json() as {
      card: { id: string; revision: number; fallbackText: string };
      message: { conversationId: string };
    };
    expect(sentCard).toMatchObject({
      card: { revision: 1, fallbackText: cardFallback },
      message: { conversationId: directConversation.conversation.id }
    });

    const updateCardResponse = await page.request.patch(
      `/api/bot-gateway/v1/cards/${encodeURIComponent(sentCard.card.id)}`,
      {
        headers: botGatewayHeaders(authorizedToken.token),
        data: {
          expectedRevision: 1,
          fallbackText: updatedCardFallback,
          payload: { question: "更新后的状态？", options: ["正常", "需处理"] }
        }
      }
    );
    expect(updateCardResponse.status()).toBe(200);
    expect(await updateCardResponse.json()).toMatchObject({
      card: { id: sentCard.card.id, revision: 2, fallbackText: updatedCardFallback }
    });

    memberContext = await browser.newContext();
    const inviteResponse = await page.request.post("/api/workspace/invites", {
      data: { defaultRole: "member", maxUses: 1 }
    });
    expect(inviteResponse.status()).toBe(201);
    const invite = await inviteResponse.json() as { invite: { code: string } };
    const acceptResponse = await memberContext.request.post(
      `/api/workspace/invites/${encodeURIComponent(invite.invite.code)}/accept`,
      {
        data: {
          githubId: `agent-bot-e2e-${suffix}`,
          githubLogin: `agent-bot-e2e-${suffix}`,
          email: `agent-bot-e2e-${suffix}@example.test`,
          displayName: `Agent Bot 成员 ${suffix}`
        }
      }
    );
    expect(acceptResponse.status()).toBe(201);
    const member = await acceptResponse.json() as { user: { id: string } };
    memberId = member.user.id;
    const groupResponse = await page.request.post("/api/workspace/conversations", {
      data: {
        type: "group",
        title: `Agent Bot 未授权群 ${suffix}`,
        memberIds: [member.user.id]
      }
    });
    expect(groupResponse.status()).toBe(201);
    const group = await groupResponse.json() as { conversation: { id: string } };

    const authorizeGroupResponse = await page.request.patch(
      `/api/workspace/bots/${encodeURIComponent(bot.id)}/group-policies/${encodeURIComponent(group.conversation.id)}`,
      { data: { status: "active", allowTrigger: true, allowContext: false } }
    );
    expect(authorizeGroupResponse.status()).toBe(200);
    const suspendGroupResponse = await page.request.patch(
      `/api/workspace/bots/${encodeURIComponent(bot.id)}/group-policies/${encodeURIComponent(group.conversation.id)}`,
      { data: { status: "pending", allowTrigger: false, allowContext: false } }
    );
    expect(suspendGroupResponse.status()).toBe(200);
    const deniedGroupResponse = await page.request.post("/api/bot-gateway/v1/messages", {
      headers: botGatewayHeaders(authorizedToken.token),
      data: {
        conversationId: group.conversation.id,
        clientMessageId: `agent-e2e-denied-group-${suffix}`,
        idempotencyKey: `agent-e2e-denied-group-${suffix}`,
        text: "不应进入未授权群聊"
      }
    });
    await expectApiError(deniedGroupResponse, 403, "bot.conversation_forbidden");

    await page.goto(`/workspace/chat/${encodeURIComponent(directConversation.conversation.id)}`);
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const chat = page.getByRole("region", { name: botName });
    await expect(chat.getByText(messageText, { exact: true })).toBeVisible();
    await expect(chat.getByText(cardFallback, { exact: true })).toBeVisible();
    await expect(chat.getByText("此卡片暂不支持交互", { exact: true })).toBeVisible();
    await expect(chat.getByText("BOT", { exact: true }).first()).toBeVisible();

    await page.goto("/workspace/account/bot");
    await expect(page.getByRole("heading", { name: botName, level: 2 })).toBeVisible();
    const authorizedTokenRow = page.locator(".workspace-bot-token-row").filter({ hasText: "cards:write" });
    await expect(authorizedTokenRow).toHaveCount(1);
    const revokeResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(
        `/api/workspace/bots/${bot!.id}/tokens/${authorizedToken.tokenRecord.id}/revoke`
      ) && response.request().method() === "POST"
    );
    await authorizedTokenRow.getByRole("button", { name: "撤销 Token", exact: true }).click();
    expect((await revokeResponsePromise).status()).toBe(200);
    await expect(authorizedTokenRow).toContainText("已撤销");

    const revokedTokenResponse = await page.request.get("/api/bot-gateway/v1/me", {
      headers: botGatewayHeaders(authorizedToken.token)
    });
    await expectApiError(revokedTokenResponse, 401, "bot.invalid_token");
  } finally {
    await memberContext?.close();
    if (bot) {
      const beginDeleteResponse = await page.request.delete(
        `/api/workspace/bots/${encodeURIComponent(bot.id)}`
      ).catch(() => null);
      if (beginDeleteResponse?.ok()) {
        await page.request.post(
          `/api/workspace/bots/${encodeURIComponent(bot.id)}/delete/confirm`
        ).catch(() => null);
      }
    }
    if (memberId) {
      await page.request.delete(`/api/workspace/members/${encodeURIComponent(memberId)}`).catch(() => null);
    }
  }
});
