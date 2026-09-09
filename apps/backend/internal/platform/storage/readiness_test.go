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

func TestExistingLocalStoreDoesNotProvisionOrChangePermissions(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o750); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenExistingLocalBlobStore(context.Background(), root); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(root)
	if err != nil || before.Mode() != after.Mode() {
		t.Fatalf("passive construction changed mode: %v", err)
	}
	missing := filepath.Join(root, "missing")
	if _, err := OpenExistingLocalBlobStore(context.Background(), missing); err == nil {
		t.Fatal("missing root accepted")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("missing root was provisioned")
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("passive construction wrote data")
	}
}
