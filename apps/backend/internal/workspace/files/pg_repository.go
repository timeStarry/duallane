package files

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// PGRepository is the native PostgreSQL adapter for the Workspace files
// boundary. It intentionally exposes only Repository methods; callers never
// receive a general-purpose SQL handle.
type PGRepository struct {
	pool      *pgxpool.Pool
	idFactory IDFactory
}

func NewPGRepository(pool *pgxpool.Pool, idFactories ...IDFactory) *PGRepository {
	idFactory := IDFactory(func() (string, error) {
		id, err := uuid.NewRandom()
		if err != nil {
			return "", err
		}
		return id.String(), nil
	})
	if len(idFactories) > 0 && idFactories[0] != nil {
		idFactory = idFactories[0]
	}
	return &PGRepository{pool: pool, idFactory: idFactory}
}

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return internalError("ping workspace files database", errors.New("workspace postgres pool is required"))
	}
	if err := r.pool.Ping(ctx); err != nil {
		return internalError("ping workspace files database", err)
	}
	return nil
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin workspace files transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin workspace files transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin workspace files transaction", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()
	adapter := &pgTx{tx: tx, repository: r}
	if err := callback(adapter); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return internalError("commit workspace files transaction", err)
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup workspace file actor", errors.New("workspace postgres pool is required"))
	}
	return lookupActor(ctx, r.pool, spaceID, userID)
}

func (r *PGRepository) GetAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get workspace attachment", errors.New("workspace postgres pool is required"))
	}
	return getAttachment(ctx, r.pool, spaceID, attachmentID)
}

func (r *PGRepository) ListAttachments(ctx context.Context, query AttachmentListQuery) ([]AttachmentRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace attachments", errors.New("workspace postgres pool is required"))
	}
	return listAttachments(ctx, r.pool, query)
}

func (r *PGRepository) GetTransfer(ctx context.Context, spaceID, userID, transferID string, direction TransferDirection) (*TransferRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get workspace transfer", errors.New("workspace postgres pool is required"))
	}
	return getTransfer(ctx, r.pool, spaceID, userID, transferID, direction)
}

func (r *PGRepository) ListUploadParts(ctx context.Context, uploadID string) ([]UploadPartRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace upload parts", errors.New("workspace postgres pool is required"))
	}
	return listUploadParts(ctx, r.pool, uploadID)
}

func (r *PGRepository) GetUploadPart(ctx context.Context, uploadID string, partNumber int) (*UploadPartRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get workspace upload part", errors.New("workspace postgres pool is required"))
	}
	return getUploadPart(ctx, r.pool, uploadID, partNumber)
}

func (r *PGRepository) UsedTransferBytes(ctx context.Context, spaceID, userID string, since time.Time) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("read workspace transfer quota", errors.New("workspace postgres pool is required"))
	}
	return usedTransferBytes(ctx, r.pool, spaceID, userID, since)
}

func (r *PGRepository) ListStaleUploads(ctx context.Context, spaceID string, before time.Time) ([]StaleUploadRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list stale workspace uploads", errors.New("workspace postgres pool is required"))
	}
	return listStaleUploads(ctx, r.pool, spaceID, before)
}

func (r *PGRepository) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check workspace conversation membership", errors.New("workspace postgres pool is required"))
	}
	return conversationMemberActive(ctx, r.pool, spaceID, conversationID, userID)
}

func (r *PGRepository) ParticipantOnlyConversation(ctx context.Context, spaceID, conversationID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check workspace conversation type", errors.New("workspace postgres pool is required"))
	}
	return participantOnlyConversation(ctx, r.pool, spaceID, conversationID)
}

func (r *PGRepository) StorageObject(ctx context.Context, objectID string) (*StorageObjectRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get workspace storage object", errors.New("workspace postgres pool is required"))
	}
	return loadStorageObject(ctx, r.pool, objectID, false)
}

func (r *PGRepository) StorageObjectReferenceCount(ctx context.Context, objectID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count workspace storage references", errors.New("workspace postgres pool is required"))
	}
	return countStorageReferences(ctx, r.pool, objectID)
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID)
}

func (t *pgTx) GetAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error) {
	return getAttachment(ctx, t.tx, spaceID, attachmentID)
}

func (t *pgTx) ListAttachments(ctx context.Context, query AttachmentListQuery) ([]AttachmentRecord, error) {
	return listAttachments(ctx, t.tx, query)
}

func (t *pgTx) GetTransfer(ctx context.Context, spaceID, userID, transferID string, direction TransferDirection) (*TransferRecord, error) {
	return getTransfer(ctx, t.tx, spaceID, userID, transferID, direction)
}

