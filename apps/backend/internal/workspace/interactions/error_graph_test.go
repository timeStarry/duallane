package interactions

import (
	"errors"
	"testing"
)

type opaqueLeaf struct{}

func (opaqueLeaf) Error() string { return "synthetic unknown leaf" }
func (opaqueLeaf) Unwrap() error { return nil }

type cyclicFailure struct{}

func (e *cyclicFailure) Error() string { return "synthetic cycle" }
func (e *cyclicFailure) Unwrap() error { return e }

func TestInfrastructureClassificationRejectsEmptyAndCyclicErrorGraphs(t *testing.T) {
	for _, failure := range []error{opaqueLeaf{}, errors.Join(NewError("fixture.reject", "Fixture", 400), opaqueLeaf{}), &cyclicFailure{}} {
		if !IsInfrastructureFailure(failure) {
			t.Fatalf("unknown error graph accepted as business rejection: %T", failure)
		}
	}
}
