package runtime

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
)

// CardRepository composes the registered Feishu and Echo actions on one card
// transaction. Domain views retain their configured factories and never begin
// another transaction. Ordinary card reads still belong to cards.PGRepository.
type CardRepository struct {
	cards.ReadRepository
	pool          *pgxpool.Pool
	base          *cards.PGRepository
	feishu        *feishucards.PGRepository
	requirements  *requirements.PGRepository
	solicitations *solicitations.PGRepository
}

func NewCardRepository(pool *pgxpool.Pool, cardRepository *cards.PGRepository, requirementRepository *requirements.PGRepository, solicitationRepository *solicitations.PGRepository) *CardRepository {
	return &CardRepository{
		ReadRepository: cardRepository, pool: pool, base: cardRepository,
		feishu:       feishucards.NewPGRepository(pool, cardRepository),
		requirements: requirementRepository, solicitations: solicitationRepository,
	}
}

func (r *CardRepository) WithTx(ctx context.Context, callback func(cards.Tx) error) error {
	if r == nil || r.pool == nil || r.base == nil || r.requirements == nil || r.solicitations == nil || callback == nil {
		return errors.New("echo card transaction dependencies are required")
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanupCtx)
	}()
	base, ok := r.feishu.NewTransaction(tx).(feishuCardTransaction)
	if !ok {
		return errors.New("feishu card transaction bridge is unavailable")
	}
	view := &cardTransaction{
		feishuCardTransaction: base,
		requirementTx:         r.requirements.NewTransaction(tx),
		solicitationTx:        r.solicitations.NewTransaction(tx),
	}
	if view.requirementTx == nil || view.solicitationTx == nil {
		return errors.New("echo card domain transaction bridge is unavailable")
	}
	if err := callback(view); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type feishuCardTransaction interface {
	cards.Tx
	cards.ActionSavepoint
	feishucards.Tx
}

type cardTransaction struct {
	feishuCardTransaction
	requirementTx  requirements.Tx
	solicitationTx solicitations.Tx
}

func (tx *cardTransaction) RequirementTransaction() requirements.Tx   { return tx.requirementTx }
func (tx *cardTransaction) SolicitationTransaction() solicitations.Tx { return tx.solicitationTx }

var _ cards.Repository = (*CardRepository)(nil)
