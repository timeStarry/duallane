import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedProcess, stopOwnedProcess, waitForExit } from "../../e2e/support/owned-process.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const backendRoot = path.join(repoRoot, "apps/backend");
const migrationRoot = path.join(repoRoot, "apps/web/server/migrations");
const migrationNamePattern = /^[0-9]{3}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const schemaNamePattern = /^duallane_coexistence_[a-z0-9_]+$/;
const advisoryLockIdentity = "duallane:schema-migrations";
const allowSchemaCreationVariable = "DUALLANE_SCHEMA_COEXISTENCE_ALLOW_SCHEMA_CREATION";
const migrationTimeoutMs = 120_000;
const lockWaitTimeoutMs = 10_000;
const safeErrorDefinitions = Object.freeze({
  provider: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_PROVIDER_FAILURE",
    message: "schema coexistence provider command failed"
  }),
  migrationEvidence: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_MIGRATION_EVIDENCE_FAILURE",
    message: "schema coexistence migration failure evidence was not accepted"
  }),
  rehearsal: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_REHEARSAL_FAILURE",
    message: "schema coexistence rehearsal failed"
  }),
  cleanup: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_CLEANUP_FAILURE",
    message: "schema coexistence cleanup failed"
  }),
  combined: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_REHEARSAL_CLEANUP_FAILURE",
    message: "schema coexistence rehearsal and cleanup failed"
  })
});
const migrationFailureFingerprints = Object.freeze({
  31: Object.freeze({
    sqlState: "42703",
    // Node reports the first index's missing column, without a migration
    // filename or table name. This is the exact synthetic 031 conflict.
    conflictTerms: ['column "space_id" does not exist']
  }),
  33: Object.freeze({
    sqlState: "42701",
    conflictTerms: ["result_finalized_at"]
  })
});

const require = createRequire(path.join(repoRoot, "apps/web/package.json"));
const { Client } = require("pg");

function createSafeError(kind) {
  const definition = safeErrorDefinitions[kind] || safeErrorDefinitions.rehearsal;
  const error = new Error(definition.message);
  error.code = definition.code;
  return error;
}

export function toSafeSchemaCoexistenceError(error, kind = "rehearsal") {
  const knownKind = Object.keys(safeErrorDefinitions).find((key) => (
    error?.code === safeErrorDefinitions[key].code && error?.message === safeErrorDefinitions[key].message
  ));
  // Rebuild even recognized errors: a provider may attach a cause, custom
  // properties or a credential-bearing stack to an otherwise safe label.
  return createSafeError(knownKind ?? kind);
}

export function validateRehearsalEnvironment(environment = process.env) {
  if (environment[allowSchemaCreationVariable] !== "true") {
    throw new Error(`${allowSchemaCreationVariable}=true is required for disposable schema rehearsal`);
  }

  const rawURL = String(environment.TEST_DATABASE_URL ?? "").trim();
  let databaseURL;
  try {
    databaseURL = new URL(rawURL);
  } catch {
    throw new Error("TEST_DATABASE_URL must be an explicit loopback PostgreSQL URL");
  }
  const unsafeDatabase = !["postgres:", "postgresql:"].includes(databaseURL.protocol)
    || !["127.0.0.1", "[::1]"].includes(databaseURL.hostname)
    || !databaseURL.pathname
    || ["/", "/postgres", "/template0", "/template1"].includes(databaseURL.pathname)
    || [...databaseURL.searchParams.keys()].some((key) => key !== "sslmode")
    || databaseURL.hash !== "";
  if (unsafeDatabase) {
    throw new Error("TEST_DATABASE_URL must target an explicit loopback disposable database without runtime overrides");
  }
  return databaseURL;
}

