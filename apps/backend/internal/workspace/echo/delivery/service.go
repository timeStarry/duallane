package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type rollbackOperation struct {
	code string
	err  error
}

func (e *rollbackOperation) Error() string {
	if e == nil {
		return ""
	}
	if e.err != nil {
		return e.err.Error()
	}
	return e.code
}

func (e *rollbackOperation) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

type staleProjection struct{}

func (staleProjection) Error() string { return "echo.delivery_projection_stale" }

var (
	echoIdentifierPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	solicitationPublicIDPattern = regexp.MustCompile(`^SOL-[0-9]{4}-[0-9]{4}$`)
	requirementPublicIDPattern  = regexp.MustCompile(`^REQ-[0-9]{4}-[0-9]{4}$`)
)

func NewService(options ServiceOptions) *Service {
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	delays := append([]time.Duration(nil), options.RetryDelays...)
	if len(delays) == 0 {
		delays = append(delays, DefaultRetryDelays[:]...)
	}
	for index := range delays {
		if delays[index] < 0 {
			delays[index] = 0
		}
	}
	maxAttempts := options.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = len(delays) + 1
	}
	lease := options.LeaseTimeout
	if lease <= 0 {
		lease = DefaultLeaseTimeout
	}
	batch := options.BatchLimit
	if batch <= 0 || batch > DefaultBatchLimit {
		batch = DefaultBatchLimit
	}
	requirementLimit := options.RequirementLimit
	if requirementLimit <= 0 || requirementLimit > DefaultRequirementLimit {
		requirementLimit = DefaultRequirementLimit
	}
	return &Service{
		repo: options.Repository, spaceID: spaceID, now: now, writer: options.Writer,
		solicitationProjector: options.SolicitationProjector,
		requirementProjector:  options.RequirementProjector,
		releaseProjector:      options.ReleaseProjector,
		retryDelays:           delays, maxAttempts: maxAttempts, leaseTimeout: lease,
		batchLimit: batch, requirementLimit: requirementLimit,
	}
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

