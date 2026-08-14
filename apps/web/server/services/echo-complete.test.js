import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import {
  createEchoRequirementService,
  EchoRequirementConflictError,
  EchoRequirementError
} from "./echo-requirements.mjs";
import { createEchoSolicitationService } from "./echo-solicitations.mjs";

const fixtures = [];

async function createFixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "duallane-echo-complete-"));
  const db = openTestDatabase(dataDir);
  const now = new Date("2026-08-14T00:00:00.000Z").toISOString();
  const addUser = (id, role = "member") => {
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'human', ?, NULL)
    `).run(id, `${id}-github`, id, `${id}@example.com`, id, now);
    db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES ('spc_default', ?, ?, ?, NULL)
    `).run(id, role, now);
  };
  addUser("usr_auditor", "auditor");
  addUser("usr_member", "member");
  db.prepare(`INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ('spc_other', '其他空间', 'other', 'usr_owner', ?)`)
    .run(now);
  addUser("usr_other_space", "member");
  db.prepare(`UPDATE space_members SET space_id = 'spc_other' WHERE user_id = 'usr_other_space'`).run();
  fixtures.push({ db, dataDir, now });
  return { db, now };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

const requirementInput = {
  type: "requirement",
  title: "跨空间编号",
  detail: "仅测试编号和阶段语义。",
  scenario: "自动化测试",
  expectedResult: "结果不漂移",
  idempotencyKey: "req-1"
};

