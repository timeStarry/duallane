package storageops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

type BackfillStoreAdapterOptions struct {
	Canonical       storage.BlobStore
	Legacy          storage.LegacyReader
	LegacyKeyPrefix string
	MaxLegacyBytes  int64
}

// BackfillStoreAdapter exposes canonical Put/Open and a bounded, scope-checked
// legacy reader. It deliberately has no Delete method and cannot provision,
// finalize, or scan a provider root. The platform LegacyReader performs the
// provider-specific bounded read; this adapter adds the domain item scope and
// expected metadata checks before exposing it to the backfill.
type BackfillStoreAdapter struct {
	canonical      storage.BlobStore
	legacy         storage.LegacyReader
	legacyPrefix   string
	maxLegacyBytes int64
}

var _ BackfillStore = (*BackfillStoreAdapter)(nil)

func NewBackfillStoreAdapter(options BackfillStoreAdapterOptions) (*BackfillStoreAdapter, error) {
	if options.Canonical == nil {
		return nil, backfillError("storageops.canonical_store_required", nil)
	}
	if options.Legacy == nil {
		return nil, backfillError("storageops.legacy_source_required", nil)
	}
	prefix, err := normalizeLegacyPrefix(options.LegacyKeyPrefix)
	if err != nil {
		return nil, err
	}
	maxBytes := options.MaxLegacyBytes
	if maxBytes <= 0 {
		maxBytes = storage.DefaultMaxObjectBytes
	}
	if maxBytes > storage.DefaultMaxObjectBytes {
		return nil, backfillError("storageops.legacy_limit_invalid", nil)
	}
	return &BackfillStoreAdapter{
		canonical:      options.Canonical,
		legacy:         options.Legacy,
		legacyPrefix:   prefix,
		maxLegacyBytes: maxBytes,
	}, nil
}

func (s *BackfillStoreAdapter) Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (storage.StoredObject, error) {
	if s == nil || s.canonical == nil {
		return storage.StoredObject{}, backfillError("storageops.canonical_store_required", nil)
	}
	return s.canonical.Put(ctx, key, source, expectedSize, expectedSHA256)
}

func (s *BackfillStoreAdapter) Open(ctx context.Context, object storage.Object, maxBytes int64) (storage.OpenedObject, error) {
	if s == nil || s.canonical == nil {
		return storage.OpenedObject{}, backfillError("storageops.canonical_store_required", nil)
	}
	return s.canonical.Open(ctx, object, maxBytes)
}

func (s *BackfillStoreAdapter) InspectLegacy(ctx context.Context, item BackfillItem) (LegacyInspection, error) {
	opened, err := s.openLegacy(ctx, item)
	if err != nil {
		return LegacyInspection{}, err
	}
	defer opened.Body.Close()

	hash := sha256.New()
	readLimit := s.maxLegacyBytes + 1
	read, err := io.Copy(hash, io.LimitReader(opened.Body, readLimit))
	if err != nil {
		return LegacyInspection{}, backfillError("storageops.legacy_inspect_failed", err)
	}
	if read > s.maxLegacyBytes {
		return LegacyInspection{}, backfillError("storageops.legacy_too_large", nil)
	}
	if item.ExpectedByteSize != nil && (*item.ExpectedByteSize < 0 || *item.ExpectedByteSize != read) {
		return LegacyInspection{}, backfillError("storageops.legacy_size_mismatch", nil)
	}
	return LegacyInspection{SHA256: hex.EncodeToString(hash.Sum(nil)), ByteSize: read}, nil
}

func (s *BackfillStoreAdapter) OpenLegacy(ctx context.Context, item BackfillItem) (storage.OpenedObject, error) {
	return s.openLegacy(ctx, item)
}

