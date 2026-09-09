package storageops

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

const (
	DefaultWorkspaceSpaceID   = "spc_default"
	DefaultDailyQuotaBytes    = int64(2 * 1024 * 1024 * 1024)
	maxManifestReferenceCount = int64(^uint(0) >> 1)
	// Fail explicitly instead of allocating an unbounded whole-catalog snapshot.
	MaxSnapshotRows = 100000
)

var migrationFilePattern = regexp.MustCompile(`^[0-9]{3}_[a-z0-9_]+\.sql$`)

// SnapshotRequest identifies one immutable, read-only catalog view. The
// PostgreSQL adapter executes the complete snapshot in one repeatable-read
// transaction so objects and their business references cannot come from
// different database versions.
type SnapshotRequest struct {
	RunID string
	Now   time.Time
}

// SnapshotSource is the narrow source boundary used by the operator. It
// deliberately exposes no general-purpose SQL or transaction handle.
type SnapshotSource interface {
	Snapshot(context.Context, SnapshotRequest) (Manifest, error)
}

// PostgresSnapshotOptions contains only read-only catalog policy. Expected
// migration names come from the operator's checked-out migration directory;
// this adapter never reads or executes migration SQL.
type PostgresSnapshotOptions struct {
	ExpectedMigrations []string
	SpaceID            string
	DailyQuotaBytes    int64
	Owner              OwnerSnapshot
	Backup             BackupProof
}

// PostgresSnapshotSource reads the migration history, 025 canonical registry,
// business references, legacy keys, and quota evidence from PostgreSQL.
type PostgresSnapshotSource struct {
	pool               *pgxpool.Pool
	expectedMigrations []string
	spaceID            string
	dailyQuotaBytes    int64
	owner              OwnerSnapshot
	backup             BackupProof
}

var _ SnapshotSource = (*PostgresSnapshotSource)(nil)

// NewPostgresSnapshotSource creates a typed read-only snapshot adapter. It
// does not ping, migrate, lock, or otherwise change the supplied database.
func NewPostgresSnapshotSource(pool *pgxpool.Pool, options PostgresSnapshotOptions) (*PostgresSnapshotSource, error) {
	if pool == nil {
		return nil, fmt.Errorf("%w: postgres pool is required", ErrSnapshotFailed)
	}
	expected, err := normalizeExpectedMigrations(options.ExpectedMigrations)
	if err != nil {
		return nil, err
	}
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultWorkspaceSpaceID
	}
	dailyQuotaBytes := options.DailyQuotaBytes
	if dailyQuotaBytes == 0 {
		dailyQuotaBytes = DefaultDailyQuotaBytes
	}
	if dailyQuotaBytes < 1 || dailyQuotaBytes > storage.DefaultMaxObjectBytes {
		return nil, fmt.Errorf("%w: daily quota is outside the supported range", ErrSnapshotFailed)
	}
	owner := options.Owner
	if strings.TrimSpace(owner.Current) == "" {
		owner.Current = NodeOwner
	}
	return &PostgresSnapshotSource{
		pool:               pool,
		expectedMigrations: expected,
		spaceID:            spaceID,
		dailyQuotaBytes:    dailyQuotaBytes,
		owner:              owner,
		backup:             options.Backup,
	}, nil
}

