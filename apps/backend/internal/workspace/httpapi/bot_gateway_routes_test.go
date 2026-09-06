package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bots"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type botGatewayRouteFake struct {
	authHeader string
	spaceID    string
	auth       *botgateway.Auth

	ackInput        botgateway.AcknowledgeInput
	contextID       string
	contextOptions  map[string]any
	messageInput    botgateway.SendMessageInput
	cardInput       botgateway.SendCardInput
	updateCardID    string
	updateCardInput botgateway.UpdateCardInput
	attachmentID    string
	attachmentInput botgateway.CreateAttachmentInput
	typingID        string
}

func (f *botGatewayRouteFake) Authenticate(_ context.Context, authorization string, options botgateway.TokenAuthOptions) (*botgateway.Auth, error) {
	f.authHeader = authorization
	f.spaceID = options.SpaceID
	if f.auth == nil {
		f.auth = &botgateway.Auth{TokenID: "token_1", BotID: "bot_1", UserID: "user_1", SpaceID: options.SpaceID}
	}
	return f.auth, nil
}

func (f *botGatewayRouteFake) GetMe(context.Context, *botgateway.Auth) (botgateway.Me, error) {
	return botgateway.Me{Version: botgateway.Version, Bot: map[string]any{"id": "bot_1"}, SpaceID: f.spaceID}, nil
}

func (f *botGatewayRouteFake) Acknowledge(_ context.Context, _ *botgateway.Auth, input botgateway.AcknowledgeInput) (botgateway.AcknowledgeResult, error) {
	f.ackInput = input
	return botgateway.AcknowledgeResult{Acknowledged: true, EventID: input.EventID, Sequence: input.Sequence}, nil
}

func (f *botGatewayRouteFake) GetContext(_ context.Context, _ *botgateway.Auth, conversationID string, options map[string]any) (map[string]any, error) {
	f.contextID = conversationID
	f.contextOptions = options
	return map[string]any{"conversation": map[string]any{"id": conversationID}, "messages": []any{}}, nil
}

func (f *botGatewayRouteFake) SendMessage(_ context.Context, _ *botgateway.Auth, input botgateway.SendMessageInput) (botgateway.SendMessageResult, error) {
	f.messageInput = input
	return botgateway.SendMessageResult{ClientMessageID: input.ClientMessageID}, nil
}

func (f *botGatewayRouteFake) SendCard(_ context.Context, _ *botgateway.Auth, input botgateway.SendCardInput) (botgateway.SendCardResult, error) {
	f.cardInput = input
	return botgateway.SendCardResult{}, nil
}

func (f *botGatewayRouteFake) UpdateCard(_ context.Context, _ *botgateway.Auth, cardID string, input botgateway.UpdateCardInput) (map[string]any, error) {
	f.updateCardID = cardID
	f.updateCardInput = input
	return map[string]any{"card": map[string]any{"id": cardID}}, nil
}

func (f *botGatewayRouteFake) GetAttachment(_ context.Context, _ *botgateway.Auth, attachmentID string) (map[string]any, error) {
	f.attachmentID = attachmentID
	return map[string]any{"attachment": map[string]any{"id": attachmentID}}, nil
}

func (f *botGatewayRouteFake) CreateAttachment(_ context.Context, _ *botgateway.Auth, input botgateway.CreateAttachmentInput) (map[string]any, error) {
	f.attachmentInput = input
	return map[string]any{"upload": map[string]any{"status": "pending"}}, nil
}

func (f *botGatewayRouteFake) Typing(_ context.Context, _ *botgateway.Auth, conversationID string) (map[string]any, error) {
	f.typingID = conversationID
	return map[string]any{"accepted": true}, nil
}

type botGatewaySetupRouteFake struct {
	requestInput  bots.RequestSetupInput
	statusInput   bots.SetupStatusInput
	exchangeInput bots.ExchangeSetupInput

	setupSession bots.SetupSession
	exchange     struct {
		Token   bots.IssuedToken
		Session bots.SetupSession
	}
}

