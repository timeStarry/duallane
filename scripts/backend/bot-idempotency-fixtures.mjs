// Actual Node gateway + card/message services on synthetic SQLite. No server,
// provider, production env, or raw tokens enter the saved fixtures or output.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { createWorkspaceAgentBotService } from "../../apps/web/server/services/workspace-agent-bots.mjs";
import { createWorkspaceBotGatewayService } from "../../apps/web/server/services/workspace-bot-gateway.mjs";
import { createWorkspaceCardInteractionService } from "../../apps/web/server/services/workspace-card-interactions.mjs";
import { createWorkspaceCardRegistry } from "../../apps/web/server/services/workspace-card-registry.mjs";

const snippets = [
  '{"z":1,"a":2}',
  '{"10":"ten","2":"two","01":"leading","4294967295":5,"0":0,"4294967294":4,"a":1}',
  '{"z":1,"a":2,"z":3,"\\u0061":4}',
  '{"z":{"b":2,"a":1},"a":[{"y":2,"x":1}]}',
  '{"value":"<>&\\u2028\\u2029","literal":"\\\\u2028"}',
  '{"value":"\\ud800","pair":"\\ud83d\\ude00","low":"\\udc00"}',
  '{"values":[-0,1.0,1e0,1e-7,1e-6,1e20,1e21,9007199254740993,333333333.33333329,5e-324]}',
  '[true,false,null,{},[],"\\b\\f\\n\\r\\t\\u0000\\/\\\""]'
];
// Binary64 edge coverage independent of operation schemas (all synthetic).
let seed = 0x29f1ace5;
for (let index = 0; index < 256; index++) {
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(next(), 0);
  bytes.writeUInt32BE(next(), 4);
  const value = bytes.readDoubleBE();
  if (Number.isFinite(value)) snippets.push(JSON.stringify(value));
}
snippets.push('1e999', '-1e999');

const directory = await mkdtemp(path.join(tmpdir(), "duallane-bot-hashes-"));
let db;
try {
  db = openTestDatabase(directory);
  const bots = createWorkspaceAgentBotService({ db });
  const cards = createWorkspaceCardInteractionService({ db, registry: createWorkspaceCardRegistry() });
  const gateway = createWorkspaceBotGatewayService({ db, botService: bots, cardService: cards });
  const bot = await bots.createBot("usr_owner", { spaceId: "spc_default", name: "Synthetic hash fixture" });
  const issued = await bots.issueToken("usr_owner", bot.id, { spaceId: "spc_default", scopes: ["messages:send", "cards:write"] });
  const auth = await gateway.authenticate(issued.token, { spaceId: "spc_default" });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
    VALUES ('conv_hash', 'spc_default', 'direct', 'Synthetic hashes', 'direct-hash', 10000, 'usr_owner', ?)`).run(now);
  for (const user of ["usr_owner", bot.botUserId]) {
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES ('conv_hash', ?, ?, NULL)").run(user, now);
  }
  const operations = [];
  const capture = async (operation, name, raw) => {
    const input = JSON.parse(raw);
    try {
      const result = await gateway[operation](auth, input);
      const persisted = db.prepare("SELECT request_hash AS hash FROM workspace_agent_bot_idempotency WHERE bot_id = ? AND idempotency_key = ?").get(bot.id, input.idempotencyKey);
      assert.ok(persisted?.hash);
      const before = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = 'conv_hash'").get().count;
      const replay = await gateway[operation](auth, input);
      assert.equal(result.message.id, replay.message.id);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = 'conv_hash'").get().count, before);
      operations.push({ operation, name, raw, hash: persisted.hash });
    } catch (error) {
      if (typeof error?.code !== "string" || !/^(message|card|idempotency)\./.test(error.code)) throw error;
      operations.push({ operation, name, raw, error: error.code, status: error.statusCode ?? 400 });
    }
  };
  const messageCases = [
    ['plain', '"  Synthetic text  "'],
    ['bom', '"\\ufeffSynthetic text\\ufeff"'],
    ['next-line', '"\\u0085Synthetic text\\u0085"'],
    ['surrogate', '"Synthetic \\ud800"'],
    ['block-order', '{"format":"duallane.message+json;v=1","plainText":"Synthetic text","blocks":[{"text":"Synthetic text","type":"text"}]}'],
    ['block-extra', '{"format":"duallane.message+json;v=1","plainText":"Synthetic text","blocks":[{"z":{"b":2,"a":1},"text":"Synthetic text","type":"text","a":0}]}'],
    ['block-duplicate', '{"format":"duallane.message+json;v=1","plainText":"Synthetic text","blocks":[{"text":"old","type":"text","text":"Synthetic text"}]}'],
    ['block-surrogate', '{"format":"duallane.message+json;v=1","plainText":"Synthetic text","blocks":[{"x":"\\ud800","text":"Synthetic text","type":"text"}]}']
  ];
  for (const [name, content] of messageCases) {
    await capture("sendMessage", name, `{"conversationId":"conv_hash","clientMessageId":"msg_${name}","idempotencyKey":"msg_${name}","content":${content}}`);
  }
  for (const [name, extra] of [['empty-reply', '""'], ['null-reply', 'null'], ['number-reply', '1']]) {
    await capture("sendMessage", name, `{"conversationId":"conv_hash","clientMessageId":"msg_${name}","idempotencyKey":"msg_${name}","text":"Synthetic text","replyToMessageId":${extra}}`);
  }
  for (const [index, payload] of snippets.slice(0, 7).entries()) {
    await capture("sendCard", `card-${index}`, `{"conversationId":"conv_hash","clientMessageId":"card_${index}","idempotencyKey":"card_${index}","cardType":"future.synthetic","schemaVersion":1,"fallbackText":"Synthetic card","payload":${payload}}`);
  }
  const fixtures = { json: snippets.map(raw => ({ raw, normalized: JSON.stringify(JSON.parse(raw)) })), operations };
  const target = new URL("../../apps/backend/internal/workspace/botgateway/testdata/node-idempotency.json", import.meta.url);
  if (process.argv.includes("--write")) {
    await writeFile(target, `${JSON.stringify(fixtures, null, 2)}\n`);
  } else {
    assert.deepEqual(fixtures, JSON.parse(await readFile(target, "utf8")));
  }
  process.stdout.write(`Bot Node persisted hashes: ${operations.length}; JSON cases: ${fixtures.json.length}; PASS\n`);
} finally {
  db?.close();
  await rm(directory, { recursive: true, force: true });
}
