package delivery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type pgQueryer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// DomainTransactionOptions lets the parent composition layer select its
// configured typed message/card repositories while keeping one underlying
// PostgreSQL transaction. Nil adapters fall back to the owning packages'
// native wrappers and still expose no generic SQL handle.
type DomainTransactionOptions struct {
	Message func(pgx.Tx) messages.Tx
	Card    func(pgx.Tx) cards.Tx
}

type PGRepository struct {
	pool    *pgxpool.Pool
	domains DomainTransactionOptions
}

func NewPGRepository(pool *pgxpool.Pool, options ...DomainTransactionOptions) *PGRepository {
	var domains DomainTransactionOptions
	if len(options) > 0 {
		domains = options[0]
	}
	return &PGRepository{pool: pool, domains: domains}
}

// NewPGTransaction wraps an already-open transaction. The caller owns its
// commit/rollback. It is useful to compose delivery into an existing worker
// transaction without creating a second pool transaction.
func NewPGTransaction(tx pgx.Tx, options ...DomainTransactionOptions) Tx {
	if tx == nil {
		return nil
	}
	var domains DomainTransactionOptions
	if len(options) > 0 {
		domains = options[0]
	}
	return &pgTx{tx: tx, repository: &PGRepository{domains: domains}}
}

func (r *PGRepository) NewTransaction(tx pgx.Tx) Tx {
	if r == nil || tx == nil {
		return nil
	}
	return &pgTx{tx: tx, repository: r}
}

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace echo delivery postgres pool is required")
	}
	return r.pool.Ping(ctx)
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace echo delivery postgres pool is required")
	}
	if callback == nil {
		return errors.New("echo delivery transaction callback is required")
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

func (r *PGRepository) GetSolicitation(ctx context.Context, spaceID, publicID string) (*SolicitationDelivery, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	return getSolicitation(ctx, r.pool, spaceID, publicID)
}

func (r *PGRepository) GetSolicitationByID(ctx context.Context, spaceID, solicitationID string) (*SolicitationDelivery, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	var value SolicitationDelivery
	err := r.pool.QueryRow(ctx, `
SELECT id, space_id, public_id, status, delivery_policy, revision, updated_at
FROM echo_solicitations
WHERE space_id = $1 AND id = $2`, spaceID, solicitationID).Scan(
		&value.SolicitationID, &value.SpaceID, &value.PublicID,
		&value.SolicitationStatus, &value.DeliveryPolicy, &value.Revision,
		&value.SolicitationUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value.SolicitationUpdatedAt = value.SolicitationUpdatedAt.UTC()
	return &value, nil
}

func getSolicitation(ctx context.Context, queryer pgQueryer, spaceID, publicID string) (*SolicitationDelivery, error) {
	return querySolicitation(ctx, queryer, spaceID, publicID, "")
}

func getSolicitationLocked(ctx context.Context, queryer pgQueryer, spaceID, publicID string) (*SolicitationDelivery, error) {
	return querySolicitation(ctx, queryer, spaceID, publicID, " FOR SHARE")
}

func querySolicitation(ctx context.Context, queryer pgQueryer, spaceID, publicID, lockClause string) (*SolicitationDelivery, error) {
	var value SolicitationDelivery
	err := queryer.QueryRow(ctx, `
SELECT id, space_id, public_id, status, delivery_policy, revision, updated_at
FROM echo_solicitations
WHERE space_id = $1 AND public_id = $2`+lockClause, spaceID, publicID).Scan(
		&value.SolicitationID, &value.SpaceID, &value.PublicID,
		&value.SolicitationStatus, &value.DeliveryPolicy, &value.Revision,
		&value.SolicitationUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value.SolicitationUpdatedAt = value.SolicitationUpdatedAt.UTC()
	return &value, nil
}

const solicitationDeliverySelect = `
SELECT d.id, d.space_id, d.solicitation_id, s.public_id, d.recipient_user_id,
       d.status, d.attempt_count, d.last_error_code, d.delivered_at,
       d.created_at, d.updated_at, s.status, s.delivery_policy, s.revision,
       s.updated_at
FROM echo_solicitation_deliveries d
INNER JOIN echo_solicitations s
  ON s.id = d.solicitation_id AND s.space_id = d.space_id
`

func scanSolicitationDelivery(row pgx.Row) (*SolicitationDelivery, error) {
	var value SolicitationDelivery
	if err := row.Scan(
		&value.ID, &value.SpaceID, &value.SolicitationID, &value.PublicID,
		&value.RecipientUserID, &value.Status, &value.AttemptCount,
		&value.LastErrorCode, &value.DeliveredAt, &value.CreatedAt,
		&value.UpdatedAt, &value.SolicitationStatus, &value.DeliveryPolicy,
		&value.Revision, &value.SolicitationUpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	value.CreatedAt = value.CreatedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	value.SolicitationUpdatedAt = value.SolicitationUpdatedAt.UTC()
	return &value, nil
}

func (r *PGRepository) ListSolicitationDeliveries(ctx context.Context, spaceID, publicID, recipientID string, limit int) ([]SolicitationDelivery, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	return listSolicitationDeliveries(ctx, r.pool, spaceID, publicID, recipientID, normalizeLimit(limit, DefaultBatchLimit))
}

func listSolicitationDeliveries(ctx context.Context, queryer pgQueryer, spaceID, publicID, recipientID string, limit int) ([]SolicitationDelivery, error) {
	query := solicitationDeliverySelect
	args := []any{spaceID}
	switch {
	case strings.TrimSpace(publicID) != "" && strings.TrimSpace(recipientID) != "":
		query += ` WHERE s.space_id = $1 AND s.public_id = $2 AND d.recipient_user_id = $3`
		args = append(args, publicID, recipientID)
	case strings.TrimSpace(publicID) != "":
		query += ` WHERE s.space_id = $1 AND s.public_id = $2`
		args = append(args, publicID)
	case strings.TrimSpace(recipientID) != "":
		query += ` WHERE s.space_id = $1 AND d.recipient_user_id = $2`
		args = append(args, recipientID)
	default:
		query += ` WHERE s.space_id = $1`
	}
	query += ` ORDER BY d.created_at ASC, d.id ASC LIMIT $` + fmt.Sprint(len(args)+1)
	args = append(args, limit)
	rows, err := queryer.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]SolicitationDelivery, 0)
	for rows.Next() {
		value, err := scanSolicitationDeliveryRows(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *value)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func scanSolicitationDeliveryRows(rows pgx.Rows) (*SolicitationDelivery, error) {
	var value SolicitationDelivery
	if err := rows.Scan(
		&value.ID, &value.SpaceID, &value.SolicitationID, &value.PublicID,
		&value.RecipientUserID, &value.Status, &value.AttemptCount,
		&value.LastErrorCode, &value.DeliveredAt, &value.CreatedAt,
		&value.UpdatedAt, &value.SolicitationStatus, &value.DeliveryPolicy,
		&value.Revision, &value.SolicitationUpdatedAt,
	); err != nil {
		return nil, err
	}
	value.CreatedAt = value.CreatedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	value.SolicitationUpdatedAt = value.SolicitationUpdatedAt.UTC()
	return &value, nil
}

func (r *PGRepository) ListSolicitationWork(ctx context.Context, spaceID, afterID string, limit int) ([]SolicitationDelivery, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	query := solicitationDeliverySelect + `
WHERE s.space_id = $1 AND d.id > $3
  AND (d.status IN ('pending', 'failed')
       OR (d.status = 'sent' AND s.status IN ('open', 'closed', 'withdrawn')))
ORDER BY d.id ASC
LIMIT $2`
	rows, err := r.pool.Query(ctx, query, spaceID, normalizeLimit(limit, DefaultBatchLimit), afterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]SolicitationDelivery, 0)
	for rows.Next() {
		value, err := scanSolicitationDeliveryRows(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *value)
	}
	return result, rows.Err()
}

func (r *PGRepository) EnsureSolicitationDeliveryRows(ctx context.Context, spaceID, publicID string, at time.Time) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace echo delivery postgres pool is required")
	}
	return r.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, "echo:solicitation:rows:"+spaceID+":"+publicID); err != nil {
			return err
		}
		solicitation, err := tx.GetSolicitation(ctx, spaceID, publicID)
		if err != nil || solicitation == nil {
			return err
		}
		if solicitation.DeliveryPolicy == "none" {
			return nil
		}
		members, err := tx.ListActiveHumanMembers(ctx, spaceID)
		if err != nil {
			return err
		}
		for _, memberID := range members {
			if err := insertSolicitationDelivery(ctx, txQueryer(tx), spaceID, solicitation.SolicitationID, memberID, at); err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *PGRepository) EnsureSolicitationDeliveryRowsForMember(ctx context.Context, spaceID, memberID string, at time.Time) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace echo delivery postgres pool is required")
	}
	return r.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, "echo:solicitation:member:"+spaceID+":"+memberID); err != nil {
			return err
		}
		active, err := tx.IsActiveHumanMember(ctx, spaceID, memberID)
		if err != nil || !active {
			return err
		}
		rows, err := querySolicitationsForMember(ctx, txQueryer(tx), spaceID)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if err := insertSolicitationDelivery(ctx, txQueryer(tx), spaceID, row.id, memberID, at); err != nil {
				return err
			}
		}
		return nil
	})
}

