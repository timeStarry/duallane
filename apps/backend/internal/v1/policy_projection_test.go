package v1

import (
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/botaccess"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botpolicy"
)

func TestV1BotProjectionUsesV2DirectPolicyInsteadOfLegacyVisibility(t *testing.T) {
	policy := botpolicy.Policy{
		Version:   botpolicy.Version,
		Discovery: botpolicy.DiscoveryPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Direct:    botpolicy.DirectPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Groups:    botpolicy.GroupPolicy{Audience: botpolicy.AudienceCurrentMembers},
	}
	access, err := botaccess.NewRecord("bot-v1", "space-v1", "owner-v1", "bot-user-v1", "active", "space_members", true, true, policy)
	if err != nil {
		t.Fatal(err)
	}
	if !access.DirectAllows("owner-v1", true, false) {
		t.Fatal("owner direct access should remain available")
	}
	if access.DirectAllows("human-v1", true, true) {
		t.Fatal("v1 projection must not use legacy space visibility for V2 direct access")
	}
	if !access.HumanGroupAllows("human-v1", true, true) {
		// This is intentionally a positive group assertion: V2 direct and group
		// audiences are independent even when the legacy field is public.
		t.Fatal("approved current group member should remain group-visible")
	}
}

func TestV1BotProjectionRejectsDisabledDirectForOwner(t *testing.T) {
	policy := botpolicy.Policy{
		Version:   botpolicy.Version,
		Discovery: botpolicy.DiscoveryPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Direct:    botpolicy.DirectPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Groups:    botpolicy.GroupPolicy{Audience: botpolicy.AudienceOwnerOnly},
	}
	access, err := botaccess.NewRecord("bot-v1", "space-v1", "owner-v1", "bot-user-v1", "active", "space_members", false, false, policy)
	if err != nil {
		t.Fatal(err)
	}
	if access.DirectAllows("owner-v1", true, false) {
		t.Fatal("allowDirect=false must not be bypassed in v1 summaries")
	}
}
