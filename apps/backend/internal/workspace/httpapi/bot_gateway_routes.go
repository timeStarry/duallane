package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bots"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

// BotGatewayService is the transport-facing portion of the Bot Gateway. Bot
// authentication and per-operation authorization remain in botgateway.Service.
type BotGatewayService interface {
	Authenticate(context.Context, string, botgateway.TokenAuthOptions) (*botgateway.Auth, error)
	GetMe(context.Context, *botgateway.Auth) (botgateway.Me, error)
	Acknowledge(context.Context, *botgateway.Auth, botgateway.AcknowledgeInput) (botgateway.AcknowledgeResult, error)
	GetContext(context.Context, *botgateway.Auth, string, map[string]any) (map[string]any, error)
	SendMessage(context.Context, *botgateway.Auth, botgateway.SendMessageInput) (botgateway.SendMessageResult, error)
	SendCard(context.Context, *botgateway.Auth, botgateway.SendCardInput) (botgateway.SendCardResult, error)
	UpdateCard(context.Context, *botgateway.Auth, string, botgateway.UpdateCardInput) (map[string]any, error)
	GetAttachment(context.Context, *botgateway.Auth, string) (map[string]any, error)
	CreateAttachment(context.Context, *botgateway.Auth, botgateway.CreateAttachmentInput) (map[string]any, error)
	Typing(context.Context, *botgateway.Auth, string) (map[string]any, error)
}

// BotGatewaySetupService is intentionally separate from BotGatewayService:
// setup is unauthenticated until the owner approves the short-lived session.
type BotGatewaySetupService interface {
	RequestSetup(context.Context, bots.RequestSetupInput) (bots.SetupSession, error)
	GetSetupStatus(context.Context, bots.SetupStatusInput) (bots.SetupSession, error)
	ExchangeSetupSession(context.Context, bots.ExchangeSetupInput) (struct {
		Token   bots.IssuedToken
		Session bots.SetupSession
	}, error)
}

// BotGatewayRouteOptions contains only the transport dependencies and the
// request-scoped space resolution needed by the gateway boundary. The caller
// must pass the exact Workspace gate result in WorkspaceEnabled.
type BotGatewayRouteOptions struct {
	Gateway          BotGatewayService
	Setup            BotGatewaySetupService
	WorkspaceEnabled bool
	ResolveSpaceID   func(*http.Request) (string, error)
	TrustProxy       bool
}

var (
	_ = BotGatewayService((*botgateway.Service)(nil))
	_ = BotGatewaySetupService((*bots.Service)(nil))
)

