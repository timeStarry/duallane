package ntfy

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

var defaultIDFactory = func() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

var defaultTopicFactory = func(githubLogin string) (string, error) {
	return CreateTopic(githubLogin)
}

type Service struct {
	repo          Repository
	spaceID       string
	serverURL     string
	frontendURL   string
	now           Clock
	idFactory     IDFactory
	topicFactory  TopicFactory
	publisher     Publisher
	workerOptions WorkerOptions
	configErr     error
}

func NewService(options ServiceOptions) *Service {
	service, err := NewServiceWithError(options)
	if err == nil {
		return service
	}
	// Keep the options-based constructor compatible with the other Workspace
	// packages. Operations fail closed through configErr; callers that compose
	// process startup can use NewServiceWithError for an early failure.
	if service == nil {
		service = &Service{}
	}
	service.configErr = err
	return service
}

func NewServiceWithError(options ServiceOptions) (*Service, error) {
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	serverURL, err := normalizeServerURL(options.ServerURL)
	if err != nil {
		return &Service{spaceID: spaceID}, err
	}
	frontendURL := normalizeFrontendURL(options.FrontendURL)
	now := options.Now
	if now == nil {
		now = time.Now
	}
	idFactory := options.IDFactory
	if idFactory == nil {
		idFactory = defaultIDFactory
	}
	topicFactory := options.TopicFactory
	if topicFactory == nil {
		topicFactory = defaultTopicFactory
	}
	workerOptions := options.Worker
	if workerOptions.Interval <= 0 {
		workerOptions.Interval = DefaultWorkerInterval
	}
	if workerOptions.Lease <= 0 {
		workerOptions.Lease = DefaultWorkerLease
	}
	if workerOptions.BatchSize <= 0 {
		workerOptions.BatchSize = DefaultJobBatchSize
	}
	if workerOptions.BatchSize > MaximumJobBatchSize {
		workerOptions.BatchSize = MaximumJobBatchSize
	}
	publisher := options.Publisher
	if publisher == nil {
		publisher = NewHTTPPublisher(HTTPPublisherOptions{ServerURL: serverURL, Timeout: DefaultPublishTimeout})
	}
	return &Service{
		repo:          options.Repository,
		spaceID:       spaceID,
		serverURL:     serverURL,
		frontendURL:   frontendURL,
		now:           now,
		idFactory:     idFactory,
		topicFactory:  topicFactory,
		publisher:     publisher,
		workerOptions: workerOptions,
	}, nil
}

func NewServiceForRepository(repo Repository) *Service {
	return NewService(ServiceOptions{Repository: repo})
}

func (s *Service) Repository() Repository {
	if s == nil {
		return nil
	}
	return s.repo
}

func (s *Service) server() string {
	if s == nil || strings.TrimSpace(s.serverURL) == "" {
		return DefaultServerURL
	}
	return s.serverURL
}

func (s *Service) frontend() string {
	if s == nil || strings.TrimSpace(s.frontendURL) == "" {
		return DefaultFrontendURL
	}
	return s.frontendURL
}

func (s *Service) space() string {
	if s == nil || strings.TrimSpace(s.spaceID) == "" {
		return DefaultSpaceID
	}
	return s.spaceID
}

func (s *Service) nowUTC() time.Time {
	now := time.Now()
	if s != nil && s.now != nil {
		now = s.now()
	}
	if now.IsZero() {
		now = time.Unix(0, 0)
	}
	return now.UTC().Truncate(time.Millisecond)
}

func (s *Service) newID(operation string) (string, error) {
	if s == nil || s.idFactory == nil {
		return "", errors.New(operation + " id factory is required")
	}
	id, err := s.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return id, nil
}

func (s *Service) checkReady(operation string) error {
	if s == nil {
		return internalError(operation, errors.New("service is required"))
	}
	if s.configErr != nil {
		return notConfiguredError(s.configErr)
	}
	if s.repo == nil {
		return internalError(operation, errors.New("repository is required"))
	}
	return nil
}

