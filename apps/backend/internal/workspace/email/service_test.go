package email

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type emailFakeRepository struct {
	actors     map[string]*auth.Actor
	prefs      map[string]*PreferenceRecord
	settings   *SMTPSettingsRecord
	challenges map[string]*ChallengeRecord
	recipients map[string][]RecipientRecord
	jobs       map[string]JobInsert
	statuses   map[string]JobStatus
	attempts   map[string]int
	delivery   map[string]*DeliveryJob
	digests    map[string]*DigestState
	audits     []AuditInput
	due        []string
	mailTests  int
}

func newEmailFake() *emailFakeRepository {
	return &emailFakeRepository{
		actors: make(map[string]*auth.Actor), prefs: make(map[string]*PreferenceRecord),
		challenges: make(map[string]*ChallengeRecord), recipients: make(map[string][]RecipientRecord),
		jobs: make(map[string]JobInsert), statuses: make(map[string]JobStatus), attempts: make(map[string]int), delivery: make(map[string]*DeliveryJob), digests: make(map[string]*DigestState),
	}
}

func TestPGRepositoryBindTxNil(t *testing.T) {
	var repository *PGRepository
	if repository.BindTx(nil) != nil {
		t.Fatal("nil repository must not bind a transaction")
	}
	if (&PGRepository{}).BindTx(nil) != nil {
		t.Fatal("nil transaction must not produce an adapter")
	}
}

func (f *emailFakeRepository) WithTx(_ context.Context, fn func(Tx) error) error { return fn(f) }

func (f *emailFakeRepository) LookupActor(_ context.Context, _ string, id string) (*auth.Actor, error) {
	actor := f.actors[id]
	if actor == nil {
		return nil, nil
	}
	copy := *actor
	return &copy, nil
}

func (f *emailFakeRepository) GetPreferences(_ context.Context, id string) (*PreferenceRecord, error) {
	return f.preference(id), nil
}

func (f *emailFakeRepository) preference(id string) *PreferenceRecord {
	record := f.prefs[id]
	if record == nil {
		return nil
	}
	copy := *record
	if record.Email != nil {
		value := *record.Email
		copy.Email = &value
	}
	if record.EmailVerifiedAt != nil {
		value := *record.EmailVerifiedAt
		copy.EmailVerifiedAt = &value
	}
	return &copy
}

func (f *emailFakeRepository) GetSpaceSettings(context.Context, string) (*SMTPSettingsRecord, error) {
	if f.settings == nil {
		return nil, nil
	}
	copy := *f.settings
	if f.settings.ActiveFrom != nil {
		value := *f.settings.ActiveFrom
		copy.ActiveFrom = &value
	}
	if f.settings.LastTestedAt != nil {
		value := *f.settings.LastTestedAt
		copy.LastTestedAt = &value
	}
	return &copy, nil
}

func (f *emailFakeRepository) CountSMTPTests(context.Context, string, time.Time) (int, error) {
	return f.mailTests, nil
}

func (f *emailFakeRepository) CountRecentChallenges(_ context.Context, userID string, since time.Time) (int, *time.Time, error) {
	count := 0
	var latest *time.Time
	for _, challenge := range f.challenges {
		if challenge.UserID != userID || challenge.CreatedAt.Before(since) {
			continue
		}
		count++
		if latest == nil || challenge.CreatedAt.After(*latest) {
			value := challenge.CreatedAt
			latest = &value
		}
	}
	return count, latest, nil
}

func (f *emailFakeRepository) GetChallenge(_ context.Context, userID, id string) (*ChallengeRecord, error) {
	challenge := f.challenges[id]
	if challenge == nil || challenge.UserID != userID {
		return nil, nil
	}
	copy := *challenge
	if challenge.ConsumedAt != nil {
		value := *challenge.ConsumedAt
		copy.ConsumedAt = &value
	}
	return &copy, nil
}

func (f *emailFakeRepository) FailedJobCount(context.Context, string) (int64, error) {
	var count int64
	for _, job := range f.jobs {
		if jobStatus(f, job.ID) == JobFailed {
			count++
		}
	}
	return count, nil
}

func (f *emailFakeRepository) LastDeliveryAt(context.Context, string) (*time.Time, error) {
	return nil, nil
}

