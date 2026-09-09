package bots

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const testSpaceID = "spc_default"

type fakeState struct {
	actors       map[string]*auth.Actor
	bots         map[string]BotRecord
	settings     map[string]SettingsRecord
	connections  map[string]ConnectionRecord
	groups       map[string][]GroupPolicyRecord
	grants       map[string]ContextGrantRecord
	tokens       map[string]TokenRecord
	setups       map[string]SetupSessionRecord
	direct       map[string]bool
	groupMembers map[string]GroupConversationRecord
	members      map[string]bool
	audits       []AuditInput
	auditErr     error
}

type fakeRepository struct {
	mu    sync.Mutex
	state *fakeState
}

type fakeTx struct{ state *fakeState }

func newFakeRepository() *fakeRepository {
	return &fakeRepository{state: &fakeState{
		actors: map[string]*auth.Actor{
			"usr_owner":  {ID: "usr_owner", GitHubLogin: "owner", Kind: "human", Role: "owner"},
			"usr_member": {ID: "usr_member", GitHubLogin: "member", Kind: "human", Role: "member"},
		},
		bots:         map[string]BotRecord{},
		settings:     map[string]SettingsRecord{},
		connections:  map[string]ConnectionRecord{},
		groups:       map[string][]GroupPolicyRecord{},
		grants:       map[string]ContextGrantRecord{},
		tokens:       map[string]TokenRecord{},
		setups:       map[string]SetupSessionRecord{},
		direct:       map[string]bool{},
		groupMembers: map[string]GroupConversationRecord{},
		members:      map[string]bool{},
	}}
}

func (r *fakeRepository) WithTx(_ context.Context, callback func(Tx) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := cloneState(r.state)
	if err := callback(&fakeTx{state: copy}); err != nil {
		return err
	}
	r.state = copy
	return nil
}

func (r *fakeRepository) read(fn func(*fakeState) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return fn(r.state)
}

func (r *fakeRepository) LookupActor(_ context.Context, _, userID string) (*auth.Actor, error) {
	var result *auth.Actor
	err := r.read(func(state *fakeState) error {
		actor := state.actors[userID]
		if actor != nil {
			value := *actor
			result = &value
		}
		return nil
	})
	return result, err
}

func (tx *fakeTx) LookupActor(_ context.Context, _, userID string) (*auth.Actor, error) {
	actor := tx.state.actors[userID]
	if actor == nil {
		return nil, nil
	}
	value := *actor
	return &value, nil
}

func (r *fakeRepository) GetBot(_ context.Context, spaceID, botID string) (*BotRecord, error) {
	var result *BotRecord
	err := r.read(func(state *fakeState) error {
		value, ok := state.bots[botID]
		if ok {
			result = cloneBotPtr(&value)
		}
		if result != nil && result.SpaceID != spaceID {
			result = nil
		}
		return nil
	})
	return result, err
}

func (tx *fakeTx) GetBot(_ context.Context, spaceID, botID string) (*BotRecord, error) {
	value, ok := tx.state.bots[botID]
	if !ok {
		return nil, nil
	}
	result := cloneBotPtr(&value)
	if result != nil && result.SpaceID != spaceID {
		return nil, nil
	}
	return result, nil
}

func (r *fakeRepository) GetBotAnySpace(_ context.Context, botID string) (*BotRecord, error) {
	var result *BotRecord
	err := r.read(func(state *fakeState) error {
		value, ok := state.bots[botID]
		if ok {
			result = cloneBotPtr(&value)
		}
		return nil
	})
	return result, err
}

func (tx *fakeTx) GetBotAnySpace(_ context.Context, botID string) (*BotRecord, error) {
	value, ok := tx.state.bots[botID]
	if !ok {
		return nil, nil
	}
	return cloneBotPtr(&value), nil
}

func (r *fakeRepository) GetBotByOwner(_ context.Context, spaceID, ownerID string) (*BotRecord, error) {
	var result *BotRecord
	err := r.read(func(state *fakeState) error { result = findOwnerBot(state, spaceID, ownerID); return nil })
	return result, err
}

func (tx *fakeTx) GetBotByOwner(_ context.Context, spaceID, ownerID string) (*BotRecord, error) {
	return findOwnerBot(tx.state, spaceID, ownerID), nil
}

func connectionKey(botID, spaceID string) string { return botID + "\x00" + spaceID }

func (r *fakeRepository) GetConnection(_ context.Context, botID, spaceID string) (*ConnectionRecord, error) {
	var result *ConnectionRecord
	err := r.read(func(state *fakeState) error {
		key := connectionKey(botID, spaceID)
		value, ok := state.connections[key]
		if !ok {
			value = ConnectionRecord{ID: "bcon_" + botID, BotID: botID, SpaceID: spaceID, Status: ConnectionStatusDisconnected, UpdatedAt: time.Unix(0, 0).UTC()}
			state.connections[key] = value
		}
		result = cloneConnectionRecord(&value)
		return nil
	})
	return result, err
}

