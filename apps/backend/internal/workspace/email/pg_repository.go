package email

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

// PGRepository is the durable email adapter. It contains no provider calls;
// external SMTP work is performed by the worker after a conditional claim.
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
		return internalError("ping workspace email database", errors.New("workspace postgres pool is required"))
	}
	if err := r.pool.Ping(ctx); err != nil {
		return internalError("ping workspace email database", err)
	}
	return nil
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin workspace email transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin workspace email transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin workspace email transaction", err)
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
		return internalError("commit workspace email transaction", err)
	}
	committed = true
	return nil
}

// BindTx adapts an already-open PostgreSQL transaction for callers that need
// to schedule email work atomically with another Workspace write. The caller
// owns commit and rollback; this method never starts or closes the transaction.
func (r *PGRepository) BindTx(tx pgx.Tx) Tx {
	if r == nil || tx == nil {
		return nil
	}
	return &pgTx{tx: tx, idFactory: r.idFactory}
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup email actor", errors.New("workspace postgres pool is required"))
	}
	return lookupActor(ctx, r.pool, spaceID, userID)
}

func (r *PGRepository) GetPreferences(ctx context.Context, userID string) (*PreferenceRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get email preferences", errors.New("workspace postgres pool is required"))
	}
	return getPreferences(ctx, r.pool, userID)
}

func (r *PGRepository) GetSpaceSettings(ctx context.Context, spaceID string) (*SMTPSettingsRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get email settings", errors.New("workspace postgres pool is required"))
	}
	return getSpaceSettings(ctx, r.pool, spaceID)
}

func (r *PGRepository) CountSMTPTests(ctx context.Context, userID string, since time.Time) (int, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count SMTP tests", errors.New("workspace postgres pool is required"))
	}
	return countSMTPTests(ctx, r.pool, userID, since)
}

func (r *PGRepository) CountRecentChallenges(ctx context.Context, userID string, since time.Time) (int, *time.Time, error) {
	if r == nil || r.pool == nil {
		return 0, nil, internalError("count email challenges", errors.New("workspace postgres pool is required"))
	}
	return countRecentChallenges(ctx, r.pool, userID, since)
}

func (r *PGRepository) GetChallenge(ctx context.Context, userID, id string) (*ChallengeRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get email challenge", errors.New("workspace postgres pool is required"))
	}
	return getChallenge(ctx, r.pool, userID, id)
}

