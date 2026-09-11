package topics

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
)

type PGRepository struct {
	pool         *pgxpool.Pool
	idFactory    IDFactory
	jobScheduler messagejobs.PGScheduler
}

// SharedMessageTransaction exposes the existing transaction only to the
// message/topic composition adapter. The topic operation keeps commit ownership.
func (t *pgTx) SharedMessageTransaction() pgx.Tx { return t.tx }

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

func NewPGRepositoryWithMessageJobs(pool *pgxpool.Pool, scheduler messagejobs.PGScheduler, idFactories ...IDFactory) *PGRepository {
	repository := NewPGRepository(pool, idFactories...)
	repository.jobScheduler = scheduler
	return repository
}

// NewTransaction exposes only topic operations and keeps the configured job
// scheduler. It never begins, commits or rolls back the caller's transaction.
func (r *PGRepository) NewTransaction(tx pgx.Tx) Tx {
	if r == nil || tx == nil {
		return nil
	}
	return &pgTx{tx: tx, idFactory: r.idFactory, jobScheduler: r.jobScheduler}
}

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return internalError("ping workspace topic database", errors.New("workspace postgres pool is required"))
	}
	if err := r.pool.Ping(ctx); err != nil {
		return internalError("ping workspace topic database", err)
	}
	return nil
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin workspace topic transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin workspace topic transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin workspace topic transaction", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()
	adapter := r.NewTransaction(tx)
	if err := callback(adapter); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return internalError("commit workspace topic transaction", err)
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup topic actor", errors.New("workspace postgres pool is required"))
	}
	return lookupActor(ctx, r.pool, spaceID, userID)
}

func (r *PGRepository) GetConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find topic conversation", errors.New("workspace postgres pool is required"))
	}
	return getConversation(ctx, r.pool, spaceID, conversationID)
}

func (r *PGRepository) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check topic conversation membership", errors.New("workspace postgres pool is required"))
	}
	return conversationMemberActive(ctx, r.pool, spaceID, conversationID, userID)
}

func (r *PGRepository) ListTopics(ctx context.Context, query TopicListQuery) ([]TopicRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace topics", errors.New("workspace postgres pool is required"))
	}
	return listTopics(ctx, r.pool, query)
}

func (r *PGRepository) GetTopic(ctx context.Context, spaceID, topicID, viewerID string) (*TopicRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find workspace topic", errors.New("workspace postgres pool is required"))
	}
	return getTopic(ctx, r.pool, spaceID, topicID, viewerID)
}

func (r *PGRepository) GetTopicByIdempotency(ctx context.Context, spaceID, actorID, key string) (*TopicRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find idempotent workspace topic", errors.New("workspace postgres pool is required"))
	}
	if strings.TrimSpace(key) == "" {
		return nil, nil
	}
	return getTopicByIdempotency(ctx, r.pool, spaceID, actorID, key)
}

func (r *PGRepository) GetTopicMember(ctx context.Context, spaceID, topicID, userID string) (*TopicMemberRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find topic member", errors.New("workspace postgres pool is required"))
	}
	return getTopicMember(ctx, r.pool, spaceID, topicID, userID)
}

func (r *PGRepository) ListTopicMembers(ctx context.Context, spaceID, topicID, viewerID string) ([]TopicMemberRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list topic members", errors.New("workspace postgres pool is required"))
	}
	return listTopicMembers(ctx, r.pool, spaceID, topicID, viewerID)
}

func (r *PGRepository) ListTopicMessages(ctx context.Context, query TopicMessageListQuery) ([]TopicMessageRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list topic messages", errors.New("workspace postgres pool is required"))
	}
	return listTopicMessages(ctx, r.pool, query)
}

func (r *PGRepository) GetTopicMessage(ctx context.Context, spaceID, topicID, messageID string) (*TopicMessageRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find topic message", errors.New("workspace postgres pool is required"))
	}
	return getTopicMessage(ctx, r.pool, spaceID, topicID, messageID)
}

func (r *PGRepository) GetTopicMessageByClientID(ctx context.Context, spaceID, topicID, actorID, clientID string) (*TopicMessageRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find idempotent topic message", errors.New("workspace postgres pool is required"))
	}
	return getTopicMessageByClientID(ctx, r.pool, spaceID, topicID, actorID, clientID)
}

func (r *PGRepository) TopicUnread(ctx context.Context, spaceID, topicID, actorID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count topic unread messages", errors.New("workspace postgres pool is required"))
	}
	return topicUnread(ctx, r.pool, spaceID, topicID, actorID)
}

func (r *PGRepository) MessageEventSeq(ctx context.Context, spaceID, messageID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("find topic message event sequence", errors.New("workspace postgres pool is required"))
	}
	return messageEventSeq(ctx, r.pool, spaceID, messageID)
}

func (r *PGRepository) ListTopicProjections(ctx context.Context, spaceID, topicID, viewerID string, limit int) ([]ProjectionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list topic projections", errors.New("workspace postgres pool is required"))
	}
	return listTopicProjections(ctx, r.pool, spaceID, topicID, viewerID, limit)
}

func (r *PGRepository) GetActiveProjection(ctx context.Context, spaceID, topicID, messageID string) (*ProjectionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find topic projection", errors.New("workspace postgres pool is required"))
	}
	return getActiveProjection(ctx, r.pool, spaceID, topicID, messageID)
}

type pgQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
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
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName, &nickname, &avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &joinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("lookup topic actor", err)
	}
	actor.GitHubID = stringValue(githubID)
	actor.Email = stringValue(email)
	actor.Nickname = stringValue(nickname)
	actor.AvatarURL = stringValue(avatarURL)
	actor.JoinedAt = joinedAt.UTC()
	return &actor, nil
}

func getConversation(ctx context.Context, queryer pgQueryer, spaceID, conversationID string) (*ConversationRecord, error) {
	var record ConversationRecord
	err := queryer.QueryRow(ctx, `SELECT id, space_id, type, retention_count FROM conversations WHERE id = $1 AND space_id = $2`, conversationID, spaceID).Scan(&record.ID, &record.SpaceID, &record.Type, &record.RetentionCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find topic conversation", err)
	}
	return &record, nil
}

