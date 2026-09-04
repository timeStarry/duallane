package p2p

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	platformconfig "github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

func TestP2PHTTPContract(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	defer manager.Close()
	handler := NewHandler(HandlerOptions{
		Config: platformconfig.P2PConfig{
			AppVersion:     "0.15.5-go",
			PublicBaseURL:  "https://duallane.example",
			STUNURLs:       []string{"stun:one.example", "stun:two.example"},
			TURNURLs:       []string{"turns:turn.example:5349"},
			TURNUsername:   "user",
			TURNCredential: "credential",
			TURNTTL:        10 * time.Minute,
			MaxFrameBytes:  64 * 1024,
			RoomTTL:        2 * time.Hour,
			EmptyRoomGrace: time.Hour,
		},
		Manager: manager,
	})

	server := httptest.NewServer(handler.Routes())
	defer server.Close()

	response, err := http.Post(server.URL+"/api/p2p/rooms", "application/json", strings.NewReader(`{"maxPeers":2}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create status = %d", response.StatusCode)
	}
	if response.Header.Get("X-Content-Type-Options") != "nosniff" || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("security headers = %#v", response.Header)
	}
	var created CreatedRoom
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.MaxPeers != MaxRoomPeers || len(created.RoomID) != 22 || created.InviteLink != "https://duallane.example/direct/"+created.RoomID {
		t.Fatalf("created room = %#v", created)
	}
	if created.ExpiresAt.IsZero() || created.ExpiresAt.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("created expiration = %v", created.ExpiresAt)
	}

	statusResponse, err := http.Get(server.URL + "/api/p2p/rooms/" + created.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	defer statusResponse.Body.Close()
	if statusResponse.StatusCode != http.StatusOK {
		t.Fatalf("room status = %d", statusResponse.StatusCode)
	}
	var status RoomStatus
	if err := json.NewDecoder(statusResponse.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.RoomID != created.RoomID || status.PeerCount != 0 || status.MaxPeers != MaxRoomPeers {
		t.Fatalf("room status = %#v", status)
	}

	iceResponse, err := http.Get(server.URL + "/api/p2p/ice-servers")
	if err != nil {
		t.Fatal(err)
	}
	defer iceResponse.Body.Close()
	var ice struct {
		ICEServers []iceServer `json:"iceServers"`
	}
	if err := json.NewDecoder(iceResponse.Body).Decode(&ice); err != nil {
		t.Fatal(err)
	}
	if len(ice.ICEServers) != 3 {
		t.Fatalf("ice servers = %#v", ice.ICEServers)
	}

	invalidResponse, err := http.Post(server.URL+"/api/p2p/rooms", "application/json", strings.NewReader(`{"maxPeers":3}`))
	if err != nil {
		t.Fatal(err)
	}
	defer invalidResponse.Body.Close()
	if invalidResponse.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid create status = %d", invalidResponse.StatusCode)
	}
	invalidBody, _ := io.ReadAll(invalidResponse.Body)
	if string(invalidBody) != `{"error":"maxPeers must be 2 for p2p rooms"}
` {
		t.Fatalf("invalid body = %q", invalidBody)
	}

	healthResponse, err := http.Get(server.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer healthResponse.Body.Close()
	var health map[string]any
	if err := json.NewDecoder(healthResponse.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if health["ok"] != true || health["service"] != "duallane" || health["lane"] != "ready" || health["appVersion"] != "0.15.5-go" {
		t.Fatalf("health = %#v", health)
	}

	missingResponse, err := http.Get(server.URL + "/api/p2p/rooms/not-a-room")
	if err != nil {
		t.Fatal(err)
	}
	defer missingResponse.Body.Close()
	if missingResponse.StatusCode != http.StatusNotFound {
		t.Fatalf("missing room status = %d", missingResponse.StatusCode)
	}
}

func TestP2PHTTPUsesForwardedOriginForInvite(t *testing.T) {
	handler := NewHandler(HandlerOptions{
		Config:  platformconfig.P2PConfig{TrustProxy: true},
		Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour}),
	})
	defer handler.Close()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/p2p/rooms", strings.NewReader(`{"maxPeers":2}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Host = "edge.example"
	handler.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var created CreatedRoom
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.InviteLink, "https://edge.example/direct/") {
		t.Fatalf("invite link = %q", created.InviteLink)
	}
}

func TestP2PHTTPIgnoresForwardedOriginWhenProxyIsUntrusted(t *testing.T) {
	handler := NewHandler(HandlerOptions{Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})})
	defer handler.Close()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/p2p/rooms", strings.NewReader(`{"maxPeers":2}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Host = "edge.example"
	handler.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var created CreatedRoom
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.InviteLink, "http://edge.example/direct/") {
		t.Fatalf("untrusted forwarded invite link = %q", created.InviteLink)
	}
}