type queryTx interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func txQueryer(tx Tx) queryTx {
	value, ok := tx.(*pgTx)
	if !ok || value == nil || value.tx == nil {
		return nil
	}
	return value.tx
}

func insertSolicitationDelivery(ctx context.Context, queryer queryTx, spaceID, solicitationID, recipientID string, at time.Time) error {
	if queryer == nil {
		return errors.New("echo delivery transaction queryer is required")
	}
	id, err := newIdentifier("echo_sol_delivery")
	if err != nil {
		return err
	}
	_, err = queryer.Exec(ctx, `
INSERT INTO echo_solicitation_deliveries (
  id, space_id, solicitation_id, recipient_user_id, status, attempt_count,
  last_error_code, delivered_at, created_at, updated_at
) VALUES ($1, $2, $3, $4, 'pending', 0, NULL, NULL, $5, $5)
ON CONFLICT (solicitation_id, recipient_user_id) DO NOTHING`,
		id, spaceID, solicitationID, recipientID, at.UTC())
	return err
}

type solicitationIDRow struct{ id string }

func querySolicitationsForMember(ctx context.Context, queryer queryTx, spaceID string) ([]solicitationIDRow, error) {
	rows, err := queryer.Query(ctx, `
SELECT id
FROM echo_solicitations
WHERE space_id = $1 AND status = 'open' AND delivery_policy <> 'none'
ORDER BY updated_at ASC, id ASC`, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]solicitationIDRow, 0)
	for rows.Next() {
		var row solicitationIDRow
		if err := rows.Scan(&row.id); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (r *PGRepository) GetRequirement(ctx context.Context, spaceID, publicID string) (*RequirementRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	return getRequirement(ctx, r.pool, spaceID, publicID)
}

const requirementSelect = `
SELECT id, public_id, space_id, submitter_user_id, revision, updated_at
FROM echo_requirements
`

func getRequirement(ctx context.Context, queryer pgQueryer, spaceID, publicID string) (*RequirementRecord, error) {
	return queryRequirement(ctx, queryer, spaceID, publicID, "")
}

func getRequirementLocked(ctx context.Context, queryer pgQueryer, spaceID, publicID string) (*RequirementRecord, error) {
	return queryRequirement(ctx, queryer, spaceID, publicID, " FOR SHARE")
}

func queryRequirement(ctx context.Context, queryer pgQueryer, spaceID, publicID, lockClause string) (*RequirementRecord, error) {
	var value RequirementRecord
	err := queryer.QueryRow(ctx, requirementSelect+`WHERE space_id = $1 AND public_id = $2`+lockClause, spaceID, publicID).Scan(
		&value.ID, &value.PublicID, &value.SpaceID, &value.SubmitterUserID, &value.Revision, &value.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value.UpdatedAt = value.UpdatedAt.UTC()
	return &value, nil
}

func (r *PGRepository) ListRequirementsForRecovery(ctx context.Context, spaceID, afterID string, limit int) ([]RequirementRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	rows, err := r.pool.Query(ctx, requirementSelect+`WHERE space_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`, spaceID, afterID, normalizeLimit(limit, DefaultRequirementLimit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]RequirementRecord, 0)
	for rows.Next() {
		var value RequirementRecord
		if err := rows.Scan(&value.ID, &value.PublicID, &value.SpaceID, &value.SubmitterUserID, &value.Revision, &value.UpdatedAt); err != nil {
			return nil, err
		}
		value.UpdatedAt = value.UpdatedAt.UTC()
		result = append(result, value)
	}
	return result, rows.Err()
}

func (r *PGRepository) ListRequirementsForMember(ctx context.Context, spaceID, memberID string, owner bool, limit int) ([]RequirementRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	return listRequirements(ctx, r.pool, spaceID, memberID, owner, normalizeLimit(limit, DefaultRequirementLimit))
}

func listRequirements(ctx context.Context, queryer pgQueryer, spaceID, memberID string, owner bool, limit int) ([]RequirementRecord, error) {
	query := requirementSelect
	args := []any{spaceID}
	if owner {
		query += `WHERE space_id = $1 ORDER BY updated_at ASC, id ASC LIMIT $2`
	} else {
		query += `WHERE space_id = $1 AND submitter_user_id = $2 ORDER BY updated_at ASC, id ASC LIMIT $3`
		args = append(args, memberID)
	}
	args = append(args, limit)
	rows, err := queryer.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]RequirementRecord, 0)
	for rows.Next() {
		var value RequirementRecord
		if err := rows.Scan(&value.ID, &value.PublicID, &value.SpaceID, &value.SubmitterUserID, &value.Revision, &value.UpdatedAt); err != nil {
			return nil, err
		}
		value.UpdatedAt = value.UpdatedAt.UTC()
		result = append(result, value)
	}
	return result, rows.Err()
}

