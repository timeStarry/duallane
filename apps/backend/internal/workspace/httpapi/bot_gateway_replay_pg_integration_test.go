//go:build postgres_integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/sdkgate"
)

const (
	gatewayReplayAfter   = 41
	gatewayReplayNoise   = 1047
	gatewayReplayQueued  = gatewayReplayAfter + 3 + gatewayReplayNoise
	gatewayReplayHead    = gatewayReplayQueued + 5
	gatewayReplayGroup   = "replay-group"
	gatewayReplayRevoked = "replay-revoked-group"
	gatewayReplayBot     = "bot-botgateway"
	gatewayReplayBotUser = "user-botgateway"
	gatewayReplaySender  = "user-owner-botgateway"
)

func TestBotGatewayHTTPReplayKeepsQueuedAcrossUnrelatedEvents(t *testing.T) {
	fixture := openGatewayReplayFixture(t)
	initial := fixture.getUpdates(t, gatewayReplayAfter, 50)
	if initial.SyncRequired || initial.HasMore || initial.CurrentSequence != gatewayReplayHead || len(initial.Events) != 1 {
		t.Fatalf("updates suppressed authorized pending work: %+v", initial)
	}
	if initial.ResumeSequence != gatewayReplayHead {
		t.Fatalf("resume sequence = %d, want certified head %d", initial.ResumeSequence, gatewayReplayHead)
	}
	assertGatewayReplayEvent(t, initial.Events[0], gatewayReplayQueued, "queued", "replay-delivery-queued")

	retry := fixture.getUpdates(t, gatewayReplayAfter, 50)
	if retry.SyncRequired || len(retry.Events) != 1 {
		t.Fatalf("retry from unacknowledged cursor = %+v", retry)
	}
	assertGatewayReplayEvent(t, retry.Events[0], gatewayReplayQueued, "queued", "replay-delivery-queued")

	if fixture.acknowledgeHTTP(t, gatewayReplayAfter+1, "expired").Acknowledged {
		t.Fatal("an expired delivery was acknowledged")
	}
	for range 2 {
		ack := fixture.acknowledgeHTTP(t, gatewayReplayQueued, "queued")
		if !ack.Acknowledged || ack.EventID != "replay-event-queued" || ack.Sequence != gatewayReplayQueued {
			t.Fatalf("acknowledgement was not idempotent: %+v", ack)
		}
	}
	exhausted := fixture.getUpdates(t, gatewayReplayAfter, 50)
	if !exhausted.SyncRequired || exhausted.Reason != "replay_window_exceeded" || exhausted.HasMore ||
		len(exhausted.Events) != 0 || exhausted.ResumeSequence != exhausted.CurrentSequence || exhausted.ResumeSequence < gatewayReplayHead {
		t.Fatalf("exhausted delivery gap did not certify safe continuation: %+v", exhausted)
	}
	resumed := fixture.getUpdates(t, exhausted.ResumeSequence, 50)
	if resumed.SyncRequired || resumed.HasMore || len(resumed.Events) != 0 {
		t.Fatalf("sync repeated after certified continuation: %+v", resumed)
	}
	fixture.assertDrained(t, map[string]int{"queued": 2})
}

func TestBotGatewayHTTPReplayResumeDoesNotCrossUnreturnedTrigger(t *testing.T) {
	fixture := openGatewayReplayFixture(t)
	sequence := fixture.appendLateTrigger(t)

	first := fixture.getUpdates(t, gatewayReplayAfter, 1)
	if first.SyncRequired || !first.HasMore || len(first.Events) != 1 ||
		first.CurrentSequence != sequence+gatewayReplayNoise || first.ResumeSequence < gatewayReplayQueued || first.ResumeSequence >= sequence {
		t.Fatalf("first replay page skipped pending work in its resume sequence: %+v", first)
	}
	assertGatewayReplayEvent(t, first.Events[0], gatewayReplayQueued, "queued", "replay-delivery-queued")
	if !fixture.acknowledgeHTTP(t, gatewayReplayQueued, "queued").Acknowledged {
		t.Fatal("first replay page was not acknowledged")
	}
	second := fixture.getUpdates(t, first.ResumeSequence, 1)
	if second.SyncRequired || second.HasMore || len(second.Events) != 1 || second.ResumeSequence != second.CurrentSequence {
		t.Fatalf("replay did not return the remaining work: %+v", second)
	}
	assertGatewayReplayEvent(t, second.Events[0], sequence, "late", "")
	if !fixture.acknowledgeHTTP(t, sequence, "late").Acknowledged {
		t.Fatal("second replay page was not acknowledged")
	}
	fixture.assertDrained(t, map[string]int{"queued": 1, "late": 1})
}

