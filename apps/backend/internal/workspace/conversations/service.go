package conversations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceMembers "github.com/timestarry/duallane/apps/backend/internal/workspace/members"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

const (
	conversationReadCapability   = "conversation.read"
	conversationDirectCapability = "conversation.create_direct"
	conversationGroupCapability  = "conversation.create_group"
	conversationMemberCapability = "conversation.member.manage"
	messageCreateCapability      = "message.create"
	fileUploadCapability         = "file.upload"
	memberRoleUpdateCapability   = "member.role_update"
	conversationTargetType       = "conversation"
	messageTargetType            = "message"
	userTargetType               = "user"
)

// CreateConversationInput contains the transport-independent fields accepted
// by the create operation. AvatarEmojiSet distinguishes omitted from explicit
// null on update-capable callers; create treats both as the default avatar.
type CreateConversationInput struct {
	ActorID        string
	Type           string
	TargetUserID   string
	Title          string
	MemberIDs      []string
	AvatarEmoji    *string
	AvatarEmojiSet bool
	Meta           auth.RequestMeta
}

type ConversationMemberInput struct {
	ActorID        string
	ConversationID string
	UserID         string
	Meta           auth.RequestMeta
}

type UpdateGroupInput struct {
	ActorID        string
	ConversationID string
	Title          *string
	AvatarEmoji    *string
	AvatarEmojiSet bool
	TitleSet       bool
	Meta           auth.RequestMeta
}

type ConversationInput struct {
	ActorID        string
	ConversationID string
	Meta           auth.RequestMeta
}

type NotificationInput struct {
	ActorID           string
	ConversationID    string
	Level             string
	NotificationLevel string
	Meta              auth.RequestMeta
}

type PinInput struct {
	ActorID        string
	ConversationID string
	MessageID      string
	Meta           auth.RequestMeta
}

type Clock func() time.Time
type IDFactory func() (string, error)

type ServiceOptions struct {
	Repository         Repository
	SpaceID            string
	Now                Clock
	IDFactory          IDFactory
	MessageShareReader workspaceMessages.MessageShareReader
}

type Service struct {
	repo               Repository
	spaceID            string
	now                Clock
	idFactory          IDFactory
	messageShareReader workspaceMessages.MessageShareReader
}

var defaultConversationIDFactory = func() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
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
		idFactory = defaultConversationIDFactory
	}
	return &Service{
		repo:               options.Repository,
		spaceID:            spaceID,
		now:                now,
		idFactory:          idFactory,
		messageShareReader: options.MessageShareReader,
	}
}

// NewServiceForRepository is a compact constructor for composition tests and
// small command wiring while NewService remains options-based like auth.
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

func (s *Service) newID() (string, error) {
	if s == nil || s.idFactory == nil {
		return "", errors.New("conversation id factory is required")
	}
	id, err := s.idFactory()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(id) == "" {
		return "", errors.New("conversation id factory returned an empty id")
	}
	return strings.TrimSpace(id), nil
}

type rejection struct {
	err   *Error
	audit AuditInput
}

// inTransaction centralizes actor re-resolution and rejection auditing. A
// callback returns a rejection with nil error after writing its audit so the
// transaction commits the evidence; all other errors roll it back.
func (s *Service) inTransaction(ctx context.Context, actorID string, meta auth.RequestMeta, fn func(Tx, *auth.Actor, time.Time) (any, *rejection, error)) (any, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace conversation service", errors.New("repository is required"))
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
		if rejected == nil {
			return nil
		}
		rejected.audit = s.auditFor(actor, meta, rejected.audit, now)
		if err := tx.WriteAudit(ctx, rejected.audit); err != nil {
			return internalError("write conversation rejection audit", err)
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
	actor, err := repo.LookupActor(ctx, s.space(), actorID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if actor == nil || strings.TrimSpace(actor.ID) == "" || actor.ID != actorID {
		return nil, authRequiredError()
	}
	if actor.Kind != "" && actor.Kind != "human" {
		return nil, identityForbiddenError()
	}
	if strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	return actor, nil
}

func normalizeRepositoryError(err error) error {
	if err == nil {
		return nil
	}
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return internalError("workspace conversation repository", err)
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
	if input.CreatedAt.IsZero() {
		input.CreatedAt = now
	}
	if input.Result == "" {
		input.Result = "rejected"
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
			Reason:     reason,
		},
	}
}

func (s *Service) requireCapability(actor *auth.Actor, capability, targetType, targetID string) *Error {
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
		case conversationReadCapability, conversationDirectCapability, conversationGroupCapability,
			conversationMemberCapability, memberRoleUpdateCapability, "member.remove",
			messageCreateCapability, fileUploadCapability, "file.download":
			return true
		}
	case "member":
		switch capability {
		case conversationReadCapability, conversationDirectCapability, messageCreateCapability, fileUploadCapability, "file.download":
			return true
		}
	}
	return false
}

func roleLabel(role string) string {
	switch role {
	case "owner":
		return "空间主人"
	case "admin":
		return "管理员"
	case "auditor":
		return "预留角色"
	default:
		return "成员"
	}
}

func projectedRole(member MemberRecord, actor *auth.Actor) string {
	role := member.Role
	if role == "owner" && (actor == nil || actor.Role != "owner") {
		return "admin"
	}
	if role == "auditor" && (actor == nil || (actor.ID != member.ID && actor.Role != "owner")) {
		return "member"
	}
	if role == "" {
		return "member"
	}
	return role
}

func canStartDirect(member MemberRecord) bool {
	if _, _, _, system := systemIdentity(member); system {
		return true
	}
	return member.Kind != "system" && member.Role != "auditor" && member.ID != ""
}

func canJoinGroup(member MemberRecord) bool {
	return member.Kind == "human" && member.Role != "auditor" && member.ID != ""
}

func canManageMembers(actor *auth.Actor) bool {
	return actor != nil && hasCapability(actor.Role, memberRoleUpdateCapability)
}

func projectMember(record MemberRecord, actor *auth.Actor) Member {
	displayName := ""
	if actor == nil || actor.ID != record.ID {
		displayName = strings.TrimSpace(memberRemarkValue(record))
	}
	if identityName, identityDescription, identityAvatar, ok := systemIdentity(record); ok {
		displayName = identityName
		record.Description = identityDescription
		record.AvatarURL = identityAvatar
		record.Kind = "bot"
	}
	if displayName == "" {
		displayName = strings.TrimSpace(memberNicknameValue(record))
	}
	if displayName == "" {
		displayName = strings.TrimSpace(record.GitHubLogin)
	}
	if displayName == "" {
		if record.Kind == "bot" {
			displayName = "Bot"
		} else {
			displayName = "成员"
		}
	}
	if record.Kind != "human" && strings.TrimSpace(record.DisplayName) != "" && !isSystemIdentity(record) {
		displayName = strings.TrimSpace(record.DisplayName)
	}
	member := Member{
		ID:          record.ID,
		DisplayName: displayName,
		Kind:        record.Kind,
		Role:        projectedRole(record, actor),
		RoleLabel:   roleLabel(projectedRole(record, actor)),
		JoinedAt:    formatTime(record.JoinedAt),
		Capabilities: MemberCapabilities{
			CanJoinGroups: canJoinGroup(record),
			CanManage:     canManageMembers(actor) && isMemberManagedIdentity(record),
		},
	}
	if record.Kind == "human" {
		member.GitHubLogin = record.GitHubLogin
		member.Nickname = nullableNonEmptyString(record.Nickname)
		if actor != nil && actor.ID != record.ID {
			member.Remark = nullableString(record.Remark)
			if member.Remark != nil && *member.Remark != "" {
				member.DisplayName = *member.Remark
			}
		}
		member.AvatarURL = sanitizeAvatarURL(record.AvatarURL)
		if actor != nil && actor.ID == record.ID {
			visible := record.SearchDiscoverable
			member.SearchDiscoverable = &visible
			if record.RecallReason != nil && strings.TrimSpace(*record.RecallReason) != "" {
				member.RecallReason = *record.RecallReason
			} else {
				member.RecallReason = "内容有误"
			}
		}
		member.Capabilities.CanStartDirectConversation = actor != nil && actor.ID != record.ID && canStartDirect(record) && hasCapability(actor.Role, conversationDirectCapability)
	} else {
		member.AvatarURL = sanitizeAvatarURL(record.AvatarURL)
		member.Description = record.Description
		member.Capabilities.CanStartDirectConversation = actor != nil && actor.ID != record.ID && canStartDirect(record) && hasCapability(actor.Role, conversationDirectCapability)
	}
	return member
}

