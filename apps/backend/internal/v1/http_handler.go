package v1

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	sdkgate "github.com/timestarry/duallane/apps/backend/internal/workspace/sdkgate"
)

const MaxBotFileUploadBytes int64 = 50 * 1024 * 1024

type ActorResolver interface {
	ResolveActor(context.Context, *http.Request) (*auth.Actor, error)
}

type SessionIssuer interface {
	CheckPublicAuthRateLimit(context.Context, *http.Request) (bool, error)
	IssueWebLoginSession(http.ResponseWriter, *http.Request, string) (string, error)
	IssueMobileLoginSession(context.Context, string) (auth.MobileTokens, error)
}

type BotAuthenticator interface {
	Authenticate(context.Context, string, botgateway.TokenAuthOptions) (*botgateway.Auth, error)
}

type BotFileUploader interface {
	ReserveAgentBotUpload(context.Context, files.ReserveUploadInput) (files.UploadResult, error)
	CompleteAgentBotUpload(context.Context, files.CompleteUploadInput) (files.UploadResult, error)
}

type botUploadFailureReleaser interface {
	FailAgentBotUpload(context.Context, files.FailUploadInput) (files.UploadResult, error)
}

type BotMessageCreator interface {
	Create(context.Context, messages.CreateInput) (messages.Message, error)
}

type HTTPHandler struct {
	service     *Service
	resolver    ActorResolver
	sessions    SessionIssuer
	botAuth     BotAuthenticator
	botFiles    BotFileUploader
	botMessages BotMessageCreator
}

func NewHTTPHandler(service *Service, resolver ActorResolver) *HTTPHandler {
	h := &HTTPHandler{service: service, resolver: resolver}
	if issuer, ok := resolver.(SessionIssuer); ok {
		h.sessions = issuer
	}
	return h
}

func (h *HTTPHandler) WithSessionIssuer(issuer SessionIssuer) *HTTPHandler {
	h.sessions = issuer
	return h
}

func (h *HTTPHandler) WithBotAuthenticator(botAuth BotAuthenticator) *HTTPHandler {
	h.botAuth = botAuth
	return h
}

func (h *HTTPHandler) WithBotFilePipeline(botFiles BotFileUploader, botMessages BotMessageCreator) *HTTPHandler {
	h.botFiles = botFiles
	h.botMessages = botMessages
	return h
}

func (h *HTTPHandler) Mount(r chi.Router) {
	r.Get("/api/bot/v2/conversations", h.handleBotListConversations)
	r.Get("/api/bot/v2/capabilities", h.handleAgentCapabilities)
	r.Post("/api/bot/v2/tasks", h.handleCreateAgentTask)
	r.Get("/api/bot/v2/tasks/{taskId}", h.handleGetAgentTask)
	r.Delete("/api/bot/v2/tasks/{taskId}", h.handleGetAgentTask)
	r.Get("/api/bot/v2/tasks/{taskId}/operations/{operation}/{key}", h.handleAgentOperation)
	r.Get("/api/bot/v2/conversations/{conversationId}/messages", h.handleAgentHistory)
	r.Get("/api/bot/v2/conversations/{conversationId}/members", h.handleAgentMembers)
	r.Get("/api/bot/v2/messages/{messageId}", h.handleGetAgentMessage)
	r.Get("/api/bot/v2/doctor", h.handleBotDoctor)
	r.Patch("/api/bot/v2/messages/{messageId}", h.handleBotEditMessage)
	r.Post("/api/bot/v2/conversations/{conversationId}/files", h.handleBotSendConversationFile)
	r.Put("/api/bot/v2/uploads/{uploadId}/content", h.handleBotCompleteUploadContent)
	r.Get("/api/bot/v2/uploads/{uploadId}", h.handleBotUploadStatus)
	r.Get("/api/bot/v2/conversations/{conversationId}/attachments/{attachmentId}/content", h.handleBotAttachmentContent)
	r.Post("/api/bot/v2/typing", h.handleBotTyping)
	r.Post("/api/bot/v2/unbind", h.handleBotUnbind)
	r.Put("/api/bot/v2/mobile-release/apk", h.handleBotUploadMobileAPK)
	r.Put("/api/bot/v2/mobile-release/ota", h.handleBotUploadMobileOTA)
	r.Put("/api/bot/v2/mobile-release", h.handleBotUpdateMobileRelease)

	r.Route("/api/v1", func(r chi.Router) {
		r.Post("/auth/qr/start", h.handleQRStart)
		r.Post("/auth/qr/{sessionId}/exchange", h.handleQRExchange)
		r.Post("/auth/email/send-code", h.handleSendLoginEmailCode)
		r.Post("/auth/email/verify", h.handleVerifyLoginEmail)
		r.Get("/mobile/releases/latest", h.handlePublicMobileReleaseLatest)
		r.Get("/mobile/native-policy", h.handlePublicMobileNativePolicy)
		r.Get("/mobile/android/latest.apk", h.handlePublicMobileDownloadAPK)
		r.Head("/mobile/android/latest.apk", h.handlePublicMobileDownloadAPK)
		r.Get("/mobile/android/latest-ota.zip", h.handlePublicMobileDownloadOTA)
		r.Head("/mobile/android/latest-ota.zip", h.handlePublicMobileDownloadOTA)

		r.Group(func(r chi.Router) {
			r.Use(h.requireActor)
			r.Get("/bootstrap", h.handleBootstrap)
			r.Post("/announcement/ack", h.handleAckAnnouncement)
			r.Post("/account/email/send-code", h.handleSendBindEmailCode)
			r.Post("/account/email/verify", h.handleVerifyBindEmail)
			r.Delete("/account/email", h.handleUnbindEmail)
			r.Get("/sync", h.handleSync)
			r.Get("/search", h.handleSearch)
			r.Post("/conversations/saved", h.handleSavedConversation)
			r.Post("/conversations/groups", h.handleCreateGroup)
			r.Patch("/conversations/{conversationId}", h.handleUpdateGroup)
			r.Post("/conversations/{conversationId}/members", h.handleAddGroupMembers)
			r.Delete("/conversations/{conversationId}/members/{userId}", h.handleRemoveGroupMember)
			r.Post("/conversations/{conversationId}/leave", h.handleLeaveGroup)
			r.Post("/conversations/{conversationId}/read", h.handleMarkConversationRead)
			r.Post("/conversations/{conversationId}/typing", h.handleConversationTyping)
			r.Post("/conversations/{conversationId}/pins/{messageId}", h.handlePin)
			r.Delete("/conversations/{conversationId}/pins/{messageId}", h.handleUnpin)
			r.Patch("/messages/{messageId}", h.handleEditMessage)
			r.Post("/messages/forward", h.handleForwardMessages)
			r.Get("/conversations/{conversationId}/threads", h.handleListConversationThreads)
			r.Get("/conversations/{conversationId}/media", h.handleListConversationMedia)
			r.Get("/conversations/{conversationId}/bot-requests", h.handleGroupBotRequests)
			r.Get("/messages/{messageId}/thread", h.handleGetThread)
			r.Post("/messages/{messageId}/thread", h.handleReplyThread)
			r.Get("/devices", h.handleListDevices)
			r.Delete("/devices/{deviceId}", h.handleRevokeDevice)
			r.Post("/auth/qr/{sessionId}/approve", h.handleQRApprove)
			r.Get("/preferences", h.handleGetPreferences)
			r.Put("/preferences", h.handleSavePreferences)
			r.Post("/bots", h.handleCreateBot)
			r.Patch("/bots/{botId}/profile", h.handleUpdateBotProfile)
			r.Put("/bots/{botId}/avatar", h.handleUploadBotAvatar)
			r.Delete("/bots/{botId}/avatar", h.handleDeleteBotAvatar)
			r.Get("/bots/{botId}/avatar", h.handleGetBotAvatar)
			r.Get("/bots/{botId}/commands", h.handleListBotCommandsByBot)
			r.Put("/bots/{botId}/commands", h.handleRegisterBotCommands)
			r.Get("/bots/{botId}/overview", h.handleGetBotOverview)
			r.Post("/bots/{botId}/request-upgrade", h.handleRequestBotUpgrade)
			r.Get("/conversations/{conversationId}/bot-commands", h.handleListBotCommands)
			r.Put("/bots/{botId}/webhook", h.handleUpsertBotWebhook)

			r.Route("/admin", func(r chi.Router) {
				r.Use(h.requireSpaceManager)
				r.Get("/overview", h.handleAdminOverview)
				r.Get("/invites", h.handleAdminListInvites)
				r.Get("/audit-logs", h.handleAdminListAuditLogs)
				r.Patch("/policy", h.handleAdminUpdatePolicy)
				r.Post("/storage/cleanup", h.handleAdminStorageCleanup)
				r.Get("/announcement", h.handleAdminGetAnnouncement)
				r.Put("/announcement", h.handleAdminUpdateAnnouncement)
				r.Get("/mobile-release", h.handleAdminGetMobileRelease)
				r.Put("/mobile-release", h.handleAdminUpdateMobileRelease)
				r.Put("/mobile-release/apk", h.handleAdminUploadMobileAPK)
				r.Put("/mobile-release/ota", h.handleAdminUploadMobileOTA)
			})
		})
	})
}

