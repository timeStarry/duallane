//go:build postgres_integration

package releases

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type pgReleaseIntegrationFixture struct {
	ctx     context.Context
	conn    *pgx.Conn
	pool    *pgxpool.Pool
	repo    *PGRepository
	service *Service
	now     time.Time
	schema  string
}

func newPGReleaseIntegrationFixture(t *testing.T) *pgReleaseIntegrationFixture {
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

	schema := fmt.Sprintf("duallane_echo_releases_%d", time.Now().UnixNano())
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
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../../web/server/migrations"))
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: migrationDirectory}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	seedPGReleaseData(t, ctx, conn)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.MaxConns = 8
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var sequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("release-pg-%03d", sequence.Add(1)), nil
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../../web/shared/echo-release-guides.json"))
	catalog, err := LoadGuideCatalog(path)
	if err != nil {
		t.Fatal(err)
	}
	repository := NewPGRepository(pool, idFactory)
	now := time.Date(2026, 9, 6, 12, 34, 56, 789000000, time.UTC)
	service, err := NewService(ServiceOptions{Repository: repository, Catalog: catalog, SpaceID: auth.DefaultSpaceID, Now: func() time.Time { return now }, IDFactory: idFactory})
	if err != nil {
		t.Fatal(err)
	}
	return &pgReleaseIntegrationFixture{ctx: ctx, conn: conn, pool: pool, repo: repository, service: service, now: now, schema: schema}
}

func seedPGReleaseData(t *testing.T, ctx context.Context, conn *pgx.Conn) {
	t.Helper()
	now := testReleaseTime
	for _, user := range []struct {
		id, login, kind string
	}{
		{"usr_release_owner", "release-owner", "human"},
		{"usr_release_member", "release-member", "human"},
		{"usr_release_removed", "release-removed", "human"},
		{"usr_release_bot", "release-bot", "bot"},
	} {
		mustExecPGRelease(t, ctx, conn, `INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ($1, $2, $2, $3, $4)`, user.id, user.login, user.kind, now)
	}
	mustExecPGRelease(t, ctx, conn, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Echo releases integration', 'echo-releases-integration', $2, $3)`, auth.DefaultSpaceID, "usr_release_owner", now)
	for _, member := range []struct {
		id, role string
		removed  bool
	}{
		{"usr_release_owner", "owner", false},
		{"usr_release_member", "member", false},
		{"usr_release_removed", "member", true},
		{"usr_release_bot", "member", false},
	} {
		if member.removed {
			mustExecPGRelease(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at) VALUES ($1, $2, $3, $4, $4)`, auth.DefaultSpaceID, member.id, member.role, now)
		} else {
			mustExecPGRelease(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`, auth.DefaultSpaceID, member.id, member.role, now)
		}
	}
}

func mustExecPGRelease(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresReleasePublishSnapshotsAndReplays(t *testing.T) {
	fixture := newPGReleaseIntegrationFixture(t)
	first, err := fixture.service.Publish(fixture.ctx, PublishInput{ActorID: "usr_release_owner", Version: "v0.15.1", Meta: auth.RequestMeta{RequestID: "release-pg-first"}})
	if err != nil {
		t.Fatal(err)
	}
	if first.RecipientCount != 2 || first.PendingCount != 2 || first.Replayed {
		t.Fatalf("first publication = %#v", first)
	}
	second, err := fixture.service.Publish(fixture.ctx, PublishInput{ActorID: "usr_release_owner", Version: "0.15.1", Meta: auth.RequestMeta{RequestID: "release-pg-replay"}})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || !second.Replayed || second.RecipientCount != 2 {
		t.Fatalf("replayed publication = %#v", second)
	}
	var publicationCount, deliveryCount int64
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COUNT(*) FROM echo_release_publications`).Scan(&publicationCount); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COUNT(*) FROM echo_release_deliveries`).Scan(&deliveryCount); err != nil {
		t.Fatal(err)
	}
	if publicationCount != 1 || deliveryCount != 2 {
		t.Fatalf("publication count=%d delivery count=%d", publicationCount, deliveryCount)
	}
	var guideHash, guideJSON string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT guide_hash, guide_json FROM echo_release_publications`).Scan(&guideHash, &guideJSON); err != nil {
		t.Fatal(err)
	}
	if len(guideHash) != 64 || guideJSON == "" || !containsText(guideJSON, "location") {
		t.Fatalf("invalid guide snapshot hash=%q jsonPresent=%t", guideHash, guideJSON != "")
	}
	var publishedAudit, replayedAudit int64
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.release.publish' AND result = 'success' AND reason = 'published'`).Scan(&publishedAudit); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.release.publish' AND result = 'success' AND reason = 'replayed'`).Scan(&replayedAudit); err != nil {
		t.Fatal(err)
	}
	if publishedAudit != 1 || replayedAudit != 1 {
		t.Fatalf("published audit=%d replayed audit=%d", publishedAudit, replayedAudit)
	}
	var auditReason string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COALESCE(string_agg(COALESCE(reason, ''), ' '), '') FROM audit_logs WHERE action = 'echo.release.publish'`).Scan(&auditReason); err != nil {
		t.Fatal(err)
	}
	if containsText(auditReason, "个人设置") || containsText(auditReason, "location") {
		t.Fatal("release guide content leaked into audit reason")
	}
	card, err := fixture.service.ProjectCard(fixture.ctx, ProjectCardInput{ActorID: "usr_release_member", Version: "0.15.1"})
	if err != nil {
		t.Fatal(err)
	}
	if card.Payload.Version != "0.15.1" || card.Payload.PublishedAt == "" || len(card.Payload.Sections) == 0 {
		t.Fatalf("projected release card = %#v", card)
	}
	if _, err := fixture.service.ProjectCard(fixture.ctx, ProjectCardInput{ActorID: "usr_release_member", Version: "0.15.1", PublicationID: "wrong-publication"}); !hasCode(err, CodeNotFound) {
		t.Fatalf("wrong publication projection error = %v", err)
	}
	if _, err := fixture.service.ProjectCard(fixture.ctx, ProjectCardInput{ActorID: "usr_release_removed", Version: "0.15.1"}); !hasCode(err, CodePermissionDenied) {
		t.Fatalf("removed recipient error = %v", err)
	}
}

func TestPostgresReleaseOwnerAuthorizationAndGuideFailureAudit(t *testing.T) {
	fixture := newPGReleaseIntegrationFixture(t)
	if _, err := fixture.service.Publish(fixture.ctx, PublishInput{ActorID: "usr_release_member", Version: "0.15.1"}); !hasCode(err, CodePermissionDenied) {
		t.Fatalf("member publish error = %v", err)
	}
	if _, err := fixture.service.Publish(fixture.ctx, PublishInput{ActorID: "usr_release_owner", Version: "9.9.9"}); !hasCode(err, CodeGuideNotFound) {
		t.Fatalf("unknown guide error = %v", err)
	}
	var publications, deliveries, audits int64
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COUNT(*) FROM echo_release_publications`).Scan(&publications); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COUNT(*) FROM echo_release_deliveries`).Scan(&deliveries); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.release.publish' AND result = 'rejected'`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if publications != 0 || deliveries != 0 || audits != 2 {
		t.Fatalf("failed publish rows publications=%d deliveries=%d audits=%d", publications, deliveries, audits)
	}
}

func containsText(value, needle string) bool {
	return len(needle) > 0 && len(value) >= len(needle) && stringContains(value, needle)
}

func stringContains(value, needle string) bool {
	for index := 0; index+len(needle) <= len(value); index++ {
		if value[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}
