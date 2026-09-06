import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { materializeActionGolden } from "./feishu-card-action-golden.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const goldenPath = path.join(root, "apps/backend/internal/workspace/feishucards/testdata/feishu-card-action-golden.json");

test("Node Feishu action side effects match the checked-in golden", async () => {
  const expected = JSON.parse(await readFile(goldenPath, "utf8"));
  assert.deepEqual(await materializeActionGolden(), expected);
});
