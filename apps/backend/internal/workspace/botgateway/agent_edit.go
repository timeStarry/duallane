package botgateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

type AgentEditInput struct {
	ExpectedVersion string
	Text            string
	Content         any
}

type agentMessageEditor interface {
	EditBotMessageInTx(context.Context, Tx, MessageWriteRequest, string, string, bool) (GatewayMessage, error)
}

func (s *Service) EditAgentMessage(ctx context.Context, value *Auth, messageID string, input AgentEditInput) (map[string]any, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	if err := RequireScope(current, ScopeMessagesSend); err != nil {
		return nil, err
	}
	task, err := s.requireAgentTask(ctx, current, AgentTaskID(ctx), "")
	if err != nil {
		return nil, err
	}
	if !identifierPattern.MatchString(messageID) || len(input.ExpectedVersion) != 64 {
		return nil, NewError(CodeMessageInvalid, "修改消息需要当前消息版本", 400)
	}
	content, err := normalizeBotContent(input.Content, input.Text)
	if err != nil {
		return nil, err
	}
	writer, ok := s.messageWriter.(agentMessageEditor)
	if !ok {
		return nil, NewError("message.unavailable", "条件消息修改尚未就绪", 503)
	}
	digest := sha256.Sum256([]byte(messageID + ":" + input.ExpectedVersion))
	key := "edit_" + hex.EncodeToString(digest[:])
	result, err := s.withIdempotency(ctx, current, "message.edit", key, map[string]any{"messageId": messageID, "expectedVersion": input.ExpectedVersion, "content": content}, func(tx Tx) (any, error) {
		store, ok := tx.(AgentTaskReader)
		if !ok {
			return nil, taskForbidden()
		}
		origin, err := store.GetAgentMessageOrigin(ctx, current.SpaceID, messageID)
		if err != nil {
			return nil, err
		}
		if origin == nil || origin.ID != task.ID || origin.BotID != current.BotID {
			return nil, taskForbidden()
		}
		if err := s.validateAgentMessageResources(ctx, tx, current, content); err != nil {
			return nil, err
		}
		message, err := writer.EditBotMessageInTx(ctx, tx, MessageWriteRequest{ActorID: current.UserID, SpaceID: current.SpaceID, ConversationID: task.ConversationID, Content: content}, messageID, input.ExpectedVersion, input.Content != nil)
		if err != nil {
			return nil, err
		}
		trigger, err := tx.GetMessageTrigger(ctx, current.SpaceID, task.ConversationID, message.ID)
		if err != nil {
			return nil, err
		}
		message.Version = messageInputHash(trigger)
		return map[string]any{"message": message, "version": message.Version}, nil
	})
	if err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(result)
	var response map[string]any
	if err := json.Unmarshal(encoded, &response); err != nil {
		return nil, err
	}
	return response, nil
}
