import { createHash, randomUUID } from "node:crypto";
import { canBotParticipateInConversation, BOT_SCOPE_ALLOWLIST, BOT_STATUS, WorkspaceAgentBotError } from "./workspace-agent-bots.mjs";
import { createBotStructuredMessage, MESSAGE_CONTENT_FORMAT, reserveUpload } from "./workspace.mjs";
import { normalizeCardPayload } from "./workspace-cards.mjs";

export const BOT_GATEWAY_VERSION = 1;
export const BOT_GATEWAY_REPLAY_LIMIT = 200;
export const BOT_GATEWAY_REPLAY_WINDOW_MS = 86_400_000;

const SAFE_TOKEN = /^Bearer\s+(dl_bot_[A-Za-z0-9_-]{32,})$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class WorkspaceBotGatewayError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceBotGatewayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createWorkspaceBotGatewayService({
  db,
  botService,
  now = () => new Date(),
  idFactory = randomUUID,
  replayLimit = BOT_GATEWAY_REPLAY_LIMIT,
  replayWindowMs = BOT_GATEWAY_REPLAY_WINDOW_MS
} = {}) {
  if (!db || !botService) throw new TypeError("Bot Gateway requires a database and Bot service");
  const connections = new Map();

  async function authenticate(rawToken, options = {}) {
    try {
      const auth = await botService.authenticateToken(rawToken, options);
      if (!auth?.bot || auth.bot.status !== BOT_STATUS.ACTIVE) throw invalidToken();
      return auth;
    } catch (error) {
      if (error instanceof WorkspaceAgentBotError) throw invalidToken();
      throw error;
    }
  }

  async function getMe(auth) {
    const settings = await readSettings(db, auth.botId, auth.spaceId);
    const connection = await readConnection(db, auth.botId, auth.spaceId);
    return {
      version: BOT_GATEWAY_VERSION,
      bot: safeBot(auth.bot),
      spaceId: auth.spaceId,
      scopes: [...auth.scopes],
      settings: settings ? projectSettings(settings) : null,
      connection
    };
  }

  // A Gateway operation is authorized against the Bot membership itself and
  // the owner-controlled policy. Token scope alone never grants cross-chat
  // access. Group entries must be explicitly approved in the policy table.
  async function requireConversation(auth, conversationId) {
    const id = normalizeId(conversationId, "conversation.invalid");
    const conversation = await db.prepare(`SELECT id, space_id AS spaceId, type, title, created_at AS createdAt
      FROM conversations WHERE id = ? AND space_id = ?`).get(id, auth.spaceId);
    if (!conversation) throw new WorkspaceBotGatewayError("conversation.not_found", "会话不存在或 Bot 未加入", 404);
    const member = await db.prepare(`SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL`)
      .get(id, auth.userId);
    if (!member) throw new WorkspaceBotGatewayError("conversation.not_found", "会话不存在或 Bot 未加入", 404);
    const settings = await readSettings(db, auth.botId, auth.spaceId);
    if (conversation.type === "direct" && settings && !Boolean(settings.allowDirect)) {
      throw new WorkspaceBotGatewayError("bot.conversation_forbidden", "Bot 当前策略不允许私聊", 403);
    }
    if (conversation.type === "group") {
      if (!settings || !Boolean(settings.allowGroup)) throw new WorkspaceBotGatewayError("bot.conversation_forbidden", "Bot 当前策略不允许群聊", 403);
      const policy = await db.prepare(`SELECT status FROM workspace_agent_bot_group_policies WHERE bot_id = ? AND space_id = ? AND conversation_id = ?`)
        .get(auth.botId, auth.spaceId, id);
      if (!policy || policy.status !== "active") throw new WorkspaceBotGatewayError("bot.conversation_forbidden", "Bot 尚未获准加入该群聊", 403);
    }
    if (!canBotParticipateInConversation({ ...auth.bot, status: BOT_STATUS.ACTIVE }, {
      conversationType: conversation.type,
      actorUserId: auth.ownerUserId,
      isMember: true,
      isExplicitTrigger: true
    }) && conversation.type === "group") {
      throw new WorkspaceBotGatewayError("bot.conversation_forbidden", "Bot 当前策略不允许访问该群聊", 403);
    }
    return conversation;
  }

  async function requireContextGrant(auth, conversationId) {
    const grant = await db.prepare(`SELECT allow_context AS allowContext, max_messages AS maxMessages
      FROM workspace_agent_bot_context_grants WHERE bot_id = ? AND space_id = ? AND conversation_id = ?`)
      .get(auth.botId, auth.spaceId, conversationId);
    if (!grant || !Boolean(grant.allowContext)) throw new WorkspaceBotGatewayError("bot.context_forbidden", "Bot 未获准读取该会话上下文", 403);
    return grant;
  }

  async function isBotConversationMember(auth, conversationId) {
    if (!conversationId) return false;
    const row = await db.prepare(`SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL`)
      .get(conversationId, auth.userId);
    return Boolean(row);
  }

  async function getContext(auth, conversationId, options = {}) {
    requireScope(auth, "messages:read_context");
    const conversation = await requireConversation(auth, conversationId);
    const grant = await requireContextGrant(auth, conversation.id);
    const settings = await readSettings(db, auth.botId, auth.spaceId);
    const configuredLimit = Math.min(Number(settings?.maxContextMessages ?? 50), Number(grant.maxMessages ?? 200) || 200);
    const limit = Math.min(Math.max(1, Number(options.limit) || configuredLimit), configuredLimit, 200);
    const rows = await db.prepare(`SELECT m.id, m.conversation_id AS conversationId, m.author_id AS authorId,
      m.author_kind AS authorKind, m.kind, m.content_format AS contentFormat, m.content_json AS contentJson,
      m.plain_text AS plainText, m.reply_to_message_id AS replyToMessageId, m.created_at AS createdAt
      FROM messages m WHERE m.space_id = ? AND m.conversation_id = ? AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(auth.spaceId, conversation.id, limit);
    return {
      conversation: projectConversation(conversation),
      messages: rows.reverse().map((row) => projectMessage(row, settings)),
      limits: { maxMessages: configuredLimit, maxChars: Number(settings?.maxContextChars ?? 20000), maxTokens: Number(settings?.maxContextTokens ?? 8000), windowSeconds: Number(settings?.contextWindowSeconds ?? 86400) }
    };
  }

  async function sendMessage(auth, input = {}) {
    requireScope(auth, "messages:send");
    rejectForgedFields(input);
    const conversationId = normalizeId(input.conversationId, "conversation.invalid");
    const clientMessageId = normalizeId(input.clientMessageId || input.idempotencyKey, "message.invalid");
    await requireConversation(auth, conversationId);
    const content = normalizeBotContent(input.content ?? input.text);
    const key = normalizeId(input.idempotencyKey || clientMessageId, "idempotency.invalid");
    return withIdempotency(db, auth, "message.send", key, content, async () => {
      const message = await createBotStructuredMessage(db, { botGateway: true }, {
        actorId: auth.userId,
        conversationId,
        clientMessageId,
        content,
        replyToMessageId: input.replyToMessageId ?? null
      });
      await markProcessed(db, auth);
      return { message: projectCreatedMessage(message), clientMessageId };
    });
  }

  async function sendCard(auth, input = {}) {
    requireScope(auth, "cards:write");
    rejectForgedFields(input);
    const conversationId = normalizeId(input.conversationId, "conversation.invalid");
    const clientMessageId = normalizeId(input.clientMessageId || input.idempotencyKey, "message.invalid");
    await requireConversation(auth, conversationId);
    const cardType = normalizeCardType(input.cardType);
    const schemaVersion = normalizeVersion(input.schemaVersion);
    const fallbackText = normalizeFallback(input.fallbackText);
    const payload = normalizeCardPayload(input.payload ?? {});
    const key = normalizeId(input.idempotencyKey || clientMessageId, "idempotency.invalid");
    return withIdempotency(db, auth, "card.send", key, { conversationId, cardType, schemaVersion, fallbackText, payload }, async () => {
      const cardId = `card_${idFactory()}`;
      const timestamp = now().toISOString();
      await db.prepare(`INSERT INTO workspace_agent_bot_cards
        (id, bot_id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text, revision, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`)
        .run(cardId, auth.botId, auth.spaceId, conversationId, cardType, schemaVersion, JSON.stringify(payload), fallbackText, timestamp, timestamp);
      const message = await createBotStructuredMessage(db, { botGateway: true }, {
        actorId: auth.userId,
        conversationId,
        clientMessageId,
        content: { format: MESSAGE_CONTENT_FORMAT, plainText: fallbackText, blocks: [{ type: "card", cardId, cardType, schemaVersion, fallbackText }] }
      });
      return { card: projectCard({ id: cardId, botId: auth.botId, spaceId: auth.spaceId, conversationId, cardType, schemaVersion, payloadJson: JSON.stringify(payload), fallbackText, revision: 1, status: "active", createdAt: timestamp, updatedAt: timestamp }), message: projectCreatedMessage(message) };
    });
  }

  async function updateCard(auth, cardId, input = {}) {
    requireScope(auth, "cards:write");
    rejectForgedFields(input);
    const card = await db.prepare(`SELECT id, bot_id AS botId, space_id AS spaceId, conversation_id AS conversationId,
      card_type AS cardType, schema_version AS schemaVersion, payload_json AS payloadJson, fallback_text AS fallbackText,
      revision, status, created_at AS createdAt, updated_at AS updatedAt FROM workspace_agent_bot_cards
      WHERE id = ? AND bot_id = ? AND space_id = ?`).get(normalizeId(cardId, "card.invalid_id"), auth.botId, auth.spaceId);
    if (!card || card.status !== "active") throw new WorkspaceBotGatewayError("card.not_found", "卡片不存在", 404);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== Number(card.revision)) throw new WorkspaceBotGatewayError("card.revision_conflict", "卡片版本已变化", 409);
    const fallbackText = input.fallbackText === undefined ? card.fallbackText : normalizeFallback(input.fallbackText);
    const payload = input.payload === undefined ? JSON.parse(card.payloadJson) : normalizeCardPayload(input.payload);
    const timestamp = now().toISOString();
    const result = await db.prepare(`UPDATE workspace_agent_bot_cards SET payload_json = ?, fallback_text = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND bot_id = ? AND space_id = ? AND status = 'active' AND revision = ?`)
      .run(JSON.stringify(payload), fallbackText, timestamp, card.id, auth.botId, auth.spaceId, input.expectedRevision);
    if (!result.changes) throw new WorkspaceBotGatewayError("card.revision_conflict", "卡片版本已变化", 409);
    return { card: projectCard({ ...card, payloadJson: JSON.stringify(payload), fallbackText, revision: input.expectedRevision + 1, updatedAt: timestamp }) };
  }

  async function getAttachment(auth, attachmentId) {
    requireScope(auth, "files:read_metadata");
    const id = normalizeId(attachmentId, "attachment.invalid");
    const row = await db.prepare(`SELECT a.id, a.space_id AS spaceId, a.uploader_id AS uploaderId, a.conversation_id AS conversationId,
      a.visibility, a.status, a.file_name AS fileName, a.mime_type AS mimeType, a.byte_size AS byteSize,
      a.created_at AS createdAt, a.completed_at AS completedAt FROM attachments a WHERE a.id = ? AND a.space_id = ?`).get(id, auth.spaceId);
    if (!row || (row.conversationId && !(await isBotConversationMember(auth, row.conversationId)))) throw new WorkspaceBotGatewayError("attachment.not_found", "附件不存在", 404);
    return { attachment: row };
  }

  async function createAttachment(auth, input = {}) {
    requireScope(auth, "files:write");
    rejectForgedFields(input);
    if (input.conversationId) await requireConversation(auth, input.conversationId);
    const upload = await reserveUpload(db, { botGateway: true }, {
      actorId: auth.userId,
      byteSize: input.byteSize,
      fileName: input.fileName,
      mimeType: input.mimeType,
      visibility: input.visibility ?? "private_staging",
      conversationId: input.conversationId
    });
    return { upload };
  }

  async function typing(auth, input = {}) {
    requireScope(auth, "messages:send");
    await requireConversation(auth, input.conversationId);
    return { accepted: true, expiresInMs: 5000 };
  }

  async function acknowledge(auth, input = {}) {
    const sequence = normalizeSequence(input.sequence, true);
    const eventId = typeof input.eventId === "string" && input.eventId.trim() ? input.eventId.trim() : null;
    if (!eventId && sequence === 0) throw new WorkspaceBotGatewayError("gateway.invalid_ack", "事件确认无效");
    const result = await db.prepare(`UPDATE workspace_agent_bot_deliveries SET status = 'acked', acked_at = ?
      WHERE bot_id = ? AND space_id = ? AND status <> 'acked' AND ${eventId ? "event_id = ?" : "sequence = ?"}`)
      .run(now().toISOString(), auth.botId, auth.spaceId, eventId ?? sequence);
    await markProcessed(db, auth);
    return { acknowledged: result.changes > 0, eventId, sequence };
  }

  async function replay(auth, lastSequence = 0) {
    const cursor = normalizeSequence(lastSequence, true);
    await queueWorkspaceEvents(auth);
    const oldest = await db.prepare(`SELECT MIN(sequence) AS sequence FROM workspace_agent_bot_deliveries
      WHERE bot_id = ? AND space_id = ? AND status <> 'expired'`).get(auth.botId, auth.spaceId);
    const current = await currentWorkspaceSequence(auth.spaceId);
    if (oldest?.sequence && cursor < Number(oldest.sequence) - 1) return { events: [], currentSequence: current, syncRequired: true, reason: "replay_window_exceeded" };
    const rows = await db.prepare(`SELECT id, sequence, event_id AS eventId, event_type AS eventType,
      conversation_id AS conversationId, payload_json AS payloadJson, status, attempts, created_at AS createdAt
      FROM workspace_agent_bot_deliveries WHERE bot_id = ? AND space_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
      .all(auth.botId, auth.spaceId, cursor, replayLimit + 1);
    const hasMore = rows.length > replayLimit;
    const events = rows.slice(0, replayLimit).map(projectDelivery);
    return { events, currentSequence: current, syncRequired: false, hasMore };
  }

  async function queueWorkspaceEvents(auth) {
    // Delivery rows intentionally contain metadata only. Agents must use the
    // explicitly authorized REST context endpoint to obtain message content.
    const rows = await db.prepare(`SELECT we.id, we.seq AS sequence, we.type AS eventType, we.conversation_id AS conversationId,
      we.created_at AS createdAt FROM workspace_events we
      INNER JOIN conversation_members cm ON cm.conversation_id = we.conversation_id AND cm.user_id = ? AND cm.removed_at IS NULL
      WHERE we.space_id = ? ORDER BY we.seq DESC LIMIT ?`).all(auth.userId, auth.spaceId, replayLimit * 2);
    for (const row of rows.reverse()) {
      const grant = await db.prepare(`SELECT allow_trigger AS allowTrigger FROM workspace_agent_bot_context_grants
        WHERE bot_id = ? AND space_id = ? AND conversation_id = ?`).get(auth.botId, auth.spaceId, row.conversationId);
      if (grant && Boolean(grant.allowTrigger)) await enqueueDelivery(auth, row);
    }
  }

  async function enqueueDelivery(auth, event) {
    const timestamp = now().toISOString();
    await db.prepare(`INSERT INTO workspace_agent_bot_deliveries
      (id, bot_id, space_id, sequence, event_id, event_type, conversation_id, payload_json, status, attempts, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'queued', 0, ?, ?) ON CONFLICT (bot_id, sequence) DO NOTHING`)
      .run(`bdl_${idFactory()}`, auth.botId, auth.spaceId, event.sequence, event.id, event.eventType, event.conversationId, timestamp, new Date(new Date(timestamp).getTime() + replayWindowMs).toISOString());
  }

  async function dispatchWorkspaceEvent(writtenEvent) {
    if (!writtenEvent?.id) return;
    const bots = await db.prepare(`SELECT b.id AS botId, b.space_id AS spaceId, b.bot_user_id AS botUserId
      FROM workspace_agent_bots b WHERE b.status = 'active'`).all();
    for (const candidate of bots) {
      const event = await db.prepare(`SELECT id, seq AS sequence, type AS eventType, conversation_id AS conversationId, created_at AS createdAt
        FROM workspace_events WHERE id = ? AND space_id = ?`).get(writtenEvent.id, candidate.spaceId);
      if (!event) continue;
      const grant = await db.prepare(`SELECT allow_trigger AS allowTrigger FROM workspace_agent_bot_context_grants
        WHERE bot_id = ? AND space_id = ? AND conversation_id = ?`).get(candidate.botId, candidate.spaceId, event.conversationId);
      if (!grant || !Boolean(grant.allowTrigger)) continue;
      const auth = { botId: candidate.botId, userId: candidate.botUserId, spaceId: candidate.spaceId };
      await enqueueDelivery(auth, event);
      const delivery = await db.prepare(`SELECT id, sequence, event_id AS eventId, event_type AS eventType, conversation_id AS conversationId,
        payload_json AS payloadJson, status, attempts, created_at AS createdAt FROM workspace_agent_bot_deliveries WHERE bot_id = ? AND sequence = ?`)
        .get(candidate.botId, event.sequence);
      for (const connection of connections.get(candidate.botId) ?? []) {
        try { connection.send(JSON.stringify({ version: BOT_GATEWAY_VERSION, type: "event", event: projectDelivery(delivery) })); } catch { /* reconnect replays */ }
      }
    }
  }

  async function registerConnection(auth, connection) {
    const set = connections.get(auth.botId) ?? new Set();
    set.add(connection);
    connections.set(auth.botId, set);
    const timestamp = now().toISOString();
    await botService.updateConnection(auth.botId, auth.spaceId, {
      status: "connected",
      adapterVersion: connection.adapterVersion ?? null,
      connectionNonce: connection.connectionNonce ?? null,
      connectedAt: timestamp,
      disconnectedAt: null,
      lastHeartbeatAt: timestamp,
      lastErrorCode: null,
      lastErrorAt: null
    });
    return async () => {
      set.delete(connection);
      if (set.size === 0) {
        connections.delete(auth.botId);
        await botService.updateConnection(auth.botId, auth.spaceId, { status: "disconnected", disconnectedAt: now().toISOString() }).catch(() => {});
      }
    };
  }

  async function heartbeat(auth) {
    const timestamp = now().toISOString();
    await botService.updateConnection(auth.botId, auth.spaceId, { status: "connected", lastHeartbeatAt: timestamp });
    return { timestamp };
  }

  async function currentWorkspaceSequence(spaceId) {
    const row = await db.prepare("SELECT next_seq - 1 AS sequence FROM workspace_event_cursors WHERE space_id = ?").get(spaceId);
    return Math.max(0, Number(row?.sequence ?? 0));
  }

  return Object.freeze({ authenticate, getMe, getContext, sendMessage, sendCard, updateCard, getAttachment, createAttachment, typing, acknowledge, replay, dispatchWorkspaceEvent, registerConnection, heartbeat, requireConversation, requireContextGrant, requireScope, extractBearerToken, safeBot });
}

export function extractBearerToken(value) {
  const match = typeof value === "string" ? value.match(SAFE_TOKEN) : null;
  if (!match) throw invalidToken();
  return match[1];
}

export function requireScope(auth, scope) {
  if (!BOT_SCOPE_ALLOWLIST.includes(scope) || !auth?.scopes?.includes(scope)) {
    throw new WorkspaceBotGatewayError("bot.scope_denied", "Bot Token Scope 不足", 403);
  }
}

export function safeBot(bot) {
  if (!bot) return null;
  const { githubLogin: _internalLogin, nameNormalized: _nameKey, ownerUserId: _owner, ...safe } = bot;
  return { ...safe, kind: "bot", authenticationAllowed: false };
}

function invalidToken() {
  return new WorkspaceBotGatewayError("bot.invalid_token", "Bot Token 无效或已失效", 401);
}

async function readSettings(db, botId, spaceId) {
  return db.prepare(`SELECT visibility_policy AS visibilityPolicy, allow_direct AS allowDirect, allow_group AS allowGroup,
    group_inviter_policy AS groupInviterPolicy, require_owner_approval AS requireOwnerApproval, proactive_enabled AS proactiveEnabled,
    trigger_policy AS triggerPolicy, max_context_messages AS maxContextMessages, max_context_chars AS maxContextChars,
    max_context_tokens AS maxContextTokens, context_window_seconds AS contextWindowSeconds, include_replies AS includeReplies,
    include_system_events AS includeSystemEvents, include_attachment_metadata AS includeAttachmentMetadata,
    allow_attachment_preview AS allowAttachmentPreview, long_term_summary_enabled AS longTermSummaryEnabled
    FROM workspace_agent_bot_settings WHERE bot_id = ? AND space_id = ?`).get(botId, spaceId);
}

function projectSettings(settings) {
  return {
    visibilityPolicy: settings.visibilityPolicy,
    allowDirect: Boolean(settings.allowDirect),
    allowGroup: Boolean(settings.allowGroup),
    groupInviterPolicy: settings.groupInviterPolicy,
    requireOwnerApproval: Boolean(settings.requireOwnerApproval),
    proactiveEnabled: Boolean(settings.proactiveEnabled),
    triggerPolicy: settings.triggerPolicy,
    context: {
      maxMessages: Number(settings.maxContextMessages),
      maxChars: Number(settings.maxContextChars),
      maxTokens: Number(settings.maxContextTokens),
      windowSeconds: Number(settings.contextWindowSeconds),
      includeReplies: Boolean(settings.includeReplies),
      includeSystemEvents: Boolean(settings.includeSystemEvents),
      includeAttachmentMetadata: Boolean(settings.includeAttachmentMetadata),
      allowAttachmentPreview: Boolean(settings.allowAttachmentPreview),
      longTermSummaryEnabled: Boolean(settings.longTermSummaryEnabled)
    }
  };
}

async function readConnection(db, botId, spaceId) {
  const row = await db.prepare(`SELECT status, adapter_version AS adapterVersion, connected_at AS connectedAt,
    disconnected_at AS disconnectedAt, last_heartbeat_at AS lastHeartbeatAt, last_processed_at AS lastProcessedAt,
    last_error_code AS lastErrorCode, last_error_at AS lastErrorAt, updated_at AS updatedAt
    FROM workspace_agent_bot_connections WHERE bot_id = ? AND space_id = ?`).get(botId, spaceId);
  return row ? { ...row } : null;
}

function normalizeId(value, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(normalized)) throw new WorkspaceBotGatewayError(code, "标识无效");
  return normalized;
}

function projectConversation(row) {
  return { id: row.id, type: row.type, title: row.title, createdAt: row.createdAt };
}

function projectMessage(row, settings) {
  let content = null;
  try { content = JSON.parse(row.contentJson); } catch { content = null; }
  const includeAttachmentMetadata = Boolean(settings?.includeAttachmentMetadata);
  if (content?.blocks && Array.isArray(content.blocks)) {
    content = {
      format: content.format,
      plainText: content.plainText,
      blocks: content.blocks.map((block) => block?.type === "attachment" && !includeAttachmentMetadata
        ? { type: "attachment", attachmentId: block.attachmentId }
        : block)
    };
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    authorId: row.authorId,
    authorKind: row.authorKind,
    kind: row.kind,
    contentFormat: row.contentFormat,
    plainText: row.plainText,
    content,
    replyToMessageId: row.replyToMessageId ?? null,
    createdAt: row.createdAt
  };
}

function rejectForgedFields(input) {
  const forged = Object.keys(input).find((key) => new Set(["actorId", "ownerId", "ownerUserId", "role", "kind", "capability", "authorId", "authorKind"]).has(key));
  if (forged) throw new WorkspaceBotGatewayError("gateway.actor_forbidden", "Bot 请求不得提交身份字段");
}

function normalizeBotContent(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > 30_000) throw new WorkspaceBotGatewayError("message.invalid", "消息内容无效");
    return { format: MESSAGE_CONTENT_FORMAT, plainText: text, blocks: [{ type: "text", text }] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== MESSAGE_CONTENT_FORMAT || !Array.isArray(value.blocks) || value.blocks.length === 0) {
    throw new WorkspaceBotGatewayError("message.invalid", "消息内容无效");
  }
  const plainText = typeof value.plainText === "string" ? value.plainText.trim() : "";
  if (!plainText || plainText.length > 30_000) throw new WorkspaceBotGatewayError("message.invalid", "消息内容无效");
  return { format: MESSAGE_CONTENT_FORMAT, plainText, blocks: value.blocks };
}

