package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type fakeEmailService struct {
	preferences      email.Preferences
	settings         email.SpaceSettings
	testResult       email.SMTPTestResult
	challenge        email.ChallengeResult
	getPreferencesID string
	getSettingsID    string
	updateInput      email.UpdatePreferencesInput
	testInput        email.TestSettingsInput
	saveInput        email.SaveSettingsInput
	challengeInput   email.CreateChallengeInput
	verifyInput      email.VerifyChallengeInput
	useGitHubInput   email.UseGitHubEmailInput
	preferenceCalls  int
	settingsCalls    int
	testCalls        int
	saveCalls        int
	challengeCalls   int
	verifyCalls      int
	useGitHubCalls   int
	err              error
}

func (service *fakeEmailService) GetPreferences(_ context.Context, actorID string) (email.Preferences, error) {
	service.getPreferencesID = actorID
	service.preferenceCalls++
	return service.preferences, service.err
}

func (service *fakeEmailService) UpdatePreferences(_ context.Context, input email.UpdatePreferencesInput) (email.Preferences, error) {
	service.updateInput = input
	return service.preferences, service.err
}

func (service *fakeEmailService) GetSpaceSettings(_ context.Context, actorID string) (email.SpaceSettings, error) {
	service.getSettingsID = actorID
	service.settingsCalls++
	return service.settings, service.err
}

func (service *fakeEmailService) TestSpaceSettings(_ context.Context, input email.TestSettingsInput) (email.SMTPTestResult, error) {
	service.testInput = input
	service.testCalls++
	return service.testResult, service.err
}

func (service *fakeEmailService) SaveSpaceSettings(_ context.Context, input email.SaveSettingsInput) (email.SpaceSettings, error) {
	service.saveInput = input
	service.saveCalls++
	return service.settings, service.err
}

func (service *fakeEmailService) CreateEmailChallenge(_ context.Context, input email.CreateChallengeInput) (email.ChallengeResult, error) {
	service.challengeInput = input
	service.challengeCalls++
	return service.challenge, service.err
}

func (service *fakeEmailService) VerifyEmailChallenge(_ context.Context, input email.VerifyChallengeInput) (email.Preferences, error) {
	service.verifyInput = input
	service.verifyCalls++
	return service.preferences, service.err
}

func (service *fakeEmailService) UseGitHubEmail(_ context.Context, input email.UseGitHubEmailInput) (email.Preferences, error) {
	service.useGitHubInput = input
	service.useGitHubCalls++
	return service.preferences, service.err
}

func emailRoutesRouter(service EmailService, resolver ActorResolver) http.Handler {
	return NewRouter(RouterOptions{
		Gate: gate.New("true"), ActorResolver: resolver, Email: service, TrustProxy: true,
	})
}

