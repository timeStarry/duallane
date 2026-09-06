package bots

import (
	"context"
	"errors"
	"strings"
	"time"

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

// PGRepository is the PostgreSQL adapter for the Agent Bot management
// vertical. It intentionally exposes only the methods in repository.go.
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

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return internalError("ping workspace agent bot database", errors.New("workspace postgres pool is required"))
	}
	if err := r.pool.Ping(ctx); err != nil {
		return internalError("ping workspace agent bot database", err)
	}
	return nil
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin workspace agent bot transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin workspace agent bot transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin workspace agent bot transaction", err)
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
		return internalError("commit workspace agent bot transaction", err)
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup workspace agent bot actor", errors.New("workspace postgres pool is required"))
	}
	return lookupActor(ctx, r.pool, spaceID, userID)
}

func lookupActor(ctx context.Context, queryer pgQueryer, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	err := queryer.QueryRow(ctx, `
		SELECT u.id, u.github_id, u.github_login, u.email, u.display_name,
			u.nickname, u.avatar_url, u.search_discoverable, u.kind,
			sm.role, sm.joined_at
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName,
		&nickname, &avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &actor.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	actor.GitHubID = optionalString(githubID)
	actor.Email = optionalString(email)
	actor.Nickname = optionalString(nickname)
	actor.AvatarURL = optionalString(avatarURL)
	actor.JoinedAt = actor.JoinedAt.UTC()
	return &actor, nil
}

func (r *PGRepository) GetBot(ctx context.Context, spaceID, botID string) (*BotRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace agent bot", errors.New("workspace postgres pool is required"))
	}
	return getBot(ctx, r.pool, spaceID, botID, true)
}

func (r *PGRepository) GetBotAnySpace(ctx context.Context, botID string) (*BotRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace agent bot", errors.New("workspace postgres pool is required"))
	}
	return getBot(ctx, r.pool, "", botID, false)
}

const botSelect = `
	SELECT b.id, b.space_id, b.owner_user_id, b.bot_user_id, b.mode, b.name,
		b.name_normalized, b.visibility_policy, b.conversation_policy,
		b.trigger_policy, b.status, u.github_login, b.created_at, b.updated_at,
		b.deleting_at, b.deleted_at
	FROM workspace_agent_bots b
	INNER JOIN users u ON u.id = b.bot_user_id AND u.kind = 'bot'
`

func scanBot(row pgx.Row) (*BotRecord, error) {
	var record BotRecord
	var deletingAt, deletedAt *time.Time
	if err := row.Scan(&record.ID, &record.SpaceID, &record.OwnerUserID, &record.BotUserID, &record.Mode,
		&record.Name, &record.NameNormalized, &record.VisibilityPolicy, &record.ConversationPolicy,
		&record.TriggerPolicy, &record.Status, &record.GithubLogin, &record.CreatedAt, &record.UpdatedAt,
		&deletingAt, &deletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	record.CreatedAt = record.CreatedAt.UTC()
	record.UpdatedAt = record.UpdatedAt.UTC()
	if deletingAt != nil {
		value := deletingAt.UTC()
		record.DeletingAt = &value
	}
	if deletedAt != nil {
		value := deletedAt.UTC()
		record.DeletedAt = &value
	}
	return &record, nil
}

func getBot(ctx context.Context, queryer pgQueryer, spaceID, botID string, scoped bool) (*BotRecord, error) {
	query := botSelect + ` WHERE b.id = $1`
	args := []any{strings.TrimSpace(botID)}
	if scoped {
		query += ` AND b.space_id = $2`
		args = append(args, spaceID)
	}
	return scanBot(queryer.QueryRow(ctx, query, args...))
}

func (r *PGRepository) GetBotByOwner(ctx context.Context, spaceID, ownerUserID string) (*BotRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find owned workspace agent bot", errors.New("workspace postgres pool is required"))
	}
	return getBotByOwner(ctx, r.pool, spaceID, ownerUserID)
}

func (r *PGRepository) GetConnection(ctx context.Context, botID, spaceID string) (*ConnectionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace agent bot connection", errors.New("workspace postgres pool is required"))
	}
	if err := ensureConnection(ctx, r.pool, botID, spaceID, time.Now().UTC().Truncate(time.Millisecond), r.idFactory); err != nil {
		return nil, err
	}
	return getConnectionRecord(ctx, r.pool, botID, spaceID)
}

func ensureConnection(ctx context.Context, queryer pgQueryer, botID, spaceID string, at time.Time, idFactory IDFactory) error {
	botID = strings.TrimSpace(botID)
	spaceID = strings.TrimSpace(spaceID)
	if botID == "" || spaceID == "" {
		return internalError("ensure workspace agent bot connection", errors.New("bot and space are required"))
	}
	var exists bool
	if err := queryer.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM workspace_agent_bot_connections WHERE bot_id = $1 AND space_id = $2)
	`, botID, spaceID).Scan(&exists); err != nil {
		return internalError("check workspace agent bot connection", err)
	}
	if exists {
		return nil
	}
	if idFactory == nil {
		idFactory = defaultIDFactory
	}
	id, err := idFactory()
	if err != nil || strings.TrimSpace(id) == "" {
		if err == nil {
			err = errors.New("connection id factory returned an empty id")
		}
		return internalError("generate workspace agent bot connection id", err)
	}
	_, err = queryer.Exec(ctx, `
		INSERT INTO workspace_agent_bot_connections (id, bot_id, space_id, status, updated_at)
		VALUES ($1, $2, $3, 'disconnected', $4)
		ON CONFLICT (bot_id) DO NOTHING
	`, "bcon_"+strings.TrimSpace(id), botID, spaceID, at.UTC())
	if err != nil {
		return internalError("ensure workspace agent bot connection", err)
	}
	return nil
}

