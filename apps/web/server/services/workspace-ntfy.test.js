import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import { createTopic, createWorkspaceNtfyService } from "./workspace-ntfy.mjs";
import {
  acceptInvite,
  createConversation,
  createInvite,
  createStructuredMessage,
  markConversationRead,
  updateConversationNotificationLevel,
  MESSAGE_CONTENT_FORMAT
} from "./workspace.mjs";

const request = { id: "ntfy-test", ip: "127.0.0.1", headers: { "user-agent": "vitest" } };

function textContent(text) {
  return {
    format: MESSAGE_CONTENT_FORMAT,
    plainText: text,
    blocks: [{ type: "text", text }]
  };
}

describe("workspace ntfy service", () => {
  let dataDir;
  let db;
  let current;
  let deliveries;
  let service;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-ntfy-test-"));
    db = openTestDatabase(dataDir);
    current = new Date(Date.now() - 1_000);
    deliveries = [];
    service = createWorkspaceNtfyService({
      db,
      env: {
        NODE_ENV: "test",
        WORKSPACE_NTFY_BASE_URL: "https://ntfy.example.test",
        WORKSPACE_FRONTEND_URL: "https://duallane.example.test"
      },
      now: () => new Date(current),
      publish: async (message) => deliveries.push(message)
    });
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("generates a stable private topic and rotates it only on explicit request", async () => {
    expect(createTopic("TimeStarry", () => 0)).toBe("duallane-timestarry-AAAAAA");
    const first = await service.getPreferences("usr_owner");
    const second = await service.getPreferences("usr_owner");
    expect(first.enabled).toBe(true);
    expect(first.topic).toBe(second.topic);
    expect(first.topic).toMatch(/^duallane-timestarry-[A-Za-z0-9]{6}$/u);
    expect(first.subscriptionUrl).toBe(`https://ntfy.example.test/${first.topic}`);

    const rotated = await service.rotateTopic("usr_owner");
    expect(rotated.topic).not.toBe(first.topic);
    expect(rotated.rotatedAt).toBe(current.toISOString());
    expect((await service.getPreferences("usr_owner")).topic).toBe(rotated.topic);
  });

  it("publishes unread direct notifications with the recipient's private name projection", async () => {
    const member = await createMember("ntfy-recipient");
    await db.prepare(`
      INSERT INTO user_remarks (owner_user_id, target_user_id, remark, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(member.id, "usr_owner", "项目负责人", current.toISOString());
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    const secret = "this message body must not enter the ntfy job or notification";
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "ntfy-direct-1",
      content: textContent(secret),
      scheduleNtfyNotifications: service.scheduleMessage
    });

    const serializedJobs = JSON.stringify(db.prepare("SELECT * FROM workspace_ntfy_jobs").all());
    expect(serializedJobs).not.toContain(secret);
    current = new Date(Date.now() + 6_000);
    const worker = service.startWorker({ startupDelayMs: 60_000, intervalMs: 60_000 });
    await worker.tick();
    worker.stop();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      title: "DualLane",
      message: "项目负责人 通过私聊给你发送了消息",
      clickUrl: `https://duallane.example.test/workspace/chat/${conversation.id}`
    });
    expect(JSON.stringify(deliveries)).not.toContain(secret);
  });

  it("honors all, mentions, muted, unread cancellation, and topic rotation", async () => {
    const member = await createMember("ntfy-mention");
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "版本发布",
      memberIds: [member.id]
    });
    await updateConversationNotificationLevel(db, request, {
      actorId: member.id,
      conversationId: conversation.id,
      notificationLevel: "mentions"
    });

    await sendMessage(conversation.id, "ntfy-plain", textContent("普通群消息"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_ntfy_jobs").get().count).toBe(0);

    const mentionContent = {
      format: MESSAGE_CONTENT_FORMAT,
      plainText: "@ntfy-mention",
      blocks: [{ type: "mention", userId: member.id, label: "ntfy-mention" }]
    };
    await sendMessage(conversation.id, "ntfy-mentioned", mentionContent);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_ntfy_jobs").get().count).toBe(1);

    const oldTopic = (await service.getPreferences(member.id)).topic;
    const rotated = await service.rotateTopic(member.id);
    expect(rotated.topic).not.toBe(oldTopic);
    expect(db.prepare("SELECT status FROM workspace_ntfy_jobs").get().status).toBe("cancelled");

    await sendMessage(conversation.id, "ntfy-mentioned-after-rotate", mentionContent);
    current = new Date(Date.now() + 6_000);
    const worker = service.startWorker({ startupDelayMs: 60_000, intervalMs: 60_000 });
    await worker.tick();
    expect(deliveries.at(-1)).toMatchObject({
      topic: rotated.topic,
      message: "有人在「版本发布」群聊中 @你"
    });

    await sendMessage(conversation.id, "ntfy-read-before-delivery", mentionContent);
    await markConversationRead(db, request, { actorId: member.id, conversationId: conversation.id });
    current = new Date(current.getTime() + 6_000);
    await worker.tick();
    expect(db.prepare(`
      SELECT status FROM workspace_ntfy_jobs
      WHERE message_id = (SELECT id FROM messages WHERE client_message_id = 'ntfy-read-before-delivery')
    `).get().status).toBe("cancelled");

    await updateConversationNotificationLevel(db, request, {
      actorId: member.id,
      conversationId: conversation.id,
      notificationLevel: "muted"
    });
    await sendMessage(conversation.id, "ntfy-muted", mentionContent);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_ntfy_jobs j
      INNER JOIN messages m ON m.id = j.message_id
      WHERE m.client_message_id = 'ntfy-muted'
    `).get().count).toBe(0);
    worker.stop();
  });

  it("keeps preferences while disabled and does not enqueue new jobs", async () => {
    const member = await createMember("ntfy-disabled");
    const original = await service.getPreferences(member.id);
    const disabled = await service.updatePreferences(member.id, { enabled: false });
    expect(disabled).toMatchObject({ enabled: false, topic: original.topic });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    await sendMessage(conversation.id, "ntfy-disabled-message", textContent("不会推送"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_ntfy_jobs").get().count).toBe(0);
  });

  it("leases failed deliveries and stops after the bounded retry schedule", async () => {
    const member = await createMember("ntfy-retry");
    const retryService = createWorkspaceNtfyService({
      db,
      env: {
        NODE_ENV: "test",
        WORKSPACE_NTFY_BASE_URL: "https://ntfy.example.test",
        WORKSPACE_FRONTEND_URL: "https://duallane.example.test"
      },
      now: () => new Date(current),
      publish: async () => {
        throw new Error("raw upstream detail must not be persisted");
      }
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "ntfy-retry-message",
      content: textContent("retry secret"),
      scheduleNtfyNotifications: retryService.scheduleMessage
    });
    current = new Date(Date.now() + 6_000);
    const worker = retryService.startWorker({ startupDelayMs: 60_000, intervalMs: 60_000 });

    await worker.tick();
    expect(db.prepare("SELECT status, attempt_count AS attemptCount, last_error_code AS errorCode FROM workspace_ntfy_jobs").get())
      .toMatchObject({ status: "pending", attemptCount: 1, errorCode: "ntfy.unavailable" });
    current = new Date(current.getTime() + 60_001);
    await worker.tick();
    current = new Date(current.getTime() + 5 * 60_000 + 1);
    await worker.tick();
    current = new Date(current.getTime() + 30 * 60_000 + 1);
    await worker.tick();
    worker.stop();

    const failed = db.prepare("SELECT status, attempt_count AS attemptCount, last_error_code AS errorCode FROM workspace_ntfy_jobs").get();
    expect(failed).toMatchObject({ status: "failed", attemptCount: 4, errorCode: "ntfy.unavailable" });
    expect(JSON.stringify(failed)).not.toContain("raw upstream detail");
  });

  async function createMember(login) {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: `NTFY-${login.toUpperCase()}`
    });
    return await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: login,
      email: `${login}@example.test`
    });
  }

  async function sendMessage(conversationId, clientMessageId, content) {
    return await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId,
      clientMessageId,
      content,
      scheduleNtfyNotifications: service.scheduleMessage
    });
  }
});