func systemIdentity(record MemberRecord) (displayName, description, avatarURL string, ok bool) {
	switch record.ID {
	case workspaceMembers.BeaconUserID:
		return "信标", "文件传输助手", "/assets/beacon-avatar.png", true
	case workspaceMembers.EchoUserID:
		return "回声", "需求与反馈助手", "/assets/echo-avatar.svg", true
	default:
		return "", "", "", false
	}
}

func isMemberManagedIdentity(record MemberRecord) bool {
	return !isSystemIdentity(record)
}

func isSystemIdentity(record MemberRecord) bool {
	_, _, _, ok := systemIdentity(record)
	return ok
}

func memberNicknameValue(record MemberRecord) string {
	if record.Nickname == nil {
		return ""
	}
	return *record.Nickname
}

func memberRemarkValue(record MemberRecord) string {
	if record.Remark == nil {
		return ""
	}
	return *record.Remark
}

func nullableString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func nullableNonEmptyString(value *string) *string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	copy := *value
	return &copy
}

func sanitizeAvatarURL(value string) string {
	candidate := strings.TrimSpace(value)
	if candidate == "" {
		return ""
	}
	if strings.HasPrefix(candidate, "/assets/") && !strings.Contains(candidate, "..") {
		return candidate
	}
	if strings.HasPrefix(candidate, "/api/workspace/avatars/") && !strings.Contains(candidate, "..") {
		return candidate
	}
	if strings.HasPrefix(candidate, "https://avatars.githubusercontent.com/") {
		return candidate
	}
	return ""
}

func projectMessage(record MessageRecord, actor *auth.Actor) (Message, error) {
	canonical := workspaceMessages.MessageRecord{
		ID:                    record.ID,
		ConversationID:        record.ConversationID,
		AuthorID:              nullableString(record.AuthorID),
		AuthorName:            record.AuthorName,
		AuthorNickname:        record.AuthorNickname,
		AuthorRemark:          record.AuthorRemark,
		AuthorGitHubLogin:     record.AuthorGitHubLogin,
		AuthorAvatarURL:       record.AuthorAvatarURL,
		AuthorKind:            record.AuthorKind,
		Kind:                  record.Kind,
		ClientMessageID:       nullableString(record.ClientMessageID),
		ContentJSON:           record.ContentJSON,
		PlainText:             record.PlainText,
		ReplyToMessageID:      nullableString(record.ReplyToMessageID),
		CreatedAt:             record.CreatedAt,
		EditedAt:              record.EditedAt,
		DeletedAt:             record.DeletedAt,
		RecalledAt:            record.RecalledAt,
		RecallReason:          nullableString(record.RecallReason),
		HiddenByCurrentUser:   record.HiddenByCurrentUser,
		EmoteCollectionShares: record.EmoteCollectionShares,
	}
	if record.AuthorID != nil {
		if identityName, _, identityAvatar, ok := systemIdentity(MemberRecord{ID: *record.AuthorID}); ok {
			canonical.AuthorName = identityName
			canonical.AuthorAvatarURL = identityAvatar
			canonical.AuthorKind = "bot"
			canonical.AuthorNickname = ""
			canonical.AuthorRemark = ""
			canonical.AuthorGitHubLogin = ""
		}
	}
	projected, err := workspaceMessages.ProjectMessageForViewer(canonical, record.Attachments, record.Reactions, actor)
	if err != nil {
		return Message{}, internalError("project workspace message", err)
	}
	projected.AuthorAvatarURL = sanitizeAvatarURL(projected.AuthorAvatarURL)
	message := Message{Message: projected}
	if record.Pin != nil && (record.RecalledAt == nil || record.RecalledAt.IsZero()) {
		message.Pin = &MessagePin{
			PinnedByUserID: record.Pin.PinnedByUserID,
			PinnedAt:       formatTime(record.Pin.CreatedAt),
			CanUnpin:       actorCanUnpin(actor, record.AuthorID),
		}
	}
	return message, nil
}

func projectPinnedMessage(record MessageRecord, pin *PinRecord, actor *auth.Actor) (Message, error) {
	if pin != nil {
		record.Pin = &PinRecord{
			MessageID:      pin.MessageID,
			PinnedByUserID: pin.PinnedByUserID,
			CreatedAt:      pin.CreatedAt,
		}
	}
	return projectMessage(record, actor)
}

