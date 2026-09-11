package messages

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// TransactionRejection means the shared writer made no domain mutation and
// wrote its rejection audit. Aggregate callers may commit that evidence; every
// other error must roll back, even when a late association fails validation.
type TransactionRejection struct{ Err *Error }

func (e *TransactionRejection) Error() string { return e.Err.Error() }
func (e *TransactionRejection) Unwrap() error { return e.Err }

// A topic is a scope on the existing message row, not a second message type.
// Reads require current space, group and topic membership. The ordinary
// conversation reader deliberately keeps its topic_id IS NULL filter.
const topicMemberSQL = `EXISTS (
	SELECT 1 FROM topic_members tm
	INNER JOIN topics topic ON topic.id = tm.topic_id AND topic.space_id = m.space_id AND topic.conversation_id = m.conversation_id
	INNER JOIN conversation_members cm ON cm.conversation_id = topic.conversation_id AND cm.user_id = tm.user_id AND cm.removed_at IS NULL
	INNER JOIN space_members sm ON sm.space_id = topic.space_id AND sm.user_id = tm.user_id AND sm.removed_at IS NULL AND sm.role <> 'auditor'
	INNER JOIN users viewer ON viewer.id = tm.user_id AND viewer.kind = 'human'
	WHERE tm.topic_id = m.topic_id AND tm.user_id = $4 AND tm.left_at IS NULL
)`

func findVisibleMessage(ctx context.Context, q pgQueryer, spaceID, conversationID, messageID, viewerID string) (*MessageRecord, error) {
	return scanMessage(q.QueryRow(ctx, messageSelect+`
		WHERE m.space_id = $1 AND m.id = $2
		AND ($3 = '' OR m.conversation_id = $3) AND m.deleted_at IS NULL
		AND (m.topic_id IS NULL OR `+topicMemberSQL+`)
	`, spaceID, messageID, conversationID, viewerID))
}

type topicMessageReader interface {
	ReadTopicMessageRecords(context.Context, string, string, string, []string) ([]MessageRecord, error)
}

func (r *PGRepository) ReadTopicMessageRecords(ctx context.Context, spaceID, topicID, viewerID string, ids []string) ([]MessageRecord, error) {
	rows, err := r.pool.Query(ctx, messageSelect+`
		WHERE m.space_id = $1 AND m.topic_id = $2 AND m.id = ANY($3::text[])
		AND m.deleted_at IS NULL AND `+topicMemberSQL, spaceID, topicID, ids, viewerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]MessageRecord, 0, len(ids))
	for rows.Next() {
		record, err := scanMessageRows(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, *record)
	}
	return records, rows.Err()
}

// ProjectTopicMessages uses the same viewer projection as ordinary messages;
// the repository independently rechecks topic membership before returning rows.
func (s *Service) ProjectTopicMessages(ctx context.Context, actorID, topicID string, ids []string) ([]Message, error) {
	actor, err := s.lookupActor(ctx, s.repo, actorID)
	if err != nil {
		return nil, err
	}
	reader, ok := s.repo.(topicMessageReader)
	if !ok {
		return nil, internalError("read topic messages", errors.New("topic message reader is required"))
	}
	records, err := reader.ReadTopicMessageRecords(ctx, s.space(), topicID, actor.ID, ids)
	if err != nil {
		return nil, err
	}
	return s.projectRecords(ctx, s.repo, actor, records)
}

type topicAccessReader interface {
	TopicMessageAccess(context.Context, string, string, string) (bool, string, error)
}

func (t *pgTx) TopicMessageAccess(ctx context.Context, spaceID, topicID, viewerID string) (bool, string, error) {
	var status string
	err := t.tx.QueryRow(ctx, `
		SELECT topic.status FROM topics topic
		INNER JOIN topic_members tm ON tm.topic_id = topic.id AND tm.user_id = $3 AND tm.left_at IS NULL
		INNER JOIN conversation_members cm ON cm.conversation_id = topic.conversation_id AND cm.user_id = $3 AND cm.removed_at IS NULL
		INNER JOIN space_members sm ON sm.space_id = topic.space_id AND sm.user_id = $3 AND sm.removed_at IS NULL AND sm.role <> 'auditor'
		INNER JOIN users viewer ON viewer.id = tm.user_id AND viewer.kind = 'human'
		WHERE topic.space_id = $1 AND topic.id = $2
		FOR SHARE OF topic, tm, cm, sm, viewer
	`, spaceID, topicID, viewerID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, "", nil
	}
	return err == nil, status, err
}

func (s *Service) authorizeMessageTopic(ctx context.Context, tx Tx, actor *auth.Actor, target *MessageRecord, mutation bool) (*Error, error) {
	if target.TopicID == "" {
		return nil, nil
	}
	if err := tx.Lock(ctx, "workspace:topic:"+target.TopicID); err != nil {
		return nil, err
	}
	access, ok := tx.(topicAccessReader)
	if !ok {
		return messageNotFoundError(), nil
	}
	allowed, status, err := access.TopicMessageAccess(ctx, s.space(), target.TopicID, actor.ID)
	if err != nil {
		return nil, err
	}
	if !allowed || actor.Kind != "human" || actor.Role == "auditor" {
		return messageNotFoundError(), nil
	}
	if mutation && status != "open" {
		return NewError("topic.not_open", "话题已关闭或归档", 400), nil
	}
	return nil, nil
}

func messageMutationEvent(eventType string, target *MessageRecord) (string, []byte, error) {
	payload := map[string]string{"messageId": target.ID, "conversationId": target.ConversationID}
	if target.TopicID != "" {
		payload["topicId"] = target.TopicID
		payload["topicMessageId"] = target.ID
		eventType = "topic.message." + strings.TrimPrefix(eventType, "message.")
	}
	encoded, err := json.Marshal(payload)
	return eventType, encoded, err
}