func getConnectionRecord(ctx context.Context, queryer pgQueryer, botID, spaceID string) (*ConnectionRecord, error) {
	var record ConnectionRecord
	var adapterVersion, errorCode *string
	var connectedAt, disconnectedAt, heartbeatAt, processedAt, errorAt *time.Time
	err := queryer.QueryRow(ctx, `
		SELECT id, bot_id, space_id, status, adapter_version, connected_at, disconnected_at,
		       last_heartbeat_at, last_processed_at, last_error_code, last_error_at, updated_at
		FROM workspace_agent_bot_connections
		WHERE bot_id = $1 AND space_id = $2
	`, strings.TrimSpace(botID), strings.TrimSpace(spaceID)).Scan(
		&record.ID, &record.BotID, &record.SpaceID, &record.Status, &adapterVersion,
		&connectedAt, &disconnectedAt, &heartbeatAt, &processedAt, &errorCode, &errorAt, &record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read workspace agent bot connection", err)
	}
	record.AdapterVersion = adapterVersion
	record.ConnectedAt = cloneConnectionTime(connectedAt)
	record.DisconnectedAt = cloneConnectionTime(disconnectedAt)
	record.LastHeartbeatAt = cloneConnectionTime(heartbeatAt)
	record.LastProcessedAt = cloneConnectionTime(processedAt)
	record.LastErrorCode = errorCode
	record.LastErrorAt = cloneConnectionTime(errorAt)
	record.UpdatedAt = record.UpdatedAt.UTC()
	return &record, nil
}

func cloneConnectionTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	result := value.UTC()
	return &result
}

func getBotByOwner(ctx context.Context, queryer pgQueryer, spaceID, ownerUserID string) (*BotRecord, error) {
	return scanBot(queryer.QueryRow(ctx, botSelect+` WHERE b.space_id = $1 AND b.owner_user_id = $2 AND b.status <> 'deleted' ORDER BY b.created_at DESC, b.id DESC LIMIT 1`, spaceID, ownerUserID))
}

func (r *PGRepository) ListBots(ctx context.Context, spaceID, ownerUserID string) ([]BotRecord, error) {
	if r == nil || r.pool == nil {
		return []BotRecord{}, internalError("list workspace agent bots", errors.New("workspace postgres pool is required"))
	}
	return listBots(ctx, r.pool, spaceID, ownerUserID)
}

func listBots(ctx context.Context, queryer pgQueryer, spaceID, ownerUserID string) ([]BotRecord, error) {
	rows, err := queryer.Query(ctx, botSelect+` WHERE b.space_id = $1 AND b.owner_user_id = $2 AND b.status <> 'deleted' ORDER BY b.created_at DESC, b.id DESC`, spaceID, ownerUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]BotRecord, 0)
	for rows.Next() {
		var record BotRecord
		var deletingAt, deletedAt *time.Time
		if err := rows.Scan(&record.ID, &record.SpaceID, &record.OwnerUserID, &record.BotUserID, &record.Mode,
			&record.Name, &record.NameNormalized, &record.VisibilityPolicy, &record.ConversationPolicy,
			&record.TriggerPolicy, &record.Status, &record.GithubLogin, &record.CreatedAt, &record.UpdatedAt,
			&deletingAt, &deletedAt); err != nil {
			return nil, err
		}
		record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
		if deletingAt != nil {
			value := deletingAt.UTC()
			record.DeletingAt = &value
		}
		if deletedAt != nil {
			value := deletedAt.UTC()
			record.DeletedAt = &value
		}
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *PGRepository) GetSettings(ctx context.Context, spaceID, botID string) (*SettingsRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace agent bot settings", errors.New("workspace postgres pool is required"))
	}
	return getSettings(ctx, r.pool, spaceID, botID)
}

func getSettings(ctx context.Context, queryer pgQueryer, spaceID, botID string) (*SettingsRecord, error) {
	var record SettingsRecord
	var welcome, description, avatar *string
	var allowDirect, allowGroup, requireApproval, proactive, showCreator int
	var includeReplies, includeSystemEvents, includeAttachmentMetadata, allowAttachmentPreview, summaryEnabled int
	var limits Limits
	err := queryer.QueryRow(ctx, `
		SELECT s.bot_id, s.space_id, s.visibility_policy, s.allow_direct, s.allow_group,
			s.group_inviter_policy, s.require_owner_approval, s.proactive_enabled,
			s.trigger_policy, s.welcome_message, s.description, s.avatar_url, s.show_creator,
			s.max_context_messages, s.max_context_chars, s.max_context_tokens,
			s.context_window_seconds, s.include_replies, s.include_system_events,
			s.include_attachment_metadata, s.allow_attachment_preview, s.long_term_summary_enabled,
			s.created_at, s.updated_at,
			COALESCE(l.requests_per_minute, 30), COALESCE(l.member_daily_requests, 500),
			COALESCE(l.input_token_limit, 32000), COALESCE(l.output_token_limit, 16000),
			COALESCE(l.max_concurrency, 2), COALESCE(l.event_backlog_limit, 200)
		FROM workspace_agent_bot_settings s
		LEFT JOIN workspace_agent_bot_limits l ON l.bot_id = s.bot_id AND l.space_id = s.space_id
		WHERE s.bot_id = $1 AND s.space_id = $2
	`, botID, spaceID).Scan(&record.BotID, &record.SpaceID, &record.VisibilityPolicy, &allowDirect, &allowGroup,
		&record.GroupInviterPolicy, &requireApproval, &proactive, &record.TriggerPolicy, &welcome, &description,
		&avatar, &showCreator, &record.MaxContextMessages, &record.MaxContextChars, &record.MaxContextTokens,
		&record.ContextWindowSeconds, &includeReplies, &includeSystemEvents, &includeAttachmentMetadata,
		&allowAttachmentPreview, &summaryEnabled, &record.CreatedAt, &record.UpdatedAt,
		&limits.RequestsPerMinute, &limits.MemberDailyRequests, &limits.InputTokenLimit, &limits.OutputTokenLimit,
		&limits.MaxConcurrency, &limits.EventBacklogLimit)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.AllowDirect, record.AllowGroup, record.RequireOwnerApproval, record.ProactiveEnabled = allowDirect != 0, allowGroup != 0, requireApproval != 0, proactive != 0
	record.ShowCreator = showCreator != 0
	record.IncludeReplies, record.IncludeSystemEvents, record.IncludeAttachmentMetadata = includeReplies != 0, includeSystemEvents != 0, includeAttachmentMetadata != 0
	record.AllowAttachmentPreview, record.LongTermSummaryEnabled = allowAttachmentPreview != 0, summaryEnabled != 0
	record.WelcomeMessage, record.Description, record.AvatarURL = cloneString(welcome), cloneString(description), cloneString(avatar)
	record.AllowedMemberIDs, err = listVisibilityMembers(ctx, queryer, spaceID, botID)
	if err != nil {
		return nil, err
	}
	record.Limits = limits
	record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
	return &record, nil
}

