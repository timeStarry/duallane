package messages

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
)

type fakeReaction struct {
	messageID string
	userID    string
	emoteKey  string
	createdAt time.Time
}

type advancedBlockValidatorFunc func(context.Context, *auth.Actor, string, Block) (Block, error)

func (fn advancedBlockValidatorFunc) ValidateBlock(ctx context.Context, actor *auth.Actor, conversationID string, block Block) (Block, error) {
	return fn(ctx, actor, conversationID, block)
}

type fakeRepo struct {
	mu sync.Mutex

	actors         map[string]*auth.Actor
	conversations  map[string]*ConversationRecord
	members        map[string]map[string]bool
	messages       map[string]*MessageRecord
	byClient       map[string]string
	attachments    map[string]*AttachmentRecord
	messageFiles   map[string][]string
	mentions       map[string]map[string]*MentionMember
	reactions      []fakeReaction
	hidden         map[string]bool
	pins           map[string]bool
	customEmotes   map[string]bool
	shares         map[string]bool
	customEmoteIDs map[string][]string
	shareIDs       map[string][]string
	events         []EventInput
	audits         []AuditInput
	nextSeq        int64
	messageJobs    []messagejobs.Input

	failEvent bool
	failJobs  bool
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		actors:         make(map[string]*auth.Actor),
		conversations:  make(map[string]*ConversationRecord),
		members:        make(map[string]map[string]bool),
		messages:       make(map[string]*MessageRecord),
		byClient:       make(map[string]string),
		attachments:    make(map[string]*AttachmentRecord),
		messageFiles:   make(map[string][]string),
		mentions:       make(map[string]map[string]*MentionMember),
		hidden:         make(map[string]bool),
		pins:           make(map[string]bool),
		customEmotes:   make(map[string]bool),
		shares:         make(map[string]bool),
		customEmoteIDs: make(map[string][]string),
		shareIDs:       make(map[string][]string),
	}
}

func (f *fakeRepo) WithTx(_ context.Context, fn func(Tx) error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	snapshot := f.cloneLocked()
	if err := fn(&fakeTx{repo: f}); err != nil {
		f.restoreLocked(snapshot)
		return err
	}
	return nil
}

func (f *fakeRepo) LookupActor(_ context.Context, _, userID string) (*auth.Actor, error) {
	actor := f.actors[userID]
	if actor == nil {
		return nil, nil
	}
	copy := *actor
	return &copy, nil
}

func (f *fakeRepo) GetConversation(_ context.Context, _, conversationID string) (*ConversationRecord, error) {
	conversation := f.conversations[conversationID]
	if conversation == nil {
		return nil, nil
	}
	copy := *conversation
	return &copy, nil
}

func (f *fakeRepo) ConversationMemberActive(_ context.Context, _, conversationID, userID string) (bool, error) {
	return f.members[conversationID][userID], nil
}

func (f *fakeRepo) FindMessage(_ context.Context, _, conversationID, messageID string) (*MessageRecord, error) {
	return f.findMessage(conversationID, messageID, "")
}

func (f *fakeRepo) FindMessageForViewer(_ context.Context, _, conversationID, messageID, _ string) (*MessageRecord, error) {
	return f.findMessage(conversationID, messageID, "")
}

func (f *fakeRepo) findMessage(conversationID, messageID, _ string) (*MessageRecord, error) {
	record := f.messages[messageID]
	if record == nil || (conversationID != "" && record.ConversationID != conversationID) {
		return nil, nil
	}
	copy := cloneMessageRecord(record)
	return copy, nil
}

func (f *fakeRepo) FindMessageByClientID(_ context.Context, _, conversationID, actorID, clientMessageID string) (*MessageRecord, error) {
	id := f.byClient[clientKey(conversationID, actorID, clientMessageID)]
	return f.findMessage(conversationID, id, "")
}

func (f *fakeRepo) MessageExists(_ context.Context, _, conversationID, messageID string) (bool, error) {
	record := f.messages[messageID]
	return record != nil && record.ConversationID == conversationID, nil
}

func (f *fakeRepo) ListMessages(_ context.Context, options ListOptions) ([]MessageRecord, error) {
	all := make([]MessageRecord, 0)
	for _, record := range f.messages {
		if record.ConversationID != options.ConversationID || record.DeletedAt != nil {
			continue
		}
		all = append(all, *cloneMessageRecord(record))
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].CreatedAt.Equal(all[j].CreatedAt) {
			return all[i].ID < all[j].ID
		}
		return all[i].CreatedAt.Before(all[j].CreatedAt)
	})
	limit := normalizeLimit(options.Limit)
	if around := strings.TrimSpace(options.Around); around != "" {
		index := indexOfMessage(all, around)
		if index < 0 {
			return []MessageRecord{}, nil
		}
		side := (limit - 1) / 2
		if side < 1 {
			side = 1
		}
		start, end := index-side, index+side+1
		if start < 0 {
			start = 0
		}
		if end > len(all) {
			end = len(all)
		}
		return append([]MessageRecord(nil), all[start:end]...), nil
	}
	if before := strings.TrimSpace(options.Before); before != "" {
		index := indexOfMessage(all, before)
		if index < 0 {
			return []MessageRecord{}, nil
		}
		start := index - limit
		if start < 0 {
			start = 0
		}
		return append([]MessageRecord(nil), all[start:index]...), nil
	}
	if after := strings.TrimSpace(options.After); after != "" {
		index := indexOfMessage(all, after)
		if index < 0 {
			return []MessageRecord{}, nil
		}
		end := index + 1 + limit
		if end > len(all) {
			end = len(all)
		}
		return append([]MessageRecord(nil), all[index+1:end]...), nil
	}
	start := len(all) - limit
	if start < 0 {
		start = 0
	}
	return append([]MessageRecord(nil), all[start:]...), nil
}

