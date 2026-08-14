import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { writeAudit } from "./audit.mjs";
import { CardValidationError, createCardRegistry, normalizeCardPayload } from "./workspace-cards.mjs";

export const ECHO_SOLICITATION_STATUSES = Object.freeze(["draft", "open", "closed", "withdrawn"]);
export const ECHO_SOLICITATION_CHOICE_MODES = Object.freeze(["single", "multiple"]);
export const ECHO_SOLICITATION_CARD_TYPE = "echo.solicitation";
export const ECHO_SOLICITATION_CARD_SCHEMA_VERSION = 1;
export const ECHO_SOLICITATION_LIMITS = Object.freeze({
  titleCodePoints: 120,
  titleBytes: 512,
  bodyCodePoints: 10_000,
  bodyBytes: 64 * 1024,
  optionCodePoints: 256,
  optionBytes: 2_048,
  maxOptions: 20,
  minOptions: 2,
  idempotencyKeyBytes: 128,
  listLimit: 100
});

export class EchoSolicitationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "EchoSolicitationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class EchoSolicitationNotFoundError extends EchoSolicitationError {
  constructor() {
    super("echo.solicitation_not_found", "征集不存在", 404);
    this.name = "EchoSolicitationNotFoundError";
  }
}

export class EchoSolicitationPermissionError extends EchoSolicitationNotFoundError {
  constructor() {
    super();
    this.name = "EchoSolicitationPermissionError";
  }
}

export class EchoSolicitationConflictError extends EchoSolicitationError {
  constructor(code, message) {
    super(code, message, 409);
    this.name = "EchoSolicitationConflictError";
  }
}

export function createEchoSolicitationService({ db, spaceId = DEFAULT_SPACE_ID, now = () => new Date(), idFactory = randomUUID }) {
  if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
    throw new TypeError("Echo solicitation service requires a database adapter");
  }
  return Object.freeze({
    create: (input) => createSolicitation(db, { ...input, spaceId, now: now(), idFactory }),
    get: (input) => getSolicitation(db, { ...input, spaceId, now: now() }),
    list: (input) => listSolicitations(db, { ...input, spaceId, now: now() }),
    publish: (input) => publishSolicitation(db, { ...input, spaceId, now: now() }),
    close: (input) => closeSolicitation(db, { ...input, spaceId, now: now() }),
    withdraw: (input) => withdrawSolicitation(db, { ...input, spaceId, now: now() }),
    vote: (input) => voteSolicitation(db, { ...input, spaceId, now: now() }),
    listVotes: (input) => listSolicitationVotes(db, { ...input, spaceId, now: now() }),
    listDeliveries: (input) => listSolicitationDeliveries(db, { ...input, spaceId, now: now() }),
    markDelivery: (input) => markSolicitationDelivery(db, { ...input, spaceId, now: now() }),
    projectDelivery: (input) => projectSolicitationDelivery(db, { ...input, spaceId }),
    projectCard: (input) => projectSolicitationCard(db, { ...input, spaceId, now: now() })
  });
}

export async function createSolicitation(db, input) {
  const spaceId = normalizeIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireActor(db, input.actorId, spaceId);
  const idFactory = input.idFactory ?? randomUUID;
  try {
    requireOwner(actor, "echo.solicitation.create");
    const intent = normalizeCreateInput(input);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const requestHash = hashRequest({ spaceId, actorId: actor.id, ...intent });
    const timestamp = iso(input.now);
    return await db.transaction(async () => {
      await db.lock?.(`echo-solicitation-sequence:${spaceId}:${timestamp.slice(0, 4)}`);
      const existing = await getIdempotency(db, spaceId, actor.id, "create", idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) throw reject(new EchoSolicitationConflictError("echo.idempotency_conflict", "幂等键已用于其他征集"), "echo.idempotency_conflict");
        return replayResult(db, existing, actor, spaceId, input.now);
      }
      const year = Number(timestamp.slice(0, 4));
      const number = await nextNumber(db, spaceId, year);
      const publicId = `SOL-${year}-${String(number).padStart(4, "0")}`;
      const id = `echo_sol_${idFactory(input)}`;
      await db.prepare(`
        INSERT INTO echo_solicitations (
          id, public_id, space_id, owner_user_id, title, description, question,
          choice_mode, min_selections, max_selections, allow_vote_change,
          result_visibility, delivery_policy, status, deadline, revision,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 1, ?, ?, ?)
      `).run(
        id, publicId, spaceId, actor.id, intent.title, intent.description, intent.question,
        intent.choiceMode, intent.minSelections, intent.maxSelections,
        intent.allowVoteChange ? 1 : 0, intent.resultVisibility, intent.deliveryPolicy,
        intent.deadline, idempotencyKey, timestamp, timestamp
      );
      for (const [position, label] of intent.options.entries()) {
        await db.prepare(`
          INSERT INTO echo_solicitation_options (id, solicitation_id, label, position)
          VALUES (?, ?, ?, ?)
        `).run(`echo_sol_opt_${idFactory(input)}`, id, label, position);
      }
      await db.prepare(`
        INSERT INTO echo_solicitation_idempotency (
          space_id, actor_user_id, operation, idempotency_key, request_hash,
          solicitation_id, result_json, created_at
        ) VALUES (?, ?, 'create', ?, ?, ?, NULL, ?)
      `).run(spaceId, actor.id, idempotencyKey, requestHash, id, timestamp);
      const result = await projectSolicitation(db, { actor, spaceId, publicId, now: input.now });
      await saveResult(db, spaceId, actor.id, "create", idempotencyKey, result);
      await audit(db, input.request, actor, spaceId, "echo.solicitation.create", publicId, "success", "draft");
      return result;
    });
  } catch (error) {
    await auditRejection(db, input.request, actor, spaceId, "echo.solicitation.create", error);
    throw error;
  }
}