func listVisibilityMembers(ctx context.Context, queryer pgQueryer, spaceID, botID string) ([]string, error) {
	rows, err := queryer.Query(ctx, `SELECT user_id FROM workspace_agent_bot_visibility_members WHERE bot_id = $1 AND space_id = $2 ORDER BY user_id`, botID, spaceID)
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

func (r *PGRepository) ListGroupPolicies(ctx context.Context, spaceID, botID string) ([]GroupPolicyRecord, error) {
	if r == nil || r.pool == nil {
		return []GroupPolicyRecord{}, internalError("list workspace agent bot group policies", errors.New("workspace postgres pool is required"))
	}
	return listGroupPolicies(ctx, r.pool, spaceID, botID)
}

func listGroupPolicies(ctx context.Context, queryer pgQueryer, spaceID, botID string) ([]GroupPolicyRecord, error) {
	rows, err := queryer.Query(ctx, `
		SELECT gp.conversation_id, gp.status, gp.invited_by, gp.approved_by,
			gp.max_context_messages, gp.created_at, gp.updated_at,
			cg.grant_id, COALESCE(cg.allow_trigger, 0), COALESCE(cg.allow_context, 0), cg.max_messages
		FROM workspace_agent_bot_group_policies gp
		LEFT JOIN workspace_agent_bot_context_grants cg ON cg.bot_id = gp.bot_id AND cg.space_id = gp.space_id AND cg.conversation_id = gp.conversation_id
		WHERE gp.bot_id = $1 AND gp.space_id = $2 ORDER BY gp.updated_at DESC, gp.conversation_id ASC
	`, botID, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]GroupPolicyRecord, 0)
	for rows.Next() {
		var record GroupPolicyRecord
		var allowTrigger, allowContext int
		if err := rows.Scan(&record.ConversationID, &record.Status, &record.InvitedBy, &record.ApprovedBy, &record.MaxContextMessages,
			&record.CreatedAt, &record.UpdatedAt, &record.GrantID, &allowTrigger, &allowContext, &record.ContextMaxMessages); err != nil {
			return nil, err
		}
		record.BotID, record.SpaceID = botID, spaceID
		record.AllowTrigger, record.AllowContext = allowTrigger != 0, allowContext != 0
		record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
		result = append(result, record)
	}
	return result, rows.Err()
}

func (r *PGRepository) GetContextGrant(ctx context.Context, spaceID, botID, conversationID string) (*ContextGrantRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace agent bot context grant", errors.New("workspace postgres pool is required"))
	}
	return getContextGrant(ctx, r.pool, spaceID, botID, conversationID)
}

func getContextGrant(ctx context.Context, queryer pgQueryer, spaceID, botID, conversationID string) (*ContextGrantRecord, error) {
	var record ContextGrantRecord
	var allowTrigger, allowContext int
	err := queryer.QueryRow(ctx, `SELECT grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at FROM workspace_agent_bot_context_grants WHERE bot_id = $1 AND space_id = $2 AND conversation_id = $3`, botID, spaceID, conversationID).Scan(&record.GrantID, &record.BotID, &record.SpaceID, &record.ConversationID, &allowTrigger, &allowContext, &record.MaxMessages, &record.GrantedBy, &record.CreatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.AllowTrigger, record.AllowContext = allowTrigger != 0, allowContext != 0
	record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
	return &record, nil
}

func (r *PGRepository) IsDirectConversation(ctx context.Context, spaceID, conversationID, ownerUserID, botUserID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check workspace agent bot direct conversation", errors.New("workspace postgres pool is required"))
	}
	return isDirectConversation(ctx, r.pool, spaceID, conversationID, ownerUserID, botUserID)
}

