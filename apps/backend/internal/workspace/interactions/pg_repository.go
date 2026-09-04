package interactions

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type pgQueryer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type PGRepository struct {
	pool      *pgxpool.Pool
	idFactory func() (string, error)
}

func NewPGRepository(pool *pgxpool.Pool, factories ...func() (string, error)) *PGRepository {
	factory := func() (string, error) {
		id, err := uuid.NewRandom()
		if err != nil {
			return "", err
		}
		return id.String(), nil
	}
	if len(factories) > 0 && factories[0] != nil {
		factory = factories[0]
	}
	return &PGRepository{pool: pool, idFactory: factory}
}
func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace interactions postgres pool is required")
	}
	return r.pool.Ping(ctx)
}
func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace interactions postgres pool is required")
	}
	if callback == nil {
		return errors.New("workspace interactions transaction callback is required")
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()
	if err := callback(&pgTx{tx: tx, repository: r}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace interactions postgres pool is required")
	}
	return lookupActor(ctx, r.pool, spaceID, userID)
}
func lookupActor(ctx context.Context, queryer pgQueryer, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	err := queryer.QueryRow(ctx, `SELECT u.id, u.github_login, u.kind, sm.role, sm.joined_at FROM users u JOIN space_members sm ON sm.user_id = u.id WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL`, userID, spaceID).Scan(&actor.ID, &actor.GitHubLogin, &actor.Kind, &actor.Role, &actor.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	actor.JoinedAt = actor.JoinedAt.UTC()
	return &actor, nil
}
func (r *PGRepository) GetConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace interactions postgres pool is required")
	}
	return getConversation(ctx, r.pool, spaceID, conversationID)
}
func getConversation(ctx context.Context, queryer pgQueryer, spaceID, conversationID string) (*ConversationRecord, error) {
	var record ConversationRecord
	err := queryer.QueryRow(ctx, `SELECT id, space_id, type FROM conversations WHERE id = $1 AND space_id = $2`, conversationID, spaceID).Scan(&record.ID, &record.SpaceID, &record.Type)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}
func (r *PGRepository) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace interactions postgres pool is required")
	}
	return conversationMemberActive(ctx, r.pool, spaceID, conversationID, userID)
}
func conversationMemberActive(ctx context.Context, queryer pgQueryer, spaceID, conversationID, userID string) (bool, error) {
	var present bool
	err := queryer.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1 WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL)`, spaceID, conversationID, userID).Scan(&present)
	return present, err
}
func (r *PGRepository) BotMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace interactions postgres pool is required")
	}
	return botMemberActive(ctx, r.pool, spaceID, conversationID, userID)
}
func botMemberActive(ctx context.Context, queryer pgQueryer, spaceID, conversationID, userID string) (bool, error) {
	var present bool
	err := queryer.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1 JOIN users u ON u.id = cm.user_id JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = c.space_id AND sm.removed_at IS NULL WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL AND u.kind IN ('bot', 'system'))`, spaceID, conversationID, userID).Scan(&present)
	return present, err
}

