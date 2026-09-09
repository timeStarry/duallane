package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	platformmetrics "github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
)

var (
	_ ObjectObserver           = (*platformmetrics.Metrics)(nil)
	_ BlobStore                = (*LocalBlobStore)(nil)
	_ LegacyReader             = (*LocalBlobStore)(nil)
	_ UploadAttemptMaintenance = (*LocalBlobStore)(nil)
	_ BlobStore                = (*S3BlobStore)(nil)
	_ LegacyReader             = (*S3BlobStore)(nil)
	_ UploadAttemptMaintenance = (*S3BlobStore)(nil)
	_ MultipartMaintenance     = (*S3BlobStore)(nil)
	_ BlobStore                = (*HybridBlobStore)(nil)
	_ LegacyReader             = (*HybridBlobStore)(nil)
	_ UploadAttemptMaintenance = (*HybridBlobStore)(nil)
	_ MultipartMaintenance     = (*HybridBlobStore)(nil)
)

type storageObservation struct {
	service   platformmetrics.Service
	operation platformmetrics.ObjectOperation
	outcome   platformmetrics.ObjectOutcome
	bytes     int64
}

type recordingStorageObserver struct {
	mu     sync.Mutex
	values []storageObservation
}

func (r *recordingStorageObserver) ObserveObject(service platformmetrics.Service, operation platformmetrics.ObjectOperation, outcome platformmetrics.ObjectOutcome, bytes int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values = append(r.values, storageObservation{service: service, operation: operation, outcome: outcome, bytes: bytes})
}

func (r *recordingStorageObserver) snapshot() []storageObservation {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]storageObservation(nil), r.values...)
}

func (r *recordingStorageObserver) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values = nil
}

func newObservedLocalStore(t *testing.T, observer *recordingStorageObserver) *LocalBlobStore {
	t.Helper()
	store, err := NewLocalBlobStoreWithOptions(LocalBlobStoreOptions{
		Root: t.TempDir(),
		ObservationOptions: ObservationOptions{
			Observer: observer,
			Service:  platformmetrics.ServiceWorkspace,
		},
	})
	if err != nil {
		t.Fatalf("new observed local store: %v", err)
	}
	return store
}

func requireStorageObservations(t *testing.T, got []storageObservation, want ...storageObservation) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("observations = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("observation[%d] = %#v, want %#v", index, got[index], want[index])
		}
	}
}

func TestObservedLocalStreamSeparatesOpenFromVerificationAndCloseIsIdempotent(t *testing.T) {
	observer := &recordingStorageObserver{}
	store := newObservedLocalStore(t, observer)
	content := []byte("storage observer bytes")
	key := "workspace/uploads/observer/content"

	stored, err := store.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), "")
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	opened, err := store.Open(context.Background(), stored.Object, int64(len(content)))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	observations := observer.snapshot()
	requireStorageObservations(t, observations,
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationPut, outcome: platformmetrics.ObjectOutcomeSuccess, bytes: int64(len(content))},
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationOpen, outcome: platformmetrics.ObjectOutcomeSuccess},
	)

	partial := make([]byte, 4)
	if count, readErr := opened.Body.Read(partial); readErr != nil || count != len(partial) {
		t.Fatalf("partial read count=%d err=%v", count, readErr)
	}
	if err := opened.Body.Close(); err != nil {
		t.Fatalf("early close: %v", err)
	}
	if err := opened.Body.Close(); err != nil {
		t.Fatalf("idempotent close: %v", err)
	}
	observations = observer.snapshot()
	requireStorageObservations(t, observations,
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationPut, outcome: platformmetrics.ObjectOutcomeSuccess, bytes: int64(len(content))},
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationOpen, outcome: platformmetrics.ObjectOutcomeSuccess},
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationVerify, outcome: platformmetrics.ObjectOutcomeFailure, bytes: int64(len(partial))},
	)

	opened, err = store.Open(context.Background(), stored.Object, int64(len(content)))
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	got, err := io.ReadAll(opened.Body)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("full read = %q, err=%v", got, err)
	}
	if err := opened.Body.Close(); err != nil {
		t.Fatalf("full close: %v", err)
	}
	observations = observer.snapshot()
	if len(observations) != 5 || observations[3] != (storageObservation{
		service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationOpen, outcome: platformmetrics.ObjectOutcomeSuccess,
	}) || observations[4] != (storageObservation{
		service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationVerify, outcome: platformmetrics.ObjectOutcomeSuccess, bytes: int64(len(content)),
	}) {
		t.Fatalf("full stream observations = %#v", observations)
	}
}