func (t *pgTx) ListUploadParts(ctx context.Context, uploadID string) ([]UploadPartRecord, error) {
	return listUploadParts(ctx, t.tx, uploadID)
}

func (t *pgTx) GetUploadPart(ctx context.Context, uploadID string, partNumber int) (*UploadPartRecord, error) {
	return getUploadPart(ctx, t.tx, uploadID, partNumber)
}

func (t *pgTx) UsedTransferBytes(ctx context.Context, spaceID, userID string, since time.Time) (int64, error) {
	return usedTransferBytes(ctx, t.tx, spaceID, userID, since)
}

func (t *pgTx) ListStaleUploads(ctx context.Context, spaceID string, before time.Time) ([]StaleUploadRecord, error) {
	return listStaleUploads(ctx, t.tx, spaceID, before)
}

func (t *pgTx) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	return conversationMemberActive(ctx, t.tx, spaceID, conversationID, userID)
}

func (t *pgTx) ParticipantOnlyConversation(ctx context.Context, spaceID, conversationID string) (bool, error) {
	return participantOnlyConversation(ctx, t.tx, spaceID, conversationID)
}

func (t *pgTx) StorageObject(ctx context.Context, objectID string) (*StorageObjectRecord, error) {
	return loadStorageObject(ctx, t.tx, objectID, false)
}

func (t *pgTx) StorageObjectReferenceCount(ctx context.Context, objectID string) (int64, error) {
	return countStorageReferences(ctx, t.tx, objectID)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	if strings.TrimSpace(key) == "" {
		return internalError("lock workspace file resource", errors.New("lock key is required"))
	}
	if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); err != nil {
		return internalError("lock workspace file resource", err)
	}
	return nil
}

func (t *pgTx) CreateTransfer(ctx context.Context, transfer TransferRecord) error {
	if strings.TrimSpace(transfer.ID) == "" || strings.TrimSpace(transfer.SpaceID) == "" || strings.TrimSpace(transfer.UserID) == "" || transfer.CreatedAt.IsZero() {
		return internalError("create workspace transfer", errors.New("transfer fields are required"))
	}
	_, err := t.tx.Exec(ctx, `INSERT INTO transfer_ledger (
		id, space_id, user_id, direction, byte_size, status, attachment_id,
		created_at, completed_at, released_at, last_activity_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		transfer.ID, transfer.SpaceID, transfer.UserID, transfer.Direction, transfer.ByteSize, transfer.Status,
		transfer.AttachmentID, normalizeTime(transfer.CreatedAt), nullableTime(transfer.CompletedAt),
		nullableTime(transfer.ReleasedAt), nullableTime(transfer.LastActivityAt))
	if err != nil {
		return internalError("create workspace transfer", err)
	}
	return nil
}

func (t *pgTx) CreateAttachment(ctx context.Context, attachment AttachmentRecord) error {
	if strings.TrimSpace(attachment.ID) == "" || strings.TrimSpace(attachment.SpaceID) == "" || strings.TrimSpace(attachment.UploaderID) == "" || attachment.CreatedAt.IsZero() {
		return internalError("create workspace attachment", errors.New("attachment fields are required"))
	}
	_, err := t.tx.Exec(ctx, `INSERT INTO attachments (
		id, space_id, uploader_id, conversation_id, visibility, status, file_name,
		mime_type, byte_size, storage_key, upload_transfer_id, created_at, completed_at
	) VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''), $12, $13)`,
		attachment.ID, attachment.SpaceID, attachment.UploaderID, pointerValue(attachment.ConversationID),
		attachment.Visibility, attachment.Status, attachment.FileName, attachment.MIMEType, attachment.ByteSize,
		attachment.StorageKey, attachment.UploadTransferID, normalizeTime(attachment.CreatedAt), nullableTime(attachment.CompletedAt))
	if err != nil {
		return internalError("create workspace attachment", err)
	}
	return nil
}

func (t *pgTx) UpsertUploadPart(ctx context.Context, part UploadPartRecord) (bool, error) {
	if part.PartNumber < 1 || part.PartNumber > UploadPartLimit || part.ByteSize <= 0 {
		return false, validationError(CodeUploadInvalidPart, MessageUploadInvalidPart)
	}
	digest, err := platformstorage.NormalizeSHA256(part.SHA256)
	if err != nil {
		return false, validationError(CodeUploadInvalidPartHash, "上传分片校验值无效")
	}
	existing, err := getUploadPart(ctx, t.tx, part.UploadID, part.PartNumber)
	if err != nil {
		return false, err
	}
	if existing != nil {
		if existing.ByteSize != part.ByteSize || !strings.EqualFold(existing.SHA256, digest) {
			return false, NewError(CodeUploadPartConflict, MessageUploadPartConflict, 409)
		}
		return false, nil
	}
	_, err = t.tx.Exec(ctx, `INSERT INTO workspace_upload_parts (
		upload_id, part_number, byte_size, sha256, created_at, updated_at
	) VALUES ($1, $2, $3, $4, $5, $6)`, part.UploadID, part.PartNumber, part.ByteSize, digest,
		normalizeTime(part.CreatedAt), normalizeTime(part.UpdatedAt))
	if err != nil {
		return false, internalError("upsert workspace upload part", err)
	}
	return true, nil
}

func (t *pgTx) TouchUpload(ctx context.Context, uploadID string, at time.Time) error {
	result, err := t.tx.Exec(ctx, `UPDATE transfer_ledger
		SET last_activity_at = $1
		WHERE id = $2 AND direction = 'upload' AND status = 'reserved'`, normalizeTime(at), uploadID)
	if err != nil {
		return internalError("touch workspace upload", err)
	}
	if result.RowsAffected() != 1 {
		return uploadInvalidError()
	}
	return nil
}

func (t *pgTx) CompleteUpload(ctx context.Context, spaceID, userID, transferID, attachmentID string, completedAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE transfer_ledger
		SET status = 'completed', completed_at = $1, last_activity_at = $1
		WHERE id = $2 AND space_id = $3 AND user_id = $4 AND direction = 'upload' AND status = 'reserved' AND attachment_id = $5`,
		normalizeTime(completedAt), transferID, spaceID, userID, attachmentID)
	if err != nil {
		return false, internalError("complete workspace upload", err)
	}
	if result.RowsAffected() != 1 {
		return false, nil
	}
	attachmentResult, err := t.tx.Exec(ctx, `UPDATE attachments
		SET status = 'available', completed_at = $1
		WHERE id = $2 AND space_id = $3 AND uploader_id = $4 AND status = 'pending' AND upload_transfer_id = $5`,
		normalizeTime(completedAt), attachmentID, spaceID, userID, transferID)
	if err != nil {
		return false, internalError("publish workspace attachment", err)
	}
	if attachmentResult.RowsAffected() != 1 {
		return false, nil
	}
	if _, err := t.tx.Exec(ctx, `DELETE FROM workspace_upload_parts WHERE upload_id = $1`, transferID); err != nil {
		return false, internalError("cleanup workspace upload parts", err)
	}
	return true, nil
}

