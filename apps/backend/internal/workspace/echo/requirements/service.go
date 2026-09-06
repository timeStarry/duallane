package requirements

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	whatwgurl "github.com/nlnwa/whatwg-url/url"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

var (
	identifierPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
	idempotencyPattern      = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
	publicIDPattern         = regexp.MustCompile(`^REQ-[0-9]{4}-[0-9]{4}$`)
	privateHostPattern      = regexp.MustCompile(`^(?:localhost(?:\.local)?|0\.0\.0\.0|127(?:\.[0-9]{1,3}){3}|10(?:\.[0-9]{1,3}){3}|169\.254(?:\.[0-9]{1,3}){2}|192\.168(?:\.[0-9]{1,3}){2}|172\.(?:1[6-9]|2[0-9]|3[0-1])(?:\.[0-9]{1,3}){2}|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)`)
	controlCharacterPattern = regexp.MustCompile(`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\x{202A}-\x{202E}\x{2066}-\x{2069}]`)
)

type ServiceOptions struct {
	Repository Repository
	SpaceID    string
	Now        Clock
	IDFactory  IDFactory
}

type Service struct {
	repo      Repository
	spaceID   string
	now       Clock
	idFactory IDFactory
}

type mutationRejection struct {
	err      *Error
	targetID string
	reason   string
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
	return &Service{repo: options.Repository, spaceID: spaceID, now: now, idFactory: idFactory}
}

func NewServiceForRepository(repo Repository) *Service {
	return NewService(ServiceOptions{Repository: repo})
}

func (s *Service) Repository() Repository {
	if s == nil {
		return nil
	}
	return s.repo
}

func (s *Service) space(input string) string {
	if value := strings.TrimSpace(input); value != "" {
		return value
	}
	if s == nil || strings.TrimSpace(s.spaceID) == "" {
		return DefaultSpaceID
	}
	return s.spaceID
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

func (s *Service) newID(operation string) (string, error) {
	if s == nil || s.idFactory == nil {
		return "", errors.New(operation + " id factory is required")
	}
	id, err := s.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return id, nil
}

// withMutation makes the actor and authorization checks part of the same
// transaction as the resource write. A domain rejection is deliberately
// returned only after its content-free audit row has committed.
func (s *Service) withMutation(ctx context.Context, actorID, spaceID string, meta auth.RequestMeta, action string, fn func(Tx, *auth.Actor, time.Time) (*Requirement, *mutationRejection, string, error)) (*Requirement, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("run echo requirement mutation", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	meta = meta.Safe()
	var result *Requirement
	var rejection *mutationRejection
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return errors.New("echo requirement transaction is required")
		}
		actor, err := s.lookupActor(ctx, tx, spaceID, actorID)
		if err != nil {
			return err
		}
		var successReason string
		at := s.nowUTC()
		result, rejection, successReason, err = fn(tx, actor, at)
		if err != nil {
			return err
		}
		// A successful idempotency replay has no new domain mutation. The
		// original transaction already recorded its audit/event pair; emitting
		// another success audit here would make retries observable as writes.
		if rejection == nil && successReason == "" {
			return nil
		}
		targetID := ""
		reason := successReason
		outcome := "success"
		if rejection != nil {
			targetID = rejection.targetID
			reason = rejection.reason
			if reason == "" && rejection.err != nil {
				reason = rejection.err.Code
			}
			outcome = "rejected"
		} else if result != nil {
			targetID = result.PublicID
		}
		audit := AuditInput{
			SpaceID:          spaceID,
			ActorUserID:      actor.ID,
			ActorGitHubLogin: actor.GitHubLogin,
			Action:           action,
			TargetType:       "echo.requirement",
			TargetID:         targetID,
			Result:           outcome,
			Reason:           reason,
			Meta:             meta,
			CreatedAt:        at,
		}
		if err := tx.WriteAudit(ctx, audit); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, normalizeError(err)
	}
	if rejection != nil {
		return nil, rejection.err
	}
	return result, nil
}

func (s *Service) lookupActor(ctx context.Context, repo ReadRepository, spaceID, actorID string) (*auth.Actor, error) {
	actor, err := repo.LookupActor(ctx, spaceID, actorID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if actor == nil || actor.ID != actorID || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	if actor.Kind != "" && actor.Kind != "human" {
		return nil, authRequiredError()
	}
	return actor, nil
}

func (s *Service) readActor(ctx context.Context, spaceID, actorID string) (*auth.Actor, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("read echo requirement actor", errors.New("repository is required"))
	}
	return s.lookupActor(ctx, s.repo, spaceID, strings.TrimSpace(actorID))
}

