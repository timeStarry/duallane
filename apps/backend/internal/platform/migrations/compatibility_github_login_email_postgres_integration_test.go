//go:build postgres_integration

package migrations_test

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

//go:embed testdata/038_github_login_email.sql
var synthetic038MigrationSQL []byte

func TestReviewed038FixtureMatchesCanonicalMigrationBytes(t *testing.T) {
	if got := fmt.Sprintf("%x", sha256.Sum256(synthetic038MigrationSQL)); got != migrations.ReleaseCompatibilityGitHubLoginEmailMigrationSHA256 {
		t.Fatalf("038 bridge fixture SHA-256 = %s, want reviewed bytes", got)
	}
	canonical, err := os.ReadFile(filepath.Join(canonicalCompatibilityDirectory(t), migrations.ReleaseCompatibilityGitHubLoginEmailMigrationName))
	if os.IsNotExist(err) {
		// The rollback bridge carries 038 only in testdata.
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(synthetic038MigrationSQL, canonical) {
		t.Fatal("038 bridge fixture differs from canonical migration bytes")
	}
}

func TestPostgres037BridgeAcceptsReviewed038ReadOnly(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	bridgeDirectory := agentCompatibilityDirectory(t)
	runner := migrations.Runner{Beginner: postgres.NewMigrationBeginner(fixture.conn), Directory: bridgeDirectory}
	result, err := runner.Run(fixture.ctx)
	if err != nil || result.Applied != 37 {
		t.Fatalf("schema 37 bootstrap = %#v, err=%v", result, err)
	}
	checker := migrations.SchemaChecker{
		Queryer:                   fixture.readOnlyQueryer(t),
		Directory:                 bridgeDirectory,
		AllowReleaseCompatibility: true,
	}
	before, err := checker.Check(fixture.ctx)
	if err != nil || before.AppliedCount != 37 || before.CompatibleCount != 0 {
		t.Fatalf("bridge before 038 = %#v, err=%v", before, err)
	}

	activationDirectory := agentCompatibilityDirectory(t)
	if err := os.WriteFile(filepath.Join(activationDirectory, migrations.ReleaseCompatibilityGitHubLoginEmailMigrationName), synthetic038MigrationSQL, 0o600); err != nil {
		t.Fatal(err)
	}
	runner.Directory = activationDirectory
	result, err = runner.Run(fixture.ctx)
	if err != nil || result.Applied != 1 {
		t.Fatalf("schema 38 activation = %#v, err=%v", result, err)
	}
	historyBefore, err := readMigrationHistory(fixture.ctx, fixture.conn)
	if err != nil {
		t.Fatal(err)
	}
	report, err := checker.Check(fixture.ctx)
	if err != nil || len(report.RequiredNames) != 37 || report.AppliedCount != 38 ||
		report.UnknownCount != 0 || report.CompatibleCount != 1 ||
		!equalMigrationNames(report.CompatibleNames, []string{migrations.ReleaseCompatibilityGitHubLoginEmailMigrationName}) {
		t.Fatalf("bridge after 038 = %#v, err=%v", report, err)
	}
	activationChecker := checker
	activationChecker.Directory = activationDirectory
	activationReport, err := activationChecker.Check(fixture.ctx)
	if err != nil || len(activationReport.RequiredNames) != 38 || activationReport.CompatibleCount != 0 {
		t.Fatalf("activation schema checker = %#v, err=%v", activationReport, err)
	}
	historyAfter, err := readMigrationHistory(fixture.ctx, fixture.conn)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(historyBefore, historyAfter) {
		t.Fatal("schema checker changed migration history")
	}

	for _, scenario := range []struct {
		name   string
		column string
	}{
		{"wrong type", "INTEGER"},
		{"required column", "TEXT NOT NULL"},
		{"default value", "TEXT DEFAULT ''"},
		{"generated value", "TEXT GENERATED ALWAYS AS (github_login) STORED"},
		{"missing column", ""},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			if _, err := fixture.conn.Exec(fixture.ctx, "ALTER TABLE users DROP COLUMN github_login_email"); err != nil {
				t.Fatal(err)
			}
			if scenario.column != "" {
				if _, err := fixture.conn.Exec(fixture.ctx, "ALTER TABLE users ADD COLUMN github_login_email "+scenario.column); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := checker.Check(fixture.ctx); !errors.Is(err, migrations.ErrCompatibleMigrationSchema) {
				t.Fatalf("schema drift was not rejected: %v", err)
			}
		})
	}
}
