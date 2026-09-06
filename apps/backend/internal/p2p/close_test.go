package p2p

import (
	"context"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The test doubles predate the force-close hook and remain intentionally
// immediate. Keeping these methods in this additive test file avoids changing
// the existing protocol fixtures.
func (p *testPeerConn) CloseNow() error {
	return p.Close(1001, "")
}

func (p *trackedPeerConn) CloseNow() error {
	return p.Close(1001, "")
}

func TestP2PHandlerForcesUnresponsivePeersWithinOneCloseBudget(t *testing.T) {
	handler := NewHandler(HandlerOptions{
		Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour}),
	})
	server := httptest.NewServer(handler.Routes())
	t.Cleanup(server.Close)
	t.Cleanup(handler.Close)

	room := createHTTPTestRoom(t, server.URL)
	first := dialP2P(t, server.URL, room.RoomID)
	t.Cleanup(func() { _ = first.CloseNow() })
	_ = readJSONFrame(t, first)
	_ = readJSONFrame(t, first)
	second := dialP2P(t, server.URL, room.RoomID)
	t.Cleanup(func() { _ = second.CloseNow() })
	_ = readJSONFrame(t, second)
	_ = readJSONFrame(t, second)

	started := time.Now()
	closed := make(chan struct{})
	go func() {
		handler.Close()
		close(closed)
	}()

	select {
	case <-closed:
	case <-time.After(peerCloseBudget + 2*time.Second):
		t.Fatalf("handler close exceeded one batch budget plus allowance")
	}
	if elapsed := time.Since(started); elapsed >= 4*time.Second {
		t.Fatalf("handler close took %s for unresponsive peers", elapsed)
	}
	if got := handler.Manager().ConnectionCount(); got != 0 {
		t.Fatalf("connection count after forced close = %d, want 0", got)
	}
	if _, ok := handler.Manager().Status(room.RoomID); ok {
		t.Fatal("closed manager retained the room")
	}
}

func TestP2PHandlerForcesFortyUnresponsivePeersWithinOneCloseBudget(t *testing.T) {
	const peerCount = 40

	handler := NewHandler(HandlerOptions{
		Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour}),
	})
	server := httptest.NewServer(handler.Routes())
	t.Cleanup(server.Close)
	t.Cleanup(handler.Close)

	clients := make([]interface{ CloseNow() error }, 0, peerCount)
	t.Cleanup(func() {
		for _, client := range clients {
			_ = client.CloseNow()
		}
	})
	for range peerCount {
		room, err := handler.Manager().Create(server.URL)
		if err != nil {
			t.Fatal(err)
		}
		client := dialP2P(t, server.URL, room.RoomID)
		clients = append(clients, client)
		_ = readJSONFrame(t, client)
		_ = readJSONFrame(t, client)
	}
	if got := handler.Manager().ConnectionCount(); got != peerCount {
		t.Fatalf("connection count before forced close = %d, want %d", got, peerCount)
	}

	started := time.Now()
	closed := make(chan struct{})
	go func() {
		handler.Close()
		close(closed)
	}()

	select {
	case <-closed:
	case <-time.After(peerCloseBudget + 2*time.Second):
		t.Fatalf("handler close exceeded one batch budget plus allowance for %d peers", peerCount)
	}
	if elapsed := time.Since(started); elapsed > peerCloseBudget+2*time.Second {
		t.Fatalf("handler close took %s for %d unresponsive peers", elapsed, peerCount)
	}
	if got := handler.Manager().ConnectionCount(); got != 0 {
		t.Fatalf("connection count after forced close = %d", got)
	}
}

type blockingClosePeerConn struct {
	gracefulStarted chan struct{}
	forceCalled     chan struct{}
	gracefulRelease chan struct{}
	startOnce       sync.Once
	forceOnce       sync.Once
	releaseOnce     sync.Once
	forceCount      atomic.Int32
}

func newBlockingClosePeerConn() *blockingClosePeerConn {
	return &blockingClosePeerConn{
		gracefulStarted: make(chan struct{}),
		forceCalled:     make(chan struct{}),
		gracefulRelease: make(chan struct{}),
	}
}

