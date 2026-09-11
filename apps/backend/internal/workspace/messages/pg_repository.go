package messages

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

// PGRepository is the native PostgreSQL adapter for the message domain. It
// exposes only the narrow methods in repository.go; callers never receive a
// generic SQL handle and all mutation methods are transaction-scoped.
type PGRepository struct {
	pool               *pgxpool.Pool
	idFactory          IDFactory
	jobScheduler       messagejobs.PGScheduler
	builtinEmoteSource BuiltinEmoteSource
	topics             *topics.PGRepository
}

func NewPGRepository(pool *pgxpool.Pool, idFactories ...IDFactory) *PGRepository {
	idFactory := IDFactory(nil)
	if len(idFactories) > 0 {
		idFactory = idFactories[0]
	}
	if idFactory == nil {
		idFactory = func() (string, error) {
			return newUUID()
		}
	}
	return &PGRepository{pool: pool, idFactory: idFactory}
}

func NewPGRepositoryWithMessageJobs(pool *pgxpool.Pool, scheduler messagejobs.PGScheduler, idFactories ...IDFactory) *PGRepository {
	repository := NewPGRepository(pool, idFactories...)
	repository.jobScheduler = scheduler
	return repository
}

// SetBuiltinEmoteSource installs the immutable catalog adapter used for
// built-in share covers. Composition must call it before serving requests;
// the message reader never accepts a source URL from message content or SQL.
func (s *PGRepository) SetBuiltinEmoteSource(source BuiltinEmoteSource) {
	if s != nil {
		s.builtinEmoteSource = source
	}
}

// SetTopicRepository is startup-only composition. Both adapters wrap the same
// PostgreSQL transaction; the topic service cannot independently commit here.
func (s *PGRepository) SetTopicRepository(repository *topics.PGRepository) {
	if s != nil {
		s.topics = repository
	}
}

type pgTopicMessageTx struct {
	*pgTx
	topicTx topics.Tx
}

func (t *pgTopicMessageTx) TopicTransaction() topics.Tx { return t.topicTx }

// NewPGTransaction wraps an already-open PostgreSQL transaction with the
// message domain's typed Tx surface. The caller remains responsible for
// commit/rollback; no pool transaction is started here.
func NewPGTransaction(tx pgx.Tx) Tx {
	if tx == nil {
		return nil
	}
	return &pgTx{tx: tx, repository: NewPGRepository(nil)}
}

// NewTransaction reuses this repository's configured ID factory and message
// job scheduler while wrapping an already-open transaction. The transaction
// still belongs to the caller and is never committed here.
func (s *PGRepository) NewTransaction(tx pgx.Tx) Tx {
	if s == nil || tx == nil {
		return nil
	}
	adapter := &pgTx{tx: tx, repository: s}
	if s.topics != nil {
		return &pgTopicMessageTx{pgTx: adapter, topicTx: s.topics.NewTransaction(tx)}
	}
	return adapter
}

func newUUID() (string, error) {
	value, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return value.String(), nil
}

func (s *PGRepository) Ping(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("workspace messages postgres pool is required")
	}
	return s.pool.Ping(ctx)
}

func (s *PGRepository) WithTx(ctx context.Context, fn func(Tx) error) error {
	if s == nil || s.pool == nil {
		return errors.New("workspace messages postgres pool is required")
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	wrapper := s.NewTransaction(tx)
	if err := fn(wrapper); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return nil
}

func (s *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return lookupActor(ctx, s.pool, spaceID, userID)
}

func (s *PGRepository) GetConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return getConversation(ctx, s.pool, spaceID, conversationID)
}

func (s *PGRepository) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	if s == nil || s.pool == nil {
		return false, errors.New("workspace messages postgres pool is required")
	}
	return conversationMemberActive(ctx, s.pool, spaceID, conversationID, userID)
}

func (s *PGRepository) FindMessage(ctx context.Context, spaceID, conversationID, messageID string) (*MessageRecord, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return s.findMessage(ctx, s.pool, spaceID, conversationID, messageID, "")
}

// FindMessageForViewer is an optional richer lookup used by the service when
// viewer-specific remarks are available. It is intentionally not required by
// ReadRepository so small fakes and future adapters can remain narrow.
func (s *PGRepository) FindMessageForViewer(ctx context.Context, spaceID, conversationID, messageID, viewerID string) (*MessageRecord, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return findVisibleMessage(ctx, s.pool, spaceID, conversationID, messageID, viewerID)
}

func (s *PGRepository) FindMessageByClientID(ctx context.Context, spaceID, conversationID, actorID, clientMessageID string) (*MessageRecord, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return findMessageByClientID(ctx, s.pool, spaceID, conversationID, actorID, clientMessageID, actorID)
}

