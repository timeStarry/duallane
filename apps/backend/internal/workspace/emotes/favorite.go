package emotes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	favoriteMessageNotFoundCode      = "message.not_found"
	favoriteMessageNotFoundMessage   = "消息不存在"
	favoriteSourceChainLimit         = 64
	favoriteFileStorageMissingCode   = "file.storage_missing"
	favoriteFileStorageMismatchCode  = "file.storage_mismatch"
	workspaceStorageObjectLockPrefix = "workspace-storage-object:"
)

var favoriteCustomEmoteID = regexp.MustCompile(`^[a-f0-9-]{36}$`)

// FavoriteFromMessageInput is the domain input for the message-action
// favorite operation. Exactly one of AttachmentID, EmoteKey, or
// CustomEmoteID must be present; transport adapters should pass the values
// without deciding which source wins.
type FavoriteFromMessageInput struct {
	ActorID       string
	MessageID     string
	AttachmentID  string
	EmoteKey      string
	CustomEmoteID string
	Meta          auth.RequestMeta
}

// FavoriteMessageRecord is the minimal authorized message projection needed
// to validate an action. ContentJSON is untrusted message data and is never
// returned from the emote service.
type FavoriteMessageRecord struct {
	ID          string
	SpaceID     string
	ContentJSON []byte
}

// FavoriteAttachmentRecord is the minimal source projection needed before an
// authorized attachment-content reader is called.
type FavoriteAttachmentRecord struct {
	ID       string
	SpaceID  string
	Status   string
	FileName string
	MIMEType string
	ByteSize int64
}

// FavoriteSourceRepository is intentionally optional from ReadRepository so
// existing narrow fakes and adapters do not gain message SQL by accident.
// PGRepository implements it with the visible-message and linked-attachment
// predicates used by the Node service.
type FavoriteSourceRepository interface {
	GetVisibleFavoriteMessage(ctx context.Context, spaceID, actorID, messageID string) (*FavoriteMessageRecord, error)
	GetFavoriteMessageAttachment(ctx context.Context, spaceID, messageID, attachmentID string) (*FavoriteAttachmentRecord, error)
}

// AttachmentContentInput is the narrow cross-domain seam for reading an
// already-authorized attachment. The files service remains responsible for
// object access, legacy/canonical fallback, and its own capability checks.
type AttachmentContentInput struct {
	ActorID      string
	AttachmentID string
	MaxBytes     int64
	Meta         auth.RequestMeta
}

// AttachmentContentReader must return a bounded, metadata-validated stream.
// It must not create a download transfer or consume download quota for this
// inline favorite operation. The caller owns and closes the returned body.
type AttachmentContentReader interface {
	OpenAttachmentContent(ctx context.Context, input AttachmentContentInput) (platformstorage.OpenedObject, error)
}

