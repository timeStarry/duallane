package emotes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type fakeState struct {
	actors            map[string]*auth.Actor
	settings          map[string]SettingsRecord
	emotes            map[string]CustomEmoteRecord
	objects           map[string]StorageObjectRecord
	entries           map[string]LibraryEntryRecord
	collections       map[string]CollectionRecord
	items             map[string][]CollectionItemRecord
	subscriptions     map[string]CollectionSubscriptionRecord
	subscriptionItems map[string][]CollectionSubscriptionItemRecord
	shares            map[string]ShareRecord
	shareItems        map[string][]ShareItemRecord
	audits            []AuditInput
	events            []EventInput
	nextSequence      int64
}

func newFakeState() fakeState {
	return fakeState{
		actors: make(map[string]*auth.Actor), settings: make(map[string]SettingsRecord),
		emotes: make(map[string]CustomEmoteRecord), objects: make(map[string]StorageObjectRecord),
		entries: make(map[string]LibraryEntryRecord), collections: make(map[string]CollectionRecord),
		items: make(map[string][]CollectionItemRecord), subscriptions: make(map[string]CollectionSubscriptionRecord),
		subscriptionItems: make(map[string][]CollectionSubscriptionItemRecord), shares: make(map[string]ShareRecord),
		shareItems: make(map[string][]ShareItemRecord), nextSequence: 1,
	}
}

func cloneFakeState(source fakeState) fakeState {
	target := newFakeState()
	for id, actor := range source.actors {
		copy := *actor
		target.actors[id] = &copy
	}
	for key, value := range source.settings {
		target.settings[key] = value
	}
	for key, value := range source.emotes {
		target.emotes[key] = cloneEmoteRecord(value)
	}
	for key, value := range source.objects {
		target.objects[key] = value
	}
	for key, value := range source.entries {
		target.entries[key] = value
	}
	for key, value := range source.collections {
		target.collections[key] = value
	}
	for key, value := range source.items {
		target.items[key] = append([]CollectionItemRecord(nil), value...)
	}
	for key, value := range source.subscriptions {
		target.subscriptions[key] = cloneSubscriptionRecord(value)
	}
	for key, value := range source.subscriptionItems {
		target.subscriptionItems[key] = append([]CollectionSubscriptionItemRecord(nil), value...)
	}
	for key, value := range source.shares {
		target.shares[key] = value
	}
	for key, value := range source.shareItems {
		target.shareItems[key] = append([]ShareItemRecord(nil), value...)
	}
	target.audits = append([]AuditInput(nil), source.audits...)
	target.events = append([]EventInput(nil), source.events...)
	target.nextSequence = source.nextSequence
	return target
}

func cloneSubscriptionRecord(source CollectionSubscriptionRecord) CollectionSubscriptionRecord {
	target := source
	if source.LastSyncedAt != nil {
		value := *source.LastSyncedAt
		target.LastSyncedAt = &value
	}
	if source.DetachedAt != nil {
		value := *source.DetachedAt
		target.DetachedAt = &value
	}
	return target
}

func cloneEmoteRecord(source CustomEmoteRecord) CustomEmoteRecord {
	target := source
	if source.ByteSize != nil {
		value := *source.ByteSize
		target.ByteSize = &value
	}
	if source.Width != nil {
		value := *source.Width
		target.Width = &value
	}
	if source.Height != nil {
		value := *source.Height
		target.Height = &value
	}
	if source.FrameCount != nil {
		value := *source.FrameCount
		target.FrameCount = &value
	}
	if source.DurationMS != nil {
		value := *source.DurationMS
		target.DurationMS = &value
	}
	if source.RemovedAt != nil {
		value := *source.RemovedAt
		target.RemovedAt = &value
	}
	return target
}

type fakeRepo struct {
	mu    sync.Mutex
	state fakeState
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{state: newFakeState()}
}

func (repo *fakeRepo) WithTx(_ context.Context, callback func(Tx) error) error {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	working := cloneFakeState(repo.state)
	if err := callback(&fakeTx{state: &working}); err != nil {
		return err
	}
	repo.state = working
	return nil
}

func (repo *fakeRepo) snapshot() fakeState {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	return cloneFakeState(repo.state)
}

func readFake[T any](repo *fakeRepo, fn func(*fakeTx) (T, error)) (T, error) {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	return fn(&fakeTx{state: &repo.state})
}

func (repo *fakeRepo) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return readFake(repo, func(tx *fakeTx) (*auth.Actor, error) {
		return tx.LookupActor(ctx, spaceID, userID)
	})
}

func (repo *fakeRepo) GetSettings(ctx context.Context, userID string) (SettingsRecord, error) {
	return readFake(repo, func(tx *fakeTx) (SettingsRecord, error) {
		return tx.GetSettings(ctx, userID)
	})
}

func (repo *fakeRepo) ListCustomEmotes(ctx context.Context, userID string, includeRemoved bool) ([]CustomEmoteRecord, error) {
	return readFake(repo, func(tx *fakeTx) ([]CustomEmoteRecord, error) {
		return tx.ListCustomEmotes(ctx, userID, includeRemoved)
	})
}

func (repo *fakeRepo) GetCustomEmote(ctx context.Context, emoteID string) (*CustomEmoteRecord, error) {
	return readFake(repo, func(tx *fakeTx) (*CustomEmoteRecord, error) {
		return tx.GetCustomEmote(ctx, emoteID)
	})
}

func (repo *fakeRepo) FindCustomEmoteByDigest(ctx context.Context, userID, digest string) (*CustomEmoteRecord, error) {
	return readFake(repo, func(tx *fakeTx) (*CustomEmoteRecord, error) {
		return tx.FindCustomEmoteByDigest(ctx, userID, digest)
	})
}

func (repo *fakeRepo) FindBuiltinEmote(ctx context.Context, userID, emoteKey string) (*CustomEmoteRecord, error) {
	return readFake(repo, func(tx *fakeTx) (*CustomEmoteRecord, error) {
		return tx.FindBuiltinEmote(ctx, userID, emoteKey)
	})
}

func (repo *fakeRepo) ListLibraryEntries(ctx context.Context, userID string) ([]LibraryEntryRecord, error) {
	return readFake(repo, func(tx *fakeTx) ([]LibraryEntryRecord, error) {
		return tx.ListLibraryEntries(ctx, userID)
	})
}

func (repo *fakeRepo) ListCollections(ctx context.Context, userID string) ([]CollectionRecord, error) {
	return readFake(repo, func(tx *fakeTx) ([]CollectionRecord, error) {
		return tx.ListCollections(ctx, userID)
	})
}

func (repo *fakeRepo) GetCollection(ctx context.Context, userID, collectionID string) (*CollectionRecord, error) {
	return readFake(repo, func(tx *fakeTx) (*CollectionRecord, error) {
		return tx.GetCollection(ctx, userID, collectionID)
	})
}

func (repo *fakeRepo) GetCollectionByID(ctx context.Context, collectionID string) (*CollectionRecord, error) {
	return readFake(repo, func(tx *fakeTx) (*CollectionRecord, error) {
		return tx.GetCollectionByID(ctx, collectionID)
	})
}

func (repo *fakeRepo) ListCollectionItems(ctx context.Context, collectionID string) ([]CollectionItemRecord, error) {
	return readFake(repo, func(tx *fakeTx) ([]CollectionItemRecord, error) {
		return tx.ListCollectionItems(ctx, collectionID)
	})
}

func (repo *fakeRepo) MutableCollectionIDsForEmote(ctx context.Context, userID, emoteID string) ([]string, error) {
	return readFake(repo, func(tx *fakeTx) ([]string, error) {
		return tx.MutableCollectionIDsForEmote(ctx, userID, emoteID)
	})
}

func (repo *fakeRepo) IsEmoteSubscriptionReadOnly(ctx context.Context, userID, emoteID string) (bool, error) {
	return readFake(repo, func(tx *fakeTx) (bool, error) {
		return tx.IsEmoteSubscriptionReadOnly(ctx, userID, emoteID)
	})
}