export function createRehearsalSchemaName() {
  const schema = `duallane_coexistence_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!schemaNamePattern.test(schema) || schema.length > 63) {
    throw new Error("generated rehearsal schema name is invalid");
  }
  return schema;
}

export async function loadCanonicalMigrationManifest(directory = migrationRoot) {
  const names = (await readdir(directory))
    .filter((name) => migrationNamePattern.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0 || !names.some((name) => name.startsWith("029_"))
    || !names.some((name) => name.startsWith("030_"))
    || !names.some((name) => name.startsWith("031_"))
    || !names.some((name) => name.startsWith("032_"))
    || !names.some((name) => name.startsWith("033_"))) {
    throw new Error("canonical migrations 029 through 033 are required for schema coexistence rehearsal");
  }

  const files = [];
  for (const name of names) {
    const contents = await readFile(path.join(directory, name));
    files.push({
      name,
      number: Number(name.slice(0, 3)),
      sha256: createHash("sha256").update(contents).digest("hex")
    });
  }
  const manifestSha256 = createHash("sha256")
    .update(files.map((file) => `${file.name}:${file.sha256}`).join("\n"))
    .digest("hex");
  return { files, manifestSha256 };
}

function migrationNamesThrough(manifest, maximumNumber) {
  return manifest.files.filter((file) => file.number <= maximumNumber).map((file) => file.name);
}

function migrationNameForNumber(manifest, number) {
  const matches = manifest.files.filter((file) => file.number === number);
  if (matches.length !== 1) throw createSafeError("migrationEvidence");
  return matches[0].name;
}

export function assertMigrationFailureEvidence(outcome, expected) {
  if (!outcome || outcome.timedOut || outcome.signal || !Number.isInteger(outcome.code) || outcome.code <= 0) {
    throw createSafeError("migrationEvidence");
  }

  const providerText = `${String(outcome.stderr ?? "")}\n${String(outcome.stdout ?? "")}`;
  const migrationMatched = typeof expected?.migrationName === "string"
    && providerText.includes(expected.migrationName);
  const sqlStateMatched = typeof expected?.sqlState === "string"
    && new RegExp(`\\b${expected.sqlState}\\b`).test(providerText);
  const conflictMatched = Array.isArray(expected?.conflictTerms)
    && expected.conflictTerms.length > 0
    && expected.conflictTerms.every((term) => providerText.includes(term));
  if (!migrationMatched && !(sqlStateMatched && conflictMatched)) {
    throw createSafeError("migrationEvidence");
  }
  return Object.freeze({
    normalNonZeroExit: true,
    evidence: migrationMatched ? "migration-name" : "sqlstate-conflict"
  });
}

async function createMigrationSubset(directory, manifest, maximumNumber) {
  const subsetDirectory = path.join(directory, `migrations-${maximumNumber}`);
  await mkdir(subsetDirectory, { recursive: true });
  for (const file of manifest.files) {
    if (file.number <= maximumNumber) {
      await copyFile(path.join(migrationRoot, file.name), path.join(subsetDirectory, file.name));
    }
  }
  return subsetDirectory;
}

function quoteIdentifier(identifier) {
  if (!schemaNamePattern.test(identifier)) throw new Error("refusing an unowned schema identifier");
  return `"${identifier}"`;
}

function rootDatabaseURL(baseURL) {
  const databaseURL = new URL(baseURL);
  databaseURL.searchParams.set("search_path", "public");
  databaseURL.searchParams.set("options", "-c search_path=public");
  databaseURL.searchParams.set("application_name", "duallane-schema-coexistence-cleanup");
  return databaseURL.toString();
}

function scopedDatabaseURL(baseURL, schema, owner) {
  if (!schemaNamePattern.test(schema)) throw new Error("refusing an invalid scoped schema");
  const databaseURL = new URL(baseURL);
  databaseURL.searchParams.set("search_path", schema);
  databaseURL.searchParams.set("options", `-c search_path=${schema}`);
  databaseURL.searchParams.set("application_name", `duallane-schema-coexistence-${owner}-${schema.slice(-8)}`);
  return databaseURL.toString();
}

function safeEnvironment(overrides = {}) {
  const environment = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot", "LANG", "LC_ALL", "GOPATH", "GOMODCACHE", "GOCACHE"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return { ...environment, ...overrides };
}

function goEnvironment(databaseURL) {
  return safeEnvironment({
    DATABASE_URL: databaseURL,
    CGO_ENABLED: "1",
    GOWORK: "off",
    GOMAXPROCS: "2",
    GOPROXY: process.env.GOPROXY || "https://goproxy.cn,direct"
  });
}

function nodeEnvironment(databaseURL) {
  return safeEnvironment({
    DATABASE_URL: databaseURL,
    DATABASE_POOL_MAX: "1",
    NODE_ENV: "test"
  });
}

function redactProcessText(value) {
  return String(value ?? "")
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, "[redacted-dsn]")
    .replace(/password=[^&\s]+/gi, "password=[redacted]");
}

function startOwnedCommand(command, args, options, timeoutMs, activeProcesses) {
  const child = spawnOwnedProcess(command, args, options);
  activeProcesses.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

  const promise = (async () => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopOwnedProcess(child, 1_000).catch(() => {});
    }, timeoutMs);
    try {
      const result = await waitForExit(child);
      return {
        ...result,
        timedOut,
        stdout: redactProcessText(stdout).trim(),
        stderr: redactProcessText(stderr).trim()
      };
    } finally {
      clearTimeout(timer);
      activeProcesses.delete(child);
      await stopOwnedProcess(child, 50).catch(() => {});
    }
  })();
  return { child, promise };
}

async function runOwnedCommand(command, args, options, timeoutMs, activeProcesses) {
  try {
    const outcome = await startOwnedCommand(command, args, options, timeoutMs, activeProcesses).promise;
    if (outcome.timedOut || outcome.code !== 0) {
      throw createSafeError("provider");
    }
    return outcome;
  } catch (error) {
    throw toSafeSchemaCoexistenceError(error, "provider");
  }
}

async function connect(databaseURL) {
  const client = new Client({
    connectionString: databaseURL,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000
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

async function createOwnedSchema(databaseURL, schemaRecord) {
  const schema = schemaRecord.name;
  const identifier = quoteIdentifier(schema);
  await withClient(rootDatabaseURL(databaseURL), async (client) => {
    await client.query(`CREATE SCHEMA ${identifier}`);
    schemaRecord.created = true;
    const result = await client.query(`
      SELECT n.nspname = $1 AS name_matches,
             n.nspowner = role.oid AS owned_by_current_user
      FROM pg_namespace AS n
      CROSS JOIN pg_roles AS role
      WHERE n.nspname = $1 AND role.rolname = current_user
    `, [schema]);
    if (result.rowCount !== 1 || !result.rows[0].name_matches || !result.rows[0].owned_by_current_user) {
      throw new Error("new rehearsal schema is not owned by the current database identity");
    }
  });
}

async function dropOwnedSchema(databaseURL, schema) {
  const identifier = quoteIdentifier(schema);
  await withClient(rootDatabaseURL(databaseURL), async (client) => {
    const result = await client.query(`
      SELECT n.nspowner = role.oid AS owned_by_current_user
      FROM pg_namespace AS n
      CROSS JOIN pg_roles AS role
      WHERE n.nspname = $1 AND role.rolname = current_user
    `, [schema]);
    if (result.rowCount === 0) return;
    if (!result.rows[0].owned_by_current_user) {
      throw new Error("refusing to drop a rehearsal schema not owned by the current database identity");
    }
    await client.query(`DROP SCHEMA IF EXISTS ${identifier} CASCADE`);
  });
}

async function readHistory(client) {
  const result = await client.query("SELECT name FROM schema_migrations ORDER BY name");
  return result.rows.map((row) => row.name);
}

async function assertHistory(databaseURL, expected, label) {
  await withClient(databaseURL, async (client) => {
    let actual;
    try {
      actual = await readHistory(client);
    } catch (error) {
      const context = await client.query("SELECT current_schema() AS schema, current_setting('search_path') AS search_path");
      throw new Error(`${label} could not read migration history in ${context.rows[0].schema} (${context.rows[0].search_path}): ${error.code || "query failed"}`);
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${label} migration history mismatch: expected ${expected.length}, got ${actual.length}`);
    }
  });
}