// FavoriteFromMessage validates the visible message action and dispatches to
// the same built-in, processed-attachment, and canonical-reference paths used
// by the Node service. Message visibility is checked before source selection so
// an inaccessible message never reveals which source was requested.
func (s *Service) FavoriteFromMessage(ctx context.Context, input FavoriteFromMessageInput) (*CustomEmote, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return nil, err
	}
	sourceRepository, ok := s.repo.(FavoriteSourceRepository)
	if !ok {
		return nil, internalError("favorite workspace emote", errors.New("favorite source repository is required"))
	}
	messageID := strings.TrimSpace(input.MessageID)
	message, err := sourceRepository.GetVisibleFavoriteMessage(ctx, s.space(), actor.ID, messageID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if message == nil || message.ID != messageID || message.SpaceID != s.space() {
		return nil, notFoundError(favoriteMessageNotFoundCode, favoriteMessageNotFoundMessage)
	}

	sourceCount := 0
	if input.AttachmentID != "" {
		sourceCount++
	}
	if input.EmoteKey != "" {
		sourceCount++
	}
	if input.CustomEmoteID != "" {
		sourceCount++
	}
	if sourceCount != 1 {
		return nil, s.rejectFavorite(ctx, actor.ID, input.Meta,
			validationError(CodeEmoteInvalidSource, "请选择一个可收藏的表情"))
	}

	blocks := parseFavoriteMessageBlocks(message.ContentJSON)
	if input.AttachmentID != "" {
		return s.favoriteAttachmentFromMessage(ctx, input, actor.ID, sourceRepository)
	}
	if input.EmoteKey != "" {
		item, ok := s.catalogImage(input.EmoteKey)
		if !ok || !favoriteMessageContainsBuiltin(blocks, item, input.EmoteKey) {
			return nil, s.rejectFavorite(ctx, actor.ID, input.Meta,
				validationError(CodeEmoteInvalidSource, "该消息没有可收藏的表情"))
		}
		return s.CreateBuiltinFavorite(ctx, actor.ID, input.EmoteKey, input.Meta)
	}

	customID := strings.TrimSpace(input.CustomEmoteID)
	if !favoriteCustomEmoteID.MatchString(customID) || !favoriteMessageContainsCustom(blocks, customID) {
		return nil, s.rejectFavorite(ctx, actor.ID, input.Meta,
			validationError(CodeEmoteInvalidSource, "该消息没有可收藏的表情"))
	}
	source, err := s.repo.GetCustomEmote(ctx, customID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if source == nil {
		return nil, s.rejectFavorite(ctx, actor.ID, input.Meta,
			validationError(CodeEmoteInvalidSource, "收藏表情已不可用"))
	}
	return s.favoriteCustomReference(ctx, actor.ID, source, input.Meta)
}

func (s *Service) rejectFavorite(ctx context.Context, actorID string, meta auth.RequestMeta, err *Error) error {
	if err == nil {
		return nil
	}
	return s.recordRejected(ctx, actorID, meta,
		mutationEvidence{action: "emote.create", targetType: "emote"}, err)
}

func (s *Service) favoriteAttachmentFromMessage(
	ctx context.Context,
	input FavoriteFromMessageInput,
	actorID string,
	sourceRepository FavoriteSourceRepository,
) (*CustomEmote, error) {
	// The Node operation does not require a marker in the content for an
	// attachment: the authorized message_attachments row is the source proof.
	attachment, err := sourceRepository.GetFavoriteMessageAttachment(
		ctx, s.space(), strings.TrimSpace(input.MessageID), input.AttachmentID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if attachment == nil || attachment.SpaceID != s.space() || attachment.Status != "available" || !isSupportedEmoteMIME(attachment.MIMEType) {
		return nil, s.rejectFavorite(ctx, actorID, input.Meta,
			validationError(CodeEmoteInvalidSource, "该消息没有可收藏的图片"))
	}
	if attachment.ByteSize < 1 || attachment.ByteSize > MaxInputBytes {
		return nil, s.rejectFavorite(ctx, actorID, input.Meta,
			NewError(CodeEmoteSourceTooLarge, MessageEmoteSourceTooLarge, 413))
	}
	if s.attachmentContentReader == nil {
		return nil, s.rejectFavorite(ctx, actorID, input.Meta,
			NewError(CodeEmoteProcessingUnavailable, MessageEmoteProcessingUnavailable, 503))
	}
	opened, err := s.attachmentContentReader.OpenAttachmentContent(ctx, AttachmentContentInput{
		ActorID: actorID, AttachmentID: attachment.ID, MaxBytes: MaxInputBytes, Meta: input.Meta,
	})
	if err != nil {
		return nil, normalizeFavoriteAttachmentError(err)
	}
	if opened.Body == nil {
		return nil, favoriteAttachmentReadFailure()
	}
	defer opened.Body.Close()
	if opened.ByteSize != attachment.ByteSize {
		return nil, favoriteAttachmentReadFailure()
	}
	content, err := readFavoriteAttachment(ctx, opened.Body, attachment.ByteSize)
	if err != nil {
		return nil, normalizeFavoriteAttachmentError(err)
	}
	return s.Upload(ctx, UploadInput{
		ActorID: actorID,
		Content: bytes.NewReader(content),
		Source: UploadSource{
			Type: "attachment", AttachmentID: attachment.ID,
			FileName: attachment.FileName, MIMEType: strings.ToLower(strings.TrimSpace(attachment.MIMEType)),
		},
		AddToLibrary: true,
		Meta:         input.Meta,
	})
}

func isSupportedEmoteMIME(value string) bool {
	_, ok := supportedMIMETypes[strings.ToLower(strings.TrimSpace(value))]
	return ok
}

func readFavoriteAttachment(ctx context.Context, body io.Reader, expectedSize int64) ([]byte, error) {
	if expectedSize < 1 || expectedSize > MaxInputBytes {
		return nil, NewError(CodeEmoteSourceTooLarge, MessageEmoteSourceTooLarge, 413)
	}
	limited := io.LimitReader(&contextReader{ctx: ctx, reader: body}, expectedSize+1)
	content, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(content)) != expectedSize {
		return nil, favoriteAttachmentReadFailure()
	}
	return content, nil
}

func favoriteAttachmentReadFailure() *Error {
	return NewError(favoriteFileStorageMismatchCode, "文件内容不可用", 500)
}

func normalizeFavoriteAttachmentError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var domainErr *Error
	if errors.As(err, &domainErr) && domainErr != nil {
		return domainErr
	}
	var storageErr *platformstorage.Error
	if !errors.As(err, &storageErr) || storageErr == nil {
		return internalError("read favorite attachment", err)
	}
	switch storageErr.Code {
	case favoriteFileStorageMissingCode, "storage.object_not_found":
		return NewError(favoriteFileStorageMissingCode, "文件内容不可用", 404)
	case "file.storage_too_large", "emote.source_too_large":
		return NewError(CodeEmoteSourceTooLarge, MessageEmoteSourceTooLarge, 413)
	case favoriteFileStorageMismatchCode:
		return favoriteAttachmentReadFailure()
	}
	if storageErr.StatusCode == 413 {
		return NewError(CodeEmoteSourceTooLarge, MessageEmoteSourceTooLarge, 413)
	}
	// The reader may be backed by workspace/files. Its domain errors already
	// carry a safe code/status pair and the HTTP adapter knows how to project
	// them; do not erase concurrent authorization or physical-read outcomes.
	return err
}

