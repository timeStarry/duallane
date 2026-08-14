import { randomUUID } from "node:crypto";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { writeAudit } from "./audit.mjs";
import {
  MESSAGE_CONTENT_FORMAT,
  runWorkspaceTransaction,
  writeWorkspaceEvent
} from "./workspace.mjs";
import { sanitizeWorkspaceAvatarUrl } from "./avatar.mjs";
import {
  CardValidationError,
  normalizeCardBlock,
  normalizeCardPayload
} from "./workspace-cards.mjs";

export const TOPIC_MESSAGE_MAX_CODE_POINTS = 30_000;
export const TOPIC_MESSAGE_MAX_BYTES = 100 * 1024;
export const TOPIC_MESSAGE_DEFAULT_LIMIT = 80;
export const TOPIC_MESSAGE_MAX_LIMIT = 200;
export const TOPIC_SYNC_CARD_TYPE = "workspace.topic-message-synced";
export const TOPIC_SYNC_CARD_SCHEMA_VERSION = 1;

const TOPIC_CARD_TYPE = "workspace.topic-created";
const TOPIC_CARD_SCHEMA_VERSION = 1;
const TOPIC_CARD_STATUSES = new Set(["open", "closed", "archived"]);
const TOPIC_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOPIC_CARD_LIMITS = Object.freeze({ maxPayloadBytes: 16 * 1024, maxTextBytes: 8 * 1024 });

export const TOPIC_SYNC_CARD_DEFINITION = Object.freeze({
  cardType: TOPIC_SYNC_CARD_TYPE,
  schemaVersion: TOPIC_SYNC_CARD_SCHEMA_VERSION,
  validatePayload: validateTopicSyncCardPayload,
  limits: TOPIC_CARD_LIMITS,
  allowPublicUrls: false
});

const RATE_LIMITS = Object.freeze({
  create: { limit: 60, windowMs: 60_000 },
  sync: { limit: 30, windowMs: 60_000 }
});
const rateBuckets = new Map();

/** Build the safe, non-content card projection for a synced topic message. */
export function projectTopicMessageSyncedCard(input = {}) {
  const topicId = normalizeTopicReference(input.topicId);
  const topicMessageId = normalizeTopicReference(input.topicMessageId);
  const projectionId = normalizeTopicReference(input.projectionId);
  const title = normalizeTopicCardTitle(input.title);
  const projectionType = normalizeTopicProjectionType(input.projectionType);
  const status = normalizeTopicCardStatus(input.status);
  if (!topicId || !topicMessageId || !projectionId || !title || !projectionType || !status) {
    throw new CardValidationError("card.domain_invalid", "话题同步卡片数据无效");
  }
  const messagePreview = summarize(input.messagePreview);
  const payload = normalizeCardPayload({
    topicId,
    topicMessageId,
    projectionId,
    projectionType,
    title,
    messagePreview,
    status
  }, { limits: TOPIC_CARD_LIMITS });
  return {
    block: {
      type: "card",
      cardId: `topic_projection_${projectionId}`,
      cardType: TOPIC_SYNC_CARD_TYPE,
      schemaVersion: TOPIC_SYNC_CARD_SCHEMA_VERSION,
      fallbackText: `${messagePreview || "话题消息"} · #${title}`
    },
    payload: validateTopicSyncCardPayload(payload)
  };
}

/** Persist the topic-created card in the same transaction as its message. */
export async function persistTopicCreatedCard(db, input = {}) {
  const topic = input.topic ?? await loadTopicCardTopic(db, input.topicId);
  if (!topic) throw new TopicMessageError("topic.not_found", "话题不存在", 404);
  const participantCount = Number(topic.participantCount ?? await countTopicParticipants(db, topic.id));
  const topicId = normalizeTopicReference(topic.id);
  const title = normalizeTopicCardTitle(topic.title);
  const descriptionPreview = summarize(topic.description ?? topic.descriptionPreview);
  const status = normalizeTopicCardStatus(topic.status ?? "open");
  if (!topicId || !title || !status) throw new TopicMessageError("topic.invalid_card", "话题卡片数据无效");
  const payload = normalizeCardPayload({
    topicId,
    title,
    descriptionPreview,
    participantCount: Number.isSafeInteger(participantCount) && participantCount >= 0 ? participantCount : 0,
    status,
    allowSyncToGroup: topic.allowSyncToGroup === true || Boolean(topic.allow_sync_to_group)
  }, { limits: TOPIC_CARD_LIMITS });
  const block = {
    type: "card",
    cardId: `topic_${topicId}`,
    cardType: TOPIC_CARD_TYPE,
    schemaVersion: TOPIC_CARD_SCHEMA_VERSION,
    fallbackText: `#${title}`
  };
  return await upsertTopicCard(db, {
    topic,
    block,
    payload,
    sourceId: topicId,
    actorId: input.actorId,
    cardStatus: "active"
  });
}

/** Persist or restore the authoritative card for a group projection. */
export async function persistTopicMessageSyncedCard(db, input = {}) {
  const topic = input.topic ?? await loadTopicCardTopic(db, input.topicId);
  const message = input.message ?? await db.prepare(`
    SELECT id, plain_text AS plainText FROM messages WHERE id = ? AND topic_id = ?
  `).get(input.topicMessageId, input.topicId);
  const projection = input.projection;
  if (!topic || !message || !projection) {
    throw new TopicMessageError("topic.message_not_found", "话题消息不存在", 404);
  }
  const card = projectTopicMessageSyncedCard({
    topicId: topic.id,
    topicMessageId: message.id,
    projectionId: projection.id,
    projectionType: projection.projectionType ?? "group_sync",
    title: topic.title,
    messagePreview: message.plainText,
    status: topic.status
  });
  return await upsertTopicCard(db, {
    topic,
    block: card.block,
    payload: card.payload,
    sourceId: `topic-message:${topic.id}:${message.id}`,
    actorId: input.actorId,
    cardStatus: "active"
  });
}

