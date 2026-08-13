import { randomUUID } from "node:crypto";
import { writeAudit } from "./audit.mjs";
import {
  parseWorkspaceTopicSyntax,
  WORKSPACE_TOPIC_BODY_MAX_BYTES,
  WORKSPACE_TOPIC_BODY_MAX_CODE_POINTS,
  WORKSPACE_TOPIC_TITLE_MAX_CODE_POINTS
} from "./workspace-topic-parser.mjs";
import { CardValidationError, normalizeCardPayload } from "./workspace-cards.mjs";

export const TOPIC_STATUSES = Object.freeze(["open", "closed", "archived"]);
export const TOPIC_NOTIFICATION_LEVELS = Object.freeze(["all", "mentions", "muted"]);
export const TOPIC_CARD_TYPE = "workspace.topic-created";
export const TOPIC_CARD_SCHEMA_VERSION = 1;

export const TOPIC_CARD_DEFINITION = Object.freeze({
  cardType: TOPIC_CARD_TYPE,
  schemaVersion: TOPIC_CARD_SCHEMA_VERSION,
  validatePayload: validateTopicCardPayload,
  limits: Object.freeze({ maxPayloadBytes: 16 * 1024, maxTextBytes: 8 * 1024 }),
  allowPublicUrls: false
});

/** Build the generic card reference plus server-owned safe projection. */
export function projectTopicCreatedCard(topic) {
  const title = normalizeTopicTitle(topic?.title);
  const description = summarizeDescription(topic?.description ?? topic?.descriptionPreview ?? "");
  const topicId = normalizeTopicId(topic?.id);
  if (!topicId) throw new TopicValidationError("topic.invalid_id", "话题 ID 无效");
  const fallbackText = `#${title}`;
  const payload = normalizeCardPayload({
    topicId,
    title,
    descriptionPreview: description,
    participantCount: Number(topic?.participantCount ?? 0),
    status: normalizeStatus(topic?.status) ?? "open",
    allowSyncToGroup: topic?.allowSyncToGroup === true
  }, { limits: TOPIC_CARD_DEFINITION.limits });
  return {
    block: {
      type: "card",
      cardId: `topic_${topicId}`,
      cardType: TOPIC_CARD_TYPE,
      schemaVersion: TOPIC_CARD_SCHEMA_VERSION,
      fallbackText
    },
    payload: validateTopicCardPayload(payload)
  };
}

function validateTopicCardPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CardValidationError("card.domain_invalid", "话题卡片数据无效");
  }
  const topicId = normalizeTopicId(payload.topicId);
  const title = normalizeTopicTitle(payload.title);
  const descriptionPreview = summarizeDescription(payload.descriptionPreview);
  const participantCount = Number(payload.participantCount);
  const status = normalizeStatus(payload.status);
  if (!topicId || !status || !Number.isSafeInteger(participantCount) || participantCount < 0 || participantCount > 1_000_000) {
    throw new CardValidationError("card.domain_invalid", "话题卡片数据无效");
  }
  return {
    topicId,
    title,
    descriptionPreview,
    participantCount,
    status,
    allowSyncToGroup: payload.allowSyncToGroup === true
  };
}

/**
 * The topic service intentionally owns only the topic/member domain. Routes,
 * message persistence, unread counters and realtime fanout are integration
 * responsibilities of the Workspace application service.
 */
