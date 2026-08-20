import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import { createWorkspaceAgentBotService } from "./workspace-agent-bots.mjs";
import { createWorkspaceBotGatewayService } from "./workspace-bot-gateway.mjs";
import { createWorkspaceCardInteractionService } from "./workspace-card-interactions.mjs";
import { createWorkspaceCardRegistry } from "./workspace-card-registry.mjs";

const SPACE_ID = "spc_default";

describe("Bot Gateway controlled Feishu cards", () => {
  const fixtures = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async ({ db, directory }) => {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it("converts sends and updates before entering the shared card authority", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-feishu-gateway-"));
    const db = openTestDatabase(directory);
    const botService = createWorkspaceAgentBotService({ db });
    const cardService = createWorkspaceCardInteractionService({ db, registry: createWorkspaceCardRegistry() });
    const gateway = createWorkspaceBotGatewayService({ db, botService, cardService });
    fixtures.push({ db, directory });

    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Feishu bridge" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID, scopes: ["cards:write", "cards:act", "messages:send"] });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const conversationId = "conv_feishu_gateway";
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'direct', ?, ?, 10000, ?, ?)`).run(conversationId, SPACE_ID, "Feishu", "direct-feishu", "usr_owner", now);
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, NULL)").run(conversationId, "usr_owner", now);
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, NULL)").run(conversationId, bot.botUserId, now);
    db.prepare(`INSERT INTO workspace_agent_bot_context_grants
      (grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?, ?)`).run("grant_feishu_gateway", bot.id, SPACE_ID, conversationId, "usr_owner", now, now);

    const sent = await gateway.sendCard(auth, {
      conversationId,
      clientMessageId: "feishu-message-1",
      idempotencyKey: "feishu-send-1",
      format: "feishu-card",
      feishuCard: {
        header: { title: { tag: "plain_text", content: "审批" } },
        elements: [{ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "确认" }, value: { action_id: "confirm", data: { source: "review" } } }] }]
      }
    });
    expect(sent.card).toMatchObject({ cardType: "feishu.adaptive.v1", schemaVersion: 1, fallbackText: "审批", revision: 1 });
    const stored = db.prepare("SELECT payload_json AS payloadJson FROM workspace_cards WHERE id = ?").get(sent.card.id);
    expect(JSON.parse(stored.payloadJson)).toMatchObject({ format: "duallane.feishu-card.v1", header: { title: "审批" } });

    await expect(cardService.executeAction("usr_owner", {
      cardId: sent.card.id,
      actionId: "confirm",
      clientActionId: "feishu-action-1",
      expectedRevision: 1,
      input: {}
    })).resolves.toMatchObject({ result: { accepted: true, actionId: "confirm" } });
    const actionEvent = db.prepare("SELECT seq AS sequence FROM workspace_events WHERE type = 'card.action' ORDER BY seq DESC LIMIT 1").get();
    const actionReplay = await gateway.replay(auth, Number(actionEvent.sequence) - 1);
    expect(actionReplay).toMatchObject({ syncRequired: false });
    expect(actionReplay.events).toHaveLength(1);
    expect(actionReplay.events[0]).toMatchObject({
      type: "card.action",
      conversationId,
      payload: {
        botId: bot.id,
        botUserId: bot.botUserId,
        cardId: sent.card.id,
        actionId: "confirm",
        clientActionId: "feishu-action-1",
        actorUserId: "usr_owner",
        data: { source: "review" }
      }
    });

    await expect(gateway.updateCard(auth, sent.card.id, {
      expectedRevision: 1,
      format: "feishu-card",
      feishuCard: { elements: [{ tag: "div", text: { tag: "plain_text", content: "已更新" } }] }
    })).resolves.toMatchObject({ card: { id: sent.card.id, revision: 2, fallbackText: "已更新" } });

    await expect(gateway.updateCard(auth, sent.card.id, {
      expectedRevision: 2,
      format: "feishu-card",
      feishuCard: { elements: [{ tag: "markdown", content: "[private](https://192.168.1.1/)" }] }
    })).rejects.toMatchObject({ code: "card.private_url", statusCode: 422 });
    expect(db.prepare(`SELECT action, result, reason FROM audit_logs
      WHERE actor_user_id = ? AND action = 'bot.gateway.card.update' ORDER BY created_at DESC LIMIT 1`).get(bot.botUserId))
      .toEqual({ action: "bot.gateway.card.update", result: "rejected", reason: "card.private_url" });

    await expect(gateway.sendCard(auth, {
      conversationId,
      clientMessageId: "feishu-message-rejected",
      idempotencyKey: "feishu-send-rejected",
      format: "feishu-card",
      feishuCard: { elements: [{ tag: "markdown", content: "[internal](http://example.com/)" }] }
    })).rejects.toMatchObject({ code: "card.url_forbidden", statusCode: 422 });
    expect(db.prepare(`SELECT action, result, reason FROM audit_logs
      WHERE actor_user_id = ? AND action = 'bot.gateway.card.send' ORDER BY created_at DESC LIMIT 1`).get(bot.botUserId))
      .toEqual({ action: "bot.gateway.card.send", result: "rejected", reason: "card.url_forbidden" });
  });
});