func (r *PGRepository) GetReleaseDelivery(ctx context.Context, spaceID, deliveryID string) (*ReleaseDelivery, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	return scanReleaseDelivery(r.pool.QueryRow(ctx, releaseDeliverySelect+`WHERE d.space_id = $1 AND d.id = $2`, spaceID, deliveryID))
}

const releaseDeliverySelect = `
SELECT d.id, d.space_id, d.publication_id, p.version, d.recipient_user_id,
       d.status, d.attempt_count, d.last_error_code, d.delivered_at,
       d.created_at, d.updated_at, p.published_at
FROM echo_release_deliveries d
INNER JOIN echo_release_publications p
  ON p.id = d.publication_id AND p.space_id = d.space_id
`

func scanReleaseDelivery(row pgx.Row) (*ReleaseDelivery, error) {
	var value ReleaseDelivery
	if err := row.Scan(
		&value.ID, &value.SpaceID, &value.PublicationID, &value.Version,
		&value.RecipientUserID, &value.Status, &value.AttemptCount,
		&value.LastErrorCode, &value.DeliveredAt, &value.CreatedAt,
		&value.UpdatedAt, &value.PublishedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	value.CreatedAt = value.CreatedAt.UTC()
	value.UpdatedAt = value.UpdatedAt.UTC()
	value.PublishedAt = value.PublishedAt.UTC()
	return &value, nil
}

func (r *PGRepository) ListReleaseDeliveries(ctx context.Context, spaceID, version, recipientID string, limit int) ([]ReleaseDelivery, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	query := releaseDeliverySelect
	args := []any{spaceID}
	switch {
	case strings.TrimSpace(version) != "" && strings.TrimSpace(recipientID) != "":
		query += `WHERE d.space_id = $1 AND p.version = $2 AND d.recipient_user_id = $3`
		args = append(args, version, recipientID)
	case strings.TrimSpace(version) != "":
		query += `WHERE d.space_id = $1 AND p.version = $2`
		args = append(args, version)
	case strings.TrimSpace(recipientID) != "":
		query += `WHERE d.space_id = $1 AND d.recipient_user_id = $2`
		args = append(args, recipientID)
	default:
		query += `WHERE d.space_id = $1`
	}
	query += ` ORDER BY d.created_at ASC, d.id ASC LIMIT $` + fmt.Sprint(len(args)+1)
	args = append(args, normalizeLimit(limit, DefaultBatchLimit))
	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ReleaseDelivery, 0)
	for rows.Next() {
		var value ReleaseDelivery
		if err := rows.Scan(
			&value.ID, &value.SpaceID, &value.PublicationID, &value.Version,
			&value.RecipientUserID, &value.Status, &value.AttemptCount,
			&value.LastErrorCode, &value.DeliveredAt, &value.CreatedAt,
			&value.UpdatedAt, &value.PublishedAt,
		); err != nil {
			return nil, err
		}
		value.CreatedAt = value.CreatedAt.UTC()
		value.UpdatedAt = value.UpdatedAt.UTC()
		value.PublishedAt = value.PublishedAt.UTC()
		result = append(result, value)
	}
	return result, rows.Err()
}

