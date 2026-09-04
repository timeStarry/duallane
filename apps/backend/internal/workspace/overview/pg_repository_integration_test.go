//go:build postgres_integration

package overview

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGStatisticsCountsAndRejectedAudit(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())

	schema := fmt.Sprintf("duallane_overview_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE")
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	runner := platformmigrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations")),
	}
	if _, err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}

	location := time.FixedZone("Asia/Shanghai", 8*60*60)
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, location)
	old := now.Add(-48 * time.Hour)
	today := now.Add(-time.Hour)
	for _, user := range []struct {
		id, role string
		joinedAt time.Time
	}{{"owner", "owner", old}, {"member", "member", today}} {
		if _, err := conn.Exec(ctx, `INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ($1, $1, $1, 'human', $2)`, user.id, old); err != nil {
			t.Fatal(err)
		}
		if user.id == "owner" {
			if _, err := conn.Exec(ctx, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'DualLane', 'overview', $2, $3)`, DefaultSpaceID, user.id, old); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := conn.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`, DefaultSpaceID, user.id, user.role, user.joinedAt); err != nil {
			t.Fatal(err)
		}
	}
	for index, createdAt := range []time.Time{old, today} {
		conversationID := fmt.Sprintf("conversation-%d", index)
		if _, err := conn.Exec(ctx, `INSERT INTO conversations (id, space_id, type, title, retention_count, created_by, created_at) VALUES ($1, $2, 'group', $1, 10000, 'owner', $3)`, conversationID, DefaultSpaceID, createdAt); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, `INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, content_format, content_json, plain_text, created_at) VALUES ($1, $2, $3, 'owner', 'human', 'user', 'duallane.message+json;v=1', '{"format":"duallane.message+json;v=1","plainText":"x","blocks":[]}', 'x', $4)`, fmt.Sprintf("message-%d", index), DefaultSpaceID, conversationID, createdAt); err != nil {
			t.Fatal(err)
		}
		byteSize := int64(100 - index*50)
		if _, err := conn.Exec(ctx, `INSERT INTO attachments (id, space_id, uploader_id, visibility, status, file_name, mime_type, byte_size, created_at, completed_at) VALUES ($1, $2, 'owner', 'space', 'available', $1, 'text/plain', $3, $4, $4)`, fmt.Sprintf("attachment-%d", index), DefaultSpaceID, byteSize, createdAt); err != nil {
			t.Fatal(err)
		}
	}

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	service := NewService(ServiceOptions{Repository: NewPGRepository(pool), Now: func() time.Time { return now }, Location: location, IDFactory: func() (string, error) { return "statistics-audit", nil }})

	statistics, err := service.GetStatistics(ctx, "owner", auth.RequestMeta{})
	if err != nil {
		t.Fatal(err)
	}
	if statistics.Totals != (Counts{Members: 2, Conversations: 2, Messages: 2, Files: 2, UploadedBytes: 150}) {
		t.Fatalf("totals = %#v", statistics.Totals)
	}
	if statistics.Today != (Counts{Members: 1, Conversations: 1, Messages: 1, Files: 1, UploadedBytes: 50}) {
		t.Fatalf("today = %#v", statistics.Today)
	}
	if statistics.DayStartedAt != "2026-09-03T16:00:00.000Z" {
		t.Fatalf("day boundary = %q", statistics.DayStartedAt)
	}

	if _, err := service.GetStatistics(ctx, "member", auth.RequestMeta{RequestID: "statistics-denied"}); err == nil {
		t.Fatal("member statistics request unexpectedly succeeded")
	}
	var auditCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE request_id = 'statistics-denied' AND action = 'workspace.statistics.read' AND result = 'rejected'`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("rejection audits = %d", auditCount)
	}
}