/** Invalidate a synced card when a projection is unsynced or retained away. */
export async function invalidateTopicMessageCard(db, input = {}) {
  const projectionId = normalizeTopicReference(input.projectionId);
  if (!projectionId) return null;
  const cardId = `topic_projection_${projectionId}`;
  const row = await db.prepare(`
    SELECT id, space_id AS spaceId, conversation_id AS conversationId,
      card_type AS cardType, revision, status
    FROM workspace_cards WHERE id = ?
  `).get(cardId);
  if (!row || row.status !== "active") return row ?? null;
  const updatedAt = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE workspace_cards
    SET status = 'invalidated', revision = revision + 1, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).run(updatedAt, cardId);
  if (result.changes !== 1) return await db.prepare("SELECT id, revision, status FROM workspace_cards WHERE id = ?").get(cardId);
  const current = await db.prepare("SELECT revision FROM workspace_cards WHERE id = ?").get(cardId);
  await writeTopicCardEvent(db, {
    type: "card.invalidated",
    spaceId: row.spaceId,
    conversationId: row.conversationId,
    actorId: input.actorId,
    cardId,
    cardType: row.cardType,
    revision: Number(current?.revision) || Number(row.revision) + 1,
    status: "invalidated"
  });
  return { ...row, revision: Number(current?.revision) || Number(row.revision) + 1, status: "invalidated" };
}

/** Refresh participant count/status for all cards belonging to a topic. */
export async function refreshTopicCards(db, input = {}) {
  const topic = await loadTopicCardTopic(db, input.topicId);
  if (!topic) return [];
  const participantCount = await countTopicParticipants(db, topic.id);
  const rows = await db.prepare(`
    SELECT id, space_id AS spaceId, conversation_id AS conversationId,
      card_type AS cardType, payload_json AS payloadJson, fallback_text AS fallbackText,
      source_kind AS sourceKind, source_id AS sourceId, resource_type AS resourceType,
      resource_id AS resourceId, visibility_scope AS visibilityScope,
      created_by_user_id AS createdByUserId, status, revision,
      expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
    FROM workspace_cards
    WHERE space_id = ? AND source_kind = 'topic' AND resource_type = 'topic' AND resource_id = ?
      AND status IN ('active', 'invalidated')
    ORDER BY created_at ASC, id ASC
  `).all(topic.spaceId, topic.id);
  const updated = [];
  for (const row of rows) {
    const current = parseJsonObject(row.payloadJson);
    if (!current) continue;
    const payload = row.cardType === TOPIC_CARD_TYPE
      ? {
        ...current,
        participantCount,
        status: normalizeTopicCardStatus(topic.status),
        allowSyncToGroup: topic.allowSyncToGroup === true || Boolean(topic.allow_sync_to_group)
      }
      : row.cardType === TOPIC_SYNC_CARD_TYPE
        ? { ...current, status: normalizeTopicCardStatus(topic.status) }
        : null;
    if (!payload) continue;
    const normalized = row.cardType === TOPIC_CARD_TYPE
      ? normalizeTopicCreatedCardPayload(payload)
      : validateTopicSyncCardPayload(normalizeCardPayload(payload, { limits: TOPIC_CARD_LIMITS }));
    if (JSON.stringify(normalized) === JSON.stringify(current)) continue;
    const next = await updateTopicCardRow(db, row, normalized, row.status, input.actorId);
    updated.push(next);
  }
  return updated;
}

/**
 * Create the initial topic message and the group creation card inside the
 * caller's transaction. This helper deliberately stores only a safe card
 * summary in the group message; the full topic body remains topic-scoped.
 */
export async function createTopicCreationBundle(db, input = {}) {
  const topic = await db.prepare(`
    SELECT id, space_id AS spaceId, conversation_id AS conversationId,
      title, description, status, allow_sync_to_group AS allowSyncToGroup,
      (SELECT COUNT(*) FROM topic_members WHERE topic_id = topics.id AND left_at IS NULL) AS participantCount
    FROM topics WHERE id = ?
  `).get(input.topicId);
  if (!topic) throw new TopicMessageError("topic.not_found", "话题不存在", 404);

  await writeTopicEvent(db, {
    type: "topic.created",
    spaceId: topic.spaceId,
    actorId: input.actorId,
    conversationId: topic.conversationId,
    targetType: "topic",
    targetId: topic.id,
    payload: {
      topicId: topic.id,
      conversationId: topic.conversationId,
      title: topic.title,
      descriptionPreview: summarize(topic.description)
    }
  });

  const content = normalizeContent({
    format: MESSAGE_CONTENT_FORMAT,
    blocks: [{ type: "text", text: topic.description }]
  });
  const initialMessage = await insertTopicMessageRow(db, {
    topic,
    actorId: input.actorId,
    clientMessageId: `topic-create:${topic.id}`,
    content,
    request: input.request,
    emitEvent: true
  });

  const descriptionPreview = summarize(topic.description);
  const cardContent = normalizeContent({
    format: MESSAGE_CONTENT_FORMAT,
    blocks: [
      { type: "text", text: `#${topic.title}${descriptionPreview ? `\n${descriptionPreview}` : ""}` },
      {
        type: "card",
        cardId: `topic_${topic.id}`,
        cardType: "workspace.topic-created",
        schemaVersion: 1,
        fallbackText: `#${topic.title}`
      }
    ]
  });
  const cardMessage = await insertConversationCardRow(db, {
    spaceId: topic.spaceId,
    conversationId: topic.conversationId,
    actorId: input.actorId,
    clientMessageId: `topic-card:${topic.id}`,
    content: cardContent,
    topicId: topic.id,
    request: input.request
  });

  await persistTopicCreatedCard(db, {
    topic,
    actorId: input.actorId,
    request: input.request
  });

  return { initialMessage, cardMessage };
}

export async function createTopicMessage(db, request, input = {}) {
  const context = await requireTopicMember(db, input, "topic.message.create", { requireOpen: true });
  consumeRateLimit(context.actor.id, "create");
  if (input.syncToGroup !== undefined && typeof input.syncToGroup !== "boolean") {
    throw new TopicMessageError("topic.invalid_sync_policy", "同步策略无效");
  }
  const clientMessageId = normalizeClientMessageId(input.clientMessageId);
  const content = normalizeContent(input.content ?? (typeof input.body === "string"
    ? { format: MESSAGE_CONTENT_FORMAT, blocks: [{ type: "text", text: input.body }] }
    : null));
  await validateTopicMentions(db, context.topic, content);
  const replyToMessageId = normalizeId(input.replyToMessageId) || null;
  if (replyToMessageId) {
    const reply = await db.prepare(`
      SELECT 1 FROM messages WHERE id = ? AND topic_id = ? AND deleted_at IS NULL
    `).get(replyToMessageId, context.topic.id);
    if (!reply) throw new TopicMessageError("topic.invalid_reply", "回复的话题消息不存在");
  }

  return await runWorkspaceTransaction(db, async () => {
    if (typeof db.lock === "function") {
      await db.lock(`workspace:topic:message:${context.topic.id}:${context.actor.id}:${clientMessageId}`);
    }
    const result = await insertTopicMessageRow(db, {
      topic: context.topic,
      actorId: context.actor.id,
      clientMessageId,
      content,
      replyToMessageId,
      request,
      emitEvent: true
    });
    if (input.syncToGroup === true) {
      await syncTopicMessageRow(db, request, {
        context,
        messageId: result.id,
        actorId: context.actor.id
      });
    }
    if (!result.duplicate && result.eventSeq) {
      await input.scheduleEmailNotifications?.({
        authorId: context.actor.id,
        spaceId: context.topic.spaceId,
        conversationId: context.topic.conversationId,
        topicId: context.topic.id,
        messageId: result.id,
        eventSeq: result.eventSeq,
        content,
        createdAt: result.createdAt
      });
      await input.scheduleNtfyNotifications?.({
        authorId: context.actor.id,
        spaceId: context.topic.spaceId,
        conversationId: context.topic.conversationId,
        topicId: context.topic.id,
        messageId: result.id,
        eventSeq: result.eventSeq,
        content,
        createdAt: result.createdAt
      });
    }
    return {
      message: await projectTopicMessage(db, result.id, context.actor.id),
      unread: await getTopicUnread(db, context.topic.id, context.actor.id)
    };
  });
}

