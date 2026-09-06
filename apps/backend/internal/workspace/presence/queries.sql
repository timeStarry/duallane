-- name: Register :one
INSERT INTO workspace_presence_leases
  (space_id, user_id, connection_id, lease_until, created_at, updated_at)
SELECT sqlc.arg(space_id)::text, u.id, sqlc.arg(connection_id)::text,
       sqlc.arg(lease_until)::timestamptz, sqlc.arg(created_at)::timestamptz,
       sqlc.arg(created_at)::timestamptz
FROM users u
INNER JOIN space_members sm
  ON sm.space_id = sqlc.arg(space_id)::text
 AND sm.user_id = u.id
 AND sm.removed_at IS NULL
WHERE u.id = sqlc.arg(user_id)::text AND u.kind = 'human'
RETURNING connection_id;

-- name: Renew :execrows
UPDATE workspace_presence_leases
SET lease_until = sqlc.arg(lease_until)::timestamptz,
    updated_at = sqlc.arg(now_at)::timestamptz
WHERE space_id = sqlc.arg(space_id)::text
  AND user_id = sqlc.arg(user_id)::text
  AND connection_id = sqlc.arg(connection_id)::text
  AND lease_until > sqlc.arg(now_at)::timestamptz
  AND EXISTS (
    SELECT 1 FROM users u
    INNER JOIN space_members sm
      ON sm.space_id = workspace_presence_leases.space_id
     AND sm.user_id = workspace_presence_leases.user_id
     AND sm.removed_at IS NULL
    WHERE u.id = workspace_presence_leases.user_id AND u.kind = 'human'
  );

-- name: Delete :execrows
DELETE FROM workspace_presence_leases
WHERE space_id = sqlc.arg(space_id)::text
  AND user_id = sqlc.arg(user_id)::text
  AND connection_id = sqlc.arg(connection_id)::text;

-- name: IsOnline :one
SELECT EXISTS (
  SELECT 1 FROM workspace_presence_leases p
  INNER JOIN users u ON u.id = p.user_id AND u.kind = 'human'
  INNER JOIN space_members sm
    ON sm.space_id = p.space_id AND sm.user_id = p.user_id
   AND sm.removed_at IS NULL
  WHERE p.space_id = sqlc.arg(space_id)::text
    AND p.user_id = sqlc.arg(user_id)::text
    AND p.lease_until > sqlc.arg(now_at)::timestamptz
) AS online;

-- name: SweepExpired :execrows
WITH expired AS (
  SELECT space_id, user_id, connection_id
  FROM workspace_presence_leases
  WHERE lease_until <= sqlc.arg(now_at)::timestamptz
  ORDER BY lease_until, space_id, user_id, connection_id
  LIMIT sqlc.arg(batch_size)::integer
  FOR UPDATE SKIP LOCKED
)
DELETE FROM workspace_presence_leases p
USING expired
WHERE p.space_id = expired.space_id
  AND p.user_id = expired.user_id
  AND p.connection_id = expired.connection_id;