func (s *PGRepository) MessageExists(ctx context.Context, spaceID, conversationID, messageID string) (bool, error) {
	if s == nil || s.pool == nil {
		return false, errors.New("workspace messages postgres pool is required")
	}
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM messages
			WHERE space_id = $1 AND conversation_id = $2 AND id = $3 AND topic_id IS NULL
		)
	`, spaceID, conversationID, messageID).Scan(&exists)
	return exists, err
}

func (s *PGRepository) ListMessages(ctx context.Context, options ListOptions) ([]MessageRecord, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return listMessages(ctx, s.pool, options)
}

func (s *PGRepository) ListAttachments(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]AttachmentRecord, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return listAttachments(ctx, s.pool, spaceID, viewerID, messageIDs)
}

func (s *PGRepository) ListReactions(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]ReactionGroup, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return listReactions(ctx, s.pool, spaceID, viewerID, messageIDs)
}

func (s *PGRepository) ListHidden(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string]bool, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return listHidden(ctx, s.pool, spaceID, viewerID, messageIDs)
}

func (s *PGRepository) ListMessageEmoteCollectionShares(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string]map[string]EmoteCollectionShare, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return listMessageEmoteCollectionShares(ctx, s.pool, spaceID, viewerID, messageIDs, s.builtinEmoteSource)
}

func (s *PGRepository) FindMentionMember(ctx context.Context, spaceID, conversationID, userID string) (*MentionMember, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return findMentionMember(ctx, s.pool, spaceID, conversationID, userID)
}

func (s *PGRepository) FindAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("workspace messages postgres pool is required")
	}
	return findAttachment(ctx, s.pool, spaceID, attachmentID)
}

func (s *PGRepository) LookupRecallReason(ctx context.Context, spaceID, userID string) (string, error) {
	if s == nil || s.pool == nil {
		return "", errors.New("workspace messages postgres pool is required")
	}
	var reason *string
	err := s.pool.QueryRow(ctx, `
		SELECT u.recall_reason
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`, userID, spaceID).Scan(&reason)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return stringValue(reason), err
}

func (s *PGRepository) findMessage(ctx context.Context, queryer pgQueryer, spaceID, conversationID, messageID, viewerID string) (*MessageRecord, error) {
	if queryer == nil {
		return nil, errors.New("workspace messages queryer is required")
	}
	return scanMessage(queryer.QueryRow(ctx, messageSelect+`
		WHERE m.space_id = $1
		  AND m.id = $2
		  AND ($3 = '' OR m.conversation_id = $3)
		  AND m.topic_id IS NULL
		  AND m.deleted_at IS NULL
	`, spaceID, messageID, conversationID, viewerID))
}

type pgQueryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
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

func (t *pgTx) FindMessage(ctx context.Context, spaceID, conversationID, messageID string) (*MessageRecord, error) {
	return t.findMessage(ctx, spaceID, conversationID, messageID, "")
}

func (t *pgTx) FindMessageForViewer(ctx context.Context, spaceID, conversationID, messageID, viewerID string) (*MessageRecord, error) {
	return findVisibleMessage(ctx, t.tx, spaceID, conversationID, messageID, viewerID)
}

func (t *pgTx) findMessage(ctx context.Context, spaceID, conversationID, messageID, viewerID string) (*MessageRecord, error) {
	return scanMessage(t.tx.QueryRow(ctx, messageSelect+`
		WHERE m.space_id = $1
		  AND m.id = $2
		  AND ($3 = '' OR m.conversation_id = $3)
		  AND m.topic_id IS NULL
		  AND m.deleted_at IS NULL
	`, spaceID, messageID, conversationID, viewerID))
}

func (t *pgTx) FindMessageByClientID(ctx context.Context, spaceID, conversationID, actorID, clientMessageID string) (*MessageRecord, error) {
	return findMessageByClientID(ctx, t.tx, spaceID, conversationID, actorID, clientMessageID, actorID)
}

func (t *pgTx) MessageExists(ctx context.Context, spaceID, conversationID, messageID string) (bool, error) {
	var exists bool
	err := t.tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM messages
			WHERE space_id = $1 AND conversation_id = $2 AND id = $3 AND topic_id IS NULL
		)
	`, spaceID, conversationID, messageID).Scan(&exists)
	return exists, err
}

func (t *pgTx) ListMessages(ctx context.Context, options ListOptions) ([]MessageRecord, error) {
	return listMessages(ctx, t.tx, options)
}

func (t *pgTx) ListAttachments(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]AttachmentRecord, error) {
	return listAttachments(ctx, t.tx, spaceID, viewerID, messageIDs)
}

func (t *pgTx) ListReactions(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]ReactionGroup, error) {
	return listReactions(ctx, t.tx, spaceID, viewerID, messageIDs)
}

func (t *pgTx) ListHidden(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string]bool, error) {
	return listHidden(ctx, t.tx, spaceID, viewerID, messageIDs)
}

func (t *pgTx) ListMessageEmoteCollectionShares(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string]map[string]EmoteCollectionShare, error) {
	var source BuiltinEmoteSource
	if t != nil && t.repository != nil {
		source = t.repository.builtinEmoteSource
	}
	return listMessageEmoteCollectionShares(ctx, t.tx, spaceID, viewerID, messageIDs, source)
}

func (t *pgTx) FindMentionMember(ctx context.Context, spaceID, conversationID, userID string) (*MentionMember, error) {
	return findMentionMember(ctx, t.tx, spaceID, conversationID, userID)
}

func (t *pgTx) FindAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error) {
	return findAttachment(ctx, t.tx, spaceID, attachmentID)
}