// Snapshot obtains one consistent database view. It only issues SELECTs and
// rolls the read-only transaction back after the rows have been copied.
func (s *PostgresSnapshotSource) Snapshot(ctx context.Context, request SnapshotRequest) (Manifest, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s == nil || s.pool == nil {
		return Manifest{}, fmt.Errorf("%w: postgres source is unavailable", ErrSnapshotFailed)
	}
	if err := ctx.Err(); err != nil {
		return Manifest{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return Manifest{}, fmt.Errorf("%w: begin read-only snapshot", ErrSnapshotFailed)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	applied, err := readAppliedMigrations(ctx, tx)
	if err != nil {
		return Manifest{}, err
	}
	objects, objectByID, err := readCanonicalObjects(ctx, tx)
	if err != nil {
		return Manifest{}, err
	}
	resources, err := readBusinessReferences(ctx, tx, objectByID)
	if err != nil {
		return Manifest{}, err
	}
	quotas, err := readQuotaSnapshots(ctx, tx, s.spaceID, s.dailyQuotaBytes)
	if err != nil {
		return Manifest{}, err
	}
	return Manifest{
		ContractVersion: ContractVersion,
		RunID:           request.RunID,
		Schema: SchemaSnapshot{
			Expected: append([]string(nil), s.expectedMigrations...),
			Applied:  applied,
		},
		Owner:     s.owner,
		Backup:    s.backup,
		Quotas:    quotas,
		Resources: resources,
		Objects:   objects,
	}, nil
}

// ReadExpectedMigrations reads only canonical migration filenames. The SQL
// contents are intentionally never opened: the CLI uses this list to compare
// schema history, while the database remains the sole source of applied state.
func ReadExpectedMigrations(directory string) ([]string, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return nil, fmt.Errorf("%w: migrations directory is required", ErrSnapshotFailed)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("%w: migrations directory is unavailable", ErrSnapshotFailed)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !migrationFilePattern.MatchString(entry.Name()) {
			continue
		}
		names = append(names, entry.Name())
	}
	names, err = normalizeExpectedMigrations(names)
	if err != nil {
		return nil, err
	}
	return names, nil
}

func normalizeExpectedMigrations(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, fmt.Errorf("%w: expected migrations are required", ErrSnapshotFailed)
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		name := strings.TrimSpace(value)
		if !migrationFilePattern.MatchString(name) {
			return nil, fmt.Errorf("%w: migration name is invalid", ErrSnapshotFailed)
		}
		if _, exists := seen[name]; exists {
			return nil, fmt.Errorf("%w: migration name is duplicated", ErrSnapshotFailed)
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	sort.Strings(result)
	if !contains(result, CanonicalStorageMigration) {
		return nil, fmt.Errorf("%w: canonical storage migration is absent", ErrSnapshotFailed)
	}
	return result, nil
}

func readAppliedMigrations(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT name FROM schema_migrations ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("%w: read migration history", ErrSnapshotFailed)
	}
	defer rows.Close()
	names := make([]string, 0)
	seen := make(map[string]struct{})
	for rows.Next() {
		if len(names) >= 1000 {
			return nil, fmt.Errorf("%w: migration snapshot exceeds limit", ErrSnapshotFailed)
		}
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("%w: scan migration history", ErrSnapshotFailed)
		}
		name = strings.TrimSpace(name)
		if !migrationFilePattern.MatchString(name) {
			return nil, fmt.Errorf("%w: applied migration name is invalid", ErrSnapshotFailed)
		}
		if _, exists := seen[name]; exists {
			return nil, fmt.Errorf("%w: applied migration is duplicated", ErrSnapshotFailed)
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: read migration history", ErrSnapshotFailed)
	}
	sort.Strings(names)
	return names, nil
}

func readCanonicalObjects(ctx context.Context, tx pgx.Tx) ([]CanonicalObject, map[string]CanonicalObject, error) {
	rows, err := tx.Query(ctx, `SELECT so.id, so.sha256, so.object_key, so.byte_size,
  so.deleted_at,
  (SELECT COUNT(*) FROM attachments a WHERE a.storage_object_id = so.id) +
  (SELECT COUNT(*) FROM users u WHERE u.avatar_storage_object_id = so.id) +
  (SELECT COUNT(*) FROM workspace_custom_emotes e WHERE e.storage_object_id = so.id)
FROM workspace_storage_objects so
ORDER BY so.id`)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: read canonical objects", ErrSnapshotFailed)
	}
	defer rows.Close()
	objects := make([]CanonicalObject, 0)
	byID := make(map[string]CanonicalObject)
	for rows.Next() {
		if len(objects) >= MaxSnapshotRows {
			return nil, nil, fmt.Errorf("%w: object snapshot exceeds limit", ErrSnapshotFailed)
		}
		var object CanonicalObject
		var deletedAt *time.Time
		var referenceCount int64
		if err := rows.Scan(&object.ID, &object.SHA256, &object.ObjectKey, &object.ByteSize, &deletedAt, &referenceCount); err != nil {
			return nil, nil, fmt.Errorf("%w: scan canonical object", ErrSnapshotFailed)
		}
		if referenceCount < 0 || referenceCount > maxManifestReferenceCount {
			return nil, nil, fmt.Errorf("%w: canonical reference count is out of range", ErrSnapshotFailed)
		}
		object.ReferenceCount = int(referenceCount)
		object.Deleted = deletedAt != nil
		objects = append(objects, object)
		byID[object.ID] = object
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("%w: read canonical objects", ErrSnapshotFailed)
	}
	return objects, byID, nil
}

