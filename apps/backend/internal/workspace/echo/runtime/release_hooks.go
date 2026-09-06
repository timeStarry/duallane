package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

const releasePostCommitTimeout = 30 * time.Second

var releaseCountFields = [...]string{
	"recipientCount",
	"pendingCount",
	"sentCount",
	"failedCount",
	"skippedCount",
}

// Finalizer is an optional post-commit result freezer. Runtime adapters pass
// the original command input and outcome so interactions, rather than the
// runtime, owns request-hash and authorization binding.
type Finalizer interface {
	FinalizeCommandResult(context.Context, interactions.FinalizeCommandResultInput) (interactions.CommandOutcome, error)
}

// PublicationReader reads the authoritative all-recipient release summary.
// It is intentionally separate from DeliveryHooks: a delivery batch result
// is not a publication count and must never be used as one.
type PublicationReader interface {
	GetPublication(context.Context, string) (*releases.PublicationSummary, error)
}

func isReleaseResult(result any) bool {
	object, ok := result.(map[string]any)
	if !ok {
		return false
	}
	typeName, ok := object["type"].(string)
	return ok && typeName == "release-published"
}

func (s InteractionHooks) finalizeReleaseCommand(ctx context.Context, input interactions.ExecuteCommandInput, original interactions.CommandOutcome) interactions.CommandOutcome {
	if original.ResultFinalized || s.Delivery == nil || ctx == nil {
		return original
	}
	object, ok := original.Result.(map[string]any)
	if !ok {
		return original
	}
	version, ok := object["version"].(string)
	version = strings.TrimSpace(version)
	if !ok || version == "" {
		return original
	}

	postCommitCtx, cancel := context.WithTimeout(ctx, releasePostCommitTimeout)
	defer cancel()
	meta := input.Request.Meta.Safe()
	if _, err := s.Delivery.SyncRelease(postCommitCtx, delivery.SyncInput{SpaceID: s.SpaceID, Version: version, Meta: meta}); err != nil {
		return original
	}
	if s.PublicationReader == nil || s.Finalizer == nil {
		return original
	}
	summary, err := s.PublicationReader.GetPublication(postCommitCtx, version)
	if err != nil || !validReleasePublicationSummary(summary, version) {
		return original
	}
	merged, err := mergeReleaseCounts(object, summary)
	if err != nil {
		return original
	}
	frozen, err := s.Finalizer.FinalizeCommandResult(postCommitCtx, interactions.FinalizeCommandResultInput{Execution: input, Original: original, Result: merged})
	if err != nil || !frozen.OK || !frozen.ResultFinalized || frozen.Replayed != original.Replayed || !sameStringPointer(frozen.ResultCardID, original.ResultCardID) || !sameReleaseNonCountFields(original.Result, frozen.Result) || !validReleaseResultCounts(frozen.Result) {
		return original
	}
	return frozen
}

func validReleasePublicationSummary(summary *releases.PublicationSummary, version string) bool {
	if summary == nil || strings.TrimSpace(summary.ID) == "" || strings.TrimSpace(summary.Version) != version {
		return false
	}
	recipient, ok := safeReleaseResultCount(summary.RecipientCount)
	if !ok {
		return false
	}
	counts := [...]int64{summary.PendingCount, summary.SentCount, summary.FailedCount, summary.SkippedCount}
	var total uint64
	for _, count := range counts {
		unsigned, ok := safeReleaseResultCount(count)
		if !ok || unsigned > ^uint64(0)-total {
			return false
		}
		total += unsigned
	}
	return total == recipient
}

func mergeReleaseCounts(original map[string]any, summary *releases.PublicationSummary) (map[string]any, error) {
	if !validReleasePublicationSummary(summary, strings.TrimSpace(stringValue(original["version"]))) {
		return nil, errors.New("release publication summary does not match result")
	}
	merged := make(map[string]any, len(original)+len(releaseCountFields))
	for key, value := range original {
		merged[key] = value
	}
	merged["recipientCount"] = summary.RecipientCount
	merged["pendingCount"] = summary.PendingCount
	merged["sentCount"] = summary.SentCount
	merged["failedCount"] = summary.FailedCount
	merged["skippedCount"] = summary.SkippedCount
	return merged, nil
}

func sameReleaseNonCountFields(before, after any) bool {
	left, leftOK := before.(map[string]any)
	right, rightOK := after.(map[string]any)
	if !leftOK || !rightOK {
		return false
	}
	leftJSON := releaseNonCountJSON(left)
	rightJSON := releaseNonCountJSON(right)
	return bytes.Equal(leftJSON, rightJSON)
}

func releaseNonCountJSON(object map[string]any) []byte {
	copy := make(map[string]any, len(object))
	for key, value := range object {
		if !isReleaseCountField(key) {
			copy[key] = value
		}
	}
	encoded, err := json.Marshal(copy)
	if err != nil {
		return nil
	}
	return encoded
}

// validReleaseResultCounts validates the authoritative result returned by the
// finalizer. It must not compare counts with the summary read by this caller:
// another concurrent finalizer may have frozen a different valid snapshot
// first, and that persisted result is the stable replay contract.
func validReleaseResultCounts(result any) bool {
	object, ok := result.(map[string]any)
	if !ok || !isReleaseResult(object) {
		return false
	}
	recipient, ok := safeReleaseResultCount(object[releaseCountFields[0]])
	if !ok {
		return false
	}
	var total uint64
	for _, field := range releaseCountFields[1:] {
		count, ok := safeReleaseResultCount(object[field])
		if !ok || count > ^uint64(0)-total {
			return false
		}
		total += count
	}
	return total == recipient
}

func safeReleaseResultCount(value any) (uint64, bool) {
	const maxCount = uint64(9007199254740991)
	switch typed := value.(type) {
	case int:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case int8:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case int16:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case int32:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case int64:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint:
		if uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint8:
		if uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint16:
		if uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint32:
		if uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint64:
		if typed > maxCount {
			return 0, false
		}
		return typed, true
	case float32:
		return safeReleaseResultFloat(float64(typed), maxCount)
	case float64:
		return safeReleaseResultFloat(typed, maxCount)
	case json.Number:
		parsed, err := strconv.ParseUint(string(typed), 10, 53)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func safeReleaseResultFloat(value float64, maxCount uint64) (uint64, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || math.Trunc(value) != value || value > float64(maxCount) {
		return 0, false
	}
	return uint64(value), true
}

func isReleaseCountField(key string) bool {
	for _, field := range releaseCountFields {
		if key == field {
			return true
		}
	}
	return false
}

func sameStringPointer(left, right *string) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}
