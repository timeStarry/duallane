import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import {
  ECHO_REQUIREMENT_CARD_DEFINITIONS,
  EchoRequirementConflictError,
  EchoRequirementError,
  EchoRequirementNotFoundError,
  createEchoRequirementCardRegistry,
  createEchoRequirementService
} from "./echo-requirements.mjs";

const tempDirs = [];
const activeDbs = [];

async function createFixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "duallane-echo-requirements-"));
  tempDirs.push(dataDir);
  const db = openTestDatabase(dataDir);
  activeDbs.push(db);
  db.prepare(`
    INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
    VALUES ('usr_submitter', 'echo-submitter', 'echoSubmitter', 'submitter@example.com', '提交者', NULL, 'human', ?, NULL)
  `).run(new Date().toISOString());
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES ('spc_default', 'usr_submitter', 'member', ?, NULL)
  `).run(new Date().toISOString());
  db.prepare(`
    INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
    VALUES ('usr_other', 'echo-other', 'echoOther', 'other@example.com', '其他成员', NULL, 'human', ?, NULL)
  `).run(new Date().toISOString());
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES ('spc_default', 'usr_other', 'member', ?, NULL)
  `).run(new Date().toISOString());
  for (const [id, login, role] of [["usr_admin", "echoAdmin", "admin"], ["usr_auditor", "echoAuditor", "auditor"]]) {
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'human', ?, NULL)
    `).run(id, `${id}-github`, login, `${id}@example.com`, login, new Date().toISOString());
    db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES ('spc_default', ?, ?, ?, NULL)
    `).run(id, role, new Date().toISOString());
  }
  return { db, service: createEchoRequirementService({ db }) };
}