async function withIdempotency(db, auth, operation, key, input, callback) {
  const requestHash = createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
  const existing = await db.prepare(`SELECT request_hash AS requestHash, response_json AS responseJson
    FROM workspace_agent_bot_idempotency WHERE bot_id = ? AND operation = ? AND idempotency_key = ? AND expires_at > ?`)
    .get(auth.botId, operation, key, new Date().toISOString());
  if (existing) {
    if (existing.requestHash !== requestHash) throw new WorkspaceBotGatewayError("idempotency.conflict", "幂等键对应的请求不一致", 409);
    return JSON.parse(existing.responseJson);
  }
  const result = await callback();
  const timestamp = new Date();
  await db.prepare(`INSERT INTO workspace_agent_bot_idempotency
    (id, bot_id, token_id, space_id, operation, idempotency_key, request_hash, response_status, response_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 200, ?, ?, ?)
    ON CONFLICT (bot_id, operation, idempotency_key) DO NOTHING`).run(
    `bid_${randomUUID()}`, auth.botId, auth.tokenId, auth.spaceId, operation, key, requestHash,
    JSON.stringify(result), timestamp.toISOString(), new Date(timestamp.getTime() + 86_400_000).toISOString()
  );
  return result;
}

function projectCreatedMessage(message) {
  if (!message || typeof message !== "object") return message;
  return {
    id: message.id,
    conversationId: message.conversationId,
    plainText: message.plainText,
    content: message.content,
    createdAt: message.createdAt,
    author: message.author
  };
}

