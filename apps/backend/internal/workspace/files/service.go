package files

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	fileUploadCapability   = "file.upload"
	fileDownloadCapability = "file.download"
	attachmentTargetType   = "attachment"
	transferTargetType     = "transfer"
	workspaceTargetType    = "workspace"
	// Only server-side promotion and cleanup run inside the digest lock. Client
	// uploads are staged first; a stalled object store must not pin the lock or
	// a database connection indefinitely after the request has gone away.
	storageMutationTimeout = 2 * time.Minute
)

type Clock func() time.Time
type IDFactory func() (string, error)

// LegacyObjectReader is the read-only compatibility seam for attachments
// created before the content-addressed registry. The files service supplies
// only an already-authorized, namespace-derived key and a bounded limit. New
// writes never use this seam; the parent composition layer must explicitly
// inject the concrete adapter.
type LegacyObjectReader interface {
	OpenLegacy(context.Context, string, int64) (platformstorage.OpenedObject, error)
}

type ServiceOptions struct {
	Repository       Repository
	BlobStore        platformstorage.BlobStore
	LegacyReader     LegacyObjectReader
	SpaceID          string
	Now              Clock
	IDFactory        IDFactory
	DailyQuotaBytes  int64
	StaleUploadAge   time.Duration
	DownloadGrantTTL time.Duration
}

type Service struct {
	repo             Repository
	blobStore        platformstorage.BlobStore
	legacyReader     LegacyObjectReader
	spaceID          string
	now              Clock
	idFactory        IDFactory
	dailyQuotaBytes  int64
	staleUploadAge   time.Duration
	downloadGrantTTL time.Duration
}

type ReserveUploadInput struct {
	ActorID        string
	FileName       string
	MIMEType       string
	ByteSize       int64
	Visibility     string
	ConversationID string
	Meta           auth.RequestMeta
}

type UploadPartInput struct {
	ActorID       string
	UploadID      string
	PartNumber    int
	Content       io.Reader
	ContentLength int64
	SHA256        string
	Meta          auth.RequestMeta
}

type UploadStatusInput struct {
	ActorID  string
	UploadID string
	Meta     auth.RequestMeta
}

type CompleteUploadInput struct {
	ActorID  string
	UploadID string
	Mode     string
	Content  io.Reader
	Meta     auth.RequestMeta
}

type FailUploadInput struct {
	ActorID  string
	UploadID string
	Reason   string
	Meta     auth.RequestMeta
}

type ListFilesInput struct {
	ActorID string
	Options FileListOptions
	Meta    auth.RequestMeta
}

type ReserveDownloadInput struct {
	ActorID      string
	AttachmentID string
	Meta         auth.RequestMeta
}

type ReleaseDownloadInput struct {
	ActorID    string
	TransferID string
	Meta       auth.RequestMeta
}

type CompletedDownloadInput struct {
	ActorID      string
	AttachmentID string
	TransferID   string
	MaxBytes     int64
	Meta         auth.RequestMeta
}

type OpenAttachmentInput struct {
	ActorID      string
	AttachmentID string
	MaxBytes     int64
	Meta         auth.RequestMeta
}

type RemoveAttachmentInput struct {
	ActorID      string
	AttachmentID string
	Meta         auth.RequestMeta
}

type RemoveResult struct {
	OK           bool   `json:"ok"`
	AttachmentID string `json:"attachmentId"`
}

type rejection struct {
	err   *Error
	audit AuditInput
}

var defaultFileIDFactory = func() (string, error) {
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
		idFactory = defaultFileIDFactory
	}
	quota := options.DailyQuotaBytes
	if quota <= 0 {
		quota = DailyQuotaBytes
	}
	staleAge := options.StaleUploadAge
	if staleAge <= 0 {
		staleAge = DefaultStaleUploadAge
	}
	downloadGrantTTL := options.DownloadGrantTTL
	if downloadGrantTTL <= 0 {
		downloadGrantTTL = DefaultDownloadGrantTTL
	}
	if downloadGrantTTL > MaximumDownloadGrantTTL {
		downloadGrantTTL = MaximumDownloadGrantTTL
	}
	return &Service{
		repo:             options.Repository,
		blobStore:        options.BlobStore,
		legacyReader:     options.LegacyReader,
		spaceID:          spaceID,
		now:              now,
		idFactory:        idFactory,
		dailyQuotaBytes:  quota,
		staleUploadAge:   staleAge,
		downloadGrantTTL: downloadGrantTTL,
	}
}

func NewServiceForRepository(repo Repository, blobStore platformstorage.BlobStore) *Service {
	return NewService(ServiceOptions{Repository: repo, BlobStore: blobStore})
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

// withTransaction resolves the current human actor again inside the same
// transaction as file, transfer, event, and audit writes. A rejection is
// intentionally committed with its content-free audit row; other errors roll
// the transaction back.
func (s *Service) withTransaction(ctx context.Context, actorID string, meta auth.RequestMeta, fn func(Tx, *auth.Actor, time.Time) (any, *rejection, error)) (any, error) {
	return s.withActorTransaction(ctx, actorID, meta, s.lookupActor, fn)
}

type fileActorLookup func(context.Context, ReadRepository, string) (*auth.Actor, error)

func (s *Service) withActorTransaction(ctx context.Context, actorID string, meta auth.RequestMeta, lookup fileActorLookup, fn func(Tx, *auth.Actor, time.Time) (any, *rejection, error)) (any, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace file service", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	if fn == nil {
		return nil, internalError("workspace file transaction", errors.New("callback is required"))
	}
	meta = meta.Safe()
	var result any
	var rejected *rejection
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return errors.New("transaction is required")
		}
		actor, err := lookup(ctx, tx, actorID)
		if err != nil {
			return err
		}
		now := s.nowUTC()
		result, rejected, err = fn(tx, actor, now)
		if err != nil {
			return err
		}
		if rejected == nil {
			return nil
		}
		audit, auditErr := s.auditInput(actor, meta, rejected.audit, now)
		if auditErr != nil {
			return auditErr
		}
		rejected.audit = audit
		if err := tx.WriteAudit(ctx, rejected.audit); err != nil {
			return internalError("write file rejection audit", err)
		}
		return nil
	})
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if rejected != nil {
		return nil, rejected.err
	}
	return result, nil
}

func (s *Service) lookupActor(ctx context.Context, repo ReadRepository, actorID string) (*auth.Actor, error) {
	actor, err := repo.LookupActor(ctx, s.space(), strings.TrimSpace(actorID))
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if actor == nil || strings.TrimSpace(actor.ID) == "" || actor.ID != strings.TrimSpace(actorID) || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	if actor.Kind != "" && actor.Kind != "human" {
		return nil, identityForbiddenError()
	}
	return actor, nil
}

func (s *Service) readActor(ctx context.Context, actorID string) (*auth.Actor, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace file service", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	return s.lookupActor(ctx, s.repo, actorID)
}

// GetQuota returns the caller's current UTC-day transfer accounting after
// re-reading active space membership. It is intentionally read-only; quota
// reservation remains serialized inside ReserveUpload/ReserveDownload.
func (s *Service) GetQuota(ctx context.Context, actorID string) (QuotaSnapshot, error) {
	actor, err := s.readActor(ctx, actorID)
	if err != nil {
		return QuotaSnapshot{}, err
	}
	used, err := s.repo.UsedTransferBytes(ctx, s.space(), actor.ID, dayStart(s.nowUTC()))
	if err != nil {
		return QuotaSnapshot{}, normalizeRepositoryError(err)
	}
	used = maxInt64(used, 0)
	return QuotaSnapshot{UsedToday: used, RemainingBytes: remainingQuota(used, s.dailyQuotaBytes), DailyQuotaBytes: s.dailyQuotaBytes}, nil
}

func (s *Service) auditInput(actor *auth.Actor, meta auth.RequestMeta, input AuditInput, now time.Time) (AuditInput, error) {
	id, err := s.newID("workspace file audit")
	if err != nil {
		return AuditInput{}, internalError("generate workspace file audit id", err)
	}
	input.ID = id
	input.SpaceID = s.space()
	if actor != nil {
		input.ActorUserID = actor.ID
		input.ActorGitHubLogin = actor.GitHubLogin
	}
	safe := meta.Safe()
	input.RequestID = safe.RequestID
	input.IPAddress = safe.IPAddress
	input.UserAgent = safe.UserAgent
	input.CreatedAt = now
	if input.Result == "" {
		input.Result = "success"
	}
	return input, nil
}