func (t *pgTx) FailUpload(ctx context.Context, spaceID, userID, transferID, attachmentID, _ string, failedAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE transfer_ledger
		SET status = 'failed', completed_at = NULL, released_at = $1, last_activity_at = $1
		WHERE id = $2 AND space_id = $3 AND user_id = $4 AND direction = 'upload' AND status = 'reserved' AND attachment_id = $5`,
		normalizeTime(failedAt), transferID, spaceID, userID, attachmentID)
	if err != nil {
		return false, internalError("fail workspace upload", err)
	}
	if result.RowsAffected() != 1 {
		return false, nil
	}
	attachmentResult, err := t.tx.Exec(ctx, `UPDATE attachments
		SET status = 'failed', completed_at = NULL
		WHERE id = $1 AND space_id = $2 AND uploader_id = $3 AND status = 'pending' AND upload_transfer_id = $4`,
		attachmentID, spaceID, userID, transferID)
	if err != nil {
		return false, internalError("fail workspace attachment", err)
	}
	if attachmentResult.RowsAffected() != 1 {
		return false, nil
	}
	if _, err := t.tx.Exec(ctx, `DELETE FROM workspace_upload_parts WHERE upload_id = $1`, transferID); err != nil {
		return false, internalError("cleanup failed workspace upload parts", err)
	}
	return true, nil
}

func (t *pgTx) ReleaseDownload(ctx context.Context, spaceID, userID, transferID string, releasedAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE transfer_ledger
		SET status = 'failed', completed_at = NULL, released_at = $1
		WHERE id = $2 AND space_id = $3 AND user_id = $4 AND direction = 'download' AND status = 'completed'`,
		normalizeTime(releasedAt), transferID, spaceID, userID)
	if err != nil {
		return false, internalError("release workspace download", err)
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) EnsureStorageObjectAndBind(ctx context.Context, spaceID, attachmentID string, object StorageObjectRecord) (*StorageObjectRecord, bool, error) {
	validated, err := validatedStorageObject(object)
	if err != nil {
		return nil, false, err
	}
	var previousID *string
	if err := t.tx.QueryRow(ctx, `SELECT storage_object_id FROM attachments WHERE id = $1 AND space_id = $2 FOR UPDATE`, attachmentID, spaceID).Scan(&previousID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, fileNotFoundError()
		}
		return nil, false, internalError("load workspace attachment object", err)
	}
	registered, err := loadStorageObject(ctx, t.tx, validated.ID, true)
	if err != nil {
		return nil, false, err
	}
	wasExisting := registered != nil
	if _, err := t.tx.Exec(ctx, `INSERT INTO workspace_storage_objects (
		id, sha256, object_key, byte_size, content_type, created_at, verified_at, deleted_at
	) VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, NULL)
	ON CONFLICT (sha256) DO UPDATE SET deleted_at = NULL`, validated.ID, validated.SHA256,
		validated.ObjectKey, validated.ByteSize, validated.ContentType, normalizeTime(validated.CreatedAt),
		nullableTime(validated.VerifiedAt)); err != nil {
		return nil, false, internalError("register workspace storage object", err)
	}
	registered, err = loadStorageObject(ctx, t.tx, validated.ID, true)
	if err != nil {
		return nil, false, err
	}
	if registered == nil || registered.SHA256 != validated.SHA256 || registered.ObjectKey != validated.ObjectKey || registered.ByteSize != validated.ByteSize {
		return nil, false, internalError("validate workspace storage object", errors.New("storage registry identity mismatch"))
	}
	if _, err := t.tx.Exec(ctx, `UPDATE attachments SET storage_object_id = $1 WHERE id = $2 AND space_id = $3`, registered.ID, attachmentID, spaceID); err != nil {
		return nil, false, internalError("bind workspace storage object", err)
	}
	var previous *StorageObjectRecord
	if previousID != nil && strings.TrimSpace(*previousID) != "" && *previousID != registered.ID {
		previous, err = loadStorageObject(ctx, t.tx, *previousID, true)
		if err != nil {
			return nil, false, err
		}
	}
	return previous, !wasExisting, nil
}