export async function createTopic(db, request, input = {}) {
  const actor = await requireTopicActor(db, input.actorId, undefined, { requireConversation: false });
  if (actor.role === "auditor") {
    await auditTopic(db, request, actor, "topic.create", "new", "rejected", "permission.denied");
    throw new TopicPermissionError("permission.denied", "审计角色不能创建话题");
  }
  let conversation;
  try {
    conversation = await getGroupConversation(db, input.conversationId);
  } catch (error) {
    await auditTopic(db, request, actor, "topic.create", "new", "rejected", error.code ?? "topic.group_only");
    throw error;
  }
  if (!await isActiveGroupMember(db, conversation.id, actor.id)) {
    await auditTopic(db, request, actor, "topic.create", "new", "rejected", "topic.not_found");
    throw topicNotFound();
  }
  let intent;
  try {
    intent = parseTopicIntent(input);
  } catch (error) {
    await auditTopic(db, request, actor, "topic.create", "new", "rejected", error.code ?? "topic.invalid");
    throw error;
  }
  let idempotencyKey;
  try {
    idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  } catch (error) {
    await auditTopic(db, request, actor, "topic.create", "new", "rejected", error.code ?? "topic.invalid_idempotency_key");
    throw error;
  }
  if (input.allowSyncToGroup !== undefined && typeof input.allowSyncToGroup !== "boolean") {
    await auditTopic(db, request, actor, "topic.create", "new", "rejected", "topic.invalid_sync_policy");
    throw new TopicValidationError("topic.invalid_sync_policy", "同步策略无效");
  }

  if (idempotencyKey) {
    const existing = await db.prepare(`
      SELECT * FROM topics
      WHERE space_id = ? AND created_by = ? AND idempotency_key = ?
    `).get(conversation.spaceId, actor.id, idempotencyKey);
    if (existing) {
      if (
        existing.conversation_id !== conversation.id ||
        existing.title !== intent.title ||
        existing.description !== intent.description ||
        Boolean(existing.allow_sync_to_group) !== Boolean(input.allowSyncToGroup)
      ) {
        await auditTopic(db, request, actor, "topic.create", existing.id, "rejected", "topic.idempotency_conflict");
        throw new TopicValidationError("topic.idempotency_conflict", "重复请求对应的话题内容不一致");
      }
      return await projectTopicForActor(db, actor.id, existing.id, { allowSummary: true });
    }
  }

  const now = new Date().toISOString();
  // Topic identifiers are server-owned. Client-provided IDs are intentionally ignored.
  const id = `top_${randomUUID()}`;
  const allowSyncToGroup = input.allowSyncToGroup === true;
  try {
    await db.transaction(async () => {
      if (typeof db.lock === "function") {
        await db.lock(`workspace:topic:create:${actor.id}`);
      }
      await db.prepare(`
        INSERT INTO topics (
          id, space_id, conversation_id, title, description, created_by,
          status, allow_sync_to_group, revision, idempotency_key,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, ?)
      `).run(
        id,
        conversation.spaceId,
        conversation.id,
        intent.title,
        intent.description,
        actor.id,
        allowSyncToGroup ? 1 : 0,
        idempotencyKey,
        now,
        now
      );
      await db.prepare(`
        INSERT INTO topic_members (topic_id, user_id, joined_at, left_at, notification_level)
        VALUES (?, ?, ?, NULL, 'all')
      `).run(id, actor.id, now);
    });
  } catch (error) {
    if (isUniqueViolation(error) && idempotencyKey) {
      const existing = await db.prepare(`
        SELECT id, conversation_id AS conversationId, title, description,
          allow_sync_to_group AS allowSyncToGroup
        FROM topics WHERE space_id = ? AND created_by = ? AND idempotency_key = ?
      `).get(conversation.spaceId, actor.id, idempotencyKey);
      if (
        existing &&
        existing.conversationId === conversation.id &&
        existing.title === intent.title &&
        existing.description === intent.description &&
        Boolean(existing.allowSyncToGroup) === allowSyncToGroup
      ) {
        return await projectTopicForActor(db, actor.id, existing.id, { allowSummary: true });
      }
      throw new TopicValidationError("topic.idempotency_conflict", "重复请求对应的话题内容不一致");
    }
    throw error;
  }

  await auditTopic(db, request, actor, "topic.create", id, "success");
  return await projectTopicForActor(db, actor.id, id, { allowSummary: true });
}

