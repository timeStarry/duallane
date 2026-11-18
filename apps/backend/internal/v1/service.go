package v1

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/mobileruntime"
)

const (
	MaxMobileAPKBytes = 30 * 1024 * 1024
	MaxMobileOTABytes = 15 * 1024 * 1024
)

type EmailCodeSender interface {
	SendVerificationCode(ctx context.Context, recipient, code, purpose string) error
	HashChallengeCode(id, code string) (string, error)
	VerifyChallengeCode(expectedHash, id, code string) (bool, error)
}

type Repository interface {
	GetBootstrap(ctx context.Context, actorID string, now time.Time) (V1BootstrapResponse, error)
	SyncDelta(ctx context.Context, actorID string, sinceSeq int64, limit int) (SyncDeltaResponse, error)
	Search(ctx context.Context, actorID, query, scope string, limit int) (SearchResponse, error)
	GetOrCreateSavedConversation(ctx context.Context, actorID string, now time.Time) (string, error)
	CreateGroupConversation(ctx context.Context, actorID string, input CreateGroupInput, now time.Time) (GroupConversationSummary, error)
	UpdateGroupConversation(ctx context.Context, actorID, conversationID string, input UpdateGroupInput, now time.Time) (GroupConversationSummary, error)
	AddGroupMembers(ctx context.Context, actorID, conversationID string, userIDs []string, now time.Time) (GroupConversationSummary, error)
	RemoveGroupMember(ctx context.Context, actorID, conversationID, targetUserID string, now time.Time) (GroupConversationSummary, error)
	LeaveGroupConversation(ctx context.Context, actorID, conversationID string, now time.Time) error
	MarkConversationRead(ctx context.Context, actorID, conversationID string, now time.Time) (string, error)
	SendConversationTyping(ctx context.Context, actorID, conversationID, kind, state string, now time.Time) (string, error)
	EditMessage(ctx context.Context, actorID, messageID, plainText string, now time.Time) error
	ForwardMessages(ctx context.Context, actorID, targetConversationID string, messageIDs []string, now time.Time) ([]string, error)
	GetThread(ctx context.Context, actorID, rootMessageID string) (ThreadView, error)
	ListConversationThreads(ctx context.Context, actorID, conversationID string) ([]ConversationThreadItem, error)
	ReplyThread(ctx context.Context, actorID, rootMessageID, plainText, threadTitle string, alsoSendToChannel bool, now time.Time) (ThreadReply, error)
	PinMessage(ctx context.Context, actorID, conversationID, messageID string, now time.Time) error
	UnpinMessage(ctx context.Context, actorID, conversationID, messageID string) error
	ListDevices(ctx context.Context, actorID, currentDeviceID string) ([]UserDevice, error)
	RevokeDevice(ctx context.Context, actorID, deviceID string, now time.Time) error
	CreateQRSession(ctx context.Context, platform, deviceName string, now time.Time) (QRLoginSession, error)
	ApproveQRSession(ctx context.Context, actorID, sessionID string, now time.Time) (QRLoginSession, error)
	ExchangeQRSession(ctx context.Context, sessionID, challenge string, now time.Time) (string, error)
	GetPreferences(ctx context.Context, actorID string) (map[string]any, error)
	SavePreferences(ctx context.Context, actorID string, prefs map[string]any, now time.Time) error
	RegisterBotCommands(ctx context.Context, actorID, botID string, commands []BotCommand, now time.Time) error
	ListBotCommands(ctx context.Context, actorID, conversationID string) ([]BotCommand, error)
	ListBotCommandsByBot(ctx context.Context, actorID, botID string) ([]BotCommand, error)
	CreateMultiBot(ctx context.Context, actorID, name string, now time.Time) (string, error)
	UpdateBotProfile(ctx context.Context, actorID, botID string, input BotProfileUpdateInput, now time.Time) (BotProfileResult, error)
	UploadBotAvatar(ctx context.Context, actorID, botID, mimeType string, data []byte, now time.Time) (BotProfileResult, error)
	DeleteBotAvatar(ctx context.Context, actorID, botID string, now time.Time) (BotProfileResult, error)
	GetBotAvatar(ctx context.Context, actorID, botID string) (BotAvatarPayload, error)
	UnbindBotToken(ctx context.Context, botID, tokenID string, now time.Time) error
	UpsertBotWebhook(ctx context.Context, actorID, botID, url, secretHash string, enabled bool, now time.Time) (BotWebhookConfig, error)
	ListBotConversations(ctx context.Context, botID, botUserID string) ([]BotConversationSummary, error)
	ListBotRecentDeliveries(ctx context.Context, botID string, limit int) ([]BotDeliveryDiagnostic, error)
	GetBotConsoleOverview(ctx context.Context, actorID, botID string, now time.Time) (BotConsoleOverview, error)
	RequestBotRuntimeUpgrade(ctx context.Context, actorID, botID string, now time.Time) (string, error)
	GetAdminOverview(ctx context.Context, actorID string, now time.Time) (AdminOverviewResponse, error)
	ListAdminInvites(ctx context.Context, actorID string, now time.Time) (AdminInviteListResponse, error)
	ListAdminAuditLogs(ctx context.Context, actorID, resultFilter, query string, limit int) ([]AdminAuditLogItem, error)
	UpdateSpacePolicy(ctx context.Context, actorID string, input AdminPolicyUpdateInput, now time.Time) (AdminSpacePolicy, error)
	CleanupStaleStorage(ctx context.Context, actorID string, now time.Time) (AdminStorageCleanupResult, error)
	GetAdminAnnouncement(ctx context.Context, actorID string) (SystemAnnouncement, error)
	UpsertAdminAnnouncement(ctx context.Context, actorID string, ann SystemAnnouncement, now time.Time) (SystemAnnouncement, error)
	AckAnnouncement(ctx context.Context, actorID, announcementID string, now time.Time) error
	FindBoundEmailOwner(ctx context.Context, normalizedEmail string) (string, error)
	CheckEmailChallengeCooldown(ctx context.Context, userID string, now time.Time) error
	SaveEmailChallenge(ctx context.Context, challengeID, userID, normalizedEmail, codeHash string, now, expiresAt time.Time) error
	VerifyAndConsumeEmailChallenge(ctx context.Context, challengeID string, verifyFn func(rec EmailChallengeStoreRecord) (bool, error), now time.Time) (EmailChallengeStoreRecord, error)
	BindAccountEmail(ctx context.Context, actorID, normalizedEmail string, now time.Time) error
	UnbindAccountEmail(ctx context.Context, actorID string, now time.Time) error
	ResolveEmailLoginMember(ctx context.Context, userID, normalizedEmail string, now time.Time) (V1BootstrapMember, error)
	GetPublicMobileRelease(ctx context.Context) (MobileClientRelease, error)
	GetAdminMobileRelease(ctx context.Context, actorID string) (MobileClientRelease, error)
	UpsertAdminMobileRelease(ctx context.Context, actorID string, rel MobileClientRelease, now time.Time) (MobileClientRelease, error)
}

type Service struct {
	repo        Repository
	emailSender EmailCodeSender
	blobStore   platformstorage.BlobStore
	codeGen     func() (string, error)
	now         func() time.Time
}

func NewService(repo Repository) *Service {
	return &Service{
		repo:    repo,
		codeGen: email.GenerateVerificationCode,
		now:     func() time.Time { return time.Now().UTC() },
	}
}

func (s *Service) WithEmailSender(sender EmailCodeSender) *Service {
	s.emailSender = sender
	return s
}

func (s *Service) WithBlobStore(blobStore platformstorage.BlobStore) *Service {
	s.blobStore = blobStore
	return s
}

func (s *Service) GetBootstrap(ctx context.Context, actorID string) (V1BootstrapResponse, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return V1BootstrapResponse{}, ErrForbidden
	}
	return s.repo.GetBootstrap(ctx, actorID, s.now())
}

func (s *Service) SyncDelta(ctx context.Context, actorID string, sinceSeq int64) (SyncDeltaResponse, error) {
	if strings.TrimSpace(actorID) == "" {
		return SyncDeltaResponse{}, ErrForbidden
	}
	if sinceSeq < 0 {
		sinceSeq = 0
	}
	return s.repo.SyncDelta(ctx, actorID, sinceSeq, 200)
}