export async function listTopicMessages(db, input = {}) {
  const context = await requireTopicMember(db, input, "topic.message.read");
  const limit = parseBoundedLimit(input.limit, TOPIC_MESSAGE_DEFAULT_LIMIT, TOPIC_MESSAGE_MAX_LIMIT);
  const before = normalizeId(input.before);
  const after = normalizeId(input.after);
  if (before && after) throw new TopicMessageError("topic.invalid_cursor", "消息游标无效");
  const cursorId = before || after;
  const cursor = cursorId
    ? await db.prepare(`
      SELECT created_at AS createdAt, id
      FROM messages WHERE id = ? AND topic_id = ? AND deleted_at IS NULL
    `).get(cursorId, context.topic.id)
    : null;
  if (cursorId && !cursor) return [];
  const filter = cursor
    ? before
      ? "AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))"
      : "AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))"
    : "";
  const params = cursor
    ? [context.actor.id, context.topic.id, cursor.createdAt, cursor.createdAt, cursor.id, limit]
    : [context.actor.id, context.topic.id, limit];
  const rows = await db.prepare(`
    SELECT m.id, m.space_id AS spaceId, m.conversation_id AS conversationId,
      m.topic_id AS topicId, m.author_id AS authorId, m.author_kind AS authorKind,
      m.kind, m.client_message_id AS clientMessageId,
      m.content_format AS contentFormat, m.content_json AS contentJson,
      m.plain_text AS plainText, m.reply_to_message_id AS replyToMessageId,
      m.created_at AS createdAt, m.edited_at AS editedAt, m.deleted_at AS deletedAt,
       u.display_name AS authorDisplayName, u.nickname AS authorNickname,
       u.github_login AS authorGithubLogin, u.avatar_url AS authorAvatarUrl,
       ur.remark AS authorRemark
    FROM messages m
    LEFT JOIN users u ON u.id = m.author_id
    LEFT JOIN user_remarks ur ON ur.owner_user_id = ? AND ur.target_user_id = u.id
    WHERE m.topic_id = ? AND m.deleted_at IS NULL ${filter}
    ORDER BY m.created_at ${after ? "ASC" : "DESC"}, m.id ${after ? "ASC" : "DESC"}
    LIMIT ?
  `).all(...params);
  const messages = await Promise.all(rows.map((row) => projectTopicMessageRow(row, context.actor.id)));
  return after ? messages : messages.reverse();
}

export async function markTopicRead(db, request, input = {}) {
  const context = await requireTopicMember(db, input, "topic.message.read");
  const requested = normalizeId(input.messageId);
  const marker = requested
    ? await db.prepare(`
      SELECT id, created_at AS createdAt FROM messages
      WHERE id = ? AND topic_id = ? AND deleted_at IS NULL
    `).get(requested, context.topic.id)
    : await db.prepare(`
      SELECT id, created_at AS createdAt FROM messages
      WHERE topic_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(context.topic.id);
  if (requested && !marker) throw new TopicMessageError("topic.message_not_found", "话题消息不存在", 404);
  const event = marker
    ? await db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS seq
      FROM workspace_events
      WHERE type IN ('topic.message.created', 'message.created') AND target_id = ?
    `).get(marker.id)
    : { seq: 0 };
  await runWorkspaceTransaction(db, async () => {
    await db.prepare(`
      UPDATE topic_members
      SET last_read_message_id = ?, last_read_seq = ?,
        notification_level = COALESCE(notification_level, 'all')
      WHERE topic_id = ? AND user_id = ? AND left_at IS NULL
        AND (last_read_seq IS NULL OR last_read_seq <= ?)
    `).run(marker?.id ?? null, Number(event.seq) || 0, context.topic.id, context.actor.id, Number(event.seq) || 0);
    await writeAudit(db, auditEvent(request, context.actor, "topic.read", context.topic.id, "success"));
  });
  return {
    topicId: context.topic.id,
    lastReadMessageId: marker?.id ?? null,
    lastReadSeq: Number(event.seq) || 0,
    unreadCount: await getTopicUnread(db, context.topic.id, context.actor.id)
  };
}

