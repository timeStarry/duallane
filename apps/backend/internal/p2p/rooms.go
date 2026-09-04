package p2p

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	MaxRoomPeers = 2
	MaxRooms     = 10_000
)

var (
	ErrRoomNotFound  = errors.New("p2p room not found")
	ErrRoomFull      = errors.New("p2p room is full")
	ErrRoomLimit     = errors.New("p2p room limit reached")
	ErrManagerClosed = errors.New("p2p manager is closed")
)

type PeerConn interface {
	Send(ctx context.Context, payload []byte) error
	Close(code int, reason string) error
}

type ManagerOptions struct {
	RoomTTL        time.Duration
	EmptyRoomGrace time.Duration
	Now            func() time.Time
	MaxRooms       int
	NewRoomID      func() (string, error)
	NewPeerID      func() (string, error)
}

type Room struct {
	ID        string
	CreatedAt time.Time
	ExpiresAt time.Time
	MaxPeers  int
}

type RoomStatus struct {
	RoomID    string    `json:"roomId"`
	ExpiresAt time.Time `json:"-"`
	PeerCount int       `json:"peerCount"`
	MaxPeers  int       `json:"maxPeers"`
}

func (s RoomStatus) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		RoomID    string `json:"roomId"`
		ExpiresAt string `json:"expiresAt"`
		PeerCount int    `json:"peerCount"`
		MaxPeers  int    `json:"maxPeers"`
	}{
		RoomID:    s.RoomID,
		ExpiresAt: formatTimestamp(s.ExpiresAt),
		PeerCount: s.PeerCount,
		MaxPeers:  s.MaxPeers,
	})
}

func (s *RoomStatus) UnmarshalJSON(data []byte) error {
	var value struct {
		RoomID    string `json:"roomId"`
		ExpiresAt string `json:"expiresAt"`
		PeerCount int    `json:"peerCount"`
		MaxPeers  int    `json:"maxPeers"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, value.ExpiresAt)
	if err != nil {
		return err
	}
	s.RoomID = value.RoomID
	s.ExpiresAt = expiresAt
	s.PeerCount = value.PeerCount
	s.MaxPeers = value.MaxPeers
	return nil
}

type CreatedRoom struct {
	RoomID     string    `json:"roomId"`
	InviteLink string    `json:"inviteLink"`
	ExpiresAt  time.Time `json:"-"`
	MaxPeers   int       `json:"maxPeers"`
}

func (r CreatedRoom) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		RoomID     string `json:"roomId"`
		InviteLink string `json:"inviteLink"`
		ExpiresAt  string `json:"expiresAt"`
		MaxPeers   int    `json:"maxPeers"`
	}{
		RoomID:     r.RoomID,
		InviteLink: r.InviteLink,
		ExpiresAt:  formatTimestamp(r.ExpiresAt),
		MaxPeers:   r.MaxPeers,
	})
}

func (r *CreatedRoom) UnmarshalJSON(data []byte) error {
	var value struct {
		RoomID     string `json:"roomId"`
		InviteLink string `json:"inviteLink"`
		ExpiresAt  string `json:"expiresAt"`
		MaxPeers   int    `json:"maxPeers"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, value.ExpiresAt)
	if err != nil {
		return err
	}
	r.RoomID = value.RoomID
	r.InviteLink = value.InviteLink
	r.ExpiresAt = expiresAt
	r.MaxPeers = value.MaxPeers
	return nil
}

type Manager struct {
	mu             sync.Mutex
	rooms          map[string]*roomState
	roomTTL        time.Duration
	emptyRoomGrace time.Duration
	now            func() time.Time
	maxRooms       int
	newRoomID      func() (string, error)
	newPeerID      func() (string, error)
	closed         bool
}

type roomState struct {
	room         Room
	peers        map[string]*peerState
	peerOrder    []string
	expiryTimer  *time.Timer
	cleanupTimer *time.Timer
}

type peerState struct {
	id   string
	conn PeerConn
}

