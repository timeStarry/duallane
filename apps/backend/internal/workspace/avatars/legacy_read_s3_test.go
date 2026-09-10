package avatars

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type nodeAvatarKeyFixture struct {
	Source string              `json:"source"`
	Cases  []nodeAvatarKeyCase `json:"cases"`
}

type nodeAvatarKeyCase struct {
	Name     string `json:"name"`
	UserID   string `json:"userId"`
	Version  string `json:"version"`
	LocalKey string `json:"localKey"`
	S3Key    string `json:"s3Key"`
}

type avatarS3TestObject struct {
	Content       []byte
	ContentType   string
	StatusCode    int
	ErrorCode     string
	ResponseBody  []byte
	ContentLength int
}

type avatarS3TestRequest struct {
	Method string
	Key    string
}

type avatarS3TestServer struct {
	mu       sync.Mutex
	objects  map[string]avatarS3TestObject
	requests []avatarS3TestRequest
}

func newAvatarS3TestServer() *avatarS3TestServer {
	return &avatarS3TestServer{objects: make(map[string]avatarS3TestObject)}
}

func (s *avatarS3TestServer) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	key, ok := avatarS3ObjectKey(request.URL.Path)
	if !ok || (request.Method != http.MethodHead && request.Method != http.MethodGet) {
		s.writeError(response, http.StatusNotFound, "NoSuchKey")
		return
	}
	s.mu.Lock()
	s.requests = append(s.requests, avatarS3TestRequest{Method: request.Method, Key: key})
	object, exists := s.objects[key]
	s.mu.Unlock()
	if !exists {
		s.writeError(response, http.StatusNotFound, "NoSuchKey")
		return
	}
	if object.StatusCode != 0 {
		s.writeError(response, object.StatusCode, object.ErrorCode)
		return
	}
	contentLength := object.ContentLength
	if contentLength == 0 {
		contentLength = len(object.Content)
	}
	response.Header().Set("Content-Length", strconv.Itoa(contentLength))
	if object.ContentType != "" {
		response.Header().Set("Content-Type", object.ContentType)
	}
	response.WriteHeader(http.StatusOK)
	if request.Method == http.MethodGet {
		body := object.ResponseBody
		if body == nil {
			body = object.Content
		}
		_, _ = response.Write(body)
	}
}

func (s *avatarS3TestServer) writeError(response http.ResponseWriter, status int, code string) {
	response.Header().Set("Content-Type", "application/xml")
	response.WriteHeader(status)
	_, _ = fmt.Fprintf(response, "<Error><Code>%s</Code></Error>", code)
}

func (s *avatarS3TestServer) setObject(key string, content []byte, contentType string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = avatarS3TestObject{Content: append([]byte(nil), content...), ContentType: contentType}
}

func (s *avatarS3TestServer) setObjectResponse(key string, headContent, responseBody []byte, contentType string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = avatarS3TestObject{
		Content: append([]byte(nil), headContent...), ContentType: contentType,
		ResponseBody: append([]byte(nil), responseBody...), ContentLength: len(headContent),
	}
}

func (s *avatarS3TestServer) setError(key string, statusCode int, errorCode string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = avatarS3TestObject{StatusCode: statusCode, ErrorCode: errorCode}
}

func (s *avatarS3TestServer) snapshotRequests() []avatarS3TestRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]avatarS3TestRequest(nil), s.requests...)
}

func avatarS3ObjectKey(requestPath string) (string, bool) {
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

func avatarS3Store(t *testing.T, server *avatarS3TestServer) *platformstorage.S3BlobStore {
	t.Helper()
	httpServer := httptest.NewServer(server)
	t.Cleanup(httpServer.Close)
	store, err := platformstorage.NewS3BlobStore(platformstorage.S3Config{
		Endpoint: httpServer.URL, Region: "us-east-1", Bucket: "duallane",
		AccessKey: "test-access-key", SecretKey: "test-secret-key",
	})
	if err != nil {
		t.Fatalf("new S3 store: %v", err)
	}
	return store
}

func loadNodeAvatarKeyFixture(t *testing.T) nodeAvatarKeyFixture {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate avatar S3 regression source")
	}
	content, err := os.ReadFile(filepath.Join(filepath.Dir(sourceFile), "testdata", "node-legacy-avatar-keys.json"))
	if err != nil {
		t.Fatalf("read Node avatar key fixture: %v", err)
	}
	var fixture nodeAvatarKeyFixture
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatalf("decode Node avatar key fixture: %v", err)
	}
	if fixture.Source != "apps/web/server/services/workspace-object-store.mjs#workspaceAvatarObjectKey" {
		t.Fatalf("unexpected Node avatar key fixture source %q", fixture.Source)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("Node avatar key fixture has no cases")
	}
	return fixture
}

