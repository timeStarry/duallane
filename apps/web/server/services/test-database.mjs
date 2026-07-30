import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SPACE_ID,
  SEEDED_OWNER_EMAIL,
  SEEDED_OWNER_GITHUB_LOGIN,
  SEEDED_OWNER_ID
} from "./db.mjs";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

// Fast unit tests use SQLite as a test double. Runtime code only opens PostgreSQL.
export function openTestDatabase(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "duallane-test.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const initialized = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!initialized) {
    for (const fileName of readdirSync(migrationsDir).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      db.exec(readFileSync(path.join(migrationsDir, fileName), "utf8"));
    }
    seedTestWorkspace(db);
  }

  db.transaction = async (callback) => {
    const savepoint = `test_tx_${randomBytes(8).toString("hex")}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await callback();
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  };
  db.lock = async () => {};
  return db;
}

function seedTestWorkspace(db) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (
      id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
    )
    VALUES (?, NULL, ?, ?, ?, NULL, 'human', ?, NULL)
  `).run(SEEDED_OWNER_ID, SEEDED_OWNER_GITHUB_LOGIN, SEEDED_OWNER_EMAIL, SEEDED_OWNER_GITHUB_LOGIN, now);

  db.prepare(`
    INSERT INTO spaces (id, name, slug, created_by, created_at)
    VALUES (?, '默认空间', 'default', ?, ?)
  `).run(DEFAULT_SPACE_ID, SEEDED_OWNER_ID, now);

  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES (?, ?, 'owner', ?, NULL)
  `).run(DEFAULT_SPACE_ID, SEEDED_OWNER_ID, now);

  db.prepare(`
    INSERT INTO workspace_events (
      id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
    )
    VALUES ('evt_seed_owner', ?, 1, 'workspace.member_joined', ?, NULL, 'user', ?, ?, ?)
  `).run(
    DEFAULT_SPACE_ID,
    SEEDED_OWNER_ID,
    SEEDED_OWNER_ID,
    JSON.stringify({ userId: SEEDED_OWNER_ID, role: "owner" }),
    now
  );

  db.prepare("INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES (?, 2)")
    .run(DEFAULT_SPACE_ID);

  db.prepare(`
    INSERT INTO audit_logs (
      id, space_id, actor_user_id, actor_github_login, action, target_type, target_id,
      result, reason, ip_address, user_agent, request_id, created_at
    )
    VALUES ('aud_seed_owner', ?, ?, ?, 'workspace.owner.seeded', 'workspace', ?,
      'success', 'development bootstrap', '127.0.0.1', 'duallane-seed', 'seed', ?)
  `).run(DEFAULT_SPACE_ID, SEEDED_OWNER_ID, SEEDED_OWNER_GITHUB_LOGIN, DEFAULT_SPACE_ID, now);
}