func (s *Service) Search(ctx context.Context, actorID, query, scope string) (SearchResponse, error) {
	if strings.TrimSpace(actorID) == "" {
		return SearchResponse{}, ErrForbidden
	}
	q := strings.TrimSpace(query)
	if len(q) == 0 {
		return SearchResponse{Messages: []SearchMessageHit{}, Files: []SearchFileHit{}}, nil
	}
	if scope == "" {
		scope = "all"
	}
	return s.repo.Search(ctx, actorID, q, scope, 50)
}

func (s *Service) GetOrCreateSavedConversation(ctx context.Context, actorID string) (string, error) {
	if strings.TrimSpace(actorID) == "" {
		return "", ErrForbidden
	}
	return s.repo.GetOrCreateSavedConversation(ctx, actorID, s.now())
}

func (s *Service) CreateGroupConversation(ctx context.Context, actorID string, input CreateGroupInput) (GroupConversationSummary, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return GroupConversationSummary{}, ErrForbidden
	}
	title := strings.TrimSpace(input.Title)
	if title == "" || utf8.RuneCountInString(title) > 80 {
		return GroupConversationSummary{}, fmt.Errorf("%w: 群聊名称需为 1-80 个字符", ErrInvalidInput)
	}
	var normalizedAvatar *string
	if input.Avatar != nil && strings.TrimSpace(*input.Avatar) != "" {
		kind, norm, _, err := NormalizeGroupAvatarValue(*input.Avatar)
		if err != nil {
			return GroupConversationSummary{}, err
		}
		if kind != "emoji" {
			return GroupConversationSummary{}, fmt.Errorf("%w: 创建群聊时仅支持 Emoji 头像，创建后可上传图片头像", ErrInvalidInput)
		}
		normalizedAvatar = &norm
	}
	peers := make([]string, 0, len(input.MemberIDs))
	for _, id := range dedupeNonEmptyIDs(input.MemberIDs) {
		if id != actorID {
			peers = append(peers, id)
		}
	}
	if len(peers) == 0 || len(peers) > 100 {
		return GroupConversationSummary{}, fmt.Errorf("%w: 请至少选择 1 位空间成员", ErrInvalidInput)
	}
	return s.repo.CreateGroupConversation(ctx, actorID, CreateGroupInput{
		Title:     title,
		MemberIDs: peers,
		Avatar:    normalizedAvatar,
	}, s.now())
}

func (s *Service) UpdateGroupConversation(ctx context.Context, actorID, conversationID string, input UpdateGroupInput) (GroupConversationSummary, error) {
	actorID = strings.TrimSpace(actorID)
	conversationID = strings.TrimSpace(conversationID)
	if actorID == "" {
		return GroupConversationSummary{}, ErrForbidden
	}
	if conversationID == "" || (!input.TitleSet && !input.AvatarSet) {
		return GroupConversationSummary{}, ErrInvalidInput
	}
	clean := UpdateGroupInput{
		TitleSet:  input.TitleSet,
		AvatarSet: input.AvatarSet,
	}
	if input.TitleSet {
		title := ""
		if input.Title != nil {
			title = strings.TrimSpace(*input.Title)
		}
		if title == "" || utf8.RuneCountInString(title) > 80 {
			return GroupConversationSummary{}, fmt.Errorf("%w: 群聊名称需为 1-80 个字符", ErrInvalidInput)
		}
		clean.Title = &title
	}
	if input.AvatarSet {
		raw := ""
		if input.Avatar != nil {
			raw = *input.Avatar
		}
		kind, norm, _, err := NormalizeGroupAvatarValue(raw)
		if err != nil {
			return GroupConversationSummary{}, err
		}
		if kind == "empty" {
			clean.Avatar = nil
		} else {
			clean.Avatar = &norm
		}
	}
	return s.repo.UpdateGroupConversation(ctx, actorID, conversationID, clean, s.now())
}

func (s *Service) AddGroupMembers(ctx context.Context, actorID, conversationID string, userIDs []string) (GroupConversationSummary, error) {
	actorID = strings.TrimSpace(actorID)
	conversationID = strings.TrimSpace(conversationID)
	if actorID == "" {
		return GroupConversationSummary{}, ErrForbidden
	}
	cleaned := make([]string, 0, len(userIDs))
	for _, id := range dedupeNonEmptyIDs(userIDs) {
		if id != actorID {
			cleaned = append(cleaned, id)
		}
	}
	if conversationID == "" || len(cleaned) == 0 || len(cleaned) > 50 {
		return GroupConversationSummary{}, ErrInvalidInput
	}
	return s.repo.AddGroupMembers(ctx, actorID, conversationID, cleaned, s.now())
}

func (s *Service) LeaveGroupConversation(ctx context.Context, actorID, conversationID string) error {
	actorID = strings.TrimSpace(actorID)
	conversationID = strings.TrimSpace(conversationID)
	if actorID == "" {
		return ErrForbidden
	}
	if conversationID == "" {
		return ErrInvalidInput
	}
	return s.repo.LeaveGroupConversation(ctx, actorID, conversationID, s.now())
}

func (s *Service) RemoveGroupMember(ctx context.Context, actorID, conversationID, targetUserID string) (GroupConversationSummary, error) {
	actorID = strings.TrimSpace(actorID)
	conversationID = strings.TrimSpace(conversationID)
	targetUserID = strings.TrimSpace(targetUserID)
	if actorID == "" {
		return GroupConversationSummary{}, ErrForbidden
	}
	if conversationID == "" || targetUserID == "" || targetUserID == actorID {
		return GroupConversationSummary{}, ErrInvalidInput
	}
	return s.repo.RemoveGroupMember(ctx, actorID, conversationID, targetUserID, s.now())
}

func (s *Service) MarkConversationRead(ctx context.Context, actorID, conversationID string) (string, error) {
	actorID = strings.TrimSpace(actorID)
	conversationID = strings.TrimSpace(conversationID)
	if actorID == "" {
		return "", ErrForbidden
	}
	if conversationID == "" {
		return "", ErrInvalidInput
	}
	return s.repo.MarkConversationRead(ctx, actorID, conversationID, s.now())
}

func (s *Service) SendConversationTyping(ctx context.Context, actorID, conversationID, kind, state string) (string, error) {
	actorID = strings.TrimSpace(actorID)
	conversationID = strings.TrimSpace(conversationID)
	if actorID == "" {
		return "", ErrForbidden
	}
	if conversationID == "" {
		return "", ErrInvalidInput
	}
	normKind := strings.ToLower(strings.TrimSpace(kind))
	if normKind != "bot" {
		normKind = "human"
	}
	normState := strings.ToLower(strings.TrimSpace(state))
	if normState != "thinking" && normState != "typing" {
		if normKind == "bot" {
			normState = "thinking"
		} else {
			normState = "typing"
		}
	}
	return s.repo.SendConversationTyping(ctx, actorID, conversationID, normKind, normState, s.now())
}

