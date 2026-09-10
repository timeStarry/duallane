package emotes

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// ReadRepository is the narrow persistence seam for emote authorization and
// projections. It deliberately contains no general SQL escape hatch.
type ReadRepository interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	GetSettings(ctx context.Context, userID string) (SettingsRecord, error)
	ListCustomEmotes(ctx context.Context, userID string, includeRemoved bool) ([]CustomEmoteRecord, error)
	GetCustomEmote(ctx context.Context, emoteID string) (*CustomEmoteRecord, error)
	FindCustomEmoteByDigest(ctx context.Context, userID, digest string) (*CustomEmoteRecord, error)
	FindBuiltinEmote(ctx context.Context, userID, emoteKey string) (*CustomEmoteRecord, error)
	ListLibraryEntries(ctx context.Context, userID string) ([]LibraryEntryRecord, error)
	ListCollections(ctx context.Context, userID string) ([]CollectionRecord, error)
	GetCollection(ctx context.Context, userID, collectionID string) (*CollectionRecord, error)
	GetCollectionByID(ctx context.Context, collectionID string) (*CollectionRecord, error)
	ListCollectionItems(ctx context.Context, collectionID string) ([]CollectionItemRecord, error)
	MutableCollectionIDsForEmote(ctx context.Context, userID, emoteID string) ([]string, error)
	IsEmoteSubscriptionReadOnly(ctx context.Context, userID, emoteID string) (bool, error)
	IsEmoteLocallyPlaced(ctx context.Context, userID, emoteID string) (bool, error)
	GetCollectionSubscription(ctx context.Context, collectionID string) (*CollectionSubscriptionRecord, error)
	GetCollectionSubscriptionByID(ctx context.Context, subscriptionID string) (*CollectionSubscriptionRecord, error)
	ListSubscriptionItems(ctx context.Context, subscriptionID string) ([]CollectionSubscriptionItemRecord, error)
	GetShare(ctx context.Context, shareID string) (*ShareRecord, error)
	ListShareItems(ctx context.Context, shareID string) ([]ShareItemRecord, error)
	EmoteVisibleTo(ctx context.Context, spaceID, actorID, emoteID string) (bool, error)
	EmoteUsage(ctx context.Context, userID string, ignoredSubscriptionID string) (EmoteUsage, error)
	GetStorageObject(ctx context.Context, objectID string, includeDeleted bool) (*StorageObjectRecord, error)
	StorageObjectReferenceCount(ctx context.Context, objectID string) (int64, error)
}

type Repository interface {
	ReadRepository
	WithTx(ctx context.Context, callback func(Tx) error) error
}

// SettingsRecord is kept separate from EmoteSettings because stored pack IDs
// are untrusted JSON and booleans are nullable during rolling migrations.
type SettingsRecord struct {
	EnabledPackIDsJSON       string
	ClickImageEmoteToSend    bool
	ReplyAutoMention         bool
	AutoHideMessages         bool
	AutoHideMessageTypesJSON string
}

type CollectionItemRecord struct {
	CollectionID string
	EmoteID      string
	SortOrder    int64
	AddedAt      time.Time
}

type ShareItemRecord struct {
	ShareID   string
	EmoteID   string
	SortOrder int64
}

// StorageCleanup describes a registry row that is safe to mark deleted after
// its final logical reference has been removed. The physical delete is done
// by the service while holding the same transaction advisory lock.
type StorageCleanup struct {
	Object     *StorageObjectRecord
	Deleted    bool
	References int64
}

type Tx interface {
	ReadRepository
	Lock(ctx context.Context, key string) error
	UpsertSettings(ctx context.Context, userID, enabledPackIDsJSON string, clickImageEmoteToSend, replyAutoMention, autoHideMessages bool, autoHideMessageTypesJSON string, at time.Time) error
	AcquireStorageObject(ctx context.Context, record StorageObjectRecord) (*StorageObjectRecord, error)
	BindStorageObject(ctx context.Context, emoteID, storageObjectID string) error
	InsertCustomEmote(ctx context.Context, record CustomEmoteRecord) (bool, error)
	RestoreCustomEmote(ctx context.Context, userID, emoteID string, at time.Time) (bool, error)
	EnsureLibraryEntry(ctx context.Context, entry LibraryEntryRecord) (bool, error)
	DeleteLibraryEntry(ctx context.Context, userID, emoteID, collectionID string) (bool, error)
	DeleteCollectionEmoteLinks(ctx context.Context, userID, emoteID string) error
	MarkCustomEmoteRemoved(ctx context.Context, userID, emoteID string, at time.Time) (bool, error)
	UpdateCustomEmoteLabel(ctx context.Context, userID, emoteID, label string) (bool, error)
	DeleteUnreferencedEmote(ctx context.Context, emoteID string) (*CustomEmoteRecord, bool, error)
	InsertCollection(ctx context.Context, record CollectionRecord) error
	ListSubscriptionsBySource(ctx context.Context, sourceCollectionID, status string) ([]CollectionSubscriptionRecord, error)
	UpsertCollectionSubscription(ctx context.Context, record CollectionSubscriptionRecord) (bool, error)
	UpdateCollectionSubscription(ctx context.Context, subscriptionID, status string, sourceRevision int64, lastSyncedAt, detachedAt *time.Time, at time.Time) (bool, error)
	DeleteCollectionItems(ctx context.Context, collectionID string) error
	DeleteSubscriptionItems(ctx context.Context, subscriptionID string) error
	InsertSubscriptionItem(ctx context.Context, item CollectionSubscriptionItemRecord) error
	UpdateCollectionFromSource(ctx context.Context, userID, collectionID, name, sourceCollectionID, originalCreatorID string, at time.Time) (bool, error)
	UpdateCollectionName(ctx context.Context, userID, collectionID, name string, at time.Time) (bool, error)
	DeleteCollection(ctx context.Context, userID, collectionID string) (bool, error)
	InsertCollectionItem(ctx context.Context, item CollectionItemRecord) (bool, error)
	DeleteCollectionItem(ctx context.Context, collectionID, emoteID string) (bool, error)
	UpdateCollectionRevision(ctx context.Context, userID, collectionID string, at time.Time) (bool, error)
	ReorderLibraryEntry(ctx context.Context, userID, entryID string, sortOrder int64) error
	ReorderCollectionItem(ctx context.Context, collectionID, emoteID string, sortOrder int64) error
	FindActiveShareByFingerprint(ctx context.Context, collectionID, userID, fingerprint string) (*ShareRecord, error)
	InsertShare(ctx context.Context, record ShareRecord) error
	InsertShareItem(ctx context.Context, item ShareItemRecord) error
	RevokeShare(ctx context.Context, userID, shareID string, at time.Time) (bool, error)
	DeleteShareItems(ctx context.Context, shareID string) error
	MarkStorageObjectDeleted(ctx context.Context, objectID string, at time.Time) (bool, error)
	WriteAudit(ctx context.Context, input AuditInput) error
	WriteEvent(ctx context.Context, input EventInput) error
}

var _ Repository = (*PGRepository)(nil)
