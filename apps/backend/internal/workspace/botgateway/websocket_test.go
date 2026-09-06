package botgateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

var fakeConnectionDisconnectNonces sync.Map

func TestWebSocketHandlerWithoutGatewayReturnsServiceUnavailable(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/ws/bot-gateway", nil)
	response := httptest.NewRecorder()
	NewWebSocketHandler(WebSocketHandlerOptions{}).ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
}

func (r *fakeRepository) RegisterConnection(_ context.Context, input ConnectionRegistrationRecord) error {
	fakeConnectionDisconnectNonces.Store(r, input.Nonce)
	r.mu.Lock()
	defer r.mu.Unlock()
	now := input.UpdatedAt
	connected := input.ConnectedAt
	if r.connection == nil {
		r.connection = &Connection{}
	}
	r.connection.Status = input.Status
	if input.AdapterVersion != "" {
		value := input.AdapterVersion
		r.connection.AdapterVersion = &value
	}
	r.connection.ConnectedAt = timestampPointer(&connected)
	r.connection.DisconnectedAt = nil
	r.connection.LastHeartbeatAt = timestampPointer(&input.HeartbeatAt)
	r.connection.UpdatedAt = timestamp(now)
	return nil
}

func (r *fakeRepository) HeartbeatConnection(_ context.Context, _, _, _ string, at time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.connection == nil || r.connection.Status != "connected" {
		return NewError(CodeInvalidRequest, MessageInvalidMessage, 400)
	}
	r.connection.LastHeartbeatAt = timestampPointer(&at)
	r.connection.UpdatedAt = timestamp(at)
	return nil
}

func (r *fakeRepository) DisconnectConnection(_ context.Context, _, _, nonce string, at time.Time) error {
	fakeConnectionDisconnectNonces.Store(r, nonce)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.connection == nil {
		return nil
	}
	r.connection.Status = "disconnected"
	r.connection.DisconnectedAt = timestampPointer(&at)
	r.connection.UpdatedAt = timestamp(at)
	return nil
}

func TestWebSocketHelloReplayAckHeartbeatAndConnectionLifecycle(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	created := repo.now()
	repo.events = []EventRecord{{
		ID: "event_ws_1", SpaceID: authValue.SpaceID, Sequence: 1, EventType: "message.created",
		ActorUserID: "owner_1", ConversationID: "conv_direct", TargetType: "message", TargetID: "message_ws_1",
		PayloadJSON: []byte(`{"messageId":"message_ws_1"}`), CreatedAt: created,
	}}
	repo.triggers["conv_direct:message_ws_1"] = &MessageTrigger{AuthorID: "owner_1", PlainText: "secret stays out", ContentJSON: []byte(`{"blocks":[{"type":"text","text":"secret stays out"}]}`)}

	handler := NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway: service, SpaceID: authValue.SpaceID, PollInterval: 10 * time.Millisecond,
		HeartbeatInterval: time.Hour, WriteTimeout: time.Second,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	serverURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	serverURL.Scheme = "ws"
	connection, _, err := websocket.Dial(context.Background(), serverURL.String(), &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer dl_bot_" + strings.Repeat("x", 32)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(websocket.StatusNormalClosure, "test complete") })

	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSequence":0}`)); err != nil {
		t.Fatal(err)
	}
	ready := readWebSocketObject(t, connection)
	if ready["type"] != "ready" || ready["currentSequence"] != float64(1) || ready["replayCount"] != float64(1) {
		t.Fatalf("ready frame = %#v", ready)
	}
	event := readWebSocketObject(t, connection)
	if event["type"] != "event" {
		t.Fatalf("event frame = %#v", event)
	}
	eventBody, ok := event["event"].(map[string]any)
	if !ok || eventBody["eventId"] != "event_ws_1" {
		t.Fatalf("event body = %#v", event["event"])
	}
	if payload, ok := eventBody["payload"].(map[string]any); !ok || len(payload) != 0 {
		t.Fatalf("event payload leaked content = %#v", eventBody["payload"])
	}

	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"ack","eventId":"event_ws_1","sequence":1}`)); err != nil {
		t.Fatal(err)
	}
	ack := readWebSocketObject(t, connection)
	if ack["type"] != "ack" || ack["acknowledged"] != true || ack["sequence"] != float64(1) {
		t.Fatalf("ack frame = %#v", ack)
	}
	repo.mu.Lock()
	deliveryStatus := repo.deliveries[0].Status
	repo.mu.Unlock()
	if deliveryStatus != "acked" {
		t.Fatalf("delivery status = %q", deliveryStatus)
	}

	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"heartbeat","id":"hb-1"}`)); err != nil {
		t.Fatal(err)
	}
	heartbeat := readWebSocketObject(t, connection)
	if heartbeat["type"] != "heartbeat" || heartbeat["id"] != "hb-1" || heartbeat["timestamp"] == "" {
		t.Fatalf("heartbeat frame = %#v", heartbeat)
	}

	if err := connection.Close(websocket.StatusNormalClosure, "client complete"); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		repo.mu.Lock()
		disconnected := repo.connection != nil && repo.connection.Status == "disconnected"
		repo.mu.Unlock()
		if disconnected {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	repo.mu.Lock()
	connectionSnapshot := repo.connection
	repo.mu.Unlock()
	t.Fatalf("connection was not disconnected: %#v", connectionSnapshot)
}

