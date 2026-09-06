package avatars

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// PGRepository is the PostgreSQL implementation for the avatar logical
// reference and content-addressed object boundary. It deliberately uses the
// existing migration-025 tables and does not introduce avatar-specific
// schema history.
type PGRepository struct {
	pool *pgxpool.Pool
}

func NewPGRepository(pool *pgxpool.Pool) *PGRepository {
	return &PGRepository{pool: pool}
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin workspace avatar transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin workspace avatar transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin workspace avatar transaction", err)
	}
	committed := false
	defer func() {
		if !committed {
			rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), avatarStorageIOTimeout)
			_ = tx.Rollback(rollbackCtx)
			cancel()
		}
	}()
	if err := callback(&pgTx{tx: tx}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return internalError("commit workspace avatar transaction", err)
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup workspace avatar actor", errors.New("workspace postgres pool is required"))
	}
	return lookupAvatarActor(ctx, r.pool, spaceID, userID)
}

func (r *PGRepository) GetCurrentAvatar(ctx context.Context, spaceID, userID string) (*AvatarRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read current workspace avatar", errors.New("workspace postgres pool is required"))
	}
	return getCurrentAvatar(ctx, r.pool, spaceID, userID, false)
}

func (r *PGRepository) FindVisibleAvatar(ctx context.Context, spaceID, viewerID, userID, version string) (*AvatarRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read visible workspace avatar", errors.New("workspace postgres pool is required"))
	}
	return findVisibleAvatar(ctx, r.pool, spaceID, viewerID, userID, version)
}

func (r *PGRepository) StorageObject(ctx context.Context, objectID string) (*StorageObjectRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace avatar storage object", errors.New("workspace postgres pool is required"))
	}
	return loadStorageObject(ctx, r.pool, objectID, false)
}

func (r *PGRepository) StorageObjectReferenceCount(ctx context.Context, objectID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count workspace avatar storage references", errors.New("workspace postgres pool is required"))
	}
	return countStorageReferences(ctx, r.pool, objectID)
}

type pgTx struct {
	tx pgx.Tx
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupAvatarActor(ctx, t.tx, spaceID, userID)
}

func (t *pgTx) GetCurrentAvatarForUpdate(ctx context.Context, spaceID, userID string) (*AvatarRecord, error) {
	return getCurrentAvatar(ctx, t.tx, spaceID, userID, true)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return internalError("lock workspace avatar resource", errors.New("lock key is required"))
	}
	if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); err != nil {
		return internalError("lock workspace avatar resource", err)
	}
	return nil
}

func (t *pgTx) EnsureStorageObjectAndBind(ctx context.Context, spaceID, userID string, object StorageObjectRecord) error {
	validated, err := validateStorageObject(object)
	if err != nil {
		return err
	}
	var registered StorageObjectRecord
	var contentType string
	if err := t.tx.QueryRow(ctx, `
		INSERT INTO workspace_storage_objects (
			id, sha256, object_key, byte_size, content_type, created_at, verified_at, deleted_at
		) VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, NULL)
		ON CONFLICT (sha256) DO UPDATE SET
			content_type = COALESCE(workspace_storage_objects.content_type, EXCLUDED.content_type),
			verified_at = COALESCE(workspace_storage_objects.verified_at, EXCLUDED.verified_at),
			deleted_at = NULL
		RETURNING id, sha256, object_key, byte_size, COALESCE(content_type, ''), created_at, verified_at, deleted_at
	`, validated.ID, validated.SHA256, validated.ObjectKey, validated.ByteSize, validated.ContentType,
		validated.CreatedAt.UTC(), nullableAvatarTime(validated.VerifiedAt)).Scan(
		&registered.ID, &registered.SHA256, &registered.ObjectKey, &registered.ByteSize, &contentType,
		&registered.CreatedAt, &registered.VerifiedAt, &registered.DeletedAt); err != nil {
		return internalError("register workspace avatar storage object", err)
	}
	registered.ContentType = contentType
	normalizeStorageObjectTime(&registered)
	if registered.ID != validated.ID || registered.SHA256 != validated.SHA256 || registered.ObjectKey != validated.ObjectKey || registered.ByteSize != validated.ByteSize {
		return internalError("validate workspace avatar storage object", errors.New("storage registry identity mismatch"))
	}
	result, err := t.tx.Exec(ctx, `UPDATE users AS u
		SET avatar_storage_object_id = $3
		FROM space_members sm
		WHERE u.id = $1 AND u.kind = 'human'
		  AND sm.space_id = $2 AND sm.user_id = u.id AND sm.removed_at IS NULL`, userID, spaceID, registered.ID)
	if err != nil {
		return internalError("bind workspace avatar storage object", err)
	}
	if result.RowsAffected() != 1 {
		return authRequiredError()
	}
	return nil
}

