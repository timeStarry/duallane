package botgateway

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
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type pgQueryer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type PGRepository struct {
	pool              *pgxpool.Pool
	idFactory         func() (string, error)
	messageRepository *workspacemessages.PGRepository
	cardRepository    *workspacecards.PGRepository
}

// DomainTransactionOptions supplies the already-configured domain adapters to
// Bot Gateway's aggregate transaction. In particular, the message adapter
// retains its notification job scheduler; only typed domain Tx values cross
// this boundary.
type DomainTransactionOptions struct {
	Messages *workspacemessages.PGRepository
	Cards    *workspacecards.PGRepository
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

// NewPGRepositoryWithDomainTransactions is the additive constructor for
// production composition. The ordinary constructor remains valid for gateway
// read-only and isolated tests.
func NewPGRepositoryWithDomainTransactions(pool *pgxpool.Pool, domains DomainTransactionOptions, factories ...func() (string, error)) *PGRepository {
	repository := NewPGRepository(pool, factories...)
	repository.messageRepository = domains.Messages
	repository.cardRepository = domains.Cards
	return repository
}

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return internalError("ping bot gateway database", errors.New("workspace postgres pool is required"))
	}
	if err := r.pool.Ping(ctx); err != nil {
		return internalError("ping bot gateway database", err)
	}
	return nil
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin bot gateway transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin bot gateway transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin bot gateway transaction", err)
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
		return internalError("commit bot gateway transaction", err)
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupToken(ctx context.Context, tokenHash string, options TokenAuthOptions, now time.Time) (*Auth, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup bot token", errors.New("workspace postgres pool is required"))
	}
	value, err := lookupToken(ctx, r.pool, tokenHash, options, now)
	if err != nil || value == nil {
		return value, err
	}
	marked, err := r.pool.Exec(ctx, `
		UPDATE workspace_agent_bot_tokens t
		SET last_used_at = $1
		WHERE t.id = $2
		  AND t.revoked_at IS NULL
		  AND (t.expires_at IS NULL OR t.expires_at > $1)
		  AND EXISTS (
			SELECT 1 FROM workspace_agent_bots b
			WHERE b.id = t.bot_id AND b.status = 'active'
		  )
	`, now.UTC(), value.TokenID)
	if err != nil {
		return nil, internalError("mark bot token use", err)
	}
	if marked.RowsAffected() != 1 {
		return nil, nil
	}
	return value, nil
}

func (r *PGRepository) ValidateToken(ctx context.Context, tokenID, botID, spaceID string, now time.Time) (*Auth, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("validate bot token", errors.New("workspace postgres pool is required"))
	}
	return lookupAuth(ctx, r.pool, tokenID, botID, spaceID, now)
}

func lookupToken(ctx context.Context, queryer pgQueryer, tokenHash string, options TokenAuthOptions, now time.Time) (*Auth, error) {
	return scanAuth(queryer.QueryRow(ctx, `
		SELECT t.id, t.bot_id, t.space_id, t.scopes_json,
		       b.owner_user_id, b.bot_user_id, b.mode, b.name,
		       b.visibility_policy, b.conversation_policy, b.trigger_policy, b.status
		FROM workspace_agent_bot_tokens t
		JOIN workspace_agent_bots b ON b.id = t.bot_id AND b.space_id = t.space_id
		JOIN users bu ON bu.id = b.bot_user_id AND bu.kind = 'bot'
		WHERE t.token_hash = $1
		  AND ($2 = '' OR t.space_id = $2)
		  AND t.revoked_at IS NULL
		  AND (t.expires_at IS NULL OR t.expires_at > $3)
		  AND b.status = 'active'
	`, tokenHash, strings.TrimSpace(options.SpaceID), now.UTC()))
}

func lookupAuth(ctx context.Context, queryer pgQueryer, tokenID, botID, spaceID string, now time.Time) (*Auth, error) {
	return lookupAuthWithLock(ctx, queryer, tokenID, botID, spaceID, now, false)
}

func lookupAuthForMutation(ctx context.Context, queryer pgQueryer, tokenID, botID, spaceID string, now time.Time) (*Auth, error) {
	return lookupAuthWithLock(ctx, queryer, tokenID, botID, spaceID, now, true)
}

func lookupAuthWithLock(ctx context.Context, queryer pgQueryer, tokenID, botID, spaceID string, now time.Time, lock bool) (*Auth, error) {
	query := `
		SELECT t.id, t.bot_id, t.space_id, t.scopes_json,
		       b.owner_user_id, b.bot_user_id, b.mode, b.name,
		       b.visibility_policy, b.conversation_policy, b.trigger_policy, b.status
		FROM workspace_agent_bot_tokens t
		JOIN workspace_agent_bots b ON b.id = t.bot_id AND b.space_id = t.space_id
		JOIN users bu ON bu.id = b.bot_user_id AND bu.kind = 'bot'
		WHERE t.id = $1 AND t.bot_id = $2 AND t.space_id = $3
		  AND t.revoked_at IS NULL
		  AND (t.expires_at IS NULL OR t.expires_at > $4)
		  AND b.status = 'active'
	`
	if lock {
		query += ` FOR UPDATE OF t, b`
	}
	return scanAuth(queryer.QueryRow(ctx, query, tokenID, botID, spaceID, now.UTC()))
}

func scanAuth(row pgx.Row) (*Auth, error) {
	var value Auth
	var scopesJSON string
	if err := row.Scan(&value.TokenID, &value.BotID, &value.SpaceID, &scopesJSON,
		&value.OwnerUserID, &value.UserID, &value.Bot.Mode, &value.Bot.Name,
		&value.Bot.VisibilityPolicy, &value.Bot.ConversationPolicy, &value.Bot.TriggerPolicy, &value.Bot.Status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, internalError("scan bot token", err)
	}
	value.Bot.ID = value.BotID
	value.Bot.BotUserID = value.UserID
	value.Bot.OwnerUserID = value.OwnerUserID
	value.Bot.SpaceID = value.SpaceID
	value.Scopes = parseScopes(scopesJSON)
	return &value, nil
}

