package conversations

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceMembers "github.com/timestarry/duallane/apps/backend/internal/workspace/members"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

// PGRepository is the native pgx adapter for the conversation boundary. It
// deliberately exposes no general-purpose query method to application code.
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
		return internalError("ping conversation database", errors.New("workspace postgres pool is required"))
	}
	if err := r.pool.Ping(ctx); err != nil {
		return internalError("ping conversation database", err)
	}
	return nil
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin conversation transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin conversation transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin conversation transaction", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()
	adapter := &pgTx{tx: tx, idFactory: r.idFactory}
	if err := callback(adapter); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return internalError("commit conversation transaction", err)
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup conversation actor", errors.New("workspace postgres pool is required"))
	}
	return lookupActor(ctx, r.pool, spaceID, userID)
}

func (r *PGRepository) ListConversationRecords(ctx context.Context, spaceID, actorID string) ([]ConversationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list conversations", errors.New("workspace postgres pool is required"))
	}
	rows, err := r.pool.Query(ctx, conversationSelect+`WHERE c.space_id = $1 AND cm.user_id = $2 AND cm.removed_at IS NULL
		GROUP BY c.id, c.space_id, c.type, c.title, c.avatar_emoji, c.retention_count, c.created_at, cm.last_read_message_id, cm.last_read_at, cm.last_read_seq, cm.notification_level
		ORDER BY last_activity_at DESC, c.created_at DESC, c.id DESC`, spaceID, actorID)
	if err != nil {
		return nil, internalError("list conversations", err)
	}
	defer rows.Close()
	return scanConversationRecords(rows)
}

func (r *PGRepository) GetVisibleConversationRecord(ctx context.Context, spaceID, actorID, conversationID string) (*ConversationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("get conversation", errors.New("workspace postgres pool is required"))
	}
	row := r.pool.QueryRow(ctx, conversationSelect+`WHERE c.space_id = $1 AND c.id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
		GROUP BY c.id, c.space_id, c.type, c.title, c.avatar_emoji, c.retention_count, c.created_at, cm.last_read_message_id, cm.last_read_at, cm.last_read_seq, cm.notification_level`, spaceID, conversationID, actorID)
	record, err := scanConversationRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get conversation", err)
	}
	return &record, nil
}

func (r *PGRepository) FindConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find conversation", errors.New("workspace postgres pool is required"))
	}
	row := r.pool.QueryRow(ctx, baseConversationSelect+`WHERE c.space_id = $1 AND c.id = $2`, spaceID, conversationID)
	record, err := scanBaseConversationRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find conversation", err)
	}
	return &record, nil
}

func (r *PGRepository) FindDirectConversation(ctx context.Context, spaceID, directKey string) (*ConversationRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find direct conversation", errors.New("workspace postgres pool is required"))
	}
	row := r.pool.QueryRow(ctx, baseConversationSelect+`WHERE c.space_id = $1 AND c.direct_key = $2`, spaceID, directKey)
	record, err := scanBaseConversationRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find direct conversation", err)
	}
	return &record, nil
}

func (r *PGRepository) ListConversationMembers(ctx context.Context, spaceID, conversationID, viewerID string) ([]MemberRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list conversation members", errors.New("workspace postgres pool is required"))
	}
	rows, err := r.pool.Query(ctx, memberSelect+`INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $2
		WHERE cm.conversation_id = $1 AND cm.removed_at IS NULL AND sm.space_id = $2 AND sm.removed_at IS NULL
		ORDER BY u.display_name ASC, u.id ASC`, conversationID, spaceID, viewerID)
	if err != nil {
		return nil, internalError("list conversation members", err)
	}
	defer rows.Close()
	return scanMemberRecords(rows)
}

func (r *PGRepository) ListLatestMessages(ctx context.Context, spaceID, conversationID, viewerID string, limit int) ([]MessageRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list latest messages", errors.New("workspace postgres pool is required"))
	}
	limit = boundedLimit(limit, 20, 100)
	rows, err := r.pool.Query(ctx, messageSelect+`WHERE m.space_id = $1 AND m.conversation_id = $2 AND m.topic_id IS NULL AND m.deleted_at IS NULL
	ORDER BY m.created_at DESC, m.id DESC LIMIT $4`, spaceID, conversationID, viewerID, limit)
	if err != nil {
		return nil, internalError("list latest messages", err)
	}
	defer rows.Close()
	items, err := scanMessageRecords(rows)
	if err != nil {
		return nil, err
	}
	// The legacy HTTP route returns chronological messages within its latest
	// window even though storage is read newest-first.
	for left, right := 0, len(items)-1; left < right; left, right = left+1, right-1 {
		items[left], items[right] = items[right], items[left]
	}
	return items, nil
}

func (r *PGRepository) ListMessageAttachments(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]workspaceMessages.AttachmentRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list conversation message attachments", errors.New("workspace postgres pool is required"))
	}
	return workspaceMessages.NewPGRepository(r.pool).ListAttachments(ctx, spaceID, viewerID, messageIDs)
}

func (r *PGRepository) ListMessageReactions(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]workspaceMessages.ReactionGroup, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list conversation message reactions", errors.New("workspace postgres pool is required"))
	}
	return workspaceMessages.NewPGRepository(r.pool).ListReactions(ctx, spaceID, viewerID, messageIDs)
}

