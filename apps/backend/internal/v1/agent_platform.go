package v1

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

func (h *HTTPHandler) agentFileFinalize(r *http.Request, value *botgateway.Auth, uploadID string) files.FinalizeTransaction {
	if gateway, ok := h.botAuth.(*botgateway.Service); ok {
		return gateway.AgentFileFinalizeTransaction(r.Context(), value, uploadID)
	}
	return nil
}

func (h *HTTPHandler) agentGateway(w http.ResponseWriter) (*botgateway.Service, bool) {
	gateway, ok := h.botAuth.(*botgateway.Service)
	if !ok || gateway == nil {
		writeJSONError(w, 503, "task.unavailable", "任务服务尚未就绪")
		return nil, false
	}
	return gateway, true
}

func (h *HTTPHandler) authorizeAgentHTTP(w http.ResponseWriter, r *http.Request, value *botgateway.Auth, gateway *botgateway.Service) bool {
	path := r.URL.Path
	if path == "/api/bot/v2/capabilities" || path == "/api/bot/v2/tasks" || strings.HasPrefix(path, "/api/bot/v2/tasks/") {
		return true
	}
	if botgateway.AgentTaskID(r.Context()) != "" {
		if path == "/api/bot/v2/doctor" || path == "/api/bot/v2/unbind" || strings.HasPrefix(path, "/api/bot/v2/mobile-release") {
			writeJSONError(w, 403, "task.operation_forbidden", "会话任务不能修改运行配置或发布应用")
			return false
		}
	}
	// Discovery is not a content grant. Its scoped response is filtered below.
	if path == "/api/bot/v2/conversations" || path == "/api/bot/v2/doctor" {
		return true
	}
	if err := gateway.AuthorizeAgentOperation(r.Context(), value, chi.URLParam(r, "conversationId")); err != nil {
		writeBotGatewayError(w, err)
		return false
	}
	if id := chi.URLParam(r, "messageId"); id != "" && r.Method == http.MethodPatch {
		if err := gateway.AuthorizeAgentMessageMutation(r.Context(), value, id); err != nil {
			writeBotGatewayError(w, err)
			return false
		}
	}
	if id := chi.URLParam(r, "uploadId"); id != "" {
		if err := gateway.AuthorizeAgentUpload(r.Context(), value, id); err != nil {
			writeBotGatewayError(w, err)
			return false
		}
	}
	return true
}

func (h *HTTPHandler) handleAgentCapabilities(w http.ResponseWriter, r *http.Request) {
	value, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	gateway, ok := h.agentGateway(w)
	if !ok {
		return
	}
	result, err := gateway.AgentCapabilities(r.Context(), value, r.URL.Query().Get("conversationId"))
	if err != nil {
		writeBotGatewayError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (h *HTTPHandler) handleCreateAgentTask(w http.ResponseWriter, r *http.Request) {
	value, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	gateway, ok := h.agentGateway(w)
	if !ok {
		return
	}
	var input struct {
		EventID string `json:"eventId"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeJSONError(w, 400, botgateway.CodeInvalidRequest, "任务请求无效")
		return
	}
	result, err := gateway.CreateAgentTask(r.Context(), value, input.EventID)
	if err != nil {
		writeBotGatewayError(w, err)
		return
	}
	writeJSON(w, 201, result)
}

func (h *HTTPHandler) handleGetAgentTask(w http.ResponseWriter, r *http.Request) {
	value, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	gateway, ok := h.agentGateway(w)
	if !ok {
		return
	}
	id := chi.URLParam(r, "taskId")
	if scoped := botgateway.AgentTaskID(r.Context()); scoped != "" && scoped != id {
		writeJSONError(w, 403, "task.operation_forbidden", "任务引用不匹配")
		return
	}
	var result map[string]any
	var err error
	if r.Method == http.MethodDelete {
		result, err = gateway.CancelAgentTask(r.Context(), value, id)
	} else {
		result, err = gateway.GetAgentTask(r.Context(), value, id)
	}
	if err != nil {
		writeBotGatewayError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (h *HTTPHandler) handleAgentHistory(w http.ResponseWriter, r *http.Request) {
	value, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	gateway, ok := h.agentGateway(w)
	if !ok {
		return
	}
	options := make(map[string]any)
	for _, key := range []string{"before", "limit", "query", "authorId", "startTime", "endTime"} {
		if raw := r.URL.Query().Get(key); raw != "" {
			options[key] = raw
		}
	}
	result, err := gateway.ListAgentHistory(r.Context(), value, chi.URLParam(r, "conversationId"), options)
	if err != nil {
		writeBotGatewayError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (h *HTTPHandler) handleGetAgentMessage(w http.ResponseWriter, r *http.Request) {
	value, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	gateway, ok := h.agentGateway(w)
	if !ok {
		return
	}
	result, err := gateway.GetAgentMessage(r.Context(), value, chi.URLParam(r, "messageId"))
	if err != nil {
		writeBotGatewayError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (h *HTTPHandler) handleAgentMembers(w http.ResponseWriter, r *http.Request) {
	value, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	gateway, ok := h.agentGateway(w)
	if !ok {
		return
	}
	result, err := gateway.ListAgentMembers(r.Context(), value, chi.URLParam(r, "conversationId"))
	if err != nil {
		writeBotGatewayError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (h *HTTPHandler) handleAgentOperation(w http.ResponseWriter, r *http.Request) {
	value, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	gateway, ok := h.agentGateway(w)
	if !ok {
		return
	}
	result, err := gateway.GetAgentOperation(r.Context(), value, chi.URLParam(r, "taskId"), chi.URLParam(r, "operation"), chi.URLParam(r, "key"))
	if err != nil {
		writeBotGatewayError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
