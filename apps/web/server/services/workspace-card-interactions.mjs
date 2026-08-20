import { createHash, randomUUID } from "node:crypto";
import { writeAudit } from "./audit.mjs";
import {
  CardValidationError,
  normalizeCardBlock,
  normalizeCardPayload
} from "./workspace-cards.mjs";
import { getSystemIdentityDefinition } from "./system-identities.mjs";
import { runWorkspaceTransaction } from "./workspace.mjs";

const CARD_STATUS = new Set(["active", "invalidated", "expired"]);
const SOURCE_KINDS = new Set(["workspace", "system_bot", "custom_bot", "echo", "topic"]);
const VISIBILITY_SCOPES = new Set(["space", "conversation", "resource"]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class WorkspaceCardInteractionError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceCardInteractionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createWorkspaceCardInteractionService({ db, registry, now = () => new Date(), idFactory = randomUUID } = {}) {
  if (!db) throw new TypeError("Workspace card interaction service requires a database");
  if (!registry || typeof registry.get !== "function") {
    throw new TypeError("Workspace card interaction service requires a card registry");
  }

  async function createCard(input = {}) {
    const spaceId = normalizeIdentifier(input.spaceId, "card.invalid_space", "空间 ID 无效");
    const block = normalizeCardBlock({
      type: "card",
      cardId: input.cardId ?? `card_${idFactory()}`,
      cardType: input.cardType,
      schemaVersion: input.schemaVersion,
      fallbackText: input.fallbackText
    });
    const sourceKind = normalizeEnum(input.sourceKind, SOURCE_KINDS, "card.invalid_source", "卡片来源无效");
    if (sourceKind === "custom_bot" && input.trustedCustomBot !== true) {
      throw new WorkspaceCardInteractionError("card.source_forbidden", "Bot 卡片必须通过受信任网关创建", 403);
    }
    const sourceId = normalizeOptionalIdentifier(input.sourceId, "card.invalid_source", "卡片来源 ID 无效");
    const visibilityScope = normalizeEnum(
      input.visibilityScope,
      VISIBILITY_SCOPES,
      "card.invalid_visibility",
      "卡片可见范围无效"
    );
    const conversationId = normalizeOptionalIdentifier(input.conversationId, "card.invalid_conversation", "会话 ID 无效");
    if (visibilityScope === "conversation" && !conversationId) {
      throw new WorkspaceCardInteractionError("card.conversation_required", "会话卡片必须绑定会话");
    }
    const resourceType = normalizeOptionalIdentifier(input.resourceType, "card.invalid_resource", "卡片资源类型无效");
    const resourceId = normalizeOptionalIdentifier(input.resourceId, "card.invalid_resource", "卡片资源 ID 无效");
    if (visibilityScope === "resource" && (!resourceType || !resourceId)) {
      throw new WorkspaceCardInteractionError("card.resource_required", "资源卡片必须绑定资源");
    }
    const definition = registry.get(block.cardType, block.schemaVersion);
    if (!definition && (input.allowUnknownDefinition !== true || input.trustedCustomBot !== true)) {
      throw new WorkspaceCardInteractionError("card.unknown_version", "卡片版本暂不支持", 422);
    }
    const validated = definition
      ? registry.validatePayload(block, input.payload ?? {})
      : { type: "card", payload: normalizeCardPayload(input.payload ?? {}) };
    if (validated.type !== "card") throw new WorkspaceCardInteractionError("card.unknown_version", "卡片版本暂不支持", 422);
    const createdAt = now().toISOString();
    const expiresAt = normalizeOptionalTimestamp(input.expiresAt, "card.invalid_expiry");
    const card = await db.transaction(async () => {
      await db.lock?.(`workspace-card:create:${spaceId}:${sourceKind}:${sourceId ?? block.cardId}:${block.cardType}`);
      await requireSpace(db, spaceId);
      if (conversationId) await requireConversationInSpace(db, conversationId, spaceId);
      if (input.createdByUserId) await requireUserInSpace(db, input.createdByUserId, spaceId);

      if (sourceId) {
        const existing = await findCardBySource(db, spaceId, sourceKind, sourceId, block.cardType);
        if (existing) {
          if (matchesCreate(existing, {
            block,
            payload: validated.payload,
            conversationId,
            visibilityScope,
            resourceType,
            resourceId,
            createdByUserId: input.createdByUserId ?? null
          })) {
            return projectStoredCard(existing, definition, validated.payload);
          }
          throw new WorkspaceCardInteractionError("card.source_conflict", "卡片来源已绑定其他内容", 409);
        }
      }

      const inserted = await db.prepare(`
        INSERT INTO workspace_cards (
          id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text,
          source_kind, source_id, resource_type, resource_id, visibility_scope,
          created_by_user_id, status, revision, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
      `).run(
        block.cardId,
        spaceId,
        conversationId,
        block.cardType,
        block.schemaVersion,
        JSON.stringify(validated.payload),
        block.fallbackText,
        sourceKind,
        sourceId,
        resourceType,
        resourceId,
        visibilityScope,
        input.createdByUserId ?? null,
        expiresAt,
        createdAt,
        createdAt
      );
      if (inserted.changes > 0) {
        await writeCardEvent(db, {
          type: "card.created",
          spaceId,
          conversationId,
          actorId: input.createdByUserId ?? null,
          cardId: block.cardId,
          cardType: block.cardType,
          revision: 1,
          status: "active"
        });
      }
      return projectStoredCard(await loadCard(db, block.cardId), definition, validated.payload);
    });
    return card;
  }

  async function resolveCard(actorUserId, cardId, request = {}) {
    const normalizedCardId = normalizeIdentifier(cardId, "card.invalid_id", "卡片 ID 无效");
    const row = await loadCard(db, normalizedCardId);
    if (!row) throw notFound();
    const actor = await requireActor(db, actorUserId, row.spaceId);
    const definition = registry.get(row.cardType, row.schemaVersion);
    // Unknown definitions may still be rendered as a safe fallback, but the
    // viewer must pass the same conversation/resource checks first.
    await assertVisible({ db, definition, row, actor, operation: "read", request });
    if (!definition) return fallbackProjection(row);
    const status = effectiveStatus(row, now());
    const payload = parseJson(row.payloadJson, {});
    const projectedPayload = definition.projectPayload
      ? await definition.projectPayload({ db, actor, card: publicCardRow(row, status), payload, request })
      : payload;
    const validated = registry.validatePayload(cardBlock(row), projectedPayload);
    return projectStoredCard(row, definition, validated.payload, status);
  }

  async function validateMessageCardReference(actorUserId, conversationId, inputBlock) {
    const block = normalizeCardBlock(inputBlock);
    const row = await loadCard(db, block.cardId);
    if (!row) throw new WorkspaceCardInteractionError("card.not_found", "卡片不存在或不可发送", 404);
    await requireActor(db, actorUserId, row.spaceId, { allowBot: true, allowSystemBot: true });
    if (
      row.conversationId !== conversationId
      || row.cardType !== block.cardType
      || row.schemaVersion !== block.schemaVersion
      || row.fallbackText !== block.fallbackText
      || effectiveStatus(row, now()) !== "active"
    ) {
      throw new WorkspaceCardInteractionError("card.reference_mismatch", "卡片引用与服务端记录不一致", 409);
    }
    return block;
  }

  async function executeAction(actorUserId, input = {}) {
    const cardId = normalizeIdentifier(input.cardId, "card.invalid_id", "卡片 ID 无效");
    const actionId = normalizeIdentifier(input.actionId, "card.invalid_action", "卡片操作 ID 无效");
    const clientActionId = normalizeIdentifier(
      input.clientActionId,
      "card.invalid_client_action_id",
      "客户端操作 ID 无效"
    );
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new WorkspaceCardInteractionError("card.invalid_revision", "卡片版本无效");
    }
    const outcome = await runWorkspaceTransaction(db, async () => {
      await db.lock?.(`workspace-card:action:${cardId}`);
      const row = await loadCard(db, cardId);
      if (!row) return failure(notFound());
      let actor;
      try {
        actor = await requireActor(db, actorUserId, row.spaceId);
      } catch (error) {
        return failure(error);
      }
      const definition = registry.get(row.cardType, row.schemaVersion);
      if (!definition) return failure(new WorkspaceCardInteractionError("card.unknown_version", "卡片版本暂不支持", 422));
      const block = cardBlock(row);
      let normalizedInput;
      try {
        normalizedInput = registry.validateActionInput(block, actionId, input.input ?? {});
      } catch (error) {
        return failure(toInteractionError(error));
      }
      const requestHash = hashRequest({ cardId, actionId, expectedRevision: input.expectedRevision, input: normalizedInput });
      const existing = await db.prepare(`
        SELECT status, request_hash AS requestHash, result_json AS resultJson, error_code AS errorCode,
          resulting_revision AS resultingRevision
        FROM workspace_card_action_runs
        WHERE card_id = ? AND actor_user_id = ? AND client_action_id = ?
      `).get(cardId, actor.id, clientActionId);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return failure(new WorkspaceCardInteractionError("card.idempotency_conflict", "操作标识已用于其他请求", 409));
        }
        if (existing.status === "succeeded") {
          return { ok: true, replayed: true, result: parseJson(existing.resultJson, {}), revision: existing.resultingRevision };
        }
        if (existing.status === "failed") {
          return failure(new WorkspaceCardInteractionError(existing.errorCode ?? "card.action_failed", "卡片操作未完成", 409));
        }
        return failure(new WorkspaceCardInteractionError("card.action_in_progress", "卡片操作正在处理", 409));
      }
      const runId = `cact_${idFactory()}`;
      const startedAt = now().toISOString();
      await db.prepare(`
        INSERT INTO workspace_card_action_runs (
          id, card_id, actor_user_id, action_id, client_action_id, request_hash,
          expected_revision, status, result_json, error_code, resulting_revision, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL)
      `).run(runId, cardId, actor.id, actionId, clientActionId, requestHash, input.expectedRevision, startedAt);

      let error;
      try {
        await assertVisible({ db, definition, row, actor, operation: "action", request: input.request });
        const status = effectiveStatus(row, now());
        if (status !== "active") throw new WorkspaceCardInteractionError("card.not_actionable", "卡片已不可操作", 409);
        if (row.revision !== input.expectedRevision) {
          throw new WorkspaceCardInteractionError("card.stale_revision", "卡片状态已变化，请刷新后重试", 409);
        }
        const action = registry.getAction(row.cardType, row.schemaVersion, actionId);
        if (!action) throw new WorkspaceCardInteractionError("card.unknown_action", "卡片操作暂不支持", 422);
        if (action.authorize) {
          const allowed = await action.authorize({
            db,
            actor,
            card: publicCardRow(row, status),
            input: normalizedInput,
            clientActionId
          });
          if (allowed === false) throw notFound();
        }
        const payload = parseJson(row.payloadJson, {});
        const executed = await db.transaction(async () => action.execute({
          db,
          actor,
          card: publicCardRow(row, status),
          payload,
          input: normalizedInput,
          clientActionId,
          request: input.request
        })) ?? {};
        let resultingRevision = row.revision;
        if (executed.cardPayload !== undefined || executed.cardStatus !== undefined) {
          const nextPayload = executed.cardPayload === undefined
            ? payload
            : registry.validatePayload(block, executed.cardPayload).payload;
          const nextStatus = executed.cardStatus === undefined
            ? status
            : normalizeEnum(executed.cardStatus, CARD_STATUS, "card.invalid_status", "卡片状态无效");
          resultingRevision += 1;
          const updated = await db.prepare(`
            UPDATE workspace_cards
            SET payload_json = ?, status = ?, revision = ?, updated_at = ?
            WHERE id = ? AND revision = ?
          `).run(JSON.stringify(nextPayload), nextStatus, resultingRevision, now().toISOString(), row.id, row.revision);
          if (!updated.changes) {
            throw new WorkspaceCardInteractionError("card.revision_conflict", "卡片版本已变化", 409);
          }
          await writeCardEvent(db, {
            type: "card.updated",
            spaceId: row.spaceId,
            conversationId: row.conversationId,
            actorId: actor.id,
            cardId: row.id,
            cardType: row.cardType,
            revision: resultingRevision,
            status: nextStatus
          });
        }
        const safeResult = normalizeCardPayload(executed.result ?? {}, {
          limits: { maxPayloadBytes: 16 * 1024, maxDepth: 6, maxNodes: 100, maxTextBytes: 8 * 1024 }
        });
        await db.prepare(`
          UPDATE workspace_card_action_runs
          SET status = 'succeeded', result_json = ?, resulting_revision = ?, completed_at = ?
          WHERE id = ?
        `).run(JSON.stringify(safeResult), resultingRevision, now().toISOString(), runId);
        await auditAction(db, actor, row, actionId, "success", null, input.request);
        return { ok: true, replayed: false, result: safeResult, revision: resultingRevision };
      } catch (caught) {
        error = toInteractionError(caught);
      }
      await db.prepare(`
        UPDATE workspace_card_action_runs
        SET status = 'failed', error_code = ?, completed_at = ?
        WHERE id = ?
      `).run(error.code, now().toISOString(), runId);
      await auditAction(db, actor, row, actionId, "rejected", error.code, input.request);
      return failure(error);
    });
    if (!outcome.ok) throw outcome.error;
    return outcome;
  }

  /**
   * Trusted Bot-only card writer. The Gateway supplies the already-authenticated
   * Bot identity and scope; request fields cannot choose the owner, space, or
   * visibility. Card IDs and source keys are opaque server-side identifiers.
   */
  async function createCustomBotCard(input = {}) {
    const spaceId = normalizeIdentifier(input.spaceId, "card.invalid_space", "空间 ID 无效");
    const conversationId = normalizeIdentifier(input.conversationId, "card.invalid_conversation", "会话 ID 无效");
    const botUserId = normalizeIdentifier(input.botUserId ?? input.ownerUserId, "card.invalid_owner", "卡片所有者无效");
    const botId = input.botId === undefined || input.botId === null
      ? null
      : normalizeIdentifier(input.botId, "card.invalid_owner", "卡片所有者无效");
    const sourceId = input.sourceId === undefined || input.sourceId === null
      ? `botcard_${idFactory()}`
      : normalizeIdentifier(input.sourceId, "card.invalid_source", "卡片来源 ID 无效");
    const actor = await requireActor(db, botUserId, spaceId, { allowBot: true });
    if (actor.kind !== "bot") throw new WorkspaceCardInteractionError("card.invalid_owner", "卡片所有者无效", 403);
    if (botId) {
      const bot = await db.prepare(`
        SELECT 1 FROM workspace_agent_bots
        WHERE id = ? AND bot_user_id = ? AND space_id = ? AND status = 'active'
      `).get(botId, botUserId, spaceId);
      if (!bot) throw notFound();
    }
    if (!await db.prepare(`
      SELECT 1 FROM conversation_members
      WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
    `).get(conversationId, botUserId)) throw notFound();

    const card = await createCard({
      spaceId,
      conversationId,
      cardType: input.cardType,
      schemaVersion: input.schemaVersion,
      fallbackText: input.fallbackText,
      payload: input.payload,
      sourceKind: "custom_bot",
      sourceId,
      visibilityScope: "conversation",
      createdByUserId: botUserId,
      trustedCustomBot: true,
      // A custom Bot may send a type the current server does not know yet. It
      // remains a safe fallback and can never acquire executable actions.
      allowUnknownDefinition: true
    });
    return { ...card, botId, ownerUserId: botUserId };
  }

  async function updateCustomBotCard(input = {}) {
    const cardId = normalizeIdentifier(input.cardId, "card.invalid_id", "卡片 ID 无效");
    const spaceId = normalizeIdentifier(input.spaceId, "card.invalid_space", "空间 ID 无效");
    const botUserId = normalizeIdentifier(input.botUserId ?? input.ownerUserId, "card.invalid_owner", "卡片所有者无效");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new WorkspaceCardInteractionError("card.invalid_revision", "卡片版本无效");
    }
    rejectImmutableBotCardFields(input);
    const actor = await requireActor(db, botUserId, spaceId, { allowBot: true });
    if (actor.kind !== "bot") throw new WorkspaceCardInteractionError("card.invalid_owner", "卡片所有者无效", 403);
    await requireCustomBotIdentity(db, input.botId, botUserId, spaceId);
    try {
      return await db.transaction(async () => {
      await db.lock?.(`workspace-card:bot-update:${cardId}`);
      const row = await loadCard(db, cardId);
      assertCustomBotOwner(row, { spaceId, botUserId, botId: input.botId });
      const status = effectiveStatus(row, now());
      if (status !== "active") throw new WorkspaceCardInteractionError("card.not_found", "卡片不存在", 404);
      const definition = registry.get(row.cardType, row.schemaVersion);
      const payload = input.payload === undefined
        ? parseJson(row.payloadJson, {})
        : definition
          ? registry.validatePayload(cardBlock(row), input.payload).payload
          : normalizeCardPayload(input.payload);
      const fallbackText = input.fallbackText === undefined
        ? row.fallbackText
        : normalizeFallbackText(input.fallbackText);
      const updatedAt = now().toISOString();
      const result = await db.prepare(`
        UPDATE workspace_cards
        SET payload_json = ?, fallback_text = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND space_id = ? AND source_kind = 'custom_bot'
          AND created_by_user_id = ? AND status = 'active' AND revision = ?
      `).run(JSON.stringify(payload), fallbackText, updatedAt, cardId, spaceId, botUserId, input.expectedRevision);
      if (!result.changes) {
        const current = await loadCard(db, cardId);
        if (current && current.spaceId === spaceId && current.sourceKind === "custom_bot" && current.createdByUserId === botUserId) {
          throw new WorkspaceCardInteractionError("card.revision_conflict", "卡片版本已变化", 409);
        }
        throw notFound();
      }
      const stored = await loadCard(db, cardId);
      await writeCardEvent(db, {
        type: "card.updated",
        spaceId,
        conversationId: stored.conversationId,
        actorId: actor.id,
        cardId,
        cardType: stored.cardType,
        revision: stored.revision,
        status: stored.status
      });
      await writeAudit(db, {
        spaceId,
        actorUserId: actor.id,
        actorGithubLogin: actor.githubLogin,
        action: "card.update",
        targetType: "workspace.card",
        targetId: cardId,
        result: "success"
      });
      return { ...projectStoredCard(stored, definition, payload), botId: input.botId ?? null, ownerUserId: botUserId };
      });
    } catch (error) {
      await writeAudit(db, {
        spaceId,
        actorUserId: actor.id,
        actorGithubLogin: actor.githubLogin,
        action: "card.update",
        targetType: "workspace.card",
        targetId: cardId,
        result: "rejected",
        reason: error?.code ?? "card.update_failed"
      }).catch(() => {});
      throw error;
    }
  }

  async function invalidateCustomBotCard(input = {}) {
    const cardId = normalizeIdentifier(input.cardId, "card.invalid_id", "卡片 ID 无效");
    const spaceId = normalizeIdentifier(input.spaceId, "card.invalid_space", "空间 ID 无效");
    const botUserId = normalizeIdentifier(input.botUserId ?? input.ownerUserId, "card.invalid_owner", "卡片所有者无效");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new WorkspaceCardInteractionError("card.invalid_revision", "卡片版本无效");
    }
    const status = normalizeEnum(input.status ?? "invalidated", CARD_STATUS, "card.invalid_status", "卡片状态无效");
    if (status === "active") throw new WorkspaceCardInteractionError("card.invalid_status", "不能通过失效接口恢复卡片");
    const actor = await requireActor(db, botUserId, spaceId, { allowBot: true });
    if (actor.kind !== "bot") throw new WorkspaceCardInteractionError("card.invalid_owner", "卡片所有者无效", 403);
    await requireCustomBotIdentity(db, input.botId, botUserId, spaceId);
    try {
      return await db.transaction(async () => {
      await db.lock?.(`workspace-card:bot-invalidate:${cardId}`);
      const row = await loadCard(db, cardId);
      assertCustomBotOwner(row, { spaceId, botUserId, botId: input.botId });
      const result = await db.prepare(`
        UPDATE workspace_cards
        SET status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND space_id = ? AND source_kind = 'custom_bot'
          AND created_by_user_id = ? AND status = 'active' AND revision = ?
      `).run(status, now().toISOString(), cardId, spaceId, botUserId, input.expectedRevision);
      if (!result.changes) {
        const current = await loadCard(db, cardId);
        if (current && current.spaceId === spaceId && current.sourceKind === "custom_bot" && current.createdByUserId === botUserId) {
          throw new WorkspaceCardInteractionError("card.revision_conflict", "卡片版本已变化", 409);
        }
        throw notFound();
      }
      const stored = await loadCard(db, cardId);
      await writeCardEvent(db, {
        type: "card.invalidated",
        spaceId,
        conversationId: stored.conversationId,
        actorId: actor.id,
        cardId,
        cardType: stored.cardType,
        revision: stored.revision,
        status
      });
      await writeAudit(db, {
        spaceId,
        actorUserId: actor.id,
        actorGithubLogin: actor.githubLogin,
        action: "card.invalidate",
        targetType: "workspace.card",
        targetId: cardId,
        result: "success",
        reason: status
      });
      return { ...publicCardRow(stored, status), botId: input.botId ?? null, ownerUserId: botUserId };
      });
    } catch (error) {
      await writeAudit(db, {
        spaceId,
        actorUserId: actor.id,
        actorGithubLogin: actor.githubLogin,
        action: "card.invalidate",
        targetType: "workspace.card",
        targetId: cardId,
        result: "rejected",
        reason: error?.code ?? "card.invalidate_failed"
      }).catch(() => {});
      throw error;
    }
  }

  async function invalidateCard(input = {}) {
    const cardId = normalizeIdentifier(input.cardId, "card.invalid_id", "卡片 ID 无效");
    const row = await loadCard(db, cardId);
    if (!row) throw notFound();
    const status = normalizeEnum(input.status ?? "invalidated", CARD_STATUS, "card.invalid_status", "卡片状态无效");
    if (status === "active") throw new WorkspaceCardInteractionError("card.invalid_status", "不能通过失效接口恢复卡片");
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
      throw new WorkspaceCardInteractionError("card.invalid_revision", "卡片版本无效");
    }
    const result = await db.prepare(input.expectedRevision === undefined
      ? "UPDATE workspace_cards SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?"
      : "UPDATE workspace_cards SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
      .run(...(input.expectedRevision === undefined
        ? [status, now().toISOString(), cardId]
        : [status, now().toISOString(), cardId, input.expectedRevision]));
    if (input.expectedRevision !== undefined && !result.changes) {
      throw new WorkspaceCardInteractionError("card.revision_conflict", "卡片版本已变化", 409);
    }
    return loadCard(db, cardId).then((stored) => publicCardRow(stored, status));
  }

  return {
    createCard,
    createCustomBotCard,
    createTrustedCustomBotCard: createCustomBotCard,
    createOpaqueCustomBotCard: createCustomBotCard,
    createBotCard: createCustomBotCard,
    resolveCard,
    validateMessageCardReference,
    executeAction,
    updateCustomBotCard,
    updateTrustedCustomBotCard: updateCustomBotCard,
    updateBotCard: updateCustomBotCard,
    invalidateCustomBotCard,
    invalidateTrustedCustomBotCard: invalidateCustomBotCard,
    invalidateBotCard: invalidateCustomBotCard,
    invalidateCard
  };
}

