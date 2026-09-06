//go:build postgres_integration

package botgateway

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestWebSocketRootShutdownDisconnectsPostgresLease(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_botgateway_ws_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = conn.Exec(cleanupContext, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE")
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (migrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 6, 12, 34, 56, 789654321, time.UTC)
	rawToken := "dl_bot_" + strings.Repeat("w", 40)
	seedBotGatewayPG(t, ctx, conn, now, rawToken)
	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	service := NewService(ServiceOptions{
		Repository: NewPGRepository(pool),
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return now },
	})
	handler := NewWebSocketHandler(WebSocketHandlerOptions{
		Gateway:           service,
		SpaceID:           DefaultSpaceID,
		PollInterval:      time.Hour,
		HeartbeatInterval: time.Hour,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	connection, _, err := dialBotGateway(t, server.URL, "Bearer "+rawToken)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.CloseNow() })

	waitForPostgresBotConnectionStatus(t, pool, "bot-botgateway", "connected")
	var connectedNonce string
	if err := pool.QueryRow(ctx, `
		SELECT connection_nonce
		FROM workspace_agent_bot_connections
		WHERE bot_id = $1 AND space_id = $2 AND status = 'connected'
	`, "bot-botgateway", DefaultSpaceID).Scan(&connectedNonce); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(connectedNonce) == "" {
		t.Fatal("connected lease nonce is empty")
	}

	shutdownContext, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	shutdownResult := make(chan error, 1)
	go func() { shutdownResult <- handler.Shutdown(shutdownContext) }()
	closeErr := readWebSocketClose(t, connection)
	if websocket.CloseStatus(closeErr) != websocket.StatusServiceRestart {
		t.Fatalf("shutdown close status = %v, err=%v", websocket.CloseStatus(closeErr), closeErr)
	}
	if err := <-shutdownResult; err != nil {
		t.Fatalf("handler shutdown: %v", err)
	}
	waitForPostgresBotConnectionStatus(t, pool, "bot-botgateway", "disconnected")

	var status, disconnectedNonce string
	var disconnectedAt time.Time
	if err := pool.QueryRow(ctx, `
		SELECT status, connection_nonce, disconnected_at
		FROM workspace_agent_bot_connections
		WHERE bot_id = $1 AND space_id = $2
	`, "bot-botgateway", DefaultSpaceID).Scan(&status, &disconnectedNonce, &disconnectedAt); err != nil {
		t.Fatal(err)
	}
	if status != "disconnected" || disconnectedNonce != connectedNonce || disconnectedAt.IsZero() {
		t.Fatalf("root shutdown lease = status=%q nonce=%q disconnectedAt=%v, want disconnected/%q/non-zero", status, disconnectedNonce, disconnectedAt, connectedNonce)
	}
	var activeLeases int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM workspace_agent_bot_connections
		WHERE bot_id = $1 AND space_id = $2 AND status = 'connected'
	`, "bot-botgateway", DefaultSpaceID).Scan(&activeLeases); err != nil {
		t.Fatal(err)
	}
	if activeLeases != 0 {
		t.Fatalf("root shutdown left %d connected leases", activeLeases)
	}
}

func waitForPostgresBotConnectionStatus(t *testing.T, pool *pgxpool.Pool, botID, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var status string
		var nonce *string
		queryContext, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		err := pool.QueryRow(queryContext, `
			SELECT status, connection_nonce
			FROM workspace_agent_bot_connections
			WHERE bot_id = $1 AND space_id = $2
		`, botID, DefaultSpaceID).Scan(&status, &nonce)
		cancel()
		if err == nil && status == want && nonce != nil && strings.TrimSpace(*nonce) != "" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("connection status = %q err=%v, want %q", status, err, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
