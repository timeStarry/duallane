package releases

import (
	"context"
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
	idFactory IDFactory
}

func NewPGRepository(pool *pgxpool.Pool, factories ...IDFactory) *PGRepository {
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
// release domain's typed Tx surface. The caller owns commit/rollback.
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
		return errors.New("workspace echo releases postgres pool is required")
	}
	return r.pool.Ping(ctx)
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace echo releases postgres pool is required")
	}
	if callback == nil {
		return errors.New("echo release transaction callback is required")
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
	transaction := &pgTx{tx: tx, repository: r}
	if err := callback(transaction); err != nil {
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
		return nil, errors.New("workspace echo releases postgres pool is required")
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
	err := queryer.QueryRow(ctx, `
		SELECT u.id, u.github_login, u.kind, sm.role
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`+lockClause, userID, spaceID).Scan(&actor.ID, &actor.GitHubLogin, &actor.Kind, &actor.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &actor, nil
}

const publicationSelect = `
	SELECT p.id, p.space_id, p.version, p.title, p.guide_hash, p.guide_json,
		p.published_by_user_id, p.published_at
	FROM echo_release_publications p
`

func scanPublication(row pgx.Row) (*PublicationRecord, error) {
	var record PublicationRecord
	if err := row.Scan(&record.ID, &record.SpaceID, &record.Version, &record.Title, &record.GuideHash, &record.GuideJSON, &record.PublishedByUserID, &record.PublishedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	record.PublishedAt = record.PublishedAt.UTC()
	return &record, nil
}

func (r *PGRepository) GetPublication(ctx context.Context, spaceID, version string) (*PublicationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo releases postgres pool is required")
	}
	return getPublication(ctx, r.pool, spaceID, version)
}

func getPublication(ctx context.Context, queryer pgQueryer, spaceID, version string) (*PublicationRecord, error) {
	return scanPublication(queryer.QueryRow(ctx, publicationSelect+` WHERE p.space_id = $1 AND p.version = $2`, spaceID, version))
}

func (r *PGRepository) GetPublicationForRecipient(ctx context.Context, spaceID, version, recipientID string) (*PublicationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo releases postgres pool is required")
	}
	return getPublicationForRecipient(ctx, r.pool, spaceID, version, recipientID)
}

func getPublicationForRecipient(ctx context.Context, queryer pgQueryer, spaceID, version, recipientID string) (*PublicationRecord, error) {
	return scanPublication(queryer.QueryRow(ctx, publicationSelect+` INNER JOIN echo_release_deliveries d ON d.publication_id = p.id AND d.space_id = p.space_id AND d.recipient_user_id = $3 WHERE p.space_id = $1 AND p.version = $2`, spaceID, version, recipientID))
}

func (r *PGRepository) DeliverySummary(ctx context.Context, publicationID string) (DeliverySummary, error) {
	if r == nil || r.pool == nil {
		return DeliverySummary{}, errors.New("workspace echo releases postgres pool is required")
	}
	return deliverySummary(ctx, r.pool, publicationID)
}

func deliverySummary(ctx context.Context, queryer pgQueryer, publicationID string) (DeliverySummary, error) {
	var result DeliverySummary
	err := queryer.QueryRow(ctx, `
		SELECT COUNT(*),
			COUNT(*) FILTER (WHERE status = 'pending'),
			COUNT(*) FILTER (WHERE status = 'sent'),
			COUNT(*) FILTER (WHERE status = 'failed'),
			COUNT(*) FILTER (WHERE status = 'skipped')
		FROM echo_release_deliveries
		WHERE publication_id = $1
	`, publicationID).Scan(&result.RecipientCount, &result.PendingCount, &result.SentCount, &result.FailedCount, &result.SkippedCount)
	return result, err
}

func (r *PGRepository) ListDeliveries(ctx context.Context, query DeliveryQuery) ([]DeliveryRecord, error) {
	if r == nil || r.pool == nil {
		return []DeliveryRecord{}, errors.New("workspace echo releases postgres pool is required")
	}
	return listDeliveries(ctx, r.pool, query)
}

func listDeliveries(ctx context.Context, queryer pgQueryer, query DeliveryQuery) ([]DeliveryRecord, error) {
	spaceID := strings.TrimSpace(query.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	conditions := []string{"d.space_id = $1"}
	args := []any{spaceID}
	add := func(condition string, value any) {
		args = append(args, value)
		conditions = append(conditions, strings.Replace(condition, "?", "$"+itoa(len(args)), 1))
	}
	if strings.TrimSpace(query.Version) != "" {
		version, err := normalizeVersion(query.Version)
		if err != nil {
			return []DeliveryRecord{}, err
		}
		add("p.version = ?", version)
	}
	if strings.TrimSpace(query.RecipientUserID) != "" {
		add("d.recipient_user_id = ?", strings.TrimSpace(query.RecipientUserID))
	}
	limit := query.Limit
	if limit <= 0 {
		limit = DefaultDeliveryLimit
	}
	if limit > MaxDeliveryLimit {
		limit = MaxDeliveryLimit
	}
	args = append(args, limit)
	limitPlaceholder := "$" + itoa(len(args))
	rows, err := queryer.Query(ctx, `
		SELECT d.id, d.space_id, d.publication_id, p.version,
			d.recipient_user_id, COALESCE(u.kind, ''),
			(sm.user_id IS NOT NULL AND sm.removed_at IS NULL),
			d.status, d.attempt_count, d.last_error_code, d.delivered_at,
			p.published_at, d.created_at, d.updated_at
		FROM echo_release_deliveries d
		INNER JOIN echo_release_publications p ON p.id = d.publication_id AND p.space_id = d.space_id
		LEFT JOIN users u ON u.id = d.recipient_user_id
		LEFT JOIN space_members sm ON sm.space_id = d.space_id AND sm.user_id = d.recipient_user_id
		WHERE `+strings.Join(conditions, " AND ")+`
		ORDER BY d.created_at ASC, d.id ASC
		LIMIT `+limitPlaceholder, args...)
	if err != nil {
		return []DeliveryRecord{}, err
	}
	defer rows.Close()
	result := make([]DeliveryRecord, 0)
	for rows.Next() {
		record, err := scanDelivery(rows)
		if err != nil {
			return []DeliveryRecord{}, err
		}
		result = append(result, *record)
	}
	if err := rows.Err(); err != nil {
		return []DeliveryRecord{}, err
	}
	return result, nil
}

func (r *PGRepository) GetDelivery(ctx context.Context, spaceID, deliveryID string) (*DeliveryRecord, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("workspace echo releases postgres pool is required")
	}
	return getDelivery(ctx, r.pool, spaceID, deliveryID)
}

func getDelivery(ctx context.Context, queryer pgQueryer, spaceID, deliveryID string) (*DeliveryRecord, error) {
	return scanDelivery(queryer.QueryRow(ctx, `
		SELECT d.id, d.space_id, d.publication_id, p.version,
			d.recipient_user_id, COALESCE(u.kind, ''),
			(sm.user_id IS NOT NULL AND sm.removed_at IS NULL),
			d.status, d.attempt_count, d.last_error_code, d.delivered_at,
			p.published_at, d.created_at, d.updated_at
		FROM echo_release_deliveries d
		INNER JOIN echo_release_publications p ON p.id = d.publication_id AND p.space_id = d.space_id
		LEFT JOIN users u ON u.id = d.recipient_user_id
		LEFT JOIN space_members sm ON sm.space_id = d.space_id AND sm.user_id = d.recipient_user_id
		WHERE d.space_id = $1 AND d.id = $2
	`, spaceID, deliveryID))
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID, true)
}

