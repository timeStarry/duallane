package storageops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestRunBackfillWithSyntheticS3StorePreservesLegacyObject(t *testing.T) {
	server := newBackfillS3Server()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()

	store, err := storage.NewS3BlobStore(storage.S3Config{
		Endpoint:  httpServer.URL,
		Region:    "us-east-1",
		Bucket:    "duallane",
		AccessKey: "synthetic-access",
		SecretKey: "synthetic-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("synthetic S3 legacy bytes")
	digest := sha256.Sum256(content)
	sha := hex.EncodeToString(digest[:])
	legacyKey := "legacy/s3/attachment"
	if _, err := store.Put(context.Background(), legacyKey, bytes.NewReader(content), int64(len(content)), sha); err != nil {
		t.Fatal(err)
	}

	journal := newFakeBackfillJournal()
	journal.rootItems = []BackfillItem{{
		RunID: "backfill-s3-test", Phase: BackfillPhaseRoot, Kind: "attachment", ResourceID: "att-s3", SpaceID: "space-s3", LegacyStorageKey: legacyKey, ContentType: "text/plain", Revision: 1,
	}}
	backfillStore := &s3BackfillStore{inner: store, legacy: map[string]storage.Object{
		"att-s3": {Key: legacyKey, SHA256: sha, ByteSize: int64(len(content)), ContentType: "text/plain"},
	}}
	report, err := RunBackfill(context.Background(), BackfillOptions{
		Journal:             journal,
		Store:               backfillStore,
		Guard:               &fakeMutationGuard{lease: MutationLease{RunID: "backfill-s3-test", Token: "synthetic-s3-token"}},
		RunID:               "backfill-s3-test",
		ManifestFingerprint: "s3-fingerprint",
		PageSize:            1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "completed" || backfillStore.puts != 1 {
		t.Fatalf("report = %#v puts=%d", report, backfillStore.puts)
	}
	opened, err := store.Open(context.Background(), storage.Object{
		Key:    "workspace/objects/sha256/" + sha[:2] + "/" + sha,
		SHA256: sha, ByteSize: int64(len(content)), ContentType: "text/plain",
	}, storage.DefaultMaxObjectBytes)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if err != nil || closeErr != nil || !bytes.Equal(canonical, content) {
		t.Fatalf("canonical read err=%v close=%v content=%q", err, closeErr, canonical)
	}
	if server.deleteRequests != 0 {
		t.Fatalf("backfill deleted S3 objects: %d", server.deleteRequests)
	}
	if _, err := store.Open(context.Background(), storage.Object{Key: legacyKey, SHA256: sha, ByteSize: int64(len(content))}, storage.DefaultMaxObjectBytes); err != nil {
		t.Fatalf("legacy S3 object was not preserved: %v", err)
	}
}

type s3BackfillStore struct {
	inner  storage.BlobStore
	legacy map[string]storage.Object
	puts   int
}

func (s *s3BackfillStore) Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (storage.StoredObject, error) {
	s.puts++
	return s.inner.Put(ctx, key, source, expectedSize, expectedSHA256)
}

func (s *s3BackfillStore) Open(ctx context.Context, object storage.Object, maxBytes int64) (storage.OpenedObject, error) {
	return s.inner.Open(ctx, object, maxBytes)
}

func (s *s3BackfillStore) InspectLegacy(ctx context.Context, item BackfillItem) (LegacyInspection, error) {
	object, ok := s.legacy[item.ResourceID]
	if !ok {
		return LegacyInspection{}, fmt.Errorf("synthetic S3 legacy object missing")
	}
	opened, err := s.inner.Open(ctx, object, storage.DefaultMaxObjectBytes)
	if err != nil {
		return LegacyInspection{}, err
	}
	if err := opened.Body.Close(); err != nil {
		return LegacyInspection{}, err
	}
	return LegacyInspection{SHA256: object.SHA256, ByteSize: object.ByteSize}, nil
}

func (s *s3BackfillStore) OpenLegacy(ctx context.Context, item BackfillItem) (storage.OpenedObject, error) {
	object, ok := s.legacy[item.ResourceID]
	if !ok {
		return storage.OpenedObject{}, fmt.Errorf("synthetic S3 legacy object missing")
	}
	return s.inner.Open(ctx, object, storage.DefaultMaxObjectBytes)
}

type backfillS3Server struct {
	mu             sync.Mutex
	objects        map[string]backfillS3Object
	deleteRequests int
}

type backfillS3Object struct {
	content     []byte
	contentType string
	sha256      string
	byteSize    int64
}

func newBackfillS3Server() *backfillS3Server {
	return &backfillS3Server{objects: make(map[string]backfillS3Object)}
}

func (s *backfillS3Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	key, ok := syntheticS3Key(r.URL.Path)
	if !ok {
		s.writeError(w, http.StatusNotFound, "NoSuchKey")
		return
	}
	s.mu.Lock()
	object, exists := s.objects[key]
	s.mu.Unlock()
	switch r.Method {
	case http.MethodHead:
		if !exists {
			s.writeError(w, http.StatusNotFound, "NoSuchKey")
			return
		}
		s.writeHeaders(w, object)
		w.WriteHeader(http.StatusOK)
	case http.MethodPut:
		content, err := io.ReadAll(r.Body)
		if err != nil {
			s.writeError(w, http.StatusBadRequest, "InvalidRequest")
			return
		}
		stored := backfillS3Object{
			content:     append([]byte(nil), content...),
			contentType: r.Header.Get("Content-Type"),
			sha256:      r.Header.Get("X-Amz-Meta-Duallane-Sha256"),
			byteSize:    int64(len(content)),
		}
		s.mu.Lock()
		s.objects[key] = stored
		s.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	case http.MethodGet:
		if !exists {
			s.writeError(w, http.StatusNotFound, "NoSuchKey")
			return
		}
		s.writeHeaders(w, object)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(object.content)
	case http.MethodDelete:
		s.mu.Lock()
		delete(s.objects, key)
		s.deleteRequests++
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		s.writeError(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
	}
}

func (s *backfillS3Server) writeHeaders(w http.ResponseWriter, object backfillS3Object) {
	w.Header().Set("Content-Length", fmt.Sprintf("%d", object.byteSize))
	w.Header().Set("Content-Type", object.contentType)
	w.Header().Set("X-Amz-Meta-Duallane-Size", fmt.Sprintf("%d", object.byteSize))
	w.Header().Set("X-Amz-Meta-Duallane-Sha256", object.sha256)
}

func (s *backfillS3Server) writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, "<Error><Code>%s</Code><Message>synthetic</Message></Error>", code)
}

func syntheticS3Key(rawPath string) (string, bool) {
	decoded, err := url.PathUnescape(rawPath)
	if err != nil {
		return "", false
	}
	trimmed := strings.TrimPrefix(decoded, "/")
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) != 2 || parts[0] != "duallane" || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}
