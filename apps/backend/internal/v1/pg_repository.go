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
			SELECT
				a.id,
				a.file_name,
				a.mime_type,
				a.byte_size,
				coalesce(direct_src.conversation_id, linked_msg.conversation_id, a.conversation_id, ''),
				coalesce(direct_src.id, linked_msg.message_id, ''),
				a.width,
				a.height,
				coalesce(a.thumb_hash, ''),
				a.created_at
			FROM attachments a
			LEFT JOIN messages direct_src
				ON a.source_message_id IS NOT NULL
				AND direct_src.id = a.source_message_id
				AND direct_src.space_id = a.space_id
				AND direct_src.topic_id IS NULL
				AND direct_src.deleted_at IS NULL
				AND direct_src.recalled_at IS NULL
				AND EXISTS (
					SELECT 1 FROM conversation_members dcm
					WHERE dcm.conversation_id = direct_src.conversation_id
					  AND dcm.user_id = $3
					  AND dcm.removed_at IS NULL
				)
			LEFT JOIN LATERAL (
				SELECT m.id AS message_id, m.conversation_id AS conversation_id
				FROM message_attachments ma
				INNER JOIN messages m ON m.id = ma.message_id
				INNER JOIN conversation_members mcm
					ON mcm.conversation_id = m.conversation_id
					AND mcm.user_id = $3
					AND mcm.removed_at IS NULL
				WHERE ma.attachment_id = a.id
				  AND m.space_id = a.space_id
				  AND m.topic_id IS NULL
				  AND m.deleted_at IS NULL
				  AND m.recalled_at IS NULL
				ORDER BY
					CASE WHEN a.conversation_id IS NOT NULL AND m.conversation_id = a.conversation_id THEN 0 ELSE 1 END,
					m.created_at DESC,
					m.id DESC
				LIMIT 1
			) linked_msg ON TRUE
			WHERE a.space_id = $1
			  AND a.status = 'available'
			  AND a.file_name ILIKE $2
			  AND (
				a.visibility = 'space'
				OR a.uploader_id = $3
				OR linked_msg.message_id IS NOT NULL
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
	err := r.pool.QueryRow(ctx, `
		SELECT c.id
		FROM conversations c
		WHERE c.space_id = $1
		  AND (
			c.direct_key = $2
			OR (
				c.type = 'saved'
				AND EXISTS (
					SELECT 1 FROM conversation_members cm
					WHERE cm.conversation_id = c.id AND cm.user_id = $3 AND cm.removed_at IS NULL
				)
			)
		  )
		ORDER BY CASE WHEN c.direct_key = $2 THEN 0 ELSE 1 END, c.created_at ASC
		LIMIT 1
	`, r.spaceID, directKey, actorID).Scan(&id)
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

func (r *PGRepository) resolveSpaceManager(ctx context.Context, actorID string) (string, string, error) {
	var role, githubLogin string
	err := r.pool.QueryRow(ctx, `
		SELECT sm.role, coalesce(u.github_login, '')
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		WHERE sm.space_id = $1 AND sm.user_id = $2 AND sm.removed_at IS NULL AND u.kind = 'human'
	`, r.spaceID, actorID).Scan(&role, &githubLogin)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", ErrForbidden
		}
		return "", "", err
	}
	if role != "owner" && role != "admin" {
		return "", "", ErrForbidden
	}
	return role, githubLogin, nil
}

