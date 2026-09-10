package migrations

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	ReleaseCompatibilityPolicyVersion   = 1
	ReleaseCompatibilityBaseMigration   = "033_workspace_command_result_finalization.sql"
	ReleaseCompatibilityMigrationName   = "034_workspace_chat_auto_hide.sql"
	ReleaseCompatibilityMigrationSHA256 = "b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb"

	maxReleaseCompatibilityPolicyBytes = 16 << 10
	maxReleaseCompatibilityJSONDepth   = 32
)

var (
	// ErrInvalidCompatibilityPolicy means the embedded policy is not the
	// reviewed policy shape for this release.
	ErrInvalidCompatibilityPolicy = errors.New("invalid release compatibility policy")

	// The compatibility exception is deliberately tied to the exact canonical
	// 001-033 baseline. A caller cannot opt into a similarly numbered or renamed
	// history by supplying RequiredNames.
	canonicalReleaseCompatibilityBaseline = [...]string{
		"001_initial.sql",
		"002_member_visibility.sql",
		"003_message_reactions.sql",
		"004_workspace_profiles.sql",
		"005_workspace_email_settings.sql",
		"006_workspace_email_jobs.sql",
		"007_profile_discovery_and_avatars.sql",
		"008_conversation_pinned_messages.sql",
		"009_workspace_ntfy.sql",
		"010_workspace_uploads_and_emotes.sql",
		"011_group_avatar_emoji.sql",
		"012_message_recall.sql",
		"013_emote_collections.sql",
		"014_message_hidden_states.sql",
		"015_workspace_emote_direct_send.sql",
		"016_workspace_agent_bots.sql",
		"017_echo_requirements.sql",
		"018_workspace_topics.sql",
		"019_workspace_interactions.sql",
		"020_workspace_agent_bot_gateway.sql",
		"021_echo_complete.sql",
		"022_workspace_topic_messages.sql",
		"023_workspace_unified_bot_cards.sql",
		"024_workspace_workflow_safety.sql",
		"025_workspace_content_addressed_storage.sql",
		"026_emote_collection_subscriptions.sql",
		"027_echo_release_broadcasts.sql",
		"028_workspace_reply_preferences.sql",
		"029_workspace_agent_bot_setup_sessions.sql",
		"030_workspace_event_notifications.sql",
		"031_workspace_presence_leases.sql",
		"032_workspace_storage_operator_runs.sql",
		ReleaseCompatibilityBaseMigration,
	}
)

//go:embed compatibility.json
var embeddedReleaseCompatibilityPolicy string

// CompatibilityPolicy is the bounded, reviewed exception used by read-only
// release preflight checks. Its fields are intentionally explicit so no
// environment value or wildcard can extend the allow-list.
type CompatibilityPolicy struct {
	Version              int                   `json:"version"`
	BaseMigration        string                `json:"baseMigration"`
	CompatibleMigrations []CompatibleMigration `json:"compatibleMigrations"`
}

type CompatibleMigration struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

// EmbeddedReleaseCompatibilityPolicy parses the immutable policy compiled
// into this package. A parse failure is returned to the caller rather than
// silently disabling or widening compatibility.
func EmbeddedReleaseCompatibilityPolicy() (CompatibilityPolicy, error) {
	return ParseReleaseCompatibilityPolicy([]byte(embeddedReleaseCompatibilityPolicy))
}

// ParseReleaseCompatibilityPolicy strictly parses and validates a policy.
// This is exported so tests and release tooling can validate candidate policy
// bytes without modifying the embedded source.
func ParseReleaseCompatibilityPolicy(data []byte) (CompatibilityPolicy, error) {
	var policy CompatibilityPolicy
	if len(data) == 0 || len(data) > maxReleaseCompatibilityPolicyBytes {
		return policy, fmt.Errorf("%w: policy size is outside the bounded limit", ErrInvalidCompatibilityPolicy)
	}
	if err := rejectDuplicateJSONMembers(data); err != nil {
		return policy, fmt.Errorf("%w: policy JSON is invalid", ErrInvalidCompatibilityPolicy)
	}

	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil || root == nil {
		return policy, fmt.Errorf("%w: policy root must be an object", ErrInvalidCompatibilityPolicy)
	}
	if err := requireExactJSONFields(root, "version", "baseMigration", "compatibleMigrations"); err != nil {
		return policy, err
	}
	if err := json.Unmarshal(root["version"], &policy.Version); err != nil {
		return policy, invalidPolicyField("version")
	}
	if err := json.Unmarshal(root["baseMigration"], &policy.BaseMigration); err != nil {
		return policy, invalidPolicyField("baseMigration")
	}
	var rawMigrations []json.RawMessage
	if err := json.Unmarshal(root["compatibleMigrations"], &rawMigrations); err != nil {
		return policy, invalidPolicyField("compatibleMigrations")
	}
	policy.CompatibleMigrations = make([]CompatibleMigration, 0, len(rawMigrations))
	for _, rawMigration := range rawMigrations {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(rawMigration, &fields); err != nil || fields == nil {
			return policy, fmt.Errorf("%w: compatible migration must be an object", ErrInvalidCompatibilityPolicy)
		}
		if err := requireExactJSONFields(fields, "name", "sha256"); err != nil {
			return policy, err
		}
		var migration CompatibleMigration
		if err := json.Unmarshal(fields["name"], &migration.Name); err != nil {
			return policy, invalidPolicyField("compatibleMigrations.name")
		}
		if err := json.Unmarshal(fields["sha256"], &migration.SHA256); err != nil {
			return policy, invalidPolicyField("compatibleMigrations.sha256")
		}
		policy.CompatibleMigrations = append(policy.CompatibleMigrations, migration)
	}
	if err := validateReleaseCompatibilityPolicy(policy); err != nil {
		return CompatibilityPolicy{}, err
	}
	return policy, nil
}

