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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceEvents "github.com/timestarry/duallane/apps/backend/internal/workspace/events"
)

// TestPGRealtimeWebSocketCatchupUsesDurableCursor exercises the complete
// listener -> hub -> handler session path against PostgreSQL. The two commits
// intentionally contain 8 and 20 events respectively, while the listener and
// Hub are allowed to coalesce their wake-ups. A replay page of five rows also
// forces the service to cross several storage batches. The tail then follows
// Node's Echo delivery order: card.created before the bot message that
// references that card. The only durable delivery signal asserted here is the
// ordered event cursor; message text is synthetic fixture data and is not
// included in failure output.
func TestPGRealtimeWebSocketCatchupUsesDurableCursor(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)

	connection, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_realtime_ws_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := connection.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := connection.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("clean synthetic realtime WebSocket schema: %v", err)
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
	seedRealtimeWebSocketFixture(t, ctx, connection)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	// The browser harness starts a listener beside a bounded Workspace pool.
	// Five connections leave four query slots while LISTEN is active, without
	// changing the production pool configuration.
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
	awaitWakeup(t, listenerWakeup, "listener startup")
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

	service := workspaceEvents.NewService(workspaceEvents.ServiceOptions{
		Repository:  workspaceEvents.NewPGRepository(pool),
		BatchSize:   5,
		ReplayLimit: 40,
	})
	server := httptest.NewServer(NewHandler(HandlerOptions{
		RootContext:       ctx,
		ActorResolver:     pgWebSocketResolver{},
		Events:            service,
		Hub:               hub,
		PollInterval:      time.Hour,
		HeartbeatInterval: time.Hour,
		IOTimeout:         5 * time.Second,
	}))
	defer server.Close()

	clients := make([]*websocket.Conn, 0, 2)
	for _, actorID := range []string{"usr_realtime_ws_owner", "usr_realtime_ws_member"} {
		client, _, dialErr := websocket.Dial(ctx, websocketURL(server.URL), &websocket.DialOptions{
			HTTPHeader: http.Header{"X-Test-Actor": []string{actorID}},
		})
		if dialErr != nil {
			t.Fatal(dialErr)
		}
		clients = append(clients, client)
		t.Cleanup(func() { _ = client.CloseNow() })
		if err := client.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSeq":0}`)); err != nil {
			t.Fatal(err)
		}
		ready, readErr := readPGWebSocketFrame(ctx, client)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if ready["type"] != "ready" || ready["currentSeq"] != float64(0) || ready["replayCount"] != float64(0) || ready["hasMore"] != false {
			t.Fatalf("initial ready frame = %#v", ready)
		}
	}

	firstReadResults := startPGWebSocketReaders(ctx, clients, 8)
	if err := insertRealtimeWebSocketBatch(ctx, connection, 1, 8); err != nil {
		t.Fatal(err)
	}
	assertPGWebSocketReadBatch(t, firstReadResults, 1, 8)

	// Keep the same sockets open for the second commit. This verifies that a
	// handler advances its private cursor from the first wake-up and replays
	// only the next durable range when the second notification arrives.
	secondReadResults := startPGWebSocketReaders(ctx, clients, 20)
	if err := insertRealtimeWebSocketBatch(ctx, connection, 9, 28); err != nil {
		t.Fatal(err)
	}
	assertPGWebSocketReadBatch(t, secondReadResults, 9, 28)

	// A repeated hello is the reconnect/session cursor contract. It must return
	// ready without replaying an event already delivered on the same socket.
	for index, client := range clients {
		if err := client.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSeq":28}`)); err != nil {
			t.Fatal(err)
		}
		ready, readErr := readPGWebSocketFrame(ctx, client)
		if readErr != nil {
			t.Fatalf("WebSocket client %d repeated hello: %v", index, readErr)
		}
		if ready["type"] != "ready" || ready["currentSeq"] != float64(28) || ready["replayCount"] != float64(0) || ready["hasMore"] != false {
			t.Fatalf("WebSocket client %d repeated hello frame = %#v", index, ready)
		}
	}

	echoReadResults := startPGWebSocketEchoReaders(ctx, clients)
	if err := insertRealtimeWebSocketEchoBatch(ctx, connection, 29); err != nil {
		t.Fatal(err)
	}
	assertPGWebSocketReadBatch(t, echoReadResults, 29, 30)

	for index, client := range clients {
		if err := client.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSeq":30}`)); err != nil {
			t.Fatal(err)
		}
		ready, readErr := readPGWebSocketFrame(ctx, client)
		if readErr != nil {
			t.Fatalf("WebSocket client %d repeated Echo hello: %v", index, readErr)
		}
		if ready["type"] != "ready" || ready["currentSeq"] != float64(30) || ready["replayCount"] != float64(0) || ready["hasMore"] != false {
			t.Fatalf("WebSocket client %d repeated Echo hello frame = %#v", index, ready)
		}
	}

	var durableCount, durableMax int64
	if err := connection.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(MAX(seq), 0)
		FROM workspace_events WHERE space_id = 'spc_default'
	`).Scan(&durableCount, &durableMax); err != nil {
		t.Fatal(err)
	}
	if durableCount != 30 || durableMax != 30 {
		t.Fatalf("durable event window = count:%d max:%d, want count:30 max:30", durableCount, durableMax)
	}
}

type pgWebSocketResolver struct{}

func (pgWebSocketResolver) ResolveActor(_ context.Context, request *http.Request) (*auth.Actor, error) {
	actorID := strings.TrimSpace(request.Header.Get("X-Test-Actor"))
	if actorID == "" {
		return nil, auth.NewError(auth.CodeRequired, auth.MessageRequired, http.StatusUnauthorized)
	}
	return &auth.Actor{ID: actorID, Kind: "human", Role: "member"}, nil
}

type pgWebSocketReadResult struct {
	index     int
	sequences []int64
	err       error
}

func startPGWebSocketReaders(ctx context.Context, clients []*websocket.Conn, count int) <-chan pgWebSocketReadResult {
	results := make(chan pgWebSocketReadResult, len(clients))
	for index, client := range clients {
		index, client := index, client
		go func() {
			readCtx, readCancel := context.WithTimeout(ctx, 20*time.Second)
			defer readCancel()
			sequences, readErr := readPGWebSocketEvents(readCtx, client, count)
			results <- pgWebSocketReadResult{index: index, sequences: sequences, err: readErr}
		}()
	}
	return results
}

func startPGWebSocketEchoReaders(ctx context.Context, clients []*websocket.Conn) <-chan pgWebSocketReadResult {
	results := make(chan pgWebSocketReadResult, len(clients))
	for index, client := range clients {
		index, client := index, client
		go func() {
			readCtx, readCancel := context.WithTimeout(ctx, 20*time.Second)
			defer readCancel()
			sequences, readErr := readPGWebSocketEchoEvents(readCtx, client)
			results <- pgWebSocketReadResult{index: index, sequences: sequences, err: readErr}
		}()
	}
	return results
}

func assertPGWebSocketReadBatch(t *testing.T, results <-chan pgWebSocketReadResult, first, last int) {
	t.Helper()
	for index := 0; index < cap(results); index++ {
		result := <-results
		if result.err != nil {
			t.Fatalf("WebSocket client %d catch-up failed: %v", result.index, result.err)
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

func readPGWebSocketEvents(ctx context.Context, connection *websocket.Conn, count int) ([]int64, error) {
	sequences := make([]int64, 0, count)
	for len(sequences) < count {
		frame, err := readPGWebSocketFrame(ctx, connection)
		if err != nil {
			return nil, err
		}
		if frame["type"] != "event" {
			return nil, fmt.Errorf("unexpected realtime frame type %v after %d events", frame["type"], len(sequences))
		}
		event, ok := frame["event"].(map[string]any)
		if !ok {
			return nil, errors.New("realtime event frame has no event object")
		}
		payload, ok := event["payload"].(map[string]any)
		if !ok {
			return nil, errors.New("realtime event frame has no payload object")
		}
		message, ok := payload["message"].(map[string]any)
		messageID, messageIDOK := message["id"].(string)
		if !ok || !messageIDOK || strings.TrimSpace(messageID) == "" {
			return nil, errors.New("realtime message event has no projected message")
		}
		sequence, ok := event["seq"].(float64)
		if !ok || sequence < 1 || sequence != float64(int64(sequence)) {
			return nil, errors.New("realtime event frame has invalid sequence")
		}
		sequences = append(sequences, int64(sequence))
	}
	return sequences, nil
}

func readPGWebSocketEchoEvents(ctx context.Context, connection *websocket.Conn) ([]int64, error) {
	sequences := make([]int64, 0, 2)
	wantTypes := []string{"card.created", "message.created"}
	for index, wantType := range wantTypes {
		frame, err := readPGWebSocketFrame(ctx, connection)
		if err != nil {
			return nil, err
		}
		if frame["type"] != "event" {
			return nil, fmt.Errorf("unexpected Echo realtime frame type %v after %d events", frame["type"], len(sequences))
		}
		event, ok := frame["event"].(map[string]any)
		if !ok {
			return nil, errors.New("Echo realtime event frame has no event object")
		}
		eventType, ok := event["type"].(string)
		if !ok || eventType != wantType {
			return nil, fmt.Errorf("Echo realtime event %d type = %v, want %s", index, event["type"], wantType)
		}
		sequence, ok := event["seq"].(float64)
		if !ok || sequence < 1 || sequence != float64(int64(sequence)) {
			return nil, errors.New("Echo realtime event frame has invalid sequence")
		}
		wantSequence := int64(29 + index)
		if int64(sequence) != wantSequence {
			return nil, fmt.Errorf("Echo realtime event %s sequence = %d, want %d", wantType, int64(sequence), wantSequence)
		}
		payload, ok := event["payload"].(map[string]any)
		if !ok {
			return nil, errors.New("Echo realtime event frame has no payload object")
		}
		switch wantType {
		case "card.created":
			if err := validatePGWebSocketEchoCardPayload(payload); err != nil {
				return nil, err
			}
		case "message.created":
			if err := validatePGWebSocketEchoMessagePayload(payload); err != nil {
				return nil, err
			}
		}
		sequences = append(sequences, int64(sequence))
	}
	return sequences, nil
}

func validatePGWebSocketEchoCardPayload(payload map[string]any) error {
	if payload["cardId"] != "card-realtime-echo" || payload["cardType"] != "echo.release" || payload["status"] != "active" {
		return fmt.Errorf("Echo card payload identity/status mismatch: cardId=%v cardType=%v status=%v", payload["cardId"], payload["cardType"], payload["status"])
	}
	if payload["revision"] != float64(1) {
		return fmt.Errorf("Echo card payload revision = %v, want 1", payload["revision"])
	}
	return nil
}

func validatePGWebSocketEchoMessagePayload(payload map[string]any) error {
	message, ok := payload["message"].(map[string]any)
	if !ok {
		return errors.New("Echo message event has no projected message")
	}
	for key, want := range map[string]any{
		"id":             "msg-realtime-echo",
		"conversationId": "conv-realtime-ws",
		"authorId":       "usr_system_echo",
		"authorName":     "回声",
		"authorKind":     "bot",
		"kind":           "bot",
		"plainText":      "Echo release v0.15.1",
	} {
		if message[key] != want {
			return fmt.Errorf("Echo message %s = %v, want %v", key, message[key], want)
		}
	}
	if message["authorAvatarUrl"] != "/assets/echo-avatar.svg" {
		return fmt.Errorf("Echo message avatar = %v, want canonical asset", message["authorAvatarUrl"])
	}
	content, ok := message["content"].(map[string]any)
	if !ok || content["format"] != "duallane.message+json;v=1" {
		return errors.New("Echo message has no canonical content envelope")
	}
	blocks, ok := content["blocks"].([]any)
	if !ok || len(blocks) != 1 {
		return fmt.Errorf("Echo message projected blocks = %v, want one card block", content["blocks"])
	}
	block, ok := blocks[0].(map[string]any)
	if !ok {
		return errors.New("Echo message card block is not an object")
	}
	for key, want := range map[string]any{
		"type":          "card",
		"cardId":        "card-realtime-echo",
		"cardType":      "echo.release",
		"schemaVersion": float64(1),
		"fallbackText":  "Echo release v0.15.1",
	} {
		if block[key] != want {
			return fmt.Errorf("Echo card block %s = %v, want %v", key, block[key], want)
		}
	}
	return nil
}

func readPGWebSocketFrame(ctx context.Context, connection *websocket.Conn) (map[string]any, error) {
	messageType, raw, err := connection.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, fmt.Errorf("realtime frame type = %v", messageType)
	}
	var frame map[string]any
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil, err
	}
	return frame, nil
}

func seedRealtimeWebSocketFixture(t *testing.T, ctx context.Context, connection *pgx.Conn) {
	t.Helper()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	for _, user := range []struct {
		id, login, name string
	}{
		{"usr_realtime_ws_owner", "realtime-ws-owner", "Realtime WS owner"},
		{"usr_realtime_ws_member", "realtime-ws-member", "Realtime WS member"},
	} {
		if _, err := connection.Exec(ctx, `
			INSERT INTO users (id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
			VALUES ($1, $2, $3, $4, $4, 'human', $5, $5)
		`, user.id, user.login, user.login+"@example.test", user.name, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := connection.Exec(ctx, `
		INSERT INTO users (id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
		VALUES ('usr_system_echo', '__duallane_echo__', NULL, '回声', '回声', 'bot', $1, NULL)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Exec(ctx, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ('spc_default', 'Realtime WebSocket', 'realtime-websocket', $1, $2)
	`, "usr_realtime_ws_owner", now); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"usr_realtime_ws_owner", "usr_realtime_ws_member", "usr_system_echo"} {
		if _, err := connection.Exec(ctx, `
			INSERT INTO space_members (space_id, user_id, role, joined_at)
			VALUES ('spc_default', $1, $2, $3)
		`, userID, map[string]string{
			"usr_realtime_ws_owner":  "owner",
			"usr_realtime_ws_member": "member",
			"usr_system_echo":        "member",
		}[userID], now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := connection.Exec(ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ('conv-realtime-ws', 'spc_default', 'direct', 'Realtime WS', 'realtime-ws-direct', 'usr_realtime_ws_owner', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"usr_realtime_ws_owner", "usr_realtime_ws_member", "usr_system_echo"} {
		if _, err := connection.Exec(ctx, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ('conv-realtime-ws', $1, $2)
		`, userID, now); err != nil {
			t.Fatal(err)
		}
	}
}

