//go:build postgres_integration

package messages

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestPGMessageListsPreserveViewerScopedPinProjection(t *testing.T) {
	fixture := newPGMessageIntegrationFixture(t)
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE conversations SET type = 'group', direct_key = NULL WHERE id = 'conv-messages'`); err != nil {
		t.Fatal(err)
	}
	first := createPGIntegrationMessage(t, fixture, "pin-first", "first")
	createPGIntegrationMessage(t, fixture, "pin-second", "second")
	if _, err := fixture.pool.Exec(fixture.ctx, `INSERT INTO conversation_pinned_messages (conversation_id, message_id, pinned_by_user_id, created_at) VALUES ('conv-messages', $1, 'usr-alice', $2)`, first.ID, fixture.now); err != nil {
		t.Fatal(err)
	}

	assertPin := func(actor string, around bool, expected map[string]any) {
		t.Helper()
		options := ListOptions{ActorID: actor, ConversationID: "conv-messages", Limit: 40}
		if around {
			options.Around = first.ID
		}
		items, err := fixture.service.List(fixture.ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			if item.ID != first.ID {
				continue
			}
			raw, err := json.Marshal(item)
			if err != nil {
				t.Fatal(err)
			}
			var projected map[string]any
			if err := json.Unmarshal(raw, &projected); err != nil {
				t.Fatal(err)
			}
			if expected == nil {
				if _, exists := projected["pin"]; exists {
					t.Fatal("unpinned or recalled message still exposes pin")
				}
			} else if !reflect.DeepEqual(projected["pin"], expected) {
				t.Fatalf("message-list pin = %#v, want %#v", projected["pin"], expected)
			}
			return
		}
		t.Fatal("message-list omitted the target message")
	}
	ownerPin := map[string]any{"pinnedByUserId": "usr-alice", "pinnedAt": formatTimestamp(fixture.now), "canUnpin": true}
	memberPin := map[string]any{"pinnedByUserId": "usr-alice", "pinnedAt": formatTimestamp(fixture.now), "canUnpin": false}
	assertPin("usr-alice", false, ownerPin)
	assertPin("usr-bob", true, memberPin)
	if _, err := fixture.service.HideMessage(fixture.ctx, HideInput{ActorID: "usr-bob", MessageID: first.ID}); err != nil {
		t.Fatal(err)
	}
	assertPin("usr-bob", false, memberPin)
	if _, err := fixture.service.UnhideMessage(fixture.ctx, HideInput{ActorID: "usr-bob", MessageID: first.ID}); err != nil {
		t.Fatal(err)
	}

	// Public capabilities must be derived from the current viewer, not stored
	// on the pin or copied from its author. These are fixture-only role changes.
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE space_members SET role = 'member' WHERE user_id = 'usr-alice'; UPDATE space_members SET role = 'admin' WHERE user_id = 'usr-bob'`); err != nil {
		t.Fatal(err)
	}
	assertPin("usr-alice", true, ownerPin)
	assertPin("usr-bob", false, ownerPin)
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE space_members SET role = 'member' WHERE user_id = 'usr-bob'`); err != nil {
		t.Fatal(err)
	}
	assertPin("usr-bob", false, memberPin)

	if _, err := fixture.pool.Exec(fixture.ctx, `DELETE FROM conversation_pinned_messages WHERE message_id = $1`, first.ID); err != nil {
		t.Fatal(err)
	}
	assertPin("usr-alice", false, nil)
	if _, err := fixture.pool.Exec(fixture.ctx, `INSERT INTO conversation_pinned_messages (conversation_id, message_id, pinned_by_user_id, created_at) VALUES ('conv-messages', $1, 'usr-alice', $2)`, first.ID, fixture.now); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Recall(fixture.ctx, RecallInput{ActorID: "usr-alice", MessageID: first.ID}); err != nil {
		t.Fatal(err)
	}
	assertPin("usr-alice", false, nil)
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE conversation_members SET removed_at = $1 WHERE conversation_id = 'conv-messages' AND user_id = 'usr-bob'`, fixture.now); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.List(fixture.ctx, ListOptions{ActorID: "usr-bob", ConversationID: "conv-messages"}); err == nil {
		t.Fatal("removed member read pinned-message history")
	}
}