func (f *botGatewaySetupRouteFake) RequestSetup(_ context.Context, input bots.RequestSetupInput) (bots.SetupSession, error) {
	f.requestInput = input
	return f.setupSession, nil
}

func (f *botGatewaySetupRouteFake) GetSetupStatus(_ context.Context, input bots.SetupStatusInput) (bots.SetupSession, error) {
	f.statusInput = input
	return f.setupSession, nil
}

func (f *botGatewaySetupRouteFake) ExchangeSetupSession(_ context.Context, input bots.ExchangeSetupInput) (struct {
	Token   bots.IssuedToken
	Session bots.SetupSession
}, error) {
	f.exchangeInput = input
	return f.exchange, nil
}

func newBotGatewayRouteTestRouter(gateway *botGatewayRouteFake, setup *botGatewaySetupRouteFake, enabled bool) http.Handler {
	router := chi.NewRouter()
	registerBotGatewayRoutes(router, BotGatewayRouteOptions{
		Gateway: gateway, Setup: setup, WorkspaceEnabled: enabled,
		ResolveSpaceID: func(*http.Request) (string, error) { return "space_resolved", nil }, TrustProxy: true,
	})
	return router
}

func gatewayJSONRequest(method, target string, body string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", testGatewayAuthorization)
	request.Header.Set("X-Request-ID", "req_gateway")
	request.Header.Set("User-Agent", "gateway-test/1")
	request.RemoteAddr = "192.0.2.10:1234"
	request.Header.Set("X-Forwarded-For", "198.51.100.3, 203.0.113.4")
	return request
}

func gatewayResponseJSON(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, response.Body.String())
	}
	return value
}

func TestBotGatewayRoutesDisabledBeforeDependencies(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/bot-gateway/v1/me", nil)
	newBotGatewayRouteTestRouter(nil, nil, false).ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	body := gatewayResponseJSON(t, response)
	if body["error"].(map[string]any)["code"] != "workspace.disabled" {
		t.Fatalf("error = %#v", body["error"])
	}
}