func (r *PGRepository) ListReleaseWork(ctx context.Context, spaceID, afterID string, limit int) ([]ReleaseDelivery, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	rows, err := r.pool.Query(ctx, releaseDeliverySelect+`WHERE d.space_id = $1 AND d.id > $3 AND d.status IN ('pending', 'failed') ORDER BY d.id ASC LIMIT $2`, spaceID, normalizeLimit(limit, DefaultBatchLimit), afterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ReleaseDelivery, 0)
	for rows.Next() {
		var value ReleaseDelivery
		if err := rows.Scan(
			&value.ID, &value.SpaceID, &value.PublicationID, &value.Version,
			&value.RecipientUserID, &value.Status, &value.AttemptCount,
			&value.LastErrorCode, &value.DeliveredAt, &value.CreatedAt,
			&value.UpdatedAt, &value.PublishedAt,
		); err != nil {
			return nil, err
		}
		value.CreatedAt = value.CreatedAt.UTC()
		value.UpdatedAt = value.UpdatedAt.UTC()
		value.PublishedAt = value.PublishedAt.UTC()
		result = append(result, value)
	}
	return result, rows.Err()
}

func (r *PGRepository) IsActiveHumanMember(ctx context.Context, spaceID, userID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace echo delivery postgres pool is required")
	}
	return isActiveHumanMember(ctx, r.pool, spaceID, userID)
}