export async function getTopicUnread(db, topicId, actorId) {
  const member = await db.prepare(`
    SELECT last_read_message_id AS lastReadMessageId
    FROM topic_members WHERE topic_id = ? AND user_id = ? AND left_at IS NULL
  `).get(topicId, actorId);
  if (!member) return 0;
  if (!member.lastReadMessageId) {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE topic_id = ? AND deleted_at IS NULL AND (author_id IS NULL OR author_id <> ?)").get(topicId, actorId);
    return Number(row?.count) || 0;
  }
  const marker = await db.prepare("SELECT created_at AS createdAt, id FROM messages WHERE id = ? AND topic_id = ?").get(member.lastReadMessageId, topicId);
  if (!marker) {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE topic_id = ? AND deleted_at IS NULL AND (author_id IS NULL OR author_id <> ?)").get(topicId, actorId);
    return Number(row?.count) || 0;
  }
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM messages
    WHERE topic_id = ? AND deleted_at IS NULL
      AND (author_id IS NULL OR author_id <> ?)
      AND (created_at > ? OR (created_at = ? AND id > ?))
  `).get(topicId, actorId, marker.createdAt, marker.createdAt, marker.id);
  return Number(row?.count) || 0;
}

export async function syncTopicMessage(db, request, input = {}) {
  const context = await requireTopicMember(db, input, "topic.sync_to_group");
  consumeRateLimit(context.actor.id, "sync");
  const messageId = normalizeId(input.messageId);
  if (!messageId) throw new TopicMessageError("topic.message_required", "话题消息不能为空");
  return await runWorkspaceTransaction(db, async () => {
    if (typeof db.lock === "function") {
      await db.lock(`workspace:topic:sync:${context.topic.id}:${messageId}`);
    }
    const projection = await syncTopicMessageRow(db, request, {
      context,
      messageId,
      actorId: context.actor.id
    });
    return { projection };
  });
}

export async function unsyncTopicMessage(db, request, input = {}) {
  const context = await requireTopicMember(db, input, "topic.sync_to_group");
  const messageId = normalizeId(input.messageId);
  if (!messageId) throw new TopicMessageError("topic.message_required", "话题消息不能为空");
  return await runWorkspaceTransaction(db, async () => {
    if (typeof db.lock === "function") {
      await db.lock(`workspace:topic:sync:${context.topic.id}:${messageId}`);
    }
    const projection = await db.prepare(`
      SELECT id, group_message_id AS groupMessageId
      FROM topic_group_projections
      WHERE topic_id = ? AND topic_message_id = ? AND removed_at IS NULL
    `).get(context.topic.id, messageId);
    if (!projection) return { projection: null, removed: false };
    const now = new Date().toISOString();
    await db.prepare("UPDATE topic_group_projections SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL")
      .run(now, now, projection.id);
    await db.prepare("UPDATE messages SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND topic_id IS NULL")
      .run(now, projection.groupMessageId);
    await invalidateTopicMessageCard(db, {
      projectionId: projection.id,
      actorId: context.actor.id
    });
    await writeTopicEvent(db, {
      type: "topic.message.unsynced",
      spaceId: context.topic.spaceId,
      actorId: context.actor.id,
      conversationId: context.topic.conversationId,
      targetType: "topic_message",
      targetId: messageId,
      payload: { topicId: context.topic.id, topicMessageId: messageId, projectionId: projection.id }
    });
    await writeTopicEvent(db, {
      type: "message.recalled",
      spaceId: context.topic.spaceId,
      actorId: context.actor.id,
      conversationId: context.topic.conversationId,
      targetType: "message",
      targetId: projection.groupMessageId,
      payload: { messageId: projection.groupMessageId, conversationId: context.topic.conversationId }
    });
    await writeAudit(db, auditEvent(request, context.actor, "topic.message.unsync", messageId, "success"));
    return { projection: { ...projection, removedAt: now }, removed: true };
  });
}

export async function listTopicProjections(db, input = {}) {
  const context = await requireTopicMember(db, input, "topic.message.read");
  return await db.prepare(`
    SELECT id, topic_id AS topicId, topic_message_id AS topicMessageId,
      group_conversation_id AS groupConversationId, group_message_id AS groupMessageId,
      projection_type AS projectionType, created_at AS createdAt, updated_at AS updatedAt,
      removed_at AS removedAt
    FROM topic_group_projections
    WHERE topic_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(context.topic.id, parseBoundedLimit(input.limit, 100, 200));
}

