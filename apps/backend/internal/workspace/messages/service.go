package messages

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
)

var customEmoteShortcodePattern = regexp.MustCompile(`(?i)^custom:([a-f0-9-]{36})$`)

const (
	conversationReadCapability = "conversation.read"
	messageCreateCapability    = "message.create"
	conversationTargetType     = "conversation"
	messageTargetType          = "message"
	userTargetType             = "user"
)

// Clock and IDFactory are injectable so expiry, retry and failure behavior can
// be tested without sleeping or relying on a process-global random source.
type Clock func() time.Time
type IDFactory func() (string, error)

// AdvancedBlockValidator is an explicit seam for future topic/card/custom
// emote integrations. The messages package does not own those domains and
// rejects their blocks unless a trusted caller supplies a validator.
type AdvancedBlockValidator interface {
	ValidateBlock(ctx context.Context, actor *auth.Actor, conversationID string, block Block) (Block, error)
}

// TransactionalBlockValidator is the narrow in-transaction extension used by
// aggregate writers. It is intentionally separate from AdvancedBlockValidator
// so ordinary human message calls keep their existing dependency graph.
type TransactionalBlockValidator interface {
	ValidateBlockInTx(ctx context.Context, tx Tx, actor *auth.Actor, conversationID string, block Block) (Block, error)
}

// GroupTopicCreator is trusted composition, not a second writer: every topic
// effect must use the supplied message transaction. Nil means ordinary text.
type GroupTopicCreator interface {
	CreateGroupTopic(context.Context, Tx, CreateInput, Content) (*MessageRecord, *GroupTopicRejection, error)
}

type TopicMessageLifecycle interface {
	RecallTopicMessage(context.Context, Tx, MessageRecord, string, time.Time) error
}

type GroupTopicRejection struct {
	Err     *Error
	Audited bool
}

type ServiceOptions struct {
	Repository             Repository
	SpaceID                string
	Now                    Clock
	IDFactory              IDFactory
	ReactionEmoteValidator ReactionEmoteValidator
	AdvancedBlockValidator AdvancedBlockValidator
	GroupTopicCreator      GroupTopicCreator
	AllowBots              bool
	RequireMessageJobs     bool
}

type Service struct {
	repo                   Repository
	spaceID                string
	now                    Clock
	idFactory              IDFactory
	reactionEmoteValidator ReactionEmoteValidator
	advancedBlockValidator AdvancedBlockValidator
	groupTopicCreator      GroupTopicCreator
	allowBots              bool
	requireMessageJobs     bool
}

type rejection struct {
	err     *Error
	audit   AuditInput
	audited bool
}

func NewService(options ServiceOptions) *Service {
	spaceID := normalizeSpaceID(options.SpaceID)
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
		repo:                   options.Repository,
		spaceID:                spaceID,
		now:                    now,
		idFactory:              idFactory,
		reactionEmoteValidator: options.ReactionEmoteValidator,
		advancedBlockValidator: options.AdvancedBlockValidator,
		groupTopicCreator:      options.GroupTopicCreator,
		allowBots:              options.AllowBots,
		requireMessageJobs:     options.RequireMessageJobs,
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
	return now.UTC()
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

// withTransaction resolves the identity again through the transaction and
// commits content-free rejection evidence. A rejected operation returns nil
// from the callback so its audit row commits; storage failures roll back.
func (s *Service) withTransaction(ctx context.Context, actorID string, meta auth.RequestMeta, fn func(Tx, *auth.Actor, time.Time) (any, *rejection, error)) (any, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace message service", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	meta = meta.Safe()
	var result any
	var rejected *rejection
	err := s.repo.WithTx(ctx, func(tx Tx) error {
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
		if rejected == nil || rejected.audited {
			return nil
		}
		audit := s.auditFor(actor, meta, rejected.audit, now)
		if err := tx.WriteAudit(ctx, audit); err != nil {
			return internalError("write message rejection audit", err)
		}
		return nil
	})
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if rejected != nil {
		return nil, rejected.err
	}
	return result, nil
}

func (s *Service) lookupActor(ctx context.Context, repo ReadRepository, actorID string) (*auth.Actor, error) {
	actorID = strings.TrimSpace(actorID)
	actor, err := repo.LookupActor(ctx, s.space(), actorID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if actor == nil || strings.TrimSpace(actor.ID) == "" || actor.ID != actorID || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	if actor.Kind != "" && actor.Kind != "human" && !(s.allowBots && actor.Kind == "bot") {
		return nil, identityForbiddenError()
	}
	return actor, nil
}

func normalizeRepositoryError(err error) error {
	if err == nil {
		return nil
	}
	var messageErr *Error
	if errors.As(err, &messageErr) {
		return messageErr
	}
	var authErr *auth.Error
	if errors.As(err, &authErr) {
		switch authErr.Code {
		case auth.CodeRequired:
			return authRequiredError()
		case auth.CodeIdentityForbidden:
			return identityForbiddenError()
		default:
			return internalError("workspace message repository", err)
		}
	}
	return internalError("workspace message repository", err)
}

func (s *Service) auditFor(actor *auth.Actor, meta auth.RequestMeta, input AuditInput, now time.Time) AuditInput {
	if actor != nil {
		input.ActorUserID = actor.ID
		input.ActorGitHubLogin = actor.GitHubLogin
	}
	input.SpaceID = s.space()
	safe := meta.Safe()
	input.RequestID = safe.RequestID
	input.IPAddress = safe.IPAddress
	input.UserAgent = safe.UserAgent
	if input.Result == "" {
		input.Result = "rejected"
	}
	if input.CreatedAt.IsZero() {
		input.CreatedAt = now
	}
	return input
}

func rejectedError(err *Error, action, targetType, targetID, reason string) *rejection {
	return &rejection{
		err: err,
		audit: AuditInput{
			Action:     action,
			TargetType: targetType,
			TargetID:   strings.TrimSpace(targetID),
			Result:     "rejected",
			Reason:     strings.TrimSpace(reason),
		},
	}
}

func (s *Service) requireCapability(actor *auth.Actor, capability string) *Error {
	if actor == nil || !hasCapability(actor.Role, capability) {
		return permissionDeniedError()
	}
	return nil
}

func hasCapability(role, capability string) bool {
	switch strings.TrimSpace(role) {
	case "owner":
		return true
	case "admin":
		switch capability {
		case conversationReadCapability, messageCreateCapability:
			return true
		}
	case "member":
		switch capability {
		case conversationReadCapability, messageCreateCapability:
			return true
		}
	}
	return false
}

func (s *Service) lockConversation(ctx context.Context, tx Tx, conversationID string) error {
	return tx.Lock(ctx, "workspace:conversation:"+s.space()+":"+strings.TrimSpace(conversationID))
}

func (s *Service) authorizeConversation(ctx context.Context, tx Tx, actor *auth.Actor, conversationID, capability string, lock bool) (*ConversationRecord, *Error, error) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return nil, validationError(CodeConversationRequired, MessageConversationRequired), nil
	}
	if lock {
		if err := s.lockConversation(ctx, tx, conversationID); err != nil {
			return nil, nil, err
		}
	}
	if denied := s.requireCapability(actor, capability); denied != nil {
		return nil, denied, nil
	}
	conversation, err := tx.GetConversation(ctx, s.space(), conversationID)
	if err != nil {
		return nil, nil, err
	}
	if conversation == nil || (conversation.SpaceID != "" && conversation.SpaceID != s.space()) {
		return nil, conversationNotFoundError(), nil
	}
	active, err := tx.ConversationMemberActive(ctx, s.space(), conversationID, actor.ID)
	if err != nil {
		return nil, nil, err
	}
	if !active {
		return nil, conversationNotFoundError(), nil
	}
	return conversation, nil, nil
}