async function assertVisible({ db, definition, row, actor, operation, request }) {
  if (row.visibilityScope === "conversation") {
    const membership = await db.prepare(`
      SELECT 1 AS allowed FROM conversation_members
      WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
    `).get(row.conversationId, actor.id);
    if (!membership) throw notFound();
  }
  if (row.visibilityScope === "resource" && (!row.resourceType || !row.resourceId || !definition?.authorize)) throw notFound();
  if (definition?.authorize) {
    const allowed = await definition.authorize({ db, actor, card: publicCardRow(row, effectiveStatus(row, new Date())), operation, request });
    if (allowed === false) throw notFound();
  }
}

async function requireActor(db, actorUserId, spaceId, options = {}) {
  const actorId = normalizeIdentifier(actorUserId, "auth.required", "请先登录共享空间");
  const actor = await db.prepare(`
    SELECT u.id, u.github_login AS githubLogin, u.kind, sm.role
    FROM users u
    JOIN space_members sm ON sm.user_id = u.id
    WHERE u.id = ? AND sm.space_id = ? AND sm.removed_at IS NULL
  `).get(actorId, spaceId);
  if (!actor || (actor.kind !== "human" && !(options.allowBot === true && actor.kind === "bot"))) throw notFound();
  if (options.allowBot === true && actor.kind === "bot") {
    const customBot = await db.prepare(`
      SELECT 1 FROM workspace_agent_bots WHERE bot_user_id = ? AND space_id = ? AND status = 'active'
    `).get(actor.id, spaceId);
    const systemBot = options.allowSystemBot === true
      ? getSystemIdentityDefinition(actor.id)
      : null;
    if (!customBot && systemBot?.kind !== "bot") throw notFound();
  }
  return actor;
}

