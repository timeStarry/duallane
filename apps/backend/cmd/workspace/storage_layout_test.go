package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestWorkspaceFactorySharesNodeObjectRoot(t *testing.T) {
	dataDir := t.TempDir()
	configuration := config.WorkspaceConfig{StorageDriver: "local", DataDir: dataDir}
	store, err := newBlobStore(context.Background(), configuration)
	if err != nil {
		t.Fatal(err)
	}
	content := "node-compatible-canonical"
	hash := sha256.Sum256([]byte(content))
	digest := hex.EncodeToString(hash[:])
	key, err := storage.CanonicalObjectKey(digest)
	if err != nil {
		t.Fatal(err)
	}
	object, err := store.Put(context.Background(), key, strings.NewReader(content), int64(len(content)), digest)
	if err != nil {
		t.Fatal(err)
	}
	physical, err := os.ReadFile(filepath.Join(dataDir, "workspace-files", filepath.FromSlash(key)))
	if err != nil || string(physical) != content {
		t.Fatalf("Node-layout bytes=%q err=%v", physical, err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "workspace")); !os.IsNotExist(err) {
		t.Fatalf("incorrect sibling object root exists: %v", err)
	}
	configuration.CandidateHealthOnly = true
	passive, err := newBlobStore(context.Background(), configuration)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := passive.Open(context.Background(), object.Object, int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Body.Close()
	read, err := io.ReadAll(opened.Body)
	if err != nil || string(read) != content {
		t.Fatalf("passive read=%q err=%v", read, err)
	}
}

func TestWorkspaceFactoryReadsActualNodeLegacyFixture(t *testing.T) {
	dataDir := os.Getenv("DUALLANE_NODE_FILES_LEGACY_FIXTURE")
	if dataDir == "" {
		t.Skip("DUALLANE_NODE_FILES_LEGACY_FIXTURE is not set")
	}
	if !filepath.IsAbs(dataDir) || !strings.HasPrefix(filepath.Base(dataDir), "duallane-files-legacy-contract-") {
		t.Fatal("expected an absolute synthetic fixture directory")
	}
	manifestFile, err := os.Open(filepath.Join(dataDir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer manifestFile.Close()
	var manifest struct {
		Source        string `json:"source"`
		ContentSHA256 string `json:"contentSha256"`
		Attachment    struct {
			Key      string `json:"legacyStorageKey"`
			ByteSize int64  `json:"byteSize"`
		} `json:"attachment"`
	}
	if err := json.NewDecoder(io.LimitReader(manifestFile, 64*1024)).Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Source != "node.workspace.files.legacy-read" || manifest.Attachment.ByteSize < 1 || manifest.Attachment.ByteSize > 64*1024 {
		t.Fatal("invalid synthetic fixture manifest")
	}
	store, err := newBlobStore(context.Background(), config.WorkspaceConfig{StorageDriver: "local", DataDir: dataDir, CandidateHealthOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	reader, ok := store.(storage.LegacyReader)
	if !ok {
		t.Fatal("factory lost legacy reader")
	}
	opened, err := reader.OpenLegacy(context.Background(), manifest.Attachment.Key, manifest.Attachment.ByteSize)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Body.Close()
	content, err := io.ReadAll(opened.Body)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	if int64(len(content)) != manifest.Attachment.ByteSize || hex.EncodeToString(digest[:]) != manifest.ContentSHA256 {
		t.Fatal("actual Node fixture bytes mismatch")
	}
}
