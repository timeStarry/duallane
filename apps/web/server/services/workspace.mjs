import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_SPACE_ID, SEEDED_OWNER_EMAIL, SEEDED_OWNER_GITHUB_LOGIN, SEEDED_OWNER_ID } from "./db.mjs";
import { canReserveQuota, DAILY_QUOTA_BYTES, remainingQuota } from "./quota.mjs";
import { writeAudit } from "./audit.mjs";

export const MESSAGE_CONTENT_FORMAT = "duallane.message+json;v=1";
export const DEFAULT_RETENTION_COUNT = 10000;
export const WORKSPACE_SESSION_COOKIE = "duallane_workspace";
export const WORKSPACE_EVENT_REPLAY_LIMIT = 200;
export const STALE_UPLOAD_RESERVATION_MS = 1000 * 60 * 30;

const workspaceEventSubscribers = new Set();
const workspaceTransactionEvents = new AsyncLocalStorage();

const ROLE_ORDER = {
  owner: 1,
  admin: 2,
  auditor: 3,
  member: 4
};

const ROLE_LABELS = {
  owner: "空间主人",
  admin: "管理员",
  member: "成员",
  auditor: "预留角色"
};

const PRIVILEGED_INVITE_ROLES = new Set(["owner", "admin", "auditor"]);
const MESSAGE_BLOCK_TYPES = new Set(["text", "mention", "link", "emoji", "attachment"]);
const ATTACHMENT_VISIBILITIES = new Set(["private_staging", "conversation", "space"]);

async function runWorkspaceTransaction(db, callback) {
  const parentPendingEvents = workspaceTransactionEvents.getStore();
  const pendingEvents = [];
  const result = await db.transaction(() => workspaceTransactionEvents.run(pendingEvents, callback));
  if (parentPendingEvents) {
    parentPendingEvents.push(...pendingEvents);
  } else {
    for (const event of pendingEvents) {
      notifyWorkspaceEventSubscribers(event);
    }
  }
  return result;
}

export async function createWorkspaceSession(db, userId, ttlMs = 1000 * 60 * 60 * 24 * 14) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(id, hashSecret(token), userId, now.toISOString(), expiresAt.toISOString());
  return { id, token, userId, expiresAt: expiresAt.toISOString() };
}

export async function getSessionUserId(db, token) {
  const normalized = normalizeString(token);
  if (!normalized) {
    return null;
  }
  const row = await db.prepare(`
    SELECT user_id AS userId
    FROM sessions
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND expires_at > ?
  `).get(hashSecret(normalized), new Date().toISOString());
  return row?.userId ?? null;
}

export async function revokeWorkspaceSession(db, token) {
  const normalized = normalizeString(token);
  if (!normalized) {
    return false;
  }
  const result = await db.prepare(`
    UPDATE sessions
    SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `).run(new Date().toISOString(), hashSecret(normalized));
  return result.changes > 0;
}

export async function getWorkspaceBootstrap(db, userId = "usr_owner") {
  const currentUser = await getUserWithRole(db, userId);
  if (!currentUser) {
    throw new WorkspaceAuthError("auth.required", "请先登录共享空间");
  }
  await releaseStaleUploadReservations(db);
  const eventCursor = await getWorkspaceEventCursor(db);

  const space = await getDefaultSpace(db);
  const members = (await listSpaceMembers(db)).map((member) => publicMember(member, currentUser));
  const usedTodayBytes = await getUsedToday(db, currentUser.id);

  const invites = await listVisibleInvitesForRole(db, currentUser.role);
  const permissions = permissionsForRole(currentUser.role);
  const conversations = permissions.canReadConversations ? await listConversations(db, currentUser.id) : [];
  const files = permissions.canDownload ? await listFiles(db, currentUser.id) : [];

  return {
    auth: {
      mode: "development",
      inviteOnly: true,
      currentUser: publicMember(currentUser, currentUser)
    },
    space,
    policy: {
      dailyQuotaBytes: DAILY_QUOTA_BYTES,
      usedTodayBytes,
      remainingQuotaBytes: remainingQuota(usedTodayBytes),
      messageRetentionCount: DEFAULT_RETENTION_COUNT
    },
    permissions,
    members,
    conversations,
    files,
    invites,
    eventCursor
  };
}

export async function listMembers(db, userId = "usr_owner", options = {}) {
  const actor = await requireActor(db, userId);
  const query = normalizeString(options.query || options.q).toLowerCase();
  const role = normalizeString(options.role);
  const kind = normalizeString(options.kind);
  const limit = Math.min(parsePositiveInteger(options.limit, 200), 500);
  const members = (await listSpaceMembers(db)).map((member) => publicMember(member, actor));
  return members.filter((member) => {
    if (role && member.role !== role) {
      return false;
    }
    if (kind && member.kind !== kind) {
      return false;
    }
    if (query) {
      return [member.displayName, member.githubLogin, member.roleLabel, member.role, member.kind]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query));
    }
    return true;
  }).slice(0, limit);
}

async function listVisibleInvitesForRole(db, role) {
  if (role === "owner") {
    return await db.prepare(`
      SELECT
        id,
        code_preview AS codePreview,
        default_role AS defaultRole,
        max_uses AS maxUses,
        uses,
        expires_at AS expiresAt,
        revoked_at AS revokedAt,
        created_at AS createdAt
      FROM invites
      WHERE space_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(DEFAULT_SPACE_ID);
  }
  if (canCreateInvite(role, "member")) {
    return await db.prepare(`
      SELECT
        id,
        code_preview AS codePreview,
        default_role AS defaultRole,
        max_uses AS maxUses,
        uses,
        expires_at AS expiresAt,
        revoked_at AS revokedAt,
        created_at AS createdAt
      FROM invites
      WHERE space_id = ? AND default_role = 'member'
      ORDER BY created_at DESC
      LIMIT 20
    `).all(DEFAULT_SPACE_ID);
  }
  return [];
}

export async function updateMemberRole(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  await requireCapability(db, request, actor, "member.role_update", {
    targetType: "member",
    targetId: input.userId
  });

  const userId = normalizeString(input.userId);
  let nextRole;
  try {
    nextRole = normalizeRole(input.role);
  } catch (error) {
    await writeMutationValidationRejection(db, request, actor, "member.role_update", "member", userId, error);
    throw error;
  }
  if (userId === actor.id) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "member.role_update",
      targetType: "member",
      targetId: userId,
      result: "rejected",
      reason: "self role update"
    });
    throw new WorkspaceValidationError("member.role_invalid", "不能修改自己的权限");
  }

  const member = await getUserWithRole(db, userId);
  if (!member) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "member.role_update",
      targetType: "member",
      targetId: userId,
      result: "rejected",
      reason: "member not found"
    });
    throw new WorkspaceValidationError("member.not_found", "空间成员不存在");
  }

  if (member.role === "owner" && nextRole !== "owner") {
    const ownerCount = (await db.prepare(`
      SELECT COUNT(*) AS count
      FROM space_members
      WHERE space_id = ? AND role = 'owner' AND removed_at IS NULL
    `).get(DEFAULT_SPACE_ID)).count;
    if (ownerCount <= 1) {
      await writeWorkspaceAudit(db, request, {
        actorUserId: actor.id,
        actorGithubLogin: actor.githubLogin,
        action: "member.role_update",
        targetType: "member",
        targetId: member.id,
        result: "rejected",
        reason: "last owner"
      });
      throw new WorkspaceValidationError("member.last_owner", "至少需要保留一位空间主人");
    }
  }

  const transactionResult = await runWorkspaceTransaction(db, async () => {
    await db.lock(`workspace-members:${DEFAULT_SPACE_ID}`);
    const currentMember = await getUserWithRole(db, member.id);
    if (currentMember?.role === "owner" && nextRole !== "owner") {
      const ownerCount = (await db.prepare(`
        SELECT COUNT(*) AS count
        FROM space_members
        WHERE space_id = ? AND role = 'owner' AND removed_at IS NULL
      `).get(DEFAULT_SPACE_ID)).count;
      if (ownerCount <= 1) {
        return { workspaceRejection: "last owner" };
      }
    }
    if (member.role !== nextRole) {
      await db.prepare(`
        UPDATE space_members
        SET role = ?
        WHERE space_id = ? AND user_id = ? AND removed_at IS NULL
      `).run(nextRole, DEFAULT_SPACE_ID, member.id);
    }

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "member.role_update",
      targetType: "member",
      targetId: member.id,
      result: "success",
      reason: `${member.role}->${nextRole}`
    });

    await writeEvent(db, {
      type: "workspace.member_updated",
      actorId: actor.id,
      targetType: "user",
      targetId: member.id,
      payload: { userId: member.id, role: nextRole, member: publicMember(await getUserWithRole(db, member.id)) }
    });

    return await getUserWithRole(db, member.id);
  });
  if (transactionResult?.workspaceRejection === "last owner") {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "member.role_update",
      targetType: "member",
      targetId: member.id,
      result: "rejected",
      reason: "last owner"
    });
    throw new WorkspaceValidationError("member.last_owner", "至少需要保留一位空间主人");
  }
  return transactionResult;
}

export async function removeSpaceMember(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  await requireCapability(db, request, actor, "member.remove", {
    targetType: "member",
    targetId: input.userId
  });

  const userId = normalizeString(input.userId);
  if (userId === actor.id) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "member.remove",
      targetType: "member",
      targetId: userId,
      result: "rejected",
      reason: "self removal"
    });
    throw new WorkspaceValidationError("member.remove_invalid", "不能移出当前账号");
  }

  const member = await getUserWithRole(db, userId);
  if (!member) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "member.remove",
      targetType: "member",
      targetId: userId,
      result: "rejected",
      reason: "member not found"
    });
    throw new WorkspaceValidationError("member.not_found", "空间成员不存在");
  }

  if (member.role === "owner") {
    const ownerCount = (await db.prepare(`
      SELECT COUNT(*) AS count
      FROM space_members
      WHERE space_id = ? AND role = 'owner' AND removed_at IS NULL
    `).get(DEFAULT_SPACE_ID)).count;
    if (ownerCount <= 1) {
      await writeWorkspaceAudit(db, request, {
        actorUserId: actor.id,
        actorGithubLogin: actor.githubLogin,
        action: "member.remove",
        targetType: "member",
        targetId: member.id,
        result: "rejected",
        reason: "last owner"
      });
      throw new WorkspaceValidationError("member.last_owner", "至少需要保留一位空间主人");
    }
  }

  const transactionResult = await runWorkspaceTransaction(db, async () => {
    await db.lock(`workspace-members:${DEFAULT_SPACE_ID}`);
    const currentMember = await getUserWithRole(db, member.id);
    if (currentMember?.role === "owner") {
      const ownerCount = (await db.prepare(`
        SELECT COUNT(*) AS count
        FROM space_members
        WHERE space_id = ? AND role = 'owner' AND removed_at IS NULL
      `).get(DEFAULT_SPACE_ID)).count;
      if (ownerCount <= 1) {
        return { workspaceRejection: "last owner" };
      }
    }
    const now = new Date().toISOString();
    await db.prepare(`
      UPDATE space_members
      SET removed_at = ?
      WHERE space_id = ? AND user_id = ? AND removed_at IS NULL
    `).run(now, DEFAULT_SPACE_ID, member.id);
    await db.prepare(`
      UPDATE conversation_members
      SET removed_at = ?
      WHERE user_id = ? AND removed_at IS NULL
    `).run(now, member.id);
    await db.prepare(`
      UPDATE sessions
      SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(now, member.id);

    await writeEvent(db, {
      type: "workspace.member_removed",
      actorId: actor.id,
      targetType: "user",
      targetId: member.id,
      payload: { userId: member.id }
    });

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "member.remove",
      targetType: "member",
      targetId: member.id,
      result: "success"
    });

    return { ok: true, userId: member.id, removedAt: now };
  });
  if (transactionResult?.workspaceRejection === "last owner") {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "member.remove",
      targetType: "member",
      targetId: member.id,
      result: "rejected",
      reason: "last owner"
    });
    throw new WorkspaceValidationError("member.last_owner", "至少需要保留一位空间主人");
  }
  return transactionResult;
}

