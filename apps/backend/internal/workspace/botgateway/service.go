package botgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
)

var (
	botTokenPattern    = regexp.MustCompile(`^Bearer\s+(dl_bot_[A-Za-z0-9_-]{32,})$`)
	rawBotTokenPattern = regexp.MustCompile(`^dl_bot_[A-Za-z0-9_-]{32,}$`)
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	cardTypePattern    = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)
	htmlPattern        = regexp.MustCompile(`(?i)</?[a-z][^>]*>`)
)

type Clock func() time.Time
type IDFactory func() (string, error)

type ServiceOptions struct {
	Repository       Repository
	Authenticator    TokenAuthenticator
	MessageWriter    MessageWriter
	CardGateway      CardGateway
	AttachmentWriter AttachmentWriter
	SpaceID          string
	Now              Clock
	IDFactory        IDFactory
	ReplayLimit      int
	ReplayWindow     time.Duration
	BatchSize        int
}

type Service struct {
	repo             Repository
	authenticator    TokenAuthenticator
	messageWriter    MessageWriter
	cardGateway      CardGateway
	attachmentWriter AttachmentWriter
	spaceID          string
	now              Clock
	idFactory        IDFactory
	replayLimit      int
	replayWindow     time.Duration
	batchSize        int
	connectionMu     sync.Mutex
	connections      map[string]map[string]struct{}
	connectionLatest map[string]string
}

func NewService(options ServiceOptions) *Service {
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	idFactory := options.IDFactory
	if idFactory == nil {
		idFactory = func() (string, error) {
			id, err := uuid.NewRandom()
			if err != nil {
				return "", err
			}
			return id.String(), nil
		}
	}
	replayLimit := options.ReplayLimit
	if replayLimit <= 0 || replayLimit > MaxReplayLimit {
		replayLimit = DefaultReplayLimit
	}
	replayWindow := options.ReplayWindow
	if replayWindow <= 0 {
		replayWindow = ReplayWindow
	}
	batchSize := options.BatchSize
	if batchSize <= 0 || batchSize > MaxBatchSize {
		batchSize = DefaultBatchSize
	}
	return &Service{
		repo:             options.Repository,
		authenticator:    options.Authenticator,
		messageWriter:    options.MessageWriter,
		cardGateway:      options.CardGateway,
		attachmentWriter: options.AttachmentWriter,
		spaceID:          spaceID,
		now:              now,
		idFactory:        idFactory,
		replayLimit:      replayLimit,
		replayWindow:     replayWindow,
		batchSize:        batchSize,
		connections:      make(map[string]map[string]struct{}),
		connectionLatest: make(map[string]string),
	}
}

func (s *Service) Repository() Repository {
	if s == nil {
		return nil
	}
	return s.repo
}

// RegisterConnection persists a connected transport and returns an idempotent
// cleanup function. The nonce is part of the update predicate on heartbeat
// and disconnect so an old socket cannot overwrite a newer socket's state.
func (s *Service) RegisterConnection(ctx context.Context, value *Auth, registration ConnectionRegistration) (func(context.Context) error, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	persistence, ok := s.repo.(ConnectionPersistence)
	if !ok || persistence == nil {
		return nil, internalError("register bot gateway connection", errors.New("connection persistence is required"))
	}
	nonce := strings.TrimSpace(registration.Nonce)
	if !identifierPattern.MatchString(nonce) {
		return nil, NewError(CodeInvalidRequest, MessageInvalidMessage, 400)
	}
	adapterVersion := strings.TrimSpace(registration.AdapterVersion)
	if len(adapterVersion) > 128 || strings.IndexByte(adapterVersion, 0) >= 0 {
		return nil, NewError(CodeInvalidRequest, MessageInvalidMessage, 400)
	}
	now := s.nowUTC()
	connectionID, err := s.newID("bot gateway connection")
	if err != nil {
		return nil, internalError("generate bot gateway connection id", err)
	}
	if err := persistence.RegisterConnection(ctx, ConnectionRegistrationRecord{
		ID: connectionID, BotID: current.BotID, SpaceID: current.SpaceID, Status: "connected",
		AdapterVersion: adapterVersion, Nonce: nonce, ConnectedAt: now, HeartbeatAt: now, UpdatedAt: now,
	}); err != nil {
		return nil, normalizeError(err)
	}

	key := connectionKey(current.BotID, current.SpaceID)
	s.connectionMu.Lock()
	if s.connections == nil {
		s.connections = make(map[string]map[string]struct{})
	}
	if s.connectionLatest == nil {
		s.connectionLatest = make(map[string]string)
	}
	active := s.connections[key]
	if active == nil {
		active = make(map[string]struct{})
		s.connections[key] = active
	}
	active[nonce] = struct{}{}
	s.connectionLatest[key] = nonce
	s.connectionMu.Unlock()

	var once sync.Once
	return func(cleanupCtx context.Context) error {
		var cleanupErr error
		once.Do(func() {
			s.connectionMu.Lock()
			active := s.connections[key]
			delete(active, nonce)
			last := len(active) == 0
			disconnectNonce := s.connectionLatest[key]
			if last {
				delete(s.connections, key)
				delete(s.connectionLatest, key)
			}
			s.connectionMu.Unlock()
			if !last {
				return
			}
			if cleanupCtx == nil {
				cleanupCtx = context.Background()
			}
			if strings.TrimSpace(disconnectNonce) == "" {
				disconnectNonce = nonce
			}
			cleanupErr = persistence.DisconnectConnection(cleanupCtx, current.BotID, current.SpaceID, disconnectNonce, s.nowUTC())
		})
		return normalizeError(cleanupErr)
	}, nil
}

// Heartbeat revalidates the token before touching durable connection state.
// A nonce that is no longer active is treated as an invalid request, which
// prevents a stale/restarted socket from extending the previous connection.
func (s *Service) Heartbeat(ctx context.Context, value *Auth, nonce string) (HeartbeatResult, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return HeartbeatResult{}, err
	}
	nonce = strings.TrimSpace(nonce)
	if !s.connectionIsActive(current.BotID, current.SpaceID, nonce) {
		return HeartbeatResult{}, NewError(CodeInvalidRequest, MessageInvalidMessage, 400)
	}
	persistence, ok := s.repo.(ConnectionPersistence)
	if !ok || persistence == nil {
		return HeartbeatResult{}, internalError("heartbeat bot gateway connection", errors.New("connection persistence is required"))
	}
	at := s.nowUTC()
	if err := persistence.HeartbeatConnection(ctx, current.BotID, current.SpaceID, nonce, at); err != nil {
		return HeartbeatResult{}, normalizeError(err)
	}
	return HeartbeatResult{Timestamp: timestamp(at)}, nil
}

func (s *Service) connectionIsActive(botID, spaceID, nonce string) bool {
	if s == nil || strings.TrimSpace(nonce) == "" {
		return false
	}
	s.connectionMu.Lock()
	defer s.connectionMu.Unlock()
	_, ok := s.connections[connectionKey(botID, spaceID)][nonce]
	return ok
}

func connectionKey(botID, spaceID string) string {
	return strings.TrimSpace(botID) + "\x00" + strings.TrimSpace(spaceID)
}

func (s *Service) nowUTC() time.Time {
	now := time.Now()
	if s != nil && s.now != nil {
		now = s.now()
	}
	if now.IsZero() {
		now = time.Unix(0, 0)
	}
	return now.UTC()
}

func (s *Service) newID(operation string) (string, error) {
	if s == nil || s.idFactory == nil {
		return "", errors.New(operation + " id factory is required")
	}
	id, err := s.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return id, nil
}

// ExtractBearerToken accepts only the documented opaque Bot token envelope.
// It intentionally does not return a partially matched value.
func ExtractBearerToken(value string) (string, error) {
	if strings.HasPrefix(value, "dl_bot_") {
		if rawBotTokenPattern.MatchString(value) {
			return value, nil
		}
		return "", invalidTokenError()
	}
	match := botTokenPattern.FindStringSubmatch(value)
	if len(match) != 2 {
		return "", invalidTokenError()
	}
	return match[1], nil
}