func (s *Service) space(value string) string {
	if value = strings.TrimSpace(value); value != "" {
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

func (s *Service) SyncSolicitation(ctx context.Context, input SyncInput) (DeliverySummary, error) {
	if s == nil || s.repo == nil {
		return DeliverySummary{}, internalError("sync echo solicitation delivery", errors.New("repository is required"))
	}
	publicID := normalizeSolicitationPublicID(input.PublicID)
	if publicID == "" {
		return DeliverySummary{}, NewError("echo.solicitation_id_invalid", "征集编号无效", 400)
	}
	spaceID := s.space(input.SpaceID)
	source, err := s.repo.GetSolicitation(ctx, spaceID, publicID)
	if err != nil {
		return DeliverySummary{}, internalError("read echo solicitation", err)
	}
	if source == nil {
		return DeliverySummary{}, notFoundError("echo.solicitation_not_found", "征集不存在")
	}
	rows, err := s.repo.ListSolicitationDeliveries(ctx, spaceID, publicID, strings.TrimSpace(input.RecipientUserID), s.batchLimit)
	if err != nil {
		return DeliverySummary{}, internalError("list echo solicitation deliveries", err)
	}
	if len(rows) == 0 && source.DeliveryPolicy != solicitations.DeliveryPolicyNone {
		if err := s.repo.EnsureSolicitationDeliveryRows(ctx, spaceID, publicID, s.nowUTC()); err != nil {
			return DeliverySummary{}, internalError("reconcile echo solicitation deliveries", err)
		}
		rows, err = s.repo.ListSolicitationDeliveries(ctx, spaceID, publicID, strings.TrimSpace(input.RecipientUserID), s.batchLimit)
		if err != nil {
			return DeliverySummary{}, internalError("reload echo solicitation deliveries", err)
		}
	}
	results := make([]DeliveryResult, 0, len(rows))
	for _, row := range rows {
		result, err := s.deliverSolicitation(ctx, row, input, 0)
		if err != nil {
			return DeliverySummary{}, err
		}
		results = append(results, result)
	}
	return summarize(DeliveryTypeSolicitation, publicID, results), nil
}

func (s *Service) SyncSolicitationByID(ctx context.Context, input SyncInput) (DeliverySummary, error) {
	if s == nil || s.repo == nil {
		return DeliverySummary{}, internalError("sync echo solicitation delivery", errors.New("repository is required"))
	}
	spaceID := s.space(input.SpaceID)
	solicitationID := normalizeEchoIdentifier(input.SolicitationID)
	if solicitationID == "" {
		return DeliverySummary{}, NewError("echo.identifier_invalid", "Echo 标识无效", 400)
	}
	row, err := s.repo.GetSolicitationByID(ctx, spaceID, solicitationID)
	if err != nil {
		return DeliverySummary{}, internalError("read echo solicitation", err)
	}
	if row == nil {
		return DeliverySummary{}, notFoundError("echo.solicitation_not_found", "征集不存在")
	}
	input.PublicID = row.PublicID
	return s.SyncSolicitation(ctx, input)
}

// DeliverSolicitation and its siblings keep the worker-facing names aligned
// with the Node coordinator while retaining one delivery coordinator and one
// transaction boundary for every card/message write.
func (s *Service) DeliverSolicitation(ctx context.Context, input SyncInput) (DeliverySummary, error) {
	return s.SyncSolicitation(ctx, input)
}

func (s *Service) DeliverSolicitationByID(ctx context.Context, input SyncInput) (DeliverySummary, error) {
	return s.SyncSolicitationByID(ctx, input)
}

func (s *Service) DeliverRequirement(ctx context.Context, input SyncInput) (DeliverySummary, error) {
	return s.SyncRequirement(ctx, input)
}

func (s *Service) DeliverRelease(ctx context.Context, input SyncInput) (DeliverySummary, error) {
	return s.SyncRelease(ctx, input)
}

func (s *Service) SyncRequirement(ctx context.Context, input SyncInput) (DeliverySummary, error) {
	if s == nil || s.repo == nil {
		return DeliverySummary{}, internalError("sync echo requirement delivery", errors.New("repository is required"))
	}
	publicID := normalizeRequirementPublicID(input.PublicID)
	if publicID == "" {
		return DeliverySummary{}, NewError("echo.requirement_id_invalid", "需求编号无效", 400)
	}
	spaceID := s.space(input.SpaceID)
	requirement, err := s.repo.GetRequirement(ctx, spaceID, publicID)
	if err != nil {
		return DeliverySummary{}, internalError("read echo requirement", err)
	}
	if requirement == nil {
		return DeliverySummary{}, notFoundError("echo.requirement_not_found", "需求不存在")
	}
	recipients, err := s.requirementRecipients(ctx, spaceID, requirement, strings.TrimSpace(input.RecipientUserID))
	if err != nil {
		return DeliverySummary{}, err
	}
	results := make([]DeliveryResult, 0, len(recipients)*2)
	for _, recipient := range recipients {
		cardTypes := []string{CardTypeStatus}
		if recipient.owner {
			cardTypes = []string{CardTypeRequest}
		}
		if strings.TrimSpace(input.CardType) != "" {
			cardTypes = []string{strings.TrimSpace(input.CardType)}
		}
		for _, cardType := range cardTypes {
			result, err := s.deliverRequirement(ctx, *requirement, recipient.id, cardType, input)
			if err != nil {
				return DeliverySummary{}, err
			}
			results = append(results, result)
		}
	}
	return summarize(DeliveryTypeRequirement, publicID, results), nil
}

func (s *Service) SyncRelease(ctx context.Context, input SyncInput) (DeliverySummary, error) {
	if s == nil || s.repo == nil {
		return DeliverySummary{}, internalError("sync echo release delivery", errors.New("repository is required"))
	}
	version := normalizeReleaseVersion(input.Version)
	if version == "" {
		return DeliverySummary{}, NewError("echo.release_version_invalid", "版本号无效", 422)
	}
	spaceID := s.space(input.SpaceID)
	rows, err := s.repo.ListReleaseDeliveries(ctx, spaceID, version, strings.TrimSpace(input.RecipientUserID), s.batchLimit)
	if err != nil {
		return DeliverySummary{}, internalError("list echo release deliveries", err)
	}
	results := make([]DeliveryResult, 0, len(rows))
	for _, row := range rows {
		result, err := s.deliverRelease(ctx, row, input)
		if err != nil {
			return DeliverySummary{}, err
		}
		results = append(results, result)
	}
	return summarize(DeliveryTypeRelease, version, results), nil
}

func (s *Service) SyncMember(ctx context.Context, spaceID, userID string, meta auth.RequestMeta) (MemberSyncResult, error) {
	if s == nil || s.repo == nil {
		return MemberSyncResult{}, internalError("sync echo member delivery", errors.New("repository is required"))
	}
	spaceID = s.space(spaceID)
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return MemberSyncResult{}, NewError("echo.recipient_ineligible", "收件人不属于空间", 404)
	}
	active, err := s.repo.IsActiveHumanMember(ctx, spaceID, userID)
	if err != nil {
		return MemberSyncResult{}, internalError("check echo member", err)
	}
	result := MemberSyncResult{RecipientUserID: userID, Solicitations: []DeliveryResult{}, Requirements: []DeliveryResult{}, Releases: []DeliveryResult{}}
	if !active {
		return result, nil
	}
	if err := s.repo.EnsureSolicitationDeliveryRowsForMember(ctx, spaceID, userID, s.nowUTC()); err != nil {
		return MemberSyncResult{}, internalError("backfill echo solicitation deliveries", err)
	}
	rows, err := s.repo.ListSolicitationDeliveries(ctx, spaceID, "", userID, s.batchLimit)
	if err != nil {
		return MemberSyncResult{}, internalError("list member echo solicitation deliveries", err)
	}
	for _, row := range rows {
		if row.SolicitationStatus != solicitations.StatusOpen && row.SolicitationStatus != solicitations.StatusClosed && row.Status == DeliverySent {
			continue
		}
		item, err := s.deliverSolicitation(ctx, row, SyncInput{SpaceID: spaceID, RecipientUserID: userID, Meta: meta}, 0)
		if err != nil {
			return MemberSyncResult{}, err
		}
		result.Solicitations = append(result.Solicitations, item)
	}
	owners, err := s.repo.ListActiveOwners(ctx, spaceID)
	if err != nil {
		return MemberSyncResult{}, internalError("list Echo owners", err)
	}
	isOwner := contains(owners, userID)
	requirementsForMember, err := s.repo.ListRequirementsForMember(ctx, spaceID, userID, isOwner, s.requirementLimit)
	if err != nil {
		return MemberSyncResult{}, internalError("list member Echo requirements", err)
	}
	for _, requirement := range requirementsForMember {
		cardType := CardTypeStatus
		if isOwner {
			cardType = CardTypeRequest
		}
		item, err := s.deliverRequirement(ctx, requirement, userID, cardType, SyncInput{SpaceID: spaceID, RecipientUserID: userID, Meta: meta})
		if err != nil {
			return MemberSyncResult{}, err
		}
		result.Requirements = append(result.Requirements, item)
	}
	return result, nil
}

func (s *Service) BackfillMember(ctx context.Context, spaceID, userID string, meta auth.RequestMeta) (MemberSyncResult, error) {
	return s.SyncMember(ctx, spaceID, userID, meta)
}

// ProcessJobs is the durable worker entry point. It claims bounded rows with
// SKIP LOCKED, re-checks membership and source authorization, then commits
// internal card/message delivery only with the delivery state transition.
func (s *Service) ProcessJobs(ctx context.Context) (ProcessReport, error) {
	return s.ProcessJobsWithOptions(ctx, ProcessOptions{})
}

func (s *Service) ProcessJobsWithOptions(ctx context.Context, options ProcessOptions) (ProcessReport, error) {
	if s == nil || s.repo == nil {
		return ProcessReport{}, internalError("process Echo delivery jobs", errors.New("repository is required"))
	}
	if ctx == nil {
		return ProcessReport{}, internalError("process Echo delivery jobs", errors.New("context is required"))
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if options.Family != "" && options.Family != DeliveryTypeSolicitation && options.Family != DeliveryTypeRequirement && options.Family != DeliveryTypeRelease {
		return ProcessReport{}, NewError("echo.delivery_family_invalid", "投递类型无效", 500)
	}
	limit := options.Limit
	if limit <= 0 || limit > s.batchLimit {
		limit = s.batchLimit
	}
	requirementLimit := options.RequirementLimit
	if requirementLimit <= 0 || requirementLimit > s.requirementLimit {
		requirementLimit = s.requirementLimit
	}
	spaceID := s.spaceID
	report := ProcessReport{Solicitations: []DeliveryResult{}, Requirements: []DeliverySummary{}, Releases: []DeliveryResult{}, Next: options.Cursor}
	var firstErr error
	recordError := func(err error) {
		if firstErr == nil && err != nil {
			firstErr = err
		}
	}
	if options.Family == "" || options.Family == DeliveryTypeSolicitation {
		solicitationRows, err := s.repo.ListSolicitationWork(ctx, spaceID, options.Cursor.Solicitation, limit)
		if err != nil {
			return report, internalError("list Echo solicitation jobs", err)
		}
		for _, row := range solicitationRows {
			if err := ctx.Err(); err != nil {
				return report, err
			}
			item, err := s.deliverSolicitation(ctx, row, SyncInput{SpaceID: spaceID}, 0)
			if ctx.Err() != nil {
				return report, ctx.Err()
			}
			if err != nil {
				recordError(err)
				item = resultFromRow(row, DeliveryFailed, "", "", false, errorCode(err))
			}
			report.Solicitations = append(report.Solicitations, item)
			report.Next.Solicitation = row.ID
		}
		if len(solicitationRows) < limit {
			report.Next.Solicitation = ""
		}
	}
	if options.Family == "" || options.Family == DeliveryTypeRequirement {
		requirementRows, err := s.repo.ListRequirementsForRecovery(ctx, spaceID, options.Cursor.Requirement, requirementLimit)
		if err != nil {
			return report, internalError("list Echo requirement jobs", err)
		}
		for _, requirement := range requirementRows {
			if err := ctx.Err(); err != nil {
				return report, err
			}
			summary, err := s.SyncRequirement(ctx, SyncInput{SpaceID: spaceID, PublicID: requirement.PublicID})
			if ctx.Err() != nil {
				return report, ctx.Err()
			}
			report.Next.Requirement = requirement.ID
			if err != nil {
				recordError(err)
				report.Requirements = append(report.Requirements, DeliverySummary{Type: DeliveryTypeRequirement, Key: requirement.PublicID, Results: []DeliveryResult{{Status: DeliveryFailed, ErrorCode: errorCode(err)}}, Failed: 1})
				continue
			}
			report.Requirements = append(report.Requirements, summary)
		}
		if len(requirementRows) < requirementLimit {
			report.Next.Requirement = ""
		}
	}
	if options.Family == "" || options.Family == DeliveryTypeRelease {
		releaseRows, err := s.repo.ListReleaseWork(ctx, spaceID, options.Cursor.Release, limit)
		if err != nil {
			return report, internalError("list Echo release jobs", err)
		}
		for _, row := range releaseRows {
			if err := ctx.Err(); err != nil {
				return report, err
			}
			item, err := s.deliverRelease(ctx, row, SyncInput{SpaceID: spaceID})
			if ctx.Err() != nil {
				return report, ctx.Err()
			}
			if err != nil {
				recordError(err)
				item = resultFromRelease(row, DeliveryFailed, "", "", false, errorCode(err))
			}
			report.Releases = append(report.Releases, item)
			report.Next.Release = row.ID
		}
		if len(releaseRows) < limit {
			report.Next.Release = ""
		}
	}
	return report, firstErr
}

func (s *Service) Recover(ctx context.Context) (ProcessReport, error) {
	return s.ProcessJobs(ctx)
}

func (s *Service) HandleWorkspaceEvent(ctx context.Context, event WorkspaceEvent) (any, error) {
	spaceID := s.space(event.SpaceID)
	key := event.normalizedTargetID()
	switch event.Type {
	case "workspace.member_joined", "workspace.member_updated":
		userID := event.payloadString("userId")
		if userID == "" {
			userID = event.TargetID
		}
		return s.SyncMember(ctx, spaceID, userID, auth.RequestMeta{})
	case "echo.solicitation.updated", "echo.solicitation.published", "echo.solicitation.closed", "echo.solicitation.withdrawn":
		return s.SyncSolicitation(ctx, SyncInput{SpaceID: spaceID, PublicID: key})
	case "echo.requirement.updated", "echo.requirement.submitted", "echo.requirement.transitioned":
		return s.SyncRequirement(ctx, SyncInput{SpaceID: spaceID, PublicID: key})
	default:
		return nil, nil
	}
}

type requirementRecipient struct {
	id    string
	owner bool
}

func (s *Service) requirementRecipients(ctx context.Context, spaceID string, requirement *RequirementRecord, onlyUserID string) ([]requirementRecipient, error) {
	if requirement == nil {
		return nil, notFoundError("echo.requirement_not_found", "需求不存在")
	}
	owners, err := s.repo.ListActiveOwners(ctx, spaceID)
	if err != nil {
		return nil, internalError("list Echo requirement owners", err)
	}
	result := make([]requirementRecipient, 0, len(owners)+1)
	if requirement.SubmitterUserID != "" && (onlyUserID == "" || onlyUserID == requirement.SubmitterUserID) {
		active, err := s.repo.IsActiveHumanMember(ctx, spaceID, requirement.SubmitterUserID)
		if err != nil {
			return nil, internalError("check Echo submitter membership", err)
		}
		if active {
			result = append(result, requirementRecipient{id: requirement.SubmitterUserID, owner: contains(owners, requirement.SubmitterUserID)})
		}
	}
	for _, ownerID := range owners {
		if onlyUserID != "" && onlyUserID != ownerID {
			continue
		}
		if !containsRecipient(result, ownerID) {
			result = append(result, requirementRecipient{id: ownerID, owner: true})
		}
	}
	return result, nil
}

func (s *Service) deliverSolicitation(ctx context.Context, row SolicitationDelivery, input SyncInput, refreshAttempt int) (DeliveryResult, error) {
	if row.ID == "" {
		return DeliveryResult{Status: DeliverySkipped, ErrorCode: "echo.delivery_not_found"}, nil
	}
	spaceID := s.space(input.SpaceID)
	active, err := s.repo.IsActiveHumanMember(ctx, spaceID, row.RecipientUserID)
	if err != nil {
		return DeliveryResult{}, internalError("check Echo solicitation recipient", err)
	}
	if !active {
		if row.Status == DeliverySkipped && !input.Force {
			return resultFromRow(row, DeliverySkipped, "", "", false, firstError(row.LastErrorCode, "echo.recipient_ineligible")), nil
		}
		return s.commitSolicitationStatus(ctx, row, DeliverySkipped, "echo.recipient_ineligible", input.Meta)
	}
	if row.Status == DeliverySent && !input.Force {
		existing, err := s.repo.FindCard(ctx, spaceID, solicitationSourceID(row), CardTypeSol)
		if err != nil {
			return DeliveryResult{}, internalError("read Echo solicitation card", err)
		}
		if existing != nil && existing.Status == string(cards.StatusActive) && cardDomainRevision(existing.PayloadJSON, existing.Revision) >= row.Revision {
			return resultFromRow(row, DeliverySent, existing.ID, "", true, ""), nil
		}
	}
	if row.Status == DeliveryFailed && !s.retryDue(row.UpdatedAt, row.AttemptCount, s.nowUTC()) {
		return resultFromRow(row, DeliveryFailed, "", "", false, firstError(row.LastErrorCode, "echo.delivery_retry_pending")), nil
	}
	if row.AttemptCount >= s.maxAttempts && row.Status != DeliverySent {
		return resultFromRow(row, DeliveryFailed, "", "", false, firstError(row.LastErrorCode, "echo.delivery_attempts_exhausted")), nil
	}

	source, err := s.repo.GetSolicitation(ctx, spaceID, row.PublicID)
	if err != nil {
		return DeliveryResult{}, internalError("read current Echo solicitation", err)
	}
	if source == nil {
		return s.failSolicitation(ctx, row, "echo.solicitation_not_found", input.Meta)
	}
	if source.Revision != row.Revision {
		row.Revision = source.Revision
		row.SolicitationStatus = source.SolicitationStatus
		row.DeliveryPolicy = source.DeliveryPolicy
		row.SolicitationUpdatedAt = source.SolicitationUpdatedAt
	}
	projection, err := s.projectSolicitation(ctx, spaceID, row.RecipientUserID, row.PublicID, input.Meta)
	if err != nil {
		return s.failSolicitation(ctx, row, errorCode(err), input.Meta)
	}
	normalized, err := normalizeProjection(projection, row.PublicID, DeliveryTypeSolicitation)
	if err != nil {
		return s.failSolicitation(ctx, row, errorCode(err), input.Meta)
	}
	normalized.Block.CardID = "card_echo_" + stableToken(solicitationSourceID(row))
	if refreshAttempt > 1 {
		return s.failSolicitation(ctx, row, "echo.delivery_projection_stale", input.Meta)
	}

	var result DeliveryResult
	err = s.withLease(ctx, func(ctx context.Context, tx Tx) error {
		current, claimed, claimErr := tx.ClaimSolicitationDelivery(ctx, spaceID, row.ID)
		if claimErr != nil {
			return claimErr
		}
		if !claimed || current == nil {
			result = resultFromRow(row, DeliverySkipped, "", "", false, "echo.delivery_claim_unavailable")
			return nil
		}
		active, err := tx.IsActiveHumanMember(ctx, spaceID, current.RecipientUserID)
		if err != nil {
			return err
		}
		if !active {
			if current.Status == DeliverySkipped && !input.Force {
				result = resultFromRow(*current, DeliverySkipped, "", "", false, firstError(current.LastErrorCode, "echo.recipient_ineligible"))
				return nil
			}
			if err := tx.MarkSolicitationDelivery(ctx, spaceID, current.ID, DeliverySkipped, "echo.recipient_ineligible", s.nowUTC()); err != nil {
				return err
			}
			if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.delivery", DeliverySkipped, "echo.recipient_ineligible", input.Meta, "", ""); err != nil {
				return err
			}
			result = resultFromRow(*current, DeliverySkipped, "", "", false, "echo.recipient_ineligible")
			return nil
		}
		if current.Status == DeliveryFailed && !s.retryDue(current.UpdatedAt, current.AttemptCount, s.nowUTC()) {
			result = resultFromRow(*current, DeliveryFailed, "", "", false, firstError(current.LastErrorCode, "echo.delivery_retry_pending"))
			return nil
		}
		if current.AttemptCount >= s.maxAttempts && current.Status != DeliverySent {
			result = resultFromRow(*current, DeliveryFailed, "", "", false, firstError(current.LastErrorCode, "echo.delivery_attempts_exhausted"))
			return nil
		}
		if current.Status == DeliverySent && !input.Force {
			existing, err := tx.FindCard(ctx, spaceID, solicitationSourceID(*current), CardTypeSol)
			if err != nil {
				return err
			}
			if existing != nil && existing.Status == string(cards.StatusActive) && cardDomainRevision(existing.PayloadJSON, existing.Revision) >= current.Revision {
				result = resultFromRow(*current, DeliverySent, existing.ID, "", true, "")
				return nil
			}
		}
		fresh, err := tx.GetSolicitation(ctx, spaceID, current.PublicID)
		if err != nil {
			return err
		}
		if fresh == nil {
			return &rollbackOperation{code: "echo.solicitation_not_found", err: errors.New("solicitation disappeared")}
		}
		if fresh.Revision != row.Revision {
			return staleProjection{}
		}
		echoActive, err := tx.EchoIdentityActive(ctx, spaceID)
		if err != nil {
			return err
		}
		if !echoActive {
			return &rollbackOperation{code: "echo.identity_unavailable", err: errors.New("echo identity is not active")}
		}
		conversation, err := tx.EnsureEchoDirectConversation(ctx, spaceID, current.RecipientUserID, EchoUserID, s.nowUTC())
		if err != nil {
			if errorCode(err) == "echo.recipient_ineligible" {
				if err := tx.MarkSolicitationDelivery(ctx, spaceID, current.ID, DeliverySkipped, "echo.recipient_ineligible", s.nowUTC()); err != nil {
					return err
				}
				if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.delivery", DeliverySkipped, "echo.recipient_ineligible", input.Meta, "", ""); err != nil {
					return err
				}
				result = resultFromRow(*current, DeliverySkipped, "", "", false, "echo.recipient_ineligible")
				return nil
			}
			return &rollbackOperation{code: errorCode(err), err: err}
		}
		if s.writer == nil {
			return &rollbackOperation{code: "echo.writer_unavailable", err: errors.New("echo writer is required")}
		}
		writeResult, err := s.writer.WriteEchoCardAndMessageInTx(ctx, tx, CardMessageWriteInput{
			SpaceID: spaceID, ConversationID: conversation.ID, RecipientUserID: current.RecipientUserID,
			CardID: normalized.Block.CardID, CardType: normalized.Block.CardType,
			SchemaVersion: normalized.Block.SchemaVersion, FallbackText: normalized.Block.FallbackText,
			Payload: normalized.Payload, SourceID: solicitationSourceID(*current),
			ResourceType: "echo.solicitation", ResourceID: current.PublicID,
			DomainRevision: current.Revision, ClientMessageID: solicitationClientID(*current),
			ContentPlainText: normalized.Block.FallbackText, InternalOnly: true, Meta: input.Meta.Safe(),
		})
		if err != nil {
			return &rollbackOperation{code: errorCode(err), err: err}
		}
		if err := tx.MarkSolicitationDelivery(ctx, spaceID, current.ID, DeliverySent, "", s.nowUTC()); err != nil {
			return err
		}
		if !writeResult.Replayed {
			if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.delivery", DeliverySent, "delivered", input.Meta, writeResult.CardID, writeResult.MessageID); err != nil {
				return err
			}
		}
		result = resultFromRow(*current, DeliverySent, writeResult.CardID, writeResult.MessageID, writeResult.Replayed, "")
		return nil
	})
	if err == nil {
		return result, nil
	}
	var stale staleProjection
	if errors.As(err, &stale) {
		freshRow, readErr := s.repo.GetSolicitation(ctx, spaceID, row.PublicID)
		if readErr != nil || freshRow == nil {
			if readErr != nil {
				return DeliveryResult{}, internalError("reload stale Echo solicitation", readErr)
			}
			return s.failSolicitation(ctx, row, "echo.solicitation_not_found", input.Meta)
		}
		return s.deliverSolicitation(ctx, *mergeSolicitationRow(&row, freshRow), input, refreshAttempt+1)
	}
	var rollback *rollbackOperation
	if errors.As(err, &rollback) {
		return s.failSolicitation(ctx, row, rollback.code, input.Meta)
	}
	if isContextError(err) {
		return s.failSolicitation(ctx, row, "echo.delivery_timeout", input.Meta)
	}
	return DeliveryResult{}, internalError("commit Echo solicitation delivery", err)
}

