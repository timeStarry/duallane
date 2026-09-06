package automation

import (
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

func TestDomainInfrastructureWithoutCauseStillRollsBackAfterAdaptation(t *testing.T) {
	failure := requirements.NewError("fixture.infrastructure", "Unavailable", 503)
	adapted := publicDomainError(failure)
	if !interactions.IsInfrastructureFailure(adapted) {
		t.Fatal("domain 503 without cause became a commit-safe rejection")
	}
	var nilFailure *requirements.Error
	if !hasInfrastructureLeaf(nilFailure, 0) {
		t.Fatal("typed-nil domain error accepted")
	}
}