async function markProcessed(db, auth) {
  const timestamp = new Date().toISOString();
  await db.prepare(`UPDATE workspace_agent_bot_connections SET last_processed_at = ?, updated_at = ?
    WHERE bot_id = ? AND space_id = ?`).run(timestamp, timestamp, auth.botId, auth.spaceId);
}

function normalizeCardType(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(normalized)) throw new WorkspaceBotGatewayError("card.invalid_type", "卡片类型无效");
  return normalized;
}

function normalizeVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkspaceBotGatewayError("card.invalid_version", "卡片版本无效");
  return value;
}

function normalizeFallback(value) {
  const normalized = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim() : "";
  if (!normalized || normalized.length > 16_000 || /<\/?[a-z][^>]*>/iu.test(normalized)) throw new WorkspaceBotGatewayError("card.invalid_fallback", "卡片降级文本无效");
  return normalized;
}

function projectCard(row) {
  let payload;
  try { payload = JSON.parse(row.payloadJson); } catch { payload = {}; }
  return { id: row.id, botId: row.botId, spaceId: row.spaceId, conversationId: row.conversationId, cardType: row.cardType, schemaVersion: Number(row.schemaVersion), payload, fallbackText: row.fallbackText, revision: Number(row.revision), status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function normalizeSequence(value, allowZero = false) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new WorkspaceBotGatewayError("gateway.invalid_sequence", "事件序号无效");
  return parsed;
}

function projectDelivery(row) {
  return {
    id: row.id,
    eventId: row.eventId,
    sequence: Number(row.sequence),
    type: row.eventType,
    conversationId: row.conversationId,
    payload: {},
    status: row.status,
    createdAt: row.createdAt
  };
}