func (s *Service) deliverRequirement(ctx context.Context, requirement RequirementRecord, recipientID, cardType string, input SyncInput) (DeliveryResult, error) {
	return s.deliverRequirementAttempt(ctx, requirement, recipientID, cardType, input, 0)
}

func (s *Service) deliverRequirementAttempt(ctx context.Context, requirement RequirementRecord, recipientID, cardType string, input SyncInput, refreshAttempt int) (DeliveryResult, error) {
	spaceID := s.space(input.SpaceID)
	if cardType != CardTypeRequest && cardType != CardTypeStatus {
		return DeliveryResult{}, NewError("echo.card_type_invalid", "需求卡片类型无效", 422)
	}
	active, err := s.repo.IsActiveHumanMember(ctx, spaceID, recipientID)
	if err != nil {
		return DeliveryResult{}, internalError("check Echo requirement recipient", err)
	}
	if !active {
		return DeliveryResult{Status: DeliverySkipped, RecipientUserID: recipientID, ErrorCode: "echo.recipient_ineligible"}, nil
	}
	projection, err := s.projectRequirement(ctx, spaceID, recipientID, requirement.PublicID, cardType, input.Meta)
	if err != nil {
		return s.failRequirement(ctx, requirement, recipientID, cardType, errorCode(err), input.Meta)
	}
	normalized, err := normalizeProjection(projection, requirement.PublicID, requirementKind(cardType))
	if err != nil {
		return s.failRequirement(ctx, requirement, recipientID, cardType, errorCode(err), input.Meta)
	}
	normalized.Block.CardID = "card_echo_" + stableToken(requirementSourceID(requirement, recipientID, cardType))
	var result DeliveryResult
	err = s.withLease(ctx, func(ctx context.Context, tx Tx) error {
		if err := tx.Lock(ctx, requirementLockKey(requirement.ID, recipientID, cardType)); err != nil {
			return err
		}
		active, err := tx.IsActiveHumanMember(ctx, spaceID, recipientID)
		if err != nil {
			return err
		}
		if !active {
			result = DeliveryResult{Status: DeliverySkipped, RecipientUserID: recipientID, ErrorCode: "echo.recipient_ineligible"}
			return s.writeOutcome(ctx, tx, spaceID, requirement.ID, "echo.requirement.delivery", DeliverySkipped, "echo.recipient_ineligible", input.Meta, "", "")
		}
		fresh, err := tx.GetRequirement(ctx, spaceID, requirement.PublicID)
		if err != nil {
			return err
		}
		if fresh == nil {
			return &rollbackOperation{code: "echo.requirement_not_found", err: errors.New("requirement disappeared")}
		}
		if fresh.Revision != requirement.Revision {
			return staleProjection{}
		}
		allowed, err := tx.RequirementRecipientAuthorized(ctx, spaceID, recipientID, fresh.SubmitterUserID, cardType)
		if err != nil {
			return err
		}
		if !allowed {
			result = DeliveryResult{Status: DeliverySkipped, RecipientUserID: recipientID, ErrorCode: "echo.recipient_ineligible"}
			return s.writeOutcome(ctx, tx, spaceID, requirement.ID, "echo.requirement.delivery", DeliverySkipped, "echo.recipient_ineligible", input.Meta, "", "")
		}
		echoActive, err := tx.EchoIdentityActive(ctx, spaceID)
		if err != nil {
			return err
		}
		if !echoActive {
			return &rollbackOperation{code: "echo.identity_unavailable", err: errors.New("echo identity is not active")}
		}
		conversation, err := tx.EnsureEchoDirectConversation(ctx, spaceID, recipientID, EchoUserID, s.nowUTC())
		if err != nil {
			if errorCode(err) == "echo.recipient_ineligible" {
				result = DeliveryResult{Status: DeliverySkipped, RecipientUserID: recipientID, ErrorCode: "echo.recipient_ineligible"}
				return s.writeOutcome(ctx, tx, spaceID, requirement.ID, "echo.requirement.delivery", DeliverySkipped, "echo.recipient_ineligible", input.Meta, "", "")
			}
			return &rollbackOperation{code: errorCode(err), err: err}
		}
		if s.writer == nil {
			return &rollbackOperation{code: "echo.writer_unavailable", err: errors.New("echo writer is required")}
		}
		writeResult, err := s.writer.WriteEchoCardAndMessageInTx(ctx, tx, CardMessageWriteInput{
			SpaceID: spaceID, ConversationID: conversation.ID, RecipientUserID: recipientID,
			CardID: normalized.Block.CardID, CardType: normalized.Block.CardType,
			SchemaVersion: normalized.Block.SchemaVersion, FallbackText: normalized.Block.FallbackText,
			Payload: normalized.Payload, SourceID: requirementSourceID(requirement, recipientID, cardType),
			ResourceType: "echo.requirement", ResourceID: requirement.PublicID,
			DomainRevision:   requirement.Revision,
			ClientMessageID:  requirementClientID(requirement, recipientID, cardType),
			ContentPlainText: normalized.Block.FallbackText, InternalOnly: true, Meta: input.Meta.Safe(),
		})
		if err != nil {
			return &rollbackOperation{code: errorCode(err), err: err}
		}
		if !writeResult.Replayed {
			if err := s.writeOutcome(ctx, tx, spaceID, requirement.ID, "echo.requirement.delivery", DeliverySent, "delivered", input.Meta, writeResult.CardID, writeResult.MessageID); err != nil {
				return err
			}
		}
		result = DeliveryResult{Status: DeliverySent, RecipientUserID: recipientID, CardID: writeResult.CardID, MessageID: writeResult.MessageID, Replayed: writeResult.Replayed}
		return nil
	})
	if err == nil {
		return result, nil
	}
	var stale staleProjection
	if errors.As(err, &stale) {
		fresh, readErr := s.repo.GetRequirement(ctx, spaceID, requirement.PublicID)
		if readErr != nil || fresh == nil {
			if readErr != nil {
				return DeliveryResult{}, internalError("reload stale Echo requirement", readErr)
			}
			return s.failRequirement(ctx, requirement, recipientID, cardType, "echo.requirement_not_found", input.Meta)
		}
		if refreshAttempt >= 1 {
			return s.failRequirement(ctx, requirement, recipientID, cardType, "echo.delivery_projection_stale", input.Meta)
		}
		return s.deliverRequirementAttempt(ctx, *fresh, recipientID, cardType, input, refreshAttempt+1)
	}
	var rollback *rollbackOperation
	if errors.As(err, &rollback) {
		return s.failRequirement(ctx, requirement, recipientID, cardType, rollback.code, input.Meta)
	}
	if isContextError(err) {
		return s.failRequirement(ctx, requirement, recipientID, cardType, "echo.delivery_timeout", input.Meta)
	}
	return DeliveryResult{}, internalError("commit Echo requirement delivery", err)
}

