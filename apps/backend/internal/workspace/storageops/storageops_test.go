package storageops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

var fixedNow = time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)

func TestBuildPlanIsDeterministicAndReadOnly(t *testing.T) {
	manifest := testManifest([]byte("operator bytes"))
	first, err := BuildPlan(manifest, PlanOptions{Operation: "verify", Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	shuffled := manifest
	shuffled.Schema.Expected = []string{"025_workspace_content_addressed_storage.sql", "001_initial.sql"}
	shuffled.Schema.Applied = []string{"025_workspace_content_addressed_storage.sql", "001_initial.sql"}
	second, err := BuildPlan(shuffled, PlanOptions{Operation: "verify", Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "ready" || !first.Validation.ReadOnlyReady || first.Validation.MutationReady {
		t.Fatalf("plan gates = %#v", first)
	}
	if first.ManifestFingerprint != second.ManifestFingerprint {
		t.Fatalf("fingerprint changed with ordering: %q != %q", first.ManifestFingerprint, second.ManifestFingerprint)
	}
	if len(first.Actions) != 1 || first.Actions[0].Action != "verify_canonical" {
		t.Fatalf("plan actions = %#v", first.Actions)
	}
}

func TestReadOnlyPlanDoesNotRequireMutationBackupProof(t *testing.T) {
	manifest := testManifest([]byte("operator bytes"))
	manifest.Backup = BackupProof{}
	report, err := BuildPlan(manifest, PlanOptions{Operation: "verify", Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "ready" || !report.Validation.ReadOnlyReady || report.Validation.MutationReady {
		t.Fatalf("backup-free read-only plan = %#v", report)
	}
	if !hasIssue(report.Validation.Warnings, "backup.proof_required_for_mutation") {
		t.Fatalf("backup-free plan did not preserve mutation warning: %#v", report.Validation.Warnings)
	}
}

func TestValidateManifestRejectsSchemaCASQuotaAndReferenceBreaks(t *testing.T) {
	manifest := testManifest([]byte("operator bytes"))
	manifest.Schema.Applied = []string{"001_initial.sql"}
	manifest.Objects[0].ObjectKey = "workspace/objects/sha256/00/wrong"
	manifest.Resources[0].ByteSize++
	manifest.Objects[0].ReferenceCount = 2
	manifest.Quotas[0].UsedBytes = 1
	manifest.Quotas[0].ReservedBytes = manifest.Quotas[0].LimitBytes
	report := ValidateManifest(manifest, fixedNow)
	if report.ReadOnlyReady {
		t.Fatal("broken manifest was accepted")
	}
	for _, code := range []string{
		"schema.025_missing",
		"cas.object_key_digest_mismatch",
		"refs.byte_size_mismatch",
		"refs.count_mismatch",
		"quota.over_limit",
	} {
		if !hasIssue(report.Issues, code) {
			t.Errorf("missing issue %q in %#v", code, report.Issues)
		}
	}
}

func TestVerifyReadsCanonicalBytesWithoutMutation(t *testing.T) {
	root := t.TempDir()
	local, err := storage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	manifest := testManifest([]byte("operator bytes"))
	digest := manifest.Objects[0].SHA256
	if _, err := local.Put(context.Background(), manifest.Objects[0].ObjectKey, strings.NewReader("operator bytes"), int64(len("operator bytes")), digest); err != nil {
		t.Fatal(err)
	}
	store := &countingStore{BlobStore: local}
	report, err := Verify(context.Background(), manifest, VerifyOptions{Store: store, Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "verified" || report.ObjectsScanned != 1 || report.ObjectsVerified != 1 || report.VerifiedBytes != int64(len("operator bytes")) {
		t.Fatalf("verification = %#v", report)
	}
	if store.puts != 0 || store.deletes != 0 || store.opens != 1 {
		t.Fatalf("storage calls put=%d delete=%d open=%d", store.puts, store.deletes, store.opens)
	}
}

func TestVerifyDetectsCorruptCanonicalBytesAndNeverDeletes(t *testing.T) {
	root := t.TempDir()
	local, err := storage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	manifest := testManifest([]byte("operator bytes"))
	object := manifest.Objects[0]
	if _, err := local.Put(context.Background(), object.ObjectKey, strings.NewReader("operator bytes"), object.ByteSize, object.SHA256); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(object.ObjectKey)), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &countingStore{BlobStore: local}
	report, err := Verify(context.Background(), manifest, VerifyOptions{Store: store, Now: fixedNow})
	if !errors.Is(err, ErrVerifyFailed) || report.Status != "failed" || report.Failures != 1 {
		t.Fatalf("corrupt verification = %#v, %v", report, err)
	}
	if store.deletes != 0 {
		t.Fatalf("verification deleted objects: %d", store.deletes)
	}
}

func TestVerifyRejectsInvalidManifestBeforeOpeningStore(t *testing.T) {
	manifest := testManifest([]byte("operator bytes"))
	manifest.Resources[0].StorageObjectID = "wso_unknown"
	store := &countingStore{}
	report, err := Verify(context.Background(), manifest, VerifyOptions{Store: store, Now: fixedNow})
	if !errors.Is(err, ErrInvalidManifest) || report.Status != "blocked" {
		t.Fatalf("invalid verification = %#v, %v", report, err)
	}
	if store.opens != 0 {
		t.Fatalf("invalid manifest opened storage %d times", store.opens)
	}
}

func TestDecodeManifestIsStrictAndBounded(t *testing.T) {
	if _, err := DecodeManifest(strings.NewReader(`{"contractVersion":1,"unknown":true}`)); !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("unknown field error = %v", err)
	}
	if _, err := DecodeManifest(strings.NewReader(`{"contractVersion":1} {}`)); !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("trailing value error = %v", err)
	}
	if _, err := DecodeManifest(strings.NewReader(strings.Repeat("x", int(MaxManifestBytes)+1))); !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("oversize error = %v", err)
	}
}

func TestManifestAssertionsCannotAuthorizeMutation(t *testing.T) {
	manifest := testManifest([]byte("operator bytes"))
	manifest.Owner.Fenced, manifest.Owner.AdmissionDrained = true, true
	report := ValidateManifest(manifest, fixedNow)
	if !report.ReadOnlyReady || report.MutationReady || !hasIssue(report.Warnings, "owner.runtime_fence_unverified") {
		t.Fatalf("untrusted manifest assertions became mutation proof: %#v", report)
	}
}

func TestVerifyCancellationStopsReadsAndClosesBody(t *testing.T) {
	for _, beforeOpen := range []bool{true, false} {
		ctx, cancel := context.WithCancel(context.Background())
		manifest := testManifest([]byte("operator bytes"))
		store := &cancelVerifyStore{cancel: cancel, content: "operator bytes"}
		if beforeOpen {
			cancel()
		}
		report, err := Verify(ctx, manifest, VerifyOptions{Store: store, Now: fixedNow})
		cancel()
		if !errors.Is(err, context.Canceled) || report.Status != "interrupted" || report.ObjectsVerified != 0 || report.Failures != 0 {
			t.Fatalf("cancel verification = %#v, %v", report, err)
		}
		if beforeOpen && store.opens != 0 {
			t.Fatal("canceled verification opened a store")
		}
		if !beforeOpen && (store.opens != 1 || !store.closed) {
			t.Fatal("unfinished object body was not closed")
		}
	}
}

type cancelVerifyStore struct {
	storage.BlobStore
	cancel  context.CancelFunc
	content string
	opens   int
	closed  bool
}

func (s *cancelVerifyStore) Open(_ context.Context, object storage.Object, _ int64) (storage.OpenedObject, error) {
	s.opens++
	return storage.OpenedObject{Object: object, Body: &cancelVerifyBody{store: s, reader: strings.NewReader(s.content)}}, nil
}

type cancelVerifyBody struct {
	store  *cancelVerifyStore
	reader io.Reader
}

func (b *cancelVerifyBody) Read(p []byte) (int, error) { b.store.cancel(); return b.reader.Read(p) }
func (b *cancelVerifyBody) Close() error               { b.store.closed = true; return nil }

type countingStore struct {
	storage.BlobStore
	opens   int
	puts    int
	deletes int
}

func (s *countingStore) Open(ctx context.Context, object storage.Object, maxBytes int64) (storage.OpenedObject, error) {
	s.opens++
	if s.BlobStore == nil {
		return storage.OpenedObject{}, errors.New("synthetic store unavailable")
	}
	return s.BlobStore.Open(ctx, object, maxBytes)
}

func (s *countingStore) Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (storage.StoredObject, error) {
	s.puts++
	return storage.StoredObject{}, errors.New("unexpected put")
}

func (s *countingStore) Delete(ctx context.Context, object storage.Object) error {
	s.deletes++
	return errors.New("unexpected delete")
}

func testManifest(content []byte) Manifest {
	digest := sha256.Sum256(content)
	sha := hex.EncodeToString(digest[:])
	key, _ := storage.CanonicalObjectKey(sha)
	return Manifest{
		ContractVersion: ContractVersion,
		RunID:           "storage-test-2026",
		Schema: SchemaSnapshot{
			Expected: []string{"001_initial.sql", CanonicalStorageMigration},
			Applied:  []string{"001_initial.sql", CanonicalStorageMigration},
		},
		Owner: OwnerSnapshot{Current: NodeOwner},
		Backup: BackupProof{
			ID:          "backup-test",
			SHA256:      strings.Repeat("b", 64),
			Verified:    true,
			RetainUntil: "2099-01-01T00:00:00Z",
		},
		Quotas:    []QuotaSnapshot{{SubjectID: "usr_test", Day: "2026-09-06", LimitBytes: storage.DefaultMaxObjectBytes, UsedBytes: 0, ReservedBytes: 0}},
		Resources: []ResourceRef{{Kind: "attachment", ID: "att_test", SpaceID: "spc_test", OwnerID: "usr_test", StorageObjectID: "wso_" + sha, ByteSize: int64(len(content))}},
		Objects:   []CanonicalObject{{ID: "wso_" + sha, SHA256: sha, ObjectKey: key, ByteSize: int64(len(content)), ReferenceCount: 1}},
	}
}

func hasIssue(issues []Issue, code string) bool {
	for _, issue := range issues {
		if issue.Code == code {
			return true
		}
	}
	return false
}
