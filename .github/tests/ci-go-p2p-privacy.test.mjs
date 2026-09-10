import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Go P2P browser gate owns its server and never uploads private failure output", async () => {
  const root = new URL("../../", import.meta.url);
  const read = (name) => readFile(new URL(name, root), "utf8");
  const [workflow, config, nodeConfig, manifest] = await Promise.all([
    read(".github/workflows/ci.yml"), read("playwright.p2p-go.config.ts"), read("playwright.config.ts"), read("package.json")
  ]);
  const job = workflow.slice(workflow.indexOf("  go-p2p-browser:"));
  assert.ok(job.startsWith("  go-p2p-browser:"));
  assert.match(job, /actions\/setup-go@/);
  assert.match(job, /run: pnpm test:e2e:p2p-go/);
  assert.doesNotMatch(job, /upload-artifact@|TEST_DATABASE_URL|POSTGRES_PASSWORD/);
  assert.equal(JSON.parse(manifest).scripts["test:e2e:p2p-go"], "playwright test --config=playwright.p2p-go.config.ts");
  assert.match(nodeConfig, /testIgnore: "\*\*\/p2p-go-privacy.spec.ts"/);
  assert.match(config, /testMatch: "p2p-go-privacy.spec.ts"/);
  assert.match(config, /outputDir: "\.private-test-results\/p2p-go-browser"/);
  for (const option of ["trace", "screenshot", "video"]) assert.match(config, new RegExp(`${option}: "off"`));
  assert.equal((config.match(/reuseExistingServer: false/g) || []).length, 2);
});
