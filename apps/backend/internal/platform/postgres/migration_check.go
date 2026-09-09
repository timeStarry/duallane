package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
)

// NewMigrationReadOnlyQueryer adapts a PostgreSQL pool for SchemaChecker.
// Queryer.Query accepts arbitrary SQL by design, so this adapter is not a
// general SQL authorization boundary. Each call instead runs in a PostgreSQL
// read-only transaction and is rolled back when its rows are closed; the
// checker itself supplies only its fixed metadata SELECTs.
func NewMigrationReadOnlyQueryer(pool *pgxpool.Pool) migrations.Queryer {
	return migrationReadOnlyQueryer{pool: pool}
}

type migrationReadOnlyQueryer struct {
	pool *pgxpool.Pool
}

func (q migrationReadOnlyQueryer) Query(ctx context.Context, query string, args ...any) (migrations.Rows, error) {
	if q.pool == nil {
		return nil, errors.New("PostgreSQL pool is required")
	}
	tx, err := q.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		rollbackMigrationCheck(tx)
		return nil, err
	}
	return &migrationReadOnlyRows{tx: tx, rows: rows}, nil
}

type migrationReadOnlyRows struct {
	tx     pgx.Tx
	rows   pgx.Rows
	closed bool
}

func (r *migrationReadOnlyRows) Next() bool {
	return r.rows.Next()
}

func (r *migrationReadOnlyRows) Scan(dest ...any) error {
	return r.rows.Scan(dest...)
}

func (r *migrationReadOnlyRows) Err() error {
	return r.rows.Err()
}

func (r *migrationReadOnlyRows) Close() {
	if r == nil || r.closed {
		return
	}
	r.closed = true
	r.rows.Close()
	rollbackMigrationCheck(r.tx)
}

func rollbackMigrationCheck(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}