func (r *PGRepository) GetCommandRun(ctx context.Context, spaceID, actorID, clientID string) (*CommandRunRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace interactions postgres pool is required")
	}
	return getCommandRun(ctx, r.pool, spaceID, actorID, clientID)
}
func getCommandRun(ctx context.Context, queryer pgQueryer, spaceID, actorID, clientID string) (*CommandRunRecord, error) {
	var record CommandRunRecord
	err := queryer.QueryRow(ctx, `SELECT id, space_id, conversation_id, actor_user_id, bot_user_id, command_name, command_version, client_invocation_id, request_hash, arguments_json, status, result_card_id, COALESCE(result_json, ''), COALESCE(error_code, ''), created_at, completed_at FROM workspace_command_runs WHERE space_id = $1 AND actor_user_id = $2 AND client_invocation_id = $3`, spaceID, actorID, clientID).Scan(&record.ID, &record.SpaceID, &record.ConversationID, &record.ActorUserID, &record.BotUserID, &record.CommandName, &record.CommandVersion, &record.ClientInvocationID, &record.RequestHash, &record.ArgumentsJSON, &record.Status, &record.ResultCardID, &record.ResultJSON, &record.ErrorCode, &record.CreatedAt, &record.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.CreatedAt = record.CreatedAt.UTC()
	return &record, nil
}

const workflowSelect = `SELECT id, space_id, conversation_id, actor_user_id, bot_user_id, workflow_type, workflow_version, state_json, status, revision, expires_at, created_at, updated_at, client_invocation_id, start_request_hash FROM workspace_workflow_sessions`

func scanWorkflow(row pgx.Row) (*WorkflowRecord, error) {
	var record WorkflowRecord
	err := row.Scan(&record.ID, &record.SpaceID, &record.ConversationID, &record.ActorUserID, &record.BotUserID, &record.WorkflowType, &record.WorkflowVersion, &record.StateJSON, &record.Status, &record.Revision, &record.ExpiresAt, &record.CreatedAt, &record.UpdatedAt, &record.ClientInvocationID, &record.StartRequestHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.ExpiresAt = record.ExpiresAt.UTC()
	record.CreatedAt = record.CreatedAt.UTC()
	record.UpdatedAt = record.UpdatedAt.UTC()
	return &record, nil
}
func (r *PGRepository) GetWorkflow(ctx context.Context, spaceID, workflowID string) (*WorkflowRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace interactions postgres pool is required")
	}
	return scanWorkflow(r.pool.QueryRow(ctx, workflowSelect+" WHERE space_id = $1 AND id = $2", spaceID, workflowID))
}
func (r *PGRepository) GetWorkflowByInvocation(ctx context.Context, spaceID, actorID, clientID string) (*WorkflowRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace interactions postgres pool is required")
	}
	return scanWorkflow(r.pool.QueryRow(ctx, workflowSelect+" WHERE space_id = $1 AND actor_user_id = $2 AND client_invocation_id = $3", spaceID, actorID, clientID))
}
func (r *PGRepository) ListActiveWorkflows(ctx context.Context, actorID, conversationID, botUserID string, limit int) ([]WorkflowRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace interactions postgres pool is required")
	}
	return listActiveWorkflows(ctx, r.pool, actorID, conversationID, botUserID, limit)
}
func listActiveWorkflows(ctx context.Context, queryer pgQueryer, actorID, conversationID, botUserID string, limit int) ([]WorkflowRecord, error) {
	if limit < 1 {
		limit = 1
	}
	rows, err := queryer.Query(ctx, workflowSelect+" WHERE actor_user_id = $1 AND conversation_id = $2 AND bot_user_id = $3 AND status = 'active' ORDER BY updated_at DESC, id DESC LIMIT $4", actorID, conversationID, botUserID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]WorkflowRecord, 0, limit)
	for rows.Next() {
		var record WorkflowRecord
		if err := rows.Scan(&record.ID, &record.SpaceID, &record.ConversationID, &record.ActorUserID, &record.BotUserID, &record.WorkflowType, &record.WorkflowVersion, &record.StateJSON, &record.Status, &record.Revision, &record.ExpiresAt, &record.CreatedAt, &record.UpdatedAt, &record.ClientInvocationID, &record.StartRequestHash); err != nil {
			return nil, err
		}
		record.ExpiresAt = record.ExpiresAt.UTC()
		record.CreatedAt = record.CreatedAt.UTC()
		record.UpdatedAt = record.UpdatedAt.UTC()
		result = append(result, record)
	}
	return result, rows.Err()
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID)
}
func (t *pgTx) GetConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	return getConversation(ctx, t.tx, spaceID, conversationID)
}
func (t *pgTx) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	return conversationMemberActive(ctx, t.tx, spaceID, conversationID, userID)
}
func (t *pgTx) BotMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	return botMemberActive(ctx, t.tx, spaceID, conversationID, userID)
}
func (t *pgTx) GetCommandRun(ctx context.Context, spaceID, actorID, clientID string) (*CommandRunRecord, error) {
	return getCommandRun(ctx, t.tx, spaceID, actorID, clientID)
}
func (t *pgTx) GetWorkflow(ctx context.Context, spaceID, workflowID string) (*WorkflowRecord, error) {
	return scanWorkflow(t.tx.QueryRow(ctx, workflowSelect+" WHERE space_id = $1 AND id = $2", spaceID, workflowID))
}
func (t *pgTx) GetWorkflowByInvocation(ctx context.Context, spaceID, actorID, clientID string) (*WorkflowRecord, error) {
	return scanWorkflow(t.tx.QueryRow(ctx, workflowSelect+" WHERE space_id = $1 AND actor_user_id = $2 AND client_invocation_id = $3", spaceID, actorID, clientID))
}
func (t *pgTx) ListActiveWorkflows(ctx context.Context, actorID, conversationID, botUserID string, limit int) ([]WorkflowRecord, error) {
	return listActiveWorkflows(ctx, t.tx, actorID, conversationID, botUserID, limit)
}
func (t *pgTx) Lock(ctx context.Context, key string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("interaction lock key is required")
	}
	_, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

