//go:build postgres_integration

package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/presence"
)

func TestWorkerCompositionUsesSharedPresenceAndBoundsExpiry(t *testing.T) {
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
	schema := fmt.Sprintf("duallane_worker_composition_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelCleanup()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../web/server/migrations"))
	if _, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(conn), Directory: migrationDir}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO users (id,github_login,display_name,kind,created_at,last_login_at) VALUES ('worker-owner','owner','Owner','human',NOW(),NOW()),('worker-recipient','recipient','Recipient','human',NOW(),NOW())`,
		`INSERT INTO spaces (id,name,slug,created_by,created_at) VALUES ('spc_default','Fixture','fixture','worker-owner',NOW())`,
		`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_default','worker-owner','owner',NOW()),('spc_default','worker-recipient','member',NOW())`,
		`INSERT INTO conversations (id,space_id,type,title,direct_key,created_by,created_at) VALUES ('worker-conversation','spc_default','direct','Fixture','owner-recipient','worker-owner',NOW())`,
		`INSERT INTO conversation_members (conversation_id,user_id,joined_at) VALUES ('worker-conversation','worker-owner',NOW()),('worker-conversation','worker-recipient',NOW())`,
		`INSERT INTO messages (id,space_id,conversation_id,author_id,author_kind,kind,client_message_id,content_format,content_json,plain_text,created_at) VALUES ('worker-message','spc_default','worker-conversation','worker-owner','human','user','worker-client-message','duallane.message+json;v=1','{"blocks":[]}','synthetic',NOW())`,
		`INSERT INTO user_notification_preferences (user_id,email,email_verified_at,enabled,immediate_enabled,digest_enabled,updated_at) VALUES ('worker-recipient','synthetic@example.test',NOW(),1,1,0,NOW())`,
		`INSERT INTO workspace_email_jobs (id,user_id,message_id,conversation_id,event_seq,status,available_at,next_attempt_at,created_at) VALUES ('worker-job','worker-recipient','worker-message','worker-conversation',1,'pending',NOW()-INTERVAL '1 minute',NOW()-INTERVAL '1 minute',NOW())`,
	} {
		if _, err := conn.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	isolatedDSN, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := isolatedDSN.Query()
	query.Set("search_path", schema)
	isolatedDSN.RawQuery = query.Encode()
	t.Setenv("DATABASE_URL", isolatedDSN.String())
	app, err := newApplication(ctx, config.WorkspaceConfig{
		Enabled: true, EmailWorkerEnabled: true, MaintenanceEnabled: true, MigrationsDir: migrationDir,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer app.pool.Close()
	processors := make(map[string]workerProcessor)
	for _, processor := range app.processors {
		processors[processor.name] = processor
	}
	if len(processors) != 2 || processors["email"].process == nil || processors["presence_expiry"].process == nil {
		t.Fatal("email and presence maintenance processors were not composed")
	}
	// A second service models the Workspace process. No process-local Hub is
	// shared with the actual worker constructed above.
	otherProcess := presence.NewService(presence.ServiceOptions{Repository: presence.NewPGRepository(app.pool)})
	lease, err := otherProcess.Register(ctx, presence.RegisterInput{UserID: "worker-recipient", ActorKind: "human"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := processors["email"].process(ctx)
	if err != nil || result != (processResult{Claimed: 1}) {
		t.Fatalf("online recipient worker result=%+v error=%v", result, err)
	}
	assertDeferred := func() {
		t.Helper()
		var pending bool
		var attempt int
		if err := conn.QueryRow(ctx, `SELECT status='pending' AND lease_until IS NULL AND next_attempt_at>NOW() AND last_error_code IS NULL,attempt_count FROM workspace_email_jobs WHERE id='worker-job'`).Scan(&pending, &attempt); err != nil || !pending || attempt != 0 {
			t.Fatalf("presence deferral pending=%v attempts=%d error=%v", pending, attempt, err)
		}
	}
	assertDeferred()
	if _, err := conn.Exec(ctx, `UPDATE workspace_email_jobs SET next_attempt_at=NOW()-INTERVAL '1 minute' WHERE id='worker-job'`); err != nil {
		t.Fatal(err)
	}
	// Simulate only the presence lookup failing, while job persistence remains
	// writable. The worker must not turn that failure into an offline send.
	if _, err := conn.Exec(ctx, `ALTER TABLE workspace_presence_leases RENAME TO workspace_presence_temporarily_unavailable`); err != nil {
		t.Fatal(err)
	}
	result, processErr := processors["email"].process(ctx)
	if _, err := conn.Exec(ctx, `ALTER TABLE workspace_presence_temporarily_unavailable RENAME TO workspace_presence_leases`); err != nil {
		t.Fatal(err)
	}
	if processErr != nil || result != (processResult{Claimed: 1, Retried: 1}) {
		t.Fatalf("unavailable presence result=%+v error=%v", result, processErr)
	}
	assertDeferred()
	if _, err := conn.Exec(ctx, `INSERT INTO workspace_presence_leases (space_id,user_id,connection_id,lease_until) SELECT 'spc_default','worker-recipient','expired-'||n,NOW()-INTERVAL '1 minute' FROM generate_series(1,105) n`); err != nil {
		t.Fatal(err)
	}
	if _, err := processors["presence_expiry"].process(ctx); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := conn.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_presence_leases WHERE connection_id LIKE 'expired-%'`).Scan(&remaining); err != nil || remaining != 5 {
		t.Fatalf("bounded sweep remaining=%d error=%v", remaining, err)
	}
	if online, err := otherProcess.IsOnlineContext(ctx, "worker-recipient"); err != nil || !online {
		t.Fatalf("sweep removed active presence online=%v error=%v", online, err)
	}
	if err := otherProcess.Delete(ctx, presence.DeleteInput{Lease: lease}); err != nil {
		t.Fatal(err)
	}
	if online, err := otherProcess.IsOnlineContext(ctx, "worker-recipient"); err != nil || online {
		t.Fatalf("expired rows counted as online=%v error=%v", online, err)
	}
}