func HashToken(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func RequireScope(value *Auth, scope string) error {
	if value == nil || !validScope(scope) || !containsScope(value.Scopes, scope) {
		return scopeDeniedError()
	}
	return nil
}

func validScope(scope string) bool {
	for _, allowed := range ScopeAllowlist {
		if allowed == scope {
			return true
		}
	}
	return false
}

func containsScope(scopes []string, wanted string) bool {
	for _, scope := range scopes {
		if scope == wanted {
			return true
		}
	}
	return false
}

func normalizeScopes(scopes []string) []string {
	seen := make(map[string]struct{}, len(scopes))
	result := make([]string, 0, len(scopes))
	for _, allowed := range ScopeAllowlist {
		for _, scope := range scopes {
			if scope == allowed {
				if _, ok := seen[scope]; !ok {
					seen[scope] = struct{}{}
					result = append(result, scope)
				}
				break
			}
		}
	}
	return result
}

func (s *Service) Authenticate(ctx context.Context, rawAuthorization string, options TokenAuthOptions) (*Auth, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("authenticate bot token", errors.New("repository is required"))
	}
	rawToken, err := ExtractBearerToken(rawAuthorization)
	if err != nil {
		return nil, err
	}
	var candidate *Auth
	if s.authenticator != nil {
		candidate, err = s.authenticator.AuthenticateToken(ctx, rawToken, options)
	} else {
		candidate, err = s.repo.LookupToken(ctx, HashToken(rawToken), options, s.nowUTC())
	}
	if err != nil {
		return nil, normalizeError(err)
	}
	if candidate == nil {
		return nil, invalidTokenError()
	}
	return s.ValidateAuth(ctx, candidate)
}

// ValidateAuth is called by every gateway operation. The caller's snapshot is
// never trusted after token rotation, Bot pause/delete, membership removal, or
// scope changes.
func (s *Service) ValidateAuth(ctx context.Context, value *Auth) (*Auth, error) {
	if s == nil || s.repo == nil || value == nil || strings.TrimSpace(value.TokenID) == "" || strings.TrimSpace(value.BotID) == "" || strings.TrimSpace(value.SpaceID) == "" {
		return nil, invalidTokenError()
	}
	current, err := s.repo.ValidateToken(ctx, value.TokenID, value.BotID, value.SpaceID, s.nowUTC())
	if err != nil {
		return nil, normalizeError(err)
	}
	if current == nil || current.Bot.Status != "active" || current.BotID == "" || current.UserID == "" {
		return nil, invalidTokenError()
	}
	current.Scopes = normalizeScopes(current.Scopes)
	return current, nil
}

func SafeBot(value Bot) map[string]any {
	return map[string]any{
		"id":                    value.ID,
		"botUserId":             value.BotUserID,
		"spaceId":               value.SpaceID,
		"mode":                  value.Mode,
		"name":                  value.Name,
		"visibilityPolicy":      value.VisibilityPolicy,
		"conversationPolicy":    value.ConversationPolicy,
		"triggerPolicy":         value.TriggerPolicy,
		"status":                value.Status,
		"kind":                  "bot",
		"authenticationAllowed": false,
	}
}

func (s *Service) GetMe(ctx context.Context, value *Auth) (Me, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return Me{}, err
	}
	settings, err := s.repo.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return Me{}, normalizeError(err)
	}
	connection, err := s.repo.GetConnection(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return Me{}, normalizeError(err)
	}
	return Me{Version: Version, Bot: SafeBot(current.Bot), SpaceID: current.SpaceID, Scopes: append([]string(nil), current.Scopes...), Settings: projectSettings(settings), Connection: connection}, nil
}

func normalizeIdentifier(value, code string) (string, error) {
	value = strings.TrimSpace(value)
	if !identifierPattern.MatchString(value) {
		return "", NewError(code, MessageConversationInvalid, 400)
	}
	return value, nil
}

func (s *Service) requireConversationCurrent(ctx context.Context, value *Auth, conversationID string) (*Auth, *Conversation, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, nil, err
	}
	id, err := normalizeIdentifier(conversationID, CodeConversationInvalid)
	if err != nil {
		return nil, nil, err
	}
	conversation, err := s.repo.GetConversation(ctx, current.SpaceID, id)
	if err != nil {
		return nil, nil, normalizeError(err)
	}
	if conversation == nil {
		return nil, nil, NewError(CodeConversationNotFound, MessageConversationNotFound, 404)
	}
	active, err := s.repo.ConversationMemberActive(ctx, current.SpaceID, id, current.UserID)
	if err != nil {
		return nil, nil, normalizeError(err)
	}
	if !active {
		return nil, nil, NewError(CodeConversationNotFound, MessageConversationNotFound, 404)
	}
	settings, err := s.repo.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return nil, nil, normalizeError(err)
	}
	if conversation.Type == "direct" && settings != nil && !settings.AllowDirect {
		return nil, nil, NewError(CodeConversationForbidden, "Bot 当前策略不允许私聊", 403)
	}
	if conversation.Type == "group" {
		if settings == nil || !settings.AllowGroup || current.Bot.ConversationPolicy != "group-capable" {
			return nil, nil, NewError(CodeConversationForbidden, MessageConversationForbidden, 403)
		}
		policy, err := s.repo.GetGroupPolicy(ctx, current.BotID, current.SpaceID, id)
		if err != nil {
			return nil, nil, normalizeError(err)
		}
		if policy == nil || policy.Status != "active" {
			return nil, nil, NewError(CodeConversationForbidden, "Bot 尚未获准加入该群聊", 403)
		}
	}
	return current, conversation, nil
}

func (s *Service) RequireConversation(ctx context.Context, value *Auth, conversationID string) (*Conversation, error) {
	_, conversation, err := s.requireConversationCurrent(ctx, value, conversationID)
	return conversation, err
}

func (s *Service) RequireContextGrant(ctx context.Context, value *Auth, conversationID string) (*ContextGrant, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	id, err := normalizeIdentifier(conversationID, CodeConversationInvalid)
	if err != nil {
		return nil, err
	}
	grant, err := s.repo.GetContextGrant(ctx, current.BotID, current.SpaceID, id)
	if err != nil {
		return nil, normalizeError(err)
	}
	if grant == nil || !grant.AllowContext {
		return nil, NewError(CodeContextForbidden, MessageContextForbidden, 403)
	}
	return grant, nil
}

func (s *Service) GetContext(ctx context.Context, value *Auth, conversationID string, options map[string]any) (map[string]any, error) {
	current, conversation, err := s.requireConversationCurrent(ctx, value, conversationID)
	if err != nil {
		return nil, err
	}
	if err := RequireScope(current, ScopeMessagesReadContext); err != nil {
		return nil, err
	}
	grant, err := s.RequireContextGrant(ctx, current, conversation.ID)
	if err != nil {
		return nil, err
	}
	settings, err := s.repo.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return nil, normalizeError(err)
	}
	configuredMessages := 50
	maxChars := 20_000
	maxTokens := 8_000
	windowSeconds := 86_400
	includeReplies := false
	includeSystemEvents := false
	includeAttachments := false
	if settings != nil {
		if settings.MaxContextMessages > 0 {
			configuredMessages = settings.MaxContextMessages
		}
		if settings.MaxContextChars > 0 {
			maxChars = settings.MaxContextChars
		}
		if settings.MaxContextTokens > 0 {
			maxTokens = settings.MaxContextTokens
		}
		if settings.ContextWindowSeconds > 0 {
			windowSeconds = settings.ContextWindowSeconds
		}
		includeReplies = settings.IncludeReplies
		includeSystemEvents = settings.IncludeSystemEvents
		includeAttachments = settings.IncludeAttachmentMetadata
	}
	if grant.MaxMessages != nil && *grant.MaxMessages > 0 && *grant.MaxMessages < configuredMessages {
		configuredMessages = *grant.MaxMessages
	}
	if configuredMessages > MaxReplayLimit {
		configuredMessages = MaxReplayLimit
	}
	limit := configuredMessages
	if requested, ok := optionInt(options, "limit"); ok {
		if requested > 0 {
			limit = requested
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > configuredMessages {
		limit = configuredMessages
	}
	if limit > MaxReplayLimit {
		limit = MaxReplayLimit
	}
	cutoff := s.nowUTC().Add(-time.Duration(windowSeconds) * time.Second)
	rows, err := s.repo.ListContextMessages(ctx, current.SpaceID, conversation.ID, cutoff, includeReplies, includeSystemEvents, limit)
	if err != nil {
		return nil, normalizeError(err)
	}
	messages := make([]ContextMessage, 0, len(rows))
	for _, row := range rows {
		messages = append(messages, projectContextMessage(row, includeAttachments))
	}
	messages = applyContextBudgets(messages, maxChars, maxTokens)
	return map[string]any{
		"conversation": projectConversation(*conversation),
		"messages":     messages,
		"limits":       map[string]any{"maxMessages": configuredMessages, "maxChars": maxChars, "maxTokens": maxTokens, "windowSeconds": windowSeconds},
	}, nil
}

func optionInt(options map[string]any, key string) (int, bool) {
	if options == nil {
		return 0, false
	}
	value, ok := options[key]
	if !ok {
		return 0, false
	}
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		if typed >= int64(^uint(0)>>1) || typed <= -int64(^uint(0)>>1)-1 {
			return 0, false
		}
		return int(typed), true
	case float64:
		if typed != float64(int(typed)) {
			return 0, false
		}
		return int(typed), true
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		return parsed, err == nil
	default:
		return 0, false
	}
}

