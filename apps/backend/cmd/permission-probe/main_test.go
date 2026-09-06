package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestValidateManifestRequiresCanonicalIdentityAndBoundedObjects(t *testing.T) {
	canonicalContent := []byte("canonical permission fixture")
	canonicalDigest := digestForTest(canonicalContent)
	canonicalKey, err := storage.CanonicalObjectKey(canonicalDigest)
	if err != nil {
		t.Fatal(err)
	}
	valid := fixtureManifest{
		Version:   probeVersion,
		Canonical: objectSpec{Key: canonicalKey, SHA256: canonicalDigest, ByteSize: int64(len(canonicalContent))},
		Legacy:    objectSpec{Key: "workspace/avatars/permission.bin", SHA256: canonicalDigest, ByteSize: int64(len(canonicalContent))},
		Secret:    &secretSpec{Path: "/run/secrets/workspace-s3", SHA256: canonicalDigest, ByteSize: int64(len(canonicalContent))},
	}
	if err := validateManifest(valid); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}

	checks := []fixtureManifest{
		valid,
		valid,
		valid,
		valid,
	}
	for index := range checks {
		secret := *valid.Secret
		checks[index].Secret = &secret
	}
	checks[0].Canonical.SHA256 = strings.ToUpper(canonicalDigest)
	checks[1].Legacy.Key = canonicalKey
	checks[2].Canonical.ByteSize = probeMaxBytes + 2
	checks[3].Secret.Path = "/run/secrets/../private"
	for index, candidate := range checks {
		if err := validateManifest(candidate); err == nil {
			t.Errorf("manifest %d unexpectedly accepted", index)
		}
	}
}

func TestLoadManifestRejectsTrailingDocumentsAndGarbage(t *testing.T) {
	canonicalContent := []byte("canonical permission fixture")
	canonicalDigest := digestForTest(canonicalContent)
	canonicalKey, err := storage.CanonicalObjectKey(canonicalDigest)
	if err != nil {
		t.Fatal(err)
	}
	manifest := fixtureManifest{
		Version:   probeVersion,
		Canonical: objectSpec{Key: canonicalKey, SHA256: canonicalDigest, ByteSize: int64(len(canonicalContent))},
		Legacy:    objectSpec{Key: "workspace/avatars/permission.bin", SHA256: canonicalDigest, ByteSize: int64(len(canonicalContent))},
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, trailing := range []string{"\n{}\n", "\ntrailing-garbage\n"} {
		t.Run(strings.TrimSpace(trailing), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "manifest.json")
			if err := os.WriteFile(path, append(encoded, []byte(trailing)...), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadManifest(path); safeErrorCode(err) != "probe.manifest_invalid" {
				t.Fatalf("trailing manifest accepted: %v", err)
			}
		})
	}
}

