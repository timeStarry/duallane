package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type s3TestObject struct {
	content     []byte
	contentType string
	metadata    map[string]string
}

type s3TestRequest struct {
	method        string
	path          string
	authorization string
	acl           string
	contentType   string
	metadata      map[string]string
}

type s3TestServer struct {
	mu          sync.Mutex
	objects     map[string]s3TestObject
	requests    []s3TestRequest
	failStatus  int
	failMessage string
}

func newS3TestServer() *s3TestServer {
	return &s3TestServer{objects: make(map[string]s3TestObject)}
}

func (s *s3TestServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodHead && strings.TrimSuffix(r.URL.Path, "/") == "/duallane" {
		s.mu.Lock()
		s.requests = append(s.requests, s3TestRequest{method: r.Method, path: r.URL.Path, authorization: r.Header.Get("Authorization")})
		failStatus, failMessage := s.failStatus, s.failMessage
		s.mu.Unlock()
		if failStatus != 0 {
			s.writeError(w, failStatus, failMessage)
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}
	key, ok := s.objectKey(r.URL.Path)
	if !ok {
		s.writeError(w, http.StatusNotFound, "NoSuchKey")
		return
	}
	metadata := requestMetadata(r.Header)
	s.mu.Lock()
	s.requests = append(s.requests, s3TestRequest{
		method:        r.Method,
		path:          r.URL.Path,
		authorization: r.Header.Get("Authorization"),
		acl:           r.Header.Get("x-amz-acl"),
		contentType:   r.Header.Get("Content-Type"),
		metadata:      metadata,
	})
	failStatus, failMessage := s.failStatus, s.failMessage
	s.mu.Unlock()
	if failStatus != 0 {
		s.writeError(w, failStatus, failMessage)
		return
	}

	switch r.Method {
	case http.MethodHead:
		s.mu.Lock()
		object, exists := s.objects[key]
		s.mu.Unlock()
		if !exists {
			s.writeError(w, http.StatusNotFound, "NoSuchKey")
			return
		}
		s.writeObjectHeaders(w, object)
		w.WriteHeader(http.StatusOK)
	case http.MethodPut:
		if r.Header.Get("If-None-Match") == "*" {
			s.mu.Lock()
			_, exists := s.objects[key]
			s.mu.Unlock()
			if exists {
				s.writeError(w, http.StatusPreconditionFailed, "PreconditionFailed")
				return
			}
		}
		content, err := io.ReadAll(r.Body)
		if err != nil {
			s.writeError(w, http.StatusBadRequest, "InvalidRequest")
			return
		}
		s.mu.Lock()
		s.objects[key] = s3TestObject{
			content:     append([]byte(nil), content...),
			contentType: r.Header.Get("Content-Type"),
			metadata:    cloneStringMap(metadata),
		}
		s.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	case http.MethodGet:
		s.mu.Lock()
		object, exists := s.objects[key]
		s.mu.Unlock()
		if !exists {
			s.writeError(w, http.StatusNotFound, "NoSuchKey")
			return
		}
		s.writeObjectHeaders(w, object)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(object.content)
	case http.MethodDelete:
		s.mu.Lock()
		delete(s.objects, key)
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		s.writeError(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
	}
}

func (s *s3TestServer) objectKey(path string) (string, bool) {
	const bucketPrefix = "/duallane/"
	if !strings.HasPrefix(path, bucketPrefix) {
		return "", false
	}
	key, err := url.PathUnescape(strings.TrimPrefix(path, bucketPrefix))
	if err != nil || key == "" {
		return "", false
	}
	return key, true
}

func (s *s3TestServer) writeObjectHeaders(w http.ResponseWriter, object s3TestObject) {
	w.Header().Set("Content-Length", strconv.Itoa(len(object.content)))
	if object.contentType != "" {
		w.Header().Set("Content-Type", object.contentType)
	}
	for name, value := range object.metadata {
		w.Header().Set("X-Amz-Meta-"+name, value)
	}
}

func (s *s3TestServer) writeError(w http.ResponseWriter, status int, code string) {
	if code == "" {
		code = "InternalError"
	}
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, "<Error><Code>%s</Code><Message>provider secret response</Message></Error>", code)
}

func requestMetadata(header http.Header) map[string]string {
	metadata := make(map[string]string)
	for key, values := range header {
		lower := strings.ToLower(key)
		if !strings.HasPrefix(lower, "x-amz-meta-") || len(values) == 0 {
			continue
		}
		metadata[strings.TrimPrefix(lower, "x-amz-meta-")] = values[0]
	}
	return metadata
}

func cloneStringMap(source map[string]string) map[string]string {
	clone := make(map[string]string, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func (s *s3TestServer) snapshotRequests() []s3TestRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]s3TestRequest, len(s.requests))
	copy(result, s.requests)
	return result
}