func (s *Service) writeAudit(ctx context.Context, tx Tx, actor *auth.Actor, meta auth.RequestMeta, input AuditInput, now time.Time) error {
	audit, err := s.auditInput(actor, meta, input, now)
	if err != nil {
		return err
	}
	if err := tx.WriteAudit(ctx, audit); err != nil {
		return internalError("write workspace file audit", err)
	}
	return nil
}

func (s *Service) writeEvent(ctx context.Context, tx Tx, input EventInput, now time.Time) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := s.newID("workspace file event")
		if err != nil {
			return internalError("generate workspace file event id", err)
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" {
		input.SpaceID = s.space()
	}
	if strings.TrimSpace(input.Type) == "" || input.CreatedAt.IsZero() {
		if input.CreatedAt.IsZero() {
			input.CreatedAt = now
		}
		if strings.TrimSpace(input.Type) == "" {
			return internalError("write workspace file event", errors.New("event type is required"))
		}
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return internalError("write workspace file event", errors.New("event payload is not valid JSON"))
	}
	if err := tx.WriteEvent(ctx, input); err != nil {
		return internalError("write workspace file event", err)
	}
	return nil
}

func (s *Service) requireCapability(actor *auth.Actor, capability, targetType, targetID string) *Error {
	if hasCapability(actor, capability) {
		return nil
	}
	return permissionDeniedError()
}

func hasCapability(actor *auth.Actor, capability string) bool {
	if actor == nil {
		return false
	}
	switch actor.Role {
	case "owner":
		return true
	case "admin":
		return capability == fileUploadCapability || capability == fileDownloadCapability
	case "member":
		return capability == fileUploadCapability || capability == fileDownloadCapability
	default:
		return false
	}
}

func reject(err *Error, action, targetType, targetID, reason string) *rejection {
	return &rejection{err: err, audit: AuditInput{Action: action, TargetType: targetType, TargetID: targetID, Result: "rejected", Reason: reason}}
}

func (s *Service) recordRejection(ctx context.Context, actorID string, meta auth.RequestMeta, action, targetType, targetID, reason string, result *Error) error {
	_, err := s.withTransaction(ctx, actorID, meta, func(_ Tx, _ *auth.Actor, _ time.Time) (any, *rejection, error) {
		return nil, reject(result, action, targetType, targetID, reason), nil
	})
	if err != nil {
		return err
	}
	return result
}

func normalizeStorageError(err error) error {
	if err == nil {
		return nil
	}
	var storageErr *platformstorage.Error
	if !errors.As(err, &storageErr) {
		return internalError("workspace file storage", err)
	}
	message := storageErr.Message
	if message == "" {
		message = MessageInternal
	}
	status := storageErr.StatusCode
	if status == 0 {
		status = 500
	}
	return NewError(storageErr.Code, message, status)
}

func normalizeUploadID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) == 0 || len(value) > 128 {
		return ""
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '_' && r != '-' {
			return ""
		}
	}
	return value
}

func normalizeFileName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || len(value) > MaximumFileNameBytes {
		return "", validationError(CodeFileInvalid, MessageFileInvalid)
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f || r == '\u202e' || r == '\u202a' || r == '\u202b' || r == '\u202c' || r == '\u202d' || r == '\u2066' || r == '\u2067' || r == '\u2068' || r == '\u2069' {
			return "", validationError(CodeFileInvalid, MessageFileInvalid)
		}
	}
	return value, nil
}

func normalizeMIMEType(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "application/octet-stream"
	}
	if !utf8.ValidString(value) || len(value) > MaximumMIMETypeBytes || strings.ContainsAny(value, "\r\n\x00") {
		return "", validationError(CodeFileInvalid, MessageFileInvalid)
	}
	return value, nil
}

func normalizeReason(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "upload failed"
	}
	if len(value) > MaximumFailureReasonBytes {
		value = value[:MaximumFailureReasonBytes]
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return "upload failed"
		}
	}
	return value
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func formatTimePtr(value *time.Time) *string {
	if value == nil || value.IsZero() {
		return nil
	}
	formatted := formatTime(*value)
	return &formatted
}

