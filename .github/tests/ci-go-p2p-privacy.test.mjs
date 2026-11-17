import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Go P2P browser gate owns its server and never uploads private failure output", async () => {
  const root = new URL("../../", import.meta.url);
  const read = async (name) => (await readFile(new URL(name, root), "utf8")).replace(/\r\n?/g, "\n");
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
  assert.doesNotMatch(qualityGate, /DUALLANE_APP_VERSION:\s*["']\d/);
  const versionCommand = qualityGate.match(/- name: Read application release version\n\s+run: node -e "([^\n]+)"/)?.[1];
  assert.ok(versionCommand, "CI must read the release version from package.json");
  const fixture = await mkdtemp(path.join(tmpdir(), "duallane-ci-version-"));
  try {
    const envFile = path.join(fixture, "github-env");
    for (const version of [JSON.parse(manifest).version, "2.3.4"]) {
      await writeFile(path.join(fixture, "package.json"), JSON.stringify({ version }));
      await writeFile(envFile, "");
      const result = spawnSync(process.execPath, ["-e", versionCommand], {
        cwd: fixture,
        env: { ...process.env, GITHUB_ENV: envFile },
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(envFile, "utf8"), `DUALLANE_APP_VERSION=${version}\n`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
  assert.match(qualityGate, /docker compose --profile storage-migration build storage-provision/);
  assert.match(config, /testMatch:\s*\[\s*"p2p-go-privacy\.spec\.ts",\s*"p2p-ime\.spec\.ts",\s*"v1-p2p-acceptance\.spec\.ts"\s*\]/);
  assert.match(config, /outputDir: "\.private-test-results\/p2p-go-browser"/);
  for (const option of ["trace", "screenshot", "video"]) assert.match(config, new RegExp(`${option}: "off"`));
  assert.equal((config.match(/reuseExistingServer: false/g) || []).length, 2);
});
