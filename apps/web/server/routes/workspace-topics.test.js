import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SPACE_ID } from "../services/db.mjs";
import { openTestDatabase } from "../services/test-database.mjs";
import { registerWorkspaceTopicRoutes } from "./workspace-topics.mjs";

const fixtures = [];
const requestHeaders = (userId) => ({ "x-workspace-user-id": userId });

async function createFixture({ enabled = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "duallane-topic-route-"));
  const db = openTestDatabase(dataDir);
  const app = Fastify({ logger: false });
  registerWorkspaceTopicRoutes(app, {
    db: enabled ? db : undefined,
    enabled,
    getActorId: (request) => request.headers["x-workspace-user-id"] ?? null
  });
  const now = new Date().toISOString();
  for (const [id, login] of [
    ["usr_route_topic_alice", "routeTopicAlice"],
    ["usr_route_topic_bob", "routeTopicBob"],
    ["usr_route_topic_outsider", "routeTopicOutsider"]
  ]) {
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at)
      VALUES (?, NULL, ?, NULL, ?, NULL, NULL, 'human', ?)
    `).run(id, login, login, now);
    db.prepare("INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at) VALUES (?, ?, 'member', ?, NULL)")
      .run(DEFAULT_SPACE_ID, id, now);
  }
  db.prepare(`
    INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
    VALUES ('conv_route_topic_group', ?, 'group', 'Route topic group', NULL, 10000, 'usr_owner', ?)
  `).run(DEFAULT_SPACE_ID, now);
  for (const userId of ["usr_owner", "usr_route_topic_alice", "usr_route_topic_bob"]) {
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES ('conv_route_topic_group', ?, ?, NULL)")
      .run(userId, now);
  }
  fixtures.push({ app, db, dataDir });
  return { app, db };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    fixture.db?.close();
    if (fixture.dataDir) await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

describe("Workspace topic routes", () => {
  it("returns the workspace disabled contract before requiring a database", async () => {
    const app = Fastify({ logger: false });
    registerWorkspaceTopicRoutes(app, { enabled: false });
    fixtures.push({ app, db: null, dataDir: null });
    const response = await app.inject({ method: "GET", url: "/api/workspace/topics" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: "workspace.disabled", message: "共享空间暂未开放" }
    });
  });

  it("requires an authenticated actor and never trusts an arbitrary default header", async () => {
    const { app } = await createFixture();
    const noHeader = await app.inject({ method: "GET", url: "/api/workspace/topics" });
    expect(noHeader.statusCode).toBe(401);
    expect(noHeader.json().error.code).toBe("auth.required");
  });

  it("maps an invalid status filter to a stable validation error", async () => {
    const { app } = await createFixture();
    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/topics?status=not-a-status",
      headers: requestHeaders("usr_route_topic_alice")
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("topic.invalid_status");
  });

  it("creates, idempotently replays and lists mine without accepting a forged topic id", async () => {
    const { app, db } = await createFixture();
    const payload = {
      topicId: "client-forged-topic-id",
      title: "路由话题",
      description: "只给话题成员的正文",
      idempotencyKey: "route-topic-1"
    };
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations/conv_route_topic_group/topics",
      headers: requestHeaders("usr_route_topic_alice"),
      payload
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json().topic;
    expect(created.id).not.toBe(payload.topicId);
    expect(created).toMatchObject({ title: payload.title, joined: true, status: "open" });

    const replay = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations/conv_route_topic_group/topics",
      headers: requestHeaders("usr_route_topic_alice"),
      payload
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().topic.id).toBe(created.id);

    const mine = await app.inject({
      method: "GET",
      url: "/api/workspace/topics/mine",
      headers: requestHeaders("usr_route_topic_alice")
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().topics.map((topic) => topic.id)).toEqual([created.id]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM topics").get().count).toBe(1);
  });

  it("returns only a summary before join, then allows join and leave", async () => {
    const { app } = await createFixture();
    const created = (await app.inject({
      method: "POST",
      url: "/api/workspace/conversations/conv_route_topic_group/topics",
      headers: requestHeaders("usr_route_topic_alice"),
      payload: { title: "加入测试", description: "不得在加入前返回完整正文" }
    })).json().topic;

    const summary = await app.inject({
      method: "GET",
      url: `/api/workspace/topics/${created.id}`,
      headers: requestHeaders("usr_route_topic_bob")
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().topic.description).toBeUndefined();
    expect(summary.json().topic.descriptionPreview).toBe("不得在加入前返回完整正文");

    const joined = await app.inject({
      method: "POST",
      url: `/api/workspace/topics/${created.id}/join`,
      headers: requestHeaders("usr_route_topic_bob"),
      payload: {}
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().topic).toMatchObject({ joined: true, description: created.description });

    const left = await app.inject({
      method: "POST",
      url: `/api/workspace/topics/${created.id}/leave`,
      headers: requestHeaders("usr_route_topic_bob"),
      payload: {}
    });
    expect(left.statusCode).toBe(200);
    expect(left.json().topic.joined).toBe(false);

    const mineAfterLeave = await app.inject({
      method: "GET",
      url: "/api/workspace/topics/mine",
      headers: requestHeaders("usr_route_topic_bob")
    });
    expect(mineAfterLeave.statusCode).toBe(200);
    expect(mineAfterLeave.json().topics.map((topic) => topic.id)).toContain(created.id);
  });

  it("rejects group outsiders and audits malformed IDs without leaking topic content", async () => {
    const { app, db } = await createFixture();
    const created = (await app.inject({
      method: "POST",
      url: "/api/workspace/conversations/conv_route_topic_group/topics",
      headers: requestHeaders("usr_route_topic_alice"),
      payload: { title: "越权测试", description: "正文不应泄露" }
    })).json().topic;

    const outsider = await app.inject({
      method: "POST",
      url: `/api/workspace/topics/${created.id}/join`,
      headers: requestHeaders("usr_route_topic_outsider"),
      payload: {}
    });
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json().error.code).toBe("topic.not_found");
    expect(outsider.body).not.toContain("正文不应泄露");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/workspace/topics/not%20valid/join",
      headers: requestHeaders("usr_route_topic_bob"),
      payload: {}
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("topic.invalid_id");
    const audit = db.prepare(`
      SELECT action, target_id AS targetId, result, reason
      FROM audit_logs WHERE action = 'topic.join' ORDER BY rowid DESC LIMIT 1
    `).get();
    expect(audit).toMatchObject({ action: "topic.join", targetId: "invalid", result: "rejected", reason: "topic.invalid_id" });
  });

  it("closes and archives with the service revision contract", async () => {
    const { app } = await createFixture();
    const created = (await app.inject({
      method: "POST",
      url: "/api/workspace/conversations/conv_route_topic_group/topics",
      headers: requestHeaders("usr_route_topic_alice"),
      payload: { title: "状态测试", description: "正文" }
    })).json().topic;

    const closed = await app.inject({
      method: "POST",
      url: `/api/workspace/topics/${created.id}/close`,
      headers: requestHeaders("usr_route_topic_alice"),
      payload: { expectedRevision: created.revision }
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().topic).toMatchObject({ status: "closed", revision: 2 });

    const archived = await app.inject({
      method: "POST",
      url: `/api/workspace/topics/${created.id}/archive`,
      headers: requestHeaders("usr_owner"),
      payload: { expectedRevision: 2 }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().topic).toMatchObject({ status: "archived", revision: 3 });
  });
});
