package solicitations

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

// PGRepository is the solicitation-owned PostgreSQL adapter. Conversation
// authorization is deliberately not queried here; callers inject the
// existing conversation access seam into ServiceOptions.
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
// solicitation domain's typed Tx surface. The caller owns commit/rollback;
// this helper never starts a second pool transaction.
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
		return errors.New("workspace echo solicitations postgres pool is required")
	}
	return r.pool.Ping(ctx)
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace echo solicitations postgres pool is required")
	}
	if callback == nil {
		return errors.New("echo solicitation transaction callback is required")
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
		return nil, errors.New("workspace echo solicitations postgres pool is required")
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
	`+lockClause, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName,
		&nickname, &avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &actor.JoinedAt)
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

const solicitationSelect = `
	SELECT s.id, s.public_id, s.space_id, s.owner_user_id, s.title,
		s.description, s.question, s.choice_mode, s.min_selections,
		s.max_selections, s.allow_vote_change, s.result_visibility,
		s.delivery_policy, s.status, s.deadline, s.revision,
		s.idempotency_key, s.created_at, s.updated_at, s.published_at,
		s.closed_at, s.withdrawn_at
	FROM echo_solicitations s
`

func scanSolicitation(row pgx.Row) (*SolicitationRecord, error) {
	var record SolicitationRecord
	err := row.Scan(&record.ID, &record.PublicID, &record.SpaceID, &record.OwnerUserID,
		&record.Title, &record.Description, &record.Question, &record.ChoiceMode,
		&record.MinSelections, &record.MaxSelections, &record.AllowVoteChange,
		&record.ResultVisibility, &record.DeliveryPolicy, &record.Status,
		&record.Deadline, &record.Revision, &record.IdempotencyKey,
		&record.CreatedAt, &record.UpdatedAt, &record.PublishedAt,
		&record.ClosedAt, &record.WithdrawnAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	normalizeSolicitationTimes(&record)
	return &record, nil
}

func normalizeSolicitationTimes(record *SolicitationRecord) {
	if record == nil {
		return
	}
	record.CreatedAt = record.CreatedAt.UTC()
	record.UpdatedAt = record.UpdatedAt.UTC()
	for _, value := range []*time.Time{record.Deadline, record.PublishedAt, record.ClosedAt, record.WithdrawnAt} {
		if value != nil {
			*value = value.UTC()
		}
	}
}

func (r *PGRepository) GetSolicitationByPublicID(ctx context.Context, spaceID, publicID string) (*SolicitationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo solicitations postgres pool is required")
	}
	return getSolicitationByPublicID(ctx, r.pool, spaceID, publicID)
}

func getSolicitationByPublicID(ctx context.Context, queryer pgQueryer, spaceID, publicID string) (*SolicitationRecord, error) {
	return scanSolicitation(queryer.QueryRow(ctx, solicitationSelect+` WHERE s.space_id = $1 AND s.public_id = $2`, spaceID, publicID))
}

func (r *PGRepository) GetSolicitationByID(ctx context.Context, spaceID, id string) (*SolicitationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo solicitations postgres pool is required")
	}
	return getSolicitationByID(ctx, r.pool, spaceID, id)
}

func getSolicitationByID(ctx context.Context, queryer pgQueryer, spaceID, id string) (*SolicitationRecord, error) {
	return scanSolicitation(queryer.QueryRow(ctx, solicitationSelect+` WHERE s.space_id = $1 AND s.id = $2`, spaceID, id))
}

func (r *PGRepository) ListSolicitations(ctx context.Context, query SolicitationListQuery) ([]SolicitationRecord, error) {
	if r == nil || r.pool == nil {
		return []SolicitationRecord{}, errors.New("workspace echo solicitations postgres pool is required")
	}
	return listSolicitations(ctx, r.pool, query)
}

func listSolicitations(ctx context.Context, queryer pgQueryer, query SolicitationListQuery) ([]SolicitationRecord, error) {
	conditions := []string{"s.space_id = $1", "(s.status <> 'draft' OR s.owner_user_id = $2)"}
	args := []any{query.SpaceID, query.ActorID}
	if query.Status != "" {
		args = append(args, query.Status)
		conditions = append(conditions, "s.status = $"+itoa(len(args)))
	}
	args = append(args, query.Limit)
	limitArg := "$" + itoa(len(args))
	rows, err := queryer.Query(ctx, solicitationSelect+" WHERE "+strings.Join(conditions, " AND ")+" ORDER BY CASE s.status WHEN 'open' THEN 1 WHEN 'draft' THEN 2 WHEN 'closed' THEN 3 ELSE 4 END, s.updated_at DESC, s.id DESC LIMIT "+limitArg, args...)
	if err != nil {
		return []SolicitationRecord{}, err
	}
	defer rows.Close()
	result := make([]SolicitationRecord, 0)
	for rows.Next() {
		var record SolicitationRecord
		if err := rows.Scan(&record.ID, &record.PublicID, &record.SpaceID, &record.OwnerUserID,
			&record.Title, &record.Description, &record.Question, &record.ChoiceMode,
			&record.MinSelections, &record.MaxSelections, &record.AllowVoteChange,
			&record.ResultVisibility, &record.DeliveryPolicy, &record.Status,
			&record.Deadline, &record.Revision, &record.IdempotencyKey,
			&record.CreatedAt, &record.UpdatedAt, &record.PublishedAt,
			&record.ClosedAt, &record.WithdrawnAt); err != nil {
			return []SolicitationRecord{}, err
		}
		normalizeSolicitationTimes(&record)
		result = append(result, record)
	}
	return result, rows.Err()
}

func (r *PGRepository) ListOptions(ctx context.Context, solicitationID string) ([]SolicitationOptionRecord, error) {
	if r == nil || r.pool == nil {
		return []SolicitationOptionRecord{}, errors.New("workspace echo solicitations postgres pool is required")
	}
	return listOptions(ctx, r.pool, solicitationID)
}

func listOptions(ctx context.Context, queryer pgQueryer, solicitationID string) ([]SolicitationOptionRecord, error) {
	rows, err := queryer.Query(ctx, `SELECT id, solicitation_id, label, position FROM echo_solicitation_options WHERE solicitation_id = $1 ORDER BY position ASC`, solicitationID)
	if err != nil {
		return []SolicitationOptionRecord{}, err
	}
	defer rows.Close()
	result := make([]SolicitationOptionRecord, 0)
	for rows.Next() {
		var row SolicitationOptionRecord
		if err := rows.Scan(&row.ID, &row.SolicitationID, &row.Label, &row.Position); err != nil {
			return []SolicitationOptionRecord{}, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (r *PGRepository) ListVotes(ctx context.Context, solicitationID string) ([]VoteRecord, error) {
	if r == nil || r.pool == nil {
		return []VoteRecord{}, errors.New("workspace echo solicitations postgres pool is required")
	}
	return listVotes(ctx, r.pool, solicitationID)
}

func listVotes(ctx context.Context, queryer pgQueryer, solicitationID string) ([]VoteRecord, error) {
	rows, err := queryer.Query(ctx, `
		SELECT v.id, v.solicitation_id, v.voter_user_id, u.display_name,
			u.github_login, v.selection_json, v.revision, v.created_at, v.updated_at
		FROM echo_solicitation_votes v
		INNER JOIN users u ON u.id = v.voter_user_id
		WHERE v.solicitation_id = $1 ORDER BY v.updated_at ASC, v.id ASC
	`, solicitationID)
	if err != nil {
		return []VoteRecord{}, err
	}
	defer rows.Close()
	result := make([]VoteRecord, 0)
	for rows.Next() {
		var row VoteRecord
		var selection string
		if err := rows.Scan(&row.ID, &row.SolicitationID, &row.VoterUserID, &row.VoterDisplayName, &row.VoterGitHubLogin, &selection, &row.Revision, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return []VoteRecord{}, err
		}
		row.Selection = parseSelection([]byte(selection))
		row.CreatedAt = row.CreatedAt.UTC()
		row.UpdatedAt = row.UpdatedAt.UTC()
		result = append(result, row)
	}
	return result, rows.Err()
}

func (r *PGRepository) GetVote(ctx context.Context, solicitationID, voterID string) (*VoteRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo solicitations postgres pool is required")
	}
	return getVote(ctx, r.pool, solicitationID, voterID)
}

func getVote(ctx context.Context, queryer pgQueryer, solicitationID, voterID string) (*VoteRecord, error) {
	var row VoteRecord
	var selection string
	err := queryer.QueryRow(ctx, `SELECT id, solicitation_id, voter_user_id, selection_json, revision, created_at, updated_at FROM echo_solicitation_votes WHERE solicitation_id = $1 AND voter_user_id = $2`, solicitationID, voterID).Scan(&row.ID, &row.SolicitationID, &row.VoterUserID, &selection, &row.Revision, &row.CreatedAt, &row.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	row.Selection = parseSelection([]byte(selection))
	row.CreatedAt = row.CreatedAt.UTC()
	row.UpdatedAt = row.UpdatedAt.UTC()
	return &row, nil
}

func (r *PGRepository) ListDeliveries(ctx context.Context, solicitationID string) ([]DeliveryRecord, error) {
	if r == nil || r.pool == nil {
		return []DeliveryRecord{}, errors.New("workspace echo solicitations postgres pool is required")
	}
	return listDeliveries(ctx, r.pool, solicitationID)
}

func listDeliveries(ctx context.Context, queryer pgQueryer, solicitationID string) ([]DeliveryRecord, error) {
	rows, err := queryer.Query(ctx, `
		SELECT d.id, d.space_id, d.solicitation_id, d.recipient_user_id,
			u.display_name, u.github_login, d.status, d.attempt_count,
			d.last_error_code, d.delivered_at, d.created_at, d.updated_at
		FROM echo_solicitation_deliveries d
		INNER JOIN users u ON u.id = d.recipient_user_id
		WHERE d.solicitation_id = $1 ORDER BY d.created_at ASC, d.id ASC
	`, solicitationID)
	if err != nil {
		return []DeliveryRecord{}, err
	}
	defer rows.Close()
	result := make([]DeliveryRecord, 0)
	for rows.Next() {
		var row DeliveryRecord
		if err := rows.Scan(&row.ID, &row.SpaceID, &row.SolicitationID, &row.RecipientUserID,
			&row.RecipientDisplayName, &row.RecipientGitHubLogin, &row.Status, &row.AttemptCount,
			&row.LastErrorCode, &row.DeliveredAt, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return []DeliveryRecord{}, err
		}
		normalizeDeliveryTimes(&row)
		result = append(result, row)
	}
	return result, rows.Err()
}

func normalizeDeliveryTimes(row *DeliveryRecord) {
	if row == nil {
		return
	}
	row.CreatedAt = row.CreatedAt.UTC()
	row.UpdatedAt = row.UpdatedAt.UTC()
	if row.DeliveredAt != nil {
		value := row.DeliveredAt.UTC()
		row.DeliveredAt = &value
	}
}

func (r *PGRepository) DeliverySummary(ctx context.Context, solicitationID string) (DeliverySummary, error) {
	if r == nil || r.pool == nil {
		return DeliverySummary{}, errors.New("workspace echo solicitations postgres pool is required")
	}
	return deliverySummary(ctx, r.pool, solicitationID)
}

func deliverySummary(ctx context.Context, queryer pgQueryer, solicitationID string) (DeliverySummary, error) {
	rows, err := queryer.Query(ctx, `SELECT status, COUNT(*) FROM echo_solicitation_deliveries WHERE solicitation_id = $1 GROUP BY status`, solicitationID)
	if err != nil {
		return DeliverySummary{}, err
	}
	defer rows.Close()
	result := DeliverySummary{}
	for rows.Next() {
		var status string
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			return DeliverySummary{}, err
		}
		result[status] = count
	}
	return result, rows.Err()
}

func (r *PGRepository) GetIdempotency(ctx context.Context, spaceID, actorID, operation, key string) (*IdempotencyRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo solicitations postgres pool is required")
	}
	return getIdempotency(ctx, r.pool, spaceID, actorID, operation, key)
}

func getIdempotency(ctx context.Context, queryer pgQueryer, spaceID, actorID, operation, key string) (*IdempotencyRecord, error) {
	var row IdempotencyRecord
	err := queryer.QueryRow(ctx, `SELECT space_id, actor_user_id, operation, idempotency_key, request_hash, solicitation_id, result_json, created_at FROM echo_solicitation_idempotency WHERE space_id = $1 AND actor_user_id = $2 AND operation = $3 AND idempotency_key = $4`, spaceID, actorID, operation, key).Scan(&row.SpaceID, &row.ActorUserID, &row.Operation, &row.Key, &row.RequestHash, &row.SolicitationID, &row.ResultJSON, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	row.CreatedAt = row.CreatedAt.UTC()
	return &row, nil
}

func (r *PGRepository) GetDelivery(ctx context.Context, spaceID, deliveryID string) (*DeliveryRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo solicitations postgres pool is required")
	}
	return getDelivery(ctx, r.pool, spaceID, deliveryID)
}

func getDelivery(ctx context.Context, queryer pgQueryer, spaceID, deliveryID string) (*DeliveryRecord, error) {
	var row DeliveryRecord
	err := queryer.QueryRow(ctx, `
		SELECT d.id, d.space_id, d.solicitation_id, d.recipient_user_id,
			u.display_name, u.github_login, d.status, d.attempt_count,
			d.last_error_code, d.delivered_at, d.created_at, d.updated_at
		FROM echo_solicitation_deliveries d
		INNER JOIN users u ON u.id = d.recipient_user_id
		WHERE d.id = $1 AND d.space_id = $2
	`, deliveryID, spaceID).Scan(&row.ID, &row.SpaceID, &row.SolicitationID, &row.RecipientUserID,
		&row.RecipientDisplayName, &row.RecipientGitHubLogin, &row.Status, &row.AttemptCount,
		&row.LastErrorCode, &row.DeliveredAt, &row.CreatedAt, &row.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	normalizeDeliveryTimes(&row)
	return &row, nil
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID, true)
}

func (t *pgTx) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	var active bool
	// Hold current membership through the accepting transaction. This also sees
	// removals made earlier by its caller instead of reading stale pool state.
	err := t.tx.QueryRow(ctx, `SELECT true FROM conversation_members cm
		INNER JOIN conversations c ON c.id = cm.conversation_id
		WHERE c.space_id = $1 AND c.id = $2 AND cm.user_id = $3
		AND cm.removed_at IS NULL FOR SHARE OF cm, c`, spaceID, conversationID, userID).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return active, err
}
func (t *pgTx) GetSolicitationByPublicID(ctx context.Context, spaceID, publicID string) (*SolicitationRecord, error) {
	return getSolicitationByPublicID(ctx, t.tx, spaceID, publicID)
}
func (t *pgTx) GetSolicitationByID(ctx context.Context, spaceID, id string) (*SolicitationRecord, error) {
	return getSolicitationByID(ctx, t.tx, spaceID, id)
}
func (t *pgTx) ListSolicitations(ctx context.Context, query SolicitationListQuery) ([]SolicitationRecord, error) {
	return listSolicitations(ctx, t.tx, query)
}
func (t *pgTx) ListOptions(ctx context.Context, solicitationID string) ([]SolicitationOptionRecord, error) {
	return listOptions(ctx, t.tx, solicitationID)
}
func (t *pgTx) ListVotes(ctx context.Context, solicitationID string) ([]VoteRecord, error) {
	return listVotes(ctx, t.tx, solicitationID)
}
func (t *pgTx) GetVote(ctx context.Context, solicitationID, voterID string) (*VoteRecord, error) {
	return getVote(ctx, t.tx, solicitationID, voterID)
}
func (t *pgTx) ListDeliveries(ctx context.Context, solicitationID string) ([]DeliveryRecord, error) {
	return listDeliveries(ctx, t.tx, solicitationID)
}
func (t *pgTx) DeliverySummary(ctx context.Context, solicitationID string) (DeliverySummary, error) {
	return deliverySummary(ctx, t.tx, solicitationID)
}
func (t *pgTx) GetIdempotency(ctx context.Context, spaceID, actorID, operation, key string) (*IdempotencyRecord, error) {
	return getIdempotency(ctx, t.tx, spaceID, actorID, operation, key)
}
func (t *pgTx) GetDelivery(ctx context.Context, spaceID, deliveryID string) (*DeliveryRecord, error) {
	return getDelivery(ctx, t.tx, spaceID, deliveryID)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	_, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, key)
	return err
}

func (t *pgTx) AllocateSequence(ctx context.Context, spaceID string, year int) (int, error) {
	if _, err := t.tx.Exec(ctx, `INSERT INTO echo_solicitation_sequences (space_id, sequence_year, next_number) VALUES ($1, $2, 1) ON CONFLICT (space_id, sequence_year) DO NOTHING`, spaceID, year); err != nil {
		return 0, err
	}
	var number int
	if err := t.tx.QueryRow(ctx, `SELECT next_number FROM echo_solicitation_sequences WHERE space_id = $1 AND sequence_year = $2 FOR UPDATE`, spaceID, year).Scan(&number); err != nil {
		return 0, err
	}
	if number < 1 || number > MaxSequenceNumber {
		return 0, conflictError(CodeSequenceExhausted, MessageSequenceExhausted)
	}
	if _, err := t.tx.Exec(ctx, `UPDATE echo_solicitation_sequences SET next_number = $1 WHERE space_id = $2 AND sequence_year = $3 AND next_number = $4`, number+1, spaceID, year, number); err != nil {
		return 0, err
	}
	return number, nil
}

func (t *pgTx) InsertSolicitation(ctx context.Context, record SolicitationRecord) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO echo_solicitations (
			id, public_id, space_id, owner_user_id, title, description, question,
			choice_mode, min_selections, max_selections, allow_vote_change,
			result_visibility, delivery_policy, status, deadline, revision,
			idempotency_key, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
	`, record.ID, record.PublicID, record.SpaceID, record.OwnerUserID, record.Title,
		record.Description, record.Question, record.ChoiceMode, record.MinSelections,
		record.MaxSelections, record.AllowVoteChange, record.ResultVisibility,
		record.DeliveryPolicy, record.Status, record.Deadline, record.Revision,
		record.IdempotencyKey, record.CreatedAt.UTC(), record.UpdatedAt.UTC())
	return err
}

