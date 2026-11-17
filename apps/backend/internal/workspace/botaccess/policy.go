// Package botaccess is the shared read-side authorization adapter for Agent
// Bots. It resolves the nullable V2 policy once and keeps legacy behavior
// explicit at every call site; a NULL access_policy never becomes a V2 grant.
package botaccess

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botpolicy"
)

// Queryer is implemented by both *pgxpool.Pool and pgx.Tx. Keeping this seam
// narrow lets read projections use the same policy semantics inside and
// outside a mutation transaction.
type Queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// Record is the minimum bot/settings projection needed by directory, DM and
// group authorization. A nil Policy means legacy mode; callers must not infer
// V2 permissions from LegacyVisibilityPolicy in that case.
type Record struct {
	ID                     string
	SpaceID                string
	OwnerUserID            string
	BotUserID              string
	Status                 string
	LegacyVisibilityPolicy string
	AllowDirect            bool
	AllowGroup             bool
	Policy                 *botpolicy.Policy
}

// LegacyVisibilityFact carries the identity that a legacy visibility query
// actually authorized. A bare boolean is intentionally not accepted by
// HumanGroupAllows: otherwise a caller could accidentally apply a visibility
// result for one user to a different group member.
type LegacyVisibilityFact struct {
	SubjectID string
	Visible   bool
}

// IsV2 reports whether the row explicitly opted into the independent V2
// policy. It is intentionally not derived from any legacy settings column.
func (r Record) IsV2() bool { return r.Policy != nil }

func (r Record) IsActive() bool { return strings.EqualFold(strings.TrimSpace(r.Status), "active") }

// ParsePolicy decodes the nullable JSONB column. nil, empty and JSON null are
// legacy mode. Invalid non-null data fails closed so a corrupt policy cannot
// silently broaden access.
func ParsePolicy(raw []byte) (*botpolicy.Policy, error) {
	return botpolicy.Parse(raw)
}

// NewRecord constructs a normalized access record from the columns selected by
// the workspace repositories. rawPolicy may be nil, []byte, string or nil.
func NewRecord(id, spaceID, ownerUserID, botUserID, status, legacyVisibility string, allowDirect, allowGroup bool, rawPolicy any) (Record, error) {
	raw, err := policyBytes(rawPolicy)
	if err != nil {
		return Record{}, err
	}
	policy, err := ParsePolicy(raw)
	if err != nil {
		return Record{}, fmt.Errorf("parse bot %s access policy: %w", strings.TrimSpace(id), err)
	}
	return Record{
		ID:                     strings.TrimSpace(id),
		SpaceID:                strings.TrimSpace(spaceID),
		OwnerUserID:            strings.TrimSpace(ownerUserID),
		BotUserID:              strings.TrimSpace(botUserID),
		Status:                 strings.TrimSpace(status),
		LegacyVisibilityPolicy: strings.TrimSpace(legacyVisibility),
		AllowDirect:            allowDirect,
		AllowGroup:             allowGroup,
		Policy:                 policy,
	}, nil
}

// Load resolves one Agent Bot and its settings for a space.
func Load(ctx context.Context, q Queryer, spaceID, botID string) (Record, error) {
	if q == nil {
		return Record{}, errors.New("bot access queryer is required")
	}
	var (
		id, resolvedSpaceID, ownerID, botUserID, status, visibility string
		allowDirect, allowGroup                                     bool
		rawPolicy                                                   []byte
	)
	err := q.QueryRow(ctx, botAccessSelect+`WHERE b.space_id = $1 AND b.id = $2`, strings.TrimSpace(spaceID), strings.TrimSpace(botID)).Scan(
		&id, &resolvedSpaceID, &ownerID, &botUserID, &status, &visibility, &allowDirect, &allowGroup, &rawPolicy,
	)
	if err != nil {
		return Record{}, err
	}
	return NewRecord(id, resolvedSpaceID, ownerID, botUserID, status, visibility, allowDirect, allowGroup, rawPolicy)
}

// LoadByUserID resolves the Agent Bot represented by a bot user in a space.
func LoadByUserID(ctx context.Context, q Queryer, spaceID, botUserID string) (Record, error) {
	if q == nil {
		return Record{}, errors.New("bot access queryer is required")
	}
	var (
		id, resolvedSpaceID, ownerID, resolvedBotUserID, status, visibility string
		allowDirect, allowGroup                                             bool
		rawPolicy                                                           []byte
	)
	err := q.QueryRow(ctx, botAccessSelect+`WHERE b.space_id = $1 AND b.bot_user_id = $2 AND b.status <> 'deleted'`, strings.TrimSpace(spaceID), strings.TrimSpace(botUserID)).Scan(
		&id, &resolvedSpaceID, &ownerID, &resolvedBotUserID, &status, &visibility, &allowDirect, &allowGroup, &rawPolicy,
	)
	if err != nil {
		return Record{}, err
	}
	return NewRecord(id, resolvedSpaceID, ownerID, resolvedBotUserID, status, visibility, allowDirect, allowGroup, rawPolicy)
}

