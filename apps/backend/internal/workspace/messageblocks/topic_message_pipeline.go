package messageblocks

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

// TopicMessagePipeline adapts scope-specific storage operations; content
// validation, associations, author projection and actions stay message-owned.
// Both adapters wrap one transaction. This never starts an independent writer.
type TopicMessagePipeline struct {
	messages   *messages.Service
	repository *messages.PGRepository
	topics     *topics.Service
}

func NewTopicMessagePipeline(service *messages.Service, repository *messages.PGRepository, topicService *topics.Service) *TopicMessagePipeline {
	return &TopicMessagePipeline{messages: service, repository: repository, topics: topicService}
}

func (p *TopicMessagePipeline) CreateMessage(ctx context.Context, tx topics.Tx, topic topics.TopicRecord, input topics.CreateMessageInput) (topics.TopicMessageResult, error) {
	provider, ok := tx.(interface{ SharedMessageTransaction() pgx.Tx })
	if !ok || provider.SharedMessageTransaction() == nil {
		return topics.TopicMessageResult{}, errors.New("shared topic message transaction is required")
	}
	content := input.Content
	if content.Format == "" && strings.TrimSpace(input.Body) != "" {
		content = topics.Content{Format: topics.MessageContentFormat, Blocks: []topics.Block{{Type: "text", Text: input.Body}}}
	}
	encoded, err := json.Marshal(content)
	if err != nil {
		return topics.TopicMessageResult{}, err
	}
	var messageContent messages.Content
	if err := json.Unmarshal(encoded, &messageContent); err != nil {
		return topics.TopicMessageResult{}, err
	}
	wrapper := &topicMessageTx{Tx: p.repository.NewTransaction(provider.SharedMessageTransaction()), topicTx: tx, topic: topic, actorID: input.ActorID, pipeline: p}
	if err := wrapper.lockAttachmentReferences(ctx, messageContent); err != nil {
		return topics.TopicMessageResult{}, err
	}
	message, err := p.messages.CreateMessageInTx(ctx, wrapper, messages.CreateInput{
		ActorID: input.ActorID, ConversationID: topic.ConversationID, TopicID: topic.ID,
		ClientMessageID: input.ClientMessageID, Content: messageContent, ReplyToMessageID: input.ReplyToMessageID, Meta: input.Meta,
	})
	if err != nil {
		var rejected *messages.TransactionRejection
		if errors.As(err, &rejected) {
			return topics.TopicMessageResult{}, topicMessageError(rejected.Err)
		}
		return topics.TopicMessageResult{}, err
	}
	projected, err := topicMessageProjection(message, topic.SpaceID)
	return topics.TopicMessageResult{Message: projected, EventSeq: wrapper.eventSeq}, err
}

func (p *TopicMessagePipeline) ProjectMessages(ctx context.Context, actorID string, input []topics.TopicMessage) ([]topics.TopicMessage, error) {
	if len(input) == 0 {
		return input, nil
	}
	ids := make([]string, 0, len(input))
	for _, item := range input {
		ids = append(ids, item.ID)
	}
	projected, err := p.messages.ProjectTopicMessages(ctx, actorID, input[0].TopicID, ids)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]messages.Message, len(projected))
	for _, item := range projected {
		byID[item.ID] = item
	}
	result := make([]topics.TopicMessage, 0, len(input))
	for _, item := range input {
		if message, ok := byID[item.ID]; ok {
			value, err := topicMessageProjection(message, item.SpaceID)
			if err != nil {
				return nil, err
			}
			result = append(result, value)
		}
	}
	return result, nil
}

func topicMessageProjection(message messages.Message, spaceID string) (topics.TopicMessage, error) {
	// Transport-compatible projection is intentional: topic responses retain
	// their author object while every ordinary message field stays canonical.
	encoded, err := json.Marshal(message)
	if err != nil {
		return topics.TopicMessage{}, err
	}
	var result topics.TopicMessage
	if err := json.Unmarshal(encoded, &result); err != nil {
		return result, err
	}
	result.SpaceID = spaceID
	result.ContentFormat = message.Content.Format
	authorID := ""
	if message.AuthorID != nil {
		authorID = *message.AuthorID
	}
	result.Author = topics.TopicActor{ID: authorID, DisplayName: message.AuthorName, GitHubLogin: message.AuthorGitHubLogin}
	if message.AuthorNickname != "" {
		result.Author.Nickname = &message.AuthorNickname
	}
	if message.AuthorRemark != "" {
		result.Author.Remark = &message.AuthorRemark
	}
	if message.AuthorAvatarURL != "" {
		result.Author.AvatarURL = &message.AuthorAvatarURL
	}
	return result, nil
}

