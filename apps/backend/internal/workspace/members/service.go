package members

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type Clock func() time.Time
type IDFactory func() (string, error)

type ServiceOptions struct {
	Repository Repository
	SpaceID    string
	Now        Clock
	IDFactory  IDFactory
}

type Service struct {
	repo      Repository
	spaceID   string
	now       Clock
	idFactory IDFactory
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
		idFactory = func() (string, error) {
			id, err := uuid.NewRandom()
			if err != nil {
				return "", err
			}
			return id.String(), nil
		}
	}
	return &Service{repo: options.Repository, spaceID: spaceID, now: now, idFactory: idFactory}
}

func NewServiceForRepository(repo Repository) *Service {
	return NewService(ServiceOptions{Repository: repo})
}

func (s *Service) Repository() Repository {
	if s == nil {
		return nil
	}
	return s.repo
}

func (s *Service) space() string {
	if s == nil || strings.TrimSpace(s.spaceID) == "" {
		return DefaultSpaceID
	}
	return s.spaceID
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

func (s *Service) newID() (string, error) {
	if s == nil || s.idFactory == nil {
		return "", errors.New("workspace member id factory is required")
	}
	id, err := s.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("workspace member id factory returned an empty id")
	}
	return id, nil
}

type rejection struct {
	err   *Error
	audit AuditInput
}

// inTransaction resolves the actor again inside the transaction and commits
// deliberate rejection audits. Any other error rolls back both state and
// evidence, preserving the Node service's mutation boundary.
func (s *Service) inTransaction(ctx context.Context, actorID string, meta auth.RequestMeta, fn func(Tx, *auth.Actor, time.Time) (any, *rejection, error)) (any, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace member service", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	if fn == nil {
		return nil, internalError("workspace member transaction", errors.New("callback is required"))
	}
	meta = meta.Safe()
	var result any
	var rejected *rejection
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return errors.New("transaction is required")
		}
		actor, err := s.lookupActor(ctx, tx, actorID)
		if err != nil {
			return err
		}
		now := s.nowUTC()
		result, rejected, err = fn(tx, actor, now)
		if err != nil {
			return err
		}
		if rejected == nil {
			return nil
		}
		rejected.audit, err = s.auditFor(actor, meta, rejected.audit, now)
		if err != nil {
			return err
		}
		if err := tx.WriteAudit(ctx, rejected.audit); err != nil {
			return internalError("write member rejection audit", err)
		}
		return nil
	})
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if rejected != nil {
		return nil, rejected.err
	}
	return result, nil
}

func (s *Service) lookupActor(ctx context.Context, repo ReadRepository, actorID string) (*auth.Actor, error) {
	actor, err := repo.LookupActor(ctx, s.space(), strings.TrimSpace(actorID))
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if actor == nil {
		return nil, authRequiredError()
	}
	if actor.Kind != "human" {
		return nil, identityForbiddenError()
	}
	if strings.TrimSpace(actor.ID) == "" || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	return actor, nil
}

