import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { TOPIC_CARD_DEFINITION } from "../../apps/web/server/services/workspace-topics.mjs";
import { TOPIC_SYNC_CARD_DEFINITION } from "../../apps/web/server/services/workspace-topic-messages.mjs";

const fixtureURL = new URL("../../apps/backend/internal/workspace/topics/testdata/cards-node.json", import.meta.url);
const created = { topicId: "top_fixture", title: "话题", descriptionPreview: " body \n text ", participantCount: 1, status: "open", allowSyncToGroup: true };
const synced = { topicId: "top_fixture", topicMessageId: "message-fixture", projectionId: "projection-fixture", projectionType: "group_sync", title: "话题", messagePreview: " preview \n body ", status: "closed" };
const examples = [
  ["created", TOPIC_CARD_DEFINITION, created],
  ["strip private fields", TOPIC_CARD_DEFINITION, { ...created, internalSecret: "synthetic-hidden", allowSyncToGroup: 1 }],
  ...[null, true, [], [null], [["2"]], "0x10", "1e3", 1000000, 1000001, -1, 1.5, "1_0", "0x1p2", [true], [1, 2]].map((participantCount, index) => [`count ${index}`, TOPIC_CARD_DEFINITION, { ...created, participantCount }]),
  ["missing count", TOPIC_CARD_DEFINITION, { ...created, participantCount: undefined }],
  ["invalid title", TOPIC_CARD_DEFINITION, { ...created, title: "[bad]" }],
  ["BOM and NEXT LINE preview", TOPIC_CARD_DEFINITION, { ...created, title: "\ufeff标题\ufeff", descriptionPreview: "\ufeffa\u0085b\ufeffc\ufeff" }],
  ["truncate preview", TOPIC_CARD_DEFINITION, { ...created, descriptionPreview: "😀".repeat(162) }],
  ["synced", TOPIC_SYNC_CARD_DEFINITION, synced],
  ["synced strips controls", TOPIC_SYNC_CARD_DEFINITION, { ...synced, title: "\u0001Title\u007f", secret: "synthetic-hidden" }],
  ["bad projection type", TOPIC_SYNC_CARD_DEFINITION, { ...synced, projectionType: "topic" }],
  ["bad status", TOPIC_SYNC_CARD_DEFINITION, { ...synced, status: "deleted" }],
  ["long sync title allowed", TOPIC_SYNC_CARD_DEFINITION, { ...synced, title: "a".repeat(128) }],
  ["long sync title rejected", TOPIC_SYNC_CARD_DEFINITION, { ...synced, title: "a".repeat(129) }]
];
const fixtures = examples.map(([name, definition, payload]) => {
  payload = JSON.parse(JSON.stringify(payload));
  try { return { name, cardType: definition.cardType, payload, expected: definition.validatePayload(payload) }; }
  catch (error) { return { name, cardType: definition.cardType, payload, error: { code: error.code, message: error.message } }; }
});
if (process.argv.includes("--write")) {
  await writeFile(fixtureURL, `${JSON.stringify(fixtures, null, 2)}\n`);
} else {
  assert.deepEqual(JSON.parse(await readFile(fixtureURL, "utf8")), fixtures);
}
console.log(JSON.stringify({ status: "PASS", cases: fixtures.length, oracle: "Node registered topic card validators" }));