func (s *Service) readAuthorized(ctx context.Context, tx Tx, actor *auth.Actor, conversationID, action string) (*ConversationRecord, *rejection, error) {
	conversation, denied, err := s.authorizeConversation(ctx, tx, actor, conversationID, conversationReadCapability, false)
	if err != nil {
		return nil, nil, err
	}
	if denied != nil {
		reason := auditReason(denied)
		if denied.Code == CodeConversationNotFound {
			reason = "not a conversation member"
		}
		return nil, rejectedError(denied, action, conversationTargetType, conversationID, reason), nil
	}
	return conversation, nil, nil
}

// ListMessages returns chronological public messages. Cursor IDs are scoped to
// the requested conversation; an unknown cursor or around anchor returns an
// empty list just like the current Node service.
func (s *Service) ListMessages(ctx context.Context, options ListOptions) ([]Message, error) {
	value, err := s.withTransaction(ctx, options.ActorID, options.Meta, func(tx Tx, actor *auth.Actor, _ time.Time) (any, *rejection, error) {
		_, rejected, err := s.readAuthorized(ctx, tx, actor, options.ConversationID, "conversation.read")
		if err != nil || rejected != nil {
			return nil, rejected, err
		}
		options.SpaceID = s.space()
		options.ActorID = actor.ID
		options.ConversationID = strings.TrimSpace(options.ConversationID)
		options.Limit = normalizeLimit(options.Limit)
		records, err := tx.ListMessages(ctx, options)
		if err != nil {
			return nil, nil, err
		}
		messages, err := s.projectRecords(ctx, tx, actor, records)
		if err != nil {
			return nil, nil, err
		}
		return messages, nil, nil
	})
	if err != nil {
		return nil, err
	}
	if value == nil {
		return []Message{}, nil
	}
	return value.([]Message), nil
}

// List is a short alias for composition code that treats all domain services
// as list/get operations.
func (s *Service) List(ctx context.Context, options ListOptions) ([]Message, error) {
	return s.ListMessages(ctx, options)
}

func (s *Service) projectRecords(ctx context.Context, repo ReadRepository, viewer *auth.Actor, records []MessageRecord) ([]Message, error) {
	result := make([]Message, 0, len(records))
	if len(records) == 0 {
		return result, nil
	}
	viewerID := ""
	if viewer != nil {
		viewerID = viewer.ID
	}
	ids := make([]string, 0, len(records))
	for _, record := range records {
		ids = append(ids, record.ID)
	}
	attachments, err := repo.ListAttachments(ctx, s.space(), viewerID, ids)
	if err != nil {
		return nil, err
	}
	reactions, err := repo.ListReactions(ctx, s.space(), viewerID, ids)
	if err != nil {
		return nil, err
	}
	hidden, err := repo.ListHidden(ctx, s.space(), viewerID, ids)
	if err != nil {
		return nil, err
	}
	shares := make(map[string]map[string]EmoteCollectionShare, len(records))
	if reader, ok := repo.(MessageShareReader); ok {
		shares, err = reader.ListMessageEmoteCollectionShares(ctx, s.space(), viewerID, ids)
		if err != nil {
			return nil, err
		}
	}
	for _, record := range records {
		record.HiddenByCurrentUser = hidden[record.ID]
		record.EmoteCollectionShares = shares[record.ID]
		projected, err := ProjectMessageForViewer(record, attachments[record.ID], reactions[record.ID], viewer)
		if err != nil {
			return nil, internalError("project workspace message", err)
		}
		result = append(result, projected)
	}
	return result, nil
}