async function readMigrationSnapshot(databaseURL) {
  return withClient(databaseURL, async (client) => {
    const result = await client.query(`
      SELECT name, applied_at::text AS applied_at
      FROM schema_migrations
      ORDER BY name
    `);
    return result.rows.map((row) => ({ name: row.name, appliedAt: row.applied_at }));
  });
}

async function assertMigrationSnapshotUnchanged(databaseURL, expected, label) {
  const actual = await readMigrationSnapshot(databaseURL);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} changed migration history`);
  }
}

function assertGoMigrationCount(outcome, expectedApplied, expectedDiscovered, label) {
  const expectedOutput = `Applied ${expectedApplied} migration(s); discovered ${expectedDiscovered}.`;
  if (outcome.timedOut || outcome.code !== 0 || outcome.stdout !== expectedOutput) {
    throw new Error(`${label} returned an unexpected migration result`);
  }
}

async function assertNodeNoop(databaseURL, outcome, before, label) {
  if (outcome.timedOut || outcome.code !== 0) {
    throw new Error(`${label} did not complete successfully`);
  }
  await assertMigrationSnapshotUnchanged(databaseURL, before, label);
}

async function assertMigrationContract(databaseURL, label) {
  await withClient(databaseURL, async (client) => {
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'schema_migrations'
      ORDER BY ordinal_position
    `);
    const actual = result.rows.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`);
    const expected = ["name:text:NO", "applied_at:timestamp with time zone:NO"];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${label} schema_migrations contract mismatch`);
    }
  });
}

async function assertSeed(databaseURL, label) {
  await withClient(databaseURL, async (client) => {
    const users = await client.query(`
      SELECT COUNT(*)::int AS count FROM users
      WHERE id = ANY($1::text[])
    `, [["usr_owner", "usr_system_beacon", "usr_system_echo"]]);
    if (users.rows[0].count !== 3) throw new Error(`${label} seed users are not exactly once`);

    const members = await client.query(`
      SELECT COUNT(*)::int AS count FROM space_members
      WHERE space_id = $1 AND user_id = ANY($2::text[])
    `, ["spc_default", ["usr_owner", "usr_system_beacon", "usr_system_echo"]]);
    if (members.rows[0].count !== 3) throw new Error(`${label} seed memberships are not exactly once`);

    const event = await client.query("SELECT COUNT(*)::int AS count FROM workspace_events WHERE id = $1", ["evt_seed_owner"]);
    if (event.rows[0].count !== 1) throw new Error(`${label} seed event is not exactly once`);

    const audit = await client.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE id = $1", ["aud_seed_owner"]);
    if (audit.rows[0].count !== 1) throw new Error(`${label} seed audit is not exactly once`);

    const cursor = await client.query("SELECT next_seq::int AS next_seq FROM workspace_event_cursors WHERE space_id = $1", ["spc_default"]);
    if (cursor.rowCount !== 1 || cursor.rows[0].next_seq !== 2) throw new Error(`${label} seed event cursor is incorrect`);
  });
}

async function assertCurrentSchema(databaseURL, label) {
  await withClient(databaseURL, async (client) => {
    for (const relation of [
      "workspace_agent_bot_setup_sessions",
      "workspace_presence_leases",
      "workspace_storage_operator_runs",
      "workspace_storage_operator_items"
    ]) {
      const result = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [relation]);
      if (!result.rows[0].present) throw new Error(`${label} relation ${relation} is missing`);
    }

    const functionResult = await client.query("SELECT to_regprocedure($1) IS NOT NULL AS present", ["notify_duallane_workspace_event()"]);
    if (!functionResult.rows[0].present) throw new Error(`${label} workspace event notification function is missing`);
    const triggerResult = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'workspace_events_notify_insert' AND NOT tgisinternal
      ) AS present
    `);
    if (!triggerResult.rows[0].present) throw new Error(`${label} workspace event notification trigger is missing`);

    const finalizationResult = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'workspace_command_runs'
          AND column_name = 'result_finalized_at'
      ) AS present
    `);
    if (!finalizationResult.rows[0].present) throw new Error(`${label} command result finalization column is missing`);
  });
}

async function assertWorkspaceReadWrite(databaseURL) {
  const connectionID = `schema-coexistence-${randomUUID().replaceAll("-", "")}`;
  await withClient(databaseURL, async (client) => {
    let inserted = false;
    try {
      const created = await client.query(`
        INSERT INTO workspace_presence_leases (
          space_id, user_id, connection_id, lease_until
        ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '1 minute')
        RETURNING connection_id
      `, ["spc_default", "usr_owner", connectionID]);
      inserted = true;
      if (created.rowCount !== 1 || created.rows[0].connection_id !== connectionID) {
        throw new Error("Workspace synthetic presence write returned an unexpected row");
      }
      const read = await client.query(
        "SELECT connection_id FROM workspace_presence_leases WHERE space_id = $1 AND user_id = $2 AND connection_id = $3",
        ["spc_default", "usr_owner", connectionID]
      );
      if (read.rowCount !== 1 || read.rows[0].connection_id !== connectionID) {
        throw new Error("Workspace synthetic presence read did not observe its write");
      }
    } finally {
      if (inserted) {
        await client.query(
          "DELETE FROM workspace_presence_leases WHERE space_id = $1 AND user_id = $2 AND connection_id = $3",
          ["spc_default", "usr_owner", connectionID]
        );
      }
    }
  });
}

