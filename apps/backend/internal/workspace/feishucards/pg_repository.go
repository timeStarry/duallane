package feishucards

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

// PGRepository composes Feishu card actions onto the cards-owned repository.
// The embedded read surface deliberately remains the cards repository's
// surface; Feishu only adds its action-specific transaction seam.
type PGRepository struct {
	workspacecards.ReadRepository

	pool            *pgxpool.Pool
	cardsRepository *workspacecards.PGRepository
}

// NewPGRepository creates the Feishu adapter over the caller's cards
// repository. Passing the configured cards repository is important: its
// transaction wrapper retains the cards ID factory and any other repository
// configuration while this adapter adds no second persistence owner.
//
// The optional form keeps construction convenient for isolated callers. The
// production composition path should pass the same cards repository that is
// used by the other card services.
func NewPGRepository(pool *pgxpool.Pool, repositories ...*workspacecards.PGRepository) *PGRepository {
	var cardsRepository *workspacecards.PGRepository
	if len(repositories) > 0 {
		cardsRepository = repositories[0]
	}
	if cardsRepository == nil {
		cardsRepository = workspacecards.NewPGRepository(pool)
	}
	return &PGRepository{
		ReadRepository:  cardsRepository,
		pool:            pool,
		cardsRepository: cardsRepository,
	}
}

// Ping checks the same pool used by WithTx. It does not open a transaction.
func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace Feishu cards postgres pool is required")
	}
	return r.pool.Ping(ctx)
}

// NewTransaction wraps an already-open transaction with the cards repository
// configuration retained. The returned value is statically a cards.Tx for
// composition, while its dynamic value also implements this package's Tx
// bridge. The caller owns commit and rollback.
func (r *PGRepository) NewTransaction(tx pgx.Tx) workspacecards.Tx {
	if r == nil || r.cardsRepository == nil || tx == nil {
		return nil
	}
	baseTx := r.cardsRepository.NewTransaction(tx)
	if baseTx == nil {
		return nil
	}
	return &pgTx{Tx: baseTx, tx: tx}
}

var (
	_ workspacecards.Repository      = (*PGRepository)(nil)
	_ workspacecards.Tx              = (*pgTx)(nil)
	_ workspacecards.ActionSavepoint = (*pgTx)(nil)
	_ Tx                             = (*pgTx)(nil)
)

// WithTx opens one transaction on this adapter's pool and wraps that exact
// pgx.Tx with cards.PGRepository.NewTransaction. The callback owns neither
// Begin nor Commit; a callback error rolls back the whole transaction.
func (r *PGRepository) WithTx(ctx context.Context, callback func(workspacecards.Tx) error) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace Feishu cards postgres pool is required")
	}
	if r.cardsRepository == nil {
		return errors.New("workspace Feishu cards repository is required")
	}
	if callback == nil {
		return errors.New("workspace Feishu cards transaction callback is required")
	}

	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()

	transaction := r.NewTransaction(tx)
	if transaction == nil {
		return errors.New("workspace Feishu cards transaction is required")
	}
	if err := callback(transaction); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

// pgTx embeds the cards transaction so all normal cards service operations
// stay on the same transaction. The explicit savepoint method is intentional:
// cards.Tx includes ActionSavepoint today, but the Feishu bridge must preserve
// that typed extension rather than rely on interface promotion being copied by
// a future adapter change.
type pgTx struct {
	workspacecards.Tx
	tx pgx.Tx
}

func (t *pgTx) WithActionSavepoint(ctx context.Context, name string, callback func(context.Context) error) error {
	if t == nil || t.Tx == nil {
		return errors.New("workspace Feishu cards action transaction is required")
	}
	savepoint, ok := t.Tx.(workspacecards.ActionSavepoint)
	if !ok || savepoint == nil {
		return errors.New("workspace Feishu cards action savepoint is unavailable")
	}
	return savepoint.WithActionSavepoint(ctx, name, callback)
}

// FindActiveBotForCard intentionally mirrors the Node callback query. The
// bot identity is derived from the stored card creator, not from the request:
// the card must be custom_bot, the creator must be the bot user, and both
// records must belong to the requested space and an active bot row.
func (t *pgTx) FindActiveBotForCard(ctx context.Context, cardID, spaceID string) (BotBinding, bool, error) {
	if t == nil || t.tx == nil {
		return BotBinding{}, false, errors.New("workspace Feishu cards action transaction is required")
	}
	if strings.TrimSpace(cardID) == "" || strings.TrimSpace(spaceID) == "" {
		return BotBinding{}, false, nil
	}
	var binding BotBinding
	err := t.tx.QueryRow(ctx, `
		SELECT b.id, b.bot_user_id
		FROM workspace_cards c
		INNER JOIN workspace_agent_bots b
		  ON b.bot_user_id = c.created_by_user_id
		 AND b.space_id = c.space_id
		 AND b.status = 'active'
		WHERE c.id = $1
		  AND c.space_id = $2
		  AND c.source_kind = 'custom_bot'
		FOR SHARE OF b
	`, cardID, spaceID).Scan(&binding.ID, &binding.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return BotBinding{}, false, nil
	}
	if err != nil {
		return BotBinding{}, false, err
	}
	return binding, true, nil
}

// WriteCardActionEvent delegates to the cards event writer on the same
// transaction. PayloadJSON is passed through unchanged so ordered action
// data and UTF-16 surrogate escapes remain the converter's canonical bytes.
func (t *pgTx) WriteCardActionEvent(ctx context.Context, event CardActionEvent) error {
	if t == nil || t.Tx == nil {
		return errors.New("workspace Feishu cards action transaction is required")
	}
	_, err := t.Tx.WriteEvent(ctx, workspacecards.EventInput{
		SpaceID:        event.SpaceID,
		Type:           event.Type,
		ActorID:        event.ActorID,
		ConversationID: event.ConversationID,
		TargetType:     event.TargetType,
		TargetID:       event.TargetID,
		PayloadJSON:    append([]byte(nil), event.PayloadJSON...),
		CreatedAt:      time.Now().UTC(),
	})
	return err
}
