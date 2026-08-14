import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import { createWorkspaceAgentBotService } from "./workspace-agent-bots.mjs";
import { createWorkspaceBotGatewayService } from "./workspace-bot-gateway.mjs";

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
    db.prepare(`INSERT INTO workspace_agent_bot_deliveries
      (id, bot_id, space_id, sequence, event_id, event_type, conversation_id, payload_json, status, attempts, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', 'queued', 0, ?, ?)`).run("bdl_replay_2", bot.id, SPACE_ID, 2, "evt_replay_2", "workspace.member_joined", now, now);
    db.prepare(`INSERT INTO workspace_agent_bot_deliveries
      (id, bot_id, space_id, sequence, event_id, event_type, conversation_id, payload_json, status, attempts, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', 'queued', 0, ?, ?)`).run("bdl_replay_3", bot.id, SPACE_ID, 3, "evt_replay_3", "workspace.member_left", now, now);

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

  async function fixture(gatewayOptions = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-gateway-test-"));
    const db = openTestDatabase(directory);
    const botService = createWorkspaceAgentBotService({ db });
    const gateway = createWorkspaceBotGatewayService({ db, botService, ...gatewayOptions });
    fixtures.push({ db, directory });
    return { db, botService, gateway };
  }
});
