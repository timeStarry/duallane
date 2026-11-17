package botgateway

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

const agentTaskColumns = `id, bot_id, token_id, space_id, conversation_id, event_id,
 trigger_message_id, requestor_user_id, root_task_id, COALESCE(parent_task_id, ''), input_hash, authorization_hash,
 depth, reads_used, read_bytes, writes_used, children_used, cancelled_at, created_at, expires_at`

func scanAgentTask(row pgx.Row) (*AgentTask, error) {
	var t AgentTask
	err := row.Scan(&t.ID, &t.BotID, &t.TokenID, &t.SpaceID, &t.ConversationID, &t.EventID,
		&t.TriggerMessageID, &t.RequestorUserID, &t.RootTaskID, &t.ParentTaskID, &t.InputHash, &t.AuthorizationHash,
		&t.Depth, &t.ReadsUsed, &t.ReadBytes, &t.WritesUsed, &t.ChildrenUsed, &t.CancelledAt, &t.CreatedAt, &t.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read agent task", err)
	}
	return &t, nil
}

func getAgentTask(ctx context.Context, q pgQueryer, id string) (*AgentTask, error) {
	return scanAgentTask(q.QueryRow(ctx, `SELECT `+agentTaskColumns+` FROM workspace_agent_tasks WHERE id=$1`, id))
}

func (r *PGRepository) GetAgentTask(ctx context.Context, id string) (*AgentTask, error) {
	return getAgentTask(ctx, r.pool, id)
}
func (t *pgTx) GetAgentTask(ctx context.Context, id string) (*AgentTask, error) {
	return getAgentTask(ctx, t.tx, id)
}

func getAgentMessageOrigin(ctx context.Context, q pgQueryer, spaceID, messageID string) (*AgentTask, error) {
	var id string
	err := q.QueryRow(ctx, `SELECT o.task_id FROM workspace_agent_message_origins o
	 JOIN messages m ON m.id=o.message_id WHERE m.id=$1 AND m.space_id=$2 AND m.deleted_at IS NULL AND m.recalled_at IS NULL`, messageID, spaceID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read agent message origin", err)
	}
	return getAgentTask(ctx, q, id)
}
func (r *PGRepository) GetAgentMessageOrigin(ctx context.Context, spaceID, messageID string) (*AgentTask, error) {
	return getAgentMessageOrigin(ctx, r.pool, spaceID, messageID)
}
func (t *pgTx) GetAgentMessageOrigin(ctx context.Context, spaceID, messageID string) (*AgentTask, error) {
	return getAgentMessageOrigin(ctx, t.tx, spaceID, messageID)
}