func (s *Service) deliverRelease(ctx context.Context, row ReleaseDelivery, input SyncInput) (DeliveryResult, error) {
	spaceID := s.space(input.SpaceID)
	active, err := s.repo.IsActiveHumanMember(ctx, spaceID, row.RecipientUserID)
	if err != nil {
		return DeliveryResult{}, internalError("check Echo release recipient", err)
	}
	if !active {
		if row.Status == DeliverySkipped && !input.Force {
			return resultFromRelease(row, DeliverySkipped, "", "", false, firstError(row.LastErrorCode, "echo.recipient_ineligible")), nil
		}
		return s.commitReleaseStatus(ctx, row, DeliverySkipped, "echo.recipient_ineligible", input.Meta)
	}
	if row.Status == DeliverySent && !input.Force {
		existing, err := s.repo.FindCard(ctx, spaceID, releaseSourceID(row), CardTypeRelease)
		if err != nil {
			return DeliveryResult{}, internalError("read Echo release card", err)
		}
		if existing != nil && existing.Status == string(cards.StatusActive) {
			return resultFromRelease(row, DeliverySent, existing.ID, "", true, ""), nil
		}
	}
	if row.Status == DeliveryFailed && !s.retryDue(row.UpdatedAt, row.AttemptCount, s.nowUTC()) {
		return resultFromRelease(row, DeliveryFailed, "", "", false, firstError(row.LastErrorCode, "echo.delivery_retry_pending")), nil
	}
	if row.AttemptCount >= s.maxAttempts && row.Status != DeliverySent {
		return resultFromRelease(row, DeliveryFailed, "", "", false, firstError(row.LastErrorCode, "echo.delivery_attempts_exhausted")), nil
	}
	projection, err := s.projectRelease(ctx, spaceID, row.RecipientUserID, row.PublicationID, row.Version, input.Meta)
	if err != nil {
		return s.failRelease(ctx, row, errorCode(err), input.Meta)
	}
	normalized, err := normalizeProjection(projection, row.Version, DeliveryTypeRelease)
	if err != nil {
		return s.failRelease(ctx, row, errorCode(err), input.Meta)
	}
	normalized.Block.CardID = "card_echo_" + stableToken(releaseSourceID(row))
	var result DeliveryResult
	err = s.withLease(ctx, func(ctx context.Context, tx Tx) error {
		current, claimed, claimErr := tx.ClaimReleaseDelivery(ctx, spaceID, row.ID)
		if claimErr != nil {
			return claimErr
		}
		if !claimed || current == nil {
			result = resultFromRelease(row, DeliverySkipped, "", "", false, "echo.delivery_claim_unavailable")
			return nil
		}
		active, err := tx.IsActiveHumanMember(ctx, spaceID, current.RecipientUserID)
		if err != nil {
			return err
		}
		if !active {
			if current.Status == DeliverySkipped && !input.Force {
				result = resultFromRelease(*current, DeliverySkipped, "", "", false, firstError(current.LastErrorCode, "echo.recipient_ineligible"))
				return nil
			}
			if err := tx.MarkReleaseDelivery(ctx, spaceID, current.ID, DeliverySkipped, "echo.recipient_ineligible", s.nowUTC()); err != nil {
				return err
			}
			if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.release.delivery", DeliverySkipped, "echo.recipient_ineligible", input.Meta, "", ""); err != nil {
				return err
			}
			result = resultFromRelease(*current, DeliverySkipped, "", "", false, "echo.recipient_ineligible")
			return nil
		}
		if current.Status == DeliveryFailed && !s.retryDue(current.UpdatedAt, current.AttemptCount, s.nowUTC()) {
			result = resultFromRelease(*current, DeliveryFailed, "", "", false, firstError(current.LastErrorCode, "echo.delivery_retry_pending"))
			return nil
		}
		if current.AttemptCount >= s.maxAttempts && current.Status != DeliverySent {
			result = resultFromRelease(*current, DeliveryFailed, "", "", false, firstError(current.LastErrorCode, "echo.delivery_attempts_exhausted"))
			return nil
		}
		if current.Status == DeliverySent && !input.Force {
			existing, err := tx.FindCard(ctx, spaceID, releaseSourceID(*current), CardTypeRelease)
			if err != nil {
				return err
			}
			if existing != nil && existing.Status == string(cards.StatusActive) {
				result = resultFromRelease(*current, DeliverySent, existing.ID, "", true, "")
				return nil
			}
		}
		echoActive, err := tx.EchoIdentityActive(ctx, spaceID)
		if err != nil {
			return err
		}
		if !echoActive {
			return &rollbackOperation{code: "echo.identity_unavailable", err: errors.New("echo identity is not active")}
		}
		conversation, err := tx.EnsureEchoDirectConversation(ctx, spaceID, current.RecipientUserID, EchoUserID, s.nowUTC())
		if err != nil {
			if errorCode(err) == "echo.recipient_ineligible" {
				if err := tx.MarkReleaseDelivery(ctx, spaceID, current.ID, DeliverySkipped, "echo.recipient_ineligible", s.nowUTC()); err != nil {
					return err
				}
				if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.release.delivery", DeliverySkipped, "echo.recipient_ineligible", input.Meta, "", ""); err != nil {
					return err
				}
				result = resultFromRelease(*current, DeliverySkipped, "", "", false, "echo.recipient_ineligible")
				return nil
			}
			return &rollbackOperation{code: errorCode(err), err: err}
		}
		if s.writer == nil {
			return &rollbackOperation{code: "echo.writer_unavailable", err: errors.New("echo writer is required")}
		}
		writeResult, err := s.writer.WriteEchoCardAndMessageInTx(ctx, tx, CardMessageWriteInput{
			SpaceID: spaceID, ConversationID: conversation.ID, RecipientUserID: current.RecipientUserID,
			CardID: normalized.Block.CardID, CardType: normalized.Block.CardType,
			SchemaVersion: normalized.Block.SchemaVersion, FallbackText: normalized.Block.FallbackText,
			Payload: normalized.Payload, SourceID: releaseSourceID(*current),
			ResourceType: "echo.release", ResourceID: current.Version,
			DomainRevision: 1, ClientMessageID: releaseClientID(*current),
			ContentPlainText: normalized.Block.FallbackText, InternalOnly: true, Meta: input.Meta.Safe(),
		})
		if err != nil {
			return &rollbackOperation{code: errorCode(err), err: err}
		}
		if err := tx.MarkReleaseDelivery(ctx, spaceID, current.ID, DeliverySent, "", s.nowUTC()); err != nil {
			return err
		}
		if !writeResult.Replayed {
			if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.release.delivery", DeliverySent, "delivered", input.Meta, writeResult.CardID, writeResult.MessageID); err != nil {
				return err
			}
		}
		result = resultFromRelease(*current, DeliverySent, writeResult.CardID, writeResult.MessageID, writeResult.Replayed, "")
		return nil
	})
	if err == nil {
		return result, nil
	}
	var rollback *rollbackOperation
	if errors.As(err, &rollback) {
		return s.failRelease(ctx, row, rollback.code, input.Meta)
	}
	if isContextError(err) {
		return s.failRelease(ctx, row, "echo.delivery_timeout", input.Meta)
	}
	return DeliveryResult{}, internalError("commit Echo release delivery", err)
}