func (r *PGRepository) FailedJobCount(ctx context.Context, spaceID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count failed email jobs", errors.New("workspace postgres pool is required"))
	}
	var count int64
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_email_jobs j INNER JOIN conversations c ON c.id = j.conversation_id WHERE c.space_id = $1 AND j.status = 'failed'`, spaceID).Scan(&count); err != nil {
		return 0, internalError("count failed email jobs", err)
	}
	return count, nil
}

func (r *PGRepository) LastDeliveryAt(ctx context.Context, spaceID string) (*time.Time, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read last email delivery", errors.New("workspace postgres pool is required"))
	}
	var value *time.Time
	if err := r.pool.QueryRow(ctx, `SELECT MAX(j.sent_at) FROM workspace_email_jobs j INNER JOIN conversations c ON c.id = j.conversation_id WHERE c.space_id = $1 AND j.status = 'sent'`, spaceID).Scan(&value); err != nil {
		return nil, internalError("read last email delivery", err)
	}
	if value != nil {
		value = timePtr(normalizeTime(*value))
	}
	return value, nil
}

func (r *PGRepository) ListRecipients(ctx context.Context, query ScheduleRecipientQuery) ([]RecipientRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list email recipients", errors.New("workspace postgres pool is required"))
	}
	return listRecipients(ctx, r.pool, query)
}

func (r *PGRepository) ListDueJobs(ctx context.Context, spaceID string, now time.Time, limit int) ([]string, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list due email jobs", errors.New("workspace postgres pool is required"))
	}
	return listDueJobs(ctx, r.pool, spaceID, now, limit)
}

func (r *PGRepository) GetDeliveryJob(ctx context.Context, id string) (*DeliveryJob, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get email delivery job", errors.New("workspace postgres pool is required"))
	}
	return getDeliveryJob(ctx, r.pool, id)
}

func (r *PGRepository) ListDigestStates(ctx context.Context, spaceID string, now time.Time, limit int) ([]DigestState, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list email digest states", errors.New("workspace postgres pool is required"))
	}
	return listDigestStates(ctx, r.pool, spaceID, now, limit)
}

func (r *PGRepository) ListEligibleUnreadMessages(ctx context.Context, spaceID, userID string, startedAt time.Time) ([]UnreadMessage, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list unread email messages", errors.New("workspace postgres pool is required"))
	}
	return listEligibleUnreadMessages(ctx, r.pool, spaceID, userID, startedAt)
}

func (r *PGRepository) ClaimJob(ctx context.Context, id string, leaseUntil, now time.Time) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("claim email job", errors.New("workspace postgres pool is required"))
	}
	return claimJob(ctx, r.pool, id, leaseUntil, now)
}

func (r *PGRepository) DeferJob(ctx context.Context, id string, nextAttemptAt time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("defer email job", errors.New("workspace postgres pool is required"))
	}
	return deferJob(ctx, r.pool, id, nextAttemptAt)
}

func (r *PGRepository) MarkSent(ctx context.Context, id string, sentAt time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("mark email job sent", errors.New("workspace postgres pool is required"))
	}
	return markSent(ctx, r.pool, id, sentAt)
}

func (r *PGRepository) RetryJob(ctx context.Context, id string, attempt int, nextAttemptAt time.Time, code string) error {
	if r == nil || r.pool == nil {
		return internalError("retry email job", errors.New("workspace postgres pool is required"))
	}
	return retryJob(ctx, r.pool, id, attempt, nextAttemptAt, code)
}

func (r *PGRepository) MarkFailed(ctx context.Context, id string, attempt int, code string) error {
	if r == nil || r.pool == nil {
		return internalError("fail email job", errors.New("workspace postgres pool is required"))
	}
	return markFailed(ctx, r.pool, id, attempt, code)
}

func (r *PGRepository) CancelJob(ctx context.Context, id string, cancelledAt time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("cancel email job", errors.New("workspace postgres pool is required"))
	}
	return cancelJob(ctx, r.pool, id, cancelledAt)
}

func (r *PGRepository) DeleteDigestState(ctx context.Context, userID string) error {
	if r == nil || r.pool == nil {
		return internalError("delete email digest state", errors.New("workspace postgres pool is required"))
	}
	_, err := r.pool.Exec(ctx, `DELETE FROM workspace_email_digest_states WHERE user_id = $1`, userID)
	if err != nil {
		return internalError("delete email digest state", err)
	}
	return nil
}

func (r *PGRepository) ClaimDigestState(ctx context.Context, userID string, leaseUntil, now time.Time) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("claim email digest state", errors.New("workspace postgres pool is required"))
	}
	return claimDigestState(ctx, r.pool, userID, leaseUntil, now)
}

func (r *PGRepository) MarkDigestSent(ctx context.Context, userID string, notifiedAt time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("mark email digest sent", errors.New("workspace postgres pool is required"))
	}
	return markDigestSent(ctx, r.pool, userID, notifiedAt)
}

func (r *PGRepository) RetryDigestState(ctx context.Context, userID string, attempt int, next time.Time, code string, updatedAt time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("retry email digest state", errors.New("workspace postgres pool is required"))
	}
	return retryDigestState(ctx, r.pool, userID, attempt, next, code, updatedAt)
}

type pgQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type pgExecer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
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

func (t *pgTx) GetSpaceSettings(ctx context.Context, spaceID string) (*SMTPSettingsRecord, error) {
	return getSpaceSettings(ctx, t.tx, spaceID)
}

func (t *pgTx) CountSMTPTests(ctx context.Context, userID string, since time.Time) (int, error) {
	return countSMTPTests(ctx, t.tx, userID, since)
}

func (t *pgTx) CountRecentChallenges(ctx context.Context, userID string, since time.Time) (int, *time.Time, error) {
	return countRecentChallenges(ctx, t.tx, userID, since)
}

func (t *pgTx) GetChallenge(ctx context.Context, userID, id string) (*ChallengeRecord, error) {
	return getChallenge(ctx, t.tx, userID, id)
}

func (t *pgTx) FailedJobCount(ctx context.Context, spaceID string) (int64, error) {
	var count int64
	if err := t.tx.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_email_jobs j INNER JOIN conversations c ON c.id = j.conversation_id WHERE c.space_id = $1 AND j.status = 'failed'`, spaceID).Scan(&count); err != nil {
		return 0, internalError("count failed email jobs", err)
	}
	return count, nil
}

func (t *pgTx) LastDeliveryAt(ctx context.Context, spaceID string) (*time.Time, error) {
	var value *time.Time
	if err := t.tx.QueryRow(ctx, `SELECT MAX(j.sent_at) FROM workspace_email_jobs j INNER JOIN conversations c ON c.id = j.conversation_id WHERE c.space_id = $1 AND j.status = 'sent'`, spaceID).Scan(&value); err != nil {
		return nil, internalError("read last email delivery", err)
	}
	if value != nil {
		value = timePtr(normalizeTime(*value))
	}
	return value, nil
}

func (t *pgTx) ListRecipients(ctx context.Context, query ScheduleRecipientQuery) ([]RecipientRecord, error) {
	return listRecipients(ctx, t.tx, query)
}

func (t *pgTx) ListDueJobs(ctx context.Context, spaceID string, now time.Time, limit int) ([]string, error) {
	return listDueJobs(ctx, t.tx, spaceID, now, limit)
}

func (t *pgTx) GetDeliveryJob(ctx context.Context, id string) (*DeliveryJob, error) {
	return getDeliveryJob(ctx, t.tx, id)
}

