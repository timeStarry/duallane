package botgateway

import (
	"context"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/botpolicy"
)

func (s *Service) agentTaskRequired(settings *Settings) bool {
	return settings != nil && settings.AccessPolicy != nil
}

func (s *Service) taskBotSourceAllowed(settings *Settings, botID string) bool {
	return settings != nil && settings.AccessPolicy != nil && botpolicy.AllowsBotGroup(*settings.AccessPolicy, botID, true)
}

func (s *Service) taskRequestorAllowed(ctx context.Context, reader ReadRepository, settings *Settings, current *Auth, userID, conversationType string) (bool, error) {
	if settings == nil {
		return false, nil
	}
	owner := current.OwnerUserID != "" && current.OwnerUserID == userID
	if settings.AccessPolicy != nil {
		if conversationType == "direct" {
			return settings.AllowDirect && botpolicy.AllowsDirect(*settings.AccessPolicy, userID, owner, true), nil
		}
		return settings.AllowGroup && botpolicy.AllowsHumanGroup(*settings.AccessPolicy, userID, owner, true), nil
	}
	if owner {
		return true, nil
	}
	switch settings.VisibilityPolicy {
	case "space_members":
		return true, nil
	case "groups":
		return conversationType == "group", nil
	case "specified_members":
		return reader.VisibilityMember(ctx, current.BotID, current.SpaceID, userID)
	default:
		return false, nil
	}
}

func (s *Service) authorizeAgentBotSource(ctx context.Context, current *Auth, event EventRecord, settings *Settings) (bool, error) {
	if settings == nil || settings.AccessPolicy == nil || !settings.AccessPolicy.Groups.AllowBotTriggers {
		return false, nil
	}
	store, ok := s.repo.(AgentTaskReader)
	if !ok {
		return false, nil
	}
	parent, err := store.GetAgentMessageOrigin(ctx, current.SpaceID, event.TargetID)
	if err != nil {
		return false, err
	}
	if parent == nil || parent.ConversationID != event.ConversationID || parent.Depth >= AgentTaskMaxDepth || !s.taskBotSourceAllowed(settings, parent.BotID) {
		return false, nil
	}
	parentAuth, err := s.repo.ValidateToken(ctx, parent.TokenID, parent.BotID, parent.SpaceID, s.nowUTC())
	if err != nil {
		return false, err
	}
	if parentAuth == nil || parentAuth.UserID != event.ActorUserID {
		return false, nil
	}
	if err := s.validateAgentTask(ctx, s.repo, store, parentAuth, parent, event.ConversationID); err != nil {
		return false, nil
	}
	rootRequestor, err := s.repo.GetSender(ctx, current.SpaceID, event.ConversationID, parent.RequestorUserID)
	if err != nil {
		return false, err
	}
	if rootRequestor == nil || rootRequestor.Kind != "human" || rootRequestor.Role == "auditor" {
		return false, nil
	}
	return s.taskRequestorAllowed(ctx, s.repo, settings, current, rootRequestor.ID, "group")
}
