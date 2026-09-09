package files

import (
	"context"
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

type filesS3LegacyObject struct {
	content     []byte
	contentType string
}

type filesS3LegacyServer struct {
	mu      sync.Mutex
	objects map[string]filesS3LegacyObject
}

func newFilesS3LegacyServer() *filesS3LegacyServer {
	return &filesS3LegacyServer{objects: make(map[string]filesS3LegacyObject)}
}

func (s *filesS3LegacyServer) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	key, ok := filesS3LegacyObjectKey(request.URL.Path)
	if !ok || (request.Method != http.MethodHead && request.Method != http.MethodGet) {
		s.writeError(response, http.StatusNotFound, "NoSuchKey")
		return
	}
	s.mu.Lock()
	object, exists := s.objects[key]
	s.mu.Unlock()
	if !exists {
		s.writeError(response, http.StatusNotFound, "NoSuchKey")
		return
	}
	response.Header().Set("Content-Length", strconv.Itoa(len(object.content)))
	if object.contentType != "" {
		response.Header().Set("Content-Type", object.contentType)
	}
	response.WriteHeader(http.StatusOK)
	if request.Method == http.MethodGet {
		_, _ = response.Write(object.content)
	}
}

func (s *filesS3LegacyServer) writeError(response http.ResponseWriter, status int, code string) {
	response.Header().Set("Content-Type", "application/xml")
	response.WriteHeader(status)
	_ = xml.NewEncoder(response).Encode(struct {
		Code string `xml:"Code"`
	}{Code: code})
}

func (s *filesS3LegacyServer) setObject(key string, content []byte, contentType string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = filesS3LegacyObject{content: append([]byte(nil), content...), contentType: contentType}
}

func filesS3LegacyObjectKey(requestPath string) (string, bool) {
	const bucketPrefix = "/duallane/"
	if !strings.HasPrefix(requestPath, bucketPrefix) {
		return "", false
	}
	key, err := url.PathUnescape(strings.TrimPrefix(requestPath, bucketPrefix))
	if err != nil || key == "" {
		return "", false
	}
	return key, true
}

func TestS3LegacyKnownCanonicalFallbackVerifiesBytesWithoutMetadata(t *testing.T) {
	server := newFilesS3LegacyServer()
	httpServer := httptest.NewServer(server)
	t.Cleanup(httpServer.Close)
	store, err := platformstorage.NewS3BlobStore(platformstorage.S3Config{
		Endpoint: httpServer.URL, Region: "us-east-1", Bucket: "duallane",
		AccessKey: "test-access-key", SecretKey: "test-secret-key",
	})
	if err != nil {
		t.Fatalf("new S3 store: %v", err)
	}

	content := []byte("s3-legacy")
	record := legacyReadAttachment(content)
	record.FileName = "s3-legacy.txt"
	record.StorageKey = "workspace/spc_default/attachment-legacy/s3-legacy.txt"
	digest := testSHA256(content)
	canonicalKey, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		t.Fatal(err)
	}
	record.StorageObjectID = "wso_" + digest
	record.StorageObject = &StorageObjectRecord{
		ID: record.StorageObjectID, SHA256: digest, ObjectKey: canonicalKey,
		ByteSize: int64(len(content)), ContentType: record.MIMEType,
		CreatedAt: record.CreatedAt,
	}
	repo := newFakeFileRepo()
	repo.state.attachments[record.ID] = &record
	server.setObject(record.StorageKey, content, record.MIMEType)
	service := testService(t, repo, store)
	service.legacyReader = store

	opened, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("S3 legacy fallback without metadata: %v", err)
	}
	if opened.SHA256 != digest {
		t.Fatalf("streaming fallback digest = %q, want %q", opened.SHA256, digest)
	}
	got, readErr := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if readErr != nil || closeErr != nil || string(got) != string(content) {
		t.Fatalf("S3 legacy bytes=%q readErr=%v closeErr=%v", got, readErr, closeErr)
	}

	// Keep the HEAD size identical but change the physical bytes. The S3
	// adapter has no legacy digest metadata, so files must reject at EOF.
	server.setObject(record.StorageKey, []byte("s3-broken"), record.MIMEType)
	opened, err = service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("S3 legacy corrupt fallback open: %v", err)
	}
	got, readErr = io.ReadAll(opened.Body)
	closeErr = opened.Body.Close()
	if errorCode(readErr) != CodeFileStorageMismatch || closeErr != nil || string(got) != "s3-broken" {
		t.Fatalf("S3 legacy corrupt bytes=%q readErr=%v closeErr=%v", got, readErr, closeErr)
	}
}