async function requireSpace(db, spaceId) {
  if (!await db.prepare("SELECT 1 AS present FROM spaces WHERE id = ?").get(spaceId)) {
    throw new WorkspaceCardInteractionError("space.not_found", "空间不存在", 404);
  }
}

async function requireConversationInSpace(db, conversationId, spaceId) {
  if (!await db.prepare("SELECT 1 AS present FROM conversations WHERE id = ? AND space_id = ?").get(conversationId, spaceId)) {
    throw new WorkspaceCardInteractionError("conversation.not_found", "会话不存在", 404);
  }
}

async function requireUserInSpace(db, userId, spaceId) {
  if (!await db.prepare(`
    SELECT 1 AS present FROM space_members WHERE space_id = ? AND user_id = ? AND removed_at IS NULL
  `).get(spaceId, userId)) {
    throw new WorkspaceCardInteractionError("permission.denied", "当前用户不属于该空间", 403);
  }
}

async function loadCard(db, cardId) {
  return db.prepare(`
    SELECT id, space_id AS spaceId, conversation_id AS conversationId,
      card_type AS cardType, schema_version AS schemaVersion, payload_json AS payloadJson,
      fallback_text AS fallbackText, source_kind AS sourceKind, source_id AS sourceId,
      resource_type AS resourceType, resource_id AS resourceId, visibility_scope AS visibilityScope,
      created_by_user_id AS createdByUserId, status, revision, expires_at AS expiresAt,
      created_at AS createdAt, updated_at AS updatedAt
    FROM workspace_cards WHERE id = ?
  `).get(cardId);
}

