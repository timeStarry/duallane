//go:build postgres_integration

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type nodeLegacyEmoteManifest struct {
	ContractVersion int    `json:"contractVersion"`
	Source          string `json:"source"`
	Synthetic       bool   `json:"synthetic"`
	Records         []struct {
		ID                  string  `json:"id"`
		OwnerID             string  `json:"ownerId"`
		SourceType          string  `json:"sourceType"`
		SourceCustomEmoteID *string `json:"sourceCustomEmoteId"`
		StorageKey          *string `json:"storageKey"`
		StorageObjectID     *string `json:"storageObjectId"`
		CanonicalObjectKey  string  `json:"canonicalObjectKey"`
		ByteSize            *int64  `json:"byteSize"`
		SHA256              *string `json:"sha256"`
		Removed             bool    `json:"removed"`
		Metadata            struct {
			OriginalFileName   *string `json:"originalFileName"`
			OriginalMIMEType   *string `json:"originalMimeType"`
			NormalizedMIMEType *string `json:"normalizedMimeType"`
			Width              *int    `json:"width"`
			Height             *int    `json:"height"`
			FrameCount         *int    `json:"frameCount"`
			DurationMS         *int    `json:"durationMs"`
		} `json:"metadata"`
	} `json:"records"`
	Cases []struct {
		Name      string   `json:"name"`
		ActorID   string   `json:"actorId"`
		RecordIDs []string `json:"recordIds"`
		Expected  struct {
			Outcome    string `json:"outcome"`
			SHA256     string `json:"sha256"`
			ByteSize   int    `json:"byteSize"`
			Code       string `json:"code"`
			StatusCode int    `json:"statusCode"`
		} `json:"expected"`
	} `json:"cases"`
}

