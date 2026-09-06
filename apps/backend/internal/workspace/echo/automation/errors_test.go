package automation

import (
	"errors"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

func TestPublicDomainErrorPreservesJoinedInfrastructure(t *testing.T) {
	rejection := requirements.NewError("echo.rejected", "rejected", 422)
	direct := publicDomainError(rejection)
	var interactionErr *interactions.Error
	if !errors.As(direct, &interactionErr) || interactionErr == nil || interactionErr.Code != rejection.Code {
		t.Fatalf("direct domain rejection conversion = %v (%T)", direct, direct)
	}
	if interactions.IsInfrastructureFailure(direct) {
		t.Fatal("direct domain 4xx was classified as infrastructure")
	}

	joined := publicDomainError(errors.Join(rejection, errors.New("savepoint release failed")))
	if !interactions.IsInfrastructureFailure(joined) {
		t.Fatalf("joined domain/infrastructure error was not preserved: %v", joined)
	}
	var leaked *interactions.Error
	if errors.As(joined, &leaked) {
		t.Fatalf("joined infrastructure exposed a converted 4xx: %#v", leaked)
	}
}

func TestDomainRejectionMarkersFailClosedWhenJoinedWithInfrastructure(t *testing.T) {
	cases := []struct {
		name   string
		marker error
		match  func(error) bool
	}{
		{
			name:   "requirement",
			marker: &requirements.TransactionRejection{Err: requirements.NewError("echo.rejected", "rejected", 422)},
			match: func(err error) bool {
				_, ok := asRequirementRejection(err)
				return ok
			},
		},
		{
			name:   "solicitation",
			marker: &solicitations.TransactionRejection{Err: solicitations.NewError("echo.rejected", "rejected", 422)},
			match: func(err error) bool {
				_, ok := asSolicitationRejection(err)
				return ok
			},
		},
		{
			name:   "release",
			marker: &releases.TransactionRejection{Err: releases.NewError("echo.rejected", "rejected", 422)},
			match: func(err error) bool {
				_, ok := asReleaseRejection(err)
				return ok
			},
		},
		{
			name:   "interaction",
			marker: &interactions.TransactionRejection{Err: interactions.NewError("echo.rejected", "rejected", 422)},
			match: func(err error) bool {
				_, ok := asInteractionRejection(err)
				return ok
			},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if !test.match(test.marker) {
				t.Fatal("plain rejection marker was not recognized")
			}
			joined := errors.Join(test.marker, errors.New("unknown infrastructure failure"))
			if test.match(joined) {
				t.Fatal("rejection marker survived an infrastructure sibling")
			}
			if !interactions.IsInfrastructureFailure(publicDomainError(joined)) {
				t.Fatal("joined marker/infrastructure error was not rollback-classified")
			}
		})
	}
}
