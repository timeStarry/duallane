package botgateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	AgentTaskHeader             = "X-DualLane-Task"
	AgentTaskLifetime           = 30 * time.Minute
	AgentTaskMaxReads           = 64
	AgentTaskMaxReadBytes int64 = 32 * 1024 * 1024
	AgentTaskMaxWrites          = 24
	AgentTaskMaxChildren        = 12
	AgentTaskMaxDepth           = 6
)

type agentTaskContextKey struct{}

// WithAgentTaskID carries a reference, never an authorization credential.
// The authenticated Bot and current domain policy are checked on every use.
func WithAgentTaskID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, agentTaskContextKey{}, strings.TrimSpace(id))
}

func AgentTaskID(ctx context.Context) string {
	id, _ := ctx.Value(agentTaskContextKey{}).(string)
	return id
}

type AgentTask struct {
	ID                string     `json:"id"`
	BotID             string     `json:"-"`
	TokenID           string     `json:"-"`
	SpaceID           string     `json:"-"`
	ConversationID    string     `json:"conversationId"`
	EventID           string     `json:"eventId"`
	TriggerMessageID  string     `json:"triggerMessageId"`
	RequestorUserID   string     `json:"-"`
	RootTaskID        string     `json:"rootTaskId"`
	ParentTaskID      string     `json:"-"`
	InputHash         string     `json:"-"`
	AuthorizationHash string     `json:"-"`
	Depth             int        `json:"depth"`
	ReadsUsed         int        `json:"readsUsed"`
	ReadBytes         int64      `json:"readBytes"`
	WritesUsed        int        `json:"writesUsed"`
	ChildrenUsed      int        `json:"childrenUsed"`
	CancelledAt       *time.Time `json:"cancelledAt,omitempty"`
	CreatedAt         time.Time  `json:"createdAt"`
	ExpiresAt         time.Time  `json:"expiresAt"`
}

type AgentTaskReader interface {
	GetAgentTask(context.Context, string) (*AgentTask, error)
	GetAgentMessageOrigin(context.Context, string, string) (*AgentTask, error)
	AgentTaskEvent(context.Context, string, string, string, time.Time) (*EventRecord, error)
}

type AgentTaskStore interface {
	AgentTaskReader
	CreateAgentTask(context.Context, AgentTask) (*AgentTask, error)
	ConsumeAgentTaskBudget(context.Context, string, int, int64, int, time.Time) error
	CancelAgentTask(context.Context, string, time.Time) error
}

// AgentTaskMutation is implemented by the same PG transaction as message writes.
type AgentTaskMutation interface {
	AgentTaskReader
	LockAgentAuthorization(context.Context, string, time.Time) error
	ConsumeAgentTaskBudget(context.Context, string, int, int64, int, time.Time) error
	RecordAgentMessageOrigin(context.Context, string, string) error
	RecordAgentOperation(context.Context, string, string, string, string) error
}

func taskForbidden() error {
	return NewError("task.authorization_required", "当前操作需要有效的会话任务授权", 403)
}

func taskInvalid() error {
	return NewError("task.invalidated", "任务授权已失效，请重新发起请求", 409)
}

func taskBudgetExceeded() error {
	return NewError("task.budget_exceeded", "任务已达到调用或内容预算上限", 429)
}

