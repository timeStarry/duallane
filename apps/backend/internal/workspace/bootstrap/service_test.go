package bootstrap

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/members"
)

type fakeRepository struct {
	snapshot RepositorySnapshot
	role     string
	loadedAt time.Time
	err      error
}

func (repository *fakeRepository) Load(_ context.Context, _ string, role string, at time.Time) (RepositorySnapshot, error) {
	repository.role = role
	repository.loadedAt = at
	return repository.snapshot, repository.err
}

type fakeMembers struct {
	items []members.Member
	input members.ListInput
	err   error
}

func (service *fakeMembers) List(_ context.Context, input members.ListInput) ([]members.Member, error) {
	service.input = input
	return service.items, service.err
}

type fakeConversations struct {
	items []conversations.Conversation
	calls int
	err   error
}

func (service *fakeConversations) ListConversations(context.Context, string, auth.RequestMeta) ([]conversations.Conversation, error) {
	service.calls++
	return service.items, service.err
}

type fakeFiles struct {
	quota        files.QuotaSnapshot
	items        []files.Attachment
	releaseCalls int
	quotaCalls   int
	listCalls    int
	err          error
}

func (service *fakeFiles) ReleaseStaleUploadReservations(context.Context) (int, error) {
	service.releaseCalls++
	return 1, service.err
}

func (service *fakeFiles) GetQuota(context.Context, string) (files.QuotaSnapshot, error) {
	service.quotaCalls++
	return service.quota, service.err
}

func (service *fakeFiles) ListFiles(context.Context, files.ListFilesInput) ([]files.Attachment, error) {
	service.listCalls++
	return service.items, service.err
}

type fakeEvents struct {
	cursor int64
	err    error
}

func (service *fakeEvents) CurrentSeq(context.Context) (int64, error) {
	return service.cursor, service.err
}

func TestGetBuildsLegacyCompatibleOwnerBootstrap(t *testing.T) {
	now := time.Date(2026, 9, 4, 8, 0, 0, 123000000, time.UTC)
	acceptedAt := now.Add(-time.Hour)
	membersService := &fakeMembers{items: []members.Member{
		{ID: "owner", GitHubLogin: "owner-login", DisplayName: "Owner", Kind: "human", Role: "owner", RoleLabel: "空间主人"},
		{ID: "visible-member", GitHubLogin: "member-login", DisplayName: "Member", Kind: "human", Role: "member", RoleLabel: "成员"},
	}}
	repository := &fakeRepository{snapshot: RepositorySnapshot{
		Space: SpaceRecord{ID: DefaultSpaceID, Name: "DualLane", Slug: "default", CreatedBy: "owner", CreatedAt: now.Add(-24 * time.Hour)},
		Invites: []InviteRecord{{ID: "invite-1", CodePreview: "ABCD...WXYZ", DefaultRole: "member", MaxUses: 3, Uses: 2,
			CreatedAt: now.Add(-2 * time.Hour), Acceptances: []InviteAcceptance{{UserID: "visible-member", AcceptedAt: acceptedAt}, {UserID: "hidden-member", AcceptedAt: acceptedAt}}}},
		InviteSummary: InviteSummary{Total: 1, Active: 1, AcceptedUses: 2, AvailableUses: 1},
	}}
	fileService := &fakeFiles{
		quota: files.QuotaSnapshot{UsedToday: 42, RemainingBytes: files.DailyQuotaBytes - 42, DailyQuotaBytes: files.DailyQuotaBytes},
		items: []files.Attachment{{ID: "file-1", Status: "available"}},
	}
	conversationService := &fakeConversations{items: []conversations.Conversation{{ID: "conversation-1", Type: "group"}}}
	service := NewService(ServiceOptions{
		Repository: repository, Members: membersService, Conversations: conversationService,
		Files: fileService, Events: &fakeEvents{cursor: 17}, AppVersion: "1.2.3", Now: func() time.Time { return now },
	})

	result, err := service.Get(context.Background(), "owner", auth.RequestMeta{RequestID: "bootstrap-request"})
	if err != nil {
		t.Fatal(err)
	}
	if result.AppVersion != "1.2.3" || result.Auth.CurrentUser.ID != "owner" || result.Space.ID != DefaultSpaceID || result.EventCursor != 17 {
		t.Fatalf("bootstrap identity = %#v", result)
	}
	if result.Policy.UsedTodayBytes != 42 || result.Policy.RemainingQuotaBytes != files.DailyQuotaBytes-42 || result.Policy.MemberVisibilityBasis != members.MemberVisibilityBasis {
		t.Fatalf("policy = %#v", result.Policy)
	}
	if !result.Permissions.CanCreatePrivilegedInvite || !result.Permissions.CanManageMemberVisibility || result.Permissions.CanViewOperationRecords {
		t.Fatalf("permissions = %#v", result.Permissions)
	}
	if len(result.Conversations) != 1 || len(result.Files) != 1 || len(result.Invites) != 1 {
		t.Fatalf("aggregate sizes = conversations:%d files:%d invites:%d", len(result.Conversations), len(result.Files), len(result.Invites))
	}
	if result.Invites[0].AcceptedMemberCount != 2 || len(result.Invites[0].AcceptedMembers) != 1 {
		t.Fatalf("invite visibility = %#v", result.Invites[0])
	}
	if membersService.input.Meta.RequestID != "bootstrap-request" || repository.role != "owner" || !repository.loadedAt.Equal(now) {
		t.Fatalf("dependency inputs = member:%#v role:%q at:%s", membersService.input, repository.role, repository.loadedAt)
	}
	if fileService.releaseCalls != 1 || fileService.quotaCalls != 1 || fileService.listCalls != 1 || conversationService.calls != 1 {
		t.Fatalf("dependency calls = files:%#v conversations:%d", fileService, conversationService.calls)
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	for _, forbidden := range []string{"hidden-member", "codeHash", "storageKey", "requestId"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("bootstrap leaked %q: %s", forbidden, body)
		}
	}
	if !strings.Contains(body, `"acceptedAt":"2026-09-04T07:00:00.123Z"`) || !strings.Contains(body, `"githubLogin":"member-login"`) {
		t.Fatalf("accepted member projection = %s", body)
	}
}