func (f *fakeRepo) ListAttachments(_ context.Context, _, _ string, messageIDs []string) (map[string][]AttachmentRecord, error) {
	result := make(map[string][]AttachmentRecord, len(messageIDs))
	for _, messageID := range messageIDs {
		result[messageID] = make([]AttachmentRecord, 0)
		for _, attachmentID := range f.messageFiles[messageID] {
			if attachment := f.attachments[attachmentID]; attachment != nil {
				result[messageID] = append(result[messageID], *attachment)
			}
		}
	}
	return result, nil
}

func (f *fakeRepo) ListReactions(_ context.Context, _, viewerID string, messageIDs []string) (map[string][]ReactionGroup, error) {
	result := make(map[string][]ReactionGroup, len(messageIDs))
	for _, messageID := range messageIDs {
		result[messageID] = make([]ReactionGroup, 0)
	}
	groupIndexes := make(map[string]int)
	for _, reaction := range f.reactions {
		if !containsString(messageIDs, reaction.messageID) {
			continue
		}
		key := reaction.messageID + "\x00" + reaction.emoteKey
		groupIndex, ok := groupIndexes[key]
		if !ok {
			result[reaction.messageID] = append(result[reaction.messageID], ReactionGroup{EmoteKey: reaction.emoteKey, Users: make([]ReactionUser, 0)})
			groupIndex = len(result[reaction.messageID]) - 1
			groupIndexes[key] = groupIndex
		}
		group := &result[reaction.messageID][groupIndex]
		group.Count++
		if reaction.userID == viewerID {
			group.ReactedByCurrentUser = true
		}
		actor := f.actors[reaction.userID]
		name := "成员"
		githubLogin := ""
		if actor != nil {
			name = firstNonEmpty(actor.Nickname, actor.GitHubLogin, actor.DisplayName, "成员")
			githubLogin = actor.GitHubLogin
		}
		group.Users = append(group.Users, ReactionUser{ID: reaction.userID, DisplayName: name, GitHubLogin: githubLogin, CreatedAt: formatTimestamp(reaction.createdAt)})
	}
	return result, nil
}

func (f *fakeRepo) ListHidden(_ context.Context, _, viewerID string, messageIDs []string) (map[string]bool, error) {
	result := make(map[string]bool, len(messageIDs))
	for _, messageID := range messageIDs {
		result[messageID] = f.hidden[hiddenKey(viewerID, messageID)]
	}
	return result, nil
}

func (f *fakeRepo) FindMentionMember(_ context.Context, _, conversationID, userID string) (*MentionMember, error) {
	member := f.mentions[conversationID][userID]
	if member == nil {
		return nil, nil
	}
	copy := *member
	return &copy, nil
}

func (f *fakeRepo) FindAttachment(_ context.Context, _, attachmentID string) (*AttachmentRecord, error) {
	attachment := f.attachments[attachmentID]
	if attachment == nil {
		return nil, nil
	}
	copy := *attachment
	return &copy, nil
}

func (f *fakeRepo) LookupRecallReason(_ context.Context, _, userID string) (string, error) {
	_ = userID
	return "", nil
}

type fakeTx struct{ repo *fakeRepo }

func (t *fakeTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return t.repo.LookupActor(ctx, spaceID, userID)
}
func (t *fakeTx) GetConversation(ctx context.Context, spaceID, id string) (*ConversationRecord, error) {
	return t.repo.GetConversation(ctx, spaceID, id)
}
func (t *fakeTx) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	return t.repo.ConversationMemberActive(ctx, spaceID, conversationID, userID)
}
func (t *fakeTx) FindMessage(ctx context.Context, spaceID, conversationID, id string) (*MessageRecord, error) {
	return t.repo.FindMessage(ctx, spaceID, conversationID, id)
}
func (t *fakeTx) FindMessageForViewer(ctx context.Context, spaceID, conversationID, id, viewerID string) (*MessageRecord, error) {
	return t.repo.FindMessageForViewer(ctx, spaceID, conversationID, id, viewerID)
}
func (t *fakeTx) FindMessageByClientID(ctx context.Context, spaceID, conversationID, actorID, clientID string) (*MessageRecord, error) {
	return t.repo.FindMessageByClientID(ctx, spaceID, conversationID, actorID, clientID)
}
func (t *fakeTx) MessageExists(ctx context.Context, spaceID, conversationID, id string) (bool, error) {
	return t.repo.MessageExists(ctx, spaceID, conversationID, id)
}
func (t *fakeTx) ListMessages(ctx context.Context, options ListOptions) ([]MessageRecord, error) {
	return t.repo.ListMessages(ctx, options)
}
func (t *fakeTx) ListAttachments(ctx context.Context, spaceID, viewerID string, ids []string) (map[string][]AttachmentRecord, error) {
	return t.repo.ListAttachments(ctx, spaceID, viewerID, ids)
}
func (t *fakeTx) ListReactions(ctx context.Context, spaceID, viewerID string, ids []string) (map[string][]ReactionGroup, error) {
	return t.repo.ListReactions(ctx, spaceID, viewerID, ids)
}
func (t *fakeTx) ListHidden(ctx context.Context, spaceID, viewerID string, ids []string) (map[string]bool, error) {
	return t.repo.ListHidden(ctx, spaceID, viewerID, ids)
}
func (t *fakeTx) FindMentionMember(ctx context.Context, spaceID, conversationID, userID string) (*MentionMember, error) {
	return t.repo.FindMentionMember(ctx, spaceID, conversationID, userID)
}
func (t *fakeTx) FindAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error) {
	return t.repo.FindAttachment(ctx, spaceID, attachmentID)
}
func (t *fakeTx) LookupRecallReason(ctx context.Context, spaceID, userID string) (string, error) {
	return t.repo.LookupRecallReason(ctx, spaceID, userID)
}
func (t *fakeTx) Lock(context.Context, string) error { return nil }

