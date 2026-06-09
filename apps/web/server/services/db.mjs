import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export function openDatabase(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "duallane.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  seedDevelopmentWorkspace(db);
  return db;
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_login TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'auditor')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      default_role TEXT NOT NULL CHECK (default_role IN ('owner', 'admin', 'member', 'auditor')),
      created_by TEXT,
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
      title TEXT NOT NULL,
      retention_count INTEGER NOT NULL DEFAULT 10000,
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT,
      uploader_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (uploader_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS transfer_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
      byte_size INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'failed', 'rejected')),
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
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
      FOREIGN KEY (actor_user_id) REFERENCES users(id)
    );
  `);
}

function seedDevelopmentWorkspace(db) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM users").get();
  if (existing.count > 0) {
    return;
  }

  const now = new Date().toISOString();
  const ownerId = "usr_owner";
  const adminId = "usr_admin";
  const memberId = "usr_member";
  const conversationId = "conv_ops";

  const insertUser = db.prepare(`
    INSERT INTO users (id, github_login, display_name, role, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertUser.run(ownerId, "timeStarry", "timeStarry", "owner", now);
  insertUser.run(adminId, "relay-admin", "Relay Admin", "admin", now);
  insertUser.run(memberId, "lane-member", "Lane Member", "member", now);

  db.prepare(`
    INSERT INTO invites (id, code, default_role, created_by, max_uses, uses, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("inv_demo", "DUALLANE-DEMO", "member", ownerId, 10, 1, null, now);

  db.prepare(`
    INSERT INTO conversations (id, type, title, retention_count, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(conversationId, "group", "Operations", 10000, ownerId, now);

  const insertMember = db.prepare(`
    INSERT INTO conversation_members (conversation_id, user_id, joined_at)
    VALUES (?, ?, ?)
  `);
  for (const userId of [ownerId, adminId, memberId]) {
    insertMember.run(conversationId, userId, now);
  }

  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertMessage.run("msg_hello", conversationId, ownerId, "Workspace relay is persistent and audited.", now);
  insertMessage.run("msg_quota", conversationId, adminId, "File quota defaults to 2 GiB per user per day.", now);

  db.prepare(`
    INSERT INTO audit_logs (
      id, actor_user_id, actor_github_login, action, target_type, target_id,
      result, reason, ip_address, user_agent, request_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "aud_seed",
    ownerId,
    "timeStarry",
    "workspace.seeded",
    "workspace",
    "default",
    "success",
    "development bootstrap",
    "127.0.0.1",
    "duallane-seed",
    "seed",
    now
  );
}