func (t *pgTx) LookupRecallReason(ctx context.Context, spaceID, userID string) (string, error) {
	var reason *string
	err := t.tx.QueryRow(ctx, `
		SELECT u.recall_reason
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`, userID, spaceID).Scan(&reason)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return stringValue(reason), err
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	_, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

func (t *pgTx) ScheduleMessageJobs(ctx context.Context, input messagejobs.Input) error {
	if t == nil || t.tx == nil || t.repository == nil || t.repository.jobScheduler == nil {
		return errors.New("workspace message job scheduler is required")
	}
	return t.repository.jobScheduler.ScheduleMessageInTx(ctx, t.tx, input)
}

func (t *pgTx) InsertMessage(ctx context.Context, record MessageInsert) (bool, *MessageRecord, error) {
	var insertedID string
	err := t.tx.QueryRow(ctx, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text,
			reply_to_message_id, created_at, edited_at, deleted_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NULL)
		ON CONFLICT (space_id, conversation_id, author_id, client_message_id) DO NOTHING
		RETURNING id
	`, record.ID, record.SpaceID, record.ConversationID, record.AuthorID, record.AuthorKind, record.Kind,
		record.ClientMessageID, record.ContentFormat, string(record.ContentJSON), record.PlainText,
		nullableStringValue(record.ReplyToMessageID), normalizeTimestamp(record.CreatedAt)).Scan(&insertedID)
	if errors.Is(err, pgx.ErrNoRows) {
		winner, findErr := t.FindMessageByClientID(ctx, record.SpaceID, record.ConversationID, record.AuthorID, record.ClientMessageID)
		return false, winner, findErr
	}
	if err != nil {
		return false, nil, err
	}
	if insertedID == "" {
		return false, nil, errors.New("message insert returned no id")
	}
	return true, nil, nil
}

func (t *pgTx) LinkMessageAttachment(ctx context.Context, spaceID, messageID, attachmentID string) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO message_attachments (message_id, attachment_id)
		SELECT $1, a.id
		FROM attachments a
		WHERE a.id = $2 AND a.space_id = $3
		ON CONFLICT DO NOTHING
	`, messageID, attachmentID, spaceID)
	return err
}

func (t *pgTx) LinkMessageCustomEmote(ctx context.Context, messageID, actorID, customEmoteID string) error {
	result, err := t.tx.Exec(ctx, `
		INSERT INTO message_custom_emotes (message_id, custom_emote_id)
		SELECT $1, e.id
		FROM workspace_custom_emotes e
		WHERE e.id = $2 AND e.user_id = $3 AND e.removed_at IS NULL
		ON CONFLICT DO NOTHING
	`, messageID, customEmoteID, actorID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return validationError(CodeMessageInvalidEmoji, MessageInvalidEmoji)
	}
	return nil
}

func (t *pgTx) LinkMessageEmoteCollectionShare(ctx context.Context, messageID, shareID string) error {
	result, err := t.tx.Exec(ctx, `
		INSERT INTO message_emote_collection_shares (message_id, share_id)
		SELECT $1, s.id
		FROM workspace_emote_collection_shares s
		WHERE s.id = $2 AND s.revoked_at IS NULL
		ON CONFLICT DO NOTHING
	`, messageID, shareID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return validationError(CodeMessageInvalidEmoteShare, MessageInvalidEmoteShare)
	}
	return nil
}

func (t *pgTx) EnforceRetention(ctx context.Context, spaceID, conversationID string, retentionCount int64, now time.Time) error {
	if retentionCount <= 0 {
		retentionCount = DefaultRetentionCount
	}
	_, err := t.tx.Exec(ctx, `
		WITH victims AS (
			SELECT m.id
			FROM messages m
			WHERE m.space_id = $1
			  AND m.conversation_id = $2
			  AND m.topic_id IS NULL
			  AND m.deleted_at IS NULL
			  AND NOT EXISTS (
				  SELECT 1 FROM conversation_pinned_messages p WHERE p.message_id = m.id
			  )
			ORDER BY m.created_at DESC, m.id DESC
			OFFSET $3
		)
		UPDATE messages m
		SET deleted_at = COALESCE(m.deleted_at, $4)
		FROM victims
		WHERE m.id = victims.id
	`, spaceID, conversationID, retentionCount, normalizeTimestamp(now))
	return err
}

func (t *pgTx) RecallMessage(ctx context.Context, spaceID, messageID string, expectedRevision int64, contentJSON []byte, plainText, reason string, now time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE messages
		SET content_json = $1,
		    plain_text = $2,
		    reply_to_message_id = NULL,
		    recalled_at = $3,
		    recall_reason = $4
		WHERE space_id = $5
		  AND id = $6
		  AND deleted_at IS NULL
		  AND recalled_at IS NULL
		  AND ($7 <= 0 OR $7 = 1)
	`, string(contentJSON), plainText, normalizeTimestamp(now), reason, spaceID, messageID, expectedRevision)
	return result.RowsAffected() > 0, err
}

func (t *pgTx) DeleteMessageReactions(ctx context.Context, spaceID, messageID string) error {
	_, err := t.tx.Exec(ctx, `
		DELETE FROM message_reactions mr
		USING messages m
		WHERE mr.message_id = m.id AND m.space_id = $1 AND mr.message_id = $2
	`, spaceID, messageID)
	return err
}

func (t *pgTx) DeleteMessageCustomEmotes(ctx context.Context, spaceID, messageID string) error {
	_, err := t.tx.Exec(ctx, `
		DELETE FROM message_custom_emotes mc
		USING messages m
		WHERE mc.message_id = m.id AND m.space_id = $1 AND mc.message_id = $2
	`, spaceID, messageID)
	return err
}

func (t *pgTx) DeleteMessageEmoteCollectionShares(ctx context.Context, spaceID, messageID string) error {
	_, err := t.tx.Exec(ctx, `
		DELETE FROM message_emote_collection_shares mes
		USING messages m
		WHERE mes.message_id = m.id AND m.space_id = $1 AND mes.message_id = $2
	`, spaceID, messageID)
	return err
}

func (t *pgTx) DeleteMessagePins(ctx context.Context, spaceID, messageID string) error {
	rows, err := t.tx.Query(ctx, `
		DELETE FROM conversation_pinned_messages p
		USING messages m
		WHERE p.message_id = m.id AND m.space_id = $1 AND p.message_id = $2
		RETURNING p.conversation_id, p.pinned_by_user_id
	`, spaceID, messageID)
	if err != nil {
		return err
	}
	type pinRecord struct {
		conversationID string
		userID         string
	}
	pins := make([]pinRecord, 0)
	for rows.Next() {
		var conversationID, userID string
		if err := rows.Scan(&conversationID, &userID); err != nil {
			rows.Close()
			return err
		}
		pins = append(pins, pinRecord{conversationID: conversationID, userID: userID})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, pin := range pins {
		if _, err := t.tx.Exec(ctx, `
			UPDATE conversation_pin_counters
			SET pin_count = CASE WHEN pin_count > 0 THEN pin_count - 1 ELSE 0 END
			WHERE conversation_id = $1 AND user_id = $2
		`, pin.conversationID, pin.userID); err != nil {
			return err
		}
	}
	return nil
}

func (t *pgTx) HideMessage(ctx context.Context, spaceID, messageID, userID string, now time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		INSERT INTO message_hidden_states (user_id, message_id, hidden_at)
		SELECT $1, m.id, $4
		FROM messages m
		WHERE m.id = $2 AND m.space_id = $3 AND m.deleted_at IS NULL
		ON CONFLICT (user_id, message_id) DO NOTHING
	`, userID, messageID, spaceID, normalizeTimestamp(now))
	return result.RowsAffected() > 0, err
}

