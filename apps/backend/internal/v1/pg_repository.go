package v1

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PGRepository struct {
	pool    *pgxpool.Pool
	spaceID string
}

func NewPGRepository(pool *pgxpool.Pool, spaceID string) *PGRepository {
	if spaceID == "" {
		spaceID = "spc_default"
	}
	return &PGRepository{pool: pool, spaceID: spaceID}
}

func (r *PGRepository) SyncDelta(ctx context.Context, actorID string, sinceSeq int64, limit int) (SyncDeltaResponse, error) {
	var currentSeq int64
	err := r.pool.QueryRow(ctx, `SELECT coalesce(max(seq), 0) FROM workspace_events WHERE space_id = $1`, r.spaceID).Scan(&currentSeq)
	if err != nil {
		return SyncDeltaResponse{}, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT we.seq, we.type, coalesce(we.conversation_id, ''), we.payload_json, we.created_at
		FROM workspace_events we
		WHERE we.space_id = $1
		  AND we.seq > $2
		  AND (
			we.conversation_id IS NULL
			OR EXISTS (
				SELECT 1 FROM conversation_members cm
				WHERE cm.conversation_id = we.conversation_id AND cm.user_id = $3 AND cm.removed_at IS NULL
			)
		  )
		ORDER BY we.seq ASC
		LIMIT $4
	`, r.spaceID, sinceSeq, actorID, limit+1)
	if err != nil {
		return SyncDeltaResponse{}, err
	}
	defer rows.Close()

	events := make([]SyncEvent, 0)
	for rows.Next() {
		var seq int64
		var evType, convID, payloadRaw string
		var createdAt time.Time
		if err := rows.Scan(&seq, &evType, &convID, &payloadRaw, &createdAt); err != nil {
			return SyncDeltaResponse{}, err
		}
		payload := map[string]any{}
		_ = json.Unmarshal([]byte(payloadRaw), &payload)
		events = append(events, SyncEvent{
			Seq:            seq,
			Type:           evType,
			ConversationID: convID,
			Payload:        payload,
			CreatedAt:      createdAt.UTC().Format(time.RFC3339Nano),
		})
	}
	hasMore := false
	if len(events) > limit {
		hasMore = true
		events = events[:limit]
	}
	return SyncDeltaResponse{
		CurrentSeq:    currentSeq,
		HasMore:       hasMore,
		ResetRequired: sinceSeq > currentSeq,
		Events:        events,
	}, rows.Err()
}

func (r *PGRepository) Search(ctx context.Context, actorID, query, scope string, limit int) (SearchResponse, error) {
	resp := SearchResponse{
		Messages: []SearchMessageHit{},
		Files:    []SearchFileHit{},
	}
	likePattern := "%" + query + "%"

	if scope == "all" || scope == "messages" {
		rows, err := r.pool.Query(ctx, `
			SELECT m.id, m.conversation_id, coalesce(m.thread_root_id, ''), coalesce(m.author_id, ''), coalesce(u.display_name, ''), m.plain_text, m.created_at
			FROM messages m
			JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
			LEFT JOIN users u ON u.id = m.author_id
			WHERE m.space_id = $2
			  AND m.deleted_at IS NULL
			  AND (
				to_tsvector('simple', coalesce(m.plain_text, '')) @@ plainto_tsquery('simple', $3)
				OR m.plain_text ILIKE $4
			  )
			ORDER BY m.created_at DESC
			LIMIT $5
		`, actorID, r.spaceID, query, likePattern, limit)
		if err != nil {
			return SearchResponse{}, err
		}
		for rows.Next() {
			var hit SearchMessageHit
			var createdAt time.Time
			if err := rows.Scan(&hit.ID, &hit.ConversationID, &hit.ThreadRootID, &hit.AuthorID, &hit.AuthorName, &hit.PlainText, &createdAt); err != nil {
				rows.Close()
				return SearchResponse{}, err
			}
			hit.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
			resp.Messages = append(resp.Messages, hit)
		}
		rows.Close()
	}

	if scope == "all" || scope == "files" {
		rows, err := r.pool.Query(ctx, `
			SELECT a.id, a.file_name, a.mime_type, a.byte_size, coalesce(a.conversation_id, ''), coalesce(a.source_message_id, ''), a.width, a.height, coalesce(a.thumb_hash, ''), a.created_at
			FROM attachments a
			WHERE a.space_id = $1
			  AND a.status = 'available'
			  AND a.file_name ILIKE $2
			  AND (
				a.visibility = 'space'
				OR a.uploader_id = $3
				OR (a.conversation_id IS NOT NULL AND EXISTS (
					SELECT 1 FROM conversation_members cm
					WHERE cm.conversation_id = a.conversation_id AND cm.user_id = $3 AND cm.removed_at IS NULL
				))
			  )
			ORDER BY a.created_at DESC
			LIMIT $4
		`, r.spaceID, likePattern, actorID, limit)
		if err != nil {
			return SearchResponse{}, err
		}
		for rows.Next() {
			var hit SearchFileHit
			var createdAt time.Time
			if err := rows.Scan(&hit.ID, &hit.FileName, &hit.MIMEType, &hit.ByteSize, &hit.ConversationID, &hit.SourceMessageID, &hit.Width, &hit.Height, &hit.ThumbHash, &createdAt); err != nil {
				rows.Close()
				return SearchResponse{}, err
			}
			hit.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
			resp.Files = append(resp.Files, hit)
		}
		rows.Close()
	}

	return resp, nil
}

func (r *PGRepository) GetOrCreateSavedConversation(ctx context.Context, actorID string, now time.Time) (string, error) {
	directKey := "saved:" + actorID
	var id string
	err := r.pool.QueryRow(ctx, `SELECT id FROM conversations WHERE space_id = $1 AND direct_key = $2`, r.spaceID, directKey).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}

	id = randomID("conv")
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ($1, $2, 'saved', '个人空间', $3, $4, $5)
		ON CONFLICT (space_id, direct_key) DO NOTHING
	`, id, r.spaceID, directKey, actorID, now)
	if err != nil {
		return "", err
	}
	err = tx.QueryRow(ctx, `SELECT id FROM conversations WHERE space_id = $1 AND direct_key = $2`, r.spaceID, directKey).Scan(&id)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
		VALUES ($1, $2, 'owner', $3)
		ON CONFLICT (conversation_id, user_id) DO NOTHING
	`, id, actorID, now)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func (r *PGRepository) EditMessage(ctx context.Context, actorID, messageID, plainText string, now time.Time) error {
	contentJSON, _ := json.Marshal(map[string]any{
		"format":    "duallane.message+json;v=1",
		"plainText": plainText,
		"blocks":    []map[string]any{{"type": "text", "text": plainText}},
	})
	tag, err := r.pool.Exec(ctx, `
		UPDATE messages
		SET plain_text = $1, content_json = $2, edited_at = $3
		WHERE id = $4 AND author_id = $5 AND deleted_at IS NULL
	`, plainText, string(contentJSON), now, messageID, actorID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	return nil
}

func (r *PGRepository) ForwardMessages(ctx context.Context, actorID, targetConversationID string, messageIDs []string, now time.Time) ([]string, error) {
	var isMember bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL
		)
	`, targetConversationID, actorID).Scan(&isMember)
	if err != nil || !isMember {
		return nil, ErrForbidden
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	created := make([]string, 0, len(messageIDs))
	for _, srcID := range messageIDs {
		var plainText, contentJSON, origAuthor string
		err := tx.QueryRow(ctx, `
			SELECT m.plain_text, m.content_json, coalesce(u.display_name, '成员')
			FROM messages m
			JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
			LEFT JOIN users u ON u.id = m.author_id
			WHERE m.id = $2 AND m.deleted_at IS NULL
		`, actorID, srcID).Scan(&plainText, &contentJSON, &origAuthor)
		if err != nil {
			return nil, ErrNotFound
		}
		newID := randomID("msg")
		metaJSON, _ := json.Marshal(map[string]any{"sourceMessageId": srcID, "authorName": origAuthor})
		_, err = tx.Exec(ctx, `
			INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, content_format, content_json, plain_text, forwarded_from_json, created_at)
			VALUES ($1, $2, $3, $4, 'human', 'user', 'duallane.message+json;v=1', $5, $6, $7, $8)
		`, newID, r.spaceID, targetConversationID, actorID, contentJSON, plainText, string(metaJSON), now)
		if err != nil {
			return nil, err
		}
		if err := emitMessageCreatedEvent(ctx, tx, r.spaceID, actorID, targetConversationID, newID, now); err != nil {
			return nil, err
		}
		created = append(created, newID)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return created, nil
}

func emitMessageCreatedEvent(ctx context.Context, tx pgx.Tx, spaceID, actorID, conversationID, messageID string, now time.Time) error {
	var nextSeq int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, 2)
		ON CONFLICT (space_id) DO UPDATE
		SET next_seq = workspace_event_cursors.next_seq + 1
		RETURNING next_seq - 1
	`, spaceID).Scan(&nextSeq); err != nil {
		return err
	}
	payloadBytes, _ := json.Marshal(map[string]any{
		"conversationId": conversationID,
		"messageId":      messageID,
	})
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		)
		VALUES ($1, $2, $3, 'message.created', $4, $5, 'message', $6, $7, $8)
	`, randomID("evt"), spaceID, nextSeq, actorID, conversationID, messageID, string(payloadBytes), now.UTC()); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `SELECT pg_notify('duallane_workspace_events', '')`)
	return err
}

