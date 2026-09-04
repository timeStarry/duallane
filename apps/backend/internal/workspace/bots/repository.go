package bots

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// ReadRepository is deliberately limited to Bot-owned projections and the
// authorization checks needed by the service. It exposes no general SQL
// escape hatch to callers.
type ReadRepository interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	GetBot(ctx context.Context, spaceID, botID string) (*BotRecord, error)
	GetBotAnySpace(ctx context.Context, botID string) (*BotRecord, error)
	GetBotByOwner(ctx context.Context, spaceID, ownerUserID string) (*BotRecord, error)
	ListBots(ctx context.Context, spaceID, ownerUserID string) ([]BotRecord, error)
	GetSettings(ctx context.Context, spaceID, botID string) (*SettingsRecord, error)
	ListGroupPolicies(ctx context.Context, spaceID, botID string) ([]GroupPolicyRecord, error)
	GetContextGrant(ctx context.Context, spaceID, botID, conversationID string) (*ContextGrantRecord, error)
	IsDirectConversation(ctx context.Context, spaceID, conversationID, ownerUserID, botUserID string) (bool, error)
	GetGroupManager(ctx context.Context, spaceID, conversationID, actorUserID string) (*GroupConversationRecord, error)
	ListTokens(ctx context.Context, spaceID, botID string) ([]TokenRecord, error)
	GetToken(ctx context.Context, spaceID, botID, tokenID string) (*TokenRecord, error)
	GetTokenByHash(ctx context.Context, tokenHash string) (*TokenAuthRecord, error)
	GetSetupSession(ctx context.Context, spaceID, setupID string) (*SetupSessionRecord, error)
	GetSetupSessionByID(ctx context.Context, setupID string) (*SetupSessionRecord, error)
}

type Repository interface {
	ReadRepository
	WithTx(ctx context.Context, callback func(Tx) error) error
}

// Tx is the write boundary. State changes, revocations, and their audit rows
// must use one transaction and a stable lifecycle lock.
type Tx interface {
	ReadRepository
	Lock(ctx context.Context, key string) error
	CreateBot(ctx context.Context, bot BotRecord, settings SettingsRecord) error
	UpdateSettings(ctx context.Context, spaceID, botID, visibilityPolicy, conversationPolicy string, settings SettingsRecord, at time.Time) error
	ReplaceVisibilityMembers(ctx context.Context, spaceID, botID string, userIDs []string, at time.Time) error
	UpsertGroupPolicy(ctx context.Context, policy GroupPolicyRecord) error
	UpsertContextGrant(ctx context.Context, grant ContextGrantRecord) error
	SetConversationMember(ctx context.Context, conversationID, botUserID string, active bool, at time.Time) error
	TransitionBot(ctx context.Context, spaceID, botID, ownerUserID, targetStatus string, fromStatuses []string, at time.Time) (*BotRecord, bool, error)
	RevokeBotTokens(ctx context.Context, botID string, at time.Time) error
	RevokePendingSetupSessions(ctx context.Context, botID string, at time.Time) (int64, error)
	RemoveBotMembership(ctx context.Context, spaceID, botUserID string, at time.Time) error
	InsertToken(ctx context.Context, token TokenRecord) error
	RevokeToken(ctx context.Context, spaceID, botID, tokenID string, at time.Time) (*TokenRecord, bool, error)
	MarkTokenUsed(ctx context.Context, tokenID, botID string, at time.Time) (bool, error)
	InsertSetupSession(ctx context.Context, session SetupSessionRecord) error
	UpdateSetupRequest(ctx context.Context, setupID string, expectedStatuses []string, requestedScopes, requestedConversations []string, clientName, clientVersion, protocolVersion string, capabilities []string, at time.Time) (bool, error)
	ApproveSetupSession(ctx context.Context, setupID string, expectedStatuses []string, approvedScopes, approvedConversations []string, at time.Time) (bool, error)
	DenySetupSession(ctx context.Context, setupID string, expectedStatuses []string, at time.Time) (bool, error)
	ExchangeSetupSession(ctx context.Context, setupID string, expectedStatuses []string, clientName, clientVersion, protocolVersion string, at time.Time) (bool, error)
	ExpireSetupSession(ctx context.Context, setupID string, expectedStatuses []string, at time.Time) (bool, error)
	WriteAudit(ctx context.Context, input AuditInput) error
}

var _ Repository = (*PGRepository)(nil)