func cloneStringPtr(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func dayStart(value time.Time) time.Time {
	value = value.UTC()
	year, month, day := value.Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

func remainingQuota(used, limit int64) int64 {
	if used < 0 {
		used = 0
	}
	if used >= limit {
		return 0
	}
	return limit - used
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func uploadContract(byteSize int64) (mode string, partCount int, err error) {
	if byteSize < 0 {
		return "", 0, validationError(CodeFileInvalidSize, MessageFileInvalidSize)
	}
	partCount = 0
	if byteSize > 0 {
		partCount = int((byteSize + UploadPartSize - 1) / UploadPartSize)
	}
	if partCount > UploadPartLimit {
		return "", 0, validationError(CodeUploadInvalidPart, MessageUploadInvalidPart)
	}
	mode = "single"
	if byteSize > UploadPartSize {
		mode = "chunked"
	}
	return mode, partCount, nil
}

func expectedPartSize(byteSize int64, partNumber int) (int64, error) {
	_, count, err := uploadContract(byteSize)
	if err != nil {
		return 0, err
	}
	if count == 0 || partNumber < 1 || partNumber > count {
		return 0, validationError(CodeUploadInvalidPart, MessageUploadInvalidPart)
	}
	if partNumber == count {
		return byteSize - UploadPartSize*int64(count-1), nil
	}
	return UploadPartSize, nil
}

func stagingContentKey(uploadID string) string {
	return "workspace/uploads/" + uploadID + "/content"
}

func stagingAssembledKey(uploadID string) string {
	return "workspace/uploads/" + uploadID + "/assembled"
}

func stagingPartKey(uploadID string, partNumber int) string {
	return fmt.Sprintf("workspace/uploads/%s/parts/%d", uploadID, partNumber)
}

func canonicalObjectRecord(digest string, size int64, contentType string, now time.Time) (StorageObjectRecord, error) {
	digest, err := platformstorage.NormalizeSHA256(digest)
	if err != nil {
		return StorageObjectRecord{}, normalizeStorageError(err)
	}
	key, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		return StorageObjectRecord{}, normalizeStorageError(err)
	}
	return StorageObjectRecord{ID: "wso_" + digest, SHA256: digest, ObjectKey: key, ByteSize: size, ContentType: contentType, CreatedAt: now}, nil
}

func lockKeys(ctx context.Context, tx Tx, keys ...string) error {
	unique := make(map[string]struct{}, len(keys))
	ordered := make([]string, 0, len(keys))
	for _, key := range keys {
		if strings.TrimSpace(key) == "" {
			continue
		}
		if _, ok := unique[key]; ok {
			continue
		}
		unique[key] = struct{}{}
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	for _, key := range ordered {
		if err := tx.Lock(ctx, key); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) ReserveUpload(ctx context.Context, input ReserveUploadInput) (UploadResult, error) {
	return s.reserveUpload(ctx, input, s.lookupActor)
}

func (s *Service) reserveUpload(ctx context.Context, input ReserveUploadInput, lookup fileActorLookup) (UploadResult, error) {
	if s == nil || s.repo == nil {
		return UploadResult{}, internalError("reserve workspace upload", errors.New("repository is required"))
	}
	// Cleanup is a mutation too: unauthenticated callers must not trigger it.
	if _, err := lookup(ctx, s.repo, input.ActorID); err != nil {
		return UploadResult{}, err
	}
	if _, err := s.ReleaseStaleUploadReservations(ctx); err != nil {
		return UploadResult{}, err
	}
	value, err := s.withActorTransaction(ctx, input.ActorID, input.Meta, lookup, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		if denied := s.requireCapability(actor, fileUploadCapability, attachmentTargetType, "new"); denied != nil {
			return nil, reject(denied, fileUploadCapability, attachmentTargetType, "new", "insufficient permission"), nil
		}
		fileName, validationErr := normalizeFileName(input.FileName)
		if validationErr != nil {
			var domainErr *Error
			if errors.As(validationErr, &domainErr) {
				return nil, reject(domainErr, "file.upload.reserve", attachmentTargetType, "new", domainErr.Code), nil
			}
			return nil, nil, internalError("validate workspace file name", validationErr)
		}
		if input.ByteSize < 0 || input.ByteSize > platformstorage.DefaultMaxObjectBytes {
			invalid := validationError(CodeFileInvalidSize, MessageFileInvalidSize)
			return nil, reject(invalid, "file.upload.reserve", attachmentTargetType, "new", CodeFileInvalidSize), nil
		}
		mimeType, validationErr := normalizeMIMEType(input.MIMEType)
		if validationErr != nil {
			var domainErr *Error
			if errors.As(validationErr, &domainErr) {
				return nil, reject(domainErr, "file.upload.reserve", attachmentTargetType, "new", domainErr.Code), nil
			}
			return nil, nil, internalError("validate workspace mime type", validationErr)
		}
		visibility := strings.TrimSpace(input.Visibility)
		if visibility == "" {
			visibility = string(VisibilityPrivateStaging)
		}
		if visibility != string(VisibilityPrivateStaging) && visibility != string(VisibilityConversation) && visibility != string(VisibilitySpace) {
			invalid := validationError(CodeFileInvalidVisibility, MessageFileInvalidVisibility)
			return nil, reject(invalid, "file.upload.reserve", attachmentTargetType, "new", CodeFileInvalidVisibility), nil
		}
		conversationID := strings.TrimSpace(input.ConversationID)
		if visibility == string(VisibilityConversation) {
			if conversationID == "" {
				invalid := validationError("conversation.required", "会话不能为空")
				return nil, reject(invalid, "file.upload", "conversation", "", "conversation.required"), nil
			}
			active, checkErr := tx.ConversationMemberActive(ctx, s.space(), conversationID, actor.ID)
			if checkErr != nil {
				return nil, nil, normalizeRepositoryError(checkErr)
			}
			if !active {
				return nil, reject(conversationNotFoundError(), "file.upload", "conversation", conversationID, "not a conversation member"), nil
			}
		} else {
			conversationID = ""
		}
		mode, partCount, contractErr := uploadContract(input.ByteSize)
		if contractErr != nil {
			var validationErr *Error
			if errors.As(contractErr, &validationErr) {
				return nil, reject(validationErr, "file.upload.reserve", attachmentTargetType, "new", validationErr.Code), nil
			}
			return nil, nil, internalError("validate workspace upload contract", contractErr)
		}
		if err := tx.Lock(ctx, quotaLockKey(s.space(), actor.ID, now)); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		used, usageErr := tx.UsedTransferBytes(ctx, s.space(), actor.ID, dayStart(now))
		if usageErr != nil {
			return nil, nil, normalizeRepositoryError(usageErr)
		}
		if input.ByteSize > remainingQuota(used, s.dailyQuotaBytes) {
			transferID, idErr := s.newID("workspace upload rejection")
			if idErr != nil {
				return nil, nil, internalError("generate workspace upload rejection id", idErr)
			}
			transfer := TransferRecord{ID: transferID, SpaceID: s.space(), UserID: actor.ID, Direction: string(TransferUpload), ByteSize: input.ByteSize, Status: string(TransferRejected), CreatedAt: now, CompletedAt: timePtr(now)}
			if err := tx.CreateTransfer(ctx, transfer); err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			payload, marshalErr := json.Marshal(map[string]any{"direction": string(TransferUpload), "code": CodeQuotaInsufficient, "message": MessageQuotaInsufficient, "reason": CodeQuotaInsufficient})
			if marshalErr != nil {
				return nil, nil, internalError("encode quota rejection event", marshalErr)
			}
			if err := s.writeEvent(ctx, tx, EventInput{Type: "transfer.rejected", ActorID: actor.ID, TargetType: transferTargetType, TargetID: transferID, PayloadJSON: payload}, now); err != nil {
				return nil, nil, err
			}
			if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "file.upload.rejected", TargetType: transferTargetType, TargetID: transferID, Result: "rejected", Reason: "insufficient daily quota"}, now); err != nil {
				return nil, nil, err
			}
			return UploadResult{Status: string(TransferRejected), UsedToday: maxInt64(used, 0), RemainingBytes: remainingQuota(used, s.dailyQuotaBytes), DailyQuotaBytes: s.dailyQuotaBytes}, nil, nil
		}

		attachmentID, idErr := s.newID("workspace attachment")
		if idErr != nil {
			return nil, nil, internalError("generate workspace attachment id", idErr)
		}
		transferID, idErr := s.newID("workspace upload")
		if idErr != nil {
			return nil, nil, internalError("generate workspace upload id", idErr)
		}
		var conversationPointer *string
		if conversationID != "" {
			conversationPointer = &conversationID
		}
		attachment := AttachmentRecord{ID: attachmentID, SpaceID: s.space(), UploaderID: actor.ID, UploaderName: actor.DisplayName, ConversationID: conversationPointer, Visibility: visibility, Status: string(AttachmentPending), FileName: fileName, MIMEType: mimeType, ByteSize: input.ByteSize, StorageKey: stagingContentKey(transferID), UploadTransferID: transferID, CreatedAt: now}
		if err := tx.CreateAttachment(ctx, attachment); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		transfer := TransferRecord{ID: transferID, SpaceID: s.space(), UserID: actor.ID, Direction: string(TransferUpload), ByteSize: input.ByteSize, Status: string(TransferReserved), AttachmentID: stringPtr(attachmentID), CreatedAt: now, LastActivityAt: timePtr(now)}
		if err := tx.CreateTransfer(ctx, transfer); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		payload, marshalErr := json.Marshal(map[string]any{"attachmentId": attachment.ID, "transferId": transfer.ID, "status": attachment.Status, "attachment": projectAttachment(attachment, actor)})
		if marshalErr != nil {
			return nil, nil, internalError("encode attachment creation event", marshalErr)
		}
		if err := s.writeEvent(ctx, tx, EventInput{Type: "attachment.created", ActorID: actor.ID, ConversationID: conversationID, TargetType: attachmentTargetType, TargetID: attachment.ID, PayloadJSON: payload}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "file.upload.reserve", TargetType: attachmentTargetType, TargetID: attachment.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		return UploadResult{Status: string(TransferReserved), ID: transfer.ID, UsedToday: used + input.ByteSize, RemainingBytes: remainingQuota(used+input.ByteSize, s.dailyQuotaBytes), DailyQuotaBytes: s.dailyQuotaBytes, Attachment: ptrAttachment(projectAttachment(attachment, actor)), Upload: &UploadPlan{ID: transfer.ID, Mode: mode, PartSize: UploadPartSize, PartCount: partCount}}, nil, nil
	})
	if err != nil {
		return UploadResult{}, err
	}
	return value.(UploadResult), nil
}

func quotaLockKey(spaceID, userID string, now time.Time) string {
	return "workspace-quota:" + spaceID + ":" + userID + ":" + now.UTC().Format("2006-01-02")
}

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}
	copy := value
	return &copy
}

func timePtr(value time.Time) *time.Time {
	copy := value
	return &copy
}

func ptrAttachment(value Attachment) *Attachment {
	copy := value
	copy.ConversationID = cloneStringPtr(value.ConversationID)
	copy.CompletedAt = cloneStringPtr(value.CompletedAt)
	copy.AvailableAt = cloneStringPtr(value.AvailableAt)
	return &copy
}

