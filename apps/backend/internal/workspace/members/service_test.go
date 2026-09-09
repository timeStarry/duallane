package members

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type fakeState struct {
	actors             map[string]auth.Actor
	members            map[string]MemberRecord
	grants             map[string]map[string]bool
	direct             map[string]map[string]bool
	sessions           map[string]bool
	conversations      map[string]bool
	ownerCountOverride *int
	events             []EventInput
	audits             []AuditInput
	locks              []string
}

type fakeRepository struct {
	state    *fakeState
	txCalls  int
	lockHook func(*fakeRepository)
}

type fakeTx struct{ *fakeRepository }

func newFakeRepository(now time.Time, actors ...auth.Actor) *fakeRepository {
	state := &fakeState{
		actors:        make(map[string]auth.Actor),
		members:       make(map[string]MemberRecord),
		grants:        make(map[string]map[string]bool),
		direct:        make(map[string]map[string]bool),
		sessions:      make(map[string]bool),
		conversations: make(map[string]bool),
	}
	repo := &fakeRepository{state: state}
	for _, actor := range actors {
		state.actors[actor.ID] = actor
		state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Nickname: stringPointer(actor.Nickname), AvatarURL: actor.AvatarURL, SearchDiscoverable: actor.SearchDiscoverable, Kind: actor.Kind, Role: actor.Role, JoinedAt: actor.JoinedAt}
	}
	_ = now
	return repo
}

func (f *fakeRepository) WithTx(_ context.Context, callback func(Tx) error) error {
	f.txCalls++
	return callback(&fakeTx{fakeRepository: f})
}

func (f *fakeRepository) LookupActor(_ context.Context, _ string, userID string) (*auth.Actor, error) {
	actor, ok := f.state.actors[userID]
	if !ok || f.state.members[userID].ID == "" {
		return nil, nil
	}
	copy := actor
	if member, ok := f.state.members[userID]; ok {
		copy.Role = member.Role
		copy.Nickname = pointerValue(member.Nickname)
		copy.SearchDiscoverable = member.SearchDiscoverable
	}
	return &copy, nil
}

func (f *fakeRepository) ListMemberRecords(_ context.Context, _ string, viewerID string) ([]MemberRecord, error) {
	items := make([]MemberRecord, 0, len(f.state.members))
	for _, member := range f.state.members {
		if f.isVisible(viewerID, member.ID) || member.SearchDiscoverable {
			copy := member
			copy.NormallyVisible = f.isVisible(viewerID, member.ID)
			items = append(items, copy)
		} else {
			copy := member
			copy.NormallyVisible = false
			items = append(items, copy)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		left, right := roleRank(items[i].Role), roleRank(items[j].Role)
		if left != right {
			return left < right
		}
		if items[i].DisplayName != items[j].DisplayName {
			return items[i].DisplayName < items[j].DisplayName
		}
		return items[i].ID < items[j].ID
	})
	return items, nil
}

func (f *fakeRepository) FindMemberRecord(_ context.Context, _ string, viewerID, userID string) (*MemberRecord, error) {
	member, ok := f.state.members[userID]
	if !ok {
		return nil, nil
	}
	member.NormallyVisible = f.isVisible(viewerID, userID)
	copy := member
	return &copy, nil
}

