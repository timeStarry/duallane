import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMigrationFailureEvidence,
  createRehearsalSchemaName,
  loadCanonicalMigrationManifest,
  runSchemaCoexistence,
  toSafeSchemaCoexistenceError,
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

test("migration failure evidence rejects a wrong migration phase", () => {
  assert.throws(
    () => assertMigrationFailureEvidence(
      {
        timedOut: false,
        code: 1,
        stderr: "apply migration 031_workspace_presence_leases.sql failed: SQLSTATE 42703"
      },
      {
        migrationName: "033_workspace_command_result_finalization.sql",
        sqlState: "42701",
        conflictTerms: ["result_finalized_at"]
      }
    ),
    (error) => error.code === "DUALLANE_SCHEMA_COEXISTENCE_MIGRATION_EVIDENCE_FAILURE"
      && error.message === "schema coexistence migration failure evidence was not accepted"
  );
});

test("migration failure evidence rejects signal exits", () => {
  assert.throws(
    () => assertMigrationFailureEvidence(
      {
        timedOut: false,
        code: null,
        signal: "SIGTERM",
        stderr: "033_workspace_command_result_finalization.sql failed: SQLSTATE 42701 result_finalized_at"
      },
      {
        migrationName: "033_workspace_command_result_finalization.sql",
        sqlState: "42701",
        conflictTerms: ["result_finalized_at"]
      }
    ),
    (error) => error.code === "DUALLANE_SCHEMA_COEXISTENCE_MIGRATION_EVIDENCE_FAILURE"
  );
});

test("external provider errors are reduced to a fixed safe error", () => {
  const raw = new Error("GET https://user:token@example.test/?dsn=postgres://user:secret@example.test/db");
  const safe = toSafeSchemaCoexistenceError(raw, "provider");
  assert.deepEqual(
    { code: safe.code, message: safe.message },
    {
      code: "DUALLANE_SCHEMA_COEXISTENCE_PROVIDER_FAILURE",
      message: "schema coexistence provider command failed"
    }
  );
  assert.doesNotMatch(`${safe.code} ${safe.message}`, /token|secret|example\.test|postgres:\/\//i);
});

test("recognized safe labels never preserve provider error objects or metadata", () => {
  const raw = new Error("schema coexistence provider command failed", { cause: new Error("private-cause") });
  raw.code = "DUALLANE_SCHEMA_COEXISTENCE_PROVIDER_FAILURE";
  raw.providerDetail = "private-provider-detail";
  raw.stack = "private-provider-stack";
  const safe = toSafeSchemaCoexistenceError(raw);
  assert.notEqual(safe, raw);
  assert.equal(safe.code, raw.code);
  assert.equal(safe.message, raw.message);
  assert.equal(safe.cause, undefined);
  assert.equal(safe.providerDetail, undefined);
  assert.notEqual(safe.stack, raw.stack);
  assert.doesNotMatch(JSON.stringify(safe), /private-/);
});

test("expected migration failures require ordinary exit and the exact conflict", () => {
  const expected = { migrationName: "033_workspace_command_result_finalization.sql", sqlState: "42701", conflictTerms: ["result_finalized_at"] };
  for (const outcome of [
    { code: 1, signal: "SIGKILL", stderr: expected.migrationName },
    { code: 0, stderr: expected.migrationName },
    { code: 1, timedOut: true, stderr: expected.migrationName },
    { code: 1, stderr: "SQLSTATE 42701 unrelated_column" }
  ]) assert.throws(() => assertMigrationFailureEvidence(outcome, expected));
  assert.equal(assertMigrationFailureEvidence({ code: 1, stderr: `apply migration ${expected.migrationName}: failed` }, expected).evidence, "migration-name");
  assert.equal(assertMigrationFailureEvidence({ code: 1, stderr: "SQLSTATE 42701 result_finalized_at" }, expected).evidence, "sqlstate-conflict");
  const node031 = { migrationName: "031_workspace_presence_leases.sql", sqlState: "42703", conflictTerms: ['column "space_id" does not exist'] };
  assert.equal(assertMigrationFailureEvidence({ code: 1, stderr: 'error: column "space_id" does not exist; code: 42703' }, node031).evidence, "sqlstate-conflict");
  assert.throws(() => assertMigrationFailureEvidence({ code: 1, stderr: 'error: column "user_id" does not exist; code: 42703' }, node031));
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
