package httpapi

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

type fileService interface {
	ReserveUpload(context.Context, files.ReserveUploadInput) (files.UploadResult, error)
	GetUploadStatus(context.Context, files.UploadStatusInput) (files.UploadStatus, error)
	UploadPart(context.Context, files.UploadPartInput) (files.UploadPartResult, error)
	CompleteUpload(context.Context, files.CompleteUploadInput) (files.UploadResult, error)
	FailUpload(context.Context, files.FailUploadInput) (files.UploadResult, error)
	ListFiles(context.Context, files.ListFilesInput) ([]files.Attachment, error)
	RemoveAttachment(context.Context, files.RemoveAttachmentInput) (files.RemoveResult, error)
	ReserveDownload(context.Context, files.ReserveDownloadInput) (files.DownloadResult, error)
	ReleaseDownloadReservation(context.Context, files.ReleaseDownloadInput) (bool, error)
	GetDownloadableAttachment(context.Context, string, string, auth.RequestMeta) (files.Attachment, error)
	OpenAttachmentContent(context.Context, files.OpenAttachmentInput) (platformstorage.OpenedObject, error)
	OpenDownload(context.Context, files.CompletedDownloadInput) (platformstorage.OpenedObject, error)
}

type reserveUploadRequest struct {
	FileName       string `json:"fileName"`
	MIMEType       string `json:"mimeType"`
	ByteSize       int64  `json:"byteSize"`
	Visibility     string `json:"visibility"`
	ConversationID string `json:"conversationId"`
}

type completeUploadRequest struct {
	Mode string `json:"mode"`
}

type failUploadRequest struct {
	Reason string `json:"reason"`
}

type downloadReservation struct {
	Status          string `json:"status"`
	ID              string `json:"id,omitempty"`
	UsedToday       int64  `json:"usedToday"`
	RemainingBytes  int64  `json:"remainingBytes"`
	DailyQuotaBytes int64  `json:"dailyQuotaBytes"`
}

func registerFileRoutes(router chi.Router, options RouterOptions) {
	router.Post("/files/uploads/reserve", withActor(options, reserveFileUpload))
	router.Get("/files/uploads/{uploadId}", withActor(options, getFileUploadStatus))
	router.Put("/files/uploads/{uploadId}/parts/{partNumber}", withActor(options, uploadFilePart))
	router.Post("/files/uploads/{uploadId}/complete", withActor(options, completeFileUpload))
	router.Put("/files/uploads/{uploadId}/content", withActor(options, uploadFileContent))
	router.Post("/files/uploads/{uploadId}/fail", withActor(options, failFileUpload))
	router.Get("/files", withActor(options, listFiles))
	router.Delete("/files/{attachmentId}", withActor(options, removeFile))
	router.Post("/files/{attachmentId}/downloads/reserve", withActor(options, reserveFileDownload))
	router.Get("/files/{attachmentId}/preview", withActor(options, previewFile))
	router.Get("/files/{attachmentId}/download", withActor(options, downloadFile))
}

func reserveFileUpload(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) {
		return
	}
	var body reserveUploadRequest
	if !decodeBody(response, request, &body) {
		return
	}
	result, err := options.Files.ReserveUpload(request.Context(), files.ReserveUploadInput{
		ActorID: actor.ID, FileName: body.FileName, MIMEType: body.MIMEType, ByteSize: body.ByteSize,
		Visibility: body.Visibility, ConversationID: body.ConversationID, Meta: requestMeta(request, options),
	})
	status := http.StatusCreated
	if result.Status == string(files.TransferRejected) {
		status = http.StatusConflict
	}
	writeResult(response, status, result, err)
}

func getFileUploadStatus(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) {
		return
	}
	result, err := options.Files.GetUploadStatus(request.Context(), files.UploadStatusInput{
		ActorID: actor.ID, UploadID: chi.URLParam(request, "uploadId"), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, result, err)
}