func (s *Service) projectOne(ctx context.Context, repo ReadRepository, viewer *auth.Actor, record *MessageRecord) (Message, error) {
	if record == nil {
		return Message{}, messageNotFoundError()
	}
	projected, err := s.projectRecords(ctx, repo, viewer, []MessageRecord{*record})
	if err != nil {
		return Message{}, err
	}
	if len(projected) != 1 {
		return Message{}, internalError("project workspace message", errors.New("message projection missing"))
	}
	return projected[0], nil
}

func findMessageForViewer(ctx context.Context, repo ReadRepository, spaceID, conversationID, messageID, viewerID string) (*MessageRecord, error) {
	if lookup, ok := repo.(ViewerMessageLookup); ok {
		return lookup.FindMessageForViewer(ctx, spaceID, conversationID, messageID, viewerID)
	}
	return repo.FindMessage(ctx, spaceID, conversationID, messageID)
}

func (s *Service) CreateMessage(ctx context.Context, input CreateInput) (Message, error) {
	value, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		return s.createMessageInTransaction(ctx, tx, actor, now, input, nil)
	})
	if err != nil {
		return Message{}, err
	}
	return value.(Message), nil
}

// CreateMessageInTx applies the complete message mutation to an already-open
// domain transaction. The caller owns commit/rollback; all authorization,
// idempotency, event, audit, relationship, retention, and notification-job
// writes use the supplied Tx.
func (s *Service) CreateMessageInTx(ctx context.Context, tx Tx, input CreateInput, validators ...TransactionalBlockValidator) (Message, error) {
	if s == nil || s.repo == nil {
		return Message{}, internalError("create workspace message", errors.New("repository is required"))
	}
	if tx == nil {
		return Message{}, internalError("create workspace message", errors.New("transaction is required"))
	}
	actorID := strings.TrimSpace(input.ActorID)
	if actorID == "" {
		return Message{}, authRequiredError()
	}
	actor, err := s.lookupActor(ctx, tx, actorID)
	if err != nil {
		return Message{}, err
	}
	now := s.nowUTC()
	var validator TransactionalBlockValidator
	if len(validators) > 0 {
		validator = validators[0]
	}
	value, rejected, err := s.createMessageInTransaction(ctx, tx, actor, now, input, validator)
	if err != nil {
		return Message{}, normalizeRepositoryError(err)
	}
	if rejected != nil {
		if !rejected.audited {
			if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, rejected.audit, now)); err != nil {
				return Message{}, internalError("write message rejection audit", err)
			}
		}
		if input.TopicID != "" {
			return Message{}, &TransactionRejection{Err: rejected.err}
		}
		return Message{}, rejected.err
	}
	message, ok := value.(Message)
	if !ok {
		return Message{}, internalError("project workspace message", errors.New("message result has invalid type"))
	}
	return message, nil
}