func (tx *fakeTx) GetConnection(_ context.Context, botID, spaceID string) (*ConnectionRecord, error) {
	key := connectionKey(botID, spaceID)
	value, ok := tx.state.connections[key]
	if !ok {
		value = ConnectionRecord{ID: "bcon_" + botID, BotID: botID, SpaceID: spaceID, Status: ConnectionStatusDisconnected, UpdatedAt: time.Unix(0, 0).UTC()}
		tx.state.connections[key] = value
	}
	return cloneConnectionRecord(&value), nil
}

func (tx *fakeTx) ClearConnectionErrors(ctx context.Context, botID, spaceID string, at time.Time) (*ConnectionRecord, error) {
	value, err := tx.GetConnection(ctx, botID, spaceID)
	if err != nil {
		return nil, err
	}
	value.LastErrorCode, value.LastErrorAt, value.UpdatedAt = nil, nil, at
	tx.state.connections[connectionKey(botID, spaceID)] = *value
	return cloneConnectionRecord(value), nil
}

func findOwnerBot(state *fakeState, spaceID, ownerID string) *BotRecord {
	var rows []BotRecord
	for _, bot := range state.bots {
		if bot.SpaceID == spaceID && bot.OwnerUserID == ownerID && bot.Status != BotStatusDeleted {
			rows = append(rows, cloneBot(bot))
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].CreatedAt.After(rows[j].CreatedAt) })
	if len(rows) == 0 {
		return nil
	}
	result := rows[0]
	return &result
}

func (r *fakeRepository) ListBots(_ context.Context, spaceID, ownerID string) ([]BotRecord, error) {
	var result []BotRecord
	err := r.read(func(state *fakeState) error { result = listBotsFromState(state, spaceID, ownerID); return nil })
	return result, err
}

func (tx *fakeTx) ListBots(_ context.Context, spaceID, ownerID string) ([]BotRecord, error) {
	return listBotsFromState(tx.state, spaceID, ownerID), nil
}

func listBotsFromState(state *fakeState, spaceID, ownerID string) []BotRecord {
	result := make([]BotRecord, 0)
	for _, bot := range state.bots {
		if bot.SpaceID == spaceID && bot.OwnerUserID == ownerID && bot.Status != BotStatusDeleted {
			result = append(result, cloneBot(bot))
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.Equal(result[j].CreatedAt) {
			return result[i].ID > result[j].ID
		}
		return result[i].CreatedAt.After(result[j].CreatedAt)
	})
	return result
}

func (r *fakeRepository) GetSettings(_ context.Context, spaceID, botID string) (*SettingsRecord, error) {
	var result *SettingsRecord
	err := r.read(func(state *fakeState) error {
		value, ok := state.settings[botID]
		if ok && value.SpaceID == spaceID {
			result = cloneSettingsPtr(&value)
		}
		return nil
	})
	return result, err
}

func (tx *fakeTx) GetSettings(_ context.Context, spaceID, botID string) (*SettingsRecord, error) {
	value, ok := tx.state.settings[botID]
	if !ok || value.SpaceID != spaceID {
		return nil, nil
	}
	return cloneSettingsPtr(&value), nil
}

func (r *fakeRepository) ListGroupPolicies(_ context.Context, spaceID, botID string) ([]GroupPolicyRecord, error) {
	var result []GroupPolicyRecord
	err := r.read(func(state *fakeState) error {
		result = cloneGroups(state.groups[botID])
		for i := range result {
			result[i].SpaceID = spaceID
		}
		return nil
	})
	return result, err
}

func (tx *fakeTx) ListGroupPolicies(_ context.Context, _, botID string) ([]GroupPolicyRecord, error) {
	return cloneGroups(tx.state.groups[botID]), nil
}

func (r *fakeRepository) GetContextGrant(_ context.Context, _, botID, conversationID string) (*ContextGrantRecord, error) {
	var result *ContextGrantRecord
	err := r.read(func(state *fakeState) error {
		for _, grant := range state.grants {
			if grant.BotID == botID && grant.ConversationID == conversationID {
				value := cloneGrant(grant)
				result = &value
				break
			}
		}
		return nil
	})
	return result, err
}

func (tx *fakeTx) GetContextGrant(_ context.Context, _, botID, conversationID string) (*ContextGrantRecord, error) {
	for _, grant := range tx.state.grants {
		if grant.BotID == botID && grant.ConversationID == conversationID {
			value := cloneGrant(grant)
			return &value, nil
		}
	}
	return nil, nil
}

func (r *fakeRepository) IsDirectConversation(_ context.Context, _, conversationID, _, _ string) (bool, error) {
	var result bool
	err := r.read(func(state *fakeState) error { result = state.direct[conversationID]; return nil })
	return result, err
}

func (tx *fakeTx) IsDirectConversation(_ context.Context, _, conversationID, _, _ string) (bool, error) {
	return tx.state.direct[conversationID], nil
}