export async function listTopics(db, input = {}) {
  const actor = await requireTopicActor(db, input.actorId, input.conversationId, { requireConversation: false });
  const conversationId = normalizeString(input.conversationId);
  const statusInput = normalizeString(input.status);
  const status = normalizeStatus(statusInput);
  if (statusInput && !status) throw new TopicValidationError("topic.invalid_status", "话题状态筛选无效");
  if (conversationId && !isValidReferenceId(conversationId)) throw new TopicValidationError("topic.invalid_conversation", "群聊 ID 无效");
  const params = [actor.id, actor.spaceId, actor.id];
  const where = ["t.space_id = ?", "EXISTS (SELECT 1 FROM conversation_members actor_cm WHERE actor_cm.conversation_id = t.conversation_id AND actor_cm.user_id = ? AND actor_cm.removed_at IS NULL)"];
  if (conversationId) {
    where.push("t.conversation_id = ?");
    params.push(conversationId);
  }
  if (status) {
    where.push("t.status = ?");
    params.push(status);
  }
  const rows = await db.prepare(`
    SELECT
      t.id, t.space_id AS spaceId, t.conversation_id AS conversationId,
      t.title, t.description, t.created_by AS createdBy,
      t.status, t.allow_sync_to_group AS allowSyncToGroup, t.revision,
      t.created_at AS createdAt, t.updated_at AS updatedAt,
      t.closed_at AS closedAt, t.archived_at AS archivedAt,
      u.display_name AS creatorDisplayName, u.nickname AS creatorNickname,
      u.github_login AS creatorGithubLogin,
      (SELECT COUNT(*) FROM topic_members tm WHERE tm.topic_id = t.id AND tm.left_at IS NULL) AS participantCount,
      EXISTS (SELECT 1 FROM topic_members tm WHERE tm.topic_id = t.id AND tm.user_id = ? AND tm.left_at IS NULL) AS joined
    FROM topics t
    INNER JOIN users u ON u.id = t.created_by
    WHERE ${where.join(" AND ")}
    ORDER BY CASE t.status WHEN 'open' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END, t.updated_at DESC, t.id DESC
  `).all(...params);
  return rows.map((row) => projectTopicRow(row, { full: Boolean(row.joined), viewerId: actor.id }));
}

export async function getTopic(db, input = {}) {
  return await getTopicDetails(db, input);
}

export async function getTopicSummary(db, input = {}) {
  const actor = await requireTopicActor(db, input.actorId, undefined, { requireConversation: false });
  return await projectTopicForActor(db, actor.id, input.topicId, { allowSummary: true });
}

export async function getTopicDetails(db, input = {}) {
  const actor = await requireTopicActor(db, input.actorId, undefined, { requireConversation: false });
  const topic = await getRawTopic(db, input.topicId);
  if (!topic || !await isActiveGroupMember(db, topic.conversation_id, actor.id) || !await isActiveTopicMember(db, topic.id, actor.id)) {
    throw topicNotFound();
  }
  return await projectTopicForActor(db, actor.id, topic.id);
}

export function parseWorkspaceTopicIntent(input) {
  return parseTopicIntent(input);
}

export async function joinTopic(db, request, input = {}) {
  const actor = await requireTopicActor(db, input.actorId, undefined, { requireConversation: false });
  let topic;
  try {
    topic = await getRawTopic(db, input.topicId);
  } catch (error) {
    await auditTopic(db, request, actor, "topic.join", auditTargetId(input.topicId), "rejected", error.code ?? "topic.invalid_id");
    throw error;
  }
  if (!topic) {
    await auditTopic(db, request, actor, "topic.join", normalizeString(input.topicId) || "unknown", "rejected", "topic.not_found");
    throw topicNotFound();
  }
  if (!await isActiveGroupMember(db, topic.conversation_id, actor.id)) {
    await auditTopic(db, request, actor, "topic.join", topic.id, "rejected", "topic.not_found");
    throw topicNotFound();
  }
  if (actor.role === "auditor") {
    await auditTopic(db, request, actor, "topic.join", topic.id, "rejected", "permission.denied");
    throw new TopicPermissionError("permission.denied", "审计角色不能加入话题");
  }
  const existing = await db.prepare("SELECT * FROM topic_members WHERE topic_id = ? AND user_id = ?").get(topic.id, actor.id);
  // An already active participant may continue to open a closed topic. This
  // makes retries idempotent and avoids turning a successful join into an
  // error merely because the topic was closed concurrently.
  if (existing && !existing.left_at) {
    await auditTopic(db, request, actor, "topic.join", topic.id, "success");
    return await projectTopicForActor(db, actor.id, topic.id);
  }
  const now = new Date().toISOString();
  let changed = 0;
  await db.transaction(async () => {
    if (existing?.left_at) {
      changed = (await db.prepare(`
        UPDATE topic_members SET joined_at = ?, left_at = NULL
        WHERE topic_id = ? AND user_id = ? AND left_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM topics WHERE id = ? AND status = 'open')
      `).run(now, topic.id, actor.id, topic.id)).changes;
    } else {
      changed = (await db.prepare(`
        INSERT INTO topic_members (topic_id, user_id, joined_at, left_at, notification_level)
        SELECT ?, ?, ?, NULL, 'all'
        WHERE EXISTS (SELECT 1 FROM topics WHERE id = ? AND status = 'open')
        ON CONFLICT (topic_id, user_id) DO NOTHING
      `).run(topic.id, actor.id, now, topic.id)).changes;
    }
  });
  if (changed === 0) {
    const current = await getRawTopic(db, topic.id);
    const activeAfterRace = await isActiveTopicMember(db, topic.id, actor.id);
    if (!activeAfterRace && current?.status !== "open") {
      await auditTopic(db, request, actor, "topic.join", topic.id, "rejected", "topic.not_open");
      throw new TopicValidationError("topic.not_open", "话题已关闭");
    }
  }
  await auditTopic(db, request, actor, "topic.join", topic.id, "success");
  return await projectTopicForActor(db, actor.id, topic.id);
}