func (repo *fakeRepo) IsEmoteLocallyPlaced(ctx context.Context, userID, emoteID string) (bool, error) {
	return readFake(repo, func(tx *fakeTx) (bool, error) {
		return tx.IsEmoteLocallyPlaced(ctx, userID, emoteID)
	})
}

func (repo *fakeRepo) GetCollectionSubscription(ctx context.Context, collectionID string) (*CollectionSubscriptionRecord, error) {
	return readFake(repo, func(tx *fakeTx) (*CollectionSubscriptionRecord, error) {
		return tx.GetCollectionSubscription(ctx, collectionID)
	})
}

func (repo *fakeRepo) GetCollectionSubscriptionByID(ctx context.Context, subscriptionID string) (*CollectionSubscriptionRecord, error) {
	return readFake(repo, func(tx *fakeTx) (*CollectionSubscriptionRecord, error) {
		return tx.GetCollectionSubscriptionByID(ctx, subscriptionID)
	})
}

func (repo *fakeRepo) ListSubscriptionItems(ctx context.Context, subscriptionID string) ([]CollectionSubscriptionItemRecord, error) {
	return readFake(repo, func(tx *fakeTx) ([]CollectionSubscriptionItemRecord, error) {
		return tx.ListSubscriptionItems(ctx, subscriptionID)
	})
}

func (repo *fakeRepo) GetShare(ctx context.Context, shareID string) (*ShareRecord, error) {
	return readFake(repo, func(tx *fakeTx) (*ShareRecord, error) {
		return tx.GetShare(ctx, shareID)
	})
}

func (repo *fakeRepo) ListShareItems(ctx context.Context, shareID string) ([]ShareItemRecord, error) {
	return readFake(repo, func(tx *fakeTx) ([]ShareItemRecord, error) {
		return tx.ListShareItems(ctx, shareID)
	})
}

func (repo *fakeRepo) EmoteVisibleTo(ctx context.Context, spaceID, actorID, emoteID string) (bool, error) {
	return readFake(repo, func(tx *fakeTx) (bool, error) {
		return tx.EmoteVisibleTo(ctx, spaceID, actorID, emoteID)
	})
}

func (repo *fakeRepo) EmoteUsage(ctx context.Context, userID, ignoredSubscriptionID string) (EmoteUsage, error) {
	return readFake(repo, func(tx *fakeTx) (EmoteUsage, error) {
		return tx.EmoteUsage(ctx, userID, ignoredSubscriptionID)
	})
}

func (repo *fakeRepo) GetStorageObject(ctx context.Context, objectID string, includeDeleted bool) (*StorageObjectRecord, error) {
	return readFake(repo, func(tx *fakeTx) (*StorageObjectRecord, error) {
		return tx.GetStorageObject(ctx, objectID, includeDeleted)
	})
}

func (repo *fakeRepo) StorageObjectReferenceCount(ctx context.Context, objectID string) (int64, error) {
	return readFake(repo, func(tx *fakeTx) (int64, error) {
		return tx.StorageObjectReferenceCount(ctx, objectID)
	})
}

type fakeTx struct{ state *fakeState }

func (tx *fakeTx) LookupActor(_ context.Context, _, userID string) (*auth.Actor, error) {
	actor := tx.state.actors[userID]
	if actor == nil {
		return nil, nil
	}
	copy := *actor
	return &copy, nil
}

func (tx *fakeTx) GetSettings(_ context.Context, userID string) (SettingsRecord, error) {
	return tx.state.settings[userID], nil
}

func (tx *fakeTx) ListCustomEmotes(_ context.Context, userID string, includeRemoved bool) ([]CustomEmoteRecord, error) {
	result := make([]CustomEmoteRecord, 0)
	for _, row := range tx.state.emotes {
		if row.UserID != userID || (!includeRemoved && row.RemovedAt != nil) {
			continue
		}
		result = append(result, cloneEmoteRecord(row))
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].SortOrder != result[j].SortOrder {
			return result[i].SortOrder < result[j].SortOrder
		}
		return result[i].CreatedAt.Before(result[j].CreatedAt)
	})
	return result, nil
}

func (tx *fakeTx) GetCustomEmote(_ context.Context, emoteID string) (*CustomEmoteRecord, error) {
	row, ok := tx.state.emotes[emoteID]
	if !ok {
		return nil, nil
	}
	copy := cloneEmoteRecord(row)
	return &copy, nil
}

func (tx *fakeTx) FindCustomEmoteByDigest(_ context.Context, userID, digest string) (*CustomEmoteRecord, error) {
	var found *CustomEmoteRecord
	for _, row := range tx.state.emotes {
		if row.UserID != userID || row.SHA256 != digest {
			continue
		}
		copy := cloneEmoteRecord(row)
		if found == nil || (found.RemovedAt != nil && copy.RemovedAt == nil) {
			found = &copy
		}
	}
	return found, nil
}

func (tx *fakeTx) FindBuiltinEmote(_ context.Context, userID, key string) (*CustomEmoteRecord, error) {
	for _, row := range tx.state.emotes {
		if row.UserID == userID && row.SourceEmoteKey == key {
			copy := cloneEmoteRecord(row)
			return &copy, nil
		}
	}
	return nil, nil
}

func (tx *fakeTx) ListLibraryEntries(_ context.Context, userID string) ([]LibraryEntryRecord, error) {
	result := make([]LibraryEntryRecord, 0)
	for _, entry := range tx.state.entries {
		if entry.UserID == userID {
			result = append(result, entry)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].SortOrder < result[j].SortOrder })
	return result, nil
}

func (tx *fakeTx) ListCollections(_ context.Context, userID string) ([]CollectionRecord, error) {
	result := make([]CollectionRecord, 0)
	for _, collection := range tx.state.collections {
		if collection.UserID == userID {
			result = append(result, collection)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UpdatedAt.After(result[j].UpdatedAt) })
	return result, nil
}

func (tx *fakeTx) GetCollection(_ context.Context, userID, collectionID string) (*CollectionRecord, error) {
	collection, ok := tx.state.collections[collectionID]
	if !ok || collection.UserID != userID {
		return nil, nil
	}
	copy := collection
	return &copy, nil
}

func (tx *fakeTx) GetCollectionByID(_ context.Context, collectionID string) (*CollectionRecord, error) {
	collection, ok := tx.state.collections[collectionID]
	if !ok {
		return nil, nil
	}
	copy := collection
	return &copy, nil
}

func (tx *fakeTx) ListCollectionItems(_ context.Context, collectionID string) ([]CollectionItemRecord, error) {
	result := append([]CollectionItemRecord(nil), tx.state.items[collectionID]...)
	sort.Slice(result, func(i, j int) bool { return result[i].SortOrder < result[j].SortOrder })
	return result, nil
}

func (tx *fakeTx) MutableCollectionIDsForEmote(_ context.Context, userID, emoteID string) ([]string, error) {
	result := make([]string, 0)
	for id, collection := range tx.state.collections {
		if collection.UserID != userID || collection.SubscriptionStatus == "active" {
			continue
		}
		for _, item := range tx.state.items[id] {
			if item.EmoteID == emoteID {
				result = append(result, id)
				break
			}
		}
	}
	sort.Strings(result)
	return result, nil
}

func (tx *fakeTx) IsEmoteSubscriptionReadOnly(_ context.Context, userID, emoteID string) (bool, error) {
	for subscriptionID, subscription := range tx.state.subscriptions {
		if subscription.SubscriberUserID != userID || subscription.Status != "active" {
			continue
		}
		for _, item := range tx.state.subscriptionItems[subscriptionID] {
			if item.TargetEmoteID == emoteID {
				return true, nil
			}
		}
	}
	return false, nil
}