func TestObservedLocalStreamCancellationIsOneFailedVerification(t *testing.T) {
	observer := &recordingStorageObserver{}
	store := newObservedLocalStore(t, observer)
	content := []byte("cancelled stream")
	stored, err := store.Put(context.Background(), "workspace/uploads/observer/cancel", bytes.NewReader(content), int64(len(content)), "")
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	observer.mu.Lock()
	observer.values = nil
	observer.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	opened, err := store.Open(ctx, stored.Object, int64(len(content)))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	cancel()
	if _, readErr := opened.Body.Read(make([]byte, 8)); !errors.Is(readErr, context.Canceled) {
		t.Fatalf("cancelled read error = %v", readErr)
	}
	if err := opened.Body.Close(); err != nil {
		t.Fatalf("cancelled close: %v", err)
	}
	requireStorageObservations(t, observer.snapshot(),
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationOpen, outcome: platformmetrics.ObjectOutcomeSuccess},
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationVerify, outcome: platformmetrics.ObjectOutcomeFailure},
	)
}

func TestObservedReadCloserCloseUnblocksBlockedRead(t *testing.T) {
	observer := &recordingStorageObserver{}
	body := newBlockingStorageReadCloser()
	reader := &observedReadCloser{
		ctx:      context.Background(),
		body:     body,
		observer: newOperationObserver(ObservationOptions{Observer: observer, Service: platformmetrics.ServiceWorkspace}),
	}

	readDone := make(chan error, 1)
	go func() {
		_, err := reader.Read(make([]byte, 1))
		readDone <- err
	}()
	select {
	case <-body.started:
	case <-time.After(time.Second):
		t.Fatal("blocked reader did not start")
	}

	closeDone := make(chan error, 1)
	go func() { closeDone <- reader.Close() }()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("close: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("close waited for blocked read instead of interrupting it")
	}
	select {
	case err := <-readDone:
		if err == nil {
			t.Fatal("interrupted read unexpectedly succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("read remained blocked after close")
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("idempotent close: %v", err)
	}
	if got := body.closeCallCount(); got != 1 {
		t.Fatalf("body close calls = %d, want 1", got)
	}
	requireStorageObservations(t, observer.snapshot(), storageObservation{
		service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationVerify, outcome: platformmetrics.ObjectOutcomeFailure,
	})
}

func TestObservedReadCloserEOFAfterCancellationIsFailure(t *testing.T) {
	observer := &recordingStorageObserver{}
	ctx, cancel := context.WithCancel(context.Background())
	reader := &observedReadCloser{
		ctx:      ctx,
		body:     &cancelBeforeEOFReadCloser{cancel: cancel},
		observer: newOperationObserver(ObservationOptions{Observer: observer, Service: platformmetrics.ServiceWorkspace}),
	}

	if _, err := reader.Read(make([]byte, 1)); !errors.Is(err, context.Canceled) {
		t.Fatalf("EOF after cancellation error = %v, want context.Canceled", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	requireStorageObservations(t, observer.snapshot(), storageObservation{
		service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationVerify, outcome: platformmetrics.ObjectOutcomeFailure,
	})
}

func TestS3VerifiedReadCloserCloseUnblocksBlockedRead(t *testing.T) {
	body := newBlockingStorageReadCloser()
	reader := newS3VerifiedReadCloser(context.Background(), body, 0, "")

	readDone := make(chan error, 1)
	go func() {
		_, err := reader.Read(make([]byte, 1))
		readDone <- err
	}()
	select {
	case <-body.started:
	case <-time.After(time.Second):
		t.Fatal("blocked S3 reader did not start")
	}

	closeDone := make(chan error, 1)
	go func() { closeDone <- reader.Close() }()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("close: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("S3 close waited for blocked read instead of interrupting it")
	}
	select {
	case err := <-readDone:
		if err == nil {
			t.Fatal("interrupted S3 read unexpectedly succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("S3 read remained blocked after close")
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("idempotent close: %v", err)
	}
	if got := body.closeCallCount(); got != 1 {
		t.Fatalf("S3 body close calls = %d, want 1", got)
	}
}

func TestS3VerifiedReadCloserBoundsPayloadReturnedAfterClose(t *testing.T) {
	const expected = int64(4)
	for _, useCopy := range []bool{false, true} {
		name := "readall"
		if useCopy {
			name = "copy"
		}
		t.Run(name, func(t *testing.T) {
			body := newPayloadAfterCloseReadCloser([]byte("payload-after-close"))
			reader := newS3VerifiedReadCloser(context.Background(), body, expected, "")
			closeDone := make(chan error, 1)
			go func() {
				<-body.started
				closeDone <- reader.Close()
			}()

			var destination bytes.Buffer
			var err error
			if useCopy {
				_, err = io.Copy(&destination, reader)
			} else {
				var data []byte
				data, err = io.ReadAll(reader)
				destination.Write(data)
			}
			if err == nil {
				t.Fatal("close-raced oversized read unexpectedly succeeded")
			}
			if !errors.Is(err, io.ErrClosedPipe) {
				t.Fatalf("close-raced oversized read error = %v, want io.ErrClosedPipe", err)
			}
			if got := int64(destination.Len()); got != expected {
				t.Fatalf("received %d bytes, want exactly %d after clipping", got, expected)
			}
			if err := <-closeDone; err != nil {
				t.Fatalf("close: %v", err)
			}
			if got := body.closeCallCount(); got != 1 {
				t.Fatalf("body close calls = %d, want 1", got)
			}
		})
	}
}

type blockingStorageReadCloser struct {
	started    chan struct{}
	release    chan struct{}
	startOnce  sync.Once
	closeOnce  sync.Once
	mu         sync.Mutex
	closeCalls int
}

func newBlockingStorageReadCloser() *blockingStorageReadCloser {
	return &blockingStorageReadCloser{started: make(chan struct{}), release: make(chan struct{})}
}

func (r *blockingStorageReadCloser) Read([]byte) (int, error) {
	r.startOnce.Do(func() { close(r.started) })
	<-r.release
	return 0, errors.New("synthetic blocked read interrupted")
}

func (r *blockingStorageReadCloser) Close() error {
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closeCalls++
		r.mu.Unlock()
		close(r.release)
	})
	return nil
}

func (r *blockingStorageReadCloser) closeCallCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.closeCalls
}

type payloadAfterCloseReadCloser struct {
	started    chan struct{}
	release    chan struct{}
	payload    []byte
	startOnce  sync.Once
	closeOnce  sync.Once
	mu         sync.Mutex
	closeCalls int
}

func newPayloadAfterCloseReadCloser(payload []byte) *payloadAfterCloseReadCloser {
	return &payloadAfterCloseReadCloser{
		started: make(chan struct{}),
		release: make(chan struct{}),
		payload: append([]byte(nil), payload...),
	}
}

func (r *payloadAfterCloseReadCloser) Read(p []byte) (int, error) {
	r.startOnce.Do(func() { close(r.started) })
	<-r.release
	return copy(p, r.payload), nil
}

func (r *payloadAfterCloseReadCloser) Close() error {
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closeCalls++
		r.mu.Unlock()
		close(r.release)
	})
	return nil
}

func (r *payloadAfterCloseReadCloser) closeCallCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.closeCalls
}

