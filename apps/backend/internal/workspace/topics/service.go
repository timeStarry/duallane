package topics

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

const (
	capabilityTopicCreate  = "topic.create"
	capabilityTopicRead    = "topic.read"
	capabilityTopicMessage = "topic.message.create"
	capabilityTopicSync    = "topic.sync_to_group"
	capabilityTopicManage  = "topic.manage"
)

var referencePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var clientMessagePattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,200}$`)
var idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
var emojiPattern = regexp.MustCompile(`(?i)^[a-z0-9_+:\-]{1,64}$`)

type Clock func() time.Time
type IDFactory func() (string, error)

type ServiceOptions struct {
	Repository         Repository
	SpaceID            string
	Now                Clock
	IDFactory          IDFactory
	RequireMessageJobs bool
}

type Service struct {
	repo               Repository
	spaceID            string
	now                Clock
	idFactory          IDFactory
	requireMessageJobs bool
}

type rejection struct {
	err   *Error
	audit AuditInput
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
	return &Service{repo: options.Repository, spaceID: spaceID, now: now, idFactory: idFactory, requireMessageJobs: options.RequireMessageJobs}
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

func (s *Service) space() string {
	if s == nil || strings.TrimSpace(s.spaceID) == "" {
		return DefaultSpaceID
	}
	return s.spaceID
}

func (s *Service) nowUTC() time.Time {
	now := time.Now()
	if s != nil && s.now != nil {
		now = s.now()
	}
	if now.IsZero() {
		now = time.Unix(0, 0)
	}
	return now.UTC().Truncate(time.Millisecond)
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

// withTransaction resolves the actor again inside the write transaction. A
// domain rejection writes its content-free audit row and commits that row;
// storage and invariant failures roll the transaction back.
func (s *Service) withTransaction(ctx context.Context, actorID string, meta auth.RequestMeta, fn func(Tx, *auth.Actor, time.Time) (any, *rejection, error)) (any, error) {
	return s.withTransactionUsing(ctx, nil, actorID, meta, fn)
}

func (s *Service) withTransactionUsing(ctx context.Context, external Tx, actorID string, meta auth.RequestMeta, fn func(Tx, *auth.Actor, time.Time) (any, *rejection, error)) (any, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace topic service", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	if fn == nil {
		return nil, internalError("workspace topic transaction", errors.New("callback is required"))
	}
	meta = meta.Safe()
	var result any
	var rejected *rejection
	run := func(tx Tx) error {
		if tx == nil {
			return errors.New("transaction is required")
		}
		actor, err := s.lookupActor(ctx, tx, actorID)
		if err != nil {
			return err
		}
		now := s.nowUTC()
		result, rejected, err = fn(tx, actor, now)
		if err != nil {
			return err
		}
		if rejected == nil {
			return nil
		}
		audit, err := s.auditFor(actor, meta, rejected.audit, now)
		if err != nil {
			return err
		}
		if err := tx.WriteAudit(ctx, audit); err != nil {
			return internalError("write topic rejection audit", err)
		}
		return nil
	}
	var err error
	if external != nil {
		err = run(external)
	} else {
		err = s.repo.WithTx(ctx, run)
	}
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if rejected != nil {
		if external != nil {
			return nil, &transactionRejection{err: rejected.err}
		}
		return nil, rejected.err
	}
	return result, nil
}

func (s *Service) lookupActor(ctx context.Context, repo ReadRepository, actorID string) (*auth.Actor, error) {
	actor, err := repo.LookupActor(ctx, s.space(), strings.TrimSpace(actorID))
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if actor == nil || strings.TrimSpace(actor.ID) == "" || actor.ID != strings.TrimSpace(actorID) || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	if actor.Kind != "" && actor.Kind != "human" {
		return nil, identityForbiddenError()
	}
	return actor, nil
}

func (s *Service) readActor(ctx context.Context, actorID string) (*auth.Actor, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("read topic actor", errors.New("repository is required"))
	}
	return s.lookupActor(ctx, s.repo, actorID)
}

func (s *Service) auditFor(actor *auth.Actor, meta auth.RequestMeta, input AuditInput, now time.Time) (AuditInput, error) {
	if strings.TrimSpace(input.ID) == "" {
		id, err := s.newID("topic audit")
		if err != nil {
			return AuditInput{}, internalError("generate topic audit id", err)
		}
		input.ID = id
	}
	input.SpaceID = s.space()
	if actor != nil {
		input.ActorUserID = actor.ID
		input.ActorGitHubLogin = actor.GitHubLogin
	}
	safe := meta.Safe()
	input.RequestID = safe.RequestID
	input.IPAddress = safe.IPAddress
	input.UserAgent = safe.UserAgent
	if input.Result == "" {
		input.Result = "success"
	}
	if input.CreatedAt.IsZero() {
		input.CreatedAt = now
	}
	return input, nil
}

func (s *Service) writeAudit(ctx context.Context, tx Tx, actor *auth.Actor, meta auth.RequestMeta, input AuditInput, now time.Time) error {
	audit, err := s.auditFor(actor, meta, input, now)
	if err != nil {
		return err
	}
	if err := tx.WriteAudit(ctx, audit); err != nil {
		return internalError("write topic audit", err)
	}
	return nil
}

func (s *Service) writeEvent(ctx context.Context, tx Tx, input EventInput, now time.Time) (EventRecord, error) {
	if strings.TrimSpace(input.ID) == "" {
		id, err := s.newID("topic event")
		if err != nil {
			return EventRecord{}, internalError("generate topic event id", err)
		}
		input.ID = id
	}
	input.SpaceID = s.space()
	if input.CreatedAt.IsZero() {
		input.CreatedAt = now
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return EventRecord{}, internalError("encode topic event", errors.New("payload is not valid JSON"))
	}
	return tx.WriteEvent(ctx, input)
}

func rejected(err *Error, action, targetID, reason string) *rejection {
	return &rejection{err: err, audit: AuditInput{Action: action, TargetType: TopicTargetType, TargetID: strings.TrimSpace(targetID), Result: "rejected", Reason: strings.TrimSpace(reason)}}
}

func (s *Service) requireRole(actor *auth.Actor, capability string) *Error {
	if actor == nil || actor.Kind != "human" || actor.Role == "auditor" {
		return permissionDeniedError()
	}
	switch capability {
	case capabilityTopicCreate, capabilityTopicRead, capabilityTopicMessage, capabilityTopicSync:
		if actor.Role == "owner" || actor.Role == "admin" || actor.Role == "member" {
			return nil
		}
	case capabilityTopicManage:
		if actor.Role == "owner" || actor.Role == "admin" {
			return nil
		}
	}
	return permissionDeniedError()
}

func (s *Service) authorizeGroup(ctx context.Context, tx ReadRepository, actor *auth.Actor, conversationID string) (*ConversationRecord, *Error, error) {
	conversationID = strings.TrimSpace(conversationID)
	if !validReferenceID(conversationID) {
		return nil, topicValidationError(CodeTopicInvalidConversation, MessageTopicInvalidConversation), nil
	}
	conversation, err := tx.GetConversation(ctx, s.space(), conversationID)
	if err != nil {
		return nil, nil, err
	}
	if conversation == nil || conversation.Type != "group" || conversation.SpaceID != "" && conversation.SpaceID != s.space() {
		return nil, topicValidationError(CodeTopicGroupOnly, MessageTopicGroupOnly), nil
	}
	active, err := tx.ConversationMemberActive(ctx, s.space(), conversationID, actor.ID)
	if err != nil {
		return nil, nil, err
	}
	if !active {
		return nil, topicNotFoundError(), nil
	}
	return conversation, nil, nil
}

func (s *Service) topicForActor(ctx context.Context, repo ReadRepository, actor *auth.Actor, topicID string, requireMember bool) (*TopicRecord, *Error, error) {
	topicID = strings.TrimSpace(topicID)
	if !validReferenceID(topicID) {
		return nil, topicValidationError(CodeTopicInvalidID, MessageTopicInvalidID), nil
	}
	record, err := repo.GetTopic(ctx, s.space(), topicID, actor.ID)
	if err != nil {
		return nil, nil, err
	}
	if record == nil || record.SpaceID != "" && record.SpaceID != s.space() || record.Status == "" {
		return nil, topicNotFoundError(), nil
	}
	active, err := repo.ConversationMemberActive(ctx, s.space(), record.ConversationID, actor.ID)
	if err != nil {
		return nil, nil, err
	}
	if !active {
		return nil, topicNotFoundError(), nil
	}
	member, err := repo.GetTopicMember(ctx, s.space(), record.ID, actor.ID)
	if err != nil {
		return nil, nil, err
	}
	record.Joined = member != nil && member.LeftAt == nil
	if requireMember && !record.Joined {
		return nil, topicNotFoundError(), nil
	}
	if member != nil && record.Joined {
		record.NotificationLevel = member.NotificationLevel
	}
	record.UnreadCount, err = repo.TopicUnread(ctx, s.space(), record.ID, actor.ID)
	if err != nil {
		return nil, nil, err
	}
	return record, nil, nil
}

func (s *Service) projectTopic(record TopicRecord, viewerID string, full bool) Topic {
	creatorName := firstNonEmpty(stringPointerValue(record.CreatorRemark), stringPointerValue(record.CreatorNickname), record.CreatorGitHubLogin, record.CreatorDisplayName)
	if creatorName == "" {
		creatorName = "成员"
	}
	creator := TopicActor{
		ID: record.CreatedBy, DisplayName: creatorName, Nickname: record.CreatorNickname,
		Remark: record.CreatorRemark, GitHubLogin: record.CreatorGitHubLogin,
		AvatarURL: sanitizeAvatarPointer(record.CreatorAvatarURL),
	}
	topic := Topic{
		ID: record.ID, SpaceID: record.SpaceID, ConversationID: record.ConversationID,
		Title: record.Title, CreatedBy: record.CreatedBy, Creator: creator,
		Status: record.Status, AllowSyncToGroup: record.AllowSyncToGroup,
		Revision: record.Revision, ParticipantCount: record.ParticipantCount,
		Joined: record.Joined, CanJoin: record.Status == StatusOpen && !record.Joined,
		CreatedAt: formatTimestamp(record.CreatedAt), UpdatedAt: formatTimestamp(record.UpdatedAt),
		ClosedAt: formatNullableTimestamp(record.ClosedAt), ArchivedAt: formatNullableTimestamp(record.ArchivedAt),
		ViewerID: viewerID, LastReadMessageID: record.LastReadMessageID,
		LastReadSeq: record.LastReadSeq, NotificationLevel: firstNonEmpty(record.NotificationLevel, NotificationAll),
		UnreadCount: record.UnreadCount,
	}
	if full {
		description := record.Description
		topic.Description = &description
	} else {
		preview := summarize(record.Description)
		topic.DescriptionPreview = &preview
	}
	return topic
}

func (s *Service) projectTopicMember(record TopicMemberRecord) TopicMember {
	displayName := firstNonEmpty(stringPointerValue(record.Remark), stringPointerValue(record.Nickname), record.GitHubLogin, record.DisplayName)
	if displayName == "" {
		displayName = "成员"
	}
	return TopicMember{
		UserID: record.UserID, JoinedAt: formatTimestamp(record.JoinedAt),
		NotificationLevel: firstNonEmpty(record.NotificationLevel, NotificationAll), DisplayName: displayName,
		Nickname: record.Nickname, GitHubLogin: record.GitHubLogin,
		AvatarURL: sanitizeAvatarPointer(record.AvatarURL), Kind: record.Kind, Remark: record.Remark,
	}
}

func (s *Service) List(ctx context.Context, input ListInput) ([]Topic, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return nil, err
	}
	conversationID := strings.TrimSpace(input.ConversationID)
	if conversationID != "" && !validReferenceID(conversationID) {
		return nil, topicValidationError(CodeTopicInvalidConversation, MessageTopicInvalidConversation)
	}
	status := strings.TrimSpace(input.Status)
	if status != "" && !validStatus(status) {
		return nil, topicValidationError(CodeTopicInvalidStatus, MessageTopicInvalidStatus)
	}
	limit, validationErr := boundedLimit(input.Limit, DefaultTopicLimit, MaxTopicLimit)
	if validationErr != nil {
		return nil, validationErr
	}
	records, err := s.repo.ListTopics(ctx, TopicListQuery{SpaceID: s.space(), ActorID: actor.ID, ConversationID: conversationID, Status: status, Mine: input.Mine, Limit: limit})
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	result := make([]Topic, 0, len(records))
	for _, record := range records {
		if record.SpaceID == "" {
			record.SpaceID = s.space()
		}
		if record.Joined {
			if record.NotificationLevel == "" {
				record.NotificationLevel = NotificationAll
			}
		}
		unread, err := s.repo.TopicUnread(ctx, s.space(), record.ID, actor.ID)
		if err != nil {
			return nil, normalizeRepositoryError(err)
		}
		record.UnreadCount = unread
		result = append(result, s.projectTopic(record, actor.ID, record.Joined))
	}
	return result, nil
}

func (s *Service) ListTopics(ctx context.Context, input ListInput) ([]Topic, error) {
	return s.List(ctx, input)
}

func (s *Service) Create(ctx context.Context, input CreateInput) (Topic, error) {
	return s.createUsing(ctx, nil, input)
}

// CreateInTx keeps the topic, membership, messages, cards, events and jobs in
// the caller's transaction. Only IsTransactionRejection permits committing an
// error result: it denotes a content-free rejection audit with no domain writes.
func (s *Service) CreateInTx(ctx context.Context, tx Tx, input CreateInput) (Topic, error) {
	if tx == nil {
		return Topic{}, internalError("create topic in transaction", errors.New("transaction is required"))
	}
	return s.createUsing(ctx, tx, input)
}

func (s *Service) createUsing(ctx context.Context, tx Tx, input CreateInput) (Topic, error) {
	if strings.TrimSpace(input.ActorID) == "" {
		return Topic{}, authRequiredError()
	}
	result, err := s.withTransactionUsing(ctx, tx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		conversation, denied, err := s.authorizeGroup(ctx, tx, actor, input.ConversationID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if denied != nil {
			return nil, rejected(denied, "topic.create", "new", denied.Code), nil
		}
		if denied := s.requireRole(actor, capabilityTopicCreate); denied != nil {
			return nil, rejected(denied, "topic.create", "new", "permission.denied"), nil
		}
		title, description, validationErr := parseCreateFields(input)
		if validationErr != nil {
			return nil, rejected(validationErr, "topic.create", "new", validationErr.Code), nil
		}
		idempotencyKey, validationErr := normalizeIdempotencyKey(input.IdempotencyKey)
		if validationErr != nil {
			return nil, rejected(validationErr, "topic.create", "new", validationErr.Code), nil
		}
		idempotency := optionalString(idempotencyKey)
		// Serialize direct and inline creation before reading the idempotency
		// winner. A PostgreSQL unique error would otherwise abort this transaction.
		if err := tx.Lock(ctx, "workspace:topic:create:"+actor.ID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if existing, err := tx.GetTopicByIdempotency(ctx, s.space(), actor.ID, idempotencyKey); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		} else if existing != nil {
			if existing.ConversationID != conversation.ID || existing.Title != title || existing.Description != description || existing.AllowSyncToGroup != input.AllowSyncToGroup {
				return nil, rejected(topicConflictError(CodeTopicIdempotencyConflict, MessageTopicIdempotencyConflict), "topic.create", existing.ID, CodeTopicIdempotencyConflict), nil
			}
			existing.Joined = true
			return s.projectTopic(*existing, actor.ID, true), nil, nil
		}
		id, err := s.newID("topic")
		if err != nil {
			return nil, nil, internalError("generate topic id", err)
		}
		id = "top_" + id
		if err := tx.CreateTopic(ctx, TopicInsert{ID: id, SpaceID: s.space(), ConversationID: conversation.ID, Title: title, Description: description, CreatedBy: actor.ID, AllowSyncToGroup: input.AllowSyncToGroup, IdempotencyKey: idempotency, CreatedAt: now}); err != nil {
			if isUniqueViolation(err) && idempotencyKey != "" {
				winner, lookupErr := tx.GetTopicByIdempotency(ctx, s.space(), actor.ID, idempotencyKey)
				if lookupErr != nil {
					return nil, nil, normalizeRepositoryError(lookupErr)
				}
				if winner != nil && winner.ConversationID == conversation.ID && winner.Title == title && winner.Description == description && winner.AllowSyncToGroup == input.AllowSyncToGroup {
					winner.Joined = true
					return s.projectTopic(*winner, actor.ID, true), nil, nil
				}
				return nil, rejected(topicConflictError(CodeTopicIdempotencyConflict, MessageTopicIdempotencyConflict), "topic.create", "new", CodeTopicIdempotencyConflict), nil
			}
			return nil, nil, normalizeRepositoryError(err)
		}
		if _, err := tx.InsertTopicMember(ctx, id, actor.ID, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		topic, err := tx.GetTopic(ctx, s.space(), id, actor.ID)
		if err != nil || topic == nil {
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			return nil, nil, internalError("load created topic", errors.New("topic disappeared after insert"))
		}
		if err := s.createTopicCreationBundle(ctx, tx, *topic, actor, input.Meta, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "topic.create", TargetType: TopicTargetType, TargetID: id, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		created, err := tx.GetTopic(ctx, s.space(), id, actor.ID)
		if err != nil || created == nil {
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			return nil, nil, internalError("load created topic", errors.New("topic disappeared after creation"))
		}
		created.Joined = true
		return s.projectTopic(*created, actor.ID, true), nil, nil
	})
	if err != nil {
		return Topic{}, err
	}
	return result.(Topic), nil
}

func (s *Service) CreateTopic(ctx context.Context, input CreateInput) (Topic, error) {
	return s.Create(ctx, input)
}

func (s *Service) GetSummary(ctx context.Context, input TopicInput) (Topic, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return Topic{}, err
	}
	record, denied, err := s.topicForActor(ctx, s.repo, actor, input.TopicID, false)
	if err != nil {
		return Topic{}, normalizeRepositoryError(err)
	}
	if denied != nil {
		return Topic{}, denied
	}
	return s.projectTopic(*record, actor.ID, record.Joined), nil
}

func (s *Service) GetTopicSummary(ctx context.Context, input TopicInput) (Topic, error) {
	return s.GetSummary(ctx, input)
}

func (s *Service) GetDetails(ctx context.Context, input TopicInput) (Topic, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return Topic{}, err
	}
	record, denied, err := s.topicForActor(ctx, s.repo, actor, input.TopicID, true)
	if err != nil {
		return Topic{}, normalizeRepositoryError(err)
	}
	if denied != nil {
		return Topic{}, denied
	}
	return s.projectTopic(*record, actor.ID, true), nil
}

func (s *Service) GetTopicDetails(ctx context.Context, input TopicInput) (Topic, error) {
	return s.GetDetails(ctx, input)
}

func (s *Service) Join(ctx context.Context, input TopicInput) (Topic, error) {
	return s.changeMembership(ctx, input, true)
}

func (s *Service) JoinTopic(ctx context.Context, input TopicInput) (Topic, error) {
	return s.Join(ctx, input)
}

func (s *Service) Leave(ctx context.Context, input TopicInput) (Topic, error) {
	return s.changeMembership(ctx, input, false)
}

func (s *Service) LeaveTopic(ctx context.Context, input TopicInput) (Topic, error) {
	return s.Leave(ctx, input)
}

func (s *Service) changeMembership(ctx context.Context, input TopicInput, join bool) (Topic, error) {
	result, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		topic, denied, err := s.topicForActor(ctx, tx, actor, input.TopicID, false)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if denied != nil {
			return nil, rejected(denied, topicAction(join, "join", "leave"), auditTarget(input.TopicID), denied.Code), nil
		}
		if denied := s.requireRole(actor, capabilityTopicRead); denied != nil {
			return nil, rejected(denied, topicAction(join, "join", "leave"), topic.ID, "permission.denied"), nil
		}
		if err := tx.Lock(ctx, "workspace:topic:"+topic.ID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		groupMember, err := tx.ConversationMemberActive(ctx, s.space(), topic.ConversationID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if !groupMember {
			return nil, rejected(topicNotFoundError(), topicAction(join, "join", "leave"), topic.ID, CodeTopicNotFound), nil
		}
		current, err := tx.GetTopic(ctx, s.space(), topic.ID, actor.ID)
		if err != nil || current == nil {
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			return nil, rejected(topicNotFoundError(), topicAction(join, "join", "leave"), topic.ID, CodeTopicNotFound), nil
		}
		member, err := tx.GetTopicMember(ctx, s.space(), current.ID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		active := member != nil && member.LeftAt == nil
		if join {
			if active {
				current.Joined = true
				if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "topic.join", TargetType: TopicTargetType, TargetID: current.ID, Result: "success"}, now); err != nil {
					return nil, nil, err
				}
				return s.projectTopic(*current, actor.ID, true), nil, nil
			}
			if current.Status != StatusOpen {
				return nil, rejected(topicValidationError(CodeTopicNotOpen, MessageTopicNotOpen), "topic.join", current.ID, CodeTopicNotOpen), nil
			}
			var changed bool
			if member != nil {
				changed, err = tx.RejoinTopicMember(ctx, current.ID, actor.ID, now)
			} else {
				changed, err = tx.InsertTopicMember(ctx, current.ID, actor.ID, now)
			}
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			if changed {
				if err := s.writeEventPayload(ctx, tx, EventInput{Type: "topic.joined", ActorID: actor.ID, ConversationID: current.ConversationID, TargetType: TopicTargetType, TargetID: current.ID, Payload: map[string]any{"topicId": current.ID, "userId": actor.ID}}, now); err != nil {
					return nil, nil, err
				}
				if err := s.refreshCards(ctx, tx, *current, actor.ID, now); err != nil {
					return nil, nil, err
				}
				if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "topic.join", TargetType: TopicTargetType, TargetID: current.ID, Result: "success"}, now); err != nil {
					return nil, nil, err
				}
			}
			updated, err := tx.GetTopic(ctx, s.space(), current.ID, actor.ID)
			if err != nil || updated == nil {
				if err != nil {
					return nil, nil, normalizeRepositoryError(err)
				}
				return nil, nil, internalError("load joined topic", errors.New("topic disappeared after join"))
			}
			updated.Joined = true
			return s.projectTopic(*updated, actor.ID, true), nil, nil
		}
		if actor.ID == current.CreatedBy && current.Status == StatusOpen {
			return nil, rejected(topicValidationError(CodeTopicCreatorRequired, MessageTopicCreatorRequired), "topic.leave", current.ID, CodeTopicCreatorRequired), nil
		}
		if !active {
			current.Joined = false
			return s.projectTopic(*current, actor.ID, false), nil, nil
		}
		changed, err := tx.LeaveTopicMember(ctx, current.ID, actor.ID, now)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if changed {
			if err := s.writeEventPayload(ctx, tx, EventInput{Type: "topic.left", ActorID: actor.ID, ConversationID: current.ConversationID, TargetType: TopicTargetType, TargetID: current.ID, Payload: map[string]any{"topicId": current.ID, "userId": actor.ID}}, now); err != nil {
				return nil, nil, err
			}
			if err := s.refreshCards(ctx, tx, *current, actor.ID, now); err != nil {
				return nil, nil, err
			}
			if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "topic.leave", TargetType: TopicTargetType, TargetID: current.ID, Result: "success"}, now); err != nil {
				return nil, nil, err
			}
		}
		updated, err := tx.GetTopic(ctx, s.space(), current.ID, actor.ID)
		if err != nil || updated == nil {
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			return nil, nil, internalError("load left topic", errors.New("topic disappeared after leave"))
		}
		updated.Joined = false
		return s.projectTopic(*updated, actor.ID, false), nil, nil
	})
	if err != nil {
		return Topic{}, err
	}
	return result.(Topic), nil
}

func (s *Service) ListMembers(ctx context.Context, input TopicInput) ([]TopicMember, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return nil, err
	}
	record, denied, err := s.topicForActor(ctx, s.repo, actor, input.TopicID, true)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if denied != nil {
		return nil, denied
	}
	rows, err := s.repo.ListTopicMembers(ctx, s.space(), record.ID, actor.ID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	result := make([]TopicMember, 0, len(rows))
	for _, row := range rows {
		result = append(result, s.projectTopicMember(row))
	}
	return result, nil
}

func (s *Service) ListTopicMembers(ctx context.Context, input TopicInput) ([]TopicMember, error) {
	return s.ListMembers(ctx, input)
}

func (s *Service) UpdateNotification(ctx context.Context, input NotificationInput) (Topic, error) {
	level := strings.TrimSpace(input.NotificationLevel)
	if level == "" {
		level = strings.TrimSpace(input.Level)
	}
	result, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		topic, denied, err := s.topicForActor(ctx, tx, actor, input.TopicID, true)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if denied != nil {
			return nil, rejected(denied, "topic.notification.update", auditTarget(input.TopicID), denied.Code), nil
		}
		if denied := s.requireRole(actor, capabilityTopicRead); denied != nil {
			return nil, rejected(denied, "topic.notification.update", topic.ID, "permission.denied"), nil
		}
		if !validNotification(level) {
			return nil, rejected(topicValidationError(CodeTopicNotificationInvalid, MessageTopicNotificationInvalid), "topic.notification.update", topic.ID, CodeTopicNotificationInvalid), nil
		}
		if err := tx.Lock(ctx, "workspace:topic:"+topic.ID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		member, err := tx.GetTopicMember(ctx, s.space(), topic.ID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if member == nil || member.LeftAt != nil {
			return nil, rejected(topicNotFoundError(), "topic.notification.update", topic.ID, CodeTopicNotMember), nil
		}
		if err := tx.UpdateTopicNotification(ctx, topic.ID, actor.ID, level); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if err := s.writeEventPayload(ctx, tx, EventInput{Type: "topic.notification.updated", ActorID: actor.ID, ConversationID: topic.ConversationID, TargetType: TopicTargetType, TargetID: topic.ID, Payload: map[string]any{"topicId": topic.ID, "userId": actor.ID, "notificationLevel": level}}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "topic.notification.update", TargetType: TopicTargetType, TargetID: topic.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		updated, err := tx.GetTopic(ctx, s.space(), topic.ID, actor.ID)
		if err != nil || updated == nil {
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			return nil, nil, internalError("load updated topic", errors.New("topic disappeared after update"))
		}
		updated.Joined = true
		updated.NotificationLevel = level
		return s.projectTopic(*updated, actor.ID, true), nil, nil
	})
	if err != nil {
		return Topic{}, err
	}
	return result.(Topic), nil
}

func (s *Service) UpdateTopicNotificationLevel(ctx context.Context, input NotificationInput) (Topic, error) {
	return s.UpdateNotification(ctx, input)
}

func (s *Service) Transition(ctx context.Context, input TransitionInput, targetStatus string) (Topic, error) {
	targetStatus = strings.TrimSpace(targetStatus)
	if targetStatus != StatusClosed && targetStatus != StatusArchived {
		return Topic{}, topicValidationError(CodeTopicInvalidTransition, MessageTopicInvalidTransition)
	}
	result, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		topic, denied, err := s.topicForActor(ctx, tx, actor, input.TopicID, false)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if denied != nil {
			return nil, rejected(denied, "topic."+targetStatus, auditTarget(input.TopicID), denied.Code), nil
		}
		if denied := s.requireRole(actor, capabilityTopicRead); denied != nil {
			return nil, rejected(denied, "topic."+targetStatus, topic.ID, "permission.denied"), nil
		}
		if err := tx.Lock(ctx, "workspace:topic:"+topic.ID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		current, err := tx.GetTopic(ctx, s.space(), topic.ID, actor.ID)
		if err != nil || current == nil {
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			return nil, rejected(topicNotFoundError(), topic.ID, topic.ID, CodeTopicNotFound), nil
		}
		if !validRevision(input.ExpectedRevision) || input.ExpectedRevision != current.Revision {
			return nil, rejected(topicConflictError(CodeTopicRevisionConflict, MessageTopicRevisionConflict), "topic."+targetStatus, current.ID, CodeTopicRevisionConflict), nil
		}
		canManage := actor.Role == "owner" || actor.Role == "admin" || targetStatus == StatusClosed && current.CreatedBy == actor.ID
		if !canManage {
			return nil, rejected(permissionDeniedError(), "topic."+targetStatus, current.ID, "permission.denied"), nil
		}
		allowed := current.Status == StatusOpen && (targetStatus == StatusClosed || targetStatus == StatusArchived) || current.Status == StatusClosed && targetStatus == StatusArchived
		if !allowed {
			return nil, rejected(topicConflictError(CodeTopicInvalidTransition, MessageTopicInvalidTransition), "topic."+targetStatus, current.ID, CodeTopicInvalidTransition), nil
		}
		updated, changed, err := tx.TransitionTopic(ctx, current.ID, targetStatus, input.ExpectedRevision, now)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if !changed {
			return nil, rejected(topicConflictError(CodeTopicRevisionConflict, MessageTopicRevisionConflict), "topic."+targetStatus, current.ID, CodeTopicRevisionConflict), nil
		}
		if err := s.writeEventPayload(ctx, tx, EventInput{Type: "topic." + targetStatus, ActorID: actor.ID, ConversationID: current.ConversationID, TargetType: TopicTargetType, TargetID: current.ID, Payload: map[string]any{"topicId": current.ID, "status": targetStatus}}, now); err != nil {
			return nil, nil, err
		}
		if err := s.refreshCards(ctx, tx, *updated, actor.ID, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "topic." + targetStatus, TargetType: TopicTargetType, TargetID: current.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		projectedRecord, loadErr := tx.GetTopic(ctx, s.space(), current.ID, actor.ID)
		if loadErr != nil {
			return nil, nil, normalizeRepositoryError(loadErr)
		}
		if projectedRecord == nil {
			projectedRecord = updated
		}
		projectedRecord.Joined = current.Joined
		return s.projectTopic(*projectedRecord, actor.ID, projectedRecord.Joined), nil, nil
	})
	if err != nil {
		return Topic{}, err
	}
	return result.(Topic), nil
}

func (s *Service) Close(ctx context.Context, input TransitionInput) (Topic, error) {
	return s.Transition(ctx, input, StatusClosed)
}

func (s *Service) CloseTopic(ctx context.Context, input TransitionInput) (Topic, error) {
	return s.Close(ctx, input)
}

func (s *Service) Archive(ctx context.Context, input TransitionInput) (Topic, error) {
	return s.Transition(ctx, input, StatusArchived)
}

func (s *Service) ArchiveTopic(ctx context.Context, input TransitionInput) (Topic, error) {
	return s.Archive(ctx, input)
}

func (s *Service) refreshCards(ctx context.Context, tx Tx, topic TopicRecord, actorID string, now time.Time) error {
	cards, err := tx.RefreshTopicCards(ctx, topic.ID, topic.Status, now)
	if err != nil {
		return normalizeRepositoryError(err)
	}
	for _, card := range cards {
		if err := s.writeEventPayload(ctx, tx, EventInput{Type: "card.updated", ActorID: actorID, ConversationID: topic.ConversationID, TargetType: "workspace.card", TargetID: card.ID, Payload: map[string]any{"cardId": card.ID, "cardType": card.CardType, "revision": card.Revision, "status": card.Status}}, now); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) writeEventPayload(ctx context.Context, tx Tx, input EventInput, now time.Time) error {
	if input.PayloadJSON == nil {
		payload, err := json.Marshal(input.Payload)
		if err != nil {
			return internalError("encode topic event payload", err)
		}
		input.PayloadJSON = payload
	}
	_, err := s.writeEvent(ctx, tx, input, now)
	return normalizeRepositoryError(err)
}

func parseCreateFields(input CreateInput) (string, string, *Error) {
	var title, description string
	if strings.TrimSpace(input.Source) != "" {
		if parsed, ok := parseTopicSyntax(input.Source); ok {
			title, description = parsed.Title, parsed.Description
		}
	}
	if title == "" {
		title = input.Title
	}
	if description == "" {
		description = input.Description
	}
	title, err := normalizeTitle(title)
	if err != nil {
		return "", "", err
	}
	description, err = normalizeDescription(description)
	if err != nil {
		return "", "", err
	}
	return title, description, nil
}

type TopicIntent struct {
	Title       string
	Description string
}

// ParseWorkspaceTopicSyntax is the side-effect-free parser used by the group
// message adapter before it calls Create. A false result means that the input
// must remain an ordinary message; it is not a partial topic conversion.
func ParseWorkspaceTopicSyntax(source string) (TopicIntent, bool) {
	return parseTopicSyntax(source)
}

// ParseWorkspaceTopic is kept as a short alias for adapters that name the
// operation after the resource rather than the message syntax.
func ParseWorkspaceTopic(source string) (TopicIntent, bool) {
	return ParseWorkspaceTopicSyntax(source)
}

func parseTopicSyntax(source string) (TopicIntent, bool) {
	start := firstNonSpace(source)
	if start < 0 || start+1 >= len(source) || source[start] != '#' || source[start+1] != '[' {
		return TopicIntent{}, false
	}
	titleEnd := strings.Index(source[start+2:], "](")
	if titleEnd < 0 {
		return TopicIntent{}, false
	}
	titleEnd += start + 2
	title := strings.TrimFunc(source[start+2:titleEnd], isSpace)
	if _, err := normalizeTitle(title); err != nil {
		return TopicIntent{}, false
	}
	bodyStart := titleEnd + 2
	bodyEnd := balancedBodyEnd(source, bodyStart)
	if bodyEnd < 0 || strings.TrimFunc(source[bodyEnd+1:], isSpace) != "" {
		return TopicIntent{}, false
	}
	rawBody := source[bodyStart:bodyEnd]
	// The Node parser bounds the untrimmed body; whitespace cannot bypass it.
	if utf8.RuneCountInString(rawBody) > TopicDescriptionMaxPoints || len(rawBody) > TopicDescriptionMaxBytes {
		return TopicIntent{}, false
	}
	description, err := normalizeDescription(rawBody)
	if err != nil {
		return TopicIntent{}, false
	}
	return TopicIntent{Title: title, Description: description}, true
}

func firstNonSpace(value string) int {
	for index, character := range value {
		if !isSpace(character) {
			return index
		}
	}
	return -1
}

func balancedBodyEnd(value string, start int) int {
	depth := 1
	for index := start; index < len(value); index++ {
		switch value[index] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return index
			}
		}
	}
	return -1
}

func normalizeTitle(value string) (string, *Error) {
	value = strings.TrimFunc(value, isSpace)
	if value == "" || utf8.RuneCountInString(value) > TopicTitleMaxCodePoints || strings.ContainsAny(value, "[]\r\n") {
		return "", topicValidationError(CodeTopicInvalidTitle, MessageTopicInvalidTitle)
	}
	return value, nil
}

func normalizeDescription(value string) (string, *Error) {
	value = strings.TrimFunc(value, isSpace)
	if value == "" || utf8.RuneCountInString(value) > TopicDescriptionMaxPoints || len([]byte(value)) > TopicDescriptionMaxBytes {
		return "", topicValidationError(CodeTopicInvalidDescription, MessageTopicInvalidDescription)
	}
	return value, nil
}

func normalizeIdempotencyKey(value string) (string, *Error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if len(value) > 200 || !idempotencyPattern.MatchString(value) {
		return "", topicValidationError(CodeTopicInvalidIdempotency, MessageTopicInvalidIdempotency)
	}
	return value, nil
}

func validReferenceID(value string) bool {
	return referencePattern.MatchString(strings.TrimSpace(value))
}
func validStatus(value string) bool {
	return value == StatusOpen || value == StatusClosed || value == StatusArchived
}
func validNotification(value string) bool {
	return value == NotificationAll || value == NotificationMentions || value == NotificationMuted
}
func validRevision(value int64) bool { return value >= 1 }

func boundedLimit(value, fallback, maximum int) (int, *Error) {
	if value == 0 {
		return fallback, nil
	}
	if value < 1 {
		return 0, topicValidationError(CodeTopicInvalidLimit, MessageTopicInvalidLimit)
	}
	if value > maximum {
		return maximum, nil
	}
	return value, nil
}

func formatTimestamp(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func formatNullableTimestamp(value *time.Time) *string {
	if value == nil || value.IsZero() {
		return nil
	}
	formatted := formatTimestamp(*value)
	return &formatted
}

func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func optionalString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	value = strings.TrimSpace(value)
	return &value
}

func sanitizeAvatarPointer(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	if normalized == "" || strings.Contains(normalized, "..") || strings.ContainsAny(normalized, "\r\n") {
		return nil
	}
	if strings.HasPrefix(normalized, "/assets/") || strings.HasPrefix(normalized, "/api/workspace/avatars/") || strings.HasPrefix(normalized, "https://avatars.githubusercontent.com/") {
		return &normalized
	}
	return nil
}

func summarize(value string) string {
	value = strings.Join(strings.FieldsFunc(value, isSpace), " ")
	runes := []rune(value)
	if len(runes) > 160 {
		return string(runes[:160]) + "…"
	}
	return value
}

func normalizeString(value string) string { return strings.TrimSpace(value) }
func auditTarget(value string) string {
	value = normalizeString(value)
	if validReferenceID(value) {
		return value
	}
	return "invalid"
}
func topicAction(join bool, whenJoin, whenLeave string) string {
	if join {
		return "topic." + whenJoin
	}
	return "topic." + whenLeave
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
func isSpace(character rune) bool {
	// ECMAScript WhiteSpace + LineTerminator: unlike Unicode IsSpace, this
	// includes BOM and excludes NEXT LINE (U+0085).
	switch character {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return character >= '\u2000' && character <= '\u200a'
}
func isUniqueViolation(err error) bool {
	return strings.Contains(strings.ToLower(fmt.Sprint(err)), "unique") || strings.Contains(fmt.Sprint(err), "23505")
}