// DiscoveryAllows evaluates whether a human may discover the bot in a
// directory. legacyVisible is the already-resolved legacy visibility-member
// fact; it is ignored for V2.
func (r Record) DiscoveryAllows(subjectID string, isSpaceMember, legacyVisible bool) bool {
	if r.Policy != nil {
		return botpolicy.AllowsDiscovery(*r.Policy, strings.TrimSpace(subjectID), strings.TrimSpace(subjectID) != "" && strings.TrimSpace(subjectID) == r.OwnerUserID, isSpaceMember)
	}
	if strings.TrimSpace(subjectID) != "" && strings.TrimSpace(subjectID) == r.OwnerUserID {
		return true
	}
	switch strings.TrimSpace(r.LegacyVisibilityPolicy) {
	case "space", "space_members", "groups":
		return isSpaceMember
	case "specified_members":
		return legacyVisible
	default:
		return false
	}
}

// DirectAllows evaluates both lifecycle and the independent direct setting.
// In particular, owner status does not bypass AllowDirect=false.
func (r Record) DirectAllows(subjectID string, isSpaceMember, legacyVisible bool) bool {
	if !r.IsActive() || !r.AllowDirect {
		return false
	}
	if r.Policy != nil {
		return botpolicy.AllowsDirect(*r.Policy, strings.TrimSpace(subjectID), strings.TrimSpace(subjectID) != "" && strings.TrimSpace(subjectID) == r.OwnerUserID, isSpaceMember)
	}
	return r.DiscoveryAllows(subjectID, isSpaceMember, legacyVisible)
}

// HumanGroupAllows evaluates a human invoking a bot in an already-approved
// group. approved is the group-policy/context admission result and must remain
// separate from the audience policy. In legacy mode, legacyVisible contains
// the already-resolved visibility-member fact for specified_members and must
// identify the same subject. Omitting it is fail-closed.
func (r Record) HumanGroupAllows(subjectID string, isCurrentMember, approved bool, legacyVisible ...LegacyVisibilityFact) bool {
	if !r.IsActive() || !r.AllowGroup || !approved {
		return false
	}
	if r.Policy != nil {
		return botpolicy.AllowsHumanGroup(*r.Policy, strings.TrimSpace(subjectID), strings.TrimSpace(subjectID) != "" && strings.TrimSpace(subjectID) == r.OwnerUserID, isCurrentMember)
	}
	subjectID = strings.TrimSpace(subjectID)
	if subjectID != "" && subjectID == r.OwnerUserID {
		return true
	}
	switch strings.TrimSpace(r.LegacyVisibilityPolicy) {
	case "space", "space_members", "groups":
		return isCurrentMember
	case "specified_members":
		if !isCurrentMember {
			return false
		}
		for _, fact := range legacyVisible {
			if strings.TrimSpace(fact.SubjectID) == subjectID && fact.Visible {
				return true
			}
		}
		return false
	default:
		return false
	}
}

// BotTriggerAllows deliberately does not reuse human group membership. Bot
// sources must be listed by the V2 policy and separately approved by the
// group/task grant; this is the recursion boundary.
func (r Record) BotTriggerAllows(sourceBotID string, approved bool) bool {
	if !r.IsActive() || !r.AllowGroup || !approved {
		return false
	}
	if r.Policy != nil {
		return botpolicy.AllowsBotGroup(*r.Policy, strings.TrimSpace(sourceBotID), true)
	}
	// Legacy settings never carried an explicit Bot-to-Bot source allowlist.
	// Treating allow_group as one would create an implicit recursion channel.
	return false
}

const botAccessSelect = `SELECT
	b.id, b.space_id, b.owner_user_id, b.bot_user_id, b.status,
	COALESCE(bs.visibility_policy, b.visibility_policy, 'private'),
	COALESCE(bs.allow_direct = 1, TRUE),
	COALESCE(bs.allow_group = 1, FALSE),
	bs.access_policy
FROM workspace_agent_bots b
LEFT JOIN workspace_agent_bot_settings bs ON bs.bot_id = b.id AND bs.space_id = b.space_id
`

func policyBytes(value any) ([]byte, error) {
	switch raw := value.(type) {
	case nil:
		return nil, nil
	case []byte:
		return raw, nil
	case string:
		return []byte(raw), nil
	case json.RawMessage:
		return []byte(raw), nil
	case botpolicy.Policy:
		return json.Marshal(raw)
	case *botpolicy.Policy:
		if raw == nil {
			return nil, nil
		}
		return json.Marshal(raw)
	default:
		return nil, fmt.Errorf("unsupported access policy value %T", value)
	}
}

var _ = pgx.ErrNoRows