func (s *Service) Submit(ctx context.Context, input SubmitInput) (*Requirement, error) {
	spaceID, err := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if err != nil {
		return nil, err
	}
	actorID := strings.TrimSpace(input.ActorID)
	if _, err := s.readActor(ctx, spaceID, actorID); err != nil {
		return nil, err
	}
	return s.withMutation(ctx, actorID, spaceID, input.Meta, "echo.requirement.submit", func(tx Tx, actor *auth.Actor, at time.Time) (*Requirement, *mutationRejection, string, error) {
		if actor.Role == "auditor" {
			return nil, &mutationRejection{err: NewError(CodePermissionDenied, "审计角色不能提交需求", 403), reason: "permission.denied"}, "", nil
		}
		normalized, normalizedErr := normalizeSubmission(input)
		if normalizedErr != nil {
			return nil, rejectError(normalizedErr, ""), "", nil
		}
		key, keyErr := normalizeIdempotencyKey(input.IdempotencyKey)
		if keyErr != nil {
			return nil, rejectError(keyErr, ""), "", nil
		}
		requestHash := submitRequestHash(spaceID, actor.ID, normalized)
		year := at.Year()
		if err := tx.Lock(ctx, fmt.Sprintf("echo-requirement:sequence:%s:%04d", spaceID, year)); err != nil {
			return nil, nil, "", err
		}
		if err := tx.Lock(ctx, fmt.Sprintf("echo-requirement:idempotency:%s:%s:submit:%s", spaceID, actor.ID, key)); err != nil {
			return nil, nil, "", err
		}
		existing, err := tx.GetIdempotency(ctx, spaceID, actor.ID, "submit", key)
		if err != nil {
			return nil, nil, "", err
		}
		if existing != nil {
			if existing.RequestHash != requestHash {
				return nil, &mutationRejection{err: conflictError(CodeIdempotencyConflict, MessageSubmitIdempotencyConflict)}, "", nil
			}
			replay, replayErr := replayResult(ctx, tx, existing, actor, spaceID)
			if replayErr != nil {
				return nil, nil, "", replayErr
			}
			return replay, nil, "", nil
		}
		number, err := tx.AllocateSequence(ctx, spaceID, year)
		if err != nil {
			return nil, nil, "", err
		}
		id, err := s.newID("echo requirement")
		if err != nil {
			return nil, nil, "", err
		}
		publicID := fmt.Sprintf("REQ-%04d-%04d", year, number)
		record := RequirementRecord{
			ID: id, PublicID: publicID, SpaceID: spaceID, SubmitterUserID: actor.ID,
			SubmitterDisplayName: actor.DisplayName, SubmitterGithubLogin: actor.GitHubLogin,
			Type: normalized.Type, Title: normalized.Title, Detail: normalized.Detail,
			Scenario: normalized.Scenario, ExpectedResult: normalized.ExpectedResult,
			RelatedLink: cloneStringPtr(normalized.RelatedLink), State: StateSubmitted,
			Phase: PhaseProposal, Status: StatusPendingReview, Revision: 1,
			CreatedAt: at, UpdatedAt: at,
		}
		if err := tx.InsertRequirement(ctx, record); err != nil {
			return nil, nil, "", err
		}
		historyID, err := s.newID("echo requirement history")
		if err != nil {
			return nil, nil, "", err
		}
		keyCopy := key
		if err := tx.InsertHistory(ctx, RequirementHistoryRecord{ID: historyID, RequirementID: id, ToState: StateSubmitted, ToPhase: PhaseProposal, ToStatus: StatusPendingReview, ActorUserID: actor.ID, Revision: 1, IdempotencyKey: &keyCopy, CreatedAt: at}); err != nil {
			return nil, nil, "", err
		}
		inserted, err := tx.InsertIdempotency(ctx, IdempotencyRecord{SpaceID: spaceID, ActorUserID: actor.ID, Operation: "submit", Key: key, RequestHash: requestHash, RequirementID: id, ResultingState: StateSubmitted, ResultingRevision: 1, CreatedAt: at})
		if err != nil {
			return nil, nil, "", err
		}
		if !inserted {
			return nil, nil, "", conflictError(CodeIdempotencyConflict, MessageIdempotencyConflict)
		}
		resultRecord, err := tx.GetRequirementByID(ctx, spaceID, id)
		if err != nil || resultRecord == nil {
			if err == nil {
				err = errors.New("created echo requirement could not be read")
			}
			return nil, nil, "", err
		}
		result := ProjectRequirement(*resultRecord)
		encoded, err := json.Marshal(result)
		if err != nil {
			return nil, nil, "", err
		}
		if err := tx.UpdateIdempotencyResult(ctx, spaceID, actor.ID, "submit", key, encoded); err != nil {
			return nil, nil, "", err
		}
		if err := writeRequirementEvent(ctx, s, tx, actor, result, "echo.requirement.submitted", at); err != nil {
			return nil, nil, "", err
		}
		return &result, nil, "submitted", nil
	})
}

// Create is an intentional alias for callers that model all domain writes as
// creates; submit remains the name used by the Echo protocol.
func (s *Service) Create(ctx context.Context, input SubmitInput) (*Requirement, error) {
	return s.Submit(ctx, input)
}

func (s *Service) Get(ctx context.Context, input GetInput) (*Requirement, error) {
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return nil, validationErr
	}
	actor, err := s.readActor(ctx, spaceID, strings.TrimSpace(input.ActorID))
	if err != nil {
		return nil, err
	}
	publicID, publicIDErr := normalizePublicID(input.PublicID)
	if publicIDErr != nil {
		return nil, publicIDErr
	}
	record, err := s.repo.GetRequirementByPublicID(ctx, spaceID, publicID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if record == nil {
		if auditErr := s.writeReadAudit(ctx, spaceID, actor, input.Meta, publicID, CodeRequirementNotFound); auditErr != nil {
			return nil, normalizeError(auditErr)
		}
		return nil, notFoundError()
	}
	if actor.Role != "owner" && actor.ID != record.SubmitterUserID {
		if auditErr := s.writeReadAudit(ctx, spaceID, actor, input.Meta, publicID, "echo.permission_denied"); auditErr != nil {
			return nil, normalizeError(auditErr)
		}
		return nil, notFoundError()
	}
	result := ProjectRequirement(*record)
	return &result, nil
}

func (s *Service) List(ctx context.Context, input ListInput) ([]Requirement, error) {
	page, err := s.ListPage(ctx, input)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

func (s *Service) ListPage(ctx context.Context, input ListInput) (RequirementPage, error) {
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return RequirementPage{Items: []Requirement{}}, validationErr
	}
	actor, err := s.readActor(ctx, spaceID, strings.TrimSpace(input.ActorID))
	if err != nil {
		return RequirementPage{Items: []Requirement{}}, err
	}
	query, queryErr := normalizeListQuery(spaceID, actor, input)
	if queryErr != nil {
		return RequirementPage{Items: []Requirement{}}, queryErr
	}
	pageRecord, err := s.repo.ListRequirements(ctx, query)
	if err != nil {
		return RequirementPage{Items: []Requirement{}}, normalizeError(err)
	}
	items := make([]Requirement, 0, len(pageRecord.Items))
	for _, record := range pageRecord.Items {
		items = append(items, ProjectRequirement(record))
	}
	page := RequirementPage{Items: items, Total: pageRecord.Total, PageInfo: PageInfo{Offset: query.Offset, Limit: query.Limit}}
	if int64(query.Offset+len(items)) < pageRecord.Total {
		value := query.Offset + len(items)
		page.PageInfo.HasNext = true
		page.PageInfo.NextOffset = &value
	}
	return page, nil
}

