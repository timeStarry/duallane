package email

import (
	"context"
	"crypto/subtle"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

var defaultIDFactory IDFactory = newUUID
var defaultCodeFactory CodeFactory = randomCode

type Service struct {
	repo          Repository
	spaceID       string
	frontendURL   string
	encryptionKey []byte
	now           Clock
	idFactory     IDFactory
	codeFactory   CodeFactory
	mailer        Mailer
	worker        WorkerOptions
	configErr     error
}

func NewService(options ServiceOptions) *Service {
	service, err := NewServiceWithError(options)
	if err == nil {
		return service
	}
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
	frontendURL := normalizeBaseURL(options.FrontendURL)
	now := options.Now
	if now == nil {
		now = time.Now
	}
	idFactory := options.IDFactory
	if idFactory == nil {
		idFactory = defaultIDFactory
	}
	codeFactory := options.CodeFactory
	if codeFactory == nil {
		codeFactory = defaultCodeFactory
	}
	worker := options.Worker
	if worker.Interval <= 0 {
		worker.Interval = DefaultWorkerInterval
	}
	if worker.Lease <= 0 {
		worker.Lease = DefaultWorkerLease
	}
	if worker.BatchSize <= 0 || worker.BatchSize > MaximumJobBatchSize {
		worker.BatchSize = DefaultJobBatchSize
	}
	if worker.PublishTimeout <= 0 {
		worker.PublishTimeout = DefaultPublishTimeout
	}
	mailer := options.Mailer
	if mailer == nil {
		mailer = NewSMTPMailer(SMTPMailerOptions{Timeout: DefaultPublishTimeout})
	}
	key := append([]byte(nil), options.EncryptionKey...)
	if len(key) == 0 && strings.TrimSpace(options.EncryptionKeyB64) != "" {
		decoded, err := decodeEncryptionKey(nil, options.EncryptionKeyB64)
		if err != nil {
			return &Service{spaceID: spaceID, frontendURL: frontendURL}, err
		}
		key = decoded
	}
	return &Service{
		repo:          options.Repository,
		spaceID:       spaceID,
		frontendURL:   frontendURL,
		encryptionKey: key,
		now:           now,
		idFactory:     idFactory,
		codeFactory:   codeFactory,
		mailer:        mailer,
		worker:        worker,
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

func (s *Service) space() string {
	if s == nil || strings.TrimSpace(s.spaceID) == "" {
		return DefaultSpaceID
	}
	return s.spaceID
}

func (s *Service) frontend() string {
	if s == nil || strings.TrimSpace(s.frontendURL) == "" {
		return normalizeBaseURL(DefaultFrontendURL)
	}
	return s.frontendURL
}

func (s *Service) nowUTC() time.Time {
	now := time.Now()
	if s != nil && s.now != nil {
		now = s.now()
	}
	if now.IsZero() {
		now = time.Unix(0, 0)
	}
	return normalizeTime(now)
}

func (s *Service) checkReady(operation string) error {
	if s == nil {
		return internalError(operation, errors.New("service is required"))
	}
	if s.configErr != nil {
		return normalizeRepositoryError(s.configErr)
	}
	if s.repo == nil {
		return internalError(operation, errors.New("repository is required"))
	}
	return nil
}

func (s *Service) key() ([]byte, error) {
	if s == nil || len(s.encryptionKey) != 32 {
		return nil, newError(CodeEncryptionUnconfigured, MessageEncryptionMissing, 503)
	}
	return append([]byte(nil), s.encryptionKey...), nil
}

func (s *Service) newID(operation string) (string, error) {
	if s == nil || s.idFactory == nil {
		return "", internalError("generate "+operation+" id", errors.New("id factory is required"))
	}
	id, err := s.idFactory()
	if err != nil {
		return "", internalError("generate "+operation+" id", err)
	}
	if strings.TrimSpace(id) == "" {
		return "", internalError("generate "+operation+" id", errors.New("id factory returned an empty id"))
	}
	return strings.TrimSpace(id), nil
}

func (s *Service) newCode() (string, error) {
	if s == nil || s.codeFactory == nil {
		return "", internalError("generate email challenge code", errors.New("code factory is required"))
	}
	code, err := s.codeFactory()
	if err != nil || len(code) != 6 {
		if err == nil {
			err = errors.New("code factory returned an invalid code")
		}
		return "", internalError("generate email challenge code", err)
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return "", internalError("generate email challenge code", errors.New("code factory returned an invalid code"))
		}
	}
	return code, nil
}

func (s *Service) lookupActor(ctx context.Context, reader ReadRepository, actorID string) (*auth.Actor, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, newError(CodeAuthRequired, MessageAuthRequired, 401)
	}
	actor, err := reader.LookupActor(ctx, s.space(), actorID)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if actor == nil {
		return nil, newError(CodeAuthRequired, MessageAuthRequired, 401)
	}
	if actor.Kind != "human" {
		return nil, newError(CodeIdentityForbidden, MessageIdentityForbidden, 401)
	}
	if strings.TrimSpace(actor.ID) == "" || strings.TrimSpace(actor.Role) == "" {
		return nil, newError(CodeAuthRequired, MessageAuthRequired, 401)
	}
	return actor, nil
}

func (s *Service) requireOwner(ctx context.Context, reader ReadRepository, actorID string) (*auth.Actor, error) {
	actor, err := s.lookupActor(ctx, reader, actorID)
	if err != nil {
		return nil, err
	}
	if actor.Role != "owner" {
		return nil, newError(CodePermissionDenied, MessagePermissionDenied, 403)
	}
	return actor, nil
}

func (s *Service) ensurePreferences(ctx context.Context, tx Tx, actor *auth.Actor, now time.Time) (*PreferenceRecord, error) {
	if actor == nil {
		return nil, newError(CodeAuthRequired, MessageAuthRequired, 401)
	}
	record, err := tx.EnsurePreferences(ctx, actor, now)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if record == nil {
		return nil, internalError("ensure workspace email preferences", errors.New("preference row is missing"))
	}
	return record, nil
}

func (s *Service) GetPreferences(ctx context.Context, actorID string) (Preferences, error) {
	if err := s.checkReady("get workspace email preferences"); err != nil {
		return Preferences{}, err
	}
	var record *PreferenceRecord
	var actor *auth.Actor
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return internalError("get workspace email preferences", errors.New("transaction is required"))
		}
		var err error
		actor, err = s.lookupActor(ctx, tx, actorID)
		if err != nil {
			return err
		}
		record, err = s.ensurePreferences(ctx, tx, actor, s.nowUTC())
		return err
	})
	if err != nil {
		return Preferences{}, normalizeRepositoryError(err)
	}
	available, err := s.mailAvailable(ctx)
	if err != nil {
		return Preferences{}, err
	}
	return projectPreferences(record, actor.Email, available), nil
}