func TestEmailRoutesPreserveLegacyResponseShapesAndInputs(t *testing.T) {
	service := &fakeEmailService{
		preferences: email.Preferences{Email: stringPtr("member@example.test"), EmailVerified: true, Enabled: true},
		settings:    email.SpaceSettings{Enabled: true, SMTPHost: "smtp.example.test", SMTPPort: 465},
		testResult:  email.SMTPTestResult{OK: true, TestedAt: "2026-09-04T12:00:00.000Z", TestProof: "proof", Recipient: "m***@example.test"},
		challenge:   email.ChallengeResult{ChallengeID: "challenge-1", PendingEmail: "m***@example.test", ExpiresAt: "2026-09-04T12:10:00.000Z", ResendAfterSeconds: 60},
	}
	resolver := &fakeResolver{actor: &auth.Actor{ID: "actor-1", Kind: "human", Role: "owner"}}
	router := emailRoutesRouter(service, resolver)

	getPreferences := httptest.NewRecorder()
	router.ServeHTTP(getPreferences, httptest.NewRequest(http.MethodGet, "/api/workspace/me/notifications", nil))
	if getPreferences.Code != http.StatusOK || !strings.Contains(getPreferences.Body.String(), `"notifications"`) || !strings.Contains(getPreferences.Body.String(), `"emailVerified":true`) {
		t.Fatalf("get preferences status=%d body=%s", getPreferences.Code, getPreferences.Body.String())
	}

	update := httptest.NewRecorder()
	updateRequest := httptest.NewRequest(http.MethodPatch, "/api/workspace/me/notifications", strings.NewReader(`{"enabled":false,"immediateEnabled":null,"digestEnabled":true}`))
	updateRequest.Header.Set("Content-Type", "application/json")
	updateRequest.Header.Set("X-Request-ID", "email-update")
	updateRequest.Header.Set("X-Forwarded-For", "203.0.113.21, 10.0.0.1")
	router.ServeHTTP(update, updateRequest)
	if update.Code != http.StatusOK || service.updateInput.ActorID != "actor-1" || service.updateInput.Enabled == nil || *service.updateInput.Enabled || service.updateInput.Immediate != nil || service.updateInput.Digest == nil || !*service.updateInput.Digest {
		t.Fatalf("update status=%d input=%#v body=%s", update.Code, service.updateInput, update.Body.String())
	}
	if service.updateInput.Meta.RequestID != "email-update" || service.updateInput.Meta.IPAddress != "203.0.113.21" {
		t.Fatalf("update metadata=%#v", service.updateInput.Meta)
	}

	getSettings := httptest.NewRecorder()
	router.ServeHTTP(getSettings, httptest.NewRequest(http.MethodGet, "/api/workspace/settings/email", nil))
	if getSettings.Code != http.StatusOK || !strings.Contains(getSettings.Body.String(), `"settings"`) || !strings.Contains(getSettings.Body.String(), `"smtpHost":"smtp.example.test"`) {
		t.Fatalf("get settings status=%d body=%s", getSettings.Code, getSettings.Body.String())
	}

	test := httptest.NewRecorder()
	testRequest := httptest.NewRequest(http.MethodPost, "/api/workspace/settings/email/test", strings.NewReader(`{"host":"smtp.alias.test","port":2525,"encryption":"starttls","username":"sender@example.test","password":"secret","fromAddress":"sender@example.test","fromName":"DualLane"}`))
	testRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(test, testRequest)
	if test.Code != http.StatusOK || !strings.Contains(test.Body.String(), `"testProof":"proof"`) || service.testInput.SMTPHost != "smtp.alias.test" || service.testInput.SMTPPort != 2525 || service.testInput.Password != "secret" || !service.testInput.PasswordSet {
		t.Fatalf("test status=%d input=%#v body=%s", test.Code, service.testInput, test.Body.String())
	}

	save := httptest.NewRecorder()
	saveRequest := httptest.NewRequest(http.MethodPut, "/api/workspace/settings/email", strings.NewReader(`{"enabled":true,"smtpHost":"smtp.example.test","smtpPort":587,"encryption":"starttls","username":"sender@example.test","password":"secret","fromAddress":"sender@example.test","fromName":"DualLane","testProof":"proof"}`))
	saveRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(save, saveRequest)
	if save.Code != http.StatusOK || !strings.Contains(save.Body.String(), `"settings"`) || !service.saveInput.Enabled || service.saveInput.TestProof != "proof" {
		t.Fatalf("save status=%d input=%#v body=%s", save.Code, service.saveInput, save.Body.String())
	}

	challenge := httptest.NewRecorder()
	challengeRequest := httptest.NewRequest(http.MethodPost, "/api/workspace/me/notification-email/challenges", strings.NewReader(`{"email":"custom@example.test"}`))
	challengeRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(challenge, challengeRequest)
	if challenge.Code != http.StatusCreated || !strings.Contains(challenge.Body.String(), `"challengeId":"challenge-1"`) || service.challengeInput.Email != "custom@example.test" {
		t.Fatalf("challenge status=%d input=%#v body=%s", challenge.Code, service.challengeInput, challenge.Body.String())
	}

	verify := httptest.NewRecorder()
	verifyRequest := httptest.NewRequest(http.MethodPost, "/api/workspace/me/notification-email/verify", strings.NewReader(`{"challengeId":"challenge-1","code":"123456"}`))
	verifyRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(verify, verifyRequest)
	if verify.Code != http.StatusOK || !strings.Contains(verify.Body.String(), `"notifications"`) || service.verifyInput.ChallengeID != "challenge-1" || service.verifyInput.Code != "123456" {
		t.Fatalf("verify status=%d input=%#v body=%s", verify.Code, service.verifyInput, verify.Body.String())
	}

	useGitHub := httptest.NewRecorder()
	router.ServeHTTP(useGitHub, httptest.NewRequest(http.MethodPost, "/api/workspace/me/notification-email/use-github", nil))
	if useGitHub.Code != http.StatusOK || !strings.Contains(useGitHub.Body.String(), `"notifications"`) || service.useGitHubInput.ActorID != "actor-1" {
		t.Fatalf("use github status=%d input=%#v body=%s", useGitHub.Code, service.useGitHubInput, useGitHub.Body.String())
	}
}