func insertRealtimeWebSocketBatch(ctx context.Context, connection *pgx.Conn, first, last int) error {
	transaction, err := connection.Begin(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = transaction.Rollback(context.Background())
		}
	}()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	for index := first; index <= last; index++ {
		messageID := fmt.Sprintf("msg-realtime-ws-%02d", index)
		text := fmt.Sprintf("realtime-history-%02d", index)
		content, err := json.Marshal(map[string]any{
			"format":    "duallane.message+json;v=1",
			"plainText": text,
			"blocks": []map[string]any{{
				"type": "text",
				"text": text,
			}},
		})
		if err != nil {
			return err
		}
		createdAt := now.Add(time.Duration(index) * time.Second)
		if _, err := transaction.Exec(ctx, `
			INSERT INTO messages (
				id, space_id, conversation_id, author_id, author_kind, kind,
				client_message_id, content_format, content_json, plain_text, created_at
			) VALUES ($1, 'spc_default', 'conv-realtime-ws', 'usr_realtime_ws_owner', 'human', 'user', $2,
				'duallane.message+json;v=1', $3, $4, $5)
		`, messageID, "client-"+messageID, string(content), text, createdAt); err != nil {
			return err
		}
		payload := fmt.Sprintf(`{"messageId":%q,"conversationId":"conv-realtime-ws"}`, messageID)
		if _, err := transaction.Exec(ctx, `
			INSERT INTO workspace_events (
				id, space_id, seq, type, actor_user_id, conversation_id,
				target_type, target_id, payload_json, created_at
			) VALUES ($1, 'spc_default', $2, 'message.created', 'usr_realtime_ws_owner', 'conv-realtime-ws',
				'message', $3, $4, $5)
		`, "evt-realtime-ws-"+fmt.Sprintf("%02d", index), index, messageID, payload, createdAt); err != nil {
			return err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

func insertRealtimeWebSocketEchoBatch(ctx context.Context, connection *pgx.Conn, sequence int64) error {
	transaction, err := connection.Begin(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = transaction.Rollback(context.Background())
		}
	}()
	now := time.Date(2026, 9, 6, 12, 1, 0, 0, time.UTC)
	cardID := "card-realtime-echo"
	messageID := "msg-realtime-echo"
	fallbackText := "Echo release v0.15.1"
	cardPayload := `{"version":"v0.15.1","title":"Synthetic Echo release"}`
	messageContent, err := json.Marshal(map[string]any{
		"format":    "duallane.message+json;v=1",
		"plainText": fallbackText,
		"blocks": []map[string]any{{
			"type": "card", "cardId": cardID, "cardType": "echo.release",
			"schemaVersion": 1, "fallbackText": fallbackText,
		}},
	})
	if err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO workspace_cards (
			id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text,
			source_kind, source_id, resource_type, resource_id, visibility_scope,
			created_by_user_id, status, revision, expires_at, created_at, updated_at
		) VALUES ($1, 'spc_default', 'conv-realtime-ws', 'echo.release', 1, $2, $3,
			'echo', 'echo-realtime-release-v0.15.1', 'echo.release', 'v0.15.1', 'conversation',
			'usr_system_echo', 'active', 1, NULL, $4, $4)
	`, cardID, cardPayload, fallbackText, now); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		) VALUES ('evt-realtime-echo-card', 'spc_default', $1, 'card.created', 'usr_system_echo', 'conv-realtime-ws',
			'workspace.card', $2, $3, $4)
	`, sequence, cardID, `{"cardId":"card-realtime-echo","cardType":"echo.release","revision":1,"status":"active"}`, now); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES ($1, 'spc_default', 'conv-realtime-ws', 'usr_system_echo', 'bot', 'bot', $2,
			'duallane.message+json;v=1', $3, $4, $5)
	`, messageID, "echo-realtime-release-v0.15.1", string(messageContent), fallbackText, now.Add(time.Second)); err != nil {
		return err
	}
	messagePayload := `{"messageId":"msg-realtime-echo","conversationId":"conv-realtime-ws"}`
	if _, err := transaction.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		) VALUES ('evt-realtime-echo-message', 'spc_default', $1, 'message.created', 'usr_system_echo', 'conv-realtime-ws',
			'message', $2, $3, $4)
	`, sequence+1, messageID, messagePayload, now.Add(time.Second)); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}