func NewManager(options ManagerOptions) *Manager {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	roomTTL := options.RoomTTL
	if roomTTL <= 0 {
		roomTTL = 2 * time.Hour
	}
	emptyGrace := options.EmptyRoomGrace
	if emptyGrace < 0 {
		emptyGrace = 10 * time.Second
	}
	maxRooms := options.MaxRooms
	if maxRooms <= 0 {
		maxRooms = MaxRooms
	}
	newRoomID := options.NewRoomID
	if newRoomID == nil {
		newRoomID = makeRoomID
	}
	newPeerID := options.NewPeerID
	if newPeerID == nil {
		newPeerID = makePeerID
	}
	return &Manager{
		rooms:          make(map[string]*roomState),
		roomTTL:        roomTTL,
		emptyRoomGrace: emptyGrace,
		now:            now,
		maxRooms:       maxRooms,
		newRoomID:      newRoomID,
		newPeerID:      newPeerID,
	}
}

func (m *Manager) Create(baseURL string) (CreatedRoom, error) {
	if m == nil {
		return CreatedRoom{}, ErrManagerClosed
	}
	now := m.now().UTC()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return CreatedRoom{}, ErrManagerClosed
	}
	expired := m.pruneExpiredLocked(now)
	if len(m.rooms) >= m.maxRooms {
		m.mu.Unlock()
		closePeers(expired)
		return CreatedRoom{}, ErrRoomLimit
	}

	var id string
	for attempt := 0; attempt < 8; attempt++ {
		candidate, err := m.newRoomID()
		if err != nil {
			m.mu.Unlock()
			closePeers(expired)
			return CreatedRoom{}, errors.New("could not allocate a room id")
		}
		id = candidate
		if _, exists := m.rooms[id]; !exists {
			break
		}
	}
	if _, exists := m.rooms[id]; exists {
		m.mu.Unlock()
		closePeers(expired)
		return CreatedRoom{}, errors.New("could not allocate a room id")
	}
	room := &roomState{
		room: Room{
			ID:        id,
			CreatedAt: now,
			ExpiresAt: now.Add(m.roomTTL),
			MaxPeers:  MaxRoomPeers,
		},
		peers: make(map[string]*peerState, MaxRoomPeers),
	}
	m.rooms[id] = room
	room.expiryTimer = time.AfterFunc(m.roomTTL, func() { m.expire(id, room) })
	created := CreatedRoom{
		RoomID:     id,
		InviteLink: strings.TrimRight(baseURL, "/") + "/direct/" + url.PathEscape(id),
		ExpiresAt:  room.room.ExpiresAt,
		MaxPeers:   MaxRoomPeers,
	}
	m.mu.Unlock()
	closePeers(expired)
	return created, nil
}

func (m *Manager) Status(roomID string) (RoomStatus, bool) {
	if m == nil {
		return RoomStatus{}, false
	}
	now := m.now().UTC()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return RoomStatus{}, false
	}
	expired := m.pruneExpiredLocked(now)
	room, ok := m.rooms[roomID]
	if !ok {
		m.mu.Unlock()
		closePeers(expired)
		return RoomStatus{}, false
	}
	status := RoomStatus{
		RoomID:    room.room.ID,
		ExpiresAt: room.room.ExpiresAt,
		PeerCount: len(room.peers),
		MaxPeers:  room.room.MaxPeers,
	}
	m.mu.Unlock()
	closePeers(expired)
	return status, true
}

