package bots

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID = auth.DefaultSpaceID
	CustomBotMode  = "external_agent"

	BotStatusActive   = "active"
	BotStatusPaused   = "paused"
	BotStatusDeleting = "deleting"
	BotStatusDeleted  = "deleted"

	SetupStatusCreated      = "created"
	SetupStatusAwaitingUser = "awaiting_user"
	SetupStatusApproved     = "approved"
	SetupStatusExchanged    = "exchanged"
	SetupStatusDenied       = "denied"
	SetupStatusExpired      = "expired"
	SetupStatusRevoked      = "revoked"

	VisibilityPrivate         = "private"
	VisibilitySpecifiedMember = "specified_members"
	VisibilitySpaceMembers    = "space_members"
	VisibilityGroups          = "groups"

	ConversationDirectOnly   = "direct-only"
	ConversationGroupCapable = "group-capable"
	TriggerMentionOrCommand  = "mention-or-command"

	MaxBotNameCodePoints = 64
	MaxTokenExpiry       = 366 * 24 * time.Hour
	SetupSessionTTL      = 10 * time.Minute
	BotTokenPrefix       = "dl_bot_"
	BotTokenBytes        = 32

	ConnectionStatusDisconnected = "disconnected"
	ConnectionStatusConnected    = "connected"
	ConnectionStatusPaused       = "paused"
	ConnectionStatusRevoked      = "revoked"
)

var (
	BotScopeAllowlist = []string{
		"messages:read_trigger",
		"messages:read_context",
		"messages:send",
		"cards:write",
		"cards:act",
		"files:read_metadata",
		"files:read_preview",
		"files:read_content",
		"files:write",
		"commands:receive",
	}
	BotDefaultScopes = []string{"messages:read_trigger", "messages:send", "commands:receive"}
	ReservedBotNames = []string{
		"信标", "回声", "Beacon", "Echo", "DualLane", "usr_system_beacon",
		"usr_system_echo", "__duallane_beacon__", "__duallane_echo__",
	}
)

// RequestMeta is the canonical, content-free audit context shared by all
// Workspace domains. It is an alias rather than a second security model.
type RequestMeta = auth.RequestMeta

// Bot is the safe owner-facing projection. Bot credentials and the internal
// GitHub login are intentionally absent.
type Bot struct {
	ID                    string  `json:"id"`
	SpaceID               string  `json:"spaceId"`
	OwnerUserID           string  `json:"ownerUserId"`
	BotUserID             string  `json:"botUserId"`
	Mode                  string  `json:"mode"`
	Name                  string  `json:"name"`
	NameNormalized        string  `json:"nameNormalized"`
	VisibilityPolicy      string  `json:"visibilityPolicy"`
	ConversationPolicy    string  `json:"conversationPolicy"`
	TriggerPolicy         string  `json:"triggerPolicy"`
	Status                string  `json:"status"`
	Kind                  string  `json:"kind"`
	AuthenticationAllowed bool    `json:"authenticationAllowed"`
	CanJoinGroups         bool    `json:"canJoinGroups"`
	TokenPolicy           string  `json:"tokenPolicy"`
	CreatedAt             string  `json:"createdAt"`
	UpdatedAt             string  `json:"updatedAt"`
	DeletingAt            *string `json:"deletingAt"`
	DeletedAt             *string `json:"deletedAt"`
}

// BotConnection is the owner-facing connection projection. It deliberately
// contains no connection nonce, token, socket handle, or adapter credential.
// The optional testedAt field is populated only by the connection test
// operation, matching the Node owner API response shape.
type BotConnection struct {
	ID              string  `json:"id"`
	BotID           string  `json:"botId"`
	SpaceID         string  `json:"spaceId"`
	Status          string  `json:"status"`
	AdapterVersion  *string `json:"adapterVersion"`
	ConnectedAt     *string `json:"connectedAt"`
	DisconnectedAt  *string `json:"disconnectedAt"`
	LastHeartbeatAt *string `json:"lastHeartbeatAt"`
	LastProcessedAt *string `json:"lastProcessedAt"`
	LastErrorCode   *string `json:"lastErrorCode"`
	LastErrorAt     *string `json:"lastErrorAt"`
	UpdatedAt       string  `json:"updatedAt"`
	TestedAt        string  `json:"testedAt,omitempty"`
}

