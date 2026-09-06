package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceEvents "github.com/timestarry/duallane/apps/backend/internal/workspace/events"
	workspacePresence "github.com/timestarry/duallane/apps/backend/internal/workspace/presence"
)

type fakeResolver struct {
	actor *auth.Actor
	err   error
	calls int
}

func (f *fakeResolver) ResolveActor(context.Context, *http.Request) (*auth.Actor, error) {
	f.calls++
	if f.actor == nil {
		return nil, f.err
	}
	copy := *f.actor
	return &copy, f.err
}

type fakeEventService struct {
	mu      sync.Mutex
	results map[int64]workspaceEvents.ReplayResult
	errors  map[int64]error
	calls   []workspaceEvents.ReplayInput
}

func (f *fakeEventService) Replay(_ context.Context, input workspaceEvents.ReplayInput) (workspaceEvents.ReplayResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, input)
	return f.results[input.LastSeq], f.errors[input.LastSeq]
}

func (f *fakeEventService) set(lastSeq int64, result workspaceEvents.ReplayResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results[lastSeq] = result
}

func (f *fakeEventService) setError(lastSeq int64, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errors[lastSeq] = err
}

type fakePresence struct {
	mu        sync.Mutex
	registers []workspacePresence.RegisterInput
	leases    []workspacePresence.Lease
	renewals  []workspacePresence.RenewInput
	deletes   []workspacePresence.DeleteInput
	nextID    int
	err       error
	renewErr  error
}

func (f *fakePresence) Register(_ context.Context, input workspacePresence.RegisterInput) (workspacePresence.Lease, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return workspacePresence.Lease{}, f.err
	}
	f.nextID++
	lease := workspacePresence.Lease{SpaceID: input.SpaceID, UserID: input.UserID, ConnectionID: "socket-" + strconv.Itoa(f.nextID), LeaseUntil: time.Now().Add(time.Minute)}
	f.registers = append(f.registers, input)
	f.leases = append(f.leases, lease)
	return lease, nil
}

func (f *fakePresence) Renew(_ context.Context, input workspacePresence.RenewInput) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renewals = append(f.renewals, input)
	return f.renewErr
}

func (f *fakePresence) Delete(_ context.Context, input workspacePresence.DeleteInput) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, input)
	return nil
}

func (f *fakePresence) counts() (registers, renewals, deletes int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.registers), len(f.renewals), len(f.deletes)
}

func TestHandlerHelloReplayAndWakeupCatchUp(t *testing.T) {
	hub := NewHub()
	resolver := &fakeResolver{actor: &auth.Actor{ID: "usr-viewer", Kind: "human", Role: "member"}}
	service := &fakeEventService{results: map[int64]workspaceEvents.ReplayResult{}, errors: map[int64]error{}}
	service.set(0, workspaceEvents.ReplayResult{
		CurrentSeq: 2, ReplayFrom: 1, ReplayCount: 2,
		Events: []workspaceEvents.Event{event(1), event(2)},
	})
	root, cancel := context.WithCancel(context.Background())
	defer cancel()
	handler := NewHandler(HandlerOptions{
		RootContext: root, ActorResolver: resolver, Events: service, Hub: hub,
		PollInterval: time.Hour, HeartbeatInterval: time.Hour, IOTimeout: time.Second,
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	connection := dial(t, server.URL, nil)
	defer connection.CloseNow()
	writeText(t, connection, `{"version":1,"type":"hello","lastSeq":0}`)
	ready := readFrame(t, connection)
	if ready["type"] != "ready" || ready["currentSeq"] != float64(2) || ready["replayCount"] != float64(2) || ready["hasMore"] != false {
		t.Fatalf("ready frame = %#v", ready)
	}
	if readFrame(t, connection)["event"].(map[string]any)["seq"] != float64(1) {
		t.Fatal("first event sequence mismatch")
	}
	if readFrame(t, connection)["event"].(map[string]any)["seq"] != float64(2) {
		t.Fatal("second event sequence mismatch")
	}
	service.set(2, workspaceEvents.ReplayResult{CurrentSeq: 3, ReplayFrom: 3, ReplayCount: 1, Events: []workspaceEvents.Event{event(3)}})
	hub.Notify()
	catchUp := readFrame(t, connection)
	if catchUp["type"] != "event" || catchUp["event"].(map[string]any)["seq"] != float64(3) {
		t.Fatalf("catch-up frame = %#v", catchUp)
	}
	if resolver.calls != 1 {
		t.Fatalf("hello actor resolutions = %d", resolver.calls)
	}
}

func TestHandlerPollRecoversMissedNotification(t *testing.T) {
	service := &fakeEventService{results: map[int64]workspaceEvents.ReplayResult{}, errors: map[int64]error{}}
	service.set(0, workspaceEvents.ReplayResult{CurrentSeq: 0, ReplayFrom: 1})
	server := httptest.NewServer(NewHandler(HandlerOptions{
		ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "usr-viewer", Kind: "human", Role: "member"}},
		Events:        service, PollInterval: 20 * time.Millisecond, HeartbeatInterval: time.Hour,
	}))
	defer server.Close()
	connection := dial(t, server.URL, nil)
	defer connection.CloseNow()
	writeText(t, connection, `{"version":1,"type":"hello","lastSeq":0}`)
	_ = readFrame(t, connection)
	service.set(0, workspaceEvents.ReplayResult{CurrentSeq: 1, ReplayFrom: 1, ReplayCount: 1, Events: []workspaceEvents.Event{event(1)}})
	recovered := readFrame(t, connection)
	if recovered["type"] != "event" || recovered["event"].(map[string]any)["seq"] != float64(1) {
		t.Fatalf("poll recovery frame = %#v", recovered)
	}
}