func (m *Manager) Join(roomID string, conn PeerConn) (string, error) {
	if m == nil || conn == nil {
		return "", ErrManagerClosed
	}
	now := m.now().UTC()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return "", ErrManagerClosed
	}
	expired := m.pruneExpiredLocked(now)
	room, ok := m.rooms[roomID]
	if !ok {
		m.mu.Unlock()
		closePeers(expired)
		return "", ErrRoomNotFound
	}
	if len(room.peers) >= room.room.MaxPeers {
		m.mu.Unlock()
		closePeers(expired)
		return "", ErrRoomFull
	}
	stopCleanup(room)
	peerID, err := m.newPeerID()
	if err != nil || peerID == "" {
		m.mu.Unlock()
		closePeers(expired)
		return "", errors.New("could not allocate a peer id")
	}
	room.peers[peerID] = &peerState{id: peerID, conn: conn}
	room.peerOrder = append(room.peerOrder, peerID)
	peers := publicPeers(room)
	existing := make([]*peerState, 0, len(room.peers)-1)
	for id, peer := range room.peers {
		if id != peerID {
			existing = append(existing, peer)
		}
	}
	m.mu.Unlock()
	closePeers(expired)

	joined := marshalSystem("joined", peerID, peers)
	if err := sendPeer(conn, joined); err != nil {
		m.Leave(roomID, peerID, true)
		return "", err
	}
	peerJoined := marshalSystem("peer-joined", "", peers)
	peerFailed := false
	for _, peer := range existing {
		if err := sendPeer(peer.conn, peerJoined); err != nil {
			m.Leave(roomID, peer.id, false)
			peerFailed = true
		}
	}
	if peerFailed {
		peers = m.currentPeers(roomID)
	}
	m.broadcast(roomID, marshalSystem("peer-list", "", peers), "")
	return peerID, nil
}

func (m *Manager) Leave(roomID, peerID string, immediateCleanup bool) bool {
	if m == nil {
		return false
	}
	now := m.now().UTC()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return false
	}
	expired := m.pruneExpiredLocked(now)
	room, ok := m.rooms[roomID]
	if !ok {
		m.mu.Unlock()
		closePeers(expired)
		return false
	}
	if _, ok := room.peers[peerID]; !ok {
		m.mu.Unlock()
		closePeers(expired)
		return false
	}
	removePeerOrder(room, peerID)
	delete(room.peers, peerID)
	peers := publicPeers(room)
	if len(room.peers) == 0 {
		if immediateCleanup || m.emptyRoomGrace == 0 {
			m.removeRoomLocked(roomID, room)
		} else {
			scheduleCleanup(m, roomID, room)
		}
	}
	m.mu.Unlock()
	closePeers(expired)

	m.broadcast(roomID, marshalSystemWithPeers("peer-left", peers), "")
	if len(peers) > 0 {
		m.broadcast(roomID, marshalSystem("peer-list", "", peers), "")
	}
	return true
}

func (m *Manager) Relay(roomID, peerID string, envelope SecureEnvelope) bool {
	if m == nil {
		return false
	}
	if validateSecureEnvelope(envelope) != nil {
		return false
	}
	now := m.now().UTC()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return false
	}
	expired := m.pruneExpiredLocked(now)
	room, ok := m.rooms[roomID]
	if !ok {
		m.mu.Unlock()
		closePeers(expired)
		return false
	}
	if _, ok := room.peers[peerID]; !ok {
		m.mu.Unlock()
		closePeers(expired)
		return false
	}
	recipients := make([]*peerState, 0, len(room.peers)-1)
	for id, peer := range room.peers {
		if id != peerID {
			recipients = append(recipients, peer)
		}
	}
	m.mu.Unlock()
	closePeers(expired)
	payload := marshalRelayed(envelope, peerID, formatTimestamp(now))
	failed := make([]string, 0)
	for _, peer := range recipients {
		if err := sendPeer(peer.conn, payload); err != nil {
			failed = append(failed, peer.id)
		}
	}
	for _, failedPeerID := range failed {
		m.Leave(roomID, failedPeerID, false)
	}
	return true
}

func (m *Manager) RoomCount() int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	expired := m.pruneExpiredLocked(m.now().UTC())
	count := len(m.rooms)
	m.mu.Unlock()
	closePeers(expired)
	return count
}

func (m *Manager) ConnectionCount() int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	expired := m.pruneExpiredLocked(m.now().UTC())
	count := 0
	for _, room := range m.rooms {
		count += len(room.peers)
	}
	m.mu.Unlock()
	closePeers(expired)
	return count
}

