package ntfy

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

const (
	DefaultSpaceID         = "spc_default"
	DefaultServerURL       = "https://ntfy.tsio.top"
	DefaultFrontendURL     = "https://duallane.tsio.top"
	TopicPrefix            = "duallane"
	TopicRandomLength      = 6
	DeliveryDelay          = 5 * time.Second
	DefaultWorkerInterval  = 5 * time.Second
	DefaultWorkerLease     = 2 * time.Minute
	DefaultPublishTimeout  = 10 * time.Second
	DefaultJobBatchSize    = 25
	MaximumJobBatchSize    = 25
	MaximumJSONBytes       = 256 * 1024
	MaximumTopicGeneration = 10
)

// RetryDelays is intentionally bounded. A provider failure can never create an
// unbounded database queue or retry forever.
var RetryDelays = [...]time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute}

type JobStatus string

const (
	JobPending   JobStatus = "pending"
	JobSending   JobStatus = "sending"
	JobSent      JobStatus = "sent"
	JobCancelled JobStatus = "cancelled"
	JobFailed    JobStatus = "failed"
)

// Preferences is the public projection returned by the future HTTP adapter.
// It contains only a private topic identifier; it never contains provider
// credentials or message content.
type Preferences struct {
	Enabled         bool    `json:"enabled"`
	Topic           string  `json:"topic"`
	ServerURL       string  `json:"serverUrl"`
	SubscriptionURL string  `json:"subscriptionUrl"`
	CreatedAt       string  `json:"createdAt"`
	RotatedAt       *string `json:"rotatedAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

// PreferenceRecord is the storage projection and must not be sent directly to
// a transport.
type PreferenceRecord struct {
	UserID    string
	Topic     string
	Enabled   bool
	CreatedAt time.Time
	RotatedAt *time.Time
	UpdatedAt time.Time
}

type UpdatePreferencesInput struct {
	ActorID    string
	Enabled    *bool
	EnabledSet bool
}

type RotateTopicInput struct {
	ActorID string
}

// Content is the small subset needed to identify mentions while scheduling a
// message. The message body itself is never copied into a job row or a push.
type Content struct {
	Blocks []Block `json:"blocks"`
}

type Block struct {
	Type   string `json:"type"`
	UserID string `json:"userId,omitempty"`
}

type ScheduleInput struct {
	AuthorID       string
	SpaceID        string
	ConversationID string
	TopicID        string
	MessageID      string
	EventSeq       int64
	Content        Content
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
	GitHubLogin       string
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

// DeliveryJob is a fresh, authorization-aware projection read immediately
// after claiming. ContentJSON is transient and exists only for mention
// re-checking; it is never part of JobInsert or the jobs table.
type DeliveryJob struct {
	ID                string
	UserID            string
	MessageID         string
	ConversationID    string
	EventSeq          int64
	AttemptCount      int
	Topic             string
	PreferenceEnabled bool
	NotificationLevel string
	LastReadSeq       *int64
	LastReadAt        *time.Time
	TopicID           *string
	TopicTitle        *string
	MessageCreatedAt  time.Time
	ContentJSON       []byte
	ConversationType  string
	ConversationTitle string
	SenderName        string
}

type Notification struct {
	Topic    string
	Title    string
	Message  string
	ClickURL string
}

type PublishInput = Notification

type ProcessResult struct {
	Claimed   int
	Sent      int
	Cancelled int
	Retried   int
	Failed    int
}

type WorkerOptions struct {
	StartupDelay time.Duration
	Interval     time.Duration
	Lease        time.Duration
	BatchSize    int
	Disabled     bool
}

type WorkerHandle struct {
	Stop func()
	Tick func(context.Context) (ProcessResult, error)
}

type Clock func() time.Time
type IDFactory func() (string, error)
type TopicFactory func(string) (string, error)

type ServiceOptions struct {
	Repository   Repository
	SpaceID      string
	ServerURL    string
	FrontendURL  string
	Now          Clock
	IDFactory    IDFactory
	TopicFactory TopicFactory
	Publisher    Publisher
	Worker       WorkerOptions
}

// Publisher is deliberately narrower than http.Client. It accepts only a
// provider-safe notification projection and returns safe/classified errors.
type Publisher interface {
	Publish(ctx context.Context, input PublishInput) error
}

type PublisherFunc func(context.Context, PublishInput) error

func (f PublisherFunc) Publish(ctx context.Context, input PublishInput) error {
	return f(ctx, input)
}

func (input ScheduleInput) mentionUserIDs() map[string]struct{} {
	result := make(map[string]struct{})
	if len(input.Content.Blocks) > 0 {
		for _, block := range input.Content.Blocks {
			userID := strings.TrimSpace(block.UserID)
			if block.Type == "mention" && userID != "" {
				result[userID] = struct{}{}
			}
		}
		return result
	}
	if len(input.ContentJSON) == 0 || len(input.ContentJSON) > MaximumJSONBytes {
		return result
	}
	var content struct {
		Blocks []Block `json:"blocks"`
	}
	if json.Unmarshal(input.ContentJSON, &content) != nil {
		return result
	}
	for _, block := range content.Blocks {
		userID := strings.TrimSpace(block.UserID)
		if block.Type == "mention" && userID != "" {
			result[userID] = struct{}{}
		}
	}
	return result
}
