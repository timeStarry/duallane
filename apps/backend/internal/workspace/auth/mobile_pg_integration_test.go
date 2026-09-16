//go:build postgres_integration

package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func mobileIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	schema := fmt.Sprintf("duallane_mobile_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = conn.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE")
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, source, _, _ := runtime.Caller(0)
	runner := migrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../web/server/migrations"))}
	if _, err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO users(id,github_login,display_name,kind,created_at,last_login_at) VALUES('usr_owner','timeStarry','Owner','human',now(),now())`,
		`INSERT INTO spaces(id,name,slug,created_by,created_at) VALUES('spc_default','Test','test','usr_owner',now())`,
		`INSERT INTO space_members(space_id,user_id,role,joined_at) VALUES('spc_default','usr_owner','owner',now())`,
	} {
		if _, err := conn.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
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
	return pool
}

func TestMobilePGTokenLifecycle(t *testing.T) {
	pool := mobileIntegrationPool(t)
	store := NewMobilePGStore(pool)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	service := &MobileService{Repository: store, Now: func() time.Time { return now }}
	verifier := strings.Repeat("v", 43)
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	tokens := func(t *testing.T) MobileTokens {
		t.Helper()
		result, err := service.tokens()
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	prepare := func(t *testing.T) string {
		t.Helper()
		id, err := NewSessionToken()
		if err != nil {
			t.Fatal(err)
		}
		if err = store.SaveFlow(ctx, MobileFlow{ID: id, Challenge: challenge, RedirectURI: MobileRedirectURI, ClientState: "state", ExpiresAt: now.Add(10 * time.Minute)}); err != nil {
			t.Fatal(err)
		}
		code, err := NewSessionToken()
		if err != nil {
			t.Fatal(err)
		}
		if _, err = store.AuthorizeFlow(ctx, id, SeededOwnerID, HashSecret(code), now); err != nil {
			t.Fatal(err)
		}
		return code
	}
	issue := func(t *testing.T) MobileTokens {
		t.Helper()
		result := tokens(t)
		if err := store.Exchange(ctx, HashSecret(prepare(t)), verifier, MobileRedirectURI, result, now); err != nil {
			t.Fatal(err)
		}
		return result
	}
	requireInvalidAccess := func(t *testing.T, token string) {
		t.Helper()
		if _, err := store.Resolve(ctx, HashSecret(token), now); !isCode(err, CodeRequired) {
			t.Fatalf("access error = %v", err)
		}
	}
	t.Run("PKCE and redirect failures preserve one-time code", func(t *testing.T) {
		code, result := prepare(t), tokens(t)
		for _, input := range []struct{ verifier, redirect string }{{strings.Repeat("x", 43), MobileRedirectURI}, {verifier, "other://oauth"}} {
			if err := store.Exchange(ctx, HashSecret(code), input.verifier, input.redirect, result, now); !errors.Is(err, errMobileInvalid) {
				t.Fatalf("invalid exchange = %v", err)
			}
		}
		if err := store.Exchange(ctx, HashSecret(code), verifier, MobileRedirectURI, result, now); err != nil {
			t.Fatal(err)
		}
		if err := store.Exchange(ctx, HashSecret(code), verifier, MobileRedirectURI, tokens(t), now); !errors.Is(err, errMobileInvalid) {
			t.Fatalf("replayed code = %v", err)
		}
		actor, err := store.Resolve(ctx, HashSecret(result.AccessToken), now)
		if err != nil || actor.ID != SeededOwnerID {
			t.Fatalf("actor = %#v %v", actor, err)
		}
		var accessHash, refreshHash string
		if err := pool.QueryRow(ctx, `SELECT a.token_hash,r.token_hash FROM mobile_access_tokens a JOIN mobile_refresh_tokens r ON r.family_id=a.family_id WHERE a.token_hash=$1`, HashSecret(result.AccessToken)).Scan(&accessHash, &refreshHash); err != nil {
			t.Fatal(err)
		}
		if accessHash == result.AccessToken || refreshHash != HashSecret(result.RefreshToken) {
			t.Fatal("raw tokens persisted")
		}
	})
	t.Run("concurrent exchange issues one family", func(t *testing.T) {
		code := prepare(t)
		results := make(chan error, 2)
		for i := 0; i < 2; i++ {
			result := tokens(t)
			go func() { results <- store.Exchange(ctx, HashSecret(code), verifier, MobileRedirectURI, result, now) }()
		}
		var succeeded, rejected int
		for i := 0; i < 2; i++ {
			err := <-results
			if err == nil {
				succeeded++
			} else if errors.Is(err, errMobileInvalid) {
				rejected++
			} else {
				t.Fatal(err)
			}
		}
		if succeeded != 1 || rejected != 1 {
			t.Fatalf("results = %d success %d rejection", succeeded, rejected)
		}
	})
	t.Run("refresh keeps deadline and reuse revokes family", func(t *testing.T) {
		initial, rotated := issue(t), tokens(t)
		rotated.RefreshTokenExpiresAt = externalTime(now.Add(60 * 24 * time.Hour))
		if err := store.Rotate(ctx, HashSecret(initial.RefreshToken), &rotated, now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		if rotated.RefreshTokenExpiresAt != initial.RefreshTokenExpiresAt {
			t.Fatal("refresh extended absolute deadline")
		}
		if _, err := store.Resolve(ctx, HashSecret(rotated.AccessToken), now); err != nil {
			t.Fatal(err)
		}
		reused := tokens(t)
		if err := store.Rotate(ctx, HashSecret(initial.RefreshToken), &reused, now.Add(2*time.Minute)); !errors.Is(err, errMobileInvalid) {
			t.Fatalf("reused refresh = %v", err)
		}
		requireInvalidAccess(t, initial.AccessToken)
		requireInvalidAccess(t, rotated.AccessToken)
		if err := store.Rotate(ctx, HashSecret(rotated.RefreshToken), &reused, now); !errors.Is(err, errMobileInvalid) {
			t.Fatalf("revoked family refresh = %v", err)
		}
	})
	t.Run("concurrent refresh detects reuse", func(t *testing.T) {
		initial := issue(t)
		results := make(chan error, 2)
		for i := 0; i < 2; i++ {
			result := tokens(t)
			go func() { results <- store.Rotate(ctx, HashSecret(initial.RefreshToken), &result, now) }()
		}
		var succeeded, rejected int
		for i := 0; i < 2; i++ {
			err := <-results
			if err == nil {
				succeeded++
			} else if errors.Is(err, errMobileInvalid) {
				rejected++
			} else {
				t.Fatal(err)
			}
		}
		if succeeded != 1 || rejected != 1 {
			t.Fatalf("results = %d success %d rejection", succeeded, rejected)
		}
		requireInvalidAccess(t, initial.AccessToken)
	})
	t.Run("logout accepts old refresh and revokes descendants", func(t *testing.T) {
		initial, rotated := issue(t), tokens(t)
		if err := store.Rotate(ctx, HashSecret(initial.RefreshToken), &rotated, now); err != nil {
			t.Fatal(err)
		}
		if err := store.Revoke(ctx, HashSecret(initial.RefreshToken), now); err != nil {
			t.Fatal(err)
		}
		requireInvalidAccess(t, rotated.AccessToken)
		if err := store.Revoke(ctx, HashSecret(initial.RefreshToken), now); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("removed membership blocks access and refresh", func(t *testing.T) {
		initial, next := issue(t), tokens(t)
		if _, err := pool.Exec(ctx, `UPDATE space_members SET removed_at=$1 WHERE user_id=$2`, now, SeededOwnerID); err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, _ = pool.Exec(ctx, `UPDATE space_members SET removed_at=NULL WHERE user_id=$1`, SeededOwnerID)
		}()
		requireInvalidAccess(t, initial.AccessToken)
		if err := store.Rotate(ctx, HashSecret(initial.RefreshToken), &next, now); !errors.Is(err, errMobileInvalid) {
			t.Fatalf("removed member refresh = %v", err)
		}
	})
	t.Run("expiry and cancellation", func(t *testing.T) {
		code, next := prepare(t), tokens(t)
		if err := store.Exchange(ctx, HashSecret(code), verifier, MobileRedirectURI, next, now.Add(time.Minute)); !errors.Is(err, errMobileInvalid) {
			t.Fatalf("expired code = %v", err)
		}
		initial := issue(t)
		if _, err := store.Resolve(ctx, HashSecret(initial.AccessToken), now.Add(15*time.Minute)); !isCode(err, CodeRequired) {
			t.Fatalf("expired access = %v", err)
		}
		if err := store.Rotate(ctx, HashSecret(initial.RefreshToken), &next, now.Add(30*24*time.Hour)); !errors.Is(err, errMobileInvalid) {
			t.Fatalf("expired family = %v", err)
		}
		cancelled, stop := context.WithCancel(ctx)
		stop()
		if err := store.Rotate(cancelled, HashSecret(initial.RefreshToken), &next, now); err == nil || errors.Is(err, errMobileInvalid) {
			t.Fatalf("cancelled database request misclassified: %v", err)
		}
	})
	t.Run("durable rate limit and content-free audit", func(t *testing.T) {
		for i := 1; i <= 61; i++ {
			allowed, err := store.Allow(ctx, HashSecret("203.0.113.7"), now)
			if err != nil || allowed != (i <= 60) {
				t.Fatalf("attempt %d = %v %v", i, allowed, err)
			}
		}
		if allowed, err := store.Allow(ctx, HashSecret("203.0.113.7"), now.Add(time.Minute)); err != nil || !allowed {
			t.Fatalf("new rate window = %v %v", allowed, err)
		}
		if err := store.RecordRejection(ctx, "refresh", RequestMeta{RequestID: "mobile-test"}, now); err != nil {
			t.Fatal(err)
		}
		var operation, reason string
		if err := pool.QueryRow(ctx, `SELECT target_id,reason FROM audit_logs WHERE action='auth.mobile.rejected' AND request_id='mobile-test'`).Scan(&operation, &reason); err != nil {
			t.Fatal(err)
		}
		if operation != "refresh" || reason != "auth.mobile_invalid" {
			t.Fatalf("audit = %q %q", operation, reason)
		}
	})
}
