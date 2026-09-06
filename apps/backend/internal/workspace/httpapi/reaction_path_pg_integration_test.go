//go:build postgres_integration

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type contractReactionCatalog struct{}

func (contractReactionCatalog) IsKnownReactionEmote(_ context.Context, key string) (bool, error) {
	return key == "feishu:ok", nil
}

func (catalog contractReactionCatalog) IsVisibleReactionEmote(ctx context.Context, key string) (bool, error) {
	return catalog.IsKnownReactionEmote(ctx, key)
}

func TestPGEncodedReactionRemovalCommitsOnce(t *testing.T) {
	database := newContractPGDatabase(t)
	if _, err := database.pool.Exec(database.ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
		VALUES ('reaction-contract', $1, 'direct', 'Reaction contract', 'reaction-contract', 10000, $2, $3)
	`, contractPGSpaceID, contractPGOwnerID, database.now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.pool.Exec(database.ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, joined_at)
		VALUES ('reaction-contract', $1, $2)
	`, contractPGOwnerID, database.now); err != nil {
		t.Fatal(err)
	}
	service := messages.NewService(messages.ServiceOptions{
		Repository: messages.NewPGRepository(database.pool), SpaceID: contractPGSpaceID,
		Now: func() time.Time { return database.now }, ReactionEmoteValidator: contractReactionCatalog{},
	})
	message, err := service.Create(database.ctx, messages.CreateInput{
		ActorID: contractPGOwnerID, ConversationID: "reaction-contract", ClientMessageID: "reaction-contract",
		Content: messages.Content{Format: messages.MessageContentFormat, Blocks: []messages.Block{{Type: "text", Text: "Synthetic reaction"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddReaction(database.ctx, messages.ReactionInput{
		ActorID: contractPGOwnerID, MessageID: message.ID, EmoteKey: "feishu:ok",
	}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(database.router(RouterOptions{Messages: service}))
	defer server.Close()
	for _, check := range []struct {
		key    string
		status int
	}{
		{"feishu%3Aok", http.StatusOK},
		{"feishu%3Aok", http.StatusOK},           // Replayed removal must not duplicate events.
		{"feishu%253Aok", http.StatusBadRequest}, // Literal %3A is not a known key.
	} {
		request, err := http.NewRequestWithContext(database.ctx, http.MethodDelete, server.URL+"/api/workspace/messages/"+message.ID+"/reactions/"+check.key, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("X-Workspace-User-ID", contractPGOwnerID)
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			MessageID string                   `json:"messageId"`
			Reactions []messages.ReactionGroup `json:"reactions"`
			Error     struct{ Code string }    `json:"error"`
		}
		decodeErr := json.NewDecoder(response.Body).Decode(&body)
		response.Body.Close()
		if decodeErr != nil || response.StatusCode != check.status {
			t.Fatalf("key=%s status=%d expected=%d decode=%v error=%s", check.key, response.StatusCode, check.status, decodeErr, body.Error.Code)
		}
		if check.status == http.StatusOK && (body.MessageID != message.ID || body.Reactions == nil || len(body.Reactions) != 0) {
			t.Fatalf("removal response was not the empty reaction projection: %#v", body)
		}
		if check.status == http.StatusBadRequest && body.Error.Code != messages.CodeReactionInvalidEmote {
			t.Fatalf("double-encoded key error = %s", body.Error.Code)
		}
	}
	var remaining, removedEvents int
	if err := database.pool.QueryRow(database.ctx, `SELECT count(*) FROM message_reactions WHERE message_id = $1`, message.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if err := database.pool.QueryRow(database.ctx, `SELECT count(*) FROM workspace_events WHERE target_id = $1 AND type = 'reaction.removed'`, message.ID).Scan(&removedEvents); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 || removedEvents != 1 {
		t.Fatalf("reactions=%d removal events=%d", remaining, removedEvents)
	}
}
