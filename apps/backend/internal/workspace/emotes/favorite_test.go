package emotes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspacefiles "github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

type favoriteSourceFakeRepository struct {
	*fakeRepo
	messages       map[string]FavoriteMessageRecord
	messageViewers map[string]map[string]bool
	attachments    map[string]FavoriteAttachmentRecord
}

func newFavoriteSourceFakeRepository() *favoriteSourceFakeRepository {
	return &favoriteSourceFakeRepository{
		fakeRepo:       newFakeRepo(),
		messages:       make(map[string]FavoriteMessageRecord),
		messageViewers: make(map[string]map[string]bool),
		attachments:    make(map[string]FavoriteAttachmentRecord),
	}
}

func (repo *favoriteSourceFakeRepository) GetVisibleFavoriteMessage(_ context.Context, spaceID, actorID, messageID string) (*FavoriteMessageRecord, error) {
	message, ok := repo.messages[messageID]
	if !ok || message.SpaceID != spaceID || !repo.messageViewers[messageID][actorID] {
		return nil, nil
	}
	copy := message
	copy.ContentJSON = append([]byte(nil), message.ContentJSON...)
	return &copy, nil
}

func (repo *favoriteSourceFakeRepository) GetFavoriteMessageAttachment(_ context.Context, spaceID, messageID, attachmentID string) (*FavoriteAttachmentRecord, error) {
	attachment, ok := repo.attachments[messageID+"\x00"+attachmentID]
	if !ok || attachment.SpaceID != spaceID || attachment.ID != attachmentID {
		return nil, nil
	}
	copy := attachment
	return &copy, nil
}

type favoriteAttachmentReaderStub struct {
	mu           sync.Mutex
	data         []byte
	err          error
	reportedSize int64
	useReported  bool
	calls        []AttachmentContentInput
	closeCount   atomic.Int32
}

func (reader *favoriteAttachmentReaderStub) OpenAttachmentContent(_ context.Context, input AttachmentContentInput) (platformstorage.OpenedObject, error) {
	reader.mu.Lock()
	reader.calls = append(reader.calls, input)
	data := append([]byte(nil), reader.data...)
	err := reader.err
	reportedSize := reader.reportedSize
	useReported := reader.useReported
	reader.mu.Unlock()
	if err != nil {
		return platformstorage.OpenedObject{}, err
	}
	size := int64(len(data))
	if useReported {
		size = reportedSize
	}
	return platformstorage.OpenedObject{
		Object: platformstorage.Object{Key: "workspace/attachments/synthetic/content", ByteSize: size, ContentType: "image/png"},
		Body:   &favoriteTrackedReadCloser{Reader: bytes.NewReader(data), closeCount: &reader.closeCount},
	}, nil
}

type favoriteTrackedReadCloser struct {
	io.Reader
	closeCount *atomic.Int32
}

func (reader *favoriteTrackedReadCloser) Close() error {
	reader.closeCount.Add(1)
	return nil
}

func newFavoriteTestService(t *testing.T, repo Repository, reader AttachmentContentReader) *Service {
	t.Helper()
	var sequence atomic.Int64
	now := time.Date(2026, 9, 6, 12, 34, 56, 789654321, time.UTC)
	return NewService(ServiceOptions{
		Repository: repo, BlobStore: newFakeBlobStore(), Catalog: testCatalog(t), Processor: fakeProcessor{},
		AttachmentContentReader: reader, SpaceID: DefaultSpaceID,
		Now:       func() time.Time { return now },
		IDFactory: func() (string, error) { return "favorite-id-" + string(rune('a'+sequence.Add(1)-1)), nil },
	})
}

func seedFavoriteMessage(repo *favoriteSourceFakeRepository, messageID, actorID string, content string) {
	repo.messages[messageID] = FavoriteMessageRecord{ID: messageID, SpaceID: DefaultSpaceID, ContentJSON: []byte(content)}
	repo.messageViewers[messageID] = map[string]bool{actorID: true}
}