func parseScopes(raw string) []string {
	var scopes []string
	if json.Unmarshal([]byte(raw), &scopes) != nil {
		return []string{}
	}
	return normalizeScopes(scopes)
}

func (r *PGRepository) GetSettings(ctx context.Context, botID, spaceID string) (*Settings, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot gateway settings", errors.New("workspace postgres pool is required"))
	}
	return getSettings(ctx, r.pool, botID, spaceID)
}

func getSettings(ctx context.Context, queryer pgQueryer, botID, spaceID string) (*Settings, error) {
	var value Settings
	err := queryer.QueryRow(ctx, `
		SELECT visibility_policy, allow_direct = 1, allow_group = 1,
		       group_inviter_policy, require_owner_approval = 1, proactive_enabled = 1,
		       trigger_policy, COALESCE(welcome_message, ''), COALESCE(description, ''),
		       COALESCE(avatar_url, ''), show_creator = 1,
		       max_context_messages, max_context_chars, max_context_tokens,
		       context_window_seconds, include_replies = 1, include_system_events = 1,
		       include_attachment_metadata = 1, allow_attachment_preview = 1,
		       long_term_summary_enabled = 1
		FROM workspace_agent_bot_settings
		WHERE bot_id = $1 AND space_id = $2
	`, botID, spaceID).Scan(&value.VisibilityPolicy, &value.AllowDirect, &value.AllowGroup,
		&value.GroupInviterPolicy, &value.RequireOwnerApproval, &value.ProactiveEnabled,
		&value.TriggerPolicy, &value.WelcomeMessage, &value.Description, &value.AvatarURL,
		&value.ShowCreator, &value.MaxContextMessages, &value.MaxContextChars,
		&value.MaxContextTokens, &value.ContextWindowSeconds, &value.IncludeReplies,
		&value.IncludeSystemEvents, &value.IncludeAttachmentMetadata, &value.AllowAttachmentPreview,
		&value.LongTermSummaryEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot gateway settings", err)
	}
	return &value, nil
}

func (r *PGRepository) GetConnection(ctx context.Context, botID, spaceID string) (*Connection, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot gateway connection", errors.New("workspace postgres pool is required"))
	}
	return getConnection(ctx, r.pool, botID, spaceID)
}

