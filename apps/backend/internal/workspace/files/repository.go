package files

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type AttachmentListQuery struct {
	SpaceID        string
	ViewerID       string
	Scope          string
	ConversationID string
	UploaderID     string
	Query          string
	Limit          int
}

// ReadRepository is the narrow persistence seam for file authorization,
// metadata, quota, transfer, and object-reference reads. Resource checks are
// repeated by the service inside mutation transactions.
type ReadRepository interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	GetAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error)
	ListAttachments(ctx context.Context, query AttachmentListQuery) ([]AttachmentRecord, error)
	GetTransfer(ctx context.Context, spaceID, userID, transferID string, direction TransferDirection) (*TransferRecord, error)
	ListUploadParts(ctx context.Context, uploadID string) ([]UploadPartRecord, error)
	GetUploadPart(ctx context.Context, uploadID string, partNumber int) (*UploadPartRecord, error)
	UsedTransferBytes(ctx context.Context, spaceID, userID string, since time.Time) (int64, error)
	ListStaleUploads(ctx context.Context, spaceID string, before time.Time) ([]StaleUploadRecord, error)
	ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error)
	ParticipantOnlyConversation(ctx context.Context, spaceID, conversationID string) (bool, error)
	StorageObject(ctx context.Context, objectID string) (*StorageObjectRecord, error)
	StorageObjectReferenceCount(ctx context.Context, objectID string) (int64, error)
}

type Repository interface {
	ReadRepository
	WithTx(ctx context.Context, fn func(Tx) error) error
}

type StorageCleanup struct {
	Object       *StorageObjectRecord
	DeleteObject bool
	References   int64
}

type Tx interface {
	ReadRepository
	Lock(ctx context.Context, key string) error
	CreateTransfer(ctx context.Context, transfer TransferRecord) error
	CreateAttachment(ctx context.Context, attachment AttachmentRecord) error
	UpsertUploadPart(ctx context.Context, part UploadPartRecord) (bool, error)
	TouchUpload(ctx context.Context, uploadID string, at time.Time) error
	CompleteUpload(ctx context.Context, spaceID, userID, transferID, attachmentID string, completedAt time.Time) (bool, error)
	FailUpload(ctx context.Context, spaceID, userID, transferID, attachmentID, reason string, failedAt time.Time) (bool, error)
	ReleaseDownload(ctx context.Context, spaceID, userID, transferID string, releasedAt time.Time) (bool, error)
	EnsureStorageObjectAndBind(ctx context.Context, spaceID, attachmentID string, object StorageObjectRecord) (*StorageObjectRecord, bool, error)
	DetachAttachment(ctx context.Context, spaceID, attachmentID, actorID string, removedAt time.Time) (*StorageObjectRecord, bool, error)
	CleanupStorageObject(ctx context.Context, objectID string, fallback StorageObjectRecord, at time.Time) (StorageCleanup, error)
	WriteEvent(ctx context.Context, input EventInput) error
	WriteAudit(ctx context.Context, input AuditInput) error
}

var _ Repository = (*PGRepository)(nil)
