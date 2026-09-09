import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { convertFeishuCard } from "../../apps/web/server/services/workspace-feishu-card-converter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const goldenPath = path.join(root, "scripts/backend/bot-feishu-contract-golden.json");
const shouldWrite = process.argv.includes("--write");

const cases = [
  {
    name: "default-fallback-preserves-converted-order",
    input: {
      header: { title: { tag: "plain_text", content: "审批" } },
      elements: [{ tag: "div", text: { tag: "plain_text", content: "原始 <& " } }]
    }
  },
  {
    name: "explicit-fallback-overrides-converter",
    input: {
      config: { version: "1.0", wide_screen_mode: true },
      elements: [{ tag: "markdown", content: "请确认" }]
    },
    fallbackText: "显式降级"
  }
];

const output = cases.map((fixture) => {
  const converted = convertFeishuCard(fixture.input);
  const fallbackText = fixture.fallbackText ?? converted.fallbackText;
  const request = {
    conversationId: "conv-feishu-contract",
    cardType: converted.cardType,
    schemaVersion: converted.schemaVersion,
    fallbackText,
    payload: converted.payload
  };
  const requestJSON = JSON.stringify(request);
  return {
    name: fixture.name,
    requestJSON,
    requestHash: createHash("sha256").update(requestJSON, "utf8").digest("hex"),
    payloadJSON: JSON.stringify(converted.payload),
    fallbackText
  };
});

if (shouldWrite) {
  await writeFile(goldenPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
} else {
  const expected = JSON.parse(await readFile(goldenPath, "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(output)) {
    throw new Error("Bot Feishu contract golden drift");
  }
}

process.stdout.write(`bot-feishu-contract ${shouldWrite ? "written" : "verified"} ${output.length}\n`);
