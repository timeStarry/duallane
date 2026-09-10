package migrations

import (
	"errors"
	"testing"
)

func TestEmbeddedReleaseCompatibilityPolicyIsReviewedAndBounded(t *testing.T) {
	t.Parallel()

	policy, err := EmbeddedReleaseCompatibilityPolicy()
	if err != nil {
		t.Fatal(err)
	}
	if policy.Version != ReleaseCompatibilityPolicyVersion || policy.BaseMigration != ReleaseCompatibilityBaseMigration {
		t.Fatalf("unexpected embedded policy: %#v", policy)
	}
	if len(policy.CompatibleMigrations) != 1 || policy.CompatibleMigrations[0].Name != ReleaseCompatibilityMigrationName || policy.CompatibleMigrations[0].SHA256 != ReleaseCompatibilityMigrationSHA256 {
		t.Fatalf("unexpected compatible migration policy: %#v", policy.CompatibleMigrations)
	}
}

func TestParseReleaseCompatibilityPolicyRejectsCorruptPolicies(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"unknown root field":    `{"version":1,"baseMigration":"033_workspace_command_result_finalization.sql","compatibleMigrations":[{"name":"034_workspace_chat_auto_hide.sql","sha256":"b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb"}],"extra":true}`,
		"duplicate root field":  `{"version":1,"version":1,"baseMigration":"033_workspace_command_result_finalization.sql","compatibleMigrations":[{"name":"034_workspace_chat_auto_hide.sql","sha256":"b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb"}]}`,
		"duplicate named entry": `{"version":1,"baseMigration":"033_workspace_command_result_finalization.sql","compatibleMigrations":[{"name":"034_workspace_chat_auto_hide.sql","sha256":"b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb"},{"name":"034_workspace_chat_auto_hide.sql","sha256":"b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb"}]}`,
		"unsupported version":   `{"version":2,"baseMigration":"033_workspace_command_result_finalization.sql","compatibleMigrations":[{"name":"034_workspace_chat_auto_hide.sql","sha256":"b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb"}]}`,
		"unreasonable base":     `{"version":1,"baseMigration":"032_workspace_storage_operator_runs.sql","compatibleMigrations":[{"name":"034_workspace_chat_auto_hide.sql","sha256":"b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb"}]}`,
		"renamed migration":     `{"version":1,"baseMigration":"033_workspace_command_result_finalization.sql","compatibleMigrations":[{"name":"034_workspace_chat_auto_hide_renamed.sql","sha256":"b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb"}]}`,
		"invalid SHA":           `{"version":1,"baseMigration":"033_workspace_command_result_finalization.sql","compatibleMigrations":[{"name":"034_workspace_chat_auto_hide.sql","sha256":"not-a-sha"}]}`,
		"changed reviewed SHA":  `{"version":1,"baseMigration":"033_workspace_command_result_finalization.sql","compatibleMigrations":[{"name":"034_workspace_chat_auto_hide.sql","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}]}`,
	}
	for name, document := range tests {
		name, document := name, document
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := ParseReleaseCompatibilityPolicy([]byte(document)); !errors.Is(err, ErrInvalidCompatibilityPolicy) {
				t.Fatalf("ParseReleaseCompatibilityPolicy() error = %v, want ErrInvalidCompatibilityPolicy", err)
			}
		})
	}
}

func TestCanonicalReleaseCompatibilityBaselineIsExact(t *testing.T) {
	t.Parallel()

	required := append([]string(nil), canonicalReleaseCompatibilityBaseline[:]...)
	if !isCanonicalReleaseCompatibilityBaseline(required) {
		t.Fatal("reviewed 001-033 baseline was not recognized")
	}
	required[len(required)-1] = ReleaseCompatibilityMigrationName
	if isCanonicalReleaseCompatibilityBaseline(required) {
		t.Fatal("034 must not be treated as the 033 compatibility baseline")
	}
}
