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
	"runtime"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

// The reviewed future SQL is kept outside the canonical migration directory
// for the schema-36 bridge rehearsal. It is applied only after the bridge has
// been proven to run on schema 36.
//
//go:embed testdata/037_agent_task_authorization.sql
var synthetic037MigrationSQL []byte

func agentCompatibilityDirectory(t *testing.T) string {
	t.Helper()
	if got := fmt.Sprintf("%x", sha256.Sum256(synthetic037MigrationSQL)); got != migrations.ReleaseCompatibilityAgentMigrationSHA256 {
		t.Fatalf("agent fixture SHA-256=%s, want reviewed bytes %s", got, migrations.ReleaseCompatibilityAgentMigrationSHA256)
	}
	directory := v1CompatibilityDirectory(t)
	if err := os.WriteFile(filepath.Join(directory, migrations.ReleaseCompatibilityAgentMigrationName), synthetic037MigrationSQL, 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func applyAgentCompatibilityFixture(t *testing.T, fixture *compatibilityPGFixture) string {
	t.Helper()
	bridgeDirectory := v1CompatibilityDirectory(t)
	result, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(fixture.conn), Directory: bridgeDirectory}).Run(fixture.ctx)
	if err != nil || result.Applied != 36 {
		t.Fatalf("schema-36 bridge bootstrap=%#v, err=%v", result, err)
	}
	if _, err := fixture.conn.Exec(fixture.ctx, string(synthetic037MigrationSQL)); err != nil {
		t.Fatalf("apply reviewed 037 fixture: %v", err)
	}
	if _, err := fixture.conn.Exec(fixture.ctx,
		"INSERT INTO schema_migrations (name, applied_at) VALUES ($1, now())",
		migrations.ReleaseCompatibilityAgentMigrationName,
	); err != nil {
		t.Fatalf("record reviewed 037 fixture: %v", err)
	}
	return bridgeDirectory
}

func TestReviewed037FixtureMatchesCanonicalMigrationBytes(t *testing.T) {
	if got := fmt.Sprintf("%x", sha256.Sum256(synthetic037MigrationSQL)); got != migrations.ReleaseCompatibilityAgentMigrationSHA256 {
		t.Fatal("037 bridge fixture does not match its reviewed digest")
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	canonicalPath := filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations", migrations.ReleaseCompatibilityAgentMigrationName)
	canonical, err := os.ReadFile(filepath.Clean(canonicalPath))
	if os.IsNotExist(err) {
		// The schema-36 bridge deliberately keeps future SQL outside canonical
		// discovery. Its immutable reviewed digest was still checked above.
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(synthetic037MigrationSQL, canonical) {
		t.Fatal("037 bridge fixture differs from canonical migration bytes")
	}
}

func TestPostgres036BridgeAcceptsReviewed037ReadOnly(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	bridgeDirectory := applyAgentCompatibilityFixture(t, fixture)
	queryer := fixture.readOnlyQueryer(t)
	verifyReadOnlyTransaction(t, fixture.ctx, queryer, fixture.conn, fixture.schema)

	historyBefore, err := readMigrationHistory(fixture.ctx, fixture.conn)
	if err != nil {
		t.Fatal(err)
	}
	report, err := (migrations.SchemaChecker{
		Queryer:                   queryer,
		Directory:                 bridgeDirectory,
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.RequiredNames) != 36 || report.AppliedCount != 37 || report.UnknownCount != 0 || report.CompatibleCount != 1 || !equalMigrationNames(report.CompatibleNames, []string{migrations.ReleaseCompatibilityAgentMigrationName}) {
		t.Fatalf("unexpected schema-37 bridge report=%#v", report)
	}
	historyAfter, err := readMigrationHistory(fixture.ctx, fixture.conn)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(historyBefore, historyAfter) {
		t.Fatalf("schema checker changed migration history: before=%s after=%s", historyBefore, historyAfter)
	}

	// A directory containing 037 is the activation contract, not the bridge
	// contract; it should require the migration rather than report it unknown.
	activationReport, err := (migrations.SchemaChecker{
		Queryer:                   queryer,
		Directory:                 agentCompatibilityDirectory(t),
		AllowReleaseCompatibility: true,
	}).Check(fixture.ctx)
	if err != nil || len(activationReport.MissingNames) != 0 || activationReport.UnknownCount != 0 || activationReport.CompatibleCount != 0 {
		t.Fatalf("unexpected schema-37 activation report=%#v, err=%v", activationReport, err)
	}
}

func TestPostgres037BridgeRejectsSchemaDrift(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		mutation string
	}{
		{
			name:     "missing column",
			mutation: "ALTER TABLE workspace_agent_tasks DROP COLUMN authorization_hash",
		},
		{
			name: "bad constraint",
			mutation: "ALTER TABLE workspace_agent_tasks DROP CONSTRAINT workspace_agent_tasks_depth_check; " +
				"ALTER TABLE workspace_agent_tasks ADD CONSTRAINT workspace_agent_tasks_depth_check CHECK (depth >= 0)",
		},
		{
			name: "wrong foreign key",
			mutation: "ALTER TABLE workspace_agent_tasks DROP CONSTRAINT workspace_agent_tasks_bot_id_fkey; " +
				"ALTER TABLE workspace_agent_tasks ADD CONSTRAINT workspace_agent_tasks_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES workspace_agent_bots(id)",
		},
		{
			name:     "missing index",
			mutation: "DROP INDEX workspace_agent_tasks_expiry_idx",
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newCompatibilityPGFixture(t)
			bridgeDirectory := applyAgentCompatibilityFixture(t, fixture)
			if _, err := fixture.conn.Exec(fixture.ctx, scenario.mutation); err != nil {
				t.Fatal(err)
			}
			_, err := (migrations.SchemaChecker{
				Queryer:                   fixture.readOnlyQueryer(t),
				Directory:                 bridgeDirectory,
				AllowReleaseCompatibility: true,
			}).Check(fixture.ctx)
			if err == nil || !errors.Is(err, migrations.ErrCompatibleMigrationSchema) {
				t.Fatalf("schema drift accepted: err=%v", err)
			}
		})
	}
}