func (t *fakeTx) InsertMessage(_ context.Context, record MessageInsert) (bool, *MessageRecord, error) {
	key := clientKey(record.ConversationID, record.AuthorID, record.ClientMessageID)
	if existingID := t.repo.byClient[key]; existingID != "" {
		return false, cloneMessageRecord(t.repo.messages[existingID]), nil
	}
	recordCopy := &MessageRecord{
		ID:               record.ID,
		SpaceID:          record.SpaceID,
		ConversationID:   record.ConversationID,
		AuthorID:         stringPointer(&record.AuthorID),
		AuthorKind:       record.AuthorKind,
		Kind:             record.Kind,
		ClientMessageID:  stringPointer(&record.ClientMessageID),
		ContentJSON:      append([]byte(nil), record.ContentJSON...),
		PlainText:        record.PlainText,
		ReplyToMessageID: stringPointer(record.ReplyToMessageID),
		CreatedAt:        record.CreatedAt,
		Revision:         1,
	}
	t.repo.messages[record.ID] = recordCopy
	t.repo.byClient[key] = record.ID
	return true, nil, nil
}

func (t *fakeTx) LinkMessageAttachment(_ context.Context, _, messageID, attachmentID string) error {
	t.repo.messageFiles[messageID] = append(t.repo.messageFiles[messageID], attachmentID)
	return nil
}
func (t *fakeTx) LinkMessageCustomEmote(_ context.Context, messageID, _ string, customEmoteID string) error {
	t.repo.customEmotes[messageID] = true
	t.repo.customEmoteIDs[messageID] = append(t.repo.customEmoteIDs[messageID], customEmoteID)
	return nil
}
func (t *fakeTx) LinkMessageEmoteCollectionShare(_ context.Context, messageID, shareID string) error {
	t.repo.shares[messageID] = true
	t.repo.shareIDs[messageID] = append(t.repo.shareIDs[messageID], shareID)
	return nil
}
func (t *fakeTx) EnforceRetention(context.Context, string, string, int64, time.Time) error {
	return nil
}
func (t *fakeTx) RecallMessage(_ context.Context, _, messageID string, expectedRevision int64, contentJSON []byte, plainText, reason string, now time.Time) (bool, error) {
	record := t.repo.messages[messageID]
	if record == nil || record.RecalledAt != nil || (expectedRevision > 0 && expectedRevision != record.Revision) {
		return false, nil
	}
	record.ContentJSON = append([]byte(nil), contentJSON...)
	record.PlainText = plainText
	record.ReplyToMessageID = nil
	record.RecalledAt = timePointer(now)
	record.RecallReason = stringPointer(&reason)
	record.Revision = 2
	return true, nil
}
func (t *fakeTx) DeleteMessageReactions(_ context.Context, _, messageID string) error {
	filtered := t.repo.reactions[:0]
	for _, reaction := range t.repo.reactions {
		if reaction.messageID != messageID {
			filtered = append(filtered, reaction)
		}
	}
	t.repo.reactions = filtered
	return nil
}
func (t *fakeTx) DeleteMessageCustomEmotes(_ context.Context, _, messageID string) error {
	delete(t.repo.customEmotes, messageID)
	delete(t.repo.customEmoteIDs, messageID)
	return nil
}
func (t *fakeTx) DeleteMessageEmoteCollectionShares(_ context.Context, _, messageID string) error {
	delete(t.repo.shares, messageID)
	delete(t.repo.shareIDs, messageID)
	return nil
}
func (t *fakeTx) DeleteMessagePins(_ context.Context, _, messageID string) error {
	delete(t.repo.pins, messageID)
	return nil
}
func (t *fakeTx) HideMessage(_ context.Context, _, messageID, userID string, _ time.Time) (bool, error) {
	key := hiddenKey(userID, messageID)
	if t.repo.hidden[key] {
		return false, nil
	}
	t.repo.hidden[key] = true
	return true, nil
}
func (t *fakeTx) UnhideMessage(_ context.Context, _, messageID, userID string) (bool, error) {
	key := hiddenKey(userID, messageID)
	if !t.repo.hidden[key] {
		return false, nil
	}
	delete(t.repo.hidden, key)
	return true, nil
}
func (t *fakeTx) AddReaction(_ context.Context, _, messageID, userID, emoteKey string, now time.Time) (bool, error) {
	for _, reaction := range t.repo.reactions {
		if reaction.messageID == messageID && reaction.userID == userID && reaction.emoteKey == emoteKey {
			return false, nil
		}
	}
	t.repo.reactions = append(t.repo.reactions, fakeReaction{messageID: messageID, userID: userID, emoteKey: emoteKey, createdAt: now})
	return true, nil
}
func (t *fakeTx) RemoveReaction(_ context.Context, _, messageID, userID, emoteKey string, _ time.Time) (bool, error) {
	for index, reaction := range t.repo.reactions {
		if reaction.messageID == messageID && reaction.userID == userID && reaction.emoteKey == emoteKey {
			t.repo.reactions = append(t.repo.reactions[:index], t.repo.reactions[index+1:]...)
			return true, nil
		}
	}
	return false, nil
}
func (t *fakeTx) WriteEvent(_ context.Context, input EventInput) (EventRecord, error) {
	if t.repo.failEvent {
		return EventRecord{}, errors.New("event write failed")
	}
	t.repo.nextSeq++
	t.repo.events = append(t.repo.events, input)
	if input.Type == "message.created" {
		if record := t.repo.messages[input.TargetID]; record != nil {
			record.EventSeq = t.repo.nextSeq
		}
	}
	return EventRecord{ID: input.ID, SpaceID: input.SpaceID, Seq: t.repo.nextSeq}, nil
}
func (t *fakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	t.repo.audits = append(t.repo.audits, input)
	return nil
}