export async function getSolicitation(db, input) {
  const spaceId = normalizeIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireActor(db, input.actorId, spaceId);
  return await projectSolicitation(db, { actor, spaceId, publicId: normalizePublicId(input.publicId), now: input.now, request: input.request });
}

export async function listSolicitations(db, input) {
  const spaceId = normalizeIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireActor(db, input.actorId, spaceId);
  const status = input.status ? normalizeStatus(input.status) : null;
  const limit = normalizeLimit(input.limit);
  const rows = await db.prepare(`
    SELECT public_id AS publicId
    FROM echo_solicitations
    WHERE space_id = ?
      AND (? IS NULL OR status = ?)
      AND (status <> 'draft' OR owner_user_id = ?)
    ORDER BY CASE status WHEN 'open' THEN 1 WHEN 'draft' THEN 2 WHEN 'closed' THEN 3 ELSE 4 END,
      updated_at DESC, id DESC
    LIMIT ?
  `).all(spaceId, status, status, actor.id, limit);
  const items = [];
  for (const row of rows) {
    items.push(await projectSolicitation(db, { actor, spaceId, publicId: row.publicId, now: input.now, request: input.request }));
  }
  return items;
}

export async function publishSolicitation(db, input) {
  return await transitionSolicitation(db, input, "publish", "open");
}

export async function closeSolicitation(db, input) {
  return await transitionSolicitation(db, input, "close", "closed");
}

export async function withdrawSolicitation(db, input) {
  return await transitionSolicitation(db, input, "withdraw", "withdrawn");
}