func (t *pgTx) UpdateAvatar(ctx context.Context, spaceID, userID, storageKey, version, avatarURL, storageObjectID string, updatedAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE users AS u
		SET avatar_storage_key = $3, avatar_version = $4, avatar_updated_at = $5,
			avatar_url = $6, avatar_storage_object_id = $7
		FROM space_members sm
		WHERE u.id = $1 AND u.kind = 'human'
		  AND sm.space_id = $2 AND sm.user_id = u.id AND sm.removed_at IS NULL`,
		userID, spaceID, storageKey, version, normalizeAvatarTime(updatedAt), avatarURL, storageObjectID)
	if err != nil {
		return false, internalError("update workspace avatar", err)
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) ClearAvatar(ctx context.Context, spaceID, userID string, updatedAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE users AS u
		SET avatar_storage_key = NULL, avatar_version = NULL, avatar_updated_at = NULL,
			avatar_url = github_avatar_url, avatar_storage_object_id = NULL
		FROM space_members sm
		WHERE u.id = $1 AND u.kind = 'human'
		  AND sm.space_id = $2 AND sm.user_id = u.id AND sm.removed_at IS NULL`,
		userID, spaceID)
	if err != nil {
		return false, internalError("remove workspace avatar", err)
	}
	_ = updatedAt
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) PrepareStorageObjectCleanup(ctx context.Context, objectID string, fallback StorageObjectRecord) (StorageCleanup, error) {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		if strings.TrimSpace(fallback.ObjectKey) == "" {
			return StorageCleanup{}, nil
		}
		return StorageCleanup{Object: &fallback, DeleteObject: true}, nil
	}
	var lockedID string
	if err := t.tx.QueryRow(ctx, `SELECT id FROM workspace_storage_objects WHERE id = $1 FOR UPDATE`, objectID).Scan(&lockedID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if strings.TrimSpace(fallback.ObjectKey) == "" {
				return StorageCleanup{}, nil
			}
			return StorageCleanup{Object: &fallback, DeleteObject: true}, nil
		}
		return StorageCleanup{}, internalError("lock workspace avatar storage object", err)
	}
	object, err := loadStorageObject(ctx, t.tx, objectID, true)
	if err != nil {
		return StorageCleanup{}, err
	}
	if object == nil {
		return StorageCleanup{}, nil
	}
	references, err := countStorageReferences(ctx, t.tx, object.ID)
	if err != nil {
		return StorageCleanup{}, err
	}
	if references > 0 {
		return StorageCleanup{Object: object, References: references, Registered: true}, nil
	}
	return StorageCleanup{Object: object, DeleteObject: true, Registered: true}, nil
}