func conversationMemberActive(ctx context.Context, queryer pgQueryer, spaceID, conversationID, userID string) (bool, error) {
	var active bool
	err := queryer.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM conversation_members cm
		INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
		INNER JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = cm.user_id AND sm.removed_at IS NULL
		WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
	)`, spaceID, conversationID, userID).Scan(&active)
	if err != nil {
		return false, internalError("check topic conversation membership", err)
	}
	return active, nil
}

const topicProjectionSelect = `
	SELECT t.id, t.space_id, t.conversation_id, t.title, t.description,
	       t.created_by, t.status, t.allow_sync_to_group, t.revision,
	       t.created_at, t.updated_at, t.closed_at, t.archived_at,
	       u.display_name, u.nickname, u.github_login, u.avatar_url,
	       ur.remark,
	       (SELECT COUNT(*) FROM topic_members active_tm WHERE active_tm.topic_id = t.id AND active_tm.left_at IS NULL),
	       EXISTS (SELECT 1 FROM topic_members viewer_tm WHERE viewer_tm.topic_id = t.id AND viewer_tm.user_id = $3 AND viewer_tm.left_at IS NULL),
	       viewer_tm.last_read_message_id, COALESCE(viewer_tm.last_read_seq, 0), COALESCE(viewer_tm.notification_level, 'all')
	FROM topics t
	INNER JOIN users u ON u.id = t.created_by
	LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = t.created_by
	LEFT JOIN topic_members viewer_tm ON viewer_tm.topic_id = t.id AND viewer_tm.user_id = $3
	WHERE t.space_id = $1 AND t.id = $2
