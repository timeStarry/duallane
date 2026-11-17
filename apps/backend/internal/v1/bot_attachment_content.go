package v1

import (
	"context"
	"io"
	"mime"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

type botAttachmentAuthorizer interface {
	AuthorizeAttachmentRead(context.Context, *botgateway.Auth, botgateway.AttachmentReadInput) (botgateway.Attachment, error)
}

type botAttachmentReader interface {
	OpenAgentBotAttachmentContent(context.Context, files.OpenAttachmentInput) (platformstorage.OpenedObject, error)
}

type botUploadStatusReader interface {
	GetAgentBotUploadStatus(context.Context, files.UploadStatusInput) (files.UploadStatus, error)
}

func (h *HTTPHandler) handleBotUploadStatus(w http.ResponseWriter, r *http.Request) {
	current, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	if err := botgateway.RequireScope(current, botgateway.ScopeFilesWrite); err != nil {
		writeBotGatewayError(w, err)
		return
	}
	reader, ok := h.botFiles.(botUploadStatusReader)
	if !ok {
		writeJSONError(w, http.StatusServiceUnavailable, "v1.unavailable", "文件服务未就绪")
		return
	}
	status, err := reader.GetAgentBotUploadStatus(r.Context(), files.UploadStatusInput{ActorID: current.UserID, UploadID: chi.URLParam(r, "uploadId")})
	if err != nil {
		writeBotDomainError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"upload": status})
}

func (h *HTTPHandler) handleBotAttachmentContent(w http.ResponseWriter, r *http.Request) {
	current, ok := h.authenticateBotRequest(w, r)
	if !ok {
		return
	}
	authorizer, authOK := h.botAuth.(botAttachmentAuthorizer)
	reader, readOK := h.botFiles.(botAttachmentReader)
	if !authOK || !readOK {
		writeJSONError(w, http.StatusServiceUnavailable, "v1.unavailable", "文件读取服务未就绪")
		return
	}
	input := botgateway.AttachmentReadInput{ConversationID: chi.URLParam(r, "conversationId"), AttachmentID: chi.URLParam(r, "attachmentId"), MessageID: r.URL.Query().Get("messageId"), Mode: r.URL.Query().Get("mode")}
	attachment, err := authorizer.AuthorizeAttachmentRead(r.Context(), current, input)
	if err != nil {
		writeBotGatewayError(w, err)
		return
	}
	limit := botgateway.MaxAgentAttachmentContentBytes
	if input.Mode == "preview" {
		limit = botgateway.MaxAgentAttachmentPreviewBytes
	}
	opened, err := reader.OpenAgentBotAttachmentContent(r.Context(), files.OpenAttachmentInput{ActorID: current.UserID, AttachmentID: attachment.ID, MaxBytes: limit})
	if err != nil {
		writeBotDomainError(w, err)
		return
	}
	defer opened.Body.Close()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", attachment.MIMEType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": attachment.FileName}))
	w.Header().Set("Content-Length", strconv.FormatInt(opened.ByteSize, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, io.LimitReader(opened.Body, limit))
}