func (m *Manager) Close() {
	if m == nil {
		return
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	peers := make([]*peerState, 0)
	for id, room := range m.rooms {
		stopRoomTimers(room)
		for peerID, peer := range room.peers {
			peers = append(peers, peer)
			delete(room.peers, peerID)
		}
		delete(m.rooms, id)
	}
	m.mu.Unlock()
	for _, peer := range peers {
		_ = peer.conn.Close(1001, "server shutdown")
	}
}

func (m *Manager) broadcast(roomID string, payload []byte, exceptPeerID string) {
	m.mu.Lock()
	room, ok := m.rooms[roomID]
	if !ok || m.closed {
		m.mu.Unlock()
		return
	}
	recipients := make([]*peerState, 0, len(room.peers))
	for peerID, peer := range room.peers {
		if peerID != exceptPeerID {
			recipients = append(recipients, peer)
		}
	}
	m.mu.Unlock()
	failed := make([]string, 0)
	for _, peer := range recipients {
		if err := sendPeer(peer.conn, payload); err != nil {
			failed = append(failed, peer.id)
		}
	}
	for _, peerID := range failed {
		m.Leave(roomID, peerID, false)
	}
}

func (m *Manager) expire(roomID string, expected *roomState) {
	m.mu.Lock()
	room, ok := m.rooms[roomID]
	if !ok || room != expected || m.closed {
		m.mu.Unlock()
		return
	}
	peers := make([]*peerState, 0, len(room.peers))
	for _, peer := range room.peers {
		peers = append(peers, peer)
	}
	m.removeRoomLocked(roomID, room)
	m.mu.Unlock()
	closePeers(peers)
}

func (m *Manager) pruneExpiredLocked(now time.Time) []*peerState {
	var expiredPeers []*peerState
	for id, room := range m.rooms {
		if now.Before(room.room.ExpiresAt) {
			continue
		}
		for _, peer := range room.peers {
			expiredPeers = append(expiredPeers, peer)
		}
		m.removeRoomLocked(id, room)
	}
	return expiredPeers
}

func (m *Manager) removeRoomLocked(roomID string, room *roomState) {
	if current, ok := m.rooms[roomID]; !ok || current != room {
		return
	}
	stopRoomTimers(room)
	delete(m.rooms, roomID)
}

func scheduleCleanup(m *Manager, roomID string, room *roomState) {
	stopCleanup(room)
	room.cleanupTimer = time.AfterFunc(m.emptyRoomGrace, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		current, ok := m.rooms[roomID]
		if !ok || current != room || len(room.peers) != 0 || m.closed {
			return
		}
		m.removeRoomLocked(roomID, room)
	})
}

func stopRoomTimers(room *roomState) {
	if room.expiryTimer != nil {
		room.expiryTimer.Stop()
		room.expiryTimer = nil
	}
	stopCleanup(room)
}

func stopCleanup(room *roomState) {
	if room.cleanupTimer != nil {
		room.cleanupTimer.Stop()
		room.cleanupTimer = nil
	}
}

func sendPeer(conn PeerConn, payload []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return conn.Send(ctx, payload)
}

func closePeers(peers []*peerState) {
	for _, peer := range peers {
		_ = peer.conn.Close(1000, "room expired")
	}
}

func publicPeers(room *roomState) []publicPeer {
	peers := make([]publicPeer, 0, len(room.peerOrder))
	for _, peerID := range room.peerOrder {
		if peer, ok := room.peers[peerID]; ok {
			peers = append(peers, publicPeer{ID: peer.id})
		}
	}
	return peers
}

func removePeerOrder(room *roomState, peerID string) {
	for index, candidate := range room.peerOrder {
		if candidate == peerID {
			copy(room.peerOrder[index:], room.peerOrder[index+1:])
			room.peerOrder = room.peerOrder[:len(room.peerOrder)-1]
			return
		}
	}
}

func (m *Manager) currentPeers(roomID string) []publicPeer {
	m.mu.Lock()
	defer m.mu.Unlock()
	room, ok := m.rooms[roomID]
	if !ok || m.closed {
		return nil
	}
	return publicPeers(room)
}

func makeRoomID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func makePeerID() (string, error) {
	value, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return value.String(), nil
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z07:00")
}