func TestP2PWebSocketRelaysSecureFramesAndRejectsPlaintext(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	handler := NewHandler(HandlerOptions{
		Config:  platformconfig.P2PConfig{AppVersion: "test", MaxFrameBytes: 64 * 1024},
		Manager: manager,
	})
	defer handler.Close()
	server := httptest.NewServer(handler.Routes())
	defer server.Close()

	room := createHTTPTestRoom(t, server.URL)
	first := dialP2P(t, server.URL, room.RoomID)
	defer first.Close(websocket.StatusNormalClosure, "")
	firstJoined := readJSONFrame(t, first)
	if firstJoined["event"] != "joined" || firstJoined["peerId"] == nil {
		t.Fatalf("first joined = %#v", firstJoined)
	}
	firstPeerID := firstJoined["peerId"].(string)
	_ = readJSONFrame(t, first)

	second := dialP2P(t, server.URL, room.RoomID)
	defer second.Close(websocket.StatusNormalClosure, "")
	secondJoined := readJSONFrame(t, second)
	if secondJoined["event"] != "joined" {
		t.Fatalf("second joined = %#v", secondJoined)
	}
	peerJoined := readJSONFrame(t, first)
	if peerJoined["event"] != "peer-joined" {
		t.Fatalf("peer joined = %#v", peerJoined)
	}
	_ = readJSONFrame(t, first)
	_ = readJSONFrame(t, second)

	if err := first.Write(context.Background(), websocket.MessageText, []byte(`{"type":"message","body":"do not relay"}`)); err != nil {
		t.Fatal(err)
	}
	invalid := readJSONFrame(t, first)
	if invalid["event"] != "invalid-message" {
		t.Fatalf("invalid response = %#v", invalid)
	}

	secure := `{"type":"secure","v":1,"channel":"ws-chat","nonce":"abc123_-","ciphertext":"opaque_ciphertext_-"}`
	if err := first.Write(context.Background(), websocket.MessageText, []byte(secure)); err != nil {
		t.Fatal(err)
	}
	relayed := readJSONFrame(t, second)
	if relayed["type"] != "secure" || relayed["channel"] != "ws-chat" || relayed["nonce"] != "abc123_-" || relayed["ciphertext"] != "opaque_ciphertext_-" {
		t.Fatalf("relayed = %#v", relayed)
	}
	from, ok := relayed["from"].(map[string]any)
	if !ok || from["id"] != firstPeerID {
		t.Fatalf("relay from = %#v", relayed["from"])
	}
	if _, ok := relayed["receivedAt"].(string); !ok {
		t.Fatalf("relay receivedAt = %#v", relayed["receivedAt"])
	}

	if err := first.Write(context.Background(), websocket.MessageText, []byte(`{"type":"secure","v":1,"channel":"ws-chat","nonce":"n=","ciphertext":"c"}`)); err != nil {
		t.Fatal(err)
	}
	invalid = readJSONFrame(t, first)
	if invalid["event"] != "invalid-message" {
		t.Fatalf("invalid envelope response = %#v", invalid)
	}
}

func TestP2PWebSocketRoomFullAndMissing(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	handler := NewHandler(HandlerOptions{Manager: manager})
	defer handler.Close()
	server := httptest.NewServer(handler.Routes())
	defer server.Close()
	room := createHTTPTestRoom(t, server.URL)
	first := dialP2P(t, server.URL, room.RoomID)
	defer first.Close(websocket.StatusNormalClosure, "")
	_ = readJSONFrame(t, first)
	second := dialP2P(t, server.URL, room.RoomID)
	defer second.Close(websocket.StatusNormalClosure, "")
	_ = readJSONFrame(t, second)
	third, _, err := websocket.Dial(context.Background(), strings.Replace(server.URL, "http://", "ws://", 1)+"/ws/p2p/"+room.RoomID, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close(websocket.StatusNormalClosure, "")
	full := readJSONFrame(t, third)
	if full["event"] != "room-full" {
		t.Fatalf("full response = %#v", full)
	}

	missing, _, err := websocket.Dial(context.Background(), strings.Replace(server.URL, "http://", "ws://", 1)+"/ws/p2p/not-found", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer missing.Close(websocket.StatusNormalClosure, "")
	notFound := readJSONFrame(t, missing)
	if notFound["event"] != "room-not-found" {
		t.Fatalf("missing response = %#v", notFound)
	}
}

func TestP2PWebSocketRejectsCrossOrigin(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	handler := NewHandler(HandlerOptions{Manager: manager})
	defer handler.Close()
	server := httptest.NewServer(handler.Routes())
	defer server.Close()
	room := createHTTPTestRoom(t, server.URL)
	wsURL := strings.Replace(server.URL, "http://", "ws://", 1) + "/ws/p2p/" + room.RoomID
	_, _, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://evil.example"}},
	})
	if err == nil {
		t.Fatal("cross-origin WebSocket handshake succeeded")
	}
}