func (s *Service) GetSpaceSettings(ctx context.Context, actorID string) (SpaceSettings, error) {
	if err := s.checkReady("get workspace email settings"); err != nil {
		return SpaceSettings{}, err
	}
	if _, err := s.requireOwner(ctx, s.repo, actorID); err != nil {
		return SpaceSettings{}, err
	}
	settings, err := s.repo.GetSpaceSettings(ctx, s.space())
	if err != nil {
		return SpaceSettings{}, normalizeRepositoryError(err)
	}
	failed, err := s.repo.FailedJobCount(ctx, s.space())
	if err != nil {
		return SpaceSettings{}, normalizeRepositoryError(err)
	}
	last, err := s.repo.LastDeliveryAt(ctx, s.space())
	if err != nil {
		return SpaceSettings{}, normalizeRepositoryError(err)
	}
	return projectSpaceSettings(settings, failed, last), nil
}

func (s *Service) TestSpaceSettings(ctx context.Context, input TestSettingsInput) (SMTPTestResult, error) {
	if err := s.checkReady("test workspace email settings"); err != nil {
		return SMTPTestResult{}, err
	}
	actor, err := s.requireOwner(ctx, s.repo, input.ActorID)
	if err != nil {
		return SMTPTestResult{}, err
	}
	now := s.nowUTC()
	count, err := s.repo.CountSMTPTests(ctx, actor.ID, now.Add(-SMTPTestWindow))
	if err != nil {
		return SMTPTestResult{}, normalizeRepositoryError(err)
	}
	if count >= SMTPTestLimit {
		return SMTPTestResult{}, newError(CodeSMTPTestRateLimited, MessageSMTPTestRateLimited, 429)
	}
	key, err := s.key()
	if err != nil {
		return SMTPTestResult{}, err
	}
	stored, err := s.repo.GetSpaceSettings(ctx, s.space())
	if err != nil {
		return SMTPTestResult{}, normalizeRepositoryError(err)
	}
	existingPassword, err := s.decryptStoredPassword(stored, key)
	if err != nil {
		return SMTPTestResult{}, err
	}
	config, err := normalizeSMTPDraft(SMTPDraft{
		SMTPHost: input.SMTPHost, SMTPPort: input.SMTPPort, Encryption: input.Encryption,
		Username: input.Username, Password: input.Password, FromAddress: input.FromAddress, FromName: input.FromName,
	}, existingPassword)
	if err != nil {
		return SMTPTestResult{}, err
	}
	var preference *PreferenceRecord
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		actorInTx, lookupErr := s.lookupActor(ctx, tx, actor.ID)
		if lookupErr != nil {
			return lookupErr
		}
		preference, lookupErr = s.ensurePreferences(ctx, tx, actorInTx, now)
		return lookupErr
	})
	if err != nil {
		return SMTPTestResult{}, normalizeRepositoryError(err)
	}
	if preference.Email == nil || preference.EmailVerifiedAt == nil {
		return SMTPTestResult{}, newError(CodeRecipientUnverified, MessageRecipientUnverified, 400)
	}
	if s.mailer == nil {
		return SMTPTestResult{}, internalError("test workspace email settings", errors.New("mailer is required"))
	}
	message := bodyWithNoContent("邮件配置测试成功", "DualLane 已成功使用当前 SMTP 配置发送此邮件。", s.frontend())
	if err := s.mailer.Send(ctx, config, message, *preference.Email); err != nil {
		code := normalizeErrorCode(normalizeMailerError(err))
		if auditErr := s.writeAudit(ctx, actor, input.Meta, "email.smtp_test", "failure", code, now); auditErr != nil {
			return SMTPTestResult{}, auditErr
		}
		return SMTPTestResult{}, newError(code, smtpErrorMessage(code), 502)
	}
	if err := s.writeAudit(ctx, actor, input.Meta, "email.smtp_test", "success", "", now); err != nil {
		return SMTPTestResult{}, err
	}
	proof, err := signTestProof(key, testProofPayload{ActorID: actor.ID, Fingerprint: smtpFingerprint(config, key), ExpiresAt: now.Add(EmailChallengeTTL).UnixMilli()})
	if err != nil {
		return SMTPTestResult{}, err
	}
	return SMTPTestResult{OK: true, TestedAt: formatTime(now), TestProof: proof, Recipient: maskEmail(*preference.Email)}, nil
}

