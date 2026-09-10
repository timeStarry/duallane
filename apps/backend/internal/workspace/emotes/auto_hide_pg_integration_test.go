//go:build postgres_integration

package emotes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGAutoHideSettingsUpgradeDefaultsIsolationAndAudit(t *testing.T) {
	fixture := newPGEmoteIntegrationFixture(t)
	owner := "usr_emote_owner"
	member := "usr_emote_member"

	// Rewind only this test schema to the pre-034 shape, then apply the actual
	// repository migration against an existing preference row.
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		ALTER TABLE workspace_emote_preferences
		  DROP COLUMN auto_hide_messages,
		  DROP COLUMN auto_hide_message_types_json
	`)
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO workspace_emote_preferences (
			user_id, enabled_pack_ids_json, click_image_emote_to_send, reply_auto_mention, updated_at
		) VALUES ($1, $2, FALSE, FALSE, $3)
	`, owner, `["emoji"]`, fixture.now)
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationPath := filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations/034_workspace_chat_auto_hide.sql")
	migrationSQL, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatalf("read canonical auto-hide migration %q: %v", migrationPath, err)
	}
	mustExecPGEmote(t, fixture.ctx, fixture.conn, string(migrationSQL))

	defaults, err := fixture.service.GetSettings(fixture.ctx, owner)
	if err != nil || defaults.AutoHideMessages || strings.Join(defaults.AutoHideMessageTypes, ",") != "image,emote,long" {
		t.Fatalf("owner defaults = %#v, %v", defaults, err)
	}
	memberDefaults, err := fixture.service.GetSettings(fixture.ctx, member)
	if err != nil || memberDefaults.AutoHideMessages || strings.Join(memberDefaults.AutoHideMessageTypes, ",") != "image,emote,long" {
		t.Fatalf("member defaults = %#v, %v", memberDefaults, err)
	}

	enabled := true
	duplicateTypes := []string{"image", "image", "long"}
	updated, err := fixture.service.UpdateSettings(fixture.ctx, owner, UpdateSettingsInput{
		AutoHideMessages: &enabled, AutoHideMessageTypes: &duplicateTypes,
	}, auth.RequestMeta{RequestID: "emote-auto-hide-partial"})
	if err != nil || !updated.AutoHideMessages || strings.Join(updated.AutoHideMessageTypes, ",") != "image,long" {
		t.Fatalf("normalized settings = %#v, %v", updated, err)
	}

	// A previous release writer updates only its legacy columns on conflict;
	// the new personal settings must survive that write unchanged.
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO workspace_emote_preferences (
			user_id, enabled_pack_ids_json, click_image_emote_to_send, reply_auto_mention, updated_at
		) VALUES ($1, $2, FALSE, TRUE, $3)
		ON CONFLICT (user_id) DO UPDATE SET
			enabled_pack_ids_json = EXCLUDED.enabled_pack_ids_json,
			click_image_emote_to_send = EXCLUDED.click_image_emote_to_send,
			reply_auto_mention = EXCLUDED.reply_auto_mention,
			updated_at = EXCLUDED.updated_at
	`, owner, `["bili"]`, fixture.now)
	legacyWriteSettings, err := fixture.service.GetSettings(fixture.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if legacyWriteSettings.AutoHideMessages != updated.AutoHideMessages ||
		strings.Join(legacyWriteSettings.AutoHideMessageTypes, ",") != "image,long" ||
		strings.Join(legacyWriteSettings.EnabledPackIDs, ",") != "bili" ||
		legacyWriteSettings.ClickImageEmoteToSend || !legacyWriteSettings.ReplyAutoMention {
		t.Fatalf("legacy ON CONFLICT changed settings = %#v", legacyWriteSettings)
	}

	emptyTypes := []string{}
	updated, err = fixture.service.UpdateSettings(fixture.ctx, owner, UpdateSettingsInput{
		AutoHideMessageTypes: &emptyTypes,
	}, auth.RequestMeta{RequestID: "emote-auto-hide-empty"})
	if err != nil || !updated.AutoHideMessages || updated.AutoHideMessageTypes == nil || len(updated.AutoHideMessageTypes) != 0 {
		t.Fatalf("empty categories = %#v, %v", updated, err)
	}

	disabled := false
	updated, err = fixture.service.UpdateSettings(fixture.ctx, owner, UpdateSettingsInput{
		AutoHideMessages: &disabled,
	}, auth.RequestMeta{RequestID: "emote-auto-hide-off"})
	if err != nil || updated.AutoHideMessages || updated.AutoHideMessageTypes == nil || len(updated.AutoHideMessageTypes) != 0 {
		t.Fatalf("disabled settings retained categories = %#v, %v", updated, err)
	}

	var storedEnabled bool
	var storedTypes string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT auto_hide_messages, auto_hide_message_types_json
		FROM workspace_emote_preferences WHERE user_id = $1
	`, owner).Scan(&storedEnabled, &storedTypes); err != nil {
		t.Fatal(err)
	}
	if storedEnabled || storedTypes != `[]` {
		t.Fatalf("stored auto-hide settings = enabled:%v types:%q", storedEnabled, storedTypes)
	}

	var auditActor, targetType, targetID, result string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT actor_user_id, target_type, target_id, result
		FROM audit_logs
		WHERE action = 'emote.settings.update' AND request_id = $1
	`, "emote-auto-hide-partial").Scan(&auditActor, &targetType, &targetID, &result); err != nil {
		t.Fatal(err)
	}
	if auditActor != owner || targetType != "user" || targetID != owner || result != "success" {
		t.Fatalf("settings audit = actor:%q target:%s/%s result:%q", auditActor, targetType, targetID, result)
	}

	var eventActor, eventTargetType, eventTargetID string
	var payloadJSON []byte
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT actor_user_id, target_type, target_id, payload_json
		FROM workspace_events
		WHERE type = 'emote.settings.updated' AND target_id = $1
		ORDER BY seq DESC LIMIT 1
	`, owner).Scan(&eventActor, &eventTargetType, &eventTargetID, &payloadJSON); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		t.Fatal(err)
	}
	if eventActor != owner || eventTargetType != "user" || eventTargetID != owner || len(payload) != 1 || payload["userId"] != owner {
		t.Fatalf("settings event = actor:%q target:%s/%s payload:%s", eventActor, eventTargetType, eventTargetID, payloadJSON)
	}
}