func (tx *fakeTx) IsEmoteLocallyPlaced(_ context.Context, userID, emoteID string) (bool, error) {
	for _, entry := range tx.state.entries {
		if entry.UserID == userID && entry.EmoteID == emoteID {
			return true, nil
		}
	}
	for collectionID, collection := range tx.state.collections {
		if collection.UserID != userID {
			continue
		}
		subscription, hasSubscription := tx.subscriptionForCollection(collectionID)
		if hasSubscription && subscription.Status == "active" {
			continue
		}
		if !hasSubscription && collection.SubscriptionStatus == "active" {
			continue
		}
		for _, item := range tx.state.items[collectionID] {
			if item.EmoteID == emoteID {
				return true, nil
			}
		}
	}
	return false, nil
}

func (tx *fakeTx) subscriptionForCollection(collectionID string) (CollectionSubscriptionRecord, bool) {
	for _, subscription := range tx.state.subscriptions {
		if subscription.CollectionID == collectionID {
			return subscription, true
		}
	}
	return CollectionSubscriptionRecord{}, false
}

func (tx *fakeTx) GetCollectionSubscription(_ context.Context, collectionID string) (*CollectionSubscriptionRecord, error) {
	for _, subscription := range tx.state.subscriptions {
		if subscription.CollectionID == collectionID {
			copy := cloneSubscriptionRecord(subscription)
			return &copy, nil
		}
	}
	return nil, nil
}

func (tx *fakeTx) GetCollectionSubscriptionByID(_ context.Context, subscriptionID string) (*CollectionSubscriptionRecord, error) {
	subscription, ok := tx.state.subscriptions[subscriptionID]
	if !ok {
		return nil, nil
	}
	copy := cloneSubscriptionRecord(subscription)
	return &copy, nil
}

func (tx *fakeTx) ListSubscriptionItems(_ context.Context, subscriptionID string) ([]CollectionSubscriptionItemRecord, error) {
	result := append([]CollectionSubscriptionItemRecord(nil), tx.state.subscriptionItems[subscriptionID]...)
	sort.Slice(result, func(i, j int) bool { return result[i].SourceSortOrder < result[j].SourceSortOrder })
	return result, nil
}

func (tx *fakeTx) GetShare(_ context.Context, shareID string) (*ShareRecord, error) {
	share, ok := tx.state.shares[shareID]
	if !ok {
		return nil, nil
	}
	copy := share
	return &copy, nil
}

func (tx *fakeTx) ListShareItems(_ context.Context, shareID string) ([]ShareItemRecord, error) {
	return append([]ShareItemRecord(nil), tx.state.shareItems[shareID]...), nil
}

func (tx *fakeTx) EmoteVisibleTo(_ context.Context, _, _, _ string) (bool, error) { return false, nil }

func (tx *fakeTx) EmoteUsage(_ context.Context, userID, ignoredSubscriptionID string) (EmoteUsage, error) {
	var usage EmoteUsage
	activeSubscriptionTargets := make(map[string]struct{})
	activeSubscriptionCount := int64(0)
	for subscriptionID, subscription := range tx.state.subscriptions {
		if subscription.SubscriberUserID != userID || subscription.Status != "active" || subscriptionID == ignoredSubscriptionID {
			continue
		}
		activeSubscriptionCount++
		for _, item := range tx.state.subscriptionItems[subscriptionID] {
			activeSubscriptionTargets[item.TargetEmoteID] = struct{}{}
		}
	}
	localPlacements := make(map[string]struct{})
	for _, entry := range tx.state.entries {
		if entry.UserID == userID && entry.EmoteID != "" {
			localPlacements[entry.EmoteID] = struct{}{}
		}
	}
	for collectionID, collection := range tx.state.collections {
		if collection.UserID != userID {
			continue
		}
		subscription, hasSubscription := tx.subscriptionForCollection(collectionID)
		active := hasSubscription && subscription.Status == "active"
		if !hasSubscription {
			active = collection.SubscriptionStatus == "active"
		}
		if active {
			if subscription.ID == ignoredSubscriptionID {
				active = false
			}
		}
		if !active {
			for _, item := range tx.state.items[collectionID] {
				localPlacements[item.EmoteID] = struct{}{}
			}
		}
	}
	for _, row := range tx.state.emotes {
		if row.UserID != userID || row.RemovedAt != nil {
			continue
		}
		bytes := valueOrZero(row.ByteSize)
		usage.ItemCount++
		usage.AllTotalBytes += bytes
		if _, subscribed := activeSubscriptionTargets[row.ID]; subscribed {
			if _, local := localPlacements[row.ID]; !local {
				usage.ItemCount--
				usage.SubscribedItemCount++
				usage.SubscribedTotalBytes += bytes
				continue
			}
		}
		usage.TotalBytes += bytes
	}
	usage.TotalItemCount = usage.ItemCount + usage.SubscribedItemCount
	usage.CollectionCount = int64(len(collectionIDsForUser(tx.state.collections, userID)))
	usage.SubscribedCollectionCount = activeSubscriptionCount
	usage.OverLimit = usage.TotalBytes > MaxTotalBytes
	return usage, nil
}

func collectionIDsForUser(collections map[string]CollectionRecord, userID string) []string {
	result := make([]string, 0)
	for id, collection := range collections {
		if collection.UserID == userID {
			result = append(result, id)
		}
	}
	return result
}

func (tx *fakeTx) GetStorageObject(_ context.Context, objectID string, includeDeleted bool) (*StorageObjectRecord, error) {
	object, ok := tx.state.objects[objectID]
	if !ok || (!includeDeleted && object.DeletedAt != nil) {
		return nil, nil
	}
	copy := object
	return &copy, nil
}

func (tx *fakeTx) StorageObjectReferenceCount(_ context.Context, objectID string) (int64, error) {
	var count int64
	for _, row := range tx.state.emotes {
		if row.StorageObjectID == objectID {
			count++
		}
	}
	return count, nil
}

func (tx *fakeTx) Lock(context.Context, string) error { return nil }

func (tx *fakeTx) UpsertSettings(_ context.Context, userID, ids string, click, reply, autoHideMessages bool, autoHideMessageTypesJSON string, _ time.Time) error {
	tx.state.settings[userID] = SettingsRecord{
		EnabledPackIDsJSON: ids, ClickImageEmoteToSend: click, ReplyAutoMention: reply,
		AutoHideMessages: autoHideMessages, AutoHideMessageTypesJSON: autoHideMessageTypesJSON,
	}
	return nil
}

func (tx *fakeTx) AcquireStorageObject(_ context.Context, record StorageObjectRecord) (*StorageObjectRecord, error) {
	existing, ok := tx.state.objects[record.ID]
	if ok && (existing.SHA256 != record.SHA256 || existing.ByteSize != record.ByteSize || existing.ObjectKey != record.ObjectKey) {
		return nil, errors.New("storage conflict")
	}
	if !ok {
		existing = record
	}
	existing.DeletedAt = nil
	tx.state.objects[record.ID] = existing
	copy := existing
	return &copy, nil
}

func (tx *fakeTx) BindStorageObject(_ context.Context, emoteID, objectID string) error {
	row, ok := tx.state.emotes[emoteID]
	if !ok {
		return errors.New("emote not found")
	}
	row.StorageObjectID = objectID
	tx.state.emotes[emoteID] = row
	return nil
}

func (tx *fakeTx) InsertCustomEmote(_ context.Context, record CustomEmoteRecord) (bool, error) {
	if _, exists := tx.state.emotes[record.ID]; exists {
		return false, nil
	}
	tx.state.emotes[record.ID] = cloneEmoteRecord(record)
	return true, nil
}

func (tx *fakeTx) RestoreCustomEmote(_ context.Context, userID, emoteID string, _ time.Time) (bool, error) {
	row, ok := tx.state.emotes[emoteID]
	if !ok || row.UserID != userID {
		return false, nil
	}
	row.RemovedAt = nil
	tx.state.emotes[emoteID] = row
	return true, nil
}

