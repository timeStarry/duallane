import assert from "node:assert/strict";
import test from "node:test";
import {
  createRehearsalSchemaName,
  loadCanonicalMigrationManifest,
  runSchemaCoexistence,
  validateRehearsalEnvironment
} from "./schema-coexistence.mjs";

test("schema coexistence requires exact opt-in and an explicit loopback test URL", () => {
  const valid = {
    DUALLANE_SCHEMA_COEXISTENCE_ALLOW_SCHEMA_CREATION: "true",
    TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:55439/duallane?sslmode=disable"
  };
  assert.equal(validateRehearsalEnvironment(valid).hostname, "127.0.0.1");
  for (const value of [undefined, "false", "TRUE", " true "]) {
    assert.throws(() => validateRehearsalEnvironment({ ...valid, DUALLANE_SCHEMA_COEXISTENCE_ALLOW_SCHEMA_CREATION: value }));
  }
  for (const value of [
    "postgres://test:test@db.example/duallane",
    "postgres://test:test@localhost/duallane",
    "postgres://test:test@127.0.0.1/postgres",
    "postgres://test:test@127.0.0.1/template1",
    "postgres://test:test@127.0.0.1/duallane?search_path=public",
    "not-a-url"
  ]) {
    assert.throws(() => validateRehearsalEnvironment({ ...valid, TEST_DATABASE_URL: value }));
  }
});

test("rehearsal schema names are generated and constrained locally", () => {
  const first = createRehearsalSchemaName();
  const second = createRehearsalSchemaName();
  assert.notEqual(first, second);
  assert.match(first, /^duallane_coexistence_[a-z0-9_]+$/);
  assert.ok(first.length <= 63);
});

test("manifest includes the current 029 through dynamic latest SQL owners", async () => {
  const manifest = await loadCanonicalMigrationManifest();
  assert.ok(manifest.manifestSha256.match(/^[a-f0-9]{64}$/));
  for (const prefix of ["029_", "030_", "031_", "032_", "033_"]) {
    assert.equal(manifest.files.filter((file) => file.name.startsWith(prefix)).length, 1);
  }
});

test("PostgreSQL rehearsal is opt-in and executes the real Node/Go owners", { timeout: 600_000 }, async (t) => {
  if (process.env.DUALLANE_SCHEMA_COEXISTENCE_RUN_PG !== "true") {
    t.skip("set DUALLANE_SCHEMA_COEXISTENCE_RUN_PG=true with the explicit rehearsal gate to run PostgreSQL");
    return;
  }
  const report = await runSchemaCoexistence();
  assert.equal(report.scenarios.length, 6);
  assert.equal(report.scenarios[0].advisoryLockWait, true);
  assert.equal(report.scenarios[2].partialObjects, false);
  assert.equal(report.scenarios[3].name, "Go 029 -> Go 030 -> Go latest -> Node no-op");
  assert.equal(report.scenarios[3].goIncremental, true);
  assert.equal(report.scenarios[3].nodeNoop, true);
  assert.deepEqual(report.scenarios[3].verification, {
    history: true,
    seed: true,
    schema: true,
    readWrite: true
  });
  assert.equal(report.scenarios[4].name, "Go 030 -> Go latest -> Node no-op");
  assert.equal(report.scenarios[4].goIncremental, true);
  assert.equal(report.scenarios[4].nodeNoop, true);
  assert.equal(report.scenarios[5].expectedFailure, true);
  assert.equal(report.scenarios[5].transactionRollback, true);
  assert.equal(report.scenarios[5].lateBatchRollback, true);
  assert.equal(report.scenarios[5].retrySucceeded, true);
  assert.equal(report.scenarios[5].partialObjects, false);
});
