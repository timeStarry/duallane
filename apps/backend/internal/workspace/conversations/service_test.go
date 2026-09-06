package conversations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceMembers "github.com/timestarry/duallane/apps/backend/internal/workspace/members"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type conversationFakeState struct {
	actors              map[string]auth.Actor
	members             map[string]MemberRecord
	conversations       map[string]ConversationRecord
	directKeys          map[string]string
	conversationMembers map[string]map[string]bool
	messages            map[string]MessageRecord
	pins                map[string]PinRecord
	pinCounts           map[string]int
	visible             map[string]bool
	events              []EventInput
	audits              []AuditInput
	locks               []string
	lockHook            func(string)
}

type conversationFakeRepository struct {
	state   *conversationFakeState
	txCalls int
}

type conversationFakeTx struct {
	*conversationFakeRepository
}

func newConversationFake(actor auth.Actor) *conversationFakeRepository {
	return &conversationFakeRepository{state: &conversationFakeState{
		actors:              map[string]auth.Actor{actor.ID: actor},
		members:             make(map[string]MemberRecord),
		conversations:       make(map[string]ConversationRecord),
		directKeys:          make(map[string]string),
		conversationMembers: make(map[string]map[string]bool),
		messages:            make(map[string]MessageRecord),
		pins:                make(map[string]PinRecord),
		pinCounts:           make(map[string]int),
		visible:             make(map[string]bool),
	}}
}

func (f *conversationFakeRepository) WithTx(_ context.Context, callback func(Tx) error) error {
	f.txCalls++
	return callback(&conversationFakeTx{conversationFakeRepository: f})
}

func (f *conversationFakeRepository) LookupActor(_ context.Context, _ string, userID string) (*auth.Actor, error) {
	actor, ok := f.state.actors[userID]
	if !ok {
		return nil, nil
	}
	return &actor, nil
}