func (t *pgTx) DetachAttachment(ctx context.Context, spaceID, attachmentID, actorID string, _ time.Time) (*StorageObjectRecord, bool, error) {
	var currentID *string
	if err := t.tx.QueryRow(ctx, `SELECT storage_object_id FROM attachments WHERE id = $1 AND space_id = $2`, attachmentID, spaceID).Scan(&currentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, internalError("load workspace attachment for removal", err)
	}
	var previous *StorageObjectRecord
	if currentID != nil && strings.TrimSpace(*currentID) != "" {
		var err error
		previous, err = loadStorageObject(ctx, t.tx, *currentID, true)
		if err != nil {
			return nil, false, err
		}
	}
	result, err := t.tx.Exec(ctx, `UPDATE attachments
		SET status = 'removed', storage_object_id = NULL
		WHERE id = $1 AND space_id = $2 AND status <> 'removed'`, attachmentID, spaceID)
	if err != nil {
		return nil, false, internalError("remove workspace attachment", err)
	}
	_ = actorID
	return previous, result.RowsAffected() == 1, nil
}

func (t *pgTx) CleanupStorageObject(ctx context.Context, objectID string, fallback StorageObjectRecord, at time.Time) (StorageCleanup, error) {
	if strings.TrimSpace(objectID) == "" {
		return StorageCleanup{Object: &fallback, DeleteObject: true}, nil
	}
	var lockedID string
	if err := t.tx.QueryRow(ctx, `SELECT id FROM workspace_storage_objects WHERE id = $1 FOR UPDATE`, objectID).Scan(&lockedID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return StorageCleanup{DeleteObject: true}, nil
		}
		return StorageCleanup{}, internalError("lock workspace storage object", err)
	}
	object, err := loadStorageObject(ctx, t.tx, objectID, true)
	if err != nil {
		return StorageCleanup{}, err
	}
	if object == nil {
		return StorageCleanup{DeleteObject: true}, nil
	}
	references, err := countStorageReferences(ctx, t.tx, object.ID)
	if err != nil {
		return StorageCleanup{}, err
	}
	if references > 0 {
		return StorageCleanup{Object: object, References: references}, nil
	}
	if _, err := t.tx.Exec(ctx, `UPDATE workspace_storage_objects SET deleted_at = $1 WHERE id = $2`, normalizeTime(at), object.ID); err != nil {
		return StorageCleanup{}, internalError("tombstone workspace storage object", err)
	}
	_ = fallback
	return StorageCleanup{Object: object, DeleteObject: true}, nil
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return internalError("generate workspace file event id", err)
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Type) == "" || input.CreatedAt.IsZero() {
		return internalError("write workspace file event", errors.New("event fields are required"))
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return internalError("write workspace file event", errors.New("event payload is not valid JSON"))
	}
	var nextSequence int64
	if err := t.tx.QueryRow(ctx, `INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, 2)
		ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1
		RETURNING next_seq`, input.SpaceID).Scan(&nextSequence); err != nil {
		return internalError("reserve workspace file event sequence", err)
	}
	sequence := nextSequence - 1
	_, err := t.tx.Exec(ctx, `INSERT INTO workspace_events (
		id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
	) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)`,
		input.ID, input.SpaceID, sequence, input.Type, input.ActorID, input.ConversationID, input.TargetType, input.TargetID,
		string(input.PayloadJSON), normalizeTime(input.CreatedAt))
	if err != nil {
		return internalError("write workspace file event", err)
	}
	return nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return internalError("generate workspace file audit id", err)
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" || input.CreatedAt.IsZero() {
		return internalError("write workspace file audit", errors.New("audit fields are required"))
	}
	result := input.Result
	if result == "" {
		result = "success"
	}
	if result != "success" && result != "failure" && result != "rejected" {
		return internalError("write workspace file audit", errors.New("audit result is invalid"))
	}
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (
		id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result,
		reason, ip_address, user_agent, request_id, created_at
	) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8,
		NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`,
		input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID,
		result, input.Reason, input.IPAddress, input.UserAgent, input.RequestID, normalizeTime(input.CreatedAt))
	if err != nil {
		return internalError("write workspace file audit", err)
	}
	return nil
}

func (t *pgTx) newID() (string, error) {
	if t == nil || t.repository == nil || t.repository.idFactory == nil {
		return "", errors.New("workspace files id factory is required")
	}
	return t.repository.idFactory()
}

type pgQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func lookupActor(ctx context.Context, queryer pgQueryer, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	var joinedAt time.Time
	err := queryer.QueryRow(ctx, `SELECT
		u.id, u.github_id, u.github_login, u.email, u.display_name, u.nickname,
		u.avatar_url, u.search_discoverable, u.kind, sm.role, sm.joined_at
	FROM users u
	INNER JOIN space_members sm ON sm.user_id = u.id
		AND sm.space_id = $2 AND sm.removed_at IS NULL
	WHERE u.id = $1`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName,
		&nickname, &avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &joinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("lookup workspace file actor", err)
	}
	actor.GitHubID = stringValue(githubID)
	actor.Email = stringValue(email)
	actor.Nickname = stringValue(nickname)
	actor.AvatarURL = stringValue(avatarURL)
	actor.JoinedAt = joinedAt.UTC()
	return &actor, nil
}

const attachmentSelect = `SELECT
	a.id, a.space_id, a.uploader_id, u.display_name, c.title, a.conversation_id,
	a.visibility, a.status, a.file_name, a.mime_type, a.byte_size, a.storage_key,
	a.upload_transfer_id, a.storage_object_id, a.created_at, a.completed_at,
	so.id, so.sha256, so.object_key, so.byte_size, so.content_type, so.created_at,
	so.verified_at, so.deleted_at
