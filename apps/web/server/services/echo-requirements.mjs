import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { writeAudit } from "./audit.mjs";
import {
  CardValidationError,
  createCardRegistry,
  normalizeCardPayload
} from "./workspace-cards.mjs";
import { createEchoSolicitationService as createEchoSolicitationDomainService } from "./echo-solicitations.mjs";

export const ECHO_REQUIREMENT_STATES = Object.freeze([
  "submitted",
  "collected",
  "in_progress",
  "implemented",
  "rejected"
]);
export const ECHO_REQUIREMENT_PHASES = Object.freeze(["proposal", "formal", "archived"]);
export const ECHO_REQUIREMENT_STATUSES = Object.freeze([
  "pending_review",
  "planned",
  "in_progress",
  "delivered",
  "archived"
]);
export const ECHO_REQUIREMENT_ARCHIVE_OUTCOMES = Object.freeze([
  "implemented",
  "rejected",
  "duplicate",
  "withdrawn",
  "cancelled"
]);
export const ECHO_REQUIREMENT_TYPES = Object.freeze([
  "requirement",
  "suggestion",
  "problem"
]);
export const ECHO_REQUIREMENT_CARD_TYPES = Object.freeze([
  "echo.request",
  "echo.request-status",
  "echo.request-list"
]);

export const ECHO_REQUIREMENT_LIMITS = Object.freeze({
  titleCodePoints: 120,
  titleBytes: 512,
  bodyCodePoints: 10_000,
  bodyBytes: 64 * 1024,
  responseCodePoints: 4_000,
  responseBytes: 32 * 1024,
  relatedLinkBytes: 2_048,
  idempotencyKeyBytes: 128,
  listLimit: 100
});

const TRANSITIONS = new Map([
  ["submitted", new Set(["collected", "rejected"])],
  ["collected", new Set(["in_progress", "implemented", "rejected"])],
  ["in_progress", new Set(["implemented", "rejected"])],
  ["implemented", new Set()],
  ["rejected", new Set()]
]);
const PRIVATE_HOST_PATTERN = /^(?:localhost(?:\.local)?|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

export class EchoRequirementError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "EchoRequirementError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class EchoRequirementNotFoundError extends EchoRequirementError {
  constructor() {
    super("echo.requirement_not_found", "需求不存在", 404);
    this.name = "EchoRequirementNotFoundError";
  }
}

export class EchoRequirementPermissionError extends EchoRequirementNotFoundError {
  constructor() {
    super();
    this.name = "EchoRequirementPermissionError";
  }
}

export class EchoRequirementConflictError extends EchoRequirementError {
  constructor(code, message) {
    super(code, message, 409);
    this.name = "EchoRequirementConflictError";
  }
}

/**
 * The Echo requirements service is intentionally independent from route and
 * message delivery code. Route handlers should pass the authenticated actor
 * id and return the already permission-filtered result from these methods.
 */
export function createEchoRequirementService({ db, spaceId = DEFAULT_SPACE_ID, now = () => new Date() }) {
  if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
    throw new TypeError("Echo requirements require a database adapter");
  }

  return Object.freeze({
    submit: (input) => submitRequirement(db, { ...input, spaceId, now: now() }),
    get: (input) => getRequirement(db, { ...input, spaceId }),
    list: (input) => listRequirements(db, { ...input, spaceId }),
    listPage: (input) => listRequirementPage(db, { ...input, spaceId }),
    stats: (input) => requirementStats(db, { ...input, spaceId }),
    history: (input) => listRequirementHistory(db, { ...input, spaceId }),
    transition: (input) => transitionRequirement(db, { ...input, spaceId, now: now() }),
    projectEvent: (input) => projectEchoRequirementEvent(db, { ...input, spaceId }),
    projectCard: (input) => projectEchoRequirementCard(db, { ...input, spaceId }),
    projectListCard: (input) => projectEchoRequirementListCard(db, { ...input, spaceId })
  });
}

