package botgateway

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type agentUploadScopeReader interface {
	AgentUploadConversation(context.Context, string, string, string) (string, error)
}

func (r *PGRepository) AgentUploadConversation(ctx context.Context, spaceID, userID, uploadID string) (string, error) {
	return agentUploadConversation(ctx, r.pool, spaceID, userID, uploadID)
}
func (t *pgTx) AgentUploadConversation(ctx context.Context, spaceID, userID, uploadID string) (string, error) {
	return agentUploadConversation(ctx, t.tx, spaceID, userID, uploadID)
}
func agentUploadConversation(ctx context.Context, q pgQueryer, spaceID, userID, uploadID string) (string, error) {
	var conversationID string
	err := q.QueryRow(ctx, `SELECT COALESCE(a.conversation_id,'') FROM transfer_ledger tl
	 JOIN attachments a ON a.id=tl.attachment_id AND a.space_id=tl.space_id
	 WHERE tl.id=$1 AND tl.space_id=$2 AND tl.user_id=$3 AND tl.direction='upload'
	 AND ($4='' OR EXISTS(SELECT 1 FROM workspace_agent_upload_origins o WHERE o.upload_id=tl.id AND o.task_id=$4))`, uploadID, spaceID, userID, AgentTaskID(ctx)).Scan(&conversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", taskForbidden()
	}
	if err != nil {
		return "", internalError("check task upload scope", err)
	}
	return conversationID, nil
}

type agentUploadBinder interface {
	BindAgentUpload(context.Context, string, string, string, string, string) error
}

func (r *PGRepository) BindAgentUpload(ctx context.Context, taskID, spaceID, userID, uploadID, conversationID string) error {
	tag, err := r.pool.Exec(ctx, `INSERT INTO workspace_agent_upload_origins(upload_id,task_id)
	 SELECT tl.id,$1 FROM transfer_ledger tl JOIN attachments a ON a.id=tl.attachment_id
	 WHERE tl.id=$4 AND tl.space_id=$2 AND tl.user_id=$3 AND tl.direction='upload' AND a.conversation_id=$5
	 ON CONFLICT(upload_id) DO UPDATE SET task_id=EXCLUDED.task_id WHERE workspace_agent_upload_origins.task_id=EXCLUDED.task_id`, taskID, spaceID, userID, uploadID, conversationID)
	if err != nil {
		return internalError("bind agent upload", err)
	}
	if tag.RowsAffected() != 1 {
		return taskForbidden()
	}
	return nil
}

func (s *Service) BindAgentUpload(ctx context.Context, value *Auth, uploadID, conversationID string) error {
	if AgentTaskID(ctx) == "" {
		return nil
	}
	if err := s.AuthorizeAgentOperation(ctx, value, conversationID); err != nil {
		return err
	}
	store, ok := s.repo.(agentUploadBinder)
	if !ok {
		return taskForbidden()
	}
	return store.BindAgentUpload(ctx, AgentTaskID(ctx), value.SpaceID, value.UserID, uploadID, conversationID)
}

func (s *Service) AuthorizeAgentUpload(ctx context.Context, value *Auth, uploadID string) error {
	if err := s.AuthorizeAgentOperation(ctx, value, ""); err != nil {
		return err
	}
	if AgentTaskID(ctx) == "" {
		return nil
	}
	store, ok := s.repo.(agentUploadScopeReader)
	if !ok {
		return taskForbidden()
	}
	conversationID, err := store.AgentUploadConversation(ctx, value.SpaceID, value.UserID, uploadID)
	if err != nil {
		return err
	}
	if conversationID == "" {
		return taskForbidden()
	}
	return s.AuthorizeAgentOperation(ctx, value, conversationID)
}

func (s *Service) ReserveAgentUploadBudget(ctx context.Context, value *Auth, conversationID string) error {
	if err := s.AuthorizeAgentOperation(ctx, value, conversationID); err != nil {
		return err
	}
	if AgentTaskID(ctx) == "" {
		return nil
	}
	task, err := s.requireAgentTask(ctx, value, AgentTaskID(ctx), conversationID)
	if err != nil {
		return err
	}
	store, ok := s.repo.(AgentTaskStore)
	if !ok {
		return taskForbidden()
	}
	return store.ConsumeAgentTaskBudget(ctx, task.RootTaskID, 0, 0, 1, s.nowUTC())
}

func (s *Service) AuthorizeAgentMessageMutation(ctx context.Context, value *Auth, messageID string) error {
	if err := s.AuthorizeAgentOperation(ctx, value, ""); err != nil {
		return err
	}
	if AgentTaskID(ctx) == "" {
		return nil
	}
	store, ok := s.repo.(AgentTaskReader)
	if !ok {
		return taskForbidden()
	}
	origin, err := store.GetAgentMessageOrigin(ctx, value.SpaceID, messageID)
	if err != nil {
		return err
	}
	if origin == nil || origin.ID != AgentTaskID(ctx) || origin.BotID != value.BotID {
		return taskForbidden()
	}
	return s.AuthorizeAgentOperation(ctx, value, origin.ConversationID)
}