func isActiveHumanMember(ctx context.Context, queryer pgQueryer, spaceID, userID string) (bool, error) {
	var active bool
	err := queryer.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM users u
  INNER JOIN space_members sm ON sm.user_id = u.id
  WHERE sm.space_id = $1 AND sm.user_id = $2
    AND sm.removed_at IS NULL AND u.kind = 'human'
)`, spaceID, userID).Scan(&active)
	return active, err
}

func (r *PGRepository) ListActiveHumanMembers(ctx context.Context, spaceID string) ([]string, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	return listMembers(ctx, r.pool, spaceID, "human", "")
}

func (r *PGRepository) ListActiveOwners(ctx context.Context, spaceID string) ([]string, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	return listMembers(ctx, r.pool, spaceID, "human", "owner")
}

func listMembers(ctx context.Context, queryer pgQueryer, spaceID, kind, role string) ([]string, error) {
	query := `
SELECT sm.user_id
FROM space_members sm
INNER JOIN users u ON u.id = sm.user_id
WHERE sm.space_id = $1 AND sm.removed_at IS NULL AND u.kind = $2`
	args := []any{spaceID, kind}
	if role != "" {
		query += ` AND sm.role = $3`
		args = append(args, role)
	}
	query += ` ORDER BY sm.user_id ASC`
	rows, err := queryer.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func (r *PGRepository) FindCard(ctx context.Context, spaceID, sourceID, cardType string) (*ExistingCard, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo delivery postgres pool is required")
	}
	return findCard(ctx, r.pool, spaceID, sourceID, cardType)
}

func findCard(ctx context.Context, queryer pgQueryer, spaceID, sourceID, cardType string) (*ExistingCard, error) {
	var value ExistingCard
	err := queryer.QueryRow(ctx, `
