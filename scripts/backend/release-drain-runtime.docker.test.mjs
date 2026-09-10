import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRehearsalSchemaName,
  loadCanonicalMigrationManifest,
  validateRehearsalEnvironment,
} from "./schema-coexistence.mjs";
import { validateReport } from "../../deploy/production/release-drain-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const image = String(process.env.DUALLANE_DRAIN_TEST_IMAGE ?? "").trim();
const imageLabel = "com.duallane.release-drain-test";
const caseLabel = "com.duallane.release-drain-case";
const expectedImage = image;
const expectedEntrypoint = ["/usr/local/bin/duallane-release-check"];
const expectedCommand = ["--check-provider"];
const migrationEntrypoint = ["/usr/local/bin/duallane-migrate"];
const commandTimeoutMs = 20_000;
const migrationTimeoutMs = 60_000;
const migrationStatementTimeoutMs = 15_000;
const imageMigrationDirectory = "/app/migrations";

const require = createRequire(path.join(repoRoot, "package.json"));
const { Client } = require("pg");

function validateImage(value) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value ?? ""))) {
    throw new Error("DUALLANE_DRAIN_TEST_IMAGE must be an exact local sha256 image ID");
  }
  return value;
}

function validateTestDatabaseURL(environment = process.env) {
  const databaseURL = validateRehearsalEnvironment({
    ...environment,
    DUALLANE_SCHEMA_COEXISTENCE_ALLOW_SCHEMA_CREATION: "true",
  });
  if (databaseURL.hostname !== "127.0.0.1" || databaseURL.port !== "55439") {
    throw new Error("TEST_DATABASE_URL must target the task-owned 127.0.0.1:55439 PostgreSQL");
  }
  return databaseURL;
}

function quoteIdentifier(value) {
  const source = String(value);
  if (!source || source.length > 63 || source.includes("\0")) {
    throw new Error("release drain identifier is invalid");
  }
  return `"${source.replaceAll('"', '""')}"`;
}

function rootDatabaseURL(baseURL) {
  const databaseURL = new URL(baseURL);
  databaseURL.searchParams.set("options", `-c search_path=public -c statement_timeout=${migrationStatementTimeoutMs}`);
  databaseURL.searchParams.set("application_name", "duallane-release-drain-root");
  databaseURL.searchParams.set("connect_timeout", "5");
  return databaseURL.toString();
}

