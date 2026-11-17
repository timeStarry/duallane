package migrations

import (
	"encoding/json"
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
	if len(policy.CompatibleMigrations) != 4 ||
		policy.CompatibleMigrations[0].Name != ReleaseCompatibilityMigrationName || policy.CompatibleMigrations[0].SHA256 != ReleaseCompatibilityMigrationSHA256 ||
		policy.CompatibleMigrations[1].Name != ReleaseCompatibilityMobileMigrationName || policy.CompatibleMigrations[1].SHA256 != ReleaseCompatibilityMobileMigrationSHA256 ||
		policy.CompatibleMigrations[2].Name != ReleaseCompatibilityV1MigrationName || policy.CompatibleMigrations[2].SHA256 != ReleaseCompatibilityV1MigrationSHA256 ||
		policy.CompatibleMigrations[3].Name != ReleaseCompatibilityAgentMigrationName || policy.CompatibleMigrations[3].SHA256 != ReleaseCompatibilityAgentMigrationSHA256 {
		t.Fatalf("unexpected compatible migration policy: %#v", policy.CompatibleMigrations)
	}
}

func TestReleaseCompatibilityPreservesHistoricalPolicyAuthority(t *testing.T) {
	t.Parallel()
	policy, err := EmbeddedReleaseCompatibilityPolicy()
	if err != nil {
		t.Fatal(err)
	}
	baseline33 := append([]string(nil), canonicalReleaseCompatibilityBaseline[:]...)
	baseline34 := append(append([]string(nil), baseline33...), ReleaseCompatibilityMigrationName)
	baseline35 := append(append([]string(nil), baseline34...), ReleaseCompatibilityMobileMigrationName)
	if !policy.allowsAfter(baseline33, ReleaseCompatibilityMigrationName) ||
		policy.allowsAfter(baseline33, ReleaseCompatibilityMobileMigrationName) ||
		policy.allowsAfter(baseline33, ReleaseCompatibilityV1MigrationName) ||
		!policy.allowsAfter(baseline34, ReleaseCompatibilityMobileMigrationName) ||
		policy.allowsAfter(baseline34, ReleaseCompatibilityV1MigrationName) ||
		!policy.allowsAfter(baseline35, ReleaseCompatibilityV1MigrationName) {
		t.Fatal("bridge exceptions must bind to their exact preceding history")
	}
	baseline35[0] = "001_renamed.sql"
	if policy.allowsAfter(baseline35, ReleaseCompatibilityV1MigrationName) {
		t.Fatal("renamed baseline accepted")
	}
	policy35 := policy
	policy35.CompatibleMigrations = append([]CompatibleMigration(nil), policy.CompatibleMigrations[:2]...)
	document35, err := json.Marshal(policy35)
	if err != nil {
		t.Fatal(err)
	}
	historical35, err := ParseReleaseCompatibilityPolicy(document35)
	if err != nil {
		t.Fatal(err)
	}
	if historical35.allows(ReleaseCompatibilityV1MigrationName) || !historical35.allows(ReleaseCompatibilityMobileMigrationName) {
		t.Fatal("reading schema-35 historical policy widened its authority")
	}
	policy.CompatibleMigrations = policy.CompatibleMigrations[:1]
	document, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	historical, err := ParseReleaseCompatibilityPolicy(document)
	if err != nil {
		t.Fatal(err)
	}
	if historical.allows(ReleaseCompatibilityMobileMigrationName) || !historical.allows(ReleaseCompatibilityMigrationName) {
		t.Fatal("reading historical policy widened its authority")
	}
}

func TestMobileCompatibilityPolicyRejectsUnreviewedExtensions(t *testing.T) {
	t.Parallel()
	for _, change := range []struct {
		name  string
		apply func(*CompatibilityPolicy)
	}{
		{"changed mobile hash", func(p *CompatibilityPolicy) { p.CompatibleMigrations[1].SHA256 = ReleaseCompatibilityMigrationSHA256 }},
		{"renamed mobile migration", func(p *CompatibilityPolicy) { p.CompatibleMigrations[1].Name = "035_renamed.sql" }},
		{"future migration", func(p *CompatibilityPolicy) {
			p.CompatibleMigrations = append(p.CompatibleMigrations, CompatibleMigration{Name: "037_future.sql", SHA256: ReleaseCompatibilityV1MigrationSHA256})
		}},
		{"missing historical declaration", func(p *CompatibilityPolicy) { p.CompatibleMigrations = p.CompatibleMigrations[1:] }},
		{"reordered declarations", func(p *CompatibilityPolicy) {
			p.CompatibleMigrations[0], p.CompatibleMigrations[1] = p.CompatibleMigrations[1], p.CompatibleMigrations[0]
		}},
	} {
		t.Run(change.name, func(t *testing.T) {
			policy, err := EmbeddedReleaseCompatibilityPolicy()
			if err != nil {
				t.Fatal(err)
			}
			change.apply(&policy)
			document, err := json.Marshal(policy)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ParseReleaseCompatibilityPolicy(document); !errors.Is(err, ErrInvalidCompatibilityPolicy) {
				t.Fatalf("error=%v, want invalid policy", err)
			}
		})
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

func TestAgentCompatibilityRequiresExactSchema36Bridge(t *testing.T) {
	policy, err := EmbeddedReleaseCompatibilityPolicy()
	if err != nil {
		t.Fatal(err)
	}
	baseline := append([]string(nil), canonicalReleaseCompatibilityBaseline[:]...)
	baseline = append(baseline, ReleaseCompatibilityMigrationName, ReleaseCompatibilityMobileMigrationName, ReleaseCompatibilityV1MigrationName)
	if !policy.allowsAfter(baseline, ReleaseCompatibilityAgentMigrationName) {
		t.Fatal("reviewed schema36 bridge must allow037")
	}
	if policy.allowsAfter(baseline[:len(baseline)-1], ReleaseCompatibilityAgentMigrationName) {
		t.Fatal("schema35 cannot claim037")
	}
	old := policy
	old.CompatibleMigrations = append([]CompatibleMigration(nil), policy.CompatibleMigrations[:3]...)
	if old.allowsAfter(baseline, ReleaseCompatibilityAgentMigrationName) {
		t.Fatal("historical schema36 policy acquired037 authority")
	}
	baseline[0] = "001_renamed.sql"
	if policy.allowsAfter(baseline, ReleaseCompatibilityAgentMigrationName) {
		t.Fatal("renamed baseline acquired037 authority")
	}
}
