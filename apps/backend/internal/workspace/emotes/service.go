package emotes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// MediaProcessor is the explicit boundary for compatibility-tested image
// decoding and WebP normalization. Runtime composition supplies the concrete
// processor so the domain remains independent of libvips and CGO.
type MediaProcessor interface {
	Process(ctx context.Context, input []byte, source UploadSource) (ProcessedUpload, error)
}

type Clock func() time.Time
type IDFactory func() (string, error)

type ServiceOptions struct {
	Repository Repository
	BlobStore  platformstorage.BlobStore
	Catalog    *Catalog
	Processor  MediaProcessor
	SpaceID    string
	Now        Clock
	IDFactory  IDFactory
}

type Service struct {
	repo      Repository
	blobStore platformstorage.BlobStore
	catalog   *Catalog
	processor MediaProcessor
	spaceID   string
	now       Clock
	idFactory IDFactory
}

type mutationEvidence struct {
	action     string
	eventType  string
	targetType string
	targetID   string
	payload    map[string]any
}

type mutationResult struct {
	value       any
	cleanupRows []CustomEmoteRecord
}

var defaultIDFactory = func() (string, error) {
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
		idFactory = defaultIDFactory
	}
	return &Service{
		repo: options.Repository, blobStore: options.BlobStore, catalog: options.Catalog,
		processor: options.Processor, spaceID: spaceID, now: now, idFactory: idFactory,
	}
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

func (s *Service) Catalog() *Catalog {
	if s == nil {
		return nil
	}
	return s.catalog
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

func (s *Service) lookupActor(ctx context.Context, repository ReadRepository, actorID string) (*auth.Actor, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	if repository == nil {
		return nil, internalError("lookup workspace emote actor", errors.New("repository is required"))
	}
	actor, err := repository.LookupActor(ctx, s.space(), actorID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if actor == nil || strings.TrimSpace(actor.ID) == "" || actor.ID != actorID || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	if actor.Kind != "" && actor.Kind != "human" {
		return nil, identityForbiddenError()
	}
	return actor, nil
}

func (s *Service) readActor(ctx context.Context, actorID string) (*auth.Actor, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace emote service", errors.New("repository is required"))
	}
	return s.lookupActor(ctx, s.repo, actorID)
}

func (s *Service) mutate(ctx context.Context, actorID string, meta auth.RequestMeta, evidence mutationEvidence, callback func(Tx, *auth.Actor, time.Time) (any, *Error, error)) (any, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace emote service", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	if callback == nil {
		return nil, internalError("workspace emote mutation", errors.New("callback is required"))
	}
	meta = meta.Safe()
	var result any
	var rejected *Error
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return errors.New("workspace emote transaction is required")
		}
		actor, err := s.lookupActor(ctx, tx, actorID)
		if err != nil {
			return err
		}
		now := s.nowUTC()
		result, rejected, err = callback(tx, actor, now)
		if err != nil {
			return err
		}
		if rejected != nil {
			return s.writeAudit(ctx, tx, actor, meta, evidence, "rejected", rejected.Code, now)
		}
		return s.writeEvidence(ctx, tx, actor, meta, evidence, "success", "", now)
	})
	if err != nil {
		return nil, normalizeError(err)
	}
	if rejected != nil {
		return nil, rejected
	}
	return result, nil
}

func (s *Service) writeEvidence(ctx context.Context, tx Tx, actor *auth.Actor, meta auth.RequestMeta, evidence mutationEvidence, result, reason string, now time.Time) error {
	audit := AuditInput{
		SpaceID: s.space(), ActorUserID: actor.ID, ActorGitHubLogin: actor.GitHubLogin,
		Action: evidence.action, TargetType: evidence.targetType, TargetID: evidence.targetID,
		Result: result, Reason: reason, RequestID: meta.RequestID, IPAddress: meta.IPAddress,
		UserAgent: meta.UserAgent, CreatedAt: now,
	}
	if err := tx.WriteAudit(ctx, audit); err != nil {
		return internalError("write workspace emote audit", err)
	}
	if strings.TrimSpace(evidence.eventType) == "" {
		return nil
	}
	payload := evidence.payload
	if payload == nil {
		payload = map[string]any{}
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return internalError("encode workspace emote event", err)
	}
	if err := tx.WriteEvent(ctx, EventInput{
		SpaceID: s.space(), Type: evidence.eventType, ActorID: actor.ID,
		TargetType: evidence.targetType, TargetID: evidence.targetID,
		PayloadJSON: payloadJSON, CreatedAt: now,
	}); err != nil {
		return internalError("write workspace emote event", err)
	}
	return nil
}

func (s *Service) writeAudit(ctx context.Context, tx Tx, actor *auth.Actor, meta auth.RequestMeta, evidence mutationEvidence, result, reason string, now time.Time) error {
	return s.writeEvidence(ctx, tx, actor, meta, mutationEvidence{
		action: evidence.action, targetType: evidence.targetType, targetID: evidence.targetID,
	}, result, reason, now)
}

func (s *Service) recordRejected(ctx context.Context, actorID string, meta auth.RequestMeta, evidence mutationEvidence, err *Error) error {
	if err == nil {
		return nil
	}
	_, transactionErr := s.mutate(ctx, actorID, meta, evidence, func(_ Tx, _ *auth.Actor, _ time.Time) (any, *Error, error) {
		return nil, err, nil
	})
	if transactionErr != nil {
		return transactionErr
	}
	return err
}

func (s *Service) visiblePacks() []PublicCatalogPack {
	if s == nil || s.catalog == nil {
		return []PublicCatalogPack{}
	}
	return s.catalog.VisiblePacks()
}

func (s *Service) settingsFromRecord(record SettingsRecord) EmoteSettings {
	available := s.visiblePacks()
	fallback := make([]string, 0, len(available))
	allowed := make(map[string]struct{}, len(available))
	for _, pack := range available {
		allowed[pack.ID] = struct{}{}
		if pack.DefaultEnabled {
			fallback = append(fallback, pack.ID)
		}
	}
	if len(fallback) == 0 && len(available) > 0 {
		fallback = append(fallback, available[0].ID)
	}
	enabled := append([]string(nil), fallback...)
	var requested []string
	if json.Unmarshal([]byte(record.EnabledPackIDsJSON), &requested) == nil {
		candidate := make([]string, 0, len(requested))
		seen := make(map[string]struct{}, len(requested))
		for _, value := range requested {
			if _, ok := allowed[value]; !ok {
				continue
			}
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			candidate = append(candidate, value)
		}
		if len(candidate) > 0 {
			enabled = candidate
		}
	}
	if enabled == nil {
		enabled = []string{}
	}
	return EmoteSettings{
		AvailablePacks: available, EnabledPackIDs: enabled,
		ClickImageEmoteToSend: record.ClickImageEmoteToSend,
		ReplyAutoMention:      record.ReplyAutoMention, MinimumEnabled: 1,
	}
}

func (s *Service) GetSettings(ctx context.Context, actorID string) (EmoteSettings, error) {
	if _, err := s.readActor(ctx, actorID); err != nil {
		return EmoteSettings{}, err
	}
	record, err := s.repo.GetSettings(ctx, strings.TrimSpace(actorID))
	if err != nil {
		return EmoteSettings{}, normalizeError(err)
	}
	return s.settingsFromRecord(record), nil
}

func (s *Service) UpdateSettings(ctx context.Context, actorID string, input UpdateSettingsInput, meta auth.RequestMeta) (EmoteSettings, error) {
	evidence := mutationEvidence{action: "emote.settings.update", eventType: "emote.settings.updated", targetType: "user", targetID: strings.TrimSpace(actorID), payload: map[string]any{"userId": strings.TrimSpace(actorID)}}
	result, err := s.mutate(ctx, actorID, meta, evidence, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		currentRecord, err := tx.GetSettings(ctx, actor.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		current := s.settingsFromRecord(currentRecord)
		nextIDs := append([]string(nil), current.EnabledPackIDs...)
		if input.EnabledPackIDs != nil {
			allowed := make(map[string]struct{}, len(current.AvailablePacks))
			for _, pack := range current.AvailablePacks {
				allowed[pack.ID] = struct{}{}
			}
			requested := append([]string(nil), (*input.EnabledPackIDs)...)
			seen := make(map[string]struct{}, len(requested))
			nextIDs = make([]string, 0, len(requested))
			for _, value := range requested {
				value = strings.TrimSpace(value)
				if _, duplicate := seen[value]; duplicate {
					continue
				}
				seen[value] = struct{}{}
				if _, ok := allowed[value]; ok {
					nextIDs = append(nextIDs, value)
				}
			}
			if len(nextIDs) < 1 || len(nextIDs) != len(seen) {
				return nil, validationError(CodeEmotePackRequired, MessageEmotePackRequired), nil
			}
		}
		click := current.ClickImageEmoteToSend
		if input.ClickImageEmoteToSend != nil {
			click = *input.ClickImageEmoteToSend
		}
		reply := current.ReplyAutoMention
		if input.ReplyAutoMention != nil {
			reply = *input.ReplyAutoMention
		}
		encoded, err := json.Marshal(nextIDs)
		if err != nil {
			return nil, nil, internalError("encode emote settings", err)
		}
		if err := tx.UpsertSettings(ctx, actor.ID, string(encoded), click, reply, now); err != nil {
			return nil, nil, normalizeError(err)
		}
		updated := current
		updated.EnabledPackIDs = nextIDs
		updated.ClickImageEmoteToSend = click
		updated.ReplyAutoMention = reply
		return s.settingsFromRecord(SettingsRecord{
			EnabledPackIDsJSON: string(encoded), ClickImageEmoteToSend: click, ReplyAutoMention: reply,
		}), nil, nil
	})
	if err != nil {
		return EmoteSettings{}, err
	}
	return result.(EmoteSettings), nil
}

