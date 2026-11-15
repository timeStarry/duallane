package v1

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

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
	GetAdminOverview(ctx context.Context, actorID string, now time.Time) (AdminOverviewResponse, error)
	ListAdminInvites(ctx context.Context, actorID string, now time.Time) (AdminInviteListResponse, error)
	ListAdminAuditLogs(ctx context.Context, actorID, resultFilter, query string, limit int) ([]AdminAuditLogItem, error)
	UpdateSpacePolicy(ctx context.Context, actorID string, input AdminPolicyUpdateInput, now time.Time) (AdminSpacePolicy, error)
	CleanupStaleStorage(ctx context.Context, actorID string, now time.Time) (AdminStorageCleanupResult, error)
}

type Service struct {
	repo Repository
	now  func() time.Time
}

func NewService(repo Repository) *Service {
	return &Service{
		repo: repo,
		now:  func() time.Time { return time.Now().UTC() },
	}
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

func randomID(prefix string) string {
	var buf [12]byte
	_, _ = rand.Read(buf[:])
	return prefix + "_" + hex.EncodeToString(buf[:])
}