func TestWebSocketInvalidHelloIsBoundedAndSyncCanResume(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.events = []EventRecord{{
		ID: "event_ws_2", SpaceID: authValue.SpaceID, Sequence: 3, EventType: "message.created",
		ActorUserID: "owner_1", ConversationID: "conv_direct", TargetType: "message", TargetID: "message_ws_2",
		PayloadJSON: []byte(`{"messageId":"message_ws_2"}`), CreatedAt: repo.now(),
	}}
	repo.triggers["conv_direct:message_ws_2"] = &MessageTrigger{AuthorID: "owner_1", PlainText: "three", ContentJSON: []byte(`{"blocks":[{"type":"text","text":"three"}]}`)}
	handler := NewWebSocketHandler(WebSocketHandlerOptions{Gateway: service, SpaceID: authValue.SpaceID, PollInterval: time.Hour, HeartbeatInterval: time.Hour})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	serverURL, _ := url.Parse(server.URL)
	serverURL.Scheme = "ws"
	connection, _, err := websocket.Dial(context.Background(), serverURL.String(), &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer dl_bot_" + strings.Repeat("x", 32)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(websocket.StatusNormalClosure, "test complete") })

	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":2,"type":"hello"}`)); err != nil {
		t.Fatal(err)
	}
	invalid := readWebSocketObject(t, connection)
	if invalid["type"] != "error" || invalid["error"].(map[string]any)["code"] != CodeInvalidHello {
		t.Fatalf("invalid hello frame = %#v", invalid)
	}
	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSequence":0}`)); err != nil {
		t.Fatal(err)
	}
	syncRequired := readWebSocketObject(t, connection)
	if syncRequired["type"] != "sync_required" || syncRequired["reason"] != "replay_window_exceeded" {
		t.Fatalf("sync frame = %#v", syncRequired)
	}
}

func TestWebSocketTransportRequiresBearerAndUsesNodeAuthCloseReason(t *testing.T) {
	_, service, _, _, _ := gatewayFixture(t)
	server := httptest.NewServer(NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway:           service,
		PollInterval:      time.Hour,
		HeartbeatInterval: time.Hour,
	}))
	t.Cleanup(server.Close)

	for _, authorization := range []string{"", "dl_bot_" + strings.Repeat("x", 32)} {
		connection, _, err := dialBotGateway(t, server.URL, authorization)
		if err != nil {
			t.Fatalf("authorization %q dial: %v", authorization, err)
		}
		closeErr := readWebSocketClose(t, connection)
		if websocket.CloseStatus(closeErr) != websocket.StatusPolicyViolation {
			t.Fatalf("authorization %q close status = %v, err=%v", authorization, websocket.CloseStatus(closeErr), closeErr)
		}
		if !strings.Contains(closeErr.Error(), "bot authentication required") {
			t.Fatalf("authorization %q close reason = %v", authorization, closeErr)
		}
		_ = connection.Close(websocket.StatusNormalClosure, "test complete")
	}
}

