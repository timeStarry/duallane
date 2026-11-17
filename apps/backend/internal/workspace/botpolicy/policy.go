// Package botpolicy contains the versioned, independent access policy used by
// an Agent Bot. It deliberately does not know about HTTP, persistence, or actor
// records: callers must provide the already-resolved actor and membership facts.
package botpolicy

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

const Version = 2

const (
	AudienceOwnerOnly       = "owner_only"
	AudienceSpecifiedMember = "specified_members"
	AudienceSpaceMembers    = "space_members"
	AudienceCurrentMembers  = "current_members"
)

// Policy is the V2 policy stored in workspace_agent_bot_settings.access_policy.
// A nil policy is the legacy mode and must be handled by the owning service;
// this package never infers V2 permissions from legacy fields.
type Policy struct {
	Version   int             `json:"version"`
	Discovery DiscoveryPolicy `json:"discovery"`
	Direct    DirectPolicy    `json:"direct"`
	Groups    GroupPolicy     `json:"groups"`
}

type DiscoveryPolicy struct {
	Audience  string   `json:"audience"`
	MemberIDs []string `json:"memberIds,omitempty"`
}

type DirectPolicy struct {
	Audience  string   `json:"audience"`
	MemberIDs []string `json:"memberIds,omitempty"`
}

type GroupPolicy struct {
	Audience         string   `json:"audience"`
	MemberIDs        []string `json:"memberIds,omitempty"`
	AllowBotTriggers bool     `json:"allowBotTriggers"`
	AllowedBotIDs    []string `json:"allowedBotIds,omitempty"`
}

// Parse validates and normalizes a JSON policy without applying any legacy
// defaults. A nil result represents the legacy mode.
func Parse(raw []byte) (*Policy, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	var policy Policy
	if err := json.Unmarshal(raw, &policy); err != nil {
		return nil, fmt.Errorf("bot access policy: %w", err)
	}
	normalized, err := Normalize(policy)
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

// Normalize validates and returns a deterministic copy suitable for storage or
// comparison. It does not add permissions or derive fields from legacy config.
func Normalize(policy Policy) (Policy, error) {
	policy.Discovery.MemberIDs = normalizeIDs(policy.Discovery.MemberIDs)
	policy.Direct.MemberIDs = normalizeIDs(policy.Direct.MemberIDs)
	policy.Groups.MemberIDs = normalizeIDs(policy.Groups.MemberIDs)
	policy.Groups.AllowedBotIDs = normalizeIDs(policy.Groups.AllowedBotIDs)
	if err := Validate(policy); err != nil {
		return Policy{}, err
	}
	return policy, nil
}

func Validate(policy Policy) error {
	if policy.Version != Version {
		return fmt.Errorf("bot access policy version must be %d", Version)
	}
	if err := validateAudience(policy.Discovery.Audience, AudienceOwnerOnly, AudienceSpecifiedMember, AudienceSpaceMembers); err != nil {
		return fmt.Errorf("discovery: %w", err)
	}
	if err := validateAudience(policy.Direct.Audience, AudienceOwnerOnly, AudienceSpecifiedMember, AudienceSpaceMembers); err != nil {
		return fmt.Errorf("direct: %w", err)
	}
	if err := validateAudience(policy.Groups.Audience, AudienceOwnerOnly, AudienceSpecifiedMember, AudienceCurrentMembers); err != nil {
		return fmt.Errorf("groups: %w", err)
	}
	if err := validateAudienceIDs(policy.Discovery.Audience, policy.Discovery.MemberIDs); err != nil {
		return fmt.Errorf("discovery: %w", err)
	}
	if err := validateAudienceIDs(policy.Direct.Audience, policy.Direct.MemberIDs); err != nil {
		return fmt.Errorf("direct: %w", err)
	}
	if err := validateAudienceIDs(policy.Groups.Audience, policy.Groups.MemberIDs); err != nil {
		return fmt.Errorf("groups: %w", err)
	}
	if !policy.Groups.AllowBotTriggers && len(policy.Groups.AllowedBotIDs) != 0 {
		return fmt.Errorf("groups: allowedBotIds requires allowBotTriggers")
	}
	if err := validateIDs(policy.Groups.AllowedBotIDs, false); err != nil {
		return fmt.Errorf("groups: %w", err)
	}
	return nil
}

func AllowsDiscovery(policy Policy, subjectID string, isOwner bool, isSpaceMember bool) bool {
	return allows(policy.Discovery.Audience, policy.Discovery.MemberIDs, subjectID, isOwner, isSpaceMember, false)
}

func AllowsDirect(policy Policy, subjectID string, isOwner bool, isSpaceMember bool) bool {
	return allows(policy.Direct.Audience, policy.Direct.MemberIDs, subjectID, isOwner, isSpaceMember, false)
}

// AllowsHumanGroup reports whether an already-approved group member may invoke
// the Bot. Group admission and context grants remain separate service checks.
func AllowsHumanGroup(policy Policy, subjectID string, isOwner bool, isCurrentMember bool) bool {
	return allows(policy.Groups.Audience, policy.Groups.MemberIDs, subjectID, isOwner, isCurrentMember, false)
}

// AllowsBotGroup is deliberately independent from human group membership.
func AllowsBotGroup(policy Policy, botID string, isAllowedDirectly bool) bool {
	if !policy.Groups.AllowBotTriggers || !isAllowedDirectly {
		return false
	}
	return contains(policy.Groups.AllowedBotIDs, botID)
}

func allows(audience string, memberIDs []string, subjectID string, isOwner, isMember, _ bool) bool {
	subjectID = strings.TrimSpace(subjectID)
	switch audience {
	case AudienceOwnerOnly:
		return isOwner
	case AudienceSpecifiedMember:
		// The Bot owner is always retained as a principal. This is an explicit
		// V2 product invariant, not inheritance from another audience or from
		// legacy visibility fields. Callers still enforce the actor's active
		// space/group membership and Bot lifecycle state separately.
		return isOwner || (subjectID != "" && contains(memberIDs, subjectID))
	case AudienceSpaceMembers, AudienceCurrentMembers:
		return isMember
	default:
		return false
	}
}

func validateAudience(value string, allowed ...string) error {
	for _, item := range allowed {
		if value == item {
			return nil
		}
	}
	return fmt.Errorf("audience %q is invalid", value)
}

func validateAudienceIDs(audience string, ids []string) error {
	if audience != AudienceSpecifiedMember && len(ids) != 0 {
		return fmt.Errorf("memberIds is only valid for specified_members")
	}
	return validateIDs(ids, audience == AudienceSpecifiedMember)
}

func validateIDs(ids []string, required bool) error {
	if required && len(ids) == 0 {
		return fmt.Errorf("memberIds must not be empty for specified_members")
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || len(id) > 200 {
			return fmt.Errorf("member id is invalid")
		}
		if _, ok := seen[id]; ok {
			return fmt.Errorf("duplicate member id %q", id)
		}
		seen[id] = struct{}{}
	}
	return nil
}

func normalizeIDs(ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	result := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	sort.Strings(result)
	return result
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