async function assertNoLatestObjects(databaseURL, label, finalizationSentinel = false) {
  await withClient(databaseURL, async (client) => {
    for (const relation of [
      "workspace_presence_user_expiry_idx",
      "workspace_presence_expiry_idx",
      "workspace_storage_operator_runs",
      "workspace_storage_operator_items",
      ...(finalizationSentinel ? ["workspace_presence_leases"] : [])
    ]) {
      const result = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [relation]);
      if (result.rows[0].present) throw new Error(`${label} left relation ${relation}`);
    }
    const finalizationResult = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'workspace_command_runs'
          AND column_name = 'result_finalized_at'
      ) AS present
    `);
    if (finalizationResult.rows[0].present !== finalizationSentinel) {
      throw new Error(`${label} changed migration 033 sentinel state`);
    }
  });
}

async function assertUpgradeSentinel(databaseURL, label) {
  await withClient(databaseURL, async (client) => {
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'workspace_presence_leases'
      ORDER BY ordinal_position
    `);
    if (JSON.stringify(result.rows) !== JSON.stringify([{
      column_name: "sentinel",
      data_type: "text",
      is_nullable: "NO"
    }])) {
      throw new Error(`${label} sentinel table was not preserved`);
    }
  });
}

async function dropUpgradeSentinel(databaseURL) {
  await withClient(databaseURL, async (client) => {
    await client.query("DROP TABLE IF EXISTS workspace_presence_leases");
  });
}

