package files

import (
	"context"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// ReserveAgentBotUpload is only for the authenticated Bot Gateway after its
// token, files:write scope and conversation-policy checks. The active custom
// bot and its membership are checked again by this domain, inside reservation.
// It grants no human session, file-content read, or content-upload permission.
func (s *Service) ReserveAgentBotUpload(ctx context.Context, input ReserveUploadInput) (UploadResult, error) {
	return s.reserveUpload(ctx, input, s.lookupAgentBotActor)
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
