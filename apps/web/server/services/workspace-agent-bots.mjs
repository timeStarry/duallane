import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeAudit } from "./audit.mjs";

export const CUSTOM_BOT_MODE = "external_agent";
export const BOT_STATUS = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  DELETING: "deleting",
  DELETED: "deleted"
});
export const BOT_VISIBILITY_POLICIES = Object.freeze({
  PRIVATE: "private",
  SPECIFIED_MEMBERS: "specified_members",
  SPACE_MEMBERS: "space_members",
  GROUPS: "groups"
});
export const BOT_CONVERSATION_POLICIES = Object.freeze({
  DIRECT_ONLY: "direct-only",
  GROUP_CAPABLE: "group-capable"
});
export const BOT_TRIGGER_POLICIES = Object.freeze({
  MENTION_OR_COMMAND: "mention-or-command"
});

export const BOT_SCOPE_ALLOWLIST = Object.freeze([
  "messages:read_trigger",
  "messages:read_context",
  "messages:send",
  "cards:write",
  "cards:act",
  "files:read_metadata",
  "files:read_preview",
  "files:read_content",
  "files:write",
  "commands:receive"
]);
export const BOT_DEFAULT_SCOPES = Object.freeze([
  "messages:read_trigger",
  "messages:send",
  "commands:receive"
]);

const FORBIDDEN_SCOPE_NAMES = new Set([
  "owner",
  "owner:impersonate",
  "session",
  "session:issue",
  "workspace:session",
  "user:impersonate",
  "identity:impersonate"
]);
const BOT_TOKEN_PREFIX = "dl_bot_";
const BOT_TOKEN_BYTES = 32;
const MAX_BOT_NAME_CODE_POINTS = 64;
const MAX_TOKEN_EXPIRY_MS = 366 * 24 * 60 * 60 * 1000;

// These names include public labels and server-only identifiers. Comparison is
// Unicode-normalized and case-insensitive so a custom Bot cannot claim an
// official system identity through casing or compatibility characters.
export const RESERVED_BOT_NAMES = Object.freeze([
  "信标",
  "回声",
  "Beacon",
  "Echo",
  "DualLane",
  "usr_system_beacon",
  "usr_system_echo",
  "__duallane_beacon__",
  "__duallane_echo__"
]);
const RESERVED_BOT_NAME_KEYS = new Set(RESERVED_BOT_NAMES.map(normalizeNameKey));

export class WorkspaceAgentBotError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceAgentBotError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createWorkspaceAgentBotService({ db, now = () => new Date(), idFactory = randomUUID }) {
  if (!db) throw new Error("Workspace agent bot service requires a database");

