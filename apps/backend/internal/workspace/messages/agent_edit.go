package messages

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// AgentEditInput is the complete replacement contract for an Agent Bot edit.
// PlainText is derived from Content.Blocks by the message domain; callers
// cannot use it to bypass block validation or relationship checks.
type AgentEditInput struct {
	ActorID         string
	ConversationID  string
	MessageID       string
	ExpectedVersion string
	Content         Content
	ReplaceContent  bool
	Meta            auth.RequestMeta
}

// AgentMessageEditMutation is the normalized, transaction-ready form of an
// Agent Bot edit. The optional transaction writer owns the conditional row
// update and relationship replacement so the caller's outer task/idempotency
// transaction remains the only commit boundary.
type AgentMessageEditMutation struct {
	SpaceID                 string
	ConversationID          string
	MessageID               string
	ActorID                 string
	ExpectedVersion         string
	ExpectedContentJSON     []byte
	ExpectedPlainText       string
	ContentJSON             []byte
	PlainText               string
	AttachmentIDs           []string
	CustomEmoteIDs          []string
	EmoteCollectionShareIDs []string
	EditedAt                time.Time
}

// AgentMessageEditTx is intentionally optional. Existing message Tx fakes and
// non-Agent writers do not gain an unrelated mutation method; only a trusted
// transaction adapter that can perform the conditional replacement implements
// this interface.
type AgentMessageEditTx interface {
	UpdateAgentMessage(context.Context, AgentMessageEditMutation) (bool, error)
}