export async function bindGitHubUser(db, request, profile) {
  const githubId = normalizeString(profile.githubId);
  const githubLogin = normalizeString(profile.githubLogin);
  const email = normalizeString(profile.email);
  const displayName = normalizeString(profile.displayName) || githubLogin;
  const avatarUrl = normalizeString(profile.avatarUrl);

  if (!githubLogin && !email && !githubId) {
    throw new WorkspaceValidationError("auth.invalid_profile", "GitHub 身份信息不完整");
  }

  const now = new Date().toISOString();
  const isSeededOwner = equalsIgnoreCase(githubLogin, SEEDED_OWNER_GITHUB_LOGIN) || equalsIgnoreCase(email, SEEDED_OWNER_EMAIL);
  let user;
  try {
    user = await resolveGitHubIdentityUser(db, { githubId, githubLogin, email });
    if (!user && isSeededOwner) {
      user = await db.prepare("SELECT * FROM users WHERE id = ?").get(SEEDED_OWNER_ID);
      assertGitHubIdentityCanBind(user, githubId);
    }
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "auth.identity_conflict") {
      await writeWorkspaceAudit(db, request, {
        actorUserId: null,
        actorGithubLogin: githubLogin || null,
        action: "login.rejected",
        targetType: "user",
        targetId: githubId || githubLogin || email,
        result: "rejected",
        reason: error.code
      });
    }
    throw error;
  }

  if (!user && !isSeededOwner) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: null,
      actorGithubLogin: githubLogin || null,
      action: "login.rejected",
      targetType: "user",
      targetId: githubLogin || email || githubId,
      result: "rejected",
      reason: "not invited"
    });
    throw new WorkspaceAuthError("auth.not_invited", "该 GitHub 用户尚未被邀请");
  }

  return await runWorkspaceTransaction(db, async () => {
    await db.prepare(`
      UPDATE users
      SET
        github_id = COALESCE(github_id, ?),
        github_login = COALESCE(?, github_login),
        email = COALESCE(?, email),
        display_name = COALESCE(?, display_name),
        avatar_url = COALESCE(?, avatar_url),
        last_login_at = ?
      WHERE id = ?
    `).run(githubId || null, githubLogin || null, email || null, displayName || null, avatarUrl || null, now, user.id);

    await writeWorkspaceAudit(db, request, {
      actorUserId: user.id,
      actorGithubLogin: githubLogin || user.github_login,
      action: "login.success",
      targetType: "user",
      targetId: user.id,
      result: "success"
    });

    return await getUserWithRole(db, user.id);
  });
}

export async function createInvite(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  let defaultRole;
  try {
    defaultRole = normalizeRole(input.defaultRole || "member");
  } catch (error) {
    await writeMutationValidationRejection(db, request, actor, "invite.create", "invite", null, error);
    throw error;
  }
  if (!canCreateInvite(actor.role, defaultRole)) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "invite.create",
      targetType: "invite",
      result: "rejected",
      reason: "insufficient permission"
    });
    throw new WorkspacePermissionError("permission.denied", "你没有创建该邀请的权限");
  }

  const code = normalizeString(input.code) || generateInviteCode();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const maxUses = parsePositiveInteger(input.maxUses, 1);
  const expiresAt = normalizeString(input.expiresAt) || expiresAtFromHours(input.expiresInHours, now);

  return await runWorkspaceTransaction(db, async () => {
    await db.prepare(`
      INSERT INTO invites (
        id, space_id, code_hash, code_preview, default_role, created_by, max_uses, uses, expires_at, revoked_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)
    `).run(id, DEFAULT_SPACE_ID, hashSecret(code), previewCode(code), defaultRole, actor.id, maxUses, expiresAt, now);

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "invite.create",
      targetType: "invite",
      targetId: id,
      result: "success"
    });

    return {
      id,
      code,
      codePreview: previewCode(code),
      defaultRole,
      maxUses,
      uses: 0,
      expiresAt,
      createdAt: now
    };
  });
}

export async function revokeInvite(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  await requireCapability(db, request, actor, "invite.revoke", {
    targetType: "invite",
    targetId: input.inviteId
  });

  const inviteId = normalizeString(input.inviteId);
  const invite = await db.prepare(`
    SELECT id, default_role AS defaultRole, revoked_at AS revokedAt
    FROM invites
    WHERE id = ? AND space_id = ?
  `).get(inviteId, DEFAULT_SPACE_ID);
  if (!invite) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "invite.revoke",
      targetType: "invite",
      targetId: inviteId,
      result: "rejected",
      reason: "invite not found"
    });
    throw new WorkspaceValidationError("invite.not_found", "邀请不存在");
  }
  if (!canCreateInvite(actor.role, invite.defaultRole)) {
    await rejectPermission(db, request, actor, {
      action: "invite.revoke",
      targetType: "invite",
      targetId: invite.id,
      reason: "insufficient permission"
    });
    throw new WorkspacePermissionError("permission.denied", "你没有执行该操作的权限");
  }

  return await runWorkspaceTransaction(db, async () => {
    const revokedAt = invite.revokedAt ?? new Date().toISOString();
    if (!invite.revokedAt) {
      await db.prepare("UPDATE invites SET revoked_at = ? WHERE id = ?").run(revokedAt, invite.id);
    }

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "invite.revoke",
      targetType: "invite",
      targetId: invite.id,
      result: "success"
    });

    return { id: invite.id, revokedAt };
  });
}

export async function acceptInvite(db, request, input) {
  const code = normalizeString(input.code);
  const githubId = normalizeString(input.githubId);
  const githubLogin = normalizeString(input.githubLogin);
  const email = normalizeString(input.email);
  const displayName = normalizeString(input.displayName) || githubLogin;
  const avatarUrl = normalizeString(input.avatarUrl);
  if (!code || !githubLogin) {
    throw new WorkspaceValidationError("invite.invalid", "邀请码和 GitHub 用户不能为空");
  }

  const invite = await db.prepare(`
    SELECT *
    FROM invites
    WHERE code_hash = ? AND space_id = ?
  `).get(hashSecret(code), DEFAULT_SPACE_ID);

  if (!invite || invite.revoked_at) {
    await writeWorkspaceAudit(db, request, {
      action: "invite.accept",
      targetType: "invite",
      result: "rejected",
      reason: "invalid invite"
    });
    throw new WorkspaceValidationError("invite.invalid", "邀请无效或已撤销");
  }

  if (invite.expires_at && Date.parse(invite.expires_at) <= Date.now()) {
    await writeWorkspaceAudit(db, request, {
      action: "invite.accept",
      targetType: "invite",
      targetId: invite.id,
      result: "rejected",
      reason: "expired invite"
    });
    throw new WorkspaceValidationError("invite.expired", "邀请已过期");
  }

  if (invite.uses >= invite.max_uses) {
    await writeWorkspaceAudit(db, request, {
      action: "invite.accept",
      targetType: "invite",
      targetId: invite.id,
      result: "rejected",
      reason: "invite exhausted"
    });
    throw new WorkspaceValidationError("invite.exhausted", "邀请次数已用完");
  }

  let existing;
  try {
    existing = await resolveGitHubIdentityUser(db, { githubId, githubLogin, email });
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "auth.identity_conflict") {
      await writeWorkspaceAudit(db, request, {
        actorGithubLogin: githubLogin || null,
        action: "invite.accept",
        targetType: "invite",
        targetId: invite.id,
        result: "rejected",
        reason: error.code
      });
    }
    throw error;
  }

  return await runWorkspaceTransaction(db, async () => {
    const now = new Date().toISOString();
    const reservedInvite = await db.prepare(`
      UPDATE invites
      SET uses = uses + 1
      WHERE id = ?
        AND space_id = ?
        AND revoked_at IS NULL
        AND uses < max_uses
        AND (expires_at IS NULL OR expires_at > ?)
    `).run(invite.id, DEFAULT_SPACE_ID, now);
    if (reservedInvite.changes !== 1) {
      const latestInvite = await db.prepare(`
        SELECT *
        FROM invites
        WHERE id = ? AND space_id = ?
      `).get(invite.id, DEFAULT_SPACE_ID);
      const reason = latestInvite?.revoked_at
        ? "invalid invite"
        : latestInvite?.expires_at && Date.parse(latestInvite.expires_at) <= Date.parse(now)
          ? "expired invite"
          : "invite exhausted";
      await writeWorkspaceAudit(db, request, {
        action: "invite.accept",
        targetType: "invite",
        targetId: invite.id,
        result: "rejected",
        reason
      });
      throw new WorkspaceValidationError(
        reason === "expired invite" ? "invite.expired" : reason === "invite exhausted" ? "invite.exhausted" : "invite.invalid",
        reason === "expired invite" ? "邀请已过期" : reason === "invite exhausted" ? "邀请次数已用完" : "邀请无效或已撤销"
      );
    }

    const userId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await db.prepare(`
        INSERT INTO users (
          id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'human', ?, ?)
      `).run(userId, githubId || null, githubLogin, email || null, displayName, avatarUrl || null, now, now);
    } else {
      await db.prepare(`
        UPDATE users
        SET
          github_id = COALESCE(github_id, ?),
          github_login = COALESCE(?, github_login),
          email = COALESCE(?, email),
          display_name = COALESCE(?, display_name),
          avatar_url = COALESCE(?, avatar_url),
          last_login_at = ?
        WHERE id = ?
      `).run(githubId || null, githubLogin || null, email || null, displayName || null, avatarUrl || null, now, userId);
    }

    await db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(space_id, user_id) DO UPDATE SET
        role = excluded.role,
        removed_at = NULL
    `).run(DEFAULT_SPACE_ID, userId, invite.default_role, now);

    const member = await getUserWithRole(db, userId);
    await writeEvent(db, {
      type: "workspace.member_joined",
      actorId: userId,
      targetType: "user",
      targetId: userId,
      payload: { userId, role: invite.default_role, inviteId: invite.id, member: publicMember(member) }
    });

    await writeWorkspaceAudit(db, request, {
      actorUserId: userId,
      actorGithubLogin: githubLogin,
      action: "invite.accept",
      targetType: "invite",
      targetId: invite.id,
      result: "success"
    });

    return member;
  });
}

async function resolveGitHubIdentityUser(db, { githubId, githubLogin, email }) {
  const byId = githubId
    ? await db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId)
    : null;
  const byLogin = githubLogin
    ? await db.prepare("SELECT * FROM users WHERE github_login = ?").get(githubLogin)
    : null;
  const byEmail = email
    ? await db.prepare("SELECT * FROM users WHERE email = ?").get(email)
    : null;
  const aliasMatches = [...new Map(
    [byLogin, byEmail].filter(Boolean).map((candidate) => [candidate.id, candidate])
  ).values()];

  if (byId) {
    if (aliasMatches.some((candidate) => candidate.id !== byId.id)) {
      throwGitHubIdentityConflict();
    }
    return byId;
  }

  if (aliasMatches.length > 1) {
    throwGitHubIdentityConflict();
  }
  const aliasUser = aliasMatches[0] ?? null;
  assertGitHubIdentityCanBind(aliasUser, githubId);
  return aliasUser;
}

function assertGitHubIdentityCanBind(user, githubId) {
  if (user?.github_id && user.github_id !== githubId) {
    throwGitHubIdentityConflict();
  }
}

function throwGitHubIdentityConflict() {
  throw new WorkspaceAuthError("auth.identity_conflict", "GitHub 身份与已有账号不一致，请联系空间主人");
}

export async function listConversations(db, userId = "usr_owner", request = null) {
  const actor = await requireActor(db, userId);
  await requireCapability(db, request, actor, "conversation.read", {
    targetType: "conversation"
  });
  const conversations = await db.prepare(`
    SELECT
      c.id,
      c.space_id AS spaceId,
      c.type,
      c.title,
      c.retention_count AS retentionCount,
      c.created_at AS createdAt,
      COALESCE((
        SELECT MAX(m.created_at)
        FROM messages m
        WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
      ), c.created_at) AS lastActivityAt,
      cm.last_read_message_id AS lastReadMessageId,
      cm.last_read_at AS lastReadAt,
      cm.last_read_seq AS lastReadSeq,
      cm.notification_level AS notificationLevel,
      (
        SELECT COUNT(*)
        FROM messages m
        WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
      ) AS messageCount,
      (
        SELECT COUNT(*)
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.deleted_at IS NULL
          AND (m.author_id IS NULL OR m.author_id != ?)
          AND (
            (
              cm.last_read_seq IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM workspace_events we
                WHERE we.type = 'message.created'
                  AND we.target_id = m.id
                  AND we.seq > cm.last_read_seq
              )
            )
            OR (
              cm.last_read_seq IS NULL
              AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
            )
          )
      ) AS unreadCount
    FROM conversations c
    INNER JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE c.space_id = ? AND cm.user_id = ? AND cm.removed_at IS NULL
    ORDER BY lastActivityAt DESC, c.created_at DESC
  `).all(actor.id, DEFAULT_SPACE_ID, actor.id);

  return await Promise.all(conversations.map(async (conversation) => await publicConversation({
    ...conversation,
    viewerId: actor.id,
    viewerRole: actor.role,
    members: await listConversationMembers(db, conversation.id),
    latestMessages: await listMessages(db, actor.id, conversation.id, { limit: 20 })
  }, actor)));
}

export async function getConversationDetails(db, userId, conversationId, request = null) {
  const actor = await requireActor(db, userId);
  return await getConversation(db, actor.id, normalizeString(conversationId), { request, actor, action: "conversation.read" });
}

export async function createConversation(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const type = normalizeString(input.type);
  if (!["direct", "group"].includes(type)) {
    await writeConversationCreateRejection(db, request, actor, "invalid type");
    throw new WorkspaceValidationError("conversation.invalid_type", "会话类型无效");
  }

  if (type === "direct") {
    const targetUserId = normalizeString(input.targetUserId);
    if (!targetUserId || targetUserId === actor.id) {
      await writeConversationCreateRejection(db, request, actor, "invalid target");
      throw new WorkspaceValidationError("conversation.invalid_target", "请选择一个空间成员");
    }
    const target = await getUserWithRole(db, targetUserId);
    if (!target) {
      await writeConversationCreateRejection(db, request, actor, "invalid target");
      throw new WorkspaceValidationError("conversation.invalid_target", "成员不存在");
    }
    if (target.role === "auditor") {
      await writeConversationCreateRejection(db, request, actor, "invalid target");
      throw new WorkspaceValidationError("conversation.invalid_target", "请选择可聊天的空间成员");
    }
    await requireCapability(db, request, actor, "conversation.create_direct", {
      targetType: "conversation",
      targetId: targetUserId
    });
    return await createOrGetDirectConversation(db, request, actor, target);
  }

  await requireCapability(db, request, actor, "conversation.create_group", {
    targetType: "conversation",
    targetId: "new"
  });
  const title = normalizeString(input.title);
  if (!title) {
    await writeConversationCreateRejection(db, request, actor, "invalid title");
    throw new WorkspaceValidationError("conversation.invalid_title", "请输入群聊名称");
  }
  if (title.length > 80) {
    await writeConversationCreateRejection(db, request, actor, "invalid title");
    throw new WorkspaceValidationError("conversation.invalid_title", "群聊名称过长");
  }
  const selectedMemberIds = uniqueStrings(Array.isArray(input.memberIds) ? input.memberIds : [])
    .filter((memberId) => memberId !== actor.id);
  if (selectedMemberIds.length === 0) {
    await writeConversationCreateRejection(db, request, actor, "invalid members");
    throw new WorkspaceValidationError("conversation.invalid_members", "请选择至少一位群聊成员");
  }
  const memberIds = uniqueStrings([actor.id, ...selectedMemberIds]);
  let members;
  try {
    members = await Promise.all(memberIds.map(async (memberId) => await ensureChatParticipantMember(db, memberId)));
  } catch (error) {
    if (error instanceof WorkspaceError) {
      await writeConversationCreateRejection(db, request, actor, error.code);
    }
    throw error;
  }
  return await runWorkspaceTransaction(db, async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'group', ?, NULL, ?, ?, ?)
    `).run(id, DEFAULT_SPACE_ID, title, DEFAULT_RETENTION_COUNT, actor.id, now);

    for (const member of members) {
      await db.prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
        VALUES (?, ?, ?, NULL)
      `).run(id, member.id, now);
    }

    const createdConversation = await getConversation(db, actor.id, id);

    await writeEvent(db, {
      type: "conversation.created",
      actorId: actor.id,
      conversationId: id,
      targetType: "conversation",
      targetId: id,
      payload: { conversationId: id, type: "group", title, conversation: await publicConversation(createdConversation) }
    });

    for (const member of members) {
      if (member.id !== actor.id) {
        await writeEvent(db, {
          type: "conversation.member_added",
          actorId: actor.id,
          conversationId: id,
          targetType: "user",
          targetId: member.id,
          payload: { conversationId: id, userId: member.id, member: publicMember(member) }
        });
      }
    }
    await createSystemMessage(db, {
      actor,
      conversationId: id,
      plainText: `${actor.displayName} 创建了群聊「${title}」`
    });

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.create",
      targetType: "conversation",
      targetId: id,
      result: "success"
    });

    return createdConversation;
  });
}

export async function addConversationMember(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const conversationId = normalizeString(input.conversationId);
  const userId = normalizeString(input.userId);
  await requireCapability(db, request, actor, "conversation.member.manage", {
    targetType: "conversation",
    targetId: conversationId
  });
  const conversation = await getGroupConversationForManage(db, conversationId);
  let member;
  try {
    member = await ensureChatParticipantMember(db, userId);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      await writeWorkspaceAudit(db, request, {
        actorUserId: actor.id,
        actorGithubLogin: actor.githubLogin,
        action: "conversation.member_add",
        targetType: "conversation",
        targetId: conversation.id,
        result: "rejected",
        reason: error.code
      });
    }
    throw error;
  }
  const activeMembership = await db.prepare(`
    SELECT 1
    FROM conversation_members
    WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
  `).get(conversation.id, member.id);
  if (activeMembership) {
    return await getConversation(db, actor.id, conversation.id);
  }

  return await runWorkspaceTransaction(db, async () => {
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(conversation_id, user_id) DO UPDATE SET
        removed_at = NULL,
        joined_at = excluded.joined_at
    `).run(conversation.id, member.id, now);

    await writeEvent(db, {
      type: "conversation.member_added",
      actorId: actor.id,
      conversationId: conversation.id,
      targetType: "user",
      targetId: member.id,
      payload: { conversationId: conversation.id, userId: member.id, member: publicMember(member) }
    });
    await createSystemMessage(db, {
      actor,
      conversationId: conversation.id,
      plainText: `${actor.displayName} 邀请 ${member.displayName} 加入群聊`
    });

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.member_add",
      targetType: "conversation",
      targetId: conversation.id,
      result: "success"
    });

    return await getConversation(db, actor.id, conversation.id);
  });
}