func actorCanUnpin(actor *auth.Actor, authorID *string) bool {
	if actor == nil {
		return false
	}
	return actor.Role == "owner" || actor.Role == "admin" || (authorID != nil && actor.ID == *authorID)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func formatTimePtr(value *time.Time) *string {
	if value == nil || value.IsZero() {
		return nil
	}
	formatted := formatTime(*value)
	return &formatted
}

func (s *Service) projectConversation(ctx context.Context, repo ReadRepository, actor *auth.Actor, record ConversationRecord) (Conversation, error) {
	if actor == nil {
		return Conversation{}, authRequiredError()
	}
	members, err := repo.ListConversationMembers(ctx, s.space(), record.ID, actor.ID)
	if err != nil {
		return Conversation{}, normalizeRepositoryError(err)
	}
	latest, err := repo.ListLatestMessages(ctx, s.space(), record.ID, actor.ID, 20)
	if err != nil {
		return Conversation{}, normalizeRepositoryError(err)
	}
	if err := s.hydrateMessageRecords(ctx, repo, actor.ID, latest); err != nil {
		return Conversation{}, err
	}
	projectedMembers := make([]Member, 0, len(members))
	for _, member := range members {
		projectedMembers = append(projectedMembers, projectMember(member, actor))
	}
	projectedMessages := make([]Message, 0, len(latest))
	for _, message := range latest {
		projected, err := projectMessage(message, actor)
		if err != nil {
			return Conversation{}, err
		}
		projectedMessages = append(projectedMessages, projected)
	}
	var otherMember *Member
	for index := range projectedMembers {
		if projectedMembers[index].ID != actor.ID {
			candidate := projectedMembers[index]
			otherMember = &candidate
			break
		}
	}
	displayTitle := record.Title
	if record.Type == string(ConversationTypeDirect) && otherMember != nil {
		displayTitle = otherMember.DisplayName
	}
	conversation := Conversation{
		ID:                record.ID,
		SpaceID:           record.SpaceID,
		Type:              record.Type,
		Title:             record.Title,
		AvatarEmoji:       nil,
		DisplayTitle:      displayTitle,
		OtherMember:       otherMember,
		RetentionCount:    record.RetentionCount,
		RetentionText:     fmt.Sprintf("保留最近 %d 条消息", record.RetentionCount),
		CreatedAt:         formatTime(record.CreatedAt),
		LastActivityAt:    formatTime(record.LastActivityAt),
		MessageCount:      record.MessageCount,
		MemberCount:       len(projectedMembers),
		UnreadCount:       record.UnreadCount,
		LastReadMessageID: nullableString(record.LastReadMessageID),
		LastReadAt:        formatTimePtr(record.LastReadAt),
		LastReadSeq:       int64Ptr(record.LastReadSeq),
		NotificationLevel: firstNonEmpty(record.NotificationLevel, string(NotificationAll)),
		Capabilities: ConversationCapabilities{
			CanSendMessage:   hasCapability(actor.Role, messageCreateCapability),
			CanUploadFile:    hasCapability(actor.Role, fileUploadCapability),
			CanManageMembers: record.Type == string(ConversationTypeGroup) && hasCapability(actor.Role, conversationMemberCapability),
		},
		Members:        projectedMembers,
		LatestMessages: projectedMessages,
	}
	if record.Type == string(ConversationTypeGroup) {
		conversation.AvatarEmoji = nullableString(record.AvatarEmoji)
	}
	for index := len(projectedMessages) - 1; index >= 0; index-- {
		message := projectedMessages[index]
		if !message.HiddenByCurrentUser {
			conversation.LastMessagePlainText = message.PlainText
			createdAt := message.CreatedAt
			conversation.LastMessageAt = &createdAt
			break
		}
	}
	return conversation, nil
}

// hydrateMessageRecords loads every viewer-bound relation required by the
// canonical message projection. Conversation and pin reads must not project a
// message from only its base row: doing so lets a later response replace a
// realtime/message-read DTO with empty attachment, reaction, or hidden-state
// data.
func (s *Service) hydrateMessageRecords(ctx context.Context, repo ReadRepository, viewerID string, records []MessageRecord) error {
	if s == nil || repo == nil || len(records) == 0 {
		return nil
	}
	ids := make([]string, 0, len(records))
	for _, record := range records {
		if strings.TrimSpace(record.ID) != "" {
			ids = append(ids, record.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	attachments, err := repo.ListMessageAttachments(ctx, s.space(), viewerID, ids)
	if err != nil {
		return normalizeRepositoryError(err)
	}
	reactions, err := repo.ListMessageReactions(ctx, s.space(), viewerID, ids)
	if err != nil {
		return normalizeRepositoryError(err)
	}
	hidden, err := repo.ListMessageHidden(ctx, s.space(), viewerID, ids)
	if err != nil {
		return normalizeRepositoryError(err)
	}
	for index := range records {
		messageID := records[index].ID
		records[index].Attachments = attachments[messageID]
		records[index].Reactions = reactions[messageID]
		records[index].HiddenByCurrentUser = hidden[messageID]
	}
	return s.hydrateMessageShares(ctx, viewerID, records)
}

func (s *Service) hydrateMessageShares(ctx context.Context, viewerID string, records []MessageRecord) error {
	if s == nil || s.messageShareReader == nil || len(records) == 0 {
		return nil
	}
	ids := make([]string, 0, len(records))
	for _, record := range records {
		if strings.TrimSpace(record.ID) != "" {
			ids = append(ids, record.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	shares, err := s.messageShareReader.ListMessageEmoteCollectionShares(ctx, s.space(), viewerID, ids)
	if err != nil {
		return internalError("project conversation message shares", err)
	}
	for index := range records {
		records[index].EmoteCollectionShares = shares[records[index].ID]
	}
	return nil
}

func (s *Service) readActor(ctx context.Context, actorID string) (*auth.Actor, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace conversation service", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	return s.lookupActor(ctx, s.repo, actorID)
}

func (s *Service) recordReadRejection(ctx context.Context, actorID string, meta auth.RequestMeta, action, targetType, targetID, reason string, result *Error) error {
	_, err := s.inTransaction(ctx, actorID, meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		return nil, rejectedError(result, action, targetType, targetID, reason), nil
	})
	if err != nil {
		return err
	}
	return result
}

func int64Ptr(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func (s *Service) ListConversations(ctx context.Context, actorID string, meta auth.RequestMeta) ([]Conversation, error) {
	actor, err := s.readActor(ctx, actorID)
	if err != nil {
		return nil, err
	}
	if denied := s.requireCapability(actor, conversationReadCapability, "workspace", ""); denied != nil {
		return nil, s.recordReadRejection(ctx, actor.ID, meta, conversationReadCapability, "workspace", "", "insufficient permission", denied)
	}
	records, err := s.repo.ListConversationRecords(ctx, s.space(), actor.ID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	conversations := make([]Conversation, 0, len(records))
	for _, record := range records {
		conversation, err := s.projectConversation(ctx, s.repo, actor, record)
		if err != nil {
			return nil, err
		}
		conversations = append(conversations, conversation)
	}
	return conversations, nil
}

func (s *Service) GetConversation(ctx context.Context, input ConversationInput) (Conversation, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return Conversation{}, err
	}
	conversationID := strings.TrimSpace(input.ConversationID)
	if denied := s.requireCapability(actor, conversationReadCapability, conversationTargetType, conversationID); denied != nil {
		return Conversation{}, s.recordReadRejection(ctx, actor.ID, input.Meta, conversationReadCapability, conversationTargetType, conversationID, "insufficient permission", denied)
	}
	if conversationID == "" {
		return Conversation{}, NewError(CodeConversationRequired, MessageConversationRequired, 400)
	}
	record, err := s.repo.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
	if err != nil {
		return Conversation{}, normalizeRepositoryError(err)
	}
	if record == nil {
		notFound := conversationNotFoundError()
		return Conversation{}, s.recordReadRejection(ctx, actor.ID, input.Meta, conversationReadCapability, conversationTargetType, conversationID, "not a conversation member", notFound)
	}
	return s.projectConversation(ctx, s.repo, actor, *record)
}

func (s *Service) CreateConversation(ctx context.Context, input CreateConversationInput) (Conversation, error) {
	value, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		typeName := strings.TrimSpace(input.Type)
		if typeName != string(ConversationTypeDirect) && typeName != string(ConversationTypeGroup) {
			err := NewError(CodeConversationInvalidType, MessageConversationInvalidType, 400)
			return nil, rejectedError(err, "conversation.create", conversationTargetType, "new", "invalid type"), nil
		}
		capability := conversationDirectCapability
		if typeName == string(ConversationTypeGroup) {
			capability = conversationGroupCapability
		}
		if denied := s.requireCapability(actor, capability, conversationTargetType, "new"); denied != nil {
			return nil, rejectedError(denied, capability, conversationTargetType, "new", "insufficient permission"), nil
		}
		if typeName == string(ConversationTypeDirect) {
			return s.createDirect(ctx, tx, actor, input, now)
		}
		return s.createGroup(ctx, tx, actor, input, now)
	})
	if err != nil {
		return Conversation{}, err
	}
	return value.(Conversation), nil
}

func (s *Service) createDirect(ctx context.Context, tx Tx, actor *auth.Actor, input CreateConversationInput, now time.Time) (any, *rejection, error) {
	targetID := strings.TrimSpace(input.TargetUserID)
	if targetID == "" || targetID == actor.ID {
		err := NewError(CodeConversationInvalidTarget, MessageConversationInvalidTarget, 400)
		return nil, rejectedError(err, "conversation.create", conversationTargetType, "new", "invalid target"), nil
	}
	if err := tx.Lock(ctx, "workspace-members:"+s.space()); err != nil {
		return nil, nil, err
	}
	var err error
	actor, err = s.lookupActor(ctx, tx, actor.ID)
	if err != nil {
		return nil, nil, err
	}
	if denied := s.requireCapability(actor, conversationDirectCapability, conversationTargetType, "new"); denied != nil {
		return nil, rejectedError(denied, conversationDirectCapability, conversationTargetType, "new", "insufficient permission"), nil
	}
	target, err := tx.FindMember(ctx, s.space(), targetID)
	if err != nil {
		return nil, nil, err
	}
	if target == nil {
		err := NewError(CodeConversationInvalidTarget, MessageConversationInvalidTarget, 400)
		return nil, rejectedError(err, "conversation.create", conversationTargetType, "new", "invalid target"), nil
	}
	if !canStartDirect(*target) {
		err := NewError(CodeConversationInvalidTarget, MessageConversationInvalidTarget, 400)
		return nil, rejectedError(err, "conversation.create", conversationTargetType, "new", "invalid target"), nil
	}
	visible, err := tx.MemberVisible(ctx, s.space(), actor.ID, targetID)
	if err != nil {
		return nil, nil, err
	}
	if !visible {
		visible, err = tx.SharesActiveGroup(ctx, s.space(), actor.ID, targetID)
		if err != nil {
			return nil, nil, err
		}
	}
	if !visible && !target.SearchDiscoverable {
		err := NewError(CodeConversationInvalidTarget, MessageConversationTargetMissing, 400)
		return nil, rejectedError(err, "conversation.create", conversationTargetType, "new", "target not visible"), nil
	}
	key := directKey(actor.ID, targetID)
	if err := tx.Lock(ctx, "conversation:direct:"+key); err != nil {
		return nil, nil, err
	}
	existing, err := tx.FindDirectConversation(ctx, s.space(), key)
	if err != nil {
		return nil, nil, err
	}
	if existing != nil {
		visibleExisting, err := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, existing.ID)
		if err != nil {
			return nil, nil, err
		}
		if visibleExisting == nil {
			err := conversationNotFoundError()
			return nil, rejectedError(err, "conversation.create", conversationTargetType, existing.ID, "not a conversation member"), nil
		}
		conversation, err := s.projectConversation(ctx, tx, actor, *visibleExisting)
		return conversation, nil, err
	}
	id, err := s.newID()
	if err != nil {
		return nil, nil, internalError("generate direct conversation id", err)
	}
	title := firstNonEmpty(actor.DisplayName, actor.GitHubLogin, "成员") + ", " + firstNonEmpty(target.DisplayName, target.GitHubLogin, "成员")
	if err := tx.CreateConversation(ctx, CreateConversationRecord{
		ID: id, SpaceID: s.space(), Type: string(ConversationTypeDirect), Title: title,
		DirectKey: stringPtr(key), RetentionCount: DefaultRetentionCount, CreatedBy: actor.ID, CreatedAt: now,
	}); err != nil {
		return nil, nil, err
	}
	memberIDs := []string{actor.ID, target.ID}
	sort.Strings(memberIDs)
	for _, memberID := range memberIDs {
		if _, err := tx.UpsertConversationMember(ctx, s.space(), id, memberID, now); err != nil {
			return nil, nil, err
		}
	}
	if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "conversation.created", ActorID: actor.ID, ConversationID: id, TargetType: conversationTargetType, TargetID: id, PayloadJSON: mustJSON(map[string]any{"conversationId": id, "type": "direct", "memberIds": memberIDs}), CreatedAt: now}); err != nil {
		return nil, nil, err
	}
	if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{Action: "conversation.create", TargetType: conversationTargetType, TargetID: id, Result: "success"}, now)); err != nil {
		return nil, nil, err
	}
	record, err := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, id)
	if err != nil {
		return nil, nil, err
	}
	if record == nil {
		return nil, nil, internalError("project created direct conversation", errors.New("conversation is not visible after insert"))
	}
	conversation, err := s.projectConversation(ctx, tx, actor, *record)
	return conversation, nil, err
}