func (s *Service) UploadPart(ctx context.Context, input UploadPartInput) (UploadPartResult, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return UploadPartResult{}, err
	}
	uploadID := normalizeUploadID(input.UploadID)
	if uploadID == "" {
		return UploadPartResult{}, uploadInvalidError()
	}
	transfer, _, err := s.loadOwnedUpload(ctx, s.repo, actor.ID, uploadID)
	if err != nil {
		return UploadPartResult{}, err
	}
	expectedSize, err := expectedPartSize(transfer.ByteSize, input.PartNumber)
	if err != nil {
		return UploadPartResult{}, err
	}
	if input.ContentLength >= 0 && input.ContentLength != expectedSize {
		return UploadPartResult{}, validationError(CodeUploadPartSize, MessageUploadPartSize)
	}
	digest, digestErr := platformstorage.NormalizeSHA256(input.SHA256)
	if digestErr != nil {
		return UploadPartResult{}, validationError(CodeUploadInvalidPartHash, "上传分片校验值无效")
	}
	if s.blobStore == nil {
		return UploadPartResult{}, internalError("save workspace upload part", errors.New("blob store is required"))
	}
	attemptKey, err := newUploadAttemptKey(uploadID)
	if err != nil {
		return UploadPartResult{}, err
	}
	defer s.cleanupUploadAttempt(ctx, attemptKey)
	stored, storeErr := s.blobStore.Put(ctx, attemptKey, input.Content, expectedSize, digest)
	if storeErr != nil {
		if storageCode(storeErr) == "storage.object_conflict" {
			return UploadPartResult{}, NewError(CodeUploadPartConflict, MessageUploadPartConflict, 409)
		}
		mapped := normalizeStorageError(storeErr)
		if isCode(mapped, "upload.size_mismatch") {
			return UploadPartResult{}, validationError(CodeUploadPartSize, MessageUploadPartSize)
		}
		if isCode(mapped, "upload.hash_mismatch") {
			return UploadPartResult{}, validationError(CodeUploadPartHash, MessageUploadPartHash)
		}
		if isCode(mapped, "upload.invalid_content") {
			return UploadPartResult{}, validationError(CodeUploadInvalidContent, MessageUploadInvalidContent)
		}
		return UploadPartResult{}, mapped
	}
	ctx, cancelPromotion := context.WithTimeout(ctx, storageMutationTimeout)
	defer cancelPromotion()
	result, txErr := s.withTransaction(ctx, actor.ID, input.Meta, func(tx Tx, currentActor *auth.Actor, now time.Time) (any, *rejection, error) {
		if err := tx.Lock(ctx, uploadLockKey(uploadID)); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if _, _, loadErr := s.loadOwnedUpload(ctx, tx, currentActor.ID, uploadID); loadErr != nil {
			return nil, nil, loadErr
		}
		existing, err := tx.GetUploadPart(ctx, uploadID, input.PartNumber)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if existing != nil && (existing.ByteSize != expectedSize || !strings.EqualFold(existing.SHA256, digest)) {
			return nil, nil, NewError(CodeUploadPartConflict, MessageUploadPartConflict, 409)
		}
		opened, err := s.blobStore.Open(ctx, platformstorage.Object{Key: attemptKey, SHA256: digest, ByteSize: expectedSize}, expectedSize)
		if err != nil {
			return nil, nil, normalizeStorageError(err)
		}
		defer opened.Body.Close()
		if _, err := s.blobStore.Put(ctx, stagingPartKey(uploadID, input.PartNumber), opened.Body, expectedSize, digest); err != nil {
			if storageCode(err) == "storage.object_conflict" {
				return nil, nil, NewError(CodeUploadPartConflict, MessageUploadPartConflict, 409)
			}
			return nil, nil, normalizeStorageError(err)
		}
		changed, err := tx.UpsertUploadPart(ctx, UploadPartRecord{UploadID: uploadID, PartNumber: input.PartNumber, ByteSize: expectedSize, SHA256: digest, CreatedAt: now, UpdatedAt: now})
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if err := tx.TouchUpload(ctx, uploadID, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		return UploadPartResult{PartNumber: input.PartNumber, ByteSize: stored.ByteSize, SHA256: digest, Reused: existing != nil && !changed}, nil, nil
	})
	if txErr != nil {
		s.cleanupUnboundPart(ctx, uploadID, input.PartNumber)
		return UploadPartResult{}, txErr
	}
	return result.(UploadPartResult), nil
}

func storageCode(err error) string {
	var value *platformstorage.Error
	if errors.As(err, &value) {
		return value.Code
	}
	return ""
}

func uploadLockKey(uploadID string) string {
	return "workspace-upload:" + uploadID
}

func (s *Service) loadOwnedUpload(ctx context.Context, repo ReadRepository, actorID, uploadID string) (*TransferRecord, *AttachmentRecord, error) {
	transfer, err := repo.GetTransfer(ctx, s.space(), actorID, uploadID, TransferUpload)
	if err != nil {
		return nil, nil, normalizeRepositoryError(err)
	}
	if transfer == nil || transfer.Status != string(TransferReserved) || transfer.AttachmentID == nil || *transfer.AttachmentID == "" {
		return nil, nil, uploadInvalidError()
	}
	attachment, err := repo.GetAttachment(ctx, s.space(), *transfer.AttachmentID)
	if err != nil {
		return nil, nil, normalizeRepositoryError(err)
	}
	if attachment == nil || attachment.UploaderID != actorID || attachment.Status != string(AttachmentPending) || attachment.UploadTransferID != transfer.ID {
		return nil, nil, uploadInvalidError()
	}
	return transfer, attachment, nil
}

func (s *Service) GetUploadStatus(ctx context.Context, input UploadStatusInput) (UploadStatus, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return UploadStatus{}, err
	}
	uploadID := normalizeUploadID(input.UploadID)
	if uploadID == "" {
		return UploadStatus{}, uploadInvalidError()
	}
	transfer, _, err := s.loadOwnedUpload(ctx, s.repo, actor.ID, uploadID)
	if err != nil {
		return UploadStatus{}, err
	}
	mode, partCount, err := uploadContract(transfer.ByteSize)
	if err != nil {
		return UploadStatus{}, err
	}
	parts, err := s.repo.ListUploadParts(ctx, uploadID)
	if err != nil {
		return UploadStatus{}, normalizeRepositoryError(err)
	}
	if parts == nil {
		parts = make([]UploadPartRecord, 0)
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })
	return UploadStatus{UploadID: uploadID, Mode: mode, PartSize: UploadPartSize, PartCount: partCount, Parts: parts}, nil
}

func (s *Service) UploadContent(ctx context.Context, actorID, uploadID string, content io.Reader, meta auth.RequestMeta) (UploadResult, error) {
	return s.CompleteUpload(ctx, CompleteUploadInput{ActorID: actorID, UploadID: uploadID, Mode: "single", Content: content, Meta: meta})
}

func (s *Service) SaveUploadPart(ctx context.Context, input UploadPartInput) (UploadPartResult, error) {
	return s.UploadPart(ctx, input)
}

func (s *Service) GetStatus(ctx context.Context, input UploadStatusInput) (UploadStatus, error) {
	return s.GetUploadStatus(ctx, input)
}

