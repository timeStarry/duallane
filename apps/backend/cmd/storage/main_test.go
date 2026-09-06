package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/storageops"
)

func TestPlanAndVerifyCommandsAreSyntheticReadOnly(t *testing.T) {
	root := t.TempDir()
	store, err := storage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	manifest := commandManifest()
	object := manifest.Objects[0]
	if _, err := store.Put(context.Background(), object.ObjectKey, strings.NewReader("command bytes"), object.ByteSize, object.SHA256); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(t.TempDir(), "manifest.json")
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	var planOutput bytes.Buffer
	if err := run([]string{"plan", "--manifest", manifestPath, "--now", "2026-09-06T12:00:00Z"}, &planOutput, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(planOutput.String(), `"status": "ready"`) || !strings.Contains(planOutput.String(), `"readOnly": true`) {
		t.Fatalf("plan output = %s", planOutput.String())
	}

	var verifyOutput bytes.Buffer
	if err := run([]string{"verify", "--manifest", manifestPath, "--object-root", root, "--now", "2026-09-06T12:00:00Z"}, &verifyOutput, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(verifyOutput.String(), `"status": "verified"`) || !strings.Contains(verifyOutput.String(), `"mutations": 0`) {
		t.Fatalf("verify output = %s", verifyOutput.String())
	}
}

func TestCommandsRejectApplyAndRealTargets(t *testing.T) {
	manifestPath := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestPath, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(run([]string{"plan", "--manifest", manifestPath, "--apply"}, &bytes.Buffer{}, &bytes.Buffer{}), storageops.ErrReadOnlyTarget) {
		t.Fatal("plan accepted --apply")
	}
	if !errors.Is(run([]string{"verify", "--manifest", manifestPath, "--target", "production"}, &bytes.Buffer{}, &bytes.Buffer{}), storageops.ErrReadOnlyTarget) {
		t.Fatal("verify accepted production target")
	}
}

func TestVerifyTimeoutIsBounded(t *testing.T) {
	if err := run([]string{"verify", "--manifest", "manifest.json", "--object-root", ".", "--timeout", "6m"}, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
		t.Fatal("verify accepted excessive timeout")
	}
}

func TestFlagErrorsNeverEchoCredentials(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://user:environment-secret@localhost/db")
	for _, args := range [][]string{
		{"plan", "--help"},
		{"verify", "--pool-max", "argument-secret"},
		{"plan", "--argument-secret"},
		{"verify", "unexpected-positional"},
	} {
		var output, diagnostic bytes.Buffer
		err := run(args, &output, &diagnostic)
		if err == nil {
			t.Fatal("invalid flags accepted")
		}
		if strings.Contains(output.String()+diagnostic.String()+err.Error(), "secret") {
			t.Fatal("flag error echoed private environment or argument")
		}
	}
}

func commandManifest() storageops.Manifest {
	content := []byte("command bytes")
	digest := sha256Hex(content)
	key, _ := storage.CanonicalObjectKey(digest)
	return storageops.Manifest{
		ContractVersion: storageops.ContractVersion,
		RunID:           "storage-cli-2026",
		Schema: storageops.SchemaSnapshot{
			Expected: []string{"001_initial.sql", storageops.CanonicalStorageMigration},
			Applied:  []string{"001_initial.sql", storageops.CanonicalStorageMigration},
		},
		Owner:     storageops.OwnerSnapshot{Current: storageops.NodeOwner},
		Backup:    storageops.BackupProof{ID: "backup-cli", SHA256: strings.Repeat("c", 64), Verified: true, RetainUntil: "2099-01-01T00:00:00Z"},
		Quotas:    []storageops.QuotaSnapshot{{SubjectID: "usr_cli", Day: "2026-09-06", LimitBytes: storage.DefaultMaxObjectBytes}},
		Resources: []storageops.ResourceRef{{Kind: "attachment", ID: "att_cli", SpaceID: "spc_cli", OwnerID: "usr_cli", StorageObjectID: "wso_" + digest, ByteSize: int64(len(content))}},
		Objects:   []storageops.CanonicalObject{{ID: "wso_" + digest, SHA256: digest, ObjectKey: key, ByteSize: int64(len(content)), ReferenceCount: 1}},
	}
}

func sha256Hex(content []byte) string {
	return fmt.Sprintf("%x", sha256.Sum256(content))
}