func (s *Service) createGroup(ctx context.Context, tx Tx, actor *auth.Actor, input CreateConversationInput, now time.Time) (any, *rejection, error) {
	title := strings.TrimSpace(input.Title)
	if title == "" {
		err := NewError(CodeConversationInvalidTitle, MessageConversationInvalidTitle, 400)
		return nil, rejectedError(err, "conversation.create", conversationTargetType, "new", "invalid title"), nil
	}
	if utf8.RuneCountInString(title) > MaxConversationTitleLen {
		err := NewError(CodeConversationInvalidTitle, MessageConversationTitleTooLong, 400)
		return nil, rejectedError(err, "conversation.create", conversationTargetType, "new", "invalid title"), nil
	}
	avatar, avatarErr := normalizeAvatarEmoji(input.AvatarEmoji)
	if avatarErr != nil {
		return nil, rejectedError(avatarErr, "conversation.create", conversationTargetType, "new", "invalid avatar"), nil
	}
	selected := uniqueIDs(input.MemberIDs)
	filtered := make([]string, 0, len(selected))
	for _, id := range selected {
		if id != actor.ID {
			filtered = append(filtered, id)
		}
	}
	if len(filtered) == 0 {
		err := NewError(CodeConversationInvalidMembers, MessageConversationInvalidMembers, 400)
		return nil, rejectedError(err, "conversation.create", conversationTargetType, "new", "invalid members"), nil
	}
	memberIDs := append([]string{actor.ID}, filtered...)
	memberIDs = uniqueIDs(memberIDs)
	sort.Strings(memberIDs)
	if err := tx.Lock(ctx, "workspace-members:"+s.space()); err != nil {
		return nil, nil, err
	}
	actor, err := s.lookupActor(ctx, tx, actor.ID)
	if err != nil {
		return nil, nil, err
	}
	if denied := s.requireCapability(actor, conversationGroupCapability, conversationTargetType, "new"); denied != nil {
		return nil, rejectedError(denied, conversationGroupCapability, conversationTargetType, "new", "insufficient permission"), nil
	}
	membersByID := make(map[string]MemberRecord, len(memberIDs))
	for _, memberID := range memberIDs {
		member, err := tx.FindMember(ctx, s.space(), memberID)
		if err != nil {
			return nil, nil, err
		}
		if member == nil {
			domainErr := NewError(CodeMemberNotFound, MessageMemberNotFound, 400)
			return nil, rejectedError(domainErr, "conversation.create", conversationTargetType, "new", CodeMemberNotFound), nil
		}
		membersByID[memberID] = *member
		if memberID != actor.ID && !canJoinGroup(*member) {
			domainErr := NewError(CodeMemberNotChatParticipant, MessageMemberNotChatParticipant, 400)
			return nil, rejectedError(domainErr, "conversation.create", conversationTargetType, "new", CodeMemberNotChatParticipant), nil
		}
		if memberID != actor.ID {
			visible, err := tx.MemberVisible(ctx, s.space(), actor.ID, memberID)
			if err != nil {
				return nil, nil, err
			}
			if !visible {
				domainErr := NewError(CodeMemberNotVisible, "部分成员当前不可见", 403)
				return nil, rejectedError(domainErr, "conversation.create", conversationTargetType, "new", CodeMemberNotVisible), nil
			}
		}
	}
	if err := tx.Lock(ctx, "conversation:create:"+actor.ID); err != nil {
		return nil, nil, err
	}
	id, factoryErr := s.newID()
	if factoryErr != nil {
		return nil, nil, internalError("generate group conversation id", factoryErr)
	}
	if err := tx.CreateConversation(ctx, CreateConversationRecord{ID: id, SpaceID: s.space(), Type: string(ConversationTypeGroup), Title: title, AvatarEmoji: avatar, RetentionCount: DefaultRetentionCount, CreatedBy: actor.ID, CreatedAt: now}); err != nil {
		return nil, nil, err
	}
	for _, memberID := range memberIDs {
		if _, err := tx.UpsertConversationMember(ctx, s.space(), id, memberID, now); err != nil {
			return nil, nil, err
		}
	}
	record, lookupErr := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, id)
	if lookupErr != nil {
		return nil, nil, lookupErr
	}
	if record == nil {
		return nil, nil, internalError("project created group conversation", errors.New("conversation is not visible after insert"))
	}
	conversation, projectErr := s.projectConversation(ctx, tx, actor, *record)
	if projectErr != nil {
		return nil, nil, projectErr
	}
	if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "conversation.created", ActorID: actor.ID, ConversationID: id, TargetType: conversationTargetType, TargetID: id, PayloadJSON: mustJSON(map[string]any{"conversationId": id, "type": "group", "title": title, "avatarEmoji": valueOrNil(avatar)}), CreatedAt: now}); err != nil {
		return nil, nil, err
	}
	for _, memberID := range memberIDs {
		if memberID == actor.ID {
			continue
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "conversation.member_added", ActorID: actor.ID, ConversationID: id, TargetType: userTargetType, TargetID: memberID, PayloadJSON: mustJSON(map[string]any{"conversationId": id, "userId": memberID, "member": projectMember(membersByID[memberID], nil)}), CreatedAt: now}); err != nil {
			return nil, nil, err
		}
	}
	if err := s.createSystemMessage(ctx, tx, actor, id, DefaultRetentionCount, fmt.Sprintf("%s 创建了群聊「%s」", firstNonEmpty(actor.DisplayName, actor.GitHubLogin, "成员"), title), now); err != nil {
		return nil, nil, err
	}
	if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{Action: "conversation.create", TargetType: conversationTargetType, TargetID: id, Result: "success"}, now)); err != nil {
		return nil, nil, err
	}
	return conversation, nil, nil
}

func directKey(left, right string) string {
	ids := []string{strings.TrimSpace(left), strings.TrimSpace(right)}
	sort.Strings(ids)
	return ids[0] + ":" + ids[1]
}

func stringPtr(value string) *string { return &value }

func valueOrNil(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func uniqueIDs(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		id := strings.TrimSpace(value)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte(`{}`)
	}
	return encoded
}

func (s *Service) writeEvent(ctx context.Context, tx Tx, input EventInput) error {
	if input.ID == "" {
		id, err := s.newID()
		if err != nil {
			return internalError("generate workspace event id", err)
		}
		input.ID = id
	}
	if input.CreatedAt.IsZero() {
		input.CreatedAt = s.nowUTC()
	}
	if input.SpaceID == "" {
		input.SpaceID = s.space()
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	return tx.WriteEvent(ctx, input)
}

func (s *Service) createSystemMessage(ctx context.Context, tx Tx, actor *auth.Actor, conversationID string, retentionCount int64, plainText string, now time.Time) error {
	text := strings.TrimSpace(plainText)
	if text == "" {
		return nil
	}
	messageID, err := s.newID()
	if err != nil {
		return internalError("generate conversation system message id", err)
	}
	contentJSON, err := json.Marshal(workspaceMessages.Content{
		Format:    workspaceMessages.MessageContentFormat,
		PlainText: text,
		Blocks:    []workspaceMessages.Block{{Type: "text", Text: text}},
	})
	if err != nil {
		return internalError("encode conversation system message", err)
	}
	record, err := tx.CreateSystemMessage(ctx, SystemMessageInsert{
		ID:             messageID,
		SpaceID:        s.space(),
		ConversationID: conversationID,
		ContentJSON:    contentJSON,
		PlainText:      text,
		CreatedAt:      now,
	}, retentionCount)
	if err != nil {
		return err
	}
	message, err := projectMessage(*record, actor)
	if err != nil {
		return err
	}
	payloadJSON, err := json.Marshal(map[string]any{
		"messageId":      messageID,
		"conversationId": conversationID,
		"message":        message,
	})
	if err != nil {
		return internalError("encode conversation system message event", err)
	}
	return s.writeEvent(ctx, tx, EventInput{
		SpaceID:        s.space(),
		Type:           "message.created",
		ActorID:        actor.ID,
		ConversationID: conversationID,
		TargetType:     messageTargetType,
		TargetID:       messageID,
		PayloadJSON:    payloadJSON,
		CreatedAt:      now,
	})
}

func normalizeAvatarEmoji(value *string) (*string, *Error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil, nil
	}
	candidate := strings.TrimSpace(*value)
	if !utf8.ValidString(candidate) || utf8.RuneCountInString(candidate) > 16 || !singleEmoji(candidate) {
		return nil, NewError(CodeConversationInvalidAvatar, MessageConversationInvalidAvatar, 400)
	}
	return &candidate, nil
}

