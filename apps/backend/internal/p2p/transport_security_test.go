package p2p

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	platformconfig "github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

func TestP2PHTTPResponsesKeepSecurityHeaders(t *testing.T) {
	handler := NewHandler(HandlerOptions{Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})})
	t.Cleanup(handler.Close)
	server := httptest.NewServer(handler.Routes())
	t.Cleanup(server.Close)

	room := createHTTPTestRoom(t, server.URL)
	for _, path := range []string{
		"/api/health",
		"/api/p2p/ice-servers",
		"/api/p2p/rooms/" + room.RoomID,
		"/api/p2p/rooms/not-found",
		"/metrics",
	} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.Header.Get("X-Content-Type-Options") != "nosniff" || response.Header.Get("Referrer-Policy") != "no-referrer" || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("security headers for %s were not preserved", path)
		}
	}
}

func TestP2PICEProjectionSupportsSTUNAndTURNVariants(t *testing.T) {
	tests := []struct {
		name            string
		stunURLs        []string
		turnURLs        []string
		sharedSecret    string
		turnUsername    string
		turnCredential  string
		wantServerCount int
		wantStatic      bool
		wantShared      bool
	}{
		{
			name:            "stun only",
			stunURLs:        []string{"stun:one.example", "", "stun:two.example"},
			wantServerCount: 2,
		},
		{
			name:            "static turn",
			stunURLs:        []string{"stun:one.example"},
			turnURLs:        []string{"turn:one.example", " turns:two.example "},
			turnUsername:    "synthetic-user",
			turnCredential:  "synthetic-credential",
			wantServerCount: 2,
			wantStatic:      true,
		},
		{
			name:            "shared secret turn",
			stunURLs:        []string{"stun:one.example"},
			turnURLs:        []string{"turns:turn.example:5349"},
			sharedSecret:    "synthetic-shared-secret",
			wantServerCount: 2,
			wantShared:      true,
		},
		{
			name:            "shared secret takes precedence",
			stunURLs:        []string{"stun:one.example"},
			turnURLs:        []string{"turns:turn.example:5349"},
			sharedSecret:    "synthetic-shared-secret",
			turnUsername:    "synthetic-static-user",
			turnCredential:  "synthetic-static-credential",
			wantServerCount: 2,
			wantShared:      true,
		},
		{
			name:            "incomplete static credentials are omitted",
			stunURLs:        []string{"stun:one.example"},
			turnURLs:        []string{"turn:turn.example"},
			turnUsername:    "synthetic-user",
			wantServerCount: 1,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := NewHandler(HandlerOptions{
				Config: platformconfig.P2PConfig{
					STUNURLs:         test.stunURLs,
					TURNURLs:         test.turnURLs,
					TURNSharedSecret: test.sharedSecret,
					TURNUsername:     test.turnUsername,
					TURNCredential:   test.turnCredential,
					TURNTTL:          10 * time.Minute,
				},
				Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour}),
			})
			t.Cleanup(handler.Close)
			request := httptest.NewRequest(http.MethodGet, "/api/p2p/ice-servers", nil)
			response := httptest.NewRecorder()
			handler.Routes().ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("ICE status = %d", response.Code)
			}
			var body struct {
				ICEServers []struct {
					URLs       any    `json:"urls"`
					Username   string `json:"username"`
					Credential string `json:"credential"`
				} `json:"iceServers"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if len(body.ICEServers) != test.wantServerCount {
				t.Fatalf("ICE server count = %d, want %d", len(body.ICEServers), test.wantServerCount)
			}
			if len(body.ICEServers) == 0 {
				return
			}
			turn := body.ICEServers[len(body.ICEServers)-1]
			if test.wantStatic {
				if turn.Username != test.turnUsername || turn.Credential != test.turnCredential {
					t.Fatal("static TURN credentials were not projected")
				}
			}
			if test.wantShared {
				if !strings.HasSuffix(turn.Username, ":duallane") || turn.Credential == test.turnCredential {
					t.Fatal("shared-secret TURN credentials were not projected")
				}
				decoded, err := base64.StdEncoding.DecodeString(turn.Credential)
				if err != nil || len(decoded) != 20 {
					t.Fatal("shared-secret TURN credential was not a SHA-1 HMAC")
				}
			}
		})
	}
}

func TestP2PWebSocketOversizeFrameUsesMessageTooBigClose(t *testing.T) {
	handler := NewHandler(HandlerOptions{
		Config:  platformconfig.P2PConfig{MaxFrameBytes: 1024},
		Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour}),
	})
	t.Cleanup(handler.Close)
	server := httptest.NewServer(handler.Routes())
	t.Cleanup(server.Close)
	room := createHTTPTestRoom(t, server.URL)
	conn := dialP2P(t, server.URL, room.RoomID)
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	_ = readJSONFrame(t, conn)
	_ = readJSONFrame(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(strings.Repeat("x", 2048))); err != nil {
		t.Fatal(err)
	}
	if got := readP2PCloseCode(t, conn); got != int(websocket.StatusMessageTooBig) {
		t.Fatalf("oversized frame close code = %d, want %d", got, websocket.StatusMessageTooBig)
	}
}

func TestP2PWebSocketLeaveAndServerShutdownUseSafeCloseCodes(t *testing.T) {
	t.Run("leave", func(t *testing.T) {
		handler := NewHandler(HandlerOptions{
			Config:  platformconfig.P2PConfig{EmptyRoomGrace: 0},
			Manager: NewManager(ManagerOptions{EmptyRoomGrace: 0}),
		})
		t.Cleanup(handler.Close)
		server := httptest.NewServer(handler.Routes())
		t.Cleanup(server.Close)
		room := createHTTPTestRoom(t, server.URL)
		conn := dialP2P(t, server.URL, room.RoomID)
		t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
		_ = readJSONFrame(t, conn)
		_ = readJSONFrame(t, conn)
		if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"leave"}`)); err != nil {
			t.Fatal(err)
		}
		if got := readP2PCloseCode(t, conn); got != int(websocket.StatusNoStatusRcvd) {
			t.Fatalf("leave close code = %d, want %d", got, websocket.StatusNoStatusRcvd)
		}
	})

	t.Run("server shutdown", func(t *testing.T) {
		handler := NewHandler(HandlerOptions{Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})})
		server := httptest.NewServer(handler.Routes())
		t.Cleanup(server.Close)
		room := createHTTPTestRoom(t, server.URL)
		conn := dialP2P(t, server.URL, room.RoomID)
		t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
		_ = readJSONFrame(t, conn)
		_ = readJSONFrame(t, conn)
		closed := make(chan struct{})
		go func() {
			handler.Close()
			close(closed)
		}()
		if got := readP2PCloseCode(t, conn); got != int(websocket.StatusGoingAway) {
			t.Fatalf("server shutdown close code = %d, want %d", got, websocket.StatusGoingAway)
		}
		select {
		case <-closed:
		case <-time.After(time.Second):
			t.Fatal("server shutdown did not finish within the bound")
		}
	})
}