func messageInputHash(message *MessageTrigger) string {
	if message == nil {
		return ""
	}
	data, _ := json.Marshal([]any{message.AuthorID, json.RawMessage(message.ContentJSON), message.PlainText})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *Service) CreateAgentTask(ctx context.Context, value *Auth, eventID string) (map[string]any, error) {
	if AgentTaskID(ctx) != "" {
		return nil, taskForbidden()
	}
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	store, ok := s.repo.(AgentTaskStore)
	if !ok {
		return nil, NewError("task.unavailable", "任务授权服务尚未就绪", 503)
	}
	if !identifierPattern.MatchString(eventID) {
		return nil, NewError(CodeInvalidRequest, "触发事件无效", 400)
	}
	event, err := store.AgentTaskEvent(ctx, current.BotID, current.SpaceID, eventID, s.nowUTC())
	if err != nil {
		return nil, err
	}
	if event == nil || event.EventType != "message.created" {
		return nil, taskForbidden()
	}
	allowed, trigger, err := s.authorizeValidatedDelivery(ctx, current, *event)
	if err != nil {
		return nil, err
	}
	if !allowed || trigger == nil {
		return nil, taskForbidden()
	}
	id, err := s.newID("agent task")
	if err != nil {
		return nil, err
	}
	now := s.nowUTC()
	task := AgentTask{ID: "task_" + id, BotID: current.BotID, TokenID: current.TokenID, SpaceID: current.SpaceID,
		ConversationID: event.ConversationID, EventID: event.ID, TriggerMessageID: event.TargetID,
		RequestorUserID: event.ActorUserID, InputHash: messageInputHash(trigger), CreatedAt: now, ExpiresAt: now.Add(AgentTaskLifetime)}
	task.RootTaskID = task.ID
	task.AuthorizationHash, err = s.agentAuthorizationHash(ctx, s.repo, current, event.ConversationID)
	if err != nil {
		return nil, err
	}
	sender, err := s.repo.GetSender(ctx, current.SpaceID, event.ConversationID, event.ActorUserID)
	if err != nil {
		return nil, err
	}
	if sender == nil {
		return nil, taskForbidden()
	}
	if sender.Kind == "bot" {
		parent, lookupErr := store.GetAgentMessageOrigin(ctx, current.SpaceID, event.TargetID)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if parent == nil || parent.CancelledAt != nil || !parent.ExpiresAt.After(now) || parent.Depth >= AgentTaskMaxDepth {
			return nil, taskInvalid()
		}
		task.RootTaskID, task.ParentTaskID, task.RequestorUserID = parent.RootTaskID, parent.ID, parent.RequestorUserID
		task.Depth, task.ExpiresAt = parent.Depth+1, parent.ExpiresAt
	}
	stored, err := store.CreateAgentTask(ctx, task)
	if err != nil {
		return nil, err
	}
	if err := s.validateAgentTask(ctx, s.repo, store, current, stored, stored.ConversationID); err != nil {
		return nil, err
	}
	return map[string]any{"task": stored}, nil
}

func (s *Service) GetAgentTask(ctx context.Context, value *Auth, taskID string) (map[string]any, error) {
	if scoped := AgentTaskID(ctx); scoped != "" && scoped != taskID {
		return nil, taskForbidden()
	}
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	task, err := s.requireAgentTask(ctx, current, taskID, "")
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task}, nil
}

func (s *Service) CancelAgentTask(ctx context.Context, value *Auth, taskID string) (map[string]any, error) {
	if scoped := AgentTaskID(ctx); scoped != "" && scoped != taskID {
		return nil, taskForbidden()
	}
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	store, ok := s.repo.(AgentTaskStore)
	if !ok {
		return nil, taskForbidden()
	}
	task, err := store.GetAgentTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if task == nil || task.BotID != current.BotID || task.TokenID != current.TokenID || task.SpaceID != current.SpaceID {
		return nil, taskForbidden()
	}
	if err := store.CancelAgentTask(ctx, task.RootTaskID, s.nowUTC()); err != nil {
		return nil, err
	}
	return map[string]any{"cancelled": true, "taskId": task.ID, "publishedResultsRecalled": false}, nil
}

