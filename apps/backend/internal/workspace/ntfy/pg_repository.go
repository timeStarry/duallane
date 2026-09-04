package ntfy

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

// PGRepository is the durable ntfy adapter. Provider requests are never made
// here; this adapter only persists state and re-reads current eligibility.
type PGRepository struct {
	pool      *pgxpool.Pool
	idFactory IDFactory
}

func NewPGRepository(pool *pgxpool.Pool, idFactories ...IDFactory) *PGRepository {
	idFactory := IDFactory(func() (string, error) {
		id, err := uuid.NewRandom()
		if err != nil {
			return "", err
		}
		return id.String(), nil
	})
	if len(idFactories) > 0 && idFactories[0] != nil {
		idFactory = idFactories[0]
	}
	return &PGRepository{pool: pool, idFactory: idFactory}
}

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return internalError("ping workspace ntfy database", errors.New("workspace postgres pool is required"))
	}
	if err := r.pool.Ping(ctx); err != nil {
		return internalError("ping workspace ntfy database", err)
	}
	return nil
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin workspace ntfy transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin workspace ntfy transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin workspace ntfy transaction", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()
	if err := callback(&pgTx{tx: tx, idFactory: r.idFactory}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return internalError("commit workspace ntfy transaction", err)
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup ntfy actor", errors.New("workspace postgres pool is required"))
	}
	return lookupActor(ctx, r.pool, spaceID, userID)
}

func (r *PGRepository) GetPreferences(ctx context.Context, userID string) (*PreferenceRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get ntfy preferences", errors.New("workspace postgres pool is required"))
	}
	return getPreferences(ctx, r.pool, userID)
}

func (r *PGRepository) ListRecipients(ctx context.Context, query ScheduleRecipientQuery) ([]RecipientRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list ntfy recipients", errors.New("workspace postgres pool is required"))
	}
	return listRecipients(ctx, r.pool, query)
}

func (r *PGRepository) ListDueJobs(ctx context.Context, now time.Time, limit int) ([]string, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list due ntfy jobs", errors.New("workspace postgres pool is required"))
	}
	return listDueJobs(ctx, r.pool, now, limit)
}

func (r *PGRepository) GetDeliveryJob(ctx context.Context, id string) (*DeliveryJob, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get ntfy delivery job", errors.New("workspace postgres pool is required"))
	}
	return getDeliveryJob(ctx, r.pool, id)
}

func (r *PGRepository) ClaimJob(ctx context.Context, id string, leaseUntil, now time.Time) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("claim ntfy job", errors.New("workspace postgres pool is required"))
	}
	return claimJob(ctx, r.pool, id, leaseUntil, now)
}

func (r *PGRepository) MarkSent(ctx context.Context, id string, sentAt time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("mark ntfy job sent", errors.New("workspace postgres pool is required"))
	}
	return markSent(ctx, r.pool, id, sentAt)
}

func (r *PGRepository) RetryJob(ctx context.Context, id string, attempt int, nextAttemptAt time.Time, code string) error {
	if r == nil || r.pool == nil {
		return internalError("retry ntfy job", errors.New("workspace postgres pool is required"))
	}
	return retryJob(ctx, r.pool, id, attempt, nextAttemptAt, code)
}

func (r *PGRepository) MarkFailed(ctx context.Context, id string, attempt int, code string) error {
	if r == nil || r.pool == nil {
		return internalError("fail ntfy job", errors.New("workspace postgres pool is required"))
	}
	return markFailed(ctx, r.pool, id, attempt, code)
}

func (r *PGRepository) CancelJob(ctx context.Context, id string, cancelledAt time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("cancel ntfy job", errors.New("workspace postgres pool is required"))
	}
	return cancelJob(ctx, r.pool, id, cancelledAt)
}

func (r *PGRepository) CancelPendingJobs(ctx context.Context, userID string, cancelledAt time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("cancel ntfy jobs", errors.New("workspace postgres pool is required"))
	}
	return cancelPendingJobs(ctx, r.pool, userID, cancelledAt)
}

type pgQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type pgTx struct {
	tx        pgx.Tx
	idFactory IDFactory
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID)
}

func (t *pgTx) GetPreferences(ctx context.Context, userID string) (*PreferenceRecord, error) {
	return getPreferences(ctx, t.tx, userID)
}

func (t *pgTx) ListRecipients(ctx context.Context, query ScheduleRecipientQuery) ([]RecipientRecord, error) {
	return listRecipients(ctx, t.tx, query)
}

func (t *pgTx) ListDueJobs(ctx context.Context, now time.Time, limit int) ([]string, error) {
	return listDueJobs(ctx, t.tx, now, limit)
}

