package invites

import "time"

const DefaultSpaceID = "spc_default"

type CreateInput struct {
	ActorID        string
	DefaultRole    string
	Code           string
	MaxUses        int
	ExpiresAt      string
	ExpiresInHours int64
	Meta           RequestMeta
}

type RevokeInput struct {
	ActorID  string
	InviteID string
	Meta     RequestMeta
}

type Invite struct {
	ID          string  `json:"id"`
	Code        string  `json:"code"`
	CodePreview string  `json:"codePreview"`
	DefaultRole string  `json:"defaultRole"`
	MaxUses     int     `json:"maxUses"`
	Uses        int     `json:"uses"`
	ExpiresAt   *string `json:"expiresAt"`
	CreatedAt   string  `json:"createdAt"`
}

type RevokedInvite struct {
	ID        string `json:"id"`
	RevokedAt string `json:"revokedAt"`
}

type InviteRecord struct {
	ID          string
	SpaceID     string
	CodeHash    string
	CodePreview string
	DefaultRole string
	CreatedBy   string
	MaxUses     int
	Uses        int
	ExpiresAt   *time.Time
	RevokedAt   *time.Time
	CreatedAt   time.Time
}

type AuditInput struct {
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
