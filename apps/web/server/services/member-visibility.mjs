export const MEMBER_VISIBILITY_BASIS = "direct_contacts";

export async function listVisibleMemberIds(db, { spaceId, actor }) {
  if (actor.role === "owner") {
    const rows = await db.prepare(`
      SELECT user_id AS userId
      FROM space_members
      WHERE space_id = ? AND removed_at IS NULL
    `).all(spaceId);
    return new Set(rows.map((row) => row.userId));
  }

  const rows = await db.prepare(`
    SELECT sm.user_id AS userId
    FROM space_members sm
    WHERE sm.space_id = ?
      AND sm.removed_at IS NULL
      AND (
        sm.user_id = ?
        OR EXISTS (
          SELECT 1
          FROM conversations c
          INNER JOIN conversation_members viewer_cm
            ON viewer_cm.conversation_id = c.id
            AND viewer_cm.user_id = ?
            AND viewer_cm.removed_at IS NULL
          INNER JOIN conversation_members visible_cm
            ON visible_cm.conversation_id = c.id
            AND visible_cm.user_id = sm.user_id
            AND visible_cm.removed_at IS NULL
          WHERE c.space_id = ? AND c.type = 'direct'
        )
        OR EXISTS (
          SELECT 1
          FROM member_visibility_grants grant_row
          WHERE grant_row.space_id = ?
            AND grant_row.viewer_user_id = ?
            AND grant_row.visible_user_id = sm.user_id
        )
      )
  `).all(spaceId, actor.id, actor.id, spaceId, spaceId, actor.id);
  return new Set(rows.map((row) => row.userId));
}

export async function canViewMember(db, { spaceId, actor, visibleUserId }) {
  if (!visibleUserId) {
    return false;
  }
  const visibleIds = await listVisibleMemberIds(db, { spaceId, actor });
  return visibleIds.has(visibleUserId);
}

export async function getMemberVisibilityRule(db, { spaceId, viewerUserId }) {
  const automaticRows = await db.prepare(`
    SELECT DISTINCT visible_cm.user_id AS userId
    FROM conversations c
    INNER JOIN conversation_members viewer_cm
      ON viewer_cm.conversation_id = c.id
      AND viewer_cm.user_id = ?
      AND viewer_cm.removed_at IS NULL
    INNER JOIN conversation_members visible_cm
      ON visible_cm.conversation_id = c.id
      AND visible_cm.user_id != ?
      AND visible_cm.removed_at IS NULL
    INNER JOIN space_members visible_sm
      ON visible_sm.space_id = c.space_id
      AND visible_sm.user_id = visible_cm.user_id
      AND visible_sm.removed_at IS NULL
    WHERE c.space_id = ? AND c.type = 'direct'
  `).all(viewerUserId, viewerUserId, spaceId);
  const grantedRows = await db.prepare(`
    SELECT visible_user_id AS userId
    FROM member_visibility_grants
    WHERE space_id = ? AND viewer_user_id = ?
    ORDER BY visible_user_id
  `).all(spaceId, viewerUserId);
  const automaticUserIds = automaticRows.map((row) => row.userId);
  const grantedUserIds = grantedRows.map((row) => row.userId);
  return {
    basis: MEMBER_VISIBILITY_BASIS,
    viewerUserId,
    automaticUserIds,
    grantedUserIds,
    visibleUserIds: Array.from(new Set([viewerUserId, ...automaticUserIds, ...grantedUserIds]))
  };
}

export async function replaceMemberVisibilityGrants(db, {
  spaceId,
  viewerUserId,
  visibleUserIds,
  createdBy,
  createdAt
}) {
  await db.prepare(`
    DELETE FROM member_visibility_grants
    WHERE space_id = ? AND viewer_user_id = ?
  `).run(spaceId, viewerUserId);
  for (const visibleUserId of visibleUserIds) {
    await db.prepare(`
      INSERT INTO member_visibility_grants (
        space_id, viewer_user_id, visible_user_id, created_by, created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(spaceId, viewerUserId, visibleUserId, createdBy, createdAt);
  }
}