async function findCardBySource(db, spaceId, sourceKind, sourceId, cardType) {
  const row = await db.prepare(`
    SELECT id FROM workspace_cards
    WHERE space_id = ? AND source_kind = ? AND source_id = ? AND card_type = ?
  `).get(spaceId, sourceKind, sourceId, cardType);
  return row ? loadCard(db, row.id) : null;
}

function matchesCreate(row, { block, payload, conversationId, visibilityScope, resourceType, resourceId, createdByUserId }) {
  return row.cardType === block.cardType
    && row.schemaVersion === block.schemaVersion
    && row.fallbackText === block.fallbackText
    && row.conversationId === conversationId
    && row.visibilityScope === visibilityScope
    && row.resourceType === resourceType
    && row.resourceId === resourceId
    && row.createdByUserId === createdByUserId
    && stableStringify(parseJson(row.payloadJson, {})) === stableStringify(payload);
}

async function requireCustomBotIdentity(db, botId, botUserId, spaceId) {
  if (botId === undefined || botId === null) return;
  const normalizedBotId = normalizeIdentifier(botId, "card.invalid_owner", "卡片所有者无效");
  const bot = await db.prepare(`
    SELECT 1 FROM workspace_agent_bots
    WHERE id = ? AND bot_user_id = ? AND space_id = ? AND status = 'active'
  `).get(normalizedBotId, botUserId, spaceId);
  if (!bot) throw notFound();
}