func TestOpenProfileAvatarReadsNodeLegacyS3KeysFromGoldenFixture(t *testing.T) {
	fixture := loadNodeAvatarKeyFixture(t)
	seenSeeded := false
	seenUUID := false
	for _, candidate := range fixture.Cases {
		candidate := candidate
		if candidate.UserID == "usr_owner" && candidate.Version == "legacy-version" {
			seenSeeded = true
		}
		if strings.Contains(candidate.UserID, "00000000-0000-4000-8000-") {
			seenUUID = true
		}
		for _, storedKey := range []struct {
			name string
			key  string
		}{
			{name: "local-selector", key: candidate.LocalKey},
			{name: "s3-selector", key: candidate.S3Key},
		} {
			storedKey := storedKey
			t.Run(candidate.Name+"/"+storedKey.name, func(t *testing.T) {
				if candidate.LocalKey == "" || candidate.S3Key == "" {
					t.Fatal("Node avatar key fixture case is missing a key")
				}
				server := newAvatarS3TestServer()
				content := []byte("node legacy avatar:" + candidate.Name)
				server.setObject(candidate.S3Key, content, AvatarContentType)
				store := avatarS3Store(t, server)
				repo := newAvatarFakeRepository(&auth.Actor{ID: candidate.UserID, Kind: "human", Role: "owner"})
				repo.state.avatars[candidate.UserID] = AvatarRecord{
					UserID: candidate.UserID, Version: candidate.Version, StorageKey: storedKey.key,
					AvatarURL: "/api/workspace/avatars/" + candidate.UserID + "/" + candidate.Version,
				}
				service := NewService(ServiceOptions{Repository: repo, LegacyReader: store})

				opened, err := service.OpenProfileAvatar(context.Background(), GetProfileAvatarInput{
					ActorID: candidate.UserID, UserID: candidate.UserID, Version: candidate.Version,
				}, int64(len(content)))
				if err != nil {
					t.Fatalf("open Node legacy avatar from S3: %v", err)
				}
				defer opened.Body.Close()
				got, err := io.ReadAll(opened.Body)
				if err != nil {
					t.Fatalf("read Node legacy avatar from S3: %v", err)
				}
				if string(got) != string(content) {
					t.Fatalf("avatar bytes = %q, want %q", got, content)
				}
				assertAvatarS3Requests(t, server.snapshotRequests(), []avatarS3TestRequest{
					{Method: http.MethodHead, Key: candidate.S3Key},
					{Method: http.MethodHead, Key: candidate.S3Key},
					{Method: http.MethodGet, Key: candidate.S3Key},
				})
			})
		}
	}
	if !seenSeeded {
		t.Fatal("Node avatar key fixture is missing usr_owner/legacy-version")
	}
	if !seenUUID {
		t.Fatal("Node avatar key fixture is missing UUID-user/version coverage")
	}
}

func assertAvatarS3Requests(t *testing.T, got, want []avatarS3TestRequest) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("S3 requests = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("S3 request %d = %#v, want %#v", index, got[index], want[index])
		}
	}
}

func assertAvatarS3RequestsOnlyKey(t *testing.T, requests []avatarS3TestRequest, key string) {
	t.Helper()
	if len(requests) == 0 {
		t.Fatal("S3 request list is empty")
	}
	for _, request := range requests {
		if request.Key != key {
			t.Fatalf("non-missing S3 error tried key %q after %q: %#v", request.Key, key, requests)
		}
	}
}

