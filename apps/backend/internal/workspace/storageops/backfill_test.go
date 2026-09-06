package storageops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestRunBackfillRequiresOwnerGuardBeforeAnyMutation(t *testing.T) {
	failStore := &fakeBackfillStore{}
	journal := newFakeBackfillJournal()
	_, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             journal,
		Store:               failStore,
		RunID:               "backfill-test-guard",
		ManifestFingerprint: "manifest-test",
	})
	if BackfillErrorCode(err) != "storageops.mutation_guard_required" {
		t.Fatalf("error code = %q, want guard required", BackfillErrorCode(err))
	}
	if journal.beginCalls != 0 || failStore.puts != 0 {
		t.Fatalf("mutation happened without guard: begin=%d puts=%d", journal.beginCalls, failStore.puts)
	}
}

func TestRunBackfillReleasesLeaseWhenInitialAssertFails(t *testing.T) {
	journal := newFakeBackfillJournal()
	guard := &fakeMutationGuard{
		lease:     MutationLease{RunID: "backfill-test-assert", Token: "owner-token"},
		assertErr: errors.New("synthetic fence assertion failure"),
	}
	_, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             journal,
		Store:               newFakeBackfillStore(),
		Guard:               guard,
		RunID:               guard.lease.RunID,
		ManifestFingerprint: "manifest-test",
	})
	if BackfillErrorCode(err) != "storageops.mutation_assert_failed" {
		t.Fatalf("error code = %q, error = %v", BackfillErrorCode(err), err)
	}
	if guard.released != 1 || guard.releaseContextErr != nil {
		t.Fatalf("lease cleanup = released:%d context:%v", guard.released, guard.releaseContextErr)
	}
	if journal.beginCalls != 0 {
		t.Fatalf("journal mutated after initial assertion failure: %d", journal.beginCalls)
	}
}

func TestRunBackfillReleasesWithIndependentContextAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	guard := &fakeMutationGuard{lease: MutationLease{RunID: "backfill-test-cancel", Token: "owner-token"}}
	_, err := RunBackfill(ctx, BackfillOptions{
		Journal:             newFakeBackfillJournal(),
		Store:               newFakeBackfillStore(),
		Guard:               guard,
		RunID:               guard.lease.RunID,
		ManifestFingerprint: "manifest-test",
	})
	if BackfillErrorCode(err) != "storageops.mutation_assert_failed" {
		t.Fatalf("error code = %q, error = %v", BackfillErrorCode(err), err)
	}
	if guard.released != 1 || guard.releaseContextErr != nil || !guard.releaseContextHasDeadline || guard.releaseContextRemaining <= 0 {
		t.Fatalf("cancelled lease cleanup = released:%d context:%v deadline:%t remaining:%s", guard.released, guard.releaseContextErr, guard.releaseContextHasDeadline, guard.releaseContextRemaining)
	}
}

func TestRunBackfillCreatesFreshCleanupContextAfterLongRun(t *testing.T) {
	previousTimeout := mutationCleanupTimeout
	mutationCleanupTimeout = 20 * time.Millisecond
	t.Cleanup(func() { mutationCleanupTimeout = previousTimeout })

	guard := &fakeMutationGuard{
		lease:       MutationLease{RunID: "backfill-test-aged-cleanup", Token: "owner-token"},
		assertErr:   errors.New("synthetic fence assertion failure"),
		assertDelay: 50 * time.Millisecond,
	}
	_, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             newFakeBackfillJournal(),
		Store:               newFakeBackfillStore(),
		Guard:               guard,
		RunID:               guard.lease.RunID,
		ManifestFingerprint: "manifest-test",
	})
	if BackfillErrorCode(err) != "storageops.mutation_assert_failed" {
		t.Fatalf("error code = %q, error = %v", BackfillErrorCode(err), err)
	}
	if guard.released != 1 || guard.releaseContextErr != nil {
		t.Fatalf("aged lease cleanup = released:%d context:%v", guard.released, guard.releaseContextErr)
	}
	if !guard.releaseContextHasDeadline || guard.releaseContextRemaining <= mutationCleanupTimeout/2 {
		t.Fatalf("cleanup context was not fresh at release: deadline:%t remaining:%s", guard.releaseContextHasDeadline, guard.releaseContextRemaining)
	}
}

