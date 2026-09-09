//go:build postgres_integration

package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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

// TestPGRealtimeWebSocketReactionRemoveThroughMessageServiceAPI exercises the
// same write and transport boundary used by the Workspace process. The
// message is created through the HTTP API, then both reaction mutations are
// also issued through HTTP; this test never inserts a message or event row
// directly. Each authenticated WebSocket must observe the committed remove
// event with its own current reaction projection.
func TestPGRealtimeWebSocketReactionRemoveThroughMessageServiceAPI(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_reaction_service_ws_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := connection.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := connection.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("clean synthetic reaction WebSocket schema: %v", err)
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
	seedReactionServiceWSFixture(t, ctx, connection)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	// Keep the synthetic run close to the browser composition: one listener
	// connection and a small pool shared by the API and two WS projectors.
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
	t.Cleanup(unsubscribe)
	listenerContext, stopListener := context.WithCancel(context.Background())
	listenerDone := make(chan error, 1)
	go func() {
		listenerDone <- NewPGListener(ListenerOptions{
			Pool: pool, Hub: hub, ReconnectMinimum: 10 * time.Millisecond, ReconnectMaximum: 50 * time.Millisecond,
		}).Run(listenerContext)
	}()
	awaitReactionServiceWSWakeup(t, listenerWakeup)
	t.Cleanup(func() {
		stopListener()
		select {
		case listenerErr := <-listenerDone:
			if listenerErr != nil {
				t.Errorf("stop reaction realtime listener: %v", listenerErr)
			}
		case <-time.After(3 * time.Second):
			t.Errorf("reaction realtime listener did not stop after cancellation")
		}
	})

	const (
		ownerID  = "usr_reaction_service_ws_owner"
		memberID = "usr_reaction_service_ws_member"
	)
	eventService := workspaceEvents.NewService(workspaceEvents.ServiceOptions{
		Repository: workspaceEvents.NewPGRepository(pool),
		BatchSize:  8,
	})
	messageService := workspaceMessages.NewService(workspaceMessages.ServiceOptions{
		Repository:             workspaceMessages.NewPGRepository(pool),
		SpaceID:                workspaceMessages.DefaultSpaceID,
		Now:                    func() time.Time { return time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC) },
		ReactionEmoteValidator: reactionServiceWSCatalog{},
	})
	resolver := reactionServiceWSResolver{}
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
	t.Cleanup(server.Close)

	messageID := createReactionServiceWSMessage(t, ctx, server.URL, ownerID)
	clients := make(map[string]*websocket.Conn, 2)
	for _, actorID := range []string{ownerID, memberID} {
		client, _, dialErr := websocket.Dial(ctx, reactionServiceWSWebSocketURL(server.URL), &websocket.DialOptions{
			HTTPHeader: http.Header{"X-Test-Actor": []string{actorID}},
		})
		if dialErr != nil {
			t.Fatal(dialErr)
		}
		clients[actorID] = client
		t.Cleanup(func() { _ = client.CloseNow() })
		if err := client.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSeq":1}`)); err != nil {
			t.Fatal(err)
		}
		ready, readErr := readReactionServiceWSFrame(ctx, client)
		if readErr != nil {
			t.Fatalf("initial %s ready: %v", actorID, readErr)
		}
		if ready["type"] != "ready" || ready["currentSeq"] != float64(1) || ready["replayCount"] != float64(0) || ready["hasMore"] != false {
			t.Fatalf("initial %s ready frame = %#v", actorID, ready)
		}
	}

	addMember := postReactionServiceWSReaction(t, ctx, server.URL, http.MethodPost, memberID, messageID, "")
	if addMember.status != http.StatusCreated {
		t.Fatalf("member add status = %d, body=%s", addMember.status, addMember.body)
	}
	assertReactionServiceWSEvent(t, ctx, clients[memberID], "reaction.added", 2, messageID, memberID, []string{memberID}, true)
	assertReactionServiceWSEvent(t, ctx, clients[ownerID], "reaction.added", 2, messageID, memberID, []string{memberID}, false)

	addOwner := postReactionServiceWSReaction(t, ctx, server.URL, http.MethodPost, ownerID, messageID, "")
	if addOwner.status != http.StatusCreated {
		t.Fatalf("owner add status = %d, body=%s", addOwner.status, addOwner.body)
	}
	assertReactionServiceWSEvent(t, ctx, clients[memberID], "reaction.added", 3, messageID, ownerID, []string{memberID, ownerID}, true)
	assertReactionServiceWSEvent(t, ctx, clients[ownerID], "reaction.added", 3, messageID, ownerID, []string{memberID, ownerID}, true)

	removeMember := postReactionServiceWSReaction(t, ctx, server.URL, http.MethodDelete, memberID, messageID, "builtin:heart")
	if removeMember.status != http.StatusOK {
		t.Fatalf("member remove status = %d, body=%s", removeMember.status, removeMember.body)
	}
	// The remove event must be visible to both viewers and must carry the
	// committed post-delete snapshot, not the pre-delete two-user state.
	assertReactionServiceWSEvent(t, ctx, clients[memberID], "reaction.removed", 4, messageID, memberID, []string{ownerID}, false)
	assertReactionServiceWSEvent(t, ctx, clients[ownerID], "reaction.removed", 4, messageID, memberID, []string{ownerID}, true)

	// A reconnecting owner must be able to recover the same committed remove
	// from the durable replay window even when the live notification was missed.
	replayOwner, _, dialErr := websocket.Dial(ctx, reactionServiceWSWebSocketURL(server.URL), &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Test-Actor": []string{ownerID}},
	})
	if dialErr != nil {
		t.Fatal(dialErr)
	}
	t.Cleanup(func() { _ = replayOwner.CloseNow() })
	if err := replayOwner.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSeq":3}`)); err != nil {
		t.Fatal(err)
	}
	ready, readErr := readReactionServiceWSFrame(ctx, replayOwner)
	if readErr != nil {
		t.Fatalf("replay owner ready: %v", readErr)
	}
	if ready["type"] != "ready" || ready["currentSeq"] != float64(4) || ready["replayCount"] != float64(1) || ready["hasMore"] != false {
		t.Fatalf("replay owner ready frame = %#v", ready)
	}
	assertReactionServiceWSEvent(t, ctx, replayOwner, "reaction.removed", 4, messageID, memberID, []string{ownerID}, true)

	var reactionRows, eventRows int
	if err := connection.QueryRow(ctx, `
		SELECT COUNT(*) FROM message_reactions
		WHERE message_id = $1
	`, messageID).Scan(&reactionRows); err != nil {
		t.Fatal(err)
	}
	if err := connection.QueryRow(ctx, `
		SELECT COUNT(*) FROM workspace_events
		WHERE target_id = $1 AND type IN ('reaction.added', 'reaction.removed')
	`, messageID).Scan(&eventRows); err != nil {
		t.Fatal(err)
	}
	if reactionRows != 1 || eventRows != 3 {
		t.Fatalf("reaction durable state = rows:%d events:%d, want 1/3", reactionRows, eventRows)
	}
}