func singleEmoji(value string) bool {
	runes := []rune(value)
	if len(runes) == 0 {
		return false
	}
	if len(runes) == 1 {
		return isEmojiBase(runes[0])
	}
	if len(runes) == 2 && isRegional(runes[0]) && isRegional(runes[1]) {
		return true
	}
	if len(runes) >= 2 && (runes[0] == '#' || runes[0] == '*' || (runes[0] >= '0' && runes[0] <= '9')) {
		index := 1
		if index < len(runes) && runes[index] == '\ufe0f' {
			index++
		}
		return index+1 == len(runes) && runes[index] == '\u20e3'
	}
	baseSeen := false
	waitingBase := false
	for _, r := range runes {
		switch {
		case r == '\u200d':
			if !baseSeen || waitingBase {
				return false
			}
			waitingBase = true
		case r == '\ufe0e' || r == '\ufe0f' || (r >= 0x1f3fb && r <= 0x1f3ff) || unicode.Is(unicode.Mn, r):
			if !baseSeen || waitingBase {
				return false
			}
		case isEmojiBase(r):
			if baseSeen && !waitingBase {
				return false
			}
			baseSeen = true
			waitingBase = false
		default:
			return false
		}
	}
	return baseSeen && !waitingBase
}

func isRegional(r rune) bool { return r >= 0x1f1e6 && r <= 0x1f1ff }

func isEmojiBase(r rune) bool {
	return (r >= 0x1f000 && r <= 0x1faff) || (r >= 0x2600 && r <= 0x27ff) || (r >= 0x2300 && r <= 0x23ff)
}

func (s *Service) AddMember(ctx context.Context, input ConversationMemberInput) (Conversation, error) {
	value, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		conversationID := strings.TrimSpace(input.ConversationID)
		if denied := s.requireCapability(actor, conversationMemberCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationMemberCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if conversationID == "" {
			err := NewError(CodeConversationRequired, MessageConversationRequired, 400)
			return nil, rejectedError(err, "conversation.member_add", conversationTargetType, conversationID, CodeConversationRequired), nil
		}
		if err := tx.Lock(ctx, "workspace-members:"+s.space()); err != nil {
			return nil, nil, err
		}
		var err error
		actor, err = s.lookupActor(ctx, tx, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if denied := s.requireCapability(actor, conversationMemberCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationMemberCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if err := tx.Lock(ctx, "conversation:"+conversationID); err != nil {
			return nil, nil, err
		}
		conversation, err := tx.FindConversation(ctx, s.space(), conversationID)
		if err != nil {
			return nil, nil, err
		}
		if conversation == nil {
			err := conversationNotFoundError()
			return nil, rejectedError(err, conversationMemberCapability, conversationTargetType, conversationID, CodeConversationNotFound), nil
		}
		if conversation.Type != string(ConversationTypeGroup) {
			err := NewError(CodeConversationInvalidType, "只有群聊可以管理成员", 400)
			return nil, rejectedError(err, "conversation.member_add", conversationTargetType, conversationID, CodeConversationInvalidType), nil
		}
		userID := strings.TrimSpace(input.UserID)
		member, err := tx.FindMember(ctx, s.space(), userID)
		if err != nil {
			return nil, nil, err
		}
		if member == nil {
			err := NewError(CodeMemberNotFound, MessageMemberNotFound, 400)
			return nil, rejectedError(err, "conversation.member_add", conversationTargetType, conversationID, CodeMemberNotFound), nil
		}
		if !canJoinGroup(*member) {
			err := NewError(CodeMemberNotChatParticipant, MessageMemberNotChatParticipant, 400)
			return nil, rejectedError(err, "conversation.member_add", conversationTargetType, conversationID, CodeMemberNotChatParticipant), nil
		}
		active, err := tx.ConversationMemberActive(ctx, s.space(), conversationID, userID)
		if err != nil {
			return nil, nil, err
		}
		if active {
			record, err := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
			if err != nil {
				return nil, nil, err
			}
			if record == nil {
				return nil, rejectedError(conversationNotFoundError(), conversationReadCapability, conversationTargetType, conversationID, "not a conversation member"), nil
			}
			result, err := s.projectConversation(ctx, tx, actor, *record)
			return result, nil, err
		}
		visible, err := tx.MemberVisible(ctx, s.space(), actor.ID, userID)
		if err != nil {
			return nil, nil, err
		}
		if !visible {
			err := NewError(CodeMemberNotVisible, MessageMemberNotVisible, 403)
			return nil, rejectedError(err, "conversation.member_add", conversationTargetType, conversationID, CodeMemberNotVisible), nil
		}
		if _, err := tx.UpsertConversationMember(ctx, s.space(), conversationID, userID, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "conversation.member_added", ActorID: actor.ID, ConversationID: conversationID, TargetType: userTargetType, TargetID: userID, PayloadJSON: mustJSON(map[string]any{"conversationId": conversationID, "userId": userID, "member": projectMember(*member, nil)}), CreatedAt: now}); err != nil {
			return nil, nil, err
		}
		if err := s.createSystemMessage(ctx, tx, actor, conversationID, conversation.RetentionCount, fmt.Sprintf("%s 邀请 %s 加入群聊", firstNonEmpty(actor.DisplayName, actor.GitHubLogin, "成员"), firstNonEmpty(member.DisplayName, member.GitHubLogin, "成员")), now); err != nil {
			return nil, nil, err
		}
		if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{Action: "conversation.member_add", TargetType: conversationTargetType, TargetID: conversationID, Result: "success"}, now)); err != nil {
			return nil, nil, err
		}
		record, err := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
		if err != nil {
			return nil, nil, err
		}
		if record == nil {
			return nil, nil, internalError("project added member conversation", errors.New("conversation is not visible after insert"))
		}
		result, err := s.projectConversation(ctx, tx, actor, *record)
		return result, nil, err
	})
	if err != nil {
		return Conversation{}, err
	}
	return value.(Conversation), nil
}