func (r *PGRepository) GetThread(ctx context.Context, actorID, rootMessageID string) (ThreadView, error) {
	var convID, threadTitle string
	err := r.pool.QueryRow(ctx, `
		SELECT m.conversation_id, coalesce(m.thread_title, '')
		FROM messages m
		JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
		WHERE m.id = $2 AND m.deleted_at IS NULL
	`, actorID, rootMessageID).Scan(&convID, &threadTitle)
	if err != nil {
		return ThreadView{}, ErrNotFound
	}

	rows, err := r.pool.Query(ctx, `
		SELECT m.id, m.conversation_id, m.thread_root_id, m.also_send_to_channel, coalesce(m.author_id, ''), coalesce(u.display_name, '成员'), m.plain_text, m.edited_at, m.created_at
		FROM messages m
		LEFT JOIN users u ON u.id = m.author_id
		WHERE m.thread_root_id = $1 AND m.deleted_at IS NULL
		ORDER BY m.created_at ASC
	`, rootMessageID)
	if err != nil {
		return ThreadView{}, err
	}
	defer rows.Close()

	replies := make([]ThreadReply, 0)
	for rows.Next() {
		var item ThreadReply
		var editedAt *time.Time
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.ConversationID, &item.ThreadRootID, &item.AlsoSendToChannel, &item.AuthorID, &item.AuthorName, &item.PlainText, &editedAt, &createdAt); err != nil {
			return ThreadView{}, err
		}
		if editedAt != nil {
			item.EditedAt = editedAt.UTC().Format(time.RFC3339Nano)
		}
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		replies = append(replies, item)
	}
	return ThreadView{
		RootMessageID: rootMessageID,
		ThreadTitle:   threadTitle,
		ReplyCount:    len(replies),
		Replies:       replies,
	}, rows.Err()
}

