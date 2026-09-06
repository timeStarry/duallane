package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestLocalUploadAttemptCursorCoversUnsortedDirectory(t *testing.T) {
	store, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cutoff := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	prefix := "workspace/uploads/unsorted/attempts/"
	want := []string{prefix + "z", prefix + "a", prefix + "m", prefix + "b", prefix + "q"}
	for _, key := range want {
		if _, err := store.Put(context.Background(), key, strings.NewReader("x"), 1, ""); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(filepath.Join(store.root, filepath.FromSlash(key)), cutoff, cutoff); err != nil {
			t.Fatal(err)
		}
	}
	sort.Strings(want)
	var got []string
	cursor := ""
	for pageIndex := 0; pageIndex <= len(want); pageIndex++ {
		page, err := store.ListUploadAttemptObjects(context.Background(), "unsorted", cutoff, cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Objects) > 1 {
			t.Fatal("page exceeded batch bound")
		}
		for _, object := range page.Objects {
			got = append(got, object.Key)
		}
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor <= cursor {
			t.Fatal("cursor did not advance")
		}
		cursor = page.NextCursor
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cursor skipped directory entries: got %v want %v", got, want)
	}
}

func TestLocalUploadAttemptMaintenanceIsBoundedAndAgeAware(t *testing.T) {
	store, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	oldKey := "workspace/uploads/upload-maint/attempts/00000000-0000-0000-0000-000000000001"
	freshKey := "workspace/uploads/upload-maint/attempts/00000000-0000-0000-0000-000000000002"
	otherKey := "workspace/uploads/other/attempts/00000000-0000-0000-0000-000000000003"
	for _, key := range []string{oldKey, freshKey, otherKey} {
		if _, err := store.Put(context.Background(), key, strings.NewReader("attempt"), int64(len("attempt")), ""); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}
	cutoff := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	oldTime := cutoff.Add(-time.Hour)
	freshTime := cutoff.Add(time.Minute)
	if err := os.Chtimes(filepath.Join(store.root, filepath.FromSlash(oldKey)), oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(store.root, filepath.FromSlash(freshKey)), freshTime, freshTime); err != nil {
		t.Fatal(err)
	}

	page, err := store.ListUploadAttemptObjects(context.Background(), "upload-maint", cutoff, "", 1)
	if err != nil {
		t.Fatalf("list old attempt: %v", err)
	}
	if len(page.Objects) != 1 || page.Objects[0].Key != oldKey || page.NextCursor == "" {
		t.Fatalf("unexpected bounded page: %#v", page)
	}
	page, err = store.ListUploadAttemptObjects(context.Background(), "upload-maint", cutoff, page.NextCursor, 1)
	if err != nil {
		t.Fatalf("list after cursor: %v", err)
	}
	if len(page.Objects) != 0 || page.NextCursor != "" {
		t.Fatalf("fresh object crossed age gate: %#v", page)
	}
	if _, err := os.Stat(filepath.Join(store.root, filepath.FromSlash(otherKey))); err != nil {
		t.Fatalf("other upload object missing: %v", err)
	}

	if err := store.DeleteUploadAttemptObject(context.Background(), "upload-maint", oldKey); err != nil {
		t.Fatalf("delete old attempt: %v", err)
	}
	if err := store.DeleteUploadAttemptObject(context.Background(), "upload-maint", oldKey); err != nil {
		t.Fatalf("idempotent delete old attempt: %v", err)
	}
	if _, err := os.Stat(filepath.Join(store.root, filepath.FromSlash(oldKey))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old attempt still exists, err=%v", err)
	}
	if err := store.DeleteUploadAttemptObject(context.Background(), "upload-maint", "workspace/uploads/other/attempts/escape"); errorCode(t, err) != "storage.invalid_key" {
		t.Fatalf("cross-upload delete code=%q", errorCode(t, err))
	}
}

func TestLocalUploadAttemptMaintenanceRejectsSymlink(t *testing.T) {
	store, err := NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(store.root, "workspace", "uploads", "upload-symlink", "attempts")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(target, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(directory, "escape")
	if err := os.Symlink(target, symlink); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if _, err := store.ListUploadAttemptObjects(context.Background(), "upload-symlink", time.Now().UTC(), "", 10); errorCode(t, err) != "storage.invalid_key" {
		t.Fatalf("symlink list code=%q", errorCode(t, err))
	}
	if err := store.DeleteUploadAttemptObject(context.Background(), "upload-symlink", "workspace/uploads/upload-symlink/attempts/escape"); errorCode(t, err) != "storage.invalid_key" {
		t.Fatalf("symlink delete code=%q", errorCode(t, err))
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("outside target was changed: %v", err)
	}
}
