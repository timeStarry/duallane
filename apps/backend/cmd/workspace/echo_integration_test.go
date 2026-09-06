//go:build postgres_integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

func assertEchoHTTPComposition(t *testing.T, ctx context.Context, app *application, request func(string, string, string, []byte) *httptest.ResponseRecorder) {
	t.Helper()
	for _, query := range []string{
		`INSERT INTO users (id,github_login,display_name,kind,created_at) VALUES ('usr_system_echo','__duallane_echo__','Echo','bot',NOW())`,
		`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_default','usr_system_echo','member',NOW())`,
	} {
		if _, err := app.pool.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	unauthenticated := httptest.NewRecorder()
	app.handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/workspace/echo/requirements", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated Echo status=%d", unauthenticated.Code)
	}
	input := []byte(`{"type":"requirement","title":"Composition fixture","detail":"Private synthetic detail","scenario":"Workspace testing","expectedResult":"A durable private requirement","idempotencyKey":"composition-echo-requirement"}`)
	var created struct {
		Requirement requirements.Requirement `json:"requirement"`
	}
	response := request(http.MethodPost, "/api/workspace/echo/requirements", "application/json", input)
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &created) != nil || created.Requirement.PublicID == "" {
		t.Fatalf("Echo requirement create=%d %s", response.Code, response.Body.String())
	}
	var replay struct {
		Requirement requirements.Requirement `json:"requirement"`
	}
	response = request(http.MethodPost, "/api/workspace/echo/requirements", "application/json", input)
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &replay) != nil || replay.Requirement.ID != created.Requirement.ID {
		t.Fatalf("Echo requirement replay=%d %s", response.Code, response.Body.String())
	}
	for _, path := range []string{"/echo/requirements", "/echo/requirements/stats", "/echo/requirements/" + created.Requirement.PublicID, "/echo/requirements/" + created.Requirement.PublicID + "/history"} {
		if response := request(http.MethodGet, "/api/workspace"+path, "", nil); response.Code != http.StatusOK {
			t.Fatalf("Echo %s=%d %s", path, response.Code, response.Body.String())
		}
	}
	var solicitation struct {
		Solicitation solicitations.Solicitation `json:"solicitation"`
	}
	response = request(http.MethodPost, "/api/workspace/echo/solicitations", "application/json", []byte(`{"title":"Synthetic poll","description":"Fixture","question":"Choose","options":["A","B"],"idempotencyKey":"composition-echo-solicitation"}`))
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &solicitation) != nil || solicitation.Solicitation.PublicID == "" {
		t.Fatalf("Echo solicitation create=%d %s", response.Code, response.Body.String())
	}
	response = request(http.MethodPost, "/api/workspace/echo/solicitations/"+solicitation.Solicitation.PublicID+"/publish", "application/json", []byte(`{"expectedRevision":1,"idempotencyKey":"composition-echo-publish"}`))
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &solicitation) != nil || solicitation.Solicitation.Status != solicitations.StatusOpen {
		t.Fatalf("Echo solicitation publish=%d %s", response.Code, response.Body.String())
	}
	var deliveries, requirementRows int
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM echo_solicitation_deliveries WHERE solicitation_id=$1`, solicitation.Solicitation.ID).Scan(&deliveries); err != nil || deliveries != 1 {
		t.Fatalf("durable publication recipients=%d err=%v", deliveries, err)
	}
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM echo_requirements WHERE id=$1`, created.Requirement.ID).Scan(&requirementRows); err != nil || requirementRows != 1 {
		t.Fatalf("idempotent requirement rows=%d err=%v", requirementRows, err)
	}
	var requirementCardID, solicitationCardID string
	for _, target := range []struct {
		cardType, publicID string
		destination        *string
	}{
		{requirements.CardTypeRequirement, created.Requirement.PublicID, &requirementCardID},
		{solicitations.CardType, solicitation.Solicitation.PublicID, &solicitationCardID},
	} {
		if err := app.pool.QueryRow(ctx, `SELECT id FROM workspace_cards WHERE card_type=$1 AND resource_id=$2 AND source_kind='echo'`, target.cardType, target.publicID).Scan(target.destination); err != nil {
			t.Fatalf("durable Echo card %s: %v", target.cardType, err)
		}
		resolved := request(http.MethodGet, "/api/workspace/cards/"+*target.destination, "", nil)
		if resolved.Code != http.StatusOK {
			t.Fatalf("Echo card resolution=%d %s", resolved.Code, resolved.Body.String())
		}
	}
	// The real HTTP adapter supplies the domain idempotency key from the
	// validated action identity; callers do not supply a separate trusted key.
	for attempt := 0; attempt < 2; attempt++ {
		actionResponse := request(http.MethodPost, "/api/workspace/cards/"+requirementCardID+"/actions", "application/json", []byte(`{"actionId":"collect","clientActionId":"composition-echo-collect","expectedRevision":1,"input":{}}`))
		var action struct {
			Action cards.ActionOutcome `json:"action"`
		}
		if actionResponse.Code != http.StatusOK || json.Unmarshal(actionResponse.Body.Bytes(), &action) != nil || !action.Action.OK || action.Action.Replayed != (attempt == 1) {
			t.Fatalf("Echo collect action=%d %s", actionResponse.Code, actionResponse.Body.String())
		}
	}
	var actionEvents, sentDeliveries int
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events WHERE type='card.action' AND target_id=$1`, requirementCardID).Scan(&actionEvents); err != nil || actionEvents != 1 {
		t.Fatalf("Echo action events=%d err=%v", actionEvents, err)
	}
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM echo_solicitation_deliveries WHERE solicitation_id=$1 AND status='sent'`, solicitation.Solicitation.ID).Scan(&sentDeliveries); err != nil || sentDeliveries != 1 {
		t.Fatalf("Echo sent deliveries=%d err=%v", sentDeliveries, err)
	}
	voteInput, err := json.Marshal(map[string]any{
		"actionId": "vote", "clientActionId": "composition-echo-vote", "expectedRevision": solicitation.Solicitation.Revision,
		"input": map[string]any{"optionIds": []string{solicitation.Solicitation.Options[0].ID}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		response := request(http.MethodPost, "/api/workspace/cards/"+solicitationCardID+"/actions", "application/json", voteInput)
		var result struct {
			Action cards.ActionOutcome `json:"action"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || !result.Action.OK || result.Action.Replayed != (attempt == 1) {
			t.Fatalf("Echo vote action=%d %s", response.Code, response.Body.String())
		}
	}
	var echoConversationID string
	if err := app.pool.QueryRow(ctx, `SELECT conversation_id FROM workspace_cards WHERE id=$1`, requirementCardID).Scan(&echoConversationID); err != nil {
		t.Fatal(err)
	}
	commandInput, err := json.Marshal(map[string]any{
		"conversationId": echoConversationID, "botUserId": "usr_system_echo", "source": "/release 0.15.1", "clientInvocationId": "composition-echo-release",
	})
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		response := request(http.MethodPost, "/api/workspace/interactions/commands", "application/json", commandInput)
		var result struct {
			Command interactions.CommandOutcome `json:"command"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || !result.Command.OK || result.Command.Replayed != (attempt == 1) {
			t.Fatalf("Echo release command=%d %s", response.Code, response.Body.String())
		}
	}
	var releaseDeliveries int
	var releaseStatus, releaseError string
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM echo_release_deliveries WHERE status='sent'`).Scan(&releaseDeliveries); err != nil || releaseDeliveries != 1 {
		_ = app.pool.QueryRow(ctx, `SELECT status,COALESCE(last_error_code,'') FROM echo_release_deliveries LIMIT 1`).Scan(&releaseStatus, &releaseError)
		t.Fatalf("Echo release delivery count=%d status=%s safeCode=%s err=%v", releaseDeliveries, releaseStatus, releaseError, err)
	}
}
