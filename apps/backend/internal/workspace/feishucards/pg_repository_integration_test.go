//go:build postgres_integration

package feishucards

import (
	"context"
	"errors"
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
	workspaceauth "github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

type pgFeishuIntegrationFixture struct {
	ctx            context.Context
	pool           *pgxpool.Pool
	repo           *PGRepository
	service        *workspacecards.Service
	spaceID        string
	conversationID string
	now            time.Time
}

func newPGFeishuIntegrationFixture(t *testing.T) *pgFeishuIntegrationFixture {
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

	schema := fmt.Sprintf("duallane_feishu_cards_%d", time.Now().UnixNano())
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

	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	seedPGFeishuIntegrationData(t, ctx, conn, now)

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

	var sequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("feishu-pg-id-%03d", sequence.Add(1)), nil
	}
	cardRepo := workspacecards.NewPGRepository(pool, idFactory)
	repo := NewPGRepository(pool, cardRepo)
	registry, err := workspacecards.NewRegistry(AsCardsDefinition())
	if err != nil {
		t.Fatal(err)
	}
	return &pgFeishuIntegrationFixture{
		ctx: ctx, pool: pool, repo: repo,
		service: workspacecards.NewService(workspacecards.ServiceOptions{
			Repository: repo,
			Registry:   registry,
			SpaceID:    "space-feishu-pg",
			Now:        func() time.Time { return now },
			IDFactory:  idFactory,
		}),
		spaceID: "space-feishu-pg", conversationID: "conversation-feishu-pg", now: now,
	}
}

func seedPGFeishuIntegrationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	users := []struct {
		id, login, kind string
	}{
		{"feishu-owner", "feishu-owner", "human"},
		{"feishu-actor", "feishu-actor", "human"},
		{"feishu-bot-user", "feishu-bot-user", "bot"},
		{"feishu-paused-owner", "feishu-paused-owner", "human"},
		{"feishu-paused-bot", "feishu-paused-bot", "bot"},
		{"feishu-cross-owner", "feishu-cross-owner", "human"},
		{"feishu-cross-bot", "feishu-cross-bot", "bot"},
	}
	for _, user := range users {
		mustExecPGFeishu(t, ctx, conn, `
			INSERT INTO users (id, github_login, display_name, kind, created_at)
			VALUES ($1, $2, $2, $3, $4)
		`, user.id, user.login, user.kind, now)
	}
	mustExecPGFeishu(t, ctx, conn, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ('space-feishu-pg', 'Feishu cards integration', 'feishu-cards-integration', 'feishu-owner', $1),
		       ('space-feishu-other', 'Feishu other space', 'feishu-other-space', 'feishu-cross-owner', $1)
	`, now)
	for _, member := range []struct{ id, role string }{
		{"feishu-owner", "owner"}, {"feishu-actor", "member"},
		{"feishu-bot-user", "member"}, {"feishu-paused-owner", "member"},
		{"feishu-paused-bot", "member"}, {"feishu-cross-owner", "member"},
		{"feishu-cross-bot", "member"},
	} {
		mustExecPGFeishu(t, ctx, conn, `
			INSERT INTO space_members (space_id, user_id, role, joined_at)
			VALUES ('space-feishu-pg', $1, $2, $3)
		`, member.id, member.role, now)
	}
	mustExecPGFeishu(t, ctx, conn, `
		INSERT INTO conversations (id, space_id, type, title, retention_count, created_by, created_at)
		VALUES ('conversation-feishu-pg', 'space-feishu-pg', 'group', 'Feishu cards integration', 10000, 'feishu-owner', $1)
	`, now)
	for _, userID := range []string{"feishu-owner", "feishu-actor", "feishu-bot-user", "feishu-paused-bot", "feishu-cross-bot"} {
		mustExecPGFeishu(t, ctx, conn, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ('conversation-feishu-pg', $1, $2)
		`, userID, now)
	}
	for _, bot := range []struct {
		id, spaceID, ownerID, userID, name, status string
	}{
		{"bot-feishu-main", "space-feishu-pg", "feishu-owner", "feishu-bot-user", "Feishu main", "active"},
		{"bot-feishu-paused", "space-feishu-pg", "feishu-paused-owner", "feishu-paused-bot", "Feishu paused", "paused"},
		{"bot-feishu-cross-space", "space-feishu-other", "feishu-cross-owner", "feishu-cross-bot", "Feishu other space", "active"},
	} {
		mustExecPGFeishu(t, ctx, conn, `
			INSERT INTO workspace_agent_bots
			(id, space_id, owner_user_id, bot_user_id, name, name_normalized, status, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
		`, bot.id, bot.spaceID, bot.ownerID, bot.userID, bot.name, bot.name, bot.status, now)
	}
}

