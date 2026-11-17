package files

import (
	"context"
	"errors"
	"strings"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// ReserveAgentBotUpload is only for the authenticated Bot Gateway / Bot v2
// endpoints after token, scope and conversation-policy checks. The active custom
// bot and its membership are checked again by this domain, inside reservation.
func (s *Service) ReserveAgentBotUpload(ctx context.Context, input ReserveUploadInput) (UploadResult, error) {
	return s.reserveUpload(ctx, input, s.lookupAgentBotActor)
}

// CompleteAgentBotUpload completes a single-stream upload owned by an active
// custom Agent Bot, promoting staged bytes to canonical storage and marking
// the attachment available for conversation messages.
func (s *Service) CompleteAgentBotUpload(ctx context.Context, input CompleteUploadInput) (UploadResult, error) {
	return s.completeUpload(ctx, input, s.lookupAgentBotActor)
}

// FailAgentBotUpload releases a pending Agent Bot upload reservation on error.
func (s *Service) FailAgentBotUpload(ctx context.Context, input FailUploadInput) (UploadResult, error) {
	return s.failUpload(ctx, input, s.lookupAgentBotActor)
}

func (s *Service) GetAgentBotUploadStatus(ctx context.Context, input UploadStatusInput) (UploadStatus, error) {
	return s.getUploadStatus(ctx, input, s.lookupAgentBotActor)
}

// OpenAgentBotAttachmentContent is called only after the gateway's file-scope,
// source-message and context-grant checks. The files domain repeats current Bot
// identity, logical visibility and quota checks before opening any object bytes.
func (s *Service) OpenAgentBotAttachmentContent(ctx context.Context, input OpenAttachmentInput) (platformstorage.OpenedObject, error) {
	if s == nil || s.repo == nil {
		return platformstorage.OpenedObject{}, internalError("open bot attachment", errors.New("repository is required"))
	}
	if input.MaxBytes <= 0 {
		return platformstorage.OpenedObject{}, validationError(CodeFileInvalidSize, MessageFileInvalidSize)
	}
	if _, err := s.lookupAgentBotActor(ctx, s.repo, input.ActorID); err != nil {
		return platformstorage.OpenedObject{}, err
	}
	record, err := s.repo.GetAttachment(ctx, s.space(), strings.TrimSpace(input.AttachmentID))
	if err != nil {
		return platformstorage.OpenedObject{}, normalizeRepositoryError(err)
	}
	if record == nil || record.Status != string(AttachmentAvailable) || record.ByteSize > input.MaxBytes {
		return platformstorage.OpenedObject{}, fileNotFoundError()
	}
	reserved, err := s.reserveDownload(ctx, ReserveDownloadInput{ActorID: input.ActorID, AttachmentID: input.AttachmentID, Meta: input.Meta}, s.lookupAgentBotActor)
	if err != nil {
		return platformstorage.OpenedObject{}, err
	}
	if reserved.Status != string(TransferCompleted) {
		return platformstorage.OpenedObject{}, NewError(CodeQuotaInsufficient, MessageQuotaInsufficient, 429)
	}
	grant, err := s.getCompletedDownload(ctx, CompletedDownloadInput{ActorID: input.ActorID, AttachmentID: input.AttachmentID, TransferID: reserved.ID, MaxBytes: input.MaxBytes, Meta: input.Meta}, s.lookupAgentBotActor)
	if err == nil {
		var opened platformstorage.OpenedObject
		opened, err = s.openAttachmentRecord(ctx, grant.Attachment, input.MaxBytes, "open bot attachment")
		if err == nil {
			return opened, nil
		}
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, _ = s.releaseDownloadReservation(cleanup, ReleaseDownloadInput{ActorID: input.ActorID, TransferID: reserved.ID, Meta: input.Meta}, s.lookupAgentBotActor)
	return platformstorage.OpenedObject{}, err
}

// This capability is separate from the human repository contract. Adapters
// without an explicit current-bot lookup fail closed rather than trusting Kind.
type agentBotActorRepository interface {
	LookupActiveAgentBot(context.Context, string, string) (*auth.Actor, error)
}

func (s *Service) lookupAgentBotActor(ctx context.Context, repo ReadRepository, actorID string) (*auth.Actor, error) {
	reader, ok := repo.(agentBotActorRepository)
	if !ok {
		return nil, identityForbiddenError()
	}
	actorID = strings.TrimSpace(actorID)
	actor, err := reader.LookupActiveAgentBot(ctx, s.space(), actorID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if actor == nil || actor.ID != actorID || actor.Kind != "bot" || strings.TrimSpace(actor.Role) == "" {
		return nil, identityForbiddenError()
	}
	return actor, nil
}