async function syncTopicMessageRow(db, request, { context, messageId, actorId }) {
  if (!Boolean(context.topic.allowSyncToGroup)) {
    throw new TopicMessageError("topic.sync_disabled", "该话题未开启同步到群聊");
  }
  const message = await db.prepare(`
    SELECT id, plain_text AS plainText, deleted_at AS deletedAt
    FROM messages WHERE id = ? AND topic_id = ?
  `).get(messageId, context.topic.id);
  if (!message || message.deletedAt) throw new TopicMessageError("topic.message_not_found", "话题消息不存在", 404);
  const existing = await db.prepare(`
    SELECT id, topic_id AS topicId, topic_message_id AS topicMessageId,
      group_conversation_id AS groupConversationId, group_message_id AS groupMessageId,
      projection_type AS projectionType, created_at AS createdAt, updated_at AS updatedAt,
      removed_at AS removedAt
    FROM topic_group_projections
    WHERE topic_message_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(message.id);
  if (existing && !existing.removedAt) {
    await persistTopicMessageSyncedCard(db, {
      topic: context.topic,
      message,
      projection: existing,
      actorId
    });
    return existing;
  }

  const projectionId = existing?.removedAt ? existing.id : `tgp_${randomUUID()}`;
  const groupMessageId = randomUUID();
  const now = new Date().toISOString();
  const summary = summarize(message.plainText);
  const fallbackText = `${summary || "话题消息"} · #${context.topic.title}`;
  const content = normalizeContent({
    format: MESSAGE_CONTENT_FORMAT,
    blocks: [
      { type: "text", text: fallbackText },
      {
        type: "card",
        cardId: `topic_projection_${projectionId}`,
        cardType: TOPIC_SYNC_CARD_TYPE,
        schemaVersion: 1,
        fallbackText
      }
    ]
  });
  const inserted = await db.prepare(`
    INSERT INTO messages (
      id, space_id, conversation_id, topic_id, author_id, author_kind, kind,
      client_message_id, content_format, content_json, plain_text,
      reply_to_message_id, created_at, edited_at, deleted_at
    ) VALUES (?, ?, ?, NULL, ?, 'human', 'user', ?, ?, ?, ?, NULL, ?, NULL, NULL)
    ON CONFLICT DO NOTHING
    RETURNING id
  `).run(
    groupMessageId,
    context.topic.spaceId,
    context.topic.conversationId,
    actorId,
    `topic-sync:${context.topic.id}:${message.id}:${groupMessageId}`,
    MESSAGE_CONTENT_FORMAT,
    JSON.stringify(content),
    content.plainText,
    now
  );
  if (inserted.changes === 0) {
    throw new TopicMessageError("topic.sync_conflict", "话题消息同步冲突，请重试", 409);
  }
  if (existing?.removedAt) {
    await db.prepare(`
      UPDATE topic_group_projections
      SET group_message_id = ?, updated_at = ?, removed_at = NULL
      WHERE id = ? AND removed_at IS NOT NULL
    `).run(groupMessageId, now, existing.id);
  } else {
    await db.prepare(`
      INSERT INTO topic_group_projections (
        id, topic_id, topic_message_id, group_conversation_id, group_message_id,
        projection_type, created_at, updated_at, removed_at
      ) VALUES (?, ?, ?, ?, ?, 'group_sync', ?, ?, NULL)
    `).run(projectionId, context.topic.id, message.id, context.topic.conversationId, groupMessageId, now, now);
  }
  const activeProjectionId = projectionId;
  await writeTopicEvent(db, {
    type: "topic.message.synced",
    spaceId: context.topic.spaceId,
    actorId,
    conversationId: context.topic.conversationId,
    targetType: "topic_message",
    targetId: message.id,
    payload: { topicId: context.topic.id, topicMessageId: message.id, projectionId: activeProjectionId }
  });
  await writeTopicEvent(db, {
    type: "message.created",
    spaceId: context.topic.spaceId,
    actorId,
    conversationId: context.topic.conversationId,
    targetType: "message",
    targetId: groupMessageId,
    payload: { messageId: groupMessageId, conversationId: context.topic.conversationId }
  });
  await writeAudit(db, auditEvent(request, context.actor, "topic.message.sync", message.id, "success"));
  const projection = {
    id: activeProjectionId,
    topicId: context.topic.id,
    topicMessageId: message.id,
    groupConversationId: context.topic.conversationId,
    groupMessageId,
    projectionType: "group_sync",
    createdAt: now,
    updatedAt: now,
    removedAt: null
  };
  await persistTopicMessageSyncedCard(db, {
    topic: context.topic,
    message,
    projection,
    actorId
  });
  return projection;
}

async function insertTopicMessageRow(db, { topic, actorId, clientMessageId, content, replyToMessageId = null, request, emitEvent }) {
  const serialized = JSON.stringify(content);
  const existing = await db.prepare(`
    SELECT id, content_json AS contentJson
    FROM messages
    WHERE topic_id = ? AND author_id = ? AND client_message_id = ?
  `).get(topic.id, actorId, clientMessageId);
  if (existing) {
    if (existing.contentJson !== serialized) {
      throw new TopicMessageError("topic.idempotency_conflict", "重复消息 ID 对应的内容不一致", 409);
    }
    return { id: existing.id, duplicate: true };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const inserted = await db.prepare(`
    INSERT INTO messages (
      id, space_id, conversation_id, topic_id, author_id, author_kind, kind,
      client_message_id, content_format, content_json, plain_text,
      reply_to_message_id, created_at, edited_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, 'human', 'user', ?, ?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT DO NOTHING
    RETURNING id
  `).run(
    id,
    topic.spaceId,
    topic.conversationId,
    topic.id,
    actorId,
    clientMessageId,
    MESSAGE_CONTENT_FORMAT,
    serialized,
    content.plainText,
    replyToMessageId,
    now
  );
  if (inserted.changes === 0) {
    const winner = await db.prepare(`
      SELECT id, content_json AS contentJson
      FROM messages
      WHERE topic_id = ? AND author_id = ? AND client_message_id = ?
    `).get(topic.id, actorId, clientMessageId);
    if (!winner || winner.contentJson !== serialized) {
      throw new TopicMessageError("topic.idempotency_conflict", "重复消息 ID 对应的内容不一致", 409);
    }
    return { id: winner.id, duplicate: true };
  }
  await db.prepare("UPDATE topics SET updated_at = ? WHERE id = ?").run(now, topic.id);
  if (emitEvent) {
    const topicEvent = await writeTopicEvent(db, {
      type: "topic.message.created",
      spaceId: topic.spaceId,
      actorId,
      conversationId: topic.conversationId,
      targetType: "topic_message",
      targetId: id,
      payload: { topicId: topic.id, topicMessageId: id }
    });
    await enforceTopicRetention(db, topic);
    await writeAudit(db, auditEvent(request, { id: actorId, spaceId: topic.spaceId }, "topic.message.create", id, "success"));
    return { id, duplicate: false, eventSeq: topicEvent.seq, topicEventSeq: topicEvent.seq, createdAt: now };
  }
  await writeAudit(db, auditEvent(request, { id: actorId, spaceId: topic.spaceId }, "topic.message.create", id, "success"));
  return { id, duplicate: false };
}

async function enforceTopicRetention(db, topic) {
  const conversation = await db.prepare(
    "SELECT retention_count AS retentionCount FROM conversations WHERE id = ? AND space_id = ?"
  ).get(topic.conversationId, topic.spaceId);
  const retentionCount = Number(conversation?.retentionCount);
  if (!Number.isSafeInteger(retentionCount) || retentionCount < 1) return;
  const stale = await db.prepare(`
    SELECT id
    FROM messages
    WHERE topic_id = ? AND deleted_at IS NULL
      AND id NOT IN (
        SELECT recent.id
        FROM messages recent
        WHERE recent.topic_id = ? AND recent.deleted_at IS NULL
        ORDER BY recent.created_at DESC, recent.id DESC
        LIMIT ?
      )
  `).all(topic.id, topic.id, retentionCount);
  if (stale.length === 0) return;
  const deletedAt = new Date().toISOString();
  for (const row of stale) {
    await db.prepare("UPDATE messages SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?").run(deletedAt, row.id);
    const projection = await db.prepare(`
      SELECT id, group_message_id AS groupMessageId
      FROM topic_group_projections
      WHERE topic_message_id = ? AND removed_at IS NULL
    `).get(row.id);
      if (projection) {
      await db.prepare("UPDATE topic_group_projections SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL")
        .run(deletedAt, deletedAt, projection.id);
        await db.prepare("UPDATE messages SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND topic_id IS NULL")
          .run(deletedAt, projection.groupMessageId);
        await invalidateTopicMessageCard(db, {
          projectionId: projection.id,
          actorId: null
        });
      await writeTopicEvent(db, {
        type: "topic.message.unsynced",
        spaceId: topic.spaceId,
        actorId: null,
        conversationId: topic.conversationId,
        targetType: "topic_message",
        targetId: row.id,
        payload: { topicId: topic.id, topicMessageId: row.id, projectionId: projection.id, reason: "retention" }
      });
      await writeTopicEvent(db, {
        type: "message.recalled",
        spaceId: topic.spaceId,
        actorId: null,
        conversationId: topic.conversationId,
        targetType: "message",
        targetId: projection.groupMessageId,
        payload: { messageId: projection.groupMessageId, conversationId: topic.conversationId, reason: "topic.retention" }
      });
    }
  }
}

async function insertConversationCardRow(db, { spaceId, conversationId, actorId, clientMessageId, content, topicId, request }) {
  const existing = await db.prepare(`
    SELECT id, content_json AS contentJson FROM messages
    WHERE space_id = ? AND conversation_id = ? AND author_id = ? AND client_message_id = ? AND topic_id IS NULL
  `).get(spaceId, conversationId, actorId, clientMessageId);
  const serialized = JSON.stringify(content);
  if (existing) return { id: existing.id, duplicate: true };
  const id = randomUUID();
  const now = new Date().toISOString();
  const inserted = await db.prepare(`
    INSERT INTO messages (
      id, space_id, conversation_id, topic_id, author_id, author_kind, kind,
      client_message_id, content_format, content_json, plain_text,
      reply_to_message_id, created_at, edited_at, deleted_at
    ) VALUES (?, ?, ?, NULL, ?, 'human', 'user', ?, ?, ?, ?, NULL, ?, NULL, NULL)
    ON CONFLICT DO NOTHING
    RETURNING id
  `).run(id, spaceId, conversationId, actorId, clientMessageId, MESSAGE_CONTENT_FORMAT, serialized, content.plainText, now);
  if (inserted.changes === 0) {
    const winner = await db.prepare(`
      SELECT id, content_json AS contentJson
      FROM messages
      WHERE space_id = ? AND conversation_id = ? AND author_id = ? AND client_message_id = ? AND topic_id IS NULL
    `).get(spaceId, conversationId, actorId, clientMessageId);
    if (winner) return { id: winner.id, duplicate: true };
  }
  await writeTopicEvent(db, {
    type: "message.created",
    spaceId,
    actorId,
    conversationId,
    targetType: "message",
    targetId: id,
    payload: { messageId: id, conversationId, topicId, topicCard: true }
  });
  await writeAudit(db, auditEvent(request, { id: actorId, spaceId }, "topic.create.card", id, "success"));
  return { id, duplicate: false };
}

async function projectTopicMessage(db, id, actorId) {
  const row = await db.prepare(`
    SELECT m.id, m.space_id AS spaceId, m.conversation_id AS conversationId,
      m.topic_id AS topicId, m.author_id AS authorId, m.author_kind AS authorKind,
      m.kind, m.client_message_id AS clientMessageId, m.content_format AS contentFormat,
      m.content_json AS contentJson, m.plain_text AS plainText,
      m.reply_to_message_id AS replyToMessageId, m.created_at AS createdAt,
      m.edited_at AS editedAt, m.deleted_at AS deletedAt,
       u.display_name AS authorDisplayName, u.nickname AS authorNickname,
       u.github_login AS authorGithubLogin, u.avatar_url AS authorAvatarUrl,
       ur.remark AS authorRemark
    FROM messages m
    LEFT JOIN users u ON u.id = m.author_id
    LEFT JOIN user_remarks ur ON ur.owner_user_id = ? AND ur.target_user_id = u.id
    WHERE m.id = ? AND m.topic_id IS NOT NULL AND m.deleted_at IS NULL
  `).get(actorId, id);
  return row ? projectTopicMessageRow(row, actorId) : null;
}

async function projectTopicMessageRow(row, _actorId) {
  let content;
  try {
    content = JSON.parse(row.contentJson);
  } catch {
    content = { format: row.contentFormat, plainText: row.plainText, blocks: [{ type: "text", text: row.plainText }] };
  }
  const authorName = row.authorRemark || row.authorNickname || row.authorGithubLogin || row.authorDisplayName || "成员";
  return {
    id: row.id,
    spaceId: row.spaceId,
    conversationId: row.conversationId,
    topicId: row.topicId,
    authorId: row.authorId,
    authorKind: row.authorKind,
    kind: row.kind,
    clientMessageId: row.clientMessageId,
    contentFormat: row.contentFormat,
    content,
    plainText: row.plainText,
    replyToMessageId: row.replyToMessageId,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    author: {
      id: row.authorId,
      displayName: authorName,
      nickname: row.authorNickname || null,
      remark: row.authorRemark || null,
      githubLogin: row.authorGithubLogin,
      avatarUrl: sanitizeWorkspaceAvatarUrl(row.authorAvatarUrl) || null
    }
  };
}

async function requireTopicMember(db, input, action, { requireOpen = false } = {}) {
  const actorId = normalizeId(input.actorId);
  if (!actorId) throw new TopicMessageError("auth.required", "请先登录共享空间", 401);
  const topicId = normalizeId(input.topicId);
  if (!topicId) throw new TopicMessageError("topic.invalid_id", "话题 ID 无效");
  const topic = await db.prepare(`
    SELECT t.id, t.space_id AS spaceId, t.conversation_id AS conversationId,
      t.title, t.status, t.allow_sync_to_group AS allowSyncToGroup
    FROM topics t WHERE t.id = ?
  `).get(topicId);
  if (!topic) throw new TopicMessageError("topic.not_found", "话题不存在", 404);
  const actor = await db.prepare(`
    SELECT u.id, u.kind, u.display_name AS displayName, u.nickname,
      u.github_login AS githubLogin, sm.space_id AS spaceId, sm.role
    FROM users u
    INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ? AND sm.removed_at IS NULL
    INNER JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = ? AND cm.removed_at IS NULL
    WHERE u.id = ? AND u.kind = 'human'
  `).get(topic.spaceId, topic.conversationId, actorId);
  if (!actor) throw new TopicMessageError("topic.not_found", "话题不存在", 404);
  const member = await db.prepare(`
    SELECT 1 FROM topic_members WHERE topic_id = ? AND user_id = ? AND left_at IS NULL
  `).get(topic.id, actor.id);
  if (!member) throw new TopicMessageError("topic.not_member", "你不是话题成员", 404);
  if (actor.role === "auditor") throw new TopicMessageError("permission.denied", "审计角色不能操作话题", 403);
  if (requireOpen && topic.status !== "open") throw new TopicMessageError("topic.not_open", "话题已关闭");
  if (!hasTopicCapability(actor.role, action)) throw new TopicMessageError("permission.denied", "你没有执行该操作的权限", 403);
  return { topic, actor };
}

function hasTopicCapability(role, action) {
  if (!role || role === "auditor") return false;
  if (role === "owner" || role === "admin") return true;
  return ["topic.message.read", "topic.message.create", "topic.sync_to_group"].includes(action);
}

function normalizeContent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.format !== MESSAGE_CONTENT_FORMAT) {
    throw new TopicMessageError("topic.invalid_content", "消息内容格式无效");
  }
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  if (!blocks.length) throw new TopicMessageError("topic.empty_message", "消息不能为空");
  const normalizedBlocks = blocks.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new TopicMessageError("topic.invalid_block", "消息块格式无效");
    if (block.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (!text.trim()) throw new TopicMessageError("topic.invalid_text", "文本消息不能为空");
      return { type: "text", text: stripControls(text) };
    }
    if (block.type === "card") {
      try { return normalizeCardBlock(block); } catch { throw new TopicMessageError("topic.invalid_card", "卡片消息无效"); }
    }
    if (block.type === "mention") {
      const userId = normalizeId(block.userId);
      if (!userId) throw new TopicMessageError("topic.invalid_mention", "提及成员无效");
      return { type: "mention", userId, label: normalizeLabel(block.label) || userId };
    }
    if (block.type === "link") {
      const url = typeof block.url === "string" ? block.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) throw new TopicMessageError("topic.invalid_link", "链接无效");
      return { type: "link", url, ...(normalizeLabel(block.label) ? { label: normalizeLabel(block.label) } : {}) };
    }
    if (block.type === "emoji") {
      const shortcode = normalizeLabel(block.shortcode);
      if (!/^[a-z0-9_+:-]{1,64}$/i.test(shortcode)) throw new TopicMessageError("topic.invalid_emoji", "表情格式无效");
      return { type: "emoji", shortcode };
    }
    throw new TopicMessageError("topic.invalid_block", "消息块格式无效");
  });
  const plainText = normalizedBlocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "mention") return `@${block.label}`;
    if (block.type === "link") return block.label || block.url;
    if (block.type === "emoji") return `:${block.shortcode}:`;
    if (block.type === "card") return block.fallbackText;
    return "";
  }).join("").trim();
  if (!plainText) throw new TopicMessageError("topic.empty_message", "消息不能为空");
  if (Array.from(plainText).length > TOPIC_MESSAGE_MAX_CODE_POINTS || Buffer.byteLength(plainText, "utf8") > TOPIC_MESSAGE_MAX_BYTES) {
    throw new TopicMessageError("topic.message_too_long", "话题消息过长");
  }
  return { format: MESSAGE_CONTENT_FORMAT, plainText, blocks: normalizedBlocks };
}

