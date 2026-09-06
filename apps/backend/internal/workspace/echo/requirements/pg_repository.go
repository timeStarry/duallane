package requirements

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

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
	idFactory IDFactory
}

func NewPGRepository(pool *pgxpool.Pool, factories ...IDFactory) *PGRepository {
	idFactory := defaultIDFactory
	if len(factories) > 0 && factories[0] != nil {
		idFactory = factories[0]
	}
	return &PGRepository{pool: pool, idFactory: idFactory}
}

func defaultIDFactory() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

// NewPGTransaction wraps an already-open PostgreSQL transaction with the
// requirement domain's typed Tx surface. The caller owns commit/rollback.
func NewPGTransaction(tx pgx.Tx) Tx {
	if tx == nil {
		return nil
	}
	return &pgTx{tx: tx, repository: NewPGRepository(nil)}
}

// NewTransaction reuses this repository's configured ID factory while
// wrapping an already-open transaction. It never starts or commits a pool
// transaction.
func (r *PGRepository) NewTransaction(tx pgx.Tx) Tx {
	if r == nil || tx == nil {
		return nil
	}
	return &pgTx{tx: tx, repository: r}
}

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace echo requirements postgres pool is required")
	}
	return r.pool.Ping(ctx)
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace echo requirements postgres pool is required")
	}
	if callback == nil {
		return errors.New("echo requirement transaction callback is required")
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
		return nil, errors.New("workspace echo requirements postgres pool is required")
	}
	return lookupActor(ctx, r.pool, spaceID, userID, false)
}

func lookupActor(ctx context.Context, queryer pgQueryer, spaceID, userID string, lock bool) (*auth.Actor, error) {
	lockClause := ""
	if lock {
		// Pin authorization through commit, including while a domain lock waits.
		lockClause = " FOR SHARE OF sm, u"
	}
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	err := queryer.QueryRow(ctx, `
		SELECT u.id, u.github_id, u.github_login, u.email, u.display_name,
			u.nickname, u.avatar_url, u.search_discoverable, u.kind,
			sm.role, sm.joined_at
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`+lockClause, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName, &nickname, &avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &actor.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	actor.GitHubID = stringValue(githubID)
	actor.Email = stringValue(email)
	actor.Nickname = stringValue(nickname)
	actor.AvatarURL = stringValue(avatarURL)
	actor.JoinedAt = actor.JoinedAt.UTC()
	return &actor, nil
}

const requirementSelect = `
	SELECT r.id, r.public_id, r.space_id, r.submitter_user_id,
		u.display_name, u.github_login, r.type, r.title, r.detail, r.scenario,
		r.expected_result, r.related_link, r.state, r.phase, r.status,
		r.archive_outcome, r.duplicate_of_public_id, r.revision, r.response,
		r.created_at, r.updated_at
	FROM echo_requirements r
	INNER JOIN users u ON u.id = r.submitter_user_id
`

func scanRequirement(row pgx.Row) (*RequirementRecord, error) {
	var record RequirementRecord
	if err := row.Scan(&record.ID, &record.PublicID, &record.SpaceID, &record.SubmitterUserID, &record.SubmitterDisplayName, &record.SubmitterGithubLogin, &record.Type, &record.Title, &record.Detail, &record.Scenario, &record.ExpectedResult, &record.RelatedLink, &record.State, &record.Phase, &record.Status, &record.ArchiveOutcome, &record.DuplicateOfPublicID, &record.Revision, &record.Response, &record.CreatedAt, &record.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	record.CreatedAt = record.CreatedAt.UTC()
	record.UpdatedAt = record.UpdatedAt.UTC()
	return &record, nil
}

func (r *PGRepository) GetRequirementByPublicID(ctx context.Context, spaceID, publicID string) (*RequirementRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo requirements postgres pool is required")
	}
	return getRequirementByPublicID(ctx, r.pool, spaceID, publicID)
}

func getRequirementByPublicID(ctx context.Context, queryer pgQueryer, spaceID, publicID string) (*RequirementRecord, error) {
	return scanRequirement(queryer.QueryRow(ctx, requirementSelect+` WHERE r.space_id = $1 AND r.public_id = $2`, spaceID, publicID))
}

func (r *PGRepository) GetRequirementByID(ctx context.Context, spaceID, id string) (*RequirementRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo requirements postgres pool is required")
	}
	return getRequirementByID(ctx, r.pool, spaceID, id)
}

func getRequirementByID(ctx context.Context, queryer pgQueryer, spaceID, id string) (*RequirementRecord, error) {
	return scanRequirement(queryer.QueryRow(ctx, requirementSelect+` WHERE r.space_id = $1 AND r.id = $2`, spaceID, id))
}