func (t *pgTx) MarkStorageObjectDeleted(ctx context.Context, objectID string, at time.Time) error {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return internalError("tombstone workspace avatar storage object", errors.New("storage object id is required"))
	}
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_storage_objects
		SET deleted_at = COALESCE(deleted_at, $2)
		WHERE id = $1 AND deleted_at IS NULL
		  AND NOT EXISTS (SELECT 1 FROM attachments WHERE storage_object_id = $1)
		  AND NOT EXISTS (SELECT 1 FROM users WHERE avatar_storage_object_id = $1)
		  AND NOT EXISTS (SELECT 1 FROM workspace_custom_emotes WHERE storage_object_id = $1)
	`, objectID, normalizeAvatarTime(at))
	if err != nil {
		return internalError("tombstone workspace avatar storage object", err)
	}
	if result.RowsAffected() != 1 {
		return internalError("tombstone workspace avatar storage object", errors.New("storage object references changed"))
	}
	return nil
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) error {
	if strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Type) == "" || input.CreatedAt.IsZero() {
		return internalError("write workspace avatar event", errors.New("event fields are required"))
	}
	payload := input.PayloadJSON
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}
	if !json.Valid(payload) {
		return internalError("write workspace avatar event", errors.New("event payload is not valid JSON"))
	}
	var sequence int64
	err := t.tx.QueryRow(ctx, `INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM workspace_events WHERE space_id = $1), 1))
		ON CONFLICT (space_id) DO NOTHING
		RETURNING next_seq`, input.SpaceID).Scan(&sequence)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := t.tx.QueryRow(ctx, `SELECT next_seq FROM workspace_event_cursors WHERE space_id = $1 FOR UPDATE`, input.SpaceID).Scan(&sequence); err != nil {
			return internalError("lock workspace avatar event cursor", err)
		}
		if _, err := t.tx.Exec(ctx, `UPDATE workspace_event_cursors SET next_seq = next_seq + 1 WHERE space_id = $1`, input.SpaceID); err != nil {
			return internalError("advance workspace avatar event cursor", err)
		}
	} else if err != nil {
		return internalError("reserve workspace avatar event sequence", err)
	} else if _, err := t.tx.Exec(ctx, `UPDATE workspace_event_cursors SET next_seq = next_seq + 1 WHERE space_id = $1`, input.SpaceID); err != nil {
		return internalError("advance workspace avatar event cursor", err)
	}
	_, err = t.tx.Exec(ctx, `INSERT INTO workspace_events (
		id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
	) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)`,
		input.ID, input.SpaceID, sequence, input.Type, input.ActorID, input.ConversationID,
		input.TargetType, input.TargetID, string(payload), normalizeAvatarTime(input.CreatedAt))
	if err != nil {
		return internalError("write workspace avatar event", err)
	}
	return nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" || input.CreatedAt.IsZero() {
		return internalError("write workspace avatar audit", errors.New("audit fields are required"))
	}
	result := strings.TrimSpace(input.Result)
	if result == "" {
		result = "success"
	}
	if result != "success" && result != "failure" && result != "rejected" {
		return internalError("write workspace avatar audit", errors.New("audit result is invalid"))
	}
	meta := (auth.RequestMeta{RequestID: input.RequestID, IPAddress: input.IPAddress, UserAgent: input.UserAgent}).Safe()
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (
		id, space_id, actor_user_id, actor_github_login, action, target_type, target_id,
		result, reason, ip_address, user_agent, request_id, created_at
	) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8,
		NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`,
		input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action,
		input.TargetType, input.TargetID, result, input.Reason, meta.IPAddress, meta.UserAgent,
		meta.RequestID, normalizeAvatarTime(input.CreatedAt))
	if err != nil {
		return internalError("write workspace avatar audit", err)
	}
	return nil
}

type avatarQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

const avatarProjection = `
	u.id, u.avatar_version, u.avatar_storage_key, u.avatar_storage_object_id,
	u.avatar_url, u.github_avatar_url, u.search_discoverable,
	so.id, so.sha256, so.object_key, so.byte_size, COALESCE(so.content_type, ''),
	so.created_at, so.verified_at, so.deleted_at`