async function validateTopicMentions(db, topic, content) {
  const mentionedIds = [...new Set((content.blocks ?? [])
    .filter((block) => block?.type === "mention")
    .map((block) => block.userId)
    .filter(Boolean))];
  if (mentionedIds.length === 0) return;
  const placeholders = mentionedIds.map(() => "?").join(", ");
  const rows = await db.prepare(`
    SELECT tm.user_id AS userId
    FROM topic_members tm
    INNER JOIN users u ON u.id = tm.user_id AND u.kind = 'human'
    INNER JOIN conversation_members cm
      ON cm.conversation_id = ? AND cm.user_id = tm.user_id AND cm.removed_at IS NULL
    WHERE tm.topic_id = ? AND tm.left_at IS NULL AND tm.user_id IN (${placeholders})
  `).all(topic.conversationId, topic.id, ...mentionedIds);
  const allowed = new Set(rows.map((row) => row.userId));
  if (mentionedIds.some((userId) => !allowed.has(userId))) {
    throw new TopicMessageError("topic.invalid_mention", "只能提及当前话题成员");
  }
}

function validateTopicSyncCardPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CardValidationError("card.domain_invalid", "话题同步卡片数据无效");
  }
  const topicId = normalizeTopicReference(payload.topicId);
  const topicMessageId = normalizeTopicReference(payload.topicMessageId);
  const projectionId = normalizeTopicReference(payload.projectionId);
  const projectionType = normalizeTopicProjectionType(payload.projectionType);
  const title = normalizeTopicCardTitle(payload.title);
  const messagePreview = summarize(payload.messagePreview);
  const status = normalizeTopicCardStatus(payload.status);
  if (!topicId || !topicMessageId || !projectionId || !projectionType || !title || !status) {
    throw new CardValidationError("card.domain_invalid", "话题同步卡片数据无效");
  }
  return {
    topicId,
    topicMessageId,
    projectionId,
    projectionType,
    title,
    messagePreview,
    status
  };
}

