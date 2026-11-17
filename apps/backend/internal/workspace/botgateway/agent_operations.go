package botgateway

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type agentOperationReader interface {
	AgentOperationResult(context.Context, string, string, string, time.Time) ([]byte, error)
}

func (t *pgTx) RecordAgentOperation(ctx context.Context, taskID, botID, operation, key string) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO workspace_agent_task_operations(task_id,bot_id,operation,idempotency_key)
	 VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, taskID, botID, operation, key)
	if err != nil {
		return internalError("record task operation", err)
	}
	return nil
}

func (r *PGRepository) AgentOperationResult(ctx context.Context, taskID, operation, key string, now time.Time) ([]byte, error) {
	var data string
	err := r.pool.QueryRow(ctx, `SELECT i.response_json FROM workspace_agent_task_operations o
	 JOIN workspace_agent_bot_idempotency i ON i.bot_id=o.bot_id AND i.operation=o.operation AND i.idempotency_key=o.idempotency_key
	 WHERE o.task_id=$1 AND o.operation=$2 AND o.idempotency_key=$3 AND i.expires_at>$4`, taskID, operation, key, now).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read task operation result", err)
	}
	return []byte(data), nil
}

func (s *Service) GetAgentOperation(ctx context.Context, value *Auth, taskID, operation, key string) (map[string]any, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	if scoped := AgentTaskID(ctx); scoped != "" && scoped != taskID {
		return nil, taskForbidden()
	}
	ctx = WithAgentTaskID(ctx, taskID)
	task, err := s.requireAgentTask(ctx, current, taskID, "")
	if err != nil {
		return nil, err
	}
	if !identifierPattern.MatchString(operation) || !identifierPattern.MatchString(key) {
		return nil, NewError(CodeInvalidRequest, "操作引用无效", 400)
	}
	store, ok := s.repo.(agentOperationReader)
	if !ok {
		return nil, taskForbidden()
	}
	if err := s.consumeAgentRead(ctx, current, task.ConversationID, 0); err != nil {
		return nil, err
	}
	data, err := store.AgentOperationResult(ctx, taskID, operation, key, s.nowUTC())
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return map[string]any{"status": "unknown", "safeToRetry": false}, nil
	}
	var result any
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, internalError("decode task operation result", err)
	}
	if err := s.chargeAgentReadBytes(ctx, current, task.ConversationID, int64(len(data))); err != nil {
		return nil, err
	}
	return map[string]any{"status": "committed", "result": result, "humanRead": false}, nil
}