func (s *Service) favoriteCustomReference(ctx context.Context, actorID string, source *CustomEmoteRecord, meta auth.RequestMeta) (*CustomEmote, error) {
	emoteID, err := s.newID("workspace referenced emote")
	if err != nil {
		return nil, internalError("generate workspace referenced emote id", err)
	}
	result, mutationErr := s.mutate(ctx, actorID, meta, mutationEvidence{
		action: "emote.create", eventType: "emote.created", targetType: "emote", targetID: emoteID,
		payload: map[string]any{"emoteId": emoteID, "source": "custom"},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		if err := tx.Lock(ctx, "workspace-emote-library:"+actor.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		// The source was read before the mutation transaction. Refresh it here so
		// a concurrent source update cannot make this insert copy a stale storage
		// projection. The object lock below then serializes the refreshed
		// projection with canonical-object cleanup.
		freshSource, err := tx.GetCustomEmote(ctx, source.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if freshSource == nil || freshSource.ID != source.ID {
			return nil, validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource), nil
		}
		source = freshSource
		resource, err := resolveFavoriteResource(ctx, tx, source)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		digest, validationErr := validateFavoriteResource(resource)
		if validationErr != nil {
			return nil, validationErr, nil
		}
		if resource.StorageObjectID != "" {
			if err := tx.Lock(ctx, workspaceStorageObjectLockKey(resource.StorageObjectID)); err != nil {
				return nil, nil, normalizeError(err)
			}
			object, err := tx.GetStorageObject(ctx, resource.StorageObjectID, false)
			if err != nil {
				return nil, nil, normalizeError(err)
			}
			if object == nil || strings.TrimSpace(object.SHA256) == "" {
				return nil, validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource), nil
			}
			objectDigest, err := platformstorage.NormalizeSHA256(object.SHA256)
			if err != nil || objectDigest != digest || (resource.ByteSize != nil && object.ByteSize != *resource.ByteSize) {
				return nil, validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource), nil
			}
			if err := platformstorage.ValidateCanonicalKey(object.ObjectKey, objectDigest); err != nil {
				return nil, validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource), nil
			}
		}

		duplicate, err := s.findReusableLocalEmote(ctx, tx, actor.ID, digest)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if duplicate != nil {
			if _, err := tx.RestoreCustomEmote(ctx, actor.ID, duplicate.ID, now); err != nil {
				return nil, nil, normalizeError(err)
			}
			if err := s.ensurePlacement(ctx, tx, actor.ID, duplicate.ID, "", true, now); err != nil {
				if domainErr, ok := err.(*Error); ok {
					return nil, domainErr, nil
				}
				return nil, nil, err
			}
			current, err := tx.GetCustomEmote(ctx, duplicate.ID)
			if err != nil {
				return nil, nil, normalizeError(err)
			}
			if current == nil {
				return nil, nil, internalError("restore workspace referenced emote", errors.New("restored emote disappeared"))
			}
			return current.Public(s.catalog), nil, nil
		}

		usage, err := tx.EmoteUsage(ctx, actor.ID, "")
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		nextBytes := valueOrZero(resource.ByteSize)
		if nextBytes < 0 || nextBytes > MaxTotalBytes || usage.TotalBytes > MaxTotalBytes-nextBytes {
			return nil, conflictError(CodeEmoteStorageLimitReached, MessageEmoteStorageLimitReached), nil
		}
		fileName := resource.OriginalFileName
		if strings.TrimSpace(fileName) == "" {
			fileName = resource.Label + ".webp"
		}
		label := nonEmpty(source.Label, resource.Label)
		record := CustomEmoteRecord{
			ID: emoteID, UserID: actor.ID, SourceType: "custom", SourceCustomEmoteID: resource.ID,
			OriginalFileName: fileName, OriginalMIMEType: "image/webp", Label: label,
			NormalizedMIMEType: "image/webp", ByteSize: cloneFavoriteInt64(resource.ByteSize),
			Width: cloneFavoriteInt(resource.Width), Height: cloneFavoriteInt(resource.Height),
			FrameCount: cloneFavoriteInt(resource.FrameCount), DurationMS: cloneFavoriteInt64(resource.DurationMS),
			SHA256: digest, StorageKey: resource.StorageKey, StorageObjectID: resource.StorageObjectID,
			SortOrder: -1, CreatedAt: now,
		}
		inserted, err := tx.InsertCustomEmote(ctx, record)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if !inserted {
			return nil, conflictError(CodeEmoteInvalidReference, MessageEmoteInvalidReference), nil
		}
		if err := s.ensurePlacement(ctx, tx, actor.ID, emoteID, "", true, now); err != nil {
			if domainErr, ok := err.(*Error); ok {
				return nil, domainErr, nil
			}
			return nil, nil, err
		}
		return record.Public(s.catalog), nil, nil
	})
	if mutationErr != nil {
		return nil, mutationErr
	}
	public, ok := result.(*CustomEmote)
	if !ok || public == nil {
		return nil, internalError("project workspace referenced emote", errors.New("invalid emote result"))
	}
	return public, nil
}