func (s *Service) RemoveMember(ctx context.Context, input ConversationMemberInput) (Conversation, error) {
	value, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		conversationID := strings.TrimSpace(input.ConversationID)
		if denied := s.requireCapability(actor, conversationMemberCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationMemberCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if conversationID == "" {
			err := NewError(CodeConversationRequired, MessageConversationRequired, 400)
			return nil, rejectedError(err, "conversation.member_remove", conversationTargetType, conversationID, CodeConversationRequired), nil
		}
		if err := tx.Lock(ctx, "workspace-members:"+s.space()); err != nil {
			return nil, nil, err
		}
		var err error
		actor, err = s.lookupActor(ctx, tx, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if denied := s.requireCapability(actor, conversationMemberCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationMemberCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if err := tx.Lock(ctx, "conversation:"+conversationID); err != nil {
			return nil, nil, err
		}
		conversation, err := tx.FindConversation(ctx, s.space(), conversationID)
		if err != nil {
			return nil, nil, err
		}
		if conversation == nil {
			err := conversationNotFoundError()
			return nil, rejectedError(err, conversationMemberCapability, conversationTargetType, conversationID, CodeConversationNotFound), nil
		}
		if conversation.Type != string(ConversationTypeGroup) {
			err := NewError(CodeConversationInvalidType, "只有群聊可以管理成员", 400)
			return nil, rejectedError(err, "conversation.member_remove", conversationTargetType, conversationID, CodeConversationInvalidType), nil
		}
		userID := strings.TrimSpace(input.UserID)
		if userID == actor.ID {
			err := NewError(CodeConversationMemberInvalid, MessageConversationMemberInvalid, 400)
			return nil, rejectedError(err, "conversation.member_remove", conversationTargetType, conversationID, "self removal"), nil
		}
		member, err := tx.FindMember(ctx, s.space(), userID)
		if err != nil {
			return nil, nil, err
		}
		if member == nil {
			err := NewError(CodeMemberNotFound, MessageMemberNotFound, 400)
			return nil, rejectedError(err, "conversation.member_remove", conversationTargetType, conversationID, CodeMemberNotFound), nil
		}
		active, err := tx.ConversationMemberActive(ctx, s.space(), conversationID, userID)
		if err != nil {
			return nil, nil, err
		}
		if !active {
			err := NewError(CodeConversationMemberNotFound, MessageConversationMemberNotFound, 400)
			return nil, rejectedError(err, "conversation.member_remove", conversationTargetType, conversationID, "member not in conversation"), nil
		}
		removed, err := tx.RemoveConversationMember(ctx, s.space(), conversationID, userID, now)
		if err != nil {
			return nil, nil, err
		}
		if !removed {
			err := NewError(CodeConversationMemberNotFound, MessageConversationMemberNotFound, 400)
			return nil, rejectedError(err, "conversation.member_remove", conversationTargetType, conversationID, "member not in conversation"), nil
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "conversation.member_removed", ActorID: actor.ID, ConversationID: conversationID, TargetType: userTargetType, TargetID: userID, PayloadJSON: mustJSON(map[string]any{"conversationId": conversationID, "userId": userID}), CreatedAt: now}); err != nil {
			return nil, nil, err
		}
		if err := s.createSystemMessage(ctx, tx, actor, conversationID, conversation.RetentionCount, fmt.Sprintf("%s 将 %s 移出群聊", firstNonEmpty(actor.DisplayName, actor.GitHubLogin, "成员"), firstNonEmpty(member.DisplayName, member.GitHubLogin, "成员")), now); err != nil {
			return nil, nil, err
		}
		if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{Action: "conversation.member_remove", TargetType: conversationTargetType, TargetID: conversationID, Result: "success"}, now)); err != nil {
			return nil, nil, err
		}
		record, err := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
		if err != nil {
			return nil, nil, err
		}
		if record == nil {
			return nil, nil, internalError("project removed member conversation", errors.New("conversation is not visible after remove"))
		}
		result, err := s.projectConversation(ctx, tx, actor, *record)
		return result, nil, err
	})
	if err != nil {
		return Conversation{}, err
	}
	return value.(Conversation), nil
}

func (s *Service) UpdateGroup(ctx context.Context, input UpdateGroupInput) (Conversation, error) {
	value, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		conversationID := strings.TrimSpace(input.ConversationID)
		if denied := s.requireCapability(actor, conversationMemberCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationMemberCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if conversationID == "" {
			err := NewError(CodeConversationRequired, MessageConversationRequired, 400)
			return nil, rejectedError(err, "conversation.update", conversationTargetType, conversationID, CodeConversationRequired), nil
		}
		titleSet := input.TitleSet || input.Title != nil
		avatarSet := input.AvatarEmojiSet || input.AvatarEmoji != nil
		if !titleSet && !avatarSet {
			err := NewError(CodeConversationInvalidUpdate, MessageConversationInvalidUpdate, 400)
			return nil, rejectedError(err, "conversation.update", conversationTargetType, conversationID, CodeConversationInvalidUpdate), nil
		}
		if err := tx.Lock(ctx, "workspace-members:"+s.space()); err != nil {
			return nil, nil, err
		}
		var err error
		actor, err = s.lookupActor(ctx, tx, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if denied := s.requireCapability(actor, conversationMemberCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationMemberCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if err := tx.Lock(ctx, "conversation:"+conversationID); err != nil {
			return nil, nil, err
		}
		conversation, err := tx.FindConversation(ctx, s.space(), conversationID)
		if err != nil {
			return nil, nil, err
		}
		if conversation == nil {
			err := conversationNotFoundError()
			return nil, rejectedError(err, "conversation.update", conversationTargetType, conversationID, CodeConversationNotFound), nil
		}
		if conversation.Type != string(ConversationTypeGroup) {
			err := NewError(CodeConversationInvalidType, "只有群聊可以更新资料", 400)
			return nil, rejectedError(err, "conversation.update", conversationTargetType, conversationID, CodeConversationInvalidType), nil
		}
		title := conversation.Title
		if titleSet {
			title = strings.TrimSpace(stringValue(input.Title))
		}
		if title == "" {
			err := NewError(CodeConversationInvalidTitle, MessageConversationInvalidTitle, 400)
			return nil, rejectedError(err, "conversation.update", conversationTargetType, conversationID, "invalid title"), nil
		}
		if utf8.RuneCountInString(title) > MaxConversationTitleLen {
			err := NewError(CodeConversationInvalidTitle, MessageConversationTitleTooLong, 400)
			return nil, rejectedError(err, "conversation.update", conversationTargetType, conversationID, "invalid title"), nil
		}
		avatar := nullableString(conversation.AvatarEmoji)
		if avatarSet {
			avatarValue, avatarErr := normalizeAvatarEmoji(input.AvatarEmoji)
			if avatarErr != nil {
				return nil, rejectedError(avatarErr, "conversation.update", conversationTargetType, conversationID, "invalid avatar"), nil
			}
			avatar = avatarValue
		}
		if err := tx.UpdateGroup(ctx, s.space(), conversationID, title, avatar); err != nil {
			return nil, nil, err
		}
		eventRecord, err := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
		if err != nil {
			return nil, nil, err
		}
		if eventRecord == nil {
			return nil, nil, internalError("project updated group event", errors.New("conversation is not visible after update"))
		}
		eventConversation, err := s.projectConversation(ctx, tx, actor, *eventRecord)
		if err != nil {
			return nil, nil, err
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "conversation.updated", ActorID: actor.ID, ConversationID: conversationID, TargetType: conversationTargetType, TargetID: conversationID, PayloadJSON: mustJSON(map[string]any{"conversationId": conversationID, "title": title, "avatarEmoji": valueOrNil(avatar), "conversation": eventConversation}), CreatedAt: now}); err != nil {
			return nil, nil, err
		}
		actorName := firstNonEmpty(actor.DisplayName, actor.GitHubLogin, "成员")
		if titleSet && title != conversation.Title {
			if err := s.createSystemMessage(ctx, tx, actor, conversationID, conversation.RetentionCount, fmt.Sprintf("%s 将群聊名称改为「%s」", actorName, title), now); err != nil {
				return nil, nil, err
			}
		}
		if avatarSet && !sameOptionalString(avatar, conversation.AvatarEmoji) {
			message := fmt.Sprintf("%s 恢复了默认群头像", actorName)
			if avatar != nil {
				message = fmt.Sprintf("%s 将群头像改为 %s", actorName, *avatar)
			}
			if err := s.createSystemMessage(ctx, tx, actor, conversationID, conversation.RetentionCount, message, now); err != nil {
				return nil, nil, err
			}
		}
		if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{Action: "conversation.update", TargetType: conversationTargetType, TargetID: conversationID, Result: "success"}, now)); err != nil {
			return nil, nil, err
		}
		record, err := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
		if err != nil {
			return nil, nil, err
		}
		if record == nil {
			return nil, nil, internalError("project updated group conversation", errors.New("conversation is not visible after update"))
		}
		result, err := s.projectConversation(ctx, tx, actor, *record)
		return result, nil, err
	})
	if err != nil {
		return Conversation{}, err
	}
	return value.(Conversation), nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (s *Service) Leave(ctx context.Context, input ConversationInput) (LeaveResult, error) {
	value, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		conversationID := strings.TrimSpace(input.ConversationID)
		if conversationID == "" {
			err := NewError(CodeConversationRequired, MessageConversationRequired, 400)
			return nil, rejectedError(err, "conversation.leave", conversationTargetType, conversationID, CodeConversationRequired), nil
		}
		if err := tx.Lock(ctx, "workspace-members:"+s.space()); err != nil {
			return nil, nil, err
		}
		var err error
		actor, err = s.lookupActor(ctx, tx, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if err := tx.Lock(ctx, "conversation:"+conversationID); err != nil {
			return nil, nil, err
		}
		conversation, err := tx.FindConversation(ctx, s.space(), conversationID)
		if err != nil {
			return nil, nil, err
		}
		if conversation == nil {
			err := conversationNotFoundError()
			return nil, rejectedError(err, "conversation.leave", conversationTargetType, conversationID, CodeConversationNotFound), nil
		}
		if conversation.Type != string(ConversationTypeGroup) {
			err := NewError(CodeConversationInvalidType, "只有群聊可以离开", 400)
			return nil, rejectedError(err, "conversation.leave", conversationTargetType, conversationID, CodeConversationInvalidType), nil
		}
		active, err := tx.ConversationMemberActive(ctx, s.space(), conversationID, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if !active {
			err := conversationNotFoundError()
			return nil, rejectedError(err, "conversation.leave", conversationTargetType, conversationID, "not a conversation member"), nil
		}
		count, err := tx.CountActiveConversationMembers(ctx, s.space(), conversationID)
		if err != nil {
			return nil, nil, err
		}
		if count <= 1 {
			err := NewError(CodeConversationMemberInvalid, MessageConversationLastMember, 400)
			return nil, rejectedError(err, "conversation.leave", conversationTargetType, conversationID, "last member"), nil
		}
		removed, err := tx.RemoveConversationMember(ctx, s.space(), conversationID, actor.ID, now)
		if err != nil {
			return nil, nil, err
		}
		if !removed {
			err := conversationNotFoundError()
			return nil, rejectedError(err, "conversation.leave", conversationTargetType, conversationID, "not a conversation member"), nil
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "conversation.member_removed", ActorID: actor.ID, ConversationID: conversationID, TargetType: userTargetType, TargetID: actor.ID, PayloadJSON: mustJSON(map[string]any{"conversationId": conversationID, "userId": actor.ID, "self": true}), CreatedAt: now}); err != nil {
			return nil, nil, err
		}
		if err := s.createSystemMessage(ctx, tx, actor, conversationID, conversation.RetentionCount, fmt.Sprintf("%s 离开了群聊", firstNonEmpty(actor.DisplayName, actor.GitHubLogin, "成员")), now); err != nil {
			return nil, nil, err
		}
		if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{Action: "conversation.leave", TargetType: conversationTargetType, TargetID: conversationID, Result: "success"}, now)); err != nil {
			return nil, nil, err
		}
		return LeaveResult{OK: true, ConversationID: conversationID}, nil, nil
	})
	if err != nil {
		return LeaveResult{}, err
	}
	return value.(LeaveResult), nil
}