  async function createBot(actorUserId, input = {}) {
    const actor = await requireActiveHumanMember(actorUserId, input.spaceId);
    let name;
    try {
      name = normalizeBotName(input.name);
    } catch (error) {
      await auditRejection(actor, "bot.create", "agent_bot", null, error.code ?? "bot.invalid_name");
      throw error;
    }
    if (isReservedBotName(name)) {
      await auditRejection(actor, "bot.create", "agent_bot", null, "bot.reserved_name");
      throw new WorkspaceAgentBotError("bot.reserved_name", "该名称为系统保留名称");
    }

    const createdAt = now().toISOString();
    const botId = `bot_${idFactory()}`;
    const botUserId = `usr_bot_${idFactory()}`;
    const botGithubLogin = `__duallane_bot_${botId}`;
    const nameNormalized = normalizeNameKey(name);
    let bot;
    try {
      bot = await db.transaction(async () => {
        await db.lock?.(`workspace-agent-bot:create:${actor.spaceId}:${actor.id}`);
        const existing = await db.prepare(`
          SELECT id FROM workspace_agent_bots
          WHERE space_id = ? AND owner_user_id = ? AND status <> 'deleted'
        `).get(actor.spaceId, actor.id);
        if (existing) {
          throw new WorkspaceAgentBotError("bot.already_exists", "每个空间只能创建一个自定义 Bot", 409);
        }

        await db.prepare(`
          INSERT INTO users (
            id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
          ) VALUES (?, NULL, ?, NULL, ?, NULL, 'bot', ?, NULL)
        `).run(botUserId, botGithubLogin, name, createdAt);
        await db.prepare(`
          INSERT INTO workspace_agent_bots (
            id, space_id, owner_user_id, bot_user_id, mode, name, name_normalized,
            visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          botId,
          actor.spaceId,
          actor.id,
          botUserId,
          CUSTOM_BOT_MODE,
          name,
          nameNormalized,
          BOT_VISIBILITY_POLICIES.PRIVATE,
          BOT_CONVERSATION_POLICIES.DIRECT_ONLY,
          BOT_TRIGGER_POLICIES.MENTION_OR_COMMAND,
          BOT_STATUS.ACTIVE,
          createdAt,
          createdAt
        );
        await db.prepare(`
          INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
          VALUES (?, ?, 'member', ?, NULL)
          ON CONFLICT (space_id, user_id) DO UPDATE SET
            role = 'member', removed_at = NULL
        `).run(actor.spaceId, botUserId, createdAt);
        return readBot(botId);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        await auditRejection(actor, "bot.create", "agent_bot", null, "bot.already_exists");
        throw new WorkspaceAgentBotError("bot.already_exists", "每个空间只能创建一个自定义 Bot", 409);
      }
      if (error instanceof WorkspaceAgentBotError) {
        await auditRejection(actor, "bot.create", "agent_bot", null, error.code);
      }
      throw error;
    }
    await writeBotAudit({
      actor,
      spaceId: actor.spaceId,
      action: "bot.create",
      targetType: "agent_bot",
      targetId: bot.id,
      result: "success"
    });
    return publicBot(bot);
  }

  async function getOwnedBot(actorUserId, spaceId, botId = null) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const bot = botId
      ? await readBot(botId)
      : await readBotByOwner(actor.spaceId, actor.id);
    if (bot && (bot.spaceId !== actor.spaceId || bot.ownerUserId !== actor.id)) {
      await auditRejection(actor, "bot.read", "agent_bot", bot.id, "permission.denied");
      throw new WorkspaceAgentBotError("permission.denied", "无权操作该 Bot", 403);
    }
    if (!bot) throw new WorkspaceAgentBotError("bot.not_found", "Bot 不存在", 404);
    return publicBot(bot);
  }

  async function pauseBot(actorUserId, botId, spaceId) {
    return transitionBot(actorUserId, botId, spaceId, BOT_STATUS.PAUSED, [BOT_STATUS.ACTIVE], "bot.pause");
  }

  async function resumeBot(actorUserId, botId, spaceId) {
    return transitionBot(actorUserId, botId, spaceId, BOT_STATUS.ACTIVE, [BOT_STATUS.PAUSED], "bot.resume");
  }

  async function beginDeleteBot(actorUserId, botId, spaceId) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const updatedAt = now().toISOString();
    let transition;
    try {
      transition = await db.transaction(async () => {
        await db.lock?.(botLifecycleLockKey(actor.spaceId, botId));
        const bot = await requireOwnedBot(actor, botId);
        if (bot.status === BOT_STATUS.DELETED || bot.status === BOT_STATUS.DELETING) {
          return { bot, changed: false };
        }
        if (![BOT_STATUS.ACTIVE, BOT_STATUS.PAUSED].includes(bot.status)) {
          throw new WorkspaceAgentBotError("bot.invalid_transition", "Bot 当前状态不允许删除");
        }
        const result = await db.prepare(`
          UPDATE workspace_agent_bots
          SET status = ?, deleting_at = ?, updated_at = ?
          WHERE id = ? AND owner_user_id = ? AND space_id = ?
            AND status IN (?, ?)
        `).run(
          BOT_STATUS.DELETING,
          updatedAt,
          updatedAt,
          bot.id,
          actor.id,
          actor.spaceId,
          BOT_STATUS.ACTIVE,
          BOT_STATUS.PAUSED
        );
        if (!result.changes) {
          throw new WorkspaceAgentBotError("bot.invalid_transition", "Bot 当前状态不允许删除");
        }
        await db.prepare(`
          UPDATE workspace_agent_bot_tokens SET revoked_at = COALESCE(revoked_at, ?)
          WHERE bot_id = ?
        `).run(updatedAt, bot.id);
        return { bot: await readBot(bot.id), changed: true };
      });
    } catch (error) {
      if (error instanceof WorkspaceAgentBotError) {
        await auditRejection(actor, "bot.delete.requested", "agent_bot", botId, error.code);
      }
      throw error;
    }
    const updated = transition.bot;
    if (!transition.changed) return publicBot(updated);
    await writeBotAudit({ actor, spaceId: actor.spaceId, action: "bot.delete.requested", targetType: "agent_bot", targetId: updated.id, result: "success" });
    return publicBot(updated);
  }

  async function finalizeDeleteBot(actorUserId, botId, spaceId) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const deletedAt = now().toISOString();
    let transition;
    try {
      transition = await db.transaction(async () => {
        await db.lock?.(botLifecycleLockKey(actor.spaceId, botId));
        const bot = await requireOwnedBot(actor, botId);
        if (bot.status === BOT_STATUS.DELETED) return { bot, changed: false };
        if (bot.status !== BOT_STATUS.DELETING) {
          throw new WorkspaceAgentBotError("bot.invalid_transition", "Bot 必须先进入待删除状态");
        }
        const result = await db.prepare(`
          UPDATE workspace_agent_bots SET status = ?, deleted_at = ?, updated_at = ?
          WHERE id = ? AND owner_user_id = ? AND space_id = ? AND status = ?
        `).run(BOT_STATUS.DELETED, deletedAt, deletedAt, bot.id, actor.id, actor.spaceId, BOT_STATUS.DELETING);
        if (!result.changes) {
          throw new WorkspaceAgentBotError("bot.invalid_transition", "Bot 必须先进入待删除状态");
        }
        await db.prepare(`
          UPDATE workspace_agent_bot_tokens SET revoked_at = COALESCE(revoked_at, ?)
          WHERE bot_id = ?
        `).run(deletedAt, bot.id);
        await db.prepare(`
          UPDATE space_members SET removed_at = ?
          WHERE space_id = ? AND user_id = ? AND removed_at IS NULL
        `).run(deletedAt, actor.spaceId, bot.botUserId);
        return { bot: await readBot(bot.id), changed: true };
      });
    } catch (error) {
      if (error instanceof WorkspaceAgentBotError) {
        await auditRejection(actor, "bot.delete.completed", "agent_bot", botId, error.code);
      }
      throw error;
    }
    const updated = transition.bot;
    if (!transition.changed) return publicBot(updated);
    await writeBotAudit({ actor, spaceId: actor.spaceId, action: "bot.delete.completed", targetType: "agent_bot", targetId: updated.id, result: "success" });
    return publicBot(updated);
  }

  async function issueToken(actorUserId, botId, input = {}) {
    const actor = await requireActiveHumanMember(actorUserId, input.spaceId);
    // Resolve ownership before validating caller-controlled scope input. This
    // preserves the stable permission boundary (a missing/foreign Bot never
    // reveals whether its requested scopes would be valid), while the same
    // ownership and active-status checks are repeated under the lifecycle lock
    // immediately before insertion below.
    const targetBot = await requireOwnedBotWithAudit(actor, botId, "bot.token.issue", "agent_bot");
    let scopes;
    try {
      scopes = validateBotScopes(input.scopes);
    } catch (error) {
      await auditRejection(actor, "bot.token.issue", "agent_bot", targetBot.id, error.code ?? "bot.invalid_scope");
      throw error;
    }
    let expiresAt;
    try {
      expiresAt = normalizeExpiry(input.expiresAt, now());
    } catch (error) {
      await auditRejection(actor, "bot.token.issue", "agent_bot", targetBot.id, error.code ?? "bot.invalid_expiry");
      throw error;
    }
    const token = `${BOT_TOKEN_PREFIX}${randomBytes(BOT_TOKEN_BYTES).toString("base64url")}`;
    const tokenHash = hashBotToken(token);
    const tokenId = `btk_${idFactory()}`;
    const createdAt = now().toISOString();
    let issued;
    try {
      issued = await db.transaction(async () => {
        await db.lock?.(botLifecycleLockKey(actor.spaceId, botId));
        const bot = await requireOwnedBot(actor, botId);
        if (bot.status !== BOT_STATUS.ACTIVE) {
          throw new WorkspaceAgentBotError("bot.not_active", "仅启用中的 Bot 可以生成 Token");
        }
        await db.prepare(`
          INSERT INTO workspace_agent_bot_tokens (
            id, bot_id, space_id, token_hash, scopes_json, expires_at, revoked_at, last_used_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        `).run(tokenId, bot.id, actor.spaceId, tokenHash, JSON.stringify(scopes), expiresAt, createdAt);
        return { bot };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        await auditRejection(actor, "bot.token.issue", "agent_bot", botId, "bot.token_issue_failed");
        throw new WorkspaceAgentBotError("bot.token_issue_failed", "暂时无法生成 Bot Token，请重试", 503);
      }
      if (error instanceof WorkspaceAgentBotError) {
        await auditRejection(actor, "bot.token.issue", "agent_bot", botId, error.code);
      }
      throw error;
    }
    await writeBotAudit({ actor, spaceId: actor.spaceId, action: "bot.token.issue", targetType: "agent_bot", targetId: issued.bot.id, result: "success" });
    return {
      id: tokenId,
      botId: issued.bot.id,
      scopes,
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      createdAt,
      token
    };
  }

  async function listTokens(actorUserId, botId, spaceId) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.token.list", "agent_bot");
    const rows = await db.prepare(`
      SELECT id, bot_id AS botId, scopes_json AS scopesJson, expires_at AS expiresAt,
             revoked_at AS revokedAt, last_used_at AS lastUsedAt, created_at AS createdAt
      FROM workspace_agent_bot_tokens WHERE bot_id = ? ORDER BY created_at DESC
    `).all(bot.id);
    return rows.map((row) => ({
      id: row.id,
      botId: row.botId,
      scopes: parseScopes(row.scopesJson),
      expiresAt: row.expiresAt ?? null,
      revokedAt: row.revokedAt ?? null,
      lastUsedAt: row.lastUsedAt ?? null,
      createdAt: row.createdAt,
      token: maskBotToken()
    }));
  }

  async function revokeToken(actorUserId, botId, tokenId, spaceId) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.token.revoke", "agent_bot");
    const revokedAt = now().toISOString();
    const result = await db.prepare(`
      UPDATE workspace_agent_bot_tokens SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ? AND bot_id = ?
    `).run(revokedAt, tokenId, bot.id);
    if (!result.changes) {
      await auditRejection(actor, "bot.token.revoke", "agent_bot_token", tokenId, "bot.token_not_found");
      throw new WorkspaceAgentBotError("bot.token_not_found", "Bot Token 不存在", 404);
    }
    await writeBotAudit({ actor, spaceId: actor.spaceId, action: "bot.token.revoke", targetType: "agent_bot_token", targetId: tokenId, result: "success" });
    const row = await db.prepare(`
      SELECT id, bot_id AS botId, scopes_json AS scopesJson, expires_at AS expiresAt,
             revoked_at AS revokedAt, last_used_at AS lastUsedAt, created_at AS createdAt
      FROM workspace_agent_bot_tokens WHERE id = ?
    `).get(tokenId);
    return {
      id: row.id,
      botId: row.botId,
      scopes: parseScopes(row.scopesJson),
      expiresAt: row.expiresAt ?? null,
      revokedAt: row.revokedAt ?? null,
      lastUsedAt: row.lastUsedAt ?? null,
      createdAt: row.createdAt,
      token: maskBotToken()
    };
  }

  async function authenticateToken(rawToken, options = {}) {
    if (!isBotToken(rawToken)) throw invalidBotToken();
    const tokenHash = hashBotToken(rawToken);
    const row = await db.prepare(`
      SELECT t.id AS tokenId, t.bot_id AS botId, t.space_id AS spaceId,
             t.scopes_json AS scopesJson, t.expires_at AS expiresAt, t.revoked_at AS revokedAt,
             b.owner_user_id AS ownerUserId, b.bot_user_id AS botUserId,
             b.name, b.name_normalized AS nameNormalized, b.visibility_policy AS visibilityPolicy,
             b.conversation_policy AS conversationPolicy, b.trigger_policy AS triggerPolicy,
             b.status, b.mode, b.created_at AS createdAt, b.updated_at AS updatedAt,
             u.github_login AS githubLogin
      FROM workspace_agent_bot_tokens t
      INNER JOIN workspace_agent_bots b ON b.id = t.bot_id
      INNER JOIN users u ON u.id = b.bot_user_id AND u.kind = 'bot'
      WHERE t.token_hash = ?
    `).get(tokenHash);
    if (!row || row.revokedAt || row.status !== BOT_STATUS.ACTIVE || isExpired(row.expiresAt, now())) {
      throw invalidBotToken();
    }
    if (options.spaceId && options.spaceId !== row.spaceId) throw invalidBotToken();
    const usedAt = now().toISOString();
    // This conditional write is the authentication linearization point. A
    // revoke, pause, or delete that commits first makes the update affect zero
    // rows, so no caller can receive a successful identity after the state
    // change wins the race.
    const marked = await db.prepare(`
      UPDATE workspace_agent_bot_tokens
      SET last_used_at = ?
      WHERE id = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND EXISTS (
          SELECT 1 FROM workspace_agent_bots
          WHERE id = ? AND status = 'active'
        )
    `).run(usedAt, row.tokenId, usedAt, row.botId);
    if (!marked.changes) throw invalidBotToken();
    return {
      tokenId: row.tokenId,
      bot: normalizeBotRow(row),
      botId: row.botId,
      userId: row.botUserId,
      spaceId: row.spaceId,
      ownerUserId: row.ownerUserId,
      scopes: parseScopes(row.scopesJson),
      lastUsedAt: usedAt
    };
  }

  async function readBot(botId) {
    return db.prepare(`
      SELECT b.id, b.space_id AS spaceId, b.owner_user_id AS ownerUserId, b.bot_user_id AS botUserId,
             b.mode, b.name, b.name_normalized AS nameNormalized, b.visibility_policy AS visibilityPolicy,
             b.conversation_policy AS conversationPolicy, b.trigger_policy AS triggerPolicy,
             b.status, b.created_at AS createdAt, b.updated_at AS updatedAt,
             b.deleting_at AS deletingAt, b.deleted_at AS deletedAt,
             u.github_login AS githubLogin
      FROM workspace_agent_bots b
      INNER JOIN users u ON u.id = b.bot_user_id
      WHERE b.id = ?
    `).get(botId);
  }

  async function readBotByOwner(spaceId, ownerUserId) {
    return db.prepare(`
      SELECT b.id, b.space_id AS spaceId, b.owner_user_id AS ownerUserId, b.bot_user_id AS botUserId,
             b.mode, b.name, b.name_normalized AS nameNormalized, b.visibility_policy AS visibilityPolicy,
             b.conversation_policy AS conversationPolicy, b.trigger_policy AS triggerPolicy,
             b.status, b.created_at AS createdAt, b.updated_at AS updatedAt,
             b.deleting_at AS deletingAt, b.deleted_at AS deletedAt,
             u.github_login AS githubLogin
      FROM workspace_agent_bots b
      INNER JOIN users u ON u.id = b.bot_user_id
      WHERE b.space_id = ? AND b.owner_user_id = ?
      ORDER BY CASE WHEN b.status <> 'deleted' THEN 0 ELSE 1 END,
               b.updated_at DESC, b.created_at DESC
      LIMIT 1
    `).get(spaceId, ownerUserId);
  }

  async function transitionBot(actorUserId, botId, spaceId, targetStatus, fromStatuses, action) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const updatedAt = now().toISOString();
    let transition;
    try {
      transition = await db.transaction(async () => {
        await db.lock?.(botLifecycleLockKey(actor.spaceId, botId));
        const bot = await requireOwnedBot(actor, botId);
        if (bot.status === targetStatus) return { bot, changed: false };
        if (!fromStatuses.includes(bot.status)) {
          throw new WorkspaceAgentBotError("bot.invalid_transition", "Bot 当前状态不允许执行该操作");
        }
        const result = await db.prepare(`
          UPDATE workspace_agent_bots SET status = ?, updated_at = ?
          WHERE id = ? AND owner_user_id = ? AND space_id = ? AND status IN (${fromStatuses.map(() => "?").join(", ")})
        `).run(targetStatus, updatedAt, bot.id, actor.id, actor.spaceId, ...fromStatuses);
        if (!result.changes) {
          throw new WorkspaceAgentBotError("bot.invalid_transition", "Bot 当前状态不允许执行该操作");
        }
        return { bot: await readBot(bot.id), changed: true };
      });
    } catch (error) {
      if (error instanceof WorkspaceAgentBotError) {
        await auditRejection(actor, action, "agent_bot", botId, error.code);
      }
      throw error;
    }
    if (!transition.changed) return publicBot(transition.bot);
    await writeBotAudit({ actor, spaceId: actor.spaceId, action, targetType: "agent_bot", targetId: transition.bot.id, result: "success" });
    return publicBot(transition.bot);
  }

  async function requireOwnedBot(actor, botId) {
    const bot = await readBot(botId);
    if (!bot || bot.spaceId !== actor.spaceId || bot.ownerUserId !== actor.id) {
      throw new WorkspaceAgentBotError("permission.denied", "无权操作该 Bot", 403);
    }
    return bot;
  }

  async function requireOwnedBotWithAudit(actor, botId, action, targetType) {
    try {
      return await requireOwnedBot(actor, botId);
    } catch (error) {
      if (error instanceof WorkspaceAgentBotError) {
        await auditRejection(actor, action, targetType, botId, error.code);
      }
      throw error;
    }
  }

  async function writeBotAudit({ actor, spaceId, action, targetType, targetId, result, reason }) {
    await writeAudit(db, {
      spaceId,
      actorUserId: actor?.id ?? null,
      actorGithubLogin: actor?.githubLogin ?? null,
      action,
      targetType,
      targetId: targetId ?? null,
      result,
      reason: reason ?? null
    });
  }

  async function auditRejection(actor, action, targetType, targetId, reason) {
    return writeBotAudit({
      actor,
      spaceId: actor.spaceId,
      action,
      targetType,
      targetId,
      result: "rejected",
      reason
    });
  }

  async function requireActiveHumanMember(userId, requestedSpaceId) {
    const spaceId = normalizeSpaceId(requestedSpaceId);
    const actor = await db.prepare(`
      SELECT u.id, u.github_login AS githubLogin, u.kind, sm.space_id AS spaceId,
             sm.role, sm.removed_at AS removedAt
      FROM users u
      INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ?
      WHERE u.id = ?
    `).get(spaceId, userId);
    if (!actor || actor.kind !== "human" || actor.removedAt) {
      throw new WorkspaceAgentBotError("permission.denied", "需要有效的 Workspace 成员身份", 403);
    }
    return actor;
  }

  return Object.freeze({
    createBot,
    getOwnedBot,
    pauseBot,
    resumeBot,
    beginDeleteBot,
    finalizeDeleteBot,
    issueToken,
    listTokens,
    revokeToken,
    authenticateToken,
    readBot
  });
}

export function normalizeBotName(value) {
  const normalized = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  const codePointLength = Array.from(normalized).length;
  if (codePointLength < 1 || codePointLength > MAX_BOT_NAME_CODE_POINTS || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new WorkspaceAgentBotError("bot.invalid_name", "Bot 名称无效");
  }
  return normalized;
}

export function normalizeNameKey(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function isReservedBotName(value) {
  const normalized = normalizeNameKey(value);
  return Boolean(normalized) && RESERVED_BOT_NAME_KEYS.has(normalized);
}

export function getDefaultBotPolicy() {
  return {
    mode: CUSTOM_BOT_MODE,
    visibilityPolicy: BOT_VISIBILITY_POLICIES.PRIVATE,
    conversationPolicy: BOT_CONVERSATION_POLICIES.DIRECT_ONLY,
    triggerPolicy: BOT_TRIGGER_POLICIES.MENTION_OR_COMMAND
  };
}

export function canBotParticipateInConversation(bot, {
  conversationType,
  actorUserId,
  isMember = false,
  isExplicitTrigger = false
} = {}) {
  if (!bot || bot.status !== BOT_STATUS.ACTIVE || bot.mode !== CUSTOM_BOT_MODE) return false;
  if (!isExplicitTrigger) return false;
  if (conversationType === "direct") {
    if (bot.visibilityPolicy === BOT_VISIBILITY_POLICIES.PRIVATE) {
      return actorUserId === bot.ownerUserId;
    }
    return isMember || actorUserId === bot.ownerUserId;
  }
  if (conversationType === "group") {
    return bot.conversationPolicy === BOT_CONVERSATION_POLICIES.GROUP_CAPABLE &&
      bot.visibilityPolicy !== BOT_VISIBILITY_POLICIES.PRIVATE && isMember;
  }
  return false;
}

export function validateBotScopes(input) {
  const scopes = input === undefined ? [...BOT_DEFAULT_SCOPES] : input;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new WorkspaceAgentBotError("bot.invalid_scope", "Bot Scope 无效");
  }
  const seen = new Set();
  for (const value of scopes) {
    if (typeof value !== "string" || !BOT_SCOPE_ALLOWLIST.includes(value) || FORBIDDEN_SCOPE_NAMES.has(value) || seen.has(value)) {
      throw new WorkspaceAgentBotError("bot.invalid_scope", "Bot Scope 无效");
    }
    seen.add(value);
  }
  return BOT_SCOPE_ALLOWLIST.filter((scope) => seen.has(scope));
}

export function hashBotToken(value) {
  if (typeof value !== "string" || !isBotToken(value)) return null;
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isBotToken(value) {
  return typeof value === "string" && new RegExp(`^${BOT_TOKEN_PREFIX}[A-Za-z0-9_-]{${Math.ceil(BOT_TOKEN_BYTES * 4 / 3)},}$`, "u").test(value);
}

export function maskBotToken() {
  return `${BOT_TOKEN_PREFIX}••••••••`;
}

export function canBotAuthenticate(kind) {
  return kind !== "bot" && kind !== "system";
}

export function canBotJoinConversation(bot, options) {
  return canBotParticipateInConversation(bot, options);
}

function normalizeExpiry(value, current) {
  if (value === undefined || value === null || value === "") return null;
  const expiry = new Date(value);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= current.getTime() || expiry.getTime() > current.getTime() + MAX_TOKEN_EXPIRY_MS) {
    throw new WorkspaceAgentBotError("bot.invalid_expiry", "Token 有效期无效");
  }
  return expiry.toISOString();
}

function parseScopes(value) {
  try {
    return validateBotScopes(JSON.parse(value));
  } catch {
    return [];
  }
}

function isExpired(value, current) {
  return Boolean(value && new Date(value).getTime() <= current.getTime());
}

function invalidBotToken() {
  return new WorkspaceAgentBotError("bot.invalid_token", "Bot Token 无效或已失效", 401);
}

function normalizeSpaceId(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceAgentBotError("space.invalid", "Workspace 空间无效");
  }
  return value;
}

function botLifecycleLockKey(spaceId, botId) {
  return `workspace-agent-bot:lifecycle:${spaceId}:${botId}`;
}

function normalizeBotRow(row) {
  return {
    id: row.id ?? row.botId,
    spaceId: row.spaceId,
    ownerUserId: row.ownerUserId,
    botUserId: row.botUserId,
    mode: row.mode,
    name: row.name,
    nameNormalized: row.nameNormalized,
    visibilityPolicy: row.visibilityPolicy,
    conversationPolicy: row.conversationPolicy,
    triggerPolicy: row.triggerPolicy,
    status: row.status,
    githubLogin: row.githubLogin ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletingAt: row.deletingAt ?? null,
    deletedAt: row.deletedAt ?? null
  };
}

function publicBot(row) {
  const normalized = normalizeBotRow(row);
  return {
    ...normalized,
    kind: "bot",
    authenticationAllowed: false,
    canJoinGroups: normalized.conversationPolicy === BOT_CONVERSATION_POLICIES.GROUP_CAPABLE,
    tokenPolicy: "hashed-one-time"
  };
}

function isUniqueConstraintError(error) {
  return Boolean(error && (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505" || /unique constraint|duplicate key/i.test(error.message ?? "")));
}