func (s *Service) Stats(ctx context.Context, input StatsInput) (RequirementStats, error) {
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return emptyStats(), validationErr
	}
	actor, err := s.readActor(ctx, spaceID, strings.TrimSpace(input.ActorID))
	if err != nil {
		return emptyStats(), err
	}
	rows, err := s.repo.RequirementStats(ctx, spaceID, actor.ID, actor.Role == "owner")
	if err != nil {
		return emptyStats(), normalizeError(err)
	}
	result := emptyStats()
	for _, row := range rows {
		result.Total += row.Count
		result.ByPhase[row.Phase] += row.Count
		result.ByStatus[row.Status] += row.Count
	}
	return result, nil
}

func (s *Service) History(ctx context.Context, input HistoryInput) ([]RequirementHistory, error) {
	requirement, err := s.Get(ctx, GetInput{ActorID: input.ActorID, SpaceID: input.SpaceID, PublicID: input.PublicID, Meta: input.Meta})
	if err != nil {
		return []RequirementHistory{}, err
	}
	spaceID := s.space(input.SpaceID)
	rows, err := s.repo.ListRequirementHistory(ctx, spaceID, requirement.ID)
	if err != nil {
		return []RequirementHistory{}, normalizeError(err)
	}
	result := make([]RequirementHistory, 0, len(rows))
	for _, row := range rows {
		result = append(result, ProjectHistory(row))
	}
	return result, nil
}

func (s *Service) Transition(ctx context.Context, input TransitionInput) (*Requirement, error) {
	spaceID, err := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if err != nil {
		return nil, err
	}
	actorID := strings.TrimSpace(input.ActorID)
	if _, err := s.readActor(ctx, spaceID, actorID); err != nil {
		return nil, err
	}
	return s.withMutation(ctx, actorID, spaceID, input.Meta, "echo.requirement.transition", func(tx Tx, actor *auth.Actor, at time.Time) (*Requirement, *mutationRejection, string, error) {
		// Keep all input normalization inside the rejection-audit transaction.
		// This mirrors the active Node service: malformed transition attempts are
		// content-free audit records, while authentication failures remain
		// outside the mutation boundary.
		publicID, validationErr := normalizePublicID(input.PublicID)
		if validationErr != nil {
			return nil, rejectError(validationErr, ""), "", nil
		}
		expected, validationErr := normalizeTargetInput(input)
		if validationErr != nil {
			return nil, rejectError(validationErr, ""), "", nil
		}
		key, validationErr := normalizeIdempotencyKey(input.IdempotencyKey)
		if validationErr != nil {
			return nil, rejectError(validationErr, ""), "", nil
		}
		expectedRevision, validationErr := normalizeExpectedRevision(input.ExpectedRevision)
		if validationErr != nil {
			return nil, rejectError(validationErr, ""), "", nil
		}
		response, validationErr := normalizeOptionalResponseWithPresence(input.Response, input.ResponseSet || input.Response != "")
		if validationErr != nil {
			return nil, rejectError(validationErr, ""), "", nil
		}
		requestHash := transitionRequestHash(spaceID, publicID, expected, expectedRevision, response, input.DuplicateOfPublicID)
		if err := tx.Lock(ctx, fmt.Sprintf("echo-requirement:transition:%s:%s", spaceID, publicID)); err != nil {
			return nil, nil, "", err
		}
		if err := tx.Lock(ctx, fmt.Sprintf("echo-requirement:idempotency:%s:%s:transition:%s", spaceID, actor.ID, key)); err != nil {
			return nil, nil, "", err
		}
		row, err := tx.GetRequirementByPublicID(ctx, spaceID, publicID)
		if err != nil {
			return nil, nil, "", err
		}
		if row == nil {
			return nil, &mutationRejection{err: notFoundError(), targetID: publicID, reason: CodeRequirementNotFound}, "", nil
		}
		if actor.Role != "owner" {
			return nil, &mutationRejection{err: notFoundError(), targetID: publicID, reason: "echo.permission_denied"}, "", nil
		}
		existing, err := tx.GetIdempotency(ctx, spaceID, actor.ID, "transition", key)
		if err != nil {
			return nil, nil, "", err
		}
		if existing != nil {
			if existing.RequestHash != requestHash || existing.RequirementID != row.ID {
				return nil, &mutationRejection{err: conflictError(CodeIdempotencyConflict, MessageIdempotencyConflict), targetID: publicID}, "", nil
			}
			replay, replayErr := replayResult(ctx, tx, existing, actor, spaceID)
			if replayErr != nil {
				return nil, nil, "", replayErr
			}
			return replay, nil, "", nil
		}
		if row.Revision != expectedRevision {
			return nil, &mutationRejection{err: conflictError(CodeRevisionConflict, MessageRevisionConflict), targetID: publicID}, "", nil
		}
		target, targetErr := resolveTarget(*row, expected, input.DuplicateOfPublicID)
		if targetErr != nil {
			return nil, &mutationRejection{err: targetErr, targetID: publicID}, "", nil
		}
		if target.ArchiveOutcome != nil && *target.ArchiveOutcome == ArchiveRejected && response == nil {
			return nil, &mutationRejection{err: validationError(CodeRejectionResponseRequired, MessageRejectionResponseRequired), targetID: publicID}, "", nil
		}
		if target.ArchiveOutcome != nil && *target.ArchiveOutcome == ArchiveDuplicate {
			duplicateID := ""
			if target.DuplicateOfPublicID != nil {
				duplicateID = *target.DuplicateOfPublicID
			}
			duplicate, duplicateErr := tx.GetRequirementByPublicID(ctx, spaceID, duplicateID)
			if duplicateErr != nil {
				return nil, nil, "", duplicateErr
			}
			if duplicate == nil || duplicate.ID == row.ID {
				return nil, &mutationRejection{err: NewError(CodeDuplicateTargetInvalid, MessageDuplicateTargetInvalid, 400), targetID: publicID}, "", nil
			}
		}
		revision := row.Revision + 1
		updated := *row
		updated.State = target.State
		updated.Phase = target.Phase
		updated.Status = target.Status
		updated.ArchiveOutcome = cloneStringPtr(target.ArchiveOutcome)
		updated.DuplicateOfPublicID = cloneStringPtr(target.DuplicateOfPublicID)
		updated.Response = cloneStringPtr(response)
		updated.Revision = revision
		updated.UpdatedAt = at
		ok, err := tx.UpdateRequirementCAS(ctx, row.ID, row.Revision, updated)
		if err != nil {
			return nil, nil, "", err
		}
		if !ok {
			return nil, &mutationRejection{err: conflictError(CodeRevisionConflict, MessageRevisionConflict), targetID: publicID}, "", nil
		}
		historyID, err := s.newID("echo requirement history")
		if err != nil {
			return nil, nil, "", err
		}
		keyCopy := key
		if err := tx.InsertHistory(ctx, RequirementHistoryRecord{ID: historyID, RequirementID: row.ID, FromState: stringPtr(row.State), ToState: target.State, FromPhase: stringPtr(row.Phase), FromStatus: stringPtr(row.Status), ToPhase: target.Phase, ToStatus: target.Status, Response: cloneStringPtr(response), ActorUserID: actor.ID, Revision: revision, IdempotencyKey: &keyCopy, CreatedAt: at}); err != nil {
			return nil, nil, "", err
		}
		inserted, err := tx.InsertIdempotency(ctx, IdempotencyRecord{SpaceID: spaceID, ActorUserID: actor.ID, Operation: "transition", Key: key, RequestHash: requestHash, RequirementID: row.ID, ResultingState: target.State, ResultingRevision: revision, CreatedAt: at})
		if err != nil {
			return nil, nil, "", err
		}
		if !inserted {
			return nil, nil, "", conflictError(CodeIdempotencyConflict, MessageIdempotencyConflict)
		}
		fresh, err := tx.GetRequirementByID(ctx, spaceID, row.ID)
		if err != nil || fresh == nil {
			if err == nil {
				err = errors.New("transitioned echo requirement could not be read")
			}
			return nil, nil, "", err
		}
		result := ProjectRequirement(*fresh)
		encoded, err := json.Marshal(result)
		if err != nil {
			return nil, nil, "", err
		}
		if err := tx.UpdateIdempotencyResult(ctx, spaceID, actor.ID, "transition", key, encoded); err != nil {
			return nil, nil, "", err
		}
		if err := writeRequirementEvent(ctx, s, tx, actor, result, "echo.requirement.updated", at); err != nil {
			return nil, nil, "", err
		}
		reason := target.Status
		if target.ArchiveOutcome != nil {
			reason = *target.ArchiveOutcome
			if reason == ArchiveDuplicate {
				reason = "duplicate_proposal"
			}
		}
		return &result, nil, reason, nil
	})
}