function projectStoredCard(row, definition, payload, status = effectiveStatus(row, new Date())) {
  return {
    id: row.id,
    spaceId: row.spaceId,
    conversationId: row.conversationId ?? null,
    block: cardBlock(row),
    payload,
    status,
    revision: row.revision,
    expiresAt: row.expiresAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    actions: definition ? Object.keys(definition.actions) : []
  };
}

function fallbackProjection(row) {
  return {
    type: "card_fallback",
    reason: "card.unknown_version",
    block: cardBlock(row),
    fallbackText: row.fallbackText,
    status: effectiveStatus(row, new Date()),
    revision: row.revision
  };
}

function publicCardRow(row, status) {
  return {
    id: row.id,
    spaceId: row.spaceId,
    conversationId: row.conversationId ?? null,
    cardType: row.cardType,
    schemaVersion: row.schemaVersion,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId ?? null,
    resourceType: row.resourceType ?? null,
    resourceId: row.resourceId ?? null,
    visibilityScope: row.visibilityScope,
    status,
    revision: row.revision,
    expiresAt: row.expiresAt ?? null
  };
}

function cardBlock(row) {
  return normalizeCardBlock({
    type: "card",
    cardId: row.id,
    cardType: row.cardType,
    schemaVersion: row.schemaVersion,
    fallbackText: row.fallbackText
  });
}