func applyContextBudgets(messages []ContextMessage, maxChars, maxTokens int) []ContextMessage {
	if maxChars <= 0 || maxTokens <= 0 {
		return []ContextMessage{}
	}
	accepted := make([]ContextMessage, 0, len(messages))
	charCount, tokenUpperBound := 2, 2
	for _, message := range messages {
		encoded, err := json.Marshal(message)
		if err != nil {
			break
		}
		separator := 0
		if len(accepted) > 0 {
			separator = 1
		}
		nextChars := len(string(encoded)) + separator
		nextTokens := len(encoded) + separator
		if charCount+nextChars > maxChars || tokenUpperBound+nextTokens > maxTokens {
			break
		}
		accepted = append(accepted, message)
		charCount += nextChars
		tokenUpperBound += nextTokens
	}
	for left, right := 0, len(accepted)-1; left < right; left, right = left+1, right-1 {
		accepted[left], accepted[right] = accepted[right], accepted[left]
	}
	return accepted
}

var forgedFields = map[string]struct{}{
	"actorId": {}, "ownerId": {}, "ownerUserId": {}, "role": {}, "kind": {}, "capability": {}, "authorId": {}, "authorKind": {},
}

func RejectForgedFields(input map[string]any) error {
	for field := range forgedFields {
		if _, ok := input[field]; ok {
			return NewError(CodeGatewayActorForbidden, MessageActorForbidden, 400)
		}
	}
	return nil
}

func (s *Service) SendMessage(ctx context.Context, value *Auth, input SendMessageInput) (SendMessageResult, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return SendMessageResult{}, err
	}
	if err := RequireScope(current, ScopeMessagesSend); err != nil {
		return SendMessageResult{}, err
	}
	if err := RejectForgedFields(input.Fields); err != nil {
		return SendMessageResult{}, err
	}
	_, conversation, err := s.requireConversationCurrent(ctx, current, input.ConversationID)
	if err != nil {
		return SendMessageResult{}, err
	}
	clientMessageID, err := normalizeIdentifier(firstNonEmpty(input.ClientMessageID, input.IdempotencyKey), CodeMessageInvalid)
	if err != nil {
		return SendMessageResult{}, err
	}
	key, err := normalizeIdentifier(firstNonEmpty(input.IdempotencyKey, clientMessageID), CodeIdempotencyInvalid)
	if err != nil {
		return SendMessageResult{}, err
	}
	replyTo := ""
	if reply, present := input.Fields["replyToMessageId"]; input.ReplyToMessageID != "" || present && reply != nil {
		replyTo, err = normalizeIdentifier(input.ReplyToMessageID, CodeMessageInvalidReply)
		if err != nil {
			return SendMessageResult{}, err
		}
	}
	content, err := normalizeBotInputContent(input)
	if err != nil {
		return SendMessageResult{}, err
	}
	if s.messageWriter == nil {
		return SendMessageResult{}, NewError(CodeMessageUnavailable, MessageInternal, 503)
	}
	request := MessageWriteRequest{ActorID: current.UserID, SpaceID: current.SpaceID, ConversationID: conversation.ID, ClientMessageID: clientMessageID, ReplyToMessageID: replyTo, Content: content, Meta: input.Meta.Safe()}
	var hashReplyTo *string
	if replyTo != "" {
		reply := replyTo
		hashReplyTo = &reply
	}
	encodedInput := messageIdempotencyInput{
		ConversationID: conversation.ID, ClientMessageID: clientMessageID,
		ReplyToMessageID: hashReplyTo, Content: content,
	}
	result, err := s.withIdempotency(ctx, current, "message.send", key, encodedInput, func(tx Tx) (any, error) {
		var message GatewayMessage
		var writeErr error
		if writer, ok := s.messageWriter.(TransactionalMessageWriter); ok {
			message, writeErr = writer.CreateBotMessageInTx(ctx, tx, request)
		} else {
			message, writeErr = s.messageWriter.CreateBotMessage(ctx, request)
		}
		if writeErr != nil {
			return nil, normalizeError(writeErr)
		}
		return SendMessageResult{Message: projectCreatedMessage(message), ClientMessageID: clientMessageID}, nil
	})
	if err != nil {
		return SendMessageResult{}, err
	}
	return coerceSendMessageResult(result)
}

func normalizeBotContent(value any, text string) (MessageContent, error) {
	if value == nil {
		value = text
	}
	if stringValue, ok := value.(string); ok {
		stringValue = nodeTrimSpace(stringValue)
		if stringValue == "" || !utf8.ValidString(stringValue) || nodeStringLength(stringValue) > MaxMessageTextRunes {
			return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
		}
		return MessageContent{Format: MessageContentFormat, PlainText: stringValue, Blocks: []map[string]any{{"type": "text", "text": stringValue}}}, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
	}
	var object map[string]any
	if json.Unmarshal(encoded, &object) != nil || object == nil {
		return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
	}
	if object["format"] != MessageContentFormat {
		return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
	}
	plainText, ok := object["plainText"].(string)
	plainText = nodeTrimSpace(plainText)
	if !ok || plainText == "" || !utf8.ValidString(plainText) || nodeStringLength(plainText) > MaxMessageTextRunes {
		return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
	}
	rawBlocks, ok := object["blocks"].([]any)
	if !ok || len(rawBlocks) == 0 {
		return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
	}
	blocks := make([]map[string]any, 0, len(rawBlocks))
	for _, rawBlock := range rawBlocks {
		block, ok := rawBlock.(map[string]any)
		if !ok {
			return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
		}
		blocks = append(blocks, block)
	}
	return MessageContent{Format: MessageContentFormat, PlainText: plainText, Blocks: blocks}, nil
}

func projectCreatedMessage(message GatewayMessage) GatewayMessage {
	return message
}

func coerceSendMessageResult(value any) (SendMessageResult, error) {
	if result, ok := value.(SendMessageResult); ok {
		return result, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return SendMessageResult{}, internalError("decode gateway message response", err)
	}
	var result SendMessageResult
	if err := json.Unmarshal(encoded, &result); err != nil {
		return SendMessageResult{}, internalError("decode gateway message response", err)
	}
	return result, nil
}