func (t *pgTx) GetPublication(ctx context.Context, spaceID, version string) (*PublicationRecord, error) {
	return getPublication(ctx, t.tx, spaceID, version)
}

func (t *pgTx) GetPublicationForRecipient(ctx context.Context, spaceID, version, recipientID string) (*PublicationRecord, error) {
	return getPublicationForRecipient(ctx, t.tx, spaceID, version, recipientID)
}

func (t *pgTx) DeliverySummary(ctx context.Context, publicationID string) (DeliverySummary, error) {
	return deliverySummary(ctx, t.tx, publicationID)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	_, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, key)
	return err
}

func (t *pgTx) InsertPublication(ctx context.Context, record PublicationRecord) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO echo_release_publications (
			id, space_id, version, title, guide_hash, guide_json,
			published_by_user_id, published_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, record.ID, record.SpaceID, record.Version, record.Title, record.GuideHash, string(record.GuideJSON), record.PublishedByUserID, record.PublishedAt.UTC())
	return err
}

func (t *pgTx) InsertDeliveryRows(ctx context.Context, spaceID, publicationID string, now time.Time) error {
	rows, err := t.tx.Query(ctx, `
		SELECT sm.user_id
		FROM space_members sm
		INNER JOIN users u ON u.id = sm.user_id
		WHERE sm.space_id = $1 AND sm.removed_at IS NULL AND u.kind = 'human'
		ORDER BY sm.user_id ASC
	`, spaceID)
	if err != nil {
		return err
	}
	recipients := make([]string, 0)
	for rows.Next() {
		var recipientUserID string
		if err := rows.Scan(&recipientUserID); err != nil {
			rows.Close()
			return err
		}
		recipients = append(recipients, recipientUserID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, recipientUserID := range recipients {
		deliverySuffix, err := t.newID("echo release delivery")
		if err != nil {
			return err
		}
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO echo_release_deliveries (
				id, space_id, publication_id, recipient_user_id, status,
				attempt_count, last_error_code, delivered_at, created_at, updated_at
			) VALUES ($1, $2, $3, $4, 'pending', 0, NULL, NULL, $5, $5)
			ON CONFLICT (publication_id, recipient_user_id) DO NOTHING
		`, "echo_release_delivery_"+deliverySuffix, spaceID, publicationID, recipientUserID, now.UTC()); err != nil {
			return err
		}
	}
	return nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID("echo release audit")
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

func (t *pgTx) newID(operation string) (string, error) {
	if t == nil || t.repository == nil || t.repository.idFactory == nil {
		return "", errors.New(operation + " id factory is required")
	}
	id, err := t.repository.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return id, nil
}

func normalizeDeliveryTimes(record *DeliveryRecord) {
	record.PublishedAt = record.PublishedAt.UTC()
	record.CreatedAt = record.CreatedAt.UTC()
	record.UpdatedAt = record.UpdatedAt.UTC()
	if record.DeliveredAt != nil {
		value := record.DeliveredAt.UTC()
		record.DeliveredAt = &value
	}
}

type pgScanner interface {
	Scan(...any) error
}

func scanDelivery(row pgScanner) (*DeliveryRecord, error) {
	var record DeliveryRecord
	if err := row.Scan(&record.ID, &record.SpaceID, &record.PublicationID, &record.Version, &record.RecipientUserID, &record.RecipientKind, &record.RecipientActive, &record.Status, &record.AttemptCount, &record.LastErrorCode, &record.DeliveredAt, &record.PublishedAt, &record.CreatedAt, &record.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	normalizeDeliveryTimes(&record)
	return &record, nil
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

var _ Repository = (*PGRepository)(nil)
var _ DeliveryRepository = (*PGRepository)(nil)
