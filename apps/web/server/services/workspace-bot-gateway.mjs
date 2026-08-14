import { createHash, randomUUID } from "node:crypto";
import { canBotParticipateInConversation, BOT_SCOPE_ALLOWLIST, BOT_STATUS, WorkspaceAgentBotError } from "./workspace-agent-bots.mjs";
import { createBotStructuredMessage, MESSAGE_CONTENT_FORMAT, reserveUpload } from "./workspace.mjs";
import { normalizeCardPayload } from "./workspace-cards.mjs";

export const BOT_GATEWAY_VERSION = 1;
export const BOT_GATEWAY_REPLAY_LIMIT = 200;
export const BOT_GATEWAY_REPLAY_WINDOW_MS = 86_400_000;

const SAFE_TOKEN = /^Bearer\s+(dl_bot_[A-Za-z0-9_-]{32,})$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DELIVERY_EVENT_SCOPES = Object.freeze({
  "message.created": "messages:read_trigger",
  "bot.mentioned": "messages:read_trigger",
  "command.invoked": "commands:receive"
});
const MAX_TRIGGER_BYTES = 100 * 1024;
const MAX_TRIGGER_BLOCKS = 100;

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
  cardService = null,
  workspaceCards = null,
  now = () => new Date(),
  idFactory = randomUUID,
  replayLimit = BOT_GATEWAY_REPLAY_LIMIT,
  replayWindowMs = BOT_GATEWAY_REPLAY_WINDOW_MS
} = {}) {
  if (!db || !botService) throw new TypeError("Bot Gateway requires a database and Bot service");
  const cards = cardService ?? workspaceCards;
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

  async function validateAuth(auth) {
    if (!auth?.tokenId || !auth?.botId || !auth?.spaceId) throw invalidToken();
    const timestamp = now().toISOString();
    const row = await db.prepare(`
      SELECT t.id AS tokenId, t.scopes_json AS scopesJson,
        b.id AS botId, b.space_id AS spaceId, b.owner_user_id AS ownerUserId,
        b.bot_user_id AS botUserId, b.mode, b.name,
        b.visibility_policy AS visibilityPolicy, b.conversation_policy AS conversationPolicy,
        b.trigger_policy AS triggerPolicy, b.status
      FROM workspace_agent_bot_tokens t
      INNER JOIN workspace_agent_bots b ON b.id = t.bot_id AND b.space_id = t.space_id
      WHERE t.id = ? AND t.bot_id = ? AND t.space_id = ?
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > ?)
        AND b.status = 'active'
    `).get(auth.tokenId, auth.botId, auth.spaceId, timestamp);
    if (!row) throw invalidToken();
    return {
      ...auth,
      tokenId: row.tokenId,
      botId: row.botId,
      userId: row.botUserId,
      spaceId: row.spaceId,
      ownerUserId: row.ownerUserId,
      scopes: parseScopes(row.scopesJson),
      bot: {
        id: row.botId,
        botUserId: row.botUserId,
        ownerUserId: row.ownerUserId,
        spaceId: row.spaceId,
        mode: row.mode,
        name: row.name,
        visibilityPolicy: row.visibilityPolicy,
        conversationPolicy: row.conversationPolicy,
        triggerPolicy: row.triggerPolicy,
        status: row.status
      }
    };
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
    const replyToMessageId = input.replyToMessageId === undefined || input.replyToMessageId === null
      ? null
      : normalizeId(input.replyToMessageId, "message.invalid_reply");
    return withIdempotency(db, auth, "message.send", key, {
      conversationId,
      clientMessageId,
      replyToMessageId,
      content
    }, async () => {
      const message = await createBotStructuredMessage(db, { botGateway: true }, {
        actorId: auth.userId,
        conversationId,
        clientMessageId,
        content,
        replyToMessageId
      });
      await markProcessed(db, auth);
      return { message: projectCreatedMessage(message), clientMessageId };
    });
  }

  async function sendCard(auth, input = {}) {
    requireScope(auth, "cards:write");
    rejectForgedFields(input);
    rejectOpaqueCardCreateFields(input);
    const conversationId = normalizeId(input.conversationId, "conversation.invalid");
    const clientMessageId = normalizeId(input.clientMessageId || input.idempotencyKey, "message.invalid");
    await requireConversation(auth, conversationId);
    const cardType = normalizeCardType(input.cardType);
    const schemaVersion = normalizeVersion(input.schemaVersion);
    const fallbackText = normalizeFallback(input.fallbackText);
    const payload = normalizeCardPayload(input.payload ?? {});
    const key = normalizeId(input.idempotencyKey || clientMessageId, "idempotency.invalid");
    if (!cards?.createCustomBotCard || !cards?.validateMessageCardReference) {
      throw new WorkspaceBotGatewayError("card.unavailable", "卡片服务暂不可用", 503);
    }
    return withIdempotency(db, auth, "card.send", key, { conversationId, cardType, schemaVersion, fallbackText, payload }, async () => {
      const card = await cards.createCustomBotCard({
        botId: auth.botId,
        botUserId: auth.userId,
        spaceId: auth.spaceId,
        conversationId,
        // This source key is deterministic for retries but does not disclose
        // the caller-controlled idempotency value in the card row.
        sourceId: opaqueCardSourceId(auth.botId, key),
        cardType,
        schemaVersion,
        fallbackText,
        payload
      });
      const message = await createBotStructuredMessage(db, { botGateway: true }, {
        actorId: auth.userId,
        conversationId,
        clientMessageId,
        content: { format: MESSAGE_CONTENT_FORMAT, plainText: fallbackText, blocks: [card.block] },
        validateCardReference: (actorId, targetConversationId, block) => cards.validateMessageCardReference(actorId, targetConversationId, block, { allowBot: true })
      });
      return { card: projectCard(card, auth.botId), message: projectCreatedMessage(message) };
    });
  }

  async function updateCard(auth, cardId, input = {}) {
    requireScope(auth, "cards:write");
    rejectForgedFields(input);
    rejectImmutableCardFields(input);
    if (!cards?.updateCustomBotCard || !cards?.invalidateCustomBotCard) {
      throw new WorkspaceBotGatewayError("card.unavailable", "卡片服务暂不可用", 503);
    }
    if (input.status !== undefined && input.status !== "active") {
      const card = await cards.invalidateCustomBotCard({
        cardId: normalizeId(cardId, "card.invalid_id"),
        botId: auth.botId,
        botUserId: auth.userId,
        spaceId: auth.spaceId,
        expectedRevision: input.expectedRevision,
        status: input.status
      });
      return { card: projectCard(card, auth.botId) };
    }
    const card = await cards.updateCustomBotCard({
      cardId: normalizeId(cardId, "card.invalid_id"),
      botId: auth.botId,
      botUserId: auth.userId,
      spaceId: auth.spaceId,
      expectedRevision: input.expectedRevision,
      payload: input.payload,
      fallbackText: input.fallbackText
    });
    return { card: projectCard(card, auth.botId) };
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
    auth = await validateAuth(auth);
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
    auth = await validateAuth(auth);
    const cursor = normalizeSequence(lastSequence, true);
    await expireDeliveries(auth);
    await queueWorkspaceEvents(auth);
    const candidates = await db.prepare(`SELECT d.id, d.sequence, d.event_id AS eventId, d.event_type AS eventType,
      d.conversation_id AS conversationId, d.payload_json AS payloadJson, d.status, d.attempts, d.created_at AS createdAt
      FROM workspace_agent_bot_deliveries d
      WHERE d.bot_id = ? AND d.space_id = ? AND d.sequence > ?
        AND d.status <> 'expired' AND d.expires_at > ?
      ORDER BY d.sequence LIMIT ?`)
      .all(auth.botId, auth.spaceId, cursor, now().toISOString(), replayLimit * 4 + 1);
    const allowed = [];
    for (const delivery of candidates) {
      const event = await loadWorkspaceEvent(delivery.eventId, auth.spaceId);
      if (event && await authorizeDelivery(auth, event)) {
        allowed.push(delivery);
      } else {
        await db.prepare("UPDATE workspace_agent_bot_deliveries SET status = 'expired' WHERE id = ? AND status <> 'expired'").run(delivery.id);
      }
    }
    const oldest = await db.prepare(`SELECT MIN(sequence) AS sequence FROM workspace_agent_bot_deliveries
      WHERE bot_id = ? AND space_id = ? AND status <> 'expired' AND expires_at > ?`).get(auth.botId, auth.spaceId, now().toISOString());
    const expiredAfterCursor = await db.prepare(`SELECT 1 AS expired FROM workspace_agent_bot_deliveries
      WHERE bot_id = ? AND space_id = ? AND sequence > ? AND (status = 'expired' OR expires_at <= ?) LIMIT 1`)
      .get(auth.botId, auth.spaceId, cursor, now().toISOString());
    const current = await currentWorkspaceSequence(auth.spaceId);
    if (expiredAfterCursor || (oldest?.sequence && cursor < Number(oldest.sequence) - 1)) {
      return { events: [], currentSequence: current, syncRequired: true, reason: "replay_window_exceeded" };
    }
    const hasMore = allowed.length > replayLimit;
    const rows = allowed.slice(0, replayLimit);
    if (rows.length > 0) {
      const timestamp = now().toISOString();
      for (const row of rows) {
        await db.prepare(`UPDATE workspace_agent_bot_deliveries
          SET status = CASE WHEN status = 'queued' THEN 'delivered' ELSE status END,
            delivered_at = COALESCE(delivered_at, ?), attempts = attempts + 1
          WHERE id = ? AND status <> 'expired'`).run(timestamp, row.id);
      }
    }
    const events = rows.map(projectDelivery);
    return { events, currentSequence: current, syncRequired: false, hasMore };
  }

  async function queueWorkspaceEvents(auth) {
    // Delivery rows intentionally contain metadata only. Agents must use the
    // explicitly authorized REST context endpoint to obtain message content.
    const rows = await db.prepare(`SELECT we.id, we.seq AS sequence, we.type AS eventType,
      we.actor_user_id AS actorUserId, we.conversation_id AS conversationId,
      we.target_type AS targetType, we.target_id AS targetId, we.payload_json AS eventPayloadJson,
      we.created_at AS createdAt FROM workspace_events we
      WHERE we.space_id = ? ORDER BY we.seq DESC LIMIT ?`).all(auth.spaceId, replayLimit * 4);
    for (const row of rows.reverse()) {
      await authorizeAndEnqueue(auth, row);
    }
  }

  async function enqueueDelivery(auth, event) {
    const timestamp = now().toISOString();
    return await db.prepare(`INSERT INTO workspace_agent_bot_deliveries
      (id, bot_id, space_id, sequence, event_id, event_type, conversation_id, payload_json, status, attempts, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'queued', 0, ?, ?) ON CONFLICT (bot_id, sequence) DO NOTHING`)
      .run(`bdl_${idFactory()}`, auth.botId, auth.spaceId, event.sequence, event.id, event.eventType, event.conversationId, timestamp, new Date(new Date(timestamp).getTime() + replayWindowMs).toISOString());
  }

  async function dispatchWorkspaceEvent(writtenEvent) {
    if (!writtenEvent?.id) return;
    const event = await loadWorkspaceEvent(writtenEvent.id, writtenEvent.spaceId);
    if (!event) return;
    for (const set of connections.values()) {
      for (const record of [...set]) {
        try {
          record.auth = await validateAuth(record.auth);
        } catch (error) {
          if (error?.code === "bot.invalid_token") await rejectConnection(record, "bot token revoked");
          else throw error;
        }
      }
    }
    const tokens = await db.prepare(`SELECT t.id AS tokenId, t.bot_id AS botId, t.space_id AS spaceId
      FROM workspace_agent_bot_tokens t
      INNER JOIN workspace_agent_bots b ON b.id = t.bot_id AND b.space_id = t.space_id
      WHERE t.space_id = ? AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > ?) AND b.status = 'active'
      ORDER BY t.bot_id, t.created_at DESC`).all(event.spaceId, now().toISOString());
    const authorizedByBot = new Map();
    for (const candidate of tokens) {
      if (authorizedByBot.has(candidate.botId)) continue;
      try {
        const decision = await authorizeDelivery(candidate, event);
        if (decision) authorizedByBot.set(candidate.botId, decision.auth);
      } catch (error) {
        if (error?.code !== "bot.invalid_token") throw error;
      }
    }
    for (const [botId, auth] of authorizedByBot) {
      const queued = await authorizeAndEnqueue(auth, event);
      if (!queued) continue;
      const delivery = await db.prepare(`SELECT id, sequence, event_id AS eventId, event_type AS eventType, conversation_id AS conversationId,
        payload_json AS payloadJson, status, attempts, created_at AS createdAt FROM workspace_agent_bot_deliveries WHERE bot_id = ? AND sequence = ?`)
        .get(botId, event.sequence);
      let delivered = false;
      for (const record of [...(connections.get(botId) ?? [])]) {
        try {
          const decision = await authorizeDelivery(record.auth, event);
          if (!decision) continue;
          record.auth = decision.auth;
          if (!delivered) {
            const timestamp = now().toISOString();
            await db.prepare(`UPDATE workspace_agent_bot_deliveries SET status = 'delivered', delivered_at = ?, attempts = attempts + 1
              WHERE id = ? AND status <> 'expired'`).run(timestamp, delivery.id);
            delivered = true;
          }
          record.connection.send(JSON.stringify({ version: BOT_GATEWAY_VERSION, type: "event", event: projectDelivery(delivery) }));
        } catch (error) {
          if (error?.code === "bot.invalid_token") {
            await rejectConnection(record, "bot token revoked");
          }
        }
      }
    }
  }

  async function registerConnection(auth, connection) {
    auth = await validateAuth(auth);
    const set = connections.get(auth.botId) ?? new Set();
    const record = { auth, connection };
    set.add(record);
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
      set.delete(record);
      if (set.size === 0) {
        connections.delete(auth.botId);
        await botService.updateConnection(auth.botId, auth.spaceId, { status: "disconnected", disconnectedAt: now().toISOString() }).catch(() => {});
      }
    };
  }

  async function heartbeat(auth) {
    auth = await validateAuth(auth);
    const timestamp = now().toISOString();
    await botService.updateConnection(auth.botId, auth.spaceId, { status: "connected", lastHeartbeatAt: timestamp });
    return { timestamp };
  }

  async function loadWorkspaceEvent(eventId, spaceId) {
    if (!eventId || !spaceId) return null;
    return await db.prepare(`SELECT id, space_id AS spaceId, seq AS sequence, type AS eventType,
      actor_user_id AS actorUserId, conversation_id AS conversationId,
      target_type AS targetType, target_id AS targetId, payload_json AS eventPayloadJson,
      created_at AS createdAt
      FROM workspace_events WHERE id = ? AND space_id = ?`).get(eventId, spaceId);
  }

  async function authorizeAndEnqueue(auth, event) {
    const existing = await db.prepare(`SELECT id, status, expires_at AS expiresAt
      FROM workspace_agent_bot_deliveries WHERE bot_id = ? AND event_id = ?`).get(auth.botId, event.id);
    if (existing) return existing.status !== "expired" && new Date(existing.expiresAt).getTime() > now().getTime();
    const decision = await authorizeDelivery(auth, event);
    if (!decision || !await passesDeliveryRateLimits(decision.auth, event)) return false;
    const inserted = await enqueueDelivery(decision.auth, event);
    return Boolean(inserted?.changes);
  }

  async function authorizeDelivery(auth, event) {
    const currentAuth = await validateAuth(auth);
    const requiredScope = DELIVERY_EVENT_SCOPES[event?.eventType];
    if (!requiredScope || !currentAuth.scopes.includes(requiredScope) || !event.conversationId) return null;
    let conversation;
    try {
      conversation = await requireConversation(currentAuth, event.conversationId);
    } catch (error) {
      if (error instanceof WorkspaceBotGatewayError) return null;
      throw error;
    }
    const grant = await db.prepare(`SELECT allow_trigger AS allowTrigger
      FROM workspace_agent_bot_context_grants
      WHERE bot_id = ? AND space_id = ? AND conversation_id = ?`)
      .get(currentAuth.botId, currentAuth.spaceId, conversation.id);
    if (!grant || !Boolean(grant.allowTrigger)) return null;
    const sender = await db.prepare(`SELECT u.id, u.kind, sm.role
      FROM users u
      INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ? AND sm.removed_at IS NULL
      INNER JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = ? AND cm.removed_at IS NULL
      WHERE u.id = ?`).get(currentAuth.spaceId, conversation.id, event.actorUserId);
    if (!sender || sender.kind !== "human" || sender.role === "auditor" || sender.id === currentAuth.userId) return null;
    const settings = await readSettings(db, currentAuth.botId, currentAuth.spaceId);
    if (!settings || !await isSenderVisible(currentAuth, sender.id, conversation, settings)) return null;
    const trigger = await resolveEventTrigger(currentAuth, event, conversation);
    if (!trigger) return null;
    return { auth: currentAuth, conversation, sender, trigger };
  }

  async function resolveEventTrigger(auth, event, conversation) {
    const payload = parseJsonObject(event.eventPayloadJson);
    if (event.eventType === "message.created") {
      const message = await db.prepare(`SELECT author_id AS authorId, content_json AS contentJson,
        plain_text AS plainText, deleted_at AS deletedAt, recalled_at AS recalledAt
        FROM messages WHERE id = ? AND space_id = ? AND conversation_id = ?`)
        .get(event.targetId, auth.spaceId, conversation.id);
      if (!message || message.deletedAt || message.recalledAt || message.authorId !== event.actorUserId) return null;
      const content = parseJsonObject(message.contentJson);
      if (!content || !Array.isArray(content.blocks) || content.blocks.length === 0 || content.blocks.length > MAX_TRIGGER_BLOCKS) return null;
      const byteSize = Buffer.byteLength(typeof message.plainText === "string" ? message.plainText : "", "utf8");
      if (byteSize === 0 || byteSize > MAX_TRIGGER_BYTES) return null;
      if (conversation.type === "direct") return { type: "direct_message", messageId: event.targetId };
      const mentioned = content.blocks.some((block) => block?.type === "mention" && block.userId === auth.userId);
      return mentioned ? { type: "mention", messageId: event.targetId } : null;
    }
    if (event.eventType === "bot.mentioned") {
      return eventTargetsBot(auth, event, payload) ? { type: "mention" } : null;
    }
    if (event.eventType === "command.invoked") {
      if (!eventTargetsBot(auth, event, payload)) return null;
      if (conversation.type === "group") {
        const mentioned = Array.isArray(payload.mentionedBotIds) && payload.mentionedBotIds.includes(auth.userId);
        if (!mentioned && payload.trigger?.type !== "mention") return null;
      }
      return { type: "command" };
    }
    return null;
  }

  function eventTargetsBot(auth, event, payload) {
    return [event.targetId, payload.botId, payload.botUserId].includes(auth.botId) ||
      [event.targetId, payload.botId, payload.botUserId].includes(auth.userId);
  }

  async function isSenderVisible(auth, senderId, conversation, settings) {
    if (settings.visibilityPolicy === "private") return senderId === auth.ownerUserId;
    if (settings.visibilityPolicy === "space_members") return true;
    if (settings.visibilityPolicy === "groups") return conversation.type === "group";
    if (settings.visibilityPolicy !== "specified_members") return false;
    const allowed = await db.prepare(`SELECT 1 AS allowed FROM workspace_agent_bot_visibility_members
      WHERE bot_id = ? AND space_id = ? AND user_id = ?`).get(auth.botId, auth.spaceId, senderId);
    return Boolean(allowed);
  }

  async function passesDeliveryRateLimits(auth, event) {
    const limits = await db.prepare(`SELECT requests_per_minute AS requestsPerMinute,
      member_daily_requests AS memberDailyRequests, event_backlog_limit AS eventBacklogLimit
      FROM workspace_agent_bot_limits WHERE bot_id = ? AND space_id = ?`).get(auth.botId, auth.spaceId);
    if (!limits) return false;
    const timestamp = now();
    const minuteStart = new Date(timestamp.getTime() - 60_000).toISOString();
    const dayStart = new Date(timestamp.getTime() - 86_400_000).toISOString();
    const recent = await db.prepare(`SELECT COUNT(*) AS count FROM workspace_agent_bot_deliveries
      WHERE bot_id = ? AND space_id = ? AND created_at >= ?`).get(auth.botId, auth.spaceId, minuteStart);
    if (Number(recent?.count) >= Number(limits.requestsPerMinute)) return false;
    const memberDaily = await db.prepare(`SELECT COUNT(*) AS count
      FROM workspace_agent_bot_deliveries d
      INNER JOIN workspace_events we ON we.id = d.event_id AND we.space_id = d.space_id
      WHERE d.bot_id = ? AND d.space_id = ? AND we.actor_user_id = ? AND d.created_at >= ?`)
      .get(auth.botId, auth.spaceId, event.actorUserId, dayStart);
    if (Number(memberDaily?.count) >= Number(limits.memberDailyRequests)) return false;
    const backlog = await db.prepare(`SELECT COUNT(*) AS count FROM workspace_agent_bot_deliveries
      WHERE bot_id = ? AND space_id = ? AND status IN ('queued', 'delivered') AND expires_at > ?`)
      .get(auth.botId, auth.spaceId, timestamp.toISOString());
    return Number(backlog?.count) < Number(limits.eventBacklogLimit);
  }

  async function expireDeliveries(auth) {
    await db.prepare(`UPDATE workspace_agent_bot_deliveries SET status = 'expired'
      WHERE bot_id = ? AND space_id = ? AND status <> 'expired' AND expires_at <= ?`)
      .run(auth.botId, auth.spaceId, now().toISOString());
  }

  async function currentWorkspaceSequence(spaceId) {
    const row = await db.prepare("SELECT next_seq - 1 AS sequence FROM workspace_event_cursors WHERE space_id = ?").get(spaceId);
    return Math.max(0, Number(row?.sequence ?? 0));
  }

  async function rejectConnection(record, reason) {
    const set = connections.get(record.auth.botId);
    set?.delete(record);
    try { record.connection.close?.(1008, reason); } catch { /* socket close is best effort */ }
    if (set && set.size === 0) {
      connections.delete(record.auth.botId);
      await botService.updateConnection(record.auth.botId, record.auth.spaceId, {
        status: "revoked",
        disconnectedAt: now().toISOString(),
        lastErrorCode: "bot.invalid_token",
        lastErrorAt: now().toISOString()
      }).catch(() => {});
    }
  }

  return Object.freeze({ authenticate, validateAuth, getMe, getContext, sendMessage, sendCard, updateCard, getAttachment, createAttachment, typing, acknowledge, replay, dispatchWorkspaceEvent, registerConnection, heartbeat, requireConversation, requireContextGrant, requireScope, extractBearerToken, safeBot });
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

