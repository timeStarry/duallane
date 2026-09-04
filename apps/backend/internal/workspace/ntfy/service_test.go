package ntfy

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type fakeRepository struct {
	actors      map[string]*auth.Actor
	prefs       map[string]*PreferenceRecord
	recipients  map[string][]RecipientRecord
	jobs        map[string]JobInsert
	delivery    map[string]*DeliveryJob
	due         []string
	cancelled   map[string]bool
	clock       time.Time
	insertCount int
	jobSequence int
	claimTimes  []time.Time

	failCreate bool
}

func newFakeRepository(now time.Time) *fakeRepository {
	return &fakeRepository{
		actors:     make(map[string]*auth.Actor),
		prefs:      make(map[string]*PreferenceRecord),
		recipients: make(map[string][]RecipientRecord),
		jobs:       make(map[string]JobInsert),
		delivery:   make(map[string]*DeliveryJob),
		cancelled:  make(map[string]bool),
		clock:      now,
	}
}

func (f *fakeRepository) WithTx(_ context.Context, fn func(Tx) error) error {
	return fn(f)
}

func (f *fakeRepository) LookupActor(_ context.Context, _ string, userID string) (*auth.Actor, error) {
	actor := f.actors[userID]
	if actor == nil {
		return nil, nil
	}
	copy := *actor
	return &copy, nil
}

func (f *fakeRepository) GetPreferences(_ context.Context, userID string) (*PreferenceRecord, error) {
	record := f.prefs[userID]
	if record == nil {
		return nil, nil
	}
	copy := *record
	if record.RotatedAt != nil {
		value := *record.RotatedAt
		copy.RotatedAt = &value
	}
	return &copy, nil
}

func (f *fakeRepository) ListRecipients(_ context.Context, query ScheduleRecipientQuery) ([]RecipientRecord, error) {
	key := query.ConversationID
	if query.TopicID != "" {
		key = query.TopicID
	}
	return append([]RecipientRecord(nil), f.recipients[key]...), nil
}

func (f *fakeRepository) ListDueJobs(_ context.Context, now time.Time, _ int) ([]string, error) {
	result := make([]string, 0, len(f.due))
	for _, id := range f.due {
		job, ok := f.jobs[id]
		if !ok || f.cancelled[id] || !job.NextAttemptAt.After(now) {
			result = append(result, id)
		}
	}
	return result, nil
}

func (f *fakeRepository) GetDeliveryJob(_ context.Context, id string) (*DeliveryJob, error) {
	job := f.delivery[id]
	if job == nil {
		return nil, nil
	}
	copy := *job
	copy.ContentJSON = append([]byte(nil), job.ContentJSON...)
	return &copy, nil
}

func (f *fakeRepository) ClaimJob(_ context.Context, id string, leaseUntil, now time.Time) (bool, error) {
	job, ok := f.jobs[id]
	if !ok || f.cancelled[id] || job.NextAttemptAt.After(now) {
		return false, nil
	}
	job.NextAttemptAt = now
	job.AvailableAt = leaseUntil
	f.jobs[id] = job
	f.claimTimes = append(f.claimTimes, now)
	return true, nil
}

func (f *fakeRepository) MarkSent(_ context.Context, id string, _ time.Time) error {
	delete(f.jobs, id)
	return nil
}

func (f *fakeRepository) RetryJob(_ context.Context, id string, attempt int, next time.Time, code string) error {
	job := f.jobs[id]
	if _, ok := f.jobs[id]; !ok {
		return errors.New("missing job")
	}
	job.EventSeq = int64(attempt)
	job.NextAttemptAt = next
	if delivery := f.delivery[id]; delivery != nil {
		delivery.AttemptCount = attempt
	}
	f.jobs[id] = job
	if code == "" {
		return errors.New("missing error code")
	}
	return nil
}

func (f *fakeRepository) MarkFailed(_ context.Context, id string, attempt int, _ string) error {
	job := f.jobs[id]
	if _, ok := f.jobs[id]; !ok {
		return errors.New("missing job")
	}
	job.EventSeq = int64(attempt)
	job.NextAttemptAt = time.Unix(1<<62, 0)
	if delivery := f.delivery[id]; delivery != nil {
		delivery.AttemptCount = attempt
	}
	f.jobs[id] = job
	return nil
}

