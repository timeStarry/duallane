package v1

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
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
	mobileRelease  MobileClientRelease
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
func (s *stubRepo) ListConversationThreads(_ context.Context, _, convID string) ([]ConversationThreadItem, error) {
	return []ConversationThreadItem{{RootMessageID: "msg_root_1", ConversationID: convID, ReplyCount: 2, RootPlainText: "讨论方案"}}, nil
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
func (s *stubRepo) GetPublicMobileRelease(_ context.Context) (MobileClientRelease, error) {
	if !s.mobileRelease.Enabled || s.mobileRelease.SHA256 == "" || s.mobileRelease.ByteSize <= 0 {
		return MobileClientRelease{}, ErrNotFound
	}
	return s.mobileRelease, nil
}
func (s *stubRepo) GetAdminMobileRelease(_ context.Context, _ string) (MobileClientRelease, error) {
	if s.mobileRelease.DownloadURL == "" {
		s.mobileRelease.DownloadURL = "/api/v1/mobile/android/latest.apk"
	}
	return s.mobileRelease, nil
}
func (s *stubRepo) UpsertAdminMobileRelease(_ context.Context, actorID string, rel MobileClientRelease, _ time.Time) (MobileClientRelease, error) {
	rel.UpdatedBy = actorID
	s.mobileRelease = rel
	return rel, nil
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

type memBlobStore struct {
	blobs map[string][]byte
}

func (m *memBlobStore) Put(_ context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (platformstorage.StoredObject, error) {
	if m.blobs == nil {
		m.blobs = make(map[string][]byte)
	}
	data, err := io.ReadAll(source)
	if err != nil {
		return platformstorage.StoredObject{}, err
	}
	m.blobs[key] = data
	return platformstorage.StoredObject{
		Object: platformstorage.Object{
			Key:      key,
			SHA256:   expectedSHA256,
			ByteSize: expectedSize,
		},
	}, nil
}

func (m *memBlobStore) Open(_ context.Context, object platformstorage.Object, _ int64) (platformstorage.OpenedObject, error) {
	data, ok := m.blobs[object.Key]
	if !ok {
		return platformstorage.OpenedObject{}, ErrNotFound
	}
	return platformstorage.OpenedObject{
		Object: object,
		Body:   io.NopCloser(bytes.NewReader(data)),
	}, nil
}

func (m *memBlobStore) Delete(_ context.Context, object platformstorage.Object) error {
	delete(m.blobs, object.Key)
	return nil
}

func buildSyntheticDualLaneAPK(t *testing.T, version string, versionCode int) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	mf, err := zw.Create("AndroidManifest.xml")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = mf.Write([]byte("binary-manifest-placeholder-bytes-for-duallane-apk"))

	dex, err := zw.Create("classes.dex")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = dex.Write([]byte("dex\n039\x00synthetic-dalvik-bytecode-for-test"))

	cfg, err := zw.Create("assets/app.config")
	if err != nil {
		t.Fatal(err)
	}
	cfgJSON, _ := json.Marshal(map[string]any{
		"name":    "DualLane",
		"version": version,
		"android": map[string]any{
			"package":     "com.timestarry.duallane",
			"versionCode": versionCode,
		},
	})
	_, _ = cfg.Write(cfgJSON)

	wwwIndex, err := zw.Create("assets/www/index.html")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = wwwIndex.Write([]byte("<!doctype html><html><body>DualLane Mobile " + version + "</body></html>"))

	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestMobileReleaseDistributionEndpoints(t *testing.T) {
	repo := &stubRepo{}
	blobs := &memBlobStore{}
	svc := NewService(repo).WithBlobStore(blobs)
	resolver := actorResolverFunc(func(_ context.Context, r *http.Request) (*auth.Actor, error) {
		if r.Header.Get("X-Test-Auth") == "none" {
			return nil, nil
		}
		return &auth.Actor{ID: "usr_owner_1", Role: "owner", Kind: "human"}, nil
	})
	h := NewHTTPHandler(svc, resolver)
	r := chi.NewRouter()
	h.Mount(r)

	// 1. Before APK upload: latest metadata returns 404, latest.apk 302-redirects to GitHub fallback
	preLatest := httptest.NewRequest(http.MethodGet, "/api/v1/mobile/releases/latest", nil)
	preLatest.Header.Set("X-Test-Auth", "none")
	preLatestRec := httptest.NewRecorder()
	r.ServeHTTP(preLatestRec, preLatest)
	if preLatestRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 before APK upload, got %d", preLatestRec.Code)
	}

	preApk := httptest.NewRequest(http.MethodGet, "/api/v1/mobile/android/latest.apk", nil)
	preApk.Header.Set("X-Test-Auth", "none")
	preApkRec := httptest.NewRecorder()
	r.ServeHTTP(preApkRec, preApk)
	if preApkRec.Code != http.StatusFound {
		t.Fatalf("expected 302 fallback redirect before APK upload, got %d", preApkRec.Code)
	}

	// 2. Reject non-APK garbage upload
	badUpload := httptest.NewRequest(http.MethodPut, "/api/v1/admin/mobile-release/apk", bytes.NewBufferString("not-a-valid-apk-zip"))
	badUploadRec := httptest.NewRecorder()
	r.ServeHTTP(badUploadRec, badUpload)
	if badUploadRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid APK upload, got %d", badUploadRec.Code)
	}

	// 3. Upload valid DualLane APK -> auto-extracts version 1.0.7 and versionCode 10007 from assets/app.config
	apkBytes := buildSyntheticDualLaneAPK(t, "1.0.7", 10007)
	upReq := httptest.NewRequest(http.MethodPut, "/api/v1/admin/mobile-release/apk", bytes.NewReader(apkBytes))
	upRec := httptest.NewRecorder()
	r.ServeHTTP(upRec, upReq)
	if upRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on APK upload, got %d (%s)", upRec.Code, upRec.Body.String())
	}
	if repo.mobileRelease.Version != "1.0.7" || repo.mobileRelease.VersionCode != 10007 || !repo.mobileRelease.Enabled {
		t.Fatalf("unexpected auto-detected release metadata: %+v", repo.mobileRelease)
	}

	// 4. Update Markdown release notes via admin endpoint
	metaReq := httptest.NewRequest(http.MethodPut, "/api/v1/admin/mobile-release", bytes.NewBufferString(`{
		"enabled": true,
		"version": "1.0.7",
		"versionCode": 10007,
		"title": "DualLane Android v1.0.7",
		"notes": "### 新增与优化\n- **服务端同源分发**：秒级检测与下载"
	}`))
	metaRec := httptest.NewRecorder()
	r.ServeHTTP(metaRec, metaReq)
	if metaRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on metadata update, got %d (%s)", metaRec.Code, metaRec.Body.String())
	}

	// 5. Public unauthenticated check returns 200 with full release info
	pubReq := httptest.NewRequest(http.MethodGet, "/api/v1/mobile/releases/latest", nil)
	pubReq.Header.Set("X-Test-Auth", "none")
	pubRec := httptest.NewRecorder()
	r.ServeHTTP(pubRec, pubReq)
	if pubRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on public latest release, got %d", pubRec.Code)
	}

	// 6. Public unauthenticated APK download streams exact APK bytes + ETag 304 support
	dlReq := httptest.NewRequest(http.MethodGet, "/api/v1/mobile/android/latest.apk", nil)
	dlReq.Header.Set("X-Test-Auth", "none")
	dlRec := httptest.NewRecorder()
	r.ServeHTTP(dlRec, dlReq)
	if dlRec.Code != http.StatusOK || !bytes.Equal(dlRec.Body.Bytes(), apkBytes) {
		t.Fatalf("expected 200 and exact APK bytes, got %d (len=%d)", dlRec.Code, dlRec.Body.Len())
	}
	etag := dlRec.Header().Get("ETag")
	if etag == "" || dlRec.Header().Get("Content-Type") != "application/vnd.android.package-archive" {
		t.Fatalf("unexpected download headers: etag=%q ct=%q", etag, dlRec.Header().Get("Content-Type"))
	}

	inmReq := httptest.NewRequest(http.MethodGet, "/api/v1/mobile/android/latest.apk", nil)
	inmReq.Header.Set("X-Test-Auth", "none")
	inmReq.Header.Set("If-None-Match", etag)
	inmRec := httptest.NewRecorder()
	r.ServeHTTP(inmRec, inmReq)
	if inmRec.Code != http.StatusNotModified {
		t.Fatalf("expected 304 Not Modified on matching ETag, got %d", inmRec.Code)
	}

	// 7. Owner-owned Bot can publish APK + metadata via /api/bot/v2/mobile-release
	ownerTok := "dl_bot_owner_token_0123456789abcdef0123456789"
	memberTok := "dl_bot_member_token_0123456789abcdef012345678"
	botRouter := chi.NewRouter()
	NewHTTPHandler(svc, resolver).WithBotAuthenticator(botAuthFunc(func(_ context.Context, authHeader string, _ botgateway.TokenAuthOptions) (*botgateway.Auth, error) {
		if authHeader == "Bearer "+ownerTok {
			return &botgateway.Auth{BotID: "bot_astra", UserID: "usr_bot_astra", OwnerUserID: "usr_owner_1"}, nil
		}
		return &botgateway.Auth{BotID: "bot_no_owner", UserID: "usr_bot_2", OwnerUserID: ""}, nil
	})).Mount(botRouter)

	deniedBotReq := httptest.NewRequest(http.MethodPut, "/api/bot/v2/mobile-release/apk", bytes.NewReader(apkBytes))
	deniedBotReq.Header.Set("Authorization", "Bearer "+memberTok)
	deniedBotRec := httptest.NewRecorder()
	botRouter.ServeHTTP(deniedBotRec, deniedBotReq)
	if deniedBotRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for bot without manager owner, got %d", deniedBotRec.Code)
	}

	apk108 := buildSyntheticDualLaneAPK(t, "1.0.8", 10008)
	ownerBotUpReq := httptest.NewRequest(http.MethodPut, "/api/bot/v2/mobile-release/apk", bytes.NewReader(apk108))
	ownerBotUpReq.Header.Set("Authorization", "Bearer "+ownerTok)
	ownerBotUpRec := httptest.NewRecorder()
	botRouter.ServeHTTP(ownerBotUpRec, ownerBotUpReq)
	if ownerBotUpRec.Code != http.StatusOK || repo.mobileRelease.Version != "1.0.8" {
		t.Fatalf("expected 200 and version 1.0.8 on owner bot APK publish, got %d (%s)", ownerBotUpRec.Code, ownerBotUpRec.Body.String())
	}
	if repo.mobileRelease.OTA == nil || !repo.mobileRelease.OTA.Enabled || repo.mobileRelease.OTA.MinNativeVersionCode != 10008 {
		t.Fatalf("expected auto-extracted OTA bundle from APK, got %+v", repo.mobileRelease.OTA)
	}

	// 8. Reject Zip-Slip / disallowed extension in standalone OTA zip, and accept valid OTA hot-update
	var evilBuf bytes.Buffer
	evilZw := zip.NewWriter(&evilBuf)
	ew, _ := evilZw.Create("../escape.js")
	_, _ = ew.Write([]byte("alert(1)"))
	_ = evilZw.Close()

	badOtaReq := httptest.NewRequest(http.MethodPut, "/api/bot/v2/mobile-release/ota?version=1.0.9", bytes.NewReader(evilBuf.Bytes()))
	badOtaReq.Header.Set("Authorization", "Bearer "+ownerTok)
	badOtaRec := httptest.NewRecorder()
	botRouter.ServeHTTP(badOtaRec, badOtaReq)
	if badOtaRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on path-traversal OTA zip, got %d", badOtaRec.Code)
	}

	var goodOtaBuf bytes.Buffer
	goodZw := zip.NewWriter(&goodOtaBuf)
	idxW, _ := goodZw.Create("www/index.html")
	_, _ = idxW.Write([]byte("<!doctype html><html><body>OTA 1.0.9</body></html>"))
	jsW, _ := goodZw.Create("www/assets/app.js")
	_, _ = jsW.Write([]byte("console.log('ota 1.0.9')"))
	_ = goodZw.Close()

	goodOtaReq := httptest.NewRequest(http.MethodPut, "/api/bot/v2/mobile-release/ota?version=1.0.9&minNativeVersionCode=10008", bytes.NewReader(goodOtaBuf.Bytes()))
	goodOtaReq.Header.Set("Authorization", "Bearer "+ownerTok)
	goodOtaRec := httptest.NewRecorder()
	botRouter.ServeHTTP(goodOtaRec, goodOtaReq)
	if goodOtaRec.Code != http.StatusOK || repo.mobileRelease.Version != "1.0.9" || repo.mobileRelease.OTA == nil {
		t.Fatalf("expected 200 on standalone OTA publish, got %d (%s)", goodOtaRec.Code, goodOtaRec.Body.String())
	}
	if repo.mobileRelease.VersionCode != 10008 || repo.mobileRelease.OTA.MinNativeVersionCode != 10008 {
		t.Fatalf("expected APK versionCode preserved at 10008 and minNativeVersionCode=10008, got %+v", repo.mobileRelease)
	}

	otaDlReq := httptest.NewRequest(http.MethodGet, "/api/v1/mobile/android/latest-ota.zip", nil)
	otaDlReq.Header.Set("X-Test-Auth", "none")
	otaDlRec := httptest.NewRecorder()
	r.ServeHTTP(otaDlRec, otaDlReq)
	if otaDlRec.Code != http.StatusOK || otaDlRec.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("expected 200 and application/zip on latest-ota.zip, got %d", otaDlRec.Code)
	}
}