type actorContextKey struct{}

func (h *HTTPHandler) requireActor(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.resolver == nil {
			writeJSONError(w, http.StatusServiceUnavailable, "v1.unavailable", "服务未就绪")
			return
		}
		actor, err := h.resolver.ResolveActor(r.Context(), r)
		if err != nil || actor == nil {
			writeJSONError(w, http.StatusUnauthorized, "auth.required", "请先登录")
			return
		}
		ctx := context.WithValue(r.Context(), actorContextKey{}, actor)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func actorFromContext(ctx context.Context) *auth.Actor {
	actor, _ := ctx.Value(actorContextKey{}).(*auth.Actor)
	return actor
}

func (h *HTTPHandler) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	res, err := h.service.GetBootstrap(r.Context(), actorFromContext(r.Context()).ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *HTTPHandler) handleSync(w http.ResponseWriter, r *http.Request) {
	rawSeq := r.URL.Query().Get("sinceSeq")
	if rawSeq == "" {
		rawSeq = r.URL.Query().Get("afterSeq")
	}
	sinceSeq, _ := strconv.ParseInt(rawSeq, 10, 64)
	res, err := h.service.SyncDelta(r.Context(), actorFromContext(r.Context()).ID, sinceSeq)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *HTTPHandler) handleSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))
	res, err := h.service.SearchWithOptions(r.Context(), actorFromContext(r.Context()).ID, SearchOptions{
		Query:          query.Get("q"),
		Scope:          query.Get("scope"),
		ConversationID: query.Get("conversationId"),
		SenderID:       query.Get("senderId"),
		Limit:          limit,
		Offset:         offset,
	})
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *HTTPHandler) handleListConversationMedia(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationId")
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))
	res, err := h.service.ListConversationMedia(
		r.Context(),
		actorFromContext(r.Context()).ID,
		convID,
		strings.TrimSpace(query.Get("kind")),
		limit,
		offset,
	)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *HTTPHandler) handleSavedConversation(w http.ResponseWriter, r *http.Request) {
	id, err := h.service.GetOrCreateSavedConversation(r.Context(), actorFromContext(r.Context()).ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"conversationId": id})
}

func (h *HTTPHandler) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	var body CreateGroupInput
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	conv, err := h.service.CreateGroupConversation(r.Context(), actorFromContext(r.Context()).ID, body)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"conversation": conv})
}

func (h *HTTPHandler) handleUpdateGroup(w http.ResponseWriter, r *http.Request) {
	var fields map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&fields); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	var input UpdateGroupInput
	if rawTitle, ok := fields["title"]; ok {
		input.TitleSet = true
		var title *string
		if err := json.Unmarshal(rawTitle, &title); err != nil {
			writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "群聊名称格式无效")
			return
		}
		input.Title = title
	}
	if rawAvatar, ok := fields["avatar"]; ok {
		input.AvatarSet = true
		var avatar *string
		if err := json.Unmarshal(rawAvatar, &avatar); err != nil {
			writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "群头像格式无效")
			return
		}
		input.Avatar = avatar
	} else if rawAvatarEmoji, ok := fields["avatarEmoji"]; ok {
		input.AvatarSet = true
		var avatar *string
		if err := json.Unmarshal(rawAvatarEmoji, &avatar); err != nil {
			writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "群头像格式无效")
			return
		}
		input.Avatar = avatar
	}
	conv, err := h.service.UpdateGroupConversation(
		r.Context(),
		actorFromContext(r.Context()).ID,
		chi.URLParam(r, "conversationId"),
		input,
	)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": conv})
}