func (s *Service) lookupActor(ctx context.Context, reader ReadRepository, actorID string) (*auth.Actor, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	actor, err := reader.LookupActor(ctx, s.space(), actorID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if actor == nil {
		return nil, authRequiredError()
	}
	if actor.Kind != "human" {
		return nil, identityForbiddenError()
	}
	if strings.TrimSpace(actor.ID) == "" || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	return actor, nil
}

func (s *Service) ensurePreferences(ctx context.Context, tx Tx, actor *auth.Actor, now time.Time) (*PreferenceRecord, error) {
	if actor == nil {
		return nil, authRequiredError()
	}
	for attempt := 0; attempt < MaximumTopicGeneration; attempt++ {
		record, err := tx.GetPreferences(ctx, actor.ID)
		if err != nil {
			return nil, normalizeRepositoryError(err)
		}
		if record != nil {
			return record, nil
		}
		topic, err := s.topicFactory(actor.GitHubLogin)
		if err != nil {
			return nil, topicGenerationError(err)
		}
		if strings.TrimSpace(topic) == "" {
			return nil, topicGenerationError(errors.New("topic factory returned an empty topic"))
		}
		if _, err := tx.CreatePreferences(ctx, actor.ID, topic, now); err != nil {
			return nil, normalizeRepositoryError(err)
		}
	}
	return nil, topicGenerationError(errors.New("topic generation exhausted"))
}

func (s *Service) GetPreferences(ctx context.Context, actorID string) (Preferences, error) {
	if err := s.checkReady("get ntfy preferences"); err != nil {
		return Preferences{}, err
	}
	var result PreferenceRecord
	if err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return internalError("get ntfy preferences", errors.New("transaction is required"))
		}
		actor, err := s.lookupActor(ctx, tx, actorID)
		if err != nil {
			return err
		}
		record, err := s.ensurePreferences(ctx, tx, actor, s.nowUTC())
		if err != nil {
			return err
		}
		result = *record
		return nil
	}); err != nil {
		return Preferences{}, normalizeRepositoryError(err)
	}
	return s.projectPreferences(result), nil
}

func (s *Service) UpdatePreferences(ctx context.Context, input UpdatePreferencesInput) (Preferences, error) {
	if err := s.checkReady("update ntfy preferences"); err != nil {
		return Preferences{}, err
	}
	var result PreferenceRecord
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return internalError("update ntfy preferences", errors.New("transaction is required"))
		}
		actor, err := s.lookupActor(ctx, tx, input.ActorID)
		if err != nil {
			return err
		}
		now := s.nowUTC()
		current, err := s.ensurePreferences(ctx, tx, actor, now)
		if err != nil {
			return err
		}
		enabled := current.Enabled
		if input.EnabledSet || input.Enabled != nil {
			enabled = input.Enabled != nil && *input.Enabled
		}
		if err := tx.UpdatePreferences(ctx, actor.ID, enabled, now); err != nil {
			return normalizeRepositoryError(err)
		}
		if !enabled {
			if err := tx.CancelPendingJobs(ctx, actor.ID, now); err != nil {
				return normalizeRepositoryError(err)
			}
		}
		updated, err := tx.GetPreferences(ctx, actor.ID)
		if err != nil {
			return normalizeRepositoryError(err)
		}
		if updated == nil {
			return internalError("update ntfy preferences", errors.New("preference disappeared after update"))
		}
		result = *updated
		return nil
	})
	if err != nil {
		return Preferences{}, normalizeRepositoryError(err)
	}
	return s.projectPreferences(result), nil
}

func (s *Service) RotateTopic(ctx context.Context, input RotateTopicInput) (Preferences, error) {
	if err := s.checkReady("rotate ntfy topic"); err != nil {
		return Preferences{}, err
	}
	for attempt := 0; attempt < MaximumTopicGeneration; attempt++ {
		var result PreferenceRecord
		rotated := false
		err := s.repo.WithTx(ctx, func(tx Tx) error {
			if tx == nil {
				return internalError("rotate ntfy topic", errors.New("transaction is required"))
			}
			actor, err := s.lookupActor(ctx, tx, input.ActorID)
			if err != nil {
				return err
			}
			now := s.nowUTC()
			if _, err := s.ensurePreferences(ctx, tx, actor, now); err != nil {
				return err
			}
			topic, err := s.topicFactory(actor.GitHubLogin)
			if err != nil {
				return topicGenerationError(err)
			}
			changed, err := tx.RotatePreferences(ctx, actor.ID, topic, now)
			if err != nil {
				return normalizeRepositoryError(err)
			}
			if !changed {
				return nil
			}
			rotated = true
			if err := tx.CancelPendingJobs(ctx, actor.ID, now); err != nil {
				return normalizeRepositoryError(err)
			}
			updated, err := tx.GetPreferences(ctx, actor.ID)
			if err != nil {
				return normalizeRepositoryError(err)
			}
			if updated == nil {
				return internalError("rotate ntfy topic", errors.New("preference disappeared after rotation"))
			}
			result = *updated
			return nil
		})
		if err != nil {
			return Preferences{}, normalizeRepositoryError(err)
		}
		if rotated {
			return s.projectPreferences(result), nil
		}
	}
	return Preferences{}, topicGenerationError(errors.New("topic rotation exhausted"))
}