function scopedDatabaseURL(baseURL, schema, role) {
  if (!/^duallane_coexistence_[a-z0-9_]+$/.test(schema)) {
    throw new Error("release drain schema is not owned by this rehearsal");
  }
  const databaseURL = new URL(baseURL);
  databaseURL.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=${migrationStatementTimeoutMs}`);
  databaseURL.searchParams.set("application_name", `duallane-release-drain-${role}`);
  databaseURL.searchParams.set("connect_timeout", "5");
  return databaseURL.toString();
}

function invalidDatabaseURL(baseURL) {
  const databaseURL = new URL(baseURL);
  const databaseName = `duallane_release_drain_invalid_${randomUUID().replaceAll("-", "")}`;
  if (databaseName.length > 63) {
    throw new Error("release drain invalid database fixture identifier is too long");
  }
  databaseURL.pathname = `/${databaseName}`;
  databaseURL.searchParams.set("application_name", "duallane-release-drain-invalid");
  databaseURL.searchParams.set("connect_timeout", "5");
  return databaseURL.toString();
}

async function connect(databaseURL) {
  const client = new Client({
    connectionString: databaseURL.toString(),
    connectionTimeoutMillis: 5_000,
    statement_timeout: migrationStatementTimeoutMs,
    query_timeout: migrationStatementTimeoutMs + 5_000,
  });
  client.on("error", () => {});
  await client.connect();
  return client;
}

async function withClient(databaseURL, callback) {
  const client = await connect(databaseURL);
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function createOwnedSchema(databaseURL, schema) {
  const identifier = quoteIdentifier(schema);
  await withClient(rootDatabaseURL(databaseURL), async (client) => {
    await client.query(`CREATE SCHEMA ${identifier}`);
    const result = await client.query(`
      SELECT n.nspname = $1 AS name_matches,
             n.nspowner = role.oid AS owned_by_current_user
      FROM pg_namespace AS n
      CROSS JOIN pg_roles AS role
      WHERE n.nspname = $1 AND role.rolname = current_user
    `, [schema]);
    if (result.rowCount !== 1 || !result.rows[0].name_matches || !result.rows[0].owned_by_current_user) {
      throw new Error("new release drain schema is not owned by the current database identity");
    }
  });
}

async function dropOwnedSchema(databaseURL, schema) {
  const identifier = quoteIdentifier(schema);
  await withClient(rootDatabaseURL(databaseURL), async (client) => {
    const ownership = await client.query(`
      SELECT n.nspowner = role.oid AS owned_by_current_user
      FROM pg_namespace AS n
      CROSS JOIN pg_roles AS role
      WHERE n.nspname = $1 AND role.rolname = current_user
    `, [schema]);
    if (ownership.rowCount !== 1 || !ownership.rows[0].owned_by_current_user) {
      throw new Error("release drain cleanup refused an unowned schema");
    }
    await client.query(`DROP SCHEMA IF EXISTS ${identifier} CASCADE`);
    const remaining = await client.query("SELECT to_regnamespace($1) IS NULL AS absent", [schema]);
    if (remaining.rowCount !== 1 || !remaining.rows[0].absent) {
      throw new Error("release drain schema cleanup did not remove the owned schema");
    }
  });
}

async function seedReservedUpload(databaseURL) {
  await withClient(databaseURL, async (client) => {
    await client.query(`
      INSERT INTO attachments
        (id, space_id, uploader_id, conversation_id, visibility, status, file_name,
         mime_type, byte_size, upload_transfer_id, created_at)
      VALUES
        ('release-drain-attachment', 'release-cli-space', 'release-cli-user',
         'release-cli-conversation', 'private_staging', 'pending', 'fixture.txt',
         'text/plain', 4, 'release-drain-upload', NOW())
    `);
    await client.query(`
      INSERT INTO transfer_ledger
        (id, space_id, user_id, direction, byte_size, status, attachment_id,
         created_at, last_activity_at)
      VALUES
        ('release-drain-upload', 'release-cli-space', 'release-cli-user',
         'upload', 4, 'reserved', 'release-drain-attachment', NOW(), NOW())
    `);
  });
}

async function seedReleaseCheckBase(databaseURL) {
  await withClient(databaseURL, async (client) => {
    await client.query(`
      INSERT INTO users (id, github_login, display_name, kind, created_at, last_login_at)
      VALUES ('release-cli-user', 'release-cli-user', 'Release CLI', 'human', NOW(), NOW())
    `);
    await client.query(`
      INSERT INTO spaces (id, name, slug, created_by, created_at)
      VALUES ('release-cli-space', 'Release CLI', 'release-cli', 'release-cli-user', NOW())
    `);
    await client.query(`
      INSERT INTO space_members (space_id, user_id, role, joined_at)
      VALUES ('release-cli-space', 'release-cli-user', 'owner', NOW())
    `);
    await client.query(`
      INSERT INTO conversations (id, space_id, type, title, created_by, created_at)
      VALUES ('release-cli-conversation', 'release-cli-space', 'group', 'Release CLI', 'release-cli-user', NOW())
    `);
  });
}

async function fingerprintSchema(databaseURL, schema) {
  return withClient(databaseURL, async (client) => {
    const relations = await client.query(`
      SELECT c.relname, c.relkind
      FROM pg_class AS c
      INNER JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `, [schema]);
    const fingerprint = [];
    for (const relation of relations.rows) {
      const table = `${quoteIdentifier(schema)}.${quoteIdentifier(relation.relname)}`;
      const result = await client.query(`
        SELECT COUNT(*)::text AS row_count,
               md5(COALESCE(
                 string_agg(md5(row_to_json(t)::text), ',' ORDER BY md5(row_to_json(t)::text)),
                 ''
               )) AS row_digest
        FROM ${table} AS t
      `);
      fingerprint.push({
        name: relation.relname,
        kind: relation.relkind,
        rowCount: result.rows[0].row_count,
        rowDigest: result.rows[0].row_digest,
      });
    }
    return fingerprint;
  });
}

async function schemaIsAbsent(databaseURL, schema) {
  return withClient(rootDatabaseURL(databaseURL), async (client) => {
    const result = await client.query("SELECT to_regnamespace($1) IS NULL AS absent", [schema]);
    return result.rowCount === 1 && result.rows[0].absent === true;
  });
}

function dockerCommand(args, timeout = commandTimeoutMs) {
  return spawnSync("docker", args, {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: "utf8",
    timeout,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
}

function requireDockerSuccess(result, operation) {
  if (result.error || result.status !== 0) {
    throw new Error(`release drain Docker ${operation} failed`);
  }
}

function singleLineOutput(result, operation) {
  requireDockerSuccess(result, operation);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`release drain Docker ${operation} returned unexpected output`);
  }
  return lines[0];
}

function resolveContainerInspectionExpectations(runtime = {}) {
  return {
    entrypoint: runtime.entrypoint ?? expectedEntrypoint,
    command: Object.hasOwn(runtime, "command") ? runtime.command : expectedCommand,
  };
}

function inspectContainer(containerID, runID, caseName, runtime) {
  const { entrypoint, command } = resolveContainerInspectionExpectations(runtime);
  const result = dockerCommand(["inspect", containerID]);
  requireDockerSuccess(result, "container inspection");
  const source = result.stdout.trim();
  if (!source) {
    throw new Error("release drain container inspection returned no data");
  }
  let containers;
  try {
    containers = JSON.parse(source);
  } catch {
    throw new Error("release drain container inspection was not JSON");
  }
  if (!Array.isArray(containers) || containers.length !== 1 || !containers[0] || typeof containers[0] !== "object") {
    throw new Error("release drain container inspection returned an invalid container");
  }
  const container = containers[0];
  assert.equal(container.Id, containerID);
  assert.equal(container.Image, expectedImage);
  assert.equal(container.Config?.Image, expectedImage);
  assert.equal(container.Config?.Labels?.[imageLabel], runID);
  assert.equal(container.Config?.Labels?.[caseLabel], caseName);
  assert.equal(container.Config?.User, "65532:65532");
  assert.deepEqual(container.Config?.Entrypoint, entrypoint);
  if (command !== undefined) assert.deepEqual(container.Config?.Cmd, command);
  assert.equal(container.HostConfig?.ReadonlyRootfs, true);
  assert.equal(container.HostConfig?.NetworkMode, "host");
  assert.deepEqual(container.Mounts ?? [], []);
  assert.ok((container.HostConfig?.CapDrop ?? []).some((value) => String(value).toUpperCase() === "ALL"));
  assert.ok((container.HostConfig?.SecurityOpt ?? []).includes("no-new-privileges:true"));
  return container;
}

function parseJSONOnly(stdout, stderr, operation) {
  if (stderr.trim() !== "") {
    throw new Error(`release drain ${operation} wrote diagnostic output`);
  }
  const source = stdout.trim();
  if (!source || source.includes("postgres://") || source.includes("DATABASE_URL")) {
    throw new Error(`release drain ${operation} emitted unsafe or empty output`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`release drain ${operation} did not emit one JSON value`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`release drain ${operation} emitted a non-object JSON value`);
  }
  return value;
}

function listOwnedContainerIDs(runID, caseName) {
  const result = dockerCommand([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    `label=${imageLabel}=${runID}`,
    "--filter",
    `label=${caseLabel}=${caseName}`,
    "--format",
    "{{.ID}}",
  ]);
  requireDockerSuccess(result, "owned container lookup");
  const ids = result.stdout.trim() === ""
    ? []
    : result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (ids.some((id) => !/^[0-9a-f]{64}$/.test(id))) {
    throw new Error("release drain Docker returned an invalid owned container ID");
  }
  return ids;
}

async function removeOwnedContainer(containerID, runID, caseName, runtime) {
  inspectContainer(containerID, runID, caseName, runtime);
  const removed = dockerCommand(["rm", "--force", containerID]);
  requireDockerSuccess(removed, "owned container removal");
  const remaining = dockerCommand(["inspect", containerID]);
  if (remaining.error) {
    throw new Error("release drain owned container removal could not be verified");
  }
  if (remaining.status === 0) {
    throw new Error("release drain owned container remained after removal");
  }
}

async function cleanupOwnedContainer(containerID, runID, caseName, runtime) {
  let candidateID = containerID;
  if (!candidateID) {
    const candidates = listOwnedContainerIDs(runID, caseName);
    if (candidates.length > 1) {
      throw new Error("release drain cleanup found multiple owned containers");
    }
    candidateID = candidates[0];
  }
  if (candidateID) await removeOwnedContainer(candidateID, runID, caseName, runtime);
}

function migrationContainerArguments(databaseURL, containerName, runID, caseName, imageID = expectedImage) {
  return [
    "create",
    "--pull=never",
    "--name", containerName,
    "--label", `${imageLabel}=${runID}`,
    "--label", `${caseLabel}=${caseName}`,
    "--user", "65532:65532",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges:true",
    "--network", "host",
    "--env", `DATABASE_URL=${databaseURL}`,
    "--env", `DUALLANE_MIGRATIONS_DIR=${imageMigrationDirectory}`,
    "--entrypoint", migrationEntrypoint[0],
    imageID,
  ];
}

async function assertImageCanonicalSQL(containerID, manifest) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "duallane-release-drain-image-sql-"));
  try {
    const copied = dockerCommand([
      "cp",
      `${containerID}:${imageMigrationDirectory}/.`,
      temporaryDirectory,
    ]);
    requireDockerSuccess(copied, "migration SQL copy");

    const entries = await readdir(temporaryDirectory, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
    const canonicalNames = manifest.files.map((file) => file.name);
    assert.deepEqual(names, canonicalNames, "Go image migration names differ from canonical SQL");
    for (const file of manifest.files) {
      const entry = entries.find((candidate) => candidate.name === file.name);
      assert.ok(entry?.isFile(), `Go image migration ${file.name} is not a regular file`);
      const contents = await readFile(path.join(temporaryDirectory, file.name));
      const sha256 = createHash("sha256").update(contents).digest("hex");
      assert.equal(sha256, file.sha256, `Go image migration ${file.name} differs from canonical SQL`);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runGoMigration(databaseURL, schema, manifest) {
  const runID = randomUUID();
  const caseName = "go-migrate";
  const containerName = `duallane-release-drain-${runID.slice(0, 12)}-${caseName}`;
  const runtime = { entrypoint: migrationEntrypoint, command: undefined };
  let containerID;
  let primaryError;
  try {
    const create = dockerCommand(migrationContainerArguments(
      scopedDatabaseURL(databaseURL, schema, "migrate"),
      containerName,
      runID,
      caseName,
    ));
    containerID = singleLineOutput(create, "migration container creation");
    if (!/^[0-9a-f]{64}$/.test(containerID)) {
      throw new Error("release drain Docker returned an invalid migration container ID");
    }
    inspectContainer(containerID, runID, caseName, runtime);
    await assertImageCanonicalSQL(containerID, manifest);

    const started = dockerCommand(["start", containerID]);
    requireDockerSuccess(started, "migration container start");
    const waited = dockerCommand(["wait", containerID], migrationTimeoutMs);
    const exitCodeText = singleLineOutput(waited, "migration container wait");
    if (!/^\d+$/.test(exitCodeText)) {
      throw new Error("release drain Docker returned an invalid migration exit status");
    }
    const exitCode = Number(exitCodeText);
    const container = inspectContainer(containerID, runID, caseName, runtime);
    assert.equal(container.State?.ExitCode, exitCode);
    if (exitCode !== 0) throw new Error("release drain Go migration failed");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanupOwnedContainer(containerID, runID, caseName, runtime);
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError([primaryError, cleanupError], "release drain migration and cleanup failed");
      }
      throw cleanupError;
    }
  }

  const scopedURL = scopedDatabaseURL(databaseURL, schema, "migrate");
  const names = await withClient(scopedURL, async (client) => {
    const result = await client.query("SELECT name FROM schema_migrations ORDER BY name");
    return result.rows.map((row) => row.name);
  });
  assert.deepEqual(names, manifest.files.map((file) => file.name), "Go image did not apply the canonical migration set");
  return scopedURL;
}

async function runContainer(databaseURL, caseName, runID) {
  const containerName = `duallane-release-drain-${runID.slice(0, 12)}-${caseName}`;
  let containerID;
  let primaryError;
  try {
    const create = dockerCommand([
      "create",
      "--pull=never",
      "--name", containerName,
      "--label", `${imageLabel}=${runID}`,
      "--label", `${caseLabel}=${caseName}`,
      "--user", "65532:65532",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges:true",
      "--network", "host",
      "--env", `DATABASE_URL=${databaseURL}`,
      "--env", "WORKSPACE_STORAGE_DRIVER=local",
      "--entrypoint", expectedEntrypoint[0],
      expectedImage,
      ...expectedCommand,
    ]);
    containerID = singleLineOutput(create, "container creation");
    if (!/^[0-9a-f]{64}$/.test(containerID)) {
      throw new Error("release drain Docker returned an invalid container ID");
    }
    inspectContainer(containerID, runID, caseName);
    const started = dockerCommand(["start", containerID]);
    requireDockerSuccess(started, "owned container start");
    const waited = dockerCommand(["wait", containerID], commandTimeoutMs);
    const exitCodeText = singleLineOutput(waited, "owned container wait");
    if (!/^\d+$/.test(exitCodeText)) {
      throw new Error("release drain Docker returned an invalid exit status");
    }
    const exitCode = Number(exitCodeText);
    const logs = dockerCommand(["logs", containerID]);
    requireDockerSuccess(logs, "owned container log read");
    const container = inspectContainer(containerID, runID, caseName);
    assert.equal(container.State?.ExitCode, exitCode);
    const report = parseJSONOnly(logs.stdout, logs.stderr, caseName);
    return { exitCode, report };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanupOwnedContainer(containerID, runID, caseName);
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError([primaryError, cleanupError], "release drain case and cleanup failed");
      }
      throw cleanupError;
    }
  }
}

function assertSnapshotIsReadOnly(report) {
  assert.equal(report.schema, "duallane.release-check/v1");
  assert.equal(report.scope, "database_and_provider_snapshot");
  assert.ok(report.snapshot && typeof report.snapshot === "object");
  assert.equal(report.snapshot.readOnly, true);
  assert.equal(report.snapshot.writers?.status, "not_proven");
  assert.equal(report.snapshot.provider?.status, "not_checked");
}

function assertLocalReady(result) {
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, "ready");
  assertSnapshotIsReadOnly(result.report);
  assert.deepEqual(result.report.snapshot.blockers, []);
  assert.equal(result.report.provider?.driver, "local");
  assert.equal(result.report.provider?.status, "not_applicable");
  assert.equal(result.report.provider?.readOnly, true);
  assert.equal(validateReport(result.report, "local"), result.report);
  assert.throws(() => validateReport(result.report, "s3"), /report_provider_driver_mismatch/);
}

function assertReservedUploadBlocked(result) {
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.status, "blocked");
  assertSnapshotIsReadOnly(result.report);
  assert.deepEqual(result.report.snapshot.blockers, [{ code: "upload_reserved", count: 1 }]);
  assert.equal(result.report.provider?.status, "not_checked");
  assert.equal(result.report.provider?.code, "database_not_ready");
  assert.equal(result.report.provider?.readOnly, true);
}

function assertMissingSchemaBlocked(result) {
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.schema, "duallane.release-check/v1");
  assert.equal(result.report.scope, "database_and_provider_snapshot");
  assert.equal(result.report.status, "blocked");
  assertSnapshotIsReadOnly(result.report);
  assert.deepEqual(result.report.snapshot.blockers, [{ code: "schema_incompatible", count: 22 }]);
  assert.deepEqual(result.report.provider, {
    driver: "unknown",
    status: "not_checked",
    code: "database_not_ready",
    readOnly: true,
  });
}

function assertInvalidDatabaseFailsSafely(result) {
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.schema, "duallane.release-check/v1");
  assert.equal(result.report.scope, "database_and_provider_snapshot");
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.errorCode, "snapshot_failed");
  assert.equal("provider" in result.report, false);
  if (result.report.snapshot) assert.equal(result.report.snapshot.readOnly, true);
}

test("release drain runtime uses the exact read-only CLI image against isolated PostgreSQL state", {
  skip: image ? false : "DUALLANE_DRAIN_TEST_IMAGE is not set; Docker gate is intentionally SKIP",
  timeout: 180_000,
}, async (t) => {
  if (process.platform !== "linux") {
    t.skip("the disposable Docker gate is Linux-only");
    return;
  }
  assert.match(process.versions.node, /^22\./, "the Docker gate requires Node 22");
  validateImage(image);
  const databaseURL = validateTestDatabaseURL(process.env);
  const imageInspection = dockerCommand(["image", "inspect", expectedImage, "--format", "{{.Id}}"]);
  assert.equal(singleLineOutput(imageInspection, "image inspection"), expectedImage);

  const manifest = await loadCanonicalMigrationManifest();
  const schema = createRehearsalSchemaName();
  const missingSchema = createRehearsalSchemaName();
  await createOwnedSchema(databaseURL, schema);
  try {
    const scopedURL = await runGoMigration(databaseURL, schema, manifest);
    await seedReleaseCheckBase(scopedURL);

    await t.test("local storage is ready with exit 0", async () => {
      const before = await fingerprintSchema(databaseURL, schema);
      const result = await runContainer(scopedURL, "local-ready", randomUUID());
      assertLocalReady(result);
      const after = await fingerprintSchema(databaseURL, schema);
      assert.deepEqual(after, before, "local readiness observation changed PostgreSQL state");
    });

    await seedReservedUpload(scopedURL);
    await t.test("reserved upload blocks with exit 2", async () => {
      const before = await fingerprintSchema(databaseURL, schema);
      const result = await runContainer(scopedURL, "reserved-upload", randomUUID());
      assertReservedUploadBlocked(result);
      const after = await fingerprintSchema(databaseURL, schema);
      assert.deepEqual(after, before, "reserved-upload observation changed PostgreSQL state");
    });

    assert.equal(await schemaIsAbsent(databaseURL, missingSchema), true);
    await t.test("missing schema blocks with schema_incompatible and exit 2", async () => {
      const missingURL = scopedDatabaseURL(databaseURL, missingSchema, "missing");
      const result = await runContainer(missingURL, "missing-schema", randomUUID());
      assertMissingSchemaBlocked(result);
      assert.equal(await schemaIsAbsent(databaseURL, missingSchema), true);
    });

    await t.test("invalid synthetic database URL fails with snapshot_failed and exit 1", async () => {
      const before = await fingerprintSchema(databaseURL, schema);
      const result = await runContainer(invalidDatabaseURL(databaseURL), "invalid-database", randomUUID());
      assertInvalidDatabaseFailsSafely(result);
      const after = await fingerprintSchema(databaseURL, schema);
      assert.deepEqual(after, before, "invalid-database observation changed PostgreSQL state");
    });
  } finally {
    await dropOwnedSchema(databaseURL, schema);
  }
});

test("release drain inputs reject mutable images and non-task PostgreSQL targets", () => {
  assert.throws(() => validateImage("duallane-workspace:latest"), /exact local sha256 image ID/);
  assert.throws(() => validateImage(`sha256:${"A".repeat(64)}`), /exact local sha256 image ID/);
  assert.throws(() => validateTestDatabaseURL({
    TEST_DATABASE_URL: "postgres://test:test@example.invalid:55439/duallane?sslmode=disable",
  }), /loopback/);
  assert.throws(() => validateTestDatabaseURL({
    TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:5432/duallane?sslmode=disable",
  }), /task-owned 127\.0\.0\.1:55439/);
  assert.throws(() => validateTestDatabaseURL({
    TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:55439/duallane?sslmode=disable&options=-c%20search_path%3Dpublic",
  }), /loopback disposable database/);
});

test("release drain migration stays on the exact Go image entrypoint", () => {
  const runID = randomUUID();
  const args = migrationContainerArguments(
    "redacted-test-database-url",
    "duallane-release-drain-test-migrate",
    runID,
    "go-migrate",
    `sha256:${"a".repeat(64)}`,
  );
  assert.equal(args[args.indexOf("--entrypoint") + 1], "/usr/local/bin/duallane-migrate");
  assert.ok(args.includes(`${imageLabel}=${runID}`));
  assert.ok(args.includes("com.duallane.release-drain-case=go-migrate"));
  assert.ok(args.includes("DUALLANE_MIGRATIONS_DIR=/app/migrations"));
  assert.equal(args.at(-1), `sha256:${"a".repeat(64)}`);
});

test("release drain migration inspection does not inherit the release-check command", () => {
  const releaseCheck = resolveContainerInspectionExpectations();
  const migration = resolveContainerInspectionExpectations({
    entrypoint: migrationEntrypoint,
    command: undefined,
  });
  assert.deepEqual(releaseCheck.entrypoint, expectedEntrypoint);
  assert.deepEqual(releaseCheck.command, expectedCommand);
  assert.deepEqual(migration.entrypoint, migrationEntrypoint);
  assert.equal(migration.command, undefined);
});
