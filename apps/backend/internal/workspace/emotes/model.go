package emotes

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID               = auth.DefaultSpaceID
	MaxInputBytes          int64 = 10 * 1024 * 1024
	MaxOutputBytes         int64 = 2 * 1024 * 1024
	MaxTotalBytes          int64 = 1024 * 1024 * 1024
	MaxCollectionItems           = 100
	MaxBatchItems                = 50
	MaxDimension                 = 4096
	MaxPixels              int64 = 40 * 1024 * 1024
	MaxFrames                    = 180
	MaxDurationMillis      int64 = 30 * 1000
	MaxLabelRunes                = 16
	MaxCollectionNameRunes       = 32
	MaxFileNameBytes             = 255
)

var supportedMIMETypes = map[string]struct{}{
	"image/jpeg": {},
	"image/png":  {},
	"image/webp": {},
	"image/gif":  {},
	"image/bmp":  {},
}

// CatalogItem is the source representation used by the imported built-in
// catalog. Unknown JSON fields are intentionally ignored so catalog additions
// remain backward-compatible with the Go service.
type CatalogItem struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Label string `json:"label"`
	Value string `json:"value,omitempty"`
	Token string `json:"token,omitempty"`
	Src   string `json:"src,omitempty"`
}

type CatalogPack struct {
	ID             string        `json:"id"`
	Label          string        `json:"label"`
	DefaultEnabled *bool         `json:"defaultEnabled,omitempty"`
	Items          []CatalogItem `json:"items"`
}

type PublicCatalogPack struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	DefaultEnabled bool   `json:"defaultEnabled"`
}

type PublicCatalogEmote struct {
	EmoteKey string `json:"emoteKey"`
	Kind     string `json:"kind"`
	Label    string `json:"label"`
	Value    string `json:"value,omitempty"`
	Src      string `json:"src,omitempty"`
}

// CustomEmoteRecord contains the storage projection. It is never serialized
// directly because StorageKey, SHA256, and storage-object IDs are private.
type CustomEmoteRecord struct {
	ID                  string
	UserID              string
	SourceType          string
	SourceAttachmentID  string
	SourceCustomEmoteID string
	SourceEmoteKey      string
	OriginalFileName    string
	OriginalMIMEType    string
	Label               string
	NormalizedMIMEType  string
	ByteSize            *int64
	Width               *int
	Height              *int
	FrameCount          *int
	DurationMS          *int64
	SHA256              string
	StorageKey          string
	StorageObjectID     string
	SortOrder           int64
	CreatedAt           time.Time
	RemovedAt           *time.Time
}

// CustomEmote is the Node-compatible public projection. Internal storage
// identity is deliberately absent.
type CustomEmote struct {
	ID               string `json:"id"`
	Kind             string `json:"kind"`
	Label            string `json:"label"`
	Token            string `json:"token"`
	Src              string `json:"src,omitempty"`
	EmoteKey         string `json:"emoteKey,omitempty"`
	Animated         bool   `json:"animated"`
	ByteSize         *int64 `json:"byteSize,omitempty"`
	Width            *int   `json:"width,omitempty"`
	Height           *int   `json:"height,omitempty"`
	SourceType       string `json:"sourceType,omitempty"`
	OriginalFileName string `json:"originalFileName,omitempty"`
	OriginalMIMEType string `json:"originalMimeType,omitempty"`
	CreatedAt        string `json:"createdAt"`
}

type EmoteUsage struct {
	ItemCount                 int64 `json:"itemCount"`
	TotalBytes                int64 `json:"totalBytes"`
	SubscribedItemCount       int64 `json:"subscribedItemCount"`
	SubscribedTotalBytes      int64 `json:"subscribedTotalBytes"`
	TotalItemCount            int64 `json:"totalItemCount"`
	AllTotalBytes             int64 `json:"allTotalBytes"`
	CollectionCount           int64 `json:"collectionCount"`
	SubscribedCollectionCount int64 `json:"subscribedCollectionCount"`
	OverLimit                 bool  `json:"overLimit"`
}

