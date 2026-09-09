package presence

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeRepository struct {
	registerErr error
	registers   []RegisterRecord
	renewErr    error
	renewed     []RenewRecord
	deleteErr   error
	deletes     []Lease
	online      bool
	onlineErr   error
	onlineBlock bool
	swept       []SweepInput
}

func (f *fakeRepository) Register(_ context.Context, record RegisterRecord) error {
	if f.registerErr != nil {
		return f.registerErr
	}
	f.registers = append(f.registers, record)
	return nil
}

func (f *fakeRepository) Renew(_ context.Context, record RenewRecord) (bool, error) {
	if f.renewErr != nil {
		return false, f.renewErr
	}
	f.renewed = append(f.renewed, record)
	return true, nil
}

func (f *fakeRepository) Delete(_ context.Context, lease Lease) (bool, error) {
	if f.deleteErr != nil {
		return false, f.deleteErr
	}
	f.deletes = append(f.deletes, lease)
	return true, nil
}

func (f *fakeRepository) IsOnline(ctx context.Context, _ OnlineQuery) (bool, error) {
	if f.onlineBlock {
		<-ctx.Done()
		return false, ctx.Err()
	}
	return f.online, f.onlineErr
}

func (f *fakeRepository) SweepExpired(_ context.Context, input SweepInput) (int, error) {
	f.swept = append(f.swept, input)
	return input.Limit, nil
}

func TestServiceRegistersOnlyHumanAndUsesOpaqueConnectionID(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepository{}
	service := NewService(ServiceOptions{
		Repository: repo, SpaceID: "space-a", LeaseTTL: time.Minute,
		Now: func() time.Time { return now }, IDFactory: func() (string, error) { return "connection-random", nil },
	})
	lease, err := service.Register(context.Background(), RegisterInput{UserID: "user-a", ActorKind: "human"})
	if err != nil {
		t.Fatal(err)
	}
	if lease.SpaceID != "space-a" || lease.UserID != "user-a" || lease.ConnectionID != "connection-random" || !lease.LeaseUntil.Equal(now.Add(time.Minute)) {
		t.Fatalf("lease=%#v", lease)
	}
	if len(repo.registers) != 1 {
		t.Fatalf("register count=%d", len(repo.registers))
	}
	if _, err := service.Register(context.Background(), RegisterInput{UserID: "user-a", ActorKind: "bot"}); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("bot registration error=%v", err)
	}
}

func TestServiceRenewAndDeleteAreLeaseScoped(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepository{}
	service := NewService(ServiceOptions{Repository: repo, SpaceID: "space-a", LeaseTTL: time.Minute, Now: func() time.Time { return now }})
	lease := Lease{SpaceID: "space-a", UserID: "user-a", ConnectionID: "old-connection"}
	if err := service.Renew(context.Background(), RenewInput{Lease: lease}); err != nil {
		t.Fatal(err)
	}
	if len(repo.renewed) != 1 || repo.renewed[0].Lease.ConnectionID != "old-connection" {
		t.Fatalf("renewals=%#v", repo.renewed)
	}
	if err := service.Delete(context.Background(), DeleteInput{Lease: lease}); err != nil {
		t.Fatal(err)
	}
	if len(repo.deletes) != 1 || repo.deletes[0].ConnectionID != "old-connection" {
		t.Fatalf("deletes=%#v", repo.deletes)
	}
}

func TestServicePresenceLookupAndSweepHaveBoundedContext(t *testing.T) {
	repo := &fakeRepository{onlineBlock: true}
	service := NewService(ServiceOptions{Repository: repo, SpaceID: "space-a", IOTimeout: 10 * time.Millisecond})
	started := time.Now()
	_, err := service.IsOnlineContext(context.Background(), "user-a")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lookup error=%v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("presence lookup was not bounded")
	}

	repo.onlineBlock = false
	if _, err := service.SweepExpired(context.Background(), MaximumSweepBatch+1); err != nil {
		t.Fatal(err)
	}
	if len(repo.swept) != 1 || repo.swept[0].Limit != MaximumSweepBatch {
		t.Fatalf("sweep=%#v", repo.swept)
	}
}

func TestServiceDoesNotTreatLookupFailureAsOffline(t *testing.T) {
	repo := &fakeRepository{onlineErr: errors.New("database unavailable")}
	service := NewService(ServiceOptions{Repository: repo, SpaceID: "space-a"})
	online, err := service.IsOnlineContext(context.Background(), "user-a")
	if online {
		t.Fatal("failed lookup returned online")
	}
	if err == nil {
		t.Fatal("failed lookup was swallowed")
	}
}
