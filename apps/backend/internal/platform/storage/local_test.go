package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalBlobStoreStagesAtomicallyAndContainsPaths(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalBlobStore(root)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	content := []byte("workspace bytes")
	staged, err := store.Put(context.Background(), "workspace/uploads/upload-1/content", strings.NewReader(string(content)), int64(len(content)), "")
	if err != nil {
		t.Fatalf("put staging object: %v", err)
	}
	if staged.Reused || staged.ByteSize != int64(len(content)) {
		t.Fatalf("unexpected staged object: %#v", staged)
	}
	opened, err := store.Open(context.Background(), staged.Object, int64(len(content)))
	if err != nil {
		t.Fatalf("open staging object: %v", err)
	}
	got, readErr := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(got) != string(content) {
		t.Fatalf("read staging object = %q, err = %v", got, readErr)
	}

	digestBytes := sha256.Sum256(content)
	digest := hex.EncodeToString(digestBytes[:])
	key, err := CanonicalObjectKey(digest)
	if err != nil {
		t.Fatalf("canonical key: %v", err)
	}
	canonical, err := store.Put(context.Background(), key, strings.NewReader(string(content)), int64(len(content)), digest)
	if err != nil {
		t.Fatalf("put canonical object: %v", err)
	}
	reused, err := store.Put(context.Background(), key, strings.NewReader(string(content)), int64(len(content)), digest)
	if err != nil {
		t.Fatalf("reuse canonical object: %v", err)
	}
	if canonical.Reused || !reused.Reused || reused.SHA256 != digest {
		t.Fatalf("canonical reuse state = %#v / %#v", canonical, reused)
	}

	for _, key := range []string{"../outside", `..\outside`, "/absolute", "workspace/../../outside"} {
		if _, err := store.Put(context.Background(), key, strings.NewReader("x"), 1, ""); err == nil {
			t.Errorf("put %q unexpectedly succeeded", key)
		}
	}
	for _, key := range []string{`C:\outside`, `C:/outside`} {
		if _, err := store.Put(context.Background(), key, strings.NewReader("x"), 1, ""); err == nil {
			t.Errorf("put %q unexpectedly succeeded", key)
		}
	}
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(root, "link")); err == nil {
		defer os.Remove(filepath.Join(root, "link"))
		if _, err := store.Put(context.Background(), "link/file", strings.NewReader("x"), 1, ""); err == nil {
			t.Error("put through symlink unexpectedly succeeded")
		}
		if _, err := store.Open(context.Background(), Object{Key: "link/file", ByteSize: 1}, 1); err == nil {
			t.Error("open through symlink unexpectedly succeeded")
		}
		if err := store.Delete(context.Background(), Object{Key: "link/file"}); err == nil {
			t.Error("delete through symlink unexpectedly succeeded")
		}
	}
}

func TestLocalBlobStoreRejectsCanonicalMetadataAndBoundsReads(t *testing.T) {
	store, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	content := []byte("bounded")
	digestBytes := sha256.Sum256(content)
	digest := hex.EncodeToString(digestBytes[:])
	key, _ := CanonicalObjectKey(digest)
	if _, err := store.Put(context.Background(), key, strings.NewReader(string(content)), int64(len(content)), ""); err == nil {
		t.Fatal("canonical put without digest unexpectedly succeeded")
	}
	if _, err := store.Put(context.Background(), key, strings.NewReader("wrong"), int64(len(content)), digest); err == nil {
		t.Fatal("digest mismatch unexpectedly succeeded")
	}
	stored, err := store.Put(context.Background(), key, strings.NewReader(string(content)), int64(len(content)), digest)
	if err != nil {
		t.Fatalf("put valid object: %v", err)
	}
	if _, err := store.Open(context.Background(), stored.Object, int64(len(content)-1)); err == nil {
		t.Fatal("open over max bytes unexpectedly succeeded")
	}
	opened, err := store.Open(context.Background(), stored.Object, int64(len(content)))
	if err != nil {
		t.Fatalf("open valid object: %v", err)
	}
	limited, readErr := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(limited) != string(content) {
		t.Fatalf("bounded read = %q, err = %v", limited, readErr)
	}

	var storageErr *Error
	if _, err := store.Open(context.Background(), Object{Key: key, SHA256: strings.Repeat("0", 64), ByteSize: int64(len(content))}, int64(len(content))); err == nil || !errors.As(err, &storageErr) {
		t.Fatalf("invalid digest open error = %v", err)
	}
}

func TestLocalBlobStoreReplacesMutableStagingContent(t *testing.T) {
	store, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	key := "workspace/uploads/upload-1/content"
	if _, err := store.Put(context.Background(), key, strings.NewReader("first"), 5, ""); err != nil {
		t.Fatalf("put first staging object: %v", err)
	}
	stored, err := store.Put(context.Background(), key, strings.NewReader("second"), 6, "")
	if err != nil {
		t.Fatalf("replace staging object: %v", err)
	}
	if stored.Reused || stored.ByteSize != 6 {
		t.Fatalf("replacement result = %#v", stored)
	}
	opened, err := store.Open(context.Background(), stored.Object, 6)
	if err != nil {
		t.Fatalf("open replacement: %v", err)
	}
	content, readErr := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(content) != "second" {
		t.Fatalf("replacement content = %q, err = %v", content, readErr)
	}
}