func getCurrentAvatar(ctx context.Context, queryer avatarQueryer, spaceID, userID string, forUpdate bool) (*AvatarRecord, error) {
	query := `SELECT ` + avatarProjection + `
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		LEFT JOIN workspace_storage_objects so
			ON so.id = u.avatar_storage_object_id AND so.deleted_at IS NULL
		WHERE u.id = $1 AND u.kind = 'human' AND sm.space_id = $2 AND sm.removed_at IS NULL`
	if forUpdate {
		query += ` FOR UPDATE OF u`
	}
	return scanAvatarRow(queryer.QueryRow(ctx, query, userID, spaceID))
}

func findVisibleAvatar(ctx context.Context, queryer avatarQueryer, spaceID, viewerID, userID, version string) (*AvatarRecord, error) {
	return scanAvatarRow(queryer.QueryRow(ctx, `SELECT `+avatarProjection+`
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		LEFT JOIN workspace_storage_objects so
			ON so.id = u.avatar_storage_object_id AND so.deleted_at IS NULL
		WHERE u.id = $3 AND u.kind = 'human' AND u.avatar_version = $4
		  AND u.avatar_storage_key IS NOT NULL
		  AND sm.space_id = $1 AND sm.removed_at IS NULL
		  AND (
			u.id = $2
			OR u.search_discoverable
			OR EXISTS (
				SELECT 1 FROM space_members owner_sm
				WHERE owner_sm.space_id = $1 AND owner_sm.user_id = $2
				  AND owner_sm.role = 'owner' AND owner_sm.removed_at IS NULL
			)
			OR EXISTS (
				SELECT 1
				FROM conversations c
				INNER JOIN conversation_members viewer_cm
					ON viewer_cm.conversation_id = c.id AND viewer_cm.user_id = $2 AND viewer_cm.removed_at IS NULL
				INNER JOIN conversation_members visible_cm
					ON visible_cm.conversation_id = c.id AND visible_cm.user_id = u.id AND visible_cm.removed_at IS NULL
				WHERE c.space_id = $1 AND c.type = 'direct'
			)
			OR EXISTS (
				SELECT 1 FROM member_visibility_grants grant_row
				WHERE grant_row.space_id = $1 AND grant_row.viewer_user_id = $2
				  AND grant_row.visible_user_id = u.id
			)
		  )`, spaceID, viewerID, userID, version))
}

func lookupAvatarActor(ctx context.Context, queryer avatarQueryer, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	if err := queryer.QueryRow(ctx, `SELECT u.id, u.github_id, u.github_login, u.email,
		u.display_name, u.nickname, u.avatar_url, u.search_discoverable, u.kind,
		sm.role, sm.joined_at
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = $2 AND sm.removed_at IS NULL
		WHERE u.id = $1`, userID, spaceID).Scan(
		&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName, &nickname,
		&avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &actor.JoinedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, internalError("lookup workspace avatar actor", err)
	}
	if githubID != nil {
		actor.GitHubID = *githubID
	}
	if email != nil {
		actor.Email = *email
	}
	if nickname != nil {
		actor.Nickname = *nickname
	}
	if avatarURL != nil {
		actor.AvatarURL = *avatarURL
	}
	actor.JoinedAt = actor.JoinedAt.UTC()
	return &actor, nil
}

