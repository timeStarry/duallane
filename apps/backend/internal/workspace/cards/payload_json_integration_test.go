//go:build postgres_integration

package cards

import (
	"context"
	"encoding/json"
	"testing"
)

func TestPGRawPayloadSurvivesCreateResolveUpdateActionAndInvalidation(t *testing.T) {
	f := newPGCardIntegrationFixture(t)
	invalidateStatus := StatusInvalidated
	_, err := f.service.Registry().Register(CardDefinition{CardType: "test.raw", SchemaVersion: 1,
		ValidatePayloadJSON: func(raw json.RawMessage) (json.RawMessage, error) { return raw, nil },
		Actions: map[string]CardAction{"close": {Execute: func(context.Context, CardActionContext) (CardActionResult, error) {
			return CardActionResult{CardStatus: &invalidateStatus}, nil
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"z":"\ud800","a":{"second":2,"first":1}}`)
	created, err := f.service.CreateCustomBotCard(f.ctx, CustomBotCreateInput{
		CreateInput: CreateInput{SpaceID: DefaultSpaceID, ConversationID: "conv-cards", CardType: "test.raw", SchemaVersion: 1,
			FallbackText: "Raw card", RawPayload: raw, SourceID: "raw-source", VisibilityScope: VisibilityConversation},
		BotID: "bot-cards", BotUserID: "usr_card_bot",
	})
	if err != nil {
		t.Fatal(err)
	}
	assertStored := func(want json.RawMessage) {
		t.Helper()
		var actual string
		if err := f.pool.QueryRow(f.ctx, `SELECT payload_json FROM workspace_cards WHERE id=$1`, created.ID).Scan(&actual); err != nil {
			t.Fatal(err)
		}
		if actual != string(want) {
			t.Fatalf("stored ordered payload=%s, want=%s", actual, want)
		}
	}
	assertStored(raw)
	resolved, err := f.service.Resolve(f.ctx, "usr_card_member", created.ID, Request{})
	if err != nil || string(mustJSON(resolved.Payload)) != string(raw) {
		t.Fatalf("resolved payload=%s err=%v", mustJSON(resolved.Payload), err)
	}
	updatedRaw := json.RawMessage(`{"z":"updated","a":{"last":2,"first":1}}`)
	updated, err := f.service.UpdateCustomBotCard(f.ctx, CustomBotUpdateInput{SpaceID: DefaultSpaceID, CardID: created.ID, BotID: "bot-cards", BotUserID: "usr_card_bot", ExpectedRevision: 1, RawPayload: updatedRaw})
	if err != nil {
		t.Fatal(err)
	}
	assertStored(updatedRaw)
	_, err = f.service.ExecuteAction(f.ctx, ActionInput{ActorID: "usr_card_member", CardID: created.ID, ActionID: "close", ClientActionID: "raw-close", ExpectedRevision: updated.Revision, Input: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	assertStored(updatedRaw)
	_, err = f.service.InvalidateCustomBotCard(f.ctx, CustomBotInvalidateInput{SpaceID: DefaultSpaceID, CardID: created.ID, BotID: "bot-cards", BotUserID: "usr_card_bot", ExpectedRevision: updated.Revision + 1, Status: StatusExpired})
	if err != nil {
		t.Fatal(err)
	}
	assertStored(updatedRaw)
}
