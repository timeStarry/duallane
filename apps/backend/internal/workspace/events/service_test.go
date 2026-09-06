package events

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type fakeRepository struct {
	actor       *auth.Actor
	rows        []EventRecord
	visible     map[string]bool
	current     int64
	earliest    int64
	lookupCount int
	after       []int64
}

func (f *fakeRepository) LookupActor(_ context.Context, _, _ string) (*auth.Actor, error) {
	f.lookupCount++
	if f.actor == nil {
		return nil, nil
	}
	copy := *f.actor
	return &copy, nil
}

func (f *fakeRepository) CurrentSeq(context.Context, string) (int64, error) {
	if f.current != 0 {
		return f.current, nil
	}
	var result int64
	for _, row := range f.rows {
		if row.Seq > result {
			result = row.Seq
		}
	}
	return result, nil
}

func (f *fakeRepository) EarliestSeq(context.Context, string) (int64, error) {
	if f.earliest != 0 {
		return f.earliest, nil
	}
	var result int64
	for _, row := range f.rows {
		if result == 0 || row.Seq < result {
			result = row.Seq
		}
	}
	return result, nil
}

func (f *fakeRepository) ListEventsAfter(_ context.Context, _ string, afterSeq int64, limit int) ([]EventRecord, error) {
	f.after = append(f.after, afterSeq)
	result := make([]EventRecord, 0, limit)
	for _, row := range f.rows {
		if row.Seq <= afterSeq {
			continue
		}
		result = append(result, row)
		if len(result) == limit {
			break
		}
	}
	return result, nil
}

func (f *fakeRepository) EventVisible(_ context.Context, _ *auth.Actor, event EventRecord, _ map[string]any) (bool, error) {
	if f.visible == nil {
		return true, nil
	}
	visible, ok := f.visible[event.ID]
	if !ok {
		return true, nil
	}
	return visible, nil
}

func TestReplayReauthenticatesFiltersAndProjectsSafePayload(t *testing.T) {
	createdAt := time.Date(2026, 9, 4, 12, 34, 56, 789654321, time.FixedZone("test", 8*60*60))
	memberID := "usr_target"
	conversationID := "conv_visible"
	repo := &fakeRepository{
		actor: &auth.Actor{ID: "usr_viewer", Kind: "human", Role: "member"},
		rows: []EventRecord{
			{ID: "evt-1", SpaceID: DefaultSpaceID, Seq: 1, Type: "workspace.member_joined", TargetType: nullable("user"), TargetID: &memberID, PayloadJSON: []byte(`{"userId":"usr_target","member":{"id":"usr_target","displayName":"Target","email":"private@example.test","github_id":"secret","nickname":null,"capabilities":{"canJoinGroups":true}}}`), CreatedAt: createdAt},
			{ID: "evt-2", SpaceID: DefaultSpaceID, Seq: 2, Type: "message.created", ConversationID: &conversationID, PayloadJSON: []byte(`{"messageId":"msg-hidden","message":{"id":"msg-hidden","content":{"format":"duallane.message+json;v=1","plainText":"hidden"}}}`), CreatedAt: createdAt.Add(time.Second)},
			{ID: "evt-3", SpaceID: DefaultSpaceID, Seq: 3, Type: "transfer.rejected", ActorID: &memberID, TargetType: nullable("transfer"), TargetID: &memberID, PayloadJSON: []byte(`{"direction":"upload","code":"quota.exceeded","message":"local"}`), CreatedAt: createdAt.Add(2 * time.Second)},
			{ID: "evt-4", SpaceID: DefaultSpaceID, Seq: 4, Type: "message.created", ConversationID: &conversationID, PayloadJSON: []byte(`{"messageId":"msg-visible","message":{"id":"msg-visible","content":{"format":"duallane.message+json;v=1","blocks":[{"type":"text","text":"visible"}],"email":"do-not-copy"}}}`), CreatedAt: createdAt.Add(3 * time.Second)},
		},
		visible: map[string]bool{"evt-2": false, "evt-3": false},
	}

	result, err := NewService(ServiceOptions{Repository: repo, ReplayLimit: 10, BatchSize: 2}).Replay(context.Background(), ReplayInput{ActorID: "usr_viewer"})
	if err != nil {
		t.Fatal(err)
	}
	if repo.lookupCount != 1 {
		t.Fatalf("actor lookups = %d, want one fresh lookup", repo.lookupCount)
	}
	if got := eventSeqs(result.Events); !reflect.DeepEqual(got, []int64{1, 4}) {
		t.Fatalf("visible sequence = %v", got)
	}
	if result.ReplayCount != 2 || result.HasMore {
		t.Fatalf("replay metadata = %#v", result)
	}
	if result.Events[0].CreatedAt != "2026-09-04T04:34:56.789Z" {
		t.Fatalf("createdAt = %q", result.Events[0].CreatedAt)
	}
	member, ok := result.Events[0].Payload["member"].(map[string]any)
	if !ok {
		t.Fatalf("member projection = %#v", result.Events[0].Payload)
	}
	if _, exists := member["email"]; exists {
		t.Fatal("member email leaked")
	}
	if _, exists := member["github_id"]; exists {
		t.Fatal("member github id leaked")
	}
	if _, exists := member["searchDiscoverable"]; exists {
		t.Fatal("member discoverability leaked to another viewer")
	}
	if result.Events[2-1].Payload["messageId"] != "msg-visible" {
		t.Fatalf("message payload = %#v", result.Events[1].Payload)
	}
}