// The Node runner creates and subsequently rechecks these same physical bytes.
// PostgreSQL rows are imported only into this test's disposable schema. No Node
// database, real user content, or historical storage object is mutated by Go.
func TestWorkspaceReadsActualNodeLegacyEmotes(t *testing.T) {
	fixtureDir := os.Getenv("DUALLANE_NODE_EMOTES_LEGACY_FIXTURE")
	if fixtureDir == "" {
		t.Skip("DUALLANE_NODE_EMOTES_LEGACY_FIXTURE is not set")
	}
	if !filepath.IsAbs(fixtureDir) || !strings.HasPrefix(filepath.Base(fixtureDir), "duallane-emotes-legacy-contract-") {
		t.Fatal("expected an absolute synthetic Node emote fixture directory")
	}
	manifestFile, err := os.Open(filepath.Join(fixtureDir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := io.ReadAll(io.LimitReader(manifestFile, 64*1024+1))
	closeErr := manifestFile.Close()
	if err != nil || closeErr != nil || len(manifestBytes) > 64*1024 {
		t.Fatal("cannot read bounded synthetic emote manifest")
	}
	var manifest nodeLegacyEmoteManifest
	decoder := json.NewDecoder(bytes.NewReader(manifestBytes))
	if err := decoder.Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	var trailing any
	if !errors.Is(decoder.Decode(&trailing), io.EOF) || manifest.ContractVersion != 1 ||
		manifest.Source != "node.workspace.custom-emotes.legacy-read" || !manifest.Synthetic ||
		len(manifest.Records) != 7 || len(manifest.Cases) != 5 {
		t.Fatal("unexpected Node emote manifest contract")
	}
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("Node/Go legacy emote parity requires TEST_DATABASE_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	schema := fmt.Sprintf("duallane_node_emote_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	webDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../web"))
	if _, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(conn), Directory: filepath.Join(webDir, "server/migrations")}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, actorID := range []string{"usr_owner", "usr_legacy_denied"} {
		exec(`INSERT INTO users (id,github_login,display_name,kind,created_at) VALUES ($1,$1,$1,'human',NOW())`, actorID)
	}
	exec(`INSERT INTO spaces (id,name,slug,created_by,created_at) VALUES ('spc_default','Fixture','fixture','usr_owner',NOW())`)
	exec(`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_default','usr_owner','owner',NOW()),('spc_default','usr_legacy_denied','member',NOW())`)
	for _, record := range manifest.Records {
		if record.OwnerID != "usr_owner" || record.ID == "" || strings.ContainsAny(record.ID, "/\\?#") {
			t.Fatal("unexpected synthetic emote identity")
		}
		if record.StorageObjectID != nil {
			if record.CanonicalObjectKey == "" || record.ByteSize == nil || record.SHA256 == nil {
				t.Fatal("canonical fixture omitted registry metadata")
			}
			exec(`INSERT INTO workspace_storage_objects (id,sha256,object_key,byte_size,content_type,created_at,verified_at)
				VALUES ($1,$2,$3,$4,'image/webp',NOW(),NOW())`, record.StorageObjectID, record.SHA256, record.CanonicalObjectKey, record.ByteSize)
		}
		var removedAt *time.Time
		if record.Removed {
			removed := time.Now().UTC()
			removedAt = &removed
		}
		exec(`INSERT INTO workspace_custom_emotes (
			id,user_id,source_type,source_custom_emote_id,original_file_name,original_mime_type,label,
			normalized_mime_type,byte_size,width,height,frame_count,duration_ms,sha256,storage_key,storage_object_id,sort_order,created_at,removed_at)
			VALUES ($1,$2,$3,$4,$5,$6,'Fixture',$7,$8,$9,$10,$11,$12,$13,$14,$15,0,NOW(),$16)`,
			record.ID, record.OwnerID, record.SourceType, record.SourceCustomEmoteID, record.Metadata.OriginalFileName,
			record.Metadata.OriginalMIMEType, record.Metadata.NormalizedMIMEType, record.ByteSize,
			record.Metadata.Width, record.Metadata.Height, record.Metadata.FrameCount, record.Metadata.DurationMS,
			record.SHA256, record.StorageKey, record.StorageObjectID, removedAt)
	}
	isolatedDSN, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := isolatedDSN.Query()
	query.Set("search_path", schema)
	isolatedDSN.RawQuery = query.Encode()
	t.Setenv("DATABASE_URL", isolatedDSN.String())
	app, err := newApplication(ctx, config.WorkspaceConfig{
		Enabled: true, Environment: "test", AppVersion: "test", StorageDriver: "local", DataDir: fixtureDir,
		EmoteCatalogPath: filepath.Join(webDir, "shared/emote-packs.json"), GitHubOAuthTimeout: time.Second,
		ReleaseCatalogPath: filepath.Join(webDir, "shared/echo-release-guides.json"),
		MigrationsDir:      filepath.Join(webDir, "server/migrations"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	sessions := map[string]string{}
	for _, actorID := range []string{"usr_owner", "usr_legacy_denied"} {
		session, err := auth.NewService(auth.ServiceOptions{Store: auth.NewPGStore(app.pool)}).CreateSession(ctx, actorID)
		if err != nil {
			t.Fatal(err)
		}
		sessions[actorID] = session.Token
	}
	for _, scenario := range manifest.Cases {
		t.Run(scenario.Name, func(t *testing.T) {
			if sessions[scenario.ActorID] == "" || len(scenario.RecordIDs) == 0 {
				t.Fatal("fixture has no authorized test session or target")
			}
			for _, id := range scenario.RecordIDs {
				request := httptest.NewRequest(http.MethodGet, "/api/workspace/emotes/"+url.PathEscape(id)+"/content", nil)
				request.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: sessions[scenario.ActorID]})
				response := httptest.NewRecorder()
				app.handler.ServeHTTP(response, request)
				if scenario.Expected.Outcome == "read" {
					digest := sha256.Sum256(response.Body.Bytes())
					if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "image/webp" ||
						response.Body.Len() != scenario.Expected.ByteSize || hex.EncodeToString(digest[:]) != scenario.Expected.SHA256 {
						t.Fatalf("Node/Go delivery mismatch for %s: status=%d bytes=%d", id, response.Code, response.Body.Len())
					}
					continue
				}
				var body struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if scenario.Expected.Outcome != "reject" || json.Unmarshal(response.Body.Bytes(), &body) != nil ||
					response.Code != scenario.Expected.StatusCode || body.Error.Code != scenario.Expected.Code {
					t.Fatalf("Node/Go rejection mismatch for %s: status=%d code=%s", id, response.Code, body.Error.Code)
				}
			}
		})
	}
}