func (s *Service) SendCard(ctx context.Context, value *Auth, input SendCardInput) (SendCardResult, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return SendCardResult{}, err
	}
	if err := RequireScope(current, ScopeCardsWrite); err != nil {
		return SendCardResult{}, err
	}
	if err := RejectForgedFields(input.Fields); err != nil {
		return SendCardResult{}, err
	}
	if err := rejectOpaqueCardCreateFields(input.Fields); err != nil {
		return SendCardResult{}, err
	}
	_, conversation, err := s.requireConversationCurrent(ctx, current, input.ConversationID)
	if err != nil {
		return SendCardResult{}, err
	}
	clientMessageID, err := normalizeIdentifier(firstNonEmpty(input.ClientMessageID, input.IdempotencyKey), CodeMessageInvalid)
	if err != nil {
		return SendCardResult{}, err
	}
	key, err := normalizeIdentifier(firstNonEmpty(input.IdempotencyKey, clientMessageID), CodeIdempotencyInvalid)
	if err != nil {
		return SendCardResult{}, err
	}
	converted, err := normalizeGatewayCardCreate(input)
	if err != nil {
		return SendCardResult{}, s.recordCardRejection(ctx, current, input.Meta, "bot.gateway.card.send", current.BotID, err)
	}
	if s.cardGateway == nil || s.messageWriter == nil {
		return SendCardResult{}, NewError(CodeCardUnavailable, MessageCardUnavailable, 503)
	}
	_, cardTransactional := s.cardGateway.(TransactionalCardGateway)
	_, messageTransactional := s.messageWriter.(TransactionalMessageWriter)
	if cardTransactional != messageTransactional {
		return SendCardResult{}, internalError("send bot card", errors.New("card and message transactional writers must be configured together"))
	}
	request := CardCreateRequest{ActorID: current.UserID, BotID: current.BotID, BotUserID: current.UserID, SpaceID: current.SpaceID, ConversationID: conversation.ID, SourceID: opaqueCardSourceID(current.BotID, key), CardType: converted.CardType, SchemaVersion: converted.SchemaVersion, FallbackText: converted.FallbackText, Payload: converted.Payload, RawPayload: cloneRawJSON(converted.RawPayload), Meta: input.Meta.Safe()}
	encodedInput := cardIdempotencyInput{
		ConversationID: conversation.ID,
		CardType:       converted.CardType, SchemaVersion: converted.SchemaVersion, FallbackText: converted.FallbackText, Payload: converted.Payload,
		HashFallbackJSON: converted.HashFallbackJSON,
	}
	if converted.Feishu {
		// Feishu hashes the converter's safe, ordered output. The caller's
		// source bytes never enter persistence or the request hash.
		encodedInput.RawPayload = converted.RawPayload
	} else if converted.NativePayloadPresent {
		// Preserve the established native-card request hash behavior. This raw
		// value is hash-only; the cards adapter receives the normalized value.
		encodedInput.RawPayload = input.RawPayload
	}
	result, err := s.withIdempotency(ctx, current, "card.send", key, encodedInput, func(tx Tx) (any, error) {
		var card Card
		var cardErr error
		if gateway, ok := s.cardGateway.(TransactionalCardGateway); ok {
			card, cardErr = gateway.CreateCustomBotCardInTx(ctx, tx, request)
		} else {
			card, cardErr = s.cardGateway.CreateCustomBotCard(ctx, request)
		}
		if cardErr != nil {
			return nil, normalizeError(cardErr)
		}
		block := card.Block
		if block == nil {
			block = map[string]any{"type": "card", "cardId": card.ID, "cardType": card.CardType, "schemaVersion": card.SchemaVersion, "fallbackText": card.FallbackText}
		}
		messageRequest := MessageWriteRequest{ActorID: current.UserID, SpaceID: current.SpaceID, ConversationID: conversation.ID, ClientMessageID: clientMessageID, Content: MessageContent{Format: MessageContentFormat, PlainText: converted.FallbackText, Blocks: []map[string]any{block}}, Meta: input.Meta.Safe()}
		if _, transactional := s.cardGateway.(TransactionalCardGateway); transactional {
			validator, ok := s.cardGateway.(TransactionalCardReferenceValidator)
			if !ok {
				return nil, internalError("validate bot card reference", errors.New("transactional card reference validator is required"))
			}
			if err := validator.ValidateMessageCardReferenceInTx(ctx, tx, current.UserID, conversation.ID, block); err != nil {
				return nil, normalizeError(err)
			}
		} else if err := s.cardGateway.ValidateMessageCardReference(ctx, current.UserID, conversation.ID, block); err != nil {
			return nil, normalizeError(err)
		}
		var message GatewayMessage
		if writer, ok := s.messageWriter.(TransactionalMessageWriter); ok {
			message, err = writer.CreateBotMessageInTx(ctx, tx, messageRequest)
		} else {
			message, err = s.messageWriter.CreateBotMessage(ctx, messageRequest)
		}
		if err != nil {
			return nil, normalizeError(err)
		}
		return SendCardResult{Card: card, Message: projectCreatedMessage(message)}, nil
	})
	if err != nil {
		return SendCardResult{}, err
	}
	return coerceSendCardResult(result)
}

func rejectOpaqueCardCreateFields(fields map[string]any) error {
	for _, field := range []string{"cardId", "sourceKind", "sourceId", "visibilityScope", "resourceType", "resourceId", "createdByUserId", "ownerUserId", "botUserId", "botId", "spaceId"} {
		if _, ok := fields[field]; ok {
			return NewError(CodeCardImmutableField, "卡片来源或范围由服务端决定", 400)
		}
	}
	return nil
}

func coerceSendCardResult(value any) (SendCardResult, error) {
	if result, ok := value.(SendCardResult); ok {
		return result, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return SendCardResult{}, internalError("decode gateway card response", err)
	}
	var result SendCardResult
	if err := json.Unmarshal(encoded, &result); err != nil {
		return SendCardResult{}, internalError("decode gateway card response", err)
	}
	return result, nil
}

func rejectImmutableCardFields(fields map[string]any) error {
	for _, field := range []string{"cardType", "schemaVersion", "spaceId", "conversationId", "sourceKind", "sourceId", "visibilityScope", "resourceType", "resourceId", "createdByUserId", "ownerUserId", "botUserId", "botId"} {
		if _, ok := fields[field]; ok {
			return NewError(CodeCardImmutableField, "卡片来源或范围不可修改", 400)
		}
	}
	return nil
}

type normalizedGatewayCard struct {
	CardType             string
	SchemaVersion        int
	FallbackText         string
	Payload              any
	RawPayload           json.RawMessage
	HashFallbackJSON     json.RawMessage
	Feishu               bool
	NativePayloadPresent bool
}

func normalizeGatewayCardCreate(input SendCardInput) (normalizedGatewayCard, error) {
	if gatewayCardUsesFeishu(input.Format, input.Fields, input.RawFeishuCard, input.FeishuCard) {
		if fieldOrValuePresent(input.Fields, "cardType", input.CardType) {
			cardType, typeErr := normalizeCardType(input.CardType)
			if typeErr != nil {
				return normalizedGatewayCard{}, typeErr
			}
			if cardType != feishucards.CardType {
				return normalizedGatewayCard{}, NewError("card.type_mismatch", "飞书卡片类型无效", 400)
			}
		}
		if fieldOrValuePresent(input.Fields, "schemaVersion", input.SchemaVersion) {
			version, versionErr := normalizeCardVersion(input.SchemaVersion)
			if versionErr != nil {
				return normalizedGatewayCard{}, versionErr
			}
			if version != feishucards.SchemaVersion {
				return normalizedGatewayCard{}, NewError("card.type_mismatch", "飞书卡片版本无效", 400)
			}
		}
		converted, err := convertGatewayFeishuCard(input.RawFeishuCard, input.RawPayload, input.FeishuCard, input.Payload)
		if err != nil {
			return normalizedGatewayCard{}, err
		}
		fallback := converted.FallbackText
		hashFallbackJSON := cloneRawJSON(converted.CanonicalFallbackJSON)
		if fieldOrValuePresent(input.Fields, "fallbackText", input.FallbackText) || input.RawFallbackText != nil {
			if input.RawFallbackText != nil {
				fallback, hashFallbackJSON, err = normalizeRawFallbackJSON(input.RawFallbackText)
			} else {
				fallback, err = normalizeFallback(input.FallbackText)
				if err == nil {
					hashFallbackJSON, err = nodeJSONMarshal(fallback)
				}
			}
			if err != nil {
				return normalizedGatewayCard{}, err
			}
		}
		return normalizedGatewayCard{
			CardType: feishucards.CardType, SchemaVersion: feishucards.SchemaVersion,
			FallbackText: fallback, Payload: converted.Payload,
			RawPayload: cloneRawJSON(converted.PayloadJSON), HashFallbackJSON: hashFallbackJSON, Feishu: true,
		}, nil
	}

	cardType, err := normalizeCardType(input.CardType)
	if err != nil {
		return normalizedGatewayCard{}, err
	}
	version, err := normalizeCardVersion(input.SchemaVersion)
	if err != nil {
		return normalizedGatewayCard{}, err
	}
	fallback, err := normalizeFallback(input.FallbackText)
	if err != nil {
		return normalizedGatewayCard{}, err
	}
	payloadValue := input.Payload
	if len(input.RawPayload) > 0 {
		if json.Unmarshal(input.RawPayload, &payloadValue) != nil {
			return normalizedGatewayCard{}, NewError(CodeCardInvalidPayload, "卡片内容无效", 422)
		}
	}
	payload, err := normalizeCardPayload(payloadValue)
	if err != nil {
		return normalizedGatewayCard{}, err
	}
	return normalizedGatewayCard{
		CardType: cardType, SchemaVersion: version, FallbackText: fallback,
		Payload: payload, NativePayloadPresent: payloadValue != nil,
	}, nil
}

