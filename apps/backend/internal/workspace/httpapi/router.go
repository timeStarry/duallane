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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bootstrap"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bots"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/invites"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/members"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/overview"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

const MaxJSONBodyBytes int64 = 1 << 20

type ActorResolver interface {
	ResolveActor(context.Context, *http.Request) (*auth.Actor, error)
}

type InviteService interface {
	Create(context.Context, invites.CreateInput) (invites.Invite, error)
	Revoke(context.Context, invites.RevokeInput) (invites.RevokedInvite, error)
}

type MemberService interface {
	List(context.Context, members.ListInput) ([]members.Member, error)
	UpdateOwnProfile(context.Context, members.UpdateOwnProfileInput) (members.Member, error)
	UpdateMemberRemark(context.Context, members.RemarkInput) (members.Member, error)
	RemoveMemberRemark(context.Context, members.RemarkInput) (members.Member, error)
	GetVisibility(context.Context, members.VisibilityReadInput) (members.VisibilityRule, error)
	UpdateVisibility(context.Context, members.VisibilityInput) (members.VisibilityRule, error)
	UpdateMemberRole(context.Context, members.RoleInput) (members.Member, error)
	RemoveMember(context.Context, members.RemoveInput) (members.RemoveResult, error)
}

type ConversationService interface {
	ListConversations(context.Context, string, auth.RequestMeta) ([]conversations.Conversation, error)
	GetConversation(context.Context, conversations.ConversationInput) (conversations.Conversation, error)
	CreateConversation(context.Context, conversations.CreateConversationInput) (conversations.Conversation, error)
	AddMember(context.Context, conversations.ConversationMemberInput) (conversations.Conversation, error)
	RemoveMember(context.Context, conversations.ConversationMemberInput) (conversations.Conversation, error)
	UpdateGroup(context.Context, conversations.UpdateGroupInput) (conversations.Conversation, error)
	Leave(context.Context, conversations.ConversationInput) (conversations.LeaveResult, error)
	MarkRead(context.Context, conversations.ConversationInput) (conversations.Conversation, error)
	UpdateNotification(context.Context, conversations.NotificationInput) (conversations.Conversation, error)
	ListPins(context.Context, conversations.ConversationInput) ([]conversations.PinListItem, error)
	Pin(context.Context, conversations.PinInput) (conversations.PinListItem, error)
	Unpin(context.Context, conversations.PinInput) (conversations.UnpinResult, error)
}

type MessageService interface {
	List(context.Context, messages.ListOptions) ([]messages.Message, error)
	Create(context.Context, messages.CreateInput) (messages.Message, error)
	Recall(context.Context, messages.RecallInput) (messages.Message, error)
	Hide(context.Context, messages.HideInput) (messages.HideResult, error)
	Unhide(context.Context, messages.HideInput) (messages.HideResult, error)
	AddReaction(context.Context, messages.ReactionInput) (messages.ReactionResult, error)
	RemoveReaction(context.Context, messages.ReactionInput) (messages.ReactionResult, error)
}

type OverviewService interface {
	GetStatistics(context.Context, string, auth.RequestMeta) (overview.Statistics, error)
}

type BootstrapService interface {
	Get(context.Context, string, auth.RequestMeta) (bootstrap.Bootstrap, error)
}

type NtfyService interface {
	GetPreferences(context.Context, string) (ntfy.Preferences, error)
	UpdatePreferences(context.Context, ntfy.UpdatePreferencesInput) (ntfy.Preferences, error)
	RotateTopic(context.Context, ntfy.RotateTopicInput) (ntfy.Preferences, error)
}

type EmailService interface {
	GetPreferences(context.Context, string) (email.Preferences, error)
	UpdatePreferences(context.Context, email.UpdatePreferencesInput) (email.Preferences, error)
	GetSpaceSettings(context.Context, string) (email.SpaceSettings, error)
	TestSpaceSettings(context.Context, email.TestSettingsInput) (email.SMTPTestResult, error)
	SaveSpaceSettings(context.Context, email.SaveSettingsInput) (email.SpaceSettings, error)
	CreateEmailChallenge(context.Context, email.CreateChallengeInput) (email.ChallengeResult, error)
	VerifyEmailChallenge(context.Context, email.VerifyChallengeInput) (email.Preferences, error)
	UseGitHubEmail(context.Context, email.UseGitHubEmailInput) (email.Preferences, error)
}

type RouterOptions struct {
	Gate               gate.Gate
	Health             http.Handler
	Readiness          http.Handler
	AuthRoutes         *auth.HTTPHandler
	ActorResolver      ActorResolver
	Invites            InviteService
	Members            MemberService
	Conversations      ConversationService
	Messages           MessageService
	Cards              CardService
	Interactions       InteractionService
	Overview           OverviewService
	Bootstrap          BootstrapService
	Files              fileService
	Topics             topicService
	Ntfy               NtfyService
	Email              EmailService
	Emotes             emoteService
	Bots               BotService
	Realtime           http.Handler
	FrontendURL        string
	PublicBaseURL      string
	InteractionSpaceID string
	TrustProxy         bool
}