func (r *fakeRepository) GetGroupManager(_ context.Context, _, conversationID, _ string) (*GroupConversationRecord, error) {
	var result *GroupConversationRecord
	err := r.read(func(state *fakeState) error {
		value, ok := state.groupMembers[conversationID]
		if ok {
			result = &value
		}
		return nil
	})
	return result, err
}

func (tx *fakeTx) GetGroupManager(_ context.Context, _, conversationID, _ string) (*GroupConversationRecord, error) {
	value, ok := tx.state.groupMembers[conversationID]
	if !ok {
		return nil, nil
	}
	return &value, nil
}

func (r *fakeRepository) ListTokens(_ context.Context, _, botID string) ([]TokenRecord, error) {
	var result []TokenRecord
	err := r.read(func(state *fakeState) error {
		for _, token := range state.tokens {
			if token.BotID == botID {
				result = append(result, cloneToken(token))
			}
		}
		sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.After(result[j].CreatedAt) })
		return nil
	})
	return result, err
}

func (tx *fakeTx) ListTokens(_ context.Context, _, botID string) ([]TokenRecord, error) {
	result := make([]TokenRecord, 0)
	for _, token := range tx.state.tokens {
		if token.BotID == botID {
			result = append(result, cloneToken(token))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.After(result[j].CreatedAt) })
	return result, nil
}

func (r *fakeRepository) GetToken(_ context.Context, _, botID, tokenID string) (*TokenRecord, error) {
	var result *TokenRecord
	err := r.read(func(state *fakeState) error {
		value, ok := state.tokens[tokenID]
		if ok && value.BotID == botID {
			copied := cloneToken(value)
			result = &copied
		}
		return nil
	})
	return result, err
}
func (tx *fakeTx) GetToken(_ context.Context, _, botID, tokenID string) (*TokenRecord, error) {
	value, ok := tx.state.tokens[tokenID]
	if !ok || value.BotID != botID {
		return nil, nil
	}
	copied := cloneToken(value)
	return &copied, nil
}

func (r *fakeRepository) GetTokenByHash(_ context.Context, tokenHash string) (*TokenAuthRecord, error) {
	var result *TokenAuthRecord
	err := r.read(func(state *fakeState) error { result = tokenAuthFromState(state, tokenHash); return nil })
	return result, err
}
func (tx *fakeTx) GetTokenByHash(_ context.Context, tokenHash string) (*TokenAuthRecord, error) {
	return tokenAuthFromState(tx.state, tokenHash), nil
}

func tokenAuthFromState(state *fakeState, tokenHash string) *TokenAuthRecord {
	for _, token := range state.tokens {
		if token.TokenHash == tokenHash {
			bot, ok := state.bots[token.BotID]
			if !ok {
				return nil
			}
			return &TokenAuthRecord{Token: cloneToken(token), Bot: cloneBot(bot)}
		}
	}
	return nil
}

func (r *fakeRepository) GetSetupSession(_ context.Context, spaceID, setupID string) (*SetupSessionRecord, error) {
	var result *SetupSessionRecord
	err := r.read(func(state *fakeState) error {
		value, ok := state.setups[setupID]
		if ok && value.SpaceID == spaceID {
			copied := cloneSetup(value)
			result = &copied
		}
		return nil
	})
	return result, err
}
func (tx *fakeTx) GetSetupSession(_ context.Context, spaceID, setupID string) (*SetupSessionRecord, error) {
	value, ok := tx.state.setups[setupID]
	if !ok || value.SpaceID != spaceID {
		return nil, nil
	}
	copied := cloneSetup(value)
	return &copied, nil
}
func (r *fakeRepository) GetSetupSessionByID(_ context.Context, setupID string) (*SetupSessionRecord, error) {
	var result *SetupSessionRecord
	err := r.read(func(state *fakeState) error {
		value, ok := state.setups[setupID]
		if ok {
			copied := cloneSetup(value)
			result = &copied
		}
		return nil
	})
	return result, err
}
func (tx *fakeTx) GetSetupSessionByID(_ context.Context, setupID string) (*SetupSessionRecord, error) {
	value, ok := tx.state.setups[setupID]
	if !ok {
		return nil, nil
	}
	copied := cloneSetup(value)
	return &copied, nil
}

func (tx *fakeTx) Lock(context.Context, string) error { return nil }

func (tx *fakeTx) CreateBot(_ context.Context, bot BotRecord, settings SettingsRecord) error {
	for _, current := range tx.state.bots {
		if current.SpaceID == bot.SpaceID && current.OwnerUserID == bot.OwnerUserID && current.Status != BotStatusDeleted {
			return errors.New("duplicate key")
		}
	}
	if _, ok := tx.state.bots[bot.ID]; ok {
		return errors.New("duplicate key")
	}
	tx.state.bots[bot.ID] = cloneBot(bot)
	tx.state.settings[bot.ID] = cloneSettings(settings)
	tx.state.members[bot.BotUserID] = true
	return nil
}

