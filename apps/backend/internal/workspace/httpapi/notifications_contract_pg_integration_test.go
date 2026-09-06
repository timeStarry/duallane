//go:build postgres_integration

package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
)

func TestWorkspaceNotificationsContractPGUsesRealPreferencesWithoutProviders(t *testing.T) {
	database := newContractPGDatabase(t)
	emailRepository := email.NewPGRepository(database.pool, contractPGIDFactory("contract-email"))
	var mailerCalls atomic.Int32
	emailService := email.NewService(email.ServiceOptions{
		Repository:    emailRepository,
		SpaceID:       contractPGSpaceID,
		FrontendURL:   "https://workspace.example.test",
		EncryptionKey: []byte(strings.Repeat("k", 32)),
		Now:           func() time.Time { return database.now },
		IDFactory:     contractPGIDFactory("contract-email-service"),
		Mailer: email.MailerFunc(func(context.Context, email.MailConfig, email.Message, string) error {
			mailerCalls.Add(1)
			return nil
		}),
	})

	var publisherCalls atomic.Int32
	var topicSequence atomic.Uint64
	ntfyRepository := ntfy.NewPGRepository(database.pool, contractPGIDFactory("contract-ntfy"))
	ntfyService, err := ntfy.NewServiceWithError(ntfy.ServiceOptions{
		Repository:  ntfyRepository,
		SpaceID:     contractPGSpaceID,
		ServerURL:   "https://ntfy.example.test",
		FrontendURL: "https://workspace.example.test",
		Now:         func() time.Time { return database.now },
		IDFactory:   contractPGIDFactory("contract-ntfy-service"),
		TopicFactory: func(login string) (string, error) {
			return "duallane-contract-" + strings.ToLower(login) + "-" + fmt.Sprint(topicSequence.Add(1)), nil
		},
		Publisher: ntfy.PublisherFunc(func(context.Context, ntfy.PublishInput) error {
			publisherCalls.Add(1)
			return nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	router := database.router(RouterOptions{Email: emailService, Ntfy: ntfyService})

	unauthenticated := contractPGServe(database, router, contractPGRequest(http.MethodGet, "/api/workspace/me/notifications", "", "", "", "notifications-auth-required"))
	if unauthenticated.Code != http.StatusUnauthorized || contractPGErrorCode(t, unauthenticated) != "auth.required" {
		t.Fatalf("unauthenticated notifications status=%d body=%s", unauthenticated.Code, unauthenticated.Body.String())
	}

	initialEmail := contractPGServe(database, router, contractPGRequest(http.MethodGet, "/api/workspace/me/notifications", "", contractPGOwnerID, "", "notifications-get"))
	if initialEmail.Code != http.StatusOK {
		t.Fatalf("notifications get status=%d body=%s", initialEmail.Code, initialEmail.Body.String())
	}
	var initialEmailPayload struct {
		Notifications struct {
			Email         *string `json:"email"`
			EmailVerified bool    `json:"emailVerified"`
			Enabled       bool    `json:"enabled"`
			Immediate     bool    `json:"immediateEnabled"`
			Digest        bool    `json:"digestEnabled"`
			MailAvailable bool    `json:"mailAvailable"`
		} `json:"notifications"`
	}
	contractPGDecode(t, initialEmail, &initialEmailPayload)
	if initialEmailPayload.Notifications.Email == nil || *initialEmailPayload.Notifications.Email != "owner@example.test" || !initialEmailPayload.Notifications.EmailVerified || !initialEmailPayload.Notifications.Enabled || initialEmailPayload.Notifications.Immediate || !initialEmailPayload.Notifications.Digest || initialEmailPayload.Notifications.MailAvailable {
		t.Fatalf("initial notifications=%#v", initialEmailPayload.Notifications)
	}
	var emailPreferenceRows int
	if err := database.pool.QueryRow(database.ctx, `SELECT COUNT(*) FROM user_notification_preferences WHERE user_id = $1`, contractPGOwnerID).Scan(&emailPreferenceRows); err != nil {
		t.Fatal(err)
	}
	if emailPreferenceRows != 1 {
		t.Fatalf("email preference rows=%d, want 1", emailPreferenceRows)
	}

	assertEmailFlags := func(label string, response *httptest.ResponseRecorder, wantEnabled, wantImmediate, wantDigest bool) {
		t.Helper()
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", label, response.Code, response.Body.String())
		}
		var payload struct {
			Notifications struct {
				Enabled   bool `json:"enabled"`
				Immediate bool `json:"immediateEnabled"`
				Digest    bool `json:"digestEnabled"`
			} `json:"notifications"`
		}
		contractPGDecode(t, response, &payload)
		got := payload.Notifications
		if got.Enabled != wantEnabled || got.Immediate != wantImmediate || got.Digest != wantDigest {
			t.Fatalf("%s notifications=%#v, want enabled=%t immediate=%t digest=%t", label, got, wantEnabled, wantImmediate, wantDigest)
		}
	}

	primedEmail := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/notifications", `{"enabled":true,"immediateEnabled":true,"digestEnabled":true}`, contractPGOwnerID, "notifications-prime-true")
	assertEmailFlags("prime true", primedEmail, true, true, true)

	nullEnabled := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/notifications", `{"enabled":null}`, contractPGOwnerID, "notifications-null-enabled")
	assertEmailFlags("explicit null enabled", nullEnabled, false, true, true)

	restoredEnabled := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/notifications", `{"enabled":true}`, contractPGOwnerID, "notifications-restore-enabled")
	assertEmailFlags("restore enabled", restoredEnabled, true, true, true)
	omittedEnabled := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/notifications", `{}`, contractPGOwnerID, "notifications-omitted-enabled")
	assertEmailFlags("omitted enabled", omittedEnabled, true, true, true)

	nullImmediate := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/notifications", `{"immediateEnabled":null}`, contractPGOwnerID, "notifications-null-immediate")
	assertEmailFlags("explicit null immediate", nullImmediate, true, false, true)
	restoredImmediate := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/notifications", `{"immediateEnabled":true}`, contractPGOwnerID, "notifications-restore-immediate")
	assertEmailFlags("restore immediate", restoredImmediate, true, true, true)
	omittedImmediate := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/notifications", `{}`, contractPGOwnerID, "notifications-omitted-immediate")
	assertEmailFlags("omitted immediate", omittedImmediate, true, true, true)

	nullDigest := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/notifications", `{"digestEnabled":null}`, contractPGOwnerID, "notifications-null-digest")
	assertEmailFlags("explicit null digest", nullDigest, true, true, false)
	var enabled, immediate, digest bool
	if err := database.pool.QueryRow(database.ctx, `
		SELECT enabled <> 0, immediate_enabled <> 0, digest_enabled <> 0
		FROM user_notification_preferences WHERE user_id = $1
	`, contractPGOwnerID).Scan(&enabled, &immediate, &digest); err != nil {
		t.Fatal(err)
	}
	if !enabled || !immediate || digest {
		t.Fatalf("persisted notification flags=%v/%v/%v", enabled, immediate, digest)
	}

	initialNtfy := contractPGServe(database, router, contractPGRequest(http.MethodGet, "/api/workspace/me/ntfy", "", contractPGOwnerID, "", "ntfy-get"))
	if initialNtfy.Code != http.StatusOK {
		t.Fatalf("ntfy get status=%d body=%s", initialNtfy.Code, initialNtfy.Body.String())
	}
	var initialNtfyPayload struct {
		Ntfy struct {
			Enabled   bool    `json:"enabled"`
			Topic     string  `json:"topic"`
			ServerURL string  `json:"serverUrl"`
			RotatedAt *string `json:"rotatedAt"`
		} `json:"ntfy"`
	}
	contractPGDecode(t, initialNtfy, &initialNtfyPayload)
	if !initialNtfyPayload.Ntfy.Enabled || !strings.HasPrefix(initialNtfyPayload.Ntfy.Topic, "duallane-contract-contract-owner-") || initialNtfyPayload.Ntfy.ServerURL != "https://ntfy.example.test" || initialNtfyPayload.Ntfy.RotatedAt != nil {
		t.Fatalf("initial ntfy=%#v", initialNtfyPayload.Ntfy)
	}

	updatedNtfy := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/ntfy", `{"enabled":false}`, contractPGOwnerID, "ntfy-patch-disabled")
	if updatedNtfy.Code != http.StatusOK {
		t.Fatalf("ntfy patch status=%d body=%s", updatedNtfy.Code, updatedNtfy.Body.String())
	}
	contractPGDecode(t, updatedNtfy, &initialNtfyPayload)
	if initialNtfyPayload.Ntfy.Enabled || initialNtfyPayload.Ntfy.Topic == "" {
		t.Fatalf("updated ntfy=%#v", initialNtfyPayload.Ntfy)
	}

	omittedNtfy := contractPGJSON(database, router, http.MethodPatch, "/api/workspace/me/ntfy", `{}`, contractPGOwnerID, "ntfy-patch-omitted")
	if omittedNtfy.Code != http.StatusOK {
		t.Fatalf("omitted ntfy patch status=%d body=%s", omittedNtfy.Code, omittedNtfy.Body.String())
	}
	contractPGDecode(t, omittedNtfy, &initialNtfyPayload)
	if initialNtfyPayload.Ntfy.Enabled || initialNtfyPayload.Ntfy.Topic == "" {
		t.Fatalf("omitted ntfy changed state=%#v", initialNtfyPayload.Ntfy)
	}

	rotated := contractPGServe(database, router, contractPGRequest(http.MethodPost, "/api/workspace/me/ntfy/rotate", "", contractPGOwnerID, "", "ntfy-rotate"))
	if rotated.Code != http.StatusOK {
		t.Fatalf("ntfy rotate status=%d body=%s", rotated.Code, rotated.Body.String())
	}
	var rotatedPayload struct {
		Ntfy struct {
			Enabled   bool    `json:"enabled"`
			Topic     string  `json:"topic"`
			RotatedAt *string `json:"rotatedAt"`
		} `json:"ntfy"`
	}
	contractPGDecode(t, rotated, &rotatedPayload)
	if rotatedPayload.Ntfy.Enabled || rotatedPayload.Ntfy.Topic == initialNtfyPayload.Ntfy.Topic || rotatedPayload.Ntfy.RotatedAt == nil {
		t.Fatalf("rotated ntfy=%#v", rotatedPayload.Ntfy)
	}
	var ntfyPreferenceRows int
	if err := database.pool.QueryRow(database.ctx, `SELECT COUNT(*) FROM workspace_ntfy_preferences WHERE user_id = $1`, contractPGOwnerID).Scan(&ntfyPreferenceRows); err != nil {
		t.Fatal(err)
	}
	if ntfyPreferenceRows != 1 {
		t.Fatalf("ntfy preference rows=%d, want 1", ntfyPreferenceRows)
	}
	if mailerCalls.Load() != 0 || publisherCalls.Load() != 0 {
		t.Fatalf("preference routes contacted providers: mailer=%d publisher=%d", mailerCalls.Load(), publisherCalls.Load())
	}
}