type cancelBeforeEOFReadCloser struct {
	cancel context.CancelFunc
	once   sync.Once
}

func (r *cancelBeforeEOFReadCloser) Read([]byte) (int, error) {
	r.once.Do(r.cancel)
	return 0, io.EOF
}

func (*cancelBeforeEOFReadCloser) Close() error { return nil }

func TestObservedPutReportsConsumedBytesOnFailureWithoutProviderDetails(t *testing.T) {
	observer := &recordingStorageObserver{}
	store := newObservedLocalStore(t, observer)
	_, err := store.Put(context.Background(), "workspace/uploads/observer/failure", &partialErrorReader{}, 4, "")
	if err == nil {
		t.Fatal("partial source unexpectedly succeeded")
	}
	observations := observer.snapshot()
	requireStorageObservations(t, observations,
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationPut, outcome: platformmetrics.ObjectOutcomeFailure, bytes: 4},
	)
}

type partialErrorReader struct {
	done bool
}

func (r *partialErrorReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, io.EOF
	}
	r.done = true
	copy(p, "part")
	return 4, errors.New("synthetic provider detail must not be observed")
}

func TestObservedLocalCleanupUsesFixedOperationAndPreservesCapabilities(t *testing.T) {
	observer := &recordingStorageObserver{}
	store := newObservedLocalStore(t, observer)
	content := []byte("staged attempt")
	key := "workspace/uploads/observer/attempts/object"
	if _, err := store.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), ""); err != nil {
		t.Fatalf("put attempt: %v", err)
	}
	observer.reset()
	if _, err := store.ListUploadAttemptObjects(context.Background(), "observer", time.Time{}, "", 10); err != nil {
		t.Fatalf("list attempts: %v", err)
	}
	if err := store.DeleteUploadAttemptObject(context.Background(), "observer", key); err != nil {
		t.Fatalf("delete attempt: %v", err)
	}
	if err := store.DeleteUploadAttemptObject(context.Background(), "observer", key); err != nil {
		t.Fatalf("idempotent delete attempt: %v", err)
	}
	observations := observer.snapshot()
	requireStorageObservations(t, observations,
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationCleanup, outcome: platformmetrics.ObjectOutcomeSuccess},
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationCleanup, outcome: platformmetrics.ObjectOutcomeSuccess, bytes: int64(len(content))},
		storageObservation{service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationCleanup, outcome: platformmetrics.ObjectOutcomeSuccess},
	)
	if _, ok := any(store).(LegacyReader); !ok {
		t.Fatal("observed local store lost LegacyReader capability")
	}
	if _, ok := any(store).(UploadAttemptMaintenance); !ok {
		t.Fatal("observed local store lost UploadAttemptMaintenance capability")
	}
}