SELECT id, card_type, revision, status, payload_json
FROM workspace_cards
WHERE space_id = $1 AND source_kind = 'echo' AND source_id = $2 AND card_type = $3`, spaceID, sourceID, cardType).Scan(
		&value.ID, &value.CardType, &value.Revision, &value.Status, &value.PayloadJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &value, nil
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

func (t *pgTx) MessageTransaction() messages.Tx {
	if t == nil || t.tx == nil {
		return nil
	}
	if t.repository != nil && t.repository.domains.Message != nil {
		return t.repository.domains.Message(t.tx)
	}
	return messages.NewPGTransaction(t.tx)
}

func (t *pgTx) CardTransaction() cards.Tx {
	if t == nil || t.tx == nil {
		return nil
	}
	if t.repository != nil && t.repository.domains.Card != nil {
		return t.repository.domains.Card(t.tx)
	}
	return cards.NewPGTransaction(t.tx)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	if t == nil || t.tx == nil {
		return errors.New("echo delivery transaction is required")
	}
	_, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

func (t *pgTx) ClaimSolicitationDelivery(ctx context.Context, spaceID, deliveryID string) (*SolicitationDelivery, bool, error) {
	if t == nil || t.tx == nil {
		return nil, false, errors.New("echo delivery transaction is required")
	}
	row := t.tx.QueryRow(ctx, solicitationDeliverySelect+`
	WHERE d.space_id = $1 AND d.id = $2
	FOR UPDATE OF d, s SKIP LOCKED`, spaceID, deliveryID)
	value, err := scanSolicitationDelivery(row)
	if err != nil {
		return nil, false, err
	}
	return value, value != nil, nil
}

func (t *pgTx) ClaimReleaseDelivery(ctx context.Context, spaceID, deliveryID string) (*ReleaseDelivery, bool, error) {
	if t == nil || t.tx == nil {
		return nil, false, errors.New("echo delivery transaction is required")
	}
	value, err := scanReleaseDelivery(t.tx.QueryRow(ctx, releaseDeliverySelect+`
	WHERE d.space_id = $1 AND d.id = $2
	FOR UPDATE OF d, p SKIP LOCKED`, spaceID, deliveryID))
	if err != nil {
		return nil, false, err
	}
	return value, value != nil, nil
}

func (t *pgTx) GetSolicitation(ctx context.Context, spaceID, publicID string) (*SolicitationDelivery, error) {
	if t == nil || t.tx == nil {
		return nil, errors.New("echo delivery transaction is required")
	}
	return getSolicitationLocked(ctx, t.tx, spaceID, publicID)
}

func (t *pgTx) GetRequirement(ctx context.Context, spaceID, publicID string) (*RequirementRecord, error) {
	if t == nil || t.tx == nil {
		return nil, errors.New("echo delivery transaction is required")
	}
	return getRequirementLocked(ctx, t.tx, spaceID, publicID)
}

func (t *pgTx) FindCard(ctx context.Context, spaceID, sourceID, cardType string) (*ExistingCard, error) {
	if t == nil || t.tx == nil {
		return nil, errors.New("echo delivery transaction is required")
	}
	return findCard(ctx, t.tx, spaceID, sourceID, cardType)
}

func (t *pgTx) IsActiveHumanMember(ctx context.Context, spaceID, userID string) (bool, error) {
	if t == nil || t.tx == nil {
		return false, errors.New("echo delivery transaction is required")
	}
	var active bool
	err := t.tx.QueryRow(ctx, `SELECT true FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE sm.space_id = $1 AND sm.user_id = $2
		AND sm.removed_at IS NULL AND u.kind = 'human'
		FOR SHARE OF sm, u`, spaceID, userID).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return active, err
}

func (t *pgTx) RequirementRecipientAuthorized(ctx context.Context, spaceID, userID, submitterID, cardType string) (bool, error) {
	var role string
	err := t.tx.QueryRow(ctx, `SELECT sm.role FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE sm.space_id = $1 AND sm.user_id = $2 AND sm.removed_at IS NULL
		AND u.kind = 'human' FOR SHARE OF sm, u`, spaceID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return (cardType == CardTypeRequest || cardType == CardTypeStatus) && (role == "owner" || userID == submitterID), nil
}

func (t *pgTx) ListActiveHumanMembers(ctx context.Context, spaceID string) ([]string, error) {
	if t == nil || t.tx == nil {
		return nil, errors.New("echo delivery transaction is required")
	}
	return listMembers(ctx, t.tx, spaceID, "human", "")
}

func (t *pgTx) EchoIdentityActive(ctx context.Context, spaceID string) (bool, error) {
	if t == nil || t.tx == nil {
		return false, errors.New("echo delivery transaction is required")
	}
	var active bool
	err := t.tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM users u
  INNER JOIN space_members sm ON sm.user_id = u.id
  WHERE sm.space_id = $1 AND sm.user_id = $2
    AND sm.removed_at IS NULL AND u.kind = 'bot'
)`, spaceID, EchoUserID).Scan(&active)
	return active, err
}

