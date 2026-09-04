package invites

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const generatedCodeBytes = 9

type Clock func() time.Time
type IDFactory func() (string, error)
type CodeFactory func() (string, error)

type ServiceOptions struct {
	Repository  Repository
	SpaceID     string
	Now         Clock
	IDFactory   IDFactory
	CodeFactory CodeFactory
}

type Service struct {
	repository  Repository
	spaceID     string
	now         Clock
	idFactory   IDFactory
	codeFactory CodeFactory
}

type rejection struct {
	err   *Error
	audit AuditInput
}

func NewService(options ServiceOptions) *Service {
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
	codeFactory := options.CodeFactory
	if codeFactory == nil {
		codeFactory = generateCode
	}
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	return &Service{repository: options.Repository, spaceID: spaceID, now: now, idFactory: idFactory, codeFactory: codeFactory}
}

func (service *Service) Create(ctx context.Context, input CreateInput) (Invite, error) {
	var output Invite
	err := service.mutate(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (*rejection, error) {
		role := strings.TrimSpace(input.DefaultRole)
		if role == "" {
			role = "member"
		}
		if !validRole(role) {
			return rejected(NewError(CodeRoleInvalid, "角色无效", 400), "invite.create", "", CodeRoleInvalid), nil
		}
		if !canManageRole(actor.Role, role) {
			return rejected(NewError(CodePermissionDenied, "你没有创建该邀请的权限", 403), "invite.create", "", "insufficient permission"), nil
		}
		code := strings.TrimSpace(input.Code)
		var err error
		if code == "" {
			code, err = service.newCode()
			if err != nil {
				return nil, internalError("generate invite code", err)
			}
		}
		code = auth.NormalizeInviteCode(code)
		if code == "" {
			return rejected(NewError(CodeInviteInvalid, "邀请码无效", 400), "invite.create", "", CodeInviteInvalid), nil
		}
		id, err := service.newID()
		if err != nil {
			return nil, internalError("generate invite id", err)
		}
		maxUses := input.MaxUses
		if maxUses <= 0 {
			maxUses = 1
		}
		expiresAt, domainErr := resolveExpiry(input.ExpiresAt, input.ExpiresInHours, now)
		if domainErr != nil {
			return rejected(domainErr, "invite.create", "", domainErr.Code), nil
		}
		preview := previewCode(code)
		record := InviteRecord{
			ID: id, SpaceID: service.spaceID, CodeHash: auth.HashSecret(code), CodePreview: preview,
			DefaultRole: role, CreatedBy: actor.ID, MaxUses: maxUses, ExpiresAt: expiresAt, CreatedAt: now,
		}
		if err := tx.InsertInvite(ctx, record); err != nil {
			return nil, err
		}
		if err := tx.WriteAudit(ctx, service.audit(actor, input.Meta, now, "invite.create", id, "success", "")); err != nil {
			return nil, err
		}
		output = projectInvite(record, code)
		return nil, nil
	})
	if err != nil {
		return Invite{}, err
	}
	return output, nil
}

func (service *Service) Revoke(ctx context.Context, input RevokeInput) (RevokedInvite, error) {
	var output RevokedInvite
	err := service.mutate(ctx, input.ActorID, input.Meta, func(tx Tx, actor *auth.Actor, now time.Time) (*rejection, error) {
		inviteID := strings.TrimSpace(input.InviteID)
		if actor.Role != "owner" && actor.Role != "admin" {
			return rejected(NewError(CodePermissionDenied, "你没有执行该操作的权限", 403), "invite.revoke", inviteID, "insufficient permission"), nil
		}
		invite, err := tx.FindInviteForUpdate(ctx, service.spaceID, inviteID)
		if err != nil {
			return nil, err
		}
		if invite == nil {
			return rejected(NewError(CodeInviteNotFound, "邀请不存在", 400), "invite.revoke", inviteID, "invite not found"), nil
		}
		if !canManageRole(actor.Role, invite.DefaultRole) {
			return rejected(NewError(CodePermissionDenied, "你没有执行该操作的权限", 403), "invite.revoke", invite.ID, "insufficient permission"), nil
		}
		revokedAt := invite.RevokedAt
		if revokedAt == nil {
			changed, err := tx.RevokeInvite(ctx, service.spaceID, invite.ID, now)
			if err != nil {
				return nil, err
			}
			if !changed {
				return nil, internalError("revoke invite", errors.New("locked invite was not updated"))
			}
			revokedAt = &now
		}
		if err := tx.WriteAudit(ctx, service.audit(actor, input.Meta, now, "invite.revoke", invite.ID, "success", "")); err != nil {
			return nil, err
		}
		output = RevokedInvite{ID: invite.ID, RevokedAt: formatTime(*revokedAt)}
		return nil, nil
	})
	if err != nil {
		return RevokedInvite{}, err
	}
	return output, nil
}

