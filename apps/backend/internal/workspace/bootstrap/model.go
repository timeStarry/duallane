package bootstrap

import (
	"encoding/json"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/members"
)

const (
	DefaultSpaceID        = "spc_default"
	MessageRetentionCount = 10000
)

type Space struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Slug      string `json:"slug"`
	CreatedBy string `json:"createdBy"`
	CreatedAt string `json:"createdAt"`
}

type SpaceRecord struct {
	ID        string
	Name      string
	Slug      string
	CreatedBy string
	CreatedAt time.Time
}

type InviteRecord struct {
	ID          string
	CodePreview string
	DefaultRole string
	MaxUses     int
	Uses        int
	ExpiresAt   *time.Time
	RevokedAt   *time.Time
	CreatedAt   time.Time
	Acceptances []InviteAcceptance
}

type InviteAcceptance struct {
	UserID     string
	AcceptedAt time.Time
}

type Invite struct {
	ID                  string           `json:"id"`
	CodePreview         string           `json:"codePreview"`
	DefaultRole         string           `json:"defaultRole"`
	MaxUses             int              `json:"maxUses"`
	Uses                int              `json:"uses"`
	ExpiresAt           *string          `json:"expiresAt"`
	RevokedAt           *string          `json:"revokedAt"`
	CreatedAt           string           `json:"createdAt"`
	AcceptedMemberCount int              `json:"acceptedMemberCount"`
	AcceptedMembers     []AcceptedMember `json:"acceptedMembers"`
}

// AcceptedMember flattens the existing public member projection and adds only
// the acceptance timestamp. It must never expose identity or audit columns.
type AcceptedMember struct {
	Member     members.Member
	AcceptedAt string
}

func (member AcceptedMember) MarshalJSON() ([]byte, error) {
	encoded, err := json.Marshal(member.Member)
	if err != nil {
		return nil, err
	}
	var projection map[string]any
	if err := json.Unmarshal(encoded, &projection); err != nil {
		return nil, err
	}
	projection["acceptedAt"] = member.AcceptedAt
	return json.Marshal(projection)
}

type InviteSummary struct {
	Total         int `json:"total"`
	Active        int `json:"active"`
	History       int `json:"history"`
	AcceptedUses  int `json:"acceptedUses"`
	AvailableUses int `json:"availableUses"`
}

type RepositorySnapshot struct {
	Space         SpaceRecord
	Invites       []InviteRecord
	InviteSummary InviteSummary
}

type Permissions struct {
	CanCreateMemberInvite     bool `json:"canCreateMemberInvite"`
	CanCreatePrivilegedInvite bool `json:"canCreatePrivilegedInvite"`
	CanManageMemberVisibility bool `json:"canManageMemberVisibility"`
	CanManageEmailSettings    bool `json:"canManageEmailSettings"`
	CanReadConversations      bool `json:"canReadConversations"`
	CanCreateGroup            bool `json:"canCreateGroup"`
	CanCreateDirect           bool `json:"canCreateDirect"`
	CanUpload                 bool `json:"canUpload"`
	CanDownload               bool `json:"canDownload"`
	CanViewOperationRecords   bool `json:"canViewOperationRecords"`
}

type Policy struct {
	DailyQuotaBytes       int64  `json:"dailyQuotaBytes"`
	UsedTodayBytes        int64  `json:"usedTodayBytes"`
	RemainingQuotaBytes   int64  `json:"remainingQuotaBytes"`
	MessageRetentionCount int    `json:"messageRetentionCount"`
	MemberVisibilityBasis string `json:"memberVisibilityBasis"`
}

type Auth struct {
	Mode        string         `json:"mode"`
	InviteOnly  bool           `json:"inviteOnly"`
	CurrentUser members.Member `json:"currentUser"`
}

type Bootstrap struct {
	AppVersion    string                       `json:"appVersion,omitempty"`
	Auth          Auth                         `json:"auth"`
	Space         Space                        `json:"space"`
	Policy        Policy                       `json:"policy"`
	Permissions   Permissions                  `json:"permissions"`
	Members       []members.Member             `json:"members"`
	Conversations []conversations.Conversation `json:"conversations"`
	Files         []files.Attachment           `json:"files"`
	Invites       []Invite                     `json:"invites"`
	InviteSummary InviteSummary                `json:"inviteSummary"`
	EventCursor   int64                        `json:"eventCursor"`
}