func (h *HTTPHandler) handleAddGroupMembers(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserIDs []string `json:"userIds"`
		UserID  string   `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	ids := body.UserIDs
	if body.UserID != "" {
		ids = append(ids, body.UserID)
	}
	conv, err := h.service.AddGroupMembers(
		r.Context(),
		actorFromContext(r.Context()).ID,
		chi.URLParam(r, "conversationId"),
		ids,
	)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": conv})
}

func (h *HTTPHandler) handleLeaveGroup(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationId")
	if err := h.service.LeaveGroupConversation(r.Context(), actorFromContext(r.Context()).ID, convID); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "conversationId": convID})
}

func (h *HTTPHandler) handleRemoveGroupMember(w http.ResponseWriter, r *http.Request) {
	conv, err := h.service.RemoveGroupMember(
		r.Context(),
		actorFromContext(r.Context()).ID,
		chi.URLParam(r, "conversationId"),
		chi.URLParam(r, "userId"),
	)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": conv})
}

func (h *HTTPHandler) handleMarkConversationRead(w http.ResponseWriter, r *http.Request) {
	convID := chi.URLParam(r, "conversationId")
	var body struct {
		MessageID *string `json:"messageId"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	if err := decoder.Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	result, err := h.service.MarkConversationRead(r.Context(), actorFromContext(r.Context()).ID, convID, body.MessageID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK             bool   `json:"ok"`
		ConversationID string `json:"conversationId"`
		ConversationReadResult
	}{OK: true, ConversationID: convID, ConversationReadResult: result})
}

func (h *HTTPHandler) handleConversationTyping(w http.ResponseWriter, r *http.Request) {
	var body struct {
		State string `json:"state"`
	}
	if r.ContentLength != 0 {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	convID := chi.URLParam(r, "conversationId")
	expiresAt, err := h.service.SendConversationTyping(r.Context(), actorFromContext(r.Context()).ID, convID, "human", body.State)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accepted": true, "conversationId": convID, "expiresAt": expiresAt})
}

func (h *HTTPHandler) handleEditMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PlainText string `json:"plainText"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	if err := h.service.EditMessage(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "messageId"), body.PlainText); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *HTTPHandler) handleForwardMessages(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TargetConversationID string   `json:"targetConversationId"`
		MessageIDs           []string `json:"messageIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	ids, err := h.service.ForwardMessages(r.Context(), actorFromContext(r.Context()).ID, body.TargetConversationID, body.MessageIDs)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"createdIds": ids})
}

func (h *HTTPHandler) handleListConversationThreads(w http.ResponseWriter, r *http.Request) {
	items, err := h.service.ListConversationThreads(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "conversationId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if items == nil {
		items = []ConversationThreadItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"threads": items})
}

func (h *HTTPHandler) handleGetThread(w http.ResponseWriter, r *http.Request) {
	view, err := h.service.GetThread(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "messageId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (h *HTTPHandler) handleReplyThread(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PlainText         string `json:"plainText"`
		ThreadTitle       string `json:"threadTitle"`
		AlsoSendToChannel bool   `json:"alsoSendToChannel"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	reply, err := h.service.ReplyThread(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "messageId"), body.PlainText, body.ThreadTitle, body.AlsoSendToChannel)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, reply)
}

func (h *HTTPHandler) handlePin(w http.ResponseWriter, r *http.Request) {
	if err := h.service.PinMessage(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "conversationId"), chi.URLParam(r, "messageId")); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"pinned": true})
}

func (h *HTTPHandler) handleUnpin(w http.ResponseWriter, r *http.Request) {
	if err := h.service.UnpinMessage(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "conversationId"), chi.URLParam(r, "messageId")); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"pinned": false})
}

func (h *HTTPHandler) handleListDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := h.service.ListDevices(r.Context(), actorFromContext(r.Context()).ID, r.Header.Get("X-Device-ID"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (h *HTTPHandler) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	if err := h.service.RevokeDevice(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "deviceId")); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

func (h *HTTPHandler) handleQRStart(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Platform   string `json:"platform"`
		DeviceName string `json:"deviceName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	session, err := h.service.CreateQRSession(r.Context(), body.Platform, body.DeviceName)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, session)
}

func (h *HTTPHandler) handleQRApprove(w http.ResponseWriter, r *http.Request) {
	session, err := h.service.ApproveQRSession(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "sessionId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func (h *HTTPHandler) handleQRExchange(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Challenge string `json:"challenge"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	token, err := h.service.ExchangeQRSession(r.Context(), chi.URLParam(r, "sessionId"), body.Challenge)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"accessToken": token})
}

func (h *HTTPHandler) handleGetPreferences(w http.ResponseWriter, r *http.Request) {
	prefs, err := h.service.GetPreferences(r.Context(), actorFromContext(r.Context()).ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"preferences": prefs})
}

func (h *HTTPHandler) handleSavePreferences(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Preferences map[string]any `json:"preferences"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	if err := h.service.SavePreferences(r.Context(), actorFromContext(r.Context()).ID, body.Preferences); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

func (h *HTTPHandler) handleRegisterBotCommands(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Commands []BotCommand `json:"commands"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	if err := h.service.RegisterBotCommands(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "botId"), body.Commands); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"updated": true})
}

func (h *HTTPHandler) handleCreateBot(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	botID, err := h.service.CreateMultiBot(r.Context(), actorFromContext(r.Context()).ID, body.Name)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"botId": botID, "name": body.Name})
}

func (h *HTTPHandler) handleListBotCommandsByBot(w http.ResponseWriter, r *http.Request) {
	cmds, err := h.service.ListBotCommandsByBot(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "botId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": cmds})
}

func (h *HTTPHandler) handleListBotCommands(w http.ResponseWriter, r *http.Request) {
	cmds, err := h.service.ListBotCommands(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "conversationId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": cmds})
}

func (h *HTTPHandler) handleUpdateBotProfile(w http.ResponseWriter, r *http.Request) {
	var fields map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&fields); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	var input BotProfileUpdateInput
	if rawName, ok := fields["name"]; ok {
		input.NameSet = true
		var name *string
		if err := json.Unmarshal(rawName, &name); err != nil {
			writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "机器人名称格式无效")
			return
		}
		input.Name = name
	}
	if rawDesc, ok := fields["description"]; ok {
		input.DescriptionSet = true
		var desc *string
		if err := json.Unmarshal(rawDesc, &desc); err != nil {
			writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "机器人简介格式无效")
			return
		}
		input.Description = desc
	}
	if rawColor, ok := fields["color"]; ok {
		input.ColorSet = true
		var color *string
		if err := json.Unmarshal(rawColor, &color); err != nil {
			writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "机器人颜色格式无效")
			return
		}
		input.Color = color
	}
	res, err := h.service.UpdateBotProfile(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "botId"), input)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": res})
}