afterEach(async () => {
  for (const db of activeDbs.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dataDir of tempDirs.splice(0)) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

const submission = {
  type: "requirement",
  title: "支持导出需求",
  detail: "希望可以把需求导出成文件。",
  scenario: "整理项目反馈时需要归档。",
  expectedResult: "可以下载结构化的需求文件。",
  relatedLink: "https://example.com/docs",
  idempotencyKey: "submit-1"
};

describe("Echo requirement service", () => {
  it("submits private requirements with stable IDs and idempotent replay", async () => {
    const { db, service } = await createFixture();
    const first = await service.submit({ ...submission, actorId: "usr_submitter" });
    expect(first).toMatchObject({
      publicId: "REQ-2026-0001",
      submitterUserId: "usr_submitter",
      state: "submitted",
      revision: 1,
      relatedLink: "https://example.com/docs"
    });
    const replay = await service.submit({ ...submission, actorId: "usr_submitter" });
    expect(replay).toEqual(first);
    await expect(service.submit({ ...submission, title: "不同标题", actorId: "usr_submitter" }))
      .rejects.toMatchObject({ code: "echo.idempotency_conflict", statusCode: 409 });
    const history = await service.history({ actorId: "usr_submitter", publicId: first.publicId });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromState: null, toState: "submitted", revision: 1, response: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_requirements").get().count).toBe(1);
  });

  it("isolates submitter content from members and non-owner roles", async () => {
    const { db, service } = await createFixture();
    const created = await service.submit({ ...submission, actorId: "usr_submitter" });
    await expect(service.get({ actorId: "usr_owner", publicId: created.publicId })).resolves.toMatchObject({
      detail: submission.detail
    });

    await expect(service.get({ actorId: "usr_other", publicId: created.publicId }))
      .rejects.toBeInstanceOf(EchoRequirementNotFoundError);
    await expect(service.list({ actorId: "usr_other" })).resolves.toEqual([]);
    const audit = db.prepare(`
      SELECT result, reason FROM audit_logs
      WHERE actor_user_id = 'usr_other' AND action = 'echo.requirement.read'
      ORDER BY created_at DESC LIMIT 1
    `).get();
    expect(audit).toEqual({ result: "rejected", reason: "echo.permission_denied" });
  });

  it("keeps admin and auditor projections private and never permits transitions", async () => {
    const { db, service } = await createFixture();
    const created = await service.submit({ ...submission, actorId: "usr_submitter" });
    for (const actorId of ["usr_admin", "usr_auditor"]) {
      await expect(service.get({ actorId, publicId: created.publicId })).rejects.toMatchObject({
        code: "echo.requirement_not_found",
        statusCode: 404
      });
      await expect(service.history({ actorId, publicId: created.publicId })).rejects.toMatchObject({
        code: "echo.requirement_not_found",
        statusCode: 404
      });
      await expect(service.projectCard({ actorId, publicId: created.publicId })).rejects.toMatchObject({
        code: "echo.requirement_not_found",
        statusCode: 404
      });
      await expect(service.projectEvent({ actorId, publicId: created.publicId })).resolves.toBe(null);
      await expect(service.transition({
        actorId,
        publicId: created.publicId,
        toState: "collected",
        expectedRevision: 1,
        idempotencyKey: `transition-${actorId}`
      })).rejects.toMatchObject({ code: "echo.requirement_not_found", statusCode: 404 });
      await expect(service.list({ actorId })).resolves.toEqual([]);
    }
    const adminOwn = await service.submit({
      ...submission,
      title: "管理员自己的反馈",
      idempotencyKey: "admin-submit-1",
      actorId: "usr_admin"
    });
    await expect(service.get({ actorId: "usr_admin", publicId: adminOwn.publicId })).resolves.toMatchObject({
      title: "管理员自己的反馈"
    });
    await expect(service.list({ actorId: "usr_admin" })).resolves.toEqual([
      expect.objectContaining({ publicId: adminOwn.publicId })
    ]);
    const audits = db.prepare(`
      SELECT action, result, reason
      FROM audit_logs
      WHERE actor_user_id IN ('usr_admin', 'usr_auditor') AND action IN ('echo.requirement.read', 'echo.requirement.transition')
    `).all();
    expect(audits.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(audits)).not.toContain(submission.detail);
  });

  it("supports only owner transitions, optimistic revisions, and terminal immutability", async () => {
    const { db, service } = await createFixture();
    const created = await service.submit({ ...submission, actorId: "usr_submitter" });
    await expect(service.transition({
      actorId: "usr_submitter",
      publicId: created.publicId,
      toState: "collected",
      expectedRevision: 1,
      idempotencyKey: "transition-member"
    })).rejects.toBeInstanceOf(EchoRequirementNotFoundError);

    const collected = await service.transition({
      actorId: "usr_owner",
      publicId: created.publicId,
      toState: "collected",
      expectedRevision: 1,
      idempotencyKey: "transition-collect"
    });
    expect(collected).toMatchObject({ state: "collected", revision: 2 });
    const replay = await service.transition({
      actorId: "usr_owner",
      publicId: created.publicId,
      toState: "collected",
      expectedRevision: 1,
      idempotencyKey: "transition-collect"
    });
    expect(replay).toEqual(collected);

    await expect(service.transition({
      actorId: "usr_owner",
      publicId: created.publicId,
      toState: "implemented",
      expectedRevision: 1,
      idempotencyKey: "transition-stale"
    })).rejects.toMatchObject({ code: "echo.revision_conflict" });
    await expect(service.transition({
      actorId: "usr_owner",
      publicId: created.publicId,
      toState: "rejected",
      expectedRevision: 2,
      idempotencyKey: "transition-reject"
    })).rejects.toMatchObject({ code: "echo.rejection_response_required" });

    const rejected = await service.transition({
      actorId: "usr_owner",
      publicId: created.publicId,
      toState: "rejected",
      response: "当前阶段不纳入计划。",
      expectedRevision: 2,
      idempotencyKey: "transition-reject-ok"
    });
    expect(rejected).toMatchObject({ state: "rejected", revision: 3, response: "当前阶段不纳入计划。" });
    await expect(service.transition({
      actorId: "usr_owner",
      publicId: created.publicId,
      toState: "collected",
      response: "不应允许",
      expectedRevision: 3,
      idempotencyKey: "transition-terminal"
    })).rejects.toMatchObject({ code: "echo.invalid_transition" });
    const audits = db.prepare(`
      SELECT reason FROM audit_logs WHERE action = 'echo.requirement.transition' AND result = 'rejected'
    `).all();
    expect(audits.map((row) => row.reason)).toEqual(expect.arrayContaining([
      "echo.permission_denied",
      "echo.revision_conflict",
      "echo.rejection_response_required",
      "echo.invalid_transition"
    ]));
  });

  it("rejects unsafe fields and links before persistence", async () => {
    const { db, service } = await createFixture();
    for (const input of [
      { ...submission, idempotencyKey: "bad-control", title: "bad\u0000title" },
      { ...submission, idempotencyKey: "bad-private", relatedLink: "http://127.0.0.1/admin" },
      { ...submission, idempotencyKey: "bad-scheme", relatedLink: "javascript:alert(1)" },
      { ...submission, idempotencyKey: "bad-type", type: "other" }
    ]) {
      await expect(service.submit({ ...input, actorId: "usr_submitter" })).rejects.toBeInstanceOf(EchoRequirementError);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_requirements").get().count).toBe(0);
    const audits = db.prepare(`
      SELECT action, result, reason FROM audit_logs
      WHERE actor_user_id = 'usr_submitter' AND action = 'echo.requirement.submit' AND result = 'rejected'
    `).all();
    expect(audits.map((row) => row.reason)).toEqual(expect.arrayContaining([
      "echo.title_invalid",
      "echo.related_link_invalid",
      "echo.type_invalid"
    ]));
    expect(JSON.stringify(audits)).not.toContain("127.0.0.1");
    expect(JSON.stringify(audits)).not.toContain("javascript");
  });

  it("projects private events and registered cards only for authorized actors", async () => {
    const { service } = await createFixture();
    const created = await service.submit({ ...submission, actorId: "usr_submitter" });
    await expect(service.projectEvent({ actorId: "usr_other", publicId: created.publicId })).resolves.toBe(null);
    const event = await service.projectEvent({
      actorId: "usr_submitter",
      publicId: created.publicId,
      state: "implemented",
      revision: 99
    });
    expect(event).toMatchObject({
      targetType: "echo.requirement",
      payload: { publicId: created.publicId, state: "submitted", revision: 1 }
    });
    expect(JSON.stringify(event)).not.toContain(submission.detail);

    const card = await service.projectCard({ actorId: "usr_submitter", publicId: created.publicId });
    expect(card.block).toMatchObject({ cardType: "echo.request", schemaVersion: 1 });
    expect(card.payload).toMatchObject({ title: submission.title, detail: submission.detail });
    const registry = createEchoRequirementCardRegistry();
    const validation = registry.validatePayload(card.block, card.payload);
    expect(validation.type).toBe("card");
    expect(ECHO_REQUIREMENT_CARD_DEFINITIONS.map((definition) => definition.cardType)).toEqual([
      "echo.request", "echo.request-status", "echo.request-list"
    ]);
  });
});
