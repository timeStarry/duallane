package runtime

import (
	"context"
	"errors"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
)

type releaseReaderFunc func(context.Context, releases.ProjectCardInput) (*releases.CardProjection, error)

func (f releaseReaderFunc) ProjectCard(ctx context.Context, input releases.ProjectCardInput) (*releases.CardProjection, error) {
	return f(ctx, input)
}

func TestReleaseProjectorPreservesRecipientAndPublicationBoundary(t *testing.T) {
	input := delivery.ReleaseProjectInput{ActorID: "recipient", SpaceID: "space", Version: "1.2.3", PublicationID: "publication"}
	want := releases.CardProjection{Block: releases.CardBlock{Type: "card", CardID: "release", CardType: releases.CardType, SchemaVersion: 1, FallbackText: "fixture"}, Payload: releases.CardPayload{Version: "1.2.3"}}
	projector := releaseProjector{service: releaseReaderFunc(func(_ context.Context, actual releases.ProjectCardInput) (*releases.CardProjection, error) {
		if actual.ActorID != input.ActorID || actual.SpaceID != input.SpaceID || actual.Version != input.Version || actual.PublicationID != input.PublicationID {
			t.Fatalf("projection input=%+v", actual)
		}
		return &want, nil
	})}
	got, err := projector.ProjectCard(context.Background(), input)
	if err != nil || got == nil || got.Block != delivery.CardBlock(want.Block) || got.Payload.(releases.CardPayload).Version != want.Payload.Version {
		t.Fatalf("projection=%+v error=%v", got, err)
	}
	input.PublicationID = ""
	if _, err := projector.ProjectCard(context.Background(), input); err == nil {
		t.Fatal("missing publication binding accepted")
	}
}

func TestReleaseProjectorPropagatesFailureAndRejectsMissingDependencies(t *testing.T) {
	failure := errors.New("synthetic read failure")
	projector := releaseProjector{service: releaseReaderFunc(func(context.Context, releases.ProjectCardInput) (*releases.CardProjection, error) {
		return nil, failure
	})}
	if _, err := projector.ProjectCard(context.Background(), delivery.ReleaseProjectInput{PublicationID: "publication"}); !errors.Is(err, failure) {
		t.Fatalf("read error=%v", err)
	}
	if _, err := NewDeliveryService(DeliveryOptions{}); err == nil {
		t.Fatal("missing delivery dependencies accepted")
	}
}