export async function removeConversationMember(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const conversationId = normalizeString(input.conversationId);
  const userId = normalizeString(input.userId);
  await requireCapability(db, request, actor, "conversation.member.manage", {
    targetType: "conversation",
    targetId: conversationId
  });
  const conversation = await getGroupConversationForManage(db, conversationId);
  if (userId === actor.id) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.member_remove",
      targetType: "conversation",
      targetId: conversation.id,
      result: "rejected",
      reason: "self removal"
    });
    throw new WorkspaceValidationError("conversation.member_invalid", "不能在此处移出自己");
  }
  await ensureActiveSpaceMember(db, userId);
  const activeMembership = await db.prepare(`
    SELECT 1
    FROM conversation_members
    WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
  `).get(conversation.id, userId);
  if (!activeMembership) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.member_remove",
      targetType: "conversation",
      targetId: conversation.id,
      result: "rejected",
      reason: "member not in conversation"
    });
    throw new WorkspaceValidationError("conversation.member_not_found", "该成员不在群聊中");
  }
  const removedMember = await getUserWithRole(db, userId);

  return await runWorkspaceTransaction(db, async () => {
    const now = new Date().toISOString();
    const result = await db.prepare(`
      UPDATE conversation_members
      SET removed_at = ?
      WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
    `).run(now, conversation.id, userId);
    if (result.changes === 0) {
      throw new WorkspaceValidationError("conversation.member_not_found", "该成员不在群聊中");
    }

    await writeEvent(db, {
      type: "conversation.member_removed",
      actorId: actor.id,
      conversationId: conversation.id,
      targetType: "user",
      targetId: userId,
      payload: { conversationId: conversation.id, userId }
    });
    await createSystemMessage(db, {
      actor,
      conversationId: conversation.id,
      plainText: `${actor.displayName} 将 ${removedMember?.displayName ?? "成员"} 移出群聊`
    });

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.member_remove",
      targetType: "conversation",
      targetId: conversation.id,
      result: "success"
    });

    return await getConversation(db, actor.id, conversation.id);
  });
}