func dedupeNonEmptyIDs(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, raw := range items {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func (s *Service) EditMessage(ctx context.Context, actorID, messageID, plainText string) error {
	trimmed := strings.TrimSpace(plainText)
	if trimmed == "" || len(trimmed) > 30000 {
		return ErrInvalidInput
	}
	return s.repo.EditMessage(ctx, actorID, messageID, trimmed, s.now())
}

func (s *Service) ForwardMessages(ctx context.Context, actorID, targetConversationID string, messageIDs []string) ([]string, error) {
	if strings.TrimSpace(targetConversationID) == "" || len(messageIDs) == 0 || len(messageIDs) > 20 {
		return nil, ErrInvalidInput
	}
	return s.repo.ForwardMessages(ctx, actorID, targetConversationID, messageIDs, s.now())
}

func (s *Service) GetThread(ctx context.Context, actorID, rootMessageID string) (ThreadView, error) {
	if strings.TrimSpace(rootMessageID) == "" {
		return ThreadView{}, ErrInvalidInput
	}
	return s.repo.GetThread(ctx, actorID, rootMessageID)
}

func (s *Service) ListConversationThreads(ctx context.Context, actorID, conversationID string) ([]ConversationThreadItem, error) {
	if strings.TrimSpace(conversationID) == "" {
		return nil, ErrInvalidInput
	}
	return s.repo.ListConversationThreads(ctx, actorID, strings.TrimSpace(conversationID))
}

func (s *Service) ReplyThread(ctx context.Context, actorID, rootMessageID, plainText, threadTitle string, alsoSendToChannel bool) (ThreadReply, error) {
	trimmed := strings.TrimSpace(plainText)
	if strings.TrimSpace(rootMessageID) == "" || trimmed == "" {
		return ThreadReply{}, ErrInvalidInput
	}
	return s.repo.ReplyThread(ctx, actorID, rootMessageID, trimmed, strings.TrimSpace(threadTitle), alsoSendToChannel, s.now())
}

func (s *Service) PinMessage(ctx context.Context, actorID, conversationID, messageID string) error {
	if strings.TrimSpace(conversationID) == "" || strings.TrimSpace(messageID) == "" {
		return ErrInvalidInput
	}
	return s.repo.PinMessage(ctx, actorID, conversationID, messageID, s.now())
}

func (s *Service) UnpinMessage(ctx context.Context, actorID, conversationID, messageID string) error {
	if strings.TrimSpace(conversationID) == "" || strings.TrimSpace(messageID) == "" {
		return ErrInvalidInput
	}
	return s.repo.UnpinMessage(ctx, actorID, conversationID, messageID)
}

func (s *Service) ListDevices(ctx context.Context, actorID, currentDeviceID string) ([]UserDevice, error) {
	return s.repo.ListDevices(ctx, actorID, currentDeviceID)
}

func (s *Service) RevokeDevice(ctx context.Context, actorID, deviceID string) error {
	if strings.TrimSpace(deviceID) == "" {
		return ErrInvalidInput
	}
	return s.repo.RevokeDevice(ctx, actorID, deviceID, s.now())
}

func (s *Service) CreateQRSession(ctx context.Context, platform, deviceName string) (QRLoginSession, error) {
	if platform != "ios" && platform != "android" {
		return QRLoginSession{}, ErrInvalidInput
	}
	if strings.TrimSpace(deviceName) == "" {
		deviceName = "DualLane Mobile"
	}
	return s.repo.CreateQRSession(ctx, platform, strings.TrimSpace(deviceName), s.now())
}

func (s *Service) ApproveQRSession(ctx context.Context, actorID, sessionID string) (QRLoginSession, error) {
	if strings.TrimSpace(actorID) == "" || strings.TrimSpace(sessionID) == "" {
		return QRLoginSession{}, ErrInvalidInput
	}
	return s.repo.ApproveQRSession(ctx, actorID, sessionID, s.now())
}

func (s *Service) ExchangeQRSession(ctx context.Context, sessionID, challenge string) (string, error) {
	if strings.TrimSpace(sessionID) == "" || strings.TrimSpace(challenge) == "" {
		return "", ErrInvalidInput
	}
	return s.repo.ExchangeQRSession(ctx, sessionID, challenge, s.now())
}

func (s *Service) GetPreferences(ctx context.Context, actorID string) (map[string]any, error) {
	return s.repo.GetPreferences(ctx, actorID)
}

func (s *Service) SavePreferences(ctx context.Context, actorID string, prefs map[string]any) error {
	if prefs == nil {
		return ErrInvalidInput
	}
	return s.repo.SavePreferences(ctx, actorID, prefs, s.now())
}

func (s *Service) RegisterBotCommands(ctx context.Context, actorID, botID string, commands []BotCommand) error {
	if strings.TrimSpace(botID) == "" || len(commands) > 30 {
		return ErrInvalidInput
	}
	for i := range commands {
		cmd := strings.TrimPrefix(strings.TrimSpace(commands[i].Command), "/")
		if cmd == "" || strings.ContainsAny(cmd, " \t\n") {
			return fmt.Errorf("%w: invalid command %q", ErrInvalidInput, commands[i].Command)
		}
		commands[i].Command = strings.ToLower(cmd)
		if commands[i].Scope == "" {
			commands[i].Scope = "all"
		}
	}
	return s.repo.RegisterBotCommands(ctx, actorID, botID, commands, s.now())
}

func (s *Service) ListBotCommands(ctx context.Context, actorID, conversationID string) ([]BotCommand, error) {
	actorID = strings.TrimSpace(actorID)
	conversationID = strings.TrimSpace(conversationID)
	if actorID == "" {
		return nil, ErrForbidden
	}
	if conversationID == "" {
		return nil, ErrInvalidInput
	}
	cmds, err := s.repo.ListBotCommands(ctx, actorID, conversationID)
	if err != nil {
		return nil, err
	}
	if cmds == nil {
		return []BotCommand{}, nil
	}
	return cmds, nil
}

func (s *Service) ListBotCommandsByBot(ctx context.Context, actorID, botID string) ([]BotCommand, error) {
	if strings.TrimSpace(actorID) == "" || strings.TrimSpace(botID) == "" {
		return nil, ErrInvalidInput
	}
	return s.repo.ListBotCommandsByBot(ctx, actorID, botID)
}

func (s *Service) CreateMultiBot(ctx context.Context, actorID, name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if strings.TrimSpace(actorID) == "" || utf8.RuneCountInString(trimmed) < 2 || utf8.RuneCountInString(trimmed) > 64 {
		return "", ErrInvalidInput
	}
	return s.repo.CreateMultiBot(ctx, actorID, trimmed, s.now())
}

func (s *Service) UpdateBotProfile(ctx context.Context, actorID, botID string, input BotProfileUpdateInput) (BotProfileResult, error) {
	actorID = strings.TrimSpace(actorID)
	botID = strings.TrimSpace(botID)
	if actorID == "" {
		return BotProfileResult{}, ErrForbidden
	}
	if botID == "" || (!input.NameSet && !input.DescriptionSet && !input.ColorSet) {
		return BotProfileResult{}, ErrInvalidInput
	}
	clean := BotProfileUpdateInput{
		NameSet:        input.NameSet,
		DescriptionSet: input.DescriptionSet,
		ColorSet:       input.ColorSet,
	}
	if input.NameSet {
		name := ""
		if input.Name != nil {
			name = strings.TrimSpace(*input.Name)
		}
		rc := utf8.RuneCountInString(name)
		if rc < 2 || rc > 64 {
			return BotProfileResult{}, fmt.Errorf("%w: 机器人名称需为 2-64 个字符", ErrInvalidInput)
		}
		lower := strings.ToLower(name)
		for _, reserved := range []string{"信标", "回声", "beacon", "echo", "duallane"} {
			if lower == reserved {
				return BotProfileResult{}, fmt.Errorf("%w: 该名称为系统保留名称", ErrInvalidInput)
			}
		}
		clean.Name = &name
	}
	if input.DescriptionSet {
		desc := ""
		if input.Description != nil {
			desc = strings.TrimSpace(*input.Description)
		}
		if utf8.RuneCountInString(desc) > 240 {
			return BotProfileResult{}, fmt.Errorf("%w: 机器人简介不可超过 240 个字符", ErrInvalidInput)
		}
		clean.Description = &desc
	}
	if input.ColorSet {
		color := ""
		if input.Color != nil {
			color = strings.ToLower(strings.TrimSpace(*input.Color))
		}
		if !IsValidBotColor(color) {
			return BotProfileResult{}, fmt.Errorf("%w: 机器人主题色无效", ErrInvalidInput)
		}
		clean.Color = &color
	}
	return s.repo.UpdateBotProfile(ctx, actorID, botID, clean, s.now())
}

func (s *Service) UploadBotAvatar(ctx context.Context, actorID, botID, mimeType string, data []byte) (BotProfileResult, error) {
	actorID = strings.TrimSpace(actorID)
	botID = strings.TrimSpace(botID)
	if actorID == "" {
		return BotProfileResult{}, ErrForbidden
	}
	if botID == "" || len(data) == 0 || len(data) > 512*1024 {
		return BotProfileResult{}, fmt.Errorf("%w: 机器人头像大小需在 512KB 以内", ErrInvalidInput)
	}
	cleanMime := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	switch cleanMime {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
	default:
		return BotProfileResult{}, fmt.Errorf("%w: 仅支持 PNG、JPG、WebP 或 GIF 图片", ErrInvalidInput)
	}
	return s.repo.UploadBotAvatar(ctx, actorID, botID, cleanMime, data, s.now())
}

func (s *Service) DeleteBotAvatar(ctx context.Context, actorID, botID string) (BotProfileResult, error) {
	actorID = strings.TrimSpace(actorID)
	botID = strings.TrimSpace(botID)
	if actorID == "" {
		return BotProfileResult{}, ErrForbidden
	}
	if botID == "" {
		return BotProfileResult{}, ErrInvalidInput
	}
	return s.repo.DeleteBotAvatar(ctx, actorID, botID, s.now())
}

func (s *Service) GetBotAvatar(ctx context.Context, actorID, botID string) (BotAvatarPayload, error) {
	actorID = strings.TrimSpace(actorID)
	botID = strings.TrimSpace(botID)
	if actorID == "" {
		return BotAvatarPayload{}, ErrForbidden
	}
	if botID == "" {
		return BotAvatarPayload{}, ErrInvalidInput
	}
	return s.repo.GetBotAvatar(ctx, actorID, botID)
}

func (s *Service) UnbindBotSelf(ctx context.Context, botID, tokenID string) error {
	botID = strings.TrimSpace(botID)
	tokenID = strings.TrimSpace(tokenID)
	if botID == "" || tokenID == "" {
		return ErrForbidden
	}
	return s.repo.UnbindBotToken(ctx, botID, tokenID, s.now())
}

func (s *Service) UpsertBotWebhook(ctx context.Context, actorID, botID, url, secret string, enabled bool) (BotWebhookConfig, error) {
	if strings.TrimSpace(botID) == "" || !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://127.0.0.1") {
		return BotWebhookConfig{}, ErrInvalidInput
	}
	if len(strings.TrimSpace(secret)) < 16 {
		return BotWebhookConfig{}, fmt.Errorf("%w: webhook secret must be at least 16 chars", ErrInvalidInput)
	}
	return s.repo.UpsertBotWebhook(ctx, actorID, botID, strings.TrimSpace(url), secret, enabled, s.now())
}

func (s *Service) ListBotConversations(ctx context.Context, botID, botUserID string) ([]BotConversationSummary, error) {
	if strings.TrimSpace(botID) == "" || strings.TrimSpace(botUserID) == "" {
		return nil, ErrForbidden
	}
	items, err := s.repo.ListBotConversations(ctx, strings.TrimSpace(botID), strings.TrimSpace(botUserID))
	if err != nil {
		return nil, err
	}
	if items == nil {
		return []BotConversationSummary{}, nil
	}
	return items, nil
}

func (s *Service) ListBotRecentDeliveries(ctx context.Context, botID string, limit int) ([]BotDeliveryDiagnostic, error) {
	if strings.TrimSpace(botID) == "" {
		return nil, ErrForbidden
	}
	items, err := s.repo.ListBotRecentDeliveries(ctx, strings.TrimSpace(botID), limit)
	if err != nil {
		return nil, err
	}
	if items == nil {
		return []BotDeliveryDiagnostic{}, nil
	}
	return items, nil
}

func (s *Service) GetBotConsoleOverview(ctx context.Context, actorID, botID string) (BotConsoleOverview, error) {
	actorID = strings.TrimSpace(actorID)
	botID = strings.TrimSpace(botID)
	if actorID == "" {
		return BotConsoleOverview{}, ErrForbidden
	}
	if botID == "" {
		return BotConsoleOverview{}, ErrInvalidInput
	}
	overview, err := s.repo.GetBotConsoleOverview(ctx, actorID, botID, s.now())
	if err != nil {
		return BotConsoleOverview{}, err
	}
	if overview.Conversations == nil {
		overview.Conversations = []BotConversationSummary{}
	}
	if overview.RecentDeliveries == nil {
		overview.RecentDeliveries = []BotDeliveryDiagnostic{}
	}
	if overview.LatestSDKVersion == "" {
		overview.LatestSDKVersion = LatestAgentSDKVersion
	}
	return overview, nil
}

func (s *Service) RequestBotRuntimeUpgrade(ctx context.Context, actorID, botID string) (string, error) {
	actorID = strings.TrimSpace(actorID)
	botID = strings.TrimSpace(botID)
	if actorID == "" {
		return "", ErrForbidden
	}
	if botID == "" {
		return "", ErrInvalidInput
	}
	return s.repo.RequestBotRuntimeUpgrade(ctx, actorID, botID, s.now())
}

func (s *Service) GetAdminOverview(ctx context.Context, actorID string) (AdminOverviewResponse, error) {
	if strings.TrimSpace(actorID) == "" {
		return AdminOverviewResponse{}, ErrForbidden
	}
	return s.repo.GetAdminOverview(ctx, actorID, s.now())
}

func (s *Service) ListAdminInvites(ctx context.Context, actorID string) (AdminInviteListResponse, error) {
	if strings.TrimSpace(actorID) == "" {
		return AdminInviteListResponse{}, ErrForbidden
	}
	return s.repo.ListAdminInvites(ctx, actorID, s.now())
}

func (s *Service) ListAdminAuditLogs(ctx context.Context, actorID, resultFilter, query string, limit int) ([]AdminAuditLogItem, error) {
	if strings.TrimSpace(actorID) == "" {
		return nil, ErrForbidden
	}
	rf := strings.ToLower(strings.TrimSpace(resultFilter))
	if rf == "all" {
		rf = ""
	}
	if rf != "" && rf != "success" && rf != "rejected" && rf != "failure" {
		return nil, ErrInvalidInput
	}
	if limit <= 0 {
		limit = 60
	}
	if limit > 200 {
		limit = 200
	}
	return s.repo.ListAdminAuditLogs(ctx, actorID, rf, strings.TrimSpace(query), limit)
}

func (s *Service) UpdateSpacePolicy(ctx context.Context, actorID string, input AdminPolicyUpdateInput) (AdminSpacePolicy, error) {
	if strings.TrimSpace(actorID) == "" {
		return AdminSpacePolicy{}, ErrForbidden
	}
	if input.DailyQuotaBytes < 10*1024*1024 || input.DailyQuotaBytes > 100*1024*1024*1024 {
		return AdminSpacePolicy{}, fmt.Errorf("%w: dailyQuotaBytes must be between 10 MiB and 100 GiB", ErrInvalidInput)
	}
	if input.MessageRetentionCount < 100 || input.MessageRetentionCount > 500000 {
		return AdminSpacePolicy{}, fmt.Errorf("%w: messageRetentionCount must be between 100 and 500000", ErrInvalidInput)
	}
	input.SpaceName = strings.TrimSpace(input.SpaceName)
	return s.repo.UpdateSpacePolicy(ctx, actorID, input, s.now())
}

func (s *Service) CleanupStaleStorage(ctx context.Context, actorID string) (AdminStorageCleanupResult, error) {
	if strings.TrimSpace(actorID) == "" {
		return AdminStorageCleanupResult{}, ErrForbidden
	}
	return s.repo.CleanupStaleStorage(ctx, actorID, s.now())
}

func sanitizeAnnouncementCTAURL(raw string) (string, error) {
	u := strings.TrimSpace(raw)
	if u == "" {
		return "", nil
	}
	if len(u) > 512 {
		return "", fmt.Errorf("%w: 链接长度不能超过 512 个字符", ErrInvalidInput)
	}
	if strings.HasPrefix(u, "/") && !strings.HasPrefix(u, "//") {
		return u, nil
	}
	lower := strings.ToLower(u)
	if strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://") {
		return u, nil
	}
	return "", fmt.Errorf("%w: 跳转链接需以 https://、http:// 或 / 开头", ErrInvalidInput)
}

