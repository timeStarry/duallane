import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  convertFeishuCard,
  validateConvertedFeishuCard
} from "../../apps/web/server/services/workspace-feishu-card-converter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const casesPath = path.join(root, "apps/backend/internal/workspace/feishucards/testdata/feishu-card-cases.json");
const goldenPath = path.join(root, "apps/backend/internal/workspace/feishucards/testdata/feishu-card-golden.json");
const cases = JSON.parse(await readFile(casesPath, "utf8"));
const golden = JSON.parse(await readFile(goldenPath, "utf8"));

function expected(name) {
  const result = golden.find((fixture) => fixture.name === name);
  assert.ok(result, `missing golden ${name}`);
  return result;
}

for (const fixture of cases.success ?? []) {
  test(`Node Feishu converter ${fixture.name}`, () => {
    const converted = convertFeishuCard(fixture.input);
    const result = expected(fixture.name);
    assert.equal(JSON.stringify(converted.payload), result.payloadJSON);
    assert.equal(converted.fallbackText, result.fallbackText);
  });
}

for (const fixture of cases.reconstruction ?? []) {
  test(`Node Feishu reconstruction ${fixture.name}`, () => {
    const payload = validateConvertedFeishuCard(fixture.payload);
    const result = expected(fixture.name);
    assert.equal(JSON.stringify(payload), result.payloadJSON);
    assert.equal(result.ok, true);
  });
}

for (const fixture of cases.errors ?? []) {
  test(`Node Feishu rejection ${fixture.name}`, () => {
    let input = fixture.input;
    if (input?.elements === "__REPLACE_WITH_81_HR__") {
      input = { ...input, elements: Array.from({ length: 81 }, () => ({ tag: "hr" })) };
    }
    if (input?.elements?.[0]?.text?.content === "__REPLACE_WITH_13K__") {
      input = { ...input, elements: [{ ...input.elements[0], text: { ...input.elements[0].text, content: "x".repeat(13 * 1024) } }] };
    }
    assert.throws(() => convertFeishuCard(input), (error) => error?.code === fixture.code);
    assert.equal(expected(fixture.name).errorCode, fixture.code);
  });
}