`

func getTopic(ctx context.Context, queryer pgQueryer, spaceID, topicID, viewerID string) (*TopicRecord, error) {
	var record TopicRecord
	var closedAt, archivedAt *time.Time
	var creatorNickname, creatorAvatar, creatorRemark, lastRead *string
	err := queryer.QueryRow(ctx, topicProjectionSelect, spaceID, topicID, viewerID).Scan(
		&record.ID, &record.SpaceID, &record.ConversationID, &record.Title, &record.Description,
		&record.CreatedBy, &record.Status, &record.AllowSyncToGroup, &record.Revision,
		&record.CreatedAt, &record.UpdatedAt, &closedAt, &archivedAt,
		&record.CreatorDisplayName, &creatorNickname, &record.CreatorGitHubLogin, &creatorAvatar,
		&creatorRemark, &record.ParticipantCount, &record.Joined, &lastRead, &record.LastReadSeq, &record.NotificationLevel,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find workspace topic", err)
	}
	record.ClosedAt, record.ArchivedAt = closedAt, archivedAt
	record.CreatorNickname, record.CreatorAvatarURL, record.CreatorRemark = creatorNickname, creatorAvatar, creatorRemark
	record.LastReadMessageID = lastRead
	return &record, nil
}

func getTopicByIdempotency(ctx context.Context, queryer pgQueryer, spaceID, actorID, key string) (*TopicRecord, error) {
	var topicID string
	err := queryer.QueryRow(ctx, `SELECT id FROM topics WHERE space_id = $1 AND created_by = $2 AND idempotency_key = $3`, spaceID, actorID, key).Scan(&topicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find idempotent workspace topic", err)
	}
	return getTopic(ctx, queryer, spaceID, topicID, actorID)
}

func listTopics(ctx context.Context, queryer pgQueryer, query TopicListQuery) ([]TopicRecord, error) {
	limit := query.Limit
	if limit < 1 || limit > MaxTopicLimit {
		limit = DefaultTopicLimit
	}
	params := []any{query.SpaceID, query.ActorID, query.ActorID}
	where := []string{
		"t.space_id = $1",
		"EXISTS (SELECT 1 FROM conversation_members actor_cm WHERE actor_cm.conversation_id = t.conversation_id AND actor_cm.user_id = $2 AND actor_cm.removed_at IS NULL)",
		"EXISTS (SELECT 1 FROM space_members actor_sm WHERE actor_sm.space_id = t.space_id AND actor_sm.user_id = $3 AND actor_sm.removed_at IS NULL)",
	}
	if query.ConversationID != "" {
		params = append(params, query.ConversationID)
		where = append(where, "t.conversation_id = $"+itoa(len(params)))
	}
	if query.Status != "" {
		params = append(params, query.Status)
		where = append(where, "t.status = $"+itoa(len(params)))
	} else {
		where = append(where, "t.status <> 'archived'")
	}
	if query.Mine {
		params = append(params, query.ActorID, query.ActorID)
		where = append(where, "(t.created_by = $"+itoa(len(params)-1)+" OR EXISTS (SELECT 1 FROM topic_members mine_tm WHERE mine_tm.topic_id = t.id AND mine_tm.user_id = $"+itoa(len(params))+"))")
	}
	params = append(params, limit)
	queryText := `
		SELECT t.id, t.space_id, t.conversation_id, t.title, t.description,
		       t.created_by, t.status, t.allow_sync_to_group, t.revision,
		       t.created_at, t.updated_at, t.closed_at, t.archived_at,
		       u.display_name, u.nickname, u.github_login, u.avatar_url, ur.remark,
		       (SELECT COUNT(*) FROM topic_members active_tm WHERE active_tm.topic_id = t.id AND active_tm.left_at IS NULL),
		       EXISTS (SELECT 1 FROM topic_members viewer_tm2 WHERE viewer_tm2.topic_id = t.id AND viewer_tm2.user_id = $2 AND viewer_tm2.left_at IS NULL),
		       viewer_tm.last_read_message_id, COALESCE(viewer_tm.last_read_seq, 0), COALESCE(viewer_tm.notification_level, 'all')
		FROM topics t
		INNER JOIN users u ON u.id = t.created_by
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $2 AND ur.target_user_id = t.created_by
		LEFT JOIN topic_members viewer_tm ON viewer_tm.topic_id = t.id AND viewer_tm.user_id = $2
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY CASE t.status WHEN 'open' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END, t.updated_at DESC, t.id DESC
		LIMIT $` + itoa(len(params))
	rows, err := queryer.Query(ctx, queryText, params...)
	if err != nil {
		return nil, internalError("list workspace topics", err)
	}
	defer rows.Close()
	result := make([]TopicRecord, 0, limit)
	for rows.Next() {
		record, err := scanTopicRecord(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan workspace topics", err)
	}
	return result, nil
}

type rowScanner interface{ Scan(...any) error }

func scanTopicRecord(row rowScanner) (TopicRecord, error) {
	var record TopicRecord
	var closedAt, archivedAt *time.Time
	var creatorNickname, creatorAvatar, creatorRemark, lastRead *string
	err := row.Scan(&record.ID, &record.SpaceID, &record.ConversationID, &record.Title, &record.Description,
		&record.CreatedBy, &record.Status, &record.AllowSyncToGroup, &record.Revision,
		&record.CreatedAt, &record.UpdatedAt, &closedAt, &archivedAt,
		&record.CreatorDisplayName, &creatorNickname, &record.CreatorGitHubLogin, &creatorAvatar, &creatorRemark,
		&record.ParticipantCount, &record.Joined, &lastRead, &record.LastReadSeq, &record.NotificationLevel)
	if err != nil {
		return TopicRecord{}, internalError("scan workspace topic", err)
	}
	record.ClosedAt, record.ArchivedAt = closedAt, archivedAt
	record.CreatorNickname, record.CreatorAvatarURL, record.CreatorRemark = creatorNickname, creatorAvatar, creatorRemark
	record.LastReadMessageID = lastRead
	return record, nil
}

func getTopicMember(ctx context.Context, queryer pgQueryer, spaceID, topicID, userID string) (*TopicMemberRecord, error) {
	var record TopicMemberRecord
	var nickname, avatar, remark *string
	var leftTime *time.Time
	err := queryer.QueryRow(ctx, `
		SELECT tm.user_id, tm.joined_at, tm.left_at, tm.notification_level,
		       u.display_name, u.nickname, u.github_login, u.avatar_url, u.kind,
		       ur.remark
		FROM topic_members tm
		INNER JOIN topics t ON t.id = tm.topic_id AND t.space_id = $1
		INNER JOIN users u ON u.id = tm.user_id
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = u.id
		WHERE tm.topic_id = $2 AND tm.user_id = $3
	`, spaceID, topicID, userID).Scan(&record.UserID, &record.JoinedAt, &leftTime, &record.NotificationLevel, &record.DisplayName, &nickname, &record.GitHubLogin, &avatar, &record.Kind, &remark)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find topic member", err)
	}
	record.LeftAt, record.Nickname, record.AvatarURL, record.Remark = leftTime, nickname, avatar, remark
	return &record, nil
}

func listTopicMembers(ctx context.Context, queryer pgQueryer, spaceID, topicID, viewerID string) ([]TopicMemberRecord, error) {
	rows, err := queryer.Query(ctx, `
		SELECT tm.user_id, tm.joined_at, tm.left_at, tm.notification_level,
		       u.display_name, u.nickname, u.github_login, u.avatar_url, u.kind,
		       ur.remark
		FROM topic_members tm
		INNER JOIN topics t ON t.id = tm.topic_id AND t.space_id = $1
		INNER JOIN users u ON u.id = tm.user_id
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = u.id
		WHERE tm.topic_id = $2 AND tm.left_at IS NULL
		ORDER BY tm.joined_at ASC, tm.user_id ASC
	`, spaceID, topicID, viewerID)
	if err != nil {
		return nil, internalError("list topic members", err)
	}
	defer rows.Close()
	result := make([]TopicMemberRecord, 0)
	for rows.Next() {
		var record TopicMemberRecord
		var leftAt *time.Time
		var nickname, avatar, remark *string
		if err := rows.Scan(&record.UserID, &record.JoinedAt, &leftAt, &record.NotificationLevel, &record.DisplayName, &nickname, &record.GitHubLogin, &avatar, &record.Kind, &remark); err != nil {
			return nil, internalError("scan topic members", err)
		}
		record.LeftAt, record.Nickname, record.AvatarURL, record.Remark = leftAt, nickname, avatar, remark
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan topic members", err)
	}
	return result, nil
}

const topicMessageSelect = `
	SELECT m.id, m.space_id, m.conversation_id, m.topic_id, m.author_id,
	       m.author_kind, m.kind, m.client_message_id, m.content_format,
	       m.content_json, m.plain_text, m.reply_to_message_id, m.created_at,
	       m.edited_at, m.deleted_at, m.recalled_at,
	       u.display_name, u.nickname, u.github_login, u.avatar_url, ur.remark,
	       COALESCE((SELECT MAX(we.seq) FROM workspace_events we WHERE we.space_id = m.space_id AND we.target_id = m.id AND we.type IN ('topic.message.created', 'message.created')), 0)
	FROM messages m
	LEFT JOIN users u ON u.id = m.author_id
	LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = m.author_id