func (t *pgTx) EnsureEchoDirectConversation(ctx context.Context, spaceID, recipientID, echoID string, at time.Time) (*DirectConversation, error) {
	if t == nil || t.tx == nil {
		return nil, errors.New("echo delivery transaction is required")
	}
	if strings.TrimSpace(echoID) == "" {
		echoID = EchoUserID
	}
	if err := t.Lock(ctx, "echo:conversation:"+spaceID+":"+recipientID+":"+echoID); err != nil {
		return nil, err
	}
	var recipientName, echoName string
	err := t.tx.QueryRow(ctx, `
SELECT u.display_name
FROM users u
INNER JOIN space_members sm ON sm.user_id = u.id
WHERE sm.space_id = $1 AND sm.user_id = $2
  AND sm.removed_at IS NULL AND u.kind = 'human'
FOR SHARE OF sm, u`, spaceID, recipientID).Scan(&recipientName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, NewError("echo.recipient_ineligible", "收件人不属于空间", 404)
	}
	if err != nil {
		return nil, err
	}
	err = t.tx.QueryRow(ctx, `
SELECT u.display_name
FROM users u
INNER JOIN space_members sm ON sm.user_id = u.id
WHERE sm.space_id = $1 AND sm.user_id = $2
  AND sm.removed_at IS NULL AND u.kind = 'bot'
FOR SHARE OF sm, u`, spaceID, echoID).Scan(&echoName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, NewError("echo.identity_unavailable", "回声身份尚未初始化", 503)
	}
	if err != nil {
		return nil, err
	}
	directKey := directConversationKey(recipientID, echoID)
	id := "conv_echo_" + stableToken(spaceID+":"+recipientID+":"+echoID)
	var insertedID string
	err = t.tx.QueryRow(ctx, `
INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
VALUES ($1, $2, 'direct', $3, $4, 10000, $5, $6)
ON CONFLICT (space_id, direct_key) DO NOTHING
RETURNING id`, id, spaceID, echoName+", "+recipientName, directKey, echoID, at.UTC()).Scan(&insertedID)
	inserted := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		err = t.tx.QueryRow(ctx, `SELECT id FROM conversations WHERE space_id = $1 AND direct_key = $2`, spaceID, directKey).Scan(&insertedID)
	}
	if err != nil {
		return nil, err
	}
	for _, userID := range []string{recipientID, echoID} {
		if _, err := t.tx.Exec(ctx, `
INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
VALUES ($1, $2, $3, NULL)
ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL`, insertedID, userID, at.UTC()); err != nil {
			return nil, err
		}
	}
	if inserted {
		if err := t.WriteEvent(ctx, EventInput{
			SpaceID: spaceID, Type: EventConversationCreated, ActorID: echoID,
			ConversationID: insertedID, TargetType: "conversation", TargetID: insertedID,
			Payload:   map[string]any{"conversationId": insertedID, "type": "direct", "memberIds": sortedStrings([]string{recipientID, echoID})},
			CreatedAt: at,
		}); err != nil {
			return nil, err
		}
	}
	return &DirectConversation{ID: insertedID, SpaceID: spaceID, Type: "direct", Reused: !inserted}, nil
}

func (t *pgTx) MarkSolicitationDelivery(ctx context.Context, spaceID, deliveryID, status, errorCode string, at time.Time) error {
	if t == nil || t.tx == nil {
		return errors.New("echo delivery transaction is required")
	}
	return markDelivery(ctx, t.tx, "echo_solicitation_deliveries", spaceID, deliveryID, status, errorCode, at)
}

func (t *pgTx) MarkReleaseDelivery(ctx context.Context, spaceID, deliveryID, status, errorCode string, at time.Time) error {
	if t == nil || t.tx == nil {
		return errors.New("echo delivery transaction is required")
	}
	return markDelivery(ctx, t.tx, "echo_release_deliveries", spaceID, deliveryID, status, errorCode, at)
}