func TestBotGatewayWebSocketReplayKeepsQueuedAcrossUnrelatedEvents(t *testing.T) {
	fixture := openGatewayReplayFixture(t)
	connectAndReadQueued := func() *websocket.Conn {
		socket := fixture.dialWebSocket(t)
		writeGatewayReplayFrame(t, socket, map[string]any{"version": 1, "type": "hello", "lastSequence": gatewayReplayAfter})

		ready := readGatewayReplayFrame(t, socket)
		if ready.Type != "ready" || ready.CurrentSequence != gatewayReplayHead || ready.ReplayCount != 1 || ready.HasMore {
			t.Fatalf("hello suppressed authorized pending work: %+v", ready)
		}
		frame := readGatewayReplayFrame(t, socket)
		if frame.Type != "event" || frame.Event == nil {
			t.Fatalf("pending event frame = %+v", frame)
		}
		assertGatewayReplayEvent(t, *frame.Event, gatewayReplayQueued, "queued", "replay-delivery-queued")
		return socket
	}

	first := connectAndReadQueued()
	if err := first.CloseNow(); err != nil {
		t.Fatal(err)
	}
	socket := connectAndReadQueued()
	for range 2 {
		acknowledgeGatewayReplaySocket(t, socket, gatewayReplayQueued, "queued")
	}
	if err := socket.CloseNow(); err != nil {
		t.Fatal(err)
	}

	socket = fixture.dialWebSocket(t)
	writeGatewayReplayFrame(t, socket, map[string]any{"version": 1, "type": "hello", "lastSequence": gatewayReplayAfter})
	gap := readGatewayReplayFrame(t, socket)
	if gap.Type != "sync_required" || gap.Reason != "replay_window_exceeded" ||
		gap.ResumeSequence != gap.CurrentSequence || gap.ResumeSequence < gatewayReplayHead {
		t.Fatalf("exhausted WebSocket gap did not certify safe continuation: %+v", gap)
	}

	sequence := fixture.appendLateTrigger(t)
	frame := readGatewayReplayFrame(t, socket)
	if frame.Type != "event" || frame.Event == nil {
		t.Fatalf("poll skipped the new trigger behind unrelated traffic: %+v", frame)
	}
	assertGatewayReplayEvent(t, *frame.Event, sequence, "late", "")
	acknowledgeGatewayReplaySocket(t, socket, sequence, "late")
	fixture.assertDrained(t, map[string]int{"queued": 2, "late": 1})
}

type gatewayReplayFixture struct {
	pool   *pgxpool.Pool
	server *httptest.Server
	token  string
	now    time.Time
}

