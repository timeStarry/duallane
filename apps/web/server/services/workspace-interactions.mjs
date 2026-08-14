import { createHash, randomUUID } from "node:crypto";
import { writeAudit } from "./audit.mjs";
import { normalizeCardPayload } from "./workspace-cards.mjs";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKFLOW_STATUS = new Set(["active", "completed", "cancelled", "expired", "conflicted"]);
const DEFAULT_WORKFLOW_TTL_MS = 30 * 60 * 1000;
const MAX_WORKFLOW_TTL_MS = 24 * 60 * 60 * 1000;

export class WorkspaceInteractionError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceInteractionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createWorkspaceInteractionService({
  db,
  commandRegistry,
  workflowRegistry,
  now = () => new Date(),
  idFactory = randomUUID
} = {}) {
  if (!db) throw new TypeError("Workspace interaction service requires a database");
  if (!commandRegistry || typeof commandRegistry.recognize !== "function") {
    throw new TypeError("Workspace interaction service requires a command registry");
  }
  if (!workflowRegistry || typeof workflowRegistry.get !== "function") {
    throw new TypeError("Workspace interaction service requires a workflow registry");
  }

  async function executeCommand(input = {}) {
    const spaceId = normalizeIdentifier(input.spaceId, "space.invalid", "空间 ID 无效");
    const conversationId = normalizeIdentifier(input.conversationId, "conversation.invalid", "会话 ID 无效");
    const botUserId = normalizeIdentifier(input.botUserId, "bot.invalid_id", "Bot ID 无效");
    const clientInvocationId = normalizeIdentifier(
      input.clientInvocationId,
      "command.invalid_client_invocation_id",
      "客户端调用 ID 无效"
    );
    const actor = await requireActor(db, input.actorId, spaceId);
    const context = await requireCommandContext(db, actor.id, botUserId, conversationId, spaceId);
    const recognized = commandRegistry.recognize(input.source, {
      conversationType: context.type,
      botUserId,
      mentionedBotIds: input.mentionedBotIds ?? []
    });
    if (!recognized) throw new WorkspaceInteractionError("command.not_triggered", "当前消息不会触发 Bot 命令", 422);
    if (recognized.type === "unknown_command") {
      throw new WorkspaceInteractionError("command.unknown", "命令不存在", 404);
    }
    const definition = recognized.definition;
    const requestHash = hashRequest({
      spaceId,
      conversationId,
      botUserId,
      command: definition.name,
      version: definition.version,
      arguments: recognized.arguments
    });
    const outcome = await db.transaction(async () => {
      await db.lock?.(`workspace-command:${spaceId}:${actor.id}:${clientInvocationId}`);
      const existing = await db.prepare(`
        SELECT status, request_hash AS requestHash, result_json AS resultJson, error_code AS errorCode,
          result_card_id AS resultCardId
        FROM workspace_command_runs
        WHERE space_id = ? AND actor_user_id = ? AND client_invocation_id = ?
      `).get(spaceId, actor.id, clientInvocationId);
      if (existing) {
        if (existing.requestHash !== requestHash) return failure(new WorkspaceInteractionError("command.idempotency_conflict", "调用标识已用于其他命令", 409));
        if (existing.status === "succeeded") {
          return { ok: true, replayed: true, result: parseJson(existing.resultJson, {}), resultCardId: existing.resultCardId ?? null };
        }
        if (existing.status === "failed") return failure(new WorkspaceInteractionError(existing.errorCode ?? "command.failed", "命令执行失败", 409));
        return failure(new WorkspaceInteractionError("command.in_progress", "命令正在执行", 409));
      }
      const runId = `cmd_${idFactory()}`;
      const startedAt = now().toISOString();
      await db.prepare(`
        INSERT INTO workspace_command_runs (
          id, space_id, conversation_id, actor_user_id, bot_user_id, command_name, command_version,
          client_invocation_id, request_hash, arguments_json, status, result_card_id, result_json,
          error_code, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL)
      `).run(
        runId, spaceId, conversationId, actor.id, botUserId, definition.name, definition.version,
        clientInvocationId, requestHash, JSON.stringify(recognized.arguments), startedAt
      );
      let error;
      try {
        if (definition.authorize) {
          const allowed = await definition.authorize({ db, actor, context, botUserId, arguments: recognized.arguments });
          if (allowed === false) throw new WorkspaceInteractionError("permission.denied", "无权执行该命令", 403);
        }
        const executed = await db.transaction(async () => definition.execute({
          db,
          actor,
          context,
          botUserId,
          arguments: recognized.arguments,
          request: input.request,
          clientInvocationId
        })) ?? {};
        const safeResult = normalizeCardPayload(executed.result ?? {}, {
          limits: { maxPayloadBytes: 32 * 1024, maxDepth: 8, maxNodes: 200, maxTextBytes: 16 * 1024 }
        });
        const resultCardId = normalizeOptionalIdentifier(
          executed.resultCardId,
          "command.invalid_result_card",
          "命令结果卡片无效"
        );
        await db.prepare(`
          UPDATE workspace_command_runs
          SET status = 'succeeded', result_card_id = ?, result_json = ?, completed_at = ?
          WHERE id = ?
        `).run(resultCardId, JSON.stringify(safeResult), now().toISOString(), runId);
        await auditInteraction(db, actor, spaceId, `command.${definition.name}`, "workspace.command", runId, "success", null, input.request);
        return { ok: true, replayed: false, result: safeResult, resultCardId };
      } catch (caught) {
        error = toInteractionError(caught, "command.failed", "命令执行失败");
      }
      await db.prepare(`
        UPDATE workspace_command_runs SET status = 'failed', error_code = ?, completed_at = ? WHERE id = ?
      `).run(error.code, now().toISOString(), runId);
      await auditInteraction(db, actor, spaceId, `command.${definition.name}`, "workspace.command", runId, "rejected", error.code, input.request);
      return failure(error);
    });
    if (!outcome.ok) throw outcome.error;
    return outcome;
  }

  async function startWorkflow(input = {}) {
    const spaceId = normalizeIdentifier(input.spaceId, "space.invalid", "空间 ID 无效");
    const actor = await requireActor(db, input.actorId, spaceId);
    const type = typeof input.type === "string" ? input.type.trim().toLowerCase() : "";
    const version = Number.isSafeInteger(input.version) ? input.version : 1;
    const definition = workflowRegistry.get(type, version);
    if (!definition) throw new WorkspaceInteractionError("workflow.unknown", "引导流程不存在", 404);
    const conversationId = normalizeOptionalIdentifier(input.conversationId, "conversation.invalid", "会话 ID 无效");
    const botUserId = normalizeOptionalIdentifier(input.botUserId, "bot.invalid_id", "Bot ID 无效");
    if (conversationId) await requireConversationActor(db, actor.id, conversationId, spaceId);
    if (definition.authorize) {
      const allowed = await definition.authorize({ db, actor, operation: "start", input: input.input ?? {} });
      if (allowed === false) throw new WorkspaceInteractionError("permission.denied", "无权发起该流程", 403);
    }
    const initialized = await definition.initialize({ db, actor, input: input.input ?? {}, conversationId, botUserId }) ?? {};
    const state = validateWorkflowState(definition, initialized.state ?? {});
    const createdAt = now();
    const ttlMs = normalizeTtl(input.ttlMs);
    const workflowId = `wf_${idFactory()}`;
    await db.prepare(`
      INSERT INTO workspace_workflow_sessions (
        id, space_id, conversation_id, actor_user_id, bot_user_id, workflow_type, workflow_version,
        state_json, status, revision, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
    `).run(
      workflowId, spaceId, conversationId, actor.id, botUserId, type, version,
      JSON.stringify(state), new Date(createdAt.getTime() + ttlMs).toISOString(), createdAt.toISOString(), createdAt.toISOString()
    );
    return projectWorkflow(definition, await loadWorkflow(db, workflowId), actor);
  }

  async function getWorkflow(actorUserId, workflowId) {
    const row = await requireWorkflow(db, actorUserId, workflowId);
    const definition = workflowRegistry.get(row.workflowType, row.workflowVersion);
    if (!definition) throw new WorkspaceInteractionError("workflow.unknown_version", "引导流程版本暂不支持", 422);
    return projectWorkflow(definition, row, await requireActor(db, actorUserId, row.spaceId));
  }

  async function continueWorkflow(actorUserId, input = {}) {
    const workflowId = normalizeIdentifier(input.workflowId, "workflow.invalid_id", "引导流程 ID 无效");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new WorkspaceInteractionError("workflow.invalid_revision", "引导流程版本无效");
    }
    const outcome = await db.transaction(async () => {
      await db.lock?.(`workspace-workflow:${workflowId}`);
      const row = await loadWorkflow(db, workflowId);
      if (!row) return failure(workflowNotFound());
      let actor;
      try {
        actor = await requireActor(db, actorUserId, row.spaceId);
      } catch (error) {
        return failure(error);
      }
      if (row.actorUserId !== actor.id) return failure(workflowNotFound());
      const definition = workflowRegistry.get(row.workflowType, row.workflowVersion);
      if (!definition) return failure(new WorkspaceInteractionError("workflow.unknown_version", "引导流程版本暂不支持", 422));
      if (row.status !== "active") return failure(new WorkspaceInteractionError("workflow.not_active", "引导流程已结束", 409));
      if (new Date(row.expiresAt).getTime() <= now().getTime()) {
        await db.prepare("UPDATE workspace_workflow_sessions SET status = 'expired', updated_at = ? WHERE id = ?")
          .run(now().toISOString(), workflowId);
        return failure(new WorkspaceInteractionError("workflow.expired", "引导流程已过期", 409));
      }
      if (row.revision !== input.expectedRevision) return failure(new WorkspaceInteractionError("workflow.stale_revision", "引导流程状态已变化", 409));
      try {
        if (definition.authorize) {
          const allowed = await definition.authorize({ db, actor, operation: "continue", workflow: publicWorkflow(row), input: input.input ?? {} });
          if (allowed === false) throw workflowNotFound();
        }
        const currentState = parseJson(row.stateJson, {});
        const continued = await db.transaction(async () => definition.continue({
          db,
          actor,
          workflow: publicWorkflow(row),
          state: currentState,
          input: input.input ?? {}
        })) ?? {};
        const nextState = validateWorkflowState(definition, continued.state ?? currentState);
        const status = normalizeWorkflowStatus(continued.status ?? "active");
        const revision = row.revision + 1;
        await db.prepare(`
          UPDATE workspace_workflow_sessions
          SET state_json = ?, status = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(JSON.stringify(nextState), status, revision, now().toISOString(), row.id, row.revision);
        const updated = await loadWorkflow(db, row.id);
        return { ok: true, workflow: await projectWorkflow(definition, updated, actor), result: continued.result ?? null };
      } catch (error) {
        return failure(toInteractionError(error, "workflow.failed", "引导流程处理失败"));
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome;
  }

  async function cancelWorkflow(actorUserId, workflowId) {
    const row = await requireWorkflow(db, actorUserId, workflowId);
    if (row.status !== "active") return getWorkflow(actorUserId, row.id);
    await db.prepare(`
      UPDATE workspace_workflow_sessions
      SET status = 'cancelled', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'active'
    `).run(now().toISOString(), row.id);
    return getWorkflow(actorUserId, row.id);
  }

  return { executeCommand, startWorkflow, getWorkflow, continueWorkflow, cancelWorkflow };
}

async function requireCommandContext(db, actorId, botUserId, conversationId, spaceId) {
  const conversation = await db.prepare(`
    SELECT id, type FROM conversations WHERE id = ? AND space_id = ?
  `).get(conversationId, spaceId);
  if (!conversation) throw new WorkspaceInteractionError("conversation.not_found", "会话不存在", 404);
  await requireConversationActor(db, actorId, conversationId, spaceId);
  const bot = await db.prepare(`
    SELECT u.id, u.kind
    FROM users u JOIN conversation_members cm ON cm.user_id = u.id
    WHERE u.id = ? AND cm.conversation_id = ? AND cm.removed_at IS NULL
  `).get(botUserId, conversationId);
  if (!bot || !["bot", "system"].includes(bot.kind)) throw new WorkspaceInteractionError("bot.not_available", "Bot 不在当前会话中", 404);
  return conversation;
}

async function requireConversationActor(db, actorId, conversationId, spaceId) {
  const membership = await db.prepare(`
    SELECT 1 AS allowed
    FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE c.id = ? AND c.space_id = ? AND cm.user_id = ? AND cm.removed_at IS NULL
  `).get(conversationId, spaceId, actorId);
  if (!membership) throw new WorkspaceInteractionError("conversation.not_found", "会话不存在", 404);
}

async function requireActor(db, actorUserId, spaceId) {
  const actorId = normalizeIdentifier(actorUserId, "auth.required", "请先登录共享空间");
  const actor = await db.prepare(`
    SELECT u.id, u.github_login AS githubLogin, u.kind, sm.role
    FROM users u JOIN space_members sm ON sm.user_id = u.id
    WHERE u.id = ? AND sm.space_id = ? AND sm.removed_at IS NULL
  `).get(actorId, spaceId);
  if (!actor || actor.kind !== "human") throw new WorkspaceInteractionError("permission.denied", "需要有效的空间成员身份", 403);
  return actor;
}

async function requireWorkflow(db, actorUserId, workflowId) {
  const id = normalizeIdentifier(workflowId, "workflow.invalid_id", "引导流程 ID 无效");
  const row = await loadWorkflow(db, id);
  if (!row) throw workflowNotFound();
  const actor = await requireActor(db, actorUserId, row.spaceId);
  if (row.actorUserId !== actor.id) throw workflowNotFound();
  return row;
}

async function loadWorkflow(db, id) {
  return db.prepare(`
    SELECT id, space_id AS spaceId, conversation_id AS conversationId, actor_user_id AS actorUserId,
      bot_user_id AS botUserId, workflow_type AS workflowType, workflow_version AS workflowVersion,
      state_json AS stateJson, status, revision, expires_at AS expiresAt,
      created_at AS createdAt, updated_at AS updatedAt
    FROM workspace_workflow_sessions WHERE id = ?
  `).get(id);
}

async function projectWorkflow(definition, row, actor) {
  const state = parseJson(row.stateJson, {});
  const projection = definition.project
    ? await definition.project({ actor, workflow: publicWorkflow(row), state })
    : state;
  return { ...publicWorkflow(row), state: projection };
}

function publicWorkflow(row) {
  return {
    id: row.id,
    spaceId: row.spaceId,
    conversationId: row.conversationId ?? null,
    botUserId: row.botUserId ?? null,
    type: row.workflowType,
    version: row.workflowVersion,
    status: row.status,
    revision: row.revision,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function validateWorkflowState(definition, value) {
  const safe = normalizeCardPayload(value ?? {}, {
    limits: { maxPayloadBytes: 64 * 1024, maxDepth: 8, maxNodes: 300, maxTextBytes: 32 * 1024 }
  });
  return definition.validateState ? definition.validateState(safe) : safe;
}

async function auditInteraction(db, actor, spaceId, action, targetType, targetId, result, reason, request) {
  await writeAudit(db, {
    spaceId,
    actorUserId: actor.id,
    actorGithubLogin: actor.githubLogin,
    action,
    targetType,
    targetId,
    result,
    reason,
    ipAddress: request?.ipAddress,
    userAgent: request?.userAgent,
    requestId: request?.requestId
  });
}

function normalizeIdentifier(value, code, message) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new WorkspaceInteractionError(code, message);
  return normalized;
}

function normalizeOptionalIdentifier(value, code, message) {
  if (value === undefined || value === null || value === "") return null;
  return normalizeIdentifier(value, code, message);
}

function normalizeTtl(value) {
  if (value === undefined || value === null) return DEFAULT_WORKFLOW_TTL_MS;
  if (!Number.isSafeInteger(value) || value < 60_000 || value > MAX_WORKFLOW_TTL_MS) {
    throw new WorkspaceInteractionError("workflow.invalid_ttl", "引导流程有效期无效");
  }
  return value;
}

function normalizeWorkflowStatus(value) {
  if (!WORKFLOW_STATUS.has(value)) throw new WorkspaceInteractionError("workflow.invalid_status", "引导流程状态无效");
  return value;
}

function hashRequest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(value, fallback) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value ?? fallback;
  } catch {
    return fallback;
  }
}

function toInteractionError(error, fallbackCode, fallbackMessage) {
  if (error instanceof WorkspaceInteractionError) return error;
  if (typeof error?.code === "string" && Number.isInteger(error?.statusCode)) {
    return new WorkspaceInteractionError(error.code, error.message || fallbackMessage, error.statusCode);
  }
  return new WorkspaceInteractionError(fallbackCode, fallbackMessage, 500);
}

function workflowNotFound() {
  return new WorkspaceInteractionError("workflow.not_found", "引导流程不存在或不可访问", 404);
}

function failure(error) {
  return { ok: false, error: toInteractionError(error, "interaction.failed", "操作失败") };
}
