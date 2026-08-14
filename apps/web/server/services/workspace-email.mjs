import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} from "node:crypto";
import nodemailer from "nodemailer";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { writeAudit } from "./audit.mjs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const SMTP_TEST_WINDOW_MS = 10 * 60 * 1000;
const SMTP_TEST_LIMIT = 5;
const EMAIL_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CHALLENGE_RESEND_MS = 60 * 1000;
const EMAIL_CHALLENGE_HOURLY_LIMIT = 5;
const IMMEDIATE_DELAY_MS = 60 * 1000;
const DIGEST_DELAY_MS = 2 * 60 * 60 * 1000;
const WORKER_INTERVAL_MS = 30 * 1000;
const WORKER_LEASE_MS = 2 * 60 * 1000;
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];

export class WorkspaceEmailError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceEmailError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createWorkspaceEmailService({ db, env = process.env, baseUrl, sendMail, now = () => new Date() }) {
  const publicBaseUrl = normalizeBaseUrl(baseUrl || env.WORKSPACE_FRONTEND_URL || env.PUBLIC_BASE_URL);
  const sender = sendMail || sendWithNodemailer;

  async function getSpaceSettings(actorId) {
    await requireOwner(actorId);
    const stored = await readStoredSmtpSettings();
    const failedJobs = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM workspace_email_jobs
      WHERE status = 'failed'
    `).get();
    const lastDelivery = await db.prepare(`
      SELECT MAX(sent_at) AS sentAt
      FROM workspace_email_jobs
      WHERE status = 'sent'
    `).get();
    return publicSmtpSettings(stored, {
      failedJobCount: Number(failedJobs?.count) || 0,
      lastDeliveryAt: lastDelivery?.sentAt ?? null
    });
  }

  async function testSpaceSettings(request, actorId, input) {
    const actor = await requireOwner(actorId);
    const key = requireEncryptionKey(env);
    await enforceSmtpTestLimit(actor.id);
    const existing = await readStoredSmtpSettings();
    const existingPassword = existing?.passwordCiphertext
      ? decryptSecret(existing.passwordCiphertext, key, DEFAULT_SPACE_ID)
      : "";
    const draft = normalizeSmtpDraft(input, existingPassword);
    const preferences = await ensurePreferences(actor);
    if (!preferences.email || !preferences.emailVerifiedAt) {
      throw new WorkspaceEmailError("email.recipient_unverified", "请先设置并验证通知邮箱");
    }
    const testedAt = now().toISOString();
    try {
      await sender(draft, buildTestTemplate(publicBaseUrl), preferences.email);
      await writeEmailAudit(request, actor, "email.smtp_test", "success");
      const testProof = signTestProof(key, {
        actorId: actor.id,
        fingerprint: smtpFingerprint(draft, key),
        expiresAt: now().getTime() + EMAIL_CHALLENGE_TTL_MS
      });
      return { ok: true, testedAt, testProof, recipient: maskEmail(preferences.email) };
    } catch (error) {
      const code = normalizeMailError(error);
      await writeEmailAudit(request, actor, "email.smtp_test", "failure", code);
      throw new WorkspaceEmailError(code, smtpErrorMessage(code), 502);
    }
  }

  async function saveSpaceSettings(request, actorId, input) {
    const actor = await requireOwner(actorId);
    const key = requireEncryptionKey(env);
    const existing = await readStoredSmtpSettings();
    const existingPassword = existing?.passwordCiphertext
      ? decryptSecret(existing.passwordCiphertext, key, DEFAULT_SPACE_ID)
      : "";
    const draft = normalizeSmtpDraft(input, existingPassword);
    const enabled = input?.enabled === true;
    if (enabled && !verifyTestProof(key, input?.testProof, actor.id, smtpFingerprint(draft, key), now().getTime())) {
      throw new WorkspaceEmailError("email.smtp_test_required", "请先测试当前邮件配置");
    }
    const updatedAt = now().toISOString();
    const activeFrom = enabled
      ? existing?.enabled
        ? existing.activeFrom || updatedAt
        : updatedAt
      : null;
    const passwordCiphertext = draft.password
      ? encryptSecret(draft.password, key, DEFAULT_SPACE_ID)
      : null;
    await db.prepare(`
      INSERT INTO space_email_settings (
        space_id, enabled, smtp_host, smtp_port, encryption, username, from_address, from_name,
        password_ciphertext, active_from, last_tested_at, last_test_status, last_test_error_code,
        updated_by, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', NULL, ?, ?)
      ON CONFLICT (space_id) DO UPDATE SET
        enabled = excluded.enabled,
        smtp_host = excluded.smtp_host,
        smtp_port = excluded.smtp_port,
        encryption = excluded.encryption,
        username = excluded.username,
        from_address = excluded.from_address,
        from_name = excluded.from_name,
        password_ciphertext = excluded.password_ciphertext,
        active_from = excluded.active_from,
        last_tested_at = excluded.last_tested_at,
        last_test_status = excluded.last_test_status,
        last_test_error_code = NULL,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(
      DEFAULT_SPACE_ID,
      enabled ? 1 : 0,
      draft.smtpHost,
      draft.smtpPort,
      draft.encryption,
      draft.username || null,
      draft.fromAddress,
      draft.fromName,
      passwordCiphertext,
      activeFrom,
      updatedAt,
      actor.id,
      updatedAt
    );
    if (!enabled) {
      await db.prepare(`
        UPDATE workspace_email_jobs
        SET status = 'cancelled', cancelled_at = ?, lease_until = NULL
        WHERE status IN ('pending', 'sending')
      `).run(updatedAt);
      await db.prepare("DELETE FROM workspace_email_digest_states").run();
    }
    await writeEmailAudit(request, actor, "email.smtp_settings_update", "success");
    return await getSpaceSettings(actor.id);
  }

  async function getPreferences(actorId) {
    const actor = await requireHumanActor(actorId);
    return publicPreferences(await ensurePreferences(actor), actor.email, await isMailAvailable());
  }

  async function updatePreferences(actorId, input) {
    const actor = await requireHumanActor(actorId);
    const current = await ensurePreferences(actor);
    const updatedAt = now().toISOString();
    const enabled = input?.enabled === undefined ? Boolean(current.enabled) : input.enabled === true;
    const immediateEnabled = input?.immediateEnabled === undefined
      ? Boolean(current.immediateEnabled)
      : input.immediateEnabled === true;
    const digestEnabled = input?.digestEnabled === undefined
      ? Boolean(current.digestEnabled)
      : input.digestEnabled === true;
    await db.prepare(`
      UPDATE user_notification_preferences
      SET enabled = ?, immediate_enabled = ?, digest_enabled = ?, updated_at = ?
      WHERE user_id = ?
    `).run(enabled ? 1 : 0, immediateEnabled ? 1 : 0, digestEnabled ? 1 : 0, updatedAt, actor.id);
    if (!enabled || !digestEnabled) {
      await db.prepare("DELETE FROM workspace_email_digest_states WHERE user_id = ?").run(actor.id);
    }
    if (!enabled || !immediateEnabled) {
      await cancelPendingJobs(actor.id, updatedAt);
    }
    return await getPreferences(actor.id);
  }

  async function createEmailChallenge(request, actorId, input) {
    const actor = await requireHumanActor(actorId);
    const email = normalizeEmail(input?.email);
    const currentTime = now();
    const since = new Date(currentTime.getTime() - 60 * 60 * 1000).toISOString();
    const recent = await db.prepare(`
      SELECT COUNT(*) AS count, MAX(created_at) AS latestAt
      FROM notification_email_challenges
      WHERE user_id = ? AND created_at >= ?
    `).get(actor.id, since);
    if ((Number(recent?.count) || 0) >= EMAIL_CHALLENGE_HOURLY_LIMIT) {
      throw new WorkspaceEmailError("email.verification_rate_limited", "验证码发送过于频繁，请稍后再试", 429);
    }
    if (recent?.latestAt && currentTime.getTime() - Date.parse(recent.latestAt) < EMAIL_CHALLENGE_RESEND_MS) {
      throw new WorkspaceEmailError("email.verification_resend_later", "请稍后再发送验证码", 429);
    }
    const smtp = await loadActiveSmtpSettings();
    const key = requireEncryptionKey(env);
    const id = crypto.randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const createdAt = currentTime.toISOString();
    const expiresAt = new Date(currentTime.getTime() + EMAIL_CHALLENGE_TTL_MS).toISOString();
    try {
      await sender(smtp, buildVerificationTemplate(code, publicBaseUrl), email);
    } catch (error) {
      const errorCode = normalizeMailError(error);
      await writeEmailAudit(request, actor, "email.verification_send", "failure", errorCode);
      throw new WorkspaceEmailError(errorCode, smtpErrorMessage(errorCode), 502);
    }
    await db.prepare(`
      UPDATE notification_email_challenges
      SET consumed_at = ?
      WHERE user_id = ? AND consumed_at IS NULL
    `).run(createdAt, actor.id);
    await db.prepare(`
      INSERT INTO notification_email_challenges (
        id, user_id, pending_email, code_hash, attempts, created_at, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)
    `).run(id, actor.id, email, challengeHash(key, id, code), createdAt, expiresAt);
    await writeEmailAudit(request, actor, "email.verification_send", "success");
    return { challengeId: id, pendingEmail: maskEmail(email), expiresAt, resendAfterSeconds: 60 };
  }

  async function verifyEmailChallenge(request, actorId, input) {
    const actor = await requireHumanActor(actorId);
    const id = normalizeText(input?.challengeId);
    const code = normalizeText(input?.code);
    const challenge = await db.prepare(`
      SELECT id, pending_email AS pendingEmail, code_hash AS codeHash, attempts, expires_at AS expiresAt, consumed_at AS consumedAt
      FROM notification_email_challenges
      WHERE id = ? AND user_id = ?
    `).get(id, actor.id);
    if (!challenge || challenge.consumedAt || Date.parse(challenge.expiresAt) <= now().getTime() || challenge.attempts >= 5) {
      throw new WorkspaceEmailError("email.verification_invalid", "验证码无效或已过期");
    }
    const key = requireEncryptionKey(env);
    if (!safeEqual(challenge.codeHash, challengeHash(key, id, code))) {
      await db.prepare("UPDATE notification_email_challenges SET attempts = attempts + 1 WHERE id = ?").run(id);
      await writeEmailAudit(request, actor, "email.verification_confirm", "rejected", "email.verification_invalid");
      throw new WorkspaceEmailError("email.verification_invalid", "验证码无效或已过期");
    }
    const verifiedAt = now().toISOString();
    await db.transaction(async () => {
      await db.prepare("UPDATE notification_email_challenges SET consumed_at = ? WHERE id = ?")
        .run(verifiedAt, id);
      await db.prepare(`
        UPDATE user_notification_preferences
        SET email = ?, email_source = 'custom', email_verified_at = ?, updated_at = ?
        WHERE user_id = ?
      `).run(challenge.pendingEmail, verifiedAt, verifiedAt, actor.id);
    });
    await writeEmailAudit(request, actor, "email.verification_confirm", "success");
    return await getPreferences(actor.id);
  }

  async function useGitHubEmail(actorId) {
    const actor = await requireHumanActor(actorId);
    if (!actor.email) {
      throw new WorkspaceEmailError("email.github_unavailable", "GitHub 账号没有可用邮箱");
    }
    const updatedAt = now().toISOString();
    await ensurePreferences(actor);
    await db.prepare(`
      UPDATE user_notification_preferences
      SET email = ?, email_source = 'github', email_verified_at = ?, updated_at = ?
      WHERE user_id = ?
    `).run(actor.email, updatedAt, updatedAt, actor.id);
    return await getPreferences(actor.id);
  }

  async function syncGitHubEmail(userId, email) {
    const actor = await requireHumanActor(userId);
    const updatedAt = now().toISOString();
    await ensurePreferences(actor);
    if (email) {
      await db.prepare(`
        UPDATE user_notification_preferences
        SET email = ?, email_verified_at = ?, updated_at = ?
        WHERE user_id = ? AND email_source = 'github'
      `).run(email, updatedAt, updatedAt, userId);
    }
  }

  async function scheduleMessage({ authorId, spaceId, conversationId, topicId, messageId, eventSeq, content, createdAt }) {
    const smtp = await readStoredSmtpSettings();
    if (!smtp?.enabled || !smtp.activeFrom || Date.parse(createdAt) < Date.parse(smtp.activeFrom)) {
      return;
    }
    const mentionedUserIds = new Set(
      (content?.blocks ?? [])
        .filter((block) => block?.type === "mention")
        .map((block) => normalizeText(block.userId))
        .filter(Boolean)
    );
    const notificationSpaceId = normalizeText(spaceId) || DEFAULT_SPACE_ID;
    const recipients = topicId
      ? await db.prepare(`
      SELECT
        u.id,
        tm.notification_level AS notificationLevel,
        p.enabled,
        p.immediate_enabled AS immediateEnabled,
        p.digest_enabled AS digestEnabled,
        p.email,
        p.email_verified_at AS emailVerifiedAt
      FROM topic_members tm
      INNER JOIN users u ON u.id = tm.user_id AND u.kind = 'human'
      INNER JOIN conversation_members cm ON cm.conversation_id = ? AND cm.user_id = tm.user_id AND cm.removed_at IS NULL
      INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ? AND sm.removed_at IS NULL
      INNER JOIN user_notification_preferences p ON p.user_id = u.id
      WHERE tm.topic_id = ? AND tm.left_at IS NULL AND u.id <> ?
    `).all(conversationId, notificationSpaceId, topicId, authorId)
      : await db.prepare(`
      SELECT
        u.id,
        cm.notification_level AS notificationLevel,
        p.enabled,
        p.immediate_enabled AS immediateEnabled,
        p.digest_enabled AS digestEnabled,
        p.email,
        p.email_verified_at AS emailVerifiedAt
      FROM conversation_members cm
      INNER JOIN users u ON u.id = cm.user_id AND u.kind = 'human'
      INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ? AND sm.removed_at IS NULL
      INNER JOIN user_notification_preferences p ON p.user_id = u.id
      WHERE cm.conversation_id = ? AND cm.removed_at IS NULL AND u.id <> ?
      `).all(notificationSpaceId, conversationId, authorId);
    const availableAt = new Date(Date.parse(createdAt) + IMMEDIATE_DELAY_MS).toISOString();
    for (const recipient of recipients) {
      if (!recipient.enabled || !recipient.email || !recipient.emailVerifiedAt) continue;
      const allowed = recipient.notificationLevel === "all" || (
        recipient.notificationLevel === "mentions" && mentionedUserIds.has(recipient.id)
      );
      if (!allowed) continue;
      if (recipient.immediateEnabled) {
        await db.prepare(`
          INSERT INTO workspace_email_jobs (
            id, user_id, message_id, conversation_id, event_seq, status, available_at,
            next_attempt_at, lease_until, attempt_count, sent_at, cancelled_at, last_error_code, created_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, 0, NULL, NULL, NULL, ?)
          ON CONFLICT (user_id, message_id) DO NOTHING
        `).run(crypto.randomUUID(), recipient.id, messageId, conversationId, eventSeq, availableAt, availableAt, createdAt);
      }
      if (recipient.digestEnabled) {
        await db.prepare(`
          INSERT INTO workspace_email_digest_states (
            user_id, started_at, notified_at, lease_until, attempt_count, next_attempt_at, last_error_code, updated_at
          ) VALUES (?, ?, NULL, NULL, 0, ?, NULL, ?)
          ON CONFLICT (user_id) DO NOTHING
        `).run(recipient.id, createdAt, new Date(Date.parse(createdAt) + DIGEST_DELAY_MS).toISOString(), createdAt);
      }
    }
  }

  async function reconcileDigestState(userId) {
    const state = await db.prepare(`
      SELECT started_at AS startedAt
      FROM workspace_email_digest_states
      WHERE user_id = ?
    `).get(userId);
    if (!state) return;
    const messages = await listEligibleUnreadMessages(userId, state.startedAt);
    if (messages.length === 0) {
      await db.prepare("DELETE FROM workspace_email_digest_states WHERE user_id = ?").run(userId);
    }
  }

  function startWorker({ presence, startupDelayMs, intervalMs } = {}) {
    if (env.WORKSPACE_EMAIL_WORKER_ENABLED === "false") {
      return { stop() {} };
    }
    let stopped = false;
    let running = false;
    let interval;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await processImmediateJobs(presence);
        await processDigestStates();
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

  async function processImmediateJobs(presence) {
    const current = now();
    const candidates = await db.prepare(`
      SELECT id
      FROM workspace_email_jobs
      WHERE status IN ('pending', 'sending')
        AND next_attempt_at <= ?
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_attempt_at ASC
      LIMIT 25
    `).all(current.toISOString(), current.toISOString());
    for (const candidate of candidates) {
      const leaseUntil = new Date(current.getTime() + WORKER_LEASE_MS).toISOString();
      const claimed = await db.prepare(`
        UPDATE workspace_email_jobs
        SET status = 'sending', lease_until = ?
        WHERE id = ? AND status IN ('pending', 'sending') AND (lease_until IS NULL OR lease_until <= ?)
      `).run(leaseUntil, candidate.id, current.toISOString());
      if (!claimed.changes) continue;
      const job = await readImmediateJob(candidate.id);
      if (!job || !isJobUnread(job) || !job.preferenceEnabled || !job.immediateEnabled || !job.emailVerifiedAt || job.notificationLevel === "muted") {
        await cancelJob(candidate.id, current.toISOString());
        continue;
      }
      if (job.notificationLevel === "mentions" && !messageMentions(job.contentJson, job.userId)) {
        await cancelJob(candidate.id, current.toISOString());
        continue;
      }
      if (presence?.isOnline(job.userId)) {
        await db.prepare(`
          UPDATE workspace_email_jobs
          SET status = 'pending', lease_until = NULL, next_attempt_at = ?
          WHERE id = ?
        `).run(new Date(current.getTime() + WORKER_INTERVAL_MS).toISOString(), job.id);
        continue;
      }
      try {
        const smtp = await loadActiveSmtpSettings();
        await sender(smtp, buildImmediateTemplate(publicBaseUrl), job.email);
        await db.prepare(`
          UPDATE workspace_email_jobs
          SET status = 'sent', sent_at = ?, lease_until = NULL, last_error_code = NULL
          WHERE id = ?
        `).run(current.toISOString(), job.id);
      } catch (error) {
        await retryImmediateJob(job, normalizeMailError(error), current);
      }
    }
  }

  async function processDigestStates() {
    const current = now();
    const states = await db.prepare(`
      SELECT user_id AS userId, started_at AS startedAt, notified_at AS notifiedAt,
        attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt
      FROM workspace_email_digest_states
      WHERE lease_until IS NULL OR lease_until <= ?
      ORDER BY started_at ASC
      LIMIT 25
    `).all(current.toISOString());
    for (const state of states) {
      const messages = await listEligibleUnreadMessages(state.userId, state.startedAt);
      if (messages.length === 0) {
        await db.prepare("DELETE FROM workspace_email_digest_states WHERE user_id = ?").run(state.userId);
        continue;
      }
      if (state.notifiedAt || Date.parse(state.nextAttemptAt) > current.getTime()) continue;
      const leaseUntil = new Date(current.getTime() + WORKER_LEASE_MS).toISOString();
      const claimed = await db.prepare(`
        UPDATE workspace_email_digest_states
        SET lease_until = ?
        WHERE user_id = ? AND notified_at IS NULL AND (lease_until IS NULL OR lease_until <= ?)
      `).run(leaseUntil, state.userId, current.toISOString());
      if (!claimed.changes) continue;
      const preference = await readPreferences(state.userId);
      if (!preference?.enabled || !preference.digestEnabled || !preference.email || !preference.emailVerifiedAt) {
        await db.prepare("DELETE FROM workspace_email_digest_states WHERE user_id = ?").run(state.userId);
        continue;
      }
      try {
        const smtp = await loadActiveSmtpSettings();
        const senderCount = new Set(messages.map((message) => message.authorId).filter(Boolean)).size;
        const durationMs = Math.max(DIGEST_DELAY_MS, current.getTime() - Date.parse(state.startedAt));
        await sender(smtp, buildDigestTemplate(publicBaseUrl, durationMs, senderCount, messages.length), preference.email);
        await db.prepare(`
          UPDATE workspace_email_digest_states
          SET notified_at = ?, lease_until = NULL, last_error_code = NULL, updated_at = ?
          WHERE user_id = ?
        `).run(current.toISOString(), current.toISOString(), state.userId);
      } catch (error) {
        await retryDigestState(state, normalizeMailError(error), current);
      }
    }
  }

  async function listEligibleUnreadMessages(userId, startedAt) {
    const rows = await db.prepare(`
      SELECT
        m.id,
        m.author_id AS authorId,
        m.created_at AS createdAt,
        m.content_json AS contentJson,
        COALESCE(tm.notification_level, cm.notification_level) AS notificationLevel,
        COALESCE(tm.last_read_seq, cm.last_read_seq) AS lastReadSeq,
        COALESCE(tm.last_read_at, cm.last_read_at) AS lastReadAt,
        we.seq AS eventSeq
      FROM messages m
      INNER JOIN conversation_members cm
        ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.removed_at IS NULL
      LEFT JOIN topic_members tm
        ON tm.topic_id = m.topic_id AND tm.user_id = ? AND tm.left_at IS NULL
      INNER JOIN conversations c ON c.id = m.conversation_id AND c.space_id = ?
      INNER JOIN space_members sm ON sm.user_id = ? AND sm.space_id = ? AND sm.removed_at IS NULL
      LEFT JOIN workspace_events we
        ON we.type IN ('message.created', 'topic.message.created')
          AND we.target_id = m.id AND we.conversation_id = m.conversation_id
      WHERE m.created_at >= ?
        AND m.deleted_at IS NULL
        AND m.recalled_at IS NULL
        AND m.kind IN ('user', 'bot')
        AND (m.author_id IS NULL OR m.author_id <> ?)
        AND (m.topic_id IS NULL OR tm.user_id IS NOT NULL)
      ORDER BY m.created_at ASC, m.id ASC
    `).all(userId, userId, DEFAULT_SPACE_ID, userId, DEFAULT_SPACE_ID, startedAt, userId);
    return rows.filter((row) => {
      const unread = row.lastReadSeq !== null && row.lastReadSeq !== undefined
        ? Number(row.eventSeq) > Number(row.lastReadSeq)
        : !row.lastReadAt || Date.parse(row.createdAt) > Date.parse(row.lastReadAt);
      if (!unread || row.notificationLevel === "muted") return false;
      return row.notificationLevel !== "mentions" || messageMentions(row.contentJson, userId);
    });
  }

  async function readImmediateJob(id) {
    return await db.prepare(`
      SELECT
        j.id, j.user_id AS userId, j.event_seq AS eventSeq, j.attempt_count AS attemptCount,
        p.email, p.email_verified_at AS emailVerifiedAt, p.enabled AS preferenceEnabled,
        p.immediate_enabled AS immediateEnabled,
        COALESCE(tm.notification_level, cm.notification_level) AS notificationLevel,
        COALESCE(tm.last_read_seq, cm.last_read_seq) AS lastReadSeq,
        COALESCE(tm.last_read_at, cm.last_read_at) AS lastReadAt,
        m.created_at AS messageCreatedAt, m.content_json AS contentJson
      FROM workspace_email_jobs j
      INNER JOIN user_notification_preferences p ON p.user_id = j.user_id
      INNER JOIN messages m ON m.id = j.message_id AND m.deleted_at IS NULL AND m.recalled_at IS NULL
      INNER JOIN conversation_members cm
        ON cm.conversation_id = j.conversation_id AND cm.user_id = j.user_id AND cm.removed_at IS NULL
      LEFT JOIN topic_members tm
        ON tm.topic_id = m.topic_id AND tm.user_id = j.user_id AND tm.left_at IS NULL
      INNER JOIN space_members sm
        ON sm.user_id = j.user_id AND sm.space_id = ? AND sm.removed_at IS NULL
      WHERE j.id = ?
        AND (m.topic_id IS NULL OR tm.user_id IS NOT NULL)
    `).get(DEFAULT_SPACE_ID, id);
  }

  function isJobUnread(job) {
    return job.lastReadSeq !== null && job.lastReadSeq !== undefined
      ? Number(job.eventSeq) > Number(job.lastReadSeq)
      : !job.lastReadAt || Date.parse(job.messageCreatedAt) > Date.parse(job.lastReadAt);
  }

  async function retryImmediateJob(job, code, current) {
    const attempt = Number(job.attemptCount) + 1;
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (delay === undefined) {
      await db.prepare(`
        UPDATE workspace_email_jobs
        SET status = 'failed', attempt_count = ?, lease_until = NULL, last_error_code = ?
        WHERE id = ?
      `).run(attempt, code, job.id);
      return;
    }
    await db.prepare(`
      UPDATE workspace_email_jobs
      SET status = 'pending', attempt_count = ?, lease_until = NULL, next_attempt_at = ?, last_error_code = ?
      WHERE id = ?
    `).run(attempt, new Date(current.getTime() + delay).toISOString(), code, job.id);
  }

  async function retryDigestState(state, code, current) {
    const attempt = Number(state.attemptCount) + 1;
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (delay === undefined) {
      await db.prepare(`
        UPDATE workspace_email_digest_states
        SET attempt_count = ?, lease_until = NULL, next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE user_id = ?
      `).run(attempt, new Date(current.getTime() + 24 * 60 * 60 * 1000).toISOString(), code, current.toISOString(), state.userId);
      return;
    }
    await db.prepare(`
      UPDATE workspace_email_digest_states
      SET attempt_count = ?, lease_until = NULL, next_attempt_at = ?, last_error_code = ?, updated_at = ?
      WHERE user_id = ?
    `).run(attempt, new Date(current.getTime() + delay).toISOString(), code, current.toISOString(), state.userId);
  }

  async function cancelJob(id, cancelledAt) {
    await db.prepare(`
      UPDATE workspace_email_jobs
      SET status = 'cancelled', cancelled_at = ?, lease_until = NULL
      WHERE id = ?
    `).run(cancelledAt, id);
  }

  async function cancelPendingJobs(userId, cancelledAt) {
    await db.prepare(`
      UPDATE workspace_email_jobs
      SET status = 'cancelled', cancelled_at = ?, lease_until = NULL
      WHERE user_id = ? AND status IN ('pending', 'sending')
    `).run(cancelledAt, userId);
  }

  async function requireHumanActor(userId) {
    const actor = await db.prepare(`
      SELECT u.id, u.github_login AS githubLogin, u.email, u.kind, sm.role
      FROM users u
      INNER JOIN space_members sm ON sm.user_id = u.id
      WHERE u.id = ? AND u.kind = 'human' AND sm.space_id = ? AND sm.removed_at IS NULL
    `).get(normalizeText(userId), DEFAULT_SPACE_ID);
    if (!actor) throw new WorkspaceEmailError("auth.required", "请先登录共享空间", 401);
    return actor;
  }

  async function requireOwner(userId) {
    const actor = await requireHumanActor(userId);
    if (actor.role !== "owner") throw new WorkspaceEmailError("permission.denied", "你没有执行该操作的权限", 403);
    return actor;
  }

  async function ensurePreferences(actor) {
    const updatedAt = now().toISOString();
    await db.prepare(`
      INSERT INTO user_notification_preferences (
        user_id, email, email_source, email_verified_at, enabled, immediate_enabled, digest_enabled, updated_at
      ) VALUES (?, ?, 'github', ?, 1, 0, 1, ?)
      ON CONFLICT (user_id) DO NOTHING
    `).run(actor.id, actor.email || null, actor.email ? updatedAt : null, updatedAt);
    return await readPreferences(actor.id);
  }

  async function readPreferences(userId) {
    return await db.prepare(`
      SELECT user_id AS userId, email, email_source AS emailSource, email_verified_at AS emailVerifiedAt,
        enabled, immediate_enabled AS immediateEnabled, digest_enabled AS digestEnabled, updated_at AS updatedAt
      FROM user_notification_preferences WHERE user_id = ?
    `).get(userId);
  }

  async function readStoredSmtpSettings() {
    return await db.prepare(`
      SELECT space_id AS spaceId, enabled, smtp_host AS smtpHost, smtp_port AS smtpPort,
        encryption, username, from_address AS fromAddress, from_name AS fromName,
        password_ciphertext AS passwordCiphertext, active_from AS activeFrom,
        last_tested_at AS lastTestedAt, last_test_status AS lastTestStatus,
        last_test_error_code AS lastTestErrorCode, updated_at AS updatedAt
      FROM space_email_settings WHERE space_id = ?
    `).get(DEFAULT_SPACE_ID);
  }

  async function loadActiveSmtpSettings() {
    const stored = await readStoredSmtpSettings();
    if (!stored?.enabled) throw new WorkspaceEmailError("email.smtp_unavailable", "空间邮件通知尚未启用", 503);
    const key = requireEncryptionKey(env);
    return {
      ...stored,
      smtpPort: Number(stored.smtpPort),
      password: stored.passwordCiphertext ? decryptSecret(stored.passwordCiphertext, key, DEFAULT_SPACE_ID) : ""
    };
  }

  async function isMailAvailable() {
    const stored = await readStoredSmtpSettings();
    return Boolean(stored?.enabled);
  }

  async function enforceSmtpTestLimit(actorId) {
    const since = new Date(now().getTime() - SMTP_TEST_WINDOW_MS).toISOString();
    const row = await db.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE actor_user_id = ? AND action = 'email.smtp_test' AND created_at >= ?
    `).get(actorId, since);
    if ((Number(row?.count) || 0) >= SMTP_TEST_LIMIT) {
      throw new WorkspaceEmailError("email.smtp_test_rate_limited", "测试过于频繁，请稍后再试", 429);
    }
  }

  async function writeEmailAudit(request, actor, action, result, reason = null) {
    await writeAudit(db, {
      spaceId: DEFAULT_SPACE_ID,
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action,
      targetType: "email_settings",
      targetId: DEFAULT_SPACE_ID,
      result,
      reason,
      ipAddress: request?.ip,
      userAgent: request?.headers?.["user-agent"],
      requestId: request?.id
    });
  }

  return {
    createEmailChallenge,
    getPreferences,
    getSpaceSettings,
    reconcileDigestState,
    saveSpaceSettings,
    scheduleMessage,
    startWorker,
    syncGitHubEmail,
    testSpaceSettings,
    updatePreferences,
    useGitHubEmail,
    verifyEmailChallenge
  };
}

function normalizeSmtpDraft(input, existingPassword = "") {
  const smtpHost = normalizeText(input?.smtpHost || input?.host);
  const smtpPort = Number(input?.smtpPort || input?.port);
  const encryption = normalizeText(input?.encryption) || "starttls";
  const username = normalizeText(input?.username);
  const password = typeof input?.password === "string" && input.password !== "" ? input.password : existingPassword;
  const fromName = normalizeText(input?.fromName) || "DualLane";
  const fromAddress = normalizeText(input?.fromAddress) || (EMAIL_RE.test(username) ? username : "");
  if (!smtpHost || smtpHost.length > 253 || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new WorkspaceEmailError("email.smtp_invalid", "请填写有效的 SMTP 服务器和端口");
  }
  if (!["starttls", "tls", "none"].includes(encryption)) {
    throw new WorkspaceEmailError("email.smtp_invalid", "请选择有效的加密方式");
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new WorkspaceEmailError("email.smtp_auth_invalid", "SMTP 用户名和密码需要同时填写");
  }
  if (!EMAIL_RE.test(fromAddress) || fromName.length > 80 || username.length > 320 || password.length > 4096) {
    throw new WorkspaceEmailError("email.smtp_invalid", "请填写有效的发信信息");
  }
  return { smtpHost, smtpPort, encryption, username, password, fromAddress, fromName };
}

function publicSmtpSettings(stored, health) {
  if (!stored) {
    return {
      enabled: false,
      smtpHost: "",
      smtpPort: 587,
      encryption: "starttls",
      username: "",
      fromAddress: "",
      fromName: "DualLane",
      passwordConfigured: false,
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestErrorCode: null,
      ...health
    };
  }
  return {
    enabled: Boolean(stored.enabled),
    smtpHost: stored.smtpHost,
    smtpPort: Number(stored.smtpPort),
    encryption: stored.encryption,
    username: stored.username || "",
    fromAddress: stored.fromAddress,
    fromName: stored.fromName,
    passwordConfigured: Boolean(stored.passwordCiphertext),
    activeFrom: stored.activeFrom,
    lastTestedAt: stored.lastTestedAt,
    lastTestStatus: stored.lastTestStatus,
    lastTestErrorCode: stored.lastTestErrorCode,
    updatedAt: stored.updatedAt,
    ...health
  };
}

function publicPreferences(row, githubEmail, mailAvailable) {
  return {
    email: row?.email || null,
    maskedEmail: row?.email ? maskEmail(row.email) : null,
    emailSource: row?.emailSource || "github",
    emailVerified: Boolean(row?.emailVerifiedAt),
    githubEmail: githubEmail || null,
    enabled: Boolean(row?.enabled),
    immediateEnabled: Boolean(row?.immediateEnabled),
    digestEnabled: Boolean(row?.digestEnabled),
    mailAvailable
  };
}

function requireEncryptionKey(env) {
  const value = normalizeText(env.WORKSPACE_SMTP_ENCRYPTION_KEY);
  let key;
  try {
    key = Buffer.from(value, "base64");
  } catch {
    key = Buffer.alloc(0);
  }
  if (key.length !== 32) {
    throw new WorkspaceEmailError("email.encryption_not_configured", "邮件凭据加密密钥尚未配置", 503);
  }
  return key;
}

function encryptSecret(value, key, associatedData) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptSecret(value, key, associatedData) {
  const [version, ivValue, tagValue, ciphertextValue] = normalizeText(value).split(".");
  if (version !== "v1" || !ivValue || !tagValue || ciphertextValue === undefined) {
    throw new WorkspaceEmailError("email.credential_unavailable", "邮件凭据无法读取", 503);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new WorkspaceEmailError("email.credential_unavailable", "邮件凭据无法读取", 503);
  }
}

function smtpFingerprint(config, key) {
  return createHmac("sha256", key).update(JSON.stringify([
    config.smtpHost,
    config.smtpPort,
    config.encryption,
    config.username,
    config.password,
    config.fromAddress,
    config.fromName
  ])).digest("base64url");
}

function signTestProof(key, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyTestProof(key, value, actorId, fingerprint, currentTime) {
  const [body, signature] = normalizeText(value).split(".");
  if (!body || !signature) return false;
  const expected = createHmac("sha256", key).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.actorId === actorId && payload.fingerprint === fingerprint && Number(payload.expiresAt) > currentTime;
  } catch {
    return false;
  }
}

function challengeHash(key, id, code) {
  return createHmac("sha256", key).update(`${id}:${code}`).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function sendWithNodemailer(config, message, recipient) {
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: Number(config.smtpPort),
    secure: config.encryption === "tls",
    requireTLS: config.encryption === "starttls",
    ignoreTLS: config.encryption === "none",
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    tls: { rejectUnauthorized: true }
  });
  try {
    await transport.sendMail({
      from: { name: config.fromName, address: config.fromAddress },
      to: recipient,
      subject: message.subject,
      text: message.text,
      html: message.html
    });
  } finally {
    transport.close?.();
  }
}

function buildImmediateTemplate(baseUrl) {
  return buildTemplate(
    "你有一条未读消息",
    "有人通过 DualLane 给您发送了一条消息。",
    baseUrl
  );
}

function buildDigestTemplate(baseUrl, durationMs, senderCount, messageCount) {
  return buildTemplate(
    "你有未处理的消息",
    `过去${formatDuration(durationMs)}内有${senderCount}人给您发送了${messageCount}条消息，您已超过2小时未处理。`,
    baseUrl
  );
}

function buildVerificationTemplate(code, baseUrl) {
  return buildTemplate(
    "验证通知邮箱",
    `您的验证码是 ${code}，10 分钟内有效。`,
    baseUrl
  );
}

function buildTestTemplate(baseUrl) {
  return buildTemplate(
    "邮件配置测试成功",
    "DualLane 已成功使用当前 SMTP 配置发送此邮件。",
    baseUrl
  );
}

function buildTemplate(title, body, baseUrl) {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  const safeUrl = escapeHtml(baseUrl);
  return {
    subject: `DualLane：${title}`,
    text: `${body}\n\n打开共享空间：${baseUrl}\n\n此邮件不会展示消息正文或附件内容。`,
    html: `<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f5f4ef;color:#1f2928;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><div style="max-width:560px;margin:0 auto;padding:32px 20px"><div style="border:1px solid #d9dedb;background:#ffffff;padding:28px"><div style="font-size:14px;font-weight:600;color:#168579">DualLane</div><h1 style="margin:18px 0 12px;font-size:22px;line-height:1.35">${safeTitle}</h1><p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#45504e">${safeBody}</p><a href="${safeUrl}" style="display:inline-block;background:#168579;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">打开共享空间</a><p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#77817f">此邮件不会展示消息正文、会话名称或附件内容。通知偏好可在个人设置中修改。</p></div></div></body></html>`
  };
}

function messageMentions(contentJson, userId) {
  try {
    const content = typeof contentJson === "string" ? JSON.parse(contentJson) : contentJson;
    return (content?.blocks ?? []).some((block) => block?.type === "mention" && block.userId === userId);
  } catch {
    return false;
  }
}

function normalizeMailError(error) {
  if (error instanceof WorkspaceEmailError) return error.code;
  const code = normalizeText(error?.code).toUpperCase();
  if (["EAUTH", "EENVELOPE"].includes(code)) return "email.smtp_auth_failed";
  if (["ETIMEDOUT", "ESOCKET"].includes(code)) return "email.smtp_timeout";
  if (["ECONNECTION", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return "email.smtp_unreachable";
  return "email.smtp_failed";
}

function smtpErrorMessage(code) {
  if (code === "email.smtp_auth_failed") return "SMTP 身份验证失败";
  if (code === "email.smtp_timeout") return "SMTP 连接超时";
  if (code === "email.smtp_unreachable") return "无法连接 SMTP 服务器";
  return "测试邮件发送失败";
}

function normalizeEmail(value) {
  const email = normalizeText(value).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 320) {
    throw new WorkspaceEmailError("email.invalid", "请输入有效的邮箱地址");
  }
  return email;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBaseUrl(value) {
  try {
    return new URL("/workspace", value || "http://127.0.0.1:8787").toString();
  } catch {
    return "http://127.0.0.1:8787/workspace";
  }
}

function maskEmail(value) {
  const [local, domain] = String(value).split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

function formatDuration(durationMs) {
  const minutes = Math.max(120, Math.floor(durationMs / 60_000));
  if (minutes < 180) return "约2小时";
  if (minutes < 24 * 60) return `约${Math.floor(minutes / 60)}小时`;
  return `约${Math.floor(minutes / (24 * 60))}天`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