func TestWebSocketAcceptsBinaryNodeNumbersArbitraryHeartbeatIDAndRejectsCloseCommand(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.events = nil
	handler := NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway: service, SpaceID: authValue.SpaceID,
		PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer dl_bot_"+strings.Repeat("x", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(websocket.StatusNormalClosure, "test complete") })

	if err := connection.Write(context.Background(), websocket.MessageBinary, []byte("{\"version\":1e0,\"type\":\"hello\",\"lastSequence\":\"\\u00a0\"}")); err != nil {
		t.Fatal(err)
	}
	ready := readWebSocketObject(t, connection)
	if ready["type"] != "ready" || ready["currentSequence"] != float64(0) {
		t.Fatalf("binary Node hello response = %#v", ready)
	}

	if err := connection.Write(context.Background(), websocket.MessageBinary, []byte(`{"version":1,"type":"heartbeat","id":{"nested":[true,"x",null]}}`)); err != nil {
		t.Fatal(err)
	}
	heartbeat := readWebSocketObject(t, connection)
	if heartbeat["type"] != "heartbeat" {
		t.Fatalf("heartbeat response = %#v", heartbeat)
	}
	if got, ok := heartbeat["id"].(map[string]any); !ok || len(got) != 1 {
		t.Fatalf("arbitrary heartbeat id = %#v", heartbeat["id"])
	}

	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"close"}`)); err != nil {
		t.Fatal(err)
	}
	invalidClose := readWebSocketObject(t, connection)
	if invalidClose["type"] != "error" || invalidClose["error"].(map[string]any)["code"] != CodeInvalidMessage {
		t.Fatalf("application close response = %#v", invalidClose)
	}
	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"heartbeat","id":[]}`)); err != nil {
		t.Fatal(err)
	}
	if next := readWebSocketObject(t, connection); next["type"] != "heartbeat" {
		t.Fatalf("connection after application close = %#v", next)
	}
}

func TestWebSocketValidHelloEntersReadyStateBeforeInvalidSequence(t *testing.T) {
	_, service, authValue, _, _ := gatewayFixture(t)
	server := httptest.NewServer(NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway: service, SpaceID: authValue.SpaceID,
		PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer dl_bot_"+strings.Repeat("x", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(websocket.StatusNormalClosure, "test complete") })

	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSequence":{}}`)); err != nil {
		t.Fatal(err)
	}
	invalidSequence := readWebSocketObject(t, connection)
	if invalidSequence["type"] != "error" || invalidSequence["error"].(map[string]any)["code"] != CodeInvalidSequence {
		t.Fatalf("invalid cursor response = %#v", invalidSequence)
	}
	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"heartbeat","id":true}`)); err != nil {
		t.Fatal(err)
	}
	if heartbeat := readWebSocketObject(t, connection); heartbeat["type"] != "heartbeat" || heartbeat["id"] != true {
		t.Fatalf("post-error heartbeat response = %#v", heartbeat)
	}
}

func TestWebSocketHeartbeatRevalidatesRevokedToken(t *testing.T) {
	_, service, authValue, _, _ := gatewayFixture(t)
	gateway := &revokingWebSocketGateway{Service: service}
	server := httptest.NewServer(NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway: gateway, SpaceID: authValue.SpaceID,
		PollInterval: time.Hour, HeartbeatInterval: 10 * time.Millisecond,
	}))
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer dl_bot_"+strings.Repeat("x", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(websocket.StatusNormalClosure, "test complete") })
	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"hello"}`)); err != nil {
		t.Fatal(err)
	}
	_ = readWebSocketObject(t, connection)
	gateway.revoked.Store(true)
	closeErr := readWebSocketClose(t, connection)
	if websocket.CloseStatus(closeErr) != websocket.StatusPolicyViolation || !strings.Contains(closeErr.Error(), "bot token revoked") {
		t.Fatalf("revoked token close = status:%v err:%v", websocket.CloseStatus(closeErr), closeErr)
	}
}