func (r *PGRepository) RegisterConnection(ctx context.Context, input ConnectionRegistrationRecord) error {
	if r == nil || r.pool == nil {
		return internalError("register bot gateway connection", errors.New("workspace postgres pool is required"))
	}
	id := strings.TrimSpace(input.ID)
	if id == "" {
		generated, err := r.idFactory()
		if err != nil || strings.TrimSpace(generated) == "" {
			if err == nil {
				err = errors.New("connection id factory returned an empty id")
			}
			return internalError("generate bot gateway connection id", err)
		}
		id = generated
	}
	status := strings.TrimSpace(input.Status)
	if status == "" {
		status = "connected"
	}
	adapterVersion := any(nil)
	if strings.TrimSpace(input.AdapterVersion) != "" {
		adapterVersion = strings.TrimSpace(input.AdapterVersion)
	}
	updatedAt := input.UpdatedAt.UTC()
	if updatedAt.IsZero() {
		updatedAt = time.Now().UTC()
	}
	connectedAt := input.ConnectedAt.UTC()
	heartbeatAt := input.HeartbeatAt.UTC()
	if connectedAt.IsZero() {
		connectedAt = updatedAt
	}
	if heartbeatAt.IsZero() {
		heartbeatAt = updatedAt
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO workspace_agent_bot_connections (
			id, bot_id, space_id, status, adapter_version, connection_nonce,
			connected_at, disconnected_at, last_heartbeat_at, last_error_code,
			last_error_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, NULL, NULL, $9)
		ON CONFLICT (bot_id) DO UPDATE SET
			space_id = EXCLUDED.space_id,
			status = EXCLUDED.status,
			adapter_version = EXCLUDED.adapter_version,
			connection_nonce = EXCLUDED.connection_nonce,
			connected_at = EXCLUDED.connected_at,
			disconnected_at = NULL,
			last_heartbeat_at = EXCLUDED.last_heartbeat_at,
			last_error_code = NULL,
			last_error_at = NULL,
			updated_at = EXCLUDED.updated_at
	`, id, strings.TrimSpace(input.BotID), strings.TrimSpace(input.SpaceID), status, adapterVersion, strings.TrimSpace(input.Nonce), connectedAt, heartbeatAt, updatedAt)
	if err != nil {
		return internalError("register bot gateway connection", err)
	}
	return nil
}

func (r *PGRepository) HeartbeatConnection(ctx context.Context, botID, spaceID, nonce string, at time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("heartbeat bot gateway connection", errors.New("workspace postgres pool is required"))
	}
	tag, err := r.pool.Exec(ctx, `
		UPDATE workspace_agent_bot_connections
		SET last_heartbeat_at = $1, updated_at = $1
		WHERE bot_id = $2 AND space_id = $3 AND connection_nonce = $4 AND status = 'connected'
	`, at.UTC(), strings.TrimSpace(botID), strings.TrimSpace(spaceID), strings.TrimSpace(nonce))
	if err != nil {
		return internalError("heartbeat bot gateway connection", err)
	}
	if tag.RowsAffected() != 1 {
		return NewError(CodeInvalidRequest, MessageInvalidMessage, 400)
	}
	return nil
}

func (r *PGRepository) DisconnectConnection(ctx context.Context, botID, spaceID, nonce string, at time.Time) error {
	if r == nil || r.pool == nil {
		return internalError("disconnect bot gateway connection", errors.New("workspace postgres pool is required"))
	}
	_, err := r.pool.Exec(ctx, `
		UPDATE workspace_agent_bot_connections
		SET status = 'disconnected', disconnected_at = $1, updated_at = $1
		WHERE bot_id = $2 AND space_id = $3 AND connection_nonce = $4
	`, at.UTC(), strings.TrimSpace(botID), strings.TrimSpace(spaceID), strings.TrimSpace(nonce))
	if err != nil {
		return internalError("disconnect bot gateway connection", err)
	}
	return nil
}

func getConnection(ctx context.Context, queryer pgQueryer, botID, spaceID string) (*Connection, error) {
	var value Connection
	var adapterVersion, errorCode *string
	var connectedAt, disconnectedAt, heartbeatAt, processedAt, errorAt *time.Time
	var updatedAt time.Time
	err := queryer.QueryRow(ctx, `
		SELECT status, adapter_version, connected_at, disconnected_at, last_heartbeat_at,
		       last_processed_at, last_error_code, last_error_at, updated_at
		FROM workspace_agent_bot_connections
		WHERE bot_id = $1 AND space_id = $2
	`, botID, spaceID).Scan(&value.Status, &adapterVersion, &connectedAt, &disconnectedAt, &heartbeatAt, &processedAt, &errorCode, &errorAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot gateway connection", err)
	}
	value.AdapterVersion = adapterVersion
	value.ConnectedAt = timestampPointer(connectedAt)
	value.DisconnectedAt = timestampPointer(disconnectedAt)
	value.LastHeartbeatAt = timestampPointer(heartbeatAt)
	value.LastProcessedAt = timestampPointer(processedAt)
	value.LastErrorCode = errorCode
	value.LastErrorAt = timestampPointer(errorAt)
	value.UpdatedAt = timestamp(updatedAt)
	return &value, nil
}

func (r *PGRepository) GetConversation(ctx context.Context, spaceID, conversationID string) (*Conversation, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot gateway conversation", errors.New("workspace postgres pool is required"))
	}
	return getConversation(ctx, r.pool, spaceID, conversationID)
}

func getConversation(ctx context.Context, queryer pgQueryer, spaceID, conversationID string) (*Conversation, error) {
	var value Conversation
	err := queryer.QueryRow(ctx, `
		SELECT id, space_id, type, title, retention_count, created_at
		FROM conversations WHERE id = $1 AND space_id = $2
	`, conversationID, spaceID).Scan(&value.ID, &value.SpaceID, &value.Type, &value.Title, &value.RetentionCount, &value.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot gateway conversation", err)
	}
	value.CreatedAt = value.CreatedAt.UTC()
	return &value, nil
}

func (r *PGRepository) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check bot conversation membership", errors.New("workspace postgres pool is required"))
	}
	return conversationMemberActive(ctx, r.pool, spaceID, conversationID, userID)
}

func conversationMemberActive(ctx context.Context, queryer pgQueryer, spaceID, conversationID, userID string) (bool, error) {
	var active bool
	err := queryer.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members cm
			JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
			WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
		)
	`, spaceID, conversationID, userID).Scan(&active)
	if err != nil {
		return false, internalError("check bot conversation membership", err)
	}
	return active, nil
}

func (r *PGRepository) GetGroupPolicy(ctx context.Context, botID, spaceID, conversationID string) (*GroupPolicy, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot group policy", errors.New("workspace postgres pool is required"))
	}
	return getGroupPolicy(ctx, r.pool, botID, spaceID, conversationID)
}

func getGroupPolicy(ctx context.Context, queryer pgQueryer, botID, spaceID, conversationID string) (*GroupPolicy, error) {
	var value GroupPolicy
	err := queryer.QueryRow(ctx, `
		SELECT status FROM workspace_agent_bot_group_policies
		WHERE bot_id = $1 AND space_id = $2 AND conversation_id = $3
	`, botID, spaceID, conversationID).Scan(&value.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot group policy", err)
	}
	return &value, nil
}

func (r *PGRepository) GetContextGrant(ctx context.Context, botID, spaceID, conversationID string) (*ContextGrant, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot context grant", errors.New("workspace postgres pool is required"))
	}
	return getContextGrant(ctx, r.pool, botID, spaceID, conversationID)
}

func getContextGrant(ctx context.Context, queryer pgQueryer, botID, spaceID, conversationID string) (*ContextGrant, error) {
	var value ContextGrant
	var maxMessages *int
	err := queryer.QueryRow(ctx, `
		SELECT allow_trigger = 1, allow_context = 1, max_messages
		FROM workspace_agent_bot_context_grants
		WHERE bot_id = $1 AND space_id = $2 AND conversation_id = $3
	`, botID, spaceID, conversationID).Scan(&value.AllowTrigger, &value.AllowContext, &maxMessages)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot context grant", err)
	}
	value.MaxMessages = maxMessages
	return &value, nil
}

func (r *PGRepository) ListContextMessages(ctx context.Context, spaceID, conversationID string, since time.Time, includeReplies, includeSystemEvents bool, limit int) ([]ContextMessageRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list bot context messages", errors.New("workspace postgres pool is required"))
	}
	return listContextMessages(ctx, r.pool, spaceID, conversationID, since, includeReplies, includeSystemEvents, limit)
}