func (tx *fakeTx) EnsureLibraryEntry(_ context.Context, entry LibraryEntryRecord) (bool, error) {
	for _, current := range tx.state.entries {
		if current.UserID == entry.UserID && ((entry.EntryType == "emote" && current.EmoteID == entry.EmoteID) || (entry.EntryType == "collection" && current.CollectionID == entry.CollectionID)) {
			return false, nil
		}
	}
	if entry.SortOrder < 0 {
		minimum := int64(0)
		for _, current := range tx.state.entries {
			if current.UserID == entry.UserID && current.SortOrder < minimum {
				minimum = current.SortOrder
			}
		}
		entry.SortOrder = minimum - 1
	}
	tx.state.entries[entry.ID] = entry
	return true, nil
}

func (tx *fakeTx) DeleteLibraryEntry(_ context.Context, userID, emoteID, collectionID string) (bool, error) {
	changed := false
	for id, entry := range tx.state.entries {
		if entry.UserID == userID && ((emoteID != "" && entry.EmoteID == emoteID) || (collectionID != "" && entry.CollectionID == collectionID)) {
			delete(tx.state.entries, id)
			changed = true
		}
	}
	return changed, nil
}

func (tx *fakeTx) DeleteCollectionEmoteLinks(_ context.Context, userID, emoteID string) error {
	for id, collection := range tx.state.collections {
		if collection.UserID != userID {
			continue
		}
		filtered := tx.state.items[id][:0]
		for _, item := range tx.state.items[id] {
			if item.EmoteID != emoteID {
				filtered = append(filtered, item)
			}
		}
		tx.state.items[id] = filtered
	}
	return nil
}

func (tx *fakeTx) MarkCustomEmoteRemoved(_ context.Context, userID, emoteID string, at time.Time) (bool, error) {
	row, ok := tx.state.emotes[emoteID]
	if !ok || row.UserID != userID {
		return false, nil
	}
	if row.RemovedAt == nil {
		value := at
		row.RemovedAt = &value
	}
	tx.state.emotes[emoteID] = row
	return true, nil
}

func (tx *fakeTx) UpdateCustomEmoteLabel(_ context.Context, userID, emoteID, label string) (bool, error) {
	row, ok := tx.state.emotes[emoteID]
	if !ok || row.UserID != userID || row.RemovedAt != nil {
		return false, nil
	}
	row.Label = label
	tx.state.emotes[emoteID] = row
	return true, nil
}

func (tx *fakeTx) DeleteUnreferencedEmote(_ context.Context, emoteID string) (*CustomEmoteRecord, bool, error) {
	row, ok := tx.state.emotes[emoteID]
	if !ok {
		return nil, false, nil
	}
	for _, entry := range tx.state.entries {
		if entry.EmoteID == emoteID {
			return &row, false, nil
		}
	}
	for _, items := range tx.state.items {
		for _, item := range items {
			if item.EmoteID == emoteID {
				return &row, false, nil
			}
		}
	}
	for _, items := range tx.state.shareItems {
		for _, item := range items {
			if item.EmoteID == emoteID {
				return &row, false, nil
			}
		}
	}
	for _, items := range tx.state.subscriptionItems {
		for _, item := range items {
			if item.SourceEmoteID == emoteID {
				return &row, false, nil
			}
		}
	}
	delete(tx.state.emotes, emoteID)
	return &row, true, nil
}

func (tx *fakeTx) InsertCollection(_ context.Context, record CollectionRecord) error {
	tx.state.collections[record.ID] = record
	return nil
}

func (tx *fakeTx) ListSubscriptionsBySource(_ context.Context, sourceCollectionID, status string) ([]CollectionSubscriptionRecord, error) {
	result := make([]CollectionSubscriptionRecord, 0)
	for _, subscription := range tx.state.subscriptions {
		if subscription.SourceCollectionID == sourceCollectionID && subscription.Status == status {
			result = append(result, cloneSubscriptionRecord(subscription))
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.Equal(result[j].CreatedAt) {
			return result[i].ID < result[j].ID
		}
		return result[i].CreatedAt.Before(result[j].CreatedAt)
	})
	return result, nil
}

func (tx *fakeTx) UpsertCollectionSubscription(_ context.Context, record CollectionSubscriptionRecord) (bool, error) {
	for id, existing := range tx.state.subscriptions {
		if existing.CollectionID == record.CollectionID && id != record.ID {
			delete(tx.state.subscriptions, id)
		}
	}
	if existing, ok := tx.state.subscriptions[record.ID]; ok && record.CreatedAt.IsZero() {
		record.CreatedAt = existing.CreatedAt
	}
	if record.UpdatedAt.IsZero() {
		record.UpdatedAt = record.CreatedAt
	}
	tx.state.subscriptions[record.ID] = cloneSubscriptionRecord(record)
	if collection, ok := tx.state.collections[record.CollectionID]; ok {
		collection.SourceCollectionID = record.SourceCollectionID
		collection.SubscriptionSourceCollectionID = record.SourceCollectionID
		collection.SubscriptionStatus = record.Status
		collection.SubscriptionSourceRevision = int64Pointer(record.SourceRevision)
		collection.SubscriptionLastSyncedAt = cloneTime(record.LastSyncedAt)
		tx.state.collections[record.CollectionID] = collection
	}
	return true, nil
}

