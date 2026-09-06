// Characterize the active Node implementation's persisted idempotency hashes.
// Only synthetic, task-owned SQLite state is created; no runtime configuration
// or external provider is loaded. Keep these goldens through the rollback window.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { createEchoRequirementService } from "../../apps/web/server/services/echo-requirements.mjs";

const examples = [
  { name: "plain", title: "A small request" },
  { name: "html", title: "A < B & B > C", relatedLink: "https://example.com/?a=1&b=2" },
  { name: "unicode-separators", title: "first\u2028second\u2029third" },
  { name: "literal-escapes", title: String.raw`literal \u2028 and \\u2029 and \"quote` },
  { name: "default-port", relatedLink: "https://EXAMPLE.com:443" },
  { name: "idn", relatedLink: "https://例子.测试/反馈" },
  { name: "dot-path", relatedLink: "https://example.com/a/%2e%2e/b/./c" },
  { name: "space-path", relatedLink: "https://example.com/a b?q=a b" },
  { name: "special-slashes", relatedLink: String.raw`https:\\example.com\a` },
  { name: "bom-trimming", title: "\ufeff Synthetic request \ufeff" },
  { name: "next-line-rejected", title: "\u0085Synthetic request\u0085" },
  { name: "private-numeric", relatedLink: "http://2130706433/private" },
  { name: "private-ipv6", relatedLink: "http://[::1]/private" }
];

export async function characterizeRequirements() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-echo-contract-"));
  let db;
  try {
    db = openTestDatabase(directory);
    const service = createEchoRequirementService({ db, now: () => new Date("2026-09-06T12:00:00.000Z") });
    const fixtures = [];
    for (const example of examples) {
      const { name, ...overrides } = example;
      const input = {
        actorId: "usr_owner", spaceId: "spc_default", type: "requirement",
        title: "Synthetic request", detail: "Synthetic detail", scenario: "Synthetic scenario",
        expectedResult: "Synthetic result", relatedLink: null, idempotencyKey: name,
        ...overrides
      };
      try {
        const result = await service.submit(input);
        const hash = db.prepare("SELECT request_hash AS hash FROM echo_requirement_idempotency WHERE operation = 'submit' AND idempotency_key = ?").get(name).hash;
        const transition = { actorId: "usr_owner", spaceId: "spc_default", publicId: result.publicId, toState: "collected", expectedRevision: 1, response: "A < B & C\u2028line", idempotencyKey: `transition-${name}` };
        await service.transition(transition);
        const transitionHash = db.prepare("SELECT request_hash AS hash FROM echo_requirement_idempotency WHERE operation = 'transition' AND idempotency_key = ?").get(transition.idempotencyKey).hash;
        fixtures.push({ name, input, relatedLink: result.relatedLink, hash, transition, transitionHash });
      } catch (error) {
        if (typeof error?.code !== "string" || !error.code.startsWith("echo.")) throw error;
        fixtures.push({ name, input, error: error.code });
      }
    }
    return fixtures;
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const result = await characterizeRequirements();
if (process.argv.includes("--check")) {
  const expected = JSON.parse(await readFile(new URL("../../apps/backend/internal/workspace/echo/requirements/testdata/node-idempotency.json", import.meta.url), "utf8"));
  assert.deepEqual(result, expected);
  process.stdout.write(`Echo Node persisted-contract fixtures passed: ${result.length}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
