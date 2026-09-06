package interactions

import (
	"encoding/json"
	"strconv"
	"testing"
)

func TestSafeReleaseFinalizationCountUsesJavaScriptSafeIntegerBoundary(t *testing.T) {
	const max = uint64(9007199254740991)
	tests := []struct {
		name  string
		value any
		want  bool
	}{
		{name: "int max", value: int(max), want: true},
		{name: "int64 max", value: int64(max), want: true},
		{name: "uint max", value: uint(max), want: true},
		{name: "uint64 max", value: uint64(max), want: true},
		{name: "float64 max", value: float64(max), want: true},
		{name: "json number max", value: json.Number(strconv.FormatUint(max, 10)), want: true},
		{name: "int over", value: int(max + 1), want: false},
		{name: "int64 over", value: int64(max + 1), want: false},
		{name: "uint over", value: uint(max + 1), want: false},
		{name: "uint64 over", value: uint64(max + 1), want: false},
		{name: "float64 over", value: float64(max + 1), want: false},
		{name: "json number over", value: json.Number(strconv.FormatUint(max+1, 10)), want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, got := safeReleaseFinalizationCount(test.value)
			if got != test.want {
				t.Fatalf("safeReleaseFinalizationCount(%#v) = %v, want %v", test.value, got, test.want)
			}
		})
	}
}

func TestReleaseFinalizationCountsApplyBoundaryToEveryField(t *testing.T) {
	const max = int64(9007199254740991)
	for _, field := range releaseFinalizationCountFields {
		t.Run(field, func(t *testing.T) {
			valid := releaseFinalizationBoundaryObject(field, max)
			if !validReleaseFinalizationCounts(valid) {
				t.Fatalf("valid boundary counts for %s rejected: %#v", field, valid)
			}
			over := releaseFinalizationBoundaryObject(field, max+1)
			if validReleaseFinalizationCounts(over) {
				t.Fatalf("over-boundary counts for %s accepted: %#v", field, over)
			}
		})
	}
}

func releaseFinalizationBoundaryObject(field string, value int64) map[string]any {
	result := map[string]any{
		"recipientCount": int64(0),
		"pendingCount":   int64(0),
		"sentCount":      int64(0),
		"failedCount":    int64(0),
		"skippedCount":   int64(0),
	}
	result[field] = value
	if field == "recipientCount" {
		result["sentCount"] = value
	} else {
		result["recipientCount"] = value
	}
	return result
}