func TestObservedS3MultipartUsesFixedOperation(t *testing.T) {
	now := time.Now().UTC()
	server := &multipartFixtureServer{uploads: []multipartFixture{{
		key: "workspace/uploads/observer/attempts/object", uploadID: "observer-mpu", initiated: now.Add(-8 * 24 * time.Hour),
	}}}
	httpServer := httptest.NewServer(server)
	t.Cleanup(httpServer.Close)
	observer := &recordingStorageObserver{}
	store, err := NewS3BlobStoreWithOptions(S3BlobStoreOptions{
		Config: s3TestConfig(httpServer.URL),
		ObservationOptions: ObservationOptions{
			Observer: observer,
			Service:  platformmetrics.ServiceWorker,
		},
	})
	if err != nil {
		t.Fatalf("new observed S3 store: %v", err)
	}
	if _, err := store.AbortStaleMultipartUploads(context.Background(), now.Add(-7*24*time.Hour), "", 10); err != nil {
		t.Fatalf("abort stale multipart: %v", err)
	}
	requireStorageObservations(t, observer.snapshot(), storageObservation{
		service: platformmetrics.ServiceWorker, operation: platformmetrics.ObjectOperationMultipartAbort, outcome: platformmetrics.ObjectOutcomeSuccess,
	})
	if _, ok := any(store).(MultipartMaintenance); !ok {
		t.Fatal("observed S3 store lost MultipartMaintenance capability")
	}
}

func TestObservedS3OpenDoesNotImplyVerifiedRead(t *testing.T) {
	server := newS3TestServer()
	httpServer := httptest.NewServer(server)
	t.Cleanup(httpServer.Close)
	observer := &recordingStorageObserver{}
	store, err := NewS3BlobStoreWithOptions(S3BlobStoreOptions{
		Config: s3TestConfig(httpServer.URL),
		ObservationOptions: ObservationOptions{
			Observer: observer,
			Service:  platformmetrics.ServiceWorkspace,
		},
	})
	if err != nil {
		t.Fatalf("new observed S3 store: %v", err)
	}
	content := []byte("right")
	digest := digestForBytes(content)
	key, err := CanonicalObjectKey(digest)
	if err != nil {
		t.Fatalf("canonical key: %v", err)
	}
	stored, err := store.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), digest)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	server.setObject(key, s3TestObject{content: []byte("wrong"), metadata: map[string]string{
		"duallane-size":   "5",
		"duallane-sha256": digest,
	}})
	opened, err := store.Open(context.Background(), stored.Object, int64(len(content)))
	if err != nil {
		t.Fatalf("open tampered object: %v", err)
	}
	if _, err := io.ReadAll(opened.Body); err == nil {
		t.Fatal("tampered stream unexpectedly verified")
	}
	if err := opened.Body.Close(); err != nil {
		t.Fatalf("tampered close: %v", err)
	}
	observations := observer.snapshot()
	if len(observations) != 3 || observations[0] != (storageObservation{
		service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationPut, outcome: platformmetrics.ObjectOutcomeSuccess, bytes: int64(len(content)),
	}) || observations[1] != (storageObservation{
		service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationOpen, outcome: platformmetrics.ObjectOutcomeSuccess,
	}) || observations[2] != (storageObservation{
		service: platformmetrics.ServiceWorkspace, operation: platformmetrics.ObjectOperationVerify, outcome: platformmetrics.ObjectOutcomeFailure, bytes: int64(len(content)),
	}) {
		t.Fatalf("S3 stream observations = %#v", observations)
	}
}