// registerBotGatewayRoutes registers the external-agent REST surface. The
// WebSocket transport is intentionally owned by the realtime adapter.
func registerBotGatewayRoutes(router chi.Router, options BotGatewayRouteOptions) {
	router.Get("/api/bot-gateway/v1/me", withBotGatewayAuth(options, func(response http.ResponseWriter, request *http.Request, value *botgateway.Auth) {
		result, err := options.Gateway.GetMe(request.Context(), value)
		writeResult(response, http.StatusOK, result, err)
	}))
	router.Post("/api/bot-gateway/v1/events/ack", withBotGatewayAuth(options, func(response http.ResponseWriter, request *http.Request, value *botgateway.Auth) {
		fields, ok := decodeBotGatewayObject(response, request)
		if !ok {
			return
		}
		sequence, _ := objectFieldInt64(fields, "sequence")
		result, err := options.Gateway.Acknowledge(request.Context(), value, botgateway.AcknowledgeInput{
			EventID: objectFieldString(fields, "eventId"), Sequence: sequence,
		})
		writeResult(response, http.StatusOK, result, err)
	}))
	router.Get("/api/bot-gateway/v1/conversations/{conversationId}/context", withBotGatewayAuth(options, func(response http.ResponseWriter, request *http.Request, value *botgateway.Auth) {
		result, err := options.Gateway.GetContext(request.Context(), value, chi.URLParam(request, "conversationId"), botGatewayQuery(request))
		writeResult(response, http.StatusOK, result, err)
	}))
	router.Post("/api/bot-gateway/v1/messages", withBotGatewayAuth(options, func(response http.ResponseWriter, request *http.Request, value *botgateway.Auth) {
		fields, ok := decodeBotGatewayValues(response, request)
		if !ok {
			return
		}
		result, err := options.Gateway.SendMessage(request.Context(), value, botGatewayMessageInput(fields, botGatewayMeta(request, options)))
		writeResult(response, http.StatusCreated, result, err)
	}))
	router.Post("/api/bot-gateway/v1/cards", withBotGatewayAuth(options, func(response http.ResponseWriter, request *http.Request, value *botgateway.Auth) {
		fields, ok := decodeBotGatewayValues(response, request)
		if !ok {
			return
		}
		result, err := options.Gateway.SendCard(request.Context(), value, botGatewayCardInput(fields, botGatewayMeta(request, options)))
		writeResult(response, http.StatusCreated, result, err)
	}))
	router.Patch("/api/bot-gateway/v1/cards/{cardId}", withBotGatewayAuth(options, func(response http.ResponseWriter, request *http.Request, value *botgateway.Auth) {
		fields, ok := decodeBotGatewayValues(response, request)
		if !ok {
			return
		}
		input, valid := botGatewayCardUpdateInput(fields, botGatewayMeta(request, options))
		if !valid {
			writeError(response, invalidBotGatewayRequest())
			return
		}
		result, err := options.Gateway.UpdateCard(request.Context(), value, chi.URLParam(request, "cardId"), input)
		writeResult(response, http.StatusOK, result, err)
	}))
	router.Get("/api/bot-gateway/v1/attachments/{attachmentId}", withBotGatewayAuth(options, func(response http.ResponseWriter, request *http.Request, value *botgateway.Auth) {
		result, err := options.Gateway.GetAttachment(request.Context(), value, chi.URLParam(request, "attachmentId"))
		writeResult(response, http.StatusOK, result, err)
	}))
	router.Post("/api/bot-gateway/v1/attachments", withBotGatewayAuth(options, func(response http.ResponseWriter, request *http.Request, value *botgateway.Auth) {
		fields, ok := decodeBotGatewayValues(response, request)
		if !ok {
			return
		}
		result, err := options.Gateway.CreateAttachment(request.Context(), value, botGatewayAttachmentInput(fields, botGatewayMeta(request, options)))
		writeResult(response, http.StatusCreated, result, err)
	}))
	router.Post("/api/bot-gateway/v1/typing", withBotGatewayAuth(options, func(response http.ResponseWriter, request *http.Request, value *botgateway.Auth) {
		fields, ok := decodeBotGatewayValues(response, request)
		if !ok {
			return
		}
		result, err := options.Gateway.Typing(request.Context(), value, objectFieldString(fields, "conversationId"))
		writeResult(response, http.StatusOK, result, err)
	}))

	router.Post("/api/bot-gateway/v1/setup/request", withBotGatewaySetup(options, func(response http.ResponseWriter, request *http.Request) {
		fields, ok := decodeBotGatewayObject(response, request)
		if !ok {
			return
		}
		input, valid := botGatewaySetupRequestInput(fields, botGatewayMeta(request, options))
		if !valid {
			writeError(response, invalidBotGatewayRequest())
			return
		}
		result, err := options.Setup.RequestSetup(request.Context(), input)
		writeResult(response, http.StatusOK, map[string]any{"setup": result}, err)
	}))
	router.Get("/api/bot-gateway/v1/setup/status", withBotGatewaySetup(options, func(response http.ResponseWriter, request *http.Request) {
		result, err := options.Setup.GetSetupStatus(request.Context(), bots.SetupStatusInput{
			SetupID: request.URL.Query().Get("setupSessionId"), Meta: botGatewayMeta(request, options),
		})
		writeResult(response, http.StatusOK, map[string]any{"setup": result}, err)
	}))
	router.Post("/api/bot-gateway/v1/setup/exchange", withBotGatewaySetup(options, func(response http.ResponseWriter, request *http.Request) {
		fields, ok := decodeBotGatewayObject(response, request)
		if !ok {
			return
		}
		input, valid := botGatewaySetupExchangeInput(fields, botGatewayMeta(request, options))
		if !valid {
			writeError(response, invalidBotGatewayRequest())
			return
		}
		result, err := options.Setup.ExchangeSetupSession(request.Context(), input)
		if err != nil {
			writeError(response, err)
			return
		}
		// Raw is generated by the setup exchange and is never part of a setup
		// status response or a persisted token record.
		if strings.TrimSpace(result.Token.Raw) == "" {
			writeError(response, internalError())
			return
		}
		writeJSON(response, http.StatusCreated, map[string]any{
			"token": result.Token.Raw, "tokenRecord": result.Token.Token, "session": result.Session,
		})
	}))
}