func (r *PGRepository) ListMessageHidden(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string]bool, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list conversation message hidden states", errors.New("workspace postgres pool is required"))
	}
	return workspaceMessages.NewPGRepository(r.pool).ListHidden(ctx, spaceID, viewerID, messageIDs)
}

func (r *PGRepository) FindMember(ctx context.Context, spaceID, userID string) (*MemberRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find space member", errors.New("workspace postgres pool is required"))
	}
	row := r.pool.QueryRow(ctx, spaceMemberSelect+`WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL`, userID, spaceID, "")
	record, err := scanMemberRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find space member", err)
	}
	return &record, nil
}

func (r *PGRepository) MemberVisible(ctx context.Context, spaceID, viewerID, visibleUserID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check member visibility", errors.New("workspace postgres pool is required"))
	}
	var visible bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM space_members viewer_sm
			WHERE viewer_sm.space_id = $1 AND viewer_sm.user_id = $2 AND viewer_sm.removed_at IS NULL
			  AND viewer_sm.role = 'owner'
		) OR EXISTS (
			SELECT 1 FROM space_members target_sm
			WHERE target_sm.space_id = $1 AND target_sm.user_id = $3 AND target_sm.removed_at IS NULL
		) AND (
			$2 = $3
			OR EXISTS (
				SELECT 1 FROM member_visibility_grants g
				WHERE g.space_id = $1 AND g.viewer_user_id = $2 AND g.visible_user_id = $3
			)
			OR EXISTS (
				SELECT 1
				FROM conversations c
				INNER JOIN conversation_members viewer_cm ON viewer_cm.conversation_id = c.id AND viewer_cm.user_id = $2 AND viewer_cm.removed_at IS NULL
				INNER JOIN conversation_members target_cm ON target_cm.conversation_id = c.id AND target_cm.user_id = $3 AND target_cm.removed_at IS NULL
				WHERE c.space_id = $1 AND c.type = 'direct'
			)
			OR $3 = ANY($4::text[])
		)`, spaceID, viewerID, visibleUserID, []string{workspaceMembers.BeaconUserID, workspaceMembers.EchoUserID}).Scan(&visible)
	if err != nil {
		return false, internalError("check member visibility", err)
	}
	return visible, nil
}

func (r *PGRepository) SharesActiveGroup(ctx context.Context, spaceID, actorID, targetUserID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check shared group", errors.New("workspace postgres pool is required"))
	}
	var exists bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversations c
			INNER JOIN conversation_members actor_cm ON actor_cm.conversation_id = c.id AND actor_cm.user_id = $2 AND actor_cm.removed_at IS NULL
			INNER JOIN conversation_members target_cm ON target_cm.conversation_id = c.id AND target_cm.user_id = $3 AND target_cm.removed_at IS NULL
			WHERE c.space_id = $1 AND c.type = 'group'
		)`, spaceID, actorID, targetUserID).Scan(&exists)
	if err != nil {
		return false, internalError("check shared group", err)
	}
	return exists, nil
}

func (r *PGRepository) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check conversation member", errors.New("workspace postgres pool is required"))
	}
	var exists bool
	err := r.pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM conversation_members cm
		INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
		WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
	)`, spaceID, conversationID, userID).Scan(&exists)
	if err != nil {
		return false, internalError("check conversation member", err)
	}
	return exists, nil
}

func (r *PGRepository) CountActiveConversationMembers(ctx context.Context, spaceID, conversationID string) (int, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count conversation members", errors.New("workspace postgres pool is required"))
	}
	var count int
	err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM conversation_members cm
		INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
		WHERE cm.conversation_id = $2 AND cm.removed_at IS NULL`, spaceID, conversationID).Scan(&count)
	if err != nil {
		return 0, internalError("count conversation members", err)
	}
	return count, nil
}

func (r *PGRepository) FindMessageForPin(ctx context.Context, spaceID, conversationID, messageID string) (*MessageRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find pin message", errors.New("workspace postgres pool is required"))
	}
	row := r.pool.QueryRow(ctx, messageSelect+`WHERE m.space_id = $1 AND m.conversation_id = $2 AND m.id = $4 AND m.deleted_at IS NULL`, spaceID, conversationID, "", messageID)
	record, err := scanMessageRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find pin message", err)
	}
	return &record, nil
}

func (r *PGRepository) FindPin(ctx context.Context, spaceID, conversationID, messageID, viewerID string) (*PinRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find message pin", errors.New("workspace postgres pool is required"))
	}
	row := r.pool.QueryRow(ctx, pinSelect+`WHERE p.conversation_id = $1 AND p.message_id = $2 AND m.space_id = $4 AND `+topicPinVisibleSQL, conversationID, messageID, viewerID, spaceID)
	pin, err := scanPinRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find message pin", err)
	}
	return &pin, nil
}

func (r *PGRepository) ListPins(ctx context.Context, spaceID, conversationID, viewerID string, limit int) ([]PinRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list message pins", errors.New("workspace postgres pool is required"))
	}
	limit = boundedLimit(limit, 20, 100)
	rows, err := r.pool.Query(ctx, pinSelect+`WHERE p.conversation_id = $1 AND m.space_id = $2 AND m.deleted_at IS NULL AND `+topicPinVisibleSQL+`
		ORDER BY p.created_at DESC, p.message_id DESC LIMIT $4`, conversationID, spaceID, viewerID, limit)
	if err != nil {
		return nil, internalError("list message pins", err)
	}
	defer rows.Close()
	return scanPinRecords(rows)
}