// ConnectionRecord is the typed provider boundary for the existing gateway
// connection projection. It intentionally has no nonce or secret fields; the
// gateway runtime retains ownership of those values and of WebSocket
// registration/cleanup.
type ConnectionRecord struct {
	ID              string
	BotID           string
	SpaceID         string
	Status          string
	AdapterVersion  *string
	ConnectedAt     *time.Time
	DisconnectedAt  *time.Time
	LastHeartbeatAt *time.Time
	LastProcessedAt *time.Time
	LastErrorCode   *string
	LastErrorAt     *time.Time
	UpdatedAt       time.Time
}

// BotRecord is an internal storage projection. GithubLogin is only used to
// populate content-free audit metadata and never appears in Bot.
type BotRecord struct {
	ID                 string
	SpaceID            string
	OwnerUserID        string
	BotUserID          string
	Mode               string
	Name               string
	NameNormalized     string
	VisibilityPolicy   string
	ConversationPolicy string
	TriggerPolicy      string
	Status             string
	GithubLogin        string
	CreatedAt          time.Time
	UpdatedAt          time.Time
	DeletingAt         *time.Time
	DeletedAt          *time.Time
}

type Limits struct {
	RequestsPerMinute   int `json:"requestsPerMinute"`
	MemberDailyRequests int `json:"memberDailyRequests"`
	InputTokenLimit     int `json:"inputTokenLimit"`
	OutputTokenLimit    int `json:"outputTokenLimit"`
	MaxConcurrency      int `json:"maxConcurrency"`
	EventBacklogLimit   int `json:"eventBacklogLimit"`
}

type ContextSettings struct {
	MaxMessages               int  `json:"maxMessages"`
	MaxChars                  int  `json:"maxChars"`
	MaxTokens                 int  `json:"maxTokens"`
	WindowSeconds             int  `json:"windowSeconds"`
	IncludeReplies            bool `json:"includeReplies"`
	IncludeSystemEvents       bool `json:"includeSystemEvents"`
	IncludeAttachmentMetadata bool `json:"includeAttachmentMetadata"`
	AllowAttachmentPreview    bool `json:"allowAttachmentPreview"`
	LongTermSummaryEnabled    bool `json:"longTermSummaryEnabled"`
}

type BotSettings struct {
	BotID                string          `json:"botId"`
	SpaceID              string          `json:"spaceId"`
	VisibilityPolicy     string          `json:"visibilityPolicy"`
	AllowDirect          bool            `json:"allowDirect"`
	AllowGroup           bool            `json:"allowGroup"`
	GroupInviterPolicy   string          `json:"groupInviterPolicy"`
	RequireOwnerApproval bool            `json:"requireOwnerApproval"`
	ProactiveEnabled     bool            `json:"proactiveEnabled"`
	TriggerPolicy        string          `json:"triggerPolicy"`
	WelcomeMessage       *string         `json:"welcomeMessage"`
	Description          *string         `json:"description"`
	AvatarURL            *string         `json:"avatarUrl"`
	ShowCreator          bool            `json:"showCreator"`
	AllowedMemberIDs     []string        `json:"allowedMemberIds"`
	Context              ContextSettings `json:"context"`
	Limits               Limits          `json:"limits"`
	UpdatedAt            string          `json:"updatedAt"`
}

