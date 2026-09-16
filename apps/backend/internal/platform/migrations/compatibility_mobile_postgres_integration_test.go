//go:build postgres_integration

package migrations_test

import (
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

// The reviewed future SQL is never discovered by the bridge's migrator.
//
//go:embed testdata/035_mobile_sessions.sql
var synthetic035MigrationSQL []byte

func mobileCompatibilityDirectory(t *testing.T) string {
	t.Helper()
	if got := fmt.Sprintf("%x", sha256.Sum256(synthetic035MigrationSQL)); got != migrations.ReleaseCompatibilityMobileMigrationSHA256 {
		t.Fatalf("mobile fixture SHA-256=%s, want reviewed bytes", got)
	}
	directory := canonical034Directory(t)
	if err := os.WriteFile(filepath.Join(directory, migrations.ReleaseCompatibilityMobileMigrationName), synthetic035MigrationSQL, 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func applyMobileCompatibilityFixture(t *testing.T, fixture *compatibilityPGFixture) {
	t.Helper()
	if _, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(fixture.conn), Directory: mobileCompatibilityDirectory(t)}).Run(fixture.ctx); err != nil {
		t.Fatal(err)
	}
}

func TestPostgres034BridgeAcceptsReviewed035WithoutMutatingHistoryOrMobileData(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	bridgeDirectory := canonical034Directory(t)
	result, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(fixture.conn), Directory: bridgeDirectory}).Run(fixture.ctx)
	if err != nil || result.Applied != 34 {
		t.Fatalf("bridge bootstrap=%#v, err=%v", result, err)
	}
	var exists bool
	if err := fixture.conn.QueryRow(fixture.ctx, "SELECT to_regclass('mobile_session_families') IS NOT NULL").Scan(&exists); err != nil || exists {
		t.Fatalf("bridge unexpectedly creates mobile schema: exists=%v, err=%v", exists, err)
	}
	applyMobileCompatibilityFixture(t, fixture)
	if _, err := fixture.conn.Exec(fixture.ctx, `
		INSERT INTO users (id, github_login, display_name, kind, created_at, last_login_at)
		VALUES ('usr_mobile_bridge', 'synthetic-bridge-user', 'Before', 'human', now(), now());
		INSERT INTO mobile_session_families(id, user_id, expires_at) VALUES ('family_bridge', 'usr_mobile_bridge', now() + interval '1 day');
		INSERT INTO mobile_access_tokens(token_hash, family_id, expires_at) VALUES ('synthetic_hash', 'family_bridge', now() + interval '1 hour');
	`); err != nil {
		t.Fatal(err)
	}
	var historyBefore, historyAfter, tokensBefore, tokensAfter string
	historySQL := "SELECT json_agg(schema_migrations ORDER BY name)::text FROM schema_migrations"
	tokensSQL := "SELECT json_agg(mobile_access_tokens ORDER BY token_hash)::text FROM mobile_access_tokens"
	if err := fixture.conn.QueryRow(fixture.ctx, historySQL).Scan(&historyBefore); err != nil {
		t.Fatal(err)
	}
	if err := fixture.conn.QueryRow(fixture.ctx, tokensSQL).Scan(&tokensBefore); err != nil {
		t.Fatal(err)
	}
	queryer := fixture.readOnlyQueryer(t)
	verifyReadOnlyTransaction(t, fixture.ctx, queryer, fixture.conn, fixture.schema)
	for i := 0; i < 2; i++ {
		report, err := (migrations.SchemaChecker{Queryer: queryer, Directory: bridgeDirectory, AllowReleaseCompatibility: true}).Check(fixture.ctx)
		if err != nil || report.AppliedCount != 35 || report.UnknownCount != 0 || report.CompatibleCount != 1 || !equalMigrationNames(report.CompatibleNames, []string{migrations.ReleaseCompatibilityMobileMigrationName}) {
			t.Fatalf("expanded bridge report=%#v, err=%v", report, err)
		}
	}
	// Existing user writes still work while preserved mobile families reference it.
	if _, err := fixture.conn.Exec(fixture.ctx, "UPDATE users SET display_name='After', last_login_at=now() WHERE id='usr_mobile_bridge'"); err != nil {
		t.Fatal(err)
	}
	if err := fixture.conn.QueryRow(fixture.ctx, historySQL).Scan(&historyAfter); err != nil {
		t.Fatal(err)
	}
	if err := fixture.conn.QueryRow(fixture.ctx, tokensSQL).Scan(&tokensAfter); err != nil {
		t.Fatal(err)
	}
	if historyBefore != historyAfter || tokensBefore != tokensAfter {
		t.Fatal("bridge check changed history or mobile state")
	}
	if _, err := (migrations.SchemaChecker{Queryer: queryer, Directory: bridgeDirectory}).Check(fixture.ctx); !errors.Is(err, migrations.ErrUnknownMigrations) {
		t.Fatalf("default checker error=%v, want strict rejection", err)
	}
	if result, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(fixture.conn), Directory: bridgeDirectory}).Run(fixture.ctx); !errors.Is(err, migrations.ErrMigrationHistory) || result.Applied != 0 {
		t.Fatalf("bridge runner must remain strict: result=%#v, err=%v", result, err)
	}
	if report, err := (migrations.SchemaChecker{Queryer: queryer, Directory: mobileCompatibilityDirectory(t), AllowReleaseCompatibility: true}).Check(fixture.ctx); err != nil || report.CompatibleCount != 0 {
		t.Fatalf("required 035 report=%#v, err=%v", report, err)
	}
}