type pgTx struct {
	tx        pgx.Tx
	idFactory IDFactory
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID)
}

func (t *pgTx) ListConversationRecords(ctx context.Context, spaceID, actorID string) ([]ConversationRecord, error) {
	rows, err := t.tx.Query(ctx, conversationSelect+`WHERE c.space_id = $1 AND cm.user_id = $2 AND cm.removed_at IS NULL
		GROUP BY c.id, c.space_id, c.type, c.title, c.avatar_emoji, c.retention_count, c.created_at, cm.last_read_message_id, cm.last_read_at, cm.last_read_seq, cm.notification_level
		ORDER BY last_activity_at DESC, c.created_at DESC, c.id DESC`, spaceID, actorID)
	if err != nil {
		return nil, internalError("list conversations", err)
	}
	defer rows.Close()
	return scanConversationRecords(rows)
}

func (t *pgTx) GetVisibleConversationRecord(ctx context.Context, spaceID, actorID, conversationID string) (*ConversationRecord, error) {
	row := t.tx.QueryRow(ctx, conversationSelect+`WHERE c.space_id = $1 AND c.id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
		GROUP BY c.id, c.space_id, c.type, c.title, c.avatar_emoji, c.retention_count, c.created_at, cm.last_read_message_id, cm.last_read_at, cm.last_read_seq, cm.notification_level`, spaceID, conversationID, actorID)
	record, err := scanConversationRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("get conversation", err)
	}
	return &record, nil
}

func (t *pgTx) FindConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	row := t.tx.QueryRow(ctx, baseConversationSelect+`WHERE c.space_id = $1 AND c.id = $2`, spaceID, conversationID)
	record, err := scanBaseConversationRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find conversation", err)
	}
	return &record, nil
}

func (t *pgTx) FindDirectConversation(ctx context.Context, spaceID, directKey string) (*ConversationRecord, error) {
	row := t.tx.QueryRow(ctx, baseConversationSelect+`WHERE c.space_id = $1 AND c.direct_key = $2`, spaceID, directKey)
	record, err := scanBaseConversationRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find direct conversation", err)
	}
	return &record, nil
}

func (t *pgTx) ListConversationMembers(ctx context.Context, spaceID, conversationID, viewerID string) ([]MemberRecord, error) {
	rows, err := t.tx.Query(ctx, memberSelect+`INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $2
		WHERE cm.conversation_id = $1 AND cm.removed_at IS NULL AND sm.space_id = $2 AND sm.removed_at IS NULL
		ORDER BY u.display_name ASC, u.id ASC`, conversationID, spaceID, viewerID)
	if err != nil {
		return nil, internalError("list conversation members", err)
	}
	defer rows.Close()
	return scanMemberRecords(rows)
}

func (t *pgTx) ListLatestMessages(ctx context.Context, spaceID, conversationID, viewerID string, limit int) ([]MessageRecord, error) {
	limit = boundedLimit(limit, 20, 100)
	rows, err := t.tx.Query(ctx, messageSelect+`WHERE m.space_id = $1 AND m.conversation_id = $2 AND m.topic_id IS NULL AND m.deleted_at IS NULL
		ORDER BY m.created_at DESC, m.id DESC LIMIT $4`, spaceID, conversationID, viewerID, limit)
	if err != nil {
		return nil, internalError("list latest messages", err)
	}
	defer rows.Close()
	items, err := scanMessageRecords(rows)
	if err != nil {
		return nil, err
	}
	for left, right := 0, len(items)-1; left < right; left, right = left+1, right-1 {
		items[left], items[right] = items[right], items[left]
	}
	return items, nil
}

// These message reads wrap the already-open transaction; the adapter does
// not acquire the repository pool or create a second transaction.
func (t *pgTx) ListMessageAttachments(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]workspaceMessages.AttachmentRecord, error) {
	return workspaceMessages.NewPGTransaction(t.tx).ListAttachments(ctx, spaceID, viewerID, messageIDs)
}

func (t *pgTx) ListMessageReactions(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]workspaceMessages.ReactionGroup, error) {
	return workspaceMessages.NewPGTransaction(t.tx).ListReactions(ctx, spaceID, viewerID, messageIDs)
}

func (t *pgTx) ListMessageHidden(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string]bool, error) {
	return workspaceMessages.NewPGTransaction(t.tx).ListHidden(ctx, spaceID, viewerID, messageIDs)
}

func (t *pgTx) FindMember(ctx context.Context, spaceID, userID string) (*MemberRecord, error) {
	row := t.tx.QueryRow(ctx, spaceMemberSelect+`WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL`, userID, spaceID, "")
	record, err := scanMemberRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find space member", err)
	}
	return &record, nil
}

