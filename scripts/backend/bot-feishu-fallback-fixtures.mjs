// Characterizes the real Node Gateway -> card writer -> card GET path for
// lone-surrogate fallback text. Output is synthetic and token-free.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "../../apps/web/node_modules/fastify/fastify.js";
import { registerWorkspaceBotGatewayRoutes } from "../../apps/web/server/routes/workspace-bot-gateway.mjs";
import { registerWorkspaceCardRoutes } from "../../apps/web/server/routes/workspace-cards.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { createWorkspaceAgentBotService } from "../../apps/web/server/services/workspace-agent-bots.mjs";
import { createWorkspaceBotGatewayService } from "../../apps/web/server/services/workspace-bot-gateway.mjs";
import { createWorkspaceCardInteractionService } from "../../apps/web/server/services/workspace-card-interactions.mjs";
import { createWorkspaceCardRegistry } from "../../apps/web/server/services/workspace-card-registry.mjs";
import { convertFeishuCard } from "../../apps/web/server/services/workspace-feishu-card-converter.mjs";

const SPACE_ID = "spc_default";
const CONVERSATION_ID = "conv_feishu_fallback";
const NOW = "2026-09-06T09:10:11.123Z";
const GOLDEN_PATH = new URL("../../apps/backend/internal/workspace/botgateway/testdata/node-feishu-fallback.json", import.meta.url);