func TestRunBackfillMalformedLeaseStillAttemptsCleanup(t *testing.T) {
	guard := &fakeMutationGuard{lease: MutationLease{RunID: "backfill-test-malformed"}}
	_, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             newFakeBackfillJournal(),
		Store:               newFakeBackfillStore(),
		Guard:               guard,
		RunID:               guard.lease.RunID,
		ManifestFingerprint: "manifest-test",
	})
	if BackfillErrorCode(err) != "storageops.mutation_lease_invalid" {
		t.Fatalf("error code = %q, error = %v", BackfillErrorCode(err), err)
	}
	if guard.released != 1 || guard.releaseContextErr != nil {
		t.Fatalf("malformed lease cleanup = released:%d context:%v", guard.released, guard.releaseContextErr)
	}
}

func TestRunBackfillReportsReleaseFailureWithoutRawError(t *testing.T) {
	guard := &fakeMutationGuard{
		lease:      MutationLease{RunID: "backfill-test-release", Token: "owner-token"},
		releaseErr: errors.New("synthetic release detail that must not escape"),
	}
	_, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             newFakeBackfillJournal(),
		Store:               newFakeBackfillStore(),
		Guard:               guard,
		RunID:               guard.lease.RunID,
		ManifestFingerprint: "manifest-test",
	})
	if BackfillErrorCode(err) != "storageops.mutation_release_failed" {
		t.Fatalf("error code = %q, error = %v", BackfillErrorCode(err), err)
	}
	if strings.Contains(err.Error(), "synthetic release detail") {
		t.Fatalf("release detail escaped content-free error: %v", err)
	}
}

func TestRunBackfillProcessesRootsAndClonesWithoutDeletingLegacy(t *testing.T) {
	content := []byte("legacy-attachment")
	digest := sha256Hex(content)
	item := BackfillItem{
		RunID:            "backfill-test-happy",
		Phase:            BackfillPhaseRoot,
		Kind:             "attachment",
		ResourceID:       "att-1",
		SpaceID:          "space-1",
		LegacyStorageKey: "legacy/att-1",
		ContentType:      "text/plain",
		Revision:         1,
	}
	clone := BackfillItem{
		RunID:               item.RunID,
		Phase:               BackfillPhaseClone,
		Kind:                "customEmote",
		ResourceID:          "emote-clone",
		SourceCustomEmoteID: "emote-root",
		Revision:            1,
	}
	journal := newFakeBackfillJournal()
	journal.rootItems = []BackfillItem{item}
	journal.cloneItems = []BackfillItem{clone}
	store := newFakeBackfillStore()
	store.legacy[item.ResourceID] = content
	guard := &fakeMutationGuard{lease: MutationLease{RunID: item.RunID, Token: "owner-token"}}

	report, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             journal,
		Store:               store,
		Guard:               guard,
		RunID:               item.RunID,
		ManifestFingerprint: "manifest-test",
		PageSize:            1,
		Now:                 func() time.Time { return time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "completed" || report.Summary.ProcessedItems != 2 || report.Summary.BoundClones != 1 {
		t.Fatalf("report = %#v", report)
	}
	if store.puts != 1 || store.deletes != 0 {
		t.Fatalf("storage calls puts=%d deletes=%d", store.puts, store.deletes)
	}
	if !bytes.Equal(store.legacy[item.ResourceID], content) {
		t.Fatal("legacy bytes were changed")
	}
	if guard.released != 1 || journal.advanceCalls != 2 {
		t.Fatalf("guard/checkpoint calls release=%d advance=%d", guard.released, journal.advanceCalls)
	}

	journal.completedReplay = true
	replay, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             journal,
		Store:               store,
		Guard:               &fakeMutationGuard{lease: MutationLease{RunID: item.RunID, Token: "owner-token-2"}},
		RunID:               item.RunID,
		ManifestFingerprint: "manifest-test",
		PageSize:            1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if replay.Status != "completed" || store.puts != 1 {
		t.Fatalf("replay = %#v puts=%d", replay, store.puts)
	}
	if journal.beginCalls != 2 {
		t.Fatalf("begin calls = %d", journal.beginCalls)
	}
	_ = digest
}

func TestRunBackfillStopsWhenFenceIsLostBeforeNextItem(t *testing.T) {
	journal := newFakeBackfillJournal()
	journal.rootItems = []BackfillItem{
		{RunID: "backfill-test-fence", Phase: BackfillPhaseRoot, Kind: "attachment", ResourceID: "att-1", SpaceID: "space-1", LegacyStorageKey: "legacy/1", Revision: 1},
		{RunID: "backfill-test-fence", Phase: BackfillPhaseRoot, Kind: "attachment", ResourceID: "att-2", SpaceID: "space-1", LegacyStorageKey: "legacy/2", Revision: 1},
	}
	store := newFakeBackfillStore()
	store.legacy["att-1"] = []byte("one")
	store.legacy["att-2"] = []byte("two")
	guard := &fakeMutationGuard{lease: MutationLease{RunID: "backfill-test-fence", Token: "owner-token"}, failAssertAt: 5}
	_, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             journal,
		Store:               store,
		Guard:               guard,
		RunID:               "backfill-test-fence",
		ManifestFingerprint: "manifest-test",
		PageSize:            2,
	})
	if BackfillErrorCode(err) != "storageops.mutation_assert_failed" {
		t.Fatalf("error code = %q, error = %v", BackfillErrorCode(err), err)
	}
	if store.puts != 1 || journal.bindCalls != 0 || journal.failedCalls != 0 {
		t.Fatalf("fence loss allowed work after boundary: puts=%d binds=%d failed=%d", store.puts, journal.bindCalls, journal.failedCalls)
	}
	if guard.released != 1 {
		t.Fatalf("release calls = %d", guard.released)
	}
}

