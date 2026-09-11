package topics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
)

func (s *Service) createTopicCreationBundle(ctx context.Context, tx Tx, topic TopicRecord, actor *auth.Actor, meta auth.RequestMeta, now time.Time) error {
	if err := s.writeEventPayload(ctx, tx, EventInput{
		Type: "topic.created", ActorID: actor.ID, ConversationID: topic.ConversationID,
		TargetType: TopicTargetType, TargetID: topic.ID,
		Payload: map[string]any{"topicId": topic.ID, "conversationId": topic.ConversationID, "title": topic.Title, "descriptionPreview": summarize(topic.Description)},
	}, now); err != nil {
		return err
	}

	initialID, err := s.newID("topic initial message")
	if err != nil {
		return internalError("generate topic initial message id", err)
	}
	initialContent, contentErr := normalizeContent(Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: topic.Description}}})
	if contentErr != nil {
		return contentErr
	}
	initialJSON, err := json.Marshal(initialContent)
	if err != nil {
		return internalError("encode topic initial message", err)
	}
	inserted, _, err := tx.InsertTopicMessage(ctx, TopicMessageInsert{
		ID: initialID, SpaceID: topic.SpaceID, ConversationID: topic.ConversationID, TopicID: topic.ID,
		AuthorID: actor.ID, AuthorKind: "human", Kind: "user", ClientMessageID: "topic-create:" + topic.ID,
		ContentFormat: MessageContentFormat, ContentJSON: initialJSON, PlainText: initialContent.PlainText, CreatedAt: now,
	})
	if err != nil {
		return normalizeRepositoryError(err)
	}
	if inserted {
		if err := s.writeEventPayload(ctx, tx, EventInput{
			Type: "topic.message.created", ActorID: actor.ID, ConversationID: topic.ConversationID,
			TargetType: TopicMessageTargetType, TargetID: initialID,
			Payload: map[string]any{"topicId": topic.ID, "topicMessageId": initialID},
		}, now); err != nil {
			return err
		}
		if err := s.writeAudit(ctx, tx, actor, meta, AuditInput{Action: "topic.message.create", TargetType: TopicMessageTargetType, TargetID: initialID, Result: "success"}, now); err != nil {
			return err
		}
	}

	descriptionPreview := summarize(topic.Description)
	cardText := "#" + topic.Title
	if descriptionPreview != "" {
		cardText += "\n" + descriptionPreview
	}
	cardContent, contentErr := normalizeContent(Content{
		Format: MessageContentFormat,
		Blocks: []Block{
			{Type: "text", Text: cardText},
			{Type: "card", CardID: "topic_" + topic.ID, CardType: TopicCardType, SchemaVersion: TopicCardSchemaVersion, FallbackText: "#" + topic.Title},
		},
	})
	if contentErr != nil {
		return contentErr
	}
	cardJSON, err := json.Marshal(cardContent)
	if err != nil {
		return internalError("encode topic creation card", err)
	}
	cardMessageID, err := s.newID("topic creation card message")
	if err != nil {
		return internalError("generate topic creation card message id", err)
	}
	cardInserted, err := tx.InsertConversationMessage(ctx, ConversationMessageInsert{
		ID: cardMessageID, SpaceID: topic.SpaceID, ConversationID: topic.ConversationID,
		AuthorID: actor.ID, AuthorKind: "human", Kind: "user", ClientMessageID: "topic-card:" + topic.ID,
		ContentFormat: MessageContentFormat, ContentJSON: cardJSON, PlainText: cardContent.PlainText, CreatedAt: now,
	})
	if err != nil {
		return normalizeRepositoryError(err)
	}
	if cardInserted {
		if err := s.writeEventPayload(ctx, tx, EventInput{
			Type: "message.created", ActorID: actor.ID, ConversationID: topic.ConversationID,
			TargetType: MessageTargetType, TargetID: cardMessageID,
			Payload: map[string]any{"messageId": cardMessageID, "conversationId": topic.ConversationID, "topicId": topic.ID, "topicCard": true},
		}, now); err != nil {
			return err
		}
		if err := s.writeAudit(ctx, tx, actor, meta, AuditInput{Action: "topic.create.card", TargetType: MessageTargetType, TargetID: cardMessageID, Result: "success"}, now); err != nil {
			return err
		}
	}

	payload, err := json.Marshal(map[string]any{
		"topicId": topic.ID, "title": topic.Title, "descriptionPreview": descriptionPreview,
		"participantCount": 1, "status": topic.Status, "allowSyncToGroup": topic.AllowSyncToGroup,
	})
	if err != nil {
		return internalError("encode topic card payload", err)
	}
	createdBy := actor.ID
	upsert, err := tx.UpsertCard(ctx, CardUpsert{
		ID: "topic_" + topic.ID, SpaceID: topic.SpaceID, ConversationID: topic.ConversationID,
		CardType: TopicCardType, SchemaVersion: TopicCardSchemaVersion, PayloadJSON: payload,
		FallbackText: "#" + topic.Title, SourceKind: "topic", SourceID: topic.ID,
		ResourceType: "topic", ResourceID: topic.ID, VisibilityScope: "conversation",
		CreatedByUserID: &createdBy, Status: "active", Now: now,
	})
	if err != nil {
		return normalizeRepositoryError(err)
	}
	if upsert.Created || upsert.Changed {
		eventType := "card.updated"
		if upsert.Created {
			eventType = "card.created"
		}
		if err := s.writeEventPayload(ctx, tx, EventInput{
			Type: eventType, ActorID: actor.ID, ConversationID: topic.ConversationID,
			TargetType: "workspace.card", TargetID: upsert.Card.ID,
			Payload: map[string]any{"cardId": upsert.Card.ID, "cardType": upsert.Card.CardType, "revision": upsert.Card.Revision, "status": upsert.Card.Status},
		}, now); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) CreateMessage(ctx context.Context, input CreateMessageInput) (TopicMessageResult, error) {
	result, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		topic, denied, err := s.topicForActor(ctx, tx, actor, input.TopicID, true)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if denied != nil {
			return nil, rejected(denied, "topic.message.create", auditTarget(input.TopicID), denied.Code), nil
		}
		if denied := s.requireRole(actor, capabilityTopicMessage); denied != nil {
			return nil, rejected(denied, "topic.message.create", topic.ID, "permission.denied"), nil
		}
		if topic.Status != StatusOpen {
			return nil, rejected(topicValidationError(CodeTopicNotOpen, MessageTopicNotOpen), "topic.message.create", topic.ID, CodeTopicNotOpen), nil
		}
		clientID, validationErr := normalizeClientMessageID(input.ClientMessageID)
		if validationErr != nil {
			return nil, rejected(validationErr, "topic.message.create", topic.ID, validationErr.Code), nil
		}
		if s.messagePipeline != nil {
			input.ClientMessageID = clientID
			return s.createSharedMessage(ctx, tx, actor, *topic, input, now)
		}
		contentInput := input.Content
		if contentInput.Format == "" && strings.TrimSpace(input.Body) != "" {
			contentInput = Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: input.Body}}}
		}
		content, validationErr := normalizeContent(contentInput)
		if validationErr != nil {
			return nil, rejected(validationErr, "topic.message.create", topic.ID, validationErr.Code), nil
		}
		if validationErr := s.validateTopicMentions(ctx, tx, topic.ID, content); validationErr != nil {
			return nil, rejected(validationErr, "topic.message.create", topic.ID, validationErr.Code), nil
		}
		replyID := strings.TrimSpace(input.ReplyToMessageID)
		if replyID != "" {
			if !validReferenceID(replyID) {
				return nil, rejected(topicValidationError(CodeTopicInvalidReply, MessageTopicInvalidReply), "topic.message.create", topic.ID, CodeTopicInvalidReply), nil
			}
			reply, err := tx.GetTopicMessage(ctx, s.space(), topic.ID, replyID)
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			if reply == nil || reply.DeletedAt != nil {
				return nil, rejected(topicValidationError(CodeTopicInvalidReply, MessageTopicInvalidReply), "topic.message.create", topic.ID, CodeTopicInvalidReply), nil
			}
		}
		if err := tx.Lock(ctx, "workspace:topic:"+topic.ID+":message:"+actor.ID+":"+clientID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		current, err := tx.GetTopic(ctx, s.space(), topic.ID, actor.ID)
		if err != nil || current == nil {
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			return nil, rejected(topicNotFoundError(), "topic.message.create", topic.ID, CodeTopicNotFound), nil
		}
		if current.Status != StatusOpen {
			return nil, rejected(topicValidationError(CodeTopicNotOpen, MessageTopicNotOpen), "topic.message.create", current.ID, CodeTopicNotOpen), nil
		}
		member, err := tx.GetTopicMember(ctx, s.space(), current.ID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if member == nil || member.LeftAt != nil {
			return nil, rejected(topicNotFoundError(), "topic.message.create", current.ID, CodeTopicNotFound), nil
		}
		contentJSON, err := json.Marshal(content)
		if err != nil {
			return nil, nil, internalError("encode topic message", err)
		}
		existing, err := tx.GetTopicMessageByClientID(ctx, s.space(), current.ID, actor.ID, clientID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		var messageRecord *TopicMessageRecord
		var eventSeq int64
		if existing != nil {
			if !bytes.Equal(existing.ContentJSON, contentJSON) {
				return nil, rejected(topicConflictError(CodeTopicIdempotencyConflict, "重复消息 ID 对应的内容不一致"), "topic.message.create", existing.ID, CodeTopicIdempotencyConflict), nil
			}
			messageRecord = existing
		} else {
			id, err := s.newID("topic message")
			if err != nil {
				return nil, nil, internalError("generate topic message id", err)
			}
			var inserted bool
			inserted, messageRecord, err = tx.InsertTopicMessage(ctx, TopicMessageInsert{
				ID: id, SpaceID: current.SpaceID, ConversationID: current.ConversationID, TopicID: current.ID,
				AuthorID: actor.ID, AuthorKind: "human", Kind: "user", ClientMessageID: clientID,
				ContentFormat: MessageContentFormat, ContentJSON: contentJSON, PlainText: content.PlainText,
				ReplyToMessageID: optionalString(replyID), CreatedAt: now,
			})
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			if !inserted {
				if messageRecord == nil || !bytes.Equal(messageRecord.ContentJSON, contentJSON) {
					return nil, rejected(topicConflictError(CodeTopicIdempotencyConflict, "重复消息 ID 对应的内容不一致"), "topic.message.create", current.ID, CodeTopicIdempotencyConflict), nil
				}
			} else {
				event, err := s.writeEventPayloadRecord(ctx, tx, EventInput{Type: "topic.message.created", ActorID: actor.ID, ConversationID: current.ConversationID, TargetType: TopicMessageTargetType, TargetID: id, Payload: map[string]any{"topicId": current.ID, "topicMessageId": id}}, now)
				if err != nil {
					return nil, nil, err
				}
				eventSeq = event.Seq
				if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "topic.message.create", TargetType: TopicMessageTargetType, TargetID: id, Result: "success"}, now); err != nil {
					return nil, nil, err
				}
				if err := s.enforceRetention(ctx, tx, *current, now); err != nil {
					return nil, nil, err
				}
			}
		}
		if input.SyncToGroup {
			if _, err := s.syncTopicMessageTx(ctx, tx, actor, *current, messageRecord.ID, input.Meta, now); err != nil {
				return nil, nil, err
			}
		}
		if eventSeq > 0 && s.requireMessageJobs {
			jobTx, ok := tx.(MessageJobTx)
			if !ok {
				return nil, nil, internalError("schedule topic message notification jobs", errors.New("transaction does not support message jobs"))
			}
			if err := jobTx.ScheduleMessageJobs(ctx, messagejobs.Input{
				AuthorID: actor.ID, SpaceID: current.SpaceID, ConversationID: current.ConversationID,
				TopicID: current.ID, MessageID: messageRecord.ID, EventSeq: eventSeq,
				ContentJSON: contentJSON, CreatedAt: now,
			}); err != nil {
				return nil, nil, internalError("schedule topic message notification jobs", err)
			}
		}
		if messageRecord == nil {
			return nil, nil, internalError("load topic message", errors.New("message unavailable after insert"))
		}
		message := s.projectTopicMessage(*messageRecord)
		unread, err := tx.TopicUnread(ctx, s.space(), current.ID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		return TopicMessageResult{Message: message, Unread: unread, EventSeq: eventSeq}, nil, nil
	})
	if err != nil {
		return TopicMessageResult{}, err
	}
	return result.(TopicMessageResult), nil
}