func (r *PGRepository) ReplyThread(ctx context.Context, actorID, rootMessageID, plainText, threadTitle string, alsoSendToChannel bool, now time.Time) (ThreadReply, error) {
	var convID string
	err := r.pool.QueryRow(ctx, `
		SELECT m.conversation_id
		FROM messages m
		JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
		WHERE m.id = $2 AND m.deleted_at IS NULL
	`, actorID, rootMessageID).Scan(&convID)
	if err != nil {
		return ThreadReply{}, ErrNotFound
	}

	if threadTitle != "" {
		_, _ = r.pool.Exec(ctx, `UPDATE messages SET thread_title = $1 WHERE id = $2 AND thread_title IS NULL`, threadTitle, rootMessageID)
	}

	msgID := randomID("msg")
	contentJSON, _ := json.Marshal(map[string]any{
		"format":    "duallane.message+json;v=1",
		"plainText": plainText,
		"blocks":    []map[string]any{{"type": "text", "text": plainText}},
	})
	_, err = r.pool.Exec(ctx, `
		INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, content_format, content_json, plain_text, thread_root_id, also_send_to_channel, created_at)
		VALUES ($1, $2, $3, $4, 'human', 'user', 'duallane.message+json;v=1', $5, $6, $7, $8, $9)
	`, msgID, r.spaceID, convID, actorID, string(contentJSON), plainText, rootMessageID, alsoSendToChannel, now)
	if err != nil {
		return ThreadReply{}, err
	}

	return ThreadReply{
		ID:                msgID,
		ConversationID:    convID,
		ThreadRootID:      rootMessageID,
		AlsoSendToChannel: alsoSendToChannel,
		AuthorID:          actorID,
		PlainText:         plainText,
		CreatedAt:         now.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (r *PGRepository) PinMessage(ctx context.Context, actorID, conversationID, messageID string, now time.Time) error {
	var isMember bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL
		)
	`, conversationID, actorID).Scan(&isMember)
	if err != nil || !isMember {
		return ErrForbidden
	}

	_, err = r.pool.Exec(ctx, `
		INSERT INTO conversation_pinned_messages (conversation_id, message_id, pinned_by_user_id, created_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (conversation_id, message_id) DO NOTHING
	`, conversationID, messageID, actorID, now)
	return err
}

func (r *PGRepository) UnpinMessage(ctx context.Context, actorID, conversationID, messageID string) error {
	var isMember bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL
		)
	`, conversationID, actorID).Scan(&isMember)
	if err != nil || !isMember {
		return ErrForbidden
	}
	_, err = r.pool.Exec(ctx, `DELETE FROM conversation_pinned_messages WHERE conversation_id = $1 AND message_id = $2`, conversationID, messageID)
	return err
}

func (r *PGRepository) ListDevices(ctx context.Context, actorID, currentDeviceID string) ([]UserDevice, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, platform, device_name, app_version, last_active_at
		FROM user_devices
		WHERE user_id = $1 AND revoked_at IS NULL
		ORDER BY last_active_at DESC
	`, actorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	devices := make([]UserDevice, 0)
	for rows.Next() {
		var d UserDevice
		var lastActive time.Time
		if err := rows.Scan(&d.ID, &d.Platform, &d.DeviceName, &d.AppVersion, &lastActive); err != nil {
			return nil, err
		}
		d.LastActiveAt = lastActive.UTC().Format(time.RFC3339Nano)
		d.Current = d.ID == currentDeviceID
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

func (r *PGRepository) RevokeDevice(ctx context.Context, actorID, deviceID string, now time.Time) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE user_devices SET revoked_at = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL
	`, now, deviceID, actorID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *PGRepository) CreateQRSession(ctx context.Context, platform, deviceName string, now time.Time) (QRLoginSession, error) {
	id := randomID("qr")
	challenge := randomID("chl")
	expiresAt := now.Add(5 * time.Minute)
	_, err := r.pool.Exec(ctx, `
		INSERT INTO qr_login_sessions (id, challenge, status, platform, device_name, expires_at, created_at)
		VALUES ($1, $2, 'pending', $3, $4, $5, $6)
	`, id, challenge, platform, deviceName, expiresAt, now)
	if err != nil {
		return QRLoginSession{}, err
	}
	return QRLoginSession{
		ID:         id,
		Challenge:  challenge,
		Status:     "pending",
		Platform:   platform,
		DeviceName: deviceName,
		ExpiresAt:  expiresAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (r *PGRepository) ApproveQRSession(ctx context.Context, actorID, sessionID string, now time.Time) (QRLoginSession, error) {
	var item QRLoginSession
	var expiresAt time.Time
	err := r.pool.QueryRow(ctx, `
		UPDATE qr_login_sessions
		SET status = 'approved', user_id = $1, approved_at = $2
		WHERE id = $3 AND status = 'pending' AND expires_at > $2
		RETURNING id, challenge, status, coalesce(platform, ''), coalesce(device_name, ''), expires_at
	`, actorID, now, sessionID).Scan(&item.ID, &item.Challenge, &item.Status, &item.Platform, &item.DeviceName, &expiresAt)
	if err != nil {
		return QRLoginSession{}, ErrNotFound
	}
	item.ExpiresAt = expiresAt.UTC().Format(time.RFC3339Nano)
	return item, nil
}

func (r *PGRepository) ExchangeQRSession(ctx context.Context, sessionID, challenge string, now time.Time) (string, error) {
	var userID, platform, deviceName string
	err := r.pool.QueryRow(ctx, `
		UPDATE qr_login_sessions
		SET status = 'exchanged', consumed_at = $1
		WHERE id = $2 AND challenge = $3 AND status = 'approved' AND expires_at > $1
		RETURNING user_id, coalesce(platform, 'android'), coalesce(device_name, 'DualLane Mobile')
	`, now, sessionID, challenge).Scan(&userID, &platform, &deviceName)
	if err != nil {
		return "", ErrForbidden
	}

	rawToken := randomID("dlm") + "_" + randomID("sec")
	sum := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(sum[:])
	deviceID := randomID("dev")
	_, err = r.pool.Exec(ctx, `
		INSERT INTO user_devices (id, user_id, platform, device_name, token_hash, last_active_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $6)
	`, deviceID, userID, platform, deviceName, tokenHash, now)
	if err != nil {
		return "", err
	}
	return rawToken, nil
}

func (r *PGRepository) GetPreferences(ctx context.Context, actorID string) (map[string]any, error) {
	var raw string
	err := r.pool.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = $1`, actorID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	_ = json.Unmarshal([]byte(raw), &out)
	return out, nil
}

func (r *PGRepository) SavePreferences(ctx context.Context, actorID string, prefs map[string]any, now time.Time) error {
	encoded, err := json.Marshal(prefs)
	if err != nil {
		return err
	}
	_, err = r.pool.Exec(ctx, `
		INSERT INTO user_preferences (user_id, prefs_json, updated_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = EXCLUDED.updated_at
	`, actorID, string(encoded), now)
	return err
}

func (r *PGRepository) RegisterBotCommands(ctx context.Context, actorID, botID string, commands []BotCommand, now time.Time) error {
	var ownerID string
	err := r.pool.QueryRow(ctx, `SELECT owner_user_id FROM workspace_agent_bots WHERE id = $1 AND status <> 'deleted'`, botID).Scan(&ownerID)
	if err != nil || ownerID != actorID {
		return ErrForbidden
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `DELETE FROM bot_commands WHERE bot_id = $1`, botID)
	if err != nil {
		return err
	}
	for _, c := range commands {
		_, err = tx.Exec(ctx, `
			INSERT INTO bot_commands (id, bot_id, command, description, scope, created_at)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, randomID("bcmd"), botID, c.Command, strings.TrimSpace(c.Description), c.Scope, now)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *PGRepository) ListBotCommands(ctx context.Context, conversationID string) ([]BotCommand, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT bc.command, bc.description, bc.scope
		FROM bot_commands bc
		JOIN workspace_agent_bots b ON b.id = bc.bot_id AND b.status = 'active'
		JOIN conversation_members cm ON cm.user_id = b.bot_user_id AND cm.conversation_id = $1 AND cm.removed_at IS NULL
		ORDER BY bc.command ASC
	`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]BotCommand, 0)
	for rows.Next() {
		var item BotCommand
		if err := rows.Scan(&item.Command, &item.Description, &item.Scope); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *PGRepository) ListBotCommandsByBot(ctx context.Context, actorID, botID string) ([]BotCommand, error) {
	var ownerID string
	err := r.pool.QueryRow(ctx, `SELECT owner_user_id FROM workspace_agent_bots WHERE id = $1 AND status <> 'deleted'`, botID).Scan(&ownerID)
	if err != nil || ownerID != actorID {
		return nil, ErrForbidden
	}
	rows, err := r.pool.Query(ctx, `
		SELECT command, description, scope
		FROM bot_commands
		WHERE bot_id = $1
		ORDER BY command ASC
	`, botID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]BotCommand, 0)
	for rows.Next() {
		var item BotCommand
		if err := rows.Scan(&item.Command, &item.Description, &item.Scope); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *PGRepository) CreateMultiBot(ctx context.Context, actorID, name string, now time.Time) (string, error) {
	var count int
	if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_agent_bots WHERE space_id = $1 AND owner_user_id = $2 AND status <> 'deleted'`, r.spaceID, actorID).Scan(&count); err != nil {
		return "", err
	}
	if count >= 20 {
		return "", ErrRateLimited
	}
	botID := randomID("bot")
	botUserID := randomID("usr_bot")
	norm := strings.ToLower(strings.TrimSpace(name))
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, github_id, github_login, display_name, kind, created_at)
		VALUES ($1, NULL, $2, $3, 'bot', $4)
	`, botUserID, "__duallane_"+botID, strings.TrimSpace(name), now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at)
		VALUES ($1, $2, 'member', $3)
		ON CONFLICT (space_id, user_id) DO NOTHING
	`, r.spaceID, botUserID, now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_agent_bots (id, space_id, owner_user_id, bot_user_id, mode, name, name_normalized, visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, 'external_agent', $5, $6, 'private', 'group-capable', 'mention-or-command', 'active', $7, $7)
	`, botID, r.spaceID, actorID, botUserID, strings.TrimSpace(name), norm, now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_settings (bot_id, space_id, visibility_policy, allow_direct, allow_group, group_inviter_policy, require_owner_approval, proactive_enabled, trigger_policy, created_at, updated_at)
		VALUES ($1, $2, 'private', 1, 1, 'owner', 1, 0, 'mention-or-command', $3, $3)
	`, botID, r.spaceID, now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_limits (bot_id, space_id, created_at, updated_at)
		VALUES ($1, $2, $3, $3)
	`, botID, r.spaceID, now); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return botID, nil
}

func (r *PGRepository) UpsertBotWebhook(ctx context.Context, actorID, botID, url, secret string, enabled bool, now time.Time) (BotWebhookConfig, error) {
	var ownerID string
	err := r.pool.QueryRow(ctx, `SELECT owner_user_id FROM workspace_agent_bots WHERE id = $1 AND status <> 'deleted'`, botID).Scan(&ownerID)
	if err != nil || ownerID != actorID {
		return BotWebhookConfig{}, ErrForbidden
	}

	sum := sha256.Sum256([]byte(secret))
	secretHash := hex.EncodeToString(sum[:])
	_, err = r.pool.Exec(ctx, `
		INSERT INTO bot_webhooks (bot_id, url, secret_hash, enabled, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (bot_id) DO UPDATE SET url = EXCLUDED.url, secret_hash = EXCLUDED.secret_hash, enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at
	`, botID, url, secretHash, enabled, now)
	if err != nil {
		return BotWebhookConfig{}, fmt.Errorf("upsert bot webhook: %w", err)
	}
	return BotWebhookConfig{BotID: botID, URL: url, Enabled: enabled}, nil
}