func (f *conversationFakeRepository) ListConversationRecords(_ context.Context, _ string, actorID string) ([]ConversationRecord, error) {
	items := make([]ConversationRecord, 0)
	for id, record := range f.state.conversations {
		if f.state.conversationMembers[id][actorID] {
			items = append(items, record)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items, nil
}

func (f *conversationFakeRepository) GetVisibleConversationRecord(_ context.Context, _ string, actorID, conversationID string) (*ConversationRecord, error) {
	if !f.state.conversationMembers[conversationID][actorID] {
		return nil, nil
	}
	record, ok := f.state.conversations[conversationID]
	if !ok {
		return nil, nil
	}
	return &record, nil
}

func (f *conversationFakeRepository) FindConversation(_ context.Context, _ string, conversationID string) (*ConversationRecord, error) {
	record, ok := f.state.conversations[conversationID]
	if !ok {
		return nil, nil
	}
	return &record, nil
}

func (f *conversationFakeRepository) FindDirectConversation(_ context.Context, _ string, directKey string) (*ConversationRecord, error) {
	id := f.state.directKeys[directKey]
	if id == "" {
		return nil, nil
	}
	return f.FindConversation(context.Background(), "", id)
}

func (f *conversationFakeRepository) ListConversationMembers(_ context.Context, _ string, conversationID, _ string) ([]MemberRecord, error) {
	items := make([]MemberRecord, 0)
	for userID, active := range f.state.conversationMembers[conversationID] {
		if active {
			if member, ok := f.state.members[userID]; ok {
				items = append(items, member)
			}
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items, nil
}

func (f *conversationFakeRepository) ListLatestMessages(_ context.Context, _ string, conversationID, _ string, limit int) ([]MessageRecord, error) {
	items := make([]MessageRecord, 0)
	for _, message := range f.state.messages {
		if message.ConversationID == conversationID && message.DeletedAt == nil {
			items = append(items, message)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.Before(items[j].CreatedAt) })
	if limit > 0 && len(items) > limit {
		items = items[len(items)-limit:]
	}
	return items, nil
}

func (f *conversationFakeRepository) ListMessageAttachments(_ context.Context, _, _ string, messageIDs []string) (map[string][]workspaceMessages.AttachmentRecord, error) {
	result := make(map[string][]workspaceMessages.AttachmentRecord, len(messageIDs))
	for _, messageID := range messageIDs {
		message, ok := f.state.messages[messageID]
		if !ok {
			result[messageID] = []workspaceMessages.AttachmentRecord{}
			continue
		}
		result[messageID] = append([]workspaceMessages.AttachmentRecord(nil), message.Attachments...)
	}
	return result, nil
}

func (f *conversationFakeRepository) ListMessageReactions(_ context.Context, _, _ string, messageIDs []string) (map[string][]workspaceMessages.ReactionGroup, error) {
	result := make(map[string][]workspaceMessages.ReactionGroup, len(messageIDs))
	for _, messageID := range messageIDs {
		message, ok := f.state.messages[messageID]
		if !ok {
			result[messageID] = []workspaceMessages.ReactionGroup{}
			continue
		}
		result[messageID] = append([]workspaceMessages.ReactionGroup(nil), message.Reactions...)
	}
	return result, nil
}

func (f *conversationFakeRepository) ListMessageHidden(_ context.Context, _, _ string, messageIDs []string) (map[string]bool, error) {
	result := make(map[string]bool, len(messageIDs))
	for _, messageID := range messageIDs {
		result[messageID] = f.state.messages[messageID].HiddenByCurrentUser
	}
	return result, nil
}

func (f *conversationFakeRepository) FindMember(_ context.Context, _ string, userID string) (*MemberRecord, error) {
	member, ok := f.state.members[userID]
	if !ok {
		return nil, nil
	}
	return &member, nil
}

func (f *conversationFakeRepository) MemberVisible(_ context.Context, _ string, viewerID, visibleUserID string) (bool, error) {
	if viewerID == visibleUserID {
		return true, nil
	}
	actor := f.state.actors[viewerID]
	if actor.Role == "owner" {
		return true, nil
	}
	return f.state.visible[viewerID+":"+visibleUserID], nil
}

func (f *conversationFakeRepository) SharesActiveGroup(_ context.Context, _ string, actorID, targetUserID string) (bool, error) {
	for conversationID, members := range f.state.conversationMembers {
		conversation := f.state.conversations[conversationID]
		if conversation.Type == string(ConversationTypeGroup) && members[actorID] && members[targetUserID] {
			return true, nil
		}
	}
	return false, nil
}

func (f *conversationFakeRepository) ConversationMemberActive(_ context.Context, _ string, conversationID, userID string) (bool, error) {
	return f.state.conversationMembers[conversationID][userID], nil
}

func (f *conversationFakeRepository) CountActiveConversationMembers(_ context.Context, _ string, conversationID string) (int, error) {
	count := 0
	for _, active := range f.state.conversationMembers[conversationID] {
		if active {
			count++
		}
	}
	return count, nil
}

func (f *conversationFakeRepository) FindMessageForPin(_ context.Context, _ string, conversationID, messageID string) (*MessageRecord, error) {
	message, ok := f.state.messages[messageID]
	if !ok || message.ConversationID != conversationID || message.DeletedAt != nil {
		return nil, nil
	}
	return &message, nil
}

func (f *conversationFakeRepository) FindPin(_ context.Context, _ string, conversationID, messageID, _ string) (*PinRecord, error) {
	key := conversationID + ":" + messageID
	pin, ok := f.state.pins[key]
	if !ok {
		return nil, nil
	}
	return &pin, nil
}

func (f *conversationFakeRepository) ListPins(_ context.Context, _ string, conversationID, _ string, limit int) ([]PinRecord, error) {
	items := make([]PinRecord, 0)
	for key, pin := range f.state.pins {
		if len(key) > len(conversationID) && key[:len(conversationID)] == conversationID && key[len(conversationID)] == ':' {
			items = append(items, pin)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (f *conversationFakeTx) Lock(_ context.Context, key string) error {
	f.state.locks = append(f.state.locks, key)
	if f.state.lockHook != nil {
		f.state.lockHook(key)
	}
	return nil
}

func (f *conversationFakeTx) CreateConversation(_ context.Context, record CreateConversationRecord) error {
	f.state.conversations[record.ID] = ConversationRecord{ID: record.ID, SpaceID: record.SpaceID, Type: record.Type, Title: record.Title, AvatarEmoji: record.AvatarEmoji, RetentionCount: record.RetentionCount, CreatedAt: record.CreatedAt, LastActivityAt: record.CreatedAt, NotificationLevel: string(NotificationAll)}
	if record.DirectKey != nil {
		f.state.directKeys[*record.DirectKey] = record.ID
	}
	f.state.conversationMembers[record.ID] = make(map[string]bool)
	return nil
}

func (f *conversationFakeTx) UpsertConversationMember(_ context.Context, _, conversationID, userID string, _ time.Time) (bool, error) {
	if f.state.conversationMembers[conversationID] == nil {
		f.state.conversationMembers[conversationID] = make(map[string]bool)
	}
	wasActive := f.state.conversationMembers[conversationID][userID]
	f.state.conversationMembers[conversationID][userID] = true
	return !wasActive, nil
}

func (f *conversationFakeTx) RemoveConversationMember(_ context.Context, _, conversationID, userID string, _ time.Time) (bool, error) {
	if !f.state.conversationMembers[conversationID][userID] {
		return false, nil
	}
	f.state.conversationMembers[conversationID][userID] = false
	return true, nil
}

func (f *conversationFakeTx) UpdateGroup(_ context.Context, _, conversationID, title string, avatarEmoji *string) error {
	record, ok := f.state.conversations[conversationID]
	if !ok {
		return conversationNotFoundError()
	}
	record.Title = title
	record.AvatarEmoji = avatarEmoji
	f.state.conversations[conversationID] = record
	return nil
}

func (f *conversationFakeTx) CreateSystemMessage(_ context.Context, record SystemMessageInsert, retentionCount int64) (*MessageRecord, error) {
	message := MessageRecord{
		ID:             record.ID,
		ConversationID: record.ConversationID,
		AuthorKind:     "system",
		Kind:           "system",
		ContentJSON:    append([]byte(nil), record.ContentJSON...),
		PlainText:      record.PlainText,
		CreatedAt:      record.CreatedAt,
	}
	f.state.messages[record.ID] = message
	conversation := f.state.conversations[record.ConversationID]
	conversation.MessageCount++
	conversation.LastActivityAt = record.CreatedAt
	f.state.conversations[record.ConversationID] = conversation
	if retentionCount <= 0 {
		retentionCount = DefaultRetentionCount
	}
	retained := make([]MessageRecord, 0)
	for _, candidate := range f.state.messages {
		if candidate.ConversationID == record.ConversationID && candidate.DeletedAt == nil {
			retained = append(retained, candidate)
		}
	}
	sort.Slice(retained, func(i, j int) bool {
		if retained[i].CreatedAt.Equal(retained[j].CreatedAt) {
			return retained[i].ID > retained[j].ID
		}
		return retained[i].CreatedAt.After(retained[j].CreatedAt)
	})
	for _, victim := range retained[intMin(len(retained), int(retentionCount)):] {
		if _, pinned := f.state.pins[record.ConversationID+":"+victim.ID]; pinned {
			continue
		}
		deletedAt := record.CreatedAt
		victim.DeletedAt = &deletedAt
		f.state.messages[victim.ID] = victim
	}
	created := f.state.messages[record.ID]
	if created.DeletedAt != nil {
		return nil, errors.New("system message was removed by retention")
	}
	return &created, nil
}

func intMin(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func (f *conversationFakeTx) MarkConversationRead(_ context.Context, _, conversationID, userID string, now time.Time) (ReadMarker, error) {
	record := f.state.conversations[conversationID]
	marker := ReadMarker{ReadAt: now, Sequence: 1}
	for _, message := range f.state.messages {
		if message.ConversationID == conversationID && (marker.MessageID == nil || message.CreatedAt.After(record.CreatedAt)) {
			id := message.ID
			marker.MessageID = &id
		}
	}
	record.LastReadMessageID = marker.MessageID
	record.LastReadAt = &marker.ReadAt
	record.LastReadSeq = &marker.Sequence
	f.state.conversations[conversationID] = record
	_ = userID
	return marker, nil
}

func (f *conversationFakeTx) UpdateNotificationLevel(_ context.Context, _, conversationID, _, level string) error {
	record := f.state.conversations[conversationID]
	record.NotificationLevel = level
	f.state.conversations[conversationID] = record
	return nil
}

func (f *conversationFakeTx) AddPin(_ context.Context, _, conversationID, messageID, userID string, now time.Time) (bool, error) {
	key := conversationID + ":" + messageID
	if _, exists := f.state.pins[key]; exists {
		return false, nil
	}
	countKey := conversationID + ":" + userID
	if f.state.pinCounts[countKey] >= MaxPinnedMessages {
		return false, nil
	}
	f.state.pinCounts[countKey]++
	message := f.state.messages[messageID]
	f.state.pins[key] = PinRecord{MessageID: messageID, PinnedByUserID: userID, CreatedAt: now, Message: message}
	return true, nil
}

func (f *conversationFakeTx) RemovePin(_ context.Context, _, conversationID, messageID string) (*PinRecord, bool, error) {
	key := conversationID + ":" + messageID
	pin, exists := f.state.pins[key]
	if !exists {
		return nil, false, nil
	}
	delete(f.state.pins, key)
	countKey := conversationID + ":" + pin.PinnedByUserID
	if f.state.pinCounts[countKey] > 0 {
		f.state.pinCounts[countKey]--
	}
	return &pin, true, nil
}

func (f *conversationFakeTx) WriteEvent(_ context.Context, input EventInput) error {
	f.state.events = append(f.state.events, input)
	return nil
}

func (f *conversationFakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	f.state.audits = append(f.state.audits, input)
	return nil
}

var _ Repository = (*conversationFakeRepository)(nil)
var _ Tx = (*conversationFakeTx)(nil)

func TestCreateGroupAllowsSpaceMemberWithoutConversationMembership(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 123000000, time.UTC)
	actor := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Kind: "human", Role: "owner", JoinedAt: now}
	repo.state.members["usr_new"] = MemberRecord{ID: "usr_new", GitHubLogin: "new", DisplayName: "New member", Kind: "human", Role: "member", JoinedAt: now}
	service := NewService(ServiceOptions{Repository: repo, Now: func() time.Time { return now }, IDFactory: func() (string, error) { return "conv_group", nil }})

	conversation, err := service.CreateConversation(context.Background(), CreateConversationInput{ActorID: actor.ID, Type: "group", Title: "New group", MemberIDs: []string{"usr_new"}})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}
	if conversation.ID != "conv_group" || len(conversation.Members) != 2 {
		t.Fatalf("unexpected conversation projection: %#v", conversation)
	}
	if !repo.state.conversationMembers[conversation.ID]["usr_new"] {
		t.Fatal("new space member was not added to conversation")
	}
	if len(repo.state.events) != 3 || len(repo.state.audits) != 1 {
		t.Fatalf("expected creation, member, and system-message events plus audit, got events=%d audits=%d", len(repo.state.events), len(repo.state.audits))
	}
	message := repo.state.messages["conv_group"]
	if message.Kind != "system" || message.AuthorKind != "system" || message.PlainText != "Owner 创建了群聊「New group」" {
		t.Fatalf("unexpected group system message: %#v", message)
	}
}

func TestCreateDirectIsIdempotent(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	actor := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Kind: "human", Role: "owner", JoinedAt: now}
	repo.state.members["usr_new"] = MemberRecord{ID: "usr_new", GitHubLogin: "new", DisplayName: "New member", Kind: "human", Role: "member", JoinedAt: now}
	nextID := 0
	service := NewService(ServiceOptions{Repository: repo, Now: func() time.Time { return now }, IDFactory: func() (string, error) { nextID++; return "conv_direct", nil }})
	input := CreateConversationInput{ActorID: actor.ID, Type: "direct", TargetUserID: "usr_new"}
	first, err := service.CreateConversation(context.Background(), input)
	if err != nil {
		t.Fatalf("first direct create: %v", err)
	}
	second, err := service.CreateConversation(context.Background(), input)
	if err != nil {
		t.Fatalf("second direct create: %v", err)
	}
	if first.ID != second.ID || first.ID != "conv_direct" {
		t.Fatalf("direct creation was not idempotent: first=%q second=%q", first.ID, second.ID)
	}
	if nextID != 2 {
		t.Fatalf("unexpected id factory calls: %d", nextID)
	}
	if len(repo.state.events) != 1 || len(repo.state.audits) != 1 {
		t.Fatalf("duplicate direct create emitted writes: events=%d audits=%d", len(repo.state.events), len(repo.state.audits))
	}
}

func TestCreateDirectProjectsBeaconPeerMetadata(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	actor := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Kind: "human", Role: "owner", JoinedAt: now}
	repo.state.members[workspaceMembers.BeaconUserID] = MemberRecord{ID: workspaceMembers.BeaconUserID, DisplayName: "forged", Kind: "system", Role: "member", JoinedAt: now}
	service := NewService(ServiceOptions{
		Repository: repo,
		Now:        func() time.Time { return now },
		IDFactory:  func() (string, error) { return "conv_beacon", nil },
	})

	conversation, err := service.CreateConversation(context.Background(), CreateConversationInput{
		ActorID:      actor.ID,
		Type:         string(ConversationTypeDirect),
		TargetUserID: workspaceMembers.BeaconUserID,
	})
	if err != nil {
		t.Fatalf("create Beacon direct: %v", err)
	}
	if conversation.OtherMember == nil {
		t.Fatal("direct conversation omitted otherMember")
	}
	if conversation.OtherMember.ID != workspaceMembers.BeaconUserID || conversation.OtherMember.Kind != "bot" || conversation.OtherMember.Description != "文件传输助手" {
		t.Fatalf("Beacon peer projection = %#v", conversation.OtherMember)
	}
	if conversation.DisplayTitle != "信标" {
		t.Fatalf("Beacon direct display title = %q", conversation.DisplayTitle)
	}
}

func TestGroupMutationsWritePublicSystemMessageEvents(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	actor := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Email: "owner@example.com", Kind: "human", Role: "owner", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Kind: "human", Role: "owner", JoinedAt: now}
	repo.state.members["usr_existing"] = MemberRecord{ID: "usr_existing", GitHubLogin: "existing", DisplayName: "Existing Member", Kind: "human", Role: "member", JoinedAt: now}
	repo.state.members["usr_added"] = MemberRecord{ID: "usr_added", GitHubLogin: "added", DisplayName: "Added Member", Kind: "human", Role: "member", JoinedAt: now}
	nextID := 0
	service := NewService(ServiceOptions{
		Repository: repo,
		Now:        func() time.Time { return now },
		IDFactory: func() (string, error) {
			nextID++
			return fmt.Sprintf("group-lifecycle-%02d", nextID), nil
		},
	})

	conversation, err := service.CreateConversation(context.Background(), CreateConversationInput{ActorID: actor.ID, Type: "group", Title: "System group", MemberIDs: []string{"usr_existing"}})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}
	if _, err := service.AddMember(context.Background(), ConversationMemberInput{ActorID: actor.ID, ConversationID: conversation.ID, UserID: "usr_added"}); err != nil {
		t.Fatalf("add member: %v", err)
	}
	avatar := "📌"
	title := "Renamed system group"
	if _, err := service.UpdateGroup(context.Background(), UpdateGroupInput{ActorID: actor.ID, ConversationID: conversation.ID, Title: &title, TitleSet: true, AvatarEmoji: &avatar, AvatarEmojiSet: true}); err != nil {
		t.Fatalf("update group: %v", err)
	}
	if _, err := service.RemoveMember(context.Background(), ConversationMemberInput{ActorID: actor.ID, ConversationID: conversation.ID, UserID: "usr_added"}); err != nil {
		t.Fatalf("remove member: %v", err)
	}
	if _, err := service.Leave(context.Background(), ConversationInput{ActorID: actor.ID, ConversationID: conversation.ID}); err != nil {
		t.Fatalf("leave group: %v", err)
	}

	want := []string{
		"Owner 创建了群聊「System group」",
		"Owner 邀请 Added Member 加入群聊",
		"Owner 将群聊名称改为「Renamed system group」",
		"Owner 将群头像改为 📌",
		"Owner 将 Added Member 移出群聊",
		"Owner 离开了群聊",
	}
	got := make([]string, 0, len(want))
	for _, event := range repo.state.events {
		if event.Type != "message.created" {
			continue
		}
		var payload struct {
			Message struct {
				Kind       string `json:"kind"`
				AuthorKind string `json:"authorKind"`
				PlainText  string `json:"plainText"`
			} `json:"message"`
		}
		if err := json.Unmarshal(event.PayloadJSON, &payload); err != nil {
			t.Fatalf("decode message event: %v", err)
		}
		if payload.Message.Kind != "system" || payload.Message.AuthorKind != "system" {
			t.Fatalf("unexpected system message projection: %#v", payload.Message)
		}
		if strings.Contains(string(event.PayloadJSON), "@example.com") {
			t.Fatalf("system message event leaked private actor data: %s", event.PayloadJSON)
		}
		got = append(got, payload.Message.PlainText)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("system messages = %#v, want %#v", got, want)
	}
	if len(repo.state.messages) != len(want) {
		t.Fatalf("persisted system messages = %d, want %d", len(repo.state.messages), len(want))
	}
	if repo.state.conversationMembers[conversation.ID][actor.ID] {
		t.Fatal("leaving actor still has an active conversation membership")
	}
}

func TestMemberManagementReauthorizesAfterWorkspaceMemberLock(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	actor := auth.Actor{ID: "usr_admin", GitHubLogin: "admin", DisplayName: "Admin", Kind: "human", Role: "admin", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Kind: "human", Role: "admin", JoinedAt: now}
	repo.state.members["usr_target"] = MemberRecord{ID: "usr_target", GitHubLogin: "target", DisplayName: "Target", Kind: "human", Role: "member", JoinedAt: now}
	repo.state.conversations["group"] = ConversationRecord{ID: "group", SpaceID: DefaultSpaceID, Type: "group", Title: "Group", RetentionCount: DefaultRetentionCount, CreatedAt: now, LastActivityAt: now, NotificationLevel: "all"}
	repo.state.conversationMembers["group"] = map[string]bool{actor.ID: true}
	repo.state.lockHook = func(key string) {
		if key != "workspace-members:"+DefaultSpaceID {
			return
		}
		demoted := repo.state.actors[actor.ID]
		demoted.Role = "member"
		repo.state.actors[actor.ID] = demoted
	}

	service := NewService(ServiceOptions{Repository: repo, Now: func() time.Time { return now }})
	_, err := service.AddMember(context.Background(), ConversationMemberInput{ActorID: actor.ID, ConversationID: "group", UserID: "usr_target"})
	if !isCode(err, CodePermissionDenied) {
		t.Fatalf("add member after demotion error = %v, want %s", err, CodePermissionDenied)
	}
	if repo.state.conversationMembers["group"]["usr_target"] {
		t.Fatal("demoted actor added a member after waiting for the workspace lock")
	}
	if len(repo.state.audits) != 1 || repo.state.audits[0].Result != "rejected" || repo.state.audits[0].Reason != "insufficient permission" {
		t.Fatalf("unexpected rejection audit: %#v", repo.state.audits)
	}
}

func TestMissingConversationMembersKeepValidationStatus(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	actor := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Kind: "human", Role: "owner", JoinedAt: now}
	repo.state.conversations["group"] = ConversationRecord{ID: "group", SpaceID: DefaultSpaceID, Type: "group", Title: "Group", RetentionCount: DefaultRetentionCount, CreatedAt: now, LastActivityAt: now, NotificationLevel: "all"}
	repo.state.conversationMembers["group"] = map[string]bool{actor.ID: true}
	service := NewService(ServiceOptions{Repository: repo, Now: func() time.Time { return now }})

	_, err := service.RemoveMember(context.Background(), ConversationMemberInput{ActorID: actor.ID, ConversationID: "group", UserID: "missing"})
	var domainErr *Error
	if !errors.As(err, &domainErr) || domainErr.Code != CodeMemberNotFound || domainErr.StatusCode != 400 {
		t.Fatalf("missing member error = %#v, want member.not_found/400", err)
	}

	repo.state.members["usr_not_joined"] = MemberRecord{ID: "usr_not_joined", GitHubLogin: "not-joined", DisplayName: "Not Joined", Kind: "human", Role: "member", JoinedAt: now}
	_, err = service.RemoveMember(context.Background(), ConversationMemberInput{ActorID: actor.ID, ConversationID: "group", UserID: "usr_not_joined"})
	if !errors.As(err, &domainErr) || domainErr.Code != CodeConversationMemberNotFound || domainErr.StatusCode != 400 {
		t.Fatalf("missing conversation member error = %#v, want conversation.member_not_found/400", err)
	}
}

