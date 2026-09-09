//go:build postgres_integration

package bots

import (
	"errors"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGBotConnectionOwnerAuthorizationAndAudit(t *testing.T) {
	fixture := newPGBotIntegrationFixture(t)
	fixture.service.connectionProvider = NewRepositoryConnectionProvider(fixture.service.Repository())
	bot, err := fixture.service.Create(fixture.ctx, CreateInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, Name: "PG Connection Bot",
		Meta: auth.RequestMeta{RequestID: "pg-connection-create"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// The first owner read must repair the missing durable row, matching
	// Node's ensureBotConfiguration path. The test then mutates that real
	// PostgreSQL row instead of a provider-only in-memory projection.
	if _, err := fixture.service.GetConnectionStatus(fixture.ctx, ConnectionInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID,
	}); err != nil {
		t.Fatal(err)
	}
	adapterVersion := "gateway-pg-v1"
	errorCode := "gateway.timeout"
	connectionID := "bcon-pg-connection"
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE workspace_agent_bot_connections
		SET id = $1, status = $2, adapter_version = $3, last_error_code = $4, last_error_at = $5, updated_at = $6
		WHERE bot_id = $7 AND space_id = $8`, connectionID, ConnectionStatusConnected, adapterVersion,
		errorCode, fixture.now, fixture.now, bot.ID, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}

	connection, err := fixture.service.GetConnectionStatus(fixture.ctx, ConnectionInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID,
		Meta: auth.RequestMeta{RequestID: "pg-connection-read"},
	})
	if err != nil || connection == nil || connection.ID != connectionID || connection.Status != ConnectionStatusConnected {
		t.Fatalf("connection = %#v, err=%v", connection, err)
	}

	tested, err := fixture.service.TestConnection(fixture.ctx, ConnectionTestInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID,
		Meta: auth.RequestMeta{RequestID: "pg-connection-test"},
	})
	if err != nil || tested == nil || tested.TestedAt == "" {
		t.Fatalf("tested = %#v, err=%v", tested, err)
	}
	var storedError *string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT last_error_code FROM workspace_agent_bot_connections WHERE bot_id = $1 AND space_id = $2`, bot.ID, DefaultSpaceID).Scan(&storedError); err != nil {
		t.Fatal(err)
	}
	if storedError != nil {
		t.Fatalf("connection error was not cleared in PostgreSQL: %q", *storedError)
	}
	if pgBotCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'bot.connection.test' AND result = 'success' AND request_id = 'pg-connection-test'`) != 1 {
		t.Fatal("successful connection test audit was not persisted")
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE workspace_agent_bot_connections SET last_error_code = 'gateway.audit_retry', last_error_at = $1 WHERE bot_id = $2 AND space_id = $3`, fixture.now, bot.ID, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}
	repository, ok := fixture.service.Repository().(*PGRepository)
	if !ok {
		t.Fatal("connection fixture does not use the PostgreSQL repository")
	}
	originalIDFactory := repository.idFactory
	repository.idFactory = func() (string, error) { return "", errors.New("synthetic audit id failure") }
	if _, err := fixture.service.TestConnection(fixture.ctx, ConnectionTestInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID,
		Meta: auth.RequestMeta{RequestID: "pg-connection-audit-failure"},
	}); domainCode(err) != CodeInternal {
		repository.idFactory = originalIDFactory
		t.Fatalf("audit failure = %v", err)
	}
	repository.idFactory = originalIDFactory
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT last_error_code FROM workspace_agent_bot_connections WHERE bot_id = $1 AND space_id = $2`, bot.ID, DefaultSpaceID).Scan(&storedError); err != nil {
		t.Fatal(err)
	}
	if storedError == nil || *storedError != "gateway.audit_retry" {
		t.Fatalf("connection projection changed despite audit rollback: %v", storedError)
	}

	if _, err := fixture.service.GetConnectionStatus(fixture.ctx, ConnectionInput{
		ActorID: "usr_bot_member", SpaceID: DefaultSpaceID, BotID: bot.ID,
		Meta: auth.RequestMeta{RequestID: "pg-connection-foreign"},
	}); domainCode(err) != CodePermissionDenied {
		t.Fatalf("foreign owner read error = %v", err)
	}
	if pgBotCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'bot.connection.read' AND result = 'rejected' AND reason = $1 AND request_id = 'pg-connection-foreign'`, CodePermissionDenied) != 1 {
		t.Fatal("foreign connection read audit was not persisted")
	}

	if _, err := fixture.service.Pause(fixture.ctx, TransitionInput{ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE workspace_agent_bot_connections SET status = $1 WHERE bot_id = $2 AND space_id = $3`, ConnectionStatusPaused, bot.ID, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}
	paused, err := fixture.service.GetConnectionStatus(fixture.ctx, ConnectionInput{ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID})
	if err != nil || paused == nil || paused.Status != ConnectionStatusPaused {
		t.Fatalf("paused connection = %#v, err=%v", paused, err)
	}

	if _, err := fixture.service.BeginDelete(fixture.ctx, TransitionInput{ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.FinalizeDelete(fixture.ctx, TransitionInput{ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE workspace_agent_bot_connections SET status = $1 WHERE bot_id = $2 AND space_id = $3`, ConnectionStatusRevoked, bot.ID, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}
	deleted, err := fixture.service.GetConnectionStatus(fixture.ctx, ConnectionInput{ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID})
	if err != nil || deleted == nil || deleted.Status != ConnectionStatusRevoked {
		t.Fatalf("deleted connection = %#v, err=%v", deleted, err)
	}

	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE space_members SET removed_at = $1 WHERE space_id = $2 AND user_id = $3`, fixture.now, DefaultSpaceID, "usr_bot_owner"); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE workspace_agent_bot_connections SET last_error_code = 'gateway.reauth', last_error_at = $1 WHERE bot_id = $2 AND space_id = $3`, fixture.now, bot.ID, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.GetConnectionStatus(fixture.ctx, ConnectionInput{ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID}); domainCode(err) != CodeAuthRequired {
		t.Fatalf("removed owner error = %v", err)
	}
	if _, err := fixture.service.TestConnection(fixture.ctx, ConnectionTestInput{ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID}); domainCode(err) != CodeAuthRequired {
		t.Fatalf("removed owner connection test error = %v", err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT last_error_code FROM workspace_agent_bot_connections WHERE bot_id = $1 AND space_id = $2`, bot.ID, DefaultSpaceID).Scan(&storedError); err != nil {
		t.Fatal(err)
	}
	if storedError == nil || *storedError != "gateway.reauth" {
		t.Fatalf("revoked owner mutated connection row: %v", storedError)
	}
}
