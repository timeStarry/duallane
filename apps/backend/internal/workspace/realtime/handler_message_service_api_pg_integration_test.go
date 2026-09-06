//go:build postgres_integration

package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	workspaceAuth "github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceEvents "github.com/timestarry/duallane/apps/backend/internal/workspace/events"
	workspaceGate "github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	workspaceHTTP "github.com/timestarry/duallane/apps/backend/internal/workspace/httpapi"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

// TestPGRealtimeWebSocketCatchupThroughMessageServiceAPI covers the production
// message write path that the lower-level replay test intentionally bypasses:
// HTTP POST -> messages.Service.Create -> one PostgreSQL transaction containing
// the message and workspace event. The owner posts the same 28-message burst
// used by the browser flow while two already-connected human sessions consume
// the durable event stream. No message or event row is inserted directly by
// this test.
func TestPGRealtimeWebSocketCatchupThroughMessageServiceAPI(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)

	connection, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_message_service_ws_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := connection.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := connection.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("clean synthetic message service WebSocket schema: %v", err)
		}
	})
	if _, err := connection.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (migrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(connection),
		Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	seedMessageServiceWSFixture(t, ctx, connection)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	// Match the browser harness: one listener connection plus a small query
	// pool while the API and both WebSocket sessions are active.
	poolConfig.MaxConns = 5
	poolConfig.MinConns = 0
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	hub := NewHub()
	listenerWakeup, unsubscribe := hub.Subscribe()
	defer unsubscribe()
	listenerContext, stopListener := context.WithCancel(context.Background())
	listenerDone := make(chan error, 1)
	go func() {
		listenerDone <- NewPGListener(ListenerOptions{
			Pool: pool, Hub: hub, ReconnectMinimum: 10 * time.Millisecond, ReconnectMaximum: 50 * time.Millisecond,
		}).Run(listenerContext)
	}()
	awaitMessageServiceWSWakeup(t, listenerWakeup)
	defer func() {
		stopListener()
		select {
		case listenerErr := <-listenerDone:
			if listenerErr != nil {
				t.Errorf("stop realtime listener: %v", listenerErr)
			}
		case <-time.After(3 * time.Second):
			t.Errorf("realtime listener did not stop after cancellation")
		}
	}()

	eventService := workspaceEvents.NewService(workspaceEvents.ServiceOptions{
		Repository: workspaceEvents.NewPGRepository(pool),
		BatchSize:  5,
	})
	messageService := workspaceMessages.NewService(workspaceMessages.ServiceOptions{
		Repository: workspaceMessages.NewPGRepository(pool),
		SpaceID:    workspaceMessages.DefaultSpaceID,
		Now: func() time.Time {
			return time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
		},
	})
	resolver := messageServiceWSResolver{}
	realtimeHandler := NewHandler(HandlerOptions{
		RootContext:       ctx,
		ActorResolver:     resolver,
		Events:            eventService,
		Hub:               hub,
		PollInterval:      time.Hour,
		HeartbeatInterval: time.Hour,
		IOTimeout:         5 * time.Second,
	})
	server := httptest.NewServer(workspaceHTTP.NewRouter(workspaceHTTP.RouterOptions{
		Gate:          workspaceGate.New("true"),
		ActorResolver: resolver,
		Messages:      messageService,
		Realtime:      realtimeHandler,
	}))
	defer server.Close()

	clients := make([]*websocket.Conn, 0, 2)
	for _, actorID := range []string{"usr_message_service_ws_owner", "usr_message_service_ws_member"} {
		client, _, dialErr := websocket.Dial(ctx, messageServiceWSWebSocketURL(server.URL+"/ws/workspace"), &websocket.DialOptions{
			HTTPHeader: http.Header{"X-Test-Actor": []string{actorID}},
		})
		if dialErr != nil {
			t.Fatal(dialErr)
		}
		clients = append(clients, client)
		defer client.CloseNow()
		if err := client.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSeq":0}`)); err != nil {
			t.Fatal(err)
		}
		ready, readErr := readMessageServiceWSFrame(ctx, client)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if ready["type"] != "ready" || ready["currentSeq"] != float64(0) || ready["replayCount"] != float64(0) || ready["hasMore"] != false {
			t.Fatalf("initial ready frame = %#v", ready)
		}
	}

	readResults := startMessageServiceWSReaders(ctx, clients, 28)
	apiClient := &http.Client{Timeout: 10 * time.Second}
	for index := 0; index < 28; index++ {
		text := fmt.Sprintf("workspace-service-ws-history-%02d", index)
		clientMessageID := fmt.Sprintf("workspace-service-ws-history-%d", index)
		requestBody, err := json.Marshal(map[string]any{
			"conversationId":  "conv-message-service-ws",
			"clientMessageId": clientMessageID,
			"content": map[string]any{
				"format":    "duallane.message+json;v=1",
				"plainText": text,
				"blocks": []map[string]any{{
					"type": "text", "text": text,
				}},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/api/workspace/messages", strings.NewReader(string(requestBody)))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Test-Actor", "usr_message_service_ws_owner")
		response, err := apiClient.Do(request)
		if err != nil {
			t.Fatalf("message API request %d: %v", index, err)
		}
		var responseBody struct {
			Message struct {
				ID string `json:"id"`
			} `json:"message"`
		}
		decodeErr := json.NewDecoder(response.Body).Decode(&responseBody)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusCreated || decodeErr != nil || responseBody.Message.ID == "" {
			t.Fatalf("message API response %d: status=%d decode=%v messageIDPresent=%t", index, response.StatusCode, decodeErr, responseBody.Message.ID != "")
		}
	}
	assertMessageServiceWSReadBatch(t, readResults, 1, 28)

	for index, client := range clients {
		if err := client.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSeq":28}`)); err != nil {
			t.Fatal(err)
		}
		ready, readErr := readMessageServiceWSFrame(ctx, client)
		if readErr != nil {
			t.Fatalf("WebSocket client %d repeated hello: %v", index, readErr)
		}
		if ready["type"] != "ready" || ready["currentSeq"] != float64(28) || ready["replayCount"] != float64(0) || ready["hasMore"] != false {
			t.Fatalf("WebSocket client %d repeated hello frame = %#v", index, ready)
		}
	}

	var messageCount, eventCount, eventMax int64
	if err := connection.QueryRow(ctx, `
		SELECT COUNT(*) FROM messages
		WHERE space_id = 'spc_default' AND conversation_id = 'conv-message-service-ws'
	`).Scan(&messageCount); err != nil {
		t.Fatal(err)
	}
	if err := connection.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(MAX(seq), 0)
		FROM workspace_events WHERE space_id = 'spc_default'
	`).Scan(&eventCount, &eventMax); err != nil {
		t.Fatal(err)
	}
	if messageCount != 28 || eventCount != 28 || eventMax != 28 {
		t.Fatalf("message service durable state = messages:%d events:%d maxSeq:%d, want 28/28/28", messageCount, eventCount, eventMax)
	}
}

type messageServiceWSResolver struct{}

func (messageServiceWSResolver) ResolveActor(_ context.Context, request *http.Request) (*workspaceAuth.Actor, error) {
	actorID := strings.TrimSpace(request.Header.Get("X-Test-Actor"))
	if actorID == "" {
		return nil, workspaceAuth.NewError(workspaceAuth.CodeRequired, workspaceAuth.MessageRequired, http.StatusUnauthorized)
	}
	return &workspaceAuth.Actor{ID: actorID, Kind: "human", Role: "member"}, nil
}

type messageServiceWSReadResult struct {
	index     int
	sequences []int64
	err       error
}

func startMessageServiceWSReaders(ctx context.Context, clients []*websocket.Conn, count int) <-chan messageServiceWSReadResult {
	results := make(chan messageServiceWSReadResult, len(clients))
	for index, client := range clients {
		index, client := index, client
		go func() {
			readCtx, readCancel := context.WithTimeout(ctx, 30*time.Second)
			defer readCancel()
			sequences, readErr := readMessageServiceWSHistory(readCtx, client, count)
			results <- messageServiceWSReadResult{index: index, sequences: sequences, err: readErr}
		}()
	}
	return results
}

func assertMessageServiceWSReadBatch(t *testing.T, results <-chan messageServiceWSReadResult, first, last int) {
	t.Helper()
	for index := 0; index < cap(results); index++ {
		result := <-results
		if result.err != nil {
			t.Fatalf("WebSocket client %d message service catch-up failed: %v", result.index, result.err)
		}
		wantCount := last - first + 1
		if len(result.sequences) != wantCount {
			t.Fatalf("WebSocket client %d received %d events, want %d", result.index, len(result.sequences), wantCount)
		}
		for offset, sequence := range result.sequences {
			want := int64(first + offset)
			if sequence != want {
				t.Fatalf("WebSocket client %d event %d has sequence %d, want %d", result.index, offset, sequence, want)
			}
		}
	}
}

func readMessageServiceWSHistory(ctx context.Context, connection *websocket.Conn, count int) ([]int64, error) {
	sequences := make([]int64, 0, count)
	for index := 0; index < count; index++ {
		frame, err := readMessageServiceWSFrame(ctx, connection)
		if err != nil {
			return nil, err
		}
		if frame["type"] != "event" {
			return nil, fmt.Errorf("unexpected message service realtime frame type %v after %d events", frame["type"], len(sequences))
		}
		event, ok := frame["event"].(map[string]any)
		if !ok {
			return nil, errors.New("message service realtime event frame has no event object")
		}
		if event["type"] != "message.created" {
			return nil, fmt.Errorf("message service realtime event type = %v, want message.created", event["type"])
		}
		sequence, ok := event["seq"].(float64)
		if !ok || sequence < 1 || sequence != float64(int64(sequence)) {
			return nil, errors.New("message service realtime event frame has invalid sequence")
		}
		wantSequence := int64(index + 1)
		if int64(sequence) != wantSequence {
			return nil, fmt.Errorf("message service realtime event sequence = %d, want %d", int64(sequence), wantSequence)
		}
		payload, ok := event["payload"].(map[string]any)
		if !ok {
			return nil, errors.New("message service realtime event frame has no payload object")
		}
		message, ok := payload["message"].(map[string]any)
		if !ok {
			return nil, errors.New("message service realtime event has no projected message")
		}
		messageID, ok := message["id"].(string)
		if !ok || strings.TrimSpace(messageID) == "" {
			return nil, errors.New("message service realtime event message has no id")
		}
		wantClientMessageID := fmt.Sprintf("workspace-service-ws-history-%d", index)
		if message["clientMessageId"] != wantClientMessageID || message["conversationId"] != "conv-message-service-ws" || message["authorId"] != "usr_message_service_ws_owner" || message["authorKind"] != "human" || message["kind"] != "user" {
			return nil, fmt.Errorf("message service realtime message identity mismatch at %d", index)
		}
		sequences = append(sequences, int64(sequence))
	}
	return sequences, nil
}

func readMessageServiceWSFrame(ctx context.Context, connection *websocket.Conn) (map[string]any, error) {
	messageType, raw, err := connection.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, fmt.Errorf("message service realtime frame type = %v", messageType)
	}
	var frame map[string]any
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil, err
	}
	return frame, nil
}

func awaitMessageServiceWSWakeup(t *testing.T, wakeup <-chan struct{}) {
	t.Helper()
	select {
	case <-wakeup:
	case <-time.After(5 * time.Second):
		t.Fatal("realtime listener did not publish startup wakeup")
	}
}

func messageServiceWSWebSocketURL(httpURL string) string {
	if strings.HasPrefix(httpURL, "https://") {
		return "wss://" + strings.TrimPrefix(httpURL, "https://")
	}
	return "ws://" + strings.TrimPrefix(httpURL, "http://")
}

func seedMessageServiceWSFixture(t *testing.T, ctx context.Context, connection *pgx.Conn) {
	t.Helper()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	for _, user := range []struct {
		id, login, name string
	}{
		{"usr_message_service_ws_owner", "message-service-ws-owner", "Message service WS owner"},
		{"usr_message_service_ws_member", "message-service-ws-member", "Message service WS member"},
	} {
		if _, err := connection.Exec(ctx, `
			INSERT INTO users (id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
			VALUES ($1, $2, $3, $4, $4, 'human', $5, $5)
		`, user.id, user.login, user.login+"@example.test", user.name, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := connection.Exec(ctx, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ('spc_default', 'Message service WebSocket', 'message-service-websocket', $1, $2)
	`, "usr_message_service_ws_owner", now); err != nil {
		t.Fatal(err)
	}
	for _, member := range []struct{ id, role string }{
		{"usr_message_service_ws_owner", "owner"},
		{"usr_message_service_ws_member", "member"},
	} {
		if _, err := connection.Exec(ctx, `
			INSERT INTO space_members (space_id, user_id, role, joined_at)
			VALUES ('spc_default', $1, $2, $3)
		`, member.id, member.role, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := connection.Exec(ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
		VALUES ('conv-message-service-ws', 'spc_default', 'direct', 'Message service WS', 'message-service-ws-direct', 10000, 'usr_message_service_ws_owner', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"usr_message_service_ws_owner", "usr_message_service_ws_member"} {
		if _, err := connection.Exec(ctx, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ('conv-message-service-ws', $1, $2)
		`, userID, now); err != nil {
			t.Fatal(err)
		}
	}
}