func (s *Service) ScheduleMessage(ctx context.Context, input ScheduleInput) error {
	if err := s.checkReady("schedule ntfy message"); err != nil {
		return err
	}
	if strings.TrimSpace(input.MessageID) == "" || strings.TrimSpace(input.ConversationID) == "" || strings.TrimSpace(input.AuthorID) == "" {
		return internalError("schedule ntfy message", errors.New("message, conversation, and author are required"))
	}
	if input.CreatedAt.IsZero() {
		return internalError("schedule ntfy message", errors.New("message timestamp is required"))
	}
	_, err := s.scheduleMessage(ctx, input, nil)
	return err
}

// ScheduleMessageInTx lets a message/topic acceptance transaction create its
// durable job rows without opening a second transaction. The caller owns the
// transaction and must not invoke external delivery from it.
func (s *Service) ScheduleMessageInTx(ctx context.Context, tx Tx, input ScheduleInput) (int, error) {
	if err := s.checkReady("schedule ntfy message"); err != nil {
		return 0, err
	}
	return s.scheduleMessage(ctx, input, tx)
}

func (s *Service) scheduleMessage(ctx context.Context, input ScheduleInput, suppliedTx Tx) (int, error) {
	if strings.TrimSpace(input.MessageID) == "" || strings.TrimSpace(input.ConversationID) == "" || strings.TrimSpace(input.AuthorID) == "" {
		return 0, internalError("schedule ntfy message", errors.New("message, conversation, and author are required"))
	}
	if input.CreatedAt.IsZero() {
		return 0, internalError("schedule ntfy message", errors.New("message timestamp is required"))
	}
	input.SpaceID = strings.TrimSpace(input.SpaceID)
	if input.SpaceID == "" {
		input.SpaceID = s.space()
	}
	createdAt := input.CreatedAt.UTC().Truncate(time.Millisecond)
	availableAt := createdAt.Add(DeliveryDelay)
	mentioned := input.mentionUserIDs()
	insert := func(tx Tx) (int, error) {
		if tx == nil {
			return 0, internalError("schedule ntfy message", errors.New("transaction is required"))
		}
		recipients, err := tx.ListRecipients(ctx, ScheduleRecipientQuery{
			SpaceID: input.SpaceID, ConversationID: input.ConversationID, TopicID: input.TopicID, AuthorID: input.AuthorID,
		})
		if err != nil {
			return 0, normalizeRepositoryError(err)
		}
		queued := 0
		for _, recipient := range recipients {
			if strings.TrimSpace(recipient.UserID) == "" || recipient.UserID == input.AuthorID {
				continue
			}
			level := recipient.NotificationLevel
			if level == "muted" || (level == "mentions" && !hasMention(mentioned, recipient.UserID)) {
				continue
			}
			actor := &auth.Actor{ID: recipient.UserID, GitHubLogin: recipient.GitHubLogin, Kind: "human", Role: "member"}
			preference, err := s.ensurePreferences(ctx, tx, actor, createdAt)
			if err != nil {
				return 0, err
			}
			if !preference.Enabled {
				continue
			}
			id, err := s.newID("ntfy job")
			if err != nil {
				return 0, internalError("generate ntfy job id", err)
			}
			inserted, err := tx.InsertJob(ctx, JobInsert{
				ID: id, UserID: recipient.UserID, MessageID: input.MessageID, ConversationID: input.ConversationID,
				EventSeq: input.EventSeq, AvailableAt: availableAt, NextAttemptAt: availableAt, CreatedAt: createdAt,
			})
			if err != nil {
				return 0, normalizeRepositoryError(err)
			}
			if inserted {
				queued++
			}
		}
		return queued, nil
	}
	if suppliedTx != nil {
		return insert(suppliedTx)
	}
	var queued int
	if err := s.repo.WithTx(ctx, func(tx Tx) error {
		var err error
		queued, err = insert(tx)
		return err
	}); err != nil {
		return 0, normalizeRepositoryError(err)
	}
	return queued, nil
}

