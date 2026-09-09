//go:build postgres_integration

package events

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceConversations "github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

func TestPGMessageEventProjectionCarriesCurrentLatestMessageWindow(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_events_latest_window_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("clean latest-message projection schema: %v", err)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (migrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	seedRealtimeCatchupData(t, ctx, conn)
	mustExecCatchupPG(t, ctx, conn, `
		INSERT INTO message_hidden_states (user_id, message_id, hidden_at)
		VALUES ('usr_catchup_a', 'msg-catchup-20', $1)
	`, time.Date(2026, 9, 6, 12, 1, 0, 0, time.UTC))
	mustExecCatchupPG(t, ctx, conn, `
		UPDATE messages
		SET recalled_at = $1, recall_reason = '内容有误'
		WHERE id = 'msg-catchup-19'
	`, time.Date(2026, 9, 6, 12, 1, 30, 0, time.UTC))
	mustExecCatchupPG(t, ctx, conn, `
		INSERT INTO attachments (
			id, space_id, uploader_id, conversation_id, visibility, status,
			file_name, mime_type, byte_size, created_at, completed_at
		) VALUES (
			'att-catchup-21', 'spc_default', 'usr_catchup_b', 'conv-catchup',
			'conversation', 'available', 'catchup.txt', 'text/plain', 11, $1, $1
		)
	`, time.Date(2026, 9, 6, 12, 1, 45, 0, time.UTC))
	mustExecCatchupPG(t, ctx, conn, `
		INSERT INTO message_attachments (message_id, attachment_id)
		VALUES ('msg-catchup-21', 'att-catchup-21')
	`)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.MaxConns = 4
	poolConfig.MinConns = 0
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	repository := NewPGRepository(pool)
	service := NewService(ServiceOptions{
		Repository:  repository,
		BatchSize:   1,
		ReplayLimit: 1,
	})
	result, err := service.Replay(ctx, ReplayInput{ActorID: "usr_catchup_a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Events) != 1 {
		t.Fatalf("replay events = %d, want one first message event", len(result.Events))
	}
	conversation, ok := result.Events[0].Payload["conversation"].(map[string]any)
	if !ok {
		t.Fatalf("message event conversation projection = %#v", result.Events[0].Payload["conversation"])
	}
	latest, ok := conversation["latestMessages"].([]any)
	if !ok {
		t.Fatalf("latestMessages projection = %#v", conversation["latestMessages"])
	}
	if len(latest) != 20 {
		t.Fatalf("latestMessages count = %d, want 20", len(latest))
	}
	wantIDs := make([]string, 0, 20)
	for index := 9; index <= 28; index++ {
		wantIDs = append(wantIDs, fmt.Sprintf("msg-catchup-%02d", index))
	}
	gotIDs := make([]string, 0, len(latest))
	for _, value := range latest {
		message, ok := value.(map[string]any)
		if !ok {
			t.Fatalf("latest message projection = %#v", value)
		}
		id, ok := message["id"].(string)
		if !ok {
			t.Fatalf("latest message id = %#v", message["id"])
		}
		gotIDs = append(gotIDs, id)
		if _, leaked := message["eventSeq"]; leaked {
			t.Fatalf("latest message %s leaked event sequence", id)
		}
		if _, leaked := message["revision"]; leaked {
			t.Fatalf("latest message %s leaked revision", id)
		}
	}
	if !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Fatalf("latest message ids = %v, want %v", gotIDs, wantIDs)
	}
	hiddenMessage := latest[11].(map[string]any)
	if hiddenMessage["id"] != "msg-catchup-20" || hiddenMessage["hiddenByCurrentUser"] != true {
		t.Fatalf("viewer hidden state = %#v", hiddenMessage)
	}
	recalledMessage := latestCatchupMessage(t, latest, "msg-catchup-19")
	if recalledMessage["recalledAt"] == nil || recalledMessage["recallReason"] != "内容有误" || recalledMessage["plainText"] != "Catch-up A因内容有误撤回了一条消息" {
		t.Fatalf("viewer recalled message projection = %#v", recalledMessage)
	}
	if attachments, ok := recalledMessage["attachments"].([]any); !ok || len(attachments) != 0 {
		t.Fatalf("recalled message attachments = %#v, want empty", recalledMessage["attachments"])
	}
	if reactions, ok := recalledMessage["reactions"].([]any); !ok || len(reactions) != 0 {
		t.Fatalf("recalled message reactions = %#v, want empty", recalledMessage["reactions"])
	}
	attachmentMessage := latestCatchupMessage(t, latest, "msg-catchup-21")
	eventAttachments, ok := attachmentMessage["attachments"].([]any)
	if !ok || len(eventAttachments) != 1 {
		t.Fatalf("viewer attachment projection = %#v", attachmentMessage["attachments"])
	}
	eventAttachment, ok := eventAttachments[0].(map[string]any)
	if !ok {
		t.Fatalf("viewer attachment item = %#v", eventAttachments[0])
	}
	eventCapabilities, ok := eventAttachment["capabilities"].(map[string]any)
	if !ok || eventCapabilities["canDownload"] != true || eventCapabilities["canRemove"] != false {
		t.Fatalf("viewer attachment capabilities = %#v", eventAttachment["capabilities"])
	}
	if eventAttachment["uploaderId"] != "usr_catchup_b" || eventAttachment["uploaderName"] != "Catch-up B" {
		t.Fatalf("viewer attachment uploader projection = %#v", eventAttachment)
	}
	members, ok := conversation["members"].([]any)
	if !ok || len(members) != 2 {
		t.Fatalf("current conversation members = %#v", conversation["members"])
	}

	// The event conversation snapshot must have the same current, viewer-bound
	// latest window as the HTTP GetConversation projection. Compare transport
	// order and IDs directly, then compare the event-safe shape after applying
	// the same allowlist to the HTTP DTO. This catches regressions where the
	// realtime path returns an empty or stale window, or drops attachment
	// capabilities while the HTTP path remains correct.
	httpConversationReader := workspaceConversations.NewPGRepository(pool)
	httpMessageReader := workspaceMessages.NewPGRepository(pool)
	httpMessageReader.SetBuiltinEmoteSource(repository.builtinEmoteSource)
	httpConversationService := workspaceConversations.NewService(workspaceConversations.ServiceOptions{
		Repository:         httpConversationReader,
		SpaceID:            DefaultSpaceID,
		MessageShareReader: httpMessageReader,
	})
	httpConversation, err := httpConversationService.GetConversation(ctx, workspaceConversations.ConversationInput{
		ActorID:        "usr_catchup_a",
		ConversationID: "conv-catchup",
	})
	if err != nil {
		t.Fatal(err)
	}
	httpLatestJSON, err := json.Marshal(httpConversation.LatestMessages)
	if err != nil {
		t.Fatal(err)
	}
	var httpLatest []any
	if err := json.Unmarshal(httpLatestJSON, &httpLatest); err != nil {
		t.Fatal(err)
	}
	if httpIDs := latestCatchupMessageIDs(t, httpLatest); !reflect.DeepEqual(gotIDs, httpIDs) {
		t.Fatalf("event latest ids = %v, HTTP latest ids = %v", gotIDs, httpIDs)
	}
	httpConversationJSON, err := json.Marshal(httpConversation)
	if err != nil {
		t.Fatal(err)
	}
	var httpConversationMap map[string]any
	if err := json.Unmarshal(httpConversationJSON, &httpConversationMap); err != nil {
		t.Fatal(err)
	}
	httpSafeConversation, ok := safeConversation(httpConversationMap, "usr_catchup_a")
	if !ok {
		t.Fatal("HTTP conversation could not be projected into the event-safe shape")
	}
	httpSafeLatest, ok := httpSafeConversation["latestMessages"].([]any)
	if !ok || !reflect.DeepEqual(latest, httpSafeLatest) {
		t.Fatalf("event latest window differs from HTTP projection")
	}
	httpAttachmentMessage := latestCatchupMessage(t, httpSafeLatest, "msg-catchup-21")
	httpAttachments, ok := httpAttachmentMessage["attachments"].([]any)
	if !ok || len(httpAttachments) != 1 {
		t.Fatalf("HTTP attachment projection = %#v", httpAttachmentMessage["attachments"])
	}
	httpAttachment, ok := httpAttachments[0].(map[string]any)
	if !ok || !reflect.DeepEqual(eventAttachment, httpAttachment) {
		t.Fatalf("event attachment projection differs from HTTP projection")
	}

	// A different member removed after the event was stored must disappear from
	// the viewer's current conversation snapshot while historical messages stay
	// governed by the existing message projection rules.
	mustExecCatchupPG(t, ctx, conn, `
		UPDATE conversation_members
		SET removed_at = $1
		WHERE conversation_id = 'conv-catchup' AND user_id = 'usr_catchup_b'
	`, time.Date(2026, 9, 6, 12, 2, 0, 0, time.UTC))
	memberRemoved, err := service.Replay(ctx, ReplayInput{ActorID: "usr_catchup_a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(memberRemoved.Events) != 1 {
		t.Fatalf("replay after other-member removal = %d, want one visible event", len(memberRemoved.Events))
	}
	memberRemovedConversation, ok := memberRemoved.Events[0].Payload["conversation"].(map[string]any)
	if !ok {
		t.Fatalf("conversation after other-member removal = %#v", memberRemoved.Events[0].Payload["conversation"])
	}
	remainingMembers, ok := memberRemovedConversation["members"].([]any)
	if !ok || len(remainingMembers) != 1 {
		t.Fatalf("members after other-member removal = %#v", memberRemovedConversation["members"])
	}
	remainingMember, ok := remainingMembers[0].(map[string]any)
	if !ok || remainingMember["id"] != "usr_catchup_a" {
		t.Fatalf("remaining member projection = %#v", remainingMembers[0])
	}

	// A member removed after the event was stored must not be able to replay
	// its historical event or receive a newly hydrated conversation snapshot.
	mustExecCatchupPG(t, ctx, conn, `
		UPDATE conversation_members
		SET removed_at = $1
		WHERE conversation_id = 'conv-catchup' AND user_id = 'usr_catchup_a'
	`, time.Date(2026, 9, 6, 12, 2, 0, 0, time.UTC))
	removed, err := service.Replay(ctx, ReplayInput{ActorID: "usr_catchup_a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(removed.Events) != 0 {
		t.Fatalf("removed member replay events = %#v, want none", removed.Events)
	}
	// The actor snapshot held by a caller is not an authorization grant. Once
	// the current conversation membership is revoked, the same bounded read
	// used by event projection must omit the conversation, never return the old
	// viewer's latest messages.
	staleActor := &auth.Actor{ID: "usr_catchup_a", Kind: "human", Role: "owner", DisplayName: "stale snapshot"}
	if projected, err := repository.publicConversationPayload(ctx, DefaultSpaceID, staleActor, "conv-catchup"); err != nil || projected != nil {
		t.Fatal("revoked actor received a conversation latest-message projection")
	}
}

func latestCatchupMessage(t *testing.T, latest []any, wantedID string) map[string]any {
	t.Helper()
	for _, value := range latest {
		message, ok := value.(map[string]any)
		if ok && message["id"] == wantedID {
			return message
		}
	}
	t.Fatalf("latest message %s is missing", wantedID)
	return nil
}

func latestCatchupMessageIDs(t *testing.T, latest []any) []string {
	t.Helper()
	ids := make([]string, 0, len(latest))
	for _, value := range latest {
		message, ok := value.(map[string]any)
		if !ok {
			t.Fatalf("latest message projection = %#v", value)
		}
		id, ok := message["id"].(string)
		if !ok || id == "" {
			t.Fatalf("latest message id = %#v", message["id"])
		}
		ids = append(ids, id)
	}
	return ids
}
