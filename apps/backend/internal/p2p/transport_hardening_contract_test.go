package p2p

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestP2PDefaultTransportBoundsIgnoredEnvelopeFields(t *testing.T) {
	handler := NewHandler(HandlerOptions{Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})})
	t.Cleanup(handler.Close)
	server := httptest.NewServer(handler.Routes())
	t.Cleanup(server.Close)
	room := createHTTPTestRoom(t, server.URL)
	first := dialP2P(t, server.URL, room.RoomID)
	t.Cleanup(func() { _ = first.CloseNow() })
	_ = readJSONFrame(t, first)
	_ = readJSONFrame(t, first)
	second := dialP2P(t, server.URL, room.RoomID)
	t.Cleanup(func() { _ = second.CloseNow() })
	_ = readJSONFrame(t, second)
	_ = readJSONFrame(t, first)
	_ = readJSONFrame(t, first)
	_ = readJSONFrame(t, second)

	const prefix = `{"type":"secure","v":1,"channel":"ws-chat","nonce":"A","ciphertext":"B","padding":"`
	const suffix = `"}`
	const limit = 64 * 1024
	message := prefix + strings.Repeat("x", limit-len(prefix)-len(suffix)) + suffix
	if _, err := ParseClientMessage([]byte(message)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := first.Write(ctx, websocket.MessageText, []byte(message)); err != nil {
		t.Fatal(err)
	}
	relayed := readJSONFrame(t, second)
	if relayed["type"] != "secure" || relayed["ciphertext"] != "B" {
		t.Fatal("bounded envelope was not relayed")
	}
	if _, exists := relayed["padding"]; exists {
		t.Fatal("ignored field entered the relay projection")
	}

	oversize := prefix + strings.Repeat("x", limit-len(prefix)-len(suffix)+1) + suffix
	if _, err := ParseClientMessage([]byte(oversize)); err != nil {
		t.Fatal("fixture is not a valid application envelope")
	}
	if err := first.Write(ctx, websocket.MessageText, []byte(oversize)); err != nil {
		t.Fatal(err)
	}
	if got := readP2PCloseCode(t, first); got != int(websocket.StatusMessageTooBig) {
		t.Fatalf("over-limit close = %d, want 1009", got)
	}
}

func TestP2PBrowserOriginCompatibilityBoundary(t *testing.T) {
	for _, test := range []struct {
		name      string
		crossHost bool
		absent    bool
	}{
		{name: "same host"}, {name: "absent nonbrowser origin", absent: true}, {name: "cross host", crossHost: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := NewHandler(HandlerOptions{Manager: NewManager(ManagerOptions{EmptyRoomGrace: time.Hour})})
			t.Cleanup(handler.Close)
			server := httptest.NewServer(handler.Routes())
			t.Cleanup(server.Close)
			room := createHTTPTestRoom(t, server.URL)
			headers := make(http.Header)
			if !test.absent {
				origin := server.URL
				if test.crossHost {
					origin = "https://cross-origin.example"
				}
				headers.Set("Origin", origin)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			conn, response, err := websocket.Dial(ctx, strings.Replace(server.URL, "http://", "ws://", 1)+"/ws/p2p/"+room.RoomID, &websocket.DialOptions{HTTPHeader: headers})
			if conn != nil {
				t.Cleanup(func() { _ = conn.CloseNow() })
			}
			if test.crossHost {
				if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
					t.Fatal("cross-host browser origin was not rejected with 403")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if frame := readJSONFrame(t, conn); frame["event"] != "joined" {
				t.Fatal("supported client did not join")
			}
		})
	}
}