func listContextMessages(ctx context.Context, queryer pgQueryer, spaceID, conversationID string, since time.Time, includeReplies, includeSystemEvents bool, limit int) ([]ContextMessageRecord, error) {
	limit = boundedLimit(limit, 50, MaxReplayLimit)
	query := `
		SELECT id, conversation_id, author_id, author_kind, kind, content_format,
		       content_json, plain_text, reply_to_message_id, created_at
		FROM messages
		WHERE space_id = $1 AND conversation_id = $2 AND deleted_at IS NULL AND created_at >= $3
	`
	args := []any{spaceID, conversationID, since.UTC()}
	if !includeReplies {
		query += ` AND reply_to_message_id IS NULL`
	}
	if !includeSystemEvents {
		query += ` AND kind <> 'system' AND author_kind <> 'system'`
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT $4`
	args = append(args, limit)
	rows, err := queryer.Query(ctx, query, args...)
	if err != nil {
		return nil, internalError("list bot context messages", err)
	}
	defer rows.Close()
	result := make([]ContextMessageRecord, 0, limit)
	for rows.Next() {
		var value ContextMessageRecord
		var contentJSON string
		if err := rows.Scan(&value.ID, &value.ConversationID, &value.AuthorID, &value.AuthorKind, &value.Kind, &value.ContentFormat, &contentJSON, &value.PlainText, &value.ReplyToMessageID, &value.CreatedAt); err != nil {
			return nil, internalError("scan bot context message", err)
		}
		value.ContentJSON = []byte(contentJSON)
		value.CreatedAt = value.CreatedAt.UTC()
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list bot context messages", err)
	}
	return result, nil
}

func (r *PGRepository) GetAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot attachment", errors.New("workspace postgres pool is required"))
	}
	return getAttachment(ctx, r.pool, spaceID, attachmentID)
}

func getAttachment(ctx context.Context, queryer pgQueryer, spaceID, attachmentID string) (*AttachmentRecord, error) {
	var value AttachmentRecord
	err := queryer.QueryRow(ctx, `
		SELECT id, space_id, uploader_id, conversation_id, visibility, status,
		       file_name, mime_type, byte_size, created_at, completed_at
		FROM attachments WHERE id = $1 AND space_id = $2
	`, attachmentID, spaceID).Scan(&value.ID, &value.SpaceID, &value.UploaderID, &value.ConversationID, &value.Visibility, &value.Status, &value.FileName, &value.MIMEType, &value.ByteSize, &value.CreatedAt, &value.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot attachment", err)
	}
	value.CreatedAt = value.CreatedAt.UTC()
	if value.CompletedAt != nil {
		completed := value.CompletedAt.UTC()
		value.CompletedAt = &completed
	}
	return &value, nil
}

func (r *PGRepository) CurrentSequence(ctx context.Context, spaceID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("read bot event cursor", errors.New("workspace postgres pool is required"))
	}
	return currentSequence(ctx, r.pool, spaceID)
}

func currentSequence(ctx context.Context, queryer pgQueryer, spaceID string) (int64, error) {
	var sequence int64
	err := queryer.QueryRow(ctx, `
		SELECT GREATEST(
			COALESCE((SELECT next_seq - 1 FROM workspace_event_cursors WHERE space_id = $1), 0),
			COALESCE((SELECT MAX(seq) FROM workspace_events WHERE space_id = $1), 0)
		)
	`, spaceID).Scan(&sequence)
	if err != nil {
		return 0, internalError("read bot event cursor", err)
	}
	return sequence, nil
}

func (r *PGRepository) EarliestSequence(ctx context.Context, spaceID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("read bot event window", errors.New("workspace postgres pool is required"))
	}
	var sequence int64
	err := r.pool.QueryRow(ctx, `SELECT COALESCE(MIN(seq), 0) FROM workspace_events WHERE space_id = $1`, spaceID).Scan(&sequence)
	if err != nil {
		return 0, internalError("read bot event window", err)
	}
	return sequence, nil
}

func (r *PGRepository) ListRecentEvents(ctx context.Context, spaceID string, limit int) ([]EventRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list recent bot events", errors.New("workspace postgres pool is required"))
	}
	return listEvents(ctx, r.pool, spaceID, 0, limit, true)
}

func (r *PGRepository) ListEventsAfter(ctx context.Context, spaceID string, afterSequence int64, limit int) ([]EventRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list bot events", errors.New("workspace postgres pool is required"))
	}
	return listEvents(ctx, r.pool, spaceID, afterSequence, limit, false)
}

func listEvents(ctx context.Context, queryer pgQueryer, spaceID string, afterSequence int64, limit int, recent bool) ([]EventRecord, error) {
	limit = boundedLimit(limit, DefaultBatchSize, MaxBatchSize)
	query := `
		SELECT id, space_id, seq, type, actor_user_id, conversation_id,
		       target_type, target_id, payload_json, created_at
		FROM workspace_events WHERE space_id = $1
	`
	args := []any{spaceID}
	if !recent {
		query += ` AND seq > $2 ORDER BY seq ASC LIMIT $3`
		args = append(args, afterSequence, limit)
	} else {
		query += ` ORDER BY seq DESC LIMIT $2`
		args = append(args, limit)
	}
	rows, err := queryer.Query(ctx, query, args...)
	if err != nil {
		return nil, internalError("list bot events", err)
	}
	defer rows.Close()
	result := make([]EventRecord, 0, limit)
	for rows.Next() {
		var value EventRecord
		var actorID, conversationID, targetType, targetID *string
		var payload string
		if err := rows.Scan(&value.ID, &value.SpaceID, &value.Sequence, &value.EventType, &actorID, &conversationID, &targetType, &targetID, &payload, &value.CreatedAt); err != nil {
			return nil, internalError("scan bot event", err)
		}
		if actorID != nil {
			value.ActorUserID = *actorID
		}
		if conversationID != nil {
			value.ConversationID = *conversationID
		}
		if targetType != nil {
			value.TargetType = *targetType
		}
		if targetID != nil {
			value.TargetID = *targetID
		}
		value.PayloadJSON = []byte(payload)
		value.CreatedAt = value.CreatedAt.UTC()
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list bot events", err)
	}
	return result, nil
}

func (r *PGRepository) GetEvent(ctx context.Context, spaceID, eventID string) (*EventRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot event", errors.New("workspace postgres pool is required"))
	}
	return getEvent(ctx, r.pool, spaceID, eventID)
}

func getEvent(ctx context.Context, queryer pgQueryer, spaceID, eventID string) (*EventRecord, error) {
	var value EventRecord
	var actorID, conversationID, targetType, targetID *string
	var payload string
	err := queryer.QueryRow(ctx, `
		SELECT id, space_id, seq, type, actor_user_id, conversation_id,
		       target_type, target_id, payload_json, created_at
		FROM workspace_events WHERE id = $1 AND space_id = $2
	`, eventID, spaceID).Scan(&value.ID, &value.SpaceID, &value.Sequence, &value.EventType, &actorID, &conversationID, &targetType, &targetID, &payload, &value.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot event", err)
	}
	if actorID != nil {
		value.ActorUserID = *actorID
	}
	if conversationID != nil {
		value.ConversationID = *conversationID
	}
	if targetType != nil {
		value.TargetType = *targetType
	}
	if targetID != nil {
		value.TargetID = *targetID
	}
	value.PayloadJSON = []byte(payload)
	value.CreatedAt = value.CreatedAt.UTC()
	return &value, nil
}

func (r *PGRepository) ListDeliveriesAfter(ctx context.Context, botID, spaceID string, afterSequence int64, now time.Time, limit int) ([]DeliveryRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list bot deliveries", errors.New("workspace postgres pool is required"))
	}
	return listDeliveriesAfter(ctx, r.pool, botID, spaceID, afterSequence, now, limit)
}

func listDeliveriesAfter(ctx context.Context, queryer pgQueryer, botID, spaceID string, afterSequence int64, now time.Time, limit int) ([]DeliveryRecord, error) {
	limit = boundedLimit(limit, DefaultReplayLimit, MaxReplayLimit*4+1)
	rows, err := queryer.Query(ctx, `
		SELECT id, bot_id, space_id, sequence, event_id, event_type, conversation_id,
		       payload_json, status, attempts, created_at, expires_at
		FROM workspace_agent_bot_deliveries
		WHERE bot_id = $1 AND space_id = $2 AND sequence > $3
		  AND status <> 'expired' AND expires_at > $4
		ORDER BY sequence ASC LIMIT $5
	`, botID, spaceID, afterSequence, now.UTC(), limit)
	if err != nil {
		return nil, internalError("list bot deliveries", err)
	}
	defer rows.Close()
	result := make([]DeliveryRecord, 0, limit)
	for rows.Next() {
		var value DeliveryRecord
		var conversationID *string
		var payload string
		if err := rows.Scan(&value.ID, &value.BotID, &value.SpaceID, &value.Sequence, &value.EventID, &value.EventType, &conversationID, &payload, &value.Status, &value.Attempts, &value.CreatedAt, &value.ExpiresAt); err != nil {
			return nil, internalError("scan bot delivery", err)
		}
		if conversationID != nil {
			value.ConversationID = *conversationID
		}
		value.PayloadJSON = []byte(payload)
		value.CreatedAt = value.CreatedAt.UTC()
		value.ExpiresAt = value.ExpiresAt.UTC()
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list bot deliveries", err)
	}
	return result, nil
}

func (r *PGRepository) EarliestDeliverySequence(ctx context.Context, botID, spaceID string, now time.Time) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("read bot delivery window", errors.New("workspace postgres pool is required"))
	}
	var value *int64
	err := r.pool.QueryRow(ctx, `
		SELECT MIN(sequence) FROM workspace_agent_bot_deliveries
		WHERE bot_id = $1 AND space_id = $2 AND status <> 'expired' AND expires_at > $3
	`, botID, spaceID, now.UTC()).Scan(&value)
	if err != nil {
		return 0, internalError("read bot delivery window", err)
	}
	if value == nil {
		return 0, nil
	}
	return *value, nil
}

// HasExpiredDeliveryAfter distinguishes an empty replay queue from a cursor
// gap caused by delivery expiry. The delivery table remains the durable
// authority; callers must still re-authorize the event before delivery.
func (r *PGRepository) HasExpiredDeliveryAfter(ctx context.Context, botID, spaceID string, afterSequence int64, now time.Time) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("read expired bot delivery window", errors.New("workspace postgres pool is required"))
	}
	var expired bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM workspace_agent_bot_deliveries
			WHERE bot_id = $1 AND space_id = $2 AND sequence > $3
			  AND (status = 'expired' OR expires_at <= $4)
		)
	`, botID, spaceID, afterSequence, now.UTC()).Scan(&expired)
	if err != nil {
		return false, internalError("read expired bot delivery window", err)
	}
	return expired, nil
}

