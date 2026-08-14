import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SPACE_ID, SEEDED_OWNER_EMAIL, SEEDED_OWNER_GITHUB_LOGIN } from "./db.mjs";
import { openTestDatabase } from "./test-database.mjs";
import { DAILY_QUOTA_BYTES } from "./quota.mjs";
import { BEACON_IDENTITY, BEACON_USER_ID, ECHO_IDENTITY } from "./system-identities.mjs";
import {
  acceptInvite,
  addConversationMember,
  addMessageReaction,
  bindGitHubUser,
  completeUpload,
  createConversation as createWorkspaceConversation,
  createInvite,
  createStructuredMessage,
  createSystemBotMessageWriter,
  createSystemBotStructuredMessage,
  createWorkspaceSession,
  failUpload,
  getConversationDetails,
  getManagedMemberVisibility,
  getProfileAvatar,
  getSessionUserId,
  getWorkspaceBootstrap,
  getWorkspaceStatistics,
  hideMessage,
  leaveConversation,
  listConversations,
  listFiles,
  listMessages,
  listPinnedMessages,
  listMembers,
  listWorkspaceEvents,
  markConversationRead,
  normalizeGroupAvatarEmoji,
  pinGroupMessage,
  recallMessage,
  MESSAGE_CONTENT_FORMAT,
  removeConversationMember,
  removeAttachment,
  removeMessageReaction,
  removeSpaceMember,
  removeOwnAvatar,
  reserveDownload,
  reserveUpload,
  releaseStaleUploadReservations,
  revokeInvite,
  STALE_UPLOAD_RESERVATION_MS,
  subscribeWorkspaceEvents,
  setOwnAvatar,
  updateMemberRole,
  updateMemberRemark,
  updateOwnProfile,
  updateConversationNotificationLevel,
  updateGroupConversation,
  updateManagedMemberVisibility,
  unpinGroupMessage,
  unhideMessage,
  WorkspaceAuthError,
  WorkspacePermissionError,
  WorkspaceValidationError
} from "./workspace.mjs";

const request = {
  id: "test-request",
  ip: "127.0.0.1",
  headers: {
    "user-agent": "vitest"
  }
};

function textContent(text) {
  return {
    format: MESSAGE_CONTENT_FORMAT,
    plainText: text,
    blocks: [{ type: "text", text }]
  };
}

async function ensureFixtureGroupMember(db) {
  const existing = db.prepare("SELECT id FROM users WHERE github_login = ?").get("group-fixture-member");
  if (existing?.id) {
    return { id: existing.id };
  }
  const invite = await createInvite(db, request, {
    actorId: "usr_owner",
    code: "GROUP-FIXTURE-MEMBER"
  });
  return await acceptInvite(db, request, {
    code: invite.code,
    githubLogin: "group-fixture-member",
    email: "group-fixture-member@example.com",
    displayName: "Group Fixture Member"
  });
}

async function createConversation(db, request, input) {
  if (input?.type !== "group" || Object.hasOwn(input, "memberIds")) {
    return await createWorkspaceConversation(db, request, input);
  }
  return await createWorkspaceConversation(db, request, {
    ...input,
    memberIds: [(await ensureFixtureGroupMember(db)).id]
  });
}