func (s *Service) createMessageInTransaction(ctx context.Context, tx Tx, actor *auth.Actor, now time.Time, input CreateInput, transactionalValidator TransactionalBlockValidator) (any, *rejection, error) {
	conversation, denied, err := s.authorizeConversation(ctx, tx, actor, input.ConversationID, messageCreateCapability, true)
	if err != nil {
		return nil, nil, err
	}
	if denied != nil {
		reason := auditReason(denied)
		if denied.Code == CodeConversationNotFound {
			reason = "not a conversation member"
		}
		return nil, rejectedError(denied, "message.create", conversationTargetType, input.ConversationID, reason), nil
	}

	clientMessageID := normalizeString(input.ClientMessageID)
	if clientMessageID == "" || strings.TrimSpace(input.ConversationID) == "" {
		err := validationError(CodeMessageInvalid, MessageInvalid)
		return nil, rejectedError(err, "message.create", conversationTargetType, input.ConversationID, CodeMessageInvalid), nil
	}
	normalized, attachmentIDs, err := s.normalizeContentWithValidator(ctx, tx, actor, conversation.ID, input.Content, transactionalValidator)
	if err != nil {
		return nil, rejectedError(asMessageError(err), "message.create", conversationTargetType, conversation.ID, auditReason(asMessageError(err))), nil
	}
	contentJSON, err := canonicalContent(normalized)
	if err != nil {
		return nil, nil, internalError("canonicalize message content", err)
	}
	inlineTopics := input.TopicID == "" && s.groupTopicCreator != nil && conversation.Type == "group" && (actor.Kind == "" || actor.Kind == "human")
	if inlineTopics {
		// Ordinary and topic-shaped messages share the original client key.
		// Lock before both lookups so concurrent requests cannot create one of each.
		key, err := json.Marshal([]string{s.space(), conversation.ID, actor.ID, clientMessageID})
		if err != nil {
			return nil, nil, err
		}
		if err := tx.Lock(ctx, "workspace:message:create:"+string(key)); err != nil {
			return nil, nil, err
		}
	}

	existing, err := tx.FindMessageByClientID(ctx, s.space(), conversation.ID, actor.ID, clientMessageID)
	if err != nil {
		return nil, nil, err
	}
	if existing != nil {
		if !sameMessageContent(*existing, contentJSON) {
			err := idempotencyConflictError()
			return nil, rejectedError(err, "message.create", conversationTargetType, conversation.ID, CodeMessageIdempotency), nil
		}
		message, err := s.projectOne(ctx, tx, actor, existing)
		return message, nil, err
	}
	if inlineTopics {
		input.ActorID = actor.ID
		input.ClientMessageID = clientMessageID
		input.ConversationID = conversation.ID
		record, denied, err := s.groupTopicCreator.CreateGroupTopic(ctx, tx, input, normalized)
		if err != nil {
			return nil, nil, err
		}
		if denied != nil {
			rejected := rejectedError(denied.Err, "message.create", conversationTargetType, conversation.ID, denied.Err.Code)
			rejected.audited = denied.Audited
			return nil, rejected, nil
		}
		if record != nil {
			message, err := s.projectOne(ctx, tx, actor, record)
			// Only the HTTP response acknowledges the original optimistic key;
			// storage and outbox retain topic-card:<topic ID> for replay.
			message.ClientMessageID = &clientMessageID
			return message, nil, err
		}
	}

	replyID := normalizedOptionalID(input.ReplyToMessageID)
	if replyID != nil {
		exists, err := tx.MessageExists(ctx, s.space(), conversation.ID, *replyID)
		if err != nil {
			return nil, nil, err
		}
		if !exists {
			err := validationError(CodeMessageInvalidReply, MessageInvalidReply)
			return nil, rejectedError(err, "message.create", messageTargetType, *replyID, CodeMessageInvalidReply), nil
		}
	}

	id, err := s.newID("message")
	if err != nil {
		return nil, nil, internalError("generate message id", err)
	}
	inserted, winner, err := tx.InsertMessage(ctx, MessageInsert{
		ID:               id,
		SpaceID:          s.space(),
		ConversationID:   conversation.ID,
		AuthorID:         actor.ID,
		AuthorKind:       actor.Kind,
		Kind:             messageKind(actor),
		ClientMessageID:  clientMessageID,
		ContentFormat:    MessageContentFormat,
		ContentJSON:      contentJSON,
		PlainText:        normalized.PlainText,
		ReplyToMessageID: replyID,
		CreatedAt:        now,
	})
	if err != nil {
		return nil, nil, err
	}
	if !inserted {
		if winner == nil {
			winner, err = tx.FindMessageByClientID(ctx, s.space(), conversation.ID, actor.ID, clientMessageID)
			if err != nil {
				return nil, nil, err
			}
		}
		if winner == nil {
			return nil, nil, internalError("read idempotency winner", errors.New("unique conflict winner is missing"))
		}
		if !sameMessageContent(*winner, contentJSON) {
			err := idempotencyConflictError()
			return nil, rejectedError(err, "message.create", conversationTargetType, conversation.ID, CodeMessageIdempotency), nil
		}
		message, err := s.projectOne(ctx, tx, actor, winner)
		return message, nil, err
	}
	for _, attachmentID := range attachmentIDs {
		if err := tx.LinkMessageAttachment(ctx, s.space(), id, attachmentID); err != nil {
			return nil, nil, err
		}
	}
	for _, customEmoteID := range extractCustomEmoteIDs(normalized) {
		if err := tx.LinkMessageCustomEmote(ctx, id, actor.ID, customEmoteID); err != nil {
			return nil, nil, err
		}
	}
	for _, shareID := range extractEmoteCollectionShareIDs(normalized) {
		if err := tx.LinkMessageEmoteCollectionShare(ctx, id, shareID); err != nil {
			return nil, nil, err
		}
	}
	if err := tx.EnforceRetention(ctx, s.space(), conversation.ID, conversation.RetentionCount, now); err != nil {
		return nil, nil, err
	}
	created, err := tx.FindMessage(ctx, s.space(), conversation.ID, id)
	if err != nil {
		return nil, nil, err
	}
	if created == nil {
		return nil, nil, internalError("read created message", errors.New("inserted message is missing"))
	}
	message, err := s.projectOne(ctx, tx, actor, created)
	if err != nil {
		return nil, nil, err
	}
	payload, err := json.Marshal(map[string]any{
		"messageId":      id,
		"conversationId": conversation.ID,
		"message":        message,
	})
	if err != nil {
		return nil, nil, internalError("encode message event", err)
	}
	event, err := s.writeEventRecord(ctx, tx, EventInput{
		SpaceID:        s.space(),
		Type:           "message.created",
		ActorID:        actor.ID,
		ConversationID: conversation.ID,
		TargetType:     messageTargetType,
		TargetID:       id,
		PayloadJSON:    payload,
		CreatedAt:      now,
	})
	if err != nil {
		return nil, nil, err
	}
	if s.requireMessageJobs {
		jobTx, ok := tx.(MessageJobTx)
		if !ok {
			return nil, nil, internalError("schedule message notification jobs", errors.New("transaction does not support message jobs"))
		}
		if err := jobTx.ScheduleMessageJobs(ctx, messagejobs.Input{
			AuthorID: actor.ID, SpaceID: s.space(), ConversationID: conversation.ID,
			MessageID: id, EventSeq: event.Seq, ContentJSON: contentJSON, CreatedAt: now,
		}); err != nil {
			return nil, nil, internalError("schedule message notification jobs", err)
		}
	}
	if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{
		Action:     "message.create",
		TargetType: conversationTargetType,
		TargetID:   conversation.ID,
		Result:     "success",
	}, now)); err != nil {
		return nil, nil, err
	}
	return message, nil, nil
}

func (s *Service) Create(ctx context.Context, input CreateInput) (Message, error) {
	return s.CreateMessage(ctx, input)
}

