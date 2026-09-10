package events

import (
	"context"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestChatPreferenceEventsAreActorLocalAndContentFree(t *testing.T) {
	// This visibility branch must not query unrelated conversations or members.
	repository := &PGRepository{pool: &pgxpool.Pool{}}
	targetType, targetID := "user", "usr-member"
	event := EventRecord{Type: "emote.settings.updated", SpaceID: "space", TargetType: &targetType, TargetID: &targetID}
	for _, actor := range []auth.Actor{{ID: "usr-member", Role: "member"}, {ID: "usr-other", Role: "member"}, {ID: "usr-owner", Role: "owner"}} {
		visible, err := repository.EventVisible(context.Background(), &actor, event, map[string]any{"userId": targetID})
		if err != nil || visible != (actor.ID == targetID) {
			t.Fatalf("actor %s visibility=%v error=%v", actor.ID, visible, err)
		}
	}
	payload := projectPayload(event.Type, map[string]any{"userId": targetID, "autoHideMessageTypes": []any{"image"}, "private": "synthetic"}, &auth.Actor{ID: targetID})
	if !reflect.DeepEqual(payload, map[string]any{"userId": targetID}) {
		t.Fatal("preference event exposed extra fields")
	}
}
