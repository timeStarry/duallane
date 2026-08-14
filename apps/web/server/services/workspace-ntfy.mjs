import { randomInt } from "node:crypto";
import { DEFAULT_SPACE_ID } from "./db.mjs";

const DEFAULT_NTFY_BASE_URL = "https://ntfy.tsio.top";
const TOPIC_PREFIX = "duallane";
const TOPIC_RANDOM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOPIC_RANDOM_LENGTH = 6;
const DELIVERY_DELAY_MS = 5_000;
const WORKER_INTERVAL_MS = 5_000;
const WORKER_LEASE_MS = 2 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const REQUEST_TIMEOUT_MS = 10_000;

export class WorkspaceNtfyError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceNtfyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createWorkspaceNtfyService({
  db,
  env = process.env,
  baseUrl,
  publish,
  now = () => new Date()
}) {
  const serverUrl = normalizeServerUrl(env.WORKSPACE_NTFY_BASE_URL || DEFAULT_NTFY_BASE_URL);
  const frontendUrl = normalizeFrontendUrl(baseUrl || env.WORKSPACE_FRONTEND_URL || env.PUBLIC_BASE_URL);
  const publisher = publish || publishToNtfy;

  async function getPreferences(actorId) {
    const actor = await requireHumanActor(actorId);
    return publicPreferences(await ensurePreferences(actor));
  }

  async function updatePreferences(actorId, input) {
    const actor = await requireHumanActor(actorId);
    const current = await ensurePreferences(actor);
    const enabled = input?.enabled === undefined ? Boolean(current.enabled) : input.enabled === true;
    const updatedAt = now().toISOString();
    await db.prepare(`
      UPDATE workspace_ntfy_preferences
      SET enabled = ?, updated_at = ?
      WHERE user_id = ?
    `).run(enabled ? 1 : 0, updatedAt, actor.id);
    if (!enabled) {
      await cancelPendingJobs(actor.id, updatedAt);
    }
    return publicPreferences(await readPreferences(actor.id));
  }

  async function rotateTopic(actorId) {
    const actor = await requireHumanActor(actorId);
    await ensurePreferences(actor);
    const rotatedAt = now().toISOString();
    let updated = false;
    for (let attempt = 0; attempt < 10 && !updated; attempt += 1) {
      const topic = createTopic(actor.githubLogin);
      try {
        const result = await db.prepare(`
          UPDATE workspace_ntfy_preferences
          SET topic = ?, rotated_at = ?, updated_at = ?
          WHERE user_id = ? AND topic <> ?
        `).run(topic, rotatedAt, rotatedAt, actor.id, topic);
        updated = result.changes > 0;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
    }
    if (!updated) {
      throw new WorkspaceNtfyError("ntfy.topic_generation_failed", "暂时无法刷新 topic，请稍后重试", 503);
    }
    await cancelPendingJobs(actor.id, rotatedAt);
    return publicPreferences(await readPreferences(actor.id));
  }

  async function scheduleMessage({ authorId, spaceId, conversationId, topicId, messageId, eventSeq, content, createdAt }) {
    const mentionedUserIds = new Set(
      (content?.blocks ?? [])
        .filter((block) => block?.type === "mention")
        .map((block) => normalizeText(block.userId))
        .filter(Boolean)
    );
    const notificationSpaceId = normalizeText(spaceId) || DEFAULT_SPACE_ID;
    const recipients = topicId
      ? await db.prepare(`
      SELECT u.id, tm.notification_level AS notificationLevel
      FROM topic_members tm
      INNER JOIN users u ON u.id = tm.user_id AND u.kind = 'human'
      INNER JOIN conversation_members cm ON cm.conversation_id = ? AND cm.user_id = tm.user_id AND cm.removed_at IS NULL
      INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ? AND sm.removed_at IS NULL
      WHERE tm.topic_id = ? AND tm.left_at IS NULL AND u.id <> ?
    `).all(conversationId, notificationSpaceId, topicId, authorId)
      : await db.prepare(`
      SELECT u.id, u.github_login AS githubLogin, cm.notification_level AS notificationLevel
      FROM conversation_members cm
      INNER JOIN users u ON u.id = cm.user_id AND u.kind = 'human'
      INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ? AND sm.removed_at IS NULL
      WHERE cm.conversation_id = ? AND cm.removed_at IS NULL AND u.id <> ?
      `).all(notificationSpaceId, conversationId, authorId);
    const availableAt = new Date(Date.parse(createdAt) + DELIVERY_DELAY_MS).toISOString();
    for (const recipient of recipients) {
      const isMentioned = mentionedUserIds.has(recipient.id);
      if (recipient.notificationLevel === "muted") continue;
      if (recipient.notificationLevel === "mentions" && !isMentioned) continue;
      const preferences = await ensurePreferences(recipient);
      if (!preferences.enabled) continue;
      await db.prepare(`
        INSERT INTO workspace_ntfy_jobs (
          id, user_id, message_id, conversation_id, event_seq, status, available_at,
          next_attempt_at, lease_until, attempt_count, sent_at, cancelled_at, last_error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, 0, NULL, NULL, NULL, ?)
        ON CONFLICT (user_id, message_id) DO NOTHING
      `).run(
        crypto.randomUUID(),
        recipient.id,
        messageId,
        conversationId,
        eventSeq,
        availableAt,
        availableAt,
        createdAt
      );
    }
  }

  function startWorker({ startupDelayMs, intervalMs } = {}) {
    if (env.WORKSPACE_NTFY_WORKER_ENABLED === "false") {
      return { stop() {}, tick: async () => {} };
    }
    let stopped = false;
    let running = false;
    let interval;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await processJobs();
      } catch {
        // A failed cycle must not stop later retries or create an unhandled rejection.
      } finally {
        running = false;
      }
    };
    const delay = startupDelayMs ?? (env.NODE_ENV === "test" ? 0 : 60_000);
    const timeout = setTimeout(() => {
      void tick();
      interval = setInterval(() => void tick(), intervalMs ?? WORKER_INTERVAL_MS);
      interval.unref?.();
    }, delay);
    timeout.unref?.();
    return {
      stop() {
        stopped = true;
        clearTimeout(timeout);
        if (interval) clearInterval(interval);
      },
      tick
    };
  }

  async function processJobs() {
    const current = now();
    const candidates = await db.prepare(`
      SELECT id
      FROM workspace_ntfy_jobs
      WHERE status IN ('pending', 'sending')
        AND next_attempt_at <= ?
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_attempt_at ASC
      LIMIT 25
    `).all(current.toISOString(), current.toISOString());
    for (const candidate of candidates) {
      const leaseUntil = new Date(current.getTime() + WORKER_LEASE_MS).toISOString();
      const claimed = await db.prepare(`
        UPDATE workspace_ntfy_jobs
        SET status = 'sending', lease_until = ?
        WHERE id = ? AND status IN ('pending', 'sending') AND (lease_until IS NULL OR lease_until <= ?)
      `).run(leaseUntil, candidate.id, current.toISOString());
      if (!claimed.changes) continue;
      const job = await readJob(candidate.id);
      if (!job || !job.preferenceEnabled || !isJobUnread(job) || job.notificationLevel === "muted") {
        await cancelJob(candidate.id, current.toISOString());
        continue;
      }
      const mentioned = messageMentions(job.contentJson, job.userId);
      if (job.notificationLevel === "mentions" && !mentioned) {
        await cancelJob(candidate.id, current.toISOString());
        continue;
      }
      try {
        await publisher({
          serverUrl,
          topic: job.topic,
          title: "DualLane",
          message: buildNotificationText(job, mentioned),
          clickUrl: `${frontendUrl}/workspace/chat/${encodeURIComponent(job.conversationId)}`,
          timeoutMs: REQUEST_TIMEOUT_MS
        });
        await db.prepare(`
          UPDATE workspace_ntfy_jobs
          SET status = 'sent', sent_at = ?, lease_until = NULL, last_error_code = NULL
          WHERE id = ? AND status = 'sending'
        `).run(current.toISOString(), job.id);
      } catch (error) {
        await retryJob(job, normalizeNtfyError(error), current);
      }
    }
  }

  async function readJob(id) {
    return await db.prepare(`
      SELECT
        j.id, j.user_id AS userId, j.conversation_id AS conversationId,
        j.event_seq AS eventSeq, j.attempt_count AS attemptCount,
        p.topic, p.enabled AS preferenceEnabled,
        CASE WHEN m.topic_id IS NOT NULL THEN tm.notification_level ELSE cm.notification_level END AS notificationLevel,
        CASE WHEN m.topic_id IS NOT NULL THEN tm.last_read_seq ELSE cm.last_read_seq END AS lastReadSeq,
        CASE WHEN m.topic_id IS NOT NULL THEN topic_read_message.created_at ELSE cm.last_read_at END AS lastReadAt,
        m.created_at AS messageCreatedAt, m.content_json AS contentJson,
        c.type AS conversationType, c.title AS conversationTitle,
        COALESCE(ur.remark, author.nickname, author.github_login, author.display_name) AS senderName
      FROM workspace_ntfy_jobs j
      INNER JOIN workspace_ntfy_preferences p ON p.user_id = j.user_id
      INNER JOIN messages m ON m.id = j.message_id AND m.deleted_at IS NULL AND m.recalled_at IS NULL
      INNER JOIN users author ON author.id = m.author_id
      INNER JOIN conversations c ON c.id = j.conversation_id
      INNER JOIN conversation_members cm
        ON cm.conversation_id = j.conversation_id AND cm.user_id = j.user_id AND cm.removed_at IS NULL
      LEFT JOIN topic_members tm
        ON tm.topic_id = m.topic_id AND tm.user_id = j.user_id AND tm.left_at IS NULL
      LEFT JOIN messages topic_read_message
        ON topic_read_message.id = tm.last_read_message_id AND topic_read_message.topic_id = m.topic_id
      INNER JOIN space_members sm
        ON sm.user_id = j.user_id AND sm.space_id = ? AND sm.removed_at IS NULL
      LEFT JOIN user_remarks ur ON ur.owner_user_id = j.user_id AND ur.target_user_id = author.id
      WHERE j.id = ?
        AND (m.topic_id IS NULL OR tm.user_id IS NOT NULL)
    `).get(DEFAULT_SPACE_ID, id);
  }

  function isJobUnread(job) {
    return job.lastReadSeq !== null && job.lastReadSeq !== undefined
      ? Number(job.eventSeq) > Number(job.lastReadSeq)
      : !job.lastReadAt || Date.parse(job.messageCreatedAt) > Date.parse(job.lastReadAt);
  }

  async function retryJob(job, code, current) {
    const attempt = Number(job.attemptCount) + 1;
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (delay === undefined) {
      await db.prepare(`
        UPDATE workspace_ntfy_jobs
        SET status = 'failed', attempt_count = ?, lease_until = NULL, last_error_code = ?
        WHERE id = ?
      `).run(attempt, code, job.id);
      return;
    }
    await db.prepare(`
      UPDATE workspace_ntfy_jobs
      SET status = 'pending', attempt_count = ?, lease_until = NULL, next_attempt_at = ?, last_error_code = ?
      WHERE id = ?
    `).run(attempt, new Date(current.getTime() + delay).toISOString(), code, job.id);
  }

  async function cancelJob(id, cancelledAt) {
    await db.prepare(`
      UPDATE workspace_ntfy_jobs
      SET status = 'cancelled', cancelled_at = ?, lease_until = NULL
      WHERE id = ?
    `).run(cancelledAt, id);
  }

  async function cancelPendingJobs(userId, cancelledAt) {
    await db.prepare(`
      UPDATE workspace_ntfy_jobs
      SET status = 'cancelled', cancelled_at = ?, lease_until = NULL
      WHERE user_id = ? AND status IN ('pending', 'sending')
    `).run(cancelledAt, userId);
  }

  async function requireHumanActor(userId) {
    const actor = await db.prepare(`
      SELECT u.id, u.github_login AS githubLogin
      FROM users u
      INNER JOIN space_members sm ON sm.user_id = u.id
      WHERE u.id = ? AND u.kind = 'human' AND sm.space_id = ? AND sm.removed_at IS NULL
    `).get(normalizeText(userId), DEFAULT_SPACE_ID);
    if (!actor) throw new WorkspaceNtfyError("auth.required", "请先登录共享空间", 401);
    return actor;
  }

  async function ensurePreferences(actor) {
    const existing = await readPreferences(actor.id);
    if (existing) return existing;
    const createdAt = now().toISOString();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const topic = createTopic(actor.githubLogin);
      await db.prepare(`
        INSERT INTO workspace_ntfy_preferences (user_id, topic, enabled, created_at, rotated_at, updated_at)
        VALUES (?, ?, 1, ?, NULL, ?)
        ON CONFLICT DO NOTHING
      `).run(actor.id, topic, createdAt, createdAt);
      const created = await readPreferences(actor.id);
      if (created) return created;
    }
    throw new WorkspaceNtfyError("ntfy.topic_generation_failed", "暂时无法生成 topic，请稍后重试", 503);
  }

  async function readPreferences(userId) {
    return await db.prepare(`
      SELECT user_id AS userId, topic, enabled, created_at AS createdAt,
        rotated_at AS rotatedAt, updated_at AS updatedAt
      FROM workspace_ntfy_preferences
      WHERE user_id = ?
    `).get(userId);
  }

  function publicPreferences(row) {
    return {
      enabled: Boolean(row.enabled),
      topic: row.topic,
      serverUrl,
      subscriptionUrl: `${serverUrl}/${encodeURIComponent(row.topic)}`,
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt ?? null,
      updatedAt: row.updatedAt
    };
  }

  return {
    getPreferences,
    rotateTopic,
    scheduleMessage,
    startWorker,
    updatePreferences
  };
}