func (h *HTTPHandler) handleUploadBotAvatar(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 520*1024)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.avatar_too_large", "机器人头像大小需在 512KB 以内")
		return
	}
	mimeType := strings.TrimSpace(r.Header.Get("Content-Type"))
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = http.DetectContentType(data)
	}
	res, err := h.service.UploadBotAvatar(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "botId"), mimeType, data)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": res})
}

func (h *HTTPHandler) handleDeleteBotAvatar(w http.ResponseWriter, r *http.Request) {
	res, err := h.service.DeleteBotAvatar(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "botId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": res})
}

func (h *HTTPHandler) handleGetBotAvatar(w http.ResponseWriter, r *http.Request) {
	payload, err := h.service.GetBotAvatar(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "botId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Content-Type", payload.MIMEType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload.Data)
}

func (h *HTTPHandler) handleUpsertBotWebhook(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL     string `json:"url"`
		Secret  string `json:"secret"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	cfg, err := h.service.UpsertBotWebhook(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "botId"), body.URL, body.Secret, body.Enabled)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (h *HTTPHandler) handleGetBotOverview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	overview, err := h.service.GetBotConsoleOverview(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "botId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

func (h *HTTPHandler) handleRequestBotUpgrade(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	targetVersion, err := h.service.RequestBotRuntimeUpgrade(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "botId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"requested":     true,
		"targetVersion": targetVersion,
	})
}

func (h *HTTPHandler) requireSpaceManager(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor := actorFromContext(r.Context())
		if actor == nil || (actor.Role != "owner" && actor.Role != "admin") {
			writeJSONError(w, http.StatusForbidden, "v1.forbidden", "无权限访问空间治理接口")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *HTTPHandler) handleAdminOverview(w http.ResponseWriter, r *http.Request) {
	overview, err := h.service.GetAdminOverview(r.Context(), actorFromContext(r.Context()).ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

func (h *HTTPHandler) handleAdminListInvites(w http.ResponseWriter, r *http.Request) {
	invites, err := h.service.ListAdminInvites(r.Context(), actorFromContext(r.Context()).ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, invites)
}

func (h *HTTPHandler) handleAdminListAuditLogs(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := h.service.ListAdminAuditLogs(
		r.Context(),
		actorFromContext(r.Context()).ID,
		r.URL.Query().Get("result"),
		r.URL.Query().Get("q"),
		limit,
	)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *HTTPHandler) handleAdminUpdatePolicy(w http.ResponseWriter, r *http.Request) {
	var body AdminPolicyUpdateInput
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.bad_json", "请求格式无效")
		return
	}
	policy, err := h.service.UpdateSpacePolicy(r.Context(), actorFromContext(r.Context()).ID, body)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"policy": policy})
}

func (h *HTTPHandler) handleAdminStorageCleanup(w http.ResponseWriter, r *http.Request) {
	result, err := h.service.CleanupStaleStorage(r.Context(), actorFromContext(r.Context()).ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *HTTPHandler) authenticateBotRequest(w http.ResponseWriter, r *http.Request) (*botgateway.Auth, bool) {
	*r = *r.WithContext(botgateway.WithAgentTaskID(r.Context(), r.Header.Get(botgateway.AgentTaskHeader)))
	w.Header().Set("Cache-Control", "no-store")
	if h.botAuth == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "v1.unavailable", "Bot 网关尚未就绪")
		return nil, false
	}
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer") {
		writeJSONError(w, http.StatusUnauthorized, botgateway.CodeInvalidToken, botgateway.MessageInvalidToken)
		return nil, false
	}
	if _, err := botgateway.ExtractBearerToken(authorization); err != nil {
		writeBotGatewayError(w, err)
		return nil, false
	}
	botAuth, err := h.botAuth.Authenticate(r.Context(), authorization, botgateway.TokenAuthOptions{
		SpaceID: auth.DefaultSpaceID,
	})
	if err != nil {
		writeBotGatewayError(w, err)
		return nil, false
	}
	if botAuth == nil {
		writeJSONError(w, http.StatusUnauthorized, botgateway.CodeInvalidToken, botgateway.MessageInvalidToken)
		return nil, false
	}
	if err := sdkgate.RequireHTTP(r); err != nil {
		writeBotGatewayError(w, err)
		return nil, false
	}
	if gateway, ok := h.botAuth.(*botgateway.Service); ok && !h.authorizeAgentHTTP(w, r, botAuth, gateway) {
		return nil, false
	}
	return botAuth, true
}

func writeBotGatewayError(w http.ResponseWriter, err error) {
	var sdkError sdkgate.UpgradeRequiredError
	if errors.As(err, &sdkError) {
		writeJSON(w, http.StatusUpgradeRequired, map[string]any{"error": sdkError.Public()})
		return
	}
	var gwErr *botgateway.Error
	if errors.As(err, &gwErr) && gwErr != nil {
		status := gwErr.StatusCode
		if status < 400 || status >= 600 {
			status = http.StatusUnauthorized
		}
		writeJSONError(w, status, gwErr.Code, gwErr.Message)
		return
	}
	writeJSONError(w, http.StatusUnauthorized, botgateway.CodeInvalidToken, botgateway.MessageInvalidToken)
}

func (h *HTTPHandler) handleBotListConversations(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	items, err := h.service.ListBotConversations(r.Context(), botAuth.BotID, botAuth.UserID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if id := botgateway.AgentTaskID(r.Context()); id != "" {
		if gateway, ok := h.botAuth.(*botgateway.Service); ok {
			info, taskErr := gateway.GetAgentTask(r.Context(), botAuth, id)
			if taskErr != nil {
				writeBotGatewayError(w, taskErr)
				return
			}
			task := info["task"].(*botgateway.AgentTask)
			filtered := items[:0]
			for _, item := range items {
				if item.ID == task.ConversationID {
					filtered = append(filtered, item)
				}
			}
			items = filtered
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"conversations":    items,
		"latestSdkVersion": LatestAgentSDKVersion,
	})
}

func (h *HTTPHandler) handleBotDoctor(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	convs, err := h.service.ListBotConversations(r.Context(), botAuth.BotID, botAuth.UserID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	deliveries, err := h.service.ListBotRecentDeliveries(r.Context(), botAuth.BotID, 8)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"latestSdkVersion": LatestAgentSDKVersion,
		"manifestPath":     "/integrations/duallane-agent.manifest.json",
		"downloadPath":     "/integrations/duallane-agent.mjs",
		"bot": map[string]any{
			"id":               botAuth.BotID,
			"botUserId":        botAuth.UserID,
			"ownerUserId":      botAuth.OwnerUserID,
			"name":             botAuth.Bot.Name,
			"status":           botAuth.Bot.Status,
			"visibilityPolicy": botAuth.Bot.VisibilityPolicy,
			"triggerPolicy":    botAuth.Bot.TriggerPolicy,
		},
		"scopes":           botAuth.Scopes,
		"conversations":    convs,
		"recentDeliveries": deliveries,
	})
}

func (h *HTTPHandler) handleBotEditMessage(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	if err := botgateway.RequireScope(botAuth, botgateway.ScopeMessagesSend); err != nil {
		writeBotGatewayError(w, err)
		return
	}
	var body struct {
		PlainText       string `json:"plainText"`
		Content         any    `json:"content"`
		ExpectedVersion string `json:"expectedVersion"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, botgateway.CodeInvalidRequest, "请求参数无效")
		return
	}
	messageID := chi.URLParam(r, "messageId")
	if gateway, ok := h.botAuth.(*botgateway.Service); ok && botgateway.AgentTaskID(r.Context()) != "" {
		result, err := gateway.EditAgentMessage(r.Context(), botAuth, messageID, botgateway.AgentEditInput{Text: body.PlainText, Content: body.Content, ExpectedVersion: body.ExpectedVersion})
		if err != nil {
			writeBotGatewayError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	if err := h.service.EditMessage(r.Context(), botAuth.UserID, messageID, body.PlainText); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "messageId": messageID})
}