func (s *Service) requireAgentTask(ctx context.Context, current *Auth, id, conversationID string) (*AgentTask, error) {
	store, ok := s.repo.(AgentTaskReader)
	if !ok || !identifierPattern.MatchString(id) {
		return nil, taskForbidden()
	}
	task, err := store.GetAgentTask(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := s.validateAgentTask(ctx, s.repo, store, current, task, conversationID); err != nil {
		return nil, err
	}
	return task, nil
}

func (s *Service) validateAgentTask(ctx context.Context, reader ReadRepository, store AgentTaskReader, current *Auth, task *AgentTask, conversationID string) error {
	if task == nil || current == nil || task.BotID != current.BotID || task.TokenID != current.TokenID || task.SpaceID != current.SpaceID || (conversationID != "" && task.ConversationID != conversationID) {
		return taskForbidden()
	}
	if task.CancelledAt != nil || !task.ExpiresAt.After(s.nowUTC()) {
		return taskInvalid()
	}
	conversation, err := reader.GetConversation(ctx, task.SpaceID, task.ConversationID)
	if err != nil {
		return err
	}
	if conversation == nil {
		return taskInvalid()
	}
	// Revalidate every ancestor input and cancellation; a modified root cannot
	// keep authorizing descendant Bot replies from an obsolete human request.
	ancestor := task
	for hops := 0; ; hops++ {
		if hops > AgentTaskMaxDepth || ancestor.CancelledAt != nil || !ancestor.ExpiresAt.After(s.nowUTC()) || ancestor.ConversationID != task.ConversationID || ancestor.RootTaskID != task.RootTaskID {
			return taskInvalid()
		}
		ancestorAuth, authErr := reader.ValidateToken(ctx, ancestor.TokenID, ancestor.BotID, ancestor.SpaceID, s.nowUTC())
		if authErr != nil {
			return authErr
		}
		if ancestorAuth == nil || ancestorAuth.Bot.Status != "active" {
			return taskInvalid()
		}
		if RequireScope(ancestorAuth, ScopeMessagesReadTrigger) != nil {
			return taskInvalid()
		}
		authorizationHash, hashErr := s.agentAuthorizationHash(ctx, reader, ancestorAuth, task.ConversationID)
		if hashErr != nil {
			return hashErr
		}
		if authorizationHash != ancestor.AuthorizationHash {
			return taskInvalid()
		}
		active, memberErr := reader.ConversationMemberActive(ctx, task.SpaceID, task.ConversationID, ancestorAuth.UserID)
		if memberErr != nil {
			return memberErr
		}
		if !active {
			return taskInvalid()
		}
		ancestorSettings, settingsErr := reader.GetSettings(ctx, ancestor.BotID, ancestor.SpaceID)
		if settingsErr != nil {
			return settingsErr
		}
		permitted, permissionErr := s.taskRequestorAllowed(ctx, reader, ancestorSettings, ancestorAuth, task.RequestorUserID, conversation.Type)
		if permissionErr != nil {
			return permissionErr
		}
		if !permitted {
			return taskInvalid()
		}
		message, err := reader.GetMessageTrigger(ctx, task.SpaceID, task.ConversationID, ancestor.TriggerMessageID)
		if err != nil {
			return err
		}
		if message == nil || message.DeletedAt != nil || message.RecalledAt != nil || messageInputHash(message) != ancestor.InputHash {
			return taskInvalid()
		}
		if ancestor.ParentTaskID == "" {
			if ancestor.ID != task.RootTaskID {
				return taskInvalid()
			}
			break
		}
		ancestor, err = store.GetAgentTask(ctx, ancestor.ParentTaskID)
		if err != nil {
			return err
		}
		if ancestor == nil {
			return taskInvalid()
		}
	}
	botMember, err := reader.ConversationMemberActive(ctx, task.SpaceID, task.ConversationID, current.UserID)
	if err != nil {
		return err
	}
	if !botMember {
		return taskInvalid()
	}
	requestor, err := reader.GetSender(ctx, task.SpaceID, task.ConversationID, task.RequestorUserID)
	if err != nil {
		return err
	}
	if requestor == nil || requestor.Kind != "human" || requestor.Role == "auditor" {
		return taskInvalid()
	}
	settings, err := reader.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return err
	}
	if settings == nil {
		return taskInvalid()
	}
	if conversation.Type == "group" {
		policy, err := reader.GetGroupPolicy(ctx, current.BotID, current.SpaceID, task.ConversationID)
		if err != nil {
			return err
		}
		grant, err := reader.GetContextGrant(ctx, current.BotID, current.SpaceID, task.ConversationID)
		if err != nil {
			return err
		}
		if !settings.AllowGroup || policy == nil || policy.Status != "active" || grant == nil || !grant.AllowTrigger {
			return taskInvalid()
		}
	} else if !settings.AllowDirect {
		return taskInvalid()
	}
	allowed, err := s.taskRequestorAllowed(ctx, reader, settings, current, requestor.ID, conversation.Type)
	if err != nil {
		return err
	}
	if !allowed {
		return taskInvalid()
	}
	if task.ParentTaskID != "" {
		origin, err := store.GetAgentMessageOrigin(ctx, task.SpaceID, task.TriggerMessageID)
		if err != nil {
			return err
		}
		if origin == nil || origin.ID != task.ParentTaskID || !s.taskBotSourceAllowed(settings, origin.BotID) {
			return taskInvalid()
		}
	}
	return nil
}