FROM attachments a
INNER JOIN users u ON u.id = a.uploader_id
LEFT JOIN conversations c ON c.id = a.conversation_id
LEFT JOIN workspace_storage_objects so ON so.id = a.storage_object_id AND so.deleted_at IS NULL
`

func getAttachment(ctx context.Context, queryer pgQueryer, spaceID, attachmentID string) (*AttachmentRecord, error) {
	record, err := scanAttachment(queryer.QueryRow(ctx, attachmentSelect+`WHERE a.space_id = $1 AND a.id = $2`, spaceID, attachmentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get workspace attachment", err)
	}
	return &record, nil
}

func listAttachments(ctx context.Context, queryer pgQueryer, query AttachmentListQuery) ([]AttachmentRecord, error) {
	limit := query.Limit
	if limit <= 0 {
		limit = DefaultListLimit
	}
	if limit > MaximumListLimit {
		limit = MaximumListLimit
	}
	rows, err := queryer.Query(ctx, `SELECT
		a.id, a.space_id, a.uploader_id,
		COALESCE(ur.remark, u.nickname, u.github_login, u.display_name), c.title,
		a.conversation_id, a.visibility, a.status, a.file_name, a.mime_type, a.byte_size,
		a.storage_key, a.upload_transfer_id, a.storage_object_id, a.created_at, a.completed_at,
		so.id, so.sha256, so.object_key, so.byte_size, so.content_type, so.created_at,
		so.verified_at, so.deleted_at
	FROM attachments a
	INNER JOIN users u ON u.id = a.uploader_id
	INNER JOIN space_members viewer_sm ON viewer_sm.space_id = a.space_id
		AND viewer_sm.user_id = $2 AND viewer_sm.removed_at IS NULL
	LEFT JOIN user_remarks ur ON ur.owner_user_id = $2 AND ur.target_user_id = u.id
	LEFT JOIN conversations c ON c.id = a.conversation_id
	LEFT JOIN workspace_storage_objects so ON so.id = a.storage_object_id AND so.deleted_at IS NULL
	WHERE a.space_id = $1 AND a.status = 'available'
		AND (a.visibility = 'space' OR a.uploader_id = $2 OR (a.visibility = 'conversation' AND EXISTS (
			SELECT 1 FROM conversation_members cm
			INNER JOIN conversations conversation ON conversation.id = cm.conversation_id
			WHERE cm.conversation_id = a.conversation_id AND cm.user_id = $2
				AND cm.removed_at IS NULL AND conversation.space_id = a.space_id
		)))
	ORDER BY a.created_at DESC, a.id DESC
	LIMIT $3`, query.SpaceID, query.ViewerID, limit)
	if err != nil {
		return nil, internalError("list workspace attachments", err)
	}
	defer rows.Close()
	return scanAttachments(rows)
}

func getTransfer(ctx context.Context, queryer pgQueryer, spaceID, userID, transferID string, direction TransferDirection) (*TransferRecord, error) {
	transfer, err := scanTransfer(queryer.QueryRow(ctx, `SELECT
		id, space_id, user_id, direction, byte_size, status, attachment_id,
		created_at, completed_at, released_at, last_activity_at
	FROM transfer_ledger
	WHERE id = $1 AND space_id = $2 AND user_id = $3 AND direction = $4`, transferID, spaceID, userID, string(direction)))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get workspace transfer", err)
	}
	return &transfer, nil
}

func listUploadParts(ctx context.Context, queryer pgQueryer, uploadID string) ([]UploadPartRecord, error) {
	rows, err := queryer.Query(ctx, `SELECT upload_id, part_number, byte_size, sha256, created_at, updated_at
	FROM workspace_upload_parts WHERE upload_id = $1 ORDER BY part_number ASC`, uploadID)
	if err != nil {
		return nil, internalError("list workspace upload parts", err)
	}
	defer rows.Close()
	items := make([]UploadPartRecord, 0)
	for rows.Next() {
		var item UploadPartRecord
		if err := rows.Scan(&item.UploadID, &item.PartNumber, &item.ByteSize, &item.SHA256, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, internalError("scan workspace upload parts", err)
		}
		item.CreatedAt = item.CreatedAt.UTC()
		item.UpdatedAt = item.UpdatedAt.UTC()
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan workspace upload parts", err)
	}
	return items, nil
}

func getUploadPart(ctx context.Context, queryer pgQueryer, uploadID string, partNumber int) (*UploadPartRecord, error) {
	var item UploadPartRecord
	err := queryer.QueryRow(ctx, `SELECT upload_id, part_number, byte_size, sha256, created_at, updated_at
	FROM workspace_upload_parts WHERE upload_id = $1 AND part_number = $2`, uploadID, partNumber).Scan(
		&item.UploadID, &item.PartNumber, &item.ByteSize, &item.SHA256, &item.CreatedAt, &item.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get workspace upload part", err)
	}
	item.CreatedAt = item.CreatedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return &item, nil
}

func usedTransferBytes(ctx context.Context, queryer pgQueryer, spaceID, userID string, since time.Time) (int64, error) {
	var used int64
	err := queryer.QueryRow(ctx, `SELECT COALESCE(SUM(byte_size), 0)
	FROM transfer_ledger
	WHERE space_id = $1 AND user_id = $2 AND created_at >= $3
		AND status IN ('reserved', 'completed')`, spaceID, userID, normalizeTime(since)).Scan(&used)
	if err != nil {
		return 0, internalError("read workspace transfer quota", err)
	}
	return used, nil
}

func listStaleUploads(ctx context.Context, queryer pgQueryer, spaceID string, before time.Time) ([]StaleUploadRecord, error) {
	rows, err := queryer.Query(ctx, `SELECT
		tl.id, tl.space_id, tl.user_id, tl.direction, tl.byte_size, tl.status,
		tl.attachment_id, tl.created_at, tl.completed_at, tl.released_at, tl.last_activity_at,
		a.id, a.space_id, a.uploader_id, u.display_name, c.title, a.conversation_id,
		a.visibility, a.status, a.file_name, a.mime_type, a.byte_size, a.storage_key,
		a.upload_transfer_id, a.storage_object_id, a.created_at, a.completed_at,
		so.id, so.sha256, so.object_key, so.byte_size, so.content_type, so.created_at,
		so.verified_at, so.deleted_at
	FROM attachments a
	INNER JOIN users u ON u.id = a.uploader_id
	LEFT JOIN conversations c ON c.id = a.conversation_id
	LEFT JOIN workspace_storage_objects so ON so.id = a.storage_object_id AND so.deleted_at IS NULL
	INNER JOIN transfer_ledger tl ON tl.id = a.upload_transfer_id
	WHERE a.space_id = $1 AND a.status = 'pending' AND tl.space_id = a.space_id
		AND tl.direction = 'upload' AND tl.status = 'reserved'
		AND COALESCE(tl.last_activity_at, tl.created_at) < $2
	ORDER BY tl.created_at ASC, tl.id ASC`, spaceID, normalizeTime(before))
	if err != nil {
		return nil, internalError("list stale workspace uploads", err)
	}
	defer rows.Close()
	items := make([]StaleUploadRecord, 0)
	for rows.Next() {
		candidate, scanErr := scanStaleUpload(rows)
		if scanErr != nil {
			return nil, internalError("scan stale workspace upload", scanErr)
		}
		items = append(items, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan stale workspace uploads", err)
	}
	return items, nil
}

func conversationMemberActive(ctx context.Context, queryer pgQueryer, spaceID, conversationID, userID string) (bool, error) {
	var active bool
	err := queryer.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1
		FROM conversations c
		INNER JOIN conversation_members cm ON cm.conversation_id = c.id
		INNER JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = cm.user_id
		WHERE c.id = $1 AND c.space_id = $2 AND cm.user_id = $3
			AND cm.removed_at IS NULL AND sm.removed_at IS NULL
	)`, conversationID, spaceID, userID).Scan(&active)
	if err != nil {
		return false, internalError("check workspace conversation membership", err)
	}
	return active, nil
}