func (t *pgTx) InsertOption(ctx context.Context, record SolicitationOptionRecord) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO echo_solicitation_options (id, solicitation_id, label, position) VALUES ($1, $2, $3, $4)`, record.ID, record.SolicitationID, record.Label, record.Position)
	return err
}

func (t *pgTx) InsertIdempotency(ctx context.Context, record IdempotencyRecord) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		INSERT INTO echo_solicitation_idempotency (
			space_id, actor_user_id, operation, idempotency_key, request_hash,
			solicitation_id, result_json, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (space_id, actor_user_id, operation, idempotency_key) DO NOTHING
	`, record.SpaceID, record.ActorUserID, record.Operation, record.Key, record.RequestHash,
		record.SolicitationID, nullableJSON(record.ResultJSON), record.CreatedAt.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) UpdateIdempotencyResult(ctx context.Context, spaceID, actorID, operation, key string, resultJSON []byte) error {
	_, err := t.tx.Exec(ctx, `UPDATE echo_solicitation_idempotency SET result_json = $1 WHERE space_id = $2 AND actor_user_id = $3 AND operation = $4 AND idempotency_key = $5`, string(resultJSON), spaceID, actorID, operation, key)
	return err
}

func (t *pgTx) UpdateSolicitationStateCAS(ctx context.Context, id string, expectedRevision int64, status string, revision int64, now time.Time, publishedAt, closedAt, withdrawnAt *time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE echo_solicitations
		SET status = $1, revision = $2, updated_at = $3,
			published_at = $4, closed_at = $5, withdrawn_at = $6
		WHERE id = $7 AND revision = $8
	`, status, revision, now.UTC(), publishedAt, closedAt, withdrawnAt, id, expectedRevision)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) InsertVote(ctx context.Context, record VoteRecord) error {
	selection, err := json.Marshal(record.Selection)
	if err != nil {
		return err
	}
	_, err = t.tx.Exec(ctx, `INSERT INTO echo_solicitation_votes (id, solicitation_id, voter_user_id, selection_json, revision, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, record.ID, record.SolicitationID, record.VoterUserID, string(selection), record.Revision, record.CreatedAt.UTC(), record.UpdatedAt.UTC())
	return err
}

