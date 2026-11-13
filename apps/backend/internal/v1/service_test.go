package v1

import (
	"context"
	"testing"
	"time"
)

type stubRepo struct {
	commands []BotCommand
	savedID  string
}

func (s *stubRepo) SyncDelta(_ context.Context, _ string, sinceSeq int64, _ int) (SyncDeltaResponse, error) {
	return SyncDeltaResponse{CurrentSeq: sinceSeq + 2, HasMore: false, Events: []SyncEvent{{Seq: sinceSeq + 1, Type: "message.created"}}}, nil
}
func (s *stubRepo) Search(_ context.Context, _, _, _ string, _ int) (SearchResponse, error) {
	return SearchResponse{Messages: []SearchMessageHit{{ID: "msg_1", PlainText: "hello"}}, Files: []SearchFileHit{}}, nil
}
func (s *stubRepo) GetOrCreateSavedConversation(_ context.Context, _ string, _ time.Time) (string, error) {
	if s.savedID == "" {
		s.savedID = "conv_saved_1"
	}
	return s.savedID, nil
}
func (s *stubRepo) EditMessage(_ context.Context, _, _, _ string, _ time.Time) error { return nil }
func (s *stubRepo) ForwardMessages(_ context.Context, _, _ string, ids []string, _ time.Time) ([]string, error) {
	return ids, nil
}
func (s *stubRepo) GetThread(_ context.Context, _, rootID string) (ThreadView, error) {
	return ThreadView{RootMessageID: rootID, ReplyCount: 1, Replies: []ThreadReply{{ID: "msg_r1", ThreadRootID: rootID}}}, nil
}
func (s *stubRepo) ReplyThread(_ context.Context, actorID, rootID, text, _ string, also bool, now time.Time) (ThreadReply, error) {
	return ThreadReply{ID: "msg_r2", ThreadRootID: rootID, AuthorID: actorID, PlainText: text, AlsoSendToChannel: also, CreatedAt: now.Format(time.RFC3339)}, nil
}
func (s *stubRepo) PinMessage(_ context.Context, _, _, _ string, _ time.Time) error { return nil }
func (s *stubRepo) UnpinMessage(_ context.Context, _, _, _ string) error            { return nil }
func (s *stubRepo) ListDevices(_ context.Context, _, _ string) ([]UserDevice, error) {
	return []UserDevice{{ID: "dev_1", Platform: "ios", DeviceName: "iPhone 16"}}, nil
}
func (s *stubRepo) RevokeDevice(_ context.Context, _, _ string, _ time.Time) error { return nil }
func (s *stubRepo) CreateQRSession(_ context.Context, platform, deviceName string, now time.Time) (QRLoginSession, error) {
	return QRLoginSession{ID: "qr_1", Challenge: "chl_1", Status: "pending", Platform: platform, DeviceName: deviceName, ExpiresAt: now.Add(5 * time.Minute).Format(time.RFC3339)}, nil
}
func (s *stubRepo) ApproveQRSession(_ context.Context, _, id string, _ time.Time) (QRLoginSession, error) {
	return QRLoginSession{ID: id, Status: "approved"}, nil
}
func (s *stubRepo) ExchangeQRSession(_ context.Context, _, _ string, _ time.Time) (string, error) {
	return "dlm_token_123", nil
}
func (s *stubRepo) GetPreferences(_ context.Context, _ string) (map[string]any, error) {
	return map[string]any{"enterToSend": true}, nil
}
func (s *stubRepo) SavePreferences(_ context.Context, _ string, _ map[string]any, _ time.Time) error {
	return nil
}
func (s *stubRepo) RegisterBotCommands(_ context.Context, _, _ string, commands []BotCommand, _ time.Time) error {
	s.commands = commands
	return nil
}
func (s *stubRepo) ListBotCommands(_ context.Context, _ string) ([]BotCommand, error) {
	return s.commands, nil
}
func (s *stubRepo) ListBotCommandsByBot(_ context.Context, _, _ string) ([]BotCommand, error) {
	return s.commands, nil
}
func (s *stubRepo) CreateMultiBot(_ context.Context, _, _ string, _ time.Time) (string, error) {
	return "bot_multi_1", nil
}
func (s *stubRepo) UpsertBotWebhook(_ context.Context, _, botID, url, _ string, enabled bool, _ time.Time) (BotWebhookConfig, error) {
	return BotWebhookConfig{BotID: botID, URL: url, Enabled: enabled}, nil
}

func TestValidateCardKitDocumentAllowsArbitraryActionIDs(t *testing.T) {
	doc := CardKitDocument{
		Version:      1,
		CardID:       "card_1",
		CardType:     "echo.solicitation",
		Status:       "active",
		Revision:     1,
		FallbackText: "需求征集",
		Blocks: []CardKitBlock{
			{Type: "header", Title: "v1.0 新特性投票", Badge: "进行中", Tone: "shared"},
			{Type: "markdown", Content: "请选择你最期待的功能"},
			{Type: "poll", PollID: "poll_1", Options: []map[string]any{{"id": "a", "label": "毛玻璃"}, {"id": "b", "label": "线程话题"}}},
			{Type: "actions", Elements: []map[string]any{{"type": "button", "actionId": "approve_proposal", "label": "批准并回复", "opensModal": true}}},
		},
	}
	if err := ValidateCardKitDocument(doc); err != nil {
		t.Fatalf("expected valid CardKitDocument, got error: %v", err)
	}
}

func TestSignWebhookDeliveryDeterministic(t *testing.T) {
	ts := time.Unix(1700000000, 0).UTC()
	sig1 := SignWebhookDelivery("super-secret-key-1234", ts, []byte(`{"event":"message.created"}`))
	sig2 := SignWebhookDelivery("super-secret-key-1234", ts, []byte(`{"event":"message.created"}`))
	if sig1 != sig2 || len(sig1) < 20 {
		t.Fatalf("expected deterministic sha256 signature, got %q vs %q", sig1, sig2)
	}
}

func TestServiceBotCommandsNormalizationAndWebhookValidation(t *testing.T) {
	repo := &stubRepo{}
	svc := NewService(repo)
	err := svc.RegisterBotCommands(context.Background(), "usr_1", "bot_1", []BotCommand{
		{Command: "/Summarize", Description: "总结当前话题"},
	})
	if err != nil {
		t.Fatalf("register commands failed: %v", err)
	}
	if len(repo.commands) != 1 || repo.commands[0].Command != "summarize" || repo.commands[0].Scope != "all" {
		t.Fatalf("unexpected normalized commands: %+v", repo.commands)
	}

	if _, err := svc.UpsertBotWebhook(context.Background(), "usr_1", "bot_1", "http://evil.example.com", "short", true); err == nil {
		t.Fatal("expected error for non-https URL and short secret")
	}
	cfg, err := svc.UpsertBotWebhook(context.Background(), "usr_1", "bot_1", "https://bot.example.com/hook", "very-strong-secret-012345", true)
	if err != nil || !cfg.Enabled {
		t.Fatalf("expected valid webhook config, got %+v err=%v", cfg, err)
	}
}
