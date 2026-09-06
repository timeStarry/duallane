package presence

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Service struct {
	repo      Repository
	spaceID   string
	leaseTTL  time.Duration
	ioTimeout time.Duration
	now       Clock
	idFactory IDFactory
	configErr error
}

func NewService(options ServiceOptions) *Service {
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	leaseTTL := options.LeaseTTL
	if leaseTTL <= 0 {
		leaseTTL = DefaultLeaseTTL
	}
	if leaseTTL > MaximumLeaseTTL {
		leaseTTL = MaximumLeaseTTL
	}
	ioTimeout := options.IOTimeout
	if ioTimeout <= 0 {
		ioTimeout = DefaultIOTimeout
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
	service := &Service{
		repo: options.Repository, spaceID: spaceID, leaseTTL: leaseTTL,
		ioTimeout: ioTimeout, now: now, idFactory: idFactory,
	}
	if options.Repository == nil {
		service.configErr = errors.New("workspace presence repository is required")
	}
	return service
}

var _ Lifecycle = (*Service)(nil)
var _ OnlineLookup = (*Service)(nil)

func (s *Service) Register(ctx context.Context, input RegisterInput) (Lease, error) {
	if err := s.ready(); err != nil {
		return Lease{}, err
	}
	if strings.TrimSpace(input.ActorKind) != "human" || strings.TrimSpace(input.UserID) == "" {
		return Lease{}, ErrNotAuthorized
	}
	spaceID := s.resolveSpace(input.SpaceID)
	now := input.Now
	if now.IsZero() {
		now = s.now()
	}
	ttl := s.resolveTTL(input.TTL)
	connectionID, err := s.idFactory()
	if err != nil {
		return Lease{}, errors.New("create workspace presence connection id")
	}
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return Lease{}, errors.New("create workspace presence connection id returned empty id")
	}
	lease := Lease{SpaceID: spaceID, UserID: strings.TrimSpace(input.UserID), ConnectionID: connectionID, LeaseUntil: now.Add(ttl).UTC()}
	callCtx, cancel := s.ioContext(ctx)
	defer cancel()
	if err := s.repo.Register(callCtx, RegisterRecord{Lease: lease, CreatedAt: now.UTC()}); err != nil {
		return Lease{}, err
	}
	return lease, nil
}

func (s *Service) Renew(ctx context.Context, input RenewInput) error {
	if err := s.ready(); err != nil {
		return err
	}
	lease := input.Lease
	if !validLease(lease) {
		return ErrInvalidInput
	}
	now := input.Now
	if now.IsZero() {
		now = s.now()
	}
	lease.LeaseUntil = now.Add(s.resolveTTL(input.TTL)).UTC()
	callCtx, cancel := s.ioContext(ctx)
	defer cancel()
	renewed, err := s.repo.Renew(callCtx, RenewRecord{Lease: lease, Now: now.UTC()})
	if err != nil {
		return err
	}
	if !renewed {
		return ErrLeaseNotFound
	}
	return nil
}

func (s *Service) Delete(ctx context.Context, input DeleteInput) error {
	if err := s.ready(); err != nil {
		return err
	}
	if !validLease(input.Lease) {
		return ErrInvalidInput
	}
	callCtx, cancel := s.ioContext(ctx)
	defer cancel()
	// Delete is idempotent: expiry or a previous cleanup is already the
	// desired state, and the composite key prevents deleting a newer lease.
	_, err := s.repo.Delete(callCtx, input.Lease)
	return err
}

func (s *Service) IsOnlineContext(ctx context.Context, userID string) (bool, error) {
	if err := s.ready(); err != nil {
		return false, err
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return false, ErrInvalidInput
	}
	callCtx, cancel := s.ioContext(ctx)
	defer cancel()
	return s.repo.IsOnline(callCtx, OnlineQuery{SpaceID: s.spaceID, UserID: userID, Now: s.now().UTC()})
}

// SweepExpired removes at most limit leases in one bounded SQL statement.
// It is intended for a maintenance/worker tick; it is not an activity-history
// compactor and does not inspect or emit any user content.
func (s *Service) SweepExpired(ctx context.Context, limit int) (int, error) {
	if err := s.ready(); err != nil {
		return 0, err
	}
	if limit <= 0 {
		limit = DefaultSweepBatch
	}
	if limit > MaximumSweepBatch {
		limit = MaximumSweepBatch
	}
	callCtx, cancel := s.ioContext(ctx)
	defer cancel()
	return s.repo.SweepExpired(callCtx, SweepInput{Now: s.now().UTC(), Limit: limit})
}

func (s *Service) ready() error {
	if s == nil {
		return errors.New("workspace presence service is required")
	}
	return s.configErr
}

func (s *Service) resolveSpace(spaceID string) string {
	spaceID = strings.TrimSpace(spaceID)
	if spaceID == "" {
		return s.spaceID
	}
	return spaceID
}

func (s *Service) resolveTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return s.leaseTTL
	}
	if ttl > MaximumLeaseTTL {
		return MaximumLeaseTTL
	}
	return ttl
}

func (s *Service) ioContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, s.ioTimeout)
}

func validLease(lease Lease) bool {
	return strings.TrimSpace(lease.SpaceID) != "" && strings.TrimSpace(lease.UserID) != "" && strings.TrimSpace(lease.ConnectionID) != ""
}
