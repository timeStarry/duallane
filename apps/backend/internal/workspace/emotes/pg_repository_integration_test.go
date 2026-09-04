//go:build postgres_integration

package emotes

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

type pgEmoteIntegrationFixture struct {
	ctx     context.Context
	conn    *pgx.Conn
	pool    *pgxpool.Pool
	service *Service
	store   *platformstorage.LocalBlobStore
	root    string
	now     time.Time
}

func newPGEmoteIntegrationFixture(t *testing.T) *pgEmoteIntegrationFixture {
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

	schema := fmt.Sprintf("duallane_emotes_%d", time.Now().UnixNano())
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

	now := time.Date(2026, 9, 4, 12, 34, 56, 789654321, time.UTC)
	seedPGEmoteIntegrationData(t, ctx, conn, now)

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
	var idSequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("emote-integration-%03d", idSequence.Add(1)), nil
	}
	return &pgEmoteIntegrationFixture{
		ctx: ctx, conn: conn, pool: pool, store: store, root: root, now: now,
		service: NewService(ServiceOptions{
			Repository: NewPGRepository(pool, idFactory),
			BlobStore:  store,
			Catalog:    testCatalog(t),
			Processor:  fakeProcessor{},
			SpaceID:    DefaultSpaceID,
			Now:        func() time.Time { return now },
			IDFactory:  idFactory,
		}),
	}
}

func seedPGEmoteIntegrationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct {
		id, login, name, role string
	}{
		{"usr_emote_owner", "emote-owner", "Emote Owner", "owner"},
		{"usr_emote_member", "emote-member", "Emote Member", "member"},
	} {
		mustExecPGEmote(t, ctx, conn, `
			INSERT INTO users (id, github_login, display_name, kind, created_at)
			VALUES ($1, $2, $3, 'human', $4)
		`, user.id, user.login, user.name, now)
	}
	mustExecPGEmote(t, ctx, conn, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ($1, 'Emotes Integration', 'emotes-integration', $2, $3)
	`, DefaultSpaceID, "usr_emote_owner", now)
	for _, user := range []struct {
		id, role string
	}{
		{"usr_emote_owner", "owner"},
		{"usr_emote_member", "member"},
	} {
		mustExecPGEmote(t, ctx, conn, `
			INSERT INTO space_members (space_id, user_id, role, joined_at)
			VALUES ($1, $2, $3, $4)
		`, DefaultSpaceID, user.id, user.role, now)
	}
}

func mustExecPGEmote(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func pgEmoteCount(t *testing.T, fixture *pgEmoteIntegrationFixture, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := fixture.pool.QueryRow(fixture.ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestPGEmoteLifecycleUsesIsolatedSchemaAndAtomicBlobCleanup(t *testing.T) {
	fixture := newPGEmoteIntegrationFixture(t)
	owner := "usr_emote_owner"
	member := "usr_emote_member"

	first, err := fixture.service.Upload(fixture.ctx, UploadInput{
		ActorID: owner,
		Source:  UploadSource{MIMEType: "image/png", FileName: "first.png"},
		Content: strings.NewReader("first emote bytes"), AddToLibrary: true,
		Meta: auth.RequestMeta{RequestID: "req-emote-create"},
	})
	if err != nil {
		t.Fatalf("first upload: %v", err)
	}
	if first.CreatedAt != "2026-09-04T12:34:56.789Z" || first.Kind != "custom" || first.Src == "" {
		t.Fatalf("first projection = %#v", first)
	}

	delivery, err := fixture.service.ReadContent(fixture.ctx, ReadContentInput{ActorID: owner, EmoteID: first.ID})
	if err != nil {
		t.Fatalf("owner content read: %v", err)
	}
	content, readErr := io.ReadAll(delivery.Body)
	_ = delivery.Body.Close()
	if readErr != nil || string(content) != "first emote bytes" || delivery.ContentType != "image/webp" {
		t.Fatalf("owner content = %q, type=%q, err=%v", content, delivery.ContentType, readErr)
	}
	if _, err := fixture.service.ReadContent(fixture.ctx, ReadContentInput{ActorID: member, EmoteID: first.ID}); !isCode(err, CodePermissionDenied) {
		t.Fatalf("unreferenced member read = %v", err)
	}

	second, err := fixture.service.Upload(fixture.ctx, UploadInput{
		ActorID: owner,
		Source:  UploadSource{MIMEType: "image/png", FileName: "second.png"},
		Content: strings.NewReader("second emote bytes"), AddToLibrary: false,
	})
	if err != nil {
		t.Fatalf("second upload: %v", err)
	}
	collection, err := fixture.service.CreateCollection(fixture.ctx, CreateCollectionInput{
		ActorID: owner, Name: "Integration collection", EmoteIDs: []string{first.ID, second.ID},
	})
	if err != nil || collection.ItemCount != 2 {
		t.Fatalf("collection = %#v, err=%v", collection, err)
	}
	share, err := fixture.service.CreateShare(fixture.ctx, CreateShareInput{ActorID: owner, CollectionID: collection.ID})
	if err != nil || share.ItemCount != 2 || len(share.Items) != 2 {
		t.Fatalf("share = %#v, err=%v", share, err)
	}

	asCollection := true
	imported, err := fixture.service.ImportShare(fixture.ctx, ImportShareInput{
		ActorID: member, ShareID: share.ID, AsCollection: &asCollection,
	})
	if err != nil || imported.Collection == nil || len(imported.Items) != 2 {
		t.Fatalf("imported share = %#v, err=%v", imported, err)
	}
	memberLibrary, err := fixture.service.GetLibrary(fixture.ctx, member)
	if err != nil || len(memberLibrary.Collections) != 1 || memberLibrary.Collections[0].ItemCount != 2 {
		t.Fatalf("member library = %#v, err=%v", memberLibrary, err)
	}
	memberDelivery, err := fixture.service.ReadContent(fixture.ctx, ReadContentInput{ActorID: member, EmoteID: imported.Items[0].ID})
	if err != nil {
		t.Fatalf("imported content read: %v", err)
	}
	_, readErr = io.Copy(io.Discard, memberDelivery.Body)
	_ = memberDelivery.Body.Close()
	if readErr != nil {
		t.Fatalf("imported content body: %v", readErr)
	}

	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM workspace_custom_emotes`); got != 4 {
		t.Fatalf("custom emote rows after import = %d, want 4", got)
	}
	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM workspace_storage_objects`); got != 2 {
		t.Fatalf("storage rows after import = %d, want 2", got)
	}
	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type LIKE 'emote.%'`); got < 5 {
		t.Fatalf("emote events = %d, want at least 5", got)
	}
	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action LIKE 'emote.%' AND result = 'success'`); got < 5 {
		t.Fatalf("emote audits = %d, want at least 5", got)
	}
	var eventPayload string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT payload_json FROM workspace_events WHERE type = 'emote.created' AND target_id = $1
		ORDER BY seq DESC LIMIT 1
	`, first.ID).Scan(&eventPayload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(eventPayload, "first emote bytes") || strings.Contains(eventPayload, "first.png") {
		t.Fatalf("emote event leaked content metadata: %s", eventPayload)
	}

	if _, err := fixture.service.Remove(fixture.ctx, owner, first.ID, auth.RequestMeta{}); err != nil {
		t.Fatalf("remove shared source: %v", err)
	}
	var removedAt *time.Time
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT removed_at FROM workspace_custom_emotes WHERE id = $1`, first.ID).Scan(&removedAt); err != nil {
		t.Fatal(err)
	}
	if removedAt == nil {
		t.Fatal("shared source was not marked removed")
	}
	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM workspace_storage_objects WHERE deleted_at IS NULL`); got != 2 {
		t.Fatalf("shared object cleanup happened too early: %d", got)
	}

	if _, err := fixture.service.RevokeShare(fixture.ctx, ShareInput{ActorID: owner, ShareID: share.ID}); err != nil {
		t.Fatalf("revoke share: %v", err)
	}
	if _, err := fixture.service.Remove(fixture.ctx, member, imported.Items[0].ID, auth.RequestMeta{}); err != nil {
		t.Fatalf("remove imported first: %v", err)
	}
	if _, err := fixture.service.Remove(fixture.ctx, member, imported.Items[1].ID, auth.RequestMeta{}); err != nil {
		t.Fatalf("remove imported second: %v", err)
	}
	if _, err := fixture.service.Remove(fixture.ctx, owner, first.ID, auth.RequestMeta{}); err != nil {
		t.Fatalf("remove source after import cleanup: %v", err)
	}
	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM workspace_custom_emotes`); got != 1 {
		t.Fatalf("custom rows after cascading logical cleanup = %d, want owner second only", got)
	}

	standalone, err := fixture.service.Upload(fixture.ctx, UploadInput{
		ActorID: owner, Source: UploadSource{MIMEType: "image/png", FileName: "standalone.png"},
		Content: strings.NewReader("standalone emote bytes"), AddToLibrary: true,
	})
	if err != nil {
		t.Fatalf("standalone upload: %v", err)
	}
	standaloneKey, err := platformstorage.CanonicalObjectKey(canonicalDigest([]byte("standalone emote bytes")))
	if err != nil {
		t.Fatal(err)
	}
	standalonePath := filepath.Join(fixture.root, filepath.FromSlash(standaloneKey))
	if _, err := os.Stat(standalonePath); err != nil {
		t.Fatalf("standalone object missing: %v", err)
	}
	if _, err := fixture.service.Remove(fixture.ctx, owner, standalone.ID, auth.RequestMeta{}); err != nil {
		t.Fatalf("remove standalone: %v", err)
	}
	if _, err := os.Stat(standalonePath); !os.IsNotExist(err) {
		t.Fatalf("standalone object remains after final remove: %v", err)
	}
	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM workspace_storage_objects WHERE deleted_at IS NULL`); got != 1 {
		t.Fatalf("live storage rows after standalone cleanup = %d, want imported/source object only", got)
	}

	if _, err := fixture.conn.Exec(fixture.ctx, `
		CREATE FUNCTION fail_emote_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'forced emote audit failure'; END $$
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.conn.Exec(fixture.ctx, `
		CREATE TRIGGER fail_emote_create_audit BEFORE INSERT ON audit_logs
		FOR EACH ROW WHEN (NEW.action = 'emote.create') EXECUTE FUNCTION fail_emote_audit()
	`); err != nil {
		t.Fatal(err)
	}
	rollbackDigest := canonicalDigest([]byte("rollback emote bytes"))
	rollbackKey, err := platformstorage.CanonicalObjectKey(rollbackDigest)
	if err != nil {
		t.Fatal(err)
	}
	_, uploadErr := fixture.service.Upload(fixture.ctx, UploadInput{
		ActorID: owner, Source: UploadSource{MIMEType: "image/png", FileName: "rollback.png"},
		Content: strings.NewReader("rollback emote bytes"), AddToLibrary: true,
	})
	if !isCode(uploadErr, CodeInternal) {
		t.Fatalf("audit failure error = %v", uploadErr)
	}
	if _, err := fixture.conn.Exec(fixture.ctx, `DROP TRIGGER fail_emote_create_audit ON audit_logs`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.conn.Exec(fixture.ctx, `DROP FUNCTION fail_emote_audit()`); err != nil {
		t.Fatal(err)
	}
	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM workspace_custom_emotes WHERE original_file_name = 'rollback.png'`); got != 0 {
		t.Fatalf("rolled back emote rows = %d", got)
	}
	rollbackPath := filepath.Join(fixture.root, filepath.FromSlash(rollbackKey))
	if _, err := os.Stat(rollbackPath); !os.IsNotExist(err) {
		t.Fatalf("rolled back physical object remains: %v", err)
	}
}