func (s *Service) MarkRead(ctx context.Context, input ConversationInput) (Conversation, error) {
	value, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		conversationID := strings.TrimSpace(input.ConversationID)
		if denied := s.requireCapability(actor, conversationReadCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationReadCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if conversationID == "" {
			err := NewError(CodeConversationRequired, MessageConversationRequired, 400)
			return nil, rejectedError(err, conversationReadCapability, conversationTargetType, conversationID, CodeConversationRequired), nil
		}
		if err := tx.Lock(ctx, "conversation:"+conversationID); err != nil {
			return nil, nil, err
		}
		record, err := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
		if err != nil {
			return nil, nil, err
		}
		if record == nil {
			err := conversationNotFoundError()
			return nil, rejectedError(err, conversationReadCapability, conversationTargetType, conversationID, "not a conversation member"), nil
		}
		if _, err := tx.MarkConversationRead(ctx, s.space(), conversationID, actor.ID, now); err != nil {
			return nil, nil, err
		}
		record, err = tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
		if err != nil {
			return nil, nil, err
		}
		if record == nil {
			return nil, nil, internalError("project marked conversation read", errors.New("conversation is not visible after read update"))
		}
		result, err := s.projectConversation(ctx, tx, actor, *record)
		return result, nil, err
	})
	if err != nil {
		return Conversation{}, err
	}
	return value.(Conversation), nil
}

func (s *Service) UpdateNotification(ctx context.Context, input NotificationInput) (Conversation, error) {
	level := strings.TrimSpace(input.Level)
	if level == "" {
		level = strings.TrimSpace(input.NotificationLevel)
	}
	if level != string(NotificationAll) && level != string(NotificationMentions) && level != string(NotificationMuted) {
		return Conversation{}, NewError(CodeConversationNotificationInvalid, MessageConversationNotificationInvalid, 400)
	}
	value, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		conversationID := strings.TrimSpace(input.ConversationID)
		if denied := s.requireCapability(actor, conversationReadCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationReadCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if conversationID == "" {
			err := NewError(CodeConversationRequired, MessageConversationRequired, 400)
			return nil, rejectedError(err, conversationReadCapability, conversationTargetType, conversationID, CodeConversationRequired), nil
		}
		if err := tx.Lock(ctx, "conversation:"+conversationID); err != nil {
			return nil, nil, err
		}
		record, err := tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
		if err != nil {
			return nil, nil, err
		}
		if record == nil {
			err := conversationNotFoundError()
			return nil, rejectedError(err, conversationReadCapability, conversationTargetType, conversationID, "not a conversation member"), nil
		}
		if err := tx.UpdateNotificationLevel(ctx, s.space(), conversationID, actor.ID, level); err != nil {
			return nil, nil, err
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "conversation.notification_updated", ActorID: actor.ID, ConversationID: conversationID, TargetType: userTargetType, TargetID: actor.ID, PayloadJSON: mustJSON(map[string]any{"conversationId": conversationID, "userId": actor.ID, "notificationLevel": level}), CreatedAt: now}); err != nil {
			return nil, nil, err
		}
		if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{Action: "conversation.notification_update", TargetType: conversationTargetType, TargetID: conversationID, Result: "success"}, now)); err != nil {
			return nil, nil, err
		}
		record, err = tx.GetVisibleConversationRecord(ctx, s.space(), actor.ID, conversationID)
		if err != nil {
			return nil, nil, err
		}
		if record == nil {
			return nil, nil, internalError("project notification conversation", errors.New("conversation is not visible after notification update"))
		}
		result, err := s.projectConversation(ctx, tx, actor, *record)
		return result, nil, err
	})
	if err != nil {
		return Conversation{}, err
	}
	return value.(Conversation), nil
}