func isDirectConversation(ctx context.Context, queryer pgQueryer, spaceID, conversationID, ownerUserID, botUserID string) (bool, error) {
	var valid bool
	err := queryer.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversations c
			INNER JOIN conversation_members owner_cm ON owner_cm.conversation_id = c.id AND owner_cm.user_id = $3 AND owner_cm.removed_at IS NULL
			INNER JOIN conversation_members bot_cm ON bot_cm.conversation_id = c.id AND bot_cm.user_id = $4 AND bot_cm.removed_at IS NULL
			WHERE c.id = $2 AND c.space_id = $1 AND c.type = 'direct'
			  AND (SELECT COUNT(*) FROM conversation_members active_cm WHERE active_cm.conversation_id = c.id AND active_cm.removed_at IS NULL) = 2
		)`, spaceID, conversationID, ownerUserID, botUserID).Scan(&valid)
	return valid, err
}

func (r *PGRepository) GetGroupManager(ctx context.Context, spaceID, conversationID, actorUserID string) (*GroupConversationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("check workspace agent bot group policy", errors.New("workspace postgres pool is required"))
	}
	return getGroupManager(ctx, r.pool, spaceID, conversationID, actorUserID)
}

func getGroupManager(ctx context.Context, queryer pgQueryer, spaceID, conversationID, actorUserID string) (*GroupConversationRecord, error) {
	var record GroupConversationRecord
	err := queryer.QueryRow(ctx, `
		SELECT c.id, c.type, (cm.user_id IS NOT NULL), COALESCE(sm.role, '')
		FROM conversations c
		LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3 AND cm.removed_at IS NULL
		LEFT JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $3 AND sm.removed_at IS NULL
		WHERE c.id = $2 AND c.space_id = $1
	`, spaceID, conversationID, actorUserID).Scan(&record.ID, &record.Type, &record.IsMember, &record.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (r *PGRepository) ListTokens(ctx context.Context, spaceID, botID string) ([]TokenRecord, error) {
	if r == nil || r.pool == nil {
		return []TokenRecord{}, internalError("list workspace agent bot tokens", errors.New("workspace postgres pool is required"))
	}
	return listTokens(ctx, r.pool, spaceID, botID)
}

func scanToken(row pgx.Row) (*TokenRecord, error) {
	var record TokenRecord
	var scopesJSON string
	err := row.Scan(&record.ID, &record.BotID, &record.SpaceID, &record.TokenHash, &scopesJSON, &record.ExpiresAt, &record.RevokedAt, &record.LastUsedAt, &record.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.Scopes = parseJSONStrings(scopesJSON)
	record.CreatedAt = record.CreatedAt.UTC()
	if record.ExpiresAt != nil {
		value := record.ExpiresAt.UTC()
		record.ExpiresAt = &value
	}
	if record.RevokedAt != nil {
		value := record.RevokedAt.UTC()
		record.RevokedAt = &value
	}
	if record.LastUsedAt != nil {
		value := record.LastUsedAt.UTC()
		record.LastUsedAt = &value
	}
	return &record, nil
}

func listTokens(ctx context.Context, queryer pgQueryer, spaceID, botID string) ([]TokenRecord, error) {
	rows, err := queryer.Query(ctx, `SELECT id, bot_id, space_id, token_hash, scopes_json, expires_at, revoked_at, last_used_at, created_at FROM workspace_agent_bot_tokens WHERE bot_id = $1 AND space_id = $2 ORDER BY created_at DESC, id DESC`, botID, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]TokenRecord, 0)
	for rows.Next() {
		var record TokenRecord
		var scopesJSON string
		if err := rows.Scan(&record.ID, &record.BotID, &record.SpaceID, &record.TokenHash, &scopesJSON, &record.ExpiresAt, &record.RevokedAt, &record.LastUsedAt, &record.CreatedAt); err != nil {
			return nil, err
		}
		record.Scopes = parseJSONStrings(scopesJSON)
		record.CreatedAt = record.CreatedAt.UTC()
		if record.ExpiresAt != nil {
			value := record.ExpiresAt.UTC()
			record.ExpiresAt = &value
		}
		if record.RevokedAt != nil {
			value := record.RevokedAt.UTC()
			record.RevokedAt = &value
		}
		if record.LastUsedAt != nil {
			value := record.LastUsedAt.UTC()
			record.LastUsedAt = &value
		}
		result = append(result, record)
	}
	return result, rows.Err()
}

func (r *PGRepository) GetToken(ctx context.Context, spaceID, botID, tokenID string) (*TokenRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace agent bot token", errors.New("workspace postgres pool is required"))
	}
	return scanToken(r.pool.QueryRow(ctx, `SELECT id, bot_id, space_id, token_hash, scopes_json, expires_at, revoked_at, last_used_at, created_at FROM workspace_agent_bot_tokens WHERE id = $1 AND bot_id = $2 AND space_id = $3`, tokenID, botID, spaceID))
}

func (r *PGRepository) GetTokenByHash(ctx context.Context, tokenHash string) (*TokenAuthRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("authenticate workspace agent bot token", errors.New("workspace postgres pool is required"))
	}
	return getTokenByHash(ctx, r.pool, tokenHash)
}

func getTokenByHash(ctx context.Context, queryer pgQueryer, tokenHash string) (*TokenAuthRecord, error) {
	var record TokenAuthRecord
	var scopesJSON string
	var deletingAt, deletedAt *time.Time
	var tokenExpires, tokenRevoked, tokenUsed *time.Time
	err := queryer.QueryRow(ctx, `
		SELECT t.id, t.bot_id, t.space_id, t.token_hash, t.scopes_json, t.expires_at, t.revoked_at, t.last_used_at, t.created_at,
			b.id, b.space_id, b.owner_user_id, b.bot_user_id, b.mode, b.name, b.name_normalized,
			b.visibility_policy, b.conversation_policy, b.trigger_policy, b.status, u.github_login,
			b.created_at, b.updated_at, b.deleting_at, b.deleted_at
		FROM workspace_agent_bot_tokens t
		INNER JOIN workspace_agent_bots b ON b.id = t.bot_id AND b.space_id = t.space_id
		INNER JOIN users u ON u.id = b.bot_user_id AND u.kind = 'bot'
		WHERE t.token_hash = $1
	`, tokenHash).Scan(&record.Token.ID, &record.Token.BotID, &record.Token.SpaceID, &record.Token.TokenHash, &scopesJSON,
		&tokenExpires, &tokenRevoked, &tokenUsed, &record.Token.CreatedAt, &record.Bot.ID, &record.Bot.SpaceID,
		&record.Bot.OwnerUserID, &record.Bot.BotUserID, &record.Bot.Mode, &record.Bot.Name, &record.Bot.NameNormalized,
		&record.Bot.VisibilityPolicy, &record.Bot.ConversationPolicy, &record.Bot.TriggerPolicy, &record.Bot.Status,
		&record.Bot.GithubLogin, &record.Bot.CreatedAt, &record.Bot.UpdatedAt, &deletingAt, &deletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.Token.Scopes = parseJSONStrings(scopesJSON)
	record.Token.ExpiresAt, record.Token.RevokedAt, record.Token.LastUsedAt = tokenExpires, tokenRevoked, tokenUsed
	record.Token.CreatedAt = record.Token.CreatedAt.UTC()
	record.Bot.CreatedAt, record.Bot.UpdatedAt = record.Bot.CreatedAt.UTC(), record.Bot.UpdatedAt.UTC()
	if tokenExpires != nil {
		value := tokenExpires.UTC()
		record.Token.ExpiresAt = &value
	}
	if tokenRevoked != nil {
		value := tokenRevoked.UTC()
		record.Token.RevokedAt = &value
	}
	if tokenUsed != nil {
		value := tokenUsed.UTC()
		record.Token.LastUsedAt = &value
	}
	if deletingAt != nil {
		value := deletingAt.UTC()
		record.Bot.DeletingAt = &value
	}
	if deletedAt != nil {
		value := deletedAt.UTC()
		record.Bot.DeletedAt = &value
	}
	return &record, nil
}

func (r *PGRepository) GetSetupSession(ctx context.Context, spaceID, setupID string) (*SetupSessionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace agent bot setup session", errors.New("workspace postgres pool is required"))
	}
	return getSetupSession(ctx, r.pool, " AND space_id = $2", setupID, spaceID)
}

func (r *PGRepository) GetSetupSessionByID(ctx context.Context, setupID string) (*SetupSessionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace agent bot setup session", errors.New("workspace postgres pool is required"))
	}
	return getSetupSession(ctx, r.pool, "", setupID)
}

func scanSetup(row pgx.Row) (*SetupSessionRecord, error) {
	var record SetupSessionRecord
	var requestedScopes, approvedScopes, requestedConversations, approvedConversations, capabilities string
	err := row.Scan(&record.ID, &record.BotID, &record.SpaceID, &record.OwnerUserID, &record.Status,
		&requestedScopes, &approvedScopes, &requestedConversations, &approvedConversations, &record.ClientName,
		&record.ClientVersion, &record.ProtocolVersion, &capabilities, &record.ExpiresAt, &record.ApprovedAt,
		&record.ExchangedAt, &record.DeniedAt, &record.CreatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.RequestedScopes, record.ApprovedScopes = parseJSONStrings(requestedScopes), parseJSONStrings(approvedScopes)
	record.RequestedConversations, record.ApprovedConversations = parseJSONStrings(requestedConversations), parseJSONStrings(approvedConversations)
	record.Capabilities = parseJSONStrings(capabilities)
	record.ExpiresAt, record.CreatedAt, record.UpdatedAt = record.ExpiresAt.UTC(), record.CreatedAt.UTC(), record.UpdatedAt.UTC()
	if record.ApprovedAt != nil {
		value := record.ApprovedAt.UTC()
		record.ApprovedAt = &value
	}
	if record.ExchangedAt != nil {
		value := record.ExchangedAt.UTC()
		record.ExchangedAt = &value
	}
	if record.DeniedAt != nil {
		value := record.DeniedAt.UTC()
		record.DeniedAt = &value
	}
	return &record, nil
}

func getSetupSession(ctx context.Context, queryer pgQueryer, scopeClause, setupID string, args ...any) (*SetupSessionRecord, error) {
	query := `SELECT id, bot_id, space_id, owner_user_id, status, requested_scopes_json, approved_scopes_json, requested_conversations_json, approved_conversations_json, client_name, client_version, protocol_version, capabilities_json, expires_at, approved_at, exchanged_at, denied_at, created_at, updated_at FROM workspace_agent_bot_setup_sessions WHERE id = $1` + scopeClause
	allArgs := []any{setupID}
	allArgs = append(allArgs, args...)
	return scanSetup(queryer.QueryRow(ctx, query, allArgs...))
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID)
}
func (t *pgTx) GetBot(ctx context.Context, spaceID, botID string) (*BotRecord, error) {
	return getBot(ctx, t.tx, spaceID, botID, true)
}
func (t *pgTx) GetBotAnySpace(ctx context.Context, botID string) (*BotRecord, error) {
	return getBot(ctx, t.tx, "", botID, false)
}
func (t *pgTx) GetBotByOwner(ctx context.Context, spaceID, ownerUserID string) (*BotRecord, error) {
	return getBotByOwner(ctx, t.tx, spaceID, ownerUserID)
}

func (t *pgTx) GetConnection(ctx context.Context, botID, spaceID string) (*ConnectionRecord, error) {
	if t == nil || t.tx == nil {
		return nil, internalError("read workspace agent bot connection", errors.New("workspace transaction is required"))
	}
	var factory IDFactory
	if t.repository != nil {
		factory = t.repository.idFactory
	}
	if err := ensureConnection(ctx, t.tx, botID, spaceID, time.Now().UTC().Truncate(time.Millisecond), factory); err != nil {
		return nil, err
	}
	return getConnectionRecord(ctx, t.tx, botID, spaceID)
}

func (t *pgTx) ClearConnectionErrors(ctx context.Context, botID, spaceID string, at time.Time) (*ConnectionRecord, error) {
	if t == nil || t.tx == nil {
		return nil, internalError("clear workspace agent bot connection errors", errors.New("workspace transaction is required"))
	}
	var factory IDFactory
	if t.repository != nil {
		factory = t.repository.idFactory
	}
	if err := ensureConnection(ctx, t.tx, botID, spaceID, at, factory); err != nil {
		return nil, err
	}
	if _, err := t.tx.Exec(ctx, `
		UPDATE workspace_agent_bot_connections
		SET last_error_code = NULL, last_error_at = NULL, updated_at = $1
		WHERE bot_id = $2 AND space_id = $3
	`, at.UTC(), strings.TrimSpace(botID), strings.TrimSpace(spaceID)); err != nil {
		return nil, internalError("clear workspace agent bot connection errors", err)
	}
	return getConnectionRecord(ctx, t.tx, botID, spaceID)
}
func (t *pgTx) ListBots(ctx context.Context, spaceID, ownerUserID string) ([]BotRecord, error) {
	return listBots(ctx, t.tx, spaceID, ownerUserID)
}
func (t *pgTx) GetSettings(ctx context.Context, spaceID, botID string) (*SettingsRecord, error) {
	return getSettings(ctx, t.tx, spaceID, botID)
}
func (t *pgTx) ListGroupPolicies(ctx context.Context, spaceID, botID string) ([]GroupPolicyRecord, error) {
	return listGroupPolicies(ctx, t.tx, spaceID, botID)
}
func (t *pgTx) GetContextGrant(ctx context.Context, spaceID, botID, conversationID string) (*ContextGrantRecord, error) {
	return getContextGrant(ctx, t.tx, spaceID, botID, conversationID)
}
func (t *pgTx) IsDirectConversation(ctx context.Context, spaceID, conversationID, ownerUserID, botUserID string) (bool, error) {
	return isDirectConversation(ctx, t.tx, spaceID, conversationID, ownerUserID, botUserID)
}
func (t *pgTx) GetGroupManager(ctx context.Context, spaceID, conversationID, actorUserID string) (*GroupConversationRecord, error) {
	return getGroupManager(ctx, t.tx, spaceID, conversationID, actorUserID)
}
func (t *pgTx) ListTokens(ctx context.Context, spaceID, botID string) ([]TokenRecord, error) {
	return listTokens(ctx, t.tx, spaceID, botID)
}
func (t *pgTx) GetToken(ctx context.Context, spaceID, botID, tokenID string) (*TokenRecord, error) {
	return scanToken(t.tx.QueryRow(ctx, `SELECT id, bot_id, space_id, token_hash, scopes_json, expires_at, revoked_at, last_used_at, created_at FROM workspace_agent_bot_tokens WHERE id = $1 AND bot_id = $2 AND space_id = $3`, tokenID, botID, spaceID))
}
func (t *pgTx) GetTokenByHash(ctx context.Context, tokenHash string) (*TokenAuthRecord, error) {
	return getTokenByHash(ctx, t.tx, tokenHash)
}
func (t *pgTx) GetSetupSession(ctx context.Context, spaceID, setupID string) (*SetupSessionRecord, error) {
	return getSetupSession(ctx, t.tx, " AND space_id = $2", setupID, spaceID)
}
func (t *pgTx) GetSetupSessionByID(ctx context.Context, setupID string) (*SetupSessionRecord, error) {
	return getSetupSession(ctx, t.tx, "", setupID)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("workspace agent bot lock key is required")
	}
	_, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

func (t *pgTx) CreateBot(ctx context.Context, bot BotRecord, settings SettingsRecord) error {
	if _, err := t.tx.Exec(ctx, `INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at) VALUES ($1, NULL, $2, NULL, $3, NULL, 'bot', $4, NULL)`, bot.BotUserID, bot.GithubLogin, bot.Name, bot.CreatedAt.UTC()); err != nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `INSERT INTO workspace_agent_bots (id, space_id, owner_user_id, bot_user_id, mode, name, name_normalized, visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, bot.ID, bot.SpaceID, bot.OwnerUserID, bot.BotUserID, bot.Mode, bot.Name, bot.NameNormalized, bot.VisibilityPolicy, bot.ConversationPolicy, bot.TriggerPolicy, bot.Status, bot.CreatedAt.UTC(), bot.UpdatedAt.UTC()); err != nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at) VALUES ($1, $2, 'member', $3, NULL) ON CONFLICT (space_id, user_id) DO UPDATE SET role = 'member', removed_at = NULL`, bot.SpaceID, bot.BotUserID, bot.CreatedAt.UTC()); err != nil {
		return err
	}
	if err := t.insertSettings(ctx, settings); err != nil {
		return err
	}
	for _, userID := range settings.AllowedMemberIDs {
		if _, err := t.tx.Exec(ctx, `INSERT INTO workspace_agent_bot_visibility_members (bot_id, space_id, user_id, created_at) SELECT $1, $2, sm.user_id, $4 FROM space_members sm WHERE sm.space_id = $2 AND sm.user_id = $3 AND sm.removed_at IS NULL ON CONFLICT DO NOTHING`, bot.ID, bot.SpaceID, userID, settings.UpdatedAt.UTC()); err != nil {
			return err
		}
	}
	return nil
}

func (t *pgTx) insertSettings(ctx context.Context, settings SettingsRecord) error {
	limits := settings.Limits
	if limits.RequestsPerMinute <= 0 {
		limits.RequestsPerMinute = 30
	}
	if limits.MemberDailyRequests <= 0 {
		limits.MemberDailyRequests = 500
	}
	if limits.InputTokenLimit <= 0 {
		limits.InputTokenLimit = 32000
	}
	if limits.OutputTokenLimit <= 0 {
		limits.OutputTokenLimit = 16000
	}
	if limits.MaxConcurrency <= 0 {
		limits.MaxConcurrency = 2
	}
	if limits.EventBacklogLimit <= 0 {
		limits.EventBacklogLimit = 200
	}
	_, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_settings (
			bot_id, space_id, visibility_policy, allow_direct, allow_group, group_inviter_policy,
			require_owner_approval, proactive_enabled, trigger_policy, welcome_message, description,
			avatar_url, show_creator, max_context_messages, max_context_chars, max_context_tokens,
			context_window_seconds, include_replies, include_system_events, include_attachment_metadata,
			allow_attachment_preview, long_term_summary_enabled, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
		ON CONFLICT (bot_id) DO UPDATE SET
			space_id = EXCLUDED.space_id, visibility_policy = EXCLUDED.visibility_policy,
			allow_direct = EXCLUDED.allow_direct, allow_group = EXCLUDED.allow_group,
			group_inviter_policy = EXCLUDED.group_inviter_policy,
			require_owner_approval = EXCLUDED.require_owner_approval,
			proactive_enabled = EXCLUDED.proactive_enabled, trigger_policy = EXCLUDED.trigger_policy,
			welcome_message = EXCLUDED.welcome_message, description = EXCLUDED.description,
			avatar_url = EXCLUDED.avatar_url, show_creator = EXCLUDED.show_creator,
			max_context_messages = EXCLUDED.max_context_messages, max_context_chars = EXCLUDED.max_context_chars,
			max_context_tokens = EXCLUDED.max_context_tokens, context_window_seconds = EXCLUDED.context_window_seconds,
			include_replies = EXCLUDED.include_replies, include_system_events = EXCLUDED.include_system_events,
			include_attachment_metadata = EXCLUDED.include_attachment_metadata,
			allow_attachment_preview = EXCLUDED.allow_attachment_preview,
			long_term_summary_enabled = EXCLUDED.long_term_summary_enabled, updated_at = EXCLUDED.updated_at
	`, settings.BotID, settings.SpaceID, settings.VisibilityPolicy, boolInt(settings.AllowDirect), boolInt(settings.AllowGroup), settings.GroupInviterPolicy,
		boolInt(settings.RequireOwnerApproval), boolInt(settings.ProactiveEnabled), settings.TriggerPolicy, settings.WelcomeMessage, settings.Description,
		settings.AvatarURL, boolInt(settings.ShowCreator), settings.MaxContextMessages, settings.MaxContextChars, settings.MaxContextTokens,
		settings.ContextWindowSeconds, boolInt(settings.IncludeReplies), boolInt(settings.IncludeSystemEvents), boolInt(settings.IncludeAttachmentMetadata),
		boolInt(settings.AllowAttachmentPreview), boolInt(settings.LongTermSummaryEnabled), settings.CreatedAt.UTC(), settings.UpdatedAt.UTC())
	if err != nil {
		return err
	}
	_, err = t.tx.Exec(ctx, `INSERT INTO workspace_agent_bot_limits (bot_id, space_id, requests_per_minute, member_daily_requests, input_token_limit, output_token_limit, max_concurrency, event_backlog_limit, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (bot_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`, settings.BotID, settings.SpaceID, limits.RequestsPerMinute, limits.MemberDailyRequests, limits.InputTokenLimit, limits.OutputTokenLimit, limits.MaxConcurrency, limits.EventBacklogLimit, settings.CreatedAt.UTC(), settings.UpdatedAt.UTC())
	return err
}

