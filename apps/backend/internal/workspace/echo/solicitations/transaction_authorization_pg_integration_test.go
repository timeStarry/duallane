//go:build postgres_integration

package solicitations

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
)

func TestPGSolicitationInTxSeesUncommittedConversationRevocation(t *testing.T) {
	fixture := newPGSolicitationIntegrationFixture(t)
	created, err := fixture.service.Create(fixture.ctx, pgSolicitationCreateInput("tx-auth-create"))
	if err != nil {
		t.Fatal(err)
	}
	open, err := fixture.service.Publish(fixture.ctx, TransitionInput{ActorID: "usr_sol_pg_owner", PublicID: created.PublicID, IdempotencyKey: "tx-auth-publish"})
	if err != nil {
		t.Fatal(err)
	}
	transaction, err := fixture.pool.Begin(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer transaction.Rollback(fixture.ctx)
	if _, err := transaction.Exec(fixture.ctx, `UPDATE conversation_members SET removed_at = $1 WHERE conversation_id = $2 AND user_id = $3`, *fixture.now, fixture.conversationID, "usr_sol_pg_member"); err != nil {
		t.Fatal(err)
	}
	typed := NewPGTransaction(transaction)
	if _, err := fixture.service.ProjectCardInTx(fixture.ctx, typed, GetInput{
		ActorID: "usr_sol_pg_member", PublicID: open.PublicID, ConversationID: fixture.conversationID,
	}); pgSolicitationCode(err) != CodeSolicitationNotFound {
		t.Errorf("project after transaction-local revocation = %v, want hidden not found", err)
	}
	if _, err := fixture.service.VoteInTx(fixture.ctx, typed, VoteInput{
		ActorID: "usr_sol_pg_member", PublicID: open.PublicID, ConversationID: fixture.conversationID,
		OptionIDs: []string{open.Options[0].ID}, IdempotencyKey: "tx-auth-vote",
	}); pgSolicitationCode(err) != CodeSolicitationNotFound {
		t.Errorf("vote after transaction-local revocation = %v, want hidden not found", err)
	}
	var votes int
	if err := transaction.QueryRow(fixture.ctx, `SELECT count(*) FROM echo_solicitation_votes`).Scan(&votes); err != nil || votes != 0 {
		t.Fatalf("transaction-local votes = %d, error = %v", votes, err)
	}
}

func TestPGEchoTransactionsPinActorAuthorizationUntilCompletion(t *testing.T) {
	fixture := newPGSolicitationIntegrationFixture(t)
	type actorReader interface {
		LookupActor(context.Context, string, string) (*auth.Actor, error)
	}
	for name, wrap := range map[string]func(pgx.Tx) actorReader{
		"solicitations": func(tx pgx.Tx) actorReader { return NewPGTransaction(tx) },
		"requirements":  func(tx pgx.Tx) actorReader { return requirements.NewPGTransaction(tx) },
		"releases":      func(tx pgx.Tx) actorReader { return releases.NewPGTransaction(tx) },
	} {
		t.Run(name, func(t *testing.T) {
			holder, err := fixture.pool.Begin(fixture.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(fixture.ctx)
			actor, err := wrap(holder).LookupActor(fixture.ctx, fixture.spaceID, "usr_sol_pg_member")
			if err != nil || actor == nil {
				t.Fatalf("actor lookup: %v, %v", actor, err)
			}
			for _, query := range []string{
				`SELECT user_id FROM space_members WHERE space_id = $1 AND user_id = $2 FOR UPDATE NOWAIT`,
				`SELECT id FROM users WHERE $1::text <> '' AND id = $2 FOR UPDATE NOWAIT`,
			} {
				contender, err := fixture.pool.Begin(fixture.ctx)
				if err != nil {
					t.Fatal(err)
				}
				var id string
				err = contender.QueryRow(fixture.ctx, query, fixture.spaceID, actor.ID).Scan(&id)
				_ = contender.Rollback(fixture.ctx)
				var pgError *pgconn.PgError
				if !errors.As(err, &pgError) || pgError.Code != "55P03" {
					t.Fatalf("actor authorization was not protected from concurrent update: %v", err)
				}
			}
		})
	}
}