func (s *Service) GetAdminAnnouncement(ctx context.Context, actorID string) (SystemAnnouncement, error) {
	if strings.TrimSpace(actorID) == "" {
		return SystemAnnouncement{}, ErrForbidden
	}
	return s.repo.GetAdminAnnouncement(ctx, strings.TrimSpace(actorID))
}

func (s *Service) UpdateAdminAnnouncement(ctx context.Context, actorID string, input SystemAnnouncementUpdateInput) (SystemAnnouncement, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return SystemAnnouncement{}, ErrForbidden
	}
	mode := strings.ToLower(strings.TrimSpace(input.DisplayMode))
	if mode == "" {
		mode = "once"
	}
	if mode != "once" && mode != "always" {
		return SystemAnnouncement{}, fmt.Errorf("%w: 展示模式仅支持 once 或 always", ErrInvalidInput)
	}
	title := strings.TrimSpace(input.Title)
	content := strings.TrimSpace(input.Content)
	badge := strings.TrimSpace(input.Badge)
	ctaLabel := strings.TrimSpace(input.CTALabel)
	ctaURL, err := sanitizeAnnouncementCTAURL(input.CTAURL)
	if err != nil {
		return SystemAnnouncement{}, err
	}
	if input.Enabled {
		if title == "" || utf8.RuneCountInString(title) > 80 {
			return SystemAnnouncement{}, fmt.Errorf("%w: 通告标题需为 1-80 个字符", ErrInvalidInput)
		}
		if content == "" || utf8.RuneCountInString(content) > 2000 {
			return SystemAnnouncement{}, fmt.Errorf("%w: 通告正文需为 1-2000 个字符", ErrInvalidInput)
		}
	} else {
		if utf8.RuneCountInString(title) > 80 || utf8.RuneCountInString(content) > 2000 {
			return SystemAnnouncement{}, fmt.Errorf("%w: 通告内容超出长度限制", ErrInvalidInput)
		}
	}
	if utf8.RuneCountInString(badge) > 24 || utf8.RuneCountInString(ctaLabel) > 32 {
		return SystemAnnouncement{}, fmt.Errorf("%w: 角标或按钮文案过长", ErrInvalidInput)
	}

	existing, err := s.repo.GetAdminAnnouncement(ctx, actorID)
	if err != nil {
		return SystemAnnouncement{}, err
	}
	now := s.now()
	annID := strings.TrimSpace(existing.ID)
	if annID == "" || input.ResetAck {
		annID = randomID("ann")
	}
	next := SystemAnnouncement{
		ID:          annID,
		Enabled:     input.Enabled,
		DisplayMode: mode,
		Badge:       badge,
		Title:       title,
		Content:     content,
		CTALabel:    ctaLabel,
		CTAURL:      ctaURL,
		UpdatedAt:   now.UTC().Format(time.RFC3339),
	}
	return s.repo.UpsertAdminAnnouncement(ctx, actorID, next, now)
}

