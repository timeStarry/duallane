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
        await ensureBotConfiguration(db, botId, actor.spaceId, createdAt);
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

  async function listOwnedBots(actorUserId, spaceId) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const rows = await db.prepare(`
      SELECT b.id
      FROM workspace_agent_bots b
      WHERE b.space_id = ? AND b.owner_user_id = ? AND b.status <> 'deleted'
      ORDER BY b.created_at DESC
    `).all(actor.spaceId, actor.id);
    return Promise.all(rows.map(async ({ id }) => publicBot(await readBot(id))));
  }

  async function getSettings(actorUserId, botId, spaceId) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.settings.read", "agent_bot");
    await ensureBotConfiguration(db, bot.id, bot.spaceId, bot.updatedAt ?? now().toISOString());
    return publicBotSettings(await readSettings(db, bot.id), bot);
  }

  async function updateSettings(actorUserId, botId, input = {}) {
    const actor = await requireActiveHumanMember(actorUserId, input.spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.settings.update", "agent_bot");
    const patch = normalizeSettingsPatch(input);
    const updatedAt = now().toISOString();
    let settings;
    try {
      settings = await db.transaction(async () => {
        await db.lock?.(botLifecycleLockKey(actor.spaceId, bot.id));
        const currentBot = await requireOwnedBot(actor, bot.id);
        if (currentBot.status !== BOT_STATUS.ACTIVE && currentBot.status !== BOT_STATUS.PAUSED) {
          throw new WorkspaceAgentBotError("bot.not_active", "当前状态不允许修改 Bot 设置", 409);
        }
        await ensureBotConfiguration(db, currentBot.id, currentBot.spaceId, updatedAt);
        if (Object.hasOwn(patch, "visibilityPolicy")) {
          await db.prepare(`UPDATE workspace_agent_bots SET visibility_policy = ?, updated_at = ? WHERE id = ?`)
            .run(patch.visibilityPolicy, updatedAt, currentBot.id);
          await db.prepare(`UPDATE workspace_agent_bot_settings SET visibility_policy = ?, updated_at = ? WHERE bot_id = ? AND space_id = ?`)
            .run(patch.visibilityPolicy, updatedAt, currentBot.id, currentBot.spaceId);
        }
        if (Object.hasOwn(patch, "allowGroup")) {
          await db.prepare(`UPDATE workspace_agent_bots SET conversation_policy = ?, updated_at = ? WHERE id = ?`)
            .run(
              patch.allowGroup ? BOT_CONVERSATION_POLICIES.GROUP_CAPABLE : BOT_CONVERSATION_POLICIES.DIRECT_ONLY,
              updatedAt,
              currentBot.id
            );
        }
        const columns = Object.keys(patch).filter((key) => Object.hasOwn(SETTINGS_COLUMNS, key));
        if (columns.length > 0) {
          const assignments = columns.map((key) => `${SETTINGS_COLUMNS[key]} = ?`).join(", ");
          await db.prepare(`UPDATE workspace_agent_bot_settings SET ${assignments}, updated_at = ? WHERE bot_id = ? AND space_id = ?`)
            .run(...columns.map((key) => patch[key]), updatedAt, currentBot.id, currentBot.spaceId);
        } else {
          await db.prepare(`UPDATE workspace_agent_bot_settings SET updated_at = ? WHERE bot_id = ? AND space_id = ?`)
            .run(updatedAt, currentBot.id, currentBot.spaceId);
        }
        if (Object.hasOwn(patch, "allowedMemberIds")) {
          await db.prepare("DELETE FROM workspace_agent_bot_visibility_members WHERE bot_id = ? AND space_id = ?")
            .run(currentBot.id, currentBot.spaceId);
          for (const userId of patch.allowedMemberIds) {
            await db.prepare(`INSERT INTO workspace_agent_bot_visibility_members (bot_id, space_id, user_id, created_at) VALUES (?, ?, ?, ?)`)
              .run(currentBot.id, currentBot.spaceId, userId, updatedAt);
          }
        }
        return await readSettings(db, currentBot.id);
      });
    } catch (error) {
      if (error instanceof WorkspaceAgentBotError) {
        await auditRejection(actor, "bot.settings.update", "agent_bot", bot.id, error.code);
      }
      throw error;
    }
    await writeBotAudit({ actor, spaceId: actor.spaceId, action: "bot.settings.update", targetType: "agent_bot", targetId: bot.id, result: "success" });
    return publicBotSettings(settings, await readBot(bot.id));
  }

  async function rotateToken(actorUserId, botId, input = {}) {
    const actor = await requireActiveHumanMember(actorUserId, input.spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.token.rotate", "agent_bot");
    const rotated = await db.transaction(async () => {
      await db.lock?.(botLifecycleLockKey(actor.spaceId, bot.id));
      const current = await requireOwnedBot(actor, bot.id);
      await db.prepare("UPDATE workspace_agent_bot_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE bot_id = ? AND revoked_at IS NULL")
        .run(now().toISOString(), current.id);
      return current;
    });
    const issued = await issueToken(actor.id, rotated.id, { ...input, spaceId: actor.spaceId });
    await writeBotAudit({ actor, spaceId: actor.spaceId, action: "bot.token.rotate", targetType: "agent_bot", targetId: bot.id, result: "success" });
    return issued;
  }

  async function listGroupPolicies(actorUserId, botId, spaceId) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.group_policy.read", "agent_bot");
    const rows = await db.prepare(`SELECT gp.conversation_id AS conversationId, gp.status, gp.invited_by AS invitedBy,
      gp.approved_by AS approvedBy, gp.max_context_messages AS maxContextMessages, gp.created_at AS createdAt, gp.updated_at AS updatedAt,
      cg.grant_id AS grantId, cg.allow_trigger AS allowTrigger, cg.allow_context AS allowContext, cg.max_messages AS contextMaxMessages
      FROM workspace_agent_bot_group_policies gp
      LEFT JOIN workspace_agent_bot_context_grants cg ON cg.bot_id = gp.bot_id AND cg.space_id = gp.space_id AND cg.conversation_id = gp.conversation_id
      WHERE gp.bot_id = ? AND gp.space_id = ? ORDER BY gp.updated_at DESC`).all(bot.id, bot.spaceId);
    return rows.map((row) => ({ ...row, allowTrigger: Boolean(row.allowTrigger), allowContext: Boolean(row.allowContext) }));
  }

  async function updateGroupPolicy(actorUserId, botId, input = {}) {
    const actor = await requireActiveHumanMember(actorUserId, input.spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.group_policy.update", "agent_bot");
    const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
    if (!conversationId) throw new WorkspaceAgentBotError("bot.invalid_group_policy", "群聊会话无效");
    const status = input.status ?? "active";
    if (!["pending", "active", "rejected", "removed"].includes(status)) throw new WorkspaceAgentBotError("bot.invalid_group_policy", "群聊策略状态无效");
    const allowTrigger = input.allowTrigger === undefined ? status === "active" : input.allowTrigger;
    const allowContext = input.allowContext === undefined ? false : input.allowContext;
    if (typeof allowTrigger !== "boolean" || typeof allowContext !== "boolean") throw new WorkspaceAgentBotError("bot.invalid_group_policy", "群聊策略开关无效");
    const maxMessages = input.maxMessages === undefined || input.maxMessages === null ? null : input.maxMessages;
    if (maxMessages !== null && (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 200)) throw new WorkspaceAgentBotError("bot.invalid_group_policy", "群聊上下文限制无效");
    const timestamp = now().toISOString();
    const grantId = `grant_${idFactory()}`;
    try {
      await db.transaction(async () => {
        await db.lock?.(botLifecycleLockKey(bot.spaceId, bot.id));
        await requireGroupPolicyManager(db, actor.id, bot.spaceId, conversationId);
        const currentBot = await requireOwnedBot(actor, bot.id);
        const settings = await readSettings(db, currentBot.id);
        if (status === "active" && (!Boolean(settings?.allowGroup) || settings.visibilityPolicy === BOT_VISIBILITY_POLICIES.PRIVATE)) {
          throw new WorkspaceAgentBotError("bot.group_policy_forbidden", "Bot 当前设置不允许加入群聊", 403);
        }
        await db.prepare(`INSERT INTO workspace_agent_bot_group_policies
          (bot_id, space_id, conversation_id, status, invited_by, approved_by, max_context_messages, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (bot_id, conversation_id) DO UPDATE SET status = excluded.status, approved_by = excluded.approved_by,
            max_context_messages = excluded.max_context_messages, updated_at = excluded.updated_at`)
          .run(currentBot.id, currentBot.spaceId, conversationId, status, actor.id, status === "active" ? actor.id : null, maxMessages, timestamp, timestamp);
        await db.prepare(`INSERT INTO workspace_agent_bot_context_grants
          (grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (bot_id, conversation_id) DO UPDATE SET allow_trigger = excluded.allow_trigger, allow_context = excluded.allow_context,
            max_messages = excluded.max_messages, granted_by = excluded.granted_by, updated_at = excluded.updated_at`)
          .run(grantId, currentBot.id, currentBot.spaceId, conversationId, allowTrigger ? 1 : 0, allowContext ? 1 : 0, maxMessages, actor.id, timestamp, timestamp);
        if (status === "active") {
          await db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
            VALUES (?, ?, ?, NULL) ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL`).run(conversationId, currentBot.botUserId, timestamp);
        } else if (status === "removed" || status === "rejected") {
          await db.prepare(`UPDATE conversation_members SET removed_at = ? WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL`)
            .run(timestamp, conversationId, currentBot.botUserId);
        }
      });
    } catch (error) {
      if (error instanceof WorkspaceAgentBotError) {
        await auditRejection(actor, "bot.group_policy.update", "agent_bot", bot.id, error.code);
      }
      throw error;
    }
    await writeBotAudit({ actor, spaceId: bot.spaceId, action: "bot.group_policy.update", targetType: "agent_bot", targetId: bot.id, result: "success" });
    return (await listGroupPolicies(actor.id, bot.id, bot.spaceId)).find((policy) => policy.conversationId === conversationId);
  }

  async function updateContextGrant(actorUserId, botId, input = {}) {
    const actor = await requireActiveHumanMember(actorUserId, input.spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.context_grant.update", "agent_bot");
    const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
    const unknown = Object.keys(input).find((key) => !new Set([
      "spaceId", "conversationId", "allowTrigger", "allowContext", "maxMessages"
    ]).has(key));
    try {
      if (!conversationId || unknown) {
        throw new WorkspaceAgentBotError("bot.invalid_context_grant", "私聊上下文授权无效");
      }
      const timestamp = now().toISOString();
      const grant = await db.transaction(async () => {
        await db.lock?.(botLifecycleLockKey(bot.spaceId, bot.id));
        const currentBot = await requireOwnedBot(actor, bot.id);
        if (currentBot.status !== BOT_STATUS.ACTIVE) {
          throw new WorkspaceAgentBotError("bot.not_active", "仅运行中的 Bot 可以修改私聊授权", 409);
        }
        const settings = await readSettings(db, currentBot.id);
        if (!Boolean(settings?.allowDirect)) {
          throw new WorkspaceAgentBotError("bot.context_grant_forbidden", "Bot 当前设置不允许私聊", 403);
        }
        const direct = await db.prepare(`SELECT c.id
          FROM conversations c
          INNER JOIN conversation_members owner_cm
            ON owner_cm.conversation_id = c.id AND owner_cm.user_id = ? AND owner_cm.removed_at IS NULL
          INNER JOIN conversation_members bot_cm
            ON bot_cm.conversation_id = c.id AND bot_cm.user_id = ? AND bot_cm.removed_at IS NULL
          WHERE c.id = ? AND c.space_id = ? AND c.type = 'direct'
            AND (SELECT COUNT(*) FROM conversation_members active_cm
              WHERE active_cm.conversation_id = c.id AND active_cm.removed_at IS NULL) = 2`)
          .get(actor.id, currentBot.botUserId, conversationId, currentBot.spaceId);
        if (!direct) {
          throw new WorkspaceAgentBotError("bot.context_grant_forbidden", "只能配置与当前 Bot 的所有者私聊", 403);
        }
        const existing = await db.prepare(`SELECT grant_id AS grantId, allow_trigger AS allowTrigger,
          allow_context AS allowContext, max_messages AS maxMessages
          FROM workspace_agent_bot_context_grants
          WHERE bot_id = ? AND space_id = ? AND conversation_id = ?`)
          .get(currentBot.id, currentBot.spaceId, conversationId);
        const allowTrigger = input.allowTrigger === undefined ? Boolean(existing?.allowTrigger ?? true) : input.allowTrigger;
        const allowContext = input.allowContext === undefined ? Boolean(existing?.allowContext ?? false) : input.allowContext;
        const maxMessages = input.maxMessages === undefined ? existing?.maxMessages ?? null : input.maxMessages;
        if (typeof allowTrigger !== "boolean" || typeof allowContext !== "boolean") {
          throw new WorkspaceAgentBotError("bot.invalid_context_grant", "私聊授权开关无效");
        }
        if (maxMessages !== null && (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 200)) {
          throw new WorkspaceAgentBotError("bot.invalid_context_grant", "私聊上下文条数无效");
        }
        const grantId = existing?.grantId ?? `grant_${idFactory()}`;
        await db.prepare(`INSERT INTO workspace_agent_bot_context_grants
          (grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (bot_id, conversation_id) DO UPDATE SET allow_trigger = excluded.allow_trigger,
            allow_context = excluded.allow_context, max_messages = excluded.max_messages,
            granted_by = excluded.granted_by, updated_at = excluded.updated_at`)
          .run(grantId, currentBot.id, currentBot.spaceId, conversationId, allowTrigger ? 1 : 0, allowContext ? 1 : 0, maxMessages, actor.id, timestamp, timestamp);
        return { grantId, botId: currentBot.id, conversationId, allowTrigger, allowContext, maxMessages, updatedAt: timestamp };
      });
      await writeBotAudit({
        actor,
        spaceId: actor.spaceId,
        action: "bot.context_grant.update",
        targetType: "conversation",
        targetId: conversationId,
        result: "success"
      });
      return grant;
    } catch (error) {
      if (error instanceof WorkspaceAgentBotError) {
        await auditRejection(actor, "bot.context_grant.update", "conversation", conversationId || null, error.code);
      }
      throw error;
    }
  }

  async function getConnectionStatus(actorUserId, botId, spaceId) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.connection.read", "agent_bot");
    await ensureBotConfiguration(db, bot.id, bot.spaceId, now().toISOString());
    const row = await db.prepare(`SELECT id, bot_id AS botId, space_id AS spaceId, status, adapter_version AS adapterVersion,
      connected_at AS connectedAt, disconnected_at AS disconnectedAt, last_heartbeat_at AS lastHeartbeatAt,
      last_processed_at AS lastProcessedAt, last_error_code AS lastErrorCode, last_error_at AS lastErrorAt, updated_at AS updatedAt
      FROM workspace_agent_bot_connections WHERE bot_id = ? AND space_id = ?`).get(bot.id, bot.spaceId);
    return publicConnection(row);
  }

  async function testConnection(actorUserId, botId, spaceId) {
    const actor = await requireActiveHumanMember(actorUserId, spaceId);
    const bot = await requireOwnedBotWithAudit(actor, botId, "bot.connection.test", "agent_bot");
    const timestamp = now().toISOString();
    await ensureBotConfiguration(db, bot.id, bot.spaceId, timestamp);
    await db.prepare(`UPDATE workspace_agent_bot_connections SET last_error_code = NULL, last_error_at = NULL, updated_at = ? WHERE bot_id = ? AND space_id = ?`)
      .run(timestamp, bot.id, bot.spaceId);
    await writeBotAudit({ actor, spaceId: actor.spaceId, action: "bot.connection.test", targetType: "agent_bot", targetId: bot.id, result: "success" });
    return { ...(await getConnectionStatus(actor.id, bot.id, actor.spaceId)), testedAt: timestamp };
  }

  async function updateConnection(botId, spaceId, patch = {}) {
    const timestamp = now().toISOString();
    await ensureBotConfiguration(db, botId, spaceId, timestamp);
    const updates = {
      status: patch.status,
      adapterVersion: patch.adapterVersion,
      connectionNonce: patch.connectionNonce,
      connectedAt: patch.connectedAt,
      disconnectedAt: patch.disconnectedAt,
      lastHeartbeatAt: patch.lastHeartbeatAt,
      lastProcessedAt: patch.lastProcessedAt,
      lastErrorCode: patch.lastErrorCode,
      lastErrorAt: patch.lastErrorAt
    };
    const columns = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (columns.length === 0) return getConnectionByBot(db, botId, spaceId);
    const names = {
      adapterVersion: "adapter_version", connectionNonce: "connection_nonce", connectedAt: "connected_at",
      disconnectedAt: "disconnected_at", lastHeartbeatAt: "last_heartbeat_at", lastProcessedAt: "last_processed_at",
      lastErrorCode: "last_error_code", lastErrorAt: "last_error_at", status: "status"
    };
    await db.prepare(`UPDATE workspace_agent_bot_connections SET ${columns.map(([key]) => `${names[key]} = ?`).join(", ")}, updated_at = ? WHERE bot_id = ? AND space_id = ?`)
      .run(...columns.map(([, value]) => value), timestamp, botId, spaceId);
    return getConnectionByBot(db, botId, spaceId);
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
      WHERE t.token_hash = ? AND t.space_id = b.space_id
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
    listOwnedBots,
    getOwnedBot,
    getSettings,
    updateSettings,
    listGroupPolicies,
    updateGroupPolicy,
    updateContextGrant,
    pauseBot,
    resumeBot,
    beginDeleteBot,
    finalizeDeleteBot,
    issueToken,
    listTokens,
    revokeToken,
    rotateToken,
    authenticateToken,
    readBot,
    getConnectionStatus,
    testConnection,
    updateConnection
  });
}

async function requireGroupPolicyManager(database, actorUserId, spaceId, conversationId) {
  const row = await database.prepare(`
    SELECT c.id, c.type, sm.role,
      CASE WHEN cm.user_id IS NULL THEN 0 ELSE 1 END AS is_member
    FROM conversations c
    INNER JOIN space_members sm
      ON sm.space_id = c.space_id AND sm.user_id = ? AND sm.removed_at IS NULL
    LEFT JOIN conversation_members cm
      ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.removed_at IS NULL
    WHERE c.id = ? AND c.space_id = ?
  `).get(actorUserId, actorUserId, conversationId, spaceId);
  if (!row || row.type !== "group") {
    throw new WorkspaceAgentBotError("bot.invalid_group_policy", "请选择群聊会话", 404);
  }
  if (!Boolean(row.is_member) || !["owner", "admin"].includes(row.role)) {
    throw new WorkspaceAgentBotError("bot.group_policy_forbidden", "只有当前群聊管理员可以管理 Bot", 403);
  }
  return row;
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
  const { githubLogin: _internalLogin, ...safe } = normalized;
  return {
    ...safe,
    kind: "bot",
    authenticationAllowed: false,
    canJoinGroups: normalized.conversationPolicy === BOT_CONVERSATION_POLICIES.GROUP_CAPABLE,
    tokenPolicy: "hashed-one-time"
  };
}

const SETTINGS_COLUMNS = Object.freeze({
  allowDirect: "allow_direct",
  allowGroup: "allow_group",
  groupInviterPolicy: "group_inviter_policy",
  requireOwnerApproval: "require_owner_approval",
  proactiveEnabled: "proactive_enabled",
  triggerPolicy: "trigger_policy",
  welcomeMessage: "welcome_message",
  description: "description",
  avatarUrl: "avatar_url",
  showCreator: "show_creator",
  maxContextMessages: "max_context_messages",
  maxContextChars: "max_context_chars",
  maxContextTokens: "max_context_tokens",
  contextWindowSeconds: "context_window_seconds",
  includeReplies: "include_replies",
  includeSystemEvents: "include_system_events",
  includeAttachmentMetadata: "include_attachment_metadata",
  allowAttachmentPreview: "allow_attachment_preview",
  longTermSummaryEnabled: "long_term_summary_enabled"
});

async function ensureBotConfiguration(database, botId, spaceId, timestamp) {
  const existing = await database.prepare("SELECT bot_id AS botId FROM workspace_agent_bot_settings WHERE bot_id = ? AND space_id = ?").get(botId, spaceId);
  if (!existing) {
    await database.prepare(`INSERT INTO workspace_agent_bot_settings (bot_id, space_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(botId, spaceId, timestamp, timestamp);
  }
  const limits = await database.prepare("SELECT bot_id AS botId FROM workspace_agent_bot_limits WHERE bot_id = ? AND space_id = ?").get(botId, spaceId);
  if (!limits) {
    await database.prepare(`INSERT INTO workspace_agent_bot_limits (bot_id, space_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(botId, spaceId, timestamp, timestamp);
  }
  const connection = await database.prepare("SELECT bot_id AS botId FROM workspace_agent_bot_connections WHERE bot_id = ? AND space_id = ?").get(botId, spaceId);
  if (!connection) {
    await database.prepare(`INSERT INTO workspace_agent_bot_connections (id, bot_id, space_id, status, updated_at) VALUES (?, ?, ?, 'disconnected', ?)`)
      .run(`bcon_${randomUUID()}`, botId, spaceId, timestamp);
  }
}

async function readSettings(database, botId) {
  const settings = await database.prepare(`SELECT bot_id AS botId, space_id AS spaceId, visibility_policy AS visibilityPolicy,
    allow_direct AS allowDirect, allow_group AS allowGroup, group_inviter_policy AS groupInviterPolicy,
    require_owner_approval AS requireOwnerApproval, proactive_enabled AS proactiveEnabled, trigger_policy AS triggerPolicy,
    welcome_message AS welcomeMessage, description, avatar_url AS avatarUrl, show_creator AS showCreator,
    max_context_messages AS maxContextMessages, max_context_chars AS maxContextChars, max_context_tokens AS maxContextTokens,
    context_window_seconds AS contextWindowSeconds, include_replies AS includeReplies, include_system_events AS includeSystemEvents,
    include_attachment_metadata AS includeAttachmentMetadata, allow_attachment_preview AS allowAttachmentPreview,
    long_term_summary_enabled AS longTermSummaryEnabled, created_at AS createdAt, updated_at AS updatedAt
    FROM workspace_agent_bot_settings WHERE bot_id = ?`).get(botId);
  if (!settings) return null;
  const allowed = await database.prepare(`SELECT user_id AS userId FROM workspace_agent_bot_visibility_members WHERE bot_id = ? ORDER BY user_id`).all(botId);
  const limits = await database.prepare(`SELECT requests_per_minute AS requestsPerMinute, member_daily_requests AS memberDailyRequests,
    input_token_limit AS inputTokenLimit, output_token_limit AS outputTokenLimit, max_concurrency AS maxConcurrency,
    event_backlog_limit AS eventBacklogLimit FROM workspace_agent_bot_limits WHERE bot_id = ?`).get(botId);
  return { ...settings, allowedMemberIds: allowed.map(({ userId }) => userId), limits: limits ?? null };
}

function publicBotSettings(row, bot) {
  if (!row) return null;
  return {
    botId: bot.id,
    spaceId: bot.spaceId,
    visibilityPolicy: row.visibilityPolicy,
    allowDirect: Boolean(row.allowDirect),
    allowGroup: Boolean(row.allowGroup),
    groupInviterPolicy: row.groupInviterPolicy,
    requireOwnerApproval: Boolean(row.requireOwnerApproval),
    proactiveEnabled: Boolean(row.proactiveEnabled),
    triggerPolicy: row.triggerPolicy,
    welcomeMessage: row.welcomeMessage ?? null,
    description: row.description ?? null,
    avatarUrl: row.avatarUrl ?? null,
    showCreator: Boolean(row.showCreator),
    allowedMemberIds: row.allowedMemberIds,
    context: {
      maxMessages: row.maxContextMessages,
      maxChars: row.maxContextChars,
      maxTokens: row.maxContextTokens,
      windowSeconds: row.contextWindowSeconds,
      includeReplies: Boolean(row.includeReplies),
      includeSystemEvents: Boolean(row.includeSystemEvents),
      includeAttachmentMetadata: Boolean(row.includeAttachmentMetadata),
      allowAttachmentPreview: Boolean(row.allowAttachmentPreview),
      longTermSummaryEnabled: Boolean(row.longTermSummaryEnabled)
    },
    limits: row.limits,
    updatedAt: row.updatedAt
  };
}

function publicConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    botId: row.botId,
    spaceId: row.spaceId,
    status: row.status,
    adapterVersion: row.adapterVersion ?? null,
    connectedAt: row.connectedAt ?? null,
    disconnectedAt: row.disconnectedAt ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt ?? null,
    lastProcessedAt: row.lastProcessedAt ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
    lastErrorAt: row.lastErrorAt ?? null,
    updatedAt: row.updatedAt
  };
}

async function getConnectionByBot(database, botId, spaceId) {
  const row = await database.prepare(`SELECT id, bot_id AS botId, space_id AS spaceId, status, adapter_version AS adapterVersion,
    connected_at AS connectedAt, disconnected_at AS disconnectedAt, last_heartbeat_at AS lastHeartbeatAt,
    last_processed_at AS lastProcessedAt, last_error_code AS lastErrorCode, last_error_at AS lastErrorAt, updated_at AS updatedAt
    FROM workspace_agent_bot_connections WHERE bot_id = ? AND space_id = ?`).get(botId, spaceId);
  return publicConnection(row);
}

function normalizeSettingsPatch(input) {
  const patch = {};
  if (Object.hasOwn(input, "visibilityPolicy")) {
    if (!Object.values(BOT_VISIBILITY_POLICIES).includes(input.visibilityPolicy)) throw new WorkspaceAgentBotError("bot.invalid_settings", "Bot 可见范围无效");
    patch.visibilityPolicy = input.visibilityPolicy;
  }
  if (Object.hasOwn(input, "allowedMemberIds")) {
    if (!Array.isArray(input.allowedMemberIds) || input.allowedMemberIds.length > 200 || input.allowedMemberIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
      throw new WorkspaceAgentBotError("bot.invalid_settings", "Bot 成员名单无效");
    }
    patch.allowedMemberIds = [...new Set(input.allowedMemberIds)];
  }
  for (const [key, column] of Object.entries(SETTINGS_COLUMNS)) {
    if (!Object.hasOwn(input, key)) continue;
    let value = input[key];
    if (["allowDirect", "allowGroup", "requireOwnerApproval", "proactiveEnabled", "showCreator", "includeReplies", "includeSystemEvents", "includeAttachmentMetadata", "allowAttachmentPreview", "longTermSummaryEnabled"].includes(key)) {
      if (typeof value !== "boolean") throw new WorkspaceAgentBotError("bot.invalid_settings", "Bot 开关设置无效");
      value = value ? 1 : 0;
    } else if (["maxContextMessages", "maxContextChars", "maxContextTokens", "contextWindowSeconds"].includes(key)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new WorkspaceAgentBotError("bot.invalid_settings", "Bot 上下文限制无效");
    } else if (["groupInviterPolicy"].includes(key)) {
      if (!["owner", "group_admin", "any_member"].includes(value)) throw new WorkspaceAgentBotError("bot.invalid_settings", "Bot 群聊策略无效");
    } else if (["triggerPolicy"].includes(key)) {
      if (value !== BOT_TRIGGER_POLICIES.MENTION_OR_COMMAND) throw new WorkspaceAgentBotError("bot.invalid_settings", "Bot 触发策略无效");
    } else if (["welcomeMessage", "description"].includes(key)) {
      if (value !== null && (typeof value !== "string" || value.length > 4000)) throw new WorkspaceAgentBotError("bot.invalid_settings", "Bot 文本设置无效");
    } else if (["avatarUrl"].includes(key)) {
      if (value !== null && (typeof value !== "string" || value.length > 2048 || !/^\/(?:api|assets)\//u.test(value))) throw new WorkspaceAgentBotError("bot.invalid_settings", "Bot 头像地址无效");
    }
    patch[key] = value;
  }
  const known = new Set(["spaceId", "visibilityPolicy", "allowedMemberIds", ...Object.keys(SETTINGS_COLUMNS)]);
  const unknown = Object.keys(input).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new WorkspaceAgentBotError("bot.invalid_settings", "Bot 设置包含未知字段");
  return patch;
}

function isUniqueConstraintError(error) {
  return Boolean(error && (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505" || /unique constraint|duplicate key/i.test(error.message ?? "")));
}
