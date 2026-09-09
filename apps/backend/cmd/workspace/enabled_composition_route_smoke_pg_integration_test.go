//go:build postgres_integration

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	enabledCompositionOwnerID = "composition-route-owner"
	enabledCompositionSpaceID = "spc_default"
	enabledCompositionGroupID = "composition-route-group"
)

var enabledCompositionRouteParameter = regexp.MustCompile(`\{[^}]+\}`)

type enabledCompositionRoute struct {
	Method    string `json:"method"`
	Path      string `json:"path"`
	Transport string `json:"transport"`
	Lane      string `json:"lane"`
}

type enabledCompositionRouteInventory struct {
	SchemaVersion int                       `json:"schemaVersion"`
	Routes        []enabledCompositionRoute `json:"routes"`
}

type enabledCompositionTableSnapshot struct {
	Rows   int64
	Digest string
}

type enabledCompositionReadProbe struct {
	Name        string
	Path        string
	Route       string
	Field       string
	FieldIsList bool
	Status      int
	ErrorField  bool
}

func TestEnabledApplicationComposesWorkspaceRouteGraph(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	conn, schema, webDir := newEnabledCompositionDatabase(t, ctx)
	isolatedDSN := enabledCompositionDatabaseURL(t, os.Getenv("TEST_DATABASE_URL"), schema)
	t.Setenv("DATABASE_URL", isolatedDSN)

	app, err := newApplication(ctx, config.WorkspaceConfig{
		Enabled: true, Environment: "test", AppVersion: "composition-smoke", Commit: "synthetic",
		StorageDriver: "local", DataDir: t.TempDir(),
		EmoteCatalogPath:   filepath.Join(webDir, "shared/emote-packs.json"),
		ReleaseCatalogPath: filepath.Join(webDir, "shared/echo-release-guides.json"),
		MigrationsDir:      filepath.Join(webDir, "server/migrations"), GitHubOAuthTimeout: time.Second,
		NtfyBaseURL: "", NtfyWorkerEnabled: false, EmailWorkerEnabled: false,
		MaintenanceEnabled: false, EchoWorkerEnabled: false,
	})
	if err != nil {
		t.Fatalf("enabled application construction failed: %v", err)
	}
	if app == nil || app.pool == nil || app.handler == nil {
		t.Fatal("enabled application returned an incomplete composition")
	}
	t.Cleanup(app.Close)

	authService := auth.NewService(auth.ServiceOptions{Store: auth.NewPGStore(app.pool)})
	session, err := authService.CreateSession(ctx, enabledCompositionOwnerID)
	if err != nil {
		t.Fatalf("create synthetic owner session: %v", err)
	}

	before, err := enabledCompositionTableState(ctx, conn, schema)
	if err != nil {
		t.Fatalf("snapshot setup state: %v", err)
	}

	t.Run("ready health", func(t *testing.T) {
		response := enabledCompositionServe(t, app.handler, http.MethodGet, "/readyz", "", "")
		if response.Code != http.StatusOK {
			t.Fatalf("/readyz status=%d", response.Code)
		}
		var body struct {
			OK    bool   `json:"ok"`
			Lane  string `json:"lane"`
			State string `json:"state"`
		}
		decodeEnabledCompositionJSON(t, response, &body)
		if !body.OK || body.Lane != "ready" || body.State != "ready" {
			t.Fatalf("/readyz projection=%+v", body)
		}

		health := enabledCompositionServe(t, app.handler, http.MethodGet, "/api/health", "", "")
		if health.Code != http.StatusOK {
			t.Fatalf("/api/health status=%d", health.Code)
		}
		var healthBody struct {
			OK      bool   `json:"ok"`
			Service string `json:"service"`
			Lane    string `json:"lane"`
		}
		decodeEnabledCompositionJSON(t, health, &healthBody)
		if !healthBody.OK || healthBody.Service != "duallane" || healthBody.Lane != "ready" {
			t.Fatalf("/api/health projection=%+v", healthBody)
		}
	})

	inventory := loadEnabledCompositionRouteInventory(t)
	observedRoutes := make([]enabledCompositionRoute, 0, len(inventory))
	for _, route := range inventory {
		if !enabledCompositionShouldProbeRejection(route) {
			continue
		}
		route := route
		t.Run("inventory/"+route.Method+"/"+route.Path, func(t *testing.T) {
			body, contentType := enabledCompositionInventoryBody(route)
			response := enabledCompositionServe(t, app.handler, route.Method, concreteEnabledCompositionPath(route.Path), body, contentType)
			assertEnabledCompositionInventoryBoundary(t, route, response)
		})
		observedRoutes = append(observedRoutes, route)
	}

	for _, probe := range enabledCompositionOwnerReadProbes(enabledCompositionOwnerID, enabledCompositionGroupID) {
		probe := probe
		t.Run("owner-read/"+probe.Name, func(t *testing.T) {
			assertEnabledCompositionRoutePresent(t, inventory, http.MethodGet, probe.Route)
			response := enabledCompositionOwnerServe(t, app.handler, session.Token, probe.Path)
			wantStatus := probe.Status
			if wantStatus == 0 {
				wantStatus = http.StatusOK
			}
			if response.Code != wantStatus {
				t.Fatalf("%s status=%d want=%d", probe.Name, response.Code, wantStatus)
			}
			if probe.ErrorField {
				assertEnabledCompositionObjectField(t, response, probe.Field, false)
				return
			}
			if probe.Field == "" {
				assertEnabledCompositionBootstrap(t, response)
				return
			}
			assertEnabledCompositionObjectField(t, response, probe.Field, probe.FieldIsList)
		})
		observedRoutes = append(observedRoutes, enabledCompositionRoute{Method: http.MethodGet, Path: probe.Route})
	}

	for _, probe := range enabledCompositionOwnerNegativeReadProbes(enabledCompositionOwnerID) {
		probe := probe
		t.Run("owner-read-negative/"+probe.Name, func(t *testing.T) {
			assertEnabledCompositionRoutePresent(t, inventory, http.MethodGet, probe.Route)
			response := enabledCompositionOwnerServe(t, app.handler, session.Token, probe.Path)
			if response.Code != probe.Status {
				t.Fatalf("%s status=%d want=%d", probe.Name, response.Code, probe.Status)
			}
			assertEnabledCompositionObjectField(t, response, probe.Field, false)
		})
		observedRoutes = append(observedRoutes, enabledCompositionRoute{Method: http.MethodGet, Path: probe.Route})
	}

	// This all-table snapshot covers domain rows, workspace events and cursors,
	// audit rows, and durable email/ntfy/task state. The reads and rejection
	// probes above must not create business data, events, or jobs after setup.
	afterReads, err := enabledCompositionTableState(ctx, conn, schema)
	if err != nil {
		t.Fatalf("snapshot post-read state: %v", err)
	}
	assertEnabledCompositionStateUnchanged(t, before, afterReads)

	workspaceHandlerDone := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/ws/workspace" {
			defer close(workspaceHandlerDone)
		}
		app.handler.ServeHTTP(response, request.WithContext(ctx))
	}))
	t.Cleanup(server.Close)
	connection, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/workspace", &websocket.DialOptions{
		HTTPHeader: http.Header{"Cookie": {(&http.Cookie{Name: auth.SessionCookieName, Value: session.Token}).String()}},
	})
	if err != nil {
		t.Fatalf("Workspace WebSocket dial: %v", err)
	}
	t.Cleanup(func() { _ = connection.CloseNow() })
	if response == nil || response.StatusCode != http.StatusSwitchingProtocols {
		if connection != nil {
			connection.CloseNow()
		}
		t.Fatalf("Workspace WebSocket upgrade status=%v", response)
	}
	if err := connection.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSeq":0}`)); err != nil {
		_ = connection.CloseNow()
		t.Fatalf("Workspace WebSocket hello: %v", err)
	}
	readCtx, cancelRead := context.WithTimeout(ctx, 5*time.Second)
	_, raw, readErr := connection.Read(readCtx)
	cancelRead()
	_ = connection.CloseNow()
	if readErr != nil {
		t.Fatalf("Workspace WebSocket ready read: %v", readErr)
	}
	var ready struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &ready); err != nil || ready.Type != "ready" {
		t.Fatalf("Workspace WebSocket ready frame type=%q error=%v", ready.Type, err)
	}
	if err := enabledCompositionWaitForPresenceBaseline(ctx, conn, before); err != nil {
		t.Fatalf("Workspace WebSocket presence cleanup: %v", err)
	}
	closeWaitCtx, cancelCloseWait := context.WithTimeout(ctx, 5*time.Second)
	defer cancelCloseWait()
	select {
	case <-workspaceHandlerDone:
	case <-closeWaitCtx.Done():
		t.Fatalf("Workspace WebSocket handler did not finish after close: %v", closeWaitCtx.Err())
	}
	observedRoutes = append(observedRoutes, enabledCompositionRoute{Method: http.MethodGet, Path: "/ws/workspace"})

	metrics := enabledCompositionServe(t, app.handler, http.MethodGet, "/metrics", "", "")
	if metrics.Code != http.StatusOK {
		t.Fatalf("/metrics status=%d", metrics.Code)
	}
	// The static route-inventory test owns registration coverage. This enabled
	// smoke asserts metrics only for routes it intentionally exercised: rejection
	// probes for mutations and positive DTO/WS probes for reads.
	assertEnabledCompositionRouteMetrics(t, metrics.Body.String(), observedRoutes)

	app.Close()
	finalState, err := enabledCompositionTableState(ctx, conn, schema)
	if err != nil {
		t.Fatalf("snapshot final state: %v", err)
	}
	assertEnabledCompositionStateUnchanged(t, before, finalState)
}

