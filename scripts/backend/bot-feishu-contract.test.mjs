import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { convertFeishuCard } from "../../apps/web/server/services/workspace-feishu-card-converter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const golden = JSON.parse(await readFile(path.join(root, "scripts/backend/bot-feishu-contract-golden.json"), "utf8"));

test("Node Bot Feishu contract golden contains ordered request hashes", () => {
  assert.equal(golden.length, 2);
  for (const item of golden) {
    assert.match(item.requestHash, /^[0-9a-f]{64}$/u);
    const request = JSON.parse(item.requestJSON);
    assert.equal(request.payload && request.payload.format, "duallane.feishu-card.v1");
    assert.equal(JSON.stringify(request.payload), item.payloadJSON);
  }
});

test("Node Bot Feishu converter remains the source of the stored payload", () => {
  const source = { elements: [{ tag: "div", text: { tag: "plain_text", content: "synthetic" } }] };
  const converted = convertFeishuCard(source);
  const item = golden.find(({ name }) => name === "default-fallback-preserves-converted-order");
  assert.ok(item);
  assert.equal(converted.cardType, "feishu.adaptive.v1");
  assert.equal(converted.schemaVersion, 1);
  assert.equal(typeof item.payloadJSON, "string");
});
