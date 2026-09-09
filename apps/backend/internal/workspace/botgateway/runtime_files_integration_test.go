//go:build postgres_integration

package botgateway

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	workspaceauth "github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspacefiles "github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

func TestPGRuntimeAdapterUsesAgentBotReservationAndQuota(t *testing.T) {
	ctx, pool, service := newRuntimeFileReservationFixture(t)
	adapters := NewRuntimeAdapters(RuntimeAdapterOptions{Files: service})
	if adapters.AttachmentWriter == nil {
		t.Fatal("runtime adapter did not expose attachment writer")
	}

	request := AttachmentCreateRequest{
		ActorID: "runtime-file-bot", SpaceID: "spc_runtime_files", ConversationID: "conversation-runtime-files",
		FileName: "bot.txt", MIMEType: "text/plain", ByteSize: 6, Visibility: "private_staging",
		Meta: workspaceauth.RequestMeta{RequestID: "runtime-file-reservation"},
	}
	results := make(chan UploadReservation, 2)
	errors := make(chan error, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			result, err := adapters.AttachmentWriter.ReserveAttachment(ctx, request)
			results <- result
			errors <- err
		}()
	}
	workers.Wait()
	close(results)
	close(errors)

	var accepted, rejected int
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	for result := range results {
		switch result.Status {
		case string(workspacefiles.TransferReserved):
			accepted++
		case string(workspacefiles.TransferRejected):
			rejected++
		default:
			t.Fatalf("unexpected adapter reservation status: %q", result.Status)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("adapter quota result: accepted=%d rejected=%d", accepted, rejected)
	}

	var attachments, transfers, successAudits, rejectedAudits int
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM attachments WHERE uploader_id = 'runtime-file-bot'),
		(SELECT COUNT(*) FROM transfer_ledger WHERE user_id = 'runtime-file-bot' AND direction = 'upload'),
		(SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = 'runtime-file-bot' AND action = 'file.upload.reserve' AND result = 'success'),
		(SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = 'runtime-file-bot' AND action = 'file.upload.rejected' AND result = 'rejected')`).Scan(&attachments, &transfers, &successAudits, &rejectedAudits); err != nil {
		t.Fatal(err)
	}
	if attachments != 1 || transfers != 2 || successAudits != 1 || rejectedAudits != 1 {
		t.Fatalf("adapter reservation evidence=%d/%d/%d/%d", attachments, transfers, successAudits, rejectedAudits)
	}

	if _, err := service.ReserveUpload(ctx, workspacefiles.ReserveUploadInput{ActorID: request.ActorID, FileName: "human-path.txt", ByteSize: 1}); err == nil {
		t.Fatal("ordinary human reservation accepted bot actor")
	}
}

func newRuntimeFileReservationFixture(t *testing.T) (context.Context, *pgxpool.Pool, *workspacefiles.Service) {
	t.Helper()
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

	schema := fmt.Sprintf("duallane_botgateway_files_%d", time.Now().UnixNano())
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

	now := time.Date(2026, 9, 6, 13, 0, 0, 0, time.UTC)
	seedRuntimeFileReservationData(t, ctx, conn, now)
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

	service := workspacefiles.NewService(workspacefiles.ServiceOptions{
		Repository:      workspacefiles.NewPGRepository(pool),
		SpaceID:         "spc_runtime_files",
		Now:             func() time.Time { return now },
		DailyQuotaBytes: 8,
	})
	return ctx, pool, service
}

func seedRuntimeFileReservationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, query := range []string{
		`INSERT INTO users (id,github_login,display_name,kind,created_at) VALUES ('runtime-file-owner','runtime-file-owner','Runtime owner','human',$1)`,
		`INSERT INTO users (id,github_login,display_name,kind,created_at) VALUES ('runtime-file-bot','runtime-file-bot','Runtime file bot','bot',$1)`,
		`INSERT INTO spaces (id,name,slug,created_by,created_at) VALUES ('spc_runtime_files','Runtime files','runtime-files','runtime-file-owner',$1)`,
		`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_runtime_files','runtime-file-owner','owner',$1)`,
		`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_runtime_files','runtime-file-bot','member',$1)`,
		`INSERT INTO workspace_agent_bots (id,space_id,owner_user_id,bot_user_id,name,name_normalized,created_at,updated_at) VALUES ('runtime-file-agent','spc_runtime_files','runtime-file-owner','runtime-file-bot','Runtime file bot','runtime file bot',$1,$1)`,
	} {
		if _, err := conn.Exec(ctx, query, now); err != nil {
			t.Fatal(err)
		}
	}
}