func TestPostgres034BridgeRejectsRecorded035WithSchemaDrift(t *testing.T) {
	for _, scenario := range []struct{ name, mutation string }{
		{"missing table", "DROP TABLE mobile_auth_rate_limits"},
		{"missing column", "ALTER TABLE mobile_oauth_flows DROP COLUMN challenge"},
		{"column type", "ALTER TABLE mobile_auth_rate_limits ALTER COLUMN attempts TYPE bigint"},
		{"column nullable", "ALTER TABLE mobile_oauth_flows ALTER COLUMN challenge DROP NOT NULL"},
		{"column default", "ALTER TABLE mobile_oauth_flows ALTER COLUMN challenge SET DEFAULT 'unexpected'"},
		{"identity column", "ALTER TABLE mobile_auth_rate_limits ALTER COLUMN attempts ADD GENERATED ALWAYS AS IDENTITY"},
		{"generated column", "ALTER TABLE mobile_refresh_tokens DROP COLUMN consumed_at; ALTER TABLE mobile_refresh_tokens ADD COLUMN consumed_at timestamptz GENERATED ALWAYS AS (NULL::timestamptz) STORED"},
		{"domain column", "CREATE DOMAIN bridge_attempt_count AS integer CHECK (VALUE >= 0); ALTER TABLE mobile_auth_rate_limits ALTER COLUMN attempts TYPE bridge_attempt_count USING attempts::bridge_attempt_count"},
		{"missing unique", "ALTER TABLE mobile_oauth_flows DROP CONSTRAINT mobile_oauth_flows_code_hash_key"},
		{"missing primary key", "ALTER TABLE mobile_auth_rate_limits DROP CONSTRAINT mobile_auth_rate_limits_pkey"},
		{"foreign key delete action", "ALTER TABLE mobile_access_tokens DROP CONSTRAINT mobile_access_tokens_family_id_fkey; ALTER TABLE mobile_access_tokens ADD CONSTRAINT mobile_access_tokens_family_id_fkey FOREIGN KEY(family_id) REFERENCES mobile_session_families(id)"},
		{"unvalidated foreign key", "ALTER TABLE mobile_access_tokens DROP CONSTRAINT mobile_access_tokens_family_id_fkey; ALTER TABLE mobile_access_tokens ADD CONSTRAINT mobile_access_tokens_family_id_fkey FOREIGN KEY(family_id) REFERENCES mobile_session_families(id) ON DELETE CASCADE NOT VALID"},
		{"deferred foreign key", "ALTER TABLE mobile_access_tokens ALTER CONSTRAINT mobile_access_tokens_family_id_fkey DEFERRABLE INITIALLY DEFERRED"},
		{"missing index", "DROP INDEX mobile_oauth_expiry_idx"},
		{"wrong index column", "DROP INDEX mobile_access_family_idx; CREATE INDEX mobile_access_family_idx ON mobile_access_tokens(expires_at)"},
		{"partial index", "DROP INDEX mobile_refresh_family_idx; CREATE INDEX mobile_refresh_family_idx ON mobile_refresh_tokens(family_id) WHERE consumed_at IS NULL"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newCompatibilityPGFixture(t)
			applyMobileCompatibilityFixture(t, fixture)
			if _, err := fixture.conn.Exec(fixture.ctx, scenario.mutation); err != nil {
				t.Fatal(err)
			}
			_, err := (migrations.SchemaChecker{Queryer: fixture.readOnlyQueryer(t), Directory: canonical034Directory(t), AllowReleaseCompatibility: true}).Check(fixture.ctx)
			if !errors.Is(err, migrations.ErrCompatibleMigrationSchema) {
				t.Fatalf("drift check error=%v", err)
			}
		})
	}
}

func TestPostgres035BridgeRequiresExactHistoryAndDoesNotExtendSchema033(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	applyMobileCompatibilityFixture(t, fixture)
	queryer := fixture.readOnlyQueryer(t)
	if report, err := (migrations.SchemaChecker{Queryer: queryer, Directory: compatibilityBaselineDirectory(t), AllowReleaseCompatibility: true}).Check(fixture.ctx); !errors.Is(err, migrations.ErrUnknownMigrations) || !equalMigrationNames(report.UnknownNames, []string{migrations.ReleaseCompatibilityMobileMigrationName}) {
		t.Fatalf("schema33 must not gain 035 support: report=%#v, err=%v", report, err)
	}
	if _, err := fixture.conn.Exec(fixture.ctx, "INSERT INTO schema_migrations(name,applied_at) VALUES('036_future.sql',now())"); err != nil {
		t.Fatal(err)
	}
	if report, err := (migrations.SchemaChecker{Queryer: queryer, Directory: canonical034Directory(t), AllowReleaseCompatibility: true}).Check(fixture.ctx); !errors.Is(err, migrations.ErrUnknownMigrations) || !equalMigrationNames(report.UnknownNames, []string{"036_future.sql"}) {
		t.Fatalf("future history accepted: report=%#v, err=%v", report, err)
	}
	if _, err := fixture.conn.Exec(fixture.ctx, "DELETE FROM schema_migrations WHERE name='036_future.sql' OR name='034_workspace_chat_auto_hide.sql'"); err != nil {
		t.Fatal(err)
	}
	if report, err := (migrations.SchemaChecker{Queryer: queryer, Directory: canonical034Directory(t), AllowReleaseCompatibility: true}).Check(fixture.ctx); !errors.Is(err, migrations.ErrMissingMigrations) || !equalMigrationNames(report.MissingNames, []string{migrations.ReleaseCompatibilityMigrationName}) {
		t.Fatalf("missing required history accepted: report=%#v, err=%v", report, err)
	}
}
