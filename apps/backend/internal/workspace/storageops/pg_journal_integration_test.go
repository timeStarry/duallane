//go:build postgres_integration

package storageops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

var integrationSchemaSequence uint64

func TestPGBackfillLocalStoreAndJournalContract(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	schema := createStorageOpsSchema(t, pool)
	defer dropStorageOpsSchema(t, pool, schema)

	root := t.TempDir()
	local, err := storage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	store := newLocalBackfillStore(local)
	shared := []byte("shared canonical bytes")
	avatar := []byte("avatar bytes")
	store.putLegacy(t, "legacy/att-1", "att-1", shared, "text/plain")
	store.putLegacy(t, "legacy/avatar-1", "avatar-1", avatar, "image/webp")
	store.putLegacy(t, "legacy/emote-root", "emote-root", shared, "image/png")
	insertStorageFixture(t, pool, schema, shared, avatar)

	journal, err := NewPGJournal(pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := "node-storage-contract-032"
	guard := &integrationFence{lease: MutationLease{RunID: "backfill-pg-local", Token: "synthetic-owner-token"}}
	report, err := RunBackfill(ctx, BackfillOptions{
		Journal:             journal,
		Store:               store,
		Guard:               guard,
		RunID:               guard.lease.RunID,
		ManifestFingerprint: fingerprint,
		PageSize:            1,
		Now:                 func() time.Time { return time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "completed" || report.Summary.TotalItems != 4 || report.Summary.ProcessedItems != 4 || report.Summary.Created != 2 || report.Summary.Reused != 1 || report.Summary.BoundClones != 1 {
		t.Fatalf("report = %#v", report)
	}
	var fenceHash string
	if err := querySchema(ctx, pool, schema, `SELECT fence_token_hash FROM workspace_storage_operator_runs WHERE id = 'backfill-pg-local'`, &fenceHash); err != nil {
		t.Fatal(err)
	}
	if fenceHash != FenceTokenHash(guard.lease.Token) {
		t.Fatalf("journal stored raw or unexpected fence hash: %q", fenceHash)
	}
	// Node's operator counts each completed logical reference, including a
	// clone, while unique bytes count each canonical digest only once.
	if report.Summary.LogicalBytes != int64(3*len(shared)+len(avatar)) {
		t.Fatalf("logical bytes = %d", report.Summary.LogicalBytes)
	}
	if report.Summary.DeduplicatedBytes != int64(2*len(shared)) {
		t.Fatalf("deduplicated bytes = %d", report.Summary.DeduplicatedBytes)
	}
	if report.Summary.UniqueBytes != int64(len(shared)+len(avatar)) {
		t.Fatalf("unique bytes = %d", report.Summary.UniqueBytes)
	}

	var objectCount, attachmentRefs, cloneRefs int
	if err := querySchema(ctx, pool, schema, `SELECT COUNT(*) FROM workspace_storage_objects`, &objectCount); err != nil {
		t.Fatal(err)
	}
	if err := querySchema(ctx, pool, schema, `SELECT COUNT(*) FROM attachments WHERE storage_object_id IS NOT NULL`, &attachmentRefs); err != nil {
		t.Fatal(err)
	}
	if err := querySchema(ctx, pool, schema, `SELECT COUNT(*) FROM workspace_custom_emotes WHERE storage_object_id IS NOT NULL`, &cloneRefs); err != nil {
		t.Fatal(err)
	}
	if objectCount != 2 || attachmentRefs != 1 || cloneRefs != 2 {
		t.Fatalf("registry counts objects=%d attachmentRefs=%d emoteRefs=%d", objectCount, attachmentRefs, cloneRefs)
	}
	var itemStatus string
	var itemRevision int
	if err := querySchema(ctx, pool, schema, `SELECT status, revision FROM workspace_storage_operator_items WHERE run_id = 'backfill-pg-local' AND resource_id = 'att-1'`, &itemStatus, &itemRevision); err != nil {
		t.Fatal(err)
	}
	if itemStatus != BackfillItemCompleted || itemRevision != 2 {
		t.Fatalf("atomic item completion status=%q revision=%d", itemStatus, itemRevision)
	}
	for _, key := range []string{"legacy/att-1", "legacy/avatar-1", "legacy/emote-root"} {
		if _, err := local.Open(ctx, store.legacyObjects[key], storage.DefaultMaxObjectBytes); err != nil {
			t.Fatalf("legacy %q was not preserved: %v", key, err)
		}
	}

	putsBeforeReplay := store.puts
	replay, err := RunBackfill(ctx, BackfillOptions{
		Journal:             journal,
		Store:               store,
		Guard:               &integrationFence{lease: MutationLease{RunID: guard.lease.RunID, Token: "synthetic-replay-token"}},
		RunID:               guard.lease.RunID,
		ManifestFingerprint: fingerprint,
		PageSize:            2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if replay.Status != "completed" || store.puts != putsBeforeReplay {
		t.Fatalf("replay = %#v puts %d -> %d", replay, putsBeforeReplay, store.puts)
	}

	_, err = RunBackfill(ctx, BackfillOptions{
		Journal:             journal,
		Store:               store,
		Guard:               &integrationFence{lease: MutationLease{RunID: guard.lease.RunID, Token: "synthetic-mismatch-token"}},
		RunID:               guard.lease.RunID,
		ManifestFingerprint: "different-fingerprint",
	})
	if BackfillErrorCode(err) != "storageops.journal_fingerprint_mismatch" {
		t.Fatalf("fingerprint mismatch code = %q, error = %v", BackfillErrorCode(err), err)
	}
}

func TestPGJournalRunConstraintRequiresActiveOperation(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	schema := createStorageOpsSchema(t, pool)
	defer dropStorageOpsSchema(t, pool, schema)
	_, err := execSchema(ctx, pool, schema, `
		INSERT INTO workspace_storage_operator_runs (
			id, operation, state, schema_fingerprint, fence_token_hash,
			phase, started_at, updated_at
		) VALUES ('invalid-null-active', 'backfill', 'running', 'fingerprint', $1, 'root', $2, $2)`,
		FenceTokenHash("constraint-token"), time.Now().UTC().Format(time.RFC3339Nano))
	if err == nil {
		t.Fatal("running journal row with NULL active_operation was accepted")
	}
}

func TestPGJournalFailsClosedWhenPrivateSchemaTablesAreMissing(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	sequence := atomic.AddUint64(&integrationSchemaSequence, 1)
	schema := fmt.Sprintf("storageops_empty_%x", sequence)
	if _, err := pool.Exec(ctx, `CREATE SCHEMA `+quotePGIdentifier(schema)); err != nil {
		t.Fatal(err)
	}
	defer dropStorageOpsSchema(t, pool, schema)
	journal, err := NewPGJournal(pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Summary(ctx, "missing"); BackfillErrorCode(err) != "storageops.summary_failed" {
		t.Fatalf("missing private tables did not fail closed: code=%q err=%v", BackfillErrorCode(err), err)
	}
}

func TestPGJournalRollsBackAfterPanic(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	schema := createStorageOpsSchema(t, pool)
	defer dropStorageOpsSchema(t, pool, schema)
	journal, err := NewPGJournal(pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	panicValue := "synthetic-journal-panic"
	func() {
		defer func() {
			if recovered := recover(); recovered != panicValue {
				t.Fatalf("panic = %v, want %q", recovered, panicValue)
			}
		}()
		tx, beginErr := journal.begin(ctx)
		if beginErr != nil {
			t.Fatal(beginErr)
		}
		var txErr error
		defer finishJournalTx(ctx, tx, &txErr)
		_, txErr = tx.Exec(ctx, `INSERT INTO workspace_storage_operator_runs (
			id, operation, state, active_operation, schema_fingerprint, fence_token_hash,
			phase, revision, total_items, processed_items, started_at, updated_at
		) VALUES ('panic-run', 'backfill', 'running', 'backfill', 'panic-fingerprint', $1,
			'root', 1, 0, 0, $2, $2)`, FenceTokenHash("panic-token"), time.Now().UTC().Format(time.RFC3339Nano))
		if txErr != nil {
			t.Fatal(txErr)
		}
		panic(panicValue)
	}()
	var runCount int
	if err := querySchema(ctx, pool, schema, `SELECT COUNT(*) FROM workspace_storage_operator_runs WHERE id = 'panic-run'`, &runCount); err != nil {
		t.Fatal(err)
	}
	if runCount != 0 {
		t.Fatalf("panic committed journal row count=%d", runCount)
	}
}

func TestPGJournalRecoveryRotatesOnlyExpectedRunningFence(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	schema := createStorageOpsSchema(t, pool)
	defer dropStorageOpsSchema(t, pool, schema)
	if _, err := execSchema(ctx, pool, schema, `
		INSERT INTO attachments (id, space_id, status, mime_type, byte_size, storage_key)
		VALUES ('att-recovery', 'space-recovery', 'available', 'text/plain', 1, 'legacy/recovery')`); err != nil {
		t.Fatal(err)
	}
	oldHash := FenceTokenHash("recovery-old")
	newHash := FenceTokenHash("recovery-new")
	run, err := NewPGJournal(pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	current, err := run.BeginOrResume(ctx, BackfillRunRequest{RunID: "backfill-recovery", ManifestFingerprint: "recovery-fingerprint", FenceTokenHash: oldHash})
	if err != nil {
		t.Fatal(err)
	}
	page, err := run.ListPage(ctx, current.ID, current.Phase, BackfillCursor{}, 1)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("recovery page=%#v err=%v", page.Items, err)
	}
	if _, err := run.RecoverRunning(ctx, BackfillRecoveryRequest{
		RunID: "backfill-recovery", ManifestFingerprint: "recovery-fingerprint",
		PreviousFenceTokenHash: oldHash, NewFenceTokenHash: newHash, ExpectedRevision: current.Revision + 1,
	}); BackfillErrorCode(err) != "storageops.journal_recovery_conflict" {
		t.Fatalf("wrong recovery revision code=%q err=%v", BackfillErrorCode(err), err)
	}
	recovered, err := run.RecoverRunning(ctx, BackfillRecoveryRequest{
		RunID: "backfill-recovery", ManifestFingerprint: "recovery-fingerprint",
		PreviousFenceTokenHash: oldHash, NewFenceTokenHash: newHash, ExpectedRevision: current.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if recovered.FenceTokenHash != newHash || recovered.Revision != current.Revision+1 || recovered.State != "running" {
		t.Fatalf("recovered run=%#v", recovered)
	}
	digest := strings.Repeat("d", 64)
	if _, err := run.AcquireAndBind(ctx, page.Items[0], BackfillObject{
		ID: "wso_" + digest, SHA256: digest,
		ObjectKey: "workspace/objects/sha256/dd/" + digest, ByteSize: 1, ContentType: "text/plain",
	}, time.Now().UTC()); BackfillErrorCode(err) != "storageops.journal_fence_conflict" {
		t.Fatalf("stale page mutation code=%q err=%v", BackfillErrorCode(err), err)
	}
	if _, err := run.BeginOrResume(ctx, BackfillRunRequest{RunID: "backfill-recovery", ManifestFingerprint: "recovery-fingerprint", FenceTokenHash: oldHash}); BackfillErrorCode(err) != "storageops.journal_active" {
		t.Fatalf("old fence reentry code=%q err=%v", BackfillErrorCode(err), err)
	}
	resumed, err := run.BeginOrResume(ctx, BackfillRunRequest{RunID: "backfill-recovery", ManifestFingerprint: "recovery-fingerprint", FenceTokenHash: newHash})
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Revision != recovered.Revision || resumed.FenceTokenHash != newHash {
		t.Fatalf("same recovered fence did not resume: %#v", resumed)
	}
}

func TestPGJournalCloneCycleAndCASRollback(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	schema := createStorageOpsSchema(t, pool)
	defer dropStorageOpsSchema(t, pool, schema)
	if _, err := execSchema(ctx, pool, schema, `
		INSERT INTO workspace_custom_emotes (id, storage_key, source_custom_emote_id, normalized_mime_type, byte_size)
		VALUES ('emote-cycle-a', NULL, 'emote-cycle-b', 'image/png', NULL),
		       ('emote-cycle-b', NULL, 'emote-cycle-a', 'image/png', NULL)`); err != nil {
		t.Fatal(err)
	}
	journal, err := NewPGJournal(pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	store := newLocalBackfillStore(nil)
	guard := &integrationFence{lease: MutationLease{RunID: "backfill-pg-cycle", Token: "synthetic-cycle-token"}}
	_, err = RunBackfill(ctx, BackfillOptions{
		Journal:             journal,
		Store:               store,
		Guard:               guard,
		RunID:               guard.lease.RunID,
		ManifestFingerprint: "cycle-fingerprint",
		PageSize:            10,
	})
	if BackfillErrorCode(err) != "storageops.clone_cycle" {
		t.Fatalf("cycle code = %q, error = %v", BackfillErrorCode(err), err)
	}
	var objectCount int
	if err := querySchema(ctx, pool, schema, `SELECT COUNT(*) FROM workspace_storage_objects`, &objectCount); err != nil {
		t.Fatal(err)
	}
	if objectCount != 0 {
		t.Fatalf("cycle created registry objects = %d", objectCount)
	}
	var runState, itemState, itemError string
	if err := querySchema(ctx, pool, schema, `SELECT state FROM workspace_storage_operator_runs WHERE id = 'backfill-pg-cycle'`, &runState); err != nil {
		t.Fatal(err)
	}
	if err := querySchema(ctx, pool, schema, `SELECT status, last_error_code FROM workspace_storage_operator_items WHERE run_id = 'backfill-pg-cycle' AND resource_id = 'emote-cycle-a'`, &itemState, &itemError); err != nil {
		t.Fatal(err)
	}
	if runState != "failed" || itemState != "failed" || itemError != "storageops.clone_cycle" {
		t.Fatalf("cycle journal state run=%q item=%q error=%q", runState, itemState, itemError)
	}

	casRun, err := journal.BeginOrResume(ctx, BackfillRunRequest{
		RunID:               "backfill-pg-cas",
		ManifestFingerprint: "cas-fingerprint",
		FenceTokenHash:      FenceTokenHash("cas-token"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := execSchema(ctx, pool, schema, `
		INSERT INTO workspace_storage_operator_items (
			run_id, phase, kind, resource_id, space_id, legacy_storage_key,
			content_type, expected_byte_size, status, revision, updated_at
		) VALUES ('backfill-pg-cas', 'root', 'attachment', 'missing', 'space', 'legacy/missing',
			'text/plain', 1, 'pending', 1, $1)`, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	rootItem := BackfillItem{
		RunID: "backfill-pg-cas", Phase: BackfillPhaseRoot, Kind: "attachment", ResourceID: "missing",
		SpaceID: "space", LegacyStorageKey: "legacy/missing", ContentType: "text/plain", ExpectedByteSize: int64Pointer(1),
		FenceTokenHash: casRun.FenceTokenHash, Status: BackfillItemPending, Revision: 1,
	}
	_, err = journal.AcquireAndBind(ctx, rootItem, BackfillObject{
		ID: "wso_" + strings.Repeat("b", 64), SHA256: strings.Repeat("b", 64),
		ObjectKey: "workspace/objects/sha256/bb/" + strings.Repeat("b", 64), ByteSize: 1,
	}, time.Now().UTC())
	if BackfillErrorCode(err) != "storageops.target_not_found" {
		t.Fatalf("missing target code = %q, error = %v", BackfillErrorCode(err), err)
	}
	if err := querySchema(ctx, pool, schema, `SELECT COUNT(*) FROM workspace_storage_objects`, &objectCount); err != nil {
		t.Fatal(err)
	}
	if objectCount != 0 {
		t.Fatalf("failed target transaction left object = %d", objectCount)
	}
}

func TestPGJournalRejectsStaleItemOrTargetBeforeBinding(t *testing.T) {
	tests := []struct {
		name     string
		mutation string
		wantCode string
	}{
		{name: "journal revision", mutation: `UPDATE workspace_storage_operator_items SET revision = revision + 1 WHERE run_id = 'backfill-stale'`, wantCode: "storageops.journal_cas_conflict"},
		{name: "legacy key", mutation: `UPDATE attachments SET storage_key = 'legacy/changed' WHERE id = 'att-stale'`, wantCode: "storageops.target_snapshot_conflict"},
		{name: "expected bytes", mutation: `UPDATE attachments SET byte_size = 2 WHERE id = 'att-stale'`, wantCode: "storageops.target_snapshot_conflict"},
		{name: "storage reference", mutation: `UPDATE attachments SET storage_object_id = 'wso_changed' WHERE id = 'att-stale'`, wantCode: "storageops.target_snapshot_conflict"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := openStorageOpsIntegrationPool(t)
			ctx := context.Background()
			schema := createStorageOpsSchema(t, pool)
			defer dropStorageOpsSchema(t, pool, schema)
			if _, err := execSchema(ctx, pool, schema, `
				INSERT INTO attachments (id, space_id, status, mime_type, byte_size, storage_key)
				VALUES ('att-stale', 'space-stale', 'available', 'text/plain', 1, 'legacy/stale')`); err != nil {
				t.Fatal(err)
			}
			journal, err := NewPGJournal(pool, schema)
			if err != nil {
				t.Fatal(err)
			}
			run, err := journal.BeginOrResume(ctx, BackfillRunRequest{
				RunID: "backfill-stale", ManifestFingerprint: "stale-fingerprint", FenceTokenHash: FenceTokenHash("stale-token"),
			})
			if err != nil {
				t.Fatal(err)
			}
			page, err := journal.ListPage(ctx, run.ID, run.Phase, BackfillCursor{}, 1)
			if err != nil || len(page.Items) != 1 {
				t.Fatalf("page=%#v err=%v", page.Items, err)
			}
			if _, err := execSchema(ctx, pool, schema, test.mutation); err != nil {
				t.Fatal(err)
			}
			digest := strings.Repeat("b", 64)
			_, err = journal.AcquireAndBind(ctx, page.Items[0], BackfillObject{
				ID: "wso_" + digest, SHA256: digest,
				ObjectKey: "workspace/objects/sha256/bb/" + digest, ByteSize: 1, ContentType: "text/plain",
			}, time.Now().UTC())
			if BackfillErrorCode(err) != test.wantCode {
				t.Fatalf("error code=%q err=%v", BackfillErrorCode(err), err)
			}
			var objectCount int
			if err := querySchema(ctx, pool, schema, `SELECT COUNT(*) FROM workspace_storage_objects`, &objectCount); err != nil {
				t.Fatal(err)
			}
			if objectCount != 0 {
				t.Fatalf("stale mutation acquired object=%d", objectCount)
			}
			if test.name == "storage reference" {
				var targetRef string
				if err := querySchema(ctx, pool, schema, `SELECT storage_object_id FROM attachments WHERE id = 'att-stale'`, &targetRef); err != nil {
					t.Fatal(err)
				}
				if targetRef != "wso_changed" {
					t.Fatalf("stale target reference changed to %q", targetRef)
				}
			}
		})
	}
}

func TestPGJournalRejectsPendingCompletionWithoutBinding(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	schema := createStorageOpsSchema(t, pool)
	defer dropStorageOpsSchema(t, pool, schema)
	if _, err := execSchema(ctx, pool, schema, `
		INSERT INTO attachments (id, space_id, status, mime_type, byte_size, storage_key)
		VALUES ('att-pending-completion', 'space-pending', 'available', 'text/plain', 1, 'legacy/pending')`); err != nil {
		t.Fatal(err)
	}
	journal, err := NewPGJournal(pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	run, err := journal.BeginOrResume(ctx, BackfillRunRequest{
		RunID: "backfill-pending-completion", ManifestFingerprint: "pending-completion-fingerprint", FenceTokenHash: FenceTokenHash("pending-completion-token"),
	})
	if err != nil {
		t.Fatal(err)
	}
	page, err := journal.ListPage(ctx, run.ID, run.Phase, BackfillCursor{}, 1)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("page=%#v err=%v", page.Items, err)
	}
	digest := strings.Repeat("d", 64)
	err = journal.MarkItemCompleted(ctx, page.Items[0], BackfillResult{
		Object: BackfillObject{
			ID: "wso_" + digest, SHA256: digest,
			ObjectKey: "workspace/objects/sha256/dd/" + digest, ByteSize: 1,
		},
		Action: BackfillActionCreated,
	}, time.Now().UTC())
	if BackfillErrorCode(err) != "storageops.item_completion_requires_bind" {
		t.Fatalf("pending completion code=%q err=%v", BackfillErrorCode(err), err)
	}
	var itemStatus string
	var itemRevision int
	if err := querySchema(ctx, pool, schema, `SELECT status, revision FROM workspace_storage_operator_items WHERE run_id = 'backfill-pending-completion'`, &itemStatus, &itemRevision); err != nil {
		t.Fatal(err)
	}
	if itemStatus != BackfillItemPending || itemRevision != 1 {
		t.Fatalf("pending item changed status=%q revision=%d", itemStatus, itemRevision)
	}
	var targetRef *string
	if err := querySchema(ctx, pool, schema, `SELECT storage_object_id FROM attachments WHERE id = 'att-pending-completion'`, &targetRef); err != nil {
		t.Fatal(err)
	}
	if targetRef != nil {
		t.Fatalf("pending completion changed target reference to %q", *targetRef)
	}
	var objectCount int
	if err := querySchema(ctx, pool, schema, `SELECT COUNT(*) FROM workspace_storage_objects`, &objectCount); err != nil {
		t.Fatal(err)
	}
	if objectCount != 0 {
		t.Fatalf("pending completion created canonical objects=%d", objectCount)
	}
}

func TestPGJournalRejectsCloneReferenceOnlyChange(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	schema := createStorageOpsSchema(t, pool)
	defer dropStorageOpsSchema(t, pool, schema)
	if _, err := execSchema(ctx, pool, schema, `
		INSERT INTO workspace_custom_emotes (id, storage_key, source_custom_emote_id, normalized_mime_type, byte_size, sha256)
		VALUES ('clone-ref-root', 'legacy/clone-ref-root', NULL, 'image/png', 1, $1),
		       ('clone-ref-child', NULL, 'clone-ref-root', 'image/png', NULL, NULL)`, strings.Repeat("e", 64)); err != nil {
		t.Fatal(err)
	}
	journal, err := NewPGJournal(pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	run, err := journal.BeginOrResume(ctx, BackfillRunRequest{
		RunID: "backfill-clone-reference", ManifestFingerprint: "clone-reference-fingerprint", FenceTokenHash: FenceTokenHash("clone-reference-token"),
	})
	if err != nil {
		t.Fatal(err)
	}
	cloneRun, err := journal.EnsureCloneItems(ctx, run, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	page, err := journal.ListPage(ctx, cloneRun.ID, cloneRun.Phase, BackfillCursor{}, 1)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("clone page=%#v err=%v", page.Items, err)
	}
	if page.Items[0].ExistingStorageObjectID != "" {
		t.Fatalf("clone journal unexpectedly captured reference %q", page.Items[0].ExistingStorageObjectID)
	}
	if _, err := execSchema(ctx, pool, schema, `UPDATE workspace_custom_emotes SET storage_object_id = 'wso_changed' WHERE id = 'clone-ref-child'`); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.BindClone(ctx, page.Items[0], time.Now().UTC()); BackfillErrorCode(err) != "storageops.target_snapshot_conflict" {
		t.Fatalf("clone reference change code=%q err=%v", BackfillErrorCode(err), err)
	}
	var targetRef string
	if err := querySchema(ctx, pool, schema, `SELECT storage_object_id FROM workspace_custom_emotes WHERE id = 'clone-ref-child'`, &targetRef); err != nil {
		t.Fatal(err)
	}
	if targetRef != "wso_changed" {
		t.Fatalf("clone target reference changed to %q", targetRef)
	}
	var itemStatus string
	var itemRevision int
	if err := querySchema(ctx, pool, schema, `SELECT status, revision FROM workspace_storage_operator_items WHERE run_id = 'backfill-clone-reference' AND resource_id = 'clone-ref-child'`, &itemStatus, &itemRevision); err != nil {
		t.Fatal(err)
	}
	if itemStatus != BackfillItemPending || itemRevision != 1 {
		t.Fatalf("clone journal changed status=%q revision=%d", itemStatus, itemRevision)
	}
}

func TestPGJournalCloneChainIsBounded(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	schema := createStorageOpsSchema(t, pool)
	defer dropStorageOpsSchema(t, pool, schema)
	journal, err := NewPGJournal(pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	run, err := journal.BeginOrResume(ctx, BackfillRunRequest{
		RunID: "backfill-chain-limit", ManifestFingerprint: "chain-fingerprint", FenceTokenHash: FenceTokenHash("chain-token"),
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("c", 64)
	if _, err := execSchema(ctx, pool, schema, `
		INSERT INTO workspace_storage_objects (id, sha256, object_key, byte_size, content_type, created_at, verified_at)
		VALUES ($1, $2, $3, 1, 'image/png', $4, $4)`,
		"wso_"+digest, digest, "workspace/objects/sha256/cc/"+digest, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err := execSchema(ctx, pool, schema, `
		INSERT INTO workspace_custom_emotes (id, storage_key, storage_object_id, normalized_mime_type, byte_size, sha256)
		VALUES ('chain-terminal', 'legacy/chain-terminal', $1, 'image/png', 1, $2)`, "wso_"+digest, digest); err != nil {
		t.Fatal(err)
	}
	chainLength := maxCloneChainLength + 1
	values := make([]string, 0, chainLength)
	args := make([]any, 0, chainLength*4)
	for index := 0; index < chainLength; index++ {
		id := fmt.Sprintf("clone-chain-%04d", index)
		source := "chain-terminal"
		if index+1 < chainLength {
			source = fmt.Sprintf("clone-chain-%04d", index+1)
		}
		base := len(args) + 1
		values = append(values, fmt.Sprintf("($%d, NULL, $%d, 'image/png', NULL, NULL)", base, base+1))
		args = append(args, id, source)
	}
	query := `INSERT INTO workspace_custom_emotes (id, storage_key, source_custom_emote_id, normalized_mime_type, byte_size, sha256) VALUES ` + strings.Join(values, ",")
	if _, err := execSchema(ctx, pool, schema, query, args...); err != nil {
		t.Fatal(err)
	}
	cloneRun, err := journal.EnsureCloneItems(ctx, run, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	page, err := journal.ListPage(ctx, cloneRun.ID, cloneRun.Phase, BackfillCursor{}, 1)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("clone page=%#v err=%v", page.Items, err)
	}
	if _, err := journal.BindClone(ctx, page.Items[0], time.Now().UTC()); BackfillErrorCode(err) != "storageops.clone_chain_limit" {
		t.Fatalf("chain bound code=%q err=%v", BackfillErrorCode(err), err)
	}
	var terminalObjectRefs int
	if err := querySchema(ctx, pool, schema, `SELECT COUNT(*) FROM workspace_custom_emotes WHERE storage_object_id IS NOT NULL`, &terminalObjectRefs); err != nil {
		t.Fatal(err)
	}
	if terminalObjectRefs != 1 {
		t.Fatalf("bounded chain changed refs=%d", terminalObjectRefs)
	}
}

func TestPGJournalStablePageCAS(t *testing.T) {
	pool := openStorageOpsIntegrationPool(t)
	ctx := context.Background()
	schema := createStorageOpsSchema(t, pool)
	defer dropStorageOpsSchema(t, pool, schema)
	if _, err := execSchema(ctx, pool, schema, `
		INSERT INTO attachments (id, space_id, status, mime_type, byte_size, storage_key)
		VALUES ('att-b', 'space', 'available', 'text/plain', 1, 'legacy/b'),
		       ('att-a', 'space', 'available', 'text/plain', 1, 'legacy/a')`); err != nil {
		t.Fatal(err)
	}
	journal, err := NewPGJournal(pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	run, err := journal.BeginOrResume(ctx, BackfillRunRequest{RunID: "backfill-pg-page", ManifestFingerprint: "page-fingerprint", FenceTokenHash: FenceTokenHash("page-token")})
	if err != nil {
		t.Fatal(err)
	}
	page, err := journal.ListPage(ctx, run.ID, run.Phase, BackfillCursor{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ResourceID != "att-a" {
		t.Fatalf("first page = %#v", page.Items)
	}
	first := page.Items[0]
	if err := journal.MarkItemFailed(ctx, first, "storageops.synthetic_failure", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Advance(ctx, run, BackfillCursor{Kind: first.Kind, ResourceID: first.ResourceID}, 1, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Advance(ctx, run, BackfillCursor{Kind: first.Kind, ResourceID: first.ResourceID}, 1, time.Now().UTC()); BackfillErrorCode(err) != "storageops.journal_cas_conflict" {
		t.Fatalf("stale checkpoint code = %q, error = %v", BackfillErrorCode(err), err)
	}
	resumed, err := journal.BeginOrResume(ctx, BackfillRunRequest{RunID: run.ID, ManifestFingerprint: "page-fingerprint", FenceTokenHash: FenceTokenHash("resume-token")})
	if err == nil {
		_ = resumed
	}
	if BackfillErrorCode(err) != "storageops.journal_active" {
		t.Fatalf("active run reentry code = %q, error = %v", BackfillErrorCode(err), err)
	}
	if _, err := journal.Fail(ctx, BackfillRun{
		ID: run.ID, Operation: BackfillOperation, State: "running", Phase: BackfillPhaseRoot, Revision: run.Revision + 1,
		FenceTokenHash: run.FenceTokenHash,
	}, "storageops.synthetic_failure", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	var waitGroup sync.WaitGroup
	results := make(chan error, 2)
	for _, token := range []string{"concurrent-token-a", "concurrent-token-b"} {
		token := token
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			_, beginErr := journal.BeginOrResume(ctx, BackfillRunRequest{
				RunID: "backfill-pg-concurrent", ManifestFingerprint: "concurrent-fingerprint", FenceTokenHash: FenceTokenHash(token),
			})
			results <- beginErr
		}()
	}
	waitGroup.Wait()
	close(results)
	var successes, activeErrors int
	for beginErr := range results {
		if beginErr == nil {
			successes++
		} else if BackfillErrorCode(beginErr) == "storageops.journal_active" {
			activeErrors++
		}
	}
	if successes != 1 || activeErrors != 1 {
		t.Fatalf("concurrent begin results successes=%d active=%d", successes, activeErrors)
	}
}

type integrationFence struct {
	lease MutationLease
}

func (f *integrationFence) Acquire(context.Context, MutationAcquireRequest) (MutationLease, error) {
	return f.lease, nil
}

func (f *integrationFence) Assert(context.Context, MutationLease) error { return nil }

func (f *integrationFence) Release(context.Context, MutationLease) error { return nil }

type localBackfillStore struct {
	inner         *storage.LocalBlobStore
	legacyObjects map[string]storage.Object
	byResource    map[string]string
	puts          int
}

func newLocalBackfillStore(inner *storage.LocalBlobStore) *localBackfillStore {
	return &localBackfillStore{inner: inner, legacyObjects: make(map[string]storage.Object), byResource: make(map[string]string)}
}

func (s *localBackfillStore) putLegacy(t *testing.T, key, resourceID string, content []byte, contentType string) {
	t.Helper()
	digest := sha256.Sum256(content)
	sha := hex.EncodeToString(digest[:])
	if _, err := s.inner.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), sha); err != nil {
		t.Fatal(err)
	}
	s.legacyObjects[key] = storage.Object{Key: key, SHA256: sha, ByteSize: int64(len(content)), ContentType: contentType}
	s.byResource[resourceID] = key
}

func (s *localBackfillStore) Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (storage.StoredObject, error) {
	s.puts++
	return s.inner.Put(ctx, key, source, expectedSize, expectedSHA256)
}

func (s *localBackfillStore) Open(ctx context.Context, object storage.Object, maxBytes int64) (storage.OpenedObject, error) {
	return s.inner.Open(ctx, object, maxBytes)
}

func (s *localBackfillStore) InspectLegacy(ctx context.Context, item BackfillItem) (LegacyInspection, error) {
	object, err := s.legacyObject(item)
	if err != nil {
		return LegacyInspection{}, err
	}
	opened, err := s.inner.Open(ctx, object, storage.DefaultMaxObjectBytes)
	if err != nil {
		return LegacyInspection{}, err
	}
	_ = opened.Body.Close()
	return LegacyInspection{SHA256: object.SHA256, ByteSize: object.ByteSize}, nil
}

func (s *localBackfillStore) OpenLegacy(ctx context.Context, item BackfillItem) (storage.OpenedObject, error) {
	object, err := s.legacyObject(item)
	if err != nil {
		return storage.OpenedObject{}, err
	}
	return s.inner.Open(ctx, object, storage.DefaultMaxObjectBytes)
}

func (s *localBackfillStore) legacyObject(item BackfillItem) (storage.Object, error) {
	key := s.byResource[item.ResourceID]
	if key == "" {
		key = item.LegacyStorageKey
	}
	object, ok := s.legacyObjects[key]
	if !ok {
		return storage.Object{}, errors.New("synthetic legacy object missing")
	}
	return object, nil
}

func openStorageOpsIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is required for postgres integration")
	}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 4
	config.MinConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func createStorageOpsSchema(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	sequence := atomic.AddUint64(&integrationSchemaSequence, 1)
	schema := "storageops_test_" + hex.EncodeToString([]byte{byte(sequence >> 8), byte(sequence)}) + "_" + strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	if _, err := pool.Exec(context.Background(), `CREATE SCHEMA `+quotePGIdentifier(schema)); err != nil {
		t.Fatal(err)
	}
	ddl := `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  avatar_storage_key TEXT,
  avatar_version TEXT,
  avatar_storage_object_id TEXT
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  status TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  storage_key TEXT,
  storage_object_id TEXT
);
CREATE TABLE workspace_custom_emotes (
  id TEXT PRIMARY KEY,
  storage_key TEXT,
  storage_object_id TEXT,
  source_custom_emote_id TEXT,
  normalized_mime_type TEXT,
  byte_size INTEGER,
  sha256 TEXT
);
CREATE TABLE workspace_storage_objects (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  byte_size BIGINT NOT NULL,
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
`
	if _, err := execSchema(context.Background(), pool, schema, ddl); err != nil {
		t.Fatal(err)
	}
	data, fileErr := os.ReadFile(migration032Path())
	if fileErr != nil {
		t.Fatal(fileErr)
	}
	if _, err := execSchema(context.Background(), pool, schema, string(data)); err != nil {
		t.Fatal(err)
	}
	return schema
}

func insertStorageFixture(t *testing.T, pool *pgxpool.Pool, schema string, shared, avatar []byte) {
	t.Helper()
	sharedDigest := sha256Hex(shared)
	if _, err := execSchema(context.Background(), pool, schema, `
		INSERT INTO attachments (id, space_id, status, mime_type, byte_size, storage_key)
		VALUES ('att-1', 'space-1', 'available', 'text/plain', $1, 'legacy/att-1')`, int64(len(shared))); err != nil {
		t.Fatal(err)
	}
	if _, err := execSchema(context.Background(), pool, schema, `
		INSERT INTO users (id, avatar_storage_key, avatar_version)
		VALUES ('avatar-1', 'legacy/avatar-1', 'v1')`); err != nil {
		t.Fatal(err)
	}
	if _, err := execSchema(context.Background(), pool, schema, `
		INSERT INTO workspace_custom_emotes (id, storage_key, normalized_mime_type, byte_size, sha256)
		VALUES ('emote-root', 'legacy/emote-root', 'image/png', $1, $2),
		       ('emote-clone', NULL, 'image/png', NULL, NULL)`, int64(len(shared)), sharedDigest); err != nil {
		t.Fatal(err)
	}
	if _, err := execSchema(context.Background(), pool, schema, `UPDATE workspace_custom_emotes SET source_custom_emote_id = 'emote-root' WHERE id = 'emote-clone'`); err != nil {
		t.Fatal(err)
	}
}

func execSchema(ctx context.Context, pool *pgxpool.Pool, schema, query string, args ...any) (pgconn.CommandTag, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SET LOCAL search_path TO `+quotePGIdentifier(schema)); err != nil {
		return pgconn.CommandTag{}, err
	}
	command, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return command, err
	}
	if err := tx.Commit(ctx); err != nil {
		return command, err
	}
	return command, nil
}

func querySchema(ctx context.Context, pool *pgxpool.Pool, schema, query string, destinations ...any) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SET LOCAL search_path TO `+quotePGIdentifier(schema)); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, query).Scan(destinations...); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func dropStorageOpsSchema(t *testing.T, pool *pgxpool.Pool, schema string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+quotePGIdentifier(schema)+` CASCADE`); err != nil {
		t.Logf("drop integration schema: %v", err)
	}
}

func migration032Path() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "web", "server", "migrations", "032_workspace_storage_operator_runs.sql")
}
