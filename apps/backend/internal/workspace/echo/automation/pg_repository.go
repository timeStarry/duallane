package automation

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

// The transaction repository interfaces keep repository configuration (most
// importantly deterministic ID factories in tests) in the composition layer
// without exposing a generic SQL handle to Echo services.
type RequirementsTransactionRepository interface {
	NewTransaction(pgx.Tx) requirements.Tx
}

type SolicitationsTransactionRepository interface {
	NewTransaction(pgx.Tx) solicitations.Tx
}

type ReleasesTransactionRepository interface {
	NewTransaction(pgx.Tx) releases.Tx
}

// PGRepository is the interaction repository used by the Echo composition.
// Its WithTx callback receives one PGTransaction that exposes every typed
// domain view over the same underlying PostgreSQL transaction.
type PGRepository struct {
	*interactions.PGRepository

	pool          *pgxpool.Pool
	requirements  RequirementsTransactionRepository
	solicitations SolicitationsTransactionRepository
	releases      ReleasesTransactionRepository
}

type PGRepositoryOptions struct {
	InteractionRepository   *interactions.PGRepository
	RequirementsRepository  RequirementsTransactionRepository
	SolicitationsRepository SolicitationsTransactionRepository
	ReleasesRepository      ReleasesTransactionRepository
}

