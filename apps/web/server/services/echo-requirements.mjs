import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { writeAudit } from "./audit.mjs";
import {
  CardValidationError,
  createCardRegistry,
  normalizeCardPayload
} from "./workspace-cards.mjs";

export const ECHO_REQUIREMENT_STATES = Object.freeze([
  "submitted",
  "collected",
  "implemented",
  "rejected"
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
  ["collected", new Set(["implemented", "rejected"])],
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
    const normalized = normalizeSubmission(input);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const requestHash = hashRequest({ spaceId, actorId: actor.id, ...normalized });
    const timestamp = asIsoTimestamp(input.now);
    return await db.transaction(async () => {
      await advisoryLock(db, `echo-requirement-sequence:${spaceId}:${timestamp.slice(0, 4)}`);
      const existing = await getIdempotency(db, actor.id, "submit", idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throwRejected(
            new EchoRequirementConflictError("echo.idempotency_conflict", "幂等键已用于其他提交"),
            auditDetails("echo.requirement.submit", null, "echo.idempotency_conflict")
          );
        }
        const replay = await loadAuthorizedRequirement(db, existing.requirementId, actor, spaceId);
        if (replay) return replay;
    }

    const sequenceYear = Number(timestamp.slice(0, 4));
    const number = await nextRequirementNumber(db, spaceId, sequenceYear);
    const publicId = `REQ-${sequenceYear}-${String(number).padStart(4, "0")}`;
    const id = `echo_req_${randomUUID()}`;
    await db.prepare(`
      INSERT INTO echo_requirements (
        id, public_id, space_id, submitter_user_id, type, title, detail,
        scenario, expected_result, related_link, state, revision, response,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 1, NULL, ?, ?)
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
        id, requirement_id, from_state, to_state, response, actor_user_id,
        revision, idempotency_key, created_at
      ) VALUES (?, ?, NULL, 'submitted', NULL, ?, 1, ?, ?)
    `).run(randomUUID(), id, actor.id, idempotencyKey, timestamp);
    await db.prepare(`
      INSERT INTO echo_requirement_idempotency (
        actor_user_id, operation, idempotency_key, request_hash,
        requirement_id, resulting_state, resulting_revision, created_at
      ) VALUES (?, 'submit', ?, ?, ?, 'submitted', 1, ?)
    `).run(actor.id, idempotencyKey, requestHash, id, timestamp);
      await writeEchoAudit(db, input.request, {
        actor,
        spaceId,
        action: "echo.requirement.submit",
        targetId: publicId,
        result: "success",
        reason: "submitted"
      });
      return await loadAuthorizedRequirement(db, id, actor, spaceId);
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
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  const state = input.state === undefined || input.state === null || input.state === ""
    ? null
    : normalizeState(input.state);
  const limit = normalizeListLimit(input.limit);
  const owner = actor.role === "owner";
  const rows = await db.prepare(`
    SELECT id, public_id AS publicId, space_id AS spaceId,
      submitter_user_id AS submitterUserId, type, title, detail, scenario,
      expected_result AS expectedResult, related_link AS relatedLink,
      state, revision, response, created_at AS createdAt, updated_at AS updatedAt
    FROM echo_requirements
    WHERE space_id = ?
      AND (? IS NULL OR state = ?)
      AND (? = 1 OR submitter_user_id = ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(spaceId, state, state, owner ? 1 : 0, actor.id, limit);
  return rows.map(normalizeRequirementRow);
}

export async function listRequirementHistory(db, input) {
  const requirement = await getRequirement(db, input);
  const rows = await db.prepare(`
    SELECT id, from_state AS fromState, to_state AS toState, response,
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
    const nextState = normalizeState(input.toState ?? input.state);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const response = input.response === undefined || input.response === null
      ? null
      : normalizeResponse(input.response);
    const timestamp = asIsoTimestamp(input.now);
    const requestHash = hashRequest({ publicId, nextState, expectedRevision, response });
    return await db.transaction(async () => {
    const row = await db.prepare(`
      SELECT id, public_id AS publicId, submitter_user_id AS submitterUserId, state, revision
      FROM echo_requirements
      WHERE space_id = ? AND public_id = ?
    `).get(spaceId, publicId);
    if (!row) {
      throwRejected(new EchoRequirementNotFoundError(), auditDetails("echo.requirement.transition", publicId, "echo.requirement_not_found"));
    }
    const owner = actor.role === "owner";
    if (!owner) {
      throwRejected(new EchoRequirementPermissionError(), auditDetails("echo.requirement.transition", publicId, "echo.permission_denied"));
    }
    const existing = await getIdempotency(db, actor.id, "transition", idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.requirementId !== row.id) {
        throwRejected(new EchoRequirementConflictError("echo.idempotency_conflict", "幂等键已用于其他处理"), auditDetails("echo.requirement.transition", publicId, "echo.idempotency_conflict"));
      }
      return await loadAuthorizedRequirement(db, row.id, actor, spaceId);
    }
    if (row.revision !== expectedRevision) {
      throwRejected(new EchoRequirementConflictError("echo.revision_conflict", "需求版本已变化，请刷新后重试"), auditDetails("echo.requirement.transition", publicId, "echo.revision_conflict"));
    }
    if (!TRANSITIONS.get(row.state)?.has(nextState)) {
      throwRejected(new EchoRequirementConflictError("echo.invalid_transition", "需求状态不能这样变更"), auditDetails("echo.requirement.transition", publicId, "echo.invalid_transition"));
    }
    if (nextState === "rejected" && !response) {
      throwRejected(new EchoRequirementError("echo.rejection_response_required", "驳回时必须填写说明"), auditDetails("echo.requirement.transition", publicId, "echo.rejection_response_required"));
    }
    const revision = row.revision + 1;
    const update = await db.prepare(`
      UPDATE echo_requirements
      SET state = ?, revision = ?, response = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND state = ?
    `).run(nextState, revision, response, timestamp, row.id, row.revision, row.state);
    if (update.changes !== 1) {
      throwRejected(new EchoRequirementConflictError("echo.revision_conflict", "需求版本已变化，请刷新后重试"), auditDetails("echo.requirement.transition", publicId, "echo.revision_conflict"));
    }
    await db.prepare(`
      INSERT INTO echo_requirement_status_history (
        id, requirement_id, from_state, to_state, response, actor_user_id,
        revision, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), row.id, row.state, nextState, response, actor.id, revision, idempotencyKey, timestamp);
    await db.prepare(`
      INSERT INTO echo_requirement_idempotency (
        actor_user_id, operation, idempotency_key, request_hash,
        requirement_id, resulting_state, resulting_revision, created_at
      ) VALUES (?, 'transition', ?, ?, ?, ?, ?, ?)
    `).run(actor.id, idempotencyKey, requestHash, row.id, nextState, revision, timestamp);
    await writeEchoAudit(db, input.request, {
      actor,
      spaceId,
      action: "echo.requirement.transition",
      targetId: publicId,
      result: "success",
      reason: nextState
    });
    return await loadAuthorizedRequirement(db, row.id, actor, spaceId);
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
      state, revision
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
    title: requirement.title,
    detail: requirement.detail,
    scenario: requirement.scenario,
    expectedResult: requirement.expectedResult,
    relatedLink: requirement.relatedLink,
    state: requirement.state,
    revision: requirement.revision,
    response: requirement.response,
    createdAt: requirement.createdAt,
    updatedAt: requirement.updatedAt
  }, { allowPublicUrls: true });
  return { block: card, payload };
}

export async function projectEchoRequirementListCard(db, input) {
  const spaceId = normalizeRequiredIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireHumanActor(db, input.actorId, spaceId);
  const requirements = await listRequirements(db, { ...input, spaceId, actorId: actor.id });
  const payload = normalizeCardPayload({
    items: requirements.map((item) => ({
      publicId: item.publicId,
      type: item.type,
      title: item.title,
      state: item.state,
      revision: item.revision,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }))
  });
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
  Object.freeze({ cardType: "echo.request", schemaVersion: 1, allowPublicUrls: true, validatePayload: validateEchoRequestCardPayload }),
  Object.freeze({ cardType: "echo.request-status", schemaVersion: 1, allowPublicUrls: true, validatePayload: validateEchoRequestStatusCardPayload }),
  Object.freeze({ cardType: "echo.request-list", schemaVersion: 1, validatePayload: validateEchoRequestListCardPayload })
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
      related_link AS relatedLink, state, revision, response,
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

async function getIdempotency(db, actorUserId, operation, idempotencyKey) {
  return await db.prepare(`
    SELECT request_hash AS requestHash, requirement_id AS requirementId,
      resulting_state AS resultingState, resulting_revision AS resultingRevision
    FROM echo_requirement_idempotency
    WHERE actor_user_id = ? AND operation = ? AND idempotency_key = ?
  `).get(actorUserId, operation, idempotencyKey);
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

function normalizeRequiredIdentifier(value, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) {
    throw new EchoRequirementError(code, "标识无效", code === "auth.required" ? 401 : 400);
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
    type: row.type,
    title: row.title,
    detail: row.detail,
    scenario: row.scenario,
    expectedResult: row.expectedResult,
    relatedLink: row.relatedLink ?? null,
    state: row.state,
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