func normalizeGatewayCardUpdate(input UpdateCardInput) (normalizedGatewayCard, error) {
	converted, err := convertGatewayFeishuCard(input.RawFeishuCard, input.RawPayload, input.FeishuCard, input.Payload)
	if err != nil {
		return normalizedGatewayCard{}, err
	}
	fallback := converted.FallbackText
	if fieldPresent(input.Fields, "fallbackText") || input.RawFallbackText != nil {
		if input.RawFallbackText != nil {
			fallback, _, err = normalizeRawFallbackJSON(input.RawFallbackText)
		} else {
			fallback, err = normalizeFallback(input.Fields["fallbackText"])
		}
	} else if input.FallbackText != nil {
		fallback, err = normalizeFallback(*input.FallbackText)
	}
	if err != nil {
		return normalizedGatewayCard{}, err
	}
	return normalizedGatewayCard{
		CardType: feishucards.CardType, SchemaVersion: feishucards.SchemaVersion,
		FallbackText: fallback, Payload: converted.Payload,
		RawPayload: cloneRawJSON(converted.PayloadJSON), Feishu: true,
	}, nil
}

func gatewayCardUsesFeishu(format string, fields map[string]any, rawFeishuCard json.RawMessage, feishuCard any) bool {
	return len(rawFeishuCard) > 0 || fieldPresent(fields, "feishuCard") || feishuCard != nil || format == "feishu-card"
}

func fieldPresent(fields map[string]any, key string) bool {
	_, ok := fields[key]
	return ok
}

func fieldOrValuePresent(fields map[string]any, key string, value any) bool {
	return fieldPresent(fields, key) || value != nil
}

func isJSONNull(raw json.RawMessage) bool {
	return len(raw) > 0 && bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func convertGatewayFeishuCard(rawFeishuCard, rawPayload json.RawMessage, feishuCard, payload any) (feishucards.Result, error) {
	var (
		result feishucards.Result
		err    error
	)
	switch {
	case len(rawFeishuCard) > 0 && !isJSONNull(rawFeishuCard):
		result, err = feishucards.ConvertJSON(rawFeishuCard)
	case len(rawFeishuCard) > 0 && len(rawPayload) > 0:
		// JS uses nullish coalescing: an explicit null Feishu value falls
		// through to payload, but a non-null payload value remains exact raw
		// JSON for ordered conversion.
		result, err = feishucards.ConvertJSON(rawPayload)
	case len(rawFeishuCard) > 0:
		result, err = feishucards.Convert(payload)
	case feishuCard != nil:
		result, err = feishucards.Convert(feishuCard)
	case len(rawPayload) > 0:
		result, err = feishucards.ConvertJSON(rawPayload)
	default:
		result, err = feishucards.Convert(payload)
	}
	if err == nil {
		return result, nil
	}
	var validation *feishucards.ValidationError
	if errors.As(err, &validation) {
		return feishucards.Result{}, NewError(validation.Code, validation.Message, 422)
	}
	return feishucards.Result{}, NewError(CodeCardInvalidPayload, "卡片内容无效", 422)
}

func normalizeCardType(value any) (string, error) {
	stringValue, ok := value.(string)
	if !ok {
		return "", NewError(CodeCardInvalidType, "卡片类型无效", 400)
	}
	stringValue = strings.ToLower(strings.TrimSpace(stringValue))
	if !cardTypePattern.MatchString(stringValue) {
		return "", NewError(CodeCardInvalidType, "卡片类型无效", 400)
	}
	return stringValue, nil
}

func normalizeCardVersion(value any) (int, error) {
	var result int64
	switch typed := value.(type) {
	case int:
		result = int64(typed)
	case int64:
		result = typed
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || math.Trunc(typed) != typed || typed < 1 || typed > 1_000_000 {
			return 0, NewError(CodeCardInvalidVersion, "卡片版本无效", 400)
		}
		result = int64(typed)
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, NewError(CodeCardInvalidVersion, "卡片版本无效", 400)
		}
		result = parsed
	default:
		return 0, NewError(CodeCardInvalidVersion, "卡片版本无效", 400)
	}
	if result < 1 || result > 1_000_000 {
		return 0, NewError(CodeCardInvalidVersion, "卡片版本无效", 400)
	}
	return int(result), nil
}

func normalizeFallback(value any) (string, error) {
	stringValue, ok := value.(string)
	if !ok {
		return "", NewError(CodeCardInvalidFallback, "卡片降级文本无效", 400)
	}
	stringValue = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, stringValue))
	if stringValue == "" || !utf8.ValidString(stringValue) || len([]byte(stringValue)) > 16_000 || htmlPattern.MatchString(stringValue) {
		return "", NewError(CodeCardInvalidFallback, "卡片降级文本无效", 400)
	}
	return stringValue, nil
}

func normalizeCardPayload(value any) (any, error) {
	if value == nil {
		value = map[string]any{}
	}
	result, err := workspacecards.NormalizeCardPayload(value, workspacecards.Limits{MaxPayloadBytes: 64 * 1024, MaxDepth: 8, MaxNodes: 200, MaxTextBytes: 16 * 1024}, false)
	if err == nil {
		return result, nil
	}
	var validation *workspacecards.CardValidationError
	if errors.As(err, &validation) {
		status := 422
		return nil, NewError(validation.Code, validation.Message, status)
	}
	return nil, NewError(CodeCardInvalidPayload, "卡片内容无效", 422)
}

func opaqueCardSourceID(botID, key string) string {
	digest := sha256.Sum256([]byte(botID + ":" + key))
	return "botkey_" + hex.EncodeToString(digest[:])[:48]
}

