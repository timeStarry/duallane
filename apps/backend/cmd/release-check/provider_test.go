package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

type providerListRequest struct {
	method        string
	path          string
	query         string
	authorization string
}

type providerListFixture struct {
	mu       sync.Mutex
	body     []byte
	status   int
	requests []providerListRequest
}

func (f *providerListFixture) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	f.requests = append(f.requests, providerListRequest{
		method:        request.Method,
		path:          request.URL.Path,
		query:         request.URL.RawQuery,
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

func (f *providerListFixture) snapshotRequests() []providerListRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	requests := make([]providerListRequest, len(f.requests))
	copy(requests, f.requests)
	return requests
}

func writeProviderCredentials(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte(`{"accessKey":"test-access-key","secretKey":"test-secret-key"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func configureProviderS3(t *testing.T, endpoint, credentialsPath string) {
	t.Helper()
	t.Setenv(config.WorkspaceStorageDriverEnv, providerDriverS3)
	t.Setenv(config.WorkspaceS3EndpointEnv, endpoint)
	t.Setenv(config.WorkspaceS3BucketEnv, "duallane")
	t.Setenv(config.WorkspaceS3RegionEnv, "us-east-1")
	t.Setenv(config.WorkspaceS3CredentialsFileEnv, credentialsPath)
}

func assertProviderListRequest(t *testing.T, requests []providerListRequest) {
	t.Helper()
	if len(requests) != 1 {
		t.Fatalf("provider requests = %d, want one", len(requests))
	}
	request := requests[0]
	if request.method != http.MethodGet || request.path != "/duallane" {
		t.Fatalf("provider request = %q %q, want signed GET to configured bucket", request.method, request.path)
	}
	query, err := url.ParseQuery(request.query)
	if err != nil {
		t.Fatal(err)
	}
	if !query.Has("uploads") || query.Get("max-uploads") != "1" || query.Has("prefix") {
		t.Fatalf("provider query = %q, want only bounded multipart listing", request.query)
	}
	if !strings.HasPrefix(request.authorization, "AWS4-HMAC-SHA256 ") || !strings.Contains(request.authorization, "Credential=test-access-key/") {
		t.Fatalf("provider request was not SigV4 signed")
	}
}

func TestObserveConfiguredProviderS3UsesOneReadOnlySignedList(t *testing.T) {
	fixture := &providerListFixture{}
	server := httptest.NewServer(fixture)
	t.Cleanup(server.Close)
	configureProviderS3(t, server.URL, writeProviderCredentials(t))

	report, err := observeConfiguredProvider(context.Background())
	if err != nil || report.Driver != providerDriverS3 || report.Status != providerStatusReady || report.Code != "storage.multipart_quiescent" || !report.ReadOnly {
		t.Fatalf("provider result = %#v, %v", report, err)
	}
	assertProviderListRequest(t, fixture.snapshotRequests())
}

func TestObserveConfiguredProviderMapsUploadToSafeBlockedState(t *testing.T) {
	fixture := &providerListFixture{body: []byte(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Upload><Key>private/key</Key><UploadId>private-upload</UploadId></Upload></ListMultipartUploadsResult>`)}
	server := httptest.NewServer(fixture)
	t.Cleanup(server.Close)
	configureProviderS3(t, server.URL, writeProviderCredentials(t))

	report, err := observeConfiguredProvider(context.Background())
	if err != nil || report.Driver != providerDriverS3 || report.Status != providerStatusBlocked || report.Code != "storage.multipart_not_quiescent" || !report.ReadOnly {
		t.Fatalf("provider result = %#v, %v", report, err)
	}
	assertProviderListRequest(t, fixture.snapshotRequests())
}

func TestObserveConfiguredProviderLocalIsNotApplicableWithoutS3Access(t *testing.T) {
	t.Setenv(config.WorkspaceStorageDriverEnv, providerDriverLocal)
	t.Setenv(config.WorkspaceS3CredentialsFileEnv, filepath.Join(t.TempDir(), "missing-secret"))
	report, err := observeConfiguredProvider(context.Background())
	if err != nil || report.Driver != providerDriverLocal || report.Status != providerStatusNotApplicable || report.Code != providerCodeNotApplicable || !report.ReadOnly {
		t.Fatalf("local provider result = %#v, %v", report, err)
	}
}

func TestObserveConfiguredProviderFailsClosedForNilCancelAndInvalidConfig(t *testing.T) {
	var nilContext context.Context
	if report, err := observeConfiguredProvider(nilContext); err != errProviderCheck || report.Status != providerStatusFailed || report.Code != providerCodeCheckFailed || !report.ReadOnly {
		t.Fatalf("nil context result = %#v, %v", report, err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if report, err := observeConfiguredProvider(cancelled); !errors.Is(err, context.Canceled) || report.Status != providerStatusFailed || report.Code != providerCodeCheckFailed || !report.ReadOnly {
		t.Fatalf("cancelled context result = %#v, %v", report, err)
	}

	t.Setenv(config.WorkspaceStorageDriverEnv, "unsupported")
	report, err := observeConfiguredProvider(context.Background())
	if err != errProviderConfig || report.Driver != providerDriverUnknown || report.Status != providerStatusFailed || report.Code != providerCodeConfigInvalid {
		t.Fatalf("invalid driver result = %#v, %v", report, err)
	}

	configureProviderS3(t, "not-a-url", writeProviderCredentials(t))
	report, err = observeConfiguredProvider(context.Background())
	if err != errProviderConfig || report.Driver != providerDriverS3 || report.Status != providerStatusFailed || report.Code != providerCodeConfigInvalid || strings.Contains(err.Error(), "not-a-url") {
		t.Fatalf("invalid config result = %#v, %v", report, err)
	}
}

func TestRegularNonSymlinkRejectsNonRegularCredentialPaths(t *testing.T) {
	root := t.TempDir()
	regular := filepath.Join(root, "credentials.json")
	if err := os.WriteFile(regular, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !regularNonSymlink(regular) {
		t.Fatal("regular credential file was rejected")
	}
	if regularNonSymlink(root) {
		t.Fatal("credential directory was accepted")
	}
	link := filepath.Join(root, "credentials-link.json")
	if err := os.Symlink(regular, link); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if regularNonSymlink(link) {
		t.Fatal("credential symlink was accepted")
	}
}