func (t *pgTx) ListDigestStates(ctx context.Context, spaceID string, now time.Time, limit int) ([]DigestState, error) {
	return listDigestStates(ctx, t.tx, spaceID, now, limit)
}

func (t *pgTx) ListEligibleUnreadMessages(ctx context.Context, spaceID, userID string, startedAt time.Time) ([]UnreadMessage, error) {
	return listEligibleUnreadMessages(ctx, t.tx, spaceID, userID, startedAt)
}

func (t *pgTx) EnsurePreferences(ctx context.Context, actor *auth.Actor, now time.Time) (*PreferenceRecord, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return nil, errors.New("actor is required")
	}
	verifiedAt := any(nil)
	if strings.TrimSpace(actor.Email) != "" {
		verifiedAt = normalizeTime(now)
	}
	_, err := t.tx.Exec(ctx, `
		INSERT INTO user_notification_preferences (
			user_id, email, email_source, email_verified_at, enabled, immediate_enabled, digest_enabled, updated_at
		) VALUES ($1, NULLIF($2, ''), 'github', $3, 1, 0, 1, $4)
		ON CONFLICT (user_id) DO NOTHING
	`, actor.ID, strings.TrimSpace(actor.Email), verifiedAt, normalizeTime(now))
	if err != nil {
		return nil, internalError("ensure email preferences", err)
	}
	return getPreferences(ctx, t.tx, actor.ID)
}

func (t *pgTx) UpdatePreferences(ctx context.Context, userID string, enabled, immediate, digest bool, updatedAt time.Time) error {
	result, err := t.tx.Exec(ctx, `UPDATE user_notification_preferences SET enabled = $2, immediate_enabled = $3, digest_enabled = $4, updated_at = $5 WHERE user_id = $1`, userID, boolInt(enabled), boolInt(immediate), boolInt(digest), normalizeTime(updatedAt))
	if err != nil {
		return internalError("update email preferences", err)
	}
	if result.RowsAffected() != 1 {
		return internalError("update email preferences", errors.New("preference row is missing"))
	}
	return nil
}

func (t *pgTx) UpsertSpaceSettings(ctx context.Context, input SpaceSettingsWrite) error {
	if strings.TrimSpace(input.PasswordCiphertext) == "" {
		input.PasswordCiphertext = ""
	}
	_, err := t.tx.Exec(ctx, `
		INSERT INTO space_email_settings (
			space_id, enabled, smtp_host, smtp_port, encryption, username, from_address, from_name,
			password_ciphertext, active_from, last_tested_at, last_test_status, last_test_error_code,
			updated_by, updated_at
		) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7, $8, NULLIF($9, ''), $10, $11, NULLIF($12, ''), NULLIF($13, ''), $14, $15)
		ON CONFLICT (space_id) DO UPDATE SET
			enabled = excluded.enabled, smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port,
			encryption = excluded.encryption, username = excluded.username, from_address = excluded.from_address,
			from_name = excluded.from_name, password_ciphertext = excluded.password_ciphertext,
			active_from = excluded.active_from, last_tested_at = excluded.last_tested_at,
			last_test_status = excluded.last_test_status, last_test_error_code = excluded.last_test_error_code,
			updated_by = excluded.updated_by, updated_at = excluded.updated_at
	`, input.SpaceID, boolInt(input.Enabled), input.SMTPHost, input.SMTPPort, input.Encryption,
		input.Username, input.FromAddress, input.FromName, input.PasswordCiphertext, nullableTime(input.ActiveFrom),
		nullableTime(input.LastTestedAt), input.LastTestStatus, input.LastTestErrorCode, input.UpdatedBy, normalizeTime(input.UpdatedAt))
	if err != nil {
		return internalError("save email settings", err)
	}
	return nil
}

func (t *pgTx) CancelPendingJobs(ctx context.Context, userID string, cancelledAt time.Time) error {
	return cancelPendingJobs(ctx, t.tx, userID, cancelledAt)
}

func (t *pgTx) CancelAllJobs(ctx context.Context, cancelledAt time.Time) error {
	_, err := t.tx.Exec(ctx, `UPDATE workspace_email_jobs SET status = 'cancelled', cancelled_at = $1, lease_until = NULL WHERE status IN ('pending', 'sending')`, normalizeTime(cancelledAt))
	if err != nil {
		return internalError("cancel email jobs", err)
	}
	return nil
}

func (t *pgTx) DeleteAllDigestStates(ctx context.Context) error {
	_, err := t.tx.Exec(ctx, `DELETE FROM workspace_email_digest_states`)
	if err != nil {
		return internalError("delete email digest states", err)
	}
	return nil
}

func (t *pgTx) DeleteUserDigestState(ctx context.Context, userID string) error {
	_, err := t.tx.Exec(ctx, `DELETE FROM workspace_email_digest_states WHERE user_id = $1`, userID)
	if err != nil {
		return internalError("delete email digest state", err)
	}
	return nil
}

