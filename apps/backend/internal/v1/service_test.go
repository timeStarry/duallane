package v1

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type stubRepo struct {
	commands []BotCommand
	savedID  string
	group    GroupConversationSummary
}

func (s *stubRepo) GetBootstrap(_ context.Context, actorID string, _ time.Time) (V1BootstrapResponse, error) {
	return V1BootstrapResponse{
		Auth: V1BootstrapAuth{
			Enabled:     true,
			CurrentUser: V1BootstrapMember{ID: actorID, DisplayName: "测试成员", Kind: "human", Role: "member"},
		},
		Policy:      V1BootstrapPolicy{DailyQuotaBytes: 2147483648, UsedTodayBytes: 1024},
		Preferences: map[string]any{"pinnedConversationIds": []string{"conv_saved_1"}},
		Members:     []V1BootstrapMember{{ID: actorID, DisplayName: "测试成员", Kind: "human", Role: "member"}},
		Conversations: []V1BootstrapConversation{{
			ID:               "conv_saved_1",
			Type:             "saved",
			Title:            "个人空间",
			DisplayTitle:     "我的收藏",
			PinnedMessageIDs: []string{},
			MemberIDs:        []string{actorID},
		}},
		EventCursor: 42,
	}, nil
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
func (s *stubRepo) CreateGroupConversation(_ context.Context, actorID string, input CreateGroupInput, now time.Time) (GroupConversationSummary, error) {
	members := append([]string{actorID}, input.MemberIDs...)
	s.group = GroupConversationSummary{
		ID:          "conv_grp_1",
		Type:        "group",
		Title:       input.Title,
		AvatarEmoji: input.Avatar,
		MemberIDs:   members,
		CreatedAt:   now.Format(time.RFC3339),
	}
	return s.group, nil
}
func (s *stubRepo) UpdateGroupConversation(_ context.Context, _, convID string, input UpdateGroupInput, _ time.Time) (GroupConversationSummary, error) {
	if s.group.ID == "" {
		s.group = GroupConversationSummary{ID: convID, Type: "group", Title: "默认群聊"}
	}
	if input.TitleSet && input.Title != nil {
		s.group.Title = *input.Title
	}
	if input.AvatarSet {
		s.group.AvatarEmoji = input.Avatar
	}
	return s.group, nil
}
func (s *stubRepo) AddGroupMembers(_ context.Context, _, convID string, userIDs []string, _ time.Time) (GroupConversationSummary, error) {
	if s.group.ID == "" {
		s.group = GroupConversationSummary{ID: convID, Type: "group", Title: "默认群聊"}
	}
	s.group.MemberIDs = append(s.group.MemberIDs, userIDs...)
	return s.group, nil
}
func (s *stubRepo) LeaveGroupConversation(_ context.Context, _, _ string, _ time.Time) error {
	return nil
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
func (s *stubRepo) GetAdminOverview(_ context.Context, _ string, _ time.Time) (AdminOverviewResponse, error) {
	return AdminOverviewResponse{
		Space:      AdminSpaceSummary{ID: "spc_default", Name: "DualLane"},
		Policy:     AdminSpacePolicy{DailyQuotaBytes: 2147483648, MessageRetentionCount: 10000},
		ViewerRole: "owner",
	}, nil
}
func (s *stubRepo) ListAdminInvites(_ context.Context, _ string, _ time.Time) (AdminInviteListResponse, error) {
	return AdminInviteListResponse{Total: 1, Active: 1, Invites: []AdminInviteItem{{ID: "inv_1", Status: "active"}}}, nil
}
func (s *stubRepo) ListAdminAuditLogs(_ context.Context, _, _, _ string, _ int) ([]AdminAuditLogItem, error) {
	return []AdminAuditLogItem{{ID: "aud_1", Action: "invite.create", Result: "success"}}, nil
}
func (s *stubRepo) UpdateSpacePolicy(_ context.Context, _ string, input AdminPolicyUpdateInput, now time.Time) (AdminSpacePolicy, error) {
	return AdminSpacePolicy{
		DailyQuotaBytes:       input.DailyQuotaBytes,
		MessageRetentionCount: input.MessageRetentionCount,
		UpdatedAt:             now.Format(time.RFC3339),
	}, nil
}
func (s *stubRepo) CleanupStaleStorage(_ context.Context, _ string, _ time.Time) (AdminStorageCleanupResult, error) {
	return AdminStorageCleanupResult{ReleasedTransfers: 1, CleanedAttachments: 1}, nil
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

func TestAdminPolicyValidationAndAuditFilter(t *testing.T) {
	repo := &stubRepo{}
	svc := NewService(repo)

	if _, err := svc.UpdateSpacePolicy(context.Background(), "usr_owner", AdminPolicyUpdateInput{
		DailyQuotaBytes:       1024,
		MessageRetentionCount: 10000,
	}); err == nil {
		t.Fatal("expected error for tiny dailyQuotaBytes")
	}

	if _, err := svc.ListAdminAuditLogs(context.Background(), "usr_owner", "invalid_status", "", 20); err == nil {
		t.Fatal("expected error for invalid audit result filter")
	}

	policy, err := svc.UpdateSpacePolicy(context.Background(), "usr_owner", AdminPolicyUpdateInput{
		SpaceName:             "DualLane Studio",
		DailyQuotaBytes:       5 * 1024 * 1024 * 1024,
		MessageRetentionCount: 20000,
	})
	if err != nil || policy.MessageRetentionCount != 20000 {
		t.Fatalf("expected valid policy update, got %+v err=%v", policy, err)
	}
}

type stubActorResolver struct {
	actor *auth.Actor
}

func (s stubActorResolver) ResolveActor(context.Context, *http.Request) (*auth.Actor, error) {
	return s.actor, nil
}

func TestAdminHTTPHandlerRejectsOrdinaryMember(t *testing.T) {
	svc := NewService(&stubRepo{})

	for _, tc := range []struct {
		name       string
		role       string
		wantStatus int
	}{
		{name: "member forbidden", role: "member", wantStatus: http.StatusForbidden},
		{name: "auditor forbidden", role: "auditor", wantStatus: http.StatusForbidden},
		{name: "admin allowed", role: "admin", wantStatus: http.StatusOK},
		{name: "owner allowed", role: "owner", wantStatus: http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := chi.NewRouter()
			h := NewHTTPHandler(svc, stubActorResolver{
				actor: &auth.Actor{ID: "usr_" + tc.role, Role: tc.role, DisplayName: tc.role},
			})
			h.Mount(r)

			for _, path := range []string{"/api/v1/admin/overview", "/api/v1/admin/invites", "/api/v1/admin/audit-logs"} {
				req := httptest.NewRequest(http.MethodGet, path, nil)
				rec := httptest.NewRecorder()
				r.ServeHTTP(rec, req)
				if rec.Code != tc.wantStatus {
					t.Fatalf("%s for role %q: got status %d, want %d (body=%s)", path, tc.role, rec.Code, tc.wantStatus, rec.Body.String())
				}
			}
		})
	}
}

func TestPeerEqualGroupManagementRoutesAndAvatarValidation(t *testing.T) {
	repo := &stubRepo{}
	svc := NewService(repo)
	r := chi.NewRouter()
	// Ordinary member (not owner/admin) has full peer-equal group controls
	h := NewHTTPHandler(svc, stubActorResolver{
		actor: &auth.Actor{ID: "usr_member_1", Role: "member", DisplayName: "Alice"},
	})
	h.Mount(r)

	// 1. Create group with emoji avatar
	createReq := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/conversations/groups",
		bytes.NewBufferString(`{"title":"产品共创组","memberIds":["usr_member_2","usr_member_1"],"avatar":"🚀"}`),
	)
	createRec := httptest.NewRecorder()
	r.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 on group create by ordinary member, got %d: %s", createRec.Code, createRec.Body.String())
	}

	// 2. Patch group name and custom workspace file preview avatar
	patchReq := httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/conversations/conv_grp_1",
		bytes.NewBufferString(`{"title":"DualLane 共创群","avatar":"/api/workspace/files/att_img_99/preview"}`),
	)
	patchRec := httptest.NewRecorder()
	r.ServeHTTP(patchRec, patchReq)
	if patchRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on group patch, got %d: %s", patchRec.Code, patchRec.Body.String())
	}
	var patchResp struct {
		Conversation GroupConversationSummary `json:"conversation"`
	}
	if err := json.Unmarshal(patchRec.Body.Bytes(), &patchResp); err != nil {
		t.Fatalf("unmarshal patch response: %v", err)
	}
	if patchResp.Conversation.Title != "DualLane 共创群" || patchResp.Conversation.AvatarEmoji == nil || *patchResp.Conversation.AvatarEmoji != "/api/workspace/files/att_img_99/preview" {
		t.Fatalf("unexpected patched conversation: %+v", patchResp.Conversation)
	}

	// 3. Reject SSRF / external URL, path traversal, and plain ASCII avatar
	for _, badAvatar := range []string{
		`https://evil.example.com/avatar.png`,
		`/api/workspace/files/../secret/preview`,
		`plain_ascii_text`,
	} {
		badBody, _ := json.Marshal(map[string]string{"avatar": badAvatar})
		badReq := httptest.NewRequest(http.MethodPatch, "/api/v1/conversations/conv_grp_1", bytes.NewReader(badBody))
		badRec := httptest.NewRecorder()
		r.ServeHTTP(badRec, badReq)
		if badRec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for invalid avatar %q, got %d", badAvatar, badRec.Code)
		}
	}

	// 4. Reset group avatar via null
	resetReq := httptest.NewRequest(http.MethodPatch, "/api/v1/conversations/conv_grp_1", bytes.NewBufferString(`{"avatar":null}`))
	resetRec := httptest.NewRecorder()
	r.ServeHTTP(resetRec, resetReq)
	if resetRec.Code != http.StatusOK || repo.group.AvatarEmoji != nil {
		t.Fatalf("expected avatar reset to nil, got code=%d avatar=%v", resetRec.Code, repo.group.AvatarEmoji)
	}

	// 5. Invite members & leave group
	invReq := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/conv_grp_1/members", bytes.NewBufferString(`{"userIds":["usr_member_3"]}`))
	invRec := httptest.NewRecorder()
	r.ServeHTTP(invRec, invReq)
	if invRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on member invite, got %d: %s", invRec.Code, invRec.Body.String())
	}

	leaveReq := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/conv_grp_1/leave", nil)
	leaveRec := httptest.NewRecorder()
	r.ServeHTTP(leaveRec, leaveReq)
	if leaveRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on group leave, got %d: %s", leaveRec.Code, leaveRec.Body.String())
	}
}

func TestHTTPHandlerBootstrapEndpoint(t *testing.T) {
	repo := &stubRepo{}
	svc := NewService(repo)
	handler := NewHTTPHandler(svc, stubActorResolver{actor: &auth.Actor{ID: "usr_fast_1", Kind: "human", Role: "member"}})
	r := chi.NewRouter()
	handler.Mount(r)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /api/v1/bootstrap, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp V1BootstrapResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal /api/v1/bootstrap: %v", err)
	}
	if !resp.Auth.Enabled || resp.Auth.CurrentUser.ID != "usr_fast_1" || len(resp.Conversations) != 1 || resp.EventCursor != 42 {
		t.Fatalf("unexpected bootstrap payload: %+v", resp)
	}
}