func (tx *fakeTx) UpdateSettings(_ context.Context, spaceID, botID, visibilityPolicy, conversationPolicy string, settings SettingsRecord, at time.Time) error {
	bot, ok := tx.state.bots[botID]
	if !ok || bot.SpaceID != spaceID {
		return errors.New("bot not found")
	}
	bot.VisibilityPolicy, bot.ConversationPolicy, bot.UpdatedAt = visibilityPolicy, conversationPolicy, at
	tx.state.bots[botID] = bot
	settings.BotID, settings.SpaceID, settings.VisibilityPolicy, settings.UpdatedAt = botID, spaceID, visibilityPolicy, at
	tx.state.settings[botID] = cloneSettings(settings)
	return nil
}

func (tx *fakeTx) ReplaceVisibilityMembers(_ context.Context, _, botID string, userIDs []string, _ time.Time) error {
	settings := tx.state.settings[botID]
	settings.AllowedMemberIDs = append([]string{}, userIDs...)
	tx.state.settings[botID] = settings
	return nil
}

func (tx *fakeTx) UpsertGroupPolicy(_ context.Context, policy GroupPolicyRecord) error {
	rows := tx.state.groups[policy.BotID]
	found := false
	for i := range rows {
		if rows[i].ConversationID == policy.ConversationID {
			policy.CreatedAt = rows[i].CreatedAt
			rows[i] = cloneGroup(policy)
			found = true
			break
		}
	}
	if !found {
		rows = append(rows, cloneGroup(policy))
	}
	tx.state.groups[policy.BotID] = rows
	return nil
}

func (tx *fakeTx) UpsertContextGrant(_ context.Context, grant ContextGrantRecord) error {
	for id, current := range tx.state.grants {
		if current.BotID == grant.BotID && current.ConversationID == grant.ConversationID {
			grant.CreatedAt = current.CreatedAt
			delete(tx.state.grants, id)
			break
		}
	}
	tx.state.grants[grant.GrantID] = cloneGrant(grant)
	return nil
}
func (tx *fakeTx) SetConversationMember(_ context.Context, _, botUserID string, active bool, _ time.Time) error {
	tx.state.members[botUserID] = active
	return nil
}

func (tx *fakeTx) TransitionBot(_ context.Context, _, botID, ownerID, target string, from []string, at time.Time) (*BotRecord, bool, error) {
	bot, ok := tx.state.bots[botID]
	if !ok || bot.OwnerUserID != ownerID {
		return nil, false, nil
	}
	if !contains(from, bot.Status) {
		copied := cloneBot(bot)
		return &copied, false, nil
	}
	bot.Status, bot.UpdatedAt = target, at
	if target == BotStatusDeleting {
		value := at
		bot.DeletingAt = &value
	}
	if target == BotStatusDeleted {
		value := at
		bot.DeletedAt = &value
	}
	tx.state.bots[botID] = bot
	copied := cloneBot(bot)
	return &copied, true, nil
}

func (tx *fakeTx) RevokeBotTokens(_ context.Context, botID string, at time.Time) error {
	for id, token := range tx.state.tokens {
		if token.BotID == botID && token.RevokedAt == nil {
			value := at
			token.RevokedAt = &value
			tx.state.tokens[id] = token
		}
	}
	return nil
}
func (tx *fakeTx) RevokePendingSetupSessions(_ context.Context, botID string, at time.Time) (int64, error) {
	var count int64
	for id, session := range tx.state.setups {
		if session.BotID == botID && (session.Status == SetupStatusCreated || session.Status == SetupStatusAwaitingUser || session.Status == SetupStatusApproved) {
			session.Status, session.UpdatedAt = SetupStatusRevoked, at
			tx.state.setups[id] = session
			count++
		}
	}
	return count, nil
}
func (tx *fakeTx) RemoveBotMembership(_ context.Context, _, botUserID string, _ time.Time) error {
	tx.state.members[botUserID] = false
	return nil
}
func (tx *fakeTx) InsertToken(_ context.Context, token TokenRecord) error {
	for _, current := range tx.state.tokens {
		if current.TokenHash == token.TokenHash || current.ID == token.ID {
			return errors.New("duplicate key")
		}
	}
	tx.state.tokens[token.ID] = cloneToken(token)
	return nil
}
func (tx *fakeTx) RevokeToken(_ context.Context, _, botID, tokenID string, at time.Time) (*TokenRecord, bool, error) {
	token, ok := tx.state.tokens[tokenID]
	if !ok || token.BotID != botID {
		return nil, false, nil
	}
	if token.RevokedAt == nil {
		value := at
		token.RevokedAt = &value
		tx.state.tokens[tokenID] = token
	}
	copied := cloneToken(token)
	return &copied, true, nil
}
func (tx *fakeTx) MarkTokenUsed(_ context.Context, tokenID, botID string, at time.Time) (bool, error) {
	token, ok := tx.state.tokens[tokenID]
	if !ok || token.BotID != botID || token.RevokedAt != nil || isExpired(token.ExpiresAt, at) {
		return false, nil
	}
	bot := tx.state.bots[botID]
	if bot.Status != BotStatusActive {
		return false, nil
	}
	token.LastUsedAt = &at
	tx.state.tokens[tokenID] = token
	return true, nil
}