func NewRouter(options RouterOptions) http.Handler {
	router := chi.NewRouter()
	if options.Health != nil {
		router.Handle("/api/health", options.Health)
	}
	if options.Readiness != nil {
		router.Handle("/readyz", options.Readiness)
	}
	if options.AuthRoutes != nil {
		router.Get("/api/auth/github/start", options.AuthRoutes.HandleGitHubStart)
		router.Get("/api/auth/github/callback", options.AuthRoutes.HandleGitHubCallback)
		router.Post("/api/auth/logout", options.AuthRoutes.HandleLogout)
	}
	realtimeHandler := options.Realtime
	if realtimeHandler == nil {
		realtimeHandler = http.NotFoundHandler()
	}
	router.With(options.Gate.Middleware).Handle("/ws/workspace", realtimeHandler)
	router.Route("/api/workspace", func(workspace chi.Router) {
		workspace.Use(options.Gate.Middleware)
		workspace.Get("/bootstrap", bootstrapHandler(options))
		workspace.Post("/invites", createInviteHandler(options))
		workspace.Post("/invites/{inviteId}/revoke", revokeInviteHandler(options))
		if options.AuthRoutes != nil {
			workspace.Post("/invites/{code}/accept", func(response http.ResponseWriter, request *http.Request) {
				options.AuthRoutes.HandleDevelopmentInviteAccept(response, request, chi.URLParam(request, "code"))
			})
		}
		registerCoreRoutes(workspace, options)
		registerFileRoutes(workspace, options)
		registerTopicRoutes(workspace, options)
		registerNtfyRoutes(workspace, options)
		registerEmailRoutes(workspace, options)
		registerEmoteRoutes(workspace, options)
		registerCardRoutes(workspace, options)
		registerInteractionRoutes(workspace, options)
		registerBotRoutes(workspace, options)
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
	if actor == nil {
		writeError(response, auth.NewError(auth.CodeRequired, auth.MessageRequired, http.StatusUnauthorized))
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
	Details    any    `json:"details,omitempty"`
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
	var memberError *members.Error
	var conversationError *conversations.Error
	var messageError *messages.Error
	var cardError *cards.Error
	var interactionError *interactions.Error
	var overviewError *overview.Error
	var fileError *files.Error
	var topicError *topics.Error
	var ntfyError *ntfy.Error
	var emailError *email.Error
	var emoteError *emotes.Error
	var botError *bots.Error
	var transportError *publicError
	switch {
	case errors.As(err, &authError):
		value = &publicError{Code: authError.Code, Message: authError.Message, StatusCode: authError.StatusCode}
	case errors.As(err, &inviteError):
		value = &publicError{Code: inviteError.Code, Message: inviteError.Message, StatusCode: inviteError.StatusCode}
	case errors.As(err, &memberError):
		value = &publicError{Code: memberError.Code, Message: memberError.Message, StatusCode: memberError.StatusCode}
	case errors.As(err, &conversationError):
		value = &publicError{Code: conversationError.Code, Message: conversationError.Message, StatusCode: conversationError.StatusCode}
	case errors.As(err, &messageError):
		value = &publicError{Code: messageError.Code, Message: messageError.Message, StatusCode: messageError.StatusCode}
	case errors.As(err, &cardError):
		value = &publicError{Code: cardError.Code, Message: cardError.Message, StatusCode: publicStatus(cardError.StatusCode)}
	case errors.As(err, &interactionError):
		value = &publicError{Code: interactionError.Code, Message: interactionError.Message, StatusCode: publicStatus(interactionError.StatusCode), Details: interactionError.Details}
	case errors.As(err, &overviewError):
		value = &publicError{Code: overviewError.Code, Message: overviewError.Message, StatusCode: overviewError.StatusCode}
	case errors.As(err, &fileError):
		value = &publicError{Code: fileError.Code, Message: fileError.Message, StatusCode: fileError.StatusCode}
	case errors.As(err, &topicError):
		value = &publicError{Code: topicError.Code, Message: topicError.Message, StatusCode: topicError.StatusCode}
	case errors.As(err, &ntfyError):
		value = &publicError{Code: ntfyError.Code, Message: ntfyError.Message, StatusCode: ntfyError.StatusCode}
	case errors.As(err, &emailError):
		value = &publicError{Code: emailError.Code, Message: emailError.Message, StatusCode: emailError.StatusCode}
	case errors.As(err, &emoteError):
		value = &publicError{Code: emoteError.Code, Message: emoteError.Message, StatusCode: emoteError.StatusCode}
	case errors.As(err, &botError):
		value = &publicError{Code: botError.Code, Message: botError.Message, StatusCode: botError.StatusCode}
	case errors.As(err, &transportError):
		value = transportError
	}
	writeJSON(response, value.StatusCode, map[string]any{"error": value})
}

func publicStatus(status int) int {
	if status <= 0 {
		return http.StatusBadRequest
	}
	return status
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