func (t *pgTx) ConsumeRateLimit(ctx context.Context, input RateLimitInput) (bool, time.Duration, error) {
	result, err := t.tx.Exec(ctx, `INSERT INTO workspace_interaction_rate_limits (space_id, actor_user_id, bot_user_id, operation_key, window_started_at, attempt_count, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6) ON CONFLICT (space_id, actor_user_id, bot_user_id, operation_key, window_started_at) DO UPDATE SET attempt_count = workspace_interaction_rate_limits.attempt_count + 1, updated_at = EXCLUDED.updated_at WHERE workspace_interaction_rate_limits.attempt_count < $7`, input.SpaceID, input.ActorUserID, input.BotUserID, input.OperationKey, input.WindowStartedAt.UTC(), input.UpdatedAt.UTC(), input.Limit)
	if err != nil {
		return false, 0, err
	}
	if result.RowsAffected() == 1 {
		return true, 0, nil
	}
	retry := input.WindowStartedAt.Add(RateLimitWindow).Sub(input.UpdatedAt)
	if retry < time.Second {
		retry = time.Second
	}
	return false, retry, nil
}

func (t *pgTx) InsertCommandRun(ctx context.Context, input CommandRunRecord) (*CommandRunRecord, bool, error) {
	var record CommandRunRecord
	err := t.tx.QueryRow(ctx, `INSERT INTO workspace_command_runs (id, space_id, conversation_id, actor_user_id, bot_user_id, command_name, command_version, client_invocation_id, request_hash, arguments_json, status, result_card_id, result_json, error_code, created_at, completed_at) VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), $6, $7, $8, $9, $10, $11, NULL, NULL, NULL, $12, NULL) ON CONFLICT (space_id, actor_user_id, client_invocation_id) DO NOTHING RETURNING id, space_id, conversation_id, actor_user_id, bot_user_id, command_name, command_version, client_invocation_id, request_hash, arguments_json, status, result_card_id, COALESCE(result_json, ''), COALESCE(error_code, ''), created_at, completed_at`, input.ID, input.SpaceID, stringValue(input.ConversationID), input.ActorUserID, stringValue(input.BotUserID), input.CommandName, input.CommandVersion, input.ClientInvocationID, input.RequestHash, string(input.ArgumentsJSON), input.Status, input.CreatedAt.UTC()).Scan(&record.ID, &record.SpaceID, &record.ConversationID, &record.ActorUserID, &record.BotUserID, &record.CommandName, &record.CommandVersion, &record.ClientInvocationID, &record.RequestHash, &record.ArgumentsJSON, &record.Status, &record.ResultCardID, &record.ResultJSON, &record.ErrorCode, &record.CreatedAt, &record.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return &record, true, nil
}
func (t *pgTx) CompleteCommandRun(ctx context.Context, runID string, resultCardID *string, resultJSON []byte, at time.Time) error {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_command_runs SET status = 'succeeded', result_card_id = $1, result_json = $2, completed_at = $3 WHERE id = $4 AND status = 'pending'`, resultCardID, string(resultJSON), at.UTC(), runID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("command run is not pending")
	}
	return nil
}
func (t *pgTx) FailCommandRun(ctx context.Context, runID, errorCode string, at time.Time) error {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_command_runs SET status = 'failed', error_code = $1, completed_at = $2 WHERE id = $3 AND status = 'pending'`, errorCode, at.UTC(), runID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("command run is not pending")
	}
	return nil
}
func (t *pgTx) ExpireWorkflows(ctx context.Context, actorID, conversationID, botUserID string, at time.Time) error {
	_, err := t.tx.Exec(ctx, `UPDATE workspace_workflow_sessions SET status = 'expired', revision = revision + 1, updated_at = $1 WHERE actor_user_id = $2 AND conversation_id = $3 AND bot_user_id = $4 AND status = 'active' AND expires_at <= $1`, at.UTC(), actorID, conversationID, botUserID)
	return err
}
func (t *pgTx) InsertWorkflow(ctx context.Context, input WorkflowRecord) (*WorkflowRecord, bool, error) {
	record, err := scanWorkflow(t.tx.QueryRow(ctx, `INSERT INTO workspace_workflow_sessions (id, space_id, conversation_id, actor_user_id, bot_user_id, workflow_type, workflow_version, state_json, status, revision, expires_at, created_at, updated_at, client_invocation_id, start_request_hash) VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4, NULLIF($5, ''), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT DO NOTHING RETURNING id, space_id, conversation_id, actor_user_id, bot_user_id, workflow_type, workflow_version, state_json, status, revision, expires_at, created_at, updated_at, client_invocation_id, start_request_hash`, input.ID, input.SpaceID, stringValue(input.ConversationID), input.ActorUserID, stringValue(input.BotUserID), input.WorkflowType, input.WorkflowVersion, string(input.StateJSON), input.Status, input.Revision, input.ExpiresAt.UTC(), input.CreatedAt.UTC(), input.UpdatedAt.UTC(), stringValue(input.ClientInvocationID), stringValue(input.StartRequestHash)))
	if errors.Is(err, pgx.ErrNoRows) || record == nil {
		return nil, false, nil
	}
	return record, true, err
}
func (t *pgTx) UpdateWorkflow(ctx context.Context, workflowID string, expectedRevision int64, state any, status string, at time.Time) (*WorkflowRecord, bool, error) {
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, false, err
	}
	updated, err := scanWorkflow(t.tx.QueryRow(ctx, `UPDATE workspace_workflow_sessions SET state_json = $1, status = $2, revision = revision + 1, updated_at = $3 WHERE id = $4 AND status = 'active' AND revision = $5 RETURNING id, space_id, conversation_id, actor_user_id, bot_user_id, workflow_type, workflow_version, state_json, status, revision, expires_at, created_at, updated_at, client_invocation_id, start_request_hash`, string(encoded), status, at.UTC(), workflowID, expectedRevision))
	if errors.Is(err, pgx.ErrNoRows) || updated == nil {
		return nil, false, nil
	}
	return updated, true, err
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if input.ID == "" {
		id, err := t.newID("interaction audit")
		if err != nil {
			return err
		}
		input.ID = id
	}
	meta := (auth.RequestMeta{RequestID: input.RequestID, IPAddress: input.IPAddress, UserAgent: input.UserAgent}).Safe()
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, ip_address, user_agent, request_id, created_at) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, input.Result, input.Reason, meta.IPAddress, meta.UserAgent, meta.RequestID, input.CreatedAt.UTC())
	return err
}
func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) (EventRecord, error) {
	if input.ID == "" {
		id, err := t.newID("interaction event")
		if err != nil {
			return EventRecord{}, err
		}
		input.ID = id
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return EventRecord{}, errors.New("interaction event payload is not valid JSON")
	}
	var next int64
	if err := t.tx.QueryRow(ctx, `INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES ($1, 2) ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1 RETURNING next_seq`, input.SpaceID).Scan(&next); err != nil {
		return EventRecord{}, err
	}
	seq := next - 1
	_, err := t.tx.Exec(ctx, `INSERT INTO workspace_events (id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)`, input.ID, input.SpaceID, seq, input.Type, input.ActorID, input.ConversationID, input.TargetType, input.TargetID, string(input.PayloadJSON), input.CreatedAt.UTC())
	if err != nil {
		return EventRecord{}, err
	}
	return EventRecord{ID: input.ID, SpaceID: input.SpaceID, Seq: seq}, nil
}
func (t *pgTx) newID(operation string) (string, error) {
	if t == nil || t.repository == nil || t.repository.idFactory == nil {
		return "", errors.New(operation + " id factory is required")
	}
	id, err := t.repository.idFactory()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(id) == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return strings.TrimSpace(id), nil
}