func (tx *fakeTx) InsertSetupSession(_ context.Context, session SetupSessionRecord) error {
	if _, ok := tx.state.setups[session.ID]; ok {
		return errors.New("duplicate key")
	}
	tx.state.setups[session.ID] = cloneSetup(session)
	return nil
}
func (tx *fakeTx) UpdateSetupRequest(_ context.Context, setupID string, expected []string, scopes, conversations []string, clientName, clientVersion, protocol string, capabilities []string, at time.Time) (bool, error) {
	session, ok := tx.state.setups[setupID]
	if !ok || !contains(expected, session.Status) || !session.ExpiresAt.After(at) {
		return false, nil
	}
	session.Status, session.RequestedScopes, session.RequestedConversations, session.ProtocolVersion, session.Capabilities, session.UpdatedAt = SetupStatusAwaitingUser, append([]string{}, scopes...), append([]string{}, conversations...), protocol, append([]string{}, capabilities...), at
	if clientName != "" {
		session.ClientName = stringPtr(clientName)
	}
	if clientVersion != "" {
		session.ClientVersion = stringPtr(clientVersion)
	}
	tx.state.setups[setupID] = session
	return true, nil
}
func (tx *fakeTx) ApproveSetupSession(_ context.Context, setupID string, expected []string, scopes, conversations []string, at time.Time) (bool, error) {
	session, ok := tx.state.setups[setupID]
	if !ok || !contains(expected, session.Status) || !session.ExpiresAt.After(at) {
		return false, nil
	}
	session.Status, session.ApprovedScopes, session.ApprovedConversations, session.ApprovedAt, session.UpdatedAt = SetupStatusApproved, append([]string{}, scopes...), append([]string{}, conversations...), &at, at
	tx.state.setups[setupID] = session
	return true, nil
}
func (tx *fakeTx) DenySetupSession(_ context.Context, setupID string, expected []string, at time.Time) (bool, error) {
	session, ok := tx.state.setups[setupID]
	if !ok || !contains(expected, session.Status) || !session.ExpiresAt.After(at) {
		return false, nil
	}
	session.Status, session.DeniedAt, session.UpdatedAt = SetupStatusDenied, &at, at
	tx.state.setups[setupID] = session
	return true, nil
}
func (tx *fakeTx) ExchangeSetupSession(_ context.Context, setupID string, expected []string, clientName, clientVersion, protocol string, at time.Time) (bool, error) {
	session, ok := tx.state.setups[setupID]
	if !ok || !contains(expected, session.Status) {
		return false, nil
	}
	session.Status, session.ExchangedAt, session.ProtocolVersion, session.UpdatedAt = SetupStatusExchanged, &at, protocol, at
	if clientName != "" {
		session.ClientName = stringPtr(clientName)
	}
	if clientVersion != "" {
		session.ClientVersion = stringPtr(clientVersion)
	}
	tx.state.setups[setupID] = session
	return true, nil
}
func (tx *fakeTx) ExpireSetupSession(_ context.Context, setupID string, expected []string, at time.Time) (bool, error) {
	session, ok := tx.state.setups[setupID]
	if !ok || !contains(expected, session.Status) || session.ExpiresAt.After(at) {
		return false, nil
	}
	session.Status, session.UpdatedAt = SetupStatusExpired, at
	tx.state.setups[setupID] = session
	return true, nil
}
func (tx *fakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	if tx.state.auditErr != nil {
		return tx.state.auditErr
	}
	tx.state.audits = append(tx.state.audits, input)
	return nil
}

func cloneState(source *fakeState) *fakeState {
	result := &fakeState{actors: map[string]*auth.Actor{}, bots: map[string]BotRecord{}, settings: map[string]SettingsRecord{}, connections: map[string]ConnectionRecord{}, groups: map[string][]GroupPolicyRecord{}, grants: map[string]ContextGrantRecord{}, tokens: map[string]TokenRecord{}, setups: map[string]SetupSessionRecord{}, direct: map[string]bool{}, groupMembers: map[string]GroupConversationRecord{}, members: map[string]bool{}, audits: append([]AuditInput{}, source.audits...), auditErr: source.auditErr}
	for id, actor := range source.actors {
		copied := *actor
		result.actors[id] = &copied
	}
	for id, bot := range source.bots {
		result.bots[id] = cloneBot(bot)
	}
	for id, settings := range source.settings {
		result.settings[id] = cloneSettings(settings)
	}
	for id, connection := range source.connections {
		result.connections[id] = *cloneConnectionRecord(&connection)
	}
	for id, rows := range source.groups {
		result.groups[id] = cloneGroups(rows)
	}
	for id, grant := range source.grants {
		result.grants[id] = cloneGrant(grant)
	}
	for id, token := range source.tokens {
		result.tokens[id] = cloneToken(token)
	}
	for id, setup := range source.setups {
		result.setups[id] = cloneSetup(setup)
	}
	for id, value := range source.direct {
		result.direct[id] = value
	}
	for id, value := range source.groupMembers {
		result.groupMembers[id] = value
	}
	for id, value := range source.members {
		result.members[id] = value
	}
	return result
}