func (t *fakeTx) ScheduleMessageJobs(_ context.Context, input messagejobs.Input) error {
	if t.repo.failJobs {
		return errors.New("message job scheduling failed")
	}
	input.ContentJSON = append([]byte(nil), input.ContentJSON...)
	t.repo.messageJobs = append(t.repo.messageJobs, input)
	return nil
}

func testService(repo *fakeRepo, ids ...string) *Service {
	var index atomic.Int64
	return NewService(ServiceOptions{
		Repository:             repo,
		ReactionEmoteValidator: testReactionValidator{},
		Now:                    func() time.Time { return time.Date(2026, 9, 4, 10, 0, 0, 123456789, time.UTC) },
		IDFactory: func() (string, error) {
			position := int(index.Add(1)) - 1
			if position >= len(ids) {
				return fmt.Sprintf("generated-%d", position), nil
			}
			return ids[position], nil
		},
	})
}

func seedConversation(repo *fakeRepo, actorID string) {
	repo.actors[actorID] = &auth.Actor{ID: actorID, GitHubLogin: actorID, Nickname: "Alice", DisplayName: "Alice", Kind: "human", Role: "member"}
	repo.conversations["conv-1"] = &ConversationRecord{ID: "conv-1", SpaceID: DefaultSpaceID, Type: "direct", RetentionCount: 10000}
	repo.members["conv-1"] = map[string]bool{actorID: true}
}

func seedMessage(repo *fakeRepo, id string, createdAt time.Time, text string) {
	content, _ := canonicalContent(Content{Format: MessageContentFormat, PlainText: text, Blocks: []Block{{Type: "text", Text: text}}})
	clientID := "client-" + id
	repo.messages[id] = &MessageRecord{ID: id, SpaceID: DefaultSpaceID, ConversationID: "conv-1", AuthorID: stringPointer(&[]string{"usr-alice"}[0]), AuthorName: "Alice", AuthorNickname: "Alice", AuthorGitHubLogin: "usr-alice", AuthorKind: "human", Kind: "user", ClientMessageID: &clientID, ContentJSON: content, PlainText: text, CreatedAt: createdAt, Revision: 1}
	repo.byClient[clientKey("conv-1", "usr-alice", clientID)] = id
}

func TestProjectMessageExactJSONProjection(t *testing.T) {
	createdAt := time.Date(2026, 9, 4, 10, 0, 0, 123456789, time.FixedZone("CST", 8*60*60))
	record := MessageRecord{
		ID:             "msg-1",
		ConversationID: "conv-1",
		AuthorID:       stringPointerValue("usr-alice"),
		AuthorName:     "Alice",
		AuthorKind:     "human",
		Kind:           "user",
		ContentJSON:    mustJSON(Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "hello"}}}),
		PlainText:      "hello",
		CreatedAt:      createdAt,
	}
	message, err := ProjectMessage(record, nil, []ReactionGroup{{EmoteKey: "builtin:heart", Count: 1}})
	if err != nil {
		t.Fatalf("ProjectMessage: %v", err)
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("marshal message: %v", err)
	}
	serialized := string(encoded)
	for _, expected := range []string{`"createdAt":"2026-09-04T02:00:00.123Z"`, `"blocks":[{"type":"text","text":"hello"}]`, `"attachments":[]`, `"users":[]`, `"reactions":[{"emoteKey":"builtin:heart","count":1,"reactedByCurrentUser":false,"users":[]}]`} {
		if !strings.Contains(serialized, expected) {
			t.Fatalf("projection missing %s: %s", expected, serialized)
		}
	}
	if strings.Contains(serialized, `"attachments":null`) || strings.Contains(serialized, `"reactions":null`) {
		t.Fatalf("projection contains null arrays: %s", serialized)
	}

	reason := "重新组织内容"
	recalledAt := createdAt.Add(time.Second)
	record.RecalledAt = &recalledAt
	record.RecallReason = &reason
	record.ContentJSON = mustJSON(Content{Format: MessageContentFormat, PlainText: "secret", Blocks: []Block{{Type: "text", Text: "secret"}}})
	record.PlainText = "secret"
	recalled, err := ProjectMessage(record, []AttachmentRecord{{ID: "att-1", FileName: "secret.txt"}}, []ReactionGroup{{EmoteKey: "builtin:heart", Count: 1}})
	if err != nil {
		t.Fatalf("ProjectMessage recalled: %v", err)
	}
	recalledJSON, _ := json.Marshal(recalled)
	serialized = string(recalledJSON)
	if strings.Contains(serialized, "secret") || !strings.Contains(serialized, `"blocks":[]`) || !strings.Contains(serialized, `"attachments":[]`) || !strings.Contains(serialized, `"reactions":[]`) {
		t.Fatalf("recalled projection leaked content or arrays: %s", serialized)
	}
	if recalled.PlainText != "Alice因重新组织内容撤回了一条消息" || recalled.Content.PlainText != "" || recalled.ReplyToMessageID != nil {
		t.Fatalf("recalled projection = %#v", recalled)
	}
}