func agentTaskEvent(ctx context.Context, q pgQueryer, botID, spaceID, eventID string, now time.Time) (*EventRecord, error) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_agent_bot_deliveries
	 WHERE bot_id=$1 AND space_id=$2 AND event_id=$3 AND status<>'expired' AND expires_at>$4)`, botID, spaceID, eventID, now).Scan(&exists)
	if err != nil {
		return nil, internalError("check agent task delivery", err)
	}
	if !exists {
		return nil, nil
	}
	return getEvent(ctx, q, spaceID, eventID)
}
func (r *PGRepository) AgentTaskEvent(ctx context.Context, botID, spaceID, eventID string, now time.Time) (*EventRecord, error) {
	return agentTaskEvent(ctx, r.pool, botID, spaceID, eventID, now)
}
func (t *pgTx) AgentTaskEvent(ctx context.Context, botID, spaceID, eventID string, now time.Time) (*EventRecord, error) {
	return agentTaskEvent(ctx, t.tx, botID, spaceID, eventID, now)
}

func (r *PGRepository) CreateAgentTask(ctx context.Context, input AgentTask) (*AgentTask, error) {
	var result *AgentTask
	err := r.WithTx(ctx, func(transaction Tx) error {
		tx := transaction.(*pgTx)
		if err := tx.Lock(ctx, "agent-task:"+input.BotID+":"+input.EventID); err != nil {
			return err
		}
		existing, err := scanAgentTask(tx.tx.QueryRow(ctx, `SELECT `+agentTaskColumns+` FROM workspace_agent_tasks WHERE bot_id=$1 AND event_id=$2`, input.BotID, input.EventID))
		if err != nil {
			return err
		}
		if existing != nil {
			result = existing
			return nil
		}
		if input.ParentTaskID != "" {
			tag, err := tx.tx.Exec(ctx, `UPDATE workspace_agent_tasks SET children_used=children_used+1
			 WHERE id=$1 AND cancelled_at IS NULL AND expires_at>$2 AND children_used<$3`, input.RootTaskID, input.CreatedAt, AgentTaskMaxChildren)
			if err != nil {
				return internalError("reserve agent child task", err)
			}
			if tag.RowsAffected() != 1 {
				return taskBudgetExceeded()
			}
		}
		_, err = tx.tx.Exec(ctx, `INSERT INTO workspace_agent_tasks
		 (id,bot_id,token_id,space_id,conversation_id,event_id,trigger_message_id,requestor_user_id,
		  root_task_id,parent_task_id,input_hash,depth,created_at,expires_at,authorization_hash)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULLIF($10,''),$11,$12,$13,$14,$15)`,
			input.ID, input.BotID, input.TokenID, input.SpaceID, input.ConversationID, input.EventID, input.TriggerMessageID,
			input.RequestorUserID, input.RootTaskID, input.ParentTaskID, input.InputHash, input.Depth, input.CreatedAt, input.ExpiresAt, input.AuthorizationHash)
		if err != nil {
			return internalError("create agent task", err)
		}
		result = &input
		return nil
	})
	return result, err
}

func consumeAgentTaskBudget(ctx context.Context, q pgQueryer, id string, reads int, bytes int64, writes int, now time.Time) error {
	if reads < 0 || bytes < 0 || writes < 0 {
		return taskBudgetExceeded()
	}
	tag, err := q.Exec(ctx, `UPDATE workspace_agent_tasks SET reads_used=reads_used+$2,read_bytes=read_bytes+$3,writes_used=writes_used+$4
	 WHERE id=$1 AND root_task_id=id AND cancelled_at IS NULL AND expires_at>$5
	 AND reads_used+$2<=$6 AND read_bytes+$3<=$7 AND writes_used+$4<=$8`, id, reads, bytes, writes, now, AgentTaskMaxReads, AgentTaskMaxReadBytes, AgentTaskMaxWrites)
	if err != nil {
		return internalError("reserve agent task budget", err)
	}
	if tag.RowsAffected() != 1 {
		return taskBudgetExceeded()
	}
	return nil
}
func (r *PGRepository) ConsumeAgentTaskBudget(ctx context.Context, id string, reads int, bytes int64, writes int, now time.Time) error {
	return consumeAgentTaskBudget(ctx, r.pool, id, reads, bytes, writes, now)
}
func (t *pgTx) ConsumeAgentTaskBudget(ctx context.Context, id string, reads int, bytes int64, writes int, now time.Time) error {
	return consumeAgentTaskBudget(ctx, t.tx, id, reads, bytes, writes, now)
}

func (r *PGRepository) CancelAgentTask(ctx context.Context, id string, now time.Time) error {
	_, err := r.pool.Exec(ctx, `UPDATE workspace_agent_tasks SET cancelled_at=COALESCE(cancelled_at,$2) WHERE id=$1`, id, now)
	if err != nil {
		return internalError("cancel agent task", err)
	}
	return nil
}

func (t *pgTx) RecordAgentMessageOrigin(ctx context.Context, messageID, taskID string) error {
	tag, err := t.tx.Exec(ctx, `INSERT INTO workspace_agent_message_origins(message_id,task_id) VALUES($1,$2)
	 ON CONFLICT(message_id) DO UPDATE SET task_id=EXCLUDED.task_id WHERE workspace_agent_message_origins.task_id=EXCLUDED.task_id`, messageID, taskID)
	if err != nil {
		return internalError("record agent message origin", err)
	}
	if tag.RowsAffected() != 1 {
		return taskForbidden()
	}
	return nil
}

// Lock the same lifecycle keys as Bot management before taking domain locks.
// Sorted ancestors serialize overlapping delegation chains without inventing a
// parallel owner for token, policy or context-grant authorization.
func (t *pgTx) LockAgentAuthorization(ctx context.Context, taskID string, now time.Time) error {
	var tasks []*AgentTask
	ids := make(map[string]bool)
	for hops := 0; taskID != ""; hops++ {
		if hops > AgentTaskMaxDepth {
			return taskInvalid()
		}
		task, err := getAgentTask(ctx, t.tx, taskID)
		if err != nil {
			return err
		}
		if task == nil {
			return taskInvalid()
		}
		tasks = append(tasks, task)
		ids[task.SpaceID+":"+task.BotID] = true
		taskID = task.ParentTaskID
	}
	keys := make([]string, 0, len(ids))
	for id := range ids {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "workspace-agent-bot:lifecycle:"+key); err != nil {
			return internalError("lock task policy", err)
		}
	}
	messageIDs := make([]string, 0, len(tasks))
	userIDs := make([]string, 0, len(tasks)+1)
	tokenIDs := make([]string, 0, len(tasks))
	botIDs := make([]string, 0, len(tasks))
	for _, task := range tasks {
		messageIDs = append(messageIDs, task.TriggerMessageID)
		userIDs = append(userIDs, task.RequestorUserID)
		tokenIDs = append(tokenIDs, task.TokenID)
		botIDs = append(botIDs, task.BotID)
		value, err := lookupAuth(ctx, t.tx, task.TokenID, task.BotID, task.SpaceID, now)
		if err != nil {
			return err
		}
		if value == nil {
			return taskInvalid()
		}
		userIDs = append(userIDs, value.UserID, value.OwnerUserID)
	}
	if len(tasks) == 0 {
		return taskInvalid()
	}
	if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "workspace:conversation:"+tasks[0].SpaceID+":"+tasks[0].ConversationID); err != nil {
		return internalError("lock task conversation", err)
	}
	queries := []struct {
		sql  string
		args []any
	}{
		{`SELECT id FROM workspace_agent_bots WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, []any{botIDs}},
		{`SELECT id FROM workspace_agent_bot_tokens WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, []any{tokenIDs}},
		{`SELECT bot_id FROM workspace_agent_bot_settings WHERE bot_id=ANY($1::text[]) ORDER BY bot_id FOR SHARE`, []any{botIDs}},
		{`SELECT bot_id FROM workspace_agent_bot_group_policies WHERE conversation_id=$1 AND bot_id=ANY($2::text[]) ORDER BY bot_id FOR SHARE`, []any{tasks[0].ConversationID, botIDs}},
		{`SELECT grant_id FROM workspace_agent_bot_context_grants WHERE conversation_id=$1 AND bot_id=ANY($2::text[]) ORDER BY bot_id FOR SHARE`, []any{tasks[0].ConversationID, botIDs}},
		{`SELECT id FROM messages WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, []any{messageIDs}},
		{`SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id=ANY($2::text[]) ORDER BY user_id FOR SHARE`, []any{tasks[0].ConversationID, userIDs}},
		{`SELECT user_id FROM space_members WHERE space_id=$1 AND user_id=ANY($2::text[]) ORDER BY user_id FOR SHARE`, []any{tasks[0].SpaceID, userIDs}},
	}
	for _, query := range queries {
		rows, err := t.tx.Query(ctx, query.sql, query.args...)
		if err != nil {
			return internalError("lock task input state", err)
		}
		for rows.Next() {
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return internalError("lock task input state", err)
		}
	}
	return nil
}