func randomBotClientMessageID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "botfile_fallback"
	}
	return "botfile_" + hex.EncodeToString(b[:])
}

func inferBotUploadMIMEType(rawHeader, rawQuery, fileName string) string {
	for _, candidate := range []string{rawQuery, rawHeader} {
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			continue
		}
		mediaType, _, err := mime.ParseMediaType(trimmed)
		if err == nil && mediaType != "" && mediaType != "application/octet-stream" {
			return strings.ToLower(mediaType)
		}
	}
	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(fileName)))
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".svg":
		return "image/svg+xml"
	case ".pdf":
		return "application/pdf"
	case ".md", ".markdown":
		return "text/markdown"
	case ".txt", ".log":
		return "text/plain"
	case ".json":
		return "application/json"
	case ".csv":
		return "text/csv"
	case ".html", ".htm":
		return "text/html"
	case ".zip":
		return "application/zip"
	}
	if ext != "" {
		if byExt := mime.TypeByExtension(ext); byExt != "" {
			if mediaType, _, err := mime.ParseMediaType(byExt); err == nil && mediaType != "" {
				return strings.ToLower(mediaType)
			}
		}
	}
	return "application/octet-stream"
}

func writeBotDomainError(w http.ResponseWriter, err error) {
	var taskError *botgateway.Error
	if errors.As(err, &taskError) {
		writeBotGatewayError(w, taskError)
		return
	}
	var fileErr *files.Error
	if errors.As(err, &fileErr) && fileErr != nil {
		status := fileErr.StatusCode
		if status < 400 || status >= 600 {
			status = http.StatusBadRequest
		}
		writeJSONError(w, status, fileErr.Code, fileErr.Message)
		return
	}
	var msgErr *messages.Error
	if errors.As(err, &msgErr) && msgErr != nil {
		status := msgErr.StatusCode
		if status < 400 || status >= 600 {
			status = http.StatusBadRequest
		}
		writeJSONError(w, status, msgErr.Code, msgErr.Message)
		return
	}
	writeServiceError(w, err)
}

func (h *HTTPHandler) handleBotCompleteUploadContent(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	if scopeErr := botgateway.RequireScope(botAuth, botgateway.ScopeFilesWrite); scopeErr != nil {
		writeBotGatewayError(w, scopeErr)
		return
	}
	if h.botFiles == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "v1.unavailable", "文件存储服务未就绪")
		return
	}
	uploadID := strings.TrimSpace(chi.URLParam(r, "uploadId"))
	if uploadID == "" {
		writeJSONError(w, http.StatusBadRequest, "upload.invalid", "上传标识无效")
		return
	}
	if r.ContentLength > MaxBotFileUploadBytes {
		h.releaseBotUpload(r, botAuth.UserID, uploadID)
		writeJSONError(w, http.StatusRequestEntityTooLarge, "file.too_large", "机器人单文件上传不能超过 50 MB")
		return
	}
	completed, err := h.botFiles.CompleteAgentBotUpload(r.Context(), files.CompleteUploadInput{
		FinalizeTransaction: h.agentFileFinalize(r, botAuth, uploadID),
		ActorID:             botAuth.UserID,
		UploadID:            uploadID,
		Mode:                "single",
		Content:             http.MaxBytesReader(w, r.Body, MaxBotFileUploadBytes),
	})
	if err != nil {
		h.releaseBotUpload(r, botAuth.UserID, uploadID)
		writeBotDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"upload":     completed,
		"attachment": completed.Attachment,
	})
}

