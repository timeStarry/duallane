package runtime

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/members"
)

type MemberDelivery interface {
	SyncMember(context.Context, string, string, auth.RequestMeta) (delivery.MemberSyncResult, error)
}

type AuthenticationStore interface {
	auth.Store
	auth.ActiveActorLookup
}

// AuthStoreHooks retains the concrete store's atomic identity/invite write and
// optional development actor lookup. It never passes the invite hash, profile
// or credentials to delivery. The closure is bound during startup, before the
// server accepts requests.
type AuthStoreHooks struct {
	AuthenticationStore
	Delivery func() MemberDelivery
	SpaceID  string
}

func (s AuthStoreHooks) AuthenticateGitHub(ctx context.Context, profile auth.GitHubProfile, inviteCodeHash string, now time.Time, meta auth.RequestMeta) (*auth.Actor, error) {
	actor, err := s.AuthenticationStore.AuthenticateGitHub(ctx, profile, inviteCodeHash, now, meta)
	if err == nil && actor != nil && actor.Kind == "human" && inviteCodeHash != "" && s.Delivery != nil {
		syncMemberAfterCommit(ctx, s.Delivery(), s.SpaceID, actor.ID, meta)
	}
	return actor, err
}

type MemberHooks struct {
	*members.Service
	Delivery MemberDelivery
	SpaceID  string
}

func (s MemberHooks) UpdateMemberRole(ctx context.Context, input members.RoleInput) (members.Member, error) {
	value, err := s.Service.UpdateMemberRole(ctx, input)
	if err == nil && value.Kind == "human" {
		syncMemberAfterCommit(ctx, s.Delivery, s.SpaceID, value.ID, input.Meta)
	}
	return value, err
}

func syncMemberAfterCommit(ctx context.Context, target MemberDelivery, spaceID, actorID string, meta auth.RequestMeta) {
	if target == nil || actorID == "" {
		return
	}
	// Login/role success is already durable. Delivery has a short best-effort
	// budget here; the independent member reconciliation worker repairs a
	// crash, cancellation or dependency failure without redoing membership.
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, _ = target.SyncMember(bounded, spaceID, actorID, meta.Safe())
}

var _ auth.Store = AuthStoreHooks{}
var _ auth.ActiveActorLookup = AuthStoreHooks{}