func (s *Service) AckAnnouncement(ctx context.Context, actorID, announcementID string) error {
	actorID = strings.TrimSpace(actorID)
	announcementID = strings.TrimSpace(announcementID)
	if actorID == "" {
		return ErrForbidden
	}
	if announcementID == "" || len(announcementID) > 128 {
		return ErrInvalidInput
	}
	return s.repo.AckAnnouncement(ctx, actorID, announcementID, s.now())
}

func (s *Service) SendBindEmailCode(ctx context.Context, actorID, rawEmail string) (EmailChallengeSummary, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return EmailChallengeSummary{}, ErrForbidden
	}
	if s.emailSender == nil {
		return EmailChallengeSummary{}, fmt.Errorf("%w: 空间尚未开启通知发信邮箱", ErrInvalidInput)
	}
	normalized, err := email.NormalizeEmailAddress(rawEmail)
	if err != nil {
		return EmailChallengeSummary{}, fmt.Errorf("%w: 请输入有效的邮箱地址", ErrInvalidInput)
	}
	existingOwner, err := s.repo.FindBoundEmailOwner(ctx, normalized)
	if err != nil {
		return EmailChallengeSummary{}, err
	}
	if existingOwner != "" && existingOwner != actorID {
		return EmailChallengeSummary{}, ErrEmailAlreadyBound
	}
	now := s.now()
	if err := s.repo.CheckEmailChallengeCooldown(ctx, actorID, now); err != nil {
		return EmailChallengeSummary{}, err
	}
	challengeID := randomID("echl_bind")
	code, err := s.codeGen()
	if err != nil {
		return EmailChallengeSummary{}, err
	}
	codeHash, err := s.emailSender.HashChallengeCode(challengeID, code)
	if err != nil {
		return EmailChallengeSummary{}, err
	}
	if err := s.emailSender.SendVerificationCode(ctx, normalized, code, "bind"); err != nil {
		return EmailChallengeSummary{}, err
	}
	expiresAt := now.Add(email.EmailChallengeTTL)
	if err := s.repo.SaveEmailChallenge(ctx, challengeID, actorID, normalized, codeHash, now, expiresAt); err != nil {
		return EmailChallengeSummary{}, err
	}
	return EmailChallengeSummary{
		ChallengeID:        challengeID,
		MaskedEmail:        email.MaskEmailAddress(normalized),
		ExpiresAt:          expiresAt.UTC().Format(time.RFC3339),
		ResendAfterSeconds: int(email.EmailChallengeResend / time.Second),
	}, nil
}

func (s *Service) VerifyBindEmail(ctx context.Context, actorID, challengeID, code string) (BoundEmailStatus, error) {
	actorID = strings.TrimSpace(actorID)
	challengeID = strings.TrimSpace(challengeID)
	code = strings.TrimSpace(code)
	if actorID == "" {
		return BoundEmailStatus{}, ErrForbidden
	}
	if s.emailSender == nil || !strings.HasPrefix(challengeID, "echl_bind_") || len(code) != 6 {
		return BoundEmailStatus{}, ErrChallengeInvalid
	}
	now := s.now()
	rec, err := s.repo.VerifyAndConsumeEmailChallenge(ctx, challengeID, func(rec EmailChallengeStoreRecord) (bool, error) {
		if rec.UserID != actorID {
			return false, nil
		}
		return s.emailSender.VerifyChallengeCode(rec.CodeHash, rec.ID, code)
	}, now)
	if err != nil {
		return BoundEmailStatus{}, err
	}
	if err := s.repo.BindAccountEmail(ctx, actorID, rec.PendingEmail, now); err != nil {
		return BoundEmailStatus{}, err
	}
	return BoundEmailStatus{
		BoundEmail:  rec.PendingEmail,
		MaskedEmail: email.MaskEmailAddress(rec.PendingEmail),
	}, nil
}

func (s *Service) UnbindAccountEmail(ctx context.Context, actorID string) error {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return ErrForbidden
	}
	return s.repo.UnbindAccountEmail(ctx, actorID, s.now())
}

func (s *Service) SendLoginEmailCode(ctx context.Context, rawEmail string) (EmailChallengeSummary, error) {
	if s.emailSender == nil {
		return EmailChallengeSummary{}, fmt.Errorf("%w: 空间尚未开启通知发信邮箱", ErrInvalidInput)
	}
	normalized, err := email.NormalizeEmailAddress(rawEmail)
	if err != nil {
		return EmailChallengeSummary{}, fmt.Errorf("%w: 请输入有效的邮箱地址", ErrInvalidInput)
	}
	userID, err := s.repo.FindBoundEmailOwner(ctx, normalized)
	if err != nil {
		return EmailChallengeSummary{}, err
	}
	if userID == "" {
		return EmailChallengeSummary{}, ErrEmailNotBound
	}
	now := s.now()
	if err := s.repo.CheckEmailChallengeCooldown(ctx, userID, now); err != nil {
		return EmailChallengeSummary{}, err
	}
	challengeID := randomID("echl_login")
	code, err := s.codeGen()
	if err != nil {
		return EmailChallengeSummary{}, err
	}
	codeHash, err := s.emailSender.HashChallengeCode(challengeID, code)
	if err != nil {
		return EmailChallengeSummary{}, err
	}
	if err := s.emailSender.SendVerificationCode(ctx, normalized, code, "login"); err != nil {
		return EmailChallengeSummary{}, err
	}
	expiresAt := now.Add(email.EmailChallengeTTL)
	if err := s.repo.SaveEmailChallenge(ctx, challengeID, userID, normalized, codeHash, now, expiresAt); err != nil {
		return EmailChallengeSummary{}, err
	}
	return EmailChallengeSummary{
		ChallengeID:        challengeID,
		MaskedEmail:        email.MaskEmailAddress(normalized),
		ExpiresAt:          expiresAt.UTC().Format(time.RFC3339),
		ResendAfterSeconds: int(email.EmailChallengeResend / time.Second),
	}, nil
}

func (s *Service) VerifyLoginEmail(ctx context.Context, rawEmail, challengeID, code string) (V1BootstrapMember, error) {
	challengeID = strings.TrimSpace(challengeID)
	code = strings.TrimSpace(code)
	if s.emailSender == nil || !strings.HasPrefix(challengeID, "echl_login_") || len(code) != 6 {
		return V1BootstrapMember{}, ErrChallengeInvalid
	}
	normalized, err := email.NormalizeEmailAddress(rawEmail)
	if err != nil {
		return V1BootstrapMember{}, ErrChallengeInvalid
	}
	now := s.now()
	rec, err := s.repo.VerifyAndConsumeEmailChallenge(ctx, challengeID, func(rec EmailChallengeStoreRecord) (bool, error) {
		if !strings.EqualFold(rec.PendingEmail, normalized) {
			return false, nil
		}
		return s.emailSender.VerifyChallengeCode(rec.CodeHash, rec.ID, code)
	}, now)
	if err != nil {
		return V1BootstrapMember{}, err
	}
	return s.repo.ResolveEmailLoginMember(ctx, rec.UserID, normalized, now)
}

