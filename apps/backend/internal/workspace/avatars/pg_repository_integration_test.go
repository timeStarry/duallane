//go:build postgres_integration

package avatars

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type pgAvatarIntegrationFixture struct {
	ctx     context.Context
	conn    *pgx.Conn
	pool    *pgxpool.Pool
	repo    *PGRepository
	service *Service
	store   *platformstorage.LocalBlobStore
	root    string
	now     time.Time
	media   *avatarFakeProcessor
}

func newPGAvatarIntegrationFixture(t *testing.T) *pgAvatarIntegrationFixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_avatars_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE")
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (platformmigrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 6, 12, 34, 56, 789654321, time.UTC)
	seedPGAvatarIntegrationData(t, ctx, conn, now)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	root := t.TempDir()
	store, err := platformstorage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	var sequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("avatar-integration-%03d", sequence.Add(1)), nil
	}
	media := &avatarFakeProcessor{content: []byte("normalized-avatar")}
	repo := NewPGRepository(pool)
	return &pgAvatarIntegrationFixture{
		ctx: ctx, conn: conn, pool: pool, repo: repo, store: store, root: root, now: now, media: media,
		service: NewService(ServiceOptions{
			Repository: repo,
			BlobStore:  store,
			Processor:  media,
			SpaceID:    DefaultSpaceID,
			Now:        func() time.Time { return now },
			IDFactory:  idFactory,
		}),
	}
}

func seedPGAvatarIntegrationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct {
		id, login, name, role string
	}{
		{"usr_avatar_owner", "avatar-owner", "Avatar Owner", "owner"},
		{"usr_avatar_member", "avatar-member", "Avatar Member", "member"},
		{"usr_avatar_viewer", "avatar-viewer", "Avatar Viewer", "member"},
	} {
		mustExecPGAvatar(t, ctx, conn, `
			INSERT INTO users (id, github_login, display_name, kind, created_at, avatar_url, github_avatar_url)
			VALUES ($1, $2, $3, 'human', $4, $5, $5)
		`, user.id, user.login, user.name, now, "https://github.example/"+user.id)
	}
	mustExecPGAvatar(t, ctx, conn, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ($1, 'Avatar Integration', 'avatar-integration', $2, $3)
	`, DefaultSpaceID, "usr_avatar_owner", now)
	for _, user := range []struct {
		id, role string
	}{
		{"usr_avatar_owner", "owner"},
		{"usr_avatar_member", "member"},
		{"usr_avatar_viewer", "member"},
	} {
		mustExecPGAvatar(t, ctx, conn, `
			INSERT INTO space_members (space_id, user_id, role, joined_at)
			VALUES ($1, $2, $3, $4)
		`, DefaultSpaceID, user.id, user.role, now)
	}
}

func mustExecPGAvatar(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func pgAvatarCount(t *testing.T, fixture *pgAvatarIntegrationFixture, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := fixture.pool.QueryRow(fixture.ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func pgAvatarDigest(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

// avatarBarrierBlobStore pauses after the inner store has performed the
// physical operation. The PG tests use it to hold Put/Delete at the exact
// point where an unlocked cleanup implementation would expose a CAS race.
type avatarBarrierBlobStore struct {
	inner         platformstorage.BlobStore
	targetKey     string
	putStarted    chan struct{}
	putRelease    <-chan struct{}
	deleteStarted chan struct{}
	deleteRelease <-chan struct{}
	putOnce       sync.Once
	deleteOnce    sync.Once
}

func (s *avatarBarrierBlobStore) Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (platformstorage.StoredObject, error) {
	stored, err := s.inner.Put(ctx, key, source, expectedSize, expectedSHA256)
	if err != nil {
		return platformstorage.StoredObject{}, err
	}
	if key == s.targetKey && s.putStarted != nil {
		s.putOnce.Do(func() { close(s.putStarted) })
		if s.putRelease != nil {
			select {
			case <-s.putRelease:
			case <-ctx.Done():
				return platformstorage.StoredObject{}, ctx.Err()
			}
		}
	}
	return stored, nil
}

func (s *avatarBarrierBlobStore) Open(ctx context.Context, object platformstorage.Object, maxBytes int64) (platformstorage.OpenedObject, error) {
	return s.inner.Open(ctx, object, maxBytes)
}

func (s *avatarBarrierBlobStore) Delete(ctx context.Context, object platformstorage.Object) error {
	if object.Key == s.targetKey && s.deleteStarted != nil {
		s.deleteOnce.Do(func() { close(s.deleteStarted) })
		if s.deleteRelease != nil {
			select {
			case <-s.deleteRelease:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return s.inner.Delete(ctx, object)
}

func TestPGAvatarSetAndCleanupShareTheObjectLock(t *testing.T) {
	fixture := newPGAvatarIntegrationFixture(t)
	member := "usr_avatar_member"
	owner := "usr_avatar_owner"
	if _, err := fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{
		ActorID: member, MIMEType: "image/png", Content: []byte("initial-source"),
		Meta: auth.RequestMeta{RequestID: "avatar-race-initial"},
	}); err != nil {
		t.Fatalf("initial avatar: %v", err)
	}
	memberRecord, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, member)
	if err != nil || memberRecord == nil || memberRecord.StorageObject == nil {
		t.Fatalf("initial member record = %#v, err=%v", memberRecord, err)
	}
	objectKey := memberRecord.StorageObject.ObjectKey
	putStarted := make(chan struct{})
	putRelease := make(chan struct{})
	deleteStarted := make(chan struct{})
	barrier := &avatarBarrierBlobStore{
		inner: fixture.store, targetKey: objectKey,
		putStarted: putStarted, putRelease: putRelease,
		deleteStarted: deleteStarted,
	}
	fixture.service.blobStore = barrier
	var releaseOnce sync.Once
	releasePut := func() { releaseOnce.Do(func() { close(putRelease) }) }
	defer releasePut()

	setDone := make(chan error, 1)
	go func() {
		_, setErr := fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{
			ActorID: owner, MIMEType: "image/png", Content: []byte("replacement-source"),
			Meta: auth.RequestMeta{RequestID: "avatar-race-set"},
		})
		setDone <- setErr
	}()
	select {
	case <-putStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("set did not reach the controlled Put barrier")
	}

	removeDone := make(chan error, 1)
	go func() {
		_, removeErr := fixture.service.RemoveOwnAvatar(fixture.ctx, RemoveOwnAvatarInput{
			ActorID: member, Meta: auth.RequestMeta{RequestID: "avatar-race-remove"},
		})
		removeDone <- removeErr
	}()
	deleteObserved := false
	select {
	case <-deleteStarted:
		deleteObserved = true
	case <-time.After(750 * time.Millisecond):
	}
	releasePut()
	setErr := <-setDone
	removeErr := <-removeDone
	if setErr != nil {
		t.Errorf("set during cleanup race: %v", setErr)
	}
	if removeErr != nil {
		t.Errorf("remove during set race: %v", removeErr)
	}
	if deleteObserved {
		t.Errorf("cleanup physically deleted the object while SetOwnAvatar held its object lock")
	}
	ownerRecord, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, owner)
	if err != nil || ownerRecord == nil || ownerRecord.StorageObjectID != memberRecord.StorageObjectID {
		t.Fatalf("owner reference after race = %#v, err=%v", ownerRecord, err)
	}
	if _, err := os.Stat(filepath.Join(fixture.root, filepath.FromSlash(objectKey))); err != nil {
		t.Fatalf("bound object bytes disappeared after locked set: %v", err)
	}
}

func TestPGAvatarCleanupHoldsObjectLockThroughPhysicalDelete(t *testing.T) {
	fixture := newPGAvatarIntegrationFixture(t)
	member := "usr_avatar_member"
	owner := "usr_avatar_owner"
	if _, err := fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{
		ActorID: member, MIMEType: "image/png", Content: []byte("initial-source"),
		Meta: auth.RequestMeta{RequestID: "avatar-delete-race-initial"},
	}); err != nil {
		t.Fatalf("initial avatar: %v", err)
	}
	memberRecord, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, member)
	if err != nil || memberRecord == nil || memberRecord.StorageObject == nil {
		t.Fatalf("initial member record = %#v, err=%v", memberRecord, err)
	}
	objectKey := memberRecord.StorageObject.ObjectKey
	deleteStarted := make(chan struct{})
	deleteRelease := make(chan struct{})
	barrier := &avatarBarrierBlobStore{
		inner: fixture.store, targetKey: objectKey,
		deleteStarted: deleteStarted, deleteRelease: deleteRelease,
	}
	fixture.service.blobStore = barrier
	var releaseOnce sync.Once
	releaseDelete := func() { releaseOnce.Do(func() { close(deleteRelease) }) }
	defer releaseDelete()

	removeDone := make(chan error, 1)
	go func() {
		_, removeErr := fixture.service.RemoveOwnAvatar(fixture.ctx, RemoveOwnAvatarInput{
			ActorID: member, Meta: auth.RequestMeta{RequestID: "avatar-delete-race-remove"},
		})
		removeDone <- removeErr
	}()
	select {
	case <-deleteStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup did not reach the controlled Delete barrier")
	}

	setDone := make(chan error, 1)
	go func() {
		_, setErr := fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{
			ActorID: owner, MIMEType: "image/png", Content: []byte("replacement-source"),
			Meta: auth.RequestMeta{RequestID: "avatar-delete-race-set"},
		})
		setDone <- setErr
	}()
	ownerFinishedBeforeDelete := false
	var setErr error
	select {
	case setErr = <-setDone:
		ownerFinishedBeforeDelete = true
	case <-time.After(750 * time.Millisecond):
	}
	releaseDelete()
	removeErr := <-removeDone
	if !ownerFinishedBeforeDelete {
		setErr = <-setDone
	}
	if removeErr != nil {
		t.Errorf("remove while physical delete was paused: %v", removeErr)
	}
	if ownerFinishedBeforeDelete {
		t.Errorf("SetOwnAvatar completed before cleanup released physical Delete: %v", setErr)
	}
	if setErr != nil {
		t.Errorf("set after cleanup delete: %v", setErr)
	}
	ownerRecord, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, owner)
	if err != nil || ownerRecord == nil || ownerRecord.StorageObjectID != memberRecord.StorageObjectID {
		t.Fatalf("owner reference after delete race = %#v, err=%v", ownerRecord, err)
	}
	if _, err := os.Stat(filepath.Join(fixture.root, filepath.FromSlash(objectKey))); err != nil {
		t.Fatalf("reacquired object bytes were deleted after cleanup: %v", err)
	}
	var deletedAt *time.Time
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT deleted_at FROM workspace_storage_objects WHERE id = $1`, memberRecord.StorageObjectID).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	if deletedAt != nil {
		t.Fatalf("reacquired object remained tombstoned at %s", deletedAt.UTC())
	}
}

