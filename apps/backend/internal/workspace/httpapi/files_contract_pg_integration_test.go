//go:build postgres_integration

package httpapi

import (
	"net/http"
	"strings"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

func TestWorkspaceFilesContractPGUsesRealServiceAndKeepsRejectionsContentFree(t *testing.T) {
	database := newContractPGDatabase(t)
	idFactory := contractPGIDFactory("contract-files")
	repository := files.NewPGRepository(database.pool, idFactory)
	blobStore, err := platformstorage.NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := files.NewService(files.ServiceOptions{
		Repository:      repository,
		BlobStore:       blobStore,
		SpaceID:         contractPGSpaceID,
		Now:             func() time.Time { return database.now },
		IDFactory:       idFactory,
		DailyQuotaBytes: files.DailyQuotaBytes,
	})
	router := database.router(RouterOptions{Files: service})

	unauthenticated := contractPGJSON(database, router, http.MethodGet, "/api/workspace/files", "", "", "files-auth-required")
	if unauthenticated.Code != http.StatusUnauthorized || contractPGErrorCode(t, unauthenticated) != "auth.required" {
		t.Fatalf("unauthenticated files list status=%d body=%s", unauthenticated.Code, unauthenticated.Body.String())
	}

	reserve := contractPGJSON(database, router, http.MethodPost, "/api/workspace/files/uploads/reserve", `{"fileName":"contract.txt","mimeType":"text/plain","byteSize":5,"visibility":"space"}`, contractPGOwnerID, "files-reserve")
	if reserve.Code != http.StatusCreated {
		t.Fatalf("reserve status=%d body=%s", reserve.Code, reserve.Body.String())
	}
	var reserved struct {
		Status     string `json:"status"`
		ID         string `json:"id"`
		Attachment struct {
			ID             string  `json:"id"`
			ConversationID *string `json:"conversationId"`
			CompletedAt    *string `json:"completedAt"`
			AvailableAt    *string `json:"availableAt"`
			Status         string  `json:"status"`
		} `json:"attachment"`
		Upload struct {
			ID        string `json:"id"`
			Mode      string `json:"mode"`
			PartCount int    `json:"partCount"`
		} `json:"upload"`
	}
	contractPGDecode(t, reserve, &reserved)
	if reserved.Status != string(files.TransferReserved) || reserved.ID == "" || reserved.ID != reserved.Upload.ID || reserved.Attachment.ID == "" || reserved.Attachment.Status != string(files.AttachmentPending) || reserved.Upload.Mode != "single" || reserved.Upload.PartCount != 1 {
		t.Fatalf("reserved response=%#v", reserved)
	}
	if reserved.Attachment.ConversationID != nil || reserved.Attachment.CompletedAt != nil || reserved.Attachment.AvailableAt != nil {
		t.Fatalf("reserved null projection=%#v", reserved.Attachment)
	}
	contractPGAssertBodyExcludes(t, reserve, "storageKey", "transferId", "uploadTransferId")

	contentRequest := contractPGRequest(http.MethodPut, "/api/workspace/files/uploads/"+reserved.ID+"/content", "hello", contractPGOwnerID, "application/octet-stream", "files-complete")
	complete := contractPGServe(database, router, contentRequest)
	if complete.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", complete.Code, complete.Body.String())
	}
	var completed struct {
		Status     string `json:"status"`
		Attachment struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"attachment"`
	}
	contractPGDecode(t, complete, &completed)
	if completed.Status != string(files.TransferCompleted) || completed.Attachment.ID != reserved.Attachment.ID || completed.Attachment.Status != string(files.AttachmentAvailable) {
		t.Fatalf("completed response=%#v", completed)
	}
	contractPGAssertBodyExcludes(t, complete, "storageKey", "transferId", "uploadTransferId")

	list := contractPGJSON(database, router, http.MethodGet, "/api/workspace/files?scope=all&limit=5", "", contractPGOwnerID, "files-list")
	if list.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	var listed struct {
		Files []files.Attachment `json:"files"`
	}
	contractPGDecode(t, list, &listed)
	if len(listed.Files) != 1 || listed.Files[0].ID != reserved.Attachment.ID || listed.Files[0].ConversationID != nil {
		t.Fatalf("listed files=%#v", listed.Files)
	}
	contractPGAssertBodyExcludes(t, list, "storageKey", "transferId", "uploadTransferId")

	auditorList := contractPGJSON(database, router, http.MethodGet, "/api/workspace/files", "", contractPGAuditorID, "files-auditor-denied")
	if auditorList.Code != http.StatusForbidden || contractPGErrorCode(t, auditorList) != files.CodePermissionDenied {
		t.Fatalf("auditor list status=%d body=%s", auditorList.Code, auditorList.Body.String())
	}
	contractPGAssertBodyExcludes(t, auditorList, reserved.Attachment.ID, "contract.txt")
	auditorAudit := contractPGAuditByRequest(t, database, "files-auditor-denied")
	if auditorAudit.Action != "file.download" || auditorAudit.TargetType != "workspace" || auditorAudit.TargetID != "" || auditorAudit.Result != "rejected" || auditorAudit.Reason != "insufficient permission" {
		t.Fatalf("auditor audit=%#v", auditorAudit)
	}

	missing := contractPGServe(database, router, contractPGRequest(http.MethodGet, "/api/workspace/files/missing-contract/download", "", contractPGOwnerID, "", "files-missing"))
	if missing.Code != http.StatusBadRequest || contractPGErrorCode(t, missing) != files.CodeFileNotFound {
		t.Fatalf("missing file status=%d body=%s", missing.Code, missing.Body.String())
	}
	contractPGAssertBodyExcludes(t, missing, "missing-contract", "contract.txt")

	quotaService := files.NewService(files.ServiceOptions{
		Repository:      repository,
		BlobStore:       blobStore,
		SpaceID:         contractPGSpaceID,
		Now:             func() time.Time { return database.now },
		IDFactory:       contractPGIDFactory("contract-files-overage"),
		DailyQuotaBytes: 4,
	})
	quotaRouter := database.router(RouterOptions{Files: quotaService})
	overage := contractPGJSON(database, quotaRouter, http.MethodPost, "/api/workspace/files/uploads/reserve", `{"fileName":"overage.txt","mimeType":"text/plain","byteSize":1,"visibility":"space"}`, contractPGOwnerID, "files-overage")
	if overage.Code != http.StatusConflict {
		t.Fatalf("overage status=%d body=%s", overage.Code, overage.Body.String())
	}
	var overagePayload map[string]any
	contractPGDecode(t, overage, &overagePayload)
	if overagePayload["status"] != string(files.TransferRejected) {
		t.Fatalf("overage payload=%#v", overagePayload)
	}
	if _, ok := overagePayload["id"]; ok {
		t.Fatalf("overage exposed transfer id: %#v", overagePayload)
	}
	contractPGAssertBodyExcludes(t, overage, "overage.txt", "transferId")

	var transferStatus, rejectionPayload string
	if err := database.pool.QueryRow(database.ctx, `
		SELECT transfer.status, COALESCE(event.payload_json, '')
		FROM transfer_ledger AS transfer
		LEFT JOIN workspace_events AS event
			ON event.type = 'transfer.rejected' AND event.target_id = transfer.id
		WHERE transfer.user_id = $1 AND transfer.direction = 'upload' AND transfer.status = 'rejected'
		ORDER BY transfer.created_at DESC, transfer.id DESC
		LIMIT 1
	`, contractPGOwnerID).Scan(&transferStatus, &rejectionPayload); err != nil {
		t.Fatal(err)
	}
	if transferStatus != string(files.TransferRejected) || !strings.Contains(rejectionPayload, files.CodeQuotaInsufficient) || strings.Contains(rejectionPayload, "overage.txt") {
		t.Fatalf("quota rejection evidence status=%q payload=%q", transferStatus, rejectionPayload)
	}
	overageAudit := contractPGAuditByRequest(t, database, "files-overage")
	if overageAudit.Action != "file.upload.rejected" || overageAudit.TargetType != "transfer" || overageAudit.TargetID == "" || overageAudit.Result != "rejected" || overageAudit.Reason != "insufficient daily quota" {
		t.Fatalf("overage audit=%#v", overageAudit)
	}
	var overageAttachments int
	if err := database.pool.QueryRow(database.ctx, `SELECT COUNT(*) FROM attachments WHERE file_name = 'overage.txt'`).Scan(&overageAttachments); err != nil {
		t.Fatal(err)
	}
	if overageAttachments != 0 {
		t.Fatalf("overage created %d attachment rows", overageAttachments)
	}

	reserveAudit := contractPGAuditByRequest(t, database, "files-reserve")
	if reserveAudit.Action != "file.upload.reserve" || reserveAudit.TargetType != "attachment" || reserveAudit.TargetID != reserved.Attachment.ID || reserveAudit.Result != "success" || reserveAudit.Reason != "" {
		t.Fatalf("reserve audit=%#v", reserveAudit)
	}
	completeAudit := contractPGAuditByRequest(t, database, "files-complete")
	if completeAudit.Action != "file.upload.completed" || completeAudit.TargetType != "attachment" || completeAudit.TargetID != reserved.Attachment.ID || completeAudit.Result != "success" || completeAudit.Reason != "" {
		t.Fatalf("complete audit=%#v", completeAudit)
	}
}
