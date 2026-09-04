package events

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// PGRepository is the durable event reader. It deliberately has no in-memory
// subscription registry: a notification may wake a caller, but PostgreSQL's
// workspace_events rows and sequence remain the source of truth.
type PGRepository struct {
	pool *pgxpool.Pool
}

func NewPGRepository(pool *pgxpool.Pool) *PGRepository {
	return &PGRepository{pool: pool}
}

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return internalError("ping workspace event database", errors.New("workspace postgres pool is required"))
	}
	if err := r.pool.Ping(ctx); err != nil {
		return internalError("ping workspace event database", err)
	}
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup workspace event actor", errors.New("workspace postgres pool is required"))
	}
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	var joinedAt time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT
			u.id, u.github_id, u.github_login, u.email, u.display_name,
			u.nickname, u.avatar_url, u.search_discoverable, u.kind,
			sm.role, sm.joined_at
		FROM users u
		INNER JOIN space_members sm
			ON sm.user_id = u.id
			AND sm.space_id = $2
			AND sm.removed_at IS NULL
		WHERE u.id = $1
	`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName,
		&nickname, &avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &joinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("lookup workspace event actor", err)
	}
	actor.GitHubID = optionalString(githubID)
	actor.Email = optionalString(email)
	actor.Nickname = optionalString(nickname)
	actor.AvatarURL = optionalString(avatarURL)
	actor.JoinedAt = joinedAt.UTC()
	return &actor, nil
}

func (r *PGRepository) CurrentSeq(ctx context.Context, spaceID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("read workspace event cursor", errors.New("workspace postgres pool is required"))
	}
	var sequence int64
	if err := r.pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(seq), 0) FROM workspace_events WHERE space_id = $1
	`, spaceID).Scan(&sequence); err != nil {
		return 0, internalError("read workspace event cursor", err)
	}
	return sequence, nil
}

func (r *PGRepository) EarliestSeq(ctx context.Context, spaceID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("read workspace event window", errors.New("workspace postgres pool is required"))
	}
	var sequence int64
	if err := r.pool.QueryRow(ctx, `
		SELECT COALESCE(MIN(seq), 0) FROM workspace_events WHERE space_id = $1
	`, spaceID).Scan(&sequence); err != nil {
		return 0, internalError("read workspace event window", err)
	}
	return sequence, nil
}

func (r *PGRepository) ListEventsAfter(ctx context.Context, spaceID string, afterSeq int64, limit int) ([]EventRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace events", errors.New("workspace postgres pool is required"))
	}
	if afterSeq < 0 {
		afterSeq = 0
	}
	limit = boundedLimit(limit, DefaultBatchSize, MaxBatchSize)
	rows, err := r.pool.Query(ctx, `
		SELECT
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		FROM workspace_events
		WHERE space_id = $1 AND seq > $2
		ORDER BY seq ASC
		LIMIT $3
	`, spaceID, afterSeq, limit)
	if err != nil {
		return nil, internalError("list workspace events", err)
	}
	defer rows.Close()
	items := make([]EventRecord, 0, limit)
	for rows.Next() {
		var item EventRecord
		var actorID, conversationID, targetType, targetID *string
		var payload string
		if err := rows.Scan(&item.ID, &item.SpaceID, &item.Seq, &item.Type, &actorID, &conversationID,
			&targetType, &targetID, &payload, &item.CreatedAt); err != nil {
			return nil, internalError("scan workspace events", err)
		}
		item.ActorID = actorID
		item.ConversationID = conversationID
		item.TargetType = targetType
		item.TargetID = targetID
		item.PayloadJSON = []byte(payload)
		item.CreatedAt = item.CreatedAt.UTC()
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("list workspace events", err)
	}
	return items, nil
}

func (r *PGRepository) GetEvent(ctx context.Context, spaceID, eventID string) (*EventRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace event", errors.New("workspace postgres pool is required"))
	}
	var item EventRecord
	var actorID, conversationID, targetType, targetID *string
	var payload string
	err := r.pool.QueryRow(ctx, `
		SELECT
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		FROM workspace_events
		WHERE space_id = $1 AND id = $2
	`, spaceID, strings.TrimSpace(eventID)).Scan(&item.ID, &item.SpaceID, &item.Seq, &item.Type, &actorID, &conversationID,
		&targetType, &targetID, &payload, &item.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("read workspace event", err)
	}
	item.ActorID = actorID
	item.ConversationID = conversationID
	item.TargetType = targetType
	item.TargetID = targetID
	item.PayloadJSON = []byte(payload)
	item.CreatedAt = item.CreatedAt.UTC()
	return &item, nil
}