func (t *pgTx) MemberVisible(ctx context.Context, spaceID, viewerID, visibleUserID string) (bool, error) {
	var visible bool
	err := t.tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM space_members viewer_sm
			WHERE viewer_sm.space_id = $1 AND viewer_sm.user_id = $2 AND viewer_sm.removed_at IS NULL AND viewer_sm.role = 'owner'
		) OR EXISTS (
			SELECT 1 FROM space_members target_sm
			WHERE target_sm.space_id = $1 AND target_sm.user_id = $3 AND target_sm.removed_at IS NULL
		) AND (
			$2 = $3 OR EXISTS (SELECT 1 FROM member_visibility_grants g WHERE g.space_id = $1 AND g.viewer_user_id = $2 AND g.visible_user_id = $3)
			OR EXISTS (
				SELECT 1 FROM conversations c
				INNER JOIN conversation_members viewer_cm ON viewer_cm.conversation_id = c.id AND viewer_cm.user_id = $2 AND viewer_cm.removed_at IS NULL
				INNER JOIN conversation_members target_cm ON target_cm.conversation_id = c.id AND target_cm.user_id = $3 AND target_cm.removed_at IS NULL
				WHERE c.space_id = $1 AND c.type = 'direct'
			)
			OR $3 = ANY($4::text[])
		)`, spaceID, viewerID, visibleUserID, []string{workspaceMembers.BeaconUserID, workspaceMembers.EchoUserID}).Scan(&visible)
	if err != nil {
		return false, internalError("check member visibility", err)
	}
	return visible, nil
}

func (t *pgTx) SharesActiveGroup(ctx context.Context, spaceID, actorID, targetUserID string) (bool, error) {
	var exists bool
	err := t.tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM conversations c
		INNER JOIN conversation_members actor_cm ON actor_cm.conversation_id = c.id AND actor_cm.user_id = $2 AND actor_cm.removed_at IS NULL
		INNER JOIN conversation_members target_cm ON target_cm.conversation_id = c.id AND target_cm.user_id = $3 AND target_cm.removed_at IS NULL
		WHERE c.space_id = $1 AND c.type = 'group'
	)`, spaceID, actorID, targetUserID).Scan(&exists)
	if err != nil {
		return false, internalError("check shared group", err)
	}
	return exists, nil
}

