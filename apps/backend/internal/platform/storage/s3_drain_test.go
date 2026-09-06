package storage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type multipartQuiescenceFixture struct {
	mu          sync.Mutex
	status      int
	body        []byte
	block       bool
	started     chan struct{}
	requests    []multipartQuiescenceRequest
	secretToken string
}

type multipartQuiescenceRequest struct {
	method        string
	path          string
	query         string
	authorization string
}

func (f *multipartQuiescenceFixture) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	f.requests = append(f.requests, multipartQuiescenceRequest{
		method:        request.Method,
		path:          request.URL.Path,
		query:         request.URL.RawQuery,
		authorization: request.Header.Get("Authorization"),
	})
	block := f.block
	started := f.started
	status := f.status
	body := append([]byte(nil), f.body...)
	secretToken := f.secretToken
	f.mu.Unlock()

	if block {
		close(started)
		<-request.Context().Done()
		return
	}
	if request.Method != http.MethodGet || !request.URL.Query().Has("uploads") {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if status == 0 {
		status = http.StatusOK
	}
	if len(body) == 0 {
		body = []byte(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`)
	}
	if secretToken != "" {
		body = []byte(`<Error><Code>AccessDenied</Code><Message>` + secretToken + `</Message></Error>`)
	}
	response.Header().Set("Content-Type", "application/xml")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

func (f *multipartQuiescenceFixture) snapshotRequests() []multipartQuiescenceRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	result := make([]multipartQuiescenceRequest, len(f.requests))
	copy(result, f.requests)
	return result
}

func newMultipartQuiescenceStore(t *testing.T, fixture *multipartQuiescenceFixture) *S3BlobStore {
	t.Helper()
	server := httptest.NewServer(fixture)
	t.Cleanup(server.Close)
	store, err := NewS3BlobStore(s3TestConfig(server.URL))
	if err != nil {
		t.Fatalf("new S3 store: %v", err)
	}
	return store
}

func assertMultipartListRequest(t *testing.T, requests []multipartQuiescenceRequest) {
	t.Helper()
	if len(requests) != 1 {
		t.Fatalf("provider requests = %d, want exactly one", len(requests))
	}
	request := requests[0]
	if request.method != http.MethodGet {
		t.Fatalf("provider method = %q, want GET", request.method)
	}
	if request.path != "/duallane" {
		t.Fatalf("provider path = %q, want configured bucket path", request.path)
	}
	query, err := url.ParseQuery(request.query)
	if err != nil {
		t.Fatalf("parse query: %v", err)
	}
	if !query.Has("uploads") || query.Get("max-uploads") != "1" || query.Has("prefix") {
		t.Fatalf("multipart query = %q, want uploads + max-uploads=1 and no prefix", request.query)
	}
	if !strings.HasPrefix(request.authorization, "AWS4-HMAC-SHA256 ") || !strings.Contains(request.authorization, "Credential=test-access-key/") {
		t.Fatalf("request was not SigV4 signed: %q", request.authorization)
	}
}

func validMultipartXMLAtSize(t *testing.T, size int) []byte {
	t.Helper()
	base := []byte(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`)
	if size < len(base) {
		t.Fatalf("valid multipart XML base is %d bytes, want size %d", len(base), size)
	}
	body := make([]byte, size)
	copy(body, base)
	for index := len(base); index < len(body); index++ {
		body[index] = ' '
	}
	return body
}

func validProviderErrorXMLAtSize(t *testing.T, size int) []byte {
	t.Helper()
	base := []byte(`<Error><Code>AccessDenied</Code><Message>denied</Message></Error>`)
	if size < len(base) {
		t.Fatalf("valid provider error XML base is %d bytes, want size %d", len(base), size)
	}
	body := make([]byte, size)
	copy(body, base)
	for index := len(base); index < len(body); index++ {
		body[index] = ' '
	}
	return body
}

func TestS3MultipartQuiescenceReportsOnlySafeBoundedState(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		body      string
		wantCode  string
		wantCount int
		wantError bool
	}{
		{
			name:      "empty complete page",
			body:      `<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`,
			wantCode:  MultipartQuiescenceReadyCode,
			wantCount: 0,
		},
		{
			name:      "one upload",
			body:      `<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Upload><Key>synthetic/key</Key><UploadId>synthetic-upload</UploadId></Upload></ListMultipartUploadsResult>`,
			wantCode:  MultipartQuiescenceBlockedCode,
			wantCount: 1,
			wantError: true,
		},
		{
			name:      "truncated empty page",
			body:      `<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>true</IsTruncated></ListMultipartUploadsResult>`,
			wantCode:  MultipartQuiescenceFailedCode,
			wantCount: 0,
			wantError: true,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := &multipartQuiescenceFixture{body: []byte(testCase.body)}
			store := newMultipartQuiescenceStore(t, fixture)
			report, err := store.CheckMultipartQuiescence(context.Background())
			if report.Code != testCase.wantCode || report.UploadCount != testCase.wantCount || !report.ReadOnly {
				t.Fatalf("report = %#v, want code=%q count=%d readOnly=true", report, testCase.wantCode, testCase.wantCount)
			}
			if (err != nil) != testCase.wantError {
				t.Fatalf("error = %v, wantError=%v", err, testCase.wantError)
			}
			if err != nil && err.Error() != testCase.wantCode {
				t.Fatalf("error code = %q, want %q", err.Error(), testCase.wantCode)
			}
			assertMultipartListRequest(t, fixture.snapshotRequests())
		})
	}
}

