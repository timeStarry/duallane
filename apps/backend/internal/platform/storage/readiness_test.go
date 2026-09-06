package storage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalReadinessDoesNotCreateDataAndDetectsMissingRoot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "objects")
	store, err := NewLocalBlobStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AssertReady(context.Background()); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		t.Fatalf("probe created files: count=%d err=%v", len(entries), err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := store.AssertReady(context.Background()); err == nil {
		t.Fatal("missing root was ready")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("probe recreated the root")
	}
}
