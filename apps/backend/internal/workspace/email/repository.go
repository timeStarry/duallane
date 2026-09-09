package email

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// ReadRepository contains only the current projections needed by an email
// operation. A queued row is not a durable authorization grant: workers use
// the delivery reads below to repeat membership, read-state and preference
// checks immediately before contacting the provider.
type ReadRepository interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
	GetPreferences(context.Context, string) (*PreferenceRecord, error)
	GetSpaceSettings(context.Context, string) (*SMTPSettingsRecord, error)
	CountSMTPTests(context.Context, string, time.Time) (int, error)
	CountRecentChallenges(context.Context, string, time.Time) (count int, latestAt *time.Time, err error)
	GetChallenge(context.Context, string, string) (*ChallengeRecord, error)
	FailedJobCount(context.Context, string) (int64, error)
	LastDeliveryAt(context.Context, string) (*time.Time, error)
	ListRecipients(context.Context, ScheduleRecipientQuery) ([]RecipientRecord, error)
	ListDueJobs(context.Context, string, time.Time, int) ([]string, error)
	GetDeliveryJob(context.Context, string) (*DeliveryJob, error)
	ListDigestStates(context.Context, string, time.Time, int) ([]DigestState, error)
	ListEligibleUnreadMessages(context.Context, string, string, time.Time) ([]UnreadMessage, error)
}

// Repository is the durable boundary shared by the Workspace command and the
// worker command. Implementations must keep conditional job transitions
// atomic so multiple workers cannot win the same lease.
type Repository interface {
	ReadRepository
	WithTx(context.Context, func(Tx) error) error
	ClaimJob(context.Context, string, time.Time, time.Time) (bool, error)
	DeferJob(context.Context, string, time.Time) error
	MarkSent(context.Context, string, time.Time) error
	RetryJob(context.Context, string, int, time.Time, string) error
	MarkFailed(context.Context, string, int, string) error
	CancelJob(context.Context, string, time.Time) error
	DeleteDigestState(context.Context, string) error
	ClaimDigestState(context.Context, string, time.Time, time.Time) (bool, error)
	MarkDigestSent(context.Context, string, time.Time) error
	RetryDigestState(context.Context, string, int, time.Time, string, time.Time) error
}

// Tx embeds reads so every state-changing operation can repeat authorization
// and current state checks under the same transaction as its audit evidence.
type Tx interface {
	ReadRepository
	EnsurePreferences(context.Context, *auth.Actor, time.Time) (*PreferenceRecord, error)
	UpdatePreferences(context.Context, string, bool, bool, bool, time.Time) error
	UpsertSpaceSettings(context.Context, SpaceSettingsWrite) error
	CancelPendingJobs(context.Context, string, time.Time) error
	CancelAllJobs(context.Context, time.Time) error
	DeleteAllDigestStates(context.Context) error
	DeleteUserDigestState(context.Context, string) error
	ConsumeChallenges(context.Context, string, time.Time) error
	InsertChallenge(context.Context, ChallengeInsert) error
	IncrementChallengeAttempt(context.Context, string, time.Time) (bool, error)
	ConfirmChallenge(context.Context, string, string, string, time.Time, time.Time) error
	UseGitHubEmail(context.Context, string, string, time.Time) error
	SyncGitHubEmail(context.Context, string, string, time.Time) error
	InsertJob(context.Context, JobInsert) (bool, error)
	InsertDigestState(context.Context, DigestInsert) (bool, error)
	WriteAudit(context.Context, AuditInput) error
}

type ChallengeRecord struct {
	ID           string
	UserID       string
	PendingEmail string
	CodeHash     string
	Attempts     int
	CreatedAt    time.Time
	ExpiresAt    time.Time
	ConsumedAt   *time.Time
}

type ChallengeInsert struct {
	ID           string
	UserID       string
	PendingEmail string
	CodeHash     string
	CreatedAt    time.Time
	ExpiresAt    time.Time
}

type SpaceSettingsWrite struct {
	SpaceID            string
	Enabled            bool
	SMTPHost           string
	SMTPPort           int
	Encryption         string
	Username           string
	FromAddress        string
	FromName           string
	PasswordCiphertext string
	ActiveFrom         *time.Time
	LastTestedAt       *time.Time
	LastTestStatus     string
	LastTestErrorCode  string
	UpdatedBy          string
	UpdatedAt          time.Time
}

var _ Repository = (*PGRepository)(nil)
