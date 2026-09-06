//go:build postgres_integration

package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

// This scheduler writes a synthetic durable marker through the supplied pgx
// transaction. It cannot contact email/ntfy or a real recipient.
type transactionJobProbe struct{ fail bool }

func (s transactionJobProbe) ScheduleMessageInTx(ctx context.Context, tx pgx.Tx, input messagejobs.Input) error {
	if input.AuthorID != delivery.EchoUserID || input.EventSeq < 1 {
		return errors.New("invalid Echo message job input")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO echo_writer_test_jobs (message_id) VALUES ($1)`, input.MessageID); err != nil {
		return err
	}
	if s.fail {
		return errors.New("synthetic scheduler failure after its write")
	}
	return nil
}

func TestPGWriterKeepsCardMessageJobsAndEvidenceAtomic(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	schema := fmt.Sprintf("duallane_echo_writer_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, file, _, _ := goruntime.Caller(0)
	if _, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(conn), Directory: filepath.Join(filepath.Dir(file), "../../../../../web/server/migrations")}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO users (id,github_login,display_name,kind,created_at) VALUES ('writer-user','writer-user','Fixture','human',NOW()),('usr_system_echo','__duallane_echo__','Echo','bot',NOW())`,
		`INSERT INTO spaces (id,name,slug,created_by,created_at) VALUES ('spc_default','Fixture','fixture','writer-user',NOW())`,
		`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_default','writer-user','owner',NOW()),('spc_default','usr_system_echo','member',NOW())`,
		`INSERT INTO conversations (id,space_id,type,title,retention_count,created_by,created_at) VALUES ('writer-direct','spc_default','direct','Echo',10000,'writer-user',NOW())`,
		`INSERT INTO conversation_members (conversation_id,user_id,joined_at) VALUES ('writer-direct','writer-user',NOW()),('writer-direct','usr_system_echo',NOW())`,
		`CREATE TABLE echo_writer_test_jobs (message_id TEXT PRIMARY KEY REFERENCES messages(id))`,
	} {
		if _, err := conn.Exec(ctx, query); err != nil {
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
	registry, err := cards.NewRegistry(cards.CardDefinition{CardType: delivery.CardTypeRequest, SchemaVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	cardRepository := cards.NewPGRepository(pool)
	cardService := cards.NewService(cards.ServiceOptions{Repository: cardRepository, Registry: registry})
	write := func(input delivery.CardMessageWriteInput, fail bool) (delivery.CardMessageWriteResult, error) {
		messageRepository := messages.NewPGRepositoryWithMessageJobs(pool, transactionJobProbe{fail: fail})
		repo := delivery.NewPGRepository(pool, delivery.DomainTransactionOptions{Message: messageRepository.NewTransaction, Card: cardRepository.NewTransaction})
		writer := NewWriter(delivery.DefaultSpaceID, messageRepository, cardService)
		var result delivery.CardMessageWriteResult
		err := repo.WithTx(ctx, func(tx delivery.Tx) error {
			var err error
			result, err = writer.WriteEchoCardAndMessageInTx(ctx, tx, input)
			return err
		})
		return result, err
	}
	input := delivery.CardMessageWriteInput{
		SpaceID: delivery.DefaultSpaceID, ConversationID: "writer-direct", RecipientUserID: "writer-user",
		CardID: "card_echo_writer", CardType: delivery.CardTypeRequest, SchemaVersion: 1,
		FallbackText: "Synthetic private requirement", SourceID: "echo-writer-source", ResourceType: "echo.requirement",
		ResourceID: "REQ-2026-0001", DomainRevision: 1, ClientMessageID: "echo-writer-client", InternalOnly: true,
		Payload: map[string]any{"revision": 1, "title": "Synthetic fixture"},
	}
	if _, err := write(input, true); err == nil {
		t.Fatal("failed scheduler accepted an Echo delivery")
	}
	count := func(query string, want int) {
		t.Helper()
		var got int
		if err := pool.QueryRow(ctx, query).Scan(&got); err != nil || got != want {
			t.Fatalf("count=%d want=%d err=%v query=%s", got, want, err, query)
		}
	}
	for _, query := range []string{"SELECT COUNT(*) FROM workspace_cards", "SELECT COUNT(*) FROM messages", "SELECT COUNT(*) FROM workspace_events", "SELECT COUNT(*) FROM audit_logs", "SELECT COUNT(*) FROM echo_writer_test_jobs"} {
		count(query, 0)
	}
	var wg sync.WaitGroup
	results := make(chan delivery.CardMessageWriteResult, 8)
	errorsCh := make(chan error, 8)
	for range 8 {
		wg.Go(func() {
			result, err := write(input, false)
			if err != nil {
				errorsCh <- err
				return
			}
			results <- result
		})
	}
	wg.Wait()
	close(errorsCh)
	close(results)
	for err := range errorsCh {
		t.Error(err)
	}
	messageID, firstWrites := "", 0
	for result := range results {
		if result.MessageID == "" || (messageID != "" && result.MessageID != messageID) {
			t.Fatalf("duplicate or missing message ID: %+v", result)
		}
		messageID = result.MessageID
		if !result.Replayed {
			firstWrites++
		}
	}
	if firstWrites != 1 {
		t.Fatalf("first writes=%d", firstWrites)
	}
	count("SELECT COUNT(*) FROM workspace_cards", 1)
	count("SELECT COUNT(*) FROM messages", 1)
	count("SELECT COUNT(*) FROM echo_writer_test_jobs", 1)
	count("SELECT COUNT(*) FROM workspace_events WHERE type='message.created'", 1)
	count("SELECT COUNT(*) FROM audit_logs WHERE action='message.create'", 1)
	input.DomainRevision = 8
	input.Payload = map[string]any{"revision": 8, "title": "Updated synthetic fixture"}
	result, err := write(input, false)
	if err != nil || result.CardRevision != 8 || result.MessageID != messageID || !result.Replayed {
		t.Fatalf("card refresh=%+v err=%v", result, err)
	}
	count("SELECT COUNT(*) FROM messages", 1)
	count("SELECT COUNT(*) FROM echo_writer_test_jobs", 1)
	input.InternalOnly = false
	if _, err := write(input, false); err == nil {
		t.Fatal("untrusted writer intent accepted")
	}
	t.Run("shared card domain transactions", func(t *testing.T) {
		checkCardTransactionComposition(t, ctx, pool)
	})
}