type botGatewayAuthHandler func(http.ResponseWriter, *http.Request, *botgateway.Auth)

func withBotGatewayAuth(options BotGatewayRouteOptions, handler botGatewayAuthHandler) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !options.WorkspaceEnabled {
			writeError(response, workspaceDisabledError())
			return
		}
		if missingService(response, options.Gateway) {
			return
		}
		authorization := request.Header.Get("Authorization")
		// The domain also accepts a raw token for trusted adapters. HTTP only
		// accepts the Bearer envelope; cookies and query parameters are not Bot credentials.
		if !strings.HasPrefix(authorization, "Bearer") {
			writeError(response, botgateway.NewError(botgateway.CodeInvalidToken, botgateway.MessageInvalidToken, http.StatusUnauthorized))
			return
		}
		if _, err := botgateway.ExtractBearerToken(authorization); err != nil {
			writeError(response, err)
			return
		}
		spaceID, err := botGatewaySpaceID(request, options)
		if err != nil {
			writeError(response, err)
			return
		}
		value, err := options.Gateway.Authenticate(request.Context(), authorization, botgateway.TokenAuthOptions{SpaceID: spaceID})
		if err != nil {
			writeError(response, err)
			return
		}
		if value == nil {
			writeError(response, botgateway.NewError(botgateway.CodeInvalidToken, botgateway.MessageInvalidToken, http.StatusUnauthorized))
			return
		}
		handler(response, request, value)
	}
}

type botGatewaySetupHandler func(http.ResponseWriter, *http.Request)

func withBotGatewaySetup(options BotGatewayRouteOptions, handler botGatewaySetupHandler) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !options.WorkspaceEnabled {
			writeError(response, workspaceDisabledError())
			return
		}
		response.Header().Set("Cache-Control", "no-store")
		if missingService(response, options.Setup) {
			return
		}
		handler(response, request)
	}
}

func workspaceDisabledError() *publicError {
	return &publicError{Code: gate.DisabledCode, Message: gate.DisabledMessage, StatusCode: http.StatusServiceUnavailable}
}

func invalidBotGatewayRequest() *publicError {
	return &publicError{Code: botgateway.CodeInvalidRequest, Message: "请求参数无效", StatusCode: http.StatusBadRequest}
}

func botGatewaySpaceID(request *http.Request, options BotGatewayRouteOptions) (string, error) {
	if options.ResolveSpaceID == nil {
		return botgateway.DefaultSpaceID, nil
	}
	return options.ResolveSpaceID(request)
}

func botGatewayMeta(request *http.Request, options BotGatewayRouteOptions) auth.RequestMeta {
	return auth.RequestMetaFromRequest(request, options.TrustProxy)
}

func decodeBotGatewayObject(response http.ResponseWriter, request *http.Request) (map[string]json.RawMessage, bool) {
	var raw json.RawMessage
	if err := decodeJSON(response, request, &raw); err != nil {
		writeError(response, err)
		return nil, false
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return map[string]json.RawMessage{}, true
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil || fields == nil {
		writeError(response, invalidBotGatewayRequest())
		return nil, false
	}
	return fields, true
}

func decodeBotGatewayValues(response http.ResponseWriter, request *http.Request) (map[string]json.RawMessage, bool) {
	return decodeBotGatewayObject(response, request)
}

func botGatewayQuery(request *http.Request) map[string]any {
	values := request.URL.Query()
	result := make(map[string]any, len(values))
	for key, entries := range values {
		if len(entries) == 1 {
			result[key] = entries[0]
		} else {
			result[key] = append([]string(nil), entries...)
		}
	}
	return result
}

func botGatewayFieldValues(fields map[string]json.RawMessage) (map[string]any, bool) {
	values := make(map[string]any, len(fields))
	for key, raw := range fields {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, false
		}
		values[key] = value
	}
	return values, true
}

