import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { openTestDatabase } from "./test-database.mjs";
import {
  archiveTopic,
  closeTopic,
  createTopic,
  getTopicDetails,
  getTopicSummary,
  joinTopic,
  leaveTopic,
  listTopicMembers,
  listTopics,
  projectTopicCreatedCard,
  TOPIC_CARD_DEFINITION,
  TopicConflictError,
  TopicNotFoundError,
  TopicPermissionError,
  TopicValidationError
} from "./workspace-topics.mjs";

const request = { id: "topic-test", ip: "127.0.0.1", headers: { "user-agent": "vitest" } };
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async ({ db, directory }) => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-topic-"));
  const db = openTestDatabase(directory);
  cleanups.push({ db, directory });
  const now = new Date().toISOString();
  for (const user of [
    ["usr_topic_alice", "topic-alice", "Alice"],
    ["usr_topic_bob", "topic-bob", "Bob"],
    ["usr_topic_outsider", "topic-outsider", "Outsider"]
  ]) {
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at)
      VALUES (?, NULL, ?, NULL, ?, NULL, NULL, 'human', ?)
    `).run(...user, now);
    db.prepare("INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at) VALUES (?, ?, 'member', ?, NULL)")
      .run(DEFAULT_SPACE_ID, user[0], now);
  }
  db.prepare(`
    INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
    VALUES ('conv_topic_group', ?, 'group', 'Topic group', NULL, 10000, 'usr_owner', ?)
  `).run(DEFAULT_SPACE_ID, now);
  for (const userId of ["usr_owner", "usr_topic_alice", "usr_topic_bob"]) {
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES ('conv_topic_group', ?, ?, NULL)")
      .run(userId, now);
  }
  return { db, directory };
}

describe("workspace topic core", () => {
  it("creates from parser syntax, auto-joins creator, and is idempotent", async () => {
    const { db } = await fixture();
    const created = await createTopic(db, request, {
      actorId: "usr_topic_alice",
      conversationId: "conv_topic_group",
      source: "#[设置页](先讨论资料页，再讨论通知页。)",
      idempotencyKey: "client-1"
      ,topicId: "client-forged-id"
    });
    expect(created.id).not.toBe("client-forged-id");
    expect(created).toMatchObject({ title: "设置页", description: "先讨论资料页，再讨论通知页。", joined: true, status: "open", revision: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM topic_members WHERE topic_id = ?").get(created.id).count).toBe(1);
    const repeated = await createTopic(db, request, {
      actorId: "usr_topic_alice",
      conversationId: "conv_topic_group",
      source: "#[设置页](先讨论资料页，再讨论通知页。)",
      idempotencyKey: "client-1"
    });
    expect(repeated.id).toBe(created.id);
    await expect(createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_group",
      source: "#[设置页](另一正文)", idempotencyKey: "client-1"
    })).rejects.toMatchObject({ code: "topic.idempotency_conflict" });
    await expect(createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_group",
      source: "#[设置页](先讨论资料页，再讨论通知页。)", idempotencyKey: "client-1", allowSyncToGroup: true
    })).rejects.toMatchObject({ code: "topic.idempotency_conflict" });
  });

  it("rejects direct conversations and parser failures without storing partial content", async () => {
    const { db } = await fixture();
    db.prepare(`
      INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES ('conv_topic_direct', ?, 'direct', 'Direct', 'topic-direct', 10000, 'usr_owner', ?)
    `).run(DEFAULT_SPACE_ID, new Date().toISOString());
    await expect(createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_direct", source: "#[标题](正文)"
    })).rejects.toMatchObject({ code: "topic.group_only" });
    await expect(createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_group", source: "普通文本 #[标题](正文)"
    })).rejects.toMatchObject({ code: "topic.invalid_title" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM topics").get().count).toBe(0);
  });

  it("returns summary to group members but full description only after joining", async () => {
    const { db } = await fixture();
    const created = await createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_group",
      title: "隐私讨论", description: "这是只有参与者读取的完整正文。"
    });
    const summary = await getTopicSummary(db, { actorId: "usr_topic_bob", topicId: created.id });
    expect(summary).toMatchObject({ title: "隐私讨论", joined: false, descriptionPreview: "这是只有参与者读取的完整正文。" });
    expect(summary.description).toBeUndefined();
    await expect(getTopicDetails(db, { actorId: "usr_topic_bob", topicId: created.id })).rejects.toBeInstanceOf(TopicNotFoundError);
    const joined = await joinTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id });
    expect(joined).toMatchObject({ joined: true, description: "这是只有参与者读取的完整正文。" });
    expect((await listTopicMembers(db, { actorId: "usr_topic_bob", topicId: created.id })).map((item) => item.userId))
      .toEqual(["usr_topic_alice", "usr_topic_bob"]);
  });

  it("blocks outsiders and immediately loses access after group removal", async () => {
    const { db } = await fixture();
    const created = await createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_group", title: "群内话题", description: "正文"
    });
    await expect(getTopicSummary(db, { actorId: "usr_topic_outsider", topicId: created.id })).rejects.toMatchObject({ code: "topic.not_found" });
    db.prepare("UPDATE conversation_members SET removed_at = ? WHERE conversation_id = 'conv_topic_group' AND user_id = 'usr_topic_bob'").run(new Date().toISOString());
    await expect(joinTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id })).rejects.toMatchObject({ code: "topic.not_found" });
  });

  it("makes join and leave idempotent and keeps creator in an open topic", async () => {
    const { db } = await fixture();
    const created = await createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_group", title: "成员", description: "正文"
    });
    await expect(joinTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id })).resolves.toMatchObject({ joined: true });
    await expect(joinTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id })).resolves.toMatchObject({ joined: true });
    await expect(leaveTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id })).resolves.toMatchObject({ joined: false });
    await expect(leaveTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id })).resolves.toMatchObject({ joined: false });
    await expect(leaveTopic(db, request, { actorId: "usr_topic_alice", topicId: created.id })).rejects.toMatchObject({ code: "topic.creator_required" });
    await expect(joinTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id })).resolves.toMatchObject({ joined: true });
    await closeTopic(db, request, { actorId: "usr_topic_alice", topicId: created.id, expectedRevision: 1 });
    await expect(joinTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id })).resolves.toMatchObject({ joined: true });
  });

  it("enforces revisioned transition matrix and management permissions", async () => {
    const { db } = await fixture();
    const created = await createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_group", title: "状态", description: "正文"
    });
    await expect(closeTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id, expectedRevision: 1 })).rejects.toBeInstanceOf(TopicPermissionError);
    const closed = await closeTopic(db, request, { actorId: "usr_topic_alice", topicId: created.id, expectedRevision: 1 });
    expect(closed).toMatchObject({ status: "closed", revision: 2 });
    await expect(archiveTopic(db, request, { actorId: "usr_topic_alice", topicId: created.id, expectedRevision: 1 })).rejects.toBeInstanceOf(TopicConflictError);
    const archived = await archiveTopic(db, request, { actorId: "usr_owner", topicId: created.id, expectedRevision: 2 });
    expect(archived).toMatchObject({ status: "archived", revision: 3 });
    await expect(closeTopic(db, request, { actorId: "usr_owner", topicId: created.id, expectedRevision: 3 })).rejects.toMatchObject({ code: "topic.invalid_transition" });
  });

  it("keeps topic audit metadata free of title and description, and validates card projection", async () => {
    const { db } = await fixture();
    const title = "私密标题";
    const description = "不应进入审计日志的正文";
    const created = await createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_group", title, description
    });
    await joinTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id });
    const logs = db.prepare("SELECT action, reason FROM audit_logs WHERE target_type = 'topic'").all();
    expect(JSON.stringify(logs)).not.toContain(title);
    expect(JSON.stringify(logs)).not.toContain(description);
    const card = projectTopicCreatedCard(created);
    expect(card.block).toMatchObject({ type: "card", cardType: "workspace.topic-created", schemaVersion: 1, fallbackText: "#私密标题" });
    expect(card.payload).toMatchObject({ topicId: created.id, title, status: "open" });
    expect(TOPIC_CARD_DEFINITION.cardType).toBe("workspace.topic-created");
  });

  it("lists discoverable topics with filters", async () => {
    const { db } = await fixture();
    await createTopic(db, request, { actorId: "usr_topic_alice", conversationId: "conv_topic_group", title: "开放", description: "正文" });
    const topics = await listTopics(db, { actorId: "usr_topic_bob", conversationId: "conv_topic_group", status: "open" });
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ title: "开放", joined: false, canJoin: true });
    await expect(listTopics(db, { actorId: "usr_topic_bob", status: "unknown" })).rejects.toMatchObject({ code: "topic.invalid_status" });
  });

  it("records rejected actions for a group outsider and denies auditor mutations", async () => {
    const { db } = await fixture();
    const created = await createTopic(db, request, {
      actorId: "usr_topic_alice", conversationId: "conv_topic_group", title: "审计", description: "不写入日志"
    });
    await expect(joinTopic(db, request, { actorId: "usr_topic_outsider", topicId: created.id })).rejects.toMatchObject({ code: "topic.not_found" });
    const outsiderAudit = db.prepare("SELECT action, result, reason FROM audit_logs WHERE actor_user_id = 'usr_topic_outsider' AND target_id = ? ORDER BY created_at DESC LIMIT 1").get(created.id);
    expect(outsiderAudit).toMatchObject({ action: "topic.join", result: "rejected", reason: "topic.not_found" });
    db.prepare("UPDATE space_members SET role = 'auditor' WHERE user_id = 'usr_topic_bob'").run();
    await expect(joinTopic(db, request, { actorId: "usr_topic_bob", topicId: created.id })).rejects.toMatchObject({ code: "permission.denied" });
  });
});