func (t *pgTx) UpdateSettings(ctx context.Context, spaceID, botID, visibilityPolicy, conversationPolicy string, settings SettingsRecord, at time.Time) error {
	if _, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bots SET visibility_policy = $1, conversation_policy = $2, updated_at = $3 WHERE id = $4 AND space_id = $5`, visibilityPolicy, conversationPolicy, at.UTC(), botID, spaceID); err != nil {
		return err
	}
	settings.BotID, settings.SpaceID, settings.VisibilityPolicy, settings.UpdatedAt = botID, spaceID, visibilityPolicy, at
	return t.insertSettings(ctx, settings)
}

func (t *pgTx) ReplaceVisibilityMembers(ctx context.Context, spaceID, botID string, userIDs []string, at time.Time) error {
	if _, err := t.tx.Exec(ctx, `DELETE FROM workspace_agent_bot_visibility_members WHERE bot_id = $1 AND space_id = $2`, botID, spaceID); err != nil {
		return err
	}
	for _, userID := range userIDs {
		if _, err := t.tx.Exec(ctx, `INSERT INTO workspace_agent_bot_visibility_members (bot_id, space_id, user_id, created_at) SELECT $1, $2, sm.user_id, $4 FROM space_members sm WHERE sm.space_id = $2 AND sm.user_id = $3 AND sm.removed_at IS NULL ON CONFLICT DO NOTHING`, botID, spaceID, userID, at.UTC()); err != nil {
			return err
		}
	}
	return nil
}

func (t *pgTx) UpsertGroupPolicy(ctx context.Context, policy GroupPolicyRecord) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO workspace_agent_bot_group_policies (bot_id, space_id, conversation_id, status, invited_by, approved_by, max_context_messages, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (bot_id, conversation_id) DO UPDATE SET status = EXCLUDED.status, invited_by = EXCLUDED.invited_by, approved_by = EXCLUDED.approved_by, max_context_messages = EXCLUDED.max_context_messages, updated_at = EXCLUDED.updated_at`, policy.BotID, policy.SpaceID, policy.ConversationID, policy.Status, policy.InvitedBy, policy.ApprovedBy, policy.MaxContextMessages, policy.CreatedAt.UTC(), policy.UpdatedAt.UTC())
	return err
}