func TestFavoriteFromMessageAttachmentProcessesAuthorizedImage(t *testing.T) {
	repo := newFavoriteSourceFakeRepository()
	seedFakeActor(repo.fakeRepo, "usr-favorite", "member")
	seedFavoriteMessage(repo, "msg-favorite", "usr-favorite", `{"blocks":[{"type":"text","text":"attachment"}]}`)
	repo.attachments["msg-favorite\x00att-favorite"] = FavoriteAttachmentRecord{
		ID: "att-favorite", SpaceID: DefaultSpaceID, Status: "available", FileName: "favorite.png", MIMEType: "image/png", ByteSize: int64(len("attachment bytes")),
	}
	reader := &favoriteAttachmentReaderStub{data: []byte("attachment bytes")}
	service := newFavoriteTestService(t, repo, reader)

	result, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{
		ActorID: "usr-favorite", MessageID: "msg-favorite", AttachmentID: "att-favorite",
		Meta: auth.RequestMeta{RequestID: "favorite-attachment"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || result.SourceType != "attachment" || result.OriginalFileName != "favorite.png" || result.OriginalMIMEType != "image/png" {
		t.Fatalf("attachment favorite = %#v", result)
	}
	if result.ByteSize == nil || *result.ByteSize != int64(len("attachment bytes")) {
		t.Fatalf("processed byte size = %#v", result.ByteSize)
	}
	reader.mu.Lock()
	calls := append([]AttachmentContentInput(nil), reader.calls...)
	reader.mu.Unlock()
	if len(calls) != 1 || calls[0].ActorID != "usr-favorite" || calls[0].AttachmentID != "att-favorite" || calls[0].MaxBytes != MaxInputBytes || calls[0].Meta.RequestID != "favorite-attachment" {
		t.Fatalf("attachment reader calls = %#v", calls)
	}
	if reader.closeCount.Load() != 1 {
		t.Fatalf("attachment body close count = %d", reader.closeCount.Load())
	}
	state := repo.snapshot()
	row := state.emotes[result.ID]
	if row.SourceAttachmentID != "att-favorite" || row.StorageObjectID == "" || len(state.audits) != 1 || len(state.events) != 1 {
		t.Fatalf("attachment persistence = row:%#v audits:%d events:%d", row, len(state.audits), len(state.events))
	}
}

func TestFavoriteFromMessageBuiltinRequiresMessageToken(t *testing.T) {
	repo := newFavoriteSourceFakeRepository()
	seedFakeActor(repo.fakeRepo, "usr-favorite", "member")
	seedFavoriteMessage(repo, "msg-builtin", "usr-favorite", `{"blocks":[{"type":"text","text":"hello [bili:doge]"}]}`)
	service := newFavoriteTestService(t, repo, nil)

	result, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{
		ActorID: "usr-favorite", MessageID: "msg-builtin", EmoteKey: " bili:doge ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || result.Kind != "builtin" || result.EmoteKey != "bili:doge" {
		t.Fatalf("builtin favorite = %#v", result)
	}
	if _, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{
		ActorID: "usr-favorite", MessageID: "msg-builtin", EmoteKey: "bili:missing",
	}); !isCode(err, CodeEmoteInvalidSource) {
		t.Fatalf("missing builtin token = %v", err)
	}
}

func TestFavoriteFromMessageCustomReferencePreservesNullableSourceMetadata(t *testing.T) {
	repo := newFavoriteSourceFakeRepository()
	seedFakeActor(repo.fakeRepo, "usr-source", "member")
	seedFakeActor(repo.fakeRepo, "usr-favorite", "member")
	const sourceID = "11111111-1111-1111-1111-111111111111"
	content := []byte("canonical custom source")
	digestBytes := sha256.Sum256(content)
	digest := hex.EncodeToString(digestBytes[:])
	objectKey, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		t.Fatal(err)
	}
	repo.state.objects["wso-source"] = StorageObjectRecord{ID: "wso-source", SHA256: digest, ObjectKey: objectKey, ByteSize: int64(len(content)), ContentType: "image/webp"}
	repo.state.emotes[sourceID] = CustomEmoteRecord{
		ID: sourceID, UserID: "usr-source", SourceType: "upload", OriginalFileName: "source.webp", Label: "source label",
		SHA256: digest, StorageObjectID: "wso-source", CreatedAt: time.Now().UTC(),
	}
	const cloneID = "22222222-2222-2222-2222-222222222222"
	repo.state.emotes[cloneID] = CustomEmoteRecord{
		ID: cloneID, UserID: "usr-source", SourceType: "custom", SourceCustomEmoteID: sourceID,
		Label: "clone label", CreatedAt: time.Now().UTC(),
	}
	seedFavoriteMessage(repo, "msg-custom", "usr-favorite", `{"blocks":[{"type":"emoji","shortcode":"custom:22222222-2222-2222-2222-222222222222"}]}`)
	service := newFavoriteTestService(t, repo, nil)

	result, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{
		ActorID: "usr-favorite", MessageID: "msg-custom", CustomEmoteID: cloneID,
		Meta: auth.RequestMeta{RequestID: "favorite-custom"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || result.SourceType != "custom" || result.ID == sourceID || result.OriginalFileName != "source.webp" || result.OriginalMIMEType != "image/webp" || result.Label != "clone label" {
		t.Fatalf("custom reference = %#v", result)
	}
	if result.ByteSize != nil || result.Width != nil || result.Height != nil || result.Animated {
		t.Fatalf("nullable source metadata was filled = %#v", result)
	}
	state := repo.snapshot()
	row := state.emotes[result.ID]
	if row.SourceCustomEmoteID != sourceID || row.StorageObjectID != "wso-source" || row.StorageKey != "" || row.ByteSize != nil {
		t.Fatalf("custom reference row = %#v", row)
	}

	replayed, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{
		ActorID: "usr-favorite", MessageID: "msg-custom", CustomEmoteID: cloneID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if replayed.ID != result.ID || len(repo.snapshot().emotes) != 3 || len(repo.snapshot().entries) != 1 {
		t.Fatalf("custom replay = %#v state=%#v", replayed, repo.snapshot())
	}
}

func TestFavoriteFromMessageRejectsInvisibleAndInvalidSources(t *testing.T) {
	repo := newFavoriteSourceFakeRepository()
	seedFakeActor(repo.fakeRepo, "usr-favorite", "member")
	seedFavoriteMessage(repo, "msg-invalid", "usr-favorite", `{"blocks":[]}`)
	reader := &favoriteAttachmentReaderStub{data: []byte("should not be read")}
	service := newFavoriteTestService(t, repo, reader)

	if _, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{ActorID: "usr-favorite", MessageID: "msg-invalid"}); !isCode(err, CodeEmoteInvalidSource) {
		t.Fatalf("missing source = %v", err)
	}
	if _, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{ActorID: "usr-favorite", MessageID: "msg-invalid", AttachmentID: "a", EmoteKey: "bili:doge"}); !isCode(err, CodeEmoteInvalidSource) {
		t.Fatalf("multiple sources = %v", err)
	}
	if _, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{ActorID: "usr-favorite", MessageID: "missing", AttachmentID: "a"}); !isCode(err, "message.not_found") {
		t.Fatalf("invisible message = %v", err)
	}
	reader.mu.Lock()
	callCount := len(reader.calls)
	reader.mu.Unlock()
	if callCount != 0 || len(repo.snapshot().emotes) != 0 {
		t.Fatalf("invalid source read/persisted: calls=%d emotes=%d", callCount, len(repo.snapshot().emotes))
	}
}