function describeString(value) {
  return {
    value,
    json: JSON.stringify(value),
    codeUnits: Array.from({ length: value.length }, (_unused, index) => value.charCodeAt(index)),
    codePoints: Array.from(value, (character) => character.codePointAt(0))
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeFallback(value) {
  const normalized = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim() : "";
  assert.ok(normalized && normalized.length <= 16_000 && !/<\/?[a-z][^>]*>/iu.test(normalized));
  return normalized;
}

function normalize(value, botId) {
  if (Array.isArray(value)) return value.map((item) => normalize(item, botId));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, botId)]));
  if (value === botId) return "bot_fixture";
  if (typeof value === "string" && /^card_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) return "card_fixture";
  return value;
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-feishu-fallback-"));
  const db = openTestDatabase(directory);
  const app = Fastify({ logger: false });
  try {
    const botService = createWorkspaceAgentBotService({ db, now: () => new Date(NOW) });
    const registry = createWorkspaceCardRegistry();
    const cards = createWorkspaceCardInteractionService({ db, registry, now: () => new Date(NOW) });
    const gateway = createWorkspaceBotGatewayService({ db, botService, cardService: cards, now: () => new Date(NOW) });
    const bot = await botService.createBot("usr_owner", { spaceId: SPACE_ID, name: "Feishu fallback fixture" });
    const issued = await botService.issueToken("usr_owner", bot.id, {
      spaceId: SPACE_ID,
      scopes: ["cards:write", "messages:send"]
    });
    db.prepare(`INSERT INTO conversations
      (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'direct', ?, ?, 10000, ?, ?)`)
      .run(CONVERSATION_ID, SPACE_ID, "Feishu fallback fixture", "feishu-fallback", "usr_owner", NOW);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
      VALUES (?, ?, ?, NULL), (?, ?, ?, NULL)`)
      .run(CONVERSATION_ID, "usr_owner", NOW, CONVERSATION_ID, bot.botUserId, NOW);

    registerWorkspaceBotGatewayRoutes({ app, gateway, workspaceEnabled: true, getSpaceId: () => SPACE_ID });
    registerWorkspaceCardRoutes(app, { service: cards, getActorId: (request) => request.headers["x-user"] ?? null });
    await app.ready();

    const cases = [
      {
        name: "default-header-title-lone-surrogate",
        card: {
          header: { title: { tag: "plain_text", content: "\ud800 title" } },
          elements: [{ tag: "div", text: { tag: "plain_text", content: "body" } }]
        }
      },
      {
        name: "default-markdown-lone-surrogate",
        card: {
          elements: [{ tag: "markdown", content: "\ud800 markdown" }]
        }
      },
      {
        name: "explicit-lone-surrogate",
        fallbackText: "\ud800 explicit",
        card: {
          elements: [{ tag: "div", text: { tag: "plain_text", content: "body" } }]
        }
      },
      {
        name: "explicit-bom-trim",
        fallbackText: "\ufeff  BOM explicit  \ufeff",
        card: {
          elements: [{ tag: "div", text: { tag: "plain_text", content: "body" } }]
        }
      },
      {
        name: "explicit-astral",
        fallbackText: "  😀 explicit  ",
        card: {
          elements: [{ tag: "div", text: { tag: "plain_text", content: "body" } }]
        }
      },
      {
        name: "explicit-empty",
        fallbackText: "",
        expectStatus: 400,
        card: {
          elements: [{ tag: "div", text: { tag: "plain_text", content: "body" } }]
        }
      },
      {
        name: "explicit-null",
        fallbackText: null,
        expectStatus: 400,
        card: {
          elements: [{ tag: "div", text: { tag: "plain_text", content: "body" } }]
        }
      }
    ];
    const observations = [];
    for (const [index, testCase] of cases.entries()) {
      const payload = {
        conversationId: CONVERSATION_ID,
        clientMessageId: `feishu_fallback_message_${index}`,
        idempotencyKey: `feishu_fallback_${index}`,
        format: "feishu-card",
        feishuCard: testCase.card
      };
      if (Object.hasOwn(testCase, "fallbackText")) payload.fallbackText = testCase.fallbackText;
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/bot-gateway/v1/cards",
        headers: { authorization: `Bearer ${issued.token}` },
        payload
      });
      if (createResponse.statusCode !== 201) {
        assert.equal(createResponse.statusCode, testCase.expectStatus ?? 201, `${testCase.name}: ${createResponse.body}`);
        const errorBody = createResponse.json();
        observations.push({
          name: testCase.name,
          input: testCase.card,
          fallbackText: testCase.fallbackText,
          createStatus: createResponse.statusCode,
          errorCode: errorBody.error?.code ?? null
        });
        continue;
      }
      const created = createResponse.json();
      const cardId = created.card.id;
      const getResponse = await app.inject({
        method: "GET",
        url: `/api/workspace/cards/${cardId}`,
        headers: { "x-user": "usr_owner" }
      });
      assert.equal(getResponse.statusCode, 200, `${testCase.name} GET: ${getResponse.body}`);
      const read = getResponse.json();
      const row = db.prepare("SELECT fallback_text AS fallbackText, payload_json AS payloadJSON FROM workspace_cards WHERE id = ?").get(cardId);
      const storedPayload = JSON.parse(row.payloadJSON);
      const converted = convertFeishuCard(testCase.card);
      const fallbackText = Object.hasOwn(testCase, "fallbackText") ? normalizeFallback(testCase.fallbackText) : converted.fallbackText;
      const nodeHashInput = {
        conversationId: CONVERSATION_ID,
        cardType: converted.cardType,
        schemaVersion: converted.schemaVersion,
        fallbackText,
        payload: converted.payload
      };
      const nodeHashJSON = JSON.stringify(nodeHashInput);
      const normalizedHashInput = { ...nodeHashInput, fallbackText: row.fallbackText };
      const normalizedHashJSON = JSON.stringify(normalizedHashInput);
      const idempotency = db.prepare(`SELECT request_hash AS requestHash
        FROM workspace_agent_bot_idempotency
        WHERE bot_id = ? AND operation = 'card.send' AND idempotency_key = ?`).get(bot.id, `feishu_fallback_${index}`);
      assert.equal(idempotency?.requestHash, sha256(nodeHashJSON), `${testCase.name}: Node request hash mismatch`);
      observations.push({
        name: testCase.name,
        input: testCase.card,
        ...(Object.hasOwn(testCase, "fallbackText") ? { fallbackText: testCase.fallbackText } : {}),
        createStatus: createResponse.statusCode,
        createCard: normalize(created.card, bot.id),
        createFallbackText: describeString(created.card.fallbackText),
        getStatus: getResponse.statusCode,
        getCard: normalize(read.card, bot.id),
        getFallbackText: describeString(read.card.block.fallbackText),
        dbFallbackText: describeString(row.fallbackText),
        dbPayloadHeaderTitle: storedPayload.header?.title === undefined ? null : describeString(storedPayload.header.title),
        dbPayloadFirstText: storedPayload.elements?.[0]?.text === undefined ? null : describeString(storedPayload.elements[0].text),
        hashInputFallbackText: describeString(nodeHashInput.fallbackText),
        hashInputJSON: nodeHashJSON,
        requestHash: idempotency.requestHash,
        normalizedFallbackHash: sha256(normalizedHashJSON),
        hashDiffersWhenFallbackUsesDBValue: idempotency.requestHash !== sha256(normalizedHashJSON)
      });
    }

    const fixture = {
      contract: "node-bot-gateway-feishu-fallback-v1",
      source: "apps/web/server/routes/workspace-bot-gateway.mjs + services/workspace-bot-gateway.mjs + services/workspace-card-interactions.mjs + routes/workspace-cards.mjs",
      database: "synthetic-sqlite",
      observations
    };
    if (process.argv.includes("--write")) {
      await writeFile(GOLDEN_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    } else {
      assert.deepEqual(fixture, JSON.parse(await readFile(GOLDEN_PATH, "utf8")));
    }
    process.stdout.write(`bot-feishu-fallback-fixtures ${process.argv.includes("--write") ? "written" : "verified"} ${observations.length} PASS\n`);
  } finally {
    await app.close().catch(() => {});
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
