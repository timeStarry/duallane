//go:build postgres_integration

package migrations_test

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	workspaceemotes "github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
)

func TestPostgresSchemaCheckerIsReadOnlyAgainstCurrentHistory(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())

	schema := fmt.Sprintf("duallane_schema_check_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := conn.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		CREATE TABLE schema_migrations (
			name TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL
		)`); err != nil {
		t.Fatal(err)
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	directory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	files, err := migrations.Discover(directory)
	if err != nil {
		t.Fatal(err)
	}
	for index, file := range files {
		if _, err := conn.Exec(ctx, "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", file.Name, time.Unix(int64(index), 0).UTC()); err != nil {
			t.Fatal(err)
		}
	}

	before, err := readMigrationHistory(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	isolatedDSN, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := isolatedDSN.Query()
	query.Set("search_path", schema)
	isolatedDSN.RawQuery = query.Encode()
	pool, err := postgres.OpenPool(ctx, isolatedDSN.String(), postgres.PoolOptions{MaxConnections: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	queryer := postgres.NewMigrationReadOnlyQueryer(pool)
	report, err := (migrations.SchemaChecker{
		Queryer:   queryer,
		Directory: directory,
	}).Check(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.RequiredNames) != len(files) || report.AppliedCount != len(files) || len(report.MissingNames) != 0 || report.UnknownCount != 0 {
		t.Fatalf("unexpected compatibility report: %#v", report)
	}

	verifyReadOnlyTransaction(t, ctx, queryer, conn, schema)
	after, err := readMigrationHistory(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("schema_migrations changed during read-only check: before=%v after=%v", before, after)
	}
}

func TestPostgresSchemaCheckerAllowsReviewed034AndOldWriterPreservesNewPreferences(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())

	schema := fmt.Sprintf("duallane_schema_compat_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := conn.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
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
	canonicalDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	canonicalFiles := assertCanonicalCompatibilityInventory(t, canonicalDirectory)
	directory := copyCanonicalCompatibilityBaseline(t, canonicalFiles)
	files, err := migrations.Discover(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != len(expectedCompatibilityBaselineNames) {
		t.Fatalf("baseline fixture migration count = %d, want %d", len(files), len(expectedCompatibilityBaselineNames))
	}
	runner := migrations.Runner{
		Beginner:  postgres.NewMigrationBeginner(conn),
		Directory: directory,
	}
	result, err := runner.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied != len(files) {
		t.Fatalf("canonical migrations applied = %d, want %d", result.Applied, len(files))
	}

	assertReviewed034FixtureHash(t)
	if _, err := conn.Exec(ctx, synthetic034MigrationSQL); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", migrations.ReleaseCompatibilityMigrationName, time.Date(2026, 9, 10, 1, 2, 3, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO users (id, github_login, display_name, kind, created_at)
		VALUES ('compat-user', 'compat-user', 'Compatibility User', 'human', $1)`, time.Date(2026, 9, 10, 1, 2, 3, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}

	isolatedDSN, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := isolatedDSN.Query()
	query.Set("search_path", schema)
	isolatedDSN.RawQuery = query.Encode()
	pool, err := postgres.OpenPool(ctx, isolatedDSN.String(), postgres.PoolOptions{MaxConnections: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	emoteRepository := workspaceemotes.NewPGRepository(pool)
	upsertSettings := func(enabledPackIDsJSON string, clickImageEmoteToSend, replyAutoMention bool, at time.Time) {
		t.Helper()
		if err := emoteRepository.WithTx(ctx, func(tx workspaceemotes.Tx) error {
			return tx.UpsertSettings(ctx, "compat-user", enabledPackIDsJSON, clickImageEmoteToSend, replyAutoMention, at)
		}); err != nil {
			t.Fatal(err)
		}
	}
	oldWriteAt := time.Date(2026, 9, 10, 1, 3, 0, 0, time.UTC)
	upsertSettings(`["legacy"]`, false, false, oldWriteAt)
	if _, err := conn.Exec(ctx, `
		UPDATE workspace_emote_preferences
		SET auto_hide_messages = TRUE, auto_hide_message_types_json = $2
		WHERE user_id = $1`, "compat-user", `["custom"]`); err != nil {
		t.Fatal(err)
	}
	newWriteAt := time.Date(2026, 9, 10, 1, 4, 0, 0, time.UTC)
	upsertSettings(`["updated-by-old-writer"]`, true, true, newWriteAt)
	settings, err := emoteRepository.GetSettings(ctx, "compat-user")
	if err != nil {
		t.Fatal(err)
	}
	if settings.EnabledPackIDsJSON != `["updated-by-old-writer"]` || !settings.ClickImageEmoteToSend || !settings.ReplyAutoMention {
		t.Fatalf("Go emotes repository did not update legacy settings: %#v", settings)
	}

	var autoHide bool
	var autoHideTypes string
	if err := conn.QueryRow(ctx, `
		SELECT auto_hide_messages, auto_hide_message_types_json
		FROM workspace_emote_preferences WHERE user_id = 'compat-user'`).Scan(&autoHide, &autoHideTypes); err != nil {
		t.Fatal(err)
	}
	if !autoHide || autoHideTypes != `["custom"]` {
		t.Fatalf("old writer changed 034 preferences: auto_hide=%v types=%q", autoHide, autoHideTypes)
	}

	before, err := readMigrationHistory(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	queryer := postgres.NewMigrationReadOnlyQueryer(pool)
	report, err := (migrations.SchemaChecker{
		Queryer:                   queryer,
		Directory:                 directory,
		AllowReleaseCompatibility: true,
	}).Check(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if report.UnknownCount != 0 || report.CompatibleCount != 1 || report.AppliedCount != len(files)+1 {
		t.Fatalf("unexpected compatibility report: %#v", report)
	}
	after, err := readMigrationHistory(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("schema_migrations changed during compatibility check: before=%v after=%v", before, after)
	}
	var afterAutoHide bool
	var afterAutoHideTypes string
	if err := conn.QueryRow(ctx, `
		SELECT auto_hide_messages, auto_hide_message_types_json
		FROM workspace_emote_preferences WHERE user_id = 'compat-user'`).Scan(&afterAutoHide, &afterAutoHideTypes); err != nil {
		t.Fatal(err)
	}
	if afterAutoHide != autoHide || afterAutoHideTypes != autoHideTypes {
		t.Fatalf("compatibility check changed preference columns: before=(%v,%q) after=(%v,%q)", autoHide, autoHideTypes, afterAutoHide, afterAutoHideTypes)
	}
}

var expectedCompatibilityBaselineNames = []string{
	"001_initial.sql",
	"002_member_visibility.sql",
	"003_message_reactions.sql",
	"004_workspace_profiles.sql",
	"005_workspace_email_settings.sql",
	"006_workspace_email_jobs.sql",
	"007_profile_discovery_and_avatars.sql",
	"008_conversation_pinned_messages.sql",
	"009_workspace_ntfy.sql",
	"010_workspace_uploads_and_emotes.sql",
	"011_group_avatar_emoji.sql",
	"012_message_recall.sql",
	"013_emote_collections.sql",
	"014_message_hidden_states.sql",
	"015_workspace_emote_direct_send.sql",
	"016_workspace_agent_bots.sql",
	"017_echo_requirements.sql",
	"018_workspace_topics.sql",
	"019_workspace_interactions.sql",
	"020_workspace_agent_bot_gateway.sql",
	"021_echo_complete.sql",
	"022_workspace_topic_messages.sql",
	"023_workspace_unified_bot_cards.sql",
	"024_workspace_workflow_safety.sql",
	"025_workspace_content_addressed_storage.sql",
	"026_emote_collection_subscriptions.sql",
	"027_echo_release_broadcasts.sql",
	"028_workspace_reply_preferences.sql",
	"029_workspace_agent_bot_setup_sessions.sql",
	"030_workspace_event_notifications.sql",
	"031_workspace_presence_leases.sql",
	"032_workspace_storage_operator_runs.sql",
	"033_workspace_command_result_finalization.sql",
}

func assertCanonicalCompatibilityInventory(t *testing.T, directory string) []migrations.File {
	t.Helper()
	files, err := migrations.Discover(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != len(expectedCompatibilityBaselineNames) && len(files) != len(expectedCompatibilityBaselineNames)+1 {
		t.Fatalf("canonical migration count = %d, want %d or %d", len(files), len(expectedCompatibilityBaselineNames), len(expectedCompatibilityBaselineNames)+1)
	}
	for index, want := range expectedCompatibilityBaselineNames {
		if files[index].Name != want {
			t.Fatalf("canonical baseline migration[%d] = %q, want %q", index, files[index].Name, want)
		}
	}
	if len(files) == len(expectedCompatibilityBaselineNames)+1 {
		if files[len(expectedCompatibilityBaselineNames)].Name != migrations.ReleaseCompatibilityMigrationName {
			t.Fatalf("canonical future migration = %q, want %q", files[len(expectedCompatibilityBaselineNames)].Name, migrations.ReleaseCompatibilityMigrationName)
		}
		assertMigrationSHA256(t, files[len(expectedCompatibilityBaselineNames)].Path, migrations.ReleaseCompatibilityMigrationSHA256)
	}
	return files
}

func copyCanonicalCompatibilityBaseline(t *testing.T, files []migrations.File) string {
	t.Helper()
	directory := t.TempDir()
	for _, file := range files[:len(expectedCompatibilityBaselineNames)] {
		content, err := os.ReadFile(file.Path)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, file.Name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return directory
}

func assertReviewed034FixtureHash(t *testing.T) {
	t.Helper()
	digest := sha256.Sum256([]byte(synthetic034MigrationSQL))
	if got := fmt.Sprintf("%x", digest); got != migrations.ReleaseCompatibilityMigrationSHA256 {
		t.Fatalf("synthetic 034 SHA-256 = %s, want reviewed %s", got, migrations.ReleaseCompatibilityMigrationSHA256)
	}
}

func assertMigrationSHA256(t *testing.T, path, want string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	if got := fmt.Sprintf("%x", digest); got != want {
		t.Fatalf("migration %q SHA-256 = %s, want %s", path, got, want)
	}
}

// The fixture is intentionally outside the canonical migration directory. It
// is used only to synthesize a database that has already applied reviewed 034.
//
//go:embed testdata/034_workspace_chat_auto_hide.sql
var synthetic034MigrationSQL string

func verifyReadOnlyTransaction(t *testing.T, ctx context.Context, queryer migrations.Queryer, conn *pgx.Conn, schema string) {
	t.Helper()

	rows, err := queryer.Query(ctx, "SELECT current_setting('transaction_read_only')")
	if err != nil {
		t.Fatal("read-only transaction probe failed")
	}
	var mode string
	if !rows.Next() {
		rows.Close()
		t.Fatal("read-only transaction probe returned no row")
	}
	if err := rows.Scan(&mode); err != nil {
		rows.Close()
		t.Fatal("read-only transaction probe could not be scanned")
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal("read-only transaction probe returned an invalid result")
	}
	rows.Close()
	if mode != "on" {
		t.Fatalf("transaction_read_only = %q, want on", mode)
	}

	probeName := fmt.Sprintf("duallane_read_only_probe_%d", time.Now().UnixNano())
	probeIdentifier := pgx.Identifier{probeName}.Sanitize()
	probeRows, probeErr := queryer.Query(ctx, "CREATE TABLE "+probeIdentifier+" (id integer)")
	if probeRows != nil {
		// pgx can defer a server error until the result stream is consumed.
		for probeRows.Next() {
		}
		if probeErr == nil {
			probeErr = probeRows.Err()
		}
		probeRows.Close()
	}
	if probeErr == nil {
		t.Fatal("read-only transaction accepted DDL")
	}

	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM pg_class AS c
		JOIN pg_namespace AS n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2
	)`, schema, probeName).Scan(&exists); err != nil {
		t.Fatal("could not verify read-only DDL probe")
	}
	if exists {
		t.Fatal("read-only DDL probe created a relation")
	}
}

type migrationHistoryRow struct {
	Name      string
	AppliedAt time.Time
}

func readMigrationHistory(ctx context.Context, conn *pgx.Conn) ([]migrationHistoryRow, error) {
	rows, err := conn.Query(ctx, "SELECT name, applied_at FROM schema_migrations ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var history []migrationHistoryRow
	for rows.Next() {
		var row migrationHistoryRow
		if err := rows.Scan(&row.Name, &row.AppliedAt); err != nil {
			return nil, err
		}
		history = append(history, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return history, nil
}
