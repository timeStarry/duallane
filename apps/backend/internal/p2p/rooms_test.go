package p2p

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type testPeerConn struct {
	mu       sync.Mutex
	messages [][]byte
	closed   []struct {
		code   int
		reason string
	}
	err error
}

func (p *testPeerConn) Send(ctx context.Context, payload []byte) error {
	if p.err != nil {
		return p.err
	}
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

func (p *testPeerConn) Close(code int, reason string) error {
	p.mu.Lock()
	p.closed = append(p.closed, struct {
		code   int
		reason string
	}{code: code, reason: reason})
	p.mu.Unlock()
	return nil
}

func (p *testPeerConn) snapshotMessages() [][]byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	result := make([][]byte, len(p.messages))
	for index, message := range p.messages {
		result[index] = append([]byte(nil), message...)
	}
	return result
}

func (p *testPeerConn) closeCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.closed)
}

func TestManagerCreatesStableRoomMetadata(t *testing.T) {
	now := time.Date(2026, time.September, 4, 10, 11, 12, 123456789, time.UTC)
	manager := NewManager(ManagerOptions{Now: func() time.Time { return now }, RoomTTL: 2 * time.Hour})
	defer manager.Close()
	room, err := manager.Create("https://duallane.example/")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if len(room.RoomID) != 22 {
		t.Fatalf("room id length = %d, want 22", len(room.RoomID))
	}
	if room.InviteLink != "https://duallane.example/direct/"+room.RoomID {
		t.Fatalf("invite link = %q", room.InviteLink)
	}
	if got := formatTimestamp(room.ExpiresAt); got != "2026-09-04T12:11:12.123Z" {
		t.Fatalf("timestamp = %q, want millisecond ISO timestamp", got)
	}
	status, ok := manager.Status(room.RoomID)
	if !ok || status.PeerCount != 0 || status.MaxPeers != MaxRoomPeers {
		t.Fatalf("status = %#v, ok = %v", status, ok)
	}
	encoded, err := json.Marshal(room)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"roomId":"`+room.RoomID+`","inviteLink":"https://duallane.example/direct/`+room.RoomID+`","expiresAt":"2026-09-04T12:11:12.123Z","maxPeers":2}` {
		t.Fatalf("created room JSON = %s", encoded)
	}
}

func TestManagerPreservesPeerJoinOrder(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	defer manager.Close()
	room, err := manager.Create("http://localhost:8787")
	if err != nil {
		t.Fatal(err)
	}
	first, second := &testPeerConn{}, &testPeerConn{}
	firstID, err := manager.Join(room.RoomID, first)
	if err != nil {
		t.Fatal(err)
	}
	secondID, err := manager.Join(room.RoomID, second)
	if err != nil {
		t.Fatal(err)
	}
	firstMessages := first.snapshotMessages()
	secondMessages := second.snapshotMessages()
	if len(firstMessages) != 4 || len(secondMessages) != 2 {
		t.Fatalf("message counts = first %d, second %d", len(firstMessages), len(secondMessages))
	}
	var firstJoined systemMessage
	if err := json.Unmarshal(firstMessages[0], &firstJoined); err != nil {
		t.Fatal(err)
	}
	if firstJoined.PeerID != firstID || len(firstJoined.Peers) != 1 || firstJoined.Peers[0].ID != firstID {
		t.Fatalf("first joined = %#v", firstJoined)
	}
	var initialPeerList systemMessage
	if err := json.Unmarshal(firstMessages[1], &initialPeerList); err != nil {
		t.Fatal(err)
	}
	if initialPeerList.Event != "peer-list" {
		t.Fatalf("initial peer-list = %#v", initialPeerList)
	}
	var secondJoined systemMessage
	if err := json.Unmarshal(secondMessages[0], &secondJoined); err != nil {
		t.Fatal(err)
	}
	if secondJoined.PeerID != secondID || len(secondJoined.Peers) != 2 || secondJoined.Peers[0].ID != firstID || secondJoined.Peers[1].ID != secondID {
		t.Fatalf("second joined = %#v", secondJoined)
	}
	var peerJoined systemMessage
	if err := json.Unmarshal(firstMessages[2], &peerJoined); err != nil {
		t.Fatal(err)
	}
	if peerJoined.Event != "peer-joined" || len(peerJoined.Peers) != 2 || peerJoined.Peers[0].ID != firstID || peerJoined.Peers[1].ID != secondID {
		t.Fatalf("peer-joined = %#v", peerJoined)
	}
}

func TestManagerRejectsThirdPeer(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	defer manager.Close()
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := manager.Join(room.RoomID, &testPeerConn{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := manager.Join(room.RoomID, &testPeerConn{}); !errors.Is(err, ErrRoomFull) {
		t.Fatalf("third Join() error = %v, want %v", err, ErrRoomFull)
	}
}

func TestManagerClosesExpiredPeersWithInjectedClock(t *testing.T) {
	now := time.Date(2026, time.September, 4, 10, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	current := now
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return current
	}
	manager := NewManager(ManagerOptions{Now: clock, RoomTTL: time.Hour, EmptyRoomGrace: time.Hour})
	defer manager.Close()
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	peer := &testPeerConn{}
	if _, err := manager.Join(room.RoomID, peer); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	current = current.Add(2 * time.Hour)
	mu.Unlock()
	if _, ok := manager.Status(room.RoomID); ok {
		t.Fatal("expired room is still available")
	}
	if peer.closeCount() != 1 {
		t.Fatalf("expired peer close count = %d, want 1", peer.closeCount())
	}
}

func TestManagerEmptyRoomGraceAndReconnect(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: 40 * time.Millisecond})
	defer manager.Close()
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	peer := &testPeerConn{}
	if _, err := manager.Join(room.RoomID, peer); err != nil {
		t.Fatal(err)
	}
	manager.Leave(room.RoomID, manager.peerIDForConn(peer), false)
	if _, ok := manager.Status(room.RoomID); !ok {
		t.Fatal("room disappeared before grace period")
	}
	reconnected := &testPeerConn{}
	if _, err := manager.Join(room.RoomID, reconnected); err != nil {
		t.Fatalf("reconnect Join() error = %v", err)
	}
	time.Sleep(60 * time.Millisecond)
	if _, ok := manager.Status(room.RoomID); !ok {
		t.Fatal("room disappeared after reconnect")
	}
}

func TestManagerRelayAndLeave(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	defer manager.Close()
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	first, second := &testPeerConn{}, &testPeerConn{}
	firstID, err := manager.Join(room.RoomID, first)
	if err != nil {
		t.Fatal(err)
	}
	secondID, err := manager.Join(room.RoomID, second)
	if err != nil {
		t.Fatal(err)
	}
	second.messages = nil
	if !manager.Relay(room.RoomID, firstID, SecureEnvelope{Type: "secure", Version: 1, Channel: "ws-chat", Nonce: "n", Ciphertext: "opaque"}) {
		t.Fatal("Relay() returned false")
	}
	messages := second.snapshotMessages()
	if len(messages) != 1 || !contains(string(messages[0]), `"from":{"id":"`+firstID+`"}`) {
		t.Fatalf("relay messages = %s", messages)
	}
	if !manager.Leave(room.RoomID, firstID, false) {
		t.Fatal("Leave() returned false")
	}
	if manager.Leave(room.RoomID, firstID, false) {
		t.Fatal("duplicate Leave() returned true")
	}
	status, ok := manager.Status(room.RoomID)
	if !ok || status.PeerCount != 1 {
		t.Fatalf("status after leave = %#v, ok=%v", status, ok)
	}
	if secondID == "" {
		t.Fatal("second peer id is empty")
	}
}

func TestManagerRoomIDFailureIsReturned(t *testing.T) {
	manager := NewManager(ManagerOptions{NewRoomID: func() (string, error) { return "", errors.New("random unavailable") }})
	defer manager.Close()
	if _, err := manager.Create(""); err == nil {
		t.Fatal("Create() succeeded after room ID generation failure")
	}
}

func TestManagerPeerIDFailureIsReturned(t *testing.T) {
	manager := NewManager(ManagerOptions{NewPeerID: func() (string, error) { return "", errors.New("random unavailable") }})
	defer manager.Close()
	room, err := manager.Create("")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Join(room.RoomID, &testPeerConn{}); err == nil {
		t.Fatal("Join() succeeded after peer ID generation failure")
	}
	status, ok := manager.Status(room.RoomID)
	if !ok || status.PeerCount != 0 {
		t.Fatalf("status after failed Join() = %#v, ok=%v", status, ok)
	}
}

func (m *Manager) peerIDForConn(target PeerConn) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, room := range m.rooms {
		for id, peer := range room.peers {
			if peer.conn == target {
				return id
			}
		}
	}
	return ""
}

func contains(value, fragment string) bool {
	return len(value) >= len(fragment) && stringIndex(value, fragment) >= 0
}

func stringIndex(value, fragment string) int {
	for index := 0; index+len(fragment) <= len(value); index++ {
		if value[index:index+len(fragment)] == fragment {
			return index
		}
	}
	return -1
}