func (h *HTTPHandler) handleBotSendConversationFile(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	sendMsgParam := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("sendMessage")))
	sendMessage := sendMsgParam != "false" && sendMsgParam != "0"
	if err := botgateway.RequireScope(botAuth, botgateway.ScopeFilesWrite); err != nil {
		writeBotGatewayError(w, err)
		return
	}

	if sendMessage {
		if err := botgateway.RequireScope(botAuth, botgateway.ScopeMessagesSend); err != nil {
			writeBotGatewayError(w, err)
			return
		}
	}

	if h.botFiles == nil || (sendMessage && h.botMessages == nil) {
		writeJSONError(w, http.StatusServiceUnavailable, "v1.unavailable", "机器人文件发送服务未就绪")
		return
	}

	conversationID := strings.TrimSpace(chi.URLParam(r, "conversationId"))
	if conversationID == "" {
		writeJSONError(w, http.StatusBadRequest, botgateway.CodeInvalidRequest, "会话 ID 不能为空")
		return
	}

	convs, err := h.service.ListBotConversations(r.Context(), botAuth.BotID, botAuth.UserID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	allowedConv := false
	for _, c := range convs {
		if c.ID == conversationID && c.AllowSend {
			allowedConv = true
			break
		}
	}
	if !allowedConv {
		writeJSONError(w, http.StatusForbidden, "conversation.forbidden", "当前机器人未被授权在该会话中发送文件")
		return
	}

	if r.ContentLength < 0 {
		writeJSONError(w, http.StatusLengthRequired, "file.length_required", "上传文件必须声明内容长度")
		return
	}
	if r.ContentLength == 0 {
		writeJSONError(w, http.StatusBadRequest, "file.empty", "上传文件内容不能为空")
		return
	}
	if r.ContentLength > MaxBotFileUploadBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "file.too_large", "机器人单文件上传不能超过 50 MB")
		return
	}

	fileName := strings.TrimSpace(r.URL.Query().Get("fileName"))
	if fileName == "" {
		fileName = strings.TrimSpace(r.Header.Get("X-File-Name"))
	}
	if fileName == "" {
		fileName = "attachment.bin"
	}
	mimeType := inferBotUploadMIMEType(
		r.Header.Get("Content-Type"),
		r.URL.Query().Get("mimeType"),
		fileName,
	)

	if gateway, ok := h.botAuth.(*botgateway.Service); ok {
		if err := gateway.ReserveAgentUploadBudget(r.Context(), botAuth, conversationID); err != nil {
			writeBotGatewayError(w, err)
			return
		}
	}
	reserved, err := h.botFiles.ReserveAgentBotUpload(r.Context(), files.ReserveUploadInput{
		ActorID:        botAuth.UserID,
		FileName:       fileName,
		MIMEType:       mimeType,
		ByteSize:       r.ContentLength,
		Visibility:     string(files.VisibilityConversation),
		ConversationID: conversationID,
	})
	if err != nil {
		writeBotDomainError(w, err)
		return
	}
	if reserved.Status != string(files.TransferReserved) || reserved.Upload == nil || reserved.Attachment == nil {
		writeJSONError(w, http.StatusTooManyRequests, "quota.insufficient", "今日空间文件传输配额不足")
		return
	}
	if gateway, ok := h.botAuth.(*botgateway.Service); ok {
		if err := gateway.BindAgentUpload(r.Context(), botAuth, reserved.Upload.ID, conversationID); err != nil {
			h.releaseBotUpload(r, botAuth.UserID, reserved.Upload.ID)
			writeBotGatewayError(w, err)
			return
		}
	}

	completed, err := h.botFiles.CompleteAgentBotUpload(r.Context(), files.CompleteUploadInput{
		FinalizeTransaction: h.agentFileFinalize(r, botAuth, reserved.Upload.ID),
		ActorID:             botAuth.UserID,
		UploadID:            reserved.Upload.ID,
		Mode:                "single",
		Content:             http.MaxBytesReader(w, r.Body, r.ContentLength+1),
	})
	if err != nil {
		h.releaseBotUpload(r, botAuth.UserID, reserved.Upload.ID)
		writeBotDomainError(w, err)
		return
	}
	att := completed.Attachment
	if att == nil {
		att = reserved.Attachment
	}

	if !sendMessage {
		writeJSON(w, http.StatusCreated, map[string]any{
			"ok":         true,
			"attachment": att,
		})
		return
	}

	caption := strings.TrimSpace(r.URL.Query().Get("text"))
	replyToID := strings.TrimSpace(r.URL.Query().Get("replyToMessageId"))
	clientMsgID := strings.TrimSpace(r.URL.Query().Get("clientMessageId"))
	if clientMsgID == "" {
		clientMsgID = randomBotClientMessageID()
	}

	blocks := make([]messages.Block, 0, 2)
	if caption != "" {
		blocks = append(blocks, messages.Block{Type: "text", Text: caption})
	}
	blocks = append(blocks, messages.Block{Type: "attachment", AttachmentID: att.ID})

	plainFallback := caption
	if plainFallback == "" {
		if strings.HasPrefix(att.MIMEType, "image/") {
			plainFallback = "[图片]"
		} else {
			plainFallback = "[文件] " + att.FileName
		}
	}

	if gateway, ok := h.botAuth.(*botgateway.Service); ok && botgateway.AgentTaskID(r.Context()) != "" {
		content := messages.Content{Format: messages.MessageContentFormat, PlainText: plainFallback, Blocks: blocks}
		result, sendErr := gateway.SendMessage(r.Context(), botAuth, botgateway.SendMessageInput{
			ConversationID: conversationID, ClientMessageID: clientMsgID, IdempotencyKey: clientMsgID,
			ReplyToMessageID: replyToID, Content: content,
		})
		if sendErr != nil {
			writeBotGatewayError(w, sendErr)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "attachment": att, "message": result.Message})
		return
	}
	createdMsg, err := h.botMessages.Create(r.Context(), messages.CreateInput{
		ActorID:          botAuth.UserID,
		ConversationID:   conversationID,
		ClientMessageID:  clientMsgID,
		ReplyToMessageID: replyToID,
		Content: messages.Content{
			Format:    messages.MessageContentFormat,
			PlainText: plainFallback,
			Blocks:    blocks,
		},
	})
	if err != nil {
		writeBotDomainError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":         true,
		"attachment": att,
		"message":    createdMsg,
	})
}

func (h *HTTPHandler) releaseBotUpload(r *http.Request, actorID, uploadID string) {
	if releaser, ok := h.botFiles.(botUploadFailureReleaser); ok {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		_, _ = releaser.FailAgentBotUpload(ctx, files.FailUploadInput{ActorID: actorID, UploadID: uploadID, Reason: "content_transfer_failed"})
	}
}

func (h *HTTPHandler) handleBotTyping(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	if err := botgateway.RequireScope(botAuth, botgateway.ScopeMessagesSend); err != nil {
		writeBotGatewayError(w, err)
		return
	}
	var body struct {
		ConversationID string `json:"conversationId"`
		State          string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ConversationID) == "" {
		writeJSONError(w, http.StatusBadRequest, botgateway.CodeInvalidRequest, "请求参数无效")
		return
	}
	if gateway, ok := h.botAuth.(*botgateway.Service); ok {
		if err := gateway.AuthorizeAgentOperation(r.Context(), botAuth, body.ConversationID); err != nil {
			writeBotGatewayError(w, err)
			return
		}
	}
	expiresAt, err := h.service.SendConversationTyping(r.Context(), botAuth.UserID, body.ConversationID, "bot", body.State)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accepted": true, "expiresAt": expiresAt, "expiresInMs": 6000})
}