func (s *Service) agentAuthorizationHash(ctx context.Context, reader ReadRepository, value *Auth, conversationID string) (string, error) {
	settings, err := reader.GetSettings(ctx, value.BotID, value.SpaceID)
	if err != nil {
		return "", err
	}
	if settings == nil {
		return "", taskInvalid()
	}
	grant, err := reader.GetContextGrant(ctx, value.BotID, value.SpaceID, conversationID)
	if err != nil {
		return "", err
	}
	groupPolicy, err := reader.GetGroupPolicy(ctx, value.BotID, value.SpaceID, conversationID)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal([]any{settings.AccessPolicy, settings.VisibilityPolicy, settings.AllowDirect, settings.AllowGroup,
		settings.TriggerPolicy, settings.MaxContextMessages, settings.MaxContextChars, settings.MaxContextTokens,
		settings.ContextWindowSeconds, settings.IncludeReplies, settings.IncludeSystemEvents,
		settings.IncludeAttachmentMetadata, settings.AllowAttachmentPreview, value.Scopes, grant, groupPolicy})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// AuthorizeAgentOperation enforces task binding for opt-in V2 Bots and for
// every explicitly scoped call. Legacy operator calls keep their old policy.
func (s *Service) AuthorizeAgentOperation(ctx context.Context, value *Auth, conversationID string) error {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return err
	}
	settings, err := s.repo.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return err
	}
	id := AgentTaskID(ctx)
	if id == "" && !s.agentTaskRequired(settings) {
		return nil
	}
	_, err = s.requireAgentTask(ctx, current, id, conversationID)
	return err
}

func (s *Service) consumeAgentRead(ctx context.Context, current *Auth, conversationID string, bytes int64) error {
	id := AgentTaskID(ctx)
	if id == "" {
		return nil
	}
	task, err := s.requireAgentTask(ctx, current, id, conversationID)
	if err != nil {
		return err
	}
	store, ok := s.repo.(AgentTaskStore)
	if !ok {
		return taskForbidden()
	}
	return store.ConsumeAgentTaskBudget(ctx, task.RootTaskID, 1, bytes, 0, s.nowUTC())
}

func (s *Service) agentTaskWriteInTx(ctx context.Context, tx Tx, value *Auth, result any) error {
	id := AgentTaskID(ctx)
	if id == "" {
		return nil
	}
	store, ok := tx.(AgentTaskMutation)
	if !ok {
		return internalError("authorize task mutation", errors.New("transactional task store required"))
	}
	task, err := store.GetAgentTask(ctx, id)
	if err != nil {
		return err
	}
	if err := s.validateAgentTask(ctx, tx, store, value, task, ""); err != nil {
		return err
	}
	if err := store.ConsumeAgentTaskBudget(ctx, task.RootTaskID, 0, 0, 1, s.nowUTC()); err != nil {
		return err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	var body struct {
		Message struct {
			ID             string `json:"id"`
			ConversationID string `json:"conversationId"`
		} `json:"message"`
	}
	if json.Unmarshal(encoded, &body) != nil {
		return taskInvalid()
	}
	if body.Message.ID != "" {
		if body.Message.ConversationID != task.ConversationID {
			return taskForbidden()
		}
		return store.RecordAgentMessageOrigin(ctx, body.Message.ID, task.ID)
	}
	return nil
}

func (s *Service) chargeAgentReadBytes(ctx context.Context, current *Auth, conversationID string, bytes int64) error {
	if AgentTaskID(ctx) == "" {
		return nil
	}
	task, err := s.requireAgentTask(ctx, current, AgentTaskID(ctx), conversationID)
	if err != nil {
		return err
	}
	store, ok := s.repo.(AgentTaskStore)
	if !ok {
		return taskForbidden()
	}
	return store.ConsumeAgentTaskBudget(ctx, task.RootTaskID, 0, bytes, 0, s.nowUTC())
}