func TestCreateMessageCanonicalIdempotencyUsesContent(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	parentID := "parent-1"
	seedMessage(repo, parentID, time.Now().UTC(), "parent")
	service := testService(repo, "msg-1", "event-1")
	input := CreateInput{ActorID: "usr-alice", ConversationID: "conv-1", ClientMessageID: "client-1", ReplyToMessageID: parentID, Content: Content{Format: MessageContentFormat, PlainText: "client supplied", Blocks: []Block{{Type: "text", Text: "hello"}}}}
	first, err := service.CreateMessage(context.Background(), input)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	input.Content.PlainText = "different client text is ignored"
	replayed, err := service.CreateMessage(context.Background(), input)
	if err != nil {
		t.Fatalf("matching replay: %v", err)
	}
	if replayed.ID != first.ID || len(repo.events) != 1 {
		t.Fatalf("replay = %#v, events = %d", replayed, len(repo.events))
	}
	otherReply := "other-parent"
	seedMessage(repo, otherReply, time.Now().UTC(), "other")
	input.ReplyToMessageID = otherReply
	replayed, err = service.CreateMessage(context.Background(), input)
	if err != nil || replayed.ID != first.ID {
		t.Fatalf("same content with changed reply should replay: %#v, err=%v", replayed, err)
	}
	if len(repo.audits) != 1 || len(repo.events) != 1 {
		t.Fatalf("idempotent replay wrote evidence: audits=%#v events=%#v", repo.audits, repo.events)
	}
	input.Content.Blocks = []Block{{Type: "text", Text: "different content"}}
	_, err = service.CreateMessage(context.Background(), input)
	var conflict *Error
	if !errors.As(err, &conflict) || conflict.Code != CodeMessageIdempotency || conflict.StatusCode != 409 {
		t.Fatalf("content conflict = %#v, want %s/409", conflict, CodeMessageIdempotency)
	}
}

func TestCreateMessagePersistsAdvancedBlockReferences(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	validator := advancedBlockValidatorFunc(func(_ context.Context, actor *auth.Actor, conversationID string, block Block) (Block, error) {
		if actor.ID != "usr-alice" || conversationID != "conv-1" {
			t.Fatalf("validator scope = actor:%#v conversation:%q", actor, conversationID)
		}
		switch block.Type {
		case "emoji", "emote_collection", "card":
			return block, nil
		case "topic_reference":
			return Block{Type: "topic_reference", TopicID: block.TopicID, Title: "发布"}, nil
		default:
			return Block{}, NewError(CodeMessageInvalidBlock, MessageInvalidBlock, 400)
		}
	})
	service := NewService(ServiceOptions{
		Repository: repo, AdvancedBlockValidator: validator,
		Now:       func() time.Time { return time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC) },
		IDFactory: func() (string, error) { return "msg-advanced", nil },
	})
	customID := "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"
	shareID := "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB"
	input := CreateInput{
		ActorID: "usr-alice", ConversationID: "conv-1", ClientMessageID: "client-advanced",
		Content: Content{Format: MessageContentFormat, Blocks: []Block{
			{Type: "emoji", Shortcode: "custom:" + customID},
			{Type: "emote_collection", ShareID: shareID},
			{Type: "topic_reference", TopicID: "topic-1", Title: "client title"},
			{Type: "card", CardID: "card-1", CardType: "echo.answer", SchemaVersion: 1, FallbackText: "回答"},
		}},
	}
	created, err := service.CreateMessage(context.Background(), input)
	if err != nil {
		t.Fatalf("create advanced message: %v", err)
	}
	wantCustom := strings.ToLower(customID)
	wantShare := strings.ToLower(shareID)
	if got := repo.customEmoteIDs[created.ID]; len(got) != 1 || got[0] != wantCustom {
		t.Fatalf("custom emote links = %#v", got)
	}
	if got := repo.shareIDs[created.ID]; len(got) != 1 || got[0] != wantShare {
		t.Fatalf("share links = %#v", got)
	}
	if created.PlainText != "[表情][表情合集]#发布回答" || created.Content.Blocks[2].Title != "发布" {
		t.Fatalf("advanced projection = %#v", created)
	}

	replayed, err := service.CreateMessage(context.Background(), input)
	if err != nil || replayed.ID != created.ID {
		t.Fatalf("advanced replay = %#v, %v", replayed, err)
	}
	if len(repo.customEmoteIDs[created.ID]) != 1 || len(repo.shareIDs[created.ID]) != 1 {
		t.Fatalf("replay duplicated links: custom=%#v shares=%#v", repo.customEmoteIDs, repo.shareIDs)
	}
}