func normalizeUploadSource(source UploadSource) (UploadSource, *Error) {
	source.Type = strings.TrimSpace(source.Type)
	if source.Type == "" {
		source.Type = "upload"
	}
	if source.Type != "upload" && source.Type != "attachment" && source.Type != "custom" {
		return UploadSource{}, validationError(CodeEmoteInvalidSource, MessageEmoteInvalidReference)
	}
	source.MIMEType = strings.ToLower(strings.TrimSpace(source.MIMEType))
	if _, ok := supportedMIMETypes[source.MIMEType]; !ok {
		return UploadSource{}, validationError(CodeEmoteInvalidFormat, MessageEmoteInvalidFormat)
	}
	fileName, err := normalizeFileName(source.FileName)
	if err != nil {
		return UploadSource{}, err
	}
	source.FileName = fileName
	return source, nil
}

func normalizeFileName(value string) (string, *Error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || containsControl(value) {
		return "", validationError(CodeEmoteInvalidFileName, MessageEmoteInvalidFileName)
	}
	value = strings.ReplaceAll(value, "\\", "/")
	parts := strings.Split(value, "/")
	base := "收藏表情"
	if len(parts) > 0 && strings.TrimSpace(parts[len(parts)-1]) != "" {
		base = strings.TrimSpace(parts[len(parts)-1])
	}
	if len([]byte(base)) > MaxFileNameBytes {
		for len([]byte(base)) > MaxFileNameBytes {
			_, size := utf8.DecodeLastRuneInString(base)
			base = base[:len(base)-size]
		}
	}
	if base == "" {
		return "", validationError(CodeEmoteInvalidFileName, MessageEmoteInvalidFileName)
	}
	return base, nil
}

func containsControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func (s *Service) PreflightUpload(ctx context.Context, source UploadSource, content io.Reader) (PreflightResult, error) {
	source, sourceErr := normalizeUploadSource(source)
	if sourceErr != nil {
		return PreflightResult{}, sourceErr
	}
	if content == nil {
		return PreflightResult{}, validationError(CodeEmoteInvalidContent, MessageEmoteInvalidContent)
	}
	limited := io.LimitReader(content, MaxInputBytes+1)
	bytes, err := io.ReadAll(&contextReader{ctx: ctx, reader: limited})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return PreflightResult{}, err
		}
		return PreflightResult{}, internalError("read emote upload", err)
	}
	if int64(len(bytes)) > MaxInputBytes {
		return PreflightResult{}, NewError(CodeEmoteInputTooLarge, MessageEmoteInputTooLarge, 413)
	}
	if len(bytes) == 0 {
		return PreflightResult{}, validationError(CodeEmoteInvalidContent, MessageEmoteInvalidContent)
	}
	return PreflightResult{Source: source, Content: bytes, ByteSize: int64(len(bytes))}, nil
}

func (s *Service) Upload(ctx context.Context, input UploadInput) (*CustomEmote, error) {
	if _, err := s.readActor(ctx, input.ActorID); err != nil {
		return nil, err
	}
	preflight, err := s.PreflightUpload(ctx, input.Source, input.Content)
	if err != nil {
		if domainErr, ok := err.(*Error); ok {
			return nil, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.create", targetType: "emote"}, domainErr)
		}
		return nil, err
	}
	if s.processor == nil {
		domainErr := NewError(CodeEmoteProcessingUnavailable, MessageEmoteProcessingUnavailable, 503)
		return nil, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.create", targetType: "emote"}, domainErr)
	}
	processed, processErr := s.processor.Process(ctx, preflight.Content, preflight.Source)
	if processErr != nil {
		var domainErr *Error
		if !errors.As(processErr, &domainErr) {
			domainErr = validationError(CodeEmoteProcessFailed, MessageEmoteProcessFailed)
		}
		return nil, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.create", targetType: "emote"}, domainErr)
	}
	return s.StoreProcessed(ctx, StoreProcessedInput{
		ActorID: input.ActorID, Source: preflight.Source, Processed: processed,
		CollectionID: strings.TrimSpace(input.CollectionID), AddToLibrary: input.AddToLibrary, Meta: input.Meta,
	})
}

func validateProcessedUpload(processed *ProcessedUpload, source UploadSource) (*Error, string) {
	if processed == nil || len(processed.Content) == 0 {
		return validationError(CodeEmoteInvalidContent, MessageEmoteInvalidContent), ""
	}
	if int64(len(processed.Content)) != processed.ByteSize || processed.ByteSize <= 0 {
		return validationError(CodeEmoteInvalidContent, MessageEmoteInvalidContent), ""
	}
	if processed.ByteSize > MaxOutputBytes {
		return validationError(CodeEmoteOutputTooLarge, MessageEmoteOutputTooLarge), ""
	}
	if processed.NormalizedMIMEType == "" {
		processed.NormalizedMIMEType = "image/webp"
	}
	if strings.ToLower(strings.TrimSpace(processed.NormalizedMIMEType)) != "image/webp" {
		return validationError(CodeEmoteProcessFailed, MessageEmoteProcessFailed), ""
	}
	detected := strings.ToLower(strings.TrimSpace(processed.DetectedMIMEType))
	if detected == "" {
		detected = source.MIMEType
		processed.DetectedMIMEType = detected
	}
	if _, ok := supportedMIMETypes[detected]; !ok {
		return validationError(CodeEmoteInvalidFormat, MessageEmoteInvalidFormat), ""
	}
	if processed.Width <= 0 || processed.Height <= 0 || processed.Width > MaxDimension || processed.Height > MaxDimension || int64(processed.Width)*int64(processed.Height) > MaxPixels {
		return validationError(CodeEmoteDimensionsExceeded, MessageEmoteDimensionsExceeded), ""
	}
	if processed.FrameCount <= 0 {
		processed.FrameCount = 1
	}
	if processed.FrameCount > MaxFrames || processed.DurationMS < 0 || processed.DurationMS > MaxDurationMillis {
		return validationError(CodeEmoteAnimationTooComplex, MessageEmoteAnimationTooComplex), ""
	}
	digest := canonicalDigest(processed.Content)
	if processed.SHA256 != "" && !strings.EqualFold(strings.TrimSpace(processed.SHA256), digest) {
		return validationError(CodeEmoteProcessFailed, MessageEmoteProcessFailed), ""
	}
	processed.SHA256 = digest
	if strings.TrimSpace(processed.Label) == "" {
		processed.Label = normalizeLabel(source.FileName, processed.FrameCount > 1)
	}
	label, labelErr := normalizeLabelValue(processed.Label)
	if labelErr != nil {
		return labelErr, ""
	}
	processed.Label = label
	return nil, digest
}

func normalizeLabel(fileName string, animated bool) string {
	base := fileName
	if index := strings.LastIndexAny(base, "."); index > 0 {
		base = base[:index]
	}
	base = strings.TrimSpace(strings.NewReplacer("_", " ", "-", " ").Replace(base))
	base = strings.Join(strings.Fields(base), " ")
	if base == "" || isGenericLabel(base) {
		if animated {
			return "动态表情"
		}
		return "自定义表情"
	}
	return truncateRunes(base, MaxLabelRunes)
}

func isGenericLabel(value string) bool {
	lower := strings.ToLower(value)
	for _, prefix := range []string{"img", "image", "photo", "screenshot", "screen shot", "wx camera", "mmexport", "pxl", "dsc", "download", "file"} {
		if lower == prefix || strings.HasPrefix(lower, prefix+" ") {
			return true
		}
	}
	if len(value) >= 20 {
		allHexOrDash := true
		for _, r := range lower {
			if !(r >= '0' && r <= '9') && !(r >= 'a' && r <= 'f') && r != '-' {
				allHexOrDash = false
				break
			}
		}
		if allHexOrDash {
			return true
		}
	}
	allDigits := value != ""
	for _, r := range value {
		if r < '0' || r > '9' {
			allDigits = false
			break
		}
	}
	return allDigits && len(value) >= 8
}

func normalizeLabelValue(value string) (string, *Error) {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || containsControl(value) || utf8.RuneCountInString(value) > MaxLabelRunes {
		return "", validationError(CodeEmoteInvalidLabel, MessageEmoteInvalidLabel)
	}
	return value, nil
}

func truncateRunes(value string, max int) string {
	if utf8.RuneCountInString(value) <= max {
		return value
	}
	runes := []rune(value)
	return string(runes[:max])
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}