func (s *Service) RecallMessage(ctx context.Context, input RecallInput) (Message, error) {
	value, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		messageID := strings.TrimSpace(input.MessageID)
		target, err := findMessageForViewer(ctx, tx, s.space(), "", messageID, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if target == nil {
			err := messageNotFoundError()
			return nil, rejectedError(err, "message.recall", messageTargetType, messageID, CodeMessageNotFound), nil
		}
		conversation, denied, err := s.authorizeConversation(ctx, tx, actor, target.ConversationID, conversationReadCapability, true)
		if err != nil {
			return nil, nil, err
		}
		if denied != nil {
			return nil, rejectedError(denied, "message.recall", messageTargetType, messageID, auditReason(denied)), nil
		}
		if topicDenied, err := s.authorizeMessageTopic(ctx, tx, actor, target, true); err != nil {
			return nil, nil, err
		} else if topicDenied != nil {
			return nil, rejectedError(topicDenied, "message.recall", messageTargetType, messageID, topicDenied.Code), nil
		}
		if target.AuthorID == nil || *target.AuthorID != actor.ID {
			err := permissionDeniedError()
			return nil, rejectedError(err, "message.recall", messageTargetType, messageID, "insufficient permission"), nil
		}
		if target.Kind != "user" || target.AuthorKind != "human" {
			err := NewError(CodeMessageRecallUnsupported, MessageRecallUnsupported, 400)
			return nil, rejectedError(err, "message.recall", messageTargetType, messageID, CodeMessageRecallUnsupported), nil
		}
		if target.RecalledAt != nil && !target.RecalledAt.IsZero() {
			message, err := s.projectOne(ctx, tx, actor, target)
			return message, nil, err
		}
		if input.ExpectedRevision > 0 && target.Revision > 0 && input.ExpectedRevision != target.Revision {
			conflictErr := revisionConflictError()
			return nil, rejectedError(conflictErr, "message.recall", messageTargetType, messageID, CodeMessageRevisionConflict), nil
		}
		reason := DefaultRecallReason
		if lookup, ok := tx.(RecallReasonLookup); ok {
			candidate, err := lookup.LookupRecallReason(ctx, s.space(), actor.ID)
			if err != nil {
				return nil, nil, err
			}
			if normalized := normalizeString(candidate); normalized != "" {
				reason = normalized
			}
		}
		recallText := firstNonEmpty(actor.Nickname, actor.GitHubLogin, actor.DisplayName, "成员") + "因" + reason + "撤回了一条消息"
		emptyContent := Content{Format: MessageContentFormat, PlainText: "", Blocks: make([]Block, 0)}
		emptyContentJSON, err := canonicalContent(emptyContent)
		if err != nil {
			return nil, nil, internalError("encode recalled message content", err)
		}
		changed, err := tx.RecallMessage(ctx, s.space(), messageID, target.Revision, emptyContentJSON, recallText, reason, now)
		if err != nil {
			return nil, nil, err
		}
		if !changed {
			current, err := findMessageForViewer(ctx, tx, s.space(), conversation.ID, messageID, actor.ID)
			if err != nil {
				return nil, nil, err
			}
			if current != nil && current.RecalledAt != nil && !current.RecalledAt.IsZero() {
				message, err := s.projectOne(ctx, tx, actor, current)
				return message, nil, err
			}
			conflictErr := revisionConflictError()
			return nil, rejectedError(conflictErr, "message.recall", messageTargetType, messageID, CodeMessageRevisionConflict), nil
		}
		if err := tx.DeleteMessageReactions(ctx, s.space(), messageID); err != nil {
			return nil, nil, err
		}
		if err := tx.DeleteMessageCustomEmotes(ctx, s.space(), messageID); err != nil {
			return nil, nil, err
		}
		if err := tx.DeleteMessageEmoteCollectionShares(ctx, s.space(), messageID); err != nil {
			return nil, nil, err
		}
		if err := tx.DeleteMessagePins(ctx, s.space(), messageID); err != nil {
			return nil, nil, err
		}
		if target.TopicID != "" {
			lifecycle, ok := s.groupTopicCreator.(TopicMessageLifecycle)
			if !ok {
				return nil, nil, internalError("recall topic message", errors.New("topic lifecycle adapter is required"))
			}
			if err := lifecycle.RecallTopicMessage(ctx, tx, *target, actor.ID, now); err != nil {
				return nil, nil, err
			}
		}
		current, err := findMessageForViewer(ctx, tx, s.space(), conversation.ID, messageID, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if current == nil {
			return nil, nil, internalError("read recalled message", errors.New("recalled message is missing"))
		}
		message, err := s.projectOne(ctx, tx, actor, current)
		if err != nil {
			return nil, nil, err
		}
		eventType, payload, err := messageMutationEvent("message.recalled", target)
		if err != nil {
			return nil, nil, internalError("encode recall event", err)
		}
		if err := s.writeEvent(ctx, tx, EventInput{
			SpaceID:        s.space(),
			Type:           eventType,
			ActorID:        actor.ID,
			ConversationID: conversation.ID,
			TargetType:     messageTargetType,
			TargetID:       messageID,
			PayloadJSON:    payload,
			CreatedAt:      now,
		}); err != nil {
			return nil, nil, err
		}
		if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{
			Action:     "message.recall",
			TargetType: messageTargetType,
			TargetID:   messageID,
			Result:     "success",
		}, now)); err != nil {
			return nil, nil, err
		}
		return message, nil, nil
	})
	if err != nil {
		return Message{}, err
	}
	return value.(Message), nil
}

func (s *Service) Recall(ctx context.Context, input RecallInput) (Message, error) {
	return s.RecallMessage(ctx, input)
}

func (s *Service) HideMessage(ctx context.Context, input HideInput) (HideResult, error) {
	return s.setHidden(ctx, input, true)
}

func (s *Service) UnhideMessage(ctx context.Context, input HideInput) (HideResult, error) {
	return s.setHidden(ctx, input, false)
}

