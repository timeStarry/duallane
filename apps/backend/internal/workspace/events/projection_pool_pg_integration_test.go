//go:build postgres_integration

package events

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

// TestPGRealtimeCatchupWithListenerBudget exercises the same small connection
// budget as a workspace process with a long-lived PGListener connection and
// two simultaneous WebSocket catch-up calls. Before the projection closes the
// conversation-member rows before hydrating each member, each call could hold
// one pool connection while waiting for another connection for its nested
// QueryRow. The two calls then stopped making progress instead of replaying all
// 28 durable message events.
func TestPGRealtimeCatchupWithListenerBudget(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_realtime_projection_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("clean synthetic catch-up schema: %v", err)
		}
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

	seedRealtimeCatchupData(t, ctx, conn)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.MaxConns = 2
	poolConfig.MinConns = 0
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	// PGListener holds one pool connection from LISTEN registration until it
	// reconnects or shuts down. Retain the connection here to model that real
	// process budget without starting a second listener or publishing notices.
	listenerConnection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(listenerConnection.Release)

	service := NewService(ServiceOptions{
		Repository:  NewPGRepository(pool),
		BatchSize:   64,
		ReplayLimit: 64,
	})
	type replayResult struct {
		actorID string
		result  ReplayResult
		err     error
	}
	results := make(chan replayResult, 2)
	start := make(chan struct{})
	var group sync.WaitGroup
	for _, actorID := range []string{"usr_catchup_a", "usr_catchup_b"} {
		actorID := actorID
		group.Add(1)
		go func() {
			defer group.Done()
			replayContext, replayCancel := context.WithTimeout(ctx, 5*time.Second)
			defer replayCancel()
			<-start
			result, replayErr := service.Replay(replayContext, ReplayInput{ActorID: actorID})
			results <- replayResult{actorID: actorID, result: result, err: replayErr}
		}()
	}
	close(start)
	group.Wait()
	close(results)

	for replay := range results {
		if replay.err != nil {
			t.Fatalf("actor %s catch-up failed with listener-sized pool: %v", replay.actorID, replay.err)
		}
		if replay.result.HasMore || len(replay.result.Events) != 28 {
			t.Fatalf("actor %s replay metadata = count:%d hasMore:%t current:%d, want 28 events without paging remainder", replay.actorID, len(replay.result.Events), replay.result.HasMore, replay.result.CurrentSeq)
		}
		for index, event := range replay.result.Events {
			wantSeq := int64(index + 1)
			if event.Seq != wantSeq {
				t.Fatalf("actor %s replay event %d has seq %d, want %d", replay.actorID, index, event.Seq, wantSeq)
			}
		}
	}
}

func seedRealtimeCatchupData(t *testing.T, ctx context.Context, conn *pgx.Conn) {
	t.Helper()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	for _, user := range []struct {
		id, login, name string
	}{
		{"usr_catchup_a", "catchup-a", "Catch-up A"},
		{"usr_catchup_b", "catchup-b", "Catch-up B"},
	} {
		mustExecCatchupPG(t, ctx, conn, `
			INSERT INTO users (id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
			VALUES ($1, $2, $3, $4, $4, 'human', $5, $5)
		`, user.id, user.login, user.login+"@example.test", user.name, now)
	}
	mustExecCatchupPG(t, ctx, conn, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ('spc_default', 'Realtime catch-up', 'realtime-catchup', $1, $2)
	`, "usr_catchup_a", now)
	for _, userID := range []string{"usr_catchup_a", "usr_catchup_b"} {
		mustExecCatchupPG(t, ctx, conn, `
			INSERT INTO space_members (space_id, user_id, role, joined_at)
			VALUES ('spc_default', $1, 'member', $2)
		`, userID, now)
	}
	mustExecCatchupPG(t, ctx, conn, `
		INSERT INTO conversations (id, space_id, type, title, created_by, created_at)
		VALUES ('conv-catchup', 'spc_default', 'group', 'Catch-up', 'usr_catchup_a', $1)
	`, now)
	for _, userID := range []string{"usr_catchup_a", "usr_catchup_b"} {
		mustExecCatchupPG(t, ctx, conn, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ('conv-catchup', $1, $2)
		`, userID, now)
	}

	for index := 1; index <= 28; index++ {
		messageID := fmt.Sprintf("msg-catchup-%02d", index)
		authorID := "usr_catchup_a"
		if index%2 == 0 {
			authorID = "usr_catchup_b"
		}
		text := fmt.Sprintf("history%d", index)
		content, err := json.Marshal(map[string]any{
			"format":    "duallane.message+json;v=1",
			"plainText": text,
			"blocks": []map[string]any{{
				"type": "text",
				"text": text,
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		createdAt := now.Add(time.Duration(index) * time.Second)
		mustExecCatchupPG(t, ctx, conn, `
			INSERT INTO messages (
				id, space_id, conversation_id, author_id, author_kind, kind,
				client_message_id, content_format, content_json, plain_text, created_at
			) VALUES ($1, 'spc_default', 'conv-catchup', $2, 'human', 'user', $3,
				'duallane.message+json;v=1', $4, $5, $6)
		`, messageID, authorID, "client-"+messageID, string(content), text, createdAt)
		payload := fmt.Sprintf(`{"messageId":%q,"conversationId":"conv-catchup"}`, messageID)
		mustExecCatchupPG(t, ctx, conn, `
			INSERT INTO workspace_events (
				id, space_id, seq, type, actor_user_id, conversation_id,
				target_type, target_id, payload_json, created_at
			) VALUES ($1, 'spc_default', $2, 'message.created', $3, 'conv-catchup',
				'message', $4, $5, $6)
		`, "evt-catchup-"+fmt.Sprintf("%02d", index), index, authorID, messageID, payload, createdAt)
	}
}

func mustExecCatchupPG(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}
