import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { openTestDatabase } from "./test-database.mjs";
import { createTopic, joinTopic, updateTopicNotificationLevel } from "./workspace-topics.mjs";
import {
  createTopicMessage,
  listTopicMessages,
  markTopicRead,
  syncTopicMessage,
  unsyncTopicMessage
} from "./workspace-topic-messages.mjs";

const request = { id: "topic-message-test", ip: "127.0.0.1", headers: { "user-agent": "vitest" } };
const cleanups = [];
const textContent = (text) => ({
  format: "duallane.message+json;v=1",
  blocks: [{ type: "text", text }]
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async ({ db, directory }) => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-topic-message-"));
  const db = openTestDatabase(directory);
  cleanups.push({ db, directory });
  const now = new Date().toISOString();
  for (const [id, login] of [
    ["usr_topic_message_alice", "topic-message-alice"],
    ["usr_topic_message_bob", "topic-message-bob"],
    ["usr_topic_message_outsider", "topic-message-outsider"]
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
    VALUES ('conv_topic_message_group', ?, 'group', 'Topic message group', NULL, 10000, 'usr_owner', ?)
  `).run(DEFAULT_SPACE_ID, now);
  for (const userId of ["usr_owner", "usr_topic_message_alice", "usr_topic_message_bob"]) {
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES ('conv_topic_message_group', ?, ?, NULL)")
      .run(userId, now);
  }
  return { db };
}

describe("Workspace topic messages", () => {
  it("keeps topic messages out of the ordinary conversation stream", async () => {
    const { db } = await fixture();
    const topic = await createTopic(db, request, {
      actorId: "usr_topic_message_alice",
      conversationId: "conv_topic_message_group",
      title: "隔离",
      description: "创建正文"
    });
    await joinTopic(db, request, { actorId: "usr_topic_message_bob", topicId: topic.id });
    const created = await createTopicMessage(db, request, {
      actorId: "usr_topic_message_alice",
      topicId: topic.id,
      clientMessageId: "topic-message-1",
      content: textContent("只有话题成员能读")
    });
    expect(created.message.topicId).toBe(topic.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE topic_id = ?").get(topic.id).count).toBe(2);
    const groupRows = db.prepare("SELECT plain_text AS plainText FROM messages WHERE conversation_id = ? AND topic_id IS NULL").all(topic.conversationId);
    const card = db.prepare("SELECT plain_text AS plainText FROM messages WHERE client_message_id = ? AND topic_id IS NULL").get(`topic-card:${topic.id}`);
    expect(card.plainText).toContain("#隔离\n创建正文");
    expect(groupRows.map((row) => row.plainText).join(" ")).not.toContain("只有话题成员能读");
    await expect(listTopicMessages(db, { actorId: "usr_topic_message_outsider", topicId: topic.id }))
      .rejects.toMatchObject({ code: "topic.not_found" });
    await expect(listTopicMessages(db, { actorId: "usr_topic_message_bob", topicId: topic.id }))
      .resolves.toHaveLength(2);
  });

  it("tracks per-member unread/read state and notification level", async () => {
    const { db } = await fixture();
    const topic = await createTopic(db, request, {
      actorId: "usr_topic_message_alice",
      conversationId: "conv_topic_message_group",
      title: "未读",
      description: "首条"
    });
    await joinTopic(db, request, { actorId: "usr_topic_message_bob", topicId: topic.id });
    const created = await createTopicMessage(db, request, {
      actorId: "usr_topic_message_alice",
      topicId: topic.id,
      clientMessageId: "topic-message-unread",
      content: textContent("新消息")
    });
    expect(created.unread).toBe(2);
    const read = await markTopicRead(db, request, {
      actorId: "usr_topic_message_bob",
      topicId: topic.id,
      messageId: created.message.id
    });
    expect(read.unreadCount).toBe(0);
    const updated = await updateTopicNotificationLevel(db, request, {
      actorId: "usr_topic_message_bob",
      topicId: topic.id,
      notificationLevel: "muted"
    });
    expect(updated.notificationLevel).toBe("muted");
  });

  it("requires the topic-level sync policy and keeps sync idempotent", async () => {
    const { db } = await fixture();
    const disabled = await createTopic(db, request, {
      actorId: "usr_topic_message_alice",
      conversationId: "conv_topic_message_group",
      title: "不同步",
      description: "正文"
    });
    await expect(syncTopicMessage(db, request, {
      actorId: "usr_topic_message_alice",
      topicId: disabled.id,
      messageId: db.prepare("SELECT id FROM messages WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1").get(disabled.id).id
    })).rejects.toMatchObject({ code: "topic.sync_disabled" });

    const enabled = await createTopic(db, request, {
      actorId: "usr_topic_message_alice",
      conversationId: "conv_topic_message_group",
      title: "同步",
      description: "正文",
      allowSyncToGroup: true
    });
    const first = db.prepare("SELECT id FROM messages WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1").get(enabled.id);
    const synced = await syncTopicMessage(db, request, {
      actorId: "usr_topic_message_alice",
      topicId: enabled.id,
      messageId: first.id
    });
    const replay = await syncTopicMessage(db, request, {
      actorId: "usr_topic_message_alice",
      topicId: enabled.id,
      messageId: first.id
    });
    expect(replay.projection.id).toBe(synced.projection.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM topic_group_projections WHERE topic_message_id = ? AND removed_at IS NULL").get(first.id).count).toBe(1);
    const removed = await unsyncTopicMessage(db, request, {
      actorId: "usr_topic_message_alice",
      topicId: enabled.id,
      messageId: first.id
    });
    expect(removed.removed).toBe(true);
    const resynced = await syncTopicMessage(db, request, {
      actorId: "usr_topic_message_alice",
      topicId: enabled.id,
      messageId: first.id
    });
    expect(resynced.projection.id).toBe(synced.projection.id);
  });
});