func (s *Service) UpdateCard(ctx context.Context, value *Auth, cardID string, input UpdateCardInput) (map[string]any, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	if err := RequireScope(current, ScopeCardsWrite); err != nil {
		return nil, err
	}
	if err := RejectForgedFields(input.Fields); err != nil {
		return nil, err
	}
	if err := rejectImmutableCardFields(input.Fields); err != nil {
		return nil, err
	}
	id, err := normalizeIdentifier(cardID, CodeCardInvalidID)
	if err != nil {
		return nil, err
	}
	if s.cardGateway == nil {
		return nil, NewError(CodeCardUnavailable, MessageCardUnavailable, 503)
	}
	request := CardUpdateRequest{ActorID: current.UserID, BotID: current.BotID, BotUserID: current.UserID, SpaceID: current.SpaceID, CardID: id, ExpectedRevision: input.ExpectedRevision, Payload: input.Payload, FallbackText: input.FallbackText, Status: input.Status, Meta: input.Meta.Safe()}
	if input.Status != "" && input.Status != "active" {
		card, err := s.cardGateway.InvalidateCustomBotCard(ctx, request)
		if err != nil {
			return nil, normalizeError(err)
		}
		return map[string]any{"card": card}, nil
	}
	if gatewayCardUsesFeishu(input.Format, input.Fields, input.RawFeishuCard, input.FeishuCard) {
		checker, ok := s.cardGateway.(interface {
			CheckFeishuCardOwner(context.Context, string, string, string) error
		})
		if !ok {
			return nil, s.recordCardRejection(ctx, current, input.Meta, "bot.gateway.card.update", id, internalError("check Feishu card owner", errors.New("card owner checker is required")))
		}
		if err := checker.CheckFeishuCardOwner(ctx, current.SpaceID, id, current.UserID); err != nil {
			return nil, s.recordCardRejection(ctx, current, input.Meta, "bot.gateway.card.update", id, err)
		}
		converted, err := normalizeGatewayCardUpdate(input)
		if err != nil {
			return nil, s.recordCardRejection(ctx, current, input.Meta, "bot.gateway.card.update", id, err)
		}
		fallback := converted.FallbackText
		request.Payload = converted.Payload
		request.RawPayload = cloneRawJSON(converted.RawPayload)
		request.FallbackText = &fallback
		card, err := s.cardGateway.UpdateCustomBotCard(ctx, request)
		if err != nil {
			return nil, normalizeError(err)
		}
		return map[string]any{"card": card}, nil
	}
	if input.Payload != nil {
		payload, err := normalizeCardPayload(input.Payload)
		if err != nil {
			return nil, s.recordCardRejection(ctx, current, input.Meta, "bot.gateway.card.update", id, err)
		}
		request.Payload = payload
	}
	card, err := s.cardGateway.UpdateCustomBotCard(ctx, request)
	if err != nil {
		return nil, normalizeError(err)
	}
	return map[string]any{"card": card}, nil
}

func (s *Service) GetAttachment(ctx context.Context, value *Auth, attachmentID string) (map[string]any, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	if err := RequireScope(current, ScopeFilesReadMetadata); err != nil {
		return nil, err
	}
	id, err := normalizeIdentifier(attachmentID, CodeAttachmentInvalid)
	if err != nil {
		return nil, err
	}
	row, err := s.repo.GetAttachment(ctx, current.SpaceID, id)
	if err != nil {
		return nil, normalizeError(err)
	}
	if row == nil {
		return nil, NewError(CodeAttachmentNotFound, MessageAttachmentNotFound, 404)
	}
	if row.ConversationID != nil && strings.TrimSpace(*row.ConversationID) != "" {
		active, err := s.repo.ConversationMemberActive(ctx, current.SpaceID, *row.ConversationID, current.UserID)
		if err != nil {
			return nil, normalizeError(err)
		}
		if !active {
			return nil, NewError(CodeAttachmentNotFound, MessageAttachmentNotFound, 404)
		}
	}
	return map[string]any{"attachment": projectAttachment(*row)}, nil
}

func (s *Service) CreateAttachment(ctx context.Context, value *Auth, input CreateAttachmentInput) (map[string]any, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return nil, err
	}
	if err := RequireScope(current, ScopeFilesWrite); err != nil {
		return nil, err
	}
	if err := RejectForgedFields(input.Fields); err != nil {
		return nil, err
	}
	conversationID := strings.TrimSpace(input.ConversationID)
	if conversationID != "" {
		_, _, err := s.requireConversationCurrent(ctx, current, conversationID)
		if err != nil {
			return nil, err
		}
	}
	if s.attachmentWriter == nil {
		return nil, NewError(CodeAttachmentUnavailable, MessageInternal, 503)
	}
	request := AttachmentCreateRequest{ActorID: current.UserID, SpaceID: current.SpaceID, ConversationID: conversationID, FileName: input.FileName, MIMEType: input.MIMEType, ByteSize: input.ByteSize, Visibility: firstNonEmpty(input.Visibility, "private_staging"), Meta: input.Meta.Safe()}
	var result UploadReservation
	if err := func() error {
		var writeErr error
		result, writeErr = s.attachmentWriter.ReserveAttachment(ctx, request)
		return writeErr
	}(); err != nil {
		return nil, normalizeError(err)
	}
	return map[string]any{"upload": result}, nil
}

func (s *Service) Typing(ctx context.Context, value *Auth, conversationID string) (map[string]any, error) {
	current, _, err := s.requireConversationCurrent(ctx, value, conversationID)
	if err != nil {
		return nil, err
	}
	if err := RequireScope(current, ScopeMessagesSend); err != nil {
		return nil, err
	}
	return map[string]any{"accepted": true, "expiresInMs": 5000}, nil
}

func (s *Service) Acknowledge(ctx context.Context, value *Auth, input AcknowledgeInput) (AcknowledgeResult, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return AcknowledgeResult{}, err
	}
	sequence, err := normalizeSequence(input.Sequence, true)
	if err != nil {
		return AcknowledgeResult{}, err
	}
	eventID := strings.TrimSpace(input.EventID)
	if eventID == "" && sequence == 0 {
		return AcknowledgeResult{}, NewError(CodeInvalidAck, MessageInvalidAck, 400)
	}
	var acknowledged bool
	now := s.nowUTC()
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		acknowledged, err = tx.AcknowledgeDelivery(ctx, current.BotID, current.SpaceID, eventID, sequence, now)
		if err != nil {
			return err
		}
		return tx.MarkProcessed(ctx, current.BotID, current.SpaceID, now)
	})
	if err != nil {
		return AcknowledgeResult{}, normalizeError(err)
	}
	return AcknowledgeResult{Acknowledged: acknowledged, EventID: eventID, Sequence: sequence}, nil
}

func normalizeSequence(value int64, allowZero bool) (int64, error) {
	const maxSafeInteger int64 = (1 << 53) - 1
	if value < 0 || value > maxSafeInteger || (!allowZero && value == 0) {
		return 0, invalidSequenceError()
	}
	return value, nil
}

func (s *Service) Replay(ctx context.Context, value *Auth, input ReplayInput) (ReplayResult, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return ReplayResult{}, err
	}
	cursor, err := normalizeSequence(input.LastSequence, true)
	if err != nil {
		return ReplayResult{}, err
	}
	limit := s.replayLimit
	if input.Limit > 0 && input.Limit < limit {
		limit = input.Limit
	}
	if limit > MaxReplayLimit {
		limit = MaxReplayLimit
	}
	if err := s.expireDeliveries(ctx, current); err != nil {
		return ReplayResult{}, err
	}
	if err := s.queueWorkspaceEvents(ctx, current); err != nil {
		return ReplayResult{}, err
	}
	workspaceSequence, err := s.repo.CurrentSequence(ctx, current.SpaceID)
	if err != nil {
		return ReplayResult{}, normalizeError(err)
	}
	result := ReplayResult{Events: []Delivery{}, CurrentSequence: workspaceSequence}
	if cursor > workspaceSequence {
		result.SyncRequired = true
		result.Reason = "cursor_ahead"
		return result, nil
	}
	candidates, err := s.repo.ListDeliveriesAfter(ctx, current.BotID, current.SpaceID, cursor, s.nowUTC(), limit*4+1)
	if err != nil {
		return ReplayResult{}, normalizeError(err)
	}
	allowed := make([]DeliveryRecord, 0, len(candidates))
	for _, candidate := range candidates {
		event, getErr := s.repo.GetEvent(ctx, current.SpaceID, candidate.EventID)
		if getErr != nil {
			return ReplayResult{}, normalizeError(getErr)
		}
		visible := false
		if event != nil {
			visible, getErr = s.authorizeDelivery(ctx, current, *event)
		}
		if getErr != nil {
			return ReplayResult{}, getErr
		}
		if !visible {
			if expireErr := s.repo.WithTx(ctx, func(tx Tx) error { return tx.ExpireDelivery(ctx, candidate.ID) }); expireErr != nil {
				return ReplayResult{}, normalizeError(expireErr)
			}
			continue
		}
		allowed = append(allowed, candidate)
	}
	earliest, err := s.repo.EarliestDeliverySequence(ctx, current.BotID, current.SpaceID, s.nowUTC())
	if err != nil {
		return ReplayResult{}, normalizeError(err)
	}
	expiredAfter, err := s.hasExpiredAfter(ctx, current, cursor)
	if err != nil {
		return ReplayResult{}, err
	}
	if expiredAfter || (earliest > 0 && cursor < earliest-1) {
		result.SyncRequired = true
		result.Reason = "replay_window_exceeded"
		return result, nil
	}
	result.HasMore = len(allowed) > limit
	if len(allowed) > limit {
		allowed = allowed[:limit]
	}
	for index := range allowed {
		if err := s.repo.WithTx(ctx, func(tx Tx) error {
			return tx.MarkDeliveryDelivered(ctx, allowed[index].ID, s.nowUTC())
		}); err != nil {
			return ReplayResult{}, normalizeError(err)
		}
		allowed[index].Status = "delivered"
		allowed[index].Attempts++
	}
	result.Events = make([]Delivery, 0, len(allowed))
	for _, row := range allowed {
		result.Events = append(result.Events, projectDelivery(row))
	}
	return result, nil
}