func TestPinLimitAndDuplicateAreStable(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	actor := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Kind: "human", Role: "owner", JoinedAt: now}
	repo.state.conversations["group"] = ConversationRecord{ID: "group", SpaceID: DefaultSpaceID, Type: "group", Title: "Group", RetentionCount: DefaultRetentionCount, CreatedAt: now, LastActivityAt: now, NotificationLevel: "all"}
	repo.state.conversationMembers["group"] = map[string]bool{actor.ID: true}
	for index := 0; index < 4; index++ {
		id := "msg-" + string(rune('1'+index))
		authorID := actor.ID
		repo.state.messages[id] = MessageRecord{ID: id, ConversationID: "group", AuthorID: &authorID, AuthorName: actor.DisplayName, AuthorKind: "human", Kind: "user", ContentJSON: []byte(`{"format":"duallane.message+json;v=1","plainText":"hello","blocks":[{"type":"text","text":"hello"}]}`), PlainText: "hello", CreatedAt: now.Add(time.Duration(index) * time.Second)}
	}
	service := NewService(ServiceOptions{Repository: repo, Now: func() time.Time { return now }})
	for _, messageID := range []string{"msg-1", "msg-2", "msg-3"} {
		if _, err := service.Pin(context.Background(), PinInput{ActorID: actor.ID, ConversationID: "group", MessageID: messageID}); err != nil {
			t.Fatalf("pin %s: %v", messageID, err)
		}
	}
	if _, err := service.Pin(context.Background(), PinInput{ActorID: actor.ID, ConversationID: "group", MessageID: "msg-4"}); !isCode(err, CodePinLimitReached) {
		t.Fatalf("expected pin limit, got %v", err)
	}
	if len(repo.state.pins) != MaxPinnedMessages || len(repo.state.events) != MaxPinnedMessages || len(repo.state.audits) != MaxPinnedMessages+1 {
		t.Fatalf("pin limit changed successful state unexpectedly: pins=%d events=%d audits=%d", len(repo.state.pins), len(repo.state.events), len(repo.state.audits))
	}
	eventsBeforeDuplicate := len(repo.state.events)
	auditsBeforeDuplicate := len(repo.state.audits)
	if _, err := service.Pin(context.Background(), PinInput{ActorID: actor.ID, ConversationID: "group", MessageID: "msg-1"}); err != nil {
		t.Fatalf("duplicate pin: %v", err)
	}
	if len(repo.state.pins) != MaxPinnedMessages || len(repo.state.events) != eventsBeforeDuplicate || len(repo.state.audits) != auditsBeforeDuplicate {
		t.Fatalf("duplicate pin was not idempotent: pins=%d events=%d audits=%d", len(repo.state.pins), len(repo.state.events), len(repo.state.audits))
	}
}