type SettingsRecord struct {
	BotID                     string
	SpaceID                   string
	VisibilityPolicy          string
	AllowDirect               bool
	AllowGroup                bool
	GroupInviterPolicy        string
	RequireOwnerApproval      bool
	ProactiveEnabled          bool
	TriggerPolicy             string
	WelcomeMessage            *string
	Description               *string
	AvatarURL                 *string
	ShowCreator               bool
	MaxContextMessages        int
	MaxContextChars           int
	MaxContextTokens          int
	ContextWindowSeconds      int
	IncludeReplies            bool
	IncludeSystemEvents       bool
	IncludeAttachmentMetadata bool
	AllowAttachmentPreview    bool
	LongTermSummaryEnabled    bool
	AllowedMemberIDs          []string
	Limits                    Limits
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

type GroupPolicy struct {
	ConversationID     string  `json:"conversationId"`
	Status             string  `json:"status"`
	InvitedBy          *string `json:"invitedBy"`
	ApprovedBy         *string `json:"approvedBy"`
	MaxContextMessages *int    `json:"maxContextMessages"`
	CreatedAt          string  `json:"createdAt"`
	UpdatedAt          string  `json:"updatedAt"`
	GrantID            *string `json:"grantId"`
	AllowTrigger       bool    `json:"allowTrigger"`
	AllowContext       bool    `json:"allowContext"`
	ContextMaxMessages *int    `json:"contextMaxMessages"`
}

type GroupPolicyRecord struct {
	BotID              string
	SpaceID            string
	ConversationID     string
	Status             string
	InvitedBy          *string
	ApprovedBy         *string
	MaxContextMessages *int
	CreatedAt          time.Time
	UpdatedAt          time.Time
	GrantID            *string
	AllowTrigger       bool
	AllowContext       bool
	ContextMaxMessages *int
}

type ContextGrant struct {
	GrantID        string  `json:"grantId"`
	BotID          string  `json:"botId"`
	ConversationID string  `json:"conversationId"`
	AllowTrigger   bool    `json:"allowTrigger"`
	AllowContext   bool    `json:"allowContext"`
	MaxMessages    *int    `json:"maxMessages"`
	GrantedBy      *string `json:"grantedBy"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
}

type ContextGrantRecord struct {
	GrantID        string
	BotID          string
	SpaceID        string
	ConversationID string
	AllowTrigger   bool
	AllowContext   bool
	MaxMessages    *int
	GrantedBy      *string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type TokenRecord struct {
	ID         string
	BotID      string
	SpaceID    string
	TokenHash  string
	Scopes     []string
	ExpiresAt  *time.Time
	RevokedAt  *time.Time
	LastUsedAt *time.Time
	CreatedAt  time.Time
}

type Token struct {
	ID         string   `json:"id"`
	BotID      string   `json:"botId"`
	Scopes     []string `json:"scopes"`
	ExpiresAt  *string  `json:"expiresAt"`
	RevokedAt  *string  `json:"revokedAt"`
	LastUsedAt *string  `json:"lastUsedAt"`
	CreatedAt  string   `json:"createdAt"`
	Token      string   `json:"token,omitempty"`
}

type TokenAuthRecord struct {
	Token TokenRecord
	Bot   BotRecord
}

type TokenIdentity struct {
	TokenID     string   `json:"tokenId"`
	Bot         Bot      `json:"bot"`
	BotID       string   `json:"botId"`
	UserID      string   `json:"userId"`
	SpaceID     string   `json:"spaceId"`
	OwnerUserID string   `json:"ownerUserId"`
	Scopes      []string `json:"scopes"`
	LastUsedAt  string   `json:"lastUsedAt"`
}

type SetupSessionRecord struct {
	ID                     string
	BotID                  string
	SpaceID                string
	OwnerUserID            string
	Status                 string
	RequestedScopes        []string
	ApprovedScopes         []string
	RequestedConversations []string
	ApprovedConversations  []string
	ClientName             *string
	ClientVersion          *string
	ProtocolVersion        string
	Capabilities           []string
	ExpiresAt              time.Time
	ApprovedAt             *time.Time
	ExchangedAt            *time.Time
	DeniedAt               *time.Time
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

type SetupSession struct {
	ID                     string    `json:"id"`
	Bot                    *SetupBot `json:"bot"`
	Status                 string    `json:"status"`
	RequestedScopes        []string  `json:"requestedScopes"`
	ApprovedScopes         []string  `json:"approvedScopes"`
	RequestedConversations []string  `json:"requestedConversations"`
	ApprovedConversations  []string  `json:"approvedConversations"`
	ClientName             *string   `json:"clientName"`
	ClientVersion          *string   `json:"clientVersion"`
	ProtocolVersion        string    `json:"protocolVersion"`
	Capabilities           []string  `json:"capabilities"`
	ExpiresAt              string    `json:"expiresAt"`
	ApprovedAt             *string   `json:"approvedAt"`
	ExchangedAt            *string   `json:"exchangedAt"`
	DeniedAt               *string   `json:"deniedAt"`
	CreatedAt              string    `json:"createdAt"`
	UpdatedAt              string    `json:"updatedAt"`
}

type SetupBot struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type GroupConversationRecord struct {
	ID       string
	Type     string
	IsMember bool
	Role     string
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

type CreateInput struct {
	ActorID string
	SpaceID string
	Name    string
	Meta    RequestMeta
}

type ListInput struct {
	ActorID string
	SpaceID string
	Meta    RequestMeta
}

type GetInput struct {
	ActorID string
	SpaceID string
	BotID   string
	Meta    RequestMeta
}

type ConnectionInput struct {
	ActorID string
	SpaceID string
	BotID   string
	Meta    RequestMeta
}

type ConnectionTestInput struct {
	ActorID string
	SpaceID string
	BotID   string
	Meta    RequestMeta
}

type UpdateSettingsInput struct {
	ActorID string
	SpaceID string
	BotID   string
	Meta    RequestMeta
	Patch   map[string]any

	VisibilityPolicy          *string
	AllowedMemberIDs          *[]string
	AllowDirect               *bool
	AllowGroup                *bool
	GroupInviterPolicy        *string
	RequireOwnerApproval      *bool
	ProactiveEnabled          *bool
	TriggerPolicy             *string
	WelcomeMessage            *string
	Description               *string
	AvatarURL                 *string
	ShowCreator               *bool
	MaxContextMessages        *int
	MaxContextChars           *int
	MaxContextTokens          *int
	ContextWindowSeconds      *int
	IncludeReplies            *bool
	IncludeSystemEvents       *bool
	IncludeAttachmentMetadata *bool
	AllowAttachmentPreview    *bool
	LongTermSummaryEnabled    *bool
}

type GroupPoliciesInput struct {
	ActorID string
	SpaceID string
	BotID   string
	Meta    RequestMeta
}

type UpdateGroupPolicyInput struct {
	ActorID        string
	SpaceID        string
	BotID          string
	ConversationID string
	Status         string
	AllowTrigger   *bool
	AllowContext   *bool
	MaxMessages    *int
	Meta           RequestMeta
}

type UpdateContextGrantInput struct {
	ActorID        string
	SpaceID        string
	BotID          string
	ConversationID string
	AllowTrigger   *bool
	AllowContext   *bool
	MaxMessages    *int
	Meta           RequestMeta
}

type TransitionInput struct {
	ActorID string
	SpaceID string
	BotID   string
	Meta    RequestMeta
}

type IssueTokenInput struct {
	ActorID   string
	SpaceID   string
	BotID     string
	Scopes    []string
	ExpiresAt string
	Meta      RequestMeta
}

type ListTokensInput struct {
	ActorID string
	SpaceID string
	BotID   string
	Meta    RequestMeta
}

type RevokeTokenInput struct {
	ActorID string
	SpaceID string
	BotID   string
	TokenID string
	Meta    RequestMeta
}

type CreateSetupSessionInput struct {
	ActorID         string
	SpaceID         string
	BotID           string
	RequestedScopes []string
	ConversationIDs []string
	Meta            RequestMeta
}

type GetSetupSessionInput struct {
	ActorID string
	SpaceID string
	SetupID string
	Meta    RequestMeta
}

type RequestSetupInput struct {
	SetupID         string
	RequestedScopes []string
	ConversationIDs []string
	ClientName      string
	ClientVersion   string
	ProtocolVersion string
	Capabilities    []string
	Meta            RequestMeta
}

type SetupStatusInput struct {
	SetupID string
	Meta    RequestMeta
}

type ApproveSetupInput struct {
	ActorID         string
	SpaceID         string
	SetupID         string
	Scopes          []string
	ConversationIDs []string
	Meta            RequestMeta
}

type DenySetupInput struct {
	ActorID string
	SpaceID string
	SetupID string
	Meta    RequestMeta
}

type ExchangeSetupInput struct {
	SetupID         string
	ClientName      string
	ClientVersion   string
	ProtocolVersion string
	Meta            RequestMeta
}

type AuthenticateOptions struct {
	SpaceID string
}

type IssuedToken struct {
	Token Token  `json:"tokenRecord"`
	Raw   string `json:"-"`
}

func (r BotRecord) Public() Bot {
	return Bot{
		ID: r.ID, SpaceID: r.SpaceID, OwnerUserID: r.OwnerUserID, BotUserID: r.BotUserID,
		Mode: r.Mode, Name: r.Name, NameNormalized: r.NameNormalized,
		VisibilityPolicy: r.VisibilityPolicy, ConversationPolicy: r.ConversationPolicy,
		TriggerPolicy: r.TriggerPolicy, Status: r.Status, Kind: "bot",
		AuthenticationAllowed: false, CanJoinGroups: r.ConversationPolicy == ConversationGroupCapable,
		TokenPolicy: "hashed-one-time", CreatedAt: formatTime(r.CreatedAt), UpdatedAt: formatTime(r.UpdatedAt),
		DeletingAt: formatOptionalTime(r.DeletingAt), DeletedAt: formatOptionalTime(r.DeletedAt),
	}
}

func (r ConnectionRecord) Public() BotConnection {
	return BotConnection{
		ID: r.ID, BotID: r.BotID, SpaceID: r.SpaceID, Status: r.Status,
		AdapterVersion: cloneString(r.AdapterVersion), ConnectedAt: formatOptionalTime(r.ConnectedAt),
		DisconnectedAt: formatOptionalTime(r.DisconnectedAt), LastHeartbeatAt: formatOptionalTime(r.LastHeartbeatAt),
		LastProcessedAt: formatOptionalTime(r.LastProcessedAt), LastErrorCode: cloneString(r.LastErrorCode),
		LastErrorAt: formatOptionalTime(r.LastErrorAt), UpdatedAt: formatTime(r.UpdatedAt),
	}
}

func (r SettingsRecord) Public() BotSettings {
	return BotSettings{
		BotID: r.BotID, SpaceID: r.SpaceID, VisibilityPolicy: r.VisibilityPolicy,
		AllowDirect: r.AllowDirect, AllowGroup: r.AllowGroup, GroupInviterPolicy: r.GroupInviterPolicy,
		RequireOwnerApproval: r.RequireOwnerApproval, ProactiveEnabled: r.ProactiveEnabled,
		TriggerPolicy: r.TriggerPolicy, WelcomeMessage: cloneString(r.WelcomeMessage), Description: cloneString(r.Description),
		AvatarURL: cloneString(r.AvatarURL), ShowCreator: r.ShowCreator, AllowedMemberIDs: cloneStrings(r.AllowedMemberIDs),
		Context: ContextSettings{MaxMessages: r.MaxContextMessages, MaxChars: r.MaxContextChars, MaxTokens: r.MaxContextTokens,
			WindowSeconds: r.ContextWindowSeconds, IncludeReplies: r.IncludeReplies, IncludeSystemEvents: r.IncludeSystemEvents,
			IncludeAttachmentMetadata: r.IncludeAttachmentMetadata, AllowAttachmentPreview: r.AllowAttachmentPreview,
			LongTermSummaryEnabled: r.LongTermSummaryEnabled},
		Limits: r.Limits, UpdatedAt: formatTime(r.UpdatedAt),
	}
}

func (r GroupPolicyRecord) Public() GroupPolicy {
	return GroupPolicy{ConversationID: r.ConversationID, Status: r.Status, InvitedBy: cloneString(r.InvitedBy),
		ApprovedBy: cloneString(r.ApprovedBy), MaxContextMessages: cloneInt(r.MaxContextMessages), CreatedAt: formatTime(r.CreatedAt),
		UpdatedAt: formatTime(r.UpdatedAt), GrantID: cloneString(r.GrantID), AllowTrigger: r.AllowTrigger,
		AllowContext: r.AllowContext, ContextMaxMessages: cloneInt(r.ContextMaxMessages)}
}

func (r ContextGrantRecord) Public() ContextGrant {
	return ContextGrant{GrantID: r.GrantID, BotID: r.BotID, ConversationID: r.ConversationID, AllowTrigger: r.AllowTrigger,
		AllowContext: r.AllowContext, MaxMessages: cloneInt(r.MaxMessages), GrantedBy: cloneString(r.GrantedBy),
		CreatedAt: formatTime(r.CreatedAt), UpdatedAt: formatTime(r.UpdatedAt)}
}

func (r TokenRecord) Public(mask string) Token {
	return Token{ID: r.ID, BotID: r.BotID, Scopes: cloneStrings(r.Scopes), ExpiresAt: formatOptionalTime(r.ExpiresAt),
		RevokedAt: formatOptionalTime(r.RevokedAt), LastUsedAt: formatOptionalTime(r.LastUsedAt), CreatedAt: formatTime(r.CreatedAt), Token: mask}
}

func (r SetupSessionRecord) Public(bot *BotRecord) SetupSession {
	var setupBot *SetupBot
	if bot != nil {
		setupBot = &SetupBot{ID: bot.ID, Name: bot.Name, Status: bot.Status}
	}
	return SetupSession{ID: r.ID, Bot: setupBot, Status: r.Status, RequestedScopes: cloneStrings(r.RequestedScopes),
		ApprovedScopes: cloneStrings(r.ApprovedScopes), RequestedConversations: cloneStrings(r.RequestedConversations),
		ApprovedConversations: cloneStrings(r.ApprovedConversations), ClientName: cloneString(r.ClientName), ClientVersion: cloneString(r.ClientVersion),
		ProtocolVersion: r.ProtocolVersion, Capabilities: cloneStrings(r.Capabilities), ExpiresAt: formatTime(r.ExpiresAt),
		ApprovedAt: formatOptionalTime(r.ApprovedAt), ExchangedAt: formatOptionalTime(r.ExchangedAt), DeniedAt: formatOptionalTime(r.DeniedAt),
		CreatedAt: formatTime(r.CreatedAt), UpdatedAt: formatTime(r.UpdatedAt)}
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func formatOptionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := formatTime(*value)
	return &formatted
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	return append([]string{}, values...)
}

func hashToken(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func parseJSONStrings(value string) []string {
	var result []string
	if json.Unmarshal([]byte(value), &result) != nil || result == nil {
		return []string{}
	}
	return result
}