func (s *Service) SaveSpaceSettings(ctx context.Context, input SaveSettingsInput) (SpaceSettings, error) {
	if err := s.checkReady("save workspace email settings"); err != nil {
		return SpaceSettings{}, err
	}
	actor, err := s.requireOwner(ctx, s.repo, input.ActorID)
	if err != nil {
		return SpaceSettings{}, err
	}
	key, err := s.key()
	if err != nil {
		return SpaceSettings{}, err
	}
	stored, err := s.repo.GetSpaceSettings(ctx, s.space())
	if err != nil {
		return SpaceSettings{}, normalizeRepositoryError(err)
	}
	existingPassword, err := s.decryptStoredPassword(stored, key)
	if err != nil {
		return SpaceSettings{}, err
	}
	config, err := normalizeSMTPDraft(SMTPDraft{
		SMTPHost: input.SMTPHost, SMTPPort: input.SMTPPort, Encryption: input.Encryption,
		Username: input.Username, Password: input.Password, FromAddress: input.FromAddress, FromName: input.FromName,
	}, existingPassword)
	if err != nil {
		return SpaceSettings{}, err
	}
	now := s.nowUTC()
	enabled := input.Enabled
	if enabled && !verifyTestProof(key, input.TestProof, actor.ID, smtpFingerprint(config, key), now.UnixMilli()) {
		return SpaceSettings{}, newError(CodeSMTPTestRequired, MessageSMTPTestRequired, 400)
	}
	var activeFrom *time.Time
	if enabled {
		if stored != nil && stored.Enabled && stored.ActiveFrom != nil {
			active := normalizeTime(*stored.ActiveFrom)
			activeFrom = &active
		} else {
			active := now
			activeFrom = &active
		}
	}
	ciphertext := ""
	if config.Password != "" {
		ciphertext, err = encryptSecret(config.Password, key, s.space())
		if err != nil {
			return SpaceSettings{}, err
		}
	}
	write := SpaceSettingsWrite{
		SpaceID: s.space(), Enabled: enabled, SMTPHost: config.SMTPHost, SMTPPort: config.SMTPPort,
		Encryption: config.Encryption, Username: config.Username, FromAddress: config.FromAddress,
		FromName: config.FromName, PasswordCiphertext: ciphertext, ActiveFrom: activeFrom,
		LastTestedAt: &now, LastTestStatus: "success", UpdatedBy: actor.ID, UpdatedAt: now,
	}
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return internalError("save workspace email settings", errors.New("transaction is required"))
		}
		actorInTx, lookupErr := s.requireOwner(ctx, tx, actor.ID)
		if lookupErr != nil {
			return lookupErr
		}
		write.UpdatedBy = actorInTx.ID
		if lookupErr := tx.UpsertSpaceSettings(ctx, write); lookupErr != nil {
			return normalizeRepositoryError(lookupErr)
		}
		if !enabled {
			if lookupErr := tx.CancelAllJobs(ctx, now); lookupErr != nil {
				return normalizeRepositoryError(lookupErr)
			}
			if lookupErr := tx.DeleteAllDigestStates(ctx); lookupErr != nil {
				return normalizeRepositoryError(lookupErr)
			}
		}
		return s.writeAuditTx(ctx, tx, actorInTx, input.Meta, "email.smtp_settings_update", "success", "", now)
	})
	if err != nil {
		return SpaceSettings{}, normalizeRepositoryError(err)
	}
	return s.GetSpaceSettings(ctx, actor.ID)
}

func (s *Service) UpdatePreferences(ctx context.Context, input UpdatePreferencesInput) (Preferences, error) {
	if err := s.checkReady("update workspace email preferences"); err != nil {
		return Preferences{}, err
	}
	var actor *auth.Actor
	var record *PreferenceRecord
	now := s.nowUTC()
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return internalError("update workspace email preferences", errors.New("transaction is required"))
		}
		var err error
		actor, err = s.lookupActor(ctx, tx, input.ActorID)
		if err != nil {
			return err
		}
		current, err := s.ensurePreferences(ctx, tx, actor, now)
		if err != nil {
			return err
		}
		enabled, immediate, digest := current.Enabled, current.Immediate, current.Digest
		if input.Enabled != nil {
			enabled = *input.Enabled
		}
		if input.Immediate != nil {
			immediate = *input.Immediate
		}
		if input.Digest != nil {
			digest = *input.Digest
		}
		if err := tx.UpdatePreferences(ctx, actor.ID, enabled, immediate, digest, now); err != nil {
			return normalizeRepositoryError(err)
		}
		if !enabled || !digest {
			if err := tx.DeleteUserDigestState(ctx, actor.ID); err != nil {
				return normalizeRepositoryError(err)
			}
		}
		if !enabled || !immediate {
			if err := tx.CancelPendingJobs(ctx, actor.ID, now); err != nil {
				return normalizeRepositoryError(err)
			}
		}
		record, err = tx.GetPreferences(ctx, actor.ID)
		if err != nil {
			return normalizeRepositoryError(err)
		}
		if record == nil {
			return internalError("update workspace email preferences", errors.New("preference row disappeared"))
		}
		return nil
	})
	if err != nil {
		return Preferences{}, normalizeRepositoryError(err)
	}
	available, err := s.mailAvailable(ctx)
	if err != nil {
		return Preferences{}, err
	}
	return projectPreferences(record, actor.Email, available), nil
}

