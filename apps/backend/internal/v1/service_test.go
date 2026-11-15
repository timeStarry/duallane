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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
)

type stubRepo struct {
	commands       []BotCommand
	savedID        string
	group          GroupConversationSummary
	editedActorID  string
	editedMsgID    string
	editedText     string
	lastReadConvID string
	typingConvID   string
	typingKind     string
	typingState    string
	botProfile     BotProfileResult
	botAvatar      BotAvatarPayload
	unboundTokenID string
	announcement   SystemAnnouncement
	ackedByUser    map[string]string
	boundByUser    map[string]string
	challenges     map[string]EmailChallengeStoreRecord
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
func (s *stubRepo) RemoveGroupMember(_ context.Context, _, convID, targetUserID string, _ time.Time) (GroupConversationSummary, error) {
	if s.group.ID == "" {
		s.group = GroupConversationSummary{ID: convID, Type: "group", Title: "默认群聊"}
	}
	next := make([]string, 0, len(s.group.MemberIDs))
	for _, id := range s.group.MemberIDs {
		if id != targetUserID {
			next = append(next, id)
		}
	}
	s.group.MemberIDs = next
	return s.group, nil
}
func (s *stubRepo) MarkConversationRead(_ context.Context, _, convID string, now time.Time) (string, error) {
	s.lastReadConvID = convID
	return now.UTC().Format(time.RFC3339Nano), nil
}
func (s *stubRepo) SendConversationTyping(_ context.Context, _, convID, kind, state string, now time.Time) (string, error) {
	s.typingConvID = convID
	s.typingKind = kind
	s.typingState = state
	return now.UTC().Add(5 * time.Second).Format(time.RFC3339Nano), nil
}
func (s *stubRepo) EditMessage(_ context.Context, actorID, msgID, text string, _ time.Time) error {
	s.editedActorID = actorID
	s.editedMsgID = msgID
	s.editedText = text
	return nil
}
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
func (s *stubRepo) ListBotCommands(_ context.Context, _, _ string) ([]BotCommand, error) {
	return s.commands, nil
}
func (s *stubRepo) ListBotCommandsByBot(_ context.Context, _, _ string) ([]BotCommand, error) {
	return s.commands, nil
}
func (s *stubRepo) CreateMultiBot(_ context.Context, _, _ string, _ time.Time) (string, error) {
	return "bot_multi_1", nil
}
func (s *stubRepo) UpdateBotProfile(_ context.Context, _, botID string, input BotProfileUpdateInput, _ time.Time) (BotProfileResult, error) {
	s.botProfile.BotID = botID
	s.botProfile.BotUserID = "usr_" + botID
	if input.NameSet && input.Name != nil {
		s.botProfile.Name = *input.Name
	}
	if input.DescriptionSet && input.Description != nil {
		s.botProfile.Description = *input.Description
	}
	if input.ColorSet && input.Color != nil {
		s.botProfile.AvatarColor = *input.Color
	}
	return s.botProfile, nil
}
func (s *stubRepo) UploadBotAvatar(_ context.Context, _, botID, mimeType string, data []byte, _ time.Time) (BotProfileResult, error) {
	s.botAvatar = BotAvatarPayload{MIMEType: mimeType, Data: append([]byte(nil), data...)}
	s.botProfile.BotID = botID
	s.botProfile.BotUserID = "usr_" + botID
	s.botProfile.AvatarURL = "/api/v1/bots/" + botID + "/avatar?v=1"
	return s.botProfile, nil
}
func (s *stubRepo) DeleteBotAvatar(_ context.Context, _, botID string, _ time.Time) (BotProfileResult, error) {
	s.botAvatar = BotAvatarPayload{}
	s.botProfile.BotID = botID
	s.botProfile.AvatarURL = ""
	return s.botProfile, nil
}
func (s *stubRepo) GetBotAvatar(_ context.Context, _, _ string) (BotAvatarPayload, error) {
	if len(s.botAvatar.Data) == 0 {
		return BotAvatarPayload{}, ErrNotFound
	}
	return s.botAvatar, nil
}
func (s *stubRepo) UnbindBotToken(_ context.Context, _, tokenID string, _ time.Time) error {
	s.unboundTokenID = tokenID
	return nil
}
func (s *stubRepo) UpsertBotWebhook(_ context.Context, _, botID, url, _ string, enabled bool, _ time.Time) (BotWebhookConfig, error) {
	return BotWebhookConfig{BotID: botID, URL: url, Enabled: enabled}, nil
}
func (s *stubRepo) ListBotConversations(_ context.Context, _, _ string) ([]BotConversationSummary, error) {
	return []BotConversationSummary{{
		ID:           "conv_dm_bot_1",
		Type:         "direct",
		Title:        "测试成员",
		AllowSend:    true,
		AllowTrigger: true,
		AllowContext: true,
		MaxMessages:  50,
		UpdatedAt:    "2026-11-14T15:00:00Z",
	}}, nil
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
func (s *stubRepo) GetAdminAnnouncement(_ context.Context, _ string) (SystemAnnouncement, error) {
	if s.announcement.DisplayMode == "" {
		s.announcement.DisplayMode = "once"
	}
	return s.announcement, nil
}
func (s *stubRepo) UpsertAdminAnnouncement(_ context.Context, _ string, ann SystemAnnouncement, _ time.Time) (SystemAnnouncement, error) {
	s.announcement = ann
	return ann, nil
}
func (s *stubRepo) AckAnnouncement(_ context.Context, actorID, announcementID string, _ time.Time) error {
	if s.ackedByUser == nil {
		s.ackedByUser = make(map[string]string)
	}
	s.ackedByUser[actorID] = announcementID
	return nil
}
func (s *stubRepo) FindBoundEmailOwner(_ context.Context, normalizedEmail string) (string, error) {
	for uid, em := range s.boundByUser {
		if em == normalizedEmail {
			return uid, nil
		}
	}
	return "", nil
}
func (s *stubRepo) CheckEmailChallengeCooldown(_ context.Context, _ string, _ time.Time) error {
	return nil
}
func (s *stubRepo) SaveEmailChallenge(_ context.Context, challengeID, userID, normalizedEmail, codeHash string, now, expiresAt time.Time) error {
	if s.challenges == nil {
		s.challenges = make(map[string]EmailChallengeStoreRecord)
	}
	s.challenges[challengeID] = EmailChallengeStoreRecord{
		ID:           challengeID,
		UserID:       userID,
		PendingEmail: normalizedEmail,
		CodeHash:     codeHash,
		CreatedAt:    now,
		ExpiresAt:    expiresAt,
	}
	return nil
}
func (s *stubRepo) VerifyAndConsumeEmailChallenge(_ context.Context, challengeID string, verifyFn func(rec EmailChallengeStoreRecord) (bool, error), now time.Time) (EmailChallengeStoreRecord, error) {
	rec, ok := s.challenges[challengeID]
	if !ok || rec.ConsumedAt != nil || !rec.ExpiresAt.After(now) || rec.Attempts >= 5 {
		return EmailChallengeStoreRecord{}, ErrChallengeInvalid
	}
	matched, err := verifyFn(rec)
	if err != nil {
		return EmailChallengeStoreRecord{}, err
	}
	if !matched {
		rec.Attempts++
		s.challenges[challengeID] = rec
		return EmailChallengeStoreRecord{}, ErrChallengeInvalid
	}
	t := now
	rec.ConsumedAt = &t
	s.challenges[challengeID] = rec
	return rec, nil
}
func (s *stubRepo) BindAccountEmail(_ context.Context, actorID, normalizedEmail string, _ time.Time) error {
	if s.boundByUser == nil {
		s.boundByUser = make(map[string]string)
	}
	for uid, em := range s.boundByUser {
		if uid != actorID && em == normalizedEmail {
			return ErrEmailAlreadyBound
		}
	}
	s.boundByUser[actorID] = normalizedEmail
	return nil
}
func (s *stubRepo) UnbindAccountEmail(_ context.Context, actorID string, _ time.Time) error {
	delete(s.boundByUser, actorID)
	return nil
}
func (s *stubRepo) ResolveEmailLoginMember(_ context.Context, userID, normalizedEmail string, _ time.Time) (V1BootstrapMember, error) {
	if s.boundByUser[userID] != normalizedEmail {
		return V1BootstrapMember{}, ErrChallengeInvalid
	}
	return V1BootstrapMember{ID: userID, DisplayName: "已绑定成员", Kind: "human", Role: "member"}, nil
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

type stubBotAuthenticator struct {
	auth *botgateway.Auth
	err  error
}

func (s stubBotAuthenticator) Authenticate(context.Context, string, botgateway.TokenAuthOptions) (*botgateway.Auth, error) {
	return s.auth, s.err
}

func TestBotGatewayV2ConversationsAndMessageEdit(t *testing.T) {
	repo := &stubRepo{}
	svc := NewService(repo)
	validToken := "dl_bot_0123456789abcdef0123456789abcdef"
	botAuth := &botgateway.Auth{
		TokenID: "btk_1",
		BotID:   "bot_agent_1",
		UserID:  "usr_bot_agent_1",
		SpaceID: auth.DefaultSpaceID,
		Scopes:  []string{botgateway.ScopeMessagesReadTrigger, botgateway.ScopeMessagesSend},
	}

	handler := NewHTTPHandler(svc, stubActorResolver{}).WithBotAuthenticator(stubBotAuthenticator{auth: botAuth})
	r := chi.NewRouter()
	handler.Mount(r)

	// 1. Reject unauthenticated request
	unauthReq := httptest.NewRequest(http.MethodGet, "/api/bot/v2/conversations", nil)
	unauthRec := httptest.NewRecorder()
	r.ServeHTTP(unauthRec, unauthReq)
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without bearer token, got %d", unauthRec.Code)
	}

	// 2. List bot conversations
	listReq := httptest.NewRequest(http.MethodGet, "/api/bot/v2/conversations", nil)
	listReq.Header.Set("Authorization", "Bearer "+validToken)
	listRec := httptest.NewRecorder()
	r.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /api/bot/v2/conversations, got %d: %s", listRec.Code, listRec.Body.String())
	}
	var listResp struct {
		Conversations []BotConversationSummary `json:"conversations"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("unmarshal bot conversations: %v", err)
	}
	if len(listResp.Conversations) != 1 || listResp.Conversations[0].ID != "conv_dm_bot_1" || !listResp.Conversations[0].AllowContext {
		t.Fatalf("unexpected bot conversations: %+v", listResp.Conversations)
	}

	// 3. Edit bot message with messages:send scope
	editReq := httptest.NewRequest(http.MethodPatch, "/api/bot/v2/messages/msg_stream_1", bytes.NewBufferString(`{"plainText":"已完成分析，结论如下"}`))
	editReq.Header.Set("Authorization", "Bearer "+validToken)
	editRec := httptest.NewRecorder()
	r.ServeHTTP(editRec, editReq)
	if editRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on bot message edit, got %d: %s", editRec.Code, editRec.Body.String())
	}
	if repo.editedActorID != "usr_bot_agent_1" || repo.editedMsgID != "msg_stream_1" || repo.editedText != "已完成分析，结论如下" {
		t.Fatalf("unexpected edited message state: %+v", repo)
	}

	// 4. Reject edit when messages:send scope is missing
	readOnlyHandler := NewHTTPHandler(svc, stubActorResolver{}).WithBotAuthenticator(stubBotAuthenticator{
		auth: &botgateway.Auth{
			TokenID: "btk_ro",
			BotID:   "bot_agent_1",
			UserID:  "usr_bot_agent_1",
			SpaceID: auth.DefaultSpaceID,
			Scopes:  []string{botgateway.ScopeMessagesReadTrigger},
		},
	})
	roRouter := chi.NewRouter()
	readOnlyHandler.Mount(roRouter)
	roReq := httptest.NewRequest(http.MethodPatch, "/api/bot/v2/messages/msg_stream_1", bytes.NewBufferString(`{"plainText":"denied"}`))
	roReq.Header.Set("Authorization", "Bearer "+validToken)
	roRec := httptest.NewRecorder()
	roRouter.ServeHTTP(roRec, roReq)
	if roRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without messages:send scope, got %d: %s", roRec.Code, roRec.Body.String())
	}

	// 5. Bot typing & self-unbind endpoints
	typingReq := httptest.NewRequest(http.MethodPost, "/api/bot/v2/typing", bytes.NewBufferString(`{"conversationId":"conv_dm_bot_1","state":"thinking"}`))
	typingReq.Header.Set("Authorization", "Bearer "+validToken)
	typingRec := httptest.NewRecorder()
	r.ServeHTTP(typingRec, typingReq)
	if typingRec.Code != http.StatusOK || repo.typingConvID != "conv_dm_bot_1" || repo.typingKind != "bot" || repo.typingState != "thinking" {
		t.Fatalf("expected 200 on /api/bot/v2/typing, got %d state=%+v", typingRec.Code, repo)
	}

	unbindReq := httptest.NewRequest(http.MethodPost, "/api/bot/v2/unbind", nil)
	unbindReq.Header.Set("Authorization", "Bearer "+validToken)
	unbindRec := httptest.NewRecorder()
	r.ServeHTTP(unbindRec, unbindReq)
	if unbindRec.Code != http.StatusOK || repo.unboundTokenID != "btk_1" {
		t.Fatalf("expected 200 on /api/bot/v2/unbind, got %d token=%q", unbindRec.Code, repo.unboundTokenID)
	}
}

func TestReadReceiptTypingBotProfileAndGroupRemoveRoutes(t *testing.T) {
	repo := &stubRepo{}
	svc := NewService(repo)
	r := chi.NewRouter()
	h := NewHTTPHandler(svc, stubActorResolver{
		actor: &auth.Actor{ID: "usr_owner_1", Role: "owner", DisplayName: "Owner"},
	})
	h.Mount(r)

	// 1. Mark read + human typing
	readReq := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/conv_dm_1/read", nil)
	readRec := httptest.NewRecorder()
	r.ServeHTTP(readRec, readReq)
	if readRec.Code != http.StatusOK || repo.lastReadConvID != "conv_dm_1" {
		t.Fatalf("expected 200 on mark read, got %d (%s)", readRec.Code, readRec.Body.String())
	}

	typReq := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/conv_dm_1/typing", bytes.NewBufferString(`{"state":"typing"}`))
	typRec := httptest.NewRecorder()
	r.ServeHTTP(typRec, typReq)
	if typRec.Code != http.StatusOK || repo.typingConvID != "conv_dm_1" || repo.typingKind != "human" {
		t.Fatalf("expected 200 on human typing, got %d (%s)", typRec.Code, typRec.Body.String())
	}

	// 2. Update bot profile, color, upload/get/delete bot avatar
	profReq := httptest.NewRequest(http.MethodPatch, "/api/v1/bots/bot_astra/profile", bytes.NewBufferString(`{"name":"Astra Pro","description":"全栈协作智能体"}`))
	profRec := httptest.NewRecorder()
	r.ServeHTTP(profRec, profReq)
	if profRec.Code != http.StatusOK || repo.botProfile.Name != "Astra Pro" || repo.botProfile.Description != "全栈协作智能体" {
		t.Fatalf("expected 200 on bot profile patch, got %d (%s)", profRec.Code, profRec.Body.String())
	}

	colReq := httptest.NewRequest(http.MethodPatch, "/api/v1/bots/bot_astra/profile", bytes.NewBufferString(`{"color":"violet"}`))
	colRec := httptest.NewRecorder()
	r.ServeHTTP(colRec, colReq)
	if colRec.Code != http.StatusOK || repo.botProfile.AvatarColor != "violet" {
		t.Fatalf("expected 200 on bot color patch, got %d (%s)", colRec.Code, colRec.Body.String())
	}

	badColReq := httptest.NewRequest(http.MethodPatch, "/api/v1/bots/bot_astra/profile", bytes.NewBufferString(`{"color":"neon-pink"}`))
	badColRec := httptest.NewRecorder()
	r.ServeHTTP(badColRec, badColReq)
	if badColRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on invalid bot color patch, got %d (%s)", badColRec.Code, badColRec.Body.String())
	}

	pngHeader := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0x00, 0x01}
	avaPut := httptest.NewRequest(http.MethodPut, "/api/v1/bots/bot_astra/avatar", bytes.NewReader(pngHeader))
	avaPut.Header.Set("Content-Type", "image/png")
	avaPutRec := httptest.NewRecorder()
	r.ServeHTTP(avaPutRec, avaPut)
	if avaPutRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on bot avatar upload, got %d (%s)", avaPutRec.Code, avaPutRec.Body.String())
	}

	avaGet := httptest.NewRequest(http.MethodGet, "/api/v1/bots/bot_astra/avatar", nil)
	avaGetRec := httptest.NewRecorder()
	r.ServeHTTP(avaGetRec, avaGet)
	if avaGetRec.Code != http.StatusOK || avaGetRec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("expected 200 image/png on bot avatar get, got %d", avaGetRec.Code)
	}

	avaDel := httptest.NewRequest(http.MethodDelete, "/api/v1/bots/bot_astra/avatar", nil)
	avaDelRec := httptest.NewRecorder()
	r.ServeHTTP(avaDelRec, avaDel)
	if avaDelRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on bot avatar delete, got %d", avaDelRec.Code)
	}

	// 3. Remove bot member from group
	repo.group = GroupConversationSummary{ID: "conv_grp_bot", Type: "group", Title: "研发群", MemberIDs: []string{"usr_owner_1", "usr_bot_astra"}}
	remReq := httptest.NewRequest(http.MethodDelete, "/api/v1/conversations/conv_grp_bot/members/usr_bot_astra", nil)
	remRec := httptest.NewRecorder()
	r.ServeHTTP(remRec, remReq)
	if remRec.Code != http.StatusOK || len(repo.group.MemberIDs) != 1 {
		t.Fatalf("expected 200 on group member remove, got %d (%s)", remRec.Code, remRec.Body.String())
	}
}

type stubEmailSender struct {
	lastRecipient string
	lastCode      string
	lastPurpose   string
}

func (s *stubEmailSender) SendVerificationCode(_ context.Context, recipient, code, purpose string) error {
	s.lastRecipient = recipient
	s.lastCode = code
	s.lastPurpose = purpose
	return nil
}
func (s *stubEmailSender) HashChallengeCode(id, code string) (string, error) {
	return id + ":" + code, nil
}
func (s *stubEmailSender) VerifyChallengeCode(expectedHash, id, code string) (bool, error) {
	return expectedHash == id+":"+code, nil
}

type stubSessionIssuer struct {
	webIssuedUser    string
	mobileIssuedUser string
}

type actorResolverFunc func(context.Context, *http.Request) (*auth.Actor, error)

func (fn actorResolverFunc) ResolveActor(ctx context.Context, r *http.Request) (*auth.Actor, error) {
	return fn(ctx, r)
}

func (s *stubSessionIssuer) CheckPublicAuthRateLimit(_ context.Context, _ *http.Request) (bool, error) {
	return true, nil
}
func (s *stubSessionIssuer) IssueWebLoginSession(w http.ResponseWriter, _ *http.Request, userID string) (string, error) {
	s.webIssuedUser = userID
	http.SetCookie(w, &http.Cookie{Name: auth.SessionCookieName, Value: "session_for_" + userID, Path: "/"})
	return "2026-12-01T00:00:00.000Z", nil
}
func (s *stubSessionIssuer) IssueMobileLoginSession(_ context.Context, userID string) (auth.MobileTokens, error) {
	s.mobileIssuedUser = userID
	return auth.MobileTokens{
		AccessToken:           "mob_acc_" + userID,
		RefreshToken:          "mob_ref_" + userID,
		AccessTokenExpiresAt:  "2026-11-16T00:15:00.000Z",
		RefreshTokenExpiresAt: "2026-12-15T00:00:00.000Z",
	}, nil
}

func TestAnnouncementAndEmailBindLoginLifecycle(t *testing.T) {
	repo := &stubRepo{}
	mailer := &stubEmailSender{}
	sessions := &stubSessionIssuer{}
	svc := NewService(repo).WithEmailSender(mailer)
	svc.codeGen = func() (string, error) { return "654321", nil }

	resolver := actorResolverFunc(func(_ context.Context, r *http.Request) (*auth.Actor, error) {
		if r.Header.Get("X-Test-Auth") == "none" {
			return nil, nil
		}
		return &auth.Actor{ID: "usr_owner_1", Kind: "human", Role: "owner"}, nil
	})
	handler := NewHTTPHandler(svc, resolver).WithSessionIssuer(sessions)
	r := chi.NewRouter()
	handler.Mount(r)

	// 1. Admin creates announcement (once mode) & rejects unsafe javascript: CTA URL
	badAnnReq := httptest.NewRequest(http.MethodPut, "/api/v1/admin/announcement", bytes.NewBufferString(`{"enabled":true,"displayMode":"once","title":"测试","content":"正文","ctaUrl":"javascript:alert(1)"}`))
	badAnnRec := httptest.NewRecorder()
	r.ServeHTTP(badAnnRec, badAnnReq)
	if badAnnRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on javascript ctaUrl, got %d", badAnnRec.Code)
	}

	putAnnReq := httptest.NewRequest(http.MethodPut, "/api/v1/admin/announcement", bytes.NewBufferString(`{"enabled":true,"displayMode":"once","badge":"新版发布","title":"DualLane 移动端上线","content":"欢迎下载 Android 客户端","ctaLabel":"立即下载","ctaUrl":"https://github.com/timeStarry/duallane-mobile/releases/latest"}`))
	putAnnRec := httptest.NewRecorder()
	r.ServeHTTP(putAnnRec, putAnnReq)
	if putAnnRec.Code != http.StatusOK || !repo.announcement.Enabled || repo.announcement.ID == "" {
		t.Fatalf("expected 200 on put announcement, got %d (%s)", putAnnRec.Code, putAnnRec.Body.String())
	}
	firstAnnID := repo.announcement.ID

	ackReq := httptest.NewRequest(http.MethodPost, "/api/v1/announcement/ack", bytes.NewBufferString(`{"id":"`+firstAnnID+`"}`))
	ackRec := httptest.NewRecorder()
	r.ServeHTTP(ackRec, ackReq)
	if ackRec.Code != http.StatusOK || repo.ackedByUser["usr_owner_1"] != firstAnnID {
		t.Fatalf("expected 200 on ack announcement, got %d", ackRec.Code)
	}

	// Re-pushing with resetAck generates a fresh announcement ID
	repushReq := httptest.NewRequest(http.MethodPut, "/api/v1/admin/announcement", bytes.NewBufferString(`{"enabled":true,"displayMode":"always","title":"DualLane 移动端上线","content":"欢迎下载","resetAck":true}`))
	repushRec := httptest.NewRecorder()
	r.ServeHTTP(repushRec, repushReq)
	if repushRec.Code != http.StatusOK || repo.announcement.ID == firstAnnID || repo.announcement.DisplayMode != "always" {
		t.Fatalf("expected new announcement ID and always mode, got %+v", repo.announcement)
	}

	// 2. Unbound email login is strictly rejected (no registration via email)
	unboundLoginReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email/send-code", bytes.NewBufferString(`{"email":"stranger@example.com"}`))
	unboundLoginReq.Header.Set("X-Test-Auth", "none")
	unboundLoginRec := httptest.NewRecorder()
	r.ServeHTTP(unboundLoginRec, unboundLoginReq)
	if unboundLoginRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when attempting login with unbound email, got %d (%s)", unboundLoginRec.Code, unboundLoginRec.Body.String())
	}

	// 3. Authenticated GitHub user binds email
	bindSendReq := httptest.NewRequest(http.MethodPost, "/api/v1/account/email/send-code", bytes.NewBufferString(`{"email":"Member@Example.com"}`))
	bindSendRec := httptest.NewRecorder()
	r.ServeHTTP(bindSendRec, bindSendReq)
	if bindSendRec.Code != http.StatusOK || mailer.lastPurpose != "bind" || mailer.lastCode != "654321" {
		t.Fatalf("expected 200 on bind send-code, got %d (%s)", bindSendRec.Code, bindSendRec.Body.String())
	}
	var bindChallenge EmailChallengeSummary
	_ = json.Unmarshal(bindSendRec.Body.Bytes(), &bindChallenge)

	// Cross-replay guard: bind challenge cannot be used on /auth/email/verify
	crossReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email/verify", bytes.NewBufferString(`{"email":"member@example.com","challengeId":"`+bindChallenge.ChallengeID+`","code":"654321"}`))
	crossReq.Header.Set("X-Test-Auth", "none")
	crossRec := httptest.NewRecorder()
	r.ServeHTTP(crossRec, crossReq)
	if crossRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on cross-replaying bind challenge as login, got %d", crossRec.Code)
	}

	bindVerifyReq := httptest.NewRequest(http.MethodPost, "/api/v1/account/email/verify", bytes.NewBufferString(`{"challengeId":"`+bindChallenge.ChallengeID+`","code":"654321"}`))
	bindVerifyRec := httptest.NewRecorder()
	r.ServeHTTP(bindVerifyRec, bindVerifyReq)
	if bindVerifyRec.Code != http.StatusOK || repo.boundByUser["usr_owner_1"] != "member@example.com" {
		t.Fatalf("expected 200 on bind verify, got %d (%s)", bindVerifyRec.Code, bindVerifyRec.Body.String())
	}

	// 4. Web & Mobile Email Login with bound email
	loginSendReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email/send-code", bytes.NewBufferString(`{"email":"member@example.com"}`))
	loginSendReq.Header.Set("X-Test-Auth", "none")
	loginSendRec := httptest.NewRecorder()
	r.ServeHTTP(loginSendRec, loginSendReq)
	if loginSendRec.Code != http.StatusOK || mailer.lastPurpose != "login" {
		t.Fatalf("expected 200 on login send-code, got %d (%s)", loginSendRec.Code, loginSendRec.Body.String())
	}
	var loginChallenge EmailChallengeSummary
	_ = json.Unmarshal(loginSendRec.Body.Bytes(), &loginChallenge)

	webVerifyReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email/verify", bytes.NewBufferString(`{"email":"member@example.com","challengeId":"`+loginChallenge.ChallengeID+`","code":"654321","client":"web"}`))
	webVerifyReq.Header.Set("X-Test-Auth", "none")
	webVerifyRec := httptest.NewRecorder()
	r.ServeHTTP(webVerifyRec, webVerifyReq)
	if webVerifyRec.Code != http.StatusOK || sessions.webIssuedUser != "usr_owner_1" {
		t.Fatalf("expected 200 web session on email login, got %d (%s)", webVerifyRec.Code, webVerifyRec.Body.String())
	}

	// Mobile client login issues Keystore-ready accessToken + refreshToken
	loginSendMobReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email/send-code", bytes.NewBufferString(`{"email":"member@example.com"}`))
	loginSendMobReq.Header.Set("X-Test-Auth", "none")
	loginSendMobRec := httptest.NewRecorder()
	r.ServeHTTP(loginSendMobRec, loginSendMobReq)
	var mobChallenge EmailChallengeSummary
	_ = json.Unmarshal(loginSendMobRec.Body.Bytes(), &mobChallenge)

	mobVerifyReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email/verify", bytes.NewBufferString(`{"email":"member@example.com","challengeId":"`+mobChallenge.ChallengeID+`","code":"654321","client":"mobile"}`))
	mobVerifyReq.Header.Set("X-Test-Auth", "none")
	mobVerifyRec := httptest.NewRecorder()
	r.ServeHTTP(mobVerifyRec, mobVerifyReq)
	if mobVerifyRec.Code != http.StatusOK || sessions.mobileIssuedUser != "usr_owner_1" {
		t.Fatalf("expected 200 mobile session on email login, got %d (%s)", mobVerifyRec.Code, mobVerifyRec.Body.String())
	}

	// 5. Unbind email removes bound email while keeping GitHub account intact
	unbindReq := httptest.NewRequest(http.MethodDelete, "/api/v1/account/email", nil)
	unbindRec := httptest.NewRecorder()
	r.ServeHTTP(unbindRec, unbindReq)
	if unbindRec.Code != http.StatusOK || repo.boundByUser["usr_owner_1"] != "" {
		t.Fatalf("expected 200 on email unbind, got %d", unbindRec.Code)
	}
}
