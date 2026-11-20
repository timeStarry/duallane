//go:build postgres_integration

package v1

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestPGEmailLoginUsesVerifiedGitHubAsDefault(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	schema := fmt.Sprintf("duallane_email_login_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("CREATE SCHEMA " + identifier)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE")
	})
	exec("SET search_path TO " + identifier)
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Join(filepath.Dir(source), "../../../web/server/migrations")
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: dir}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	now := time.Date(2026, 11, 19, 6, 0, 0, 0, time.UTC)
	exec(`INSERT INTO spaces (id, slug, name, created_at) VALUES ('email-space','email-space','Email login',$1), ('other-space','other-space','Other',$1)`, now)
	exec(`INSERT INTO users (id, github_id, github_login, display_name, email, github_login_email, kind, created_at) VALUES
		('github-user', '101', 'github-user', 'GitHub user', 'public@example.test', 'primary@example.test', 'human', $1),
		('bound-user', '102', 'bound-user', 'Bound user', NULL, 'bound-primary@example.test', 'human', $1),
		('legacy-user', '103', 'legacy-user', 'Legacy user', 'legacy@example.test', NULL, 'human', $1),
		('removed-user', '104', 'removed-user', 'Removed user', NULL, 'removed@example.test', 'human', $1),
		('dup-a', '105', 'dup-a', 'Duplicate A', NULL, 'duplicate@example.test', 'human', $1),
		('dup-b', '106', 'dup-b', 'Duplicate B', NULL, 'duplicate@example.test', 'human', $1),
		('other-user', '107', 'other-user', 'Other space user', NULL, 'primary@example.test', 'human', $1),
		('bot-user', NULL, 'bot-user', 'Bot user', NULL, 'bot@example.test', 'bot', $1)`, now)
	exec(`INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
		SELECT CASE WHEN id = 'other-user' THEN 'other-space' ELSE 'email-space' END, id, 'member', $1::timestamptz,
			CASE WHEN id = 'removed-user' THEN $1::timestamptz ELSE NULL END FROM users`, now)
	exec(`INSERT INTO user_preferences (user_id,prefs_json,updated_at)
		VALUES ('bound-user','{"boundEmail":"explicit@example.test"}',$1)`, now)

	repo := NewPGRepository(pool, "email-space")
	assertOwner := func(address, want string) {
		t.Helper()
		got, err := repo.FindEmailLoginOwner(ctx, address)
		if err != nil || got != want {
			t.Fatalf("owner for %s = %q, err=%v, want %q", address, got, err, want)
		}
	}
	assertOwner("primary@example.test", "github-user")
	assertOwner("explicit@example.test", "bound-user")
	for _, address := range []string{"public@example.test", "legacy@example.test", "bound-primary@example.test", "removed@example.test", "duplicate@example.test", "bot@example.test"} {
		assertOwner(address, "")
	}

	mailer := &stubEmailSender{}
	service := NewService(repo).WithEmailSender(mailer)
	service.now = func() time.Time { return now }
	service.codeGen = func() (string, error) { return "654321", nil }
	address := "primary@example.test"
	previous, err := service.SendLoginEmailCode(ctx, "  PRIMARY@example.test  ")
	if err != nil || mailer.lastRecipient != address || mailer.lastPurpose != "login" {
		t.Fatalf("send code to verified default: recipient=%q, err=%v", mailer.lastRecipient, err)
	}
	if err := repo.BindAccountEmail(ctx, "bound-user", address, now); err != nil {
		t.Fatal(err)
	}
	assertOwner(address, "bound-user")
	if _, err := service.VerifyLoginEmail(ctx, address, previous.ChallengeID, "654321"); !errors.Is(err, ErrChallengeInvalid) {
		t.Fatalf("old code after explicit binding changes ownership: %v", err)
	}
	if err := repo.UnbindAccountEmail(ctx, "bound-user", now); err != nil {
		t.Fatal(err)
	}
	assertOwner(address, "github-user")
	assertOwner("bound-primary@example.test", "bound-user")

	now = now.Add(time.Minute)
	challenge, err := service.SendLoginEmailCode(ctx, address)
	if err != nil {
		t.Fatal(err)
	}
	user, err := service.VerifyLoginEmail(ctx, address, challenge.ChallengeID, "654321")
	if err != nil || user.ID != "github-user" {
		t.Fatalf("verify GitHub default: id=%q, err=%v", user.ID, err)
	}
	if _, err := service.VerifyLoginEmail(ctx, address, challenge.ChallengeID, "654321"); !errors.Is(err, ErrChallengeInvalid) {
		t.Fatalf("replay GitHub default code: %v", err)
	}

	now = now.Add(time.Minute)
	results := make(chan error, 2)
	for _, id := range []string{"echl_login_parallel_a", "echl_login_parallel_b"} {
		go func() {
			results <- repo.SaveEmailChallenge(ctx, id, "github-user", address, "fixture-hash", now, now.Add(10*time.Minute))
		}()
	}
	var reserved, limited int
	for range 2 {
		switch err := <-results; {
		case err == nil:
			reserved++
		case errors.Is(err, ErrRateLimited):
			limited++
		default:
			t.Fatal(err)
		}
	}
	if reserved != 1 || limited != 1 {
		t.Fatalf("concurrent login challenge reservations = %d success, %d limited", reserved, limited)
	}
}
