package storageops

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// PlanOptions controls the read-only planning phase. Mutation modes need
// parent-owned database, owner-fence, and backup adapters and are intentionally
// not accepted by this package.
type PlanOptions struct {
	Operation string
	Now       time.Time
}

// BuildPlan validates a manifest and produces a deterministic physical-read
// plan. It does not open a database, create a store, or touch an object.
func BuildPlan(manifest Manifest, options PlanOptions) (PlanReport, error) {
	operation := options.Operation
	if operation == "" {
		operation = "verify"
	}
	if operation != "verify" {
		return PlanReport{}, fmt.Errorf("%w: operation is unavailable", ErrReadOnlyTarget)
	}
	validation := ValidateManifest(manifest, options.Now)
	report := PlanReport{
		Command:             "plan",
		Operation:           operation,
		Status:              "ready",
		ReadOnly:            true,
		ApplyRequired:       false,
		RunID:               manifest.RunID,
		ManifestFingerprint: manifestFingerprint(manifest),
		Validation:          validation,
		Actions:             make([]PlannedAction, 0, len(manifest.Objects)),
	}
	if !validation.ReadOnlyReady {
		report.Status = "blocked"
	}
	for _, object := range sortedObjects(manifest.Objects) {
		if object.Deleted {
			continue
		}
		report.Actions = append(report.Actions, PlannedAction{
			Action: "verify_canonical",
			Kind:   "object",
			ID:     object.ID,
		})
	}
	return report, nil
}

func manifestFingerprint(manifest Manifest) string {
	canonical := manifest
	canonical.Schema.Expected = append([]string(nil), manifest.Schema.Expected...)
	canonical.Schema.Applied = append([]string(nil), manifest.Schema.Applied...)
	canonical.Quotas = append([]QuotaSnapshot(nil), manifest.Quotas...)
	canonical.Resources = append([]ResourceRef(nil), manifest.Resources...)
	canonical.Objects = append([]CanonicalObject(nil), manifest.Objects...)
	sort.Strings(canonical.Schema.Expected)
	sort.Strings(canonical.Schema.Applied)
	sort.Slice(canonical.Quotas, func(i, j int) bool {
		left := canonical.Quotas[i].SubjectID + "\x00" + canonical.Quotas[i].Day
		right := canonical.Quotas[j].SubjectID + "\x00" + canonical.Quotas[j].Day
		return left < right
	})
	sort.Slice(canonical.Resources, func(i, j int) bool {
		left := canonical.Resources[i].Kind + "\x00" + canonical.Resources[i].ID
		right := canonical.Resources[j].Kind + "\x00" + canonical.Resources[j].ID
		return left < right
	})
	sort.Slice(canonical.Objects, func(i, j int) bool {
		return canonical.Objects[i].ID < canonical.Objects[j].ID
	})
	data, err := json.Marshal(canonical)
	if err != nil {
		// All fields are concrete JSON values; keep a stable failure value if
		// a future field makes that assumption false.
		return ""
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func sortedObjects(objects []CanonicalObject) []CanonicalObject {
	result := append([]CanonicalObject(nil), objects...)
	sort.Slice(result, func(i, j int) bool {
		return result[i].ID < result[j].ID
	})
	return result
}
