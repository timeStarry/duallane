//go:build postgres_integration

package files

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestPGFilesLegacyReadUsesUnboundRegistryAndPreservesErrorBoundary(t *testing.T) {
	ctx, pool, service, _ := newStorageLockFixture(t)
	content := []byte("pg-legacy")
	attachmentID := "attachment-pg-legacy"
	legacyKey := "workspace/spc_default/attachment-pg-legacy/legacy.txt"
	legacy := &fileLegacyReaderStub{responses: map[string]fileLegacyResponse{
		legacyKey: {content: content, body: true, byteSize: int64(len(content)), hasByteSize: true},
	}}
	service.legacyReader = legacy
	now := service.nowUTC()
	insertPGLegacyAttachment(t, ctx, pool, attachmentID, "usr_file_owner", "legacy.txt", legacyKey, int64(len(content)), "", now)

	var beforeAttachments int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM attachments`).Scan(&beforeAttachments); err != nil {
		t.Fatal(err)
	}
	opened, err := service.OpenAttachmentContent(ctx, OpenAttachmentInput{
		ActorID: "usr_file_owner", AttachmentID: attachmentID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("PG legacy preview: %v", err)
	}
	got, readErr := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(got) != string(content) || len(legacy.calls) != 1 {
		t.Fatalf("PG legacy preview bytes=%q err=%v calls=%v", got, readErr, legacy.calls)
	}
	if legacy.maxBytes[0] != int64(len(content)) {
		t.Fatalf("PG legacy preview max=%d", legacy.maxBytes[0])
	}

	transferID := "download-pg-legacy"
	if _, err := pool.Exec(ctx, `INSERT INTO transfer_ledger (
		id, space_id, user_id, direction, byte_size, status, attachment_id, created_at, completed_at
	) VALUES ($1, $2, $3, 'download', $4, 'completed', $5, $6, $6)`, transferID, DefaultSpaceID, "usr_file_owner", len(content), attachmentID, now); err != nil {
		t.Fatal(err)
	}
	legacy.calls = nil
	opened, err = service.OpenDownload(ctx, CompletedDownloadInput{
		ActorID: "usr_file_owner", AttachmentID: attachmentID, TransferID: transferID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("PG legacy download: %v", err)
	}
	got, readErr = io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(got) != string(content) || len(legacy.calls) != 1 {
		t.Fatalf("PG legacy download bytes=%q err=%v calls=%v", got, readErr, legacy.calls)
	}

	// A live registry reference is authoritative. A provider failure is not a
	// missing-object result and must not be masked by a readable legacy copy.
	canonicalID := "attachment-pg-provider"
	digest := strings.Repeat("d", 64)
	canonicalKey := "workspace/objects/sha256/dd/" + digest
	insertPGStorageObject(t, ctx, pool, "wso_"+digest, digest, canonicalKey, int64(len(content)), now)
	insertPGLegacyAttachment(t, ctx, pool, canonicalID, "usr_file_owner", "provider.txt", "workspace/spc_default/attachment-pg-provider/provider.txt", int64(len(content)), "wso_"+digest, now)
	legacy.responses["workspace/spc_default/attachment-pg-provider/provider.txt"] = legacyReadResponse(content)
	legacy.calls = nil
	service.blobStore = &fileReadBlobStore{openErr: errors.New("synthetic provider outage")}
	if _, err := service.OpenAttachmentContent(ctx, OpenAttachmentInput{
		ActorID: "usr_file_owner", AttachmentID: canonicalID, MaxBytes: int64(len(content)),
	}); errorCode(err) != CodeInternal {
		t.Fatalf("PG provider failure code=%q err=%v", errorCode(err), err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("PG provider failure fell back to legacy: %v", legacy.calls)
	}

	// When a canonical registry object is explicitly missing, a legacy copy is
	// usable only if the adapter reports the same content hash. Equal byte size
	// alone must not allow different physical bytes to cross this boundary.
	canonicalFallbackID := "attachment-pg-canonical-fallback"
	canonicalFallbackKey := "workspace/spc_default/attachment-pg-canonical-fallback/legacy.txt"
	canonicalFallbackDigest := testSHA256(content)
	canonicalFallbackObjectKey, keyErr := platformstorage.CanonicalObjectKey(canonicalFallbackDigest)
	if keyErr != nil {
		t.Fatal(keyErr)
	}
	insertPGStorageObject(t, ctx, pool, "wso_"+canonicalFallbackDigest, canonicalFallbackDigest, canonicalFallbackObjectKey, int64(len(content)), now)
	insertPGLegacyAttachment(t, ctx, pool, canonicalFallbackID, "usr_file_owner", "legacy.txt", canonicalFallbackKey, int64(len(content)), "wso_"+canonicalFallbackDigest, now)
	legacy.responses[canonicalFallbackKey] = legacyReadResponse([]byte("pg-wrong!"))
	legacy.calls = nil
	service.blobStore = &fileReadBlobStore{openErr: &platformstorage.Error{Code: "file.storage_missing", Message: "missing", StatusCode: 404}}
	if opened, err := service.OpenAttachmentContent(ctx, OpenAttachmentInput{
		ActorID: "usr_file_owner", AttachmentID: canonicalFallbackID, MaxBytes: int64(len(content)),
	}); errorCode(err) != CodeFileStorageMismatch || opened.Body != nil {
		t.Fatalf("PG canonical fallback hash mismatch opened=%#v code=%q err=%v", opened, errorCode(err), err)
	}
	if len(legacy.calls) != 1 {
		t.Fatalf("PG canonical fallback hash mismatch calls=%v", legacy.calls)
	}

	legacy.responses[canonicalFallbackKey] = legacyReadResponse(content)
	legacy.calls = nil
	opened, err = service.OpenAttachmentContent(ctx, OpenAttachmentInput{
		ActorID: "usr_file_owner", AttachmentID: canonicalFallbackID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("PG canonical fallback matching digest: %v", err)
	}
	got, readErr = io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(got) != string(content) || len(legacy.calls) != 1 {
		t.Fatalf("PG canonical fallback bytes=%q err=%v calls=%v", got, readErr, legacy.calls)
	}

	var afterAttachments int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM attachments`).Scan(&afterAttachments); err != nil {
		t.Fatal(err)
	}
	if beforeAttachments+2 != afterAttachments {
		t.Fatalf("read path changed attachment count: before=%d after=%d", beforeAttachments, afterAttachments)
	}

	// A repository/database error is also distinct from object-not-found. Once
	// the pool is closed, no compatibility reader may be attempted.
	pool.Close()
	legacy.calls = nil
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_file_owner", AttachmentID: attachmentID, MaxBytes: int64(len(content)),
	}); errorCode(err) != CodeInternal {
		t.Fatalf("PG repository failure code=%q err=%v", errorCode(err), err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("PG repository failure fell back to legacy: %v", legacy.calls)
	}
}

func insertPGLegacyAttachment(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, uploaderID, fileName, storageKey string, byteSize int64, storageObjectID string, now time.Time) {
	t.Helper()
	// This helper is intentionally kept to the SQL shape already used by the
	// files PG repository; it only seeds synthetic, isolated test data.
	_, err := pool.Exec(ctx, `INSERT INTO attachments (
		id, space_id, uploader_id, conversation_id, visibility, status, file_name,
		mime_type, byte_size, storage_key, upload_transfer_id, created_at, completed_at, storage_object_id
	) VALUES ($1, $2, $3, NULL, 'space', 'available', $4, 'text/plain', $5, $6, NULL, $7, $7, NULLIF($8, ''))`,
		id, DefaultSpaceID, uploaderID, fileName, byteSize, storageKey, now, storageObjectID)
	if err != nil {
		t.Fatal(err)
	}
}

func insertPGStorageObject(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, digest, objectKey string, byteSize int64, now time.Time) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO workspace_storage_objects (
		id, sha256, object_key, byte_size, content_type, created_at, verified_at
	) VALUES ($1, $2, $3, $4, 'text/plain', $5, $5)`, id, digest, objectKey, byteSize, now)
	if err != nil {
		t.Fatal(err)
	}
}