func TestFavoriteFromMessageAttachmentChecksDeclaredAndPhysicalBytes(t *testing.T) {
	repo := newFavoriteSourceFakeRepository()
	seedFakeActor(repo.fakeRepo, "usr-favorite", "member")
	seedFavoriteMessage(repo, "msg-size", "usr-favorite", `{"blocks":[]}`)
	repo.attachments["msg-size\x00att-size"] = FavoriteAttachmentRecord{
		ID: "att-size", SpaceID: DefaultSpaceID, Status: "available", FileName: "size.png", MIMEType: "image/png", ByteSize: 3,
	}
	reader := &favoriteAttachmentReaderStub{data: []byte("four"), reportedSize: 3, useReported: true}
	service := newFavoriteTestService(t, repo, reader)
	if _, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{ActorID: "usr-favorite", MessageID: "msg-size", AttachmentID: "att-size"}); !isCode(err, "file.storage_mismatch") {
		t.Fatalf("physical size mismatch = %v", err)
	}
	if reader.closeCount.Load() != 1 || len(repo.snapshot().emotes) != 0 {
		t.Fatalf("mismatch cleanup = closes:%d emotes:%d", reader.closeCount.Load(), len(repo.snapshot().emotes))
	}
}

func TestFavoriteFromMessageAttachmentHonorsQuota(t *testing.T) {
	repo := newFavoriteSourceFakeRepository()
	seedFakeActor(repo.fakeRepo, "usr-favorite", "member")
	seedFavoriteMessage(repo, "msg-quota", "usr-favorite", `{"blocks":[]}`)
	value := MaxTotalBytes
	repo.state.emotes["over-limit"] = CustomEmoteRecord{ID: "over-limit", UserID: "usr-favorite", SourceType: "upload", Label: "over", ByteSize: &value}
	repo.attachments["msg-quota\x00att-quota"] = FavoriteAttachmentRecord{
		ID: "att-quota", SpaceID: DefaultSpaceID, Status: "available", FileName: "quota.png", MIMEType: "image/png", ByteSize: 5,
	}
	reader := &favoriteAttachmentReaderStub{data: []byte("quota")}
	service := newFavoriteTestService(t, repo, reader)
	if _, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{ActorID: "usr-favorite", MessageID: "msg-quota", AttachmentID: "att-quota"}); !isCode(err, CodeEmoteStorageLimitReached) {
		t.Fatalf("quota rejection = %v", err)
	}
	if len(repo.snapshot().emotes) != 1 {
		t.Fatalf("quota created emote rows = %d", len(repo.snapshot().emotes))
	}
}