func (s *Service) ProcessJobs(ctx context.Context) (ProcessResult, error) {
	if err := s.checkReady("process ntfy jobs"); err != nil {
		return ProcessResult{}, err
	}
	return s.processJobs(ctx, s.workerOptions)
}

func (s *Service) processJobs(ctx context.Context, options WorkerOptions) (ProcessResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if options.Lease <= 0 {
		options.Lease = DefaultWorkerLease
	}
	if options.BatchSize <= 0 || options.BatchSize > MaximumJobBatchSize {
		options.BatchSize = DefaultJobBatchSize
	}
	listedAt := s.nowUTC()
	ids, err := s.repo.ListDueJobs(ctx, listedAt, options.BatchSize)
	if err != nil {
		return ProcessResult{}, normalizeRepositoryError(err)
	}
	result := ProcessResult{}
	for _, id := range ids {
		claimedAt := s.nowUTC()
		leaseUntil := claimedAt.Add(options.Lease)
		claimed, err := s.repo.ClaimJob(ctx, id, leaseUntil, claimedAt)
		if err != nil {
			return result, normalizeRepositoryError(err)
		}
		if !claimed {
			continue
		}
		result.Claimed++
		job, err := s.repo.GetDeliveryJob(ctx, id)
		if err != nil {
			return result, normalizeRepositoryError(err)
		}
		if job == nil || !isEligible(*job) || (job.NotificationLevel == "mentions" && !messageMentions(job.ContentJSON, job.UserID)) {
			if err := s.repo.CancelJob(ctx, id, s.nowUTC()); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Cancelled++
			continue
		}
		notification := buildNotification(s.frontend(), *job)
		publisher := s.publisher
		if publisher == nil {
			return result, notConfiguredError(errors.New("publisher is required"))
		}
		publishCtx, cancel := context.WithTimeout(ctx, DefaultPublishTimeout)
		err = publisher.Publish(publishCtx, notification)
		cancel()
		completedAt := s.nowUTC()
		if err == nil {
			if err := s.repo.MarkSent(ctx, id, completedAt); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Sent++
			continue
		}
		code := normalizeProviderError(err)
		attempt := job.AttemptCount + 1
		if attempt <= len(RetryDelays) {
			if err := s.repo.RetryJob(ctx, id, attempt, completedAt.Add(RetryDelays[attempt-1]), code); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Retried++
		} else {
			if err := s.repo.MarkFailed(ctx, id, attempt, code); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Failed++
		}
	}
	return result, nil
}

func (s *Service) StartWorker(ctx context.Context, options WorkerOptions) *WorkerHandle {
	if ctx == nil {
		ctx = context.Background()
	}
	if options.Interval <= 0 {
		options.Interval = s.workerOptions.Interval
	}
	if options.Lease <= 0 {
		options.Lease = s.workerOptions.Lease
	}
	if options.BatchSize <= 0 {
		options.BatchSize = s.workerOptions.BatchSize
	}
	child, cancel := context.WithCancel(ctx)
	var stopOnce sync.Once
	var tickMu sync.Mutex
	stop := func() {
		stopOnce.Do(cancel)
	}
	tick := func(tickCtx context.Context) (ProcessResult, error) {
		tickMu.Lock()
		defer tickMu.Unlock()
		if options.Disabled || child.Err() != nil {
			return ProcessResult{}, nil
		}
		return s.processJobs(tickCtx, options)
	}
	if options.Disabled {
		return &WorkerHandle{Stop: stop, Tick: tick}
	}
	startup := options.StartupDelay
	if startup < 0 {
		startup = 0
	}
	go func() {
		timer := time.NewTimer(startup)
		defer timer.Stop()
		select {
		case <-child.Done():
			return
		case <-timer.C:
		}
		_, _ = tick(child)
		ticker := time.NewTicker(options.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-child.Done():
				return
			case <-ticker.C:
				_, _ = tick(child)
			}
		}
	}()
	return &WorkerHandle{Stop: stop, Tick: tick}
}

func (s *Service) CancelPendingJobs(ctx context.Context, userID string) error {
	if err := s.checkReady("cancel ntfy jobs"); err != nil {
		return err
	}
	if strings.TrimSpace(userID) == "" {
		return internalError("cancel ntfy jobs", errors.New("user id is required"))
	}
	if err := s.repo.CancelPendingJobs(ctx, userID, s.nowUTC()); err != nil {
		return normalizeRepositoryError(err)
	}
	return nil
}

