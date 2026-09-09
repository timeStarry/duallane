package storageops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestOpenReadOnlyStoreLocalDoesNotCreateOrMutate(t *testing.T) {
	root := t.TempDir()
	content := []byte("read-only local operator bytes")
	object := testReadOnlyObject(content)
	target := filepath.Join(root, filepath.FromSlash(object.Key))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, content, 0o600); err != nil {
		t.Fatal(err)
	}
	rootInfoBefore, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	store, err := OpenReadOnlyStore(context.Background(), ReadOnlyStoreOptions{
		Kind: ReadOnlyLocalStore, ObjectRoot: root,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	opened, err := store.Open(context.Background(), object, storage.DefaultMaxObjectBytes)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if err != nil || closeErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("opened local object = %q, read error = %v, close error = %v", got, err, closeErr)
	}
	if _, err := store.Put(context.Background(), object.Key, bytes.NewReader(content), object.ByteSize, object.SHA256); err != ErrReadOnlyTarget {
		t.Fatalf("read-only Put error = %v", err)
	}
	if err := store.Delete(context.Background(), object); err != ErrReadOnlyTarget {
		t.Fatalf("read-only Delete error = %v", err)
	}
	rootInfoAfter, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(rootInfoBefore, rootInfoAfter) {
		t.Fatal("read-only store replaced local root")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("read-only store changed object: %v", err)
	}

	missingRoot := filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := OpenReadOnlyStore(context.Background(), ReadOnlyStoreOptions{
		Kind: ReadOnlyLocalStore, ObjectRoot: missingRoot,
	}); err == nil {
		t.Fatal("read-only store created or accepted a missing root")
	}
	if _, err := os.Stat(missingRoot); !os.IsNotExist(err) {
		t.Fatalf("missing root was created, stat error = %v", err)
	}
}

func TestOpenReadOnlyStoreS3UsesOnlyReadRequests(t *testing.T) {
	content := []byte("read-only S3 operator bytes")
	object := testReadOnlyObject(content)
	var writes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPut || request.Method == http.MethodDelete || request.Method == http.MethodPost {
			writes.Add(1)
			response.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		path := strings.TrimPrefix(request.URL.Path, "/")
		if path == "operator-bucket" && request.Method == http.MethodHead {
			response.WriteHeader(http.StatusOK)
			return
		}
		if path != "operator-bucket/"+object.Key {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		response.Header().Set("Content-Length", ""+itoaForTest(len(content)))
		response.Header().Set("Content-Type", "application/octet-stream")
		response.Header().Set("X-Amz-Meta-Duallane-Sha256", object.SHA256)
		response.Header().Set("X-Amz-Meta-Duallane-Size", itoaForTest(len(content)))
		if request.Method == http.MethodHead {
			response.WriteHeader(http.StatusOK)
			return
		}
		_, _ = response.Write(content)
	}))
	defer server.Close()

	store, err := OpenReadOnlyStore(context.Background(), ReadOnlyStoreOptions{
		Kind: ReadOnlyS3Store,
		S3:   storage.S3Config{Endpoint: server.URL, Region: "us-east-1", Bucket: "operator-bucket", AccessKey: "access", SecretKey: "secret"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	opened, err := store.Open(context.Background(), object, storage.DefaultMaxObjectBytes)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if err != nil || closeErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("opened S3 object = %q, read error = %v, close error = %v", got, err, closeErr)
	}
	if _, err := store.Put(context.Background(), object.Key, bytes.NewReader(content), object.ByteSize, object.SHA256); err != ErrReadOnlyTarget {
		t.Fatalf("read-only S3 Put error = %v", err)
	}
	if err := store.Delete(context.Background(), object); err != ErrReadOnlyTarget {
		t.Fatalf("read-only S3 Delete error = %v", err)
	}
	if writes.Load() != 0 {
		t.Fatalf("read-only S3 store issued %d mutating requests", writes.Load())
	}
}

func testReadOnlyObject(content []byte) storage.Object {
	digest := sha256.Sum256(content)
	hexDigest := hex.EncodeToString(digest[:])
	key, _ := storage.CanonicalObjectKey(hexDigest)
	return storage.Object{Key: key, SHA256: hexDigest, ByteSize: int64(len(content))}
}

func itoaForTest(value int) string {
	return strconv.Itoa(value)
}
