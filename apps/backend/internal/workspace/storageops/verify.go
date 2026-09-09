package storageops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

// VerifyOptions supplies the already-constructed read-only object store. The
// caller owns its lifecycle; this package never constructs a provider client.
type VerifyOptions struct {
	Store storage.BlobStore
	Now   time.Time
}

// Verify reads each active canonical object once and proves byte size and
// SHA-256. It never calls Put, Delete, multipart, or any database operation.
func Verify(ctx context.Context, manifest Manifest, options VerifyOptions) (VerifyReport, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	now := options.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	validation := ValidateManifest(manifest, now)
	report := VerifyReport{
		Command:             "verify",
		Status:              "verified",
		ReadOnly:            true,
		Mutations:           0,
		RunID:               manifest.RunID,
		ManifestFingerprint: manifestFingerprint(manifest),
		Validation:          validation,
	}
	if err := ctx.Err(); err != nil {
		report.Status = "interrupted"
		return report, err
	}
	if !validation.ReadOnlyReady {
		report.Status = "blocked"
		return report, ErrInvalidManifest
	}
	if options.Store == nil {
		report.Status = "failed"
		report.Failures = 1
		return report, fmt.Errorf("%w: object store is required", ErrVerifyFailed)
	}

	for index, object := range sortedObjects(manifest.Objects) {
		if err := ctx.Err(); err != nil {
			report.Status = "interrupted"
			return report, err
		}
		if object.Deleted {
			report.ObjectsSkipped++
			continue
		}
		report.ObjectsScanned++
		opened, err := options.Store.Open(ctx, storage.Object{
			Key:      object.ObjectKey,
			SHA256:   object.SHA256,
			ByteSize: object.ByteSize,
		}, storage.DefaultMaxObjectBytes)
		if err != nil {
			if ctx.Err() != nil {
				report.Status = "interrupted"
				return report, ctx.Err()
			}
			report.Failures++
			report.Validation.Issues = append(report.Validation.Issues, Issue{Code: "object.read_failed", Path: "objects[" + itoa(index) + "]"})
			continue
		}
		if opened.Body == nil {
			report.Failures++
			report.Validation.Issues = append(report.Validation.Issues, Issue{Code: "object.body_missing", Path: "objects[" + itoa(index) + "]"})
			continue
		}
		if opened.Key != object.ObjectKey || opened.ByteSize != object.ByteSize || opened.SHA256 != object.SHA256 {
			_ = opened.Body.Close()
			report.Failures++
			report.Validation.Issues = append(report.Validation.Issues, Issue{Code: "object.metadata_mismatch", Path: "objects[" + itoa(index) + "]"})
			continue
		}
		count, digest, readErr := hashBounded(contextReader{ctx: ctx, reader: opened.Body}, object.ByteSize)
		closeErr := opened.Body.Close()
		if ctx.Err() != nil {
			report.Status = "interrupted"
			return report, ctx.Err()
		}
		if readErr != nil || closeErr != nil || count != object.ByteSize || digest != object.SHA256 {
			report.Failures++
			report.Validation.Issues = append(report.Validation.Issues, Issue{Code: "object.integrity_mismatch", Path: "objects[" + itoa(index) + "]"})
			continue
		}
		if report.VerifiedBytes > maxInt64-object.ByteSize {
			report.Failures++
			report.Validation.Issues = append(report.Validation.Issues, Issue{Code: "object.verified_bytes_overflow", Path: "objects[" + itoa(index) + "]"})
			continue
		}
		report.VerifiedBytes += object.ByteSize
		report.ObjectsVerified++
	}
	sortIssues(report.Validation.Issues)
	if report.Failures > 0 {
		report.Status = "failed"
		return report, ErrVerifyFailed
	}
	return report, nil
}

func hashBounded(body io.Reader, expectedSize int64) (int64, string, error) {
	if body == nil || expectedSize < 0 || expectedSize > storage.DefaultMaxObjectBytes {
		return 0, "", errors.New("invalid object stream")
	}
	hashValue := sha256.New()
	limited := io.LimitReader(body, expectedSize+1)
	count, err := io.Copy(io.MultiWriter(hashValue, io.Discard), limited)
	if err != nil {
		return count, "", err
	}
	if count != expectedSize {
		return count, "", errors.New("object size mismatch")
	}
	return count, hex.EncodeToString(hashValue.Sum(nil)), nil
}