`

func getTopicMessage(ctx context.Context, queryer pgQueryer, spaceID, topicID, messageID string) (*TopicMessageRecord, error) {
	row := queryer.QueryRow(ctx, topicMessageSelect+` WHERE m.space_id = $1 AND m.topic_id = $2 AND m.id = $4`, spaceID, topicID, "", messageID)
	record, err := scanTopicMessage(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find topic message", err)
	}
	return &record, nil
}

func getTopicMessageByClientID(ctx context.Context, queryer pgQueryer, spaceID, topicID, actorID, clientID string) (*TopicMessageRecord, error) {
	row := queryer.QueryRow(ctx, topicMessageSelect+` WHERE m.space_id = $1 AND m.topic_id = $2 AND m.author_id = $4 AND m.client_message_id = $5`, spaceID, topicID, actorID, actorID, clientID)
	record, err := scanTopicMessage(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find idempotent topic message", err)
	}
	return &record, nil
}

func scanTopicMessage(row rowScanner) (TopicMessageRecord, error) {
	var record TopicMessageRecord
	var authorID, clientID, replyID *string
	var topicID *string
	var authorNickname, authorAvatar, authorRemark *string
	err := row.Scan(&record.ID, &record.SpaceID, &record.ConversationID, &topicID, &authorID, &record.AuthorKind, &record.Kind, &clientID, &record.ContentFormat, &record.ContentJSON, &record.PlainText, &replyID, &record.CreatedAt, &record.EditedAt, &record.DeletedAt, &record.RecalledAt, &record.AuthorDisplayName, &authorNickname, &record.AuthorGitHubLogin, &authorAvatar, &authorRemark, &record.EventSeq)
	if err != nil {
		return TopicMessageRecord{}, err
	}
	record.TopicID, record.AuthorID, record.ClientMessageID, record.ReplyToMessageID = stringValue(topicID), authorID, clientID, replyID
	record.AuthorNickname, record.AuthorAvatarURL, record.AuthorRemark = authorNickname, authorAvatar, authorRemark
	return record, nil
}

func listTopicMessages(ctx context.Context, queryer pgQueryer, query TopicMessageListQuery) ([]TopicMessageRecord, error) {
	limit := query.Limit
	if limit < 1 || limit > MaxMessageLimit {
		limit = DefaultMessageLimit
	}
	params := []any{query.SpaceID, query.TopicID, query.ViewerID}
	filter := ""
	order := "DESC"
	if query.Before != nil {
		params = append(params, query.Before.CreatedAt, query.Before.CreatedAt, query.Before.ID)
		filter = " AND (m.created_at < $4 OR (m.created_at = $5 AND m.id < $6))"
	} else if query.After != nil {
		params = append(params, query.After.CreatedAt, query.After.CreatedAt, query.After.ID)
		filter = " AND (m.created_at > $4 OR (m.created_at = $5 AND m.id > $6))"
		order = "ASC"
	}
	params = append(params, limit)
	text := topicMessageSelect + ` WHERE m.space_id = $1 AND m.topic_id = $2 AND m.deleted_at IS NULL` + filter + ` ORDER BY m.created_at ` + order + `, m.id ` + order + ` LIMIT $` + itoa(len(params))
	rows, err := queryer.Query(ctx, text, params...)
	if err != nil {
		return nil, internalError("list topic messages", err)
	}
	defer rows.Close()
	result := make([]TopicMessageRecord, 0, limit)
	for rows.Next() {
		record, err := scanTopicMessage(rows)
		if err != nil {
			return nil, internalError("scan topic message", err)
		}
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan topic messages", err)
	}
	return result, nil
}

func topicUnread(ctx context.Context, queryer pgQueryer, spaceID, topicID, actorID string) (int64, error) {
	var count int64
	err := queryer.QueryRow(ctx, `
		SELECT COUNT(*) FROM messages m
		INNER JOIN topic_members tm ON tm.topic_id = m.topic_id AND tm.user_id = $3 AND tm.left_at IS NULL
		LEFT JOIN messages marker ON marker.id = tm.last_read_message_id AND marker.topic_id = m.topic_id
		WHERE m.space_id = $1 AND m.topic_id = $2 AND m.deleted_at IS NULL
		  AND (m.author_id IS NULL OR m.author_id <> $3)
		  AND (tm.last_read_message_id IS NULL OR marker.id IS NULL OR m.created_at > marker.created_at OR (m.created_at = marker.created_at AND m.id > marker.id))
	`, spaceID, topicID, actorID).Scan(&count)
	if err != nil {
		return 0, internalError("count topic unread messages", err)
	}
	return count, nil
}

func messageEventSeq(ctx context.Context, queryer pgQueryer, spaceID, messageID string) (int64, error) {
	var sequence int64
	err := queryer.QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0) FROM workspace_events WHERE space_id = $1 AND target_id = $2 AND type IN ('topic.message.created', 'message.created')`, spaceID, messageID).Scan(&sequence)
	if err != nil {
		return 0, internalError("find topic message event sequence", err)
	}
	return sequence, nil
}