func TestOpenProfileAvatarCanonicalS3ReadIsFirstAndDirect(t *testing.T) {
	content := []byte("canonical avatar")
	digestBytes := sha256.Sum256(content)
	digest := hex.EncodeToString(digestBytes[:])
	canonicalKey, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		t.Fatalf("canonical key: %v", err)
	}
	server := newAvatarS3TestServer()
	server.setObject(canonicalKey, content, AvatarContentType)
	store := avatarS3Store(t, server)
	repo := newAvatarFakeRepository(&auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"})
	repo.state.avatars["usr_owner"] = AvatarRecord{
		UserID: "usr_owner", Version: "canonical-version", StorageKey: "profile-avatars/usr_owner/canonical-version.webp",
		StorageObjectID: "wso_" + digest, AvatarURL: "/api/workspace/avatars/usr_owner/canonical-version",
	}
	repo.state.objects["wso_"+digest] = StorageObjectRecord{
		ID: "wso_" + digest, SHA256: digest, ObjectKey: canonicalKey,
		ByteSize: int64(len(content)), ContentType: AvatarContentType,
	}
	service := NewService(ServiceOptions{Repository: repo, BlobStore: store, LegacyReader: store})

	opened, err := service.OpenProfileAvatar(context.Background(), GetProfileAvatarInput{
		ActorID: "usr_owner", UserID: "usr_owner", Version: "canonical-version",
	}, int64(len(content)))
	if err != nil {
		t.Fatalf("open canonical avatar: %v", err)
	}
	got, readErr := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("canonical bytes=%q readErr=%v closeErr=%v", got, readErr, closeErr)
	}
	assertAvatarS3Requests(t, server.snapshotRequests(), []avatarS3TestRequest{
		{Method: http.MethodHead, Key: canonicalKey},
		{Method: http.MethodGet, Key: canonicalKey},
	})
}

