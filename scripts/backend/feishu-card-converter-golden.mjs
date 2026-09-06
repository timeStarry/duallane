import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  convertFeishuCard,
  validateConvertedFeishuCard
} from "../../apps/web/server/services/workspace-feishu-card-converter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const casesPath = path.join(root, "apps/backend/internal/workspace/feishucards/testdata/feishu-card-cases.json");
const goldenPath = path.join(root, "apps/backend/internal/workspace/feishucards/testdata/feishu-card-golden.json");
const shouldWrite = process.argv.includes("--write");

const cases = JSON.parse(await readFile(casesPath, "utf8"));
const materialized = materializeCases(cases);
const output = [];
for (const fixture of materialized) {
  try {
    const converted = fixture.kind === "reconstruction"
      ? { payload: validateConvertedFeishuCard(fixture.payload) }
      : convertFeishuCard(fixture.input);
    output.push({
      name: fixture.name,
      ok: true,
      fallbackText: converted.fallbackText ?? deriveFallback(converted.payload),
      payloadJSON: JSON.stringify(converted.payload)
    });
  } catch (error) {
    output.push({ name: fixture.name, ok: false, errorCode: error?.code ?? "unknown" });
  }
}

if (shouldWrite) {
  await writeFile(goldenPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
} else {
  const expected = JSON.parse(await readFile(goldenPath, "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(output)) {
    throw new Error("Feishu converter golden drift");
  }
}
process.stdout.write(`feishu-card-golden ${shouldWrite ? "written" : "verified"} ${output.length}\n`);

function materializeCases(input) {
  const result = [];
  for (const fixture of input.success ?? []) {
    result.push({ kind: "convert", name: fixture.name, input: fixture.input });
  }
  for (const fixture of input.reconstruction ?? []) {
    result.push({ kind: "reconstruction", name: fixture.name, payload: fixture.payload });
  }
  for (const fixture of input.errors ?? []) {
    let value = fixture.input;
    if (value?.elements === "__REPLACE_WITH_81_HR__") {
      value = { ...value, elements: Array.from({ length: 81 }, () => ({ tag: "hr" })) };
    }
    if (value?.elements?.[0]?.text?.content === "__REPLACE_WITH_13K__") {
      value = { ...value, elements: [{ ...value.elements[0], text: { ...value.elements[0].text, content: "x".repeat(13 * 1024) } }] };
    }
    result.push({ kind: "convert", name: fixture.name, input: value, expectedCode: fixture.code });
  }
  return result;
}

function deriveFallback(payload) {
  const candidates = [payload?.header?.title];
  for (const element of payload?.elements ?? []) {
    if (element?.type === "text") candidates.push(element.text);
    if (element?.type === "note") candidates.push(element.parts?.map((part) => part.text).join(" "));
  }
  const text = candidates.find((value) => typeof value === "string" && value.trim())?.trim() ?? "Bot 卡片";
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
