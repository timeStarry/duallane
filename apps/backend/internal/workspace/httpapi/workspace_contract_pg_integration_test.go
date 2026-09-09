//go:build postgres_integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

const (
	contractPGSpaceID   = "spc_default"
	contractPGOwnerID   = "usr_contract_owner"
	contractPGMemberID  = "usr_contract_member"
	contractPGAuditorID = "usr_contract_auditor"
)

var contractPGSequence atomic.Uint64

type contractPGDatabase struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	schema string
	now    time.Time
}

type contractPGAuditEvidence struct {
	Action     string
	TargetType string
	TargetID   string
	Result     string
	Reason     string
}

func contractPGIDFactory(prefix string) func() (string, error) {
	return func() (string, error) {
		return fmt.Sprintf("%s-%d", prefix, contractPGSequence.Add(1)), nil
	}
}

func newContractPGDatabase(t *testing.T) *contractPGDatabase {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_http_contract_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("remove owned HTTP contract schema: %v", err)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (platformmigrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	if _, err := conn.Exec(ctx, `
		INSERT INTO users (id, github_login, email, display_name, kind, created_at, last_login_at)
		VALUES
			($1, 'contract-owner', 'owner@example.test', 'Contract Owner', 'human', $4, $4),
			($2, 'contract-member', 'member@example.test', 'Contract Member', 'human', $4, NULL),
			($3, 'contract-auditor', NULL, 'Contract Auditor', 'human', $4, NULL)
	`, contractPGOwnerID, contractPGMemberID, contractPGAuditorID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ($1, 'Contract Workspace', 'contract-workspace', $2, $3)
	`, contractPGSpaceID, contractPGOwnerID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
		VALUES
			($1, $2, 'owner', $4, NULL),
			($1, $3, 'member', $4, NULL),
			($1, $5, 'auditor', $4, NULL)
	`, contractPGSpaceID, contractPGOwnerID, contractPGMemberID, now, contractPGAuditorID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES ($1, 1)
	`, contractPGSpaceID); err != nil {
		t.Fatal(err)
	}

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if poolConfig.ConnConfig.RuntimeParams == nil {
		poolConfig.ConnConfig.RuntimeParams = make(map[string]string)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return &contractPGDatabase{ctx: ctx, pool: pool, schema: schema, now: now}
}

func (database *contractPGDatabase) actorResolver() ActorResolver {
	store := auth.NewPGStore(database.pool, contractPGIDFactory("contract-auth"))
	service := auth.NewService(auth.ServiceOptions{
		Store:     store,
		Now:       func() time.Time { return database.now },
		IDFactory: contractPGIDFactory("contract-auth-service"),
	})
	return auth.NewHTTPHandler(auth.HTTPHandler{
		Service:          service,
		Environment:      "development",
		FrontendURL:      "https://workspace.example.test",
		WorkspaceEnabled: func() bool { return true },
	})
}

func (database *contractPGDatabase) router(options RouterOptions) http.Handler {
	options.Gate = gate.New("true")
	options.ActorResolver = database.actorResolver()
	options.TrustProxy = true
	if strings.TrimSpace(options.FrontendURL) == "" {
		options.FrontendURL = "https://workspace.example.test"
	}
	return NewRouter(options)
}

func contractPGRequest(method, path, body, actorID, contentType, requestID string) *http.Request {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	if strings.TrimSpace(actorID) != "" {
		request.Header.Set("X-Workspace-User-ID", actorID)
	}
	if strings.TrimSpace(contentType) != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if strings.TrimSpace(requestID) != "" {
		request.Header.Set("X-Request-ID", requestID)
	}
	return request
}

func contractPGServe(database *contractPGDatabase, router http.Handler, request *http.Request) *httptest.ResponseRecorder {
	request = request.WithContext(database.ctx)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func contractPGJSON(database *contractPGDatabase, router http.Handler, method, path, body, actorID, requestID string) *httptest.ResponseRecorder {
	request := contractPGRequest(method, path, body, actorID, "application/json", requestID)
	return contractPGServe(database, router, request)
}

func contractPGDecode(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response status=%d body=%s: %v", response.Code, response.Body.String(), err)
	}
}

func contractPGErrorCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	contractPGDecode(t, response, &payload)
	return payload.Error.Code
}

func contractPGAssertBodyExcludes(t *testing.T, response *httptest.ResponseRecorder, values ...string) {
	t.Helper()
	body := response.Body.String()
	for _, value := range values {
		if strings.Contains(body, value) {
			t.Fatalf("response status=%d exposed %q: %s", response.Code, value, body)
		}
	}
}

func contractPGAuditByRequest(t *testing.T, database *contractPGDatabase, requestID string) contractPGAuditEvidence {
	t.Helper()
	var evidence contractPGAuditEvidence
	err := database.pool.QueryRow(database.ctx, `
		SELECT action, target_type, COALESCE(target_id, ''), result, COALESCE(reason, '')
		FROM audit_logs
		WHERE request_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT 1
	`, requestID).Scan(&evidence.Action, &evidence.TargetType, &evidence.TargetID, &evidence.Result, &evidence.Reason)
	if err != nil {
		t.Fatalf("load audit request %q: %v", requestID, err)
	}
	return evidence
}