func TestBotGatewayRoutesAuthenticateAndForwardRESTRequests(t *testing.T) {
	gateway := &botGatewayRouteFake{}
	router := newBotGatewayRouteTestRouter(gateway, nil, true)

	response := httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodGet, "/api/bot-gateway/v1/me", ""))
	if response.Code != http.StatusOK || gateway.authHeader != testGatewayAuthorization || gateway.spaceID != "space_resolved" {
		t.Fatalf("me response/status or auth mismatch: status=%d auth=%q space=%q", response.Code, gateway.authHeader, gateway.spaceID)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodGet, "/api/bot-gateway/v1/conversations/conv_1/context?limit=10", ""))
	if response.Code != http.StatusOK || gateway.contextID != "conv_1" || gateway.contextOptions["limit"] != "10" {
		t.Fatalf("context forwarding mismatch: status=%d id=%q options=%#v", response.Code, gateway.contextID, gateway.contextOptions)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodPost, "/api/bot-gateway/v1/events/ack", `{"eventId":"evt_1","sequence":7}`))
	if response.Code != http.StatusOK || gateway.ackInput.EventID != "evt_1" || gateway.ackInput.Sequence != 7 {
		t.Fatalf("ack forwarding mismatch: status=%d input=%#v", response.Code, gateway.ackInput)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodPost, "/api/bot-gateway/v1/messages", `{"conversationId":"conv_1","clientMessageId":"msg_1","idempotencyKey":"idem_1","text":"hello","actorId":"caller-forbidden"}`))
	if response.Code != http.StatusCreated || gateway.messageInput.ClientMessageID != "msg_1" || gateway.messageInput.Fields["actorId"] != "caller-forbidden" {
		t.Fatalf("message forwarding mismatch: status=%d input=%#v", response.Code, gateway.messageInput)
	}
	if gateway.messageInput.Meta.RequestID != "req_gateway" || gateway.messageInput.Meta.IPAddress != "198.51.100.3" || gateway.messageInput.Meta.UserAgent != "gateway-test/1" {
		t.Fatalf("request metadata mismatch: %#v", gateway.messageInput.Meta)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodPost, "/api/bot-gateway/v1/cards", `{"conversationId":"conv_1","clientMessageId":"card_msg","cardType":"notice","schemaVersion":1,"fallbackText":"fallback","payload":{"title":"hi"}}`))
	if response.Code != http.StatusCreated || gateway.cardInput.ClientMessageID != "card_msg" || gateway.cardInput.CardType != "notice" {
		t.Fatalf("card forwarding mismatch: status=%d input=%#v", response.Code, gateway.cardInput)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodPatch, "/api/bot-gateway/v1/cards/card_1", `{"expectedRevision":3,"fallbackText":"updated","payload":{"title":"new"},"status":"active"}`))
	if response.Code != http.StatusOK || gateway.updateCardID != "card_1" || gateway.updateCardInput.ExpectedRevision != 3 || gateway.updateCardInput.FallbackText == nil || *gateway.updateCardInput.FallbackText != "updated" {
		t.Fatalf("card update mismatch: status=%d id=%q input=%#v", response.Code, gateway.updateCardID, gateway.updateCardInput)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodGet, "/api/bot-gateway/v1/attachments/att_1", ""))
	if response.Code != http.StatusOK || gateway.attachmentID != "att_1" {
		t.Fatalf("attachment lookup mismatch: status=%d id=%q", response.Code, gateway.attachmentID)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodPost, "/api/bot-gateway/v1/attachments", `{"conversationId":"conv_1","fileName":"a.txt","mimeType":"text/plain","byteSize":12,"visibility":"private_staging"}`))
	if response.Code != http.StatusCreated || gateway.attachmentInput.FileName != "a.txt" || gateway.attachmentInput.ByteSize != 12 {
		t.Fatalf("attachment creation mismatch: status=%d input=%#v", response.Code, gateway.attachmentInput)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodPost, "/api/bot-gateway/v1/typing", `{"conversationId":"conv_1"}`))
	if response.Code != http.StatusOK || gateway.typingID != "conv_1" {
		t.Fatalf("typing mismatch: status=%d id=%q", response.Code, gateway.typingID)
	}
}

func TestBotGatewaySetupRoutesValidateAndExposeRawTokenOnlyOnExchange(t *testing.T) {
	setup := &botGatewaySetupRouteFake{
		setupSession: bots.SetupSession{ID: "setup_1234567890123456", Status: "awaiting_user"},
	}
	setup.exchange.Token = bots.IssuedToken{Token: bots.Token{ID: "token_record_1"}, Raw: "dl_bot_raw_once_abcdefghijklmnopqrstuvwxyz012345"}
	setup.exchange.Session = bots.SetupSession{ID: setup.setupSession.ID, Status: "approved"}
	router := newBotGatewayRouteTestRouter(nil, setup, true)

	response := httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodPost, "/api/bot-gateway/v1/setup/request", `{"setupSessionId":"setup_1234567890123456","requestedScopes":["messages:send"],"conversationIds":["conv_1"],"clientName":"agent","clientVersion":"1","protocolVersion":"v1","capabilities":["cards"]}`))
	if response.Code != http.StatusOK || setup.requestInput.SetupID != setup.setupSession.ID || len(setup.requestInput.RequestedScopes) != 1 || setup.requestInput.Meta.RequestID != "req_gateway" {
		t.Fatalf("setup request mismatch: status=%d input=%#v", response.Code, setup.requestInput)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("setup request cache-control = %q", response.Header().Get("Cache-Control"))
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodGet, "/api/bot-gateway/v1/setup/status?setupSessionId="+setup.setupSession.ID, ""))
	if response.Code != http.StatusOK || setup.statusInput.SetupID != setup.setupSession.ID {
		t.Fatalf("setup status mismatch: status=%d input=%#v", response.Code, setup.statusInput)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodPost, "/api/bot-gateway/v1/setup/exchange", `{"setupSessionId":"setup_1234567890123456","clientName":"agent","clientVersion":"1","protocolVersion":"v1"}`))
	if response.Code != http.StatusCreated || strings.Count(response.Body.String(), setup.exchange.Token.Raw) != 1 {
		t.Fatalf("exchange status/body token count mismatch: status=%d body=%s", response.Code, response.Body.String())
	}
	body := gatewayResponseJSON(t, response)
	record, ok := body["tokenRecord"].(map[string]any)
	if body["token"] != setup.exchange.Token.Raw || !ok || record["id"] != "token_record_1" {
		t.Fatalf("exchange shape = %#v", body)
	}
	if setup.exchangeInput.SetupID != setup.setupSession.ID || setup.exchangeInput.ClientName != "agent" {
		t.Fatalf("exchange input = %#v", setup.exchangeInput)
	}
}