func TestPGAvatarLifecycleUsesIsolatedSchemaAndAtomicStorageCleanup(t *testing.T) {
	fixture := newPGAvatarIntegrationFixture(t)
	owner := "usr_avatar_owner"
	member := "usr_avatar_member"
	viewer := "usr_avatar_viewer"

	first, err := fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{
		ActorID: owner, MIMEType: "image/png", Content: []byte("source-owner"),
		Meta: auth.RequestMeta{RequestID: "avatar-set-owner"},
	})
	if err != nil {
		t.Fatalf("set owner avatar: %v", err)
	}
	if first.User == nil || first.User.AvatarURL == "" {
		t.Fatalf("owner set result = %#v", first)
	}

	second, err := fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{
		ActorID: member, MIMEType: "image/png", Content: []byte("source-member"),
		Meta: auth.RequestMeta{RequestID: "avatar-set-member"},
	})
	if err != nil {
		t.Fatalf("set member avatar: %v", err)
	}
	if second.User == nil || second.User.AvatarURL == "" {
		t.Fatalf("member set result = %#v", second)
	}

	ownerRecord, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, owner)
	if err != nil || ownerRecord == nil || ownerRecord.StorageObject == nil {
		t.Fatalf("owner record = %#v, err=%v", ownerRecord, err)
	}
	memberRecord, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, member)
	if err != nil || memberRecord == nil || memberRecord.StorageObject == nil {
		t.Fatalf("member record = %#v, err=%v", memberRecord, err)
	}
	if ownerRecord.StorageObjectID == "" || ownerRecord.StorageObjectID != memberRecord.StorageObjectID {
		t.Fatalf("content-addressed references = %q and %q", ownerRecord.StorageObjectID, memberRecord.StorageObjectID)
	}
	if got := pgAvatarCount(t, fixture, `SELECT COUNT(*) FROM workspace_storage_objects WHERE deleted_at IS NULL`); got != 1 {
		t.Fatalf("live storage rows after dedupe = %d", got)
	}

	opened, err := fixture.service.OpenProfileAvatar(fixture.ctx, GetProfileAvatarInput{
		ActorID: owner, UserID: owner, Version: ownerRecord.Version,
	}, AvatarMaxOutputBytes)
	if err != nil {
		t.Fatalf("open canonical avatar: %v", err)
	}
	content, readErr := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(content) != string(fixture.media.content) || opened.ContentType != AvatarContentType {
		t.Fatalf("canonical content = %q type=%q err=%v", content, opened.ContentType, readErr)
	}

	if _, err := fixture.service.GetProfileAvatar(fixture.ctx, GetProfileAvatarInput{
		ActorID: viewer, UserID: member, Version: memberRecord.Version,
	}); !isAvatarCode(err, CodeAvatarNotFound) {
		t.Fatalf("hidden member avatar error = %v", err)
	}
	mustExecPGAvatar(t, fixture.ctx, fixture.conn, `
		INSERT INTO member_visibility_grants (space_id, viewer_user_id, visible_user_id, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5)
	`, DefaultSpaceID, viewer, member, owner, fixture.now)
	if _, err := fixture.service.GetProfileAvatar(fixture.ctx, GetProfileAvatarInput{
		ActorID: viewer, UserID: member, Version: memberRecord.Version,
	}); err != nil {
		t.Fatalf("granted member avatar: %v", err)
	}
	mustExecPGAvatar(t, fixture.ctx, fixture.conn, `
		DELETE FROM member_visibility_grants
		WHERE space_id = $1 AND viewer_user_id = $2 AND visible_user_id = $3
	`, DefaultSpaceID, viewer, member)
	mustExecPGAvatar(t, fixture.ctx, fixture.conn, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ($1, $2, 'direct', 'Avatar direct', $3, $4, $5)
	`, "conv_avatar_direct", DefaultSpaceID, "avatar-direct", viewer, fixture.now)
	for _, userID := range []string{viewer, member} {
		mustExecPGAvatar(t, fixture.ctx, fixture.conn, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ($1, $2, $3)
		`, "conv_avatar_direct", userID, fixture.now)
	}
	if _, err := fixture.service.GetProfileAvatar(fixture.ctx, GetProfileAvatarInput{
		ActorID: viewer, UserID: member, Version: memberRecord.Version,
	}); err != nil {
		t.Fatalf("direct-contact member avatar: %v", err)
	}
	mustExecPGAvatar(t, fixture.ctx, fixture.conn, `UPDATE users SET search_discoverable = TRUE WHERE id = $1`, member)
	if _, err := fixture.service.GetProfileAvatar(fixture.ctx, GetProfileAvatarInput{
		ActorID: viewer, UserID: member, Version: memberRecord.Version,
	}); err != nil {
		t.Fatalf("discoverable member avatar: %v", err)
	}

	if got := pgAvatarCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type = 'workspace.member_updated'`); got != 2 {
		t.Fatalf("avatar events after set = %d", got)
	}
	if got := pgAvatarCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action LIKE 'profile.avatar_%' AND result = 'success'`); got != 2 {
		t.Fatalf("avatar audits after set = %d", got)
	}
	var payload string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT payload_json FROM workspace_events
		WHERE type = 'workspace.member_updated' AND target_id = $1
		ORDER BY seq DESC LIMIT 1
	`, owner).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "source-owner") || strings.Contains(payload, string(fixture.media.content)) || strings.Contains(payload, ownerRecord.StorageObject.ObjectKey) {
		t.Fatalf("avatar event leaked content or storage metadata: %s", payload)
	}

	objectPath := filepath.Join(fixture.root, filepath.FromSlash(ownerRecord.StorageObject.ObjectKey))
	if _, err := os.Stat(objectPath); err != nil {
		t.Fatalf("canonical object missing before cleanup: %v", err)
	}
	if _, err := fixture.service.RemoveOwnAvatar(fixture.ctx, RemoveOwnAvatarInput{
		ActorID: owner, Meta: auth.RequestMeta{RequestID: "avatar-remove-owner"},
	}); err != nil {
		t.Fatalf("remove owner avatar: %v", err)
	}
	if _, err := os.Stat(objectPath); err != nil {
		t.Fatalf("shared canonical object removed early: %v", err)
	}
	if got := pgAvatarCount(t, fixture, `SELECT COUNT(*) FROM workspace_storage_objects WHERE deleted_at IS NULL`); got != 1 {
		t.Fatalf("storage rows after first removal = %d", got)
	}

	if _, err := fixture.service.RemoveOwnAvatar(fixture.ctx, RemoveOwnAvatarInput{
		ActorID: member, Meta: auth.RequestMeta{RequestID: "avatar-remove-member"},
	}); err != nil {
		t.Fatalf("remove member avatar: %v", err)
	}
	if _, err := os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("canonical object remains after final removal: %v", err)
	}
	var deletedAt *time.Time
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT deleted_at FROM workspace_storage_objects WHERE id = $1`, ownerRecord.StorageObjectID).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	if deletedAt == nil {
		t.Fatal("final avatar reference did not tombstone storage object")
	}
	if got := pgAvatarCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action LIKE 'profile.avatar_%' AND result = 'success'`); got != 4 {
		t.Fatalf("avatar audits after remove = %d", got)
	}
}

func TestPGAvatarSetRollsBackEvidenceAndPhysicalObjectOnAuditFailure(t *testing.T) {
	fixture := newPGAvatarIntegrationFixture(t)
	owner := "usr_avatar_owner"
	if _, err := fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{
		ActorID: owner, MIMEType: "image/png", Content: []byte("initial-source"),
		Meta: auth.RequestMeta{RequestID: "avatar-initial"},
	}); err != nil {
		t.Fatalf("initial avatar: %v", err)
	}
	before, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, owner)
	if err != nil || before == nil || before.StorageObject == nil {
		t.Fatalf("initial record = %#v, err=%v", before, err)
	}

	mustExecPGAvatar(t, fixture.ctx, fixture.conn, `
		CREATE FUNCTION fail_avatar_update_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'forced avatar audit failure'; END $$
	`)
	mustExecPGAvatar(t, fixture.ctx, fixture.conn, `
		CREATE TRIGGER fail_avatar_update_audit BEFORE INSERT ON audit_logs
		FOR EACH ROW WHEN (NEW.action = 'profile.avatar_update')
		EXECUTE FUNCTION fail_avatar_update_audit()
	`)
	t.Cleanup(func() {
		_, _ = fixture.conn.Exec(context.Background(), `DROP TRIGGER IF EXISTS fail_avatar_update_audit ON audit_logs`)
		_, _ = fixture.conn.Exec(context.Background(), `DROP FUNCTION IF EXISTS fail_avatar_update_audit()`)
	})

	newContent := []byte("replacement-normalized-avatar")
	fixture.media.content = newContent
	newKey, err := platformstorage.CanonicalObjectKey(pgAvatarDigest(newContent))
	if err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(fixture.root, filepath.FromSlash(newKey))
	_, err = fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{
		ActorID: owner, MIMEType: "image/png", Content: []byte("replacement-source"),
		Meta: auth.RequestMeta{RequestID: "avatar-replacement"},
	})
	if !isAvatarCode(err, CodeInternal) {
		t.Fatalf("audit failure error = %v", err)
	}
	if _, err := os.Stat(newPath); !os.IsNotExist(err) {
		t.Fatalf("rolled back physical object remains: %v", err)
	}

	after, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, owner)
	if err != nil || after == nil || after.Version != before.Version || after.StorageObjectID != before.StorageObjectID {
		t.Fatalf("avatar changed after rollback: before=%#v after=%#v err=%v", before, after, err)
	}
	if got := pgAvatarCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type = 'workspace.member_updated'`); got != 1 {
		t.Fatalf("rolled back event count = %d", got)
	}
	if got := pgAvatarCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action LIKE 'profile.avatar_%'`); got != 1 {
		t.Fatalf("rolled back audit count = %d", got)
	}
}