func TestWebSocketAckPreservesMissingSequenceDistinction(t *testing.T) {
	_, service, authValue, _, _ := gatewayFixture(t)
	server := httptest.NewServer(NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway: service, SpaceID: authValue.SpaceID,
		PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer dl_bot_"+strings.Repeat("x", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(websocket.StatusNormalClosure, "test complete") })
	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"hello"}`)); err != nil {
		t.Fatal(err)
	}
	_ = readWebSocketObject(t, connection)

	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"ack","eventId":"event-1"}`)); err != nil {
		t.Fatal(err)
	}
	missing := readWebSocketObject(t, connection)
	if missing["error"].(map[string]any)["code"] != CodeInvalidSequence {
		t.Fatalf("missing sequence response = %#v", missing)
	}
	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"ack","eventId":"event-1","sequence":null}`)); err != nil {
		t.Fatal(err)
	}
	nullSequence := readWebSocketObject(t, connection)
	if nullSequence["type"] != "ack" || nullSequence["sequence"] != float64(0) {
		t.Fatalf("null sequence response = %#v", nullSequence)
	}
}

func TestNormalizeSequenceRejectsValuesOutsideJavaScriptSafeIntegerRange(t *testing.T) {
	if _, err := normalizeSequence((1<<53)-1, true); err != nil {
		t.Fatalf("max safe sequence rejected: %v", err)
	}
	if _, err := normalizeSequence(1<<53, true); !isCode(err, CodeInvalidSequence) {
		t.Fatalf("unsafe sequence error = %v", err)
	}
}

func TestGatewaySafeIntegerMatchesNodeNumberConversions(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want int64
		ok   bool
	}{
		{name: "empty string", raw: `""`, want: 0, ok: true},
		{name: "unicode whitespace string", raw: `"\u00a0\u2028"`, want: 0, ok: true},
		{name: "null", raw: "null", want: 0, ok: true},
		{name: "false", raw: "false", want: 0, ok: true},
		{name: "true", raw: "true", want: 1, ok: true},
		{name: "empty array", raw: "[]", want: 0, ok: true},
		{name: "single value array", raw: `["1e0"]`, want: 1, ok: true},
		{name: "multiple value array", raw: `[1,2]`, ok: false},
		{name: "object", raw: `{}`, ok: false},
		{name: "fraction", raw: "1.5", ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := gatewaySafeInteger(json.RawMessage(test.raw))
			if ok != test.ok || ok && got != test.want {
				t.Fatalf("gatewaySafeInteger(%s) = (%d, %v), want (%d, %v)", test.raw, got, ok, test.want, test.ok)
			}
		})
	}
}

func TestWebSocketEnforcesThirtyTwoKilobyteInputFrameLimit(t *testing.T) {
	_, service, authValue, _, _ := gatewayFixture(t)
	server := httptest.NewServer(NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway: service, SpaceID: authValue.SpaceID,
		ReadLimit: 32 * 1024, PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer dl_bot_"+strings.Repeat("x", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(websocket.StatusNormalClosure, "test complete") })
	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"hello"}`)); err != nil {
		t.Fatal(err)
	}
	_ = readWebSocketObject(t, connection)
	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"version":1,"type":"heartbeat","id":"`+strings.Repeat("x", 32*1024)+`"}`)); err != nil {
		t.Fatal(err)
	}
	closeErr := readWebSocketClose(t, connection)
	if websocket.CloseStatus(closeErr) != websocket.StatusMessageTooBig {
		t.Fatalf("oversized frame status = %v, err=%v", websocket.CloseStatus(closeErr), closeErr)
	}
}

func TestWebSocketRootContextInterruptsIdleReadAndCleanup(t *testing.T) {
	root, cancelRoot := context.WithCancel(context.Background())
	gateway := newShutdownWebSocketGateway()
	server := httptest.NewServer(NewWebSocketHandler(WebSocketHandlerOptions{
		RootContext: root, Gateway: gateway,
		PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer dl_bot_"+strings.Repeat("x", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(websocket.StatusNormalClosure, "test complete") })
	select {
	case <-gateway.registered:
	case <-time.After(time.Second):
		t.Fatal("gateway registration did not complete")
	}
	cancelRoot()
	closeErr := readWebSocketClose(t, connection)
	if websocket.CloseStatus(closeErr) != websocket.StatusServiceRestart {
		t.Fatalf("shutdown close status = %v, err=%v", websocket.CloseStatus(closeErr), closeErr)
	}
	select {
	case <-gateway.cleanupDone:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not run after root shutdown")
	}
	if gateway.cleanupContextCanceled.Load() {
		t.Fatal("cleanup received a canceled context after root shutdown")
	}
}

func TestWebSocketShutdownWaitsForCleanupAndRejectsLateAdmission(t *testing.T) {
	gateway := newShutdownWebSocketGateway()
	gateway.cleanupRelease = make(chan struct{})
	handler := NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway: gateway, PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer dl_bot_"+strings.Repeat("x", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.CloseNow() })
	var releaseOnce sync.Once
	releaseCleanup := func() { releaseOnce.Do(func() { close(gateway.cleanupRelease) }) }
	t.Cleanup(releaseCleanup)
	select {
	case <-gateway.registered:
	case <-time.After(time.Second):
		t.Fatal("gateway registration did not complete")
	}

	shutdownResult := make(chan error, 1)
	go func() { shutdownResult <- handler.Shutdown(context.Background()) }()
	closeErr := readWebSocketClose(t, connection)
	if websocket.CloseStatus(closeErr) != websocket.StatusServiceRestart {
		t.Fatalf("shutdown close status = %v, err=%v", websocket.CloseStatus(closeErr), closeErr)
	}
	select {
	case <-gateway.cleanupStarted:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not enter durable cleanup")
	}
	select {
	case err := <-shutdownResult:
		t.Fatalf("Shutdown returned before cleanup was released: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	timeoutContext, cancelTimeout := context.WithTimeout(context.Background(), 25*time.Millisecond)
	err = handler.Shutdown(timeoutContext)
	cancelTimeout()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timed out Shutdown error = %v, want deadline exceeded", err)
	}
	select {
	case err := <-shutdownResult:
		t.Fatalf("primary Shutdown returned before cleanup was released: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	select {
	case <-gateway.cleanupDone:
		t.Fatal("cleanup completed before release")
	default:
	}

	lateResponse := httptest.NewRecorder()
	handler.ServeHTTP(lateResponse, httptest.NewRequest(http.MethodGet, "/ws/bot-gateway", nil))
	if lateResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("late admission status = %d, body = %q", lateResponse.Code, lateResponse.Body.String())
	}

	releaseCleanup()
	if err := <-shutdownResult; err != nil {
		t.Fatalf("primary Shutdown after cleanup release: %v", err)
	}
	if err := handler.Shutdown(context.Background()); err != nil {
		t.Fatalf("repeat Shutdown after cleanup release: %v", err)
	}
	select {
	case <-gateway.cleanupDone:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not finish after release")
	}
}

func TestWebSocketShutdownReportsCleanupFailureWithoutDetails(t *testing.T) {
	gateway := newShutdownWebSocketGateway()
	gateway.cleanupError = errors.New("provider=secret token=dl_bot_sensitive")
	handler := NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway: gateway, PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer dl_bot_"+strings.Repeat("x", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.CloseNow() })
	select {
	case <-gateway.registered:
	case <-time.After(time.Second):
		t.Fatal("gateway registration did not complete")
	}

	shutdownResult := make(chan error, 1)
	go func() { shutdownResult <- handler.Shutdown(context.Background()) }()
	closeErr := readWebSocketClose(t, connection)
	if websocket.CloseStatus(closeErr) != websocket.StatusServiceRestart {
		t.Fatalf("shutdown close status = %v, err=%v", websocket.CloseStatus(closeErr), closeErr)
	}
	if err := <-shutdownResult; !errors.Is(err, ErrShutdownCleanupFailed) {
		t.Fatalf("Shutdown error = %v, want ErrShutdownCleanupFailed", err)
	} else if strings.Contains(err.Error(), "provider=") || strings.Contains(err.Error(), "dl_bot_sensitive") {
		t.Fatalf("Shutdown exposed cleanup details: %v", err)
	}
}

func TestWebSocketAuthenticationAndRegistrationShareHandshakeDeadline(t *testing.T) {
	gateway := newShutdownWebSocketGateway()
	gateway.authDeadline = make(chan time.Time, 1)
	gateway.registerDeadline = make(chan time.Time, 1)
	gateway.registerError = errors.New("stop handshake")
	server := httptest.NewServer(NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway: gateway, PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer dl_bot_"+strings.Repeat("x", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.CloseNow() })
	_ = readWebSocketClose(t, connection)
	var authDeadline, registerDeadline time.Time
	select {
	case authDeadline = <-gateway.authDeadline:
	case <-time.After(time.Second):
		t.Fatal("Authenticate did not receive a deadline")
	}
	select {
	case registerDeadline = <-gateway.registerDeadline:
	case <-time.After(time.Second):
		t.Fatal("RegisterConnection did not receive a deadline")
	}
	if authDeadline.IsZero() || registerDeadline.IsZero() || !authDeadline.Equal(registerDeadline) {
		t.Fatalf("handshake deadlines = auth %v, register %v; want one shared deadline", authDeadline, registerDeadline)
	}
}

func TestConnectionCleanupUsesLatestNonceWhenSocketsCloseOutOfOrder(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	firstCleanup, err := service.RegisterConnection(context.Background(), authValue, ConnectionRegistration{Nonce: "nonce-first"})
	if err != nil {
		t.Fatal(err)
	}
	secondCleanup, err := service.RegisterConnection(context.Background(), authValue, ConnectionRegistration{Nonce: "nonce-second"})
	if err != nil {
		t.Fatal(err)
	}
	if err := secondCleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := firstCleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	value, ok := fakeConnectionDisconnectNonces.Load(repo)
	if !ok || value != "nonce-second" {
		t.Fatalf("disconnected nonce = %v", value)
	}
}

func readWebSocketObject(t *testing.T, connection *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	typ, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("message type = %v", typ)
	}
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("decode frame: %v (%s)", err, payload)
	}
	return value
}

func dialBotGateway(t *testing.T, serverURL, authorization string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Scheme = "ws"
	parsed.Path = "/ws/bot-gateway"
	options := &websocket.DialOptions{}
	if authorization != "" {
		options.HTTPHeader = http.Header{"Authorization": []string{authorization}}
	}
	return websocket.Dial(context.Background(), parsed.String(), options)
}

func readWebSocketClose(t *testing.T, connection *websocket.Conn) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, err := connection.Read(ctx)
	if err == nil {
		t.Fatal("expected WebSocket close")
	}
	return err
}

type shutdownWebSocketGateway struct {
	cleanupDone            chan struct{}
	cleanupStarted         chan struct{}
	cleanupRelease         chan struct{}
	cleanupContextCanceled atomic.Bool
	registered             chan struct{}
	registerOnce           sync.Once
	cleanupStartOnce       sync.Once
	cleanupDoneOnce        sync.Once
	authDeadline           chan time.Time
	registerDeadline       chan time.Time
	registerError          error
	cleanupError           error
}

type revokingWebSocketGateway struct {
	*Service
	revoked atomic.Bool
}

func (g *revokingWebSocketGateway) ValidateAuth(ctx context.Context, value *Auth) (*Auth, error) {
	if g.revoked.Load() {
		return nil, invalidTokenError()
	}
	return g.Service.ValidateAuth(ctx, value)
}

func newShutdownWebSocketGateway() *shutdownWebSocketGateway {
	return &shutdownWebSocketGateway{
		cleanupDone:    make(chan struct{}),
		cleanupStarted: make(chan struct{}),
		registered:     make(chan struct{}),
	}
}

func (g *shutdownWebSocketGateway) Authenticate(ctx context.Context, _ string, _ TokenAuthOptions) (*Auth, error) {
	if g.authDeadline != nil {
		if deadline, ok := ctx.Deadline(); ok {
			g.authDeadline <- deadline
		}
	}
	return &Auth{TokenID: "token_shutdown", BotID: "bot_shutdown", UserID: "bot_user", SpaceID: DefaultSpaceID, Bot: Bot{ID: "bot_shutdown", Status: "active"}}, nil
}

func (g *shutdownWebSocketGateway) ValidateAuth(_ context.Context, value *Auth) (*Auth, error) {
	return value, nil
}

func (g *shutdownWebSocketGateway) RegisterConnection(ctx context.Context, _ *Auth, _ ConnectionRegistration) (func(context.Context) error, error) {
	if g.registerDeadline != nil {
		if deadline, ok := ctx.Deadline(); ok {
			g.registerDeadline <- deadline
		}
	}
	if g.registerError != nil {
		return nil, g.registerError
	}
	g.registerOnce.Do(func() { close(g.registered) })
	return func(ctx context.Context) error {
		g.cleanupStartOnce.Do(func() { close(g.cleanupStarted) })
		if g.cleanupRelease != nil {
			<-g.cleanupRelease
		}
		if ctx.Err() != nil {
			g.cleanupContextCanceled.Store(true)
		}
		g.cleanupDoneOnce.Do(func() { close(g.cleanupDone) })
		return g.cleanupError
	}, nil
}

func (g *shutdownWebSocketGateway) Heartbeat(context.Context, *Auth, string) (HeartbeatResult, error) {
	return HeartbeatResult{Timestamp: "2026-09-06T00:00:00.000Z"}, nil
}

func (g *shutdownWebSocketGateway) Replay(context.Context, *Auth, ReplayInput) (ReplayResult, error) {
	return ReplayResult{Events: []Delivery{}, CurrentSequence: 0}, nil
}

func (g *shutdownWebSocketGateway) Acknowledge(context.Context, *Auth, AcknowledgeInput) (AcknowledgeResult, error) {
	return AcknowledgeResult{}, nil
}