func (r *PGRepository) GetAdminOverview(ctx context.Context, actorID string, now time.Time) (AdminOverviewResponse, error) {
	role, _, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return AdminOverviewResponse{}, err
	}

	var resp AdminOverviewResponse
	resp.ViewerRole = role
	resp.Storage.RecentOperatorRuns = []StorageOperatorRunSummary{}

	var spaceCreatedAt time.Time
	if err := r.pool.QueryRow(ctx, `
		SELECT id, name, slug, created_at FROM spaces WHERE id = $1
	`, r.spaceID).Scan(&resp.Space.ID, &resp.Space.Name, &resp.Space.Slug, &spaceCreatedAt); err != nil {
		return AdminOverviewResponse{}, err
	}
	resp.Space.CreatedAt = spaceCreatedAt.UTC().Format(time.RFC3339Nano)

	dayStart := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	if err := r.pool.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM space_members WHERE space_id = $1 AND removed_at IS NULL),
			(SELECT COUNT(*) FROM conversations WHERE space_id = $1),
			(SELECT COUNT(*) FROM messages WHERE space_id = $1 AND deleted_at IS NULL),
			(SELECT COUNT(*) FROM attachments WHERE space_id = $1 AND status = 'available'),
			(SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE space_id = $1 AND status = 'available'),
			(SELECT COUNT(*) FROM space_members WHERE space_id = $1 AND removed_at IS NULL AND joined_at >= $2),
			(SELECT COUNT(*) FROM conversations WHERE space_id = $1 AND created_at >= $2),
			(SELECT COUNT(*) FROM messages WHERE space_id = $1 AND deleted_at IS NULL AND created_at >= $2),
			(SELECT COUNT(*) FROM attachments WHERE space_id = $1 AND status = 'available' AND COALESCE(completed_at, created_at) >= $2),
			(SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE space_id = $1 AND status = 'available' AND COALESCE(completed_at, created_at) >= $2)
	`, r.spaceID, dayStart).Scan(
		&resp.Totals.Members, &resp.Totals.Conversations, &resp.Totals.Messages, &resp.Totals.Files, &resp.Totals.UploadedBytes,
		&resp.Today.Members, &resp.Today.Conversations, &resp.Today.Messages, &resp.Today.Files, &resp.Today.UploadedBytes,
	); err != nil {
		return AdminOverviewResponse{}, err
	}

	resp.Policy = AdminSpacePolicy{
		DailyQuotaBytes:       2 * 1024 * 1024 * 1024,
		MessageRetentionCount: 10000,
	}
	var policyUpdatedAt time.Time
	if err := r.pool.QueryRow(ctx, `
		SELECT daily_quota_bytes, message_retention_count, updated_at
		FROM space_policies
		WHERE space_id = $1
	`, r.spaceID).Scan(&resp.Policy.DailyQuotaBytes, &resp.Policy.MessageRetentionCount, &policyUpdatedAt); err == nil {
		resp.Policy.UpdatedAt = policyUpdatedAt.UTC().Format(time.RFC3339Nano)
	}

	_ = r.pool.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE status = 'available'),
			COALESCE(SUM(byte_size) FILTER (WHERE status = 'available'), 0),
			COUNT(*) FILTER (WHERE status = 'pending'),
			COALESCE(SUM(byte_size) FILTER (WHERE status = 'pending'), 0),
			COUNT(*) FILTER (WHERE status IN ('failed', 'removed')),
			COALESCE(SUM(byte_size) FILTER (WHERE status IN ('failed', 'removed')), 0)
		FROM attachments
		WHERE space_id = $1
	`, r.spaceID).Scan(
		&resp.Storage.ActiveAttachments,
		&resp.Storage.ActiveBytes,
		&resp.Storage.PendingUploads,
		&resp.Storage.PendingBytes,
		&resp.Storage.ReclaimableAttachments,
		&resp.Storage.ReclaimableBytes,
	)

	_ = r.pool.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(SUM(byte_size), 0)
		FROM workspace_storage_objects
		WHERE deleted_at IS NULL
	`).Scan(&resp.Storage.CASObjects, &resp.Storage.CASBytes)

	runRows, runErr := r.pool.Query(ctx, `
		SELECT id, operation, state, phase, total_items, processed_items, COALESCE(last_error_code, ''), started_at, COALESCE(completed_at, '')
		FROM workspace_storage_operator_runs
		ORDER BY started_at DESC
		LIMIT 5
	`)
	if runErr == nil {
		defer runRows.Close()
		for runRows.Next() {
			var run StorageOperatorRunSummary
			if err := runRows.Scan(&run.ID, &run.Operation, &run.State, &run.Phase, &run.TotalItems, &run.ProcessedItems, &run.LastErrorCode, &run.StartedAt, &run.CompletedAt); err == nil {
				resp.Storage.RecentOperatorRuns = append(resp.Storage.RecentOperatorRuns, run)
			}
		}
	}

	return resp, nil
}

func (r *PGRepository) ListAdminInvites(ctx context.Context, actorID string, now time.Time) (AdminInviteListResponse, error) {
	role, _, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return AdminInviteListResponse{}, err
	}

	viewAllRoles := role == "owner"
	resp := AdminInviteListResponse{
		Invites: []AdminInviteItem{},
	}

	rows, err := r.pool.Query(ctx, `
		SELECT i.id, i.code_preview, i.default_role, i.max_uses, i.uses, i.expires_at, i.revoked_at, i.created_at, COALESCE(u.display_name, u.github_login, '')
		FROM invites i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.space_id = $1 AND ($2 OR i.default_role = 'member')
		ORDER BY i.created_at DESC
		LIMIT 100
	`, r.spaceID, viewAllRoles)
	if err != nil {
		return AdminInviteListResponse{}, err
	}
	defer rows.Close()

	nowUTC := now.UTC()
	for rows.Next() {
		var item AdminInviteItem
		var expiresAt, revokedAt *time.Time
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.CodePreview, &item.DefaultRole, &item.MaxUses, &item.Uses, &expiresAt, &revokedAt, &createdAt, &item.CreatedByName); err != nil {
			return AdminInviteListResponse{}, err
		}
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		if expiresAt != nil {
			s := expiresAt.UTC().Format(time.RFC3339Nano)
			item.ExpiresAt = &s
		}
		if revokedAt != nil {
			s := revokedAt.UTC().Format(time.RFC3339Nano)
			item.RevokedAt = &s
		}

		switch {
		case revokedAt != nil:
			item.Status = "revoked"
		case expiresAt != nil && !expiresAt.UTC().After(nowUTC):
			item.Status = "expired"
		case item.Uses >= item.MaxUses:
			item.Status = "exhausted"
		default:
			item.Status = "active"
			resp.Active++
			resp.AvailableUses += item.MaxUses - item.Uses
		}
		resp.Total++
		resp.AcceptedUses += item.Uses
		resp.Invites = append(resp.Invites, item)
	}
	return resp, rows.Err()
}

func (r *PGRepository) ListAdminAuditLogs(ctx context.Context, actorID, resultFilter, query string, limit int) ([]AdminAuditLogItem, error) {
	if _, _, err := r.resolveSpaceManager(ctx, actorID); err != nil {
		return nil, err
	}

	like := "%" + query + "%"
	rows, err := r.pool.Query(ctx, `
		SELECT
			a.id,
			COALESCE(a.actor_user_id, ''),
			COALESCE(u.display_name, a.actor_github_login, '系统'),
			COALESCE(a.actor_github_login, ''),
			a.action,
			a.target_type,
			COALESCE(a.target_id, ''),
			a.result,
			COALESCE(a.reason, ''),
			COALESCE(a.ip_address, ''),
			COALESCE(a.request_id, ''),
			a.created_at
		FROM audit_logs a
		LEFT JOIN users u ON u.id = a.actor_user_id
		WHERE (a.space_id = $1 OR a.space_id IS NULL)
		  AND ($2 = '' OR a.result = $2)
		  AND (
			$3 = ''
			OR a.action ILIKE $4
			OR a.target_type ILIKE $4
			OR COALESCE(a.target_id, '') ILIKE $4
			OR COALESCE(a.actor_github_login, '') ILIKE $4
			OR COALESCE(u.display_name, '') ILIKE $4
			OR COALESCE(a.reason, '') ILIKE $4
			OR COALESCE(a.ip_address, '') ILIKE $4
		  )
		ORDER BY a.created_at DESC
		LIMIT $5
	`, r.spaceID, resultFilter, query, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]AdminAuditLogItem, 0)
	for rows.Next() {
		var item AdminAuditLogItem
		var createdAt time.Time
		if err := rows.Scan(
			&item.ID,
			&item.ActorUserID,
			&item.ActorDisplayName,
			&item.ActorGitHubLogin,
			&item.Action,
			&item.TargetType,
			&item.TargetID,
			&item.Result,
			&item.Reason,
			&item.IPAddress,
			&item.RequestID,
			&createdAt,
		); err != nil {
			return nil, err
		}
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *PGRepository) UpdateSpacePolicy(ctx context.Context, actorID string, input AdminPolicyUpdateInput, now time.Time) (AdminSpacePolicy, error) {
	role, githubLogin, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return AdminSpacePolicy{}, err
	}
	if role != "owner" {
		_, _ = r.pool.Exec(ctx, `
			INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, created_at)
			VALUES ($1, $2, $3, NULLIF($4, ''), 'space.policy_update', 'space', $2, 'rejected', 'owner required', $5)
		`, randomID("aud"), r.spaceID, actorID, githubLogin, now.UTC())
		return AdminSpacePolicy{}, ErrForbidden
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return AdminSpacePolicy{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if input.SpaceName != "" {
		if _, err := tx.Exec(ctx, `UPDATE spaces SET name = $2 WHERE id = $1`, r.spaceID, input.SpaceName); err != nil {
			return AdminSpacePolicy{}, err
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO space_policies (space_id, daily_quota_bytes, message_retention_count, updated_by, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (space_id) DO UPDATE
		SET daily_quota_bytes = EXCLUDED.daily_quota_bytes,
		    message_retention_count = EXCLUDED.message_retention_count,
		    updated_by = EXCLUDED.updated_by,
		    updated_at = EXCLUDED.updated_at
	`, r.spaceID, input.DailyQuotaBytes, input.MessageRetentionCount, actorID, now.UTC()); err != nil {
		return AdminSpacePolicy{}, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'space.policy_update', 'space', $2, 'success', $5, $6)
	`, randomID("aud"), r.spaceID, actorID, githubLogin, fmt.Sprintf("quota=%d retention=%d", input.DailyQuotaBytes, input.MessageRetentionCount), now.UTC()); err != nil {
		return AdminSpacePolicy{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return AdminSpacePolicy{}, err
	}

	return AdminSpacePolicy{
		DailyQuotaBytes:       input.DailyQuotaBytes,
		MessageRetentionCount: input.MessageRetentionCount,
		UpdatedAt:             now.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (r *PGRepository) CleanupStaleStorage(ctx context.Context, actorID string, now time.Time) (AdminStorageCleanupResult, error) {
	_, githubLogin, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return AdminStorageCleanupResult{}, err
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return AdminStorageCleanupResult{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	cutoff := now.UTC().Add(-15 * time.Minute)
	var result AdminStorageCleanupResult

	if err := tx.QueryRow(ctx, `
		WITH rel AS (
			UPDATE transfer_ledger
			SET status = 'released', released_at = $3
			WHERE space_id = $1 AND status = 'reserved' AND created_at < $2
			RETURNING byte_size
		)
		SELECT COUNT(*), COALESCE(SUM(byte_size), 0) FROM rel
	`, r.spaceID, cutoff, now.UTC()).Scan(&result.ReleasedTransfers, &result.ReclaimedBytes); err != nil {
		return AdminStorageCleanupResult{}, err
	}

	tag, err := tx.Exec(ctx, `
		UPDATE attachments
		SET status = 'failed'
		WHERE space_id = $1 AND status = 'pending' AND created_at < $2
	`, r.spaceID, cutoff)
	if err != nil {
		return AdminStorageCleanupResult{}, err
	}
	result.CleanedAttachments = tag.RowsAffected()

	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'storage.cleanup', 'workspace', $2, 'success', $5, $6)
	`, randomID("aud"), r.spaceID, actorID, githubLogin, fmt.Sprintf("transfers=%d attachments=%d", result.ReleasedTransfers, result.CleanedAttachments), now.UTC()); err != nil {
		return AdminStorageCleanupResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return AdminStorageCleanupResult{}, err
	}
	return result, nil
}
