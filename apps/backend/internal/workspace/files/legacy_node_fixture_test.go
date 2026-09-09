package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	nodeFilesLegacyFixtureEnv    = "DUALLANE_NODE_FILES_LEGACY_FIXTURE"
	nodeFilesLegacyFixturePrefix = "duallane-files-legacy-contract-"
	nodeFilesLegacyManifestLimit = 100 * 1024
)

type nodeFilesLegacyFixtureManifest struct {
	ContractVersion    int                              `json:"contractVersion"`
	Source             string                           `json:"source"`
	Owner              string                           `json:"owner"`
	Attachment         nodeFilesLegacyFixtureAttachment `json:"attachment"`
	DownloadTransferID string                           `json:"downloadTransferId"`
	ContentSHA256      string                           `json:"contentSha256"`
}

type nodeFilesLegacyFixtureAttachment struct {
	ID               string  `json:"id"`
	SpaceID          string  `json:"spaceId"`
	UploaderID       string  `json:"uploaderId"`
	FileName         string  `json:"fileName"`
	MIMEType         string  `json:"mimeType"`
	ByteSize         int64   `json:"byteSize"`
	Status           string  `json:"status"`
	StorageObjectID  *string `json:"storageObjectId"`
	LegacyStorageKey string  `json:"legacyStorageKey"`
	DeterministicKey string  `json:"deterministicStorageKey"`
}

// TestNodeLegacyFixtureRoundTrip exercises bytes produced by the Node
// workspace-files legacy contract through the Go authorization and physical
// read paths. The fixture is deliberately opt-in: normal Go test runs must
// not depend on a Node process, a production database, or a shared filesystem.
func TestNodeLegacyFixtureRoundTrip(t *testing.T) {
	fixtureDir := strings.TrimSpace(os.Getenv(nodeFilesLegacyFixtureEnv))
	if fixtureDir == "" {
		t.Skipf("%s is not set; run scripts/backend/workspace-files-legacy-contract.mjs --check first", nodeFilesLegacyFixtureEnv)
	}

	fixtureDir, manifest, err := loadNodeFilesLegacyFixture(fixtureDir)
	if err != nil {
		t.Fatalf("load Node legacy fixture: %v", err)
	}
	if err := validateNodeFilesLegacyFixture(manifest); err != nil {
		t.Fatalf("validate Node legacy fixture: %v", err)
	}

	ctx := context.Background()
	// Node's workspace storage helper places physical objects below the
	// data-dir's workspace-files child. The manifest remains at the synthetic
	// fixture root, while the Go local store must use that exact nested root.
	storageRoot := filepath.Join(fixtureDir, "workspace-files")
	store, err := platformstorage.OpenExistingLocalBlobStore(ctx, storageRoot)
	if err != nil {
		t.Fatalf("open existing fixture storage root %q: %v", storageRoot, err)
	}

	repo := newFakeFileRepo()
	fixtureNow := time.Unix(1700000000, 0).UTC()
	repo.state.actors[manifest.Attachment.UploaderID] = &auth.Actor{
		ID:          manifest.Attachment.UploaderID,
		GitHubLogin: "node-fixture-owner",
		DisplayName: "Node fixture owner",
		Kind:        "human",
		Role:        "owner",
	}
	completedAt := fixtureNow
	repo.state.attachments[manifest.Attachment.ID] = &AttachmentRecord{
		ID:          manifest.Attachment.ID,
		SpaceID:     manifest.Attachment.SpaceID,
		UploaderID:  manifest.Attachment.UploaderID,
		Visibility:  string(VisibilitySpace),
		Status:      manifest.Attachment.Status,
		FileName:    manifest.Attachment.FileName,
		MIMEType:    manifest.Attachment.MIMEType,
		ByteSize:    manifest.Attachment.ByteSize,
		StorageKey:  manifest.Attachment.LegacyStorageKey,
		CreatedAt:   fixtureNow,
		CompletedAt: &completedAt,
	}
	attachmentID := manifest.Attachment.ID
	repo.state.transfers[manifest.DownloadTransferID] = &TransferRecord{
		ID:           manifest.DownloadTransferID,
		SpaceID:      manifest.Attachment.SpaceID,
		UserID:       manifest.Attachment.UploaderID,
		Direction:    string(TransferDownload),
		ByteSize:     manifest.Attachment.ByteSize,
		Status:       string(TransferCompleted),
		AttachmentID: &attachmentID,
		CreatedAt:    fixtureNow,
		CompletedAt:  &completedAt,
	}

	service := NewService(ServiceOptions{
		Repository:   repo,
		BlobStore:    store,
		LegacyReader: store,
		SpaceID:      manifest.Attachment.SpaceID,
		Now:          func() time.Time { return fixtureNow },
	})

	preview, err := service.OpenAttachmentContent(ctx, OpenAttachmentInput{
		ActorID: manifest.Attachment.UploaderID, AttachmentID: manifest.Attachment.ID,
		MaxBytes: manifest.Attachment.ByteSize,
	})
	if err != nil {
		t.Fatalf("Go authorized preview of Node legacy fixture: %v", err)
	}
	assertNodeFilesLegacyOpened(t, preview, manifest.Attachment.LegacyStorageKey, manifest.Attachment.ByteSize, manifest.Attachment.MIMEType, manifest.ContentSHA256)

	download, err := service.OpenDownload(ctx, CompletedDownloadInput{
		ActorID: manifest.Attachment.UploaderID, AttachmentID: manifest.Attachment.ID,
		TransferID: manifest.DownloadTransferID, MaxBytes: manifest.Attachment.ByteSize,
	})
	if err != nil {
		t.Fatalf("Go authorized download of Node legacy fixture: %v", err)
	}
	assertNodeFilesLegacyOpened(t, download, manifest.Attachment.LegacyStorageKey, manifest.Attachment.ByteSize, manifest.Attachment.MIMEType, manifest.ContentSHA256)
}