func markDelivery(ctx context.Context, queryer queryTx, table, spaceID, deliveryID, status, errorCode string, at time.Time) error {
	if status != DeliverySent && status != DeliveryFailed && status != DeliverySkipped {
		return NewError("echo.delivery_status_invalid", "投递状态无效", 500)
	}
	tag, err := queryer.Exec(ctx, `UPDATE `+table+`
 SET status = $1,
     attempt_count = attempt_count + 1,
     last_error_code = $2,
    delivered_at = CASE WHEN $1 = 'sent' THEN COALESCE(delivered_at, $3) ELSE delivered_at END,
    updated_at = $3
	 WHERE id = $4 AND space_id = $5`, status, nullableErrorCode(errorCode), at.UTC(), deliveryID, spaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return NewError("echo.delivery_not_found", "投递不存在", 404)
	}
	return nil
}

func nullableErrorCode(value string) any {
	value = truncateCode(value)
	if value == "" {
		return nil
	}
	return value
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if t == nil || t.tx == nil {
		return errors.New("echo delivery transaction is required")
	}
	meta := input.Meta.Safe()
	id, err := auditID(input.ID)
	if err != nil {
		return err
	}
	_, err = t.tx.Exec(ctx, `
INSERT INTO audit_logs (
  id, space_id, actor_user_id, actor_github_login, action, target_type,
  target_id, result, reason, ip_address, user_agent, request_id, created_at
) VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), $10, $11, $12, $13)`,
		id, input.SpaceID, nullableString(input.ActorUserID), nullableString(input.ActorGitHubLogin),
		input.Action, input.TargetType, input.TargetID, normalizeAuditResult(input.Result),
		truncateCode(input.Reason), meta.IPAddress, meta.UserAgent, meta.RequestID, auditTime(input.CreatedAt))
	return err
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) error {
	if t == nil || t.tx == nil {
		return errors.New("echo delivery transaction is required")
	}
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return err
	}
	id, err := eventID(input.ID)
	if err != nil {
		return err
	}
	var seq int64
	if err := t.tx.QueryRow(ctx, `
INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES ($1, 2)
ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1
RETURNING next_seq - 1`, input.SpaceID).Scan(&seq); err != nil {
		return err
	}
	_, err = t.tx.Exec(ctx, `
INSERT INTO workspace_events (
  id, space_id, seq, type, actor_user_id, conversation_id,
  target_type, target_id, payload_json, created_at
) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)`,
		id, input.SpaceID, seq, input.Type, input.ActorID, input.ConversationID,
		input.TargetType, input.TargetID, string(payload), auditTime(input.CreatedAt))
	return err
}

func normalizeLimit(value, fallback int) int {
	if value <= 0 {
		value = fallback
	}
	if value > 200 {
		return 200
	}
	return value
}

func newIdentifier(prefix string) (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return prefix + "_" + id.String(), nil
}

func auditID(value string) (string, error) {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value), nil
	}
	return newIdentifier("audit_echo")
}

func eventID(value string) (string, error) {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value), nil
	}
	return newIdentifier("evt_echo")
}

func auditTime(value time.Time) time.Time {
	if value.IsZero() {
		return time.Now().UTC().Truncate(time.Millisecond)
	}
	return value.UTC().Truncate(time.Millisecond)
}

func normalizeAuditResult(value string) string {
	switch strings.TrimSpace(value) {
	case "success", "rejected":
		return strings.TrimSpace(value)
	default:
		return "failure"
	}
}

func truncateCode(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > MaxDeliveryErrorCode {
		return value[:MaxDeliveryErrorCode]
	}
	return value
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func directConversationKey(first, second string) string {
	values := sortedStrings([]string{first, second})
	return strings.Join(values, ":")
}

func stableToken(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])[:32]
}

func sortedStrings(values []string) []string {
	copyValues := append([]string(nil), values...)
	sort.Strings(copyValues)
	return copyValues
}

var _ TypedTransactionProvider = (*pgTx)(nil)
var _ Tx = (*pgTx)(nil)

// Keep auth imported in this file's dependency graph through the explicit
// transaction boundary documentation; the actual actor model remains owned
// by the auth package used in AuditInput.
var _ = auth.DefaultSpaceID