func (r *PGRepository) ListRequirements(ctx context.Context, query RequirementListQuery) (RequirementPageRecord, error) {
	if r == nil || r.pool == nil {
		return RequirementPageRecord{Items: []RequirementRecord{}}, errors.New("workspace echo requirements postgres pool is required")
	}
	return listRequirements(ctx, r.pool, query)
}

func listRequirements(ctx context.Context, queryer pgQueryer, query RequirementListQuery) (RequirementPageRecord, error) {
	where, args := requirementFilters(query)
	rows, err := queryer.Query(ctx, requirementSelect+" WHERE "+where+" ORDER BY r.created_at DESC, r.id DESC LIMIT $"+itoa(len(args)+1)+" OFFSET $"+itoa(len(args)+2), append(args, query.Limit, query.Offset)...)
	if err != nil {
		return RequirementPageRecord{Items: []RequirementRecord{}}, err
	}
	defer rows.Close()
	items := make([]RequirementRecord, 0)
	for rows.Next() {
		var record RequirementRecord
		if err := rows.Scan(&record.ID, &record.PublicID, &record.SpaceID, &record.SubmitterUserID, &record.SubmitterDisplayName, &record.SubmitterGithubLogin, &record.Type, &record.Title, &record.Detail, &record.Scenario, &record.ExpectedResult, &record.RelatedLink, &record.State, &record.Phase, &record.Status, &record.ArchiveOutcome, &record.DuplicateOfPublicID, &record.Revision, &record.Response, &record.CreatedAt, &record.UpdatedAt); err != nil {
			return RequirementPageRecord{Items: []RequirementRecord{}}, err
		}
		record.CreatedAt = record.CreatedAt.UTC()
		record.UpdatedAt = record.UpdatedAt.UTC()
		items = append(items, record)
	}
	if err := rows.Err(); err != nil {
		return RequirementPageRecord{Items: []RequirementRecord{}}, err
	}
	var total int64
	if err := queryer.QueryRow(ctx, "SELECT COUNT(*) FROM echo_requirements r WHERE "+where, args...).Scan(&total); err != nil {
		return RequirementPageRecord{Items: []RequirementRecord{}}, err
	}
	return RequirementPageRecord{Items: items, Total: total}, nil
}

func requirementFilters(query RequirementListQuery) (string, []any) {
	conditions := []string{"r.space_id = $1"}
	args := []any{query.SpaceID}
	add := func(condition string, value any) {
		args = append(args, value)
		conditions = append(conditions, strings.Replace(condition, "?", "$"+itoa(len(args)), 1))
	}
	if query.State != nil {
		add("r.state = ?", *query.State)
	}
	if query.Phase != nil {
		add("r.phase = ?", *query.Phase)
	}
	if query.Status != nil {
		add("r.status = ?", *query.Status)
	}
	if query.ArchiveOutcome != nil {
		add("r.archive_outcome = ?", *query.ArchiveOutcome)
	}
	if query.Type != nil {
		add("r.type = ?", *query.Type)
	}
	if query.SubmitterUserID != nil {
		add("r.submitter_user_id = ?", *query.SubmitterUserID)
	}
	if query.CreatedFrom != nil {
		add("r.created_at >= ?", query.CreatedFrom.UTC())
	}
	if query.CreatedTo != nil {
		add("r.created_at <= ?", query.CreatedTo.UTC())
	}
	if !query.Owner {
		add("r.submitter_user_id = ?", query.ActorID)
	}
	return strings.Join(conditions, " AND "), args
}

func (r *PGRepository) RequirementStats(ctx context.Context, spaceID, actorID string, owner bool) ([]RequirementStatsRow, error) {
	if r == nil || r.pool == nil {
		return []RequirementStatsRow{}, errors.New("workspace echo requirements postgres pool is required")
	}
	return requirementStats(ctx, r.pool, spaceID, actorID, owner)
}