func (s *Service) projectSolicitation(ctx context.Context, spaceID, recipientID, publicID string, meta auth.RequestMeta) (Projection, error) {
	if s.solicitationProjector == nil {
		return Projection{}, NewError("echo.solicitation_unavailable", "征集服务尚未初始化", 503)
	}
	value, err := s.solicitationProjector.ProjectCard(ctx, solicitations.GetInput{ActorID: recipientID, SpaceID: spaceID, PublicID: publicID, Meta: meta.Safe()})
	if err != nil {
		return Projection{}, err
	}
	if value == nil {
		return Projection{}, NewError("echo.card_projection_invalid", "Echo 卡片投影无效", 422)
	}
	return Projection{Block: CardBlock{Type: value.Block.Type, CardID: value.Block.CardID, CardType: value.Block.CardType, SchemaVersion: value.Block.SchemaVersion, FallbackText: value.Block.FallbackText}, Payload: value.Payload}, nil
}

func (s *Service) projectRequirement(ctx context.Context, spaceID, recipientID, publicID, cardType string, meta auth.RequestMeta) (Projection, error) {
	if s.requirementProjector == nil {
		return Projection{}, NewError("echo.requirement_unavailable", "需求服务尚未初始化", 503)
	}
	value, err := s.requirementProjector.ProjectCard(ctx, requirements.GetInput{ActorID: recipientID, SpaceID: spaceID, PublicID: publicID, CardType: cardType, Meta: meta.Safe()})
	if err != nil {
		return Projection{}, err
	}
	if value == nil {
		return Projection{}, NewError("echo.card_projection_invalid", "Echo 卡片投影无效", 422)
	}
	return Projection{Block: CardBlock{Type: value.Block.Type, CardID: value.Block.CardID, CardType: value.Block.CardType, SchemaVersion: value.Block.SchemaVersion, FallbackText: value.Block.FallbackText}, Payload: value.Payload}, nil
}