func TestGetSkipsForbiddenCollectionsForAuditor(t *testing.T) {
	membersService := &fakeMembers{items: []members.Member{{ID: "auditor", Kind: "human", Role: "auditor"}}}
	repository := &fakeRepository{snapshot: RepositorySnapshot{Space: SpaceRecord{ID: DefaultSpaceID}}}
	fileService := &fakeFiles{quota: files.QuotaSnapshot{DailyQuotaBytes: files.DailyQuotaBytes, RemainingBytes: files.DailyQuotaBytes}}
	conversationService := &fakeConversations{err: errors.New("must not be called")}
	service := NewService(ServiceOptions{
		Repository: repository, Members: membersService, Conversations: conversationService,
		Files: fileService, Events: &fakeEvents{},
	})

	result, err := service.Get(context.Background(), "auditor", auth.RequestMeta{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Permissions != (Permissions{}) || conversationService.calls != 0 || fileService.listCalls != 0 {
		t.Fatalf("auditor result = permissions:%#v conversation calls:%d file calls:%d", result.Permissions, conversationService.calls, fileService.listCalls)
	}
	if result.Conversations == nil || result.Files == nil || result.Invites == nil {
		t.Fatalf("empty collections must serialize as arrays: %#v", result)
	}
	if repository.role != "auditor" {
		t.Fatalf("repository role = %q", repository.role)
	}
}

func TestGetRejectsActorMissingFromVisibleMembers(t *testing.T) {
	service := NewService(ServiceOptions{
		Repository: &fakeRepository{}, Members: &fakeMembers{}, Files: &fakeFiles{}, Events: &fakeEvents{},
	})
	_, err := service.Get(context.Background(), "missing", auth.RequestMeta{})
	var authError *auth.Error
	if !errors.As(err, &authError) || authError.Code != auth.CodeRequired {
		t.Fatalf("error = %#v", err)
	}
}

func TestPermissionsMatchLegacyRoleMatrix(t *testing.T) {
	tests := map[string]Permissions{
		"owner": {CanCreateMemberInvite: true, CanCreatePrivilegedInvite: true, CanManageMemberVisibility: true, CanManageEmailSettings: true,
			CanReadConversations: true, CanCreateGroup: true, CanCreateDirect: true, CanUpload: true, CanDownload: true},
		"admin":   {CanCreateMemberInvite: true, CanReadConversations: true, CanCreateGroup: true, CanCreateDirect: true, CanUpload: true, CanDownload: true},
		"member":  {CanReadConversations: true, CanCreateDirect: true, CanUpload: true, CanDownload: true},
		"auditor": {},
	}
	for role, want := range tests {
		if got := permissionsForRole(role); got != want {
			t.Fatalf("role %s permissions = %#v want %#v", role, got, want)
		}
	}
}
