import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SPACE_ID } from "../services/db.mjs";
import { openTestDatabase } from "../services/test-database.mjs";
import { registerWorkspaceTopicRoutes } from "./workspace-topics.mjs";

const fixtures = [];
const headers = (userId) => ({ "x-workspace-user-id": userId });
const content = (text) => ({ format: "duallane.message+json;v=1", blocks: [{ type: "text", text }] });

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    fixture.db.close();
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "duallane-topic-message-route-"));
  const db = openTestDatabase(dataDir);
  const app = Fastify({ logger: false });
  registerWorkspaceTopicRoutes(app, {
    db,
    enabled: true,
    getActorId: (request) => request.headers["x-workspace-user-id"] ?? null
  });
  const now = new Date().toISOString();
  for (const [id, login] of [["route_topic_message_alice", "route-topic-message-alice"], ["route_topic_message_bob", "route-topic-message-bob"], ["route_topic_message_outsider", "route-topic-message-outsider"]]) {
    db.prepare(`INSERT INTO users (id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at) VALUES (?, NULL, ?, NULL, ?, NULL, NULL, 'human', ?)`)
      .run(id, login, login, now);
    db.prepare("INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at) VALUES (?, ?, 'member', ?, NULL)")
      .run(DEFAULT_SPACE_ID, id, now);
  }
  db.prepare(`INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at) VALUES ('route_topic_message_group', ?, 'group', 'Route topic message group', NULL, 10000, 'usr_owner', ?)`)
    .run(DEFAULT_SPACE_ID, now);
  for (const id of ["usr_owner", "route_topic_message_alice", "route_topic_message_bob"]) {
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES ('route_topic_message_group', ?, ?, NULL)").run(id, now);
  }
  fixtures.push({ app, db, dataDir });
  return { app };
}

describe("Workspace topic message routes", () => {
  it("creates, reads, marks and syncs topic messages without exposing outsiders", async () => {
    const { app } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/workspace/conversations/route_topic_message_group/topics",
      headers: headers("route_topic_message_alice"),
      payload: { title: "路由消息", description: "首条正文", allowSyncToGroup: true }
    });
    expect(created.statusCode).toBe(201);
    const topic = created.json().topic;
    expect((await app.inject({ method: "POST", url: `/api/workspace/topics/${topic.id}/join`, headers: headers("route_topic_message_bob"), payload: {} })).statusCode).toBe(200);
    const message = await app.inject({
      method: "POST",
      url: `/api/workspace/topics/${topic.id}/messages`,
      headers: headers("route_topic_message_alice"),
      payload: { clientMessageId: "route-topic-message-1", content: content("路由私密正文") }
    });
    expect(message.statusCode).toBe(201);
    const messageId = message.json().message.id;
    const visible = await app.inject({ method: "GET", url: `/api/workspace/topics/${topic.id}/messages`, headers: headers("route_topic_message_bob") });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().messages.some((item) => item.id === messageId)).toBe(true);
    const outsider = await app.inject({ method: "GET", url: `/api/workspace/topics/${topic.id}/messages`, headers: headers("route_topic_message_outsider") });
    expect(outsider.statusCode).toBe(404);
    expect(outsider.body).not.toContain("路由私密正文");
    const read = await app.inject({ method: "POST", url: `/api/workspace/topics/${topic.id}/read`, headers: headers("route_topic_message_bob"), payload: { messageId } });
    expect(read.statusCode).toBe(200);
    expect(read.json().read.unreadCount).toBe(0);
    const notification = await app.inject({ method: "PATCH", url: `/api/workspace/topics/${topic.id}/notification`, headers: headers("route_topic_message_bob"), payload: { notificationLevel: "muted" } });
    expect(notification.statusCode).toBe(200);
    expect(notification.json().topic.notificationLevel).toBe("muted");
    const sync = await app.inject({ method: "POST", url: `/api/workspace/topics/${topic.id}/messages/${messageId}/sync`, headers: headers("route_topic_message_alice"), payload: {} });
    expect(sync.statusCode).toBe(201);
    expect(sync.json().projection.topicMessageId).toBe(messageId);
  });
});
