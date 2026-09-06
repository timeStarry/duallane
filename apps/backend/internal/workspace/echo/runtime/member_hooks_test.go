package runtime

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
)

type memberAuthStub struct {
	AuthenticationStore
	committed bool
	err       error
}

func (s *memberAuthStub) AuthenticateGitHub(context.Context, auth.GitHubProfile, string, time.Time, auth.RequestMeta) (*auth.Actor, error) {
	s.committed = s.err == nil
	return &auth.Actor{ID: "member-fixture", Kind: "human", Role: "member"}, s.err
}

type memberDeliveryStub struct {
	t     *testing.T
	store *memberAuthStub
	calls int
}

func (s *memberDeliveryStub) SyncMember(ctx context.Context, spaceID, actorID string, _ auth.RequestMeta) (delivery.MemberSyncResult, error) {
	deadline, bounded := ctx.Deadline()
	if !s.store.committed || !bounded || time.Until(deadline) > 5*time.Second || spaceID != "space-fixture" || actorID != "member-fixture" {
		s.t.Fatal("uncommitted, unbounded or incorrect member sync")
	}
	s.calls++
	return delivery.MemberSyncResult{}, errors.New("synthetic post-commit failure")
}

func TestAuthMemberDeliveryRunsOnlyAfterSuccessfulInviteCommit(t *testing.T) {
	store := &memberAuthStub{}
	target := &memberDeliveryStub{t: t, store: store}
	hook := AuthStoreHooks{AuthenticationStore: store, SpaceID: "space-fixture", Delivery: func() MemberDelivery { return target }}
	actor, err := hook.AuthenticateGitHub(context.Background(), auth.GitHubProfile{}, "opaque-invite-hash", time.Now(), auth.RequestMeta{})
	if err != nil || actor.ID != "member-fixture" || target.calls != 1 {
		t.Fatalf("durable success changed actor=%+v err=%v calls=%d", actor, err, target.calls)
	}
	if _, err := hook.AuthenticateGitHub(context.Background(), auth.GitHubProfile{}, "", time.Now(), auth.RequestMeta{}); err != nil || target.calls != 1 {
		t.Fatal("ordinary login unnecessarily triggered invite delivery")
	}
	store.err = errors.New("synthetic invite rejection")
	if _, err := hook.AuthenticateGitHub(context.Background(), auth.GitHubProfile{}, "opaque-invite-hash", time.Now(), auth.RequestMeta{}); err == nil || target.calls != 1 {
		t.Fatal("failed invitation triggered delivery")
	}
}
