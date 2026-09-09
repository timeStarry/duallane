package p2p

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type trackedPeerClose struct {
	code   int
	reason string
}

type trackedPeerConn struct {
	mu        sync.Mutex
	messages  [][]byte
	closed    []trackedPeerClose
	closedCh  chan struct{}
	closeOnce sync.Once
}

func newTrackedPeerConn() *trackedPeerConn {
	return &trackedPeerConn{closedCh: make(chan struct{})}
}

func (p *trackedPeerConn) Send(ctx context.Context, payload []byte) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	p.mu.Lock()
	p.messages = append(p.messages, append([]byte(nil), payload...))
	p.mu.Unlock()
	return nil
}

func (p *trackedPeerConn) Close(code int, reason string) error {
	p.mu.Lock()
	p.closed = append(p.closed, trackedPeerClose{code: code, reason: reason})
	p.mu.Unlock()
	p.closeOnce.Do(func() { close(p.closedCh) })
	return nil
}

func (p *trackedPeerConn) waitClosed(t *testing.T, timeout time.Duration) {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-p.closedCh:
	case <-timer.C:
		t.Fatal("peer was not closed within the bound")
	}
}

func (p *trackedPeerConn) closeEvents() []trackedPeerClose {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]trackedPeerClose(nil), p.closed...)
}

type gatedPeerConn struct {
	*trackedPeerConn
	sendStarted chan struct{}
	release     chan struct{}
	startOnce   sync.Once
}

func newGatedPeerConn() *gatedPeerConn {
	return &gatedPeerConn{
		trackedPeerConn: newTrackedPeerConn(),
		sendStarted:     make(chan struct{}),
		release:         make(chan struct{}),
	}
}

func (p *gatedPeerConn) Send(ctx context.Context, payload []byte) error {
	p.startOnce.Do(func() { close(p.sendStarted) })
	select {
	case <-p.release:
		return p.trackedPeerConn.Send(ctx, payload)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestManagerRoomExpiryClosesPeersAndRejectsReuse(t *testing.T) {
	manager := NewManager(ManagerOptions{
		RoomTTL:        25 * time.Millisecond,
		EmptyRoomGrace: time.Hour,
	})
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	peer := newTrackedPeerConn()
	if _, err := manager.Join(room.RoomID, peer); err != nil {
		t.Fatal(err)
	}

	peer.waitClosed(t, time.Second)
	events := peer.closeEvents()
	if len(events) != 1 || events[0].code != 1005 || events[0].reason != "" {
		t.Fatalf("expiry close event = %#v", events)
	}
	if manager.RoomCount() != 0 || manager.ConnectionCount() != 0 {
		t.Fatal("expired room remained available")
	}
	if _, err := manager.Join(room.RoomID, newTrackedPeerConn()); !errors.Is(err, ErrRoomNotFound) {
		t.Fatalf("Join() after expiry error = %v, want %v", err, ErrRoomNotFound)
	}
	manager.Close()
}

func TestManagerEmptyRoomGraceExpiresWithoutReconnect(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: 25 * time.Millisecond})
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	peer := newTrackedPeerConn()
	peerID, err := manager.Join(room.RoomID, peer)
	if err != nil {
		t.Fatal(err)
	}
	if !manager.Leave(room.RoomID, peerID, false) {
		t.Fatal("Leave() did not remove the peer")
	}
	if manager.RoomCount() != 1 {
		t.Fatal("empty-room grace removed the room too early")
	}

	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	for manager.RoomCount() != 0 {
		select {
		case <-poll.C:
		case <-deadline.C:
			t.Fatal("empty-room grace did not remove the room within the bound")
		}
	}
	manager.Close()
}

func TestManagerConcurrentJoinLeaveRelay(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	defer manager.Close()
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}

	const workers = 64
	start := make(chan struct{})
	var group sync.WaitGroup
	group.Add(workers)
	for range workers {
		go func() {
			defer group.Done()
			<-start
			peer := newTrackedPeerConn()
			peerID, joinErr := manager.Join(room.RoomID, peer)
			if joinErr != nil {
				return
			}
			_ = manager.Relay(room.RoomID, peerID, SecureEnvelope{
				Type:       "secure",
				Version:    SecureEnvelopeVersion,
				Channel:    "signal",
				Nonce:      "synthetic-nonce",
				Ciphertext: "synthetic-ciphertext",
			})
			_ = manager.Leave(room.RoomID, peerID, false)
		}()
	}
	close(start)
	group.Wait()

	if manager.ConnectionCount() != 0 {
		t.Fatalf("concurrent lifecycle left %d connections", manager.ConnectionCount())
	}
}

func TestManagerCloseRacesWithJoinAndConcurrentCloseCalls(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	peer := newGatedPeerConn()
	type joinResult struct {
		peerID string
		err    error
	}
	joined := make(chan joinResult, 1)
	go func() {
		peerID, joinErr := manager.Join(room.RoomID, peer)
		joined <- joinResult{peerID: peerID, err: joinErr}
	}()

	select {
	case <-peer.sendStarted:
	case <-time.After(time.Second):
		t.Fatal("Join() did not reach the peer send boundary")
	}

	const closers = 8
	var group sync.WaitGroup
	group.Add(closers)
	for range closers {
		go func() {
			defer group.Done()
			manager.Close()
		}()
	}
	group.Wait()
	close(peer.release)

	select {
	case result := <-joined:
		if result.err != nil || result.peerID == "" {
			t.Fatalf("Join() during Close() = %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("Join() did not finish after concurrent Close()")
	}
	peer.waitClosed(t, time.Second)
	if events := peer.closeEvents(); len(events) != 1 || events[0].code != 1001 || events[0].reason != "server shutdown" {
		t.Fatalf("concurrent close events = %#v", events)
	}
	if manager.RoomCount() != 0 || manager.ConnectionCount() != 0 {
		t.Fatal("concurrent Close() retained P2P state")
	}
}