type EmoteLimits struct {
	MaxItems           *int64 `json:"maxItems"`
	MaxTotalBytes      int64  `json:"maxTotalBytes"`
	MaxInputBytes      int64  `json:"maxInputBytes"`
	MaxCollections     *int64 `json:"maxCollections"`
	MaxCollectionItems int64  `json:"maxCollectionItems"`
	MaxBatchItems      int64  `json:"maxBatchItems"`
}

type EmoteSettings struct {
	AvailablePacks        []PublicCatalogPack `json:"availablePacks"`
	EnabledPackIDs        []string            `json:"enabledPackIds"`
	ClickImageEmoteToSend bool                `json:"clickImageEmoteToSend"`
	ReplyAutoMention      bool                `json:"replyAutoMention"`
	MinimumEnabled        int                 `json:"minimumEnabled"`
}

type UpdateSettingsInput struct {
	EnabledPackIDs        *[]string
	ClickImageEmoteToSend *bool
	ReplyAutoMention      *bool
}

type LibraryEntryRecord struct {
	ID           string
	UserID       string
	EntryType    string
	EmoteID      string
	CollectionID string
	SortOrder    int64
	CreatedAt    time.Time
}

type PublicLibraryEntry struct {
	ID         string       `json:"id"`
	Type       string       `json:"type"`
	Emote      *CustomEmote `json:"emote,omitempty"`
	Collection *Collection  `json:"collection,omitempty"`
}

type PublicLibrary struct {
	Entries     []PublicLibraryEntry `json:"entries"`
	Emotes      []CustomEmote        `json:"emotes"`
	Collections []Collection         `json:"collections"`
	Usage       EmoteUsage           `json:"usage"`
	Limits      EmoteLimits          `json:"limits"`
}

type CollectionSubscription struct {
	Eligible           bool    `json:"eligible"`
	Enabled            bool    `json:"enabled"`
	Status             string  `json:"status"`
	SourceCollectionID *string `json:"sourceCollectionId"`
	SourceRevision     *int64  `json:"sourceRevision"`
	LastSyncedAt       *string `json:"lastSyncedAt"`
	ReadOnly           bool    `json:"readOnly"`
}

type CollectionRecord struct {
	ID                         string
	UserID                     string
	Name                       string
	SourceCollectionID         string
	OriginalCreatorID          string
	OriginalCreatorName        string
	Revision                   int64
	CreatedAt                  time.Time
	UpdatedAt                  time.Time
	SubscriptionStatus         string
	SubscriptionSourceRevision *int64
	SubscriptionLastSyncedAt   *time.Time
}

type PublicPerson struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

type Collection struct {
	ID                 string                 `json:"id"`
	Name               string                 `json:"name"`
	SourceCollectionID *string                `json:"sourceCollectionId"`
	OriginalCreatorID  string                 `json:"originalCreatorUserId"`
	OriginalCreator    PublicPerson           `json:"originalCreator"`
	Revision           int64                  `json:"revision"`
	CreatedAt          string                 `json:"createdAt"`
	UpdatedAt          string                 `json:"updatedAt"`
	SourceSubscription CollectionSubscription `json:"sourceSubscription"`
	Items              []CustomEmote          `json:"items"`
	ItemCount          int                    `json:"itemCount"`
}

type ShareRecord struct {
	ID                  string
	SourceCollectionID  string
	SharedByID          string
	SharedByName        string
	OriginalCreatorID   string
	OriginalCreatorName string
	Name                string
	Fingerprint         string
	ItemCount           int
	CreatedAt           time.Time
	RevokedAt           *time.Time
}