func (s *Service) ProjectEvent(ctx context.Context, input GetInput) (*RequirementEvent, error) {
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return nil, validationErr
	}
	actor, err := s.readActor(ctx, spaceID, strings.TrimSpace(input.ActorID))
	if err != nil {
		return nil, err
	}
	publicID, publicIDErr := normalizePublicID(input.PublicID)
	if publicIDErr != nil {
		return nil, publicIDErr
	}
	record, err := s.repo.GetRequirementByPublicID(ctx, spaceID, publicID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if record == nil || (actor.Role != "owner" && actor.ID != record.SubmitterUserID) {
		return nil, nil
	}
	result := ProjectRequirementEvent(*record)
	return &result, nil
}

func (s *Service) ProjectCard(ctx context.Context, input GetInput) (*CardProjection, error) {
	requirement, err := s.Get(ctx, input)
	if err != nil {
		return nil, err
	}
	cardType, cardTypeErr := normalizeRequirementCardType(input.CardType)
	if cardTypeErr != nil {
		return nil, cardTypeErr
	}
	payload, payloadErr := normalizeRequirementCardPayload(cardType, map[string]any{
		"publicId": requirement.PublicID, "type": requirement.Type, "title": truncateCardText(requirement.Title, 120, 512),
		"detail": truncateCardText(requirement.Detail, 4_000, 5_000), "scenario": truncateCardText(requirement.Scenario, 2_000, 3_000),
		"expectedResult": truncateCardText(requirement.ExpectedResult, 2_000, 3_000), "relatedLink": requirement.RelatedLink,
		"state": requirement.State, "phase": requirement.Phase, "status": requirement.Status,
		"archiveOutcome": requirement.ArchiveOutcome, "duplicateOfPublicId": requirement.DuplicateOfPublicID,
		"revision": requirement.Revision, "response": truncatePtrWithBytes(requirement.Response, 2_000, 3_000),
		"createdAt": requirement.CreatedAt, "updatedAt": requirement.UpdatedAt,
	})
	if payloadErr != nil {
		return nil, payloadErr
	}
	return &CardProjection{
		Block:   CardBlock{Type: "card", CardID: "echo_req_" + strings.ToLower(requirement.PublicID), CardType: cardType, SchemaVersion: CardSchemaVersion, FallbackText: "回声需求 " + requirement.PublicID},
		Payload: payload,
	}, nil
}