func listTopicProjections(ctx context.Context, queryer pgQueryer, spaceID, topicID, viewerID string, limit int) ([]ProjectionRecord, error) {
	if limit < 1 || limit > MaxMessageLimit {
		limit = 100
	}
	rows, err := queryer.Query(ctx, `
		SELECT p.id, p.topic_id, p.topic_message_id, p.group_conversation_id,
		       p.group_message_id, p.projection_type, p.created_at, p.updated_at, p.removed_at
		FROM topic_group_projections p
		INNER JOIN topics t ON t.id = p.topic_id AND t.space_id = $1
		WHERE p.topic_id = $2
		ORDER BY p.created_at DESC, p.id DESC LIMIT $3
	`, spaceID, topicID, limit)
	if err != nil {
		return nil, internalError("list topic projections", err)
	}
	defer rows.Close()
	result := make([]ProjectionRecord, 0, limit)
	for rows.Next() {
		var item ProjectionRecord
		if err := rows.Scan(&item.ID, &item.TopicID, &item.TopicMessageID, &item.GroupConversationID, &item.GroupMessageID, &item.ProjectionType, &item.CreatedAt, &item.UpdatedAt, &item.RemovedAt); err != nil {
			return nil, internalError("scan topic projections", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan topic projections", err)
	}
	_ = viewerID
	return result, nil
}

func getActiveProjection(ctx context.Context, queryer pgQueryer, spaceID, topicID, messageID string, includeRemoved ...bool) (*ProjectionRecord, error) {
	active := " AND p.removed_at IS NULL"
	if len(includeRemoved) > 0 && includeRemoved[0] {
		active = ""
	}
	var item ProjectionRecord
	err := queryer.QueryRow(ctx, `
		SELECT p.id, p.topic_id, p.topic_message_id, p.group_conversation_id,
		       p.group_message_id, p.projection_type, p.created_at, p.updated_at, p.removed_at
		FROM topic_group_projections p
		INNER JOIN topics t ON t.id = p.topic_id AND t.space_id = $1
		WHERE p.topic_id = $2 AND p.topic_message_id = $3
	`+active, spaceID, topicID, messageID).Scan(&item.ID, &item.TopicID, &item.TopicMessageID, &item.GroupConversationID, &item.GroupMessageID, &item.ProjectionType, &item.CreatedAt, &item.UpdatedAt, &item.RemovedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find topic projection", err)
	}
	return &item, nil
}

type pgTx struct {
	tx           pgx.Tx
	idFactory    IDFactory
	jobScheduler messagejobs.PGScheduler
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
func (t *pgTx) ListTopics(ctx context.Context, query TopicListQuery) ([]TopicRecord, error) {
	return listTopics(ctx, t.tx, query)
}
func (t *pgTx) GetTopic(ctx context.Context, spaceID, topicID, viewerID string) (*TopicRecord, error) {
	return getTopic(ctx, t.tx, spaceID, topicID, viewerID)
}
func (t *pgTx) GetTopicByIdempotency(ctx context.Context, spaceID, actorID, key string) (*TopicRecord, error) {
	return getTopicByIdempotency(ctx, t.tx, spaceID, actorID, key)
}
func (t *pgTx) GetTopicMember(ctx context.Context, spaceID, topicID, userID string) (*TopicMemberRecord, error) {
	return getTopicMember(ctx, t.tx, spaceID, topicID, userID)
}
func (t *pgTx) ListTopicMembers(ctx context.Context, spaceID, topicID, viewerID string) ([]TopicMemberRecord, error) {
	return listTopicMembers(ctx, t.tx, spaceID, topicID, viewerID)
}
func (t *pgTx) ListTopicMessages(ctx context.Context, query TopicMessageListQuery) ([]TopicMessageRecord, error) {
	return listTopicMessages(ctx, t.tx, query)
}
func (t *pgTx) GetTopicMessage(ctx context.Context, spaceID, topicID, messageID string) (*TopicMessageRecord, error) {
	return getTopicMessage(ctx, t.tx, spaceID, topicID, messageID)
}
func (t *pgTx) GetTopicMessageByClientID(ctx context.Context, spaceID, topicID, actorID, clientID string) (*TopicMessageRecord, error) {
	return getTopicMessageByClientID(ctx, t.tx, spaceID, topicID, actorID, clientID)
}
func (t *pgTx) TopicUnread(ctx context.Context, spaceID, topicID, actorID string) (int64, error) {
	return topicUnread(ctx, t.tx, spaceID, topicID, actorID)
}
func (t *pgTx) MessageEventSeq(ctx context.Context, spaceID, messageID string) (int64, error) {
	return messageEventSeq(ctx, t.tx, spaceID, messageID)
}
func (t *pgTx) ListTopicProjections(ctx context.Context, spaceID, topicID, viewerID string, limit int) ([]ProjectionRecord, error) {
	return listTopicProjections(ctx, t.tx, spaceID, topicID, viewerID, limit)
}
func (t *pgTx) GetActiveProjection(ctx context.Context, spaceID, topicID, messageID string) (*ProjectionRecord, error) {
	return getActiveProjection(ctx, t.tx, spaceID, topicID, messageID)
}

func (t *pgTx) GetMessageProjectionIncludingRemoved(ctx context.Context, spaceID, topicID, messageID string) (*ProjectionRecord, error) {
	return getActiveProjection(ctx, t.tx, spaceID, topicID, messageID, true)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	if strings.TrimSpace(key) == "" {
		return internalError("lock topic resource", errors.New("lock key is required"))
	}
	if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); err != nil {
		return internalError("lock topic resource", err)
	}
	return nil
}

func (t *pgTx) ScheduleMessageJobs(ctx context.Context, input messagejobs.Input) error {
	if t == nil || t.tx == nil || t.jobScheduler == nil {
		return errors.New("workspace topic message job scheduler is required")
	}
	return t.jobScheduler.ScheduleMessageInTx(ctx, t.tx, input)
}

func (t *pgTx) CreateTopic(ctx context.Context, record TopicInsert) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO topics (id, space_id, conversation_id, title, description, created_by, status, allow_sync_to_group, revision, idempotency_key, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 1, $8, $9, $9)`, record.ID, record.SpaceID, record.ConversationID, record.Title, record.Description, record.CreatedBy, record.AllowSyncToGroup, nullableStringArg(record.IdempotencyKey), record.CreatedAt.UTC())
	if err != nil {
		return err
	}
	return nil
}

func (t *pgTx) InsertTopicMember(ctx context.Context, topicID, userID string, joinedAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `INSERT INTO topic_members (topic_id, user_id, joined_at, left_at, notification_level) VALUES ($1, $2, $3, NULL, 'all') ON CONFLICT (topic_id, user_id) DO NOTHING`, topicID, userID, joinedAt.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) RejoinTopicMember(ctx context.Context, topicID, userID string, joinedAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE topic_members SET joined_at = $3, left_at = NULL WHERE topic_id = $1 AND user_id = $2 AND left_at IS NOT NULL AND EXISTS (SELECT 1 FROM topics WHERE id = $1 AND status = 'open')`, topicID, userID, joinedAt.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) LeaveTopicMember(ctx context.Context, topicID, userID string, leftAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE topic_members SET left_at = $3 WHERE topic_id = $1 AND user_id = $2 AND left_at IS NULL`, topicID, userID, leftAt.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) TransitionTopic(ctx context.Context, topicID, status string, expectedRevision int64, now time.Time) (*TopicRecord, bool, error) {
	var id, spaceID string
	err := t.tx.QueryRow(ctx, `UPDATE topics SET status = $2, revision = revision + 1, updated_at = $3, closed_at = CASE WHEN $2 = 'closed' THEN COALESCE(closed_at, $3) ELSE closed_at END, archived_at = CASE WHEN $2 = 'archived' THEN COALESCE(archived_at, $3) ELSE archived_at END WHERE id = $1 AND revision = $4 RETURNING id, space_id`, topicID, status, now.UTC(), expectedRevision).Scan(&id, &spaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	updated, err := getTopic(ctx, t.tx, spaceID, id, "")
	return updated, true, err
}

func (t *pgTx) UpdateTopicNotification(ctx context.Context, topicID, userID, level string) error {
	_, err := t.tx.Exec(ctx, `UPDATE topic_members SET notification_level = $3 WHERE topic_id = $1 AND user_id = $2 AND left_at IS NULL`, topicID, userID, level)
	return err
}

func (t *pgTx) InsertTopicMessage(ctx context.Context, record TopicMessageInsert) (bool, *TopicMessageRecord, error) {
	var id string
	err := t.tx.QueryRow(ctx, `INSERT INTO messages (id, space_id, conversation_id, topic_id, author_id, author_kind, kind, client_message_id, content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, NULL) ON CONFLICT (topic_id, author_id, client_message_id) WHERE topic_id IS NOT NULL AND author_id IS NOT NULL AND client_message_id IS NOT NULL DO NOTHING RETURNING id`, record.ID, record.SpaceID, record.ConversationID, record.TopicID, record.AuthorID, record.AuthorKind, record.Kind, record.ClientMessageID, record.ContentFormat, string(record.ContentJSON), record.PlainText, nullableStringArg(record.ReplyToMessageID), record.CreatedAt.UTC()).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		winner, findErr := getTopicMessageByClientID(ctx, t.tx, record.SpaceID, record.TopicID, record.AuthorID, record.ClientMessageID)
		return false, winner, findErr
	}
	if err != nil {
		return false, nil, err
	}
	message, err := getTopicMessage(ctx, t.tx, record.SpaceID, record.TopicID, id)
	return true, message, err
}

func (t *pgTx) InsertConversationMessage(ctx context.Context, record ConversationMessageInsert) (bool, error) {
	var id string
	err := t.tx.QueryRow(ctx, `INSERT INTO messages (id, space_id, conversation_id, topic_id, author_id, author_kind, kind, client_message_id, content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, NULL, $11, NULL, NULL) ON CONFLICT (space_id, conversation_id, author_id, client_message_id) DO NOTHING RETURNING id`, record.ID, record.SpaceID, record.ConversationID, record.AuthorID, record.AuthorKind, record.Kind, record.ClientMessageID, record.ContentFormat, string(record.ContentJSON), record.PlainText, record.CreatedAt.UTC()).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (t *pgTx) EnforceTopicRetention(ctx context.Context, topicID string, retentionCount int64, now time.Time) ([]RetentionRemoval, error) {
	if retentionCount < 1 {
		return nil, nil
	}
	rows, err := t.tx.Query(ctx, `SELECT m.id, p.id, p.group_message_id FROM messages m LEFT JOIN topic_group_projections p ON p.topic_message_id = m.id AND p.removed_at IS NULL WHERE m.topic_id = $1 AND m.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM conversation_pinned_messages pin WHERE pin.message_id = m.id) AND m.id NOT IN (SELECT recent.id FROM messages recent WHERE recent.topic_id = $1 AND recent.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM conversation_pinned_messages pin WHERE pin.message_id = recent.id) ORDER BY recent.created_at DESC, recent.id DESC LIMIT $2)`, topicID, retentionCount)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	removed := make([]RetentionRemoval, 0)
	for rows.Next() {
		var messageID string
		var projectionID, groupMessageID *string
		if err := rows.Scan(&messageID, &projectionID, &groupMessageID); err != nil {
			return nil, err
		}
		item := RetentionRemoval{MessageID: messageID}
		if projectionID != nil {
			item.ProjectionID = *projectionID
		}
		if groupMessageID != nil {
			item.GroupMessageID = *groupMessageID
		}
		removed = append(removed, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, item := range removed {
		if _, err := t.tx.Exec(ctx, `UPDATE messages SET deleted_at = COALESCE(deleted_at, $2) WHERE id = $1`, item.MessageID, now.UTC()); err != nil {
			return nil, err
		}
		if item.ProjectionID != "" {
			if _, err := t.tx.Exec(ctx, `UPDATE topic_group_projections SET removed_at = $2, updated_at = $2 WHERE id = $1 AND removed_at IS NULL`, item.ProjectionID, now.UTC()); err != nil {
				return nil, err
			}
			if _, err := t.tx.Exec(ctx, `UPDATE messages SET deleted_at = COALESCE(deleted_at, $2) WHERE id = $1 AND topic_id IS NULL`, item.GroupMessageID, now.UTC()); err != nil {
				return nil, err
			}
		}
	}
	return removed, nil
}

func (t *pgTx) CreateProjection(ctx context.Context, record ProjectionRecord) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO topic_group_projections (id, topic_id, topic_message_id, group_conversation_id, group_message_id, projection_type, created_at, updated_at, removed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, NULL)`, record.ID, record.TopicID, record.TopicMessageID, record.GroupConversationID, record.GroupMessageID, record.ProjectionType, record.CreatedAt.UTC())
	return err
}