type embeddedAPKConfig struct {
	Version string `json:"version"`
	Android struct {
		Package     string `json:"package"`
		VersionCode int    `json:"versionCode"`
	} `json:"android"`
}

func inspectAPKBytes(apkBytes []byte) (version string, versionCode int, err error) {
	if len(apkBytes) < 128 {
		return "", 0, fmt.Errorf("%w: 请上传有效的 Android APK 安装包", ErrInvalidInput)
	}
	if int64(len(apkBytes)) > MaxMobileAPKBytes {
		return "", 0, fmt.Errorf("%w: APK 安装包大小不能超过 30 MB", ErrInvalidInput)
	}
	zr, zerr := zip.NewReader(bytes.NewReader(apkBytes), int64(len(apkBytes)))
	if zerr != nil {
		return "", 0, fmt.Errorf("%w: 请上传有效的 Android APK 安装包", ErrInvalidInput)
	}
	hasManifest := false
	hasDex := false
	configCount := 0
	for _, f := range zr.File {
		switch f.Name {
		case "AndroidManifest.xml":
			hasManifest = true
		case "classes.dex":
			hasDex = true
		case "assets/app.config":
			configCount++
			if configCount > 1 {
				return "", 0, fmt.Errorf("%w: APK 包含重复的原生版本信息", ErrInvalidInput)
			}
			if f.UncompressedSize64 > 0 && f.UncompressedSize64 <= 64*1024 {
				rc, openErr := f.Open()
				if openErr == nil {
					rawCfg, readErr := io.ReadAll(io.LimitReader(rc, 64*1024))
					_ = rc.Close()
					if readErr == nil {
						var parsed embeddedAPKConfig
						if json.Unmarshal(rawCfg, &parsed) == nil {
							if pkg := strings.TrimSpace(parsed.Android.Package); pkg != "com.timestarry.duallane" {
								return "", 0, fmt.Errorf("%w: APK 应用包名 (%s) 与 DualLane 不一致", ErrInvalidInput, pkg)
							}
							version = strings.TrimPrefix(strings.TrimSpace(parsed.Version), "v")
							versionCode = parsed.Android.VersionCode
						}
					}
				}
			}
		}
	}
	if !hasManifest || !hasDex {
		return "", 0, fmt.Errorf("%w: 请上传包含完整签名结构的 Android APK 安装包", ErrInvalidInput)
	}
	if configCount != 1 || version == "" || versionCode <= 0 || versionCode > 2100000000 {
		return "", 0, fmt.Errorf("%w: 无法可靠识别 APK 的原生版本信息", ErrInvalidInput)
	}
	return version, versionCode, nil
}

func normalizeSemverString(raw string) (string, error) {
	clean := strings.TrimPrefix(strings.TrimSpace(raw), "v")
	clean = strings.TrimPrefix(clean, "V")
	if clean == "" || len(clean) > 32 {
		return "", fmt.Errorf("%w: 请输入有效的语义化版本号（如 1.0.7）", ErrInvalidInput)
	}
	parts := strings.Split(clean, ".")
	if len(parts) < 2 || len(parts) > 4 {
		return "", fmt.Errorf("%w: 版本号格式无效（示例：1.0.7）", ErrInvalidInput)
	}
	for _, p := range parts {
		if p == "" || len(p) > 8 {
			return "", fmt.Errorf("%w: 版本号格式无效（示例：1.0.7）", ErrInvalidInput)
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return "", fmt.Errorf("%w: 版本号仅允许数字与点号（示例：1.0.7）", ErrInvalidInput)
			}
		}
	}
	return clean, nil
}

func deriveDefaultVersionCode(version string) int {
	parts := strings.Split(version, ".")
	parsePart := func(idx int) int {
		if idx >= len(parts) {
			return 0
		}
		n := 0
		for _, r := range parts[idx] {
			if r >= '0' && r <= '9' {
				n = n*10 + int(r-'0')
			}
		}
		return n
	}
	code := parsePart(0)*10000 + parsePart(1)*100 + parsePart(2)
	if code <= 0 {
		return 1
	}
	return code
}

var allowedOTAExtensions = map[string]bool{
	".html":  true,
	".js":    true,
	".mjs":   true,
	".css":   true,
	".json":  true,
	".svg":   true,
	".png":   true,
	".jpg":   true,
	".jpeg":  true,
	".webp":  true,
	".gif":   true,
	".ico":   true,
	".woff":  true,
	".woff2": true,
	".ttf":   true,
	".txt":   true,
}

func normalizeOTAEntryName(rawName string) (string, bool) {
	cleaned := strings.ReplaceAll(strings.TrimSpace(rawName), "\\", "/")
	cleaned = strings.TrimPrefix(cleaned, "./")
	if cleaned == "" || strings.HasPrefix(cleaned, "/") || strings.Contains(cleaned, "..") {
		return "", false
	}
	norm := path.Clean(cleaned)
	if norm == "." || norm == ".." || strings.HasPrefix(norm, "../") || strings.HasPrefix(norm, "/") {
		return "", false
	}
	if strings.HasPrefix(norm, "assets/www/") {
		norm = strings.TrimPrefix(norm, "assets/www/")
	} else if strings.HasPrefix(norm, "www/") {
		norm = strings.TrimPrefix(norm, "www/")
	}
	if norm == "" || norm == "." {
		return "", false
	}
	return norm, true
}

func inspectAndNormalizeOTAZip(rawBytes []byte, fromFullAPK bool) ([]byte, error) {
	maxCompressed := int64(MaxMobileOTABytes)
	if fromFullAPK {
		maxCompressed = int64(MaxMobileAPKBytes)
	}
	if len(rawBytes) < 64 || int64(len(rawBytes)) > maxCompressed {
		return nil, fmt.Errorf("%w: 请上传有效的移动端前端热更资源包 (.zip)", ErrInvalidInput)
	}
	zr, err := zip.NewReader(bytes.NewReader(rawBytes), int64(len(rawBytes)))
	if err != nil {
		return nil, fmt.Errorf("%w: 热更资源包不是有效的 ZIP 格式", ErrInvalidInput)
	}

	entriesByName := map[string][]byte{}
	var totalUncompressed int64
	const maxUncompressed = 25 * 1024 * 1024

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rawName := strings.ReplaceAll(f.Name, "\\", "/")
		if fromFullAPK && !strings.HasPrefix(rawName, "assets/www/") {
			continue
		}
		norm, ok := normalizeOTAEntryName(rawName)
		if !ok {
			if fromFullAPK {
				continue
			}
			return nil, fmt.Errorf("%w: 热更包包含非法路径 %q", ErrInvalidInput, f.Name)
		}
		ext := strings.ToLower(path.Ext(norm))
		if !allowedOTAExtensions[ext] {
			if fromFullAPK {
				continue
			}
			return nil, fmt.Errorf("%w: 热更包包含不支持的资源后缀 %q", ErrInvalidInput, ext)
		}
		if len(entriesByName) >= 500 {
			return nil, fmt.Errorf("%w: 热更包文件数量超出上限 (500)", ErrInvalidInput)
		}
		if f.UncompressedSize64 > uint64(maxUncompressed) {
			return nil, fmt.Errorf("%w: 热更包单文件体积超出限制", ErrInvalidInput)
		}
		rc, openErr := f.Open()
		if openErr != nil {
			return nil, fmt.Errorf("%w: 读取热更包内容失败", ErrInvalidInput)
		}
		content, readErr := io.ReadAll(io.LimitReader(rc, maxUncompressed+1))
		_ = rc.Close()
		if readErr != nil {
			return nil, fmt.Errorf("%w: 读取热更包内容失败", ErrInvalidInput)
		}
		totalUncompressed += int64(len(content))
		if totalUncompressed > maxUncompressed {
			return nil, fmt.Errorf("%w: 热更包解压后总大小不能超过 25 MB", ErrInvalidInput)
		}
		entriesByName[norm] = content
	}

	indexBytes, hasIndex := entriesByName["index.html"]
	if !hasIndex || len(indexBytes) == 0 {
		return nil, fmt.Errorf("%w: 热更包缺少入口文件 index.html", ErrInvalidInput)
	}

	sortedNames := make([]string, 0, len(entriesByName))
	for k := range entriesByName {
		sortedNames = append(sortedNames, k)
	}
	sort.Strings(sortedNames)

	var outBuf bytes.Buffer
	zw := zip.NewWriter(&outBuf)
	fixedTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, name := range sortedNames {
		hdr := &zip.FileHeader{
			Name:     name,
			Method:   zip.Deflate,
			Modified: fixedTime,
		}
		w, werr := zw.CreateHeader(hdr)
		if werr != nil {
			_ = zw.Close()
			return nil, fmt.Errorf("create ota zip entry: %w", werr)
		}
		if _, werr := w.Write(entriesByName[name]); werr != nil {
			_ = zw.Close()
			return nil, fmt.Errorf("write ota zip entry: %w", werr)
		}
	}
	if cerr := zw.Close(); cerr != nil {
		return nil, fmt.Errorf("finalize ota zip: %w", cerr)
	}
	return outBuf.Bytes(), nil
}