func (t *pgTx) UnhideMessage(ctx context.Context, spaceID, messageID, userID string) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		DELETE FROM message_hidden_states h
		USING messages m
		WHERE h.user_id = $1 AND h.message_id = m.id
		  AND m.id = $2 AND m.space_id = $3
	`, userID, messageID, spaceID)
	return result.RowsAffected() > 0, err
}

func (t *pgTx) AddReaction(ctx context.Context, spaceID, messageID, userID, emoteKey string, now time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		INSERT INTO message_reactions (message_id, user_id, emote_key, created_at)
		SELECT m.id, $3, $4, $5
		FROM messages m
		WHERE m.id = $1 AND m.space_id = $2 AND m.deleted_at IS NULL AND m.recalled_at IS NULL
		ON CONFLICT (message_id, user_id, emote_key) DO NOTHING
	`, messageID, spaceID, userID, emoteKey, normalizeTimestamp(now))
	return result.RowsAffected() > 0, err
}

func (t *pgTx) RemoveReaction(ctx context.Context, spaceID, messageID, userID, emoteKey string, _ time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		DELETE FROM message_reactions mr
		USING messages m
		WHERE mr.message_id = m.id AND mr.message_id = $1 AND mr.user_id = $2
		  AND mr.emote_key = $3 AND m.space_id = $4
	`, messageID, userID, emoteKey, spaceID)
	return result.RowsAffected() > 0, err
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) (EventRecord, error) {
	if strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Type) == "" || input.CreatedAt.IsZero() {
		return EventRecord{}, errors.New("workspace event fields are required")
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return EventRecord{}, errors.New("workspace event payload is not valid JSON")
	}
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return EventRecord{}, err
		}
		input.ID = id
	}
	var seq int64
	if err := t.tx.QueryRow(ctx, `
		INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, 2)
		ON CONFLICT (space_id) DO UPDATE
		SET next_seq = workspace_event_cursors.next_seq + 1
		RETURNING next_seq - 1
	`, input.SpaceID).Scan(&seq); err != nil {
		return EventRecord{}, err
	}
	_, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)
	`, input.ID, input.SpaceID, seq, input.Type, input.ActorID, input.ConversationID,
		input.TargetType, input.TargetID, string(input.PayloadJSON), normalizeTimestamp(input.CreatedAt))
	if err != nil {
		return EventRecord{}, err
	}
	return EventRecord{ID: input.ID, SpaceID: input.SpaceID, Seq: seq}, nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" || strings.TrimSpace(input.Result) == "" || input.CreatedAt.IsZero() {
		return errors.New("workspace audit fields are required")
	}
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return err
		}
		input.ID = id
	}
	meta := (auth.RequestMeta{RequestID: input.RequestID, IPAddress: input.IPAddress, UserAgent: input.UserAgent}).Safe()
	_, err := t.tx.Exec(ctx, `
		INSERT INTO audit_logs (
			id, space_id, actor_user_id, actor_github_login, action, target_type,
			target_id, result, reason, ip_address, user_agent, request_id, created_at
		)
		VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)
	`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType,
		input.TargetID, input.Result, input.Reason, meta.IPAddress, meta.UserAgent, meta.RequestID, normalizeTimestamp(input.CreatedAt))
	return err
}

func (t *pgTx) newID() (string, error) {
	if t == nil || t.repository == nil || t.repository.idFactory == nil {
		return "", errors.New("workspace message id factory is required")
	}
	id, err := t.repository.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("workspace message id factory returned an empty id")
	}
	return id, nil
}

func lookupActor(ctx context.Context, queryer pgQueryer, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	var joinedAt time.Time
	err := queryer.QueryRow(ctx, `
		SELECT
			u.id, u.github_id, u.github_login, u.email, u.display_name,
			u.nickname, u.avatar_url, u.search_discoverable, u.kind,
			sm.role, sm.joined_at
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName,
		&nickname, &avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &joinedAt)
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
	actor.JoinedAt = joinedAt.UTC()
	return &actor, nil
}

func getConversation(ctx context.Context, queryer pgQueryer, spaceID, conversationID string) (*ConversationRecord, error) {
	var record ConversationRecord
	err := queryer.QueryRow(ctx, `
		SELECT id, space_id, type, retention_count, created_at
		FROM conversations
		WHERE id = $1 AND space_id = $2
	`, conversationID, spaceID).Scan(&record.ID, &record.SpaceID, &record.Type, &record.RetentionCount, &record.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.CreatedAt = record.CreatedAt.UTC()
	return &record, nil
}

func conversationMemberActive(ctx context.Context, queryer pgQueryer, spaceID, conversationID, userID string) (bool, error) {
	var active bool
	err := queryer.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversation_members cm
			INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
			WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
		)
	`, spaceID, conversationID, userID).Scan(&active)
	return active, err
}