func TestPGAutoHideSettingsConcurrentFirstInsertPreservesPartialUpdates(t *testing.T) {
	fixture := newPGEmoteIntegrationFixture(t)
	owner := "usr_emote_owner"
	mustExecPGEmote(t, fixture.ctx, fixture.conn, "DELETE FROM workspace_emote_preferences WHERE user_id = $1", owner)

	enabled := true
	types := []string{"image"}
	errors := make(chan error, 2)
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		_, err := fixture.service.UpdateSettings(fixture.ctx, owner, UpdateSettingsInput{AutoHideMessages: &enabled}, auth.RequestMeta{RequestID: "emote-auto-hide-concurrent-master"})
		errors <- err
	}()
	go func() {
		defer wait.Done()
		_, err := fixture.service.UpdateSettings(fixture.ctx, owner, UpdateSettingsInput{AutoHideMessageTypes: &types}, auth.RequestMeta{RequestID: "emote-auto-hide-concurrent-types"})
		errors <- err
	}()
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}

	settings, err := fixture.service.GetSettings(fixture.ctx, owner)
	if err != nil || !settings.AutoHideMessages || strings.Join(settings.AutoHideMessageTypes, ",") != "image" {
		t.Fatalf("concurrent first insert settings = %#v, %v", settings, err)
	}
	if count := pgEmoteCount(t, fixture, "SELECT COUNT(*) FROM workspace_emote_preferences WHERE user_id = $1", owner); count != 1 {
		t.Fatalf("concurrent preference row count = %d", count)
	}
}
