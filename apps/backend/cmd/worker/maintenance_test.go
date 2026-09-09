package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

type maintenanceUploadStub struct {
	mu      sync.Mutex
	calls   int
	options []files.UploadMaintenanceOptions
	result  files.UploadMaintenanceResult
	err     error
	onCall  func(context.Context)
}

func (stub *maintenanceUploadStub) RunUploadMaintenance(ctx context.Context, options files.UploadMaintenanceOptions) (files.UploadMaintenanceResult, error) {
	stub.mu.Lock()
	stub.calls++
	stub.options = append(stub.options, options)
	err := stub.err
	result := stub.result
	onCall := stub.onCall
	stub.mu.Unlock()
	if onCall != nil {
		onCall(ctx)
	}
	return result, err
}

type multipartHTTPStub struct {
	server    *httptest.Server
	mu        sync.Mutex
	cursors   []string
	responses []platformstorage.MultipartMaintenanceResult
}

func newMultipartHTTPStub(responses ...platformstorage.MultipartMaintenanceResult) *multipartHTTPStub {
	stub := &multipartHTTPStub{responses: responses}
	stub.server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		cursor := request.URL.Query().Get("cursor")
		stub.mu.Lock()
		stub.cursors = append(stub.cursors, cursor)
		index := len(stub.cursors) - 1
		result := platformstorage.MultipartMaintenanceResult{}
		if index < len(stub.responses) {
			result = stub.responses[index]
		}
		stub.mu.Unlock()
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(result)
	}))
	return stub
}

func (stub *multipartHTTPStub) Close() {
	stub.server.Close()
}

func (stub *multipartHTTPStub) AbortStaleMultipartUploads(ctx context.Context, _ time.Time, cursor string, _ int) (platformstorage.MultipartMaintenanceResult, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, stub.server.URL+"?cursor="+url.QueryEscape(cursor), nil)
	if err != nil {
		return platformstorage.MultipartMaintenanceResult{}, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return platformstorage.MultipartMaintenanceResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return platformstorage.MultipartMaintenanceResult{}, errors.New("synthetic multipart status")
	}
	var result platformstorage.MultipartMaintenanceResult
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return platformstorage.MultipartMaintenanceResult{}, err
	}
	return result, nil
}

type maintenanceMultipartStore struct {
	platformstorage.BlobStore
	multipart platformstorage.MultipartMaintenance
}

func (store *maintenanceMultipartStore) AbortStaleMultipartUploads(ctx context.Context, before time.Time, cursor string, limit int) (platformstorage.MultipartMaintenanceResult, error) {
	return store.multipart.AbortStaleMultipartUploads(ctx, before, cursor, limit)
}

func TestMaintenanceRunnerRetainsAndWrapsMultipartCursor(t *testing.T) {
	storeRoot := t.TempDir()
	local, err := platformstorage.NewLocalBlobStore(storeRoot)
	if err != nil {
		t.Fatal(err)
	}
	multipart := newMultipartHTTPStub(
		platformstorage.MultipartMaintenanceResult{Scanned: 1, Aborted: 1, NextCursor: "marker-1"},
		platformstorage.MultipartMaintenanceResult{Scanned: 1, Aborted: 1},
		platformstorage.MultipartMaintenanceResult{Scanned: 1, Aborted: 1, NextCursor: "marker-1"},
	)
	defer multipart.Close()
	uploads := &maintenanceUploadStub{}
	runner := &maintenanceRunner{
		uploads: uploads,
		store:   &maintenanceMultipartStore{BlobStore: local, multipart: multipart},
		now:     func() time.Time { return time.Date(2026, 9, 6, 15, 0, 0, 0, time.UTC) },
	}
	for cycle := 0; cycle < 3; cycle++ {
		if _, err := runner.processMultipart(context.Background()); err != nil {
			t.Fatalf("cycle %d: %v", cycle, err)
		}
	}
	multipart.mu.Lock()
	cursors := append([]string(nil), multipart.cursors...)
	multipart.mu.Unlock()
	if len(cursors) != 3 || cursors[0] != "" || cursors[1] != "marker-1" || cursors[2] != "" {
		t.Fatalf("multipart cursors=%v", cursors)
	}
	if len(uploads.options) != 0 {
		t.Fatalf("multipart processor unexpectedly started uploads: %#v", uploads.options)
	}
}

func TestMaintenanceRunnerContinuesMultipartAfterUploadFailure(t *testing.T) {
	multipart := newMultipartHTTPStub(platformstorage.MultipartMaintenanceResult{Scanned: 2, Aborted: 1})
	defer multipart.Close()
	uploads := &maintenanceUploadStub{result: files.UploadMaintenanceResult{Scanned: 2}, err: errors.New("synthetic upload failure")}
	runner := &maintenanceRunner{
		uploads: uploads,
		store:   &maintenanceMultipartStore{BlobStore: noopMaintenanceBlobStore{}, multipart: multipart},
	}
	result, err := runner.processUploads(context.Background())
	if err == nil || result.Claimed != 2 || result.Failed < 1 {
		t.Fatalf("upload failure result=%+v error=%v", result, err)
	}
	if _, err := runner.processMultipart(context.Background()); err != nil {
		t.Fatal(err)
	}
	multipart.mu.Lock()
	callCount := len(multipart.cursors)
	multipart.mu.Unlock()
	if callCount != 1 {
		t.Fatalf("multipart page was starved after upload failure: calls=%d", callCount)
	}
}