const messageSelect = `
	SELECT
		m.id,
		m.space_id,
		m.conversation_id,
		m.author_id,
		COALESCE(ur.remark, u.nickname, u.github_login, u.display_name, '') AS author_name,
		COALESCE(u.nickname, '') AS author_nickname,
		COALESCE(ur.remark, '') AS author_remark,
		COALESCE(u.github_login, '') AS author_github_login,
		COALESCE(u.avatar_url, '') AS author_avatar_url,
		m.author_kind,
		m.kind,
		m.client_message_id,
		m.content_json,
		m.plain_text,
		m.reply_to_message_id,
		m.created_at,
		m.edited_at,
		m.deleted_at,
		m.recalled_at,
		m.recall_reason,
		CASE WHEN m.recalled_at IS NULL THEN 1 ELSE 2 END AS revision,
		COALESCE((
			SELECT MAX(we.seq)
			FROM workspace_events we
			WHERE we.space_id = m.space_id
			  AND we.type = 'message.created'
			  AND we.target_id = m.id
		), 0) AS event_seq,
		p.pinned_by_user_id,
		p.created_at AS pinned_at,
		COALESCE(m.topic_id, '') AS topic_id
	FROM messages m
	LEFT JOIN users u ON u.id = m.author_id
	LEFT JOIN user_remarks ur ON ur.owner_user_id = $4 AND ur.target_user_id = u.id
	LEFT JOIN conversation_pinned_messages p ON p.message_id = m.id AND p.conversation_id = m.conversation_id
`

func findMessageByClientID(ctx context.Context, queryer pgQueryer, spaceID, conversationID, actorID, clientMessageID, viewerID string) (*MessageRecord, error) {
	return scanMessage(queryer.QueryRow(ctx, messageSelectWithViewer("$5")+`
		WHERE m.space_id = $1
		  AND m.conversation_id = $2
		  AND m.author_id = $3
		  AND m.client_message_id = $4
		  AND m.topic_id IS NULL
	`, spaceID, conversationID, actorID, clientMessageID, viewerID))
}

func scanMessage(row pgx.Row) (*MessageRecord, error) {
	var record MessageRecord
	var authorID, clientID, replyID *string
	var authorNickname, authorRemark, authorGitHub, authorAvatar string
	var contentJSON string
	var editedAt, deletedAt, recalledAt *time.Time
	var recallReasonText *string
	err := row.Scan(&record.ID, &record.SpaceID, &record.ConversationID, &authorID, &record.AuthorName,
		&authorNickname, &authorRemark, &authorGitHub, &authorAvatar, &record.AuthorKind, &record.Kind,
		&clientID, &contentJSON, &record.PlainText, &replyID, &record.CreatedAt, &editedAt, &deletedAt,
		&recalledAt, &recallReasonText, &record.Revision, &record.EventSeq, &record.PinnedByUserID, &record.PinnedAt, &record.TopicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.AuthorID = stringPointer(authorID)
	record.AuthorNickname = authorNickname
	record.AuthorRemark = authorRemark
	record.AuthorGitHubLogin = authorGitHub
	record.AuthorAvatarURL = sanitizeMessageAvatar(authorAvatar)
	record.ClientMessageID = stringPointer(clientID)
	record.ContentJSON = []byte(contentJSON)
	record.ReplyToMessageID = stringPointer(replyID)
	record.CreatedAt = record.CreatedAt.UTC()
	record.EditedAt = utcTimePointer(editedAt)
	record.DeletedAt = utcTimePointer(deletedAt)
	record.RecalledAt = utcTimePointer(recalledAt)
	record.RecallReason = stringPointer(recallReasonText)
	return &record, nil
}

func listMessages(ctx context.Context, queryer pgQueryer, options ListOptions) ([]MessageRecord, error) {
	spaceID := normalizeSpaceID(options.SpaceID)
	conversationID := strings.TrimSpace(options.ConversationID)
	limit := normalizeLimit(options.Limit)
	if conversationID == "" {
		return []MessageRecord{}, nil
	}

	if around := strings.TrimSpace(options.Around); around != "" {
		anchor, err := scanMessage(queryer.QueryRow(ctx, messageSelect+`
			WHERE m.space_id = $1 AND m.id = $2 AND m.conversation_id = $3
			  AND m.topic_id IS NULL AND m.deleted_at IS NULL
		`, spaceID, around, conversationID, options.ActorID))
		if err != nil || anchor == nil {
			return []MessageRecord{}, err
		}
		sideLimit := (limit - 1) / 2
		if sideLimit < 1 {
			sideLimit = 1
		}
		older, err := listMessageWindow(ctx, queryer, options, "before", around, sideLimit)
		if err != nil {
			return nil, err
		}
		newer, err := listMessageWindow(ctx, queryer, options, "after", around, sideLimit)
		if err != nil {
			return nil, err
		}
		result := make([]MessageRecord, 0, len(older)+1+len(newer))
		result = append(result, older...)
		result = append(result, *anchor)
		result = append(result, newer...)
		return result, nil
	}
	if before := strings.TrimSpace(options.Before); before != "" {
		return listMessageWindow(ctx, queryer, options, "before", before, limit)
	}
	if after := strings.TrimSpace(options.After); after != "" {
		return listMessageWindow(ctx, queryer, options, "after", after, limit)
	}
	return listMessageWindow(ctx, queryer, options, "latest", "", limit)
}

func listMessageWindow(ctx context.Context, queryer pgQueryer, options ListOptions, direction, cursor string, limit int) ([]MessageRecord, error) {
	spaceID := normalizeSpaceID(options.SpaceID)
	conversationID := strings.TrimSpace(options.ConversationID)
	viewerID := strings.TrimSpace(options.ActorID)
	args := []any{spaceID, conversationID}
	whereCursor := ""
	if cursor != "" {
		var cursorTime time.Time
		var cursorID string
		err := queryer.QueryRow(ctx, `
			SELECT created_at, id
			FROM messages
			WHERE space_id = $1 AND id = $2 AND conversation_id = $3
			  AND topic_id IS NULL AND deleted_at IS NULL
		`, spaceID, cursor, conversationID).Scan(&cursorTime, &cursorID)
		if errors.Is(err, pgx.ErrNoRows) {
			return []MessageRecord{}, nil
		}
		if err != nil {
			return nil, err
		}
		args = append(args, cursorTime, cursorID)
		if direction == "before" {
			whereCursor = " AND (m.created_at < $3 OR (m.created_at = $3 AND m.id < $4))"
		} else {
			whereCursor = " AND (m.created_at > $3 OR (m.created_at = $3 AND m.id > $4))"
		}
	}
	order := "DESC"
	if direction == "after" {
		order = "ASC"
	}
	args = append(args, limit, viewerID)
	limitPlaceholder := "$5"
	viewerPlaceholder := "$6"
	if cursor == "" {
		limitPlaceholder = "$3"
		viewerPlaceholder = "$4"
	}
	query := messageSelectWithViewer(viewerPlaceholder) + `
		WHERE m.space_id = $1
		  AND m.conversation_id = $2
		  AND m.topic_id IS NULL
		  AND m.deleted_at IS NULL
	` + whereCursor + `
		ORDER BY m.created_at ` + order + `, m.id ` + order + `
		LIMIT ` + limitPlaceholder
	rows, err := queryer.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]MessageRecord, 0, limit)
	for rows.Next() {
		record, err := scanMessageRows(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if direction != "after" {
		for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
			result[left], result[right] = result[right], result[left]
		}
	}
	return result, nil
}

