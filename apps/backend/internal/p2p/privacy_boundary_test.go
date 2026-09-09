package p2p

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/logging"
)

func TestP2PRuntimeDependencyBoundaryExcludesWorkspacePersistence(t *testing.T) {
	_, sourcePath, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate the P2P test source")
	}
	backendDir := filepath.Clean(filepath.Join(filepath.Dir(sourcePath), "..", ".."))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "go", "list", "-deps", "./cmd/p2p")
	command.Dir = backendDir
	command.Env = append(os.Environ(), "GOWORK=off")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("P2P dependency graph command failed: %v", err)
	}

	dependencyGraph := string(output)
	for _, forbidden := range []string{
		"github.com/jackc/pgx",
		"github.com/aws/aws-sdk-go-v2/service/s3",
		"/internal/platform/postgres",
		"/internal/platform/storage",
		"/internal/workspace",
		"database/sql\n",
	} {
		if strings.Contains(dependencyGraph, forbidden) {
			t.Fatalf("P2P dependency graph crosses the persistence boundary")
		}
	}
}

func TestP2PRelayLifecycleDoesNotRetainContentAfterRoomCleanup(t *testing.T) {
	const marker = "synthetic-private-envelope-marker"

	manager := NewManager(ManagerOptions{EmptyRoomGrace: 0})
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

	if !manager.Relay(room.RoomID, firstID, SecureEnvelope{
		Type:       "secure",
		Version:    SecureEnvelopeVersion,
		Channel:    "ws-chat",
		Nonce:      "synthetic-nonce",
		Ciphertext: marker,
	}) {
		t.Fatal("secure envelope was not relayed")
	}
	if messages := second.snapshotMessages(); len(messages) == 0 || !strings.Contains(string(messages[len(messages)-1]), marker) {
		t.Fatal("secure envelope did not reach the transient peer")
	}

	if !manager.Leave(room.RoomID, firstID, true) || !manager.Leave(room.RoomID, secondID, true) {
		t.Fatal("peer cleanup did not remove both peers")
	}
	manager.Close()
	if manager.RoomCount() != 0 || manager.ConnectionCount() != 0 {
		t.Fatal("P2P cleanup retained room or connection state")
	}
}

func TestP2PLoggerFiltersContentBearingAttributes(t *testing.T) {
	const marker = "synthetic-private-content-marker"
	var output bytes.Buffer
	logger := logging.New(logging.Options{
		Service: "p2p",
		Version: "test",
		Writer:  &output,
	})
	logger.WarnContext(context.Background(), "frame rejected",
		slog.String("error_code", "invalid_envelope"),
		slog.String("request_id", "synthetic-request"),
		slog.String("ciphertext", marker),
		slog.String("room_id", marker),
		slog.String("body", marker),
	)

	if !strings.Contains(output.String(), `"error_code":"invalid_envelope"`) || !strings.Contains(output.String(), `"request_id":"synthetic-request"`) {
		t.Fatal("safe operational fields were not retained in the P2P log projection")
	}
	if strings.Contains(output.String(), marker) {
		t.Fatal("P2P log projection retained content-bearing data")
	}
}