func (s *Service) projectRelease(ctx context.Context, spaceID, recipientID, publicationID, version string, meta auth.RequestMeta) (Projection, error) {
	if s.releaseProjector == nil {
		return Projection{}, NewError("echo.release_unavailable", "版本发布服务尚未初始化", 503)
	}
	value, err := s.releaseProjector.ProjectCard(ctx, ReleaseProjectInput{ActorID: recipientID, SpaceID: spaceID, PublicationID: publicationID, Version: version, Meta: meta.Safe()})
	if err != nil {
		return Projection{}, err
	}
	if value == nil {
		return Projection{}, NewError("echo.card_projection_invalid", "Echo 卡片投影无效", 422)
	}
	return Projection{Block: CardBlock{Type: value.Block.Type, CardID: value.Block.CardID, CardType: value.Block.CardType, SchemaVersion: value.Block.SchemaVersion, FallbackText: value.Block.FallbackText}, Payload: value.Payload}, nil
}

func (s *Service) commitSolicitationStatus(ctx context.Context, row SolicitationDelivery, status, code string, meta auth.RequestMeta) (DeliveryResult, error) {
	var result DeliveryResult
	err := s.withLease(ctx, func(ctx context.Context, tx Tx) error {
		current, claimed, err := tx.ClaimSolicitationDelivery(ctx, s.space(row.SpaceID), row.ID)
		if err != nil {
			return err
		}
		if !claimed || current == nil {
			result = resultFromRow(row, status, "", "", false, "echo.delivery_claim_unavailable")
			return nil
		}
		if err := tx.MarkSolicitationDelivery(ctx, current.SpaceID, current.ID, status, code, s.nowUTC()); err != nil {
			return err
		}
		if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.solicitation.delivery", status, code, meta, "", ""); err != nil {
			return err
		}
		result = resultFromRow(*current, status, "", "", false, code)
		return nil
	})
	if err != nil {
		return DeliveryResult{}, internalError("record Echo solicitation delivery state", err)
	}
	return result, nil
}

func (s *Service) commitReleaseStatus(ctx context.Context, row ReleaseDelivery, status, code string, meta auth.RequestMeta) (DeliveryResult, error) {
	var result DeliveryResult
	err := s.withLease(ctx, func(ctx context.Context, tx Tx) error {
		current, claimed, err := tx.ClaimReleaseDelivery(ctx, s.space(row.SpaceID), row.ID)
		if err != nil {
			return err
		}
		if !claimed || current == nil {
			result = resultFromRelease(row, status, "", "", false, "echo.delivery_claim_unavailable")
			return nil
		}
		if err := tx.MarkReleaseDelivery(ctx, current.SpaceID, current.ID, status, code, s.nowUTC()); err != nil {
			return err
		}
		if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.release.delivery", status, code, meta, "", ""); err != nil {
			return err
		}
		result = resultFromRelease(*current, status, "", "", false, code)
		return nil
	})
	if err != nil {
		return DeliveryResult{}, internalError("record Echo release delivery state", err)
	}
	return result, nil
}

