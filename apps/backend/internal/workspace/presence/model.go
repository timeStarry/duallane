package presence

import (
	"context"
	"errors"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID    = auth.DefaultSpaceID
	DefaultLeaseTTL   = 90 * time.Second
	DefaultIOTimeout  = 5 * time.Second
	DefaultSweepBatch = 100
	MaximumSweepBatch = 1000
	MaximumLeaseTTL   = 5 * time.Minute
)

var (
	// ErrNotAuthorized is deliberately content-free. It covers a non-human
	// actor, a missing membership, and a removed membership alike.
	ErrNotAuthorized = errors.New("workspace presence authorization failed")
	ErrLeaseNotFound = errors.New("workspace presence lease is no longer active")
	ErrInvalidInput  = errors.New("workspace presence input is invalid")
)

// Lease is the opaque per-connection identity returned after successful
// authentication and replay. It contains no session token or transport data.
type Lease struct {
	SpaceID      string
	UserID       string
	ConnectionID string
	LeaseUntil   time.Time
}

// RegisterInput is supplied only after the realtime handshake has
// authenticated the actor and completed event replay.
type RegisterInput struct {
	SpaceID   string
	UserID    string
	ActorKind string
	Now       time.Time
	TTL       time.Duration
}

type RenewInput struct {
	Lease Lease
	Now   time.Time
	TTL   time.Duration
}

type DeleteInput struct {
	Lease Lease
}

type RegisterRecord struct {
	Lease     Lease
	CreatedAt time.Time
}

type RenewRecord struct {
	Lease Lease
	Now   time.Time
}

type OnlineQuery struct {
	SpaceID string
	UserID  string
	Now     time.Time
}

type SweepInput struct {
	Now   time.Time
	Limit int
}

// Repository is the narrow persistence boundary for presence leases.
// Implementations must keep authorization in the SQL path and must never
// return connection or user content beyond the boolean online projection.
type Repository interface {
	Register(context.Context, RegisterRecord) error
	Renew(context.Context, RenewRecord) (bool, error)
	Delete(context.Context, Lease) (bool, error)
	IsOnline(context.Context, OnlineQuery) (bool, error)
	SweepExpired(context.Context, SweepInput) (int, error)
}

// Lifecycle is the realtime hook used by the WebSocket handler. Register is
// intentionally separate from authentication/replay; callers must invoke it
// only after those gates have succeeded.
type Lifecycle interface {
	Register(context.Context, RegisterInput) (Lease, error)
	Renew(context.Context, RenewInput) error
	Delete(context.Context, DeleteInput) error
}

// OnlineLookup is the context-aware email-worker seam. An error is not an
// offline result; callers must retain the job and retry it.
type OnlineLookup interface {
	IsOnlineContext(context.Context, string) (bool, error)
}

type Clock func() time.Time
type IDFactory func() (string, error)

type ServiceOptions struct {
	Repository Repository
	SpaceID    string
	LeaseTTL   time.Duration
	IOTimeout  time.Duration
	Now        Clock
	IDFactory  IDFactory
}