func (s *s3TestServer) object(key string) (s3TestObject, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	object, ok := s.objects[key]
	return object, ok
}

func (s *s3TestServer) setObject(key string, object s3TestObject) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = object
}

func s3TestConfig(endpoint string) S3Config {
	return S3Config{
		Endpoint:  endpoint,
		Region:    "us-east-1",
		Bucket:    "duallane",
		AccessKey: "test-access-key",
		SecretKey: "test-secret-key",
	}
}

func digestForBytes(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

func mustS3Store(t *testing.T, server *s3TestServer) *S3BlobStore {
	t.Helper()
	httpServer := httptest.NewServer(server)
	t.Cleanup(httpServer.Close)
	store, err := NewS3BlobStore(s3TestConfig(httpServer.URL))
	if err != nil {
		t.Fatalf("new S3 store: %v", err)
	}
	return store
}

func errorCode(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected storage error")
	}
	var storageErr *Error
	if !errors.As(err, &storageErr) {
		t.Fatalf("error %T does not implement storage Error: %v", err, err)
	}
	return storageErr.Code
}

func TestS3BlobStoreUsesPrivatePathStyleAndSupportsBoundedLifecycle(t *testing.T) {
	server := newS3TestServer()
	store := mustS3Store(t, server)
	if err := store.AssertReady(context.Background()); err != nil {
		t.Fatalf("assert ready: %v", err)
	}
	content := []byte("workspace bytes")
	digest := digestForBytes(content)
	key, err := CanonicalObjectKey(digest)
	if err != nil {
		t.Fatalf("canonical key: %v", err)
	}

	stored, err := store.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), digest)
	if err != nil {
		t.Fatalf("put object: code=%s cause=%v", errorCode(t, err), errors.Unwrap(err))
	}
	if stored.Reused || stored.Key != key || stored.SHA256 != digest || stored.ByteSize != int64(len(content)) {
		t.Fatalf("unexpected put result: %#v", stored)
	}
	requests := server.snapshotRequests()
	var putRequest *s3TestRequest
	for index := range requests {
		if requests[index].method == http.MethodPut {
			putRequest = &requests[index]
			break
		}
	}
	if putRequest == nil || putRequest.path != "/duallane/"+key {
		t.Fatalf("put did not use bucket path style: %#v", putRequest)
	}
	if !strings.Contains(putRequest.authorization, "Credential=test-access-key/") || strings.Contains(putRequest.authorization, "test-secret-key") {
		t.Fatalf("unexpected authorization header: %q", putRequest.authorization)
	}
	if putRequest.acl != "" {
		t.Fatalf("unexpected object ACL: %q", putRequest.acl)
	}
	if putRequest.contentType != defaultS3ContentType {
		t.Fatalf("unexpected content type: %q", putRequest.contentType)
	}
	if _, present := putRequest.metadata["duallane-sha256"]; !present {
		t.Fatalf("missing digest metadata: %#v", putRequest.metadata)
	}
	if putRequest.metadata["duallane-size"] != strconv.Itoa(len(content)) {
		t.Fatalf("unexpected size metadata: %#v", putRequest.metadata)
	}

	reused, err := store.Put(context.Background(), key, &failingReader{}, int64(len(content)), digest)
	if err != nil {
		t.Fatalf("reuse object: %v", err)
	}
	if !reused.Reused || reused.SHA256 != digest {
		t.Fatalf("unexpected reuse result: %#v", reused)
	}

	opened, err := store.Open(context.Background(), stored.Object, int64(len(content)))
	if err != nil {
		t.Fatalf("open object: %v", err)
	}
	got, readErr := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("read object = %q, read error = %v, close error = %v", got, readErr, closeErr)
	}

	if err := store.Delete(context.Background(), stored.Object); err != nil {
		t.Fatalf("delete object: %v", err)
	}
	if err := store.Delete(context.Background(), stored.Object); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
	if _, err := store.Open(context.Background(), stored.Object, int64(len(content))); errorCode(t, err) != "file.storage_missing" {
		t.Fatalf("missing object code = %q", errorCode(t, err))
	}
}