func (f *fakeRepository) CancelJob(_ context.Context, id string, _ time.Time) error {
	f.cancelled[id] = true
	return nil
}

func (f *fakeRepository) CancelPendingJobs(_ context.Context, userID string, _ time.Time) error {
	for id, job := range f.jobs {
		if job.UserID == userID {
			f.cancelled[id] = true
		}
	}
	return nil
}

func (f *fakeRepository) CreatePreferences(_ context.Context, userID, topic string, createdAt time.Time) (bool, error) {
	if f.failCreate {
		return false, errors.New("create failed")
	}
	if _, ok := f.prefs[userID]; ok {
		return false, nil
	}
	for _, record := range f.prefs {
		if record.Topic == topic {
			return false, nil
		}
	}
	f.prefs[userID] = &PreferenceRecord{UserID: userID, Topic: topic, Enabled: true, CreatedAt: createdAt, UpdatedAt: createdAt}
	return true, nil
}

func (f *fakeRepository) UpdatePreferences(_ context.Context, userID string, enabled bool, updatedAt time.Time) error {
	record := f.prefs[userID]
	if record == nil {
		return errors.New("missing preference")
	}
	record.Enabled = enabled
	record.UpdatedAt = updatedAt
	return nil
}

func (f *fakeRepository) RotatePreferences(_ context.Context, userID, topic string, rotatedAt time.Time) (bool, error) {
	record := f.prefs[userID]
	if record == nil {
		return false, errors.New("missing preference")
	}
	for owner, candidate := range f.prefs {
		if owner != userID && candidate.Topic == topic {
			return false, nil
		}
	}
	if record.Topic == topic {
		return false, nil
	}
	record.Topic = topic
	record.RotatedAt = &rotatedAt
	record.UpdatedAt = rotatedAt
	return true, nil
}

func (f *fakeRepository) InsertJob(_ context.Context, input JobInsert) (bool, error) {
	for _, existing := range f.jobs {
		if existing.UserID == input.UserID && existing.MessageID == input.MessageID {
			return false, nil
		}
	}
	f.jobs[input.ID] = input
	f.due = append(f.due, input.ID)
	f.insertCount++
	return true, nil
}

func (f *fakeRepository) TestTx() Tx { return f }

func TestCreateTopicUsesNodeCompatibleShapeAndFailsOnRandomError(t *testing.T) {
	index := func(max int) (int, error) { return 0, nil }
	if got, err := createTopic("TimeStarry", index); err != nil || got != "duallane-timestarry-AAAAAA" {
		t.Fatalf("topic = %q, err = %v", got, err)
	}
	if got, err := createTopic("  !!! ", index); err != nil || got != "duallane-----AAAAAA" {
		t.Fatalf("fallback topic = %q, err = %v", got, err)
	}
	want := errors.New("entropy unavailable")
	if _, err := createTopic("user", func(int) (int, error) { return 0, want }); !errors.Is(err, want) {
		t.Fatalf("random error = %v, want %v", err, want)
	}
}

func TestPreferencesAreStableRotateAndCancelPendingJobs(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 987654321, time.FixedZone("CST", 8*60*60))
	repo := newFakeRepository(now)
	repo.actors["owner"] = &auth.Actor{ID: "owner", Kind: "human", Role: "owner", GitHubLogin: "TimeStarry"}
	sequence := 0
	service := NewService(ServiceOptions{
		Repository: repo,
		Now:        func() time.Time { return now },
		TopicFactory: func(string) (string, error) {
			sequence++
			return []string{"duallane-owner-AAAAAA", "duallane-owner-BBBBBB"}[sequence-1], nil
		},
		IDFactory:   func() (string, error) { return "job", nil },
		ServerURL:   "https://ntfy.example.test/",
		FrontendURL: "https://duallane.example.test/",
		Publisher:   PublisherFunc(func(context.Context, PublishInput) error { return nil }),
	})
	first, err := service.GetPreferences(context.Background(), "owner")
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.GetPreferences(context.Background(), "owner")
	if err != nil || first.Topic != second.Topic || first.CreatedAt != "2026-09-04T04:00:00.987Z" {
		t.Fatalf("stable preferences first=%#v second=%#v err=%v", first, second, err)
	}
	disabled, err := service.UpdatePreferences(context.Background(), UpdatePreferencesInput{ActorID: "owner", Enabled: pointer(false)})
	if err != nil || disabled.Enabled {
		t.Fatalf("disabled preferences=%#v err=%v", disabled, err)
	}
	rotated, err := service.RotateTopic(context.Background(), RotateTopicInput{ActorID: "owner"})
	if err != nil || rotated.Topic != "duallane-owner-BBBBBB" || rotated.RotatedAt == nil || *rotated.RotatedAt != "2026-09-04T04:00:00.987Z" {
		t.Fatalf("rotated preferences=%#v err=%v", rotated, err)
	}
}