export async function leaveConversation(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const conversationId = normalizeString(input.conversationId);
  const conversation = await getGroupConversationForManage(db, conversationId);
  await requireConversationMember(db, actor.id, conversation.id, { request, actor, action: "conversation.leave" });
  const activeCount = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM conversation_members
    WHERE conversation_id = ? AND removed_at IS NULL
  `).get(conversation.id);
  if (activeCount.count <= 1) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.leave",
      targetType: "conversation",
      targetId: conversation.id,
      result: "rejected",
      reason: "last member"
    });
    throw new WorkspaceValidationError("conversation.member_invalid", "最后一位成员不能离开群聊");
  }

  return await runWorkspaceTransaction(db, async () => {
    const now = new Date().toISOString();
    await db.prepare(`
      UPDATE conversation_members
      SET removed_at = ?
      WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
    `).run(now, conversation.id, actor.id);

    await writeEvent(db, {
      type: "conversation.member_removed",
      actorId: actor.id,
      conversationId: conversation.id,
      targetType: "user",
      targetId: actor.id,
      payload: { conversationId: conversation.id, userId: actor.id, self: true }
    });
    await createSystemMessage(db, {
      actor,
      conversationId: conversation.id,
      plainText: `${actor.displayName} 离开了群聊`
    });

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.leave",
      targetType: "conversation",
      targetId: conversation.id,
      result: "success"
    });

    return { ok: true, conversationId: conversation.id };
  });
}

export async function updateGroupConversation(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const conversationId = normalizeString(input.conversationId);
  await requireCapability(db, request, actor, "conversation.member.manage", {
    targetType: "conversation",
    targetId: conversationId
  });
  const conversation = await getGroupConversationForManage(db, conversationId);
  const title = normalizeString(input.title);
  if (!title) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.update",
      targetType: "conversation",
      targetId: conversation.id,
      result: "rejected",
      reason: "invalid title"
    });
    throw new WorkspaceValidationError("conversation.invalid_title", "请输入群聊名称");
  }
  if (title.length > 80) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.update",
      targetType: "conversation",
      targetId: conversation.id,
      result: "rejected",
      reason: "invalid title"
    });
    throw new WorkspaceValidationError("conversation.invalid_title", "群聊名称过长");
  }

  return await runWorkspaceTransaction(db, async () => {
    await db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, conversation.id);
    const renamedConversation = await getConversation(db, actor.id, conversation.id, { actor });

    await writeEvent(db, {
      type: "conversation.updated",
      actorId: actor.id,
      conversationId: conversation.id,
      targetType: "conversation",
      targetId: conversation.id,
      payload: { conversationId: conversation.id, title, conversation: await publicConversation(renamedConversation) }
    });
    await createSystemMessage(db, {
      actor,
      conversationId: conversation.id,
      plainText: `${actor.displayName} 将群聊名称改为「${title}」`
    });

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.update",
      targetType: "conversation",
      targetId: conversation.id,
      result: "success"
    });

    return await getConversation(db, actor.id, conversation.id);
  });
}

export async function markConversationRead(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const conversationId = normalizeString(input.conversationId);
  await requireCapability(db, request, actor, "conversation.read", {
    targetType: "conversation",
    targetId: conversationId
  });
  await requireConversationMember(db, actor.id, conversationId, { request, actor, action: "conversation.read" });
  return await runWorkspaceTransaction(db, async () => {
    const marker = await db.prepare(`
      WITH latest_message AS (
        SELECT m.id, m.created_at, we.seq AS event_seq
        FROM messages m
        LEFT JOIN workspace_events we
          ON we.space_id = m.space_id
          AND we.conversation_id = m.conversation_id
          AND we.type = 'message.created'
          AND we.target_id = m.id
        WHERE m.conversation_id = ? AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC, we.seq DESC, m.id DESC
        LIMIT 1
      )
      SELECT
        latest_message.id,
        latest_message.created_at AS createdAt,
        COALESCE(
          latest_message.event_seq,
          (SELECT COALESCE(MAX(seq), 0) FROM workspace_events WHERE space_id = ?)
        ) AS lastReadSeq
      FROM (SELECT 1) AS marker_anchor
      LEFT JOIN latest_message ON 1 = 1
    `).get(conversationId, DEFAULT_SPACE_ID);
    const lastReadSeq = Number(marker.lastReadSeq) || 0;
    await db.prepare(`
      UPDATE conversation_members
      SET last_read_message_id = ?, last_read_at = ?, last_read_seq = ?
      WHERE conversation_id = ?
        AND user_id = ?
        AND removed_at IS NULL
        AND (last_read_seq IS NULL OR last_read_seq <= ?)
    `).run(
      marker.id ?? null,
      marker.createdAt ?? new Date().toISOString(),
      lastReadSeq,
      conversationId,
      actor.id,
      lastReadSeq
    );
    return await getConversation(db, actor.id, conversationId);
  });
}

export async function updateConversationNotificationLevel(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const conversationId = normalizeString(input.conversationId);
  const level = normalizeString(input.level || input.notificationLevel);
  if (!["all", "mentions", "muted"].includes(level)) {
    throw new WorkspaceValidationError("conversation.notification_invalid", "请选择有效的提醒方式");
  }
  await requireCapability(db, request, actor, "conversation.read", {
    targetType: "conversation",
    targetId: conversationId
  });
  await requireConversationMember(db, actor.id, conversationId, { request, actor, action: "conversation.read" });

  return await runWorkspaceTransaction(db, async () => {
    await db.prepare(`
      UPDATE conversation_members
      SET notification_level = ?
      WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
    `).run(level, conversationId, actor.id);

    const conversation = await getConversation(db, actor.id, conversationId);
    await writeEvent(db, {
      type: "conversation.notification_updated",
      actorId: actor.id,
      conversationId,
      targetType: "user",
      targetId: actor.id,
      payload: {
        conversationId,
        userId: actor.id,
        notificationLevel: level,
        conversation
      }
    });

    return conversation;
  });
}

export async function listMessages(db, userId, conversationId, options = {}) {
  const actor = await requireActor(db, userId);
  await requireCapability(db, options.request ?? null, actor, "conversation.read", {
    targetType: "conversation",
    targetId: conversationId
  });
  await requireConversationMember(db, actor.id, conversationId, {
    request: options.request,
    actor,
    action: "conversation.read"
  });
  const limit = Math.min(parsePositiveInteger(options.limit, 80), 200);
  const beforeMessageId = normalizeString(options.before);
  const before = beforeMessageId
    ? await db.prepare(`
      SELECT created_at AS createdAt, id AS messageCursorId
      FROM messages
      WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL
    `).get(beforeMessageId, conversationId)
    : null;
  if (beforeMessageId && !before) {
    return [];
  }
  const cursorFilter = before
    ? `AND (
          m.created_at < ?
          OR (m.created_at = ? AND m.id < ?)
        )`
    : "";
  const rows = await db.prepare(`
    SELECT
      recent.id,
      recent.spaceId,
      recent.conversationId,
      recent.authorId,
      u.display_name AS authorName,
      u.github_login AS authorGithubLogin,
      recent.authorKind,
      recent.kind,
      recent.clientMessageId,
      recent.contentFormat,
      recent.contentJson,
      recent.plainText,
      recent.replyToMessageId,
      recent.createdAt,
      recent.editedAt,
      recent.deletedAt
    FROM (
      SELECT
        m.id AS messageCursorId,
        m.id,
        m.space_id AS spaceId,
        m.conversation_id AS conversationId,
        m.author_id AS authorId,
        m.author_kind AS authorKind,
        m.kind,
        m.client_message_id AS clientMessageId,
        m.content_format AS contentFormat,
        m.content_json AS contentJson,
        m.plain_text AS plainText,
        m.reply_to_message_id AS replyToMessageId,
        m.created_at AS createdAt,
        m.edited_at AS editedAt,
        m.deleted_at AS deletedAt
      FROM messages m
      WHERE m.conversation_id = ?
        AND m.deleted_at IS NULL
        ${cursorFilter}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?
    ) recent
    LEFT JOIN users u ON u.id = recent.authorId
    ORDER BY recent.createdAt ASC, recent.messageCursorId ASC
  `).all(...(before
    ? [conversationId, before.createdAt, before.createdAt, before.messageCursorId, limit]
    : [conversationId, limit]));

  return await Promise.all(rows.map(async (row) => await publicMessage({
    ...row,
    content: JSON.parse(row.contentJson),
    attachments: await listMessageAttachments(db, row.id)
  }, actor, db)));
}

export async function createStructuredMessage(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const conversationId = normalizeString(input.conversationId);
  const clientMessageId = normalizeString(input.clientMessageId);
  if (!conversationId || !clientMessageId) {
    throw new WorkspaceValidationError("message.invalid", "conversationId 和 clientMessageId 不能为空");
  }

  await requireCapability(db, request, actor, "message.create", {
    targetType: "conversation",
    targetId: conversationId
  });
  await requireConversationMember(db, actor.id, conversationId, { request, actor, action: "message.create" });
  let existing;
  let normalizedContent;
  let replyToMessageId = null;
  let attachmentIds = [];
  try {
    existing = await db.prepare(`
      SELECT id, content_json AS contentJson
      FROM messages
      WHERE space_id = ? AND conversation_id = ? AND author_id = ? AND client_message_id = ?
    `).get(DEFAULT_SPACE_ID, conversationId, actor.id, clientMessageId);

    normalizedContent = await normalizeMessageContent(db, actor, conversationId, input.content);
    if (existing) {
      if (existing.contentJson !== JSON.stringify(normalizedContent)) {
        throw new WorkspaceValidationError("message.idempotency_conflict", "重复消息 ID 对应的内容不一致");
      }
      return (await listMessages(db, actor.id, conversationId, { limit: 200 })).find((message) => message.id === existing.id);
    }

    replyToMessageId = normalizeString(input.replyToMessageId) || null;
    if (replyToMessageId) {
      const reply = await db.prepare("SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?").get(replyToMessageId, conversationId);
      if (!reply) {
        throw new WorkspaceValidationError("message.invalid_reply", "回复的消息不存在");
      }
    }

    attachmentIds = extractAttachmentIds(normalizedContent);
    for (const attachmentId of attachmentIds) {
      await validateAttachmentForMessage(db, actor, conversationId, attachmentId);
    }
  } catch (error) {
    await auditMessageCreateRejection(db, request, actor, conversationId, error);
    throw error;
  }

  const transactionResult = await runWorkspaceTransaction(db, async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const inserted = await db.prepare(`
      INSERT INTO messages (
        id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
        content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT (space_id, conversation_id, author_id, client_message_id) DO NOTHING
      RETURNING id
    `).run(
      id,
      DEFAULT_SPACE_ID,
      conversationId,
      actor.id,
      actor.kind,
      clientMessageId,
      MESSAGE_CONTENT_FORMAT,
      JSON.stringify(normalizedContent),
      normalizedContent.plainText,
      replyToMessageId,
      now
    );
    if (inserted.changes === 0) {
      const winner = await db.prepare(`
        SELECT id, content_json AS contentJson
        FROM messages
        WHERE space_id = ? AND conversation_id = ? AND author_id = ? AND client_message_id = ?
      `).get(DEFAULT_SPACE_ID, conversationId, actor.id, clientMessageId);
      if (!winner || winner.contentJson !== JSON.stringify(normalizedContent)) {
        return { idempotencyConflict: true };
      }
      return (await listMessages(db, actor.id, conversationId, { limit: 200 }))
        .find((message) => message.id === winner.id);
    }

    for (const attachmentId of attachmentIds) {
      await db.prepare(`
        INSERT INTO message_attachments (message_id, attachment_id)
        VALUES (?, ?)
        ON CONFLICT DO NOTHING
      `).run(id, attachmentId);
      await db.prepare(`
        UPDATE attachments
        SET visibility = 'conversation', conversation_id = COALESCE(conversation_id, ?)
        WHERE id = ?
      `).run(conversationId, attachmentId);
    }

    await enforceRetention(db, conversationId);
    const createdMessage = (await listMessages(db, actor.id, conversationId, { limit: 200 })).find((message) => message.id === id);
    const updatedConversation = await getConversation(db, actor.id, conversationId);
    await writeEvent(db, {
      type: "message.created",
      actorId: actor.id,
      conversationId,
      targetType: "message",
      targetId: id,
      payload: {
        messageId: id,
        conversationId,
        message: await publicMessage(createdMessage, actor, db),
        conversation: await publicConversation(updatedConversation)
      }
    });

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "message.create",
      targetType: "conversation",
      targetId: conversationId,
      result: "success"
    });

    return createdMessage;
  });
  if (transactionResult?.idempotencyConflict) {
    const error = new WorkspaceValidationError(
      "message.idempotency_conflict",
      "重复消息 ID 对应的内容不一致"
    );
    await auditMessageCreateRejection(db, request, actor, conversationId, error);
    throw error;
  }
  return transactionResult;
}

async function createSystemMessage(db, { actor, conversationId, plainText }) {
  const text = normalizeString(plainText);
  if (!text) {
    return null;
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const content = {
    format: MESSAGE_CONTENT_FORMAT,
    plainText: text,
    blocks: [{ type: "text", text }]
  };
  await db.prepare(`
    INSERT INTO messages (
      id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
      content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at
    )
    VALUES (?, ?, ?, NULL, 'system', 'system', NULL, ?, ?, ?, NULL, ?, NULL, NULL)
  `).run(id, DEFAULT_SPACE_ID, conversationId, MESSAGE_CONTENT_FORMAT, JSON.stringify(content), text, now);

  await enforceRetention(db, conversationId);
  const viewer = await isActiveConversationMember(db, actor.id, conversationId)
    ? actor
    : await getConversationEventViewer(db, conversationId) ?? actor;
  const systemMessage = (await listMessages(db, viewer.id, conversationId, { limit: 200 })).find((message) => message.id === id);
  const updatedConversation = await getConversation(db, viewer.id, conversationId, { actor: viewer });
  await writeEvent(db, {
    type: "message.created",
    actorId: actor.id,
    conversationId,
    targetType: "message",
    targetId: id,
    payload: {
      messageId: id,
      conversationId,
      message: await publicMessage(systemMessage, actor, db),
      conversation: await publicConversation(updatedConversation)
    }
  });
  return systemMessage;
}

async function getConversationEventViewer(db, conversationId) {
  const row = await db.prepare(`
    SELECT user_id AS userId
    FROM conversation_members
    WHERE conversation_id = ? AND removed_at IS NULL
    ORDER BY joined_at ASC
    LIMIT 1
  `).get(conversationId);
  return row ? await getUserWithRole(db, row.userId) : null;
}

export async function reserveUpload(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  await requireCapability(db, request, actor, "file.upload", {
    targetType: "attachment",
    targetId: "new"
  });
  let byteSize;
  let fileName;
  let mimeType;
  let visibility;
  try {
    byteSize = parseByteSize(input.byteSize);
    fileName = normalizeString(input.fileName);
    mimeType = normalizeString(input.mimeType) || "application/octet-stream";
    visibility = normalizeAttachmentVisibility(input.visibility || "private_staging");
    if (!fileName) {
      throw new WorkspaceValidationError("file.invalid", "文件名不能为空");
    }
  } catch (error) {
    await writeMutationValidationRejection(db, request, actor, "file.upload.reserve", "attachment", "new", error);
    throw error;
  }
  const requestedConversationId = normalizeString(input.conversationId) || null;
  const conversationId = visibility === "conversation" ? requestedConversationId : null;
  if (visibility === "conversation") {
    await requireConversationMember(db, actor.id, conversationId, { request, actor, action: "file.upload" });
  }

  await releaseStaleUploadReservations(db);
  const now = new Date().toISOString();
  const transferId = crypto.randomUUID();

  return await runWorkspaceTransaction(db, async () => {
    await db.lock(`workspace-quota:${DEFAULT_SPACE_ID}:${actor.id}:${new Date(now).toDateString()}`);
    const usedToday = await getUsedToday(db, actor.id);
    const allowed = canReserveQuota(usedToday, byteSize);
    if (!allowed) {
      await db.prepare(`
        INSERT INTO transfer_ledger (
          id, space_id, user_id, direction, byte_size, status, attachment_id, created_at, completed_at, released_at
        )
        VALUES (?, ?, ?, 'upload', ?, 'rejected', NULL, ?, ?, NULL)
      `).run(transferId, DEFAULT_SPACE_ID, actor.id, byteSize, now, now);
      await writeRejectedTransfer(db, request, actor, transferId, "upload", "insufficient daily quota");
      return quotaResponse(transferId, "rejected", usedToday, actor.id);
    }

    const attachmentId = crypto.randomUUID();
    const storageKey = `workspace/${DEFAULT_SPACE_ID}/${attachmentId}/${safeStorageName(fileName)}`;
    await db.prepare(`
      INSERT INTO attachments (
        id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type,
        byte_size, storage_key, upload_transfer_id, created_at, completed_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, NULL)
    `).run(attachmentId, DEFAULT_SPACE_ID, actor.id, conversationId, visibility, fileName, mimeType, byteSize, storageKey, transferId, now);

    await db.prepare(`
      INSERT INTO transfer_ledger (
        id, space_id, user_id, direction, byte_size, status, attachment_id, created_at, completed_at, released_at
      )
      VALUES (?, ?, ?, 'upload', ?, 'reserved', ?, ?, NULL, NULL)
    `).run(transferId, DEFAULT_SPACE_ID, actor.id, byteSize, attachmentId, now);

    await writeEvent(db, {
      type: "attachment.created",
      actorId: actor.id,
      conversationId,
      targetType: "attachment",
      targetId: attachmentId,
      payload: { attachmentId, transferId, status: "pending", attachment: publicAttachment(await getAttachment(db, attachmentId), actor) }
    });

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "file.upload.reserve",
      targetType: "attachment",
      targetId: attachmentId,
      result: "success"
    });

    return {
      ...quotaResponse(transferId, "reserved", usedToday + byteSize, actor.id),
      attachment: publicAttachment(await getAttachment(db, attachmentId), actor),
      upload: { id: transferId }
    };
  });
}

export async function completeUpload(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const uploadId = normalizeString(input.uploadId);
  const { transfer: row, attachment } = await getReservedUpload(db, actor.id, uploadId);
  const storedByteSize = parseByteSize(input.storageVerifiedByteSize);
  if (storedByteSize !== row.byte_size) {
    await markUploadFailed(db, request, actor, uploadId, attachment.id, "upload.size_mismatch");
    throw new WorkspaceValidationError("upload.size_mismatch", "上传内容大小与预留不一致");
  }

  return await runWorkspaceTransaction(db, async () => {
    const now = new Date().toISOString();
    await db.prepare("UPDATE transfer_ledger SET status = 'completed', completed_at = ? WHERE id = ?").run(now, uploadId);
    await db.prepare("UPDATE attachments SET status = 'available', completed_at = ? WHERE id = ?").run(now, attachment.id);

    const completedAttachment = await getAttachment(db, attachment.id);
    await writeEvent(db, {
      type: "attachment.available",
      actorId: actor.id,
      conversationId: completedAttachment.conversationId,
      targetType: "attachment",
      targetId: completedAttachment.id,
      payload: { attachmentId: completedAttachment.id, status: "available", attachment: publicAttachment(completedAttachment, actor) }
    });
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "file.upload.completed",
      targetType: "attachment",
      targetId: completedAttachment.id,
      result: "success"
    });
    return {
      transfer: quotaResponse(uploadId, "completed", await getUsedToday(db, actor.id), actor.id),
      attachment: publicAttachment(completedAttachment, actor)
    };
  });
}

export async function getReservedUpload(db, actorId, uploadId) {
  await requireActor(db, actorId);
  const row = await db.prepare(`
    SELECT
      tl.id,
      tl.space_id,
      tl.user_id,
      tl.direction,
      tl.byte_size,
      tl.status,
      tl.attachment_id AS attachmentId,
      tl.created_at,
      tl.completed_at,
      tl.released_at
    FROM transfer_ledger tl
    WHERE tl.id = ? AND tl.user_id = ? AND tl.direction = 'upload'
  `).get(normalizeString(uploadId), actorId);
  if (!row || row.status !== "reserved") {
    throw new WorkspaceValidationError("upload.invalid", "上传预留不存在或状态不可完成");
  }

  const attachment = await getAttachment(db, row.attachmentId);
  if (!attachment || attachment.status !== "pending") {
    throw new WorkspaceValidationError("upload.invalid", "上传预留不存在或状态不可完成");
  }

  return { transfer: row, attachment };
}

export async function failUpload(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const uploadId = normalizeString(input.uploadId);
  const row = await db.prepare(`
    SELECT tl.*, a.id AS attachmentId
    FROM transfer_ledger tl
    INNER JOIN attachments a ON a.upload_transfer_id = tl.id
    WHERE tl.id = ? AND tl.user_id = ? AND tl.direction = 'upload'
  `).get(uploadId, actor.id);
  if (!row || row.status !== "reserved") {
    throw new WorkspaceValidationError("upload.invalid", "上传预留不存在或状态不可失败");
  }
  return await markUploadFailed(db, request, actor, uploadId, row.attachmentId, normalizeString(input.reason) || "upload failed");
}

async function markUploadFailed(db, request, actor, uploadId, attachmentId, reason) {
  return await runWorkspaceTransaction(db, async () => {
    const now = new Date().toISOString();
    await db.prepare("UPDATE transfer_ledger SET status = 'failed', released_at = ? WHERE id = ?").run(now, uploadId);
    await db.prepare("UPDATE attachments SET status = 'failed' WHERE id = ?").run(attachmentId);
    const attachment = await getAttachment(db, attachmentId);
    await writeEvent(db, {
      type: "attachment.failed",
      actorId: actor.id,
      conversationId: attachment.conversationId,
      targetType: "attachment",
      targetId: attachment.id,
      payload: { attachmentId: attachment.id, status: "failed", attachment: publicAttachment(attachment, actor) }
    });
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "file.upload.failed",
      targetType: "attachment",
      targetId: attachment.id,
      result: "failure",
      reason
    });
    return {
      transfer: quotaResponse(uploadId, "failed", await getUsedToday(db, actor.id), actor.id),
      attachment: publicAttachment(attachment, actor)
    };
  });
}

export async function listFiles(db, userId = "usr_owner", filters = {}, request) {
  const actor = await requireActor(db, userId);
  await requireCapability(db, request, actor, "file.download", {
    targetType: "workspace"
  });
  const scope = normalizeString(filters.scope || "all");
  const conversationId = normalizeString(filters.conversationId);
  const uploaderId = normalizeString(filters.uploaderId);
  const query = normalizeString(filters.q).toLowerCase();
  const limit = Math.min(parsePositiveInteger(filters.limit, 200), 500);
  const rows = await db.prepare(`
    SELECT
      a.id,
      a.space_id AS spaceId,
      a.uploader_id AS uploaderId,
      u.display_name AS uploaderName,
      c.title AS conversationTitle,
      a.conversation_id AS conversationId,
      a.visibility,
      a.status,
      a.file_name AS fileName,
      a.mime_type AS mimeType,
      a.byte_size AS byteSize,
      a.created_at AS createdAt,
      a.completed_at AS completedAt
    FROM attachments a
    INNER JOIN users u ON u.id = a.uploader_id
    LEFT JOIN conversations c ON c.id = a.conversation_id
    WHERE a.space_id = ?
      AND a.status = 'available'
      AND (
        a.visibility = 'space'
        OR a.uploader_id = ?
        OR (
          a.visibility = 'conversation'
          AND EXISTS (
            SELECT 1 FROM conversation_members cm
            WHERE cm.conversation_id = a.conversation_id
              AND cm.user_id = ?
              AND cm.removed_at IS NULL
          )
        )
      )
    ORDER BY a.created_at DESC
  `).all(DEFAULT_SPACE_ID, actor.id, actor.id);

  return rows.filter((file) => {
    if (scope === "conversation" && !(file.visibility === "conversation" || file.conversationId)) {
      return false;
    }
    if (scope === "standalone" && !(file.visibility === "space" && !file.conversationId)) {
      return false;
    }
    if (scope === "mine" && file.uploaderId !== actor.id) {
      return false;
    }
    if (conversationId && file.conversationId !== conversationId) {
      return false;
    }
    if (uploaderId && file.uploaderId !== uploaderId) {
      return false;
    }
    if (query) {
      const haystack = [
        file.fileName,
        file.uploaderName,
        file.conversationTitle,
        file.mimeType,
        file.visibility
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(query)) {
        return false;
      }
    }
    return true;
  }).slice(0, limit).map((file) => publicAttachment(file, actor));
}

export async function reserveDownload(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  await requireCapability(db, request, actor, "file.download", {
    targetType: "attachment",
    targetId: normalizeString(input.attachmentId)
  });
  const attachmentId = normalizeString(input.attachmentId);
  const attachment = await getDownloadableAttachmentForActor(db, request, actor, attachmentId);

  await releaseStaleUploadReservations(db);
  const now = new Date().toISOString();
  const transferId = crypto.randomUUID();
  return await runWorkspaceTransaction(db, async () => {
    await db.lock(`workspace-quota:${DEFAULT_SPACE_ID}:${actor.id}:${new Date(now).toDateString()}`);
    const usedToday = await getUsedToday(db, actor.id);
    const allowed = canReserveQuota(usedToday, attachment.byteSize);
    if (!allowed) {
      await db.prepare(`
        INSERT INTO transfer_ledger (
          id, space_id, user_id, direction, byte_size, status, attachment_id, created_at, completed_at, released_at
        )
        VALUES (?, ?, ?, 'download', ?, 'rejected', ?, ?, ?, NULL)
      `).run(transferId, DEFAULT_SPACE_ID, actor.id, attachment.byteSize, attachment.id, now, now);
      await writeRejectedTransfer(db, request, actor, transferId, "download", "insufficient daily quota");
      return quotaResponse(transferId, "rejected", usedToday, actor.id);
    }

    await db.prepare(`
      INSERT INTO transfer_ledger (
        id, space_id, user_id, direction, byte_size, status, attachment_id, created_at, completed_at, released_at
      )
      VALUES (?, ?, ?, 'download', ?, 'completed', ?, ?, ?, NULL)
    `).run(transferId, DEFAULT_SPACE_ID, actor.id, attachment.byteSize, attachment.id, now, now);

    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "file.download.reserve",
      targetType: "attachment",
      targetId: attachment.id,
      result: "success"
    });
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "file.download.completed",
      targetType: "attachment",
      targetId: attachment.id,
      result: "success"
    });
    return {
      ...quotaResponse(transferId, "completed", usedToday + attachment.byteSize, actor.id),
      attachment
    };
  });
}

export async function removeAttachment(db, request, input) {
  const actor = await requireActor(db, input.actorId);
  const attachmentId = normalizeString(input.attachmentId);
  const attachment = await getAttachment(db, attachmentId);
  if (!attachment || attachment.spaceId !== DEFAULT_SPACE_ID || attachment.status === "removed") {
    throw new WorkspaceValidationError("file.not_found", "文件不存在或已移除");
  }
  if (attachment.uploaderId !== actor.id && !["owner", "admin"].includes(actor.role)) {
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "file.remove",
      targetType: "attachment",
      targetId: attachmentId,
      result: "rejected",
      reason: "insufficient permission"
    });
    throw new WorkspacePermissionError("permission.denied", "你没有移除此文件的权限");
  }

  return await runWorkspaceTransaction(db, async () => {
    await db.prepare("UPDATE attachments SET status = 'removed' WHERE id = ?").run(attachment.id);
    await writeEvent(db, {
      type: "attachment.removed",
      actorId: actor.id,
      conversationId: attachment.conversationId,
      targetType: "attachment",
      targetId: attachment.id,
      payload: { attachmentId: attachment.id, status: "removed", attachment: publicAttachment({ ...attachment, status: "removed" }, actor) }
    });
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "file.remove",
      targetType: "attachment",
      targetId: attachment.id,
      result: "success"
    });
    return { ok: true, attachmentId: attachment.id };
  });
}

export async function getDownloadableAttachment(db, request, actorId, attachmentId) {
  const actor = await requireActor(db, actorId);
  return await getDownloadableAttachmentForActor(db, request, actor, attachmentId);
}

export async function getCompletedDownload(db, actorId, attachmentId, transferId) {
  const actor = await requireActor(db, actorId);
  const attachment = await getDownloadableAttachmentForActor(db, null, actor, attachmentId);

  const transfer = await db.prepare(`
    SELECT id, byte_size AS byteSize, status, attachment_id AS attachmentId
    FROM transfer_ledger
    WHERE id = ?
      AND user_id = ?
      AND direction = 'download'
      AND attachment_id = ?
      AND status = 'completed'
  `).get(normalizeString(transferId), actor.id, attachment.id);
  if (!transfer) {
    throw new WorkspaceValidationError("download.invalid", "下载预留不存在或已失效");
  }
  return { transfer, attachment };
}

export async function listWorkspaceEvents(db, userId, lastSeq = 0) {
  const actor = await requireActor(db, userId);
  const normalizedSeq = Math.max(0, Number(lastSeq) || 0);
  const rows = await db.prepare(`
    SELECT
      id,
      space_id AS spaceId,
      seq,
      type,
      actor_user_id AS actorId,
      conversation_id AS conversationId,
      target_type AS targetType,
      target_id AS targetId,
      payload_json AS payloadJson,
      created_at AS createdAt
    FROM workspace_events
    WHERE space_id = ? AND seq > ?
    ORDER BY seq ASC
  `).all(DEFAULT_SPACE_ID, normalizedSeq);

  const visibleEvents = [];
  let hasMore = false;
  for (const event of rows) {
    if (!await canSeeEvent(db, actor, event)) {
      continue;
    }
    if (visibleEvents.length >= WORKSPACE_EVENT_REPLAY_LIMIT) {
      hasMore = true;
      break;
    }
    visibleEvents.push(await publicWorkspaceEvent(db, actor, event));
  }
  Object.defineProperty(visibleEvents, "hasMore", {
    value: hasMore,
    enumerable: false
  });
  return visibleEvents;
}

export async function getWorkspaceEventCursor(db) {
  const row = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS currentSeq FROM workspace_events WHERE space_id = ?").get(DEFAULT_SPACE_ID);
  return Number(row?.currentSeq) || 0;
}

export async function getWorkspaceEventForUser(db, userId, eventId) {
  const actor = await requireActor(db, userId);
  const event = await db.prepare(`
    SELECT
      id,
      space_id AS spaceId,
      seq,
      type,
      actor_user_id AS actorId,
      conversation_id AS conversationId,
      target_type AS targetType,
      target_id AS targetId,
      payload_json AS payloadJson,
      created_at AS createdAt
    FROM workspace_events
    WHERE id = ? AND space_id = ?
  `).get(normalizeString(eventId), DEFAULT_SPACE_ID);
  if (!event || !await canSeeEvent(db, actor, event)) {
    return null;
  }
  return await publicWorkspaceEvent(db, actor, event);
}

async function createOrGetDirectConversation(db, request, actor, target) {
  const ids = [actor.id, target.id].sort();
  const directKey = ids.join(":");
  const existing = await db.prepare(`
    SELECT id
    FROM conversations
    WHERE space_id = ? AND direct_key = ?
  `).get(DEFAULT_SPACE_ID, directKey);
  if (existing) {
    return await getConversation(db, actor.id, existing.id);
  }

  return await runWorkspaceTransaction(db, async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const inserted = await db.prepare(`
      INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
      VALUES (?, ?, 'direct', ?, ?, ?, ?, ?)
      ON CONFLICT (space_id, direct_key) DO NOTHING
      RETURNING id
    `).run(id, DEFAULT_SPACE_ID, `${actor.displayName}, ${target.displayName}`, directKey, DEFAULT_RETENTION_COUNT, actor.id, now);
    if (inserted.changes === 0) {
      const winner = await db.prepare(`
        SELECT id FROM conversations WHERE space_id = ? AND direct_key = ?
      `).get(DEFAULT_SPACE_ID, directKey);
      return await getConversation(db, actor.id, winner.id);
    }
    const insertMember = db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
      VALUES (?, ?, ?, NULL)
    `);
    await insertMember.run(id, actor.id, now);
    await insertMember.run(id, target.id, now);
    const createdConversation = await getConversation(db, actor.id, id);

    await writeEvent(db, {
      type: "conversation.created",
      actorId: actor.id,
      conversationId: id,
      targetType: "conversation",
      targetId: id,
      payload: { conversationId: id, type: "direct", memberIds: ids, conversation: await publicConversation(createdConversation) }
    });
    await writeWorkspaceAudit(db, request, {
      actorUserId: actor.id,
      actorGithubLogin: actor.githubLogin,
      action: "conversation.create",
      targetType: "conversation",
      targetId: id,
      result: "success"
    });
    return createdConversation;
  });
}