func TestProcessBackfillItemReadsExistingCanonicalToEOFBeforeBind(t *testing.T) {
	content := []byte("registered canonical bytes")
	digest := sha256Hex(content)
	registered := CanonicalObject{
		ID: "wso_" + digest, SHA256: digest,
		ObjectKey: "workspace/objects/sha256/" + digest[:2] + "/" + digest,
		ByteSize:  int64(len(content)),
	}
	journal := newFakeBackfillJournal()
	journal.loadedObject = &registered
	store := newFakeBackfillStore()
	store.canonical[registered.ObjectKey] = bytes.Repeat([]byte("x"), len(content))
	item := BackfillItem{
		RunID:                   "backfill-test-canonical-eof",
		Phase:                   BackfillPhaseRoot,
		Kind:                    "attachment",
		ResourceID:              "att-1",
		SpaceID:                 "space-1",
		LegacyStorageKey:        "legacy/att-1",
		ExistingStorageObjectID: registered.ID,
		ContentType:             "text/plain",
		Revision:                1,
	}
	guard := &fakeMutationGuard{lease: MutationLease{RunID: item.RunID, Token: "owner-token"}}
	_, err := processBackfillItem(context.Background(), store, journal, guard, guard.lease, item, time.Now().UTC())
	if BackfillErrorCode(err) != "storageops.canonical_digest_mismatch" {
		t.Fatalf("canonical verification code=%q err=%v", BackfillErrorCode(err), err)
	}
	if journal.bindCalls != 0 {
		t.Fatalf("tampered canonical object was bound: %d", journal.bindCalls)
	}
}

func TestCanonicalReadLimitIncludesSentinelAtMaximum(t *testing.T) {
	limit, err := canonicalReadLimit(storage.DefaultMaxObjectBytes)
	if err != nil {
		t.Fatal(err)
	}
	if limit != storage.DefaultMaxObjectBytes+1 {
		t.Fatalf("canonical read limit = %d, want %d", limit, storage.DefaultMaxObjectBytes+1)
	}
	for _, size := range []int64{-1, storage.DefaultMaxObjectBytes + 1} {
		if _, err := canonicalReadLimit(size); BackfillErrorCode(err) != "storageops.canonical_size_invalid" {
			t.Fatalf("size %d error code = %q, error = %v", size, BackfillErrorCode(err), err)
		}
	}
}

