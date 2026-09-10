import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool, types } = pg;

// The migration SQL remains owned by the application tree. This path is
// informational for the operator package; this adapter never executes it.
export const CANONICAL_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/server/migrations"
);

types.setTypeParser(20, parseSafeDatabaseNumber);
types.setTypeParser(1700, parseSafeDatabaseNumber);

export async function openDatabase(connectionString, options = {}) {
  const connectionOptions = connectionString
    ? { connectionString }
    : options.host
      ? {
        host: options.host,
        port: options.port,
        database: options.database,
        user: options.user,
        password: options.password
      }
      : null;
  if (!options.pool && !connectionOptions) {
    throw new Error("DATABASE_URL or PGHOST is required for the offline storage operator");
  }

  const pool = options.pool ?? new Pool({
    ...connectionOptions,
    max: options.maxConnections,
    ssl: options.ssl
  });
  const db = new PostgresDatabase(pool, { ownsPool: !options.pool });
  return db;
}

export function createDatabaseFromPool(pool, options = {}) {
  return new PostgresDatabase(pool, { ownsPool: options.ownsPool === true });
}

class PostgresDatabase {
  #pool;
  #ownsPool;
  #transactionContext = new AsyncLocalStorage();

  constructor(pool, { ownsPool }) {
    this.#pool = pool;
    this.#ownsPool = ownsPool;
  }

  prepare(sql) {
    const { text, aliases } = toPostgresSql(sql);
    return {
      get: async (...values) => {
        const result = await this.#query(text, values);
        return normalizeStatementRow(result.rows[0], aliases);
      },
      all: async (...values) => {
        const result = await this.#query(text, values);
        return result.rows.map((row) => normalizeStatementRow(row, aliases));
      },
      run: async (...values) => {
        const result = await this.#query(text, values);
        return {
          changes: result.rowCount,
          rows: result.rows.map((row) => normalizeStatementRow(row, aliases))
        };
      }
    };
  }

  async exec(sql) {
    return this.#query(sql);
  }

  async transaction(callback) {
    const active = this.#transactionContext.getStore();
    if (active) {
      return this.#nestedTransaction(active.client, callback);
    }

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      return await this.#transactionContext.run({ client }, async () => {
        try {
          const result = await callback();
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    } finally {
      client.release();
    }
  }

  async lock(key) {
    if (!this.#transactionContext.getStore()) {
      throw new Error("Database advisory locks require an active transaction");
    }
    await this.#query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [String(key)]);
  }

  async close() {
    if (this.#ownsPool) {
      await this.#pool.end();
    }
  }

  async #nestedTransaction(client, callback) {
    const savepoint = `duallane_${randomBytes(8).toString("hex")}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await callback();
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  async #query(text, values = []) {
    const queryable = this.#transactionContext.getStore()?.client ?? this.#pool;
    const result = await queryable.query(text, values);
    if (Array.isArray(result)) {
      return result.at(-1);
    }
    return {
      ...result,
      rows: result.rows.map(normalizeDatabaseRow)
    };
  }
}

function toPostgresSql(sql) {
  const source = String(sql);
  const aliases = new Map();
  for (const match of source.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (/[A-Z]/.test(match[1])) {
      aliases.set(match[1].toLowerCase(), match[1]);
    }
  }
  return {
    text: replaceQuestionMarkParameters(source),
    aliases
  };
}

function replaceQuestionMarkParameters(sql) {
  let index = 0;
  let quote = null;
  let output = "";
  for (let cursor = 0; cursor < sql.length; cursor += 1) {
    const character = sql[cursor];
    const next = sql[cursor + 1];
    if (quote) {
      output += character;
      if (character === quote) {
        if (next === quote) {
          output += next;
          cursor += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === "?") {
      index += 1;
      output += `$${index}`;
      continue;
    }
    output += character;
  }
  return output;
}

function normalizeDatabaseRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value
  ]));
}

function normalizeStatementRow(row, aliases) {
  if (!row || aliases.size === 0) {
    return row;
  }
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [aliases.get(key) ?? key, value]));
}

function parseSafeDatabaseNumber(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`Database integer exceeds JavaScript safe range: ${value}`);
  }
  return parsed;
}
