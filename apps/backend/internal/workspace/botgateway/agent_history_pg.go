package botgateway

import (
	"context"
	"time"
)

func (r *PGRepository) ListAgentMessages(ctx context.Context, q AgentHistoryQuery) ([]ContextMessageRecord, error) {
	var before any
	if !q.BeforeTime.IsZero() {
		before = q.BeforeTime
	}
	rows, err := r.pool.Query(ctx, `SELECT m.id,m.conversation_id,COALESCE(m.author_id,''),m.author_kind,m.kind,m.content_format,
	 m.content_json,m.plain_text,m.reply_to_message_id,m.created_at
	 FROM messages m WHERE m.space_id=$1 AND m.conversation_id=$2
	 AND m.topic_id IS NULL AND m.deleted_at IS NULL AND m.recalled_at IS NULL
	 AND m.kind<>'system' AND m.author_kind<>'system' AND m.created_at>=$5 AND m.created_at<=$6
	 AND ($7='' OR m.id=$7) AND ($8='' OR strpos(lower(m.plain_text),lower($8))>0)
	 AND ($9='' OR m.author_id=$9)
	 AND ($10::timestamptz IS NULL OR (m.created_at,m.id)<($10::timestamptz,$11::text))
	 AND ($12::boolean OR m.reply_to_message_id IS NULL)
	 AND NOT EXISTS(SELECT 1 FROM message_hidden_states hs WHERE hs.message_id=m.id AND hs.user_id IN ($3,$4))
	 AND EXISTS(SELECT 1 FROM conversation_members cm JOIN space_members sm ON sm.user_id=cm.user_id AND sm.space_id=$1 AND sm.removed_at IS NULL
	 WHERE cm.conversation_id=$2 AND cm.user_id=$3 AND cm.removed_at IS NULL)
	 AND EXISTS(SELECT 1 FROM conversation_members cm JOIN space_members sm ON sm.user_id=cm.user_id AND sm.space_id=$1 AND sm.removed_at IS NULL
	 WHERE cm.conversation_id=$2 AND cm.user_id=$4 AND cm.removed_at IS NULL)
	 ORDER BY m.created_at DESC,m.id DESC LIMIT $13`, q.SpaceID, q.ConversationID, q.RequestorID, q.BotUserID, q.Since, q.Until, q.MessageID, q.Query, q.AuthorID, before, q.BeforeID, q.IncludeReplies, q.Limit)
	if err != nil {
		return nil, internalError("query authorized agent history", err)
	}
	defer rows.Close()
	result := make([]ContextMessageRecord, 0)
	for rows.Next() {
		var v ContextMessageRecord
		var content string
		if err := rows.Scan(&v.ID, &v.ConversationID, &v.AuthorID, &v.AuthorKind, &v.Kind, &v.ContentFormat, &content, &v.PlainText, &v.ReplyToMessageID, &v.CreatedAt); err != nil {
			return nil, internalError("read agent history", err)
		}
		v.ContentJSON = []byte(content)
		v.CreatedAt = v.CreatedAt.UTC()
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("read agent history rows", err)
	}
	return result, nil
}

func (r *PGRepository) ListAgentMembers(ctx context.Context, spaceID, conversationID string, limit int) ([]AgentMember, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	rows, err := r.pool.Query(ctx, `SELECT u.id,COALESCE(NULLIF(u.nickname,''),NULLIF(u.display_name,''),u.id),u.kind,COALESCE(b.id,'')
	 FROM conversation_members cm JOIN users u ON u.id=cm.user_id
	 LEFT JOIN workspace_agent_bots b ON b.bot_user_id=u.id AND b.space_id=$1 AND b.status='active'
	 JOIN space_members sm ON sm.user_id=u.id AND sm.space_id=$1 AND sm.removed_at IS NULL
	 WHERE cm.conversation_id=$2 AND cm.removed_at IS NULL AND u.kind IN ('human','bot')
	 ORDER BY u.id LIMIT $3`, spaceID, conversationID, limit)
	if err != nil {
		return nil, internalError("query agent conversation members", err)
	}
	defer rows.Close()
	result := make([]AgentMember, 0)
	for rows.Next() {
		var v AgentMember
		if err := rows.Scan(&v.ID, &v.Name, &v.Kind, &v.BotID); err != nil {
			return nil, internalError("read agent member", err)
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("read agent members", err)
	}
	return result, nil
}