func (s *Service) CreateTopicMessage(ctx context.Context, input CreateMessageInput) (TopicMessageResult, error) {
	return s.CreateMessage(ctx, input)
}

func (s *Service) ListMessages(ctx context.Context, input MessageListInput) ([]TopicMessage, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return nil, err
	}
	record, denied, err := s.topicForActor(ctx, s.repo, actor, input.TopicID, true)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if denied != nil {
		return nil, denied
	}
	if denied := s.requireRole(actor, capabilityTopicRead); denied != nil {
		return nil, denied
	}
	limit, validationErr := boundedLimit(input.Limit, DefaultMessageLimit, MaxMessageLimit)
	if validationErr != nil {
		return nil, validationErr
	}
	if around := strings.TrimSpace(input.Around); around != "" {
		if input.Before != "" || input.After != "" {
			return nil, topicValidationError(CodeTopicInvalidCursor, MessageTopicInvalidCursor)
		}
		anchor, err := s.repo.GetTopicMessage(ctx, s.space(), record.ID, around)
		if err != nil {
			return nil, err
		}
		if anchor == nil || anchor.DeletedAt != nil {
			return []TopicMessage{}, nil
		}
		side := (limit - 1) / 2
		if side < 1 {
			side = 1
		}
		older, err := s.ListMessages(ctx, MessageListInput{ActorID: actor.ID, TopicID: record.ID, Before: around, Limit: side, Meta: input.Meta})
		if err != nil {
			return nil, err
		}
		newer, err := s.ListMessages(ctx, MessageListInput{ActorID: actor.ID, TopicID: record.ID, After: around, Limit: side, Meta: input.Meta})
		if err != nil {
			return nil, err
		}
		center := []TopicMessage{s.projectTopicMessage(*anchor)}
		if s.messagePipeline != nil {
			center, err = s.messagePipeline.ProjectMessages(ctx, actor.ID, center)
		}
		if err != nil {
			return nil, err
		}
		return append(append(older, center...), newer...), nil
	}
	before, err := s.messageCursor(ctx, s.repo, record.ID, input.Before)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(input.Before) != "" && strings.TrimSpace(input.After) != "" {
		return nil, topicValidationError(CodeTopicInvalidCursor, MessageTopicInvalidCursor)
	}
	if before != nil && before.ID == "" {
		return []TopicMessage{}, nil
	}
	after, err := s.messageCursor(ctx, s.repo, record.ID, input.After)
	if err != nil {
		return nil, err
	}
	if after != nil && after.ID == "" {
		return []TopicMessage{}, nil
	}
	if after != nil && after.ID == "" {
		return []TopicMessage{}, nil
	}
	rows, err := s.repo.ListTopicMessages(ctx, TopicMessageListQuery{SpaceID: s.space(), TopicID: record.ID, ViewerID: actor.ID, Before: before, After: after, Limit: limit})
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	result := make([]TopicMessage, 0, len(rows))
	for _, row := range rows {
		result = append(result, s.projectTopicMessage(row))
	}
	if s.messagePipeline != nil {
		result, err = s.messagePipeline.ProjectMessages(ctx, actor.ID, result)
		if err != nil {
			return nil, err
		}
	}
	if before != nil {
		for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
			result[left], result[right] = result[right], result[left]
		}
	}
	return result, nil
}