export async function leaveTopic(db, request, input = {}) {
  const actor = await requireTopicActor(db, input.actorId, undefined, { requireConversation: false });
  let topic;
  try {
    topic = await getRawTopic(db, input.topicId);
  } catch (error) {
    await auditTopic(db, request, actor, "topic.leave", auditTargetId(input.topicId), "rejected", error.code ?? "topic.invalid_id");
    throw error;
  }
  if (!topic) {
    await auditTopic(db, request, actor, "topic.leave", normalizeString(input.topicId) || "unknown", "rejected", "topic.not_found");
    throw topicNotFound();
  }
  if (!await isActiveGroupMember(db, topic.conversation_id, actor.id)) {
    await auditTopic(db, request, actor, "topic.leave", topic.id, "rejected", "topic.not_found");
    throw topicNotFound();
  }
  if (actor.role === "auditor") {
    await auditTopic(db, request, actor, "topic.leave", topic.id, "rejected", "permission.denied");
    throw new TopicPermissionError("permission.denied", "审计角色不能退出话题");
  }
  if (topic.created_by === actor.id && topic.status === "open") {
    await auditTopic(db, request, actor, "topic.leave", topic.id, "rejected", "topic.creator_required");
    throw new TopicValidationError("topic.creator_required", "创建者需先关闭话题才能退出");
  }
  const existing = await db.prepare("SELECT left_at FROM topic_members WHERE topic_id = ? AND user_id = ?").get(topic.id, actor.id);
  if (existing && !existing.left_at) {
    await db.prepare("UPDATE topic_members SET left_at = ? WHERE topic_id = ? AND user_id = ?").run(new Date().toISOString(), topic.id, actor.id);
  }
  await auditTopic(db, request, actor, "topic.leave", topic.id, "success");
  return await projectTopicForActor(db, actor.id, topic.id, { allowSummary: true });
}

export async function closeTopic(db, request, input = {}) {
  return await transitionTopic(db, request, input, "closed");
}

export async function archiveTopic(db, request, input = {}) {
  return await transitionTopic(db, request, input, "archived");
}

export async function listTopicMembers(db, input = {}) {
  const topic = await getRawTopic(db, input.topicId);
  const actor = await requireTopicActor(db, input.actorId, undefined, { requireConversation: false });
  if (!topic) throw topicNotFound();
  if (!await isActiveGroupMember(db, topic.conversation_id, actor.id)) throw topicNotFound();
  const active = await isActiveTopicMember(db, topic.id, actor.id);
  if (!active) throw topicNotFound();
  return await db.prepare(`
    SELECT tm.user_id AS userId, tm.joined_at AS joinedAt,
      tm.notification_level AS notificationLevel,
      u.display_name AS displayName, u.nickname, u.github_login AS githubLogin,
      u.avatar_url AS avatarUrl
    FROM topic_members tm INNER JOIN users u ON u.id = tm.user_id
    WHERE tm.topic_id = ? AND tm.left_at IS NULL
    ORDER BY tm.joined_at ASC, tm.user_id ASC
  `).all(topic.id);
}

export async function updateTopicNotificationLevel(db, request, input = {}) {
  const topic = await getRawTopic(db, input.topicId);
  const actor = await requireTopicActor(db, input.actorId, undefined, { requireConversation: false });
  if (!topic) throw topicNotFound();
  if (!await isActiveGroupMember(db, topic.conversation_id, actor.id)) throw topicNotFound();
  if (!TOPIC_NOTIFICATION_LEVELS.includes(normalizeString(input.notificationLevel))) {
    await auditTopic(db, request, actor, "topic.notification.update", topic.id, "rejected", "topic.notification_invalid");
    throw new TopicValidationError("topic.notification_invalid", "话题提醒方式无效");
  }
  if (!await isActiveTopicMember(db, topic.id, actor.id)) {
    await auditTopic(db, request, actor, "topic.notification.update", topic.id, "rejected", "topic.not_member");
    throw topicNotFound();
  }
  await db.prepare("UPDATE topic_members SET notification_level = ? WHERE topic_id = ? AND user_id = ? AND left_at IS NULL")
    .run(normalizeString(input.notificationLevel), topic.id, actor.id);
  await auditTopic(db, request, actor, "topic.notification.update", topic.id, "success");
  return await projectTopicForActor(db, actor.id, topic.id);
}