func (tx *fakeTx) UpdateCollectionSubscription(_ context.Context, subscriptionID, status string, sourceRevision int64, lastSyncedAt, detachedAt *time.Time, at time.Time) (bool, error) {
	record, ok := tx.state.subscriptions[subscriptionID]
	if !ok {
		return false, nil
	}
	record.Status, record.SourceRevision, record.LastSyncedAt, record.DetachedAt, record.UpdatedAt = status, sourceRevision, cloneTime(lastSyncedAt), cloneTime(detachedAt), at
	tx.state.subscriptions[subscriptionID] = record
	if collection, ok := tx.state.collections[record.CollectionID]; ok {
		collection.SubscriptionStatus = status
		collection.SubscriptionSourceCollectionID = record.SourceCollectionID
		collection.SubscriptionSourceRevision = int64Pointer(sourceRevision)
		collection.SubscriptionLastSyncedAt = cloneTime(lastSyncedAt)
		tx.state.collections[record.CollectionID] = collection
	}
	return true, nil
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func (tx *fakeTx) DeleteCollectionItems(_ context.Context, collectionID string) error {
	delete(tx.state.items, collectionID)
	return nil
}

func (tx *fakeTx) DeleteSubscriptionItems(_ context.Context, subscriptionID string) error {
	delete(tx.state.subscriptionItems, subscriptionID)
	return nil
}

func (tx *fakeTx) InsertSubscriptionItem(_ context.Context, item CollectionSubscriptionItemRecord) error {
	for _, existing := range tx.state.subscriptionItems[item.SubscriptionID] {
		if existing.SourceEmoteID == item.SourceEmoteID || existing.TargetEmoteID == item.TargetEmoteID {
			return errors.New("subscription item already exists")
		}
	}
	tx.state.subscriptionItems[item.SubscriptionID] = append(tx.state.subscriptionItems[item.SubscriptionID], item)
	return nil
}

func (tx *fakeTx) UpdateCollectionFromSource(_ context.Context, userID, collectionID, name, sourceCollectionID, originalCreatorID string, at time.Time) (bool, error) {
	record, ok := tx.state.collections[collectionID]
	if !ok || record.UserID != userID {
		return false, nil
	}
	record.Name, record.SourceCollectionID, record.SubscriptionSourceCollectionID = name, sourceCollectionID, sourceCollectionID
	record.OriginalCreatorID, record.SubscriptionStatus, record.Revision, record.UpdatedAt = originalCreatorID, "active", record.Revision+1, at
	tx.state.collections[collectionID] = record
	return true, nil
}

func (tx *fakeTx) UpdateCollectionName(_ context.Context, userID, collectionID, name string, at time.Time) (bool, error) {
	record, ok := tx.state.collections[collectionID]
	if !ok || record.UserID != userID {
		return false, nil
	}
	record.Name, record.Revision, record.UpdatedAt = name, record.Revision+1, at
	tx.state.collections[collectionID] = record
	return true, nil
}

func (tx *fakeTx) DeleteCollection(_ context.Context, userID, collectionID string) (bool, error) {
	record, ok := tx.state.collections[collectionID]
	if !ok || record.UserID != userID {
		return false, nil
	}
	delete(tx.state.collections, collectionID)
	delete(tx.state.items, collectionID)
	if subscription, ok := tx.subscriptionForCollection(collectionID); ok {
		delete(tx.state.subscriptions, subscription.ID)
		delete(tx.state.subscriptionItems, subscription.ID)
	}
	for id, entry := range tx.state.entries {
		if entry.CollectionID == collectionID {
			delete(tx.state.entries, id)
		}
	}
	return true, nil
}

func (tx *fakeTx) InsertCollectionItem(_ context.Context, item CollectionItemRecord) (bool, error) {
	for _, current := range tx.state.items[item.CollectionID] {
		if current.EmoteID == item.EmoteID {
			return false, nil
		}
	}
	if item.SortOrder < 0 {
		item.SortOrder = int64(len(tx.state.items[item.CollectionID]))
	}
	tx.state.items[item.CollectionID] = append(tx.state.items[item.CollectionID], item)
	return true, nil
}

func (tx *fakeTx) DeleteCollectionItem(_ context.Context, collectionID, emoteID string) (bool, error) {
	items := tx.state.items[collectionID]
	filtered := items[:0]
	changed := false
	for _, item := range items {
		if item.EmoteID == emoteID {
			changed = true
			continue
		}
		filtered = append(filtered, item)
	}
	tx.state.items[collectionID] = filtered
	return changed, nil
}

func (tx *fakeTx) UpdateCollectionRevision(_ context.Context, userID, collectionID string, at time.Time) (bool, error) {
	record, ok := tx.state.collections[collectionID]
	if !ok || record.UserID != userID {
		return false, nil
	}
	record.Revision++
	record.UpdatedAt = at
	tx.state.collections[collectionID] = record
	return true, nil
}

func (tx *fakeTx) ReorderLibraryEntry(_ context.Context, userID, entryID string, order int64) error {
	entry, ok := tx.state.entries[entryID]
	if !ok || entry.UserID != userID {
		return errors.New("entry not found")
	}
	entry.SortOrder = order
	tx.state.entries[entryID] = entry
	return nil
}

func (tx *fakeTx) ReorderCollectionItem(_ context.Context, collectionID, emoteID string, order int64) error {
	items := tx.state.items[collectionID]
	for index := range items {
		if items[index].EmoteID == emoteID {
			items[index].SortOrder = order
			tx.state.items[collectionID] = items
			return nil
		}
	}
	return errors.New("item not found")
}

func (tx *fakeTx) FindActiveShareByFingerprint(_ context.Context, collectionID, userID, fingerprint string) (*ShareRecord, error) {
	for _, share := range tx.state.shares {
		if share.SourceCollectionID == collectionID && share.SharedByID == userID && share.Fingerprint == fingerprint && share.RevokedAt == nil {
			copy := share
			return &copy, nil
		}
	}
	return nil, nil
}

func (tx *fakeTx) InsertShare(_ context.Context, record ShareRecord) error {
	tx.state.shares[record.ID] = record
	return nil
}

func (tx *fakeTx) InsertShareItem(_ context.Context, item ShareItemRecord) error {
	tx.state.shareItems[item.ShareID] = append(tx.state.shareItems[item.ShareID], item)
	return nil
}

func (tx *fakeTx) RevokeShare(_ context.Context, userID, shareID string, at time.Time) (bool, error) {
	share, ok := tx.state.shares[shareID]
	if !ok || share.SharedByID != userID {
		return false, nil
	}
	if share.RevokedAt == nil {
		value := at
		share.RevokedAt = &value
	}
	tx.state.shares[shareID] = share
	return true, nil
}

func (tx *fakeTx) DeleteShareItems(_ context.Context, shareID string) error {
	delete(tx.state.shareItems, shareID)
	return nil
}

func (tx *fakeTx) MarkStorageObjectDeleted(_ context.Context, objectID string, at time.Time) (bool, error) {
	object, ok := tx.state.objects[objectID]
	if !ok {
		return false, nil
	}
	object.DeletedAt = &at
	tx.state.objects[objectID] = object
	return true, nil
}

func (tx *fakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	tx.state.audits = append(tx.state.audits, input)
	return nil
}

func (tx *fakeTx) WriteEvent(_ context.Context, input EventInput) error {
	tx.state.events = append(tx.state.events, input)
	tx.state.nextSequence++
	return nil
}

var _ Repository = (*fakeRepo)(nil)
var _ Tx = (*fakeTx)(nil)

type fakeBlobStore struct {
	mu      sync.Mutex
	objects map[string][]byte
}

func newFakeBlobStore() *fakeBlobStore { return &fakeBlobStore{objects: make(map[string][]byte)} }

func (store *fakeBlobStore) Put(_ context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (platformstorage.StoredObject, error) {
	data, err := io.ReadAll(source)
	if err != nil {
		return platformstorage.StoredObject{}, err
	}
	if int64(len(data)) != expectedSize {
		return platformstorage.StoredObject{}, errors.New("size mismatch")
	}
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])
	if digest != expectedSHA256 {
		return platformstorage.StoredObject{}, errors.New("hash mismatch")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	_, reused := store.objects[key]
	store.objects[key] = append([]byte(nil), data...)
	return platformstorage.StoredObject{Object: platformstorage.Object{Key: key, SHA256: digest, ByteSize: expectedSize, ContentType: "image/webp"}, Reused: reused}, nil
}

func (store *fakeBlobStore) Open(_ context.Context, object platformstorage.Object, maxBytes int64) (platformstorage.OpenedObject, error) {
	store.mu.Lock()
	data, ok := store.objects[object.Key]
	store.mu.Unlock()
	if !ok {
		return platformstorage.OpenedObject{}, errors.New("missing")
	}
	if int64(len(data)) > maxBytes {
		return platformstorage.OpenedObject{}, errors.New("too large")
	}
	return platformstorage.OpenedObject{Object: object, Body: io.NopCloser(bytes.NewReader(data))}, nil
}

func (store *fakeBlobStore) Delete(_ context.Context, object platformstorage.Object) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.objects, object.Key)
	return nil
}

type fakeProcessor struct{}

func (fakeProcessor) Process(_ context.Context, input []byte, source UploadSource) (ProcessedUpload, error) {
	return ProcessedUpload{Content: append([]byte(nil), input...), DetectedMIMEType: source.MIMEType, NormalizedMIMEType: "image/webp", ByteSize: int64(len(input)), Width: 2, Height: 3, FrameCount: 1}, nil
}

func testCatalog(t *testing.T) *Catalog {
	t.Helper()
	return mustCatalog(t, []CatalogPack{
		{ID: "emoji", Label: "Emoji", Items: []CatalogItem{{Kind: "unicode", ID: "smile", Label: "微笑", Value: "😄"}}},
		{ID: "bili", Label: "Bili", Items: []CatalogItem{{Kind: "image", ID: "doge", Label: "狗头", Token: "[bili:doge]", Src: "/emotes/bili/doge.png"}}},
		{ID: "douyin", Label: "Hidden", Items: []CatalogItem{{Kind: "image", ID: "hidden", Label: "Hidden", Token: "[douyin:hidden]", Src: "/hidden.png"}}},
	})
}