type botAuthFunc func(context.Context, string, botgateway.TokenAuthOptions) (*botgateway.Auth, error)

func (fn botAuthFunc) Authenticate(ctx context.Context, header string, opts botgateway.TokenAuthOptions) (*botgateway.Auth, error) {
	return fn(ctx, header, opts)
}

type stubBotFiles struct {
	reservedInput  files.ReserveUploadInput
	completedBytes []byte
}

func (s *stubBotFiles) ReserveAgentBotUpload(_ context.Context, input files.ReserveUploadInput) (files.UploadResult, error) {
	s.reservedInput = input
	convID := input.ConversationID
	return files.UploadResult{
		Status: string(files.TransferReserved),
		ID:     "upl_bot_test_1",
		Upload: &files.UploadPlan{ID: "upl_bot_test_1", Mode: "single", PartSize: files.UploadPartSize, PartCount: 1},
		Attachment: &files.Attachment{
			ID:             "att_bot_test_1",
			FileName:       input.FileName,
			MIMEType:       input.MIMEType,
			ByteSize:       input.ByteSize,
			Status:         string(files.AttachmentPending),
			Visibility:     input.Visibility,
			UploaderID:     input.ActorID,
			ConversationID: &convID,
		},
	}, nil
}

func (s *stubBotFiles) CompleteAgentBotUpload(_ context.Context, input files.CompleteUploadInput) (files.UploadResult, error) {
	data, err := io.ReadAll(input.Content)
	if err != nil {
		return files.UploadResult{}, err
	}
	s.completedBytes = data
	convID := s.reservedInput.ConversationID
	return files.UploadResult{
		Status: string(files.TransferCompleted),
		ID:     input.UploadID,
		Attachment: &files.Attachment{
			ID:             "att_bot_test_1",
			FileName:       s.reservedInput.FileName,
			MIMEType:       s.reservedInput.MIMEType,
			ByteSize:       int64(len(data)),
			Status:         string(files.AttachmentAvailable),
			Visibility:     string(files.VisibilityConversation),
			UploaderID:     input.ActorID,
			ConversationID: &convID,
		},
	}, nil
}

