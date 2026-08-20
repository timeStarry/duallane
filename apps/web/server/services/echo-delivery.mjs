import { randomUUID } from "node:crypto";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { ECHO_USER_ID } from "./echo-identity.mjs";
import { normalizeCardBlock, normalizeCardPayload } from "./workspace-cards.mjs";

/**
 * Echo delivery is deliberately a small orchestration layer. Domain services
 * own authorization and state transitions; this module owns turning an
 * actor-filtered projection into a persisted card and a real Workspace bot
 * message. The stable source/client keys are the idempotency boundary.
 */

export const ECHO_DELIVERY_RETRY_DELAYS_MS = Object.freeze([
  60_000,
  5 * 60_000,
  30 * 60_000
]);
export const ECHO_DELIVERY_MAX_ATTEMPTS = ECHO_DELIVERY_RETRY_DELAYS_MS.length + 1;
export const ECHO_SOLICITATION_CARD_TYPE = "echo.solicitation";
export const ECHO_SOLICITATION_CARD_SCHEMA_VERSION = 1;
export const ECHO_REQUIREMENT_CARD_TYPE = "echo.request";
export const ECHO_REQUIREMENT_STATUS_CARD_TYPE = "echo.request-status";
export const ECHO_RELEASE_CARD_TYPE = "echo.release";
export const ECHO_DELIVERY_SOURCE_KIND = "echo";

