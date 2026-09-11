package conversations

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// TopicPinReader keeps pin operations on the existing conversation transaction
// while requiring the narrower topic membership, without a topics import cycle.
type TopicPinReader interface {
	TopicPinStatus(ctx context.Context, spaceID, conversationID, topicID, viewerID string) (string, error)
}

const topicPinVisibleSQL = `(m.topic_id IS NULL OR EXISTS (
	SELECT 1 FROM topics t
	JOIN topic_members tm ON tm.topic_id = t.id AND tm.user_id = $3 AND tm.left_at IS NULL
	JOIN conversation_members cm ON cm.conversation_id = t.conversation_id AND cm.user_id = $3 AND cm.removed_at IS NULL
	JOIN space_members sm ON sm.space_id = t.space_id AND sm.user_id = $3 AND sm.removed_at IS NULL
	JOIN users viewer ON viewer.id = sm.user_id AND viewer.kind = 'human'
	WHERE t.id = m.topic_id AND t.space_id = m.space_id AND t.conversation_id = m.conversation_id
		AND sm.role IN ('owner', 'admin', 'member')))`

const topicPinStatusSQL = `SELECT t.status FROM topics t
	JOIN topic_members tm ON tm.topic_id = t.id AND tm.user_id = $4 AND tm.left_at IS NULL
	JOIN conversation_members cm ON cm.conversation_id = t.conversation_id AND cm.user_id = $4 AND cm.removed_at IS NULL
	JOIN space_members sm ON sm.space_id = t.space_id AND sm.user_id = $4 AND sm.removed_at IS NULL
	JOIN users u ON u.id = sm.user_id AND u.kind = 'human'
	WHERE t.space_id = $1 AND t.conversation_id = $2 AND t.id = $3 AND sm.role IN ('owner', 'admin', 'member')`

func scanTopicPinStatus(row pgx.Row) (string, error) {
	var status string
	err := row.Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", internalError("check topic pin access", err)
	}
	return status, nil
}

func (r *PGRepository) TopicPinStatus(ctx context.Context, spaceID, conversationID, topicID, viewerID string) (string, error) {
	return scanTopicPinStatus(r.pool.QueryRow(ctx, topicPinStatusSQL, spaceID, conversationID, topicID, viewerID))
}

func (t *pgTx) TopicPinStatus(ctx context.Context, spaceID, conversationID, topicID, viewerID string) (string, error) {
	// Share locks prevent a concurrent membership removal or closure from
	// invalidating authorization before the pin mutation commits.
	return scanTopicPinStatus(t.tx.QueryRow(ctx, topicPinStatusSQL+` FOR SHARE OF t, tm, cm, sm, u`, spaceID, conversationID, topicID, viewerID))
}

func (s *Service) topicPinAccess(ctx context.Context, repo ReadRepository, actor *auth.Actor, message *MessageRecord, mutate bool) (*Error, error) {
	if message.TopicID == "" {
		return nil, nil
	}
	if actor == nil || actor.Kind != "human" || actor.Role == "auditor" {
		return messageNotFoundError(), nil
	}
	reader, ok := repo.(TopicPinReader)
	if !ok {
		return messageNotFoundError(), nil
	}
	status, err := reader.TopicPinStatus(ctx, s.space(), message.ConversationID, message.TopicID, actor.ID)
	if err != nil {
		return nil, err
	}
	if status == "" {
		return messageNotFoundError(), nil
	}
	message.TopicReadOnly = status != "open"
	if mutate && message.TopicReadOnly {
		return NewError("topic.not_open", "话题已关闭", 400), nil
	}
	if mutate && message.RecalledAt != nil {
		return messageNotFoundError(), nil
	}
	return nil, nil
}

func pinEvent(spaceID, actorID string, message MessageRecord, unpin bool, now time.Time) EventInput {
	typeName := "message.pinned"
	if unpin {
		typeName = "message.unpinned"
	}
	payload := map[string]any{"conversationId": message.ConversationID, "messageId": message.ID}
	if message.TopicID != "" {
		typeName = "topic." + typeName
		payload["topicId"] = message.TopicID
		payload["topicMessageId"] = message.ID
	}
	return EventInput{SpaceID: spaceID, Type: typeName, ActorID: actorID, ConversationID: message.ConversationID, TargetType: messageTargetType, TargetID: message.ID, PayloadJSON: mustJSON(payload), CreatedAt: now}
}
