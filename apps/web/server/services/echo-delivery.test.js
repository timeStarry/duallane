import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import {
  ECHO_REQUIREMENT_CARD_TYPE,
  ECHO_REQUIREMENT_STATUS_CARD_TYPE,
  createEchoDeliveryService
} from "./echo-delivery.mjs";

const fixtures = [];

async function createFixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "duallane-echo-delivery-"));
  const db = openTestDatabase(dataDir);
  const now = "2026-08-14T00:00:00.000Z";
  db.prepare(`
    INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
    VALUES ('usr_member_delivery', 'delivery-member', 'deliveryMember', 'delivery@example.com', '成员', NULL, 'human', ?, NULL)
  `).run(now);
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES ('spc_default', 'usr_member_delivery', 'member', ?, NULL)
  `).run(now);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_cards (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      conversation_id TEXT,
      card_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      fallback_text TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      resource_type TEXT,
      resource_id TEXT,
      visibility_scope TEXT NOT NULL,
      created_by_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (space_id, source_kind, source_id, card_type)
    );
    CREATE TABLE IF NOT EXISTS echo_solicitations (
      id TEXT PRIMARY KEY,
      public_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      question TEXT NOT NULL,
      choice_mode TEXT NOT NULL,
      min_selections INTEGER NOT NULL,
      max_selections INTEGER NOT NULL,
      allow_vote_change INTEGER NOT NULL,
      delivery_policy TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      deadline TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS echo_solicitation_options (
      id TEXT PRIMARY KEY,
      solicitation_id TEXT NOT NULL,
      label TEXT NOT NULL,
      position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS echo_solicitation_deliveries (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      solicitation_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (solicitation_id, recipient_user_id)
    );
    CREATE TABLE IF NOT EXISTS echo_requirements (
      id TEXT PRIMARY KEY,
      public_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      submitter_user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      scenario TEXT NOT NULL,
      expected_result TEXT NOT NULL,
      related_link TEXT,
      state TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      archive_outcome TEXT,
      duplicate_of_public_id TEXT,
      revision INTEGER NOT NULL,
      response TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  fixtures.push({ db, dataDir });
  return { db, now };
}

function insertSolicitation(db, now = "2026-08-14T00:00:00.000Z") {
  db.prepare(`
    INSERT INTO echo_solicitations (
      id, public_id, space_id, owner_user_id, title, description, question,
      choice_mode, min_selections, max_selections, allow_vote_change,
      delivery_policy, status, revision, deadline, created_at, updated_at
    ) VALUES ('echo_sol_1', 'SOL-2026-0001', 'spc_default', 'usr_owner', '方向', '描述', '选择', 'single', 1, 1, 1, 'all_active_members', 'open', 1, NULL, ?, ?)
  `).run(now, now);
  db.prepare("INSERT INTO echo_solicitation_options (id, solicitation_id, label, position) VALUES ('opt_a', 'echo_sol_1', 'Web', 0)").run();
  for (const userId of ["usr_owner", "usr_member_delivery"]) {
    db.prepare(`
      INSERT INTO echo_solicitation_deliveries (id, space_id, solicitation_id, recipient_user_id, status, attempt_count, created_at, updated_at)
      VALUES (?, 'spc_default', 'echo_sol_1', ?, 'pending', 0, ?, ?)
    `).run(`delivery_${userId}`, userId, now, now);
  }
}

function solicitationProjector() {
  return {
    async projectCard({ publicId }) {
      return {
        block: {
          type: "card",
          cardId: `domain_${publicId}`,
          cardType: "echo.solicitation",
          schemaVersion: 1,
          fallbackText: `回声征集 ${publicId}`
        },
        payload: {
          publicId,
          title: "方向",
          description: "描述",
          question: "选择",
          status: "open",
          revision: 1,
          choiceMode: "single",
          minSelections: 1,
          maxSelections: 1,
          allowVoteChange: true,
          options: [{ id: "opt_a", label: "Web", position: 0, count: 0 }],
          selectedOptionIds: [],
          owner: false,
          voteCount: 0
        }
      };
    }
  };
}

function requirementProjector() {
  return {
    async projectCard({ publicId, cardType }) {
      return {
        block: {
          type: "card",
          cardId: `domain_${publicId}`,
          cardType,
          schemaVersion: 1,
          fallbackText: `回声需求 ${publicId}`
        },
        payload: {
          publicId,
          type: "requirement",
          title: "一个需求",
          detail: "细节",
          scenario: "场景",
          expectedResult: "结果",
          state: "submitted",
          phase: "proposal",
          status: "pending_review",
          archiveOutcome: null,
          duplicateOfPublicId: null,
          revision: 1,
          response: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z"
        }
      };
    }
  };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

describe("Echo delivery", () => {
  it("creates and reuses one direct conversation and idempotent card message rows", async () => {
    const { db, now } = await createFixture();
    insertSolicitation(db, now);
    const notifications = { email: 0, ntfy: 0 };
    const service = createEchoDeliveryService({
      db,
      now: () => new Date(now),
      solicitationService: solicitationProjector(),
      scheduleEmailNotifications: async () => { notifications.email += 1; },
      scheduleNtfyNotifications: async () => { notifications.ntfy += 1; }
    });

    const first = await service.syncSolicitation({ publicId: "SOL-2026-0001" });
    const second = await service.syncSolicitation({ publicId: "SOL-2026-0001" });
    expect(first.sent).toBe(2);
    expect(second.sent).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE type = 'direct'").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_cards").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE author_id = 'usr_system_echo'").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events WHERE type = 'message.created'").get().count).toBe(2);
    expect(notifications).toEqual({ email: 2, ntfy: 2 });
    expect(db.prepare("SELECT status, attempt_count FROM echo_solicitation_deliveries WHERE recipient_user_id = 'usr_member_delivery'").get()).toMatchObject({ status: "sent", attempt_count: 1 });
    const eventPayload = db.prepare("SELECT payload_json AS payload FROM workspace_events WHERE type = 'message.created' LIMIT 1").get().payload;
    expect(eventPayload).not.toContain("描述");
    expect(eventPayload).toContain("echo");
  });

  it("projects private requirements to owners and submitters with isolated card scopes", async () => {
    const { db, now } = await createFixture();
    db.prepare(`
      INSERT INTO echo_requirements (
        id, public_id, space_id, submitter_user_id, type, title, detail, scenario,
        expected_result, related_link, state, phase, status, archive_outcome,
        duplicate_of_public_id, revision, response, created_at, updated_at
      ) VALUES ('echo_req_1', 'REQ-2026-0001', 'spc_default', 'usr_member_delivery', 'requirement', '一个需求', '细节', '场景', '结果', NULL, 'submitted', 'proposal', 'pending_review', NULL, NULL, 1, NULL, ?, ?)
    `).run(now, now);
    const service = createEchoDeliveryService({
      db,
      now: () => new Date(now),
      requirementService: requirementProjector()
    });
    const result = await service.syncRequirement({ publicId: "REQ-2026-0001" });
    expect(result.sent).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_cards").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE author_id = 'usr_system_echo'").get().count).toBe(2);
    expect(db.prepare("SELECT card_type AS cardType FROM workspace_cards WHERE source_id LIKE '%usr_owner%'").get().cardType).toBe(ECHO_REQUIREMENT_CARD_TYPE);
    expect(db.prepare("SELECT card_type AS cardType FROM workspace_cards WHERE source_id LIKE '%usr_member_delivery%'").get().cardType).toBe(ECHO_REQUIREMENT_STATUS_CARD_TYPE);

    db.prepare("UPDATE echo_requirements SET revision = 2, state = 'collected', phase = 'formal', status = 'planned' WHERE id = 'echo_req_1'").run();
    const updated = await service.syncRequirement({ publicId: "REQ-2026-0001" });
    expect(updated.sent).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE author_id = 'usr_system_echo'").get().count).toBe(4);
    expect(db.prepare("SELECT MAX(revision) AS revision FROM workspace_cards").get().revision).toBe(2);
  });

  it("marks transient failures and retries only after the configured delay", async () => {
    const { db, now } = await createFixture();
    insertSolicitation(db, now);
    let attempts = 0;
    const service = createEchoDeliveryService({
      db,
      now: () => new Date(now),
      retryDelaysMs: [60_000],
      solicitationService: {
        async projectCard(input) {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("temporary"), { code: "echo.upstream_timeout" });
          return solicitationProjector().projectCard(input);
        }
      }
    });
    const first = await service.syncSolicitation({ publicId: "SOL-2026-0001", recipientUserId: "usr_member_delivery" });
    expect(first.failed).toBe(1);
    const immediate = await service.recover({ limit: 10 });
    expect(immediate.solicitations.some((item) => item.status === "failed")).toBe(true);
    db.prepare("UPDATE echo_solicitation_deliveries SET updated_at = ? WHERE recipient_user_id = 'usr_member_delivery'").run("2026-08-13T23:58:00.000Z");
    const recovered = await service.recover({ limit: 10 });
    expect(recovered.solicitations.some((item) => item.status === "sent")).toBe(true);
  });

  it("only delivers to active human members and records an unavailable Echo identity as failed", async () => {
    const { db, now } = await createFixture();
    insertSolicitation(db, now);
    db.prepare(`
      INSERT INTO echo_solicitation_deliveries (id, space_id, solicitation_id, recipient_user_id, status, attempt_count, created_at, updated_at)
      VALUES ('delivery_echo', 'spc_default', 'echo_sol_1', 'usr_system_echo', 'pending', 0, ?, ?)
    `).run(now, now);
    const service = createEchoDeliveryService({
      db,
      now: () => new Date(now),
      solicitationService: solicitationProjector()
    });

    const skipped = await service.syncSolicitation({ publicId: "SOL-2026-0001", recipientUserId: "usr_system_echo" });
    expect(skipped).toMatchObject({ skipped: 1, results: [{ errorCode: "echo.recipient_ineligible" }] });
    expect(db.prepare("SELECT status FROM echo_solicitation_deliveries WHERE id = 'delivery_echo'").get().status).toBe("skipped");
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE type = 'direct'").get().count).toBe(0);

    db.prepare("DELETE FROM space_members WHERE space_id = 'spc_default' AND user_id = 'usr_system_echo'").run();
    const failed = await service.syncSolicitation({ publicId: "SOL-2026-0001", recipientUserId: "usr_member_delivery" });
    expect(failed.failed).toBe(1);
    expect(db.prepare("SELECT status, last_error_code FROM echo_solicitation_deliveries WHERE recipient_user_id = 'usr_member_delivery'").get())
      .toMatchObject({ status: "failed", last_error_code: "echo.identity_unavailable" });
  });

  it("backfills an eligible member without duplicating delivery rows", async () => {
    const { db, now } = await createFixture();
    insertSolicitation(db, now);
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES ('usr_member_new', 'new-member', 'newMember', 'new@example.com', '新成员', NULL, 'human', ?, NULL)
    `).run(now);
    db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES ('spc_default', 'usr_member_new', 'member', ?, NULL)
    `).run(now);
    const service = createEchoDeliveryService({
      db,
      now: () => new Date(now),
      solicitationService: solicitationProjector()
    });

    const first = await service.syncMember("usr_member_new");
    const second = await service.syncMember("usr_member_new");
    expect(first.solicitations).toHaveLength(1);
    expect(first.solicitations[0].status).toBe("sent");
    expect(second.solicitations).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_solicitation_deliveries WHERE recipient_user_id = 'usr_member_new'").get().count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE author_id = 'usr_system_echo' AND conversation_id = (SELECT id FROM conversations WHERE direct_key = 'usr_member_new:usr_system_echo')").get().count).toBe(1);
  });
});
