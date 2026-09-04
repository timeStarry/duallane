package files

import (
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

const (
	DefaultSpaceID                  = "spc_default"
	DailyQuotaBytes           int64 = 2 * 1024 * 1024 * 1024
	UploadPartSize            int64 = 4 * 1024 * 1024
	UploadPartLimit                 = 10000
	DefaultListLimit                = 200
	MaximumListLimit                = 500
	DefaultStaleUploadAge           = 30 * time.Minute
	DefaultDownloadGrantTTL         = 5 * time.Minute
	MaximumDownloadGrantTTL         = 15 * time.Minute
	MaximumFileNameBytes            = 255
	MaximumMIMETypeBytes            = 255
	MaximumFailureReasonBytes       = 256
)

type AttachmentStatus string

const (
	AttachmentPending   AttachmentStatus = "pending"
	AttachmentAvailable AttachmentStatus = "available"
	AttachmentFailed    AttachmentStatus = "failed"
	AttachmentRemoved   AttachmentStatus = "removed"
)

type AttachmentVisibility string

const (
	VisibilityPrivateStaging AttachmentVisibility = "private_staging"
	VisibilityConversation   AttachmentVisibility = "conversation"
	VisibilitySpace          AttachmentVisibility = "space"
)

type TransferDirection string

const (
	TransferUpload   TransferDirection = "upload"
	TransferDownload TransferDirection = "download"
)

type TransferStatus string

const (
	TransferReserved  TransferStatus = "reserved"
	TransferCompleted TransferStatus = "completed"
	TransferReleased  TransferStatus = "released"
	TransferFailed    TransferStatus = "failed"
	TransferRejected  TransferStatus = "rejected"
)

// StorageObjectRecord is an internal registry projection. ObjectKey and
// SHA256 must never cross the HTTP/public attachment boundary.
type StorageObjectRecord struct {
	ID          string
	SHA256      string
	ObjectKey   string
	ByteSize    int64
	ContentType string
	CreatedAt   time.Time
	VerifiedAt  *time.Time
	DeletedAt   *time.Time
}

func (record StorageObjectRecord) BlobObject() storage.Object {
	return storage.Object{
		Key:         record.ObjectKey,
		SHA256:      record.SHA256,
		ByteSize:    record.ByteSize,
		ContentType: record.ContentType,
	}
}

// AttachmentRecord is the storage projection used by the service. It may
// contain legacy/internal keys and must not be serialized directly.
type AttachmentRecord struct {
	ID                string
	SpaceID           string
	UploaderID        string
	UploaderName      string
	ConversationTitle string
	ConversationID    *string
	Visibility        string
	Status            string
	FileName          string
	MIMEType          string
	ByteSize          int64
	StorageKey        string
	UploadTransferID  string
	StorageObjectID   string
	StorageObject     *StorageObjectRecord
	CreatedAt         time.Time
	CompletedAt       *time.Time
}

type AttachmentCapabilities struct {
	CanDownload bool `json:"canDownload"`
	CanRemove   bool `json:"canRemove"`
}

type PublicUploader struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

// Attachment is the compatibility-safe public projection. Internal storage
// keys, digests, transfer IDs, and ledger rows are intentionally absent.
type Attachment struct {
	ID             string                 `json:"id"`
	FileName       string                 `json:"fileName"`
	MIMEType       string                 `json:"mimeType"`
	ByteSize       int64                  `json:"byteSize"`
	Status         string                 `json:"status"`
	Visibility     string                 `json:"visibility"`
	UploaderID     string                 `json:"uploaderId"`
	UploaderName   string                 `json:"uploaderName"`
	Uploader       PublicUploader         `json:"uploader"`
	ConversationID *string                `json:"conversationId"`
	CreatedAt      string                 `json:"createdAt"`
	CompletedAt    *string                `json:"completedAt"`
	AvailableAt    *string                `json:"availableAt"`
	Capabilities   AttachmentCapabilities `json:"capabilities"`
}

type TransferRecord struct {
	ID             string
	SpaceID        string
	UserID         string
	Direction      string
	ByteSize       int64
	Status         string
	AttachmentID   *string
	CreatedAt      time.Time
	CompletedAt    *time.Time
	ReleasedAt     *time.Time
	LastActivityAt *time.Time
}

type UploadPartRecord struct {
	UploadID   string
	PartNumber int
	ByteSize   int64
	SHA256     string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type UploadPlan struct {
	ID        string `json:"id"`
	Mode      string `json:"mode"`
	PartSize  int64  `json:"partSize"`
	PartCount int    `json:"partCount"`
}

type QuotaSnapshot struct {
	UsedToday       int64 `json:"usedToday"`
	RemainingBytes  int64 `json:"remainingBytes"`
	DailyQuotaBytes int64 `json:"dailyQuotaBytes"`
}

type UploadResult struct {
	Status          string      `json:"status"`
	ID              string      `json:"id,omitempty"`
	UsedToday       int64       `json:"usedToday"`
	RemainingBytes  int64       `json:"remainingBytes"`
	DailyQuotaBytes int64       `json:"dailyQuotaBytes"`
	Attachment      *Attachment `json:"attachment,omitempty"`
	Upload          *UploadPlan `json:"upload,omitempty"`
}

type UploadStatus struct {
	UploadID  string             `json:"uploadId"`
	Mode      string             `json:"mode"`
	PartSize  int64              `json:"partSize"`
	PartCount int                `json:"partCount"`
	Parts     []UploadPartRecord `json:"parts"`
}

type UploadPartResult struct {
	PartNumber int    `json:"partNumber"`
	ByteSize   int64  `json:"byteSize"`
	SHA256     string `json:"sha256"`
	Reused     bool   `json:"reused"`
}

type DownloadResult struct {
	Status          string      `json:"status"`
	ID              string      `json:"id,omitempty"`
	UsedToday       int64       `json:"usedToday"`
	RemainingBytes  int64       `json:"remainingBytes"`
	DailyQuotaBytes int64       `json:"dailyQuotaBytes"`
	Attachment      *Attachment `json:"attachment,omitempty"`
}

type DownloadGrant struct {
	Transfer   TransferRecord
	Attachment AttachmentRecord
}

type FileListOptions struct {
	Scope          string
	ConversationID string
	UploaderID     string
	Query          string
	Q              string
	Limit          int
}

type EventInput struct {
	ID             string
	SpaceID        string
	Type           string
	ActorID        string
	ConversationID string
	TargetType     string
	TargetID       string
	PayloadJSON    []byte
	CreatedAt      time.Time
}

type AuditInput struct {
	ID               string
	SpaceID          string
	ActorUserID      string
	ActorGitHubLogin string
	Action           string
	TargetType       string
	TargetID         string
	Result           string
	Reason           string
	RequestID        string
	IPAddress        string
	UserAgent        string
	CreatedAt        time.Time
}

type StaleUploadRecord struct {
	Transfer   TransferRecord
	Attachment AttachmentRecord
}