func TestRunBackfillMarksFailedItemAndPreservesErrorCode(t *testing.T) {
	journal := newFakeBackfillJournal()
	journal.rootItems = []BackfillItem{{
		RunID: "backfill-test-failure", Phase: BackfillPhaseRoot, Kind: "attachment", ResourceID: "att-1", SpaceID: "space-1", LegacyStorageKey: "legacy/1", Revision: 1,
	}}
	store := newFakeBackfillStore()
	store.inspectErr = errors.New("synthetic source failure")
	guard := &fakeMutationGuard{lease: MutationLease{RunID: "backfill-test-failure", Token: "owner-token"}}
	_, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             journal,
		Store:               store,
		Guard:               guard,
		RunID:               "backfill-test-failure",
		ManifestFingerprint: "manifest-test",
	})
	if BackfillErrorCode(err) != "storageops.legacy_inspect_failed" {
		t.Fatalf("error code = %q", BackfillErrorCode(err))
	}
	if journal.failedCalls != 1 || journal.failedItems[0].ResourceID != "att-1" || journal.failedCode != "storageops.legacy_inspect_failed" {
		t.Fatalf("failure journal = %#v code=%q", journal.failedItems, journal.failedCode)
	}
	if journal.run.State != "failed" {
		t.Fatalf("run state = %q", journal.run.State)
	}
}

func TestRunBackfillCloneErrorIsStableAndDoesNotWriteLegacy(t *testing.T) {
	journal := newFakeBackfillJournal()
	journal.cloneItems = []BackfillItem{{
		RunID: "backfill-test-cycle", Phase: BackfillPhaseClone, Kind: "customEmote", ResourceID: "emote-a", SourceCustomEmoteID: "emote-b", Revision: 1,
	}}
	journal.cloneErr = &BackfillError{Code: "storageops.clone_cycle"}
	store := newFakeBackfillStore()
	guard := &fakeMutationGuard{lease: MutationLease{RunID: "backfill-test-cycle", Token: "owner-token"}}
	_, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             journal,
		Store:               store,
		Guard:               guard,
		RunID:               "backfill-test-cycle",
		ManifestFingerprint: "manifest-test",
	})
	if BackfillErrorCode(err) != "storageops.clone_cycle" {
		t.Fatalf("error code = %q", BackfillErrorCode(err))
	}
	if store.puts != 0 || journal.failedCalls != 1 {
		t.Fatalf("clone cycle wrote data: puts=%d failed=%d", store.puts, journal.failedCalls)
	}
}

type fakeMutationGuard struct {
	lease                     MutationLease
	failAssertAt              int
	assertErr                 error
	assertDelay               time.Duration
	releaseErr                error
	asserts                   int
	released                  int
	releaseContextErr         error
	releaseContextHasDeadline bool
	releaseContextRemaining   time.Duration
}

func (g *fakeMutationGuard) Acquire(context.Context, MutationAcquireRequest) (MutationLease, error) {
	return g.lease, nil
}

