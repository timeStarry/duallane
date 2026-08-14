import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import { createWorkspaceAgentBotService } from "./workspace-agent-bots.mjs";
import { createWorkspaceBotGatewayService } from "./workspace-bot-gateway.mjs";
import { createWorkspaceCardInteractionService } from "./workspace-card-interactions.mjs";
import { createWorkspaceCardRegistry } from "./workspace-card-registry.mjs";

const SPACE_ID = "spc_default";

describe("Workspace Bot Gateway", () => {
  const fixtures = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async ({ db, directory }) => {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it("authenticates only a bound Bot token and projects no internal login or owner", async () => {
    const { db, botService, gateway } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Gateway test" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const me = await gateway.getMe(auth);
    expect(me.bot).toMatchObject({ id: bot.id, kind: "bot", authenticationAllowed: false });
    expect(me.bot).not.toHaveProperty("githubLogin");
    expect(me.bot).not.toHaveProperty("ownerUserId");
    expect(me.scopes).toEqual(["messages:read_trigger", "messages:send", "commands:receive"]);
    expect(db.prepare("SELECT token_hash AS tokenHash FROM workspace_agent_bot_tokens WHERE id = ?").get(issued.id).tokenHash).not.toContain(issued.token);
  });

  it("requires an explicit conversation grant for context and keeps gateway message idempotency", async () => {
    const { db, botService, gateway } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Context test" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID, scopes: ["messages:read_context", "messages:send"] });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const conversationId = "conv_gateway_direct";
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'direct', ?, ?, 10000, ?, ?)`).run(conversationId, SPACE_ID, "Gateway direct", "gateway-direct", "usr_owner", now);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, NULL)`).run(conversationId, "usr_owner", now);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, NULL)`).run(conversationId, bot.botUserId, now);
    await expect(gateway.getContext(auth, conversationId)).rejects.toMatchObject({ code: "bot.context_forbidden" });
    const grantId = "grant_gateway_context";
    db.prepare(`INSERT INTO workspace_agent_bot_context_grants (grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1, 20, ?, ?, ?)`).run(grantId, bot.id, SPACE_ID, conversationId, "usr_owner", now, now);
    const sent = await gateway.sendMessage(auth, { conversationId, clientMessageId: "msg_gateway_1", text: "hello from bot", idempotencyKey: "idem_gateway_1" });
    const replay = await gateway.sendMessage(auth, { conversationId, clientMessageId: "msg_gateway_1", text: "hello from bot", idempotencyKey: "idem_gateway_1" });
    expect(sent.message.id).toBe(replay.message.id);
    const context = await gateway.getContext(auth, conversationId);
    expect(context.messages.at(-1).plainText).toBe("hello from bot");
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(conversationId).count).toBe(1);
  });

  it("replays metadata-only deliveries, reports stale cursors, and acknowledges events", async () => {
    const { db, botService, gateway } = await fixture({ replayLimit: 1 });
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Replay test" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const conversationId = "conv_gateway_replay";
    createDirectTriggerContext(db, bot, conversationId, now);
    insertMessageEvent(db, { messageId: "msg_replay_2", eventId: "evt_replay_2", sequence: 2, conversationId, actorId: "usr_owner", text: "first" });
    insertMessageEvent(db, { messageId: "msg_replay_3", eventId: "evt_replay_3", sequence: 3, conversationId, actorId: "usr_owner", text: "second" });
    db.prepare(`INSERT INTO workspace_agent_bot_deliveries
      (id, bot_id, space_id, sequence, event_id, event_type, conversation_id, payload_json, status, attempts, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'message.created', ?, '{}', 'queued', 0, ?, ?)`).run("bdl_replay_2", bot.id, SPACE_ID, 2, "evt_replay_2", conversationId, now, expiresAt);
    db.prepare(`INSERT INTO workspace_agent_bot_deliveries
      (id, bot_id, space_id, sequence, event_id, event_type, conversation_id, payload_json, status, attempts, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'message.created', ?, '{}', 'queued', 0, ?, ?)`).run("bdl_replay_3", bot.id, SPACE_ID, 3, "evt_replay_3", conversationId, now, expiresAt);

    const stale = await gateway.replay(auth, 0);
    expect(stale).toMatchObject({ syncRequired: true, reason: "replay_window_exceeded", currentSequence: 1 });

    const replay = await gateway.replay(auth, 1);
    expect(replay).toMatchObject({ syncRequired: false, hasMore: true, currentSequence: 1 });
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({ sequence: 2, eventId: "evt_replay_2", payload: {} });
    expect(JSON.stringify(replay.events[0])).not.toContain("plainText");

    await expect(gateway.acknowledge(auth, { sequence: 2 })).resolves.toMatchObject({ acknowledged: true, sequence: 2 });
    expect(db.prepare("SELECT status FROM workspace_agent_bot_deliveries WHERE id = 'bdl_replay_2'").get().status).toBe("acked");
  });

  it("expires replay rows before querying and never returns them", async () => {
    const clock = new Date("2026-08-14T10:00:00.000Z");
    const { db, botService, gateway } = await fixture({ now: () => clock });
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Replay expiry" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    db.prepare(`INSERT INTO workspace_agent_bot_deliveries
      (id, bot_id, space_id, sequence, event_id, event_type, conversation_id, payload_json, status, attempts, created_at, expires_at)
      VALUES ('bdl_expired', ?, ?, 2, 'evt_expired', 'message.created', NULL, '{}', 'queued', 0, ?, ?)`)
      .run(bot.id, SPACE_ID, "2026-08-14T08:00:00.000Z", "2026-08-14T09:00:00.000Z");
    await expect(gateway.replay(auth, 1)).resolves.toMatchObject({ syncRequired: true, reason: "replay_window_exceeded", events: [] });
    expect(db.prepare("SELECT status FROM workspace_agent_bot_deliveries WHERE id = 'bdl_expired'").get().status).toBe("expired");
  });

  it("binds message idempotency to conversation and reply routing", async () => {
    const { db, botService, gateway } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Routing idempotency" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const now = new Date().toISOString();
    createDirectTriggerContext(db, bot, "conv_route_a", now);
    createDirectTriggerContext(db, bot, "conv_route_b", now);
    await gateway.sendMessage(auth, {
      conversationId: "conv_route_a",
      clientMessageId: "client_route_a",
      idempotencyKey: "same-route-key",
      text: "same content"
    });
    await expect(gateway.sendMessage(auth, {
      conversationId: "conv_route_b",
      clientMessageId: "client_route_b",
      idempotencyKey: "same-route-key",
      text: "same content"
    })).rejects.toMatchObject({ code: "idempotency.conflict", statusCode: 409 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = 'conv_route_b'").get().count).toBe(0);
  });

  it("dispatches only explicit eligible group triggers and rejects stale membership", async () => {
    const { db, botService, gateway } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Dispatch gate" });
    await botService.updateSettings("usr_owner", bot.id, {
      spaceId: SPACE_ID,
      allowGroup: true,
      visibilityPolicy: "groups"
    });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const now = new Date().toISOString();
    const conversationId = "conv_dispatch_group";
    db.prepare(`INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'group', 'Dispatch group', NULL, 10000, 'usr_owner', ?)`).run(conversationId, SPACE_ID, now);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
      VALUES (?, 'usr_owner', ?, NULL)`).run(conversationId, now);
    await botService.updateGroupPolicy("usr_owner", bot.id, { spaceId: SPACE_ID, conversationId });
    const sent = [];
    await gateway.registerConnection(auth, { send: (value) => sent.push(JSON.parse(value)) });

    insertMessageEvent(db, { messageId: "msg_plain_group", eventId: "evt_plain_group", sequence: 2, conversationId, actorId: "usr_owner", text: "ordinary group message" });
    await gateway.dispatchWorkspaceEvent({ id: "evt_plain_group", spaceId: SPACE_ID });
    expect(sent).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_agent_bot_deliveries WHERE bot_id = ?").get(bot.id).count).toBe(0);

    insertMessageEvent(db, { messageId: "msg_mention_group", eventId: "evt_mention_group", sequence: 3, conversationId, actorId: "usr_owner", text: "hello bot", mentionUserId: bot.botUserId });
    await gateway.dispatchWorkspaceEvent({ id: "evt_mention_group", spaceId: SPACE_ID });
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toMatchObject({ eventId: "evt_mention_group", type: "message.created", payload: {} });

    db.prepare("UPDATE conversation_members SET removed_at = ? WHERE conversation_id = ? AND user_id = ?").run(new Date().toISOString(), conversationId, bot.botUserId);
    insertMessageEvent(db, { messageId: "msg_stale_group", eventId: "evt_stale_group", sequence: 4, conversationId, actorId: "usr_owner", text: "stale grant", mentionUserId: bot.botUserId });
    await gateway.dispatchWorkspaceEvent({ id: "evt_stale_group", spaceId: SPACE_ID });
    expect(sent).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_agent_bot_deliveries WHERE event_id = 'evt_stale_group'").get().count).toBe(0);
  });

  it("closes a registered connection before dispatch after token rotation", async () => {
    const { db, botService, gateway } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Revoked socket" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const now = new Date().toISOString();
    createDirectTriggerContext(db, bot, "conv_revoked_socket", now);
    insertMessageEvent(db, { messageId: "msg_revoked_socket", eventId: "evt_revoked_socket", sequence: 2, conversationId: "conv_revoked_socket", actorId: "usr_owner", text: "do not deliver" });
    const send = vi.fn();
    const close = vi.fn();
    await gateway.registerConnection(auth, { send, close });
    await botService.rotateToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    await gateway.dispatchWorkspaceEvent({ id: "evt_revoked_socket", spaceId: SPACE_ID });
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(1008, "bot token revoked");
    await expect(gateway.heartbeat(auth)).rejects.toMatchObject({ code: "bot.invalid_token", statusCode: 401 });
  });

  it("applies persistent Bot rate limits before enqueueing a trigger", async () => {
    const { db, botService, gateway } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Dispatch limit" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const now = new Date().toISOString();
    createDirectTriggerContext(db, bot, "conv_dispatch_limit", now);
    db.prepare("UPDATE workspace_agent_bot_limits SET requests_per_minute = 1 WHERE bot_id = ?").run(bot.id);
    const sent = [];
    await gateway.registerConnection(auth, { send: (value) => sent.push(JSON.parse(value)) });
    insertMessageEvent(db, { messageId: "msg_limit_1", eventId: "evt_limit_1", sequence: 2, conversationId: "conv_dispatch_limit", actorId: "usr_owner", text: "first" });
    insertMessageEvent(db, { messageId: "msg_limit_2", eventId: "evt_limit_2", sequence: 3, conversationId: "conv_dispatch_limit", actorId: "usr_owner", text: "second" });
    await gateway.dispatchWorkspaceEvent({ id: "evt_limit_1", spaceId: SPACE_ID });
    await gateway.dispatchWorkspaceEvent({ id: "evt_limit_2", spaceId: SPACE_ID });
    expect(sent).toHaveLength(1);
    expect(db.prepare("SELECT event_id AS eventId FROM workspace_agent_bot_deliveries WHERE bot_id = ?").all(bot.id))
      .toEqual([{ eventId: "evt_limit_1" }]);
  });

  it("requires trigger scope and rejects ineligible senders or oversized messages", async () => {
    const { db, botService, gateway } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Dispatch risk gate" });
    const sendOnly = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID, scopes: ["messages:send"] });
    const sendOnlyAuth = await gateway.authenticate(sendOnly.token, { spaceId: SPACE_ID });
    const now = new Date().toISOString();
    createDirectTriggerContext(db, bot, "conv_dispatch_risk", now);
    insertMessageEvent(db, { messageId: "msg_scope_denied", eventId: "evt_scope_denied", sequence: 2, conversationId: "conv_dispatch_risk", actorId: "usr_owner", text: "scope denied" });
    await gateway.dispatchWorkspaceEvent({ id: "evt_scope_denied", spaceId: SPACE_ID });
    await expect(gateway.replay(sendOnlyAuth, 1)).resolves.toMatchObject({ events: [] });

    const triggerToken = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const triggerAuth = await gateway.authenticate(triggerToken.token, { spaceId: SPACE_ID });
    const sent = [];
    await gateway.registerConnection(triggerAuth, { send: (value) => sent.push(JSON.parse(value)) });
    db.prepare(`INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES ('usr_gateway_outsider', 'gateway-outsider', 'gateway-outsider', NULL, 'Gateway outsider', NULL, 'human', ?, NULL)`).run(now);
    db.prepare(`INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES (?, 'usr_gateway_outsider', 'member', ?, NULL)`).run(SPACE_ID, now);
    insertMessageEvent(db, { messageId: "msg_outsider", eventId: "evt_outsider", sequence: 3, conversationId: "conv_dispatch_risk", actorId: "usr_gateway_outsider", text: "not a conversation member" });
    insertMessageEvent(db, { messageId: "msg_oversized", eventId: "evt_oversized", sequence: 4, conversationId: "conv_dispatch_risk", actorId: "usr_owner", text: "x".repeat(100 * 1024 + 1) });
    await gateway.dispatchWorkspaceEvent({ id: "evt_outsider", spaceId: SPACE_ID });
    await gateway.dispatchWorkspaceEvent({ id: "evt_oversized", spaceId: SPACE_ID });
    expect(sent).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_agent_bot_deliveries WHERE bot_id = ?").get(bot.id).count).toBe(0);
  });

  it("tracks Gateway connection and heartbeat state", async () => {
    const { botService, gateway } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Heartbeat test" });
    const issued = await botService.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const connection = { adapterVersion: "test-1", connectionNonce: "nonce-1", send() {} };
    const cleanup = await gateway.registerConnection(auth, connection);
    await expect(gateway.heartbeat(auth)).resolves.toMatchObject({ timestamp: expect.any(String) });
    await expect(botService.getConnectionStatus("usr_owner", bot.id, SPACE_ID)).resolves.toMatchObject({ status: "connected", adapterVersion: "test-1" });
    await cleanup();
    await expect(botService.getConnectionStatus("usr_owner", bot.id, SPACE_ID)).resolves.toMatchObject({ status: "disconnected" });
  });

  it("uses one authoritative Bot card row, validates the message reference, and keeps retries atomic", async () => {
    const { db, botService, gateway, cardService } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Card Gateway" });
    const issued = await botService.issueToken("usr_owner", bot.id, {
      spaceId: SPACE_ID,
      scopes: ["cards:write", "messages:send"]
    });
    const auth = await gateway.authenticate(issued.token, { spaceId: SPACE_ID });
    const conversationId = "conv_gateway_card";
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'direct', ?, ?, 10000, ?, ?)`).run(conversationId, SPACE_ID, "Gateway card", "gateway-card", "usr_owner", now);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, NULL)`).run(conversationId, "usr_owner", now);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, NULL)`).run(conversationId, bot.botUserId, now);

    const input = {
      conversationId,
      clientMessageId: "card-message-1",
      idempotencyKey: "card-send-1",
      cardType: "future.poll",
      schemaVersion: 1,
      fallbackText: "投票卡片",
      payload: { question: "你好吗？", options: ["好", "很好"] }
    };
    const sent = await gateway.sendCard(auth, input);
    expect(sent.card).toMatchObject({ id: expect.any(String), cardType: "future.poll", revision: 1, status: "active" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_agent_bot_cards").get().count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_cards WHERE source_kind = 'custom_bot'").get().count).toBe(1);
    expect(db.prepare("SELECT created_by_user_id AS createdByUserId, visibility_scope AS visibilityScope FROM workspace_cards WHERE id = ?").get(sent.card.id))
      .toEqual({ createdByUserId: bot.botUserId, visibilityScope: "conversation" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(conversationId).count).toBe(1);
    await expect(cardService.resolveCard("usr_owner", sent.card.id)).resolves.toMatchObject({
      type: "card_fallback",
      fallbackText: "投票卡片"
    });

    const replay = await gateway.sendCard(auth, input);
    expect(replay.card.id).toBe(sent.card.id);
    expect(replay.message.id).toBe(sent.message.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_cards WHERE source_kind = 'custom_bot'").get().count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(conversationId).count).toBe(1);

    await expect(gateway.updateCard(auth, sent.card.id, {
      expectedRevision: 1,
      payload: { question: "新的问题", options: ["A", "B"] }
    })).resolves.toMatchObject({ card: { id: sent.card.id, revision: 2 } });
    expect(db.prepare("SELECT type FROM workspace_events WHERE target_id = ? ORDER BY seq").all(sent.card.id).map(({ type }) => type))
      .toEqual(["card.created", "card.updated"]);
    await expect(gateway.updateCard(auth, sent.card.id, {
      expectedRevision: 1,
      payload: { question: "冲突", options: ["A", "B"] }
    })).rejects.toMatchObject({ code: "card.revision_conflict", statusCode: 409 });
    await expect(gateway.updateCard(auth, sent.card.id, {
      expectedRevision: 2,
      status: "invalidated"
    })).resolves.toMatchObject({ card: { id: sent.card.id, revision: 3, status: "invalidated" } });
    expect(db.prepare("SELECT type FROM workspace_events WHERE target_id = ? ORDER BY seq").all(sent.card.id).map(({ type }) => type))
      .toEqual(["card.created", "card.updated", "card.invalidated"]);
  });

  it("backfills deleted legacy Bot cards as invalidated shared cards idempotently", async () => {
    const { db, botService } = await fixture();
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Legacy Card" });
    const now = new Date().toISOString();
    const conversationId = "conv_gateway_legacy_card";
    db.prepare(`INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'direct', ?, ?, 10000, ?, ?)`).run(conversationId, SPACE_ID, "Legacy card", "legacy-card", "usr_owner", now);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, NULL)`).run(conversationId, "usr_owner", now);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, NULL)`).run(conversationId, bot.botUserId, now);
    db.prepare(`INSERT INTO workspace_agent_bot_cards
      (id, bot_id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text, revision, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, 3, 'deleted', ?, ?)`).run(
      "legacy_card_1", bot.id, SPACE_ID, conversationId, "future.poll", JSON.stringify({ options: ["A", "B"] }), "旧卡片", now, now
    );
    const migration = readFileSync(new URL("../migrations/023_workspace_unified_bot_cards.sql", import.meta.url), "utf8");
    db.exec(migration);
    db.exec(migration);
    expect(db.prepare("SELECT source_kind AS sourceKind, status, revision FROM workspace_cards WHERE id = ?").get("legacy_card_1"))
      .toEqual({ sourceKind: "custom_bot", status: "invalidated", revision: 3 });
  });

  function createDirectTriggerContext(db, bot, conversationId, timestamp) {
    db.prepare(`INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'direct', ?, ?, 10000, 'usr_owner', ?)`)
      .run(conversationId, SPACE_ID, conversationId, `direct-${conversationId}`, timestamp);
    for (const userId of ["usr_owner", bot.botUserId]) {
      db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
        VALUES (?, ?, ?, NULL)`).run(conversationId, userId, timestamp);
    }
    db.prepare(`INSERT INTO workspace_agent_bot_context_grants
      (grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, NULL, 'usr_owner', ?, ?)`)
      .run(`grant-${conversationId}`, bot.id, SPACE_ID, conversationId, timestamp, timestamp);
  }

  function insertMessageEvent(db, { messageId, eventId, sequence, conversationId, actorId, text, mentionUserId = null }) {
    const timestamp = new Date().toISOString();
    const blocks = [{ type: "text", text }];
    if (mentionUserId) blocks.push({ type: "mention", userId: mentionUserId, label: "Bot" });
    const content = { format: "duallane.rich.v1", plainText: text, blocks };
    db.prepare(`INSERT INTO messages (
      id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
      content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at
    ) VALUES (?, ?, ?, ?, 'human', 'user', ?, 'duallane.rich.v1', ?, ?, NULL, ?, NULL, NULL)`)
      .run(messageId, SPACE_ID, conversationId, actorId, `client-${messageId}`, JSON.stringify(content), text, timestamp);
    db.prepare(`INSERT INTO workspace_events (
      id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
    ) VALUES (?, ?, ?, 'message.created', ?, ?, 'message', ?, ?, ?)`)
      .run(eventId, SPACE_ID, sequence, actorId, conversationId, messageId, JSON.stringify({ messageId, conversationId }), timestamp);
  }

  async function fixture(gatewayOptions = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-gateway-test-"));
    const db = openTestDatabase(directory);
    const botService = createWorkspaceAgentBotService({ db });
    const cardService = createWorkspaceCardInteractionService({ db, registry: createWorkspaceCardRegistry() });
    const gateway = createWorkspaceBotGatewayService({ db, botService, cardService, ...gatewayOptions });
    fixtures.push({ db, directory });
    return { db, botService, gateway, cardService };
  }
});