func (s *Service) ListPins(ctx context.Context, input ConversationInput) ([]PinListItem, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return nil, err
	}
	conversationID := strings.TrimSpace(input.ConversationID)
	if denied := s.requireCapability(actor, conversationReadCapability, conversationTargetType, conversationID); denied != nil {
		return nil, s.recordReadRejection(ctx, actor.ID, input.Meta, conversationReadCapability, conversationTargetType, conversationID, "insufficient permission", denied)
	}
	if conversationID == "" {
		return nil, NewError(CodeConversationRequired, MessageConversationRequired, 400)
	}
	conversation, err := s.repo.FindConversation(ctx, s.space(), conversationID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if conversation == nil {
		notFound := messageNotFoundError()
		return nil, s.recordReadRejection(ctx, actor.ID, input.Meta, "message.pin.list", conversationTargetType, conversationID, CodeMessageNotFound, notFound)
	}
	if conversation.Type != string(ConversationTypeGroup) {
		invalidType := NewError(CodePinGroupOnly, MessagePinGroupOnly, 400)
		return nil, s.recordReadRejection(ctx, actor.ID, input.Meta, "message.pin.list", conversationTargetType, conversationID, CodePinGroupOnly, invalidType)
	}
	active, err := s.repo.ConversationMemberActive(ctx, s.space(), conversationID, actor.ID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if !active {
		notFound := conversationNotFoundError()
		return nil, s.recordReadRejection(ctx, actor.ID, input.Meta, "message.pin.list", conversationTargetType, conversationID, "not a conversation member", notFound)
	}
	pins, err := s.repo.ListPins(ctx, s.space(), conversationID, actor.ID, 100)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	pinMessages := make([]MessageRecord, len(pins))
	for index := range pins {
		pinMessages[index] = pins[index].Message
	}
	if err := s.hydrateMessageRecords(ctx, s.repo, actor.ID, pinMessages); err != nil {
		return nil, err
	}
	for index := range pins {
		pins[index].Message = pinMessages[index]
	}
	items := make([]PinListItem, 0, len(pins))
	for _, pin := range pins {
		message, err := projectPinnedMessage(pin.Message, &pin, actor)
		if err != nil {
			return nil, err
		}
		items = append(items, PinListItem{MessageID: pin.MessageID, PinnedByUserID: pin.PinnedByUserID, PinnedAt: formatTime(pin.CreatedAt), CanUnpin: actorCanUnpin(actor, pin.Message.AuthorID), Message: message})
	}
	return items, nil
}

func (s *Service) Pin(ctx context.Context, input PinInput) (PinListItem, error) {
	value, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		conversationID := strings.TrimSpace(input.ConversationID)
		messageID := strings.TrimSpace(input.MessageID)
		if denied := s.requireCapability(actor, conversationReadCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationReadCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if conversationID == "" {
			err := NewError(CodeConversationRequired, MessageConversationRequired, 400)
			return nil, rejectedError(err, "message.pin", conversationTargetType, conversationID, CodeConversationRequired), nil
		}
		if err := tx.Lock(ctx, "conversation:"+conversationID); err != nil {
			return nil, nil, err
		}
		conversation, err := tx.FindConversation(ctx, s.space(), conversationID)
		if err != nil {
			return nil, nil, err
		}
		if conversation == nil {
			err := messageNotFoundError()
			return nil, rejectedError(err, "message.pin", conversationTargetType, conversationID, CodeMessageNotFound), nil
		}
		if conversation.Type != string(ConversationTypeGroup) {
			err := NewError(CodePinGroupOnly, MessagePinGroupOnly, 400)
			return nil, rejectedError(err, "message.pin", conversationTargetType, conversationID, CodePinGroupOnly), nil
		}
		active, err := tx.ConversationMemberActive(ctx, s.space(), conversationID, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if !active {
			err := conversationNotFoundError()
			return nil, rejectedError(err, "message.pin", conversationTargetType, conversationID, "not a conversation member"), nil
		}
		message, err := tx.FindMessageForPin(ctx, s.space(), conversationID, messageID)
		if err != nil {
			return nil, nil, err
		}
		if message == nil {
			err := messageNotFoundError()
			return nil, rejectedError(err, "message.pin", messageTargetType, messageID, CodeMessageNotFound), nil
		}
		if message.Kind != "user" || message.AuthorID == nil || *message.AuthorID != actor.ID {
			err := NewError(CodePinNotAuthor, MessagePinNotAuthor, 400)
			return nil, rejectedError(err, "message.pin", messageTargetType, messageID, CodePinNotAuthor), nil
		}
		existing, err := tx.FindPin(ctx, s.space(), conversationID, messageID, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if existing == nil {
			added, err := tx.AddPin(ctx, s.space(), conversationID, messageID, actor.ID, now)
			if err != nil {
				return nil, nil, err
			}
			if !added {
				existing, err = tx.FindPin(ctx, s.space(), conversationID, messageID, actor.ID)
				if err != nil {
					return nil, nil, err
				}
				if existing == nil {
					err := NewError(CodePinLimitReached, MessagePinLimitReached, 400)
					return nil, rejectedError(err, "message.pin", messageTargetType, messageID, CodePinLimitReached), nil
				}
			} else {
				if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "message.pinned", ActorID: actor.ID, ConversationID: conversationID, TargetType: messageTargetType, TargetID: messageID, PayloadJSON: mustJSON(map[string]any{"conversationId": conversationID, "messageId": messageID}), CreatedAt: now}); err != nil {
					return nil, nil, err
				}
				if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{Action: "message.pin", TargetType: messageTargetType, TargetID: messageID, Result: "success"}, now)); err != nil {
					return nil, nil, err
				}
			}
		}
		if existing == nil {
			existing, err = tx.FindPin(ctx, s.space(), conversationID, messageID, actor.ID)
			if err != nil {
				return nil, nil, err
			}
		}
		if existing == nil {
			return nil, nil, internalError("project pinned message", errors.New("pin is not visible after insert"))
		}
		if existing.Message.ID == "" {
			existing.Message = *message
		}
		messageRecords := []MessageRecord{existing.Message}
		if err := s.hydrateMessageRecords(ctx, tx, actor.ID, messageRecords); err != nil {
			return nil, nil, err
		}
		existing.Message = messageRecords[0]
		projectedMessage, err := projectPinnedMessage(existing.Message, existing, actor)
		if err != nil {
			return nil, nil, err
		}
		projected := PinListItem{MessageID: existing.MessageID, PinnedByUserID: existing.PinnedByUserID, PinnedAt: formatTime(existing.CreatedAt), CanUnpin: actorCanUnpin(actor, existing.Message.AuthorID), Message: projectedMessage}
		return projected, nil, nil
	})
	if err != nil {
		return PinListItem{}, err
	}
	return value.(PinListItem), nil
}

func (s *Service) Unpin(ctx context.Context, input PinInput) (UnpinResult, error) {
	value, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		conversationID := strings.TrimSpace(input.ConversationID)
		messageID := strings.TrimSpace(input.MessageID)
		if denied := s.requireCapability(actor, conversationReadCapability, conversationTargetType, conversationID); denied != nil {
			return nil, rejectedError(denied, conversationReadCapability, conversationTargetType, conversationID, "insufficient permission"), nil
		}
		if conversationID == "" {
			err := NewError(CodeConversationRequired, MessageConversationRequired, 400)
			return nil, rejectedError(err, "message.unpin", conversationTargetType, conversationID, CodeConversationRequired), nil
		}
		if err := tx.Lock(ctx, "conversation:"+conversationID); err != nil {
			return nil, nil, err
		}
		conversation, err := tx.FindConversation(ctx, s.space(), conversationID)
		if err != nil {
			return nil, nil, err
		}
		if conversation == nil {
			err := messageNotFoundError()
			return nil, rejectedError(err, "message.unpin", conversationTargetType, conversationID, CodeMessageNotFound), nil
		}
		if conversation.Type != string(ConversationTypeGroup) {
			err := NewError(CodePinGroupOnly, MessagePinGroupOnly, 400)
			return nil, rejectedError(err, "message.unpin", conversationTargetType, conversationID, CodePinGroupOnly), nil
		}
		active, err := tx.ConversationMemberActive(ctx, s.space(), conversationID, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if !active {
			err := conversationNotFoundError()
			return nil, rejectedError(err, "message.unpin", conversationTargetType, conversationID, "not a conversation member"), nil
		}
		message, err := tx.FindMessageForPin(ctx, s.space(), conversationID, messageID)
		if err != nil {
			return nil, nil, err
		}
		if message == nil {
			err := messageNotFoundError()
			return nil, rejectedError(err, "message.unpin", messageTargetType, messageID, CodeMessageNotFound), nil
		}
		if !actorCanUnpin(actor, message.AuthorID) {
			err := pinPermissionDeniedError()
			return nil, rejectedError(err, "message.unpin", messageTargetType, messageID, "insufficient permission"), nil
		}
		pin, err := tx.FindPin(ctx, s.space(), conversationID, messageID, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if pin == nil {
			return UnpinResult{MessageID: messageID, Removed: false}, nil, nil
		}
		_, removed, err := tx.RemovePin(ctx, s.space(), conversationID, messageID)
		if err != nil {
			return nil, nil, err
		}
		if !removed {
			return UnpinResult{MessageID: messageID, Removed: false}, nil, nil
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: s.space(), Type: "message.unpinned", ActorID: actor.ID, ConversationID: conversationID, TargetType: messageTargetType, TargetID: messageID, PayloadJSON: mustJSON(map[string]any{"conversationId": conversationID, "messageId": messageID}), CreatedAt: now}); err != nil {
			return nil, nil, err
		}
		if err := tx.WriteAudit(ctx, s.auditFor(actor, input.Meta, AuditInput{Action: "message.unpin", TargetType: messageTargetType, TargetID: messageID, Result: "success"}, now)); err != nil {
			return nil, nil, err
		}
		return UnpinResult{MessageID: messageID, Removed: true}, nil, nil
	})
	if err != nil {
		return UnpinResult{}, err
	}
	return value.(UnpinResult), nil
}

// Compatibility-shaped method names keep the application boundary easy to
// wire while the HTTP adapter is migrated from the Node service names.
func (s *Service) AddConversationMember(ctx context.Context, input ConversationMemberInput) (Conversation, error) {
	return s.AddMember(ctx, input)
}

func (s *Service) GetConversationDetails(ctx context.Context, input ConversationInput) (Conversation, error) {
	return s.GetConversation(ctx, input)
}

func (s *Service) RemoveConversationMember(ctx context.Context, input ConversationMemberInput) (Conversation, error) {
	return s.RemoveMember(ctx, input)
}

func (s *Service) UpdateGroupConversation(ctx context.Context, input UpdateGroupInput) (Conversation, error) {
	return s.UpdateGroup(ctx, input)
}

func (s *Service) LeaveConversation(ctx context.Context, input ConversationInput) (LeaveResult, error) {
	return s.Leave(ctx, input)
}

func (s *Service) MarkConversationRead(ctx context.Context, input ConversationInput) (Conversation, error) {
	return s.MarkRead(ctx, input)
}

func (s *Service) UpdateConversationNotificationLevel(ctx context.Context, input NotificationInput) (Conversation, error) {
	return s.UpdateNotification(ctx, input)
}

func (s *Service) ListPinnedMessages(ctx context.Context, input ConversationInput) ([]PinListItem, error) {
	return s.ListPins(ctx, input)
}

func (s *Service) PinGroupMessage(ctx context.Context, input PinInput) (PinListItem, error) {
	return s.Pin(ctx, input)
}

func (s *Service) UnpinGroupMessage(ctx context.Context, input PinInput) (UnpinResult, error) {
	return s.Unpin(ctx, input)
}