func (f *emailFakeRepository) ListRecipients(_ context.Context, query ScheduleRecipientQuery) ([]RecipientRecord, error) {
	key := query.ConversationID
	if query.TopicID != "" {
		key = query.TopicID
	}
	return append([]RecipientRecord(nil), f.recipients[key]...), nil
}

func (f *emailFakeRepository) ListDueJobs(_ context.Context, _ string, now time.Time, _ int) ([]string, error) {
	result := make([]string, 0)
	for _, id := range f.due {
		job, ok := f.jobs[id]
		if ok && (f.statuses[id] == JobPending || f.statuses[id] == JobSending) && !job.NextAttemptAt.After(now) {
			result = append(result, id)
		}
	}
	return result, nil
}

func (f *emailFakeRepository) GetDeliveryJob(_ context.Context, id string) (*DeliveryJob, error) {
	job := f.delivery[id]
	if job == nil {
		return nil, nil
	}
	copy := *job
	copy.ContentJSON = append([]byte(nil), job.ContentJSON...)
	if job.EmailVerifiedAt != nil {
		value := *job.EmailVerifiedAt
		copy.EmailVerifiedAt = &value
	}
	return &copy, nil
}

func (f *emailFakeRepository) ListDigestStates(_ context.Context, _ string, _ time.Time, _ int) ([]DigestState, error) {
	result := make([]DigestState, 0, len(f.digests))
	for _, state := range f.digests {
		result = append(result, *state)
	}
	return result, nil
}

func (f *emailFakeRepository) ListEligibleUnreadMessages(_ context.Context, _, userID string, startedAt time.Time) ([]UnreadMessage, error) {
	result := make([]UnreadMessage, 0)
	for _, job := range f.delivery {
		if job.UserID != userID || job.MessageCreatedAt.Before(startedAt) {
			continue
		}
		result = append(result, UnreadMessage{ID: job.MessageID, CreatedAt: job.MessageCreatedAt, ContentJSON: job.ContentJSON, EventSeq: job.EventSeq, NotificationLevel: job.NotificationLevel, LastReadSeq: job.LastReadSeq, LastReadAt: job.LastReadAt})
	}
	return result, nil
}

func (f *emailFakeRepository) ClaimJob(_ context.Context, id string, leaseUntil, now time.Time) (bool, error) {
	job, ok := f.jobs[id]
	if !ok || job.NextAttemptAt.After(now) {
		return false, nil
	}
	job.NextAttemptAt = now
	f.jobs[id] = job
	f.statuses[id] = JobSending
	if delivery := f.delivery[id]; delivery != nil {
		delivery.AttemptCount = f.attempts[id]
	}
	_ = leaseUntil
	return true, nil
}

func (f *emailFakeRepository) DeferJob(_ context.Context, id string, next time.Time) error {
	job, ok := f.jobs[id]
	if !ok {
		return errors.New("job missing")
	}
	job.NextAttemptAt = next
	f.jobs[id] = job
	f.statuses[id] = JobPending
	return nil
}

func (f *emailFakeRepository) MarkSent(_ context.Context, id string, _ time.Time) error {
	f.statuses[id] = JobSent
	delete(f.jobs, id)
	return nil
}

func (f *emailFakeRepository) RetryJob(_ context.Context, id string, attempt int, next time.Time, _ string) error {
	job, ok := f.jobs[id]
	if !ok {
		return errors.New("job missing")
	}
	job.NextAttemptAt = next
	f.jobs[id] = job
	f.statuses[id] = JobPending
	f.attempts[id] = attempt
	if delivery := f.delivery[id]; delivery != nil {
		delivery.AttemptCount = attempt
	}
	return nil
}

func (f *emailFakeRepository) MarkFailed(_ context.Context, id string, attempt int, _ string) error {
	if _, ok := f.jobs[id]; !ok {
		return errors.New("job missing")
	}
	if delivery := f.delivery[id]; delivery != nil {
		delivery.AttemptCount = attempt
	}
	f.statuses[id] = JobFailed
	f.attempts[id] = attempt
	return nil
}

func (f *emailFakeRepository) CancelJob(_ context.Context, id string, _ time.Time) error {
	f.statuses[id] = JobCancelled
	delete(f.jobs, id)
	return nil
}