export async function projectTopicEvent(db, input = {}) {
  const event = input.event;
  if (!event || typeof event !== "object") return null;
  const topicId = normalizeString(event.topicId ?? event.targetId);
  if (!topicId) return null;
  const actor = await requireTopicActor(db, input.actorId, undefined, { requireConversation: false });
  const topic = await getRawTopic(db, topicId);
  if (!topic) return null;
  const groupMember = await isActiveGroupMember(db, topic.conversation_id, actor.id);
  if (!groupMember) return null;
  const joined = await isActiveTopicMember(db, topic.id, actor.id);
  const projected = projectTopicRow(await loadTopicRow(db, topic.id, actor.id), { full: joined, viewerId: actor.id });
  return {
    type: normalizeTopicEventType(event.type),
    schemaVersion: 1,
    topicId: topic.id,
    payload: projected
  };
}

/**
 * Return an event envelope from persisted state only. Callers provide an
 * event type and topic ID; status, revision, title and description are always
 * loaded and permission-filtered here.
 */
export async function buildTopicEvent(db, input = {}) {
  const topicId = normalizeString(input.topicId);
  if (!topicId) throw new TopicValidationError("topic.invalid_id", "话题 ID 无效");
  const projected = await projectTopicEvent(db, {
    actorId: input.actorId,
    event: { type: input.type, topicId }
  });
  return projected ? { ...projected, actorId: normalizeString(input.actorId) || null } : null;
}

async function transitionTopic(db, request, input, targetStatus) {
  const actor = await requireTopicActor(db, input.actorId, undefined, { requireConversation: false });
  let topic;
  try {
    topic = await getRawTopic(db, input.topicId);
  } catch (error) {
    await auditTopic(db, request, actor, `topic.${targetStatus}`, auditTargetId(input.topicId), "rejected", error.code ?? "topic.invalid_id");
    throw error;
  }
  if (!topic) {
    await auditTopic(db, request, actor, `topic.${targetStatus}`, normalizeString(input.topicId) || "unknown", "rejected", "topic.not_found");
    throw topicNotFound();
  }
  if (!await isActiveGroupMember(db, topic.conversation_id, actor.id)) {
    await auditTopic(db, request, actor, `topic.${targetStatus}`, topic.id, "rejected", "topic.not_found");
    throw topicNotFound();
  }
  if (actor.role === "auditor") {
    await auditTopic(db, request, actor, `topic.${targetStatus}`, topic.id, "rejected", "permission.denied");
    throw new TopicPermissionError("permission.denied", "审计角色不能管理话题");
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== topic.revision) {
    await auditTopic(db, request, actor, `topic.${targetStatus}`, topic.id, "rejected", "topic.revision_conflict");
    throw new TopicConflictError("topic.revision_conflict", "话题版本已变化，请刷新后重试");
  }
  const canManage = actor.role === "owner" || actor.role === "admin" || (targetStatus === "closed" && topic.created_by === actor.id);
  if (!canManage) {
    await auditTopic(db, request, actor, `topic.${targetStatus}`, topic.id, "rejected", "permission.denied");
    throw new TopicPermissionError("permission.denied", "没有管理该话题的权限");
  }
  const allowed = (topic.status === "open" && ["closed", "archived"].includes(targetStatus)) ||
    (topic.status === "closed" && targetStatus === "archived");
  if (!allowed) {
    await auditTopic(db, request, actor, `topic.${targetStatus}`, topic.id, "rejected", "topic.invalid_transition");
    throw new TopicConflictError("topic.invalid_transition", "话题状态不能转换");
  }
  const now = new Date().toISOString();
  const updateResult = await db.prepare(`
    UPDATE topics SET status = ?, revision = revision + 1, updated_at = ?,
      closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?) ELSE closed_at END,
      archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, ?) ELSE archived_at END
    WHERE id = ? AND revision = ?
  `).run(targetStatus, now, targetStatus, now, targetStatus, now, topic.id, expectedRevision);
  if (updateResult.changes !== 1) {
    await auditTopic(db, request, actor, `topic.${targetStatus}`, topic.id, "rejected", "topic.revision_conflict");
    throw new TopicConflictError("topic.revision_conflict", "话题版本已变化，请刷新后重试");
  }
  const updated = await getRawTopic(db, topic.id);
  await auditTopic(db, request, actor, `topic.${targetStatus}`, topic.id, "success");
  return await projectTopicForActor(db, actor.id, updated.id, { allowSummary: true });
}

