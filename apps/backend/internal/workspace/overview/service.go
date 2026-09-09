package overview

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const statisticsCapability = "workspace.statistics.read"

type Clock func() time.Time
type IDFactory func() (string, error)

type ServiceOptions struct {
	Repository Repository
	SpaceID    string
	Now        Clock
	Location   *time.Location
	IDFactory  IDFactory
}

type Service struct {
	repository Repository
	spaceID    string
	now        Clock
	location   *time.Location
	idFactory  IDFactory
}

func NewService(options ServiceOptions) *Service {
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	location := options.Location
	if location == nil {
		location = time.Local
	}
	idFactory := options.IDFactory
	if idFactory == nil {
		idFactory = func() (string, error) {
			id, err := uuid.NewRandom()
			return id.String(), err
		}
	}
	return &Service{repository: options.Repository, spaceID: spaceID, now: now, location: location, idFactory: idFactory}
}

func (service *Service) GetStatistics(ctx context.Context, actorID string, meta auth.RequestMeta) (Statistics, error) {
	if service == nil || service.repository == nil {
		return Statistics{}, internalError("read workspace statistics", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return Statistics{}, NewError(CodeAuthRequired, MessageAuthRequired, 401)
	}
	now := service.now()
	if now.IsZero() {
		return Statistics{}, NewError(CodeInvalidTime, MessageInvalidTime, 400)
	}
	localNow := now.In(service.location)
	dayStartedLocal := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, service.location)
	var result Statistics
	var rejected *Error
	err := service.repository.WithTx(ctx, func(tx Tx) error {
		actor, err := tx.LookupActor(ctx, service.spaceID, actorID)
		if err != nil {
			return err
		}
		if actor == nil || actor.ID != actorID || strings.TrimSpace(actor.Role) == "" {
			return NewError(CodeAuthRequired, MessageAuthRequired, 401)
		}
		if actor.Kind != "" && actor.Kind != "human" {
			return NewError(CodeIdentityForbidden, MessageIdentityForbidden, 401)
		}
		if actor.Role != "owner" {
			rejected = NewError(CodePermissionDenied, MessagePermissionDenied, 403)
			if err := service.writeRejectionAudit(ctx, tx, actor, meta, now); err != nil {
				return err
			}
			return nil
		}
		record, err := tx.ReadStatistics(ctx, service.spaceID, dayStartedLocal.UTC())
		if err != nil {
			return err
		}
		result = Statistics{
			AsOf:         formatTime(now),
			DayStartedAt: formatTime(dayStartedLocal),
			Totals:       record.Totals,
			Today:        record.Today,
		}
		return nil
	})
	if err != nil {
		var domainErr *Error
		if errors.As(err, &domainErr) {
			return Statistics{}, domainErr
		}
		return Statistics{}, internalError("read workspace statistics", err)
	}
	if rejected != nil {
		return Statistics{}, rejected
	}
	return result, nil
}

func (service *Service) writeRejectionAudit(ctx context.Context, tx Tx, actor *auth.Actor, meta auth.RequestMeta, now time.Time) error {
	id, err := service.idFactory()
	if err != nil || strings.TrimSpace(id) == "" {
		if err == nil {
			err = errors.New("id factory returned an empty id")
		}
		return internalError("generate statistics audit id", err)
	}
	safe := meta.Safe()
	return tx.WriteAudit(ctx, AuditInput{
		ID: id, SpaceID: service.spaceID, ActorUserID: actor.ID, ActorGitHubLogin: actor.GitHubLogin,
		Action: statisticsCapability, TargetType: "workspace", TargetID: service.spaceID,
		Result: "rejected", Reason: "insufficient permission", RequestID: safe.RequestID,
		IPAddress: safe.IPAddress, UserAgent: safe.UserAgent, CreatedAt: now.UTC(),
	})
}

func formatTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