function normalizeFallbackText(value) {
  const normalized = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim() : "";
  if (!normalized || normalized.length > 16_000 || /<\/?[a-z][^>]*>/iu.test(normalized)) {
    throw new WorkspaceCardInteractionError("card.invalid_fallback", "卡片降级文本无效");
  }
  return normalized;
}

function rejectImmutableBotCardFields(input) {
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
  const field = immutable.find((name) => Object.prototype.hasOwnProperty.call(input, name) && input[name] !== undefined);
  // The trusted context fields are passed separately by the Gateway. They are
  // accepted by this internal service API but never read from the Bot body.
  if (field && ["spaceId", "botUserId", "ownerUserId", "botId"].includes(field)) return;
  if (field) throw new WorkspaceCardInteractionError("card.immutable_field", "卡片来源或范围不可修改", 400);
}

function assertCustomBotOwner(row, { spaceId, botUserId, botId }) {
  if (!row || row.spaceId !== spaceId || row.sourceKind !== "custom_bot" || row.createdByUserId !== botUserId) {
    throw notFound();
  }
  if (botId !== undefined && botId !== null) {
    const normalizedBotId = typeof botId === "string" ? botId.trim() : "";
    // The row intentionally stores only the opaque source key. The Gateway
    // additionally authenticates botId before reaching this boundary; a
    // malformed value is treated as an inaccessible card.
    if (!IDENTIFIER_PATTERN.test(normalizedBotId)) throw notFound();
  }
}

