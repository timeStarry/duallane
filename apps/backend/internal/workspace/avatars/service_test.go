package avatars

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/media"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestServiceSetRemoveAndDeduplicatesReferences(t *testing.T) {
	content := []byte("normalized-avatar")
	repo := newAvatarFakeRepository(
		&auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner", AvatarURL: "https://github/avatar"},
		&auth.Actor{ID: "usr_member", GitHubLogin: "member", DisplayName: "Member", Kind: "human", Role: "member"},
	)
	store := newAvatarFakeBlobStore()
	processor := &avatarFakeProcessor{content: content}
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	service := NewService(ServiceOptions{
		Repository: repo, BlobStore: store, Processor: processor,
		Now:       func() time.Time { return now },
		IDFactory: sequentialAvatarIDFactory("avatar-version-1", "avatar-event-1", "avatar-audit-1", "avatar-version-2", "avatar-event-2", "avatar-audit-2", "avatar-event-3", "avatar-audit-3", "avatar-event-4", "avatar-audit-4"),
	})

	first, err := service.SetOwnAvatar(context.Background(), SetOwnAvatarInput{
		ActorID: "usr_owner", MIMEType: "image/png", Content: []byte("source"),
		Meta: auth.RequestMeta{RequestID: "avatar-set-owner"},
	})
	if err != nil {
		t.Fatalf("set owner avatar: %v", err)
	}
	if first.User == nil || first.User.AvatarURL != "/api/workspace/avatars/usr_owner/avatar-version-1" {
		t.Fatalf("set result = %#v", first.User)
	}
	ownerRecord := repo.avatar("usr_owner")
	if ownerRecord.StorageObjectID == "" || len(store.objects) != 1 {
		t.Fatalf("owner record/object = %#v/%d", ownerRecord, len(store.objects))
	}
	objectID := ownerRecord.StorageObjectID
	objectKey := repo.state.objects[objectID].ObjectKey

	second, err := service.SetOwnAvatar(context.Background(), SetOwnAvatarInput{
		ActorID: "usr_member", MIMEType: "image/png", Content: []byte("source"),
		Meta: auth.RequestMeta{RequestID: "avatar-set-member"},
	})
	if err != nil {
		t.Fatalf("set member avatar: %v", err)
	}
	if second.User == nil || repo.avatar("usr_member").StorageObjectID != objectID || len(store.objects) != 1 {
		t.Fatalf("deduplicated state = %#v/%#v objects=%d", second.User, repo.avatar("usr_member"), len(store.objects))
	}

	if _, err := service.RemoveOwnAvatar(context.Background(), RemoveOwnAvatarInput{
		ActorID: "usr_owner", Meta: auth.RequestMeta{RequestID: "avatar-remove-owner"},
	}); err != nil {
		t.Fatalf("remove owner avatar: %v", err)
	}
	if _, ok := store.objects[objectKey]; !ok {
		t.Fatalf("shared object was deleted while member still referenced it: owner=%#v member=%#v objects=%#v", repo.avatar("usr_owner"), repo.avatar("usr_member"), repo.state.objects)
	}
	if _, err := service.RemoveOwnAvatar(context.Background(), RemoveOwnAvatarInput{
		ActorID: "usr_member", Meta: auth.RequestMeta{RequestID: "avatar-remove-member"},
	}); err != nil {
		t.Fatalf("remove member avatar: %v", err)
	}
	if len(store.objects) != 0 {
		t.Fatalf("last reference did not delete object: %v", store.objects)
	}

	if len(repo.state.events) != 4 || len(repo.state.audits) != 4 {
		t.Fatalf("evidence counts events=%d audits=%d", len(repo.state.events), len(repo.state.audits))
	}
	for _, audit := range repo.state.audits {
		if audit.TargetID == "" || audit.RequestID == "" || audit.Reason != "" {
			t.Fatalf("unsafe avatar audit = %#v", audit)
		}
	}
}