func (s *Service) StoreProcessed(ctx context.Context, input StoreProcessedInput) (*CustomEmote, error) {
	if _, err := s.readActor(ctx, input.ActorID); err != nil {
		return nil, err
	}
	source, sourceErr := normalizeUploadSource(input.Source)
	if sourceErr != nil {
		return nil, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.create", targetType: "emote"}, sourceErr)
	}
	if input.Processed.Content == nil {
		input.Processed.Content = []byte{}
	}
	if processedErr, _ := validateProcessedUpload(&input.Processed, source); processedErr != nil {
		return nil, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.create", targetType: "emote"}, processedErr)
	}
	if s.blobStore == nil {
		err := NewError(CodeEmoteProcessingUnavailable, MessageEmoteProcessingUnavailable, 503)
		return nil, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.create", targetType: "emote"}, err)
	}
	digest := input.Processed.SHA256
	objectKey, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		return nil, internalError("build emote storage key", err)
	}
	objectID := "wso_" + digest
	stored, err := s.blobStore.Put(ctx, objectKey, bytes.NewReader(input.Processed.Content), input.Processed.ByteSize, digest)
	if err != nil {
		return nil, normalizeStorageError(err)
	}
	if stored.SHA256 != "" && !strings.EqualFold(stored.SHA256, digest) {
		return nil, internalError("verify emote storage object", errors.New("storage digest mismatch"))
	}
	if stored.ByteSize != 0 && stored.ByteSize != input.Processed.ByteSize {
		return nil, internalError("verify emote storage object", errors.New("storage size mismatch"))
	}
	physicalObject := platformstorage.Object{
		Key: objectKey, SHA256: digest, ByteSize: input.Processed.ByteSize, ContentType: "image/webp",
	}
	emoteID, err := s.newID("workspace emote")
	if err != nil {
		_ = s.cleanupObjectIfUnreferencedWithFallback(ctx, objectID, &physicalObject)
		return nil, internalError("generate workspace emote id", err)
	}
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.create", eventType: "emote.created", targetType: "emote", targetID: emoteID,
		payload: map[string]any{"emoteId": emoteID},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		if err := tx.Lock(ctx, "workspace-emote-library:"+actor.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		if err := tx.Lock(ctx, "workspace-storage-object:"+objectID); err != nil {
			return nil, nil, normalizeError(err)
		}
		object, err := tx.AcquireStorageObject(ctx, StorageObjectRecord{
			ID: objectID, SHA256: digest, ObjectKey: objectKey,
			ByteSize: input.Processed.ByteSize, ContentType: "image/webp", CreatedAt: now, VerifiedAt: &now,
		})
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if object == nil || object.ID != objectID {
			return nil, nil, internalError("acquire emote storage object", errors.New("invalid storage object"))
		}
		duplicate, err := tx.FindCustomEmoteByDigest(ctx, actor.ID, digest)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if duplicate != nil {
			if _, err := tx.RestoreCustomEmote(ctx, actor.ID, duplicate.ID, now); err != nil {
				return nil, nil, normalizeError(err)
			}
			if duplicate.StorageObjectID != objectID {
				if err := tx.BindStorageObject(ctx, duplicate.ID, objectID); err != nil {
					return nil, nil, normalizeError(err)
				}
			}
			if err := s.ensurePlacement(ctx, tx, actor.ID, duplicate.ID, input.CollectionID, input.AddToLibrary, now); err != nil {
				if domainErr, ok := err.(*Error); ok {
					return nil, domainErr, nil
				}
				return nil, nil, err
			}
			current, err := tx.GetCustomEmote(ctx, duplicate.ID)
			if err != nil {
				return nil, nil, normalizeError(err)
			}
			return current.Public(s.catalog), nil, nil
		}
		usage, err := tx.EmoteUsage(ctx, actor.ID, "")
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if usage.TotalBytes+input.Processed.ByteSize > MaxTotalBytes {
			return nil, conflictError(CodeEmoteStorageLimitReached, MessageEmoteStorageLimitReached), nil
		}
		record := CustomEmoteRecord{
			ID: emoteID, UserID: actor.ID, SourceType: source.Type,
			SourceAttachmentID: source.AttachmentID, SourceCustomEmoteID: source.CustomEmoteID,
			OriginalFileName: source.FileName, OriginalMIMEType: input.Processed.DetectedMIMEType,
			Label: input.Processed.Label, NormalizedMIMEType: "image/webp", ByteSize: int64Pointer(input.Processed.ByteSize),
			Width: intPointer(input.Processed.Width), Height: intPointer(input.Processed.Height), FrameCount: intPointer(input.Processed.FrameCount),
			DurationMS: int64Pointer(input.Processed.DurationMS), SHA256: digest, StorageObjectID: objectID,
			SortOrder: -1, CreatedAt: now,
		}
		inserted, err := tx.InsertCustomEmote(ctx, record)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if !inserted {
			return nil, conflictError(CodeEmoteInvalidReference, MessageEmoteInvalidReference), nil
		}
		if err := s.ensurePlacement(ctx, tx, actor.ID, emoteID, input.CollectionID, input.AddToLibrary, now); err != nil {
			if domainErr, ok := err.(*Error); ok {
				return nil, domainErr, nil
			}
			return nil, nil, err
		}
		return record.Public(s.catalog), nil, nil
	})
	if mutationErr != nil {
		_ = s.cleanupObjectIfUnreferencedWithFallback(ctx, objectID, &physicalObject)
		return nil, mutationErr
	}
	public, ok := result.(*CustomEmote)
	if !ok || public == nil {
		_ = s.cleanupObjectIfUnreferencedWithFallback(ctx, objectID, &physicalObject)
		return nil, internalError("project workspace emote", errors.New("invalid emote result"))
	}
	return public, nil
}