func participantOnlyConversation(ctx context.Context, queryer pgQueryer, spaceID, conversationID string) (bool, error) {
	var participantOnly bool
	err := queryer.QueryRow(ctx, `SELECT COALESCE((SELECT c.type = 'direct'
		FROM conversations c WHERE c.id = $1 AND c.space_id = $2), false)`, conversationID, spaceID).Scan(&participantOnly)
	if err != nil {
		return false, internalError("check workspace conversation type", err)
	}
	return participantOnly, nil
}

func loadStorageObject(ctx context.Context, queryer pgQueryer, objectID string, includeDeleted bool) (*StorageObjectRecord, error) {
	where := "WHERE id = $1"
	if !includeDeleted {
		where += " AND deleted_at IS NULL"
	}
	var record StorageObjectRecord
	var contentType *string
	if err := queryer.QueryRow(ctx, `SELECT id, sha256, object_key, byte_size, content_type,
		created_at, verified_at, deleted_at FROM workspace_storage_objects `+where, objectID).Scan(
		&record.ID, &record.SHA256, &record.ObjectKey, &record.ByteSize, &contentType,
		&record.CreatedAt, &record.VerifiedAt, &record.DeletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, internalError("load workspace storage object", err)
	}
	record.ContentType = stringValue(contentType)
	record.CreatedAt = record.CreatedAt.UTC()
	if record.VerifiedAt != nil {
		value := record.VerifiedAt.UTC()
		record.VerifiedAt = &value
	}
	if record.DeletedAt != nil {
		value := record.DeletedAt.UTC()
		record.DeletedAt = &value
	}
	return &record, nil
}