func (s *Service) GetPublicMobileRelease(ctx context.Context) (MobileClientRelease, error) {
	return s.repo.GetPublicMobileRelease(ctx)
}

func (s *Service) GetMobileNativePolicy(ctx context.Context) (mobileruntime.Policy, error) {
	release, err := s.repo.GetPublicMobileRelease(ctx)
	if errors.Is(err, ErrNotFound) {
		return mobileruntime.Policy{}, nil
	}
	if err != nil {
		return mobileruntime.Policy{}, err
	}
	return mobileruntime.Policy{
		MinimumSupportedNativeVersionCode: release.MinimumSupportedNativeVersionCode,
		LatestNativeVersionCode:           release.VersionCode,
		APKURL:                            "/api/v1/mobile/android/latest.apk",
	}, nil
}

func (s *Service) OpenPublicMobileAPK(ctx context.Context) (MobileClientRelease, io.ReadCloser, error) {
	if s.blobStore == nil {
		return MobileClientRelease{}, nil, ErrNotFound
	}
	rel, err := s.repo.GetPublicMobileRelease(ctx)
	if err != nil {
		return MobileClientRelease{}, nil, err
	}
	if rel.SHA256 == "" || rel.ByteSize <= 0 {
		return MobileClientRelease{}, nil, ErrNotFound
	}
	key, err := platformstorage.CanonicalObjectKey(rel.SHA256)
	if err != nil {
		return MobileClientRelease{}, nil, ErrNotFound
	}
	opened, err := s.blobStore.Open(ctx, platformstorage.Object{
		Key:      key,
		SHA256:   rel.SHA256,
		ByteSize: rel.ByteSize,
	}, MaxMobileAPKBytes+1024*1024)
	if err != nil {
		return MobileClientRelease{}, nil, ErrNotFound
	}
	return rel, opened.Body, nil
}

func (s *Service) OpenPublicMobileOTA(ctx context.Context) (MobileOTABundle, io.ReadCloser, error) {
	if s.blobStore == nil {
		return MobileOTABundle{}, nil, ErrNotFound
	}
	rel, err := s.repo.GetPublicMobileRelease(ctx)
	if err != nil {
		return MobileOTABundle{}, nil, err
	}
	if rel.OTA == nil || !rel.OTA.Enabled || rel.OTA.SHA256 == "" || rel.OTA.ByteSize <= 0 {
		return MobileOTABundle{}, nil, ErrNotFound
	}
	key, err := platformstorage.CanonicalObjectKey(rel.OTA.SHA256)
	if err != nil {
		return MobileOTABundle{}, nil, ErrNotFound
	}
	opened, err := s.blobStore.Open(ctx, platformstorage.Object{
		Key:      key,
		SHA256:   rel.OTA.SHA256,
		ByteSize: rel.OTA.ByteSize,
	}, MaxMobileOTABytes+1024*1024)
	if err != nil {
		return MobileOTABundle{}, nil, ErrNotFound
	}
	return *rel.OTA, opened.Body, nil
}

func (s *Service) GetAdminMobileRelease(ctx context.Context, actorID string) (MobileClientRelease, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return MobileClientRelease{}, ErrForbidden
	}
	return s.repo.GetAdminMobileRelease(ctx, actorID)
}

func (s *Service) UploadAdminMobileAPK(ctx context.Context, actorID string, apkBytes []byte, overrideVersion string, overrideVersionCode int, minNativeVersionCode ...int) (MobileClientRelease, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return MobileClientRelease{}, ErrForbidden
	}
	if s.blobStore == nil {
		return MobileClientRelease{}, fmt.Errorf("%w: 对象存储服务未就绪", ErrInvalidInput)
	}
	existing, err := s.repo.GetAdminMobileRelease(ctx, actorID)
	if err != nil {
		return MobileClientRelease{}, err
	}

	detectedVersion, detectedCode, err := inspectAPKBytes(apkBytes)
	if err != nil {
		return MobileClientRelease{}, err
	}
	detectedVersion, err = normalizeSemverString(detectedVersion)
	if err != nil {
		return MobileClientRelease{}, err
	}
	if strings.TrimSpace(overrideVersion) != "" {
		override, versionErr := normalizeSemverString(overrideVersion)
		if versionErr != nil {
			return MobileClientRelease{}, versionErr
		}
		if override != detectedVersion {
			return MobileClientRelease{}, fmt.Errorf("%w: 声明版本与 APK 原生版本不一致", ErrInvalidInput)
		}
	}
	if overrideVersionCode > 0 && overrideVersionCode != detectedCode {
		return MobileClientRelease{}, fmt.Errorf("%w: 声明版本号与 APK 原生版本号不一致", ErrInvalidInput)
	}

	version := detectedVersion
	versionCode := detectedCode
	if existing.MinimumSupportedNativeVersionCode > versionCode {
		return MobileClientRelease{}, fmt.Errorf("%w: 安装包低于当前最低可用原生版本", ErrInvalidInput)
	}

	sum := sha256.Sum256(apkBytes)
	shaHex := hex.EncodeToString(sum[:])
	key, err := platformstorage.CanonicalObjectKey(shaHex)
	if err != nil {
		return MobileClientRelease{}, err
	}
	if _, err := s.blobStore.Put(ctx, key, bytes.NewReader(apkBytes), int64(len(apkBytes)), shaHex); err != nil {
		return MobileClientRelease{}, err
	}

	now := s.now()
	nowStr := now.UTC().Format(time.RFC3339)
	title := strings.TrimSpace(existing.Title)
	if title == "" || strings.HasPrefix(title, "DualLane Android v") || strings.HasPrefix(title, "DualLane Mobile v") {
		title = "DualLane Android v" + version
	}

	resolvedMinNative := versionCode
	if len(minNativeVersionCode) > 0 && minNativeVersionCode[0] > 0 {
		resolvedMinNative = minNativeVersionCode[0]
	}

	var otaBundle *MobileOTABundle
	if otaZipBytes, otaErr := inspectAndNormalizeOTAZip(apkBytes, true); otaErr == nil && len(otaZipBytes) > 0 {
		otaSum := sha256.Sum256(otaZipBytes)
		otaShaHex := hex.EncodeToString(otaSum[:])
		if otaKey, kerr := platformstorage.CanonicalObjectKey(otaShaHex); kerr == nil {
			if _, perr := s.blobStore.Put(ctx, otaKey, bytes.NewReader(otaZipBytes), int64(len(otaZipBytes)), otaShaHex); perr == nil {
				otaBundle = &MobileOTABundle{
					Enabled:              true,
					Version:              version,
					BundleID:             otaShaHex[:12],
					MinNativeVersionCode: resolvedMinNative,
					ByteSize:             int64(len(otaZipBytes)),
					SHA256:               otaShaHex,
					DownloadURL:          "/api/v1/mobile/android/latest-ota.zip",
					PublishedAt:          nowStr,
				}
			}
		}
	}

	next := MobileClientRelease{
		Enabled:                           true,
		Version:                           version,
		VersionCode:                       versionCode,
		APKVersion:                        version,
		MinimumSupportedNativeVersionCode: existing.MinimumSupportedNativeVersionCode,
		TagName:                           "v" + version,
		Title:                             title,
		Notes:                             existing.Notes,
		FileName:                          fmt.Sprintf("duallane-v%s.apk", version),
		ByteSize:                          int64(len(apkBytes)),
		SHA256:                            shaHex,
		DownloadURL:                       "/api/v1/mobile/android/latest.apk",
		PublishedAt:                       nowStr,
		OTA:                               otaBundle,
	}
	return s.repo.UpsertAdminMobileRelease(ctx, actorID, next, now)
}

