package cards

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

// PGRepository is the cards-owned PostgreSQL adapter. It intentionally
// exposes only the repository methods required by the application service.
type PGRepository struct {
	pool      *pgxpool.Pool
	idFactory func() (string, error)
}

func NewPGRepository(pool *pgxpool.Pool, factories ...func() (string, error)) *PGRepository {
	idFactory := func() (string, error) {
		id, err := uuid.NewRandom()
		if err != nil {
			return "", err
		}
		return id.String(), nil
	}
	if len(factories) > 0 && factories[0] != nil {
		idFactory = factories[0]
	}
	return &PGRepository{pool: pool, idFactory: idFactory}
}

// NewPGTransaction wraps an already-open PostgreSQL transaction with the
// cards domain's typed Tx surface. The caller owns commit/rollback; this
// helper never starts a second pool transaction.
func NewPGTransaction(tx pgx.Tx) Tx {
	if tx == nil {
		return nil
	}
	return &pgTx{tx: tx, repository: NewPGRepository(nil)}
}

// NewTransaction reuses this repository's configured ID factory while
// wrapping an already-open transaction. The caller owns commit/rollback.
func (r *PGRepository) NewTransaction(tx pgx.Tx) Tx {
	if r == nil || tx == nil {
		return nil
	}
	return &pgTx{tx: tx, repository: r}
}

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace cards postgres pool is required")
	}
	return r.pool.Ping(ctx)
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace cards postgres pool is required")
	}
	if callback == nil {
		return errors.New("workspace cards transaction callback is required")
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
		return nil, errors.New("workspace cards postgres pool is required")
	}
	return lookupActor(ctx, r.pool, spaceID, userID, false)
}

func lookupActor(ctx context.Context, queryer pgQueryer, spaceID, userID string, pin bool) (*auth.Actor, error) {
	var actor auth.Actor
	query := `
		SELECT u.id, u.github_login, u.kind, sm.role, sm.joined_at
		FROM users u
		JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`
	if pin {
		query += " FOR SHARE OF u, sm"
	}
	err := queryer.QueryRow(ctx, query, userID, spaceID).Scan(&actor.ID, &actor.GitHubLogin, &actor.Kind, &actor.Role, &actor.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	actor.JoinedAt = actor.JoinedAt.UTC()
	return &actor, nil
}

func (r *PGRepository) SpaceExists(ctx context.Context, spaceID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace cards postgres pool is required")
	}
	return spaceExists(ctx, r.pool, spaceID)
}

