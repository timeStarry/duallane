import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createEchoRequirementService } from "./echo-requirements.mjs";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const fixtures = [];

const LEGACY_017 = `
CREATE TABLE echo_requirements (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  submitter_user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('requirement', 'suggestion', 'problem')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  scenario TEXT NOT NULL,
  expected_result TEXT NOT NULL,
  related_link TEXT,
  state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'collected', 'implemented', 'rejected')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  response TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX echo_requirements_space_state_idx
  ON echo_requirements (space_id, state, created_at DESC, id DESC);
CREATE INDEX echo_requirements_submitter_idx
  ON echo_requirements (space_id, submitter_user_id, created_at DESC, id DESC);

CREATE TABLE echo_requirement_sequences (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  sequence_year INTEGER NOT NULL CHECK (sequence_year >= 2000 AND sequence_year <= 9999),
  next_number INTEGER NOT NULL CHECK (next_number > 0 AND next_number <= 10000),
  PRIMARY KEY (space_id, sequence_year)
);

CREATE TABLE echo_requirement_status_history (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES echo_requirements(id) ON DELETE CASCADE,
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('submitted', 'collected', 'implemented', 'rejected')),
  to_state TEXT NOT NULL CHECK (to_state IN ('submitted', 'collected', 'implemented', 'rejected')),
  response TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (requirement_id, revision),
  CHECK ((revision = 1 AND from_state IS NULL) OR (revision > 1 AND from_state IS NOT NULL))
);
CREATE INDEX echo_requirement_history_requirement_idx
  ON echo_requirement_status_history (requirement_id, revision ASC);

CREATE TABLE echo_requirement_idempotency (
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('submit', 'transition')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  requirement_id TEXT NOT NULL REFERENCES echo_requirements(id) ON DELETE CASCADE,
  resulting_state TEXT NOT NULL CHECK (resulting_state IN ('submitted', 'collected', 'implemented', 'rejected')),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_user_id, operation, idempotency_key)
);
CREATE INDEX echo_requirement_idempotency_requirement_idx
  ON echo_requirement_idempotency (requirement_id);
`;