func TestScheduleFiltersMentionLevelsAndNeverStoresContent(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	repo := newFakeRepository(now)
	repo.actors["author"] = &auth.Actor{ID: "author", Kind: "human", Role: "member"}
	for _, id := range []string{"all", "mentions", "muted"} {
		repo.actors[id] = &auth.Actor{ID: id, Kind: "human", Role: "member", GitHubLogin: id}
	}
	repo.recipients["conversation"] = []RecipientRecord{
		{UserID: "all", GitHubLogin: "all", NotificationLevel: "all"},
		{UserID: "mentions", GitHubLogin: "mentions", NotificationLevel: "mentions"},
		{UserID: "muted", GitHubLogin: "muted", NotificationLevel: "muted"},
	}
	service := NewService(ServiceOptions{
		Repository: repo,
		Now:        func() time.Time { return now },
		IDFactory: func() (string, error) {
			repo.jobSequence++
			return "job-" + string(rune('0'+repo.jobSequence)), nil
		},
		TopicFactory: func(login string) (string, error) { return "topic-" + login, nil },
		Publisher:    PublisherFunc(func(context.Context, PublishInput) error { return nil }),
	})
	secret := "this message body must never enter ntfy state"
	if err := service.ScheduleMessage(context.Background(), ScheduleInput{
		AuthorID: "author", ConversationID: "conversation", MessageID: "message", EventSeq: 7,
		ContentJSON: []byte(`{"blocks":[{"type":"mention","userId":"mentions"}],"plainText":"` + secret + `"}`), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if repo.insertCount != 2 {
		t.Fatalf("inserted jobs = %d, want all and mentions", repo.insertCount)
	}
	if strings.Contains(string(mustJSON(repo.jobs)), secret) {
		t.Fatal("message content entered job state")
	}
	if got := repo.jobs["job-1"].AvailableAt; !got.Equal(now.Add(DeliveryDelay)) {
		t.Fatalf("availableAt=%s", got)
	}
	if err := service.ScheduleMessage(context.Background(), ScheduleInput{AuthorID: "author", ConversationID: "conversation", MessageID: "message", EventSeq: 7, Content: Content{Blocks: []Block{{Type: "mention", UserID: "mentions"}}}, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if repo.insertCount != 2 {
		t.Fatalf("duplicate schedule inserted jobs = %d", repo.insertCount)
	}
}

func TestProcessCancelsUnreadAndMentionRechecksAndBoundsRetries(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	repo := newFakeRepository(now)
	repo.jobs["read"] = JobInsert{ID: "read", UserID: "viewer", MessageID: "m-read", NextAttemptAt: now}
	repo.jobs["retry"] = JobInsert{ID: "retry", UserID: "viewer", MessageID: "m-retry", NextAttemptAt: now}
	repo.jobs["mention"] = JobInsert{ID: "mention", UserID: "viewer", MessageID: "m-mention", NextAttemptAt: now}
	repo.due = []string{"read", "retry", "mention"}
	readAt := now.Add(-time.Second)
	repo.delivery["read"] = &DeliveryJob{ID: "read", UserID: "viewer", PreferenceEnabled: true, NotificationLevel: "all", EventSeq: 1, LastReadSeq: pointerInt64(2), MessageCreatedAt: now, ContentJSON: []byte(`{"blocks":[]}`)}
	repo.delivery["retry"] = &DeliveryJob{ID: "retry", UserID: "viewer", PreferenceEnabled: true, NotificationLevel: "all", EventSeq: 3, LastReadAt: &readAt, MessageCreatedAt: now, ContentJSON: []byte(`{"blocks":[]}`), Topic: "duallane-viewer-ABC123", ConversationID: "conv", ConversationType: "direct", SenderName: "sender"}
	repo.delivery["mention"] = &DeliveryJob{ID: "mention", UserID: "viewer", PreferenceEnabled: true, NotificationLevel: "mentions", EventSeq: 3, LastReadAt: &readAt, MessageCreatedAt: now, ContentJSON: []byte(`{"blocks":[{"type":"text","text":"plain"}]}`)}
	failures := 0
	service := NewService(ServiceOptions{Repository: repo, Now: func() time.Time { return now }, Publisher: PublisherFunc(func(context.Context, PublishInput) error { failures++; return errors.New("provider detail") })})
	result, err := service.ProcessJobs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Cancelled != 2 || result.Retried != 1 || failures != 1 {
		t.Fatalf("first process result=%#v failures=%d cancelled=%#v", result, failures, repo.cancelled)
	}
	if repo.jobs["retry"].EventSeq != 1 || !repo.jobs["retry"].NextAttemptAt.Equal(now.Add(RetryDelays[0])) {
		t.Fatalf("retry state=%#v", repo.jobs["retry"])
	}
	now = now.Add(RetryDelays[0] + time.Millisecond)
	for attempt := 0; attempt < 3; attempt++ {
		_, err = service.ProcessJobs(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if attempt < 2 {
			now = now.Add(RetryDelays[attempt+1] + time.Millisecond)
		}
	}
	if repo.jobs["retry"].EventSeq != 4 || !repo.jobs["retry"].NextAttemptAt.After(now) {
		t.Fatalf("terminal retry state=%#v", repo.jobs["retry"])
	}
}

func TestProcessRefreshesLeaseClockForEachJob(t *testing.T) {
	base := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	repo := newFakeRepository(base)
	for _, id := range []string{"first", "second"} {
		repo.jobs[id] = JobInsert{ID: id, NextAttemptAt: base}
		repo.due = append(repo.due, id)
	}
	current := base.Add(-time.Second)
	service := NewService(ServiceOptions{
		Repository: repo,
		Now: func() time.Time {
			current = current.Add(time.Second)
			return current
		},
		Publisher: PublisherFunc(func(context.Context, PublishInput) error { return nil }),
	})
	if _, err := service.ProcessJobs(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(repo.claimTimes) != 2 || !repo.claimTimes[1].After(repo.claimTimes[0]) {
		t.Fatalf("claim times = %v", repo.claimTimes)
	}
	if !repo.jobs["second"].AvailableAt.After(repo.jobs["first"].AvailableAt) {
		t.Fatalf("lease deadlines first=%s second=%s", repo.jobs["first"].AvailableAt, repo.jobs["second"].AvailableAt)
	}
}

func TestProviderErrorsAreClassifiedWithoutRawDetails(t *testing.T) {
	if got := NormalizeProviderError(&ProviderError{StatusCode: 503}); got != "ntfy.http_503" {
		t.Fatalf("status code=%q", got)
	}
	if got := NormalizeProviderError(context.DeadlineExceeded); got != CodeProviderTimeout {
		t.Fatalf("deadline code=%q", got)
	}
	if got := NormalizeProviderError(errors.New("raw upstream secret")); got != CodeProviderUnavailable || strings.Contains(got, "secret") {
		t.Fatalf("raw provider code=%q", got)
	}
}

func TestServiceRejectsMissingOrNonHumanActor(t *testing.T) {
	repo := newFakeRepository(time.Now())
	repo.actors["bot"] = &auth.Actor{ID: "bot", Kind: "bot", Role: "member"}
	service := NewService(ServiceOptions{Repository: repo})
	if _, err := service.GetPreferences(context.Background(), "missing"); !hasCode(err, CodeAuthRequired) {
		t.Fatalf("missing actor error=%v", err)
	}
	if _, err := service.GetPreferences(context.Background(), "bot"); !hasCode(err, CodeIdentityForbidden) {
		t.Fatalf("bot actor error=%v", err)
	}
}

func pointer(value bool) *bool { return &value }

func pointerInt64(value int64) *int64 { return &value }

func hasCode(err error, code string) bool {
	var value *Error
	return errors.As(err, &value) && value.Code == code
}

func mustJSON(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}