func (r *PGRepository) EventVisible(ctx context.Context, actor *auth.Actor, event EventRecord, payload map[string]any) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check workspace event visibility", errors.New("workspace postgres pool is required"))
	}
	if actor == nil || strings.TrimSpace(actor.ID) == "" || strings.TrimSpace(event.SpaceID) == "" {
		return false, nil
	}

	// Topic rows are the authoritative visibility boundary for topic events and
	// topic-backed message projections. Check this before generic conversation
	// visibility so a conversation member who left a topic cannot replay it.
	if topicID := stringField(payload, "topicId"); topicID != "" {
		var topicSpaceID, conversationID string
		err := r.pool.QueryRow(ctx, `
			SELECT space_id, conversation_id FROM topics WHERE id = $1
		`, topicID).Scan(&topicSpaceID, &conversationID)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, internalError("check workspace topic visibility", err)
		}
		if topicSpaceID != event.SpaceID {
			return false, nil
		}
		member, err := r.conversationMemberActive(ctx, event.SpaceID, conversationID, actor.ID)
		if err != nil || !member || actor.Role == "auditor" {
			return false, err
		}
		if strings.HasPrefix(event.Type, "topic.message.") || (event.Type == "message.created" && payload["topicCard"] != true) {
			var joined bool
			err := r.pool.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1 FROM topic_members
					WHERE topic_id = $1 AND user_id = $2 AND left_at IS NULL
				)
			`, topicID, actor.ID).Scan(&joined)
			if err != nil {
				return false, internalError("check topic member visibility", err)
			}
			return joined, nil
		}
		return true, nil
	}

	if event.Type == "card.created" || event.Type == "card.updated" || event.Type == "card.invalidated" {
		cardID := stringField(payload, "cardId")
		if cardID == "" {
			cardID = pointerString(event.TargetID)
		}
		if cardID == "" {
			return false, nil
		}
		var cardSpaceID, visibilityScope string
		var conversationID *string
		err := r.pool.QueryRow(ctx, `
			SELECT space_id, conversation_id, visibility_scope
			FROM workspace_cards WHERE id = $1
		`, cardID).Scan(&cardSpaceID, &conversationID, &visibilityScope)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, internalError("check workspace card visibility", err)
		}
		if cardSpaceID != event.SpaceID {
			return false, nil
		}
		switch visibilityScope {
		case "space":
			return actor.Role != "auditor", nil
		case "conversation":
			if conversationID == nil || *conversationID == "" {
				return false, nil
			}
			return r.conversationMemberActive(ctx, event.SpaceID, *conversationID, actor.ID)
		default:
			return false, nil
		}
	}

	if event.Type == "transfer.rejected" {
		return pointerString(event.ActorID) == actor.ID, nil
	}
	if event.Type == "workspace.member_visibility_updated" {
		return actor.Role == "owner" || pointerString(event.TargetID) == actor.ID, nil
	}
	if (event.Type == "workspace.member_joined" || event.Type == "workspace.member_updated") &&
		pointerString(event.TargetType) == "user" && pointerString(event.TargetID) != "" {
		return r.memberVisible(ctx, event.SpaceID, actor, pointerString(event.TargetID))
	}
	if event.Type == "workspace.member_removed" && pointerString(event.TargetType) == "user" && pointerString(event.TargetID) != "" {
		targetID := pointerString(event.TargetID)
		if actor.Role == "owner" || targetID == actor.ID {
			return true, nil
		}
		return r.removedMemberVisible(ctx, event.SpaceID, actor.ID, targetID)
	}
	if event.Type == "conversation.notification_updated" || event.Type == "emote.library.updated" {
		return pointerString(event.TargetType) == "user" && pointerString(event.TargetID) == actor.ID, nil
	}
	if pointerString(event.TargetType) == "attachment" && pointerString(event.TargetID) != "" {
		return r.attachmentVisible(ctx, actor, event)
	}
	if event.Type == "conversation.member_removed" && pointerString(event.TargetType) == "user" && pointerString(event.TargetID) == actor.ID {
		return true, nil
	}
	if event.ConversationID == nil || *event.ConversationID == "" {
		return actor.Role != "auditor", nil
	}
	if !conversationReadAllowed(actor.Role) {
		return false, nil
	}
	return r.conversationMemberActive(ctx, event.SpaceID, *event.ConversationID, actor.ID)
}

func (r *PGRepository) memberVisible(ctx context.Context, spaceID string, actor *auth.Actor, visibleUserID string) (bool, error) {
	var visible bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM space_members viewer_sm
			WHERE viewer_sm.space_id = $1 AND viewer_sm.user_id = $2
			  AND viewer_sm.removed_at IS NULL AND viewer_sm.role = 'owner'
		) OR EXISTS (
			SELECT 1
			FROM users target_u
			INNER JOIN space_members target_sm
				ON target_sm.user_id = target_u.id
				AND target_sm.space_id = $1
				AND target_sm.removed_at IS NULL
			WHERE target_u.id = $3
			  AND (
					$2 = $3
					OR EXISTS (
						SELECT 1 FROM member_visibility_grants g
						WHERE g.space_id = $1 AND g.viewer_user_id = $2 AND g.visible_user_id = $3
					)
					OR EXISTS (
						SELECT 1
						FROM conversations c
						INNER JOIN conversation_members viewer_cm
							ON viewer_cm.conversation_id = c.id
							AND viewer_cm.user_id = $2 AND viewer_cm.removed_at IS NULL
						INNER JOIN conversation_members target_cm
							ON target_cm.conversation_id = c.id
							AND target_cm.user_id = $3 AND target_cm.removed_at IS NULL
						WHERE c.space_id = $1 AND c.type = 'direct'
					)
					OR $3 = ANY($4::text[])
				)
		)
	`, spaceID, actor.ID, visibleUserID, []string{"usr_system_beacon", "usr_system_echo"}).Scan(&visible)
	if err != nil {
		return false, internalError("check member event visibility", err)
	}
	return visible, nil
}