func TestCreateMessageValidationAuditsAndFailsClosed(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	service := testService(repo, "msg-1", "event-1")
	_, err := service.CreateMessage(context.Background(), CreateInput{ActorID: "usr-alice", ConversationID: "conv-1", ClientMessageID: "client-1", Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "link", URL: "javascript:alert(1)"}}}, Meta: auth.RequestMeta{RequestID: " req-1 ", IPAddress: "203.0.113.4:443", UserAgent: "test"}})
	if !isMessageCode(err, CodeMessageInvalidLink) {
		t.Fatalf("invalid link error = %v", err)
	}
	if len(repo.messages) != 0 || len(repo.audits) != 1 || repo.audits[0].IPAddress != "203.0.113.4" {
		t.Fatalf("invalid create state/audit = messages=%d audits=%#v", len(repo.messages), repo.audits)
	}

	repo.failEvent = true
	_, err = service.CreateMessage(context.Background(), CreateInput{ActorID: "usr-alice", ConversationID: "conv-1", ClientMessageID: "client-2", Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "will rollback"}}}})
	if !isMessageCode(err, CodeInternal) || len(repo.messages) != 0 || len(repo.events) != 0 || len(repo.audits) != 1 {
		t.Fatalf("event failure did not rollback: err=%v messages=%d events=%d audits=%d", err, len(repo.messages), len(repo.events), len(repo.audits))
	}
}

func TestListMessagesCursorsAndAround(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	for index := 1; index <= 5; index++ {
		seedMessage(repo, fmt.Sprintf("msg-%d", index), base.Add(time.Duration(index)*time.Minute), fmt.Sprintf("message %d", index))
	}
	service := testService(repo)
	latest, err := service.ListMessages(context.Background(), ListOptions{ActorID: "usr-alice", ConversationID: "conv-1", Limit: 2})
	if err != nil || messageIDs(latest) != "msg-4,msg-5" {
		t.Fatalf("latest = %s, err=%v", messageIDs(latest), err)
	}
	older, err := service.ListMessages(context.Background(), ListOptions{ActorID: "usr-alice", ConversationID: "conv-1", Before: "msg-4", Limit: 2})
	if err != nil || messageIDs(older) != "msg-2,msg-3" {
		t.Fatalf("older = %s, err=%v", messageIDs(older), err)
	}
	newer, err := service.ListMessages(context.Background(), ListOptions{ActorID: "usr-alice", ConversationID: "conv-1", After: "msg-2", Limit: 2})
	if err != nil || messageIDs(newer) != "msg-3,msg-4" {
		t.Fatalf("newer = %s, err=%v", messageIDs(newer), err)
	}
	around, err := service.ListMessages(context.Background(), ListOptions{ActorID: "usr-alice", ConversationID: "conv-1", Around: "msg-3", Limit: 3})
	if err != nil || messageIDs(around) != "msg-2,msg-3,msg-4" {
		t.Fatalf("around = %s, err=%v", messageIDs(around), err)
	}
}

func TestRecallClearsContentReactionsPinsAndEmoteLinks(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	seedMessage(repo, "msg-1", time.Now().UTC(), "secret body")
	repo.reactions = []fakeReaction{{messageID: "msg-1", userID: "usr-alice", emoteKey: "builtin:heart", createdAt: time.Now().UTC()}}
	repo.pins["msg-1"] = true
	repo.customEmotes["msg-1"] = true
	repo.shares["msg-1"] = true
	service := testService(repo, "event-recall")
	message, err := service.RecallMessage(context.Background(), RecallInput{ActorID: "usr-alice", MessageID: "msg-1"})
	if err != nil {
		t.Fatalf("recall: %v", err)
	}
	encoded, _ := json.Marshal(message)
	if strings.Contains(string(encoded), "secret body") || len(repo.reactions) != 0 || repo.pins["msg-1"] || repo.customEmotes["msg-1"] || repo.shares["msg-1"] {
		t.Fatalf("recall retained private state: message=%s reactions=%#v pins=%#v custom=%#v shares=%#v", encoded, repo.reactions, repo.pins, repo.customEmotes, repo.shares)
	}
	if len(repo.events) != 1 || repo.events[0].Type != "message.recalled" || strings.Contains(string(repo.events[0].PayloadJSON), "secret body") {
		t.Fatalf("recall event = %#v", repo.events)
	}
	if len(repo.audits) != 1 || repo.audits[0].Action != "message.recall" {
		t.Fatalf("recall audit = %#v", repo.audits)
	}
	replayed, err := service.RecallMessage(context.Background(), RecallInput{ActorID: "usr-alice", MessageID: "msg-1"})
	if err != nil || replayed.ID != message.ID || len(repo.events) != 1 {
		t.Fatalf("recalled replay = %#v err=%v events=%d", replayed, err, len(repo.events))
	}
}