func mustCatalog(t *testing.T, packs []CatalogPack) *Catalog {
	t.Helper()
	catalog, err := NewCatalog(packs)
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func testService(t *testing.T, repo *fakeRepo, store *fakeBlobStore) *Service {
	t.Helper()
	counter := 0
	now := time.Date(2026, 9, 4, 12, 34, 56, 789654321, time.UTC)
	return NewService(ServiceOptions{
		Repository: repo, BlobStore: store, Catalog: testCatalog(t), Processor: fakeProcessor{},
		Now:       func() time.Time { return now },
		IDFactory: func() (string, error) { counter++; return "id-" + string(rune('a'+counter)), nil },
	})
}

func seedFakeActor(repo *fakeRepo, id, role string) {
	repo.state.actors[id] = &auth.Actor{ID: id, Kind: "human", Role: role, GitHubLogin: id, DisplayName: id}
}

func TestLoadCatalogMatchesImportedCatalogShape(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/shared/emote-packs.json"))
	catalog, err := LoadCatalogFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if catalog.IsVisible("douyin:nonexistent") {
		t.Fatal("unknown hidden key became visible")
	}
	if !catalog.IsVisible("bili:doge") {
		t.Fatal("known image key is not visible")
	}
	if len(catalog.VisiblePacks()) != 7 {
		t.Fatalf("visible packs = %d, want 7", len(catalog.VisiblePacks()))
	}
	if got := catalog.Public("emoji:grinning"); got == nil || got.Value == "" || got.Src != "" {
		t.Fatalf("unicode projection = %#v", got)
	}
}

func TestPreflightBoundsContentAndSource(t *testing.T) {
	service := NewService(ServiceOptions{})
	if _, err := service.PreflightUpload(context.Background(), UploadSource{MIMEType: "text/plain", FileName: "a.txt"}, strings.NewReader("x")); !isCode(err, CodeEmoteInvalidFormat) {
		t.Fatalf("invalid MIME = %v", err)
	}
	if _, err := service.PreflightUpload(context.Background(), UploadSource{MIMEType: "image/png", FileName: "../a.png"}, strings.NewReader("x")); err != nil {
		t.Fatalf("safe basename should pass: %v", err)
	}
	if _, err := service.PreflightUpload(context.Background(), UploadSource{MIMEType: "image/png", FileName: "bad\x00.png"}, strings.NewReader("x")); !isCode(err, CodeEmoteInvalidFileName) {
		t.Fatalf("control filename = %v", err)
	}
	if _, err := service.PreflightUpload(context.Background(), UploadSource{MIMEType: "image/png", FileName: "large.png"}, bytes.NewReader(make([]byte, MaxInputBytes+1))); !isCode(err, CodeEmoteInputTooLarge) {
		t.Fatalf("oversize = %v", err)
	}
}

func TestServiceStoreReadAndRemoveCleansLastCASReference(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	store := newFakeBlobStore()
	service := testService(t, repo, store)
	emote, err := service.Upload(context.Background(), UploadInput{ActorID: "usr-owner", Source: UploadSource{MIMEType: "image/png", FileName: "favorite.png"}, Content: strings.NewReader("normalized"), AddToLibrary: true})
	if err != nil {
		t.Fatal(err)
	}
	if emote.Kind != "custom" || emote.Token != "[custom:"+emote.ID+"]" || emote.CreatedAt != "2026-09-04T12:34:56.789Z" {
		t.Fatalf("public emote = %#v", emote)
	}
	if strings.Contains(emote.Token, "sha256") || strings.Contains(emote.Src, "workspace/objects") {
		t.Fatal("public projection leaked storage identity")
	}
	delivery, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: "usr-owner", EmoteID: emote.ID})
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(delivery.Body)
	_ = delivery.Body.Close()
	if err != nil || string(content) != "normalized" || delivery.ContentType != "image/webp" {
		t.Fatalf("delivery = %q, %#v, %v", content, delivery, err)
	}
	if _, err := service.Remove(context.Background(), "usr-owner", emote.ID, auth.RequestMeta{}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: "usr-owner", EmoteID: emote.ID}); !isCode(err, CodeEmoteNotFound) {
		t.Fatalf("removed content = %v", err)
	}
	state := repo.snapshot()
	if len(state.emotes) != 0 || len(store.objects) != 0 {
		t.Fatalf("remove retained emote/object: rows=%d objects=%d", len(state.emotes), len(store.objects))
	}
	if len(state.audits) < 2 || len(state.events) < 2 {
		t.Fatalf("mutation evidence = audits:%d events:%d", len(state.audits), len(state.events))
	}
}

func TestValidateMessageCustomEmoteRequiresOwnedAvailableMedia(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	seedFakeActor(repo, "usr-other", "member")
	service := testService(t, repo, newFakeBlobStore())
	emote := mustUpload(t, service, "usr-owner", "message.png", "message")
	if err := service.ValidateMessageCustomEmote(context.Background(), "usr-owner", emote.ID); err != nil {
		t.Fatalf("validate owned emote: %v", err)
	}
	if err := service.ValidateMessageCustomEmote(context.Background(), "usr-other", emote.ID); !isCode(err, "message.invalid_emoji") {
		t.Fatalf("validate another user's emote = %v", err)
	}
	if _, err := service.Remove(context.Background(), "usr-owner", emote.ID, auth.RequestMeta{}); err != nil {
		t.Fatal(err)
	}
	if err := service.ValidateMessageCustomEmote(context.Background(), "usr-owner", emote.ID); !isCode(err, "message.invalid_emoji") {
		t.Fatalf("validate removed emote = %v", err)
	}
}

func TestServiceCollectionsSharesAndSettingsAreStable(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	store := newFakeBlobStore()
	service := testService(t, repo, store)
	settings, err := service.GetSettings(context.Background(), "usr-owner")
	if err != nil || len(settings.EnabledPackIDs) != 2 {
		t.Fatalf("default settings = %#v, %v", settings, err)
	}
	ids := []string{"bili"}
	updated, err := service.UpdateSettings(context.Background(), "usr-owner", UpdateSettingsInput{EnabledPackIDs: &ids, ReplyAutoMention: boolPointer(true)}, auth.RequestMeta{})
	if err != nil || len(updated.EnabledPackIDs) != 1 || !updated.ReplyAutoMention {
		t.Fatalf("updated settings = %#v, %v", updated, err)
	}
	if _, err := service.UpdateSettings(context.Background(), "usr-owner", UpdateSettingsInput{EnabledPackIDs: &[]string{}}, auth.RequestMeta{}); !isCode(err, CodeEmotePackRequired) {
		t.Fatalf("empty pack settings = %v", err)
	}
	first := mustUpload(t, service, "usr-owner", "first.png", "first")
	second := mustUpload(t, service, "usr-owner", "second.png", "second")
	collection, err := service.CreateCollection(context.Background(), CreateCollectionInput{ActorID: "usr-owner", Name: "常用", EmoteIDs: []string{first.ID, second.ID}})
	if err != nil || collection.ItemCount != 2 {
		t.Fatalf("collection = %#v, %v", collection, err)
	}
	share, err := service.CreateShare(context.Background(), CreateShareInput{ActorID: "usr-owner", CollectionID: collection.ID})
	if err != nil || share.ItemCount != 2 || len(share.Items) != 2 {
		t.Fatalf("share = %#v, %v", share, err)
	}
	reused, err := service.CreateShare(context.Background(), CreateShareInput{ActorID: "usr-owner", CollectionID: collection.ID})
	if err != nil || reused.ID != share.ID {
		t.Fatalf("share idempotency = %#v, %v", reused, err)
	}
	imported, err := service.ImportShare(context.Background(), ImportShareInput{ActorID: "usr-owner", ShareID: share.ID})
	if err != nil || imported.Collection == nil || len(imported.Items) != 2 {
		t.Fatalf("import = %#v, %v", imported, err)
	}
	if _, err := service.RemoveCollectionItem(context.Background(), RemoveCollectionItemInput{ActorID: "usr-owner", CollectionID: collection.ID, EmoteID: first.ID}); err != nil {
		t.Fatal(err)
	}
	latest, err := service.GetLibrary(context.Background(), "usr-owner")
	if err != nil || len(latest.Collections) != 2 {
		t.Fatalf("library after import = %#v, %v", latest, err)
	}
	if _, err := service.RevokeShare(context.Background(), ShareInput{ActorID: "usr-owner", ShareID: share.ID}); err != nil {
		t.Fatal(err)
	}
	revoked, err := service.GetShare(context.Background(), "usr-owner", share.ID)
	if err != nil || revoked.RevokedAt == nil || len(revoked.Items) != 0 {
		t.Fatalf("revoked share = %#v, %v", revoked, err)
	}
}

