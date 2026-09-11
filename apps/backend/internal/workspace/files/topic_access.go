package files

import "context"

// TopicAttachmentReader preserves private staging until a message publishes the
// logical attachment to its topic. Linked files never fall back to uploader
// ownership after topic or group membership has been revoked.
type TopicAttachmentReader interface {
	TopicAttachmentAccess(ctx context.Context, spaceID, attachmentID, viewerID string) (linked, visible bool, err error)
}

func (r *PGRepository) TopicAttachmentAccess(ctx context.Context, spaceID, attachmentID, viewerID string) (bool, bool, error) {
	return topicAttachmentAccess(ctx, r.pool, spaceID, attachmentID, viewerID)
}

func (t *pgTx) TopicAttachmentAccess(ctx context.Context, spaceID, attachmentID, viewerID string) (bool, bool, error) {
	return topicAttachmentAccess(ctx, t.tx, spaceID, attachmentID, viewerID)
}

func topicAttachmentAccess(ctx context.Context, queryer pgQueryer, spaceID, attachmentID, viewerID string) (bool, bool, error) {
	var linked, visible bool
	err := queryer.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM message_attachments ma JOIN messages m ON m.id = ma.message_id
			WHERE ma.attachment_id = $2 AND m.space_id = $1 AND m.topic_id IS NOT NULL),
		EXISTS (SELECT 1 FROM message_attachments ma
			JOIN messages m ON m.id = ma.message_id AND m.space_id = $1
			JOIN topics t ON t.id = m.topic_id AND t.space_id = m.space_id AND t.conversation_id = m.conversation_id
			JOIN conversations c ON c.id = t.conversation_id AND c.space_id = t.space_id AND c.type = 'group'
			JOIN topic_members tm ON tm.topic_id = t.id AND tm.user_id = $3 AND tm.left_at IS NULL
			JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3 AND cm.removed_at IS NULL
			JOIN space_members sm ON sm.space_id = t.space_id AND sm.user_id = $3 AND sm.removed_at IS NULL
			JOIN users u ON u.id = sm.user_id AND u.kind = 'human'
			WHERE ma.attachment_id = $2 AND m.deleted_at IS NULL AND m.recalled_at IS NULL
				AND sm.role IN ('owner', 'admin', 'member'))`, spaceID, attachmentID, viewerID).Scan(&linked, &visible)
	if err != nil {
		return false, false, internalError("check topic attachment access", err)
	}
	return linked, visible, nil
}
