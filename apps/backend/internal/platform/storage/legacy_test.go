package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLegacyLocalReadIsBoundedAndReadOnly(t *testing.T) {
	ctx := context.Background()
	store, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	key := "workspace/avatars/legacy.webp"
	if _, err := store.Put(ctx, key, strings.NewReader("legacy"), 6, ""); err != nil {
		t.Fatal(err)
	}
	opened, err := store.OpenLegacy(ctx, key, 6)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Body.Close()
	content, err := io.ReadAll(opened.Body)
	if err != nil || !bytes.Equal(content, []byte("legacy")) || opened.ByteSize != 6 || opened.SHA256 != digestForBytes(content) {
		t.Fatalf("legacy read size=%d err=%v", opened.ByteSize, err)
	}
	if _, err := store.OpenLegacy(ctx, key, 5); errorCode(t, err) != "file.storage_too_large" {
		t.Fatalf("overage=%v", err)
	}
	if _, err := store.OpenLegacy(ctx, "workspace/avatars/missing.webp", 6); !isStorageMissing(err) {
		t.Fatalf("missing=%v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := store.OpenLegacy(canceled, key, 6); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel=%v", err)
	}
	outside := filepath.Join(t.TempDir(), "private")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(store.root, "workspace/avatars/link.webp")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if result, err := store.OpenLegacy(ctx, "workspace/avatars/link.webp", 6); err == nil || result.Body != nil {
		t.Fatal("symlink was opened")
	}
}

func TestLegacyReadersRejectCanonicalAndUnsafeKeysBeforeProviderAccess(t *testing.T) {
	local, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	provider := newS3TestServer()
	s3Store := mustS3Store(t, provider)
	key, err := CanonicalObjectKey(strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	for _, reader := range []LegacyReader{local, s3Store} {
		for _, invalid := range []string{key, "./" + key, strings.Replace(key, "objects/", "objects/./", 1), "../private", "/private", `C:\private`, `workspace\..\private`, "nul\x00"} {
			if opened, err := reader.OpenLegacy(context.Background(), invalid, 10); err == nil || opened.Body != nil {
				t.Fatalf("accepted invalid key %q", invalid)
			}
		}
		if _, err := reader.OpenLegacy(context.Background(), "legacy", 0); err == nil {
			t.Fatal("accepted unbounded legacy read")
		}
	}
	if len(provider.requests) != 0 {
		t.Fatal("invalid reads reached provider")
	}
}

func TestLegacyS3RejectsOverageBeforeGETAndFallsBackOnlyForMissing(t *testing.T) {
	ctx := context.Background()
	provider := newS3TestServer()
	key := "workspace/avatars/old.webp"
	provider.objects[key] = s3TestObject{content: []byte("legacy"), contentType: "image/webp"}
	primary := mustS3Store(t, provider)
	if _, err := primary.OpenLegacy(ctx, key, 5); errorCode(t, err) != "file.storage_too_large" {
		t.Fatalf("oversize=%v", err)
	}
	provider.mu.Lock()
	for _, request := range provider.requests {
		if request.method == http.MethodGet {
			t.Error("GET was issued before size approval")
		}
	}
	provider.mu.Unlock()
	opened, err := primary.OpenLegacy(ctx, key, 6)
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(opened.Body)
	if err := opened.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if readErr != nil || string(content) != "legacy" {
		t.Fatalf("legacy content=%q err=%v", content, readErr)
	}
	local, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := local.Put(ctx, "fallback", strings.NewReader("local"), 5, ""); err != nil {
		t.Fatal(err)
	}
	hybrid, err := NewHybridBlobStore(HybridBlobStoreOptions{Primary: primary, Local: local, LocalReadFallback: true})
	if err != nil {
		t.Fatal(err)
	}
	fallback, err := hybrid.OpenLegacy(ctx, "fallback", 5)
	if err != nil {
		t.Fatal(err)
	}
	defer fallback.Body.Close()
	content, err = io.ReadAll(fallback.Body)
	if err != nil || string(content) != "local" {
		t.Fatalf("fallback=%q err=%v", content, err)
	}
	provider.mu.Lock()
	provider.failStatus, provider.failMessage = http.StatusForbidden, "AccessDenied"
	provider.mu.Unlock()
	if result, err := hybrid.OpenLegacy(ctx, "fallback", 5); err == nil || result.Body != nil || isStorageMissing(err) {
		t.Fatalf("provider denial masked: %v", err)
	}
}
