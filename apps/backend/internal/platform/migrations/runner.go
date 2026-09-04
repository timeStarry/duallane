package migrations

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	// AdvisoryLockIdentity must remain byte-for-byte compatible with the Node
	// runner while both runtimes can still start against the same database.
	AdvisoryLockIdentity = "duallane:schema-migrations"

	advisoryLockSQL = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))"
	createTableSQL  = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL
)`
	columnsSQL = `SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'schema_migrations'
ORDER BY ordinal_position`
	primaryKeySQL = `SELECT kcu.column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON kcu.constraint_name = tc.constraint_name
 AND kcu.constraint_schema = tc.constraint_schema
 AND kcu.table_name = tc.table_name
WHERE tc.table_schema = current_schema()
  AND tc.table_name = 'schema_migrations'
  AND tc.constraint_type = 'PRIMARY KEY'
ORDER BY kcu.ordinal_position`
	appliedSQL = "SELECT name FROM schema_migrations ORDER BY name"
	insertSQL  = "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)"
)

var (
	ErrUnsupportedSchema = errors.New("unsupported schema_migrations state")
	ErrMigrationHistory  = errors.New("migration history does not match migration files")
)

// Rows is the small row-iteration surface needed by the runner. It keeps
// unit tests independent of a PostgreSQL driver and lets the platform adapter
// choose a PostgreSQL adapter without leaking driver details into migration policy.
type Rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}

// Tx is the transaction surface needed by one migration run.
type Tx interface {
	Exec(ctx context.Context, query string, args ...any) error
	Query(ctx context.Context, query string, args ...any) (Rows, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// Beginner starts a transaction on the authoritative PostgreSQL connection.
type Beginner interface {
	Begin(ctx context.Context) (Tx, error)
}

// BeginFunc adapts a function to Beginner for focused tests and small command
// adapters.
type BeginFunc func(context.Context) (Tx, error)

func (f BeginFunc) Begin(ctx context.Context) (Tx, error) {
	return f(ctx)
}

// Runner applies the migration directory as one transaction. The entire
// pending batch is serialized under the same transaction advisory lock as the
// existing Node runner, so a failed batch leaves both schema and history
// unchanged.
type Runner struct {
	Beginner  Beginner
	Directory string
	Now       func() time.Time
}

type Result struct {
	Discovered   int
	Applied      int
	AppliedNames []string
}

// Run discovers, validates, and applies pending migrations.
func (r Runner) Run(ctx context.Context) (result Result, err error) {
	if r.Beginner == nil {
		return result, fmt.Errorf("migration database is required")
	}
	files, err := Discover(r.Directory)
	if err != nil {
		return result, err
	}
	result.Discovered = len(files)

	tx, err := r.Beginner.Begin(ctx)
	if err != nil {
		return result, fmt.Errorf("begin migration transaction: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			// Rollback is best effort after an execution or context failure. The
			// original error is more useful than a secondary rollback error.
			_ = tx.Rollback(context.Background())
		}
	}()

	if err := tx.Exec(ctx, advisoryLockSQL, AdvisoryLockIdentity); err != nil {
		return result, fmt.Errorf("acquire migration advisory lock: %w", err)
	}
	if err := ensureSchema(ctx, tx); err != nil {
		return result, err
	}
	applied, err := readApplied(ctx, tx)
	if err != nil {
		return result, err
	}
	if err := validateHistory(files, applied); err != nil {
		return result, err
	}

	now := r.Now
	if now == nil {
		now = time.Now
	}
	pendingSeen := false
	for _, file := range files {
		if _, ok := applied[file.Name]; ok {
			if pendingSeen {
				return result, fmt.Errorf("%w: applied migration %q follows a pending migration", ErrMigrationHistory, file.Name)
			}
			continue
		}
		pendingSeen = true
		if err := ctx.Err(); err != nil {
			return result, fmt.Errorf("migration cancelled before %q: %w", file.Name, err)
		}
		sqlBytes, err := os.ReadFile(file.Path)
		if err != nil {
			return result, fmt.Errorf("read migration %q: %w", file.Name, err)
		}
		if strings.TrimSpace(string(sqlBytes)) == "" {
			return result, fmt.Errorf("%w: migration %q is empty", ErrUnsupportedSchema, file.Name)
		}
		if err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			return result, fmt.Errorf("apply migration %q: %w", file.Name, err)
		}
		if err := tx.Exec(ctx, insertSQL, file.Name, now().UTC()); err != nil {
			return result, fmt.Errorf("record migration %q: %w", file.Name, err)
		}
		result.Applied++
		result.AppliedNames = append(result.AppliedNames, file.Name)
	}

	if err := tx.Commit(ctx); err != nil {
		return result, fmt.Errorf("commit migrations: %w", err)
	}
	committed = true
	return result, nil
}

type schemaColumn struct {
	Name     string
	DataType string
	Nullable string
}

func ensureSchema(ctx context.Context, tx Tx) error {
	if err := tx.Exec(ctx, createTableSQL); err != nil {
		return fmt.Errorf("ensure schema_migrations table: %w", err)
	}

	rows, err := tx.Query(ctx, columnsSQL)
	if err != nil {
		return fmt.Errorf("inspect schema_migrations columns: %w", err)
	}
	columns := make([]schemaColumn, 0, 2)
	for rows.Next() {
		var column schemaColumn
		if err := rows.Scan(&column.Name, &column.DataType, &column.Nullable); err != nil {
			rows.Close()
			return fmt.Errorf("inspect schema_migrations columns: %w", err)
		}
		columns = append(columns, column)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("inspect schema_migrations columns: %w", err)
	}
	rows.Close()
	expectedColumns := []schemaColumn{
		{Name: "name", DataType: "text", Nullable: "NO"},
		{Name: "applied_at", DataType: "timestamp with time zone", Nullable: "NO"},
	}
	if len(columns) != len(expectedColumns) {
		return fmt.Errorf("%w: schema_migrations must contain exactly name and applied_at", ErrUnsupportedSchema)
	}
	for index, expected := range expectedColumns {
		actual := columns[index]
		if actual.Name != expected.Name || actual.DataType != expected.DataType || !strings.EqualFold(actual.Nullable, expected.Nullable) {
			return fmt.Errorf("%w: schema_migrations column %q is incompatible", ErrUnsupportedSchema, actual.Name)
		}
	}

	rows, err = tx.Query(ctx, primaryKeySQL)
	if err != nil {
		return fmt.Errorf("inspect schema_migrations primary key: %w", err)
	}
	var primaryKeyColumns []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return fmt.Errorf("inspect schema_migrations primary key: %w", err)
		}
		primaryKeyColumns = append(primaryKeyColumns, name)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("inspect schema_migrations primary key: %w", err)
	}
	rows.Close()
	if len(primaryKeyColumns) != 1 || primaryKeyColumns[0] != "name" {
		return fmt.Errorf("%w: schema_migrations primary key must be name", ErrUnsupportedSchema)
	}
	return nil
}

func readApplied(ctx context.Context, tx Tx) (map[string]struct{}, error) {
	rows, err := tx.Query(ctx, appliedSQL)
	if err != nil {
		return nil, fmt.Errorf("read schema_migrations: %w", err)
	}
	applied := make(map[string]struct{})
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return nil, fmt.Errorf("read schema_migrations: %w", err)
		}
		if _, exists := applied[name]; exists {
			rows.Close()
			return nil, fmt.Errorf("%w: duplicate applied migration %q", ErrMigrationHistory, name)
		}
		applied[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("read schema_migrations: %w", err)
	}
	rows.Close()
	return applied, nil
}

func validateHistory(files []File, applied map[string]struct{}) error {
	byName := make(map[string]struct{}, len(files))
	for _, file := range files {
		byName[file.Name] = struct{}{}
	}
	for name := range applied {
		if !IsCanonicalName(name) {
			return fmt.Errorf("%w: applied name %q is not canonical", ErrMigrationHistory, name)
		}
		if _, exists := byName[name]; !exists {
			return fmt.Errorf("%w: applied migration %q is missing from the directory", ErrMigrationHistory, name)
		}
	}

	pendingSeen := false
	for _, file := range files {
		_, exists := applied[file.Name]
		if !exists {
			pendingSeen = true
			continue
		}
		if pendingSeen {
			return fmt.Errorf("%w: applied migration %q follows a pending migration", ErrMigrationHistory, file.Name)
		}
	}
	return nil
}
