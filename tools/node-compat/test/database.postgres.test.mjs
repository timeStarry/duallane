import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { test } from "node:test";
import { openDatabase } from "../lib/database.mjs";

const { Pool } = pg;
const postgresOptIn = process.env.NODE_COMPAT_TEST_POSTGRES === "true";
const POSTGRES_QUERY_TIMEOUT_MS = 5_000;
const POSTGRES_TEST_TIMEOUT_MS = 30_000;

test("PostgreSQL adapter uses an owned disposable schema and preserves its safety semantics", {
  timeout: POSTGRES_TEST_TIMEOUT_MS,
  skip: postgresOptIn
    ? false
    : "set NODE_COMPAT_TEST_POSTGRES=true with TEST_DATABASE_URL to run the disposable PostgreSQL adapter test"
}, async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("NODE_COMPAT_TEST_POSTGRES=true requires TEST_DATABASE_URL");
  }
  assertDisposableDatabaseUrl(connectionString);

  const nativePool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: POSTGRES_QUERY_TIMEOUT_MS,
    query_timeout: POSTGRES_QUERY_TIMEOUT_MS,
    statement_timeout: POSTGRES_QUERY_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POSTGRES_QUERY_TIMEOUT_MS
  });
  let poolEndCalls = 0;
  const observedQueries = [];
  const trackedPool = {
    async query(...args) {
      observedQueries.push(queryText(args[0]));
      return await nativePool.query(...args);
    },
    async connect() {
      const client = await nativePool.connect();
      return {
        query: async (...args) => {
          observedQueries.push(queryText(args[0]));
          return await client.query(...args);
        },
        release: (...args) => client.release(...args)
      };
    },
    async end() {
      poolEndCalls += 1;
      return await nativePool.end();
    }
  };
  const db = await openDatabase(null, {
    pool: trackedPool,
    migrate: true,
    seed: true
  });
  const schemaName = `nodecompat_${randomBytes(8).toString("hex")}`;
  const schema = quoteIdentifier(schemaName);
  const records = `${schema}."records"`;
  const lockKey = `node-compat:${schemaName}:concurrent-lock`;
  let schemaCreated = false;
  let schemaIdentity;

  try {
    assert.deepEqual(observedQueries, [], "openDatabase must not run migrations, seed, or any SQL");

    await db.exec(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    schemaIdentity = await readOwnedSchemaIdentity(nativePool, schemaName);
    await db.exec(`
      CREATE TABLE ${records} (
        label TEXT PRIMARY KEY,
        amount BIGINT NOT NULL,
        numeric_amount NUMERIC NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `);

    const safeAmount = "9007199254740991";
    const safeNumeric = "42";
    const createdAt = "2026-09-10T00:00:00.000Z";
    await db.prepare(`INSERT INTO ${records} (
      label, amount, numeric_amount, created_at
    ) VALUES (?, ?, ?, ?)`)
      .run("safe", safeAmount, safeNumeric, createdAt);

    const safeRow = await db.prepare(`SELECT
      amount AS amount, numeric_amount AS numericAmount, created_at AS createdAt
      FROM ${records} WHERE label = ?`).get("safe");
    assert.equal(safeRow.amount, Number.MAX_SAFE_INTEGER);
    assert.equal(safeRow.numericAmount, 42);
    assert.equal(safeRow.createdAt, new Date(createdAt).toISOString());

    await db.prepare(`INSERT INTO ${records} (
      label, amount, numeric_amount, created_at
    ) VALUES (?, ?, ?, ?)`)
      .run("overflow", "9007199254740992", safeNumeric, createdAt);
    await assert.rejects(
      db.prepare(`SELECT amount AS amount FROM ${records} WHERE label = ?`).get("overflow"),
      (error) => error instanceof RangeError && /safe range/.test(error.message)
    );

    const rollbackFailure = new Error("rollback sentinel");
    await assert.rejects(
      db.transaction(async () => {
        await db.prepare(`INSERT INTO ${records} (
          label, amount, numeric_amount, created_at
        ) VALUES (?, ?, ?, ?)`)
          .run("rolled-back", safeAmount, safeNumeric, createdAt);
        throw rollbackFailure;
      }),
      (error) => error === rollbackFailure
    );
    assert.equal(
      (await db.prepare(`SELECT COUNT(*) AS count FROM ${records} WHERE label = ?`).get("rolled-back")).count,
      0
    );

    const nestedFailure = new Error("savepoint sentinel");
    await db.transaction(async () => {
      await insertRecord(db, records, "outer-before", createdAt);
      await assert.rejects(
        db.transaction(async () => {
          await insertRecord(db, records, "nested-rolled-back", createdAt);
          throw nestedFailure;
        }),
        (error) => error === nestedFailure
      );
      await insertRecord(db, records, "outer-after", createdAt);
    });
    assert.deepEqual(
      await db.prepare(`SELECT label FROM ${records}
        WHERE label IN (?, ?, ?) ORDER BY label`).all(
        "outer-after", "outer-before", "nested-rolled-back"
      ),
      [{ label: "outer-after" }, { label: "outer-before" }]
    );

    await assertConcurrentAdvisoryLock(db, nativePool, lockKey);

    await db.close();
    assert.equal(poolEndCalls, 0, "a pool supplied by the caller remains caller-owned");
  } finally {
    try {
      if (schemaCreated) {
        await assertOwnedSchemaBeforeDrop(nativePool, schemaName, schemaIdentity);
        await db.exec(`DROP SCHEMA ${schema} CASCADE`);
        schemaCreated = false;
      }
    } finally {
      await db.close();
      await nativePool.end();
    }
  }
});