func (h *HTTPHandler) handleBotUnbind(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	if err := h.service.UnbindBotSelf(r.Context(), botAuth.BotID, botAuth.TokenID); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revokedTokenId": botAuth.TokenID})
}

func (h *HTTPHandler) handleAckAnnouncement(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	if err := h.service.AckAnnouncement(r.Context(), actorFromContext(r.Context()).ID, body.ID); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *HTTPHandler) handleAdminGetAnnouncement(w http.ResponseWriter, r *http.Request) {
	ann, err := h.service.GetAdminAnnouncement(r.Context(), actorFromContext(r.Context()).ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"announcement": ann})
}

func (h *HTTPHandler) handleAdminUpdateAnnouncement(w http.ResponseWriter, r *http.Request) {
	var input SystemAnnouncementUpdateInput
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&input); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	ann, err := h.service.UpdateAdminAnnouncement(r.Context(), actorFromContext(r.Context()).ID, input)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"announcement": ann})
}

func (h *HTTPHandler) handleSendBindEmailCode(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	res, err := h.service.SendBindEmailCode(r.Context(), actorFromContext(r.Context()).ID, body.Email)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *HTTPHandler) handleVerifyBindEmail(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var body struct {
		ChallengeID string `json:"challengeId"`
		Code        string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	res, err := h.service.VerifyBindEmail(r.Context(), actorFromContext(r.Context()).ID, body.ChallengeID, body.Code)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *HTTPHandler) handleUnbindEmail(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if err := h.service.UnbindAccountEmail(r.Context(), actorFromContext(r.Context()).ID); err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *HTTPHandler) checkEmailAuthRateLimit(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	if h.sessions == nil {
		return true
	}
	allowed, err := h.sessions.CheckPublicAuthRateLimit(r.Context(), r)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "v1.internal", "服务器内部错误")
		return false
	}
	if !allowed {
		writeJSONError(w, http.StatusTooManyRequests, "v1.rate_limited", "请求过于频繁，请稍后再试")
		return false
	}
	return true
}

func (h *HTTPHandler) handleSendLoginEmailCode(w http.ResponseWriter, r *http.Request) {
	if !h.checkEmailAuthRateLimit(w, r) {
		return
	}
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	res, err := h.service.SendLoginEmailCode(r.Context(), body.Email)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *HTTPHandler) handleVerifyLoginEmail(w http.ResponseWriter, r *http.Request) {
	if !h.checkEmailAuthRateLimit(w, r) {
		return
	}
	if h.sessions == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "auth.unavailable", "认证服务未就绪")
		return
	}
	var body struct {
		Email       string `json:"email"`
		ChallengeID string `json:"challengeId"`
		Code        string `json:"code"`
		Client      string `json:"client"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	member, err := h.service.VerifyLoginEmail(r.Context(), body.Email, body.ChallengeID, body.Code)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if strings.EqualFold(strings.TrimSpace(body.Client), "mobile") {
		tokens, err := h.sessions.IssueMobileLoginSession(r.Context(), member.ID)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"user":                  member,
			"accessToken":           tokens.AccessToken,
			"refreshToken":          tokens.RefreshToken,
			"accessTokenExpiresAt":  tokens.AccessTokenExpiresAt,
			"refreshTokenExpiresAt": tokens.RefreshTokenExpiresAt,
		})
		return
	}
	expiresAt, err := h.sessions.IssueWebLoginSession(w, r, member.ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": member,
		"session": map[string]any{
			"expiresAt": expiresAt,
		},
	})
}

const githubFallbackLatestAPKURL = "https://github.com/timeStarry/duallane-mobile/releases/latest/download/app-release.apk"

func (h *HTTPHandler) handlePublicMobileNativePolicy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	policy, err := h.service.GetMobileNativePolicy(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

func (h *HTTPHandler) handlePublicMobileReleaseLatest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	rel, err := h.service.GetPublicMobileRelease(r.Context())
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSONError(w, http.StatusNotFound, "v1.release_not_published", "当前节点暂未托管移动端安装包")
			return
		}
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"release": rel})
}

func (h *HTTPHandler) handlePublicMobileDownloadAPK(w http.ResponseWriter, r *http.Request) {
	rel, body, err := h.service.OpenPublicMobileAPK(r.Context())
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, githubFallbackLatestAPKURL, http.StatusFound)
			return
		}
		writeServiceError(w, err)
		return
	}
	defer func() { _ = body.Close() }()

	etag := `"` + rel.SHA256 + `"`
	fileName := rel.FileName
	if fileName == "" {
		fileName = "duallane-latest.apk"
	}
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", `attachment; filename="`+fileName+`"`)
	w.Header().Set("Content-Length", strconv.FormatInt(rel.ByteSize, 10))
	w.Header().Set("ETag", etag)
	w.Header().Set("X-Content-SHA256", rel.SHA256)
	w.Header().Set("Cache-Control", "no-cache")

	if inm := strings.TrimSpace(r.Header.Get("If-None-Match")); inm != "" && inm == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, body)
}

func (h *HTTPHandler) handlePublicMobileDownloadOTA(w http.ResponseWriter, r *http.Request) {
	ota, body, err := h.service.OpenPublicMobileOTA(r.Context())
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSONError(w, http.StatusNotFound, "v1.ota_not_published", "当前节点暂无可用的前端热更资源包")
			return
		}
		writeServiceError(w, err)
		return
	}
	defer func() { _ = body.Close() }()

	etag := `"` + ota.SHA256 + `"`
	fileName := "duallane-ota-v" + ota.Version + "-" + ota.BundleID + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+fileName+`"`)
	w.Header().Set("Content-Length", strconv.FormatInt(ota.ByteSize, 10))
	w.Header().Set("ETag", etag)
	w.Header().Set("X-Content-SHA256", ota.SHA256)
	w.Header().Set("Cache-Control", "no-cache")

	if inm := strings.TrimSpace(r.Header.Get("If-None-Match")); inm != "" && inm == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, body)
}

