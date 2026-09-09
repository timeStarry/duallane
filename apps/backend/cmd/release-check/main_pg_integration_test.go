//go:build postgres_integration

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/platform/releasecheck"
)

const (
	releaseCheckIntegrationUploadID     = "release-check-upload"
	releaseCheckIntegrationAttachmentID = "release-check-attachment"
)

func TestReleaseCheckCommandPostgresProviderIntegration(t *testing.T) {
	if strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")) == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}

	t.Run("local ready", func(t *testing.T) {
		fixture := newReleaseCheckCommandPGFixture(t)
		fixture.setDatabaseEnvironment(t)
		t.Setenv(config.WorkspaceStorageDriverEnv, providerDriverLocal)
		t.Setenv(config.WorkspaceS3CredentialsFileEnv, filepath.Join(t.TempDir(), "must-not-be-read"))
		before := fixture.fingerprint(t)

		result, code := runReleaseCheckCommandIntegration(t, "")
		if code != 0 {
			t.Fatalf("exit code = %d, want ready", code)
		}
		if result.Status != "ready" || result.Scope != "database_and_provider_snapshot" {
			t.Fatalf("command result = %#v, want local ready provider snapshot", result)
		}
		assertReadyDatabaseSnapshot(t, result)
		if result.Provider == nil || result.Provider.Driver != providerDriverLocal || result.Provider.Status != providerStatusNotApplicable || !result.Provider.ReadOnly {
			t.Fatalf("local provider result = %#v", result.Provider)
		}
		fixture.assertUnchanged(t, before)
	})

	t.Run("reserved upload blocks without S3 contact", func(t *testing.T) {
		fixture := newReleaseCheckCommandPGFixture(t)
		fixture.seedReservedUpload(t)
		fixture.setDatabaseEnvironment(t)
		provider := &releaseCheckProviderHTTPFixture{}
		server := httptest.NewServer(provider)
		t.Cleanup(server.Close)
		configureReleaseCheckS3Environment(t, server.URL, writeReleaseCheckCredentials(t))
		before := fixture.fingerprint(t)

		result, code := runReleaseCheckCommandIntegration(t, "")
		if code != 2 {
			t.Fatalf("exit code = %d, want database blocker", code)
		}
		if result.Status != "blocked" || result.Scope != "database_and_provider_snapshot" {
			t.Fatalf("command result = %#v, want blocked database snapshot", result)
		}
		assertDatabaseBlockedSnapshot(t, result)
		if result.Provider == nil || result.Provider.Status != providerStatusNotChecked || result.Provider.Code != providerCodeDatabaseNotReady {
			t.Fatalf("provider was not marked not-checked: %#v", result.Provider)
		}
		if requests := provider.snapshotRequests(); len(requests) != 0 {
			t.Fatalf("database blocker contacted provider: %#v", requests)
		}
		fixture.assertUnchanged(t, before)
	})

	for _, testCase := range []struct {
		name             string
		status           int
		body             string
		wantCode         int
		wantStatus       string
		wantProvider     string
		wantProviderCode string
		wantErrorCode    string
		forbiddenText    string
	}{
		{
			name:             "S3 empty list is ready",
			status:           http.StatusOK,
			body:             `<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`,
			wantCode:         0,
			wantStatus:       "ready",
			wantProvider:     providerStatusReady,
			wantProviderCode: "storage.multipart_quiescent",
		},
		{
			name:             "S3 upload is blocked",
			status:           http.StatusOK,
			body:             `<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Upload><Key>integration-private-key</Key><UploadId>integration-private-upload</UploadId></Upload></ListMultipartUploadsResult>`,
			wantCode:         2,
			wantStatus:       "blocked",
			wantProvider:     providerStatusBlocked,
			wantProviderCode: "storage.multipart_not_quiescent",
			forbiddenText:    "integration-private-upload",
		},
		{
			name:             "S3 forbidden response fails",
			status:           http.StatusForbidden,
			body:             `<Error><Code>AccessDenied</Code><Message>integration-provider-secret</Message></Error>`,
			wantCode:         1,
			wantStatus:       "failed",
			wantProvider:     providerStatusFailed,
			wantProviderCode: providerCodeCheckFailed,
			wantErrorCode:    "provider_failed",
			forbiddenText:    "integration-provider-secret",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newReleaseCheckCommandPGFixture(t)
			fixture.setDatabaseEnvironment(t)
			provider := &releaseCheckProviderHTTPFixture{status: testCase.status, body: []byte(testCase.body)}
			server := httptest.NewServer(provider)
			t.Cleanup(server.Close)
			configureReleaseCheckS3Environment(t, server.URL, writeReleaseCheckCredentials(t))
			before := fixture.fingerprint(t)

			result, code := runReleaseCheckCommandIntegration(t, testCase.forbiddenText)
			if code != testCase.wantCode || result.Status != testCase.wantStatus || result.Scope != "database_and_provider_snapshot" {
				t.Fatalf("code/status/scope = %d/%s/%s, want %d/%s/database_and_provider_snapshot", code, result.Status, result.Scope, testCase.wantCode, testCase.wantStatus)
			}
			assertReadyDatabaseSnapshot(t, result)
			if result.Provider == nil || result.Provider.Driver != providerDriverS3 || result.Provider.Status != testCase.wantProvider || result.Provider.Code != testCase.wantProviderCode || !result.Provider.ReadOnly {
				t.Fatalf("S3 provider result = %#v", result.Provider)
			}
			if testCase.wantErrorCode != "" && result.ErrorCode != testCase.wantErrorCode {
				t.Fatalf("error code = %q, want %q", result.ErrorCode, testCase.wantErrorCode)
			}
			assertReleaseCheckProviderListRequest(t, provider.snapshotRequests())
			if testCase.forbiddenText != "" && bytes.Contains(result.rawOutput, []byte(testCase.forbiddenText)) {
				t.Fatalf("provider key/body leaked into command output")
			}
			fixture.assertUnchanged(t, before)
		})
	}
}