func TestServiceCollectionSubscriptionSyncQuotaAndDetach(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	seedFakeActor(repo, "usr-member", "member")
	service := testService(t, repo, newFakeBlobStore())
	first := mustUpload(t, service, "usr-owner", "first.png", "first")
	second := mustUpload(t, service, "usr-owner", "second.png", "second")
	source, err := service.CreateCollection(context.Background(), CreateCollectionInput{
		ActorID: "usr-owner", Name: "Source", EmoteIDs: []string{first.ID, second.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	share, err := service.CreateShare(context.Background(), CreateShareInput{ActorID: "usr-owner", CollectionID: source.ID})
	if err != nil {
		t.Fatal(err)
	}
	asCollection := true
	imported, err := service.ImportShare(context.Background(), ImportShareInput{
		ActorID: "usr-member", ShareID: share.ID, AsCollection: &asCollection, SubscribeToSourceChanges: true,
	})
	if err != nil || imported.Collection == nil || imported.Library == nil || len(imported.Items) != 2 {
		t.Fatalf("subscribed import = %#v, %v", imported, err)
	}
	if imported.Collection.SourceSubscription.Status != "synced" || !imported.Collection.SourceSubscription.Enabled || !imported.Collection.SourceSubscription.ReadOnly {
		t.Fatalf("subscription projection = %#v", imported.Collection.SourceSubscription)
	}
	if imported.Collection.SourceCollectionID == nil || *imported.Collection.SourceCollectionID != source.ID {
		t.Fatalf("subscription source = %#v", imported.Collection.SourceCollectionID)
	}
	if imported.Items[0].ID == first.ID || imported.Items[1].ID == second.ID {
		t.Fatal("subscription reused source emote identity")
	}

	state := repo.snapshot()
	subscription, ok := state.subscriptions[findSubscriptionID(state, imported.Collection.ID)]
	if !ok || subscription.Status != "active" || subscription.SourceRevision != state.collections[source.ID].Revision {
		t.Fatalf("subscription record = %#v, ok=%v", subscription, ok)
	}
	for _, importedItem := range imported.Items {
		row := state.emotes[importedItem.ID]
		if row.StorageObjectID == "" {
			t.Fatalf("subscription target lost CAS object: %#v", row)
		}
	}
	usage, err := service.GetLibrary(context.Background(), "usr-member")
	if err != nil {
		t.Fatal(err)
	}
	if usage.Usage.TotalBytes != 0 || usage.Usage.SubscribedItemCount != 2 || usage.Usage.SubscribedTotalBytes == 0 {
		t.Fatalf("active subscription usage = %#v", usage.Usage)
	}

	if _, err := service.Update(context.Background(), UpdateEmoteInput{ActorID: "usr-member", EmoteID: imported.Items[0].ID, Label: "local"}); !isCode(err, CodeEmoteSubscriptionReadOnly) {
		t.Fatalf("subscription emote update = %v", err)
	}
	if _, err := service.UpdateCollection(context.Background(), UpdateCollectionInput{ActorID: "usr-member", CollectionID: imported.Collection.ID, Name: "local"}); !isCode(err, CodeEmoteSubscriptionReadOnly) {
		t.Fatalf("subscription collection update = %v", err)
	}

	if _, err := service.Update(context.Background(), UpdateEmoteInput{ActorID: "usr-owner", EmoteID: first.ID, Label: "renamed"}); err != nil {
		t.Fatal(err)
	}
	memberLibrary, err := service.GetLibrary(context.Background(), "usr-member")
	if err != nil {
		t.Fatal(err)
	}
	memberCollection := findPublicCollection(memberLibrary.Collections, imported.Collection.ID)
	if memberCollection == nil || memberCollection.Items[0].Label != "renamed" {
		t.Fatalf("synced label collection = %#v", memberCollection)
	}

	// The fake repository is intentionally mutable for quota-boundary tests.
	repo.mu.Lock()
	for _, item := range imported.Items {
		row := repo.state.emotes[item.ID]
		if item.ID == imported.Items[0].ID {
			value := MaxTotalBytes
			row.ByteSize = &value
		} else {
			value := int64(0)
			row.ByteSize = &value
		}
		repo.state.emotes[item.ID] = row
	}
	repo.mu.Unlock()
	if err := service.UpdateCollectionSourceSubscription(context.Background(), "usr-member", imported.Collection.ID, false, auth.RequestMeta{}); err != nil {
		t.Fatalf("disable at exact quota = %v", err)
	}
	memberLibrary, err = service.GetLibrary(context.Background(), "usr-member")
	if err != nil {
		t.Fatal(err)
	}
	memberCollection = findPublicCollection(memberLibrary.Collections, imported.Collection.ID)
	if memberCollection == nil || memberCollection.SourceSubscription.Status != "off" || memberCollection.SourceSubscription.ReadOnly {
		t.Fatalf("disabled subscription = %#v", memberCollection)
	}
	if err := service.UpdateCollectionSourceSubscription(context.Background(), "usr-member", imported.Collection.ID, true, auth.RequestMeta{}); err != nil {
		t.Fatalf("re-enable subscription = %v", err)
	}
	repo.mu.Lock()
	row := repo.state.emotes[imported.Items[0].ID]
	value := MaxTotalBytes + 1
	row.ByteSize = &value
	repo.state.emotes[imported.Items[0].ID] = row
	repo.mu.Unlock()
	if err := service.UpdateCollectionSourceSubscription(context.Background(), "usr-member", imported.Collection.ID, false, auth.RequestMeta{}); !isCode(err, CodeEmoteStorageLimitReached) {
		t.Fatalf("disable over quota = %v", err)
	}
	state = repo.snapshot()
	subscriptionID := findSubscriptionID(state, imported.Collection.ID)
	if state.subscriptions[subscriptionID].Status != "active" {
		t.Fatalf("failed disable changed subscription = %#v", state.subscriptions[subscriptionID])
	}

	if _, err := service.RevokeShare(context.Background(), ShareInput{ActorID: "usr-owner", ShareID: share.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateCollection(context.Background(), UpdateCollectionInput{ActorID: "usr-owner", CollectionID: source.ID, Name: "Source v2"}); err != nil {
		t.Fatal(err)
	}
	memberLibrary, err = service.GetLibrary(context.Background(), "usr-member")
	if err != nil {
		t.Fatal(err)
	}
	memberCollection = findPublicCollection(memberLibrary.Collections, imported.Collection.ID)
	if memberCollection == nil || memberCollection.Name != "Source v2" {
		t.Fatalf("revoked share stopped active sync = %#v", memberCollection)
	}
	if _, err := service.DeleteCollection(context.Background(), DeleteCollectionInput{ActorID: "usr-owner", CollectionID: source.ID, Disposition: "keep"}); err != nil {
		t.Fatal(err)
	}
	memberLibrary, err = service.GetLibrary(context.Background(), "usr-member")
	if err != nil {
		t.Fatal(err)
	}
	memberCollection = findPublicCollection(memberLibrary.Collections, imported.Collection.ID)
	if memberCollection == nil || memberCollection.SourceSubscription.Status != "detached" || memberCollection.SourceSubscription.ReadOnly || len(memberCollection.Items) != 2 {
		t.Fatalf("detached snapshot = %#v", memberCollection)
	}
}

func findSubscriptionID(state fakeState, collectionID string) string {
	for id, subscription := range state.subscriptions {
		if subscription.CollectionID == collectionID {
			return id
		}
	}
	return ""
}

func findPublicCollection(collections []Collection, collectionID string) *Collection {
	for index := range collections {
		if collections[index].ID == collectionID {
			return &collections[index]
		}
	}
	return nil
}

func mustUpload(t *testing.T, service *Service, actorID, name, content string) *CustomEmote {
	t.Helper()
	emote, err := service.Upload(context.Background(), UploadInput{ActorID: actorID, Source: UploadSource{MIMEType: "image/png", FileName: name}, Content: strings.NewReader(content), AddToLibrary: true})
	if err != nil {
		t.Fatal(err)
	}
	return emote
}

func boolPointer(value bool) *bool { return &value }

func TestServiceRejectsNonMemberAndDoesNotReadContent(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	store := newFakeBlobStore()
	service := testService(t, repo, store)
	emote := mustUpload(t, service, "usr-owner", "secret.png", "secret")
	if _, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: "usr-unknown", EmoteID: emote.ID}); !isCode(err, CodeAuthRequired) {
		t.Fatalf("unknown actor = %v", err)
	}
	state := repo.snapshot()
	if len(state.audits) == 0 {
		t.Fatal("expected create audit")
	}
}

func TestServiceStoreProcessedRejectsDigestMismatchWithoutPersisting(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	service := testService(t, repo, newFakeBlobStore())
	_, err := service.StoreProcessed(context.Background(), StoreProcessedInput{ActorID: "usr-owner", Source: UploadSource{MIMEType: "image/png", FileName: "bad.png"}, Processed: ProcessedUpload{Content: []byte("content"), ByteSize: 7, Width: 1, Height: 1, FrameCount: 1, DetectedMIMEType: "image/png", NormalizedMIMEType: "image/webp", SHA256: strings.Repeat("0", 64)}})
	if !isCode(err, CodeEmoteProcessFailed) {
		t.Fatalf("digest mismatch = %v", err)
	}
	if got := len(repo.snapshot().emotes); got != 0 {
		t.Fatalf("persisted rejected emote count = %d", got)
	}
}

func TestServiceConcurrentSettingsUpdatesSerialize(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	service := testService(t, repo, newFakeBlobStore())
	ids := []string{"bili"}
	var wait sync.WaitGroup
	for index := 0; index < 10; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, _ = service.UpdateSettings(context.Background(), "usr-owner", UpdateSettingsInput{EnabledPackIDs: &ids}, auth.RequestMeta{})
		}()
	}
	wait.Wait()
	settings, err := service.GetSettings(context.Background(), "usr-owner")
	if err != nil || len(settings.EnabledPackIDs) != 1 || settings.EnabledPackIDs[0] != "bili" {
		t.Fatalf("concurrent settings = %#v, %v", settings, err)
	}
}

func TestServiceAutoHideSettingsDefaultsNormalizeAndPreserve(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	service := testService(t, repo, newFakeBlobStore())

	defaults, err := service.GetSettings(context.Background(), "usr-owner")
	if err != nil {
		t.Fatalf("default settings: %v", err)
	}
	if defaults.AutoHideMessages || strings.Join(defaults.AutoHideMessageTypes, ",") != "image,emote,long" {
		t.Fatalf("default auto-hide settings = %#v", defaults)
	}

	enabled := true
	duplicateTypes := []string{"image", "image", "long"}
	updated, err := service.UpdateSettings(context.Background(), "usr-owner", UpdateSettingsInput{
		AutoHideMessages:     &enabled,
		AutoHideMessageTypes: &duplicateTypes,
	}, auth.RequestMeta{})
	if err != nil || !updated.AutoHideMessages || strings.Join(updated.AutoHideMessageTypes, ",") != "image,long" {
		t.Fatalf("normalized auto-hide settings = %#v, %v", updated, err)
	}

	emptyTypes := []string{}
	updated, err = service.UpdateSettings(context.Background(), "usr-owner", UpdateSettingsInput{AutoHideMessageTypes: &emptyTypes}, auth.RequestMeta{})
	if err != nil || !updated.AutoHideMessages || updated.AutoHideMessageTypes == nil || len(updated.AutoHideMessageTypes) != 0 {
		t.Fatalf("empty auto-hide types = %#v, %v", updated, err)
	}

	disabled := false
	updated, err = service.UpdateSettings(context.Background(), "usr-owner", UpdateSettingsInput{AutoHideMessages: &disabled}, auth.RequestMeta{})
	if err != nil || updated.AutoHideMessages || updated.AutoHideMessageTypes == nil || len(updated.AutoHideMessageTypes) != 0 {
		t.Fatalf("disabled auto-hide settings = %#v, %v", updated, err)
	}

	invalidTypes := []string{"image", "video"}
	if _, err := service.UpdateSettings(context.Background(), "usr-owner", UpdateSettingsInput{AutoHideMessageTypes: &invalidTypes}, auth.RequestMeta{}); !isCode(err, CodeEmoteInvalidSettings) {
		t.Fatalf("invalid auto-hide types = %v", err)
	}
	invalidState, err := service.GetSettings(context.Background(), "usr-owner")
	if err != nil || invalidState.AutoHideMessages || len(invalidState.AutoHideMessageTypes) != 0 {
		t.Fatalf("state after rejected auto-hide types = %#v, %v", invalidState, err)
	}
}

func TestServiceConcurrentAutoHideFirstInsertPreservesPartialUpdates(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	service := testService(t, repo, newFakeBlobStore())
	enabled := true
	types := []string{"image"}
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		_, _ = service.UpdateSettings(context.Background(), "usr-owner", UpdateSettingsInput{AutoHideMessages: &enabled}, auth.RequestMeta{})
	}()
	go func() {
		defer wait.Done()
		_, _ = service.UpdateSettings(context.Background(), "usr-owner", UpdateSettingsInput{AutoHideMessageTypes: &types}, auth.RequestMeta{})
	}()
	wait.Wait()

	settings, err := service.GetSettings(context.Background(), "usr-owner")
	if err != nil || !settings.AutoHideMessages || strings.Join(settings.AutoHideMessageTypes, ",") != "image" {
		t.Fatalf("concurrent first insert settings = %#v, %v", settings, err)
	}
}

