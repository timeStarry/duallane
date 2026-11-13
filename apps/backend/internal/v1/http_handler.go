package v1

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type ActorResolver interface {
	ResolveActor(context.Context, *http.Request) (*auth.Actor, error)
}

type HTTPHandler struct {
	service  *Service
	resolver ActorResolver
}

func NewHTTPHandler(service *Service, resolver ActorResolver) *HTTPHandler {
	return &HTTPHandler{service: service, resolver: resolver}
}

func (h *HTTPHandler) Mount(r chi.Router) {
	r.Route("/api/v1", func(r chi.Router) {
		r.Post("/auth/qr/start", h.handleQRStart)
		r.Post("/auth/qr/{sessionId}/exchange", h.handleQRExchange)

		r.Group(func(r chi.Router) {
			r.Use(h.requireActor)
			r.Get("/sync", h.handleSync)
			r.Get("/search", h.handleSearch)
			r.Post("/conversations/saved", h.handleSavedConversation)
			r.Post("/conversations/{conversationId}/pins/{messageId}", h.handlePin)
			r.Delete("/conversations/{conversationId}/pins/{messageId}", h.handleUnpin)
			r.Patch("/messages/{messageId}", h.handleEditMessage)
			r.Post("/messages/forward", h.handleForwardMessages)
			r.Get("/messages/{messageId}/thread", h.handleGetThread)
			r.Post("/messages/{messageId}/thread", h.handleReplyThread)
			r.Get("/devices", h.handleListDevices)
			r.Delete("/devices/{deviceId}", h.handleRevokeDevice)
			r.Post("/auth/qr/{sessionId}/approve", h.handleQRApprove)
			r.Get("/preferences", h.handleGetPreferences)
			r.Put("/preferences", h.handleSavePreferences)
			r.Post("/bots", h.handleCreateBot)
			r.Get("/bots/{botId}/commands", h.handleListBotCommandsByBot)
			r.Put("/bots/{botId}/commands", h.handleRegisterBotCommands)
			r.Get("/conversations/{conversationId}/bot-commands", h.handleListBotCommands)
			r.Put("/bots/{botId}/webhook", h.handleUpsertBotWebhook)
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
	q := r.URL.Query().Get("q")
	scope := r.URL.Query().Get("scope")
	res, err := h.service.Search(r.Context(), actorFromContext(r.Context()).ID, q, scope)
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
	cmds, err := h.service.ListBotCommands(r.Context(), chi.URLParam(r, "conversationId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": cmds})
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

func writeServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeJSONError(w, http.StatusForbidden, "v1.forbidden", "无权限执行该操作")
	case errors.Is(err, ErrNotFound):
		writeJSONError(w, http.StatusNotFound, "v1.not_found", "目标不存在")
	case errors.Is(err, ErrInvalidInput):
		writeJSONError(w, http.StatusBadRequest, "v1.invalid_input", err.Error())
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
