import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { openTestDatabase } from "./test-database.mjs";
import { createCardRegistry, CardValidationError } from "./workspace-cards.mjs";
import {
  createWorkspaceCardInteractionService,
  WorkspaceCardInteractionError
} from "./workspace-card-interactions.mjs";

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async ({ db, directory }) => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-card-actions-"));
  const db = openTestDatabase(directory);
  cleanups.push({ db, directory });
  const now = new Date().toISOString();
  for (const [id, login] of [["usr_card_member", "card-member"], ["usr_card_outsider", "card-outsider"]]) {
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at)
      VALUES (?, NULL, ?, NULL, ?, NULL, NULL, 'human', ?)
    `).run(id, login, login, now);
    db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES (?, ?, 'member', ?, NULL)
    `).run(DEFAULT_SPACE_ID, id, now);
  }
  db.prepare(`
    INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
    VALUES ('conv_card_test', ?, 'group', 'Card test', NULL, 10000, 'usr_owner', ?)
  `).run(DEFAULT_SPACE_ID, now);
  for (const userId of ["usr_owner", "usr_card_member"]) {
    db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
      VALUES ('conv_card_test', ?, ?, NULL)
    `).run(userId, now);
  }

  const registry = createCardRegistry([{
    cardType: "test.counter",
    schemaVersion: 1,
    validatePayload(payload) {
      if (!Number.isSafeInteger(payload.count) || payload.count < 0) {
        throw new CardValidationError("card.domain_invalid", "计数无效");
      }
      return payload;
    },
    actions: {
      increment: {
        validateInput(input) {
          if (input.secret !== undefined && typeof input.secret !== "string") {
            throw new CardValidationError("card.action_input_invalid", "输入无效");
          }
          return input;
        },
        async execute({ payload }) {
          const count = payload.count + 1;
          return { cardPayload: { count }, result: { count } };
        }
      }
    }
  }]);
  let sequence = 0;
  const service = createWorkspaceCardInteractionService({
    db,
    registry,
    idFactory: () => `fixed_${sequence += 1}`,
    now: () => new Date("2026-08-14T00:00:00.000Z")
  });
  return { db, service };
}

async function createCounter(service, overrides = {}) {
  return service.createCard({
    spaceId: DEFAULT_SPACE_ID,
    conversationId: "conv_card_test",
    cardType: "test.counter",
    schemaVersion: 1,
    fallbackText: "计数卡片",
    payload: { count: 0 },
    sourceKind: "workspace",
    sourceId: "counter-1",
    visibilityScope: "conversation",
    createdByUserId: "usr_owner",
    ...overrides
  });
}

describe("workspace card interaction service", () => {
  it("creates authoritative card instances and scopes reads to conversation members", async () => {
    const { service } = await fixture();
    const created = await createCounter(service);
    expect(created).toMatchObject({
      block: { cardType: "test.counter", schemaVersion: 1, fallbackText: "计数卡片" },
      payload: { count: 0 },
      revision: 1,
      status: "active",
      actions: ["increment"]
    });
    await expect(service.resolveCard("usr_card_member", created.block.cardId)).resolves.toMatchObject({ payload: { count: 0 } });
    await expect(service.resolveCard("usr_card_outsider", created.block.cardId)).rejects.toMatchObject({
      code: "card.not_found",
      statusCode: 404
    });
  });

  it("checks conversation scope before returning an unknown-version fallback", async () => {
    const { db, service } = await fixture();
    const timestamp = new Date("2026-08-14T00:00:00.000Z").toISOString();
    db.prepare(`INSERT INTO workspace_cards (
      id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text,
      source_kind, source_id, resource_type, resource_id, visibility_scope,
      created_by_user_id, status, revision, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'custom_bot', ?, NULL, NULL, 'conversation', ?, 'active', 1, NULL, ?, ?)`)
      .run("card_unknown_scope", DEFAULT_SPACE_ID, "conv_card_test", "future.poll", 9, JSON.stringify({ secret: "hidden" }), "未来卡片", "opaque", "usr_owner", timestamp, timestamp);
    await expect(service.resolveCard("usr_card_member", "card_unknown_scope")).resolves.toMatchObject({
      type: "card_fallback",
      fallbackText: "未来卡片"
    });
    await expect(service.resolveCard("usr_card_outsider", "card_unknown_scope")).rejects.toMatchObject({
      code: "card.not_found",
      statusCode: 404
    });
  });

  it("replays identical actions without executing twice and rejects idempotency conflicts", async () => {
    const { service, db } = await fixture();
    const created = await createCounter(service);
    const request = {
      cardId: created.block.cardId,
      actionId: "increment",
      expectedRevision: 1,
      clientActionId: "client-action-1",
      input: { secret: "do-not-audit" },
      request: { requestId: "req-card-1", ipAddress: "127.0.0.1", userAgent: "vitest" }
    };
    await expect(service.executeAction("usr_card_member", request)).resolves.toEqual({
      ok: true,
      replayed: false,
      result: { count: 1 },
      revision: 2
    });
    await expect(service.executeAction("usr_card_member", request)).resolves.toEqual({
      ok: true,
      replayed: true,
      result: { count: 1 },
      revision: 2
    });
    await expect(service.resolveCard("usr_card_member", created.block.cardId)).resolves.toMatchObject({ payload: { count: 1 }, revision: 2 });
    await expect(service.executeAction("usr_card_member", { ...request, input: { secret: "changed" } })).rejects.toMatchObject({
      code: "card.idempotency_conflict"
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_card_action_runs").get().count).toBe(1);
    expect(JSON.stringify(db.prepare("SELECT * FROM audit_logs WHERE action = 'card.action.increment'").all()))
      .not.toContain("do-not-audit");
  });

  it("rejects stale revisions and unsupported actions with stable codes", async () => {
    const { service } = await fixture();
    const created = await createCounter(service);
    await expect(service.executeAction("usr_card_member", {
      cardId: created.block.cardId,
      actionId: "increment",
      expectedRevision: 2,
      clientActionId: "stale-action",
      input: {}
    })).rejects.toMatchObject({ code: "card.stale_revision", statusCode: 409 });
    await expect(service.executeAction("usr_card_member", {
      cardId: created.block.cardId,
      actionId: "missing",
      expectedRevision: 1,
      clientActionId: "unknown-action",
      input: {}
    })).rejects.toMatchObject({ code: "card.unknown_action", statusCode: 422 });
  });

  it("reuses matching source cards and rejects conflicting source payloads", async () => {
    const { service } = await fixture();
    const first = await createCounter(service);
    const replay = await createCounter(service);
    expect(replay.block.cardId).toBe(first.block.cardId);
    await expect(createCounter(service, { payload: { count: 8 } })).rejects.toBeInstanceOf(WorkspaceCardInteractionError);
    await expect(createCounter(service, { payload: { count: 8 } })).rejects.toMatchObject({ code: "card.source_conflict" });
  });
});