func (s *Service) CreateBuiltinFavorite(ctx context.Context, actorID, emoteKey string, meta auth.RequestMeta) (*CustomEmote, error) {
	if _, err := s.readActor(ctx, actorID); err != nil {
		return nil, err
	}
	item, ok := s.catalogImage(emoteKey)
	if !ok {
		err := validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource)
		return nil, s.recordRejected(ctx, actorID, meta, mutationEvidence{action: "emote.create", targetType: "emote"}, err)
	}
	emoteID, err := s.newID("workspace builtin emote")
	if err != nil {
		return nil, internalError("generate workspace builtin emote id", err)
	}
	result, mutationErr := s.mutate(ctx, actorID, meta, mutationEvidence{
		action: "emote.create", eventType: "emote.created", targetType: "emote", targetID: emoteID,
		payload: map[string]any{"emoteId": emoteID, "source": "builtin"},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		if err := tx.Lock(ctx, "workspace-emote-library:"+actor.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		key := strings.TrimSpace(emoteKey)
		duplicate, err := tx.FindBuiltinEmote(ctx, actor.ID, key)
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
			return current.Public(s.catalog), nil, nil
		}
		record := CustomEmoteRecord{ID: emoteID, UserID: actor.ID, SourceType: "builtin", SourceEmoteKey: key, Label: item.Label, SortOrder: -1, CreatedAt: now}
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
	return result.(*CustomEmote), nil
}

func (s *Service) catalogImage(key string) (CatalogItem, bool) {
	if s == nil || s.catalog == nil {
		return CatalogItem{}, false
	}
	return s.catalog.Image(key)
}

func (s *Service) ensurePlacement(ctx context.Context, tx Tx, actorID, emoteID, collectionID string, addToLibrary bool, now time.Time) error {
	collectionID = strings.TrimSpace(collectionID)
	if collectionID != "" {
		collection, err := tx.GetCollection(ctx, actorID, collectionID)
		if err != nil {
			return normalizeError(err)
		}
		if collection == nil {
			return notFoundError(CodeEmoteCollectionNotFound, MessageEmoteCollectionNotFound)
		}
		if collection.SubscriptionStatus == "active" {
			return conflictError(CodeEmoteSubscriptionReadOnly, MessageEmoteSubscriptionReadOnly)
		}
		items, err := tx.ListCollectionItems(ctx, collectionID)
		if err != nil {
			return normalizeError(err)
		}
		exists := false
		for _, item := range items {
			if item.EmoteID == emoteID {
				exists = true
				break
			}
		}
		if !exists && len(items) >= MaxCollectionItems {
			return conflictError(CodeEmoteCollectionLimitReached, MessageEmoteCollectionLimitReached)
		}
		if !exists {
			if _, err := tx.InsertCollectionItem(ctx, CollectionItemRecord{CollectionID: collectionID, EmoteID: emoteID, SortOrder: -1, AddedAt: now}); err != nil {
				return normalizeError(err)
			}
			if _, err := tx.UpdateCollectionRevision(ctx, actorID, collectionID, now); err != nil {
				return normalizeError(err)
			}
		}
	}
	if addToLibrary {
		entryID, err := s.newID("workspace emote library entry")
		if err != nil {
			return internalError("generate workspace emote library entry id", err)
		}
		if _, err := tx.EnsureLibraryEntry(ctx, LibraryEntryRecord{ID: entryID, UserID: actorID, EntryType: "emote", EmoteID: emoteID, SortOrder: -1, CreatedAt: now}); err != nil {
			return normalizeError(err)
		}
	}
	return nil
}

func int64Pointer(value int64) *int64 {
	return &value
}

func intPointer(value int) *int {
	return &value
}

func normalizeStorageError(err error) error {
	if err == nil {
		return nil
	}
	var storageErr *platformstorage.Error
	if !errors.As(err, &storageErr) {
		return internalError("workspace emote storage", err)
	}
	if storageErr.Code == "file.storage_missing" || storageErr.Code == "storage.object_not_found" {
		return notFoundError(CodeEmoteStorageMissing, MessageEmoteStorageMissing)
	}
	if storageErr.StatusCode == 413 {
		return NewError(CodeEmoteInputTooLarge, MessageEmoteInputTooLarge, 413)
	}
	return internalError("workspace emote storage", storageErr)
}

func (s *Service) List(ctx context.Context, actorID string) ([]CustomEmote, EmoteUsage, EmoteLimits, error) {
	if _, err := s.readActor(ctx, actorID); err != nil {
		return []CustomEmote{}, EmoteUsage{}, defaultLimits(), err
	}
	rows, err := s.repo.ListCustomEmotes(ctx, strings.TrimSpace(actorID), false)
	if err != nil {
		return []CustomEmote{}, EmoteUsage{}, defaultLimits(), normalizeError(err)
	}
	items := make([]CustomEmote, 0, len(rows))
	for _, row := range rows {
		if row.RemovedAt != nil {
			continue
		}
		if item := row.Public(s.catalog); item != nil {
			items = append(items, *item)
		}
	}
	usage, err := s.repo.EmoteUsage(ctx, strings.TrimSpace(actorID), "")
	if err != nil {
		return []CustomEmote{}, EmoteUsage{}, defaultLimits(), normalizeError(err)
	}
	return items, usage, defaultLimits(), nil
}

func (s *Service) GetLibrary(ctx context.Context, actorID string) (PublicLibrary, error) {
	if _, err := s.readActor(ctx, actorID); err != nil {
		return PublicLibrary{Entries: []PublicLibraryEntry{}, Emotes: []CustomEmote{}, Collections: []Collection{}, Limits: defaultLimits()}, err
	}
	return s.buildLibrary(ctx, strings.TrimSpace(actorID))
}

func (s *Service) buildLibrary(ctx context.Context, actorID string) (PublicLibrary, error) {
	rows, err := s.repo.ListCustomEmotes(ctx, actorID, false)
	if err != nil {
		return PublicLibrary{}, normalizeError(err)
	}
	emotes := make([]CustomEmote, 0, len(rows))
	emoteByID := make(map[string]*CustomEmote, len(rows))
	for _, row := range rows {
		if row.RemovedAt != nil {
			continue
		}
		item := row.Public(s.catalog)
		if item == nil {
			continue
		}
		emotes = append(emotes, *item)
		emoteByID[row.ID] = item
	}
	collectionRecords, err := s.repo.ListCollections(ctx, actorID)
	if err != nil {
		return PublicLibrary{}, normalizeError(err)
	}
	collections := make([]Collection, 0, len(collectionRecords))
	collectionByID := make(map[string]*Collection, len(collectionRecords))
	for _, record := range collectionRecords {
		collection, err := s.projectCollection(ctx, record)
		if err != nil {
			return PublicLibrary{}, err
		}
		collections = append(collections, collection)
		copy := collection
		collectionByID[record.ID] = &copy
	}
	entryRecords, err := s.repo.ListLibraryEntries(ctx, actorID)
	if err != nil {
		return PublicLibrary{}, normalizeError(err)
	}
	entries := make([]PublicLibraryEntry, 0, len(entryRecords))
	for _, record := range entryRecords {
		entry := PublicLibraryEntry{ID: record.ID, Type: record.EntryType}
		if record.EntryType == "emote" {
			entry.Emote = emoteByID[record.EmoteID]
		} else if record.EntryType == "collection" {
			entry.Collection = collectionByID[record.CollectionID]
		}
		if entry.Emote != nil || entry.Collection != nil {
			entries = append(entries, entry)
		}
	}
	usage, err := s.repo.EmoteUsage(ctx, actorID, "")
	if err != nil {
		return PublicLibrary{}, normalizeError(err)
	}
	return PublicLibrary{Entries: entries, Emotes: emotes, Collections: collections, Usage: usage, Limits: defaultLimits()}, nil
}

func (s *Service) projectCollection(ctx context.Context, record CollectionRecord) (Collection, error) {
	itemRecords, err := s.repo.ListCollectionItems(ctx, record.ID)
	if err != nil {
		return Collection{}, normalizeError(err)
	}
	items := make([]CustomEmote, 0, len(itemRecords))
	for _, itemRecord := range itemRecords {
		emote, err := s.repo.GetCustomEmote(ctx, itemRecord.EmoteID)
		if err != nil {
			return Collection{}, normalizeError(err)
		}
		if emote == nil || emote.RemovedAt != nil {
			continue
		}
		public := emote.Public(s.catalog)
		if public != nil {
			items = append(items, *public)
		}
	}
	return record.Public(items), nil
}

func (s *Service) CreateCollection(ctx context.Context, input CreateCollectionInput) (Collection, error) {
	name, nameErr := normalizeCollectionName(input.Name)
	if nameErr != nil {
		return Collection{}, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.collection.create", targetType: "collection"}, nameErr)
	}
	if len(uniqueIDs(input.EmoteIDs)) > MaxCollectionItems {
		err := conflictError(CodeEmoteCollectionLimitReached, MessageEmoteCollectionLimitReached)
		return Collection{}, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.collection.create", targetType: "collection"}, err)
	}
	if _, err := s.readActor(ctx, input.ActorID); err != nil {
		return Collection{}, err
	}
	collectionID, err := s.newID("workspace emote collection")
	if err != nil {
		return Collection{}, internalError("generate workspace emote collection id", err)
	}
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.collection.create", eventType: "emote.collection.created", targetType: "collection", targetID: collectionID,
		payload: map[string]any{"collectionId": collectionID},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		if err := tx.Lock(ctx, "workspace-emote-library:"+actor.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		record := CollectionRecord{ID: collectionID, UserID: actor.ID, Name: name, OriginalCreatorID: actor.ID, OriginalCreatorName: displayName(actor), Revision: 1, CreatedAt: now, UpdatedAt: now, SubscriptionStatus: "off"}
		if err := tx.InsertCollection(ctx, record); err != nil {
			return nil, nil, normalizeError(err)
		}
		entryID, err := s.newID("workspace collection library entry")
		if err != nil {
			return nil, nil, internalError("generate workspace collection library entry id", err)
		}
		if _, err := tx.EnsureLibraryEntry(ctx, LibraryEntryRecord{ID: entryID, UserID: actor.ID, EntryType: "collection", CollectionID: collectionID, SortOrder: -1, CreatedAt: now}); err != nil {
			return nil, nil, normalizeError(err)
		}
		if err := s.addItems(ctx, tx, actor.ID, collectionID, input.EmoteIDs, now); err != nil {
			if domainErr, ok := err.(*Error); ok {
				return nil, domainErr, nil
			}
			return nil, nil, err
		}
		return record, nil, nil
	})
	if mutationErr != nil {
		return Collection{}, mutationErr
	}
	record, ok := result.(CollectionRecord)
	if !ok {
		return Collection{}, internalError("project emote collection", errors.New("invalid collection result"))
	}
	return s.projectCollection(ctx, record)
}

func (s *Service) UpdateCollection(ctx context.Context, input UpdateCollectionInput) (Collection, error) {
	name, nameErr := normalizeCollectionName(input.Name)
	if nameErr != nil {
		return Collection{}, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.collection.update", targetType: "collection", targetID: input.CollectionID}, nameErr)
	}
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.collection.update", eventType: "emote.collection.updated", targetType: "collection", targetID: strings.TrimSpace(input.CollectionID),
		payload: map[string]any{"collectionId": strings.TrimSpace(input.CollectionID)},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		collection, err := tx.GetCollection(ctx, actor.ID, strings.TrimSpace(input.CollectionID))
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if collection == nil {
			return nil, notFoundError(CodeEmoteCollectionNotFound, MessageEmoteCollectionNotFound), nil
		}
		if collection.SubscriptionStatus == "active" {
			return nil, conflictError(CodeEmoteSubscriptionReadOnly, MessageEmoteSubscriptionReadOnly), nil
		}
		updated, err := tx.UpdateCollectionName(ctx, actor.ID, collection.ID, name, now)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if !updated {
			return nil, notFoundError(CodeEmoteCollectionNotFound, MessageEmoteCollectionNotFound), nil
		}
		collection.Name = name
		collection.Revision++
		collection.UpdatedAt = now
		return *collection, nil, nil
	})
	if mutationErr != nil {
		return Collection{}, mutationErr
	}
	record, ok := result.(CollectionRecord)
	if !ok {
		return Collection{}, internalError("project emote collection", errors.New("invalid collection result"))
	}
	return s.projectCollection(ctx, record)
}