func (s *Service) failSolicitation(ctx context.Context, row SolicitationDelivery, code string, meta auth.RequestMeta) (DeliveryResult, error) {
	code = safeErrorCode(code)
	var result DeliveryResult
	err := s.withLease(ctx, func(ctx context.Context, tx Tx) error {
		current, claimed, err := tx.ClaimSolicitationDelivery(ctx, s.space(row.SpaceID), row.ID)
		if err != nil {
			return err
		}
		if !claimed || current == nil {
			result = resultFromRow(row, DeliveryFailed, "", "", false, code)
			return nil
		}
		if current.Status == DeliverySent {
			existing, err := tx.FindCard(ctx, current.SpaceID, solicitationSourceID(*current), CardTypeSol)
			if err != nil {
				return err
			}
			cardID := ""
			if existing != nil {
				cardID = existing.ID
			}
			result = resultFromRow(*current, DeliverySent, cardID, "", true, "")
			return nil
		}
		if err := tx.MarkSolicitationDelivery(ctx, current.SpaceID, current.ID, DeliveryFailed, code, s.nowUTC()); err != nil {
			return err
		}
		if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.solicitation.delivery", DeliveryFailed, code, meta, "", ""); err != nil {
			return err
		}
		result = resultFromRow(*current, DeliveryFailed, "", "", false, code)
		return nil
	})
	if err != nil {
		return DeliveryResult{}, internalError("record Echo solicitation failure", err)
	}
	return result, nil
}

func (s *Service) failRelease(ctx context.Context, row ReleaseDelivery, code string, meta auth.RequestMeta) (DeliveryResult, error) {
	code = safeErrorCode(code)
	var result DeliveryResult
	err := s.withLease(ctx, func(ctx context.Context, tx Tx) error {
		current, claimed, err := tx.ClaimReleaseDelivery(ctx, s.space(row.SpaceID), row.ID)
		if err != nil {
			return err
		}
		if !claimed || current == nil {
			result = resultFromRelease(row, DeliveryFailed, "", "", false, code)
			return nil
		}
		if current.Status == DeliverySent {
			existing, err := tx.FindCard(ctx, current.SpaceID, releaseSourceID(*current), CardTypeRelease)
			if err != nil {
				return err
			}
			cardID := ""
			if existing != nil {
				cardID = existing.ID
			}
			result = resultFromRelease(*current, DeliverySent, cardID, "", true, "")
			return nil
		}
		if err := tx.MarkReleaseDelivery(ctx, current.SpaceID, current.ID, DeliveryFailed, code, s.nowUTC()); err != nil {
			return err
		}
		if err := s.writeOutcome(ctx, tx, current.SpaceID, current.ID, "echo.release.delivery", DeliveryFailed, code, meta, "", ""); err != nil {
			return err
		}
		result = resultFromRelease(*current, DeliveryFailed, "", "", false, code)
		return nil
	})
	if err != nil {
		return DeliveryResult{}, internalError("record Echo release failure", err)
	}
	return result, nil
}

func (s *Service) failRequirement(ctx context.Context, requirement RequirementRecord, recipientID, cardType, code string, meta auth.RequestMeta) (DeliveryResult, error) {
	code = safeErrorCode(code)
	result := DeliveryResult{Status: DeliveryFailed, RecipientUserID: recipientID, ErrorCode: code}
	err := s.withLease(ctx, func(ctx context.Context, tx Tx) error {
		if err := tx.Lock(ctx, requirementLockKey(requirement.ID, recipientID, cardType)); err != nil {
			return err
		}
		existing, err := tx.FindCard(ctx, requirement.SpaceID, requirementSourceID(requirement, recipientID, cardType), cardType)
		if err != nil {
			return err
		}
		if existing != nil && existing.Status == string(cards.StatusActive) && cardDomainRevision(existing.PayloadJSON, existing.Revision) >= requirement.Revision {
			result = DeliveryResult{Status: DeliverySent, RecipientUserID: recipientID, CardID: existing.ID, Replayed: true}
			return nil
		}
		return s.writeOutcome(ctx, tx, requirement.SpaceID, requirement.ID, "echo.requirement.delivery", DeliveryFailed, code, meta, "", "")
	})
	if err != nil {
		return DeliveryResult{}, internalError("record Echo requirement failure", err)
	}
	return result, nil
}

func (s *Service) withLease(ctx context.Context, fn func(context.Context, Tx) error) error {
	if s == nil || s.repo == nil {
		return errors.New("echo delivery repository is required")
	}
	leaseCtx, cancel := context.WithTimeout(ctx, s.leaseTimeout)
	defer cancel()
	return s.repo.WithTx(leaseCtx, func(tx Tx) error { return fn(leaseCtx, tx) })
}

func (s *Service) retryDue(updatedAt time.Time, attempts int, current time.Time) bool {
	if attempts >= s.maxAttempts {
		return false
	}
	if attempts <= 0 || len(s.retryDelays) == 0 {
		return true
	}
	index := attempts - 1
	if index >= len(s.retryDelays) {
		index = len(s.retryDelays) - 1
	}
	return !updatedAt.Add(s.retryDelays[index]).After(current)
}

func (s *Service) writeOutcome(ctx context.Context, tx Tx, spaceID, targetID, action, status, code string, meta auth.RequestMeta, cardID, messageID string) error {
	if tx == nil {
		return errors.New("echo delivery transaction is required")
	}
	at := s.nowUTC()
	result := "success"
	eventType := EventDeliverySent
	if status == DeliveryFailed {
		result = "failure"
		eventType = EventDeliveryFailed
	} else if status == DeliverySkipped {
		result = "rejected"
		eventType = EventDeliverySkipped
	}
	actorID := EchoUserID
	actorLogin := EchoGitHubLogin
	// A projection or membership rejection can be recorded while the Echo
	// identity is unavailable. Keep that content-free audit/event evidence
	// durable with nullable actors instead of failing on the users FK.
	identityActive, err := tx.EchoIdentityActive(ctx, spaceID)
	if err != nil {
		return err
	}
	if !identityActive {
		actorID = ""
		actorLogin = ""
	}
	if err := tx.WriteAudit(ctx, AuditInput{
		SpaceID: spaceID, ActorUserID: actorID, ActorGitHubLogin: actorLogin,
		Action: action, TargetType: "echo.delivery", TargetID: targetID,
		Result: result, Reason: safeErrorCode(code), Meta: meta.Safe(), CreatedAt: at,
	}); err != nil {
		return err
	}
	payload := map[string]any{"deliveryId": targetID, "status": status}
	if code != "" {
		payload["errorCode"] = safeErrorCode(code)
	}
	if cardID != "" {
		payload["cardId"] = cardID
	}
	if messageID != "" {
		payload["messageId"] = messageID
	}
	return tx.WriteEvent(ctx, EventInput{
		SpaceID: spaceID, Type: eventType, ActorID: actorID,
		TargetType: "echo.delivery", TargetID: targetID, Payload: payload, CreatedAt: at,
	})
}