func NewPGRepository(pool *pgxpool.Pool, options ...PGRepositoryOptions) *PGRepository {
	var configured PGRepositoryOptions
	if len(options) > 0 {
		configured = options[0]
	}
	interactionRepository := configured.InteractionRepository
	if interactionRepository == nil {
		interactionRepository = interactions.NewPGRepository(pool)
	}
	requirementRepository := configured.RequirementsRepository
	if requirementRepository == nil {
		requirementRepository = requirements.NewPGRepository(pool)
	}
	solicitationRepository := configured.SolicitationsRepository
	if solicitationRepository == nil {
		solicitationRepository = solicitations.NewPGRepository(pool)
	}
	releaseRepository := configured.ReleasesRepository
	if releaseRepository == nil {
		releaseRepository = releases.NewPGRepository(pool)
	}
	return &PGRepository{
		PGRepository:  interactionRepository,
		pool:          pool,
		requirements:  requirementRepository,
		solicitations: solicitationRepository,
		releases:      releaseRepository,
	}
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(interactions.Tx) error) error {
	if r == nil || r.pool == nil {
		return errors.New("echo automation postgres pool is required")
	}
	if callback == nil {
		return errors.New("echo automation transaction callback is required")
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
	transaction, err := r.NewTransaction(tx)
	if err != nil {
		return err
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

// NewTransaction wraps an already-open transaction and preserves the
// configured repository factories. It never begins, commits, or rolls back a
// pool transaction.
func (r *PGRepository) NewTransaction(tx pgx.Tx) (*PGTransaction, error) {
	if r == nil {
		return nil, errors.New("echo automation postgres repository is required")
	}
	if tx == nil {
		return nil, errors.New("echo automation postgres transaction is required")
	}
	if r.PGRepository == nil {
		return nil, errors.New("echo automation interaction repository is required")
	}
	return NewPGTransaction(tx, PGTransactionOptions{
		InteractionRepository: r.PGRepository,
		Requirements:          r.requirements,
		Solicitations:         r.solicitations,
		Releases:              r.releases,
	})
}

// PGTransaction is the only shared transaction object consumed by Echo
// command/workflow handlers. The embedded interaction view keeps the object
// acceptable to interactions.Service; the other views are deliberately typed
// and do not expose pgx.Tx.
type PGTransaction struct {
	interactions.Tx
	raw           pgx.Tx
	requirements  requirements.Tx
	solicitations solicitations.Tx
	releases      releases.Tx
}

type PGTransactionOptions struct {
	InteractionRepository *interactions.PGRepository
	Requirements          RequirementsTransactionRepository
	Solicitations         SolicitationsTransactionRepository
	Releases              ReleasesTransactionRepository
}

// NewPGTransaction creates a shared view over a caller-owned transaction. The
// interaction repository creates its view from that same transaction. Domain
// repository factories do likewise, so every typed view is tied to one
// caller-owned pgx.Tx while preserving each repository's configured ID
// behavior.
func NewPGTransaction(tx pgx.Tx, options PGTransactionOptions) (*PGTransaction, error) {
	if tx == nil {
		return nil, errors.New("echo automation postgres transaction is required")
	}
	if options.InteractionRepository == nil {
		return nil, errors.New("echo automation interaction repository is required")
	}
	interactionTx := options.InteractionRepository.NewTransaction(tx)
	if interactionTx == nil {
		return nil, errors.New("echo automation interaction transaction is unavailable")
	}
	requirementTx := requirements.NewPGTransaction(tx)
	if options.Requirements != nil {
		requirementTx = options.Requirements.NewTransaction(tx)
	}
	solicitationTx := solicitations.NewPGTransaction(tx)
	if options.Solicitations != nil {
		solicitationTx = options.Solicitations.NewTransaction(tx)
	}
	releaseTx := releases.NewPGTransaction(tx)
	if options.Releases != nil {
		releaseTx = options.Releases.NewTransaction(tx)
	}
	if requirementTx == nil || solicitationTx == nil || releaseTx == nil {
		return nil, errors.New("echo automation typed transaction view is unavailable")
	}
	return &PGTransaction{
		Tx:            interactionTx,
		raw:           tx,
		requirements:  requirementTx,
		solicitations: solicitationTx,
		releases:      releaseTx,
	}, nil
}

var savepointNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_:-]{0,62}$`)

func (t *PGTransaction) RequirementTransaction() requirements.Tx {
	if t == nil {
		return nil
	}
	return t.requirements
}

func (t *PGTransaction) SolicitationTransaction() solicitations.Tx {
	if t == nil {
		return nil
	}
	return t.solicitations
}

func (t *PGTransaction) ReleaseTransaction() releases.Tx {
	if t == nil {
		return nil
	}
	return t.releases
}

// WithEchoSavepoint gives one Echo multi-step operation a rollback boundary
// inside the caller-owned transaction. Domain errors are returned unchanged
// after successful cleanup; savepoint infrastructure errors are wrapped so
// the outer interaction transaction can roll back everything.
func (t *PGTransaction) WithEchoSavepoint(ctx context.Context, name string, callback func(context.Context) error) error {
	if t == nil || t.raw == nil {
		return &SavepointFailure{Err: errors.New("echo automation postgres transaction is required")}
	}
	if ctx == nil {
		return &SavepointFailure{Err: errors.New("echo automation savepoint context is required")}
	}
	if callback == nil {
		return &SavepointFailure{Err: errors.New("echo automation savepoint callback is required")}
	}
	if !savepointNamePattern.MatchString(name) {
		return &SavepointFailure{Err: fmt.Errorf("invalid Echo savepoint name")}
	}
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err := t.raw.Exec(ctx, "SAVEPOINT "+quoted); err != nil {
		return &SavepointFailure{Err: fmt.Errorf("create Echo savepoint: %w", err)}
	}
	callbackErr := callback(ctx)
	if callbackErr != nil {
		rollbackErr := execSavepoint(ctx, t.raw, "ROLLBACK TO SAVEPOINT "+quoted)
		releaseErr := execSavepoint(ctx, t.raw, "RELEASE SAVEPOINT "+quoted)
		if rollbackErr != nil || releaseErr != nil {
			return &SavepointFailure{Err: errors.Join(
				callbackErr,
				wrapSavepointCleanupError("rollback Echo savepoint", rollbackErr),
				wrapSavepointCleanupError("release Echo savepoint", releaseErr),
			)}
		}
		return callbackErr
	}
	if _, err := t.raw.Exec(ctx, "RELEASE SAVEPOINT "+quoted); err != nil {
		return &SavepointFailure{Err: fmt.Errorf("release Echo savepoint: %w", err)}
	}
	return nil
}

func execSavepoint(ctx context.Context, tx pgx.Tx, statement string) error {
	if tx == nil {
		return errors.New("echo automation postgres transaction is required")
	}
	_, err := tx.Exec(ctx, statement)
	return err
}

func wrapSavepointCleanupError(operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", operation, err)
}

var _ interactions.Repository = (*PGRepository)(nil)
var _ interactions.Tx = (*PGTransaction)(nil)
var _ SharedTxProvider = (*PGTransaction)(nil)
