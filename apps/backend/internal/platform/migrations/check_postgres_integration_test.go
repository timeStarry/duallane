//go:build postgres_integration

package migrations_test

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestPostgresSchemaCheckerIsReadOnlyAgainstCurrentHistory(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())

	schema := fmt.Sprintf("duallane_schema_check_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := conn.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		CREATE TABLE schema_migrations (
			name TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL
		)`); err != nil {
		t.Fatal(err)
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	directory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	files, err := migrations.Discover(directory)
	if err != nil {
		t.Fatal(err)
	}
	for index, file := range files {
		if _, err := conn.Exec(ctx, "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", file.Name, time.Unix(int64(index), 0).UTC()); err != nil {
			t.Fatal(err)
		}
	}

	before, err := readMigrationHistory(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	isolatedDSN, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := isolatedDSN.Query()
	query.Set("search_path", schema)
	isolatedDSN.RawQuery = query.Encode()
	pool, err := postgres.OpenPool(ctx, isolatedDSN.String(), postgres.PoolOptions{MaxConnections: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	queryer := postgres.NewMigrationReadOnlyQueryer(pool)
	report, err := (migrations.SchemaChecker{
		Queryer:   queryer,
		Directory: directory,
	}).Check(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.RequiredNames) != len(files) || report.AppliedCount != len(files) || len(report.MissingNames) != 0 || report.UnknownCount != 0 {
		t.Fatalf("unexpected compatibility report: %#v", report)
	}

	verifyReadOnlyTransaction(t, ctx, queryer, conn, schema)
	after, err := readMigrationHistory(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("schema_migrations changed during read-only check: before=%v after=%v", before, after)
	}
}

func verifyReadOnlyTransaction(t *testing.T, ctx context.Context, queryer migrations.Queryer, conn *pgx.Conn, schema string) {
	t.Helper()

	rows, err := queryer.Query(ctx, "SELECT current_setting('transaction_read_only')")
	if err != nil {
		t.Fatal("read-only transaction probe failed")
	}
	var mode string
	if !rows.Next() {
		rows.Close()
		t.Fatal("read-only transaction probe returned no row")
	}
	if err := rows.Scan(&mode); err != nil {
		rows.Close()
		t.Fatal("read-only transaction probe could not be scanned")
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal("read-only transaction probe returned an invalid result")
	}
	rows.Close()
	if mode != "on" {
		t.Fatalf("transaction_read_only = %q, want on", mode)
	}

	probeName := fmt.Sprintf("duallane_read_only_probe_%d", time.Now().UnixNano())
	probeIdentifier := pgx.Identifier{probeName}.Sanitize()
	probeRows, probeErr := queryer.Query(ctx, "CREATE TABLE "+probeIdentifier+" (id integer)")
	if probeRows != nil {
		// pgx can defer a server error until the result stream is consumed.
		for probeRows.Next() {
		}
		if probeErr == nil {
			probeErr = probeRows.Err()
		}
		probeRows.Close()
	}
	if probeErr == nil {
		t.Fatal("read-only transaction accepted DDL")
	}

	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM pg_class AS c
		JOIN pg_namespace AS n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2
	)`, schema, probeName).Scan(&exists); err != nil {
		t.Fatal("could not verify read-only DDL probe")
	}
	if exists {
		t.Fatal("read-only DDL probe created a relation")
	}
}

type migrationHistoryRow struct {
	Name      string
	AppliedAt time.Time
}

func readMigrationHistory(ctx context.Context, conn *pgx.Conn) ([]migrationHistoryRow, error) {
	rows, err := conn.Query(ctx, "SELECT name, applied_at FROM schema_migrations ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var history []migrationHistoryRow
	for rows.Next() {
		var row migrationHistoryRow
		if err := rows.Scan(&row.Name, &row.AppliedAt); err != nil {
			return nil, err
		}
		history = append(history, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return history, nil
}