describe("Echo v0.15 completion contract", () => {
  it("rejects auditor submissions without persisting private requirement content", async () => {
    const { db } = await createFixture();
    const service = createEchoRequirementService({ db, now: () => new Date("2026-08-14T00:00:00.000Z") });
    await expect(service.submit({ ...requirementInput, actorId: "usr_auditor" }))
      .rejects.toMatchObject({ code: "echo.permission_denied", statusCode: 403 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_requirements").get().count).toBe(0);
    expect(db.prepare("SELECT action, result, reason FROM audit_logs WHERE action = 'echo.requirement.submit' ORDER BY created_at DESC LIMIT 1").get())
      .toMatchObject({ result: "rejected", reason: "permission.denied" });
  });

  it("scopes public IDs and duplicate proposals to one space", async () => {
    const { db } = await createFixture();
    const defaultService = createEchoRequirementService({ db, now: () => new Date("2026-08-14T00:00:00.000Z") });
    const otherService = createEchoRequirementService({ db, spaceId: "spc_other", now: () => new Date("2026-08-14T00:00:00.000Z") });
    const first = await defaultService.submit({ ...requirementInput, actorId: "usr_member" });
    const second = await otherService.submit({ ...requirementInput, actorId: "usr_other_space" });
    expect(first.publicId).toBe(second.publicId);
    const archived = await defaultService.transition({
      actorId: "usr_owner",
      publicId: first.publicId,
      phase: "archived",
      status: "archived",
      archiveOutcome: "duplicate",
      duplicateOfPublicId: first.publicId,
      expectedRevision: 1,
      idempotencyKey: "duplicate-self"
    }).catch((error) => error);
    expect(archived).toMatchObject({ code: "echo.duplicate_target_invalid" });
    const valid = await defaultService.transition({
      actorId: "usr_owner",
      publicId: first.publicId,
      phase: "archived",
      status: "archived",
      archiveOutcome: "duplicate",
      duplicateOfPublicId: second.publicId,
      expectedRevision: 1,
      idempotencyKey: "duplicate-other-space"
    }).catch((error) => error);
    expect(valid).toMatchObject({ code: "echo.duplicate_target_invalid" });
  });

  it("projects long private bodies into a bounded card", async () => {
    const { db } = await createFixture();
    const service = createEchoRequirementService({ db });
    const created = await service.submit({
      actorId: "usr_member",
      ...requirementInput,
      detail: "长".repeat(10_000),
      scenario: "场景".repeat(5_000),
      expectedResult: "结果".repeat(5_000),
      idempotencyKey: "long-1"
    });
    const card = await service.projectCard({ actorId: "usr_member", publicId: created.publicId });
    expect(JSON.stringify(card).length).toBeLessThan(20_000);
    expect(card.payload.detail.endsWith("…")).toBe(true);
  });

  it("runs solicitation draft/open/closed with vote and owner delivery projection", async () => {
    const { db } = await createFixture();
    const service = createEchoSolicitationService({ db, now: () => new Date("2026-08-14T00:00:00.000Z") });
    const draft = await service.create({
      actorId: "usr_owner",
      title: "发布计划",
      description: "请选择方向",
      question: "哪个优先？",
      options: ["Web", "移动"],
      idempotencyKey: "sol-create-1",
      deadline: "2026-08-20T00:00:00.000Z"
    });
    expect(draft.status).toBe("draft");
    const open = await service.publish({ actorId: "usr_owner", publicId: draft.publicId, idempotencyKey: "sol-publish-1" });
    expect(open).toMatchObject({ status: "open", ownerProjection: { canViewVoters: true } });
    expect(open.ownerProjection.deliverySummary.pending).toBeGreaterThanOrEqual(3);
    const vote = await service.vote({
      actorId: "usr_member",
      publicId: draft.publicId,
      optionIds: [open.options[0].id],
      expectedRevision: open.revision,
      idempotencyKey: "sol-vote-1"
    });
    expect(vote.counts[open.options[0].id]).toBe(1);
    const closed = await service.close({ actorId: "usr_owner", publicId: draft.publicId, idempotencyKey: "sol-close-1" });
    expect(closed.status).toBe("closed");
    await expect(service.vote({
      actorId: "usr_member",
      publicId: draft.publicId,
      optionIds: [open.options[1].id],
      idempotencyKey: "sol-vote-2"
    })).rejects.toMatchObject({ code: "echo.vote_closed" });
    expect((await service.listVotes({ actorId: "usr_owner", publicId: draft.publicId })).length).toBe(1);
    expect((await service.listDeliveries({ actorId: "usr_owner", publicId: draft.publicId })).length).toBeGreaterThanOrEqual(3);
  });

  it("rejects solicitation transitions when the compare-and-swap update loses", async () => {
    const { db } = await createFixture();
    const service = createEchoSolicitationService({ db, now: () => new Date("2026-08-14T00:00:00.000Z") });
    const draft = await service.create({
      actorId: "usr_owner",
      title: "并发发布",
      description: "验证发布状态不会误报成功",
      question: "是否发布？",
      options: ["是", "否"],
      idempotencyKey: "sol-cas-create"
    });
    db.exec(`
      CREATE TRIGGER echo_solicitation_ignore_status_update
      BEFORE UPDATE OF status ON echo_solicitations
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    await expect(service.publish({
      actorId: "usr_owner",
      publicId: draft.publicId,
      idempotencyKey: "sol-cas-publish"
    })).rejects.toMatchObject({ code: "echo.revision_conflict" });
    expect(db.prepare("SELECT status, revision FROM echo_solicitations WHERE public_id = ?").get(draft.publicId))
      .toEqual({ status: "draft", revision: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_solicitation_idempotency WHERE idempotency_key = 'sol-cas-publish'").get().count).toBe(0);
  });

  it("rolls back a vote when the solicitation revision compare-and-swap loses", async () => {
    const { db } = await createFixture();
    const service = createEchoSolicitationService({ db, now: () => new Date("2026-08-14T00:00:00.000Z") });
    const draft = await service.create({
      actorId: "usr_owner",
      title: "并发投票",
      description: "验证投票不会与征集版本脱节",
      question: "选择哪项？",
      options: ["A", "B"],
      idempotencyKey: "sol-vote-cas-create"
    });
    const open = await service.publish({ actorId: "usr_owner", publicId: draft.publicId, idempotencyKey: "sol-vote-cas-publish" });
    db.exec(`
      CREATE TRIGGER echo_solicitation_ignore_revision_only_update
      BEFORE UPDATE OF revision ON echo_solicitations
      WHEN NEW.status = OLD.status
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    await expect(service.vote({
      actorId: "usr_member",
      publicId: open.publicId,
      optionIds: [open.options[0].id],
      expectedRevision: open.revision,
      idempotencyKey: "sol-vote-cas"
    })).rejects.toMatchObject({ code: "echo.revision_conflict" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_solicitation_votes").get().count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_solicitation_idempotency WHERE idempotency_key = 'sol-vote-cas'").get().count).toBe(0);
  });
});
