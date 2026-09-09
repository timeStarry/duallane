// Package storageops contains safe, bounded storage-operator contracts.
//
// The operator surface is deliberately read-only. It validates a private
// operator manifest, can snapshot the catalog through a typed PostgreSQL
// adapter, and verifies canonical bytes without changing PostgreSQL or object
// storage. All mutating phases remain separate integrations.
package storageops

const (
	ContractVersion           = 1
	CanonicalStorageMigration = "025_workspace_content_addressed_storage.sql"
	NodeOwner                 = "node"
)

// Manifest is the private, content-free operator snapshot exchanged between
// a future typed database adapter and this package. It is not an HTTP or
// user-facing response.
type Manifest struct {
	ContractVersion int               `json:"contractVersion"`
	RunID           string            `json:"runId"`
	Schema          SchemaSnapshot    `json:"schema"`
	Owner           OwnerSnapshot     `json:"owner"`
	Backup          BackupProof       `json:"backup"`
	Quotas          []QuotaSnapshot   `json:"quotas"`
	Resources       []ResourceRef     `json:"resources"`
	Objects         []CanonicalObject `json:"objects"`
}

// SchemaSnapshot is the exact numbered migration set observed by the
// operator. Both lists are required so a manifest cannot silently omit an
// applied or required migration.
type SchemaSnapshot struct {
	Expected []string `json:"expected"`
	Applied  []string `json:"applied"`
}

// OwnerSnapshot records the current writer owner and the fencing state needed
// before a future mutating phase. Read-only plan/verify do not require the
// active Node owner to be fenced.
type OwnerSnapshot struct {
	Current          string `json:"current"`
	Fenced           bool   `json:"fenced"`
	AdmissionDrained bool   `json:"admissionDrained"`
}

// BackupProof is an operator-supplied proof that the coordinated database and
// object backup is restorable and retained through the rollback window.
type BackupProof struct {
	ID          string `json:"id"`
	SHA256      string `json:"sha256"`
	Verified    bool   `json:"verified"`
	RetainUntil string `json:"retainUntil"`
}

// QuotaSnapshot is read-only quota evidence. Storage verification never
// changes quota ledgers; mutating phases must compare before/after snapshots
// through a parent-owned typed repository.
type QuotaSnapshot struct {
	SubjectID     string `json:"subjectId"`
	Day           string `json:"day"`
	LimitBytes    int64  `json:"limitBytes"`
	UsedBytes     int64  `json:"usedBytes"`
	ReservedBytes int64  `json:"reservedBytes"`
}

// ResourceRef is one logical Workspace resource reference. Kind matches the
// three 025 registry reference columns and is intentionally explicit.
type ResourceRef struct {
	Kind             string `json:"kind"`
	ID               string `json:"id"`
	SpaceID          string `json:"spaceId"`
	OwnerID          string `json:"ownerId"`
	StorageObjectID  string `json:"storageObjectId"`
	ByteSize         int64  `json:"byteSize"`
	LegacyStorageKey string `json:"legacyStorageKey,omitempty"`
}

// CanonicalObject is one active or tombstoned row from
// workspace_storage_objects plus a read-only reference count computed across
// attachments, users, and workspace_custom_emotes.
type CanonicalObject struct {
	ID             string `json:"id"`
	SHA256         string `json:"sha256"`
	ObjectKey      string `json:"objectKey"`
	ByteSize       int64  `json:"byteSize"`
	ReferenceCount int    `json:"referenceCount"`
	Deleted        bool   `json:"deleted"`
}

// PlannedAction contains metadata only; it never authorizes or executes a
// mutation.
type PlannedAction struct {
	Action string `json:"action"`
	Kind   string `json:"kind"`
	ID     string `json:"id"`
}

// PlanReport is stable JSON intended for private operator review and CI.
type PlanReport struct {
	Command             string           `json:"command"`
	Operation           string           `json:"operation"`
	Status              string           `json:"status"`
	ReadOnly            bool             `json:"readOnly"`
	ApplyRequired       bool             `json:"applyRequired"`
	RunID               string           `json:"runId"`
	ManifestFingerprint string           `json:"manifestFingerprint"`
	Validation          ValidationReport `json:"validation"`
	Actions             []PlannedAction  `json:"actions"`
}

// VerifyReport contains counts and safe issue codes only. It never includes
// provider errors, credentials, original names, signed URLs, or raw paths.
type VerifyReport struct {
	Command             string           `json:"command"`
	Status              string           `json:"status"`
	ReadOnly            bool             `json:"readOnly"`
	Mutations           int              `json:"mutations"`
	RunID               string           `json:"runId"`
	ManifestFingerprint string           `json:"manifestFingerprint"`
	Validation          ValidationReport `json:"validation"`
	ObjectsScanned      int              `json:"objectsScanned"`
	ObjectsVerified     int              `json:"objectsVerified"`
	ObjectsSkipped      int              `json:"objectsSkipped"`
	VerifiedBytes       int64            `json:"verifiedBytes"`
	Failures            int              `json:"failures"`
}