func TestOpenProfileAvatarLegacyUsesLocalAndHybridReadFlags(t *testing.T) {
	fixture := loadNodeAvatarKeyFixture(t)
	candidate := fixture.Cases[0]
	content := []byte("local legacy avatar")

	t.Run("local", func(t *testing.T) {
		local := newAvatarLocalStore(t, candidate.LocalKey, content)
		service := newLegacyAvatarService(t, candidate, local)
		opened, err := service.OpenProfileAvatar(context.Background(), avatarInput(candidate), int64(len(content)))
		assertAvatarContent(t, opened, err, content)
	})

	t.Run("hybrid-local-read-fallback", func(t *testing.T) {
		server := newAvatarS3TestServer()
		primary := avatarS3Store(t, server)
		local := newAvatarLocalStore(t, candidate.LocalKey, content)
		hybrid, err := platformstorage.NewHybridBlobStore(platformstorage.HybridBlobStoreOptions{
			Primary: primary, Local: local, LocalReadFallback: true,
		})
		if err != nil {
			t.Fatalf("new hybrid store: %v", err)
		}
		service := newLegacyAvatarService(t, candidate, hybrid)
		opened, err := service.OpenProfileAvatar(context.Background(), avatarInput(candidate), int64(len(content)))
		assertAvatarContent(t, opened, err, content)
		assertAvatarS3Requests(t, server.snapshotRequests(), []avatarS3TestRequest{
			{Method: http.MethodHead, Key: candidate.S3Key},
			{Method: http.MethodHead, Key: candidate.LocalKey},
		})
	})

	t.Run("hybrid-s3-priority-over-local", func(t *testing.T) {
		server := newAvatarS3TestServer()
		server.setObject(candidate.S3Key, content, AvatarContentType)
		primary := avatarS3Store(t, server)
		local := newAvatarLocalStore(t, candidate.LocalKey, []byte("stale local avatar"))
		hybrid, err := platformstorage.NewHybridBlobStore(platformstorage.HybridBlobStoreOptions{
			Primary: primary, Local: local, LocalReadFallback: true,
		})
		if err != nil {
			t.Fatalf("new hybrid store: %v", err)
		}
		service := newLegacyAvatarService(t, candidate, hybrid)
		opened, err := service.OpenProfileAvatar(context.Background(), avatarInput(candidate), int64(len(content)))
		assertAvatarContent(t, opened, err, content)
		assertAvatarS3Requests(t, server.snapshotRequests(), []avatarS3TestRequest{
			{Method: http.MethodHead, Key: candidate.S3Key},
			{Method: http.MethodHead, Key: candidate.S3Key},
			{Method: http.MethodGet, Key: candidate.S3Key},
		})
	})

	t.Run("hybrid-no-read-fallback", func(t *testing.T) {
		server := newAvatarS3TestServer()
		primary := avatarS3Store(t, server)
		local := newAvatarLocalStore(t, candidate.LocalKey, content)
		hybrid, err := platformstorage.NewHybridBlobStore(platformstorage.HybridBlobStoreOptions{
			Primary: primary, Local: local, LocalMirrorWrite: true,
		})
		if err != nil {
			t.Fatalf("new hybrid store: %v", err)
		}
		service := newLegacyAvatarService(t, candidate, hybrid)
		_, err = service.OpenProfileAvatar(context.Background(), avatarInput(candidate), int64(len(content)))
		if !isAvatarCode(err, CodeAvatarNotFound) {
			t.Fatalf("hybrid without local read fallback error = %v", err)
		}
		assertAvatarS3Requests(t, server.snapshotRequests(), []avatarS3TestRequest{
			{Method: http.MethodHead, Key: candidate.S3Key},
			{Method: http.MethodHead, Key: candidate.LocalKey},
		})
	})

	t.Run("hybrid-raw-key-denied-does-not-read-local", func(t *testing.T) {
		server := newAvatarS3TestServer()
		server.setError(candidate.LocalKey, http.StatusForbidden, "AccessDenied")
		local := newAvatarLocalStore(t, candidate.LocalKey, content)
		hybrid, err := platformstorage.NewHybridBlobStore(platformstorage.HybridBlobStoreOptions{
			Primary: avatarS3Store(t, server), Local: local, LocalReadFallback: true,
		})
		if err != nil {
			t.Fatalf("new hybrid store: %v", err)
		}
		opened, err := newLegacyAvatarService(t, candidate, hybrid).OpenProfileAvatar(
			context.Background(), avatarInput(candidate), int64(len(content)))
		if opened.Body != nil {
			_ = opened.Body.Close()
			t.Fatal("access denial returned a local body")
		}
		if !isAvatarCode(err, CodeAvatarStorageFailed) {
			t.Fatalf("raw-key denial error = %v", err)
		}
		assertAvatarS3Requests(t, server.snapshotRequests(), []avatarS3TestRequest{
			{Method: http.MethodHead, Key: candidate.S3Key},
			{Method: http.MethodHead, Key: candidate.LocalKey},
		})
	})
}

func TestOpenProfileAvatarCanonicalMissingReadsNodeLegacyS3(t *testing.T) {
	candidate := loadNodeAvatarKeyFixture(t).Cases[0]
	content := []byte("legacy after canonical miss")
	digestBytes := sha256.Sum256(content)
	digest := hex.EncodeToString(digestBytes[:])
	canonicalKey, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		t.Fatal(err)
	}
	server := newAvatarS3TestServer()
	server.setObject(candidate.S3Key, content, AvatarContentType)
	store := avatarS3Store(t, server)
	repo := newAvatarFakeRepository(&auth.Actor{ID: candidate.UserID, Kind: "human", Role: "owner"})
	repo.state.avatars[candidate.UserID] = AvatarRecord{
		UserID: candidate.UserID, Version: candidate.Version, StorageKey: candidate.LocalKey,
		StorageObjectID: "wso_" + digest,
	}
	repo.state.objects["wso_"+digest] = StorageObjectRecord{
		ID: "wso_" + digest, SHA256: digest, ObjectKey: canonicalKey,
		ByteSize: int64(len(content)), ContentType: AvatarContentType,
	}
	service := NewService(ServiceOptions{Repository: repo, BlobStore: store, LegacyReader: store})
	opened, err := service.OpenProfileAvatar(context.Background(), avatarInput(candidate), int64(len(content)))
	assertAvatarContent(t, opened, err, content)
	assertAvatarS3Requests(t, server.snapshotRequests(), []avatarS3TestRequest{
		{Method: http.MethodHead, Key: canonicalKey},
		{Method: http.MethodHead, Key: candidate.S3Key},
		{Method: http.MethodHead, Key: candidate.S3Key},
		{Method: http.MethodGet, Key: candidate.S3Key},
	})
}