func isEligible(job DeliveryJob) bool {
	if !job.PreferenceEnabled || job.NotificationLevel == "muted" {
		return false
	}
	if job.LastReadSeq != nil {
		return job.EventSeq > *job.LastReadSeq
	}
	return job.LastReadAt == nil || job.MessageCreatedAt.After(*job.LastReadAt)
}

func buildNotification(frontendURL string, job DeliveryJob) Notification {
	if job.TopicID != nil && strings.TrimSpace(*job.TopicID) != "" {
		title := valueOr(job.TopicTitle, "未命名话题")
		mentioned := messageMentions(job.ContentJSON, job.UserID)
		message := fmt.Sprintf("%s 在「%s」话题中发来新消息", job.SenderName, title)
		if mentioned {
			message = fmt.Sprintf("有人在「%s」话题中 @你", title)
		}
		return Notification{Topic: job.Topic, Title: "话题 · " + title, Message: message, ClickURL: frontendURL + "/workspace/topics/" + url.PathEscape(*job.TopicID)}
	}
	mentioned := messageMentions(job.ContentJSON, job.UserID)
	message := job.SenderName + " 通过私聊给你发送了消息"
	if job.ConversationType == "group" {
		if mentioned {
			message = fmt.Sprintf("有人在「%s」群聊中 @你", job.ConversationTitle)
		} else {
			message = fmt.Sprintf("%s 通过「%s」群聊给你发送了消息", job.SenderName, job.ConversationTitle)
		}
	}
	return Notification{Topic: job.Topic, Title: "DualLane", Message: message, ClickURL: frontendURL + "/workspace/chat/" + url.PathEscape(job.ConversationID)}
}

func (s *Service) projectPreferences(record PreferenceRecord) Preferences {
	result := Preferences{
		Enabled:         record.Enabled,
		Topic:           record.Topic,
		ServerURL:       s.server(),
		SubscriptionURL: s.server() + "/" + url.PathEscape(record.Topic),
		CreatedAt:       formatTimestamp(record.CreatedAt),
		UpdatedAt:       formatTimestamp(record.UpdatedAt),
	}
	if record.RotatedAt != nil {
		value := formatTimestamp(*record.RotatedAt)
		result.RotatedAt = &value
	}
	return result
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func CreateTopic(githubLogin string) (string, error) {
	return createTopic(githubLogin, func(max int) (int, error) {
		value, err := rand.Int(rand.Reader, big.NewInt(int64(max)))
		if err != nil {
			return 0, err
		}
		return int(value.Int64()), nil
	})
}

func createTopic(githubLogin string, randomIndex func(int) (int, error)) (string, error) {
	login := strings.ToLower(strings.TrimSpace(githubLogin))
	var builder strings.Builder
	for _, character := range login {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-' {
			builder.WriteRune(character)
		} else {
			builder.WriteByte('-')
		}
	}
	login = builder.String()
	if login == "" {
		login = "user"
	}
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	var suffix strings.Builder
	for index := 0; index < TopicRandomLength; index++ {
		value, err := randomIndex(len(alphabet))
		if err != nil {
			return "", err
		}
		if value < 0 || value >= len(alphabet) {
			return "", errors.New("topic random index out of range")
		}
		suffix.WriteByte(alphabet[value])
	}
	return TopicPrefix + "-" + login + "-" + suffix.String(), nil
}

func hasMention(mentions map[string]struct{}, userID string) bool {
	_, ok := mentions[strings.TrimSpace(userID)]
	return ok
}

func messageMentions(raw []byte, userID string) bool {
	if len(raw) == 0 || len(raw) > MaximumJSONBytes || strings.TrimSpace(userID) == "" {
		return false
	}
	var content struct {
		Blocks []Block `json:"blocks"`
	}
	if json.Unmarshal(raw, &content) != nil {
		return false
	}
	for _, block := range content.Blocks {
		if block.Type == "mention" && strings.TrimSpace(block.UserID) == strings.TrimSpace(userID) {
			return true
		}
	}
	return false
}

func valueOr(value *string, fallback string) string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return fallback
	}
	return *value
}

func normalizeServerURL(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		value = DefaultServerURL
	}
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("ntfy server URL must be a valid HTTPS URL without credentials or query")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func normalizeFrontendURL(value string) string {
	if strings.TrimSpace(value) == "" {
		return DefaultFrontendURL
	}
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return DefaultFrontendURL
	}
	return strings.TrimRight(parsed.String(), "/")
}
