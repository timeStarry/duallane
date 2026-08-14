import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import { createWorkspaceEmailService } from "./workspace-email.mjs";
import { createTopic, joinTopic } from "./workspace-topics.mjs";
import { createTopicMessage } from "./workspace-topic-messages.mjs";
import {
  acceptInvite,
  createConversation,
  createInvite,
  createStructuredMessage,
  markConversationRead,
  updateConversationNotificationLevel,
  MESSAGE_CONTENT_FORMAT
} from "./workspace.mjs";

const request = { id: "email-test", ip: "127.0.0.1", headers: { "user-agent": "vitest" } };
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const smtpDraft = {
  enabled: true,
  smtpHost: "smtp.example.test",
  smtpPort: 587,
  encryption: "starttls",
  username: "sender@example.test",
  password: "smtp-secret-value",
  fromAddress: "sender@example.test",
  fromName: "DualLane"
};

function textContent(text) {
  return {
    format: MESSAGE_CONTENT_FORMAT,
    plainText: text,
    blocks: [{ type: "text", text }]
  };
}

describe("workspace email service", () => {
  let dataDir;
  let db;
  let current;
  let deliveries;
  let service;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-email-test-"));
    db = openTestDatabase(dataDir);
    current = new Date(Date.now() - 1_000);
    deliveries = [];
    service = createWorkspaceEmailService({
      db,
      env: {
        NODE_ENV: "test",
        WORKSPACE_SMTP_ENCRYPTION_KEY: encryptionKey,
        WORKSPACE_FRONTEND_URL: "https://duallane.example.test"
      },
      now: () => new Date(current),
      sendMail: async (config, message, recipient) => {
        deliveries.push({ config, message, recipient });
      }
    });
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("requires owner access, encrypts credentials, and binds enablement to a tested draft", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "EMAIL-PERMISSION" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "email-member",
      email: "email-member@example.test"
    });
    await expect(service.getSpaceSettings(member.id)).rejects.toMatchObject({ code: "permission.denied", statusCode: 403 });

    const tested = await service.testSpaceSettings(request, "usr_owner", smtpDraft);
    expect(tested.testProof).toEqual(expect.any(String));
    expect(deliveries[0].recipient).toBe("timestarry@qq.com");

    await expect(service.saveSpaceSettings(request, "usr_owner", {
      ...smtpDraft,
      smtpHost: "changed.example.test",
      testProof: tested.testProof
    })).rejects.toMatchObject({ code: "email.smtp_test_required" });

    const saved = await service.saveSpaceSettings(request, "usr_owner", { ...smtpDraft, testProof: tested.testProof });
    expect(saved).toMatchObject({ enabled: true, passwordConfigured: true, smtpHost: "smtp.example.test" });
    const raw = db.prepare("SELECT password_ciphertext AS passwordCiphertext FROM space_email_settings").get();
    expect(raw.passwordCiphertext).not.toContain(smtpDraft.password);
    expect(JSON.stringify(saved)).not.toContain(smtpDraft.password);
  });

  it("verifies custom email without persisting the code in audit rows", async () => {
    const tested = await service.testSpaceSettings(request, "usr_owner", smtpDraft);
    await service.saveSpaceSettings(request, "usr_owner", { ...smtpDraft, testProof: tested.testProof });

    const challenge = await service.createEmailChallenge(request, "usr_owner", { email: "custom@example.test" });
    const code = deliveries.at(-1).message.text.match(/\b\d{6}\b/)?.[0];
    expect(code).toMatch(/^\d{6}$/);
    const verified = await service.verifyEmailChallenge(request, "usr_owner", {
      challengeId: challenge.challengeId,
      code
    });
    expect(verified).toMatchObject({ email: "custom@example.test", emailSource: "custom", emailVerified: true });
    const serializedAudits = JSON.stringify(db.prepare("SELECT * FROM audit_logs").all());
    expect(serializedAudits).not.toContain("custom@example.test");
    expect(serializedAudits).not.toContain(code);
  });

  it("expires verification challenges and enforces the hourly send limit", async () => {
    const tested = await service.testSpaceSettings(request, "usr_owner", smtpDraft);
    await service.saveSpaceSettings(request, "usr_owner", { ...smtpDraft, testProof: tested.testProof });

    const expired = await service.createEmailChallenge(request, "usr_owner", { email: "expired@example.test" });
    const expiredCode = deliveries.at(-1).message.text.match(/\b\d{6}\b/)?.[0];
    current = new Date(current.getTime() + 10 * 60 * 1000 + 1);
    await expect(service.verifyEmailChallenge(request, "usr_owner", {
      challengeId: expired.challengeId,
      code: expiredCode
    })).rejects.toMatchObject({ code: "email.verification_invalid" });

    for (let index = 0; index < 4; index += 1) {
      current = new Date(current.getTime() + 61_000);
      await service.createEmailChallenge(request, "usr_owner", { email: `limit-${index}@example.test` });
    }
    current = new Date(current.getTime() + 61_000);
    await expect(service.createEmailChallenge(request, "usr_owner", {
      email: "limit-rejected@example.test"
    })).rejects.toMatchObject({ code: "email.verification_rate_limited", statusCode: 429 });
  });

  it("defers immediate mail while online and sends only metadata after the message stays unread", async () => {
    const tested = await service.testSpaceSettings(request, "usr_owner", smtpDraft);
    await service.saveSpaceSettings(request, "usr_owner", { ...smtpDraft, testProof: tested.testProof });
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "EMAIL-RECIPIENT" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "email-recipient",
      email: "recipient@example.test"
    });
    await service.syncGitHubEmail(member.id, "recipient@example.test");
    await service.updatePreferences(member.id, { immediateEnabled: true, digestEnabled: true });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    const secret = "message body must never enter email jobs or templates";
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "email-message-1",
      content: textContent(secret),
      scheduleEmailNotifications: service.scheduleMessage
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_email_jobs").get().count).toBe(1);
    expect(JSON.stringify(db.prepare("SELECT * FROM workspace_email_jobs").all())).not.toContain(secret);

    current = new Date(Date.now() + 61_000);
    const worker = service.startWorker({ startupDelayMs: 60_000, intervalMs: 60_000, presence: { isOnline: () => true } });
    await worker.tick();
    expect(db.prepare("SELECT status FROM workspace_email_jobs").get().status).toBe("pending");
    current = new Date(current.getTime() + 31_000);
    const offlineWorker = service.startWorker({ startupDelayMs: 60_000, intervalMs: 60_000, presence: { isOnline: () => false } });
    await offlineWorker.tick();
    const immediate = deliveries.at(-1);
    expect(db.prepare("SELECT status FROM workspace_email_jobs").get().status).toBe("sent");
    expect(immediate.recipient).toBe("recipient@example.test");
    expect(immediate.message.text).toContain("有人通过 DualLane 给您发送了一条消息");
    expect(JSON.stringify(immediate)).not.toContain(secret);
    worker.stop();
    offlineWorker.stop();
  });

  it("applies mentions and muted conversation gates before creating immediate jobs", async () => {
    const tested = await service.testSpaceSettings(request, "usr_owner", smtpDraft);
    await service.saveSpaceSettings(request, "usr_owner", { ...smtpDraft, testProof: tested.testProof });
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "EMAIL-MENTION" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "email-mention",
      email: "mention@example.test"
    });
    await service.syncGitHubEmail(member.id, "mention@example.test");
    await service.updatePreferences(member.id, { immediateEnabled: true, digestEnabled: false });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    await updateConversationNotificationLevel(db, request, {
      actorId: member.id,
      conversationId: conversation.id,
      notificationLevel: "mentions"
    });

    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "email-mention-plain",
      content: textContent("没有提及"),
      scheduleEmailNotifications: service.scheduleMessage
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_email_jobs").get().count).toBe(0);

    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "email-mention-targeted",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        plainText: "@email-mention",
        blocks: [{ type: "mention", userId: member.id, label: "email-mention" }]
      },
      scheduleEmailNotifications: service.scheduleMessage
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_email_jobs").get().count).toBe(1);

    await updateConversationNotificationLevel(db, request, {
      actorId: member.id,
      conversationId: conversation.id,
      notificationLevel: "muted"
    });
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "email-muted-targeted",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        plainText: "@email-mention",
        blocks: [{ type: "mention", userId: member.id, label: "email-mention" }]
      },
      scheduleEmailNotifications: service.scheduleMessage
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_email_jobs").get().count).toBe(1);
  });

  it("aggregates one digest per unread cycle and starts a new cycle after reading", async () => {
    const tested = await service.testSpaceSettings(request, "usr_owner", smtpDraft);
    await service.saveSpaceSettings(request, "usr_owner", { ...smtpDraft, testProof: tested.testProof });
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "EMAIL-DIGEST" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "email-digest",
      email: "digest@example.test"
    });
    await service.syncGitHubEmail(member.id, "digest@example.test");
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    for (let index = 0; index < 2; index += 1) {
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: `email-digest-${index}`,
        content: textContent(`digest ${index}`),
        scheduleEmailNotifications: service.scheduleMessage
      });
    }

    const baseline = deliveries.length;
    current = new Date(Date.now() + 2 * 60 * 60 * 1000 + 61_000);
    const worker = service.startWorker({ startupDelayMs: 60_000, intervalMs: 60_000 });
    await worker.tick();
    expect(deliveries).toHaveLength(baseline + 1);
    expect(deliveries.at(-1).message.text).toContain("有1人给您发送了2条消息");

    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "email-digest-same-cycle",
      content: textContent("same cycle"),
      scheduleEmailNotifications: service.scheduleMessage
    });
    current = new Date(current.getTime() + 60_000);
    await worker.tick();
    expect(deliveries).toHaveLength(baseline + 1);

    await markConversationRead(db, request, { actorId: member.id, conversationId: conversation.id });
    await service.reconcileDigestState(member.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_email_digest_states").get().count).toBe(0);

    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "email-digest-new-cycle",
      content: textContent("new cycle"),
      scheduleEmailNotifications: service.scheduleMessage
    });
    current = new Date(current.getTime() + 2 * 60 * 60 * 1000 + 61_000);
    await worker.tick();
    expect(deliveries).toHaveLength(baseline + 2);
    expect(deliveries.at(-1).message.text).toContain("有1人给您发送了1条消息");
    worker.stop();
  });

  it("delivers unread topic mail with the topic-specific read cursor", async () => {
    const tested = await service.testSpaceSettings(request, "usr_owner", smtpDraft);
    await service.saveSpaceSettings(request, "usr_owner", { ...smtpDraft, testProof: tested.testProof });
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "EMAIL-TOPIC" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "email-topic",
      email: "email-topic@example.test"
    });
    await service.syncGitHubEmail(member.id, "email-topic@example.test");
    await service.updatePreferences(member.id, { immediateEnabled: true, digestEnabled: true });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "邮件话题群",
      memberIds: [member.id]
    });
    const topic = await createTopic(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      title: "邮件通知",
      description: "验证话题独立未读游标",
      idempotencyKey: "email-topic-create"
    });
    await joinTopic(db, request, { actorId: member.id, topicId: topic.id });
    await createTopicMessage(db, request, {
      actorId: "usr_owner",
      topicId: topic.id,
      clientMessageId: "email-topic-message",
      body: "话题邮件正文不得进入通知",
      scheduleEmailNotifications: service.scheduleMessage
    });

    const baseline = deliveries.length;
    current = new Date(Date.now() + 2 * 60 * 60 * 1000 + 61_000);
    const worker = service.startWorker({ startupDelayMs: 60_000, intervalMs: 60_000 });
    await worker.tick();
    worker.stop();

    expect(deliveries.length).toBeGreaterThanOrEqual(baseline + 2);
    expect(db.prepare("SELECT status FROM workspace_email_jobs").get().status).toBe("sent");
    expect(deliveries.at(-1).message.text).not.toContain("话题邮件正文不得进入通知");
  });

  it("retries failed delivery after 1, 5 and 30 minutes before marking the job failed", async () => {
    const tested = await service.testSpaceSettings(request, "usr_owner", smtpDraft);
    await service.saveSpaceSettings(request, "usr_owner", { ...smtpDraft, testProof: tested.testProof });
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "EMAIL-RETRY" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "email-retry",
      email: "retry@example.test"
    });
    await service.syncGitHubEmail(member.id, "retry@example.test");
    await service.updatePreferences(member.id, { immediateEnabled: true, digestEnabled: false });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "email-retry-message",
      content: textContent("retry body"),
      scheduleEmailNotifications: service.scheduleMessage
    });

    const failingService = createWorkspaceEmailService({
      db,
      env: {
        NODE_ENV: "test",
        WORKSPACE_SMTP_ENCRYPTION_KEY: encryptionKey,
        WORKSPACE_FRONTEND_URL: "https://duallane.example.test"
      },
      now: () => new Date(current),
      sendMail: async () => {
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      }
    });
    const worker = failingService.startWorker({ startupDelayMs: 60_000, intervalMs: 60_000 });
    current = new Date(Date.now() + 61_000);
    for (const advance of [0, 61_000, 5 * 60 * 1000 + 1, 30 * 60 * 1000 + 1]) {
      current = new Date(current.getTime() + advance);
      await worker.tick();
    }
    expect(db.prepare(`
      SELECT status, attempt_count AS attemptCount, last_error_code AS lastErrorCode
      FROM workspace_email_jobs
    `).get()).toEqual({ status: "failed", attemptCount: 4, lastErrorCode: "email.smtp_timeout" });
    worker.stop();
  });
});