func cloneBot(value BotRecord) BotRecord {
	value.DeletingAt, value.DeletedAt = cloneTime(value.DeletingAt), cloneTime(value.DeletedAt)
	return value
}
func cloneBotPtr(value *BotRecord) *BotRecord {
	if value == nil {
		return nil
	}
	copied := cloneBot(*value)
	return &copied
}
func cloneSettings(value SettingsRecord) SettingsRecord {
	value.AllowedMemberIDs = append([]string{}, value.AllowedMemberIDs...)
	value.WelcomeMessage, value.Description, value.AvatarURL = cloneString(value.WelcomeMessage), cloneString(value.Description), cloneString(value.AvatarURL)
	return value
}
func cloneSettingsPtr(value *SettingsRecord) *SettingsRecord {
	if value == nil {
		return nil
	}
	copied := cloneSettings(*value)
	return &copied
}
func cloneGroup(value GroupPolicyRecord) GroupPolicyRecord {
	value.InvitedBy, value.ApprovedBy, value.GrantID = cloneString(value.InvitedBy), cloneString(value.ApprovedBy), cloneString(value.GrantID)
	value.MaxContextMessages, value.ContextMaxMessages = cloneInt(value.MaxContextMessages), cloneInt(value.ContextMaxMessages)
	return value
}
func cloneGroups(values []GroupPolicyRecord) []GroupPolicyRecord {
	result := make([]GroupPolicyRecord, 0, len(values))
	for _, value := range values {
		result = append(result, cloneGroup(value))
	}
	return result
}
func cloneGrant(value ContextGrantRecord) ContextGrantRecord {
	value.MaxMessages, value.GrantedBy = cloneInt(value.MaxMessages), cloneString(value.GrantedBy)
	return value
}
func cloneToken(value TokenRecord) TokenRecord {
	value.Scopes = append([]string{}, value.Scopes...)
	value.ExpiresAt, value.RevokedAt, value.LastUsedAt = cloneTime(value.ExpiresAt), cloneTime(value.RevokedAt), cloneTime(value.LastUsedAt)
	return value
}
func cloneSetup(value SetupSessionRecord) SetupSessionRecord {
	value.RequestedScopes, value.ApprovedScopes, value.RequestedConversations, value.ApprovedConversations, value.Capabilities = append([]string{}, value.RequestedScopes...), append([]string{}, value.ApprovedScopes...), append([]string{}, value.RequestedConversations...), append([]string{}, value.ApprovedConversations...), append([]string{}, value.Capabilities...)
	value.ClientName, value.ClientVersion, value.ApprovedAt, value.ExchangedAt, value.DeniedAt = cloneString(value.ClientName), cloneString(value.ClientVersion), cloneTime(value.ApprovedAt), cloneTime(value.ExchangedAt), cloneTime(value.DeniedAt)
	return value
}
func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

func testService(repo Repository, now *time.Time, sequence *atomic.Int64) *Service {
	return NewService(ServiceOptions{Repository: repo, SpaceID: testSpaceID, Now: func() time.Time { return *now }, IDFactory: func() (string, error) { return fmt.Sprintf("id-%016d", sequence.Add(1)), nil }, TokenFactory: func() (string, error) { return "", errors.New("test token factory not configured") }})
}

func testTokenFactory(values ...string) TokenFactory {
	var index atomic.Int64
	return func() (string, error) {
		current := int(index.Add(1) - 1)
		if current >= len(values) {
			return "", errors.New("token fixture exhausted")
		}
		return values[current], nil
	}
}

func domainCode(err error) string {
	var value *Error
	if errors.As(err, &value) {
		return value.Code
	}
	return ""
}