type stubBotMessageCreator struct {
	lastInput messages.CreateInput
}

func (s *stubBotMessageCreator) Create(_ context.Context, input messages.CreateInput) (messages.Message, error) {
	s.lastInput = input
	return messages.Message{
		ID:             "msg_bot_file_1",
		ConversationID: input.ConversationID,
		PlainText:      input.Content.PlainText,
		Content:        input.Content,
	}, nil
}

func TestBotFileUploadAndSendEndpoints(t *testing.T) {
	repo := &stubRepo{}
	svc := NewService(repo)
	resolver := actorResolverFunc(func(_ context.Context, _ *http.Request) (*auth.Actor, error) {
		return nil, nil
	})
	botFiles := &stubBotFiles{}
	botMsgs := &stubBotMessageCreator{}
	validTok := "dl_bot_comet_token_0123456789abcdef0123456789"
	h := NewHTTPHandler(svc, resolver).
		WithBotAuthenticator(botAuthFunc(func(_ context.Context, header string, _ botgateway.TokenAuthOptions) (*botgateway.Auth, error) {
			if header != "Bearer "+validTok {
				return nil, botgateway.NewError(botgateway.CodeInvalidToken, "invalid", http.StatusUnauthorized)
			}
			return &botgateway.Auth{
				BotID:   "bot_comet",
				UserID:  "usr_bot_comet",
				SpaceID: "spc_default",
				Scopes:  []string{botgateway.ScopeMessagesSend},
			}, nil
		})).
		WithBotFilePipeline(botFiles, botMsgs)

	r := chi.NewRouter()
	h.Mount(r)

	// 1. Reject unauthorized conversation
	forbidReq := httptest.NewRequest(http.MethodPost, "/api/bot/v2/conversations/conv_unauthorized/files?fileName=report.md", bytes.NewBufferString("# Report"))
	forbidReq.Header.Set("Authorization", "Bearer "+validTok)
	forbidRec := httptest.NewRecorder()
	r.ServeHTTP(forbidRec, forbidReq)
	if forbidRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized conversation, got %d", forbidRec.Code)
	}

	// 2. One-shot file upload + message send in authorized conversation (works with messages:send scope!)
	sendReq := httptest.NewRequest(
		http.MethodPost,
		"/api/bot/v2/conversations/conv_dm_bot_1/files?fileName=summary.md&text=%E5%B7%B2%E7%94%9F%E6%88%90%E6%8A%A5%E5%91%8A",
		bytes.NewBufferString("# Weekly Summary\nAll green."),
	)
	sendReq.Header.Set("Authorization", "Bearer "+validTok)
	sendReq.Header.Set("Content-Type", "application/octet-stream")
	sendRec := httptest.NewRecorder()
	r.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 on bot file send, got %d (%s)", sendRec.Code, sendRec.Body.String())
	}
	if botFiles.reservedInput.MIMEType != "text/markdown" || botFiles.reservedInput.Visibility != "conversation" {
		t.Fatalf("expected inferred text/markdown + conversation visibility, got %+v", botFiles.reservedInput)
	}
	if string(botFiles.completedBytes) != "# Weekly Summary\nAll green." {
		t.Fatalf("unexpected completed bytes: %q", string(botFiles.completedBytes))
	}
	if len(botMsgs.lastInput.Content.Blocks) != 2 ||
		botMsgs.lastInput.Content.Blocks[0].Type != "text" ||
		botMsgs.lastInput.Content.Blocks[1].Type != "attachment" ||
		botMsgs.lastInput.Content.Blocks[1].AttachmentID != "att_bot_test_1" {
		t.Fatalf("unexpected message blocks: %+v", botMsgs.lastInput.Content.Blocks)
	}

	// 3. Two-step PUT /api/bot/v2/uploads/{uploadId}/content also succeeds
	putReq := httptest.NewRequest(http.MethodPut, "/api/bot/v2/uploads/upl_bot_test_1/content", bytes.NewBufferString("raw-binary-content"))
	putReq.Header.Set("Authorization", "Bearer "+validTok)
	putRec := httptest.NewRecorder()
	r.ServeHTTP(putRec, putReq)
	if putRec.Code != http.StatusOK || string(botFiles.completedBytes) != "raw-binary-content" {
		t.Fatalf("expected 200 on two-step bot upload content, got %d (%s)", putRec.Code, putRec.Body.String())
	}
}
