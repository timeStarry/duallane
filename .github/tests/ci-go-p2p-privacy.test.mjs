import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Go P2P browser gate owns its server and never uploads private failure output", async () => {
  const root = new URL("../../", import.meta.url);
  const read = (name) => readFile(new URL(name, root), "utf8");
  const [workflow, config, nodeConfig, server, manifest] = await Promise.all([
    read(".github/workflows/ci.yml"), read("playwright.p2p-go.config.ts"), read("playwright.config.ts"), read("e2e/support/test-server.mjs"), read("package.json")
  ]);
  const job = workflow.slice(workflow.indexOf("  go-p2p-browser:"));
  const qualityGate = workflow.slice(workflow.indexOf("  quality-gate:"), workflow.indexOf("  go-workspace-browser:"));
  assert.ok(job.startsWith("  go-p2p-browser:"));
  assert.match(job, /actions\/setup-go@/);
  assert.match(job, /run: pnpm test:e2e:p2p-go/);
  assert.doesNotMatch(job, /upload-artifact@|TEST_DATABASE_URL|POSTGRES_PASSWORD/);
  assert.equal(JSON.parse(manifest).scripts["test:e2e:p2p-go"], "playwright test --config=playwright.p2p-go.config.ts");
  assert.match(nodeConfig, /testMatch:\s*\[\s*"p2p\.spec\.ts",\s*"p2p-ime\.spec\.ts"\s*\]/);
  assert.match(nodeConfig, /outputDir: "\.private-test-results\/p2p-go-default"/);
  for (const option of ["trace", "screenshot", "video"]) assert.match(nodeConfig, new RegExp(`${option}: "off"`));
  assert.doesNotMatch(nodeConfig, /testIgnore/);
  assert.doesNotMatch(server, /apps\/web\/server|openTestDatabase|createApp/);
  assert.match(server, /go-p2p-server\.mjs/);
  assert.match(qualityGate, /- name: Set up Go\n        uses: actions\/setup-go@v7\n        with:\n          go-version-file: apps\/backend\/go\.mod\n          cache-dependency-path: apps\/backend\/go\.sum/);
  assert.match(qualityGate, /DUALLANE_APP_VERSION: "0\.18\.0"/);
  assert.match(qualityGate, /docker compose --profile storage-migration build storage-provision/);
  assert.match(config, /testMatch:\s*\[\s*"p2p-go-privacy\.spec\.ts",\s*"p2p-ime\.spec\.ts"\s*\]/);
  assert.match(config, /outputDir: "\.private-test-results\/p2p-go-browser"/);
  for (const option of ["trace", "screenshot", "video"]) assert.match(config, new RegExp(`${option}: "off"`));
  assert.equal((config.match(/reuseExistingServer: false/g) || []).length, 2);
});
