package storageops

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

var (
	safeIDPattern             = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	canonicalMigrationPattern = regexp.MustCompile(`^[0-9]{3}_[a-z0-9_]+\.sql$`)
)

// ValidateManifest checks all read-only invariants that can be proven without
// a database adapter. It deliberately does not accept a caller-provided
// object key as authoritative: the digest derives the canonical key.
func ValidateManifest(manifest Manifest, now time.Time) ValidationReport {
	report := ValidationReport{
		SchemaReady:      true,
		OwnerReady:       true,
		OwnerFenced:      manifest.Owner.Fenced,
		AdmissionDrained: manifest.Owner.AdmissionDrained,
		BackupReady:      true,
		QuotaReady:       true,
		CASReady:         true,
		ReferencesReady:  true,
		Resources:        len(manifest.Resources),
		Objects:          len(manifest.Objects),
		Quotas:           len(manifest.Quotas),
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	addIssue := func(code, path string) {
		report.Issues = append(report.Issues, Issue{Code: code, Path: path})
	}
	addWarning := func(code, path string) {
		report.Warnings = append(report.Warnings, Issue{Code: code, Path: path})
	}

	if manifest.ContractVersion != ContractVersion {
		addIssue("contract.version_unsupported", "contractVersion")
	}
	if !safeRunID(manifest.RunID) {
		addIssue("contract.run_id_invalid", "runId")
	}
	if err := validateMigrationSet(manifest.Schema); err != nil {
		report.SchemaReady = false
		addIssue(err.code, err.path)
	}

	if !safeID(manifest.Owner.Current) {
		report.OwnerReady = false
		addIssue("owner.current_invalid", "owner.current")
	} else if manifest.Owner.Current != NodeOwner {
		// A future cutover may introduce another owner, but this first slice
		// must never silently claim that Go owns the active Node writer.
		report.OwnerReady = false
		addIssue("owner.current_not_node", "owner.current")
	}
	if !manifest.Owner.Fenced || !manifest.Owner.AdmissionDrained {
		addWarning("owner.fence_required_for_mutation", "owner")
	}

	if strings.TrimSpace(manifest.Backup.ID) == "" {
		report.BackupReady = false
		addWarning("backup.proof_required_for_mutation", "backup.id")
	} else if !safeID(manifest.Backup.ID) {
		report.BackupReady = false
		addIssue("backup.id_invalid", "backup.id")
	}
	if strings.TrimSpace(manifest.Backup.SHA256) == "" {
		report.BackupReady = false
		addWarning("backup.proof_required_for_mutation", "backup.sha256")
	} else if _, err := storage.NormalizeSHA256(manifest.Backup.SHA256); err != nil {
		report.BackupReady = false
		addIssue("backup.sha256_invalid", "backup.sha256")
	}
	if !manifest.Backup.Verified {
		report.BackupReady = false
		addWarning("backup.not_verified", "backup.verified")
	}
	retainUntilValue := strings.TrimSpace(manifest.Backup.RetainUntil)
	if retainUntilValue == "" {
		report.BackupReady = false
		addWarning("backup.proof_required_for_mutation", "backup.retainUntil")
	} else if retainUntil, err := time.Parse(time.RFC3339, retainUntilValue); err != nil {
		report.BackupReady = false
		addIssue("backup.retention_invalid", "backup.retainUntil")
	} else if !retainUntil.After(now) {
		report.BackupReady = false
		addWarning("backup.retention_expired", "backup.retainUntil")
	}

	quotaKeys := make(map[string]struct{}, len(manifest.Quotas))
	for index, quota := range manifest.Quotas {
		path := "quotas[" + itoa(index) + "]"
		if !safeID(quota.SubjectID) {
			report.QuotaReady = false
			addIssue("quota.subject_invalid", path+".subjectId")
		}
		if _, err := time.Parse("2006-01-02", strings.TrimSpace(quota.Day)); err != nil {
			report.QuotaReady = false
			addIssue("quota.day_invalid", path+".day")
		}
		if quota.LimitBytes <= 0 || quota.LimitBytes > storage.DefaultMaxObjectBytes {
			report.QuotaReady = false
			addIssue("quota.limit_invalid", path+".limitBytes")
		}
		if quota.UsedBytes < 0 || quota.ReservedBytes < 0 || quota.UsedBytes > storage.DefaultMaxObjectBytes || quota.ReservedBytes > storage.DefaultMaxObjectBytes {
			report.QuotaReady = false
			addIssue("quota.usage_invalid", path)
		}
		if quota.UsedBytes > quota.LimitBytes || quota.ReservedBytes > quota.LimitBytes-quota.UsedBytes {
			report.QuotaReady = false
			addIssue("quota.over_limit", path)
		}
		key := quota.SubjectID + "\x00" + quota.Day
		if _, exists := quotaKeys[key]; exists {
			report.QuotaReady = false
			addIssue("quota.duplicate_snapshot", path)
		}
		quotaKeys[key] = struct{}{}
	}
	if len(manifest.Quotas) == 0 {
		report.QuotaReady = false
		addWarning("quota.snapshot_required_for_mutation", "quotas")
	}

	objectsByID := make(map[string]CanonicalObject, len(manifest.Objects))
	objectsByDigest := make(map[string]string, len(manifest.Objects))
	objectsByKey := make(map[string]string, len(manifest.Objects))
	for index, object := range manifest.Objects {
		path := "objects[" + itoa(index) + "]"
		if !safeID(object.ID) || !strings.HasPrefix(object.ID, "wso_") {
			report.CASReady = false
			addIssue("cas.object_id_invalid", path+".id")
		}
		digest, err := storage.NormalizeSHA256(object.SHA256)
		if err != nil {
			report.CASReady = false
			addIssue("cas.digest_invalid", path+".sha256")
			digest = ""
		}
		if digest != "" {
			if object.SHA256 != digest {
				report.CASReady = false
				addIssue("cas.digest_not_lowercase", path+".sha256")
			}
			expectedID := "wso_" + digest
			if object.ID != expectedID {
				report.CASReady = false
				addIssue("cas.object_id_digest_mismatch", path+".id")
			}
			expectedKey, keyErr := storage.CanonicalObjectKey(digest)
			if keyErr != nil || strings.TrimSpace(object.ObjectKey) != expectedKey {
				report.CASReady = false
				addIssue("cas.object_key_digest_mismatch", path+".objectKey")
			}
		}
		if object.ByteSize < 0 || object.ByteSize > storage.DefaultMaxObjectBytes {
			report.CASReady = false
			addIssue("cas.byte_size_invalid", path+".byteSize")
		}
		if object.ReferenceCount < 0 {
			report.ReferencesReady = false
			addIssue("refs.count_invalid", path+".referenceCount")
		}
		if _, exists := objectsByID[object.ID]; exists {
			report.CASReady = false
			addIssue("cas.object_id_duplicate", path+".id")
		}
		if digest != "" {
			if _, exists := objectsByDigest[digest]; exists {
				report.CASReady = false
				addIssue("cas.digest_duplicate", path+".sha256")
			}
			objectsByDigest[digest] = object.ID
		}
		if object.ObjectKey != "" {
			if _, exists := objectsByKey[object.ObjectKey]; exists {
				report.CASReady = false
				addIssue("cas.object_key_duplicate", path+".objectKey")
			}
			objectsByKey[object.ObjectKey] = object.ID
		}
		objectsByID[object.ID] = object
	}

	refsByObject := make(map[string]int, len(manifest.Objects))
	resourceKeys := make(map[string]struct{}, len(manifest.Resources))
	logicalBySpace := make(map[string]int64)
	for index, resource := range manifest.Resources {
		path := "resources[" + itoa(index) + "]"
		if !validResourceKind(resource.Kind) {
			report.ReferencesReady = false
			addIssue("refs.kind_invalid", path+".kind")
		}
		if !safeID(resource.ID) {
			report.ReferencesReady = false
			addIssue("refs.resource_id_invalid", path+".id")
		}
		resourceKey := resource.Kind + "\x00" + resource.ID
		if _, exists := resourceKeys[resourceKey]; exists {
			report.ReferencesReady = false
			addIssue("refs.resource_duplicate", path)
		}
		resourceKeys[resourceKey] = struct{}{}
		if resource.StorageObjectID == "" {
			report.ReferencesReady = false
			addIssue("refs.object_missing", path+".storageObjectId")
		} else {
			refsByObject[resource.StorageObjectID]++
			object, exists := objectsByID[resource.StorageObjectID]
			if !exists {
				report.ReferencesReady = false
				addIssue("refs.object_unknown", path+".storageObjectId")
			} else if resource.ByteSize != object.ByteSize {
				report.ReferencesReady = false
				addIssue("refs.byte_size_mismatch", path+".byteSize")
			}
		}
		if resource.ByteSize < 0 || resource.ByteSize > storage.DefaultMaxObjectBytes {
			report.ReferencesReady = false
			addIssue("refs.byte_size_invalid", path+".byteSize")
		}
		if !safeID(resource.OwnerID) {
			report.ReferencesReady = false
			addIssue("refs.owner_id_required", path+".ownerId")
		}
		if resource.Kind == "attachment" {
			if !safeID(resource.SpaceID) {
				report.ReferencesReady = false
				addIssue("refs.space_id_required", path+".spaceId")
			}
			if resource.ByteSize > 0 && resource.SpaceID != "" {
				if logicalBySpace[resource.SpaceID] > maxInt64-resource.ByteSize {
					report.ReferencesReady = false
					addIssue("refs.logical_bytes_overflow", path+".byteSize")
				} else {
					logicalBySpace[resource.SpaceID] += resource.ByteSize
				}
			}
		}
		if resource.LegacyStorageKey != "" && !safeLegacyKey(resource.LegacyStorageKey) {
			report.ReferencesReady = false
			addIssue("refs.legacy_key_invalid", path+".legacyStorageKey")
		}
		if resource.ByteSize >= 0 && report.LogicalBytes <= maxInt64-resource.ByteSize {
			report.LogicalBytes += resource.ByteSize
		} else {
			report.ReferencesReady = false
			addIssue("refs.logical_bytes_overflow", "resources")
		}
	}
	for index, object := range manifest.Objects {
		path := "objects[" + itoa(index) + "]"
		actual := refsByObject[object.ID]
		if actual != object.ReferenceCount {
			report.ReferencesReady = false
			addIssue("refs.count_mismatch", path+".referenceCount")
		}
		if object.Deleted && actual != 0 {
			report.ReferencesReady = false
			addIssue("refs.deleted_object_referenced", path)
		}
		if !object.Deleted && actual == 0 {
			report.ReferencesReady = false
			addIssue("refs.unreferenced_active_object", path)
		}
		if !object.Deleted {
			if report.UniqueBytes <= maxInt64-object.ByteSize {
				report.UniqueBytes += object.ByteSize
			} else {
				report.CASReady = false
				addIssue("cas.unique_bytes_overflow", path+".byteSize")
			}
		}
	}

	report.ReadOnlyReady = len(report.Issues) == 0
	// Manifest assertions are observations, not proof of a live exclusive fence.
	// Only the separately acquired runtime mutation guard may authorize writes.
	report.MutationReady = false
	addWarning("owner.runtime_fence_unverified", "owner")
	sortIssues(report.Issues)
	sortIssues(report.Warnings)
	return report
}

func validateMigrationSet(schema SchemaSnapshot) *validationIssue {
	if len(schema.Expected) == 0 || len(schema.Applied) == 0 {
		return &validationIssue{code: "schema.migration_set_missing", path: "schema"}
	}
	if !contains(schema.Expected, CanonicalStorageMigration) || !contains(schema.Applied, CanonicalStorageMigration) {
		return &validationIssue{code: "schema.025_missing", path: "schema"}
	}
	expected := make(map[string]struct{}, len(schema.Expected))
	for _, name := range schema.Expected {
		if !canonicalMigrationPattern.MatchString(name) {
			return &validationIssue{code: "schema.migration_name_invalid", path: "schema.expected"}
		}
		if _, exists := expected[name]; exists {
			return &validationIssue{code: "schema.expected_duplicate", path: "schema.expected"}
		}
		expected[name] = struct{}{}
	}
	applied := make(map[string]struct{}, len(schema.Applied))
	for _, name := range schema.Applied {
		if !canonicalMigrationPattern.MatchString(name) {
			return &validationIssue{code: "schema.migration_name_invalid", path: "schema.applied"}
		}
		if _, exists := applied[name]; exists {
			return &validationIssue{code: "schema.applied_duplicate", path: "schema.applied"}
		}
		applied[name] = struct{}{}
	}
	if len(expected) != len(applied) {
		return &validationIssue{code: "schema.migration_set_mismatch", path: "schema"}
	}
	for name := range expected {
		if _, exists := applied[name]; !exists {
			return &validationIssue{code: "schema.migration_set_mismatch", path: "schema"}
		}
	}
	return nil
}

type validationIssue struct {
	code string
	path string
}

func validResourceKind(kind string) bool {
	return kind == "attachment" || kind == "avatar" || kind == "customEmote"
}

func safeRunID(value string) bool {
	return len(value) >= 8 && len(value) <= 64 && safeIDPattern.MatchString(value)
}

func safeID(value string) bool {
	return safeIDPattern.MatchString(value)
}

func safeLegacyKey(value string) bool {
	if strings.TrimSpace(value) == "" || strings.ContainsRune(value, '\x00') || strings.ContainsAny(value, "\r\n") {
		return false
	}
	normalized := strings.ReplaceAll(value, "\\", "/")
	if strings.HasPrefix(normalized, "/") || (len(normalized) >= 2 && normalized[1] == ':') {
		return false
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == ".." {
			return false
		}
	}
	return true
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func sortIssues(issues []Issue) {
	sort.Slice(issues, func(i, j int) bool {
		if issues[i].Path == issues[j].Path {
			return issues[i].Code < issues[j].Code
		}
		return issues[i].Path < issues[j].Path
	})
}

func itoa(value int) string {
	return strconv.Itoa(value)
}

const maxInt64 = int64(^uint64(0) >> 1)
