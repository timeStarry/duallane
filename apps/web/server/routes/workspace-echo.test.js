import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerWorkspaceEchoRequirementRoutes } from "./workspace-echo.mjs";
import { openTestDatabase } from "../services/test-database.mjs";

const fixtures = [];

async function createFixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "duallane-echo-route-"));
  const db = openTestDatabase(dataDir);
  const app = Fastify({ logger: false });
  registerWorkspaceEchoRequirementRoutes(app, {
    db,
    getActorId: (request) => request.headers["x-workspace-user-id"] ?? null
  });
  const now = new Date().toISOString();
  for (const [id, login, role] of [
    ["usr_echo_submitter", "echoSubmitter", "member"],
    ["usr_echo_other", "echoOther", "member"],
    ["usr_echo_admin", "echoAdmin", "admin"],
    ["usr_auditor", "echoAuditor", "auditor"]
  ]) {
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'human', ?, NULL)
    `).run(id, `${id}-github`, login, `${id}@example.com`, login, now);
    db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES ('spc_default', ?, ?, ?, NULL)
    `).run(id, role, now);
  }
  fixtures.push({ app, db, dataDir });
  return { app, db };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    fixture.db.close();
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

const submission = {
  type: "requirement",
  title: "路由化需求",
  detail: "这段正文只允许提交者和空间主人读取。",
  scenario: "验证私密 Echo API。",
  expectedResult: "越权读取返回统一 404。",
  relatedLink: "https://example.com/echo",
  idempotencyKey: "route-submit-1"
};

function asMember(userId) {
  return { "x-workspace-user-id": userId };
}

