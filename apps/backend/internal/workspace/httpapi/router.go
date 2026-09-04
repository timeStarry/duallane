package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/invites"
)

const MaxJSONBodyBytes int64 = 1 << 20

type ActorResolver interface {
	ResolveActor(context.Context, *http.Request) (*auth.Actor, error)
}

type InviteService interface {
	Create(context.Context, invites.CreateInput) (invites.Invite, error)
	Revoke(context.Context, invites.RevokeInput) (invites.RevokedInvite, error)
}

type RouterOptions struct {
	Gate          gate.Gate
	Health        http.Handler
	AuthRoutes    *auth.HTTPHandler
	ActorResolver ActorResolver
	Invites       InviteService
	FrontendURL   string
	PublicBaseURL string
	TrustProxy    bool
}

func NewRouter(options RouterOptions) http.Handler {
	router := chi.NewRouter()
	if options.Health != nil {
		router.Handle("/api/health", options.Health)
	}
	if options.AuthRoutes != nil {
		router.Get("/api/auth/github/start", options.AuthRoutes.HandleGitHubStart)
		router.Get("/api/auth/github/callback", options.AuthRoutes.HandleGitHubCallback)
		router.Post("/api/auth/logout", options.AuthRoutes.HandleLogout)
	}
	router.Route("/api/workspace", func(workspace chi.Router) {
		workspace.Use(options.Gate.Middleware)
		workspace.Post("/invites", createInviteHandler(options))
		workspace.Post("/invites/{inviteId}/revoke", revokeInviteHandler(options))
	})
	return router
}

type createInviteRequest struct {
	DefaultRole    string `json:"defaultRole"`
	Code           string `json:"code"`
	MaxUses        int    `json:"maxUses"`
	ExpiresAt      string `json:"expiresAt"`
	ExpiresInHours int64  `json:"expiresInHours"`
}

func createInviteHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := resolveActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		var body createInviteRequest
		if err := decodeJSON(response, request, &body); err != nil {
			writeError(response, err)
			return
		}
		if options.Invites == nil {
			writeError(response, internalError())
			return
		}
		invite, err := options.Invites.Create(request.Context(), invites.CreateInput{
			ActorID: actor.ID, DefaultRole: body.DefaultRole, Code: body.Code, MaxUses: body.MaxUses,
			ExpiresAt: body.ExpiresAt, ExpiresInHours: body.ExpiresInHours,
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeError(response, err)
			return
		}
		inviteURL, err := buildInviteURL(options, request, invite.Code)
		if err != nil {
			writeError(response, internalError())
			return
		}
		writeJSON(response, http.StatusCreated, map[string]any{
			"invite": map[string]any{
				"id": invite.ID, "code": invite.Code, "codePreview": invite.CodePreview,
				"defaultRole": invite.DefaultRole, "maxUses": invite.MaxUses, "uses": invite.Uses,
				"expiresAt": invite.ExpiresAt, "createdAt": invite.CreatedAt, "inviteUrl": inviteURL,
			},
		})
	}
}

func revokeInviteHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := resolveActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		if options.Invites == nil {
			writeError(response, internalError())
			return
		}
		invite, err := options.Invites.Revoke(request.Context(), invites.RevokeInput{
			ActorID: actor.ID, InviteID: chi.URLParam(request, "inviteId"),
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"invite": invite})
	}
}

func resolveActor(response http.ResponseWriter, request *http.Request, resolver ActorResolver) (*auth.Actor, bool) {
	if resolver == nil {
		writeError(response, auth.NewError(auth.CodeRequired, auth.MessageRequired, http.StatusUnauthorized))
		return nil, false
	}
	actor, err := resolver.ResolveActor(request.Context(), request)
	if err != nil {
		writeError(response, err)
		return nil, false
	}
	return actor, true
}

func decodeJSON(response http.ResponseWriter, request *http.Request, target any) error {
	if request == nil || request.Body == nil || request.ContentLength == 0 {
		return nil
	}
	contentType := request.Header.Get("Content-Type")
	if contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || mediaType != "application/json" {
			return &publicError{Code: "request.unsupported_media_type", Message: "请求格式必须为 JSON", StatusCode: http.StatusUnsupportedMediaType}
		}
	}
	request.Body = http.MaxBytesReader(response, request.Body, MaxJSONBodyBytes)
	decoder := json.NewDecoder(request.Body)
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return &publicError{Code: "request.too_large", Message: "请求内容过大", StatusCode: http.StatusRequestEntityTooLarge}
		}
		return &publicError{Code: "request.invalid_json", Message: "请求内容不是有效 JSON", StatusCode: http.StatusBadRequest}
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return &publicError{Code: "request.invalid_json", Message: "请求内容不是有效 JSON", StatusCode: http.StatusBadRequest}
	}
	return nil
}

func buildInviteURL(options RouterOptions, request *http.Request, code string) (string, error) {
	base := strings.TrimSpace(options.FrontendURL)
	if base == "" {
		base = strings.TrimSpace(options.PublicBaseURL)
	}
	if base == "" && request != nil {
		scheme := "http"
		if auth.RequestIsSecure(request, options.TrustProxy) {
			scheme = "https"
		}
		base = scheme + "://" + request.Host
	}
	if base == "" {
		base = "http://127.0.0.1:5173"
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("invite base URL is invalid")
	}
	parsed.Path = "/workspace"
	parsed.RawPath = ""
	parsed.RawQuery = url.Values{"invite": []string{code}}.Encode()
	parsed.Fragment = ""
	return parsed.String(), nil
}

type publicError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"-"`
}

func (err *publicError) Error() string { return err.Code }

func internalError() *publicError {
	return &publicError{Code: "internal.error", Message: "服务暂时不可用", StatusCode: http.StatusInternalServerError}
}

func writeError(response http.ResponseWriter, err error) {
	value := internalError()
	var authError *auth.Error
	var inviteError *invites.Error
	var transportError *publicError
	switch {
	case errors.As(err, &authError):
		value = &publicError{Code: authError.Code, Message: authError.Message, StatusCode: authError.StatusCode}
	case errors.As(err, &inviteError):
		value = &publicError{Code: inviteError.Code, Message: inviteError.Message, StatusCode: inviteError.StatusCode}
	case errors.As(err, &transportError):
		value = transportError
	}
	writeJSON(response, value.StatusCode, map[string]any{"error": value})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