func TestMemberJSONPreservesHumanNullAndRoleProjection(t *testing.T) {
	actor := &auth.Actor{ID: "viewer", Role: "member"}
	owner := projectMember(MemberRecord{ID: "owner", GitHubLogin: "owner-login", DisplayName: "Owner", Nickname: stringPtr("Owner Nickname"), Remark: stringPtr("Owner Alias"), Kind: "human", Role: "owner"}, actor)
	encoded, err := json.Marshal(owner)
	if err != nil {
		t.Fatalf("marshal owner: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("decode owner: %v", err)
	}
	if value, exists := payload["nickname"]; !exists || value != "Owner Nickname" {
		t.Fatalf("expected human nickname, got %#v", payload["nickname"])
	}
	if payload["role"] != "admin" {
		t.Fatalf("expected owner role projection as admin, got %#v", payload["role"])
	}
	if payload["displayName"] != "Owner Alias" || payload["githubLogin"] != "owner-login" || payload["remark"] != "Owner Alias" {
		t.Fatalf("unexpected human other projection: %#v", payload)
	}
	if _, exists := payload["status"]; exists {
		t.Fatal("status is not part of the compatibility projection")
	}
	capabilities, ok := payload["capabilities"].(map[string]any)
	if !ok || capabilities["canStartDirectConversation"] != true || capabilities["canJoinGroups"] != true || capabilities["canManage"] != false {
		t.Fatalf("unexpected human capabilities: %#v", payload["capabilities"])
	}

	self := projectMember(MemberRecord{ID: "viewer", GitHubLogin: "viewer-login", DisplayName: "Viewer", Nickname: stringPtr(""), Kind: "human", Role: "auditor", SearchDiscoverable: true}, actor)
	encoded, err = json.Marshal(self)
	if err != nil {
		t.Fatalf("marshal human self: %v", err)
	}
	payload = map[string]any{}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("decode human self: %v", err)
	}
	if value, exists := payload["nickname"]; !exists || value != nil {
		t.Fatalf("expected human self nickname:null, got %#v", payload["nickname"])
	}
	if payload["role"] != "auditor" || payload["recallReason"] != "内容有误" || payload["searchDiscoverable"] != true {
		t.Fatalf("unexpected human self projection: %#v", payload)
	}
	if _, exists := payload["remark"]; exists {
		t.Fatal("human self must not expose a viewer remark")
	}

	auditor := projectMember(MemberRecord{ID: "auditor", DisplayName: "Auditor", Kind: "human", Role: "auditor"}, actor)
	if auditor.Role != "member" {
		t.Fatalf("expected auditor role to be hidden from non-owner, got %q", auditor.Role)
	}
	ownerView := projectMember(MemberRecord{ID: "auditor", DisplayName: "Auditor", Kind: "human", Role: "auditor"}, &auth.Actor{ID: "owner", Role: "owner"})
	if ownerView.Role != "auditor" {
		t.Fatalf("owner should see auditor role, got %q", ownerView.Role)
	}
	system := projectMember(MemberRecord{ID: workspaceMembers.BeaconUserID, DisplayName: "forged", Kind: "system", Role: "member"}, &auth.Actor{ID: "owner", Role: "owner"})
	encoded, err = json.Marshal(system)
	if err != nil {
		t.Fatalf("marshal system: %v", err)
	}
	payload = map[string]any{}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("decode system: %v", err)
	}
	if payload["id"] != workspaceMembers.BeaconUserID || payload["displayName"] != "信标" || payload["description"] != "文件传输助手" || payload["avatarUrl"] != "/assets/beacon-avatar.png" || payload["kind"] != "bot" || payload["role"] != "member" {
		t.Fatalf("unexpected system projection: %#v", payload)
	}
	for _, field := range []string{"githubLogin", "nickname", "remark", "searchDiscoverable", "status"} {
		if _, exists := payload[field]; exists {
			t.Fatalf("system projection must omit %s: %#v", field, payload)
		}
	}
}