func TestHandlerPresenceRegistersAfterReplayRenewsAndDeletesOwnLease(t *testing.T) {
	presence := &fakePresence{}
	service := &fakeEventService{results: map[int64]workspaceEvents.ReplayResult{0: {CurrentSeq: 0, ReplayFrom: 1}}, errors: map[int64]error{}}
	server := httptest.NewServer(NewHandler(HandlerOptions{
		ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "usr-viewer", Kind: "human", Role: "member"}},
		Events:        service, Presence: presence, PollInterval: time.Hour, HeartbeatInterval: 20 * time.Millisecond,
		IOTimeout: time.Second,
	}))
	defer server.Close()
	connection := dial(t, server.URL, nil)
	writeText(t, connection, `{"version":1,"type":"hello","lastSeq":0}`)
	_ = readFrame(t, connection)
	waitForPresence(t, func() bool {
		registers, _, _ := presence.counts()
		return registers == 1
	})
	waitForPresence(t, func() bool {
		_, renewals, _ := presence.counts()
		return renewals > 0
	})
	connection.CloseNow()
	waitForPresence(t, func() bool {
		_, _, deletes := presence.counts()
		return deletes == 1
	})
	registers, renewals, deletes := presence.counts()
	if registers != 1 || renewals == 0 || deletes != 1 {
		t.Fatalf("presence lifecycle registers=%d renewals=%d deletes=%d", registers, renewals, deletes)
	}
}

