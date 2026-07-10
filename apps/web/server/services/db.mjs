import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool, types } = pg;

export const DEFAULT_SPACE_ID = "spc_default";
export const SEEDED_OWNER_ID = "usr_owner";
export const SEEDED_OWNER_GITHUB_LOGIN = "timeStarry";
export const SEEDED_OWNER_EMAIL = "timestarry@qq.com";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

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
    throw new Error("DATABASE_URL or PGHOST is required when Workspace is enabled");
  }

  const pool = options.pool ?? new Pool({
    ...connectionOptions,
    max: options.maxConnections,
    ssl: options.ssl
  });
  const db = new PostgresDatabase(pool, { ownsPool: !options.pool });

  try {
    if (options.migrate !== false) {
      await migrateDatabase(db);
    }
    if (options.seed !== false) {
      await seedWorkspace(db);
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export function createDatabaseFromPool(pool, options = {}) {
  return new PostgresDatabase(pool, { ownsPool: options.ownsPool === true });
}

export async function migrateDatabase(db) {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((fileName) => /^\d+.*\.sql$/.test(fileName))
    .sort((left, right) => left.localeCompare(right));

  await db.transaction(async () => {
    await db.lock("duallane:schema-migrations");
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      )
    `);

    const appliedRows = await db.prepare("SELECT name FROM schema_migrations").all();
    const applied = new Set(appliedRows.map((row) => row.name));
    for (const fileName of migrationFiles) {
      if (applied.has(fileName)) {
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, fileName), "utf8");
      await db.exec(sql);
      await db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(fileName, new Date().toISOString());
    }
  });
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

async function seedWorkspace(db) {
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare(`
      INSERT INTO users (
        id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
      )
      VALUES (?, NULL, ?, ?, ?, NULL, 'human', ?, NULL)
      ON CONFLICT DO NOTHING
    `).run(SEEDED_OWNER_ID, SEEDED_OWNER_GITHUB_LOGIN, SEEDED_OWNER_EMAIL, SEEDED_OWNER_GITHUB_LOGIN, now);

    await db.prepare(`
      INSERT INTO spaces (id, name, slug, created_by, created_at)
      VALUES (?, '默认空间', 'default', ?, ?)
      ON CONFLICT DO NOTHING
    `).run(DEFAULT_SPACE_ID, SEEDED_OWNER_ID, now);

    await db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES (?, ?, 'owner', ?, NULL)
      ON CONFLICT DO NOTHING
    `).run(DEFAULT_SPACE_ID, SEEDED_OWNER_ID, now);

    await db.prepare(`
      INSERT INTO workspace_events (
        id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
      )
      VALUES ('evt_seed_owner', ?, 1, 'workspace.member_joined', ?, NULL, 'user', ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      DEFAULT_SPACE_ID,
      SEEDED_OWNER_ID,
      SEEDED_OWNER_ID,
      JSON.stringify({ userId: SEEDED_OWNER_ID, role: "owner" }),
      now
    );

    await db.prepare(`
      INSERT INTO workspace_event_cursors (space_id, next_seq)
      SELECT ?, COALESCE(MAX(seq), 0) + 1 FROM workspace_events WHERE space_id = ?
      ON CONFLICT (space_id) DO UPDATE
      SET next_seq = GREATEST(workspace_event_cursors.next_seq, EXCLUDED.next_seq)
    `).run(DEFAULT_SPACE_ID, DEFAULT_SPACE_ID);

    await db.prepare(`
      INSERT INTO audit_logs (
        id, space_id, actor_user_id, actor_github_login, action, target_type, target_id,
        result, reason, ip_address, user_agent, request_id, created_at
      )
      VALUES ('aud_seed_owner', ?, ?, ?, 'workspace.owner.seeded', 'workspace', ?,
        'success', 'development bootstrap', '127.0.0.1', 'duallane-seed', 'seed', ?)
      ON CONFLICT DO NOTHING
    `).run(DEFAULT_SPACE_ID, SEEDED_OWNER_ID, SEEDED_OWNER_GITHUB_LOGIN, DEFAULT_SPACE_ID, now);
  });
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
