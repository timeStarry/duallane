import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createEchoCommandDefinitions
} from "../../apps/web/server/services/echo-runtime.mjs";

const fixture = JSON.parse(await readFile(new URL(
  "../../apps/backend/internal/workspace/echo/automation/testdata/node-parser-boundaries.json",
  import.meta.url
), "utf8"));

function inputFor(testCase) {
  switch (testCase.kind) {
    case "wrapped":
      return `${testCase.prefix ?? ""}${testCase.value ?? ""}${testCase.suffix ?? ""}`;
    case "quoted-repeat":
      return `"${String(testCase.value ?? "").repeat(testCase.count)}"`;
    case "repeat":
      return String(testCase.value ?? "").repeat(testCase.count);
    default:
      throw new Error(`unknown parser fixture kind: ${testCase.kind}`);
  }
}

function observe(testCase, parseArguments) {
  try {
    const result = parseArguments(inputFor(testCase));
    return { ok: true, type: result.type };
  } catch (error) {
    return { ok: false, code: error?.code ?? "unknown" };
  }
}

const need = createEchoCommandDefinitions().find((definition) => definition.name === "need");
assert.ok(need?.parseArguments, "Node need parser is unavailable");
const observed = fixture.cases.map((testCase) => ({
  name: testCase.name,
  ...observe(testCase, need.parseArguments)
}));
const expected = fixture.cases.map((testCase) => ({ name: testCase.name, ...testCase.expect }));
assert.deepEqual(observed, expected);

if (process.argv.includes("--check")) {
  process.stdout.write("Echo parser Node fixtures passed\n");
} else {
  process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
}