describe("workspace service", () => {
  let dataDir;
  let db;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-test-"));
    db = openTestDatabase(dataDir);
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("seeds and repairs the managed Beacon identity without allowing authentication", async () => {
    const beacon = (await listMembers(db, "usr_owner")).find((member) => member.id === BEACON_USER_ID);
    expect(beacon).toMatchObject({
      id: BEACON_USER_ID,
      displayName: "信标",
      description: "文件传输助手",
      avatarUrl: "/assets/beacon-avatar.png",
      kind: "bot",
      role: "member",
      capabilities: {
        canStartDirectConversation: true,
        canJoinGroups: false,
        canManage: false
      }
    });
    expect(beacon.githubLogin).toBeUndefined();

    db.prepare(`
      UPDATE users
      SET display_name = 'Modified', avatar_url = NULL, kind = 'system', last_login_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), BEACON_USER_ID);
    db.prepare(`
      UPDATE space_members
      SET role = 'admin', removed_at = ?
      WHERE space_id = ? AND user_id = ?
    `).run(new Date().toISOString(), DEFAULT_SPACE_ID, BEACON_USER_ID);
    db.close();
    db = openTestDatabase(dataDir);

    expect(db.prepare(`
      SELECT display_name AS displayName, avatar_url AS avatarUrl, kind, last_login_at AS lastLoginAt
      FROM users WHERE id = ?
    `).get(BEACON_USER_ID)).toEqual({
      displayName: BEACON_IDENTITY.displayName,
      avatarUrl: BEACON_IDENTITY.avatarUrl,
      kind: BEACON_IDENTITY.kind,
      lastLoginAt: null
    });
    expect(db.prepare(`
      SELECT role, removed_at AS removedAt
      FROM space_members WHERE space_id = ? AND user_id = ?
    `).get(DEFAULT_SPACE_ID, BEACON_USER_ID)).toEqual({ role: "member", removedAt: null });

    await expect(createWorkspaceSession(db, BEACON_USER_ID)).rejects.toMatchObject({ code: "auth.identity_forbidden" });
    await expect(listMembers(db, BEACON_USER_ID)).rejects.toMatchObject({ code: "auth.identity_forbidden" });
  });

  it("keeps public nicknames stable across OAuth updates and isolates private remarks", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "PROFILE-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "profile-member",
      email: "profile-member@example.com",
      displayName: "Provider Name"
    });

    const updated = await updateOwnProfile(db, request, { actorId: member.id, nickname: "公开昵称" });
    expect(updated).toMatchObject({ displayName: "公开昵称", nickname: "公开昵称", githubLogin: "profile-member" });

    const recallProfile = await updateOwnProfile(db, request, { actorId: member.id, recallReason: "重新组织内容" });
    expect(recallProfile.recallReason).toBe("重新组织内容");
    expect((await listMembers(db, "usr_owner")).find((item) => item.id === member.id).recallReason).toBeUndefined();

    const discoverable = await updateOwnProfile(db, request, { actorId: member.id, searchDiscoverable: true });
    expect(discoverable).toMatchObject({ nickname: "公开昵称", searchDiscoverable: true });
    expect((await listMembers(db, "usr_owner", { query: "profile" })).find((item) => item.id === member.id)).toBeTruthy();
    expect((await listMembers(db, "usr_owner", { query: "p" })).find((item) => item.id === member.id)).toBeTruthy();

    const hiddenViewerInvite = await createInvite(db, request, { actorId: "usr_owner", code: "PROFILE-HIDDEN-VIEWER" });
    const hiddenViewer = await acceptInvite(db, request, {
      code: hiddenViewerInvite.code,
      githubLogin: "profile-hidden-viewer",
      displayName: "Hidden Viewer"
    });
    expect((await listMembers(db, hiddenViewer.id, { query: "p" })).map((item) => item.id)).not.toContain(member.id);
    const discoveredMember = (await listMembers(db, hiddenViewer.id, { query: "profile" }))
      .find((item) => item.id === member.id);
    expect(discoveredMember).toBeTruthy();
    expect(discoveredMember.capabilities).toMatchObject({
      canStartDirectConversation: true,
      canJoinGroups: false
    });
    const discoveredDirect = await createWorkspaceConversation(db, request, {
      actorId: hiddenViewer.id,
      type: "direct",
      targetUserId: member.id
    });
    expect(discoveredDirect.type).toBe("direct");

    const avatar = await setOwnAvatar(db, request, {
      actorId: member.id,
      storageKey: `profile-avatars/${member.id}/custom.webp`,
      version: "custom"
    });
    expect(avatar.user.avatarUrl).toBe(`/api/workspace/avatars/${member.id}/custom`);
    expect((await getProfileAvatar(db, hiddenViewer.id, member.id, "custom")).storageKey)
      .toBe(`profile-avatars/${member.id}/custom.webp`);
    const avatarOutsiderInvite = await createInvite(db, request, { actorId: "usr_owner", code: "PROFILE-AVATAR-OUTSIDER" });
    const avatarOutsider = await acceptInvite(db, request, {
      code: avatarOutsiderInvite.code,
      githubLogin: "profile-avatar-outsider",
      displayName: "Avatar Outsider"
    });
    await updateOwnProfile(db, request, { actorId: member.id, searchDiscoverable: false });
    await expect(getProfileAvatar(db, avatarOutsider.id, member.id, "custom"))
      .rejects.toMatchObject({ code: "avatar.not_found" });
    await updateOwnProfile(db, request, { actorId: member.id, searchDiscoverable: true });
    expect((await getProfileAvatar(db, avatarOutsider.id, member.id, "custom")).storageKey)
      .toBe(`profile-avatars/${member.id}/custom.webp`);
    await bindGitHubUser(db, request, {
      githubLogin: "profile-member",
      avatarUrl: "https://avatars.githubusercontent.com/u/9001?v=4"
    });
    expect((await getWorkspaceBootstrap(db, member.id)).auth.currentUser.avatarUrl)
      .toBe(`/api/workspace/avatars/${member.id}/custom`);
    const restored = await removeOwnAvatar(db, request, { actorId: member.id });
    expect(restored.user.avatarUrl).toBe("https://avatars.githubusercontent.com/u/9001?v=4");

    await bindGitHubUser(db, request, {
      githubLogin: "profile-member",
      email: "profile-member@example.com",
      displayName: "Changed Provider Name"
    });
    expect((await getWorkspaceBootstrap(db, member.id)).auth.currentUser).toMatchObject({
      displayName: "公开昵称",
      nickname: "公开昵称"
    });

    const remarked = await updateMemberRemark(db, {
      actorId: "usr_owner",
      userId: member.id,
      remark: "我的备注"
    });
    expect(remarked).toMatchObject({ displayName: "我的备注", remark: "我的备注", nickname: "公开昵称" });
    expect((await listMembers(db, member.id)).find((item) => item.id === member.id)).toMatchObject({
      displayName: "公开昵称",
      nickname: "公开昵称"
    });
    expect((await listMembers(db, member.id)).find((item) => item.id === member.id).remark).toBeUndefined();

    const conversation = await createWorkspaceConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "profile-private-remark-event",
      content: textContent("事件投影不应保存私人备注")
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM workspace_events
      WHERE payload_json LIKE ?
    `).get("%我的备注%").count).toBe(0);

    await updateOwnProfile(db, request, { actorId: member.id, nickname: null });
    await bindGitHubUser(db, request, {
      githubLogin: "profile-member",
      email: "profile-member@example.com",
      displayName: "Another Provider Name"
    });
    expect((await getWorkspaceBootstrap(db, member.id)).auth.currentUser).toMatchObject({
      displayName: "profile-member",
      nickname: null
    });
    await expect(updateMemberRemark(db, {
      actorId: "usr_owner",
      userId: BEACON_USER_ID,
      remark: "不允许"
    })).rejects.toMatchObject({ code: "member.remark_unsupported" });
  });

  it("keeps Beacon visible without grants and isolates one direct conversation per user", async () => {
    const firstInvite = await createInvite(db, request, { actorId: "usr_owner", code: "BEACON-FIRST" });
    const first = await acceptInvite(db, request, {
      code: firstInvite.code,
      githubLogin: "beacon-first",
      email: "beacon-first@example.com"
    });
    const secondInvite = await createInvite(db, request, { actorId: "usr_owner", code: "BEACON-SECOND" });
    const second = await acceptInvite(db, request, {
      code: secondInvite.code,
      githubLogin: "beacon-second",
      email: "beacon-second@example.com"
    });

    for (const member of [first, second]) {
      expect((await listMembers(db, member.id)).find((item) => item.id === BEACON_USER_ID)).toMatchObject({
        kind: "bot",
        description: "文件传输助手"
      });
    }

    const visibility = await updateManagedMemberVisibility(db, request, {
      actorId: "usr_owner",
      userId: first.id,
      visibleUserIds: [BEACON_USER_ID]
    });
    expect(visibility.automaticUserIds).toContain(BEACON_USER_ID);
    expect(visibility.grantedUserIds).not.toContain(BEACON_USER_ID);
    expect(db.prepare(`
      SELECT 1 FROM member_visibility_grants
      WHERE space_id = ? AND viewer_user_id = ? AND visible_user_id = ?
    `).get(DEFAULT_SPACE_ID, first.id, BEACON_USER_ID)).toBeUndefined();

    const firstConversation = await createConversation(db, request, {
      actorId: first.id,
      type: "direct",
      targetUserId: BEACON_USER_ID
    });
    const reused = await createConversation(db, request, {
      actorId: first.id,
      type: "direct",
      targetUserId: BEACON_USER_ID
    });
    const secondConversation = await createConversation(db, request, {
      actorId: second.id,
      type: "direct",
      targetUserId: BEACON_USER_ID
    });

    expect(reused.id).toBe(firstConversation.id);
    expect(secondConversation.id).not.toBe(firstConversation.id);
    expect(firstConversation).toMatchObject({
      displayTitle: "信标",
      otherMember: { id: BEACON_USER_ID, kind: "bot", description: "文件传输助手" }
    });
  });

  it("uses conversation policy, not bot kind, to reject Beacon from groups", async () => {
    const member = await ensureFixtureGroupMember(db);
    await expect(createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Invalid Beacon group",
      memberIds: [BEACON_USER_ID]
    })).rejects.toMatchObject({ code: "member.not_chat_participant" });

    const group = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Regular group",
      memberIds: [member.id]
    });
    await expect(addConversationMember(db, request, {
      actorId: "usr_owner",
      conversationId: group.id,
      userId: BEACON_USER_ID
    })).rejects.toMatchObject({ code: "member.not_chat_participant" });
    expect(db.prepare(`
      SELECT 1 FROM conversation_members
      WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
    `).get(group.id, BEACON_USER_ID)).toBeUndefined();
  });

  it("only allows official system Bot messages through the server-only writer boundary", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: ECHO_IDENTITY.id
    });

    await expect(createSystemBotStructuredMessage(db, request, {
      actorId: ECHO_IDENTITY.id,
      conversationId: conversation.id,
      clientMessageId: "echo-raw-request",
      content: textContent("raw request must be rejected")
    })).rejects.toMatchObject({ code: "permission.denied" });

    const writeEchoMessage = createSystemBotMessageWriter(db, ECHO_IDENTITY.id);
    const message = await writeEchoMessage({
      request,
      conversationId: conversation.id,
      clientMessageId: "echo-server-message",
      content: textContent("official Echo message")
    });
    expect(message).toMatchObject({
      authorId: ECHO_IDENTITY.id,
      authorKind: "bot",
      content: { blocks: [{ type: "text", text: "official Echo message" }] }
    });
    expect(db.prepare(`
      SELECT author_id AS authorId, author_kind AS authorKind, kind
      FROM messages WHERE id = ?
    `).get(message.id)).toEqual({
      authorId: ECHO_IDENTITY.id,
      authorKind: "bot",
      kind: "bot"
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_events
      WHERE type = 'message.created' AND target_id = ?
    `).get(message.id).count).toBe(1);

    expect(() => createSystemBotMessageWriter(db, "usr_custom_bot")).toThrowError(
      expect.objectContaining({ code: "auth.identity_forbidden" })
    );
  });

  it("prevents owners and other members from reading Beacon messages or known attachment ids", async () => {
    const firstInvite = await createInvite(db, request, { actorId: "usr_owner", code: "BEACON-PRIVATE-FIRST" });
    const first = await acceptInvite(db, request, {
      code: firstInvite.code,
      githubLogin: "beacon-private-first",
      email: "beacon-private-first@example.com"
    });
    const secondInvite = await createInvite(db, request, { actorId: "usr_owner", code: "BEACON-PRIVATE-SECOND" });
    const second = await acceptInvite(db, request, {
      code: secondInvite.code,
      githubLogin: "beacon-private-second",
      email: "beacon-private-second@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: first.id,
      type: "direct",
      targetUserId: BEACON_USER_ID
    });
    const secretText = "private Beacon content";
    await createStructuredMessage(db, request, {
      actorId: first.id,
      conversationId: conversation.id,
      clientMessageId: "beacon-private-text",
      content: textContent(secretText)
    });
    const upload = await reserveUpload(db, request, {
      actorId: first.id,
      conversationId: conversation.id,
      visibility: "conversation",
      fileName: "private-beacon.txt",
      mimeType: "text/plain",
      byteSize: 32
    });
    await completeUpload(db, request, {
      actorId: first.id,
      uploadId: upload.id,
      storageVerifiedByteSize: 32
    });
    await createStructuredMessage(db, request, {
      actorId: first.id,
      conversationId: conversation.id,
      clientMessageId: "beacon-private-file",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        plainText: "[文件]",
        blocks: [{ type: "attachment", attachmentId: upload.attachment.id }]
      }
    });

    for (const actorId of ["usr_owner", second.id]) {
      await expect(listMessages(db, actorId, conversation.id)).rejects.toThrow(WorkspacePermissionError);
      await expect(reserveDownload(db, request, {
        actorId,
        attachmentId: upload.attachment.id
      })).rejects.toThrow(WorkspacePermissionError);
      await expect(removeAttachment(db, request, {
        actorId,
        attachmentId: upload.attachment.id
      })).rejects.toThrow(WorkspacePermissionError);
    }
    expect((await listFiles(db, "usr_owner")).map((file) => file.id)).not.toContain(upload.attachment.id);
    expect((await listFiles(db, first.id)).map((file) => file.id)).toContain(upload.attachment.id);

    const ownerGroup = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Owner files"
    });
    await expect(createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: ownerGroup.id,
      clientMessageId: "beacon-private-reference",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        plainText: "[文件]",
        blocks: [{ type: "attachment", attachmentId: upload.attachment.id }]
      }
    })).rejects.toThrow(WorkspacePermissionError);

    const auditRows = db.prepare(`
      SELECT action, target_type AS targetType, target_id AS targetId, result, reason
      FROM audit_logs WHERE actor_user_id = ?
    `).all(first.id);
    expect(JSON.stringify(auditRows)).not.toContain(secretText);
    expect(JSON.stringify(auditRows)).not.toContain("private-beacon.txt");
  });

  it("rejects OAuth binding, invite binding, role changes, and removal for Beacon", async () => {
    await expect(bindGitHubUser(db, request, {
      githubId: "beacon-oauth-id",
      githubLogin: BEACON_IDENTITY.githubLogin,
      email: "beacon-oauth@example.com"
    })).rejects.toMatchObject({ code: "auth.identity_forbidden" });

    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "BEACON-LOGIN" });
    await expect(acceptInvite(db, request, {
      code: invite.code,
      githubId: "beacon-invite-id",
      githubLogin: BEACON_IDENTITY.githubLogin,
      email: "beacon-invite@example.com"
    })).rejects.toMatchObject({ code: "auth.identity_forbidden" });
    expect(db.prepare("SELECT uses FROM invites WHERE id = ?").get(invite.id).uses).toBe(0);

    await expect(updateMemberRole(db, request, {
      actorId: "usr_owner",
      userId: BEACON_USER_ID,
      role: "admin"
    })).rejects.toMatchObject({ code: "member.system_managed" });
    await expect(removeSpaceMember(db, request, {
      actorId: "usr_owner",
      userId: BEACON_USER_ID
    })).rejects.toMatchObject({ code: "member.system_managed" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE target_id = ? AND result = 'rejected' AND reason = 'member.system_managed'
    `).get(BEACON_USER_ID).count).toBe(2);
  });

  it("returns owner-only cumulative and today workspace statistics", async () => {
    const now = new Date("2026-08-04T12:00:00.000Z");
    const dayStartedAt = new Date(now);
    dayStartedAt.setHours(0, 0, 0, 0);
    const older = new Date(dayStartedAt.getTime() - 1000).toISOString();
    const today = new Date(dayStartedAt.getTime() + 1000).toISOString();
    const before = await getWorkspaceStatistics(db, request, { actorId: "usr_owner", now });

    for (const [id, login, joinedAt] of [
      ["usr_stats_older", "stats-older", older],
      ["usr_stats_today", "stats-today", today]
    ]) {
      db.prepare("INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at) VALUES (?, NULL, ?, NULL, ?, NULL, 'human', ?, NULL)")
        .run(id, login, login, joinedAt);
      db.prepare("INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at) VALUES (?, ?, 'member', ?, NULL)")
        .run(DEFAULT_SPACE_ID, id, joinedAt);
    }

    for (const [id, createdAt] of [
      ["conv_stats_older", older],
      ["conv_stats_today", today]
    ]) {
      db.prepare("INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at) VALUES (?, ?, 'group', ?, NULL, 10000, 'usr_owner', ?)")
        .run(id, DEFAULT_SPACE_ID, id, createdAt);
      db.prepare("INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, client_message_id, content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at) VALUES (?, ?, ?, 'usr_owner', 'human', 'user', NULL, ?, '{}', ?, NULL, ?, NULL, NULL)")
        .run("msg_" + id, DEFAULT_SPACE_ID, id, MESSAGE_CONTENT_FORMAT, id, createdAt);
    }

    for (const [id, byteSize, completedAt] of [
      ["att_stats_older", 110, older],
      ["att_stats_today", 40, today]
    ]) {
      db.prepare("INSERT INTO attachments (id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type, byte_size, storage_key, upload_transfer_id, created_at, completed_at) VALUES (?, ?, 'usr_owner', NULL, 'space', 'available', ?, 'text/plain', ?, ?, NULL, ?, ?)")
        .run(id, DEFAULT_SPACE_ID, id + ".txt", byteSize, id + ".txt", completedAt, completedAt);
    }

    db.prepare("UPDATE space_members SET removed_at = ? WHERE user_id = 'usr_stats_older'").run(today);
    db.prepare("UPDATE messages SET deleted_at = ? WHERE id = 'msg_conv_stats_older'").run(today);
    db.prepare("UPDATE attachments SET status = 'removed' WHERE id = 'att_stats_older'").run();

    const after = await getWorkspaceStatistics(db, request, { actorId: "usr_owner", now });
    expect(after.dayStartedAt).toBe(dayStartedAt.toISOString());
    expect(after.totals).toEqual({
      members: before.totals.members + 2,
      conversations: before.totals.conversations + 2,
      messages: before.totals.messages + 2,
      files: before.totals.files + 2,
      uploadedBytes: before.totals.uploadedBytes + 150
    });
    expect(after.today).toEqual({
      members: before.today.members + 1,
      conversations: before.today.conversations + 1,
      messages: before.today.messages + 1,
      files: before.today.files + 1,
      uploadedBytes: before.today.uploadedBytes + 40
    });

    await expect(getWorkspaceStatistics(db, request, {
      actorId: "usr_stats_today",
      now
    })).rejects.toMatchObject({ code: "permission.denied" });
    db.prepare("UPDATE space_members SET role = 'admin' WHERE user_id = 'usr_stats_today'").run();
    await expect(getWorkspaceStatistics(db, request, {
      actorId: "usr_stats_today",
      now
    })).rejects.toMatchObject({ code: "permission.denied" });
    expect(db.prepare("SELECT result, reason FROM audit_logs WHERE actor_user_id = ? AND action = 'workspace.statistics.read' ORDER BY created_at DESC LIMIT 1")
      .get("usr_stats_today")).toEqual({
      result: "rejected",
      reason: "insufficient permission"
    });
  });
  it("seeds the first owner and default shared space", async () => {
    const owner = db.prepare(`
      SELECT u.github_login AS githubLogin, u.email, sm.role
      FROM users u
      INNER JOIN space_members sm ON sm.user_id = u.id
      WHERE u.id = 'usr_owner'
    `).get();
    expect(owner).toEqual({
      githubLogin: SEEDED_OWNER_GITHUB_LOGIN,
      email: SEEDED_OWNER_EMAIL,
      role: "owner"
    });

    const space = db.prepare("SELECT id, name FROM spaces WHERE id = ?").get(DEFAULT_SPACE_ID);
    expect(space.name).toBe("默认空间");
    const currentSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS currentSeq FROM workspace_events").get().currentSeq;
    expect((await getWorkspaceBootstrap(db)).eventCursor).toBe(currentSeq);
  });

  it("binds the seeded owner to a GitHub identity", async () => {
    const owner = await bindGitHubUser(db, request, {
      githubId: "12345",
      githubLogin: SEEDED_OWNER_GITHUB_LOGIN,
      email: SEEDED_OWNER_EMAIL,
      displayName: "timeStarry"
    });

    expect(owner.id).toBe("usr_owner");
    const row = db.prepare("SELECT github_id AS githubId, last_login_at AS lastLoginAt FROM users WHERE id = 'usr_owner'").get();
    expect(row.githubId).toBe("12345");
    expect(row.lastLoginAt).toBeTruthy();
  });

  it("keeps a bound GitHub id stable while allowing profile renames", async () => {
    await bindGitHubUser(db, request, {
      githubId: "stable-owner-id",
      githubLogin: SEEDED_OWNER_GITHUB_LOGIN,
      email: SEEDED_OWNER_EMAIL,
      displayName: "Original Owner"
    });

    const renamed = await bindGitHubUser(db, request, {
      githubId: "stable-owner-id",
      githubLogin: "renamed-owner",
      email: "renamed-owner@example.com",
      displayName: "Renamed Owner"
    });
    expect(renamed).toMatchObject({
      id: "usr_owner",
      githubId: "stable-owner-id",
      githubLogin: "renamed-owner",
      email: "renamed-owner@example.com"
    });

    await expect(async () =>
      await bindGitHubUser(db, request, {
        githubId: "different-owner-id",
        githubLogin: "renamed-owner",
        email: "different-owner@example.com",
        displayName: "Different Account"
      })
    ).rejects.toThrow("GitHub 身份与已有账号不一致");

    await expect(async () =>
      await bindGitHubUser(db, request, {
        githubId: "recycled-seeded-login-id",
        githubLogin: SEEDED_OWNER_GITHUB_LOGIN,
        email: "recycled-owner@example.com",
        displayName: "Recycled Login"
      })
    ).rejects.toThrow("GitHub 身份与已有账号不一致");

    const stored = db.prepare(`
      SELECT github_id AS githubId, github_login AS githubLogin, email
      FROM users
      WHERE id = 'usr_owner'
    `).get();
    expect(stored).toEqual({
      githubId: "stable-owner-id",
      githubLogin: "renamed-owner",
      email: "renamed-owner@example.com"
    });
    const rejection = db.prepare(`
      SELECT result, reason, COUNT(*) AS count
      FROM audit_logs
      WHERE action = 'login.rejected'
    `).get();
    expect(rejection).toEqual({ result: "rejected", reason: "auth.identity_conflict", count: 2 });
  });

  it("does not consume an invite when its GitHub identity conflicts", async () => {
    const firstInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "IDENTITY-FIRST"
    });
    await acceptInvite(db, request, {
      code: firstInvite.code,
      githubId: "stable-member-id",
      githubLogin: "stable-member",
      email: "stable-member@example.com"
    });
    const secondInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "IDENTITY-SECOND"
    });

    await expect(async () =>
      await acceptInvite(db, request, {
        code: secondInvite.code,
        githubId: "different-member-id",
        githubLogin: "stable-member",
        email: "different-member@example.com"
      })
    ).rejects.toThrow("GitHub 身份与已有账号不一致");

    expect(db.prepare("SELECT uses FROM invites WHERE id = ?").get(secondInvite.id).uses).toBe(0);
    const rejection = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'invite.accept' AND target_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(secondInvite.id);
    expect(rejection).toEqual({ result: "rejected", reason: "auth.identity_conflict" });
  });

  it("rolls back GitHub login binding when audit persistence fails", async () => {
    db.exec(`
      CREATE TRIGGER fail_login_success_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'login.success' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'login success audit failed');
      END
    `);
    try {
      await expect(async () =>
        await bindGitHubUser(db, request, {
          githubId: "rollback-login",
          githubLogin: SEEDED_OWNER_GITHUB_LOGIN,
          email: SEEDED_OWNER_EMAIL,
          displayName: "timeStarry"
        })
      ).rejects.toThrow(/login success audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_login_success_audit");
    }

    const row = db.prepare("SELECT github_id AS githubId, last_login_at AS lastLoginAt FROM users WHERE id = 'usr_owner'").get();
    expect(row.githubId).toBeNull();
    expect(row.lastLoginAt).toBeNull();
  });

  it("rejects uninvited GitHub users and writes an operation record", async () => {
    await expect(async () =>
      await bindGitHubUser(db, request, {
        githubId: "999",
        githubLogin: "outsider",
        email: "outsider@example.com"
      })
    ).rejects.toThrow("该 GitHub 用户尚未被邀请");

    const audit = db.prepare("SELECT result, reason FROM audit_logs WHERE action = 'login.rejected'").get();
    expect(audit).toEqual({ result: "rejected", reason: "not invited" });
  });

  it("allows owner/admin invite creation but rejects members", async () => {
    const ownerInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      maxUses: 2,
      code: "OWNER-ADMIN"
    });
    expect(ownerInvite.defaultRole).toBe("admin");

    const admin = await acceptInvite(db, request, {
      code: "OWNER-ADMIN",
      githubLogin: "space-admin",
      email: "admin@example.com",
      displayName: "Space Admin"
    });

    const memberInvite = await createInvite(db, request, {
      actorId: admin.id,
      defaultRole: "member",
      code: "ADMIN-MEMBER"
    });
    expect(memberInvite.defaultRole).toBe("member");

    const member = await acceptInvite(db, request, {
      code: "ADMIN-MEMBER",
      githubId: "member-gh-id",
      githubLogin: "space-member",
      email: "member@example.com",
      displayName: "Space Member"
    });
    const memberRow = db.prepare("SELECT github_id AS githubId FROM users WHERE id = ?").get(member.id);
    expect(memberRow.githubId).toBe("member-gh-id");
    expect(member.githubId).toBe("member-gh-id");

    await expect(async () =>
      await createInvite(db, request, {
        actorId: member.id,
        defaultRole: "member",
        code: "MEMBER-INVITE"
      })
    ).rejects.toThrow(WorkspacePermissionError);
  });

  it("derives invite expiry from hour-based product input", async () => {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "member",
      code: "EXPIRY-HOURS",
      expiresInHours: 2
    });

    expect(invite.expiresAt).toBeTruthy();
    const createdAt = Date.parse(invite.createdAt);
    const expiresAt = Date.parse(invite.expiresAt);
    expect(expiresAt - createdAt).toBe(2 * 60 * 60 * 1000);

    const row = db.prepare("SELECT expires_at AS expiresAt FROM invites WHERE id = ?").get(invite.id);
    expect(row.expiresAt).toBe(invite.expiresAt);
  });

  it("projects role permissions without exposing operation-record access", async () => {
    const adminInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      code: "ROLE-MATRIX-ADMIN"
    });
    const admin = await acceptInvite(db, request, {
      code: adminInvite.code,
      githubLogin: "role-matrix-admin",
      email: "role-matrix-admin@example.com"
    });
    const memberInvite = await createInvite(db, request, {
      actorId: admin.id,
      defaultRole: "member",
      code: "ROLE-MATRIX-MEMBER"
    });
    const member = await acceptInvite(db, request, {
      code: memberInvite.code,
      githubLogin: "role-matrix-member",
      email: "role-matrix-member@example.com"
    });
    const auditorInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "auditor",
      code: "ROLE-MATRIX-AUDITOR"
    });
    const auditor = await acceptInvite(db, request, {
      code: auditorInvite.code,
      githubLogin: "role-matrix-auditor",
      email: "role-matrix-auditor@example.com"
    });

    const ownerPermissions = (await getWorkspaceBootstrap(db, "usr_owner")).permissions;
    const adminPermissions = (await getWorkspaceBootstrap(db, admin.id)).permissions;
    const memberPermissions = (await getWorkspaceBootstrap(db, member.id)).permissions;
    const auditorPermissions = (await getWorkspaceBootstrap(db, auditor.id)).permissions;

    expect(ownerPermissions).toMatchObject({
      canCreateMemberInvite: true,
      canCreatePrivilegedInvite: true,
      canReadConversations: true,
      canCreateGroup: true,
      canCreateDirect: true,
      canUpload: true,
      canDownload: true,
      canViewOperationRecords: false
    });
    expect(adminPermissions).toMatchObject({
      canCreateMemberInvite: true,
      canCreatePrivilegedInvite: false,
      canReadConversations: true,
      canCreateGroup: true,
      canCreateDirect: true,
      canUpload: true,
      canDownload: true,
      canViewOperationRecords: false
    });
    expect(memberPermissions).toMatchObject({
      canCreateMemberInvite: false,
      canCreatePrivilegedInvite: false,
      canReadConversations: true,
      canCreateGroup: false,
      canCreateDirect: true,
      canUpload: true,
      canDownload: true,
      canViewOperationRecords: false
    });
    expect(auditorPermissions).toMatchObject({
      canCreateMemberInvite: false,
      canCreatePrivilegedInvite: false,
      canReadConversations: false,
      canCreateGroup: false,
      canCreateDirect: false,
      canUpload: false,
      canDownload: false,
      canViewOperationRecords: false
    });
    expect((await getWorkspaceBootstrap(db, member.id)).invites).toEqual([]);
    expect((await getWorkspaceBootstrap(db, auditor.id)).invites).toEqual([]);
  });

  it("limits non-owner member discovery to direct contacts and owner grants", async () => {
    const adminInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      code: "VISIBILITY-ADMIN"
    });
    const admin = await acceptInvite(db, request, {
      code: adminInvite.code,
      githubLogin: "visibility-admin",
      email: "visibility-admin@example.com",
      displayName: "Visibility Admin"
    });
    const memberInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "VISIBILITY-MEMBER"
    });
    const member = await acceptInvite(db, request, {
      code: memberInvite.code,
      githubLogin: "visibility-member",
      email: "visibility-member@example.com",
      displayName: "Visibility Member"
    });
    const unrelatedInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "VISIBILITY-UNRELATED"
    });
    const unrelated = await acceptInvite(db, request, {
      code: unrelatedInvite.code,
      githubLogin: "visibility-unrelated",
      email: "visibility-unrelated@example.com",
      displayName: "Visibility Unrelated"
    });

    expect((await listMembers(db, admin.id)).map((item) => item.id)).toEqual([admin.id, BEACON_USER_ID, ECHO_IDENTITY.id]);
    expect((await listMembers(db, member.id)).map((item) => item.id)).toEqual([member.id, BEACON_USER_ID, ECHO_IDENTITY.id]);

    await expect(async () =>
      await createConversation(db, request, {
        actorId: member.id,
        type: "direct",
        targetUserId: "usr_owner"
      })
    ).rejects.toThrow("成员不存在或当前不可见");

    await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: admin.id
    });

    const memberContacts = await listMembers(db, member.id);
    expect(memberContacts.map((item) => item.id)).toEqual(expect.arrayContaining([member.id, "usr_owner"]));
    expect(memberContacts.map((item) => item.id)).not.toContain(unrelated.id);
    expect(memberContacts.find((item) => item.id === "usr_owner")).toMatchObject({
      role: "admin",
      roleLabel: "管理员"
    });
    expect((await listMembers(db, admin.id)).find((item) => item.id === "usr_owner")).toMatchObject({
      role: "admin",
      roleLabel: "管理员"
    });

    const ownerMembers = await listMembers(db, "usr_owner");
    expect(ownerMembers.find((item) => item.id === "usr_owner")).toMatchObject({
      role: "owner",
      roleLabel: "空间主人"
    });
    expect(ownerMembers.map((item) => item.id)).toEqual(
      expect.arrayContaining(["usr_owner", admin.id, member.id, unrelated.id])
    );

    const granted = await updateManagedMemberVisibility(db, request, {
      actorId: "usr_owner",
      userId: member.id,
      visibleUserIds: [unrelated.id]
    });
    expect(granted).toMatchObject({
      basis: "direct_contacts",
      viewerUserId: member.id,
      grantedUserIds: [unrelated.id]
    });
    expect((await listMembers(db, member.id)).map((item) => item.id)).toContain(unrelated.id);
    expect(await getManagedMemberVisibility(db, request, {
      actorId: "usr_owner",
      userId: member.id
    })).toMatchObject({
      automaticUserIds: ["usr_owner", BEACON_USER_ID, ECHO_IDENTITY.id],
      grantedUserIds: [unrelated.id]
    });

    await updateManagedMemberVisibility(db, request, {
      actorId: "usr_owner",
      userId: member.id,
      visibleUserIds: []
    });
    expect((await listMembers(db, member.id)).map((item) => item.id)).not.toContain(unrelated.id);

    await expect(async () =>
      await getManagedMemberVisibility(db, request, {
        actorId: member.id,
        userId: admin.id
      })
    ).rejects.toThrow(WorkspacePermissionError);
  });

  it("limits bootstrap invite projections to invites each role can manage", async () => {
    const adminInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      code: "VISIBLE-ADMIN"
    });
    const admin = await acceptInvite(db, request, {
      code: adminInvite.code,
      githubLogin: "visible-admin",
      email: "visible-admin@example.com"
    });
    const memberInvite = await createInvite(db, request, {
      actorId: admin.id,
      defaultRole: "member",
      code: "VISIBLE-MEMBER"
    });
    const member = await acceptInvite(db, request, {
      code: memberInvite.code,
      githubLogin: "invite-visible-member",
      email: "invite-visible-member@example.com",
      displayName: "Invite Visible Member"
    });
    const ownerInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "owner",
      code: "VISIBLE-OWNER"
    });

    const ownerBootstrap = await getWorkspaceBootstrap(db, "usr_owner");
    const adminBootstrap = await getWorkspaceBootstrap(db, admin.id);

    expect(ownerBootstrap.invites.map((invite) => invite.id)).toEqual(
      expect.arrayContaining([adminInvite.id, memberInvite.id, ownerInvite.id])
    );
    expect(adminBootstrap.invites.map((invite) => invite.id)).toEqual([memberInvite.id]);
    expect(adminBootstrap.invites[0]).toMatchObject({
      defaultRole: "member",
      codePreview: memberInvite.codePreview,
      acceptedMemberCount: 1,
      acceptedMembers: []
    });
    expect(adminBootstrap.inviteSummary).toEqual({
      total: 1,
      active: 0,
      history: 1,
      acceptedUses: 1,
      availableUses: 0
    });
    expect(ownerBootstrap.inviteSummary).toEqual({
      total: 3,
      active: 1,
      history: 2,
      acceptedUses: 2,
      availableUses: 1
    });
    expect(ownerBootstrap.invites.find((invite) => invite.id === memberInvite.id)).toMatchObject({
      acceptedMemberCount: 1,
      acceptedMembers: [expect.objectContaining({
        id: member.id,
        displayName: "Invite Visible Member"
      })]
    });
    expect(JSON.stringify(adminBootstrap.invites)).not.toContain("VISIBLE-MEMBER");
    expect(JSON.stringify(adminBootstrap.invites)).not.toContain("Invite Visible Member");
    expect(JSON.stringify(ownerBootstrap.invites)).not.toContain("invite-visible-member@example.com");
    expect(JSON.stringify(adminBootstrap.invites)).not.toContain(ownerInvite.id);
    expect(JSON.stringify(adminBootstrap.invites)).not.toContain(adminInvite.id);
  });

  it("records rejected invite creation when the requested default role is invalid", async () => {
    await expect(async () =>
      await createInvite(db, request, {
        actorId: "usr_owner",
        defaultRole: "operator",
        code: "INVALID-ROLE-INVITE"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const invite = db.prepare("SELECT 1 FROM invites WHERE code_preview = ?").get("INVA...");
    expect(invite).toBeUndefined();
    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'invite.create'
      ORDER BY rowid DESC
      LIMIT 1
    `).get();
    expect(audit).toEqual({ result: "rejected", reason: "role.invalid" });
  });

  it("rolls back invite creation when audit persistence fails", async () => {
    db.exec(`
      CREATE TRIGGER fail_invite_create_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'invite.create' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'invite create audit failed');
      END
    `);
    try {
      await expect(async () =>
        await createInvite(db, request, {
          actorId: "usr_owner",
          code: "CREATE-TXN"
        })
      ).rejects.toThrow(/invite create audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_invite_create_audit");
    }

    const invite = db.prepare("SELECT 1 FROM invites WHERE code_preview = ?").get("CREA...");
    expect(invite).toBeUndefined();
  });

  it("revokes invites through privileged members and rejects revoked invite acceptance", async () => {
    const adminInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      code: "REVOKE-ADMIN"
    });
    const admin = await acceptInvite(db, request, {
      code: adminInvite.code,
      githubLogin: "revoke-admin",
      email: "revoke-admin@example.com",
      displayName: "Revoke Admin"
    });

    const memberInvite = await createInvite(db, request, {
      actorId: admin.id,
      defaultRole: "member",
      code: "REVOKE-MEMBER"
    });
    const revoked = await revokeInvite(db, request, {
      actorId: admin.id,
      inviteId: memberInvite.id
    });
    expect(revoked.id).toBe(memberInvite.id);
    expect(revoked.revokedAt).toBeTruthy();

    await expect(async () =>
      await acceptInvite(db, request, {
        code: memberInvite.code,
        githubLogin: "revoked-member",
        email: "revoked-member@example.com"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const audit = db.prepare("SELECT result FROM audit_logs WHERE action = 'invite.revoke' AND target_id = ?").get(memberInvite.id);
    expect(audit.result).toBe("success");
  });

  it("rolls back invite revocation when audit persistence fails", async () => {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "REVOKE-TXN"
    });

    db.exec(`
      CREATE TRIGGER fail_invite_revoke_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'invite.revoke' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'invite revoke audit failed');
      END
    `);
    try {
      await expect(async () =>
        await revokeInvite(db, request, {
          actorId: "usr_owner",
          inviteId: invite.id
        })
      ).rejects.toThrow(/invite revoke audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_invite_revoke_audit");
    }

    const row = db.prepare("SELECT revoked_at AS revokedAt FROM invites WHERE id = ?").get(invite.id);
    expect(row.revokedAt).toBeNull();
  });

  it("records rejected invite revocation when the invite does not exist", async () => {
    await expect(async () =>
      await revokeInvite(db, request, {
        actorId: "usr_owner",
        inviteId: "missing-invite"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'invite.revoke' AND target_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get("usr_owner", "missing-invite");
    expect(audit).toEqual({ result: "rejected", reason: "invite not found" });
  });

  it("prevents admins from revoking privileged invites and writes an operation record", async () => {
    const adminInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      code: "REVOKE-PRIVILEGED-ADMIN"
    });
    const admin = await acceptInvite(db, request, {
      code: adminInvite.code,
      githubLogin: "revoke-privileged-admin",
      email: "revoke-privileged-admin@example.com"
    });
    const ownerInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "owner",
      code: "REVOKE-PRIVILEGED-OWNER"
    });

    await expect(async () =>
      await revokeInvite(db, request, {
        actorId: admin.id,
        inviteId: ownerInvite.id
      })
    ).rejects.toThrow(WorkspacePermissionError);

    const row = db.prepare("SELECT revoked_at AS revokedAt FROM invites WHERE id = ?").get(ownerInvite.id);
    expect(row.revokedAt).toBeNull();
    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'invite.revoke' AND target_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(admin.id, ownerInvite.id);
    expect(audit).toEqual({ result: "rejected", reason: "insufficient permission" });
  });

  it("rejects invite revocation by normal members and writes an operation record", async () => {
    const memberInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "REVOKE-NORMAL-MEMBER"
    });
    const member = await acceptInvite(db, request, {
      code: memberInvite.code,
      githubLogin: "revoke-normal-member",
      email: "revoke-normal-member@example.com"
    });
    const targetInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "REVOKE-TARGET"
    });

    await expect(async () =>
      await revokeInvite(db, request, {
        actorId: member.id,
        inviteId: targetInvite.id
      })
    ).rejects.toThrow(WorkspacePermissionError);

    const row = db.prepare("SELECT revoked_at AS revokedAt FROM invites WHERE id = ?").get(targetInvite.id);
    expect(row.revokedAt).toBeNull();
    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'invite.revoke'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(member.id);
    expect(audit).toEqual({ result: "rejected", reason: "insufficient permission" });
  });

  it("rejects expired and exhausted invites with operation records", async () => {
    const expiredInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "EXPIRED-INVITE",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    await expect(async () =>
      await acceptInvite(db, request, {
        code: expiredInvite.code,
        githubLogin: "expired-member",
        email: "expired-member@example.com"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const exhaustedInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "EXHAUSTED-INVITE",
      maxUses: 1
    });
    const firstMember = await acceptInvite(db, request, {
      code: exhaustedInvite.code,
      githubLogin: "exhausted-first",
      email: "exhausted-first@example.com"
    });
    expect(firstMember.role).toBe("member");
    await expect(async () =>
      await acceptInvite(db, request, {
        code: exhaustedInvite.code,
        githubLogin: "exhausted-second",
        email: "exhausted-second@example.com"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const rows = db.prepare(`
      SELECT target_id AS targetId, result, reason
      FROM audit_logs
      WHERE action = 'invite.accept'
        AND result = 'rejected'
        AND target_id IN (?, ?)
      ORDER BY created_at ASC
    `).all(expiredInvite.id, exhaustedInvite.id);
    expect(rows).toEqual([
      { targetId: expiredInvite.id, result: "rejected", reason: "expired invite" },
      { targetId: exhaustedInvite.id, result: "rejected", reason: "invite exhausted" }
    ]);

    const inviteRows = db.prepare(`
      SELECT id, uses
      FROM invites
      WHERE id IN (?, ?)
      ORDER BY id ASC
    `).all(expiredInvite.id, exhaustedInvite.id);
    expect(inviteRows).toEqual([
      { id: exhaustedInvite.id, uses: 1 },
      { id: expiredInvite.id, uses: 0 }
    ].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it("does not over-consume invite uses when the invite becomes exhausted before transaction commit", async () => {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "TXN-EXHAUSTED",
      maxUses: 1
    });
    db.prepare("UPDATE invites SET uses = max_uses WHERE id = ?").run(invite.id);

    await expect(async () =>
      await acceptInvite(db, request, {
        code: invite.code,
        githubLogin: "txn-exhausted",
        email: "txn-exhausted@example.com"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const inviteRow = db.prepare("SELECT uses, max_uses AS maxUses FROM invites WHERE id = ?").get(invite.id);
    expect(inviteRow).toEqual({ uses: 1, maxUses: 1 });
    const user = db.prepare("SELECT id FROM users WHERE github_login = 'txn-exhausted'").get();
    expect(user).toBeUndefined();
    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'invite.accept' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(invite.id);
    expect(audit).toEqual({ result: "rejected", reason: "invite exhausted" });
  });

  it("rolls back invite acceptance when downstream persistence fails", async () => {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "TXN-INVITE"
    });

    db.exec(`
      CREATE TRIGGER fail_member_join_event
      BEFORE INSERT ON workspace_events
      WHEN NEW.type = 'workspace.member_joined'
      BEGIN
        SELECT RAISE(ABORT, 'member join event failed');
      END
    `);
    try {
      await expect(async () =>
        await acceptInvite(db, request, {
          code: invite.code,
          githubLogin: "txn-member",
          email: "txn-member@example.com"
        })
      ).rejects.toThrow(/member join event failed/);
    } finally {
      db.exec("DROP TRIGGER fail_member_join_event");
    }

    const inviteRow = db.prepare("SELECT uses FROM invites WHERE id = ?").get(invite.id);
    expect(inviteRow.uses).toBe(0);
    const user = db.prepare("SELECT id FROM users WHERE github_login = 'txn-member'").get();
    expect(user).toBeUndefined();
    const successAudit = db.prepare(`
      SELECT 1
      FROM audit_logs
      WHERE action = 'invite.accept' AND target_id = ? AND result = 'success'
    `).get(invite.id);
    expect(successAudit).toBeUndefined();
  });

  it("does not notify realtime subscribers for rolled-back transactional events", async () => {
    const notifiedEvents = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      notifiedEvents.push(event);
    });
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "TXN-NOTIFY"
    });
    notifiedEvents.length = 0;

    db.exec(`
      CREATE TRIGGER fail_invite_accept_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'invite.accept' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'invite accept audit failed');
      END
    `);
    try {
      await expect(async () =>
        await acceptInvite(db, request, {
          code: invite.code,
          githubLogin: "txn-notify",
          email: "txn-notify@example.com"
        })
      ).rejects.toThrow(/invite accept audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_invite_accept_audit");
      unsubscribe();
    }

    const committedEvent = db.prepare(`
      SELECT 1
      FROM workspace_events
      WHERE type = 'workspace.member_joined' AND target_id != 'usr_owner'
    `).get();
    expect(committedEvent).toBeUndefined();
    expect(notifiedEvents).toEqual([]);
  });

  it("rolls back member role updates when audit persistence fails", async () => {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "ROLE-TXN"
    });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "role-txn",
      email: "role-txn@example.com"
    });

    db.exec(`
      CREATE TRIGGER fail_role_update_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'member.role_update' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'role update audit failed');
      END
    `);
    try {
      await expect(async () =>
        await updateMemberRole(db, request, {
          actorId: "usr_owner",
          userId: member.id,
          role: "admin"
        })
      ).rejects.toThrow(/role update audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_role_update_audit");
    }

    const membership = db.prepare("SELECT role FROM space_members WHERE user_id = ?").get(member.id);
    expect(membership.role).toBe("member");
    const event = db.prepare(`
      SELECT 1
      FROM workspace_events
      WHERE type = 'workspace.member_updated' AND target_id = ?
    `).get(member.id);
    expect(event).toBeUndefined();
  });

  it("lets the owner update member roles and records the change", async () => {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "ROLE-MEMBER"
    });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "role-member",
      email: "role-member@example.com"
    });

    const updated = await updateMemberRole(db, request, {
      actorId: "usr_owner",
      userId: member.id,
      role: "admin"
    });
    expect(updated.role).toBe("admin");
    expect((await getWorkspaceBootstrap(db, "usr_owner")).members.find((item) => item.id === member.id).role).toBe("admin");

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'member.role_update' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(member.id);
    expect(audit).toEqual({ result: "success", reason: "member->admin" });

    const event = db.prepare(`
      SELECT type, payload_json AS payloadJson
      FROM workspace_events
      WHERE type = 'workspace.member_updated' AND target_id = ?
      ORDER BY seq DESC
      LIMIT 1
    `).get(member.id);
    expect(JSON.parse(event.payloadJson).role).toBe("admin");
  });

  it("records rejected member role updates when the requested role is invalid", async () => {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "ROLE-INVALID"
    });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "role-invalid",
      email: "role-invalid@example.com"
    });

    await expect(async () =>
      await updateMemberRole(db, request, {
        actorId: "usr_owner",
        userId: member.id,
        role: "operator"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'member.role_update' AND target_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(member.id);
    expect(audit).toEqual({ result: "rejected", reason: "role.invalid" });
  });

  it("rejects member role updates from non-owners and protects the owner role", async () => {
    const adminInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      code: "ROLE-ADMIN"
    });
    const admin = await acceptInvite(db, request, {
      code: adminInvite.code,
      githubLogin: "role-admin",
      email: "role-admin@example.com"
    });
    const memberInvite = await createInvite(db, request, {
      actorId: admin.id,
      code: "ROLE-NORMAL"
    });
    const member = await acceptInvite(db, request, {
      code: memberInvite.code,
      githubLogin: "role-normal",
      email: "role-normal@example.com"
    });

    await expect(async () =>
      await updateMemberRole(db, request, {
        actorId: admin.id,
        userId: member.id,
        role: "admin"
      })
    ).rejects.toThrow(WorkspacePermissionError);

    const deniedAudit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'member.role_update'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(admin.id);
    expect(deniedAudit).toEqual({ result: "rejected", reason: "insufficient permission" });

    await expect(async () =>
      await updateMemberRole(db, request, {
        actorId: "usr_owner",
        userId: "usr_owner",
        role: "admin"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const ownerAudit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'member.role_update' AND target_id = 'usr_owner'
      ORDER BY created_at DESC
      LIMIT 1
    `).get();
    expect(ownerAudit).toEqual({ result: "rejected", reason: "self role update" });
  });

  it("removes a space member and revokes their conversation, file, and session access", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "REMOVE-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "remove-member",
      email: "remove-member@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Removal group",
      memberIds: [member.id]
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      fileName: "visible.txt",
      mimeType: "text/plain",
      byteSize: 12
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 12
    });
    const session = await createWorkspaceSession(db, member.id);

    const removed = await removeSpaceMember(db, request, {
      actorId: "usr_owner",
      userId: member.id
    });
    expect(removed).toMatchObject({ ok: true, userId: member.id });
    expect((await listMembers(db, "usr_owner")).map((item) => item.id)).not.toContain(member.id);
    await expect(async () => await listConversations(db, member.id)).rejects.toThrow(WorkspaceAuthError);
    await expect(async () => await listFiles(db, member.id)).rejects.toThrow(WorkspaceAuthError);
    expect(await getSessionUserId(db, session.token)).toBeNull();

    const audit = db.prepare("SELECT result FROM audit_logs WHERE action = 'member.remove' AND target_id = ?").get(member.id);
    expect(audit.result).toBe("success");
    const event = db.prepare("SELECT type FROM workspace_events WHERE type = 'workspace.member_removed' AND target_id = ?").get(member.id);
    expect(event.type).toBe("workspace.member_removed");
  });

  it("filters workspace members by query, role, kind, and limit", async () => {
    const adminInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      code: "FILTER-ADMIN"
    });
    await acceptInvite(db, request, {
      code: adminInvite.code,
      githubLogin: "filter-admin",
      email: "filter-admin@example.com",
      displayName: "Filter Admin"
    });
    const memberInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "FILTER-MEMBER"
    });
    await acceptInvite(db, request, {
      code: memberInvite.code,
      githubLogin: "filter-member",
      email: "filter-member@example.com",
      displayName: "Filter Member"
    });

    expect((await listMembers(db, "usr_owner", { q: "filter", role: "admin" })).map((member) => member.githubLogin)).toEqual(["filter-admin"]);
    expect(await listMembers(db, "usr_owner", { kind: "human", limit: 1 })).toHaveLength(1);
  });

  it("rejects member removal by non-owners and protects the current account", async () => {
    const adminInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      code: "REMOVE-ADMIN"
    });
    const admin = await acceptInvite(db, request, {
      code: adminInvite.code,
      githubLogin: "remove-admin",
      email: "remove-admin@example.com"
    });
    const memberInvite = await createInvite(db, request, {
      actorId: admin.id,
      code: "REMOVE-NORMAL"
    });
    const member = await acceptInvite(db, request, {
      code: memberInvite.code,
      githubLogin: "remove-normal",
      email: "remove-normal@example.com"
    });

    await expect(async () =>
      await removeSpaceMember(db, request, {
        actorId: admin.id,
        userId: member.id
      })
    ).rejects.toThrow(WorkspacePermissionError);

    await expect(async () =>
      await removeSpaceMember(db, request, {
        actorId: "usr_owner",
        userId: "usr_owner"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    expect((await listMembers(db, "usr_owner")).map((item) => item.id)).toContain(member.id);
    const deniedAudit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'member.remove'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(admin.id);
    expect(deniedAudit).toEqual({ result: "rejected", reason: "insufficient permission" });
  });

  it("lets members create direct conversations but not group conversations", async () => {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "DIRECT-MEMBER"
    });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "direct-member",
      email: "direct@example.com"
    });

    await updateManagedMemberVisibility(db, request, {
      actorId: "usr_owner",
      userId: member.id,
      visibleUserIds: ["usr_owner"]
    });

    const direct = await createConversation(db, request, {
      actorId: member.id,
      type: "direct",
      targetUserId: "usr_owner"
    });
    expect(direct.type).toBe("direct");
    expect(direct.displayTitle).toBe("timeStarry");
    expect(direct.otherMember).toMatchObject({
      id: "usr_owner",
      displayName: "timeStarry"
    });

    const reused = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    expect(reused.id).toBe(direct.id);
    expect(reused.displayTitle).toBe(member.displayName);
    expect(reused.otherMember).toMatchObject({
      id: member.id,
      displayName: member.displayName
    });

    const memberListed = (await listConversations(db, member.id)).find((item) => item.id === direct.id);
    const ownerListed = (await listConversations(db, "usr_owner")).find((item) => item.id === direct.id);
    expect(memberListed.displayTitle).toBe("timeStarry");
    expect(ownerListed.displayTitle).toBe(member.displayName);

    const memberCreateEvent = (await listWorkspaceEvents(db, member.id, 0)).find((event) => event.type === "conversation.created" && event.conversationId === direct.id);
    const ownerCreateEvent = (await listWorkspaceEvents(db, "usr_owner", 0)).find((event) => event.type === "conversation.created" && event.conversationId === direct.id);
    expect(memberCreateEvent.payload.conversation.displayTitle).toBe("timeStarry");
    expect(memberCreateEvent.payload.conversation.otherMember.id).toBe("usr_owner");
    expect(ownerCreateEvent.payload.conversation.displayTitle).toBe(member.displayName);
    expect(ownerCreateEvent.payload.conversation.otherMember.id).toBe(member.id);

    await expect(async () =>
      await createConversation(db, request, {
        actorId: member.id,
        type: "group",
        title: "Member group"
      })
    ).rejects.toThrow(WorkspacePermissionError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'conversation.create_group'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(member.id);
    expect(audit).toEqual({ result: "rejected", reason: "insufficient permission" });
  });

  it("rolls back direct conversation creation when audit persistence fails", async () => {
    const invite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "DIRECT-TXN"
    });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "direct-txn",
      email: "direct-txn@example.com"
    });

    await updateManagedMemberVisibility(db, request, {
      actorId: "usr_owner",
      userId: member.id,
      visibleUserIds: ["usr_owner"]
    });

    db.exec(`
      CREATE TRIGGER fail_direct_conversation_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'conversation.create' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'direct conversation audit failed');
      END
    `);
    try {
      await expect(async () =>
        await createConversation(db, request, {
          actorId: member.id,
          type: "direct",
          targetUserId: "usr_owner"
        })
      ).rejects.toThrow(/direct conversation audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_direct_conversation_audit");
    }

    const conversation = db.prepare("SELECT 1 FROM conversations WHERE type = 'direct'").get();
    expect(conversation).toBeUndefined();
    const membership = db.prepare("SELECT 1 FROM conversation_members").get();
    expect(membership).toBeUndefined();
    const event = db.prepare("SELECT 1 FROM workspace_events WHERE type = 'conversation.created'").get();
    expect(event).toBeUndefined();
  });

  it("records rejected conversation creation when the type is invalid", async () => {
    const before = {
      conversations: db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count,
      events: db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count,
      audits: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'conversation.create'").get().count
    };

    await expect(async () =>
      await createConversation(db, request, {
        actorId: "usr_owner",
        type: "channel"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count).toBe(before.conversations);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count).toBe(before.events);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'conversation.create'").get().count).toBe(before.audits + 1);
    expect(db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.create'
      ORDER BY rowid DESC
      LIMIT 1
    `).get()).toEqual({ result: "rejected", reason: "invalid type" });
  });

  it("records rejected direct conversation validation without creating rows", async () => {
    const before = {
      conversations: db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count,
      memberships: db.prepare("SELECT COUNT(*) AS count FROM conversation_members").get().count,
      events: db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count,
      audits: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'conversation.create'").get().count
    };

    await expect(async () =>
      await createConversation(db, request, {
        actorId: "usr_owner",
        type: "direct",
        targetUserId: "usr_owner"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    await expect(async () =>
      await createConversation(db, request, {
        actorId: "usr_owner",
        type: "direct",
        targetUserId: "missing-direct-member"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count).toBe(before.conversations);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_members").get().count).toBe(before.memberships);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count).toBe(before.events);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'conversation.create'").get().count).toBe(before.audits + 2);
    expect(db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.create'
      ORDER BY created_at DESC
      LIMIT 1
    `).get()).toEqual({ result: "rejected", reason: "invalid target" });
  });

  it("requires a group name and selected member when creating group conversations", async () => {
    await expect(async () =>
      await createConversation(db, request, {
        actorId: "usr_owner",
        type: "group",
        title: "   ",
        memberIds: ["usr_owner"]
      })
    ).rejects.toThrow(WorkspaceValidationError);

    await expect(async () =>
      await createConversation(db, request, {
        actorId: "usr_owner",
        type: "group",
        title: "x".repeat(81),
        memberIds: ["usr_owner"]
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const before = {
      conversations: db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count,
      memberships: db.prepare("SELECT COUNT(*) AS count FROM conversation_members").get().count,
      events: db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count,
      audits: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'conversation.create'").get().count
    };

    await expect(async () =>
      await createConversation(db, request, {
        actorId: "usr_owner",
        type: "group",
        title: "No selected members",
        memberIds: []
      })
    ).rejects.toThrow(WorkspaceValidationError);

    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count).toBe(before.conversations);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_members").get().count).toBe(before.memberships);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count).toBe(before.events);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'conversation.create'").get().count).toBe(before.audits + 1);
    expect(db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.create'
        AND result = 'rejected'
        AND reason = 'invalid members'
    `).get()).toEqual({ result: "rejected", reason: "invalid members" });
  });

  it("does not leave partial group conversations when selected members are invalid", async () => {
    const before = {
      conversations: db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count,
      memberships: db.prepare("SELECT COUNT(*) AS count FROM conversation_members").get().count,
      events: db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count,
      audits: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'conversation.create'").get().count
    };

    await expect(async () =>
      await createConversation(db, request, {
        actorId: "usr_owner",
        type: "group",
        title: "Invalid selected member",
        memberIds: ["missing-member"]
      })
    ).rejects.toThrow(WorkspaceValidationError);

    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count).toBe(before.conversations);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_members").get().count).toBe(before.memberships);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count).toBe(before.events);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'conversation.create'").get().count).toBe(before.audits + 1);
    expect(db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.create'
      ORDER BY created_at DESC
      LIMIT 1
    `).get()).toEqual({ result: "rejected", reason: "member.not_found" });
  });

  it("persists structured messages and deduplicates clientMessageId", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Structured"
    });

    const message = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "client-1",
      content: textContent("A structured message")
    });

    expect(message.plainText).toBe("A structured message");
    expect(message.content.blocks[0].type).toBe("text");
    const columns = db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name);
    expect(columns).not.toContain("body");
    const row = db.prepare("SELECT content_json AS contentJson FROM messages WHERE id = ?").get(message.id);
    expect(JSON.parse(row.contentJson).plainText).toBe("A structured message");

    const duplicate = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "client-1",
      content: textContent("A structured message")
    });
    expect(duplicate.id).toBe(message.id);

    await expect(async () =>
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: "client-1",
        content: textContent("Different")
      })
    ).rejects.toThrow(WorkspaceValidationError);
  });

  it("supports all P0 structured message block types with server canonicalization", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "BLOCK-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "block-member",
      email: "block-member@example.com",
      displayName: "Block Member"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "All blocks",
      memberIds: [member.id]
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      fileName: "blocks.txt",
      mimeType: "text/plain",
      byteSize: 16,
      visibility: "conversation"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 16
    });

    const message = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "all-blocks",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        plainText: "client supplied text is ignored",
        blocks: [
          { type: "text", text: "Hi " },
          { type: "mention", userId: member.id, label: "Spoofed Label" },
          { type: "text", text: " see " },
          { type: "link", url: "https://example.com/spec", label: "spec" },
          { type: "emoji", shortcode: "thumbsup" },
          { type: "attachment", attachmentId: upload.attachment.id }
        ]
      }
    });

    expect(message.content).toEqual({
      format: MESSAGE_CONTENT_FORMAT,
      plainText: "Hi @Block Member see spec:thumbsup:[文件]",
      blocks: [
        { type: "text", text: "Hi " },
        { type: "mention", userId: member.id, label: "Block Member" },
        { type: "text", text: " see " },
        { type: "link", url: "https://example.com/spec", label: "spec" },
        { type: "emoji", shortcode: "thumbsup" },
        { type: "attachment", attachmentId: upload.attachment.id }
      ]
    });
    expect(message.plainText).toBe("Hi @Block Member see spec:thumbsup:[文件]");
    expect(message.attachments.map((attachment) => attachment.id)).toEqual([upload.attachment.id]);

    await expect(async () =>
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: "bad-link",
        content: {
          format: MESSAGE_CONTENT_FORMAT,
          blocks: [{ type: "link", url: "javascript:alert(1)" }]
        }
      })
    ).rejects.toThrow(WorkspaceValidationError);
  });

  it("persists only server-validated card references and keeps fallback summaries", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Card messages"
    });
    const card = {
      type: "card",
      cardId: "card_unknown_1",
      cardType: "future.poll",
      schemaVersion: 99,
      fallbackText: "未来投票卡片"
    };
    const input = {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "card-reference-1",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        plainText: "客户端摘要会被覆盖",
        blocks: [card]
      }
    };
    await expect(createStructuredMessage(db, request, input)).rejects.toMatchObject({ code: "card.server_owned" });
    const validateCardReference = vi.fn(async () => card);
    const message = await createStructuredMessage(db, request, { ...input, validateCardReference });
    expect(validateCardReference).toHaveBeenCalledWith("usr_owner", conversation.id, card);

    expect(message.content).toEqual({
      format: MESSAGE_CONTENT_FORMAT,
      plainText: "未来投票卡片",
      blocks: [card]
    });
    expect(message.plainText).toBe("未来投票卡片");
    const row = db.prepare("SELECT content_json AS contentJson FROM messages WHERE id = ?").get(message.id);
    expect(JSON.parse(row.contentJson).blocks).toEqual([card]);
  });

  it("rejects malformed card references without requiring a registered card type", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Invalid cards"
    });

    await expect(createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "invalid-card-reference",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [{
          type: "card",
          cardId: "bad id",
          cardType: "future.poll",
          schemaVersion: 1,
          fallbackText: "不可用"
        }]
      }
    })).rejects.toMatchObject({ code: "card.invalid_id" });
  });

  it("lets group members start a direct conversation without making them globally visible", async () => {
    const firstInvite = await createInvite(db, request, { actorId: "usr_owner", code: "GROUP-DIRECT-A" });
    const firstMember = await acceptInvite(db, request, {
      code: firstInvite.code,
      githubLogin: "group-direct-a",
      email: "group-direct-a@example.com"
    });
    const secondInvite = await createInvite(db, request, { actorId: "usr_owner", code: "GROUP-DIRECT-B" });
    const secondMember = await acceptInvite(db, request, {
      code: secondInvite.code,
      githubLogin: "group-direct-b",
      email: "group-direct-b@example.com"
    });
    await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Shared group",
      memberIds: [firstMember.id, secondMember.id]
    });

    expect((await listMembers(db, firstMember.id)).map((member) => member.id))
      .not.toContain(secondMember.id);
    const direct = await createConversation(db, request, {
      actorId: firstMember.id,
      type: "direct",
      targetUserId: secondMember.id
    });

    expect(direct).toMatchObject({
      type: "direct",
      otherMember: { id: secondMember.id }
    });
    expect((await listMembers(db, firstMember.id)).map((member) => member.id))
      .toContain(secondMember.id);
  });

  it("accepts mention-only messages and whitespace separators between mentions", async () => {
    const firstInvite = await createInvite(db, request, { actorId: "usr_owner", code: "MENTION-ONLY-FIRST" });
    const firstMember = await acceptInvite(db, request, {
      code: firstInvite.code,
      githubLogin: "mention-only-first",
      email: "mention-only-first@example.com",
      displayName: "First Mention"
    });
    const secondInvite = await createInvite(db, request, { actorId: "usr_owner", code: "MENTION-ONLY-SECOND" });
    const secondMember = await acceptInvite(db, request, {
      code: secondInvite.code,
      githubLogin: "mention-only-second",
      email: "mention-only-second@example.com",
      displayName: "Second Mention"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Mention-only messages",
      memberIds: [firstMember.id, secondMember.id]
    });

    const mentionOnly = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "mention-only",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [{ type: "mention", userId: firstMember.id, label: "Spoofed" }]
      }
    });
    expect(mentionOnly.plainText).toBe("@First Mention");

    const separatedMentions = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "mention-separated",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [
          { type: "mention", userId: firstMember.id, label: "Spoofed" },
          { type: "text", text: " " },
          { type: "mention", userId: secondMember.id, label: "Spoofed" }
        ]
      }
    });
    expect(separatedMentions.content.blocks).toEqual([
      { type: "mention", userId: firstMember.id, label: "First Mention" },
      { type: "text", text: " " },
      { type: "mention", userId: secondMember.id, label: "Second Mention" }
    ]);
    expect(separatedMentions.plainText).toBe("@First Mention @Second Mention");

    await expect(createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "whitespace-only",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [{ type: "text", text: " \n\t " }]
      }
    })).rejects.toMatchObject({ code: "message.empty" });
  });

  it("rejects mentions for space members outside the current conversation", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "MENTION-OUTSIDE" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "mention-outside",
      email: "mention-outside@example.com",
      displayName: "Outside Mention"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Mention boundary"
    });

    await expect(async () =>
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: "outside-mention",
        content: {
          format: MESSAGE_CONTENT_FORMAT,
          blocks: [
            { type: "text", text: "Hello " },
            { type: "mention", userId: member.id, label: "Outside Mention" }
          ]
        }
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const row = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE client_message_id = ?").get("outside-mention");
    expect(row.count).toBe(0);
    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'message.create' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversation.id);
    expect(audit).toEqual({ result: "rejected", reason: "message.invalid_mention" });
  });

  it("does not allow private staging attachments to be published through messages", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Staging attachment boundary"
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "staging-only.txt",
      mimeType: "text/plain",
      byteSize: 12,
      visibility: "private_staging"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 12
    });

    await expect(async () =>
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: "staging-attachment",
        content: {
          format: MESSAGE_CONTENT_FORMAT,
          blocks: [
            { type: "text", text: "publish staging " },
            { type: "attachment", attachmentId: upload.attachment.id }
          ]
        }
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const attachment = db.prepare("SELECT visibility, conversation_id AS conversationId FROM attachments WHERE id = ?").get(upload.attachment.id);
    expect(attachment).toEqual({ visibility: "private_staging", conversationId: null });
    const links = db.prepare("SELECT COUNT(*) AS count FROM message_attachments WHERE attachment_id = ?").get(upload.attachment.id);
    expect(links.count).toBe(0);
  });

  it("rolls back message creation and attachment linking when audit persistence fails", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Message transaction"
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "message-txn.txt",
      mimeType: "text/plain",
      byteSize: 12,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 12
    });

    db.exec(`
      CREATE TRIGGER fail_message_create_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'message.create' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'message create audit failed');
      END
    `);
    try {
      await expect(async () =>
        await createStructuredMessage(db, request, {
          actorId: "usr_owner",
          conversationId: conversation.id,
          clientMessageId: "message-txn",
          content: {
            format: MESSAGE_CONTENT_FORMAT,
            blocks: [
              { type: "text", text: "transactional attachment " },
              { type: "attachment", attachmentId: upload.attachment.id }
            ]
          }
        })
      ).rejects.toThrow(/message create audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_message_create_audit");
    }

    const message = db.prepare("SELECT 1 FROM messages WHERE client_message_id = 'message-txn'").get();
    expect(message).toBeUndefined();
    const link = db.prepare("SELECT 1 FROM message_attachments WHERE attachment_id = ?").get(upload.attachment.id);
    expect(link).toBeUndefined();
    const attachment = db.prepare("SELECT visibility, conversation_id AS conversationId FROM attachments WHERE id = ?").get(upload.attachment.id);
    expect(attachment).toEqual({ visibility: "space", conversationId: null });
    const event = db.prepare("SELECT 1 FROM workspace_events WHERE type = 'message.created' AND conversation_id = ? AND payload_json LIKE '%message-txn%'").get(conversation.id);
    expect(event).toBeUndefined();
  });

  it("tracks unread counts and marks conversations as read", async () => {
    const membershipColumns = db.prepare("PRAGMA table_info(conversation_members)").all().map((column) => column.name);
    expect(membershipColumns).toEqual(expect.arrayContaining(["last_read_message_id", "last_read_at", "last_read_seq", "notification_level"]));

    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "UNREAD-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "unread-member",
      email: "unread@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });

    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "unread-1",
      content: textContent("Unread for member")
    });
    await createStructuredMessage(db, request, {
      actorId: member.id,
      conversationId: conversation.id,
      clientMessageId: "member-own",
      content: textContent("Own message")
    });
    await createWorkspaceConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Unread cursor isolation",
      memberIds: [member.id]
    });

    const latestMessageEvent = db.prepare(`
      SELECT m.id, we.seq AS eventSeq
      FROM messages m
      INNER JOIN workspace_events we
        ON we.type = 'message.created' AND we.target_id = m.id
      WHERE m.conversation_id = ? AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC, we.seq DESC, m.id DESC
      LIMIT 1
    `).get(conversation.id);
    const globalEventCursor = db.prepare("SELECT MAX(seq) AS eventCursor FROM workspace_events").get().eventCursor;
    expect(globalEventCursor).toBeGreaterThan(latestMessageEvent.eventSeq);

    const beforeRead = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);
    expect(beforeRead.unreadCount).toBe(1);
    expect(beforeRead.lastReadSeq).toBeNull();
    expect(beforeRead.notificationLevel).toBe("all");

    const read = await markConversationRead(db, request, {
      actorId: member.id,
      conversationId: conversation.id
    });
    expect(read.unreadCount).toBe(0);
    expect(read.lastReadMessageId).toBe(latestMessageEvent.id);
    expect(read.lastReadSeq).toBe(latestMessageEvent.eventSeq);
    expect(read.notificationLevel).toBe("all");

    const afterRead = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);
    expect(afterRead.unreadCount).toBe(0);
    expect(afterRead.lastReadMessageId).toBeTruthy();
    expect(afterRead.lastReadAt).toBeTruthy();
    expect(afterRead.lastReadSeq).toBe(read.lastReadSeq);
    expect(afterRead.notificationLevel).toBe("all");

    const sameTimestampMessage = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "unread-same-timestamp",
      content: textContent("Unread despite matching the read timestamp")
    });
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(afterRead.lastReadAt, sameTimestampMessage.id);

    const afterSameTimestamp = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);
    expect(afterSameTimestamp.unreadCount).toBe(1);

    const sameTimestampEvent = db.prepare(`
      SELECT seq
      FROM workspace_events
      WHERE type = 'message.created' AND target_id = ?
    `).get(sameTimestampMessage.id);
    const readSameTimestamp = await markConversationRead(db, request, {
      actorId: member.id,
      conversationId: conversation.id
    });
    expect(readSameTimestamp.lastReadMessageId).toBe(sameTimestampMessage.id);
    expect(readSameTimestamp.lastReadSeq).toBe(sameTimestampEvent.seq);

    const advancedReadSeq = sameTimestampEvent.seq + 100;
    db.prepare(`
      UPDATE conversation_members
      SET last_read_seq = ?
      WHERE conversation_id = ? AND user_id = ?
    `).run(advancedReadSeq, conversation.id, member.id);
    const monotonicRead = await markConversationRead(db, request, {
      actorId: member.id,
      conversationId: conversation.id
    });
    expect(monotonicRead.lastReadSeq).toBe(advancedReadSeq);
  });

  it("updates conversation notification levels only for the current member", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "NOTIFY-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "notify-member",
      email: "notify@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });

    const updated = await updateConversationNotificationLevel(db, request, {
      actorId: member.id,
      conversationId: conversation.id,
      level: "muted"
    });
    expect(updated.notificationLevel).toBe("muted");

    const memberConversation = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);
    const ownerConversation = (await listConversations(db, "usr_owner")).find((item) => item.id === conversation.id);
    expect(memberConversation.notificationLevel).toBe("muted");
    expect(ownerConversation.notificationLevel).toBe("all");

    const memberEvent = (await listWorkspaceEvents(db, member.id, 0)).find((event) => event.type === "conversation.notification_updated");
    const ownerEvent = (await listWorkspaceEvents(db, "usr_owner", 0)).find((event) => event.type === "conversation.notification_updated");
    expect(memberEvent).toMatchObject({
      targetType: "user",
      targetId: member.id,
      payload: {
        conversationId: conversation.id,
        notificationLevel: "muted",
        conversation: {
          id: conversation.id,
          notificationLevel: "muted"
        }
      }
    });
    expect(ownerEvent).toBeUndefined();
  });

  it("rejects invalid conversation notification levels", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Invalid notification"
    });

    await expect(async () =>
      await updateConversationNotificationLevel(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        level: "loud"
      })
    ).rejects.toThrow(WorkspaceValidationError);
  });

  it("enforces conversation message retention for visible history", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Retention"
    });
    db.prepare("UPDATE conversations SET retention_count = 2 WHERE id = ?").run(conversation.id);

    for (const text of ["first", "second", "third"]) {
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: `retention-${text}`,
        content: textContent(text)
      });
    }

    const rows = db.prepare(`
      SELECT plain_text AS plainText, deleted_at AS deletedAt
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `).all(conversation.id);
    expect(rows.map((row) => row.plainText)).toEqual(["timeStarry 创建了群聊「Retention」", "first", "second", "third"]);
    expect(rows.slice(0, 2).every((row) => row.deletedAt)).toBe(true);
    expect(rows.slice(2).every((row) => row.deletedAt === null)).toBe(true);

    const visibleMessages = await listMessages(db, "usr_owner", conversation.id, { limit: 20 });
    expect(visibleMessages.map((message) => message.plainText)).toEqual(["second", "third"]);
    expect(visibleMessages.some((message) => Object.hasOwn(message, "contentJson"))).toBe(false);

    const listed = (await listConversations(db, "usr_owner")).find((item) => item.id === conversation.id);
    expect(listed.messageCount).toBe(2);
    expect(listed.latestMessages.map((message) => message.plainText)).toEqual(["second", "third"]);
  });

  it("writes conversation-visible system messages for group changes", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "SYSTEM-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "system-member",
      email: "system-member@example.com",
      displayName: "System Member"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "System group"
    });

    await addConversationMember(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      userId: member.id
    });
    await updateGroupConversation(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      title: "Renamed system group"
    });
    await removeConversationMember(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      userId: member.id
    });

    const messages = await listMessages(db, "usr_owner", conversation.id, { limit: 20 });
    expect(messages.map((message) => message.plainText)).toEqual([
      "timeStarry 创建了群聊「System group」",
      "timeStarry 邀请 System Member 加入群聊",
      "timeStarry 将群聊名称改为「Renamed system group」",
      "timeStarry 将 System Member 移出群聊"
    ]);
    expect(messages.every((message) => message.kind === "system" && message.authorKind === "system")).toBe(true);

    const messageEvent = (await listWorkspaceEvents(db, "usr_owner", 0)).find((event) =>
      event.type === "message.created" &&
      event.payload.message?.plainText === "timeStarry 邀请 System Member 加入群聊"
    );
    expect(messageEvent.payload.message.kind).toBe("system");
    expect(JSON.stringify(messageEvent)).not.toContain("system-member@example.com");
  });

  it("projects product-ready conversation fields without leaking viewer internals", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "CONVERSATION-PRODUCT-FIELDS" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "conversation-product-member",
      email: "conversation-product-member@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Product conversation fields",
      memberIds: [member.id]
    });
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "product-fields-message",
      content: textContent("Product field summary")
    });

    const ownerConversation = (await listConversations(db, "usr_owner")).find((item) => item.id === conversation.id);
    expect(ownerConversation).toMatchObject({
      displayTitle: "Product conversation fields",
      memberCount: 2,
      lastMessagePlainText: "Product field summary",
      retentionText: "保留最近 10000 条消息",
      capabilities: {
        canSendMessage: true,
        canUploadFile: true,
        canManageMembers: true
      }
    });
    expect(ownerConversation.lastMessageAt).toBeTruthy();
    expect(ownerConversation.viewerRole).toBeUndefined();

    const memberConversation = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);
    expect(memberConversation.capabilities).toEqual({
      canSendMessage: true,
      canUploadFile: true,
      canManageMembers: false
    });
    expect(JSON.stringify(memberConversation)).not.toContain("viewerRole");

    const direct = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    const directConversation = (await listConversations(db, "usr_owner")).find((item) => item.id === direct.id);
    expect(directConversation.capabilities).toMatchObject({
      canSendMessage: true,
      canUploadFile: true,
      canManageMembers: false
    });
  });

  it("keeps attachments and message links when message retention hides old messages", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Retention attachments"
    });
    db.prepare("UPDATE conversations SET retention_count = 1 WHERE id = ?").run(conversation.id);

    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "retained-attachment.txt",
      mimeType: "text/plain",
      byteSize: 32,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 32
    });

    const messageWithAttachment = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "retention-file-1",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [
          { type: "text", text: "File lives on " },
          { type: "attachment", attachmentId: upload.attachment.id }
        ]
      }
    });
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "retention-file-2",
      content: textContent("Newer message")
    });

    const hiddenMessage = db.prepare("SELECT deleted_at AS deletedAt FROM messages WHERE id = ?").get(messageWithAttachment.id);
    expect(hiddenMessage.deletedAt).toBeTruthy();
    const attachment = db.prepare(`
      SELECT status, conversation_id AS conversationId, visibility
      FROM attachments
      WHERE id = ?
    `).get(upload.attachment.id);
    expect(attachment).toEqual({
      status: "available",
      conversationId: conversation.id,
      visibility: "conversation"
    });
    const link = db.prepare(`
      SELECT message_id AS messageId, attachment_id AS attachmentId
      FROM message_attachments
      WHERE message_id = ? AND attachment_id = ?
    `).get(messageWithAttachment.id, upload.attachment.id);
    expect(link).toEqual({ messageId: messageWithAttachment.id, attachmentId: upload.attachment.id });
    expect((await listFiles(db, "usr_owner", { conversationId: conversation.id })).map((file) => file.id)).toContain(upload.attachment.id);

    const messageList = await listMessages(db, "usr_owner", conversation.id, { limit: 10 });
    const serialized = JSON.stringify(messageList);
    expect(serialized).not.toContain("contentJson");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("uploadTransferId");
  });

  it("returns the most recent messages in chronological order", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Recent messages"
    });

    for (const text of ["one", "two", "three", "four"]) {
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: `recent-${text}`,
        content: textContent(text)
      });
    }

    const messages = await listMessages(db, "usr_owner", conversation.id, { limit: 2 });
    expect(messages.map((message) => message.plainText)).toEqual(["three", "four"]);

    const listed = (await listConversations(db, "usr_owner")).find((item) => item.id === conversation.id);
    expect(listed.latestMessages.map((message) => message.plainText)).toEqual(["timeStarry 创建了群聊「Recent messages」", "one", "two", "three", "four"]);
    expect(listed.latestMessages.at(-1).plainText).toBe("four");
  });

  it("loads older messages before a message cursor", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Paged messages"
    });

    for (const text of ["one", "two", "three", "four"]) {
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: `paged-${text}`,
        content: textContent(text)
      });
    }

    const latest = await listMessages(db, "usr_owner", conversation.id, { limit: 2 });
    expect(latest.map((message) => message.plainText)).toEqual(["three", "four"]);

    const older = await listMessages(db, "usr_owner", conversation.id, {
      before: latest[0].id,
      limit: 2
    });
    expect(older.map((message) => message.plainText)).toEqual(["one", "two"]);
    expect(await listMessages(db, "usr_owner", conversation.id, { before: "missing", limit: 2 })).toEqual([]);
  });

  it("orders conversations by latest retained activity", async () => {
    const olderConversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Older active conversation"
    });
    const newerConversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Newer quiet conversation"
    });

    const activeMessage = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: olderConversation.id,
      clientMessageId: "activity-latest",
      content: textContent("Latest activity")
    });
    db.prepare("UPDATE conversations SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", olderConversation.id);
    db.prepare("UPDATE conversations SET created_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", newerConversation.id);
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run("2026-01-03T00:00:00.000Z", activeMessage.id);
    db.prepare("UPDATE messages SET created_at = ? WHERE conversation_id = ? AND kind = 'system'").run("2026-01-01T00:00:00.000Z", olderConversation.id);
    db.prepare("UPDATE messages SET created_at = ? WHERE conversation_id = ? AND kind = 'system'").run("2026-01-02T00:00:00.000Z", newerConversation.id);

    const conversations = await listConversations(db, "usr_owner");
    expect(conversations.map((conversation) => conversation.id).slice(0, 2)).toEqual([olderConversation.id, newerConversation.id]);
    expect(conversations[0].lastActivityAt).toBe("2026-01-03T00:00:00.000Z");
    expect(conversations[1].lastActivityAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rejects non-member message creation and writes audit", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Owner only"
    });

    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "OUTSIDER" });
    const outsider = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "outsider-member",
      email: "outsider-member@example.com"
    });

    await expect(async () =>
      await createStructuredMessage(db, request, {
        actorId: outsider.id,
        conversationId: conversation.id,
        clientMessageId: "outsider-1",
        content: textContent("Should not land")
      })
    ).rejects.toThrow(WorkspacePermissionError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'message.create'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(outsider.id);
    expect(audit).toEqual({ result: "rejected", reason: "not a conversation member" });
  });

  it("writes audit rows for invalid structured message rejections", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Message validation"
    });

    await expect(async () =>
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: "invalid-block",
        content: {
          format: MESSAGE_CONTENT_FORMAT,
          blocks: [{ type: "unknown", text: "Nope" }]
        }
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = 'usr_owner' AND action = 'message.create' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversation.id);
    expect(audit).toEqual({ result: "rejected", reason: "message.invalid_block" });
  });

  it("writes audit rows for message idempotency conflicts", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Message idempotency audit"
    });

    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "conflict-message",
      content: textContent("Original")
    });

    await expect(async () =>
      await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        clientMessageId: "conflict-message",
        content: textContent("Changed")
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = 'usr_owner' AND action = 'message.create' AND target_id = ?
        AND result = 'rejected'
        AND reason = 'message.idempotency_conflict'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversation.id);
    expect(audit).toEqual({ result: "rejected", reason: "message.idempotency_conflict" });
  });

  it("reserves upload quota, allows standalone attachments, and releases quota on failure", async () => {
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "standalone.txt",
      mimeType: "text/plain",
      byteSize: 1024,
      visibility: "space"
    });

    expect(upload.status).toBe("reserved");
    expect(upload.attachment.status).toBe("pending");

    const filesBeforeComplete = await listFiles(db, "usr_owner");
    expect(filesBeforeComplete).toHaveLength(0);

    const failed = await failUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      reason: "test failure"
    });
    expect(failed.transfer.status).toBe("failed");

    const used = db.prepare(`
      SELECT COALESCE(SUM(byte_size), 0) AS used
      FROM transfer_ledger
      WHERE user_id = 'usr_owner' AND status IN ('reserved', 'completed')
    `).get();
    expect(used.used).toBe(0);
  });

  it("rolls back upload reservation state when audit persistence fails", async () => {
    db.exec(`
      CREATE TRIGGER fail_upload_reserve_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'file.upload.reserve' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'upload reserve audit failed');
      END
    `);
    try {
      await expect(async () =>
        await reserveUpload(db, request, {
          actorId: "usr_owner",
          fileName: "upload-txn.txt",
          mimeType: "text/plain",
          byteSize: 128,
          visibility: "space"
        })
      ).rejects.toThrow(/upload reserve audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_upload_reserve_audit");
    }

    const attachment = db.prepare("SELECT 1 FROM attachments WHERE file_name = 'upload-txn.txt'").get();
    expect(attachment).toBeUndefined();
    const transfer = db.prepare("SELECT 1 FROM transfer_ledger WHERE direction = 'upload' AND byte_size = 128").get();
    expect(transfer).toBeUndefined();
    const event = db.prepare("SELECT 1 FROM workspace_events WHERE type = 'attachment.created'").get();
    expect(event).toBeUndefined();
  });

  it("records rejected upload reservations for invalid request metadata", async () => {
    const before = {
      attachments: db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
      transfers: db.prepare("SELECT COUNT(*) AS count FROM transfer_ledger").get().count,
      events: db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count,
      audits: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'file.upload.reserve'").get().count
    };

    await expect(async () =>
      await reserveUpload(db, request, {
        actorId: "usr_owner",
        fileName: "bad-size.bin",
        byteSize: -1,
        visibility: "space"
      })
    ).rejects.toThrow(WorkspaceValidationError);
    await expect(async () =>
      await reserveUpload(db, request, {
        actorId: "usr_owner",
        fileName: "bad-visibility.bin",
        byteSize: 1,
        visibility: "global"
      })
    ).rejects.toThrow(WorkspaceValidationError);
    await expect(async () =>
      await reserveUpload(db, request, {
        actorId: "usr_owner",
        fileName: "   ",
        byteSize: 1,
        visibility: "space"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    expect(db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count).toBe(before.attachments);
    expect(db.prepare("SELECT COUNT(*) AS count FROM transfer_ledger").get().count).toBe(before.transfers);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count).toBe(before.events);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'file.upload.reserve'").get().count).toBe(before.audits + 3);
    const reasons = db.prepare(`
      SELECT reason
      FROM audit_logs
      WHERE action = 'file.upload.reserve'
      ORDER BY rowid DESC
      LIMIT 3
    `).all().map((row) => row.reason);
    expect(reasons).toEqual(["file.invalid", "file.invalid_visibility", "file.invalid_size"]);
  });

  it("releases upload quota when completion byte verification fails", async () => {
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "mismatch.txt",
      mimeType: "text/plain",
      byteSize: 1024,
      visibility: "space"
    });

    await expect(async () =>
      await completeUpload(db, request, {
        actorId: "usr_owner",
        uploadId: upload.id,
        storageVerifiedByteSize: 512
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const used = db.prepare(`
      SELECT COALESCE(SUM(byte_size), 0) AS used
      FROM transfer_ledger
      WHERE user_id = 'usr_owner' AND status IN ('reserved', 'completed')
    `).get();
    expect(used.used).toBe(0);

    const transfer = db.prepare("SELECT status, released_at AS releasedAt FROM transfer_ledger WHERE id = ?").get(upload.id);
    expect(transfer.status).toBe("failed");
    expect(transfer.releasedAt).toBeTruthy();

    const attachment = db.prepare("SELECT status FROM attachments WHERE id = ?").get(upload.attachment.id);
    expect(attachment.status).toBe("failed");

    const event = db.prepare(`
      SELECT type
      FROM workspace_events
      WHERE type = 'attachment.failed' AND target_id = ?
    `).get(upload.attachment.id);
    expect(event.type).toBe("attachment.failed");

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'file.upload.failed' AND target_id = ?
    `).get(upload.attachment.id);
    expect(audit).toEqual({ result: "failure", reason: "upload.size_mismatch" });
  });

  it("releases stale pending upload reservations before reporting quota", async () => {
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "abandoned.bin",
      mimeType: "application/octet-stream",
      byteSize: 4096,
      visibility: "space"
    });
    const staleCreatedAt = new Date(Date.now() - STALE_UPLOAD_RESERVATION_MS - 1000).toISOString();
    db.prepare("UPDATE transfer_ledger SET created_at = ? WHERE id = ?").run(staleCreatedAt, upload.id);

    const usedBeforeCleanup = db.prepare(`
      SELECT COALESCE(SUM(byte_size), 0) AS used
      FROM transfer_ledger
      WHERE user_id = 'usr_owner' AND status IN ('reserved', 'completed')
    `).get();
    expect(usedBeforeCleanup.used).toBe(4096);

    const bootstrap = await getWorkspaceBootstrap(db, "usr_owner");
    expect(bootstrap.policy.usedTodayBytes).toBe(0);
    expect(bootstrap.policy.remainingQuotaBytes).toBe(DAILY_QUOTA_BYTES);

    const transfer = db.prepare("SELECT status, released_at AS releasedAt FROM transfer_ledger WHERE id = ?").get(upload.id);
    expect(transfer.status).toBe("failed");
    expect(transfer.releasedAt).toBeTruthy();

    const attachment = db.prepare("SELECT status FROM attachments WHERE id = ?").get(upload.attachment.id);
    expect(attachment.status).toBe("failed");

    const event = db.prepare(`
      SELECT type
      FROM workspace_events
      WHERE type = 'attachment.failed' AND target_id = ?
    `).get(upload.attachment.id);
    expect(event.type).toBe("attachment.failed");

    const audit = db.prepare(`
      SELECT action, result, reason
      FROM audit_logs
      WHERE action = 'file.upload.failed' AND target_id = ?
    `).get(upload.attachment.id);
    expect(audit).toEqual({
      action: "file.upload.failed",
      result: "failure",
      reason: "stale upload reservation"
    });
  });

  it("rolls back stale upload cleanup when audit persistence fails", async () => {
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "stale-txn.bin",
      mimeType: "application/octet-stream",
      byteSize: 2048,
      visibility: "space"
    });
    const staleCreatedAt = new Date(Date.now() - STALE_UPLOAD_RESERVATION_MS - 1000).toISOString();
    db.prepare("UPDATE transfer_ledger SET created_at = ? WHERE id = ?").run(staleCreatedAt, upload.id);

    db.exec(`
      CREATE TRIGGER fail_stale_upload_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'file.upload.failed' AND NEW.reason = 'stale upload reservation'
      BEGIN
        SELECT RAISE(ABORT, 'stale upload audit failed');
      END
    `);
    try {
      await expect(async () => await releaseStaleUploadReservations(db)).rejects.toThrow(/stale upload audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_stale_upload_audit");
    }

    const transfer = db.prepare("SELECT status, released_at AS releasedAt FROM transfer_ledger WHERE id = ?").get(upload.id);
    expect(transfer).toEqual({ status: "reserved", releasedAt: null });
    const attachment = db.prepare("SELECT status FROM attachments WHERE id = ?").get(upload.attachment.id);
    expect(attachment.status).toBe("pending");
    const event = db.prepare("SELECT 1 FROM workspace_events WHERE type = 'attachment.failed' AND target_id = ?").get(upload.attachment.id);
    expect(event).toBeUndefined();
  });

  it("does not release fresh pending upload reservations during stale cleanup", async () => {
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "fresh.bin",
      mimeType: "application/octet-stream",
      byteSize: 1024,
      visibility: "space"
    });

    expect(await releaseStaleUploadReservations(db)).toBe(0);

    const transfer = db.prepare("SELECT status FROM transfer_ledger WHERE id = ?").get(upload.id);
    expect(transfer.status).toBe("reserved");
    const attachment = db.prepare("SELECT status FROM attachments WHERE id = ?").get(upload.attachment.id);
    expect(attachment.status).toBe("pending");
  });

  it("downloads only after quota check and rejects oversized downloads before transfer", async () => {
    const smallUpload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "download-ok.bin",
      mimeType: "application/octet-stream",
      byteSize: 256,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: smallUpload.id,
      storageVerifiedByteSize: 256
    });
    const download = await reserveDownload(db, request, {
      actorId: "usr_owner",
      attachmentId: smallUpload.attachment.id
    });
    expect(download.status).toBe("completed");
    const successfulAuditActions = db.prepare(`
      SELECT action
      FROM audit_logs
      WHERE actor_user_id = 'usr_owner'
        AND target_id = ?
        AND result = 'success'
      ORDER BY created_at ASC
    `).all(smallUpload.attachment.id).map((row) => row.action);
    expect(successfulAuditActions).toContain("file.download.reserve");
    expect(successfulAuditActions).toContain("file.download.completed");

    const fillBytes = DAILY_QUOTA_BYTES - download.usedToday;
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "big.bin",
      mimeType: "application/octet-stream",
      byteSize: fillBytes,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: fillBytes
    });

    const rejected = await reserveDownload(db, request, {
      actorId: "usr_owner",
      attachmentId: upload.attachment.id
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.id).toBeUndefined();

    const ledger = db.prepare(`
      SELECT status
      FROM transfer_ledger
      WHERE user_id = 'usr_owner'
        AND direction = 'download'
        AND attachment_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(upload.attachment.id);
    expect(ledger.status).toBe("rejected");
    const rejectionAudit = db.prepare(`
      SELECT action, result, reason
      FROM audit_logs
      WHERE action = 'file.download.rejected'
        AND actor_user_id = 'usr_owner'
      ORDER BY created_at DESC
      LIMIT 1
    `).get();
    expect(rejectionAudit).toEqual({
      action: "file.download.rejected",
      result: "rejected",
      reason: "insufficient daily quota"
    });
  });

  it("rolls back download reservations when audit persistence fails", async () => {
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "download-txn.bin",
      mimeType: "application/octet-stream",
      byteSize: 256,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 256
    });
    const usedBefore = (await getWorkspaceBootstrap(db, "usr_owner")).policy.usedTodayBytes;

    db.exec(`
      CREATE TRIGGER fail_download_reserve_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'file.download.reserve' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'download reserve audit failed');
      END
    `);
    try {
      await expect(async () =>
        await reserveDownload(db, request, {
          actorId: "usr_owner",
          attachmentId: upload.attachment.id
        })
      ).rejects.toThrow(/download reserve audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_download_reserve_audit");
    }

    const downloadLedger = db.prepare(`
      SELECT 1
      FROM transfer_ledger
      WHERE direction = 'download' AND attachment_id = ?
    `).get(upload.attachment.id);
    expect(downloadLedger).toBeUndefined();
    expect((await getWorkspaceBootstrap(db, "usr_owner")).policy.usedTodayBytes).toBe(usedBefore);
  });

  it("rejects file downloads outside the visible scope and records the rejection", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Scoped files"
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      visibility: "conversation",
      fileName: "scoped.txt",
      mimeType: "text/plain",
      byteSize: 64
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 64
    });
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "FILE-SCOPE" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "file-scope-member",
      email: "file-scope-member@example.com"
    });

    await expect(async () =>
      await reserveDownload(db, request, {
        actorId: member.id,
        attachmentId: upload.attachment.id
      })
    ).rejects.toThrow(WorkspacePermissionError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'file.download' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(member.id, upload.attachment.id);
    expect(audit).toEqual({ result: "rejected", reason: "not a conversation member" });
  });

  it("creates visible files after upload completion", async () => {
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "share.txt",
      mimeType: "text/plain",
      byteSize: 128,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 128
    });

    const files = await listFiles(db, "usr_owner");
    expect(files).toHaveLength(1);
    expect(files[0].fileName).toBe("share.txt");
    expect(files[0]).toMatchObject({
      uploader: {
        id: "usr_owner",
        displayName: "timeStarry"
      },
      capabilities: {
        canDownload: true,
        canRemove: true
      }
    });
    expect(files[0].availableAt).toBeTruthy();
    expect(files[0].storageKey).toBeUndefined();
  });

  it("filters visible files by scope, query, conversation, and uploader", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "File Filter Room"
    });
    const standalone = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "standalone-report.txt",
      mimeType: "text/plain",
      byteSize: 64,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: standalone.id,
      storageVerifiedByteSize: 64
    });
    const conversationFile = await reserveUpload(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      visibility: "conversation",
      fileName: "room-brief.pdf",
      mimeType: "application/pdf",
      byteSize: 128
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: conversationFile.id,
      storageVerifiedByteSize: 128
    });

    expect((await listFiles(db, "usr_owner", { scope: "standalone" })).map((file) => file.id)).toEqual([standalone.attachment.id]);
    expect((await listFiles(db, "usr_owner", { scope: "conversation" })).map((file) => file.id)).toEqual([conversationFile.attachment.id]);
    expect((await listFiles(db, "usr_owner", { conversationId: conversation.id })).map((file) => file.id)).toEqual([conversationFile.attachment.id]);
    expect((await listFiles(db, "usr_owner", { uploaderId: "usr_owner", q: "brief" })).map((file) => file.id)).toEqual([conversationFile.attachment.id]);
  });

  it("projects file capabilities from the current viewer", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "FILE-CAPABILITY-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "file-capability-member",
      email: "file-capability-member@example.com"
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "viewer-capability.txt",
      mimeType: "text/plain",
      byteSize: 64,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 64
    });

    const [visibleFile] = await listFiles(db, member.id);
    expect(visibleFile).toMatchObject({
      id: upload.attachment.id,
      uploader: {
        id: "usr_owner",
        displayName: "timeStarry"
      },
      capabilities: {
        canDownload: true,
        canRemove: false
      }
    });
  });

  it("keeps space-visible uploads detached from conversations even when a conversationId is supplied", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Detached file room"
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      visibility: "space",
      fileName: "detached-space-file.txt",
      mimeType: "text/plain",
      byteSize: 32
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 32
    });

    const attachment = db.prepare("SELECT visibility, conversation_id AS conversationId FROM attachments WHERE id = ?").get(upload.attachment.id);
    expect(attachment).toEqual({ visibility: "space", conversationId: null });
    expect((await listFiles(db, "usr_owner", { scope: "standalone" })).map((file) => file.id)).toEqual([upload.attachment.id]);
    expect((await listFiles(db, "usr_owner", { conversationId: conversation.id })).map((file) => file.id)).toEqual([]);
  });

  it("blocks file library access for roles without download permission", async () => {
    const auditorInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "auditor",
      code: "AUDITOR-FILES"
    });
    const auditor = await acceptInvite(db, request, {
      code: auditorInvite.code,
      githubLogin: "auditor-files",
      email: "auditor-files@example.com"
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "space-visible.txt",
      mimeType: "text/plain",
      byteSize: 12,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 12
    });

    await expect(async () => await listFiles(db, auditor.id, {}, request)).rejects.toThrow(WorkspacePermissionError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'file.download'
      ORDER BY rowid DESC
      LIMIT 1
    `).get(auditor.id);
    expect(audit).toEqual({ result: "rejected", reason: "insufficient permission" });
  });

  it("removes attachments without deleting records and blocks later downloads", async () => {
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "remove-file.txt",
      mimeType: "text/plain",
      byteSize: 64,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 64
    });

    const removed = await removeAttachment(db, request, {
      actorId: "usr_owner",
      attachmentId: upload.attachment.id
    });
    expect(removed).toEqual({ ok: true, attachmentId: upload.attachment.id });
    expect((await listFiles(db, "usr_owner")).map((file) => file.id)).not.toContain(upload.attachment.id);
    await expect(async () =>
      await reserveDownload(db, request, {
        actorId: "usr_owner",
        attachmentId: upload.attachment.id
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const row = db.prepare("SELECT status FROM attachments WHERE id = ?").get(upload.attachment.id);
    expect(row.status).toBe("removed");
    const audit = db.prepare("SELECT result FROM audit_logs WHERE action = 'file.remove' AND target_id = ?").get(upload.attachment.id);
    expect(audit.result).toBe("success");
    const event = db.prepare("SELECT type FROM workspace_events WHERE type = 'attachment.removed' AND target_id = ?").get(upload.attachment.id);
    expect(event.type).toBe("attachment.removed");
  });

  it("rejects attachment removal by ordinary non-uploaders", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "FILE-REMOVER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "file-remover",
      email: "file-remover@example.com"
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "owner-file.txt",
      mimeType: "text/plain",
      byteSize: 64,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 64
    });

    await expect(async () =>
      await removeAttachment(db, request, {
        actorId: member.id,
        attachmentId: upload.attachment.id
      })
    ).rejects.toThrow(WorkspacePermissionError);
    expect((await listFiles(db, "usr_owner")).map((file) => file.id)).toContain(upload.attachment.id);
    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'file.remove' AND actor_user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(member.id);
    expect(audit).toEqual({ result: "rejected", reason: "insufficient permission" });
  });

  it("emits monotonic workspace events visible to allowed members", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Events"
    });
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "event-1",
      content: textContent("Event message")
    });

    const events = await listWorkspaceEvents(db, "usr_owner", 0);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(events.some((event) => event.type === "message.created")).toBe(true);
  });

  it("includes safe projection payloads in message and attachment events", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Projection events"
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      visibility: "conversation",
      fileName: "projection.txt",
      mimeType: "text/plain",
      byteSize: 64
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 64
    });
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "projection-message",
      content: textContent("Projection message")
    });

    const events = await listWorkspaceEvents(db, "usr_owner", 0);
    const messageEvent = events.find((event) => event.type === "message.created" && event.payload.message?.clientMessageId === "projection-message");
    expect(messageEvent.payload.message).toMatchObject({
      plainText: "Projection message",
      conversationId: conversation.id
    });
    expect(messageEvent.payload.conversation).toMatchObject({
      id: conversation.id,
      title: "Projection events"
    });

    const attachmentEvent = events.find((event) => event.type === "attachment.available" && event.payload.attachmentId === upload.attachment.id);
    expect(attachmentEvent.payload.attachment).toMatchObject({
      id: upload.attachment.id,
      fileName: "projection.txt",
      status: "available",
      uploaderName: "timeStarry"
    });
    expect(attachmentEvent.payload.attachment.storageKey).toBeUndefined();

    const createdAttachmentEvent = events.find((event) => event.type === "attachment.created" && event.payload.attachmentId === upload.attachment.id);
    expect(createdAttachmentEvent.payload.transferId).toBeUndefined();
    expect(createdAttachmentEvent.payload.attachment.storageKey).toBeUndefined();
  });

  it("sanitizes realtime event payloads through product projection allowlists", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Projection allowlist"
    });
    const seq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM workspace_events WHERE space_id = ?").get(DEFAULT_SPACE_ID).seq;
    db.prepare(`
      INSERT INTO workspace_events (
        id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
      )
      VALUES (?, ?, ?, 'message.created', 'usr_owner', ?, 'message', 'msg_projection_allowlist', ?, ?)
    `).run(
      "evt_projection_allowlist",
      DEFAULT_SPACE_ID,
      seq,
      conversation.id,
      JSON.stringify({
        requestId: "req-internal",
        transferId: "transfer-internal",
        payloadJson: "{\"debug\":true}",
        storageKey: "workspace/spc_default/internal/key",
        messageId: "msg_projection_allowlist",
        conversationId: conversation.id,
        message: {
          id: "msg_projection_allowlist",
          conversationId: conversation.id,
          authorId: "usr_owner",
          authorName: "timeStarry",
          authorGithubLogin: "timeStarry",
          authorKind: "human",
          kind: "user",
          clientMessageId: "projection-allowlist",
          plainText: "Allowed text",
          requestId: "message-request",
          content: {
            format: MESSAGE_CONTENT_FORMAT,
            plainText: "Allowed text",
            blocks: [{ type: "text", text: "Allowed text", storageKey: "block-storage" }]
          },
          attachments: [
            {
              id: "att_projection_allowlist",
              fileName: "visible.txt",
              mimeType: "text/plain",
              byteSize: 5,
              status: "available",
              visibility: "conversation",
              uploaderId: "usr_owner",
              uploaderName: "timeStarry",
              conversationId: conversation.id,
              storageKey: "attachment-storage",
              transferId: "attachment-transfer"
            }
          ],
          createdAt: "2026-01-01T00:00:00.000Z"
        },
        conversation: {
          ...conversation,
          requestId: "conversation-request",
          payloadJson: "{\"internal\":true}",
          members: [
            {
              id: "usr_owner",
              githubLogin: "timeStarry",
              email: "owner-internal@example.com",
              githubId: "provider-internal",
              displayName: "timeStarry",
              kind: "human",
              role: "owner",
              joinedAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        }
      }),
      "2026-01-01T00:00:00.000Z"
    );

    const event = (await listWorkspaceEvents(db, "usr_owner", seq - 1)).find((item) => item.id === "evt_projection_allowlist");
    expect(event.payload.message.plainText).toBe("Allowed text");
    expect(event.payload.message.attachments[0]).toMatchObject({
      id: "att_projection_allowlist",
      fileName: "visible.txt",
      status: "available"
    });
    expect(event.payload.conversation).toMatchObject({
      id: conversation.id,
      title: "Projection allowlist"
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("req-internal");
    expect(serialized).not.toContain("transfer-internal");
    expect(serialized).not.toContain("payloadJson");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("message-request");
    expect(serialized).not.toContain("block-storage");
    expect(serialized).not.toContain("attachment-storage");
    expect(serialized).not.toContain("attachment-transfer");
    expect(serialized).not.toContain("conversation-request");
    expect(serialized).not.toContain("owner-internal@example.com");
    expect(serialized).not.toContain("provider-internal");
  });

  it("keeps transfer rejection realtime events actor-local", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "TRANSFER-LOCAL" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "transfer-local",
      email: "transfer-local@example.com"
    });
    const first = await reserveUpload(db, request, {
      actorId: member.id,
      fileName: "quota-fill.bin",
      mimeType: "application/octet-stream",
      byteSize: DAILY_QUOTA_BYTES,
      visibility: "space"
    });
    expect(first.status).toBe("reserved");
    const rejected = await reserveUpload(db, request, {
      actorId: member.id,
      fileName: "quota-reject.bin",
      mimeType: "application/octet-stream",
      byteSize: 1,
      visibility: "space"
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.id).toBeUndefined();

    const memberEvents = await listWorkspaceEvents(db, member.id, 0);
    const ownerEvents = await listWorkspaceEvents(db, "usr_owner", 0);
    const rejectionEvent = memberEvents.find((event) => event.type === "transfer.rejected");
    expect(rejectionEvent).toMatchObject({
      actorId: member.id,
      targetType: "transfer",
      targetId: null,
      target: {
        type: "transfer",
        id: null
      },
      payload: {
        direction: "upload",
        code: "quota.insufficient",
        message: "今日传输额度不足",
        reason: "quota.insufficient"
      }
    });
    expect(rejectionEvent.payload.transferId).toBeUndefined();
    expect(ownerEvents.some((event) => event.type === "transfer.rejected")).toBe(false);
  });

  it("filters attachment realtime events by file visibility", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "ATTACHMENT-EVENTS" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "attachment-events",
      email: "attachment-events@example.com"
    });
    const privateUpload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "private-staging.txt",
      mimeType: "text/plain",
      byteSize: 32,
      visibility: "private_staging"
    });
    const spaceUpload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "space-visible.txt",
      mimeType: "text/plain",
      byteSize: 32,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: spaceUpload.id,
      storageVerifiedByteSize: 32
    });

    const memberEvents = await listWorkspaceEvents(db, member.id, 0);
    const ownerEvents = await listWorkspaceEvents(db, "usr_owner", 0);
    expect(ownerEvents.some((event) => event.type === "attachment.created" && event.targetId === privateUpload.attachment.id)).toBe(true);
    expect(memberEvents.some((event) => event.type === "attachment.created" && event.targetId === privateUpload.attachment.id)).toBe(false);
    expect(memberEvents.some((event) => event.type === "attachment.created" && event.targetId === spaceUpload.attachment.id)).toBe(false);
    const availableEvent = memberEvents.find((event) => event.type === "attachment.available" && event.targetId === spaceUpload.attachment.id);
    expect(availableEvent?.payload.attachment.storageKey).toBeUndefined();
    expect(availableEvent?.payload.transferId).toBeUndefined();
    expect(availableEvent?.payload.attachment.capabilities).toEqual({
      canDownload: true,
      canRemove: false
    });
    const ownerAvailableEvent = ownerEvents.find((event) => event.type === "attachment.available" && event.targetId === spaceUpload.attachment.id);
    expect(ownerAvailableEvent?.payload.attachment.capabilities).toEqual({
      canDownload: true,
      canRemove: true
    });
  });

  it("projects attachment realtime capabilities from the receiving member", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "ATTACHMENT-CAPABILITY-EVENTS" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "attachment-capability-events",
      email: "attachment-capability-events@example.com"
    });
    const upload = await reserveUpload(db, request, {
      actorId: member.id,
      fileName: "member-owned-space-file.txt",
      mimeType: "text/plain",
      byteSize: 32,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: member.id,
      uploadId: upload.id,
      storageVerifiedByteSize: 32
    });

    const memberEvent = (await listWorkspaceEvents(db, member.id, 0)).find((event) => event.type === "attachment.available" && event.targetId === upload.attachment.id);
    const ownerEvent = (await listWorkspaceEvents(db, "usr_owner", 0)).find((event) => event.type === "attachment.available" && event.targetId === upload.attachment.id);

    expect(memberEvent.payload.attachment.capabilities).toEqual({
      canDownload: true,
      canRemove: true
    });
    expect(ownerEvent.payload.attachment.capabilities).toEqual({
      canDownload: true,
      canRemove: true
    });
    expect(memberEvent.payload.attachment.uploader.displayName).toBe(member.displayName);
    expect(ownerEvent.payload.attachment.uploader.displayName).toBe(member.displayName);
    expect(JSON.stringify(ownerEvent)).not.toContain("attachment-capability-events@example.com");
  });

  it("projects message attachment capabilities from the receiving member", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "MESSAGE-ATTACHMENT-CAPS" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "message-attachment-caps",
      email: "message-attachment-caps@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Message attachment capabilities",
      memberIds: [member.id]
    });
    const upload = await reserveUpload(db, request, {
      actorId: member.id,
      conversationId: conversation.id,
      visibility: "conversation",
      fileName: "message-attachment-caps.txt",
      mimeType: "text/plain",
      byteSize: 32
    });
    await completeUpload(db, request, {
      actorId: member.id,
      uploadId: upload.id,
      storageVerifiedByteSize: 32
    });
    await createStructuredMessage(db, request, {
      actorId: member.id,
      conversationId: conversation.id,
      clientMessageId: "message-attachment-caps",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [
          { type: "text", text: "file " },
          { type: "attachment", attachmentId: upload.attachment.id }
        ]
      }
    });

    const memberMessage = (await listMessages(db, member.id, conversation.id)).find((message) => message.clientMessageId === "message-attachment-caps");
    const ownerMessage = (await listMessages(db, "usr_owner", conversation.id)).find((message) => message.clientMessageId === "message-attachment-caps");
    expect(memberMessage.attachments[0].capabilities).toEqual({
      canDownload: true,
      canRemove: true
    });
    expect(ownerMessage.attachments[0].capabilities).toEqual({
      canDownload: true,
      canRemove: true
    });

    const memberEvent = (await listWorkspaceEvents(db, member.id, 0)).find((event) => event.type === "message.created" && event.payload.message?.clientMessageId === "message-attachment-caps");
    const ownerEvent = (await listWorkspaceEvents(db, "usr_owner", 0)).find((event) => event.type === "message.created" && event.payload.message?.clientMessageId === "message-attachment-caps");
    expect(memberEvent.payload.message.attachments[0].capabilities.canRemove).toBe(true);
    expect(ownerEvent.payload.message.attachments[0].capabilities.canRemove).toBe(true);
    expect(memberEvent.payload.message.attachments[0].storageKey).toBeUndefined();
    expect(JSON.stringify(ownerEvent)).not.toContain("message-attachment-caps@example.com");
  });

  it("filters event visibility before applying the replay limit", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "EVENT-LIMIT" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "event-limit",
      email: "event-limit@example.com"
    });

    for (let index = 0; index < 205; index += 1) {
      await createConversation(db, request, {
        actorId: "usr_owner",
        type: "group",
        title: `Owner private ${index}`
      });
    }

    const visible = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Visible after hidden events",
      memberIds: [member.id]
    });

    const memberEvents = await listWorkspaceEvents(db, member.id, 0);
    expect(memberEvents.some((event) => event.type === "conversation.created" && event.targetId === visible.id)).toBe(true);
    expect(memberEvents.some((event) => event.payloadJson)).toBe(false);
    expect(memberEvents.hasMore).toBe(false);

    const ownerEvents = await listWorkspaceEvents(db, "usr_owner", 0);
    expect(ownerEvents).toHaveLength(200);
    expect(ownerEvents.hasMore).toBe(true);
  }, 15_000);

  it("writes group conversation creation before member-added events", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "EVENT-ORDER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "event-order",
      email: "event-order@example.com"
    });

    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Event order",
      memberIds: [member.id]
    });

    const eventTypes = db.prepare(`
      SELECT type
      FROM workspace_events
      WHERE conversation_id = ?
      ORDER BY seq ASC
    `).all(conversation.id).map((row) => row.type);

    expect(eventTypes.slice(0, 2)).toEqual(["conversation.created", "conversation.member_added"]);
  });

  it("does not expose operation records through bootstrap", async () => {
    const bootstrap = await getWorkspaceBootstrap(db, "usr_owner");
    expect(bootstrap.audits).toBeUndefined();
    expect(bootstrap.policy.operationRecords).toBeUndefined();
    expect(bootstrap.auth.githubOAuthReady).toBeUndefined();
    expect(bootstrap.permissions.canViewOperationRecords).toBe(false);
  });

  it("includes first-screen conversations and files in bootstrap without internal fields", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Bootstrap first screen"
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "bootstrap-file.txt",
      mimeType: "text/plain",
      byteSize: 128,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 128
    });

    const bootstrap = await getWorkspaceBootstrap(db, "usr_owner");
    expect(bootstrap.conversations.map((item) => item.id)).toContain(conversation.id);
    expect(bootstrap.files.map((item) => item.id)).toContain(upload.attachment.id);
    expect(JSON.stringify(bootstrap)).not.toContain("storageKey");
    expect(JSON.stringify(bootstrap)).not.toContain("uploadTransferId");
    expect(JSON.stringify(bootstrap)).not.toContain("transferId");
    expect(JSON.stringify(bootstrap)).not.toContain("audit_logs");
  });

  it("does not expose email or provider ids in member projections", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "PUBLIC-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubId: "public-provider-id",
      githubLogin: "public-member",
      email: "public-member@example.com",
      displayName: "Public Member"
    });

    const stored = db.prepare("SELECT github_id AS githubId, email FROM users WHERE id = ?").get(member.id);
    expect(stored).toEqual({ githubId: "public-provider-id", email: "public-member@example.com" });

    const bootstrapMember = (await getWorkspaceBootstrap(db, "usr_owner")).members.find((item) => item.id === member.id);
    expect(bootstrapMember.githubLogin).toBe("public-member");
    expect(bootstrapMember.email).toBeUndefined();
    expect(bootstrapMember.githubId).toBeUndefined();

    const memberBootstrap = await getWorkspaceBootstrap(db, member.id);
    expect(memberBootstrap.auth.currentUser.githubLogin).toBe("public-member");
    expect(memberBootstrap.auth.currentUser.email).toBeUndefined();
    expect(memberBootstrap.auth.currentUser.githubId).toBeUndefined();

    const listedMember = (await listMembers(db, "usr_owner", { q: "public" }))[0];
    expect(listedMember.githubLogin).toBe("public-member");
    expect(listedMember.email).toBeUndefined();
    expect(listedMember.githubId).toBeUndefined();
    expect(await listMembers(db, "usr_owner", { q: "public-member@example.com" })).toEqual([]);

    const event = (await listWorkspaceEvents(db, "usr_owner", 0)).find((item) => item.type === "workspace.member_joined" && item.targetId === member.id);
    expect(event.payload.member.email).toBeUndefined();
    expect(event.payload.member.githubId).toBeUndefined();
    expect(event.payload.member.capabilities.canStartDirectConversation).toBe(true);

    const selfEvent = (await listWorkspaceEvents(db, member.id, 0)).find((item) => item.type === "workspace.member_joined" && item.targetId === member.id);
    expect(selfEvent.payload.member.capabilities.canStartDirectConversation).toBe(false);
  });

  it("projects member realtime capabilities from the receiving member", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "MEMBER-CAPABILITY-EVENTS" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "member-capability-events",
      email: "member-capability-events@example.com",
      displayName: "Member Capability Events"
    });
    const auditorInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "auditor",
      code: "MEMBER-CAPABILITY-AUDITOR"
    });
    const auditor = await acceptInvite(db, request, {
      code: auditorInvite.code,
      githubLogin: "member-capability-auditor",
      email: "member-capability-auditor@example.com"
    });

    const ownerEvent = (await listWorkspaceEvents(db, "usr_owner", 0)).find((item) => item.type === "workspace.member_joined" && item.targetId === member.id);
    const memberEvent = (await listWorkspaceEvents(db, member.id, 0)).find((item) => item.type === "workspace.member_joined" && item.targetId === member.id);
    const auditorViewEvents = await listWorkspaceEvents(db, auditor.id, 0);

    expect(ownerEvent.payload.member.capabilities.canStartDirectConversation).toBe(true);
    expect(memberEvent.payload.member.capabilities.canStartDirectConversation).toBe(false);
    expect(auditorViewEvents.every((event) => event.payload.member?.capabilities?.canStartDirectConversation !== true)).toBe(true);
    expect(JSON.stringify(ownerEvent)).not.toContain("member-capability-events@example.com");
  });

  it("reports current user quota usage and remaining quota in bootstrap", async () => {
    const initial = await getWorkspaceBootstrap(db, "usr_owner");
    expect(initial.policy.dailyQuotaBytes).toBe(DAILY_QUOTA_BYTES);
    expect(initial.policy.usedTodayBytes).toBe(0);
    expect(initial.policy.remainingQuotaBytes).toBe(DAILY_QUOTA_BYTES);

    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      fileName: "quota.txt",
      mimeType: "text/plain",
      byteSize: 4096,
      visibility: "space"
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 4096
    });

    const afterUpload = await getWorkspaceBootstrap(db, "usr_owner");
    expect(afterUpload.policy.usedTodayBytes).toBe(4096);
    expect(afterUpload.policy.remainingQuotaBytes).toBe(DAILY_QUOTA_BYTES - 4096);
  });

  it("returns only joined conversations", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "JOINED" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "joined-member",
      email: "joined@example.com"
    });

    const ownerOnly = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Owner only"
    });
    const direct = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });

    const conversations = await listConversations(db, member.id);
    expect(conversations.map((conversation) => conversation.id)).toContain(direct.id);
    expect(conversations.map((conversation) => conversation.id)).not.toContain(ownerOnly.id);
  });

  it("prevents reserved auditors from joining conversations or reading message events", async () => {
    const auditorInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "auditor",
      code: "AUDITOR-NO-CHAT"
    });
    const auditor = await acceptInvite(db, request, {
      code: auditorInvite.code,
      githubLogin: "auditor-no-chat",
      email: "auditor-no-chat@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Auditor hidden group"
    });
    await expect(async () =>
      await addConversationMember(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        userId: auditor.id
      })
    ).rejects.toThrow(WorkspaceValidationError);
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "auditor-hidden-message",
      content: textContent("Auditor must not see this")
    });

    await expect(async () => await listConversations(db, auditor.id, request)).rejects.toThrow(WorkspacePermissionError);
    await expect(async () => await getConversationDetails(db, auditor.id, conversation.id, request)).rejects.toThrow(WorkspacePermissionError);
    await expect(async () => await listMessages(db, auditor.id, conversation.id, { request })).rejects.toThrow(WorkspacePermissionError);
    await expect(async () =>
      await markConversationRead(db, request, {
        actorId: auditor.id,
        conversationId: conversation.id
      })
    ).rejects.toThrow(WorkspacePermissionError);

    const events = await listWorkspaceEvents(db, auditor.id, 0);
    expect(events.some((event) => event.type === "message.created")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("Auditor must not see this");

    const addAudit = db.prepare(`
      SELECT action, target_type AS targetType, target_id AS targetId, result, reason
      FROM audit_logs
      WHERE actor_user_id = ?
        AND action = 'conversation.member_add'
      ORDER BY rowid DESC
      LIMIT 1
    `).get("usr_owner");
    expect(addAudit).toEqual({
      action: "conversation.member_add",
      targetType: "conversation",
      targetId: conversation.id,
      result: "rejected",
      reason: "member.not_chat_participant"
    });

    const audit = db.prepare(`
      SELECT action, target_type AS targetType, target_id AS targetId, result, reason
      FROM audit_logs
      WHERE actor_user_id = ?
        AND action = 'conversation.read'
      ORDER BY rowid DESC
      LIMIT 1
    `).get(auditor.id);
    expect(audit).toEqual({
      action: "conversation.read",
      targetType: "conversation",
      targetId: conversation.id,
      result: "rejected",
      reason: "insufficient permission"
    });
  });

  it("lists and filters visible space members", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "MEMBER-LIST" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "filter-member",
      email: "filter@example.com",
      displayName: "Filter Member"
    });

    const members = await listMembers(db, "usr_owner");
    expect(members.map((item) => item.id)).toContain(member.id);
    expect(members.find((item) => item.id === member.id)).toMatchObject({
      roleLabel: "成员",
      capabilities: {
        canStartDirectConversation: true
      }
    });
    expect(members.find((item) => item.id === "usr_owner")?.capabilities.canStartDirectConversation).toBe(false);

    const filtered = await listMembers(db, "usr_owner", { query: "filter" });
    expect(filtered.map((item) => item.githubLogin)).toEqual(["filter-member"]);

    await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    const memberView = await listMembers(db, member.id);
    expect(memberView.find((item) => item.id === "usr_owner")?.capabilities.canStartDirectConversation).toBe(true);

    const auditorInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "auditor",
      code: "MEMBER-LIST-AUDITOR"
    });
    const auditor = await acceptInvite(db, request, {
      code: auditorInvite.code,
      githubLogin: "member-list-auditor",
      email: "member-list-auditor@example.com"
    });
    const auditorView = await listMembers(db, auditor.id);
    expect(auditorView.every((item) => item.capabilities.canStartDirectConversation === false)).toBe(true);
  });

  it("hides reserved operation-review roles from normal member projections", async () => {
    const memberInvite = await createInvite(db, request, { actorId: "usr_owner", code: "MEMBER-ROLE-PROJECTION" });
    const member = await acceptInvite(db, request, {
      code: memberInvite.code,
      githubLogin: "member-role-projection",
      email: "member-role-projection@example.com"
    });
    const auditorInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "auditor",
      code: "AUDITOR-ROLE-PROJECTION"
    });
    const auditor = await acceptInvite(db, request, {
      code: auditorInvite.code,
      githubLogin: "reserved-role-projection",
      email: "reserved-role-projection@example.com"
    });

    await updateManagedMemberVisibility(db, request, {
      actorId: "usr_owner",
      userId: member.id,
      visibleUserIds: [auditor.id]
    });

    const ownerView = (await listMembers(db, "usr_owner")).find((item) => item.id === auditor.id);
    expect(ownerView).toMatchObject({
      role: "auditor",
      roleLabel: "预留角色"
    });

    const memberView = (await listMembers(db, member.id)).find((item) => item.id === auditor.id);
    expect(memberView).toMatchObject({
      role: "member",
      roleLabel: "成员",
      capabilities: {
        canStartDirectConversation: false
      }
    });

    const memberBootstrap = await getWorkspaceBootstrap(db, member.id);
    expect(memberBootstrap.members.find((item) => item.id === auditor.id)).toMatchObject({
      role: "member",
      roleLabel: "成员"
    });
    expect(JSON.stringify(memberBootstrap)).not.toContain("auditor");
    expect(JSON.stringify(memberBootstrap)).not.toContain("记录查看员");
    expect(JSON.stringify(memberBootstrap)).not.toContain("预留角色");

    const ownerEvent = (await listWorkspaceEvents(db, "usr_owner", 0)).find((item) => item.type === "workspace.member_joined" && item.targetId === auditor.id);
    const memberEvent = (await listWorkspaceEvents(db, member.id, 0)).find((item) => item.type === "workspace.member_joined" && item.targetId === auditor.id);
    expect(ownerEvent.payload.role).toBe("auditor");
    expect(ownerEvent.payload.member.roleLabel).toBe("预留角色");
    expect(memberEvent.payload.role).toBe("member");
    expect(memberEvent.payload.member.roleLabel).toBe("成员");
  });

  it("rejects direct conversations with reserved operation-review members", async () => {
    const auditorInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "auditor",
      code: "AUDITOR-DIRECT-TARGET"
    });
    const auditor = await acceptInvite(db, request, {
      code: auditorInvite.code,
      githubLogin: "auditor-direct-target",
      email: "auditor-direct-target@example.com"
    });

    await expect(async () =>
      await createWorkspaceConversation(db, request, {
        actorId: "usr_owner",
        type: "direct",
        targetUserId: auditor.id
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.create' AND actor_user_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get("usr_owner");
    expect(audit).toEqual({ result: "rejected", reason: "invalid target" });
  });

  it("rejects reserved operation-review members as group chat participants", async () => {
    const auditorInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "auditor",
      code: "AUDITOR-GROUP-TARGET"
    });
    const auditor = await acceptInvite(db, request, {
      code: auditorInvite.code,
      githubLogin: "auditor-group-target",
      email: "auditor-group-target@example.com"
    });

    await expect(async () =>
      await createWorkspaceConversation(db, request, {
        actorId: "usr_owner",
        type: "group",
        title: "Invalid reserved member group",
        memberIds: [auditor.id]
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Valid managed group"
    });

    await expect(async () =>
      await addConversationMember(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        userId: auditor.id
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const membership = db.prepare(`
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
    `).get(conversation.id, auditor.id);
    expect(membership).toBeUndefined();

    const createAudit = db.prepare(`
      SELECT action, result, reason
      FROM audit_logs
      WHERE actor_user_id = 'usr_owner'
        AND action = 'conversation.create'
        AND target_id = 'new'
        AND result = 'rejected'
      ORDER BY rowid DESC
      LIMIT 1
    `).get();
    expect(createAudit).toEqual({
      action: "conversation.create",
      result: "rejected",
      reason: "member.not_chat_participant"
    });

    const addAudit = db.prepare(`
      SELECT action, result, reason
      FROM audit_logs
      WHERE actor_user_id = 'usr_owner'
        AND action = 'conversation.member_add'
        AND target_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(conversation.id);
    expect(addAudit).toEqual({
      action: "conversation.member_add",
      result: "rejected",
      reason: "member.not_chat_participant"
    });
  });

  it("lets owner or admin add and remove group members", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "GROUP-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "group-member",
      email: "group-member@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Managed group"
    });

    const afterAdd = await addConversationMember(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      userId: member.id
    });
    expect(afterAdd.members.map((item) => item.id)).toContain(member.id);

    const afterRemove = await removeConversationMember(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      userId: member.id
    });
    expect(afterRemove.members.map((item) => item.id)).not.toContain(member.id);

    const eventTypes = db.prepare(`
      SELECT type
      FROM workspace_events
      WHERE conversation_id = ?
      ORDER BY seq ASC
    `).all(conversation.id).map((row) => row.type);
    expect(eventTypes).toContain("conversation.member_added");
    expect(eventTypes).toContain("conversation.member_removed");
  });

  it("blocks group member additions outside the actor contact scope", async () => {
    const adminInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      defaultRole: "admin",
      code: "GROUP-HIDDEN-ADMIN"
    });
    const admin = await acceptInvite(db, request, {
      code: adminInvite.code,
      githubLogin: "group-hidden-admin",
      email: "group-hidden-admin@example.com"
    });
    const hiddenInvite = await createInvite(db, request, {
      actorId: "usr_owner",
      code: "GROUP-HIDDEN-TARGET"
    });
    const hiddenMember = await acceptInvite(db, request, {
      code: hiddenInvite.code,
      githubLogin: "group-hidden-target",
      email: "group-hidden-target@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Contact-scoped group",
      memberIds: [admin.id]
    });

    await expect(async () =>
      await addConversationMember(db, request, {
        actorId: admin.id,
        conversationId: conversation.id,
        userId: hiddenMember.id
      })
    ).rejects.toMatchObject({ code: "member.not_visible" });

    const rejection = db.prepare(
      "SELECT result, reason FROM audit_logs WHERE actor_user_id = ? AND action = 'conversation.member_add' ORDER BY created_at DESC LIMIT 1"
    ).get(admin.id);
    expect(rejection).toEqual({ result: "rejected", reason: "member.not_visible" });

    await updateManagedMemberVisibility(db, request, {
      actorId: "usr_owner",
      userId: admin.id,
      visibleUserIds: [hiddenMember.id]
    });
    const updated = await addConversationMember(db, request, {
      actorId: admin.id,
      conversationId: conversation.id,
      userId: hiddenMember.id
    });
    expect(updated.members.map((member) => member.id)).toContain(hiddenMember.id);
  });

  it("does not emit duplicate member-added events for active group members", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "GROUP-MEMBER-IDEMPOTENT" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "group-member-idempotent",
      email: "group-member-idempotent@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Idempotent member add"
    });

    await addConversationMember(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      userId: member.id
    });
    await addConversationMember(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      userId: member.id
    });

    const addedEvents = db.prepare(`
      SELECT COUNT(*) AS count
      FROM workspace_events
      WHERE conversation_id = ?
        AND type = 'conversation.member_added'
        AND target_id = ?
    `).get(conversation.id, member.id);
    expect(addedEvents.count).toBe(1);
  });

  it("rolls back group member additions when audit persistence fails", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "GROUP-ADD-TXN" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "group-add-txn",
      email: "group-add-txn@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Transactional add"
    });

    db.exec(`
      CREATE TRIGGER fail_group_member_add_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'conversation.member_add' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'group member add audit failed');
      END
    `);
    try {
      await expect(async () =>
        await addConversationMember(db, request, {
          actorId: "usr_owner",
          conversationId: conversation.id,
          userId: member.id
        })
      ).rejects.toThrow(/group member add audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_group_member_add_audit");
    }

    const membership = db.prepare(`
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
    `).get(conversation.id, member.id);
    expect(membership).toBeUndefined();
    const event = db.prepare(`
      SELECT 1
      FROM workspace_events
      WHERE conversation_id = ?
        AND type = 'conversation.member_added'
        AND target_id = ?
    `).get(conversation.id, member.id);
    expect(event).toBeUndefined();
  });

  it("records rejected group member additions when the target member is unavailable", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Missing add target"
    });

    await expect(async () =>
      await addConversationMember(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        userId: "missing-member"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const membership = db.prepare(`
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = ? AND user_id = ?
    `).get(conversation.id, "missing-member");
    expect(membership).toBeUndefined();
    const event = db.prepare(`
      SELECT 1
      FROM workspace_events
      WHERE conversation_id = ?
        AND type = 'conversation.member_added'
        AND target_id = ?
    `).get(conversation.id, "missing-member");
    expect(event).toBeUndefined();
    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.member_add' AND target_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(conversation.id);
    expect(audit).toEqual({ result: "rejected", reason: "member.not_found" });
  });

  it("records rejected group member removal after permission checks", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "GROUP-REJECT-AUDIT" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "group-reject-audit",
      email: "group-reject-audit@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Rejected member management",
      memberIds: [member.id]
    });

    await expect(async () =>
      await removeConversationMember(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        userId: "usr_owner"
      })
    ).rejects.toThrow(WorkspaceValidationError);

    let audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.member_remove' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversation.id);
    expect(audit).toEqual({ result: "rejected", reason: "self removal" });

    await removeConversationMember(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      userId: member.id
    });

    await expect(async () =>
      await removeConversationMember(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        userId: member.id
      })
    ).rejects.toThrow(WorkspaceValidationError);

    audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.member_remove' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversation.id);
    expect(audit).toEqual({ result: "rejected", reason: "member not in conversation" });
  });

  it("rolls back group member removals when audit persistence fails", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "GROUP-REMOVE-TXN" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "group-remove-txn",
      email: "group-remove-txn@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Transactional remove",
      memberIds: [member.id]
    });

    db.exec(`
      CREATE TRIGGER fail_group_member_remove_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'conversation.member_remove' AND NEW.result = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'group member remove audit failed');
      END
    `);
    try {
      await expect(async () =>
        await removeConversationMember(db, request, {
          actorId: "usr_owner",
          conversationId: conversation.id,
          userId: member.id
        })
      ).rejects.toThrow(/group member remove audit failed/);
    } finally {
      db.exec("DROP TRIGGER fail_group_member_remove_audit");
    }

    const membership = db.prepare(`
      SELECT removed_at AS removedAt
      FROM conversation_members
      WHERE conversation_id = ? AND user_id = ?
    `).get(conversation.id, member.id);
    expect(membership.removedAt).toBeNull();
    const event = db.prepare(`
      SELECT 1
      FROM workspace_events
      WHERE conversation_id = ?
        AND type = 'conversation.member_removed'
        AND target_id = ?
    `).get(conversation.id, member.id);
    expect(event).toBeUndefined();
  });

  it("removes group file visibility and future conversation events after member removal", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "GROUP-FILE-ACCESS" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "group-file-member",
      email: "group-file-member@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Scoped group files",
      memberIds: [member.id]
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      visibility: "conversation",
      fileName: "group-file.txt",
      mimeType: "text/plain",
      byteSize: 64
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 64
    });
    expect((await listFiles(db, member.id)).map((file) => file.id)).toContain(upload.attachment.id);

    const beforeRemovalSeq = db.prepare("SELECT MAX(seq) AS seq FROM workspace_events").get().seq;
    await removeConversationMember(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      userId: member.id
    });
    await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "after-removal",
      content: textContent("After removal")
    });

    expect((await listConversations(db, member.id)).map((item) => item.id)).not.toContain(conversation.id);
    expect((await listFiles(db, member.id)).map((file) => file.id)).not.toContain(upload.attachment.id);
    await expect(async () =>
      await reserveDownload(db, request, {
        actorId: member.id,
        attachmentId: upload.attachment.id
      })
    ).rejects.toThrow(WorkspacePermissionError);

    const events = await listWorkspaceEvents(db, member.id, beforeRemovalSeq);
    expect(events.some((event) => event.type === "conversation.member_removed" && event.targetId === member.id)).toBe(true);
    expect(events.some((event) => event.type === "message.created" && event.payload.message?.clientMessageId === "after-removal")).toBe(false);
  });

  it("lets a member leave a group conversation", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "LEAVE-GROUP" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "leave-member",
      email: "leave-member@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Leaveable group",
      memberIds: [member.id]
    });

    const result = await leaveConversation(db, request, {
      actorId: member.id,
      conversationId: conversation.id
    });
    expect(result).toEqual({ ok: true, conversationId: conversation.id });
    expect((await listConversations(db, member.id)).map((item) => item.id)).not.toContain(conversation.id);

    const event = db.prepare(`
      SELECT type, target_id AS targetId
      FROM workspace_events
      WHERE conversation_id = ? AND type = 'conversation.member_removed'
      ORDER BY seq DESC
      LIMIT 1
    `).get(conversation.id);
    expect(event).toEqual({ type: "conversation.member_removed", targetId: member.id });

    const audit = db.prepare("SELECT result FROM audit_logs WHERE action = 'conversation.leave' AND actor_user_id = ?").get(member.id);
    expect(audit.result).toBe("success");
  });

  it("rejects leaving a group when the actor is the last member", async () => {
    const now = new Date().toISOString();
    const conversationId = "conv_last_member_fixture";
    db.prepare(`
      INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'group', 'Last member group', NULL, 10000, 'usr_owner', ?)
    `).run(conversationId, DEFAULT_SPACE_ID, now);
    db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
      VALUES (?, 'usr_owner', ?, NULL)
    `).run(conversationId, now);

    await expect(async () =>
      await leaveConversation(db, request, {
        actorId: "usr_owner",
        conversationId
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.leave' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversationId);
    expect(audit).toEqual({ result: "rejected", reason: "last member" });
  });

  it("lets owner or admin rename group conversations and records the change", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Old group name"
    });

    const renamed = await updateGroupConversation(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      title: "New group name"
    });
    expect(renamed.title).toBe("New group name");

    const event = db.prepare(`
      SELECT type, payload_json AS payloadJson
      FROM workspace_events
      WHERE conversation_id = ? AND type = 'conversation.updated'
      ORDER BY seq DESC
      LIMIT 1
    `).get(conversation.id);
    expect(event.type).toBe("conversation.updated");
    expect(JSON.parse(event.payloadJson).title).toBe("New group name");

    const audit = db.prepare("SELECT result FROM audit_logs WHERE action = 'conversation.update' AND target_id = ?").get(conversation.id);
    expect(audit.result).toBe("success");
  });

  it("records rejected group rename validation after permission checks", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Rename validation"
    });

    await expect(async () =>
      await updateGroupConversation(db, request, {
        actorId: "usr_owner",
        conversationId: conversation.id,
        title: ""
      })
    ).rejects.toThrow(WorkspaceValidationError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE action = 'conversation.update' AND target_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversation.id);
    expect(audit).toEqual({ result: "rejected", reason: "invalid title" });
  });

  it("rejects normal member group management and records the rejection", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "NO-GROUP-MANAGE" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "normal-member",
      email: "normal-member@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Owner managed"
    });

    await expect(async () =>
      await addConversationMember(db, request, {
        actorId: member.id,
        conversationId: conversation.id,
        userId: member.id
      })
    ).rejects.toThrow(WorkspacePermissionError);

    const audit = db.prepare(`
      SELECT result, reason
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'conversation.member.manage'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(member.id);
    expect(audit).toEqual({ result: "rejected", reason: "insufficient permission" });

    await expect(async () =>
      await updateGroupConversation(db, request, {
        actorId: member.id,
        conversationId: conversation.id,
        title: "Not allowed"
      })
    ).rejects.toThrow(WorkspacePermissionError);
  });
  it("persists raw Workspace Markdown while projecting clean summaries", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Markdown summaries"
    });
    const markdown = "**粗体** 与 [链接](https://example.test)\n\n- 第一项\n- 第二项";
    const message = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "markdown-summary",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        plainText: "客户端摘要不会被信任",
        blocks: [{ type: "text", text: markdown }]
      }
    });

    expect(message.content.blocks).toEqual([{ type: "text", text: markdown }]);
    expect(message.plainText).toBe("粗体 与 链接\n第一项\n第二项");

    const stored = db.prepare("SELECT content_json AS contentJson, plain_text AS plainText FROM messages WHERE id = ?").get(message.id);
    expect(JSON.parse(stored.contentJson).blocks[0].text).toBe(markdown);
    expect(stored.plainText).toBe(message.plainText);

    const codeMarkdown = "~~~python\nimport stdio\nmain() {}\n~~~";
    const codeMessage = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "markdown-code-only",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [{ type: "text", text: codeMarkdown }]
      }
    });
    expect(codeMessage.content.blocks).toEqual([{ type: "text", text: codeMarkdown }]);
    expect(codeMessage.plainText).toBe("import stdio\nmain() {}");

    const incompleteLink = "[链接文本](https://)";
    const incompleteLinkMessage = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "markdown-incomplete-link",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [{ type: "text", text: incompleteLink }]
      }
    });
    expect(incompleteLinkMessage.content.blocks).toEqual([{ type: "text", text: incompleteLink }]);
    expect(incompleteLinkMessage.plainText).toBe("链接文本");

    const literalUrlText = "访问 https://example.test/files?id=42 查看文件";
    const literalUrlMessage = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "markdown-literal-url",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [{ type: "text", text: literalUrlText }]
      }
    });
    expect(literalUrlMessage.content.blocks).toEqual([{ type: "text", text: literalUrlText }]);
    expect(literalUrlMessage.plainText).toBe(literalUrlText);

    const legacyContent = JSON.parse(stored.contentJson);
    legacyContent.plainText = markdown;
    db.prepare("UPDATE messages SET content_json = ?, plain_text = ? WHERE id = ?")
      .run(JSON.stringify(legacyContent), markdown, message.id);

    const projected = (await listMessages(db, "usr_owner", conversation.id))
      .find((item) => item.id === message.id);
    expect(projected.content.blocks[0].text).toBe(markdown);
    expect(projected.content.plainText).toBe("粗体 与 链接\n第一项\n第二项");
    expect(projected.plainText).toBe(projected.content.plainText);
  });

  it("stores one emoji grapheme as the group avatar and allows restoring the default", async () => {
    expect(normalizeGroupAvatarEmoji(" 👩🏽‍💻 ")).toBe("👩🏽‍💻");
    expect(normalizeGroupAvatarEmoji("🇨🇳")).toBe("🇨🇳");
    expect(() => normalizeGroupAvatarEmoji("not emoji")).toThrow(WorkspaceValidationError);
    expect(() => normalizeGroupAvatarEmoji("😀🚀")).toThrow(WorkspaceValidationError);

    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Avatar group",
      avatarEmoji: "🧭"
    });
    expect(conversation.avatarEmoji).toBe("🧭");

    const updated = await updateGroupConversation(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      avatarEmoji: "👩🏽‍💻"
    });
    expect(updated.title).toBe("Avatar group");
    expect(updated.avatarEmoji).toBe("👩🏽‍💻");

    const restored = await updateGroupConversation(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      avatarEmoji: null
    });
    expect(restored.avatarEmoji).toBeNull();
  });

  it("pins only an author's group messages with an atomic per-user limit and retention exemption", async () => {
    const memberInvite = await createInvite(db, request, { actorId: "usr_owner", code: "PIN-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: memberInvite.code,
      githubLogin: "pin-member",
      displayName: "Pin Member"
    });
    const group = await createWorkspaceConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Pinned messages",
      memberIds: [member.id]
    });
    const messages = [];
    for (let index = 0; index < 4; index += 1) {
      messages.push(await createStructuredMessage(db, request, {
        actorId: "usr_owner",
        conversationId: group.id,
        clientMessageId: `pin-owner-${index}`,
        content: textContent(`owner message ${index}`)
      }));
    }

    let before = (await listConversations(db, "usr_owner")).find((item) => item.id === group.id);
    const firstPin = await pinGroupMessage(db, request, {
      actorId: "usr_owner",
      conversationId: group.id,
      messageId: messages[1].id
    });
    expect(firstPin).toMatchObject({ messageId: messages[1].id, canUnpin: true });
    const memberPinEvent = (await listWorkspaceEvents(db, member.id, 0))
      .findLast((event) => event.type === "message.pinned" && event.targetId === messages[1].id);
    expect(memberPinEvent?.payload).toEqual({
      messageId: messages[1].id,
      conversationId: group.id
    });
    expect((await pinGroupMessage(db, request, {
      actorId: "usr_owner",
      conversationId: group.id,
      messageId: messages[1].id
    })).messageId).toBe(messages[1].id);
    await pinGroupMessage(db, request, { actorId: "usr_owner", conversationId: group.id, messageId: messages[2].id });
    await pinGroupMessage(db, request, { actorId: "usr_owner", conversationId: group.id, messageId: messages[3].id });
    db.prepare("UPDATE conversations SET retention_count = 2 WHERE id = ?").run(group.id);
    const fourth = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: group.id,
      clientMessageId: "pin-owner-fourth",
      content: textContent("owner fourth pin")
    });
    await expect(pinGroupMessage(db, request, {
      actorId: "usr_owner",
      conversationId: group.id,
      messageId: fourth.id
    })).rejects.toMatchObject({ code: "pin.limit_reached" });
    await expect(pinGroupMessage(db, request, {
      actorId: member.id,
      conversationId: group.id,
      messageId: messages[2].id
    })).rejects.toMatchObject({ code: "pin.not_author" });

    const memberMessage = await createStructuredMessage(db, request, {
      actorId: member.id,
      conversationId: group.id,
      clientMessageId: "pin-member-own",
      content: textContent("member pinned")
    });
    before = (await listConversations(db, "usr_owner")).find((item) => item.id === group.id);
    await pinGroupMessage(db, request, { actorId: member.id, conversationId: group.id, messageId: memberMessage.id });
    expect((await listPinnedMessages(db, member.id, group.id)).find((pin) => pin.messageId === memberMessage.id)?.canUnpin).toBe(true);
    expect((await listPinnedMessages(db, "usr_owner", group.id)).find((pin) => pin.messageId === memberMessage.id)?.canUnpin).toBe(true);
    await unpinGroupMessage(db, request, { actorId: "usr_owner", conversationId: group.id, messageId: memberMessage.id });
    const memberUnpinEvent = (await listWorkspaceEvents(db, member.id, 0))
      .findLast((event) => event.type === "message.unpinned" && event.targetId === memberMessage.id);
    expect(memberUnpinEvent?.payload).toEqual({
      messageId: memberMessage.id,
      conversationId: group.id
    });

    const after = (await listConversations(db, "usr_owner")).find((item) => item.id === group.id);
    expect(after.unreadCount).toBe(before.unreadCount);
    expect(after.lastActivityAt).toBe(memberMessage.createdAt);
    expect(db.prepare("SELECT deleted_at AS deletedAt FROM messages WHERE id = ?").get(messages[1].id).deletedAt).toBeNull();
    const around = await listMessages(db, "usr_owner", group.id, { around: messages[2].id, limit: 3 });
    expect(around.map((message) => message.id)).toContain(messages[2].id);
    expect(around.find((message) => message.id === messages[2].id)?.pin).toBeTruthy();
    expect(db.prepare("SELECT payload_json AS payload FROM workspace_events WHERE type = 'message.pinned' LIMIT 1").get().payload)
      .not.toContain("owner message");
  });

  it("recalls only the author's message without leaking content or deleting file-library attachments", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "RECALL-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "recall-member",
      displayName: "Recall Member"
    });
    const group = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Recall group",
      memberIds: [member.id]
    });
    const upload = await reserveUpload(db, request, {
      actorId: "usr_owner",
      conversationId: group.id,
      visibility: "conversation",
      fileName: "kept-after-recall.txt",
      mimeType: "text/plain",
      byteSize: 12
    });
    await completeUpload(db, request, {
      actorId: "usr_owner",
      uploadId: upload.id,
      storageVerifiedByteSize: 12
    });
    const message = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: group.id,
      clientMessageId: "recall-secret-message",
      content: {
        format: MESSAGE_CONTENT_FORMAT,
        blocks: [
          { type: "text", text: "secret recall body" },
          { type: "attachment", attachmentId: upload.attachment.id }
        ]
      }
    });
    await pinGroupMessage(db, request, {
      actorId: "usr_owner",
      conversationId: group.id,
      messageId: message.id
    });
    await addMessageReaction(db, request, {
      actorId: member.id,
      messageId: message.id,
      emoteKey: "feishu:ok"
    });
    await updateOwnProfile(db, request, { actorId: "usr_owner", recallReason: "重新组织内容" });

    await expect(recallMessage(db, request, { actorId: member.id, messageId: message.id }))
      .rejects.toMatchObject({ code: "permission.denied" });
    const recalled = await recallMessage(db, request, { actorId: "usr_owner", messageId: message.id });

    expect(recalled).toMatchObject({
      id: message.id,
      plainText: "timeStarry因重新组织内容撤回了一条消息",
      recalledAt: expect.any(String),
      recallReason: "重新组织内容",
      replyToMessageId: null,
      attachments: [],
      reactions: []
    });
    expect(recalled.content.blocks).toEqual([]);
    expect(recalled.pin).toBeUndefined();
    const stored = db.prepare(`
      SELECT content_json AS contentJson, plain_text AS plainText, recalled_at AS recalledAt
      FROM messages WHERE id = ?
    `).get(message.id);
    expect(stored.contentJson).not.toContain("secret recall body");
    expect(stored.plainText).not.toContain("secret recall body");
    expect(stored.recalledAt).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS count FROM message_attachments WHERE message_id = ?").get(message.id).count).toBe(1);
    expect((await listFiles(db, member.id)).map((file) => file.id)).toContain(upload.attachment.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?").get(message.id).count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_pinned_messages WHERE message_id = ?").get(message.id).count).toBe(0);
    expect(db.prepare(`
      SELECT pin_count AS pinCount FROM conversation_pin_counters
      WHERE conversation_id = ? AND user_id = ?
    `).get(group.id, "usr_owner").pinCount).toBe(0);

    const memberProjection = (await listMessages(db, member.id, group.id)).find((item) => item.id === message.id);
    expect(memberProjection.plainText).toBe("timeStarry因重新组织内容撤回了一条消息");
    const event = (await listWorkspaceEvents(db, member.id, 0))
      .findLast((item) => item.type === "message.recalled" && item.targetId === message.id);
    expect(event.payload.message).toMatchObject({ id: message.id, recalledAt: expect.any(String) });
    expect(JSON.stringify(event)).not.toContain("secret recall body");

    await recallMessage(db, request, { actorId: "usr_owner", messageId: message.id });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events WHERE type = 'message.recalled' AND target_id = ?").get(message.id).count)
      .toBe(1);
  });

  it("rejects oversized structured text before persistence", async () => {
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Long message limit"
    });
    await expect(createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "too-long-message",
      content: textContent("字".repeat(30_001))
    })).rejects.toMatchObject({ code: "message.too_long" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE client_message_id = ?").get("too-long-message").count).toBe(0);
  });

  it("hides messages only for the current member and restores them idempotently", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "HIDDEN-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "hidden-member",
      email: "hidden-member@example.com",
      displayName: "Hidden Member",
      avatarUrl: "https://avatars.githubusercontent.com/u/8181?v=4"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    const message = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "private-hidden-state",
      content: textContent("Only the viewer may hide this")
    });
    const visibleMessage = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "visible-before-private-hidden-state",
      content: textContent("Visible conversation preview")
    });
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), visibleMessage.id);
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?")
      .run(new Date().toISOString(), message.id);
    const before = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count;

    const first = await hideMessage(db, request, { actorId: member.id, messageId: message.id });
    const duplicate = await hideMessage(db, request, { actorId: member.id, messageId: message.id });
    expect(first).toEqual({ messageId: message.id, hidden: true, changed: true });
    expect(duplicate).toEqual({ messageId: message.id, hidden: true, changed: false });
    expect((await listMessages(db, member.id, conversation.id)).find((item) => item.id === message.id)?.hiddenByCurrentUser).toBe(true);
    expect((await listMessages(db, "usr_owner", conversation.id)).find((item) => item.id === message.id)?.hiddenByCurrentUser).toBe(false);
    const hiddenConversation = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);
    expect(hiddenConversation.lastMessagePlainText).toBe("Visible conversation preview");
    expect(hiddenConversation.lastMessageAt).toBeTruthy();
    expect(hiddenConversation.latestMessages.find((item) => item.id === message.id)?.hiddenByCurrentUser).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM message_hidden_states WHERE message_id = ?").get(message.id).count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events").get().count).toBe(eventCount);

    const restored = await unhideMessage(db, request, { actorId: member.id, messageId: message.id });
    const duplicateRestore = await unhideMessage(db, request, { actorId: member.id, messageId: message.id });
    expect(restored).toEqual({ messageId: message.id, hidden: false, changed: true });
    expect(duplicateRestore).toEqual({ messageId: message.id, hidden: false, changed: false });
    expect((await listMessages(db, member.id, conversation.id)).find((item) => item.id === message.id)?.hiddenByCurrentUser).toBe(false);

    const after = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);
    expect({
      lastActivityAt: after.lastActivityAt,
      messageCount: after.messageCount,
      unreadCount: after.unreadCount
    }).toEqual({
      lastActivityAt: before.lastActivityAt,
      messageCount: before.messageCount,
      unreadCount: before.unreadCount
    });
  });

  it("adds, aggregates and removes reactions idempotently without changing conversation counters", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "REACTION-MEMBER" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "reaction-member",
      email: "reaction-member@example.com",
      displayName: "Reaction Member",
      avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    const message = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "reaction-message",
      content: textContent("React to this")
    });
    const before = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);

    const first = await addMessageReaction(db, request, {
      actorId: member.id,
      messageId: message.id,
      emoteKey: "feishu:ok"
    });
    expect(first.created).toBe(true);
    expect(first.reactions).toEqual([{
      emoteKey: "feishu:ok",
      count: 1,
      reactedByCurrentUser: true,
      users: [{
        id: member.id,
        displayName: "Reaction Member",
        githubLogin: "reaction-member",
        avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4",
        createdAt: expect.any(String)
      }]
    }]);

    const duplicate = await addMessageReaction(db, request, {
      actorId: member.id,
      messageId: message.id,
      emoteKey: "feishu:ok"
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.reactions).toEqual(first.reactions);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events WHERE type = 'reaction.added' AND target_id = ?").get(message.id).count)
      .toBe(1);

    await addMessageReaction(db, request, {
      actorId: "usr_owner",
      messageId: message.id,
      emoteKey: "feishu:ok"
    });
    const memberProjection = (await listMessages(db, member.id, conversation.id))
      .find((item) => item.id === message.id);
    expect(memberProjection.reactions[0]).toMatchObject({
      emoteKey: "feishu:ok",
      count: 2,
      reactedByCurrentUser: true
    });
    expect(memberProjection.reactions[0].users.map((user) => user.id))
      .toEqual([member.id, "usr_owner"]);

    const reactionEvent = (await listWorkspaceEvents(db, member.id, 0))
      .findLast((event) => event.type === "reaction.added" && event.targetId === message.id);
    expect(reactionEvent.payload).toMatchObject({
      messageId: message.id,
      conversationId: conversation.id,
      reactions: [{
        emoteKey: "feishu:ok",
        count: 2
      }]
    });

    const removed = await removeMessageReaction(db, request, {
      actorId: member.id,
      messageId: message.id,
      emoteKey: "feishu:ok"
    });
    expect(removed.removed).toBe(true);
    expect(removed.reactions[0]).toMatchObject({
      count: 1,
      reactedByCurrentUser: false
    });
    const duplicateRemoval = await removeMessageReaction(db, request, {
      actorId: member.id,
      messageId: message.id,
      emoteKey: "feishu:ok"
    });
    expect(duplicateRemoval.removed).toBe(false);
    expect(duplicateRemoval.reactions).toEqual(removed.reactions);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_events WHERE type = 'reaction.removed' AND target_id = ?").get(message.id).count)
      .toBe(1);

    const after = (await listConversations(db, member.id)).find((item) => item.id === conversation.id);
    expect({
      lastActivityAt: after.lastActivityAt,
      messageCount: after.messageCount,
      unreadCount: after.unreadCount
    }).toEqual({
      lastActivityAt: before.lastActivityAt,
      messageCount: before.messageCount,
      unreadCount: before.unreadCount
    });
  });

  it("enforces reaction emote, membership and message-kind boundaries and cascades cleanup", async () => {
    const invite = await createInvite(db, request, { actorId: "usr_owner", code: "REACTION-TARGET" });
    const member = await acceptInvite(db, request, {
      code: invite.code,
      githubLogin: "reaction-target",
      email: "reaction-target@example.com"
    });
    const outsiderInvite = await createInvite(db, request, { actorId: "usr_owner", code: "REACTION-OUTSIDER" });
    const outsider = await acceptInvite(db, request, {
      code: outsiderInvite.code,
      githubLogin: "reaction-outsider",
      email: "reaction-outsider@example.com"
    });
    const conversation = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "direct",
      targetUserId: member.id
    });
    const message = await createStructuredMessage(db, request, {
      actorId: "usr_owner",
      conversationId: conversation.id,
      clientMessageId: "reaction-boundaries",
      content: textContent("Boundary target")
    });

    await expect(addMessageReaction(db, request, {
      actorId: member.id,
      messageId: message.id,
      emoteKey: "douyin:laughwithtears"
    })).rejects.toMatchObject({ code: "reaction.invalid_emote" });
    await expect(addMessageReaction(db, request, {
      actorId: member.id,
      messageId: message.id,
      emoteKey: "missing:nope"
    })).rejects.toMatchObject({ code: "reaction.invalid_emote" });
    await expect(addMessageReaction(db, request, {
      actorId: outsider.id,
      messageId: message.id,
      emoteKey: "feishu:ok"
    })).rejects.toMatchObject({ code: "permission.denied" });
    await expect(addMessageReaction(db, request, {
      actorId: member.id,
      messageId: "missing-message",
      emoteKey: "feishu:ok"
    })).rejects.toMatchObject({ code: "message.not_found" });

    const group = await createConversation(db, request, {
      actorId: "usr_owner",
      type: "group",
      title: "Reaction system boundary"
    });
    const systemMessage = (await listMessages(db, "usr_owner", group.id))
      .find((item) => item.kind === "system");
    await expect(addMessageReaction(db, request, {
      actorId: "usr_owner",
      messageId: systemMessage.id,
      emoteKey: "feishu:ok"
    })).rejects.toMatchObject({ code: "reaction.unsupported_message" });

    await addMessageReaction(db, request, {
      actorId: member.id,
      messageId: message.id,
      emoteKey: "feishu:ok"
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?").get(message.id).count).toBe(1);
    db.prepare("DELETE FROM messages WHERE id = ?").run(message.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?").get(message.id).count).toBe(0);
  });
});