async function getConversation(db, userId, conversationId, context = {}) {
  const actor = context.actor ?? await requireActor(db, userId);
  await requireCapability(db, context.request ?? null, actor, "conversation.read", {
    targetType: "conversation",
    targetId: conversationId
  });
  await requireConversationMember(db, actor.id, conversationId, context);
  const conversation = await db.prepare(`
    SELECT
      id,
      space_id AS spaceId,
      type,
      title,
      retention_count AS retentionCount,
      created_by AS createdBy,
      created_at AS createdAt,
      COALESCE((
        SELECT MAX(m.created_at)
        FROM messages m
        WHERE m.conversation_id = conversations.id AND m.deleted_at IS NULL
      ), created_at) AS lastActivityAt,
      cm.last_read_message_id AS lastReadMessageId,
      cm.last_read_at AS lastReadAt,
      cm.last_read_seq AS lastReadSeq,
      cm.notification_level AS notificationLevel,
      (
        SELECT COUNT(*)
        FROM messages m
        WHERE m.conversation_id = conversations.id AND m.deleted_at IS NULL
      ) AS messageCount,
      (
        SELECT COUNT(*)
        FROM messages m
        WHERE m.conversation_id = conversations.id
          AND m.deleted_at IS NULL
          AND (m.author_id IS NULL OR m.author_id != ?)
          AND (
            (
              cm.last_read_seq IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM workspace_events we
                WHERE we.type = 'message.created'
                  AND we.target_id = m.id
                  AND we.seq > cm.last_read_seq
              )
            )
            OR (
              cm.last_read_seq IS NULL
              AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
            )
          )
      ) AS unreadCount
    FROM conversations
    INNER JOIN conversation_members cm ON cm.conversation_id = conversations.id AND cm.user_id = ? AND cm.removed_at IS NULL
    WHERE conversations.id = ? AND conversations.space_id = ?
  `).get(actor.id, actor.id, conversationId, DEFAULT_SPACE_ID);
  return await publicConversation({
    ...conversation,
    viewerId: actor.id,
    viewerRole: actor.role,
    members: await listConversationMembers(db, conversationId),
    latestMessages: await listMessages(db, actor.id, conversationId, { limit: 20 })
  }, actor);
}

