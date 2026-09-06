package avatars

import (
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/media"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID       = auth.DefaultSpaceID
	AvatarMaxInputBytes  = media.AvatarMaxInputBytes
	AvatarMaxInputPixels = media.MaxInputPixels
	AvatarMaxInputEdge   = media.AvatarMaxInputEdge
	AvatarMaxOutputBytes = media.MaxOutputBytes
	AvatarOutputSize     = media.DefaultTargetSize
	AvatarContentType    = "image/webp"
)

// StorageObjectRecord is the private registry projection for a content-
// addressed object. Its key and digest are never intended for public JSON.
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

// AvatarRecord is an internal projection used by the service and a future
// HTTP delivery adapter. Legacy StorageKey is retained for compatibility;
// new writes always bind StorageObject to the canonical object registry.
type AvatarRecord struct {
	UserID             string
	Version            string
	StorageKey         string
	StorageObjectID    string
	StorageObject      *StorageObjectRecord
	AvatarURL          string
	GitHubAvatarURL    string
	SearchDiscoverable bool
}

// SetOwnAvatarInput is intentionally byte-oriented. HTTP body and multipart
// parsing, including request length enforcement, belong to the transport.
type SetOwnAvatarInput struct {
	ActorID  string
	MIMEType string
	Content  []byte
	Meta     auth.RequestMeta
}

type RemoveOwnAvatarInput struct {
	ActorID string
	Meta    auth.RequestMeta
}

type GetProfileAvatarInput struct {
	ActorID string
	UserID  string
	Version string
}

type AvatarMutationResult struct {
	User                    *auth.Actor
	PreviousStorageKey      string
	PreviousStorageObjectID string
}

// ProcessedUpload is re-exported as a package-local domain convenience while
// preserving the single media projection shared by all Workspace image users.
type ProcessedUpload = media.ProcessedUpload

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

type StorageCleanup struct {
	Object       *StorageObjectRecord
	DeleteObject bool
	References   int64
	// Registered distinguishes a registry row from a compatibility fallback.
	// A missing row can still carry enough metadata to retry physical cleanup,
	// but it must not be tombstoned through the registry update.
	Registered bool
}
