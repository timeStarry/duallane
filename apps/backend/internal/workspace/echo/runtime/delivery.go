package runtime

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

// DeliveryOptions contains the already-configured domain dependencies shared
// by the API retry path and worker recovery path. Construction never starts a
// worker or sends a notification; durable message jobs use Messages' scheduler.
type DeliveryOptions struct {
	Pool          *pgxpool.Pool
	SpaceID       string
	Messages      *messages.PGRepository
	Cards         *cards.PGRepository
	CardService   *cards.Service
	Requirements  *requirements.Service
	Solicitations *solicitations.Service
	Releases      *releases.Service
}

func NewDeliveryService(options DeliveryOptions) (*delivery.Service, error) {
	if options.Pool == nil || options.Messages == nil || options.Cards == nil || options.CardService == nil || options.Requirements == nil || options.Solicitations == nil || options.Releases == nil {
		return nil, errors.New("echo delivery composition dependencies are required")
	}
	repository := delivery.NewPGRepository(options.Pool, delivery.DomainTransactionOptions{
		Message: options.Messages.NewTransaction,
		// The base cards view retains EchoCardRevisionTx. The action repository
		// is used for actions, not this trusted internal upsert path.
		Card: options.Cards.NewTransaction,
	})
	return delivery.NewService(delivery.ServiceOptions{
		Repository: repository, SpaceID: options.SpaceID,
		Writer:               NewWriter(options.SpaceID, options.Messages, options.CardService),
		RequirementProjector: options.Requirements, SolicitationProjector: options.Solicitations,
		ReleaseProjector: releaseProjector{service: options.Releases},
	}), nil
}

type releaseCardReader interface {
	ProjectCard(context.Context, releases.ProjectCardInput) (*releases.CardProjection, error)
}

type releaseProjector struct{ service releaseCardReader }

func (p releaseProjector) ProjectCard(ctx context.Context, input delivery.ReleaseProjectInput) (*delivery.ReleaseProjection, error) {
	if p.service == nil || input.PublicationID == "" {
		return nil, errors.New("echo release publication projection is unavailable")
	}
	value, err := p.service.ProjectCard(ctx, releases.ProjectCardInput{
		ActorID: input.ActorID, SpaceID: input.SpaceID, Version: input.Version, PublicationID: input.PublicationID,
	})
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, errors.New("echo release projection is missing")
	}
	return &delivery.ReleaseProjection{
		Block: delivery.CardBlock(value.Block), Payload: value.Payload,
	}, nil
}

var _ delivery.ReleaseProjector = releaseProjector{}