async function listSpaceMembers(db) {
  return await db.prepare(`
    SELECT
      u.id,
      u.github_login AS githubLogin,
      u.email,
      u.display_name AS displayName,
      u.avatar_url AS avatarUrl,
      u.kind,
      sm.role,
      sm.joined_at AS joinedAt
    FROM space_members sm
    INNER JOIN users u ON u.id = sm.user_id
    WHERE sm.space_id = ? AND sm.removed_at IS NULL
    ORDER BY
      CASE sm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'auditor' THEN 3 ELSE 4 END,
      u.display_name
  `).all(DEFAULT_SPACE_ID);
}

async function getGroupConversationForManage(db, conversationId) {
  if (!conversationId) {
    throw new WorkspaceValidationError("conversation.required", "会话不能为空");
  }
  const conversation = await db.prepare(`
    SELECT id, type
    FROM conversations
    WHERE id = ? AND space_id = ?
  `).get(conversationId, DEFAULT_SPACE_ID);
  if (!conversation) {
    throw new WorkspaceValidationError("conversation.not_found", "会话不存在");
  }
  if (conversation.type !== "group") {
    throw new WorkspaceValidationError("conversation.invalid_type", "只有群聊可以管理成员");
  }
  return conversation;
}

async function listConversationMembers(db, conversationId) {
  return await db.prepare(`
    SELECT
      u.id,
      u.github_login AS githubLogin,
      u.email,
      u.display_name AS displayName,
      u.avatar_url AS avatarUrl,
      u.kind,
      sm.role,
      cm.joined_at AS joinedAt
    FROM conversation_members cm
    INNER JOIN users u ON u.id = cm.user_id
    INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = ?
    WHERE cm.conversation_id = ? AND cm.removed_at IS NULL
    ORDER BY u.display_name
  `).all(DEFAULT_SPACE_ID, conversationId);
}

async function listMessageAttachments(db, messageId) {
  return await db.prepare(`
    SELECT
      a.id,
      a.file_name AS fileName,
      a.mime_type AS mimeType,
      a.byte_size AS byteSize,
      a.status,
      a.visibility
    FROM message_attachments ma
    INNER JOIN attachments a ON a.id = ma.attachment_id
    WHERE ma.message_id = ?
    ORDER BY a.created_at ASC
  `).all(messageId);
}

async function normalizeMessageContent(db, actor, conversationId, content) {
  if (!content || typeof content !== "object") {
    throw new WorkspaceValidationError("message.invalid_content", "消息内容格式无效");
  }
  if (content.format !== MESSAGE_CONTENT_FORMAT) {
    throw new WorkspaceValidationError("message.unsupported_format", "消息格式版本不支持");
  }
  const blocks = Array.isArray(content.blocks) ? content.blocks : [];
  if (blocks.length === 0) {
    throw new WorkspaceValidationError("message.empty", "消息不能为空");
  }

  const normalizedBlocks = await Promise.all(
    blocks.map(async (block) => await normalizeBlock(db, actor, conversationId, block))
  );
  const plainText = buildPlainText(normalizedBlocks).trim();
  if (!plainText) {
    throw new WorkspaceValidationError("message.empty", "消息不能为空");
  }
  return {
    format: MESSAGE_CONTENT_FORMAT,
    plainText,
    blocks: normalizedBlocks
  };
}

async function normalizeBlock(db, actor, conversationId, block) {
  if (!block || typeof block !== "object" || !MESSAGE_BLOCK_TYPES.has(block.type)) {
    throw new WorkspaceValidationError("message.invalid_block", "消息块格式无效");
  }
  if (block.type === "text") {
    const text = normalizeTextBlock(block.text);
    if (!text) {
      throw new WorkspaceValidationError("message.invalid_text", "文本消息不能为空");
    }
    return { type: "text", text };
  }
  if (block.type === "mention") {
    const userId = normalizeString(block.userId);
    const user = await getUserWithRole(db, userId);
    if (!user) {
      throw new WorkspaceValidationError("message.invalid_mention", "提及的成员不存在");
    }
    if (!await isActiveConversationMember(db, userId, conversationId)) {
      throw new WorkspaceValidationError("message.invalid_mention", "只能提及当前会话成员");
    }
    return { type: "mention", userId, label: user.displayName };
  }
  if (block.type === "link") {
    const url = normalizeString(block.url);
    assertAllowedUrl(url);
    const label = normalizeString(block.label);
    return label ? { type: "link", url, label } : { type: "link", url };
  }
  if (block.type === "emoji") {
    const shortcode = normalizeString(block.shortcode);
    if (!/^[a-z0-9_+-]{1,64}$/i.test(shortcode)) {
      throw new WorkspaceValidationError("message.invalid_emoji", "表情格式无效");
    }
    return { type: "emoji", shortcode };
  }
  const attachmentId = normalizeString(block.attachmentId);
  await validateAttachmentForMessage(db, actor, conversationId, attachmentId);
  return { type: "attachment", attachmentId };
}

function buildPlainText(blocks) {
  return blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "mention") return `@${block.label}`;
    if (block.type === "link") return block.label || block.url;
    if (block.type === "emoji") return `:${block.shortcode}:`;
    if (block.type === "attachment") return "[文件]";
    return "";
  }).join("");
}

function extractAttachmentIds(content) {
  return uniqueStrings(content.blocks.filter((block) => block.type === "attachment").map((block) => block.attachmentId));
}

async function validateAttachmentForMessage(db, actor, conversationId, attachmentId) {
  const attachment = await getAttachment(db, attachmentId);
  if (!attachment || attachment.spaceId !== DEFAULT_SPACE_ID || attachment.status !== "available") {
    throw new WorkspaceValidationError("message.invalid_attachment", "附件不可用");
  }
  if (attachment.visibility === "private_staging") {
    throw new WorkspaceValidationError("message.invalid_attachment", "附件尚未发布");
  }
  if (attachment.uploaderId !== actor.id && !["owner", "admin"].includes(actor.role)) {
    await validateAttachmentVisible(db, null, actor, attachment);
  }
  if (attachment.visibility === "conversation" && attachment.conversationId && attachment.conversationId !== conversationId) {
    throw new WorkspaceValidationError("message.invalid_attachment", "附件属于其他会话");
  }
}

async function validateAttachmentVisible(db, request, actor, attachment) {
  if (attachment.visibility === "space") {
    return;
  }
  if (attachment.uploaderId === actor.id || ["owner", "admin"].includes(actor.role)) {
    return;
  }
  if (attachment.visibility === "conversation" && attachment.conversationId) {
    const membership = await db.prepare(`
      SELECT 1
      FROM conversation_members cm
      INNER JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.conversation_id = ?
        AND cm.user_id = ?
        AND cm.removed_at IS NULL
        AND c.space_id = ?
    `).get(attachment.conversationId, actor.id, DEFAULT_SPACE_ID);
    if (membership) {
      return;
    }
    if (request) {
      await rejectPermission(db, request, actor, {
        action: "file.download",
        targetType: "attachment",
        targetId: attachment.id,
        reason: "not a conversation member"
      });
    }
    throw new WorkspacePermissionError("permission.denied", "你没有访问该文件的权限");
  }
  if (request) {
    await rejectPermission(db, request, actor, {
      action: "file.download",
      targetType: "attachment",
      targetId: attachment.id,
      reason: "file not visible"
    });
  }
  throw new WorkspacePermissionError("permission.denied", "你没有访问该文件的权限");
}

async function getDownloadableAttachmentForActor(db, request, actor, attachmentId) {
  const attachment = await getAttachment(db, normalizeString(attachmentId));
  if (!attachment || attachment.status !== "available") {
    throw new WorkspaceValidationError("file.not_found", "文件不存在或不可下载");
  }
  await validateAttachmentVisible(db, request, actor, attachment);
  return attachment;
}

async function getAttachment(db, attachmentId) {
  if (!attachmentId) return null;
  return await db.prepare(`
    SELECT
      a.id,
      a.space_id AS spaceId,
      a.uploader_id AS uploaderId,
      u.display_name AS uploaderName,
      a.conversation_id AS conversationId,
      a.visibility,
      a.status,
      a.file_name AS fileName,
      a.mime_type AS mimeType,
      a.byte_size AS byteSize,
      a.storage_key AS storageKey,
      a.upload_transfer_id AS uploadTransferId,
      a.created_at AS createdAt,
      a.completed_at AS completedAt
    FROM attachments a
    INNER JOIN users u ON u.id = a.uploader_id
    WHERE a.id = ?
  `).get(attachmentId);
}

function publicMember(member, actor = null) {
  if (!member) return null;
  const projectedRole = publicMemberRole(member, actor);
  const canStartDirectConversation = Boolean(
    actor &&
    actor.id !== member.id &&
    member.kind === "human" &&
    member.role !== "auditor" &&
    hasCapability(actor.role, "conversation.create_direct")
  );
  return {
    id: member.id,
    githubLogin: member.githubLogin,
    displayName: member.displayName,
    avatarUrl: member.avatarUrl,
    kind: member.kind,
    role: projectedRole,
    roleLabel: ROLE_LABELS[projectedRole] ?? "成员",
    capabilities: {
      canStartDirectConversation
    },
    joinedAt: member.joinedAt
  };
}

function publicMemberRole(member, actor = null) {
  if (member?.role === "auditor" && actor?.role !== "owner" && actor?.id !== member?.id) {
    return "member";
  }
  return member?.role ?? "member";
}