func (s *Service) readActor(ctx context.Context, actorID string) (*auth.Actor, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("workspace member service", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	return s.lookupActor(ctx, s.repo, actorID)
}

func (s *Service) auditFor(actor *auth.Actor, meta auth.RequestMeta, input AuditInput, now time.Time) (AuditInput, error) {
	id, err := s.newID()
	if err != nil {
		return AuditInput{}, internalError("generate workspace member audit id", err)
	}
	input.ID = id
	input.SpaceID = s.space()
	if actor != nil {
		input.ActorUserID = actor.ID
		input.ActorGitHubLogin = actor.GitHubLogin
	}
	safe := meta.Safe()
	input.RequestID = safe.RequestID
	input.IPAddress = safe.IPAddress
	input.UserAgent = safe.UserAgent
	input.CreatedAt = normalizeTime(now)
	if input.Result == "" {
		input.Result = "rejected"
	}
	return input, nil
}

func (s *Service) writeAudit(ctx context.Context, tx Tx, actor *auth.Actor, meta auth.RequestMeta, input AuditInput, now time.Time) error {
	input, err := s.auditFor(actor, meta, input, now)
	if err != nil {
		return err
	}
	if err := tx.WriteAudit(ctx, input); err != nil {
		return internalError("write workspace member audit", err)
	}
	return nil
}

func (s *Service) writeEvent(ctx context.Context, tx Tx, input EventInput, now time.Time) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := s.newID()
		if err != nil {
			return internalError("generate workspace member event id", err)
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" {
		input.SpaceID = s.space()
	}
	if input.CreatedAt.IsZero() {
		input.CreatedAt = now
	} else {
		input.CreatedAt = normalizeTime(input.CreatedAt)
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if err := tx.WriteEvent(ctx, input); err != nil {
		return internalError("write workspace member event", err)
	}
	return nil
}

func (s *Service) List(ctx context.Context, input ListInput) ([]Member, error) {
	actor, err := s.readActor(ctx, input.ActorID)
	if err != nil {
		return nil, err
	}
	records, err := s.repo.ListMemberRecords(ctx, s.space(), actor.ID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	options := input.Options
	query := strings.ToLower(strings.TrimSpace(options.Query))
	if query == "" {
		query = strings.ToLower(strings.TrimSpace(options.Q))
	}
	role := strings.TrimSpace(options.Role)
	kind := strings.TrimSpace(options.Kind)
	limit := options.Limit
	if limit <= 0 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}
	discoveryEnabled := utf8.RuneCountInString(query) >= 2
	items := make([]Member, 0, len(records))
	for _, record := range records {
		normallyVisible := record.NormallyVisible || record.ID == actor.ID || actor.Role == RoleOwner
		if !normallyVisible && !(discoveryEnabled && record.Kind == "human" && record.SearchDiscoverable &&
			(strings.Contains(strings.ToLower(pointerValue(record.Nickname)), query) || strings.Contains(strings.ToLower(record.GitHubLogin), query))) {
			continue
		}
		projected := projectMember(record, actor)
		if !normallyVisible {
			projected.Capabilities.CanJoinGroups = false
		}
		if role != "" && projected.Role != role {
			continue
		}
		if kind != "" && projected.Kind != kind {
			continue
		}
		if query != "" && !memberContains(projected, query) {
			continue
		}
		items = append(items, projected)
		if len(items) >= limit {
			break
		}
	}
	return items, nil
}

func (s *Service) ListMembers(ctx context.Context, actorID string, options ListOptions, meta auth.RequestMeta) ([]Member, error) {
	return s.List(ctx, ListInput{ActorID: actorID, Options: options, Meta: meta})
}

func (s *Service) UpdateOwnProfile(ctx context.Context, input UpdateOwnProfileInput) (Member, error) {
	nicknameSet := input.NicknameSet || input.Nickname != nil
	discoverableSet := input.SearchDiscoverableSet || input.SearchDiscoverable != nil
	recallReasonSet := input.RecallReasonSet || input.RecallReason != nil
	var nickname *string
	if nicknameSet && input.Nickname != nil {
		value := strings.TrimSpace(*input.Nickname)
		if value != "" {
			normalized, normalizationErr := normalizeProfileLabel(value, CodeProfileNicknameInvalid, MessageNicknameInvalid)
			if normalizationErr != nil {
				return Member{}, normalizationErr
			}
			nickname = &normalized
		}
	}
	var discoverable *bool
	if discoverableSet {
		if input.SearchDiscoverable == nil {
			return Member{}, validationError(CodeProfileSearchDiscoverableInvalid, MessageSearchDiscoverableInvalid)
		}
		value := *input.SearchDiscoverable
		discoverable = &value
	}
	var recallReason *string
	if recallReasonSet && input.RecallReason != nil {
		value := strings.TrimSpace(*input.RecallReason)
		if value != "" {
			normalized, normalizationErr := normalizeRecallReason(value)
			if normalizationErr != nil {
				return Member{}, normalizationErr
			}
			recallReason = &normalized
		}
	}
	if !nicknameSet && !discoverableSet && !recallReasonSet {
		actor, err := s.readActor(ctx, input.ActorID)
		if err != nil {
			return Member{}, err
		}
		record, err := s.repo.FindMemberRecord(ctx, s.space(), actor.ID, actor.ID)
		if err != nil {
			return Member{}, normalizeRepositoryError(err)
		}
		if record == nil {
			return Member{}, authRequiredError()
		}
		return projectMember(*record, actor), nil
	}
	result, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		if err := tx.UpdateOwnProfile(ctx, s.space(), actor.ID, nicknameSet, nickname, discoverableSet, discoverable, recallReasonSet, recallReason); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		record, err := tx.FindMemberRecord(ctx, s.space(), actor.ID, actor.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if record == nil {
			return nil, nil, authRequiredError()
		}
		payload, err := json.Marshal(map[string]string{"userId": actor.ID})
		if err != nil {
			return nil, nil, internalError("encode member profile event", err)
		}
		if err := s.writeEvent(ctx, tx, EventInput{Type: "workspace.member_updated", ActorID: actor.ID, TargetType: "user", TargetID: actor.ID, PayloadJSON: payload}, now); err != nil {
			return nil, nil, err
		}
		updates := 0
		if nicknameSet {
			updates++
		}
		if discoverableSet {
			updates++
		}
		if recallReasonSet {
			updates++
		}
		action := "profile.update"
		if updates == 1 && nicknameSet {
			action = "profile.nickname_update"
		} else if updates == 1 && discoverableSet {
			action = "profile.search_discoverable_update"
		} else if updates == 1 && recallReasonSet {
			action = "profile.recall_reason_update"
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: action, TargetType: "user", TargetID: actor.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		return projectMember(*record, actor), nil, nil
	})
	if err != nil {
		return Member{}, err
	}
	return result.(Member), nil
}

func (s *Service) UpdateMemberRemark(ctx context.Context, input RemarkInput) (Member, error) {
	remark, remarkErr := normalizeProfileLabel(input.Remark, CodeMemberRemarkInvalid, MessageRemarkInvalid)
	if remarkErr != nil {
		return Member{}, remarkErr
	}
	result, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		target, err := s.remarkTarget(ctx, tx, actor, input.UserID)
		if err != nil {
			return nil, nil, err
		}
		if err := tx.UpsertRemark(ctx, actor.ID, target.ID, remark, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		updated, err := tx.FindMemberRecord(ctx, s.space(), actor.ID, target.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if updated == nil {
			return nil, nil, memberNotFoundError()
		}
		return projectMember(*updated, actor), nil, nil
	})
	if err != nil {
		return Member{}, err
	}
	return result.(Member), nil
}

func (s *Service) RemoveMemberRemark(ctx context.Context, input RemarkInput) (Member, error) {
	result, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		target, err := s.remarkTarget(ctx, tx, actor, input.UserID)
		if err != nil {
			return nil, nil, err
		}
		if err := tx.DeleteRemark(ctx, actor.ID, target.ID); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		updated, err := tx.FindMemberRecord(ctx, s.space(), actor.ID, target.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if updated == nil {
			return nil, nil, memberNotFoundError()
		}
		return projectMember(*updated, actor), nil, nil
	})
	if err != nil {
		return Member{}, err
	}
	return result.(Member), nil
}