func (t *pgTx) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	var exists bool
	err := t.tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM conversation_members cm
		INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
		WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
	)`, spaceID, conversationID, userID).Scan(&exists)
	if err != nil {
		return false, internalError("check conversation member", err)
	}
	return exists, nil
}

func (t *pgTx) CountActiveConversationMembers(ctx context.Context, spaceID, conversationID string) (int, error) {
	var count int
	err := t.tx.QueryRow(ctx, `SELECT COUNT(*) FROM conversation_members cm
		INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
		WHERE cm.conversation_id = $2 AND cm.removed_at IS NULL`, spaceID, conversationID).Scan(&count)
	if err != nil {
		return 0, internalError("count conversation members", err)
	}
	return count, nil
}

func (t *pgTx) FindMessageForPin(ctx context.Context, spaceID, conversationID, messageID string) (*MessageRecord, error) {
	row := t.tx.QueryRow(ctx, messageSelect+`WHERE m.space_id = $1 AND m.conversation_id = $2 AND m.id = $4 AND m.deleted_at IS NULL`, spaceID, conversationID, "", messageID)
	record, err := scanMessageRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find pin message", err)
	}
	return &record, nil
}

func (t *pgTx) FindPin(ctx context.Context, spaceID, conversationID, messageID, viewerID string) (*PinRecord, error) {
	row := t.tx.QueryRow(ctx, pinSelect+`WHERE p.conversation_id = $1 AND p.message_id = $2 AND m.space_id = $4 AND `+topicPinVisibleSQL, conversationID, messageID, viewerID, spaceID)
	pin, err := scanPinRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find message pin", err)
	}
	return &pin, nil
}

func (t *pgTx) ListPins(ctx context.Context, spaceID, conversationID, viewerID string, limit int) ([]PinRecord, error) {
	limit = boundedLimit(limit, 20, 100)
	rows, err := t.tx.Query(ctx, pinSelect+`WHERE p.conversation_id = $1 AND m.space_id = $2 AND m.deleted_at IS NULL AND `+topicPinVisibleSQL+`
		ORDER BY p.created_at DESC, p.message_id DESC LIMIT $4`, conversationID, spaceID, viewerID, limit)
	if err != nil {
		return nil, internalError("list message pins", err)
	}
	defer rows.Close()
	return scanPinRecords(rows)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return internalError("lock conversation resource", errors.New("lock key is required"))
	}
	if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); err != nil {
		return internalError("lock conversation resource", err)
	}
	return nil
}

func (t *pgTx) CreateConversation(ctx context.Context, record CreateConversationRecord) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO conversations (
		id, space_id, type, title, avatar_emoji, direct_key, retention_count, created_by, created_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, record.ID, record.SpaceID, record.Type, record.Title, nullableStringArg(record.AvatarEmoji), nullableStringArg(record.DirectKey), record.RetentionCount, record.CreatedBy, record.CreatedAt.UTC())
	if err != nil {
		return internalError("create conversation", err)
	}
	return nil
}

func (t *pgTx) UpsertConversationMember(ctx context.Context, spaceID, conversationID, userID string, joinedAt time.Time) (bool, error) {
	var inserted bool
	err := t.tx.QueryRow(ctx, `INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
		VALUES ($1, $2, $3, NULL)
		ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL, joined_at = EXCLUDED.joined_at
		WHERE conversation_members.removed_at IS NOT NULL
		RETURNING TRUE`, conversationID, userID, joinedAt.UTC()).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, internalError("add conversation member", err)
	}
	return inserted, nil
}

func (t *pgTx) RemoveConversationMember(ctx context.Context, spaceID, conversationID, userID string, removedAt time.Time) (bool, error) {
	var removed bool
	err := t.tx.QueryRow(ctx, `UPDATE conversation_members
		SET removed_at = $1 WHERE conversation_id = $2 AND user_id = $3 AND removed_at IS NULL RETURNING TRUE`, removedAt.UTC(), conversationID, userID).Scan(&removed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, internalError("remove conversation member", err)
	}
	return removed, nil
}

func (t *pgTx) UpdateGroup(ctx context.Context, spaceID, conversationID, title string, avatarEmoji *string) error {
	result, err := t.tx.Exec(ctx, `UPDATE conversations SET title = $1, avatar_emoji = $2 WHERE id = $3 AND space_id = $4 AND type = 'group'`, title, nullableStringArg(avatarEmoji), conversationID, spaceID)
	if err != nil {
		return internalError("update group conversation", err)
	}
	if result.RowsAffected() != 1 {
		return conversationNotFoundError()
	}
	return nil
}

func (t *pgTx) CreateSystemMessage(ctx context.Context, record SystemMessageInsert, retentionCount int64) (*MessageRecord, error) {
	if retentionCount <= 0 {
		retentionCount = DefaultRetentionCount
	}
	if _, err := t.tx.Exec(ctx, `INSERT INTO messages (
		id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
		content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at
	) VALUES ($1, $2, $3, NULL, 'system', 'system', NULL, $4, $5, $6, NULL, $7, NULL, NULL)`,
		record.ID, record.SpaceID, record.ConversationID, workspaceMessages.MessageContentFormat,
		string(record.ContentJSON), record.PlainText, record.CreatedAt.UTC()); err != nil {
		return nil, internalError("create conversation system message", err)
	}
	if _, err := t.tx.Exec(ctx, `WITH victims AS (
		SELECT m.id
		FROM messages m
		WHERE m.space_id = $1 AND m.conversation_id = $2 AND m.topic_id IS NULL AND m.deleted_at IS NULL
		  AND NOT EXISTS (SELECT 1 FROM conversation_pinned_messages p WHERE p.message_id = m.id)
		ORDER BY m.created_at DESC, m.id DESC
		OFFSET $3
	)
	UPDATE messages m SET deleted_at = COALESCE(m.deleted_at, $4)
	FROM victims WHERE m.id = victims.id`, record.SpaceID, record.ConversationID, retentionCount, record.CreatedAt.UTC()); err != nil {
		return nil, internalError("enforce conversation system message retention", err)
	}
	message, err := t.FindMessageForPin(ctx, record.SpaceID, record.ConversationID, record.ID)
	if err != nil {
		return nil, err
	}
	if message == nil {
		return nil, internalError("read conversation system message", errors.New("system message is not visible after insert"))
	}
	return message, nil
}

func (t *pgTx) MarkConversationRead(ctx context.Context, spaceID, conversationID, userID string, now time.Time) (ReadMarker, error) {
	var messageID *string
	var messageAt *time.Time
	var sequence int64
	err := t.tx.QueryRow(ctx, `
		SELECT latest.id, latest.created_at, COALESCE(latest.event_seq, (SELECT COALESCE(MAX(seq), 0) FROM workspace_events WHERE space_id = $1))
		FROM (VALUES (1)) anchor(one)
		LEFT JOIN LATERAL (
			SELECT m.id, m.created_at, we.seq AS event_seq
			FROM messages m
			LEFT JOIN workspace_events we ON we.space_id = m.space_id AND we.conversation_id = m.conversation_id
				AND we.type = 'message.created' AND we.target_id = m.id
			WHERE m.space_id = $1 AND m.conversation_id = $2 AND m.topic_id IS NULL AND m.deleted_at IS NULL
			ORDER BY m.created_at DESC, we.seq DESC NULLS LAST, m.id DESC LIMIT 1
		) latest ON TRUE`, spaceID, conversationID).Scan(&messageID, &messageAt, &sequence)
	if err != nil {
		return ReadMarker{}, internalError("resolve conversation read marker", err)
	}
	if messageAt == nil {
		messageAt = timePtr(now.UTC())
	}
	result, err := t.tx.Exec(ctx, `UPDATE conversation_members
		SET last_read_message_id = $1, last_read_at = $2, last_read_seq = $3
		WHERE conversation_id = $4 AND user_id = $5 AND removed_at IS NULL
		AND (last_read_seq IS NULL OR last_read_seq <= $3)`, nullableStringArg(messageID), messageAt.UTC(), sequence, conversationID, userID)
	if err != nil {
		return ReadMarker{}, internalError("mark conversation read", err)
	}
	if result.RowsAffected() == 0 {
		// A newer marker won a concurrent request. The operation is still
		// idempotently successful; callers will project the current row.
		return ReadMarker{MessageID: messageID, ReadAt: *messageAt, Sequence: sequence}, nil
	}
	return ReadMarker{MessageID: messageID, ReadAt: *messageAt, Sequence: sequence}, nil
}

func (t *pgTx) UpdateNotificationLevel(ctx context.Context, spaceID, conversationID, userID, level string) error {
	result, err := t.tx.Exec(ctx, `UPDATE conversation_members cm SET notification_level = $1
		FROM conversations c WHERE cm.conversation_id = c.id AND c.space_id = $2
		AND cm.conversation_id = $3 AND cm.user_id = $4 AND cm.removed_at IS NULL`, level, spaceID, conversationID, userID)
	if err != nil {
		return internalError("update conversation notification", err)
	}
	if result.RowsAffected() != 1 {
		return conversationNotFoundError()
	}
	return nil
}

func (t *pgTx) AddPin(ctx context.Context, spaceID, conversationID, messageID, userID string, createdAt time.Time) (bool, error) {
	var count int
	err := t.tx.QueryRow(ctx, `INSERT INTO conversation_pin_counters (conversation_id, user_id, pin_count)
		VALUES ($1, $2, 1)
		ON CONFLICT (conversation_id, user_id) DO UPDATE SET pin_count = conversation_pin_counters.pin_count + 1
		WHERE conversation_pin_counters.pin_count < $3
		RETURNING pin_count`, conversationID, userID, MaxPinnedMessages).Scan(&count)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, internalError("reserve message pin", err)
	}
	result, err := t.tx.Exec(ctx, `INSERT INTO conversation_pinned_messages (conversation_id, message_id, pinned_by_user_id, created_at)
		VALUES ($1, $2, $3, $4) ON CONFLICT (conversation_id, message_id) DO NOTHING`, conversationID, messageID, userID, createdAt.UTC())
	if err != nil {
		return false, internalError("add message pin", err)
	}
	if result.RowsAffected() == 1 {
		return true, nil
	}
	if _, err := t.tx.Exec(ctx, `UPDATE conversation_pin_counters SET pin_count = CASE WHEN pin_count > 0 THEN pin_count - 1 ELSE 0 END WHERE conversation_id = $1 AND user_id = $2`, conversationID, userID); err != nil {
		return false, internalError("restore message pin counter", err)
	}
	return false, nil
}

func (t *pgTx) RemovePin(ctx context.Context, spaceID, conversationID, messageID string) (*PinRecord, bool, error) {
	var pinnedBy string
	var createdAt time.Time
	err := t.tx.QueryRow(ctx, `DELETE FROM conversation_pinned_messages
		WHERE conversation_id = $1 AND message_id = $2 RETURNING pinned_by_user_id, created_at`, conversationID, messageID).Scan(&pinnedBy, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, internalError("remove message pin", err)
	}
	if _, err := t.tx.Exec(ctx, `UPDATE conversation_pin_counters SET pin_count = CASE WHEN pin_count > 0 THEN pin_count - 1 ELSE 0 END WHERE conversation_id = $1 AND user_id = $2`, conversationID, pinnedBy); err != nil {
		return nil, false, internalError("decrement message pin counter", err)
	}
	return &PinRecord{MessageID: messageID, PinnedByUserID: pinnedBy, CreatedAt: createdAt}, true, nil
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return internalError("generate workspace event id", err)
		}
		input.ID = id
	}
	if input.CreatedAt.IsZero() {
		return internalError("write workspace event", errors.New("event timestamp is required"))
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	var sequence int64
	err := t.tx.QueryRow(ctx, `INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM workspace_events WHERE space_id = $1), 1))
		ON CONFLICT (space_id) DO NOTHING
		RETURNING next_seq`, input.SpaceID).Scan(&sequence)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := t.tx.QueryRow(ctx, `SELECT next_seq FROM workspace_event_cursors WHERE space_id = $1 FOR UPDATE`, input.SpaceID).Scan(&sequence); err != nil {
			return internalError("lock workspace event cursor", err)
		}
		if _, err := t.tx.Exec(ctx, `UPDATE workspace_event_cursors SET next_seq = next_seq + 1 WHERE space_id = $1`, input.SpaceID); err != nil {
			return internalError("advance workspace event cursor", err)
		}
	} else if err != nil {
		return internalError("reserve workspace event sequence", err)
	} else {
		if _, err := t.tx.Exec(ctx, `UPDATE workspace_event_cursors SET next_seq = next_seq + 1 WHERE space_id = $1`, input.SpaceID); err != nil {
			return internalError("advance workspace event cursor", err)
		}
	}
	_, err = t.tx.Exec(ctx, `INSERT INTO workspace_events (
		id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
	) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)`, input.ID, input.SpaceID, sequence, input.Type, input.ActorID, input.ConversationID, input.TargetType, input.TargetID, string(input.PayloadJSON), input.CreatedAt.UTC())
	if err != nil {
		return internalError("write workspace event", err)
	}
	return nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return internalError("generate conversation audit id", err)
		}
		input.ID = id
	}
	if input.CreatedAt.IsZero() {
		return internalError("write conversation audit", errors.New("audit timestamp is required"))
	}
	if strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" {
		return internalError("write conversation audit", errors.New("audit action and target are required"))
	}
	result := input.Result
	if result == "" {
		result = "success"
	}
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (
		id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, ip_address, user_agent, request_id, created_at
	) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, result, input.Reason, input.IPAddress, input.UserAgent, input.RequestID, input.CreatedAt.UTC())
	if err != nil {
		return internalError("write conversation audit", err)
	}
	return nil
}

func (t *pgTx) newID() (string, error) {
	if t == nil || t.idFactory == nil {
		return "", errors.New("conversation id factory is required")
	}
	return t.idFactory()
}

const conversationSelect = `SELECT
	c.id, c.space_id, c.type, c.title, c.avatar_emoji, c.retention_count,
	c.created_at, COALESCE(MAX(m.created_at), c.created_at) AS last_activity_at,
	COUNT(m.id) FILTER (WHERE m.deleted_at IS NULL AND m.topic_id IS NULL) AS message_count,
	cm.last_read_message_id, cm.last_read_at, cm.last_read_seq, cm.notification_level,
	COUNT(m.id) FILTER (WHERE m.deleted_at IS NULL AND m.topic_id IS NULL AND (m.author_id IS NULL OR m.author_id <> cm.user_id)
		AND ((cm.last_read_seq IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_events we WHERE we.space_id = c.space_id AND we.type = 'message.created' AND we.target_id = m.id AND we.seq > cm.last_read_seq))
			OR (cm.last_read_seq IS NULL AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)))) AS unread_count