function publicAttachment(attachment, actor) {
  if (!attachment) return null;
  const canDownload = typeof attachment.capabilities?.canDownload === "boolean"
    ? attachment.capabilities.canDownload
    : attachment.status === "available";
  const canRemove = actor
    ? attachment.status === "available" && (
      attachment.uploaderId === actor.id || ["owner", "admin"].includes(actor.role)
    )
    : Boolean(attachment.capabilities?.canRemove);
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    status: attachment.status,
    visibility: attachment.visibility,
    uploaderId: attachment.uploaderId,
    uploaderName: attachment.uploaderName || actor?.displayName,
    uploader: removeUndefinedValues({
      id: attachment.uploaderId,
      displayName: attachment.uploaderName || actor?.displayName
    }),
    conversationId: attachment.conversationId,
    createdAt: attachment.createdAt,
    completedAt: attachment.completedAt,
    availableAt: attachment.completedAt,
    capabilities: {
      canDownload,
      canRemove
    }
  };
}

async function publicMessage(message, actor = null, db = null) {
  if (!message) return null;
  return {
    id: message.id,
    conversationId: message.conversationId,
    authorId: message.authorId,
    authorName: message.authorName,
    authorGithubLogin: message.authorGithubLogin,
    authorKind: message.authorKind,
    kind: message.kind,
    clientMessageId: message.clientMessageId,
    content: publicMessageContent(message.content),
    plainText: message.plainText,
    replyToMessageId: message.replyToMessageId,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    attachments: message.attachments
      ? await Promise.all(message.attachments.map(async (attachment) =>
        db && actor ? await publicAttachmentPayloadForActor(db, actor, attachment) : publicAttachment(attachment, actor)
      ))
      : []
  };
}

function publicMessageContent(content) {
  if (!content || typeof content !== "object") {
    return {
      format: "",
      plainText: "",
      blocks: []
    };
  }
  return {
    format: publicString(content.format),
    plainText: publicString(content.plainText),
    blocks: Array.isArray(content.blocks) ? content.blocks.map(publicMessageBlock).filter(Boolean) : []
  };
}

function publicMessageBlock(block) {
  if (!block || typeof block !== "object") {
    return null;
  }
  if (block.type === "text") {
    return { type: "text", text: publicString(block.text) };
  }
  if (block.type === "mention") {
    return { type: "mention", userId: publicString(block.userId), label: publicString(block.label) };
  }
  if (block.type === "link") {
    const label = publicString(block.label);
    return removeUndefinedValues({
      type: "link",
      url: publicString(block.url),
      label: label || undefined
    });
  }
  if (block.type === "emoji") {
    return { type: "emoji", shortcode: publicString(block.shortcode) };
  }
  if (block.type === "attachment") {
    return { type: "attachment", attachmentId: publicString(block.attachmentId) };
  }
  return null;
}

async function publicConversation(conversation, actor = null) {
  if (!conversation) return null;
  const members = conversation.members?.map((member) => publicMember(member, actor)) ?? [];
  const latestMessages = conversation.latestMessages
    ? await Promise.all(conversation.latestMessages.map(async (message) => await publicMessage(message)))
    : [];
  const lastMessage = latestMessages.at(-1);
  const otherMember = conversation.type === "direct"
    ? members.find((member) => member.id !== conversation.viewerId) ?? null
    : null;
  const displayTitle = conversation.displayTitle
    ? conversation.displayTitle
    : conversation.type === "direct" && otherMember
    ? otherMember.displayName
    : conversation.title;
  return {
    id: conversation.id,
    spaceId: conversation.spaceId,
    type: conversation.type,
    title: conversation.title,
    displayTitle,
    otherMember,
    retentionCount: conversation.retentionCount,
    retentionText: `保留最近 ${conversation.retentionCount} 条消息`,
    createdAt: conversation.createdAt,
    lastActivityAt: conversation.lastActivityAt,
    messageCount: conversation.messageCount,
    memberCount: members.length,
    lastMessagePlainText: lastMessage?.plainText ?? "",
    lastMessageAt: lastMessage?.createdAt ?? null,
    unreadCount: conversation.unreadCount,
    lastReadMessageId: conversation.lastReadMessageId,
    lastReadAt: conversation.lastReadAt,
    lastReadSeq: conversation.lastReadSeq ?? null,
    notificationLevel: conversation.notificationLevel || "all",
    capabilities: {
      canSendMessage: hasCapability(conversation.viewerRole, "message.create"),
      canUploadFile: hasCapability(conversation.viewerRole, "file.upload"),
      canManageMembers: conversation.type === "group" && hasCapability(conversation.viewerRole, "conversation.member.manage")
    },
    members,
    latestMessages
  };
}

async function enforceRetention(db, conversationId) {
  const conversation = await db.prepare("SELECT retention_count AS retentionCount FROM conversations WHERE id = ?").get(conversationId);
  if (!conversation) {
    return;
  }
  const stale = await db.prepare(`
    SELECT id
    FROM messages
    WHERE conversation_id = ?
      AND deleted_at IS NULL
      AND id NOT IN (
        SELECT id
        FROM messages
        WHERE conversation_id = ?
          AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
  `).all(conversationId, conversationId, conversation.retentionCount);
  for (const message of stale) {
    await db.prepare("UPDATE messages SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?").run(new Date().toISOString(), message.id);
  }
}

async function getUsedToday(db, userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const row = await db.prepare(`
    SELECT COALESCE(SUM(byte_size), 0) AS used
    FROM transfer_ledger
    WHERE space_id = ?
      AND user_id = ?
      AND status IN ('reserved', 'completed')
      AND created_at >= ?
  `).get(DEFAULT_SPACE_ID, userId, startOfDay.toISOString());
  return row.used;
}

export async function releaseStaleUploadReservations(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_UPLOAD_RESERVATION_MS).toISOString();
  const releasedAt = now.toISOString();
  const staleUploads = await db.prepare(`
    SELECT
      tl.id,
      tl.user_id AS userId,
      a.id AS attachmentId,
      a.conversation_id AS conversationId,
      a.uploader_id AS uploaderId
    FROM transfer_ledger tl
    INNER JOIN attachments a ON a.upload_transfer_id = tl.id
    WHERE tl.space_id = ?
      AND tl.direction = 'upload'
      AND tl.status = 'reserved'
      AND tl.created_at < ?
      AND a.status = 'pending'
  `).all(DEFAULT_SPACE_ID, cutoff);

  let releasedCount = 0;
  for (const upload of staleUploads) {
    const released = await runWorkspaceTransaction(db, async () => {
      const result = await db.prepare("UPDATE transfer_ledger SET status = 'failed', released_at = ? WHERE id = ? AND status = 'reserved'").run(releasedAt, upload.id);
      if (result.changes === 0) {
        return false;
      }
      await db.prepare("UPDATE attachments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(upload.attachmentId);
      const actor = await getUserWithRole(db, upload.uploaderId);
      const attachment = await getAttachment(db, upload.attachmentId);
      await writeEvent(db, {
        type: "attachment.failed",
        actorId: upload.uploaderId,
        conversationId: upload.conversationId,
        targetType: "attachment",
        targetId: upload.attachmentId,
        payload: { attachmentId: upload.attachmentId, status: "failed", attachment: publicAttachment(attachment, actor) }
      });
      await writeWorkspaceAudit(db, null, {
        actorUserId: upload.uploaderId,
        actorGithubLogin: actor?.githubLogin,
        action: "file.upload.failed",
        targetType: "attachment",
        targetId: upload.attachmentId,
        result: "failure",
        reason: "stale upload reservation"
      });
      return true;
    });
    if (released) {
      releasedCount += 1;
    }
  }

  return releasedCount;
}

function quotaResponse(id, status, usedToday, userId) {
  const actualUsed = userId ? Math.max(usedToday, 0) : usedToday;
  const response = {
    status,
    usedToday: actualUsed,
    remainingBytes: remainingQuota(actualUsed),
    dailyQuotaBytes: DAILY_QUOTA_BYTES
  };
  if (status !== "rejected") {
    response.id = id;
  }
  return response;
}

async function writeRejectedTransfer(db, request, actor, transferId, direction, reason) {
  const code = "quota.insufficient";
  await writeEvent(db, {
    type: "transfer.rejected",
    actorId: actor.id,
    targetType: "transfer",
    targetId: transferId,
    payload: {
      direction,
      code,
      message: "今日传输额度不足",
      reason: code
    }
  });
  await writeWorkspaceAudit(db, request, {
    actorUserId: actor.id,
    actorGithubLogin: actor.githubLogin,
    action: `file.${direction}.rejected`,
    targetType: "transfer",
    targetId: transferId,
    result: "rejected",
    reason
  });
}

