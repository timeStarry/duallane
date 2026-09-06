//go:build postgres_integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
)

func assertEchoHTTPComposition(t *testing.T, ctx context.Context, app *application, request func(string, string, string, []byte) *httptest.ResponseRecorder) {
	t.Helper()
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
}