async function insertRecord(db, records, label, createdAt) {
  await db.prepare(`INSERT INTO ${records} (
    label, amount, numeric_amount, created_at
  ) VALUES (?, ?, ?, ?)`)
    .run(label, "1", "1", createdAt);
}

function assertDisposableDatabaseUrl(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a PostgreSQL URL for the loopback disposable database");
  }
  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "::1"]);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const queryKeys = [...parsed.searchParams.keys()];
  const hasOnlyOneOptionalSslMode = queryKeys.length === 0 || (
    queryKeys.length === 1 && queryKeys[0] === "sslmode" && parsed.searchParams.get("sslmode")
  );
  const hasServiceOverride = ["PGSERVICE", "PGSERVICEFILE", "PGSYSCONFDIR"]
    .some((name) => process.env[name]);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !loopbackHosts.has(parsed.hostname) ||
    !parsed.port ||
    !parsed.username ||
    !databaseName ||
    ["postgres", "template0", "template1"].includes(databaseName.toLowerCase()) ||
    parsed.hash ||
    !hasOnlyOneOptionalSslMode ||
    hasServiceOverride
  ) {
    throw new Error(
      "TEST_DATABASE_URL must use an explicit loopback PostgreSQL URL for a non-system database without service overrides"
    );
  }
}

async function assertConcurrentAdvisoryLock(db, nativePool, lockKey) {
  const events = [];
  const firstStarted = deferred();
  const firstAcquired = deferred();
  const secondStarted = deferred();
  const holdFirst = deferred();
  let firstFailure;
  let secondFailure;

  const first = db.transaction(async () => {
    try {
      const row = await db.prepare("SELECT pg_backend_pid() AS backendPid").get();
      firstStarted.resolve(Number(row.backendPid));
      await db.lock(lockKey);
      events.push("first-acquired");
      firstAcquired.resolve();
      await holdFirst.promise;
      events.push("first-releasing");
    } catch (error) {
      firstStarted.reject(error);
      firstAcquired.reject(error);
      throw error;
    }
  });
  const firstDone = first.then(
    () => undefined,
    (error) => {
      firstFailure = error;
      firstStarted.reject(error);
      firstAcquired.reject(error);
    }
  );

  let second;
  let secondDone;
  try {
    await firstStarted.promise;
    await firstAcquired.promise;
    second = db.transaction(async () => {
      try {
        const row = await db.prepare("SELECT pg_backend_pid() AS backendPid").get();
        secondStarted.resolve(Number(row.backendPid));
        await db.lock(lockKey);
        events.push("second-acquired");
      } catch (error) {
        secondStarted.reject(error);
        throw error;
      }
    });
    secondDone = second.then(
      () => undefined,
      (error) => {
        secondFailure = error;
        secondStarted.reject(error);
      }
    );
    const secondPid = await secondStarted.promise;
    await waitForAdvisoryLockWait(nativePool, secondPid);
    assert.deepEqual(events, ["first-acquired"]);
  } finally {
    holdFirst.resolve();
    await Promise.all([firstDone, secondDone ?? Promise.resolve()]);
  }

  if (firstFailure) throw firstFailure;
  if (secondFailure) throw secondFailure;
  assert.deepEqual(events, ["first-acquired", "first-releasing", "second-acquired"]);
}

async function waitForAdvisoryLockWait(nativePool, backendPid) {
  const deadline = Date.now() + POSTGRES_QUERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await nativePool.query({
      text: `SELECT wait_event_type AS "waitEventType", wait_event AS "waitEvent"
        FROM pg_stat_activity WHERE pid = $1`,
      values: [backendPid],
      query_timeout: POSTGRES_QUERY_TIMEOUT_MS
    });
    const activity = result.rows[0];
    if (activity?.waitEventType === "Lock" && activity.waitEvent === "advisory") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("second PostgreSQL transaction did not become observable as advisory-lock waiting");
}

async function readOwnedSchemaIdentity(nativePool, schemaName) {
  if (!/^nodecompat_[a-f0-9]{16}$/.test(schemaName)) {
    throw new Error("refusing to drop a schema outside the nodecompat ownership prefix");
  }
  const result = await nativePool.query({
    text: `SELECT
        n.oid::text AS "schemaOid",
        n.nspname AS "schemaName",
        n.nspowner::text AS "ownerOid",
        n.nspowner::regrole::text AS "ownerRole",
        current_user AS "currentRole"
      FROM pg_namespace AS n
      WHERE n.nspname = $1
        AND n.nspowner = CURRENT_USER::regrole`,
    values: [schemaName],
    query_timeout: POSTGRES_QUERY_TIMEOUT_MS
  });
  const identity = result.rows[0];
  if (
    result.rowCount !== 1 ||
    identity?.schemaName !== schemaName ||
    identity.ownerRole !== identity.currentRole
  ) {
    throw new Error("refusing to drop a missing or unowned nodecompat schema");
  }
  return {
    schemaOid: identity.schemaOid,
    ownerOid: identity.ownerOid,
    ownerRole: identity.ownerRole
  };
}

async function assertOwnedSchemaBeforeDrop(nativePool, schemaName, createdIdentity) {
  if (!createdIdentity) {
    throw new Error("refusing to drop a nodecompat schema without a recorded identity");
  }
  const currentIdentity = await readOwnedSchemaIdentity(nativePool, schemaName);
  if (
    currentIdentity.schemaOid !== createdIdentity.schemaOid ||
    currentIdentity.ownerOid !== createdIdentity.ownerOid ||
    currentIdentity.ownerRole !== createdIdentity.ownerRole
  ) {
    throw new Error("refusing to drop a nodecompat schema whose identity changed");
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function queryText(query) {
  return typeof query === "string" ? query : query?.text;
}