func TestServiceCleanupDeleteFailureLeavesObjectRetryable(t *testing.T) {
	repo := newAvatarFakeRepository(&auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"})
	store := newAvatarFakeBlobStore()
	service := NewService(ServiceOptions{
		Repository: repo,
		BlobStore:  store,
		Processor:  &avatarFakeProcessor{content: []byte("normalized-avatar")},
	})
	setResult, err := service.SetOwnAvatar(context.Background(), SetOwnAvatarInput{
		ActorID: "usr_owner", MIMEType: "image/png", Content: []byte("source"),
	})
	if err != nil {
		t.Fatalf("set avatar: %v", err)
	}
	objectID := setResult.PreviousStorageObjectID
	if objectID != "" {
		t.Fatalf("new avatar unexpectedly returned previous object %q", objectID)
	}
	avatar := repo.avatar("usr_owner")
	objectID = avatar.StorageObjectID
	object := repo.state.objects[objectID]
	store.deleteErr = errors.New("temporary physical delete failure")
	removed, err := service.RemoveOwnAvatar(context.Background(), RemoveOwnAvatarInput{ActorID: "usr_owner"})
	if err != nil {
		t.Fatalf("remove avatar with retryable cleanup failure: %v", err)
	}
	if removed.PreviousStorageObjectID != objectID {
		t.Fatalf("removed object id = %q, want %q", removed.PreviousStorageObjectID, objectID)
	}
	if repo.state.objects[objectID].DeletedAt != nil {
		t.Fatal("failed physical delete committed a storage tombstone")
	}
	if _, ok := store.objects[object.ObjectKey]; !ok {
		t.Fatal("failed physical delete removed bytes before the retry")
	}

	store.deleteErr = nil
	if err := service.cleanupObject(context.Background(), objectID, object); err != nil {
		t.Fatalf("retry cleanup: %v", err)
	}
	if repo.state.objects[objectID].DeletedAt == nil {
		t.Fatal("successful retry did not commit a storage tombstone")
	}
	if _, ok := store.objects[object.ObjectKey]; ok {
		t.Fatal("successful retry did not delete physical bytes")
	}
}

func TestServiceRejectsOversizedInputBeforeProcessingOrStorage(t *testing.T) {
	repo := newAvatarFakeRepository(&auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"})
	store := newAvatarFakeBlobStore()
	processor := &avatarFakeProcessor{content: []byte("normalized")}
	service := NewService(ServiceOptions{Repository: repo, BlobStore: store, Processor: processor})

	_, err := service.SetOwnAvatar(context.Background(), SetOwnAvatarInput{
		ActorID: "usr_owner", MIMEType: "image/png", Content: bytes.Repeat([]byte("x"), int(AvatarMaxInputBytes)+1),
	})
	if !isAvatarCode(err, CodeAvatarInvalidSize) {
		t.Fatalf("oversized input error = %v", err)
	}
	if processor.calls != 0 || len(store.objects) != 0 || len(repo.state.audits) != 0 {
		t.Fatalf("oversized input crossed boundary: processor=%d objects=%d audits=%d", processor.calls, len(store.objects), len(repo.state.audits))
	}
}

func TestServiceRejectsOversizedProcessedOutputBeforeStorage(t *testing.T) {
	repo := newAvatarFakeRepository(&auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"})
	store := newAvatarFakeBlobStore()
	service := NewService(ServiceOptions{
		Repository: repo,
		BlobStore:  store,
		Processor:  &avatarFakeProcessor{content: bytes.Repeat([]byte("x"), int(AvatarMaxOutputBytes)+1)},
	})
	_, err := service.SetOwnAvatar(context.Background(), SetOwnAvatarInput{
		ActorID: "usr_owner", MIMEType: "image/png", Content: []byte("source"),
	})
	if !isAvatarCode(err, CodeAvatarProcessingFailed) {
		t.Fatalf("oversized processed output error = %v", err)
	}
	if len(store.objects) != 0 || len(repo.state.audits) != 0 {
		t.Fatalf("oversized processed output crossed storage boundary: objects=%d audits=%d", len(store.objects), len(repo.state.audits))
	}
}

func TestServiceUsesLegacyReadWhenCanonicalObjectIsMissing(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	repo := newAvatarFakeRepository(&auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"})
	repo.state.avatars["usr_owner"] = AvatarRecord{
		UserID: "usr_owner", Version: "legacy-version", StorageKey: "profile-avatars/usr_owner/legacy-version.webp",
		AvatarURL: "/api/workspace/avatars/usr_owner/legacy-version",
	}
	legacy := &avatarFakeLegacyReader{key: repo.state.avatars["usr_owner"].StorageKey, content: []byte("legacy-webp")}
	service := NewService(ServiceOptions{Repository: repo, LegacyReader: legacy, Now: func() time.Time { return now }})

	opened, err := service.OpenProfileAvatar(context.Background(), GetProfileAvatarInput{
		ActorID: "usr_owner", UserID: "usr_owner", Version: "legacy-version",
	}, AvatarMaxOutputBytes*2)
	if err != nil {
		t.Fatalf("open legacy avatar: %v", err)
	}
	defer opened.Body.Close()
	content, err := io.ReadAll(opened.Body)
	if err != nil || string(content) != "legacy-webp" || legacy.calls != 1 || legacy.maxBytes != AvatarMaxOutputBytes {
		t.Fatalf("legacy read content=%q err=%v calls=%d max=%d", content, err, legacy.calls, legacy.maxBytes)
	}
	if opened.ContentType != AvatarContentType {
		t.Fatalf("legacy content type = %q", opened.ContentType)
	}
}

func TestServiceDoesNotFallbackOnCanonicalStorageFailure(t *testing.T) {
	repo := newAvatarFakeRepository(&auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"})
	repo.state.avatars["usr_owner"] = AvatarRecord{
		UserID: "usr_owner", Version: "canonical-version", StorageKey: "profile-avatars/usr_owner/canonical-version.webp",
		StorageObjectID: "wso_canonical", AvatarURL: "/api/workspace/avatars/usr_owner/canonical-version",
	}
	repo.state.objects["wso_canonical"] = StorageObjectRecord{
		ID: "wso_canonical", SHA256: strings.Repeat("a", 64), ObjectKey: "workspace/objects/sha256/aa/" + strings.Repeat("a", 64),
		ByteSize: 12, ContentType: AvatarContentType, CreatedAt: time.Now().UTC(),
	}
	store := newAvatarFakeBlobStore()
	store.openErr = &platformstorage.Error{Code: "file.storage_mismatch", Message: "mismatch", StatusCode: 500}
	legacy := &avatarFakeLegacyReader{key: repo.state.avatars["usr_owner"].StorageKey, content: []byte("legacy-webp")}
	service := NewService(ServiceOptions{Repository: repo, BlobStore: store, LegacyReader: legacy})

	_, err := service.OpenProfileAvatar(context.Background(), GetProfileAvatarInput{
		ActorID: "usr_owner", UserID: "usr_owner", Version: "canonical-version",
	}, AvatarMaxOutputBytes)
	if !isAvatarCode(err, CodeAvatarStorageFailed) || legacy.calls != 0 {
		t.Fatalf("canonical storage failure error=%v legacy calls=%d", err, legacy.calls)
	}
}

func TestServiceRejectsLegacyKeyOutsideAuthorizedAvatarNamespace(t *testing.T) {
	repo := newAvatarFakeRepository(&auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"})
	repo.state.avatars["usr_owner"] = AvatarRecord{
		UserID: "usr_owner", Version: "legacy-version", StorageKey: "profile-avatars/usr_other/legacy-version.webp",
		AvatarURL: "/api/workspace/avatars/usr_owner/legacy-version",
	}
	legacy := &avatarFakeLegacyReader{key: repo.state.avatars["usr_owner"].StorageKey, content: []byte("legacy-webp")}
	service := NewService(ServiceOptions{Repository: repo, LegacyReader: legacy})

	_, err := service.OpenProfileAvatar(context.Background(), GetProfileAvatarInput{
		ActorID: "usr_owner", UserID: "usr_owner", Version: "legacy-version",
	}, AvatarMaxOutputBytes)
	if !isAvatarCode(err, CodeAvatarNotFound) || legacy.calls != 0 {
		t.Fatalf("unauthorized legacy key error=%v calls=%d", err, legacy.calls)
	}
}

func TestServiceHidesUndiscoverableAvatarFromUnrelatedMember(t *testing.T) {
	repo := newAvatarFakeRepository(
		&auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"},
		&auth.Actor{ID: "usr_member", Kind: "human", Role: "member"},
		&auth.Actor{ID: "usr_viewer", Kind: "human", Role: "member"},
	)
	repo.state.avatars["usr_member"] = AvatarRecord{
		UserID: "usr_member", Version: "version-1", StorageKey: "profile-avatars/usr_member/version-1.webp",
		AvatarURL: "/api/workspace/avatars/usr_member/version-1", SearchDiscoverable: false,
	}
	service := NewService(ServiceOptions{Repository: repo})
	_, err := service.GetProfileAvatar(context.Background(), GetProfileAvatarInput{
		ActorID: "usr_viewer", UserID: "usr_member", Version: "version-1",
	})
	if !isAvatarCode(err, CodeAvatarNotFound) {
		t.Fatalf("hidden avatar error = %v", err)
	}
	record := repo.state.avatars["usr_member"]
	record.SearchDiscoverable = true
	repo.state.avatars["usr_member"] = record
	if _, err := service.GetProfileAvatar(context.Background(), GetProfileAvatarInput{
		ActorID: "usr_viewer", UserID: "usr_member", Version: "version-1",
	}); err != nil {
		t.Fatalf("discoverable avatar: %v", err)
	}
}

type avatarFakeProcessor struct {
	content []byte
	calls   int
	err     error
}

func (p *avatarFakeProcessor) Process(_ context.Context, _ []byte, _ media.Source) (media.ProcessedUpload, error) {
	p.calls++
	if p.err != nil {
		return media.ProcessedUpload{}, p.err
	}
	digest := sha256.Sum256(p.content)
	return media.ProcessedUpload{
		Content: append([]byte(nil), p.content...), ByteSize: int64(len(p.content)), Width: AvatarOutputSize,
		Height: AvatarOutputSize, FrameCount: 1, NormalizedMIMEType: AvatarContentType,
		SHA256: hex.EncodeToString(digest[:]),
	}, nil
}

type avatarFakeBlobStore struct {
	mu        sync.Mutex
	objects   map[string][]byte
	openErr   error
	deleteErr error
}

func newAvatarFakeBlobStore() *avatarFakeBlobStore {
	return &avatarFakeBlobStore{objects: map[string][]byte{}}
}

func (s *avatarFakeBlobStore) Put(_ context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (platformstorage.StoredObject, error) {
	content, err := io.ReadAll(source)
	if err != nil {
		return platformstorage.StoredObject{}, err
	}
	if int64(len(content)) != expectedSize {
		return platformstorage.StoredObject{}, errors.New("size mismatch")
	}
	digest := sha256.Sum256(content)
	if hex.EncodeToString(digest[:]) != expectedSHA256 {
		return platformstorage.StoredObject{}, errors.New("digest mismatch")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, reused := s.objects[key]
	s.objects[key] = append([]byte(nil), content...)
	return platformstorage.StoredObject{Object: platformstorage.Object{Key: key, SHA256: expectedSHA256, ByteSize: expectedSize, ContentType: AvatarContentType}, Reused: reused}, nil
}

func (s *avatarFakeBlobStore) Open(_ context.Context, object platformstorage.Object, maxBytes int64) (platformstorage.OpenedObject, error) {
	if s.openErr != nil {
		return platformstorage.OpenedObject{}, s.openErr
	}
	s.mu.Lock()
	content, ok := s.objects[object.Key]
	s.mu.Unlock()
	if !ok {
		return platformstorage.OpenedObject{}, &platformstorage.Error{Code: "file.storage_missing", Message: "missing", StatusCode: 404}
	}
	if int64(len(content)) > maxBytes {
		return platformstorage.OpenedObject{}, errors.New("too large")
	}
	return platformstorage.OpenedObject{Object: platformstorage.Object{Key: object.Key, SHA256: object.SHA256, ByteSize: int64(len(content)), ContentType: AvatarContentType}, Body: io.NopCloser(bytes.NewReader(content))}, nil
}

func (s *avatarFakeBlobStore) Delete(_ context.Context, object platformstorage.Object) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.objects, object.Key)
	return nil
}

type avatarFakeLegacyReader struct {
	key      string
	content  []byte
	calls    int
	maxBytes int64
}

func (r *avatarFakeLegacyReader) OpenLegacy(_ context.Context, key string, maxBytes int64) (platformstorage.OpenedObject, error) {
	r.calls++
	r.maxBytes = maxBytes
	if key != r.key || int64(len(r.content)) > maxBytes {
		return platformstorage.OpenedObject{}, errors.New("legacy object unavailable")
	}
	return platformstorage.OpenedObject{Object: platformstorage.Object{Key: key, ByteSize: int64(len(r.content)), ContentType: AvatarContentType}, Body: io.NopCloser(bytes.NewReader(r.content))}, nil
}

type avatarFakeState struct {
	actors  map[string]*auth.Actor
	avatars map[string]AvatarRecord
	objects map[string]StorageObjectRecord
	events  []EventInput
	audits  []AuditInput
}

type avatarFakeRepository struct {
	mu    sync.Mutex
	state *avatarFakeState
}

func newAvatarFakeRepository(actors ...*auth.Actor) *avatarFakeRepository {
	state := &avatarFakeState{actors: map[string]*auth.Actor{}, avatars: map[string]AvatarRecord{}, objects: map[string]StorageObjectRecord{}}
	for _, actor := range actors {
		state.actors[actor.ID] = cloneAvatarActor(actor)
		state.avatars[actor.ID] = AvatarRecord{UserID: actor.ID, GitHubAvatarURL: actor.AvatarURL, AvatarURL: actor.AvatarURL, SearchDiscoverable: actor.SearchDiscoverable}
	}
	return &avatarFakeRepository{state: state}
}

func (r *avatarFakeRepository) LookupActor(_ context.Context, _ string, userID string) (*auth.Actor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneAvatarActor(r.state.actors[userID]), nil
}

func (r *avatarFakeRepository) GetCurrentAvatar(_ context.Context, _ string, userID string) (*AvatarRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.avatarLocked(userID), nil
}

func (r *avatarFakeRepository) FindVisibleAvatar(_ context.Context, _ string, viewerID, userID, version string) (*AvatarRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.avatarLocked(userID)
	if record == nil || record.Version != version || record.StorageKey == "" {
		return nil, nil
	}
	viewer := r.state.actors[viewerID]
	if viewer == nil || (viewerID != userID && viewer.Role != "owner" && !record.SearchDiscoverable) {
		return nil, nil
	}
	return record, nil
}

func (r *avatarFakeRepository) StorageObject(_ context.Context, objectID string) (*StorageObjectRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, ok := r.state.objects[objectID]
	if !ok || value.DeletedAt != nil {
		return nil, nil
	}
	return cloneStorageObject(&value), nil
}

func (r *avatarFakeRepository) StorageObjectReferenceCount(_ context.Context, objectID string) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.referenceCountLocked(objectID), nil
}

func (r *avatarFakeRepository) WithTx(_ context.Context, callback func(Tx) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	working := cloneAvatarState(r.state)
	if err := callback(&avatarFakeTx{state: working}); err != nil {
		return err
	}
	r.state = working
	return nil
}

func (r *avatarFakeRepository) avatar(userID string) AvatarRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	value := r.state.avatars[userID]
	return cloneAvatarRecord(&value)
}

func (r *avatarFakeRepository) avatarLocked(userID string) *AvatarRecord {
	value, ok := r.state.avatars[userID]
	if !ok {
		return nil
	}
	result := cloneAvatarRecord(&value)
	if result.StorageObjectID != "" {
		if object, ok := r.state.objects[result.StorageObjectID]; ok && object.DeletedAt == nil {
			result.StorageObject = cloneStorageObject(&object)
		}
	}
	return &result
}

func (r *avatarFakeRepository) referenceCountLocked(objectID string) int64 {
	var count int64
	for _, avatar := range r.state.avatars {
		if avatar.StorageObjectID == objectID {
			count++
		}
	}
	return count
}

type avatarFakeTx struct{ state *avatarFakeState }

func (t *avatarFakeTx) LookupActor(_ context.Context, _ string, userID string) (*auth.Actor, error) {
	return cloneAvatarActor(t.state.actors[userID]), nil
}

func (t *avatarFakeTx) GetCurrentAvatarForUpdate(_ context.Context, _ string, userID string) (*AvatarRecord, error) {
	value, ok := t.state.avatars[userID]
	if !ok {
		return nil, nil
	}
	result := cloneAvatarRecord(&value)
	return &result, nil
}

func (*avatarFakeTx) Lock(context.Context, string) error { return nil }

func (t *avatarFakeTx) EnsureStorageObjectAndBind(_ context.Context, _ string, _ string, object StorageObjectRecord) error {
	t.state.objects[object.ID] = *cloneStorageObject(&object)
	return nil
}

func (t *avatarFakeTx) UpdateAvatar(_ context.Context, _ string, userID, storageKey, version, avatarURL, storageObjectID string, _ time.Time) (bool, error) {
	record, ok := t.state.avatars[userID]
	if !ok {
		return false, nil
	}
	record.StorageKey, record.Version, record.AvatarURL, record.StorageObjectID = storageKey, version, avatarURL, storageObjectID
	t.state.avatars[userID] = record
	if actor := t.state.actors[userID]; actor != nil {
		actor.AvatarURL = avatarURL
	}
	return true, nil
}

func (t *avatarFakeTx) ClearAvatar(_ context.Context, _ string, userID string, _ time.Time) (bool, error) {
	record, ok := t.state.avatars[userID]
	if !ok {
		return false, nil
	}
	record.StorageKey, record.Version, record.AvatarURL, record.StorageObjectID = "", "", record.GitHubAvatarURL, ""
	t.state.avatars[userID] = record
	if actor := t.state.actors[userID]; actor != nil {
		actor.AvatarURL = record.GitHubAvatarURL
	}
	return true, nil
}

func (t *avatarFakeTx) PrepareStorageObjectCleanup(_ context.Context, objectID string, fallback StorageObjectRecord) (StorageCleanup, error) {
	object, ok := t.state.objects[objectID]
	if !ok {
		if fallback.ObjectKey == "" {
			return StorageCleanup{}, nil
		}
		return StorageCleanup{Object: &fallback, DeleteObject: true}, nil
	}
	if t.referenceCount(objectID) > 0 {
		return StorageCleanup{Object: cloneStorageObject(&object), References: t.referenceCount(objectID), Registered: true}, nil
	}
	return StorageCleanup{Object: cloneStorageObject(&object), DeleteObject: true, Registered: true}, nil
}

func (t *avatarFakeTx) MarkStorageObjectDeleted(_ context.Context, objectID string, at time.Time) error {
	object, ok := t.state.objects[objectID]
	if !ok {
		return errors.New("storage object is missing")
	}
	if t.referenceCount(objectID) > 0 {
		return errors.New("storage object is still referenced")
	}
	if object.DeletedAt == nil {
		object.DeletedAt = &at
		t.state.objects[objectID] = object
	}
	return nil
}

func (t *avatarFakeTx) WriteEvent(_ context.Context, input EventInput) error {
	t.state.events = append(t.state.events, input)
	return nil
}

func (t *avatarFakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	t.state.audits = append(t.state.audits, input)
	return nil
}

func (t *avatarFakeTx) referenceCount(objectID string) int64 {
	var count int64
	for _, avatar := range t.state.avatars {
		if avatar.StorageObjectID == objectID {
			count++
		}
	}
	return count
}

func sequentialAvatarIDFactory(values ...string) IDFactory {
	var index int
	return func() (string, error) {
		if index >= len(values) {
			return "", errors.New("id sequence exhausted")
		}
		value := values[index]
		index++
		return value, nil
	}
}

func cloneAvatarState(source *avatarFakeState) *avatarFakeState {
	result := &avatarFakeState{actors: map[string]*auth.Actor{}, avatars: map[string]AvatarRecord{}, objects: map[string]StorageObjectRecord{}, events: append([]EventInput(nil), source.events...), audits: append([]AuditInput(nil), source.audits...)}
	for id, actor := range source.actors {
		result.actors[id] = cloneAvatarActor(actor)
	}
	for id, avatar := range source.avatars {
		result.avatars[id] = cloneAvatarRecord(&avatar)
	}
	for id, object := range source.objects {
		result.objects[id] = *cloneStorageObject(&object)
	}
	return result
}

func cloneAvatarActor(actor *auth.Actor) *auth.Actor {
	if actor == nil {
		return nil
	}
	value := *actor
	return &value
}

func cloneAvatarRecord(record *AvatarRecord) AvatarRecord {
	if record == nil {
		return AvatarRecord{}
	}
	value := *record
	value.StorageObject = cloneStorageObject(record.StorageObject)
	return value
}

func cloneStorageObject(object *StorageObjectRecord) *StorageObjectRecord {
	if object == nil {
		return nil
	}
	value := *object
	if object.VerifiedAt != nil {
		verified := *object.VerifiedAt
		value.VerifiedAt = &verified
	}
	if object.DeletedAt != nil {
		deleted := *object.DeletedAt
		value.DeletedAt = &deleted
	}
	return &value
}

func isAvatarCode(err error, code string) bool {
	var value *Error
	return errors.As(err, &value) && value != nil && value.Code == code
}