export async function submitRequirement(db, input) {
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  return await withRejectionAudit(db, input, actor, spaceId, "echo.requirement.submit", async () => {
    if (actor.role === "auditor") {
      throwRejected(
        new EchoRequirementError("echo.permission_denied", "审计角色不能提交需求", 403),
        auditDetails("echo.requirement.submit", null, "permission.denied")
      );
    }
    const normalized = normalizeSubmission(input);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const requestHash = hashRequest({ spaceId, actorId: actor.id, ...normalized });
    const timestamp = asIsoTimestamp(input.now);
    return await db.transaction(async () => {
      await advisoryLock(db, `echo-requirement-sequence:${spaceId}:${timestamp.slice(0, 4)}`);
      const existing = await getIdempotency(db, spaceId, actor.id, "submit", idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throwRejected(
            new EchoRequirementConflictError("echo.idempotency_conflict", "幂等键已用于其他提交"),
            auditDetails("echo.requirement.submit", null, "echo.idempotency_conflict")
          );
        }
        const replay = await replayRequirementResult(db, existing, actor, spaceId);
        if (replay) return replay;
    }

    const sequenceYear = Number(timestamp.slice(0, 4));
    const number = await nextRequirementNumber(db, spaceId, sequenceYear);
    const publicId = `REQ-${sequenceYear}-${String(number).padStart(4, "0")}`;
    const id = `echo_req_${randomUUID()}`;
    await db.prepare(`
      INSERT INTO echo_requirements (
        id, public_id, space_id, submitter_user_id, type, title, detail,
        scenario, expected_result, related_link, state, phase, status, archive_outcome,
        revision, response,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 'proposal', 'pending_review', NULL, 1, NULL, ?, ?)
    `).run(
      id,
      publicId,
      spaceId,
      actor.id,
      normalized.type,
      normalized.title,
      normalized.detail,
      normalized.scenario,
      normalized.expectedResult,
      normalized.relatedLink,
      timestamp,
      timestamp
    );
    await db.prepare(`
      INSERT INTO echo_requirement_status_history (
        id, requirement_id, from_state, to_state, from_phase, from_status,
        to_phase, to_status, response, actor_user_id, revision, idempotency_key, created_at
      ) VALUES (?, ?, NULL, 'submitted', NULL, NULL, 'proposal', 'pending_review', NULL, ?, 1, ?, ?)
    `).run(randomUUID(), id, actor.id, idempotencyKey, timestamp);
    await db.prepare(`
      INSERT INTO echo_requirement_idempotency (
        space_id, actor_user_id, operation, idempotency_key, request_hash,
        requirement_id, resulting_state, resulting_revision, result_json, created_at
      ) VALUES (?, ?, 'submit', ?, ?, ?, 'submitted', 1, NULL, ?)
    `).run(spaceId, actor.id, idempotencyKey, requestHash, id, timestamp);
      await writeEchoAudit(db, input.request, {
        actor,
        spaceId,
        action: "echo.requirement.submit",
        targetId: publicId,
        result: "success",
        reason: "submitted"
      });
      const result = await loadAuthorizedRequirement(db, id, actor, spaceId);
      await db.prepare(`
        UPDATE echo_requirement_idempotency SET result_json = ?
        WHERE space_id = ? AND actor_user_id = ? AND operation = 'submit' AND idempotency_key = ?
      `).run(JSON.stringify(result), spaceId, actor.id, idempotencyKey);
      return result;
    });
  });
}

export async function getRequirement(db, input) {
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  const publicId = normalizePublicId(input.publicId);
  return await loadAuthorizedRequirementByPublicId(db, publicId, actor, spaceId, input.request);
}

export async function listRequirements(db, input) {
  const page = await listRequirementPage(db, input);
  return page.items;
}

