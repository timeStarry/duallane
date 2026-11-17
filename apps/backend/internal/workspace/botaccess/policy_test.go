package botaccess

import (
	"encoding/json"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/botpolicy"
)

func v2Record(t *testing.T, policy botpolicy.Policy, allowDirect, allowGroup bool) Record {
	t.Helper()
	record, err := NewRecord("bot-1", "space-1", "owner-1", "bot-user-1", "active", "space_members", allowDirect, allowGroup, policyJSON(t, policy))
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func policyJSON(t *testing.T, policy botpolicy.Policy) []byte {
	t.Helper()
	value, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestV2DirectOwnerOnlyDoesNotUseLegacyVisibility(t *testing.T) {
	record := v2Record(t, botpolicy.Policy{
		Version:   botpolicy.Version,
		Discovery: botpolicy.DiscoveryPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Direct:    botpolicy.DirectPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Groups:    botpolicy.GroupPolicy{Audience: botpolicy.AudienceOwnerOnly},
	}, true, true)
	if !record.DirectAllows("owner-1", true, false) {
		t.Fatal("owner should retain direct access")
	}
	if record.DirectAllows("member-1", true, true) {
		t.Fatal("V2 owner-only direct access must not inherit legacy visibility")
	}
	if record.DiscoveryAllows("member-1", true, true) {
		t.Fatal("V2 owner-only discovery must not inherit legacy visibility")
	}
}

func TestV2AllowDirectFalseAlsoBlocksOwner(t *testing.T) {
	record := v2Record(t, botpolicy.Policy{
		Version:   botpolicy.Version,
		Discovery: botpolicy.DiscoveryPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Direct:    botpolicy.DirectPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Groups:    botpolicy.GroupPolicy{Audience: botpolicy.AudienceOwnerOnly},
	}, false, true)
	if record.DirectAllows("owner-1", true, false) {
		t.Fatal("allowDirect=false must not be bypassed by owner status")
	}
}

func TestV2GroupHumanAndBotAudiencesAreIndependent(t *testing.T) {
	record := v2Record(t, botpolicy.Policy{
		Version:   botpolicy.Version,
		Discovery: botpolicy.DiscoveryPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Direct:    botpolicy.DirectPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Groups: botpolicy.GroupPolicy{
			Audience:         botpolicy.AudienceCurrentMembers,
			AllowBotTriggers: true,
			AllowedBotIDs:    []string{"source-bot"},
		},
	}, true, true)
	if !record.HumanGroupAllows("member-1", true, true) {
		t.Fatal("approved current human member should invoke the bot")
	}
	if record.HumanGroupAllows("member-1", false, true) {
		t.Fatal("group audience must require current membership")
	}
	if !record.BotTriggerAllows("source-bot", true) || record.BotTriggerAllows("other-bot", true) {
		t.Fatal("bot trigger allowlist must be independent and exact")
	}
}

func TestLegacyRecordKeepsLegacyVisibilitySemantics(t *testing.T) {
	record, err := NewRecord("bot-1", "space-1", "owner-1", "bot-user-1", "active", "specified_members", true, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if record.IsV2() || !record.DiscoveryAllows("member-1", false, true) {
		t.Fatal("legacy specified-member visibility should remain unchanged")
	}
	if !record.DirectAllows("member-1", false, true) {
		t.Fatal("legacy direct access should follow legacy visibility")
	}
	if !record.HumanGroupAllows("member-1", true, true, LegacyVisibilityFact{SubjectID: "member-1", Visible: true}) {
		t.Fatal("legacy approved group access should remain available")
	}
}

func TestLegacyGroupAndBotAccessFailsClosedWithoutExplicitFacts(t *testing.T) {
	specified, err := NewRecord("bot-specified", "space-1", "owner-1", "bot-user-1", "active", "specified_members", true, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if specified.HumanGroupAllows("member-1", false, true) {
		t.Fatal("legacy specified-member group access must not infer visibility")
	}
	if specified.HumanGroupAllows("member-2", true, true, LegacyVisibilityFact{SubjectID: "member-2", Visible: false}) {
		t.Fatal("legacy non-member must not invoke a specified-member Bot")
	}
	if specified.HumanGroupAllows("member-2", true, true, LegacyVisibilityFact{SubjectID: "member-1", Visible: true}) {
		t.Fatal("legacy specified-member fact must not bypass the member identity")
	}

	private, err := NewRecord("bot-private", "space-1", "owner-1", "bot-user-2", "active", "private", true, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if private.HumanGroupAllows("member-1", true, true) {
		t.Fatal("legacy private Bot must reject a non-owner in an approved group")
	}
	if private.DirectAllows("member-1", true, true) {
		t.Fatal("legacy private Bot must reject a non-owner direct conversation")
	}
	if private.BotTriggerAllows("source-bot", true) {
		t.Fatal("legacy Bot settings must not authorize Bot-to-Bot triggers")
	}
}

func TestInvalidExplicitPolicyFailsClosed(t *testing.T) {
	if _, err := NewRecord("bot-1", "space-1", "owner-1", "bot-user-1", "active", "space_members", true, true, []byte(`{"version":2,"direct":{"audience":"not-valid"}}`)); err == nil {
		t.Fatal("invalid explicit policy unexpectedly accepted")
	}
}
