package email

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID          = auth.DefaultSpaceID
	DefaultFrontendURL      = "https://duallane.tsio.top"
	DefaultWorkerInterval   = 30 * time.Second
	DefaultWorkerLease      = 2 * time.Minute
	DefaultPublishTimeout   = 10 * time.Second
	DefaultJobBatchSize     = 25
	MaximumJobBatchSize     = 25
	EmailChallengeTTL       = 10 * time.Minute
	EmailChallengeResend    = time.Minute
	EmailChallengeHourLimit = 5
	SMTPTestWindow          = 10 * time.Minute
	SMTPTestLimit           = 5
	ImmediateDelay          = time.Minute
	DigestDelay             = 2 * time.Hour
	MaximumCodeAttempts     = 5
)

var RetryDelays = [...]time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute}

type JobStatus string

const (
	JobPending   JobStatus = "pending"
	JobSending   JobStatus = "sending"
	JobSent      JobStatus = "sent"
	JobCancelled JobStatus = "cancelled"
	JobFailed    JobStatus = "failed"
)

// Preferences is the public notification projection. It never exposes the
// provider credential or an unmasked email address other than the selected
// address, matching the current Workspace JSON contract.
type Preferences struct {
	Email         *string `json:"email"`
	MaskedEmail   *string `json:"maskedEmail"`
	EmailSource   string  `json:"emailSource"`
	EmailVerified bool    `json:"emailVerified"`
	GitHubEmail   *string `json:"githubEmail"`
	Enabled       bool    `json:"enabled"`
	Immediate     bool    `json:"immediateEnabled"`
	Digest        bool    `json:"digestEnabled"`
	MailAvailable bool    `json:"mailAvailable"`
}

type PreferenceRecord struct {
	UserID          string
	Email           *string
	EmailSource     string
	EmailVerifiedAt *time.Time
	Enabled         bool
	Immediate       bool
	Digest          bool
	UpdatedAt       time.Time
}

type SpaceSettings struct {
	Enabled            bool    `json:"enabled"`
	SMTPHost           string  `json:"smtpHost"`
	SMTPPort           int     `json:"smtpPort"`
	Encryption         string  `json:"encryption"`
	Username           string  `json:"username"`
	FromAddress        string  `json:"fromAddress"`
	FromName           string  `json:"fromName"`
	PasswordConfigured bool    `json:"passwordConfigured"`
	ActiveFrom         *string `json:"activeFrom,omitempty"`
	LastTestedAt       *string `json:"lastTestedAt"`
	LastTestStatus     *string `json:"lastTestStatus"`
	LastTestErrorCode  *string `json:"lastTestErrorCode"`
	UpdatedAt          *string `json:"updatedAt,omitempty"`
	FailedJobCount     int64   `json:"failedJobCount"`
	LastDeliveryAt     *string `json:"lastDeliveryAt"`
}

type SMTPSettingsRecord struct {
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
	LastTestStatus     *string
	LastTestErrorCode  *string
	UpdatedAt          time.Time
}

type SMTPDraft struct {
	SMTPHost    string
	SMTPPort    int
	Encryption  string
	Username    string
	Password    string
	FromAddress string
	FromName    string
}

// SaveSettingsInput keeps EnabledSet and PasswordSet because omitted fields
// have distinct legacy semantics from explicit false/empty values.
type SaveSettingsInput struct {
	ActorID     string
	Enabled     bool
	EnabledSet  bool
	SMTPHost    string
	SMTPPort    int
	Encryption  string
	Username    string
	Password    string
	PasswordSet bool
	FromAddress string
	FromName    string
	TestProof   string
	Meta        auth.RequestMeta
}

type TestSettingsInput struct {
	ActorID     string
	SMTPHost    string
	SMTPPort    int
	Encryption  string
	Username    string
	Password    string
	PasswordSet bool
	FromAddress string
	FromName    string
	Meta        auth.RequestMeta
}

type SMTPTestResult struct {
	OK        bool   `json:"ok"`
	TestedAt  string `json:"testedAt"`
	TestProof string `json:"testProof"`
	Recipient string `json:"recipient"`
}

type CreateChallengeInput struct {
	ActorID string
	Email   string
	Meta    auth.RequestMeta
}

type ChallengeResult struct {
	ChallengeID        string `json:"challengeId"`
	PendingEmail       string `json:"pendingEmail"`
	ExpiresAt          string `json:"expiresAt"`
	ResendAfterSeconds int    `json:"resendAfterSeconds"`
}

type VerifyChallengeInput struct {
	ActorID     string
	ChallengeID string
	Code        string
	Meta        auth.RequestMeta
}