func openGatewayReplayFixture(t *testing.T) gatewayReplayFixture {
	t.Helper()
	ctx, pool, token := openBotGatewayHTTPFallbackDatabase(t)
	now := time.Date(2026, 9, 6, 12, 10, 0, 0, time.UTC)
	joinedAt := now.Add(-10 * time.Minute)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, group := range []string{gatewayReplayGroup, gatewayReplayRevoked} {
		execGatewayReplay(t, ctx, tx, `
			INSERT INTO conversations (id, space_id, type, title, created_by, created_at)
			VALUES ($1, $2, 'group', 'Synthetic replay group', $3, $4)
		`, group, botgateway.DefaultSpaceID, gatewayReplaySender, joinedAt)
		execGatewayReplay(t, ctx, tx, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ($1, $2, $4), ($1, $3, $4)
		`, group, gatewayReplaySender, gatewayReplayBotUser, joinedAt)
		execGatewayReplay(t, ctx, tx, `
			INSERT INTO workspace_agent_bot_group_policies (bot_id, space_id, conversation_id, status, created_at, updated_at)
			VALUES ($1, $2, $3, 'active', $4, $4)
		`, gatewayReplayBot, botgateway.DefaultSpaceID, group, joinedAt)
		execGatewayReplay(t, ctx, tx, `
			INSERT INTO workspace_agent_bot_context_grants (grant_id, bot_id, space_id, conversation_id, allow_trigger, created_at, updated_at)
			VALUES ($1, $2, $3, $4, 1, $5, $5)
		`, "grant-"+group, gatewayReplayBot, botgateway.DefaultSpaceID, group, joinedAt)
	}
	execGatewayReplay(t, ctx, tx, `UPDATE workspace_agent_bots SET conversation_policy = 'group-capable' WHERE id = $1`, gatewayReplayBot)
	execGatewayReplay(t, ctx, tx, `UPDATE workspace_agent_bot_settings SET allow_group = 1 WHERE bot_id = $1`, gatewayReplayBot)
	execGatewayReplay(t, ctx, tx, `UPDATE workspace_agent_bot_tokens SET scopes_json = '["messages:read_trigger"]' WHERE bot_id = $1`, gatewayReplayBot)

	for _, item := range []struct {
		key, group string
		sequence   int64
		expires    time.Time
	}{
		{"expired", gatewayReplayGroup, gatewayReplayAfter + 1, now.Add(-time.Minute)},
		{"revoked", gatewayReplayRevoked, gatewayReplayAfter + 2, now.Add(time.Hour)},
		{"queued", gatewayReplayGroup, gatewayReplayQueued, now.Add(time.Hour)},
	} {
		createdAt := now.Add(-2 * time.Minute)
		insertGatewayReplayTrigger(t, ctx, tx, item.group, item.key, item.sequence, createdAt)
		execGatewayReplay(t, ctx, tx, `
			INSERT INTO workspace_agent_bot_deliveries
				(id, bot_id, space_id, sequence, event_id, event_type, conversation_id, payload_json, status, created_at, expires_at)
			VALUES ($1, $2, $3, $4, $5, 'message.created', $6, '{"text":"stale queued snapshot"}', 'queued', $7, $8)
		`, "replay-delivery-"+item.key, gatewayReplayBot, botgateway.DefaultSpaceID, item.sequence, "replay-event-"+item.key, item.group, createdAt, item.expires)
	}
	execGatewayReplay(t, ctx, tx, `
		UPDATE workspace_agent_bot_context_grants SET allow_trigger = 0 WHERE bot_id = $1 AND conversation_id = $2
	`, gatewayReplayBot, gatewayReplayRevoked)
	insertGatewayReplayNoise(t, ctx, tx, gatewayReplayAfter, gatewayReplayAfter, now)
	insertGatewayReplayNoise(t, ctx, tx, gatewayReplayAfter+3, gatewayReplayQueued-1, now)
	insertGatewayReplayNoise(t, ctx, tx, gatewayReplayQueued+1, gatewayReplayHead, now)
	execGatewayReplay(t, ctx, tx, `UPDATE workspace_event_cursors SET next_seq = $1 WHERE space_id = $2`, int64(gatewayReplayHead+1), botgateway.DefaultSpaceID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	service := botgateway.NewService(botgateway.ServiceOptions{
		Repository: botgateway.NewPGRepository(pool),
		SpaceID:    botgateway.DefaultSpaceID,
		Now:        func() time.Time { return now },
	})
	socketHandler := botgateway.NewWebSocketHandler(botgateway.WebSocketHandlerOptions{
		Gateway: service, SpaceID: botgateway.DefaultSpaceID, PollInterval: 20 * time.Millisecond, HeartbeatInterval: time.Hour,
	})
	server := httptest.NewServer(NewRouter(RouterOptions{
		Gate: gate.New("true"), BotGateway: service, BotGatewayWebSocket: socketHandler,
	}))
	t.Cleanup(server.Close)
	return gatewayReplayFixture{pool: pool, server: server, token: token, now: now}
}

func execGatewayReplay(t *testing.T, ctx context.Context, tx pgx.Tx, query string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func insertGatewayReplayTrigger(t *testing.T, ctx context.Context, tx pgx.Tx, group, key string, sequence int64, now time.Time) {
	t.Helper()
	text := gatewayReplayText(key)
	content, err := json.Marshal(map[string]any{
		"format": "duallane.message+json;v=1", "plainText": text,
		"blocks": []map[string]string{
			{"type": "mention", "userId": gatewayReplayBotUser, "label": "@Gateway Bot"},
			{"type": "text", "text": " " + key + " synthetic request"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	messageID := "replay-message-" + key
	execGatewayReplay(t, ctx, tx, `
		INSERT INTO messages
			(id, space_id, conversation_id, author_id, author_kind, kind, content_format, content_json, plain_text, created_at)
		VALUES ($1, $2, $3, $4, 'human', 'user', 'duallane.message+json;v=1', $5, $6, $7)
	`, messageID, botgateway.DefaultSpaceID, group, gatewayReplaySender, string(content), text, now)
	execGatewayReplay(t, ctx, tx, `
		INSERT INTO workspace_events (id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at)
		VALUES ($1, $2, $3, 'message.created', $4, $5, 'message', $6, '{"text":"stale source snapshot"}', $7)
	`, "replay-event-"+key, botgateway.DefaultSpaceID, sequence, gatewayReplaySender, group, messageID, now)
}

func gatewayReplayText(key string) string {
	return "@Gateway Bot " + key + " synthetic request"
}

func insertGatewayReplayNoise(t *testing.T, ctx context.Context, tx pgx.Tx, from, through int64, now time.Time) {
	t.Helper()
	execGatewayReplay(t, ctx, tx, `
		INSERT INTO workspace_events (id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at)
		SELECT 'replay-unrelated-' || seq, $3, seq, 'conversation.typing', $4, $5, 'conversation', $5, '{}', $6
		FROM generate_series($1::bigint, $2::bigint) AS seq
	`, from, through, botgateway.DefaultSpaceID, gatewayReplaySender, gatewayReplayGroup, now)
}

func (f gatewayReplayFixture) appendLateTrigger(t *testing.T) int64 {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var sequence int64
	if err := tx.QueryRow(ctx, `SELECT next_seq FROM workspace_event_cursors WHERE space_id = $1 FOR UPDATE`, botgateway.DefaultSpaceID).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	insertGatewayReplayTrigger(t, ctx, tx, gatewayReplayGroup, "late", sequence, f.now)
	insertGatewayReplayNoise(t, ctx, tx, sequence+1, sequence+gatewayReplayNoise, f.now)
	execGatewayReplay(t, ctx, tx, `UPDATE workspace_event_cursors SET next_seq = $1 WHERE space_id = $2`, sequence+gatewayReplayNoise+1, botgateway.DefaultSpaceID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return sequence
}

type gatewayReplayResponse struct {
	botgateway.ReplayResult
	ResumeSequence int64 `json:"resumeSequence"`
}

func (f gatewayReplayFixture) getUpdates(t *testing.T, after int64, limit int) gatewayReplayResponse {
	t.Helper()
	var result gatewayReplayResponse
	f.request(t, http.MethodGet, fmt.Sprintf("/api/bot/v2/updates?afterSequence=%d&limit=%d", after, limit), "", &result)
	return result
}

func (f gatewayReplayFixture) acknowledgeHTTP(t *testing.T, sequence int64, key string) botgateway.AcknowledgeResult {
	t.Helper()
	var result botgateway.AcknowledgeResult
	body := fmt.Sprintf(`{"eventId":"replay-event-%s","sequence":%d}`, key, sequence)
	f.request(t, http.MethodPost, "/api/bot-gateway/v1/events/ack", body, &result)
	return result
}

func (f gatewayReplayFixture) request(t *testing.T, method, path, body string, result any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+f.token)
	request.Header.Set(sdkgate.SDKVersionHeader, sdkgate.MinimumSDKVersion)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := f.server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		t.Fatalf("%s %s = %d, body = %s", method, path, response.StatusCode, detail)
	}
	if err := json.NewDecoder(response.Body).Decode(result); err != nil {
		t.Fatal(err)
	}
}

func (f gatewayReplayFixture) dialWebSocket(t *testing.T) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.server.URL, "http")+"/ws/bot-gateway", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization":          {"Bearer " + f.token},
			sdkgate.SDKVersionHeader: {sdkgate.MinimumSDKVersion},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = socket.CloseNow() })
	return socket
}

type gatewayReplayFrame struct {
	Type            string               `json:"type"`
	CurrentSequence int64                `json:"currentSequence"`
	ResumeSequence  int64                `json:"resumeSequence"`
	Reason          string               `json:"reason"`
	ReplayCount     int                  `json:"replayCount"`
	HasMore         bool                 `json:"hasMore"`
	Event           *botgateway.Delivery `json:"event"`
	botgateway.AcknowledgeResult
}

func readGatewayReplayFrame(t *testing.T, socket *websocket.Conn) gatewayReplayFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var frame gatewayReplayFrame
	if err := wsjson.Read(ctx, socket, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func writeGatewayReplayFrame(t *testing.T, socket *websocket.Conn, frame map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, socket, frame); err != nil {
		t.Fatal(err)
	}
}

func acknowledgeGatewayReplaySocket(t *testing.T, socket *websocket.Conn, sequence int64, key string) {
	t.Helper()
	eventID := "replay-event-" + key
	writeGatewayReplayFrame(t, socket, map[string]any{"version": 1, "type": "ack", "eventId": eventID, "sequence": sequence})
	ack := readGatewayReplayFrame(t, socket)
	if ack.Type != "ack" || !ack.Acknowledged || ack.EventID != eventID || ack.Sequence != sequence {
		t.Fatalf("WebSocket acknowledgement = %+v", ack)
	}
}

func assertGatewayReplayEvent(t *testing.T, event botgateway.Delivery, sequence int64, key, persistedID string) {
	t.Helper()
	if event.ID == "" || (persistedID != "" && event.ID != persistedID) ||
		event.EventID != "replay-event-"+key || event.Sequence != sequence || event.Type != "message.created" ||
		event.ConversationID != gatewayReplayGroup || event.Status != "delivered" {
		t.Fatalf("unexpected delivery identity = %+v", event)
	}
	payload := map[string]any{
		"messageId": "replay-message-" + key, "actorUserId": gatewayReplaySender, "conversationId": gatewayReplayGroup,
		"text": gatewayReplayText(key), "textComplete": true,
	}
	if !reflect.DeepEqual(event.Payload, payload) {
		t.Fatalf("delivery used a stale or unauthorized payload: %+v", event.Payload)
	}
}

func (f gatewayReplayFixture) assertDrained(t *testing.T, acknowledged map[string]int) {
	t.Helper()
	var pending int
	if err := f.pool.QueryRow(t.Context(), `
		SELECT COUNT(*) FROM workspace_agent_bot_deliveries WHERE bot_id = $1 AND status IN ('queued', 'delivered')
	`, gatewayReplayBot).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("%d pending deliveries remain after ACK", pending)
	}
	for _, key := range []string{"expired", "revoked"} {
		var status string
		var attempts int
		if err := f.pool.QueryRow(t.Context(), `SELECT status, attempts FROM workspace_agent_bot_deliveries WHERE id = $1`, "replay-delivery-"+key).Scan(&status, &attempts); err != nil {
			t.Fatal(err)
		}
		if status != "expired" || attempts != 0 {
			t.Fatalf("%s delivery = %s with %d attempts, want expired without delivery", key, status, attempts)
		}
	}
	for key, wantAttempts := range acknowledged {
		var status string
		var attempts int
		if err := f.pool.QueryRow(t.Context(), `SELECT status, attempts FROM workspace_agent_bot_deliveries WHERE event_id = $1`, "replay-event-"+key).Scan(&status, &attempts); err != nil {
			t.Fatal(err)
		}
		if status != "acked" || attempts != wantAttempts {
			t.Fatalf("%s delivery = %s with %d attempts, want acked with %d attempts", key, status, attempts, wantAttempts)
		}
	}
}