func (s *Service) CompleteUpload(ctx context.Context, input CompleteUploadInput) (UploadResult, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return UploadResult{}, err
	}
	uploadID := normalizeUploadID(input.UploadID)
	if uploadID == "" {
		return UploadResult{}, uploadInvalidError()
	}
	transfer, attachment, err := s.loadOwnedUpload(ctx, s.repo, actor.ID, uploadID)
	if err != nil {
		return UploadResult{}, err
	}
	if s.blobStore == nil {
		return UploadResult{}, internalError("complete workspace upload", errors.New("blob store is required"))
	}
	mode := strings.ToLower(strings.TrimSpace(input.Mode))
	if mode == "" {
		if input.Content != nil {
			mode = "single"
		} else {
			mode = "chunked"
		}
	}
	if mode != "single" && mode != "chunked" {
		return UploadResult{}, validationError(CodeUploadInvalid, MessageUploadInvalid)
	}
	partRecords := make([]UploadPartRecord, 0)
	attemptKey, err := newUploadAttemptKey(uploadID)
	if err != nil {
		return UploadResult{}, err
	}
	defer s.cleanupUploadAttempt(ctx, attemptKey)
	var staged platformstorage.StoredObject
	if mode == "single" {
		if input.Content == nil {
			return UploadResult{}, validationError(CodeUploadInvalidContent, MessageUploadInvalidContent)
		}
		staged, err = s.blobStore.Put(ctx, attemptKey, input.Content, transfer.ByteSize, "")
		if err != nil {
			mapped := mapUploadStorageError(err)
			if shouldFailDuringStorage(mapped) {
				_ = s.failUploadAfterCompletion(ctx, actor.ID, uploadID, failureReason(mapped), input.Meta)
			}
			return UploadResult{}, mapped
		}
	} else {
		if input.Content != nil {
			return UploadResult{}, validationError(CodeUploadInvalidContent, MessageUploadInvalidContent)
		}
		parts, partsErr := s.repo.ListUploadParts(ctx, uploadID)
		if partsErr != nil {
			return UploadResult{}, normalizeRepositoryError(partsErr)
		}
		partRecords = append(partRecords, parts...)
		_, expectedCount, contractErr := uploadContract(transfer.ByteSize)
		if contractErr != nil {
			return UploadResult{}, contractErr
		}
		if expectedCount == 0 || len(parts) != expectedCount {
			return UploadResult{}, validationError(CodeUploadPartsIncomplete, MessageUploadPartsIncomplete)
		}
		sort.Slice(parts, func(i, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })
		readers := make([]io.Reader, 0, len(parts))
		closers := make([]io.Closer, 0, len(parts))
		closeReaders := func() {
			for _, closer := range closers {
				_ = closer.Close()
			}
		}
		for index, part := range parts {
			expectedPartNumber := index + 1
			if part.PartNumber != expectedPartNumber {
				closeReaders()
				return UploadResult{}, validationError(CodeUploadPartsIncomplete, MessageUploadPartsIncomplete)
			}
			expectedSize, sizeErr := expectedPartSize(transfer.ByteSize, part.PartNumber)
			if sizeErr != nil || part.ByteSize != expectedSize {
				closeReaders()
				return UploadResult{}, validationError(CodeUploadPartsIncomplete, MessageUploadPartsIncomplete)
			}
			opened, openErr := s.blobStore.Open(ctx, platformstorage.Object{Key: stagingPartKey(uploadID, part.PartNumber), SHA256: part.SHA256, ByteSize: part.ByteSize}, expectedPartSizeOrMax(part.ByteSize))
			if openErr != nil {
				closeReaders()
				return UploadResult{}, validationError(CodeUploadPartsIncomplete, MessageUploadPartsIncomplete)
			}
			readers = append(readers, opened.Body)
			closers = append(closers, opened.Body)
		}
		staged, err = s.blobStore.Put(ctx, attemptKey, io.MultiReader(readers...), transfer.ByteSize, "")
		closeReaders()
		if err != nil {
			mapped := mapUploadStorageError(err)
			if shouldFailDuringStorage(mapped) {
				_ = s.failUploadAfterCompletion(ctx, actor.ID, uploadID, failureReason(mapped), input.Meta)
			}
			return UploadResult{}, mapped
		}
	}
	objectRecord, err := canonicalObjectRecord(staged.SHA256, staged.ByteSize, attachment.MIMEType, s.nowUTC())
	if err != nil {
		mapped := normalizeStorageError(err)
		var failErr error
		if shouldFailDuringStorage(mapped) {
			failErr = s.failUploadAfterCompletion(context.Background(), actor.ID, uploadID, failureReason(mapped), input.Meta)
		}
		if failErr != nil {
			mapped = errors.Join(mapped, failErr)
		}
		return UploadResult{}, mapped
	}
	ctx, cancelPromotion := context.WithTimeout(ctx, storageMutationTimeout)
	defer cancelPromotion()
	defer func() {
		s.cleanupTerminalUploadStaging(ctx, actor.ID, uploadID, partRecords, transfer.ByteSize)
	}()
	var promotionFailed bool
	value, txErr := s.withTransaction(ctx, actor.ID, input.Meta, func(tx Tx, currentActor *auth.Actor, now time.Time) (any, *rejection, error) {
		if err := lockKeys(ctx, tx, uploadLockKey(uploadID), storageObjectLockKey(objectRecord.ID)); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		currentTransfer, currentAttachment, loadErr := s.loadOwnedUpload(ctx, tx, currentActor.ID, uploadID)
		if loadErr != nil {
			return nil, nil, loadErr
		}
		if currentTransfer.ByteSize != objectRecord.ByteSize || currentAttachment.ID != attachment.ID {
			return nil, nil, validationError(CodeUploadSizeMismatch, MessageUploadSizeMismatch)
		}
		// Ensure bytes and bind their reference under the same shared digest
		// lock as deletion, including when Put reuses an existing object.
		if _, err := s.copyStagedToCanonical(ctx, staged, objectRecord); err != nil {
			promotionFailed = true
			return nil, nil, mapUploadStorageError(err)
		}
		_, _, bindErr := tx.EnsureStorageObjectAndBind(ctx, s.space(), currentAttachment.ID, objectRecord)
		if bindErr != nil {
			return nil, nil, normalizeRepositoryError(bindErr)
		}
		changed, completeErr := tx.CompleteUpload(ctx, s.space(), currentActor.ID, uploadID, currentAttachment.ID, now)
		if completeErr != nil {
			return nil, nil, normalizeRepositoryError(completeErr)
		}
		if !changed {
			return nil, nil, uploadInvalidError()
		}
		completedAttachment, getErr := tx.GetAttachment(ctx, s.space(), currentAttachment.ID)
		if getErr != nil {
			return nil, nil, normalizeRepositoryError(getErr)
		}
		if completedAttachment == nil {
			return nil, nil, internalError("load completed attachment", errors.New("attachment disappeared"))
		}
		payload, marshalErr := json.Marshal(map[string]any{"attachmentId": completedAttachment.ID, "status": completedAttachment.Status, "attachment": projectAttachment(*completedAttachment, currentActor)})
		if marshalErr != nil {
			return nil, nil, internalError("encode attachment completion event", marshalErr)
		}
		if err := s.writeEvent(ctx, tx, EventInput{Type: "attachment.available", ActorID: currentActor.ID, ConversationID: pointerValue(completedAttachment.ConversationID), TargetType: attachmentTargetType, TargetID: completedAttachment.ID, PayloadJSON: payload}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, currentActor, input.Meta, AuditInput{Action: "file.upload.completed", TargetType: attachmentTargetType, TargetID: completedAttachment.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		used, usageErr := tx.UsedTransferBytes(ctx, s.space(), currentActor.ID, dayStart(now))
		if usageErr != nil {
			return nil, nil, normalizeRepositoryError(usageErr)
		}
		return UploadResult{Status: string(TransferCompleted), ID: uploadID, UsedToday: maxInt64(used, 0), RemainingBytes: remainingQuota(used, s.dailyQuotaBytes), DailyQuotaBytes: s.dailyQuotaBytes, Attachment: ptrAttachment(projectAttachment(*completedAttachment, currentActor))}, nil, nil
	})
	if txErr != nil {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), storageMutationTimeout)
		defer cancelCleanup()
		_ = s.cleanupObject(cleanupCtx, objectRecord)
		if (promotionFailed && shouldFailDuringStorage(txErr)) || (!promotionFailed && shouldFailAfterComplete(txErr)) {
			_ = s.failUploadAfterCompletion(cleanupCtx, actor.ID, uploadID, failureReason(txErr), input.Meta)
		}
		return UploadResult{}, txErr
	}
	return value.(UploadResult), nil
}

func expectedPartSizeOrMax(size int64) int64 {
	if size <= 0 {
		return platformstorage.DefaultMaxObjectBytes
	}
	return size
}

func (s *Service) copyStagedToCanonical(ctx context.Context, staged platformstorage.StoredObject, object StorageObjectRecord) (platformstorage.StoredObject, error) {
	opened, err := s.blobStore.Open(ctx, staged.Object, staged.ByteSize)
	if err != nil {
		return platformstorage.StoredObject{}, mapUploadStorageError(err)
	}
	defer opened.Body.Close()
	return s.blobStore.Put(ctx, object.ObjectKey, opened.Body, object.ByteSize, object.SHA256)
}

func mapUploadStorageError(err error) error {
	mapped := normalizeStorageError(err)
	code := storageCode(err)
	switch code {
	case "upload.size_mismatch":
		return validationError(CodeUploadSizeMismatch, MessageUploadSizeMismatch)
	case "upload.hash_mismatch", "storage.object_digest_mismatch":
		return validationError(CodeUploadHashMismatch, MessageUploadHashMismatch)
	case "upload.invalid_content":
		return validationError(CodeUploadInvalidContent, MessageUploadInvalidContent)
	default:
		return mapped
	}
}

func shouldFailAfterComplete(err error) bool {
	return !isCode(err, CodeUploadInvalid) && !isCode(err, CodeUploadPartsIncomplete) && !isCode(err, CodeUploadInvalidContent) && !isCode(err, CodeUploadSizeMismatch)
}

func shouldFailDuringStorage(err error) bool {
	if err == nil || isCode(err, CodeUploadInvalidContent) || isCode(err, CodeUploadInvalid) || isCode(err, CodeUploadPartsIncomplete) {
		return false
	}
	return true
}

func failureReason(err error) string {
	var value *Error
	if errors.As(err, &value) && value.Code != "" {
		return value.Code
	}
	return "upload complete failed"
}

func pointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (s *Service) cleanupStaged(ctx context.Context, keys []string) error {
	if s == nil || s.blobStore == nil {
		return nil
	}
	var joined error
	for _, key := range keys {
		if err := s.blobStore.Delete(ctx, platformstorage.Object{Key: key}); err != nil {
			joined = errors.Join(joined, normalizeStorageError(err))
		}
	}
	return joined
}

