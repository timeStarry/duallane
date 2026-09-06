package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type reactionPathService struct {
	fakeMessageService
	removed messages.ReactionInput
}

func (service *reactionPathService) RemoveReaction(_ context.Context, input messages.ReactionInput) (messages.ReactionResult, error) {
	service.removed = input
	return messages.ReactionResult{MessageID: input.MessageID, Reactions: []messages.ReactionGroup{}}, nil
}

func TestRemoveReactionDecodesPathExactlyOnce(t *testing.T) {
	for _, item := range []struct {
		path string
		want string
	}{
		{"feishu:ok", "feishu:ok"},
		{"feishu%3Aok", "feishu:ok"},
		{"feishu%3aok", "feishu:ok"},
		{"feishu%253Aok", "feishu%3Aok"},
		{"feishu%25253Aok", "feishu%253Aok"},
		{"feishu%3Aok%252F", "feishu:ok%2F"},
		{"feishu%3Aok%2Fother", "feishu:ok/other"},
		{"feishu:plus+key", "feishu:plus+key"},
		{"feishu%3Aplus%2Bkey", "feishu:plus+key"},
	} {
		t.Run(item.path, func(t *testing.T) {
			service := &reactionPathService{}
			router := coreRouter(nil, nil, service)
			request := httptest.NewRequest(http.MethodDelete, "/api/workspace/messages/message-1/reactions/"+item.path, nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK || service.removed.EmoteKey != item.want {
				t.Fatalf("status=%d key=%q want=%q", response.Code, service.removed.EmoteKey, item.want)
			}
			if service.removed.ActorID != "owner" || service.removed.MessageID != "message-1" {
				t.Fatalf("path decoding changed authorization input: %#v", service.removed)
			}
		})
	}
}