async function writeEvent(db, event) {
  const now = new Date().toISOString();
  const seqRow = await db.prepare(`
    INSERT INTO workspace_event_cursors (space_id, next_seq)
    VALUES (?, 2)
    ON CONFLICT (space_id) DO UPDATE
    SET next_seq = workspace_event_cursors.next_seq + 1
    RETURNING next_seq - 1 AS nextSeq
  `).get(DEFAULT_SPACE_ID);
  const id = event.id || crypto.randomUUID();
  await db.prepare(`
    INSERT INTO workspace_events (
      id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    DEFAULT_SPACE_ID,
    seqRow.nextSeq,
    event.type,
    event.actorId ?? null,
    event.conversationId ?? null,
    event.targetType ?? null,
    event.targetId ?? null,
    JSON.stringify(event.payload ?? {}),
    now
  );
  const writtenEvent = { id, seq: seqRow.nextSeq, spaceId: DEFAULT_SPACE_ID };
  const pendingEvents = workspaceTransactionEvents.getStore();
  if (pendingEvents) {
    pendingEvents.push(writtenEvent);
  } else {
    notifyWorkspaceEventSubscribers(writtenEvent);
  }
  return writtenEvent;
}

export function subscribeWorkspaceEvents(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }
  const subscriber = { listener, pending: null };
  workspaceEventSubscribers.add(subscriber);
  return () => {
    workspaceEventSubscribers.delete(subscriber);
  };
}

function notifyWorkspaceEventSubscribers(event) {
  for (const subscriber of workspaceEventSubscribers) {
    const invoke = () => workspaceEventSubscribers.has(subscriber)
      ? subscriber.listener(event)
      : undefined;
    try {
      subscriber.pending = subscriber.pending
        ? subscriber.pending.then(invoke, invoke)
        : Promise.resolve(invoke());
      const pending = subscriber.pending;
      pending.catch(() => {}).finally(() => {
        if (subscriber.pending === pending) {
          subscriber.pending = null;
        }
      });
    } catch {
      // Realtime fanout must not roll back the persisted Workspace event.
    }
  }
}

async function writeWorkspaceAudit(db, request, event) {
  return await writeAudit(db, {
    ...event,
    spaceId: event.spaceId ?? DEFAULT_SPACE_ID,
    ipAddress: request?.ip,
    userAgent: request?.headers?.["user-agent"],
    requestId: request?.id
  });
}

export async function recordGitHubLoginRejection(db, request, phase) {
  const safePhase = ["token", "profile", "email"].includes(phase) ? phase : "exchange";
  await writeWorkspaceAudit(db, request, {
    action: "login.rejected",
    targetType: "github_oauth",
    targetId: safePhase,
    result: "rejected",
    reason: "auth.github_failed"
  });
}

export async function recordInviteAcceptRejection(db, request, reason) {
  await writeWorkspaceAudit(db, request, {
    action: "invite.accept",
    targetType: "invite",
    result: "rejected",
    reason
  });
}

async function writeConversationCreateRejection(db, request, actor, reason) {
  await writeWorkspaceAudit(db, request, {
    actorUserId: actor.id,
    actorGithubLogin: actor.githubLogin,
    action: "conversation.create",
    targetType: "conversation",
    targetId: "new",
    result: "rejected",
    reason
  });
}

async function writeMutationValidationRejection(db, request, actor, action, targetType, targetId, error) {
  if (!(error instanceof WorkspaceError)) {
    return;
  }
  await writeWorkspaceAudit(db, request, {
    actorUserId: actor.id,
    actorGithubLogin: actor.githubLogin,
    action,
    targetType,
    targetId,
    result: "rejected",
    reason: error.code
  });
}

async function auditMessageCreateRejection(db, request, actor, conversationId, error) {
  if (!(error instanceof WorkspaceError)) {
    return;
  }
  await writeWorkspaceAudit(db, request, {
    actorUserId: actor.id,
    actorGithubLogin: actor.githubLogin,
    action: "message.create",
    targetType: "conversation",
    targetId: conversationId,
    result: "rejected",
    reason: error.code
  });
}

async function canSeeEvent(db, actor, event) {
  if (event.type === "transfer.rejected") {
    return event.actorId === actor.id;
  }
  if (event.type === "conversation.notification_updated") {
    return event.targetType === "user" && event.targetId === actor.id;
  }
  if (event.targetType === "attachment" && event.targetId) {
    return await canSeeAttachmentEvent(db, actor, event);
  }
  if (event.type === "conversation.member_removed" && event.targetType === "user" && event.targetId === actor.id) {
    return true;
  }
  if (!event.conversationId) {
    return actor.role !== "auditor";
  }
  if (!hasCapability(actor.role, "conversation.read")) {
    return false;
  }
  return Boolean(await db.prepare(`
    SELECT 1
    FROM conversation_members
    WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
  `).get(event.conversationId, actor.id));
}

async function canSeeAttachmentEvent(db, actor, event) {
  const attachment = await getAttachment(db, event.targetId);
  if (!attachment || attachment.spaceId !== DEFAULT_SPACE_ID) {
    return false;
  }
  if (attachment.uploaderId === actor.id || ["owner", "admin"].includes(actor.role)) {
    return true;
  }
  if (event.type === "attachment.created" || event.type === "attachment.failed") {
    return false;
  }
  if (attachment.visibility === "space") {
    return actor.role !== "auditor";
  }
  if (attachment.visibility === "conversation" && attachment.conversationId) {
    if (!hasCapability(actor.role, "conversation.read")) {
      return false;
    }
    return Boolean(await db.prepare(`
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = ? AND user_id = ? AND removed_at IS NULL
    `).get(attachment.conversationId, actor.id));
  }
  return false;
}

async function publicWorkspaceEvent(db, actor, event) {
  const publicTargetId = event.type === "transfer.rejected" ? null : event.targetId;
  const payload = await publicWorkspaceEventPayload(db, actor, event.type, JSON.parse(event.payloadJson));
  return {
    id: event.id,
    spaceId: event.spaceId,
    seq: event.seq,
    type: event.type,
    actorId: event.actorId,
    conversationId: event.conversationId,
    targetType: event.targetType,
    targetId: publicTargetId,
    target: event.targetType ? { type: event.targetType, id: publicTargetId } : null,
    payload,
    createdAt: event.createdAt
  };
}

async function publicWorkspaceEventPayload(db, actor, type, payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  if (type === "workspace.member_joined" || type === "workspace.member_updated") {
    const member = await publicMemberPayloadForActor(db, actor, payload.userId || payload.member);
    return removeUndefinedValues({
      userId: normalizeString(payload.userId),
      role: member?.role ?? normalizeString(payload.role),
      member
    });
  }
  if (type === "workspace.member_removed") {
    return removeUndefinedValues({
      userId: normalizeString(payload.userId)
    });
  }
  if (type === "conversation.created" || type === "conversation.updated") {
    return removeUndefinedValues({
      conversationId: normalizeString(payload.conversationId),
      type: normalizeString(payload.type),
      title: normalizeString(payload.title),
      memberIds: Array.isArray(payload.memberIds) ? uniqueStrings(payload.memberIds) : undefined,
      conversation: await publicConversationPayloadForActor(db, actor, payload.conversation)
    });
  }
  if (type === "conversation.member_added") {
    return removeUndefinedValues({
      conversationId: normalizeString(payload.conversationId),
      userId: normalizeString(payload.userId),
      member: await publicMemberPayloadForActor(db, actor, payload.userId || payload.member)
    });
  }
  if (type === "conversation.member_removed") {
    return removeUndefinedValues({
      conversationId: normalizeString(payload.conversationId),
      userId: normalizeString(payload.userId),
      self: payload.self === true ? true : undefined
    });
  }
  if (type === "conversation.notification_updated") {
    return removeUndefinedValues({
      conversationId: normalizeString(payload.conversationId),
      userId: normalizeString(payload.userId),
      notificationLevel: normalizeString(payload.notificationLevel),
      conversation: await publicConversationPayloadForActor(db, actor, payload.conversation)
    });
  }
  if (type === "message.created") {
    return removeUndefinedValues({
      messageId: normalizeString(payload.messageId),
      conversationId: normalizeString(payload.conversationId),
      message: await publicMessagePayloadForActor(db, actor, payload.message || payload.messageId),
      conversation: await publicConversationPayloadForActor(db, actor, payload.conversation)
    });
  }
  if (type === "attachment.created" || type === "attachment.available" || type === "attachment.failed" || type === "attachment.removed") {
    return removeUndefinedValues({
      attachmentId: normalizeString(payload.attachmentId),
      status: normalizeString(payload.status),
      attachment: await publicAttachmentPayloadForActor(db, actor, payload.attachmentId || payload.attachment)
    });
  }
  if (type === "transfer.rejected") {
    return removeUndefinedValues({
      direction: normalizeString(payload.direction),
      code: normalizeString(payload.code),
      message: normalizeString(payload.message),
      reason: normalizeString(payload.reason)
    });
  }
  return {};
}

async function publicConversationPayloadForActor(db, actor, conversation) {
  const conversationId = normalizeString(conversation?.id || conversation?.conversationId);
  if (conversationId) {
    try {
      return await getConversation(db, actor.id, conversationId, { actor });
    } catch {
      return undefined;
    }
  }
  return await publicConversation(conversation, actor);
}

async function publicAttachmentPayloadForActor(db, actor, attachment) {
  const attachmentId = normalizeString(typeof attachment === "string" ? attachment : attachment?.id || attachment?.attachmentId);
  if (attachmentId) {
    const current = await getAttachment(db, attachmentId);
    if (current) {
      return publicAttachment(current, actor);
    }
  }
  return publicAttachment(attachment, actor);
}

async function publicMessagePayloadForActor(db, actor, message) {
  const messageId = normalizeString(typeof message === "string" ? message : message?.id || message?.messageId);
  if (messageId) {
    const row = await db.prepare(`
      SELECT
        m.id,
        m.space_id AS spaceId,
        m.conversation_id AS conversationId,
        m.author_id AS authorId,
        u.display_name AS authorName,
        u.github_login AS authorGithubLogin,
        m.author_kind AS authorKind,
        m.kind,
        m.client_message_id AS clientMessageId,
        m.content_json AS contentJson,
        m.plain_text AS plainText,
        m.reply_to_message_id AS replyToMessageId,
        m.created_at AS createdAt,
        m.edited_at AS editedAt,
        m.deleted_at AS deletedAt
      FROM messages m
      LEFT JOIN users u ON u.id = m.author_id
      WHERE m.id = ? AND m.deleted_at IS NULL
    `).get(messageId);
    if (row) {
      return await publicMessage({
        ...row,
        content: JSON.parse(row.contentJson),
        attachments: await listMessageAttachments(db, row.id)
      }, actor, db);
    }
  }
  return await publicMessage(message, actor, db);
}

async function publicMemberPayloadForActor(db, actor, member) {
  const memberId = normalizeString(typeof member === "string" ? member : member?.id || member?.userId);
  if (memberId) {
    const current = await getUserWithRole(db, memberId);
    if (current) {
      return publicMember(current, actor);
    }
  }
  return publicMember(member, actor);
}

function removeUndefinedValues(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function requireActor(db, userId) {
  const actor = await getUserWithRole(db, normalizeString(userId));
  if (!actor) {
    throw new WorkspaceAuthError("auth.required", "请先登录共享空间");
  }
  return actor;
}

async function getUserWithRole(db, userId) {
  if (!userId) return null;
  return await db.prepare(`
    SELECT
      u.id,
      u.github_id AS githubId,
      u.github_login AS githubLogin,
      u.email,
      u.display_name AS displayName,
      u.avatar_url AS avatarUrl,
      u.kind,
      sm.role,
      sm.joined_at AS joinedAt
    FROM users u
    INNER JOIN space_members sm ON sm.user_id = u.id
    WHERE u.id = ? AND sm.space_id = ? AND sm.removed_at IS NULL
  `).get(userId, DEFAULT_SPACE_ID);
}

async function ensureActiveSpaceMember(db, userId) {
  const user = await getUserWithRole(db, userId);
  if (!user) {
    throw new WorkspaceValidationError("member.not_found", "空间成员不存在");
  }
  return user;
}

async function ensureChatParticipantMember(db, userId) {
  const user = await ensureActiveSpaceMember(db, userId);
  if (!hasCapability(user.role, "conversation.read") || !hasCapability(user.role, "message.create")) {
    throw new WorkspaceValidationError("member.not_chat_participant", "请选择可聊天的空间成员");
  }
  return user;
}

async function isActiveConversationMember(db, userId, conversationId) {
  if (!conversationId || !userId) {
    return false;
  }
  return Boolean(await db.prepare(`
    SELECT 1
    FROM conversation_members cm
    INNER JOIN conversations c ON c.id = cm.conversation_id
    WHERE cm.conversation_id = ?
      AND cm.user_id = ?
      AND cm.removed_at IS NULL
      AND c.space_id = ?
  `).get(conversationId, userId, DEFAULT_SPACE_ID));
}

async function requireConversationMember(db, userId, conversationId, context = {}) {
  if (!conversationId) {
    throw new WorkspaceValidationError("conversation.required", "会话不能为空");
  }
  if (!await isActiveConversationMember(db, userId, conversationId)) {
    if (context.request && context.actor) {
      await rejectPermission(db, context.request, context.actor, {
        action: context.action || "conversation.access",
        targetType: "conversation",
        targetId: conversationId,
        reason: "not a conversation member"
      });
    }
    throw new WorkspacePermissionError("conversation.not_found", "你无法访问此会话");
  }
}

async function requireCapability(db, request, actor, capability, target = {}) {
  if (!hasCapability(actor.role, capability)) {
    await rejectPermission(db, request, actor, {
      action: capability,
      targetType: target.targetType || "workspace",
      targetId: target.targetId,
      reason: "insufficient permission"
    });
    throw new WorkspacePermissionError("permission.denied", "你没有执行该操作的权限");
  }
}

async function rejectPermission(db, request, actor, event) {
  await writeWorkspaceAudit(db, request, {
    actorUserId: actor.id,
    actorGithubLogin: actor.githubLogin,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    result: "rejected",
    reason: event.reason
  });
}

function hasCapability(role, capability) {
  if (role === "owner") {
    return true;
  }
  if (role === "admin") {
    return [
      "invite.create.member",
      "invite.revoke",
      "conversation.read",
      "conversation.create_direct",
      "conversation.create_group",
      "conversation.member.manage",
      "message.create",
      "file.upload",
      "file.download"
    ].includes(capability);
  }
  if (role === "member") {
    return ["conversation.read", "conversation.create_direct", "message.create", "file.upload", "file.download"].includes(capability);
  }
  return false;
}

function canCreateInvite(role, defaultRole) {
  if (role === "owner") {
    return true;
  }
  return role === "admin" && defaultRole === "member" && !PRIVILEGED_INVITE_ROLES.has(defaultRole);
}

function permissionsForRole(role) {
  return {
    canCreateMemberInvite: canCreateInvite(role, "member"),
    canCreatePrivilegedInvite: role === "owner",
    canReadConversations: hasCapability(role, "conversation.read"),
    canCreateGroup: hasCapability(role, "conversation.create_group"),
    canCreateDirect: hasCapability(role, "conversation.create_direct"),
    canUpload: hasCapability(role, "file.upload"),
    canDownload: hasCapability(role, "file.download"),
    canViewOperationRecords: false
  };
}

async function getDefaultSpace(db) {
  return await db.prepare(`
    SELECT id, name, slug, created_by AS createdBy, created_at AS createdAt
    FROM spaces
    WHERE id = ?
  `).get(DEFAULT_SPACE_ID);
}

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function expiresAtFromHours(value, now) {
  const hours = parsePositiveInteger(value, null);
  return hours ? new Date(Date.parse(now) + hours * 60 * 60 * 1000).toISOString() : null;
}

function parseByteSize(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new WorkspaceValidationError("file.invalid_size", "文件大小无效");
  }
  return number;
}

function normalizeRole(role) {
  const normalized = normalizeString(role);
  if (!Object.hasOwn(ROLE_ORDER, normalized)) {
    throw new WorkspaceValidationError("role.invalid", "角色无效");
  }
  return normalized;
}

function normalizeAttachmentVisibility(visibility) {
  const normalized = normalizeString(visibility);
  if (!ATTACHMENT_VISIBILITIES.has(normalized)) {
    throw new WorkspaceValidationError("file.invalid_visibility", "文件可见性无效");
  }
  return normalized;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function publicString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeTextBlock(value) {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return text.trim() ? text : "";
}

function equalsIgnoreCase(left, right) {
  return normalizeString(left).toLowerCase() === normalizeString(right).toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.map(normalizeString).filter(Boolean))];
}

function assertAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new WorkspaceValidationError("message.invalid_link", "链接格式无效");
  }
}

function generateInviteCode() {
  return `DL-${randomBytes(9).toString("base64url").toUpperCase()}`;
}

function hashSecret(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function previewCode(code) {
  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

function safeStorageName(fileName) {
  return fileName.replace(/[^a-z0-9._-]/gi, "_").slice(0, 120) || "file";
}

export class WorkspaceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class WorkspaceValidationError extends WorkspaceError {
  constructor(code, message) {
    super(code, message, 400);
    this.name = "WorkspaceValidationError";
  }
}

export class WorkspacePermissionError extends WorkspaceError {
  constructor(code, message) {
    super(code, message, 403);
    this.name = "WorkspacePermissionError";
  }
}

export class WorkspaceAuthError extends WorkspaceError {
  constructor(code, message) {
    super(code, message, 401);
    this.name = "WorkspaceAuthError";
  }
}