func (t *pgTx) UpdateVote(ctx context.Context, record VoteRecord) (bool, error) {
	selection, err := json.Marshal(record.Selection)
	if err != nil {
		return false, err
	}
	result, err := t.tx.Exec(ctx, `UPDATE echo_solicitation_votes SET selection_json = $1, revision = $2, updated_at = $3 WHERE id = $4`, string(selection), record.Revision, record.UpdatedAt.UTC(), record.ID)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) InsertDeliveryRows(ctx context.Context, spaceID, solicitationID string, now time.Time) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO echo_solicitation_deliveries (
			id, space_id, solicitation_id, recipient_user_id, status,
			attempt_count, created_at, updated_at
		)
		SELECT 'echo_sol_delivery_' || md5(random()::text || clock_timestamp()::text || sm.user_id || s.id),
			sm.space_id, s.id, sm.user_id, 'pending', 0, $3, $3
		FROM space_members sm
		INNER JOIN users u ON u.id = sm.user_id
		INNER JOIN echo_solicitations s ON s.id = $2 AND s.space_id = sm.space_id
		WHERE sm.space_id = $1 AND sm.removed_at IS NULL AND u.kind = 'human'
		ON CONFLICT (solicitation_id, recipient_user_id) DO NOTHING
	`, spaceID, solicitationID, now.UTC())
	return err
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID("echo solicitation audit")
		if err != nil {
			return err
		}
		input.ID = id
	}
	meta := input.Meta.Safe()
	_, err := t.tx.Exec(ctx, `
		INSERT INTO audit_logs (
			id, space_id, actor_user_id, actor_github_login, action, target_type,
			target_id, result, reason, ip_address, user_agent, request_id, created_at
		) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6,
			NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''),
			NULLIF($11, ''), NULLIF($12, ''), $13)
	`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin,
		input.Action, input.TargetType, input.TargetID, input.Result, input.Reason,
		meta.IPAddress, meta.UserAgent, meta.RequestID, input.CreatedAt.UTC())
	return err
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) (EventRecord, error) {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID("echo solicitation event")
		if err != nil {
			return EventRecord{}, err
		}
		input.ID = id
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return EventRecord{}, errors.New("echo solicitation event payload is not valid JSON")
	}
	var next int64
	if err := t.tx.QueryRow(ctx, `INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES ($1, 2) ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1 RETURNING next_seq`, input.SpaceID).Scan(&next); err != nil {
		return EventRecord{}, err
	}
	seq := next - 1
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''),
			NULLIF($7, ''), NULLIF($8, ''), $9, $10)
	`, input.ID, input.SpaceID, seq, input.Type, input.ActorID, input.ConversationID,
		input.TargetType, input.TargetID, string(input.PayloadJSON), input.CreatedAt.UTC()); err != nil {
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

func parseSelection(raw []byte) []string {
	var result []string
	if err := json.Unmarshal(raw, &result); err != nil || result == nil {
		return []string{}
	}
	return result
}

func nullableJSON(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return string(value)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	negative := value < 0
	if negative {
		value = -value
	}
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		index--
		digits[index] = '-'
	}
	return string(digits[index:])
}