export async function listRequirementPage(db, input) {
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  const state = input.state === undefined || input.state === null || input.state === ""
    ? null
    : normalizeState(input.state);
  const phase = input.phase === undefined || input.phase === null || input.phase === ""
    ? null
    : normalizePhase(input.phase);
  const status = input.status === undefined || input.status === null || input.status === ""
    ? null
    : normalizeStatus(input.status);
  const archiveOutcome = input.archiveOutcome === undefined || input.archiveOutcome === null || input.archiveOutcome === ""
    ? null
    : normalizeArchiveOutcome(input.archiveOutcome);
  const limit = normalizeListLimit(input.limit);
  const type = input.type === undefined || input.type === null || input.type === ""
    ? null
    : normalizeType(input.type);
  const submitterUserId = input.submitterUserId ? normalizeRequiredIdentifier(input.submitterUserId, "echo.submitter_invalid") : null;
  const offset = normalizeOffset(input.offset);
  const createdFrom = input.createdFrom === undefined || input.createdFrom === null || input.createdFrom === ""
    ? null
    : normalizeFilterTimestamp(input.createdFrom, "echo.created_from_invalid");
  const createdTo = input.createdTo === undefined || input.createdTo === null || input.createdTo === ""
    ? null
    : normalizeFilterTimestamp(input.createdTo, "echo.created_to_invalid");
  if (createdFrom && createdTo && createdFrom > createdTo) {
    throw new EchoRequirementError("echo.created_range_invalid", "创建时间范围无效");
  }
  const owner = actor.role === "owner";
  const where = `
      echo_requirements.space_id = ?
      AND (? IS NULL OR echo_requirements.state = ?)
      AND (? IS NULL OR echo_requirements.phase = ?)
      AND (? IS NULL OR echo_requirements.status = ?)
      AND (? IS NULL OR echo_requirements.archive_outcome = ?)
      AND (? IS NULL OR echo_requirements.type = ?)
      AND (? IS NULL OR echo_requirements.submitter_user_id = ?)
      AND (? IS NULL OR echo_requirements.created_at >= ?)
      AND (? IS NULL OR echo_requirements.created_at <= ?)
      AND (? = 1 OR echo_requirements.submitter_user_id = ?)`;
  const filterParams = [
    spaceId,
    state, state,
    phase, phase,
    status, status,
    archiveOutcome, archiveOutcome,
    type, type,
    submitterUserId, submitterUserId,
    createdFrom, createdFrom,
    createdTo, createdTo,
    owner ? 1 : 0, actor.id
  ];
  const rows = await db.prepare(`
    SELECT echo_requirements.id, echo_requirements.public_id AS publicId, echo_requirements.space_id AS spaceId,
      echo_requirements.submitter_user_id AS submitterUserId, u.display_name AS submitterDisplayName,
      u.github_login AS submitterGithubLogin, echo_requirements.type, echo_requirements.title,
      echo_requirements.detail, echo_requirements.scenario,
      echo_requirements.expected_result AS expectedResult, echo_requirements.related_link AS relatedLink,
      echo_requirements.state, echo_requirements.phase, echo_requirements.status,
      echo_requirements.archive_outcome AS archiveOutcome,
      echo_requirements.duplicate_of_public_id AS duplicateOfPublicId,
      echo_requirements.revision, echo_requirements.response,
      echo_requirements.created_at AS createdAt, echo_requirements.updated_at AS updatedAt
    FROM echo_requirements
    INNER JOIN users u ON u.id = echo_requirements.submitter_user_id
    WHERE ${where}
    ORDER BY echo_requirements.created_at DESC, echo_requirements.id DESC
    LIMIT ? OFFSET ?
  `).all(...filterParams, limit, offset);
  const totalRow = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM echo_requirements
    WHERE ${where}
  `).get(...filterParams);
  const total = Number(totalRow?.count ?? 0);
  const items = rows.map(normalizeRequirementRow);
  return {
    items,
    total,
    pageInfo: {
      offset,
      limit,
      hasNext: offset + items.length < total,
      nextOffset: offset + items.length < total ? offset + items.length : null
    }
  };
}

/** Combined domain facade for hosts that register Echo as one module. */
export function createEchoService(options) {
  return Object.freeze({
    requirements: createEchoRequirementService(options),
    solicitations: createEchoSolicitationDomainService(options)
  });
}

export async function requirementStats(db, input) {
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  const owner = actor.role === "owner";
  const rows = await db.prepare(`
    SELECT phase, status, COUNT(*) AS count
    FROM echo_requirements
    WHERE space_id = ? AND (? = 1 OR submitter_user_id = ?)
    GROUP BY phase, status
    ORDER BY phase ASC, status ASC
  `).all(spaceId, owner ? 1 : 0, actor.id);
  const totals = { total: 0, byPhase: {}, byStatus: {} };
  for (const row of rows) {
    const count = Number(row.count);
    totals.total += count;
    totals.byPhase[row.phase] = (totals.byPhase[row.phase] ?? 0) + count;
    totals.byStatus[row.status] = count;
  }
  return totals;
}

export async function listRequirementHistory(db, input) {
  const requirement = await getRequirement(db, input);
  const rows = await db.prepare(`
    SELECT id, from_state AS fromState, to_state AS toState,
      from_phase AS fromPhase, from_status AS fromStatus,
      to_phase AS toPhase, to_status AS toStatus, response,
      actor_user_id AS actorUserId, revision, created_at AS createdAt
    FROM echo_requirement_status_history
    WHERE requirement_id = ?
    ORDER BY revision ASC
  `).all(requirement.id);
  return rows.map((row) => ({ ...row, response: row.response ?? null }));
}

export async function transitionRequirement(db, input) {
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  return await withRejectionAudit(db, input, actor, spaceId, "echo.requirement.transition", async () => {
    const publicId = normalizePublicId(input.publicId);
    const expected = normalizeExpectedTarget(input);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const response = input.response === undefined || input.response === null
      ? null
      : normalizeResponse(input.response);
    const timestamp = asIsoTimestamp(input.now);
    const requestHash = hashRequest({ spaceId, publicId, expected, expectedRevision, response, duplicateOfPublicId: input.duplicateOfPublicId ?? null });
    return await db.transaction(async () => {
      const row = await db.prepare(`
        SELECT id, public_id AS publicId, submitter_user_id AS submitterUserId,
          state, phase, status, archive_outcome AS archiveOutcome,
          duplicate_of_public_id AS duplicateOfPublicId, revision
        FROM echo_requirements
        WHERE space_id = ? AND public_id = ?
      `).get(spaceId, publicId);
      if (!row) {
        throwRejected(new EchoRequirementNotFoundError(), auditDetails("echo.requirement.transition", publicId, "echo.requirement_not_found"));
      }
      if (actor.role !== "owner") {
        throwRejected(new EchoRequirementPermissionError(), auditDetails("echo.requirement.transition", publicId, "echo.permission_denied"));
      }
      const existing = await getIdempotency(db, spaceId, actor.id, "transition", idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.requirementId !== row.id) {
          throwRejected(new EchoRequirementConflictError("echo.idempotency_conflict", "幂等键已用于其他处理"), auditDetails("echo.requirement.transition", publicId, "echo.idempotency_conflict"));
        }
        return await replayRequirementResult(db, existing, actor, spaceId);
      }
      if (row.revision !== expectedRevision) {
        throwRejected(new EchoRequirementConflictError("echo.revision_conflict", "需求版本已变化，请刷新后重试"), auditDetails("echo.requirement.transition", publicId, "echo.revision_conflict"));
      }
      const target = resolveRequirementTarget(row, expected, input.duplicateOfPublicId);
      if (target.archiveOutcome === "rejected" && !response) {
        throwRejected(new EchoRequirementError("echo.rejection_response_required", "驳回时必须填写说明"), auditDetails("echo.requirement.transition", publicId, "echo.rejection_response_required"));
      }
      if (target.archiveOutcome === "duplicate") {
        if (target.duplicateOfPublicId) {
          if (target.duplicateOfPublicId === publicId) {
            throwRejected(new EchoRequirementError("echo.duplicate_target_invalid", "重复需求不能引用自身"), auditDetails("echo.requirement.transition", publicId, "echo.duplicate_target_invalid"));
          }
          const duplicate = await db.prepare(`
            SELECT id FROM echo_requirements WHERE space_id = ? AND public_id = ?
          `).get(spaceId, target.duplicateOfPublicId);
          if (!duplicate) {
            throwRejected(new EchoRequirementError("echo.duplicate_target_invalid", "重复需求引用不存在"), auditDetails("echo.requirement.transition", publicId, "echo.duplicate_target_invalid"));
          }
        }
      }
      const revision = row.revision + 1;
      const update = await db.prepare(`
        UPDATE echo_requirements
        SET state = ?, phase = ?, status = ?, archive_outcome = ?, duplicate_of_public_id = ?,
          revision = ?, response = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(target.legacyState, target.phase, target.status, target.archiveOutcome, target.duplicateOfPublicId, revision, response, timestamp, row.id, row.revision);
      if (update.changes !== 1) {
        throwRejected(new EchoRequirementConflictError("echo.revision_conflict", "需求版本已变化，请刷新后重试"), auditDetails("echo.requirement.transition", publicId, "echo.revision_conflict"));
      }
      await db.prepare(`
        INSERT INTO echo_requirement_status_history (
          id, requirement_id, from_state, to_state, from_phase, from_status,
          to_phase, to_status, response, actor_user_id, revision, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), row.id, row.state, target.legacyState, row.phase, row.status, target.phase, target.status, response, actor.id, revision, idempotencyKey, timestamp);
      await db.prepare(`
        INSERT INTO echo_requirement_idempotency (
          space_id, actor_user_id, operation, idempotency_key, request_hash,
          requirement_id, resulting_state, resulting_revision, result_json, created_at
        ) VALUES (?, ?, 'transition', ?, ?, ?, ?, ?, NULL, ?)
      `).run(spaceId, actor.id, idempotencyKey, requestHash, row.id, target.legacyState, revision, timestamp);
      const result = await loadAuthorizedRequirement(db, row.id, actor, spaceId);
      await db.prepare(`
        UPDATE echo_requirement_idempotency SET result_json = ?
        WHERE space_id = ? AND actor_user_id = ? AND operation = 'transition' AND idempotency_key = ?
      `).run(JSON.stringify(result), spaceId, actor.id, idempotencyKey);
    await writeEchoAudit(db, input.request, {
      actor,
      spaceId,
      action: "echo.requirement.transition",
      targetId: publicId,
      result: "success",
      reason: target.archiveOutcome === "duplicate" ? "duplicate_proposal" : target.archiveOutcome ?? target.status
    });
      return result;
    });
  });
}

/**
 * Project a persisted domain event for one actor. The event must contain only
 * metadata (requirement id/public id/state/revision); this function never
 * loads or returns private requirement fields.
 */
export async function projectEchoRequirementEvent(db, input) {
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  const publicId = normalizePublicId(input.publicId ?? input.requirement?.publicId);
  const row = await db.prepare(`
    SELECT id, public_id AS publicId, submitter_user_id AS submitterUserId,
      state, phase, status, archive_outcome AS archiveOutcome,
      duplicate_of_public_id AS duplicateOfPublicId, revision
    FROM echo_requirements
    WHERE space_id = ? AND public_id = ?
  `).get(spaceId, publicId);
  if (!row || (actor.role !== "owner" && actor.id !== row.submitterUserId)) {
    return null;
  }
  return {
    type: "echo.requirement.updated",
    targetType: "echo.requirement",
    targetId: row.id,
    payload: {
      publicId: row.publicId,
      state: row.state,
      phase: row.phase,
      status: row.status,
      archiveOutcome: row.archiveOutcome ?? null,
      duplicateOfPublicId: row.duplicateOfPublicId ?? null,
      revision: Number(row.revision),
      card: {
        cardId: `echo_req_${row.publicId.toLowerCase()}`,
        cardType: "echo.request-status",
        schemaVersion: 1,
        fallbackText: `回声需求 ${row.publicId} 状态已更新`
      }
    }
  };
}

export async function projectEchoRequirementCard(db, input) {
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  const requirement = await loadAuthorizedRequirementByPublicId(db, normalizePublicId(input.publicId), actor, spaceId, input.request);
  const cardType = normalizeCardType(input.cardType ?? "echo.request");
  const card = {
    type: "card",
    cardId: `echo_req_${requirement.publicId.toLowerCase()}`,
    cardType,
    schemaVersion: 1,
    fallbackText: `回声需求 ${requirement.publicId}`
  };
  const payload = normalizeCardPayload({
    publicId: requirement.publicId,
    type: requirement.type,
    title: truncateCardText(requirement.title, 120, 512),
    detail: truncateCardText(requirement.detail, 4_000, 5_000),
    scenario: truncateCardText(requirement.scenario, 2_000, 3_000),
    expectedResult: truncateCardText(requirement.expectedResult, 2_000, 3_000),
    relatedLink: requirement.relatedLink,
    state: requirement.state,
    phase: requirement.phase,
    status: requirement.status,
    archiveOutcome: requirement.archiveOutcome,
    duplicateOfPublicId: requirement.duplicateOfPublicId,
    revision: requirement.revision,
    response: requirement.response ? truncateCardText(requirement.response, 2_000, 3_000) : null,
    createdAt: requirement.createdAt,
    updatedAt: requirement.updatedAt
  }, { allowPublicUrls: true, limits: { maxPayloadBytes: 20 * 1024, maxTextBytes: 14 * 1024 } });
  return { block: card, payload };
}

export async function projectEchoRequirementListCard(db, input) {
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  const requirements = await listRequirements(db, { ...input, spaceId, actorId: actor.id });
  const payload = normalizeCardPayload({
    items: requirements.slice(0, 40).map((item) => ({
      publicId: item.publicId,
      type: item.type,
      title: truncateCardText(item.title, 96, 384),
      state: item.state,
      phase: item.phase,
      status: item.status,
      revision: item.revision,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }))
  }, { limits: { maxPayloadBytes: 16 * 1024, maxTextBytes: 8 * 1024 } });
  return {
    block: {
      type: "card",
      cardId: `echo_req_list_${actor.id}`,
      cardType: "echo.request-list",
      schemaVersion: 1,
      fallbackText: `回声需求列表（${requirements.length} 条）`
    },
    payload
  };
}

export const ECHO_REQUIREMENT_CARD_DEFINITIONS = Object.freeze([
  Object.freeze({ cardType: "echo.request", schemaVersion: 1, allowPublicUrls: true, validatePayload: validateEchoRequestCardPayload, limits: { maxPayloadBytes: 20 * 1024, maxTextBytes: 14 * 1024 } }),
  Object.freeze({ cardType: "echo.request-status", schemaVersion: 1, allowPublicUrls: true, validatePayload: validateEchoRequestStatusCardPayload, limits: { maxPayloadBytes: 12 * 1024, maxTextBytes: 8 * 1024 } }),
  Object.freeze({ cardType: "echo.request-list", schemaVersion: 1, validatePayload: validateEchoRequestListCardPayload, limits: { maxPayloadBytes: 16 * 1024, maxTextBytes: 8 * 1024 } })
]);

export function createEchoRequirementCardRegistry() {
  return createCardRegistry(ECHO_REQUIREMENT_CARD_DEFINITIONS);
}

function validateEchoRequestCardPayload(payload) {
  validateCardPublicId(payload);
  validateCardCommon(payload);
  if (!isNonEmptyString(payload.detail) || !isNonEmptyString(payload.scenario) || !isNonEmptyString(payload.expectedResult)) {
    throw new CardValidationError("card.domain_invalid", "需求卡片内容不完整");
  }
  return payload;
}

function validateEchoRequestStatusCardPayload(payload) {
  validateCardPublicId(payload);
  validateCardCommon(payload);
  return payload;
}

function validateEchoRequestListCardPayload(payload) {
  if (!Array.isArray(payload?.items) || payload.items.length > ECHO_REQUIREMENT_LIMITS.listLimit) {
    throw new CardValidationError("card.domain_invalid", "需求列表无效");
  }
  for (const item of payload.items) {
    validateCardPublicId(item);
    validateCardCommon(item, { requireTitle: true });
  }
  return payload;
}

function validateCardCommon(payload, options = {}) {
  if (!ECHO_REQUIREMENT_TYPES.includes(payload?.type) || !ECHO_REQUIREMENT_STATES.includes(payload?.state)) {
    throw new CardValidationError("card.domain_invalid", "需求卡片状态无效");
  }
  if (options.requireTitle !== false && !isNonEmptyString(payload?.title)) {
    throw new CardValidationError("card.domain_invalid", "需求卡片标题无效");
  }
  if (!Number.isSafeInteger(payload?.revision) || payload.revision < 1) {
    throw new CardValidationError("card.domain_invalid", "需求卡片版本无效");
  }
  if (payload?.phase !== undefined && !ECHO_REQUIREMENT_PHASES.includes(payload.phase)) {
    throw new CardValidationError("card.domain_invalid", "需求卡片阶段无效");
  }
  if (payload?.status !== undefined && !ECHO_REQUIREMENT_STATUSES.includes(payload.status)) {
    throw new CardValidationError("card.domain_invalid", "需求卡片状态无效");
  }
}

function validateCardPublicId(payload) {
  if (!/^REQ-\d{4}-\d{4}$/.test(payload?.publicId ?? "")) {
    throw new CardValidationError("card.domain_invalid", "需求卡片编号无效");
  }
}

async function requireHumanActor(db, actorId, spaceId) {
  const userId = normalizeRequiredIdentifier(actorId, "auth.required");
  const actor = await db.prepare(`
    SELECT u.id, u.github_login AS githubLogin, u.kind,
      sm.role, sm.removed_at AS removedAt
    FROM users u
    INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ?
    WHERE u.id = ? AND sm.removed_at IS NULL
  `).get(spaceId, userId);
  if (!actor || actor.kind !== "human") {
    throw new EchoRequirementError("auth.required", "请先登录共享空间", 401);
  }
  return actor;
}

async function loadAuthorizedRequirementByPublicId(db, publicId, actor, spaceId, request) {
  const row = await db.prepare("SELECT id FROM echo_requirements WHERE space_id = ? AND public_id = ?").get(spaceId, publicId);
  if (!row) {
    await writeEchoAudit(db, request, {
      actor,
      spaceId,
      action: "echo.requirement.read",
      targetId: publicId,
      result: "rejected",
      reason: "echo.requirement_not_found"
    });
    throw new EchoRequirementNotFoundError();
  }
  const result = await loadAuthorizedRequirement(db, row.id, actor, spaceId);
  if (!result) {
    await writeEchoAudit(db, request, {
      actor,
      spaceId,
      action: "echo.requirement.read",
      targetId: publicId,
      result: "rejected",
      reason: "echo.permission_denied"
    });
    throw new EchoRequirementNotFoundError();
  }
  return result;
}

async function loadAuthorizedRequirement(db, id, actor, spaceId) {
  const row = await db.prepare(`
    SELECT id, public_id AS publicId, space_id AS spaceId, submitter_user_id AS submitterUserId,
      type, title, detail, scenario, expected_result AS expectedResult,
      related_link AS relatedLink, state, phase, status,
      archive_outcome AS archiveOutcome, duplicate_of_public_id AS duplicateOfPublicId,
      revision, response,
      created_at AS createdAt, updated_at AS updatedAt
    FROM echo_requirements
    WHERE id = ? AND space_id = ?
  `).get(id, spaceId);
  if (!row || (actor.role !== "owner" && actor.id !== row.submitterUserId)) {
    return null;
  }
  return normalizeRequirementRow(row);
}

async function nextRequirementNumber(db, spaceId, year) {
  const current = await db.prepare(`
    SELECT next_number AS nextNumber
    FROM echo_requirement_sequences
    WHERE space_id = ? AND sequence_year = ?
  `).get(spaceId, year);
  const number = current?.nextNumber ?? 1;
  if (!Number.isSafeInteger(number) || number > 9_999) {
    throw new EchoRequirementError("echo.sequence_exhausted", "本年度需求编号已用尽", 409);
  }
  if (current) {
    await db.prepare(`
      UPDATE echo_requirement_sequences
      SET next_number = ?
      WHERE space_id = ? AND sequence_year = ? AND next_number = ?
    `).run(number + 1, spaceId, year, number);
  } else {
    await db.prepare(`
      INSERT INTO echo_requirement_sequences (space_id, sequence_year, next_number)
      VALUES (?, ?, ?)
    `).run(spaceId, year, 2);
  }
  return number;
}

async function getIdempotency(db, spaceId, actorUserId, operation, idempotencyKey) {
  return await db.prepare(`
    SELECT request_hash AS requestHash, requirement_id AS requirementId,
      resulting_state AS resultingState, resulting_revision AS resultingRevision,
      result_json AS resultJson
    FROM echo_requirement_idempotency
    WHERE space_id = ? AND actor_user_id = ? AND operation = ? AND idempotency_key = ?
  `).get(spaceId, actorUserId, operation, idempotencyKey);
}

async function replayRequirementResult(db, existing, actor, spaceId) {
  if (existing.resultJson) {
    try {
      const parsed = JSON.parse(existing.resultJson);
      if (parsed && parsed.id && parsed.publicId) return parsed;
    } catch {
      // Fall through to a legacy reconstruction for rows written before 021.
    }
  }
  const replay = await loadAuthorizedRequirement(db, existing.requirementId, actor, spaceId);
  if (!replay) return replay;
  return {
    ...replay,
    state: existing.resultingState ?? replay.state,
    phase: legacyPhaseForState(existing.resultingState) ?? replay.phase,
    status: legacyStatusForState(existing.resultingState) ?? replay.status,
    revision: Number(existing.resultingRevision ?? replay.revision)
  };
}

async function writeEchoAudit(db, request, event) {
  await writeAudit(db, {
    id: request?.auditId,
    spaceId: event.spaceId,
    actorUserId: event.actor?.id,
    actorGithubLogin: event.actor?.githubLogin,
    action: event.action,
    targetType: "echo.requirement",
    targetId: event.targetId ?? null,
    result: event.result,
    reason: event.reason ?? null,
    ipAddress: request?.ipAddress,
    userAgent: request?.userAgent,
    requestId: request?.requestId
  });
}

async function withRejectionAudit(db, input, actor, spaceId, operation, callback) {
  try {
    return await callback();
  } catch (error) {
    const details = error?.echoAudit ?? (
      error instanceof EchoRequirementError
        ? auditDetails(operation, null, error.code)
        : null
    );
    if (details) {
      await writeEchoAudit(db, input.request, {
        actor,
        spaceId,
        action: details.action,
        targetId: details.targetId ?? null,
        result: "rejected",
        reason: details.reason
      });
    }
    throw error;
  }
}

function auditDetails(action, targetId, reason) {
  return { action, targetId: targetId ?? null, reason };
}

function throwRejected(error, details) {
  Object.defineProperty(error, "echoAudit", {
    configurable: true,
    enumerable: false,
    value: details
  });
  throw error;
}

async function advisoryLock(db, key) {
  if (typeof db.lock === "function") {
    await db.lock(key);
  }
}

function normalizeSubmission(input) {
  const type = normalizeType(input.type);
  return {
    type,
    title: normalizeBoundedText(input.title, "echo.title_invalid", ECHO_REQUIREMENT_LIMITS.titleCodePoints, ECHO_REQUIREMENT_LIMITS.titleBytes, "标题"),
    detail: normalizeBoundedText(input.detail, "echo.detail_invalid", ECHO_REQUIREMENT_LIMITS.bodyCodePoints, ECHO_REQUIREMENT_LIMITS.bodyBytes, "详细描述"),
    scenario: normalizeBoundedText(input.scenario, "echo.scenario_invalid", ECHO_REQUIREMENT_LIMITS.bodyCodePoints, ECHO_REQUIREMENT_LIMITS.bodyBytes, "使用场景"),
    expectedResult: normalizeBoundedText(input.expectedResult, "echo.expected_result_invalid", ECHO_REQUIREMENT_LIMITS.bodyCodePoints, ECHO_REQUIREMENT_LIMITS.bodyBytes, "预期结果"),
    relatedLink: normalizeRelatedLink(input.relatedLink)
  };
}

function normalizeResponse(value) {
  return normalizeBoundedText(value, "echo.response_invalid", ECHO_REQUIREMENT_LIMITS.responseCodePoints, ECHO_REQUIREMENT_LIMITS.responseBytes, "处理说明");
}

function normalizeBoundedText(value, code, maxCodePoints, maxBytes, label) {
  if (typeof value !== "string") {
    throw new EchoRequirementError(code, `${label}不能为空`);
  }
  const normalized = value.trim();
  if (!normalized || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new EchoRequirementError(code, `${label}包含无效字符`);
  }
  if (Array.from(normalized).length > maxCodePoints || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new EchoRequirementError(code, `${label}超出长度限制`);
  }
  return normalized;
}

function normalizeRelatedLink(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Buffer.byteLength(value.trim(), "utf8") > ECHO_REQUIREMENT_LIMITS.relatedLinkBytes) {
    throw new EchoRequirementError("echo.related_link_invalid", "相关链接无效");
  }
  const source = value.trim();
  if (CONTROL_CHARACTER_PATTERN.test(source)) {
    throw new EchoRequirementError("echo.related_link_invalid", "相关链接无效");
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new EchoRequirementError("echo.related_link_invalid", "相关链接无效");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || PRIVATE_HOST_PATTERN.test(url.hostname)) {
    throw new EchoRequirementError("echo.related_link_invalid", "相关链接仅支持公开 HTTP(S) 地址");
  }
  return url.toString();
}

function normalizeType(value) {
  if (!ECHO_REQUIREMENT_TYPES.includes(value)) {
    throw new EchoRequirementError("echo.type_invalid", "需求类型无效");
  }
  return value;
}

function normalizeState(value) {
  if (!ECHO_REQUIREMENT_STATES.includes(value)) {
    throw new EchoRequirementError("echo.state_invalid", "需求状态无效");
  }
  return value;
}

function normalizePhase(value) {
  if (!ECHO_REQUIREMENT_PHASES.includes(value)) {
    throw new EchoRequirementError("echo.phase_invalid", "需求阶段无效");
  }
  return value;
}

function normalizeStatus(value) {
  if (!ECHO_REQUIREMENT_STATUSES.includes(value)) {
    throw new EchoRequirementError("echo.status_invalid", "需求状态无效");
  }
  return value;
}

function normalizeArchiveOutcome(value) {
  if (!ECHO_REQUIREMENT_ARCHIVE_OUTCOMES.includes(value)) {
    throw new EchoRequirementError("echo.archive_outcome_invalid", "归档结果无效");
  }
  return value;
}

function normalizeExpectedTarget(input) {
  if (input.toState !== undefined || input.state !== undefined) {
    const legacy = normalizeState(input.toState ?? input.state);
    return legacyTarget(legacy);
  }
  const phase = normalizePhase(input.toPhase ?? input.phase);
  const status = normalizeStatus(input.toStatus ?? input.status);
  const archiveOutcome = phase === "archived"
    ? normalizeArchiveOutcome(input.archiveOutcome)
    : null;
  return { phase, status, archiveOutcome };
}

function resolveRequirementTarget(row, expected, duplicateOfPublicId) {
  const currentPhase = row.phase ?? legacyPhaseForState(row.state);
  const currentStatus = row.status ?? legacyStatusForState(row.state);
  if (expected.phase === "archived") {
    if (expected.status !== "archived") {
      throwRejected(new EchoRequirementConflictError("echo.invalid_transition", "需求状态不能这样变更"), auditDetails("echo.requirement.transition", row.publicId, "echo.invalid_transition"));
    }
    if (currentPhase === "archived") {
      throwRejected(new EchoRequirementConflictError("echo.invalid_transition", "需求状态不能这样变更"), auditDetails("echo.requirement.transition", row.publicId, "echo.invalid_transition"));
    }
    if (expected.archiveOutcome === "implemented" && !(currentPhase === "formal" && currentStatus === "delivered")) {
      throwRejected(new EchoRequirementConflictError("echo.invalid_transition", "只有已交付需求可以归档为已实现"), auditDetails("echo.requirement.transition", row.publicId, "echo.invalid_transition"));
    }
    const duplicate = expected.archiveOutcome === "duplicate"
      ? normalizePublicId(duplicateOfPublicId)
      : null;
    return {
      phase: "archived",
      status: "archived",
      archiveOutcome: expected.archiveOutcome,
      duplicateOfPublicId: duplicate,
      legacyState: expected.archiveOutcome === "implemented" ? "implemented" : "rejected"
    };
  }
  if (currentPhase === "archived" || expected.phase === "proposal" && expected.status !== "pending_review") {
    throwRejected(new EchoRequirementConflictError("echo.invalid_transition", "需求状态不能这样变更"), auditDetails("echo.requirement.transition", row.publicId, "echo.invalid_transition"));
  }
  const valid = currentPhase === "proposal" && currentStatus === "pending_review"
    ? expected.phase === "formal" && expected.status === "planned"
    : currentPhase === "formal" && currentStatus === "planned"
      ? expected.phase === "formal" && ["in_progress", "delivered"].includes(expected.status)
      : currentPhase === "formal" && currentStatus === "in_progress"
        ? expected.phase === "formal" && expected.status === "delivered"
        : false;
  if (!valid) {
    throwRejected(new EchoRequirementConflictError("echo.invalid_transition", "需求状态不能这样变更"), auditDetails("echo.requirement.transition", row.publicId, "echo.invalid_transition"));
  }
  return {
    phase: expected.phase,
    status: expected.status,
    archiveOutcome: null,
    duplicateOfPublicId: null,
    legacyState: legacyStateForTarget(expected.phase, expected.status)
  };
}

function legacyTarget(state) {
  if (state === "submitted") return { phase: "proposal", status: "pending_review", archiveOutcome: null };
  if (state === "collected") return { phase: "formal", status: "planned", archiveOutcome: null };
  if (state === "in_progress") return { phase: "formal", status: "in_progress", archiveOutcome: null };
  if (state === "implemented") return { phase: "formal", status: "delivered", archiveOutcome: null };
  return { phase: "archived", status: "archived", archiveOutcome: "rejected" };
}

function legacyStateForTarget(phase, status) {
  if (phase === "proposal") return "submitted";
  if (phase === "formal" && status === "planned") return "collected";
  if (phase === "formal" && status === "in_progress") return "in_progress";
  if (phase === "formal" && status === "delivered") return "implemented";
  return "rejected";
}

function legacyPhaseForState(state) {
  if (state === "collected" || state === "in_progress" || state === "implemented") return "formal";
  if (state === "rejected") return "archived";
  return "proposal";
}

function legacyStatusForState(state) {
  if (state === "collected") return "planned";
  if (state === "in_progress") return "in_progress";
  if (state === "implemented") return "delivered";
  if (state === "rejected") return "archived";
  return "pending_review";
}

function normalizePublicId(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^REQ-\d{4}-\d{4}$/.test(normalized)) {
    throw new EchoRequirementError("echo.requirement_id_invalid", "需求编号无效");
  }
  return normalized;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > ECHO_REQUIREMENT_LIMITS.idempotencyKeyBytes || !/^[A-Za-z0-9._:-]+$/.test(value.trim())) {
    throw new EchoRequirementError("echo.idempotency_key_invalid", "幂等键无效");
  }
  return value.trim();
}

function normalizeExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EchoRequirementError("echo.expected_revision_invalid", "需求版本无效");
  }
  return value;
}

function normalizeListLimit(value) {
  if (value === undefined || value === null || value === "") return ECHO_REQUIREMENT_LIMITS.listLimit;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new EchoRequirementError("echo.limit_invalid", "列表数量无效");
  }
  return Math.min(parsed, ECHO_REQUIREMENT_LIMITS.listLimit);
}

function normalizeOffset(value) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new EchoRequirementError("echo.offset_invalid", "列表偏移无效");
  }
  return parsed;
}

function normalizeFilterTimestamp(value, code) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new EchoRequirementError(code, "创建时间范围无效");
  }
  return timestamp.toISOString();
}

function normalizeRequiredIdentifier(value, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) {
    throw new EchoRequirementError(
      code,
      code === "auth.required" ? "请先登录共享空间" : "标识无效",
      code === "auth.required" ? 401 : 400
    );
  }
  return normalized;
}

function normalizeCardType(value) {
  if (!ECHO_REQUIREMENT_CARD_TYPES.includes(value)) {
    throw new EchoRequirementError("echo.card_type_invalid", "需求卡片类型无效");
  }
  return value;
}

function normalizeRequirementRow(row) {
  return {
    id: row.id,
    publicId: row.publicId,
    spaceId: row.spaceId,
    submitterUserId: row.submitterUserId,
    submitterDisplayName: row.submitterDisplayName ?? null,
    submitterGithubLogin: row.submitterGithubLogin ?? null,
    type: row.type,
    title: row.title,
    detail: row.detail,
    scenario: row.scenario,
    expectedResult: row.expectedResult,
    relatedLink: row.relatedLink ?? null,
    state: row.state,
    phase: row.phase ?? legacyPhaseForState(row.state),
    status: row.status ?? legacyStatusForState(row.state),
    archiveOutcome: row.archiveOutcome ?? (row.state === "rejected" ? "rejected" : null),
    duplicateOfPublicId: row.duplicateOfPublicId ?? null,
    revision: Number(row.revision),
    response: row.response ?? null,
    createdAt: normalizeTimestamp(row.createdAt),
    updatedAt: normalizeTimestamp(row.updatedAt)
  };
}

function normalizeTimestamp(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function asIsoTimestamp(value) {
  const timestamp = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(timestamp.getTime())) {
    throw new EchoRequirementError("echo.invalid_time", "时间无效");
  }
  return timestamp.toISOString();
}

function hashRequest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function truncateCardText(value, maxCodePoints, maxBytes = Number.POSITIVE_INFINITY) {
  const normalized = typeof value === "string" ? value : "";
  const points = Array.from(normalized);
  if (points.length <= maxCodePoints && Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  let result = "";
  for (const point of points) {
    const candidate = `${result}${point}`;
    if (Array.from(candidate).length >= maxCodePoints || Buffer.byteLength(`${candidate}…`, "utf8") > maxBytes) break;
    result = candidate;
  }
  return `${result}…`;
}

export {
  ECHO_SOLICITATION_CARD_DEFINITION,
  ECHO_SOLICITATION_CARD_SCHEMA_VERSION,
  ECHO_SOLICITATION_CARD_TYPE,
  ECHO_SOLICITATION_CHOICE_MODES,
  ECHO_SOLICITATION_LIMITS,
  ECHO_SOLICITATION_STATUSES,
  EchoSolicitationConflictError,
  EchoSolicitationError,
  EchoSolicitationNotFoundError,
  EchoSolicitationPermissionError,
  createEchoSolicitationCardRegistry,
  createEchoSolicitationService,
  createSolicitation,
  getSolicitation,
  listSolicitations,
  publishSolicitation,
  closeSolicitation,
  withdrawSolicitation,
  voteSolicitation,
  listSolicitationVotes,
  listSolicitationDeliveries,
  markSolicitationDelivery,
  projectSolicitationDelivery,
  projectSolicitationCard
} from "./echo-solicitations.mjs";