type integrationCommandResult struct {
	commandReport
	rawOutput []byte
}

func runReleaseCheckCommandIntegration(t *testing.T, forbiddenText string) (integrationCommandResult, int) {
	t.Helper()
	var output, diagnostic bytes.Buffer
	code := runWithProvider(context.Background(), []string{"--check-provider"}, &output, &diagnostic, observeDatabase, observeConfiguredProvider)
	if diagnostic.Len() != 0 {
		t.Fatalf("unexpected diagnostic output: %q", diagnostic.String())
	}
	if forbiddenText != "" && strings.Contains(output.String(), forbiddenText) {
		t.Fatalf("unsafe provider detail in command output")
	}
	var result commandReport
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("decode command output: %v; output=%q", err, output.String())
	}
	return integrationCommandResult{commandReport: result, rawOutput: output.Bytes()}, code
}

func assertReadyDatabaseSnapshot(t *testing.T, result integrationCommandResult) {
	t.Helper()
	if result.Snapshot == nil || !result.Snapshot.ReadOnly || !result.Snapshot.Ready || result.Snapshot.SnapshotAt.IsZero() {
		t.Fatalf("database snapshot is not ready/read-only: %#v", result.Snapshot)
	}
	if len(result.Snapshot.Blockers) != 0 {
		t.Fatalf("ready snapshot has blockers: %#v", result.Snapshot.Blockers)
	}
	if result.Snapshot.Writers.Status != releasecheck.ObservationNotProven || result.Snapshot.Provider.Status != releasecheck.ObservationNotChecked {
		t.Fatalf("snapshot overstated external coverage: writers=%#v provider=%#v", result.Snapshot.Writers, result.Snapshot.Provider)
	}
	if result.Snapshot.Counts != (releasecheck.Counts{}) {
		t.Fatalf("empty fixture aggregate counts = %#v, want zero", result.Snapshot.Counts)
	}
}

func assertDatabaseBlockedSnapshot(t *testing.T, result integrationCommandResult) {
	t.Helper()
	if result.Snapshot == nil || !result.Snapshot.ReadOnly || result.Snapshot.Ready {
		t.Fatalf("database blocker snapshot = %#v", result.Snapshot)
	}
	if result.Snapshot.Writers.Status != releasecheck.ObservationNotProven || result.Snapshot.Provider.Status != releasecheck.ObservationNotChecked {
		t.Fatalf("snapshot overstated external coverage: writers=%#v provider=%#v", result.Snapshot.Writers, result.Snapshot.Provider)
	}
	if result.Snapshot.Counts.Uploads.Reserved != 1 || result.Snapshot.Counts.Uploads.StaleReserved != 1 || result.Snapshot.Counts.Uploads.MissingAttachment != 0 || result.Snapshot.Counts.Uploads.NonPendingAttachment != 0 || result.Snapshot.Counts.Uploads.PartRows != 0 {
		t.Fatalf("reserved upload aggregates = %#v", result.Snapshot.Counts.Uploads)
	}
	if releaseCheckBlockerCount(*result.Snapshot, releasecheck.BlockerUploadReserved) != 1 {
		t.Fatalf("reserved upload blocker missing: %#v", result.Snapshot.Blockers)
	}
}