func (s *Service) expireDeliveries(ctx context.Context, value *Auth) error {
	now := s.nowUTC()
	err := s.repo.WithTx(ctx, func(tx Tx) error { return tx.ExpireDeliveries(ctx, value.BotID, value.SpaceID, now) })
	if err != nil {
		return normalizeError(err)
	}
	return nil
}

func (s *Service) queueWorkspaceEvents(ctx context.Context, value *Auth) error {
	rows, err := s.repo.ListRecentEvents(ctx, value.SpaceID, s.replayLimit*4)
	if err != nil {
		return normalizeError(err)
	}
	for left, right := 0, len(rows)-1; left < right; left, right = left+1, right-1 {
		rows[left], rows[right] = rows[right], rows[left]
	}
	for _, event := range rows {
		if err := s.queueEvent(ctx, value, event); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) queueEvent(ctx context.Context, value *Auth, event EventRecord) error {
	authorized, err := s.authorizeDelivery(ctx, value, event)
	if err != nil || !authorized {
		return err
	}
	if allowed, err := s.passesDeliveryRateLimits(ctx, value, event); err != nil || !allowed {
		return err
	}
	id, err := s.newID("bot delivery")
	if err != nil {
		return internalError("generate bot delivery id", err)
	}
	now := s.nowUTC()
	input := DeliveryInsert{ID: "bdl_" + id, BotID: value.BotID, SpaceID: value.SpaceID, Sequence: event.Sequence, EventID: event.ID, EventType: event.EventType, ConversationID: event.ConversationID, PayloadJSON: safeDeliveryPayload(event), Status: "queued", CreatedAt: now, ExpiresAt: now.Add(s.replayWindow)}
	return s.repo.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, "workspace-bot-delivery:"+value.BotID+":"+strconv.FormatInt(event.Sequence, 10)); err != nil {
			return err
		}
		_, err := tx.InsertDelivery(ctx, input)
		return err
	})
}

func (s *Service) hasExpiredAfter(ctx context.Context, value *Auth, cursor int64) (bool, error) {
	checker, ok := s.repo.(ExpiredDeliveryLookup)
	if !ok {
		return false, nil
	}
	return checker.HasExpiredDeliveryAfter(ctx, value.BotID, value.SpaceID, cursor, s.nowUTC())
}

// ExpiredDeliveryLookup is optional for small adapters. PostgreSQL implements
// it so replay can distinguish an empty queue from a gap caused by expiry.
type ExpiredDeliveryLookup interface {
	HasExpiredDeliveryAfter(ctx context.Context, botID, spaceID string, afterSequence int64, now time.Time) (bool, error)
}

func eventScope(eventType string) string {
	switch eventType {
	case "message.created", "bot.mentioned":
		return ScopeMessagesReadTrigger
	case "command.invoked":
		return ScopeCommandsReceive
	case "card.action":
		return ScopeCardsAct
	default:
		return ""
	}
}

func (s *Service) AuthorizeDelivery(ctx context.Context, value *Auth, event EventRecord) (bool, error) {
	return s.authorizeDelivery(ctx, value, event)
}

func (s *Service) authorizeDelivery(ctx context.Context, value *Auth, event EventRecord) (bool, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return false, err
	}
	if event.SpaceID != current.SpaceID || eventScope(event.EventType) == "" || !containsScope(current.Scopes, eventScope(event.EventType)) || strings.TrimSpace(event.ConversationID) == "" {
		return false, nil
	}
	_, conversation, err := s.requireConversationCurrent(ctx, current, event.ConversationID)
	if err != nil {
		if isGatewayError(err) {
			return false, nil
		}
		return false, err
	}
	grant, err := s.repo.GetContextGrant(ctx, current.BotID, current.SpaceID, conversation.ID)
	if err != nil {
		return false, normalizeError(err)
	}
	if grant == nil || !grant.AllowTrigger {
		return false, nil
	}
	sender, err := s.repo.GetSender(ctx, current.SpaceID, conversation.ID, event.ActorUserID)
	if err != nil {
		return false, normalizeError(err)
	}
	if sender == nil || sender.Kind != "human" || sender.Role == "auditor" || sender.ID == current.UserID {
		return false, nil
	}
	settings, err := s.repo.GetSettings(ctx, current.BotID, current.SpaceID)
	if err != nil {
		return false, normalizeError(err)
	}
	if settings == nil {
		return false, nil
	}
	visible, err := s.senderVisible(ctx, current, sender.ID, conversation, settings)
	if err != nil || !visible {
		return false, err
	}
	return s.resolveTrigger(ctx, current, event, conversation)
}

func isGatewayError(err error) bool {
	var value *Error
	return errors.As(err, &value) && value.Code != CodeInternal
}

func (s *Service) senderVisible(ctx context.Context, value *Auth, senderID string, conversation *Conversation, settings *Settings) (bool, error) {
	switch settings.VisibilityPolicy {
	case "private":
		return senderID == value.OwnerUserID, nil
	case "space_members":
		return true, nil
	case "groups":
		return conversation.Type == "group", nil
	case "specified_members":
		return s.repo.VisibilityMember(ctx, value.BotID, value.SpaceID, senderID)
	default:
		return false, nil
	}
}

func (s *Service) resolveTrigger(ctx context.Context, value *Auth, event EventRecord, conversation *Conversation) (bool, error) {
	payload := parseObject(event.PayloadJSON)
	switch event.EventType {
	case "message.created":
		message, err := s.repo.GetMessageTrigger(ctx, value.SpaceID, conversation.ID, event.TargetID)
		if err != nil {
			return false, normalizeError(err)
		}
		if message == nil || message.AuthorID != event.ActorUserID || message.DeletedAt != nil || message.RecalledAt != nil {
			return false, nil
		}
		content := parseObject(message.ContentJSON)
		blocks, ok := content["blocks"].([]any)
		if !ok || len(blocks) == 0 || len(blocks) > MaxTriggerBlocks || len([]byte(message.PlainText)) == 0 || len([]byte(message.PlainText)) > MaxTriggerBytes {
			return false, nil
		}
		if conversation.Type == "direct" {
			return true, nil
		}
		for _, raw := range blocks {
			block, ok := raw.(map[string]any)
			if ok && block["type"] == "mention" && block["userId"] == value.UserID {
				return true, nil
			}
		}
		return false, nil
	case "bot.mentioned":
		return eventTargetsBot(value, event, payload), nil
	case "command.invoked":
		if !eventTargetsBot(value, event, payload) {
			return false, nil
		}
		if conversation.Type != "group" {
			return true, nil
		}
		mentioned := false
		if ids, ok := payload["mentionedBotIds"].([]any); ok {
			for _, raw := range ids {
				if raw == value.UserID || raw == value.BotID {
					mentioned = true
				}
			}
		}
		trigger, _ := payload["trigger"].(map[string]any)
		return mentioned || trigger["type"] == "mention", nil
	case "card.action":
		return eventTargetsBot(value, event, payload), nil
	default:
		return false, nil
	}
}