func (s *Service) FailUpload(ctx context.Context, input FailUploadInput) (UploadResult, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return UploadResult{}, err
	}
	uploadID := normalizeUploadID(input.UploadID)
	if uploadID == "" {
		return UploadResult{}, uploadInvalidError()
	}
	parts, partsErr := s.repo.ListUploadParts(ctx, uploadID)
	if partsErr != nil {
		return UploadResult{}, normalizeRepositoryError(partsErr)
	}
	var uploadByteSize int64
	value, err := s.withTransaction(ctx, actor.ID, input.Meta, func(tx Tx, currentActor *auth.Actor, now time.Time) (any, *rejection, error) {
		transfer, attachment, loadErr := s.loadOwnedUpload(ctx, tx, currentActor.ID, uploadID)
		if loadErr != nil {
			return nil, nil, loadErr
		}
		uploadByteSize = transfer.ByteSize
		if err := tx.Lock(ctx, uploadLockKey(uploadID)); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		changed, failErr := tx.FailUpload(ctx, s.space(), currentActor.ID, transfer.ID, attachment.ID, normalizeReason(input.Reason), now)
		if failErr != nil {
			return nil, nil, normalizeRepositoryError(failErr)
		}
		if !changed {
			return nil, nil, uploadInvalidError()
		}
		failedAttachment, getErr := tx.GetAttachment(ctx, s.space(), attachment.ID)
		if getErr != nil {
			return nil, nil, normalizeRepositoryError(getErr)
		}
		if failedAttachment == nil {
			return nil, nil, internalError("load failed attachment", errors.New("attachment disappeared"))
		}
		payload, marshalErr := json.Marshal(map[string]any{"attachmentId": failedAttachment.ID, "status": failedAttachment.Status, "attachment": projectAttachment(*failedAttachment, currentActor)})
		if marshalErr != nil {
			return nil, nil, internalError("encode attachment failure event", marshalErr)
		}
		if err := s.writeEvent(ctx, tx, EventInput{Type: "attachment.failed", ActorID: currentActor.ID, ConversationID: pointerValue(failedAttachment.ConversationID), TargetType: attachmentTargetType, TargetID: failedAttachment.ID, PayloadJSON: payload}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, currentActor, input.Meta, AuditInput{Action: "file.upload.failed", TargetType: attachmentTargetType, TargetID: failedAttachment.ID, Result: "failure", Reason: normalizeReason(input.Reason)}, now); err != nil {
			return nil, nil, err
		}
		used, usageErr := tx.UsedTransferBytes(ctx, s.space(), currentActor.ID, dayStart(now))
		if usageErr != nil {
			return nil, nil, normalizeRepositoryError(usageErr)
		}
		return UploadResult{Status: string(TransferFailed), ID: uploadID, UsedToday: maxInt64(used, 0), RemainingBytes: remainingQuota(used, s.dailyQuotaBytes), DailyQuotaBytes: s.dailyQuotaBytes, Attachment: ptrAttachment(projectAttachment(*failedAttachment, currentActor))}, nil, nil
	})
	if err != nil {
		return UploadResult{}, err
	}
	_ = s.cleanupUploadStaging(context.Background(), uploadID, parts, uploadByteSize)
	return value.(UploadResult), nil
}

func (s *Service) failUploadAfterCompletion(ctx context.Context, actorID, uploadID, reason string, meta auth.RequestMeta) error {
	_, err := s.FailUpload(ctx, FailUploadInput{ActorID: actorID, UploadID: uploadID, Reason: reason, Meta: meta})
	return err
}

func (s *Service) ReleaseStaleUploadReservations(ctx context.Context) (int, error) {
	result, err := s.RunUploadMaintenance(ctx, UploadMaintenanceOptions{})
	return result.StaleReservationsFailed, err
}

func storageObjectLockKey(objectID string) string {
	return "workspace-storage-object:" + strings.TrimSpace(objectID)
}

func (s *Service) cleanupUploadStaging(ctx context.Context, uploadID string, parts []UploadPartRecord, uploadByteSize int64) error {
	ctx, cancel := context.WithTimeout(ctx, storageMutationTimeout)
	defer cancel()
	keys := []string{stagingContentKey(uploadID), stagingAssembledKey(uploadID)}
	partNumbers := make(map[int]struct{}, len(parts))
	for _, part := range parts {
		if part.PartNumber > 0 && part.PartNumber <= UploadPartLimit {
			partNumbers[part.PartNumber] = struct{}{}
		}
	}
	if _, count, err := uploadContract(uploadByteSize); err == nil {
		for partNumber := 1; partNumber <= count; partNumber++ {
			partNumbers[partNumber] = struct{}{}
		}
	}
	partList := make([]int, 0, len(partNumbers))
	for partNumber := range partNumbers {
		partList = append(partList, partNumber)
	}
	sort.Ints(partList)
	for _, partNumber := range partList {
		keys = append(keys, stagingPartKey(uploadID, partNumber))
	}
	return s.cleanupStaged(ctx, keys)
}

func (s *Service) cleanupObject(ctx context.Context, object StorageObjectRecord) error {
	if s == nil || s.repo == nil || s.blobStore == nil || strings.TrimSpace(object.ObjectKey) == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, storageMutationTimeout)
	defer cancel()
	if err := s.repo.WithTx(ctx, func(tx Tx) error {
		if err := lockKeys(ctx, tx, storageObjectLockKey(object.ID)); err != nil {
			return err
		}
		cleanup, err := tx.CleanupStorageObject(ctx, object.ID, object, s.nowUTC())
		if err != nil || !cleanup.DeleteObject {
			return err
		}
		physical := object
		if cleanup.Object != nil {
			physical = *cleanup.Object
		}
		// The lock covers physical deletion, not only the reference count and
		// tombstone. Failure rolls back the tombstone so maintenance can retry.
		return normalizeStorageError(s.blobStore.Delete(ctx, physical.BlobObject()))
	}); err != nil {
		return normalizeRepositoryError(err)
	}
	return nil
}

func (s *Service) ListFiles(ctx context.Context, input ListFilesInput) ([]Attachment, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return nil, err
	}
	if denied := s.requireCapability(actor, fileDownloadCapability, workspaceTargetType, ""); denied != nil {
		return nil, s.recordRejection(ctx, actor.ID, input.Meta, fileDownloadCapability, workspaceTargetType, "", "insufficient permission", denied)
	}
	options := input.Options
	scope := strings.ToLower(strings.TrimSpace(options.Scope))
	query := strings.TrimSpace(options.Query)
	if query == "" {
		query = strings.TrimSpace(options.Q)
	}
	limit := options.Limit
	if limit <= 0 {
		limit = DefaultListLimit
	}
	if limit > MaximumListLimit {
		limit = MaximumListLimit
	}
	// Filtering remains in the service so every adapter returns the same
	// projection. Fetch the bounded window before applying optional filters to
	// avoid under-filling a page when an adapter cannot push those filters down.
	records, err := s.repo.ListAttachments(ctx, AttachmentListQuery{SpaceID: s.space(), ViewerID: actor.ID, Scope: scope, ConversationID: strings.TrimSpace(options.ConversationID), UploaderID: strings.TrimSpace(options.UploaderID), Query: query, Limit: MaximumListLimit})
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	items := make([]Attachment, 0, len(records))
	for _, record := range records {
		if record.Status != string(AttachmentAvailable) {
			continue
		}
		if !strings.Contains(strings.ToLower(record.FileName+" "+record.UploaderName+" "+record.ConversationTitle+" "+record.MIMEType+" "+record.Visibility), strings.ToLower(query)) {
			continue
		}
		if scope == "conversation" && (record.Visibility != string(VisibilityConversation) || record.ConversationID == nil) {
			continue
		}
		if scope == "standalone" && (record.Visibility != string(VisibilitySpace) || record.ConversationID != nil) {
			continue
		}
		if scope == "mine" && record.UploaderID != actor.ID {
			continue
		}
		if options.ConversationID != "" && pointerValue(record.ConversationID) != strings.TrimSpace(options.ConversationID) {
			continue
		}
		if options.UploaderID != "" && record.UploaderID != strings.TrimSpace(options.UploaderID) {
			continue
		}
		canRemove, removeErr := s.canRemoveAttachment(ctx, s.repo, actor, record)
		if removeErr != nil {
			return nil, removeErr
		}
		items = append(items, projectAttachmentWithCapabilities(record, actor, canRemove))
		if len(items) >= limit {
			break
		}
	}
	return items, nil
}

func projectAttachment(record AttachmentRecord, actor *auth.Actor) Attachment {
	canRemove := false
	if actor != nil {
		canRemove = record.UploaderID == actor.ID || actor.Role == "owner" || actor.Role == "admin"
	}
	return projectAttachmentWithCapabilities(record, actor, canRemove)
}

func projectAttachmentWithCapabilities(record AttachmentRecord, actor *auth.Actor, canRemove bool) Attachment {
	uploaderName := record.UploaderName
	if uploaderName == "" && actor != nil && record.UploaderID == actor.ID {
		uploaderName = actor.DisplayName
	}
	return Attachment{ID: record.ID, FileName: record.FileName, MIMEType: record.MIMEType, ByteSize: record.ByteSize, Status: record.Status, Visibility: record.Visibility, UploaderID: record.UploaderID, UploaderName: uploaderName, Uploader: PublicUploader{ID: record.UploaderID, DisplayName: uploaderName}, ConversationID: cloneStringPtr(record.ConversationID), CreatedAt: formatTime(record.CreatedAt), CompletedAt: formatTimePtr(record.CompletedAt), AvailableAt: formatTimePtr(record.CompletedAt), Capabilities: AttachmentCapabilities{CanDownload: record.Status == string(AttachmentAvailable), CanRemove: record.Status != string(AttachmentRemoved) && canRemove}}
}