func validateReleaseCompatibilityPolicy(policy CompatibilityPolicy) error {
	if policy.Version != ReleaseCompatibilityPolicyVersion {
		return fmt.Errorf("%w: unsupported policy version", ErrInvalidCompatibilityPolicy)
	}
	if policy.BaseMigration != ReleaseCompatibilityBaseMigration || !IsCanonicalName(policy.BaseMigration) {
		return fmt.Errorf("%w: base migration is not the reviewed canonical baseline", ErrInvalidCompatibilityPolicy)
	}
	if len(policy.CompatibleMigrations) != 1 {
		return fmt.Errorf("%w: compatibility allow-list must contain exactly one migration", ErrInvalidCompatibilityPolicy)
	}
	seen := make(map[string]struct{}, len(policy.CompatibleMigrations))
	for _, migration := range policy.CompatibleMigrations {
		if _, exists := seen[migration.Name]; exists {
			return fmt.Errorf("%w: compatible migration names are duplicated", ErrInvalidCompatibilityPolicy)
		}
		seen[migration.Name] = struct{}{}
		if !IsCanonicalName(migration.Name) || migration.Name != ReleaseCompatibilityMigrationName {
			return fmt.Errorf("%w: compatible migration name is not reviewed", ErrInvalidCompatibilityPolicy)
		}
		if len(migration.SHA256) != sha256.Size*2 || migration.SHA256 != strings.ToLower(migration.SHA256) {
			return fmt.Errorf("%w: compatible migration SHA-256 has an invalid format", ErrInvalidCompatibilityPolicy)
		}
		for _, character := range migration.SHA256 {
			if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
				return fmt.Errorf("%w: compatible migration SHA-256 has an invalid format", ErrInvalidCompatibilityPolicy)
			}
		}
		if migration.SHA256 != ReleaseCompatibilityMigrationSHA256 {
			return fmt.Errorf("%w: compatible migration SHA-256 is not reviewed", ErrInvalidCompatibilityPolicy)
		}
	}
	return nil
}

func requireExactJSONFields(fields map[string]json.RawMessage, expected ...string) error {
	expectedSet := make(map[string]struct{}, len(expected))
	for _, field := range expected {
		expectedSet[field] = struct{}{}
	}
	if len(fields) != len(expectedSet) {
		return fmt.Errorf("%w: policy contains unknown or missing fields", ErrInvalidCompatibilityPolicy)
	}
	for field := range fields {
		if _, ok := expectedSet[field]; !ok {
			return fmt.Errorf("%w: policy contains unknown field", ErrInvalidCompatibilityPolicy)
		}
	}
	return nil
}

func invalidPolicyField(field string) error {
	return fmt.Errorf("%w: policy field %s has an invalid type", ErrInvalidCompatibilityPolicy, field)
}

func (policy CompatibilityPolicy) allows(name string) bool {
	for _, migration := range policy.CompatibleMigrations {
		if migration.Name == name {
			return true
		}
	}
	return false
}

func isCanonicalReleaseCompatibilityBaseline(required []string) bool {
	if len(required) != len(canonicalReleaseCompatibilityBaseline) {
		return false
	}
	for index, name := range canonicalReleaseCompatibilityBaseline {
		if required[index] != name {
			return false
		}
	}
	return required[len(required)-1] == ReleaseCompatibilityBaseMigration
}

func rejectDuplicateJSONMembers(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := walkJSONValue(decoder, 0); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("multiple top-level JSON values")
		}
		return err
	}
	return nil
}

func walkJSONValue(decoder *json.Decoder, depth int) error {
	if depth > maxReleaseCompatibilityJSONDepth {
		return errors.New("JSON nesting is too deep")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("object key is not a string")
			}
			if _, exists := seen[key]; exists {
				return errors.New("duplicate object key")
			}
			seen[key] = struct{}{}
			if err := walkJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return err
		}
		if end != json.Delim('}') {
			return errors.New("object is not closed")
		}
	case '[':
		for decoder.More() {
			if err := walkJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return err
		}
		if end != json.Delim(']') {
			return errors.New("array is not closed")
		}
	default:
		return errors.New("unexpected JSON delimiter")
	}
	return nil
}