func displayName(actor *auth.Actor) string {
	if actor == nil {
		return ""
	}
	for _, value := range []string{actor.Nickname, actor.DisplayName, actor.GitHubLogin, actor.ID} {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func normalizeCollectionName(value string) (string, *Error) {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || containsControl(value) || utf8.RuneCountInString(value) > MaxCollectionNameRunes {
		return "", validationError(CodeEmoteInvalidCollectionName, MessageEmoteInvalidCollectionName)
	}
	return value, nil
}

func uniqueIDs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func (s *Service) addItems(ctx context.Context, tx Tx, actorID, collectionID string, emoteIDs []string, now time.Time) error {
	normalized := uniqueIDs(emoteIDs)
	if len(normalized) > MaxBatchItems {
		return conflictError(CodeEmoteCollectionLimitReached, MessageEmoteCollectionLimitReached)
	}
	items, err := tx.ListCollectionItems(ctx, collectionID)
	if err != nil {
		return normalizeError(err)
	}
	current := make(map[string]struct{}, len(items))
	for _, item := range items {
		current[item.EmoteID] = struct{}{}
	}
	additions := 0
	for _, emoteID := range normalized {
		if _, exists := current[emoteID]; exists {
			continue
		}
		emote, err := tx.GetCustomEmote(ctx, emoteID)
		if err != nil {
			return normalizeError(err)
		}
		if emote == nil || emote.UserID != actorID || emote.RemovedAt != nil {
			return validationError(CodeEmoteInvalidSource, "只能添加自己的可用表情")
		}
		if len(items)+additions >= MaxCollectionItems {
			return conflictError(CodeEmoteCollectionLimitReached, MessageEmoteCollectionLimitReached)
		}
		if _, err := tx.InsertCollectionItem(ctx, CollectionItemRecord{CollectionID: collectionID, EmoteID: emoteID, SortOrder: -1, AddedAt: now}); err != nil {
			return normalizeError(err)
		}
		current[emoteID] = struct{}{}
		additions++
	}
	if additions > 0 {
		if _, err := tx.UpdateCollectionRevision(ctx, actorID, collectionID, now); err != nil {
			return normalizeError(err)
		}
	}
	return nil
}

func (s *Service) AddCollectionItems(ctx context.Context, input CollectionItemsInput) (Collection, error) {
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.collection.items.add", eventType: "emote.collection.updated", targetType: "collection", targetID: strings.TrimSpace(input.CollectionID),
		payload: map[string]any{"collectionId": strings.TrimSpace(input.CollectionID)},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		collection, err := tx.GetCollection(ctx, actor.ID, strings.TrimSpace(input.CollectionID))
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if collection == nil {
			return nil, notFoundError(CodeEmoteCollectionNotFound, MessageEmoteCollectionNotFound), nil
		}
		if collection.SubscriptionStatus == "active" {
			return nil, conflictError(CodeEmoteSubscriptionReadOnly, MessageEmoteSubscriptionReadOnly), nil
		}
		if err := s.addItems(ctx, tx, actor.ID, collection.ID, input.EmoteIDs, now); err != nil {
			if domainErr, ok := err.(*Error); ok {
				return nil, domainErr, nil
			}
			return nil, nil, err
		}
		return *collection, nil, nil
	})
	if mutationErr != nil {
		return Collection{}, mutationErr
	}
	record, ok := result.(CollectionRecord)
	if !ok {
		return Collection{}, internalError("project emote collection", errors.New("invalid collection result"))
	}
	return s.projectCollection(ctx, record)
}

func (s *Service) RemoveCollectionItem(ctx context.Context, input RemoveCollectionItemInput) (Collection, error) {
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.collection.items.remove", eventType: "emote.collection.updated", targetType: "collection", targetID: strings.TrimSpace(input.CollectionID),
		payload: map[string]any{"collectionId": strings.TrimSpace(input.CollectionID), "emoteId": strings.TrimSpace(input.EmoteID)},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		collection, err := tx.GetCollection(ctx, actor.ID, strings.TrimSpace(input.CollectionID))
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if collection == nil {
			return nil, notFoundError(CodeEmoteCollectionNotFound, MessageEmoteCollectionNotFound), nil
		}
		if collection.SubscriptionStatus == "active" {
			return nil, conflictError(CodeEmoteSubscriptionReadOnly, MessageEmoteSubscriptionReadOnly), nil
		}
		removed, err := tx.DeleteCollectionItem(ctx, collection.ID, strings.TrimSpace(input.EmoteID))
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if !removed {
			return nil, notFoundError(CodeEmoteNotFound, "合集内没有该表情"), nil
		}
		if _, err := tx.UpdateCollectionRevision(ctx, actor.ID, collection.ID, now); err != nil {
			return nil, nil, normalizeError(err)
		}
		collection.Revision++
		collection.UpdatedAt = now
		return *collection, nil, nil
	})
	if mutationErr != nil {
		return Collection{}, mutationErr
	}
	record, ok := result.(CollectionRecord)
	if !ok {
		return Collection{}, internalError("project emote collection", errors.New("invalid collection result"))
	}
	return s.projectCollection(ctx, record)
}

func (s *Service) ReorderLibrary(ctx context.Context, input ReorderInput) (PublicLibrary, error) {
	ids := uniqueIDs(input.IDs)
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.library.reorder", eventType: "emote.library.updated", targetType: "user", targetID: strings.TrimSpace(input.ActorID),
		payload: map[string]any{"userId": strings.TrimSpace(input.ActorID)},
	}, func(tx Tx, actor *auth.Actor, _ time.Time) (any, *Error, error) {
		if err := tx.Lock(ctx, "workspace-emote-library:"+actor.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		entries, err := tx.ListLibraryEntries(ctx, actor.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if len(ids) != len(entries) {
			return nil, validationError(CodeEmoteInvalidOrder, MessageEmoteInvalidOrder), nil
		}
		known := make(map[string]struct{}, len(entries))
		for _, entry := range entries {
			known[entry.ID] = struct{}{}
		}
		for _, id := range ids {
			if _, ok := known[id]; !ok {
				return nil, validationError(CodeEmoteInvalidOrder, MessageEmoteInvalidOrder), nil
			}
		}
		for index, id := range ids {
			if err := tx.ReorderLibraryEntry(ctx, actor.ID, id, int64(index)); err != nil {
				return nil, nil, normalizeError(err)
			}
		}
		return nil, nil, nil
	})
	if mutationErr != nil {
		return PublicLibrary{}, mutationErr
	}
	if result != nil {
		return PublicLibrary{}, internalError("reorder workspace emote library", errors.New("unexpected result"))
	}
	return s.GetLibrary(ctx, input.ActorID)
}

func (s *Service) ReorderEmotes(ctx context.Context, input ReorderInput) (PublicLibrary, error) {
	if _, err := s.readActor(ctx, input.ActorID); err != nil {
		return PublicLibrary{}, err
	}
	entries, err := s.repo.ListLibraryEntries(ctx, strings.TrimSpace(input.ActorID))
	if err != nil {
		return PublicLibrary{}, normalizeError(err)
	}
	currentEmotes := make([]string, 0)
	for _, entry := range entries {
		if entry.EntryType == "emote" {
			currentEmotes = append(currentEmotes, entry.EmoteID)
		}
	}
	requested := uniqueIDs(input.IDs)
	if len(requested) != len(currentEmotes) {
		return PublicLibrary{}, validationError(CodeEmoteInvalidOrder, MessageEmoteInvalidOrder)
	}
	known := make(map[string]struct{}, len(currentEmotes))
	for _, id := range currentEmotes {
		known[id] = struct{}{}
	}
	for _, id := range requested {
		if _, ok := known[id]; !ok {
			return PublicLibrary{}, validationError(CodeEmoteInvalidOrder, MessageEmoteInvalidOrder)
		}
	}
	positions := make(map[string]string, len(entries))
	for _, entry := range entries {
		if entry.EntryType == "emote" {
			positions[entry.EmoteID] = entry.ID
		}
	}
	orderedEntryIDs := append([]string(nil), make([]string, 0, len(entries))...)
	index := 0
	for _, entry := range entries {
		if entry.EntryType == "emote" {
			orderedEntryIDs = append(orderedEntryIDs, positions[requested[index]])
			index++
		} else {
			orderedEntryIDs = append(orderedEntryIDs, entry.ID)
		}
	}
	input.IDs = orderedEntryIDs
	return s.ReorderLibrary(ctx, input)
}

