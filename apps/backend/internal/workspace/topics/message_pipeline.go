package topics

import (
	"context"
	"errors"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// MessagePipeline is the ordinary Workspace message implementation, adapted
// to a topic-owned transaction. The topic service owns membership, status,
// independent read state and synchronization; content and message behavior have
// one implementation in the message service.
type MessagePipeline interface {
	CreateMessage(context.Context, Tx, TopicRecord, CreateMessageInput) (TopicMessageResult, error)
	ProjectMessages(context.Context, string, []TopicMessage) ([]TopicMessage, error)
}

// SetMessagePipeline is startup-only composition, after the mutually referring
// topic-card validator and ordinary message service have been constructed.
func (s *Service) SetMessagePipeline(pipeline MessagePipeline) { s.messagePipeline = pipeline }

// EnforceMessageRetention keeps topic projections and cards consistent while
// the shared message writer owns content and relationship writes.
func (s *Service) EnforceMessageRetention(ctx context.Context, tx Tx, topic TopicRecord, now time.Time) error {
	return s.enforceRetention(ctx, tx, topic, now)
}

// InvalidateMessageProjection executes in the shared recall transaction. A
// group sync card must never retain the withdrawn source's cached preview.
func (s *Service) InvalidateMessageProjection(ctx context.Context, tx Tx, topicID, messageID, actorID string, now time.Time) error {
	projection, err := tx.GetActiveProjection(ctx, s.space(), topicID, messageID)
	if reader, ok := tx.(interface {
		GetMessageProjectionIncludingRemoved(context.Context, string, string, string) (*ProjectionRecord, error)
	}); ok {
		projection, err = reader.GetMessageProjectionIncludingRemoved(ctx, s.space(), topicID, messageID)
	}
	if err != nil || projection == nil {
		return err
	}
	if _, err := tx.UnsyncProjection(ctx, projection.ID, now); err != nil {
		return err
	}
	if err := tx.MarkGroupMessageDeleted(ctx, projection.GroupMessageID, now); err != nil {
		return err
	}
	if card, changed, err := tx.InvalidateCard(ctx, projection.ID, now); err != nil {
		return err
	} else if changed {
		if err := s.writeEventPayload(ctx, tx, EventInput{Type: "card.invalidated", ActorID: actorID, ConversationID: projection.GroupConversationID, TargetType: "workspace.card", TargetID: card.ID, Payload: map[string]any{"cardId": card.ID, "cardType": card.CardType, "revision": card.Revision, "status": card.Status}}, now); err != nil {
			return err
		}
	}
	if projection.RemovedAt != nil {
		return nil
	}
	if err := s.writeEventPayload(ctx, tx, EventInput{Type: "topic.message.unsynced", ActorID: actorID, ConversationID: projection.GroupConversationID, TargetType: TopicMessageTargetType, TargetID: messageID, Payload: map[string]any{"topicId": topicID, "topicMessageId": messageID, "projectionId": projection.ID}}, now); err != nil {
		return err
	}
	return s.writeEventPayload(ctx, tx, EventInput{Type: "message.recalled", ActorID: actorID, ConversationID: projection.GroupConversationID, TargetType: MessageTargetType, TargetID: projection.GroupMessageID, Payload: map[string]any{"messageId": projection.GroupMessageID, "conversationId": projection.GroupConversationID}}, now)
}

func (s *Service) createSharedMessage(ctx context.Context, tx Tx, actor *auth.Actor, topic TopicRecord, input CreateMessageInput, now time.Time) (any, *rejection, error) {
	// Share the ordinary group lock, then the topic state lock. Close/leave and
	// message actions take the same topic lock, so stale clients cannot write.
	if err := tx.Lock(ctx, "workspace:conversation:"+s.space()+":"+topic.ConversationID); err != nil {
		return nil, nil, err
	}
	if err := tx.Lock(ctx, "workspace:topic:"+topic.ID); err != nil {
		return nil, nil, err
	}
	current, denied, err := s.topicForActor(ctx, tx, actor, topic.ID, true)
	if err != nil {
		return nil, nil, err
	}
	if denied != nil {
		return nil, rejected(denied, "topic.message.create", topic.ID, denied.Code), nil
	}
	if current.Status != StatusOpen {
		return nil, rejected(topicValidationError(CodeTopicNotOpen, MessageTopicNotOpen), "topic.message.create", topic.ID, CodeTopicNotOpen), nil
	}
	result, err := s.messagePipeline.CreateMessage(ctx, tx, *current, input)
	if err != nil {
		var domainErr *Error
		if errors.As(err, &domainErr) && domainErr.StatusCode < 500 {
			return nil, &rejection{err: domainErr, audited: true}, nil
		}
		return nil, nil, err
	}
	if input.SyncToGroup {
		if _, err := s.syncTopicMessageTx(ctx, tx, actor, *current, result.Message.ID, input.Meta, now); err != nil {
			return nil, nil, err
		}
	}
	result.Unread, err = tx.TopicUnread(ctx, s.space(), topic.ID, actor.ID)
	return result, nil, err
}

func (s *Service) lockWritableTopic(ctx context.Context, tx Tx, actor *auth.Actor, topic TopicRecord) (*TopicRecord, *Error, error) {
	if err := tx.Lock(ctx, "workspace:conversation:"+s.space()+":"+topic.ConversationID); err != nil {
		return nil, nil, err
	}
	if err := tx.Lock(ctx, "workspace:topic:"+topic.ID); err != nil {
		return nil, nil, err
	}
	current, denied, err := s.topicForActor(ctx, tx, actor, topic.ID, true)
	if err != nil || denied != nil {
		return nil, denied, err
	}
	if current.Status != StatusOpen {
		return nil, topicValidationError(CodeTopicNotOpen, MessageTopicNotOpen), nil
	}
	return current, nil, nil
}