func uploadFilePart(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) || !requireBinaryBody(response, request) {
		return
	}
	partNumber, _ := strconv.Atoi(chi.URLParam(request, "partNumber"))
	if request.ContentLength > files.UploadPartSize {
		writeError(response, &publicError{Code: "request.too_large", Message: "请求内容过大", StatusCode: http.StatusRequestEntityTooLarge})
		return
	}
	result, err := options.Files.UploadPart(request.Context(), files.UploadPartInput{
		ActorID: actor.ID, UploadID: chi.URLParam(request, "uploadId"), PartNumber: partNumber,
		Content: request.Body, ContentLength: request.ContentLength, SHA256: request.Header.Get("X-DualLane-Part-SHA256"),
		Meta: requestMeta(request, options),
	})
	status := http.StatusCreated
	if result.Reused {
		status = http.StatusOK
	}
	writeResult(response, status, map[string]any{"part": result}, err)
}

func completeFileUpload(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) {
		return
	}
	var body completeUploadRequest
	if !decodeBody(response, request, &body) {
		return
	}
	result, err := options.Files.CompleteUpload(request.Context(), files.CompleteUploadInput{
		ActorID: actor.ID, UploadID: chi.URLParam(request, "uploadId"), Mode: body.Mode, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, result, err)
}

func uploadFileContent(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) || !requireBinaryBody(response, request) {
		return
	}
	if request.ContentLength > files.UploadPartSize {
		writeError(response, &publicError{Code: "request.too_large", Message: "请求内容过大", StatusCode: http.StatusRequestEntityTooLarge})
		return
	}
	result, err := options.Files.CompleteUpload(request.Context(), files.CompleteUploadInput{
		ActorID: actor.ID, UploadID: chi.URLParam(request, "uploadId"), Mode: "single", Content: request.Body,
		Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, result, err)
}

func failFileUpload(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) {
		return
	}
	var body failUploadRequest
	if !decodeBody(response, request, &body) {
		return
	}
	result, err := options.Files.FailUpload(request.Context(), files.FailUploadInput{
		ActorID: actor.ID, UploadID: chi.URLParam(request, "uploadId"), Reason: body.Reason, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, result, err)
}

func listFiles(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) {
		return
	}
	query := request.URL.Query()
	result, err := options.Files.ListFiles(request.Context(), files.ListFilesInput{ActorID: actor.ID, Options: files.FileListOptions{
		Scope: query.Get("scope"), ConversationID: query.Get("conversationId"), UploaderID: query.Get("uploaderId"),
		Query: query.Get("q"), Limit: parseLimit(query.Get("limit")),
	}, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"files": result}, err)
}

func removeFile(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) {
		return
	}
	result, err := options.Files.RemoveAttachment(request.Context(), files.RemoveAttachmentInput{
		ActorID: actor.ID, AttachmentID: chi.URLParam(request, "attachmentId"), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, result, err)
}

func reserveFileDownload(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) {
		return
	}
	result, err := options.Files.ReserveDownload(request.Context(), files.ReserveDownloadInput{
		ActorID: actor.ID, AttachmentID: chi.URLParam(request, "attachmentId"), Meta: requestMeta(request, options),
	})
	status := http.StatusCreated
	if result.Status == string(files.TransferRejected) {
		status = http.StatusConflict
	}
	writeResult(response, status, publicDownloadReservation(result), err)
}

func previewFile(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) {
		return
	}
	attachmentID := chi.URLParam(request, "attachmentId")
	meta := requestMeta(request, options)
	attachment, err := options.Files.GetDownloadableAttachment(request.Context(), actor.ID, attachmentID, meta)
	if err != nil {
		writeError(response, err)
		return
	}
	if !previewableImageType(attachment.MIMEType) {
		writeError(response, files.NewError("file.preview_unsupported", "该文件不支持图片预览", http.StatusBadRequest))
		return
	}
	opened, err := options.Files.OpenAttachmentContent(request.Context(), files.OpenAttachmentInput{
		ActorID: actor.ID, AttachmentID: attachmentID, MaxBytes: platformstorage.DefaultMaxObjectBytes, Meta: meta,
	})
	if err != nil {
		writeError(response, err)
		return
	}
	writeBlob(response, opened, attachment.MIMEType, contentDisposition("inline", attachment.FileName), "private, no-store")
}

