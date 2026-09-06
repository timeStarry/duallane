package storage

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	// DefaultUploadAttemptMaintenanceInterval is the suggested cadence for a
	// separately owned maintenance worker. Storage construction never starts
	// that worker.
	DefaultUploadAttemptMaintenanceInterval = 5 * time.Minute
	// DefaultUploadAttemptMaintenanceAge protects objects written by a slow
	// request while still bounding crash leftovers.
	DefaultUploadAttemptMaintenanceAge = 30 * time.Minute
	// DefaultMultipartMaintenanceInterval mirrors the Node S3 maintenance
	// cadence while remaining an opt-in worker concern.
	DefaultMultipartMaintenanceInterval = 6 * time.Hour
	// DefaultMultipartMaintenanceAge matches the Node S3 stale-upload policy.
	DefaultMultipartMaintenanceAge  = 7 * 24 * time.Hour
	DefaultMaintenanceBatchSize     = 100
	DefaultMaintenanceObjectTimeout = 15 * time.Second
)

// UploadAttemptObject is a metadata-only view of one request-owned staging
// object. Keys are internal and are never suitable for public responses.
type UploadAttemptObject struct {
	Key          string
	LastModified time.Time
	ByteSize     int64
}

// UploadAttemptObjectPage is one bounded page for a single upload ID. Cursor
// values are adapter-owned and must only be fed back to the same store.
type UploadAttemptObjectPage struct {
	Objects    []UploadAttemptObject
	NextCursor string
}

// UploadAttemptMaintenance is deliberately narrower than BlobStore. It can
// enumerate and remove only the request-owned attempts for one validated
// upload ID; it cannot scan a generic Workspace prefix.
type UploadAttemptMaintenance interface {
	ListUploadAttemptObjects(ctx context.Context, uploadID string, before time.Time, cursor string, limit int) (UploadAttemptObjectPage, error)
	DeleteUploadAttemptObject(ctx context.Context, uploadID, key string) error
}

// MultipartMaintenance is an explicit worker capability. Implementations
// list only the provider's in-progress Workspace multipart uploads and abort
// those at or before before. No scheduler is started by a storage adapter.
type MultipartMaintenance interface {
	AbortStaleMultipartUploads(ctx context.Context, before time.Time, cursor string, limit int) (MultipartMaintenanceResult, error)
}

// MultipartMaintenanceResult describes one bounded provider page.
type MultipartMaintenanceResult struct {
	Scanned    int
	Aborted    int
	NextCursor string
}

func normalizeMaintenanceLimit(limit int) int {
	if limit <= 0 {
		return DefaultMaintenanceBatchSize
	}
	if limit > 1000 {
		return 1000
	}
	return limit
}

func uploadAttemptPrefix(uploadID string) (string, error) {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" || len(uploadID) > 128 || strings.ContainsAny(uploadID, "/\\\x00") {
		return "", newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("upload ID is not a safe segment"))
	}
	for _, r := range uploadID {
		if !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '_' && r != '-' {
			return "", newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("upload ID is not a safe segment"))
		}
	}
	return "workspace/uploads/" + uploadID + "/attempts/", nil
}

func validateUploadAttemptObjectKey(uploadID, key string) (string, error) {
	prefix, err := uploadAttemptPrefix(uploadID)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(key) == "" || strings.ContainsRune(key, '\x00') || !strings.HasPrefix(key, prefix) {
		return "", newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("object is outside upload attempt prefix"))
	}
	name := strings.TrimPrefix(key, prefix)
	if name == "" || strings.ContainsAny(name, "/\\") || name == "." || name == ".." || len(name) > 256 {
		return "", newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("object is not one upload attempt file"))
	}
	return key, nil
}

func encodeMultipartCursor(keyMarker, uploadIDMarker string) string {
	if keyMarker == "" && uploadIDMarker == "" {
		return ""
	}
	raw := keyMarker + "\x00" + uploadIDMarker
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeMultipartCursor(cursor string) (string, string, error) {
	if cursor == "" {
		return "", "", nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", "", newError("storage.maintenance_cursor_invalid", "存储维护游标无效", 500, err)
	}
	parts := strings.SplitN(string(raw), "\x00", 2)
	if len(parts) != 2 || parts[0] == "" {
		return "", "", newError("storage.maintenance_cursor_invalid", "存储维护游标无效", 500, fmt.Errorf("multipart cursor is malformed"))
	}
	return parts[0], parts[1], nil
}
