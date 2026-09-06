//go:build postgres_integration

package events

import (
	"context"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func assertReactionEventProjection(t *testing.T, ctx context.Context, repository *PGRepository) {
	t.Helper()
	for _, eventType := range []string{"reaction.added", "reaction.removed"} {
		for _, viewer := range []struct {
			id      string
			reacted bool
		}{{"usr_viewer", true}, {"usr_target", false}} {
			actor := &auth.Actor{ID: viewer.id, Kind: "human", Role: "member"}
			payload, err := repository.ProjectEventPayload(ctx, actor, EventRecord{Type: eventType, SpaceID: DefaultSpaceID}, map[string]any{
				"messageId": "msg-1", "conversationId": "conv-events",
				// Stored projections are not trusted; reactions are viewer-specific.
				"reactions": []any{map[string]any{"emoteKey": "forged", "count": 999}},
			})
			if err != nil {
				t.Fatal(err)
			}
			safe := projectPayload(eventType, payload, actor)
			groups, ok := safe["reactions"].([]any)
			if !ok || len(groups) != 1 {
				t.Fatalf("reaction event lacks current groups: %#v", safe)
			}
			group := groups[0].(map[string]any)
			if group["emoteKey"] != "builtin:heart" || group["count"] != int64(2) || group["reactedByCurrentUser"] != viewer.reacted {
				t.Fatalf("reaction group for %s = %#v", viewer.id, group)
			}
			users, ok := group["users"].([]any)
			if !ok || len(users) != 2 || users[1].(map[string]any)["displayName"] != "Viewer" {
				t.Fatalf("reaction users = %#v", group["users"])
			}
		}
	}
}
