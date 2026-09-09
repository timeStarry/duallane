package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type fakeFileRoutesService struct {
	reserveUploadInput  files.ReserveUploadInput
	uploadPartInput     files.UploadPartInput
	completeUploadInput files.CompleteUploadInput
	listInput           files.ListFilesInput
	reserveDownload     files.DownloadResult
	attachment          files.Attachment
	opened              platformstorage.OpenedObject
	openDownloadErr     error
	partBody            string
	reserveCalls        int
	previewCalls        int
	releaseCalls        int
}

func (service *fakeFileRoutesService) ReserveUpload(_ context.Context, input files.ReserveUploadInput) (files.UploadResult, error) {
	service.reserveUploadInput = input
	return files.UploadResult{Status: string(files.TransferReserved), ID: "upload-1", Upload: &files.UploadPlan{ID: "upload-1", Mode: "single", PartSize: files.UploadPartSize, PartCount: 1}}, nil
}

func (*fakeFileRoutesService) GetUploadStatus(_ context.Context, input files.UploadStatusInput) (files.UploadStatus, error) {
	return files.UploadStatus{UploadID: input.UploadID, Mode: "single", PartSize: files.UploadPartSize, PartCount: 1, Parts: []files.UploadPartRecord{}}, nil
}

func (service *fakeFileRoutesService) UploadPart(_ context.Context, input files.UploadPartInput) (files.UploadPartResult, error) {
	service.uploadPartInput = input
	body, err := io.ReadAll(input.Content)
	if err != nil {
		return files.UploadPartResult{}, err
	}
	service.partBody = string(body)
	return files.UploadPartResult{PartNumber: input.PartNumber, ByteSize: int64(len(body)), SHA256: input.SHA256}, nil
}

func (service *fakeFileRoutesService) CompleteUpload(_ context.Context, input files.CompleteUploadInput) (files.UploadResult, error) {
	service.completeUploadInput = input
	if input.Content != nil {
		_, _ = io.Copy(io.Discard, input.Content)
	}
	return files.UploadResult{Status: string(files.TransferCompleted), ID: input.UploadID}, nil
}

func (*fakeFileRoutesService) FailUpload(_ context.Context, input files.FailUploadInput) (files.UploadResult, error) {
	return files.UploadResult{Status: string(files.TransferFailed), ID: input.UploadID}, nil
}

func (service *fakeFileRoutesService) ListFiles(_ context.Context, input files.ListFilesInput) ([]files.Attachment, error) {
	service.listInput = input
	return []files.Attachment{}, nil
}

func (*fakeFileRoutesService) RemoveAttachment(_ context.Context, input files.RemoveAttachmentInput) (files.RemoveResult, error) {
	return files.RemoveResult{OK: true, AttachmentID: input.AttachmentID}, nil
}

func (service *fakeFileRoutesService) ReserveDownload(context.Context, files.ReserveDownloadInput) (files.DownloadResult, error) {
	service.reserveCalls++
	if service.reserveDownload.Status == "" {
		return files.DownloadResult{Status: string(files.TransferCompleted), ID: "download-1"}, nil
	}
	return service.reserveDownload, nil
}

func (service *fakeFileRoutesService) ReleaseDownloadReservation(context.Context, files.ReleaseDownloadInput) (bool, error) {
	service.releaseCalls++
	return true, nil
}

func (service *fakeFileRoutesService) GetDownloadableAttachment(context.Context, string, string, auth.RequestMeta) (files.Attachment, error) {
	return service.attachment, nil
}

func (service *fakeFileRoutesService) OpenAttachmentContent(context.Context, files.OpenAttachmentInput) (platformstorage.OpenedObject, error) {
	service.previewCalls++
	return service.opened, nil
}

func (service *fakeFileRoutesService) OpenDownload(context.Context, files.CompletedDownloadInput) (platformstorage.OpenedObject, error) {
	if service.openDownloadErr != nil {
		return platformstorage.OpenedObject{}, service.openDownloadErr
	}
	return service.opened, nil
}

func fileRoutesRouter(service *fakeFileRoutesService) http.Handler {
	return NewRouter(RouterOptions{
		Gate: gate.New("true"), ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "owner", Kind: "human", Role: "owner"}},
		Files: service, TrustProxy: true,
	})
}