func TestBotLifecycleAndSafeProjections(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 4, 12, 0, 0, 123456789, time.UTC)
	var sequence atomic.Int64
	service := testService(repo, &now, &sequence)
	service.tokenFactory = testTokenFactory("dl_bot_"+strings.Repeat("A", 43), "dl_bot_"+strings.Repeat("B", 43))
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "  Agent Ｂot  ", Meta: RequestMeta{RequestID: "req-bot"}})
	if err != nil {
		t.Fatal(err)
	}
	if bot.Status != BotStatusActive || bot.Name != "Agent Bot" || bot.CreatedAt != "2026-09-04T12:00:00.123Z" || bot.DeletingAt != nil {
		t.Fatalf("bot = %#v", bot)
	}
	encoded, err := json.Marshal(bot)
	if err != nil || !strings.Contains(string(encoded), `"deletingAt":null`) || !strings.Contains(string(encoded), `"deletedAt":null`) {
		t.Fatalf("safe bot JSON = %s, %v", encoded, err)
	}

	issued, err := service.IssueToken(context.Background(), IssueTokenInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID})
	if err != nil {
		t.Fatal(err)
	}
	if issued.Raw == "" || issued.Token.Token != "" {
		t.Fatalf("issued token leaked in projection: %#v", issued)
	}
	if got := repo.state.tokens[issued.Token.ID].TokenHash; got == issued.Raw || got == "" {
		t.Fatalf("stored token hash = %q", got)
	}
	listed, err := service.ListTokens(context.Background(), ListTokensInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID})
	if err != nil || len(listed) != 1 || listed[0].Token != MaskBotToken() {
		t.Fatalf("listed = %#v, %v", listed, err)
	}
	identity, err := service.AuthenticateToken(context.Background(), issued.Raw, AuthenticateOptions{SpaceID: testSpaceID})
	if err != nil || identity.BotID != bot.ID || identity.LastUsedAt != "2026-09-04T12:00:00.123Z" {
		t.Fatalf("identity = %#v, %v", identity, err)
	}

	paused, err := service.Pause(context.Background(), TransitionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID})
	if err != nil || paused.Status != BotStatusPaused {
		t.Fatalf("paused = %#v, %v", paused, err)
	}
	if _, err := service.AuthenticateToken(context.Background(), issued.Raw, AuthenticateOptions{}); domainCode(err) != CodeBotInvalidToken {
		t.Fatalf("paused auth error = %v", err)
	}
	resumed, err := service.Resume(context.Background(), TransitionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID})
	if err != nil || resumed.Status != BotStatusActive {
		t.Fatalf("resumed = %#v, %v", resumed, err)
	}
	if _, err := service.RotateToken(context.Background(), IssueTokenInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AuthenticateToken(context.Background(), issued.Raw, AuthenticateOptions{}); domainCode(err) != CodeBotInvalidToken {
		t.Fatalf("rotated old token error = %v", err)
	}

	setup, err := service.CreateSetupSession(context.Background(), CreateSetupSessionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID, ConversationIDs: []string{"conv-direct"}})
	if err != nil || setup.Status != SetupStatusCreated || len(setup.RequestedScopes) != 3 || setup.ExpiresAt != "2026-09-04T12:10:00.123Z" {
		t.Fatalf("setup = %#v, %v", setup, err)
	}
	requested, err := service.RequestSetup(context.Background(), RequestSetupInput{SetupID: setup.ID, RequestedScopes: []string{"messages:send"}, ClientName: "agent/1", ProtocolVersion: "v1"})
	if err != nil || requested.Status != SetupStatusAwaitingUser {
		t.Fatalf("requested = %#v, %v", requested, err)
	}
	approved, err := service.ApproveSetupSession(context.Background(), ApproveSetupInput{ActorID: "usr_owner", SpaceID: testSpaceID, SetupID: setup.ID, Scopes: []string{"messages:send"}, ConversationIDs: []string{"conv-direct"}})
	if err != nil || approved.Status != SetupStatusApproved || len(approved.ApprovedScopes) != 1 {
		t.Fatalf("approved = %#v, %v", approved, err)
	}

	deleting, err := service.BeginDelete(context.Background(), TransitionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID})
	if err != nil || deleting.Status != BotStatusDeleting {
		t.Fatalf("deleting = %#v, %v", deleting, err)
	}
	if repo.state.setups[setup.ID].Status != SetupStatusRevoked {
		t.Fatalf("setup was not revoked: %#v", repo.state.setups[setup.ID])
	}
	deleted, err := service.FinalizeDelete(context.Background(), TransitionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID})
	if err != nil || deleted.Status != BotStatusDeleted || repo.state.members[bot.BotUserID] {
		t.Fatalf("deleted = %#v, member=%v, %v", deleted, repo.state.members[bot.BotUserID], err)
	}
	if len(repo.state.audits) < 7 {
		t.Fatalf("audits = %#v", repo.state.audits)
	}
}

func TestBotAuthorizationAndValidation(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 4, 12, 0, 0, 999999999, time.UTC)
	var sequence atomic.Int64
	service := testService(repo, &now, &sequence)
	if _, err := service.Create(context.Background(), CreateInput{ActorID: "unknown", SpaceID: testSpaceID, Name: "x"}); domainCode(err) != CodeAuthRequired {
		t.Fatalf("member create error = %v", err)
	}
	if _, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Echo"}); domainCode(err) != CodeBotReservedName {
		t.Fatalf("reserved name error = %v", err)
	}
	if _, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "\x00"}); domainCode(err) != CodeBotInvalidName {
		t.Fatalf("invalid name error = %v", err)
	}
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Owner Bot"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Second Bot"}); domainCode(err) != CodeBotAlreadyExists {
		t.Fatalf("duplicate error = %v", err)
	}
	if _, err := service.Get(context.Background(), GetInput{ActorID: "usr_member", SpaceID: testSpaceID, BotID: bot.ID}); domainCode(err) != CodePermissionDenied {
		t.Fatalf("foreign read error = %v", err)
	}
	if _, err := service.IssueToken(context.Background(), IssueTokenInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID, Scopes: []string{"owner:impersonate"}}); domainCode(err) != CodeBotInvalidScope {
		t.Fatalf("scope error = %v", err)
	}
	if _, err := service.UpdateSettings(context.Background(), UpdateSettingsInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID, Patch: map[string]any{"unknown": true}}); domainCode(err) != CodeBotInvalidSettings {
		t.Fatalf("settings error = %v", err)
	}
	if _, err := service.CreateSetupSession(context.Background(), CreateSetupSessionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); err != nil {
		t.Fatal(err)
	}
}