func (s *Service) ProjectListCard(ctx context.Context, input ListInput) (*CardProjection, error) {
	items, err := s.List(ctx, input)
	if err != nil {
		return nil, err
	}
	itemCount := len(items)
	if len(items) > 40 {
		items = items[:40]
	}
	values := make([]any, 0, len(items))
	for _, item := range items {
		values = append(values, map[string]any{"publicId": item.PublicID, "type": item.Type, "title": truncateCardText(item.Title, 96, 384), "state": item.State, "phase": item.Phase, "status": item.Status, "revision": item.Revision, "createdAt": item.CreatedAt, "updatedAt": item.UpdatedAt})
	}
	payload, payloadErr := normalizeRequirementCardListPayload(map[string]any{"items": values})
	if payloadErr != nil {
		return nil, payloadErr
	}
	return &CardProjection{Block: CardBlock{Type: "card", CardID: "echo_req_list_" + strings.TrimSpace(input.ActorID), CardType: CardTypeRequirementList, SchemaVersion: CardSchemaVersion, FallbackText: fmt.Sprintf("回声需求列表（%d 条）", itemCount)}, Payload: payload}, nil
}

type normalizedSubmission struct {
	Type, Title, Detail, Scenario, ExpectedResult string
	RelatedLink                                   *string
}

type normalizedTarget struct {
	State, Phase, Status string
	ArchiveOutcome       *string
	DuplicateOfPublicID  *string
}

func normalizeSubmission(input SubmitInput) (normalizedSubmission, *Error) {
	typ, err := normalizeType(input.Type)
	if err != nil {
		return normalizedSubmission{}, err
	}
	title, err := boundedText(input.Title, CodeTitleInvalid, MessageTitleInvalid, MaxTitleCodePoints, MaxTitleBytes)
	if err != nil {
		return normalizedSubmission{}, err
	}
	detail, err := boundedText(input.Detail, CodeDetailInvalid, MessageDetailInvalid, MaxBodyCodePoints, MaxBodyBytes)
	if err != nil {
		return normalizedSubmission{}, err
	}
	scenario, err := boundedText(input.Scenario, CodeScenarioInvalid, MessageScenarioInvalid, MaxBodyCodePoints, MaxBodyBytes)
	if err != nil {
		return normalizedSubmission{}, err
	}
	expected, err := boundedText(input.ExpectedResult, CodeExpectedResultInvalid, MessageExpectedResultInvalid, MaxBodyCodePoints, MaxBodyBytes)
	if err != nil {
		return normalizedSubmission{}, err
	}
	link, err := normalizeRelatedLink(input.RelatedLink)
	if err != nil {
		return normalizedSubmission{}, err
	}
	return normalizedSubmission{Type: typ, Title: title, Detail: detail, Scenario: scenario, ExpectedResult: expected, RelatedLink: link}, nil
}

func normalizeType(value string) (string, *Error) {
	for _, candidate := range RequirementTypes {
		if value == candidate {
			return value, nil
		}
	}
	return "", validationError(CodeTypeInvalid, MessageTypeInvalid)
}

func boundedText(value, code, message string, maxPoints, maxBytes int) (string, *Error) {
	if !utf8.ValidString(value) {
		return "", validationError(code, message)
	}
	value = trimNodeSpace(value)
	if value == "" || controlCharacterPattern.MatchString(value) || utf8.RuneCountInString(value) > maxPoints || len([]byte(value)) > maxBytes {
		return "", validationError(code, message)
	}
	return value, nil
}

func normalizeRelatedLink(value string) (*string, *Error) {
	if value == "" {
		return nil, nil
	}
	value = trimNodeSpace(value)
	if value == "" || !utf8.ValidString(value) || len([]byte(value)) > MaxRelatedLinkBytes || controlCharacterPattern.MatchString(value) {
		return nil, validationError(CodeRelatedLinkInvalid, MessageRelatedLinkInvalid)
	}
	// The normalized link participates in persisted Node request hashes. Use
	// the browser URL algorithm for ports, IDNs, dot segments and IPv4 aliases.
	parsed, err := whatwgurl.Parse(value)
	if err != nil || parsed.Username() != "" || parsed.Password() != "" || (parsed.Scheme() != "http" && parsed.Scheme() != "https") || parsed.Hostname() == "" {
		return nil, validationError(CodeRelatedLinkInvalid, MessageRelatedLinkInvalid)
	}
	host := strings.Trim(strings.ToLower(strings.TrimSuffix(parsed.Hostname(), ".")), "[]")
	if privateHostPattern.MatchString(host) || privateIPAddress(host) {
		return nil, validationError(CodeRelatedLinkInvalid, MessageRelatedLinkInvalid)
	}
	canonical := parsed.Href(false)
	return &canonical, nil
}

func privateIPAddress(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsLinkLocalMulticast()
}

func normalizeIdempotencyKey(value string) (string, *Error) {
	value = trimNodeSpace(value)
	if value == "" || len([]byte(value)) > MaxIdempotencyBytes || !idempotencyPattern.MatchString(value) {
		return "", validationError(CodeIdempotencyKeyInvalid, "幂等键无效")
	}
	return value, nil
}

func normalizeIdentifier(value, code, message string) (string, *Error) {
	value = trimNodeSpace(value)
	if !identifierPattern.MatchString(value) {
		return "", validationError(code, message)
	}
	return value, nil
}

func normalizePublicID(value string) (string, *Error) {
	value = strings.ToUpper(trimNodeSpace(value))
	if !publicIDPattern.MatchString(value) {
		return "", validationError(CodeRequirementIDInvalid, MessageRequirementIDInvalid)
	}
	return value, nil
}

func normalizeExpectedRevision(value int64) (int64, *Error) {
	if value < 1 {
		return 0, validationError(CodeExpectedRevisionInvalid, "需求版本无效")
	}
	return value, nil
}