func TestS3MultipartQuiescenceAcceptsExactResponseLimit(t *testing.T) {
	fixture := &multipartQuiescenceFixture{body: validMultipartXMLAtSize(t, int(s3MultipartQuiescenceResponseLimit))}
	store := newMultipartQuiescenceStore(t, fixture)
	report, err := store.CheckMultipartQuiescence(context.Background())
	if err != nil || report.Code != MultipartQuiescenceReadyCode || report.UploadCount != 0 || !report.ReadOnly {
		t.Fatalf("exact-limit report=%#v err=%v, want ready empty read-only result", report, err)
	}
	assertMultipartListRequest(t, fixture.snapshotRequests())
}

func TestS3MultipartQuiescenceBoundsMalformedAndProviderResponses(t *testing.T) {
	secret := "provider-secret-response"
	oversized := validMultipartXMLAtSize(t, int(s3MultipartQuiescenceResponseLimit)+1)
	oversizedError := validProviderErrorXMLAtSize(t, int(s3MultipartQuiescenceResponseLimit)+1)
	for _, testCase := range []struct {
		name   string
		status int
		body   []byte
		secret string
	}{
		{name: "missing truncation flag", status: http.StatusOK, body: []byte(`<ListMultipartUploadsResult></ListMultipartUploadsResult>`)},
		{name: "oversized XML", status: http.StatusOK, body: oversized},
		{name: "oversized forbidden provider response", status: http.StatusForbidden, body: oversizedError},
		{name: "forbidden provider response", status: http.StatusForbidden, secret: secret},
		{name: "unsupported provider response", status: http.StatusNotImplemented, secret: secret},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := &multipartQuiescenceFixture{status: testCase.status, body: testCase.body, secretToken: testCase.secret}
			store := newMultipartQuiescenceStore(t, fixture)
			report, err := store.CheckMultipartQuiescence(context.Background())
			if err == nil || report.Code != MultipartQuiescenceFailedCode || report.UploadCount != 0 || !report.ReadOnly {
				t.Fatalf("report=%#v err=%v", report, err)
			}
			if err.Error() != MultipartQuiescenceFailedCode || strings.Contains(err.Error(), secret) {
				t.Fatalf("unsafe error = %q", err.Error())
			}
			encoded, marshalErr := json.Marshal(report)
			if marshalErr != nil || strings.Contains(string(encoded), secret) || strings.Contains(string(encoded), "synthetic-upload") || strings.Contains(string(encoded), "synthetic/key") || strings.Contains(string(encoded), "duallane") || strings.Contains(string(encoded), "127.0.0.1") {
				t.Fatalf("unsafe report = %s err=%v", encoded, marshalErr)
			}
			assertMultipartListRequest(t, fixture.snapshotRequests())
		})
	}
}

type trackingReadCloser struct {
	source    *strings.Reader
	readBytes int64
	closeCall int
}

func (r *trackingReadCloser) Read(p []byte) (int, error) {
	n, err := r.source.Read(p)
	r.readBytes += int64(n)
	return n, err
}

func (r *trackingReadCloser) Close() error {
	r.closeCall++
	return nil
}

func TestBoundedS3ResponseBodyStopsAfterOneByteOverflowProbe(t *testing.T) {
	payload := validMultipartXMLAtSize(t, int(s3MultipartQuiescenceResponseLimit)+1)
	source := &trackingReadCloser{source: strings.NewReader(string(payload))}
	body := &boundedS3ResponseBody{source: source, limit: s3MultipartQuiescenceResponseLimit}
	_, err := io.Copy(io.Discard, body)
	if !errors.Is(err, errMultipartResponseTooLarge) {
		t.Fatalf("bounded copy error = %v, want response-too-large", err)
	}
	if source.readBytes != s3MultipartQuiescenceResponseLimit+1 {
		t.Fatalf("source bytes read = %d, want exactly limit+1", source.readBytes)
	}
	if closeErr := body.Close(); closeErr != nil || source.closeCall != 1 {
		t.Fatalf("close error=%v calls=%d, want one successful close", closeErr, source.closeCall)
	}
}

func TestS3MultipartQuiescenceHonorsCancellationAndDeadline(t *testing.T) {
	fixture := &multipartQuiescenceFixture{}
	store := newMultipartQuiescenceStore(t, fixture)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	report, err := store.CheckMultipartQuiescence(cancelled)
	if err == nil || report.Code != MultipartQuiescenceFailedCode || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled report=%#v err=%v", report, err)
	}
	if requests := fixture.snapshotRequests(); len(requests) != 0 {
		t.Fatalf("cancelled call performed provider I/O: %#v", requests)
	}

	started := make(chan struct{})
	deadlineFixture := &multipartQuiescenceFixture{block: true, started: started}
	deadlineStore := newMultipartQuiescenceStore(t, deadlineFixture)
	deadlineContext, stop := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer stop()
	deadlineReport, deadlineErr := deadlineStore.CheckMultipartQuiescence(deadlineContext)
	if deadlineErr == nil || deadlineReport.Code != MultipartQuiescenceFailedCode || !errors.Is(deadlineErr, context.DeadlineExceeded) {
		t.Fatalf("deadline report=%#v err=%v", deadlineReport, deadlineErr)
	}
	assertMultipartListRequest(t, deadlineFixture.snapshotRequests())
}

var _ io.ReadCloser = (*boundedS3ResponseBody)(nil)
