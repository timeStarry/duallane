package storage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHybridUploadAttemptMaintenanceReconcilesPrimaryAndLocalCopies(t *testing.T) {
	primary, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	local, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewHybridBlobStore(HybridBlobStoreOptions{Primary: primary, Local: local, LocalReadFallback: true, LocalMirrorWrite: true})
	if err != nil {
		t.Fatal(err)
	}
	key := "workspace/uploads/hybrid-maint/attempts/00000000-0000-0000-0000-000000000001"
	if _, err := primary.Put(context.Background(), key, strings.NewReader("primary"), int64(len("primary")), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := local.Put(context.Background(), key, strings.NewReader("local"), int64(len("local")), ""); err != nil {
		t.Fatal(err)
	}
	cutoff := time.Now().UTC().Add(time.Minute)
	old := cutoff.Add(-time.Hour)
	for _, root := range []string{primary.root, local.root} {
		if err := os.Chtimes(filepath.Join(root, filepath.FromSlash(key)), old, old); err != nil {
			t.Fatal(err)
		}
	}
	page, err := store.ListUploadAttemptObjects(context.Background(), "hybrid-maint", cutoff, "", 10)
	if err != nil {
		t.Fatalf("list hybrid attempts: %v", err)
	}
	if len(page.Objects) != 1 || page.Objects[0].Key != key || page.NextCursor != "l|" {
		t.Fatalf("unexpected primary maintenance page: %#v", page)
	}
	page, err = store.ListUploadAttemptObjects(context.Background(), "hybrid-maint", cutoff, page.NextCursor, 10)
	if err != nil {
		t.Fatalf("list local attempts: %v", err)
	}
	if len(page.Objects) != 1 || page.Objects[0].Key != key {
		t.Fatalf("unexpected local maintenance page: %#v", page)
	}
	if err := store.DeleteUploadAttemptObject(context.Background(), "hybrid-maint", key); err != nil {
		t.Fatalf("delete hybrid attempt: %v", err)
	}
	for _, root := range []string{primary.root, local.root} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(key))); !os.IsNotExist(err) {
			t.Fatalf("hybrid copy remains at %s, err=%v", root, err)
		}
	}
}