func countStorageReferences(ctx context.Context, queryer pgQueryer, objectID string) (int64, error) {
	var count int64
	err := queryer.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM attachments WHERE storage_object_id = $1) +
		(SELECT COUNT(*) FROM users WHERE avatar_storage_object_id = $1) +
		(SELECT COUNT(*) FROM workspace_custom_emotes WHERE storage_object_id = $1)`, objectID).Scan(&count)
	if err != nil {
		return 0, internalError("count workspace storage references", err)
	}
	return count, nil
}

func validatedStorageObject(object StorageObjectRecord) (StorageObjectRecord, error) {
	digest, err := platformstorage.NormalizeSHA256(object.SHA256)
	if err != nil {
		return StorageObjectRecord{}, normalizeStorageError(err)
	}
	key, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		return StorageObjectRecord{}, normalizeStorageError(err)
	}
	if object.ID != "wso_"+digest || object.ObjectKey != key || object.ByteSize < 0 || object.ByteSize > platformstorage.DefaultMaxObjectBytes {
		return StorageObjectRecord{}, internalError("validate workspace storage object", errors.New("storage registry identity is invalid"))
	}
	if object.CreatedAt.IsZero() {
		return StorageObjectRecord{}, internalError("validate workspace storage object", errors.New("storage registry timestamp is required"))
	}
	object.SHA256 = digest
	object.ObjectKey = key
	return object, nil
}

func scanAttachment(row rowScanner) (AttachmentRecord, error) {
	var values attachmentScanValues
	if err := row.Scan(values.destinations()...); err != nil {
		return AttachmentRecord{}, err
	}
	return values.record(), nil
}

func scanStaleUpload(row rowScanner) (StaleUploadRecord, error) {
	var transfer TransferRecord
	var attachment attachmentScanValues
	destinations := []any{&transfer.ID, &transfer.SpaceID, &transfer.UserID, &transfer.Direction, &transfer.ByteSize, &transfer.Status,
		&transfer.AttachmentID, &transfer.CreatedAt, &transfer.CompletedAt, &transfer.ReleasedAt, &transfer.LastActivityAt}
	destinations = append(destinations, attachment.destinations()...)
	if err := row.Scan(destinations...); err != nil {
		return StaleUploadRecord{}, err
	}
	normalizeTransfer(&transfer)
	return StaleUploadRecord{Transfer: transfer, Attachment: attachment.record()}, nil
}

type attachmentScanValues struct {
	value                               AttachmentRecord
	conversationID, storageKey          *string
	uploadTransferID, storageObjectID   *string
	conversationTitle                   *string
	storageObjectIDValue                *string
	storageSHA256, storageObjectKey     *string
	storageContentType                  *string
	storageByteSize                     *int64
	storageCreatedAt                    *time.Time
	storageVerifiedAt, storageDeletedAt *time.Time
}

func (v *attachmentScanValues) destinations() []any {
	return []any{&v.value.ID, &v.value.SpaceID, &v.value.UploaderID, &v.value.UploaderName, &v.conversationTitle,
		&v.conversationID, &v.value.Visibility, &v.value.Status, &v.value.FileName, &v.value.MIMEType, &v.value.ByteSize,
		&v.storageKey, &v.uploadTransferID, &v.storageObjectID, &v.value.CreatedAt, &v.value.CompletedAt,
		&v.storageObjectIDValue, &v.storageSHA256, &v.storageObjectKey, &v.storageByteSize, &v.storageContentType,
		&v.storageCreatedAt, &v.storageVerifiedAt, &v.storageDeletedAt}
}

func (v *attachmentScanValues) record() AttachmentRecord {
	record := v.value
	record.ConversationID = cloneStringPtr(v.conversationID)
	record.ConversationTitle = stringValue(v.conversationTitle)
	record.StorageKey = stringValue(v.storageKey)
	record.UploadTransferID = stringValue(v.uploadTransferID)
	record.StorageObjectID = stringValue(v.storageObjectID)
	record.CreatedAt = record.CreatedAt.UTC()
	if record.CompletedAt != nil {
		value := record.CompletedAt.UTC()
		record.CompletedAt = &value
	}
	if v.storageObjectIDValue != nil && v.storageSHA256 != nil && v.storageObjectKey != nil && v.storageByteSize != nil && v.storageCreatedAt != nil {
		record.StorageObject = &StorageObjectRecord{ID: *v.storageObjectIDValue, SHA256: *v.storageSHA256, ObjectKey: *v.storageObjectKey, ByteSize: *v.storageByteSize, ContentType: stringValue(v.storageContentType), CreatedAt: v.storageCreatedAt.UTC(), VerifiedAt: utcTimePtr(v.storageVerifiedAt), DeletedAt: utcTimePtr(v.storageDeletedAt)}
	}
	return record
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAttachments(rows pgx.Rows) ([]AttachmentRecord, error) {
	items := make([]AttachmentRecord, 0)
	for rows.Next() {
		item, err := scanAttachment(rows)
		if err != nil {
			return nil, internalError("scan workspace attachments", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan workspace attachments", err)
	}
	return items, nil
}

func scanTransfer(row rowScanner) (TransferRecord, error) {
	var record TransferRecord
	if err := scanTransferValues(row, &record); err != nil {
		return TransferRecord{}, err
	}
	normalizeTransfer(&record)
	return record, nil
}

func scanTransferValues(row rowScanner, record *TransferRecord) error {
	return row.Scan(&record.ID, &record.SpaceID, &record.UserID, &record.Direction, &record.ByteSize, &record.Status,
		&record.AttachmentID, &record.CreatedAt, &record.CompletedAt, &record.ReleasedAt, &record.LastActivityAt)
}

func normalizeTransfer(record *TransferRecord) {
	record.CreatedAt = record.CreatedAt.UTC()
	if record.CompletedAt != nil {
		value := record.CompletedAt.UTC()
		record.CompletedAt = &value
	}
	if record.ReleasedAt != nil {
		value := record.ReleasedAt.UTC()
		record.ReleasedAt = &value
	}
	if record.LastActivityAt != nil {
		value := record.LastActivityAt.UTC()
		record.LastActivityAt = &value
	}
}

func normalizeTime(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}

func nullableTime(value *time.Time) any {
	if value == nil || value.IsZero() {
		return nil
	}
	return normalizeTime(*value)
}

func utcTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := value.UTC()
	return &copy
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

var _ Repository = (*PGRepository)(nil)
