package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type completionRacingStatusRepository struct {
	*fakeFileRepo
	transferReads int
}

func (r *completionRacingStatusRepository) GetTransfer(ctx context.Context, spaceID, userID, uploadID string, direction TransferDirection) (*TransferRecord, error) {
	transfer, err := r.fakeFileRepo.GetTransfer(ctx, spaceID, userID, uploadID, direction)
	r.transferReads++
	if err == nil && transfer != nil && r.transferReads == 1 {
		transfer.Status = "reserved"
	}
	return transfer, err
}

func TestUploadStatusHandlesCompletionBetweenMetadataReads(t *testing.T) {
	repo := newFakeFileRepo()
	service := testService(t, repo, nil)
	attachmentID := "attachment-owned"
	repo.state.transfers["upload-owned"] = &TransferRecord{ID: "upload-owned", SpaceID: DefaultSpaceID, UserID: "usr_owner", Direction: "upload", Status: "completed", AttachmentID: &attachmentID, ByteSize: 7}
	repo.state.attachments[attachmentID] = &AttachmentRecord{ID: attachmentID, SpaceID: DefaultSpaceID, UploaderID: "usr_owner", UploadTransferID: "upload-owned", Status: "available", Visibility: "private_staging", ByteSize: 7}
	racing := &completionRacingStatusRepository{fakeFileRepo: repo}
	service.repo = racing
	result, err := service.GetUploadStatus(context.Background(), UploadStatusInput{ActorID: "usr_owner", UploadID: "upload-owned"})
	if err != nil || result.Status != "completed" || result.Attachment == nil || racing.transferReads != 2 {
		t.Fatalf("completion race = %#v, reads=%d, err=%v", result, racing.transferReads, err)
	}
}

func TestUploadStatusRecoversLostCompletionResponse(t *testing.T) {
	for _, mode := range []string{"single", "chunked"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			store, err := platformstorage.NewLocalBlobStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			repo := newFakeFileRepo()
			service := testService(t, repo, store)
			size := int64(7)
			if mode == "chunked" {
				size = UploadPartSize + 1
			}
			reserved, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_owner", FileName: "retry.bin", MIMEType: "application/octet-stream", ByteSize: size})
			if err != nil {
				t.Fatal(err)
			}
			pending, err := service.GetUploadStatus(ctx, UploadStatusInput{ActorID: "usr_owner", UploadID: reserved.ID})
			if err != nil || pending.Status != "reserved" || pending.Attachment != nil || pending.Mode != mode {
				t.Fatalf("pending status = %#v, %v", pending, err)
			}
			var completed UploadResult
			if mode == "single" {
				completed, err = service.UploadContent(ctx, "usr_owner", reserved.ID, strings.NewReader("content"), auth.RequestMeta{})
			} else {
				for i, content := range []string{strings.Repeat("a", int(UploadPartSize)), "b"} {
					digest := sha256.Sum256([]byte(content))
					if _, err = service.UploadPart(ctx, UploadPartInput{ActorID: "usr_owner", UploadID: reserved.ID, PartNumber: i + 1, Content: strings.NewReader(content), ContentLength: int64(len(content)), SHA256: hex.EncodeToString(digest[:])}); err != nil {
						t.Fatal(err)
					}
				}
				completed, err = service.CompleteUpload(ctx, CompleteUploadInput{ActorID: "usr_owner", UploadID: reserved.ID, Mode: "chunked"})
			}
			if err != nil {
				t.Fatal(err)
			}
			before := repo.state.clone()
			for i := 0; i < 2; i++ {
				recovered, err := service.GetUploadStatus(ctx, UploadStatusInput{ActorID: "usr_owner", UploadID: reserved.ID})
				if err != nil || recovered.Status != "completed" || recovered.UploadID != reserved.ID || recovered.Mode != mode || recovered.PartCount != reserved.Upload.PartCount || recovered.PartSize != reserved.Upload.PartSize || recovered.Parts == nil || len(recovered.Parts) != 0 || !reflect.DeepEqual(recovered.Attachment, completed.Attachment) {
					t.Fatalf("recovered status = %#v, err=%v", recovered, err)
				}
				encoded, err := json.Marshal(recovered)
				if err != nil {
					t.Fatal(err)
				}
				for _, private := range []string{"storageObjectId", "storageKey", "objectKey", "SHA256", "sha256"} {
					if strings.Contains(string(encoded), private) {
						t.Fatalf("status leaked %q: %s", private, encoded)
					}
				}
			}
			if !reflect.DeepEqual(before, repo.state) {
				t.Fatal("status recovery mutated transfer quota, records, events or audit")
			}
			if _, err := service.UploadContent(ctx, "usr_owner", reserved.ID, strings.NewReader("content"), auth.RequestMeta{}); errorCode(err) != CodeUploadInvalid {
				t.Fatalf("completed PUT was reopened: %v", err)
			}
			if _, err := service.CompleteUpload(ctx, CompleteUploadInput{ActorID: "usr_owner", UploadID: reserved.ID, Mode: "chunked"}); errorCode(err) != CodeUploadInvalid {
				t.Fatalf("completed POST was reopened: %v", err)
			}
		})
	}
}

func TestCompletedUploadStatusRetainsOwnershipAndVisibility(t *testing.T) {
	for _, scenario := range []string{"other uploader", "inactive uploader", "removed attachment", "failed attachment", "failed transfer", "changed uploader", "changed binding", "other space", "left conversation", "left topic"} {
		t.Run(scenario, func(t *testing.T) {
			repo := newFakeFileRepo()
			service := testService(t, repo, nil)
			attachmentID := "attachment-owned"
			repo.state.transfers["upload-owned"] = &TransferRecord{ID: "upload-owned", SpaceID: DefaultSpaceID, UserID: "usr_owner", Direction: "upload", Status: "completed", AttachmentID: &attachmentID, ByteSize: 7}
			attachment := &AttachmentRecord{ID: attachmentID, SpaceID: DefaultSpaceID, UploaderID: "usr_owner", UploadTransferID: "upload-owned", Status: "available", Visibility: "private_staging", ByteSize: 7}
			repo.state.attachments[attachmentID] = attachment
			actorID, wantCode := "usr_owner", CodeUploadInvalid
			switch scenario {
			case "other uploader":
				actorID = "usr_other"
				repo.state.actors[actorID] = &auth.Actor{ID: actorID, Kind: "human", Role: "owner"}
			case "inactive uploader":
				delete(repo.state.actors, actorID)
				wantCode = CodeAuthRequired
			case "removed attachment":
				attachment.Status = "removed"
			case "failed attachment":
				attachment.Status = "failed"
			case "failed transfer":
				repo.state.transfers["upload-owned"].Status = "failed"
			case "changed uploader":
				attachment.UploaderID = "someone-else"
			case "changed binding":
				attachment.UploadTransferID = "different-upload"
			case "other space":
				attachment.SpaceID = "another-space"
			case "left conversation":
				conversationID := "conv-private"
				attachment.Visibility, attachment.ConversationID = "conversation", &conversationID
			case "left topic":
				service.repo = topicFileReader{fakeFileRepo: repo, linked: true, visible: false}
			}
			result, err := service.GetUploadStatus(context.Background(), UploadStatusInput{ActorID: actorID, UploadID: "upload-owned"})
			if errorCode(err) != wantCode || result.Attachment != nil {
				t.Fatalf("unauthorized status = %#v, err=%v want=%s", result, err, wantCode)
			}
		})
	}
}
