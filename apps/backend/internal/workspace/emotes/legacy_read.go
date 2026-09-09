package emotes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"unicode/utf8"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

const (
	// The first key is the legacy local-storage key written by the original
	// Node service. The second is the deterministic non-CAS key used by its S3
	// adapter. Both are derived from the authorized emote identity; a stored
	// StorageKey is only accepted when it is exactly one of these values.
	legacyEmoteStoragePrefix          = "custom-emotes/"
	deterministicEmoteStoragePrefix   = "workspace/custom-emotes/"
	legacyEmoteStorageSegmentMaxBytes = 128
)

func (s *Service) openEmoteContent(ctx context.Context, resource *CustomEmoteRecord, maxBytes int64) (platformstorage.OpenedObject, error) {
	if s == nil {
		return platformstorage.OpenedObject{}, internalError("open workspace emote content", errors.New("emote service is required"))
	}
	if resource == nil {
		return platformstorage.OpenedObject{}, notFoundError(CodeEmoteStorageMissing, MessageEmoteStorageMissing)
	}
	maxBytes = normalizeEmoteReadLimit(maxBytes)
	expectedSize, expectedDigest, err := validateEmoteMetadata(resource, maxBytes)
	if err != nil {
		return platformstorage.OpenedObject{}, err
	}

	if resource.StorageObjectID != "" {
		return s.openBoundEmoteContent(ctx, resource, maxBytes, expectedSize, expectedDigest)
	}
	return s.openLegacyEmoteContent(ctx, resource, maxBytes, expectedSize, expectedDigest)
}

func (s *Service) openBoundEmoteContent(ctx context.Context, resource *CustomEmoteRecord, maxBytes int64, expectedSize *int64, expectedDigest string) (platformstorage.OpenedObject, error) {
	object, err := s.repo.GetStorageObject(ctx, resource.StorageObjectID, false)
	if err != nil {
		return platformstorage.OpenedObject{}, normalizeError(err)
	}
	if object == nil {
		// GetStorageObject intentionally hides tombstones by default. A second
		// lookup makes an absent live binding distinguishable from a deleted
		// canonical object. Deleted or otherwise inconsistent canonical state is
		// authoritative and must never resurrect legacy bytes.
		deleted, deletedErr := s.repo.GetStorageObject(ctx, resource.StorageObjectID, true)
		if deletedErr != nil {
			return platformstorage.OpenedObject{}, normalizeError(deletedErr)
		}
		if deleted != nil {
			return platformstorage.OpenedObject{}, emoteStorageMismatchError()
		}
		return s.openLegacyEmoteContent(ctx, resource, maxBytes, expectedSize, expectedDigest)
	}
	if err := validateCanonicalEmoteObject(*object, resource, maxBytes, expectedSize, expectedDigest); err != nil {
		return platformstorage.OpenedObject{}, err
	}
	canonicalDigest, err := platformstorage.NormalizeSHA256(object.SHA256)
	if err != nil {
		return platformstorage.OpenedObject{}, emoteStorageMismatchError()
	}
	canonicalSize := object.ByteSize
	if s.blobStore == nil {
		return platformstorage.OpenedObject{}, internalError("open workspace emote content", errors.New("blob store is required for a bound object"))
	}

	opened, openErr := s.blobStore.Open(ctx, object.BlobObject(), maxBytes)
	if openErr != nil {
		closeEmoteOpenedObject(opened)
		if !isMissingEmoteStorage(openErr) {
			return platformstorage.OpenedObject{}, normalizeEmoteReadStorageError(openErr)
		}
		return s.openLegacyEmoteContent(ctx, resource, maxBytes, &canonicalSize, canonicalDigest)
	}
	return validateOpenedEmote(ctx, opened, object.ObjectKey, object.ByteSize, canonicalDigest, nonEmpty(resource.NormalizedMIMEType, object.ContentType))
}

