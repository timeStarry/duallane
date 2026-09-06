package solicitations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

var (
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
	publicIDPattern    = regexp.MustCompile(`^SOL-[0-9]{4}-[0-9]{4}$`)
	idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
)

type mutationRejection struct {
	err      *Error
	targetID string
	reason   string
}

type createIntent struct {
	Title            string
	Description      string
	Question         string
	Options          []string
	ChoiceMode       string
	MinSelections    int
	MaxSelections    int
	AllowVoteChange  bool
	ResultVisibility string
	DeliveryPolicy   string
	Deadline         *time.Time
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
	return &Service{
		repo:               options.Repository,
		spaceID:            spaceID,
		now:                now,
		idFactory:          idFactory,
		conversationAccess: options.ConversationAccess,
		requirements:       options.Requirements,
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

func (s *Service) Requirements() RequirementAdapter {
	if s == nil {
		return nil
	}
	return s.requirements
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

// withMutation repeats actor authorization inside the accepting transaction.
// Domain rejections deliberately commit a content-free audit row; repository
// or CAS failures roll the transaction back and receive a best-effort audit in
// a separate transaction, matching the Node service's rejection path.
func (s *Service) withMutation(ctx context.Context, actorID, spaceID string, meta auth.RequestMeta, action string, fn func(Tx, *auth.Actor, time.Time) (*Solicitation, *mutationRejection, bool, string, error)) (*Solicitation, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("run echo solicitation mutation", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	meta = meta.Safe()
	var result *Solicitation
	var transactionActor *auth.Actor
	var rejected *TransactionRejection
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		actor, actorErr := s.lookupActor(ctx, tx, spaceID, actorID)
		if actorErr != nil {
			return actorErr
		}
		transactionActor = actor
		var txErr error
		result, txErr = s.withMutationInTx(ctx, tx, actorID, spaceID, meta, action, fn)
		if txErr != nil {
			if marker, ok := txErr.(*TransactionRejection); ok {
				rejected = marker
				return nil
			}
			return txErr
		}
		return nil
	})
	if err != nil {
		domainErr := asDomainError(err)
		if domainErr != nil && transactionActor != nil {
			_ = s.writeStandaloneAudit(ctx, spaceID, transactionActor, meta, action, "", "rejected", domainErr.Code)
		}
		return nil, normalizeError(err)
	}
	if rejected != nil {
		return nil, rejected.Err
	}
	return result, nil
}

// withMutationInTx applies the solicitation mutation and audit policy to an
// already-open transaction. The caller owns commit/rollback. Domain
// rejections write their content-free audit in this transaction and return a
// TransactionRejection marker; infrastructure failures return their original
// error so the caller rolls back.
func (s *Service) withMutationInTx(ctx context.Context, tx Tx, actorID, spaceID string, meta auth.RequestMeta, action string, fn func(Tx, *auth.Actor, time.Time) (*Solicitation, *mutationRejection, bool, string, error)) (*Solicitation, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("run echo solicitation mutation", errors.New("repository is required"))
	}
	if tx == nil {
		return nil, internalError("run echo solicitation mutation", errors.New("transaction is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	meta = meta.Safe()
	actor, err := s.lookupActor(ctx, tx, spaceID, actorID)
	if err != nil {
		return nil, err
	}
	result, rejected, auditSuccess, successReason, err := fn(tx, actor, s.nowUTC())
	if err != nil {
		return nil, err
	}
	if rejected != nil {
		reason := firstNonEmpty(rejected.reason, rejected.err.Code)
		if err := tx.WriteAudit(ctx, AuditInput{
			SpaceID: spaceID, ActorUserID: actor.ID, ActorGitHubLogin: actor.GitHubLogin,
			Action: action, TargetType: "echo.solicitation", TargetID: rejected.targetID,
			Result: "rejected", Reason: reason, Meta: meta, CreatedAt: s.nowUTC(),
		}); err != nil {
			return nil, err
		}
		return nil, &TransactionRejection{Err: rejected.err, TargetID: rejected.targetID, Reason: reason}
	}
	if auditSuccess && result != nil {
		if err := tx.WriteAudit(ctx, AuditInput{
			SpaceID: spaceID, ActorUserID: actor.ID, ActorGitHubLogin: actor.GitHubLogin,
			Action: action, TargetType: "echo.solicitation", TargetID: result.PublicID,
			Result: "success", Reason: successReason, Meta: meta, CreatedAt: s.nowUTC(),
		}); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (s *Service) lookupActor(ctx context.Context, repository ReadRepository, spaceID, actorID string) (*auth.Actor, error) {
	actor, err := repository.LookupActor(ctx, spaceID, actorID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if actor == nil || actor.ID != actorID || strings.TrimSpace(actor.Role) == "" || actor.Kind != "human" {
		return nil, authRequiredError()
	}
	return actor, nil
}

func (s *Service) readActor(ctx context.Context, spaceID, actorID string) (*auth.Actor, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("read echo solicitation actor", errors.New("repository is required"))
	}
	return s.lookupActor(ctx, s.repo, spaceID, strings.TrimSpace(actorID))
}

func (s *Service) authorizeConversation(ctx context.Context, spaceID, conversationID, actorID string) error {
	var access ConversationAccess
	if s != nil {
		access = s.conversationAccess
	}
	return authorizeConversationWith(ctx, access, spaceID, conversationID, actorID)
}

func authorizeConversationWith(ctx context.Context, access ConversationAccess, spaceID, conversationID, actorID string) error {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return nil
	}
	if access == nil {
		return internalError("authorize echo solicitation target conversation", errors.New("conversation access is required"))
	}
	active, err := access.ConversationMemberActive(ctx, spaceID, conversationID, actorID)
	if err != nil {
		return normalizeError(err)
	}
	if !active {
		return notFoundError()
	}
	return nil
}

func (s *Service) Create(ctx context.Context, input CreateInput) (*Solicitation, error) {
	spaceID, err := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if err != nil {
		return nil, err
	}
	return s.withMutation(ctx, input.ActorID, spaceID, input.Meta, "echo.solicitation.create", func(tx Tx, actor *auth.Actor, at time.Time) (*Solicitation, *mutationRejection, bool, string, error) {
		if actor.Role != "owner" {
			return nil, reject(hiddenPermissionError(), "", ""), true, "", nil
		}
		intent, normalizedErr := normalizeCreateInput(input)
		if normalizedErr != nil {
			return nil, reject(normalizedErr, "", ""), true, "", nil
		}
		key, keyErr := normalizeIdempotencyKey(input.IdempotencyKey)
		if keyErr != nil {
			return nil, reject(keyErr, "", ""), true, "", nil
		}
		hash := createRequestHash(spaceID, actor.ID, intent)
		year := at.Year()
		if err := tx.Lock(ctx, fmt.Sprintf("echo-solicitation:sequence:%s:%04d", spaceID, year)); err != nil {
			return nil, nil, false, "", err
		}
		if err := tx.Lock(ctx, fmt.Sprintf("echo-solicitation:idempotency:%s:%s:create:%s", spaceID, actor.ID, key)); err != nil {
			return nil, nil, false, "", err
		}
		existing, err := tx.GetIdempotency(ctx, spaceID, actor.ID, "create", key)
		if err != nil {
			return nil, nil, false, "", err
		}
		if existing != nil {
			if existing.RequestHash != hash {
				return nil, reject(conflictError(CodeIdempotencyConflict, MessageIdempotencyConflict), "", ""), true, "", nil
			}
			replay, replayErr := s.replay(ctx, tx, existing, actor, spaceID)
			return replay, nil, false, "", replayErr
		}
		number, err := tx.AllocateSequence(ctx, spaceID, year)
		if err != nil {
			return nil, nil, false, "", err
		}
		id, err := s.newID("echo solicitation")
		if err != nil {
			return nil, nil, false, "", err
		}
		publicID := fmt.Sprintf("SOL-%04d-%04d", year, number)
		keyCopy := key
		record := SolicitationRecord{
			ID: id, PublicID: publicID, SpaceID: spaceID, OwnerUserID: actor.ID,
			Title: intent.Title, Description: intent.Description, Question: intent.Question,
			ChoiceMode: intent.ChoiceMode, MinSelections: intent.MinSelections,
			MaxSelections: intent.MaxSelections, AllowVoteChange: intent.AllowVoteChange,
			ResultVisibility: intent.ResultVisibility, DeliveryPolicy: intent.DeliveryPolicy,
			Status: StatusDraft, Deadline: cloneTime(intent.Deadline), Revision: 1,
			IdempotencyKey: &keyCopy, CreatedAt: at, UpdatedAt: at,
		}
		if err := tx.InsertSolicitation(ctx, record); err != nil {
			return nil, nil, false, "", err
		}
		for position, label := range intent.Options {
			optionID, idErr := s.newID("echo solicitation option")
			if idErr != nil {
				return nil, nil, false, "", idErr
			}
			if err := tx.InsertOption(ctx, SolicitationOptionRecord{ID: "echo_sol_opt_" + optionID, SolicitationID: id, Label: label, Position: position}); err != nil {
				return nil, nil, false, "", err
			}
		}
		inserted, err := tx.InsertIdempotency(ctx, IdempotencyRecord{SpaceID: spaceID, ActorUserID: actor.ID, Operation: "create", Key: key, RequestHash: hash, SolicitationID: id, CreatedAt: at})
		if err != nil {
			return nil, nil, false, "", err
		}
		if !inserted {
			return nil, nil, false, "", conflictError(CodeIdempotencyConflict, MessageIdempotencyConflict)
		}
		created, err := tx.GetSolicitationByID(ctx, spaceID, id)
		if err != nil || created == nil {
			if err == nil {
				err = errors.New("created echo solicitation could not be read")
			}
			return nil, nil, false, "", err
		}
		result, err := s.project(ctx, tx, actor, created)
		if err != nil {
			return nil, nil, false, "", err
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			return nil, nil, false, "", err
		}
		if err := tx.UpdateIdempotencyResult(ctx, spaceID, actor.ID, "create", key, encoded); err != nil {
			return nil, nil, false, "", err
		}
		if err := s.writeEvent(ctx, tx, actor, result, "echo.solicitation.updated", at); err != nil {
			return nil, nil, false, "", err
		}
		return result, nil, true, StatusDraft, nil
	})
}

func (s *Service) Get(ctx context.Context, input GetInput) (*Solicitation, error) {
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return nil, validationErr
	}
	actor, actorErr := s.readActor(ctx, spaceID, input.ActorID)
	if actorErr != nil {
		return nil, actorErr
	}
	publicID, publicErr := normalizePublicID(input.PublicID)
	if publicErr != nil {
		return nil, publicErr
	}
	if err := s.authorizeConversation(ctx, spaceID, input.ConversationID, actor.ID); err != nil {
		return nil, err
	}
	record, err := s.repo.GetSolicitationByPublicID(ctx, spaceID, publicID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if record == nil || (record.Status == StatusDraft && record.OwnerUserID != actor.ID) {
		_ = s.writeStandaloneAudit(ctx, spaceID, actor, input.Meta, "echo.solicitation.read", publicID, "rejected", CodeSolicitationNotFound)
		return nil, notFoundError()
	}
	if record.Status == StatusOpen && expired(record.Deadline, s.nowUTC()) {
		if err := s.expire(ctx, spaceID, record.ID, actor, input.Meta); err != nil {
			return nil, err
		}
		record, err = s.repo.GetSolicitationByPublicID(ctx, spaceID, publicID)
		if err != nil {
			return nil, normalizeError(err)
		}
	}
	return s.project(ctx, s.repo, actor, record)
}

func (s *Service) List(ctx context.Context, input ListInput) ([]Solicitation, error) {
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return nil, validationErr
	}
	actor, actorErr := s.readActor(ctx, spaceID, input.ActorID)
	if actorErr != nil {
		return nil, actorErr
	}
	if err := s.authorizeConversation(ctx, spaceID, input.ConversationID, actor.ID); err != nil {
		return nil, err
	}
	status := ""
	if input.Status != "" {
		normalizedStatus, statusErr := normalizeStatus(input.Status)
		if statusErr != nil {
			return nil, statusErr
		}
		status = normalizedStatus
	}
	limit, limitErr := normalizeLimitWithPresence(input.Limit, input.LimitPresent || input.Limit != 0)
	if limitErr != nil {
		return nil, limitErr
	}
	records, err := s.repo.ListSolicitations(ctx, SolicitationListQuery{SpaceID: spaceID, ActorID: actor.ID, Status: status, Limit: limit})
	if err != nil {
		return nil, normalizeError(err)
	}
	result := make([]Solicitation, 0, len(records))
	for _, record := range records {
		if record.Status == StatusOpen && expired(record.Deadline, s.nowUTC()) {
			if expireErr := s.expire(ctx, spaceID, record.ID, actor, input.Meta); expireErr != nil {
				return nil, expireErr
			}
			fresh, getErr := s.repo.GetSolicitationByID(ctx, spaceID, record.ID)
			if getErr != nil {
				return nil, normalizeError(getErr)
			}
			if fresh != nil {
				record = *fresh
			}
		}
		projection, projectErr := s.project(ctx, s.repo, actor, &record)
		if projectErr != nil {
			return nil, projectErr
		}
		result = append(result, *projection)
	}
	return result, nil
}

func (s *Service) Publish(ctx context.Context, input TransitionInput) (*Solicitation, error) {
	return s.transition(ctx, input, "publish", StatusOpen)
}

func (s *Service) Close(ctx context.Context, input TransitionInput) (*Solicitation, error) {
	return s.transition(ctx, input, "close", StatusClosed)
}

func (s *Service) Withdraw(ctx context.Context, input TransitionInput) (*Solicitation, error) {
	return s.transition(ctx, input, "withdraw", StatusWithdrawn)
}

func (s *Service) transition(ctx context.Context, input TransitionInput, operation, targetStatus string) (*Solicitation, error) {
	spaceID, err := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if err != nil {
		return nil, err
	}
	return s.withMutation(ctx, input.ActorID, spaceID, input.Meta, "echo.solicitation."+operation, func(tx Tx, actor *auth.Actor, at time.Time) (*Solicitation, *mutationRejection, bool, string, error) {
		if actor.Role != "owner" {
			return nil, reject(hiddenPermissionError(), "", ""), true, "", nil
		}
		publicID, publicErr := normalizePublicID(input.PublicID)
		if publicErr != nil {
			return nil, reject(publicErr, "", ""), true, "", nil
		}
		if err := authorizeConversationWith(ctx, tx, spaceID, input.ConversationID, actor.ID); err != nil {
			if domain := asDomainError(err); domain != nil {
				return nil, reject(domain, publicID, domain.Code), true, "", nil
			}
			return nil, nil, false, "", err
		}
		key, keyErr := normalizeIdempotencyKey(input.IdempotencyKey)
		if keyErr != nil {
			return nil, reject(keyErr, publicID, keyErr.Code), true, "", nil
		}
		expectedRevision, revisionErr := normalizeExpectedRevision(input.ExpectedRevision, input.ExpectedRevisionPresent || input.ExpectedRevision != 0)
		if revisionErr != nil {
			return nil, reject(revisionErr, publicID, revisionErr.Code), true, "", nil
		}
		hash := transitionRequestHash(spaceID, publicID, operation, targetStatus)
		if err := tx.Lock(ctx, "echo-solicitation:"+spaceID+":"+publicID); err != nil {
			return nil, nil, false, "", err
		}
		if err := tx.Lock(ctx, fmt.Sprintf("echo-solicitation:idempotency:%s:%s:%s:%s", spaceID, actor.ID, operation, key)); err != nil {
			return nil, nil, false, "", err
		}
		row, err := tx.GetSolicitationByPublicID(ctx, spaceID, publicID)
		if err != nil {
			return nil, nil, false, "", err
		}
		if row == nil {
			return nil, reject(notFoundError(), publicID, CodeSolicitationNotFound), true, "", nil
		}
		existing, err := tx.GetIdempotency(ctx, spaceID, actor.ID, operation, key)
		if err != nil {
			return nil, nil, false, "", err
		}
		if existing != nil {
			if existing.RequestHash != hash || existing.SolicitationID != row.ID {
				return nil, reject(conflictError(CodeIdempotencyConflict, MessageIdempotencyConflict), publicID, CodeIdempotencyConflict), true, "", nil
			}
			replay, replayErr := s.replay(ctx, tx, existing, actor, spaceID)
			return replay, nil, false, "", replayErr
		}
		allowed := (operation == "publish" && row.Status == StatusDraft) ||
			(operation == "close" && row.Status == StatusOpen) ||
			(operation == "withdraw" && (row.Status == StatusDraft || row.Status == StatusOpen))
		if !allowed {
			return nil, reject(conflictError(CodeInvalidTransition, MessageInvalidTransition), publicID, CodeInvalidTransition), true, "", nil
		}
		if operation == "publish" && expired(row.Deadline, at) {
			return nil, reject(conflictError(CodeDeadlineInvalid, MessageDeadlineInvalid), publicID, CodeDeadlineInvalid), true, "", nil
		}
		if expectedRevision != nil && row.Revision != *expectedRevision {
			return nil, reject(conflictError(CodeRevisionConflict, MessageRevisionConflict), publicID, CodeRevisionConflict), true, "", nil
		}
		nextRevision := row.Revision + 1
		publishedAt, closedAt, withdrawnAt := cloneTime(row.PublishedAt), cloneTime(row.ClosedAt), cloneTime(row.WithdrawnAt)
		switch operation {
		case "publish":
			publishedAt = cloneTime(&at)
		case "close":
			closedAt = cloneTime(&at)
		case "withdraw":
			withdrawnAt = cloneTime(&at)
		}
		updated, err := tx.UpdateSolicitationStateCAS(ctx, row.ID, row.Revision, targetStatus, nextRevision, at, publishedAt, closedAt, withdrawnAt)
		if err != nil {
			return nil, nil, false, "", err
		}
		if !updated {
			return nil, nil, false, "", conflictError(CodeRevisionConflict, MessageRevisionConflict)
		}
		if operation == "publish" && row.DeliveryPolicy != DeliveryPolicyNone {
			if err := tx.InsertDeliveryRows(ctx, row.SpaceID, row.ID, at); err != nil {
				return nil, nil, false, "", err
			}
		}
		inserted, err := tx.InsertIdempotency(ctx, IdempotencyRecord{SpaceID: spaceID, ActorUserID: actor.ID, Operation: operation, Key: key, RequestHash: hash, SolicitationID: row.ID, CreatedAt: at})
		if err != nil {
			return nil, nil, false, "", err
		}
		if !inserted {
			return nil, nil, false, "", conflictError(CodeIdempotencyConflict, MessageIdempotencyConflict)
		}
		fresh, err := tx.GetSolicitationByID(ctx, spaceID, row.ID)
		if err != nil || fresh == nil {
			if err == nil {
				err = errors.New("updated echo solicitation could not be read")
			}
			return nil, nil, false, "", err
		}
		result, err := s.project(ctx, tx, actor, fresh)
		if err != nil {
			return nil, nil, false, "", err
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			return nil, nil, false, "", err
		}
		if err := tx.UpdateIdempotencyResult(ctx, spaceID, actor.ID, operation, key, encoded); err != nil {
			return nil, nil, false, "", err
		}
		eventType := "echo.solicitation.updated"
		switch operation {
		case "publish":
			eventType = "echo.solicitation.published"
		case "close":
			eventType = "echo.solicitation.closed"
		case "withdraw":
			eventType = "echo.solicitation.withdrawn"
		}
		if err := s.writeEvent(ctx, tx, actor, result, eventType, at); err != nil {
			return nil, nil, false, "", err
		}
		return result, nil, true, targetStatus, nil
	})
}

func (s *Service) Vote(ctx context.Context, input VoteInput) (*Solicitation, error) {
	spaceID, err := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if err != nil {
		return nil, err
	}
	return s.withMutation(ctx, input.ActorID, spaceID, input.Meta, "echo.solicitation.vote", s.voteMutation(ctx, spaceID, input))
}

// VoteInTx applies the complete vote mutation to an already-open transaction.
// A TransactionRejection means the rejection audit is already in tx and the
// caller must commit; all other errors must roll the outer transaction back.
func (s *Service) VoteInTx(ctx context.Context, tx Tx, input VoteInput) (*Solicitation, error) {
	spaceID, err := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if err != nil {
		return nil, err
	}
	return s.withMutationInTx(ctx, tx, input.ActorID, spaceID, input.Meta, "echo.solicitation.vote", s.voteMutation(ctx, spaceID, input))
}

func (s *Service) voteMutation(ctx context.Context, spaceID string, input VoteInput) func(Tx, *auth.Actor, time.Time) (*Solicitation, *mutationRejection, bool, string, error) {
	return func(tx Tx, actor *auth.Actor, at time.Time) (*Solicitation, *mutationRejection, bool, string, error) {
		if actor.Role == "auditor" {
			return nil, reject(hiddenPermissionError(), "", ""), true, "", nil
		}
		publicID, publicErr := normalizePublicID(input.PublicID)
		if publicErr != nil {
			return nil, reject(publicErr, "", ""), true, "", nil
		}
		optionValues := input.OptionIDs
		if len(optionValues) == 0 && len(input.SelectedOptionIDs) > 0 {
			optionValues = input.SelectedOptionIDs
		}
		optionIDs, optionErr := normalizeOptionIDs(optionValues)
		if optionErr != nil {
			return nil, reject(optionErr, publicID, optionErr.Code), true, "", nil
		}
		key, keyErr := normalizeIdempotencyKey(input.IdempotencyKey)
		if keyErr != nil {
			return nil, reject(keyErr, publicID, keyErr.Code), true, "", nil
		}
		expectedRevision, revisionErr := normalizeExpectedRevision(input.ExpectedRevision, input.ExpectedRevisionPresent || input.ExpectedRevision != 0)
		if revisionErr != nil {
			return nil, reject(revisionErr, publicID, revisionErr.Code), true, "", nil
		}
		if err := authorizeConversationWith(ctx, tx, spaceID, input.ConversationID, actor.ID); err != nil {
			if domain := asDomainError(err); domain != nil {
				return nil, reject(domain, publicID, domain.Code), true, "", nil
			}
			return nil, nil, false, "", err
		}
		hash := voteRequestHashWithPresence(spaceID, publicID, optionIDs, expectedRevision)
		if err := tx.Lock(ctx, "echo-solicitation:"+spaceID+":"+publicID); err != nil {
			return nil, nil, false, "", err
		}
		if err := tx.Lock(ctx, fmt.Sprintf("echo-solicitation:idempotency:%s:%s:vote:%s", spaceID, actor.ID, key)); err != nil {
			return nil, nil, false, "", err
		}
		row, err := tx.GetSolicitationByPublicID(ctx, spaceID, publicID)
		if err != nil {
			return nil, nil, false, "", err
		}
		if row == nil || row.Status == StatusDraft {
			return nil, reject(notFoundError(), publicID, CodeSolicitationNotFound), true, "", nil
		}
		if expired(row.Deadline, at) && row.Status == StatusOpen {
			closedAt := cloneTime(&at)
			updated, closeErr := tx.UpdateSolicitationStateCAS(ctx, row.ID, row.Revision, StatusClosed, row.Revision+1, at, cloneTime(row.PublishedAt), closedAt, cloneTime(row.WithdrawnAt))
			if closeErr != nil {
				return nil, nil, false, "", closeErr
			}
			if !updated {
				return nil, nil, false, "", conflictError(CodeRevisionConflict, MessageRevisionConflict)
			}
			fresh, getErr := tx.GetSolicitationByID(ctx, spaceID, row.ID)
			if getErr != nil {
				return nil, nil, false, "", getErr
			}
			if fresh != nil {
				row = fresh
			}
			if row != nil {
				if eventErr := s.writeEvent(ctx, tx, actor, projectMetadata(row), "echo.solicitation.closed", at); eventErr != nil {
					return nil, nil, false, "", eventErr
				}
			}
		}
		existing, err := tx.GetIdempotency(ctx, spaceID, actor.ID, "vote", key)
		if err != nil {
			return nil, nil, false, "", err
		}
		if existing != nil {
			if existing.RequestHash != hash || existing.SolicitationID != row.ID {
				return nil, reject(conflictError(CodeIdempotencyConflict, MessageIdempotencyConflict), publicID, CodeIdempotencyConflict), true, "", nil
			}
			replay, replayErr := s.replay(ctx, tx, existing, actor, spaceID)
			return replay, nil, false, "", replayErr
		}
		if row.Status != StatusOpen {
			return nil, reject(conflictError(CodeVoteClosed, MessageVoteClosed), publicID, CodeVoteClosed), true, "", nil
		}
		if expectedRevision != nil && *expectedRevision != row.Revision {
			return nil, reject(conflictError(CodeRevisionConflict, MessageRevisionConflict), publicID, CodeRevisionConflict), true, "", nil
		}
		options, err := tx.ListOptions(ctx, row.ID)
		if err != nil {
			return nil, nil, false, "", err
		}
		validOptions := make(map[string]struct{}, len(options))
		for _, option := range options {
			validOptions[option.ID] = struct{}{}
		}
		for _, optionID := range optionIDs {
			if _, ok := validOptions[optionID]; !ok {
				return nil, reject(validationError(CodeOptionInvalid, MessageOptionInvalid), publicID, CodeOptionInvalid), true, "", nil
			}
		}
		if row.ChoiceMode == ChoiceSingle && len(optionIDs) != 1 {
			return nil, reject(validationError(CodeSelectionInvalid, "单选征集只能选择一项"), publicID, CodeSelectionInvalid), true, "", nil
		}
		if len(optionIDs) < row.MinSelections || len(optionIDs) > row.MaxSelections {
			return nil, reject(validationError(CodeSelectionInvalid, MessageSelectionInvalid), publicID, CodeSelectionInvalid), true, "", nil
		}
		prior, err := tx.GetVote(ctx, row.ID, actor.ID)
		if err != nil {
			return nil, nil, false, "", err
		}
		if prior != nil && !row.AllowVoteChange {
			return nil, reject(conflictError(CodeVoteChangeForbidden, MessageVoteChangeForbidden), publicID, CodeVoteChangeForbidden), true, "", nil
		}
		voteRevision := int64(1)
		if prior != nil {
			voteRevision = prior.Revision + 1
			prior.Selection = append([]string(nil), optionIDs...)
			prior.Revision = voteRevision
			prior.UpdatedAt = at
			updated, updateErr := tx.UpdateVote(ctx, *prior)
			if updateErr != nil {
				return nil, nil, false, "", updateErr
			}
			if !updated {
				return nil, nil, false, "", conflictError(CodeRevisionConflict, MessageRevisionConflict)
			}
		} else {
			voteID, idErr := s.newID("echo solicitation vote")
			if idErr != nil {
				return nil, nil, false, "", idErr
			}
			if err := tx.InsertVote(ctx, VoteRecord{ID: "echo_sol_vote_" + voteID, SolicitationID: row.ID, VoterUserID: actor.ID, Selection: optionIDs, Revision: 1, CreatedAt: at, UpdatedAt: at}); err != nil {
				return nil, nil, false, "", err
			}
		}
		updated, err := tx.UpdateSolicitationStateCAS(ctx, row.ID, row.Revision, StatusOpen, row.Revision+1, at, cloneTime(row.PublishedAt), cloneTime(row.ClosedAt), cloneTime(row.WithdrawnAt))
		if err != nil {
			return nil, nil, false, "", err
		}
		if !updated {
			return nil, nil, false, "", conflictError(CodeRevisionConflict, MessageRevisionConflict)
		}
		inserted, err := tx.InsertIdempotency(ctx, IdempotencyRecord{SpaceID: spaceID, ActorUserID: actor.ID, Operation: "vote", Key: key, RequestHash: hash, SolicitationID: row.ID, CreatedAt: at})
		if err != nil {
			return nil, nil, false, "", err
		}
		if !inserted {
			return nil, nil, false, "", conflictError(CodeIdempotencyConflict, MessageIdempotencyConflict)
		}
		fresh, err := tx.GetSolicitationByID(ctx, spaceID, row.ID)
		if err != nil || fresh == nil {
			if err == nil {
				err = errors.New("voted echo solicitation could not be read")
			}
			return nil, nil, false, "", err
		}
		result, err := s.project(ctx, tx, actor, fresh)
		if err != nil {
			return nil, nil, false, "", err
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			return nil, nil, false, "", err
		}
		if err := tx.UpdateIdempotencyResult(ctx, spaceID, actor.ID, "vote", key, encoded); err != nil {
			return nil, nil, false, "", err
		}
		if err := s.writeEvent(ctx, tx, actor, result, "echo.solicitation.updated", at); err != nil {
			return nil, nil, false, "", err
		}
		return result, nil, true, "vote", nil
	}
}

func (s *Service) ListVotes(ctx context.Context, input VotesInput) ([]SolicitationVote, error) {
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return nil, validationErr
	}
	actor, actorErr := s.readActor(ctx, spaceID, input.ActorID)
	if actorErr != nil {
		return nil, actorErr
	}
	if actor.Role != "owner" {
		return nil, hiddenPermissionError()
	}
	if err := s.authorizeConversation(ctx, spaceID, input.ConversationID, actor.ID); err != nil {
		return nil, err
	}
	publicID, publicErr := normalizePublicID(input.PublicID)
	if publicErr != nil {
		return nil, publicErr
	}
	row, err := s.repo.GetSolicitationByPublicID(ctx, spaceID, publicID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if row == nil {
		return nil, notFoundError()
	}
	votes, err := s.repo.ListVotes(ctx, row.ID)
	if err != nil {
		return nil, normalizeError(err)
	}
	result := make([]SolicitationVote, 0, len(votes))
	for _, vote := range votes {
		result = append(result, SolicitationVote{ID: vote.ID, VoterUserID: vote.VoterUserID, VoterDisplayName: vote.VoterDisplayName, VoterGitHubLogin: vote.VoterGitHubLogin, OptionIDs: append([]string(nil), vote.Selection...), Revision: vote.Revision, CreatedAt: formatTime(vote.CreatedAt), UpdatedAt: formatTime(vote.UpdatedAt)})
	}
	return result, nil
}

func (s *Service) ListDeliveries(ctx context.Context, input DeliveriesInput) ([]SolicitationDelivery, error) {
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return nil, validationErr
	}
	actor, actorErr := s.readActor(ctx, spaceID, input.ActorID)
	if actorErr != nil {
		return nil, actorErr
	}
	if actor.Role != "owner" {
		return nil, hiddenPermissionError()
	}
	if err := s.authorizeConversation(ctx, spaceID, input.ConversationID, actor.ID); err != nil {
		return nil, err
	}
	publicID, publicErr := normalizePublicID(input.PublicID)
	if publicErr != nil {
		return nil, publicErr
	}
	row, err := s.repo.GetSolicitationByPublicID(ctx, spaceID, publicID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if row == nil {
		return nil, notFoundError()
	}
	deliveries, err := s.repo.ListDeliveries(ctx, row.ID)
	if err != nil {
		return nil, normalizeError(err)
	}
	result := make([]SolicitationDelivery, 0, len(deliveries))
	for _, delivery := range deliveries {
		result = append(result, projectDelivery(delivery))
	}
	return result, nil
}

func (s *Service) ProjectDelivery(ctx context.Context, input ProjectDeliveryInput) (DeliveryProjection, error) {
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return DeliveryProjection{}, validationErr
	}
	var err error
	deliveryID, deliveryErr := normalizeIdentifier(input.DeliveryID, CodeDeliveryInvalid, MessageDeliveryInvalid)
	if deliveryErr != nil {
		return DeliveryProjection{}, deliveryErr
	}
	row, err := s.repo.GetDelivery(ctx, spaceID, deliveryID)
	if err != nil {
		return DeliveryProjection{}, normalizeError(err)
	}
	if row == nil {
		return DeliveryProjection{}, notFoundError()
	}
	solicitation, err := s.repo.GetSolicitationByID(ctx, spaceID, row.SolicitationID)
	if err != nil {
		return DeliveryProjection{}, normalizeError(err)
	}
	if solicitation == nil {
		return DeliveryProjection{}, notFoundError()
	}
	return DeliveryProjection{Type: "echo.solicitation.delivery", DeliveryID: row.ID, SolicitationID: row.SolicitationID, PublicID: solicitation.PublicID, RecipientUserID: row.RecipientUserID, Status: row.Status, Revision: solicitation.Revision}, nil
}

func projectDelivery(row DeliveryRecord) SolicitationDelivery {
	return SolicitationDelivery{
		ID: row.ID, RecipientUserID: row.RecipientUserID,
		RecipientDisplayName: row.RecipientDisplayName, RecipientGitHubLogin: row.RecipientGitHubLogin,
		Status: row.Status, AttemptCount: row.AttemptCount, LastErrorCode: cloneString(row.LastErrorCode),
		DeliveredAt: formatOptionalTime(row.DeliveredAt), CreatedAt: formatTime(row.CreatedAt), UpdatedAt: formatTime(row.UpdatedAt),
	}
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func (s *Service) ProjectCard(ctx context.Context, input GetInput) (*CardProjection, error) {
	result, err := s.Get(ctx, input)
	if err != nil {
		return nil, err
	}
	if result.CardPayload == nil {
		return nil, internalError("project echo solicitation card", errors.New("card payload is missing"))
	}
	return &CardProjection{
		Block:   CardBlock{Type: "card", CardID: solicitationCardID(result.PublicID), CardType: CardType, SchemaVersion: CardSchemaVersion, FallbackText: fmt.Sprintf("回声征集 %s: %s", result.PublicID, truncate(result.Title, 80, 384))},
		Payload: result.CardPayload,
	}, nil
}

// ProjectCardInTx reads and projects a solicitation through the caller's
// transaction. It is the transaction-scoped companion to ProjectCard for a
// shared cards action; it never opens a pool transaction or reads through a
// second connection.
func (s *Service) ProjectCardInTx(ctx context.Context, tx Tx, input GetInput) (*CardProjection, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("project echo solicitation card", errors.New("repository is required"))
	}
	if tx == nil {
		return nil, internalError("project echo solicitation card", errors.New("transaction is required"))
	}
	spaceID, validationErr := normalizeIdentifier(s.space(input.SpaceID), CodeInvalidSpace, MessageInvalidSpace)
	if validationErr != nil {
		return nil, validationErr
	}
	actor, err := s.lookupActor(ctx, tx, spaceID, input.ActorID)
	if err != nil {
		return nil, err
	}
	publicID, validationErr := normalizePublicID(input.PublicID)
	if validationErr != nil {
		return nil, validationErr
	}
	if err := authorizeConversationWith(ctx, tx, spaceID, input.ConversationID, actor.ID); err != nil {
		return nil, err
	}
	record, err := tx.GetSolicitationByPublicID(ctx, spaceID, publicID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if record == nil || (record.Status == StatusDraft && record.OwnerUserID != actor.ID) {
		return nil, notFoundError()
	}
	if record.Status == StatusOpen && expired(record.Deadline, s.nowUTC()) {
		if err := s.expireInTx(ctx, tx, spaceID, record.ID, actor, input.Meta); err != nil {
			return nil, err
		}
		record, err = tx.GetSolicitationByPublicID(ctx, spaceID, publicID)
		if err != nil {
			return nil, normalizeError(err)
		}
	}
	result, err := s.project(ctx, tx, actor, record)
	if err != nil {
		return nil, err
	}
	if result.CardPayload == nil {
		return nil, internalError("project echo solicitation card", errors.New("card payload is missing"))
	}
	return &CardProjection{
		Block:   CardBlock{Type: "card", CardID: solicitationCardID(result.PublicID), CardType: CardType, SchemaVersion: CardSchemaVersion, FallbackText: fmt.Sprintf("回声征集 %s: %s", result.PublicID, truncate(result.Title, 80, 384))},
		Payload: result.CardPayload,
	}, nil
}

func (s *Service) expire(ctx context.Context, spaceID, solicitationID string, actor *auth.Actor, meta auth.RequestMeta) error {
	return s.repo.WithTx(ctx, func(tx Tx) error {
		return s.expireInTx(ctx, tx, spaceID, solicitationID, actor, meta)
	})
}

func (s *Service) expireInTx(ctx context.Context, tx Tx, spaceID, solicitationID string, actor *auth.Actor, meta auth.RequestMeta) error {
	if tx == nil {
		return errors.New("echo solicitation transaction is required")
	}
	if err := tx.Lock(ctx, "echo-solicitation:"+spaceID+":"+solicitationID); err != nil {
		return err
	}
	row, err := tx.GetSolicitationByID(ctx, spaceID, solicitationID)
	if err != nil || row == nil {
		return err
	}
	at := s.nowUTC()
	if row.Status != StatusOpen || !expired(row.Deadline, at) {
		return nil
	}
	closedAt := cloneTime(&at)
	updated, err := tx.UpdateSolicitationStateCAS(ctx, row.ID, row.Revision, StatusClosed, row.Revision+1, at, cloneTime(row.PublishedAt), closedAt, cloneTime(row.WithdrawnAt))
	if err != nil {
		return err
	}
	if !updated {
		return conflictError(CodeRevisionConflict, MessageRevisionConflict)
	}
	fresh, err := tx.GetSolicitationByID(ctx, spaceID, row.ID)
	if err != nil {
		return err
	}
	if fresh != nil {
		if err := s.writeEvent(ctx, tx, actor, projectMetadata(fresh), "echo.solicitation.closed", at); err != nil {
			return err
		}
	}
	return tx.WriteAudit(ctx, AuditInput{SpaceID: spaceID, ActorUserID: actor.ID, ActorGitHubLogin: actor.GitHubLogin, Action: "echo.solicitation.expire", TargetType: "echo.solicitation", TargetID: row.PublicID, Result: "success", Reason: "deadline", Meta: meta.Safe(), CreatedAt: at})
}

func (s *Service) replay(ctx context.Context, repository ReadRepository, existing *IdempotencyRecord, actor *auth.Actor, spaceID string) (*Solicitation, error) {
	if len(existing.ResultJSON) > 0 {
		var result Solicitation
		if err := json.Unmarshal(existing.ResultJSON, &result); err == nil && result.PublicID != "" {
			normalizeReplayResult(&result)
			return &result, nil
		}
	}
	row, err := repository.GetSolicitationByID(ctx, spaceID, existing.SolicitationID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, notFoundError()
	}
	return s.project(ctx, repository, actor, row)
}

func (s *Service) project(ctx context.Context, repository ReadRepository, actor *auth.Actor, row *SolicitationRecord) (*Solicitation, error) {
	if row == nil || (row.Status == StatusDraft && row.OwnerUserID != actor.ID) {
		return nil, notFoundError()
	}
	options, err := repository.ListOptions(ctx, row.ID)
	if err != nil {
		return nil, normalizeError(err)
	}
	votes, err := repository.ListVotes(ctx, row.ID)
	if err != nil {
		return nil, normalizeError(err)
	}
	own, err := repository.GetVote(ctx, row.ID, actor.ID)
	if err != nil {
		return nil, normalizeError(err)
	}
	counts := make(map[string]int64, len(options))
	for _, option := range options {
		counts[option.ID] = 0
	}
	for _, vote := range votes {
		for _, optionID := range vote.Selection {
			if _, ok := counts[optionID]; ok {
				counts[optionID]++
			}
		}
	}
	owner := actor.ID == row.OwnerUserID
	publicCounts := counts
	if row.ResultVisibility == ResultVisibilityOwner && !owner {
		publicCounts = nil
	}
	var voteCount *int64
	if row.ResultVisibility == ResultVisibilityAggregate || owner {
		value := int64(len(votes))
		voteCount = &value
	}
	selected := []string{}
	if own != nil {
		selected = append(selected, own.Selection...)
	}
	result := &Solicitation{
		ID: row.ID, PublicID: row.PublicID, SpaceID: row.SpaceID, OwnerUserID: row.OwnerUserID,
		Title: row.Title, Description: row.Description, Question: row.Question, ChoiceMode: row.ChoiceMode,
		MinSelections: row.MinSelections, MaxSelections: row.MaxSelections, AllowVoteChange: row.AllowVoteChange,
		ResultVisibility: row.ResultVisibility, DeliveryPolicy: row.DeliveryPolicy, Status: row.Status,
		Deadline: formatOptionalTime(row.Deadline), Revision: row.Revision, SelectedOptionIDs: selected,
		Counts: publicCounts, VoteCount: voteCount, CreatedAt: formatTime(row.CreatedAt), UpdatedAt: formatTime(row.UpdatedAt),
		PublishedAt: formatOptionalTime(row.PublishedAt), ClosedAt: formatOptionalTime(row.ClosedAt), WithdrawnAt: formatOptionalTime(row.WithdrawnAt),
		Options: make([]SolicitationOption, 0, len(options)),
	}
	for _, option := range options {
		result.Options = append(result.Options, SolicitationOption{ID: option.ID, Label: option.Label, Position: option.Position})
	}
	if owner {
		summary, summaryErr := repository.DeliverySummary(ctx, row.ID)
		if summaryErr != nil {
			return nil, normalizeError(summaryErr)
		}
		result.OwnerProjection = &OwnerProjection{DeliverySummary: summary, CanViewVoters: true}
	}
	result.CardPayload = solicitationCardPayload(*result, counts, owner)
	return result, nil
}

// normalizeReplayResult restores the concrete Go types that were present in
// the original projection before it was stored as JSON. The idempotency
// response is part of the service contract, so a JSON round-trip must not
// change nil slices into nil interfaces or integer values into float64 inside
// the card payload.
func normalizeReplayResult(result *Solicitation) {
	if result == nil {
		return
	}
	if result.Options == nil {
		result.Options = []SolicitationOption{}
	}
	if result.SelectedOptionIDs == nil {
		result.SelectedOptionIDs = []string{}
	}
	if result.CardPayload == nil {
		return
	}
	result.CardPayload["deadline"] = replayStringOrNil(result.CardPayload["deadline"])
	result.CardPayload["revision"] = replayInteger(result.CardPayload["revision"], true)
	result.CardPayload["minSelections"] = replayInteger(result.CardPayload["minSelections"], false)
	result.CardPayload["maxSelections"] = replayInteger(result.CardPayload["maxSelections"], false)
	result.CardPayload["voteCount"] = replayInteger(result.CardPayload["voteCount"], true)
	result.CardPayload["selectedOptionIds"] = replayStringSlice(result.CardPayload["selectedOptionIds"])
	if values, ok := result.CardPayload["options"].([]any); ok {
		for _, value := range values {
			option, ok := value.(map[string]any)
			if !ok {
				continue
			}
			option["position"] = replayInteger(option["position"], false)
			option["count"] = replayInteger(option["count"], true)
		}
	}
}

func replayStringOrNil(value any) any {
	if value == nil {
		return nil
	}
	if pointer, ok := value.(*string); ok {
		if pointer == nil {
			return nil
		}
		return *pointer
	}
	return value
}

func replayInteger(value any, pointerSized bool) any {
	if value == nil {
		return nil
	}
	if number, ok := value.(float64); ok && number == float64(int64(number)) {
		if pointerSized {
			return int64(number)
		}
		return int(number)
	}
	return value
}

func replayStringSlice(value any) []string {
	if value == nil {
		return []string{}
	}
	if values, ok := value.([]string); ok {
		return values
	}
	values, ok := value.([]any)
	if !ok {
		return []string{}
	}
	result := make([]string, 0, len(values))
	for _, item := range values {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func solicitationCardPayload(result Solicitation, counts map[string]int64, owner bool) map[string]any {
	publicCounts := counts
	if result.ResultVisibility == ResultVisibilityOwner && !owner {
		publicCounts = nil
	}
	optionPayload := make([]any, 0, len(result.Options))
	for _, option := range result.Options {
		var count any
		if publicCounts != nil {
			count = publicCounts[option.ID]
		}
		optionPayload = append(optionPayload, map[string]any{"id": option.ID, "label": truncate(option.Label, MaxOptionCodePoints, 192), "position": option.Position, "count": count})
	}
	var voteCount any
	if result.VoteCount != nil {
		voteCount = *result.VoteCount
	}
	var deadline any
	if result.Deadline != nil {
		deadline = *result.Deadline
	}
	return map[string]any{
		"publicId":          result.PublicID,
		"title":             truncate(result.Title, MaxTitleCodePoints, MaxTitleBytes),
		"description":       truncate(result.Description, 3_000, 3_500),
		"question":          truncate(result.Question, 2_000, 2_500),
		"status":            result.Status,
		"deadline":          deadline,
		"revision":          result.Revision,
		"choiceMode":        result.ChoiceMode,
		"minSelections":     result.MinSelections,
		"maxSelections":     result.MaxSelections,
		"allowVoteChange":   result.AllowVoteChange,
		"options":           optionPayload,
		"selectedOptionIds": append([]string{}, result.SelectedOptionIDs...),
		"owner":             owner,
		"voteCount":         voteCount,
	}
}

func projectMetadata(row *SolicitationRecord) *Solicitation {
	if row == nil {
		return &Solicitation{}
	}
	return &Solicitation{ID: row.ID, PublicID: row.PublicID, SpaceID: row.SpaceID, OwnerUserID: row.OwnerUserID, Status: row.Status, Revision: row.Revision, Title: row.Title}
}

func (s *Service) writeEvent(ctx context.Context, tx Tx, actor *auth.Actor, result *Solicitation, eventType string, at time.Time) error {
	payload := map[string]any{"publicId": result.PublicID, "status": result.Status, "revision": result.Revision, "cardType": CardType, "schemaVersion": CardSchemaVersion}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.WriteEvent(ctx, EventInput{SpaceID: result.SpaceID, Type: eventType, ActorID: actor.ID, TargetType: "echo.solicitation", TargetID: result.PublicID, PayloadJSON: encoded, CreatedAt: at})
	return err
}

func (s *Service) writeStandaloneAudit(ctx context.Context, spaceID string, actor *auth.Actor, meta auth.RequestMeta, action, targetID, result, reason string) error {
	if s == nil || s.repo == nil || actor == nil {
		return nil
	}
	return s.repo.WithTx(ctx, func(tx Tx) error {
		return tx.WriteAudit(ctx, AuditInput{SpaceID: spaceID, ActorUserID: actor.ID, ActorGitHubLogin: actor.GitHubLogin, Action: action, TargetType: "echo.solicitation", TargetID: targetID, Result: result, Reason: reason, Meta: meta.Safe(), CreatedAt: s.nowUTC()})
	})
}

func reject(err *Error, targetID, reason string) *mutationRejection {
	if err == nil {
		err = internalError("reject echo solicitation", nil)
	}
	return &mutationRejection{err: err, targetID: targetID, reason: reason}
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func normalizeCreateInput(input CreateInput) (createIntent, *Error) {
	title, err := boundedText(input.Title, CodeTitleInvalid, MessageTitleInvalid, MaxTitleCodePoints, MaxTitleBytes)
	if err != nil {
		return createIntent{}, err
	}
	descriptionValue := input.Description
	if !input.Presence.Description && descriptionValue == "" {
		descriptionValue = input.Detail
	}
	description, err := boundedText(descriptionValue, CodeDescriptionInvalid, MessageDescriptionInvalid, MaxBodyCodePoints, MaxBodyBytes)
	if err != nil {
		return createIntent{}, err
	}
	question, err := boundedText(input.Question, CodeQuestionInvalid, MessageQuestionInvalid, MaxBodyCodePoints, MaxBodyBytes)
	if err != nil {
		return createIntent{}, err
	}
	if len(input.Options) < MinOptions || len(input.Options) > MaxOptions {
		return createIntent{}, validationError(CodeOptionsInvalid, MessageOptionsInvalid)
	}
	options := make([]string, len(input.Options))
	seen := map[string]struct{}{}
	for index, value := range input.Options {
		normalized, textErr := boundedText(value, CodeOptionInvalid, MessageOptionInvalid, MaxOptionCodePoints, MaxOptionBytes)
		if textErr != nil {
			return createIntent{}, textErr
		}
		key := strings.ToLower(normalized)
		if _, exists := seen[key]; exists {
			return createIntent{}, validationError(CodeOptionsInvalid, "征集选项不能重复")
		}
		seen[key] = struct{}{}
		options[index] = normalized
	}
	choiceMode := input.ChoiceMode
	if !input.Presence.ChoiceMode && choiceMode == "" {
		choiceMode = ChoiceSingle
	}
	if !contains(ChoiceModes[:], choiceMode) {
		return createIntent{}, validationError(CodeChoiceModeInvalid, MessageChoiceModeInvalid)
	}
	minSelections := input.MinSelections
	if !input.Presence.MinSelections && minSelections == 0 {
		minSelections = 1
	}
	maxSelections := input.MaxSelections
	if !input.Presence.MaxSelections && maxSelections == 0 {
		maxSelections = 1
		if choiceMode == ChoiceMultiple {
			maxSelections = len(options)
		}
	}
	if minSelections < 1 || maxSelections < minSelections || maxSelections > len(options) || (choiceMode == ChoiceSingle && (minSelections != 1 || maxSelections != 1)) {
		return createIntent{}, validationError(CodeSelectionInvalid, MessageSelectionInvalid)
	}
	allowVoteChange := true
	if input.AllowVoteChange != nil {
		allowVoteChange = *input.AllowVoteChange
	}
	resultVisibility := input.ResultVisibility
	if !input.Presence.ResultVisibility && resultVisibility == "" {
		resultVisibility = ResultVisibilityAggregate
	}
	if resultVisibility != ResultVisibilityAggregate && resultVisibility != ResultVisibilityOwner {
		return createIntent{}, validationError(CodeResultVisibilityInvalid, MessageResultVisibilityInvalid)
	}
	deliveryPolicy := input.DeliveryPolicy
	if !input.Presence.DeliveryPolicy && deliveryPolicy == "" {
		deliveryPolicy = DeliveryPolicyAllActiveMembers
	}
	if deliveryPolicy != DeliveryPolicyAllActiveMembers && deliveryPolicy != DeliveryPolicyNone {
		return createIntent{}, validationError(CodeDeliveryPolicyInvalid, MessageDeliveryPolicyInvalid)
	}
	deadline, deadlineErr := normalizeOptionalTime(input.Deadline)
	if deadlineErr != nil {
		return createIntent{}, deadlineErr
	}
	return createIntent{Title: title, Description: description, Question: question, Options: options, ChoiceMode: choiceMode, MinSelections: minSelections, MaxSelections: maxSelections, AllowVoteChange: allowVoteChange, ResultVisibility: resultVisibility, DeliveryPolicy: deliveryPolicy, Deadline: deadline}, nil
}

func normalizeIdentifier(value, code, message string) (string, *Error) {
	normalized := strings.TrimSpace(value)
	if !identifierPattern.MatchString(normalized) {
		status := 400
		if code == CodeAuthRequired {
			status = 401
		}
		return "", NewError(code, message, status)
	}
	return normalized, nil
}

func normalizePublicID(value string) (string, *Error) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	if !publicIDPattern.MatchString(normalized) {
		return "", validationError(CodeSolicitationIDInvalid, MessageSolicitationIDInvalid)
	}
	return normalized, nil
}

func normalizeStatus(value string) (string, *Error) {
	if !contains(SolicitationStatuses[:], value) {
		return "", validationError(CodeStatusInvalid, MessageStatusInvalid)
	}
	return value, nil
}

func normalizeLimitWithPresence(value int, present bool) (int, *Error) {
	if !present {
		return DefaultListLimit, nil
	}
	if value < 1 {
		return 0, validationError(CodeLimitInvalid, MessageLimitInvalid)
	}
	if value > MaxListLimit {
		return MaxListLimit, nil
	}
	return value, nil
}

func normalizeExpectedRevision(value int64, present bool) (*int64, *Error) {
	if !present {
		return nil, nil
	}
	if value < 1 {
		return nil, validationError(CodeExpectedRevisionInvalid, "征集版本无效")
	}
	normalized := value
	return &normalized, nil
}

func normalizeIdempotencyKey(value string) (string, *Error) {
	normalized := strings.TrimSpace(value)
	if normalized == "" || len([]byte(normalized)) > MaxIdempotencyBytes || !idempotencyPattern.MatchString(normalized) {
		return "", validationError(CodeIdempotencyKeyInvalid, MessageIdempotencyKeyInvalid)
	}
	return normalized, nil
}

func normalizeOptionIDs(values []string) ([]string, *Error) {
	if len(values) == 0 || len(values) > MaxOptions {
		return nil, validationError(CodeSelectionInvalid, MessageSelectionInvalid)
	}
	seen := map[string]struct{}{}
	result := make([]string, len(values))
	for index, value := range values {
		normalized, err := normalizeIdentifier(value, CodeOptionInvalid, MessageOptionInvalid)
		if err != nil {
			return nil, err
		}
		if _, ok := seen[normalized]; ok {
			return nil, validationError(CodeSelectionInvalid, "征集选项不能重复")
		}
		seen[normalized] = struct{}{}
		result[index] = normalized
	}
	return result, nil
}

func boundedText(value, code, message string, maxCodePoints, maxBytes int) (string, *Error) {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || len([]byte(value)) > maxBytes || utf8.RuneCountInString(value) > maxCodePoints || hasUnsafeControl(value) {
		return "", validationError(code, message)
	}
	return value, nil
}

func hasUnsafeControl(value string) bool {
	for _, character := range value {
		if (character >= 0 && character <= 0x1f) || (character >= 0x7f && character <= 0x9f) || (character >= 0x202a && character <= 0x202e) || (character >= 0x2066 && character <= 0x2069) {
			return true
		}
	}
	return false
}

func normalizeOptionalTime(value string) (*time.Time, *Error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return nil, validationError(CodeInvalidTime, MessageInvalidTime)
	}
	parsed = parsed.UTC().Truncate(time.Millisecond)
	return &parsed, nil
}

func expired(deadline *time.Time, now time.Time) bool {
	return deadline != nil && !deadline.After(now)
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copyValue := value.UTC().Truncate(time.Millisecond)
	return &copyValue
}

func formatTime(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func formatOptionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	result := formatTime(*value)
	return &result
}

func solicitationCardID(publicID string) string {
	return "echo_sol_" + strings.ToLower(publicID)
}

func truncate(value string, maxCodePoints, maxBytes int) string {
	if utf8.RuneCountInString(value) <= maxCodePoints && len([]byte(value)) <= maxBytes {
		return value
	}
	result := ""
	for _, character := range value {
		candidate := result + string(character)
		if utf8.RuneCountInString(candidate) >= maxCodePoints || len([]byte(candidate+"…")) > maxBytes {
			break
		}
		result = candidate
	}
	return result + "…"
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