func (h *HTTPHandler) handleAdminGetMobileRelease(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	rel, err := h.service.GetAdminMobileRelease(r.Context(), actorFromContext(r.Context()).ID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"release": rel})
}

func (h *HTTPHandler) handleAdminUpdateMobileRelease(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var input MobileClientReleaseMetadataInput
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&input); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	rel, err := h.service.UpdateAdminMobileRelease(r.Context(), actorFromContext(r.Context()).ID, input)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"release": rel})
}

func (h *HTTPHandler) handleAdminUploadMobileAPK(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	data, err := io.ReadAll(io.LimitReader(r.Body, MaxMobileAPKBytes+1024))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_body", "读取安装包数据失败")
		return
	}
	if int64(len(data)) > MaxMobileAPKBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "v1.apk_too_large", "APK 安装包大小不能超过 30 MB")
		return
	}
	overrideVersion := strings.TrimSpace(r.URL.Query().Get("version"))
	overrideCode, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("versionCode")))
	minNativeCode, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("minNativeVersionCode")))
	rel, err := h.service.UploadAdminMobileAPK(r.Context(), actorFromContext(r.Context()).ID, data, overrideVersion, overrideCode, minNativeCode)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"release": rel})
}

func (h *HTTPHandler) handleAdminUploadMobileOTA(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	data, err := io.ReadAll(io.LimitReader(r.Body, MaxMobileOTABytes+1024))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_body", "读取热更资源包失败")
		return
	}
	if int64(len(data)) > MaxMobileOTABytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "v1.ota_too_large", "热更资源包大小不能超过 15 MB")
		return
	}
	overrideVersion := strings.TrimSpace(r.URL.Query().Get("version"))
	minNativeCode, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("minNativeVersionCode")))
	rel, err := h.service.UploadAdminMobileOTA(r.Context(), actorFromContext(r.Context()).ID, data, overrideVersion, minNativeCode)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"release": rel})
}

func (h *HTTPHandler) handleBotUploadMobileAPK(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	ownerID := strings.TrimSpace(botAuth.OwnerUserID)
	if ownerID == "" {
		writeJSONError(w, http.StatusForbidden, "v1.forbidden", "仅空间创建者或管理员名下的机器人可执行分发")
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, MaxMobileAPKBytes+1024))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_body", "读取安装包数据失败")
		return
	}
	if int64(len(data)) > MaxMobileAPKBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "v1.apk_too_large", "APK 安装包大小不能超过 30 MB")
		return
	}
	overrideVersion := strings.TrimSpace(r.URL.Query().Get("version"))
	overrideCode, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("versionCode")))
	minNativeCode, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("minNativeVersionCode")))
	rel, err := h.service.UploadAdminMobileAPK(r.Context(), ownerID, data, overrideVersion, overrideCode, minNativeCode)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"release": rel})
}

func (h *HTTPHandler) handleBotUploadMobileOTA(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	ownerID := strings.TrimSpace(botAuth.OwnerUserID)
	if ownerID == "" {
		writeJSONError(w, http.StatusForbidden, "v1.forbidden", "仅空间创建者或管理员名下的机器人可执行分发")
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, MaxMobileOTABytes+1024))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_body", "读取热更资源包失败")
		return
	}
	if int64(len(data)) > MaxMobileOTABytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "v1.ota_too_large", "热更资源包大小不能超过 15 MB")
		return
	}
	overrideVersion := strings.TrimSpace(r.URL.Query().Get("version"))
	minNativeCode, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("minNativeVersionCode")))
	rel, err := h.service.UploadAdminMobileOTA(r.Context(), ownerID, data, overrideVersion, minNativeCode)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"release": rel})
}

func (h *HTTPHandler) handleBotUpdateMobileRelease(w http.ResponseWriter, r *http.Request) {
	botAuth, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	ownerID := strings.TrimSpace(botAuth.OwnerUserID)
	if ownerID == "" {
		writeJSONError(w, http.StatusForbidden, "v1.forbidden", "仅空间创建者或管理员名下的机器人可执行分发")
		return
	}
	var input MobileClientReleaseMetadataInput
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&input); err != nil {
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_json", "请求体格式错误")
		return
	}
	rel, err := h.service.UpdateAdminMobileRelease(r.Context(), ownerID, input)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"release": rel})
}

func cleanServiceErrMessage(err error, prefix string) string {
	msg := strings.TrimSpace(err.Error())
	msg = strings.TrimPrefix(msg, prefix+": ")
	msg = strings.TrimPrefix(msg, prefix)
	return strings.TrimSpace(msg)
}

func writeServiceError(w http.ResponseWriter, err error) {
	var emailErr *email.Error
	if errors.As(err, &emailErr) && emailErr != nil {
		status := emailErr.StatusCode
		if status <= 0 {
			status = http.StatusBadRequest
		}
		writeJSONError(w, status, emailErr.Code, emailErr.Message)
		return
	}
	var authErr *auth.Error
	if errors.As(err, &authErr) && authErr != nil {
		status := authErr.StatusCode
		if status <= 0 {
			status = http.StatusUnauthorized
		}
		writeJSONError(w, status, authErr.Code, authErr.Message)
		return
	}
	switch {
	case errors.Is(err, ErrForbidden):
		writeJSONError(w, http.StatusForbidden, "v1.forbidden", "无权限执行该操作")
	case errors.Is(err, ErrNotFound):
		writeJSONError(w, http.StatusNotFound, "v1.not_found", "目标不存在")
	case errors.Is(err, ErrRateLimited):
		msg := cleanServiceErrMessage(err, ErrRateLimited.Error())
		if msg == "" {
			msg = "请求过于频繁，请稍后再试"
		}
		writeJSONError(w, http.StatusTooManyRequests, "v1.rate_limited", msg)
	case errors.Is(err, ErrEmailAlreadyBound):
		writeJSONError(w, http.StatusConflict, "v1.email_already_bound", "该邮箱已被其他空间成员绑定")
	case errors.Is(err, ErrChallengeInvalid):
		writeJSONError(w, http.StatusBadRequest, "v1.challenge_invalid", "验证码错误或已失效，请重新获取")
	case errors.Is(err, ErrInvalidInput):
		msg := cleanServiceErrMessage(err, ErrInvalidInput.Error())
		if msg == "" {
			msg = "请求参数无效"
		}
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_input", msg)
	default:
		writeJSONError(w, http.StatusInternalServerError, "v1.internal", "服务器内部错误")
	}
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
