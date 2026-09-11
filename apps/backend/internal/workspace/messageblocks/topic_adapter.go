package messageblocks

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

type GroupTopicCreator struct {
	service *topics.Service
	spaceID string
}

func NewGroupTopicCreator(service *topics.Service, spaceID string) *GroupTopicCreator {
	if strings.TrimSpace(spaceID) == "" {
		spaceID = topics.DefaultSpaceID
	}
	return &GroupTopicCreator{service: service, spaceID: spaceID}
}

// CreateGroupTopic is called after message authorization and normalization,
// inside the same transaction. It never falls back to a second pool transaction.
func (a *GroupTopicCreator) CreateGroupTopic(ctx context.Context, tx messages.Tx, input messages.CreateInput, content messages.Content) (*messages.MessageRecord, *messages.GroupTopicRejection, error) {
	provider, ok := tx.(interface{ TopicTransaction() topics.Tx })
	if !ok || provider.TopicTransaction() == nil || a == nil || a.service == nil {
		return nil, nil, errors.New("inline topic transaction adapter is required")
	}
	topicTx := provider.TopicTransaction()
	// Direct topic creation uses the same lock. Taking it before the lookup
	// also protects requests that reuse a topic key for non-topic content.
	if err := topicTx.Lock(ctx, "workspace:topic:create:"+input.ActorID); err != nil {
		return nil, nil, err
	}
	existing, err := topicTx.GetTopicByIdempotency(ctx, a.spaceID, input.ActorID, input.ClientMessageID)
	if err != nil {
		return nil, nil, err
	}
	var source strings.Builder
	eligible := strings.TrimSpace(input.ReplyToMessageID) == "" && len(content.Blocks) > 0
	for _, block := range content.Blocks {
		if block.Type != "text" {
			eligible = false
			break
		}
		source.WriteString(block.Text)
	}
	_, intent := topics.ParseWorkspaceTopicSyntax(source.String())
	if !eligible || !intent {
		if existing != nil && existing.ConversationID == input.ConversationID {
			return nil, &messages.GroupTopicRejection{Err: messages.NewError(messages.CodeMessageIdempotency, messages.MessageIdempotencyConflict, 409)}, nil
		}
		return nil, nil, nil
	}
	topic, err := a.service.CreateInTx(ctx, topicTx, topics.CreateInput{
		ActorID: input.ActorID, ConversationID: input.ConversationID,
		Source: source.String(), IdempotencyKey: input.ClientMessageID,
		AllowSyncToGroup: true, Meta: input.Meta,
	})
	if err != nil {
		var denied *topics.Error
		if topics.IsTransactionRejection(err) && errors.As(err, &denied) {
			return nil, &messages.GroupTopicRejection{Err: messages.NewError(denied.Code, denied.Message, denied.StatusCode), Audited: true}, nil
		}
		return nil, nil, err
	}
	message, err := tx.FindMessageByClientID(ctx, a.spaceID, input.ConversationID, input.ActorID, "topic-card:"+topic.ID)
	if err != nil {
		return nil, nil, err
	}
	if message == nil || message.DeletedAt != nil {
		return nil, nil, messages.NewError("topic.card_missing", "话题卡片不可用", 500)
	}
	return message, nil, nil
}

var _ messages.GroupTopicCreator = (*GroupTopicCreator)(nil)

func (a *GroupTopicCreator) RecallTopicMessage(ctx context.Context, tx messages.Tx, message messages.MessageRecord, actorID string, now time.Time) error {
	provider, ok := tx.(interface{ TopicTransaction() topics.Tx })
	if !ok || provider.TopicTransaction() == nil {
		return errors.New("topic lifecycle transaction is required")
	}
	return a.service.InvalidateMessageProjection(ctx, provider.TopicTransaction(), message.TopicID, message.ID, actorID, now)
}
