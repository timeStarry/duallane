package botgateway

import (
	"context"
	"time"
)

type agentResourceReader interface {
	AgentAttachmentReferenceAllowed(context.Context, string, string, bool, time.Time) (bool, error)
}

func agentAttachmentReferenceAllowed(ctx context.Context, q pgQueryer, taskID, attachmentID string, published bool, since time.Time) (bool, error) {
	var allowed bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_agent_tasks t JOIN workspace_agent_bots b ON b.id=t.bot_id JOIN attachments a ON a.id=$2
	 WHERE t.id=$1 AND a.space_id=t.space_id AND a.conversation_id=t.conversation_id AND a.visibility='conversation' AND a.status='available'
	 AND (EXISTS(SELECT 1 FROM workspace_agent_upload_origins o WHERE o.upload_id=a.upload_transfer_id AND o.task_id=t.id)
	 OR ($3::boolean AND EXISTS(SELECT 1 FROM message_attachments ma JOIN messages m ON m.id=ma.message_id
	 WHERE ma.attachment_id=a.id AND m.space_id=t.space_id AND m.conversation_id=t.conversation_id
	 AND m.topic_id IS NULL AND m.kind<>'system' AND m.author_kind<>'system' AND m.deleted_at IS NULL AND m.recalled_at IS NULL AND (m.created_at>=$4 OR m.id=t.trigger_message_id)
	 AND NOT EXISTS(SELECT 1 FROM message_hidden_states hs WHERE hs.message_id=m.id AND hs.user_id IN(t.requestor_user_id,b.bot_user_id))))))`, taskID, attachmentID, published, since).Scan(&allowed)
	if err != nil {
		return false, internalError("authorize task resource reference", err)
	}
	return allowed, nil
}
func (r *PGRepository) AgentAttachmentReferenceAllowed(ctx context.Context, taskID, attachmentID string, published bool, since time.Time) (bool, error) {
	return agentAttachmentReferenceAllowed(ctx, r.pool, taskID, attachmentID, published, since)
}
func (t *pgTx) AgentAttachmentReferenceAllowed(ctx context.Context, taskID, attachmentID string, published bool, since time.Time) (bool, error) {
	return agentAttachmentReferenceAllowed(ctx, t.tx, taskID, attachmentID, published, since)
}

func (s *Service) authorizeAgentResource(ctx context.Context, reader ReadRepository, resources agentResourceReader, current *Auth, task *AgentTask, attachmentID string) error {
	settings, err := reader.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return err
	}
	grant, err := reader.GetContextGrant(ctx, current.BotID, current.SpaceID, task.ConversationID)
	if err != nil {
		return err
	}
	published := grant != nil && grant.AllowContext && RequireScope(current, ScopeMessagesReadContext) == nil && RequireScope(current, ScopeFilesReadMetadata) == nil
	window := 86400
	if settings != nil && settings.ContextWindowSeconds > 0 {
		window = settings.ContextWindowSeconds
	}
	allowed, err := resources.AgentAttachmentReferenceAllowed(ctx, task.ID, attachmentID, published, task.CreatedAt.Add(-time.Duration(window)*time.Second))
	if err != nil {
		return err
	}
	if !allowed {
		return taskForbidden()
	}
	return nil
}

func (s *Service) validateAgentMessageResources(ctx context.Context, tx Tx, current *Auth, content MessageContent) error {
	if AgentTaskID(ctx) == "" {
		return nil
	}
	store, ok := tx.(AgentTaskMutation)
	if !ok {
		return taskForbidden()
	}
	resources, ok := tx.(agentResourceReader)
	if !ok {
		return taskForbidden()
	}
	task, err := store.GetAgentTask(ctx, AgentTaskID(ctx))
	if err != nil {
		return err
	}
	if task == nil {
		return taskForbidden()
	}
	for _, block := range content.Blocks {
		if block["type"] == "attachment" {
			id, _ := block["attachmentId"].(string)
			if err := s.authorizeAgentResource(ctx, tx, resources, current, task, id); err != nil {
				return err
			}
		} else if block["type"] == "card" {
			id, _ := block["cardId"].(string)
			if err := s.authorizeAgentCardReference(ctx, tx, current, task, id); err != nil {
				return err
			}
		}
	}
	return nil
}

// Published references require the same source visibility as history. Knowing a
// card ID cannot move a private-topic/resource card into the ordinary channel.
func (s *Service) authorizeAgentCardReference(ctx context.Context, tx Tx, current *Auth, task *AgentTask, cardID string) error {
	binding, ok := tx.(agentCardBinding)
	if !ok {
		return taskForbidden()
	}
	own, err := binding.AgentTaskOwnsCard(ctx, task.ID, cardID)
	if err != nil {
		return err
	}
	published := false
	if !own {
		grant, err := tx.GetContextGrant(ctx, current.BotID, current.SpaceID, task.ConversationID)
		if err != nil {
			return err
		}
		published = grant != nil && grant.AllowContext && RequireScope(current, ScopeMessagesReadContext) == nil
	}
	settings, err := tx.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return err
	}
	window := 86400
	if settings != nil && settings.ContextWindowSeconds > 0 {
		window = settings.ContextWindowSeconds
	}
	reader, ok := tx.(interface {
		AgentCardReferenceAllowed(context.Context, string, string, bool, bool, time.Time) (bool, error)
	})
	if !ok {
		return taskForbidden()
	}
	allowed, err := reader.AgentCardReferenceAllowed(ctx, task.ID, cardID, own, published, task.CreatedAt.Add(-time.Duration(window)*time.Second))
	if err != nil {
		return err
	}
	if !allowed {
		return taskForbidden()
	}
	return nil
}

func (t *pgTx) AgentCardReferenceAllowed(ctx context.Context, taskID, cardID string, own, published bool, since time.Time) (bool, error) {
	var allowed bool
	err := t.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_agent_tasks t
 JOIN workspace_agent_bots b ON b.id=t.bot_id JOIN workspace_cards c ON c.id=$2
 WHERE t.id=$1 AND c.space_id=t.space_id AND c.conversation_id=t.conversation_id AND c.visibility_scope='conversation'
 AND c.status='active' AND ($3::boolean OR ($4::boolean AND EXISTS(SELECT 1 FROM messages m
 WHERE m.space_id=t.space_id AND m.conversation_id=t.conversation_id AND m.topic_id IS NULL
 AND m.kind<>'system' AND m.author_kind<>'system' AND m.deleted_at IS NULL AND m.recalled_at IS NULL AND (m.created_at>=$5 OR m.id=t.trigger_message_id)
 AND m.content_json::jsonb->'blocks' @> jsonb_build_array(jsonb_build_object('type','card','cardId',$2::text))
 AND NOT EXISTS(SELECT 1 FROM message_hidden_states hs WHERE hs.message_id=m.id AND hs.user_id IN(t.requestor_user_id,b.bot_user_id))))))`, taskID, cardID, own, published, since).Scan(&allowed)
	if err != nil {
		return false, internalError("authorize task card reference", err)
	}
	return allowed, nil
}