func spaceExists(ctx context.Context, queryer pgQueryer, spaceID string) (bool, error) {
	var present bool
	err := queryer.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM spaces WHERE id = $1)`, spaceID).Scan(&present)
	return present, err
}

func (r *PGRepository) GetConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace cards postgres pool is required")
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
		return false, errors.New("workspace cards postgres pool is required")
	}
	return conversationMemberActive(ctx, r.pool, spaceID, conversationID, userID, false)
}

func conversationMemberActive(ctx context.Context, queryer pgQueryer, spaceID, conversationID, userID string, pin bool) (bool, error) {
	var present bool
	query := `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members cm
			JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
			WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
	`
	if pin {
		query += " FOR SHARE OF cm, c"
	}
	query += ")"
	err := queryer.QueryRow(ctx, query, spaceID, conversationID, userID).Scan(&present)
	return present, err
}

func (r *PGRepository) GetCard(ctx context.Context, spaceID, cardID string) (*CardRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace cards postgres pool is required")
	}
	return getCard(ctx, r.pool, spaceID, cardID)
}

func getCard(ctx context.Context, queryer pgQueryer, spaceID, cardID string) (*CardRecord, error) {
	return scanCard(queryer.QueryRow(ctx, cardSelect+" WHERE space_id = $1 AND id = $2", spaceID, cardID))
}

func (r *PGRepository) GetCardBySource(ctx context.Context, spaceID string, sourceKind SourceKind, sourceID, cardType string) (*CardRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace cards postgres pool is required")
	}
	return getCardBySource(ctx, r.pool, spaceID, sourceKind, sourceID, cardType)
}

func getCardBySource(ctx context.Context, queryer pgQueryer, spaceID string, sourceKind SourceKind, sourceID, cardType string) (*CardRecord, error) {
	return scanCard(queryer.QueryRow(ctx, cardSelect+" WHERE space_id = $1 AND source_kind = $2 AND source_id = $3 AND card_type = $4", spaceID, sourceKind, sourceID, cardType))
}

func (r *PGRepository) GetActionRun(ctx context.Context, cardID, actorID, clientActionID string) (*ActionRunRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace cards postgres pool is required")
	}
	return getActionRun(ctx, r.pool, cardID, actorID, clientActionID)
}

func getActionRun(ctx context.Context, queryer pgQueryer, cardID, actorID, clientActionID string) (*ActionRunRecord, error) {
	var record ActionRunRecord
	err := queryer.QueryRow(ctx, `
		SELECT id, card_id, actor_user_id, action_id, client_action_id, request_hash,
		       expected_revision, status, COALESCE(result_json, ''), COALESCE(error_code, ''),
		       resulting_revision, created_at, completed_at
		FROM workspace_card_action_runs
		WHERE card_id = $1 AND actor_user_id = $2 AND client_action_id = $3
	`, cardID, actorID, clientActionID).Scan(&record.ID, &record.CardID, &record.ActorUserID, &record.ActionID, &record.ClientActionID, &record.RequestHash, &record.ExpectedRevision, &record.Status, &record.ResultJSON, &record.ErrorCode, &record.ResultingRevision, &record.CreatedAt, &record.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

const cardSelect = `SELECT id, space_id, conversation_id, card_type, schema_version, payload_json,
 fallback_text, source_kind, source_id, resource_type, resource_id, visibility_scope,
 created_by_user_id, status, revision, expires_at, created_at, updated_at FROM workspace_cards`

func scanCard(row pgx.Row) (*CardRecord, error) {
	var record CardRecord
	err := row.Scan(&record.ID, &record.SpaceID, &record.ConversationID, &record.CardType, &record.SchemaVersion, &record.PayloadJSON,
		&record.FallbackText, &record.SourceKind, &record.SourceID, &record.ResourceType, &record.ResourceID, &record.VisibilityScope,
		&record.CreatedByUserID, &record.Status, &record.Revision, &record.ExpiresAt, &record.CreatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.CreatedAt = record.CreatedAt.UTC()
	record.UpdatedAt = record.UpdatedAt.UTC()
	if record.ExpiresAt != nil {
		value := record.ExpiresAt.UTC()
		record.ExpiresAt = &value
	}
	return &record, nil
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID, true)
}
func (t *pgTx) SpaceExists(ctx context.Context, spaceID string) (bool, error) {
	return spaceExists(ctx, t.tx, spaceID)
}
func (t *pgTx) GetConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	return getConversation(ctx, t.tx, spaceID, conversationID)
}
func (t *pgTx) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	return conversationMemberActive(ctx, t.tx, spaceID, conversationID, userID, true)
}
func (t *pgTx) GetCard(ctx context.Context, spaceID, cardID string) (*CardRecord, error) {
	return scanCard(t.tx.QueryRow(ctx, cardSelect+" WHERE space_id = $1 AND id = $2", spaceID, cardID))
}
func (t *pgTx) GetCardBySource(ctx context.Context, spaceID string, sourceKind SourceKind, sourceID, cardType string) (*CardRecord, error) {
	return scanCard(t.tx.QueryRow(ctx, cardSelect+" WHERE space_id = $1 AND source_kind = $2 AND source_id = $3 AND card_type = $4", spaceID, sourceKind, sourceID, cardType))
}
func (t *pgTx) GetActionRun(ctx context.Context, cardID, actorID, clientActionID string) (*ActionRunRecord, error) {
	return getActionRun(ctx, t.tx, cardID, actorID, clientActionID)
}
func (t *pgTx) CustomBotActive(ctx context.Context, spaceID, botID, botUserID string) (bool, error) {
	return customBotActive(ctx, t.tx, spaceID, botID, botUserID, true)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("card lock key is required")
	}
	_, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

// WithActionSavepoint runs an action's domain effects inside a savepoint on
// the caller-owned transaction. The action service deliberately creates the
// action run before entering this boundary, so a controlled action rejection
// can roll back domain/card effects while still recording the failed run and
// content-free rejection audit in the outer transaction.
func (t *pgTx) WithActionSavepoint(ctx context.Context, name string, callback func(context.Context) error) error {
	if t == nil || t.tx == nil {
		return errors.New("card action transaction is required")
	}
	if callback == nil {
		return errors.New("card action savepoint callback is required")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("card action savepoint name is required")
	}
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err := t.tx.Exec(ctx, "SAVEPOINT "+identifier); err != nil {
		return &actionSavepointFailure{err: err}
	}

	callbackErr := callback(ctx)
	if callbackErr != nil {
		rollbackErr := func() error {
			_, err := t.tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+identifier)
			return err
		}()
		releaseErr := func() error {
			_, err := t.tx.Exec(ctx, "RELEASE SAVEPOINT "+identifier)
			return err
		}()
		if rollbackErr != nil || releaseErr != nil {
			return &actionSavepointFailure{err: errors.Join(callbackErr, rollbackErr, releaseErr)}
		}
		return callbackErr
	}
	_, err := t.tx.Exec(ctx, "RELEASE SAVEPOINT "+identifier)
	if err != nil {
		return &actionSavepointFailure{err: err}
	}
	return nil
}

func (t *pgTx) InsertCard(ctx context.Context, input CardInsert) (*CardRecord, bool, error) {
	record := input.CardRecord
	row := t.tx.QueryRow(ctx, `
		INSERT INTO workspace_cards (
			id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text,
			source_kind, source_id, resource_type, resource_id, visibility_scope,
			created_by_user_id, status, revision, expires_at, created_at, updated_at
		) VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), $12, NULLIF($13, ''), $14, $15, $16, $17, $17)
		ON CONFLICT DO NOTHING
		RETURNING id, space_id, conversation_id, card_type, schema_version, payload_json,
		 fallback_text, source_kind, source_id, resource_type, resource_id, visibility_scope,
		 created_by_user_id, status, revision, expires_at, created_at, updated_at
	`, record.ID, record.SpaceID, stringPointerValue(record.ConversationID), record.CardType, record.SchemaVersion, string(record.PayloadJSON), record.FallbackText,
		record.SourceKind, stringPointerValue(record.SourceID), stringPointerValue(record.ResourceType), stringPointerValue(record.ResourceID), record.VisibilityScope,
		stringPointerValue(record.CreatedByUserID), record.Status, record.Revision, record.ExpiresAt, record.CreatedAt.UTC())
	inserted, err := scanCard(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return inserted, true, nil
}

func (t *pgTx) UpdateCard(ctx context.Context, cardID string, expectedRevision int64, payload any, status CardStatus, fallbackText string, at time.Time) (*CardRecord, bool, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, false, err
	}
	updated, err := scanCard(t.tx.QueryRow(ctx, `
		UPDATE workspace_cards
		SET payload_json = $1, status = $2, fallback_text = $3, revision = revision + 1, updated_at = $4
		WHERE id = $5 AND revision = $6
		RETURNING id, space_id, conversation_id, card_type, schema_version, payload_json,
		 fallback_text, source_kind, source_id, resource_type, resource_id, visibility_scope,
		 created_by_user_id, status, revision, expires_at, created_at, updated_at
	`, string(encoded), status, fallbackText, at.UTC(), cardID, expectedRevision))
	if errors.Is(err, pgx.ErrNoRows) || updated == nil {
		return nil, false, nil
	}
	return updated, true, err
}

func (t *pgTx) InsertActionRun(ctx context.Context, input ActionRunRecord) (*ActionRunRecord, bool, error) {
	var record ActionRunRecord
	err := t.tx.QueryRow(ctx, `
		INSERT INTO workspace_card_action_runs (
			id, card_id, actor_user_id, action_id, client_action_id, request_hash,
			expected_revision, status, result_json, error_code, resulting_revision, created_at, completed_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, NULL, $9, NULL)
		ON CONFLICT (card_id, actor_user_id, client_action_id) DO NOTHING
		RETURNING id, card_id, actor_user_id, action_id, client_action_id, request_hash,
		 expected_revision, status, COALESCE(result_json, ''), COALESCE(error_code, ''), resulting_revision, created_at, completed_at
	`, input.ID, input.CardID, input.ActorUserID, input.ActionID, input.ClientActionID, input.RequestHash, input.ExpectedRevision, input.Status, input.CreatedAt.UTC()).Scan(
		&record.ID, &record.CardID, &record.ActorUserID, &record.ActionID, &record.ClientActionID, &record.RequestHash, &record.ExpectedRevision, &record.Status, &record.ResultJSON, &record.ErrorCode, &record.ResultingRevision, &record.CreatedAt, &record.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return &record, true, nil
}

func (t *pgTx) CompleteActionRun(ctx context.Context, runID, status string, resultJSON []byte, resultingRevision *int64, at time.Time) error {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_card_action_runs SET status = $1, result_json = $2, resulting_revision = $3, completed_at = $4 WHERE id = $5 AND status = 'pending'`, status, string(resultJSON), resultingRevision, at.UTC(), runID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("card action run is not pending")
	}
	return nil
}