func messageSelectWithViewer(viewerPlaceholder string) string {
	return strings.Replace(messageSelect, "$4", viewerPlaceholder, 1)
}

func scanMessageRows(rows pgx.Rows) (*MessageRecord, error) {
	var record MessageRecord
	var authorID, clientID, replyID *string
	var authorNickname, authorRemark, authorGitHub, authorAvatar string
	var contentJSON string
	var editedAt, deletedAt, recalledAt *time.Time
	var recallReason *string
	err := rows.Scan(&record.ID, &record.SpaceID, &record.ConversationID, &authorID, &record.AuthorName,
		&authorNickname, &authorRemark, &authorGitHub, &authorAvatar, &record.AuthorKind, &record.Kind,
		&clientID, &contentJSON, &record.PlainText, &replyID, &record.CreatedAt, &editedAt, &deletedAt,
		&recalledAt, &recallReason, &record.Revision, &record.EventSeq, &record.PinnedByUserID, &record.PinnedAt, &record.TopicID)
	if err != nil {
		return nil, err
	}
	record.AuthorID = stringPointer(authorID)
	record.AuthorNickname = authorNickname
	record.AuthorRemark = authorRemark
	record.AuthorGitHubLogin = authorGitHub
	record.AuthorAvatarURL = sanitizeMessageAvatar(authorAvatar)
	record.ClientMessageID = stringPointer(clientID)
	record.ContentJSON = []byte(contentJSON)
	record.ReplyToMessageID = stringPointer(replyID)
	record.CreatedAt = record.CreatedAt.UTC()
	record.EditedAt = utcTimePointer(editedAt)
	record.DeletedAt = utcTimePointer(deletedAt)
	record.RecalledAt = utcTimePointer(recalledAt)
	record.RecallReason = stringPointer(recallReason)
	return &record, nil
}

func listAttachments(ctx context.Context, queryer pgQueryer, spaceID, viewerID string, messageIDs []string) (map[string][]AttachmentRecord, error) {
	return listAttachmentsRows(ctx, queryer, spaceID, viewerID, messageIDs)
}

func listAttachmentsRows(ctx context.Context, queryer pgQueryer, spaceID, viewerID string, messageIDs []string) (map[string][]AttachmentRecord, error) {
	result := make(map[string][]AttachmentRecord, len(messageIDs))
	for _, id := range messageIDs {
		result[id] = make([]AttachmentRecord, 0)
	}
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := queryer.Query(ctx, `
		SELECT
			ma.message_id, a.id, a.space_id, a.uploader_id, a.conversation_id,
			COALESCE(ur.remark, u.nickname, u.github_login, u.display_name, ''),
			a.visibility, a.status, a.file_name, a.mime_type, a.byte_size,
			a.created_at, a.completed_at
		FROM message_attachments ma
		INNER JOIN attachments a ON a.id = ma.attachment_id
		INNER JOIN messages m ON m.id = ma.message_id AND m.space_id = $1
		INNER JOIN users u ON u.id = a.uploader_id
		LEFT JOIN space_members uploader_members
			ON uploader_members.space_id = a.space_id
			AND uploader_members.user_id = u.id
			AND uploader_members.removed_at IS NULL
		LEFT JOIN user_remarks ur
			ON ur.owner_user_id = $2
			AND ur.target_user_id = u.id
			AND uploader_members.user_id IS NOT NULL
		WHERE a.space_id = $1 AND ma.message_id = ANY($3::text[])
		ORDER BY ma.message_id, a.created_at ASC, a.id ASC
	`, spaceID, viewerID, messageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var record AttachmentRecord
		if err := rows.Scan(&messageID, &record.ID, &record.SpaceID, &record.UploaderID, &record.ConversationID,
			&record.UploaderName, &record.Visibility, &record.Status, &record.FileName, &record.MIMEType, &record.ByteSize,
			&record.CreatedAt, &record.CompletedAt); err != nil {
			return nil, err
		}
		record.CreatedAt = record.CreatedAt.UTC()
		result[messageID] = append(result[messageID], record)
	}
	return result, rows.Err()
}