func (r *PGRepository) GetMessageTrigger(ctx context.Context, spaceID, conversationID, messageID string) (*MessageTrigger, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot trigger message", errors.New("workspace postgres pool is required"))
	}
	return getMessageTrigger(ctx, r.pool, spaceID, conversationID, messageID)
}

func getMessageTrigger(ctx context.Context, queryer pgQueryer, spaceID, conversationID, messageID string) (*MessageTrigger, error) {
	var value MessageTrigger
	var content string
	err := queryer.QueryRow(ctx, `
		SELECT author_id, content_json, plain_text, deleted_at, recalled_at
		FROM messages
		WHERE id = $1 AND space_id = $2 AND conversation_id = $3
	`, messageID, spaceID, conversationID).Scan(&value.AuthorID, &content, &value.PlainText, &value.DeletedAt, &value.RecalledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot trigger message", err)
	}
	value.ContentJSON = []byte(content)
	if value.DeletedAt != nil {
		deleted := value.DeletedAt.UTC()
		value.DeletedAt = &deleted
	}
	if value.RecalledAt != nil {
		recalled := value.RecalledAt.UTC()
		value.RecalledAt = &recalled
	}
	return &value, nil
}

func (r *PGRepository) GetSender(ctx context.Context, spaceID, conversationID, userID string) (*Sender, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot event sender", errors.New("workspace postgres pool is required"))
	}
	return getSender(ctx, r.pool, spaceID, conversationID, userID)
}