func TestHideAndReactionOperationsAreIdempotent(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	seedMessage(repo, "msg-1", time.Now().UTC(), "hello")
	service := testService(repo, "reaction-event", "reaction-remove-event")
	hidden, err := service.HideMessage(context.Background(), HideInput{ActorID: "usr-alice", MessageID: "msg-1"})
	if err != nil || !hidden.Hidden || !hidden.Changed {
		t.Fatalf("hide = %#v err=%v", hidden, err)
	}
	hidden, err = service.HideMessage(context.Background(), HideInput{ActorID: "usr-alice", MessageID: "msg-1"})
	if err != nil || hidden.Changed {
		t.Fatalf("idempotent hide = %#v err=%v", hidden, err)
	}
	added, err := service.AddReaction(context.Background(), ReactionInput{ActorID: "usr-alice", MessageID: "msg-1", EmoteKey: "builtin:heart"})
	if err != nil || !added.Created || len(added.Reactions) != 1 {
		t.Fatalf("add reaction = %#v err=%v", added, err)
	}
	added, err = service.AddReaction(context.Background(), ReactionInput{ActorID: "usr-alice", MessageID: "msg-1", EmoteKey: "builtin:heart"})
	if err != nil || added.Created || len(repo.events) != 1 {
		t.Fatalf("idempotent reaction = %#v err=%v events=%d", added, err, len(repo.events))
	}
	removed, err := service.RemoveReaction(context.Background(), ReactionInput{ActorID: "usr-alice", MessageID: "msg-1", EmoteKey: "builtin:heart"})
	if err != nil || !removed.Removed || len(removed.Reactions) != 0 || len(repo.events) != 2 {
		t.Fatalf("remove reaction = %#v err=%v events=%d", removed, err, len(repo.events))
	}
}

func TestReactionValidationFailsClosedWithoutCatalog(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	seedMessage(repo, "msg-1", time.Now().UTC(), "hello")
	service := NewService(ServiceOptions{Repository: repo})

	_, err := service.AddReaction(context.Background(), ReactionInput{ActorID: "usr-alice", MessageID: "msg-1", EmoteKey: "builtin:heart"})
	if !isMessageCode(err, CodeReactionInvalidEmote) || len(repo.reactions) != 0 {
		t.Fatalf("missing reaction catalog = %v, reactions=%#v", err, repo.reactions)
	}
}

type testReactionValidator struct{}

func (testReactionValidator) IsVisibleReactionEmote(_ context.Context, emoteKey string) (bool, error) {
	return emoteKey == "builtin:heart", nil
}

func (testReactionValidator) IsKnownReactionEmote(_ context.Context, emoteKey string) (bool, error) {
	return emoteKey == "builtin:heart", nil
}

func TestCreateMessageConcurrentSameClientIDHasOneWinner(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	service := testService(repo)
	const workers = 32
	results := make(chan Message, workers)
	errorsCh := make(chan error, workers)
	var wait sync.WaitGroup
	wait.Add(workers)
	for index := 0; index < workers; index++ {
		go func() {
			defer wait.Done()
			message, err := service.CreateMessage(context.Background(), CreateInput{ActorID: "usr-alice", ConversationID: "conv-1", ClientMessageID: "same-client", Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "same body"}}}})
			if err != nil {
				errorsCh <- err
				return
			}
			results <- message
		}()
	}
	wait.Wait()
	close(results)
	close(errorsCh)
	for err := range errorsCh {
		t.Fatalf("concurrent create error: %v", err)
	}
	var winnerID string
	for message := range results {
		if winnerID == "" {
			winnerID = message.ID
		}
		if message.ID != winnerID {
			t.Fatalf("concurrent winner IDs differ: %q and %q", winnerID, message.ID)
		}
	}
	if len(repo.messages) != 1 || len(repo.events) != 1 {
		t.Fatalf("concurrent state = messages=%d events=%d", len(repo.messages), len(repo.events))
	}
}

func TestCreateMessageIDFactoryFailureDoesNotPersist(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	service := NewService(ServiceOptions{Repository: repo, IDFactory: func() (string, error) { return "", errors.New("random source unavailable") }})
	_, err := service.CreateMessage(context.Background(), CreateInput{ActorID: "usr-alice", ConversationID: "conv-1", ClientMessageID: "client-1", Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "hello"}}}})
	if !isMessageCode(err, CodeInternal) || len(repo.messages) != 0 || len(repo.events) != 0 {
		t.Fatalf("id factory failure = %v, messages=%d events=%d", err, len(repo.messages), len(repo.events))
	}
}

func TestCreateMessageSchedulesJobsWithEventAndRollsBackOnFailure(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	service := NewService(ServiceOptions{
		Repository: repo, RequireMessageJobs: true,
		Now: func() time.Time { return time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC) },
		IDFactory: func() (string, error) {
			if len(repo.messages) == 0 {
				return "msg-jobs", nil
			}
			return "event-jobs", nil
		},
	})
	created, err := service.CreateMessage(context.Background(), CreateInput{
		ActorID: "usr-alice", ConversationID: "conv-1", ClientMessageID: "jobs-1",
		Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "hello"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(repo.messageJobs) != 1 || repo.messageJobs[0].MessageID != created.ID || repo.messageJobs[0].EventSeq != 1 || !json.Valid(repo.messageJobs[0].ContentJSON) {
		t.Fatalf("scheduled jobs = %#v", repo.messageJobs)
	}

	repo.failJobs = true
	_, err = service.CreateMessage(context.Background(), CreateInput{
		ActorID: "usr-alice", ConversationID: "conv-1", ClientMessageID: "jobs-2",
		Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "rollback"}}},
	})
	if !isMessageCode(err, CodeInternal) || len(repo.messages) != 1 || len(repo.events) != 1 || len(repo.messageJobs) != 1 || len(repo.audits) != 1 {
		t.Fatalf("job failure did not roll back: err=%v messages=%d events=%d jobs=%d audits=%d", err, len(repo.messages), len(repo.events), len(repo.messageJobs), len(repo.audits))
	}
}