func TestMemberProjectionOnlyExposesSelfOnlyFieldsToThatActor(t *testing.T) {
	payload := ParsePayloadObject([]byte(`{"userId":"usr-viewer","member":{"id":"usr-viewer","displayName":"Viewer","searchDiscoverable":true,"recallReason":"内容有误"}}`))
	projected := projectPayload("workspace.member_updated", payload, &auth.Actor{ID: "usr-viewer"})
	member, ok := projected["member"].(map[string]any)
	if !ok || member["searchDiscoverable"] != true || member["recallReason"] != "内容有误" {
		t.Fatalf("self member projection = %#v", projected)
	}
}

func TestSafeConversationPreservesDirectBotPeerProjection(t *testing.T) {
	conversation, ok := safeConversation(map[string]any{
		"id":           "conv-beacon",
		"type":         "direct",
		"displayTitle": "信标",
		"members": []any{
			map[string]any{"id": "usr_viewer", "displayName": "Viewer", "kind": "human"},
			map[string]any{
				"id":          "usr_system_beacon",
				"displayName": "信标",
				"description": "文件传输助手",
				"kind":        "bot",
				"githubLogin": "must-not-leak",
			},
		},
		"otherMember": map[string]any{
			"id":          "usr_system_beacon",
			"displayName": "信标",
			"description": "文件传输助手",
			"kind":        "bot",
			"githubLogin": "must-not-leak",
		},
	}, "usr_viewer")
	if !ok {
		t.Fatal("safeConversation rejected direct conversation")
	}
	peer, ok := conversation["otherMember"].(map[string]any)
	if !ok {
		t.Fatalf("otherMember = %#v", conversation["otherMember"])
	}
	if peer["id"] != "usr_system_beacon" || peer["kind"] != "bot" || peer["description"] != "文件传输助手" {
		t.Fatalf("bot peer projection = %#v", peer)
	}
	if _, leaked := peer["githubLogin"]; leaked {
		t.Fatalf("bot peer leaked human identity: %#v", peer)
	}
}

func TestSafeConversationKeepsNullOtherMemberShape(t *testing.T) {
	conversation, ok := safeConversation(map[string]any{
		"id":          "conv-empty",
		"type":        "direct",
		"otherMember": nil,
	}, "usr_viewer")
	if !ok {
		t.Fatal("safeConversation rejected conversation")
	}
	if peer, exists := conversation["otherMember"]; !exists || peer != nil {
		t.Fatalf("null otherMember shape = %#v", conversation["otherMember"])
	}
	group, ok := safeConversation(map[string]any{
		"id":   "conv-group",
		"type": "group",
		"otherMember": map[string]any{
			"id": "usr_system_beacon", "kind": "bot", "description": "must not be copied",
		},
	}, "usr_viewer")
	if !ok || group["otherMember"] != nil {
		t.Fatalf("group otherMember was not forced null: %#v", group["otherMember"])
	}
}

func TestSafeBlockPreservesAuthorizedShareProjectionOnly(t *testing.T) {
	content, ok := safeContent(map[string]any{
		"format": "duallane.message+json;v=1",
		"blocks": []any{map[string]any{
			"type":    "emote_collection",
			"shareId": "share-1",
			"share": map[string]any{
				"id":        "share-1",
				"name":      "精选",
				"itemCount": 2,
				"createdAt": "2026-09-06T00:00:00.000Z",
				"revokedAt": nil,
				"sharePath": "/workspace/emotes/shared/share-1",
				"canRevoke": true,
				"sharedBy":  map[string]any{"id": "usr_owner", "displayName": "Owner", "email": "private@example.test"},
				"originalCreator": map[string]any{
					"id": "usr_creator", "displayName": "Creator", "email": "private@example.test",
				},
				"covers": []any{map[string]any{
					"id": "emote-1", "label": "心", "src": "/api/workspace/emotes/emote-1/content", "animated": true,
					"storageKey": "must-not-leak",
				}},
				"storageKey": "must-not-leak",
			},
		}},
	})
	if !ok {
		t.Fatal("safeContent rejected projected share")
	}
	blocks, ok := content["blocks"].([]any)
	if !ok || len(blocks) != 1 {
		t.Fatalf("projected blocks = %#v", content["blocks"])
	}
	block := blocks[0]
	projected, ok := block.(map[string]any)
	if !ok {
		t.Fatalf("projected block = %#v", block)
	}
	share, ok := projected["share"].(map[string]any)
	if !ok || share["id"] != "share-1" || share["canRevoke"] != true {
		t.Fatalf("projected share = %#v", projected["share"])
	}
	if _, leaked := share["storageKey"]; leaked {
		t.Fatalf("share leaked storage key: %#v", share)
	}
	cover := share["covers"].([]any)[0].(map[string]any)
	if _, leaked := cover["storageKey"]; leaked {
		t.Fatalf("cover leaked storage key: %#v", cover)
	}
	if _, leaked := share["sharedBy"].(map[string]any)["email"]; leaked {
		t.Fatalf("share leaked private identity: %#v", share["sharedBy"])
	}
}