func TestCatalogPublicProjectionDoesNotReturnHiddenPack(t *testing.T) {
	catalog := testCatalog(t)
	if catalog.Public("douyin:hidden") != nil {
		t.Fatal("hidden built-in was projected")
	}
	if item, ok := catalog.Image("bili:doge"); !ok || item.Token == "" {
		t.Fatalf("image lookup = %#v, %v", item, ok)
	}
}

func TestCanonicalDigestMatchesContent(t *testing.T) {
	content := []byte("digest")
	hash := sha256.Sum256(content)
	if got := canonicalDigest(content); got != hex.EncodeToString(hash[:]) {
		t.Fatalf("digest = %q", got)
	}
}

func TestLoadCatalogRejectsDuplicateIDs(t *testing.T) {
	_, err := NewCatalog([]CatalogPack{{ID: "pack", Label: "Pack", Items: []CatalogItem{{ID: "same", Kind: "unicode", Label: "a", Value: "a"}, {ID: "same", Kind: "unicode", Label: "b", Value: "b"}}}})
	if err == nil {
		t.Fatal("duplicate catalog item accepted")
	}
}

func TestPublicSlicesAreNonNil(t *testing.T) {
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-owner", "owner")
	service := testService(t, repo, newFakeBlobStore())
	library, err := service.GetLibrary(context.Background(), "usr-owner")
	if err != nil {
		t.Fatal(err)
	}
	if library.Entries == nil || library.Emotes == nil || library.Collections == nil {
		t.Fatalf("nil public slices = %#v", library)
	}
}

func TestErrorPublicOmitsCause(t *testing.T) {
	err := internalError("secret operation", errors.New("secret detail"))
	public := err.Public()
	if public.Cause != nil || public.Code != CodeInternal || public.Message != MessageInternal {
		t.Fatalf("public error = %#v", public)
	}
}

func TestStorageObjectKeyIsCanonical(t *testing.T) {
	digest := strings.Repeat("a", 64)
	key, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil || !strings.HasSuffix(key, digest) {
		t.Fatalf("canonical key = %q, %v", key, err)
	}
}

func TestPreflightHonorsContext(t *testing.T) {
	service := NewService(ServiceOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := service.PreflightUpload(ctx, UploadSource{MIMEType: "image/png", FileName: "a.png"}, strings.NewReader("x"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled preflight = %v", err)
	}
}

func TestCatalogFilePathExists(t *testing.T) {
	_, sourceFile, _, _ := runtime.Caller(0)
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/shared/emote-packs.json"))
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}
