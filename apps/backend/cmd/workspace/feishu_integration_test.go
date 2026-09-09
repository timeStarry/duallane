//go:build postgres_integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

func assertFeishuHTTPComposition(t *testing.T, ctx context.Context, conn *pgx.Conn, app *application, request func(string, string, string, []byte) *httptest.ResponseRecorder, token, conversationID string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"conversationId": conversationID, "clientMessageId": "main-feishu-message", "idempotencyKey": "main-feishu-card",
		"format": "feishu-card", "feishuCard": json.RawMessage(`{"elements":[{"tag":"action","actions":[{"tag":"button","text":"Confirm","value":{"action_id":"confirm","data":{"z":1,"a":"synthetic"}}}]}]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/bot-gateway/v1/cards", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app.handler.ServeHTTP(response, r)
	var created struct {
		Card struct {
			ID string `json:"id"`
		} `json:"card"`
	}
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &created) != nil || created.Card.ID == "" {
		t.Fatalf("composed Feishu create = %d %s", response.Code, response.Body.String())
	}
	resolved := request(http.MethodGet, "/api/workspace/cards/"+created.Card.ID, "", nil)
	var resolution struct {
		Card cards.Resolution `json:"card"`
	}
	if resolved.Code != http.StatusOK || json.Unmarshal(resolved.Body.Bytes(), &resolution) != nil || resolution.Card.Payload == nil {
		t.Fatalf("composed Feishu resolution = %d %s", resolved.Code, resolved.Body.String())
	}
	for attempt := 0; attempt < 2; attempt++ {
		actionResponse := request(http.MethodPost, "/api/workspace/cards/"+created.Card.ID+"/actions", "application/json", []byte(`{"actionId":"confirm","clientActionId":"main-feishu-action","expectedRevision":1,"input":{}}`))
		var action struct {
			Action cards.ActionOutcome `json:"action"`
		}
		if actionResponse.Code != http.StatusOK || json.Unmarshal(actionResponse.Body.Bytes(), &action) != nil || !action.Action.OK || action.Action.Replayed != (attempt == 1) {
			t.Fatalf("composed Feishu action = %d %s", actionResponse.Code, actionResponse.Body.String())
		}
	}
	var count int
	var payload string
	if err := conn.QueryRow(ctx, `SELECT COUNT(*), MIN(payload_json) FROM workspace_events WHERE type='card.action' AND target_id=$1`, created.Card.ID).Scan(&count, &payload); err != nil || count != 1 {
		t.Fatalf("composed Feishu action events = %d err=%v", count, err)
	}
	if !strings.Contains(payload, `"data":{"z":1,"a":"synthetic"}`) {
		t.Fatalf("composed Feishu event lost validated canonical data: %s", payload)
	}
	// Gateway creation uses an outer card transaction, while updates use the
	// composed action repository. Both must retain Bot owner authorization.
	update := httptest.NewRequest(http.MethodPatch, "/api/bot-gateway/v1/cards/"+created.Card.ID, strings.NewReader(`{"expectedRevision":1,"fallbackText":"Updated synthetic card","format":"feishu-card","feishuCard":{"elements":[{"tag":"div","text":{"tag":"plain_text","content":"Updated synthetic card"}}]}}`))
	update.Header.Set("Authorization", "Bearer "+token)
	update.Header.Set("Content-Type", "application/json")
	updated := httptest.NewRecorder()
	app.handler.ServeHTTP(updated, update)
	var updatedCard struct {
		Card struct {
			Revision int64 `json:"revision"`
		} `json:"card"`
	}
	if updated.Code != http.StatusOK || json.Unmarshal(updated.Body.Bytes(), &updatedCard) != nil || updatedCard.Card.Revision != 2 {
		t.Fatalf("composed Bot card update = %d %s", updated.Code, updated.Body.String())
	}
}