func TestP2PWebSocketRejectsOversizedFrame(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	handler := NewHandler(HandlerOptions{
		Config:  platformconfig.P2PConfig{MaxFrameBytes: 1024},
		Manager: manager,
	})
	defer handler.Close()
	server := httptest.NewServer(handler.Routes())
	defer server.Close()
	room := createHTTPTestRoom(t, server.URL)
	conn := dialP2P(t, server.URL, room.RoomID)
	defer conn.Close(websocket.StatusNormalClosure, "")
	_ = readJSONFrame(t, conn)
	_ = readJSONFrame(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(strings.Repeat("x", 2048))); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, err := conn.Read(readCtx)
	if err == nil {
		t.Fatal("oversized frame did not close the connection")
	}
}

func TestTurnCredentialMatchesCoturnRESTContract(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	username, credential := makeTURNCredential("secret", 10*time.Minute, now)
	wantUsername := "1700000600:duallane"
	mac := hmac.New(sha1.New, []byte("secret"))
	_, _ = mac.Write([]byte(wantUsername))
	wantCredential := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if username != wantUsername || credential != wantCredential {
		t.Fatalf("credential = %q/%q, want %q/%q", username, credential, wantUsername, wantCredential)
	}
}

func createHTTPTestRoom(t *testing.T, serverURL string) CreatedRoom {
	t.Helper()
	response, err := http.Post(serverURL+"/api/p2p/rooms", "application/json", strings.NewReader(`{"maxPeers":2}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create room status = %d", response.StatusCode)
	}
	var room CreatedRoom
	if err := json.NewDecoder(response.Body).Decode(&room); err != nil {
		t.Fatal(err)
	}
	return room
}

func dialP2P(t *testing.T, serverURL, roomID string) *websocket.Conn {
	t.Helper()
	wsURL := strings.Replace(serverURL, "http://", "ws://", 1) + "/ws/p2p/" + roomID
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func readJSONFrame(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	messageType, payload, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("message type = %v", messageType)
	}
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("payload = %q: %v", payload, err)
	}
	return value
}

func TestP2PMetricsDoNotContainRoomIdentifiers(t *testing.T) {
	manager := NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})
	handler := NewHandler(HandlerOptions{Manager: manager})
	defer handler.Close()
	server := httptest.NewServer(handler.Routes())
	defer server.Close()
	room := createHTTPTestRoom(t, server.URL)
	response, err := http.Get(server.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), room.RoomID) {
		t.Fatalf("metrics contain room id %q", room.RoomID)
	}
	if !strings.Contains(string(body), "duallane_p2p_rooms") {
		t.Fatalf("metrics missing room gauge: %s", body)
	}
}

func TestP2PHTTPBodyLimit(t *testing.T) {
	handler := NewHandler(HandlerOptions{Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})})
	defer handler.Close()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/p2p/rooms", strings.NewReader(fmt.Sprintf(`{"maxPeers":2,"padding":"%s"}`, strings.Repeat("a", createRoomBodyLimit))))
	request.Header.Set("Content-Type", "application/json")
	handler.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("body-limit status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestP2PHandlerPreservesImmediateEmptyRoomCleanup(t *testing.T) {
	handler := NewHandler(HandlerOptions{
		Config: platformconfig.P2PConfig{EmptyRoomGrace: 0},
	})
	defer handler.Close()

	room, err := handler.Manager().Create("http://127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	peer := &testPeerConn{}
	peerID, err := handler.Manager().Join(room.RoomID, peer)
	if err != nil {
		t.Fatal(err)
	}
	if !handler.Manager().Leave(room.RoomID, peerID, false) {
		t.Fatal("expected peer to leave the room")
	}
	if _, ok := handler.Manager().Status(room.RoomID); ok {
		t.Fatal("room with zero grace period was not removed immediately")
	}
}