func TestFavoriteFromMessageAttachmentIsDigestIdempotentUnderConcurrency(t *testing.T) {
	repo := newFavoriteSourceFakeRepository()
	seedFakeActor(repo.fakeRepo, "usr-favorite", "member")
	seedFavoriteMessage(repo, "msg-concurrent", "usr-favorite", `{"blocks":[]}`)
	repo.attachments["msg-concurrent\x00att-concurrent"] = FavoriteAttachmentRecord{
		ID: "att-concurrent", SpaceID: DefaultSpaceID, Status: "available", FileName: "concurrent.png", MIMEType: "image/png", ByteSize: 10,
	}
	reader := &favoriteAttachmentReaderStub{data: []byte("same bytes")}
	service := newFavoriteTestService(t, repo, reader)

	results := make(chan *CustomEmote, 2)
	errorsCh := make(chan error, 2)
	for range 2 {
		go func() {
			result, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{ActorID: "usr-favorite", MessageID: "msg-concurrent", AttachmentID: "att-concurrent"})
			results <- result
			errorsCh <- err
		}()
	}
	var ids []string
	for range 2 {
		if err := <-errorsCh; err != nil {
			t.Fatal(err)
		}
		ids = append(ids, (<-results).ID)
	}
	if ids[0] != ids[1] || len(repo.snapshot().emotes) != 1 {
		t.Fatalf("concurrent favorite ids=%v rows=%d", ids, len(repo.snapshot().emotes))
	}
}