func cloneMessageRecord(record *MessageRecord) *MessageRecord {
	if record == nil {
		return nil
	}
	copyValue := *record
	copyValue.AuthorID = stringPointer(record.AuthorID)
	copyValue.ClientMessageID = stringPointer(record.ClientMessageID)
	copyValue.ReplyToMessageID = stringPointer(record.ReplyToMessageID)
	copyValue.ContentJSON = append([]byte(nil), record.ContentJSON...)
	copyValue.EditedAt = timePointerValue(record.EditedAt)
	copyValue.DeletedAt = timePointerValue(record.DeletedAt)
	copyValue.RecalledAt = timePointerValue(record.RecalledAt)
	copyValue.RecallReason = stringPointer(record.RecallReason)
	return &copyValue
}

func (f *fakeRepo) cloneLocked() *fakeRepo {
	copyRepo := newFakeRepo()
	for id, actor := range f.actors {
		copyValue := *actor
		copyRepo.actors[id] = &copyValue
	}
	for id, conversation := range f.conversations {
		copyValue := *conversation
		copyRepo.conversations[id] = &copyValue
	}
	for id, members := range f.members {
		copyRepo.members[id] = make(map[string]bool, len(members))
		for memberID, active := range members {
			copyRepo.members[id][memberID] = active
		}
	}
	for id, message := range f.messages {
		copyRepo.messages[id] = cloneMessageRecord(message)
	}
	for key, id := range f.byClient {
		copyRepo.byClient[key] = id
	}
	for id, attachment := range f.attachments {
		copyValue := *attachment
		copyRepo.attachments[id] = &copyValue
	}
	for id, files := range f.messageFiles {
		copyRepo.messageFiles[id] = append([]string(nil), files...)
	}
	for conversationID, members := range f.mentions {
		copyRepo.mentions[conversationID] = make(map[string]*MentionMember, len(members))
		for memberID, member := range members {
			copyValue := *member
			copyRepo.mentions[conversationID][memberID] = &copyValue
		}
	}
	copyRepo.reactions = append([]fakeReaction(nil), f.reactions...)
	for key, value := range f.hidden {
		copyRepo.hidden[key] = value
	}
	for key, value := range f.pins {
		copyRepo.pins[key] = value
	}
	for key, value := range f.customEmotes {
		copyRepo.customEmotes[key] = value
	}
	for key, value := range f.shares {
		copyRepo.shares[key] = value
	}
	for key, values := range f.customEmoteIDs {
		copyRepo.customEmoteIDs[key] = append([]string(nil), values...)
	}
	for key, values := range f.shareIDs {
		copyRepo.shareIDs[key] = append([]string(nil), values...)
	}
	copyRepo.events = append([]EventInput(nil), f.events...)
	copyRepo.audits = append([]AuditInput(nil), f.audits...)
	copyRepo.nextSeq = f.nextSeq
	copyRepo.failEvent = f.failEvent
	copyRepo.messageJobs = append([]messagejobs.Input(nil), f.messageJobs...)
	copyRepo.failJobs = f.failJobs
	return copyRepo
}

func (f *fakeRepo) restoreLocked(snapshot *fakeRepo) {
	f.actors = snapshot.actors
	f.conversations = snapshot.conversations
	f.members = snapshot.members
	f.messages = snapshot.messages
	f.byClient = snapshot.byClient
	f.attachments = snapshot.attachments
	f.messageFiles = snapshot.messageFiles
	f.mentions = snapshot.mentions
	f.reactions = snapshot.reactions
	f.hidden = snapshot.hidden
	f.pins = snapshot.pins
	f.customEmotes = snapshot.customEmotes
	f.shares = snapshot.shares
	f.customEmoteIDs = snapshot.customEmoteIDs
	f.shareIDs = snapshot.shareIDs
	f.events = snapshot.events
	f.audits = snapshot.audits
	f.nextSeq = snapshot.nextSeq
	f.failEvent = snapshot.failEvent
	f.messageJobs = snapshot.messageJobs
	f.failJobs = snapshot.failJobs
}

func clientKey(conversationID, actorID, clientID string) string {
	return conversationID + "\x00" + actorID + "\x00" + clientID
}
func hiddenKey(userID, messageID string) string { return userID + "\x00" + messageID }
func indexOfMessage(messages []MessageRecord, id string) int {
	for index := range messages {
		if messages[index].ID == id {
			return index
		}
	}
	return -1
}
func messageIDs(messages []Message) string {
	ids := make([]string, 0, len(messages))
	for _, message := range messages {
		ids = append(ids, message.ID)
	}
	return strings.Join(ids, ",")
}
func containsString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
func stringPointerValue(value string) *string { return &value }
func timePointer(value time.Time) *time.Time  { return &value }
func timePointerValue(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}
func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}
func isMessageCode(err error, code string) bool {
	var domainErr *Error
	return errors.As(err, &domainErr) && domainErr.Code == code
}

var _ Repository = (*fakeRepo)(nil)
var _ Tx = (*fakeTx)(nil)