func (t *pgTx) FailActionRun(ctx context.Context, runID, errorCode string, at time.Time) error {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_card_action_runs SET status = 'failed', error_code = $1, completed_at = $2 WHERE id = $3 AND status = 'pending'`, errorCode, at.UTC(), runID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("card action run is not pending")
	}
	return nil
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) (EventRecord, error) {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID("card event")
		if err != nil {
			return EventRecord{}, err
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Type) == "" || input.CreatedAt.IsZero() {
		return EventRecord{}, errors.New("card event fields are required")
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return EventRecord{}, errors.New("card event payload is not valid JSON")
	}
	var next int64
	if err := t.tx.QueryRow(ctx, `INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES ($1, 2) ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1 RETURNING next_seq`, input.SpaceID).Scan(&next); err != nil {
		return EventRecord{}, err
	}
	seq := next - 1
	if _, err := t.tx.Exec(ctx, `INSERT INTO workspace_events (id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)`, input.ID, input.SpaceID, seq, input.Type, input.ActorID, input.ConversationID, input.TargetType, input.TargetID, string(input.PayloadJSON), input.CreatedAt.UTC()); err != nil {
		return EventRecord{}, err
	}
	return EventRecord{ID: input.ID, SpaceID: input.SpaceID, Seq: seq}, nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID("card audit")
		if err != nil {
			return err
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" || strings.TrimSpace(input.Result) == "" || input.CreatedAt.IsZero() {
		return errors.New("card audit fields are required")
	}
	meta := (auth.RequestMeta{RequestID: input.RequestID, IPAddress: input.IPAddress, UserAgent: input.UserAgent}).Safe()
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, ip_address, user_agent, request_id, created_at) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, input.Result, input.Reason, meta.IPAddress, meta.UserAgent, meta.RequestID, input.CreatedAt.UTC())
	return err
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

func (r *PGRepository) CustomBotActive(ctx context.Context, spaceID, botID, botUserID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace cards postgres pool is required")
	}
	return customBotActive(ctx, r.pool, spaceID, botID, botUserID, false)
}

func customBotActive(ctx context.Context, queryer pgQueryer, spaceID, botID, botUserID string, pin bool) (bool, error) {
	var active bool
	query := `SELECT EXISTS (SELECT 1 FROM workspace_agent_bots WHERE id = $1 AND space_id = $2 AND bot_user_id = $3 AND status = 'active'`
	args := []any{botID, spaceID, botUserID}
	if strings.TrimSpace(botID) == "" {
		query = `SELECT EXISTS (SELECT 1 FROM workspace_agent_bots WHERE space_id = $1 AND bot_user_id = $2 AND status = 'active'`
		args = []any{spaceID, botUserID}
	}
	if pin {
		query += " FOR SHARE"
	}
	query += ")"
	err := queryer.QueryRow(ctx, query, args...).Scan(&active)
	return active, err
}

func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