func normalizeOptionalResponseWithPresence(value string, present bool) (*string, *Error) {
	if !present {
		return nil, nil
	}
	normalized, err := boundedText(value, CodeResponseInvalid, MessageResponseInvalid, MaxResponseCodePoint, MaxResponseBytes)
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

func normalizeTargetInput(input TransitionInput) (normalizedTarget, *Error) {
	legacy := input.ToState
	if legacy == "" {
		legacy = input.State
	}
	if legacy != "" {
		for _, candidate := range RequirementStates {
			if legacy == candidate {
				return targetForLegacyState(legacy), nil
			}
		}
		return normalizedTarget{}, validationError(CodeStateInvalid, MessageStateInvalid)
	}
	phase := input.ToPhase
	if phase == "" {
		phase = input.Phase
	}
	status := input.ToStatus
	if status == "" {
		status = input.Status
	}
	if !contains(RequirementPhases[:], phase) {
		return normalizedTarget{}, validationError(CodePhaseInvalid, MessagePhaseInvalid)
	}
	if !contains(RequirementStatuses[:], status) {
		return normalizedTarget{}, validationError(CodeStatusInvalid, MessageStatusInvalid)
	}
	var outcome *string
	if phase == PhaseArchived {
		value := input.ArchiveOutcome
		if !contains(RequirementArchiveResults[:], value) {
			return normalizedTarget{}, validationError(CodeArchiveOutcomeInvalid, MessageArchiveOutcomeInvalid)
		}
		outcome = &value
	}
	return normalizedTarget{Phase: phase, Status: status, ArchiveOutcome: outcome}, nil
}

func targetForLegacyState(state string) normalizedTarget {
	switch state {
	case StateSubmitted:
		return normalizedTarget{State: StateSubmitted, Phase: PhaseProposal, Status: StatusPendingReview}
	case StateCollected:
		return normalizedTarget{State: StateCollected, Phase: PhaseFormal, Status: StatusPlanned}
	case StateInProgress:
		return normalizedTarget{State: StateInProgress, Phase: PhaseFormal, Status: StatusInProgress}
	case StateImplemented:
		return normalizedTarget{State: StateImplemented, Phase: PhaseFormal, Status: StatusDelivered}
	default:
		return normalizedTarget{State: StateRejected, Phase: PhaseArchived, Status: StatusArchived, ArchiveOutcome: stringPtr(ArchiveRejected)}
	}
}

func resolveTarget(row RequirementRecord, expected normalizedTarget, duplicateID string) (normalizedTarget, *Error) {
	currentPhase, currentStatus := row.Phase, row.Status
	if currentPhase == "" {
		currentPhase = legacyPhase(row.State)
	}
	if currentStatus == "" {
		currentStatus = legacyStatus(row.State)
	}
	if expected.Phase == PhaseArchived {
		if expected.Status != StatusArchived || currentPhase == PhaseArchived || expected.ArchiveOutcome == nil {
			return normalizedTarget{}, conflictError(CodeInvalidTransition, MessageInvalidTransition)
		}
		if *expected.ArchiveOutcome == ArchiveImplemented && !(currentPhase == PhaseFormal && currentStatus == StatusDelivered) {
			return normalizedTarget{}, conflictError(CodeInvalidTransition, "只有已交付需求可以归档为已实现")
		}
		result := expected
		result.State = StateRejected
		if *expected.ArchiveOutcome == ArchiveImplemented {
			result.State = StateImplemented
		}
		if *expected.ArchiveOutcome == ArchiveDuplicate {
			normalizedDuplicateID, err := normalizePublicID(duplicateID)
			if err != nil {
				return normalizedTarget{}, err
			}
			result.DuplicateOfPublicID = &normalizedDuplicateID
		}
		return result, nil
	}
	if currentPhase == PhaseArchived || (expected.Phase == PhaseProposal && expected.Status != StatusPendingReview) {
		return normalizedTarget{}, conflictError(CodeInvalidTransition, MessageInvalidTransition)
	}
	valid := (currentPhase == PhaseProposal && currentStatus == StatusPendingReview && expected.Phase == PhaseFormal && expected.Status == StatusPlanned) ||
		(currentPhase == PhaseFormal && currentStatus == StatusPlanned && expected.Phase == PhaseFormal && (expected.Status == StatusInProgress || expected.Status == StatusDelivered)) ||
		(currentPhase == PhaseFormal && currentStatus == StatusInProgress && expected.Phase == PhaseFormal && expected.Status == StatusDelivered)
	if !valid {
		return normalizedTarget{}, conflictError(CodeInvalidTransition, MessageInvalidTransition)
	}
	expected.State = stateForTarget(expected.Phase, expected.Status)
	return expected, nil
}

func stateForTarget(phase, status string) string {
	if phase == PhaseFormal && status == StatusPlanned {
		return StateCollected
	}
	if phase == PhaseFormal && status == StatusInProgress {
		return StateInProgress
	}
	if phase == PhaseFormal && status == StatusDelivered {
		return StateImplemented
	}
	if phase == PhaseArchived {
		return StateRejected
	}
	return StateSubmitted
}

func legacyPhase(state string) string {
	if state == StateCollected || state == StateInProgress || state == StateImplemented {
		return PhaseFormal
	}
	if state == StateRejected {
		return PhaseArchived
	}
	return PhaseProposal
}

func legacyStatus(state string) string {
	switch state {
	case StateCollected:
		return StatusPlanned
	case StateInProgress:
		return StatusInProgress
	case StateImplemented:
		return StatusDelivered
	case StateRejected:
		return StatusArchived
	default:
		return StatusPendingReview
	}
}

func normalizeListQuery(spaceID string, actor *auth.Actor, input ListInput) (RequirementListQuery, *Error) {
	query := RequirementListQuery{SpaceID: spaceID, ActorID: actor.ID, Owner: actor.Role == "owner", Limit: DefaultListLimit}
	var err *Error
	if input.State != "" {
		query.State, err = optionalEnum(input.State, RequirementStates[:], CodeStateInvalid, MessageStateInvalid)
		if err != nil {
			return query, err
		}
	}
	if input.Phase != "" {
		query.Phase, err = optionalEnum(input.Phase, RequirementPhases[:], CodePhaseInvalid, MessagePhaseInvalid)
		if err != nil {
			return query, err
		}
	}
	if input.Status != "" {
		query.Status, err = optionalEnum(input.Status, RequirementStatuses[:], CodeStatusInvalid, MessageStatusInvalid)
		if err != nil {
			return query, err
		}
	}
	if input.ArchiveOutcome != "" {
		query.ArchiveOutcome, err = optionalEnum(input.ArchiveOutcome, RequirementArchiveResults[:], CodeArchiveOutcomeInvalid, MessageArchiveOutcomeInvalid)
		if err != nil {
			return query, err
		}
	}
	if input.Type != "" {
		query.Type, err = optionalEnum(input.Type, RequirementTypes[:], CodeTypeInvalid, MessageTypeInvalid)
		if err != nil {
			return query, err
		}
	}
	if input.SubmitterUserID != "" {
		value, valueErr := normalizeIdentifier(input.SubmitterUserID, CodeSubmitterInvalid, "提交者无效")
		if valueErr != nil {
			return query, valueErr
		}
		query.SubmitterUserID = &value
	}
	if input.CreatedFrom != "" {
		value, valueErr := parseFilterTime(input.CreatedFrom, CodeCreatedFromInvalid)
		if valueErr != nil {
			return query, valueErr
		}
		query.CreatedFrom = &value
	}
	if input.CreatedTo != "" {
		value, valueErr := parseFilterTime(input.CreatedTo, CodeCreatedToInvalid)
		if valueErr != nil {
			return query, valueErr
		}
		query.CreatedTo = &value
	}
	if query.CreatedFrom != nil && query.CreatedTo != nil && query.CreatedFrom.After(*query.CreatedTo) {
		return query, validationError(CodeCreatedRangeInvalid, "创建时间范围无效")
	}
	query.Limit = input.Limit
	if query.Limit == 0 {
		query.Limit = DefaultListLimit
	}
	if query.Limit < 1 {
		return query, validationError(CodeLimitInvalid, "列表数量无效")
	}
	if query.Limit > MaxListLimit {
		query.Limit = MaxListLimit
	}
	if input.Offset < 0 {
		return query, validationError(CodeOffsetInvalid, "列表偏移无效")
	}
	query.Offset = input.Offset
	return query, nil
}

func optionalEnum(value string, allowed []string, code, message string) (*string, *Error) {
	if !contains(allowed, value) {
		return nil, validationError(code, message)
	}
	return &value, nil
}

func parseFilterTime(value, code string) (time.Time, *Error) {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		parsed, err = time.Parse("2006-01-02", strings.TrimSpace(value))
	}
	if err != nil {
		return time.Time{}, validationError(code, "创建时间范围无效")
	}
	return parsed.UTC().Truncate(time.Millisecond), nil
}