func TestBotGatewaySetupRoutesRejectUnknownFieldsBeforeService(t *testing.T) {
	setup := &botGatewaySetupRouteFake{}
	router := newBotGatewayRouteTestRouter(nil, setup, true)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/bot-gateway/v1/setup/request", strings.NewReader(`{"setupSessionId":"setup_1234567890123456","actorId":"caller-forbidden"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	body := gatewayResponseJSON(t, response)
	if body["error"].(map[string]any)["code"] != botgateway.CodeInvalidRequest {
		t.Fatalf("error = %#v", body["error"])
	}
	if setup.requestInput.SetupID != "" {
		t.Fatalf("setup service was called: %#v", setup.requestInput)
	}
}

func TestBotGatewayExchangeFailsClosedWithoutRawToken(t *testing.T) {
	setup := &botGatewaySetupRouteFake{}
	setup.exchange.Session = bots.SetupSession{ID: "setup_1234567890123456", Status: "approved"}
	router := newBotGatewayRouteTestRouter(nil, setup, true)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/bot-gateway/v1/setup/exchange", strings.NewReader(`{"setupSessionId":"setup_1234567890123456"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusInternalServerError)
	}
	if strings.Contains(response.Body.String(), "token") {
		t.Fatalf("raw-less exchange exposed token response: %s", response.Body.String())
	}
}

func TestBotGatewayRoutesUseDefaultSpaceWithoutResolver(t *testing.T) {
	gateway := &botGatewayRouteFake{}
	router := chi.NewRouter()
	registerBotGatewayRoutes(router, BotGatewayRouteOptions{Gateway: gateway, WorkspaceEnabled: true})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/bot-gateway/v1/me", nil)
	request.Header.Set("Authorization", testGatewayAuthorization)
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || gateway.spaceID != auth.DefaultSpaceID {
		t.Fatalf("default space mismatch: status=%d space=%q", response.Code, gateway.spaceID)
	}
}

const testGatewayAuthorization = "Bearer dl_bot_abcdefghijklmnopqrstuvwxyz012345"

func TestBotGatewayRootRouterUsesTokenIdentity(t *testing.T) {
	gateway := &botGatewayRouteFake{}
	resolver := &fakeResolver{actor: &auth.Actor{ID: "browser-owner"}}
	router := NewRouter(RouterOptions{Gate: gate.New("true"), BotGateway: gateway, ActorResolver: resolver})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodGet, "/api/bot-gateway/v1/me", ""))
	if response.Code != http.StatusOK || resolver.calls != 0 || gateway.spaceID != auth.DefaultSpaceID {
		t.Fatalf("gateway root wiring: status=%d browserAuth=%d space=%q", response.Code, resolver.calls, gateway.spaceID)
	}
}