func (s *Service) setHidden(ctx context.Context, input HideInput, hidden bool) (HideResult, error) {
	value, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		messageID := strings.TrimSpace(input.MessageID)
		target, err := findMessageForViewer(ctx, tx, s.space(), "", messageID, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if target == nil {
			err := messageNotFoundError()
			return nil, rejectedError(err, hiddenAction(hidden), messageTargetType, messageID, CodeMessageNotFound), nil
		}
		_, denied, err := s.authorizeConversation(ctx, tx, actor, target.ConversationID, conversationReadCapability, true)
		if err != nil {
			return nil, nil, err
		}
		if denied != nil {
			return nil, rejectedError(denied, hiddenAction(hidden), messageTargetType, messageID, auditReason(denied)), nil
		}
		if topicDenied, err := s.authorizeMessageTopic(ctx, tx, actor, target, false); err != nil {
			return nil, nil, err
		} else if topicDenied != nil {
			return nil, rejectedError(topicDenied, hiddenAction(hidden), messageTargetType, messageID, topicDenied.Code), nil
		}
		var changed bool
		if hidden {
			changed, err = tx.HideMessage(ctx, s.space(), messageID, actor.ID, now)
		} else {
			changed, err = tx.UnhideMessage(ctx, s.space(), messageID, actor.ID)
		}
		if err != nil {
			return nil, nil, err
		}
		return HideResult{MessageID: messageID, Hidden: hidden, Changed: changed}, nil, nil
	})
	if err != nil {
		return HideResult{}, err
	}
	return value.(HideResult), nil
}

func hiddenAction(hidden bool) string {
	if hidden {
		return "message.hide"
	}
	return "message.unhide"
}

func (s *Service) Hide(ctx context.Context, input HideInput) (HideResult, error) {
	return s.HideMessage(ctx, input)
}

func (s *Service) Unhide(ctx context.Context, input HideInput) (HideResult, error) {
	return s.UnhideMessage(ctx, input)
}

func (s *Service) AddReaction(ctx context.Context, input ReactionInput) (ReactionResult, error) {
	return s.setReaction(ctx, input, true)
}

func (s *Service) RemoveReaction(ctx context.Context, input ReactionInput) (ReactionResult, error) {
	return s.setReaction(ctx, input, false)
}

func (s *Service) setReaction(ctx context.Context, input ReactionInput, add bool) (ReactionResult, error) {
	value, err := s.withTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		messageID := strings.TrimSpace(input.MessageID)
		emoteKey := strings.TrimSpace(input.EmoteKey)
		action := reactionAction(add)
		if !validReactionKey(emoteKey) {
			err := NewError(CodeReactionInvalidEmote, MessageReactionInvalidEmote, 400)
			return nil, rejectedError(err, action, messageTargetType, messageID, CodeReactionInvalidEmote), nil
		}
		if s.reactionEmoteValidator == nil {
			err := NewError(CodeReactionInvalidEmote, MessageReactionInvalidEmote, 400)
			return nil, rejectedError(err, action, messageTargetType, messageID, CodeReactionInvalidEmote), nil
		}
		known := false
		var validationErr error
		if add {
			known, validationErr = s.reactionEmoteValidator.IsVisibleReactionEmote(ctx, emoteKey)
		} else {
			known, validationErr = s.reactionEmoteValidator.IsKnownReactionEmote(ctx, emoteKey)
		}
		if validationErr != nil {
			return nil, nil, validationErr
		}
		if !known {
			err := NewError(CodeReactionInvalidEmote, MessageReactionInvalidEmote, 400)
			return nil, rejectedError(err, action, messageTargetType, messageID, CodeReactionInvalidEmote), nil
		}
		target, err := findMessageForViewer(ctx, tx, s.space(), "", messageID, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if target == nil {
			err := messageNotFoundError()
			return nil, rejectedError(err, action, messageTargetType, messageID, CodeMessageNotFound), nil
		}
		_, denied, err := s.authorizeConversation(ctx, tx, actor, target.ConversationID, conversationReadCapability, true)
		if err != nil {
			return nil, nil, err
		}
		if denied != nil {
			return nil, rejectedError(denied, action, messageTargetType, messageID, auditReason(denied)), nil
		}
		if topicDenied, err := s.authorizeMessageTopic(ctx, tx, actor, target, true); err != nil {
			return nil, nil, err
		} else if topicDenied != nil {
			return nil, rejectedError(topicDenied, action, messageTargetType, messageID, topicDenied.Code), nil
		}
		if target.Kind != "user" && target.Kind != "bot" {
			err := NewError(CodeReactionUnsupported, MessageReactionUnsupported, 400)
			return nil, rejectedError(err, action, messageTargetType, messageID, CodeReactionUnsupported), nil
		}
		var changed bool
		if add {
			changed, err = tx.AddReaction(ctx, s.space(), messageID, actor.ID, emoteKey, now)
		} else {
			changed, err = tx.RemoveReaction(ctx, s.space(), messageID, actor.ID, emoteKey, now)
		}
		if err != nil {
			return nil, nil, err
		}
		reactionsByMessage, err := tx.ListReactions(ctx, s.space(), actor.ID, []string{messageID})
		if err != nil {
			return nil, nil, err
		}
		groups := cloneReactionGroups(reactionsByMessage[messageID])
		if changed {
			eventType := "reaction.removed"
			if add {
				eventType = "reaction.added"
			}
			eventType, payload, err := messageMutationEvent(eventType, target)
			if err != nil {
				return nil, nil, internalError("encode reaction event", err)
			}
			if err := s.writeEvent(ctx, tx, EventInput{
				SpaceID:        s.space(),
				Type:           eventType,
				ActorID:        actor.ID,
				ConversationID: target.ConversationID,
				TargetType:     messageTargetType,
				TargetID:       messageID,
				PayloadJSON:    payload,
				CreatedAt:      now,
			}); err != nil {
				return nil, nil, err
			}
		}
		return ReactionResult{MessageID: messageID, Reactions: groups, Created: add && changed, Removed: !add && changed}, nil, nil
	})
	if err != nil {
		return ReactionResult{}, err
	}
	return value.(ReactionResult), nil
}

