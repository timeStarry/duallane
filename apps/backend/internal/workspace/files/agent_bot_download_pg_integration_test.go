//go:build postgres_integration

package files

import (
	"io"
	"strings"
	"testing"
)

func TestPGFileAgentBotContentReadQuotaAndRevocation(t *testing.T) {
	ctx, pool, service, _ := newStorageLockFixture(t)
	seedFileAgentBot(t, ctx, pool)
	service.dailyQuotaBytes = 18
	reserved, err := service.ReserveAgentBotUpload(ctx, ReserveUploadInput{ActorID: "file-bot", FileName: "input.txt", MIMEType: "text/plain", ByteSize: 6})
	if err != nil {
		t.Fatal(err)
	}
	status, err := service.GetAgentBotUploadStatus(ctx, UploadStatusInput{ActorID: "file-bot", UploadID: reserved.ID})
	if err != nil || status.Status != string(TransferReserved) {
		t.Fatalf("reserved status: %+v %v", status, err)
	}
	completed, err := service.CompleteAgentBotUpload(ctx, CompleteUploadInput{ActorID: "file-bot", UploadID: reserved.ID, Content: strings.NewReader("secret")})
	if err != nil {
		t.Fatal(err)
	}
	status, err = service.GetAgentBotUploadStatus(ctx, UploadStatusInput{ActorID: "file-bot", UploadID: reserved.ID})
	if err != nil || status.Status != string(TransferCompleted) || status.Attachment == nil || status.Attachment.ID != completed.Attachment.ID {
		t.Fatalf("lost completion recovery: %+v %v", status, err)
	}
	input := OpenAttachmentInput{ActorID: "file-bot", AttachmentID: completed.Attachment.ID, MaxBytes: 6}
	if _, err := service.OpenAttachmentContent(ctx, input); errorCode(err) != CodeIdentityForbidden {
		t.Fatalf("human path accepted Bot: %v", err)
	}
	opened, err := service.OpenAgentBotAttachmentContent(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if err != nil || string(body) != "secret" {
		t.Fatalf("content: %q %v", body, err)
	}
	var used int64
	var audits int
	if err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(byte_size),0) FROM transfer_ledger WHERE user_id='file-bot' AND status IN ('reserved','completed')`).Scan(&used); err != nil || used != 12 {
		t.Fatalf("usage=%d err=%v", used, err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE actor_user_id='file-bot' AND action='file.download.completed'`).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("audit=%d err=%v", audits, err)
	}
	service.dailyQuotaBytes = 12
	if _, err := service.OpenAgentBotAttachmentContent(ctx, input); errorCode(err) != CodeQuotaInsufficient {
		t.Fatalf("quota bypass: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bots SET status='paused' WHERE id='file-agent'`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.OpenAgentBotAttachmentContent(ctx, input); errorCode(err) != CodeIdentityForbidden {
		t.Fatalf("paused Bot read: %v", err)
	}
}

func TestPGFileAgentBotContentReadRejectsOtherPrivateStaging(t *testing.T) {
	ctx, pool, service, _ := newStorageLockFixture(t)
	seedFileAgentBot(t, ctx, pool)
	reserved, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_file_owner", FileName: "private.txt", MIMEType: "text/plain", ByteSize: 6})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := service.CompleteUpload(ctx, CompleteUploadInput{ActorID: "usr_file_owner", UploadID: reserved.ID, Content: strings.NewReader("secret")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.OpenAgentBotAttachmentContent(ctx, OpenAttachmentInput{ActorID: "file-bot", AttachmentID: completed.Attachment.ID, MaxBytes: 6}); err == nil {
		t.Fatal("another actor's private staging was readable")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM transfer_ledger WHERE user_id='file-bot' AND direction='download'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("denied read charged download: %d %v", count, err)
	}
}
