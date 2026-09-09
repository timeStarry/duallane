package storageops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

const (
	BackfillOperation  = "backfill"
	BackfillPhaseRoot  = "root"
	BackfillPhaseClone = "clone"

	BackfillItemPending   = "pending"
	BackfillItemCompleted = "completed"
	BackfillItemFailed    = "failed"

	BackfillActionCreated = "created"
	BackfillActionReused  = "reused"
	BackfillActionClone   = "bound_clone"

	maxCloneChainLength = 1024
)

// MutationAcquireRequest is the only information a backfill needs from the
// owner coordinator. The coordinator, rather than this package, decides
// whether Node admission has drained and whether the fence is trusted.
type MutationAcquireRequest struct {
	RunID               string
	Operation           string
	ManifestFingerprint string
}

// MutationLease contains an opaque owner token. The token is never persisted
// or included in an operator error; only its SHA-256 digest is journaled.
type MutationLease struct {
	RunID string
	Token string
}

// MutationGuard is injected by the caller that owns the production fence.
// Backfill refuses to mutate without a guard and asserts it at every bounded
// page/item boundary.
type MutationGuard interface {
	Acquire(context.Context, MutationAcquireRequest) (MutationLease, error)
	Assert(context.Context, MutationLease) error
	Release(context.Context, MutationLease) error
}

// BackfillRunRequest identifies a resumable backfill. FenceTokenHash must be
// produced from the opaque lease token by FenceTokenHash; callers must not
// pass a raw owner token to the journal.
type BackfillRunRequest struct {
	RunID               string
	ManifestFingerprint string
	FenceTokenHash      string
}

// BackfillCursor is the stable keyset checkpoint. An empty cursor means the
// beginning of a phase; ordering is always (kind, resource_id).
type BackfillCursor struct {
	Kind       string
	ResourceID string
}

func (c BackfillCursor) Empty() bool {
	return strings.TrimSpace(c.Kind) == "" && strings.TrimSpace(c.ResourceID) == ""
}

// BackfillRun is the journal state visible to the bounded orchestrator.
type BackfillRun struct {
	ID        string
	Operation string
	State     string
	// FenceTokenHash is the opaque owner-fence identity currently authorized
	// for this run. It is safe to return because it is a digest, never a token.
	FenceTokenHash string
	Phase          string
	Cursor         BackfillCursor
	Revision       int64
	TotalItems     int64
	ProcessedItems int64
	LastErrorCode  string
}

// BackfillItem is a content-addressing work item captured from the live
// legacy catalog. Nullable Node fields are represented explicitly: a nil
// ExpectedByteSize means the source row had no byte-size value.
type BackfillItem struct {
	RunID                   string
	Phase                   string
	Kind                    string
	ResourceID              string
	SpaceID                 string
	LegacyStorageKey        string
	ExistingStorageObjectID string
	SourceCustomEmoteID     string
	ContentType             string
	ExpectedSHA256          string
	ExpectedByteSize        *int64
	// FenceTokenHash is copied from the run when this item is paged. Bind
	// operations must reject an item captured under an older owner lease.
	FenceTokenHash string
	Status         string
	Revision       int64
}

// BackfillRecoveryRequest is an explicit crash/cancellation recovery
// handshake. The parent owner coordinator must first acquire and assert a new
// trusted lease, then provide both the observed old fence hash and the new
// hash. Recovery is a revision-checked fence rotation; it is not a force flag
// and does not allow an untrusted caller to take over a live run.
type BackfillRecoveryRequest struct {
	RunID                  string
	ManifestFingerprint    string
	PreviousFenceTokenHash string
	NewFenceTokenHash      string
	ExpectedRevision       int64
}

type BackfillPage struct {
	Items []BackfillItem
}

// BackfillObject is the identity sent to the journal after the object store
// has validated or written the digest-addressed bytes.
type BackfillObject struct {
	ID          string
	SHA256      string
	ObjectKey   string
	ByteSize    int64
	ContentType string
}

type BackfillResult struct {
	Object BackfillObject
	Action string
}

type BackfillSummary struct {
	RunID             string
	State             string
	TotalItems        int64
	ProcessedItems    int64
	Created           int64
	Reused            int64
	BoundClones       int64
	AttachmentItems   int64
	AvatarItems       int64
	CustomEmoteItems  int64
	LogicalBytes      int64
	UniqueBytes       int64
	DeduplicatedBytes int64
}

// BackfillStore deliberately exposes only the operations needed by the
// migration. It has no delete or multipart-maintenance method: legacy bytes
// and shared canonical objects are never removed by this slice.
type BackfillStore interface {
	Put(context.Context, string, io.Reader, int64, string) (storage.StoredObject, error)
	Open(context.Context, storage.Object, int64) (storage.OpenedObject, error)
	InspectLegacy(context.Context, BackfillItem) (LegacyInspection, error)
	OpenLegacy(context.Context, BackfillItem) (storage.OpenedObject, error)
}

type LegacyInspection struct {
	SHA256   string
	ByteSize int64
}

// BackfillJournal owns the mutation boundary. Implementations must make each
// object acquire/bind transaction atomic and must use CAS on the run/item
// revisions. No method is an authorization or owner-fence substitute.
type BackfillJournal interface {
	BeginOrResume(context.Context, BackfillRunRequest) (BackfillRun, error)
	RecoverRunning(context.Context, BackfillRecoveryRequest) (BackfillRun, error)
	ListPage(context.Context, string, string, BackfillCursor, int) (BackfillPage, error)
	EnsureCloneItems(context.Context, BackfillRun, time.Time) (BackfillRun, error)
	LoadObject(context.Context, string) (CanonicalObject, error)
	AcquireAndBind(context.Context, BackfillItem, BackfillObject, time.Time) (BackfillResult, error)
	BindClone(context.Context, BackfillItem, time.Time) (BackfillResult, error)
	MarkItemCompleted(context.Context, BackfillItem, BackfillResult, time.Time) error
	MarkItemFailed(context.Context, BackfillItem, string, time.Time) error
	Advance(context.Context, BackfillRun, BackfillCursor, int64, time.Time) (BackfillRun, error)
	Complete(context.Context, BackfillRun, time.Time) (BackfillRun, error)
	Fail(context.Context, BackfillRun, string, time.Time) (BackfillRun, error)
	Summary(context.Context, string) (BackfillSummary, error)
}

// FenceTokenHash is intentionally small and deterministic so parent-owned
// coordinators can use the same journal representation without sharing raw
// credentials or owner tokens with PostgreSQL.
func FenceTokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func validateLease(lease MutationLease, runID string) error {
	if strings.TrimSpace(lease.RunID) == "" || strings.TrimSpace(lease.Token) == "" {
		return &BackfillError{Code: "storageops.mutation_lease_invalid"}
	}
	if strings.TrimSpace(runID) != lease.RunID {
		return &BackfillError{Code: "storageops.mutation_lease_run_mismatch"}
	}
	return nil
}

type BackfillError struct {
	Code  string
	Cause error
}

func (e *BackfillError) Error() string {
	if e == nil || strings.TrimSpace(e.Code) == "" {
		return "storageops.backfill_failed"
	}
	return e.Code
}

func (e *BackfillError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func backfillError(code string, cause error) error {
	return &BackfillError{Code: code, Cause: cause}
}

func BackfillErrorCode(err error) string {
	var typed *BackfillError
	if errors.As(err, &typed) && typed != nil {
		return typed.Code
	}
	if err == nil {
		return ""
	}
	return "storageops.backfill_failed"
}
