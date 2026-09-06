//go:build postgres_integration

package runtime

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
)

// Reuses only the synthetic schema provisioned by the writer integration test.
func checkCardTransactionComposition(t *testing.T, parent context.Context, pool *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	configuration := pool.Config()
	configuration.MaxConns = 1
	boundedPool, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer boundedPool.Close()
	repository := NewCardRepository(boundedPool, cards.NewPGRepository(boundedPool),
		requirements.NewPGRepository(boundedPool, func() (string, error) { return "shared-requirement-audit", nil }),
		solicitations.NewPGRepository(boundedPool, func() (string, error) { return "shared-solicitation-audit", nil }),
	)
	writeDomains := func(tx cards.Tx) error {
		if _, ok := tx.(feishucards.Tx); !ok {
			t.Fatal("Feishu transaction extension was lost")
		}
		view, ok := tx.(*cardTransaction)
		if !ok {
			t.Fatal("Echo transaction extensions were lost")
		}
		if err := view.RequirementTransaction().WriteAudit(ctx, requirements.AuditInput{
			SpaceID: "spc_default", ActorUserID: "writer-user", Action: "fixture.shared.requirement", TargetType: "echo.requirement", Result: "success", CreatedAt: time.Now(),
		}); err != nil {
			return err
		}
		return view.SolicitationTransaction().WriteAudit(ctx, solicitations.AuditInput{
			SpaceID: "spc_default", ActorUserID: "writer-user", Action: "fixture.shared.solicitation", TargetType: "echo.solicitation", Result: "success", CreatedAt: time.Now(),
		})
	}
	count := func(want int) {
		var actual int
		if err := boundedPool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE id IN ('shared-requirement-audit','shared-solicitation-audit')`).Scan(&actual); err != nil {
			t.Fatal(err)
		}
		if actual != want {
			t.Fatalf("shared transaction audits=%d, want=%d", actual, want)
		}
	}
	lateFailure := errors.New("synthetic late infrastructure failure")
	err = repository.WithTx(ctx, func(tx cards.Tx) error {
		if err := writeDomains(tx); err != nil {
			return err
		}
		return lateFailure
	})
	if !errors.Is(err, lateFailure) {
		t.Fatalf("outer rollback error=%v", err)
	}
	count(0)
	err = repository.WithTx(ctx, func(tx cards.Tx) error {
		err := tx.(cards.ActionSavepoint).WithActionSavepoint(ctx, "shared_action", func(context.Context) error {
			if err := writeDomains(tx); err != nil {
				return err
			}
			return lateFailure
		})
		if !errors.Is(err, lateFailure) {
			return errors.New("card savepoint did not preserve the callback error")
		}
		// The same configured IDs can now be written again only if both domain
		// views were rolled back by the card-owned savepoint.
		return writeDomains(tx)
	})
	if err != nil {
		t.Fatal(err)
	}
	count(2)
}