// workspaceStorageObjectLockKey is shared with emote cleanup and the files
// canonical-object lifecycle. It must remain a transaction advisory lock key
// for the complete reference-establishing mutation, not only the object read.
func workspaceStorageObjectLockKey(objectID string) string {
	return workspaceStorageObjectLockPrefix + strings.TrimSpace(objectID)
}

func resolveFavoriteResource(ctx context.Context, repository ReadRepository, row *CustomEmoteRecord) (*CustomEmoteRecord, error) {
	if repository == nil {
		return nil, errors.New("favorite emote repository is required")
	}
	current := row
	seen := make(map[string]struct{}, favoriteSourceChainLimit)
	for depth := 0; current != nil && depth < favoriteSourceChainLimit; depth++ {
		if current.StorageObjectID != "" || current.StorageKey != "" {
			return current, nil
		}
		if current.ID == "" {
			return nil, nil
		}
		if _, ok := seen[current.ID]; ok {
			return nil, nil
		}
		seen[current.ID] = struct{}{}
		if current.SourceCustomEmoteID == "" {
			return nil, nil
		}
		next, err := repository.GetCustomEmote(ctx, current.SourceCustomEmoteID)
		if err != nil {
			return nil, err
		}
		current = next
	}
	return nil, nil
}

func validateFavoriteResource(resource *CustomEmoteRecord) (string, *Error) {
	if resource == nil || (resource.StorageObjectID == "" && resource.StorageKey == "") {
		return "", validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource)
	}
	digest, err := platformstorage.NormalizeSHA256(resource.SHA256)
	if err != nil {
		return "", validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource)
	}
	if resource.ByteSize != nil && *resource.ByteSize < 0 {
		return "", validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource)
	}
	return digest, nil
}