type topicMessageTx struct {
	messages.Tx
	topicTx   topics.Tx
	topic     topics.TopicRecord
	actorID   string
	pipeline  *TopicMessagePipeline
	eventSeq  int64
	messageID string
}

func (t *topicMessageTx) lockAttachmentReferences(ctx context.Context, content messages.Content) error {
	seen := make(map[string]struct{})
	ids := make([]string, 0)
	for _, block := range content.Blocks {
		id := strings.TrimSpace(block.AttachmentID)
		if block.Type != "attachment" || id == "" {
			continue
		}
		if _, exists := seen[id]; !exists {
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	// A staging attachment has one topic scope even when the competing sends
	// belong to different parent groups. Hold the logical attachment lock from
	// validation through association, shared with file removal. Sort all IDs
	// before taking any lock so reversed multi-attachment sends cannot deadlock.
	slices.Sort(ids)
	for _, id := range ids {
		if err := t.Tx.Lock(ctx, "workspace-attachment:"+id); err != nil {
			return err
		}
	}
	return nil
}

func (t *topicMessageTx) GetConversation(ctx context.Context, spaceID, conversationID string) (*messages.ConversationRecord, error) {
	access, ok := t.Tx.(interface {
		TopicMessageAccess(context.Context, string, string, string) (bool, string, error)
	})
	if !ok {
		return nil, errors.New("topic message authorization transaction is required")
	}
	allowed, status, err := access.TopicMessageAccess(ctx, spaceID, t.topic.ID, t.actorID)
	if err != nil || !allowed || status != topics.StatusOpen {
		return nil, err
	}
	return t.Tx.GetConversation(ctx, spaceID, conversationID)
}

func (t *topicMessageTx) FindMessage(ctx context.Context, spaceID, conversationID, messageID string) (*messages.MessageRecord, error) {
	lookup, ok := t.Tx.(messages.ViewerMessageLookup)
	if !ok {
		return nil, errors.New("viewer message lookup is required")
	}
	record, err := lookup.FindMessageForViewer(ctx, spaceID, conversationID, messageID, t.actorID)
	if record != nil && record.TopicID != t.topic.ID {
		return nil, nil
	}
	return record, err
}

func (t *topicMessageTx) FindMessageByClientID(ctx context.Context, spaceID, conversationID, actorID, clientID string) (*messages.MessageRecord, error) {
	record, err := t.topicTx.GetTopicMessageByClientID(ctx, spaceID, t.topic.ID, actorID, clientID)
	if err != nil || record == nil {
		return nil, err
	}
	return t.FindMessage(ctx, spaceID, conversationID, record.ID)
}

func (t *topicMessageTx) MessageExists(ctx context.Context, spaceID, conversationID, messageID string) (bool, error) {
	record, err := t.FindMessage(ctx, spaceID, conversationID, messageID)
	return record != nil && record.DeletedAt == nil && record.RecalledAt == nil, err
}

func (t *topicMessageTx) FindMentionMember(ctx context.Context, spaceID, conversationID, userID string) (*messages.MentionMember, error) {
	member, err := t.topicTx.GetTopicMember(ctx, spaceID, t.topic.ID, userID)
	if err != nil || member == nil || member.LeftAt != nil {
		return nil, err
	}
	return t.Tx.FindMentionMember(ctx, spaceID, conversationID, userID)
}

func (t *topicMessageTx) FindAttachment(ctx context.Context, spaceID, attachmentID string) (*messages.AttachmentRecord, error) {
	attachment, err := t.Tx.FindAttachment(ctx, spaceID, attachmentID)
	if err != nil || attachment == nil {
		return nil, err
	}
	if attachment.Visibility == "private_staging" && attachment.UploaderID == t.actorID {
		provider, ok := t.topicTx.(interface{ SharedMessageTransaction() pgx.Tx })
		if !ok {
			return nil, errors.New("staging attachment scope transaction is required")
		}
		var otherTopic bool
		if err := provider.SharedMessageTransaction().QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM message_attachments ma INNER JOIN messages m ON m.id = ma.message_id
			WHERE ma.attachment_id = $1 AND m.topic_id IS NOT NULL AND m.topic_id <> $2)
		`, attachmentID, t.topic.ID).Scan(&otherTopic); err != nil {
			return nil, err
		}
		if otherTopic {
			return nil, nil
		}
		// The actual attachment remains private. Access is granted by the
		// committed message association to current topic members, never to all
		// parent-group members or while the upload is merely staged.
		copy := *attachment
		copy.Visibility = "conversation"
		copy.ConversationID = &t.topic.ConversationID
		return &copy, nil
	}
	return attachment, nil
}

func (t *topicMessageTx) InsertMessage(ctx context.Context, input messages.MessageInsert) (bool, *messages.MessageRecord, error) {
	inserted, winner, err := t.topicTx.InsertTopicMessage(ctx, topics.TopicMessageInsert{
		ID: input.ID, SpaceID: input.SpaceID, ConversationID: t.topic.ConversationID, TopicID: t.topic.ID,
		AuthorID: input.AuthorID, AuthorKind: input.AuthorKind, Kind: input.Kind, ClientMessageID: input.ClientMessageID,
		ContentFormat: input.ContentFormat, ContentJSON: input.ContentJSON, PlainText: input.PlainText,
		ReplyToMessageID: input.ReplyToMessageID, CreatedAt: input.CreatedAt,
	})
	if err != nil || inserted || winner == nil {
		return inserted, nil, err
	}
	record, err := t.FindMessage(ctx, input.SpaceID, t.topic.ConversationID, winner.ID)
	return inserted, record, err
}

func (t *topicMessageTx) EnforceRetention(ctx context.Context, _ string, _ string, _ int64, now time.Time) error {
	return t.pipeline.topics.EnforceMessageRetention(ctx, t.topicTx, t.topic, now)
}

func (t *topicMessageTx) WriteEvent(ctx context.Context, input messages.EventInput) (messages.EventRecord, error) {
	t.messageID = input.TargetID
	input.Type = "topic.message.created"
	input.TargetType = topics.TopicMessageTargetType
	payload, err := json.Marshal(map[string]string{"topicId": t.topic.ID, "topicMessageId": input.TargetID, "conversationId": t.topic.ConversationID})
	if err != nil {
		return messages.EventRecord{}, err
	}
	input.PayloadJSON = payload
	result, err := t.Tx.WriteEvent(ctx, input)
	if err == nil {
		t.eventSeq = result.Seq
	}
	return result, err
}

func (t *topicMessageTx) WriteAudit(ctx context.Context, input messages.AuditInput) error {
	if input.Action == "message.create" {
		input.Action = "topic.message.create"
		input.TargetType, input.TargetID = topics.TopicTargetType, t.topic.ID
		if input.Result == "success" {
			input.TargetType, input.TargetID = topics.TopicMessageTargetType, t.messageID
		}
		if strings.HasPrefix(input.Reason, "message.") {
			input.Reason = topicMessageError(messages.NewError(input.Reason, "", 400)).Code
		}
	}
	return t.Tx.WriteAudit(ctx, input)
}

// Keep existing topic validation codes while sharing the implementation.
// Newly supported content keeps the shared message error when there was no
// older topic equivalent.
func topicMessageError(err *messages.Error) *topics.Error {
	code, message := err.Code, err.Message
	switch code {
	case messages.CodeMessageInvalidContent, messages.CodeMessageUnsupported:
		code, message = topics.CodeTopicInvalidContent, topics.MessageTopicInvalidContent
	case messages.CodeMessageEmpty:
		code, message = topics.CodeTopicEmptyMessage, topics.MessageTopicEmptyMessage
	case messages.CodeMessageTooLong:
		code, message = topics.CodeTopicMessageTooLong, topics.MessageTopicMessageTooLong
	case messages.CodeMessageInvalidBlock:
		code, message = topics.CodeTopicInvalidBlock, topics.MessageTopicInvalidBlock
	case messages.CodeMessageInvalidText:
		code, message = topics.CodeTopicInvalidText, topics.MessageTopicInvalidText
	case messages.CodeMessageInvalidMention:
		code, message = topics.CodeTopicInvalidMention, topics.MessageTopicInvalidMention
	case messages.CodeMessageInvalidLink:
		code, message = topics.CodeTopicInvalidLink, topics.MessageTopicInvalidLink
	case messages.CodeMessageInvalidEmoji:
		code, message = topics.CodeTopicInvalidEmoji, topics.MessageTopicInvalidEmoji
	case messages.CodeMessageInvalidReply:
		code, message = topics.CodeTopicInvalidReply, topics.MessageTopicInvalidReply
	case messages.CodeMessageIdempotency:
		code = topics.CodeTopicIdempotencyConflict
	}
	return topics.NewError(code, message, err.StatusCode)
}

func (t *topicMessageTx) ScheduleMessageJobs(ctx context.Context, input messagejobs.Input) error {
	jobTx, ok := t.Tx.(messages.MessageJobTx)
	if !ok {
		return errors.New("message job transaction is required")
	}
	input.TopicID = t.topic.ID
	return jobTx.ScheduleMessageJobs(ctx, input)
}

func (t *topicMessageTx) ListMessageEmoteCollectionShares(ctx context.Context, spaceID, viewerID string, ids []string) (map[string]map[string]messages.EmoteCollectionShare, error) {
	reader, ok := t.Tx.(messages.MessageShareReader)
	if !ok {
		return nil, errors.New("message share reader is required")
	}
	return reader.ListMessageEmoteCollectionShares(ctx, spaceID, viewerID, ids)
}