func listReactions(ctx context.Context, queryer pgQueryer, spaceID, viewerID string, messageIDs []string) (map[string][]ReactionGroup, error) {
	result := make(map[string][]ReactionGroup, len(messageIDs))
	for _, id := range messageIDs {
		result[id] = make([]ReactionGroup, 0)
	}
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := queryer.Query(ctx, `
		SELECT
			mr.message_id, mr.emote_key, mr.created_at,
			u.id, COALESCE(ur.remark, u.nickname, u.github_login, u.display_name, ''),
			u.github_login, u.avatar_url
		FROM message_reactions mr
		INNER JOIN users u ON u.id = mr.user_id
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $2 AND ur.target_user_id = u.id
		INNER JOIN messages m ON m.id = mr.message_id AND m.space_id = $1
		WHERE mr.message_id = ANY($3::text[])
		ORDER BY mr.created_at ASC, u.display_name ASC, u.id ASC
	`, spaceID, viewerID, messageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	groupIndexes := make(map[string]int)
	for rows.Next() {
		var messageID, emoteKey, userID, displayName string
		var createdAt time.Time
		var githubLogin, avatarURL *string
		if err := rows.Scan(&messageID, &emoteKey, &createdAt, &userID, &displayName, &githubLogin, &avatarURL); err != nil {
			return nil, err
		}
		key := messageID + "\x00" + emoteKey
		groupIndex, ok := groupIndexes[key]
		if !ok {
			result[messageID] = append(result[messageID], ReactionGroup{EmoteKey: emoteKey, Users: make([]ReactionUser, 0)})
			groupIndex = len(result[messageID]) - 1
			groupIndexes[key] = groupIndex
		}
		group := &result[messageID][groupIndex]
		group.Count++
		if userID == viewerID {
			group.ReactedByCurrentUser = true
		}
		group.Users = append(group.Users, ReactionUser{
			ID:          userID,
			DisplayName: displayName,
			GitHubLogin: stringValue(githubLogin),
			AvatarURL:   sanitizeMessageAvatar(stringValue(avatarURL)),
			CreatedAt:   formatTimestamp(createdAt),
		})
	}
	return result, rows.Err()
}

func listHidden(ctx context.Context, queryer pgQueryer, spaceID, viewerID string, messageIDs []string) (map[string]bool, error) {
	result := make(map[string]bool, len(messageIDs))
	for _, id := range messageIDs {
		result[id] = false
	}
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := queryer.Query(ctx, `
		SELECT h.message_id
		FROM message_hidden_states h
		INNER JOIN messages m ON m.id = h.message_id AND m.space_id = $1
		WHERE h.user_id = $2 AND h.message_id = ANY($3::text[])
	`, spaceID, viewerID, messageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		if err := rows.Scan(&messageID); err != nil {
			return nil, err
		}
		result[messageID] = true
	}
	return result, rows.Err()
}

func listMessageEmoteCollectionShares(ctx context.Context, queryer pgQueryer, spaceID, viewerID string, messageIDs []string, builtinSource BuiltinEmoteSource) (map[string]map[string]EmoteCollectionShare, error) {
	ids := uniqueMessageIDs(messageIDs)
	result := make(map[string]map[string]EmoteCollectionShare, len(ids))
	for _, id := range ids {
		result[id] = make(map[string]EmoteCollectionShare)
	}
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := queryer.Query(ctx, `
		SELECT mes.message_id, s.id, s.snapshot_name, s.item_count, s.created_at, s.revoked_at,
			s.shared_by_user_id,
			COALESCE(sr.remark, su.nickname, su.github_login, su.display_name, su.id),
			s.original_creator_user_id,
			COALESCE(orr.remark, ou.nickname, ou.github_login, ou.display_name, ou.id)
		FROM message_emote_collection_shares mes
		INNER JOIN messages m ON m.id = mes.message_id
			AND m.space_id = $1 AND m.deleted_at IS NULL
		INNER JOIN workspace_emote_collection_shares s ON s.id = mes.share_id
		INNER JOIN users su ON su.id = s.shared_by_user_id
		INNER JOIN users ou ON ou.id = s.original_creator_user_id
		LEFT JOIN user_remarks sr ON sr.owner_user_id = $2 AND sr.target_user_id = su.id
		LEFT JOIN user_remarks orr ON orr.owner_user_id = $2 AND orr.target_user_id = ou.id
		WHERE mes.message_id = ANY($3::text[])
			AND (m.topic_id IS NULL OR EXISTS (SELECT 1 FROM topic_members tm WHERE tm.topic_id = m.topic_id AND tm.user_id = $2 AND tm.left_at IS NULL))
			AND EXISTS (
				SELECT 1 FROM conversation_members cm
				INNER JOIN space_members sm ON sm.user_id = cm.user_id
					AND sm.space_id = $1 AND sm.removed_at IS NULL
				WHERE cm.conversation_id = m.conversation_id
					AND cm.user_id = $2 AND cm.removed_at IS NULL
			)
		ORDER BY mes.message_id, s.created_at ASC, s.id ASC
	`, spaceID, viewerID, ids)
	if err != nil {
		return nil, err
	}
	shareIDs := make([]string, 0)
	seenShareIDs := make(map[string]struct{})
	for rows.Next() {
		var messageID, shareID, name, sharedByID, sharedByName, originalCreatorID, originalCreatorName string
		var itemCount int
		var createdAt time.Time
		var revokedAt *time.Time
		if err := rows.Scan(&messageID, &shareID, &name, &itemCount, &createdAt, &revokedAt,
			&sharedByID, &sharedByName, &originalCreatorID, &originalCreatorName); err != nil {
			rows.Close()
			return nil, err
		}
		projected := EmoteCollectionShare{
			ID: shareID, Name: name, ItemCount: itemCount, CreatedAt: formatTimestamp(createdAt),
			RevokedAt:       formatNullableTimestamp(revokedAt),
			SharedBy:        EmoteCollectionSharePerson{ID: sharedByID, DisplayName: sharedByName},
			OriginalCreator: EmoteCollectionSharePerson{ID: originalCreatorID, DisplayName: originalCreatorName},
			CanRevoke:       sharedByID == strings.TrimSpace(viewerID),
			Covers:          make([]EmoteCollectionShareCover, 0),
			SharePath:       "/workspace/emotes/shared/" + url.PathEscape(shareID),
		}
		if result[messageID] == nil {
			result[messageID] = make(map[string]EmoteCollectionShare)
		}
		result[messageID][shareID] = projected
		if _, seen := seenShareIDs[shareID]; !seen {
			seenShareIDs[shareID] = struct{}{}
			shareIDs = append(shareIDs, shareID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(shareIDs) == 0 {
		return result, nil
	}

	coverRows, err := queryer.Query(ctx, `
		SELECT si.share_id, e.id, e.source_type, e.source_emote_key, e.label, e.frame_count
		FROM workspace_emote_collection_share_items si
		INNER JOIN workspace_custom_emotes e ON e.id = si.emote_id
		WHERE si.share_id = ANY($1::text[]) AND si.sort_order < 4
		ORDER BY si.share_id, si.sort_order ASC, e.id ASC
	`, shareIDs)
	if err != nil {
		return nil, err
	}
	for coverRows.Next() {
		var shareID, emoteID, sourceType, label string
		var sourceEmoteKey *string
		var frameCount *int
		if err := coverRows.Scan(&shareID, &emoteID, &sourceType, &sourceEmoteKey, &label, &frameCount); err != nil {
			coverRows.Close()
			return nil, err
		}
		cover, ok := messageShareCover(ctx, builtinSource, emoteID, sourceType, stringValue(sourceEmoteKey), label, frameCount)
		if !ok {
			continue
		}
		for messageID, shares := range result {
			share, exists := shares[shareID]
			if !exists || len(share.Covers) >= 4 {
				continue
			}
			share.Covers = append(share.Covers, cover)
			shares[shareID] = share
			result[messageID] = shares
		}
	}
	if err := coverRows.Err(); err != nil {
		coverRows.Close()
		return nil, err
	}
	coverRows.Close()
	return result, nil
}

func messageShareCover(ctx context.Context, builtinSource BuiltinEmoteSource, emoteID, sourceType, sourceEmoteKey, label string, frameCount *int) (EmoteCollectionShareCover, bool) {
	if sourceType == "builtin" {
		if builtinSource == nil {
			return EmoteCollectionShareCover{}, false
		}
		src, ok := builtinSource.ResolveBuiltinEmote(ctx, sourceEmoteKey)
		if !ok || strings.TrimSpace(src) == "" {
			return EmoteCollectionShareCover{}, false
		}
		return EmoteCollectionShareCover{ID: emoteID, Label: label, Src: src}, true
	}
	animated := frameCount != nil && *frameCount > 1
	return EmoteCollectionShareCover{
		ID: emoteID, Label: label,
		Src:      "/api/workspace/emotes/" + url.PathEscape(emoteID) + "/content",
		Animated: &animated,
	}, true
}

func uniqueMessageIDs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func findMentionMember(ctx context.Context, queryer pgQueryer, spaceID, conversationID, userID string) (*MentionMember, error) {
	var member MentionMember
	var nickname, githubLogin *string
	err := queryer.QueryRow(ctx, `
		SELECT u.id, u.display_name, u.nickname, u.github_login, u.kind
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = $1 AND sm.removed_at IS NULL
		INNER JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = $2 AND cm.removed_at IS NULL
		WHERE u.id = $3
	`, spaceID, conversationID, userID).Scan(&member.ID, &member.DisplayName, &nickname, &githubLogin, &member.Kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	member.Nickname = stringValue(nickname)
	member.GitHubLogin = stringValue(githubLogin)
	return &member, nil
}

func findAttachment(ctx context.Context, queryer pgQueryer, spaceID, attachmentID string) (*AttachmentRecord, error) {
	var record AttachmentRecord
	err := queryer.QueryRow(ctx, `
		SELECT id, space_id, uploader_id, conversation_id, visibility, status,
		       file_name, mime_type, byte_size, created_at, completed_at
		FROM attachments
		WHERE id = $1 AND space_id = $2
	`, attachmentID, spaceID).Scan(&record.ID, &record.SpaceID, &record.UploaderID, &record.ConversationID,
		&record.Visibility, &record.Status, &record.FileName, &record.MIMEType, &record.ByteSize,
		&record.CreatedAt, &record.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.CreatedAt = record.CreatedAt.UTC()
	return &record, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableStringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func utcTimePointer(value *time.Time) *time.Time {
	if value == nil || value.IsZero() {
		return nil
	}
	copyValue := value.UTC()
	return &copyValue
}

func normalizeTimestamp(value time.Time) time.Time {
	if value.IsZero() {
		return time.Unix(0, 0).UTC()
	}
	return value.UTC().Truncate(time.Millisecond)
}

var _ Repository = (*PGRepository)(nil)
var _ RecallReasonLookup = (*PGRepository)(nil)