func (s *Service) Update(ctx context.Context, input UpdateEmoteInput) (*CustomEmote, error) {
	label, labelErr := normalizeLabelValue(input.Label)
	if labelErr != nil {
		return nil, s.recordRejected(ctx, input.ActorID, input.Meta, mutationEvidence{action: "emote.update", targetType: "emote", targetID: strings.TrimSpace(input.EmoteID)}, labelErr)
	}
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.update", eventType: "emote.updated", targetType: "emote", targetID: strings.TrimSpace(input.EmoteID),
		payload: map[string]any{"emoteId": strings.TrimSpace(input.EmoteID)},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		emoteID := strings.TrimSpace(input.EmoteID)
		row, err := tx.GetCustomEmote(ctx, emoteID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if row == nil || row.UserID != actor.ID || row.RemovedAt != nil {
			return nil, notFoundError(CodeEmoteNotFound, MessageEmoteNotFound), nil
		}
		readonly, err := tx.IsEmoteSubscriptionReadOnly(ctx, actor.ID, row.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if readonly {
			return nil, conflictError(CodeEmoteSubscriptionReadOnly, MessageEmoteSubscriptionReadOnly), nil
		}
		if _, err := tx.UpdateCustomEmoteLabel(ctx, actor.ID, row.ID, label); err != nil {
			return nil, nil, normalizeError(err)
		}
		collectionIDs, err := tx.MutableCollectionIDsForEmote(ctx, actor.ID, row.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		for _, collectionID := range collectionIDs {
			if _, err := tx.UpdateCollectionRevision(ctx, actor.ID, collectionID, now); err != nil {
				return nil, nil, normalizeError(err)
			}
		}
		row.Label = label
		return row.Public(s.catalog), nil, nil
	})
	if mutationErr != nil {
		return nil, mutationErr
	}
	public, ok := result.(*CustomEmote)
	if !ok || public == nil {
		return nil, internalError("project workspace emote", errors.New("invalid emote result"))
	}
	return public, nil
}

func (s *Service) Remove(ctx context.Context, actorID, emoteID string, meta auth.RequestMeta) (map[string]any, error) {
	emoteID = strings.TrimSpace(emoteID)
	result, mutationErr := s.mutate(ctx, actorID, meta, mutationEvidence{
		action: "emote.remove", eventType: "emote.removed", targetType: "emote", targetID: emoteID,
		payload: map[string]any{"emoteId": emoteID},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		row, err := tx.GetCustomEmote(ctx, emoteID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if row == nil || row.UserID != actor.ID {
			return nil, notFoundError(CodeEmoteNotFound, MessageEmoteNotFound), nil
		}
		readonly, err := tx.IsEmoteSubscriptionReadOnly(ctx, actor.ID, row.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if readonly {
			return nil, conflictError(CodeEmoteSubscriptionReadOnly, MessageEmoteSubscriptionReadOnly), nil
		}
		if err := tx.Lock(ctx, "workspace-emote-library:"+actor.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		collectionIDs, err := tx.MutableCollectionIDsForEmote(ctx, actor.ID, row.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if _, err := tx.DeleteLibraryEntry(ctx, actor.ID, row.ID, ""); err != nil {
			return nil, nil, normalizeError(err)
		}
		if err := tx.DeleteCollectionEmoteLinks(ctx, actor.ID, row.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		if _, err := tx.MarkCustomEmoteRemoved(ctx, actor.ID, row.ID, now); err != nil {
			return nil, nil, normalizeError(err)
		}
		for _, collectionID := range collectionIDs {
			if _, err := tx.UpdateCollectionRevision(ctx, actor.ID, collectionID, now); err != nil {
				return nil, nil, normalizeError(err)
			}
		}
		removedRow, deleted, err := tx.DeleteUnreferencedEmote(ctx, row.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		cleanupRows := []CustomEmoteRecord{}
		if deleted && removedRow != nil {
			cleanupRows = append(cleanupRows, *removedRow)
		}
		return mutationResult{value: map[string]any{"ok": true, "emoteId": row.ID}, cleanupRows: cleanupRows}, nil, nil
	})
	if mutationErr != nil {
		return nil, mutationErr
	}
	mutation, ok := result.(mutationResult)
	if !ok {
		return nil, internalError("remove workspace emote", errors.New("invalid removal result"))
	}
	if err := s.cleanupRows(ctx, mutation.cleanupRows); err != nil {
		return nil, err
	}
	return mutation.value.(map[string]any), nil
}

func (s *Service) ReadContent(ctx context.Context, input ReadContentInput) (Delivery, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return Delivery{}, err
	}
	row, err := s.repo.GetCustomEmote(ctx, strings.TrimSpace(input.EmoteID))
	if err != nil {
		return Delivery{}, normalizeError(err)
	}
	if row == nil {
		return Delivery{}, notFoundError(CodeEmoteNotFound, MessageEmoteNotFound)
	}
	if row.UserID != actor.ID {
		visible, err := s.repo.EmoteVisibleTo(ctx, s.space(), actor.ID, row.ID)
		if err != nil {
			return Delivery{}, normalizeError(err)
		}
		if !visible {
			return Delivery{}, permissionDeniedError()
		}
	}
	resource, err := s.resolveResource(ctx, row)
	if err != nil {
		return Delivery{}, err
	}
	limit := input.MaxBytes
	if limit <= 0 || limit > MaxOutputBytes {
		limit = MaxOutputBytes
	}
	if resource.StorageObjectID != "" {
		object, err := s.repo.GetStorageObject(ctx, resource.StorageObjectID, false)
		if err != nil {
			return Delivery{}, normalizeError(err)
		}
		if object == nil {
			return Delivery{}, notFoundError(CodeEmoteStorageMissing, MessageEmoteStorageMissing)
		}
		opened, err := s.blobStore.Open(ctx, object.BlobObject(), limit)
		if err != nil {
			return Delivery{}, normalizeStorageError(err)
		}
		return Delivery{Body: opened.Body, ContentType: nonEmpty(resource.NormalizedMIMEType, "image/webp"), ByteSize: opened.ByteSize}, nil
	}
	if resource.StorageKey == "" || s.blobStore == nil {
		return Delivery{}, notFoundError(CodeEmoteStorageMissing, MessageEmoteStorageMissing)
	}
	opened, err := s.blobStore.Open(ctx, platformstorage.Object{Key: resource.StorageKey, ByteSize: valueOrZero(resource.ByteSize), ContentType: nonEmpty(resource.NormalizedMIMEType, "image/webp")}, limit)
	if err != nil {
		return Delivery{}, normalizeStorageError(err)
	}
	return Delivery{Body: opened.Body, ContentType: nonEmpty(resource.NormalizedMIMEType, "image/webp"), ByteSize: opened.ByteSize}, nil
}

func (s *Service) resolveResource(ctx context.Context, row *CustomEmoteRecord) (*CustomEmoteRecord, error) {
	current := row
	seen := make(map[string]struct{})
	for current != nil {
		if current.StorageObjectID != "" || current.StorageKey != "" {
			return current, nil
		}
		if current.SourceCustomEmoteID == "" {
			return nil, notFoundError(CodeEmoteStorageMissing, MessageEmoteStorageMissing)
		}
		if _, ok := seen[current.ID]; ok {
			return nil, internalError("resolve emote storage source", errors.New("custom emote source cycle"))
		}
		seen[current.ID] = struct{}{}
		next, err := s.repo.GetCustomEmote(ctx, current.SourceCustomEmoteID)
		if err != nil {
			return nil, normalizeError(err)
		}
		current = next
	}
	return nil, notFoundError(CodeEmoteStorageMissing, MessageEmoteStorageMissing)
}

func valueOrZero(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func (s *Service) cleanupRows(ctx context.Context, rows []CustomEmoteRecord) error {
	seen := make(map[string]struct{})
	for _, row := range rows {
		if row.StorageObjectID == "" {
			continue
		}
		if _, ok := seen[row.StorageObjectID]; ok {
			continue
		}
		seen[row.StorageObjectID] = struct{}{}
		if err := s.cleanupObjectIfUnreferenced(ctx, row.StorageObjectID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) cleanupObjectIfUnreferenced(ctx context.Context, objectID string) error {
	return s.cleanupObjectIfUnreferencedWithFallback(ctx, objectID, nil)
}

func (s *Service) cleanupObjectIfUnreferencedWithFallback(ctx context.Context, objectID string, fallback *platformstorage.Object) error {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" || s == nil || s.repo == nil || s.blobStore == nil {
		return nil
	}
	return s.repo.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, "workspace-storage-object:"+objectID); err != nil {
			return normalizeError(err)
		}
		object, err := tx.GetStorageObject(ctx, objectID, true)
		if err != nil {
			return normalizeError(err)
		}
		if object == nil {
			if fallback == nil {
				return nil
			}
			if err := s.blobStore.Delete(ctx, *fallback); err != nil {
				return normalizeStorageError(err)
			}
			return nil
		}
		if object.DeletedAt != nil {
			return nil
		}
		references, err := tx.StorageObjectReferenceCount(ctx, objectID)
		if err != nil {
			return normalizeError(err)
		}
		if references > 0 {
			return nil
		}
		if err := s.blobStore.Delete(ctx, object.BlobObject()); err != nil {
			return normalizeStorageError(err)
		}
		if _, err := tx.MarkStorageObjectDeleted(ctx, objectID, s.nowUTC()); err != nil {
			return normalizeError(err)
		}
		return nil
	})
}

func (s *Service) DeleteCollection(ctx context.Context, input DeleteCollectionInput) (map[string]any, error) {
	collectionID := strings.TrimSpace(input.CollectionID)
	disposition := strings.TrimSpace(input.Disposition)
	if disposition == "" {
		disposition = "keep"
	}
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.collection.remove", eventType: "emote.collection.removed", targetType: "collection", targetID: collectionID,
		payload: map[string]any{"collectionId": collectionID, "disposition": disposition},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		collection, err := tx.GetCollection(ctx, actor.ID, collectionID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if collection == nil {
			return nil, notFoundError(CodeEmoteCollectionNotFound, MessageEmoteCollectionNotFound), nil
		}
		if collection.SubscriptionStatus == "active" {
			return nil, conflictError(CodeEmoteSubscriptionReadOnly, MessageEmoteSubscriptionReadOnly), nil
		}
		if err := tx.Lock(ctx, "workspace-emote-library:"+actor.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		items, err := tx.ListCollectionItems(ctx, collection.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		rows := make([]CustomEmoteRecord, 0, len(items))
		for _, item := range items {
			row, err := tx.GetCustomEmote(ctx, item.EmoteID)
			if err != nil {
				return nil, nil, normalizeError(err)
			}
			if row != nil {
				rows = append(rows, *row)
			}
		}
		if disposition != "remove" {
			for _, row := range rows {
				entryID, err := s.newID("workspace emote library entry")
				if err != nil {
					return nil, nil, internalError("generate workspace emote library entry id", err)
				}
				if _, err := tx.EnsureLibraryEntry(ctx, LibraryEntryRecord{ID: entryID, UserID: actor.ID, EntryType: "emote", EmoteID: row.ID, SortOrder: -1, CreatedAt: now}); err != nil {
					return nil, nil, normalizeError(err)
				}
			}
		} else {
			for _, row := range rows {
				if _, err := tx.MarkCustomEmoteRemoved(ctx, actor.ID, row.ID, now); err != nil {
					return nil, nil, normalizeError(err)
				}
			}
		}
		if _, err := tx.DeleteLibraryEntry(ctx, actor.ID, "", collectionID); err != nil {
			return nil, nil, normalizeError(err)
		}
		if _, err := tx.DeleteCollection(ctx, actor.ID, collectionID); err != nil {
			return nil, nil, normalizeError(err)
		}
		cleanupRows := make([]CustomEmoteRecord, 0)
		if disposition == "remove" {
			for _, row := range rows {
				if deletedRow, deleted, err := tx.DeleteUnreferencedEmote(ctx, row.ID); err != nil {
					return nil, nil, normalizeError(err)
				} else if deleted && deletedRow != nil {
					cleanupRows = append(cleanupRows, *deletedRow)
				}
			}
		}
		return mutationResult{value: map[string]any{"ok": true, "collectionId": collectionID}, cleanupRows: cleanupRows}, nil, nil
	})
	if mutationErr != nil {
		return nil, mutationErr
	}
	mutation, ok := result.(mutationResult)
	if !ok {
		return nil, internalError("remove workspace emote collection", errors.New("invalid collection removal result"))
	}
	if err := s.cleanupRows(ctx, mutation.cleanupRows); err != nil {
		return nil, err
	}
	return mutation.value.(map[string]any), nil
}

func (s *Service) ReorderCollection(ctx context.Context, input ReorderInput, collectionID string) (Collection, error) {
	collectionID = strings.TrimSpace(collectionID)
	ids := uniqueIDs(input.IDs)
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.collection.reorder", eventType: "emote.collection.updated", targetType: "collection", targetID: collectionID,
		payload: map[string]any{"collectionId": collectionID},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		collection, err := tx.GetCollection(ctx, actor.ID, collectionID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if collection == nil {
			return nil, notFoundError(CodeEmoteCollectionNotFound, MessageEmoteCollectionNotFound), nil
		}
		if collection.SubscriptionStatus == "active" {
			return nil, conflictError(CodeEmoteSubscriptionReadOnly, MessageEmoteSubscriptionReadOnly), nil
		}
		items, err := tx.ListCollectionItems(ctx, collectionID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if len(ids) != len(items) {
			return nil, validationError(CodeEmoteInvalidOrder, MessageEmoteInvalidOrder), nil
		}
		known := make(map[string]struct{}, len(items))
		for _, item := range items {
			known[item.EmoteID] = struct{}{}
		}
		for _, id := range ids {
			if _, ok := known[id]; !ok {
				return nil, validationError(CodeEmoteInvalidOrder, MessageEmoteInvalidOrder), nil
			}
		}
		for index, id := range ids {
			if err := tx.ReorderCollectionItem(ctx, collectionID, id, int64(index)); err != nil {
				return nil, nil, normalizeError(err)
			}
		}
		if _, err := tx.UpdateCollectionRevision(ctx, actor.ID, collectionID, now); err != nil {
			return nil, nil, normalizeError(err)
		}
		collection.Revision++
		collection.UpdatedAt = now
		return *collection, nil, nil
	})
	if mutationErr != nil {
		return Collection{}, mutationErr
	}
	record, ok := result.(CollectionRecord)
	if !ok {
		return Collection{}, internalError("project emote collection", errors.New("invalid collection order result"))
	}
	return s.projectCollection(ctx, record)
}

func (s *Service) CreateShare(ctx context.Context, input CreateShareInput) (Share, error) {
	collectionID := strings.TrimSpace(input.CollectionID)
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.collection.share.create", eventType: "emote.collection.share.created", targetType: "collection", targetID: collectionID,
		payload: map[string]any{"collectionId": collectionID},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		if err := tx.Lock(ctx, "workspace-emote-library:"+actor.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		collection, err := tx.GetCollection(ctx, actor.ID, collectionID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if collection == nil {
			return nil, notFoundError(CodeEmoteCollectionNotFound, MessageEmoteCollectionNotFound), nil
		}
		items, err := tx.ListCollectionItems(ctx, collection.ID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if len(items) == 0 {
			return nil, validationError(CodeEmoteCollectionEmpty, MessageEmoteCollectionEmpty), nil
		}
		ids := make([]string, 0, len(items))
		for _, item := range items {
			ids = append(ids, item.EmoteID)
		}
		fingerprintBytes, err := canonicalJSON(struct {
			Name     string   `json:"name"`
			EmoteIDs []string `json:"emoteIds"`
		}{Name: collection.Name, EmoteIDs: ids})
		if err != nil {
			return nil, nil, internalError("encode emote share fingerprint", err)
		}
		fingerprint := canonicalDigest(fingerprintBytes)
		existing, err := tx.FindActiveShareByFingerprint(ctx, collection.ID, actor.ID, fingerprint)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if existing != nil {
			return *existing, nil, nil
		}
		shareID, err := s.newID("workspace emote share")
		if err != nil {
			return nil, nil, internalError("generate workspace emote share id", err)
		}
		record := ShareRecord{ID: shareID, SourceCollectionID: collection.ID, SharedByID: actor.ID, SharedByName: displayName(actor), OriginalCreatorID: collection.OriginalCreatorID, OriginalCreatorName: collection.OriginalCreatorName, Name: collection.Name, Fingerprint: fingerprint, ItemCount: len(items), CreatedAt: now}
		if err := tx.InsertShare(ctx, record); err != nil {
			return nil, nil, normalizeError(err)
		}
		for index, item := range items {
			if err := tx.InsertShareItem(ctx, ShareItemRecord{ShareID: shareID, EmoteID: item.EmoteID, SortOrder: int64(index)}); err != nil {
				return nil, nil, normalizeError(err)
			}
		}
		return record, nil, nil
	})
	if mutationErr != nil {
		return Share{}, mutationErr
	}
	record, ok := result.(ShareRecord)
	if !ok {
		return Share{}, internalError("project workspace emote share", errors.New("invalid share result"))
	}
	return s.projectShare(ctx, input.ActorID, record)
}

func (s *Service) GetShare(ctx context.Context, actorID, shareID string) (Share, error) {
	if _, err := s.readActor(ctx, actorID); err != nil {
		return Share{}, err
	}
	record, err := s.repo.GetShare(ctx, strings.TrimSpace(shareID))
	if err != nil {
		return Share{}, normalizeError(err)
	}
	if record == nil {
		return Share{}, notFoundError(CodeEmoteShareNotFound, MessageEmoteShareNotFound)
	}
	return s.projectShare(ctx, actorID, *record)
}

func (s *Service) projectShare(ctx context.Context, actorID string, record ShareRecord) (Share, error) {
	itemRecords, err := s.repo.ListShareItems(ctx, record.ID)
	if err != nil {
		return Share{}, normalizeError(err)
	}
	items := make([]CustomEmote, 0, len(itemRecords))
	for _, itemRecord := range itemRecords {
		row, err := s.repo.GetCustomEmote(ctx, itemRecord.EmoteID)
		if err != nil {
			return Share{}, normalizeError(err)
		}
		if row == nil {
			continue
		}
		if public := row.Public(s.catalog); public != nil {
			items = append(items, *public)
		}
	}
	canSubscribe := false
	if record.SourceCollectionID != "" && record.OriginalCreatorID != strings.TrimSpace(actorID) {
		if source, err := s.repo.GetCollection(ctx, record.OriginalCreatorID, record.SourceCollectionID); err == nil {
			canSubscribe = source != nil
		} else {
			return Share{}, normalizeError(err)
		}
	}
	return record.Public(items, canSubscribe, record.SharedByID == strings.TrimSpace(actorID)), nil
}

func (s *Service) RevokeShare(ctx context.Context, input ShareInput) (Share, error) {
	shareID := strings.TrimSpace(input.ShareID)
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.collection.share.revoke", eventType: "emote.collection.share.revoked", targetType: "share", targetID: shareID,
		payload: map[string]any{"shareId": shareID},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		share, err := tx.GetShare(ctx, shareID)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if share == nil {
			return nil, notFoundError(CodeEmoteShareNotFound, MessageEmoteShareNotFound), nil
		}
		if share.SharedByID != actor.ID {
			return nil, permissionDeniedError(), nil
		}
		if _, err := tx.RevokeShare(ctx, actor.ID, share.ID, now); err != nil {
			return nil, nil, normalizeError(err)
		}
		if err := tx.DeleteShareItems(ctx, share.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		share.RevokedAt = &now
		return *share, nil, nil
	})
	if mutationErr != nil {
		return Share{}, mutationErr
	}
	record, ok := result.(ShareRecord)
	if !ok {
		return Share{}, internalError("project workspace emote share", errors.New("invalid revoke result"))
	}
	return s.projectShare(ctx, input.ActorID, record)
}

func (s *Service) ImportShare(ctx context.Context, input ImportShareInput) (ImportShareResult, error) {
	if _, err := s.readActor(ctx, input.ActorID); err != nil {
		return ImportShareResult{}, err
	}
	shareID := strings.TrimSpace(input.ShareID)
	share, err := s.repo.GetShare(ctx, shareID)
	if err != nil {
		return ImportShareResult{}, normalizeError(err)
	}
	if share == nil {
		return ImportShareResult{}, notFoundError(CodeEmoteShareNotFound, MessageEmoteShareNotFound)
	}
	if share.RevokedAt != nil {
		return ImportShareResult{}, NewError(CodeEmoteShareRevoked, MessageEmoteShareRevoked, 410)
	}
	requested := uniqueIDs(input.EmoteIDs)
	shareItems, err := s.repo.ListShareItems(ctx, share.ID)
	if err != nil {
		return ImportShareResult{}, normalizeError(err)
	}
	selected := shareItems
	if len(requested) > 0 {
		allowed := make(map[string]ShareItemRecord, len(shareItems))
		for _, item := range shareItems {
			allowed[item.EmoteID] = item
		}
		selected = make([]ShareItemRecord, 0, len(requested))
		for _, id := range requested {
			item, ok := allowed[id]
			if !ok {
				return ImportShareResult{}, validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource)
			}
			selected = append(selected, item)
		}
	}
	asCollection := len(requested) == 0
	if input.AsCollection != nil {
		asCollection = *input.AsCollection
	}
	if !asCollection && len(requested) == 0 {
		selected = shareItems
	}
	collectionName := share.Name
	if strings.TrimSpace(input.CollectionName) != "" {
		var collectionNameErr *Error
		collectionName, collectionNameErr = normalizeCollectionName(input.CollectionName)
		if collectionNameErr != nil {
			return ImportShareResult{}, collectionNameErr
		}
	}
	collectionID := ""
	if asCollection {
		collectionID, err = s.newID("workspace imported emote collection")
		if err != nil {
			return ImportShareResult{}, internalError("generate workspace imported emote collection id", err)
		}
	}
	result, mutationErr := s.mutate(ctx, input.ActorID, input.Meta, mutationEvidence{
		action: "emote.collection.share.import", eventType: "emote.collection.share.imported", targetType: "share", targetID: share.ID,
		payload: map[string]any{"shareId": share.ID, "collectionId": collectionID, "itemCount": len(selected)},
	}, func(tx Tx, actor *auth.Actor, now time.Time) (any, *Error, error) {
		if err := tx.Lock(ctx, "workspace-emote-library:"+actor.ID); err != nil {
			return nil, nil, normalizeError(err)
		}
		var collection *CollectionRecord
		if asCollection {
			record := CollectionRecord{ID: collectionID, UserID: actor.ID, Name: collectionName, SourceCollectionID: share.SourceCollectionID, OriginalCreatorID: share.OriginalCreatorID, OriginalCreatorName: share.OriginalCreatorName, Revision: 1, CreatedAt: now, UpdatedAt: now, SubscriptionStatus: "off"}
			if err := tx.InsertCollection(ctx, record); err != nil {
				return nil, nil, normalizeError(err)
			}
			entryID, err := s.newID("workspace imported collection library entry")
			if err != nil {
				return nil, nil, internalError("generate workspace imported collection library entry id", err)
			}
			if _, err := tx.EnsureLibraryEntry(ctx, LibraryEntryRecord{ID: entryID, UserID: actor.ID, EntryType: "collection", CollectionID: collectionID, SortOrder: -1, CreatedAt: now}); err != nil {
				return nil, nil, normalizeError(err)
			}
			collection = &record
		}
		imported := make([]CustomEmote, 0, len(selected))
		for _, item := range selected {
			source, err := tx.GetCustomEmote(ctx, item.EmoteID)
			if err != nil {
				return nil, nil, normalizeError(err)
			}
			if source == nil || source.RemovedAt != nil && source.SourceType != "builtin" {
				return nil, validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource), nil
			}
			var target *CustomEmoteRecord
			if source.SourceType == "builtin" {
				catalogItem, ok := s.catalogImage(source.SourceEmoteKey)
				if !ok {
					return nil, validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource), nil
				}
				existing, err := tx.FindBuiltinEmote(ctx, actor.ID, source.SourceEmoteKey)
				if err != nil {
					return nil, nil, normalizeError(err)
				}
				if existing != nil {
					if _, err := tx.RestoreCustomEmote(ctx, actor.ID, existing.ID, now); err != nil {
						return nil, nil, normalizeError(err)
					}
					target = existing
				} else {
					id, err := s.newID("workspace imported builtin emote")
					if err != nil {
						return nil, nil, internalError("generate workspace imported builtin emote id", err)
					}
					record := &CustomEmoteRecord{ID: id, UserID: actor.ID, SourceType: "builtin", SourceEmoteKey: source.SourceEmoteKey, Label: catalogItem.Label, SortOrder: -1, CreatedAt: now}
					inserted, err := tx.InsertCustomEmote(ctx, *record)
					if err != nil {
						return nil, nil, normalizeError(err)
					}
					if !inserted {
						return nil, conflictError(CodeEmoteInvalidReference, MessageEmoteInvalidReference), nil
					}
					target = record
				}
			} else {
				if source.SHA256 == "" && source.StorageObjectID == "" {
					return nil, validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource), nil
				}
				digest := source.SHA256
				existing, err := tx.FindCustomEmoteByDigest(ctx, actor.ID, digest)
				if err != nil {
					return nil, nil, normalizeError(err)
				}
				if existing != nil {
					if _, err := tx.RestoreCustomEmote(ctx, actor.ID, existing.ID, now); err != nil {
						return nil, nil, normalizeError(err)
					}
					target = existing
				} else {
					usage, err := tx.EmoteUsage(ctx, actor.ID, "")
					if err != nil {
						return nil, nil, normalizeError(err)
					}
					if usage.TotalBytes+valueOrZero(source.ByteSize) > MaxTotalBytes {
						return nil, conflictError(CodeEmoteStorageLimitReached, MessageEmoteStorageLimitReached), nil
					}
					id, err := s.newID("workspace imported emote")
					if err != nil {
						return nil, nil, internalError("generate workspace imported emote id", err)
					}
					record := &CustomEmoteRecord{ID: id, UserID: actor.ID, SourceType: "custom", SourceCustomEmoteID: source.ID, OriginalFileName: source.OriginalFileName, OriginalMIMEType: source.OriginalMIMEType, Label: source.Label, NormalizedMIMEType: source.NormalizedMIMEType, ByteSize: source.ByteSize, Width: source.Width, Height: source.Height, FrameCount: source.FrameCount, DurationMS: source.DurationMS, SHA256: source.SHA256, StorageObjectID: source.StorageObjectID, StorageKey: source.StorageKey, SortOrder: -1, CreatedAt: now}
					inserted, err := tx.InsertCustomEmote(ctx, *record)
					if err != nil {
						return nil, nil, normalizeError(err)
					}
					if !inserted {
						return nil, conflictError(CodeEmoteInvalidReference, MessageEmoteInvalidReference), nil
					}
					target = record
				}
			}
			if err := s.ensurePlacement(ctx, tx, actor.ID, target.ID, collectionID, !asCollection, now); err != nil {
				if domainErr, ok := err.(*Error); ok {
					return nil, domainErr, nil
				}
				return nil, nil, err
			}
			if public := target.Public(s.catalog); public != nil {
				imported = append(imported, *public)
			}
		}
		return struct {
			Collection *CollectionRecord
			Items      []CustomEmote
		}{Collection: collection, Items: imported}, nil, nil
	})
	if mutationErr != nil {
		return ImportShareResult{}, mutationErr
	}
	imported, ok := result.(struct {
		Collection *CollectionRecord
		Items      []CustomEmote
	})
	if !ok {
		return ImportShareResult{}, internalError("import workspace emote share", errors.New("invalid import result"))
	}
	response := ImportShareResult{Items: imported.Items, Library: nil}
	if imported.Collection != nil {
		collection, err := s.projectCollection(ctx, *imported.Collection)
		if err != nil {
			return ImportShareResult{}, err
		}
		response.Collection = &collection
	}
	library, err := s.GetLibrary(ctx, input.ActorID)
	if err != nil {
		return ImportShareResult{}, err
	}
	response.Library = &library
	return response, nil
}

func (s *Service) ValidateShare(ctx context.Context, actorID, shareID string) error {
	if _, err := s.readActor(ctx, actorID); err != nil {
		return err
	}
	share, err := s.repo.GetShare(ctx, strings.TrimSpace(shareID))
	if err != nil {
		return normalizeError(err)
	}
	if share == nil || share.RevokedAt != nil {
		return validationError(CodeEmoteInvalidSource, MessageEmoteInvalidSource)
	}
	return nil
}

func (s *Service) UpdateCollectionSourceSubscription(context.Context, string, string, bool, auth.RequestMeta) error {
	return NewError(CodeEmoteSubscriptionUnsupported, MessageEmoteSubscriptionUnsupported, 501)
}
