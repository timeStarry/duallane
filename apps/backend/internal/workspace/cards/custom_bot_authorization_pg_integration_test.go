//go:build postgres_integration

package cards

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Runs the revocation after the service's preliminary reads but before its
// accepting transaction, reproducing a credential/identity TOCTOU boundary.
type revokeBeforeCardTx struct {
	*PGRepository
	revoke func() error
}

func (r *revokeBeforeCardTx) WithTx(ctx context.Context, callback func(Tx) error) error {
	if err := r.revoke(); err != nil {
		return err
	}
	return r.PGRepository.WithTx(ctx, callback)
}

func TestPGCustomBotMutationsReauthorizeInsideTransaction(t *testing.T) {
	for _, operation := range []string{"update", "invalidate"} {
		for _, revocation := range []struct{ name, sql string }{
			{"membership", `UPDATE space_members SET removed_at=NOW() WHERE user_id='usr_card_bot'`},
			{"identity", `UPDATE users SET kind='human' WHERE id='usr_card_bot'`},
			{"bot", `UPDATE workspace_agent_bots SET status='paused' WHERE id='bot-cards'`},
		} {
			t.Run(operation+"/"+revocation.name, func(t *testing.T) {
				f := newPGCardIntegrationFixture(t)
				card, err := f.service.CreateCustomBotCard(f.ctx, CustomBotCreateInput{
					BotID: "bot-cards", BotUserID: "usr_card_bot",
					CreateInput: CreateInput{SpaceID: DefaultSpaceID, ConversationID: "conv-cards", CardType: "test.counter", SchemaVersion: 1, FallbackText: "Synthetic", Payload: map[string]any{"count": 0}, SourceID: "recheck-source", VisibilityScope: VisibilityConversation},
				})
				if err != nil {
					t.Fatal(err)
				}
				repo := &revokeBeforeCardTx{PGRepository: NewPGRepository(f.pool), revoke: func() error {
					_, err := f.pool.Exec(f.ctx, revocation.sql)
					if err != nil {
						t.Fatalf("could not establish synthetic revocation: %v", err)
					}
					return err
				}}
				service := NewService(ServiceOptions{Repository: repo, Registry: f.service.Registry()})
				if operation == "update" {
					_, err = service.UpdateCustomBotCard(f.ctx, CustomBotUpdateInput{SpaceID: DefaultSpaceID, CardID: card.ID, BotID: "bot-cards", BotUserID: "usr_card_bot", ExpectedRevision: 1, Payload: map[string]any{"count": 1}})
				} else {
					_, err = service.InvalidateCustomBotCard(f.ctx, CustomBotInvalidateInput{SpaceID: DefaultSpaceID, CardID: card.ID, BotID: "bot-cards", BotUserID: "usr_card_bot", ExpectedRevision: 1})
				}
				if err == nil {
					t.Fatal("revoked Bot authorization committed a card mutation")
				}
				if got := pgCardCount(t, f, `SELECT COUNT(*) FROM workspace_cards WHERE id=$1 AND revision=1 AND status='active'`, card.ID); got != 1 {
					t.Fatal("rejected mutation changed the card")
				}
				if got := pgCardCount(t, f, `SELECT COUNT(*) FROM workspace_events WHERE target_id=$1 AND type IN ('card.updated','card.invalidated')`, card.ID); got != 0 {
					t.Fatal("rejected mutation committed an event")
				}
			})
		}
	}
}

func TestPGCardAuthorizationIsPinnedUntilCommit(t *testing.T) {
	f := newPGCardIntegrationFixture(t)
	repo := NewPGRepository(f.pool)
	if err := repo.WithTx(f.ctx, func(tx Tx) error {
		if _, err := tx.LookupActor(f.ctx, DefaultSpaceID, "usr_card_bot"); err != nil {
			return err
		}
		if active, err := tx.ConversationMemberActive(f.ctx, DefaultSpaceID, "conv-cards", "usr_card_bot"); err != nil || !active {
			t.Fatalf("initial membership active=%v err=%v", active, err)
		}
		if active, err := tx.(CustomBotAuthorizer).CustomBotActive(f.ctx, DefaultSpaceID, "bot-cards", "usr_card_bot"); err != nil || !active {
			t.Fatalf("initial bot active=%v err=%v", active, err)
		}
		for _, query := range []string{
			`UPDATE users SET kind='human' WHERE id='usr_card_bot'`,
			`UPDATE space_members SET removed_at=NOW() WHERE user_id='usr_card_bot'`,
			`UPDATE conversation_members SET removed_at=NOW() WHERE conversation_id='conv-cards' AND user_id='usr_card_bot'`,
			`UPDATE workspace_agent_bots SET status='paused' WHERE id='bot-cards'`,
		} {
			other, err := f.pool.BeginTx(f.ctx, pgx.TxOptions{})
			if err != nil {
				return err
			}
			if _, err := other.Exec(f.ctx, `SET LOCAL lock_timeout='100ms'`); err != nil {
				_ = other.Rollback(f.ctx)
				return err
			}
			_, updateErr := other.Exec(f.ctx, query)
			_ = other.Rollback(f.ctx)
			var pgError *pgconn.PgError
			if !errors.As(updateErr, &pgError) || pgError.Code != "55P03" {
				t.Fatalf("authorization changed before accepting commit: err=%v query=%s", updateErr, query)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