func (t *pgTx) ConsumeChallenges(ctx context.Context, userID string, consumedAt time.Time) error {
	_, err := t.tx.Exec(ctx, `UPDATE notification_email_challenges SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL`, userID, normalizeTime(consumedAt))
	if err != nil {
		return internalError("consume email challenges", err)
	}
	return nil
}

func (t *pgTx) InsertChallenge(ctx context.Context, input ChallengeInsert) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO notification_email_challenges (id, user_id, pending_email, code_hash, attempts, created_at, expires_at, consumed_at) VALUES ($1, $2, $3, $4, 0, $5, $6, NULL)`, input.ID, input.UserID, input.PendingEmail, input.CodeHash, normalizeTime(input.CreatedAt), normalizeTime(input.ExpiresAt))
	if err != nil {
		return internalError("insert email challenge", err)
	}
	return nil
}

func (t *pgTx) IncrementChallengeAttempt(ctx context.Context, id string, now time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE notification_email_challenges SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2 AND attempts < $3`, id, normalizeTime(now), MaximumCodeAttempts)
	if err != nil {
		return false, internalError("increment email challenge attempt", err)
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) ConfirmChallenge(ctx context.Context, id, userID, pendingEmail string, verifiedAt, now time.Time) error {
	result, err := t.tx.Exec(ctx, `UPDATE notification_email_challenges SET consumed_at = $4 WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL AND expires_at > $3 AND attempts < $5`, id, userID, normalizeTime(now), normalizeTime(verifiedAt), MaximumCodeAttempts)
	if err != nil {
		return internalError("consume email challenge", err)
	}
	if result.RowsAffected() != 1 {
		return newError(CodeVerificationInvalid, MessageVerificationInvalid, 400)
	}
	result, err = t.tx.Exec(ctx, `UPDATE user_notification_preferences SET email = $2, email_source = 'custom', email_verified_at = $3, updated_at = $3 WHERE user_id = $1`, userID, pendingEmail, normalizeTime(verifiedAt))
	if err != nil {
		return internalError("save verified email", err)
	}
	if result.RowsAffected() != 1 {
		return internalError("save verified email", errors.New("preference row is missing"))
	}
	return nil
}

func (t *pgTx) UseGitHubEmail(ctx context.Context, userID, email string, updatedAt time.Time) error {
	result, err := t.tx.Exec(ctx, `UPDATE user_notification_preferences SET email = $2, email_source = 'github', email_verified_at = $3, updated_at = $3 WHERE user_id = $1`, userID, email, normalizeTime(updatedAt))
	if err != nil {
		return internalError("use GitHub email", err)
	}
	if result.RowsAffected() != 1 {
		return internalError("use GitHub email", errors.New("preference row is missing"))
	}
	return nil
}

func (t *pgTx) SyncGitHubEmail(ctx context.Context, userID, email string, updatedAt time.Time) error {
	_, err := t.tx.Exec(ctx, `UPDATE user_notification_preferences SET email = $2, email_verified_at = $3, updated_at = $3 WHERE user_id = $1 AND email_source = 'github'`, userID, email, normalizeTime(updatedAt))
	if err != nil {
		return internalError("sync GitHub email", err)
	}
	return nil
}

func (t *pgTx) InsertJob(ctx context.Context, input JobInsert) (bool, error) {
	id := strings.TrimSpace(input.ID)
	if id == "" {
		var err error
		id, err = t.newID("email job")
		if err != nil {
			return false, err
		}
	}
	result, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_email_jobs (
			id, user_id, message_id, conversation_id, event_seq, status, available_at,
			next_attempt_at, lease_until, attempt_count, sent_at, cancelled_at, last_error_code, created_at
		) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, NULL, 0, NULL, NULL, NULL, $8)
		ON CONFLICT (user_id, message_id) DO NOTHING
	`, id, input.UserID, input.MessageID, input.ConversationID, input.EventSeq, normalizeTime(input.AvailableAt), normalizeTime(input.NextAttemptAt), normalizeTime(input.CreatedAt))
	if err != nil {
		return false, internalError("insert email job", err)
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) InsertDigestState(ctx context.Context, input DigestInsert) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_email_digest_states (user_id, started_at, notified_at, lease_until, attempt_count, next_attempt_at, last_error_code, updated_at)
		VALUES ($1, $2, NULL, NULL, 0, $3, NULL, $4)
		ON CONFLICT (user_id) DO NOTHING
	`, input.UserID, normalizeTime(input.StartedAt), normalizeTime(input.NextAttemptAt), normalizeTime(input.UpdatedAt))
	if err != nil {
		return false, internalError("insert email digest state", err)
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID("email audit")
		if err != nil {
			return err
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" || strings.TrimSpace(input.Result) == "" || input.CreatedAt.IsZero() {
		return errors.New("email audit fields are required")
	}
	meta := input.Meta.Safe()
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, ip_address, user_agent, request_id, created_at) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, input.Result, safeReason(input.Reason), meta.IPAddress, meta.UserAgent, meta.RequestID, normalizeTime(input.CreatedAt))
	if err != nil {
		return internalError("write email audit", err)
	}
	return nil
}

