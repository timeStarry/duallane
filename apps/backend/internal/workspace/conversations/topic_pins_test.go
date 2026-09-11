package conversations

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type topicPinTestReader struct {
	*conversationFakeRepository
	status string
}

func (r topicPinTestReader) TopicPinStatus(context.Context, string, string, string, string) (string, error) {
	return r.status, nil
}

func TestTopicPinRequiresMemberAndOpenMutationState(t *testing.T) {
	for _, test := range []struct {
		name, status, role, kind string
		mutate, allow            bool
	}{
		{"member can pin open topic", "open", "member", "human", true, true},
		{"owner cannot bypass topic membership", "", "owner", "human", true, false},
		{"closed topic rejects pin and unpin", "closed", "owner", "human", true, false},
		{"closed topic retains authorized pin reads", "closed", "member", "human", false, true},
		{"archived topic rejects changes", "archived", "admin", "human", true, false},
		{"auditor cannot read topic pins", "open", "auditor", "human", false, false},
		{"bot cannot read topic pins", "open", "member", "bot", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			actor := auth.Actor{ID: "reader", Role: test.role, Kind: test.kind}
			repo := topicPinTestReader{newConversationFake(actor), test.status}
			service := NewService(ServiceOptions{Repository: repo})
			message := MessageRecord{ID: "m", ConversationID: "g", TopicID: "topic"}
			denied, err := service.topicPinAccess(context.Background(), repo, &actor, &message, test.mutate)
			if err != nil || (denied == nil) != test.allow {
				t.Fatalf("denied=%v err=%v", denied, err)
			}
		})
	}
}

func TestTopicPinEventsUseTopicAudienceWithoutContent(t *testing.T) {
	for _, unpin := range []bool{false, true} {
		event := pinEvent(DefaultSpaceID, "author", MessageRecord{ID: "m", ConversationID: "g", TopicID: "topic", PlainText: "private body"}, unpin, time.Now())
		if !strings.HasPrefix(event.Type, "topic.message.") || !strings.Contains(string(event.PayloadJSON), `"topicId":"topic"`) || strings.Contains(string(event.PayloadJSON), "private body") {
			t.Fatalf("unsafe topic pin event: %#v", event)
		}
	}
}