func (r *PGRepository) removedMemberVisible(ctx context.Context, spaceID, viewerID, targetID string) (bool, error) {
	var visible bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversations c
			INNER JOIN conversation_members viewer_cm
				ON viewer_cm.conversation_id = c.id AND viewer_cm.user_id = $1
			INNER JOIN conversation_members visible_cm
				ON visible_cm.conversation_id = c.id AND visible_cm.user_id = $2
			WHERE c.space_id = $3 AND c.type = 'direct'
		) OR EXISTS (
			SELECT 1 FROM member_visibility_grants
			WHERE space_id = $3 AND viewer_user_id = $1 AND visible_user_id = $2
		)
	`, viewerID, targetID, spaceID).Scan(&visible)
	if err != nil {
		return false, internalError("check removed member event visibility", err)
	}
	return visible, nil
}

func (r *PGRepository) attachmentVisible(ctx context.Context, actor *auth.Actor, event EventRecord) (bool, error) {
	var spaceID, uploaderID, visibility string
	var conversationID *string
	err := r.pool.QueryRow(ctx, `
		SELECT space_id, uploader_id, conversation_id, visibility
		FROM attachments WHERE id = $1
	`, pointerString(event.TargetID)).Scan(&spaceID, &uploaderID, &conversationID, &visibility)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, internalError("check attachment event visibility", err)
	}
	if spaceID != event.SpaceID {
		return false, nil
	}
	if uploaderID == actor.ID || visibility == "private_staging" {
		return uploaderID == actor.ID, nil
	}
	participantOnly := false
	if visibility == "conversation" && conversationID != nil && *conversationID != "" {
		participantOnly, err = r.participantOnlyConversation(ctx, event.SpaceID, *conversationID)
		if err != nil {
			return false, err
		}
	}
	if participantOnly {
		return r.conversationMemberActive(ctx, event.SpaceID, *conversationID, actor.ID)
	}
	if event.Type == "attachment.created" || event.Type == "attachment.failed" {
		return actor.Role == "owner" || actor.Role == "admin", nil
	}
	if visibility == "space" {
		return actor.Role != "auditor", nil
	}
	if visibility == "conversation" && conversationID != nil && *conversationID != "" {
		if actor.Role == "owner" || actor.Role == "admin" {
			return true, nil
		}
		if !conversationReadAllowed(actor.Role) {
			return false, nil
		}
		return r.conversationMemberActive(ctx, event.SpaceID, *conversationID, actor.ID)
	}
	return false, nil
}

func (r *PGRepository) participantOnlyConversation(ctx context.Context, spaceID, conversationID string) (bool, error) {
	var participantOnly bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversations c
			INNER JOIN conversation_members cm ON cm.conversation_id = c.id
			WHERE c.id = $1 AND c.space_id = $2 AND c.type = 'direct'
			  AND cm.user_id = ANY($3::text[])
		)
	`, conversationID, spaceID, []string{"usr_system_beacon", "usr_system_echo"}).Scan(&participantOnly)
	if err != nil {
		return false, internalError("check participant-only conversation", err)
	}
	return participantOnly, nil
}

func (r *PGRepository) conversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	var active bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members cm
			INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
			WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
		)
	`, spaceID, conversationID, userID).Scan(&active)
	if err != nil {
		return false, internalError("check conversation event visibility", err)
	}
	return active, nil
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

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func pointerString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func conversationReadAllowed(role string) bool {
	return role == "owner" || role == "admin" || role == "member"
}
