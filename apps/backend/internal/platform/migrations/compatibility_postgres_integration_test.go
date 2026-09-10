//go:build postgres_integration

package migrations_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

type compatibilityPGFixture struct {
	ctx    context.Context
	conn   *pgx.Conn
	dsn    string
	schema string
}

func newCompatibilityPGFixture(t *testing.T) *compatibilityPGFixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_schema_compat_negative_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop compatibility test schema: %v", err)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	return &compatibilityPGFixture{ctx: ctx, conn: conn, dsn: dsn, schema: schema}
}

func (f *compatibilityPGFixture) createHistory(t *testing.T, extra string) {
	t.Helper()
	if _, err := f.conn.Exec(f.ctx, `
		CREATE TABLE schema_migrations (
			name TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL
		)`); err != nil {
		t.Fatal(err)
	}
	names := append([]string(nil), expectedCompatibilityBaselineNames...)
	if extra != "" {
		names = append(names, extra)
	}
	for index, name := range names {
		if _, err := f.conn.Exec(f.ctx, "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", name, time.Unix(int64(index), 0).UTC()); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *compatibilityPGFixture) readOnlyQueryer(t *testing.T) migrations.Queryer {
	t.Helper()
	poolConfig, err := pgxpool.ParseConfig(f.dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.MaxConns = 1
	poolConfig.ConnConfig.RuntimeParams["search_path"] = f.schema
	pool, err := pgxpool.NewWithConfig(f.ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return postgres.NewMigrationReadOnlyQueryer(pool)
}

func canonicalCompatibilityDirectory(t *testing.T) string {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
}

func canonical034Directory(t *testing.T) string {
	t.Helper()
	directory := canonicalCompatibilityDirectory(t)
	files := assertCanonicalCompatibilityInventory(t, directory)
	if len(files) != len(expectedCompatibilityBaselineNames)+1 {
		t.Fatalf("canonical 034 is required for this test; discovered %d migrations", len(files))
	}
	return directory
}

func compatibilityBaselineDirectory(t *testing.T) string {
	t.Helper()
	canonicalDirectory := canonicalCompatibilityDirectory(t)
	canonicalFiles := assertCanonicalCompatibilityInventory(t, canonicalDirectory)
	return copyCanonicalCompatibilityBaseline(t, canonicalFiles)
}

func TestPostgresSchemaCheckerAcceptsCanonical034AsRequired(t *testing.T) {
	directory := canonical034Directory(t)
	fixture := newCompatibilityPGFixture(t)

	result, err := (migrations.Runner{
		Beginner:  postgres.NewMigrationBeginner(fixture.conn),
		Directory: directory,
	}).Run(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied != len(expectedCompatibilityBaselineNames)+1 {
		t.Fatalf("canonical 034 runner applied %d migrations, want %d", result.Applied, len(expectedCompatibilityBaselineNames)+1)
	}

	report, err := (migrations.SchemaChecker{
		Queryer:                   fixture.readOnlyQueryer(t),
		Directory:                 directory,
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if report.AppliedCount != len(expectedCompatibilityBaselineNames)+1 || len(report.MissingNames) != 0 || report.UnknownCount != 0 || report.CompatibleCount != 0 || len(report.CompatibleNames) != 0 {
		t.Fatalf("unexpected required canonical-034 report: %#v", report)
	}
}

func TestPostgresSchemaCheckerRejectsMissingCanonical034(t *testing.T) {
	directory := canonical034Directory(t)
	fixture := newCompatibilityPGFixture(t)
	baselineDirectory := compatibilityBaselineDirectory(t)

	result, err := (migrations.Runner{
		Beginner:  postgres.NewMigrationBeginner(fixture.conn),
		Directory: baselineDirectory,
	}).Run(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied != len(expectedCompatibilityBaselineNames) {
		t.Fatalf("baseline runner applied %d migrations, want %d", result.Applied, len(expectedCompatibilityBaselineNames))
	}

	report, err := (migrations.SchemaChecker{
		Queryer:                   fixture.readOnlyQueryer(t),
		Directory:                 directory,
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err == nil || !errors.Is(err, migrations.ErrMissingMigrations) {
		t.Fatalf("error = %v, want missing required canonical 034", err)
	}
	if report.AppliedCount != len(expectedCompatibilityBaselineNames) || !equalMigrationNames(report.MissingNames, []string{migrations.ReleaseCompatibilityMigrationName}) || report.CompatibleCount != 0 || report.UnknownCount != 0 {
		t.Fatalf("unexpected missing canonical-034 report: %#v", report)
	}
}

func TestPostgresSchemaCheckerRejects035WhenCanonical034IsRequired(t *testing.T) {
	directory := canonical034Directory(t)
	fixture := newCompatibilityPGFixture(t)

	result, err := (migrations.Runner{
		Beginner:  postgres.NewMigrationBeginner(fixture.conn),
		Directory: directory,
	}).Run(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied != len(expectedCompatibilityBaselineNames)+1 {
		t.Fatalf("canonical 034 runner applied %d migrations, want %d", result.Applied, len(expectedCompatibilityBaselineNames)+1)
	}
	if _, err := fixture.conn.Exec(fixture.ctx, "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", "035_future_workspace_change.sql", time.Date(2026, 9, 10, 1, 5, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}

	report, err := (migrations.SchemaChecker{
		Queryer:                   fixture.readOnlyQueryer(t),
		Directory:                 directory,
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err == nil || !errors.Is(err, migrations.ErrUnknownMigrations) {
		t.Fatalf("error = %v, want unknown 035 rejection", err)
	}
	if report.UnknownCount != 1 || !equalMigrationNames(report.UnknownNames, []string{"035_future_workspace_change.sql"}) || report.CompatibleCount != 0 {
		t.Fatalf("unexpected canonical-034 unknown report: %#v", report)
	}
}

func TestPostgresSchemaCheckerRejectsMissingReviewed034Columns(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	fixture.createHistory(t, migrations.ReleaseCompatibilityMigrationName)
	if _, err := fixture.conn.Exec(fixture.ctx, `
		CREATE TABLE workspace_emote_preferences (
			auto_hide_messages BOOLEAN NOT NULL DEFAULT FALSE
		)`); err != nil {
		t.Fatal(err)
	}

	_, err := (migrations.SchemaChecker{
		Queryer:                   fixture.readOnlyQueryer(t),
		Directory:                 compatibilityBaselineDirectory(t),
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err == nil || !errors.Is(err, migrations.ErrCompatibleMigrationSchema) {
		t.Fatalf("error = %v, want missing 034 column rejection", err)
	}
}

func TestPostgresSchemaCheckerRejectsReviewed034DefaultDrift(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	fixture.createHistory(t, migrations.ReleaseCompatibilityMigrationName)
	if _, err := fixture.conn.Exec(fixture.ctx, `
		CREATE TABLE workspace_emote_preferences (
			auto_hide_messages BOOLEAN NOT NULL DEFAULT TRUE,
			auto_hide_message_types_json TEXT NOT NULL DEFAULT '["changed"]'
		)`); err != nil {
		t.Fatal(err)
	}

	_, err := (migrations.SchemaChecker{
		Queryer:                   fixture.readOnlyQueryer(t),
		Directory:                 compatibilityBaselineDirectory(t),
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err == nil || !errors.Is(err, migrations.ErrCompatibleMigrationSchema) {
		t.Fatalf("error = %v, want 034 default drift rejection", err)
	}
}

func TestPostgresSchemaCheckerRejectsReviewed034TypeDrift(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	fixture.createHistory(t, migrations.ReleaseCompatibilityMigrationName)
	if _, err := fixture.conn.Exec(fixture.ctx, `
		CREATE TABLE workspace_emote_preferences (
			auto_hide_messages TEXT NOT NULL DEFAULT 'false',
			auto_hide_message_types_json TEXT NOT NULL DEFAULT '["image","emote","long"]'
		)`); err != nil {
		t.Fatal(err)
	}

	_, err := (migrations.SchemaChecker{
		Queryer:                   fixture.readOnlyQueryer(t),
		Directory:                 compatibilityBaselineDirectory(t),
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err == nil || !errors.Is(err, migrations.ErrCompatibleMigrationSchema) {
		t.Fatalf("error = %v, want 034 type drift rejection", err)
	}
}

func TestPostgresSchemaCheckerRejectsReviewed034NullabilityDrift(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	fixture.createHistory(t, migrations.ReleaseCompatibilityMigrationName)
	if _, err := fixture.conn.Exec(fixture.ctx, `
		CREATE TABLE workspace_emote_preferences (
			auto_hide_messages BOOLEAN DEFAULT FALSE,
			auto_hide_message_types_json TEXT NOT NULL DEFAULT '["image","emote","long"]'
		)`); err != nil {
		t.Fatal(err)
	}

	_, err := (migrations.SchemaChecker{
		Queryer:                   fixture.readOnlyQueryer(t),
		Directory:                 compatibilityBaselineDirectory(t),
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err == nil || !errors.Is(err, migrations.ErrCompatibleMigrationSchema) {
		t.Fatalf("error = %v, want 034 nullability drift rejection", err)
	}
}

func TestPostgresSchemaCheckerRejectsUnknown035(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	fixture.createHistory(t, "035_future_workspace_change.sql")

	report, err := (migrations.SchemaChecker{
		Queryer:                   fixture.readOnlyQueryer(t),
		Directory:                 compatibilityBaselineDirectory(t),
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err == nil || !errors.Is(err, migrations.ErrUnknownMigrations) {
		t.Fatalf("error = %v, want unknown 035 rejection", err)
	}
	if report.UnknownCount != 1 || len(report.UnknownNames) != 1 || report.UnknownNames[0] != "035_future_workspace_change.sql" {
		t.Fatalf("unexpected unknown report: %#v", report)
	}
}

func TestPostgresRunnerStrictlyRejectsApplied034(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	fixture.createHistory(t, migrations.ReleaseCompatibilityMigrationName)

	result, err := (migrations.Runner{
		Beginner:  postgres.NewMigrationBeginner(fixture.conn),
		Directory: compatibilityBaselineDirectory(t),
	}).Run(fixture.ctx)
	if err == nil || !errors.Is(err, migrations.ErrMigrationHistory) {
		t.Fatalf("error = %v, want strict applied-034 rejection", err)
	}
	if result.Applied != 0 {
		t.Fatalf("strict runner applied %d migrations before rejecting history", result.Applied)
	}
}

func equalMigrationNames(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range want {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