function normalizeTopicCreatedCardPayload(payload) {
  const topicId = normalizeTopicReference(payload?.topicId);
  const title = normalizeTopicCardTitle(payload?.title);
  const descriptionPreview = summarize(payload?.descriptionPreview);
  const participantCount = Number(payload?.participantCount);
  const status = normalizeTopicCardStatus(payload?.status);
  if (!topicId || !title || !status || !Number.isSafeInteger(participantCount) || participantCount < 0) {
    throw new CardValidationError("card.domain_invalid", "话题卡片数据无效");
  }
  return {
    topicId,
    title,
    descriptionPreview,
    participantCount,
    status,
    allowSyncToGroup: payload?.allowSyncToGroup === true
  };
}

function normalizeTopicReference(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return TOPIC_REFERENCE_PATTERN.test(normalized) ? normalized : "";
}

function normalizeTopicCardTitle(value) {
  const normalized = stripControls(typeof value === "string" ? value : "").trim();
  const length = Array.from(normalized).length;
  return length > 0 && length <= 128 && !/[\[\]\r\n]/u.test(normalized) ? normalized : "";
}

function normalizeTopicProjectionType(value) {
  return value === "group_sync" ? value : "";
}

function normalizeTopicCardStatus(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return TOPIC_CARD_STATUSES.has(normalized) ? normalized : "";
}

async function loadTopicCardTopic(db, topicId) {
  const normalized = normalizeTopicReference(topicId);
  if (!normalized) return null;
  return await db.prepare(`
    SELECT t.id, t.space_id AS spaceId, t.conversation_id AS conversationId,
      t.title, t.description, t.status,
      t.allow_sync_to_group AS allowSyncToGroup,
      (SELECT COUNT(*) FROM topic_members tm WHERE tm.topic_id = t.id AND tm.left_at IS NULL) AS participantCount
    FROM topics t WHERE t.id = ?
  `).get(normalized);
}

async function countTopicParticipants(db, topicId) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM topic_members WHERE topic_id = ? AND left_at IS NULL").get(topicId);
  return Number(row?.count) || 0;
}