func (s *Service) remarkTarget(ctx context.Context, repo ReadRepository, actor *auth.Actor, userID string) (*MemberRecord, error) {
	target, err := repo.FindMemberRecord(ctx, s.space(), actor.ID, strings.TrimSpace(userID))
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if target == nil {
		return nil, memberNotFoundError()
	}
	if target.ID == actor.ID || target.Kind != "human" {
		return nil, validationError(CodeMemberRemarkUnsupported, MessageRemarkUnsupported)
	}
	if !target.NormallyVisible && actor.Role != RoleOwner {
		return nil, permissionDeniedError()
	}
	return target, nil
}

func (s *Service) GetVisibility(ctx context.Context, input VisibilityReadInput) (VisibilityRule, error) {
	viewerID := strings.TrimSpace(input.ViewerUserID)
	result, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		if denied := requireCapability(actor, CapabilityVisibilityManage); denied != nil {
			return nil, &rejection{err: denied, audit: AuditInput{Action: CapabilityVisibilityManage, TargetType: "member", TargetID: viewerID, Result: "rejected", Reason: "insufficient permission"}}, nil
		}
		viewer, err := tx.FindMemberRecord(ctx, s.space(), actor.ID, viewerID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if viewer == nil {
			return nil, nil, memberNotFoundError()
		}
		rule, err := tx.GetVisibilityRule(ctx, s.space(), viewer.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		return rule, nil, nil
	})
	if err != nil {
		return VisibilityRule{}, err
	}
	return result.(VisibilityRule), nil
}