func botGatewayMessageInput(fields map[string]json.RawMessage, meta auth.RequestMeta) botgateway.SendMessageInput {
	values, _ := botGatewayFieldValues(fields)
	return botgateway.SendMessageInput{
		ConversationID: objectFieldString(fields, "conversationId"), ClientMessageID: objectFieldString(fields, "clientMessageId"),
		IdempotencyKey: objectFieldString(fields, "idempotencyKey"), ReplyToMessageID: objectFieldString(fields, "replyToMessageId"),
		Text: objectFieldString(fields, "text"), Content: objectFieldAny(fields, "content"), Fields: values, Meta: meta,
	}
}

func botGatewayCardInput(fields map[string]json.RawMessage, meta auth.RequestMeta) botgateway.SendCardInput {
	values, _ := botGatewayFieldValues(fields)
	return botgateway.SendCardInput{
		ConversationID: objectFieldString(fields, "conversationId"), ClientMessageID: objectFieldString(fields, "clientMessageId"),
		IdempotencyKey: objectFieldString(fields, "idempotencyKey"), CardType: objectFieldAny(fields, "cardType"),
		SchemaVersion: objectFieldAny(fields, "schemaVersion"), FallbackText: objectFieldAny(fields, "fallbackText"),
		Payload: objectFieldAny(fields, "payload"), Format: objectFieldString(fields, "format"),
		FeishuCard: objectFieldAny(fields, "feishuCard"), Fields: values, Meta: meta,
	}
}

func botGatewayCardUpdateInput(fields map[string]json.RawMessage, meta auth.RequestMeta) (botgateway.UpdateCardInput, bool) {
	fallback, valid := optionalBotGatewayString(fields, "fallbackText")
	if !valid {
		return botgateway.UpdateCardInput{}, false
	}
	return botgateway.UpdateCardInput{
		ExpectedRevision: fieldInt64OrZero(fields, "expectedRevision"), Payload: objectFieldAny(fields, "payload"),
		FallbackText: fallback, Status: objectFieldString(fields, "status"), Format: objectFieldString(fields, "format"),
		FeishuCard: objectFieldAny(fields, "feishuCard"), Fields: mustBotGatewayFieldValues(fields), Meta: meta,
	}, true
}

func botGatewayAttachmentInput(fields map[string]json.RawMessage, meta auth.RequestMeta) botgateway.CreateAttachmentInput {
	return botgateway.CreateAttachmentInput{
		ConversationID: objectFieldString(fields, "conversationId"), FileName: objectFieldString(fields, "fileName"),
		MIMEType: objectFieldString(fields, "mimeType"), ByteSize: fieldInt64OrZero(fields, "byteSize"),
		Visibility: objectFieldString(fields, "visibility"), Fields: mustBotGatewayFieldValues(fields), Meta: meta,
	}
}

func fieldInt64OrZero(fields map[string]json.RawMessage, key string) int64 {
	value, _ := objectFieldInt64(fields, key)
	return value
}

func mustBotGatewayFieldValues(fields map[string]json.RawMessage) map[string]any {
	values, ok := botGatewayFieldValues(fields)
	if !ok {
		return map[string]any{}
	}
	return values
}