func normalizeProjection(input Projection, resourceID, kind string) (Projection, error) {
	block := input.Block
	if strings.TrimSpace(block.Type) == "" {
		block.Type = cards.CardBlockType
	}
	if strings.TrimSpace(block.CardID) == "" {
		block.CardID = "card_echo_" + stableToken(kind+":"+resourceID)
	}
	if block.SchemaVersion == 0 {
		block.SchemaVersion = CardSchemaVersion
	}
	if strings.TrimSpace(block.FallbackText) == "" {
		switch kind {
		case DeliveryTypeRelease:
			block.FallbackText = "DualLane v" + resourceID + " 版本更新"
		case DeliveryTypeRequirementStat:
			block.FallbackText = "回声需求 " + resourceID + " 状态已更新"
		default:
			block.FallbackText = "回声" + map[string]string{DeliveryTypeSolicitation: "征集", DeliveryTypeRequirement: "需求"}[kind] + " " + resourceID
		}
	}
	if kind == DeliveryTypeRequirement || kind == DeliveryTypeRequirementStat {
		if kind == DeliveryTypeRequirementStat {
			block.FallbackText = "回声需求 " + resourceID + " 状态已更新"
		} else {
			block.FallbackText = "回声需求 " + resourceID
		}
	}
	normalized, err := cards.NormalizeCardBlock(cards.CardBlock{
		Type: block.Type, CardID: block.CardID, CardType: block.CardType,
		SchemaVersion: block.SchemaVersion, FallbackText: block.FallbackText,
	})
	if err != nil {
		return Projection{}, NewError("echo.card_projection_invalid", "Echo 卡片引用无效", 422)
	}
	expectedCardType := map[string]string{
		DeliveryTypeSolicitation:    CardTypeSol,
		DeliveryTypeRequirement:     CardTypeRequest,
		DeliveryTypeRequirementStat: CardTypeStatus,
		DeliveryTypeRelease:         CardTypeRelease,
	}[kind]
	if expectedCardType == "" || normalized.CardType != expectedCardType {
		return Projection{}, NewError("echo.card_projection_invalid", "Echo 卡片类型无效", 422)
	}
	return Projection{Block: CardBlock{Type: normalized.Type, CardID: normalized.CardID, CardType: normalized.CardType, SchemaVersion: normalized.SchemaVersion, FallbackText: normalized.FallbackText}, Payload: input.Payload}, nil
}

func cardDomainRevision(payload []byte, fallback int64) int64 {
	var value struct {
		Revision int64 `json:"revision"`
	}
	if len(payload) != 0 && json.Unmarshal(payload, &value) == nil && value.Revision > fallback {
		return value.Revision
	}
	return fallback
}

func solicitationSourceID(row SolicitationDelivery) string {
	return "sol:" + row.SolicitationID + ":" + row.RecipientUserID
}

func solicitationClientID(row SolicitationDelivery) string {
	revision := row.Revision
	if revision <= 0 {
		revision = 1
	}
	return fmt.Sprintf("echo:sol:%s:%s:r%d", row.SolicitationID, row.RecipientUserID, revision)
}

func requirementSourceID(requirement RequirementRecord, recipientID, cardType string) string {
	return "req:" + requirement.ID + ":" + recipientID + ":" + cardType
}

func requirementClientID(requirement RequirementRecord, recipientID, cardType string) string {
	revision := requirement.Revision
	if revision <= 0 {
		revision = 1
	}
	return fmt.Sprintf("echo:req:%s:%s:%s:r%d", requirement.ID, recipientID, cardType, revision)
}

func releaseSourceID(row ReleaseDelivery) string {
	return "release:" + row.PublicationID + ":" + row.RecipientUserID
}

func releaseClientID(row ReleaseDelivery) string {
	return "echo:release:" + row.PublicationID + ":" + row.RecipientUserID
}

func requirementKind(cardType string) string {
	if cardType == CardTypeStatus {
		return DeliveryTypeRequirementStat
	}
	return DeliveryTypeRequirement
}

func requirementLockKey(requirementID, recipientID, cardType string) string {
	return "echo:requirement:" + requirementID + ":" + recipientID + ":" + cardType
}

func mergeSolicitationRow(old, fresh *SolicitationDelivery) *SolicitationDelivery {
	copy := *old
	copy.Revision = fresh.Revision
	copy.SolicitationStatus = fresh.SolicitationStatus
	copy.DeliveryPolicy = fresh.DeliveryPolicy
	copy.SolicitationUpdatedAt = fresh.SolicitationUpdatedAt
	copy.PublicID = fresh.PublicID
	copy.SolicitationID = fresh.SolicitationID
	return &copy
}

func resultFromRow(row SolicitationDelivery, status, cardID, messageID string, replayed bool, code string) DeliveryResult {
	return DeliveryResult{Status: status, DeliveryID: row.ID, RecipientUserID: row.RecipientUserID, CardID: cardID, MessageID: messageID, Replayed: replayed, ErrorCode: code}
}

func resultFromRelease(row ReleaseDelivery, status, cardID, messageID string, replayed bool, code string) DeliveryResult {
	return DeliveryResult{Status: status, DeliveryID: row.ID, RecipientUserID: row.RecipientUserID, CardID: cardID, MessageID: messageID, Replayed: replayed, ErrorCode: code}
}

func summarize(kind, key string, results []DeliveryResult) DeliverySummary {
	result := DeliverySummary{Type: kind, Key: key, Results: results}
	for _, item := range results {
		switch item.Status {
		case DeliverySent:
			result.Sent++
		case DeliveryFailed:
			result.Failed++
		case DeliverySkipped:
			result.Skipped++
		}
	}
	return result
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func containsRecipient(values []requirementRecipient, target string) bool {
	for _, value := range values {
		if value.id == target {
			return true
		}
	}
	return false
}

func normalizeReleaseVersion(value string) string {
	value = strings.TrimSpace(strings.TrimPrefix(strings.ToLower(value), "v"))
	parts := strings.Split(value, ".")
	if len(parts) != 3 || value == "" {
		return ""
	}
	for _, part := range parts {
		if part == "" {
			return ""
		}
		for _, character := range part {
			if character < '0' || character > '9' {
				return ""
			}
		}
	}
	return value
}

func normalizeEchoIdentifier(value string) string {
	value = strings.TrimSpace(value)
	if !echoIdentifierPattern.MatchString(value) {
		return ""
	}
	return value
}

func normalizeSolicitationPublicID(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if !solicitationPublicIDPattern.MatchString(value) {
		return ""
	}
	return value
}

func normalizeRequirementPublicID(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if !requirementPublicIDPattern.MatchString(value) {
		return ""
	}
	return value
}

func firstError(value *string, fallback string) string {
	if value != nil && strings.TrimSpace(*value) != "" {
		return safeErrorCode(*value)
	}
	return fallback
}

func safeErrorCode(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "echo.delivery_failed"
	}
	if len(value) > MaxDeliveryErrorCode {
		return value[:MaxDeliveryErrorCode]
	}
	return value
}

func errorCode(err error) string {
	if err == nil {
		return ""
	}
	var local *Error
	if errors.As(err, &local) && local != nil && local.Code != "" {
		return safeErrorCode(local.Code)
	}
	var requirementErr *requirements.Error
	if errors.As(err, &requirementErr) && requirementErr != nil && requirementErr.Code != "" {
		return safeErrorCode(requirementErr.Code)
	}
	var solicitationErr *solicitations.Error
	if errors.As(err, &solicitationErr) && solicitationErr != nil && solicitationErr.Code != "" {
		return safeErrorCode(solicitationErr.Code)
	}
	var cardErr *cards.Error
	if errors.As(err, &cardErr) && cardErr != nil && cardErr.Code != "" {
		return safeErrorCode(cardErr.Code)
	}
	var messageErr *messages.Error
	if errors.As(err, &messageErr) && messageErr != nil && messageErr.Code != "" {
		return safeErrorCode(messageErr.Code)
	}
	if isContextError(err) {
		return "echo.delivery_timeout"
	}
	return "echo.delivery_failed"
}

func isContextError(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