func (s *Service) GetManagedMemberVisibility(ctx context.Context, input VisibilityReadInput) (VisibilityRule, error) {
	return s.GetVisibility(ctx, input)
}

func (s *Service) UpdateVisibility(ctx context.Context, input VisibilityInput) (VisibilityRule, error) {
	viewerID := strings.TrimSpace(input.ViewerUserID)
	visibleIDs := uniqueStrings(input.VisibleUserIDs)
	visibleIDs = filterVisibleIDs(visibleIDs, viewerID)
	result, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		if denied := requireCapability(actor, CapabilityVisibilityManage); denied != nil {
			return nil, &rejection{err: denied, audit: AuditInput{Action: CapabilityVisibilityManage, TargetType: "member", TargetID: viewerID, Result: "rejected", Reason: "insufficient permission"}}, nil
		}
		viewer, err := tx.FindMemberRecord(ctx, s.space(), actor.ID, viewerID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if viewer == nil {
			return nil, nil, memberNotFoundError()
		}
		for _, targetID := range visibleIDs {
			target, err := tx.FindMemberRecord(ctx, s.space(), actor.ID, targetID)
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			if target == nil {
				return nil, &rejection{err: memberNotFoundError(), audit: AuditInput{Action: "member.visibility_update", TargetType: "member", TargetID: viewer.ID, Result: "rejected", Reason: CodeMemberNotFound}}, nil
			}
		}
		if err := tx.ReplaceVisibilityGrants(ctx, s.space(), viewer.ID, actor.ID, visibleIDs, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		rule, err := tx.GetVisibilityRule(ctx, s.space(), viewer.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		payload, err := json.Marshal(map[string]string{"userId": viewer.ID})
		if err != nil {
			return nil, nil, internalError("encode member visibility event", err)
		}
		if err := s.writeEvent(ctx, tx, EventInput{Type: "workspace.member_visibility_updated", ActorID: actor.ID, TargetType: "user", TargetID: viewer.ID, PayloadJSON: payload}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "member.visibility_update", TargetType: "member", TargetID: viewer.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		return rule, nil, nil
	})
	if err != nil {
		return VisibilityRule{}, err
	}
	return result.(VisibilityRule), nil
}

func (s *Service) UpdateManagedMemberVisibility(ctx context.Context, input VisibilityInput) (VisibilityRule, error) {
	return s.UpdateVisibility(ctx, input)
}

func (s *Service) UpdateMemberRole(ctx context.Context, input RoleInput) (Member, error) {
	targetID := strings.TrimSpace(input.UserID)
	nextRole, roleErr := normalizeRole(input.Role)
	result, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		if denied := requireCapability(actor, CapabilityRoleUpdate); denied != nil {
			return nil, &rejection{err: denied, audit: AuditInput{Action: CapabilityRoleUpdate, TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "insufficient permission"}}, nil
		}
		if roleErr != nil {
			return nil, &rejection{err: roleErr, audit: AuditInput{Action: "member.role_update", TargetType: "member", TargetID: targetID, Result: "rejected", Reason: CodeRoleInvalid}}, nil
		}
		if targetID == actor.ID {
			return nil, &rejection{err: validationError(CodeMemberRoleInvalid, MessageMemberRoleInvalid), audit: AuditInput{Action: "member.role_update", TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "self role update"}}, nil
		}
		target, err := tx.FindMemberRecord(ctx, s.space(), actor.ID, targetID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if target == nil {
			return nil, &rejection{err: memberNotFoundError(), audit: AuditInput{Action: "member.role_update", TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "member not found"}}, nil
		}
		if !isMemberManagedIdentity(*target) {
			return nil, &rejection{err: validationError(CodeMemberSystemManaged, MessageMemberSystemManaged), audit: AuditInput{Action: "member.role_update", TargetType: "member", TargetID: target.ID, Result: "rejected", Reason: CodeMemberSystemManaged}}, nil
		}
		if err := tx.Lock(ctx, "workspace-members:"+s.space()); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		actor, err = s.lookupActor(ctx, tx, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if denied := requireCapability(actor, CapabilityRoleUpdate); denied != nil {
			return nil, &rejection{err: denied, audit: AuditInput{Action: CapabilityRoleUpdate, TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "insufficient permission"}}, nil
		}
		target, err = tx.FindMemberRecord(ctx, s.space(), actor.ID, target.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if target == nil {
			return nil, &rejection{err: memberNotFoundError(), audit: AuditInput{Action: "member.role_update", TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "member not found"}}, nil
		}
		if target.Role == RoleOwner && nextRole != RoleOwner {
			owners, err := tx.CountActiveOwners(ctx, s.space())
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			if owners <= 1 {
				return nil, &rejection{err: validationError(CodeMemberLastOwner, MessageMemberLastOwner), audit: AuditInput{Action: "member.role_update", TargetType: "member", TargetID: target.ID, Result: "rejected", Reason: "last owner"}}, nil
			}
		}
		oldRole := target.Role
		if err := tx.UpdateMemberRole(ctx, s.space(), target.ID, nextRole); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		updated, err := tx.FindMemberRecord(ctx, s.space(), actor.ID, target.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if updated == nil {
			return nil, nil, memberNotFoundError()
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "member.role_update", TargetType: "member", TargetID: target.ID, Result: "success", Reason: oldRole + "->" + nextRole}, now); err != nil {
			return nil, nil, err
		}
		payload, err := json.Marshal(map[string]any{"userId": target.ID, "role": nextRole, "member": projectMember(*updated, nil)})
		if err != nil {
			return nil, nil, internalError("encode member role event", err)
		}
		if err := s.writeEvent(ctx, tx, EventInput{Type: "workspace.member_updated", ActorID: actor.ID, TargetType: "user", TargetID: target.ID, PayloadJSON: payload}, now); err != nil {
			return nil, nil, err
		}
		return projectMember(*updated, actor), nil, nil
	})
	if err != nil {
		return Member{}, err
	}
	return result.(Member), nil
}

func (s *Service) RemoveMember(ctx context.Context, input RemoveInput) (RemoveResult, error) {
	targetID := strings.TrimSpace(input.UserID)
	result, err := s.inTransaction(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (any, *rejection, error) {
		if denied := requireCapability(actor, CapabilityRemove); denied != nil {
			return nil, &rejection{err: denied, audit: AuditInput{Action: CapabilityRemove, TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "insufficient permission"}}, nil
		}
		if targetID == actor.ID {
			return nil, &rejection{err: validationError(CodeMemberRemoveInvalid, MessageMemberRemoveInvalid), audit: AuditInput{Action: "member.remove", TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "self removal"}}, nil
		}
		target, err := tx.FindMemberRecord(ctx, s.space(), actor.ID, targetID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if target == nil {
			return nil, &rejection{err: memberNotFoundError(), audit: AuditInput{Action: "member.remove", TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "member not found"}}, nil
		}
		if !isMemberManagedIdentity(*target) {
			return nil, &rejection{err: validationError(CodeMemberSystemManaged, MessageMemberRemoveSystem), audit: AuditInput{Action: "member.remove", TargetType: "member", TargetID: target.ID, Result: "rejected", Reason: CodeMemberSystemManaged}}, nil
		}
		if err := tx.Lock(ctx, "workspace-members:"+s.space()); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		actor, err = s.lookupActor(ctx, tx, actor.ID)
		if err != nil {
			return nil, nil, err
		}
		if denied := requireCapability(actor, CapabilityRemove); denied != nil {
			return nil, &rejection{err: denied, audit: AuditInput{Action: CapabilityRemove, TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "insufficient permission"}}, nil
		}
		target, err = tx.FindMemberRecord(ctx, s.space(), actor.ID, target.ID)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if target == nil {
			return nil, &rejection{err: memberNotFoundError(), audit: AuditInput{Action: "member.remove", TargetType: "member", TargetID: targetID, Result: "rejected", Reason: "member not found"}}, nil
		}
		if target.Role == RoleOwner {
			owners, err := tx.CountActiveOwners(ctx, s.space())
			if err != nil {
				return nil, nil, normalizeRepositoryError(err)
			}
			if owners <= 1 {
				return nil, &rejection{err: validationError(CodeMemberLastOwner, MessageMemberLastOwner), audit: AuditInput{Action: "member.remove", TargetType: "member", TargetID: target.ID, Result: "rejected", Reason: "last owner"}}, nil
			}
		}
		removed, err := tx.RemoveMember(ctx, s.space(), target.ID, now)
		if err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if !removed {
			return nil, &rejection{err: memberNotFoundError(), audit: AuditInput{Action: "member.remove", TargetType: "member", TargetID: target.ID, Result: "rejected", Reason: "member not found"}}, nil
		}
		if err := tx.RevokeUserConversationMemberships(ctx, target.ID, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		if err := tx.RevokeUserSessions(ctx, target.ID, now); err != nil {
			return nil, nil, normalizeRepositoryError(err)
		}
		payload, err := json.Marshal(map[string]string{"userId": target.ID})
		if err != nil {
			return nil, nil, internalError("encode member removal event", err)
		}
		if err := s.writeEvent(ctx, tx, EventInput{Type: "workspace.member_removed", ActorID: actor.ID, TargetType: "user", TargetID: target.ID, PayloadJSON: payload}, now); err != nil {
			return nil, nil, err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{Action: "member.remove", TargetType: "member", TargetID: target.ID, Result: "success"}, now); err != nil {
			return nil, nil, err
		}
		return RemoveResult{OK: true, UserID: target.ID, RemovedAt: formatTime(now)}, nil, nil
	})
	if err != nil {
		return RemoveResult{}, err
	}
	return result.(RemoveResult), nil
}

func (s *Service) RemoveSpaceMember(ctx context.Context, input RemoveInput) (RemoveResult, error) {
	return s.RemoveMember(ctx, input)
}

func requireCapability(actor *auth.Actor, capability string) *Error {
	if actor == nil || !hasCapability(actor.Role, capability) {
		return permissionDeniedError()
	}
	return nil
}

func hasCapability(role, capability string) bool {
	switch strings.TrimSpace(role) {
	case RoleOwner:
		return true
	case RoleAdmin:
		switch capability {
		case CapabilityConversationRead, CapabilityConversationDirect, CapabilityConversationGroup, CapabilityConversationMembers, CapabilityMessageCreate, CapabilityFileUpload, CapabilityFileDownload:
			return true
		}
	case RoleMember:
		switch capability {
		case CapabilityConversationRead, CapabilityConversationDirect, CapabilityMessageCreate, CapabilityFileUpload, CapabilityFileDownload:
			return true
		}
	}
	return false
}

func normalizeRole(role string) (string, *Error) {
	role = strings.TrimSpace(role)
	switch role {
	case RoleOwner, RoleAdmin, RoleMember, RoleAuditor:
		return role, nil
	default:
		return "", validationError(CodeRoleInvalid, MessageRoleInvalid)
	}
}

func normalizeProfileLabel(value, code, message string) (string, *Error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) == 0 || utf8.RuneCountInString(value) > 32 || containsProfileControl(value) {
		return "", validationError(code, message)
	}
	return value, nil
}

func normalizeRecallReason(value string) (string, *Error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) < 1 || utf8.RuneCountInString(value) > 16 || containsProfileControl(value) {
		return "", validationError(CodeProfileRecallReasonInvalid, MessageRecallReasonInvalid)
	}
	return value, nil
}

func containsProfileControl(value string) bool {
	for _, r := range value {
		if (r >= 0x00 && r <= 0x1f) || r == 0x7f || (r >= 0x80 && r <= 0x9f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
			return true
		}
	}
	return false
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func filterVisibleIDs(values []string, viewerID string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == viewerID || value == BeaconUserID || value == EchoUserID {
			continue
		}
		result = append(result, value)
	}
	return result
}

func memberContains(member Member, query string) bool {
	values := []string{member.DisplayName, pointerValue(member.Nickname), pointerValue(member.Remark), member.GitHubLogin, member.RoleLabel, member.Role, member.Kind}
	for _, value := range values {
		if strings.Contains(strings.ToLower(value), query) {
			return true
		}
	}
	return false
}

func pointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func normalizeTime(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return normalizeTime(value).Format("2006-01-02T15:04:05.000Z")
}

func nullableString(value *string) *string {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func sanitizeAvatarURL(value string) string {
	candidate := strings.TrimSpace(value)
	if candidate == "" || strings.Contains(candidate, "..") {
		return ""
	}
	if strings.HasPrefix(candidate, "/assets/") || strings.HasPrefix(candidate, "/api/workspace/avatars/") || strings.HasPrefix(candidate, "https://avatars.githubusercontent.com/") {
		return candidate
	}
	return ""
}

func projectedRole(record MemberRecord, actor *auth.Actor) string {
	role := record.Role
	if role == RoleOwner && (actor == nil || actor.Role != RoleOwner) {
		return RoleAdmin
	}
	if role == RoleAuditor && (actor == nil || (actor.ID != record.ID && actor.Role != RoleOwner)) {
		return RoleMember
	}
	if role == "" {
		return RoleMember
	}
	return role
}

func roleLabel(role string) string {
	switch role {
	case RoleOwner:
		return "空间主人"
	case RoleAdmin:
		return "管理员"
	case RoleAuditor:
		return "预留角色"
	default:
		return "成员"
	}
}

func systemIdentity(record MemberRecord) (displayName, description, avatarURL string, ok bool) {
	switch record.ID {
	case BeaconUserID:
		return "信标", "文件传输助手", "/assets/beacon-avatar.png", true
	case EchoUserID:
		return "回声", "需求与反馈助手", "/assets/echo-avatar.svg", true
	default:
		return "", "", "", false
	}
}

func isMemberManagedIdentity(record MemberRecord) bool {
	_, _, _, system := systemIdentity(record)
	return !system
}

func canStartDirect(record MemberRecord) bool {
	if _, _, _, system := systemIdentity(record); system {
		return true
	}
	return record.Kind == "human" && record.Role != RoleAuditor && record.ID != ""
}

func canJoinGroups(record MemberRecord) bool {
	if !hasCapability(record.Role, CapabilityConversationRead) || !hasCapability(record.Role, CapabilityMessageCreate) {
		return false
	}
	return record.Kind == "human"
}

func projectMember(record MemberRecord, actor *auth.Actor) Member {
	displayName := ""
	if actor == nil || actor.ID != record.ID {
		displayName = strings.TrimSpace(pointerValue(record.Remark))
	}
	if identityName, identityDescription, identityAvatar, ok := systemIdentity(record); ok {
		displayName = identityName
		record.Description = identityDescription
		record.AvatarURL = identityAvatar
		record.Kind = "bot"
	}
	if displayName == "" {
		displayName = strings.TrimSpace(pointerValue(record.Nickname))
	}
	if displayName == "" {
		displayName = strings.TrimSpace(record.GitHubLogin)
	}
	if displayName == "" {
		if record.Kind == "bot" {
			displayName = "Bot"
		} else {
			displayName = "成员"
		}
	}
	if record.Kind != "human" && strings.TrimSpace(record.DisplayName) != "" && systemIdentityName(record.ID) == "" {
		displayName = strings.TrimSpace(record.DisplayName)
	}
	role := projectedRole(record, actor)
	member := Member{
		ID:           record.ID,
		DisplayName:  displayName,
		Kind:         record.Kind,
		Role:         role,
		RoleLabel:    roleLabel(role),
		JoinedAt:     formatTime(record.JoinedAt),
		Capabilities: MemberCapabilities{CanJoinGroups: canJoinGroups(record), CanManage: actor != nil && isMemberManagedIdentity(record) && hasCapability(actor.Role, CapabilityRoleUpdate)},
	}
	if record.Kind == "human" {
		member.GitHubLogin = record.GitHubLogin
		member.Nickname = nullableString(record.Nickname)
		if actor != nil && actor.ID != record.ID {
			if remark := strings.TrimSpace(pointerValue(record.Remark)); remark != "" {
				member.Remark = &remark
				member.DisplayName = remark
			}
		}
		member.AvatarURL = sanitizeAvatarURL(record.AvatarURL)
		if actor != nil && actor.ID == record.ID {
			visible := record.SearchDiscoverable
			member.SearchDiscoverable = &visible
			if record.RecallReason != nil && strings.TrimSpace(*record.RecallReason) != "" {
				member.RecallReason = strings.TrimSpace(*record.RecallReason)
			} else {
				member.RecallReason = "内容有误"
			}
		}
	} else {
		member.AvatarURL = sanitizeAvatarURL(record.AvatarURL)
		member.Description = record.Description
	}
	member.Capabilities.CanStartDirectConversation = actor != nil && actor.ID != record.ID && canStartDirect(record) && hasCapability(actor.Role, CapabilityConversationDirect)
	return member
}

func systemIdentityName(id string) string {
	name, _, _, ok := systemIdentity(MemberRecord{ID: id})
	if !ok {
		return ""
	}
	return name
}
