package avatars

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/platform/media"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type Clock func() time.Time
type IDFactory func() (string, error)

const avatarStorageIOTimeout = 15 * time.Second

func avatarStorageContext(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(context.WithoutCancel(parent), avatarStorageIOTimeout)
}

// MediaProcessor is the only image-processing seam the avatar domain needs.
// The concrete platform/media.Processor satisfies it directly.
type MediaProcessor interface {
	Process(context.Context, []byte, media.Source) (media.ProcessedUpload, error)
}

// LegacyObjectReader is the compatibility-only read seam for avatars that
// predate the content-addressed registry. The adapter must authorize the
// already-checked logical avatar key, bound the returned object to maxBytes,
// and validate the physical bytes before returning them. New writes never use
// this seam.
type LegacyObjectReader interface {
	OpenLegacy(context.Context, string, int64) (platformstorage.OpenedObject, error)
}

type ServiceOptions struct {
	Repository   Repository
	BlobStore    platformstorage.BlobStore
	LegacyReader LegacyObjectReader
	Processor    MediaProcessor
	SpaceID      string
	Now          Clock
	IDFactory    IDFactory
}

type Service struct {
	repo         Repository
	blobStore    platformstorage.BlobStore
	legacyReader LegacyObjectReader
	processor    MediaProcessor
	spaceID      string
	now          Clock
	idFactory    IDFactory
}

var avatarVersionPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,128}$`)

var defaultAvatarIDFactory = func() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

func NewService(options ServiceOptions) *Service {
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	idFactory := options.IDFactory
	if idFactory == nil {
		idFactory = defaultAvatarIDFactory
	}
	return &Service{
		repo:         options.Repository,
		blobStore:    options.BlobStore,
		legacyReader: options.LegacyReader,
		processor:    options.Processor,
		spaceID:      spaceID,
		now:          now,
		idFactory:    idFactory,
	}
}

func NewServiceForRepository(repo Repository, blobStore platformstorage.BlobStore, processor MediaProcessor) *Service {
	return NewService(ServiceOptions{Repository: repo, BlobStore: blobStore, Processor: processor})
}

func (s *Service) Repository() Repository {
	if s == nil {
		return nil
	}
	return s.repo
}

func (s *Service) BlobStore() platformstorage.BlobStore {
	if s == nil {
		return nil
	}
	return s.blobStore
}

func (s *Service) space() string {
	if s == nil || strings.TrimSpace(s.spaceID) == "" {
		return DefaultSpaceID
	}
	return s.spaceID
}

func (s *Service) nowUTC() time.Time {
	now := time.Now()
	if s != nil && s.now != nil {
		now = s.now()
	}
	if now.IsZero() {
		now = time.Unix(0, 0)
	}
	return now.UTC().Truncate(time.Millisecond)
}

func (s *Service) newID(operation string) (string, error) {
	if s == nil || s.idFactory == nil {
		return "", errors.New(operation + " id factory is required")
	}
	id, err := s.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return id, nil
}

// SetOwnAvatar processes one avatar outside the transaction, then acquires
// the user/object locks before ensuring physical bytes and binding the
// content-addressed registry row. The bounded storage operation intentionally
// runs while the object advisory lock is held so cleanup cannot race it.
func (s *Service) SetOwnAvatar(ctx context.Context, input SetOwnAvatarInput) (AvatarMutationResult, error) {
	if s == nil || s.repo == nil {
		return AvatarMutationResult{}, internalError("set workspace avatar", errors.New("repository is required"))
	}
	actorID := strings.TrimSpace(input.ActorID)
	if _, err := s.readActor(ctx, actorID); err != nil {
		return AvatarMutationResult{}, err
	}
	if err := validateAvatarInput(input.MIMEType, input.Content); err != nil {
		return AvatarMutationResult{}, err
	}
	if s.processor == nil {
		return AvatarMutationResult{}, NewError(CodeAvatarProcessingUnavailable, MessageAvatarProcessingUnavailable, 503)
	}

	processed, err := s.processor.Process(ctx, append([]byte(nil), input.Content...), media.Source{
		Kind:     media.KindAvatar,
		MIMEType: input.MIMEType,
	})
	if err != nil {
		return AvatarMutationResult{}, normalizeMediaError(err)
	}
	if err := validateProcessedAvatar(processed); err != nil {
		return AvatarMutationResult{}, err
	}

	version, err := s.newID("workspace avatar version")
	if err != nil {
		return AvatarMutationResult{}, internalError("generate workspace avatar version", err)
	}
	if !avatarVersionPattern.MatchString(version) {
		return AvatarMutationResult{}, internalError("generate workspace avatar version", errors.New("version is invalid"))
	}
	digest := strings.ToLower(processed.SHA256)
	objectKey, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		return AvatarMutationResult{}, internalError("build workspace avatar object key", err)
	}
	now := s.nowUTC()
	verifiedAt := now
	object := StorageObjectRecord{
		ID:          "wso_" + digest,
		SHA256:      digest,
		ObjectKey:   objectKey,
		ByteSize:    int64(len(processed.Content)),
		ContentType: AvatarContentType,
		CreatedAt:   now,
		VerifiedAt:  &verifiedAt,
	}
	storageKey := fmt.Sprintf("profile-avatars/%s/%s.webp", actorID, version)
	var result AvatarMutationResult
	var previous AvatarRecord
	ctx, cancelMutation := context.WithTimeout(ctx, avatarStorageIOTimeout)
	defer cancelMutation()
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return internalError("set workspace avatar", errors.New("transaction is required"))
		}
		if err := tx.Lock(ctx, avatarResourceLock(actorID)); err != nil {
			return normalizeRepositoryError(err)
		}
		current, err := tx.GetCurrentAvatarForUpdate(ctx, s.space(), actorID)
		if err != nil {
			return normalizeRepositoryError(err)
		}
		if current == nil {
			return authRequiredError()
		}
		previous = *current
		if err := lockObjectIDs(ctx, tx, previous.StorageObjectID, object.ID); err != nil {
			return err
		}
		storageCtx, cancelStorage := context.WithTimeout(ctx, avatarStorageIOTimeout)
		defer cancelStorage()
		if err := s.putObject(storageCtx, object, processed.Content); err != nil {
			return err
		}
		if err := tx.EnsureStorageObjectAndBind(ctx, s.space(), actorID, object); err != nil {
			return normalizeRepositoryError(err)
		}
		updated, err := tx.UpdateAvatar(ctx, s.space(), actorID, storageKey, version,
			fmt.Sprintf("/api/workspace/avatars/%s/%s", actorID, version), object.ID, now)
		if err != nil {
			return normalizeRepositoryError(err)
		}
		if !updated {
			return authRequiredError()
		}
		updatedActor, err := s.lookupActor(ctx, tx, actorID)
		if err != nil {
			return err
		}
		if err := s.writeMemberUpdatedEvent(ctx, tx, updatedActor, now); err != nil {
			return err
		}
		if err := s.writeAudit(ctx, tx, updatedActor, input.Meta, AuditInput{
			Action:     "profile.avatar_update",
			TargetType: "user",
			TargetID:   actorID,
			Result:     "success",
		}, now); err != nil {
			return err
		}
		result.User = updatedActor
		return nil
	})
	if err != nil {
		cleanupErr := s.cleanupObject(ctx, object.ID, object)
		if cleanupErr != nil {
			return AvatarMutationResult{}, errors.Join(normalizeRepositoryError(err), cleanupErr)
		}
		return AvatarMutationResult{}, normalizeRepositoryError(err)
	}

	result.PreviousStorageKey = previous.StorageKey
	result.PreviousStorageObjectID = previous.StorageObjectID
	s.cleanupPrevious(ctx, previous, object.ID, storageKey)
	return result, nil
}

// RemoveOwnAvatar clears the logical avatar and restores the GitHub avatar
// URL in the same transaction as the event and audit records.
func (s *Service) RemoveOwnAvatar(ctx context.Context, input RemoveOwnAvatarInput) (AvatarMutationResult, error) {
	if s == nil || s.repo == nil {
		return AvatarMutationResult{}, internalError("remove workspace avatar", errors.New("repository is required"))
	}
	actorID := strings.TrimSpace(input.ActorID)
	if _, err := s.readActor(ctx, actorID); err != nil {
		return AvatarMutationResult{}, err
	}
	now := s.nowUTC()
	var result AvatarMutationResult
	var previous AvatarRecord
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return internalError("remove workspace avatar", errors.New("transaction is required"))
		}
		if err := tx.Lock(ctx, avatarResourceLock(actorID)); err != nil {
			return normalizeRepositoryError(err)
		}
		current, err := tx.GetCurrentAvatarForUpdate(ctx, s.space(), actorID)
		if err != nil {
			return normalizeRepositoryError(err)
		}
		if current == nil {
			return authRequiredError()
		}
		previous = *current
		if err := lockObjectIDs(ctx, tx, previous.StorageObjectID); err != nil {
			return err
		}
		actor, err := s.lookupActor(ctx, tx, actorID)
		if err != nil {
			return err
		}
		updated, err := tx.ClearAvatar(ctx, s.space(), actorID, now)
		if err != nil {
			return normalizeRepositoryError(err)
		}
		if !updated {
			return authRequiredError()
		}
		updatedActor, err := s.lookupActor(ctx, tx, actorID)
		if err != nil {
			return err
		}
		if err := s.writeMemberUpdatedEvent(ctx, tx, updatedActor, now); err != nil {
			return err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{
			Action:     "profile.avatar_remove",
			TargetType: "user",
			TargetID:   actorID,
			Result:     "success",
		}, now); err != nil {
			return err
		}
		result.User = updatedActor
		return nil
	})
	if err != nil {
		return AvatarMutationResult{}, normalizeRepositoryError(err)
	}
	result.PreviousStorageKey = previous.StorageKey
	result.PreviousStorageObjectID = previous.StorageObjectID
	s.cleanupPrevious(ctx, previous, "", "")
	return result, nil
}

// GetProfileAvatar applies the same active-membership and visibility rules as
// the current Node service. Storage metadata is returned only to the internal
// delivery boundary; callers must not serialize StorageKey or object fields.
func (s *Service) GetProfileAvatar(ctx context.Context, input GetProfileAvatarInput) (AvatarRecord, error) {
	if s == nil || s.repo == nil {
		return AvatarRecord{}, internalError("get workspace avatar", errors.New("repository is required"))
	}
	viewerID := strings.TrimSpace(input.ActorID)
	if _, err := s.readActor(ctx, viewerID); err != nil {
		return AvatarRecord{}, err
	}
	userID := strings.TrimSpace(input.UserID)
	version := strings.TrimSpace(input.Version)
	if userID == "" || !avatarVersionPattern.MatchString(version) {
		return AvatarRecord{}, avatarNotFoundError()
	}
	record, err := s.repo.FindVisibleAvatar(ctx, s.space(), viewerID, userID, version)
	if err != nil {
		return AvatarRecord{}, normalizeRepositoryError(err)
	}
	if record == nil {
		return AvatarRecord{}, avatarNotFoundError()
	}
	return *record, nil
}

// OpenProfileAvatar is the bounded delivery seam for a future HTTP adapter.
// It opens a verified canonical object first, then falls back to the legacy
// reader only when that canonical object is missing. Authorization always
// happens before either physical read.
func (s *Service) OpenProfileAvatar(ctx context.Context, input GetProfileAvatarInput, maxBytes int64) (platformstorage.OpenedObject, error) {
	record, err := s.GetProfileAvatar(ctx, input)
	if err != nil {
		return platformstorage.OpenedObject{}, err
	}
	if maxBytes <= 0 || maxBytes > AvatarMaxOutputBytes {
		maxBytes = AvatarMaxOutputBytes
	}
	if record.StorageObject != nil && record.StorageObject.DeletedAt == nil {
		if s.blobStore == nil {
			return platformstorage.OpenedObject{}, NewError(CodeAvatarStorageFailed, MessageAvatarStorageFailed, 500)
		}
		opened, err := s.blobStore.Open(ctx, record.StorageObject.BlobObject(), maxBytes)
		if err == nil {
			return validateOpenedAvatar(opened)
		}
		if !isMissingObjectError(err) {
			return platformstorage.OpenedObject{}, normalizeOpenError(err)
		}
	}
	legacyKey := strings.TrimSpace(record.StorageKey)
	if legacyKey == "" || legacyKey != expectedLegacyAvatarStorageKey(record) || s.legacyReader == nil {
		return platformstorage.OpenedObject{}, avatarNotFoundError()
	}
	opened, err := s.legacyReader.OpenLegacy(ctx, legacyKey, maxBytes)
	if err != nil {
		return platformstorage.OpenedObject{}, normalizeOpenError(err)
	}
	return validateOpenedAvatar(opened)
}

func (s *Service) readActor(ctx context.Context, actorID string) (*auth.Actor, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("read workspace avatar actor", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	return s.lookupActor(ctx, s.repo, actorID)
}

func (s *Service) lookupActor(ctx context.Context, repo interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
}, actorID string) (*auth.Actor, error) {
	actor, err := repo.LookupActor(ctx, s.space(), actorID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if actor == nil || strings.TrimSpace(actor.ID) == "" || actor.ID != actorID || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	if actor.Kind != "" && actor.Kind != "human" {
		return nil, identityForbiddenError()
	}
	return actor, nil
}

func validateAvatarInput(mimeType string, content []byte) error {
	mimeType = strings.ToLower(strings.TrimSpace(mimeType))
	if mimeType != "image/jpeg" && mimeType != "image/png" && mimeType != "image/webp" {
		return NewError(CodeAvatarUnsupportedFormat, MessageAvatarUnsupportedFormat, 400)
	}
	if len(content) == 0 {
		return NewError(CodeAvatarInvalidSize, MessageAvatarSizeMismatch, 400)
	}
	if int64(len(content)) > AvatarMaxInputBytes {
		return NewError(CodeAvatarInvalidSize, MessageAvatarInvalidSize, 400)
	}
	return nil
}

func validateProcessedAvatar(processed media.ProcessedUpload) error {
	if len(processed.Content) == 0 || processed.ByteSize != int64(len(processed.Content)) {
		return internalError("validate processed workspace avatar", errors.New("processed byte size is invalid"))
	}
	if int64(len(processed.Content)) > AvatarMaxOutputBytes {
		return NewError(CodeAvatarProcessingFailed, MessageAvatarProcessingFailed, 500)
	}
	if processed.Width != AvatarOutputSize || processed.Height != AvatarOutputSize || processed.FrameCount != 1 || processed.NormalizedMIMEType != AvatarContentType {
		return internalError("validate processed workspace avatar", errors.New("processed image metadata is invalid"))
	}
	digest, err := platformstorage.NormalizeSHA256(processed.SHA256)
	if err != nil {
		return internalError("validate processed workspace avatar", err)
	}
	hash := sha256.Sum256(processed.Content)
	if digest != hex.EncodeToString(hash[:]) {
		return internalError("validate processed workspace avatar", errors.New("processed digest does not match content"))
	}
	return nil
}

func (s *Service) putObject(ctx context.Context, object StorageObjectRecord, content []byte) error {
	if s.blobStore == nil {
		return NewError(CodeAvatarStorageFailed, MessageAvatarStorageFailed, 500)
	}
	stored, err := s.blobStore.Put(ctx, object.ObjectKey, bytes.NewReader(content), object.ByteSize, object.SHA256)
	if err != nil {
		return normalizePutError(err)
	}
	if stored.Key != object.ObjectKey || stored.SHA256 != object.SHA256 || stored.ByteSize != object.ByteSize {
		// The canonical object may already serve another resource. Only the
		// outer, reference-checked cleanup may delete after this failure.
		return NewError(CodeAvatarStorageFailed, MessageAvatarStorageFailed, 500)
	}
	return nil
}

func (s *Service) writeMemberUpdatedEvent(ctx context.Context, tx Tx, actor *auth.Actor, now time.Time) error {
	id, err := s.newID("workspace avatar event")
	if err != nil {
		return internalError("generate workspace avatar event id", err)
	}
	payload, err := json.Marshal(map[string]string{"userId": actor.ID})
	if err != nil {
		return internalError("encode workspace avatar event", err)
	}
	if err := tx.WriteEvent(ctx, EventInput{
		ID:          id,
		SpaceID:     s.space(),
		Type:        "workspace.member_updated",
		ActorID:     actor.ID,
		TargetType:  "user",
		TargetID:    actor.ID,
		PayloadJSON: payload,
		CreatedAt:   now,
	}); err != nil {
		return internalError("write workspace avatar event", err)
	}
	return nil
}

func (s *Service) writeAudit(ctx context.Context, tx Tx, actor *auth.Actor, meta auth.RequestMeta, input AuditInput, now time.Time) error {
	id, err := s.newID("workspace avatar audit")
	if err != nil {
		return internalError("generate workspace avatar audit id", err)
	}
	safe := meta.Safe()
	input.ID = id
	input.SpaceID = s.space()
	input.ActorUserID = actor.ID
	input.ActorGitHubLogin = actor.GitHubLogin
	input.RequestID = safe.RequestID
	input.IPAddress = safe.IPAddress
	input.UserAgent = safe.UserAgent
	input.CreatedAt = now
	if input.Result == "" {
		input.Result = "success"
	}
	if err := tx.WriteAudit(ctx, input); err != nil {
		return internalError("write workspace avatar audit", err)
	}
	return nil
}

func lockObjectIDs(ctx context.Context, tx Tx, ids ...string) error {
	keys := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		key := storageObjectLock(id)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := tx.Lock(ctx, key); err != nil {
			return normalizeRepositoryError(err)
		}
	}
	return nil
}

func avatarResourceLock(userID string) string {
	return "workspace-avatar:" + userID
}

func expectedLegacyAvatarStorageKey(record AvatarRecord) string {
	if strings.TrimSpace(record.UserID) == "" || !avatarVersionPattern.MatchString(record.Version) {
		return ""
	}
	return fmt.Sprintf("profile-avatars/%s/%s.webp", record.UserID, record.Version)
}

func storageObjectLock(objectID string) string {
	return "workspace-storage-object:" + objectID
}

func (s *Service) cleanupPrevious(ctx context.Context, previous AvatarRecord, currentObjectID, currentStorageKey string) {
	if previous.StorageObjectID != "" && previous.StorageObjectID != currentObjectID {
		_ = s.cleanupObject(ctx, previous.StorageObjectID, storageObjectFallback(previous))
	}
	if previous.StorageKey != "" && previous.StorageKey != currentStorageKey && expectedLegacyAvatarStorageKey(previous) == previous.StorageKey && s.blobStore != nil {
		cleanupCtx, cancelCleanup := avatarStorageContext(ctx)
		defer cancelCleanup()
		_ = s.blobStore.Delete(cleanupCtx, platformstorage.Object{Key: previous.StorageKey})
	}
}

func storageObjectFallback(record AvatarRecord) StorageObjectRecord {
	if record.StorageObject != nil {
		return *record.StorageObject
	}
	return StorageObjectRecord{ID: record.StorageObjectID}
}

func (s *Service) cleanupObject(ctx context.Context, objectID string, fallback StorageObjectRecord) error {
	if s == nil || s.repo == nil || s.blobStore == nil || strings.TrimSpace(objectID) == "" {
		return nil
	}
	cleanupCtx, cancelCleanup := avatarStorageContext(ctx)
	defer cancelCleanup()
	var cleanup StorageCleanup
	err := s.repo.WithTx(cleanupCtx, func(tx Tx) error {
		if tx == nil {
			return errors.New("transaction is required")
		}
		if err := tx.Lock(cleanupCtx, storageObjectLock(objectID)); err != nil {
			return err
		}
		var err error
		cleanup, err = tx.PrepareStorageObjectCleanup(cleanupCtx, objectID, fallback)
		if err != nil || !cleanup.DeleteObject || cleanup.Object == nil {
			return err
		}
		if cleanup.Registered && cleanup.Object.DeletedAt == nil {
			if err := tx.MarkStorageObjectDeleted(cleanupCtx, cleanup.Object.ID, s.nowUTC()); err != nil {
				return err
			}
		}
		if err := s.blobStore.Delete(cleanupCtx, cleanup.Object.BlobObject()); err != nil {
			return normalizePutError(err)
		}
		return nil
	})
	if err != nil {
		return normalizeRepositoryError(err)
	}
	return nil
}

func normalizeMediaError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var value *media.Error
	if errors.As(err, &value) {
		if value.Code == media.CodeProcessingUnavailable {
			return &Error{Code: CodeAvatarProcessingUnavailable, Message: MessageAvatarProcessingUnavailable, StatusCode: 503, Cause: err}
		}
		if strings.HasPrefix(value.Code, "avatar.") {
			return &Error{Code: value.Code, Message: value.Message, StatusCode: value.StatusCode, Cause: err}
		}
		return &Error{Code: CodeAvatarProcessingFailed, Message: MessageAvatarProcessingFailed, StatusCode: 500, Cause: err}
	}
	return &Error{Code: CodeAvatarProcessingFailed, Message: MessageAvatarProcessingFailed, StatusCode: 500, Cause: err}
}

func normalizePutError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return &Error{Code: CodeAvatarStorageFailed, Message: MessageAvatarStorageFailed, StatusCode: 500, Cause: err}
}

func normalizeOpenError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var value *platformstorage.Error
	if errors.As(err, &value) && value.Code == "file.storage_missing" {
		return avatarNotFoundError()
	}
	return &Error{Code: CodeAvatarStorageFailed, Message: MessageAvatarStorageFailed, StatusCode: 500, Cause: err}
}

func isMissingObjectError(err error) bool {
	var value *platformstorage.Error
	return errors.As(err, &value) && value != nil && value.Code == "file.storage_missing"
}

func validateOpenedAvatar(opened platformstorage.OpenedObject) (platformstorage.OpenedObject, error) {
	if opened.Body == nil {
		return platformstorage.OpenedObject{}, internalError("open workspace avatar", errors.New("storage returned an empty body"))
	}
	if opened.ByteSize <= 0 || opened.ByteSize > AvatarMaxOutputBytes {
		_ = opened.Body.Close()
		return platformstorage.OpenedObject{}, NewError(CodeAvatarStorageFailed, MessageAvatarStorageFailed, 500)
	}
	if strings.TrimSpace(opened.ContentType) == "" {
		opened.ContentType = AvatarContentType
	}
	return opened, nil
}
