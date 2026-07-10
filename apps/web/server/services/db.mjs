import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const DEFAULT_SPACE_ID = "spc_default";
export const SEEDED_OWNER_ID = "usr_owner";
export const SEEDED_OWNER_GITHUB_LOGIN = "timeStarry";
export const SEEDED_OWNER_EMAIL = "timestarry@qq.com";

const WORKSPACE_TABLES = [
  "message_attachments",
  "messages",
  "conversation_members",
  "conversations",
  "attachments",
  "transfer_ledger",
  "workspace_events",
  "invites",
  "sessions",
  "space_members",
  "spaces",
  "audit_logs",
  "users"
];

export function openDatabase(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "duallane.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  resetLegacyWorkspaceSchema(db);
  initializeSchema(db);
  seedWorkspace(db);
  return db;
}

function resetLegacyWorkspaceSchema(db) {
  const messageColumns = db.prepare("PRAGMA table_info(messages)").all();
  const hasLegacyBodyColumn = messageColumns.some((column) => column.name === "body");
  const hasStructuredContent = messageColumns.some((column) => column.name === "content_json");

  if (messageColumns.length > 0 && hasLegacyBodyColumn && !hasStructuredContent) {
    db.exec("PRAGMA foreign_keys = OFF");
    for (const table of WORKSPACE_TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id TEXT UNIQUE,
      github_login TEXT NOT NULL UNIQUE,
      email TEXT,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'bot', 'system')),
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS space_members (
      space_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'auditor')),
      joined_at TEXT NOT NULL,
      removed_at TEXT,
      PRIMARY KEY (space_id, user_id),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      code_preview TEXT NOT NULL,
      default_role TEXT NOT NULL CHECK (default_role IN ('owner', 'admin', 'member', 'auditor')),
      created_by TEXT NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
      title TEXT NOT NULL,
      direct_key TEXT,
      retention_count INTEGER NOT NULL DEFAULT 10000,
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id),
      UNIQUE (space_id, direct_key)
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      removed_at TEXT,
      last_read_message_id TEXT,
      last_read_at TEXT,
      last_read_seq INTEGER,
      notification_level TEXT NOT NULL DEFAULT 'all' CHECK (notification_level IN ('all', 'mentions', 'muted')),
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      author_id TEXT,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'bot', 'system')),
      kind TEXT NOT NULL CHECK (kind IN ('user', 'bot', 'system')),
      client_message_id TEXT,
      content_format TEXT NOT NULL,
      content_json TEXT NOT NULL,
      plain_text TEXT NOT NULL,
      reply_to_message_id TEXT,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      deleted_at TEXT,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id),
      FOREIGN KEY (reply_to_message_id) REFERENCES messages(id),
      UNIQUE (space_id, conversation_id, author_id, client_message_id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      uploader_id TEXT NOT NULL,
      conversation_id TEXT,
      visibility TEXT NOT NULL CHECK (visibility IN ('private_staging', 'conversation', 'space')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'available', 'failed', 'removed')),
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      storage_key TEXT,
      upload_transfer_id TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (uploader_id) REFERENCES users(id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      PRIMARY KEY (message_id, attachment_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transfer_ledger (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
      byte_size INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'released', 'failed', 'rejected')),
      attachment_id TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      released_at TEXT,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (attachment_id) REFERENCES attachments(id)
    );

    CREATE TABLE IF NOT EXISTS workspace_events (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor_user_id TEXT,
      conversation_id TEXT,
      target_type TEXT,
      target_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES users(id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      UNIQUE (space_id, seq)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      space_id TEXT,
      actor_user_id TEXT,
      actor_github_login TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'rejected')),
      reason TEXT,
      ip_address TEXT,
      user_agent TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES users(id)
    );
  `);
  ensureColumn(db, "conversation_members", "last_read_message_id", "TEXT");
  ensureColumn(db, "conversation_members", "last_read_at", "TEXT");
  ensureColumn(db, "conversation_members", "last_read_seq", "INTEGER");
  ensureColumn(db, "conversation_members", "notification_level", "TEXT NOT NULL DEFAULT 'all'");
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function seedWorkspace(db) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO users (
      id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
    )
    VALUES (?, NULL, ?, ?, ?, NULL, 'human', ?, NULL)
  `).run(SEEDED_OWNER_ID, SEEDED_OWNER_GITHUB_LOGIN, SEEDED_OWNER_EMAIL, SEEDED_OWNER_GITHUB_LOGIN, now);

  db.prepare(`
    INSERT OR IGNORE INTO spaces (id, name, slug, created_by, created_at)
    VALUES (?, '默认空间', 'default', ?, ?)
  `).run(DEFAULT_SPACE_ID, SEEDED_OWNER_ID, now);

  db.prepare(`
    INSERT OR IGNORE INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES (?, ?, 'owner', ?, NULL)
  `).run(DEFAULT_SPACE_ID, SEEDED_OWNER_ID, now);

  const existingEvent = db.prepare(`
    SELECT 1 FROM workspace_events WHERE space_id = ? AND type = 'workspace.member_joined' LIMIT 1
  `).get(DEFAULT_SPACE_ID);

  if (!existingEvent) {
    db.prepare(`
      INSERT INTO workspace_events (
        id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
      )
      VALUES (?, ?, 1, 'workspace.member_joined', ?, NULL, 'user', ?, ?, ?)
    `).run(
      "evt_seed_owner",
      DEFAULT_SPACE_ID,
      SEEDED_OWNER_ID,
      SEEDED_OWNER_ID,
      JSON.stringify({ userId: SEEDED_OWNER_ID, role: "owner" }),
      now
    );
  }

  const existingAudit = db.prepare(`
    SELECT 1 FROM audit_logs WHERE id = 'aud_seed_owner'
  `).get();

  if (!existingAudit) {
    db.prepare(`
      INSERT INTO audit_logs (
        id, space_id, actor_user_id, actor_github_login, action, target_type, target_id,
        result, reason, ip_address, user_agent, request_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "aud_seed_owner",
      DEFAULT_SPACE_ID,
      SEEDED_OWNER_ID,
      SEEDED_OWNER_GITHUB_LOGIN,
      "workspace.owner.seeded",
      "workspace",
      DEFAULT_SPACE_ID,
      "success",
      "development bootstrap",
      "127.0.0.1",
      "duallane-seed",
      "seed",
      now
    );
  }
}