func TestMaintenanceRunnerDoesNotStartIOAfterCancellation(t *testing.T) {
	multipart := newMultipartHTTPStub(platformstorage.MultipartMaintenanceResult{Scanned: 1, Aborted: 1})
	defer multipart.Close()
	uploads := &maintenanceUploadStub{}
	runner := &maintenanceRunner{
		uploads: uploads,
		store:   &maintenanceMultipartStore{BlobStore: noopMaintenanceBlobStore{}, multipart: multipart},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runner.processUploads(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled process error=%v", err)
	}
	if _, err := runner.processMultipart(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled multipart process error=%v", err)
	}
	if uploads.calls != 0 {
		t.Fatalf("upload service called after cancellation: %d", uploads.calls)
	}
	multipart.mu.Lock()
	callCount := len(multipart.cursors)
	multipart.mu.Unlock()
	if callCount != 0 {
		t.Fatalf("multipart IO called after cancellation: %d", callCount)
	}
}

func TestMaintenanceRunnerStopsBeforeMultipartWhenUploadCancelsCycle(t *testing.T) {
	multipart := newMultipartHTTPStub(platformstorage.MultipartMaintenanceResult{Scanned: 1, Aborted: 1})
	defer multipart.Close()
	ctx, cancel := context.WithCancel(context.Background())
	uploads := &maintenanceUploadStub{
		onCall: func(context.Context) { cancel() },
		err:    context.Canceled,
	}
	runner := &maintenanceRunner{
		uploads: uploads,
		store:   &maintenanceMultipartStore{BlobStore: noopMaintenanceBlobStore{}, multipart: multipart},
	}
	if _, err := runner.processUploads(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled cycle error=%v", err)
	}
	multipart.mu.Lock()
	callCount := len(multipart.cursors)
	multipart.mu.Unlock()
	if callCount != 0 {
		t.Fatalf("multipart IO started after upload budget cancellation: %d", callCount)
	}
}

func TestMaintenanceRunnerBoundsReturnedAttemptCursors(t *testing.T) {
	large := make(map[string]string, files.MaxUploadMaintenanceAttemptCursors+8)
	for index := 0; index < files.MaxUploadMaintenanceAttemptCursors+8; index++ {
		large["upload-"+time.Duration(index).String()] = "cursor"
	}
	uploads := &maintenanceUploadStub{result: files.UploadMaintenanceResult{AttemptCursors: large}}
	runner := &maintenanceRunner{uploads: uploads, store: noopMaintenanceBlobStore{}}
	if _, err := runner.processUploads(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.attemptCursors) > files.MaxUploadMaintenanceAttemptCursors {
		t.Fatalf("worker attempt cursors=%d", len(runner.attemptCursors))
	}
}

func TestMaintenanceFamiliesRunIndependentlyAndJoinOnShutdown(t *testing.T) {
	uploadEntered := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	uploads := &maintenanceUploadStub{onCall: func(ctx context.Context) {
		close(uploadEntered)
		<-ctx.Done()
	}, err: context.Canceled}
	multipart := newMultipartHTTPStub(platformstorage.MultipartMaintenanceResult{Scanned: 1, Aborted: 1})
	defer multipart.Close()
	runner := &maintenanceRunner{uploads: uploads, store: &maintenanceMultipartStore{BlobStore: noopMaintenanceBlobStore{}, multipart: multipart}}
	processors := runner.processors()
	if len(processors) != 2 || processors[1].interval != platformstorage.DefaultMultipartMaintenanceInterval {
		t.Fatalf("independent processors = %#v", processors)
	}
	app := &application{processors: processors, startupDelay: -1}
	done := make(chan struct{})
	go func() { defer close(done); app.run(ctx) }()
	defer func() { cancel(); <-done }()
	select {
	case <-uploadEntered:
	case <-time.After(time.Second):
		t.Fatal("upload processor did not start")
	}
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		multipart.mu.Lock()
		calls := len(multipart.cursors)
		multipart.mu.Unlock()
		if calls > 0 {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("blocked uploads starved multipart processor")
		case <-tick.C:
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("maintenance processors did not join on shutdown")
	}
}

func TestNewMaintenanceBlobStoreUsesLocalConfiguration(t *testing.T) {
	store, err := newMaintenanceBlobStore(context.Background(), config.WorkspaceConfig{
		StorageDriver: "local", DataDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.(*platformstorage.LocalBlobStore); !ok {
		t.Fatalf("local maintenance store=%T", store)
	}
}

type noopMaintenanceBlobStore struct{}

func (noopMaintenanceBlobStore) Put(context.Context, string, io.Reader, int64, string) (platformstorage.StoredObject, error) {
	return platformstorage.StoredObject{}, errors.New("synthetic put is not used")
}

func (noopMaintenanceBlobStore) Open(context.Context, platformstorage.Object, int64) (platformstorage.OpenedObject, error) {
	return platformstorage.OpenedObject{}, errors.New("synthetic open is not used")
}

func (noopMaintenanceBlobStore) Delete(context.Context, platformstorage.Object) error {
	return nil
}