func mustExecPGFeishu(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func (f *pgFeishuIntegrationFixture) insertCard(t *testing.T, id, creator, sourceKind, sourceID string, payload []byte) {
	t.Helper()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO workspace_cards (
			id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text,
			source_kind, source_id, visibility_scope, created_by_user_id, status, revision, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', 1, $12, $12)
	`, id, f.spaceID, f.conversationID, CardType, SchemaVersion, string(payload), DefaultFallback, sourceKind, sourceID, workspacecards.VisibilityConversation, creator, f.now)
	if err != nil {
		t.Fatal(err)
	}
}

func (f *pgFeishuIntegrationFixture) count(t *testing.T, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := f.pool.QueryRow(f.ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func cardErrorCode(err error) string {
	var domain *workspacecards.Error
	if errors.As(err, &domain) && domain != nil {
		return domain.Code
	}
	var validation *workspacecards.CardValidationError
	if errors.As(err, &validation) && validation != nil {
		return validation.Code
	}
	return ""
}

func TestPGFeishuActionUsesNodeBotJoinAndPreservesCanonicalEvent(t *testing.T) {
	f := newPGFeishuIntegrationFixture(t)
	converted, err := ConvertJSON([]byte(`{"elements":[{"tag":"action","actions":[{"tag":"button","text":"确认","value":{"action_id":"confirm","data":{"z":"first","0":"zero","z":"last","a":"first","surrogate":"\ud800"}}}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	cardID := "card-feishu-success"
	f.insertCard(t, cardID, "feishu-bot-user", "custom_bot", "source-feishu-success", converted.PayloadJSON)
	input := workspacecards.ActionInput{
		ActorID: "feishu-actor", CardID: cardID, ActionID: "confirm", ClientActionID: "client-feishu-success", ExpectedRevision: 1,
		Input: map[string]any{}, Meta: workspaceauth.RequestMeta{RequestID: "feishu-action-success"},
	}
	outcome, err := f.service.ExecuteAction(f.ctx, input)
	if err != nil || !outcome.OK || outcome.Replayed {
		t.Fatalf("first action = %#v, err=%v", outcome, err)
	}
	var eventID, payload string
	if err := f.pool.QueryRow(f.ctx, `
		SELECT id, payload_json FROM workspace_events
		WHERE type = 'card.action' AND target_id = $1
	`, cardID).Scan(&eventID, &payload); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(eventID, "feishu-pg-id-") {
		t.Fatalf("event id factory was not retained: %q", eventID)
	}
	wantPayload := `{"botId":"bot-feishu-main","botUserId":"feishu-bot-user","cardId":"card-feishu-success","actionId":"confirm","clientActionId":"client-feishu-success","data":{"0":"zero","z":"last","a":"first","surrogate":"\ud800"}}`
	if payload != wantPayload {
		t.Fatalf("stored action payload = %s, want %s", payload, wantPayload)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM workspace_events WHERE type = 'card.action' AND target_id = $1`, cardID); got != 1 {
		t.Fatalf("action event count = %d, want 1", got)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM workspace_card_action_runs WHERE card_id = $1 AND status = 'succeeded'`, cardID); got != 1 {
		t.Fatalf("succeeded action run count = %d, want 1", got)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM audit_logs WHERE action = 'card.action.confirm' AND target_id = $1 AND result = 'success'`, cardID); got != 1 {
		t.Fatalf("success audit count = %d, want 1", got)
	}

	replayed, err := f.service.ExecuteAction(f.ctx, input)
	if err != nil || !replayed.OK || !replayed.Replayed {
		t.Fatalf("replayed action = %#v, err=%v", replayed, err)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM workspace_events WHERE type = 'card.action' AND target_id = $1`, cardID); got != 1 {
		t.Fatalf("replayed action event count = %d, want 1", got)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM workspace_card_action_runs WHERE card_id = $1`, cardID); got != 1 {
		t.Fatalf("replayed action run count = %d, want 1", got)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM audit_logs WHERE action = 'card.action.confirm' AND target_id = $1`, cardID); got != 1 {
		t.Fatalf("replayed audit count = %d, want 1", got)
	}
}

func TestPGFeishuActionRejectsNodeBotJoinMismatchesWithAudit(t *testing.T) {
	f := newPGFeishuIntegrationFixture(t)
	converted, err := ConvertJSON([]byte(`{"elements":[{"tag":"action","actions":[{"tag":"button","text":"确认","value":{"action_id":"confirm","data":{"choice":"yes"}}}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, cardID, creator, sourceKind string
	}{
		{name: "source", cardID: "card-feishu-source-mismatch", creator: "feishu-bot-user", sourceKind: "workspace"},
		{name: "creator", cardID: "card-feishu-creator-mismatch", creator: "feishu-owner", sourceKind: "custom_bot"},
		{name: "inactive", cardID: "card-feishu-inactive-mismatch", creator: "feishu-paused-bot", sourceKind: "custom_bot"},
		{name: "space", cardID: "card-feishu-space-mismatch", creator: "feishu-cross-bot", sourceKind: "custom_bot"},
	}
	for index, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			f.insertCard(t, testCase.cardID, testCase.creator, testCase.sourceKind, fmt.Sprintf("source-feishu-reject-%d", index), converted.PayloadJSON)
			_, err := f.service.ExecuteAction(f.ctx, workspacecards.ActionInput{
				ActorID: "feishu-actor", CardID: testCase.cardID, ActionID: "confirm", ClientActionID: "client-feishu-reject-" + testCase.name, ExpectedRevision: 1,
				Input: map[string]any{}, Meta: workspaceauth.RequestMeta{RequestID: "feishu-action-reject-" + testCase.name},
			})
			if got := cardErrorCode(err); got != workspacecards.CodeCardUnknownAction {
				t.Fatalf("error code = %q, err=%v", got, err)
			}
			if got := f.count(t, `SELECT COUNT(*) FROM workspace_events WHERE type = 'card.action' AND target_id = $1`, testCase.cardID); got != 0 {
				t.Fatalf("rejected action event count = %d, want 0", got)
			}
			var status, errorCode string
			if err := f.pool.QueryRow(f.ctx, `
				SELECT status, error_code FROM workspace_card_action_runs
				WHERE card_id = $1 AND client_action_id = $2
			`, testCase.cardID, "client-feishu-reject-"+testCase.name).Scan(&status, &errorCode); err != nil {
				t.Fatal(err)
			}
			if status != "failed" || errorCode != workspacecards.CodeCardUnknownAction {
				t.Fatalf("failed action = (%s, %s)", status, errorCode)
			}
			if got := f.count(t, `SELECT COUNT(*) FROM audit_logs WHERE action = 'card.action.confirm' AND target_id = $1 AND result = 'rejected' AND reason = $2`, testCase.cardID, workspacecards.CodeCardUnknownAction); got != 1 {
				t.Fatalf("rejection audit count = %d, want 1", got)
			}
		})
	}
}

func TestPGFeishuFindActiveBotLocksIdentityUntilCommit(t *testing.T) {
	f := newPGFeishuIntegrationFixture(t)
	f.insertCard(t, "card-feishu-lock", "feishu-bot-user", "custom_bot", "source-feishu-lock", []byte(`{}`))

	firstTx, err := f.pool.BeginTx(f.ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	firstCommitted := false
	defer func() {
		if !firstCommitted {
			_ = firstTx.Rollback(context.Background())
		}
	}()
	firstCardsTx := f.repo.NewTransaction(firstTx)
	bridge, ok := firstCardsTx.(Tx)
	if !ok {
		t.Fatal("NewTransaction did not retain Feishu bridge")
	}
	binding, found, err := bridge.FindActiveBotForCard(f.ctx, "card-feishu-lock", f.spaceID)
	if err != nil || !found || binding.ID != "bot-feishu-main" {
		t.Fatalf("active bot lookup = %#v, found=%v, err=%v", binding, found, err)
	}

	secondTx, err := f.pool.BeginTx(f.ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	secondCommitted := false
	defer func() {
		if !secondCommitted {
			_ = secondTx.Rollback(context.Background())
		}
	}()
	updateCtx, cancel := context.WithTimeout(f.ctx, 2*time.Second)
	defer cancel()
	updateDone := make(chan error, 1)
	go func() {
		_, updateErr := secondTx.Exec(updateCtx, `UPDATE workspace_agent_bots SET status = 'paused' WHERE id = 'bot-feishu-main'`)
		updateDone <- updateErr
	}()
	select {
	case updateErr := <-updateDone:
		t.Fatalf("bot status update was not held by active identity lock: %v", updateErr)
	case <-time.After(150 * time.Millisecond):
	}

	if err := firstTx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	firstCommitted = true
	select {
	case updateErr := <-updateDone:
		if updateErr != nil {
			t.Fatal(updateErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bot status update remained blocked after action transaction commit")
	}
	if err := secondTx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	secondCommitted = true
}

func TestPGFeishuBridgeKeepsCardsSavepointAndOuterRollback(t *testing.T) {
	f := newPGFeishuIntegrationFixture(t)
	writeEvent := func(ctx context.Context, tx Tx, targetID string) error {
		return tx.WriteCardActionEvent(ctx, CardActionEvent{
			SpaceID: f.spaceID, Type: "card.action", ActorID: "feishu-actor", ConversationID: f.conversationID,
			TargetType: "workspace.card", TargetID: targetID, PayloadJSON: []byte(`{"ordered":{"z":1,"a":2}}`),
		})
	}
	savepointFault := errors.New("synthetic savepoint rejection")
	err := f.repo.WithTx(f.ctx, func(baseTx workspacecards.Tx) error {
		bridge, ok := baseTx.(Tx)
		if !ok {
			return errors.New("cards transaction did not retain Feishu bridge")
		}
		savepoint, ok := baseTx.(workspacecards.ActionSavepoint)
		if !ok {
			return errors.New("cards transaction did not retain action savepoint")
		}
		got := savepoint.WithActionSavepoint(f.ctx, "feishu_bridge_test", func(actionCtx context.Context) error {
			if err := writeEvent(actionCtx, bridge, "card-feishu-savepoint"); err != nil {
				return err
			}
			return savepointFault
		})
		if !errors.Is(got, savepointFault) {
			return fmt.Errorf("savepoint error = %v", got)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM workspace_events WHERE target_id = 'card-feishu-savepoint'`); got != 0 {
		t.Fatalf("savepoint rollback event count = %d, want 0", got)
	}

	outerFault := errors.New("synthetic outer failure")
	err = f.repo.WithTx(f.ctx, func(baseTx workspacecards.Tx) error {
		bridge, ok := baseTx.(Tx)
		if !ok {
			return errors.New("cards transaction did not retain Feishu bridge")
		}
		if err := writeEvent(f.ctx, bridge, "card-feishu-outer"); err != nil {
			return err
		}
		return outerFault
	})
	if !errors.Is(err, outerFault) {
		t.Fatalf("outer error = %v", err)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM workspace_events WHERE target_id = 'card-feishu-outer'`); got != 0 {
		t.Fatalf("outer rollback event count = %d, want 0", got)
	}
}