type Share struct {
	ID                          string        `json:"id"`
	SourceCollectionID          string        `json:"sourceCollectionId"`
	Name                        string        `json:"name"`
	ItemCount                   int           `json:"itemCount"`
	CreatedAt                   string        `json:"createdAt"`
	RevokedAt                   *string       `json:"revokedAt"`
	SharedBy                    PublicPerson  `json:"sharedBy"`
	OriginalCreator             PublicPerson  `json:"originalCreator"`
	CanSubscribeToSourceChanges bool          `json:"canSubscribeToSourceChanges"`
	CanRevoke                   bool          `json:"canRevoke"`
	Items                       []CustomEmote `json:"items"`
	SharePath                   string        `json:"sharePath"`
}

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

func (record StorageObjectRecord) BlobObject() platformstorage.Object {
	return platformstorage.Object{
		Key: record.ObjectKey, SHA256: record.SHA256, ByteSize: record.ByteSize, ContentType: record.ContentType,
	}
}

type UploadSource struct {
	Type          string
	AttachmentID  string
	CustomEmoteID string
	FileName      string
	MIMEType      string
}

type UploadInput struct {
	ActorID      string
	Content      io.Reader
	Source       UploadSource
	CollectionID string
	AddToLibrary bool
	Meta         auth.RequestMeta
}

type PreflightResult struct {
	Source   UploadSource
	Content  []byte
	ByteSize int64
}

type ProcessedUpload struct {
	Content            []byte
	DetectedMIMEType   string
	NormalizedMIMEType string
	Label              string
	ByteSize           int64
	Width              int
	Height             int
	FrameCount         int
	DurationMS         int64
	SHA256             string
}

type StoreProcessedInput struct {
	ActorID      string
	Source       UploadSource
	Processed    ProcessedUpload
	CollectionID string
	AddToLibrary bool
	Meta         auth.RequestMeta
}

type CreateCollectionInput struct {
	ActorID  string
	Name     string
	EmoteIDs []string
	Meta     auth.RequestMeta
}

type UpdateCollectionInput struct {
	ActorID      string
	CollectionID string
	Name         string
	Meta         auth.RequestMeta
}

type DeleteCollectionInput struct {
	ActorID      string
	CollectionID string
	Disposition  string
	Meta         auth.RequestMeta
}

type CollectionItemsInput struct {
	ActorID      string
	CollectionID string
	EmoteIDs     []string
	Meta         auth.RequestMeta
}

type RemoveCollectionItemInput struct {
	ActorID      string
	CollectionID string
	EmoteID      string
	Meta         auth.RequestMeta
}

type ReorderInput struct {
	ActorID string
	IDs     []string
	Meta    auth.RequestMeta
}

type UpdateEmoteInput struct {
	ActorID string
	EmoteID string
	Label   string
	Meta    auth.RequestMeta
}

type ReadContentInput struct {
	ActorID  string
	EmoteID  string
	MaxBytes int64
	Meta     auth.RequestMeta
}

type CreateShareInput struct {
	ActorID      string
	CollectionID string
	Meta         auth.RequestMeta
}

type ShareInput struct {
	ActorID string
	ShareID string
	Meta    auth.RequestMeta
}

type ImportShareInput struct {
	ActorID                  string
	ShareID                  string
	EmoteIDs                 []string
	AsCollection             *bool
	SubscribeToSourceChanges bool
	CollectionName           string
	Meta                     auth.RequestMeta
}

type ImportShareResult struct {
	Collection *Collection    `json:"collection"`
	Items      []CustomEmote  `json:"items"`
	Library    *PublicLibrary `json:"library"`
}

