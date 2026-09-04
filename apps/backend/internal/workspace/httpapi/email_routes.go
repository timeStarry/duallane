package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
)

type emailPreferencesRequest struct {
	Enabled   optional[bool] `json:"enabled"`
	Immediate optional[bool] `json:"immediateEnabled"`
	Digest    optional[bool] `json:"digestEnabled"`
}

type emailSettingsRequest struct {
	Enabled     optional[bool]   `json:"enabled"`
	SMTPHost    string           `json:"smtpHost"`
	Host        string           `json:"host"`
	SMTPPort    int              `json:"smtpPort"`
	Port        int              `json:"port"`
	Encryption  string           `json:"encryption"`
	Username    string           `json:"username"`
	Password    optional[string] `json:"password"`
	FromAddress string           `json:"fromAddress"`
	FromName    string           `json:"fromName"`
	TestProof   string           `json:"testProof"`
}

type emailChallengeRequest struct {
	Email string `json:"email"`
}

type emailVerifyRequest struct {
	ChallengeID string `json:"challengeId"`
	Code        string `json:"code"`
}

func registerEmailRoutes(router chi.Router, options RouterOptions) {
	router.Get("/settings/email", withActor(options, getEmailSettings))
	router.Post("/settings/email/test", withActor(options, testEmailSettings))
	router.Put("/settings/email", withActor(options, saveEmailSettings))
	router.Get("/me/notifications", withActor(options, getEmailPreferences))
	router.Patch("/me/notifications", withActor(options, updateEmailPreferences))
	router.Post("/me/notification-email/challenges", withActor(options, createEmailChallenge))
	router.Post("/me/notification-email/verify", withActor(options, verifyEmailChallenge))
	router.Post("/me/notification-email/use-github", withActor(options, useGitHubEmail))
}

func getEmailSettings(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Email) {
		return
	}
	settings, err := options.Email.GetSpaceSettings(request.Context(), actor.ID)
	writeResult(response, http.StatusOK, map[string]any{"settings": settings}, err)
}

func testEmailSettings(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Email) {
		return
	}
	var body emailSettingsRequest
	if !decodeBody(response, request, &body) {
		return
	}
	result, err := options.Email.TestSpaceSettings(request.Context(), email.TestSettingsInput{
		ActorID: actor.ID, SMTPHost: body.smtpHost(), SMTPPort: body.smtpPort(), Encryption: body.Encryption,
		Username: body.Username, Password: body.password(), PasswordSet: body.Password.Set,
		FromAddress: body.FromAddress, FromName: body.FromName, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, result, err)
}

func saveEmailSettings(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Email) {
		return
	}
	var body emailSettingsRequest
	if !decodeBody(response, request, &body) {
		return
	}
	settings, err := options.Email.SaveSpaceSettings(request.Context(), email.SaveSettingsInput{
		ActorID: actor.ID, Enabled: body.enabled(), EnabledSet: body.Enabled.Set,
		SMTPHost: body.smtpHost(), SMTPPort: body.smtpPort(), Encryption: body.Encryption,
		Username: body.Username, Password: body.password(), PasswordSet: body.Password.Set,
		FromAddress: body.FromAddress, FromName: body.FromName, TestProof: body.TestProof,
		Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"settings": settings}, err)
}

func (body emailSettingsRequest) enabled() bool {
	return body.Enabled.Value != nil && *body.Enabled.Value
}

func (body emailSettingsRequest) smtpHost() string {
	if body.SMTPHost != "" {
		return body.SMTPHost
	}
	return body.Host
}

func (body emailSettingsRequest) smtpPort() int {
	if body.SMTPPort != 0 {
		return body.SMTPPort
	}
	return body.Port
}

func (body emailSettingsRequest) password() string {
	if body.Password.Value == nil {
		return ""
	}
	return *body.Password.Value
}

func getEmailPreferences(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Email) {
		return
	}
	preferences, err := options.Email.GetPreferences(request.Context(), actor.ID)
	writeResult(response, http.StatusOK, map[string]any{"notifications": preferences}, err)
}

func updateEmailPreferences(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Email) {
		return
	}
	var body emailPreferencesRequest
	if !decodeBody(response, request, &body) {
		return
	}
	preferences, err := options.Email.UpdatePreferences(request.Context(), email.UpdatePreferencesInput{
		ActorID: actor.ID, Enabled: body.Enabled.Value, Immediate: body.Immediate.Value, Digest: body.Digest.Value,
		Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"notifications": preferences}, err)
}

func createEmailChallenge(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Email) {
		return
	}
	var body emailChallengeRequest
	if !decodeBody(response, request, &body) {
		return
	}
	challenge, err := options.Email.CreateEmailChallenge(request.Context(), email.CreateChallengeInput{
		ActorID: actor.ID, Email: body.Email, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusCreated, challenge, err)
}

func verifyEmailChallenge(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Email) {
		return
	}
	var body emailVerifyRequest
	if !decodeBody(response, request, &body) {
		return
	}
	preferences, err := options.Email.VerifyEmailChallenge(request.Context(), email.VerifyChallengeInput{
		ActorID: actor.ID, ChallengeID: body.ChallengeID, Code: body.Code, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"notifications": preferences}, err)
}

func useGitHubEmail(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Email) {
		return
	}
	preferences, err := options.Email.UseGitHubEmail(request.Context(), email.UseGitHubEmailInput{ActorID: actor.ID, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"notifications": preferences}, err)
}
