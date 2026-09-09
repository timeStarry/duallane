package members

import (
	"encoding/json"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID        = "spc_default"
	MemberVisibilityBasis = "direct_contacts"
	BeaconUserID          = "usr_system_beacon"
	EchoUserID            = "usr_system_echo"
)

const (
	RoleOwner   = "owner"
	RoleAdmin   = "admin"
	RoleMember  = "member"
	RoleAuditor = "auditor"
)

const (
	CapabilityConversationRead    = "conversation.read"
	CapabilityConversationDirect  = "conversation.create_direct"
	CapabilityConversationGroup   = "conversation.create_group"
	CapabilityConversationMembers = "conversation.member.manage"
	CapabilityMessageCreate       = "message.create"
	CapabilityFileUpload          = "file.upload"
	CapabilityFileDownload        = "file.download"
	CapabilityVisibilityManage    = "member.visibility.manage"
	CapabilityRoleUpdate          = "member.role_update"
	CapabilityRemove              = "member.remove"
)

// MemberCapabilities are the server-derived actions that the current actor
// may perform against the projected member. They are not authorization input.
type MemberCapabilities struct {
	CanStartDirectConversation bool `json:"canStartDirectConversation"`
	CanJoinGroups              bool `json:"canJoinGroups"`
	CanManage                  bool `json:"canManage"`
}

// Member is the public member projection. Private identity columns such as
// email and github_id deliberately have no representation in this type.
type Member struct {
	ID                 string             `json:"id"`
	GitHubLogin        string             `json:"githubLogin,omitempty"`
	DisplayName        string             `json:"displayName"`
	Nickname           *string            `json:"nickname"`
	Remark             *string            `json:"remark,omitempty"`
	Description        string             `json:"description,omitempty"`
	AvatarURL          string             `json:"avatarUrl,omitempty"`
	SearchDiscoverable *bool              `json:"searchDiscoverable,omitempty"`
	RecallReason       string             `json:"recallReason,omitempty"`
	Kind               string             `json:"kind"`
	Role               string             `json:"role"`
	RoleLabel          string             `json:"roleLabel"`
	Capabilities       MemberCapabilities `json:"capabilities"`
	JoinedAt           string             `json:"joinedAt"`
}

// MarshalJSON preserves the legacy distinction between human profile fields
// and system/bot identity fields. In particular, a human always emits its
// nickname key, including an explicit null.
func (m Member) MarshalJSON() ([]byte, error) {
	wire := map[string]any{
		"id":           m.ID,
		"displayName":  m.DisplayName,
		"kind":         m.Kind,
		"role":         m.Role,
		"roleLabel":    m.RoleLabel,
		"capabilities": m.Capabilities,
		"joinedAt":     m.JoinedAt,
	}
	if m.Kind == "human" {
		wire["githubLogin"] = m.GitHubLogin
		wire["nickname"] = m.Nickname
		if m.Remark != nil {
			wire["remark"] = m.Remark
		}
		if m.Description != "" {
			wire["description"] = m.Description
		}
		if m.AvatarURL != "" {
			wire["avatarUrl"] = m.AvatarURL
		}
		if m.SearchDiscoverable != nil {
			wire["searchDiscoverable"] = m.SearchDiscoverable
		}
		if m.RecallReason != "" {
			wire["recallReason"] = m.RecallReason
		}
	} else {
		if m.Description != "" {
			wire["description"] = m.Description
		}
		if m.AvatarURL != "" {
			wire["avatarUrl"] = m.AvatarURL
		}
	}
	return json.Marshal(wire)
}

// MemberRecord is the storage projection used by the domain service. It may
// contain private columns and must never be returned directly by a transport.
type MemberRecord struct {
	ID                 string
	GitHubLogin        string
	DisplayName        string
	Description        string
	Nickname           *string
	Remark             *string
	AvatarURL          string
	SearchDiscoverable bool
	RecallReason       *string
	Kind               string
	Role               string
	JoinedAt           time.Time
	NormallyVisible    bool
}

type VisibilityRule struct {
	Basis            string   `json:"basis"`
	ViewerUserID     string   `json:"viewerUserId"`
	AutomaticUserIDs []string `json:"automaticUserIds"`
	GrantedUserIDs   []string `json:"grantedUserIds"`
	VisibleUserIDs   []string `json:"visibleUserIds"`
}

type RemoveResult struct {
	OK        bool   `json:"ok"`
	UserID    string `json:"userId"`
	RemovedAt string `json:"removedAt"`
}

type ListOptions struct {
	Query string
	Q     string
	Role  string
	Kind  string
	Limit int
}

type ListInput struct {
	ActorID string
	Options ListOptions
	Meta    auth.RequestMeta
}

type UpdateOwnProfileInput struct {
	ActorID               string
	Nickname              *string
	NicknameSet           bool
	SearchDiscoverable    *bool
	SearchDiscoverableSet bool
	RecallReason          *string
	RecallReasonSet       bool
	Meta                  auth.RequestMeta
}

type RemarkInput struct {
	ActorID string
	UserID  string
	Remark  string
	Meta    auth.RequestMeta
}

type VisibilityReadInput struct {
	ActorID      string
	ViewerUserID string
	Meta         auth.RequestMeta
}

type VisibilityInput struct {
	ActorID        string
	ViewerUserID   string
	VisibleUserIDs []string
	Meta           auth.RequestMeta
}

type RoleInput struct {
	ActorID string
	UserID  string
	Role    string
	Meta    auth.RequestMeta
}

type RemoveInput struct {
	ActorID string
	UserID  string
	Meta    auth.RequestMeta
}

type EventInput struct {
	ID          string
	SpaceID     string
	Type        string
	ActorID     string
	TargetType  string
	TargetID    string
	PayloadJSON []byte
	CreatedAt   time.Time
}

type AuditInput struct {
	ID               string
	SpaceID          string
	ActorUserID      string
	ActorGitHubLogin string
	Action           string
	TargetType       string
	TargetID         string
	Result           string
	Reason           string
	RequestID        string
	IPAddress        string
	UserAgent        string
	CreatedAt        time.Time
}
