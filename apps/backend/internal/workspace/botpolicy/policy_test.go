package botpolicy

import (
	"encoding/json"
	"testing"
)

func validPolicy() Policy {
	return Policy{
		Version:   2,
		Discovery: DiscoveryPolicy{Audience: AudienceOwnerOnly},
		Direct:    DirectPolicy{Audience: AudienceOwnerOnly},
		Groups:    GroupPolicy{Audience: AudienceCurrentMembers},
	}
}

func TestNormalizeSortsAndDeduplicatesIDsWithoutGrantingAccess(t *testing.T) {
	policy := validPolicy()
	policy.Direct.Audience = AudienceSpecifiedMember
	policy.Direct.MemberIDs = []string{"usr_b", "usr_a", "usr_b"}
	normalized, err := Normalize(policy)
	if err != nil {
		t.Fatal(err)
	}
	if len(normalized.Direct.MemberIDs) != 2 || normalized.Direct.MemberIDs[0] != "usr_a" {
		t.Fatalf("normalized specified-member IDs = %#v", normalized.Direct.MemberIDs)
	}
	if AllowsDirect(normalized, "usr_c", false, true) {
		t.Fatal("space membership must not grant specified-member direct access")
	}
}

func TestIndependentAudiencesAndBotTriggers(t *testing.T) {
	policy := validPolicy()
	if AllowsDiscovery(policy, "usr_member", false, true) {
		t.Fatal("owner-only discovery must remain private")
	}
	if AllowsDirect(policy, "usr_member", false, true) {
		t.Fatal("owner-only direct policy must remain private")
	}
	if AllowsHumanGroup(policy, "usr_member", false, true) != true {
		t.Fatal("current member should be allowed in approved group")
	}
	policy.Discovery.Audience = AudienceSpaceMembers
	if !AllowsDiscovery(policy, "usr_member", false, true) {
		t.Fatal("space member should be discoverable when configured")
	}
	if AllowsBotGroup(policy, "bot_other", true) {
		t.Fatal("bot triggers are disabled by default")
	}
	policy.Groups.AllowBotTriggers = true
	policy.Groups.AllowedBotIDs = []string{"bot_other"}
	if !AllowsBotGroup(policy, "bot_other", true) || AllowsBotGroup(policy, "bot_other", false) {
		t.Fatal("bot source must be explicitly allowed and independently checked")
	}
}

func TestOwnerRetainsExplicitV2SpecifiedMemberAccess(t *testing.T) {
	policy := validPolicy()
	policy.Discovery.Audience = AudienceSpecifiedMember
	policy.Discovery.MemberIDs = []string{"usr_member"}
	policy.Direct.Audience = AudienceSpecifiedMember
	policy.Direct.MemberIDs = []string{"usr_member"}
	policy.Groups.Audience = AudienceSpecifiedMember
	policy.Groups.MemberIDs = []string{"usr_member"}

	if !AllowsDiscovery(policy, "usr_owner", true, false) {
		t.Fatal("owner must retain discovery when omitted from specified list")
	}
	if !AllowsDirect(policy, "usr_owner", true, false) {
		t.Fatal("owner must retain direct access when omitted from specified list")
	}
	if !AllowsHumanGroup(policy, "usr_owner", true, false) {
		t.Fatal("owner must not be locked out by specified group list")
	}
	if AllowsDirect(policy, "usr_other", false, true) {
		t.Fatal("space membership must not expand specified direct access")
	}
}

func TestValidateRejectsUnknownAndImplicitBotAccess(t *testing.T) {
	policy := validPolicy()
	policy.Version = 1
	if err := Validate(policy); err == nil {
		t.Fatal("expected version rejection")
	}
	policy = validPolicy()
	policy.Direct.Audience = AudienceSpecifiedMember
	if err := Validate(policy); err == nil {
		t.Fatal("expected empty specified-member rejection")
	}
	policy = validPolicy()
	policy.Groups.MemberIDs = []string{"usr_other"}
	if err := Validate(policy); err == nil {
		t.Fatal("expected member IDs to be rejected for current_members")
	}
	policy = validPolicy()
	policy.Groups.AllowedBotIDs = []string{"bot_other"}
	if err := Validate(policy); err == nil {
		t.Fatal("expected bot allowlist rejection when triggers are disabled")
	}
}

func TestParseNullIsLegacyAndJSONRoundTrip(t *testing.T) {
	policy, err := Parse([]byte("null"))
	if err != nil || policy != nil {
		t.Fatalf("null parse = %#v, %v; want nil legacy policy", policy, err)
	}
	original := validPolicy()
	raw, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Version != Version || parsed.Direct.Audience != AudienceOwnerOnly {
		t.Fatalf("round-trip policy = %#v", parsed)
	}
}