FROM conversations c
INNER JOIN conversation_members cm ON cm.conversation_id = c.id
LEFT JOIN messages m ON m.conversation_id = c.id AND m.space_id = c.space_id
	AND m.topic_id IS NULL AND m.deleted_at IS NULL
`

const baseConversationSelect = `SELECT
	c.id, c.space_id, c.type, c.title, c.avatar_emoji, c.retention_count, c.created_at
FROM conversations c
`

const memberSelect = `SELECT
	u.id, u.github_login, u.display_name, u.nickname, ur.remark, u.avatar_url,
	u.search_discoverable, u.recall_reason, u.kind, sm.role, cm.joined_at
FROM conversation_members cm
INNER JOIN users u ON u.id = cm.user_id
INNER JOIN space_members sm ON sm.user_id = u.id
LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = u.id
`

const spaceMemberSelect = `SELECT
	u.id, u.github_login, u.display_name, u.nickname, ur.remark, u.avatar_url,
	u.search_discoverable, u.recall_reason, u.kind, sm.role, sm.joined_at
FROM users u
INNER JOIN space_members sm ON sm.user_id = u.id
LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = u.id
`

const messageSelect = `SELECT
	m.id, m.conversation_id, COALESCE(m.topic_id, ''), m.author_id,
	COALESCE(ur.remark, u.nickname, u.github_login, u.display_name, '成员') AS author_name,
	u.nickname, ur.remark, u.github_login, u.avatar_url,
	m.author_kind, m.kind, m.client_message_id, m.content_json, m.plain_text,
	m.reply_to_message_id, m.created_at, m.edited_at, m.deleted_at, m.recalled_at, m.recall_reason,
	p.pinned_by_user_id, p.created_at AS pinned_at