func (s *BackfillStoreAdapter) openLegacy(ctx context.Context, item BackfillItem) (storage.OpenedObject, error) {
	if s == nil || s.legacy == nil {
		return storage.OpenedObject{}, backfillError("storageops.legacy_source_required", nil)
	}
	key, err := s.validateLegacyItem(item)
	if err != nil {
		return storage.OpenedObject{}, err
	}
	if item.ExpectedByteSize != nil && (*item.ExpectedByteSize < 0 || *item.ExpectedByteSize > s.maxLegacyBytes) {
		return storage.OpenedObject{}, backfillError("storageops.legacy_limit_invalid", nil)
	}
	opened, err := s.legacy.OpenLegacy(ctx, key, s.maxLegacyBytes)
	if err != nil {
		return storage.OpenedObject{}, backfillError("storageops.legacy_open_failed", err)
	}
	if opened.Body == nil {
		return storage.OpenedObject{}, backfillError("storageops.legacy_body_missing", nil)
	}
	if opened.Object.Key != "" && opened.Object.Key != key {
		_ = opened.Body.Close()
		return storage.OpenedObject{}, backfillError("storageops.legacy_key_mismatch", nil)
	}
	if opened.Object.ByteSize < 0 || opened.Object.ByteSize > s.maxLegacyBytes {
		_ = opened.Body.Close()
		return storage.OpenedObject{}, backfillError("storageops.legacy_too_large", nil)
	}
	if item.ExpectedByteSize != nil && opened.Object.ByteSize != *item.ExpectedByteSize {
		_ = opened.Body.Close()
		return storage.OpenedObject{}, backfillError("storageops.legacy_size_mismatch", nil)
	}
	if expectedContentType := strings.TrimSpace(item.ContentType); expectedContentType != "" && opened.Object.ContentType != "" && !strings.EqualFold(expectedContentType, strings.TrimSpace(opened.Object.ContentType)) {
		_ = opened.Body.Close()
		return storage.OpenedObject{}, backfillError("storageops.legacy_content_type_mismatch", nil)
	}
	return storage.OpenedObject{
		Object: storage.Object{Key: key, ByteSize: opened.Object.ByteSize, ContentType: strings.TrimSpace(item.ContentType)},
		Body:   &boundedReadCloser{reader: io.LimitReader(opened.Body, s.maxLegacyBytes+1), closer: opened.Body},
	}, nil
}

func (s *BackfillStoreAdapter) validateLegacyItem(item BackfillItem) (string, error) {
	if item.Kind != "attachment" && item.Kind != "avatar" && item.Kind != "customEmote" {
		return "", backfillError("storageops.item_kind_invalid", nil)
	}
	if strings.TrimSpace(item.ResourceID) == "" {
		return "", backfillError("storageops.resource_id_required", nil)
	}
	key, err := normalizeLegacyKey(item.LegacyStorageKey)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(key, s.legacyPrefix) {
		return "", backfillError("storageops.legacy_key_out_of_scope", nil)
	}
	if strings.HasPrefix(key, storage.CanonicalObjectPrefix) {
		return "", backfillError("storageops.legacy_canonical_key_forbidden", nil)
	}
	return key, nil
}

func normalizeLegacyPrefix(value string) (string, error) {
	value = strings.TrimSuffix(strings.TrimSpace(strings.ReplaceAll(value, "\\", "/")), "/")
	prefix, err := normalizeLegacyKey(value)
	if err != nil {
		return "", backfillError("storageops.legacy_scope_invalid", err)
	}
	if strings.HasPrefix(prefix, storage.CanonicalObjectPrefix) {
		return "", backfillError("storageops.legacy_scope_invalid", nil)
	}
	return strings.TrimSuffix(prefix, "/") + "/", nil
}

func normalizeLegacyKey(value string) (string, error) {
	key := strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if key == "" || strings.ContainsRune(key, '\x00') || strings.HasPrefix(key, "/") || strings.HasPrefix(key, "//") || (len(key) > 1 && key[1] == ':') {
		return "", backfillError("storageops.legacy_key_invalid", nil)
	}
	segments := strings.Split(key, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return "", backfillError("storageops.legacy_key_invalid", nil)
		}
	}
	return strings.Join(segments, "/"), nil
}

type boundedReadCloser struct {
	reader io.Reader
	closer io.Closer
}

func (r *boundedReadCloser) Read(buffer []byte) (int, error) {
	if r == nil || r.reader == nil {
		return 0, errors.New("storageops.legacy_body_missing")
	}
	return r.reader.Read(buffer)
}

func (r *boundedReadCloser) Close() error {
	if r == nil || r.closer == nil {
		return nil
	}
	return r.closer.Close()
}