func eventTargetsBot(value *Auth, event EventRecord, payload map[string]any) bool {
	for _, target := range []string{event.TargetID, stringField(payload, "botId"), stringField(payload, "botUserId")} {
		if target == value.BotID || target == value.UserID {
			return true
		}
	}
	return false
}

func eventStringFields(payload map[string]any, keys ...string) map[string]any {
	result := make(map[string]any, len(keys))
	for _, key := range keys {
		if value := stringField(payload, key); value != "" {
			if identifierPattern.MatchString(value) || key == "status" || key == "code" || key == "message" || key == "reason" || key == "direction" {
				result[key] = value
			}
		}
	}
	return result
}

func safeDeliveryPayload(event EventRecord) []byte {
	if event.EventType != "card.action" {
		return []byte(`{}`)
	}
	payload := parseObject(event.PayloadJSON)
	result := eventStringFields(payload, "botId", "botUserId", "cardId", "actionId", "clientActionId")
	if identifierPattern.MatchString(event.ActorUserID) {
		result["actorUserId"] = event.ActorUserID
	}
	data, err := workspacecards.NormalizeCardPayload(payload["data"], workspacecards.Limits{MaxPayloadBytes: MaxDeliveryDataBytes, MaxDepth: MaxDeliveryDataDepth, MaxNodes: MaxDeliveryDataNodes, MaxTextBytes: MaxDeliveryTextBytes}, false)
	if err != nil {
		data = map[string]any{}
	}
	result["data"] = data
	encoded, err := json.Marshal(result)
	if err != nil {
		return []byte(`{}`)
	}
	return encoded
}

func (s *Service) passesDeliveryRateLimits(ctx context.Context, value *Auth, event EventRecord) (bool, error) {
	limits, err := s.repo.GetLimits(ctx, value.BotID, value.SpaceID)
	if err != nil {
		return false, normalizeError(err)
	}
	if limits == nil {
		return false, nil
	}
	now := s.nowUTC()
	recent, err := s.repo.CountRecentDeliveries(ctx, value.BotID, value.SpaceID, now.Add(-time.Minute))
	if err != nil {
		return false, normalizeError(err)
	}
	if limits.RequestsPerMinute > 0 && recent >= limits.RequestsPerMinute {
		return false, nil
	}
	memberDaily, err := s.repo.CountMemberDeliveries(ctx, value.BotID, value.SpaceID, event.ActorUserID, now.Add(-24*time.Hour))
	if err != nil {
		return false, normalizeError(err)
	}
	if limits.MemberDailyRequests > 0 && memberDaily >= limits.MemberDailyRequests {
		return false, nil
	}
	backlog, err := s.repo.CountPendingDeliveries(ctx, value.BotID, value.SpaceID, now)
	if err != nil {
		return false, normalizeError(err)
	}
	return limits.EventBacklogLimit <= 0 || backlog < limits.EventBacklogLimit, nil
}

func (s *Service) recordCardRejection(ctx context.Context, value *Auth, meta auth.RequestMeta, action, targetID string, cause error) error {
	if cause == nil {
		return nil
	}
	domain := normalizeError(cause)
	if domain == nil {
		return cause
	}
	var domainErr *Error
	if !errors.As(domain, &domainErr) {
		return domain
	}
	// The rejected request is returned to the caller. Audit failure is not
	// allowed to replace a safe domain error or expose provider details.
	_ = s.repo.WithTx(ctx, func(tx Tx) error {
		id, err := s.newID("bot gateway audit")
		if err != nil {
			return err
		}
		safe := meta.Safe()
		return tx.WriteAudit(ctx, AuditInput{ID: "aud_" + id, SpaceID: value.SpaceID, ActorUserID: value.UserID, Action: action, TargetType: "workspace.card", TargetID: targetID, Result: "rejected", Reason: domainErr.Code, RequestID: safe.RequestID, IPAddress: safe.IPAddress, UserAgent: safe.UserAgent, CreatedAt: s.nowUTC()})
	})
	return domainErr
}

func (s *Service) withIdempotency(ctx context.Context, value *Auth, operation, key string, input any, callback func(Tx) (any, error)) (any, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("gateway idempotency", errors.New("repository is required"))
	}
	requestHash, err := hashGatewayRequest(input)
	if err != nil {
		return nil, internalError("hash gateway request", err)
	}
	var result any
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, "workspace-bot-idempotency:"+value.BotID+":"+operation+":"+key); err != nil {
			return err
		}
		if err := s.validateIdempotentOperationInTx(ctx, tx, value, operation, false); err != nil {
			return err
		}
		existing, err := tx.GetIdempotency(ctx, value.BotID, operation, key, s.nowUTC())
		if err != nil {
			return err
		}
		if existing != nil {
			if existing.RequestHash != requestHash {
				return NewError(CodeIdempotencyConflict, MessageIdempotencyConflict, 409)
			}
			if err := json.Unmarshal(existing.ResponseJSON, &result); err != nil {
				return internalError("decode gateway idempotency response", err)
			}
			return nil
		}
		result, err = callback(tx)
		if err != nil {
			return err
		}
		// Revalidate immediately before the idempotency row is written. A token
		// can be revoked or lose the operation scope while domain writes are in
		// flight; returning the error here makes the outer repository roll back
		// card/message/event/audit writes together.
		if err := s.validateIdempotentOperationInTx(ctx, tx, value, operation, true); err != nil {
			return err
		}
		responseJSON, err := json.Marshal(result)
		if err != nil {
			return internalError("encode gateway idempotency response", err)
		}
		id, err := s.newID("gateway idempotency")
		if err != nil {
			return internalError("generate gateway idempotency id", err)
		}
		inserted, err := tx.InsertIdempotency(ctx, IdempotencyRecordInput{ID: "bid_" + id, BotID: value.BotID, TokenID: value.TokenID, SpaceID: value.SpaceID, Operation: operation, Key: key, RequestHash: requestHash, ResponseJSON: responseJSON, CreatedAt: s.nowUTC(), ExpiresAt: s.nowUTC().Add(24 * time.Hour)})
		if err != nil {
			return err
		}
		if !inserted {
			winner, err := tx.GetIdempotency(ctx, value.BotID, operation, key, s.nowUTC())
			if err != nil {
				return err
			}
			if winner == nil || winner.RequestHash != requestHash {
				return NewError(CodeIdempotencyConflict, MessageIdempotencyConflict, 409)
			}
			if err := json.Unmarshal(winner.ResponseJSON, &result); err != nil {
				return internalError("decode gateway idempotency winner", err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, normalizeError(err)
	}
	return result, nil
}

func (s *Service) validateIdempotentOperationInTx(ctx context.Context, tx Tx, value *Auth, operation string, lockToken bool) error {
	if tx == nil || value == nil {
		return invalidTokenError()
	}
	var current *Auth
	var err error
	if lockToken {
		if validator, ok := tx.(TransactionalTokenValidator); ok {
			current, err = validator.ValidateTokenForMutation(ctx, value.TokenID, value.BotID, value.SpaceID, s.nowUTC())
		} else {
			current, err = tx.ValidateToken(ctx, value.TokenID, value.BotID, value.SpaceID, s.nowUTC())
		}
	} else {
		current, err = tx.ValidateToken(ctx, value.TokenID, value.BotID, value.SpaceID, s.nowUTC())
	}
	if err != nil {
		return err
	}
	if current == nil || current.TokenID != value.TokenID || current.BotID != value.BotID || current.UserID != value.UserID || current.SpaceID != value.SpaceID || current.Bot.Status != "active" {
		return invalidTokenError()
	}
	scope := ""
	switch operation {
	case "message.send":
		scope = ScopeMessagesSend
	case "card.send":
		scope = ScopeCardsWrite
	}
	if scope != "" {
		if err := RequireScope(current, scope); err != nil {
			return err
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func stringField(value map[string]any, key string) string {
	if value == nil {
		return ""
	}
	text, _ := value[key].(string)
	return strings.TrimSpace(text)
}