FROM messages m
LEFT JOIN users u ON u.id = m.author_id
LEFT JOIN user_remarks ur ON ur.target_user_id = u.id AND ur.owner_user_id = $3
LEFT JOIN conversation_pinned_messages p ON p.message_id = m.id AND p.conversation_id = m.conversation_id
`

const pinSelect = `SELECT
	p.message_id, p.pinned_by_user_id, p.created_at,
	m.id, m.conversation_id, COALESCE(m.topic_id, ''), m.author_id,
	COALESCE(ur.remark, u.nickname, u.github_login, u.display_name, '成员') AS author_name,
	u.nickname, ur.remark, u.github_login, u.avatar_url,
	m.author_kind, m.kind, m.client_message_id, m.content_json, m.plain_text,
	m.reply_to_message_id, m.created_at, m.edited_at, m.deleted_at, m.recalled_at, m.recall_reason
FROM conversation_pinned_messages p
INNER JOIN messages m ON m.id = p.message_id
LEFT JOIN users u ON u.id = m.author_id
LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = u.id
`

func lookupActor(ctx context.Context, querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	var discoverable *bool
	err := querier.QueryRow(ctx, `SELECT u.id, u.github_id, u.github_login, u.email, u.display_name, u.nickname, u.avatar_url, u.search_discoverable, u.kind, sm.role, sm.joined_at
		FROM users u INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = $2 AND sm.removed_at IS NULL
		WHERE u.id = $1`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName, &nickname, &avatarURL, &discoverable, &actor.Kind, &actor.Role, &actor.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("lookup conversation actor", err)
	}
	if githubID != nil {
		actor.GitHubID = *githubID
	}
	if email != nil {
		actor.Email = *email
	}
	if nickname != nil {
		actor.Nickname = *nickname
	}
	if avatarURL != nil {
		actor.AvatarURL = *avatarURL
	}
	if discoverable != nil {
		actor.SearchDiscoverable = *discoverable
	}
	return &actor, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanConversationRecord(row rowScanner) (ConversationRecord, error) {
	var record ConversationRecord
	var avatar *string
	var createdAt, lastActivity time.Time
	if err := row.Scan(&record.ID, &record.SpaceID, &record.Type, &record.Title, &avatar, &record.RetentionCount, &createdAt, &lastActivity, &record.MessageCount, &record.LastReadMessageID, &record.LastReadAt, &record.LastReadSeq, &record.NotificationLevel, &record.UnreadCount); err != nil {
		return ConversationRecord{}, err
	}
	record.AvatarEmoji = avatar
	record.CreatedAt = createdAt
	record.LastActivityAt = lastActivity
	return record, nil
}

func scanBaseConversationRecord(row rowScanner) (ConversationRecord, error) {
	var record ConversationRecord
	if err := row.Scan(&record.ID, &record.SpaceID, &record.Type, &record.Title, &record.AvatarEmoji, &record.RetentionCount, &record.CreatedAt); err != nil {
		return ConversationRecord{}, err
	}
	record.LastActivityAt = record.CreatedAt
	record.NotificationLevel = string(NotificationAll)
	return record, nil
}

func scanConversationRecords(rows pgx.Rows) ([]ConversationRecord, error) {
	items := make([]ConversationRecord, 0)
	for rows.Next() {
		item, err := scanConversationRecord(rows)
		if err != nil {
			return nil, internalError("scan conversations", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan conversations", err)
	}
	return items, nil
}

func scanMemberRecord(row rowScanner) (MemberRecord, error) {
	var record MemberRecord
	var nickname, remark, avatarURL, recallReason *string
	if err := row.Scan(&record.ID, &record.GitHubLogin, &record.DisplayName, &nickname, &remark, &avatarURL, &record.SearchDiscoverable, &recallReason, &record.Kind, &record.Role, &record.JoinedAt); err != nil {
		return MemberRecord{}, err
	}
	record.Nickname = nickname
	record.Remark = remark
	record.AvatarURL = stringValuePtr(avatarURL)
	record.RecallReason = recallReason
	return record, nil
}

func scanMemberRecords(rows pgx.Rows) ([]MemberRecord, error) {
	items := make([]MemberRecord, 0)
	for rows.Next() {
		item, err := scanMemberRecord(rows)
		if err != nil {
			return nil, internalError("scan conversation members", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan conversation members", err)
	}
	return items, nil
}

func scanMessageRecord(row rowScanner) (MessageRecord, error) {
	var record MessageRecord
	var authorID, clientID, replyID, authorNickname, authorRemark, authorLogin, avatarURL, pinBy *string
	var pinAt *time.Time
	var content string
	if err := row.Scan(&record.ID, &record.ConversationID, &record.TopicID, &authorID, &record.AuthorName, &authorNickname, &authorRemark, &authorLogin, &avatarURL, &record.AuthorKind, &record.Kind, &clientID, &content, &record.PlainText, &replyID, &record.CreatedAt, &record.EditedAt, &record.DeletedAt, &record.RecalledAt, &record.RecallReason, &pinBy, &pinAt); err != nil {
		return MessageRecord{}, err
	}
	record.ContentJSON = []byte(content)
	record.AuthorID = authorID
	record.ClientMessageID = clientID
	record.AuthorNickname = stringValuePtr(authorNickname)
	record.AuthorRemark = stringValuePtr(authorRemark)
	record.AuthorGitHubLogin = stringValuePtr(authorLogin)
	record.AuthorAvatarURL = stringValuePtr(avatarURL)
	record.ReplyToMessageID = replyID
	if pinBy != nil && pinAt != nil {
		record.Pin = &PinRecord{MessageID: record.ID, PinnedByUserID: *pinBy, CreatedAt: *pinAt, Message: record}
	}
	return record, nil
}

func scanMessageRecords(rows pgx.Rows) ([]MessageRecord, error) {
	items := make([]MessageRecord, 0)
	for rows.Next() {
		item, err := scanMessageRecord(rows)
		if err != nil {
			return nil, internalError("scan messages", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan messages", err)
	}
	return items, nil
}

func scanPinRecord(row rowScanner) (PinRecord, error) {
	var pin PinRecord
	var authorID, clientID, replyID, authorNickname, authorRemark, authorLogin, avatarURL *string
	var content string
	if err := row.Scan(&pin.MessageID, &pin.PinnedByUserID, &pin.CreatedAt, &pin.Message.ID, &pin.Message.ConversationID, &pin.Message.TopicID, &authorID, &pin.Message.AuthorName, &authorNickname, &authorRemark, &authorLogin, &avatarURL, &pin.Message.AuthorKind, &pin.Message.Kind, &clientID, &content, &pin.Message.PlainText, &replyID, &pin.Message.CreatedAt, &pin.Message.EditedAt, &pin.Message.DeletedAt, &pin.Message.RecalledAt, &pin.Message.RecallReason); err != nil {
		return PinRecord{}, err
	}
	pin.Message.ContentJSON = []byte(content)
	pin.Message.AuthorID = authorID
	pin.Message.ClientMessageID = clientID
	pin.Message.AuthorNickname = stringValuePtr(authorNickname)
	pin.Message.AuthorRemark = stringValuePtr(authorRemark)
	pin.Message.AuthorGitHubLogin = stringValuePtr(authorLogin)
	pin.Message.AuthorAvatarURL = stringValuePtr(avatarURL)
	pin.Message.ReplyToMessageID = replyID
	return pin, nil
}

func scanPinRecords(rows pgx.Rows) ([]PinRecord, error) {
	items := make([]PinRecord, 0)
	for rows.Next() {
		item, err := scanPinRecord(rows)
		if err != nil {
			return nil, internalError("scan message pins", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan message pins", err)
	}
	return items, nil
}

func boundedLimit(value, fallback, maximum int) int {
	if value <= 0 {
		return fallback
	}
	if value > maximum {
		return maximum
	}
	return value
}

func nullableStringArg(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func stringValuePtr(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func timePtr(value time.Time) *time.Time { return &value }

var _ Repository = (*PGRepository)(nil)
var _ Tx = (*pgTx)(nil)