func requirementStats(ctx context.Context, queryer pgQueryer, spaceID, actorID string, owner bool) ([]RequirementStatsRow, error) {
	rows, err := queryer.Query(ctx, `SELECT r.phase, r.status, COUNT(*) FROM echo_requirements r WHERE r.space_id = $1 AND ($2 OR r.submitter_user_id = $3) GROUP BY r.phase, r.status ORDER BY r.phase ASC, r.status ASC`, spaceID, owner, actorID)
	if err != nil {
		return []RequirementStatsRow{}, err
	}
	defer rows.Close()
	result := make([]RequirementStatsRow, 0)
	for rows.Next() {
		var row RequirementStatsRow
		if err := rows.Scan(&row.Phase, &row.Status, &row.Count); err != nil {
			return []RequirementStatsRow{}, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (r *PGRepository) ListRequirementHistory(ctx context.Context, spaceID, requirementID string) ([]RequirementHistoryRecord, error) {
	if r == nil || r.pool == nil {
		return []RequirementHistoryRecord{}, errors.New("workspace echo requirements postgres pool is required")
	}
	return listRequirementHistory(ctx, r.pool, spaceID, requirementID)
}

func listRequirementHistory(ctx context.Context, queryer pgQueryer, spaceID, requirementID string) ([]RequirementHistoryRecord, error) {
	rows, err := queryer.Query(ctx, `
		SELECT h.id, h.requirement_id, h.from_state, h.to_state, h.from_phase,
			h.from_status, h.to_phase, h.to_status, h.response, h.actor_user_id,
			h.revision, h.idempotency_key, h.created_at
		FROM echo_requirement_status_history h
		INNER JOIN echo_requirements r ON r.id = h.requirement_id AND r.space_id = $1
		WHERE h.requirement_id = $2 ORDER BY h.revision ASC
	`, spaceID, requirementID)
	if err != nil {
		return []RequirementHistoryRecord{}, err
	}
	defer rows.Close()
	result := make([]RequirementHistoryRecord, 0)
	for rows.Next() {
		var row RequirementHistoryRecord
		if err := rows.Scan(&row.ID, &row.RequirementID, &row.FromState, &row.ToState, &row.FromPhase, &row.FromStatus, &row.ToPhase, &row.ToStatus, &row.Response, &row.ActorUserID, &row.Revision, &row.IdempotencyKey, &row.CreatedAt); err != nil {
			return []RequirementHistoryRecord{}, err
		}
		row.CreatedAt = row.CreatedAt.UTC()
		result = append(result, row)
	}
	return result, rows.Err()
}

func (r *PGRepository) GetIdempotency(ctx context.Context, spaceID, actorID, operation, key string) (*IdempotencyRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo requirements postgres pool is required")
	}
	return getIdempotency(ctx, r.pool, spaceID, actorID, operation, key)
}

func getIdempotency(ctx context.Context, queryer pgQueryer, spaceID, actorID, operation, key string) (*IdempotencyRecord, error) {
	var record IdempotencyRecord
	if err := queryer.QueryRow(ctx, `SELECT space_id, actor_user_id, operation, idempotency_key, request_hash, requirement_id, resulting_state, resulting_revision, result_json, created_at FROM echo_requirement_idempotency WHERE space_id = $1 AND actor_user_id = $2 AND operation = $3 AND idempotency_key = $4`, spaceID, actorID, operation, key).Scan(&record.SpaceID, &record.ActorUserID, &record.Operation, &record.Key, &record.RequestHash, &record.RequirementID, &record.ResultingState, &record.ResultingRevision, &record.ResultJSON, &record.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	record.CreatedAt = record.CreatedAt.UTC()
	return &record, nil
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID, true)
}
func (t *pgTx) GetRequirementByPublicID(ctx context.Context, spaceID, publicID string) (*RequirementRecord, error) {
	return getRequirementByPublicID(ctx, t.tx, spaceID, publicID)
}
func (t *pgTx) GetRequirementByID(ctx context.Context, spaceID, id string) (*RequirementRecord, error) {
	return getRequirementByID(ctx, t.tx, spaceID, id)
}
func (t *pgTx) ListRequirements(ctx context.Context, query RequirementListQuery) (RequirementPageRecord, error) {
	return listRequirements(ctx, t.tx, query)
}
func (t *pgTx) RequirementStats(ctx context.Context, spaceID, actorID string, owner bool) ([]RequirementStatsRow, error) {
	return requirementStats(ctx, t.tx, spaceID, actorID, owner)
}
func (t *pgTx) ListRequirementHistory(ctx context.Context, spaceID, requirementID string) ([]RequirementHistoryRecord, error) {
	return listRequirementHistory(ctx, t.tx, spaceID, requirementID)
}
func (t *pgTx) GetIdempotency(ctx context.Context, spaceID, actorID, operation, key string) (*IdempotencyRecord, error) {
	return getIdempotency(ctx, t.tx, spaceID, actorID, operation, key)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	_, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, key)
	return err
}

func (t *pgTx) AllocateSequence(ctx context.Context, spaceID string, year int) (int, error) {
	if _, err := t.tx.Exec(ctx, `INSERT INTO echo_requirement_sequences (space_id, sequence_year, next_number) VALUES ($1, $2, 1) ON CONFLICT (space_id, sequence_year) DO NOTHING`, spaceID, year); err != nil {
		return 0, err
	}
	var number int
	if err := t.tx.QueryRow(ctx, `SELECT next_number FROM echo_requirement_sequences WHERE space_id = $1 AND sequence_year = $2 FOR UPDATE`, spaceID, year).Scan(&number); err != nil {
		return 0, err
	}
	if number < 1 || number > MaxSequenceNumber {
		return 0, conflictError(CodeSequenceExhausted, MessageSequenceExhausted)
	}
	if _, err := t.tx.Exec(ctx, `UPDATE echo_requirement_sequences SET next_number = $1 WHERE space_id = $2 AND sequence_year = $3 AND next_number = $4`, number+1, spaceID, year, number); err != nil {
		return 0, err
	}
	return number, nil
}

func (t *pgTx) InsertRequirement(ctx context.Context, record RequirementRecord) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO echo_requirements (id, public_id, space_id, submitter_user_id, type, title, detail, scenario, expected_result, related_link, state, phase, status, archive_outcome, duplicate_of_public_id, revision, response, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`, record.ID, record.PublicID, record.SpaceID, record.SubmitterUserID, record.Type, record.Title, record.Detail, record.Scenario, record.ExpectedResult, record.RelatedLink, record.State, record.Phase, record.Status, record.ArchiveOutcome, record.DuplicateOfPublicID, record.Revision, record.Response, record.CreatedAt.UTC(), record.UpdatedAt.UTC())
	return err
}

func (t *pgTx) InsertHistory(ctx context.Context, record RequirementHistoryRecord) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO echo_requirement_status_history (id, requirement_id, from_state, to_state, from_phase, from_status, to_phase, to_status, response, actor_user_id, revision, idempotency_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, record.ID, record.RequirementID, record.FromState, record.ToState, record.FromPhase, record.FromStatus, record.ToPhase, record.ToStatus, record.Response, record.ActorUserID, record.Revision, record.IdempotencyKey, record.CreatedAt.UTC())
	return err
}

func (t *pgTx) InsertIdempotency(ctx context.Context, record IdempotencyRecord) (bool, error) {
	result, err := t.tx.Exec(ctx, `INSERT INTO echo_requirement_idempotency (space_id, actor_user_id, operation, idempotency_key, request_hash, requirement_id, resulting_state, resulting_revision, result_json, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (space_id, actor_user_id, operation, idempotency_key) DO NOTHING`, record.SpaceID, record.ActorUserID, record.Operation, record.Key, record.RequestHash, record.RequirementID, record.ResultingState, record.ResultingRevision, nullableJSON(record.ResultJSON), record.CreatedAt.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) UpdateIdempotencyResult(ctx context.Context, spaceID, actorID, operation, key string, resultJSON []byte) error {
	_, err := t.tx.Exec(ctx, `UPDATE echo_requirement_idempotency SET result_json = $1 WHERE space_id = $2 AND actor_user_id = $3 AND operation = $4 AND idempotency_key = $5`, string(resultJSON), spaceID, actorID, operation, key)
	return err
}

func (t *pgTx) UpdateRequirementCAS(ctx context.Context, id string, expectedRevision int64, record RequirementRecord) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE echo_requirements SET state = $1, phase = $2, status = $3, archive_outcome = $4, duplicate_of_public_id = $5, revision = $6, response = $7, updated_at = $8 WHERE id = $9 AND revision = $10`, record.State, record.Phase, record.Status, record.ArchiveOutcome, record.DuplicateOfPublicID, record.Revision, record.Response, record.UpdatedAt.UTC(), id, expectedRevision)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID("echo requirement audit")
		if err != nil {
			return err
		}
		input.ID = id
	}
	meta := input.Meta.Safe()
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, ip_address, user_agent, request_id, created_at) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, input.Result, input.Reason, meta.IPAddress, meta.UserAgent, meta.RequestID, input.CreatedAt.UTC())
	return err
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) (EventRecord, error) {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID("echo requirement event")
		if err != nil {
			return EventRecord{}, err
		}
		input.ID = id
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return EventRecord{}, errors.New("echo requirement event payload is not valid JSON")
	}
	var next int64
	if err := t.tx.QueryRow(ctx, `INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES ($1, 2) ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1 RETURNING next_seq`, input.SpaceID).Scan(&next); err != nil {
		return EventRecord{}, err
	}
	seq := next - 1
	if _, err := t.tx.Exec(ctx, `INSERT INTO workspace_events (id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULL, NULLIF($6, ''), NULLIF($7, ''), $8, $9)`, input.ID, input.SpaceID, seq, input.Type, input.ActorID, input.TargetType, input.TargetID, string(input.PayloadJSON), input.CreatedAt.UTC()); err != nil {
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
	return id, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableJSON(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return string(value)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [24]byte
	position := len(digits)
	for value > 0 {
		position--
		digits[position] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[position:])
}
