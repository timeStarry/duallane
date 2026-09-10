import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabaseFromPool, openDatabase } from "../lib/database.mjs";

test("offline database opening does not run migrations, seed writes, or any query", async () => {
  const calls = [];
  const db = await openDatabase(null, {
    pool: {
      async query(...args) {
        calls.push(args);
        throw new Error("unexpected query");
      }
    },
    migrate: true,
    seed: true
  });

  assert.deepEqual(calls, []);
  await db.close();
});

test("database adapter preserves positional parameters and camel-case aliases", async () => {
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      return {
        rows: [{ camelname: "value", literal: "?", quoted: "?" }],
        rowCount: 1
      };
    }
  };
  const db = createDatabaseFromPool(pool);

  const row = await db.prepare(`SELECT ? AS camelName, '?' AS literal, "?" AS quoted`).get("value");

  assert.deepEqual(row, { camelName: "value", literal: "?", quoted: "?" });
  assert.deepEqual(queries, [{
    text: `SELECT $1 AS camelName, '?' AS literal, "?" AS quoted`,
    values: ["value"]
  }]);
});

test("database transaction propagates callback failures and rolls back", async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push({ text: "RELEASE" });
    }
  };
  const pool = { async connect() { return client; } };
  const db = createDatabaseFromPool(pool);
  const failure = new Error("synthetic transaction failure");

  await assert.rejects(
    db.transaction(async () => {
      await db.lock("synthetic-lock");
      throw failure;
    }),
    (error) => error === failure
  );
  assert.deepEqual(calls, [
    { text: "BEGIN", values: undefined },
    { text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", values: ["synthetic-lock"] },
    { text: "ROLLBACK", values: undefined },
    { text: "RELEASE" }
  ]);
});

test("database advisory locks fail outside a transaction", async () => {
  const db = createDatabaseFromPool({});
  await assert.rejects(
    db.lock("outside-transaction"),
    /advisory locks require an active transaction/
  );
});