func TestDefaultIDFactoryFailureIsFailClosed(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	actor := auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, DisplayName: actor.DisplayName, GitHubLogin: actor.GitHubLogin, Kind: "human", Role: "owner", JoinedAt: now}
	repo.state.members["usr_new"] = MemberRecord{ID: "usr_new", DisplayName: "New member", GitHubLogin: "new", Kind: "human", Role: "member", JoinedAt: now}
	previousFactory := defaultConversationIDFactory
	defaultConversationIDFactory = func() (string, error) { return "", errors.New("entropy unavailable") }
	t.Cleanup(func() { defaultConversationIDFactory = previousFactory })
	service := NewService(ServiceOptions{Repository: repo, Now: func() time.Time { return now }})
	_, err := service.CreateConversation(context.Background(), CreateConversationInput{ActorID: actor.ID, Type: "group", Title: "Group", MemberIDs: []string{"usr_new"}})
	if !isCode(err, CodeInternal) {
		t.Fatalf("expected internal error, got %v", err)
	}
	if len(repo.state.conversations) != 0 || len(repo.state.events) != 0 || len(repo.state.audits) != 0 {
		t.Fatalf("failed ID generation changed state: conversations=%d events=%d audits=%d", len(repo.state.conversations), len(repo.state.events), len(repo.state.audits))
	}
}