func (s *Service) openLegacyEmoteContent(ctx context.Context, resource *CustomEmoteRecord, maxBytes int64, expectedSize *int64, expectedDigest string) (platformstorage.OpenedObject, error) {
	keys, valid := legacyEmoteStorageKeys(resource)
	if !valid {
		return platformstorage.OpenedObject{}, invalidStorageKeyError()
	}
	if len(keys) == 0 || s.legacyReader == nil {
		return platformstorage.OpenedObject{}, notFoundError(CodeEmoteStorageMissing, MessageEmoteStorageMissing)
	}

	contentType := nonEmpty(resource.NormalizedMIMEType, "image/webp")
	for _, key := range keys {
		opened, err := s.legacyReader.OpenLegacy(ctx, key, maxBytes)
		if err != nil {
			closeEmoteOpenedObject(opened)
			if isMissingEmoteStorage(err) {
				continue
			}
			return platformstorage.OpenedObject{}, normalizeEmoteReadStorageError(err)
		}
		return validateOpenedEmote(ctx, opened, key, pointerValue(expectedSize, opened.ByteSize), expectedDigest, contentType)
	}
	return platformstorage.OpenedObject{}, notFoundError(CodeEmoteStorageMissing, MessageEmoteStorageMissing)
}

func validateEmoteMetadata(resource *CustomEmoteRecord, maxBytes int64) (*int64, string, error) {
	var expectedSize *int64
	if resource.ByteSize != nil {
		value := *resource.ByteSize
		if value <= 0 {
			return nil, "", emoteStorageMismatchError()
		}
		if value > maxBytes {
			return nil, "", emoteOutputTooLargeError()
		}
		expectedSize = &value
	}
	expectedDigest := strings.TrimSpace(resource.SHA256)
	if expectedDigest == "" {
		return expectedSize, "", nil
	}
	normalized, err := platformstorage.NormalizeSHA256(expectedDigest)
	if err != nil {
		return nil, "", emoteStorageMismatchError()
	}
	return expectedSize, normalized, nil
}

func validateCanonicalEmoteObject(object StorageObjectRecord, resource *CustomEmoteRecord, maxBytes int64, expectedSize *int64, expectedDigest string) error {
	if object.ID != resource.StorageObjectID || object.DeletedAt != nil {
		return emoteStorageMismatchError()
	}
	if object.ByteSize <= 0 {
		return emoteStorageMismatchError()
	}
	if object.ByteSize > maxBytes {
		return emoteOutputTooLargeError()
	}
	digest, err := platformstorage.NormalizeSHA256(object.SHA256)
	if err != nil || object.SHA256 != strings.TrimSpace(object.SHA256) {
		return emoteStorageMismatchError()
	}
	if object.ObjectKey != strings.TrimSpace(object.ObjectKey) || platformstorage.ValidateCanonicalKey(object.ObjectKey, digest) != nil {
		return invalidStorageKeyError()
	}
	if expectedSize != nil && object.ByteSize != *expectedSize {
		return emoteStorageMismatchError()
	}
	if expectedDigest != "" && digest != expectedDigest {
		return emoteStorageMismatchError()
	}
	return nil
}

// legacyEmoteStorageKeys returns only deterministic keys from the authorized
// source identity. The caller-provided StorageKey is an allow-list selector,
// never the path supplied to the platform reader without validation.
func legacyEmoteStorageKeys(resource *CustomEmoteRecord) ([]string, bool) {
	if resource == nil || !validLegacyEmoteSegment(resource.UserID) || !validLegacyEmoteSegment(resource.ID) {
		return nil, false
	}
	if resource.StorageKey == "" {
		return nil, true
	}
	if resource.StorageKey != strings.TrimSpace(resource.StorageKey) {
		return nil, false
	}
	legacy := legacyEmoteStoragePrefix + resource.UserID + "/" + resource.ID + "/content.webp"
	deterministic := deterministicEmoteStoragePrefix + resource.UserID + "/" + resource.ID + "/content.webp"
	switch resource.StorageKey {
	case legacy:
		return []string{legacy, deterministic}, true
	case deterministic:
		return []string{deterministic, legacy}, true
	default:
		return nil, false
	}
}

