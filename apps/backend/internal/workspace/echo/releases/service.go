package releases

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const releasePublishAction = "echo.release.publish"

// NewService requires a validated non-empty catalog. The parent composition
// layer should load the checked-in shared catalog with LoadGuideCatalog before
// constructing the service; there is no placeholder or empty-guide mode.
func NewService(options ServiceOptions) (*Service, error) {
	if options.Repository == nil {
		return nil, errors.New("echo release repository is required")
	}
	if options.Catalog.Empty() {
		return nil, ErrCatalogEmpty
	}
	catalog, err := NewGuideCatalog(options.Catalog.List())
	if err != nil {
		return nil, err
	}
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	idFactory := options.IDFactory
	if idFactory == nil {
		idFactory = func() (string, error) {
			id, err := uuid.NewRandom()
			if err != nil {
				return "", err
			}
			return id.String(), nil
		}
	}
	return &Service{repo: options.Repository, catalog: catalog, spaceID: spaceID, now: now, newID: idFactory}, nil
}

func NewServiceFromCatalogFile(options ServiceOptions, path string) (*Service, error) {
	catalog, err := LoadGuideCatalog(path)
	if err != nil {
		return nil, err
	}
	options.Catalog = catalog
	return NewService(options)
}

func (s *Service) Repository() Repository {
	if s == nil {
		return nil
	}
	return s.repo
}

func (s *Service) DeliveryRepository() DeliveryRepository {
	if s == nil {
		return nil
	}
	repository, _ := s.repo.(DeliveryRepository)
	return repository
}

func (s *Service) nowUTC() time.Time {
	value := time.Now()
	if s != nil && s.now != nil {
		value = s.now()
	}
	if value.IsZero() {
		value = time.Unix(0, 0)
	}
	return value.UTC().Truncate(time.Millisecond)
}

func (s *Service) newIdentifier(operation string) (string, error) {
	if s == nil || s.newID == nil {
		return "", errors.New(operation + " id factory is required")
	}
	id, err := s.newID()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return id, nil
}

// Publish authorizes the current active human actor inside the accepting
// transaction, locks the (space, version) boundary, snapshots the registered
// guide, creates one pending row for every active human member, and records a
// metadata-only audit. It never performs external delivery.
func (s *Service) Publish(ctx context.Context, input PublishInput) (*PublicationSummary, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("publish echo release", errors.New("repository is required"))
	}
	var result *PublicationSummary
	var rejected *TransactionRejection
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		var txErr error
		result, txErr = s.PublishInTx(ctx, tx, input)
		if marker, ok := txErr.(*TransactionRejection); ok {
			rejected = marker
			return nil
		}
		return txErr
	})
	if err != nil {
		if domainErr := asDomainError(err); domainErr != nil {
			return nil, domainErr
		}
		return nil, normalizeError(err)
	}
	if rejected != nil {
		return nil, rejected.Err
	}
	return result, nil
}

// PublishInTx applies release publication, recipient row creation, snapshot,
// idempotent replay, and audit writes to a caller-owned transaction. A
// TransactionRejection is returned only after its rejection audit is in tx;
// the caller must commit that path.
func (s *Service) PublishInTx(ctx context.Context, tx Tx, input PublishInput) (*PublicationSummary, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("publish echo release", errors.New("repository is required"))
	}
	if tx == nil {
		return nil, internalError("publish echo release", errors.New("transaction is required"))
	}
	spaceID := s.space(input.SpaceID)
	version, err := normalizeVersion(input.Version)
	if err != nil {
		return nil, err
	}
	actorID := strings.TrimSpace(input.ActorID)
	if actorID == "" {
		return nil, unauthorizedError()
	}
	meta := input.Meta.Safe()
	actor, err := tx.LookupActor(ctx, spaceID, actorID)
	if err != nil {
		return nil, err
	}
	if actor == nil || actor.Kind != "human" || strings.TrimSpace(actor.Role) == "" {
		return nil, unauthorizedError()
	}
	if actor.Role != "owner" {
		if err := tx.WriteAudit(ctx, releaseAudit(actor, spaceID, version, "rejected", "permission.denied", meta, s.nowUTC())); err != nil {
			return nil, err
		}
		return nil, &TransactionRejection{Err: permissionDeniedError(), TargetID: version, Reason: "permission.denied"}
	}
	guide, ok := s.catalog.Guide(version)
	if !ok {
		if err := tx.WriteAudit(ctx, releaseAudit(actor, spaceID, version, "rejected", CodeGuideNotFound, meta, s.nowUTC())); err != nil {
			return nil, err
		}
		return nil, &TransactionRejection{Err: guideNotFoundError(), TargetID: version, Reason: CodeGuideNotFound}
	}
	if err := tx.Lock(ctx, "duallane:echo-release:"+spaceID+":"+version); err != nil {
		return nil, err
	}
	existing, err := tx.GetPublication(ctx, spaceID, version)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		result, err := s.summary(ctx, tx, existing, true)
		if err != nil {
			return nil, err
		}
		if err := tx.WriteAudit(ctx, releaseAudit(actor, spaceID, version, "success", "replayed", meta, s.nowUTC())); err != nil {
			return nil, err
		}
		return result, nil
	}

	publicationSuffix, err := s.newIdentifier("echo release publication")
	if err != nil {
		return nil, err
	}
	at := s.nowUTC()
	guideJSON, guideHash, err := marshalGuide(guide)
	if err != nil {
		return nil, err
	}
	record := PublicationRecord{
		ID:                "echo_release_" + publicationSuffix,
		SpaceID:           spaceID,
		Version:           version,
		Title:             guide.Title,
		GuideHash:         guideHash,
		GuideJSON:         guideJSON,
		PublishedByUserID: actor.ID,
		PublishedAt:       at,
	}
	if err := tx.InsertPublication(ctx, record); err != nil {
		return nil, err
	}
	if err := tx.InsertDeliveryRows(ctx, spaceID, record.ID, at); err != nil {
		return nil, err
	}
	result, err := s.summary(ctx, tx, &record, false)
	if err != nil {
		return nil, err
	}
	if err := tx.WriteAudit(ctx, releaseAudit(actor, spaceID, version, "success", "published", meta, at)); err != nil {
		return nil, err
	}
	return result, nil
}