func (s *Service) UploadAdminMobileOTA(ctx context.Context, actorID string, rawZipBytes []byte, overrideVersion string, minNativeVersionCode int) (MobileClientRelease, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return MobileClientRelease{}, ErrForbidden
	}
	if s.blobStore == nil {
		return MobileClientRelease{}, fmt.Errorf("%w: 对象存储服务未就绪", ErrInvalidInput)
	}
	existing, err := s.repo.GetAdminMobileRelease(ctx, actorID)
	if err != nil {
		return MobileClientRelease{}, err
	}

	rawVer := strings.TrimSpace(overrideVersion)
	if rawVer == "" {
		rawVer = existing.Version
	}
	if rawVer == "" {
		return MobileClientRelease{}, fmt.Errorf("%w: 发布热更包时请指定目标版本号（如 1.0.10）", ErrInvalidInput)
	}
	version, err := normalizeSemverString(rawVer)
	if err != nil {
		return MobileClientRelease{}, err
	}

	normalizedZip, err := inspectAndNormalizeOTAZip(rawZipBytes, false)
	if err != nil {
		return MobileClientRelease{}, err
	}
	otaSum := sha256.Sum256(normalizedZip)
	otaShaHex := hex.EncodeToString(otaSum[:])
	otaKey, err := platformstorage.CanonicalObjectKey(otaShaHex)
	if err != nil {
		return MobileClientRelease{}, err
	}
	if _, err := s.blobStore.Put(ctx, otaKey, bytes.NewReader(normalizedZip), int64(len(normalizedZip)), otaShaHex); err != nil {
		return MobileClientRelease{}, err
	}

	resolvedMinNative := minNativeVersionCode
	if resolvedMinNative <= 0 {
		if existing.OTA != nil && existing.OTA.MinNativeVersionCode > 0 {
			resolvedMinNative = existing.OTA.MinNativeVersionCode
		} else if existing.VersionCode > 0 {
			resolvedMinNative = existing.VersionCode
		} else {
			resolvedMinNative = 10009
		}
	}

	now := s.now()
	nowStr := now.UTC().Format(time.RFC3339)
	title := strings.TrimSpace(existing.Title)
	if title == "" || strings.HasPrefix(title, "DualLane Android v") || strings.HasPrefix(title, "DualLane Mobile v") {
		title = "DualLane Android v" + version
	}

	apkVersionCode := existing.VersionCode
	if apkVersionCode <= 0 {
		apkVersionCode = resolvedMinNative
	}
	apkFileName := existing.FileName
	if apkFileName == "" {
		apkFileName = fmt.Sprintf("duallane-v%s.apk", version)
	}
	apkVersion := existing.APKVersion
	if apkVersion == "" {
		apkVersion = existing.Version
	}

	next := MobileClientRelease{
		Enabled:                           true,
		Version:                           version,
		VersionCode:                       apkVersionCode,
		APKVersion:                        apkVersion,
		MinimumSupportedNativeVersionCode: existing.MinimumSupportedNativeVersionCode,
		TagName:                           "v" + version,
		Title:                             title,
		Notes:                             existing.Notes,
		FileName:                          apkFileName,
		ByteSize:                          existing.ByteSize,
		SHA256:                            existing.SHA256,
		DownloadURL:                       "/api/v1/mobile/android/latest.apk",
		PublishedAt:                       nowStr,
		OTA: &MobileOTABundle{
			Enabled:              true,
			Version:              version,
			BundleID:             otaShaHex[:12],
			MinNativeVersionCode: resolvedMinNative,
			ByteSize:             int64(len(normalizedZip)),
			SHA256:               otaShaHex,
			DownloadURL:          "/api/v1/mobile/android/latest-ota.zip",
			PublishedAt:          nowStr,
		},
	}
	return s.repo.UpsertAdminMobileRelease(ctx, actorID, next, now)
}

func (s *Service) UpdateAdminMobileRelease(ctx context.Context, actorID string, input MobileClientReleaseMetadataInput) (MobileClientRelease, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return MobileClientRelease{}, ErrForbidden
	}
	existing, err := s.repo.GetAdminMobileRelease(ctx, actorID)
	if err != nil {
		return MobileClientRelease{}, err
	}
	hasAPK := existing.SHA256 != "" && existing.ByteSize > 0
	hasOTA := existing.OTA != nil && existing.OTA.SHA256 != "" && existing.OTA.ByteSize > 0
	if input.Enabled && !hasAPK && !hasOTA {
		return MobileClientRelease{}, fmt.Errorf("%w: 请先上传签名 APK 或前端热更包后再开启分发", ErrInvalidInput)
	}
	if hasAPK && input.VersionCode > 0 && input.VersionCode != existing.VersionCode {
		return MobileClientRelease{}, fmt.Errorf("%w: 原生版本号必须与已上传安装包一致，请上传新版 APK", ErrInvalidInput)
	}

	version := existing.Version
	if strings.TrimSpace(input.Version) != "" {
		v, verr := normalizeSemverString(input.Version)
		if verr != nil {
			return MobileClientRelease{}, verr
		}
		version = v
	}
	versionCode := input.VersionCode
	if versionCode <= 0 {
		versionCode = existing.VersionCode
	}
	if versionCode <= 0 && version != "" {
		versionCode = deriveDefaultVersionCode(version)
	}
	minimumNative := existing.MinimumSupportedNativeVersionCode
	if input.MinimumSupportedNativeVersionCode != nil {
		minimumNative = *input.MinimumSupportedNativeVersionCode
	}
	if minimumNative < 0 || minimumNative > 2100000000 || (minimumNative > 0 && (!input.Enabled || !hasAPK || minimumNative > versionCode)) {
		return MobileClientRelease{}, fmt.Errorf("%w: 最低可用原生版本必须可由当前启用的安装包满足", ErrInvalidInput)
	}

	title := strings.TrimSpace(input.Title)
	if utf8.RuneCountInString(title) > 80 {
		return MobileClientRelease{}, fmt.Errorf("%w: 版本标题不能超过 80 个字符", ErrInvalidInput)
	}
	if title == "" && version != "" {
		title = "DualLane Android v" + version
	}
	notes := strings.TrimSpace(input.Notes)
	if utf8.RuneCountInString(notes) > 4000 {
		return MobileClientRelease{}, fmt.Errorf("%w: 更新说明不能超过 4000 个字符", ErrInvalidInput)
	}

	now := s.now()
	publishedAt := existing.PublishedAt
	if publishedAt == "" && (hasAPK || hasOTA) {
		publishedAt = now.UTC().Format(time.RFC3339)
	}
	fileName := existing.FileName
	if fileName == "" && version != "" {
		fileName = fmt.Sprintf("duallane-v%s.apk", version)
	}
	tagName := existing.TagName
	if version != "" {
		tagName = "v" + version
	}

	var nextOTA *MobileOTABundle
	if existing.OTA != nil {
		copied := *existing.OTA
		if version != "" {
			copied.Version = version
		}
		if input.MinNativeVersionCode > 0 {
			copied.MinNativeVersionCode = input.MinNativeVersionCode
		}
		if input.OTAEnabled != nil {
			copied.Enabled = *input.OTAEnabled
		}
		nextOTA = &copied
	}

	next := MobileClientRelease{
		Enabled:                           input.Enabled,
		Version:                           version,
		VersionCode:                       versionCode,
		APKVersion:                        existing.APKVersion,
		MinimumSupportedNativeVersionCode: minimumNative,
		TagName:                           tagName,
		Title:                             title,
		Notes:                             notes,
		FileName:                          fileName,
		ByteSize:                          existing.ByteSize,
		SHA256:                            existing.SHA256,
		DownloadURL:                       "/api/v1/mobile/android/latest.apk",
		PublishedAt:                       publishedAt,
		OTA:                               nextOTA,
	}
	return s.repo.UpsertAdminMobileRelease(ctx, actorID, next, now)
}

func randomID(prefix string) string {
	var buf [12]byte
	_, _ = rand.Read(buf[:])
	return prefix + "_" + hex.EncodeToString(buf[:])
}