func (s *Service) findReusableLocalEmote(ctx context.Context, repository ReadRepository, actorID, digest string) (*CustomEmoteRecord, error) {
	duplicate, err := repository.FindCustomEmoteByDigest(ctx, actorID, digest)
	if err != nil || duplicate == nil {
		return duplicate, err
	}
	readonly, err := repository.IsEmoteSubscriptionReadOnly(ctx, actorID, duplicate.ID)
	if err != nil {
		return nil, err
	}
	if !readonly {
		return duplicate, nil
	}
	local, err := repository.IsEmoteLocallyPlaced(ctx, actorID, duplicate.ID)
	if err != nil {
		return nil, err
	}
	if !local {
		return nil, nil
	}
	return duplicate, nil
}

func cloneFavoriteInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneFavoriteInt(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

type favoriteMessageBlock struct {
	Type      string
	Text      json.RawMessage
	Shortcode json.RawMessage
}

func parseFavoriteMessageBlocks(content []byte) []favoriteMessageBlock {
	var document struct {
		Blocks json.RawMessage `json:"blocks"`
	}
	if err := json.Unmarshal(content, &document); err != nil || len(bytes.TrimSpace(document.Blocks)) == 0 {
		return nil
	}
	trimmed := bytes.TrimSpace(document.Blocks)
	if trimmed[0] != '[' {
		return nil
	}
	var rawBlocks []json.RawMessage
	if err := json.Unmarshal(trimmed, &rawBlocks); err != nil {
		return nil
	}
	blocks := make([]favoriteMessageBlock, 0, len(rawBlocks))
	for _, rawBlock := range rawBlocks {
		var block favoriteMessageBlock
		if err := json.Unmarshal(rawBlock, &block); err == nil {
			blocks = append(blocks, block)
		}
	}
	return blocks
}

func favoriteMessageContainsBuiltin(blocks []favoriteMessageBlock, item CatalogItem, emoteKey string) bool {
	tokens := []string{item.Token, "[" + strings.TrimSpace(emoteKey) + "]"}
	for _, block := range blocks {
		if block.Type != "text" {
			continue
		}
		text := favoriteNodeString(block.Text)
		for _, token := range tokens {
			if token != "" && strings.Contains(text, token) {
				return true
			}
		}
	}
	return false
}

func favoriteMessageContainsCustom(blocks []favoriteMessageBlock, customID string) bool {
	wanted := "custom:" + customID
	for _, block := range blocks {
		if block.Type != "emoji" {
			continue
		}
		var shortcode string
		if json.Unmarshal(block.Shortcode, &shortcode) == nil && shortcode == wanted {
			return true
		}
	}
	return false
}

// favoriteNodeString covers the JSON scalar values that can occur in a
// validated text block and keeps token matching aligned with JavaScript's
// String(block.text) for malformed-but-readable message JSON.
func favoriteNodeString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "undefined"
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "undefined"
	}
	var text string
	if trimmed[0] == '"' && json.Unmarshal(trimmed, &text) == nil {
		return text
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return "null"
	}
	if bytes.Equal(trimmed, []byte("true")) || bytes.Equal(trimmed, []byte("false")) {
		return string(trimmed)
	}
	if trimmed[0] == '[' {
		var values []json.RawMessage
		if json.Unmarshal(trimmed, &values) == nil {
			parts := make([]string, 0, len(values))
			for _, value := range values {
				if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					parts = append(parts, "")
				} else {
					parts = append(parts, favoriteNodeString(value))
				}
			}
			return strings.Join(parts, ",")
		}
	}
	if trimmed[0] == '{' {
		return "[object Object]"
	}
	if number, err := strconv.ParseFloat(string(trimmed), 64); err == nil {
		return strconv.FormatFloat(number, 'g', -1, 64)
	}
	return ""
}