func releaseCheckBlockerCount(report releasecheck.Report, code string) int64 {
	for _, blocker := range report.Blockers {
		if blocker.Code == code {
			return blocker.Count
		}
	}
	return 0
}

type releaseCheckCommandPGFixture struct {
	ctx    context.Context
	conn   *pgx.Conn
	schema string
	dsn    string
}

func newReleaseCheckCommandPGFixture(t *testing.T) *releaseCheckCommandPGFixture {
	t.Helper()
	baseDSN := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if baseDSN == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, baseDSN)
	if err != nil {
		t.Fatal(err)
	}
	schema := randomReleaseCheckSchema(t)
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		_ = conn.Close(context.Background())
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop isolated release-check schema: %v", err)
		}
		if err := conn.Close(context.Background()); err != nil {
			t.Errorf("close isolated release-check connection: %v", err)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../web/server/migrations"))
	if _, err := (migrations.Runner{
		Beginner: postgres.NewMigrationBeginner(conn), Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	seedReleaseCheckCommandBase(t, conn, ctx)
	isolatedDSN, err := url.Parse(baseDSN)
	if err != nil {
		t.Fatal(err)
	}
	query := isolatedDSN.Query()
	query.Set("search_path", schema)
	isolatedDSN.RawQuery = query.Encode()
	return &releaseCheckCommandPGFixture{ctx: ctx, conn: conn, schema: schema, dsn: isolatedDSN.String()}
}

func randomReleaseCheckSchema(t *testing.T) string {
	t.Helper()
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	return "duallane_release_check_cli_" + hex.EncodeToString(random[:])
}

func (f *releaseCheckCommandPGFixture) setDatabaseEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", f.dsn)
}

func seedReleaseCheckCommandBase(t *testing.T, conn *pgx.Conn, ctx context.Context) {
	t.Helper()
	for _, query := range []string{
		`INSERT INTO users (id, github_login, display_name, kind, created_at, last_login_at)
VALUES ('release-cli-user', 'release-cli-user', 'Release CLI', 'human', NOW(), NOW())`,
		`INSERT INTO spaces (id, name, slug, created_by, created_at)
VALUES ('release-cli-space', 'Release CLI', 'release-cli', 'release-cli-user', NOW())`,
		`INSERT INTO space_members (space_id, user_id, role, joined_at)
VALUES ('release-cli-space', 'release-cli-user', 'owner', NOW())`,
		`INSERT INTO conversations (id, space_id, type, title, created_by, created_at)
VALUES ('release-cli-conversation', 'release-cli-space', 'group', 'Release CLI', 'release-cli-user', NOW())`,
	} {
		if _, err := conn.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *releaseCheckCommandPGFixture) seedReservedUpload(t *testing.T) {
	t.Helper()
	createdAt := time.Now().UTC().Add(-time.Hour)
	if _, err := f.conn.Exec(f.ctx, `INSERT INTO attachments
(id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type, byte_size, upload_transfer_id, created_at)
VALUES ($1, 'release-cli-space', 'release-cli-user', 'release-cli-conversation', 'private_staging', 'pending', 'fixture.txt', 'text/plain', 4, $2, $3)`, releaseCheckIntegrationAttachmentID, releaseCheckIntegrationUploadID, createdAt); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(f.ctx, `INSERT INTO transfer_ledger
(id, space_id, user_id, direction, byte_size, status, attachment_id, created_at, last_activity_at)
VALUES ($1, 'release-cli-space', 'release-cli-user', 'upload', 4, 'reserved', $2, $3, $3)`, releaseCheckIntegrationUploadID, releaseCheckIntegrationAttachmentID, createdAt); err != nil {
		t.Fatal(err)
	}
}

type releaseCheckDatabaseFingerprint struct {
	users                    int64
	spaces                   int64
	spaceMembers             int64
	conversations            int64
	attachments              int64
	transfers                int64
	parts                    int64
	emailJobs                int64
	ntfyJobs                 int64
	digests                  int64
	echoSolicitations        int64
	echoSolicitationDelivery int64
	echoReleases             int64
	echoReleaseDelivery      int64
	migrations               int64
	transferStatus           string
	attachmentStatus         string
}

func (f *releaseCheckCommandPGFixture) fingerprint(t *testing.T) releaseCheckDatabaseFingerprint {
	t.Helper()
	var result releaseCheckDatabaseFingerprint
	if err := f.conn.QueryRow(f.ctx, `SELECT
(SELECT COUNT(*) FROM users),
(SELECT COUNT(*) FROM spaces),
(SELECT COUNT(*) FROM space_members),
(SELECT COUNT(*) FROM conversations),
(SELECT COUNT(*) FROM attachments),
(SELECT COUNT(*) FROM transfer_ledger),
(SELECT COUNT(*) FROM workspace_upload_parts),
(SELECT COUNT(*) FROM workspace_email_jobs),
(SELECT COUNT(*) FROM workspace_ntfy_jobs),
(SELECT COUNT(*) FROM workspace_email_digest_states),
(SELECT COUNT(*) FROM echo_solicitations),
(SELECT COUNT(*) FROM echo_solicitation_deliveries),
(SELECT COUNT(*) FROM echo_release_publications),
(SELECT COUNT(*) FROM echo_release_deliveries),
(SELECT COUNT(*) FROM schema_migrations),
COALESCE((SELECT status FROM transfer_ledger WHERE id = $1), ''),
COALESCE((SELECT status FROM attachments WHERE id = $2), '')`, releaseCheckIntegrationUploadID, releaseCheckIntegrationAttachmentID).Scan(
		&result.users, &result.spaces, &result.spaceMembers, &result.conversations,
		&result.attachments, &result.transfers, &result.parts, &result.emailJobs,
		&result.ntfyJobs, &result.digests, &result.echoSolicitations,
		&result.echoSolicitationDelivery, &result.echoReleases, &result.echoReleaseDelivery,
		&result.migrations, &result.transferStatus, &result.attachmentStatus,
	); err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *releaseCheckCommandPGFixture) assertUnchanged(t *testing.T, before releaseCheckDatabaseFingerprint) {
	t.Helper()
	if after := f.fingerprint(t); after != before {
		t.Fatalf("release-check changed isolated data: before=%#v after=%#v", before, after)
	}
}

type releaseCheckProviderListRequest struct {
	method        string
	path          string
	query         string
	authorization string
}

type releaseCheckProviderHTTPFixture struct {
	mu       sync.Mutex
	status   int
	body     []byte
	requests []releaseCheckProviderListRequest
}

func (f *releaseCheckProviderHTTPFixture) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	f.requests = append(f.requests, releaseCheckProviderListRequest{
		method: request.Method,
		path:   request.URL.Path,
		query:  request.URL.RawQuery,
		// Only the signing scheme and access-key prefix are inspected by the
		// test; no credential value is emitted by the fixture.
		authorization: request.Header.Get("Authorization"),
	})
	body := append([]byte(nil), f.body...)
	status := f.status
	f.mu.Unlock()

	if status == 0 {
		status = http.StatusOK
	}
	if len(body) == 0 {
		body = []byte(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`)
	}
	response.Header().Set("Content-Type", "application/xml")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

func (f *releaseCheckProviderHTTPFixture) snapshotRequests() []releaseCheckProviderListRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	result := make([]releaseCheckProviderListRequest, len(f.requests))
	copy(result, f.requests)
	return result
}

func assertReleaseCheckProviderListRequest(t *testing.T, requests []releaseCheckProviderListRequest) {
	t.Helper()
	if len(requests) != 1 {
		t.Fatalf("provider requests = %d, want exactly one", len(requests))
	}
	request := requests[0]
	if request.method != http.MethodGet || request.path != "/duallane" {
		t.Fatalf("provider request = %q %q, want configured bucket GET", request.method, request.path)
	}
	query, err := url.ParseQuery(request.query)
	if err != nil {
		t.Fatal(err)
	}
	if !query.Has("uploads") || query.Get("max-uploads") != "1" || query.Has("prefix") {
		t.Fatalf("provider query = %q, want bounded multipart list without prefix", request.query)
	}
	if !strings.HasPrefix(request.authorization, "AWS4-HMAC-SHA256 ") || !strings.Contains(request.authorization, "Credential=test-access-key/") {
		t.Fatal("provider request was not SigV4 signed")
	}
}

func writeReleaseCheckCredentials(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte(`{"accessKey":"test-access-key","secretKey":"test-secret-key"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func configureReleaseCheckS3Environment(t *testing.T, endpoint, credentialsPath string) {
	t.Helper()
	t.Setenv(config.WorkspaceStorageDriverEnv, providerDriverS3)
	t.Setenv(config.WorkspaceS3EndpointEnv, endpoint)
	t.Setenv(config.WorkspaceS3BucketEnv, "duallane")
	t.Setenv(config.WorkspaceS3RegionEnv, "us-east-1")
	t.Setenv(config.WorkspaceS3CredentialsFileEnv, credentialsPath)
}