async function upsertTopicCard(db, { topic, block, payload, sourceId, actorId, cardStatus }) {
  const existing = await db.prepare(`
    SELECT id, space_id AS spaceId, conversation_id AS conversationId,
      card_type AS cardType, schema_version AS schemaVersion, payload_json AS payloadJson,
      fallback_text AS fallbackText, source_kind AS sourceKind, source_id AS sourceId,
      resource_type AS resourceType, resource_id AS resourceId, visibility_scope AS visibilityScope,
      created_by_user_id AS createdByUserId, status, revision,
      expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
    FROM workspace_cards
    WHERE space_id = ? AND source_kind = 'topic' AND source_id = ? AND card_type = ?
  `).get(topic.spaceId, sourceId, block.cardType);
  if (existing) {
    const currentPayload = parseJsonObject(existing.payloadJson);
    if (existing.status === cardStatus && JSON.stringify(currentPayload) === JSON.stringify(payload)) {
      return existing;
    }
    return await updateTopicCardRow(db, existing, payload, cardStatus, actorId);
  }

  const now = new Date().toISOString();
  const inserted = await db.prepare(`
    INSERT INTO workspace_cards (
      id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text,
      source_kind, source_id, resource_type, resource_id, visibility_scope,
      created_by_user_id, status, revision, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'topic', ?, 'topic', ?, 'conversation', ?, ?, 1, NULL, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(
    block.cardId,
    topic.spaceId,
    topic.conversationId,
    block.cardType,
    block.schemaVersion,
    JSON.stringify(payload),
    block.fallbackText,
    sourceId,
    topic.id,
    actorId ?? null,
    cardStatus,
    now,
    now
  );
  if (inserted.changes === 0) {
    const winner = await db.prepare(`
      SELECT id, space_id AS spaceId, conversation_id AS conversationId,
        card_type AS cardType, schema_version AS schemaVersion, payload_json AS payloadJson,
        fallback_text AS fallbackText, source_kind AS sourceKind, source_id AS sourceId,
        resource_type AS resourceType, resource_id AS resourceId, visibility_scope AS visibilityScope,
        created_by_user_id AS createdByUserId, status, revision,
        expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
      FROM workspace_cards WHERE id = ?
    `).get(block.cardId);
    if (winner) return winner;
  }
  await writeTopicCardEvent(db, {
    type: "card.created",
    spaceId: topic.spaceId,
    conversationId: topic.conversationId,
    actorId,
    cardId: block.cardId,
    cardType: block.cardType,
    revision: 1,
    status: cardStatus
  });
  return {
    id: block.cardId,
    spaceId: topic.spaceId,
    conversationId: topic.conversationId,
    cardType: block.cardType,
    schemaVersion: block.schemaVersion,
    payloadJson: JSON.stringify(payload),
    fallbackText: block.fallbackText,
    sourceKind: "topic",
    sourceId,
    resourceType: "topic",
    resourceId: topic.id,
    visibilityScope: "conversation",
    createdByUserId: actorId ?? null,
    status: cardStatus,
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
}

async function updateTopicCardRow(db, row, payload, cardStatus, actorId) {
  const updatedAt = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE workspace_cards
    SET payload_json = ?, status = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ?
  `).run(JSON.stringify(payload), cardStatus, updatedAt, row.id, row.revision);
  if (result.changes !== 1) {
    return await db.prepare(`
      SELECT id, space_id AS spaceId, conversation_id AS conversationId,
        card_type AS cardType, schema_version AS schemaVersion, payload_json AS payloadJson,
        fallback_text AS fallbackText, source_kind AS sourceKind, source_id AS sourceId,
        resource_type AS resourceType, resource_id AS resourceId, visibility_scope AS visibilityScope,
        created_by_user_id AS createdByUserId, status, revision,
        expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
      FROM workspace_cards WHERE id = ?
    `).get(row.id);
  }
  const current = await db.prepare(`
    SELECT id, space_id AS spaceId, conversation_id AS conversationId,
      card_type AS cardType, schema_version AS schemaVersion, payload_json AS payloadJson,
      fallback_text AS fallbackText, source_kind AS sourceKind, source_id AS sourceId,
      resource_type AS resourceType, resource_id AS resourceId, visibility_scope AS visibilityScope,
      created_by_user_id AS createdByUserId, status, revision,
      expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
    FROM workspace_cards WHERE id = ?
  `).get(row.id);
  await writeTopicCardEvent(db, {
    type: "card.updated",
    spaceId: current.spaceId,
    conversationId: current.conversationId,
    actorId,
    cardId: current.id,
    cardType: current.cardType,
    revision: Number(current.revision),
    status: current.status
  });
  return current;
}

async function writeTopicCardEvent(db, { type, spaceId, conversationId, actorId, cardId, cardType, revision, status }) {
  return await writeWorkspaceEvent(db, {
    type,
    spaceId,
    actorId: actorId ?? null,
    conversationId: conversationId ?? null,
    targetType: "workspace.card",
    targetId: cardId,
    payload: { cardId, cardType, revision, status }
  });
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeTopicEvent(db, event) {
  return await writeWorkspaceEvent(db, {
    ...event,
    spaceId: event.spaceId ?? DEFAULT_SPACE_ID
  });
}

export async function writeTopicDomainEvent(db, event) {
  return await writeTopicEvent(db, event);
}

function auditEvent(request, actor, action, targetId, result, reason = null) {
  return {
    spaceId: actor?.spaceId ?? DEFAULT_SPACE_ID,
    actorUserId: actor?.id ?? null,
    actorGithubLogin: actor?.githubLogin ?? null,
    action,
    targetType: "topic",
    targetId,
    result,
    reason,
    ipAddress: request?.ip,
    userAgent: request?.headers?.["user-agent"],
    requestId: request?.id
  };
}

function consumeRateLimit(actorId, action) {
  const config = RATE_LIMITS[action] ?? RATE_LIMITS.create;
  const now = Date.now();
  const key = `${action}:${actorId}`;
  const timestamps = (rateBuckets.get(key) ?? []).filter((value) => value > now - config.windowMs);
  if (timestamps.length >= config.limit) throw new TopicMessageError("topic.rate_limited", "操作过于频繁，请稍后再试", 429);
  timestamps.push(now);
  rateBuckets.set(key, timestamps);
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, values] of rateBuckets) {
      if (values.every((value) => value <= now - config.windowMs)) rateBuckets.delete(bucketKey);
    }
  }
}

function parseBoundedLimit(value, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TopicMessageError("topic.invalid_limit", "列表长度无效");
  return Math.min(number, maximum);
}

function normalizeClientMessageId(value) {
  const normalized = normalizeId(value);
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new TopicMessageError("topic.invalid_client_message_id", "消息幂等 ID 无效");
  }
  return normalized;
}

function normalizeId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized) ? normalized : "";
}

function normalizeLabel(value) {
  return typeof value === "string" ? stripControls(value).trim().slice(0, 256) : "";
}

function stripControls(value) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function summarize(value) {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return Array.from(text).slice(0, 160).join("") + (Array.from(text).length > 160 ? "…" : "");
}

export class TopicMessageError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "TopicError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