function parseTopicIntent(input) {
  const parsed = typeof input.source === "string" ? parseWorkspaceTopicSyntax(input.source) : null;
  const candidate = parsed ?? (input.intent && typeof input.intent === "object" ? input.intent : {
    title: input.title,
    description: input.description
  });
  const title = normalizeTopicTitle(candidate?.title);
  const description = normalizeTopicDescription(candidate?.description);
  return { title, description };
}

async function requireTopicActor(db, userId, conversationId, options = {}) {
  const normalizedUserId = normalizeString(userId);
  const user = await db.prepare("SELECT id, kind FROM users WHERE id = ?").get(normalizedUserId);
  if (!user || user.kind !== "human") throw new TopicAuthError("auth.required", "请先登录共享空间");
  const actor = await db.prepare(`
    SELECT u.id, u.kind, u.display_name AS displayName, u.nickname, u.github_login AS githubLogin,
      sm.space_id AS spaceId, sm.role
    FROM users u INNER JOIN space_members sm ON sm.user_id = u.id
    WHERE u.id = ? AND u.kind = 'human' AND sm.removed_at IS NULL
    ORDER BY sm.joined_at DESC LIMIT 1
  `).get(normalizedUserId);
  if (!actor) throw topicNotFound();
  if (conversationId && options.requireConversation !== false && !await isActiveGroupMember(db, conversationId, actor.id)) {
    throw topicNotFound();
  }
  return actor;
}

async function getGroupConversation(db, conversationId) {
  const row = await db.prepare("SELECT id, space_id AS spaceId, type FROM conversations WHERE id = ?").get(normalizeString(conversationId));
  if (!row || row.type !== "group") throw new TopicNotFoundError("topic.group_only", "话题只能绑定群聊");
  return row;
}

async function getRawTopic(db, topicId) {
  const normalized = normalizeString(topicId);
  if (!isValidReferenceId(normalized)) throw new TopicValidationError("topic.invalid_id", "话题 ID 无效");
  return await db.prepare("SELECT * FROM topics WHERE id = ?").get(normalized);
}

async function projectTopicForActor(db, actorId, topicId, { allowSummary = false } = {}) {
  const topic = await getRawTopic(db, topicId);
  if (!topic) throw topicNotFound();
  const actor = await requireTopicActor(db, actorId, topic.conversation_id, { requireConversation: false });
  if (!await isActiveGroupMember(db, topic.conversation_id, actor.id)) throw topicNotFound();
  const row = await loadTopicRow(db, topic.id, actor.id);
  const joined = await isActiveTopicMember(db, topic.id, actor.id);
  if (!joined && !allowSummary) throw topicNotFound();
  return projectTopicRow(row, { full: joined, viewerId: actor.id });
}

async function loadTopicRow(db, topicId, viewerId) {
  return await db.prepare(`
    SELECT t.id, t.space_id AS spaceId, t.conversation_id AS conversationId,
      t.title, t.description, t.created_by AS createdBy, t.status,
      t.allow_sync_to_group AS allowSyncToGroup, t.revision,
      t.created_at AS createdAt, t.updated_at AS updatedAt,
      t.closed_at AS closedAt, t.archived_at AS archivedAt,
      u.display_name AS creatorDisplayName, u.nickname AS creatorNickname,
      u.github_login AS creatorGithubLogin,
      (SELECT COUNT(*) FROM topic_members tm WHERE tm.topic_id = t.id AND tm.left_at IS NULL) AS participantCount,
      EXISTS (SELECT 1 FROM topic_members tm WHERE tm.topic_id = t.id AND tm.user_id = ? AND tm.left_at IS NULL) AS joined
    FROM topics t INNER JOIN users u ON u.id = t.created_by
    WHERE t.id = ?
  `).get(viewerId, topicId);
}