func TestFavoriteFromMessageMapsAttachmentStorageErrors(t *testing.T) {
	repo := newFavoriteSourceFakeRepository()
	seedFakeActor(repo.fakeRepo, "usr-favorite", "member")
	seedFavoriteMessage(repo, "msg-storage", "usr-favorite", `{"blocks":[]}`)
	repo.attachments["msg-storage\x00att-storage"] = FavoriteAttachmentRecord{
		ID: "att-storage", SpaceID: DefaultSpaceID, Status: "available", FileName: "storage.png", MIMEType: "image/png", ByteSize: 7,
	}
	reader := &favoriteAttachmentReaderStub{err: &platformstorage.Error{Code: "file.storage_missing", StatusCode: 404}}
	service := newFavoriteTestService(t, repo, reader)
	_, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{ActorID: "usr-favorite", MessageID: "msg-storage", AttachmentID: "att-storage"})
	if !isCode(err, "file.storage_missing") {
		t.Fatalf("storage missing mapping = %v", err)
	}
	if errors.Is(err, context.Canceled) {
		t.Fatal("storage missing was reported as cancellation")
	}
}

func TestFavoriteFromMessagePreservesFilesAttachmentErrors(t *testing.T) {
	for _, test := range []struct {
		name string
		err  *workspacefiles.Error
	}{
		{name: "permission removed", err: workspacefiles.NewError(workspacefiles.CodePermissionDenied, workspacefiles.MessagePermissionDenied, 403)},
		{name: "physical missing", err: workspacefiles.NewError(workspacefiles.CodeFileStorageMissing, workspacefiles.MessageFileStorageMissing, 404)},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo := newFavoriteSourceFakeRepository()
			seedFakeActor(repo.fakeRepo, "usr-favorite", "member")
			seedFavoriteMessage(repo, "msg-files-error", "usr-favorite", `{"blocks":[]}`)
			repo.attachments["msg-files-error\x00att-files-error"] = FavoriteAttachmentRecord{
				ID: "att-files-error", SpaceID: DefaultSpaceID, Status: "available", FileName: "error.png", MIMEType: "image/png", ByteSize: 5,
			}
			reader := &favoriteAttachmentReaderStub{err: test.err}
			service := newFavoriteTestService(t, repo, reader)

			_, err := service.FavoriteFromMessage(context.Background(), FavoriteFromMessageInput{
				ActorID: "usr-favorite", MessageID: "msg-files-error", AttachmentID: "att-files-error",
			})
			var got *workspacefiles.Error
			if !errors.As(err, &got) || got != test.err || got.Code != test.err.Code || got.StatusCode != test.err.StatusCode {
				t.Fatalf("files error = %#v, want preserved %#v", err, test.err)
			}
		})
	}
}

func TestFavoriteMessageContentMatchingMirrorsNodeScalars(t *testing.T) {
	blocks := parseFavoriteMessageBlocks([]byte(`{"blocks":[{"type":"text","text":true},{"type":"text","text":["prefix","[bili:doge]"]},{"type":"emoji","shortcode":"custom:11111111-1111-1111-1111-111111111111"}]}`))
	item := CatalogItem{Kind: "image", Token: "[bili:doge]"}
	if !favoriteMessageContainsBuiltin(blocks, item, "bili:doge") || !favoriteMessageContainsCustom(blocks, "11111111-1111-1111-1111-111111111111") {
		t.Fatalf("message matching blocks = %#v", blocks)
	}
}

func TestFavoriteNodeStringDoesNotTreatInvalidJSONAsContent(t *testing.T) {
	if blocks := parseFavoriteMessageBlocks([]byte(`{"blocks":{}}`)); blocks != nil {
		t.Fatalf("object blocks accepted = %#v", blocks)
	}
	if got := favoriteNodeString([]byte(`"[bili:doge]"`)); got != "[bili:doge]" {
		t.Fatalf("node string = %q", got)
	}
	if got := favoriteNodeString([]byte(`null`)); got != "null" {
		t.Fatalf("node null string = %q", got)
	}
	if strings.TrimSpace(favoriteMessageNotFoundMessage) == "" {
		t.Fatal("message-not-found message is empty")
	}
}