func TestBotGatewayRootRouterGatesEveryRESTEndpoint(t *testing.T) {
	endpoints := []struct{ method, path string }{
		{http.MethodGet, "/api/bot-gateway/v1/me"},
		{http.MethodPost, "/api/bot-gateway/v1/events/ack"},
		{http.MethodGet, "/api/bot-gateway/v1/conversations/c/context"},
		{http.MethodPost, "/api/bot-gateway/v1/messages"},
		{http.MethodPost, "/api/bot-gateway/v1/cards"},
		{http.MethodPatch, "/api/bot-gateway/v1/cards/c"},
		{http.MethodGet, "/api/bot-gateway/v1/attachments/a"},
		{http.MethodPost, "/api/bot-gateway/v1/attachments"},
		{http.MethodPost, "/api/bot-gateway/v1/typing"},
		{http.MethodPost, "/api/bot-gateway/v1/setup/request"},
		{http.MethodGet, "/api/bot-gateway/v1/setup/status"},
		{http.MethodPost, "/api/bot-gateway/v1/setup/exchange"},
	}
	for _, flag := range []string{"", "false", "TRUE", " true", "true "} {
		for _, endpoint := range endpoints {
			t.Run(flag+"/"+endpoint.method+endpoint.path, func(t *testing.T) {
				gateway := &botGatewayRouteFake{}
				setup := &botGatewaySetupRouteFake{}
				router := NewRouter(RouterOptions{Gate: gate.New(flag), BotGateway: gateway, BotGatewaySetup: setup})
				response := httptest.NewRecorder()
				router.ServeHTTP(response, gatewayJSONRequest(endpoint.method, endpoint.path, "invalid-json"))
				payload := gatewayResponseJSON(t, response)
				value := payload["error"].(map[string]any)
				if response.Code != http.StatusServiceUnavailable || value["code"] != gate.DisabledCode || value["message"] != gate.DisabledMessage || gateway.authHeader != "" || setup.requestInput.SetupID != "" {
					t.Fatalf("disabled endpoint reached a dependency or changed contract: %d %s", response.Code, response.Body.String())
				}
			})
		}
	}
}

func TestBotGatewayRejectsCredentialsOutsideBearerHeader(t *testing.T) {
	for _, header := range []string{"", "dl_bot_abcdefghijklmnopqrstuvwxyz012345", "Basic abc", "bearer dl_bot_abcdefghijklmnopqrstuvwxyz012345", "Bearer dl_bot_short"} {
		gateway := &botGatewayRouteFake{}
		router := NewRouter(RouterOptions{Gate: gate.New("true"), BotGateway: gateway})
		request := httptest.NewRequest(http.MethodGet, "/api/bot-gateway/v1/me?token=dl_bot_abcdefghijklmnopqrstuvwxyz012345", nil)
		request.Header.Set("Authorization", header)
		request.AddCookie(&http.Cookie{Name: "workspace_session", Value: "browser-session"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || gateway.authHeader != "" || strings.Contains(response.Body.String(), "abcdefghijklmnopqrstuvwxyz") {
			t.Fatalf("non-Bearer credentials accepted or exposed: status=%d body=%s", response.Code, response.Body.String())
		}
	}
}

type failingBotGatewayRoute struct {
	botGatewayRouteFake
	err error
}

func (f *failingBotGatewayRoute) Authenticate(context.Context, string, botgateway.TokenAuthOptions) (*botgateway.Auth, error) {
	return nil, f.err
}

func TestBotGatewayRootRouterProjectsSafeDomainErrors(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusConflict, http.StatusInternalServerError} {
		domain := botgateway.NewError("gateway.test", "safe message", status)
		domain.Cause = errors.New("postgres://secret:password@private-host/db")
		router := NewRouter(RouterOptions{Gate: gate.New("true"), BotGateway: &failingBotGatewayRoute{err: domain}})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, gatewayJSONRequest(http.MethodGet, "/api/bot-gateway/v1/me", ""))
		if response.Code != status || !strings.Contains(response.Body.String(), `"code":"gateway.test"`) || strings.Contains(response.Body.String(), "password") || strings.Contains(response.Body.String(), "private-host") {
			t.Fatalf("unsafe or incorrect gateway error: status=%d body=%s", response.Code, response.Body.String())
		}
	}
}