async function waitForAdvisoryLockWait(databaseURL, applicationName, child) {
  const started = Date.now();
  while (Date.now() - started < lockWaitTimeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const observed = await withClient(rootDatabaseURL(databaseURL), async (client) => {
      const result = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
        WHERE application_name = $1
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `, [applicationName]);
      return result.rows[0].count > 0;
    });
    if (observed) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function runGo(binary, databaseURL, migrationsDirectory, environment, activeProcesses, label) {
  return runOwnedCommand(
    binary,
    ["-migrations-dir", migrationsDirectory],
    { cwd: backendRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    migrationTimeoutMs,
    activeProcesses,
    label
  );
}

async function runNode(databaseURL, environment, activeProcesses, label) {
  return runOwnedCommand(
    process.execPath,
    [path.join(repoRoot, "apps/web/server/migrate.mjs")],
    { cwd: repoRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    migrationTimeoutMs,
    activeProcesses,
    label
  );
}

async function runLockedOwnerUpgrade(databaseURL, schema, nodeApplicationName, goApplicationName, goBinary, fullDirectory, nodeEnv, goEnv, activeProcesses) {
  const lockClient = await connect(scopedDatabaseURL(databaseURL, schema, "lock-holder"));
  let transactionOpen = false;
  let nodeRun;
  let goRun;
  try {
    await lockClient.query("BEGIN");
    transactionOpen = true;
    await lockClient.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [advisoryLockIdentity]);
    nodeRun = startOwnedCommand(
      process.execPath,
      [path.join(repoRoot, "apps/web/server/migrate.mjs")],
      { cwd: repoRoot, env: nodeEnv, stdio: ["ignore", "pipe", "pipe"] },
      migrationTimeoutMs,
      activeProcesses
    );
    goRun = startOwnedCommand(
      goBinary,
      ["-migrations-dir", fullDirectory],
      { cwd: backendRoot, env: goEnv, stdio: ["ignore", "pipe", "pipe"] },
      migrationTimeoutMs,
      activeProcesses
    );
    const [nodeObserved, goObserved] = await Promise.all([
      waitForAdvisoryLockWait(databaseURL, nodeApplicationName, nodeRun.child),
      waitForAdvisoryLockWait(databaseURL, goApplicationName, goRun.child)
    ]);
    if (!nodeObserved || !goObserved) {
      const [nodeOutcome, goOutcome] = await Promise.all([nodeRun.promise, goRun.promise]);
      throw new Error(
        `migration owners did not wait on ${advisoryLockIdentity} (node=${nodeObserved}, go=${goObserved}, `
        + `codes=${nodeOutcome.code ?? "null"}/${goOutcome.code ?? "null"})`
      );
    }
    await lockClient.query("COMMIT");
    transactionOpen = false;
    const [nodeOutcome, goOutcome] = await Promise.all([nodeRun.promise, goRun.promise]);
    if (nodeOutcome.timedOut || nodeOutcome.code !== 0 || goOutcome.timedOut || goOutcome.code !== 0) {
      throw new Error(
        `migration owners released from advisory lock unsuccessfully `
        + `(codes=${nodeOutcome.code ?? "null"}/${goOutcome.code ?? "null"})`
      );
    }
    return { lockObserved: true, node: nodeOutcome, go: goOutcome };
  } finally {
    if (transactionOpen) await lockClient.query("ROLLBACK").catch(() => {});
    if (nodeRun) await nodeRun.promise.catch(() => {});
    if (goRun) await goRun.promise.catch(() => {});
    await stopOwnedProcess(nodeRun?.child, 50).catch(() => {});
    await stopOwnedProcess(goRun?.child, 50).catch(() => {});
    await lockClient.end();
  }
}

async function rehearse(databaseURL, manifest, migrationDirectories, goBinary, activeProcesses, schemas) {
  const fullHistory = migrationNamesThrough(manifest, Number.MAX_SAFE_INTEGER);
  const through029 = migrationNamesThrough(manifest, 29);
  const through030 = migrationNamesThrough(manifest, 30);
  const report = {
    migrationManifestSha256: manifest.manifestSha256,
    checksumPersistence: "schema_migrations stores name/applied_at only; canonical SQL manifest verified",
    scenarios: []
  };

  const scenarioA = { name: createRehearsalSchemaName(), created: false };
  schemas.push(scenarioA);
  await createOwnedSchema(databaseURL, scenarioA);
  const scenarioADatabaseURL = scopedDatabaseURL(databaseURL, scenarioA.name, "node-upgrade");
  const scenarioAGoDatabaseURL = scopedDatabaseURL(databaseURL, scenarioA.name, "go-upgrade");
  const scenarioANodeApplicationName = new URL(scenarioADatabaseURL).searchParams.get("application_name");
  const scenarioAGoApplicationName = new URL(scenarioAGoDatabaseURL).searchParams.get("application_name");
  const scenarioAGoEnvironment = goEnvironment(scenarioAGoDatabaseURL);
  const scenarioANodeEnvironment = nodeEnvironment(scenarioADatabaseURL);

  await runGo(goBinary, scenarioAGoDatabaseURL, migrationDirectories.through029, scenarioAGoEnvironment, activeProcesses, "Go bootstrap through migration 029");
  await assertHistory(scenarioADatabaseURL, through029, "Go bootstrap through 029");
  await assertMigrationContract(scenarioADatabaseURL, "Go bootstrap through 029");
  await assertSeed(scenarioADatabaseURL, "Go bootstrap through 029");
  const lockReport = await runLockedOwnerUpgrade(
    scenarioADatabaseURL,
    scenarioA.name,
    scenarioANodeApplicationName,
    scenarioAGoApplicationName,
    goBinary,
    migrationDirectories.full,
    scenarioANodeEnvironment,
    scenarioAGoEnvironment,
    activeProcesses
  );
  await assertHistory(scenarioADatabaseURL, fullHistory, "locked Node/Go upgrade after 029");
  await assertMigrationContract(scenarioADatabaseURL, "locked Node/Go upgrade after 029");
  await assertSeed(scenarioADatabaseURL, "locked Node/Go upgrade after 029");
  await assertCurrentSchema(scenarioADatabaseURL, "locked Node/Go upgrade after 029");
  await assertWorkspaceReadWrite(scenarioADatabaseURL);
  const goNoopBefore = await readMigrationSnapshot(scenarioADatabaseURL);
  const goNoop = await runGo(goBinary, scenarioADatabaseURL, migrationDirectories.full, scenarioAGoEnvironment, activeProcesses, "Go compatibility check after Node upgrade");
  assertGoMigrationCount(goNoop, 0, fullHistory.length, "Go compatibility check after Node upgrade");
  await assertHistory(scenarioADatabaseURL, fullHistory, "Go compatibility check after Node upgrade");
  await assertSeed(scenarioADatabaseURL, "Go compatibility check after Node upgrade");
  await assertMigrationSnapshotUnchanged(scenarioADatabaseURL, goNoopBefore, "Go compatibility check after Node upgrade");
  report.scenarios.push({
    name: "Go 029 bootstrap -> locked Node/Go upgrade -> Go no-op",
    schema: scenarioA.name,
    history: fullHistory.length,
    advisoryLockWait: lockReport.lockObserved,
    goNoop: true
  });

  const scenarioB = { name: createRehearsalSchemaName(), created: false };
  schemas.push(scenarioB);
  await createOwnedSchema(databaseURL, scenarioB);
  const scenarioBDatabaseURL = scopedDatabaseURL(databaseURL, scenarioB.name, "node-bootstrap");
  const scenarioBGoDatabaseURL = scopedDatabaseURL(databaseURL, scenarioB.name, "go-bootstrap");
  const scenarioBGoEnvironment = goEnvironment(scenarioBGoDatabaseURL);
  const scenarioBNodeEnvironment = nodeEnvironment(scenarioBDatabaseURL);
  await runNode(scenarioBDatabaseURL, scenarioBNodeEnvironment, activeProcesses, "Node full bootstrap");
  await assertHistory(scenarioBDatabaseURL, fullHistory, "Node full bootstrap");
  await assertMigrationContract(scenarioBDatabaseURL, "Node full bootstrap");
  await assertSeed(scenarioBDatabaseURL, "Node full bootstrap");
  await assertCurrentSchema(scenarioBDatabaseURL, "Node full bootstrap");
  await assertWorkspaceReadWrite(scenarioBDatabaseURL);
  const goAfterNodeBefore = await readMigrationSnapshot(scenarioBDatabaseURL);
  const goAfterNode = await runGo(goBinary, scenarioBGoDatabaseURL, migrationDirectories.full, scenarioBGoEnvironment, activeProcesses, "Go compatibility check after Node bootstrap");
  assertGoMigrationCount(goAfterNode, 0, fullHistory.length, "Go compatibility check after Node bootstrap");
  await assertHistory(scenarioBDatabaseURL, fullHistory, "Go compatibility check after Node bootstrap");
  await assertSeed(scenarioBDatabaseURL, "Go compatibility check after Node bootstrap");
  await assertMigrationSnapshotUnchanged(scenarioBDatabaseURL, goAfterNodeBefore, "Go compatibility check after Node bootstrap");
  report.scenarios.push({
    name: "Node full bootstrap -> Go no-op",
    schema: scenarioB.name,
    history: fullHistory.length,
    goNoop: true
  });

  const scenarioC = { name: createRehearsalSchemaName(), created: false };
  schemas.push(scenarioC);
  await createOwnedSchema(databaseURL, scenarioC);
  const scenarioCDatabaseURL = scopedDatabaseURL(databaseURL, scenarioC.name, "node-rollback");
  const scenarioCGoDatabaseURL = scopedDatabaseURL(databaseURL, scenarioC.name, "go-rollback");
  const scenarioCGoEnvironment = goEnvironment(scenarioCGoDatabaseURL);
  const scenarioCNodeEnvironment = nodeEnvironment(scenarioCDatabaseURL);
  await runGo(goBinary, scenarioCGoDatabaseURL, migrationDirectories.through030, scenarioCGoEnvironment, activeProcesses, "Go bootstrap through migration 030");
  await assertHistory(scenarioCDatabaseURL, through030, "Go bootstrap through 030");
  await assertMigrationContract(scenarioCDatabaseURL, "Go bootstrap through 030");
  await assertSeed(scenarioCDatabaseURL, "Go bootstrap through 030");
  const scenarioCBeforeFailure = await readMigrationSnapshot(scenarioCDatabaseURL);
  await withClient(scenarioCDatabaseURL, async (client) => {
    await client.query("CREATE TABLE workspace_presence_leases (sentinel TEXT PRIMARY KEY)");
  });
  const rollbackAttempt = await startOwnedCommand(
    process.execPath,
    [path.join(repoRoot, "apps/web/server/migrate.mjs")],
    { cwd: repoRoot, env: scenarioCNodeEnvironment, stdio: ["ignore", "pipe", "pipe"] },
    migrationTimeoutMs,
    activeProcesses
  ).promise;
  assertMigrationFailureEvidence(rollbackAttempt, {
    migrationName: migrationNameForNumber(manifest, 31),
    ...migrationFailureFingerprints[31]
  });
  await assertHistory(scenarioCDatabaseURL, through030, "Node failed upgrade rollback");
  await assertMigrationSnapshotUnchanged(scenarioCDatabaseURL, scenarioCBeforeFailure, "Node failed upgrade rollback");
  await assertUpgradeSentinel(scenarioCDatabaseURL, "Node failed upgrade rollback");
  await assertNoLatestObjects(scenarioCDatabaseURL, "Node failed upgrade rollback");
  report.scenarios.push({
    name: "Node failed 031/032 batch rolls back",
    schema: scenarioC.name,
    history: through030.length,
    expectedFailure: true,
    partialObjects: false
  });

  const scenarioD = { name: createRehearsalSchemaName(), created: false };
  schemas.push(scenarioD);
  await createOwnedSchema(databaseURL, scenarioD);
  const scenarioDDatabaseURL = scopedDatabaseURL(databaseURL, scenarioD.name, "go-stepwise-029");
  const scenarioDGoEnvironment = goEnvironment(scenarioDDatabaseURL);
  const scenarioDGo029 = await runGo(
    goBinary,
    scenarioDDatabaseURL,
    migrationDirectories.through029,
    scenarioDGoEnvironment,
    activeProcesses,
    "Go-only bootstrap through migration 029"
  );
  assertGoMigrationCount(scenarioDGo029, through029.length, through029.length, "Go-only bootstrap through migration 029");
  await assertHistory(scenarioDDatabaseURL, through029, "Go-only bootstrap through 029");
  await assertMigrationContract(scenarioDDatabaseURL, "Go-only bootstrap through 029");
  await assertSeed(scenarioDDatabaseURL, "Go-only bootstrap through 029");

  const scenarioDGo030 = await runGo(
    goBinary,
    scenarioDDatabaseURL,
    migrationDirectories.through030,
    scenarioDGoEnvironment,
    activeProcesses,
    "Go-only upgrade through migration 030"
  );
  assertGoMigrationCount(
    scenarioDGo030,
    through030.length - through029.length,
    through030.length,
    "Go-only upgrade through migration 030"
  );
  await assertHistory(scenarioDDatabaseURL, through030, "Go-only upgrade through 030");
  await assertMigrationContract(scenarioDDatabaseURL, "Go-only upgrade through 030");
  await assertSeed(scenarioDDatabaseURL, "Go-only upgrade through 030");

  const scenarioDGoLatest = await runGo(
    goBinary,
    scenarioDDatabaseURL,
    migrationDirectories.full,
    scenarioDGoEnvironment,
    activeProcesses,
    "Go-only upgrade through the dynamic latest migration"
  );
  assertGoMigrationCount(
    scenarioDGoLatest,
    fullHistory.length - through030.length,
    fullHistory.length,
    "Go-only upgrade through the dynamic latest migration"
  );
  await assertHistory(scenarioDDatabaseURL, fullHistory, "Go-only upgrade through latest");
  await assertMigrationContract(scenarioDDatabaseURL, "Go-only upgrade through latest");
  await assertSeed(scenarioDDatabaseURL, "Go-only upgrade through latest");
  await assertCurrentSchema(scenarioDDatabaseURL, "Go-only upgrade through latest");
  await assertWorkspaceReadWrite(scenarioDDatabaseURL);

  const scenarioDNodeBefore = await readMigrationSnapshot(scenarioDDatabaseURL);
  const scenarioDNode = await runNode(
    scenarioDDatabaseURL,
    nodeEnvironment(scenarioDDatabaseURL),
    activeProcesses,
    "Node no-op after Go-only latest upgrade"
  );
  await assertNodeNoop(scenarioDDatabaseURL, scenarioDNode, scenarioDNodeBefore, "Node no-op after Go-only latest upgrade");
  await assertHistory(scenarioDDatabaseURL, fullHistory, "Node no-op after Go-only latest upgrade");
  await assertSeed(scenarioDDatabaseURL, "Node no-op after Go-only latest upgrade");
  await assertCurrentSchema(scenarioDDatabaseURL, "Node no-op after Go-only latest upgrade");
  report.scenarios.push({
    name: "Go 029 -> Go 030 -> Go latest -> Node no-op",
    schema: scenarioD.name,
    history: fullHistory.length,
    goIncremental: true,
    nodeNoop: true,
    verification: { history: true, seed: true, schema: true, readWrite: true }
  });

  const scenarioE = { name: createRehearsalSchemaName(), created: false };
  schemas.push(scenarioE);
  await createOwnedSchema(databaseURL, scenarioE);
  const scenarioEDatabaseURL = scopedDatabaseURL(databaseURL, scenarioE.name, "go-stepwise-030");
  const scenarioEGoEnvironment = goEnvironment(scenarioEDatabaseURL);
  const scenarioEGo030 = await runGo(
    goBinary,
    scenarioEDatabaseURL,
    migrationDirectories.through030,
    scenarioEGoEnvironment,
    activeProcesses,
    "Go-only bootstrap through migration 030"
  );
  assertGoMigrationCount(scenarioEGo030, through030.length, through030.length, "Go-only bootstrap through migration 030");
  await assertHistory(scenarioEDatabaseURL, through030, "Go-only bootstrap through 030");
  await assertMigrationContract(scenarioEDatabaseURL, "Go-only bootstrap through 030");
  await assertSeed(scenarioEDatabaseURL, "Go-only bootstrap through 030");

  const scenarioEGoLatest = await runGo(
    goBinary,
    scenarioEDatabaseURL,
    migrationDirectories.full,
    scenarioEGoEnvironment,
    activeProcesses,
    "Go-only upgrade from migration 030 through the dynamic latest migration"
  );
  assertGoMigrationCount(
    scenarioEGoLatest,
    fullHistory.length - through030.length,
    fullHistory.length,
    "Go-only upgrade from migration 030 through the dynamic latest migration"
  );
  await assertHistory(scenarioEDatabaseURL, fullHistory, "Go-only upgrade from 030 through latest");
  await assertMigrationContract(scenarioEDatabaseURL, "Go-only upgrade from 030 through latest");
  await assertSeed(scenarioEDatabaseURL, "Go-only upgrade from 030 through latest");
  await assertCurrentSchema(scenarioEDatabaseURL, "Go-only upgrade from 030 through latest");
  await assertWorkspaceReadWrite(scenarioEDatabaseURL);

  const scenarioENodeBefore = await readMigrationSnapshot(scenarioEDatabaseURL);
  const scenarioENode = await runNode(
    scenarioEDatabaseURL,
    nodeEnvironment(scenarioEDatabaseURL),
    activeProcesses,
    "Node no-op after Go-only 030-to-latest upgrade"
  );
  await assertNodeNoop(scenarioEDatabaseURL, scenarioENode, scenarioENodeBefore, "Node no-op after Go-only 030-to-latest upgrade");
  await assertHistory(scenarioEDatabaseURL, fullHistory, "Node no-op after Go-only 030-to-latest upgrade");
  await assertSeed(scenarioEDatabaseURL, "Node no-op after Go-only 030-to-latest upgrade");
  await assertCurrentSchema(scenarioEDatabaseURL, "Node no-op after Go-only 030-to-latest upgrade");
  report.scenarios.push({
    name: "Go 030 -> Go latest -> Node no-op",
    schema: scenarioE.name,
    history: fullHistory.length,
    goIncremental: true,
    nodeNoop: true,
    verification: { history: true, seed: true, schema: true, readWrite: true }
  });

  const scenarioF = { name: createRehearsalSchemaName(), created: false };
  schemas.push(scenarioF);
  await createOwnedSchema(databaseURL, scenarioF);
  const scenarioFDatabaseURL = scopedDatabaseURL(databaseURL, scenarioF.name, "go-rollback");
  const scenarioFGoEnvironment = goEnvironment(scenarioFDatabaseURL);
  const scenarioFGo030 = await runGo(
    goBinary,
    scenarioFDatabaseURL,
    migrationDirectories.through030,
    scenarioFGoEnvironment,
    activeProcesses,
    "Go rollback bootstrap through migration 030"
  );
  assertGoMigrationCount(scenarioFGo030, through030.length, through030.length, "Go rollback bootstrap through migration 030");
  await assertHistory(scenarioFDatabaseURL, through030, "Go rollback bootstrap through 030");
  await assertMigrationContract(scenarioFDatabaseURL, "Go rollback bootstrap through 030");
  await assertSeed(scenarioFDatabaseURL, "Go rollback bootstrap through 030");
  const scenarioFBeforeFailure = await readMigrationSnapshot(scenarioFDatabaseURL);
  let sentinelCreated = false;
  try {
    await withClient(scenarioFDatabaseURL, async (client) => {
      await client.query("CREATE TABLE workspace_presence_leases (sentinel TEXT PRIMARY KEY)");
    });
    sentinelCreated = true;
    const failedGoUpgrade = await startOwnedCommand(
      goBinary,
      ["-migrations-dir", migrationDirectories.full],
      { cwd: backendRoot, env: scenarioFGoEnvironment, stdio: ["ignore", "pipe", "pipe"] },
      migrationTimeoutMs,
      activeProcesses
    ).promise;
    assertMigrationFailureEvidence(failedGoUpgrade, {
      migrationName: migrationNameForNumber(manifest, 31),
      ...migrationFailureFingerprints[31]
    });
    await assertMigrationSnapshotUnchanged(scenarioFDatabaseURL, scenarioFBeforeFailure, "Go failed upgrade rollback");
    await assertHistory(scenarioFDatabaseURL, through030, "Go failed upgrade rollback");
    await assertUpgradeSentinel(scenarioFDatabaseURL, "Go failed upgrade rollback");
    await assertNoLatestObjects(scenarioFDatabaseURL, "Go failed upgrade rollback");
  } finally {
    if (sentinelCreated) await dropUpgradeSentinel(scenarioFDatabaseURL);
  }

  // Failing the first pending migration alone cannot prove that earlier
  // migrations in the same batch roll back. Fail at 033 after 031/032 ran,
  // without editing the canonical SQL history.
  let finalizationSentinelCreated = false;
  try {
    await withClient(scenarioFDatabaseURL, async (client) => {
      await client.query("ALTER TABLE workspace_command_runs ADD COLUMN result_finalized_at TEXT");
    });
    finalizationSentinelCreated = true;
    const lateFailure = await startOwnedCommand(
      goBinary,
      ["-migrations-dir", migrationDirectories.full],
      { cwd: backendRoot, env: scenarioFGoEnvironment, stdio: ["ignore", "pipe", "pipe"] },
      migrationTimeoutMs,
      activeProcesses
    ).promise;
    assertMigrationFailureEvidence(lateFailure, {
      migrationName: migrationNameForNumber(manifest, 33),
      ...migrationFailureFingerprints[33]
    });
    await assertMigrationSnapshotUnchanged(scenarioFDatabaseURL, scenarioFBeforeFailure, "Go late-batch rollback");
    await assertNoLatestObjects(scenarioFDatabaseURL, "Go late-batch rollback", true);
    await withClient(scenarioFDatabaseURL, async (client) => {
      const result = await client.query(`SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'workspace_command_runs'
          AND column_name = 'result_finalized_at'`);
      if (result.rowCount !== 1 || result.rows[0].data_type !== "text") {
        throw new Error("Go late-batch rollback changed the synthetic sentinel");
      }
    });
  } finally {
    if (finalizationSentinelCreated) await withClient(scenarioFDatabaseURL, async (client) => {
      await client.query("ALTER TABLE workspace_command_runs DROP COLUMN result_finalized_at");
    });
  }

  const scenarioFRetry = await runGo(
    goBinary,
    scenarioFDatabaseURL,
    migrationDirectories.full,
    scenarioFGoEnvironment,
    activeProcesses,
    "Go retry after failed upgrade rollback"
  );
  assertGoMigrationCount(
    scenarioFRetry,
    fullHistory.length - through030.length,
    fullHistory.length,
    "Go retry after failed upgrade rollback"
  );
  await assertHistory(scenarioFDatabaseURL, fullHistory, "Go retry after failed upgrade rollback");
  await assertMigrationContract(scenarioFDatabaseURL, "Go retry after failed upgrade rollback");
  await assertSeed(scenarioFDatabaseURL, "Go retry after failed upgrade rollback");
  await assertCurrentSchema(scenarioFDatabaseURL, "Go retry after failed upgrade rollback");
  await assertWorkspaceReadWrite(scenarioFDatabaseURL);
  report.scenarios.push({
    name: "Go failed latest upgrade rolls back -> retry succeeds",
    schema: scenarioF.name,
    history: fullHistory.length,
    expectedFailure: true,
    transactionRollback: true,
    lateBatchRollback: true,
    retrySucceeded: true,
    partialObjects: false,
    verification: { history: true, seed: true, schema: true, readWrite: true }
  });

  return report;
}

async function runSchemaCoexistenceInternal(environment = process.env) {
  const databaseURL = validateRehearsalEnvironment(environment);
  const manifest = await loadCanonicalMigrationManifest();
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "duallane-schema-coexistence-"));
  const activeProcesses = new Set();
  const schemas = [];
  let primaryError;
  let cleanupError;
  let report;
  const interrupt = () => {
    for (const child of activeProcesses) void stopOwnedProcess(child, 1_000).catch(() => {});
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const migrationDirectories = {
      full: migrationRoot,
      through029: await createMigrationSubset(temporaryDirectory, manifest, 29),
      through030: await createMigrationSubset(temporaryDirectory, manifest, 30)
    };
    const goBinary = path.join(temporaryDirectory, `duallane-migrate${process.platform === "win32" ? ".exe" : ""}`);
    await runOwnedCommand(
      environment.DUALLANE_SCHEMA_GO_BIN || environment.GO_BIN || "go",
      ["build", "-trimpath", "-buildvcs=false", "-o", goBinary, "./cmd/migrate"],
      { cwd: backendRoot, env: safeEnvironment({
        CGO_ENABLED: "1",
        GOWORK: "off",
        GOMAXPROCS: "2",
        GOPROXY: environment.GOPROXY || "https://goproxy.cn,direct"
      }), stdio: ["ignore", "pipe", "pipe"] },
      migrationTimeoutMs,
      activeProcesses,
      "build Go migration owner"
    );
    report = await rehearse(databaseURL, manifest, migrationDirectories, goBinary, activeProcesses, schemas);
  } catch (error) {
    primaryError = error;
  } finally {
    for (const child of activeProcesses) await stopOwnedProcess(child, 1_000).catch(() => {});
    for (const schema of schemas.reverse()) {
      if (!schema.created) continue;
      try {
        await dropOwnedSchema(databaseURL, schema.name);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      await rm(temporaryDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (primaryError && cleanupError) throw createSafeError("combined");
  if (primaryError) throw toSafeSchemaCoexistenceError(primaryError);
  if (cleanupError) throw toSafeSchemaCoexistenceError(cleanupError, "cleanup");
  if (!report) throw new Error("schema rehearsal did not produce a result");
  const finalManifest = await loadCanonicalMigrationManifest();
  if (finalManifest.manifestSha256 !== manifest.manifestSha256) {
    throw new Error("canonical migration SQL changed during schema rehearsal");
  }
  return report;
}

export async function runSchemaCoexistence(environment = process.env) {
  try {
    return await runSchemaCoexistenceInternal(environment);
  } catch (error) {
    throw toSafeSchemaCoexistenceError(error);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runSchemaCoexistence();
    process.stdout.write(`${JSON.stringify({ ok: true, ...report })}\n`);
  } catch {
    process.stderr.write("Schema coexistence rehearsal failed; no credential-bearing provider details emitted.\n");
    process.exitCode = 1;
  }
}