func getSender(ctx context.Context, queryer pgQueryer, spaceID, conversationID, userID string) (*Sender, error) {
	var value Sender
	err := queryer.QueryRow(ctx, `
		SELECT u.id, u.kind, sm.role
		FROM users u
		JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = $1 AND sm.removed_at IS NULL
		JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = $2 AND cm.removed_at IS NULL
		WHERE u.id = $3
	`, spaceID, conversationID, userID).Scan(&value.ID, &value.Kind, &value.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot event sender", err)
	}
	return &value, nil
}

func (r *PGRepository) VisibilityMember(ctx context.Context, botID, spaceID, userID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check bot visibility member", errors.New("workspace postgres pool is required"))
	}
	var allowed bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM workspace_agent_bot_visibility_members
			WHERE bot_id = $1 AND space_id = $2 AND user_id = $3
		)
	`, botID, spaceID, userID).Scan(&allowed)
	if err != nil {
		return false, internalError("check bot visibility member", err)
	}
	return allowed, nil
}

func (r *PGRepository) GetLimits(ctx context.Context, botID, spaceID string) (*Limits, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read bot gateway limits", errors.New("workspace postgres pool is required"))
	}
	var value Limits
	err := r.pool.QueryRow(ctx, `
		SELECT requests_per_minute, member_daily_requests, event_backlog_limit
		FROM workspace_agent_bot_limits WHERE bot_id = $1 AND space_id = $2
	`, botID, spaceID).Scan(&value.RequestsPerMinute, &value.MemberDailyRequests, &value.EventBacklogLimit)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot gateway limits", err)
	}
	return &value, nil
}

func (r *PGRepository) CountRecentDeliveries(ctx context.Context, botID, spaceID string, since time.Time) (int, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count bot deliveries", errors.New("workspace postgres pool is required"))
	}
	return countRows(ctx, r.pool, `SELECT COUNT(*) FROM workspace_agent_bot_deliveries WHERE bot_id = $1 AND space_id = $2 AND created_at >= $3`, botID, spaceID, since.UTC())
}

func (r *PGRepository) CountMemberDeliveries(ctx context.Context, botID, spaceID, actorUserID string, since time.Time) (int, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count bot member deliveries", errors.New("workspace postgres pool is required"))
	}
	return countRows(ctx, r.pool, `
		SELECT COUNT(*) FROM workspace_agent_bot_deliveries d
		JOIN workspace_events e ON e.id = d.event_id AND e.space_id = d.space_id
		WHERE d.bot_id = $1 AND d.space_id = $2 AND e.actor_user_id = $3 AND d.created_at >= $4
	`, botID, spaceID, actorUserID, since.UTC())
}

func (r *PGRepository) CountPendingDeliveries(ctx context.Context, botID, spaceID string, now time.Time) (int, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count bot delivery backlog", errors.New("workspace postgres pool is required"))
	}
	return countRows(ctx, r.pool, `
		SELECT COUNT(*) FROM workspace_agent_bot_deliveries
		WHERE bot_id = $1 AND space_id = $2 AND status IN ('queued', 'delivered') AND expires_at > $3
	`, botID, spaceID, now.UTC())
}

func countRows(ctx context.Context, queryer pgQueryer, query string, args ...any) (int, error) {
	var count int
	if err := queryer.QueryRow(ctx, query, args...).Scan(&count); err != nil {
		return 0, internalError("count bot delivery rows", err)
	}
	return count, nil
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

var (
	_ MessageTransactionProvider  = (*pgTx)(nil)
	_ CardTransactionProvider     = (*pgTx)(nil)
	_ TransactionalTokenValidator = (*pgTx)(nil)
)

// MessageTransaction and CardTransaction expose only each owning domain's
// typed Tx surface over this same PostgreSQL transaction. They deliberately do
// not expose pgx or a generic query handle to gateway callers.
func (t *pgTx) MessageTransaction() workspacemessages.Tx {
	if t == nil {
		return nil
	}
	if t.repository != nil && t.repository.messageRepository != nil {
		return t.repository.messageRepository.NewTransaction(t.tx)
	}
	return workspacemessages.NewPGTransaction(t.tx)
}

func (t *pgTx) CardTransaction() workspacecards.Tx {
	if t == nil {
		return nil
	}
	if t.repository != nil && t.repository.cardRepository != nil {
		return t.repository.cardRepository.NewTransaction(t.tx)
	}
	return workspacecards.NewPGTransaction(t.tx)
}

func (t *pgTx) LookupToken(ctx context.Context, tokenHash string, options TokenAuthOptions, now time.Time) (*Auth, error) {
	return lookupToken(ctx, t.tx, tokenHash, options, now)
}

func (t *pgTx) ValidateToken(ctx context.Context, tokenID, botID, spaceID string, now time.Time) (*Auth, error) {
	return lookupAuth(ctx, t.tx, tokenID, botID, spaceID, now)
}

func (t *pgTx) ValidateTokenForMutation(ctx context.Context, tokenID, botID, spaceID string, now time.Time) (*Auth, error) {
	return lookupAuthForMutation(ctx, t.tx, tokenID, botID, spaceID, now)
}

func (t *pgTx) GetSettings(ctx context.Context, botID, spaceID string) (*Settings, error) {
	return getSettings(ctx, t.tx, botID, spaceID)
}

func (t *pgTx) GetConnection(ctx context.Context, botID, spaceID string) (*Connection, error) {
	return getConnection(ctx, t.tx, botID, spaceID)
}

func (t *pgTx) GetConversation(ctx context.Context, spaceID, conversationID string) (*Conversation, error) {
	return getConversation(ctx, t.tx, spaceID, conversationID)
}

func (t *pgTx) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	return conversationMemberActive(ctx, t.tx, spaceID, conversationID, userID)
}

func (t *pgTx) GetGroupPolicy(ctx context.Context, botID, spaceID, conversationID string) (*GroupPolicy, error) {
	return getGroupPolicy(ctx, t.tx, botID, spaceID, conversationID)
}

func (t *pgTx) GetContextGrant(ctx context.Context, botID, spaceID, conversationID string) (*ContextGrant, error) {
	return getContextGrant(ctx, t.tx, botID, spaceID, conversationID)
}

func (t *pgTx) ListContextMessages(ctx context.Context, spaceID, conversationID string, since time.Time, includeReplies, includeSystemEvents bool, limit int) ([]ContextMessageRecord, error) {
	return listContextMessages(ctx, t.tx, spaceID, conversationID, since, includeReplies, includeSystemEvents, limit)
}

func (t *pgTx) GetAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error) {
	return getAttachment(ctx, t.tx, spaceID, attachmentID)
}

func (t *pgTx) CurrentSequence(ctx context.Context, spaceID string) (int64, error) {
	return currentSequence(ctx, t.tx, spaceID)
}

func (t *pgTx) EarliestSequence(ctx context.Context, spaceID string) (int64, error) {
	var sequence int64
	err := t.tx.QueryRow(ctx, `SELECT COALESCE(MIN(seq), 0) FROM workspace_events WHERE space_id = $1`, spaceID).Scan(&sequence)
	if err != nil {
		return 0, internalError("read bot event window", err)
	}
	return sequence, nil
}

func (t *pgTx) ListRecentEvents(ctx context.Context, spaceID string, limit int) ([]EventRecord, error) {
	return listEvents(ctx, t.tx, spaceID, 0, limit, true)
}

func (t *pgTx) ListEventsAfter(ctx context.Context, spaceID string, afterSequence int64, limit int) ([]EventRecord, error) {
	return listEvents(ctx, t.tx, spaceID, afterSequence, limit, false)
}

func (t *pgTx) GetEvent(ctx context.Context, spaceID, eventID string) (*EventRecord, error) {
	return getEvent(ctx, t.tx, spaceID, eventID)
}

func (t *pgTx) ListDeliveriesAfter(ctx context.Context, botID, spaceID string, afterSequence int64, now time.Time, limit int) ([]DeliveryRecord, error) {
	return listDeliveriesAfter(ctx, t.tx, botID, spaceID, afterSequence, now, limit)
}

func (t *pgTx) EarliestDeliverySequence(ctx context.Context, botID, spaceID string, now time.Time) (int64, error) {
	var value *int64
	err := t.tx.QueryRow(ctx, `
		SELECT MIN(sequence) FROM workspace_agent_bot_deliveries
		WHERE bot_id = $1 AND space_id = $2 AND status <> 'expired' AND expires_at > $3
	`, botID, spaceID, now.UTC()).Scan(&value)
	if err != nil {
		return 0, internalError("read bot delivery window", err)
	}
	if value == nil {
		return 0, nil
	}
	return *value, nil
}

func (t *pgTx) GetMessageTrigger(ctx context.Context, spaceID, conversationID, messageID string) (*MessageTrigger, error) {
	return getMessageTrigger(ctx, t.tx, spaceID, conversationID, messageID)
}

func (t *pgTx) GetSender(ctx context.Context, spaceID, conversationID, userID string) (*Sender, error) {
	return getSender(ctx, t.tx, spaceID, conversationID, userID)
}

func (t *pgTx) VisibilityMember(ctx context.Context, botID, spaceID, userID string) (bool, error) {
	var allowed bool
	err := t.tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM workspace_agent_bot_visibility_members WHERE bot_id = $1 AND space_id = $2 AND user_id = $3)
	`, botID, spaceID, userID).Scan(&allowed)
	if err != nil {
		return false, internalError("check bot visibility member", err)
	}
	return allowed, nil
}