func TestReplayAppliesLimitAfterVisibilityAndUsesBoundedPages(t *testing.T) {
	repo := &fakeRepository{
		actor: &auth.Actor{ID: "usr_viewer", Kind: "human", Role: "member"},
		rows: []EventRecord{
			{ID: "hidden", SpaceID: DefaultSpaceID, Seq: 1, Type: "unknown", CreatedAt: time.Now()},
			{ID: "visible-1", SpaceID: DefaultSpaceID, Seq: 2, Type: "unknown", CreatedAt: time.Now()},
			{ID: "visible-2", SpaceID: DefaultSpaceID, Seq: 3, Type: "unknown", CreatedAt: time.Now()},
			{ID: "visible-3", SpaceID: DefaultSpaceID, Seq: 4, Type: "unknown", CreatedAt: time.Now()},
		},
		visible: map[string]bool{"hidden": false},
	}
	result, err := NewService(ServiceOptions{Repository: repo, ReplayLimit: 2, BatchSize: 2}).Replay(context.Background(), ReplayInput{ActorID: "usr_viewer"})
	if err != nil {
		t.Fatal(err)
	}
	if got := eventSeqs(result.Events); !reflect.DeepEqual(got, []int64{2, 3}) {
		t.Fatalf("visible sequence = %v", got)
	}
	if !result.HasMore {
		t.Fatal("replay did not report visible events beyond the limit")
	}
	if !reflect.DeepEqual(repo.after, []int64{0, 2}) {
		t.Fatalf("page cursors = %v, want bounded pages through seq 3", repo.after)
	}
}

func TestReplayReturnsExplicitSyncRequiredForCursorAndStaleWindow(t *testing.T) {
	base := &fakeRepository{actor: &auth.Actor{ID: "usr_viewer", Kind: "human", Role: "member"}, current: 5, earliest: 3}
	service := NewServiceForRepository(base)

	result, err := service.Replay(context.Background(), ReplayInput{ActorID: "usr_viewer", LastSeq: 6})
	if err != nil || !result.SyncRequired || result.Reason != SyncReasonCursorAhead || result.CurrentSeq != 5 {
		t.Fatalf("cursor-ahead result = %#v, err=%v", result, err)
	}
	result, err = service.Replay(context.Background(), ReplayInput{ActorID: "usr_viewer", LastSeq: 1})
	if err != nil || !result.SyncRequired || result.Reason != SyncReasonReplayWindow || result.ReplayFrom != 2 {
		t.Fatalf("stale result = %#v, err=%v", result, err)
	}
}

func TestReplayRejectsMissingActorAndNonMonotonicRows(t *testing.T) {
	repo := &fakeRepository{rows: []EventRecord{{ID: "one", Seq: 1, SpaceID: DefaultSpaceID, Type: "x"}}}
	_, err := NewServiceForRepository(repo).Replay(context.Background(), ReplayInput{ActorID: "missing"})
	if !isEventCode(err, CodeAuthRequired) {
		t.Fatalf("missing actor error = %v", err)
	}

	repo.actor = &auth.Actor{ID: "usr_viewer", Kind: "human", Role: "member"}
	repo.rows = []EventRecord{{ID: "one", Seq: 1, SpaceID: DefaultSpaceID, Type: "x"}, {ID: "again", Seq: 1, SpaceID: DefaultSpaceID, Type: "x"}}
	_, err = NewService(ServiceOptions{Repository: repo, BatchSize: 10}).Replay(context.Background(), ReplayInput{ActorID: "usr_viewer"})
	if err == nil || !strings.Contains(err.Error(), CodeInternal) {
		t.Fatalf("non-monotonic error = %v", err)
	}
}

func TestParsePayloadObjectNeverReturnsInputAlias(t *testing.T) {
	if got := ParsePayloadObject([]byte(`[]`)); len(got) != 0 {
		t.Fatalf("array payload = %#v", got)
	}
	if got := ParsePayloadObject([]byte(`{"message":"ok","email":"private"}`)); got["message"] != "ok" {
		t.Fatalf("object payload = %#v", got)
	}
	if got := ParsePayloadObject(make([]byte, MaxPayloadBytes+1)); len(got) != 0 {
		t.Fatalf("oversized payload = %#v", got)
	}
}

func nullable(value string) *string {
	return &value
}

func eventSeqs(events []Event) []int64 {
	result := make([]int64, 0, len(events))
	for _, event := range events {
		result = append(result, event.Seq)
	}
	return result
}

func isEventCode(err error, code string) bool {
	var value *Error
	return errors.As(err, &value) && value.Code == code
}
