package botgateway

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"time"
)

type AgentHistoryQuery struct {
	SpaceID, ConversationID, RequestorID, BotUserID string
	MessageID, AuthorID, Query                      string
	Since, Until, BeforeTime                        time.Time
	BeforeID                                        string
	Limit                                           int
	IncludeReplies                                  bool
}

type AgentMember struct {
	ID    string `json:"id"`
	BotID string `json:"botId,omitempty"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
}

type AgentHistoryStore interface {
	ListAgentMessages(context.Context, AgentHistoryQuery) ([]ContextMessageRecord, error)
	ListAgentMembers(context.Context, string, string, int) ([]AgentMember, error)
}

type agentHistoryCursor struct {
	Before time.Time `json:"before"`
	ID     string    `json:"id"`
	Scope  string    `json:"scope"`
}

func (s *Service) AgentCapabilities(ctx context.Context, value *Auth, conversationID string) (map[string]any, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	settings, err := s.repo.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return nil, err
	}
	_, tasks := s.repo.(AgentTaskStore)
	_, history := s.repo.(AgentHistoryStore)
	_, edits := s.messageWriter.(agentMessageEditor)
	_, cardUpdates := s.cardGateway.(agentCardUpdater)
	if conversationID != "" {
		if _, _, err := s.requireConversationPrevalidated(ctx, current, conversationID); err != nil {
			return nil, err
		}
	}
	if AgentTaskID(ctx) != "" {
		task, err := s.requireAgentTask(ctx, current, AgentTaskID(ctx), conversationID)
		if err != nil {
			return nil, err
		}
		if conversationID == "" {
			conversationID = task.ConversationID
		}
	}
	window := 86400
	if settings != nil && settings.ContextWindowSeconds > 0 {
		window = settings.ContextWindowSeconds
	}
	contextAllowed := false
	maxHistoryPage := 50
	if settings != nil && settings.MaxContextMessages > 0 && settings.MaxContextMessages < maxHistoryPage {
		maxHistoryPage = settings.MaxContextMessages
	}
	if conversationID != "" {
		grant, grantErr := s.repo.GetContextGrant(ctx, current.BotID, current.SpaceID, conversationID)
		if grantErr != nil {
			return nil, grantErr
		}
		contextAllowed = grant != nil && grant.AllowContext
		if grant != nil && grant.MaxMessages != nil && *grant.MaxMessages < maxHistoryPage {
			maxHistoryPage = *grant.MaxMessages
		}
	}
	operations := make(map[string]any)
	for name, scope := range map[string]string{"messages.get": ScopeMessagesReadTrigger, "messages.history": ScopeMessagesReadContext, "messages.search": ScopeMessagesReadContext, "members.list": ScopeMessagesReadTrigger, "messages.send": ScopeMessagesSend, "messages.edit": ScopeMessagesSend, "files.read": ScopeFilesReadContent, "files.preview": ScopeFilesReadPreview, "files.metadata": ScopeFilesReadMetadata, "files.upload": ScopeFilesWrite, "cards.send": ScopeCardsWrite, "cards.update": ScopeCardsWrite} {
		granted := RequireScope(current, scope) == nil
		if name == "messages.history" || name == "messages.search" || name == "files.read" || name == "files.preview" || name == "files.metadata" {
			granted = granted && contextAllowed && RequireScope(current, ScopeMessagesReadContext) == nil
		}
		if name == "files.preview" {
			granted = granted && settings != nil && settings.AllowAttachmentPreview
		}
		supported := true
		if name == "messages.edit" {
			supported = edits
		}
		if name == "cards.update" {
			supported = cardUpdates
		}
		operations[name] = map[string]any{"implemented": supported, "scopeGranted": granted, "authorized": supported && granted && AgentTaskID(ctx) != "", "requiresTask": true}
	}
	return map[string]any{
		"version": 1, "taskRequired": s.agentTaskRequired(settings) || AgentTaskID(ctx) != "",
		"features":   map[string]bool{"taskAuthorization": tasks, "history": history, "structuredMessages": true, "taskStatePolling": tasks, "stateEvents": false, "threads": false, "conditionalMessageEdit": edits, "taskCardUpdate": cardUpdates, "operationReconciliation": tasks},
		"operations": operations, "taskActivationEvents": []string{"message.created"},
		"scopes":              append([]string(nil), current.Scopes...),
		"limits":              map[string]any{"maxHistoryPage": maxHistoryPage, "historyWindowSeconds": window, "maxTaskReads": AgentTaskMaxReads, "maxTaskReadBytes": AgentTaskMaxReadBytes, "maxTaskWrites": AgentTaskMaxWrites, "maxTaskChildren": AgentTaskMaxChildren, "maxTaskDepth": AgentTaskMaxDepth, "taskLifetimeSeconds": int(AgentTaskLifetime.Seconds()), "maxAttachmentReadBytes": MaxAgentAttachmentContentBytes, "maxUploadBytes": 50 * 1024 * 1024},
		"messageBlocks":       []string{"text", "mention", "link", "emoji", "attachment", "card"},
		"historyRequiresTask": true, "asOf": s.nowUTC(),
	}, nil
}

func (s *Service) agentHistoryAccess(ctx context.Context, value *Auth, conversationID string) (*Auth, *AgentTask, *Settings, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, nil, nil, err
	}
	task, err := s.requireAgentTask(ctx, current, AgentTaskID(ctx), conversationID)
	if err != nil {
		return nil, nil, nil, err
	}
	settings, err := s.repo.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return nil, nil, nil, err
	}
	return current, task, settings, nil
}

func (s *Service) GetAgentMessage(ctx context.Context, value *Auth, messageID string) (map[string]any, error) {
	if !identifierPattern.MatchString(messageID) {
		return nil, NewError(CodeMessageInvalid, "消息标识无效", 400)
	}
	current, task, settings, err := s.agentHistoryAccess(ctx, value, "")
	if err != nil {
		return nil, err
	}
	store, ok := s.repo.(AgentHistoryStore)
	if !ok {
		return nil, NewError("history.unavailable", "历史读取服务未就绪", 503)
	}
	since := task.CreatedAt.Add(-24 * time.Hour)
	if settings != nil && settings.ContextWindowSeconds > 0 {
		since = task.CreatedAt.Add(-time.Duration(settings.ContextWindowSeconds) * time.Second)
	}
	if messageID == task.TriggerMessageID {
		if err := RequireScope(current, ScopeMessagesReadTrigger); err != nil {
			return nil, err
		}
		since = time.Unix(0, 0).UTC()
	} else {
		origin, originErr := s.repo.(AgentTaskReader).GetAgentMessageOrigin(ctx, current.SpaceID, messageID)
		if originErr != nil {
			return nil, originErr
		}
		ownReply := origin != nil && origin.ID == task.ID && origin.BotID == current.BotID
		if ownReply {
			if err := RequireScope(current, ScopeMessagesSend); err != nil {
				return nil, err
			}
			since = time.Unix(0, 0).UTC()
		} else {
			if err := RequireScope(current, ScopeMessagesReadContext); err != nil {
				return nil, err
			}
			if _, err := s.RequireContextGrant(ctx, current, task.ConversationID); err != nil {
				return nil, err
			}
		}
	}
	if err := s.consumeAgentRead(ctx, current, task.ConversationID, 0); err != nil {
		return nil, err
	}
	rows, err := store.ListAgentMessages(ctx, AgentHistoryQuery{SpaceID: current.SpaceID, ConversationID: task.ConversationID, RequestorID: task.RequestorUserID, BotUserID: current.UserID, MessageID: messageID, Since: since, Until: s.nowUTC(), Limit: 1, IncludeReplies: true})
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, NewError(CodeMessageInvalid, "消息不可读取", 404)
	}
	metadata := settings != nil && settings.IncludeAttachmentMetadata && RequireScope(current, ScopeFilesReadMetadata) == nil
	if metadata {
		grant, grantErr := s.repo.GetContextGrant(ctx, current.BotID, current.SpaceID, task.ConversationID)
		if grantErr != nil {
			return nil, grantErr
		}
		metadata = grant != nil && grant.AllowContext && RequireScope(current, ScopeMessagesReadContext) == nil
	}
	message, err := s.projectAgentMessage(ctx, rows[0], metadata)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	if len(encoded) > 128*1024 {
		return nil, NewError("history.message_too_large", "消息超过单次读取上限", 413)
	}
	if err := s.chargeAgentReadBytes(ctx, current, task.ConversationID, int64(len(encoded))); err != nil {
		return nil, err
	}
	return map[string]any{"message": message, "coverage": map[string]any{"complete": true, "asOf": s.nowUTC()}}, nil
}

func (s *Service) ListAgentHistory(ctx context.Context, value *Auth, conversationID string, options map[string]any) (map[string]any, error) {
	current, task, settings, err := s.agentHistoryAccess(ctx, value, conversationID)
	if err != nil {
		return nil, err
	}
	if err := RequireScope(current, ScopeMessagesReadContext); err != nil {
		return nil, err
	}
	grant, err := s.RequireContextGrant(ctx, current, conversationID)
	if err != nil {
		return nil, err
	}
	store, ok := s.repo.(AgentHistoryStore)
	if !ok {
		return nil, NewError("history.unavailable", "历史读取服务未就绪", 503)
	}
	query := AgentHistoryQuery{SpaceID: current.SpaceID, ConversationID: conversationID, RequestorID: task.RequestorUserID, BotUserID: current.UserID, Until: task.CreatedAt, Limit: 20}
	window := 86400
	maxChars := 20000
	metadata := false
	if settings != nil {
		if settings.ContextWindowSeconds > 0 {
			window = settings.ContextWindowSeconds
		}
		if settings.MaxContextChars > 0 && settings.MaxContextChars < maxChars {
			maxChars = settings.MaxContextChars
		}
		if settings.MaxContextTokens > 0 && settings.MaxContextTokens < maxChars {
			maxChars = settings.MaxContextTokens
		}
		query.IncludeReplies = settings.IncludeReplies
		metadata = settings.IncludeAttachmentMetadata && RequireScope(current, ScopeFilesReadMetadata) == nil
	}
	query.Since = task.CreatedAt.Add(-time.Duration(window) * time.Second)
	if n, ok := optionInt(options, "limit"); ok {
		if n < 1 || n > 50 {
			return nil, NewError(CodeInvalidRequest, "每页条数须在 1 到 50 之间", 400)
		}
		query.Limit = n
	}
	if grant.MaxMessages != nil && *grant.MaxMessages < query.Limit {
		query.Limit = *grant.MaxMessages
	}
	if settings != nil && settings.MaxContextMessages > 0 && settings.MaxContextMessages < query.Limit {
		query.Limit = settings.MaxContextMessages
	}
	query.Query = stringField(options, "query")
	query.AuthorID = stringField(options, "authorId")
	if len(query.Query) > 256 || (query.AuthorID != "" && !identifierPattern.MatchString(query.AuthorID)) {
		return nil, NewError(CodeInvalidRequest, "历史查询条件无效", 400)
	}
	for _, key := range []string{"startTime", "endTime"} {
		if raw := stringField(options, key); raw != "" {
			at, parseErr := time.Parse(time.RFC3339Nano, raw)
			if parseErr != nil {
				return nil, NewError(CodeInvalidRequest, "查询时间须为 RFC3339 格式", 400)
			}
			if key == "startTime" && at.After(query.Since) {
				query.Since = at
			}
			if key == "endTime" && at.Before(query.Until) {
				query.Until = at
			}
		}
	}
	scopeData, _ := json.Marshal([]any{current.BotID, task.ID, conversationID, query.Query, query.AuthorID, query.Since, query.Until})
	digest := sha256.Sum256(scopeData)
	scope := hex.EncodeToString(digest[:])
	if raw := stringField(options, "before"); raw != "" {
		if len(raw) > 1024 {
			return nil, NewError(CodeInvalidRequest, "分页位置无效", 400)
		}
		data, decodeErr := base64.RawURLEncoding.DecodeString(raw)
		var cursor agentHistoryCursor
		if decodeErr != nil || json.Unmarshal(data, &cursor) != nil || cursor.Scope != scope || !identifierPattern.MatchString(cursor.ID) || cursor.Before.IsZero() {
			return nil, NewError(CodeInvalidRequest, "分页位置已失效或不属于本次查询", 400)
		}
		query.BeforeTime, query.BeforeID = cursor.Before, cursor.ID
	}
	pageSize := query.Limit
	query.Limit++
	if err := s.consumeAgentRead(ctx, current, conversationID, 0); err != nil {
		return nil, err
	}
	boundedCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	rows, err := store.ListAgentMessages(boundedCtx, query)
	if err != nil {
		return nil, err
	}
	hasMore := len(rows) > pageSize
	if hasMore {
		rows = rows[:pageSize]
	}
	messages := make([]ContextMessage, 0, len(rows))
	truncated := false
	used := 0
	last := -1
	for i, row := range rows {
		message, projectionErr := s.projectAgentMessage(ctx, row, metadata)
		if projectionErr != nil {
			return nil, projectionErr
		}
		data, _ := json.Marshal(message)
		if used+len(data) > maxChars {
			if len(messages) > 0 {
				hasMore = true
				truncated = true
				break
			}
			// Return a marked excerpt rather than an empty, unpageable result.
			message.PlainText = truncateUTF8Bytes(message.PlainText, 1024)
			message.Content = map[string]any{"format": MessageContentFormat, "plainText": message.PlainText, "blocks": []map[string]any{{"type": "text", "text": message.PlainText}}}
			data, _ = json.Marshal(message)
			truncated = true
		}
		used += len(data)
		messages = append(messages, message)
		last = i
	}
	nextCursor := ""
	if hasMore && last >= 0 {
		cursorData, _ := json.Marshal(agentHistoryCursor{Before: rows[last].CreatedAt, ID: rows[last].ID, Scope: scope})
		nextCursor = base64.RawURLEncoding.EncodeToString(cursorData)
	}
	if err := s.chargeAgentReadBytes(ctx, current, conversationID, int64(used)); err != nil {
		return nil, err
	}
	return map[string]any{"messages": messages, "hasMore": hasMore, "nextCursor": nextCursor,
		"coverage": map[string]any{"since": query.Since, "until": query.Until, "asOf": task.CreatedAt, "sort": "created_at_desc", "truncated": truncated, "returned": len(messages), "scope": "conversation"}}, nil
}

func (s *Service) projectAgentMessage(ctx context.Context, row ContextMessageRecord, metadata bool) (ContextMessage, error) {
	message := projectContextMessage(row, metadata)
	author := ""
	if row.AuthorID != nil {
		author = *row.AuthorID
	}
	message.Version = messageInputHash(&MessageTrigger{AuthorID: author, ContentJSON: row.ContentJSON, PlainText: row.PlainText})
	if !metadata {
		return message, nil
	}
	var body struct {
		Blocks []struct {
			Type string `json:"type"`
			ID   string `json:"attachmentId"`
		} `json:"blocks"`
	}
	if json.Unmarshal(row.ContentJSON, &body) != nil {
		return message, nil
	}
	for _, block := range body.Blocks {
		if block.Type != "attachment" || !identifierPattern.MatchString(block.ID) {
			continue
		}
		if len(message.Attachments) >= 6 {
			break
		}
		attachment, err := s.repo.GetAttachment(ctx, s.spaceID, block.ID)
		if err != nil {
			return ContextMessage{}, err
		}
		if attachment != nil && attachment.ConversationID != nil && *attachment.ConversationID == row.ConversationID && attachment.Visibility == "conversation" && attachment.Status == "available" {
			message.Attachments = append(message.Attachments, projectAttachment(*attachment))
		}
	}
	return message, nil
}

func (s *Service) ListAgentMembers(ctx context.Context, value *Auth, conversationID string) (map[string]any, error) {
	current, task, _, err := s.agentHistoryAccess(ctx, value, conversationID)
	if err != nil {
		return nil, err
	}
	store, ok := s.repo.(AgentHistoryStore)
	if !ok {
		return nil, NewError("members.unavailable", "成员查询服务未就绪", 503)
	}
	if err := s.consumeAgentRead(ctx, current, conversationID, 0); err != nil {
		return nil, err
	}
	members, err := store.ListAgentMembers(ctx, current.SpaceID, task.ConversationID, 201)
	if err != nil {
		return nil, err
	}
	truncated := len(members) > 200
	if truncated {
		members = members[:200]
	}
	data, _ := json.Marshal(members)
	if err := s.chargeAgentReadBytes(ctx, current, conversationID, int64(len(data))); err != nil {
		return nil, err
	}
	return map[string]any{"members": members, "truncated": truncated}, nil
}