func (t *pgTx) newID(operation string) (string, error) {
	if t == nil || t.idFactory == nil {
		return "", internalError("generate "+operation+" id", errors.New("id factory is required"))
	}
	id, err := t.idFactory()
	if err != nil || strings.TrimSpace(id) == "" {
		if err == nil {
			err = errors.New("id factory returned an empty id")
		}
		return "", internalError("generate "+operation+" id", err)
	}
	return strings.TrimSpace(id), nil
}

func lookupActor(ctx context.Context, queryer pgQueryer, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email *string
	var joinedAt time.Time
	err := queryer.QueryRow(ctx, `
		SELECT u.id, u.github_id, u.github_login, u.email, u.display_name, u.kind, sm.role, sm.joined_at
		FROM users u INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = $2 AND sm.removed_at IS NULL
		WHERE u.id = $1
	`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName, &actor.Kind, &actor.Role, &joinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("lookup email actor", err)
	}
	actor.GitHubID = stringValue(githubID)
	actor.Email = stringValue(email)
	actor.JoinedAt = normalizeTime(joinedAt)
	return &actor, nil
}

func getPreferences(ctx context.Context, queryer pgQueryer, userID string) (*PreferenceRecord, error) {
	var record PreferenceRecord
	var email *string
	var verified *time.Time
	err := queryer.QueryRow(ctx, `SELECT user_id, email, email_source, email_verified_at, enabled = 1, immediate_enabled = 1, digest_enabled = 1, updated_at FROM user_notification_preferences WHERE user_id = $1`, userID).Scan(&record.UserID, &email, &record.EmailSource, &verified, &record.Enabled, &record.Immediate, &record.Digest, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get email preferences", err)
	}
	record.Email = email
	record.EmailVerifiedAt = verified
	record.UpdatedAt = normalizeTime(record.UpdatedAt)
	if verified != nil {
		value := normalizeTime(*verified)
		record.EmailVerifiedAt = &value
	}
	return &record, nil
}

func getSpaceSettings(ctx context.Context, queryer pgQueryer, spaceID string) (*SMTPSettingsRecord, error) {
	var record SMTPSettingsRecord
	var username, password, lastStatus, lastError *string
	var activeFrom, testedAt *time.Time
	err := queryer.QueryRow(ctx, `SELECT space_id, enabled = 1, smtp_host, smtp_port, encryption, username, from_address, from_name, password_ciphertext, active_from, last_tested_at, last_test_status, last_test_error_code, updated_at FROM space_email_settings WHERE space_id = $1`, spaceID).Scan(&record.SpaceID, &record.Enabled, &record.SMTPHost, &record.SMTPPort, &record.Encryption, &username, &record.FromAddress, &record.FromName, &password, &activeFrom, &testedAt, &lastStatus, &lastError, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get email settings", err)
	}
	record.Username = stringValue(username)
	record.PasswordCiphertext = stringValue(password)
	record.ActiveFrom = normalizeTimePtr(activeFrom)
	record.LastTestedAt = normalizeTimePtr(testedAt)
	record.LastTestStatus = lastStatus
	record.LastTestErrorCode = lastError
	record.UpdatedAt = normalizeTime(record.UpdatedAt)
	return &record, nil
}

