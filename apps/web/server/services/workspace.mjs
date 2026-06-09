import { canReserveQuota, DAILY_QUOTA_BYTES, remainingQuota } from "./quota.mjs";
import { writeAudit } from "./audit.mjs";

export function getWorkspaceBootstrap(db, userId = "usr_owner") {
  const currentUser = db.prepare(`
    SELECT id, github_login AS githubLogin, display_name AS displayName, role, created_at AS createdAt
    FROM users
    WHERE id = ?
  `).get(userId);

  const users = db.prepare(`
    SELECT id, github_login AS githubLogin, display_name AS displayName, role, created_at AS createdAt
    FROM users
    ORDER BY
      CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'auditor' THEN 3 ELSE 4 END,
      display_name
  `).all();

  const invites = db.prepare(`
    SELECT id, code, default_role AS defaultRole, max_uses AS maxUses, uses, expires_at AS expiresAt, created_at AS createdAt
    FROM invites
    ORDER BY created_at DESC
    LIMIT 20
  `).all();

  const audits = db.prepare(`
    SELECT
      id,
      actor_github_login AS actorGithubLogin,
      action,
      target_type AS targetType,
      target_id AS targetId,
      result,
      reason,
      created_at AS createdAt
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT 30
  `).all();

  return {
    auth: {
      mode: "development",
      githubOAuthReady: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
      inviteOnly: true,
      currentUser
    },
    policy: {
      dailyQuotaBytes: DAILY_QUOTA_BYTES,
      relayRetentionCount: 10000,
      auditRetention: "permanent"
    },
    users,
    invites,
    audits
  };
}

export function listConversations(db, userId = "usr_owner") {
  const conversations = db.prepare(`
    SELECT
      c.id,
      c.type,
      c.title,
      c.retention_count AS retentionCount,
      c.created_at AS createdAt,
      (
        SELECT COUNT(*)
        FROM messages m
        WHERE m.conversation_id = c.id
      ) AS messageCount
    FROM conversations c
    INNER JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE cm.user_id = ?
    ORDER BY c.created_at DESC
  `).all(userId);

  const messageStatement = db.prepare(`
    SELECT
      m.id,
      m.conversation_id AS conversationId,
      m.author_id AS authorId,
      u.display_name AS authorName,
      u.github_login AS authorGithubLogin,
      m.body,
      m.created_at AS createdAt
    FROM messages m
    INNER JOIN users u ON u.id = m.author_id
    WHERE m.conversation_id = ?
    ORDER BY m.created_at ASC
    LIMIT 80
  `);

  return conversations.map((conversation) => ({
    ...conversation,
    messages: messageStatement.all(conversation.id)
  }));
}

export function createRelayMessage(db, request, input) {
  const authorId = input.authorId || "usr_owner";
  const conversationId = input.conversationId;
  const body = typeof input.body === "string" ? input.body.trim() : "";

  if (!conversationId || !body) {
    throw new WorkspaceValidationError("conversationId and body are required");
  }

  const membership = db.prepare(`
    SELECT 1
    FROM conversation_members
    WHERE conversation_id = ? AND user_id = ?
  `).get(conversationId, authorId);

  if (!membership) {
    writeAudit(db, {
      actorUserId: authorId,
      action: "message.create",
      targetType: "conversation",
      targetId: conversationId,
      result: "rejected",
      reason: "not a conversation member",
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      requestId: request.id
    });
    throw new WorkspaceValidationError("user is not a member of this conversation");
  }

  const author = db.prepare("SELECT github_login AS githubLogin, display_name AS displayName FROM users WHERE id = ?").get(authorId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO messages (id, conversation_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, conversationId, authorId, body, now);

  enforceRetention(db, conversationId);

  writeAudit(db, {
    actorUserId: authorId,
    actorGithubLogin: author?.githubLogin,
    action: "message.create",
    targetType: "conversation",
    targetId: conversationId,
    result: "success",
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    requestId: request.id
  });

  return {
    id,
    conversationId,
    authorId,
    authorName: author?.displayName ?? "Unknown",
    authorGithubLogin: author?.githubLogin ?? "unknown",
    body,
    createdAt: now
  };
}

export function reserveTransferQuota(db, request, input) {
  const userId = input.userId || "usr_owner";
  const direction = input.direction;
  const byteSize = Number(input.byteSize);

  if (!["upload", "download"].includes(direction) || !Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new WorkspaceValidationError("direction and byteSize are required");
  }

  const usedToday = getUsedToday(db, userId);
  const allowed = canReserveQuota(usedToday, byteSize);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const user = db.prepare("SELECT github_login AS githubLogin FROM users WHERE id = ?").get(userId);

  if (!allowed) {
    db.prepare(`
      INSERT INTO transfer_ledger (id, user_id, direction, byte_size, status, created_at, completed_at)
      VALUES (?, ?, ?, ?, 'rejected', ?, ?)
    `).run(id, userId, direction, byteSize, now, now);

    writeAudit(db, {
      actorUserId: userId,
      actorGithubLogin: user?.githubLogin,
      action: `file.${direction}.rejected`,
      targetType: "transfer",
      targetId: id,
      result: "rejected",
      reason: "insufficient daily quota",
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      requestId: request.id
    });

    return {
      id,
      status: "rejected",
      usedToday,
      remainingBytes: remainingQuota(usedToday),
      dailyQuotaBytes: DAILY_QUOTA_BYTES
    };
  }

  db.prepare(`
    INSERT INTO transfer_ledger (id, user_id, direction, byte_size, status, created_at, completed_at)
    VALUES (?, ?, ?, ?, 'completed', ?, ?)
  `).run(id, userId, direction, byteSize, now, now);

  writeAudit(db, {
    actorUserId: userId,
    actorGithubLogin: user?.githubLogin,
    action: `file.${direction}.completed`,
    targetType: "transfer",
    targetId: id,
    result: "success",
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    requestId: request.id
  });

  const updatedUsed = usedToday + byteSize;
  return {
    id,
    status: "completed",
    usedToday: updatedUsed,
    remainingBytes: remainingQuota(updatedUsed),
    dailyQuotaBytes: DAILY_QUOTA_BYTES
  };
}

function enforceRetention(db, conversationId) {
  const conversation = db.prepare(`
    SELECT retention_count AS retentionCount
    FROM conversations
    WHERE id = ?
  `).get(conversationId);

  if (!conversation) {
    return;
  }

  db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ?
      AND id NOT IN (
        SELECT id
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
  `).run(conversationId, conversationId, conversation.retentionCount);
}

function getUsedToday(db, userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const row = db.prepare(`
    SELECT COALESCE(SUM(byte_size), 0) AS used
    FROM transfer_ledger
    WHERE user_id = ?
      AND status IN ('reserved', 'completed')
      AND created_at >= ?
  `).get(userId, startOfDay.toISOString());
  return row.used;
}

export class WorkspaceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}