func TestS3BlobStoreRejectsInvalidUploadAndVerifiesDownloadBytes(t *testing.T) {
	server := newS3TestServer()
	store := mustS3Store(t, server)
	content := []byte("right")
	digest := digestForBytes(content)
	key, err := CanonicalObjectKey(digest)
	if err != nil {
		t.Fatalf("canonical key: %v", err)
	}

	if _, err := store.Put(context.Background(), key, bytes.NewReader([]byte("wr0ng")), int64(len(content)), digest); errorCode(t, err) != "upload.hash_mismatch" {
		t.Fatalf("hash mismatch code = %q", errorCode(t, err))
	}
	if _, exists := server.object(key); exists {
		t.Fatal("hash-mismatched object was not cleaned up")
	}
	if _, err := store.Put(context.Background(), key, bytes.NewReader([]byte("right!")), int64(len(content)), digest); errorCode(t, err) != "upload.size_mismatch" {
		t.Fatalf("extra-byte code = %q", errorCode(t, err))
	}
	if _, exists := server.object(key); exists {
		t.Fatal("size-mismatched object was not cleaned up")
	}

	stored, err := store.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), digest)
	if err != nil {
		t.Fatalf("put valid object: %v", err)
	}
	object, ok := server.object(key)
	if !ok {
		t.Fatal("valid object missing from test server")
	}
	object.content = []byte("wrong")
	server.setObject(key, object)
	opened, err := store.Open(context.Background(), stored.Object, int64(len(content)))
	if err != nil {
		t.Fatalf("open tampered object: %v", err)
	}
	_, readErr := io.ReadAll(opened.Body)
	if closeErr := opened.Body.Close(); closeErr != nil {
		t.Fatalf("close after integrity failure: %v", closeErr)
	}
	if errorCode(t, readErr) != "file.storage_mismatch" {
		t.Fatalf("tampered read code = %q", errorCode(t, readErr))
	}
}

func TestS3BlobStoreBoundsKeysAndProviderErrorsAreSafe(t *testing.T) {
	server := newS3TestServer()
	store := mustS3Store(t, server)
	for _, key := range []string{"../outside", `..\outside`, "/absolute", `C:\outside`, "workspace/../../outside"} {
		if _, err := store.Put(context.Background(), key, strings.NewReader("x"), 1, ""); errorCode(t, err) != "storage.object_invalid_key" {
			t.Fatalf("invalid key %q code = %q", key, errorCode(t, err))
		}
	}
	content := []byte("bounded")
	digest := digestForBytes(content)
	key, _ := CanonicalObjectKey(digest)
	stored, err := store.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), digest)
	if err != nil {
		t.Fatalf("put bounded object: %v", err)
	}
	requestCount := len(server.snapshotRequests())
	if _, err := store.Open(context.Background(), stored.Object, int64(len(content)-1)); errorCode(t, err) != "file.storage_too_large" {
		t.Fatalf("bounded open code = %q", errorCode(t, err))
	}
	if len(server.snapshotRequests()) != requestCount {
		t.Fatal("oversized open made an S3 request")
	}

	for _, config := range []S3Config{
		{Endpoint: "ftp://storage.example", Region: "us-east-1", Bucket: "duallane", AccessKey: "access", SecretKey: "secret"},
		{Endpoint: "http://storage.example/path", Region: "us-east-1", Bucket: "duallane", AccessKey: "access", SecretKey: "secret"},
		{Endpoint: "http://storage.example?secret=1", Region: "us-east-1", Bucket: "duallane", AccessKey: "access", SecretKey: "secret"},
		{Endpoint: "http://storage.example", Region: "us-east-1", Bucket: "INVALID", AccessKey: "access", SecretKey: "secret"},
		{Endpoint: "http://storage.example", Region: "us-east-1", Bucket: "duallane", AccessKey: "", SecretKey: "secret"},
	} {
		if _, err := NewS3BlobStore(config); errorCode(t, err) != "storage.config_invalid" {
			t.Fatalf("invalid S3 config code = %q", errorCode(t, err))
		}
	}

	server.mu.Lock()
	server.failStatus = http.StatusInternalServerError
	server.failMessage = "provider secret response"
	server.mu.Unlock()
	_, err = store.Put(context.Background(), "workspace/uploads/private-key", bytes.NewReader(content), int64(len(content)), "")
	if errorCode(t, err) != "file.storage_unavailable" {
		t.Fatalf("provider put code = %q", errorCode(t, err))
	}
	if strings.Contains(err.Error(), "private-key") || strings.Contains(err.Error(), "test-secret-key") || strings.Contains(err.Error(), "provider secret response") {
		t.Fatalf("provider error leaked sensitive data: %q", err.Error())
	}
	var storageErr *Error
	if !errors.As(err, &storageErr) || storageErr.Public().Cause != nil || storageErr.Public().Message == "" {
		t.Fatalf("unsafe public provider error: %#v", storageErr.Public())
	}
}

type failingReader struct{}

func (*failingReader) Read([]byte) (int, error) {
	return 0, errors.New("source should not be read")
}