func (service *Service) mutate(ctx context.Context, actorID string, meta RequestMeta, operation func(Tx, *auth.Actor, time.Time) (*rejection, error)) error {
	if service == nil || service.repository == nil {
		return internalError("workspace invite service", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return NewError(CodeAuthRequired, "请先登录共享空间", 401)
	}
	var rejectedOperation *rejection
	err := service.repository.WithTx(ctx, func(tx Tx) error {
		actor, err := tx.LookupActor(ctx, service.spaceID, actorID)
		if err != nil {
			return err
		}
		if actor == nil || actor.ID != actorID || actor.Kind != "human" || strings.TrimSpace(actor.Role) == "" {
			return NewError(CodeAuthRequired, "请先登录共享空间", 401)
		}
		now := service.nowUTC()
		rejectedOperation, err = operation(tx, actor, now)
		if err != nil {
			return err
		}
		if rejectedOperation != nil {
			audit := rejectedOperation.audit
			audit = service.audit(actor, meta, now, audit.Action, audit.TargetID, "rejected", audit.Reason)
			return tx.WriteAudit(ctx, audit)
		}
		return nil
	})
	if err != nil {
		return normalizeError(err)
	}
	if rejectedOperation != nil {
		return rejectedOperation.err
	}
	return nil
}

func (service *Service) audit(actor *auth.Actor, meta RequestMeta, now time.Time, action, targetID, result, reason string) AuditInput {
	safe := meta.Safe()
	return AuditInput{
		SpaceID: service.spaceID, ActorUserID: actor.ID, ActorGitHubLogin: actor.GitHubLogin,
		Action: action, TargetType: "invite", TargetID: targetID, Result: result, Reason: reason,
		RequestID: safe.RequestID, IPAddress: safe.IPAddress, UserAgent: safe.UserAgent, CreatedAt: now,
	}
}

func rejected(err *Error, action, targetID, reason string) *rejection {
	return &rejection{err: err, audit: AuditInput{Action: action, TargetType: "invite", TargetID: targetID, Result: "rejected", Reason: reason}}
}

func (service *Service) newID() (string, error) {
	if service.idFactory == nil {
		return "", errors.New("invite id factory is required")
	}
	id, err := service.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("invite id factory returned an empty id")
	}
	return id, nil
}

func (service *Service) newCode() (string, error) {
	if service.codeFactory == nil {
		return "", errors.New("invite code factory is required")
	}
	return service.codeFactory()
}

func generateCode() (string, error) {
	bytes := make([]byte, generatedCodeBytes)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return "DL-" + strings.ToUpper(base64.RawURLEncoding.EncodeToString(bytes)), nil
}

func validRole(role string) bool {
	return role == "owner" || role == "admin" || role == "member" || role == "auditor"
}

func canManageRole(actorRole, inviteRole string) bool {
	return actorRole == "owner" || (actorRole == "admin" && inviteRole == "member")
}

func resolveExpiry(explicit string, hours int64, now time.Time) (*time.Time, *Error) {
	if value := strings.TrimSpace(explicit); value != "" {
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return nil, NewError(CodeInviteInvalid, "邀请有效期无效", 400)
		}
		normalized := parsed.UTC().Truncate(time.Millisecond)
		return &normalized, nil
	}
	if hours <= 0 {
		return nil, nil
	}
	if hours > int64((365*24*time.Hour)/time.Hour) {
		return nil, NewError(CodeInviteInvalid, "邀请有效期无效", 400)
	}
	value := now.Add(time.Duration(hours) * time.Hour)
	return &value, nil
}

func previewCode(code string) string {
	if len(code) <= 8 {
		return code
	}
	return code[:4] + "..." + code[len(code)-4:]
}

func projectInvite(record InviteRecord, code string) Invite {
	return Invite{
		ID: record.ID, Code: code, CodePreview: record.CodePreview, DefaultRole: record.DefaultRole,
		MaxUses: record.MaxUses, Uses: record.Uses, ExpiresAt: formatTimePointer(record.ExpiresAt), CreatedAt: formatTime(record.CreatedAt),
	}
}

func formatTime(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func formatTimePointer(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := formatTime(*value)
	return &formatted
}

func (service *Service) nowUTC() time.Time {
	now := service.now()
	if now.IsZero() {
		now = time.Now()
	}
	return now.UTC().Truncate(time.Millisecond)
}