export function createTopic(githubLogin, randomIndex = (max) => randomInt(max)) {
  const login = normalizeText(githubLogin).toLowerCase().replace(/[^a-z0-9-]/gu, "-") || "user";
  let suffix = "";
  for (let index = 0; index < TOPIC_RANDOM_LENGTH; index += 1) {
    suffix += TOPIC_RANDOM_ALPHABET[randomIndex(TOPIC_RANDOM_ALPHABET.length)];
  }
  return `${TOPIC_PREFIX}-${login}-${suffix}`;
}

function buildNotificationText(job, mentioned) {
  if (job.conversationType === "group" && mentioned) {
    return `有人在「${job.conversationTitle}」群聊中 @你`;
  }
  if (job.conversationType === "group") {
    return `${job.senderName} 通过「${job.conversationTitle}」群聊给你发送了消息`;
  }
  return `${job.senderName} 通过私聊给你发送了消息`;
}

function messageMentions(contentJson, userId) {
  try {
    const content = JSON.parse(contentJson);
    return (content?.blocks ?? []).some(
      (block) => block?.type === "mention" && normalizeText(block.userId) === userId
    );
  } catch {
    return false;
  }
}

async function publishToNtfy({ serverUrl, topic, title, message, clickUrl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, title, message, click: clickUrl, tags: ["speech_balloon"] }),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`ntfy returned ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeNtfyError(error) {
  if (error?.name === "AbortError") return "ntfy.timeout";
  const statusCode = Number(error?.statusCode);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
    return `ntfy.http_${statusCode}`;
  }
  return "ntfy.unavailable";
}

function normalizeServerUrl(value) {
  try {
    const url = new URL(String(value || DEFAULT_NTFY_BASE_URL).trim());
    if (url.protocol !== "https:") throw new Error("https required");
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new Error("WORKSPACE_NTFY_BASE_URL must be a valid HTTPS URL");
  }
}

function normalizeFrontendUrl(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "https://duallane.tsio.top";
  try {
    const url = new URL(normalized);
    return url.toString().replace(/\/$/u, "");
  } catch {
    return "https://duallane.tsio.top";
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isUniqueConstraintError(error) {
  return error?.code === "23505" || /unique/iu.test(String(error?.message || ""));
}
