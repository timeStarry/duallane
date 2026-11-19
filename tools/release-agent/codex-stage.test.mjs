import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCodexStage } from "./codex-stage.mjs";

const input = { protocol: "duallane.release-agent.develop", version: 1, ticketId: "DL-fixture", repository: "mobile",
  text: "会话列表预读不消耗未读", acceptance: ["两条未读保持"] };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "duallane-model-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, ".github"));
  await writeFile(join(directory, ".github", "config.json"), "private fixture");
  await writeFile(join(directory, "src", "unread.ts"), "export const afterPrefetch = () => 0;\n");
  return directory;
}

test("passes bounded source to the model and applies only validated anchored edits", async (t) => {
  const directory = await fixture(t);
  const notes = [];
  const result = await runCodexStage(input, { cwd: directory, complete: async (_schema, prompt) => {
    notes.push(prompt);
    assert.ok(!prompt.includes("private fixture"));
    assert.ok(!prompt.includes(".github/config.json"));
    return notes.length === 1 ? { files: ["src/unread.ts"] } : {
      summary: "保留列表预取的未读计数", edits: [{ path: "src/unread.ts", before: "() => 0", after: "(unread: number) => unread" },
        { path: "src/unread.test.ts", before: "", after: "// Same module regression test\n" }],
    };
  } });
  assert.equal(result.summary, "保留列表预取的未读计数");
  assert.match(await readFile(join(directory, "src", "unread.ts"), "utf8"), /unread: number/u);
  assert.match(await readFile(join(directory, "src", "unread.test.ts"), "utf8"), /Same module/u);
});

test("a model cannot select or modify other files and invalid multi-edit output stays unapplied", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(runCodexStage(input, { cwd: directory, complete: async () => ({ files: [".github/config.json"] }) }),
    { code: "development.codex_selection" });
  await assert.rejects(runCodexStage(input, { cwd: directory, complete: async (schema) => schema.properties.files ? { files: ["src/unread.ts"] } : {
    summary: "fixture", edits: [{ path: "src/unread.ts", before: "() => 0", after: "() => 2" },
      { path: "other.ts", before: "a", after: "b" }],
  } }), { code: "development.codex_edit_scope" });
  assert.match(await readFile(join(directory, "src", "unread.ts"), "utf8"), /\(\) => 0/u);
});