function parseScopes(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((scope) => BOT_SCOPE_ALLOWLIST.includes(scope)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  return db.transaction(async () => {
    await db.lock?.(`workspace-bot-idempotency:${auth.botId}:${operation}:${key}`);
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
  });
}

function rejectImmutableCardFields(input) {
  const immutable = [
    "cardType",
    "schemaVersion",
    "spaceId",
    "conversationId",
    "sourceKind",
    "sourceId",
    "visibilityScope",
    "resourceType",
    "resourceId",
    "createdByUserId",
    "ownerUserId",
    "botUserId",
    "botId"
  ];
  const field = immutable.find((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (field) throw new WorkspaceBotGatewayError("card.immutable_field", "卡片来源或范围不可修改", 400);
}

function rejectOpaqueCardCreateFields(input) {
  const forbidden = ["cardId", "sourceKind", "sourceId", "visibilityScope", "resourceType", "resourceId", "createdByUserId", "ownerUserId", "botUserId", "botId", "spaceId"];
  const field = forbidden.find((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (field) throw new WorkspaceBotGatewayError("card.immutable_field", "卡片来源或范围由服务端决定", 400);
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

function projectCard(row, botId = null) {
  const block = row?.block ?? {};
  let payload = row?.payload;
  if (payload === undefined) {
    try { payload = JSON.parse(row?.payloadJson); } catch { payload = {}; }
  }
  return {
    id: row?.id ?? block.cardId,
    botId: row?.botId ?? botId,
    spaceId: row?.spaceId ?? null,
    conversationId: row?.conversationId ?? null,
    cardType: row?.cardType ?? block.cardType,
    schemaVersion: Number(row?.schemaVersion ?? block.schemaVersion),
    payload,
    fallbackText: row?.fallbackText ?? block.fallbackText,
    revision: Number(row?.revision ?? 1),
    status: row?.status ?? "active",
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null
  };
}

function opaqueCardSourceId(botId, idempotencyKey) {
  return `botkey_${createHash("sha256").update(`${botId}:${idempotencyKey}`, "utf8").digest("hex").slice(0, 48)}`;
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