async function transitionSolicitation(db, input, operation, targetStatus) {
  const spaceId = normalizeIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireActor(db, input.actorId, spaceId);
  try {
    requireOwner(actor, `echo.solicitation.${operation}`);
    const publicId = normalizePublicId(input.publicId);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const requestHash = hashRequest({ spaceId, publicId, operation, targetStatus });
    const timestamp = iso(input.now);
    return await db.transaction(async () => {
      const row = await getSolicitationRow(db, spaceId, publicId);
      if (!row) throw reject(new EchoSolicitationNotFoundError(), "echo.solicitation_not_found");
      const existing = await getIdempotency(db, spaceId, actor.id, operation, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.solicitationId !== row.id) throw reject(new EchoSolicitationConflictError("echo.idempotency_conflict", "幂等键已用于其他处理"), "echo.idempotency_conflict");
        return replayResult(db, existing, actor, spaceId, input.now);
      }
      const allowed = operation === "publish" ? row.status === "draft" : operation === "close" ? row.status === "open" : ["draft", "open"].includes(row.status);
      if (!allowed) throw reject(new EchoSolicitationConflictError("echo.invalid_transition", "征集状态不能这样变更"), "echo.invalid_transition");
      if (operation === "publish" && row.deadline && new Date(row.deadline).getTime() <= new Date(timestamp).getTime()) {
        throw reject(new EchoSolicitationConflictError("echo.deadline_invalid", "截止时间必须晚于当前时间"), "echo.deadline_invalid");
      }
      const revision = Number(row.revision) + 1;
      const fields = operation === "publish"
        ? "status = 'open', published_at = ?"
        : operation === "close"
          ? "status = 'closed', closed_at = ?"
          : "status = 'withdrawn', withdrawn_at = ?";
      const updated = await db.prepare(`UPDATE echo_solicitations SET ${fields}, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`)
        .run(timestamp, revision, timestamp, row.id, row.revision);
      if (!updated.changes) {
        throw reject(new EchoSolicitationConflictError("echo.revision_conflict", "征集版本已变化，请刷新后重试"), "echo.revision_conflict");
      }
      if (operation === "publish" && row.deliveryPolicy !== "none") await createDeliveryRows(db, row, timestamp);
      await db.prepare(`
        INSERT INTO echo_solicitation_idempotency (
          space_id, actor_user_id, operation, idempotency_key, request_hash,
          solicitation_id, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(spaceId, actor.id, operation, idempotencyKey, requestHash, row.id, timestamp);
      const result = await projectSolicitation(db, { actor, spaceId, publicId, now: input.now });
      await saveResult(db, spaceId, actor.id, operation, idempotencyKey, result);
      await audit(db, input.request, actor, spaceId, `echo.solicitation.${operation}`, publicId, "success", targetStatus);
      return result;
    });
  } catch (error) {
    await auditRejection(db, input.request, actor, spaceId, `echo.solicitation.${operation}`, error);
    throw error;
  }
}

export async function voteSolicitation(db, input) {
  const spaceId = normalizeIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireActor(db, input.actorId, spaceId);
  try {
    if (actor.role === "auditor") throw reject(new EchoSolicitationPermissionError(), "echo.vote_permission_denied");
    const publicId = normalizePublicId(input.publicId);
    const optionIds = normalizeOptionIds(input.optionIds ?? input.selectedOptionIds);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const expectedRevision = input.expectedRevision === undefined ? null : normalizeRevision(input.expectedRevision);
    const requestHash = hashRequest({ spaceId, publicId, optionIds, expectedRevision });
    const timestamp = iso(input.now);
    return await db.transaction(async () => {
      const row = await getSolicitationRow(db, spaceId, publicId);
      if (!row || row.status === "draft") throw reject(new EchoSolicitationNotFoundError(), "echo.solicitation_not_found");
      await closeIfExpired(db, row, timestamp);
      const current = await getSolicitationRow(db, spaceId, publicId);
      const existingIntent = await getIdempotency(db, spaceId, actor.id, "vote", idempotencyKey);
      if (existingIntent) {
        if (existingIntent.requestHash !== requestHash || existingIntent.solicitationId !== current.id) throw reject(new EchoSolicitationConflictError("echo.idempotency_conflict", "幂等键已用于其他投票"), "echo.idempotency_conflict");
        return replayResult(db, existingIntent, actor, spaceId, input.now);
      }
      if (current.status !== "open") throw reject(new EchoSolicitationConflictError("echo.vote_closed", "征集已关闭"), "echo.vote_closed");
      if (expectedRevision !== null && expectedRevision !== Number(current.revision)) throw reject(new EchoSolicitationConflictError("echo.revision_conflict", "征集版本已变化，请刷新后重试"), "echo.revision_conflict");
      const options = await db.prepare(`SELECT id FROM echo_solicitation_options WHERE solicitation_id = ? ORDER BY position ASC`).all(current.id);
      const validIds = new Set(options.map((option) => option.id));
      if (optionIds.some((id) => !validIds.has(id))) throw reject(new EchoSolicitationError("echo.option_invalid", "投票选项无效"), "echo.option_invalid");
      if (current.choiceMode === "single" && optionIds.length !== 1) throw reject(new EchoSolicitationError("echo.selection_invalid", "单选征集只能选择一项"), "echo.selection_invalid");
      if (optionIds.length < Number(current.minSelections) || optionIds.length > Number(current.maxSelections)) throw reject(new EchoSolicitationError("echo.selection_invalid", "投票选项数量无效"), "echo.selection_invalid");
      const prior = await db.prepare(`SELECT id, revision FROM echo_solicitation_votes WHERE solicitation_id = ? AND voter_user_id = ?`).get(current.id, actor.id);
      if (prior && !Boolean(current.allowVoteChange)) throw reject(new EchoSolicitationConflictError("echo.vote_change_forbidden", "该征集不允许修改投票"), "echo.vote_change_forbidden");
      const voteRevision = Number(prior?.revision ?? 0) + 1;
      if (prior) {
        await db.prepare(`UPDATE echo_solicitation_votes SET selection_json = ?, revision = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(optionIds), voteRevision, timestamp, prior.id);
      } else {
        await db.prepare(`
          INSERT INTO echo_solicitation_votes (id, solicitation_id, voter_user_id, selection_json, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(`echo_sol_vote_${randomUUID()}`, current.id, actor.id, JSON.stringify(optionIds), timestamp, timestamp);
      }
      const updated = await db.prepare(`UPDATE echo_solicitations SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?`)
        .run(Number(current.revision) + 1, timestamp, current.id, current.revision);
      if (!updated.changes) {
        throw reject(new EchoSolicitationConflictError("echo.revision_conflict", "征集版本已变化，请刷新后重试"), "echo.revision_conflict");
      }
      await db.prepare(`
        INSERT INTO echo_solicitation_idempotency (
          space_id, actor_user_id, operation, idempotency_key, request_hash,
          solicitation_id, result_json, created_at
        ) VALUES (?, ?, 'vote', ?, ?, ?, NULL, ?)
      `).run(spaceId, actor.id, idempotencyKey, requestHash, current.id, timestamp);
      const result = await projectSolicitation(db, { actor, spaceId, publicId, now: input.now });
      await saveResult(db, spaceId, actor.id, "vote", idempotencyKey, result);
      await audit(db, input.request, actor, spaceId, "echo.solicitation.vote", publicId, "success", "vote");
      return result;
    });
  } catch (error) {
    await auditRejection(db, input.request, actor, spaceId, "echo.solicitation.vote", error);
    throw error;
  }
}

export async function listSolicitationVotes(db, input) {
  const spaceId = normalizeIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireActor(db, input.actorId, spaceId);
  requireOwner(actor, "echo.solicitation.votes.read");
  const row = await getSolicitationRow(db, spaceId, normalizePublicId(input.publicId));
  if (!row) throw new EchoSolicitationNotFoundError();
  const rows = await db.prepare(`
    SELECT v.id, v.voter_user_id AS voterUserId, u.display_name AS voterDisplayName,
      u.github_login AS voterGithubLogin, v.selection_json AS selectionJson,
      v.revision, v.created_at AS createdAt, v.updated_at AS updatedAt
    FROM echo_solicitation_votes v INNER JOIN users u ON u.id = v.voter_user_id
    WHERE v.solicitation_id = ? ORDER BY v.updated_at ASC, v.id ASC
  `).all(row.id);
  return rows.map((vote) => ({
    id: vote.id,
    voterUserId: vote.voterUserId,
    voterDisplayName: vote.voterDisplayName,
    voterGithubLogin: vote.voterGithubLogin,
    optionIds: parseSelection(vote.selectionJson),
    revision: Number(vote.revision),
    createdAt: asTimestamp(vote.createdAt),
    updatedAt: asTimestamp(vote.updatedAt)
  }));
}

export async function listSolicitationDeliveries(db, input) {
  const spaceId = normalizeIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const actor = await requireActor(db, input.actorId, spaceId);
  requireOwner(actor, "echo.solicitation.deliveries.read");
  const row = await getSolicitationRow(db, spaceId, normalizePublicId(input.publicId));
  if (!row) throw new EchoSolicitationNotFoundError();
  const rows = await db.prepare(`
    SELECT d.id, d.recipient_user_id AS recipientUserId, u.display_name AS recipientDisplayName,
      u.github_login AS recipientGithubLogin, d.status, d.attempt_count AS attemptCount,
      d.last_error_code AS lastErrorCode, d.delivered_at AS deliveredAt,
      d.created_at AS createdAt, d.updated_at AS updatedAt
    FROM echo_solicitation_deliveries d INNER JOIN users u ON u.id = d.recipient_user_id
    WHERE d.solicitation_id = ? ORDER BY d.created_at ASC, d.id ASC
  `).all(row.id);
  return rows.map((delivery) => ({
    ...delivery,
    attemptCount: Number(delivery.attemptCount),
    deliveredAt: delivery.deliveredAt ? asTimestamp(delivery.deliveredAt) : null,
    createdAt: asTimestamp(delivery.createdAt),
    updatedAt: asTimestamp(delivery.updatedAt)
  }));
}

export async function markSolicitationDelivery(db, input) {
  const deliveryId = normalizeIdentifier(input.deliveryId, "echo.delivery_invalid");
  const status = ["sent", "failed", "skipped", "pending"].includes(input.status) ? input.status : null;
  if (!status) throw new EchoSolicitationError("echo.delivery_invalid", "投递状态无效");
  const timestamp = iso(input.now);
  const result = await db.prepare(`
    UPDATE echo_solicitation_deliveries
    SET status = ?, attempt_count = attempt_count + 1, last_error_code = ?,
      delivered_at = CASE WHEN ? = 'sent' THEN ? ELSE delivered_at END, updated_at = ?
    WHERE id = ? AND space_id = ?
  `).run(status, input.errorCode ? String(input.errorCode).slice(0, 128) : null, status, timestamp, timestamp, deliveryId, input.spaceId ?? DEFAULT_SPACE_ID);
  if (result.changes !== 1) throw new EchoSolicitationNotFoundError();
  return { deliveryId, status };
}

/**
 * Safe handoff for a shared Workspace writer. It deliberately exposes only
 * routing metadata; writers must fetch an actor-filtered card projection and
 * never receive requirement/solicitation bodies or option contents here.
 */
export async function projectSolicitationDelivery(db, input) {
  const spaceId = normalizeIdentifier(input.spaceId ?? DEFAULT_SPACE_ID, "echo.invalid_space");
  const deliveryId = normalizeIdentifier(input.deliveryId, "echo.delivery_invalid");
  const row = await db.prepare(`
    SELECT d.id AS deliveryId, d.solicitation_id AS solicitationId,
      d.recipient_user_id AS recipientUserId, d.status,
      s.public_id AS publicId, s.revision
    FROM echo_solicitation_deliveries d
    INNER JOIN echo_solicitations s ON s.id = d.solicitation_id AND s.space_id = d.space_id
    WHERE d.id = ? AND d.space_id = ?
  `).get(deliveryId, spaceId);
  if (!row) throw new EchoSolicitationNotFoundError();
  return {
    type: "echo.solicitation.delivery",
    deliveryId: row.deliveryId,
    solicitationId: row.solicitationId,
    publicId: row.publicId,
    recipientUserId: row.recipientUserId,
    status: row.status,
    revision: Number(row.revision)
  };
}

export async function projectSolicitationCard(db, input) {
  const result = await getSolicitation(db, input);
  return {
    block: {
      type: "card",
      cardId: `echo_sol_${result.publicId.toLowerCase()}`,
      cardType: ECHO_SOLICITATION_CARD_TYPE,
      schemaVersion: ECHO_SOLICITATION_CARD_SCHEMA_VERSION,
      fallbackText: `回声征集 ${result.publicId}: ${truncate(result.title, 80, 384)}`
    },
    payload: result.cardPayload
  };
}

export const ECHO_SOLICITATION_CARD_DEFINITION = Object.freeze({
  cardType: ECHO_SOLICITATION_CARD_TYPE,
  schemaVersion: ECHO_SOLICITATION_CARD_SCHEMA_VERSION,
  allowPublicUrls: false,
  limits: Object.freeze({ maxPayloadBytes: 20 * 1024, maxTextBytes: 14 * 1024 }),
  validatePayload: validateSolicitationCardPayload,
  actions: createSolicitationCardActions()
});

function createSolicitationCardActions(solicitations = null) {
  return {
    vote: {
      validateInput: validateSolicitationVoteActionInput,
      authorize: ({ actor }) => actor.kind === "human" && actor.role !== "auditor",
      async execute({ db, actor, card, payload, input, request }) {
        const idempotencyKey = normalizeActionIdempotencyKey(input.idempotencyKey);
        const service = solicitations ?? createEchoSolicitationService({ db, spaceId: card.spaceId });
        const result = await service.vote({
          spaceId: card.spaceId,
          actorId: actor.id,
          publicId: payload.publicId,
          optionIds: input.optionIds,
          expectedRevision: card.revision,
          idempotencyKey,
          request
        });
        const projection = await service.projectCard({
          spaceId: card.spaceId,
          actorId: actor.id,
          publicId: result.publicId,
          request
        });
        return {
          cardPayload: projection.payload,
          result: safeSolicitationActionResult(result)
        };
      }
    }
  };
}

export function createEchoSolicitationCardRegistry(options = {}) {
  const definition = options.solicitations
    ? { ...ECHO_SOLICITATION_CARD_DEFINITION, actions: createSolicitationCardActions(options.solicitations) }
    : ECHO_SOLICITATION_CARD_DEFINITION;
  return createCardRegistry([definition]);
}

export function createEchoSolicitationCardActions(solicitations = null) {
  return createSolicitationCardActions(solicitations);
}

async function projectSolicitation(db, { actor, spaceId, publicId, now, request }) {
  let row = await getSolicitationRow(db, spaceId, publicId);
  if (!row || row.status === "draft" && row.ownerUserId !== actor.id) {
    await audit(db, request, actor, spaceId, "echo.solicitation.read", publicId, "rejected", "echo.solicitation_not_found");
    throw new EchoSolicitationNotFoundError();
  }
  const timestamp = iso(now);
  if (row.status === "open" && row.deadline && new Date(row.deadline).getTime() <= new Date(timestamp).getTime()) {
    await closeIfExpired(db, row, timestamp);
    row = await getSolicitationRow(db, spaceId, publicId);
  }
  const options = await db.prepare(`
    SELECT id, label, position FROM echo_solicitation_options WHERE solicitation_id = ? ORDER BY position ASC
  `).all(row.id);
  const votes = await db.prepare(`SELECT selection_json AS selectionJson FROM echo_solicitation_votes WHERE solicitation_id = ?`).all(row.id);
  const counts = Object.fromEntries(options.map((option) => [option.id, 0]));
  for (const vote of votes) for (const optionId of parseSelection(vote.selectionJson)) if (optionId in counts) counts[optionId] += 1;
  const own = await db.prepare(`SELECT selection_json AS selectionJson FROM echo_solicitation_votes WHERE solicitation_id = ? AND voter_user_id = ?`).get(row.id, actor.id);
  const owner = row.ownerUserId === actor.id;
  const publicCounts = row.resultVisibility === "aggregate" || owner ? counts : null;
  const cardPayload = normalizeCardPayload({
    publicId: row.publicId,
    title: truncate(row.title, 120, 512),
    description: truncate(row.description, 3_000, 3_500),
    question: truncate(row.question, 2_000, 2_500),
    status: row.status,
    deadline: row.deadline ? asTimestamp(row.deadline) : null,
    revision: Number(row.revision),
    choiceMode: row.choiceMode,
    minSelections: Number(row.minSelections),
    maxSelections: Number(row.maxSelections),
    allowVoteChange: Boolean(row.allowVoteChange),
    options: options.map((option) => ({ id: option.id, label: truncate(option.label, 256, 192), position: Number(option.position), count: publicCounts ? counts[option.id] : null })),
    selectedOptionIds: own ? parseSelection(own.selectionJson) : [],
    owner: owner,
    voteCount: owner || row.resultVisibility === "aggregate" ? votes.length : null
  }, { limits: ECHO_SOLICITATION_CARD_DEFINITION.limits });
  return {
    id: row.id,
    publicId: row.publicId,
    spaceId: row.spaceId,
    ownerUserId: row.ownerUserId,
    title: row.title,
    description: row.description,
    question: row.question,
    choiceMode: row.choiceMode,
    minSelections: Number(row.minSelections),
    maxSelections: Number(row.maxSelections),
    allowVoteChange: Boolean(row.allowVoteChange),
    resultVisibility: row.resultVisibility,
    deliveryPolicy: row.deliveryPolicy,
    status: row.status,
    deadline: row.deadline ? asTimestamp(row.deadline) : null,
    revision: Number(row.revision),
    options: options.map((option) => ({ id: option.id, label: option.label, position: Number(option.position) })),
    counts: publicCounts,
    selectedOptionIds: own ? parseSelection(own.selectionJson) : [],
    voteCount: owner || row.resultVisibility === "aggregate" ? votes.length : null,
    ownerProjection: owner ? {
      deliverySummary: await deliverySummary(db, row.id),
      canViewVoters: true
    } : null,
    cardPayload,
    createdAt: asTimestamp(row.createdAt),
    updatedAt: asTimestamp(row.updatedAt),
    publishedAt: row.publishedAt ? asTimestamp(row.publishedAt) : null,
    closedAt: row.closedAt ? asTimestamp(row.closedAt) : null,
    withdrawnAt: row.withdrawnAt ? asTimestamp(row.withdrawnAt) : null
  };
}

async function closeIfExpired(db, row, timestamp) {
  if (row.status !== "open" || !row.deadline || new Date(row.deadline).getTime() > new Date(timestamp).getTime()) return false;
  await db.prepare(`UPDATE echo_solicitations SET status = 'closed', closed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'open'`)
    .run(timestamp, timestamp, row.id);
  return true;
}

async function createDeliveryRows(db, row, timestamp) {
  const recipients = await db.prepare(`
    SELECT sm.user_id AS userId
    FROM space_members sm INNER JOIN users u ON u.id = sm.user_id
    WHERE sm.space_id = ? AND sm.removed_at IS NULL AND u.kind = 'human'
  `).all(row.spaceId);
  for (const recipient of recipients) {
    await db.prepare(`
      INSERT INTO echo_solicitation_deliveries (
        id, space_id, solicitation_id, recipient_user_id, status, attempt_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (solicitation_id, recipient_user_id) DO NOTHING
    `).run(`echo_sol_delivery_${randomUUID()}`, row.spaceId, row.id, recipient.userId, timestamp, timestamp);
  }
}

async function deliverySummary(db, solicitationId) {
  const rows = await db.prepare(`SELECT status, COUNT(*) AS count FROM echo_solicitation_deliveries WHERE solicitation_id = ? GROUP BY status`).all(solicitationId);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

async function getSolicitationRow(db, spaceId, publicId) {
  const row = await db.prepare(`
    SELECT id, public_id AS publicId, space_id AS spaceId, owner_user_id AS ownerUserId,
      title, description, question, choice_mode AS choiceMode,
      min_selections AS minSelections, max_selections AS maxSelections,
      allow_vote_change AS allowVoteChange, result_visibility AS resultVisibility,
      delivery_policy AS deliveryPolicy, status, deadline, revision,
      idempotency_key AS idempotencyKey, created_at AS createdAt, updated_at AS updatedAt,
      published_at AS publishedAt, closed_at AS closedAt, withdrawn_at AS withdrawnAt
    FROM echo_solicitations WHERE space_id = ? AND public_id = ?
  `).get(spaceId, publicId);
  return row ?? null;
}

async function requireActor(db, actorId, spaceId) {
  const userId = normalizeIdentifier(actorId, "auth.required");
  const actor = await db.prepare(`
    SELECT u.id, u.github_login AS githubLogin, u.kind, sm.role, sm.removed_at AS removedAt
    FROM users u INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ?
    WHERE u.id = ? AND sm.removed_at IS NULL
  `).get(spaceId, userId);
  if (!actor || actor.kind !== "human") throw new EchoSolicitationError("auth.required", "请先登录共享空间", 401);
  return actor;
}

function requireOwner(actor, action) {
  if (actor.role !== "owner") throw reject(new EchoSolicitationPermissionError(), "echo.permission_denied", action);
}

function normalizeCreateInput(input) {
  const title = boundedText(input.title, "echo.title_invalid", ECHO_SOLICITATION_LIMITS.titleCodePoints, ECHO_SOLICITATION_LIMITS.titleBytes);
  const description = boundedText(input.description ?? input.detail, "echo.description_invalid", ECHO_SOLICITATION_LIMITS.bodyCodePoints, ECHO_SOLICITATION_LIMITS.bodyBytes);
  const question = boundedText(input.question, "echo.question_invalid", ECHO_SOLICITATION_LIMITS.bodyCodePoints, ECHO_SOLICITATION_LIMITS.bodyBytes);
  if (!Array.isArray(input.options) || input.options.length < ECHO_SOLICITATION_LIMITS.minOptions || input.options.length > ECHO_SOLICITATION_LIMITS.maxOptions) throw new EchoSolicitationError("echo.options_invalid", "征集选项数量无效");
  const options = input.options.map((option) => boundedText(typeof option === "string" ? option : option?.label, "echo.option_invalid", ECHO_SOLICITATION_LIMITS.optionCodePoints, ECHO_SOLICITATION_LIMITS.optionBytes));
  if (new Set(options.map((option) => option.toLocaleLowerCase())).size !== options.length) throw new EchoSolicitationError("echo.options_invalid", "征集选项不能重复");
  const choiceMode = input.choiceMode ?? "single";
  if (!ECHO_SOLICITATION_CHOICE_MODES.includes(choiceMode)) throw new EchoSolicitationError("echo.choice_mode_invalid", "选择模式无效");
  const minSelections = input.minSelections === undefined ? 1 : integer(input.minSelections, "echo.selection_invalid");
  const maxSelections = input.maxSelections === undefined ? (choiceMode === "single" ? 1 : options.length) : integer(input.maxSelections, "echo.selection_invalid");
  if (choiceMode === "single" && (minSelections !== 1 || maxSelections !== 1) || minSelections < 1 || maxSelections < minSelections || maxSelections > options.length) throw new EchoSolicitationError("echo.selection_invalid", "选择数量范围无效");
  if (input.allowVoteChange !== undefined && typeof input.allowVoteChange !== "boolean") throw new EchoSolicitationError("echo.vote_policy_invalid", "投票修改策略无效");
  const resultVisibility = input.resultVisibility ?? "aggregate";
  if (!["aggregate", "owner"].includes(resultVisibility)) throw new EchoSolicitationError("echo.result_visibility_invalid", "结果可见性无效");
  const deliveryPolicy = input.deliveryPolicy ?? "all_active_members";
  if (!["all_active_members", "none"].includes(deliveryPolicy)) throw new EchoSolicitationError("echo.delivery_policy_invalid", "投递策略无效");
  const deadline = input.deadline === undefined || input.deadline === null || input.deadline === "" ? null : iso(input.deadline);
  return { title, description, question, options, choiceMode, minSelections, maxSelections, allowVoteChange: input.allowVoteChange !== false, resultVisibility, deliveryPolicy, deadline };
}

function normalizeOptionIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > ECHO_SOLICITATION_LIMITS.maxOptions) throw new EchoSolicitationError("echo.selection_invalid", "投票选项无效");
  const result = value.map((item) => normalizeIdentifier(item, "echo.option_invalid"));
  if (new Set(result).size !== result.length) throw new EchoSolicitationError("echo.selection_invalid", "投票选项不能重复");
  return result;
}

function normalizePublicId(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^SOL-\d{4}-\d{4}$/.test(normalized)) throw new EchoSolicitationError("echo.solicitation_id_invalid", "征集编号无效");
  return normalized;
}

function normalizeStatus(value) {
  if (!ECHO_SOLICITATION_STATUSES.includes(value)) throw new EchoSolicitationError("echo.status_invalid", "征集状态无效");
  return value;
}

function normalizeIdempotencyKey(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || Buffer.byteLength(normalized, "utf8") > ECHO_SOLICITATION_LIMITS.idempotencyKeyBytes || !/^[A-Za-z0-9._:-]+$/.test(normalized)) throw new EchoSolicitationError("echo.idempotency_key_invalid", "幂等键无效");
  return normalized;
}

function normalizeIdentifier(value, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) throw new EchoSolicitationError(code, code === "auth.required" ? "请先登录共享空间" : "标识无效", code === "auth.required" ? 401 : 400);
  return normalized;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") return ECHO_SOLICITATION_LIMITS.listLimit;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new EchoSolicitationError("echo.limit_invalid", "列表数量无效");
  return Math.min(result, ECHO_SOLICITATION_LIMITS.listLimit);
}

function normalizeRevision(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new EchoSolicitationError("echo.expected_revision_invalid", "征集版本无效");
  return result;
}

function boundedText(value, code, maxCodePoints, maxBytes) {
  if (typeof value !== "string") throw new EchoSolicitationError(code, "内容不能为空");
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(normalized) || Array.from(normalized).length > maxCodePoints || Buffer.byteLength(normalized, "utf8") > maxBytes) throw new EchoSolicitationError(code, "内容无效或超出长度限制");
  return normalized;
}

function integer(value, code) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new EchoSolicitationError(code, "数量无效");
  return result;
}

function iso(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new EchoSolicitationError("echo.invalid_time", "时间无效");
  return date.toISOString();
}

function asTimestamp(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseSelection(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function nextNumber(db, spaceId, year) {
  const row = await db.prepare(`SELECT next_number AS nextNumber FROM echo_solicitation_sequences WHERE space_id = ? AND sequence_year = ?`).get(spaceId, year);
  const number = Number(row?.nextNumber ?? 1);
  if (!Number.isSafeInteger(number) || number > 9_999) throw new EchoSolicitationError("echo.sequence_exhausted", "本年度征集编号已用尽", 409);
  if (row) await db.prepare(`UPDATE echo_solicitation_sequences SET next_number = ? WHERE space_id = ? AND sequence_year = ? AND next_number = ?`).run(number + 1, spaceId, year, number);
  else await db.prepare(`INSERT INTO echo_solicitation_sequences (space_id, sequence_year, next_number) VALUES (?, ?, ?)`).run(spaceId, year, 2);
  return number;
}

async function getIdempotency(db, spaceId, actorId, operation, key) {
  return await db.prepare(`SELECT request_hash AS requestHash, solicitation_id AS solicitationId, result_json AS resultJson FROM echo_solicitation_idempotency WHERE space_id = ? AND actor_user_id = ? AND operation = ? AND idempotency_key = ?`).get(spaceId, actorId, operation, key);
}

async function saveResult(db, spaceId, actorId, operation, key, result) {
  await db.prepare(`UPDATE echo_solicitation_idempotency SET result_json = ? WHERE space_id = ? AND actor_user_id = ? AND operation = ? AND idempotency_key = ?`).run(JSON.stringify(result), spaceId, actorId, operation, key);
}

async function replayResult(db, existing, actor, spaceId, now) {
  if (existing.resultJson) {
    try {
      const result = JSON.parse(existing.resultJson);
      if (result && result.publicId) return result;
    } catch {
      // Legacy row: return the current authorized projection.
    }
  }
  return await projectSolicitation(db, { actor, spaceId, publicId: (await getSolicitationById(db, spaceId, existing.solicitationId)).publicId, now });
}

async function getSolicitationById(db, spaceId, id) {
  const row = await db.prepare(`SELECT public_id AS publicId FROM echo_solicitations WHERE space_id = ? AND id = ?`).get(spaceId, id);
  if (!row) throw new EchoSolicitationNotFoundError();
  return row;
}

function hashRequest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function truncate(value, maxCodePoints, maxBytes = Number.POSITIVE_INFINITY) {
  const text = typeof value === "string" ? value : "";
  const points = Array.from(text);
  if (points.length <= maxCodePoints && Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let result = "";
  for (const point of points) {
    const candidate = `${result}${point}`;
    if (Array.from(candidate).length >= maxCodePoints || Buffer.byteLength(`${candidate}…`, "utf8") > maxBytes) break;
    result = candidate;
  }
  return `${result}…`;
}

function validateSolicitationCardPayload(payload) {
  if (!payload || typeof payload !== "object" || !/^SOL-\d{4}-\d{4}$/.test(payload.publicId ?? "") || !ECHO_SOLICITATION_STATUSES.includes(payload.status) || !Array.isArray(payload.options) || payload.options.length < 2 || payload.options.length > ECHO_SOLICITATION_LIMITS.maxOptions) throw new CardValidationError("card.domain_invalid", "征集卡片数据无效");
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 1) throw new CardValidationError("card.domain_invalid", "征集卡片版本无效");
  return payload;
}

function validateSolicitationVoteActionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CardValidationError("card.action_input_invalid", "投票参数无效");
  }
  const optionIds = normalizeOptionIds(input.optionIds ?? input.selectedOptionIds);
  const idempotencyKey = normalizeActionIdempotencyKey(input.idempotencyKey);
  return { optionIds, idempotencyKey };
}

function normalizeActionIdempotencyKey(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || Buffer.byteLength(normalized, "utf8") > ECHO_SOLICITATION_LIMITS.idempotencyKeyBytes || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new CardValidationError("card.action_input_invalid", "操作幂等键无效");
  }
  return normalized;
}

function safeSolicitationActionResult(result) {
  return {
    publicId: result.publicId,
    status: result.status,
    revision: result.revision,
    selectedOptionIds: result.selectedOptionIds,
    counts: result.counts,
    voteCount: result.voteCount
  };
}

function reject(error, reason, action = null) {
  Object.defineProperty(error, "echoAudit", { configurable: true, enumerable: false, value: { reason, action } });
  return error;
}

async function audit(db, request, actor, spaceId, action, targetId, result, reason) {
  await writeAudit(db, {
    id: request?.auditId,
    spaceId,
    actorUserId: actor?.id ?? null,
    actorGithubLogin: actor?.githubLogin ?? null,
    action,
    targetType: "echo.solicitation",
    targetId: targetId ?? null,
    result,
    reason: reason ?? null,
    ipAddress: request?.ipAddress,
    userAgent: request?.userAgent,
    requestId: request?.requestId
  });
}

async function auditRejection(db, request, actor, spaceId, action, error) {
  const reason = error?.echoAudit?.reason ?? error?.code ?? "internal.error";
  try { await audit(db, request, actor, spaceId, action, null, "rejected", reason); } catch { /* preserve the domain error */ }
}