function projectTopicRow(row, { full, viewerId }) {
  if (!row) return null;
  const creatorName = row.creatorNickname || row.creatorDisplayName || row.creatorGithubLogin;
  return {
    id: row.id,
    spaceId: row.spaceId ?? row.space_id,
    conversationId: row.conversationId ?? row.conversation_id,
    title: row.title,
    description: full ? row.description : undefined,
    descriptionPreview: full ? undefined : summarizeDescription(row.description),
    createdBy: row.createdBy ?? row.created_by,
    creator: {
      id: row.createdBy ?? row.created_by,
      displayName: creatorName,
      githubLogin: row.creatorGithubLogin
    },
    status: row.status,
    allowSyncToGroup: Boolean(row.allowSyncToGroup ?? row.allow_sync_to_group),
    revision: Number(row.revision),
    participantCount: Number(row.participantCount ?? row.participant_count ?? 0),
    joined: Boolean(row.joined),
    canJoin: row.status === "open" && !Boolean(row.joined),
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    closedAt: row.closedAt ?? row.closed_at ?? null,
    archivedAt: row.archivedAt ?? row.archived_at ?? null,
    viewerId
  };
}

async function isActiveGroupMember(db, conversationId, userId) {
  if (!conversationId || !userId) return false;
  return Boolean(await db.prepare(`
    SELECT 1 FROM conversations c
    INNER JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.removed_at IS NULL
    INNER JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = cm.user_id AND sm.removed_at IS NULL
    WHERE c.id = ? AND c.type = 'group'
  `).get(userId, conversationId));
}

async function isActiveTopicMember(db, topicId, userId) {
  return Boolean(await db.prepare("SELECT 1 FROM topic_members WHERE topic_id = ? AND user_id = ? AND left_at IS NULL").get(topicId, userId));
}

async function auditTopic(db, request, actor, action, targetId, result, reason = null) {
  return await writeAudit(db, {
    spaceId: actor?.spaceId ?? null,
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
  });
}

function normalizeTopicTitle(value) {
  const normalized = normalizeString(value);
  const length = Array.from(normalized).length;
  if (!length || length > WORKSPACE_TOPIC_TITLE_MAX_CODE_POINTS || /[\[\]\r\n]/u.test(normalized)) {
    throw new TopicValidationError("topic.invalid_title", "话题标题无效");
  }
  return normalized;
}

function normalizeTopicDescription(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || Array.from(normalized).length > WORKSPACE_TOPIC_BODY_MAX_CODE_POINTS || Buffer.byteLength(normalized, "utf8") > WORKSPACE_TOPIC_BODY_MAX_BYTES) {
    throw new TopicValidationError("topic.invalid_description", "话题正文无效");
  }
  return normalized;
}

function normalizeIdempotencyKey(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new TopicValidationError("topic.invalid_idempotency_key", "幂等键无效");
  }
  return normalized;
}

function normalizeTopicId(value) {
  const normalized = normalizeString(value);
  return normalized && isValidReferenceId(normalized) ? normalized : null;
}

function isValidReferenceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function normalizeStatus(value) {
  const normalized = normalizeString(value);
  return TOPIC_STATUSES.includes(normalized) ? normalized : null;
}

function normalizeTopicEventType(value) {
  const normalized = normalizeString(value);
  return ["topic.created", "topic.joined", "topic.left", "topic.closed", "topic.archived"].includes(normalized)
    ? normalized
    : "topic.updated";
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function summarizeDescription(value) {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return Array.from(text).slice(0, 160).join("") + (Array.from(text).length > 160 ? "…" : "");
}

function isUniqueViolation(error) {
  return error?.code === "23505" || /unique constraint|UNIQUE constraint/i.test(String(error?.message ?? ""));
}

function topicNotFound() {
  return new TopicNotFoundError("topic.not_found", "话题不存在");
}

function auditTargetId(value) {
  const normalized = normalizeString(value);
  return isValidReferenceId(normalized) ? normalized : "invalid";
}

export class TopicError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "TopicError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class TopicValidationError extends TopicError {}
export class TopicPermissionError extends TopicError {
  constructor(code, message) { super(code, message, 403); }
}
export class TopicAuthError extends TopicError {
  constructor(code, message) { super(code, message, 401); }
}
export class TopicNotFoundError extends TopicError {
  constructor(code, message) { super(code, message, 404); }
}
export class TopicConflictError extends TopicError {
  constructor(code, message) { super(code, message, 409); }
}