func countSMTPTests(ctx context.Context, queryer pgQueryer, userID string, since time.Time) (int, error) {
	var count int
	if err := queryer.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = $1 AND action = 'email.smtp_test' AND created_at >= $2`, userID, normalizeTime(since)).Scan(&count); err != nil {
		return 0, internalError("count SMTP tests", err)
	}
	return count, nil
}

func countRecentChallenges(ctx context.Context, queryer pgQueryer, userID string, since time.Time) (int, *time.Time, error) {
	var count int
	var latest *time.Time
	if err := queryer.QueryRow(ctx, `SELECT COUNT(*), MAX(created_at) FROM notification_email_challenges WHERE user_id = $1 AND created_at >= $2`, userID, normalizeTime(since)).Scan(&count, &latest); err != nil {
		return 0, nil, internalError("count email challenges", err)
	}
	return count, normalizeTimePtr(latest), nil
}

func getChallenge(ctx context.Context, queryer pgQueryer, userID, id string) (*ChallengeRecord, error) {
	var record ChallengeRecord
	var consumed *time.Time
	err := queryer.QueryRow(ctx, `SELECT id, user_id, pending_email, code_hash, attempts, created_at, expires_at, consumed_at FROM notification_email_challenges WHERE user_id = $1 AND id = $2`, userID, id).Scan(&record.ID, &record.UserID, &record.PendingEmail, &record.CodeHash, &record.Attempts, &record.CreatedAt, &record.ExpiresAt, &consumed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get email challenge", err)
	}
	record.CreatedAt = normalizeTime(record.CreatedAt)
	record.ExpiresAt = normalizeTime(record.ExpiresAt)
	record.ConsumedAt = normalizeTimePtr(consumed)
	return &record, nil
}

func listRecipients(ctx context.Context, queryer pgQueryer, query ScheduleRecipientQuery) ([]RecipientRecord, error) {
	var rows pgx.Rows
	var err error
	if strings.TrimSpace(query.TopicID) != "" {
		rows, err = queryer.Query(ctx, `SELECT tm.user_id, COALESCE(tm.notification_level, 'all') FROM topic_members tm INNER JOIN conversation_members cm ON cm.conversation_id = $1 AND cm.user_id = tm.user_id AND cm.removed_at IS NULL INNER JOIN space_members sm ON sm.space_id = $2 AND sm.user_id = tm.user_id AND sm.removed_at IS NULL INNER JOIN users u ON u.id = tm.user_id AND u.kind = 'human' WHERE tm.topic_id = $3 AND tm.left_at IS NULL AND tm.user_id <> $4 ORDER BY tm.user_id ASC`, query.ConversationID, query.SpaceID, query.TopicID, query.AuthorID)
	} else {
		rows, err = queryer.Query(ctx, `SELECT cm.user_id, COALESCE(cm.notification_level, 'all') FROM conversation_members cm INNER JOIN space_members sm ON sm.space_id = $1 AND sm.user_id = cm.user_id AND sm.removed_at IS NULL INNER JOIN users u ON u.id = cm.user_id AND u.kind = 'human' WHERE cm.conversation_id = $2 AND cm.removed_at IS NULL AND cm.user_id <> $3 ORDER BY cm.user_id ASC`, query.SpaceID, query.ConversationID, query.AuthorID)
	}
	if err != nil {
		return nil, internalError("list email recipients", err)
	}
	defer rows.Close()
	items := make([]RecipientRecord, 0)
	for rows.Next() {
		var item RecipientRecord
		if err := rows.Scan(&item.UserID, &item.NotificationLevel); err != nil {
			return nil, internalError("scan email recipients", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list email recipients", err)
	}
	return items, nil
}

func listDueJobs(ctx context.Context, queryer pgQueryer, spaceID string, now time.Time, limit int) ([]string, error) {
	if limit <= 0 || limit > MaximumJobBatchSize {
		limit = DefaultJobBatchSize
	}
	rows, err := queryer.Query(ctx, `SELECT j.id FROM workspace_email_jobs j INNER JOIN conversations c ON c.id = j.conversation_id WHERE c.space_id = $1 AND j.status IN ('pending', 'sending') AND j.next_attempt_at <= $2 AND (j.lease_until IS NULL OR j.lease_until <= $2) ORDER BY j.next_attempt_at ASC, j.id ASC LIMIT $3`, spaceID, normalizeTime(now), limit)
	if err != nil {
		return nil, internalError("list due email jobs", err)
	}
	defer rows.Close()
	items := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, internalError("scan due email job", err)
		}
		items = append(items, id)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list due email jobs", err)
	}
	return items, nil
}

func getDeliveryJob(ctx context.Context, queryer pgQueryer, id string) (*DeliveryJob, error) {
	var job DeliveryJob
	var email *string
	var verified *time.Time
	var lastReadSeq *int64
	var lastReadAt *time.Time
	var content string
	err := queryer.QueryRow(ctx, `
		SELECT j.id, j.user_id, j.message_id, j.conversation_id, j.event_seq, j.attempt_count,
			p.email, p.email_verified_at, p.enabled = 1, p.immediate_enabled = 1,
			COALESCE(CASE WHEN m.topic_id IS NOT NULL THEN tm.notification_level ELSE cm.notification_level END, 'all'),
			CASE WHEN m.topic_id IS NOT NULL THEN tm.last_read_seq ELSE cm.last_read_seq END,
			CASE WHEN m.topic_id IS NOT NULL THEN topic_read_message.created_at ELSE cm.last_read_at END,
			m.created_at, m.content_json
		FROM workspace_email_jobs j
		INNER JOIN user_notification_preferences p ON p.user_id = j.user_id
		INNER JOIN messages m ON m.id = j.message_id AND m.deleted_at IS NULL AND m.recalled_at IS NULL
		INNER JOIN conversations c ON c.id = j.conversation_id
		INNER JOIN conversation_members cm ON cm.conversation_id = j.conversation_id AND cm.user_id = j.user_id AND cm.removed_at IS NULL
		LEFT JOIN topic_members tm ON tm.topic_id = m.topic_id AND tm.user_id = j.user_id AND tm.left_at IS NULL
		LEFT JOIN messages topic_read_message ON topic_read_message.id = tm.last_read_message_id AND topic_read_message.topic_id = m.topic_id
		INNER JOIN space_members sm ON sm.user_id = j.user_id AND sm.space_id = c.space_id AND sm.removed_at IS NULL
		WHERE j.id = $1 AND j.status = 'sending' AND (m.topic_id IS NULL OR tm.user_id IS NOT NULL)
	`, id).Scan(&job.ID, &job.UserID, &job.MessageID, &job.ConversationID, &job.EventSeq, &job.AttemptCount, &email, &verified, &job.PreferenceEnabled, &job.ImmediateEnabled, &job.NotificationLevel, &lastReadSeq, &lastReadAt, &job.MessageCreatedAt, &content)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get email delivery job", err)
	}
	job.Email = stringValue(email)
	job.EmailVerifiedAt = normalizeTimePtr(verified)
	job.LastReadSeq = lastReadSeq
	job.LastReadAt = normalizeTimePtr(lastReadAt)
	job.MessageCreatedAt = normalizeTime(job.MessageCreatedAt)
	job.ContentJSON = []byte(content)
	return &job, nil
}

func listDigestStates(ctx context.Context, queryer pgQueryer, spaceID string, now time.Time, limit int) ([]DigestState, error) {
	if limit <= 0 || limit > MaximumJobBatchSize {
		limit = DefaultJobBatchSize
	}
	rows, err := queryer.Query(ctx, `SELECT d.user_id, d.started_at, d.notified_at, d.attempt_count, d.next_attempt_at FROM workspace_email_digest_states d INNER JOIN space_members sm ON sm.user_id = d.user_id AND sm.space_id = $1 AND sm.removed_at IS NULL WHERE d.lease_until IS NULL OR d.lease_until <= $2 ORDER BY d.started_at ASC, d.user_id ASC LIMIT $3`, spaceID, normalizeTime(now), limit)
	if err != nil {
		return nil, internalError("list email digest states", err)
	}
	defer rows.Close()
	items := make([]DigestState, 0, limit)
	for rows.Next() {
		var state DigestState
		if err := rows.Scan(&state.UserID, &state.StartedAt, &state.NotifiedAt, &state.AttemptCount, &state.NextAttemptAt); err != nil {
			return nil, internalError("scan email digest state", err)
		}
		state.StartedAt = normalizeTime(state.StartedAt)
		state.NotifiedAt = normalizeTimePtr(state.NotifiedAt)
		state.NextAttemptAt = normalizeTime(state.NextAttemptAt)
		items = append(items, state)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list email digest states", err)
	}
	return items, nil
}

func listEligibleUnreadMessages(ctx context.Context, queryer pgQueryer, spaceID, userID string, startedAt time.Time) ([]UnreadMessage, error) {
	rows, err := queryer.Query(ctx, `
		SELECT m.id, m.author_id, m.created_at, m.content_json,
			COALESCE(we.seq, 0),
			COALESCE(CASE WHEN m.topic_id IS NOT NULL THEN tm.notification_level ELSE cm.notification_level END, 'all'),
			CASE WHEN m.topic_id IS NOT NULL THEN tm.last_read_seq ELSE cm.last_read_seq END,
			CASE WHEN m.topic_id IS NOT NULL THEN topic_read_message.created_at ELSE cm.last_read_at END
		FROM messages m
		INNER JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
		LEFT JOIN topic_members tm ON tm.topic_id = m.topic_id AND tm.user_id = $1 AND tm.left_at IS NULL
		LEFT JOIN messages topic_read_message ON topic_read_message.id = tm.last_read_message_id AND topic_read_message.topic_id = m.topic_id
		INNER JOIN conversations c ON c.id = m.conversation_id AND c.space_id = $2
		INNER JOIN space_members sm ON sm.user_id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
		LEFT JOIN workspace_events we ON we.type IN ('message.created', 'topic.message.created') AND we.target_id = m.id AND we.conversation_id = m.conversation_id
		WHERE m.created_at >= $3 AND m.deleted_at IS NULL AND m.recalled_at IS NULL AND m.kind IN ('user', 'bot')
			AND (m.author_id IS NULL OR m.author_id <> $1) AND (m.topic_id IS NULL OR tm.user_id IS NOT NULL)
		ORDER BY m.created_at ASC, m.id ASC
	`, userID, spaceID, normalizeTime(startedAt))
	if err != nil {
		return nil, internalError("list unread email messages", err)
	}
	defer rows.Close()
	items := make([]UnreadMessage, 0)
	for rows.Next() {
		var item UnreadMessage
		if err := rows.Scan(&item.ID, &item.AuthorID, &item.CreatedAt, &item.ContentJSON, &item.EventSeq, &item.NotificationLevel, &item.LastReadSeq, &item.LastReadAt); err != nil {
			return nil, internalError("scan unread email message", err)
		}
		item.CreatedAt = normalizeTime(item.CreatedAt)
		item.LastReadAt = normalizeTimePtr(item.LastReadAt)
		item.ContentJSON = append([]byte(nil), item.ContentJSON...)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list unread email messages", err)
	}
	return items, nil
}

func claimJob(ctx context.Context, queryer pgExecer, id string, leaseUntil, now time.Time) (bool, error) {
	result, err := queryer.Exec(ctx, `UPDATE workspace_email_jobs SET status = 'sending', lease_until = $2 WHERE id = $1 AND status IN ('pending', 'sending') AND next_attempt_at <= $3 AND (lease_until IS NULL OR lease_until <= $3)`, id, normalizeTime(leaseUntil), normalizeTime(now))
	if err != nil {
		return false, internalError("claim email job", err)
	}
	return result.RowsAffected() == 1, nil
}

func markSent(ctx context.Context, queryer pgExecer, id string, sentAt time.Time) error {
	_, err := queryer.Exec(ctx, `UPDATE workspace_email_jobs SET status = 'sent', sent_at = $2, lease_until = NULL, last_error_code = NULL WHERE id = $1 AND status = 'sending'`, id, normalizeTime(sentAt))
	if err != nil {
		return internalError("mark email job sent", err)
	}
	return nil
}

func deferJob(ctx context.Context, queryer pgExecer, id string, nextAttemptAt time.Time) error {
	_, err := queryer.Exec(ctx, `UPDATE workspace_email_jobs SET status = 'pending', lease_until = NULL, next_attempt_at = $2 WHERE id = $1 AND status = 'sending'`, id, normalizeTime(nextAttemptAt))
	if err != nil {
		return internalError("defer email job", err)
	}
	return nil
}

func retryJob(ctx context.Context, queryer pgExecer, id string, attempt int, next time.Time, code string) error {
	_, err := queryer.Exec(ctx, `UPDATE workspace_email_jobs SET status = 'pending', attempt_count = $2, lease_until = NULL, next_attempt_at = $3, last_error_code = $4 WHERE id = $1 AND status = 'sending'`, id, attempt, normalizeTime(next), normalizeErrorCode(code))
	if err != nil {
		return internalError("retry email job", err)
	}
	return nil
}

func markFailed(ctx context.Context, queryer pgExecer, id string, attempt int, code string) error {
	_, err := queryer.Exec(ctx, `UPDATE workspace_email_jobs SET status = 'failed', attempt_count = $2, lease_until = NULL, last_error_code = $3 WHERE id = $1 AND status = 'sending'`, id, attempt, normalizeErrorCode(code))
	if err != nil {
		return internalError("fail email job", err)
	}
	return nil
}

func cancelJob(ctx context.Context, queryer pgExecer, id string, cancelledAt time.Time) error {
	_, err := queryer.Exec(ctx, `UPDATE workspace_email_jobs SET status = 'cancelled', cancelled_at = $2, lease_until = NULL WHERE id = $1 AND status IN ('pending', 'sending')`, id, normalizeTime(cancelledAt))
	if err != nil {
		return internalError("cancel email job", err)
	}
	return nil
}

func cancelPendingJobs(ctx context.Context, queryer pgExecer, userID string, cancelledAt time.Time) error {
	_, err := queryer.Exec(ctx, `UPDATE workspace_email_jobs SET status = 'cancelled', cancelled_at = $2, lease_until = NULL WHERE user_id = $1 AND status IN ('pending', 'sending')`, userID, normalizeTime(cancelledAt))
	if err != nil {
		return internalError("cancel email jobs", err)
	}
	return nil
}

func claimDigestState(ctx context.Context, queryer pgExecer, userID string, leaseUntil, now time.Time) (bool, error) {
	result, err := queryer.Exec(ctx, `UPDATE workspace_email_digest_states SET lease_until = $2 WHERE user_id = $1 AND notified_at IS NULL AND next_attempt_at <= $3 AND (lease_until IS NULL OR lease_until <= $3)`, userID, normalizeTime(leaseUntil), normalizeTime(now))
	if err != nil {
		return false, internalError("claim email digest state", err)
	}
	return result.RowsAffected() == 1, nil
}

func markDigestSent(ctx context.Context, queryer pgExecer, userID string, notifiedAt time.Time) error {
	_, err := queryer.Exec(ctx, `UPDATE workspace_email_digest_states SET notified_at = $2, lease_until = NULL, last_error_code = NULL, updated_at = $2 WHERE user_id = $1 AND notified_at IS NULL`, userID, normalizeTime(notifiedAt))
	if err != nil {
		return internalError("mark email digest sent", err)
	}
	return nil
}

func retryDigestState(ctx context.Context, queryer pgExecer, userID string, attempt int, next time.Time, code string, updatedAt time.Time) error {
	_, err := queryer.Exec(ctx, `UPDATE workspace_email_digest_states SET attempt_count = $2, lease_until = NULL, next_attempt_at = $3, last_error_code = $4, updated_at = $5 WHERE user_id = $1 AND notified_at IS NULL`, userID, attempt, normalizeTime(next), normalizeErrorCode(code), normalizeTime(updatedAt))
	if err != nil {
		return internalError("retry email digest state", err)
	}
	return nil
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

func timePtr(value time.Time) *time.Time { return &value }

func normalizeTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	result := normalizeTime(*value)
	return &result
}

func safeReason(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return ""
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f || r == '\n' || r == '\r' {
			return ""
		}
	}
	return value
}

func nullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return normalizeTime(*value)
}