func reactionAction(add bool) string {
	if add {
		return "reaction.add"
	}
	return "reaction.remove"
}

func (s *Service) Remove(ctx context.Context, input ReactionInput) (ReactionResult, error) {
	return s.RemoveReaction(ctx, input)
}

func (s *Service) normalizeContentWithValidator(ctx context.Context, repo ReadRepository, actor *auth.Actor, conversationID string, input Content, transactionalValidator TransactionalBlockValidator) (Content, []string, error) {
	if input.Format != MessageContentFormat {
		if input.Format == "" {
			return Content{}, nil, validationError(CodeMessageInvalidContent, MessageInvalidContent)
		}
		return Content{}, nil, validationError(CodeMessageUnsupported, MessageUnsupportedFormat)
	}
	if len(input.Blocks) == 0 {
		return Content{}, nil, validationError(CodeMessageEmpty, MessageEmpty)
	}
	rawText := make([]string, 0, len(input.Blocks))
	for _, block := range input.Blocks {
		if block.Type == "text" {
			if !utf8.ValidString(block.Text) {
				return Content{}, nil, validationError(CodeMessageInvalidText, MessageInvalidText)
			}
			rawText = append(rawText, block.Text)
		}
	}
	raw := strings.Join(rawText, "")
	codePoints, byteCount := messageTextLength(raw)
	if codePoints > MaxMessageTextCodePoints || byteCount > MaxMessageTextBytes {
		return Content{}, nil, validationError(CodeMessageTooLong, MessageTooLong)
	}
	normalized := Content{Format: MessageContentFormat, Blocks: make([]Block, 0, len(input.Blocks))}
	attachmentIDs := make([]string, 0)
	attachmentSeen := make(map[string]struct{})
	for _, block := range input.Blocks {
		candidate, attachmentID, err := s.normalizeBlockWithValidator(ctx, repo, actor, conversationID, block, transactionalValidator)
		if err != nil {
			return Content{}, nil, err
		}
		normalized.Blocks = append(normalized.Blocks, candidate)
		if attachmentID != "" {
			if _, ok := attachmentSeen[attachmentID]; !ok {
				attachmentSeen[attachmentID] = struct{}{}
				attachmentIDs = append(attachmentIDs, attachmentID)
			}
		}
	}
	normalized.PlainText = ProjectPlainText(normalized.Blocks)
	if normalized.PlainText == "" {
		return Content{}, nil, validationError(CodeMessageEmpty, MessageEmpty)
	}
	return normalized, attachmentIDs, nil
}

func (s *Service) normalizeBlockWithValidator(ctx context.Context, repo ReadRepository, actor *auth.Actor, conversationID string, block Block, transactionalValidator TransactionalBlockValidator) (Block, string, error) {
	switch block.Type {
	case "text":
		normalized := normalizeTextBlock(block.Text)
		if normalized == "" {
			return Block{}, "", validationError(CodeMessageInvalidText, MessageInvalidText)
		}
		return Block{Type: "text", Text: normalized}, "", nil
	case "mention":
		userID := normalizeString(block.UserID)
		member, err := repo.FindMentionMember(ctx, s.space(), conversationID, userID)
		if err != nil {
			return Block{}, "", err
		}
		if member == nil || strings.TrimSpace(member.ID) != userID {
			return Block{}, "", validationError(CodeMessageInvalidMention, MessageInvalidMention)
		}
		return Block{Type: "mention", UserID: userID, Label: displayName(*member)}, "", nil
	case "link":
		link := normalizeString(block.URL)
		if !allowedLink(link) {
			return Block{}, "", validationError(CodeMessageInvalidLink, MessageInvalidLink)
		}
		label := normalizeString(block.Label)
		candidate := Block{Type: "link", URL: link}
		if label != "" {
			candidate.Label = label
		}
		return candidate, "", nil
	case "emoji":
		shortcode := normalizeString(block.Shortcode)
		if match := customEmoteShortcodePattern.FindStringSubmatch(shortcode); len(match) == 2 {
			if s.advancedBlockValidator == nil {
				return Block{}, "", validationError(CodeMessageInvalidEmoji, MessageInvalidEmoji)
			}
			candidate, err := s.advancedBlockValidator.ValidateBlock(ctx, actor, conversationID, Block{
				Type: "emoji", Shortcode: "custom:" + strings.ToLower(match[1]),
			})
			if err != nil {
				return Block{}, "", err
			}
			if candidate.Type != "emoji" || customEmoteShortcodePattern.FindStringSubmatch(candidate.Shortcode) == nil {
				return Block{}, "", validationError(CodeMessageInvalidEmoji, MessageInvalidEmoji)
			}
			return candidate, "", nil
		}
		if !validEmojiShortcode(shortcode) {
			return Block{}, "", validationError(CodeMessageInvalidEmoji, MessageInvalidEmoji)
		}
		return Block{Type: "emoji", Shortcode: shortcode}, "", nil
	case "attachment":
		attachmentID := normalizeString(block.AttachmentID)
		attachment, err := repo.FindAttachment(ctx, s.space(), attachmentID)
		if err != nil {
			return Block{}, "", err
		}
		if err := s.validateAttachment(ctx, repo, actor, conversationID, attachment); err != nil {
			return Block{}, "", err
		}
		return Block{Type: "attachment", AttachmentID: attachmentID}, attachmentID, nil
	default:
		if block.Type == "card" && transactionalValidator != nil {
			transaction, ok := repo.(Tx)
			if !ok {
				return Block{}, "", internalError("validate message card reference", errors.New("transactional message repository is required"))
			}
			normalized, err := transactionalValidator.ValidateBlockInTx(ctx, transaction, actor, conversationID, block)
			if err != nil {
				return Block{}, "", err
			}
			if strings.TrimSpace(normalized.Type) == "" {
				return Block{}, "", validationError(CodeMessageInvalidBlock, MessageInvalidBlock)
			}
			return normalized, "", nil
		}
		if s.advancedBlockValidator == nil {
			return Block{}, "", validationError(CodeMessageInvalidBlock, MessageInvalidBlock)
		}
		normalized, err := s.advancedBlockValidator.ValidateBlock(ctx, actor, conversationID, block)
		if err != nil {
			return Block{}, "", err
		}
		if strings.TrimSpace(normalized.Type) == "" {
			return Block{}, "", validationError(CodeMessageInvalidBlock, MessageInvalidBlock)
		}
		return normalized, "", nil
	}
}