func rejectError(err *Error, target string) *mutationRejection {
	return &mutationRejection{err: err, targetID: target, reason: err.Code}
}

func replayResult(ctx context.Context, repo ReadRepository, existing *IdempotencyRecord, actor *auth.Actor, spaceID string) (*Requirement, error) {
	if existing == nil {
		return nil, errors.New("echo requirement replay record is required")
	}
	if len(existing.ResultJSON) > 0 {
		var result Requirement
		if json.Unmarshal(existing.ResultJSON, &result) == nil && result.ID != "" && result.PublicID != "" {
			return &result, nil
		}
	}
	record, err := repo.GetRequirementByID(ctx, spaceID, existing.RequirementID)
	if err != nil {
		return nil, err
	}
	if record == nil || (actor.Role != "owner" && actor.ID != record.SubmitterUserID) {
		return nil, notFoundError()
	}
	result := ProjectRequirement(*record)
	if existing.ResultingState != "" {
		result.State = existing.ResultingState
		result.Phase = legacyPhase(existing.ResultingState)
		result.Status = legacyStatus(existing.ResultingState)
	}
	if existing.ResultingRevision > 0 {
		result.Revision = existing.ResultingRevision
	}
	return &result, nil
}

func submitRequestHash(spaceID, actorID string, input normalizedSubmission) string {
	value := struct {
		SpaceID        string  `json:"spaceId"`
		ActorID        string  `json:"actorId"`
		Type           string  `json:"type"`
		Title          string  `json:"title"`
		Detail         string  `json:"detail"`
		Scenario       string  `json:"scenario"`
		ExpectedResult string  `json:"expectedResult"`
		RelatedLink    *string `json:"relatedLink"`
	}{spaceID, actorID, input.Type, input.Title, input.Detail, input.Scenario, input.ExpectedResult, input.RelatedLink}
	return hashJSON(value)
}

func transitionRequestHash(spaceID, publicID string, expected normalizedTarget, revision int64, response *string, duplicateID string) string {
	value := struct {
		SpaceID             string               `json:"spaceId"`
		PublicID            string               `json:"publicId"`
		Expected            normalizedTargetHash `json:"expected"`
		ExpectedRevision    int64                `json:"expectedRevision"`
		Response            *string              `json:"response"`
		DuplicateOfPublicID *string              `json:"duplicateOfPublicId"`
	}{spaceID, publicID, normalizedTargetHash{Phase: expected.Phase, Status: expected.Status, ArchiveOutcome: expected.ArchiveOutcome}, revision, response, nullableString(duplicateID)}
	return hashJSON(value)
}

type normalizedTargetHash struct {
	Phase          string  `json:"phase"`
	Status         string  `json:"status"`
	ArchiveOutcome *string `json:"archiveOutcome"`
}

func hashJSON(value any) string {
	// Callers supply fixed ordered structs of strings, nulls and integer
	// revisions. JSON.stringify keeps HTML and U+2028/2029 unescaped; changing
	// those bytes would invalidate Node-written idempotency rows on cutover.
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	compatible := make([]byte, 0, len(encoded))
	for index := 0; index < len(encoded); index++ {
		if encoded[index] == '\\' && index+1 < len(encoded) {
			if index+6 <= len(encoded) && (string(encoded[index:index+6]) == `\u2028` || string(encoded[index:index+6]) == `\u2029`) {
				compatible = append(compatible, 0xe2, 0x80, 0xa8+encoded[index+5]-'8')
				index += 5
				continue
			}
			// Consume escape pairs together: a literal backslash-u sequence
			// must remain escaped, including after another escaped backslash.
			compatible = append(compatible, encoded[index], encoded[index+1])
			index++
			continue
		}
		compatible = append(compatible, encoded[index])
	}
	sum := sha256.Sum256(compatible)
	return hex.EncodeToString(sum[:])
}

