//go:build postgres_integration

package files

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func seedFileAgentBot(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, query := range []string{
		`INSERT INTO users (id,github_login,display_name,kind,created_at) VALUES ('file-bot','file-bot','File bot','bot',NOW())`,
		`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_default','file-bot','member',NOW())`,
		`INSERT INTO workspace_agent_bots (id,space_id,owner_user_id,bot_user_id,name,name_normalized,created_at,updated_at) VALUES ('file-agent','spc_default','usr_file_owner','file-bot','File bot','file bot',NOW(),NOW())`,
	} {
		if _, err := pool.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPGFileAgentBotReservationIsNarrowAndQuotaSerialized(t *testing.T) {
	ctx, pool, service, _ := newStorageLockFixture(t)
	seedFileAgentBot(t, ctx, pool)
	service.dailyQuotaBytes = 8
	input := ReserveUploadInput{ActorID: "file-bot", FileName: "bot.txt", ByteSize: 6}
	if _, err := service.ReserveUpload(ctx, input); errorCode(err) != CodeIdentityForbidden {
		t.Fatalf("human reservation accepted bot: %v", err)
	}
	human := input
	human.ActorID = "usr_file_owner"
	if _, err := service.ReserveAgentBotUpload(ctx, human); errorCode(err) != CodeIdentityForbidden {
		t.Fatalf("bot boundary accepted human: %v", err)
	}
	results := make(chan UploadResult, 2)
	errors := make(chan error, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Go(func() {
			result, err := service.ReserveAgentBotUpload(ctx, input)
			results <- result
			errors <- err
		})
	}
	workers.Wait()
	close(results)
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	var accepted, rejected int
	var uploadID string
	for result := range results {
		switch result.Status {
		case string(TransferReserved):
			accepted++
			uploadID = result.ID
		case string(TransferRejected):
			rejected++
		default:
			t.Fatalf("unexpected reservation status: %q", result.Status)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("quota race: accepted=%d rejected=%d", accepted, rejected)
	}
	var attachments, successAudits, rejectedAudits int
	if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM attachments WHERE uploader_id='file-bot'),(SELECT COUNT(*) FROM audit_logs WHERE actor_user_id='file-bot' AND action='file.upload.reserve' AND result='success'),(SELECT COUNT(*) FROM audit_logs WHERE actor_user_id='file-bot' AND action='file.upload.rejected' AND result='rejected')`).Scan(&attachments, &successAudits, &rejectedAudits); err != nil || attachments != 1 || successAudits != 1 || rejectedAudits != 1 {
		t.Fatalf("bot quota evidence=%d/%d/%d err=%v", attachments, successAudits, rejectedAudits, err)
	}
	if _, err := service.CompleteUpload(ctx, CompleteUploadInput{ActorID: input.ActorID, UploadID: uploadID, Content: strings.NewReader("secret")}); errorCode(err) != CodeIdentityForbidden {
		t.Fatalf("reservation granted human content completion: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bots SET status='paused' WHERE id='file-agent'`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReserveAgentBotUpload(ctx, input); errorCode(err) != CodeIdentityForbidden {
		t.Fatalf("paused bot accepted: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bots SET status='active' WHERE id='file-agent'; UPDATE space_members SET removed_at=NOW() WHERE user_id='file-bot'`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReserveAgentBotUpload(ctx, input); errorCode(err) != CodeIdentityForbidden {
		t.Fatalf("removed bot member accepted: %v", err)
	}
}

type revokingFileBotRepository struct {
	*PGRepository
	beforeTx func()
}

func (r revokingFileBotRepository) LookupActiveAgentBot(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	actor, err := r.PGRepository.LookupActiveAgentBot(ctx, spaceID, userID)
	r.beforeTx()
	return actor, err
}

func TestPGFileAgentBotRevalidatesCurrentStatusInsideReservation(t *testing.T) {
	ctx, pool, service, _ := newStorageLockFixture(t)
	seedFileAgentBot(t, ctx, pool)
	service.repo = revokingFileBotRepository{PGRepository: NewPGRepository(pool), beforeTx: func() {
		if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bots SET status='paused' WHERE id='file-agent'`); err != nil {
			t.Fatal(err)
		}
	}}
	if _, err := service.ReserveAgentBotUpload(ctx, ReserveUploadInput{ActorID: "file-bot", FileName: "bot.txt", ByteSize: 6}); errorCode(err) != CodeIdentityForbidden {
		t.Fatalf("stale preflight identity accepted: %v", err)
	}
	var reservations int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM transfer_ledger WHERE user_id='file-bot'`).Scan(&reservations); err != nil || reservations != 0 {
		t.Fatalf("revoked reservation persisted: count=%d err=%v", reservations, err)
	}
}

func TestPGFileAgentBotAuditFailureRollsBackReservation(t *testing.T) {
	ctx, pool, service, _ := newStorageLockFixture(t)
	seedFileAgentBot(t, ctx, pool)
	if _, err := pool.Exec(ctx, `ALTER TABLE audit_logs ADD CONSTRAINT fixture_refuse_bot_audit CHECK (actor_user_id <> 'file-bot')`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReserveAgentBotUpload(ctx, ReserveUploadInput{ActorID: "file-bot", FileName: "bot.txt", ByteSize: 6}); errorCode(err) != CodeInternal {
		t.Fatalf("audit failure was accepted: %v", err)
	}
	var writes int
	if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM attachments WHERE uploader_id='file-bot')+(SELECT COUNT(*) FROM transfer_ledger WHERE user_id='file-bot')+(SELECT COUNT(*) FROM workspace_events WHERE actor_user_id='file-bot')`).Scan(&writes); err != nil || writes != 0 {
		t.Fatalf("rejected audit left reservation writes: count=%d err=%v", writes, err)
	}
}

func TestPGUnauthenticatedReservationCannotTriggerStaleCleanup(t *testing.T) {
	ctx, pool, service, _ := newStorageLockFixture(t)
	reservation, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_file_owner", FileName: "pending.txt", ByteSize: 1})
	if err != nil {
		t.Fatal(err)
	}
	later := service.nowUTC().Add(service.staleUploadAge + time.Hour)
	service.now = func() time.Time { return later }
	if _, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "not-a-member", FileName: "bad.txt", ByteSize: 1}); errorCode(err) != CodeAuthRequired {
		t.Fatalf("unauthenticated reservation result: %v", err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM transfer_ledger WHERE id=$1`, reservation.ID).Scan(&status); err != nil || status != string(TransferReserved) {
		t.Fatalf("unauthenticated request mutated another user's reservation: status=%q err=%v", status, err)
	}
}
