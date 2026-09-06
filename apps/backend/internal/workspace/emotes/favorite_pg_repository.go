package emotes

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

var _ FavoriteSourceRepository = (*PGRepository)(nil)

func (r *PGRepository) GetVisibleFavoriteMessage(ctx context.Context, spaceID, actorID, messageID string) (*FavoriteMessageRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read favorite message", errors.New("workspace postgres pool is required"))
	}
	return getVisibleFavoriteMessage(ctx, r.pool, spaceID, actorID, messageID)
}

func getVisibleFavoriteMessage(ctx context.Context, queryer pgQueryer, spaceID, actorID, messageID string) (*FavoriteMessageRecord, error) {
	var record FavoriteMessageRecord
	err := queryer.QueryRow(ctx, `
		SELECT m.id, m.space_id, m.content_json
		FROM messages m
		INNER JOIN conversation_members cm
			ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
		WHERE m.space_id = $1 AND m.id = $3
		  AND m.deleted_at IS NULL AND cm.removed_at IS NULL
	`, spaceID, actorID, strings.TrimSpace(messageID)).Scan(&record.ID, &record.SpaceID, &record.ContentJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (r *PGRepository) GetFavoriteMessageAttachment(ctx context.Context, spaceID, messageID, attachmentID string) (*FavoriteAttachmentRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read favorite attachment", errors.New("workspace postgres pool is required"))
	}
	return getFavoriteMessageAttachment(ctx, r.pool, spaceID, messageID, attachmentID)
}

func getFavoriteMessageAttachment(ctx context.Context, queryer pgQueryer, spaceID, messageID, attachmentID string) (*FavoriteAttachmentRecord, error) {
	var record FavoriteAttachmentRecord
	err := queryer.QueryRow(ctx, `
		SELECT a.id, a.space_id, a.status, a.file_name, a.mime_type, a.byte_size
		FROM message_attachments ma
		INNER JOIN attachments a ON a.id = ma.attachment_id
		WHERE a.space_id = $1 AND ma.message_id = $2 AND ma.attachment_id = $3
		  AND a.status = 'available'
	`, spaceID, strings.TrimSpace(messageID), strings.TrimSpace(attachmentID)).Scan(
		&record.ID, &record.SpaceID, &record.Status, &record.FileName, &record.MIMEType, &record.ByteSize,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (t *pgTx) GetVisibleFavoriteMessage(ctx context.Context, spaceID, actorID, messageID string) (*FavoriteMessageRecord, error) {
	return getVisibleFavoriteMessage(ctx, t.tx, spaceID, actorID, messageID)
}

func (t *pgTx) GetFavoriteMessageAttachment(ctx context.Context, spaceID, messageID, attachmentID string) (*FavoriteAttachmentRecord, error) {
	return getFavoriteMessageAttachment(ctx, t.tx, spaceID, messageID, attachmentID)
}