describe("Workspace Echo requirement routes", () => {
  it("returns the workspace disabled contract before resolving a caller", async () => {
    const disabledApp = Fastify({ logger: false });
    registerWorkspaceEchoRequirementRoutes(disabledApp, {
      ensureWorkspaceEnabled: () => false,
      getActorId: () => { throw new Error("must not resolve actor"); }
    });
    const disabled = await disabledApp.inject({
      method: "GET",
      url: "/api/workspace/echo/requirements"
    });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json()).toEqual({
      error: { code: "workspace.disabled", message: "共享空间暂未开放" }
    });
    await disabledApp.close();

  });

  it("rejects unauthenticated submissions and never echoes private fields", async () => {
    const { app } = await createFixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/echo/requirements",
      payload: submission
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: "auth.required", message: "请先登录共享空间" }
    });
    expect(response.body).not.toContain(submission.title);
    expect(response.body).not.toContain(submission.detail);
  });

  it("submits, lists, reads, and loads history for the submitter", async () => {
    const { app } = await createFixture();
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/workspace/echo/requirements",
      headers: asMember("usr_echo_submitter"),
      payload: submission
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json().requirement;
    expect(created).toMatchObject({
      publicId: expect.stringMatching(/^REQ-\d{4}-\d{4}$/),
      title: submission.title,
      state: "submitted",
      revision: 1
    });
    expect(createdResponse.body).not.toContain("requestHash");

    const list = await app.inject({
      method: "GET",
      url: "/api/workspace/echo/requirements?limit=10",
      headers: asMember("usr_echo_submitter")
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().requirements).toHaveLength(1);
    expect(list.json().requirements[0]).toMatchObject({ publicId: created.publicId });

    const detail = await app.inject({
      method: "GET",
      url: `/api/workspace/echo/requirements/${created.publicId}`,
      headers: asMember("usr_echo_submitter")
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().requirement).toMatchObject({ detail: submission.detail });

    const history = await app.inject({
      method: "GET",
      url: `/api/workspace/echo/requirements/${created.publicId}/history`,
      headers: asMember("usr_echo_submitter")
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().history).toEqual([
      expect.objectContaining({ fromState: null, toState: "submitted", revision: 1 })
    ]);
  });

  it("allows the owner to transition and keeps history private", async () => {
    const { app, db } = await createFixture();
    const created = (await app.inject({
      method: "POST",
      url: "/api/workspace/echo/requirements",
      headers: asMember("usr_echo_submitter"),
      payload: submission
    })).json().requirement;
    const transition = await app.inject({
      method: "POST",
      url: `/api/workspace/echo/requirements/${created.publicId}/transition`,
      headers: asMember("usr_owner"),
      payload: {
        toState: "collected",
        expectedRevision: 1,
        idempotencyKey: "route-transition-1"
      }
    });
    expect(transition.statusCode).toBe(200);
    expect(transition.json().requirement).toMatchObject({ state: "collected", revision: 2 });

    const history = await app.inject({
      method: "GET",
      url: `/api/workspace/echo/requirements/${created.publicId}/history`,
      headers: asMember("usr_owner")
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().history).toHaveLength(2);
    expect(JSON.stringify(history.json())).not.toContain(submission.detail);
    const audits = db.prepare(`
      SELECT action, result, reason FROM audit_logs
      WHERE action LIKE 'echo.requirement.%'
      ORDER BY rowid ASC
    `).all();
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits)).not.toContain(submission.title);
    expect(JSON.stringify(audits)).not.toContain(submission.detail);
  });

  it("returns not-found for other members and records metadata-only rejection audit", async () => {
    const { app, db } = await createFixture();
    const created = (await app.inject({
      method: "POST",
      url: "/api/workspace/echo/requirements",
      headers: asMember("usr_echo_submitter"),
      payload: submission
    })).json().requirement;
    for (const url of [
      `/api/workspace/echo/requirements/${created.publicId}`,
      `/api/workspace/echo/requirements/${created.publicId}/history`
    ]) {
      const response = await app.inject({ method: "GET", url, headers: asMember("usr_echo_other") });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("echo.requirement_not_found");
      expect(response.body).not.toContain(submission.title);
      expect(response.body).not.toContain(submission.detail);
      expect(response.body).not.toContain(submission.relatedLink);
    }
    const transition = await app.inject({
      method: "POST",
      url: `/api/workspace/echo/requirements/${created.publicId}/transition`,
      headers: asMember("usr_echo_other"),
      payload: { toState: "collected", expectedRevision: 1, idempotencyKey: "route-other-transition" }
    });
    expect(transition.statusCode).toBe(404);
    expect(transition.json().error.code).toBe("echo.requirement_not_found");
    const audits = db.prepare(`
      SELECT action, result, reason FROM audit_logs
      WHERE actor_user_id = 'usr_echo_other' AND result = 'rejected'
    `).all();
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audits)).not.toContain(submission.detail);
    expect(JSON.stringify(audits)).not.toContain(submission.expectedResult);
  });

  it("keeps admin lists scoped to the admin's own submissions and hides auditor content", async () => {
    const { app } = await createFixture();
    const submitter = (await app.inject({
      method: "POST",
      url: "/api/workspace/echo/requirements",
      headers: asMember("usr_echo_submitter"),
      payload: submission
    })).json().requirement;
    const admin = (await app.inject({
      method: "POST",
      url: "/api/workspace/echo/requirements",
      headers: asMember("usr_echo_admin"),
      payload: { ...submission, title: "管理员自己的需求", idempotencyKey: "admin-route-submit-1" }
    })).json().requirement;

    const adminList = await app.inject({
      method: "GET",
      url: "/api/workspace/echo/requirements",
      headers: asMember("usr_echo_admin")
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().requirements.map((item) => item.publicId)).toEqual([admin.publicId]);
    expect(adminList.body).not.toContain(submitter.title);

    const auditor = await app.inject({
      method: "GET",
      url: `/api/workspace/echo/requirements/${submitter.publicId}`,
      headers: asMember("usr_auditor")
    });
    expect(auditor.statusCode).toBe(404);
    expect(auditor.json().error.code).toBe("echo.requirement_not_found");
    expect(auditor.body).not.toContain(submission.detail);
  });

  it("filters owner lists by archive outcome and creation range with page metadata", async () => {
    const { app } = await createFixture();
    const first = (await app.inject({
      method: "POST",
      url: "/api/workspace/echo/requirements",
      headers: asMember("usr_echo_submitter"),
      payload: { ...submission, idempotencyKey: "owner-filter-first" }
    })).json().requirement;
    await app.inject({
      method: "POST",
      url: `/api/workspace/echo/requirements/${first.publicId}/transition`,
      headers: asMember("usr_owner"),
      payload: {
        phase: "archived",
        status: "archived",
        archiveOutcome: "rejected",
        response: "当前范围暂不处理",
        expectedRevision: 1,
        idempotencyKey: "owner-filter-reject"
      }
    });
    const second = (await app.inject({
      method: "POST",
      url: "/api/workspace/echo/requirements",
      headers: asMember("usr_echo_submitter"),
      payload: { ...submission, title: "第二条", idempotencyKey: "owner-filter-second" }
    })).json().requirement;

    const filtered = await app.inject({
      method: "GET",
      url: "/api/workspace/echo/requirements?archiveOutcome=rejected&createdFrom=2000-01-01T00%3A00%3A00.000Z&createdTo=2999-01-01T00%3A00%3A00.000Z",
      headers: asMember("usr_owner")
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({
      requirements: [expect.objectContaining({ publicId: first.publicId, archiveOutcome: "rejected" })],
      total: 1,
      pageInfo: { offset: 0, hasNext: false, nextOffset: null }
    });

    const paged = await app.inject({
      method: "GET",
      url: "/api/workspace/echo/requirements?limit=1",
      headers: asMember("usr_owner")
    });
    expect(paged.json()).toMatchObject({
      total: 2,
      pageInfo: { offset: 0, limit: 1, hasNext: true, nextOffset: 1 }
    });
    expect(paged.json().requirements.map((item) => item.publicId)).toContain(second.publicId);
  });
});