async function writeCardEvent(db, { type, spaceId, conversationId, actorId, cardId, cardType, revision, status }) {
  const sequence = await db.prepare(`
    INSERT INTO workspace_event_cursors (space_id, next_seq)
    VALUES (?, 2)
    ON CONFLICT (space_id) DO UPDATE
    SET next_seq = workspace_event_cursors.next_seq + 1
    RETURNING next_seq - 1 AS nextSeq
  `).get(spaceId);
  const eventId = `evt_card_${randomUUID()}`;
  await db.prepare(`
    INSERT INTO workspace_events (
      id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'workspace.card', ?, ?, ?)
  `).run(
    eventId,
    spaceId,
    sequence.nextSeq,
    type,
    actorId ?? null,
    conversationId ?? null,
    cardId,
    JSON.stringify({ cardId, cardType, revision, status }),
    new Date().toISOString()
  );
  return { id: eventId, seq: sequence.nextSeq, spaceId };
}

function effectiveStatus(row, referenceDate) {
  if (row.status === "active" && row.expiresAt && new Date(row.expiresAt).getTime() <= referenceDate.getTime()) return "expired";
  return row.status;
}

async function auditAction(db, actor, card, actionId, result, reason, request) {
  await writeAudit(db, {
    spaceId: card.spaceId,
    actorUserId: actor.id,
    actorGithubLogin: actor.githubLogin,
    action: `card.action.${actionId}`,
    targetType: "workspace.card",
    targetId: card.id,
    result,
    reason,
    ipAddress: request?.ipAddress,
    userAgent: request?.userAgent,
    requestId: request?.requestId
  });
}