func (t *pgTx) ReactivateProjection(ctx context.Context, projectionID, groupMessageID string, now time.Time) error {
	_, err := t.tx.Exec(ctx, `UPDATE topic_group_projections SET group_message_id = $2, updated_at = $3, removed_at = NULL WHERE id = $1 AND removed_at IS NOT NULL`, projectionID, groupMessageID, now.UTC())
	return err
}

func (t *pgTx) UnsyncProjection(ctx context.Context, projectionID string, now time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE topic_group_projections SET removed_at = $2, updated_at = $2 WHERE id = $1 AND removed_at IS NULL`, projectionID, now.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) MarkGroupMessageDeleted(ctx context.Context, messageID string, now time.Time) error {
	_, err := t.tx.Exec(ctx, `UPDATE messages SET deleted_at = COALESCE(deleted_at, $2) WHERE id = $1 AND topic_id IS NULL`, messageID, now.UTC())
	return err
}

func (t *pgTx) UpsertCard(ctx context.Context, input CardUpsert) (CardUpsertResult, error) {
	var current CardRecord
	var createdBy *string
	err := t.tx.QueryRow(ctx, `SELECT id, space_id, COALESCE(conversation_id, ''), card_type, schema_version, payload_json, fallback_text, source_kind, COALESCE(source_id, ''), COALESCE(resource_type, ''), COALESCE(resource_id, ''), visibility_scope, created_by_user_id, status, revision, created_at, updated_at FROM workspace_cards WHERE space_id = $1 AND source_kind = $2 AND source_id = $3 AND card_type = $4`, input.SpaceID, input.SourceKind, input.SourceID, input.CardType).Scan(&current.ID, &current.SpaceID, &current.ConversationID, &current.CardType, &current.SchemaVersion, &current.PayloadJSON, &current.FallbackText, &current.SourceKind, &current.SourceID, &current.ResourceType, &current.ResourceID, &current.VisibilityScope, &createdBy, &current.Status, &current.Revision, &current.CreatedAt, &current.UpdatedAt)
	if err == nil {
		current.CreatedByUserID = createdBy
		if current.Status == input.Status && bytesEqual(current.PayloadJSON, input.PayloadJSON) && current.FallbackText == input.FallbackText {
			return CardUpsertResult{Card: current}, nil
		}
		var updated CardRecord
		var updatedBy *string
		err = t.tx.QueryRow(ctx, `UPDATE workspace_cards SET payload_json = $2, fallback_text = $3, status = $4, revision = revision + 1, updated_at = $5 WHERE id = $1 AND revision = $6 RETURNING id, space_id, COALESCE(conversation_id, ''), card_type, schema_version, payload_json, fallback_text, source_kind, COALESCE(source_id, ''), COALESCE(resource_type, ''), COALESCE(resource_id, ''), visibility_scope, created_by_user_id, status, revision, created_at, updated_at`, current.ID, string(input.PayloadJSON), input.FallbackText, input.Status, input.Now.UTC(), current.Revision).Scan(&updated.ID, &updated.SpaceID, &updated.ConversationID, &updated.CardType, &updated.SchemaVersion, &updated.PayloadJSON, &updated.FallbackText, &updated.SourceKind, &updated.SourceID, &updated.ResourceType, &updated.ResourceID, &updated.VisibilityScope, &updatedBy, &updated.Status, &updated.Revision, &updated.CreatedAt, &updated.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return t.UpsertCard(ctx, input)
		}
		if err != nil {
			return CardUpsertResult{}, err
		}
		updated.CreatedByUserID = updatedBy
		return CardUpsertResult{Card: updated, Changed: true}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CardUpsertResult{}, err
	}
	var inserted CardRecord
	var insertedBy *string
	err = t.tx.QueryRow(ctx, `INSERT INTO workspace_cards (id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text, source_kind, source_id, resource_type, resource_id, visibility_scope, created_by_user_id, status, revision, expires_at, created_at, updated_at) VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''), $12, $13, $14, 1, NULL, $15, $15) ON CONFLICT DO NOTHING RETURNING id, space_id, COALESCE(conversation_id, ''), card_type, schema_version, payload_json, fallback_text, source_kind, COALESCE(source_id, ''), COALESCE(resource_type, ''), COALESCE(resource_id, ''), visibility_scope, created_by_user_id, status, revision, created_at, updated_at`, input.ID, input.SpaceID, input.ConversationID, input.CardType, input.SchemaVersion, string(input.PayloadJSON), input.FallbackText, input.SourceKind, input.SourceID, input.ResourceType, input.ResourceID, input.VisibilityScope, nullableStringArg(input.CreatedByUserID), input.Status, input.Now.UTC()).Scan(&inserted.ID, &inserted.SpaceID, &inserted.ConversationID, &inserted.CardType, &inserted.SchemaVersion, &inserted.PayloadJSON, &inserted.FallbackText, &inserted.SourceKind, &inserted.SourceID, &inserted.ResourceType, &inserted.ResourceID, &inserted.VisibilityScope, &insertedBy, &inserted.Status, &inserted.Revision, &inserted.CreatedAt, &inserted.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return t.UpsertCard(ctx, input)
	}
	if err != nil {
		return CardUpsertResult{}, err
	}
	inserted.CreatedByUserID = insertedBy
	return CardUpsertResult{Card: inserted, Created: true, Changed: true}, nil
}

func (t *pgTx) InvalidateCard(ctx context.Context, projectionID string, now time.Time) (CardRecord, bool, error) {
	cardID := "topic_projection_" + projectionID
	var current CardRecord
	var createdBy *string
	err := t.tx.QueryRow(ctx, `SELECT id, space_id, COALESCE(conversation_id, ''), card_type, schema_version, payload_json, fallback_text, source_kind, COALESCE(source_id, ''), COALESCE(resource_type, ''), COALESCE(resource_id, ''), visibility_scope, created_by_user_id, status, revision, created_at, updated_at FROM workspace_cards WHERE id = $1`, cardID).Scan(&current.ID, &current.SpaceID, &current.ConversationID, &current.CardType, &current.SchemaVersion, &current.PayloadJSON, &current.FallbackText, &current.SourceKind, &current.SourceID, &current.ResourceType, &current.ResourceID, &current.VisibilityScope, &createdBy, &current.Status, &current.Revision, &current.CreatedAt, &current.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return CardRecord{}, false, nil
	}
	if err != nil {
		return CardRecord{}, false, err
	}
	current.CreatedByUserID = createdBy
	if current.Status != "active" && current.FallbackText == "话题消息已移除" {
		return current, false, nil
	}
	var updated CardRecord
	var updatedBy *string
	err = t.tx.QueryRow(ctx, `UPDATE workspace_cards SET status = 'invalidated', payload_json = jsonb_set(payload_json::jsonb, '{messagePreview}', '""'::jsonb)::text, fallback_text = '话题消息已移除', revision = revision + 1, updated_at = $2 WHERE id = $1 AND status IN ('active', 'invalidated') RETURNING id, space_id, COALESCE(conversation_id, ''), card_type, schema_version, payload_json, fallback_text, source_kind, COALESCE(source_id, ''), COALESCE(resource_type, ''), COALESCE(resource_id, ''), visibility_scope, created_by_user_id, status, revision, created_at, updated_at`, cardID, now.UTC()).Scan(&updated.ID, &updated.SpaceID, &updated.ConversationID, &updated.CardType, &updated.SchemaVersion, &updated.PayloadJSON, &updated.FallbackText, &updated.SourceKind, &updated.SourceID, &updated.ResourceType, &updated.ResourceID, &updated.VisibilityScope, &updatedBy, &updated.Status, &updated.Revision, &updated.CreatedAt, &updated.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return current, false, nil
	}
	if err != nil {
		return CardRecord{}, false, err
	}
	updated.CreatedByUserID = updatedBy
	return updated, true, nil
}

func (t *pgTx) RefreshTopicCards(ctx context.Context, topicID, status string, now time.Time) ([]CardRecord, error) {
	var participantCount int
	if err := t.tx.QueryRow(ctx, `SELECT COUNT(*) FROM topic_members WHERE topic_id = $1 AND left_at IS NULL`, topicID).Scan(&participantCount); err != nil {
		return nil, err
	}
	rows, err := t.tx.Query(ctx, `SELECT id, space_id, COALESCE(conversation_id, ''), card_type, schema_version, payload_json, fallback_text, source_kind, COALESCE(source_id, ''), COALESCE(resource_type, ''), COALESCE(resource_id, ''), visibility_scope, created_by_user_id, status, revision, created_at, updated_at FROM workspace_cards WHERE source_kind = 'topic' AND resource_type = 'topic' AND resource_id = $1 AND status IN ('active', 'invalidated') ORDER BY created_at ASC, id ASC`, topicID)
	if err != nil {
		return nil, err
	}
	cards := make([]CardRecord, 0)
	for rows.Next() {
		var current CardRecord
		var createdBy *string
		if err := rows.Scan(&current.ID, &current.SpaceID, &current.ConversationID, &current.CardType, &current.SchemaVersion, &current.PayloadJSON, &current.FallbackText, &current.SourceKind, &current.SourceID, &current.ResourceType, &current.ResourceID, &current.VisibilityScope, &createdBy, &current.Status, &current.Revision, &current.CreatedAt, &current.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		current.CreatedByUserID = createdBy
		cards = append(cards, current)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	result := make([]CardRecord, 0, len(cards))
	for _, current := range cards {
		var payload map[string]any
		if json.Unmarshal(current.PayloadJSON, &payload) != nil || payload == nil {
			continue
		}
		if current.CardType == TopicCardType {
			payload["participantCount"] = participantCount
			payload["status"] = status
		} else if current.CardType == TopicSyncCardType {
			payload["status"] = status
		} else {
			continue
		}
		encoded, err := json.Marshal(payload)
		if err != nil || bytesEqual(encoded, current.PayloadJSON) {
			continue
		}
		var updated CardRecord
		var updatedBy *string
		if err := t.tx.QueryRow(ctx, `UPDATE workspace_cards SET payload_json = $2, revision = revision + 1, updated_at = $3 WHERE id = $1 AND revision = $4 RETURNING id, space_id, COALESCE(conversation_id, ''), card_type, schema_version, payload_json, fallback_text, source_kind, COALESCE(source_id, ''), COALESCE(resource_type, ''), COALESCE(resource_id, ''), visibility_scope, created_by_user_id, status, revision, created_at, updated_at`, current.ID, string(encoded), now.UTC(), current.Revision).Scan(&updated.ID, &updated.SpaceID, &updated.ConversationID, &updated.CardType, &updated.SchemaVersion, &updated.PayloadJSON, &updated.FallbackText, &updated.SourceKind, &updated.SourceID, &updated.ResourceType, &updated.ResourceID, &updated.VisibilityScope, &updatedBy, &updated.Status, &updated.Revision, &updated.CreatedAt, &updated.UpdatedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			return nil, err
		}
		updated.CreatedByUserID = updatedBy
		result = append(result, updated)
	}
	return result, nil
}

func (t *pgTx) MarkTopicRead(ctx context.Context, topicID, userID string, messageID *string, sequence int64, now time.Time) error {
	_, err := t.tx.Exec(ctx, `UPDATE topic_members SET last_read_message_id = $3, last_read_seq = $4, notification_level = COALESCE(notification_level, 'all') WHERE topic_id = $1 AND user_id = $2 AND left_at IS NULL AND (last_read_seq IS NULL OR last_read_seq <= $4)`, topicID, userID, nullableStringArg(messageID), sequence)
	return err
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) (EventRecord, error) {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return EventRecord{}, err
		}
		input.ID = id
	}
	if input.CreatedAt.IsZero() || strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Type) == "" {
		return EventRecord{}, errors.New("workspace event fields are required")
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return EventRecord{}, errors.New("workspace event payload is not valid JSON")
	}
	var sequence int64
	err := t.tx.QueryRow(ctx, `INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM workspace_events WHERE space_id = $1), 1) + 1) ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1 RETURNING next_seq - 1`, input.SpaceID).Scan(&sequence)
	if err != nil {
		return EventRecord{}, err
	}
	_, err = t.tx.Exec(ctx, `INSERT INTO workspace_events (id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)`, input.ID, input.SpaceID, sequence, input.Type, input.ActorID, input.ConversationID, input.TargetType, input.TargetID, string(input.PayloadJSON), input.CreatedAt.UTC())
	if err != nil {
		return EventRecord{}, err
	}
	return EventRecord{ID: input.ID, SpaceID: input.SpaceID, Seq: sequence}, nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return err
		}
		input.ID = id
	}
	if input.CreatedAt.IsZero() || strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" || strings.TrimSpace(input.Result) == "" {
		return errors.New("workspace audit fields are required")
	}
	meta := (auth.RequestMeta{RequestID: input.RequestID, IPAddress: input.IPAddress, UserAgent: input.UserAgent}).Safe()
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, ip_address, user_agent, request_id, created_at) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, input.Result, input.Reason, meta.IPAddress, meta.UserAgent, meta.RequestID, input.CreatedAt.UTC())
	return err
}

func (t *pgTx) newID() (string, error) {
	if t == nil || t.idFactory == nil {
		return "", errors.New("workspace topic id factory is required")
	}
	id, err := t.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("workspace topic id factory returned an empty id")
	}
	return id, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableStringArg(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func bytesEqual(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	result := make([]byte, 0, 12)
	for value > 0 {
		result = append([]byte{byte('0' + value%10)}, result...)
		value /= 10
	}
	return string(result)
}
