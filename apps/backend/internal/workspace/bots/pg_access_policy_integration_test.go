//go:build postgres_integration

package bots

import (
	"encoding/json"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botpolicy"
)

func TestPGBotAccessPolicyIsNullableAndVersioned(t *testing.T) {
	fixture := newPGBotIntegrationFixture(t)
	bot, err := fixture.service.Create(fixture.ctx, CreateInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, Name: "PG Access Policy Bot",
		Meta: auth.RequestMeta{RequestID: "pg-policy-create"},
	})
	if err != nil {
		t.Fatal(err)
	}

	var legacyValue []byte
	if err := fixture.pool.QueryRow(fixture.ctx,
		`SELECT access_policy FROM workspace_agent_bot_settings WHERE bot_id = $1`, bot.ID).Scan(&legacyValue); err != nil {
		t.Fatal(err)
	}
	if len(legacyValue) != 0 {
		t.Fatalf("new Bot access policy = %s; want SQL NULL", legacyValue)
	}

	policy := botpolicy.Policy{
		Version:   botpolicy.Version,
		Discovery: botpolicy.DiscoveryPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Direct:    botpolicy.DirectPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Groups:    botpolicy.GroupPolicy{Audience: botpolicy.AudienceCurrentMembers},
	}
	settings, err := fixture.service.UpdateSettings(fixture.ctx, UpdateSettingsInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID,
		AccessPolicy: &policy, Meta: auth.RequestMeta{RequestID: "pg-policy-enable"},
	})
	if err != nil || settings.AccessPolicy == nil || settings.AccessPolicy.Version != botpolicy.Version {
		t.Fatalf("enabled access policy = %#v, err=%v", settings.AccessPolicy, err)
	}

	var raw []byte
	if err := fixture.pool.QueryRow(fixture.ctx,
		`SELECT access_policy FROM workspace_agent_bot_settings WHERE bot_id = $1`, bot.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var stored botpolicy.Policy
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Version != botpolicy.Version || stored.Direct.Audience != botpolicy.AudienceOwnerOnly {
		t.Fatalf("stored policy = %#v", stored)
	}

	read, err := fixture.service.GetSettings(fixture.ctx, GetInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID,
	})
	if err != nil || read.AccessPolicy == nil || read.AccessPolicy.Groups.Audience != botpolicy.AudienceCurrentMembers {
		t.Fatalf("read policy = %#v, err=%v", read.AccessPolicy, err)
	}

	if _, err := fixture.service.UpdateSettings(fixture.ctx, UpdateSettingsInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID,
		Description: stringPtr("non-permission update"),
	}); err != nil {
		t.Fatalf("non-permission update after V2 = %v", err)
	}
	if _, err := fixture.service.UpdateSettings(fixture.ctx, UpdateSettingsInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID,
		AllowDirect: botBool(false),
	}); domainCode(err) != CodeBotInvalidSettings {
		t.Fatalf("legacy permission update after V2 = %v", err)
	}

	cleared, err := fixture.service.UpdateSettings(fixture.ctx, UpdateSettingsInput{
		ActorID: "usr_bot_owner", SpaceID: DefaultSpaceID, BotID: bot.ID,
		Patch: map[string]any{"accessPolicy": nil},
	})
	if err != nil || cleared.AccessPolicy != nil {
		t.Fatalf("cleared access policy = %#v, err=%v", cleared.AccessPolicy, err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx,
		`SELECT access_policy FROM workspace_agent_bot_settings WHERE bot_id = $1`, bot.ID).Scan(&legacyValue); err != nil {
		t.Fatal(err)
	}
	if len(legacyValue) != 0 {
		t.Fatalf("cleared access policy = %s; want SQL NULL", legacyValue)
	}
}
