import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { disposableDatabaseURL } from "../../e2e/support/go-workspace-server.mjs";

test("Go browser database requires exact explicit opt-in and loopback URL", () => {
  const env = { DUALLANE_GO_E2E_ALLOW_SCHEMA_CREATION: "true", TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:55439/duallane?sslmode=disable" };
  assert.equal(disposableDatabaseURL(env).hostname, "127.0.0.1");
  for (const value of [undefined, "false", "TRUE", " true "]) {
    assert.throws(() => disposableDatabaseURL({ ...env, DUALLANE_GO_E2E_ALLOW_SCHEMA_CREATION: value }));
  }
  for (const value of [
    "postgres://test:test@db.example/duallane", "postgres://test:test@localhost/duallane",
    "postgres://test:test@127.0.0.1/postgres", "postgres://test:test@127.0.0.1/template1",
    "postgres://test:test@127.0.0.1/duallane?options=-c%20search_path=public",
    "postgres://test:test@127.0.0.1/duallane?search_path=public", "not-a-url"
  ]) {
    assert.throws(() => disposableDatabaseURL({ ...env, TEST_DATABASE_URL: value }), (error) => !error.message.includes(value));
  }
});

test("Go Workspace browser gate reuses real frontend tests without reusing servers", async () => {
  const config = await readFile(new URL("../../playwright.workspace-go.config.ts", import.meta.url), "utf8");
  const server = await readFile(new URL("../../e2e/support/go-workspace-server.mjs", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts["test:e2e:workspace-go"], "playwright test --config=playwright.workspace-go.config.ts");
  assert.match(config, /testMatch: "workspace\*\.spec\.ts"/);
  assert.match(config, /outputDir: "\.private-test-results\/workspace-go-browser"/);
  assert.equal((config.match(/reuseExistingServer: false/g) || []).length, 2);
  for (const setting of ["trace", "screenshot", "video"]) assert.match(config, new RegExp(`${setting}: "off"`));
  assert.match(server, /\["migrate", "workspace"\]/);
  assert.match(server, /searchParams\.set\("search_path", schema\)/);
  assert.match(server, /WORKSPACE_EMAIL_WORKER_ENABLED: "false"/);
  assert.match(server, /WORKSPACE_NTFY_WORKER_ENABLED: "false"/);
  assert.doesNotMatch(server, /\.\.\.process\.env|import.*createApp/);
});