func (f *emailFakeRepository) DeleteDigestState(_ context.Context, id string) error {
	delete(f.digests, id)
	return nil
}

func (f *emailFakeRepository) ClaimDigestState(_ context.Context, id string, _, now time.Time) (bool, error) {
	state := f.digests[id]
	return state != nil && state.NotifiedAt == nil && !state.NextAttemptAt.After(now), nil
}

func (f *emailFakeRepository) MarkDigestSent(_ context.Context, id string, now time.Time) error {
	if state := f.digests[id]; state != nil {
		state.NotifiedAt = timePtr(now)
	}
	return nil
}

func (f *emailFakeRepository) RetryDigestState(_ context.Context, id string, attempt int, next time.Time, _ string, _ time.Time) error {
	if state := f.digests[id]; state != nil {
		state.AttemptCount = attempt
		state.NextAttemptAt = next
	}
	return nil
}

func (f *emailFakeRepository) EnsurePreferences(_ context.Context, actor *auth.Actor, now time.Time) (*PreferenceRecord, error) {
	if f.prefs[actor.ID] == nil {
		var email *string
		var verified *time.Time
		if actor.Email != "" {
			value := actor.Email
			email = &value
			valueTime := now
			verified = &valueTime
		}
		f.prefs[actor.ID] = &PreferenceRecord{UserID: actor.ID, Email: email, EmailSource: "github", EmailVerifiedAt: verified, Enabled: true, Digest: true, UpdatedAt: now}
	}
	return f.preference(actor.ID), nil
}

func (f *emailFakeRepository) UpdatePreferences(_ context.Context, id string, enabled, immediate, digest bool, at time.Time) error {
	record := f.prefs[id]
	if record == nil {
		return errors.New("preference missing")
	}
	record.Enabled, record.Immediate, record.Digest, record.UpdatedAt = enabled, immediate, digest, at
	return nil
}

func (f *emailFakeRepository) UpsertSpaceSettings(_ context.Context, input SpaceSettingsWrite) error {
	f.settings = &SMTPSettingsRecord{SpaceID: input.SpaceID, Enabled: input.Enabled, SMTPHost: input.SMTPHost, SMTPPort: input.SMTPPort, Encryption: input.Encryption, Username: input.Username, FromAddress: input.FromAddress, FromName: input.FromName, PasswordCiphertext: input.PasswordCiphertext, ActiveFrom: input.ActiveFrom, LastTestedAt: input.LastTestedAt, LastTestStatus: optionalString(input.LastTestStatus), LastTestErrorCode: optionalString(input.LastTestErrorCode), UpdatedAt: input.UpdatedAt}
	return nil
}

func (f *emailFakeRepository) CancelPendingJobs(_ context.Context, userID string, _ time.Time) error {
	for id, job := range f.jobs {
		if job.UserID == userID {
			delete(f.jobs, id)
		}
	}
	return nil
}

func (f *emailFakeRepository) CancelAllJobs(context.Context, time.Time) error {
	f.jobs = make(map[string]JobInsert)
	return nil
}
func (f *emailFakeRepository) DeleteAllDigestStates(context.Context) error {
	f.digests = make(map[string]*DigestState)
	return nil
}
func (f *emailFakeRepository) DeleteUserDigestState(_ context.Context, userID string) error {
	delete(f.digests, userID)
	return nil
}

func (f *emailFakeRepository) ConsumeChallenges(_ context.Context, userID string, at time.Time) error {
	for _, challenge := range f.challenges {
		if challenge.UserID == userID && challenge.ConsumedAt == nil {
			value := at
			challenge.ConsumedAt = &value
		}
	}
	return nil
}

func (f *emailFakeRepository) InsertChallenge(_ context.Context, input ChallengeInsert) error {
	f.challenges[input.ID] = &ChallengeRecord{ID: input.ID, UserID: input.UserID, PendingEmail: input.PendingEmail, CodeHash: input.CodeHash, CreatedAt: input.CreatedAt, ExpiresAt: input.ExpiresAt}
	return nil
}