func (t *pgTx) UpsertContextGrant(ctx context.Context, grant ContextGrantRecord) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO workspace_agent_bot_context_grants (grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (bot_id, conversation_id) DO UPDATE SET allow_trigger = EXCLUDED.allow_trigger, allow_context = EXCLUDED.allow_context, max_messages = EXCLUDED.max_messages, granted_by = EXCLUDED.granted_by, updated_at = EXCLUDED.updated_at`, grant.GrantID, grant.BotID, grant.SpaceID, grant.ConversationID, boolInt(grant.AllowTrigger), boolInt(grant.AllowContext), grant.MaxMessages, grant.GrantedBy, grant.CreatedAt.UTC(), grant.UpdatedAt.UTC())
	return err
}

func (t *pgTx) SetConversationMember(ctx context.Context, conversationID, botUserID string, active bool, at time.Time) error {
	removedAt := any(at.UTC())
	if active {
		removedAt = nil
	}
	_, err := t.tx.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES ($1, $2, $3, $4) ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = EXCLUDED.removed_at`, conversationID, botUserID, at.UTC(), removedAt)
	return err
}

func (t *pgTx) TransitionBot(ctx context.Context, spaceID, botID, ownerUserID, targetStatus string, fromStatuses []string, at time.Time) (*BotRecord, bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bots SET status = $1, deleting_at = CASE WHEN $1 = 'deleting' THEN $2 ELSE deleting_at END, deleted_at = CASE WHEN $1 = 'deleted' THEN $2 ELSE deleted_at END, updated_at = $2 WHERE id = $3 AND space_id = $4 AND owner_user_id = $5 AND status = ANY($6::text[])`, targetStatus, at.UTC(), botID, spaceID, ownerUserID, fromStatuses)
	if err != nil {
		return nil, false, err
	}
	if result.RowsAffected() == 0 {
		current, readErr := getBot(ctx, t.tx, spaceID, botID, true)
		return current, false, readErr
	}
	updated, err := getBot(ctx, t.tx, spaceID, botID, true)
	return updated, true, err
}

func (t *pgTx) RevokeBotTokens(ctx context.Context, botID string, at time.Time) error {
	_, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE bot_id = $1`, botID, at.UTC())
	return err
}

