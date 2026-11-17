//go:build postgres_integration

package migrations_test

import (
	"crypto/sha256"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

//go:embed testdata/036_v1_clean_architecture.sql
var synthetic036MigrationSQL []byte

func v1CompatibilityDirectory(t *testing.T) string {
	t.Helper()
	if got := fmt.Sprintf("%x", sha256.Sum256(synthetic036MigrationSQL)); got != migrations.ReleaseCompatibilityV1MigrationSHA256 {
		t.Fatalf("v1 fixture SHA-256=%s, want reviewed bytes %s", got, migrations.ReleaseCompatibilityV1MigrationSHA256)
	}
	directory := mobileCompatibilityDirectory(t)
	if err := os.WriteFile(filepath.Join(directory, migrations.ReleaseCompatibilityV1MigrationName), synthetic036MigrationSQL, 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestPostgres035BridgeAndV1ActivationAcceptReviewed036(t *testing.T) {
	fixture := newCompatibilityPGFixture(t)
	bridgeDirectory := mobileCompatibilityDirectory(t)
	result, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(fixture.conn), Directory: bridgeDirectory}).Run(fixture.ctx)
	if err != nil || result.Applied != 35 {
		t.Fatalf("bridge bootstrap=%#v, err=%v", result, err)
	}

	// Seed a legacy 0.20.0 Beacon DM to verify 036 data migration safety.
	if _, err := fixture.conn.Exec(fixture.ctx, `
		INSERT INTO spaces (id, slug, name, created_at) VALUES ('spc_default', 'default', 'Default', now());
		INSERT INTO users (id, github_login, display_name, kind, created_at, last_login_at)
		VALUES
			('usr_owner', 'owner', 'Owner', 'human', now(), now()),
			('usr_system_beacon', '__beacon__', 'Beacon', 'bot', now(), now());
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ('conv_beacon_legacy', 'spc_default', 'direct', 'Owner, Beacon', 'usr_owner:usr_system_beacon', 'usr_owner', now());
		INSERT INTO conversation_members (conversation_id, user_id, joined_at)
		VALUES ('conv_beacon_legacy', 'usr_owner', now()), ('conv_beacon_legacy', 'usr_system_beacon', now());
	`); err != nil {
		t.Fatalf("seed legacy beacon DM: %v", err)
	}

	queryer := fixture.readOnlyQueryer(t)
	bridgeReportBefore, err := (migrations.SchemaChecker{Queryer: queryer, Directory: bridgeDirectory, AllowReleaseCompatibility: true}).Check(fixture.ctx)
	if err != nil || bridgeReportBefore.AppliedCount != 35 || bridgeReportBefore.UnknownCount != 0 || bridgeReportBefore.CompatibleCount != 0 {
		t.Fatalf("bridge before 036 report=%#v, err=%v", bridgeReportBefore, err)
	}

	v1Directory := v1CompatibilityDirectory(t)
	v1Result, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(fixture.conn), Directory: v1Directory}).Run(fixture.ctx)
	if err != nil || v1Result.Applied != 1 {
		t.Fatalf("036 migration run=%#v, err=%v", v1Result, err)
	}

	var convType, convTitle string
	if err := fixture.conn.QueryRow(fixture.ctx, `SELECT type, title FROM conversations WHERE id = 'conv_beacon_legacy'`).Scan(&convType, &convTitle); err != nil {
		t.Fatalf("query migrated beacon conversation: %v", err)
	}
	if convType != "saved" || convTitle != "个人空间" {
		t.Fatalf("migrated beacon conversation = (%q, %q), want ('saved', '个人空间')", convType, convTitle)
	}

	// Bridge 0.20.1 rollback check against schema 36:
	bridgeReportAfter, err := (migrations.SchemaChecker{Queryer: queryer, Directory: bridgeDirectory, AllowReleaseCompatibility: true}).Check(fixture.ctx)
	if err != nil || bridgeReportAfter.AppliedCount != 36 || bridgeReportAfter.UnknownCount != 0 || bridgeReportAfter.CompatibleCount != 1 || !equalMigrationNames(bridgeReportAfter.CompatibleNames, []string{migrations.ReleaseCompatibilityV1MigrationName}) {
		t.Fatalf("bridge after 036 report=%#v, err=%v", bridgeReportAfter, err)
	}

	// Full v1.0.0 check against schema 36:
	v1Report, err := (migrations.SchemaChecker{Queryer: queryer, Directory: v1Directory, AllowReleaseCompatibility: true}).Check(fixture.ctx)
	if err != nil || v1Report.AppliedCount != 36 || v1Report.UnknownCount != 0 || len(v1Report.MissingNames) != 0 {
		t.Fatalf("v1 036 required report=%#v, err=%v", v1Report, err)
	}
}