func (t *pgTx) GetDeliveryJob(ctx context.Context, id string) (*DeliveryJob, error) {
	return getDeliveryJob(ctx, t.tx, id)
}

func (t *pgTx) CreatePreferences(ctx context.Context, userID, topic string, createdAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_ntfy_preferences (
			user_id, topic, enabled, created_at, rotated_at, updated_at
		) VALUES ($1, $2, 1, $3, NULL, $3)
		ON CONFLICT DO NOTHING
	`, userID, topic, normalizeTime(createdAt))
	if err != nil {
		return false, internalError("create ntfy preferences", err)
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) UpdatePreferences(ctx context.Context, userID string, enabled bool, updatedAt time.Time) error {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_ntfy_preferences
		SET enabled = $2, updated_at = $3
		WHERE user_id = $1
	`, userID, boolInt(enabled), normalizeTime(updatedAt))
	if err != nil {
		return internalError("update ntfy preferences", err)
	}
	if result.RowsAffected() != 1 {
		return internalError("update ntfy preferences", errors.New("preference row is missing"))
	}
	return nil
}

func (t *pgTx) RotatePreferences(ctx context.Context, userID, topic string, rotatedAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_ntfy_preferences AS current
		SET topic = $2, rotated_at = $3, updated_at = $3
		WHERE current.user_id = $1
		  AND current.topic <> $2
		  AND NOT EXISTS (
			SELECT 1 FROM workspace_ntfy_preferences conflict
			WHERE conflict.topic = $2 AND conflict.user_id <> current.user_id
		  )
	`, userID, topic, normalizeTime(rotatedAt))
	if err != nil {
		return false, internalError("rotate ntfy topic", err)
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) InsertJob(ctx context.Context, input JobInsert) (bool, error) {
	id := strings.TrimSpace(input.ID)
	if id == "" {
		var err error
		id, err = t.newID()
		if err != nil {
			return false, err
		}
	}
	result, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_ntfy_jobs (
			id, user_id, message_id, conversation_id, event_seq, status,
			available_at, next_attempt_at, lease_until, attempt_count,
			sent_at, cancelled_at, last_error_code, created_at
		) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, NULL, 0, NULL, NULL, NULL, $8)
		ON CONFLICT (user_id, message_id) DO NOTHING
	`, id, input.UserID, input.MessageID, input.ConversationID, input.EventSeq,
		normalizeTime(input.AvailableAt), normalizeTime(input.NextAttemptAt), normalizeTime(input.CreatedAt))
	if err != nil {
		return false, internalError("insert ntfy job", err)
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) CancelPendingJobs(ctx context.Context, userID string, cancelledAt time.Time) error {
	return cancelPendingJobs(ctx, t.tx, userID, cancelledAt)
}

func (t *pgTx) newID() (string, error) {
	if t == nil || t.idFactory == nil {
		return "", errors.New("workspace ntfy id factory is required")
	}
	id, err := t.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("workspace ntfy id factory returned an empty id")
	}
	return id, nil
}

func lookupActor(ctx context.Context, queryer pgQueryer, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	var joinedAt time.Time
	err := queryer.QueryRow(ctx, `
		SELECT u.id, u.github_id, u.github_login, u.email, u.display_name,
		       u.nickname, u.avatar_url, u.search_discoverable, u.kind,
		       sm.role, sm.joined_at
		FROM users u
		INNER JOIN space_members sm
		  ON sm.user_id = u.id AND sm.space_id = $2 AND sm.removed_at IS NULL
		WHERE u.id = $1
	`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName,
		&nickname, &avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &joinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("lookup ntfy actor", err)
	}
	actor.GitHubID = stringValue(githubID)
	actor.Email = stringValue(email)
	actor.Nickname = stringValue(nickname)
	actor.AvatarURL = stringValue(avatarURL)
	actor.JoinedAt = joinedAt.UTC()
	return &actor, nil
}

func getPreferences(ctx context.Context, queryer pgQueryer, userID string) (*PreferenceRecord, error) {
	var record PreferenceRecord
	err := queryer.QueryRow(ctx, `
		SELECT user_id, topic, enabled = 1, created_at, rotated_at, updated_at
		FROM workspace_ntfy_preferences
		WHERE user_id = $1
	`, userID).Scan(&record.UserID, &record.Topic, &record.Enabled, &record.CreatedAt, &record.RotatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get ntfy preferences", err)
	}
	record.CreatedAt = record.CreatedAt.UTC()
	record.UpdatedAt = record.UpdatedAt.UTC()
	if record.RotatedAt != nil {
		value := record.RotatedAt.UTC()
		record.RotatedAt = &value
	}
	return &record, nil
}