func (s *Service) CreateEmailChallenge(ctx context.Context, input CreateChallengeInput) (ChallengeResult, error) {
	if err := s.checkReady("create notification email challenge"); err != nil {
		return ChallengeResult{}, err
	}
	actor, err := s.lookupActor(ctx, s.repo, input.ActorID)
	if err != nil {
		return ChallengeResult{}, err
	}
	email, err := normalizeEmail(input.Email)
	if err != nil {
		return ChallengeResult{}, err
	}
	now := s.nowUTC()
	count, latest, err := s.repo.CountRecentChallenges(ctx, actor.ID, now.Add(-time.Hour))
	if err != nil {
		return ChallengeResult{}, normalizeRepositoryError(err)
	}
	if count >= EmailChallengeHourLimit {
		return ChallengeResult{}, newError(CodeVerificationRateLimit, MessageVerificationRate, 429)
	}
	if latest != nil && now.Sub(normalizeTime(*latest)) < EmailChallengeResend {
		return ChallengeResult{}, newError(CodeVerificationResend, MessageVerificationResend, 429)
	}
	smtp, err := s.activeSMTP(ctx)
	if err != nil {
		return ChallengeResult{}, err
	}
	key, err := s.key()
	if err != nil {
		return ChallengeResult{}, err
	}
	id, err := s.newID("email challenge")
	if err != nil {
		return ChallengeResult{}, err
	}
	code, err := s.newCode()
	if err != nil {
		return ChallengeResult{}, err
	}
	createdAt := now
	expiresAt := now.Add(EmailChallengeTTL)
	if s.mailer == nil {
		return ChallengeResult{}, internalError("send email challenge", errors.New("mailer is required"))
	}
	if err := s.mailer.Send(ctx, smtp, bodyWithNoContent("验证通知邮箱", "您的验证码是 "+code+"，10 分钟内有效。", s.frontend()), email); err != nil {
		errorCode := normalizeErrorCode(normalizeMailerError(err))
		if auditErr := s.writeAudit(ctx, actor, input.Meta, "email.verification_send", "failure", errorCode, now); auditErr != nil {
			return ChallengeResult{}, auditErr
		}
		return ChallengeResult{}, newError(errorCode, smtpErrorMessage(errorCode), 502)
	}
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		actorInTx, lookupErr := s.lookupActor(ctx, tx, actor.ID)
		if lookupErr != nil {
			return lookupErr
		}
		if lookupErr := tx.ConsumeChallenges(ctx, actorInTx.ID, createdAt); lookupErr != nil {
			return normalizeRepositoryError(lookupErr)
		}
		if lookupErr := tx.InsertChallenge(ctx, ChallengeInsert{ID: id, UserID: actorInTx.ID, PendingEmail: email, CodeHash: challengeHash(key, id, code), CreatedAt: createdAt, ExpiresAt: expiresAt}); lookupErr != nil {
			return normalizeRepositoryError(lookupErr)
		}
		return s.writeAuditTx(ctx, tx, actorInTx, input.Meta, "email.verification_send", "success", "", now)
	})
	if err != nil {
		return ChallengeResult{}, normalizeRepositoryError(err)
	}
	return ChallengeResult{ChallengeID: id, PendingEmail: maskEmail(email), ExpiresAt: formatTime(expiresAt), ResendAfterSeconds: int(EmailChallengeResend / time.Second)}, nil
}

func (s *Service) VerifyEmailChallenge(ctx context.Context, input VerifyChallengeInput) (Preferences, error) {
	if err := s.checkReady("verify notification email challenge"); err != nil {
		return Preferences{}, err
	}
	key, err := s.key()
	if err != nil {
		return Preferences{}, err
	}
	id := strings.TrimSpace(input.ChallengeID)
	code := strings.TrimSpace(input.Code)
	now := s.nowUTC()
	var actor *auth.Actor
	var record *PreferenceRecord
	var rejected error
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if tx == nil {
			return internalError("verify notification email challenge", errors.New("transaction is required"))
		}
		var lookupErr error
		actor, lookupErr = s.lookupActor(ctx, tx, input.ActorID)
		if lookupErr != nil {
			return lookupErr
		}
		challenge, lookupErr := tx.GetChallenge(ctx, actor.ID, id)
		if lookupErr != nil {
			return normalizeRepositoryError(lookupErr)
		}
		if challenge == nil || challenge.ConsumedAt != nil || !challenge.ExpiresAt.After(now) || challenge.Attempts >= MaximumCodeAttempts {
			return newError(CodeVerificationInvalid, MessageVerificationInvalid, 400)
		}
		if !secureEqual(challenge.CodeHash, challengeHash(key, id, code)) {
			changed, incrementErr := tx.IncrementChallengeAttempt(ctx, id, now)
			if incrementErr != nil {
				return normalizeRepositoryError(incrementErr)
			}
			if !changed {
				return newError(CodeVerificationInvalid, MessageVerificationInvalid, 400)
			}
			if auditErr := s.writeAuditTx(ctx, tx, actor, input.Meta, "email.verification_confirm", "rejected", CodeVerificationInvalid, now); auditErr != nil {
				return auditErr
			}
			rejected = newError(CodeVerificationInvalid, MessageVerificationInvalid, 400)
			return nil
		}
		if _, err := s.ensurePreferences(ctx, tx, actor, now); err != nil {
			return err
		}
		if err := tx.ConfirmChallenge(ctx, id, actor.ID, challenge.PendingEmail, now, now); err != nil {
			return normalizeRepositoryError(err)
		}
		if err := s.writeAuditTx(ctx, tx, actor, input.Meta, "email.verification_confirm", "success", "", now); err != nil {
			return err
		}
		record, err = tx.GetPreferences(ctx, actor.ID)
		return normalizeRepositoryError(err)
	})
	if err != nil {
		return Preferences{}, normalizeRepositoryError(err)
	}
	if rejected != nil {
		return Preferences{}, rejected
	}
	if record == nil {
		return Preferences{}, internalError("verify notification email challenge", errors.New("preference row is missing"))
	}
	available, err := s.mailAvailable(ctx)
	if err != nil {
		return Preferences{}, err
	}
	return projectPreferences(record, actor.Email, available), nil
}

func secureEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func (s *Service) UseGitHubEmail(ctx context.Context, input UseGitHubEmailInput) (Preferences, error) {
	if err := s.checkReady("use GitHub notification email"); err != nil {
		return Preferences{}, err
	}
	var actor *auth.Actor
	var record *PreferenceRecord
	now := s.nowUTC()
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		var err error
		actor, err = s.lookupActor(ctx, tx, input.ActorID)
		if err != nil {
			return err
		}
		if strings.TrimSpace(actor.Email) == "" {
			return newError(CodeGitHubUnavailable, MessageGitHubUnavailable, 400)
		}
		if _, err := s.ensurePreferences(ctx, tx, actor, now); err != nil {
			return err
		}
		if err := tx.UseGitHubEmail(ctx, actor.ID, actor.Email, now); err != nil {
			return normalizeRepositoryError(err)
		}
		record, err = tx.GetPreferences(ctx, actor.ID)
		return normalizeRepositoryError(err)
	})
	if err != nil {
		return Preferences{}, normalizeRepositoryError(err)
	}
	available, err := s.mailAvailable(ctx)
	if err != nil {
		return Preferences{}, err
	}
	return projectPreferences(record, actor.Email, available), nil
}

func (s *Service) SyncGitHubEmail(ctx context.Context, input SyncGitHubEmailInput) error {
	if err := s.checkReady("sync GitHub notification email"); err != nil {
		return err
	}
	now := s.nowUTC()
	var email string
	if strings.TrimSpace(input.Email) != "" {
		normalized, err := normalizeEmail(input.Email)
		if err != nil {
			return err
		}
		email = normalized
	}
	err := s.repo.WithTx(ctx, func(tx Tx) error {
		actor, err := s.lookupActor(ctx, tx, input.UserID)
		if err != nil {
			return err
		}
		if _, err := s.ensurePreferences(ctx, tx, actor, now); err != nil {
			return err
		}
		if email == "" {
			return nil
		}
		return normalizeRepositoryError(tx.SyncGitHubEmail(ctx, actor.ID, email, now))
	})
	return normalizeRepositoryError(err)
}

func (s *Service) decryptStoredPassword(settings *SMTPSettingsRecord, key []byte) (string, error) {
	if settings == nil || strings.TrimSpace(settings.PasswordCiphertext) == "" {
		return "", nil
	}
	return decryptSecret(settings.PasswordCiphertext, key, s.space())
}

func (s *Service) activeSMTP(ctx context.Context) (MailConfig, error) {
	settings, err := s.repo.GetSpaceSettings(ctx, s.space())
	if err != nil {
		return MailConfig{}, normalizeRepositoryError(err)
	}
	if settings == nil || !settings.Enabled {
		return MailConfig{}, newError(CodeSMTPUnavailable, MessageSMTPUnavailable, 503)
	}
	key, err := s.key()
	if err != nil {
		return MailConfig{}, err
	}
	password, err := s.decryptStoredPassword(settings, key)
	if err != nil {
		return MailConfig{}, err
	}
	return MailConfig{SMTPHost: settings.SMTPHost, SMTPPort: settings.SMTPPort, Encryption: settings.Encryption, Username: settings.Username, Password: password, FromAddress: settings.FromAddress, FromName: settings.FromName}, nil
}

func (s *Service) mailAvailable(ctx context.Context) (bool, error) {
	settings, err := s.repo.GetSpaceSettings(ctx, s.space())
	if err != nil {
		return false, normalizeRepositoryError(err)
	}
	return settings != nil && settings.Enabled, nil
}

func (s *Service) writeAudit(ctx context.Context, actor *auth.Actor, meta auth.RequestMeta, action, result, reason string, now time.Time) error {
	return s.repo.WithTx(ctx, func(tx Tx) error {
		return s.writeAuditTx(ctx, tx, actor, meta, action, result, reason, now)
	})
}

func (s *Service) writeAuditTx(ctx context.Context, tx Tx, actor *auth.Actor, meta auth.RequestMeta, action, result, reason string, now time.Time) error {
	if tx == nil || actor == nil {
		return internalError("write workspace email audit", errors.New("audit transaction and actor are required"))
	}
	id, err := s.newID("email audit")
	if err != nil {
		return err
	}
	if err := tx.WriteAudit(ctx, AuditInput{ID: id, SpaceID: s.space(), ActorUserID: actor.ID, ActorGitHubLogin: actor.GitHubLogin, Action: action, TargetType: "email_settings", TargetID: s.space(), Result: result, Reason: reason, Meta: meta.Safe(), CreatedAt: normalizeTime(now)}); err != nil {
		return normalizeRepositoryError(err)
	}
	return nil
}

func (s *Service) ScheduleMessage(ctx context.Context, input ScheduleInput) (int, error) {
	if err := s.checkReady("schedule workspace email message"); err != nil {
		return 0, err
	}
	return s.scheduleMessage(ctx, input, nil)
}

// ScheduleMessageInTx is used by the message acceptance transaction. It only
// persists bounded delivery projections; no SMTP call occurs in the supplied
// transaction.
func (s *Service) ScheduleMessageInTx(ctx context.Context, tx Tx, input ScheduleInput) (int, error) {
	if err := s.checkReady("schedule workspace email message"); err != nil {
		return 0, err
	}
	return s.scheduleMessage(ctx, input, tx)
}