func extractCustomEmoteIDs(content Content) []string {
	values := make([]string, 0)
	seen := make(map[string]struct{})
	for _, block := range content.Blocks {
		if block.Type != "emoji" {
			continue
		}
		match := customEmoteShortcodePattern.FindStringSubmatch(block.Shortcode)
		if len(match) != 2 {
			continue
		}
		value := strings.ToLower(match[1])
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

func extractEmoteCollectionShareIDs(content Content) []string {
	values := make([]string, 0)
	seen := make(map[string]struct{})
	for _, block := range content.Blocks {
		if block.Type != "emote_collection" {
			continue
		}
		value := strings.ToLower(normalizeString(block.ShareID))
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

func (s *Service) validateAttachment(ctx context.Context, repo ReadRepository, actor *auth.Actor, conversationID string, attachment *AttachmentRecord) error {
	if attachment == nil || attachment.ID == "" || (attachment.SpaceID != "" && attachment.SpaceID != s.space()) || attachment.Status != "available" {
		return validationError(CodeMessageInvalidAttach, MessageInvalidAttachment)
	}
	if attachment.Visibility == "private_staging" {
		return validationError(CodeMessageInvalidAttach, MessageInvalidAttachment)
	}
	if attachment.Visibility == "conversation" && attachment.ConversationID != nil && strings.TrimSpace(*attachment.ConversationID) != conversationID {
		return validationError(CodeMessageInvalidAttach, MessageInvalidAttachment)
	}
	if attachment.Visibility == "space" || attachment.UploaderID == actor.ID {
		return nil
	}
	if attachment.Visibility != "conversation" || attachment.ConversationID == nil || strings.TrimSpace(*attachment.ConversationID) == "" {
		return permissionDeniedError()
	}
	active, err := repo.ConversationMemberActive(ctx, s.space(), strings.TrimSpace(*attachment.ConversationID), actor.ID)
	if err != nil {
		return err
	}
	if !active {
		return permissionDeniedError()
	}
	return nil
}

func messageKind(actor *auth.Actor) string {
	if actor != nil && actor.Kind == "bot" {
		return "bot"
	}
	return "user"
}

func normalizedOptionalID(value string) *string {
	value = normalizeString(value)
	if value == "" {
		return nil
	}
	return &value
}

func sameMessageContent(existing MessageRecord, contentJSON []byte) bool {
	stored, err := canonicalStoredContent(existing.ContentJSON, existing.PlainText)
	return err == nil && bytes.Equal(stored, contentJSON)
}

func canonicalStoredContent(raw []byte, fallback string) ([]byte, error) {
	if len(raw) == 0 {
		return nil, errors.New("stored message content is empty")
	}
	var decoded Content
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	canonical := Content{Format: decoded.Format, Blocks: make([]Block, 0, len(decoded.Blocks))}
	if canonical.Format == "" {
		canonical.Format = MessageContentFormat
	}
	for _, block := range decoded.Blocks {
		normalized, ok := projectBlock(block, nil)
		if !ok {
			return nil, errors.New("stored message contains unsupported block")
		}
		canonical.Blocks = append(canonical.Blocks, normalized)
	}
	canonical.PlainText = ProjectPlainText(canonical.Blocks)
	if canonical.PlainText == "" {
		canonical.PlainText = normalizeString(fallback)
	}
	return canonicalContent(canonical)
}

func asMessageError(err error) *Error {
	if err == nil {
		return internalError("message operation", nil)
	}
	if value, ok := domainError(err); ok {
		return value
	}
	return internalError("message operation", err)
}

func auditReason(err *Error) string {
	if err == nil {
		return CodeInternal
	}
	switch err.Code {
	case CodePermissionDenied:
		return "insufficient permission"
	case CodeConversationNotFound:
		return "not a conversation member"
	default:
		return err.Code
	}
}

func (s *Service) writeEvent(ctx context.Context, tx Tx, input EventInput) error {
	_, err := s.writeEventRecord(ctx, tx, input)
	return err
}

func (s *Service) writeEventRecord(ctx context.Context, tx Tx, input EventInput) (EventRecord, error) {
	if strings.TrimSpace(input.ID) == "" {
		id, err := s.newID("workspace event")
		if err != nil {
			return EventRecord{}, internalError("generate workspace event id", err)
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" {
		input.SpaceID = s.space()
	}
	if input.CreatedAt.IsZero() {
		input.CreatedAt = s.nowUTC()
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	return tx.WriteEvent(ctx, input)
}