func (f *emailFakeRepository) IncrementChallengeAttempt(_ context.Context, id string, now time.Time) (bool, error) {
	challenge := f.challenges[id]
	if challenge == nil || challenge.ConsumedAt != nil || !challenge.ExpiresAt.After(now) || challenge.Attempts >= MaximumCodeAttempts {
		return false, nil
	}
	challenge.Attempts++
	return true, nil
}

func (f *emailFakeRepository) ConfirmChallenge(_ context.Context, id, userID, email string, verifiedAt, _ time.Time) error {
	challenge := f.challenges[id]
	if challenge == nil || challenge.UserID != userID || challenge.ConsumedAt != nil {
		return errors.New("challenge unavailable")
	}
	challenge.ConsumedAt = timePtr(verifiedAt)
	record := f.prefs[userID]
	if record == nil {
		return errors.New("preference missing")
	}
	value := email
	record.Email, record.EmailSource, record.EmailVerifiedAt, record.UpdatedAt = &value, "custom", timePtr(verifiedAt), verifiedAt
	return nil
}

func (f *emailFakeRepository) UseGitHubEmail(_ context.Context, id, email string, at time.Time) error {
	record := f.prefs[id]
	if record == nil {
		return errors.New("preference missing")
	}
	value := email
	record.Email, record.EmailSource, record.EmailVerifiedAt, record.UpdatedAt = &value, "github", timePtr(at), at
	return nil
}

func (f *emailFakeRepository) SyncGitHubEmail(_ context.Context, id, email string, at time.Time) error {
	record := f.prefs[id]
	if record == nil || record.EmailSource != "github" {
		return nil
	}
	value := email
	record.Email, record.EmailVerifiedAt, record.UpdatedAt = &value, timePtr(at), at
	return nil
}

func (f *emailFakeRepository) InsertJob(_ context.Context, input JobInsert) (bool, error) {
	for _, job := range f.jobs {
		if job.UserID == input.UserID && job.MessageID == input.MessageID {
			return false, nil
		}
	}
	f.jobs[input.ID] = input
	f.statuses[input.ID] = JobPending
	f.due = append(f.due, input.ID)
	return true, nil
}

func (f *emailFakeRepository) InsertDigestState(_ context.Context, input DigestInsert) (bool, error) {
	if _, ok := f.digests[input.UserID]; ok {
		return false, nil
	}
	f.digests[input.UserID] = &DigestState{UserID: input.UserID, StartedAt: input.StartedAt, NextAttemptAt: input.NextAttemptAt}
	return true, nil
}

func (f *emailFakeRepository) WriteAudit(_ context.Context, input AuditInput) error {
	f.audits = append(f.audits, input)
	return nil
}

func jobStatus(f *emailFakeRepository, id string) JobStatus { return f.statuses[id] }

