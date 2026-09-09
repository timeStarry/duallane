package migrations

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsCanonicalName(t *testing.T) {
	t.Parallel()
	tests := map[string]bool{
		"001_initial.sql":              true,
		"029_workspace_agent_bots.sql": true,
		"999_future_2.sql":             true,
		"001Initial.sql":               false,
		"01_initial.sql":               false,
		"001-initial.sql":              false,
		"001_Initial.sql":              false,
		"001_.sql":                     false,
		"001_initial.sql.bak":          false,
		"migration.sql":                false,
		"001_initial.txt":              false,
	}
	for name, expected := range tests {
		if got := IsCanonicalName(name); got != expected {
			t.Errorf("IsCanonicalName(%q) = %v, want %v", name, got, expected)
		}
	}
}

func TestDiscoverSortsCanonicalFilesAndIgnoresOtherFiles(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	for _, name := range []string{"002_second.sql", "001_first.sql", "notes.sql", "001_bad.sql.bak"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("SELECT 1"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	files, err := Discover(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("Discovered %d files, want 2", len(files))
	}
	if files[0].Name != "001_first.sql" || files[1].Name != "002_second.sql" {
		t.Fatalf("unexpected order: %#v", files)
	}
	if files[0].Number != 1 || files[1].Number != 2 {
		t.Fatalf("unexpected numbers: %#v", files)
	}
}

func TestDiscoverRejectsDuplicateNumbers(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	for _, name := range []string{"001_first.sql", "001_renamed.sql"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("SELECT 1"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := Discover(directory); err == nil {
		t.Fatal("Discover succeeded with duplicate migration numbers")
	}
}

func TestDiscoverRejectsCanonicalDirectory(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "001_directory.sql"), 0o700); err != nil {
		t.Fatal(err)
	}

	if _, err := Discover(directory); err == nil {
		t.Fatal("Discover succeeded with a canonical directory")
	}
}