// AgentMessageVersion is the compare-and-swap version used by Agent Gateway.
// It hashes only the server-owned author identity, exact stored content bytes,
// and derived plain text. The shape intentionally matches the gateway task
// input hash so a message cannot be edited from a stale or forged projection.
func AgentMessageVersion(authorID string, contentJSON []byte, plainText string) string {
	if authorID == "" || len(contentJSON) == 0 || !json.Valid(contentJSON) {
		return ""
	}
	data, err := json.Marshal([]any{authorID, json.RawMessage(contentJSON), plainText})
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// AgentMessageRecordVersion returns the safe CAS version for a stored record.
func AgentMessageRecordVersion(record MessageRecord) string {
	authorID := ""
	if record.AuthorID != nil {
		authorID = *record.AuthorID
	}
	return AgentMessageVersion(authorID, record.ContentJSON, record.PlainText)
}

func agentEditVersionEqual(expected, actual string) bool {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if len(expected) == 0 || len(expected) != len(actual) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}

// EditAgentMessageInTx edits one ordinary message written by the same Bot
// actor, using the caller's already-open message transaction. It intentionally
// does not open, commit, or rollback a transaction; Agent Gateway uses this to
// couple the edit with task budget/provenance and idempotency state.
func (s *Service) EditAgentMessageInTx(ctx context.Context, tx Tx, input AgentEditInput) (Message, error) {
	if s == nil || s.repo == nil {
		return Message{}, internalError("edit Agent message", errors.New("repository is required"))
	}
	if tx == nil {
		return Message{}, internalError("edit Agent message", errors.New("transaction is required"))
	}
	actorID := strings.TrimSpace(input.ActorID)
	conversationID := strings.TrimSpace(input.ConversationID)
	messageID := strings.TrimSpace(input.MessageID)
	if actorID == "" {
		return Message{}, authRequiredError()
	}
	if conversationID == "" {
		return Message{}, validationError(CodeConversationRequired, MessageConversationRequired)
	}
	if messageID == "" {
		return Message{}, validationError(CodeMessageInvalid, MessageInvalid)
	}
	if strings.TrimSpace(input.ExpectedVersion) == "" {
		return Message{}, revisionConflictError()
	}

	actor, err := s.lookupActor(ctx, tx, actorID)
	if err != nil {
		return Message{}, err
	}
	if actor.Kind != "bot" {
		return Message{}, permissionDeniedError()
	}
	conversation, denied, err := s.authorizeConversation(ctx, tx, actor, conversationID, messageCreateCapability, true)
	if err != nil {
		return Message{}, normalizeRepositoryError(err)
	}
	if denied != nil {
		return Message{}, denied
	}
	target, err := findMessageForViewer(ctx, tx, s.space(), conversation.ID, messageID, actor.ID)
	if err != nil {
		return Message{}, normalizeRepositoryError(err)
	}
	if target == nil {
		return Message{}, messageNotFoundError()
	}
	if target.AuthorID == nil || *target.AuthorID != actor.ID || target.AuthorKind != "bot" || target.Kind != "bot" {
		return Message{}, permissionDeniedError()
	}
	if target.TopicID != "" || target.ThreadRootID != "" {
		return Message{}, validationError(CodeMessageInvalid, "机器人只能编辑普通消息")
	}
	if target.DeletedAt != nil || target.RecalledAt != nil {
		return Message{}, messageNotFoundError()
	}
	currentVersion := AgentMessageRecordVersion(*target)
	if !agentEditVersionEqual(input.ExpectedVersion, currentVersion) {
		return Message{}, revisionConflictError()
	}

	normalized, attachmentIDs, err := s.normalizeContentWithValidator(ctx, tx, actor, conversation.ID, input.Content, nil)
	if err != nil {
		return Message{}, asMessageError(err)
	}
	if !input.ReplaceContent && storedHasNonTextBlocks(target.ContentJSON) && contentHasOnlyTextBlocks(normalized) {
		return Message{}, validationError(CodeMessageInvalidContent, "请提供完整结构化消息内容，不能隐式移除附件或提及")
	}
	contentJSON, err := canonicalContent(normalized)
	if err != nil {
		return Message{}, internalError("canonicalize Agent message", err)
	}
	editTx, ok := tx.(AgentMessageEditTx)
	if !ok {
		return Message{}, internalError("edit Agent message", errors.New("transaction does not support Agent message edits"))
	}
	if changed, err := editTx.UpdateAgentMessage(ctx, AgentMessageEditMutation{
		SpaceID:                 s.space(),
		ConversationID:          conversation.ID,
		MessageID:               target.ID,
		ActorID:                 actor.ID,
		ExpectedVersion:         currentVersion,
		ExpectedContentJSON:     append([]byte(nil), target.ContentJSON...),
		ExpectedPlainText:       target.PlainText,
		ContentJSON:             contentJSON,
		PlainText:               normalized.PlainText,
		AttachmentIDs:           append([]string(nil), attachmentIDs...),
		CustomEmoteIDs:          extractCustomEmoteIDs(normalized),
		EmoteCollectionShareIDs: extractEmoteCollectionShareIDs(normalized),
		EditedAt:                s.nowUTC(),
	}); err != nil {
		return Message{}, normalizeRepositoryError(err)
	} else if !changed {
		return Message{}, revisionConflictError()
	}

	updated, err := findMessageForViewer(ctx, tx, s.space(), conversation.ID, target.ID, actor.ID)
	if err != nil {
		return Message{}, normalizeRepositoryError(err)
	}
	if updated == nil {
		return Message{}, internalError("read edited Agent message", errors.New("edited message is missing"))
	}
	message, err := s.projectOne(ctx, tx, actor, updated)
	if err != nil {
		return Message{}, err
	}
	eventType, payload, err := messageMutationEvent("message.edited", target)
	if err != nil {
		return Message{}, internalError("encode Agent edit event", err)
	}
	if err := s.writeEvent(ctx, tx, EventInput{
		SpaceID:        s.space(),
		Type:           eventType,
		ActorID:        actor.ID,
		ConversationID: conversation.ID,
		TargetType:     messageTargetType,
		TargetID:       target.ID,
		PayloadJSON:    payload,
		CreatedAt:      s.nowUTC(),
	}); err != nil {
		return Message{}, normalizeRepositoryError(err)
	}
	if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{
		Action:     "message.edit",
		TargetType: messageTargetType,
		TargetID:   target.ID,
		Result:     "success",
	}, s.nowUTC())); err != nil {
		return Message{}, normalizeRepositoryError(err)
	}
	return message, nil
}

func storedHasNonTextBlocks(raw []byte) bool {
	var content Content
	if json.Unmarshal(raw, &content) != nil {
		return true
	}
	for _, block := range content.Blocks {
		if strings.TrimSpace(block.Type) != "" && block.Type != "text" {
			return true
		}
	}
	return false
}

func contentHasOnlyTextBlocks(content Content) bool {
	if len(content.Blocks) == 0 {
		return false
	}
	for _, block := range content.Blocks {
		if block.Type != "text" {
			return false
		}
	}
	return true
}