func (s *Service) canRemoveAttachment(ctx context.Context, repo ReadRepository, actor *auth.Actor, record AttachmentRecord) (bool, error) {
	if actor == nil {
		return false, nil
	}
	if record.UploaderID == actor.ID {
		return true, nil
	}
	if actor.Role != "owner" && actor.Role != "admin" || record.Visibility == string(VisibilityPrivateStaging) {
		return false, nil
	}
	if record.ConversationID == nil {
		return true, nil
	}
	participantOnly, err := repo.ParticipantOnlyConversation(ctx, s.space(), *record.ConversationID)
	if err != nil {
		return false, normalizeRepositoryError(err)
	}
	return !participantOnly, nil
}

func (s *Service) GetDownloadableAttachment(ctx context.Context, actorID, attachmentID string, meta auth.RequestMeta) (Attachment, error) {
	actor, err := s.readActor(ctx, actorID)
	if err != nil {
		return Attachment{}, err
	}
	if denied := s.requireCapability(actor, fileDownloadCapability, attachmentTargetType, attachmentID); denied != nil {
		return Attachment{}, s.recordRejection(ctx, actor.ID, meta, fileDownloadCapability, attachmentTargetType, strings.TrimSpace(attachmentID), "insufficient permission", denied)
	}
	if strings.TrimSpace(attachmentID) == "" {
		return Attachment{}, fileNotFoundError()
	}
	record, err := s.repo.GetAttachment(ctx, s.space(), strings.TrimSpace(attachmentID))
	if err != nil {
		return Attachment{}, normalizeRepositoryError(err)
	}
	if record == nil || record.Status != string(AttachmentAvailable) {
		return Attachment{}, fileNotFoundError()
	}
	visible, reason, err := s.attachmentVisible(ctx, s.repo, actor, *record)
	if err != nil {
		return Attachment{}, err
	}
	if !visible {
		denied := permissionDeniedError()
		return Attachment{}, s.recordRejection(ctx, actor.ID, meta, "file.download", attachmentTargetType, record.ID, reason, denied)
	}
	canRemove, err := s.canRemoveAttachment(ctx, s.repo, actor, *record)
	if err != nil {
		return Attachment{}, err
	}
	return projectAttachmentWithCapabilities(*record, actor, canRemove), nil
}

func (s *Service) attachmentVisible(ctx context.Context, repo ReadRepository, actor *auth.Actor, record AttachmentRecord) (bool, string, error) {
	if actor == nil || record.SpaceID != s.space() || record.Status == string(AttachmentRemoved) {
		return false, "file not visible", nil
	}
	switch record.Visibility {
	case string(VisibilitySpace):
		return true, "", nil
	case string(VisibilityPrivateStaging):
		if record.UploaderID == actor.ID {
			return true, "", nil
		}
		return false, "file not visible", nil
	case string(VisibilityConversation):
		if record.ConversationID == nil || strings.TrimSpace(*record.ConversationID) == "" {
			return false, "file not visible", nil
		}
		if record.UploaderID == actor.ID {
			return true, "", nil
		}
		active, err := repo.ConversationMemberActive(ctx, s.space(), *record.ConversationID, actor.ID)
		if err != nil {
			return false, "", normalizeRepositoryError(err)
		}
		if active {
			return true, "", nil
		}
		if actor.Role == "owner" || actor.Role == "admin" {
			participantOnly, participantErr := repo.ParticipantOnlyConversation(ctx, s.space(), *record.ConversationID)
			if participantErr != nil {
				return false, "", normalizeRepositoryError(participantErr)
			}
			if !participantOnly {
				return true, "", nil
			}
		}
		return false, "not a conversation member", nil
	default:
		return false, "file not visible", nil
	}
}

