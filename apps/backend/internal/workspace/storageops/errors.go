package storageops

import "strings"

// Issue is a safe, deterministic diagnostic. Path values refer only to
// manifest fields and never contain provider responses or filesystem paths.
type Issue struct {
	Code string `json:"code"`
	Path string `json:"path"`
}

// ValidationReport separates structural read-only validity from the stronger
// gates required by a future mutating operation.
type ValidationReport struct {
	ReadOnlyReady    bool    `json:"readOnlyReady"`
	MutationReady    bool    `json:"mutationReady"`
	SchemaReady      bool    `json:"schemaReady"`
	OwnerReady       bool    `json:"ownerReady"`
	OwnerFenced      bool    `json:"ownerFenced"`
	AdmissionDrained bool    `json:"admissionDrained"`
	BackupReady      bool    `json:"backupReady"`
	QuotaReady       bool    `json:"quotaReady"`
	CASReady         bool    `json:"casReady"`
	ReferencesReady  bool    `json:"referencesReady"`
	Resources        int     `json:"resources"`
	Objects          int     `json:"objects"`
	Quotas           int     `json:"quotas"`
	LogicalBytes     int64   `json:"logicalBytes"`
	UniqueBytes      int64   `json:"uniqueBytes"`
	Issues           []Issue `json:"issues,omitempty"`
	Warnings         []Issue `json:"warnings,omitempty"`
}

// ContractError reports only stable safe codes. Callers can inspect the
// report returned by the operation for the individual field paths.
type ContractError struct {
	Code string
}

func (e *ContractError) Error() string {
	if e == nil || strings.TrimSpace(e.Code) == "" {
		return "storage operator contract failed"
	}
	return e.Code
}

var (
	ErrInvalidManifest = &ContractError{Code: "storageops.manifest_invalid"}
	ErrVerifyFailed    = &ContractError{Code: "storageops.verify_failed"}
	ErrReadOnlyTarget  = &ContractError{Code: "storageops.read_only_target_required"}
	ErrSnapshotFailed  = &ContractError{Code: "storageops.snapshot_failed"}
)