func downloadFile(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Files) {
		return
	}
	attachmentID := chi.URLParam(request, "attachmentId")
	meta := requestMeta(request, options)
	attachment, err := options.Files.GetDownloadableAttachment(request.Context(), actor.ID, attachmentID, meta)
	if err != nil {
		writeError(response, err)
		return
	}
	transferID := strings.TrimSpace(request.URL.Query().Get("downloadId"))
	if transferID == "" {
		reservation, reserveErr := options.Files.ReserveDownload(request.Context(), files.ReserveDownloadInput{
			ActorID: actor.ID, AttachmentID: attachmentID, Meta: meta,
		})
		if reserveErr != nil {
			writeError(response, reserveErr)
			return
		}
		if reservation.Status == string(files.TransferRejected) {
			writeJSON(response, http.StatusConflict, publicDownloadReservation(reservation))
			return
		}
		transferID = reservation.ID
	}
	opened, err := options.Files.OpenDownload(request.Context(), files.CompletedDownloadInput{
		ActorID: actor.ID, AttachmentID: attachmentID, TransferID: transferID,
		MaxBytes: platformstorage.DefaultMaxObjectBytes, Meta: meta,
	})
	if err != nil {
		_, _ = options.Files.ReleaseDownloadReservation(request.Context(), files.ReleaseDownloadInput{
			ActorID: actor.ID, TransferID: transferID, Meta: meta,
		})
		writeError(response, err)
		return
	}
	writeBlob(response, opened, nonEmpty(attachment.MIMEType, "application/octet-stream"), contentDisposition("attachment", attachment.FileName), "private, no-store")
}

func publicDownloadReservation(result files.DownloadResult) downloadReservation {
	return downloadReservation{Status: result.Status, ID: result.ID, UsedToday: result.UsedToday,
		RemainingBytes: result.RemainingBytes, DailyQuotaBytes: result.DailyQuotaBytes}
}

func requireBinaryBody(response http.ResponseWriter, request *http.Request) bool {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/octet-stream" {
		writeError(response, &publicError{Code: "request.unsupported_media_type", Message: "请求格式必须为二进制流", StatusCode: http.StatusUnsupportedMediaType})
		return false
	}
	return true
}

func previewableImageType(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp":
		return true
	default:
		return false
	}
}

func contentDisposition(disposition, fileName string) string {
	fileName = strings.ToValidUTF8(fileName, "_")
	var fallback strings.Builder
	for _, character := range fileName {
		if character < 0x20 || character > 0x7e || character == '"' || character == '\\' {
			fallback.WriteByte('_')
		} else {
			fallback.WriteRune(character)
		}
	}
	if fallback.Len() == 0 {
		fallback.WriteString("download")
	}
	header := fmt.Sprintf("%s; filename=\"%s\"", disposition, fallback.String())
	if fallback.String() == fileName && utf8.ValidString(fileName) {
		return header
	}
	return header + "; filename*=UTF-8''" + strings.ReplaceAll(url.QueryEscape(fileName), "+", "%20")
}

func writeBlob(response http.ResponseWriter, opened platformstorage.OpenedObject, contentType, disposition, cacheControl string) {
	defer opened.Body.Close()
	response.Header().Set("Content-Type", contentType)
	response.Header().Set("Content-Disposition", disposition)
	response.Header().Set("Cache-Control", cacheControl)
	response.Header().Set("Content-Length", strconv.FormatInt(opened.ByteSize, 10))
	response.WriteHeader(http.StatusOK)
	_, _ = io.Copy(response, opened.Body)
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