func listRecipients(ctx context.Context, queryer pgQueryer, query ScheduleRecipientQuery) ([]RecipientRecord, error) {
	var rows pgx.Rows
	var err error
	if strings.TrimSpace(query.TopicID) != "" {
		rows, err = queryer.Query(ctx, `
			SELECT u.id, u.github_login, COALESCE(tm.notification_level, 'all')
			FROM topic_members tm
			INNER JOIN users u ON u.id = tm.user_id AND u.kind = 'human'
			INNER JOIN conversation_members cm
			  ON cm.conversation_id = $1 AND cm.user_id = tm.user_id AND cm.removed_at IS NULL
			INNER JOIN space_members sm
			  ON sm.space_id = $2 AND sm.user_id = tm.user_id AND sm.removed_at IS NULL
			WHERE tm.topic_id = $3 AND tm.left_at IS NULL AND tm.user_id <> $4
			ORDER BY tm.user_id ASC
		`, query.ConversationID, query.SpaceID, query.TopicID, query.AuthorID)
	} else {
		rows, err = queryer.Query(ctx, `
			SELECT u.id, u.github_login, COALESCE(cm.notification_level, 'all')
			FROM conversation_members cm
			INNER JOIN users u ON u.id = cm.user_id AND u.kind = 'human'
			INNER JOIN space_members sm
			  ON sm.space_id = $1 AND sm.user_id = cm.user_id AND sm.removed_at IS NULL
			WHERE cm.conversation_id = $2 AND cm.removed_at IS NULL AND cm.user_id <> $3
			ORDER BY cm.user_id ASC
		`, query.SpaceID, query.ConversationID, query.AuthorID)
	}
	if err != nil {
		return nil, internalError("list ntfy recipients", err)
	}
	defer rows.Close()
	items := make([]RecipientRecord, 0)
	for rows.Next() {
		var item RecipientRecord
		if err := rows.Scan(&item.UserID, &item.GitHubLogin, &item.NotificationLevel); err != nil {
			return nil, internalError("scan ntfy recipients", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list ntfy recipients", err)
	}
	return items, nil
}

func listDueJobs(ctx context.Context, queryer pgQueryer, now time.Time, limit int) ([]string, error) {
	if limit <= 0 || limit > MaximumJobBatchSize {
		limit = DefaultJobBatchSize
	}
	rows, err := queryer.Query(ctx, `
		SELECT id
		FROM workspace_ntfy_jobs
		WHERE status IN ('pending', 'sending')
		  AND next_attempt_at <= $1
		  AND (lease_until IS NULL OR lease_until <= $1)
		ORDER BY next_attempt_at ASC, id ASC
		LIMIT $2
	`, normalizeTime(now), limit)
	if err != nil {
		return nil, internalError("list due ntfy jobs", err)
	}
	defer rows.Close()
	items := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, internalError("scan due ntfy job", err)
		}
		items = append(items, id)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list due ntfy jobs", err)
	}
	return items, nil
}

func getDeliveryJob(ctx context.Context, queryer pgQueryer, id string) (*DeliveryJob, error) {
	var job DeliveryJob
	var topicID, topicTitle *string
	var lastReadSeq *int64
	var lastReadAt *time.Time
	var content string
	err := queryer.QueryRow(ctx, `
		SELECT
			j.id, j.user_id, j.message_id, j.conversation_id, j.event_seq,
			j.attempt_count, p.topic, (p.enabled = 1),
			COALESCE(CASE WHEN m.topic_id IS NOT NULL THEN tm.notification_level ELSE cm.notification_level END, 'all'),
			CASE WHEN m.topic_id IS NOT NULL THEN tm.last_read_seq ELSE cm.last_read_seq END,
			CASE WHEN m.topic_id IS NOT NULL THEN topic_read_message.created_at ELSE cm.last_read_at END,
			m.topic_id, topic.title, m.created_at, m.content_json,
			c.type, c.title,
			COALESCE(ur.remark, author.nickname, author.github_login, author.display_name, '成员')
		FROM workspace_ntfy_jobs j
		INNER JOIN workspace_ntfy_preferences p ON p.user_id = j.user_id
		INNER JOIN messages m ON m.id = j.message_id AND m.deleted_at IS NULL AND m.recalled_at IS NULL
		INNER JOIN users author ON author.id = m.author_id
		INNER JOIN conversations c ON c.id = j.conversation_id
		LEFT JOIN topics topic ON topic.id = m.topic_id
		INNER JOIN conversation_members cm
		  ON cm.conversation_id = j.conversation_id AND cm.user_id = j.user_id AND cm.removed_at IS NULL
		LEFT JOIN topic_members tm
		  ON tm.topic_id = m.topic_id AND tm.user_id = j.user_id AND tm.left_at IS NULL
		LEFT JOIN messages topic_read_message
		  ON topic_read_message.id = tm.last_read_message_id AND topic_read_message.topic_id = m.topic_id
		INNER JOIN space_members sm
		  ON sm.user_id = j.user_id AND sm.space_id = c.space_id AND sm.removed_at IS NULL
		LEFT JOIN user_remarks ur
		  ON ur.owner_user_id = j.user_id AND ur.target_user_id = author.id
		WHERE j.id = $1
		  AND j.status = 'sending'
		  AND (m.topic_id IS NULL OR tm.user_id IS NOT NULL)
	`, id).Scan(&job.ID, &job.UserID, &job.MessageID, &job.ConversationID, &job.EventSeq,
		&job.AttemptCount, &job.Topic, &job.PreferenceEnabled, &job.NotificationLevel,
		&lastReadSeq, &lastReadAt, &topicID, &topicTitle, &job.MessageCreatedAt, &content,
		&job.ConversationType, &job.ConversationTitle, &job.SenderName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get ntfy delivery job", err)
	}
	job.LastReadSeq = lastReadSeq
	job.LastReadAt = lastReadAt
	job.TopicID = topicID
	job.TopicTitle = topicTitle
	job.MessageCreatedAt = job.MessageCreatedAt.UTC()
	job.ContentJSON = []byte(content)
	return &job, nil
}