func scanAvatarRow(row pgx.Row) (*AvatarRecord, error) {
	var record AvatarRecord
	var version, storageKey, storageObjectID, avatarURL, githubAvatarURL *string
	var searchDiscoverable bool
	var objectID, digest, objectKey, contentType *string
	var byteSize *int64
	var createdAt, verifiedAt, deletedAt *time.Time
	if err := row.Scan(&record.UserID, &version, &storageKey, &storageObjectID, &avatarURL, &githubAvatarURL,
		&searchDiscoverable, &objectID, &digest, &objectKey, &byteSize, &contentType,
		&createdAt, &verifiedAt, &deletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, internalError("scan workspace avatar", err)
	}
	if version != nil {
		record.Version = *version
	}
	if storageKey != nil {
		record.StorageKey = *storageKey
	}
	if storageObjectID != nil {
		record.StorageObjectID = *storageObjectID
	}
	if avatarURL != nil {
		record.AvatarURL = *avatarURL
	}
	if githubAvatarURL != nil {
		record.GitHubAvatarURL = *githubAvatarURL
	}
	record.SearchDiscoverable = searchDiscoverable
	if objectID != nil && strings.TrimSpace(*objectID) != "" {
		object := &StorageObjectRecord{ID: *objectID}
		if digest != nil {
			object.SHA256 = *digest
		}
		if objectKey != nil {
			object.ObjectKey = *objectKey
		}
		if byteSize != nil {
			object.ByteSize = *byteSize
		}
		if contentType != nil {
			object.ContentType = *contentType
		}
		if createdAt != nil {
			object.CreatedAt = createdAt.UTC()
		}
		if verifiedAt != nil {
			value := verifiedAt.UTC()
			object.VerifiedAt = &value
		}
		if deletedAt != nil {
			value := deletedAt.UTC()
			object.DeletedAt = &value
		}
		record.StorageObject = object
	}
	return &record, nil
}

func loadStorageObject(ctx context.Context, queryer avatarQueryer, objectID string, includeDeleted bool) (*StorageObjectRecord, error) {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return nil, nil
	}
	query := `SELECT id, sha256, object_key, byte_size, COALESCE(content_type, ''),
		created_at, verified_at, deleted_at FROM workspace_storage_objects WHERE id = $1`
	if !includeDeleted {
		query += ` AND deleted_at IS NULL`
	}
	var record StorageObjectRecord
	if err := queryer.QueryRow(ctx, query, objectID).Scan(&record.ID, &record.SHA256, &record.ObjectKey,
		&record.ByteSize, &record.ContentType, &record.CreatedAt, &record.VerifiedAt, &record.DeletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, internalError("load workspace avatar storage object", err)
	}
	normalizeStorageObjectTime(&record)
	return &record, nil
}

func countStorageReferences(ctx context.Context, queryer avatarQueryer, objectID string) (int64, error) {
	var count int64
	if err := queryer.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM attachments WHERE storage_object_id = $1) +
		(SELECT COUNT(*) FROM users WHERE avatar_storage_object_id = $1) +
		(SELECT COUNT(*) FROM workspace_custom_emotes WHERE storage_object_id = $1)`, objectID).Scan(&count); err != nil {
		return 0, internalError("count workspace avatar storage references", err)
	}
	return count, nil
}

func validateStorageObject(object StorageObjectRecord) (StorageObjectRecord, error) {
	digest, err := platformstorage.NormalizeSHA256(object.SHA256)
	if err != nil {
		return StorageObjectRecord{}, normalizeRepositoryError(err)
	}
	objectKey, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		return StorageObjectRecord{}, normalizeRepositoryError(err)
	}
	if object.ID != "wso_"+digest || object.ObjectKey != objectKey || object.ByteSize < 0 || object.ByteSize > platformstorage.DefaultMaxObjectBytes || object.CreatedAt.IsZero() {
		return StorageObjectRecord{}, internalError("validate workspace avatar storage object", errors.New("storage registry identity is invalid"))
	}
	object.SHA256 = digest
	object.ObjectKey = objectKey
	return object, nil
}

func normalizeStorageObjectTime(record *StorageObjectRecord) {
	if record == nil {
		return
	}
	if !record.CreatedAt.IsZero() {
		record.CreatedAt = record.CreatedAt.UTC()
	}
	if record.VerifiedAt != nil {
		value := record.VerifiedAt.UTC()
		record.VerifiedAt = &value
	}
	if record.DeletedAt != nil {
		value := record.DeletedAt.UTC()
		record.DeletedAt = &value
	}
}

func normalizeAvatarTime(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}

func nullableAvatarTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return normalizeAvatarTime(*value)
}

var _ Repository = (*PGRepository)(nil)