func readBusinessReferences(ctx context.Context, tx pgx.Tx, objects map[string]CanonicalObject) ([]ResourceRef, error) {
	resources := make([]ResourceRef, 0)

	attachmentRows, err := tx.Query(ctx, `SELECT id, space_id, uploader_id, storage_object_id,
  byte_size, COALESCE(storage_key, '')
FROM attachments
WHERE storage_object_id IS NOT NULL
   OR (status = 'available' AND storage_key IS NOT NULL)
ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("%w: read attachment storage references", ErrSnapshotFailed)
	}
	for attachmentRows.Next() {
		if len(resources) >= MaxSnapshotRows {
			attachmentRows.Close()
			return nil, fmt.Errorf("%w: reference snapshot exceeds limit", ErrSnapshotFailed)
		}
		var id, spaceID, ownerID, legacyKey string
		var objectID *string
		var byteSize int64
		if err := attachmentRows.Scan(&id, &spaceID, &ownerID, &objectID, &byteSize, &legacyKey); err != nil {
			attachmentRows.Close()
			return nil, fmt.Errorf("%w: scan attachment storage reference", ErrSnapshotFailed)
		}
		resources = append(resources, makeResourceRef("attachment", id, spaceID, ownerID, objectID, &byteSize, legacyKey, objects))
	}
	if err := attachmentRows.Err(); err != nil {
		attachmentRows.Close()
		return nil, fmt.Errorf("%w: read attachment storage references", ErrSnapshotFailed)
	}
	attachmentRows.Close()

	avatarRows, err := tx.Query(ctx, `SELECT id, avatar_storage_object_id,
  COALESCE(avatar_storage_key, '')
FROM users
WHERE avatar_storage_object_id IS NOT NULL
   OR (avatar_storage_key IS NOT NULL AND avatar_version IS NOT NULL)
ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("%w: read avatar storage references", ErrSnapshotFailed)
	}
	for avatarRows.Next() {
		if len(resources) >= MaxSnapshotRows {
			avatarRows.Close()
			return nil, fmt.Errorf("%w: reference snapshot exceeds limit", ErrSnapshotFailed)
		}
		var id, legacyKey string
		var objectID *string
		if err := avatarRows.Scan(&id, &objectID, &legacyKey); err != nil {
			avatarRows.Close()
			return nil, fmt.Errorf("%w: scan avatar storage reference", ErrSnapshotFailed)
		}
		resources = append(resources, makeResourceRef("avatar", id, "", id, objectID, nil, legacyKey, objects))
	}
	if err := avatarRows.Err(); err != nil {
		avatarRows.Close()
		return nil, fmt.Errorf("%w: read avatar storage references", ErrSnapshotFailed)
	}
	avatarRows.Close()

	emoteRows, err := tx.Query(ctx, `SELECT id, user_id, storage_object_id,
  byte_size, COALESCE(storage_key, '')
FROM workspace_custom_emotes
WHERE storage_object_id IS NOT NULL OR storage_key IS NOT NULL
ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("%w: read custom emote storage references", ErrSnapshotFailed)
	}
	for emoteRows.Next() {
		if len(resources) >= MaxSnapshotRows {
			emoteRows.Close()
			return nil, fmt.Errorf("%w: reference snapshot exceeds limit", ErrSnapshotFailed)
		}
		var id, ownerID, legacyKey string
		var objectID *string
		var byteSize *int64
		if err := emoteRows.Scan(&id, &ownerID, &objectID, &byteSize, &legacyKey); err != nil {
			emoteRows.Close()
			return nil, fmt.Errorf("%w: scan custom emote storage reference", ErrSnapshotFailed)
		}
		resources = append(resources, makeResourceRef("customEmote", id, "", ownerID, objectID, byteSize, legacyKey, objects))
	}
	if err := emoteRows.Err(); err != nil {
		emoteRows.Close()
		return nil, fmt.Errorf("%w: read custom emote storage references", ErrSnapshotFailed)
	}
	emoteRows.Close()

	sort.Slice(resources, func(i, j int) bool {
		left := resources[i].Kind + "\x00" + resources[i].ID
		right := resources[j].Kind + "\x00" + resources[j].ID
		return left < right
	})
	return resources, nil
}

func makeResourceRef(kind, id, spaceID, ownerID string, objectID *string, databaseByteSize *int64, legacyKey string, objects map[string]CanonicalObject) ResourceRef {
	resource := ResourceRef{
		Kind:             kind,
		ID:               id,
		SpaceID:          spaceID,
		OwnerID:          ownerID,
		LegacyStorageKey: legacyKey,
	}
	if databaseByteSize != nil {
		resource.ByteSize = *databaseByteSize
	}
	if objectID != nil {
		resource.StorageObjectID = *objectID
		if object, ok := objects[*objectID]; ok {
			if databaseByteSize == nil {
				resource.ByteSize = object.ByteSize
			}
		}
	}
	return resource
}

func readQuotaSnapshots(ctx context.Context, tx pgx.Tx, spaceID string, limit int64) ([]QuotaSnapshot, error) {
	rows, err := tx.Query(ctx, `SELECT user_id,
  TO_CHAR((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD'),
  COALESCE(SUM(byte_size) FILTER (WHERE status = 'completed'), 0)::bigint,
  COALESCE(SUM(byte_size) FILTER (WHERE status = 'reserved'), 0)::bigint
FROM transfer_ledger
WHERE space_id = $1 AND direction = 'upload'
  AND status IN ('reserved', 'completed')
GROUP BY user_id, (created_at AT TIME ZONE 'UTC')::date
ORDER BY user_id, (created_at AT TIME ZONE 'UTC')::date`, spaceID)
	if err != nil {
		return nil, fmt.Errorf("%w: read quota snapshots", ErrSnapshotFailed)
	}
	defer rows.Close()
	quotas := make([]QuotaSnapshot, 0)
	for rows.Next() {
		if len(quotas) >= MaxSnapshotRows {
			return nil, fmt.Errorf("%w: quota snapshot exceeds limit", ErrSnapshotFailed)
		}
		var quota QuotaSnapshot
		if err := rows.Scan(&quota.SubjectID, &quota.Day, &quota.UsedBytes, &quota.ReservedBytes); err != nil {
			return nil, fmt.Errorf("%w: scan quota snapshot", ErrSnapshotFailed)
		}
		quota.LimitBytes = limit
		quotas = append(quotas, quota)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: read quota snapshots", ErrSnapshotFailed)
	}
	return quotas, nil
}