func TestOpenProfileAvatarAuthorizationPrecedesS3Read(t *testing.T) {
	candidate := loadNodeAvatarKeyFixture(t).Cases[0]
	server := newAvatarS3TestServer()
	server.setObject(candidate.S3Key, []byte("private avatar"), AvatarContentType)
	service := newLegacyAvatarService(t, candidate, avatarS3Store(t, server))
	input := avatarInput(candidate)
	input.ActorID = "usr_unregistered"
	opened, err := service.OpenProfileAvatar(context.Background(), input, AvatarMaxOutputBytes)
	if opened.Body != nil {
		_ = opened.Body.Close()
		t.Fatal("unauthorized read returned a body")
	}
	if err == nil || len(server.snapshotRequests()) != 0 {
		t.Fatalf("unauthorized read err=%v S3 requests=%d", err, len(server.snapshotRequests()))
	}
}

func TestOpenProfileAvatarLegacyStopsOnS3ProviderFailureAndOversize(t *testing.T) {
	fixture := loadNodeAvatarKeyFixture(t)
	candidate := fixture.Cases[0]

	for _, failure := range []struct {
		name       string
		statusCode int
		errorCode  string
	}{
		{name: "forbidden", statusCode: http.StatusForbidden, errorCode: "AccessDenied"},
		{name: "provider-unavailable", statusCode: http.StatusServiceUnavailable, errorCode: "SlowDown"},
	} {
		failure := failure
		t.Run(failure.name, func(t *testing.T) {
			server := newAvatarS3TestServer()
			server.setError(candidate.S3Key, failure.statusCode, failure.errorCode)
			server.setObject(candidate.LocalKey, []byte("should-not-be-read"), AvatarContentType)
			service := newLegacyAvatarService(t, candidate, avatarS3Store(t, server))
			_, err := service.OpenProfileAvatar(context.Background(), avatarInput(candidate), AvatarMaxOutputBytes)
			if !isAvatarCode(err, CodeAvatarStorageFailed) {
				t.Fatalf("provider failure error = %v", err)
			}
			assertAvatarS3RequestsOnlyKey(t, server.snapshotRequests(), candidate.S3Key)
		})
	}

	t.Run("oversize", func(t *testing.T) {
		server := newAvatarS3TestServer()
		server.setObject(candidate.S3Key, []byte("oversized"), AvatarContentType)
		service := newLegacyAvatarService(t, candidate, avatarS3Store(t, server))
		_, err := service.OpenProfileAvatar(context.Background(), avatarInput(candidate), 3)
		if !isAvatarCode(err, CodeAvatarStorageFailed) {
			t.Fatalf("oversize error = %v", err)
		}
		assertAvatarS3Requests(t, server.snapshotRequests(), []avatarS3TestRequest{
			{Method: http.MethodHead, Key: candidate.S3Key},
		})
	})
}