func TestP2PWebSocketRoomErrorsMatchNodeEmptyCloseFrame(t *testing.T) {
	handler := NewHandler(HandlerOptions{Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})})
	t.Cleanup(handler.Close)
	server := httptest.NewServer(handler.Routes())
	t.Cleanup(server.Close)
	room := createHTTPTestRoom(t, server.URL)
	first := dialP2P(t, server.URL, room.RoomID)
	t.Cleanup(func() { _ = first.Close(websocket.StatusNormalClosure, "") })
	_ = readJSONFrame(t, first)
	_ = readJSONFrame(t, first)
	second := dialP2P(t, server.URL, room.RoomID)
	t.Cleanup(func() { _ = second.Close(websocket.StatusNormalClosure, "") })
	_ = readJSONFrame(t, second)
	third := dialP2P(t, server.URL, room.RoomID)
	t.Cleanup(func() { _ = third.Close(websocket.StatusNormalClosure, "") })
	full := readJSONFrame(t, third)
	if full["event"] != "room-full" {
		t.Fatalf("full response = %#v", full)
	}
	if got := readP2PCloseCode(t, third); got != int(websocket.StatusNoStatusRcvd) {
		t.Errorf("room-full close code = %d, want %d", got, websocket.StatusNoStatusRcvd)
	}

	missing := dialP2P(t, server.URL, "not-found")
	t.Cleanup(func() { _ = missing.Close(websocket.StatusNormalClosure, "") })
	notFound := readJSONFrame(t, missing)
	if notFound["event"] != "room-not-found" {
		t.Fatalf("missing response = %#v", notFound)
	}
	if got := readP2PCloseCode(t, missing); got != int(websocket.StatusNoStatusRcvd) {
		t.Errorf("room-not-found close code = %d, want %d", got, websocket.StatusNoStatusRcvd)
	}
}

func readP2PCloseCode(t *testing.T, conn *websocket.Conn) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, err := conn.Read(ctx)
	if err == nil {
		t.Fatal("WebSocket did not close")
	}
	code := websocket.CloseStatus(err)
	if code < websocket.StatusNormalClosure {
		t.Fatalf("WebSocket closed without a protocol close code")
	}
	return int(code)
}