func TestHandlerPresenceIsRemovedWhenReplayLosesAuthorization(t *testing.T) {
	presence := &fakePresence{}
	root, cancel := context.WithCancel(context.Background())
	defer cancel()
	hub := NewHub()
	service := &fakeEventService{results: map[int64]workspaceEvents.ReplayResult{0: {CurrentSeq: 0, ReplayFrom: 1}}, errors: map[int64]error{}}
	server := httptest.NewServer(NewHandler(HandlerOptions{
		RootContext: root, ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "usr-viewer", Kind: "human", Role: "member"}},
		Events: service, Presence: presence, Hub: hub, PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	defer server.Close()
	connection := dial(t, server.URL, nil)
	defer connection.CloseNow()
	writeText(t, connection, `{"version":1,"type":"hello","lastSeq":0}`)
	_ = readFrame(t, connection)
	waitForPresence(t, func() bool { registers, _, _ := presence.counts(); return registers == 1 })
	service.setError(0, auth.NewError(auth.CodeRequired, auth.MessageRequired, http.StatusUnauthorized))
	hub.Notify()
	failure := readFrame(t, connection)
	if failure["error"].(map[string]any)["code"] != auth.CodeRequired {
		t.Fatalf("replay authorization frame = %#v", failure)
	}
	closeCtx, closeCancel := context.WithTimeout(context.Background(), time.Second)
	_, _, _ = connection.Read(closeCtx)
	closeCancel()
	waitForPresence(t, func() bool { _, _, deletes := presence.counts(); return deletes == 1 })
}

func TestHandlerHasMoreAndSyncRequiredContracts(t *testing.T) {
	service := &fakeEventService{
		results: map[int64]workspaceEvents.ReplayResult{
			0: {CurrentSeq: 5, ReplayFrom: 1, ReplayCount: 1, HasMore: true, Events: []workspaceEvents.Event{event(1)}},
			1: {CurrentSeq: 5, ReplayFrom: 2, SyncRequired: true, Reason: workspaceEvents.SyncReasonCursorAhead},
		},
		errors: map[int64]error{},
	}
	server := httptest.NewServer(NewHandler(HandlerOptions{
		ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "usr-viewer", Kind: "human", Role: "member"}},
		Events:        service, PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	defer server.Close()
	connection := dial(t, server.URL, nil)
	defer connection.CloseNow()
	writeText(t, connection, `{"type":"hello","lastSeq":0}`)
	ready := readFrame(t, connection)
	if ready["hasMore"] != true || ready["replayCount"] != float64(1) {
		t.Fatalf("bounded ready frame = %#v", ready)
	}
	_ = readFrame(t, connection)
	writeText(t, connection, `{"type":"hello","lastSeq":1}`)
	syncFrame := readFrame(t, connection)
	if syncFrame["type"] != "sync.required" || syncFrame["reason"] != workspaceEvents.SyncReasonCursorAhead || syncFrame["currentSeq"] != float64(5) {
		t.Fatalf("sync frame = %#v", syncFrame)
	}
}

func TestHandlerRejectsInvalidAndOversizedFrames(t *testing.T) {
	server := httptest.NewServer(NewHandler(HandlerOptions{
		ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "usr-viewer"}},
		Events:        &fakeEventService{results: map[int64]workspaceEvents.ReplayResult{}, errors: map[int64]error{}},
		MaxFrameBytes: 64, PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	defer server.Close()
	connection := dial(t, server.URL, nil)
	defer connection.CloseNow()
	writeText(t, connection, `{"version":2,"type":"hello","lastSeq":0}`)
	invalid := readFrame(t, connection)
	if invalid["type"] != "error" || invalid["error"].(map[string]any)["code"] != "realtime.invalid" {
		t.Fatalf("invalid frame response = %#v", invalid)
	}
	writeText(t, connection, strings.Repeat("x", 128))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err := connection.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatalf("oversized close = %v, status=%v", err, websocket.CloseStatus(err))
	}
}

func TestHandlerEnforcesOriginAndClosesOnShutdown(t *testing.T) {
	root, cancelRoot := context.WithCancel(context.Background())
	presence := &fakePresence{}
	handler := NewHandler(HandlerOptions{
		RootContext:   root,
		ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "usr-viewer", Kind: "human", Role: "member"}},
		Events:        &fakeEventService{results: map[int64]workspaceEvents.ReplayResult{0: {CurrentSeq: 0, ReplayFrom: 1}}, errors: map[int64]error{}},
		Presence:      presence,
		PollInterval:  time.Hour, HeartbeatInterval: time.Hour,
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	badOrigin := http.Header{"Origin": []string{"https://evil.example"}}
	_, response, err := websocket.Dial(context.Background(), websocketURL(server.URL), &websocket.DialOptions{HTTPHeader: badOrigin})
	if response != nil {
		defer response.Body.Close()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin dial = response:%v err:%v", response, err)
	}
	connection := dial(t, server.URL, nil)
	writeText(t, connection, `{"version":1,"type":"hello","lastSeq":0}`)
	_ = readFrame(t, connection)
	waitForPresence(t, func() bool { registers, _, _ := presence.counts(); return registers == 1 })
	cancelRoot()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err = connection.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusServiceRestart {
		t.Fatalf("shutdown close = %v, status=%v", err, websocket.CloseStatus(err))
	}
	waitForPresence(t, func() bool { _, _, deletes := presence.counts(); return deletes == 1 })
}

func TestHandlerProjectsAuthenticationFailureAndCloses(t *testing.T) {
	resolver := &fakeResolver{err: auth.NewError(auth.CodeRequired, auth.MessageRequired, http.StatusUnauthorized)}
	server := httptest.NewServer(NewHandler(HandlerOptions{
		ActorResolver: resolver,
		Events:        &fakeEventService{results: map[int64]workspaceEvents.ReplayResult{}, errors: map[int64]error{}},
		PollInterval:  time.Hour, HeartbeatInterval: time.Hour,
	}))
	defer server.Close()
	connection := dial(t, server.URL, nil)
	defer connection.CloseNow()
	writeText(t, connection, `{"type":"hello","lastSeq":0}`)
	failure := readFrame(t, connection)
	if failure["error"].(map[string]any)["code"] != auth.CodeRequired {
		t.Fatalf("authentication frame = %#v", failure)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err := connection.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("authentication close = %v", err)
	}
}

func event(sequence int64) workspaceEvents.Event {
	return workspaceEvents.Event{
		ID: "event-" + strconv.FormatInt(sequence, 10), SpaceID: workspaceEvents.DefaultSpaceID,
		Seq: sequence, Type: "unknown", Payload: map[string]any{}, CreatedAt: "2026-09-04T00:00:00.000Z",
	}
}

func dial(t *testing.T, serverURL string, options *websocket.DialOptions) *websocket.Conn {
	t.Helper()
	connection, _, err := websocket.Dial(context.Background(), websocketURL(serverURL), options)
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func websocketURL(serverURL string) string {
	return strings.Replace(serverURL, "http://", "ws://", 1)
}

func writeText(t *testing.T, connection *websocket.Conn, value string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, []byte(value)); err != nil {
		t.Fatal(err)
	}
}

func readFrame(t *testing.T, connection *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	messageType, raw, err := connection.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("message type = %v", messageType)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func waitForPresence(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("presence condition was not reached")
}
