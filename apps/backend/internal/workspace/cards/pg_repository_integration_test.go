//go:build postgres_integration

package cards

import (
	"context"
	"errors"
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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type pgCardIntegrationFixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	service *Service
	now     time.Time
}

func newPGCardIntegrationFixture(t *testing.T) *pgCardIntegrationFixture {
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

	schema := fmt.Sprintf("duallane_cards_%d", time.Now().UnixNano())
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

	now := time.Date(2026, 9, 4, 12, 34, 56, 789654321, time.UTC)
	seedPGCardIntegrationData(t, ctx, conn, now)
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

	registry, err := NewRegistry(pgCardIntegrationDefinition())
	if err != nil {
		t.Fatal(err)
	}
	var sequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("card-integration-%03d", sequence.Add(1)), nil
	}
	return &pgCardIntegrationFixture{
		ctx: ctx, pool: pool, now: now,
		service: NewService(ServiceOptions{Repository: NewPGRepository(pool, idFactory), Registry: registry, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, IDFactory: idFactory}),
	}
}

func seedPGCardIntegrationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct{ id, login, kind string }{
		{"usr_card_owner", "card-owner", "human"},
		{"usr_card_member", "card-member", "human"},
		{"usr_card_bot", "card-bot", "bot"},
	} {
		mustExecPGCard(t, ctx, conn, `INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ($1, $2, $2, $3, $4)`, user.id, user.login, user.kind, now)
	}
	mustExecPGCard(t, ctx, conn, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Cards integration', 'cards-integration', $2, $3)`, DefaultSpaceID, "usr_card_owner", now)
	for _, member := range []struct{ id, role string }{{"usr_card_owner", "owner"}, {"usr_card_member", "member"}, {"usr_card_bot", "member"}} {
		mustExecPGCard(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`, DefaultSpaceID, member.id, member.role, now)
	}
	mustExecPGCard(t, ctx, conn, `INSERT INTO conversations (id, space_id, type, title, retention_count, created_by, created_at) VALUES ('conv-cards', $1, 'group', 'Cards integration', 10000, 'usr_card_owner', $2)`, DefaultSpaceID, now)
	for _, userID := range []string{"usr_card_owner", "usr_card_member", "usr_card_bot"} {
		mustExecPGCard(t, ctx, conn, `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('conv-cards', $1, $2)`, userID, now)
	}
	mustExecPGCard(t, ctx, conn, `INSERT INTO workspace_agent_bots (id, space_id, owner_user_id, bot_user_id, name, name_normalized, created_at, updated_at) VALUES ('bot-cards', $1, 'usr_card_owner', 'usr_card_bot', 'Cards Bot', 'cards bot', $2, $2)`, DefaultSpaceID, now)
}

func mustExecPGCard(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func pgCardCount(t *testing.T, fixture *pgCardIntegrationFixture, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := fixture.pool.QueryRow(fixture.ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func pgCardIntegrationDefinition() CardDefinition {
	return CardDefinition{
		CardType:      "test.counter",
		SchemaVersion: 1,
		ValidatePayload: func(value any) (any, error) {
			object, ok := value.(map[string]any)
			if !ok {
				return nil, &CardValidationError{Code: "card.test_invalid", Message: "counter payload must be an object"}
			}
			count, ok := pgCardNumber(object["count"])
			if !ok || count < 0 {
				return nil, &CardValidationError{Code: "card.test_invalid", Message: "counter payload is invalid"}
			}
			object["count"] = count
			return object, nil
		},
		Actions: map[string]CardAction{
			"increment": {Execute: func(_ context.Context, input CardActionContext) (CardActionResult, error) {
				payload := input.Payload.(map[string]any)
				count, ok := pgCardNumber(payload["count"])
				if !ok {
					return CardActionResult{}, errors.New("counter payload is invalid")
				}
				return CardActionResult{CardPayload: map[string]any{"count": count + 1}, Result: map[string]any{"count": count + 1}}, nil
			}},
		},
	}
}

func pgCardNumber(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int64:
		return number, true
	case float64:
		return int64(number), number == float64(int64(number))
	default:
		return 0, false
	}
}

func TestPGCardLifecycleUsesIsolatedSchemaAndAtomicEvidence(t *testing.T) {
	fixture := newPGCardIntegrationFixture(t)
	first, err := fixture.service.Create(fixture.ctx, CreateInput{ActorID: "usr_card_owner", SpaceID: DefaultSpaceID, ConversationID: "conv-cards", CardType: "test.counter", SchemaVersion: 1, FallbackText: "Counter card", Payload: map[string]any{"count": 0}, SourceKind: SourceWorkspace, SourceID: "source-card-1", VisibilityScope: VisibilityConversation, Meta: auth.RequestMeta{RequestID: "card-create-request", IPAddress: "198.51.100.8", UserAgent: "cards-integration"}})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || first.CreatedAt != "2026-09-04T12:34:56.789Z" || first.Revision != 1 {
		t.Fatalf("created card = %#v", first)
	}
	if got := pgCardCount(t, fixture, `SELECT COUNT(*) FROM workspace_cards`); got != 1 {
		t.Fatalf("card rows = %d", got)
	}
	if got := pgCardCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type = 'card.created' AND target_id = $1`, first.ID); got != 1 {
		t.Fatalf("create events = %d", got)
	}
	if got := pgCardCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'card.create' AND target_id = $1 AND result = 'success'`, first.ID); got != 1 {
		t.Fatalf("create audits = %d", got)
	}

	replay, err := fixture.service.Create(fixture.ctx, CreateInput{ActorID: "usr_card_owner", SpaceID: DefaultSpaceID, ConversationID: "conv-cards", CardType: "test.counter", SchemaVersion: 1, FallbackText: "Counter card", Payload: map[string]any{"count": int64(0)}, SourceKind: SourceWorkspace, SourceID: "source-card-1", VisibilityScope: VisibilityConversation})
	if err != nil || replay.ID != first.ID {
		t.Fatalf("create replay = %#v, err=%v", replay, err)
	}
	_, err = fixture.service.Create(fixture.ctx, CreateInput{ActorID: "usr_card_owner", SpaceID: DefaultSpaceID, ConversationID: "conv-cards", CardType: "test.counter", SchemaVersion: 1, FallbackText: "Counter card", Payload: map[string]any{"count": int64(9)}, SourceKind: SourceWorkspace, SourceID: "source-card-1", VisibilityScope: VisibilityConversation})
	if code := pgCardErrorCode(err); code != CodeCardSourceConflict {
		t.Fatalf("source conflict = %v", err)
	}

	resolved, err := fixture.service.Resolve(fixture.ctx, "usr_card_member", first.ID, Request{})
	if err != nil || resolved.Type != CardBlockType || resolved.Status != StatusActive {
		t.Fatalf("member resolution = %#v, err=%v", resolved, err)
	}
	if _, err := fixture.service.Resolve(fixture.ctx, "usr_card_owner", "missing-card", Request{}); pgCardErrorCode(err) != CodeCardNotFound {
		t.Fatalf("missing resolution = %v", err)
	}

	actionInput := ActionInput{ActorID: "usr_card_member", CardID: first.ID, ActionID: "increment", ClientActionID: "card-action-1", ExpectedRevision: 1, Input: map[string]any{}, Meta: auth.RequestMeta{RequestID: "card-action-request"}}
	acted, err := fixture.service.ExecuteAction(fixture.ctx, actionInput)
	if err != nil || !acted.OK || acted.Revision != 2 {
		t.Fatalf("card action = %#v, err=%v", acted, err)
	}
	actedReplay, err := fixture.service.ExecuteAction(fixture.ctx, actionInput)
	if err != nil || !actedReplay.Replayed || actedReplay.Revision != 2 {
		t.Fatalf("card action replay = %#v, err=%v", actedReplay, err)
	}
	_, err = fixture.service.ExecuteAction(fixture.ctx, ActionInput{ActorID: "usr_card_member", CardID: first.ID, ActionID: "increment", ClientActionID: "card-action-stale", ExpectedRevision: 1})
	if code := pgCardErrorCode(err); code != CodeCardStaleRevision {
		t.Fatalf("stale card action = %v", err)
	}
	if got := pgCardCount(t, fixture, `SELECT COUNT(*) FROM workspace_card_action_runs WHERE card_id = $1`, first.ID); got != 2 {
		t.Fatalf("action runs = %d", got)
	}
	if got := pgCardCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE target_id = $1`, first.ID); got != 3 {
		t.Fatalf("card events = %d", got)
	}
	var eventPayload string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT payload_json FROM workspace_events WHERE type = 'card.action' AND target_id = $1`, first.ID).Scan(&eventPayload); err != nil {
		t.Fatal(err)
	}
	if eventPayload == "" || eventPayload == "{}" {
		t.Fatalf("card action evidence = %s", eventPayload)
	}
	custom, err := fixture.service.CreateCustomBotCard(fixture.ctx, CustomBotCreateInput{CreateInput: CreateInput{SpaceID: DefaultSpaceID, ConversationID: "conv-cards", CardType: "future.card", SchemaVersion: 4, FallbackText: "Future card", Payload: map[string]any{"safe": true}, SourceID: "bot-source-1", VisibilityScope: VisibilityConversation}, BotID: "bot-cards", BotUserID: "usr_card_bot"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.UpdateCustomBotCard(fixture.ctx, CustomBotUpdateInput{SpaceID: DefaultSpaceID, CardID: custom.ID, BotID: "bot-cards", BotUserID: "usr_card_bot", ExpectedRevision: 1, Payload: map[string]any{"safe": false}, Meta: auth.RequestMeta{RequestID: "custom-update"}}); err != nil {
		t.Fatal(err)
	}
	invalidated, err := fixture.service.InvalidateCustomBotCard(fixture.ctx, CustomBotInvalidateInput{SpaceID: DefaultSpaceID, CardID: custom.ID, BotID: "bot-cards", BotUserID: "usr_card_bot", ExpectedRevision: 2, Meta: auth.RequestMeta{RequestID: "custom-invalidate"}})
	if err != nil || invalidated.Status != StatusInvalidated || invalidated.Revision != 3 {
		t.Fatalf("invalidated custom card = %#v, err=%v", invalidated, err)
	}
	if got := pgCardCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action IN ('card.create', 'card.action.increment', 'card.update', 'card.invalidate') AND result = 'success'`); got < 4 {
		t.Fatalf("success audits = %d", got)
	}
	if err := fixture.service.Repository().WithTx(fixture.ctx, func(tx Tx) error {
		return tx.CompleteActionRun(fixture.ctx, "missing-run", "succeeded", []byte(`{}`), nil, fixture.now)
	}); err == nil {
		t.Fatal("missing card action run completed")
	}
	if err := fixture.service.Repository().WithTx(fixture.ctx, func(tx Tx) error {
		return tx.FailActionRun(fixture.ctx, "missing-run", "card.test_failure", fixture.now)
	}); err == nil {
		t.Fatal("missing card action run failed")
	}
}

func pgCardErrorCode(err error) string {
	var value *Error
	if errors.As(err, &value) {
		return value.Code
	}
	return ""
}