type reactionServiceWSResolver struct{}

func (reactionServiceWSResolver) ResolveActor(_ context.Context, request *http.Request) (*workspaceAuth.Actor, error) {
	actorID := strings.TrimSpace(request.Header.Get("X-Test-Actor"))
	switch actorID {
	case "usr_reaction_service_ws_owner":
		return &workspaceAuth.Actor{ID: actorID, Kind: "human", Role: "owner"}, nil
	case "usr_reaction_service_ws_member":
		return &workspaceAuth.Actor{ID: actorID, Kind: "human", Role: "member"}, nil
	default:
		return nil, workspaceAuth.NewError(workspaceAuth.CodeRequired, workspaceAuth.MessageRequired, http.StatusUnauthorized)
	}
}

type reactionServiceWSCatalog struct{}

func (reactionServiceWSCatalog) IsVisibleReactionEmote(_ context.Context, emoteKey string) (bool, error) {
	return emoteKey == "builtin:heart", nil
}

func (reactionServiceWSCatalog) IsKnownReactionEmote(_ context.Context, emoteKey string) (bool, error) {
	return emoteKey == "builtin:heart", nil
}

func createReactionServiceWSMessage(t *testing.T, ctx context.Context, serverURL, actorID string) string {
	t.Helper()
	body := strings.NewReader(`{"conversationId":"conv-reaction-service-ws","clientMessageId":"reaction-service-ws-message","content":{"format":"duallane.message+json;v=1","plainText":"reaction service WebSocket","blocks":[{"type":"text","text":"reaction service WebSocket"}]}}`)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, serverURL+"/api/workspace/messages", body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Test-Actor", actorID)
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var payload struct {
		Message struct {
			ID string `json:"id"`
		} `json:"message"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode reaction service message response: %v", err)
	}
	if response.StatusCode != http.StatusCreated || payload.Message.ID == "" {
		t.Fatalf("reaction service message response status=%d id=%q", response.StatusCode, payload.Message.ID)
	}
	return payload.Message.ID
}

type reactionServiceWSHTTPResult struct {
	status int
	body   string
}

func postReactionServiceWSReaction(t *testing.T, ctx context.Context, serverURL, method, actorID, messageID, emoteKey string) reactionServiceWSHTTPResult {
	t.Helper()
	path := serverURL + "/api/workspace/messages/" + messageID + "/reactions"
	body := ""
	if method == http.MethodDelete {
		path += "/" + emoteKey
	} else {
		body = `{"emoteKey":"builtin:heart"}`
	}
	request, err := http.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Test-Actor", actorID)
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	contents, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		t.Fatalf("decode reaction response: %v", readErr)
	}
	return reactionServiceWSHTTPResult{status: response.StatusCode, body: string(contents)}
}

func assertReactionServiceWSEvent(t *testing.T, ctx context.Context, connection *websocket.Conn, eventType string, sequence int64, messageID, actorID string, userIDs []string, reacted bool) {
	t.Helper()
	frame, err := readReactionServiceWSFrame(ctx, connection)
	if err != nil {
		t.Fatal(err)
	}
	if frame["type"] != "event" {
		t.Fatalf("reaction event frame type = %#v", frame)
	}
	event, ok := frame["event"].(map[string]any)
	if !ok {
		t.Fatalf("reaction event has no event object: %#v", frame)
	}
	if event["type"] != eventType || event["seq"] != float64(sequence) || event["actorId"] != actorID {
		t.Fatalf("reaction event identity = %#v, want type=%s seq=%d actor=%s", event, eventType, sequence, actorID)
	}
	payload, ok := event["payload"].(map[string]any)
	if !ok || payload["messageId"] != messageID || payload["conversationId"] != "conv-reaction-service-ws" {
		t.Fatalf("reaction event payload = %#v", event["payload"])
	}
	groups, ok := payload["reactions"].([]any)
	if !ok || len(groups) != 1 {
		t.Fatalf("reaction groups = %#v", payload["reactions"])
	}
	group, ok := groups[0].(map[string]any)
	if !ok || group["emoteKey"] != "builtin:heart" || group["count"] != float64(len(userIDs)) || group["reactedByCurrentUser"] != reacted {
		t.Fatalf("reaction group = %#v", groups[0])
	}
	users, ok := group["users"].([]any)
	if !ok || len(users) != len(userIDs) {
		t.Fatalf("reaction users = %#v", group["users"])
	}
	for index, wantID := range userIDs {
		user, ok := users[index].(map[string]any)
		if !ok || user["id"] != wantID {
			t.Fatalf("reaction user %d = %#v, want %s", index, users[index], wantID)
		}
	}
}

func readReactionServiceWSFrame(ctx context.Context, connection *websocket.Conn) (map[string]any, error) {
	readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	messageType, raw, err := connection.Read(readCtx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, fmt.Errorf("reaction service WebSocket frame type = %v", messageType)
	}
	var frame map[string]any
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil, err
	}
	return frame, nil
}

func awaitReactionServiceWSWakeup(t *testing.T, wakeup <-chan struct{}) {
	t.Helper()
	select {
	case <-wakeup:
	case <-time.After(5 * time.Second):
		t.Fatal("reaction realtime listener did not publish startup wakeup")
	}
}

func reactionServiceWSWebSocketURL(httpURL string) string {
	if strings.HasPrefix(httpURL, "https://") {
		return "wss://" + strings.TrimPrefix(httpURL, "https://") + "/ws/workspace"
	}
	return "ws://" + strings.TrimPrefix(httpURL, "http://") + "/ws/workspace"
}

func seedReactionServiceWSFixture(t *testing.T, ctx context.Context, connection *pgx.Conn) {
	t.Helper()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	for _, user := range []struct{ id, login, name string }{
		{"usr_reaction_service_ws_owner", "reaction-service-ws-owner", "Reaction service WS owner"},
		{"usr_reaction_service_ws_member", "reaction-service-ws-member", "Reaction service WS member"},
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
		VALUES ('spc_default', 'Reaction service WebSocket', 'reaction-service-websocket', $1, $2)
	`, "usr_reaction_service_ws_owner", now); err != nil {
		t.Fatal(err)
	}
	for _, member := range []struct{ id, role string }{
		{"usr_reaction_service_ws_owner", "owner"},
		{"usr_reaction_service_ws_member", "member"},
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
		VALUES ('conv-reaction-service-ws', 'spc_default', 'direct', 'Reaction service WS', 'reaction-service-ws-direct', 10000, 'usr_reaction_service_ws_owner', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"usr_reaction_service_ws_owner", "usr_reaction_service_ws_member"} {
		if _, err := connection.Exec(ctx, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ('conv-reaction-service-ws', $1, $2)
		`, userID, now); err != nil {
			t.Fatal(err)
		}
	}
}