type pgExecer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func claimJob(ctx context.Context, queryer pgExecer, id string, leaseUntil, now time.Time) (bool, error) {
	result, err := queryer.Exec(ctx, `
		UPDATE workspace_ntfy_jobs
		SET status = 'sending', lease_until = $2
		WHERE id = $1
		  AND status IN ('pending', 'sending')
		  AND next_attempt_at <= $3
		  AND (lease_until IS NULL OR lease_until <= $3)
	`, id, normalizeTime(leaseUntil), normalizeTime(now))
	if err != nil {
		return false, internalError("claim ntfy job", err)
	}
	return result.RowsAffected() == 1, nil
}

func markSent(ctx context.Context, queryer pgExecer, id string, sentAt time.Time) error {
	_, err := queryer.Exec(ctx, `
		UPDATE workspace_ntfy_jobs
		SET status = 'sent', sent_at = $2, lease_until = NULL, last_error_code = NULL
		WHERE id = $1 AND status = 'sending'
	`, id, normalizeTime(sentAt))
	if err != nil {
		return internalError("mark ntfy job sent", err)
	}
	return nil
}

func retryJob(ctx context.Context, queryer pgExecer, id string, attempt int, nextAttemptAt time.Time, code string) error {
	_, err := queryer.Exec(ctx, `
		UPDATE workspace_ntfy_jobs
		SET status = 'pending', attempt_count = $2, lease_until = NULL,
		    next_attempt_at = $3, last_error_code = $4
		WHERE id = $1 AND status = 'sending'
	`, id, attempt, normalizeTime(nextAttemptAt), safeErrorCode(code))
	if err != nil {
		return internalError("retry ntfy job", err)
	}
	return nil
}

func markFailed(ctx context.Context, queryer pgExecer, id string, attempt int, code string) error {
	_, err := queryer.Exec(ctx, `
		UPDATE workspace_ntfy_jobs
		SET status = 'failed', attempt_count = $2, lease_until = NULL, last_error_code = $3
		WHERE id = $1 AND status = 'sending'
	`, id, attempt, safeErrorCode(code))
	if err != nil {
		return internalError("fail ntfy job", err)
	}
	return nil
}

func cancelJob(ctx context.Context, queryer pgExecer, id string, cancelledAt time.Time) error {
	_, err := queryer.Exec(ctx, `
		UPDATE workspace_ntfy_jobs
		SET status = 'cancelled', cancelled_at = $2, lease_until = NULL
		WHERE id = $1 AND status IN ('pending', 'sending')
	`, id, normalizeTime(cancelledAt))
	if err != nil {
		return internalError("cancel ntfy job", err)
	}
	return nil
}

func cancelPendingJobs(ctx context.Context, queryer pgExecer, userID string, cancelledAt time.Time) error {
	_, err := queryer.Exec(ctx, `
		UPDATE workspace_ntfy_jobs
		SET status = 'cancelled', cancelled_at = $2, lease_until = NULL
		WHERE user_id = $1 AND status IN ('pending', 'sending')
	`, userID, normalizeTime(cancelledAt))
	if err != nil {
		return internalError("cancel ntfy jobs", err)
	}
	return nil
}

func normalizeTime(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func safeErrorCode(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 128 {
		return CodeProviderUnavailable
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f || character == '\n' || character == '\r' {
			return CodeProviderUnavailable
		}
	}
	if value == "" {
		return CodeProviderUnavailable
	}
	return value
}
