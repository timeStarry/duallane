package bots

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"golang.org/x/text/unicode/norm"
)

type Clock func() time.Time
type IDFactory func() (string, error)
type TokenFactory func() (string, error)

type ServiceOptions struct {
	Repository   Repository
	SpaceID      string
	Now          Clock
	IDFactory    IDFactory
	TokenFactory TokenFactory
}

type Service struct {
	repo         Repository
	spaceID      string
	now          Clock
	idFactory    IDFactory
	tokenFactory TokenFactory
}

type mutationResult struct {
	value    any
	targetID string
}

type rejection struct {
	err *Error
}

type mutationEvidence struct {
	action     string
	targetType string
	targetID   string
}

var (
	setupIDPattern       = regexp.MustCompile(`^setup_[A-Za-z0-9_-]{16,}$`)
	setupConversationPat = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	setupClientPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/+ -]{0,127}$`)
	setupCapabilityPat   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)
	memberIDPattern      = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	identifierPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

var defaultIDFactory = func() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

func defaultTokenFactory() (string, error) {
	buf := make([]byte, BotTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return BotTokenPrefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

func NewService(options ServiceOptions) *Service {
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	idFactory := options.IDFactory
	if idFactory == nil {
		idFactory = defaultIDFactory
	}
	tokenFactory := options.TokenFactory
	if tokenFactory == nil {
		tokenFactory = defaultTokenFactory
	}
	return &Service{repo: options.Repository, spaceID: spaceID, now: now, idFactory: idFactory, tokenFactory: tokenFactory}
}

func NewServiceForRepository(repository Repository) *Service {
	return NewService(ServiceOptions{Repository: repository})
}

func (s *Service) Repository() Repository {
	if s == nil {
		return nil
	}
	return s.repo
}

func (s *Service) space(requested string) (string, *Error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		if s == nil || strings.TrimSpace(s.spaceID) == "" {
			return DefaultSpaceID, nil
		}
		return strings.TrimSpace(s.spaceID), nil
	}
	return requested, nil
}

func (s *Service) nowUTC() time.Time {
	now := time.Now()
	if s != nil && s.now != nil {
		now = s.now()
	}
	if now.IsZero() {
		now = time.Unix(0, 0)
	}
	return now.UTC().Truncate(time.Millisecond)
}

func (s *Service) newID(operation string) (string, error) {
	if s == nil || s.idFactory == nil {
		return "", errors.New(operation + " id factory is required")
	}
	id, err := s.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return id, nil
}

func (s *Service) lookupActor(ctx context.Context, repository ReadRepository, spaceID, actorID string) (*auth.Actor, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	if repository == nil {
		return nil, internalError("lookup workspace agent bot actor", errors.New("repository is required"))
	}
	actor, err := repository.LookupActor(ctx, spaceID, actorID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if actor == nil || strings.TrimSpace(actor.ID) == "" || actor.ID != actorID || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	if actor.Kind == "bot" || actor.Kind == "system" {
		return nil, identityForbiddenError()
	}
	if actor.Kind != "" && actor.Kind != "human" {
		return nil, identityForbiddenError()
	}
	return actor, nil
}

func (s *Service) auditInput(actor *auth.Actor, spaceID string, meta RequestMeta, evidence mutationEvidence, result, reason string, at time.Time) AuditInput {
	safe := meta.Safe()
	input := AuditInput{
		SpaceID: spaceID, Action: evidence.action, TargetType: evidence.targetType, TargetID: evidence.targetID,
		Result: result, Reason: reason, RequestID: safe.RequestID, IPAddress: safe.IPAddress,
		UserAgent: safe.UserAgent, CreatedAt: at,
	}
	if actor != nil {
		input.ActorUserID = actor.ID
		input.ActorGitHubLogin = actor.GitHubLogin
	}
	return input
}

// mutate centralizes the authorization re-check and the atomic audit rule:
// deliberate domain rejections commit a content-free rejected audit row,
// while repository failures roll the transaction back.
func (s *Service) mutate(ctx context.Context, spaceID, actorID string, meta RequestMeta, evidence mutationEvidence, fn func(Tx, *auth.Actor, time.Time) (mutationResult, *rejection, error)) (mutationResult, error) {
	if s == nil || s.repo == nil {
		return mutationResult{}, internalError("workspace agent bot service", errors.New("repository is required"))
	}
	if fn == nil {
		return mutationResult{}, internalError("workspace agent bot mutation", errors.New("callback is required"))
	}
	var output mutationResult
	var rejectedOperation *rejection
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return errors.New("workspace agent bot transaction is required")
		}
		actor, err := s.lookupActor(ctx, tx, spaceID, actorID)
		if err != nil {
			return err
		}
		output, rejectedOperation, err = fn(tx, actor, s.nowUTC())
		if err != nil {
			return err
		}
		if rejectedOperation != nil {
			return tx.WriteAudit(ctx, s.auditInput(actor, spaceID, meta, evidence, "rejected", rejectedOperation.err.Code, s.nowUTC()))
		}
		auditEvidence := evidence
		if output.targetID != "" {
			auditEvidence.targetID = output.targetID
		}
		return tx.WriteAudit(ctx, s.auditInput(actor, spaceID, meta, auditEvidence, "success", "", s.nowUTC()))
	})
	if err != nil {
		return mutationResult{}, normalizeError(err)
	}
	if rejectedOperation != nil {
		return mutationResult{}, rejectedOperation.err
	}
	return output, nil
}

func rejected(err *Error) *rejection { return &rejection{err: err} }

func (s *Service) ownerBot(ctx context.Context, repository ReadRepository, actor *auth.Actor, spaceID, botID string) (*BotRecord, error) {
	botID = strings.TrimSpace(botID)
	if botID == "" {
		return nil, notFoundError(CodeBotNotFound, MessageBotNotFound)
	}
	bot, err := repository.GetBot(ctx, spaceID, botID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if bot == nil {
		anyBot, lookupErr := repository.GetBotAnySpace(ctx, botID)
		if lookupErr != nil {
			return nil, normalizeError(lookupErr)
		}
		if anyBot != nil {
			return nil, permissionDeniedError()
		}
		return nil, notFoundError(CodeBotNotFound, MessageBotNotFound)
	}
	if actor == nil || bot.SpaceID != spaceID || bot.OwnerUserID != actor.ID {
		return nil, permissionDeniedError()
	}
	return bot, nil
}

func (s *Service) preflightActor(ctx context.Context, actorID, requestedSpace string) (string, *auth.Actor, error) {
	spaceID, domainErr := s.space(requestedSpace)
	if domainErr != nil {
		return "", nil, domainErr
	}
	if s == nil || s.repo == nil {
		return "", nil, internalError("workspace agent bot service", errors.New("repository is required"))
	}
	actor, err := s.lookupActor(ctx, s.repo, spaceID, actorID)
	return spaceID, actor, err
}

func (s *Service) Create(ctx context.Context, input CreateInput) (Bot, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return Bot{}, domainErr
	}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: "bot.create", targetType: "agent_bot"}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		// Serialize the owner uniqueness check with other Bot creates in this
		// space. The partial unique index remains the database backstop, while
		// this lock keeps the normal concurrent path audit-safe.
		if err := tx.Lock(ctx, botOwnerCreateLockKey(spaceID, actor.ID)); err != nil {
			return mutationResult{}, nil, err
		}
		name, validationErr := NormalizeBotName(input.Name)
		if validationErr != nil {
			return mutationResult{}, rejected(validationErr), nil
		}
		if IsReservedBotName(name) {
			return mutationResult{}, rejected(NewError(CodeBotReservedName, MessageBotReservedName, 400)), nil
		}
		existing, err := tx.GetBotByOwner(ctx, spaceID, actor.ID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if existing != nil && existing.Status != BotStatusDeleted {
			return mutationResult{}, rejected(conflictError(CodeBotAlreadyExists, MessageBotAlreadyExists)), nil
		}
		id, err := s.newID("bot")
		if err != nil {
			return mutationResult{}, nil, internalError("generate bot id", err)
		}
		botUserSuffix, err := s.newID("bot user")
		if err != nil {
			return mutationResult{}, nil, internalError("generate bot user id", err)
		}
		bot := BotRecord{
			ID: "bot_" + id, SpaceID: spaceID, OwnerUserID: actor.ID, BotUserID: "usr_bot_" + botUserSuffix,
			Mode: CustomBotMode, Name: name, NameNormalized: NormalizeNameKey(name), VisibilityPolicy: VisibilityPrivate,
			ConversationPolicy: ConversationDirectOnly, TriggerPolicy: TriggerMentionOrCommand, Status: BotStatusActive,
			GithubLogin: "__duallane_bot_bot_" + id, CreatedAt: now, UpdatedAt: now,
		}
		settings := defaultSettings(bot.ID, spaceID, now)
		if err := tx.CreateBot(ctx, bot, settings); err != nil {
			if isUniqueError(err) {
				return mutationResult{}, rejected(conflictError(CodeBotAlreadyExists, MessageBotAlreadyExists)), nil
			}
			return mutationResult{}, nil, err
		}
		stored, err := tx.GetBot(ctx, spaceID, bot.ID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if stored == nil {
			stored = &bot
		}
		return mutationResult{value: stored.Public(), targetID: stored.ID}, nil, nil
	})
	if err != nil {
		return Bot{}, err
	}
	return result.value.(Bot), nil
}

func (s *Service) CreateBot(ctx context.Context, input CreateInput) (Bot, error) {
	return s.Create(ctx, input)
}

func (s *Service) List(ctx context.Context, input ListInput) ([]Bot, error) {
	spaceID, actor, err := s.preflightActor(ctx, input.ActorID, input.SpaceID)
	if err != nil {
		return []Bot{}, err
	}
	rows, err := s.repo.ListBots(ctx, spaceID, actor.ID)
	if err != nil {
		return []Bot{}, normalizeError(err)
	}
	result := make([]Bot, 0, len(rows))
	for _, row := range rows {
		if row.Status == BotStatusDeleted {
			continue
		}
		result = append(result, row.Public())
	}
	return result, nil
}

func (s *Service) ListOwnedBots(ctx context.Context, input ListInput) ([]Bot, error) {
	return s.List(ctx, input)
}

func (s *Service) Get(ctx context.Context, input GetInput) (Bot, error) {
	spaceID, actor, err := s.preflightActor(ctx, input.ActorID, input.SpaceID)
	if err != nil {
		return Bot{}, err
	}
	botID := strings.TrimSpace(input.BotID)
	if botID == "" {
		bot, readErr := s.repo.GetBotByOwner(ctx, spaceID, actor.ID)
		if readErr != nil {
			return Bot{}, normalizeError(readErr)
		}
		if bot == nil {
			return Bot{}, notFoundError(CodeBotNotFound, MessageBotNotFound)
		}
		return bot.Public(), nil
	}
	bot, err := s.ownerBot(ctx, s.repo, actor, spaceID, botID)
	if err != nil {
		return Bot{}, err
	}
	return bot.Public(), nil
}

func (s *Service) GetOwnedBot(ctx context.Context, input GetInput) (Bot, error) {
	return s.Get(ctx, input)
}

func defaultSettings(botID, spaceID string, at time.Time) SettingsRecord {
	return SettingsRecord{
		BotID: botID, SpaceID: spaceID, VisibilityPolicy: VisibilityPrivate, AllowDirect: true, AllowGroup: false,
		GroupInviterPolicy: "owner", RequireOwnerApproval: true, ProactiveEnabled: false,
		TriggerPolicy: TriggerMentionOrCommand, MaxContextMessages: 50, MaxContextChars: 20000,
		MaxContextTokens: 8000, ContextWindowSeconds: 86400, IncludeReplies: true,
		IncludeSystemEvents: false, IncludeAttachmentMetadata: false, AllowAttachmentPreview: false,
		LongTermSummaryEnabled: false, AllowedMemberIDs: []string{}, Limits: Limits{
			RequestsPerMinute: 30, MemberDailyRequests: 500, InputTokenLimit: 32000, OutputTokenLimit: 16000,
			MaxConcurrency: 2, EventBacklogLimit: 200,
		}, CreatedAt: at, UpdatedAt: at,
	}
}

func (s *Service) GetSettings(ctx context.Context, input GetInput) (BotSettings, error) {
	spaceID, actor, err := s.preflightActor(ctx, input.ActorID, input.SpaceID)
	if err != nil {
		return BotSettings{}, err
	}
	bot, err := s.ownerBot(ctx, s.repo, actor, spaceID, input.BotID)
	if err != nil {
		return BotSettings{}, err
	}
	settings, err := s.repo.GetSettings(ctx, spaceID, bot.ID)
	if err != nil {
		return BotSettings{}, normalizeError(err)
	}
	if settings == nil {
		fallback := defaultSettings(bot.ID, spaceID, bot.UpdatedAt)
		return fallback.Public(), nil
	}
	return settings.Public(), nil
}

func (s *Service) UpdateSettings(ctx context.Context, input UpdateSettingsInput) (BotSettings, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return BotSettings{}, domainErr
	}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: "bot.settings.update", targetType: "agent_bot", targetID: strings.TrimSpace(input.BotID)}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, input.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		bot, err := s.ownerBot(ctx, tx, actor, spaceID, input.BotID)
		if err != nil {
			return mutationResult{}, rejectionFromError(err), nil
		}
		if bot.Status != BotStatusActive && bot.Status != BotStatusPaused {
			return mutationResult{}, rejected(NewError(CodeBotNotActive, "当前状态不允许修改 Bot 设置", 409)), nil
		}
		current, err := tx.GetSettings(ctx, spaceID, bot.ID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if current == nil {
			fallback := defaultSettings(bot.ID, spaceID, bot.UpdatedAt)
			current = &fallback
		}
		updated, validationErr := applySettingsPatch(*current, input, now)
		if validationErr != nil {
			return mutationResult{}, rejected(validationErr), nil
		}
		conversationPolicy := ConversationDirectOnly
		if updated.AllowGroup {
			conversationPolicy = ConversationGroupCapable
		}
		if err := tx.UpdateSettings(ctx, spaceID, bot.ID, updated.VisibilityPolicy, conversationPolicy, updated, now); err != nil {
			return mutationResult{}, nil, err
		}
		if hasPatch(input, "allowedMemberIds") {
			if err := tx.ReplaceVisibilityMembers(ctx, spaceID, bot.ID, updated.AllowedMemberIDs, now); err != nil {
				return mutationResult{}, nil, err
			}
		}
		stored, err := tx.GetSettings(ctx, spaceID, bot.ID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if stored == nil {
			stored = &updated
		}
		return mutationResult{value: stored.Public(), targetID: bot.ID}, nil, nil
	})
	if err != nil {
		return BotSettings{}, err
	}
	return result.value.(BotSettings), nil
}

func (s *Service) UpdateBotSettings(ctx context.Context, input UpdateSettingsInput) (BotSettings, error) {
	return s.UpdateSettings(ctx, input)
}

func (s *Service) ListGroupPolicies(ctx context.Context, input GroupPoliciesInput) ([]GroupPolicy, error) {
	spaceID, actor, err := s.preflightActor(ctx, input.ActorID, input.SpaceID)
	if err != nil {
		return []GroupPolicy{}, err
	}
	bot, err := s.ownerBot(ctx, s.repo, actor, spaceID, input.BotID)
	if err != nil {
		return []GroupPolicy{}, err
	}
	rows, err := s.repo.ListGroupPolicies(ctx, spaceID, bot.ID)
	if err != nil {
		return []GroupPolicy{}, normalizeError(err)
	}
	result := make([]GroupPolicy, 0, len(rows))
	for _, row := range rows {
		result = append(result, row.Public())
	}
	return result, nil
}

func (s *Service) UpdateGroupPolicy(ctx context.Context, input UpdateGroupPolicyInput) (GroupPolicy, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return GroupPolicy{}, domainErr
	}
	conversationID := strings.TrimSpace(input.ConversationID)
	evidence := mutationEvidence{action: "bot.group_policy.update", targetType: "agent_bot", targetID: strings.TrimSpace(input.BotID)}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, evidence, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, input.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		bot, err := s.ownerBot(ctx, tx, actor, spaceID, input.BotID)
		if err != nil {
			return mutationResult{}, rejectionFromError(err), nil
		}
		if !identifierPattern.MatchString(conversationID) {
			return mutationResult{}, rejected(NewError(CodeBotInvalidGroupPolicy, MessageBotInvalidGroupPolicy, 400)), nil
		}
		status := input.Status
		if status == "" {
			status = "active"
		}
		if status != "pending" && status != "active" && status != "rejected" && status != "removed" {
			return mutationResult{}, rejected(NewError(CodeBotInvalidGroupPolicy, MessageBotInvalidGroupPolicy, 400)), nil
		}
		allowTrigger := status == "active"
		if input.AllowTrigger != nil {
			allowTrigger = *input.AllowTrigger
		}
		allowContext := false
		if input.AllowContext != nil {
			allowContext = *input.AllowContext
		}
		if input.MaxMessages != nil && (*input.MaxMessages < 1 || *input.MaxMessages > 200) {
			return mutationResult{}, rejected(NewError(CodeBotInvalidGroupPolicy, MessageBotInvalidGroupPolicy, 400)), nil
		}
		manager, err := tx.GetGroupManager(ctx, spaceID, conversationID, actor.ID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if manager == nil || manager.Type != "group" {
			return mutationResult{}, rejected(notFoundError(CodeBotInvalidGroupPolicy, "请选择群聊会话")), nil
		}
		if !manager.IsMember || (manager.Role != "owner" && manager.Role != "admin") {
			return mutationResult{}, rejected(forbiddenError(CodeBotGroupPolicyForbidden, "只有当前群聊管理员可以管理 Bot")), nil
		}
		settings, err := tx.GetSettings(ctx, spaceID, bot.ID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if settings == nil {
			fallback := defaultSettings(bot.ID, spaceID, bot.UpdatedAt)
			settings = &fallback
		}
		if status == "active" && (!settings.AllowGroup || settings.VisibilityPolicy == VisibilityPrivate) {
			return mutationResult{}, rejected(forbiddenError(CodeBotGroupPolicyForbidden, MessageBotGroupPolicyForbidden)), nil
		}
		existing, err := tx.GetContextGrant(ctx, spaceID, bot.ID, conversationID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		grantID := ""
		if existing != nil {
			grantID = existing.GrantID
		}
		if grantID == "" {
			id, idErr := s.newID("group grant")
			if idErr != nil {
				return mutationResult{}, nil, internalError("generate group grant id", idErr)
			}
			grantID = "grant_" + id
		}
		policy := GroupPolicyRecord{BotID: bot.ID, SpaceID: spaceID, ConversationID: conversationID, Status: status,
			InvitedBy: stringPtr(actor.ID), MaxContextMessages: cloneInt(input.MaxMessages), CreatedAt: now, UpdatedAt: now,
			GrantID: stringPtr(grantID), AllowTrigger: allowTrigger, AllowContext: allowContext,
			ContextMaxMessages: cloneInt(input.MaxMessages)}
		if status == "active" {
			policy.ApprovedBy = stringPtr(actor.ID)
		}
		if err := tx.UpsertGroupPolicy(ctx, policy); err != nil {
			return mutationResult{}, nil, err
		}
		grant := ContextGrantRecord{GrantID: grantID, BotID: bot.ID, SpaceID: spaceID, ConversationID: conversationID,
			AllowTrigger: allowTrigger, AllowContext: allowContext, MaxMessages: cloneInt(input.MaxMessages),
			GrantedBy: stringPtr(actor.ID), CreatedAt: now, UpdatedAt: now}
		if err := tx.UpsertContextGrant(ctx, grant); err != nil {
			return mutationResult{}, nil, err
		}
		if status == "active" {
			if err := tx.SetConversationMember(ctx, conversationID, bot.BotUserID, true, now); err != nil {
				return mutationResult{}, nil, err
			}
		} else if status == "removed" || status == "rejected" {
			if err := tx.SetConversationMember(ctx, conversationID, bot.BotUserID, false, now); err != nil {
				return mutationResult{}, nil, err
			}
		}
		return mutationResult{value: policy.Public(), targetID: bot.ID}, nil, nil
	})
	if err != nil {
		return GroupPolicy{}, err
	}
	return result.value.(GroupPolicy), nil
}

func (s *Service) UpdateContextGrant(ctx context.Context, input UpdateContextGrantInput) (ContextGrant, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return ContextGrant{}, domainErr
	}
	conversationID := strings.TrimSpace(input.ConversationID)
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: "bot.context_grant.update", targetType: "conversation", targetID: conversationID}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, input.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		bot, err := s.ownerBot(ctx, tx, actor, spaceID, input.BotID)
		if err != nil {
			return mutationResult{}, rejectionFromError(err), nil
		}
		if bot.Status != BotStatusActive {
			return mutationResult{}, rejected(NewError(CodeBotNotActive, "仅运行中的 Bot 可以修改私聊授权", 409)), nil
		}
		if !identifierPattern.MatchString(conversationID) {
			return mutationResult{}, rejected(NewError(CodeBotInvalidContextGrant, MessageBotInvalidContextGrant, 400)), nil
		}
		settings, err := tx.GetSettings(ctx, spaceID, bot.ID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if settings == nil {
			fallback := defaultSettings(bot.ID, spaceID, bot.UpdatedAt)
			settings = &fallback
		}
		if !settings.AllowDirect {
			return mutationResult{}, rejected(forbiddenError(CodeBotContextGrantForbidden, MessageBotContextGrantForbidden)), nil
		}
		validDirect, err := tx.IsDirectConversation(ctx, spaceID, conversationID, actor.ID, bot.BotUserID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if !validDirect {
			return mutationResult{}, rejected(forbiddenError(CodeBotContextGrantForbidden, MessageBotContextGrantForbidden)), nil
		}
		existing, err := tx.GetContextGrant(ctx, spaceID, bot.ID, conversationID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		allowTrigger := true
		allowContext := false
		var maxMessages *int
		grantID := ""
		if existing != nil {
			allowTrigger, allowContext, maxMessages, grantID = existing.AllowTrigger, existing.AllowContext, cloneInt(existing.MaxMessages), existing.GrantID
		}
		if input.AllowTrigger != nil {
			allowTrigger = *input.AllowTrigger
		}
		if input.AllowContext != nil {
			allowContext = *input.AllowContext
		}
		if input.MaxMessages != nil {
			maxMessages = cloneInt(input.MaxMessages)
		}
		if maxMessages != nil && (*maxMessages < 1 || *maxMessages > 200) {
			return mutationResult{}, rejected(NewError(CodeBotInvalidContextGrant, MessageBotInvalidContextGrant, 400)), nil
		}
		if grantID == "" {
			id, idErr := s.newID("context grant")
			if idErr != nil {
				return mutationResult{}, nil, internalError("generate context grant id", idErr)
			}
			grantID = "grant_" + id
		}
		grant := ContextGrantRecord{GrantID: grantID, BotID: bot.ID, SpaceID: spaceID, ConversationID: conversationID,
			AllowTrigger: allowTrigger, AllowContext: allowContext, MaxMessages: maxMessages, GrantedBy: stringPtr(actor.ID), CreatedAt: now, UpdatedAt: now}
		if existing != nil {
			grant.CreatedAt = existing.CreatedAt
		}
		if err := tx.UpsertContextGrant(ctx, grant); err != nil {
			return mutationResult{}, nil, err
		}
		return mutationResult{value: grant.Public(), targetID: conversationID}, nil, nil
	})
	if err != nil {
		return ContextGrant{}, err
	}
	return result.value.(ContextGrant), nil
}

func (s *Service) Pause(ctx context.Context, input TransitionInput) (Bot, error) {
	return s.transition(ctx, input, BotStatusPaused, []string{BotStatusActive}, "bot.pause")
}

func (s *Service) PauseBot(ctx context.Context, input TransitionInput) (Bot, error) {
	return s.Pause(ctx, input)
}

func (s *Service) Resume(ctx context.Context, input TransitionInput) (Bot, error) {
	return s.transition(ctx, input, BotStatusActive, []string{BotStatusPaused}, "bot.resume")
}

func (s *Service) ResumeBot(ctx context.Context, input TransitionInput) (Bot, error) {
	return s.Resume(ctx, input)
}

func (s *Service) transition(ctx context.Context, input TransitionInput, target string, from []string, action string) (Bot, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return Bot{}, domainErr
	}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: action, targetType: "agent_bot", targetID: strings.TrimSpace(input.BotID)}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, input.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		bot, err := s.ownerBot(ctx, tx, actor, spaceID, input.BotID)
		if err != nil {
			return mutationResult{}, rejectionFromError(err), nil
		}
		if bot.Status == target || (target == BotStatusDeleting && bot.Status == BotStatusDeleted) {
			return mutationResult{value: bot.Public(), targetID: bot.ID}, nil, nil
		}
		if !contains(from, bot.Status) {
			return mutationResult{}, rejected(NewError(CodeBotInvalidTransition, MessageBotInvalidTransition, 409)), nil
		}
		updated, changed, err := tx.TransitionBot(ctx, spaceID, bot.ID, actor.ID, target, from, now)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if !changed || updated == nil {
			return mutationResult{}, rejected(NewError(CodeBotInvalidTransition, MessageBotInvalidTransition, 409)), nil
		}
		if target == BotStatusPaused || target == BotStatusDeleting || target == BotStatusDeleted {
			if _, err := tx.RevokePendingSetupSessions(ctx, bot.ID, now); err != nil {
				return mutationResult{}, nil, err
			}
		}
		if target == BotStatusDeleting || target == BotStatusDeleted {
			if err := tx.RevokeBotTokens(ctx, bot.ID, now); err != nil {
				return mutationResult{}, nil, err
			}
		}
		if target == BotStatusDeleted {
			if err := tx.RemoveBotMembership(ctx, spaceID, bot.BotUserID, now); err != nil {
				return mutationResult{}, nil, err
			}
		}
		return mutationResult{value: updated.Public(), targetID: updated.ID}, nil, nil
	})
	if err != nil {
		return Bot{}, err
	}
	return result.value.(Bot), nil
}

func (s *Service) BeginDelete(ctx context.Context, input TransitionInput) (Bot, error) {
	return s.transition(ctx, input, BotStatusDeleting, []string{BotStatusActive, BotStatusPaused}, "bot.delete.requested")
}

func (s *Service) BeginDeleteBot(ctx context.Context, input TransitionInput) (Bot, error) {
	return s.BeginDelete(ctx, input)
}

func (s *Service) FinalizeDelete(ctx context.Context, input TransitionInput) (Bot, error) {
	return s.transition(ctx, input, BotStatusDeleted, []string{BotStatusDeleting}, "bot.delete.completed")
}

func (s *Service) FinalizeDeleteBot(ctx context.Context, input TransitionInput) (Bot, error) {
	return s.FinalizeDelete(ctx, input)
}

func (s *Service) IssueToken(ctx context.Context, input IssueTokenInput) (IssuedToken, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return IssuedToken{}, domainErr
	}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: "bot.token.issue", targetType: "agent_bot", targetID: strings.TrimSpace(input.BotID)}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, input.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		bot, err := s.ownerBot(ctx, tx, actor, spaceID, input.BotID)
		if err != nil {
			return mutationResult{}, rejectionFromError(err), nil
		}
		if bot.Status != BotStatusActive {
			return mutationResult{}, rejected(NewError(CodeBotNotActive, "仅启用中的 Bot 可以生成 Token", 409)), nil
		}
		record, raw, issueErr := s.newTokenRecord(bot, input.Scopes, input.ExpiresAt, now)
		if issueErr != nil {
			return mutationResult{}, rejected(issueErr), nil
		}
		if err := tx.InsertToken(ctx, record); err != nil {
			if isUniqueError(err) {
				return mutationResult{}, rejected(NewError(CodeBotTokenIssueFailed, MessageBotTokenIssueFailed, 503)), nil
			}
			return mutationResult{}, nil, err
		}
		return mutationResult{value: IssuedToken{Token: record.Public(""), Raw: raw}, targetID: bot.ID}, nil, nil
	})
	if err != nil {
		return IssuedToken{}, err
	}
	return result.value.(IssuedToken), nil
}

func (s *Service) Issue(ctx context.Context, input IssueTokenInput) (IssuedToken, error) {
	return s.IssueToken(ctx, input)
}

func (s *Service) newTokenRecord(bot *BotRecord, requestedScopes []string, expiry string, now time.Time) (TokenRecord, string, *Error) {
	scopes, err := ValidateBotScopes(requestedScopes)
	if err != nil {
		return TokenRecord{}, "", err
	}
	expiresAt, err := NormalizeExpiry(expiry, now)
	if err != nil {
		return TokenRecord{}, "", err
	}
	if s == nil || s.tokenFactory == nil {
		return TokenRecord{}, "", internalError("generate bot token", errors.New("token factory is required"))
	}
	raw, factoryErr := s.tokenFactory()
	if factoryErr != nil {
		return TokenRecord{}, "", internalError("generate bot token", factoryErr)
	}
	if !IsBotToken(raw) {
		return TokenRecord{}, "", internalError("generate bot token", errors.New("token factory returned an invalid token"))
	}
	id, idErr := s.newID("bot token")
	if idErr != nil {
		return TokenRecord{}, "", internalError("generate bot token id", idErr)
	}
	record := TokenRecord{ID: "btk_" + id, BotID: bot.ID, SpaceID: bot.SpaceID, TokenHash: HashBotToken(raw), Scopes: scopes,
		ExpiresAt: expiresAt, CreatedAt: now}
	return record, raw, nil
}

func (s *Service) ListTokens(ctx context.Context, input ListTokensInput) ([]Token, error) {
	spaceID, actor, err := s.preflightActor(ctx, input.ActorID, input.SpaceID)
	if err != nil {
		return []Token{}, err
	}
	bot, err := s.ownerBot(ctx, s.repo, actor, spaceID, input.BotID)
	if err != nil {
		return []Token{}, err
	}
	rows, err := s.repo.ListTokens(ctx, spaceID, bot.ID)
	if err != nil {
		return []Token{}, normalizeError(err)
	}
	result := make([]Token, 0, len(rows))
	for _, row := range rows {
		result = append(result, row.Public(MaskBotToken()))
	}
	return result, nil
}

func (s *Service) RevokeToken(ctx context.Context, input RevokeTokenInput) (Token, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return Token{}, domainErr
	}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: "bot.token.revoke", targetType: "agent_bot_token", targetID: strings.TrimSpace(input.TokenID)}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, input.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		bot, err := s.ownerBot(ctx, tx, actor, spaceID, input.BotID)
		if err != nil {
			return mutationResult{}, rejectionFromError(err), nil
		}
		token, found, err := tx.RevokeToken(ctx, spaceID, bot.ID, strings.TrimSpace(input.TokenID), now)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if !found || token == nil {
			return mutationResult{}, rejected(notFoundError(CodeBotTokenNotFound, MessageBotTokenNotFound)), nil
		}
		return mutationResult{value: token.Public(MaskBotToken()), targetID: token.ID}, nil, nil
	})
	if err != nil {
		return Token{}, err
	}
	return result.value.(Token), nil
}

func (s *Service) RotateToken(ctx context.Context, input IssueTokenInput) (IssuedToken, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return IssuedToken{}, domainErr
	}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: "bot.token.rotate", targetType: "agent_bot", targetID: strings.TrimSpace(input.BotID)}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, input.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		bot, err := s.ownerBot(ctx, tx, actor, spaceID, input.BotID)
		if err != nil {
			return mutationResult{}, rejectionFromError(err), nil
		}
		if bot.Status != BotStatusActive {
			return mutationResult{}, rejected(NewError(CodeBotNotActive, "仅启用中的 Bot 可以生成 Token", 409)), nil
		}
		record, raw, issueErr := s.newTokenRecord(bot, input.Scopes, input.ExpiresAt, now)
		if issueErr != nil {
			return mutationResult{}, rejected(issueErr), nil
		}
		if err := tx.RevokeBotTokens(ctx, bot.ID, now); err != nil {
			return mutationResult{}, nil, err
		}
		if err := tx.InsertToken(ctx, record); err != nil {
			if isUniqueError(err) {
				return mutationResult{}, rejected(NewError(CodeBotTokenIssueFailed, MessageBotTokenIssueFailed, 503)), nil
			}
			return mutationResult{}, nil, err
		}
		return mutationResult{value: IssuedToken{Token: record.Public(""), Raw: raw}, targetID: bot.ID}, nil, nil
	})
	if err != nil {
		return IssuedToken{}, err
	}
	return result.value.(IssuedToken), nil
}

func (s *Service) AuthenticateToken(ctx context.Context, rawToken string, options AuthenticateOptions) (TokenIdentity, error) {
	if !IsBotToken(rawToken) {
		return TokenIdentity{}, invalidBotTokenError()
	}
	if s == nil || s.repo == nil {
		return TokenIdentity{}, internalError("authenticate bot token", errors.New("repository is required"))
	}
	hash := HashBotToken(rawToken)
	var identity TokenIdentity
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		record, err := tx.GetTokenByHash(ctx, hash)
		if err != nil {
			return err
		}
		if record == nil || record.Token.TokenHash == "" || record.Bot.Status != BotStatusActive || record.Token.RevokedAt != nil || isExpired(record.Token.ExpiresAt, s.nowUTC()) {
			return invalidBotTokenError()
		}
		spaceID := strings.TrimSpace(options.SpaceID)
		if spaceID != "" && spaceID != record.Bot.SpaceID {
			return invalidBotTokenError()
		}
		usedAt := s.nowUTC()
		marked, err := tx.MarkTokenUsed(ctx, record.Token.ID, record.Bot.ID, usedAt)
		if err != nil {
			return err
		}
		if !marked {
			return invalidBotTokenError()
		}
		identity = TokenIdentity{TokenID: record.Token.ID, Bot: record.Bot.Public(), BotID: record.Bot.ID, UserID: record.Bot.BotUserID,
			SpaceID: record.Bot.SpaceID, OwnerUserID: record.Bot.OwnerUserID, Scopes: cloneStrings(record.Token.Scopes), LastUsedAt: formatTime(usedAt)}
		return nil
	})
	if err != nil {
		return TokenIdentity{}, normalizeError(err)
	}
	return identity, nil
}

func (s *Service) CreateSetupSession(ctx context.Context, input CreateSetupSessionInput) (SetupSession, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return SetupSession{}, domainErr
	}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: "bot.setup.create", targetType: "agent_bot_setup"}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, input.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		bot, err := s.ownerBot(ctx, tx, actor, spaceID, input.BotID)
		if err != nil {
			return mutationResult{}, rejectionFromError(err), nil
		}
		if bot.Status != BotStatusActive {
			return mutationResult{}, rejected(NewError(CodeBotNotActive, "仅运行中的 Bot 可以创建配置会话", 409)), nil
		}
		scopes, scopeErr := ValidateBotScopes(input.RequestedScopes)
		if scopeErr != nil {
			return mutationResult{}, rejected(scopeErr), nil
		}
		conversations, conversationErr := NormalizeSetupConversationIDs(input.ConversationIDs)
		if conversationErr != nil {
			return mutationResult{}, rejected(conversationErr), nil
		}
		id, idErr := s.newID("bot setup session")
		if idErr != nil {
			return mutationResult{}, nil, internalError("generate bot setup session id", idErr)
		}
		session := SetupSessionRecord{ID: "setup_" + id, BotID: bot.ID, SpaceID: spaceID, OwnerUserID: actor.ID,
			Status: SetupStatusCreated, RequestedScopes: scopes, ApprovedScopes: []string{}, RequestedConversations: conversations,
			ApprovedConversations: []string{}, ProtocolVersion: "v1", Capabilities: []string{}, ExpiresAt: now.Add(SetupSessionTTL),
			CreatedAt: now, UpdatedAt: now}
		if err := tx.InsertSetupSession(ctx, session); err != nil {
			return mutationResult{}, nil, err
		}
		return mutationResult{value: session.Public(bot), targetID: session.ID}, nil, nil
	})
	if err != nil {
		return SetupSession{}, err
	}
	return result.value.(SetupSession), nil
}

func (s *Service) CreateSetup(ctx context.Context, input CreateSetupSessionInput) (SetupSession, error) {
	return s.CreateSetupSession(ctx, input)
}

func (s *Service) GetSetupSession(ctx context.Context, input GetSetupSessionInput) (SetupSession, error) {
	spaceID, actor, err := s.preflightActor(ctx, input.ActorID, input.SpaceID)
	if err != nil {
		return SetupSession{}, err
	}
	setupID, validationErr := NormalizeSetupID(input.SetupID)
	if validationErr != nil {
		return SetupSession{}, validationErr
	}
	session, err := s.repo.GetSetupSessionByID(ctx, setupID)
	if err != nil {
		return SetupSession{}, normalizeError(err)
	}
	if session == nil {
		return SetupSession{}, notFoundError(CodeBotSetupNotFound, MessageBotSetupNotFound)
	}
	if session.SpaceID != spaceID || session.OwnerUserID != actor.ID {
		return SetupSession{}, notFoundError(CodeBotSetupNotFound, MessageBotSetupNotFound)
	}
	session, err = s.expireSetupIfNeeded(ctx, session)
	if err != nil {
		return SetupSession{}, err
	}
	bot, err := s.repo.GetBot(ctx, spaceID, session.BotID)
	if err != nil {
		return SetupSession{}, normalizeError(err)
	}
	return session.Public(bot), nil
}

func (s *Service) RequestSetup(ctx context.Context, input RequestSetupInput) (SetupSession, error) {
	setupID, validationErr := NormalizeSetupID(input.SetupID)
	if validationErr != nil {
		return SetupSession{}, validationErr
	}
	result, err := s.setupMutation(ctx, setupID, "bot.setup.request", input.Meta, func(tx Tx, session *SetupSessionRecord, now time.Time) (mutationResult, *auth.Actor, *Error, error) {
		if session.Status != SetupStatusCreated && session.Status != SetupStatusAwaitingUser {
			return mutationResult{}, nil, NewError(CodeBotSetupNotRequestable, MessageBotSetupNotRequestable, 409), nil
		}
		requestedScopes := cloneStrings(session.RequestedScopes)
		if input.RequestedScopes != nil {
			requestedScopes, validationErr = ValidateBotScopes(input.RequestedScopes)
			if validationErr != nil {
				return mutationResult{}, nil, validationErr, nil
			}
		}
		requestedConversations := cloneStrings(session.RequestedConversations)
		if input.ConversationIDs != nil {
			requestedConversations, validationErr = NormalizeSetupConversationIDs(input.ConversationIDs)
			if validationErr != nil {
				return mutationResult{}, nil, validationErr, nil
			}
		}
		clientName, validationErr := NormalizeSetupClient(input.ClientName)
		if validationErr != nil {
			return mutationResult{}, nil, validationErr, nil
		}
		clientVersion, validationErr := NormalizeSetupClient(input.ClientVersion)
		if validationErr != nil {
			return mutationResult{}, nil, validationErr, nil
		}
		protocol, validationErr := NormalizeSetupProtocol(input.ProtocolVersion)
		if validationErr != nil {
			return mutationResult{}, nil, validationErr, nil
		}
		capabilities, validationErr := NormalizeSetupCapabilities(input.Capabilities)
		if validationErr != nil {
			return mutationResult{}, nil, validationErr, nil
		}
		if isExpiredAt(session.ExpiresAt, now) {
			return mutationResult{}, nil, NewError(CodeBotSetupNotRequestable, MessageBotSetupNotRequestable, 409), nil
		}
		if ok, err := tx.UpdateSetupRequest(ctx, session.ID, []string{SetupStatusCreated, SetupStatusAwaitingUser}, requestedScopes, requestedConversations, valueOrEmpty(clientName), valueOrEmpty(clientVersion), protocol, capabilities, now); err != nil {
			return mutationResult{}, nil, nil, err
		} else if !ok {
			return mutationResult{}, nil, NewError(CodeBotSetupConflict, MessageBotSetupConflict, 409), nil
		}
		updated, err := tx.GetSetupSessionByID(ctx, session.ID)
		if err != nil {
			return mutationResult{}, nil, nil, err
		}
		bot, err := tx.GetBot(ctx, session.SpaceID, session.BotID)
		if err != nil {
			return mutationResult{}, nil, nil, err
		}
		return mutationResult{value: updated.Public(bot), targetID: session.ID}, nil, nil, nil
	})
	if err != nil {
		return SetupSession{}, err
	}
	return result.value.(SetupSession), nil
}

func (s *Service) GetSetupStatus(ctx context.Context, input SetupStatusInput) (SetupSession, error) {
	setupID, validationErr := NormalizeSetupID(input.SetupID)
	if validationErr != nil {
		return SetupSession{}, validationErr
	}
	session, err := s.repo.GetSetupSessionByID(ctx, setupID)
	if err != nil {
		return SetupSession{}, normalizeError(err)
	}
	if session == nil {
		return SetupSession{}, notFoundError(CodeBotSetupNotFound, MessageBotSetupNotFound)
	}
	session, err = s.expireSetupIfNeeded(ctx, session)
	if err != nil {
		return SetupSession{}, err
	}
	bot, err := s.repo.GetBot(ctx, session.SpaceID, session.BotID)
	if err != nil {
		return SetupSession{}, normalizeError(err)
	}
	return session.Public(bot), nil
}

func (s *Service) ApproveSetupSession(ctx context.Context, input ApproveSetupInput) (SetupSession, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return SetupSession{}, domainErr
	}
	setupID, validationErr := NormalizeSetupID(input.SetupID)
	if validationErr != nil {
		return SetupSession{}, validationErr
	}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: "bot.setup.approve", targetType: "agent_bot_setup", targetID: setupID}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		session, err := tx.GetSetupSessionByID(ctx, setupID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if session == nil || session.SpaceID != spaceID || session.OwnerUserID != actor.ID {
			return mutationResult{}, rejected(notFoundError(CodeBotSetupNotFound, MessageBotSetupNotFound)), nil
		}
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, session.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		if err := tx.Lock(ctx, setupLockKey(setupID)); err != nil {
			return mutationResult{}, nil, err
		}
		session, err = tx.GetSetupSessionByID(ctx, setupID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if session == nil || session.SpaceID != spaceID || session.OwnerUserID != actor.ID {
			return mutationResult{}, rejected(notFoundError(CodeBotSetupNotFound, MessageBotSetupNotFound)), nil
		}
		if session.Status != SetupStatusCreated && session.Status != SetupStatusAwaitingUser {
			return mutationResult{}, rejected(NewError(CodeBotSetupNotApprovable, MessageBotSetupNotApprovable, 409)), nil
		}
		if isExpiredAt(session.ExpiresAt, now) {
			if _, expireErr := tx.ExpireSetupSession(ctx, setupID, []string{SetupStatusCreated, SetupStatusAwaitingUser, SetupStatusApproved}, now); expireErr != nil {
				return mutationResult{}, nil, expireErr
			}
			return mutationResult{}, rejected(NewError(CodeBotSetupNotApprovable, MessageBotSetupNotApprovable, 409)), nil
		}
		bot, err := s.ownerBot(ctx, tx, actor, spaceID, session.BotID)
		if err != nil {
			return mutationResult{}, rejectionFromError(err), nil
		}
		if bot.Status != BotStatusActive {
			return mutationResult{}, rejected(NewError(CodeBotNotActive, "Bot 当前未运行", 409)), nil
		}
		approvedScopes, scopeErr := ValidateSetupApprovalScopes(input.Scopes, session.RequestedScopes)
		if scopeErr != nil {
			return mutationResult{}, rejected(scopeErr), nil
		}
		approvedConversations, conversationErr := ValidateSetupApprovalConversations(input.ConversationIDs, session.RequestedConversations)
		if conversationErr != nil {
			return mutationResult{}, rejected(conversationErr), nil
		}
		if ok, err := tx.ApproveSetupSession(ctx, setupID, []string{SetupStatusCreated, SetupStatusAwaitingUser}, approvedScopes, approvedConversations, now); err != nil {
			return mutationResult{}, nil, err
		} else if !ok {
			return mutationResult{}, rejected(NewError(CodeBotSetupConflict, MessageBotSetupConflict, 409)), nil
		}
		updated, err := tx.GetSetupSessionByID(ctx, setupID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		return mutationResult{value: updated.Public(bot), targetID: setupID}, nil, nil
	})
	if err != nil {
		return SetupSession{}, err
	}
	return result.value.(SetupSession), nil
}

func (s *Service) DenySetupSession(ctx context.Context, input DenySetupInput) (SetupSession, error) {
	spaceID, domainErr := s.space(input.SpaceID)
	if domainErr != nil {
		return SetupSession{}, domainErr
	}
	setupID, validationErr := NormalizeSetupID(input.SetupID)
	if validationErr != nil {
		return SetupSession{}, validationErr
	}
	result, err := s.mutate(ctx, spaceID, input.ActorID, input.Meta, mutationEvidence{action: "bot.setup.deny", targetType: "agent_bot_setup", targetID: setupID}, func(tx Tx, actor *auth.Actor, now time.Time) (mutationResult, *rejection, error) {
		session, err := tx.GetSetupSessionByID(ctx, setupID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		if session == nil || session.SpaceID != spaceID || session.OwnerUserID != actor.ID {
			return mutationResult{}, rejected(notFoundError(CodeBotSetupNotFound, MessageBotSetupNotFound)), nil
		}
		if err := tx.Lock(ctx, botLifecycleLockKey(spaceID, session.BotID)); err != nil {
			return mutationResult{}, nil, err
		}
		if err := tx.Lock(ctx, setupLockKey(setupID)); err != nil {
			return mutationResult{}, nil, err
		}
		if session.Status != SetupStatusCreated && session.Status != SetupStatusAwaitingUser {
			return mutationResult{}, rejected(NewError(CodeBotSetupNotDeniable, MessageBotSetupNotDeniable, 409)), nil
		}
		if isExpiredAt(session.ExpiresAt, now) {
			if _, expireErr := tx.ExpireSetupSession(ctx, setupID, []string{SetupStatusCreated, SetupStatusAwaitingUser, SetupStatusApproved}, now); expireErr != nil {
				return mutationResult{}, nil, expireErr
			}
			return mutationResult{}, rejected(NewError(CodeBotSetupNotDeniable, MessageBotSetupNotDeniable, 409)), nil
		}
		if ok, err := tx.DenySetupSession(ctx, setupID, []string{SetupStatusCreated, SetupStatusAwaitingUser}, now); err != nil {
			return mutationResult{}, nil, err
		} else if !ok {
			return mutationResult{}, rejected(NewError(CodeBotSetupConflict, MessageBotSetupConflict, 409)), nil
		}
		updated, err := tx.GetSetupSessionByID(ctx, setupID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		bot, err := tx.GetBot(ctx, spaceID, session.BotID)
		if err != nil {
			return mutationResult{}, nil, err
		}
		return mutationResult{value: updated.Public(bot), targetID: setupID}, nil, nil
	})
	if err != nil {
		return SetupSession{}, err
	}
	return result.value.(SetupSession), nil
}

func (s *Service) ExchangeSetupSession(ctx context.Context, input ExchangeSetupInput) (struct {
	Token   IssuedToken
	Session SetupSession
}, error) {
	setupID, validationErr := NormalizeSetupID(input.SetupID)
	if validationErr != nil {
		return struct {
			Token   IssuedToken
			Session SetupSession
		}{}, validationErr
	}
	result, err := s.setupMutation(ctx, setupID, "bot.setup.exchange", input.Meta, func(tx Tx, session *SetupSessionRecord, now time.Time) (mutationResult, *auth.Actor, *Error, error) {
		if session.Status != SetupStatusApproved {
			return mutationResult{}, nil, NewError(CodeBotSetupNotApproved, MessageBotSetupNotApproved, 409), nil
		}
		if isExpiredAt(session.ExpiresAt, now) {
			return mutationResult{}, nil, NewError(CodeBotSetupNotApproved, MessageBotSetupNotApproved, 409), nil
		}
		actor, err := s.lookupActor(ctx, tx, session.SpaceID, session.OwnerUserID)
		if err != nil {
			return mutationResult{}, nil, nil, err
		}
		bot, err := s.ownerBot(ctx, tx, actor, session.SpaceID, session.BotID)
		if err != nil {
			return mutationResult{}, actor, rejectionError(err), nil
		}
		if bot.Status != BotStatusActive {
			return mutationResult{}, actor, NewError(CodeBotNotActive, "Bot 当前未运行", 409), nil
		}
		protocol, validationErr := NormalizeSetupProtocol(input.ProtocolVersion)
		if validationErr != nil {
			return mutationResult{}, actor, validationErr, nil
		}
		clientName, validationErr := NormalizeSetupClient(input.ClientName)
		if validationErr != nil {
			return mutationResult{}, actor, validationErr, nil
		}
		clientVersion, validationErr := NormalizeSetupClient(input.ClientVersion)
		if validationErr != nil {
			return mutationResult{}, actor, validationErr, nil
		}
		tokenRecord, raw, issueErr := s.newTokenRecord(bot, session.ApprovedScopes, "", now)
		if issueErr != nil {
			return mutationResult{}, actor, issueErr, nil
		}
		if err := tx.InsertToken(ctx, tokenRecord); err != nil {
			if isUniqueError(err) {
				return mutationResult{}, actor, NewError(CodeBotTokenIssueFailed, MessageBotTokenIssueFailed, 503), nil
			}
			return mutationResult{}, actor, nil, err
		}
		if ok, err := tx.ExchangeSetupSession(ctx, session.ID, []string{SetupStatusApproved}, valueOrEmpty(clientName), valueOrEmpty(clientVersion), protocol, now); err != nil {
			return mutationResult{}, actor, nil, err
		} else if !ok {
			return mutationResult{}, actor, NewError(CodeBotSetupConflict, MessageBotSetupConflict, 409), nil
		}
		updated, err := tx.GetSetupSessionByID(ctx, session.ID)
		if err != nil {
			return mutationResult{}, actor, nil, err
		}
		return mutationResult{value: struct {
			Token   IssuedToken
			Session SetupSession
		}{Token: IssuedToken{Token: tokenRecord.Public(""), Raw: raw}, Session: updated.Public(bot)}, targetID: session.ID}, actor, nil, nil
	})
	if err != nil {
		return struct {
			Token   IssuedToken
			Session SetupSession
		}{}, err
	}
	return result.value.(struct {
		Token   IssuedToken
		Session SetupSession
	}), nil
}

// setupMutation applies the same lock order used by lifecycle operations:
// Bot lock first, then setup lock. External Agent calls have no authenticated
// actor, so their audit rows retain only space, operation, target and reason.
func (s *Service) setupMutation(ctx context.Context, setupID, action string, meta RequestMeta, fn func(Tx, *SetupSessionRecord, time.Time) (mutationResult, *auth.Actor, *Error, error)) (mutationResult, error) {
	if s == nil || s.repo == nil {
		return mutationResult{}, internalError("workspace agent bot setup", errors.New("repository is required"))
	}
	initial, err := s.repo.GetSetupSessionByID(ctx, setupID)
	if err != nil {
		return mutationResult{}, normalizeError(err)
	}
	if initial == nil {
		return mutationResult{}, notFoundError(CodeBotSetupNotFound, MessageBotSetupNotFound)
	}
	var output mutationResult
	var actor *auth.Actor
	var rejectedErr *Error
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, botLifecycleLockKey(initial.SpaceID, initial.BotID)); err != nil {
			return err
		}
		if err := tx.Lock(ctx, setupLockKey(setupID)); err != nil {
			return err
		}
		session, err := tx.GetSetupSessionByID(ctx, setupID)
		if err != nil {
			return err
		}
		if session == nil {
			rejectedErr = notFoundError(CodeBotSetupNotFound, MessageBotSetupNotFound)
		} else {
			now := s.nowUTC()
			if session.Status != SetupStatusExchanged && session.Status != SetupStatusDenied && session.Status != SetupStatusExpired && session.Status != SetupStatusRevoked && isExpiredAt(session.ExpiresAt, now) {
				changed, expireErr := tx.ExpireSetupSession(ctx, session.ID, []string{SetupStatusCreated, SetupStatusAwaitingUser, SetupStatusApproved}, now)
				if expireErr != nil {
					return expireErr
				}
				if changed {
					if err := tx.WriteAudit(ctx, s.auditInput(nil, session.SpaceID, RequestMeta{}, mutationEvidence{action: "bot.setup.expire", targetType: "agent_bot_setup", targetID: session.ID}, "success", "", now)); err != nil {
						return err
					}
					fresh, readErr := tx.GetSetupSessionByID(ctx, session.ID)
					if readErr != nil {
						return readErr
					}
					session = fresh
				}
			}
			output, actor, rejectedErr, err = fn(tx, session, now)
			if err != nil {
				return err
			}
		}
		if rejectedErr != nil {
			return tx.WriteAudit(ctx, s.auditInput(actor, initial.SpaceID, meta, mutationEvidence{action: action, targetType: "agent_bot_setup", targetID: setupID}, "rejected", rejectedErr.Code, s.nowUTC()))
		}
		return tx.WriteAudit(ctx, s.auditInput(actor, initial.SpaceID, meta, mutationEvidence{action: action, targetType: "agent_bot_setup", targetID: output.targetID}, "success", "", s.nowUTC()))
	})
	if err != nil {
		return mutationResult{}, normalizeError(err)
	}
	if rejectedErr != nil {
		return mutationResult{}, rejectedErr
	}
	return output, nil
}

func (s *Service) expireSetupIfNeeded(ctx context.Context, session *SetupSessionRecord) (*SetupSessionRecord, error) {
	if session == nil || session.Status == SetupStatusExchanged || session.Status == SetupStatusDenied || session.Status == SetupStatusExpired || session.Status == SetupStatusRevoked || !isExpiredAt(session.ExpiresAt, s.nowUTC()) {
		return session, nil
	}
	var changed bool
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, botLifecycleLockKey(session.SpaceID, session.BotID)); err != nil {
			return err
		}
		if err := tx.Lock(ctx, setupLockKey(session.ID)); err != nil {
			return err
		}
		fresh, err := tx.GetSetupSessionByID(ctx, session.ID)
		if err != nil {
			return err
		}
		if fresh == nil || fresh.Status == SetupStatusExpired || !isExpiredAt(fresh.ExpiresAt, s.nowUTC()) {
			return nil
		}
		changed, err = tx.ExpireSetupSession(ctx, session.ID, []string{SetupStatusCreated, SetupStatusAwaitingUser, SetupStatusApproved}, s.nowUTC())
		if err != nil {
			return err
		}
		if changed {
			return tx.WriteAudit(ctx, s.auditInput(nil, fresh.SpaceID, RequestMeta{}, mutationEvidence{action: "bot.setup.expire", targetType: "agent_bot_setup", targetID: fresh.ID}, "success", "", s.nowUTC()))
		}
		return nil
	})
	if err != nil {
		return nil, normalizeError(err)
	}
	if changed {
		fresh, readErr := s.repo.GetSetupSessionByID(ctx, session.ID)
		if readErr != nil {
			return nil, normalizeError(readErr)
		}
		return fresh, nil
	}
	return session, nil
}

func rejectionFromError(err error) *rejection {
	domainErr := asDomainError(err)
	if domainErr == nil {
		return nil
	}
	return rejected(domainErr)
}

func rejectionError(err error) *Error {
	if domainErr := asDomainError(err); domainErr != nil {
		return domainErr
	}
	return internalError("workspace agent bot operation", err)
}

func asDomainError(err error) *Error {
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return nil
}

func botLifecycleLockKey(spaceID, botID string) string {
	return "workspace-agent-bot:lifecycle:" + spaceID + ":" + botID
}

func botOwnerCreateLockKey(spaceID, ownerUserID string) string {
	return "workspace-agent-bot:create:" + spaceID + ":" + ownerUserID
}

func setupLockKey(setupID string) string { return "workspace-agent-bot:setup:" + setupID }

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func stringPtr(value string) *string {
	return &value
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func isUniqueError(err error) bool {
	if err == nil {
		return false
	}
	var coded interface{ SQLState() string }
	if errors.As(err, &coded) && coded.SQLState() == "23505" {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "duplicate key") || strings.Contains(strings.ToLower(err.Error()), "unique constraint")
}

func NormalizeBotName(value string) (string, *Error) {
	value = strings.TrimSpace(normNFKC(value))
	if value == "" || utf8.RuneCountInString(value) > MaxBotNameCodePoints || !utf8.ValidString(value) {
		return "", validationError(CodeBotInvalidName, MessageBotInvalidName)
	}
	for _, r := range value {
		if r <= 0x1f || r == 0x7f {
			return "", validationError(CodeBotInvalidName, MessageBotInvalidName)
		}
	}
	return value, nil
}

func NormalizeNameKey(value string) string {
	return strings.ToLower(strings.TrimSpace(normNFKC(value)))
}

func IsReservedBotName(value string) bool {
	key := NormalizeNameKey(value)
	if key == "" {
		return false
	}
	for _, reserved := range ReservedBotNames {
		if NormalizeNameKey(reserved) == key {
			return true
		}
	}
	return false
}

func normNFKC(value string) string {
	return norm.NFKC.String(value)
}

func ValidateBotScopes(input []string) ([]string, *Error) {
	scopes := input
	if scopes == nil {
		scopes = BotDefaultScopes
	}
	if len(scopes) == 0 {
		return nil, validationError(CodeBotInvalidScope, MessageBotInvalidScope)
	}
	seen := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		if !contains(BotScopeAllowlist, scope) {
			return nil, validationError(CodeBotInvalidScope, MessageBotInvalidScope)
		}
		if _, exists := seen[scope]; exists {
			return nil, validationError(CodeBotInvalidScope, MessageBotInvalidScope)
		}
		seen[scope] = struct{}{}
	}
	result := make([]string, 0, len(seen))
	for _, scope := range BotScopeAllowlist {
		if _, exists := seen[scope]; exists {
			result = append(result, scope)
		}
	}
	return result, nil
}

func NormalizeExpiry(value string, current time.Time) (*time.Time, *Error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil, validationError(CodeBotInvalidExpiry, MessageBotInvalidExpiry)
	}
	expiresAt = expiresAt.UTC().Truncate(time.Millisecond)
	current = current.UTC().Truncate(time.Millisecond)
	if !expiresAt.After(current) || expiresAt.After(current.Add(MaxTokenExpiry)) {
		return nil, validationError(CodeBotInvalidExpiry, MessageBotInvalidExpiry)
	}
	return &expiresAt, nil
}

func HashBotToken(value string) string {
	if !IsBotToken(value) {
		return ""
	}
	return hashToken(value)
}

func IsBotToken(value string) bool {
	if !strings.HasPrefix(value, BotTokenPrefix) {
		return false
	}
	encoded := strings.TrimPrefix(value, BotTokenPrefix)
	if len(encoded) < 43 {
		return false
	}
	for _, r := range encoded {
		if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' && r != '-' {
			return false
		}
	}
	return true
}

func MaskBotToken() string { return BotTokenPrefix + "••••••••" }

func invalidBotTokenError() *Error { return NewError(CodeBotInvalidToken, MessageBotInvalidToken, 401) }

func isExpired(value *time.Time, now time.Time) bool {
	return value != nil && !value.After(now)
}

func isExpiredAt(value, now time.Time) bool { return !value.After(now) }

func NormalizeSetupID(value string) (string, *Error) {
	value = strings.TrimSpace(value)
	if !setupIDPattern.MatchString(value) {
		return "", validationError(CodeBotSetupInvalid, MessageBotSetupInvalid)
	}
	return value, nil
}

func NormalizeSetupConversationIDs(values []string) ([]string, *Error) {
	if values == nil {
		return []string{}, nil
	}
	if len(values) > 200 {
		return nil, validationError(CodeBotSetupInvalid, "配置会话的会话范围无效")
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if !setupConversationPat.MatchString(value) {
			return nil, validationError(CodeBotSetupInvalid, "配置会话的会话范围无效")
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

func NormalizeSetupClient(value string) (*string, *Error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if !setupClientPattern.MatchString(value) {
		return nil, validationError(CodeBotSetupInvalid, "Agent 客户端标识无效")
	}
	return stringPtr(value), nil
}

func NormalizeSetupProtocol(value string) (string, *Error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "v1", nil
	}
	if value != "v1" {
		return "", NewError(CodeBotSetupProtocolUnsupported, MessageBotSetupProtocolUnsupported, 409)
	}
	return "v1", nil
}

func NormalizeSetupCapabilities(values []string) ([]string, *Error) {
	if values == nil {
		return []string{}, nil
	}
	if len(values) > 32 {
		return nil, validationError(CodeBotSetupInvalid, "Agent 能力声明无效")
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if !setupCapabilityPat.MatchString(value) {
			return nil, validationError(CodeBotSetupInvalid, "Agent 能力声明无效")
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

func ValidateSetupApprovalScopes(values, requested []string) ([]string, *Error) {
	approved := values
	if approved == nil {
		approved = requested
	}
	canonical, err := ValidateBotScopes(approved)
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]struct{}, len(requested))
	for _, scope := range requested {
		allowed[scope] = struct{}{}
	}
	for _, scope := range canonical {
		if _, ok := allowed[scope]; !ok {
			return nil, forbiddenError(CodeBotSetupScopeNotRequested, MessageBotSetupScopeNotRequested)
		}
	}
	return canonical, nil
}

func ValidateSetupApprovalConversations(values, requested []string) ([]string, *Error) {
	approved := values
	if approved == nil {
		approved = requested
	}
	canonical, err := NormalizeSetupConversationIDs(approved)
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]struct{}, len(requested))
	for _, conversationID := range requested {
		allowed[conversationID] = struct{}{}
	}
	for _, conversationID := range canonical {
		if _, ok := allowed[conversationID]; !ok {
			return nil, forbiddenError(CodeBotSetupConversationNotRequested, MessageBotSetupConversationNotRequested)
		}
	}
	return canonical, nil
}

func hasPatch(input UpdateSettingsInput, key string) bool {
	if _, ok := input.Patch[key]; ok {
		return true
	}
	switch key {
	case "visibilityPolicy":
		return input.VisibilityPolicy != nil
	case "allowedMemberIds":
		return input.AllowedMemberIDs != nil
	case "allowDirect":
		return input.AllowDirect != nil
	case "allowGroup":
		return input.AllowGroup != nil
	case "groupInviterPolicy":
		return input.GroupInviterPolicy != nil
	case "requireOwnerApproval":
		return input.RequireOwnerApproval != nil
	case "proactiveEnabled":
		return input.ProactiveEnabled != nil
	case "triggerPolicy":
		return input.TriggerPolicy != nil
	case "welcomeMessage":
		return input.WelcomeMessage != nil
	case "description":
		return input.Description != nil
	case "avatarUrl":
		return input.AvatarURL != nil
	case "showCreator":
		return input.ShowCreator != nil
	case "maxContextMessages":
		return input.MaxContextMessages != nil
	case "maxContextChars":
		return input.MaxContextChars != nil
	case "maxContextTokens":
		return input.MaxContextTokens != nil
	case "contextWindowSeconds":
		return input.ContextWindowSeconds != nil
	case "includeReplies":
		return input.IncludeReplies != nil
	case "includeSystemEvents":
		return input.IncludeSystemEvents != nil
	case "includeAttachmentMetadata":
		return input.IncludeAttachmentMetadata != nil
	case "allowAttachmentPreview":
		return input.AllowAttachmentPreview != nil
	case "longTermSummaryEnabled":
		return input.LongTermSummaryEnabled != nil
	default:
		return false
	}
}

func applySettingsPatch(current SettingsRecord, input UpdateSettingsInput, at time.Time) (SettingsRecord, *Error) {
	patch := make(map[string]any, len(input.Patch)+20)
	for key, value := range input.Patch {
		patch[key] = value
	}
	if input.VisibilityPolicy != nil {
		patch["visibilityPolicy"] = *input.VisibilityPolicy
	}
	if input.AllowedMemberIDs != nil {
		patch["allowedMemberIds"] = *input.AllowedMemberIDs
	}
	if input.AllowDirect != nil {
		patch["allowDirect"] = *input.AllowDirect
	}
	if input.AllowGroup != nil {
		patch["allowGroup"] = *input.AllowGroup
	}
	if input.GroupInviterPolicy != nil {
		patch["groupInviterPolicy"] = *input.GroupInviterPolicy
	}
	if input.RequireOwnerApproval != nil {
		patch["requireOwnerApproval"] = *input.RequireOwnerApproval
	}
	if input.ProactiveEnabled != nil {
		patch["proactiveEnabled"] = *input.ProactiveEnabled
	}
	if input.TriggerPolicy != nil {
		patch["triggerPolicy"] = *input.TriggerPolicy
	}
	if input.WelcomeMessage != nil {
		patch["welcomeMessage"] = *input.WelcomeMessage
	}
	if input.Description != nil {
		patch["description"] = *input.Description
	}
	if input.AvatarURL != nil {
		patch["avatarUrl"] = *input.AvatarURL
	}
	if input.ShowCreator != nil {
		patch["showCreator"] = *input.ShowCreator
	}
	if input.MaxContextMessages != nil {
		patch["maxContextMessages"] = *input.MaxContextMessages
	}
	if input.MaxContextChars != nil {
		patch["maxContextChars"] = *input.MaxContextChars
	}
	if input.MaxContextTokens != nil {
		patch["maxContextTokens"] = *input.MaxContextTokens
	}
	if input.ContextWindowSeconds != nil {
		patch["contextWindowSeconds"] = *input.ContextWindowSeconds
	}
	if input.IncludeReplies != nil {
		patch["includeReplies"] = *input.IncludeReplies
	}
	if input.IncludeSystemEvents != nil {
		patch["includeSystemEvents"] = *input.IncludeSystemEvents
	}
	if input.IncludeAttachmentMetadata != nil {
		patch["includeAttachmentMetadata"] = *input.IncludeAttachmentMetadata
	}
	if input.AllowAttachmentPreview != nil {
		patch["allowAttachmentPreview"] = *input.AllowAttachmentPreview
	}
	if input.LongTermSummaryEnabled != nil {
		patch["longTermSummaryEnabled"] = *input.LongTermSummaryEnabled
	}
	known := map[string]struct{}{
		"visibilityPolicy": {}, "allowedMemberIds": {}, "allowDirect": {}, "allowGroup": {}, "groupInviterPolicy": {},
		"requireOwnerApproval": {}, "proactiveEnabled": {}, "triggerPolicy": {}, "welcomeMessage": {}, "description": {},
		"avatarUrl": {}, "showCreator": {}, "maxContextMessages": {}, "maxContextChars": {}, "maxContextTokens": {},
		"contextWindowSeconds": {}, "includeReplies": {}, "includeSystemEvents": {}, "includeAttachmentMetadata": {},
		"allowAttachmentPreview": {}, "longTermSummaryEnabled": {},
	}
	for key := range patch {
		if _, ok := known[key]; !ok {
			return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 设置包含未知字段")
		}
	}
	for key, value := range patch {
		switch key {
		case "visibilityPolicy":
			stringValue, ok := value.(string)
			if !ok || !contains([]string{VisibilityPrivate, VisibilitySpecifiedMember, VisibilitySpaceMembers, VisibilityGroups}, stringValue) {
				return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 可见范围无效")
			}
			current.VisibilityPolicy = stringValue
		case "allowedMemberIds":
			ids, ok := stringSliceValue(value)
			if !ok || len(ids) > 200 {
				return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 成员名单无效")
			}
			seen := make(map[string]struct{}, len(ids))
			current.AllowedMemberIDs = make([]string, 0, len(ids))
			for _, id := range ids {
				if !memberIDPattern.MatchString(id) {
					return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 成员名单无效")
				}
				if _, exists := seen[id]; exists {
					continue
				}
				seen[id] = struct{}{}
				current.AllowedMemberIDs = append(current.AllowedMemberIDs, id)
			}
			sort.Strings(current.AllowedMemberIDs)
		case "allowDirect", "allowGroup", "requireOwnerApproval", "proactiveEnabled", "showCreator", "includeReplies", "includeSystemEvents", "includeAttachmentMetadata", "allowAttachmentPreview", "longTermSummaryEnabled":
			valueBool, ok := value.(bool)
			if !ok {
				return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 开关设置无效")
			}
			switch key {
			case "allowDirect":
				current.AllowDirect = valueBool
			case "allowGroup":
				current.AllowGroup = valueBool
			case "requireOwnerApproval":
				current.RequireOwnerApproval = valueBool
			case "proactiveEnabled":
				current.ProactiveEnabled = valueBool
			case "showCreator":
				current.ShowCreator = valueBool
			case "includeReplies":
				current.IncludeReplies = valueBool
			case "includeSystemEvents":
				current.IncludeSystemEvents = valueBool
			case "includeAttachmentMetadata":
				current.IncludeAttachmentMetadata = valueBool
			case "allowAttachmentPreview":
				current.AllowAttachmentPreview = valueBool
			case "longTermSummaryEnabled":
				current.LongTermSummaryEnabled = valueBool
			}
		case "groupInviterPolicy":
			valueString, ok := value.(string)
			if !ok || !contains([]string{"owner", "group_admin", "any_member"}, valueString) {
				return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 群聊策略无效")
			}
			current.GroupInviterPolicy = valueString
		case "triggerPolicy":
			valueString, ok := value.(string)
			if !ok || valueString != TriggerMentionOrCommand {
				return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 触发策略无效")
			}
			current.TriggerPolicy = valueString
		case "welcomeMessage", "description":
			if value == nil {
				if key == "welcomeMessage" {
					current.WelcomeMessage = nil
				} else {
					current.Description = nil
				}
				continue
			}
			valueString, ok := value.(string)
			if !ok || len(valueString) > 4000 {
				return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 文本设置无效")
			}
			if key == "welcomeMessage" {
				current.WelcomeMessage = stringPtr(valueString)
			} else {
				current.Description = stringPtr(valueString)
			}
		case "avatarUrl":
			if value == nil {
				current.AvatarURL = nil
				continue
			}
			valueString, ok := value.(string)
			if !ok || len(valueString) > 2048 || (!strings.HasPrefix(valueString, "/api/") && !strings.HasPrefix(valueString, "/assets/")) {
				return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 头像地址无效")
			}
			current.AvatarURL = stringPtr(valueString)
		case "maxContextMessages", "maxContextChars", "maxContextTokens", "contextWindowSeconds":
			valueInt, ok := intValue(value)
			if !ok || valueInt <= 0 {
				return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 上下文限制无效")
			}
			switch key {
			case "maxContextMessages":
				if valueInt > 200 {
					return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 上下文限制无效")
				}
				current.MaxContextMessages = valueInt
			case "maxContextChars":
				if valueInt > 200000 {
					return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 上下文限制无效")
				}
				current.MaxContextChars = valueInt
			case "maxContextTokens":
				if valueInt > 100000 {
					return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 上下文限制无效")
				}
				current.MaxContextTokens = valueInt
			case "contextWindowSeconds":
				if valueInt > 2592000 {
					return SettingsRecord{}, validationError(CodeBotInvalidSettings, "Bot 上下文限制无效")
				}
				current.ContextWindowSeconds = valueInt
			}
		}
	}
	current.UpdatedAt = at
	if current.AllowedMemberIDs == nil {
		current.AllowedMemberIDs = []string{}
	}
	return current, nil
}

func stringSliceValue(value any) ([]string, bool) {
	switch values := value.(type) {
	case []string:
		return append([]string{}, values...), true
	case []any:
		result := make([]string, 0, len(values))
		for _, value := range values {
			stringValue, ok := value.(string)
			if !ok {
				return nil, false
			}
			result = append(result, stringValue)
		}
		return result, true
	default:
		return nil, false
	}
}

func intValue(value any) (int, bool) {
	switch value := value.(type) {
	case int:
		return value, true
	case int8:
		return int(value), true
	case int16:
		return int(value), true
	case int32:
		return int(value), true
	case int64:
		if int64(int(value)) != value {
			return 0, false
		}
		return int(value), true
	case uint:
		if uint(int(value)) != value {
			return 0, false
		}
		return int(value), true
	case uint64:
		if uint64(int(value)) != value {
			return 0, false
		}
		return int(value), true
	case float64:
		if value != float64(int(value)) {
			return 0, false
		}
		return int(value), true
	case json.Number:
		parsed, err := value.Int64()
		if err != nil {
			return 0, false
		}
		return intValue(parsed)
	default:
		return 0, false
	}
}

func normalizeTokenScopesJSON(scopes []string) string {
	data, _ := json.Marshal(cloneStrings(scopes))
	return string(data)
}