func TestOpenProfileAvatarLegacyCorruptionAndCancellationDoNotFallback(t *testing.T) {
	fixture := loadNodeAvatarKeyFixture(t)
	candidate := fixture.Cases[0]
	content := []byte("verified avatar")

	t.Run("short-get-body", func(t *testing.T) {
		server := newAvatarS3TestServer()
		server.setObjectResponse(candidate.S3Key, content, content[:len(content)-1], AvatarContentType)
		service := newLegacyAvatarService(t, candidate, avatarS3Store(t, server))
		opened, err := service.OpenProfileAvatar(context.Background(), avatarInput(candidate), int64(len(content)))
		if err != nil {
			t.Fatalf("open corrupt legacy avatar: %v", err)
		}
		_, readErr := io.ReadAll(opened.Body)
		closeErr := opened.Body.Close()
		if readErr == nil || closeErr != nil {
			t.Fatalf("corrupt legacy readErr=%v closeErr=%v", readErr, closeErr)
		}
		assertAvatarS3Requests(t, server.snapshotRequests(), []avatarS3TestRequest{
			{Method: http.MethodHead, Key: candidate.S3Key},
			{Method: http.MethodHead, Key: candidate.S3Key},
			{Method: http.MethodGet, Key: candidate.S3Key},
		})
	})

	t.Run("canceled-before-read", func(t *testing.T) {
		server := newAvatarS3TestServer()
		server.setObject(candidate.S3Key, content, AvatarContentType)
		service := newLegacyAvatarService(t, candidate, avatarS3Store(t, server))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := service.OpenProfileAvatar(ctx, avatarInput(candidate), int64(len(content)))
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled legacy read error = %v", err)
		}
		if requests := server.snapshotRequests(); len(requests) != 0 {
			t.Fatalf("canceled legacy read made S3 requests: %#v", requests)
		}
	})
}

func TestOpenProfileAvatarRejectsUnsafeLegacyIdentityBeforeAdapter(t *testing.T) {
	cases := []struct {
		name   string
		userID string
		key    string
	}{
		{name: "path-in-storage-key", userID: "usr_owner", key: "profile-avatars/usr_owner/../avatar.webp"},
		{name: "path-in-user-id", userID: "usr/../owner", key: "profile-avatars/usr_owner/legacy-version.webp"},
		{name: "unicode-user-id", userID: "用户", key: "profile-avatars/usr_owner/legacy-version.webp"},
	}
	for _, candidate := range cases {
		candidate := candidate
		t.Run(candidate.name, func(t *testing.T) {
			repo := newAvatarFakeRepository(&auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"})
			repo.state.avatars["usr_owner"] = AvatarRecord{
				UserID: candidate.userID, Version: "legacy-version", StorageKey: candidate.key,
			}
			legacy := &avatarFakeLegacyReader{key: candidate.key, content: []byte("should-not-open")}
			service := NewService(ServiceOptions{Repository: repo, LegacyReader: legacy})
			_, err := service.OpenProfileAvatar(context.Background(), GetProfileAvatarInput{
				ActorID: "usr_owner", UserID: "usr_owner", Version: "legacy-version",
			}, AvatarMaxOutputBytes)
			if !isAvatarCode(err, CodeAvatarNotFound) || legacy.calls != 0 {
				t.Fatalf("unsafe identity error=%v legacy calls=%d", err, legacy.calls)
			}
		})
	}
}

func avatarInput(candidate nodeAvatarKeyCase) GetProfileAvatarInput {
	return GetProfileAvatarInput{ActorID: candidate.UserID, UserID: candidate.UserID, Version: candidate.Version}
}

func newLegacyAvatarService(t *testing.T, candidate nodeAvatarKeyCase, reader LegacyObjectReader) *Service {
	t.Helper()
	repo := newAvatarFakeRepository(&auth.Actor{ID: candidate.UserID, Kind: "human", Role: "owner"})
	repo.state.avatars[candidate.UserID] = AvatarRecord{
		UserID: candidate.UserID, Version: candidate.Version, StorageKey: candidate.LocalKey,
		AvatarURL: "/api/workspace/avatars/" + candidate.UserID + "/" + candidate.Version,
	}
	return NewService(ServiceOptions{Repository: repo, LegacyReader: reader})
}

func newAvatarLocalStore(t *testing.T, key string, content []byte) *platformstorage.LocalBlobStore {
	t.Helper()
	local, err := platformstorage.NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatalf("new local store: %v", err)
	}
	if _, err := local.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), ""); err != nil {
		t.Fatalf("put local legacy avatar: %v", err)
	}
	return local
}

func assertAvatarContent(t *testing.T, opened platformstorage.OpenedObject, err error, want []byte) {
	t.Helper()
	if err != nil {
		t.Fatalf("open avatar: %v", err)
	}
	got, readErr := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(got, want) {
		t.Fatalf("avatar bytes=%q readErr=%v closeErr=%v", got, readErr, closeErr)
	}
}