func (p *blockingClosePeerConn) Send(ctx context.Context, _ []byte) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

func (p *blockingClosePeerConn) Close(int, string) error {
	p.startOnce.Do(func() { close(p.gracefulStarted) })
	<-p.gracefulRelease
	return nil
}

func (p *blockingClosePeerConn) CloseNow() error {
	p.forceCount.Add(1)
	p.forceOnce.Do(func() { close(p.forceCalled) })
	return nil
}

func (p *blockingClosePeerConn) releaseGraceful() {
	p.releaseOnce.Do(func() { close(p.gracefulRelease) })
}

func TestManagerConcurrentCloseWaitsForGracefulBatchAndForceCloses(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	peer := newBlockingClosePeerConn()
	if _, err := manager.Join(room.RoomID, peer); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		peer.releaseGraceful()
		manager.Close()
	})

	firstDone := make(chan struct{})
	secondDone := make(chan struct{})
	go func() {
		manager.Close()
		close(firstDone)
	}()
	go func() {
		manager.Close()
		close(secondDone)
	}()

	select {
	case <-peer.gracefulStarted:
	case <-time.After(time.Second):
		t.Fatal("graceful close did not start")
	}
	assertNotClosed(t, firstDone, "first Manager.Close returned before graceful batch completion")
	assertNotClosed(t, secondDone, "second Manager.Close returned before graceful batch completion")

	select {
	case <-peer.forceCalled:
	case <-time.After(peerCloseBudget + time.Second):
		t.Fatal("force close hook was not called within the batch budget")
	}
	if got := peer.forceCount.Load(); got != 1 {
		t.Fatalf("force close hook count = %d, want 1", got)
	}
	assertNotClosed(t, firstDone, "first Manager.Close returned before graceful batch completion after force")
	assertNotClosed(t, secondDone, "second Manager.Close returned before graceful batch completion after force")

	peer.releaseGraceful()
	waitClosed(t, firstDone, time.Second, "first Manager.Close")
	waitClosed(t, secondDone, time.Second, "second Manager.Close")
}

func TestManagerPruneExpiredClosesPeersOutsideManagerLock(t *testing.T) {
	now := time.Date(2026, time.September, 7, 10, 0, 0, 0, time.UTC)
	manager := NewManager(ManagerOptions{
		Now:            func() time.Time { return now },
		RoomTTL:        time.Hour,
		EmptyRoomGrace: time.Hour,
	})
	t.Cleanup(manager.Close)

	expired, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	live, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	peer := newBlockingClosePeerConn()
	t.Cleanup(peer.releaseGraceful)
	if _, err := manager.Join(expired.RoomID, peer); err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	manager.rooms[expired.RoomID].room.ExpiresAt = now.Add(-time.Minute)
	manager.mu.Unlock()

	expiredStatusDone := make(chan struct{})
	go func() {
		if _, ok := manager.Status(expired.RoomID); ok {
			t.Errorf("expired room remained available")
		}
		close(expiredStatusDone)
	}()
	select {
	case <-peer.gracefulStarted:
	case <-time.After(time.Second):
		t.Fatal("expired peer close did not start")
	}

	liveStatusDone := make(chan bool, 1)
	go func() {
		_, ok := manager.Status(live.RoomID)
		liveStatusDone <- ok
	}()
	select {
	case ok := <-liveStatusDone:
		if !ok {
			t.Fatal("live room status was not available while expired peer close was blocked")
		}
	case <-time.After(time.Second):
		t.Fatal("live room status blocked behind expired peer close")
	}

	peer.releaseGraceful()
	waitClosed(t, expiredStatusDone, time.Second, "expired room status")
}

func assertNotClosed(t *testing.T, done <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-done:
		t.Fatal(message)
	default:
	}
}

func waitClosed(t *testing.T, done <-chan struct{}, timeout time.Duration, operation string) {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		t.Fatalf("%s did not finish within %s", operation, timeout)
	}
}
