//go:build postgres_integration

package email

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGEmailPreferencesChallengesJobsAndCurrentEligibility(t *testing.T) {
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
	schema := fmt.Sprintf("duallane_email_%d", time.Now().UnixNano())
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
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: migrationDirectory}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 4, 12, 0, 0, 789654321, time.UTC)
	seedEmailData(t, ctx, conn, now)
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
	var idCounter atomic.Int64
	repository := NewPGRepository(pool, func() (string, error) {
		return fmt.Sprintf("email-integration-%d", idCounter.Add(1)), nil
	})
	callerTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	boundTx := repository.BindTx(callerTx)
	if boundTx == nil {
		_ = callerTx.Rollback(ctx)
		t.Fatal("repository did not bind caller transaction")
	}
	boundActor, err := boundTx.LookupActor(ctx, "spc_default", "usr_owner")
	if err != nil || boundActor == nil || boundActor.ID != "usr_owner" {
		_ = callerTx.Rollback(ctx)
		t.Fatalf("bound transaction actor=%#v err=%v", boundActor, err)
	}
	if err := callerTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	current := now
	var deliveries []Message
	service := NewService(ServiceOptions{
		Repository:    repository,
		EncryptionKey: []byte(strings.Repeat("k", 32)),
		Now:           func() time.Time { return current },
		CodeFactory:   func() (string, error) { return "123456", nil },
		FrontendURL:   "https://duallane.example.test",
		Mailer: MailerFunc(func(_ context.Context, _ MailConfig, message Message, _ string) error {
			deliveries = append(deliveries, message)
			return nil
		}),
	})
	preferences, err := service.GetPreferences(ctx, "usr_owner")
	if err != nil || preferences.Email == nil || *preferences.Email != "owner@example.test" || !preferences.EmailVerified {
		t.Fatalf("initial preferences=%#v err=%v", preferences, err)
	}
	tested, err := service.TestSpaceSettings(ctx, TestSettingsInput{ActorID: "usr_owner", SMTPHost: "smtp.example.test", SMTPPort: 587, Encryption: "starttls", Username: "sender@example.test", Password: "pg-secret", FromAddress: "sender@example.test", FromName: "DualLane", Meta: auth.RequestMeta{RequestID: "email-pg-test", IPAddress: "198.51.100.9", UserAgent: "pg"}})
	if err != nil || !tested.OK {
		t.Fatalf("test settings=%#v err=%v", tested, err)
	}
	if _, err := service.SaveSpaceSettings(ctx, SaveSettingsInput{ActorID: "usr_owner", Enabled: true, SMTPHost: "smtp.example.test", SMTPPort: 587, Encryption: "starttls", Username: "sender@example.test", Password: "pg-secret", FromAddress: "sender@example.test", FromName: "DualLane", TestProof: tested.TestProof, Meta: auth.RequestMeta{RequestID: "email-pg-save"}}); err != nil {
		t.Fatal(err)
	}
	challenge, err := service.CreateEmailChallenge(ctx, CreateChallengeInput{ActorID: "usr_owner", Email: "custom@example.test", Meta: auth.RequestMeta{RequestID: "email-pg-challenge"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.VerifyEmailChallenge(ctx, VerifyChallengeInput{ActorID: "usr_owner", ChallengeID: challenge.ChallengeID, Code: "000000", Meta: auth.RequestMeta{RequestID: "email-pg-rejected"}}); !hasCode(err, CodeVerificationInvalid) {
		t.Fatalf("wrong verification code error=%v", err)
	}
	var attempts, rejectionAudits int
	if err := pool.QueryRow(ctx, `SELECT attempts FROM notification_email_challenges WHERE id = $1`, challenge.ChallengeID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE request_id = 'email-pg-rejected' AND result = 'rejected' AND reason = 'email.verification_invalid'`).Scan(&rejectionAudits); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || rejectionAudits != 1 {
		t.Fatalf("wrong verification code evidence attempts=%d audits=%d", attempts, rejectionAudits)
	}
	verified, err := service.VerifyEmailChallenge(ctx, VerifyChallengeInput{ActorID: "usr_owner", ChallengeID: challenge.ChallengeID, Code: "123456", Meta: auth.RequestMeta{RequestID: "email-pg-verify"}})
	if err != nil || verified.Email == nil || *verified.Email != "custom@example.test" {
		t.Fatalf("verified=%#v err=%v", verified, err)
	}
	var ciphertext *string
	if err := conn.QueryRow(ctx, `SELECT password_ciphertext FROM space_email_settings WHERE space_id = 'spc_default'`).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if ciphertext == nil || !strings.HasPrefix(*ciphertext, "v1.") || strings.Contains(*ciphertext, "pg-secret") {
		t.Fatalf("password ciphertext=%v", ciphertext)
	}
	var auditCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE request_id IN ('email-pg-test', 'email-pg-save', 'email-pg-challenge', 'email-pg-verify')`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount < 4 {
		t.Fatalf("audit count=%d", auditCount)
	}
	if _, err := service.GetPreferences(ctx, "usr_recipient"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdatePreferences(ctx, UpdatePreferencesInput{ActorID: "usr_recipient", Immediate: boolPtr(true), Digest: boolPtr(false)}); err != nil {
		t.Fatal(err)
	}
	queued, err := service.ScheduleMessage(ctx, ScheduleInput{AuthorID: "usr_owner", ConversationID: "conv_email", MessageID: "msg_email_1", EventSeq: 7, ContentJSON: []byte(`{"blocks":[{"type":"text","text":"private body"}]}`), CreatedAt: now})
	if err != nil || queued != 1 {
		t.Fatalf("queued=%d err=%v", queued, err)
	}
	current = now.Add(ImmediateDelay + time.Millisecond)
	result, err := service.ProcessJobs(ctx)
	if err != nil || result.Sent != 1 || len(deliveries) < 3 {
		t.Fatalf("process=%#v deliveries=%d err=%v", result, len(deliveries), err)
	}
	if strings.Contains(deliveries[len(deliveries)-1].Text, "private body") {
		t.Fatal("message content entered email")
	}
	if _, err := conn.Exec(ctx, `INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, client_message_id, content_format, content_json, plain_text, created_at) VALUES ('msg_email_2', 'spc_default', 'conv_email', 'usr_owner', 'human', 'user', 'email-2', 'duallane.message+json;v=1', '{"blocks":[]}', 'private body 2', $1)`, now); err != nil {
		t.Fatal(err)
	}
	queued, err = service.ScheduleMessage(ctx, ScheduleInput{AuthorID: "usr_owner", ConversationID: "conv_email", MessageID: "msg_email_2", EventSeq: 8, CreatedAt: now})
	if err != nil || queued != 1 {
		t.Fatalf("second queued=%d err=%v", queued, err)
	}
	if _, err := conn.Exec(ctx, `UPDATE conversation_members SET removed_at = $1 WHERE conversation_id = 'conv_email' AND user_id = 'usr_recipient'`, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	current = now.Add(ImmediateDelay + 2*time.Second)
	result, err = service.ProcessJobs(ctx)
	if err != nil || result.Cancelled != 1 {
		t.Fatalf("removed member process=%#v err=%v", result, err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM workspace_email_jobs WHERE message_id = 'msg_email_2'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != string(JobCancelled) {
		t.Fatalf("removed member status=%q", status)
	}
}

func seedEmailData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct{ id, login, email string }{{"usr_owner", "owner", "owner@example.test"}, {"usr_recipient", "recipient", "recipient@example.test"}} {
		if _, err := conn.Exec(ctx, `INSERT INTO users (id, github_login, email, display_name, kind, created_at, last_login_at) VALUES ($1, $2, $3, $2, 'human', $4, $4)`, user.id, user.login, user.email, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ('spc_default', 'Default', 'email', 'usr_owner', $1)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ('spc_default', 'usr_owner', 'owner', $1), ('spc_default', 'usr_recipient', 'member', $1)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at) VALUES ('conv_email', 'spc_default', 'direct', 'Email', 'owner-recipient', 'usr_owner', $1)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('conv_email', 'usr_owner', $1), ('conv_email', 'usr_recipient', $1)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, client_message_id, content_format, content_json, plain_text, created_at) VALUES ('msg_email_1', 'spc_default', 'conv_email', 'usr_owner', 'human', 'user', 'email-1', 'duallane.message+json;v=1', '{"blocks":[]}', 'private body', $1)`, now); err != nil {
		t.Fatal(err)
	}
}

func boolPtr(value bool) *bool { return &value }