func (t *pgTx) GetLimits(ctx context.Context, botID, spaceID string) (*Limits, error) {
	var value Limits
	err := t.tx.QueryRow(ctx, `SELECT requests_per_minute, member_daily_requests, event_backlog_limit FROM workspace_agent_bot_limits WHERE bot_id = $1 AND space_id = $2`, botID, spaceID).Scan(&value.RequestsPerMinute, &value.MemberDailyRequests, &value.EventBacklogLimit)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot gateway limits", err)
	}
	return &value, nil
}

func (t *pgTx) CountRecentDeliveries(ctx context.Context, botID, spaceID string, since time.Time) (int, error) {
	return countRows(ctx, t.tx, `SELECT COUNT(*) FROM workspace_agent_bot_deliveries WHERE bot_id = $1 AND space_id = $2 AND created_at >= $3`, botID, spaceID, since.UTC())
}

func (t *pgTx) CountMemberDeliveries(ctx context.Context, botID, spaceID, actorUserID string, since time.Time) (int, error) {
	return countRows(ctx, t.tx, `
		SELECT COUNT(*) FROM workspace_agent_bot_deliveries d
		JOIN workspace_events e ON e.id = d.event_id AND e.space_id = d.space_id
		WHERE d.bot_id = $1 AND d.space_id = $2 AND e.actor_user_id = $3 AND d.created_at >= $4
	`, botID, spaceID, actorUserID, since.UTC())
}