export class EchoDeliveryError extends Error {
  constructor(code, message, statusCode = 503, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "EchoDeliveryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Create the Echo delivery coordinator.
 *
 * `solicitationService` and `requirementService` are the domain services from
 * the Echo runtime. They are optional so the server can boot on an older
 * database during a rolling migration; the worker simply remains idle until
 * the corresponding tables/services exist. `messageWriter` and
 * `conversationFactory` are injectable to reuse Workspace's normal event and
 * notification paths. SQL fallbacks keep the integration usable in focused
 * service tests and during startup recovery.
 */
export function createEchoDeliveryService(options = {}) {
  const db = options.db;
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("Echo delivery requires a database adapter");
  }
  const spaceId = normalizeIdentifier(options.spaceId ?? DEFAULT_SPACE_ID);
  const now = options.now ?? (() => new Date());
  const solicitationService = options.solicitationService
    ?? options.solicitations
    ?? null;
  const requirementService = options.requirementService
    ?? options.requirements
    ?? null;
  const releaseService = options.releaseService
    ?? options.releases
    ?? null;
  const cardService = options.cardService
    ?? options.cards
    ?? null;
  const cardRegistry = options.cardRegistry ?? null;
  const messageWriter = options.messageWriter
    ?? options.messageService
    ?? options.messages
    ?? null;
  const conversationFactory = options.conversationFactory
    ?? options.conversationService
    ?? null;
  const scheduleEmailNotifications = options.scheduleEmailNotifications
    ?? options.emailScheduler
    ?? null;
  const scheduleNtfyNotifications = options.scheduleNtfyNotifications
    ?? options.ntfyScheduler
    ?? null;
  const eventPublisher = options.eventPublisher ?? null;
  const retryDelaysMs = Array.isArray(options.retryDelaysMs)
    ? options.retryDelaysMs.map((value) => Math.max(0, Number(value) || 0))
    : ECHO_DELIVERY_RETRY_DELAYS_MS;
  const maxAttempts = Number.isSafeInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : retryDelaysMs.length + 1;
  const locks = new Map();

  async function withKeyLock(key, operation) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === queued) locks.delete(key);
    }
  }

  async function syncSolicitation(input = {}) {
    const publicId = normalizePublicId(input.publicId ?? input.solicitationPublicId);
    const rows = await loadSolicitationDeliveries(publicId, input.recipientUserId);
    if (rows.length === 0) {
      // A publish can race the worker before the domain transaction has
      // inserted delivery rows. Reconcile from the domain row when possible.
      if (input._reconciled !== true) {
        await ensureSolicitationDeliveryRows(publicId);
        return syncSolicitation({ ...input, _reconciled: true });
      }
      return summarizeResults([], "solicitation", publicId);
    }
    const results = [];
    for (const row of rows) {
      results.push(await deliverSolicitationDelivery(row, input));
    }
    return summarizeResults(results, "solicitation", publicId);
  }

  async function syncSolicitationById(input = {}) {
    const row = await db.prepare(`
      SELECT public_id AS publicId
      FROM echo_solicitations
      WHERE id = ? AND space_id = ?
    `).get(normalizeIdentifier(input.solicitationId), spaceId);
    if (!row) throw new EchoDeliveryError("echo.solicitation_not_found", "征集不存在", 404);
    return syncSolicitation({ ...input, publicId: row.publicId });
  }

  async function deliverSolicitationDelivery(row, input = {}) {
    const key = `solicitation:${row.deliveryId}`;
    return withKeyLock(key, async () => {
      const current = await readSolicitationDelivery(row.deliveryId);
      if (!current) return resultSkipped(row, "echo.delivery_not_found");
      if (!await isHumanRecipient(current.recipientUserId)) {
        await markSolicitationDelivery(current.deliveryId, "skipped", "echo.recipient_ineligible");
        return resultSkipped(current, "echo.recipient_ineligible");
      }
      if (current.deliveryStatus === "sent" && !input.force) {
        // A sent row still needs card refresh after a vote/status revision.
        // We intentionally continue when the domain revision changed.
        const existingCard = await findDeliveryCard(current);
        if (existingCard && Number(existingCard.domainRevision ?? existingCard.revision) >= Number(current.revision || 1)) {
          return resultSent(current, existingCard.cardId, existingCard.messageId, true);
        }
      }
      if (current.deliveryStatus === "failed" && !isRetryDue(current, now())) {
        return resultFailed(current, current.lastErrorCode || "echo.delivery_retry_pending");
      }
      if (Number(current.attemptCount) >= maxAttempts && current.deliveryStatus !== "sent") {
        return resultFailed(current, current.lastErrorCode || "echo.delivery_attempts_exhausted");
      }

      const recipientId = current.recipientUserId;
      let conversation;
      try {
        conversation = await ensureEchoDirectConversation(recipientId, input);
      } catch (error) {
        return await failSolicitationDelivery(current, error);
      }
      let projection;
      try {
        projection = await projectSolicitation(recipientId, current.publicId, input);
      } catch (error) {
        return await failSolicitationDelivery(current, error);
      }
      try {
        const delivered = await persistProjectionAndMessage({
          kind: "solicitation",
          resourceId: current.publicId,
          resourceInternalId: current.solicitationId,
          domainRevision: current.revision,
          recipientId,
          conversationId: conversation.id,
          projection,
          sourceKey: solicitationSourceKey(current, recipientId),
          clientMessageId: solicitationClientMessageId(current, recipientId),
          input
        });
        await markSolicitationDelivery(current.deliveryId, "sent", null);
        return resultSent(current, delivered.card.id, delivered.message?.id, false);
      } catch (error) {
        return await failSolicitationDelivery(current, error);
      }
    });
  }

  async function syncRequirement(input = {}) {
    const publicId = normalizeRequirementPublicId(input.publicId ?? input.requirementPublicId);
    const requirement = await loadRequirement(publicId);
    if (!requirement) throw new EchoDeliveryError("echo.requirement_not_found", "需求不存在", 404);
    const recipients = await requirementRecipients(requirement);
    const results = [];
    for (const recipient of recipients) {
      const cardTypes = input.cardType
        ? [input.cardType]
        : recipient.role === "owner"
          ? [ECHO_REQUIREMENT_CARD_TYPE]
          : [ECHO_REQUIREMENT_STATUS_CARD_TYPE];
      for (const cardType of cardTypes) {
        results.push(await deliverRequirementProjection({ requirement, recipientId: recipient.id, cardType, input }));
      }
    }
    return summarizeResults(results, "requirement", publicId);
  }

  async function syncRelease(input = {}) {
    const version = normalizeReleaseVersion(input.version);
    const rows = await loadReleaseDeliveries(version, input.recipientUserId);
    const results = [];
    for (const row of rows) {
      results.push(await deliverReleaseDelivery(row, input));
    }
    return summarizeResults(results, "release", version);
  }

  async function deliverReleaseDelivery(row, input = {}) {
    return withKeyLock(`release:${row.deliveryId}`, async () => {
      const current = await readReleaseDelivery(row.deliveryId);
      if (!current) return resultSkipped(row, "echo.delivery_not_found");
      if (!await isHumanRecipient(current.recipientUserId)) {
        await markReleaseDelivery(current.deliveryId, "skipped", "echo.recipient_ineligible");
        return resultSkipped(current, "echo.recipient_ineligible");
      }
      if (current.deliveryStatus === "sent" && !input.force) {
        const existingCard = await findReleaseDeliveryCard(current);
        return resultSent(current, existingCard?.cardId, existingCard?.messageId, true);
      }
      if (current.deliveryStatus === "failed" && !isRetryDue(current, now())) {
        return resultFailed(current, current.lastErrorCode || "echo.delivery_retry_pending");
      }
      if (Number(current.attemptCount) >= maxAttempts) {
        return resultFailed(current, current.lastErrorCode || "echo.delivery_attempts_exhausted");
      }

      const recipientId = current.recipientUserId;
      let conversation;
      try {
        conversation = await ensureEchoDirectConversation(recipientId, input);
      } catch (error) {
        return failReleaseDelivery(current, error);
      }
      let projection;
      try {
        if (!releaseService?.projectCard) throw new EchoDeliveryError("echo.release_unavailable", "版本发布服务尚未初始化");
        projection = await releaseService.projectCard({ actorId: recipientId, version: current.version, request: input.request });
      } catch (error) {
        return failReleaseDelivery(current, error);
      }
      try {
        const delivered = await persistProjectionAndMessage({
          kind: "release",
          resourceId: current.version,
          resourceInternalId: current.publicationId,
          domainRevision: 1,
          recipientId,
          conversationId: conversation.id,
          projection,
          sourceKey: releaseSourceKey(current, recipientId),
          clientMessageId: releaseClientMessageId(current, recipientId),
          input
        });
        await markReleaseDelivery(current.deliveryId, "sent", null);
        return resultSent(current, delivered.card.id, delivered.message?.id, delivered.replayed);
      } catch (error) {
        return failReleaseDelivery(current, error);
      }
    });
  }

  async function deliverRequirementProjection({ requirement, recipientId, cardType, input = {} }) {
    const key = `requirement:${requirement.id}:${recipientId}:${cardType}`;
    return withKeyLock(key, async () => {
      if (!await isHumanRecipient(recipientId)) return resultSkipped({ recipientUserId: recipientId }, "echo.recipient_ineligible");
      let conversation;
      try {
        conversation = await ensureEchoDirectConversation(recipientId, input);
      } catch (error) {
        return resultFailed({ recipientUserId: recipientId }, normalizeErrorCode(error));
      }
      let projection;
      try {
        projection = await projectRequirement(recipientId, requirement.publicId, cardType, input);
      } catch (error) {
        return resultFailed({ recipientUserId: recipientId }, normalizeErrorCode(error));
      }
      try {
        const delivered = await persistProjectionAndMessage({
          kind: cardType === ECHO_REQUIREMENT_STATUS_CARD_TYPE ? "requirement-status" : "requirement",
          resourceId: requirement.publicId,
          resourceInternalId: requirement.id,
          domainRevision: requirement.revision,
          recipientId,
          conversationId: conversation.id,
          projection,
          sourceKey: requirementSourceKey(requirement, recipientId, cardType),
          clientMessageId: requirementClientMessageId(requirement, recipientId, cardType),
          input
        });
        return resultSent({ recipientUserId: recipientId }, delivered.card.id, delivered.message?.id, delivered.replayed);
      } catch (error) {
        return resultFailed({ recipientUserId: recipientId }, normalizeErrorCode(error));
      }
    });
  }

  async function syncMember(userId, input = {}) {
    const recipientId = normalizeIdentifier(userId);
    if (!await isHumanRecipient(recipientId)) return { recipientId, solicitations: [], requirements: [], releases: [] };
    await ensureSolicitationDeliveryRowsForMember(recipientId);
    const solicitationRows = await loadSolicitationDeliveries(null, recipientId);
    const solicitations = [];
    for (const row of solicitationRows) {
      if (["open", "closed"].includes(row.status) || row.deliveryStatus !== "sent") {
        solicitations.push(await deliverSolicitationDelivery(row, input));
      }
    }
    const requirements = [];
    const requirementRows = await loadRequirementsForMember(recipientId);
    for (const requirement of requirementRows) {
      const recipients = await requirementRecipients(requirement, recipientId);
      for (const recipient of recipients) {
        const cardTypes = recipient.role === "owner"
          ? [ECHO_REQUIREMENT_CARD_TYPE]
          : [ECHO_REQUIREMENT_STATUS_CARD_TYPE];
        for (const cardType of cardTypes) {
          requirements.push(await deliverRequirementProjection({ requirement, recipientId, cardType, input }));
        }
      }
    }
    return { recipientId, solicitations, requirements, releases: [] };
  }

  async function recover(input = {}) {
    const summary = { solicitations: [], requirements: [], releases: [] };
    if (await hasTable("echo_solicitation_deliveries")) {
      const rows = await db.prepare(`
        SELECT d.id AS deliveryId
        FROM echo_solicitation_deliveries d
        INNER JOIN echo_solicitations s ON s.id = d.solicitation_id AND s.space_id = d.space_id
        WHERE d.space_id = ? AND (d.status IN ('pending', 'failed') OR s.status IN ('open', 'closed', 'withdrawn'))
        ORDER BY d.updated_at ASC, d.id ASC
        LIMIT ?
      `).all(spaceId, normalizeLimit(input.limit, 200));
      for (const candidate of rows) {
        const row = await readSolicitationDelivery(candidate.deliveryId);
        if (row) summary.solicitations.push(await deliverSolicitationDelivery(row, input));
      }
    }
    if (await hasTable("echo_requirements")) {
      const rows = await db.prepare(`
        SELECT public_id AS publicId
        FROM echo_requirements
        WHERE space_id = ?
        ORDER BY updated_at ASC, id ASC
        LIMIT ?
      `).all(spaceId, normalizeLimit(input.requirementLimit, 100));
      for (const row of rows) {
        try {
          summary.requirements.push(await syncRequirement({ publicId: row.publicId, ...input }));
        } catch (error) {
          summary.requirements.push({ publicId: row.publicId, status: "failed", errorCode: normalizeErrorCode(error) });
        }
      }
    }
    if (await hasTable("echo_release_deliveries")) {
      const rows = await db.prepare(`
        SELECT id AS deliveryId
        FROM echo_release_deliveries
        WHERE space_id = ? AND status IN ('pending', 'failed')
        ORDER BY updated_at ASC, id ASC
        LIMIT ?
      `).all(spaceId, normalizeLimit(input.releaseLimit, 200));
      for (const candidate of rows) {
        const row = await readReleaseDelivery(candidate.deliveryId);
        if (row) summary.releases.push(await deliverReleaseDelivery(row, input));
      }
    }
    return summary;
  }

  function startWorker(workerOptions = {}) {
    if (options.env?.WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED === "false"
      || options.enabled === false) {
      return { stop() {}, tick: async () => ({ skipped: true }) };
    }
    let stopped = false;
    let running = false;
    let interval;
    const tick = async () => {
      if (stopped || running) return { skipped: true };
      running = true;
      try {
        return await recover(workerOptions);
      } catch (error) {
        return { status: "failed", errorCode: normalizeErrorCode(error) };
      } finally {
        running = false;
      }
    };
    const delay = workerOptions.startupDelayMs ?? (options.env?.NODE_ENV === "test" ? 0 : 60_000);
    const timeout = setTimeout(() => {
      void tick();
      interval = setInterval(() => void tick(), workerOptions.intervalMs ?? 15_000);
      interval.unref?.();
    }, Math.max(0, Number(delay) || 0));
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

  async function handleWorkspaceEvent(event) {
    if (!event || typeof event !== "object") return null;
    const payload = parseJson(event.payloadJson ?? event.payload, {});
    if (event.type === "workspace.member_joined" || event.type === "workspace.member_updated") {
      const userId = payload.userId ?? event.targetId;
      return userId ? syncMember(userId) : null;
    }
    if ([
      "echo.solicitation.updated",
      "echo.solicitation.published",
      "echo.solicitation.closed",
      "echo.solicitation.withdrawn"
    ].includes(event.type)) {
      return syncSolicitation({ publicId: payload.publicId ?? event.targetId });
    }
    if ([
      "echo.requirement.updated",
      "echo.requirement.submitted",
      "echo.requirement.transitioned"
    ].includes(event.type)) {
      return syncRequirement({ publicId: payload.publicId ?? event.targetId });
    }
    return null;
  }

  return Object.freeze({
    deliverSolicitation: syncSolicitation,
    deliverSolicitationById: syncSolicitationById,
    deliverRequirement: syncRequirement,
    deliverRelease: syncRelease,
    syncSolicitation,
    syncSolicitationById,
    syncRequirement,
    syncRelease,
    syncMember,
    backfillMember: syncMember,
    recover,
    handleWorkspaceEvent,
    startWorker
  });

  async function ensureEchoDirectConversation(recipientId, input = {}) {
    const factory = typeof conversationFactory === "function"
      ? conversationFactory
      : conversationFactory?.ensureEchoDirectConversation
        ?? conversationFactory?.createOrGetDirectConversation
        ?? conversationFactory?.ensureDirectConversation
        ?? null;
    if (typeof factory === "function") {
      const provided = await factory.call(conversationFactory, {
        db,
        spaceId,
        actorId: ECHO_USER_ID,
        userId: recipientId,
        recipientUserId: recipientId,
        botUserId: ECHO_USER_ID,
        request: input.request
      });
      if (provided?.id) return provided;
    }
    const existing = await db.prepare(`
      SELECT c.id, c.type
      FROM conversations c
      INNER JOIN conversation_members recipient_cm ON recipient_cm.conversation_id = c.id
        AND recipient_cm.user_id = ? AND recipient_cm.removed_at IS NULL
      INNER JOIN conversation_members echo_cm ON echo_cm.conversation_id = c.id
        AND echo_cm.user_id = ? AND echo_cm.removed_at IS NULL
      WHERE c.space_id = ? AND c.type = 'direct' AND c.direct_key = ?
    `).get(recipientId, ECHO_USER_ID, spaceId, directKey(recipientId));
    if (existing) return { id: existing.id, type: existing.type, reused: true };

    const recipient = await db.prepare(`
      SELECT u.id, u.display_name AS displayName
      FROM users u
      INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ? AND sm.removed_at IS NULL
      WHERE u.id = ? AND u.kind = 'human'
    `).get(spaceId, recipientId);
    if (!recipient) throw new EchoDeliveryError("echo.recipient_ineligible", "收件人不属于空间", 404);
    const echo = await db.prepare(`
      SELECT u.id, u.display_name AS displayName, u.kind
      FROM users u
      INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ? AND sm.removed_at IS NULL
      WHERE u.id = ? AND u.kind = 'bot'
    `).get(spaceId, ECHO_USER_ID);
    if (!echo) throw new EchoDeliveryError("echo.identity_unavailable", "回声身份尚未初始化", 503);

    const create = async () => {
      const timestamp = toIso(now());
      const id = `conv_echo_${stableToken(recipientId)}`;
      const inserted = await db.prepare(`
        INSERT INTO conversations (
          id, space_id, type, title, direct_key, retention_count, created_by, created_at
        ) VALUES (?, ?, 'direct', ?, ?, 10000, ?, ?)
        ON CONFLICT (space_id, direct_key) DO NOTHING
      `).run(id, spaceId, `${echo.displayName}, ${recipient.displayName}`, directKey(recipientId), ECHO_USER_ID, timestamp);
      const winner = inserted.changes
        ? { id }
        : await db.prepare("SELECT id FROM conversations WHERE space_id = ? AND direct_key = ?").get(spaceId, directKey(recipientId));
      if (!winner?.id) throw new EchoDeliveryError("echo.conversation_unavailable", "回声会话创建失败");
      await db.prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL
      `).run(winner.id, recipientId, timestamp);
      await db.prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL
      `).run(winner.id, ECHO_USER_ID, timestamp);
      if (inserted.changes) {
        await writeWorkspaceEvent({
          type: "conversation.created",
          actorId: ECHO_USER_ID,
          conversationId: winner.id,
          targetType: "conversation",
          targetId: winner.id,
          payload: { conversationId: winner.id, type: "direct", memberIds: [recipientId, ECHO_USER_ID] }
        });
      }
      return { id: winner.id, type: "direct", reused: !inserted.changes };
    };
    if (typeof db.transaction === "function") return db.transaction(create);
    return create();
  }

  async function persistProjectionAndMessage(input) {
    const projection = normalizeProjection(input.projection, input.resourceId, input.kind);
    const card = await upsertCard({ ...input, projection });
    const messageContent = {
      format: "duallane.message+json;v=1",
      plainText: card.fallbackText,
      blocks: [{
        type: "card",
        cardId: card.id,
        cardType: card.cardType,
        schemaVersion: card.schemaVersion,
        fallbackText: card.fallbackText
      }]
    };
    const message = await writeBotMessage({
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      content: messageContent,
      plainText: card.fallbackText,
      recipientId: input.recipientId,
      request: input.input?.request
    });
    return { card, message, replayed: Boolean(message?.replayed) };
  }

  async function upsertCard(input) {
    const block = normalizeCardBlock({
      ...input.projection.block,
      cardId: input.cardId ?? `card_echo_${stableToken(input.sourceKey)}`,
      cardType: input.projection.block.cardType,
      schemaVersion: input.projection.block.schemaVersion,
      fallbackText: input.projection.block.fallbackText
    });
    const cardDefinition = typeof cardRegistry?.get === "function"
      ? cardRegistry.get(block.cardType, block.schemaVersion)
      : cardRegistry?.validatePayload
        ? true
        : null;
    const payload = cardDefinition && typeof cardRegistry?.validatePayload === "function"
      ? cardRegistry.validatePayload(block, input.projection.payload, { allowPublicUrls: true }).payload
      : normalizeCardPayload(input.projection.payload ?? {}, { allowPublicUrls: true });
    const sourceId = normalizeIdentifier(input.sourceKey);
    const timestamp = toIso(now());
    const requestedRevision = Math.max(
      1,
      Number(input.domainRevision ?? input.projection.payload?.revision) || 1
    );

    // Read the authoritative shared card first. This makes retries safe even
    // when a caller-provided card service has no update/upsert primitive.
    let existing;
    try {
      existing = await db.prepare(`
        SELECT id, card_type AS cardType, schema_version AS schemaVersion,
          payload_json AS payloadJson, fallback_text AS fallbackText,
          revision, status, conversation_id AS conversationId
        FROM workspace_cards
        WHERE space_id = ? AND source_kind = ? AND source_id = ? AND card_type = ?
      `).get(spaceId, ECHO_DELIVERY_SOURCE_KIND, sourceId, block.cardType);
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
    if (existing) {
      let cardRevision = Number(existing.revision) || 1;
      const samePayload = stableJson(parseJson(existing.payloadJson, {})) === stableJson(payload)
        && existing.fallbackText === block.fallbackText
        && existing.conversationId === input.conversationId
        && Number(existing.revision) >= requestedRevision;
      if (!samePayload || existing.status !== "active") {
        cardRevision = Math.max(cardRevision + 1, requestedRevision);
        await db.prepare(`
          UPDATE workspace_cards
          SET conversation_id = ?, payload_json = ?, fallback_text = ?, status = 'active',
            revision = ?, resource_type = ?, resource_id = ?, visibility_scope = 'conversation',
            created_by_user_id = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.conversationId,
          JSON.stringify(payload),
          block.fallbackText,
          cardRevision,
          input.resourceType ?? resourceTypeFor(input.kind),
          input.resourceId ?? input.resourceInternalId ?? null,
          ECHO_USER_ID,
          timestamp,
          existing.id
        );
        await writeWorkspaceEvent({
          type: "card.updated",
          conversationId: input.conversationId,
          targetType: "workspace.card",
          targetId: existing.id,
          actorId: ECHO_USER_ID,
          payload: { cardId: existing.id, cardType: block.cardType, revision: cardRevision, status: "active" }
        });
      }
      return {
        id: existing.id,
        cardType: block.cardType,
        schemaVersion: block.schemaVersion,
        fallbackText: block.fallbackText,
        revision: cardRevision,
        replayed: samePayload && existing.status === "active"
      };
    }

    if (typeof cardService?.upsertEchoCard === "function") {
      const trusted = await cardService.upsertEchoCard({
        spaceId,
        conversationId: input.conversationId,
        card: block,
        payload,
        sourceKind: ECHO_DELIVERY_SOURCE_KIND,
        sourceId: normalizeIdentifier(input.sourceKey),
        resourceType: input.resourceType ?? resourceTypeFor(input.kind),
        resourceId: input.resourceId ?? input.resourceInternalId ?? null,
        visibilityScope: "conversation",
        createdByUserId: ECHO_USER_ID
      });
      if (trusted?.id || trusted?.block?.cardId) return projectTrustedCard(trusted, block);
    }

    // The shared service is optional during rolling migration. When present,
    // let it validate and emit its normal card.created event before falling
    // back to the strict SQL authority used by recovery and focused tests.
    const createCard = cardService?.createEchoCard
      ?? cardService?.createTrustedEchoCard
      ?? cardService?.createCard;
    if (typeof createCard === "function") {
      try {
        const trusted = await createCard.call(cardService, {
          spaceId,
          conversationId: input.conversationId,
          card: block,
          cardType: block.cardType,
          schemaVersion: block.schemaVersion,
          fallbackText: block.fallbackText,
          payload,
          sourceKind: ECHO_DELIVERY_SOURCE_KIND,
          sourceId,
          resourceType: input.resourceType ?? resourceTypeFor(input.kind),
          resourceId: input.resourceId ?? input.resourceInternalId ?? null,
          visibilityScope: "conversation",
          createdByUserId: ECHO_USER_ID,
          trustedEcho: true,
          allowUnknownDefinition: true
        });
        if (trusted?.id || trusted?.block?.cardId) return projectTrustedCard(trusted, block);
      } catch (error) {
        // Unknown-version/card unavailable errors are safe to handle with the
        // SQL fallback. Authorization and source conflicts must surface.
        if (!isRecoverableCardServiceError(error)) throw error;
      }
    }

    const id = block.cardId;
    const inserted = await db.prepare(`
      INSERT INTO workspace_cards (
        id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text,
        source_kind, source_id, resource_type, resource_id, visibility_scope,
        created_by_user_id, status, revision, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'echo', ?, ?, ?, 'conversation', ?, 'active', ?, NULL, ?, ?)
      ON CONFLICT (space_id, source_kind, source_id, card_type) DO NOTHING
    `).run(
      id,
      spaceId,
      input.conversationId,
      block.cardType,
      block.schemaVersion,
      JSON.stringify(payload),
      block.fallbackText,
      sourceId,
      input.resourceType ?? resourceTypeFor(input.kind),
      input.resourceId ?? input.resourceInternalId ?? null,
      ECHO_USER_ID,
       requestedRevision,
      timestamp,
      timestamp
    );
    const stored = await db.prepare(`
      SELECT id, card_type AS cardType, schema_version AS schemaVersion,
        fallback_text AS fallbackText, revision
      FROM workspace_cards WHERE space_id = ? AND source_kind = 'echo' AND source_id = ? AND card_type = ?
    `).get(spaceId, sourceId, block.cardType);
    if (!stored) throw new EchoDeliveryError("echo.card_unavailable", "卡片写入失败");
    if (inserted.changes > 0) {
      await writeWorkspaceEvent({
        type: "card.created",
        conversationId: input.conversationId,
        targetType: "workspace.card",
        targetId: stored.id,
        actorId: ECHO_USER_ID,
        payload: { cardId: stored.id, cardType: stored.cardType, revision: Number(stored.revision) || 1, status: "active" }
      });
    }
    return { ...stored, replayed: stored.id !== id };
  }

  async function writeBotMessage(input) {
    const writer = typeof messageWriter === "function"
      ? messageWriter
      : messageWriter?.createEchoMessage
        ?? messageWriter?.createBotMessage
        ?? messageWriter?.writeBotMessage
        ?? messageWriter?.createStructuredMessage
        ?? null;
    if (typeof writer === "function") {
      const result = await writer.call(messageWriter, {
        ...input,
        actorId: ECHO_USER_ID,
        authorId: ECHO_USER_ID,
        botUserId: ECHO_USER_ID,
        request: { ...(input.request ?? {}), echoDelivery: true, botIdentity: ECHO_USER_ID },
        scheduleEmailNotifications,
        scheduleNtfyNotifications
      });
      if (result?.authorId && result.authorId !== ECHO_USER_ID) {
        throw new EchoDeliveryError("echo.identity_mismatch", "Echo 消息身份无效", 500);
      }
      return result;
    }
    const contentJson = JSON.stringify(input.content);
    const timestamp = toIso(now());
    const existing = await db.prepare(`
      SELECT id, content_json AS contentJson, created_at AS createdAt
      FROM messages
      WHERE space_id = ? AND conversation_id = ? AND author_id = ? AND client_message_id = ?
    `).get(spaceId, input.conversationId, ECHO_USER_ID, input.clientMessageId);
    if (existing) {
      if (existing.contentJson !== contentJson) {
        throw new EchoDeliveryError("echo.message_idempotency_conflict", "Echo 消息幂等键内容不一致", 409);
      }
      return { id: existing.id, createdAt: existing.createdAt, replayed: true };
    }
    const create = async () => {
      const id = `msg_echo_${stableToken(`${input.conversationId}:${input.clientMessageId}`)}`;
      const inserted = await db.prepare(`
        INSERT INTO messages (
          id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
          content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at
        ) VALUES (?, ?, ?, ?, 'bot', 'bot', ?, 'duallane.message+json;v=1', ?, ?, NULL, ?, NULL, NULL)
        ON CONFLICT (space_id, conversation_id, author_id, client_message_id) DO NOTHING
      `).run(id, spaceId, input.conversationId, ECHO_USER_ID, input.clientMessageId, contentJson, input.plainText, timestamp);
      if (!inserted.changes) {
        const winner = await db.prepare(`
          SELECT id, content_json AS contentJson, created_at AS createdAt
          FROM messages WHERE space_id = ? AND conversation_id = ? AND author_id = ? AND client_message_id = ?
        `).get(spaceId, input.conversationId, ECHO_USER_ID, input.clientMessageId);
        if (!winner || winner.contentJson !== contentJson) throw new EchoDeliveryError("echo.message_idempotency_conflict", "Echo 消息幂等键内容不一致", 409);
        return { id: winner.id, createdAt: winner.createdAt, replayed: true };
      }
      const event = await writeWorkspaceEvent({
        type: "message.created",
        actorId: ECHO_USER_ID,
        conversationId: input.conversationId,
        targetType: "message",
        targetId: id,
        payload: {
          messageId: id,
          conversationId: input.conversationId,
          message: { id, conversationId: input.conversationId, authorId: ECHO_USER_ID, authorKind: "bot", kind: "bot", clientMessageId: input.clientMessageId, content: input.content, plainText: input.plainText, createdAt: timestamp }
        }
      });
      await scheduleEmailNotifications?.({
        authorId: ECHO_USER_ID,
        conversationId: input.conversationId,
        messageId: id,
        eventSeq: event.seq,
        content: input.content,
        createdAt: timestamp
      });
      await scheduleNtfyNotifications?.({
        authorId: ECHO_USER_ID,
        conversationId: input.conversationId,
        messageId: id,
        eventSeq: event.seq,
        content: input.content,
        createdAt: timestamp
      });
      return { id, createdAt: timestamp, replayed: false };
    };
    return typeof db.transaction === "function" ? db.transaction(create) : create();
  }

  async function writeWorkspaceEvent(event) {
    const timestamp = toIso(now());
    let row;
    try {
      row = await db.prepare(`
        INSERT INTO workspace_event_cursors (space_id, next_seq)
        VALUES (?, 1)
        ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1
        RETURNING next_seq - 1 AS nextSeq
      `).get(spaceId);
      const seq = Number(row?.nextSeq) || 1;
      const id = event.id ?? `evt_echo_${randomUUID()}`;
      await db.prepare(`
        INSERT INTO workspace_events (
          id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, spaceId, seq, event.type, event.actorId ?? null, event.conversationId ?? null, event.targetType ?? null, event.targetId ?? null, JSON.stringify(event.payload ?? {}), timestamp);
      const written = { id, seq, spaceId, type: event.type, conversationId: event.conversationId ?? null, targetId: event.targetId ?? null };
      try {
        await eventPublisher?.(written);
      } catch {
        // Realtime fanout is best effort; the persisted event remains the
        // recovery source for reconnecting clients.
      }
      return written;
    } catch (error) {
      if (isMissingTableError(error)) return null;
      throw error;
    }
  }

  async function projectSolicitation(recipientId, publicId, input) {
    if (solicitationService?.projectCard) {
      return solicitationService.projectCard({ actorId: recipientId, spaceId, publicId, request: input.request });
    }
    const row = await db.prepare(`
      SELECT id, public_id AS publicId, title, description, question, status, revision, deadline,
        choice_mode AS choiceMode, min_selections AS minSelections, max_selections AS maxSelections,
        allow_vote_change AS allowVoteChange
      FROM echo_solicitations WHERE space_id = ? AND public_id = ?
    `).get(spaceId, publicId);
    if (!row) throw new EchoDeliveryError("echo.solicitation_not_found", "征集不存在", 404);
    const options = await db.prepare("SELECT id, label, position FROM echo_solicitation_options WHERE solicitation_id = ? ORDER BY position").all(row.id);
    return {
      block: { type: "card", cardId: `echo_sol_${publicId.toLowerCase()}`, cardType: ECHO_SOLICITATION_CARD_TYPE, schemaVersion: 1, fallbackText: `回声征集 ${publicId}: ${row.title}` },
      payload: { publicId, title: row.title, description: row.description, question: row.question, status: row.status, revision: Number(row.revision), deadline: row.deadline ?? null, choiceMode: row.choiceMode, minSelections: Number(row.minSelections), maxSelections: Number(row.maxSelections), allowVoteChange: Boolean(row.allowVoteChange), options: options.map((option) => ({ id: option.id, label: option.label, position: Number(option.position), count: null })), selectedOptionIds: [], owner: false, voteCount: null }
    };
  }

  async function projectRequirement(recipientId, publicId, cardType, input) {
    if (requirementService?.projectCard) {
      return requirementService.projectCard({ actorId: recipientId, spaceId, publicId, cardType, request: input.request });
    }
    const row = await db.prepare(`
      SELECT public_id AS publicId, submitter_user_id AS submitterUserId, type, title, detail, scenario,
        expected_result AS expectedResult, related_link AS relatedLink, state, phase, status,
        archive_outcome AS archiveOutcome, duplicate_of_public_id AS duplicateOfPublicId, revision, response,
        created_at AS createdAt, updated_at AS updatedAt
      FROM echo_requirements WHERE space_id = ? AND public_id = ?
    `).get(spaceId, publicId);
    if (!row || (recipientId !== row.submitterUserId && !await isOwner(recipientId))) {
      throw new EchoDeliveryError("echo.requirement_not_found", "需求不存在", 404);
    }
    const payload = { publicId, type: row.type, title: row.title, detail: row.detail, scenario: row.scenario, expectedResult: row.expectedResult, relatedLink: row.relatedLink, state: row.state, phase: row.phase, status: row.status, archiveOutcome: row.archiveOutcome, duplicateOfPublicId: row.duplicateOfPublicId, revision: Number(row.revision), response: row.response, createdAt: row.createdAt, updatedAt: row.updatedAt };
    return { block: { type: "card", cardId: `echo_req_${publicId.toLowerCase()}`, cardType, schemaVersion: 1, fallbackText: `回声需求 ${publicId}` }, payload };
  }

  async function requirementRecipients(requirement, onlyUserId = null) {
    const recipients = [];
    if (requirement.submitterUserId && (!onlyUserId || onlyUserId === requirement.submitterUserId)) {
      recipients.push({ id: requirement.submitterUserId, role: await isOwner(requirement.submitterUserId) ? "owner" : "submitter" });
    }
    if (!onlyUserId || onlyUserId !== requirement.submitterUserId) {
      const owners = await db.prepare(`
        SELECT sm.user_id AS id, sm.role
        FROM space_members sm INNER JOIN users u ON u.id = sm.user_id
        WHERE sm.space_id = ? AND sm.removed_at IS NULL AND u.kind = 'human' AND sm.role = 'owner'
      `).all(spaceId);
      recipients.push(...owners);
    }
    return recipients.filter((recipient, index, all) => all.findIndex((candidate) => candidate.id === recipient.id) === index);
  }

  async function loadRequirement(publicId) {
    if (!(await hasTable("echo_requirements"))) return null;
    return db.prepare(`
      SELECT id, public_id AS publicId, submitter_user_id AS submitterUserId,
        state, phase, status, revision, response, created_at AS createdAt, updated_at AS updatedAt
      FROM echo_requirements WHERE space_id = ? AND public_id = ?
    `).get(spaceId, publicId);
  }

  async function loadRequirementsForMember(recipientId) {
    const rows = [];
    if (!(await hasTable("echo_requirements"))) return rows;
    const owner = await isOwner(recipientId);
    const query = owner
      ? "SELECT public_id AS publicId FROM echo_requirements WHERE space_id = ? ORDER BY updated_at ASC, id ASC LIMIT 100"
      : "SELECT public_id AS publicId FROM echo_requirements WHERE space_id = ? AND submitter_user_id = ? ORDER BY updated_at ASC, id ASC LIMIT 100";
    const result = owner ? await db.prepare(query).all(spaceId) : await db.prepare(query).all(spaceId, recipientId);
    for (const item of result) {
      const row = await loadRequirement(item.publicId);
      if (row) rows.push(row);
    }
    return rows;
  }

  async function isOwner(userId) {
    const row = await db.prepare(`
      SELECT 1 AS present FROM space_members
      WHERE space_id = ? AND user_id = ? AND role = 'owner' AND removed_at IS NULL
    `).get(spaceId, userId);
    return Boolean(row);
  }

  async function isHumanRecipient(userId) {
    const row = await db.prepare(`
      SELECT 1 AS present FROM users u INNER JOIN space_members sm ON sm.user_id = u.id
      WHERE u.id = ? AND u.kind = 'human' AND sm.space_id = ? AND sm.removed_at IS NULL
    `).get(userId, spaceId);
    return Boolean(row);
  }

  async function loadSolicitationDeliveries(publicId = null, recipientId = null) {
    if (!(await hasTable("echo_solicitation_deliveries"))) return [];
    const where = ["d.space_id = ?"];
    const values = [spaceId];
    if (publicId) { where.push("s.public_id = ?"); values.push(publicId); }
    if (recipientId) { where.push("d.recipient_user_id = ?"); values.push(recipientId); }
    const rows = await db.prepare(`
      SELECT d.id AS deliveryId, d.solicitation_id AS solicitationId,
        d.recipient_user_id AS recipientUserId, d.status AS deliveryStatus,
        d.attempt_count AS attemptCount, d.last_error_code AS lastErrorCode,
        d.delivered_at AS deliveredAt, d.created_at AS createdAt, d.updated_at AS updatedAt,
        s.public_id AS publicId, s.status, s.revision, s.delivery_policy AS deliveryPolicy
      FROM echo_solicitation_deliveries d
      INNER JOIN echo_solicitations s ON s.id = d.solicitation_id AND s.space_id = d.space_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.created_at ASC, d.id ASC
    `).all(...values);
    return rows.map(normalizeSolicitationDelivery);
  }

  async function loadReleaseDeliveries(version = null, recipientId = null) {
    if (!(await hasTable("echo_release_deliveries"))) return [];
    const where = ["d.space_id = ?"];
    const values = [spaceId];
    if (version) { where.push("p.version = ?"); values.push(version); }
    if (recipientId) { where.push("d.recipient_user_id = ?"); values.push(normalizeIdentifier(recipientId)); }
    const rows = await db.prepare(`
      SELECT d.id AS deliveryId, d.publication_id AS publicationId,
        d.recipient_user_id AS recipientUserId, d.status AS deliveryStatus,
        d.attempt_count AS attemptCount, d.last_error_code AS lastErrorCode,
        d.delivered_at AS deliveredAt, d.created_at AS createdAt, d.updated_at AS updatedAt,
        p.version, p.published_at AS publishedAt
      FROM echo_release_deliveries d
      INNER JOIN echo_release_publications p ON p.id = d.publication_id AND p.space_id = d.space_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.created_at ASC, d.id ASC
    `).all(...values);
    return rows.map((row) => ({
      ...row,
      attemptCount: Number(row.attemptCount) || 0
    }));
  }

  async function readReleaseDelivery(deliveryId) {
    const rows = await loadReleaseDeliveries();
    return rows.find((row) => row.deliveryId === deliveryId) ?? null;
  }

  async function markReleaseDelivery(deliveryId, status, errorCode) {
    const timestamp = toIso(now());
    await db.prepare(`
      UPDATE echo_release_deliveries
      SET status = ?, attempt_count = attempt_count + 1, last_error_code = ?,
        delivered_at = CASE WHEN ? = 'sent' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
        updated_at = ?
      WHERE id = ? AND space_id = ?
    `).run(status, errorCode ? String(errorCode).slice(0, 128) : null, status, timestamp, timestamp, deliveryId, spaceId);
  }

  async function failReleaseDelivery(row, error) {
    const code = normalizeErrorCode(error);
    await markReleaseDelivery(row.deliveryId, "failed", code);
    return resultFailed(row, code);
  }

  async function findReleaseDeliveryCard(row) {
    try {
      return await db.prepare(`
        SELECT id AS cardId, revision
        FROM workspace_cards
        WHERE space_id = ? AND source_kind = 'echo' AND source_id = ? AND card_type = ?
      `).get(spaceId, releaseSourceKey(row, row.recipientUserId), ECHO_RELEASE_CARD_TYPE);
    } catch (error) {
      if (isMissingTableError(error)) return null;
      throw error;
    }
  }

  async function readSolicitationDelivery(deliveryId) {
    const rows = await loadSolicitationDeliveries();
    return rows.find((row) => row.deliveryId === deliveryId) ?? null;
  }

  async function ensureSolicitationDeliveryRows(publicId) {
    if (!(await hasTable("echo_solicitation_deliveries"))) return;
    const row = await db.prepare("SELECT id, status, delivery_policy AS deliveryPolicy FROM echo_solicitations WHERE space_id = ? AND public_id = ?").get(spaceId, publicId);
    if (!row || row.deliveryPolicy === "none") return;
    const recipients = await db.prepare(`
      SELECT sm.user_id AS userId FROM space_members sm INNER JOIN users u ON u.id = sm.user_id
      WHERE sm.space_id = ? AND sm.removed_at IS NULL AND u.kind = 'human'
    `).all(spaceId);
    const timestamp = toIso(now());
    for (const recipient of recipients) {
      await db.prepare(`
        INSERT INTO echo_solicitation_deliveries (
          id, space_id, solicitation_id, recipient_user_id, status, attempt_count,
          last_error_code, delivered_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
        ON CONFLICT (solicitation_id, recipient_user_id) DO NOTHING
      `).run(`echo_sol_delivery_${randomUUID()}`, spaceId, row.id, recipient.userId, timestamp, timestamp);
    }
  }

  async function ensureSolicitationDeliveryRowsForMember(recipientId) {
    if (!(await hasTable("echo_solicitation_deliveries")) || !(await hasTable("echo_solicitations"))) return;
    const rows = await db.prepare(`
      SELECT id, status, delivery_policy AS deliveryPolicy
      FROM echo_solicitations
      WHERE space_id = ? AND status = 'open' AND delivery_policy <> 'none'
    `).all(spaceId);
    const timestamp = toIso(now());
    for (const row of rows) {
      await db.prepare(`
        INSERT INTO echo_solicitation_deliveries (
          id, space_id, solicitation_id, recipient_user_id, status, attempt_count,
          last_error_code, delivered_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
        ON CONFLICT (solicitation_id, recipient_user_id) DO NOTHING
      `).run(`echo_sol_delivery_${randomUUID()}`, spaceId, row.id, recipientId, timestamp, timestamp);
    }
  }

  async function markSolicitationDelivery(deliveryId, status, errorCode) {
    if (!(await hasTable("echo_solicitation_deliveries"))) return;
    const timestamp = toIso(now());
    if (typeof solicitationService?.markDelivery === "function") {
      await solicitationService.markDelivery({
        spaceId,
        deliveryId,
        status,
        errorCode: errorCode ?? null,
        now: timestamp
      });
      return;
    }
    await db.prepare(`
      UPDATE echo_solicitation_deliveries
      SET status = ?, attempt_count = attempt_count + 1, last_error_code = ?,
        delivered_at = CASE WHEN ? = 'sent' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
        updated_at = ?
      WHERE id = ? AND space_id = ?
    `).run(status, errorCode ? String(errorCode).slice(0, 128) : null, status, timestamp, timestamp, deliveryId, spaceId);
  }

  async function failSolicitationDelivery(row, error) {
    const code = normalizeErrorCode(error);
    await markSolicitationDelivery(row.deliveryId, "failed", code);
    return resultFailed(row, code);
  }

  async function findDeliveryCard(row) {
    const recipientId = row.recipientUserId;
    const sourceId = solicitationSourceKey(row, recipientId);
    let card;
    try {
      card = await db.prepare(`
        SELECT id AS cardId, revision, payload_json AS payloadJson
        FROM workspace_cards
        WHERE space_id = ? AND source_kind = 'echo' AND source_id = ? AND card_type = ?
      `).get(spaceId, sourceId, ECHO_SOLICITATION_CARD_TYPE);
    } catch (error) {
      if (isMissingTableError(error)) return null;
      throw error;
    }
    if (!card) return null;
    let payload = parseJson(card.payloadJson, {});
    return { ...card, domainRevision: Math.max(Number(payload.revision) || 0, Number(card.revision) || 0) };
  }

  function normalizeProjection(projection, resourceId, kind) {
    if (!projection || typeof projection !== "object") throw new EchoDeliveryError("echo.card_projection_invalid", "Echo 卡片投影无效", 422);
    const block = projection.block ?? projection.card ?? projection;
    const payload = projection.payload ?? {};
    if (!block || typeof block !== "object") throw new EchoDeliveryError("echo.card_projection_invalid", "Echo 卡片引用无效", 422);
    const defaultFallback = kind === "release"
      ? `DualLane v${resourceId} 版本更新`
      : kind === "requirement-status"
      ? `回声需求 ${resourceId} 状态已更新`
      : `回声${kind === "solicitation" ? "征集" : "需求"} ${resourceId}`;
    // Requirement bodies are private. Keep their message fallback metadata
    // based on the stable public ID even if a projector returns a verbose
    // fallback intended only for an in-app card renderer.
    const fallbackText = kind === "requirement" || kind === "requirement-status"
      ? defaultFallback
      : typeof block.fallbackText === "string" && block.fallbackText.trim()
        ? block.fallbackText.trim()
        : defaultFallback;
    return {
      block: { type: "card", cardId: block.cardId, cardType: block.cardType, schemaVersion: block.schemaVersion, fallbackText },
      payload
    };
  }

  function solicitationSourceKey(row, recipientId) {
    return `sol:${row.solicitationId}:${recipientId}`;
  }

  function solicitationClientMessageId(row, recipientId) {
    // One immutable message per domain revision. The card itself is reused,
    // so a status refresh updates all historical references without duplicate
    // messages; a new revision still produces a visible event.
    return `echo:sol:${row.solicitationId}:${recipientId}:r${Number(row.revision) || 1}`;
  }

  function requirementSourceKey(requirement, recipientId, cardType) {
    return `req:${requirement.id}:${recipientId}:${cardType}`;
  }

  function requirementClientMessageId(requirement, recipientId, cardType) {
    return `echo:req:${requirement.id}:${recipientId}:${cardType}:r${Number(requirement.revision) || 1}`;
  }

  function releaseSourceKey(row, recipientId) {
    return `release:${row.publicationId}:${recipientId}`;
  }

  function releaseClientMessageId(row, recipientId) {
    return `echo:release:${row.publicationId}:${recipientId}`;
  }

  function directKey(userId) {
    return [ECHO_USER_ID, userId].sort().join(":");
  }

  function resourceTypeFor(kind) {
    if (kind === "solicitation") return "echo.solicitation";
    if (kind === "requirement" || kind === "requirement-status") return "echo.requirement";
    if (kind === "release") return "echo.release";
    return "echo";
  }

  function projectTrustedCard(value, fallbackBlock) {
    const block = value?.block ?? {};
    const id = value?.id ?? block.cardId;
    const cardType = value?.cardType ?? block.cardType ?? fallbackBlock.cardType;
    const schemaVersion = Number(value?.schemaVersion ?? block.schemaVersion ?? fallbackBlock.schemaVersion);
    const fallbackText = value?.fallbackText ?? block.fallbackText ?? fallbackBlock.fallbackText;
    if (!id || !cardType || !Number.isSafeInteger(schemaVersion) || !fallbackText) {
      throw new EchoDeliveryError("echo.card_unavailable", "卡片写入失败");
    }
    // Never return a service payload here. Callers only need the immutable
    // message reference; domain bodies remain in the card authority.
    return {
      id: String(id),
      cardType: String(cardType),
      schemaVersion,
      fallbackText: String(fallbackText),
      revision: Number(value?.revision) || 1,
      replayed: Boolean(value?.replayed)
    };
  }

  function isRecoverableCardServiceError(error) {
    return ["card.unknown_version", "card.unavailable", "card.not_found", "echo.card_unavailable"].includes(error?.code)
      || isMissingTableError(error);
  }

  function resultSent(row, cardId, messageId, replayed) {
    // Delivery results are operational metadata only. Do not echo the
    // actor-filtered card payload or writer response into route/event logs.
    return { status: "sent", deliveryId: row.deliveryId, recipientUserId: row.recipientUserId, cardId: cardId ?? null, messageId: messageId ?? null, replayed: Boolean(replayed) };
  }

  function resultFailed(row, code) {
    return { status: "failed", deliveryId: row.deliveryId, recipientUserId: row.recipientUserId, errorCode: code };
  }

  function resultSkipped(row, code) {
    return { status: "skipped", deliveryId: row.deliveryId, recipientUserId: row.recipientUserId, errorCode: code };
  }

  function summarizeResults(results, type, publicId) {
    return {
      type,
      ...(type === "release" ? { version: publicId } : { publicId }),
      results,
      sent: results.filter((item) => item.status === "sent").length,
      failed: results.filter((item) => item.status === "failed").length,
      skipped: results.filter((item) => item.status === "skipped").length
    };
  }

  function normalizeSolicitationDelivery(row) {
    return {
      ...row,
      deliveryStatus: row.deliveryStatus ?? row.status,
      status: row.status,
      attemptCount: Number(row.attemptCount) || 0,
      revision: Number(row.revision) || 1
    };
  }

  function normalizeReleaseVersion(value) {
    const match = typeof value === "string" ? value.trim().match(/^(?:v)?(\d+\.\d+\.\d+)$/i) : null;
    if (!match) throw new EchoDeliveryError("echo.release_version_invalid", "版本号无效", 422);
    return match[1];
  }

  function isRetryDue(row, current) {
    if (row.deliveryStatus !== "failed") return true;
    const attempt = Number(row.attemptCount) || 0;
    if (attempt >= maxAttempts) return false;
    const delay = retryDelaysMs[Math.max(0, attempt - 1)] ?? 0;
    const currentTime = current instanceof Date ? current.getTime() : Date.parse(current ?? "");
    return Date.parse(row.updatedAt ?? 0) + delay <= (Number.isFinite(currentTime) ? currentTime : Date.now());
  }

  async function hasTable(name) {
    try {
      if (db.constructor?.name?.toLowerCase().includes("sqlite")) {
        return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
      }
      await db.prepare(`SELECT 1 FROM ${quoteIdentifier(name)} LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  }

  function parseJson(value, fallback) {
    try { return typeof value === "string" ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }

  function normalizeErrorCode(error) {
    return typeof error?.code === "string" && error.code ? error.code : "echo.delivery_failed";
  }

  function normalizeIdentifier(value) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw new EchoDeliveryError("echo.identifier_invalid", "Echo 标识无效", 400);
    return normalized;
  }

  function normalizePublicId(value) {
    const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (!/^SOL-\d{4}-\d{4}$/.test(normalized)) throw new EchoDeliveryError("echo.solicitation_id_invalid", "征集编号无效", 400);
    return normalized;
  }

  function normalizeRequirementPublicId(value) {
    const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (!/^REQ-\d{4}-\d{4}$/.test(normalized)) throw new EchoDeliveryError("echo.requirement_id_invalid", "需求编号无效", 400);
    return normalized;
  }

  function normalizeLimit(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? Math.min(number, fallback) : fallback;
  }

  function toIso(value) {
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    if (!Number.isFinite(date.getTime())) return new Date().toISOString();
    return date.toISOString();
  }

  function stableToken(value) {
    // IDs are opaque and bounded; keeping a readable prefix helps operators
    // inspect rows without exposing card payloads in logs.
    return String(value).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 96) || randomUUID();
  }

  function quoteIdentifier(value) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("invalid identifier");
    return `\"${value}\"`;
  }

  function isMissingTableError(error) {
    return /(?:no such table|does not exist|undefined table)/i.test(String(error?.message ?? ""));
  }
}

export const createEchoDeliveryCoordinator = createEchoDeliveryService;