func TestProbeUsesActualLocalCanonicalAndLegacyReaders(t *testing.T) {
	root := t.TempDir()
	store, err := storage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	canonicalContent := []byte("canonical bytes")
	canonicalDigest := digestForTest(canonicalContent)
	canonicalKey, err := storage.CanonicalObjectKey(canonicalDigest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(context.Background(), canonicalKey, bytes.NewReader(canonicalContent), int64(len(canonicalContent)), canonicalDigest); err != nil {
		t.Fatal(err)
	}
	legacyContent := []byte("legacy bytes")
	legacyDigest := digestForTest(legacyContent)
	legacyKey := "workspace/avatars/legacy.bin"
	if _, err := store.Put(context.Background(), legacyKey, bytes.NewReader(legacyContent), int64(len(legacyContent)), ""); err != nil {
		t.Fatal(err)
	}

	report := probeManifest(fixtureManifest{
		Version:   probeVersion,
		Canonical: objectSpec{Key: canonicalKey, SHA256: canonicalDigest, ByteSize: int64(len(canonicalContent))},
		Legacy:    objectSpec{Key: legacyKey, SHA256: legacyDigest, ByteSize: int64(len(legacyContent))},
	}, root, t.TempDir())
	if report.Status != "passed" || report.Root.Status != "passed" || report.Canonical.Status != "passed" || report.Legacy.Status != "passed" {
		t.Fatalf("local probe report = %#v", report)
	}
}

func TestProbeRejectsBoundaryOverflowAndSymlinks(t *testing.T) {
	root := t.TempDir()
	over := bytes.Repeat([]byte{'x'}, int(probeMaxBytes)+1)
	digest := digestForTest(over)
	canonicalKey, _ := storage.CanonicalObjectKey(digest)
	canonicalPath := filepath.Join(root, filepath.FromSlash(canonicalKey))
	if err := os.MkdirAll(filepath.Dir(canonicalPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(canonicalPath, over, 0o600); err != nil {
		t.Fatal(err)
	}
	legacyKey := "workspace/avatars/overflow.bin"
	legacyPath := filepath.Join(root, filepath.FromSlash(legacyKey))
	if err := os.MkdirAll(filepath.Dir(legacyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPath, over, 0o600); err != nil {
		t.Fatal(err)
	}
	overReport := probeManifest(fixtureManifest{
		Version:   probeVersion,
		Canonical: objectSpec{Key: canonicalKey, SHA256: digest, ByteSize: int64(len(over))},
		Legacy:    objectSpec{Key: legacyKey, SHA256: digest, ByteSize: int64(len(over))},
	}, root, t.TempDir())
	if overReport.Root.Status != "passed" || overReport.Canonical.ErrorCode != "file.storage_too_large" || overReport.Legacy.ErrorCode != "file.storage_too_large" {
		t.Fatalf("overflow report = %#v", overReport)
	}

	content := []byte("symlink target")
	symlinkDigest := digestForTest(content)
	symlinkKey, _ := storage.CanonicalObjectKey(symlinkDigest)
	symlinkPath := filepath.Join(root, filepath.FromSlash(symlinkKey))
	if err := os.MkdirAll(filepath.Dir(symlinkPath), 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "outside")
	if err := os.WriteFile(target, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, symlinkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	symlinkLegacyKey := "workspace/avatars/link.bin"
	symlinkLegacyPath := filepath.Join(root, filepath.FromSlash(symlinkLegacyKey))
	if err := os.MkdirAll(filepath.Dir(symlinkLegacyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, symlinkLegacyPath); err != nil {
		t.Fatal(err)
	}
	symlinkReport := probeManifest(fixtureManifest{
		Version:   probeVersion,
		Canonical: objectSpec{Key: symlinkKey, SHA256: symlinkDigest, ByteSize: int64(len(content))},
		Legacy:    objectSpec{Key: symlinkLegacyKey, SHA256: symlinkDigest, ByteSize: int64(len(content))},
	}, root, t.TempDir())
	if symlinkReport.Canonical.ErrorCode != "storage.invalid_key" || symlinkReport.Legacy.ErrorCode != "storage.invalid_key" {
		t.Fatalf("symlink report = %#v", symlinkReport)
	}
}

func TestProbeSecretPermissionAndCancellationAreBounded(t *testing.T) {
	root := t.TempDir()
	secretContent := []byte("synthetic secret fixture")
	secretPath := filepath.Join(root, "workspace-s3")
	if err := os.WriteFile(secretPath, secretContent, 0o600); err != nil {
		t.Fatal(err)
	}
	spec := secretSpec{Path: "/run/secrets/workspace-s3", SHA256: digestForTest(secretContent), ByteSize: int64(len(secretContent))}
	result := probeSecret(root, "workspace-s3", spec)
	if result.Status != "passed" {
		t.Fatalf("secret probe = %#v", result)
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	err := readAndVerifyBody(canceled, bytes.NewReader(secretContent), int64(len(secretContent)), spec.SHA256)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled read = %v", err)
	}

	tooLarge := readAndVerifyBody(context.Background(), strings.NewReader("too large"), probeMaxBytes+1, spec.SHA256)
	if safeErrorCode(tooLarge) != "file.storage_too_large" {
		t.Fatalf("unbounded read result = %v", tooLarge)
	}
}

func TestRunEmitsSafeFailureWithoutManifestDetails(t *testing.T) {
	var output, diagnostic bytes.Buffer
	code := run([]string{"--manifest", filepath.Join(t.TempDir(), "missing-manifest")}, &output, &diagnostic)
	if code != 2 {
		t.Fatalf("exit code = %d", code)
	}
	if strings.Contains(output.String()+diagnostic.String(), "missing-manifest") {
		t.Fatal("manifest path leaked")
	}
	if !strings.Contains(output.String(), `"errorCode":"probe.manifest_unreadable"`) {
		t.Fatalf("failure report = %s", output.String())
	}
}

func TestProbeUsesWorkspaceFilesAsContainerBlobRoot(t *testing.T) {
	if probeDataRoot != "/app/data/workspace-files" {
		t.Fatalf("probe data root = %q, want /app/data/workspace-files", probeDataRoot)
	}
}

func digestForTest(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

var _ io.ReadCloser = (*os.File)(nil)