func botGatewaySetupRequestInput(fields map[string]json.RawMessage, meta auth.RequestMeta) (bots.RequestSetupInput, bool) {
	if !onlyBotGatewayFields(fields, "setupSessionId", "requestedScopes", "conversationIds", "clientName", "clientVersion", "protocolVersion", "capabilities") {
		return bots.RequestSetupInput{}, false
	}
	setupID, ok := requiredBotGatewayString(fields, "setupSessionId", 0)
	if !ok {
		return bots.RequestSetupInput{}, false
	}
	requestedScopes, ok := optionalBotGatewayStringSlice(fields, "requestedScopes", 10)
	if !ok {
		return bots.RequestSetupInput{}, false
	}
	conversationIDs, ok := optionalBotGatewayStringSlice(fields, "conversationIds", 200)
	if !ok {
		return bots.RequestSetupInput{}, false
	}
	capabilities, ok := optionalBotGatewayStringSlice(fields, "capabilities", 32)
	if !ok {
		return bots.RequestSetupInput{}, false
	}
	clientName, ok := optionalBotGatewayStringLimit(fields, "clientName", 128)
	if !ok {
		return bots.RequestSetupInput{}, false
	}
	clientVersion, ok := optionalBotGatewayStringLimit(fields, "clientVersion", 128)
	if !ok {
		return bots.RequestSetupInput{}, false
	}
	protocolVersion, ok := optionalBotGatewayStringLimit(fields, "protocolVersion", 16)
	if !ok {
		return bots.RequestSetupInput{}, false
	}
	return bots.RequestSetupInput{
		SetupID: setupID, RequestedScopes: requestedScopes, ConversationIDs: conversationIDs,
		ClientName: clientName, ClientVersion: clientVersion, ProtocolVersion: protocolVersion,
		Capabilities: capabilities, Meta: meta,
	}, true
}

func botGatewaySetupExchangeInput(fields map[string]json.RawMessage, meta auth.RequestMeta) (bots.ExchangeSetupInput, bool) {
	if !onlyBotGatewayFields(fields, "setupSessionId", "clientName", "clientVersion", "protocolVersion") {
		return bots.ExchangeSetupInput{}, false
	}
	setupID, ok := requiredBotGatewayString(fields, "setupSessionId", 0)
	if !ok {
		return bots.ExchangeSetupInput{}, false
	}
	clientName, ok := optionalBotGatewayStringLimit(fields, "clientName", 128)
	if !ok {
		return bots.ExchangeSetupInput{}, false
	}
	clientVersion, ok := optionalBotGatewayStringLimit(fields, "clientVersion", 128)
	if !ok {
		return bots.ExchangeSetupInput{}, false
	}
	protocolVersion, ok := optionalBotGatewayStringLimit(fields, "protocolVersion", 16)
	if !ok {
		return bots.ExchangeSetupInput{}, false
	}
	return bots.ExchangeSetupInput{
		SetupID: setupID, ClientName: clientName, ClientVersion: clientVersion,
		ProtocolVersion: protocolVersion, Meta: meta,
	}, true
}

func onlyBotGatewayFields(fields map[string]json.RawMessage, allowed ...string) bool {
	known := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		known[key] = struct{}{}
	}
	for key := range fields {
		if _, ok := known[key]; !ok {
			return false
		}
	}
	return true
}

func requiredBotGatewayString(fields map[string]json.RawMessage, key string, maxRunes int) (string, bool) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil || (maxRunes > 0 && utf8.RuneCountInString(value) > maxRunes) {
		return "", false
	}
	return value, true
}

func optionalBotGatewayStringLimit(fields map[string]json.RawMessage, key string, maxRunes int) (string, bool) {
	value, present := fields[key]
	if !present {
		return "", true
	}
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return "", false
	}
	var result string
	if json.Unmarshal(value, &result) != nil || utf8.RuneCountInString(result) > maxRunes {
		return "", false
	}
	return result, true
}

func optionalBotGatewayString(fields map[string]json.RawMessage, key string) (*string, bool) {
	raw, present := fields[key]
	if !present || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, true
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return nil, false
	}
	return &value, true
}

func optionalBotGatewayStringSlice(fields map[string]json.RawMessage, key string, maxItems int) ([]string, bool) {
	raw, present := fields[key]
	if !present {
		return nil, true
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, false
	}
	var values []string
	if json.Unmarshal(raw, &values) != nil || values == nil || len(values) > maxItems {
		return nil, false
	}
	return values, true
}