func (s *Service) ReserveDownload(ctx context.Context, input ReserveDownloadInput) (DownloadResult, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return DownloadResult{}, err
	}
	if denied := s.requireCapability(actor, fileDownloadCapability, attachmentTargetType, input.AttachmentID); denied != nil {
		return DownloadResult{}, s.recordRejection(ctx, actor.ID, input.Meta, fileDownloadCapability, attachmentTargetType, strings.TrimSpace(input.AttachmentID), "insufficient permission", denied)
	}
	if _, err := s.ReleaseStaleUploadReservations(ctx); err != nil {
		return DownloadResult{}, err
	}
	value, err := s.withTransaction(ctx, actor.ID, input.Meta, func(tx Tx, currentActor *auth.Actor, now time.Time) (any, *rejection, error) {
		attachmentID := strings.TrimSpace(input.AttachmentID)
		if attachmentID == "" {
			return nil, nil, fileNotFoundError()
		}
		record, getErr := tx.GetAttachment(ctx, s.space(), attachmentID)
		if getErr != nil {
			return nil, nil, normalizeRepositoryError(getErr)
		}
		if record == nil || record.Status != string(AttachmentAvailable) {
			return nil, nil, fileNotFoundError()
		}
		visible, reason, visibilityErr := s.attachmentVisible(ctx, tx, currentActor, *record)
		if visibilityErr != nil {
			return nil, nil, visibilityErr
		}
		if !visible {
			return nil, reject(permissionDeniedError(), "file.download", attachmentTargetType, record.ID, reason), nil
		}
		if err := tx.Lock(ctx, quotaLockKey(s.space(), currentActor.ID, now)); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		used, usageErr := tx.UsedTransferBytes(ctx, s.space(), currentActor.ID, dayStart(now))
		if usageErr != nil {
			return nil, nil, normalizeRepositoryError(usageErr)
		}
		transferID, idErr := s.newID("workspace download")
		if idErr != nil {
			return nil, nil, internalError("generate workspace download id", idErr)
		}
		if record.ByteSize > remainingQuota(used, s.dailyQuotaBytes) {
			transfer := TransferRecord{ID: transferID, SpaceID: s.space(), UserID: currentActor.ID, Direction: string(TransferDownload), ByteSize: record.ByteSize, Status: string(TransferRejected), AttachmentID: stringPtr(record.ID), CreatedAt: now, CompletedAt: timePtr(now)}
			if err := tx.CreateTransfer(ctx, transfer); err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			payload, marshalErr := json.Marshal(map[string]any{"direction": string(TransferDownload), "code": CodeQuotaInsufficient, "message": MessageQuotaInsufficient, "reason": CodeQuotaInsufficient})
			if marshalErr != nil {
				return nil, nil, internalError("encode download quota rejection event", marshalErr)
			}
			if err := s.writeEvent(ctx, tx, EventInput{Type: "transfer.rejected", ActorID: currentActor.ID, TargetType: transferTargetType, TargetID: transferID, PayloadJSON: payload}, now); err != nil {
				return nil, nil, err
			}
			if err := s.writeAudit(ctx, tx, currentActor, input.Meta, AuditInput{Action: "file.download.rejected", TargetType: transferTargetType, TargetID: transferID, Result: "rejected", Reason: "insufficient daily quota"}, now); err != nil {
				return nil, nil, err
			}
			return DownloadResult{Status: string(TransferRejected), UsedToday: maxInt64(used, 0), RemainingBytes: remainingQuota(used, s.dailyQuotaBytes), DailyQuotaBytes: s.dailyQuotaBytes}, nil, nil
		}
		transfer := TransferRecord{ID: transferID, SpaceID: s.space(), UserID: currentActor.ID, Direction: string(TransferDownload), ByteSize: record.ByteSize, Status: string(TransferCompleted), AttachmentID: stringPtr(record.ID), CreatedAt: now, CompletedAt: timePtr(now)}
		if err := tx.CreateTransfer(ctx, transfer); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if err := s.writeAudit(ctx, tx, currentActor, input.Meta, AuditInput{Action: "file.download.reserve", TargetType: attachmentTargetType, TargetID: record.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, currentActor, input.Meta, AuditInput{Action: "file.download.completed", TargetType: attachmentTargetType, TargetID: record.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		canRemove, removeErr := s.canRemoveAttachment(ctx, tx, currentActor, *record)
		if removeErr != nil {
			return nil, nil, removeErr
		}
		return DownloadResult{Status: string(TransferCompleted), ID: transfer.ID, UsedToday: used + record.ByteSize, RemainingBytes: remainingQuota(used+record.ByteSize, s.dailyQuotaBytes), DailyQuotaBytes: s.dailyQuotaBytes, Attachment: ptrAttachment(projectAttachmentWithCapabilities(*record, currentActor, canRemove))}, nil, nil
	})
	if err != nil {
		return DownloadResult{}, err
	}
	return value.(DownloadResult), nil
}

func (s *Service) ReleaseDownloadReservation(ctx context.Context, input ReleaseDownloadInput) (bool, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return false, err
	}
	transferID := normalizeUploadID(input.TransferID)
	if transferID == "" {
		return false, downloadInvalidError()
	}
	value, err := s.withTransaction(ctx, actor.ID, input.Meta, func(tx Tx, currentActor *auth.Actor, now time.Time) (any, *rejection, error) {
		transfer, getErr := tx.GetTransfer(ctx, s.space(), currentActor.ID, transferID, TransferDownload)
		if getErr != nil {
			return nil, nil, normalizeRepositoryError(getErr)
		}
		if transfer == nil || transfer.Status != string(TransferCompleted) {
			return false, nil, nil
		}
		if err := tx.Lock(ctx, "workspace-download:"+transferID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		changed, releaseErr := tx.ReleaseDownload(ctx, s.space(), currentActor.ID, transferID, now)
		if releaseErr != nil {
			return nil, nil, normalizeRepositoryError(releaseErr)
		}
		if !changed {
			return false, nil, nil
		}
		if err := s.writeAudit(ctx, tx, currentActor, input.Meta, AuditInput{Action: "file.download.release", TargetType: transferTargetType, TargetID: transferID, Result: "failure", Reason: "delivery unavailable"}, now); err != nil {
			return nil, nil, err
		}
		return true, nil, nil
	})
	if err != nil {
		return false, err
	}
	return value.(bool), nil
}

// GetCompletedDownload repeats both attachment visibility and transfer
// ownership checks. A transfer id alone is never a bearer capability.
func (s *Service) GetCompletedDownload(ctx context.Context, input CompletedDownloadInput) (DownloadGrant, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return DownloadGrant{}, err
	}
	if denied := s.requireCapability(actor, fileDownloadCapability, attachmentTargetType, input.AttachmentID); denied != nil {
		return DownloadGrant{}, s.recordRejection(ctx, actor.ID, input.Meta, fileDownloadCapability, attachmentTargetType, strings.TrimSpace(input.AttachmentID), "insufficient permission", denied)
	}
	attachmentID := strings.TrimSpace(input.AttachmentID)
	transferID := normalizeUploadID(input.TransferID)
	if attachmentID == "" || transferID == "" {
		return DownloadGrant{}, downloadInvalidError()
	}
	record, err := s.repo.GetAttachment(ctx, s.space(), attachmentID)
	if err != nil {
		return DownloadGrant{}, normalizeRepositoryError(err)
	}
	if record == nil || record.Status != string(AttachmentAvailable) {
		return DownloadGrant{}, downloadInvalidError()
	}
	visible, _, visibilityErr := s.attachmentVisible(ctx, s.repo, actor, *record)
	if visibilityErr != nil {
		return DownloadGrant{}, visibilityErr
	}
	if !visible {
		return DownloadGrant{}, downloadInvalidError()
	}
	transfer, err := s.repo.GetTransfer(ctx, s.space(), actor.ID, transferID, TransferDownload)
	if err != nil {
		return DownloadGrant{}, normalizeRepositoryError(err)
	}
	if transfer == nil || transfer.Status != string(TransferCompleted) || transfer.AttachmentID == nil || *transfer.AttachmentID != record.ID {
		return DownloadGrant{}, downloadInvalidError()
	}
	if transfer.CreatedAt.IsZero() || s.nowUTC().Sub(transfer.CreatedAt.UTC()) > s.downloadGrantTTL {
		return DownloadGrant{}, downloadExpiredError()
	}
	return DownloadGrant{Transfer: *transfer, Attachment: *record}, nil
}

// OpenAttachmentContent reads an authorized attachment without creating a
// transfer-ledger entry. Inline previews do not consume daily download quota.
func (s *Service) OpenAttachmentContent(ctx context.Context, input OpenAttachmentInput) (platformstorage.OpenedObject, error) {
	if _, err := s.GetDownloadableAttachment(ctx, input.ActorID, input.AttachmentID, input.Meta); err != nil {
		return platformstorage.OpenedObject{}, err
	}
	record, err := s.repo.GetAttachment(ctx, s.space(), strings.TrimSpace(input.AttachmentID))
	if err != nil {
		return platformstorage.OpenedObject{}, normalizeRepositoryError(err)
	}
	if record == nil || record.Status != string(AttachmentAvailable) {
		return platformstorage.OpenedObject{}, fileNotFoundError()
	}
	return s.openAttachmentRecord(ctx, *record, input.MaxBytes, "open workspace attachment")
}

// OpenDownload verifies the short-lived logical grant before opening bytes.
// The returned body remains bounded by the registered object size and caller's
// MaxBytes limit; the caller owns and must close it.
func (s *Service) OpenDownload(ctx context.Context, input CompletedDownloadInput) (platformstorage.OpenedObject, error) {
	grant, err := s.GetCompletedDownload(ctx, input)
	if err != nil {
		return platformstorage.OpenedObject{}, err
	}
	return s.openAttachmentRecord(ctx, grant.Attachment, input.MaxBytes, "open workspace download")
}

// RemoveAttachment atomically hides the logical attachment and detaches its
// content-addressed reference. Physical bytes are deleted only after commit
// and only when the registry has no remaining references.
func (s *Service) RemoveAttachment(ctx context.Context, input RemoveAttachmentInput) (RemoveResult, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return RemoveResult{}, err
	}
	attachmentID := strings.TrimSpace(input.AttachmentID)
	if attachmentID == "" {
		return RemoveResult{}, fileNotFoundError()
	}
	parts := make([]UploadPartRecord, 0)
	value, txErr := s.withTransaction(ctx, actor.ID, input.Meta, func(tx Tx, currentActor *auth.Actor, now time.Time) (any, *rejection, error) {
		record, getErr := tx.GetAttachment(ctx, s.space(), attachmentID)
		if getErr != nil {
			return nil, nil, normalizeRepositoryError(getErr)
		}
		if record == nil || record.SpaceID != s.space() || record.Status == string(AttachmentRemoved) {
			return nil, nil, fileNotFoundError()
		}
		canRemove, canRemoveErr := s.canRemoveAttachment(ctx, tx, currentActor, *record)
		if canRemoveErr != nil {
			return nil, nil, canRemoveErr
		}
		if !canRemove {
			return nil, reject(permissionDeniedError(), "file.remove", attachmentTargetType, record.ID, "insufficient permission"), nil
		}
		if record.UploadTransferID != "" {
			listed, listErr := tx.ListUploadParts(ctx, record.UploadTransferID)
			if listErr != nil {
				return nil, nil, normalizeRepositoryError(listErr)
			}
			parts = append(parts, listed...)
		}
		keys := []string{"workspace-attachment:" + record.ID}
		if record.StorageObjectID != "" {
			keys = append(keys, storageObjectLockKey(record.StorageObjectID))
		}
		if err := lockKeys(ctx, tx, keys...); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		previous, changed, detachErr := tx.DetachAttachment(ctx, s.space(), record.ID, currentActor.ID, now)
		if detachErr != nil {
			return nil, nil, normalizeRepositoryError(detachErr)
		}
		if !changed {
			return nil, nil, fileNotFoundError()
		}
		removed, reloadErr := tx.GetAttachment(ctx, s.space(), record.ID)
		if reloadErr != nil {
			return nil, nil, normalizeRepositoryError(reloadErr)
		}
		if removed == nil {
			return nil, nil, internalError("load removed attachment", errors.New("attachment disappeared"))
		}
		payload, marshalErr := json.Marshal(map[string]any{"attachmentId": removed.ID, "status": removed.Status, "attachment": projectAttachment(*removed, currentActor)})
		if marshalErr != nil {
			return nil, nil, internalError("encode attachment removal event", marshalErr)
		}
		if err := s.writeEvent(ctx, tx, EventInput{Type: "attachment.removed", ActorID: currentActor.ID, ConversationID: pointerValue(removed.ConversationID), TargetType: attachmentTargetType, TargetID: removed.ID, PayloadJSON: payload}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, currentActor, input.Meta, AuditInput{Action: "file.remove", TargetType: attachmentTargetType, TargetID: removed.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		return struct {
			result   RemoveResult
			object   *StorageObjectRecord
			staging  string
			byteSize int64
		}{result: RemoveResult{OK: true, AttachmentID: removed.ID}, object: previous, staging: record.UploadTransferID, byteSize: record.ByteSize}, nil, nil
	})
	if txErr != nil {
		return RemoveResult{}, txErr
	}
	removed := value.(struct {
		result   RemoveResult
		object   *StorageObjectRecord
		staging  string
		byteSize int64
	})
	if removed.object != nil {
		if cleanupErr := s.cleanupObject(ctx, *removed.object); cleanupErr != nil {
			return removed.result, cleanupErr
		}
	}
	if removed.staging != "" {
		_ = s.cleanupUploadStaging(context.Background(), removed.staging, parts, removed.byteSize)
	}
	return removed.result, nil
}