func validLegacyEmoteSegment(value string) bool {
	if value == "" || len(value) > legacyEmoteStorageSegmentMaxBytes || strings.TrimSpace(value) != value || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func validateOpenedEmote(ctx context.Context, opened platformstorage.OpenedObject, expectedKey string, expectedSize int64, expectedDigest, contentType string) (platformstorage.OpenedObject, error) {
	if opened.Body == nil || opened.Key != expectedKey || opened.ByteSize < 0 || opened.ByteSize != expectedSize {
		closeEmoteOpenedObject(opened)
		return platformstorage.OpenedObject{}, emoteStorageMismatchError()
	}
	if opened.ByteSize > MaxOutputBytes {
		closeEmoteOpenedObject(opened)
		return platformstorage.OpenedObject{}, emoteOutputTooLargeError()
	}

	actualDigest := strings.TrimSpace(opened.SHA256)
	if actualDigest != "" {
		normalized, err := platformstorage.NormalizeSHA256(actualDigest)
		if err != nil {
			closeEmoteOpenedObject(opened)
			return platformstorage.OpenedObject{}, emoteStorageMismatchError()
		}
		actualDigest = normalized
	}
	if expectedDigest != "" && actualDigest != "" && actualDigest != expectedDigest {
		closeEmoteOpenedObject(opened)
		return platformstorage.OpenedObject{}, emoteStorageMismatchError()
	}
	if expectedDigest != "" {
		actualDigest = expectedDigest
	}
	data, readErr := readEmoteContent(ctx, opened.Body, opened.ByteSize)
	if readErr != nil {
		closeEmoteOpenedObject(opened)
		return platformstorage.OpenedObject{}, readErr
	}
	if actualDigest != "" {
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != actualDigest {
			closeEmoteOpenedObject(opened)
			return platformstorage.OpenedObject{}, emoteStorageMismatchError()
		}
	}
	if closeErr := opened.Body.Close(); closeErr != nil {
		return platformstorage.OpenedObject{}, normalizeEmoteReadStorageError(closeErr)
	}
	opened.SHA256 = actualDigest
	opened.ContentType = nonEmpty(opened.ContentType, contentType)
	opened.Body = io.NopCloser(bytes.NewReader(data))
	return opened, nil
}

func readEmoteContent(ctx context.Context, body io.Reader, expectedSize int64) ([]byte, error) {
	if body == nil || expectedSize < 0 || expectedSize > MaxOutputBytes {
		return nil, emoteStorageMismatchError()
	}
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	data, err := io.ReadAll(io.LimitReader(body, expectedSize+1))
	if err != nil {
		return nil, normalizeEmoteReadStorageError(err)
	}
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	if int64(len(data)) != expectedSize {
		return nil, emoteStorageMismatchError()
	}
	return data, nil
}

func normalizeEmoteReadLimit(maxBytes int64) int64 {
	if maxBytes <= 0 || maxBytes > MaxOutputBytes {
		return MaxOutputBytes
	}
	return maxBytes
}

func isMissingEmoteStorage(err error) bool {
	var storageErr *platformstorage.Error
	return errors.As(err, &storageErr) && storageErr != nil &&
		(storageErr.Code == "file.storage_missing" || storageErr.Code == "storage.object_not_found")
}

func normalizeEmoteReadStorageError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var domainErr *Error
	if errors.As(err, &domainErr) && domainErr != nil {
		return domainErr
	}
	var storageErr *platformstorage.Error
	if !errors.As(err, &storageErr) || storageErr == nil {
		return internalError("workspace emote storage", err)
	}
	switch storageErr.Code {
	case "file.storage_missing", "storage.object_not_found":
		return notFoundError(CodeEmoteStorageMissing, MessageEmoteStorageMissing)
	case "file.storage_too_large", "storage.object_too_large":
		return emoteOutputTooLargeError()
	case "file.storage_mismatch", "storage.object_invalid_key", "storage.invalid_key", "storage.object_invalid_digest", "storage.object_invalid_size":
		return emoteStorageMismatchError()
	default:
		return internalError("workspace emote storage", storageErr)
	}
}

func emoteStorageMismatchError() *Error {
	return NewError(CodeEmoteStorageMismatch, MessageEmoteStorageMismatch, 500)
}

func invalidStorageKeyError() *Error {
	return NewError(CodeFileInvalidStorageKey, MessageFileInvalidStorageKey, 500)
}

func emoteOutputTooLargeError() *Error {
	return NewError(CodeEmoteOutputTooLarge, MessageEmoteOutputTooLarge, 413)
}

func closeEmoteOpenedObject(opened platformstorage.OpenedObject) {
	if opened.Body != nil {
		_ = opened.Body.Close()
	}
}

func pointerValue(value *int64, fallback int64) int64 {
	if value != nil {
		return *value
	}
	return fallback
}