func (t *pgTx) RevokePendingSetupSessions(ctx context.Context, botID string, at time.Time) (int64, error) {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_setup_sessions SET status = 'revoked', updated_at = $2 WHERE bot_id = $1 AND status IN ('created', 'awaiting_user', 'approved')`, botID, at.UTC())
	return result.RowsAffected(), err
}

func (t *pgTx) RemoveBotMembership(ctx context.Context, spaceID, botUserID string, at time.Time) error {
	_, err := t.tx.Exec(ctx, `UPDATE space_members SET removed_at = COALESCE(removed_at, $3) WHERE space_id = $1 AND user_id = $2`, spaceID, botUserID, at.UTC())
	return err
}

func (t *pgTx) InsertToken(ctx context.Context, token TokenRecord) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO workspace_agent_bot_tokens (id, bot_id, space_id, token_hash, scopes_json, expires_at, revoked_at, last_used_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7)`, token.ID, token.BotID, token.SpaceID, token.TokenHash, normalizeTokenScopesJSON(token.Scopes), token.ExpiresAt, token.CreatedAt.UTC())
	return err
}

func (t *pgTx) RevokeToken(ctx context.Context, spaceID, botID, tokenID string, at time.Time) (*TokenRecord, bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET revoked_at = COALESCE(revoked_at, $1) WHERE id = $2 AND bot_id = $3 AND space_id = $4`, at.UTC(), tokenID, botID, spaceID)
	if err != nil {
		return nil, false, err
	}
	if result.RowsAffected() == 0 {
		token, readErr := scanToken(t.tx.QueryRow(ctx, `SELECT id, bot_id, space_id, token_hash, scopes_json, expires_at, revoked_at, last_used_at, created_at FROM workspace_agent_bot_tokens WHERE id = $1 AND bot_id = $2 AND space_id = $3`, tokenID, botID, spaceID))
		return token, token != nil, readErr
	}
	token, err := scanToken(t.tx.QueryRow(ctx, `SELECT id, bot_id, space_id, token_hash, scopes_json, expires_at, revoked_at, last_used_at, created_at FROM workspace_agent_bot_tokens WHERE id = $1 AND bot_id = $2 AND space_id = $3`, tokenID, botID, spaceID))
	return token, token != nil, err
}

func (t *pgTx) MarkTokenUsed(ctx context.Context, tokenID, botID string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET last_used_at = $1 WHERE id = $2 AND bot_id = $3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $1) AND EXISTS (SELECT 1 FROM workspace_agent_bots WHERE id = $3 AND status = 'active')`, at.UTC(), tokenID, botID)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) InsertSetupSession(ctx context.Context, session SetupSessionRecord) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO workspace_agent_bot_setup_sessions (id, bot_id, space_id, owner_user_id, status, requested_scopes_json, approved_scopes_json, requested_conversations_json, approved_conversations_json, client_name, client_version, protocol_version, capabilities_json, expires_at, approved_at, exchanged_at, denied_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, '[]', $7, '[]', NULL, NULL, $8, '[]', $9, NULL, NULL, NULL, $10, $10)`, session.ID, session.BotID, session.SpaceID, session.OwnerUserID, session.Status, normalizeTokenScopesJSON(session.RequestedScopes), normalizeTokenScopesJSON(session.RequestedConversations), session.ProtocolVersion, session.ExpiresAt.UTC(), session.CreatedAt.UTC())
	return err
}

func (t *pgTx) UpdateSetupRequest(ctx context.Context, setupID string, expectedStatuses []string, requestedScopes, requestedConversations []string, clientName, clientVersion, protocolVersion string, capabilities []string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_setup_sessions SET status = 'awaiting_user', requested_scopes_json = $1, requested_conversations_json = $2, client_name = COALESCE(NULLIF($3, ''), client_name), client_version = COALESCE(NULLIF($4, ''), client_version), protocol_version = $5, capabilities_json = $6, updated_at = $7 WHERE id = $8 AND status = ANY($9::text[]) AND expires_at > $7`, normalizeTokenScopesJSON(requestedScopes), normalizeTokenScopesJSON(requestedConversations), clientName, clientVersion, protocolVersion, normalizeTokenScopesJSON(capabilities), at.UTC(), setupID, expectedStatuses)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) ApproveSetupSession(ctx context.Context, setupID string, expectedStatuses []string, approvedScopes, approvedConversations []string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_setup_sessions SET status = 'approved', approved_scopes_json = $1, approved_conversations_json = $2, approved_at = $3, updated_at = $3 WHERE id = $4 AND status = ANY($5::text[]) AND expires_at > $3`, normalizeTokenScopesJSON(approvedScopes), normalizeTokenScopesJSON(approvedConversations), at.UTC(), setupID, expectedStatuses)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) DenySetupSession(ctx context.Context, setupID string, expectedStatuses []string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_setup_sessions SET status = 'denied', denied_at = $1, updated_at = $1 WHERE id = $2 AND status = ANY($3::text[]) AND expires_at > $1`, at.UTC(), setupID, expectedStatuses)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) ExchangeSetupSession(ctx context.Context, setupID string, expectedStatuses []string, clientName, clientVersion, protocolVersion string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_setup_sessions SET status = 'exchanged', client_name = COALESCE(NULLIF($1, ''), client_name), client_version = COALESCE(NULLIF($2, ''), client_version), protocol_version = $3, exchanged_at = $4, updated_at = $4 WHERE id = $5 AND status = ANY($6::text[])`, clientName, clientVersion, protocolVersion, at.UTC(), setupID, expectedStatuses)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) ExpireSetupSession(ctx context.Context, setupID string, expectedStatuses []string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE workspace_agent_bot_setup_sessions SET status = 'expired', updated_at = $1 WHERE id = $2 AND status = ANY($3::text[]) AND expires_at <= $1`, at.UTC(), setupID, expectedStatuses)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" || strings.TrimSpace(input.Result) == "" || input.CreatedAt.IsZero() {
		return errors.New("workspace agent bot audit fields are required")
	}
	if strings.TrimSpace(input.ID) == "" {
		factory := defaultIDFactory
		if t.repository != nil && t.repository.idFactory != nil {
			factory = t.repository.idFactory
		}
		id, err := factory()
		if err != nil {
			return err
		}
		input.ID = "audit_" + strings.TrimSpace(id)
	}
	meta := (auth.RequestMeta{RequestID: input.RequestID, IPAddress: input.IPAddress, UserAgent: input.UserAgent}).Safe()
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, ip_address, user_agent, request_id, created_at) VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, input.Result, input.Reason, meta.IPAddress, meta.UserAgent, meta.RequestID, input.CreatedAt.UTC())
	return err
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

var _ Repository = (*PGRepository)(nil)
var _ Tx = (*pgTx)(nil)
