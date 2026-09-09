//go:build postgres_integration

package emotes

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestPGLegacyEmoteReadUsesNodeNullMetadataAndExactKey(t *testing.T) {
	fixture := newPGEmoteIntegrationFixture(t)
	fixture.service.legacyReader = fixture.store
	const (
		emoteID = "emote-pg-legacy-null"
		userID  = "usr_emote_owner"
	)
	legacyKey, _ := legacyReadKeys(userID, emoteID)
	content := []byte("Node legacy emote fixture bytes")
	legacyPath := filepath.Join(fixture.root, filepath.FromSlash(legacyKey))
	if err := os.MkdirAll(filepath.Dir(legacyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO workspace_custom_emotes (
			id, user_id, source_type, label, normalized_mime_type,
			byte_size, sha256, storage_key, sort_order, created_at
		) VALUES ($1, $2, 'upload', $3, NULL, NULL, NULL, $4, 0, $5)
	`, emoteID, userID, "legacy null metadata", legacyKey, fixture.now)

	delivery, err := fixture.service.ReadContent(fixture.ctx, ReadContentInput{ActorID: userID, EmoteID: emoteID})
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(delivery.Body)
	closeErr := delivery.Body.Close()
	if readErr != nil || closeErr != nil || string(got) != string(content) {
		t.Fatalf("PG legacy content=%q readErr=%v closeErr=%v", got, readErr, closeErr)
	}
	if delivery.ByteSize != int64(len(content)) || delivery.ContentType != "image/webp" {
		t.Fatalf("PG legacy delivery=%#v", delivery)
	}
}

func TestPGLegacyEmoteReadMissingCanonicalFallsBackAndRejectsTombstones(t *testing.T) {
	fixture := newPGEmoteIntegrationFixture(t)
	fixture.service.legacyReader = fixture.store
	const userID = "usr_emote_owner"

	missingID := "emote-pg-canonical-missing"
	missingKey, _ := legacyReadKeys(userID, missingID)
	missingContent := []byte("missing canonical fallback")
	missingPath := filepath.Join(fixture.root, filepath.FromSlash(missingKey))
	if err := os.MkdirAll(filepath.Dir(missingPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(missingPath, missingContent, 0o600); err != nil {
		t.Fatal(err)
	}
	missingDigest := legacyReadDigest(missingContent)
	missingObjectKey, err := canonicalLegacyReadKey(missingDigest)
	if err != nil {
		t.Fatal(err)
	}
	missingObjectID := "wso-pg-physical-missing"
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO workspace_storage_objects (
			id, sha256, object_key, byte_size, content_type, created_at, verified_at, deleted_at
		) VALUES ($1, $2, $3, $4, 'image/webp', $5, $5, NULL)
	`, missingObjectID, missingDigest, missingObjectKey, len(missingContent), fixture.now)
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO workspace_custom_emotes (
			id, user_id, source_type, label, byte_size, sha256, storage_key, storage_object_id, sort_order, created_at
		) VALUES ($1, $2, 'upload', $3, $4, $5, $6, $7, 0, $8)
	`, missingID, userID, "missing canonical", len(missingContent), missingDigest, missingKey, missingObjectID, fixture.now)
	delivery, err := fixture.service.ReadContent(fixture.ctx, ReadContentInput{ActorID: userID, EmoteID: missingID})
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(delivery.Body)
	_ = delivery.Body.Close()
	if readErr != nil || string(got) != string(missingContent) {
		t.Fatalf("missing canonical content=%q readErr=%v", got, readErr)
	}

	tombstoneID := "emote-pg-canonical-tombstone"
	tombstoneKey, _ := legacyReadKeys(userID, tombstoneID)
	tombstoneContent := []byte("tombstone must not resurrect")
	tombstonePath := filepath.Join(fixture.root, filepath.FromSlash(tombstoneKey))
	if err := os.MkdirAll(filepath.Dir(tombstonePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tombstonePath, tombstoneContent, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := legacyReadDigest(tombstoneContent)
	objectKey, err := canonicalLegacyReadKey(digest)
	if err != nil {
		t.Fatal(err)
	}
	objectID := "wso-pg-tombstone"
	deletedAt := time.Now().UTC()
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO workspace_storage_objects (
			id, sha256, object_key, byte_size, content_type, created_at, verified_at, deleted_at
		) VALUES ($1, $2, $3, $4, 'image/webp', $5, $5, $6)
	`, objectID, digest, objectKey, len(tombstoneContent), fixture.now, deletedAt)
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO workspace_custom_emotes (
			id, user_id, source_type, label, byte_size, sha256, storage_key, storage_object_id, sort_order, created_at
		) VALUES ($1, $2, 'upload', $3, $4, $5, $6, $7, 0, $8)
	`, tombstoneID, userID, "tombstone", len(tombstoneContent), digest, tombstoneKey, objectID, fixture.now)

	if _, err := fixture.service.ReadContent(context.Background(), ReadContentInput{ActorID: userID, EmoteID: tombstoneID}); !isCode(err, CodeEmoteStorageMismatch) {
		t.Fatalf("tombstone read=%v", err)
	}

	removedID := "emote-pg-removed"
	removedKey, _ := legacyReadKeys(userID, removedID)
	removedPath := filepath.Join(fixture.root, filepath.FromSlash(removedKey))
	if err := os.MkdirAll(filepath.Dir(removedPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(removedPath, []byte("removed legacy bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	removedAt := time.Now().UTC()
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO workspace_custom_emotes (
			id, user_id, source_type, label, normalized_mime_type,
			byte_size, sha256, storage_key, storage_object_id, sort_order, created_at, removed_at
		) VALUES ($1, $2, 'upload', $3, NULL, $4, $5, NULL, NULL, 0, $6, $7)
	`, removedID, userID, "removed emote", len("removed legacy bytes"), legacyReadDigest([]byte("removed legacy bytes")), fixture.now, removedAt)

	if _, err := fixture.service.ReadContent(context.Background(), ReadContentInput{ActorID: userID, EmoteID: removedID}); !isCode(err, CodeEmoteNotFound) {
		t.Fatalf("removed emote read=%v", err)
	}
}

func canonicalLegacyReadKey(digest string) (string, error) {
	return platformstorage.CanonicalObjectKey(digest)
}