function normalizeIdentifier(value, code, message) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new WorkspaceCardInteractionError(code, message);
  return normalized;
}

function normalizeOptionalIdentifier(value, code, message) {
  if (value === undefined || value === null || value === "") return null;
  return normalizeIdentifier(value, code, message);
}

function normalizeEnum(value, allowed, code, message) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!allowed.has(normalized)) throw new WorkspaceCardInteractionError(code, message);
  return normalized;
}

function normalizeOptionalTimestamp(value, code) {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new WorkspaceCardInteractionError(code, "时间格式无效");
  return timestamp.toISOString();
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

function notFound() {
  return new WorkspaceCardInteractionError("card.not_found", "卡片不存在或不可访问", 404);
}

function toInteractionError(error) {
  if (error instanceof WorkspaceCardInteractionError) return error;
  if (error instanceof CardValidationError) return new WorkspaceCardInteractionError(error.code, error.message, 422);
  if (typeof error?.code === "string" && Number.isInteger(error?.statusCode)) {
    return new WorkspaceCardInteractionError(error.code, error.message || "卡片操作失败", error.statusCode);
  }
  return new WorkspaceCardInteractionError("card.action_failed", "卡片操作失败", 500);
}

function failure(error) {
  return { ok: false, error: toInteractionError(error) };
}