func newEnabledCompositionDatabase(t *testing.T, ctx context.Context) (*pgx.Conn, string, string) {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL is not set; enabled composition requires real PostgreSQL")
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_route_graph_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Error("drop owned composition schema failed")
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	webDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../web"))
	if _, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(conn), Directory: filepath.Join(webDir, "server/migrations")}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	for _, query := range []struct {
		SQL  string
		Args []any
	}{
		{SQL: `INSERT INTO users (id, github_login, email, display_name, kind, created_at, last_login_at) VALUES ($1, $2, $3, $4, 'human', $5, $5)`, Args: []any{enabledCompositionOwnerID, "composition-route-owner", "composition-owner@example.test", "Composition Owner", now}},
		{SQL: `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`, Args: []any{enabledCompositionSpaceID, "Composition Workspace", "composition-workspace", enabledCompositionOwnerID, now}},
		{SQL: `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`, Args: []any{enabledCompositionSpaceID, enabledCompositionOwnerID, now}},
		{SQL: `INSERT INTO conversations (id, space_id, type, title, retention_count, created_by, created_at) VALUES ($1, $2, 'group', $3, 10000, $4, $5)`, Args: []any{enabledCompositionGroupID, enabledCompositionSpaceID, "Composition Group", enabledCompositionOwnerID, now}},
		{SQL: `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)`, Args: []any{enabledCompositionGroupID, enabledCompositionOwnerID, now}},
		{SQL: `INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES ($1, 1)`, Args: []any{enabledCompositionSpaceID}},
		{SQL: `INSERT INTO user_notification_preferences (user_id, email, email_source, email_verified_at, enabled, immediate_enabled, digest_enabled, updated_at) VALUES ($1, $2, 'github', $3, 1, 0, 1, $3)`, Args: []any{enabledCompositionOwnerID, "composition-owner@example.test", now}},
		{SQL: `INSERT INTO workspace_ntfy_preferences (user_id, topic, enabled, created_at, updated_at) VALUES ($1, $2, 0, $3, $3)`, Args: []any{enabledCompositionOwnerID, "duallane-composition-route-owner", now}},
	} {
		if _, err := conn.Exec(ctx, query.SQL, query.Args...); err != nil {
			t.Fatal(err)
		}
	}
	return conn, schema, webDir
}

