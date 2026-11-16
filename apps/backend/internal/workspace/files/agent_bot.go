package files

import (
	"context"
	"strings"

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