// ProjectCard reads the immutable publication snapshot and applies the
// recipient's current active-human authorization before returning it. Card
// persistence and message delivery remain the delivery coordinator's job.
func (s *Service) ProjectCard(ctx context.Context, input ProjectCardInput) (*CardProjection, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("project echo release card", errors.New("repository is required"))
	}
	spaceID := s.space(input.SpaceID)
	version, err := normalizeVersion(input.Version)
	if err != nil {
		return nil, err
	}
	actorID := strings.TrimSpace(input.ActorID)
	if actorID == "" {
		return nil, unauthorizedError()
	}
	actor, err := s.repo.LookupActor(ctx, spaceID, actorID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if actor == nil || actor.Kind != "human" {
		return nil, unauthorizedError()
	}
	publication, err := s.repo.GetPublicationForRecipient(ctx, spaceID, version, actor.ID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if publication == nil || (input.PublicationID != "" && publication.ID != input.PublicationID) {
		return nil, releaseNotFoundError()
	}
	guide, err := parseStoredGuide(publication.GuideJSON)
	if err != nil || guide.Version != version {
		return nil, internalError("project echo release card", errors.New("published guide snapshot is invalid"))
	}
	publishedAt := formatTimestamp(publication.PublishedAt)
	return &CardProjection{
		Block: CardBlock{
			Type:          "card",
			CardID:        "echo_release_" + strings.ReplaceAll(version, ".", "_"),
			CardType:      CardType,
			SchemaVersion: CardSchemaVersion,
			FallbackText:  fmt.Sprintf("DualLane v%s 更新：%s", version, guide.Title),
		},
		Payload: CardPayload{
			Version:     guide.Version,
			ReleasedAt:  guide.ReleasedAt,
			Title:       guide.Title,
			Summary:     guide.Summary,
			Sections:    guide.Sections,
			PublishedAt: publishedAt,
		},
	}, nil
}

// GetPublication is the internal release read interface corresponding to the
// Node service's getPublication(version). It is intentionally not an HTTP
// handler or route: command and delivery composition may use it to read the
// immutable publication summary, while transport wiring remains outside this package.
func (s *Service) GetPublication(ctx context.Context, version string) (*PublicationSummary, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("get echo release publication", errors.New("repository is required"))
	}
	canonical, err := normalizeVersion(version)
	if err != nil {
		return nil, err
	}
	publication, err := s.repo.GetPublication(ctx, s.spaceID, canonical)
	if err != nil {
		return nil, normalizeError(err)
	}
	if publication == nil {
		return nil, nil
	}
	return s.summary(ctx, s.repo, publication, false)
}

func (s *Service) summary(ctx context.Context, repository ReadRepository, publication *PublicationRecord, replayed bool) (*PublicationSummary, error) {
	if publication == nil {
		return nil, errors.New("echo release publication is required")
	}
	counts, err := repository.DeliverySummary(ctx, publication.ID)
	if err != nil {
		return nil, err
	}
	return &PublicationSummary{
		ID:             publication.ID,
		Version:        publication.Version,
		Title:          publication.Title,
		PublishedAt:    formatTimestamp(publication.PublishedAt),
		RecipientCount: counts.RecipientCount,
		PendingCount:   counts.PendingCount,
		SentCount:      counts.SentCount,
		FailedCount:    counts.FailedCount,
		SkippedCount:   counts.SkippedCount,
		Replayed:       replayed,
	}, nil
}

func (s *Service) space(value string) string {
	value = strings.TrimSpace(value)
	if value != "" {
		return value
	}
	if s != nil && strings.TrimSpace(s.spaceID) != "" {
		return s.spaceID
	}
	return DefaultSpaceID
}

func releaseAudit(actor *auth.Actor, spaceID, version, result, reason string, meta auth.RequestMeta, at time.Time) AuditInput {
	return AuditInput{
		SpaceID:          spaceID,
		ActorUserID:      actor.ID,
		ActorGitHubLogin: actor.GitHubLogin,
		Action:           releasePublishAction,
		TargetType:       "echo.release",
		TargetID:         version,
		Result:           result,
		Reason:           reason,
		Meta:             meta.Safe(),
		CreatedAt:        at,
	}
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func asDomainError(err error) *Error {
	if err == nil {
		return nil
	}
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return nil
}