func TestBotSettingsAndConversationGrants(t *testing.T) {
	repo := newFakeRepository()
	repo.state.direct["conv-direct"] = true
	repo.state.groupMembers["conv-group"] = GroupConversationRecord{ID: "conv-group", Type: "group", IsMember: true, Role: "admin"}
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	var sequence atomic.Int64
	service := testService(repo, &now, &sequence)
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Policy Bot"})
	if err != nil {
		t.Fatal(err)
	}
	allowGroup := true
	visibility := VisibilitySpaceMembers
	settings, err := service.UpdateSettings(context.Background(), UpdateSettingsInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID, VisibilityPolicy: &visibility, AllowGroup: &allowGroup, Patch: map[string]any{"description": "safe"}})
	if err != nil || !settings.AllowGroup || settings.VisibilityPolicy != VisibilitySpaceMembers || settings.Description == nil || *settings.Description != "safe" {
		t.Fatalf("settings = %#v, %v", settings, err)
	}
	grant, err := service.UpdateContextGrant(context.Background(), UpdateContextGrantInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID, ConversationID: "conv-direct", AllowContext: boolPtr(true)})
	if err != nil || !grant.AllowContext || grant.GrantID == "" {
		t.Fatalf("direct grant = %#v, %v", grant, err)
	}
	policy, err := service.UpdateGroupPolicy(context.Background(), UpdateGroupPolicyInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID, ConversationID: "conv-group", AllowContext: boolPtr(true), MaxMessages: intPtr(10)})
	if err != nil || policy.Status != "active" || !policy.AllowContext || !repo.state.members[bot.BotUserID] {
		t.Fatalf("group policy = %#v, member=%v, %v", policy, repo.state.members[bot.BotUserID], err)
	}
	if _, err := service.UpdateContextGrant(context.Background(), UpdateContextGrantInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID, ConversationID: "conv-missing"}); domainCode(err) != CodeBotContextGrantForbidden {
		t.Fatalf("missing direct error = %v", err)
	}
	encoded, err := json.Marshal(settings)
	if err != nil || !strings.Contains(string(encoded), `"allowedMemberIds":[]`) || !strings.Contains(string(encoded), `"updatedAt":"2026-09-04T12:00:00.000Z"`) {
		t.Fatalf("settings JSON = %s, %v", encoded, err)
	}
}

func TestBotSetupExpiryAndApprovalSubset(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	var sequence atomic.Int64
	service := testService(repo, &now, &sequence)
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Setup Bot"})
	if err != nil {
		t.Fatal(err)
	}
	setup, err := service.CreateSetupSession(context.Background(), CreateSetupSessionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID, RequestedScopes: []string{"messages:send"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ApproveSetupSession(context.Background(), ApproveSetupInput{ActorID: "usr_owner", SpaceID: testSpaceID, SetupID: setup.ID, Scopes: []string{"files:write"}}); domainCode(err) != CodeBotSetupScopeNotRequested {
		t.Fatalf("subset scope error = %v", err)
	}
	now = now.Add(11 * time.Minute)
	expired, err := service.GetSetupStatus(context.Background(), SetupStatusInput{SetupID: setup.ID})
	if err != nil || expired.Status != SetupStatusExpired {
		t.Fatalf("expired = %#v, %v", expired, err)
	}
	if _, err := service.ApproveSetupSession(context.Background(), ApproveSetupInput{ActorID: "usr_owner", SpaceID: testSpaceID, SetupID: setup.ID}); domainCode(err) != CodeBotSetupNotApprovable {
		t.Fatalf("expired approval error = %v", err)
	}
}

func TestBotConcurrentCreateUsesOwnerInvariant(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	var sequence atomic.Int64
	service := testService(repo, &now, &sequence)
	var successes atomic.Int64
	var conflicts atomic.Int64
	var wait sync.WaitGroup
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Concurrent Bot"})
			if err == nil {
				successes.Add(1)
			} else if domainCode(err) == CodeBotAlreadyExists {
				conflicts.Add(1)
			} else {
				t.Errorf("concurrent create error = %v", err)
			}
		}()
	}
	wait.Wait()
	if successes.Load() != 1 || conflicts.Load() != 7 {
		t.Fatalf("successes=%d conflicts=%d", successes.Load(), conflicts.Load())
	}
	if len(listBotsFromState(repo.state, testSpaceID, "usr_owner")) != 1 {
		t.Fatalf("bots = %#v", repo.state.bots)
	}
}

func boolPtr(value bool) *bool { return &value }
func intPtr(value int) *int    { return &value }