func loadNodeFilesLegacyFixture(requestedDirectory string) (string, nodeFilesLegacyFixtureManifest, error) {
	fixtureDir, err := filepath.Abs(filepath.Clean(requestedDirectory))
	if err != nil {
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("resolve fixture directory: %w", err)
	}
	rootInfo, err := os.Lstat(fixtureDir)
	if err != nil {
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("stat fixture directory: %w", err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return "", nodeFilesLegacyFixtureManifest{}, errors.New("fixture path must be a real directory")
	}
	if !strings.HasPrefix(filepath.Base(fixtureDir), nodeFilesLegacyFixturePrefix) {
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("fixture directory must use synthetic prefix %q", nodeFilesLegacyFixturePrefix)
	}

	manifestPath := filepath.Join(fixtureDir, "manifest.json")
	manifestInfo, err := os.Lstat(manifestPath)
	if err != nil {
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("stat manifest: %w", err)
	}
	if manifestInfo.Mode()&os.ModeSymlink != 0 || !manifestInfo.Mode().IsRegular() {
		return "", nodeFilesLegacyFixtureManifest{}, errors.New("fixture manifest must be a regular file")
	}
	manifestFile, err := os.Open(manifestPath)
	if err != nil {
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("open manifest: %w", err)
	}
	manifestBytes, readErr := io.ReadAll(io.LimitReader(manifestFile, nodeFilesLegacyManifestLimit+1))
	closeErr := manifestFile.Close()
	if readErr != nil {
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("read manifest: %w", readErr)
	}
	if closeErr != nil {
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("close manifest: %w", closeErr)
	}
	if len(manifestBytes) > nodeFilesLegacyManifestLimit {
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("manifest exceeds %d bytes", nodeFilesLegacyManifestLimit)
	}

	decoder := json.NewDecoder(bytes.NewReader(manifestBytes))
	decoder.DisallowUnknownFields()
	var manifest nodeFilesLegacyFixtureManifest
	if err := decoder.Decode(&manifest); err != nil {
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("decode manifest: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return "", nodeFilesLegacyFixtureManifest{}, errors.New("manifest contains trailing JSON")
		}
		return "", nodeFilesLegacyFixtureManifest{}, fmt.Errorf("read manifest trailer: %w", err)
	}
	return fixtureDir, manifest, nil
}

func validateNodeFilesLegacyFixture(manifest nodeFilesLegacyFixtureManifest) error {
	if manifest.ContractVersion != 1 || manifest.Source != "node.workspace.files.legacy-read" || manifest.Owner != "node" {
		return errors.New("manifest is not the Node workspace-files legacy contract")
	}
	attachment := manifest.Attachment
	if attachment.ID == "" || attachment.SpaceID == "" || attachment.UploaderID == "" || attachment.FileName == "" || attachment.MIMEType == "" {
		return errors.New("manifest attachment identity is incomplete")
	}
	if !validLegacySegment(attachment.SpaceID) || !validLegacySegment(attachment.ID) {
		return errors.New("manifest attachment identity is not a safe legacy segment")
	}
	if attachment.Status != string(AttachmentAvailable) || attachment.StorageObjectID != nil {
		return errors.New("manifest must describe an available unbound legacy attachment")
	}
	if attachment.ByteSize < 1 || attachment.ByteSize > nodeFilesLegacyManifestLimit {
		return fmt.Errorf("manifest attachment byte size must be between 1 and %d", nodeFilesLegacyManifestLimit)
	}
	if manifest.DownloadTransferID == "" {
		return errors.New("manifest download transfer id is required")
	}
	if len(manifest.ContentSHA256) != sha256.Size*2 {
		return errors.New("manifest content digest has invalid length")
	}
	digest, err := hex.DecodeString(manifest.ContentSHA256)
	if err != nil || len(digest) != sha256.Size || strings.ToLower(manifest.ContentSHA256) != manifest.ContentSHA256 {
		return errors.New("manifest content digest must be lowercase hexadecimal")
	}

	expectedLegacyKey := fmt.Sprintf("workspace/%s/%s/%s", attachment.SpaceID, attachment.ID, nodeSafeStorageName(attachment.FileName))
	if attachment.LegacyStorageKey != expectedLegacyKey {
		return fmt.Errorf("manifest legacy storage key %q does not match Node-derived key %q", attachment.LegacyStorageKey, expectedLegacyKey)
	}
	expectedDeterministicKey := fmt.Sprintf("workspace/attachments/%s/%s/content", attachment.SpaceID, attachment.ID)
	if attachment.DeterministicKey != expectedDeterministicKey {
		return fmt.Errorf("manifest deterministic storage key %q does not match expected key %q", attachment.DeterministicKey, expectedDeterministicKey)
	}
	return nil
}

func assertNodeFilesLegacyOpened(t *testing.T, opened platformstorage.OpenedObject, expectedKey string, expectedSize int64, expectedContentType, expectedSHA256 string) {
	t.Helper()
	if opened.Body == nil {
		t.Fatal("opened Node legacy object has no body")
	}
	content, readErr := io.ReadAll(io.LimitReader(opened.Body, nodeFilesLegacyManifestLimit+1))
	closeErr := opened.Body.Close()
	if readErr != nil || closeErr != nil {
		t.Fatalf("read Node legacy object: read=%v close=%v", readErr, closeErr)
	}
	if opened.Key != expectedKey || opened.ByteSize != expectedSize || opened.ContentType != expectedContentType {
		t.Fatalf("opened Node legacy metadata key=%q size=%d contentType=%q", opened.Key, opened.ByteSize, opened.ContentType)
	}
	if int64(len(content)) != expectedSize {
		t.Fatalf("opened Node legacy bytes=%d, want %d", len(content), expectedSize)
	}
	digest := sha256.Sum256(content)
	actualSHA256 := hex.EncodeToString(digest[:])
	if actualSHA256 != expectedSHA256 || opened.SHA256 != expectedSHA256 {
		t.Fatalf("opened Node legacy digest actual=%q opened=%q expected=%q", actualSHA256, opened.SHA256, expectedSHA256)
	}
}
