//go:build postgres_integration

package ntfy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestPGNtfyDurablePreferencesSchedulingLeasesAndEligibility(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_ntfy_%d", time.Now().UnixNano())
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
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (platformmigrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 4, 12, 0, 0, 789654321, time.UTC)
	seedNtfyData(t, ctx, conn, now)
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

	var ids atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("ntfy-integration-%d", ids.Add(1)), nil
	}
	var current = now
	var published []Notification
	publisher := PublisherFunc(func(_ context.Context, input PublishInput) error {
		published = append(published, input)
		return nil
	})
	repository := NewPGRepository(pool, idFactory)
	service := NewService(ServiceOptions{
		Repository: repository,
		Now:        func() time.Time { return current },
		TopicFactory: func(login string) (string, error) {
			return "duallane-" + login + "-ABC123", nil
		},
		Publisher:   publisher,
		ServerURL:   "https://ntfy.example.test",
		FrontendURL: "https://duallane.example.test",
	})

	preferences, err := service.GetPreferences(ctx, "usr_recipient")
	if err != nil {
		t.Fatal(err)
	}
	if preferences.Topic != "duallane-recipient-ABC123" || preferences.CreatedAt != "2026-09-04T12:00:00.789Z" {
		t.Fatalf("preferences = %#v", preferences)
	}
	if err := service.ScheduleMessage(ctx, ScheduleInput{
		AuthorID: "usr_author", ConversationID: "conv_ntfy", MessageID: "msg_ntfy_1", EventSeq: 11,
		ContentJSON: []byte(`{"format":"duallane.message+json;v=1","plainText":"private body","blocks":[{"type":"text","text":"private body"}]}`), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	var jobStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM workspace_ntfy_jobs WHERE message_id = 'msg_ntfy_1'`).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if jobStatus != string(JobPending) {
		t.Fatalf("initial job status = %q", jobStatus)
	}

	current = now.Add(DeliveryDelay + time.Millisecond)
	result, err := service.ProcessJobs(ctx)
	if err != nil || result.Sent != 1 || len(published) != 1 {
		t.Fatalf("process result=%#v published=%#v err=%v", result, published, err)
	}
	if published[0].Message != "author 通过私聊给你发送了消息" || published[0].ClickURL != "https://duallane.example.test/workspace/chat/conv_ntfy" {
		t.Fatalf("published projection = %#v", published[0])
	}
	if published[0].Message == "private body" {
		t.Fatal("message body entered notification")
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM workspace_ntfy_jobs WHERE message_id = 'msg_ntfy_1'`).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if jobStatus != string(JobSent) {
		t.Fatalf("sent job status = %q", jobStatus)
	}

	if _, err := conn.Exec(ctx, `INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, client_message_id, content_format, content_json, plain_text, created_at)
		VALUES ('msg_ntfy_2', 'spc_default', 'conv_ntfy', 'usr_author', 'human', 'user', 'ntfy-2', 'duallane.message+json;v=1', '{"blocks":[]}', 'second', $1)`, now); err != nil {
		t.Fatal(err)
	}
	if err := service.ScheduleMessage(ctx, ScheduleInput{AuthorID: "usr_author", ConversationID: "conv_ntfy", MessageID: "msg_ntfy_2", EventSeq: 12, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	var secondJobID string
	if err := pool.QueryRow(ctx, `SELECT id FROM workspace_ntfy_jobs WHERE message_id = 'msg_ntfy_2'`).Scan(&secondJobID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workspace_ntfy_jobs SET status = 'cancelled' WHERE id = $1`, secondJobID); err != nil {
		t.Fatal(err)
	}
	if job, err := repository.GetDeliveryJob(ctx, secondJobID); err != nil || job != nil {
		t.Fatalf("cancelled delivery job = %#v, err=%v", job, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workspace_ntfy_jobs SET status = 'pending' WHERE id = $1`, secondJobID); err != nil {
		t.Fatal(err)
	}
	removedAt := now.Add(time.Second)
	if _, err := conn.Exec(ctx, `UPDATE conversation_members SET removed_at = $1 WHERE conversation_id = 'conv_ntfy' AND user_id = 'usr_recipient'`, removedAt); err != nil {
		t.Fatal(err)
	}
	current = now.Add(DeliveryDelay + 2*time.Second)
	result, err = service.ProcessJobs(ctx)
	if err != nil || result.Cancelled != 1 || len(published) != 1 {
		t.Fatalf("removed member result=%#v published=%d err=%v", result, len(published), err)
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM workspace_ntfy_jobs WHERE message_id = 'msg_ntfy_2'`).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if jobStatus != string(JobCancelled) {
		t.Fatalf("removed member job status = %q", jobStatus)
	}
}

func seedNtfyData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct{ id, login string }{
		{"usr_author", "author"}, {"usr_recipient", "recipient"},
	} {
		if _, err := conn.Exec(ctx, `INSERT INTO users (id, github_login, email, display_name, kind, created_at, last_login_at)
			VALUES ($1, $2, $3, $2, 'human', $4, $4)`, user.id, user.login, user.id+"@example.test", now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ('spc_default', 'Default', 'ntfy', 'usr_author', $1)`, now); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"usr_author", "usr_recipient"} {
		if _, err := conn.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ('spc_default', $1, 'member', $2)`, userID, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ('conv_ntfy', 'spc_default', 'direct', 'Direct', 'author-recipient', 'usr_author', $1)`, now); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"usr_author", "usr_recipient"} {
		if _, err := conn.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('conv_ntfy', $1, $2)`, userID, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, client_message_id, content_format, content_json, plain_text, created_at)
		VALUES ('msg_ntfy_1', 'spc_default', 'conv_ntfy', 'usr_author', 'human', 'user', 'ntfy-1', 'duallane.message+json;v=1', '{"blocks":[]}', 'private body', $1)`, now); err != nil {
		t.Fatal(err)
	}
}