func writeRequirementEvent(ctx context.Context, s *Service, tx Tx, actor *auth.Actor, requirement Requirement, eventType string, at time.Time) error {
	payload, err := json.Marshal(requirementEventPayload(requirement, eventType))
	if err != nil {
		return err
	}
	id, err := s.newID("echo requirement event")
	if err != nil {
		return err
	}
	_, err = tx.WriteEvent(ctx, EventInput{ID: id, SpaceID: requirement.SpaceID, Type: eventType, ActorID: actor.ID, TargetType: "echo.requirement", TargetID: requirement.ID, PayloadJSON: payload, CreatedAt: at})
	return err
}

func (s *Service) writeReadAudit(ctx context.Context, spaceID string, actor *auth.Actor, meta auth.RequestMeta, targetID, reason string) error {
	if s == nil || s.repo == nil {
		return errors.New("repository is required")
	}
	return s.repo.WithTx(ctx, func(tx Tx) error {
		return tx.WriteAudit(ctx, AuditInput{SpaceID: spaceID, ActorUserID: actor.ID, ActorGitHubLogin: actor.GitHubLogin, Action: "echo.requirement.read", TargetType: "echo.requirement", TargetID: targetID, Result: "rejected", Reason: reason, Meta: meta.Safe(), CreatedAt: s.nowUTC()})
	})
}

func ProjectRequirement(record RequirementRecord) Requirement {
	archiveOutcome := cloneStringPtr(record.ArchiveOutcome)
	if archiveOutcome == nil && record.State == StateRejected {
		archiveOutcome = stringPtr(ArchiveRejected)
	}
	return Requirement{ID: record.ID, PublicID: record.PublicID, SpaceID: record.SpaceID, SubmitterUserID: record.SubmitterUserID, SubmitterDisplayName: nullableString(record.SubmitterDisplayName), SubmitterGithubLogin: nullableString(record.SubmitterGithubLogin), Type: record.Type, Title: record.Title, Detail: record.Detail, Scenario: record.Scenario, ExpectedResult: record.ExpectedResult, RelatedLink: cloneStringPtr(record.RelatedLink), State: valueOr(record.State, StateSubmitted), Phase: valueOr(record.Phase, legacyPhase(record.State)), Status: valueOr(record.Status, legacyStatus(record.State)), ArchiveOutcome: archiveOutcome, DuplicateOfPublicID: cloneStringPtr(record.DuplicateOfPublicID), Revision: record.Revision, Response: cloneStringPtr(record.Response), CreatedAt: formatTimestamp(record.CreatedAt), UpdatedAt: formatTimestamp(record.UpdatedAt)}
}

func ProjectHistory(record RequirementHistoryRecord) RequirementHistory {
	return RequirementHistory{ID: record.ID, FromState: cloneStringPtr(record.FromState), ToState: record.ToState, FromPhase: cloneStringPtr(record.FromPhase), FromStatus: cloneStringPtr(record.FromStatus), ToPhase: record.ToPhase, ToStatus: record.ToStatus, Response: cloneStringPtr(record.Response), ActorUserID: record.ActorUserID, Revision: record.Revision, CreatedAt: formatTimestamp(record.CreatedAt)}
}

func ProjectRequirementEvent(record RequirementRecord) RequirementEvent {
	requirement := ProjectRequirement(record)
	return RequirementEvent{Type: "echo.requirement.updated", TargetType: "echo.requirement", TargetID: record.ID, Payload: requirementEventPayload(requirement, "echo.requirement.updated")}
}

func requirementEventPayload(requirement Requirement, eventType string) RequirementEventPayload {
	fallback := "回声需求 " + requirement.PublicID + " 状态已更新"
	_ = eventType
	return RequirementEventPayload{
		PublicID: requirement.PublicID, State: requirement.State, Phase: requirement.Phase,
		Status: requirement.Status, ArchiveOutcome: cloneStringPtr(requirement.ArchiveOutcome),
		DuplicateOfPublicID: cloneStringPtr(requirement.DuplicateOfPublicID), Revision: requirement.Revision,
		Card: RequirementEventCard{CardID: "echo_req_" + strings.ToLower(requirement.PublicID), CardType: CardTypeRequirementStatus, SchemaVersion: CardSchemaVersion, FallbackText: fallback},
	}
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func emptyStats() RequirementStats {
	return RequirementStats{ByPhase: map[string]int64{}, ByStatus: map[string]int64{}}
}
func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
func stringPtr(value string) *string { return &value }
func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func cloneStringPtr(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func truncateCardText(value string, maxCodePoints, maxBytes int) string {
	if utf8.RuneCountInString(value) <= maxCodePoints && len([]byte(value)) <= maxBytes {
		return value
	}
	result := ""
	for _, point := range value {
		candidate := result + string(point)
		if utf8.RuneCountInString(candidate) >= maxCodePoints || len([]byte(candidate+"…")) > maxBytes {
			break
		}
		result = candidate
	}
	return result + "…"
}

func truncatePtrWithBytes(value *string, maxCodePoints, maxBytes int) any {
	if value == nil {
		return nil
	}
	return truncateCardText(*value, maxCodePoints, maxBytes)
}

func trimNodeSpace(value string) string {
	// ECMAScript trim includes BOM, but excludes NEXT LINE (U+0085).
	return strings.TrimFunc(value, func(r rune) bool {
		return r == '\ufeff' || (r != '\u0085' && unicode.IsSpace(r))
	})
}