func TestFileRoutesPreserveUploadContract(t *testing.T) {
	service := &fakeFileRoutesService{}
	router := fileRoutesRouter(service)

	request := httptest.NewRequest(http.MethodPost, "/api/workspace/files/uploads/reserve", strings.NewReader(`{"fileName":"report.txt","mimeType":"text/plain","byteSize":5,"visibility":"space"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "reserve-request")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || service.reserveUploadInput.FileName != "report.txt" || service.reserveUploadInput.Meta.RequestID != "reserve-request" {
		t.Fatalf("reserve status=%d input=%#v body=%s", response.Code, service.reserveUploadInput, response.Body.String())
	}

	partRequest := httptest.NewRequest(http.MethodPut, "/api/workspace/files/uploads/upload-1/parts/1", strings.NewReader("hello"))
	partRequest.Header.Set("Content-Type", "application/octet-stream")
	partRequest.Header.Set("X-DualLane-Part-SHA256", strings.Repeat("a", 64))
	partResponse := httptest.NewRecorder()
	router.ServeHTTP(partResponse, partRequest)
	if partResponse.Code != http.StatusCreated || service.uploadPartInput.PartNumber != 1 || service.uploadPartInput.ContentLength != 5 || service.partBody != "hello" {
		t.Fatalf("part status=%d input=%#v body=%q response=%s", partResponse.Code, service.uploadPartInput, service.partBody, partResponse.Body.String())
	}

	unsupported := httptest.NewRequest(http.MethodPut, "/api/workspace/files/uploads/upload-1/content", strings.NewReader("hello"))
	unsupported.Header.Set("Content-Type", "text/plain")
	unsupportedResponse := httptest.NewRecorder()
	router.ServeHTTP(unsupportedResponse, unsupported)
	if unsupportedResponse.Code != http.StatusUnsupportedMediaType || !strings.Contains(unsupportedResponse.Body.String(), "request.unsupported_media_type") {
		t.Fatalf("unsupported status=%d body=%s", unsupportedResponse.Code, unsupportedResponse.Body.String())
	}

	listResponse := httptest.NewRecorder()
	router.ServeHTTP(listResponse, httptest.NewRequest(http.MethodGet, "/api/workspace/files?scope=mine&q=report&limit=12", nil))
	if listResponse.Code != http.StatusOK || service.listInput.Options.Scope != "mine" || service.listInput.Options.Query != "report" || service.listInput.Options.Limit != 12 {
		t.Fatalf("list status=%d input=%#v body=%s", listResponse.Code, service.listInput, listResponse.Body.String())
	}
}

func TestFilePreviewAndDownloadKeepPrivateDeliverySemantics(t *testing.T) {
	service := &fakeFileRoutesService{
		attachment: files.Attachment{ID: "attachment-1", FileName: "头像 图片.png", MIMEType: "image/png"},
		opened:     platformstorage.OpenedObject{Object: platformstorage.Object{ByteSize: 3}, Body: io.NopCloser(strings.NewReader("png"))},
	}
	router := fileRoutesRouter(service)
	preview := httptest.NewRecorder()
	router.ServeHTTP(preview, httptest.NewRequest(http.MethodGet, "/api/workspace/files/attachment-1/preview", nil))
	if preview.Code != http.StatusOK || preview.Body.String() != "png" || service.previewCalls != 1 || service.reserveCalls != 0 {
		t.Fatalf("preview status=%d calls=%d/%d body=%q", preview.Code, service.previewCalls, service.reserveCalls, preview.Body.String())
	}
	wantDisposition := "inline; filename=\"__ __.png\"; filename*=UTF-8''%E5%A4%B4%E5%83%8F%20%E5%9B%BE%E7%89%87.png"
	if preview.Header().Get("Content-Disposition") != wantDisposition || preview.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("preview headers = %#v", preview.Header())
	}

	service.opened = platformstorage.OpenedObject{Object: platformstorage.Object{ByteSize: 4}, Body: io.NopCloser(strings.NewReader("file"))}
	download := httptest.NewRecorder()
	router.ServeHTTP(download, httptest.NewRequest(http.MethodGet, "/api/workspace/files/attachment-1/download", nil))
	if download.Code != http.StatusOK || download.Body.String() != "file" || service.reserveCalls != 1 {
		t.Fatalf("download status=%d reserves=%d body=%q", download.Code, service.reserveCalls, download.Body.String())
	}
}

func TestFileDownloadFailureReleasesReservationAndHidesAttachment(t *testing.T) {
	service := &fakeFileRoutesService{
		reserveDownload: files.DownloadResult{Status: string(files.TransferCompleted), ID: "download-1", Attachment: &files.Attachment{ID: "private"}},
		attachment:      files.Attachment{ID: "attachment-1", FileName: "report.txt", MIMEType: "text/plain"},
		openDownloadErr: files.NewError(files.CodeFileStorageMissing, files.MessageFileStorageMissing, http.StatusNotFound),
	}
	router := fileRoutesRouter(service)

	reserve := httptest.NewRecorder()
	router.ServeHTTP(reserve, httptest.NewRequest(http.MethodPost, "/api/workspace/files/attachment-1/downloads/reserve", strings.NewReader(`{}`)))
	if reserve.Code != http.StatusCreated || strings.Contains(reserve.Body.String(), "private") || strings.Contains(reserve.Body.String(), "attachment") {
		t.Fatalf("reserve status=%d body=%s", reserve.Code, reserve.Body.String())
	}

	download := httptest.NewRecorder()
	router.ServeHTTP(download, httptest.NewRequest(http.MethodGet, "/api/workspace/files/attachment-1/download?downloadId=download-1", nil))
	if download.Code != http.StatusNotFound || service.releaseCalls != 1 || !strings.Contains(download.Body.String(), files.CodeFileStorageMissing) {
		t.Fatalf("download status=%d releases=%d body=%s", download.Code, service.releaseCalls, download.Body.String())
	}
}

func TestFileRouteMapsDomainErrors(t *testing.T) {
	service := &fakeFileRoutesService{
		attachment:      files.Attachment{ID: "attachment-1", FileName: "report.txt", MIMEType: "text/plain"},
		openDownloadErr: errors.New("private provider failure"),
	}
	response := httptest.NewRecorder()
	fileRoutesRouter(service).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/files/attachment-1/download?downloadId=download-1", nil))
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "provider") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