func (s *Service) scheduleMessage(ctx context.Context, input ScheduleInput, supplied Tx) (int, error) {
	if strings.TrimSpace(input.AuthorID) == "" || strings.TrimSpace(input.ConversationID) == "" || strings.TrimSpace(input.MessageID) == "" || input.CreatedAt.IsZero() {
		return 0, internalError("schedule workspace email message", errors.New("author, conversation, message, and timestamp are required"))
	}
	input.SpaceID = strings.TrimSpace(input.SpaceID)
	if input.SpaceID == "" {
		input.SpaceID = s.space()
	}
	createdAt := normalizeTime(input.CreatedAt)
	var settings *SMTPSettingsRecord
	var err error
	if supplied != nil {
		settings, err = supplied.GetSpaceSettings(ctx, input.SpaceID)
	} else {
		settings, err = s.repo.GetSpaceSettings(ctx, input.SpaceID)
	}
	if err != nil {
		return 0, normalizeRepositoryError(err)
	}
	if settings == nil || !settings.Enabled || settings.ActiveFrom == nil || createdAt.Before(normalizeTime(*settings.ActiveFrom)) {
		return 0, nil
	}
	mentioned := input.mentionUserIDs()
	insert := func(tx Tx) (int, error) {
		if tx == nil {
			return 0, internalError("schedule workspace email message", errors.New("transaction is required"))
		}
		recipients, err := tx.ListRecipients(ctx, ScheduleRecipientQuery{SpaceID: input.SpaceID, ConversationID: input.ConversationID, TopicID: input.TopicID, AuthorID: input.AuthorID})
		if err != nil {
			return 0, normalizeRepositoryError(err)
		}
		queued := 0
		for _, recipient := range recipients {
			userID := strings.TrimSpace(recipient.UserID)
			if userID == "" || userID == input.AuthorID || recipient.NotificationLevel == "muted" || (recipient.NotificationLevel == "mentions" && !hasMention(mentioned, userID)) {
				continue
			}
			preference, err := tx.GetPreferences(ctx, userID)
			if err != nil {
				return queued, normalizeRepositoryError(err)
			}
			if preference == nil || !preference.Enabled || preference.Email == nil || preference.EmailVerifiedAt == nil {
				continue
			}
			if preference.Immediate {
				id, err := s.newID("email job")
				if err != nil {
					return queued, err
				}
				inserted, err := tx.InsertJob(ctx, JobInsert{ID: id, UserID: userID, MessageID: input.MessageID, ConversationID: input.ConversationID, EventSeq: input.EventSeq, AvailableAt: createdAt.Add(ImmediateDelay), NextAttemptAt: createdAt.Add(ImmediateDelay), CreatedAt: createdAt})
				if err != nil {
					return queued, normalizeRepositoryError(err)
				}
				if inserted {
					queued++
				}
			}
			if preference.Digest {
				if _, err := tx.InsertDigestState(ctx, DigestInsert{UserID: userID, StartedAt: createdAt, NextAttemptAt: createdAt.Add(DigestDelay), UpdatedAt: createdAt}); err != nil {
					return queued, normalizeRepositoryError(err)
				}
			}
		}
		return queued, nil
	}
	if supplied != nil {
		return insert(supplied)
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

func hasMention(mentioned map[string]struct{}, userID string) bool {
	_, ok := mentioned[userID]
	return ok
}

func (s *Service) ReconcileDigestState(ctx context.Context, userID string) error {
	if err := s.checkReady("reconcile workspace email digest"); err != nil {
		return err
	}
	states, err := s.repo.ListDigestStates(ctx, s.space(), s.nowUTC(), 25)
	if err != nil {
		return normalizeRepositoryError(err)
	}
	for _, state := range states {
		if state.UserID != userID {
			continue
		}
		messages, err := s.eligibleUnreadMessages(ctx, state.UserID, state.StartedAt)
		if err != nil {
			return err
		}
		if len(messages) == 0 {
			return normalizeRepositoryError(s.repo.DeleteDigestState(ctx, state.UserID))
		}
	}
	return nil
}

func (s *Service) ProcessJobs(ctx context.Context) (ProcessResult, error) {
	if err := s.checkReady("process workspace email jobs"); err != nil {
		return ProcessResult{}, err
	}
	return s.processJobs(ctx, nil, nil, s.worker)
}

// ProcessJobsWithPresence is the worker-facing variant used when the caller
// owns a current presence source. Presence only defers immediate mail; all
// durable membership, preference, read-state and job checks remain in the
// repository projections.
func (s *Service) ProcessJobsWithPresence(ctx context.Context, presence Presence) (ProcessResult, error) {
	if err := s.checkReady("process workspace email jobs"); err != nil {
		return ProcessResult{}, err
	}
	return s.processJobs(ctx, presence, nil, s.worker)
}

// ProcessJobsWithContextPresence is the cross-process worker variant. Unlike
// the legacy bool Presence seam, it preserves lookup failures as retryable
// deferrals instead of treating a database outage as offline.
func (s *Service) ProcessJobsWithContextPresence(ctx context.Context, presence ContextPresence) (ProcessResult, error) {
	if err := s.checkReady("process workspace email jobs"); err != nil {
		return ProcessResult{}, err
	}
	return s.processJobs(ctx, nil, presence, s.worker)
}

func (s *Service) processJobs(ctx context.Context, presence Presence, contextPresence ContextPresence, options WorkerOptions) (ProcessResult, error) {
	result, err := s.processImmediate(ctx, presence, contextPresence, options)
	if err != nil {
		return result, err
	}
	digestResult, err := s.processDigest(ctx, options)
	result.Claimed += digestResult.Claimed
	result.Sent += digestResult.Sent
	result.Cancelled += digestResult.Cancelled
	result.Retried += digestResult.Retried
	result.Failed += digestResult.Failed
	return result, err
}

func (s *Service) processImmediate(ctx context.Context, presence Presence, contextPresence ContextPresence, options WorkerOptions) (ProcessResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	now := s.nowUTC()
	ids, err := s.repo.ListDueJobs(ctx, s.space(), now, options.BatchSize)
	if err != nil {
		return ProcessResult{}, normalizeRepositoryError(err)
	}
	result := ProcessResult{}
	for _, id := range ids {
		claimedAt := s.nowUTC()
		claimed, err := s.repo.ClaimJob(ctx, id, claimedAt.Add(options.Lease), claimedAt)
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
		if job == nil || !eligibleJob(*job) || (job.NotificationLevel == "mentions" && !messageMentions(job.ContentJSON, job.UserID)) {
			if err := s.repo.CancelJob(ctx, id, s.nowUTC()); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Cancelled++
			continue
		}
		online, presenceErr := lookupPresence(ctx, presence, contextPresence, job.UserID)
		if presenceErr != nil {
			if err := s.repo.DeferJob(ctx, id, s.nowUTC().Add(options.Interval)); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Retried++
			continue
		}
		if online {
			if err := s.repo.DeferJob(ctx, id, s.nowUTC().Add(options.Interval)); err != nil {
				return result, normalizeRepositoryError(err)
			}
			continue
		}
		smtp, smtpErr := s.activeSMTP(ctx)
		var sendErr error
		if smtpErr != nil {
			sendErr = smtpErr
		} else {
			publishCtx, cancel := context.WithTimeout(ctx, options.PublishTimeout)
			sendErr = s.mailer.Send(publishCtx, smtp, bodyWithNoContent("你有一条未读消息", "有人通过 DualLane 给您发送了一条消息。", s.frontend()), job.Email)
			cancel()
		}
		if sendErr == nil {
			if err := s.repo.MarkSent(ctx, id, s.nowUTC()); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Sent++
			continue
		}
		code := normalizeErrorCode(normalizeMailerError(sendErr))
		attempt := job.AttemptCount + 1
		if attempt <= len(RetryDelays) {
			if err := s.repo.RetryJob(ctx, id, attempt, s.nowUTC().Add(RetryDelays[attempt-1]), code); err != nil {
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

func lookupPresence(ctx context.Context, legacy Presence, contextual ContextPresence, userID string) (bool, error) {
	if contextual != nil {
		return contextual.IsOnlineContext(ctx, userID)
	}
	if legacy != nil {
		return legacy.IsOnline(userID), nil
	}
	return false, nil
}

func (s *Service) eligibleUnreadMessages(ctx context.Context, userID string, startedAt time.Time) ([]UnreadMessage, error) {
	rows, err := s.repo.ListEligibleUnreadMessages(ctx, s.space(), userID, startedAt)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	result := make([]UnreadMessage, 0, len(rows))
	for _, row := range rows {
		if !isUnread(row.EventSeq, row.LastReadSeq, row.CreatedAt, row.LastReadAt) || row.NotificationLevel == "muted" {
			continue
		}
		if row.NotificationLevel == "mentions" && !messageMentions(row.ContentJSON, userID) {
			continue
		}
		result = append(result, row)
	}
	return result, nil
}

func (s *Service) processDigest(ctx context.Context, options WorkerOptions) (ProcessResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	now := s.nowUTC()
	states, err := s.repo.ListDigestStates(ctx, s.space(), now, options.BatchSize)
	if err != nil {
		return ProcessResult{}, normalizeRepositoryError(err)
	}
	result := ProcessResult{}
	for _, state := range states {
		messages, err := s.eligibleUnreadMessages(ctx, state.UserID, state.StartedAt)
		if err != nil {
			return result, err
		}
		if len(messages) == 0 {
			if err := s.repo.DeleteDigestState(ctx, state.UserID); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Cancelled++
			continue
		}
		if state.NotifiedAt != nil || state.NextAttemptAt.After(now) {
			continue
		}
		claimedAt := s.nowUTC()
		claimed, err := s.repo.ClaimDigestState(ctx, state.UserID, claimedAt.Add(options.Lease), claimedAt)
		if err != nil {
			return result, normalizeRepositoryError(err)
		}
		if !claimed {
			continue
		}
		result.Claimed++
		messages, err = s.eligibleUnreadMessages(ctx, state.UserID, state.StartedAt)
		if err != nil {
			return result, err
		}
		preference, err := s.repo.GetPreferences(ctx, state.UserID)
		if err != nil {
			return result, normalizeRepositoryError(err)
		}
		if len(messages) == 0 || preference == nil || !preference.Enabled || !preference.Digest || preference.Email == nil || preference.EmailVerifiedAt == nil {
			if err := s.repo.DeleteDigestState(ctx, state.UserID); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Cancelled++
			continue
		}
		smtp, smtpErr := s.activeSMTP(ctx)
		senderCount := 0
		senders := make(map[string]struct{})
		for _, message := range messages {
			if message.AuthorID != nil && *message.AuthorID != "" {
				senders[*message.AuthorID] = struct{}{}
			}
		}
		senderCount = len(senders)
		duration := now.Sub(state.StartedAt)
		if duration < DigestDelay {
			duration = DigestDelay
		}
		var sendErr error
		if smtpErr != nil {
			sendErr = smtpErr
		} else {
			publishCtx, cancel := context.WithTimeout(ctx, options.PublishTimeout)
			sendErr = s.mailer.Send(publishCtx, smtp, bodyWithNoContent("你有未处理的消息", "过去"+formatDuration(duration)+"内有"+itoa(senderCount)+"人给您发送了"+itoa(len(messages))+"条消息，您已超过2小时未处理。", s.frontend()), *preference.Email)
			cancel()
		}
		if sendErr == nil {
			if err := s.repo.MarkDigestSent(ctx, state.UserID, s.nowUTC()); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Sent++
			continue
		}
		code := normalizeErrorCode(normalizeMailerError(sendErr))
		attempt := state.AttemptCount + 1
		if attempt <= len(RetryDelays) {
			if err := s.repo.RetryDigestState(ctx, state.UserID, attempt, s.nowUTC().Add(RetryDelays[attempt-1]), code, s.nowUTC()); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Retried++
		} else {
			if err := s.repo.RetryDigestState(ctx, state.UserID, attempt, s.nowUTC().Add(24*time.Hour), code, s.nowUTC()); err != nil {
				return result, normalizeRepositoryError(err)
			}
			result.Failed++
		}
	}
	return result, nil
}

func (s *Service) StartWorker(ctx context.Context, options WorkerOptions) *WorkerHandle {
	return s.startWorker(ctx, nil, nil, options)
}

func (s *Service) StartWorkerWithPresence(ctx context.Context, presence Presence, options WorkerOptions) *WorkerHandle {
	return s.startWorker(ctx, presence, nil, options)
}

// StartWorkerWithContextPresence is the long-lived worker constructor for the
// PostgreSQL lease-backed presence adapter.
func (s *Service) StartWorkerWithContextPresence(ctx context.Context, presence ContextPresence, options WorkerOptions) *WorkerHandle {
	return s.startWorker(ctx, nil, presence, options)
}

func (s *Service) startWorker(ctx context.Context, presence Presence, contextPresence ContextPresence, options WorkerOptions) *WorkerHandle {
	if ctx == nil {
		ctx = context.Background()
	}
	if options.Interval <= 0 {
		options.Interval = s.worker.Interval
	}
	if options.Lease <= 0 {
		options.Lease = s.worker.Lease
	}
	if options.BatchSize <= 0 || options.BatchSize > MaximumJobBatchSize {
		options.BatchSize = s.worker.BatchSize
	}
	if options.PublishTimeout <= 0 {
		options.PublishTimeout = s.worker.PublishTimeout
	}
	child, cancel := context.WithCancel(ctx)
	var stopOnce sync.Once
	var tickMu sync.Mutex
	stop := func() { stopOnce.Do(cancel) }
	tick := func(tickCtx context.Context) (ProcessResult, error) {
		tickMu.Lock()
		defer tickMu.Unlock()
		if options.Disabled || child.Err() != nil {
			return ProcessResult{}, nil
		}
		return s.processJobs(tickCtx, presence, contextPresence, options)
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
		interval := time.NewTicker(options.Interval)
		defer interval.Stop()
		_, _ = tick(child)
		for {
			select {
			case <-child.Done():
				return
			case <-interval.C:
				_, _ = tick(child)
			}
		}
	}()
	return &WorkerHandle{Stop: stop, Tick: tick}
}

func eligibleJob(job DeliveryJob) bool {
	return job.PreferenceEnabled && job.ImmediateEnabled && job.Email != "" && job.EmailVerifiedAt != nil &&
		job.NotificationLevel != "muted" && isUnread(job.EventSeq, job.LastReadSeq, job.MessageCreatedAt, job.LastReadAt)
}

func projectPreferences(record *PreferenceRecord, githubEmail string, mailAvailable bool) Preferences {
	result := Preferences{EmailSource: "github", GitHubEmail: optionalString(githubEmail), MailAvailable: mailAvailable}
	if record == nil {
		return result
	}
	result.Email = record.Email
	if record.Email != nil && *record.Email != "" {
		masked := maskEmail(*record.Email)
		result.MaskedEmail = &masked
	}
	if record.EmailSource != "" {
		result.EmailSource = record.EmailSource
	}
	result.EmailVerified = record.EmailVerifiedAt != nil
	result.Enabled = record.Enabled
	result.Immediate = record.Immediate
	result.Digest = record.Digest
	return result
}

func projectSpaceSettings(record *SMTPSettingsRecord, failed int64, last *time.Time) SpaceSettings {
	result := SpaceSettings{SMTPPort: 587, Encryption: "starttls", FromName: "DualLane", FailedJobCount: failed, LastDeliveryAt: optionalTime(last)}
	if record == nil {
		return result
	}
	result.Enabled = record.Enabled
	result.SMTPHost = record.SMTPHost
	result.SMTPPort = record.SMTPPort
	result.Encryption = record.Encryption
	result.Username = record.Username
	result.FromAddress = record.FromAddress
	result.FromName = record.FromName
	result.PasswordConfigured = record.PasswordCiphertext != ""
	result.ActiveFrom = optionalTime(record.ActiveFrom)
	result.LastTestedAt = optionalTime(record.LastTestedAt)
	result.LastTestStatus = record.LastTestStatus
	result.LastTestErrorCode = record.LastTestErrorCode
	result.UpdatedAt = optionalTime(&record.UpdatedAt)
	result.FailedJobCount = failed
	result.LastDeliveryAt = optionalTime(last)
	return result
}

func formatDuration(duration time.Duration) string {
	minutes := int(duration / time.Minute)
	if minutes < 120 {
		minutes = 120
	}
	if minutes < 180 {
		return "约2小时"
	}
	if minutes < 24*60 {
		return "约" + itoa(minutes/60) + "小时"
	}
	return "约" + itoa(minutes/(24*60)) + "天"
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var buffer [20]byte
	index := len(buffer)
	for value > 0 {
		index--
		buffer[index] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		index--
		buffer[index] = '-'
	}
	return string(buffer[index:])
}