func TestEmailRoutesApplyGateAndAuthBeforeEmailService(t *testing.T) {
	service := &fakeEmailService{}
	resolver := &fakeResolver{actor: &auth.Actor{ID: "actor-1", Kind: "human", Role: "member"}}
	disabled := NewRouter(RouterOptions{Gate: gate.New("false"), ActorResolver: resolver, Email: service})
	response := httptest.NewRecorder()
	disabled.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspace/me/notification-email/challenges", strings.NewReader(`{"email":"secret@example.test"}`)))
	if response.Code != http.StatusServiceUnavailable || resolver.calls != 0 || service.challengeCalls != 0 || strings.Contains(response.Body.String(), "secret@example.test") {
		t.Fatalf("disabled status=%d resolver=%d calls=%d body=%s", response.Code, resolver.calls, service.challengeCalls, response.Body.String())
	}

	unauthenticated := NewRouter(RouterOptions{Gate: gate.New("true"), Email: service})
	response = httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/me/notifications", nil))
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), `"code":"auth.required"`) || service.preferenceCalls != 0 {
		t.Fatalf("unauthenticated status=%d calls=%d body=%s", response.Code, service.preferenceCalls, response.Body.String())
	}

	nilActor := emailRoutesRouter(service, &fakeResolver{})
	response = httptest.NewRecorder()
	nilActor.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/me/notifications", nil))
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), `"code":"auth.required"`) || service.preferenceCalls != 0 {
		t.Fatalf("nil actor status=%d calls=%d body=%s", response.Code, service.preferenceCalls, response.Body.String())
	}
}

func TestEmailRoutesMapDomainErrorsAndRejectOversizedBodies(t *testing.T) {
	service := &fakeEmailService{err: &email.Error{Code: email.CodeSMTPUnavailable, Message: email.MessageSMTPUnavailable, StatusCode: http.StatusServiceUnavailable, Cause: errors.New("smtp password must stay private")}}
	router := emailRoutesRouter(service, &fakeResolver{actor: &auth.Actor{ID: "owner", Kind: "human", Role: "owner"}})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/settings/email", nil))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"email.smtp_unavailable"`) || strings.Contains(response.Body.String(), "smtp password") {
		t.Fatalf("domain error status=%d body=%s", response.Code, response.Body.String())
	}

	service.err = nil
	largeBody := `{"email":"large@example.test","padding":"` + strings.Repeat("x", int(MaxJSONBodyBytes)) + `"}`
	response = httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/me/notification-email/challenges", strings.NewReader(largeBody))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), `"code":"request.too_large"`) || service.challengeCalls != 0 {
		t.Fatalf("oversized status=%d calls=%d body=%s", response.Code, service.challengeCalls, response.Body.String())
	}
}

func stringPtr(value string) *string { return &value }