func (g *fakeMutationGuard) Assert(ctx context.Context, _ MutationLease) error {
	g.asserts++
	if g.assertDelay > 0 {
		time.Sleep(g.assertDelay)
	}
	if g.assertErr != nil {
		return g.assertErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if g.failAssertAt > 0 && g.asserts >= g.failAssertAt {
		return errors.New("fence_lost")
	}
	return nil
}

func (g *fakeMutationGuard) Release(ctx context.Context, _ MutationLease) error {
	g.released++
	g.releaseContextErr = ctx.Err()
	deadline, ok := ctx.Deadline()
	g.releaseContextHasDeadline = ok
	if ok {
		g.releaseContextRemaining = time.Until(deadline)
	}
	return g.releaseErr
}

type fakeBackfillStore struct {
	legacy     map[string][]byte
	canonical  map[string][]byte
	puts       int
	deletes    int
	inspectErr error
}

func newFakeBackfillStore() *fakeBackfillStore {
	return &fakeBackfillStore{legacy: make(map[string][]byte), canonical: make(map[string][]byte)}
}

func (s *fakeBackfillStore) Put(_ context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (storage.StoredObject, error) {
	content, err := io.ReadAll(source)
	if err != nil {
		return storage.StoredObject{}, err
	}
	if int64(len(content)) != expectedSize || sha256Hex(content) != expectedSHA256 {
		return storage.StoredObject{}, errors.New("synthetic put identity mismatch")
	}
	s.puts++
	if existing, ok := s.canonical[key]; ok {
		if !bytes.Equal(existing, content) {
			return storage.StoredObject{}, errors.New("synthetic canonical conflict")
		}
		return storage.StoredObject{Object: storage.Object{Key: key, SHA256: expectedSHA256, ByteSize: expectedSize}, Reused: true}, nil
	}
	s.canonical[key] = append([]byte(nil), content...)
	return storage.StoredObject{Object: storage.Object{Key: key, SHA256: expectedSHA256, ByteSize: expectedSize}}, nil
}

func (s *fakeBackfillStore) Open(_ context.Context, object storage.Object, _ int64) (storage.OpenedObject, error) {
	content, ok := s.canonical[object.Key]
	if !ok {
		return storage.OpenedObject{}, &storage.Error{Code: "file.storage_missing"}
	}
	return storage.OpenedObject{Object: object, Body: io.NopCloser(bytes.NewReader(content))}, nil
}

func (s *fakeBackfillStore) InspectLegacy(_ context.Context, item BackfillItem) (LegacyInspection, error) {
	if s.inspectErr != nil {
		return LegacyInspection{}, s.inspectErr
	}
	content, ok := s.legacy[item.ResourceID]
	if !ok {
		return LegacyInspection{}, errors.New("synthetic legacy missing")
	}
	return LegacyInspection{SHA256: sha256Hex(content), ByteSize: int64(len(content))}, nil
}

func (s *fakeBackfillStore) OpenLegacy(_ context.Context, item BackfillItem) (storage.OpenedObject, error) {
	content, ok := s.legacy[item.ResourceID]
	if !ok {
		return storage.OpenedObject{}, errors.New("synthetic legacy missing")
	}
	return storage.OpenedObject{Body: io.NopCloser(bytes.NewReader(content))}, nil
}

func (s *fakeBackfillStore) Delete(context.Context, storage.Object) error {
	s.deletes++
	return nil
}

type fakeBackfillJournal struct {
	run             BackfillRun
	rootItems       []BackfillItem
	cloneItems      []BackfillItem
	rootOffset      int
	cloneOffset     int
	completedReplay bool
	cloneErr        error
	beginCalls      int
	advanceCalls    int
	bindCalls       int
	failedCalls     int
	failedItems     []BackfillItem
	failedCode      string
	loadedObject    *CanonicalObject
}

func newFakeBackfillJournal() *fakeBackfillJournal {
	return &fakeBackfillJournal{run: BackfillRun{ID: "unset", Operation: BackfillOperation, State: "running", Phase: BackfillPhaseRoot, Revision: 1}}
}

func (j *fakeBackfillJournal) BeginOrResume(_ context.Context, request BackfillRunRequest) (BackfillRun, error) {
	j.beginCalls++
	if j.completedReplay {
		j.run = BackfillRun{ID: request.RunID, Operation: BackfillOperation, State: "completed", Phase: BackfillPhaseClone, Revision: 4}
		return j.run, nil
	}
	j.run.ID, j.run.Operation = request.RunID, BackfillOperation
	j.rootOffset, j.cloneOffset = 0, 0
	if j.run.State == "" {
		j.run.State = "running"
	}
	if j.run.Phase == "" {
		j.run.Phase = BackfillPhaseRoot
	}
	return j.run, nil
}

func (j *fakeBackfillJournal) RecoverRunning(_ context.Context, request BackfillRecoveryRequest) (BackfillRun, error) {
	j.run.ID = request.RunID
	j.run.Operation = BackfillOperation
	j.run.State = "running"
	j.run.FenceTokenHash = request.NewFenceTokenHash
	j.run.Revision++
	return j.run, nil
}

func (j *fakeBackfillJournal) ListPage(_ context.Context, runID, phase string, _ BackfillCursor, limit int) (BackfillPage, error) {
	items := j.rootItems
	offset := j.rootOffset
	if phase == BackfillPhaseClone {
		items = j.cloneItems
		offset = j.cloneOffset
	}
	if offset >= len(items) {
		return BackfillPage{}, nil
	}
	items = items[offset:]
	if len(items) > limit {
		items = items[:limit]
	}
	for _, item := range items {
		item.RunID = runID
	}
	return BackfillPage{Items: append([]BackfillItem(nil), items...)}, nil
}

func (j *fakeBackfillJournal) EnsureCloneItems(_ context.Context, run BackfillRun, _ time.Time) (BackfillRun, error) {
	run.Phase = BackfillPhaseClone
	run.Revision++
	j.run = run
	return run, nil
}

func (j *fakeBackfillJournal) LoadObject(context.Context, string) (CanonicalObject, error) {
	if j.loadedObject != nil {
		return *j.loadedObject, nil
	}
	return CanonicalObject{}, errors.New("synthetic object missing")
}

func (j *fakeBackfillJournal) AcquireAndBind(_ context.Context, item BackfillItem, object BackfillObject, _ time.Time) (BackfillResult, error) {
	j.bindCalls++
	return BackfillResult{Object: object, Action: BackfillActionCreated}, nil
}

func (j *fakeBackfillJournal) BindClone(_ context.Context, item BackfillItem, _ time.Time) (BackfillResult, error) {
	j.bindCalls++
	if j.cloneErr != nil {
		return BackfillResult{}, j.cloneErr
	}
	return BackfillResult{Object: BackfillObject{ID: "wso_clone", SHA256: strings.Repeat("a", 64), ObjectKey: "workspace/objects/sha256/aa/" + strings.Repeat("a", 64), ByteSize: 1}, Action: BackfillActionClone}, nil
}

func (j *fakeBackfillJournal) MarkItemCompleted(_ context.Context, _ BackfillItem, _ BackfillResult, _ time.Time) error {
	return nil
}

func (j *fakeBackfillJournal) MarkItemFailed(_ context.Context, item BackfillItem, code string, _ time.Time) error {
	j.failedCalls++
	j.failedItems = append(j.failedItems, item)
	j.failedCode = code
	return nil
}

func (j *fakeBackfillJournal) Advance(_ context.Context, run BackfillRun, _ BackfillCursor, processed int64, _ time.Time) (BackfillRun, error) {
	j.advanceCalls++
	if run.Phase == BackfillPhaseClone {
		j.cloneOffset += int(processed)
	} else {
		j.rootOffset += int(processed)
	}
	run.Revision++
	j.run = run
	return run, nil
}

func (j *fakeBackfillJournal) Complete(_ context.Context, run BackfillRun, _ time.Time) (BackfillRun, error) {
	run.State = "completed"
	run.Revision++
	j.run = run
	return run, nil
}

func (j *fakeBackfillJournal) Fail(_ context.Context, run BackfillRun, code string, _ time.Time) (BackfillRun, error) {
	run.State = "failed"
	run.LastErrorCode = code
	run.Revision++
	j.run = run
	return run, nil
}

func (j *fakeBackfillJournal) Summary(_ context.Context, runID string) (BackfillSummary, error) {
	state := j.run.State
	if state == "" {
		state = "running"
	}
	processed := int64(0)
	if state == "completed" {
		processed = int64(len(j.rootItems) + len(j.cloneItems))
	}
	return BackfillSummary{RunID: runID, State: state, TotalItems: processed, ProcessedItems: processed, BoundClones: int64(len(j.cloneItems))}, nil
}

func sha256Hex(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}