func (f *fakeRepository) GetVisibilityRule(_ context.Context, _ string, viewerID string) (VisibilityRule, error) {
	rule := VisibilityRule{Basis: MemberVisibilityBasis, ViewerUserID: viewerID, AutomaticUserIDs: []string{}, GrantedUserIDs: []string{}, VisibleUserIDs: []string{viewerID}}
	seen := map[string]bool{viewerID: true}
	if peers := f.state.direct[viewerID]; peers != nil {
		ids := make([]string, 0, len(peers))
		for id, active := range peers {
			if active {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			if !seen[id] {
				seen[id] = true
				rule.AutomaticUserIDs = append(rule.AutomaticUserIDs, id)
				rule.VisibleUserIDs = append(rule.VisibleUserIDs, id)
			}
		}
	}
	for _, id := range []string{BeaconUserID, EchoUserID} {
		if _, active := f.state.members[id]; active && !seen[id] {
			seen[id] = true
			rule.AutomaticUserIDs = append(rule.AutomaticUserIDs, id)
			rule.VisibleUserIDs = append(rule.VisibleUserIDs, id)
		}
	}
	if grants := f.state.grants[viewerID]; grants != nil {
		ids := make([]string, 0, len(grants))
		for id, active := range grants {
			if active && id != BeaconUserID && id != EchoUserID {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			rule.GrantedUserIDs = append(rule.GrantedUserIDs, id)
			if !seen[id] {
				seen[id] = true
				rule.VisibleUserIDs = append(rule.VisibleUserIDs, id)
			}
		}
	}
	return rule, nil
}

func (f *fakeRepository) CountActiveOwners(_ context.Context, _ string) (int, error) {
	if f.state.ownerCountOverride != nil {
		return *f.state.ownerCountOverride, nil
	}
	count := 0
	for _, member := range f.state.members {
		if member.Role == RoleOwner {
			count++
		}
	}
	return count, nil
}

func (f *fakeRepository) isVisible(viewerID, targetID string) bool {
	if viewerID == targetID {
		return true
	}
	actor := f.state.actors[viewerID]
	if actor.Role == RoleOwner {
		return true
	}
	if targetID == BeaconUserID || targetID == EchoUserID {
		_, active := f.state.members[targetID]
		return active
	}
	return f.state.direct[viewerID][targetID] || f.state.grants[viewerID][targetID]
}

func (f *fakeTx) Lock(_ context.Context, key string) error {
	f.state.locks = append(f.state.locks, key)
	if f.lockHook != nil {
		f.lockHook(f.fakeRepository)
		f.lockHook = nil
	}
	return nil
}

func (f *fakeTx) UpdateOwnProfile(_ context.Context, _ string, userID string, nicknameSet bool, nickname *string, discoverableSet bool, discoverable *bool, recallReasonSet bool, recallReason *string) error {
	member := f.state.members[userID]
	if nicknameSet {
		member.Nickname = nullableCopy(nickname)
	}
	if discoverableSet && discoverable != nil {
		member.SearchDiscoverable = *discoverable
	}
	if recallReasonSet {
		member.RecallReason = nullableCopy(recallReason)
	}
	f.state.members[userID] = member
	return nil
}

func (f *fakeTx) UpsertRemark(_ context.Context, ownerUserID, targetUserID, remark string, _ time.Time) error {
	member := f.state.members[targetUserID]
	member.Remark = stringPointer(remark)
	f.state.members[targetUserID] = member
	_ = ownerUserID
	return nil
}

func (f *fakeTx) DeleteRemark(_ context.Context, ownerUserID, targetUserID string) error {
	member := f.state.members[targetUserID]
	member.Remark = nil
	f.state.members[targetUserID] = member
	_ = ownerUserID
	return nil
}

func (f *fakeTx) ReplaceVisibilityGrants(_ context.Context, _ string, viewerUserID, _ string, visibleUserIDs []string, _ time.Time) error {
	f.state.grants[viewerUserID] = make(map[string]bool)
	for _, id := range visibleUserIDs {
		if id != viewerUserID && id != BeaconUserID && id != EchoUserID {
			f.state.grants[viewerUserID][id] = true
		}
	}
	return nil
}

func (f *fakeTx) UpdateMemberRole(_ context.Context, _ string, userID, role string) error {
	member := f.state.members[userID]
	member.Role = role
	f.state.members[userID] = member
	return nil
}

func (f *fakeTx) RemoveMember(_ context.Context, _ string, userID string, _ time.Time) (bool, error) {
	if _, ok := f.state.members[userID]; !ok {
		return false, nil
	}
	delete(f.state.members, userID)
	return true, nil
}

func (f *fakeTx) RevokeUserConversationMemberships(_ context.Context, userID string, _ time.Time) error {
	f.state.conversations[userID] = false
	return nil
}

func (f *fakeTx) RevokeUserSessions(_ context.Context, userID string, _ time.Time) error {
	f.state.sessions[userID] = false
	return nil
}

func (f *fakeTx) WriteEvent(_ context.Context, input EventInput) error {
	f.state.events = append(f.state.events, input)
	return nil
}

func (f *fakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	f.state.audits = append(f.state.audits, input)
	return nil
}

func roleRank(role string) int {
	switch role {
	case RoleOwner:
		return 1
	case RoleAdmin:
		return 2
	case RoleAuditor:
		return 3
	default:
		return 4
	}
}

func stringPointer(value string) *string { return &value }

func nullableCopy(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	var domainErr *Error
	if !errors.As(err, &domainErr) || domainErr.Code != code {
		t.Fatalf("error = %v, want %s", err, code)
	}
}

func assertStatus(t *testing.T, err error, statusCode int) {
	t.Helper()
	var domainErr *Error
	if !errors.As(err, &domainErr) {
		t.Fatalf("error = %v, want member error with status %d", err, statusCode)
	}
	if domainErr.StatusCode != statusCode {
		t.Fatalf("error = %v, status = %d, want %d", err, domainErr.StatusCode, statusCode)
	}
}

func testService(repo Repository, now time.Time) *Service {
	var sequence int
	return NewService(ServiceOptions{
		Repository: repo,
		Now:        func() time.Time { return now },
		IDFactory: func() (string, error) {
			sequence++
			return "member-test-id-" + string(rune('a'+sequence)), nil
		},
	})
}

func TestListProjectionAndDiscoverableSearch(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 34, 56, 789654321, time.FixedZone("CST", 8*60*60))
	owner := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Email: "owner@example.test", Kind: "human", Role: RoleOwner, JoinedAt: now}
	viewer := auth.Actor{ID: "usr_viewer", GitHubLogin: "viewer", DisplayName: "Viewer", Kind: "human", Role: RoleMember, JoinedAt: now}
	target := auth.Actor{ID: "usr_target", GitHubLogin: "TargetLogin", DisplayName: "Target", Kind: "human", Role: RoleMember, JoinedAt: now}
	repo := newFakeRepository(now, owner, viewer, target)
	repo.state.members[target.ID] = MemberRecord{ID: target.ID, GitHubLogin: target.GitHubLogin, DisplayName: target.DisplayName, Nickname: stringPointer("HiddenTarget"), SearchDiscoverable: true, Kind: "human", Role: RoleMember, JoinedAt: now}
	service := testService(repo, now)
	items, err := service.List(context.Background(), ListInput{ActorID: viewer.ID, Options: ListOptions{Query: "t"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("one-character discovery returned %d members, want no matching members", len(items))
	}
	items, err = service.List(context.Background(), ListInput{ActorID: viewer.ID, Options: ListOptions{Query: "hi"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != target.ID {
		t.Fatalf("discoverable search = %#v, want target", items)
	}
	if items[0].Capabilities.CanJoinGroups {
		t.Fatal("discovery-only member may not join groups")
	}
	encoded, err := json.Marshal(items[0])
	if err != nil {
		t.Fatal(err)
	}
	wire := string(encoded)
	if strings.Contains(wire, "email") || strings.Contains(wire, "github_id") {
		t.Fatalf("private identity leaked in member projection: %s", wire)
	}
	if !strings.Contains(wire, `"joinedAt":"2026-09-04T04:34:56.789Z"`) {
		t.Fatalf("joinedAt is not UTC milliseconds: %s", wire)
	}
}

func TestProfileRemarkAndVisibilityAudit(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 123456789, time.UTC)
	owner := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: RoleOwner, JoinedAt: now}
	viewer := auth.Actor{ID: "usr_viewer", GitHubLogin: "viewer", DisplayName: "Viewer", Kind: "human", Role: RoleMember, JoinedAt: now}
	target := auth.Actor{ID: "usr_target", GitHubLogin: "target", DisplayName: "Target", Kind: "human", Role: RoleMember, JoinedAt: now}
	repo := newFakeRepository(now, owner, viewer, target)
	service := testService(repo, now)
	nickname := "  新昵称  "
	discoverable := true
	recallReason := "  内容不准确  "
	updated, err := service.UpdateOwnProfile(context.Background(), UpdateOwnProfileInput{ActorID: owner.ID, Nickname: &nickname, SearchDiscoverable: &discoverable, RecallReason: &recallReason, Meta: auth.RequestMeta{RequestID: "req-profile", IPAddress: "192.0.2.4:443", UserAgent: "member-test"}})
	if err != nil {
		t.Fatal(err)
	}
	if updated.DisplayName != "新昵称" || updated.SearchDiscoverable == nil || !*updated.SearchDiscoverable || updated.RecallReason != "内容不准确" {
		t.Fatalf("updated profile = %#v", updated)
	}
	if len(repo.state.events) != 1 || repo.state.events[0].Type != "workspace.member_updated" || len(repo.state.audits) != 1 || repo.state.audits[0].Action != "profile.update" {
		t.Fatalf("profile records events=%#v audits=%#v", repo.state.events, repo.state.audits)
	}
	if repo.state.audits[0].RequestID != "req-profile" || repo.state.audits[0].IPAddress != "192.0.2.4" || repo.state.audits[0].UserAgent != "member-test" {
		t.Fatalf("audit metadata = %#v", repo.state.audits[0])
	}

	repo.state.direct[owner.ID] = map[string]bool{target.ID: true}
	remarked, err := service.UpdateMemberRemark(context.Background(), RemarkInput{ActorID: owner.ID, UserID: target.ID, Remark: "工作伙伴"})
	if err != nil || remarked.DisplayName != "工作伙伴" || remarked.Remark == nil {
		t.Fatalf("remarked member = %#v, err=%v", remarked, err)
	}
	cleared, err := service.RemoveMemberRemark(context.Background(), RemarkInput{ActorID: owner.ID, UserID: target.ID})
	if err != nil || cleared.Remark != nil {
		t.Fatalf("cleared remark = %#v, err=%v", cleared, err)
	}
	clearedProfile, err := service.UpdateOwnProfile(context.Background(), UpdateOwnProfileInput{ActorID: owner.ID, RecallReasonSet: true, Meta: auth.RequestMeta{RequestID: "req-recall-clear"}})
	if err != nil || clearedProfile.RecallReason != "内容有误" {
		t.Fatalf("cleared recall reason = %#v, err=%v", clearedProfile, err)
	}
	if len(repo.state.events) != 2 || len(repo.state.audits) != 2 || repo.state.audits[1].Action != "profile.recall_reason_update" {
		t.Fatalf("recall clear records events=%#v audits=%#v", repo.state.events, repo.state.audits)
	}

	visibility, err := service.UpdateVisibility(context.Background(), VisibilityInput{ActorID: owner.ID, ViewerUserID: viewer.ID, VisibleUserIDs: []string{target.ID, target.ID, BeaconUserID}, Meta: auth.RequestMeta{RequestID: "req-visibility"}})
	if err != nil || len(visibility.GrantedUserIDs) != 1 || visibility.GrantedUserIDs[0] != target.ID {
		t.Fatalf("visibility = %#v, err=%v", visibility, err)
	}
	if len(repo.state.events) != 3 || repo.state.events[2].Type != "workspace.member_visibility_updated" || len(repo.state.audits) != 3 || repo.state.audits[2].Action != "member.visibility_update" {
		t.Fatalf("visibility records events=%#v audits=%#v", repo.state.events, repo.state.audits)
	}
	tooLongRecall := strings.Repeat("x", 17)
	if _, err := service.UpdateOwnProfile(context.Background(), UpdateOwnProfileInput{ActorID: owner.ID, RecallReason: &tooLongRecall}); err == nil {
		t.Fatal("overlong recall reason unexpectedly accepted")
	} else {
		assertCode(t, err, CodeProfileRecallReasonInvalid)
	}
	if len(repo.state.events) != 3 || len(repo.state.audits) != 3 {
		t.Fatal("invalid recall reason created state or audit records")
	}
}

func TestRoleAndRemovalEnforceLastOwnerAndRevokeMembership(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	owner := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: RoleOwner, JoinedAt: now}
	secondOwner := auth.Actor{ID: "usr_second", GitHubLogin: "second", DisplayName: "Second", Kind: "human", Role: RoleOwner, JoinedAt: now}
	thirdOwner := auth.Actor{ID: "usr_third", GitHubLogin: "third", DisplayName: "Third", Kind: "human", Role: RoleOwner, JoinedAt: now}
	target := auth.Actor{ID: "usr_target", GitHubLogin: "target", DisplayName: "Target", Kind: "human", Role: RoleMember, JoinedAt: now}
	repo := newFakeRepository(now, owner, secondOwner, thirdOwner, target)
	repo.state.members[BeaconUserID] = MemberRecord{ID: BeaconUserID, GitHubLogin: "__duallane_beacon__", DisplayName: "信标", Kind: "bot", Role: RoleMember, JoinedAt: now}
	repo.state.sessions[target.ID] = true
	repo.state.conversations[target.ID] = true
	service := testService(repo, now)
	updated, err := service.UpdateMemberRole(context.Background(), RoleInput{ActorID: owner.ID, UserID: target.ID, Role: RoleAdmin, Meta: auth.RequestMeta{RequestID: "req-role"}})
	if err != nil || updated.Role != RoleAdmin {
		t.Fatalf("role update = %#v, err=%v", updated, err)
	}
	if len(repo.state.events) != 1 || !strings.Contains(string(repo.state.events[0].PayloadJSON), `"member"`) {
		t.Fatalf("role event payload = %s", repo.state.events[0].PayloadJSON)
	}
	if _, err := service.RemoveMember(context.Background(), RemoveInput{ActorID: owner.ID, UserID: secondOwner.ID}); err != nil {
		t.Fatalf("second owner removal: %v", err)
	}
	lastOwner := 1
	repo.state.ownerCountOverride = &lastOwner
	if _, err := service.RemoveMember(context.Background(), RemoveInput{ActorID: owner.ID, UserID: thirdOwner.ID}); err == nil {
		t.Fatal("last owner removal unexpectedly succeeded")
	} else {
		assertCode(t, err, CodeMemberLastOwner)
	}
	if len(repo.state.audits) != 3 || repo.state.audits[2].Reason != "last owner" {
		t.Fatalf("last-owner audit = %#v", repo.state.audits)
	}
	removed, err := service.RemoveMember(context.Background(), RemoveInput{ActorID: owner.ID, UserID: target.ID, Meta: auth.RequestMeta{RequestID: "req-remove"}})
	if err != nil || !removed.OK || removed.UserID != target.ID || removed.RemovedAt != "2026-09-04T10:00:00.000Z" {
		t.Fatalf("remove = %#v, err=%v", removed, err)
	}
	if repo.state.sessions[target.ID] || repo.state.conversations[target.ID] {
		t.Fatal("member removal did not revoke dependent memberships")
	}
	if len(repo.state.events) != 3 || repo.state.events[2].Type != "workspace.member_removed" || repo.state.audits[len(repo.state.audits)-1].Action != "member.remove" {
		t.Fatalf("removal records events=%#v audits=%#v", repo.state.events, repo.state.audits)
	}
	if _, err := service.RemoveMember(context.Background(), RemoveInput{ActorID: owner.ID, UserID: BeaconUserID}); err == nil {
		t.Fatal("system identity removal unexpectedly succeeded")
	} else {
		assertCode(t, err, CodeMemberSystemManaged)
	}
}

func TestInvalidProfileAndPermissionRejections(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	member := auth.Actor{ID: "usr_member", GitHubLogin: "member", DisplayName: "Member", Kind: "human", Role: RoleMember, JoinedAt: now}
	target := auth.Actor{ID: "usr_target", GitHubLogin: "target", DisplayName: "Target", Kind: "human", Role: RoleMember, JoinedAt: now}
	repo := newFakeRepository(now, member, target)
	service := testService(repo, now)
	bad := "\u202eunsafe"
	if _, err := service.UpdateOwnProfile(context.Background(), UpdateOwnProfileInput{ActorID: member.ID, Nickname: &bad}); err == nil {
		t.Fatal("bidi nickname unexpectedly accepted")
	} else {
		assertCode(t, err, CodeProfileNicknameInvalid)
	}
	if _, err := service.UpdateVisibility(context.Background(), VisibilityInput{ActorID: member.ID, ViewerUserID: target.ID, VisibleUserIDs: []string{target.ID}}); err == nil {
		t.Fatal("member visibility update unexpectedly succeeded")
	} else {
		assertCode(t, err, CodePermissionDenied)
	}
	if len(repo.state.audits) != 1 || repo.state.audits[0].Action != CapabilityVisibilityManage || repo.state.audits[0].Result != "rejected" {
		t.Fatalf("permission audit = %#v", repo.state.audits)
	}
	assertStatus(t, memberNotFoundError(), 400)
}

func TestRoleUpdateReauthorizesActorAfterWaitingForLock(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	owner := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: RoleOwner, JoinedAt: now}
	target := auth.Actor{ID: "usr_target", GitHubLogin: "target", DisplayName: "Target", Kind: "human", Role: RoleMember, JoinedAt: now}
	repo := newFakeRepository(now, owner, target)
	repo.lockHook = func(repository *fakeRepository) {
		member := repository.state.members[owner.ID]
		member.Role = RoleMember
		repository.state.members[owner.ID] = member
	}
	service := testService(repo, now)

	_, err := service.UpdateMemberRole(context.Background(), RoleInput{ActorID: owner.ID, UserID: target.ID, Role: RoleAdmin})
	assertCode(t, err, CodePermissionDenied)
	if repo.state.members[target.ID].Role != RoleMember {
		t.Fatalf("target role = %q, want unchanged member", repo.state.members[target.ID].Role)
	}
	if len(repo.state.audits) != 1 || repo.state.audits[0].Reason != "insufficient permission" {
		t.Fatalf("reauthorization audit = %#v", repo.state.audits)
	}
}