type Delivery struct {
	Body        io.ReadCloser
	ContentType string
	ByteSize    int64
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

type EventInput struct {
	ID          string
	SpaceID     string
	Type        string
	ActorID     string
	TargetType  string
	TargetID    string
	PayloadJSON []byte
	CreatedAt   time.Time
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func nullableTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := formatTimestamp(*value)
	return &formatted
}

func (record CustomEmoteRecord) Public(catalog *Catalog) *CustomEmote {
	if record.SourceType == "builtin" {
		if catalog == nil {
			return nil
		}
		item, ok := catalog.Lookup(record.SourceEmoteKey)
		if !ok || item.Kind != "image" {
			return nil
		}
		return &CustomEmote{
			ID: record.ID, Kind: "builtin", Label: record.Label, Token: item.Token,
			Src: item.Src, EmoteKey: record.SourceEmoteKey, Animated: false,
			CreatedAt: formatTimestamp(record.CreatedAt),
		}
	}
	return &CustomEmote{
		ID: record.ID, Kind: "custom", Label: record.Label,
		Token:    "[custom:" + record.ID + "]",
		Src:      "/api/workspace/emotes/" + record.ID + "/content",
		Animated: record.FrameCount != nil && *record.FrameCount > 1,
		ByteSize: record.ByteSize, Width: record.Width, Height: record.Height,
		SourceType: record.SourceType, OriginalFileName: record.OriginalFileName,
		OriginalMIMEType: record.OriginalMIMEType, CreatedAt: formatTimestamp(record.CreatedAt),
	}
}

func (record CollectionRecord) Public(items []CustomEmote) Collection {
	if items == nil {
		items = []CustomEmote{}
	}
	var sourceID *string
	if record.SourceCollectionID != "" {
		sourceID = &record.SourceCollectionID
	}
	status := record.SubscriptionStatus
	if status == "" {
		status = "off"
	}
	enabled := status == "active"
	detached := status == "detached"
	publicStatus := "off"
	if enabled {
		publicStatus = "synced"
	} else if detached {
		publicStatus = "detached"
	}
	return Collection{
		ID: record.ID, Name: record.Name, SourceCollectionID: sourceID,
		OriginalCreatorID: record.OriginalCreatorID,
		OriginalCreator:   PublicPerson{ID: record.OriginalCreatorID, DisplayName: record.OriginalCreatorName},
		Revision:          record.Revision, CreatedAt: formatTimestamp(record.CreatedAt), UpdatedAt: formatTimestamp(record.UpdatedAt),
		SourceSubscription: CollectionSubscription{
			Eligible: !detached && sourceID != nil, Enabled: enabled, Status: publicStatus,
			SourceCollectionID: sourceID, SourceRevision: record.SubscriptionSourceRevision,
			LastSyncedAt: nullableTimestamp(record.SubscriptionLastSyncedAt), ReadOnly: enabled,
		},
		Items: items, ItemCount: len(items),
	}
}

func (record ShareRecord) Public(items []CustomEmote, canSubscribe, canRevoke bool) Share {
	if items == nil {
		items = []CustomEmote{}
	}
	var revokedAt *string
	if record.RevokedAt != nil {
		revokedAt = nullableTimestamp(record.RevokedAt)
	}
	return Share{
		ID: record.ID, SourceCollectionID: record.SourceCollectionID, Name: record.Name,
		ItemCount: record.ItemCount, CreatedAt: formatTimestamp(record.CreatedAt), RevokedAt: revokedAt,
		SharedBy:                    PublicPerson{ID: record.SharedByID, DisplayName: record.SharedByName},
		OriginalCreator:             PublicPerson{ID: record.OriginalCreatorID, DisplayName: record.OriginalCreatorName},
		CanSubscribeToSourceChanges: canSubscribe, CanRevoke: canRevoke, Items: items,
		SharePath: "/workspace/emotes/shared/" + record.ID,
	}
}

func defaultLimits() EmoteLimits {
	return EmoteLimits{MaxItems: nil, MaxTotalBytes: MaxTotalBytes, MaxInputBytes: MaxInputBytes, MaxCollections: nil, MaxCollectionItems: MaxCollectionItems, MaxBatchItems: MaxBatchItems}
}

func canonicalDigest(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

func canonicalJSON(value any) ([]byte, error) {
	return json.Marshal(value)
}