func (s *Service) ListTopicMessages(ctx context.Context, input MessageListInput) ([]TopicMessage, error) {
	return s.ListMessages(ctx, input)
}

func (s *Service) messageCursor(ctx context.Context, repo ReadRepository, topicID, raw string) (*Cursor, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if !validReferenceID(raw) {
		return nil, topicValidationError(CodeTopicInvalidCursor, MessageTopicInvalidCursor)
	}
	row, err := repo.GetTopicMessage(ctx, s.space(), topicID, raw)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if row == nil || row.DeletedAt != nil {
		return &Cursor{ID: "", CreatedAt: time.Time{}}, nil
	}
	return &Cursor{ID: row.ID, CreatedAt: row.CreatedAt}, nil
}

func (s *Service) MarkRead(ctx context.Context, input ReadInput) (ReadResult, error) {
	result, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		topic, denied, err := s.topicForActor(ctx, tx, actor, input.TopicID, true)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if denied != nil {
			return nil, rejected(denied, "topic.read", auditTarget(input.TopicID), denied.Code), nil
		}
		if denied := s.requireRole(actor, capabilityTopicRead); denied != nil {
			return nil, rejected(denied, "topic.read", topic.ID, "permission.denied"), nil
		}
		messageID := strings.TrimSpace(input.MessageID)
		var marker *TopicMessageRecord
		if messageID != "" {
			if !validReferenceID(messageID) {
				return nil, rejected(topicValidationError(CodeTopicMessageNotFound, MessageTopicMessageNotFound), "topic.read", topic.ID, CodeTopicMessageNotFound), nil
			}
			marker, err = tx.GetTopicMessage(ctx, s.space(), topic.ID, messageID)
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			if marker == nil || marker.DeletedAt != nil {
				return nil, rejected(topicValidationError(CodeTopicMessageNotFound, MessageTopicMessageNotFound), "topic.read", topic.ID, CodeTopicMessageNotFound), nil
			}
		} else {
			rows, listErr := tx.ListTopicMessages(ctx, TopicMessageListQuery{SpaceID: s.space(), TopicID: topic.ID, ViewerID: actor.ID, Limit: 1})
			if listErr != nil {
				return nil, nil, normalizeRepositoryError(listErr)
			}
			if len(rows) > 0 {
				// The repository returns the default page newest first, so the
				// first row is the latest message for an empty read marker.
				marker = &rows[0]
			}
		}
		var sequence int64
		if marker != nil {
			sequence, err = tx.MessageEventSeq(ctx, s.space(), marker.ID)
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
		}
		if err := tx.Lock(ctx, "workspace:topic:"+topic.ID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		member, err := tx.GetTopicMember(ctx, s.space(), topic.ID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if member == nil || member.LeftAt != nil {
			return nil, rejected(topicNotFoundError(), "topic.read", topic.ID, CodeTopicNotMember), nil
		}
		if err := tx.MarkTopicRead(ctx, topic.ID, actor.ID, optionalStringRecord(marker), sequence, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "topic.read", TargetType: TopicTargetType, TargetID: topic.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		unread, err := tx.TopicUnread(ctx, s.space(), topic.ID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		return ReadResult{TopicID: topic.ID, LastReadMessageID: optionalStringRecord(marker), LastReadSeq: sequence, UnreadCount: unread}, nil, nil
	})
	if err != nil {
		return ReadResult{}, err
	}
	return result.(ReadResult), nil
}

func (s *Service) MarkTopicRead(ctx context.Context, input ReadInput) (ReadResult, error) {
	return s.MarkRead(ctx, input)
}

func (s *Service) enforceRetention(ctx context.Context, tx Tx, topic TopicRecord, now time.Time) error {
	conversation, err := tx.GetConversation(ctx, s.space(), topic.ConversationID)
	if err != nil {
		return normalizeRepositoryError(err)
	}
	if conversation == nil || conversation.RetentionCount < 1 {
		return nil
	}
	removed, err := tx.EnforceTopicRetention(ctx, topic.ID, conversation.RetentionCount, now)
	if err != nil {
		return normalizeRepositoryError(err)
	}
	for _, item := range removed {
		if item.ProjectionID != "" {
			if card, changed, err := tx.InvalidateCard(ctx, item.ProjectionID, now); err != nil {
				return normalizeRepositoryError(err)
			} else if changed {
				if err := s.writeEventPayload(ctx, tx, EventInput{Type: "card.invalidated", ConversationID: topic.ConversationID, TargetType: "workspace.card", TargetID: card.ID, Payload: map[string]any{"cardId": card.ID, "cardType": card.CardType, "revision": card.Revision, "status": card.Status}}, now); err != nil {
					return err
				}
			}
			if err := s.writeEventPayload(ctx, tx, EventInput{Type: "topic.message.unsynced", ConversationID: topic.ConversationID, TargetType: TopicMessageTargetType, TargetID: item.MessageID, Payload: map[string]any{"topicId": topic.ID, "topicMessageId": item.MessageID, "projectionId": item.ProjectionID, "reason": "retention"}}, now); err != nil {
				return err
			}
			if err := s.writeEventPayload(ctx, tx, EventInput{Type: "message.recalled", ConversationID: topic.ConversationID, TargetType: MessageTargetType, TargetID: item.GroupMessageID, Payload: map[string]any{"messageId": item.GroupMessageID, "conversationId": topic.ConversationID, "reason": "topic.retention"}}, now); err != nil {
				return err
			}
		}
	}
	return nil
}

func normalizeContent(input Content) (Content, *Error) {
	if input.Format != MessageContentFormat {
		return Content{}, topicValidationError(CodeTopicInvalidContent, MessageTopicInvalidContent)
	}
	if len(input.Blocks) == 0 {
		return Content{}, topicValidationError(CodeTopicEmptyMessage, MessageTopicEmptyMessage)
	}
	content := Content{Format: MessageContentFormat, Blocks: make([]Block, 0, len(input.Blocks))}
	plainParts := make([]string, 0, len(input.Blocks))
	for _, block := range input.Blocks {
		normalized, part, err := normalizeBlock(block)
		if err != nil {
			return Content{}, err
		}
		content.Blocks = append(content.Blocks, normalized)
		plainParts = append(plainParts, part)
	}
	content.PlainText = strings.TrimSpace(strings.Join(plainParts, ""))
	if content.PlainText == "" {
		return Content{}, topicValidationError(CodeTopicEmptyMessage, MessageTopicEmptyMessage)
	}
	if utf8.RuneCountInString(content.PlainText) > MaxMessageTextCodePoints || len([]byte(content.PlainText)) > MaxMessageTextBytes {
		return Content{}, topicValidationError(CodeTopicMessageTooLong, MessageTopicMessageTooLong)
	}
	return content, nil
}

func normalizeBlock(block Block) (Block, string, *Error) {
	switch block.Type {
	case "text":
		text := stripControls(block.Text)
		if strings.TrimSpace(text) == "" {
			return Block{}, "", topicValidationError(CodeTopicInvalidText, MessageTopicInvalidText)
		}
		return Block{Type: "text", Text: text}, text, nil
	case "mention":
		userID := strings.TrimSpace(block.UserID)
		if !validReferenceID(userID) {
			return Block{}, "", topicValidationError(CodeTopicInvalidMention, MessageTopicInvalidMention)
		}
		label := stripControls(block.Label)
		label = strings.TrimSpace(label)
		if runes := []rune(label); len(runes) > 256 {
			label = string(runes[:256])
		}
		if label == "" {
			label = userID
		}
		return Block{Type: "mention", UserID: userID, Label: label}, "@" + label, nil
	case "link":
		link := strings.TrimSpace(block.URL)
		parsed, err := url.Parse(link)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || strings.ContainsAny(link, "\r\n") {
			return Block{}, "", topicValidationError(CodeTopicInvalidLink, MessageTopicInvalidLink)
		}
		label := strings.TrimSpace(stripControls(block.Label))
		result := Block{Type: "link", URL: link}
		if label != "" {
			result.Label = label
		}
		if label == "" {
			label = link
		}
		return result, label, nil
	case "emoji":
		shortcode := strings.TrimSpace(block.Shortcode)
		if !emojiPattern.MatchString(shortcode) {
			return Block{}, "", topicValidationError(CodeTopicInvalidEmoji, MessageTopicInvalidEmoji)
		}
		return Block{Type: "emoji", Shortcode: shortcode}, ":" + shortcode + ":", nil
	case "attachment":
		attachmentID := strings.TrimSpace(block.AttachmentID)
		if !validReferenceID(attachmentID) {
			return Block{}, "", topicValidationError(CodeTopicInvalidBlock, MessageTopicInvalidBlock)
		}
		return Block{Type: "attachment", AttachmentID: attachmentID}, "", nil
	case "card":
		cardID := strings.TrimSpace(block.CardID)
		cardType := strings.TrimSpace(block.CardType)
		fallback := strings.TrimSpace(stripControls(block.FallbackText))
		if !validReferenceID(cardID) || cardType == "" || len(cardType) > 128 || block.SchemaVersion < 1 || fallback == "" || utf8.RuneCountInString(fallback) > 160 {
			return Block{}, "", topicValidationError(CodeTopicInvalidBlock, MessageTopicInvalidBlock)
		}
		return Block{Type: "card", CardID: cardID, CardType: cardType, SchemaVersion: block.SchemaVersion, FallbackText: fallback}, fallback, nil
	default:
		return Block{}, "", topicValidationError(CodeTopicInvalidBlock, MessageTopicInvalidBlock)
	}
}

func (s *Service) validateTopicMentions(ctx context.Context, repo ReadRepository, topicID string, content Content) *Error {
	seen := make(map[string]struct{})
	for _, block := range content.Blocks {
		if block.Type != "mention" {
			continue
		}
		if _, ok := seen[block.UserID]; ok {
			continue
		}
		seen[block.UserID] = struct{}{}
		member, err := repo.GetTopicMember(ctx, s.space(), topicID, block.UserID)
		if err != nil {
			return internalError("check topic mention", err)
		}
		if member == nil || member.LeftAt != nil {
			return topicValidationError(CodeTopicInvalidMention, MessageTopicInvalidMention)
		}
	}
	return nil
}

func (s *Service) projectTopicMessage(record TopicMessageRecord) TopicMessage {
	authorID := record.AuthorID
	name := firstNonEmpty(stringPointerValue(record.AuthorRemark), stringPointerValue(record.AuthorNickname), record.AuthorGitHubLogin, record.AuthorDisplayName)
	if name == "" {
		name = "成员"
	}
	content := projectStoredContent(record.ContentJSON, record.ContentFormat, record.PlainText)
	return TopicMessage{
		ID: record.ID, SpaceID: record.SpaceID, ConversationID: record.ConversationID, TopicID: record.TopicID,
		AuthorID: authorID, AuthorKind: record.AuthorKind, Kind: record.Kind,
		ClientMessageID: record.ClientMessageID, ContentFormat: record.ContentFormat, Content: content,
		PlainText: content.PlainText, ReplyToMessageID: record.ReplyToMessageID,
		CreatedAt: formatTimestamp(record.CreatedAt), EditedAt: formatNullableTimestamp(record.EditedAt), DeletedAt: formatNullableTimestamp(record.DeletedAt),
		Author: TopicActor{ID: stringPointerValue(authorID), DisplayName: name, Nickname: record.AuthorNickname, Remark: record.AuthorRemark, GitHubLogin: record.AuthorGitHubLogin, AvatarURL: sanitizeAvatarPointer(record.AuthorAvatarURL)},
	}
}

func projectStoredContent(raw []byte, format, fallback string) Content {
	var decoded Content
	if len(raw) > 0 && json.Unmarshal(raw, &decoded) == nil {
		decoded.Format = firstNonEmpty(decoded.Format, format, MessageContentFormat)
		if decoded.Blocks != nil {
			blocks := make([]Block, 0, len(decoded.Blocks))
			parts := make([]string, 0, len(decoded.Blocks))
			for _, block := range decoded.Blocks {
				normalized, part, err := normalizeBlock(block)
				if err != nil {
					continue
				}
				blocks = append(blocks, normalized)
				parts = append(parts, part)
			}
			decoded.Blocks = blocks
			decoded.PlainText = strings.TrimSpace(strings.Join(parts, ""))
		}
		if decoded.PlainText == "" {
			decoded.PlainText = strings.TrimSpace(fallback)
		}
		return decoded
	}
	return Content{Format: firstNonEmpty(format, MessageContentFormat), PlainText: strings.TrimSpace(fallback), Blocks: []Block{{Type: "text", Text: strings.TrimSpace(fallback)}}}
}

func (s *Service) writeEventPayloadRecord(ctx context.Context, tx Tx, input EventInput, now time.Time) (EventRecord, error) {
	if input.PayloadJSON == nil {
		payload, err := json.Marshal(input.Payload)
		if err != nil {
			return EventRecord{}, internalError("encode topic event payload", err)
		}
		input.PayloadJSON = payload
	}
	return s.writeEvent(ctx, tx, input, now)
}

func normalizeClientMessageID(value string) (string, *Error) {
	value = strings.TrimSpace(value)
	if value == "" || !clientMessagePattern.MatchString(value) {
		return "", topicValidationError(CodeTopicInvalidClientID, MessageTopicInvalidClientID)
	}
	return value, nil
}

func stripControls(value string) string {
	return strings.Map(func(character rune) rune {
		switch {
		case character <= 0x08, character == 0x0b, character == 0x0c, character >= 0x0e && character <= 0x1f, character == 0x7f:
			return -1
		default:
			return character
		}
	}, value)
}

func (s *Service) syncTopicMessageTx(ctx context.Context, tx Tx, actor *auth.Actor, topic TopicRecord, messageID string, meta auth.RequestMeta, now time.Time) (*ProjectionRecord, error) {
	if !topic.AllowSyncToGroup {
		return nil, topicValidationError(CodeTopicSyncDisabled, MessageTopicSyncDisabled)
	}
	message, err := tx.GetTopicMessage(ctx, s.space(), topic.ID, messageID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if message == nil || message.DeletedAt != nil || message.RecalledAt != nil {
		return nil, topicValidationError(CodeTopicMessageNotFound, MessageTopicMessageNotFound)
	}
	existing, err := tx.GetActiveProjection(ctx, s.space(), topic.ID, message.ID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if existing != nil {
		return existing, nil
	}
	// A removed projection is reused, preserving its stable projection ID while
	// assigning a fresh group message that cannot accidentally resurrect content.
	allProjections, err := tx.ListTopicProjections(ctx, s.space(), topic.ID, actor.ID, MaxMessageLimit)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	var removed *ProjectionRecord
	for index := range allProjections {
		if allProjections[index].TopicMessageID == message.ID && allProjections[index].RemovedAt != nil {
			removed = &allProjections[index]
			break
		}
	}
	projectionID := ""
	if removed != nil {
		projectionID = removed.ID
	} else {
		id, err := s.newID("topic projection")
		if err != nil {
			return nil, internalError("generate topic projection id", err)
		}
		projectionID = "tgp_" + id
	}
	groupMessageID, err := s.newID("topic sync message")
	if err != nil {
		return nil, internalError("generate topic sync message id", err)
	}
	summary := summarize(message.PlainText)
	fallback := firstNonEmpty(summary, "话题消息") + " · #" + topic.Title
	content, validationErr := normalizeContent(Content{Format: MessageContentFormat, Blocks: []Block{
		{Type: "text", Text: fallback},
		{Type: "card", CardID: "topic_projection_" + projectionID, CardType: TopicSyncCardType, SchemaVersion: TopicCardSchemaVersion, FallbackText: fallback},
	}})
	if validationErr != nil {
		return nil, validationErr
	}
	contentJSON, err := json.Marshal(content)
	if err != nil {
		return nil, internalError("encode topic sync message", err)
	}
	inserted, err := tx.InsertConversationMessage(ctx, ConversationMessageInsert{
		ID: groupMessageID, SpaceID: topic.SpaceID, ConversationID: topic.ConversationID, AuthorID: actor.ID,
		AuthorKind: "human", Kind: "user", ClientMessageID: "topic-sync:" + topic.ID + ":" + message.ID + ":" + groupMessageID,
		ContentFormat: MessageContentFormat, ContentJSON: contentJSON, PlainText: content.PlainText, CreatedAt: now,
	})
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if !inserted {
		return nil, topicConflictError(CodeTopicSyncConflict, MessageTopicSyncConflict)
	}
	projection := ProjectionRecord{ID: projectionID, TopicID: topic.ID, TopicMessageID: message.ID, GroupConversationID: topic.ConversationID, GroupMessageID: groupMessageID, ProjectionType: "group_sync", CreatedAt: now, UpdatedAt: now}
	if removed != nil {
		if err := tx.ReactivateProjection(ctx, projectionID, groupMessageID, now); err != nil {
			return nil, normalizeRepositoryError(err)
		}
	} else if err := tx.CreateProjection(ctx, projection); err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if err := s.writeEventPayload(ctx, tx, EventInput{Type: "topic.message.synced", ActorID: actor.ID, ConversationID: topic.ConversationID, TargetType: TopicMessageTargetType, TargetID: message.ID, Payload: map[string]any{"topicId": topic.ID, "topicMessageId": message.ID, "projectionId": projectionID}}, now); err != nil {
		return nil, err
	}
	if err := s.writeEventPayload(ctx, tx, EventInput{Type: "message.created", ActorID: actor.ID, ConversationID: topic.ConversationID, TargetType: MessageTargetType, TargetID: groupMessageID, Payload: map[string]any{"messageId": groupMessageID, "conversationId": topic.ConversationID}}, now); err != nil {
		return nil, err
	}
	if err := s.writeAudit(ctx, tx, actor, meta, AuditInput{Action: "topic.message.sync", TargetType: TopicMessageTargetType, TargetID: message.ID, Result: "success"}, now); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(map[string]any{"topicId": topic.ID, "topicMessageId": message.ID, "projectionId": projectionID, "projectionType": "group_sync", "title": topic.Title, "messagePreview": summary, "status": topic.Status})
	if err != nil {
		return nil, internalError("encode topic sync card", err)
	}
	createdBy := actor.ID
	card, err := tx.UpsertCard(ctx, CardUpsert{ID: "topic_projection_" + projectionID, SpaceID: topic.SpaceID, ConversationID: topic.ConversationID, CardType: TopicSyncCardType, SchemaVersion: TopicCardSchemaVersion, PayloadJSON: payload, FallbackText: fallback, SourceKind: "topic", SourceID: "topic-message:" + topic.ID + ":" + message.ID, ResourceType: "topic", ResourceID: topic.ID, VisibilityScope: "conversation", CreatedByUserID: &createdBy, Status: "active", Now: now})
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if card.Created || card.Changed {
		eventType := "card.updated"
		if card.Created {
			eventType = "card.created"
		}
		if err := s.writeEventPayload(ctx, tx, EventInput{Type: eventType, ActorID: actor.ID, ConversationID: topic.ConversationID, TargetType: "workspace.card", TargetID: card.Card.ID, Payload: map[string]any{"cardId": card.Card.ID, "cardType": card.Card.CardType, "revision": card.Card.Revision, "status": card.Card.Status}}, now); err != nil {
			return nil, err
		}
	}
	return &projection, nil
}

func (s *Service) SyncMessage(ctx context.Context, input SyncInput) (ProjectionResult, error) {
	result, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		topic, denied, err := s.topicForActor(ctx, tx, actor, input.TopicID, true)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if denied != nil {
			return nil, rejected(denied, "topic.message.sync", auditTarget(input.TopicID), denied.Code), nil
		}
		if denied := s.requireRole(actor, capabilityTopicSync); denied != nil {
			return nil, rejected(denied, "topic.message.sync", topic.ID, "permission.denied"), nil
		}
		topic, denied, err = s.lockWritableTopic(ctx, tx, actor, *topic)
		if err != nil {
			return nil, nil, err
		}
		if denied != nil {
			return nil, rejected(denied, "topic.message.sync", auditTarget(input.TopicID), denied.Code), nil
		}
		messageID := strings.TrimSpace(input.MessageID)
		if !validReferenceID(messageID) {
			return nil, rejected(topicValidationError(CodeTopicMessageRequired, MessageTopicMessageRequired), "topic.message.sync", topic.ID, CodeTopicMessageRequired), nil
		}
		if err := tx.Lock(ctx, "workspace:topic:"+topic.ID+":sync:"+messageID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		member, err := tx.GetTopicMember(ctx, s.space(), topic.ID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if member == nil || member.LeftAt != nil {
			return nil, rejected(topicNotFoundError(), "topic.message.sync", topic.ID, CodeTopicNotMember), nil
		}
		projection, err := s.syncTopicMessageTx(ctx, tx, actor, *topic, messageID, input.Meta, now)
		if err != nil {
			if domainErr, ok := err.(*Error); ok {
				return nil, rejected(domainErr, "topic.message.sync", topic.ID, domainErr.Code), nil
			}
			return nil, nil, err
		}
		projected := projectProjection(*projection)
		return ProjectionResult{Projection: &projected, Removed: false}, nil, nil
	})
	if err != nil {
		return ProjectionResult{}, err
	}
	return result.(ProjectionResult), nil
}

func (s *Service) SyncTopicMessage(ctx context.Context, input SyncInput) (ProjectionResult, error) {
	return s.SyncMessage(ctx, input)
}

func (s *Service) UnsyncMessage(ctx context.Context, input SyncInput) (ProjectionResult, error) {
	result, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		topic, denied, err := s.topicForActor(ctx, tx, actor, input.TopicID, true)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if denied != nil {
			return nil, rejected(denied, "topic.message.unsync", auditTarget(input.TopicID), denied.Code), nil
		}
		if denied := s.requireRole(actor, capabilityTopicSync); denied != nil {
			return nil, rejected(denied, "topic.message.unsync", topic.ID, "permission.denied"), nil
		}
		topic, denied, err = s.lockWritableTopic(ctx, tx, actor, *topic)
		if err != nil {
			return nil, nil, err
		}
		if denied != nil {
			return nil, rejected(denied, "topic.message.unsync", auditTarget(input.TopicID), denied.Code), nil
		}
		messageID := strings.TrimSpace(input.MessageID)
		if !validReferenceID(messageID) {
			return nil, rejected(topicValidationError(CodeTopicMessageRequired, MessageTopicMessageRequired), "topic.message.unsync", topic.ID, CodeTopicMessageRequired), nil
		}
		if err := tx.Lock(ctx, "workspace:topic:"+topic.ID+":sync:"+messageID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		member, err := tx.GetTopicMember(ctx, s.space(), topic.ID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if member == nil || member.LeftAt != nil {
			return nil, rejected(topicNotFoundError(), "topic.message.unsync", topic.ID, CodeTopicNotMember), nil
		}
		projection, err := tx.GetActiveProjection(ctx, s.space(), topic.ID, messageID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if projection == nil {
			return ProjectionResult{Projection: nil, Removed: false}, nil, nil
		}
		if _, err := tx.UnsyncProjection(ctx, projection.ID, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if err := tx.MarkGroupMessageDeleted(ctx, projection.GroupMessageID, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if card, changed, err := tx.InvalidateCard(ctx, projection.ID, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		} else if changed {
			if err := s.writeEventPayload(ctx, tx, EventInput{Type: "card.invalidated", ActorID: actor.ID, ConversationID: topic.ConversationID, TargetType: "workspace.card", TargetID: card.ID, Payload: map[string]any{"cardId": card.ID, "cardType": card.CardType, "revision": card.Revision, "status": card.Status}}, now); err != nil {
				return nil, nil, err
			}
		}
		if err := s.writeEventPayload(ctx, tx, EventInput{Type: "topic.message.unsynced", ActorID: actor.ID, ConversationID: topic.ConversationID, TargetType: TopicMessageTargetType, TargetID: messageID, Payload: map[string]any{"topicId": topic.ID, "topicMessageId": messageID, "projectionId": projection.ID}}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeEventPayload(ctx, tx, EventInput{Type: "message.recalled", ActorID: actor.ID, ConversationID: topic.ConversationID, TargetType: MessageTargetType, TargetID: projection.GroupMessageID, Payload: map[string]any{"messageId": projection.GroupMessageID, "conversationId": topic.ConversationID}}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "topic.message.unsync", TargetType: TopicMessageTargetType, TargetID: messageID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		removedAt := now
		projection.RemovedAt = &removedAt
		projection.UpdatedAt = now
		projected := projectProjection(*projection)
		return ProjectionResult{Projection: &projected, Removed: true}, nil, nil
	})
	if err != nil {
		return ProjectionResult{}, err
	}
	return result.(ProjectionResult), nil
}

func (s *Service) UnsyncTopicMessage(ctx context.Context, input SyncInput) (ProjectionResult, error) {
	return s.UnsyncMessage(ctx, input)
}

func (s *Service) ListProjections(ctx context.Context, input ProjectionListInput) ([]Projection, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return nil, err
	}
	record, denied, err := s.topicForActor(ctx, s.repo, actor, input.TopicID, true)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if denied != nil {
		return nil, denied
	}
	if denied := s.requireRole(actor, capabilityTopicRead); denied != nil {
		return nil, denied
	}
	limit, validationErr := boundedLimit(input.Limit, 100, MaxMessageLimit)
	if validationErr != nil {
		return nil, validationErr
	}
	rows, err := s.repo.ListTopicProjections(ctx, s.space(), record.ID, actor.ID, limit)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	result := make([]Projection, 0, len(rows))
	for _, row := range rows {
		result = append(result, projectProjection(row))
	}
	return result, nil
}

func (s *Service) ListTopicProjections(ctx context.Context, input ProjectionListInput) ([]Projection, error) {
	return s.ListProjections(ctx, input)
}

func projectProjection(record ProjectionRecord) Projection {
	return Projection{ID: record.ID, TopicID: record.TopicID, TopicMessageID: record.TopicMessageID, GroupConversationID: record.GroupConversationID, GroupMessageID: record.GroupMessageID, ProjectionType: record.ProjectionType, CreatedAt: formatTimestamp(record.CreatedAt), UpdatedAt: formatTimestamp(record.UpdatedAt), RemovedAt: formatNullableTimestamp(record.RemovedAt)}
}

func optionalStringRecord(record *TopicMessageRecord) *string {
	if record == nil || strings.TrimSpace(record.ID) == "" {
		return nil
	}
	id := record.ID
	return &id
}
