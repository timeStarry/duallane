package ntfy

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// ReadRepository is the narrow database seam. Delivery rows are permission to
// re-evaluate a notification, never a durable authorization snapshot.
type ReadRepository interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
	GetPreferences(context.Context, string) (*PreferenceRecord, error)
	ListRecipients(context.Context, ScheduleRecipientQuery) ([]RecipientRecord, error)
	ListDueJobs(context.Context, time.Time, int) ([]string, error)
	GetDeliveryJob(context.Context, string) (*DeliveryJob, error)
}

type Repository interface {
	ReadRepository
	WithTx(context.Context, func(Tx) error) error
	ClaimJob(context.Context, string, time.Time, time.Time) (bool, error)
	MarkSent(context.Context, string, time.Time) error
	RetryJob(context.Context, string, int, time.Time, string) error
	MarkFailed(context.Context, string, int, string) error
	CancelJob(context.Context, string, time.Time) error
	CancelPendingJobs(context.Context, string, time.Time) error
}

// Tx is used for preference changes and job creation. A single transaction
// keeps accepted state and its durable delivery rows together when the caller
// supplies this operation at the domain boundary.
type Tx interface {
	ReadRepository
	CreatePreferences(context.Context, string, string, time.Time) (bool, error)
	UpdatePreferences(context.Context, string, bool, time.Time) error
	RotatePreferences(context.Context, string, string, time.Time) (bool, error)
	InsertJob(context.Context, JobInsert) (bool, error)
	CancelPendingJobs(context.Context, string, time.Time) error
}

var _ Repository = (*PGRepository)(nil)