func TestEmailCryptoUsesLegacyV1ShapeAndNoPlaintext(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	value, err := encryptSecret("smtp-password", key, DefaultSpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(value, "smtp-password") || !strings.HasPrefix(value, "v1.") {
		t.Fatalf("ciphertext = %q", value)
	}
	plain, err := decryptSecret(value, key, DefaultSpaceID)
	if err != nil || plain != "smtp-password" {
		t.Fatalf("decrypted = %q, err=%v", plain, err)
	}
	if _, err := decryptSecret(value, key, "other-space"); !hasCode(err, CodeCredentialUnavailable) {
		t.Fatalf("wrong associated data err=%v", err)
	}
	proof, err := signTestProof(key, testProofPayload{ActorID: "owner", Fingerprint: "fp", ExpiresAt: 200})
	if err != nil || !verifyTestProof(key, proof, "owner", "fp", 100) || verifyTestProof(key, proof, "other", "fp", 100) {
		t.Fatalf("proof validation failed")
	}
}

func TestEmailSettingsChallengeAndAuditDoNotStoreSecrets(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 123456789, time.FixedZone("CST", 8*60*60))
	repo := newEmailFake()
	repo.actors["owner"] = &auth.Actor{ID: "owner", Kind: "human", Role: "owner", GitHubLogin: "owner", Email: "owner@example.test"}
	var sent []struct {
		config    MailConfig
		message   Message
		recipient string
	}
	service := NewService(ServiceOptions{Repository: repo, EncryptionKey: []byte(strings.Repeat("k", 32)), FrontendURL: "https://duallane.example.test", Now: func() time.Time { return now }, IDFactory: sequenceIDs("id-"), CodeFactory: func() (string, error) { return "123456", nil }, Mailer: MailerFunc(func(_ context.Context, config MailConfig, message Message, recipient string) error {
		sent = append(sent, struct {
			config    MailConfig
			message   Message
			recipient string
		}{config, message, recipient})
		return nil
	})})
	draft := TestSettingsInput{ActorID: "owner", SMTPHost: "smtp.example.test", SMTPPort: 587, Encryption: "starttls", Username: "sender@example.test", Password: "secret-password", FromAddress: "sender@example.test", FromName: "DualLane", Meta: auth.RequestMeta{RequestID: "email-test", IPAddress: "198.51.100.3", UserAgent: "test"}}
	tested, err := service.TestSpaceSettings(context.Background(), draft)
	if err != nil || !tested.OK || tested.Recipient != "o****@example.test" {
		t.Fatalf("test result=%#v err=%v", tested, err)
	}
	if sent[0].config.Password != "secret-password" {
		t.Fatal("mailer did not receive password")
	}
	saved, err := service.SaveSpaceSettings(context.Background(), SaveSettingsInput{ActorID: "owner", Enabled: true, SMTPHost: draft.SMTPHost, SMTPPort: draft.SMTPPort, Encryption: draft.Encryption, Username: draft.Username, Password: draft.Password, FromAddress: draft.FromAddress, FromName: draft.FromName, TestProof: tested.TestProof, Meta: draft.Meta})
	if err != nil || !saved.Enabled || !saved.PasswordConfigured {
		t.Fatalf("saved=%#v err=%v", saved, err)
	}
	challenge, err := service.CreateEmailChallenge(context.Background(), CreateChallengeInput{ActorID: "owner", Email: "custom@example.test", Meta: draft.Meta})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.VerifyEmailChallenge(context.Background(), VerifyChallengeInput{ActorID: "owner", ChallengeID: challenge.ChallengeID, Code: "000000", Meta: draft.Meta}); !hasCode(err, CodeVerificationInvalid) {
		t.Fatalf("wrong code err=%v", err)
	}
	if stored := repo.challenges[challenge.ChallengeID]; stored == nil || stored.Attempts != 1 {
		t.Fatalf("wrong-code attempt was not committed: %#v", stored)
	}
	if audit := repo.audits[len(repo.audits)-1]; audit.Result != "rejected" || audit.Reason != CodeVerificationInvalid {
		t.Fatalf("wrong-code audit was not committed: %#v", audit)
	}
	verified, err := service.VerifyEmailChallenge(context.Background(), VerifyChallengeInput{ActorID: "owner", ChallengeID: challenge.ChallengeID, Code: "123456", Meta: draft.Meta})
	if err != nil || verified.Email == nil || *verified.Email != "custom@example.test" || verified.EmailSource != "custom" {
		t.Fatalf("verified=%#v err=%v", verified, err)
	}
	for _, audit := range repo.audits {
		if strings.Contains(audit.Reason, "123456") || strings.Contains(audit.Reason, "custom@example.test") || audit.Meta.RequestID != "email-test" {
			t.Fatalf("unsafe audit=%#v", audit)
		}
	}
}

