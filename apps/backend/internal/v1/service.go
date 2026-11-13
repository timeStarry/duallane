package v1

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

type Repository interface {
	SyncDelta(ctx context.Context, actorID string, sinceSeq int64, limit int) (SyncDeltaResponse, error)
	Search(ctx context.Context, actorID, query, scope string, limit int) (SearchResponse, error)
	GetOrCreateSavedConversation(ctx context.Context, actorID string, now time.Time) (string, error)
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
	ListBotCommands(ctx context.Context, conversationID string) ([]BotCommand, error)
	UpsertBotWebhook(ctx context.Context, actorID, botID, url, secretHash string, enabled bool, now time.Time) (BotWebhookConfig, error)
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

func (s *Service) ListBotCommands(ctx context.Context, conversationID string) ([]BotCommand, error) {
	return s.repo.ListBotCommands(ctx, conversationID)
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

func randomID(prefix string) string {
	var buf [12]byte
	_, _ = rand.Read(buf[:])
	return prefix + "_" + hex.EncodeToString(buf[:])
}
