package messages

import (
	"bytes"
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

var _ AgentMessageEditTx = (*pgTx)(nil)

// UpdateAgentMessage performs the message row compare-and-swap and replaces
// all content relationships inside the caller's transaction. The service has
// already normalized and authorized every referenced object; this adapter
// keeps the final row lock and conditional write in PostgreSQL so a concurrent
// edit cannot silently overwrite an Agent's expected version.
func (t *pgTx) UpdateAgentMessage(ctx context.Context, input AgentMessageEditMutation) (bool, error) {
	if t == nil || t.tx == nil {
		return false, errors.New("workspace message transaction is required")
	}
	if input.SpaceID == "" || input.ConversationID == "" || input.MessageID == "" || input.ActorID == "" || input.ExpectedVersion == "" {
		return false, errors.New("agent message edit fields are required")
	}
	var (
		authorID              string
		currentContentJSON    string
		currentPlainText      string
		topicID, threadRootID *string
		deletedAt, recalledAt *time.Time
	)
	err := t.tx.QueryRow(ctx, `
		SELECT COALESCE(author_id, ''), content_json, plain_text,
		       topic_id, thread_root_id, deleted_at, recalled_at
		FROM messages
		WHERE space_id = $1 AND conversation_id = $2 AND id = $3
		FOR UPDATE
	`, input.SpaceID, input.ConversationID, input.MessageID).Scan(
		&authorID, &currentContentJSON, &currentPlainText,
		&topicID, &threadRootID, &deletedAt, &recalledAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if authorID != input.ActorID || topicID != nil || threadRootID != nil || deletedAt != nil || recalledAt != nil {
		return false, nil
	}
	currentContent := []byte(currentContentJSON)
	currentVersion := AgentMessageVersion(authorID, currentContent, currentPlainText)
	if !agentEditVersionEqual(input.ExpectedVersion, currentVersion) ||
		!bytes.Equal(currentContent, input.ExpectedContentJSON) || currentPlainText != input.ExpectedPlainText {
		return false, nil
	}
	result, err := t.tx.Exec(ctx, `
		UPDATE messages
		SET content_json = $1, plain_text = $2, edited_at = $3
		WHERE space_id = $4 AND conversation_id = $5 AND id = $6
		  AND author_id = $7 AND topic_id IS NULL AND thread_root_id IS NULL
		  AND deleted_at IS NULL AND recalled_at IS NULL
		  AND content_json = $8 AND plain_text = $9
	`, string(input.ContentJSON), input.PlainText, normalizeTimestamp(input.EditedAt),
		input.SpaceID, input.ConversationID, input.MessageID, input.ActorID,
		string(input.ExpectedContentJSON), input.ExpectedPlainText)
	if err != nil {
		return false, err
	}
	if result.RowsAffected() != 1 {
		return false, nil
	}
	if err := t.replaceAgentMessageRelations(ctx, input); err != nil {
		return false, err
	}
	return true, nil
}

func (t *pgTx) replaceAgentMessageRelations(ctx context.Context, input AgentMessageEditMutation) error {
	if _, err := t.tx.Exec(ctx, `DELETE FROM message_attachments WHERE message_id = $1`, input.MessageID); err != nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `DELETE FROM message_custom_emotes WHERE message_id = $1`, input.MessageID); err != nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `DELETE FROM message_emote_collection_shares WHERE message_id = $1`, input.MessageID); err != nil {
		return err
	}
	for _, attachmentID := range input.AttachmentIDs {
		if err := t.LinkMessageAttachment(ctx, input.SpaceID, input.MessageID, attachmentID); err != nil {
			return err
		}
	}
	for _, customEmoteID := range input.CustomEmoteIDs {
		if err := t.LinkMessageCustomEmote(ctx, input.MessageID, input.ActorID, customEmoteID); err != nil {
			return err
		}
	}
	for _, shareID := range input.EmoteCollectionShareIDs {
		if err := t.LinkMessageEmoteCollectionShare(ctx, input.MessageID, shareID); err != nil {
			return err
		}
	}
	return nil
}