func TestEmailSchedulingRechecksUnreadAndDefersOnlineDelivery(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	repo := newEmailFake()
	repo.settings = &SMTPSettingsRecord{SpaceID: DefaultSpaceID, Enabled: true, SMTPHost: "smtp.example.test", SMTPPort: 587, Encryption: "none", FromAddress: "sender@example.test", FromName: "DualLane", ActiveFrom: timePtr(now.Add(-time.Hour))}
	repo.actors["author"] = &auth.Actor{ID: "author", Kind: "human", Role: "member"}
	repo.actors["recipient"] = &auth.Actor{ID: "recipient", Kind: "human", Role: "member", Email: "recipient@example.test"}
	repo.prefs["recipient"] = &PreferenceRecord{UserID: "recipient", Email: optionalString("recipient@example.test"), EmailSource: "github", EmailVerifiedAt: timePtr(now.Add(-time.Hour)), Enabled: true, Immediate: true, Digest: false}
	repo.recipients["conversation"] = []RecipientRecord{{UserID: "recipient", NotificationLevel: "all"}}
	secret := "private message body"
	service := NewService(ServiceOptions{Repository: repo, EncryptionKey: []byte(strings.Repeat("k", 32)), Now: func() time.Time { return now }, IDFactory: sequenceIDs("job-"), Mailer: MailerFunc(func(_ context.Context, _ MailConfig, message Message, _ string) error {
		if strings.Contains(message.Text+message.HTML, secret) {
			t.Fatal("message body entered email")
		}
		return nil
	})})
	queued, err := service.ScheduleMessage(context.Background(), ScheduleInput{AuthorID: "author", ConversationID: "conversation", MessageID: "message", EventSeq: 7, ContentJSON: []byte(`{"blocks":[{"type":"text","text":"` + secret + `"}]}`), CreatedAt: now})
	if err != nil || queued != 1 {
		t.Fatalf("queued=%d err=%v", queued, err)
	}
	jobID := "job-1"
	verified := now
	repo.delivery[jobID] = &DeliveryJob{ID: jobID, UserID: "recipient", MessageID: "message", EventSeq: 7, Email: "recipient@example.test", EmailVerifiedAt: &verified, PreferenceEnabled: true, ImmediateEnabled: true, NotificationLevel: "all", MessageCreatedAt: now, ContentJSON: []byte(`{"blocks":[{"type":"text","text":"` + secret + `"}]}`)}
	worker := service.StartWorkerWithPresence(context.Background(), PresenceFunc(func(string) bool { return true }), WorkerOptions{StartupDelay: time.Hour, Interval: time.Minute, Lease: time.Minute, BatchSize: 25, PublishTimeout: time.Second})
	if _, err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := repo.jobs[jobID]; !ok {
		t.Fatal("online recipient job was lost")
	}
	worker.Stop()
}

func TestEmailProviderRetriesAreBoundedAndClassified(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	repo := newEmailFake()
	repo.settings = &SMTPSettingsRecord{SpaceID: DefaultSpaceID, Enabled: true, SMTPHost: "smtp.example.test", SMTPPort: 587, Encryption: "none", FromAddress: "sender@example.test", FromName: "DualLane", ActiveFrom: timePtr(now.Add(-time.Hour))}
	verified := now.Add(-time.Hour)
	repo.delivery["job-1"] = &DeliveryJob{ID: "job-1", UserID: "recipient", MessageID: "message", EventSeq: 2, Email: "recipient@example.test", EmailVerifiedAt: &verified, PreferenceEnabled: true, ImmediateEnabled: true, NotificationLevel: "all", MessageCreatedAt: now}
	repo.jobs["job-1"] = JobInsert{ID: "job-1", UserID: "recipient", MessageID: "message", ConversationID: "conversation", EventSeq: 2, NextAttemptAt: now}
	repo.statuses["job-1"] = JobPending
	repo.due = []string{"job-1"}
	service := NewService(ServiceOptions{Repository: repo, EncryptionKey: []byte(strings.Repeat("k", 32)), Now: func() time.Time { return now }, Mailer: MailerFunc(func(context.Context, MailConfig, Message, string) error {
		return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
	})})
	for index, advance := range []time.Duration{0, time.Minute + time.Millisecond, 5*time.Minute + time.Millisecond, 30*time.Minute + time.Millisecond} {
		_ = index
		now = now.Add(advance)
		result, err := service.ProcessJobs(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if index < len(RetryDelays) && result.Retried != 1 {
			t.Fatalf("attempt %d result=%#v", index+1, result)
		}
		if index == len(RetryDelays) && result.Failed != 1 {
			t.Fatalf("terminal result=%#v", result)
		}
	}
	if repo.statuses["job-1"] != JobFailed || repo.attempts["job-1"] != 4 {
		t.Fatalf("status=%q attempts=%d", repo.statuses["job-1"], repo.attempts["job-1"])
	}
}

func sequenceIDs(prefix string) IDFactory {
	count := 0
	return func() (string, error) { count++; return prefix + itoa(count), nil }
}

func hasCode(err error, code string) bool {
	var emailErr *Error
	return errors.As(err, &emailErr) && emailErr.Code == code
}