func (t *pgTx) CountPendingDeliveries(ctx context.Context, botID, spaceID string, now time.Time) (int, error) {
	return countRows(ctx, t.tx, `
		SELECT COUNT(*) FROM workspace_agent_bot_deliveries
		WHERE bot_id = $1 AND space_id = $2 AND status IN ('queued', 'delivered') AND expires_at > $3
	`, botID, spaceID, now.UTC())
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, key); err != nil {
		return internalError("lock bot gateway operation", err)
	}
	return nil
}

func (t *pgTx) GetIdempotency(ctx context.Context, botID, operation, key string, now time.Time) (*IdempotencyRecord, error) {
	var value IdempotencyRecord
	var expiresAt time.Time
	err := t.tx.QueryRow(ctx, `
		SELECT request_hash, response_json, expires_at
		FROM workspace_agent_bot_idempotency
		WHERE bot_id = $1 AND operation = $2 AND idempotency_key = $3 AND expires_at > $4
	`, botID, operation, key, now.UTC()).Scan(&value.RequestHash, &value.ResponseJSON, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read bot gateway idempotency", err)
	}
	value.ExpiresAt = expiresAt.UTC()
	return &value, nil
}

func (t *pgTx) InsertIdempotency(ctx context.Context, input IdempotencyRecordInput) (bool, error) {
	tag, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_idempotency
		(id, bot_id, token_id, space_id, operation, idempotency_key, request_hash, response_status, response_json, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 200, $8, $9, $10)
		ON CONFLICT (bot_id, operation, idempotency_key) DO NOTHING
	`, input.ID, input.BotID, input.TokenID, input.SpaceID, input.Operation, input.Key, input.RequestHash, string(input.ResponseJSON), input.CreatedAt.UTC(), input.ExpiresAt.UTC())
	if err != nil {
		return false, internalError("write bot gateway idempotency", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (t *pgTx) ExpireDeliveries(ctx context.Context, botID, spaceID string, now time.Time) error {
	_, err := t.tx.Exec(ctx, `
		UPDATE workspace_agent_bot_deliveries SET status = 'expired'
		WHERE bot_id = $1 AND space_id = $2 AND status <> 'expired' AND expires_at <= $3
	`, botID, spaceID, now.UTC())
	if err != nil {
		return internalError("expire bot deliveries", err)
	}
	return nil
}

func (t *pgTx) ExpireDelivery(ctx context.Context, id string) error {
	_, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_deliveries SET status = 'expired' WHERE id = $1 AND status <> 'expired'`, id)
	if err != nil {
		return internalError("expire bot delivery", err)
	}
	return nil
}

func (t *pgTx) InsertDelivery(ctx context.Context, input DeliveryInsert) (bool, error) {
	tag, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_deliveries
		(id, bot_id, space_id, sequence, event_id, event_type, conversation_id, payload_json, status, attempts, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), $8, $9, $10, $11, $12)
		ON CONFLICT (bot_id, sequence) DO NOTHING
	`, input.ID, input.BotID, input.SpaceID, input.Sequence, input.EventID, input.EventType, input.ConversationID, string(input.PayloadJSON), input.Status, input.Attempts, input.CreatedAt.UTC(), input.ExpiresAt.UTC())
	if err != nil {
		return false, internalError("write bot delivery", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (t *pgTx) MarkDeliveryDelivered(ctx context.Context, id string, now time.Time) error {
	_, err := t.tx.Exec(ctx, `
		UPDATE workspace_agent_bot_deliveries
		SET status = CASE WHEN status = 'queued' THEN 'delivered' ELSE status END,
		    delivered_at = COALESCE(delivered_at, $1), attempts = attempts + 1
		WHERE id = $2 AND status <> 'expired'
	`, now.UTC(), id)
	if err != nil {
		return internalError("mark bot delivery delivered", err)
	}
	return nil
}

func (t *pgTx) AcknowledgeDelivery(ctx context.Context, botID, spaceID, eventID string, sequence int64, now time.Time) (bool, error) {
	query := `
		UPDATE workspace_agent_bot_deliveries SET status = 'acked', acked_at = $1
		WHERE bot_id = $2 AND space_id = $3 AND status <> 'acked' AND `
	args := []any{now.UTC(), botID, spaceID}
	if eventID != "" {
		query += `event_id = $4`
		args = append(args, eventID)
	} else {
		query += `sequence = $4`
		args = append(args, sequence)
	}
	tag, err := t.tx.Exec(ctx, query, args...)
	if err != nil {
		return false, internalError("acknowledge bot delivery", err)
	}
	return tag.RowsAffected() > 0, nil
}

func (t *pgTx) MarkProcessed(ctx context.Context, botID, spaceID string, now time.Time) error {
	_, err := t.tx.Exec(ctx, `
		UPDATE workspace_agent_bot_connections SET last_processed_at = $1, updated_at = $1
		WHERE bot_id = $2 AND space_id = $3
	`, now.UTC(), botID, spaceID)
	if err != nil {
		return internalError("mark bot gateway processed", err)
	}
	return nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	id := strings.TrimSpace(input.ID)
	if id == "" {
		generated, err := t.repository.idFactory()
		if err != nil || strings.TrimSpace(generated) == "" {
			if err == nil {
				err = errors.New("audit id factory returned an empty id")
			}
			return internalError("generate bot gateway audit id", err)
		}
		id = "aud_" + strings.TrimSpace(generated)
	}
	_, err := t.tx.Exec(ctx, `
		INSERT INTO audit_logs
		(id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, request_id, ip_address, user_agent, created_at)
		VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)
	`, id, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, input.Result, input.Reason, input.RequestID, input.IPAddress, input.UserAgent, input.CreatedAt.UTC())
	if err != nil {
		return internalError("write bot gateway audit", err)
	}
	return nil
}

func boundedLimit(value, fallback, maximum int) int {
	if value <= 0 {
		value = fallback
	}
	if value > maximum {
		value = maximum
	}
	return value
}