func enabledCompositionDatabaseURL(t *testing.T, dsn, schema string) string {
	t.Helper()
	parsed, err := url.Parse(strings.TrimSpace(dsn))
	if err != nil {
		t.Fatalf("parse TEST_DATABASE_URL: %v", err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func loadEnabledCompositionRouteInventory(t *testing.T) []enabledCompositionRoute {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(sourceFile), "../../api/node-routes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var inventory enabledCompositionRouteInventory
	if err := json.Unmarshal(data, &inventory); err != nil {
		t.Fatal(err)
	}
	if inventory.SchemaVersion != 1 || len(inventory.Routes) == 0 {
		t.Fatal("invalid Node route inventory")
	}
	seen := make(map[string]struct{})
	result := make([]enabledCompositionRoute, 0, len(inventory.Routes))
	for _, route := range inventory.Routes {
		if route.Lane != "workspace" {
			continue
		}
		key := route.Method + " " + route.Path
		if _, exists := seen[key]; exists {
			t.Fatalf("duplicate Workspace inventory route: %s", key)
		}
		seen[key] = struct{}{}
		result = append(result, route)
	}
	if len(result) == 0 {
		t.Fatal("Workspace route inventory is empty")
	}
	return result
}

func concreteEnabledCompositionPath(path string) string {
	return enabledCompositionRouteParameter.ReplaceAllString(path, "composition-id")
}

func enabledCompositionInventoryBody(route enabledCompositionRoute) (string, string) {
	if route.Method == http.MethodGet || route.Method == http.MethodHead || route.Method == http.MethodDelete {
		return "", ""
	}
	if strings.HasSuffix(route.Path, "/content") || strings.Contains(route.Path, "/parts/") {
		return "invalid synthetic content", "application/octet-stream"
	}
	return "not-json", "application/json"
}

func enabledCompositionShouldProbeRejection(route enabledCompositionRoute) bool {
	if route.Method == http.MethodGet || route.Method == http.MethodHead {
		return false
	}
	// Logout is deliberately public and has no protected business operation to
	// reject. Its registration remains covered by the static route inventory.
	return !(route.Method == http.MethodPost && route.Path == "/api/auth/logout")
}

func enabledCompositionServe(t *testing.T, handler http.Handler, method, path, body, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func enabledCompositionOwnerServe(t *testing.T, handler http.Handler, token, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: token})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertEnabledCompositionInventoryBoundary(t *testing.T, route enabledCompositionRoute, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code < http.StatusBadRequest || response.Code >= http.StatusInternalServerError {
		t.Fatalf("non-read inventory probe was not a client rejection: %s %s status=%d", route.Method, route.Path, response.Code)
	}
	body := response.Body.String()
	if strings.Contains(body, "not-json") || strings.Contains(body, "invalid synthetic content") || strings.Contains(body, "#k=") {
		t.Fatalf("inventory rejection reflected probe content: %s %s", route.Method, route.Path)
	}
}

func enabledCompositionOwnerReadProbes(ownerID, groupID string) []enabledCompositionReadProbe {
	return []enabledCompositionReadProbe{
		{Name: "bootstrap", Path: "/api/workspace/bootstrap", Route: "/api/workspace/bootstrap", Field: "", FieldIsList: false},
		{Name: "conversations", Path: "/api/workspace/conversations", Route: "/api/workspace/conversations", Field: "conversations", FieldIsList: true},
		{Name: "conversation", Path: "/api/workspace/conversations/" + groupID, Route: "/api/workspace/conversations/{conversationId}", Field: "conversation", FieldIsList: false},
		{Name: "conversation messages", Path: "/api/workspace/conversations/" + groupID + "/messages", Route: "/api/workspace/conversations/{conversationId}/messages", Field: "messages", FieldIsList: true},
		{Name: "group pins", Path: "/api/workspace/groups/" + groupID + "/pins", Route: "/api/workspace/groups/{conversationId}/pins", Field: "pins", FieldIsList: true},
		{Name: "members", Path: "/api/workspace/members", Route: "/api/workspace/members", Field: "members", FieldIsList: true},
		{Name: "member visibility", Path: "/api/workspace/member-visibility/" + ownerID, Route: "/api/workspace/member-visibility/{userId}", Field: "visibility", FieldIsList: false},
		{Name: "files", Path: "/api/workspace/files", Route: "/api/workspace/files", Field: "files", FieldIsList: true},
		{Name: "emotes", Path: "/api/workspace/me/emotes", Route: "/api/workspace/me/emotes", Field: "items", FieldIsList: true},
		{Name: "emote library", Path: "/api/workspace/me/emote-library", Route: "/api/workspace/me/emote-library", Field: "entries", FieldIsList: true},
		{Name: "emote settings", Path: "/api/workspace/me/emote-settings", Route: "/api/workspace/me/emote-settings", Field: "settings", FieldIsList: false},
		{Name: "email notifications", Path: "/api/workspace/me/notifications", Route: "/api/workspace/me/notifications", Field: "notifications", FieldIsList: false},
		{Name: "email settings", Path: "/api/workspace/settings/email", Route: "/api/workspace/settings/email", Field: "settings", FieldIsList: false},
		{Name: "ntfy", Path: "/api/workspace/me/ntfy", Route: "/api/workspace/me/ntfy", Field: "ntfy", FieldIsList: false},
		{Name: "topics", Path: "/api/workspace/topics", Route: "/api/workspace/topics", Field: "topics", FieldIsList: true},
		{Name: "my topics", Path: "/api/workspace/topics/mine", Route: "/api/workspace/topics/mine", Field: "topics", FieldIsList: true},
		{Name: "conversation topics", Path: "/api/workspace/conversations/" + groupID + "/topics", Route: "/api/workspace/conversations/{conversationId}/topics", Field: "topics", FieldIsList: true},
		{Name: "echo requirements", Path: "/api/workspace/echo/requirements", Route: "/api/workspace/echo/requirements", Field: "requirements", FieldIsList: true},
		{Name: "echo requirement stats", Path: "/api/workspace/echo/requirements/stats", Route: "/api/workspace/echo/requirements/stats", Field: "stats", FieldIsList: false},
		{Name: "echo solicitations", Path: "/api/workspace/echo/solicitations", Route: "/api/workspace/echo/solicitations", Field: "solicitations", FieldIsList: true},
		{Name: "bots", Path: "/api/workspace/bots", Route: "/api/workspace/bots", Field: "bots", FieldIsList: true},
		{Name: "statistics", Path: "/api/workspace/statistics", Route: "/api/workspace/statistics", Field: "statistics", FieldIsList: false},
	}
}

func enabledCompositionOwnerNegativeReadProbes(ownerID string) []enabledCompositionReadProbe {
	return []enabledCompositionReadProbe{
		{Name: "profile avatar", Path: "/api/workspace/avatars/" + ownerID + "/1", Route: "/api/workspace/avatars/{userId}/{version}", Status: http.StatusNotFound, Field: "error", ErrorField: true},
		{Name: "missing card", Path: "/api/workspace/cards/composition-missing-card", Route: "/api/workspace/cards/{cardId}", Status: http.StatusNotFound, Field: "error", ErrorField: true},
		{Name: "missing workflow", Path: "/api/workspace/workflows/composition-missing-workflow", Route: "/api/workspace/workflows/{workflowId}", Status: http.StatusNotFound, Field: "error", ErrorField: true},
	}
}

func assertEnabledCompositionRoutePresent(t *testing.T, inventory []enabledCompositionRoute, method, path string) {
	t.Helper()
	for _, route := range inventory {
		if route.Method == method && route.Path == path {
			return
		}
	}
	t.Fatalf("owner probe route is missing from inventory: %s %s", method, path)
}

func assertEnabledCompositionRouteMetrics(t *testing.T, body string, routes []enabledCompositionRoute) {
	t.Helper()
	for _, route := range routes {
		methodLabel := fmt.Sprintf(`method="%s"`, route.Method)
		routeLabel := fmt.Sprintf(`route="%s"`, route.Path)
		found := false
		for _, line := range strings.Split(body, "\n") {
			if strings.HasPrefix(line, "duallane_workspace_http_requests_total{") &&
				strings.Contains(line, methodLabel) && strings.Contains(line, routeLabel) &&
				strings.Contains(line, `service="workspace"`) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("actual enabled router did not emit route metric for %s %s", route.Method, route.Path)
		}
	}
	if t.Failed() {
		t.FailNow()
	}
}

func decodeEnabledCompositionJSON(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if !strings.HasPrefix(response.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("response content type=%q", response.Header().Get("Content-Type"))
	}
	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response status=%d: %v", response.Code, err)
	}
}

func assertEnabledCompositionObjectField(t *testing.T, response *httptest.ResponseRecorder, field string, list bool) {
	t.Helper()
	var object map[string]json.RawMessage
	decodeEnabledCompositionJSON(t, response, &object)
	raw, ok := object[field]
	if !ok {
		t.Fatalf("response missing %q field", field)
	}
	if list {
		var values []json.RawMessage
		if err := json.Unmarshal(raw, &values); err != nil || values == nil {
			t.Fatalf("field %q is not an array: %v", field, err)
		}
		return
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		t.Fatalf("field %q is not an object", field)
	}
}

func assertEnabledCompositionBootstrap(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	var body map[string]json.RawMessage
	decodeEnabledCompositionJSON(t, response, &body)
	for _, field := range []string{"auth", "space", "policy", "permissions", "members", "conversations", "files", "invites", "inviteSummary", "eventCursor"} {
		if _, ok := body[field]; !ok {
			t.Fatalf("bootstrap missing %q field", field)
		}
	}
	for _, field := range []string{"auth", "space", "policy", "permissions", "inviteSummary"} {
		var value map[string]json.RawMessage
		if err := json.Unmarshal(body[field], &value); err != nil || value == nil {
			t.Fatalf("bootstrap field %q is not an object", field)
		}
	}
	for _, field := range []string{"members", "conversations", "files", "invites"} {
		var value []json.RawMessage
		if err := json.Unmarshal(body[field], &value); err != nil || value == nil {
			t.Fatalf("bootstrap field %q is not an array: %v", field, err)
		}
	}
}

func enabledCompositionTableState(ctx context.Context, conn *pgx.Conn, schema string) (map[string]enabledCompositionTableSnapshot, error) {
	rows, err := conn.Query(ctx, `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`, schema)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tableNames []string
	for rows.Next() {
		var tableName string
		if err := rows.Scan(&tableName); err != nil {
			return nil, err
		}
		tableNames = append(tableNames, tableName)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	state := make(map[string]enabledCompositionTableSnapshot, len(tableNames))
	for _, tableName := range tableNames {
		qualified := pgx.Identifier{schema, tableName}.Sanitize()
		var tableState enabledCompositionTableSnapshot
		query := fmt.Sprintf(`SELECT COUNT(*)::bigint, COALESCE(md5(string_agg(md5(row_to_json(t)::text), ',' ORDER BY md5(row_to_json(t)::text))), '') FROM %s AS t`, qualified)
		if err := conn.QueryRow(ctx, query).Scan(&tableState.Rows, &tableState.Digest); err != nil {
			return nil, err
		}
		state[tableName] = tableState
	}
	return state, nil
}

func assertEnabledCompositionStateUnchanged(t *testing.T, before, after map[string]enabledCompositionTableSnapshot) {
	t.Helper()
	if len(before) != len(after) {
		t.Fatalf("database table set changed: before=%d after=%d", len(before), len(after))
	}
	for table, previous := range before {
		current, ok := after[table]
		if !ok {
			t.Errorf("database table disappeared: %s", table)
			continue
		}
		if previous.Rows != current.Rows || previous.Digest != current.Digest {
			t.Errorf("database table changed: %s rows %d->%d", table, previous.Rows, current.Rows)
		}
	}
	if t.Failed() {
		t.FailNow()
	}
}

func enabledCompositionWaitForPresenceBaseline(ctx context.Context, conn *pgx.Conn, before map[string]enabledCompositionTableSnapshot) error {
	baseline, ok := before["workspace_presence_leases"]
	if !ok {
		return errors.New("workspace_presence_leases table missing from baseline")
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var state enabledCompositionTableSnapshot
		query := `SELECT COUNT(*)::bigint, COALESCE(md5(string_agg(md5(row_to_json(t)::text), ',' ORDER BY md5(row_to_json(t)::text))), '') FROM workspace_presence_leases AS t`
		if err := conn.QueryRow(ctx, query).Scan(&state.Rows, &state.Digest); err != nil {
			return err
		}
		if state == baseline {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("presence lease did not return to baseline")
		case <-ticker.C:
		}
	}
}