function openLegacyDatabase(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "duallane-legacy.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((fileName) => /^\d+.*\.sql$/.test(fileName) && Number(fileName.slice(0, 3)) < 21)
    .sort();
  for (const fileName of migrationFiles) {
    db.exec(fileName === "017_echo_requirements.sql" ? LEGACY_017 : readFileSync(path.join(migrationsDir, fileName), "utf8"));
  }
  seedLegacyWorkspace(db);
  seedLegacyEchoRows(db);
  db.exec(readFileSync(path.join(migrationsDir, "021_echo_complete.sql"), "utf8"));
  db.transaction = async (callback) => {
    db.exec("BEGIN");
    try {
      const result = await callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  db.lock = async () => {};
  return db;
}

function seedLegacyWorkspace(db) {
  const now = "2026-08-14T00:00:00.000Z";
  for (const [id, login] of [["usr_owner", "owner"], ["usr_member", "member"], ["usr_other", "other"]]) {
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'human', ?, NULL)
    `).run(id, `${login}-github`, login, `${login}@example.test`, login, now);
  }
  db.prepare("INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ('spc_default', 'Default', 'default', 'usr_owner', ?)").run(now);
  db.prepare("INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ('spc_other', 'Other', 'other', 'usr_owner', ?)").run(now);
  for (const [spaceId, userId, role] of [["spc_default", "usr_owner", "owner"], ["spc_default", "usr_member", "member"], ["spc_other", "usr_owner", "owner"], ["spc_other", "usr_other", "member"]]) {
    db.prepare("INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at) VALUES (?, ?, ?, ?, NULL)").run(spaceId, userId, role, now);
  }
}

function seedLegacyEchoRows(db) {
  const createdAt = "2025-08-14T00:00:00.000Z";
  db.prepare(`
    INSERT INTO echo_requirements (
      id, public_id, space_id, submitter_user_id, type, title, detail, scenario,
      expected_result, related_link, state, revision, response, created_at, updated_at
    ) VALUES ('echo_req_legacy', 'REQ-2025-0001', 'spc_default', 'usr_member', 'requirement',
      '旧需求', '旧正文', '旧场景', '旧结果', NULL, 'implemented', 1, NULL, ?, ?)
  `).run(createdAt, createdAt);
  db.prepare(`
    INSERT INTO echo_requirement_status_history (
      id, requirement_id, from_state, to_state, response, actor_user_id,
      revision, idempotency_key, created_at
    ) VALUES ('echo_history_legacy', 'echo_req_legacy', NULL, 'implemented', NULL,
      'usr_owner', 1, 'legacy-history', ?)
  `).run(createdAt);
  db.prepare(`
    INSERT INTO echo_requirement_idempotency (
      actor_user_id, operation, idempotency_key, request_hash, requirement_id,
      resulting_state, resulting_revision, created_at
    ) VALUES ('usr_member', 'submit', 'legacy-idempotency', 'legacy-hash',
      'echo_req_legacy', 'implemented', 1, ?)
  `).run(createdAt);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

describe("Echo migration 021 legacy compatibility", () => {
  it("upgrades original 017 through pre-021 migrations and preserves the complete workflow", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "duallane-echo-legacy-migration-"));
    const db = openLegacyDatabase(dataDir);
    fixtures.push({ db, dataDir });
    const now = () => new Date("2026-08-14T00:00:00.000Z");
    const defaultService = createEchoRequirementService({ db, spaceId: "spc_default", now });
    const otherService = createEchoRequirementService({ db, spaceId: "spc_other", now });
    expect(db.prepare("SELECT phase, status, archive_outcome AS archiveOutcome FROM echo_requirements WHERE id = 'echo_req_legacy'").get())
      .toEqual({ phase: "formal", status: "delivered", archiveOutcome: null });
    expect(db.prepare("SELECT to_phase AS toPhase, to_status AS toStatus FROM echo_requirement_status_history WHERE id = 'echo_history_legacy'").get())
      .toEqual({ toPhase: "formal", toStatus: "delivered" });
    expect(db.prepare("SELECT space_id AS spaceId, result_json AS resultJson FROM echo_requirement_idempotency WHERE idempotency_key = 'legacy-idempotency'").get())
      .toEqual({ spaceId: "spc_default", resultJson: null });
    const input = {
      actorId: "usr_member",
      type: "requirement",
      title: "旧库升级",
      detail: "保留正文",
      scenario: "数据库升级",
      expectedResult: "状态不漂移",
      idempotencyKey: "legacy-submit"
    };

    const first = await defaultService.submit(input);
    const replay = await defaultService.submit(input);
    expect(replay).toMatchObject({ publicId: first.publicId, revision: 1, phase: "proposal", status: "pending_review" });

    const duplicateTarget = await defaultService.submit({ ...input, idempotencyKey: "legacy-duplicate-target" });
    const otherSpace = await otherService.submit({ ...input, actorId: "usr_other" });
    expect(otherSpace.publicId).toBe(first.publicId);

    const planned = await defaultService.transition({
      actorId: "usr_owner", publicId: first.publicId, phase: "formal", status: "planned",
      expectedRevision: 1, idempotencyKey: "legacy-planned"
    });
    expect(planned).toMatchObject({ phase: "formal", status: "planned", state: "collected", revision: 2 });
    const inProgress = await defaultService.transition({
      actorId: "usr_owner", publicId: first.publicId, phase: "formal", status: "in_progress",
      expectedRevision: 2, idempotencyKey: "legacy-progress"
    });
    expect(inProgress).toMatchObject({ phase: "formal", status: "in_progress", state: "in_progress", revision: 3 });
    const delivered = await defaultService.transition({
      actorId: "usr_owner", publicId: first.publicId, phase: "formal", status: "delivered",
      expectedRevision: 3, idempotencyKey: "legacy-delivered"
    });
    expect(delivered).toMatchObject({ phase: "formal", status: "delivered", state: "implemented", revision: 4 });
    const archived = await defaultService.transition({
      actorId: "usr_owner", publicId: first.publicId, phase: "archived", status: "archived",
      archiveOutcome: "duplicate", duplicateOfPublicId: duplicateTarget.publicId,
      expectedRevision: 4, idempotencyKey: "legacy-duplicate"
    });
    expect(archived).toMatchObject({ phase: "archived", status: "archived", archiveOutcome: "duplicate", duplicateOfPublicId: duplicateTarget.publicId, revision: 5 });
    const transitionReplay = await defaultService.transition({
      actorId: "usr_owner", publicId: first.publicId, phase: "archived", status: "archived",
      archiveOutcome: "duplicate", duplicateOfPublicId: duplicateTarget.publicId,
      expectedRevision: 4, idempotencyKey: "legacy-duplicate"
    });
    expect(transitionReplay).toMatchObject({ revision: archived.revision, archiveOutcome: "duplicate" });
  });
});
