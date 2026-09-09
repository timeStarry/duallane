// Characterizes the real Node Bot Gateway message writer on synthetic SQLite.
// Generated output contains only normalized DTOs and never stores a raw token.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "../../apps/web/node_modules/fastify/fastify.js";
import { registerWorkspaceBotGatewayRoutes } from "../../apps/web/server/routes/workspace-bot-gateway.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { createWorkspaceAgentBotService } from "../../apps/web/server/services/workspace-agent-bots.mjs";
import { createWorkspaceBotGatewayService } from "../../apps/web/server/services/workspace-bot-gateway.mjs";

const SPACE_ID = "spc_default";
const CONVERSATION_ID = "conv_message_dto";
const NOW = "2026-09-06T09:10:11.123Z";
const GOLDEN_PATH = new URL("../../apps/backend/internal/workspace/botgateway/testdata/node-message-dto.json", import.meta.url);

function normalizeValue(value, ids, key = "") {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, ids, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalizeValue(item, ids, name)]));
  }
  if (typeof value !== "string") return value;
  if (value === ids.botId) return "bot_fixture";
  if (value === ids.botUserId) return "usr_bot_fixture";
  if (value === CONVERSATION_ID) return CONVERSATION_ID;
  if (key === "createdAt" || key === "updatedAt" || key === "testedAt" || /At$/u.test(key)) return NOW;
  if (key === "id" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) return "message_fixture";
  return value;
}

function keySet(value) {
  return Object.keys(value ?? {});
}

function messageCount(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(CONVERSATION_ID).count;
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-message-dto-"));
  const db = openTestDatabase(directory);
  const app = Fastify({ logger: false });
  let bot;
  try {
    const botService = createWorkspaceAgentBotService({ db, now: () => new Date(NOW) });
    const gateway = createWorkspaceBotGatewayService({ db, botService, now: () => new Date(NOW) });
    bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Gateway DTO Fixture" });
    const issued = await botService.issueToken("usr_owner", bot.id, {
      spaceId: SPACE_ID,
      scopes: ["messages:send"]
    });
    const createdAt = NOW;
    db.prepare(`INSERT INTO conversations
      (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'direct', ?, ?, 10000, ?, ?)`)
      .run(CONVERSATION_ID, SPACE_ID, "Gateway DTO Fixture", "gateway-dto-fixture", "usr_owner", createdAt);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
      VALUES (?, ?, ?, NULL), (?, ?, ?, NULL)`)
      .run(CONVERSATION_ID, "usr_owner", createdAt, CONVERSATION_ID, bot.botUserId, createdAt);

    registerWorkspaceBotGatewayRoutes({ app, gateway, workspaceEnabled: true, getSpaceId: () => SPACE_ID });
    await app.ready();

    const requests = [
      {
        name: "text-alias",
        payload: {
          conversationId: CONVERSATION_ID,
          clientMessageId: "client_text_alias",
          idempotencyKey: "idem_text_alias",
          text: "Hello <& "
        }
      },
      {
        name: "content-wins-over-text",
        payload: {
          conversationId: CONVERSATION_ID,
          clientMessageId: "client_content_wins",
          idempotencyKey: "idem_content_wins",
          text: "ignored text",
          content: {
            format: "duallane.message+json;v=1",
            plainText: "Content wins",
            blocks: [{ type: "text", text: "Content wins" }]
          }
        }
      },
      {
        name: "null-content-falls-back-to-text",
        payload: {
          conversationId: CONVERSATION_ID,
          clientMessageId: "client_null_content",
          idempotencyKey: "idem_null_content",
          content: null,
          text: "Null content fallback"
        }
      },
      {
        name: "idempotency-aliases-client-message-id",
        payload: {
          conversationId: CONVERSATION_ID,
          idempotencyKey: "idem_only_client",
          text: "Idempotency alias"
        }
      }
    ];

    const results = [];
    for (const testCase of requests) {
      const before = messageCount(db);
      const response = await app.inject({
        method: "POST",
        url: "/api/bot-gateway/v1/messages",
        headers: { authorization: `Bearer ${issued.token}` },
        payload: testCase.payload
      });
      const body = response.json();
      if (testCase.expectedError) {
        assert.equal(response.statusCode, 400, `${testCase.name}: ${response.body}`);
        assert.equal(body.error.code, testCase.expectedError);
        results.push({
          name: testCase.name,
          request: testCase.payload,
          statusCode: response.statusCode,
          response: body,
          responseKeys: keySet(body),
          messageCountBefore: before,
          messageCountAfter: messageCount(db)
        });
        continue;
      }
      assert.equal(response.statusCode, 201, `${testCase.name}: ${response.body}`);
      assert.ok(body.message);
      const normalized = normalizeValue(body, { botId: bot.id, botUserId: bot.botUserId });
      const messageKeys = keySet(body.message);
      assert.deepEqual(messageKeys, ["id", "conversationId", "plainText", "content", "createdAt"]);
      assert.equal(Object.hasOwn(body.message, "author"), false);
      results.push({
        name: testCase.name,
        request: testCase.payload,
        statusCode: response.statusCode,
        response: normalized,
        responseKeys: keySet(normalized),
        messageKeys,
        contentKeys: keySet(body.message.content),
        messageCountBefore: before,
        messageCountAfter: messageCount(db)
      });

      if (testCase.name === "text-alias") {
        const replay = await app.inject({
          method: "POST",
          url: "/api/bot-gateway/v1/messages",
          headers: { authorization: `Bearer ${issued.token}` },
          payload: testCase.payload
        });
        assert.equal(replay.statusCode, 201, replay.body);
        assert.equal(replay.json().message.id, body.message.id);
        assert.equal(messageCount(db), before + 1);
        results.at(-1).replay = {
          statusCode: replay.statusCode,
          response: normalizeValue(replay.json(), { botId: bot.id, botUserId: bot.botUserId }),
          messageCountAfter: messageCount(db)
        };
      }
    }

    const fixture = {
      contract: "node-bot-gateway-message-v1",
      source: "apps/web/server/routes/workspace-bot-gateway.mjs + services/workspace-bot-gateway.mjs + services/workspace.mjs",
      method: "POST",
      path: "/api/bot-gateway/v1/messages",
      statusCode: 201,
      responseMessageKeys: ["id", "conversationId", "plainText", "content", "createdAt"],
      responseMessageAuthor: "omitted",
      contentKeys: ["format", "plainText", "blocks"],
      cases: results
    };
    if (process.argv.includes("--write")) {
      await writeFile(GOLDEN_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    } else {
      assert.deepEqual(fixture, JSON.parse(await readFile(GOLDEN_PATH, "utf8")));
    }
    process.stdout.write(`bot-message-dto-fixtures ${process.argv.includes("--write") ? "written" : "verified"} ${results.length} PASS\n`);
  } finally {
    await app.close().catch(() => {});
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