type UpdatePreferencesInput struct {
	ActorID   string
	Enabled   *bool
	Immediate *bool
	Digest    *bool
	Meta      auth.RequestMeta
}

type UseGitHubEmailInput struct {
	ActorID string
	Meta    auth.RequestMeta
}

type SyncGitHubEmailInput struct {
	UserID string
	Email  string
}

type ScheduleInput struct {
	AuthorID       string
	SpaceID        string
	ConversationID string
	TopicID        string
	MessageID      string
	EventSeq       int64
	ContentJSON    []byte
	CreatedAt      time.Time
}

type ScheduleRecipientQuery struct {
	SpaceID        string
	ConversationID string
	TopicID        string
	AuthorID       string
}

type RecipientRecord struct {
	UserID            string
	NotificationLevel string
}

type JobInsert struct {
	ID             string
	UserID         string
	MessageID      string
	ConversationID string
	EventSeq       int64
	AvailableAt    time.Time
	NextAttemptAt  time.Time
	CreatedAt      time.Time
}

type DigestInsert struct {
	UserID        string
	StartedAt     time.Time
	NextAttemptAt time.Time
	UpdatedAt     time.Time
}

// DeliveryJob contains transient content only for mention re-checking. It is
// never persisted or sent to a provider.
type DeliveryJob struct {
	ID                string
	UserID            string
	MessageID         string
	ConversationID    string
	EventSeq          int64
	AttemptCount      int
	Email             string
	EmailVerifiedAt   *time.Time
	PreferenceEnabled bool
	ImmediateEnabled  bool
	NotificationLevel string
	LastReadSeq       *int64
	LastReadAt        *time.Time
	MessageCreatedAt  time.Time
	ContentJSON       []byte
}

type UnreadMessage struct {
	ID                string
	AuthorID          *string
	CreatedAt         time.Time
	ContentJSON       []byte
	EventSeq          int64
	NotificationLevel string
	LastReadSeq       *int64
	LastReadAt        *time.Time
}

type DigestState struct {
	UserID        string
	StartedAt     time.Time
	NotifiedAt    *time.Time
	AttemptCount  int
	NextAttemptAt time.Time
}

type MailConfig struct {
	SMTPHost    string
	SMTPPort    int
	Encryption  string
	Username    string
	Password    string
	FromAddress string
	FromName    string
}

type Message struct {
	Subject string
	Text    string
	HTML    string
}

type Mailer interface {
	Send(context.Context, MailConfig, Message, string) error
}

type MailerFunc func(context.Context, MailConfig, Message, string) error

func (f MailerFunc) Send(ctx context.Context, config MailConfig, message Message, recipient string) error {
	return f(ctx, config, message, recipient)
}

type Presence interface {
	IsOnline(string) bool
}

type PresenceFunc func(string) bool

func (f PresenceFunc) IsOnline(userID string) bool { return f(userID) }

type WorkerOptions struct {
	StartupDelay   time.Duration
	Interval       time.Duration
	Lease          time.Duration
	BatchSize      int
	PublishTimeout time.Duration
	Disabled       bool
}

type ProcessResult struct {
	Claimed   int
	Sent      int
	Cancelled int
	Retried   int
	Failed    int
}

type WorkerHandle struct {
	Stop func()
	Tick func(context.Context) (ProcessResult, error)
}

type Clock func() time.Time
type IDFactory func() (string, error)
type CodeFactory func() (string, error)

type ServiceOptions struct {
	Repository       Repository
	SpaceID          string
	FrontendURL      string
	EncryptionKey    []byte
	EncryptionKeyB64 string
	Now              Clock
	IDFactory        IDFactory
	CodeFactory      CodeFactory
	Mailer           Mailer
	Worker           WorkerOptions
}

type AuditInput struct {
	ID               string
	SpaceID          string
	ActorUserID      string
	ActorGitHubLogin string
	Action           string
	TargetType       string
	TargetID         string
	Result           string
	Reason           string
	Meta             auth.RequestMeta
	CreatedAt        time.Time
}

func (input ScheduleInput) mentionUserIDs() map[string]struct{} {
	result := make(map[string]struct{})
	if len(input.ContentJSON) == 0 || len(input.ContentJSON) > 256*1024 {
		return result
	}
	var content struct {
		Blocks []struct {
			Type   string `json:"type"`
			UserID string `json:"userId"`
		} `json:"blocks"`
	}
	if json.Unmarshal(input.ContentJSON, &content) != nil {
		return result
	}
	for _, block := range content.Blocks {
		if block.Type == "mention" {
			if id := strings.TrimSpace(block.UserID); id != "" {
				result[id] = struct{}{}
			}
		}
	}
	return result
}
