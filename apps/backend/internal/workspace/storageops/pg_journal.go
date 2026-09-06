package storageops

import (
	"context"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

// PGJournal is the additive PostgreSQL journal and 025 registry adapter for
// the bounded backfill. schema is optional; when set, every transaction uses
// SET LOCAL search_path so integration tests can isolate all domain tables in
// a temporary schema without touching public.
type PGJournal struct {
	pool   *pgxpool.Pool
	schema string
}

var _ BackfillJournal = (*PGJournal)(nil)

func NewPGJournal(pool *pgxpool.Pool, schema string) (*PGJournal, error) {
	if pool == nil {
		return nil, backfillError("storageops.database_required", nil)
	}
	schema = strings.TrimSpace(schema)
	if schema != "" && !validPGIdentifier(schema) {
		return nil, backfillError("storageops.database_schema_invalid", nil)
	}
	return &PGJournal{pool: pool, schema: schema}, nil
}

func (j *PGJournal) begin(ctx context.Context) (pgx.Tx, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if j == nil || j.pool == nil {
		return nil, backfillError("storageops.database_required", nil)
	}
	tx, err := j.pool.Begin(ctx)
	if err != nil {
		return nil, journalFailure("storageops.journal_begin_failed", err)
	}
	if j.schema != "" {
		if _, err := tx.Exec(ctx, `SET LOCAL search_path TO `+quotePGIdentifier(j.schema)); err != nil {
			_ = tx.Rollback(context.Background())
			return nil, journalFailure("storageops.journal_schema_failed", err)
		}
	}
	return tx, nil
}

func finishJournalTx(ctx context.Context, tx pgx.Tx, errp *error) {
	if tx == nil {
		return
	}
	if recovered := recover(); recovered != nil {
		_ = tx.Rollback(context.Background())
		panic(recovered)
	}
	if *errp != nil {
		_ = tx.Rollback(context.Background())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		*errp = journalFailure("storageops.journal_commit_failed", err)
	}
}

func (j *PGJournal) BeginOrResume(ctx context.Context, request BackfillRunRequest) (run BackfillRun, err error) {
	if err := validateRunRequest(request); err != nil {
		return run, err
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return run, err
	}
	defer finishJournalTx(ctx, tx, &err)

	run, found, err := selectRun(ctx, tx, request.RunID, true)
	if err != nil {
		return run, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if !found {
		_, err = tx.Exec(ctx, `INSERT INTO workspace_storage_operator_runs (
			id, operation, state, active_operation, schema_fingerprint, fence_token_hash,
			phase, revision, total_items, processed_items, started_at, updated_at
		) VALUES ($1, $2, 'running', $2, $3, $4, 'root', 1, 0, 0, $5, $5)`,
			request.RunID, BackfillOperation, request.ManifestFingerprint, request.FenceTokenHash, now)
		if err != nil {
			if isUniqueViolation(err) {
				return run, backfillError("storageops.journal_active", nil)
			}
			return run, journalFailure("storageops.journal_create_failed", err)
		}
		if err = seedRootItems(ctx, tx, request.RunID, now); err != nil {
			return run, err
		}
		if err = refreshRunTotal(ctx, tx, request.RunID, now, false); err != nil {
			return run, err
		}
		run, _, err = selectRun(ctx, tx, request.RunID, false)
		return run, err
	}
	if run.Operation != BackfillOperation {
		return run, backfillError("storageops.journal_operation_mismatch", nil)
	}
	if run.State == "completed" {
		if err := ensureFingerprint(ctx, tx, request.RunID, request.ManifestFingerprint); err != nil {
			return run, err
		}
		return run, nil
	}
	if run.State == "running" {
		if run.FenceTokenHash != request.FenceTokenHash {
			return run, backfillError("storageops.journal_active", nil)
		}
		if err := ensureFingerprint(ctx, tx, request.RunID, request.ManifestFingerprint); err != nil {
			return run, err
		}
		return run, nil
	}
	if run.State != "failed" && run.State != "paused" {
		return run, backfillError("storageops.journal_state_invalid", nil)
	}
	if err = ensureFingerprint(ctx, tx, request.RunID, request.ManifestFingerprint); err != nil {
		return run, err
	}
	if err = seedRootItems(ctx, tx, request.RunID, now); err != nil {
		return run, err
	}
	result, updateErr := tx.Exec(ctx, `UPDATE workspace_storage_operator_runs
		SET state = 'running', active_operation = $1, fence_token_hash = $2,
			last_error_code = NULL, updated_at = $3, revision = revision + 1
		WHERE id = $4 AND revision = $5 AND state IN ('failed', 'paused')`,
		BackfillOperation, request.FenceTokenHash, now, request.RunID, run.Revision)
	if updateErr != nil {
		return run, journalFailure("storageops.journal_resume_failed", updateErr)
	}
	if result.RowsAffected() != 1 {
		return run, backfillError("storageops.journal_cas_conflict", nil)
	}
	run, _, err = selectRun(ctx, tx, request.RunID, false)
	return run, err
}

// RecoverRunning rotates a running run to a newly acquired owner fence after
// a parent coordinator has established that the previous owner is gone. The
// old hash and revision are both required, so this method cannot be used as a
// blind takeover or force-resume switch. Existing items retain the old hash;
// their transaction-time fence check therefore rejects stale workers.
func (j *PGJournal) RecoverRunning(ctx context.Context, request BackfillRecoveryRequest) (run BackfillRun, err error) {
	if err := validateRecoveryRequest(request); err != nil {
		return run, err
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return run, err
	}
	defer finishJournalTx(ctx, tx, &err)

	run, found, err := selectRun(ctx, tx, request.RunID, true)
	if err != nil {
		return run, err
	}
	if !found {
		return run, backfillError("storageops.journal_run_missing", nil)
	}
	if run.Operation != BackfillOperation || run.State != "running" {
		return run, backfillError("storageops.journal_recovery_state_invalid", nil)
	}
	if run.FenceTokenHash != request.PreviousFenceTokenHash || run.Revision != request.ExpectedRevision {
		return run, backfillError("storageops.journal_recovery_conflict", nil)
	}
	if err = ensureFingerprint(ctx, tx, request.RunID, request.ManifestFingerprint); err != nil {
		return run, err
	}
	command, updateErr := tx.Exec(ctx, `UPDATE workspace_storage_operator_runs
		SET fence_token_hash = $1, updated_at = $2, revision = revision + 1
		WHERE id = $3 AND revision = $4 AND state = 'running'
		  AND fence_token_hash = $5`,
		request.NewFenceTokenHash, time.Now().UTC().Format(time.RFC3339Nano), request.RunID,
		request.ExpectedRevision, request.PreviousFenceTokenHash)
	if updateErr != nil {
		return run, journalFailure("storageops.journal_recovery_failed", updateErr)
	}
	if command.RowsAffected() != 1 {
		return run, backfillError("storageops.journal_recovery_conflict", nil)
	}
	run, _, err = selectRun(ctx, tx, request.RunID, false)
	return run, err
}

func (j *PGJournal) ListPage(ctx context.Context, runID, phase string, after BackfillCursor, limit int) (page BackfillPage, err error) {
	if err := validatePageRequest(runID, phase, after, limit); err != nil {
		return page, err
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return page, err
	}
	defer finishJournalTx(ctx, tx, &err)
	rows, err := tx.Query(ctx, `SELECT
		i.run_id, i.phase, i.kind, i.resource_id, i.space_id, i.legacy_storage_key,
		i.existing_storage_object_id, i.source_custom_emote_id, i.content_type,
		i.expected_sha256, i.expected_byte_size, i.status, i.revision, r.fence_token_hash
		FROM workspace_storage_operator_items i
		JOIN workspace_storage_operator_runs r ON r.id = i.run_id
		WHERE i.run_id = $1 AND i.phase = $2 AND i.status IN ('pending', 'failed')
		  AND ($3 = '' OR i.kind > $3 OR (i.kind = $3 AND i.resource_id > $4))
		ORDER BY i.kind, i.resource_id
		LIMIT $5`, runID, phase, after.Kind, after.ResourceID, limit)
	if err != nil {
		return page, journalFailure("storageops.journal_page_failed", err)
	}
	defer rows.Close()
	for rows.Next() {
		item, scanErr := scanBackfillItem(rows)
		if scanErr != nil {
			return page, journalFailure("storageops.journal_page_failed", scanErr)
		}
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return page, journalFailure("storageops.journal_page_failed", err)
	}
	return page, nil
}

func (j *PGJournal) EnsureCloneItems(ctx context.Context, run BackfillRun, at time.Time) (next BackfillRun, err error) {
	if run.Phase != BackfillPhaseRoot || run.State != "running" || run.Revision <= 0 {
		return next, backfillError("storageops.journal_phase_invalid", nil)
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return next, err
	}
	defer finishJournalTx(ctx, tx, &err)
	current, found, err := selectRun(ctx, tx, run.ID, true)
	if err != nil {
		return next, err
	}
	if !found {
		return next, backfillError("storageops.journal_run_missing", nil)
	}
	if current.Revision != run.Revision || current.State != "running" || current.Phase != BackfillPhaseRoot {
		return next, backfillError("storageops.journal_cas_conflict", nil)
	}
	if current.FenceTokenHash != run.FenceTokenHash {
		return next, backfillError("storageops.journal_fence_conflict", nil)
	}
	stamp := normalizeJournalTime(at)
	_, err = tx.Exec(ctx, `INSERT INTO workspace_storage_operator_items (
		run_id, phase, kind, resource_id, legacy_storage_key,
		existing_storage_object_id, source_custom_emote_id, content_type, expected_sha256,
		status, revision, updated_at
	)
	SELECT $1, 'clone', 'customEmote', e.id, NULL, e.storage_object_id,
		e.source_custom_emote_id, COALESCE(NULLIF(e.normalized_mime_type, ''), 'image/webp'),
		NULL, 'pending', 1, $2
	FROM workspace_custom_emotes e
	WHERE e.storage_key IS NULL AND e.source_custom_emote_id IS NOT NULL
	ON CONFLICT (run_id, phase, kind, resource_id) DO NOTHING`, run.ID, stamp)
	if err != nil {
		return next, journalFailure("storageops.journal_clone_seed_failed", err)
	}
	result, err := tx.Exec(ctx, `UPDATE workspace_storage_operator_runs
		SET phase = 'clone', cursor_kind = NULL, cursor_id = NULL,
			total_items = (SELECT COUNT(*) FROM workspace_storage_operator_items WHERE run_id = $1),
			updated_at = $2, revision = revision + 1
		WHERE id = $1 AND revision = $3 AND state = 'running' AND phase = 'root'`,
		run.ID, stamp, run.Revision)
	if err != nil {
		return next, journalFailure("storageops.journal_clone_phase_failed", err)
	}
	if result.RowsAffected() != 1 {
		return next, backfillError("storageops.journal_cas_conflict", nil)
	}
	next, _, err = selectRun(ctx, tx, run.ID, false)
	return next, err
}

func (j *PGJournal) LoadObject(ctx context.Context, objectID string) (object CanonicalObject, err error) {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return object, backfillError("storageops.object_id_required", nil)
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return object, err
	}
	defer finishJournalTx(ctx, tx, &err)
	var deletedAt *time.Time
	var referenceCount int64
	err = tx.QueryRow(ctx, `SELECT id, sha256, object_key, byte_size, deleted_at,
		(SELECT COUNT(*) FROM attachments WHERE storage_object_id = $1) +
		(SELECT COUNT(*) FROM users WHERE avatar_storage_object_id = $1) +
		(SELECT COUNT(*) FROM workspace_custom_emotes WHERE storage_object_id = $1)
		FROM workspace_storage_objects WHERE id = $1`, objectID).Scan(
		&object.ID, &object.SHA256, &object.ObjectKey, &object.ByteSize, &deletedAt, &referenceCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return object, backfillError("storageops.object_not_found", nil)
	}
	if err != nil {
		return object, journalFailure("storageops.object_load_failed", err)
	}
	object.ReferenceCount = int(referenceCount)
	object.Deleted = deletedAt != nil
	return object, nil
}

type lockedJournalItem struct {
	item            BackfillItem
	runOperation    string
	runState        string
	runFenceHash    string
	storageObjectID *string
	sha256          *string
	byteSize        *int64
	objectKey       *string
	action          *string
}

func lockJournalItem(ctx context.Context, tx pgx.Tx, item BackfillItem) (lockedJournalItem, error) {
	current, err := loadLockedJournalItem(ctx, tx, item, true)
	if err != nil {
		return current, err
	}
	if err := validatePendingItemSnapshot(item, current.item); err != nil {
		return current, err
	}
	return current, nil
}

func loadLockedJournalItem(ctx context.Context, tx pgx.Tx, item BackfillItem, requireFence bool) (current lockedJournalItem, err error) {
	if strings.TrimSpace(item.RunID) == "" || strings.TrimSpace(item.FenceTokenHash) == "" {
		return current, backfillError("storageops.journal_item_identity_invalid", nil)
	}
	err = tx.QueryRow(ctx, `SELECT operation, state, fence_token_hash
		FROM workspace_storage_operator_runs WHERE id = $1 FOR UPDATE`, item.RunID).Scan(
		&current.runOperation, &current.runState, &current.runFenceHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return current, backfillError("storageops.journal_run_missing", nil)
	}
	if err != nil {
		return current, journalFailure("storageops.journal_run_load_failed", err)
	}
	if current.runOperation != BackfillOperation {
		return current, backfillError("storageops.journal_operation_mismatch", nil)
	}
	if requireFence && current.runState != "running" {
		return current, backfillError("storageops.journal_run_not_active", nil)
	}
	if requireFence && current.runFenceHash != item.FenceTokenHash {
		return current, backfillError("storageops.journal_fence_conflict", nil)
	}
	var spaceID, legacyKey, existingObjectID, sourceID, contentType, expectedSHA *string
	err = tx.QueryRow(ctx, `SELECT run_id, phase, kind, resource_id, space_id,
		legacy_storage_key, existing_storage_object_id, source_custom_emote_id,
		content_type, expected_sha256, expected_byte_size, status, revision,
		storage_object_id, sha256, byte_size, object_key, action
		FROM workspace_storage_operator_items
		WHERE run_id = $1 AND phase = $2 AND kind = $3 AND resource_id = $4
		FOR UPDATE`, item.RunID, item.Phase, item.Kind, item.ResourceID).Scan(
		&current.item.RunID, &current.item.Phase, &current.item.Kind, &current.item.ResourceID,
		&spaceID, &legacyKey, &existingObjectID, &sourceID, &contentType, &expectedSHA,
		&current.item.ExpectedByteSize, &current.item.Status, &current.item.Revision,
		&current.storageObjectID, &current.sha256, &current.byteSize, &current.objectKey, &current.action)
	if errors.Is(err, pgx.ErrNoRows) {
		return current, backfillError("storageops.journal_item_missing", nil)
	}
	if err != nil {
		return current, journalFailure("storageops.journal_item_load_failed", err)
	}
	if spaceID != nil {
		current.item.SpaceID = *spaceID
	}
	if legacyKey != nil {
		current.item.LegacyStorageKey = *legacyKey
	}
	if existingObjectID != nil {
		current.item.ExistingStorageObjectID = *existingObjectID
	}
	if sourceID != nil {
		current.item.SourceCustomEmoteID = *sourceID
	}
	if contentType != nil {
		current.item.ContentType = *contentType
	}
	if expectedSHA != nil {
		current.item.ExpectedSHA256 = *expectedSHA
	}
	current.item.FenceTokenHash = current.runFenceHash
	if current.runFenceHash != item.FenceTokenHash && requireFence {
		return current, backfillError("storageops.journal_fence_conflict", nil)
	}
	return current, nil
}

func validatePendingItemSnapshot(expected, actual BackfillItem) error {
	if !sameItemSnapshot(expected, actual) || expected.Revision != actual.Revision || expected.Status != actual.Status {
		return backfillError("storageops.journal_cas_conflict", nil)
	}
	if actual.Status != BackfillItemPending && actual.Status != BackfillItemFailed {
		return backfillError("storageops.journal_item_state_invalid", nil)
	}
	return nil
}

func sameItemSnapshot(left, right BackfillItem) bool {
	if left.RunID != right.RunID || left.Phase != right.Phase || left.Kind != right.Kind || left.ResourceID != right.ResourceID ||
		left.SpaceID != right.SpaceID || left.LegacyStorageKey != right.LegacyStorageKey ||
		left.ExistingStorageObjectID != right.ExistingStorageObjectID || left.SourceCustomEmoteID != right.SourceCustomEmoteID ||
		left.ContentType != right.ContentType || left.ExpectedSHA256 != right.ExpectedSHA256 {
		return false
	}
	if left.ExpectedByteSize == nil || right.ExpectedByteSize == nil {
		return left.ExpectedByteSize == nil && right.ExpectedByteSize == nil
	}
	return *left.ExpectedByteSize == *right.ExpectedByteSize
}

func (j *PGJournal) AcquireAndBind(ctx context.Context, item BackfillItem, candidate BackfillObject, at time.Time) (result BackfillResult, err error) {
	digest, key, objectID, err := validateBackfillObject(candidate)
	if err != nil {
		return result, err
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return result, err
	}
	defer finishJournalTx(ctx, tx, &err)
	previousID, err := lockTarget(ctx, tx, item)
	if err != nil {
		return result, err
	}
	if err = lockStorageObjects(ctx, tx, previousID, objectID); err != nil {
		return result, err
	}
	stamp := normalizeJournalTime(at)
	var existingID *string
	if err = tx.QueryRow(ctx, `SELECT id FROM workspace_storage_objects WHERE sha256 = $1 FOR UPDATE`, digest).Scan(&existingID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, journalFailure("storageops.object_load_failed", err)
	}
	wasExisting := existingID != nil
	_, err = tx.Exec(ctx, `INSERT INTO workspace_storage_objects (
		id, sha256, object_key, byte_size, content_type, created_at, verified_at, deleted_at
	) VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $6, NULL)
	ON CONFLICT (sha256) DO UPDATE SET
		content_type = COALESCE(workspace_storage_objects.content_type, EXCLUDED.content_type),
		deleted_at = NULL`, objectID, digest, key, candidate.ByteSize, candidate.ContentType, stamp)
	if err != nil {
		return result, journalFailure("storageops.object_acquire_failed", err)
	}
	var registered BackfillObject
	err = tx.QueryRow(ctx, `SELECT id, sha256, object_key, byte_size, COALESCE(content_type, '')
		FROM workspace_storage_objects WHERE sha256 = $1 FOR UPDATE`, digest).Scan(
		&registered.ID, &registered.SHA256, &registered.ObjectKey, &registered.ByteSize, &registered.ContentType)
	if err != nil {
		return result, journalFailure("storageops.object_load_failed", err)
	}
	if registered.ID != objectID || registered.SHA256 != digest || registered.ObjectKey != key || registered.ByteSize != candidate.ByteSize {
		return result, backfillError("storageops.object_identity_mismatch", nil)
	}
	action := BackfillActionCreated
	if wasExisting {
		action = BackfillActionReused
	}
	if err = bindTarget(ctx, tx, item, previousID, registered.ID); err != nil {
		return result, err
	}
	result = BackfillResult{Object: registered, Action: action}
	if err = completeItemTx(ctx, tx, item, result, at); err != nil {
		return BackfillResult{}, err
	}
	return result, nil
}

func (j *PGJournal) BindClone(ctx context.Context, item BackfillItem, at time.Time) (result BackfillResult, err error) {
	if item.Kind != "customEmote" || strings.TrimSpace(item.ResourceID) == "" {
		return result, backfillError("storageops.clone_item_invalid", nil)
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return result, err
	}
	defer finishJournalTx(ctx, tx, &err)
	if _, err = lockJournalItem(ctx, tx, item); err != nil {
		return result, err
	}
	currentID := item.ResourceID
	visited := make(map[string]struct{})
	var objectID string
	var previousID string
	first := true
	for {
		if len(visited) >= maxCloneChainLength {
			return result, backfillError("storageops.clone_chain_limit", nil)
		}
		if _, exists := visited[currentID]; exists {
			return result, backfillError("storageops.clone_cycle", nil)
		}
		visited[currentID] = struct{}{}
		var sourceID *string
		var storageObjectID *string
		err = tx.QueryRow(ctx, `SELECT storage_object_id, source_custom_emote_id
			FROM workspace_custom_emotes WHERE id = $1 FOR UPDATE`, currentID).Scan(&storageObjectID, &sourceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return result, backfillError("storageops.clone_unresolved", nil)
		}
		if err != nil {
			return result, journalFailure("storageops.clone_load_failed", err)
		}
		if first && !storageObjectRefMatches(item.ExistingStorageObjectID, storageObjectID) {
			return result, backfillError("storageops.target_snapshot_conflict", nil)
		}
		if storageObjectID != nil && strings.TrimSpace(*storageObjectID) != "" {
			if first {
				previousID = strings.TrimSpace(*storageObjectID)
			}
			objectID = *storageObjectID
			break
		}
		first = false
		if sourceID == nil || strings.TrimSpace(*sourceID) == "" {
			return result, backfillError("storageops.clone_unresolved", nil)
		}
		currentID = *sourceID
	}
	if err = lockStorageObjects(ctx, tx, previousID, objectID); err != nil {
		return result, err
	}
	var object BackfillObject
	err = tx.QueryRow(ctx, `SELECT id, sha256, object_key, byte_size, COALESCE(content_type, '')
		FROM workspace_storage_objects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, objectID).Scan(
		&object.ID, &object.SHA256, &object.ObjectKey, &object.ByteSize, &object.ContentType)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, backfillError("storageops.clone_unresolved", nil)
	}
	if err != nil {
		return result, journalFailure("storageops.clone_object_load_failed", err)
	}
	if err = bindTarget(ctx, tx, item, previousID, object.ID); err != nil {
		return result, err
	}
	result = BackfillResult{Object: object, Action: BackfillActionClone}
	if err = completeItemTx(ctx, tx, item, result, at); err != nil {
		return BackfillResult{}, err
	}
	return result, nil
}

func (j *PGJournal) MarkItemCompleted(ctx context.Context, item BackfillItem, result BackfillResult, at time.Time) (err error) {
	if item.RunID == "" || item.Revision <= 0 || result.Object.ID == "" {
		return backfillError("storageops.item_completion_invalid", nil)
	}
	if result.Action != BackfillActionCreated && result.Action != BackfillActionReused && result.Action != BackfillActionClone {
		return backfillError("storageops.item_action_invalid", nil)
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return err
	}
	defer finishJournalTx(ctx, tx, &err)
	current, err := loadLockedJournalItem(ctx, tx, item, false)
	if err != nil {
		return err
	}
	if current.item.Status == BackfillItemCompleted {
		if current.item.Revision != item.Revision+1 || !sameItemSnapshot(item, current.item) || !completedResultMatches(current, result) {
			return backfillError("storageops.journal_cas_conflict", nil)
		}
		return nil
	}
	if current.runState != "running" || current.runFenceHash != item.FenceTokenHash {
		return backfillError("storageops.journal_fence_conflict", nil)
	}
	if err := validatePendingItemSnapshot(item, current.item); err != nil {
		return err
	}
	return backfillError("storageops.item_completion_requires_bind", nil)
}

func completeItemTx(ctx context.Context, tx pgx.Tx, item BackfillItem, result BackfillResult, at time.Time) error {
	command, err := tx.Exec(ctx, `UPDATE workspace_storage_operator_items
		SET status = 'completed', storage_object_id = $1, sha256 = $2, byte_size = $3,
			object_key = $4, action = $5, last_error_code = NULL,
			attempt_count = attempt_count + 1, revision = revision + 1, updated_at = $6
		WHERE run_id = $7 AND phase = $8 AND kind = $9 AND resource_id = $10
		  AND revision = $11 AND status IN ('pending', 'failed')`,
		result.Object.ID, result.Object.SHA256, result.Object.ByteSize, result.Object.ObjectKey,
		result.Action, normalizeJournalTime(at), item.RunID, item.Phase, item.Kind, item.ResourceID, item.Revision)
	if err != nil {
		return journalFailure("storageops.item_completion_failed", err)
	}
	if command.RowsAffected() != 1 {
		return backfillError("storageops.journal_cas_conflict", nil)
	}
	return nil
}

func completedResultMatches(item lockedJournalItem, result BackfillResult) bool {
	if item.storageObjectID == nil || item.sha256 == nil || item.objectKey == nil || item.action == nil || item.byteSize == nil {
		return false
	}
	return *item.storageObjectID == result.Object.ID && *item.sha256 == result.Object.SHA256 &&
		*item.byteSize == result.Object.ByteSize && *item.objectKey == result.Object.ObjectKey &&
		*item.action == result.Action
}

func (j *PGJournal) MarkItemFailed(ctx context.Context, item BackfillItem, code string, at time.Time) (err error) {
	code = safeErrorCode(code)
	if item.RunID == "" || item.Revision <= 0 {
		return backfillError("storageops.item_failure_invalid", nil)
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return err
	}
	defer finishJournalTx(ctx, tx, &err)
	if _, err = lockJournalItem(ctx, tx, item); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE workspace_storage_operator_items
		SET status = 'failed', last_error_code = $1,
			attempt_count = attempt_count + 1, revision = revision + 1, updated_at = $2
		WHERE run_id = $3 AND phase = $4 AND kind = $5 AND resource_id = $6
		  AND revision = $7 AND status IN ('pending', 'failed')`,
		code, normalizeJournalTime(at), item.RunID, item.Phase, item.Kind, item.ResourceID, item.Revision)
	if err != nil {
		return journalFailure("storageops.item_failure_failed", err)
	}
	if command.RowsAffected() != 1 {
		return backfillError("storageops.journal_cas_conflict", nil)
	}
	return nil
}

func (j *PGJournal) Advance(ctx context.Context, run BackfillRun, cursor BackfillCursor, processed int64, at time.Time) (next BackfillRun, err error) {
	if run.ID == "" || run.Revision <= 0 || run.State != "running" || !validCursor(cursor) {
		return next, backfillError("storageops.checkpoint_invalid", nil)
	}
	if processed < 0 {
		return next, backfillError("storageops.checkpoint_invalid", nil)
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return next, err
	}
	defer finishJournalTx(ctx, tx, &err)
	var cursorKind any
	var cursorID any
	if cursor.Empty() {
		cursorKind, cursorID = nil, nil
	} else {
		cursorKind, cursorID = cursor.Kind, cursor.ResourceID
	}
	command, err := tx.Exec(ctx, `UPDATE workspace_storage_operator_runs
		SET cursor_kind = $1, cursor_id = $2,
			processed_items = (SELECT COUNT(*) FROM workspace_storage_operator_items WHERE run_id = $3 AND status = 'completed'),
			updated_at = $4, revision = revision + 1
		WHERE id = $3 AND revision = $5 AND state = 'running'
		  AND fence_token_hash = $6`,
		cursorKind, cursorID, run.ID, normalizeJournalTime(at), run.Revision, run.FenceTokenHash)
	if err != nil {
		return next, journalFailure("storageops.checkpoint_failed", err)
	}
	if command.RowsAffected() != 1 {
		return next, backfillError("storageops.journal_cas_conflict", nil)
	}
	next, _, err = selectRun(ctx, tx, run.ID, false)
	return next, err
}

func (j *PGJournal) Complete(ctx context.Context, run BackfillRun, at time.Time) (next BackfillRun, err error) {
	if run.ID == "" || run.Revision <= 0 || run.State != "running" || run.Phase != BackfillPhaseClone {
		return next, backfillError("storageops.completion_invalid", nil)
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return next, err
	}
	defer finishJournalTx(ctx, tx, &err)
	command, err := tx.Exec(ctx, `UPDATE workspace_storage_operator_runs
		SET state = 'completed', active_operation = NULL,
			processed_items = (SELECT COUNT(*) FROM workspace_storage_operator_items WHERE run_id = $1 AND status = 'completed'),
			completed_at = $2, updated_at = $2, revision = revision + 1
		WHERE id = $1 AND revision = $3 AND state = 'running' AND phase = 'clone'
		  AND fence_token_hash = $4
		  AND NOT EXISTS (SELECT 1 FROM workspace_storage_operator_items WHERE run_id = $1 AND status IN ('pending', 'failed'))`,
		run.ID, normalizeJournalTime(at), run.Revision, run.FenceTokenHash)
	if err != nil {
		return next, journalFailure("storageops.completion_failed", err)
	}
	if command.RowsAffected() != 1 {
		return next, backfillError("storageops.journal_cas_conflict", nil)
	}
	next, _, err = selectRun(ctx, tx, run.ID, false)
	return next, err
}

func (j *PGJournal) Fail(ctx context.Context, run BackfillRun, code string, at time.Time) (next BackfillRun, err error) {
	if run.ID == "" || run.Revision <= 0 {
		return next, backfillError("storageops.failure_invalid", nil)
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return next, err
	}
	defer finishJournalTx(ctx, tx, &err)
	command, err := tx.Exec(ctx, `UPDATE workspace_storage_operator_runs
		SET state = 'failed', active_operation = NULL, last_error_code = $1,
			updated_at = $2, revision = revision + 1
		WHERE id = $3 AND revision = $4 AND state IN ('running', 'paused')
		  AND fence_token_hash = $5`,
		safeErrorCode(code), normalizeJournalTime(at), run.ID, run.Revision, run.FenceTokenHash)
	if err != nil {
		return next, journalFailure("storageops.failure_update_failed", err)
	}
	if command.RowsAffected() != 1 {
		return next, backfillError("storageops.journal_cas_conflict", nil)
	}
	next, _, err = selectRun(ctx, tx, run.ID, false)
	return next, err
}

func (j *PGJournal) Summary(ctx context.Context, runID string) (summary BackfillSummary, err error) {
	if strings.TrimSpace(runID) == "" {
		return summary, backfillError("storageops.run_id_required", nil)
	}
	tx, err := j.begin(ctx)
	if err != nil {
		return summary, err
	}
	defer finishJournalTx(ctx, tx, &err)
	if err = tx.QueryRow(ctx, `SELECT state FROM workspace_storage_operator_runs WHERE id = $1`, runID).Scan(&summary.State); errors.Is(err, pgx.ErrNoRows) {
		return summary, backfillError("storageops.journal_run_missing", nil)
	} else if err != nil {
		return summary, journalFailure("storageops.summary_failed", err)
	}
	var logicalBytes int64
	err = tx.QueryRow(ctx, `SELECT
		COUNT(*),
		COUNT(*) FILTER (WHERE status = 'completed'),
		COUNT(*) FILTER (WHERE action = 'created'),
		COUNT(*) FILTER (WHERE action = 'reused'),
		COUNT(*) FILTER (WHERE action = 'bound_clone'),
		COUNT(*) FILTER (WHERE kind = 'attachment'),
		COUNT(*) FILTER (WHERE kind = 'avatar'),
		COUNT(*) FILTER (WHERE kind = 'customEmote'),
		COALESCE(SUM(CASE WHEN status = 'completed' THEN COALESCE(byte_size, 0) ELSE 0 END), 0)
		FROM workspace_storage_operator_items WHERE run_id = $1`, runID).Scan(
		&summary.TotalItems, &summary.ProcessedItems, &summary.Created, &summary.Reused,
		&summary.BoundClones, &summary.AttachmentItems, &summary.AvatarItems,
		&summary.CustomEmoteItems, &logicalBytes)
	if err != nil {
		return summary, journalFailure("storageops.summary_failed", err)
	}
	summary.RunID = runID
	summary.LogicalBytes = logicalBytes
	err = tx.QueryRow(ctx, `SELECT COALESCE(SUM(byte_size), 0) FROM (
		SELECT sha256, MAX(byte_size) AS byte_size
		FROM workspace_storage_operator_items
		WHERE run_id = $1 AND status = 'completed' AND sha256 IS NOT NULL
		GROUP BY sha256
	) objects`, runID).Scan(&summary.UniqueBytes)
	if err != nil {
		return summary, journalFailure("storageops.summary_failed", err)
	}
	if summary.LogicalBytes > summary.UniqueBytes {
		summary.DeduplicatedBytes = summary.LogicalBytes - summary.UniqueBytes
	}
	return summary, nil
}

func selectRun(ctx context.Context, queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, runID string, _ bool) (run BackfillRun, found bool, err error) {
	var cursorKind, cursorID, lastError *string
	err = queryer.QueryRow(ctx, `SELECT id, operation, state, phase, cursor_kind, cursor_id,
		revision, total_items, processed_items, last_error_code, fence_token_hash
		FROM workspace_storage_operator_runs WHERE id = $1 FOR UPDATE`, runID).Scan(
		&run.ID, &run.Operation, &run.State, &run.Phase, &cursorKind, &cursorID,
		&run.Revision, &run.TotalItems, &run.ProcessedItems, &lastError, &run.FenceTokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return run, false, nil
	}
	if err != nil {
		return run, false, journalFailure("storageops.journal_run_load_failed", err)
	}
	if cursorKind != nil {
		run.Cursor.Kind = *cursorKind
	}
	if cursorID != nil {
		run.Cursor.ResourceID = *cursorID
	}
	if lastError != nil {
		run.LastErrorCode = *lastError
	}
	return run, true, nil
}

func seedRootItems(ctx context.Context, tx pgx.Tx, runID, stamp string) error {
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO workspace_storage_operator_items (
			run_id, phase, kind, resource_id, space_id, legacy_storage_key,
			existing_storage_object_id, content_type, expected_byte_size, status, revision, updated_at
		)
		SELECT $1, 'root', 'attachment', a.id, a.space_id, a.storage_key,
			a.storage_object_id, a.mime_type, a.byte_size, 'pending', 1, $2
		FROM attachments a
		WHERE a.status = 'available' AND a.storage_key IS NOT NULL
		ON CONFLICT (run_id, phase, kind, resource_id) DO NOTHING`, []any{runID, stamp}},
		{`INSERT INTO workspace_storage_operator_items (
			run_id, phase, kind, resource_id, legacy_storage_key,
			existing_storage_object_id, content_type, status, revision, updated_at
		)
		SELECT $1, 'root', 'avatar', u.id, u.avatar_storage_key,
			u.avatar_storage_object_id, 'image/webp', 'pending', 1, $2
		FROM users u
		WHERE u.avatar_storage_key IS NOT NULL AND u.avatar_version IS NOT NULL
		ON CONFLICT (run_id, phase, kind, resource_id) DO NOTHING`, []any{runID, stamp}},
		{`INSERT INTO workspace_storage_operator_items (
			run_id, phase, kind, resource_id, legacy_storage_key,
			existing_storage_object_id, content_type, expected_sha256, expected_byte_size,
			status, revision, updated_at
		)
		SELECT $1, 'root', 'customEmote', e.id, e.storage_key,
			e.storage_object_id, COALESCE(NULLIF(e.normalized_mime_type, ''), 'image/webp'),
			e.sha256, e.byte_size, 'pending', 1, $2
		FROM workspace_custom_emotes e
		WHERE e.storage_key IS NOT NULL
		ON CONFLICT (run_id, phase, kind, resource_id) DO NOTHING`, []any{runID, stamp}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			return journalFailure("storageops.journal_inventory_failed", err)
		}
	}
	return nil
}

func refreshRunTotal(ctx context.Context, tx pgx.Tx, runID, stamp string, bumpRevision bool) error {
	query := `UPDATE workspace_storage_operator_runs
		SET total_items = (SELECT COUNT(*) FROM workspace_storage_operator_items WHERE run_id = $1), updated_at = $2`
	if bumpRevision {
		query += `, revision = revision + 1`
	}
	query += ` WHERE id = $1`
	if _, err := tx.Exec(ctx, query, runID, stamp); err != nil {
		return journalFailure("storageops.journal_total_failed", err)
	}
	return nil
}

func ensureFingerprint(ctx context.Context, tx pgx.Tx, runID, fingerprint string) error {
	var existing string
	if err := tx.QueryRow(ctx, `SELECT schema_fingerprint FROM workspace_storage_operator_runs WHERE id = $1`, runID).Scan(&existing); err != nil {
		return journalFailure("storageops.journal_fingerprint_failed", err)
	}
	if existing != fingerprint {
		return backfillError("storageops.journal_fingerprint_mismatch", nil)
	}
	return nil
}

func lockTarget(ctx context.Context, tx pgx.Tx, item BackfillItem) (previousID string, err error) {
	if _, err := lockJournalItem(ctx, tx, item); err != nil {
		return "", err
	}
	var previous *string
	switch item.Kind {
	case "attachment":
		if strings.TrimSpace(item.SpaceID) == "" {
			return "", backfillError("storageops.attachment_space_required", nil)
		}
		var legacyKey, contentType, status string
		var byteSize int64
		err = tx.QueryRow(ctx, `SELECT storage_object_id, storage_key, byte_size, mime_type, status
			FROM attachments WHERE id = $1 AND space_id = $2 FOR UPDATE`, item.ResourceID, item.SpaceID).Scan(
			&previous, &legacyKey, &byteSize, &contentType, &status)
		if err == nil && (status != "available" || strings.TrimSpace(legacyKey) != strings.TrimSpace(item.LegacyStorageKey) ||
			(item.ExpectedByteSize != nil && *item.ExpectedByteSize != byteSize) ||
			!contentTypeMatches(item.ContentType, contentType)) {
			return "", backfillError("storageops.target_snapshot_conflict", nil)
		}
	case "avatar":
		var legacyKey *string
		err = tx.QueryRow(ctx, `SELECT avatar_storage_object_id, avatar_storage_key
			FROM users WHERE id = $1 FOR UPDATE`, item.ResourceID).Scan(&previous, &legacyKey)
		if err == nil && (legacyKey == nil || strings.TrimSpace(*legacyKey) != strings.TrimSpace(item.LegacyStorageKey) || item.ExpectedByteSize != nil || strings.TrimSpace(item.ExpectedSHA256) != "") {
			return "", backfillError("storageops.target_snapshot_conflict", nil)
		}
	case "customEmote":
		var legacyKey, sourceID, contentType, actualSHA *string
		var byteSize *int64
		err = tx.QueryRow(ctx, `SELECT storage_object_id, storage_key, source_custom_emote_id,
			 normalized_mime_type, sha256, byte_size
			FROM workspace_custom_emotes WHERE id = $1 FOR UPDATE`, item.ResourceID).Scan(
			&previous, &legacyKey, &sourceID, &contentType, &actualSHA, &byteSize)
		if err == nil {
			if item.Phase == BackfillPhaseClone {
				if (legacyKey != nil && strings.TrimSpace(*legacyKey) != "") || sourceID == nil || strings.TrimSpace(*sourceID) != strings.TrimSpace(item.SourceCustomEmoteID) ||
					item.ExpectedByteSize != nil || strings.TrimSpace(item.ExpectedSHA256) != "" || !contentTypeMatches(item.ContentType, effectiveEmoteContentType(contentType)) {
					return "", backfillError("storageops.target_snapshot_conflict", nil)
				}
			} else if legacyKey == nil || strings.TrimSpace(*legacyKey) != strings.TrimSpace(item.LegacyStorageKey) ||
				(sourceID != nil && strings.TrimSpace(*sourceID) != strings.TrimSpace(item.SourceCustomEmoteID)) ||
				!expectedSizeMatches(item.ExpectedByteSize, byteSize) || !expectedDigestMatches(item.ExpectedSHA256, actualSHA) ||
				!contentTypeMatches(item.ContentType, effectiveEmoteContentType(contentType)) {
				return "", backfillError("storageops.target_snapshot_conflict", nil)
			}
		}
	default:
		return "", backfillError("storageops.item_kind_invalid", nil)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "", backfillError("storageops.target_not_found", nil)
	}
	if err != nil {
		return "", journalFailure("storageops.target_lock_failed", err)
	}
	if !storageObjectRefMatches(item.ExistingStorageObjectID, previous) {
		return "", backfillError("storageops.target_snapshot_conflict", nil)
	}
	if previous != nil {
		previousID = strings.TrimSpace(*previous)
	}
	return previousID, nil
}

func bindTarget(ctx context.Context, tx pgx.Tx, item BackfillItem, previousID, objectID string) error {
	var command pgconn.CommandTag
	var err error
	expectedSize := any(nil)
	if item.ExpectedByteSize != nil {
		expectedSize = *item.ExpectedByteSize
	}
	previousID = strings.TrimSpace(previousID)
	switch item.Kind {
	case "attachment":
		if strings.TrimSpace(item.SpaceID) == "" {
			return backfillError("storageops.attachment_space_required", nil)
		}
		command, err = tx.Exec(ctx, `UPDATE attachments SET storage_object_id = $1
			WHERE id = $2 AND space_id = $3 AND COALESCE(storage_object_id, '') = $4
			AND storage_key = $5 AND status = 'available'
			AND ($6 = '' OR LOWER(mime_type) = LOWER($6))
			AND ($7::BIGINT IS NULL OR byte_size = $7)`, objectID, item.ResourceID, item.SpaceID,
			previousID, strings.TrimSpace(item.LegacyStorageKey), strings.TrimSpace(item.ContentType), expectedSize)
	case "avatar":
		command, err = tx.Exec(ctx, `UPDATE users SET avatar_storage_object_id = $1
			WHERE id = $2 AND COALESCE(avatar_storage_object_id, '') = $3 AND avatar_storage_key = $4`,
			objectID, item.ResourceID, previousID, strings.TrimSpace(item.LegacyStorageKey))
	case "customEmote":
		if item.Phase == BackfillPhaseClone {
			command, err = tx.Exec(ctx, `UPDATE workspace_custom_emotes SET storage_object_id = $1
				WHERE id = $2 AND COALESCE(storage_object_id, '') = $3 AND storage_key IS NULL
				AND source_custom_emote_id = $4
				AND LOWER(COALESCE(NULLIF(normalized_mime_type, ''), 'image/webp')) = LOWER($5)`,
				objectID, item.ResourceID, previousID, strings.TrimSpace(item.SourceCustomEmoteID), strings.TrimSpace(item.ContentType))
		} else {
			command, err = tx.Exec(ctx, `UPDATE workspace_custom_emotes SET storage_object_id = $1
				WHERE id = $2 AND COALESCE(storage_object_id, '') = $3 AND storage_key = $4
				AND ($5 = '' OR LOWER(COALESCE(NULLIF(normalized_mime_type, ''), 'image/webp')) = LOWER($5))
				AND ($6::BIGINT IS NULL OR byte_size = $6)
				AND ($7 = '' OR LOWER(COALESCE(sha256, '')) = LOWER($7))`,
				objectID, item.ResourceID, previousID, strings.TrimSpace(item.LegacyStorageKey),
				strings.TrimSpace(item.ContentType), expectedSize, strings.TrimSpace(item.ExpectedSHA256))
		}
	default:
		return backfillError("storageops.item_kind_invalid", nil)
	}
	if err != nil {
		return journalFailure("storageops.target_bind_failed", err)
	}
	if command.RowsAffected() != 1 {
		return backfillError("storageops.target_not_found", nil)
	}
	return nil
}

func expectedSizeMatches(expected *int64, actual *int64) bool {
	if expected == nil {
		return true
	}
	return actual != nil && *expected == *actual
}

func expectedDigestMatches(expected string, actual *string) bool {
	if strings.TrimSpace(expected) == "" {
		return true
	}
	if actual == nil {
		return false
	}
	expectedDigest, expectedErr := storage.NormalizeSHA256(expected)
	actualDigest, actualErr := storage.NormalizeSHA256(*actual)
	return expectedErr == nil && actualErr == nil && expectedDigest == actualDigest
}

func contentTypeMatches(expected, actual string) bool {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	return expected == "" || (actual != "" && strings.EqualFold(expected, actual))
}

func storageObjectRefMatches(expected string, actual *string) bool {
	expected = strings.TrimSpace(expected)
	if actual == nil {
		return expected == ""
	}
	return expected == strings.TrimSpace(*actual)
}

func effectiveEmoteContentType(value *string) string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return "image/webp"
	}
	return strings.TrimSpace(*value)
}

func lockStorageObjects(ctx context.Context, tx pgx.Tx, IDs ...string) error {
	unique := make(map[string]struct{}, len(IDs))
	ordered := make([]string, 0, len(IDs))
	for _, id := range IDs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, exists := unique[id]; exists {
			continue
		}
		unique[id] = struct{}{}
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	for _, id := range ordered {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "workspace-storage-object:"+id); err != nil {
			return journalFailure("storageops.object_lock_failed", err)
		}
	}
	return nil
}

func validateBackfillObject(object BackfillObject) (string, string, string, error) {
	digest, err := storage.NormalizeSHA256(object.SHA256)
	if err != nil {
		return "", "", "", backfillError("storageops.object_digest_invalid", err)
	}
	key, err := storage.CanonicalObjectKey(digest)
	if err != nil || object.ObjectKey != key {
		return "", "", "", backfillError("storageops.object_key_invalid", err)
	}
	if object.ByteSize < 0 || object.ByteSize > storage.DefaultMaxObjectBytes {
		return "", "", "", backfillError("storageops.object_size_invalid", nil)
	}
	objectID := "wso_" + digest
	if object.ID != "" && object.ID != objectID {
		return "", "", "", backfillError("storageops.object_id_invalid", nil)
	}
	return digest, key, objectID, nil
}

func scanBackfillItem(row interface{ Scan(...any) error }) (item BackfillItem, err error) {
	var spaceID, legacyKey, objectID, sourceID, contentType, expectedSHA *string
	if err := row.Scan(&item.RunID, &item.Phase, &item.Kind, &item.ResourceID, &spaceID, &legacyKey,
		&objectID, &sourceID, &contentType, &expectedSHA, &item.ExpectedByteSize,
		&item.Status, &item.Revision, &item.FenceTokenHash); err != nil {
		return item, err
	}
	if spaceID != nil {
		item.SpaceID = *spaceID
	}
	if legacyKey != nil {
		item.LegacyStorageKey = *legacyKey
	}
	if objectID != nil {
		item.ExistingStorageObjectID = *objectID
	}
	if sourceID != nil {
		item.SourceCustomEmoteID = *sourceID
	}
	if contentType != nil {
		item.ContentType = *contentType
	}
	if expectedSHA != nil {
		item.ExpectedSHA256 = *expectedSHA
	}
	return item, nil
}

func validateRunRequest(request BackfillRunRequest) error {
	if strings.TrimSpace(request.RunID) == "" {
		return backfillError("storageops.run_id_required", nil)
	}
	if strings.TrimSpace(request.ManifestFingerprint) == "" {
		return backfillError("storageops.manifest_fingerprint_required", nil)
	}
	if len(request.FenceTokenHash) != 64 || strings.ToLower(request.FenceTokenHash) != request.FenceTokenHash {
		return backfillError("storageops.fence_hash_invalid", nil)
	}
	if _, err := hex.DecodeString(request.FenceTokenHash); err != nil {
		return backfillError("storageops.fence_hash_invalid", nil)
	}
	return nil
}

func validateRecoveryRequest(request BackfillRecoveryRequest) error {
	if strings.TrimSpace(request.RunID) == "" {
		return backfillError("storageops.run_id_required", nil)
	}
	if strings.TrimSpace(request.ManifestFingerprint) == "" {
		return backfillError("storageops.manifest_fingerprint_required", nil)
	}
	if request.ExpectedRevision <= 0 {
		return backfillError("storageops.journal_recovery_revision_invalid", nil)
	}
	if err := validateFenceHash(request.PreviousFenceTokenHash); err != nil {
		return err
	}
	if err := validateFenceHash(request.NewFenceTokenHash); err != nil {
		return err
	}
	if request.PreviousFenceTokenHash == request.NewFenceTokenHash {
		return backfillError("storageops.journal_recovery_fence_unchanged", nil)
	}
	return nil
}

func validateFenceHash(value string) error {
	if len(value) != 64 || strings.ToLower(value) != value {
		return backfillError("storageops.fence_hash_invalid", nil)
	}
	if _, err := hex.DecodeString(value); err != nil {
		return backfillError("storageops.fence_hash_invalid", nil)
	}
	return nil
}

func validatePageRequest(runID, phase string, cursor BackfillCursor, limit int) error {
	if strings.TrimSpace(runID) == "" || (phase != BackfillPhaseRoot && phase != BackfillPhaseClone) {
		return backfillError("storageops.page_invalid", nil)
	}
	if limit <= 0 || limit > 1000 || !validCursor(cursor) {
		return backfillError("storageops.page_invalid", nil)
	}
	return nil
}

func validCursor(cursor BackfillCursor) bool {
	return cursor.Empty() || (strings.TrimSpace(cursor.Kind) != "" && strings.TrimSpace(cursor.ResourceID) != "")
}

func normalizeJournalTime(at time.Time) string {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return at.UTC().Format(time.RFC3339Nano)
}

func safeErrorCode(code string) string {
	code = strings.TrimSpace(code)
	if code == "" || len(code) > 128 {
		return "storageops.backfill_failed"
	}
	for _, character := range code {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' && character != '.' && character != '-' {
			return "storageops.backfill_failed"
		}
	}
	return code
}

func journalFailure(code string, cause error) error {
	return &BackfillError{Code: code, Cause: cause}
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr != nil && pgErr.Code == "23505"
}

func validPGIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 63 {
		return false
	}
	for index, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '_' {
			return false
		}
		if index == 0 && character >= '0' && character <= '9' {
			return false
		}
	}
	return true
}

func quotePGIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}
