//go:build postgres_integration

package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

type failingPartTouchRepository struct{ Repository }
type failingPartTouchTx struct{ Tx }

func (r failingPartTouchRepository) WithTx(ctx context.Context, fn func(Tx) error) error {
	return r.Repository.WithTx(ctx, func(tx Tx) error { return fn(failingPartTouchTx{tx}) })
}

func (failingPartTouchTx) TouchUpload(context.Context, string, time.Time) error {
	return errors.New("synthetic transaction failure")
}

func partInput(uploadID, content string) UploadPartInput {
	digest := sha256.Sum256([]byte(content))
	return UploadPartInput{ActorID: "usr_file_owner", UploadID: uploadID, PartNumber: 1,
		Content: strings.NewReader(content), ContentLength: int64(len(content)), SHA256: hex.EncodeToString(digest[:])}
}

func TestPGFailedDuplicatePartCannotDeleteCommittedBytes(t *testing.T) {
	ctx, _, service, store := newStorageLockFixture(t)
	reservation, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_file_owner", FileName: "part.txt", ByteSize: 3})
	if err != nil {
		t.Fatal(err)
	}
	input := partInput(reservation.ID, "one")
	if _, err := service.UploadPart(ctx, input); err != nil {
		t.Fatal(err)
	}
	service.repo = failingPartTouchRepository{service.repo}
	if _, err := service.UploadPart(ctx, partInput(reservation.ID, "one")); err == nil {
		t.Fatal("failing duplicate transaction accepted")
	}
	opened, err := store.Open(ctx, platformstorage.Object{Key: stagingPartKey(reservation.ID, 1), SHA256: input.SHA256, ByteSize: 3}, 3)
	if err != nil {
		t.Fatalf("failed duplicate removed a committed part: %v", err)
	}
	_ = opened.Body.Close()
}

type heldUploadReader struct {
	reader  io.Reader
	started chan struct{}
	resume  chan struct{}
	once    sync.Once
	ctx     context.Context
}

func (r *heldUploadReader) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	case <-r.resume:
		return r.reader.Read(p)
	}
}

func TestPGConflictingConcurrentPartCannotReplaceWinner(t *testing.T) {
	ctx, _, service, store := newStorageLockFixture(t)
	reservation, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_file_owner", FileName: "part.txt", ByteSize: 3})
	if err != nil {
		t.Fatal(err)
	}
	slow := &heldUploadReader{reader: strings.NewReader("old"), started: make(chan struct{}), resume: make(chan struct{}), ctx: ctx}
	defer func() {
		select {
		case <-slow.resume:
		default:
			close(slow.resume)
		}
	}()
	first := partInput(reservation.ID, "old")
	first.Content = slow
	firstResult := make(chan error, 1)
	go func() { _, err := service.UploadPart(ctx, first); firstResult <- err }()
	select {
	case <-slow.started:
	case <-ctx.Done():
		t.Fatal("first request never reached body staging")
	}
	winner := partInput(reservation.ID, "new")
	if _, err := service.UploadPart(ctx, winner); err != nil {
		t.Fatal(err)
	}
	close(slow.resume)
	if err := <-firstResult; errorCode(err) != CodeUploadPartConflict {
		t.Fatalf("conflicting delayed request = %v", err)
	}
	opened, err := store.Open(ctx, platformstorage.Object{Key: stagingPartKey(reservation.ID, 1), SHA256: winner.SHA256, ByteSize: 3}, 3)
	if err != nil {
		t.Fatalf("conflicting request corrupted winning part: %v", err)
	}
	defer opened.Body.Close()
	content, err := io.ReadAll(opened.Body)
	if err != nil || string(content) != "new" {
		t.Fatalf("winning bytes=%q err=%v", content, err)
	}
}

type completionStageBarrier struct {
	platformstorage.BlobStore
	firstDigest               string
	firstReady, secondReady   chan struct{}
	firstResume, secondResume chan struct{}
}

func (s completionStageBarrier) Put(ctx context.Context, key string, reader io.Reader, size int64, digest string) (platformstorage.StoredObject, error) {
	stored, err := s.BlobStore.Put(ctx, key, reader, size, digest)
	if err != nil || !strings.HasPrefix(key, "workspace/uploads/") {
		return stored, err
	}
	ready, resume := s.secondReady, s.secondResume
	if stored.SHA256 == s.firstDigest {
		ready, resume = s.firstReady, s.firstResume
	}
	close(ready)
	select {
	case <-ctx.Done():
		return stored, ctx.Err()
	case <-resume:
		return stored, nil
	}
}

func TestPGConcurrentCompletionAttemptsKeepIndependentStaging(t *testing.T) {
	ctx, _, service, store := newStorageLockFixture(t)
	reservation, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_file_owner", FileName: "complete.txt", ByteSize: 3})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("one"))
	barrier := completionStageBarrier{BlobStore: store, firstDigest: hex.EncodeToString(digest[:]),
		firstReady: make(chan struct{}), secondReady: make(chan struct{}), firstResume: make(chan struct{}), secondResume: make(chan struct{})}
	service.blobStore = barrier
	defer func() {
		for _, resume := range []chan struct{}{barrier.firstResume, barrier.secondResume} {
			select {
			case <-resume:
			default:
				close(resume)
			}
		}
	}()
	firstResult, secondResult := make(chan error, 1), make(chan error, 1)
	complete := func(content string, result chan error) {
		_, err := service.CompleteUpload(ctx, CompleteUploadInput{ActorID: "usr_file_owner", UploadID: reservation.ID, Content: strings.NewReader(content)})
		result <- err
	}
	go complete("one", firstResult)
	select {
	case <-barrier.firstReady:
	case <-ctx.Done():
		t.Fatal("first completion did not stage")
	}
	go complete("two", secondResult)
	select {
	case <-barrier.secondReady:
	case <-ctx.Done():
		t.Fatal("second completion did not stage")
	}
	close(barrier.firstResume)
	firstErr := <-firstResult
	close(barrier.secondResume)
	secondErr := <-secondResult
	if firstErr != nil || secondErr == nil {
		t.Fatalf("concurrent completion first=%v second=%v", firstErr, secondErr)
	}
	attachment, err := service.repo.GetAttachment(ctx, DefaultSpaceID, reservation.Attachment.ID)
	if err != nil || attachment == nil || attachment.Status != string(AttachmentAvailable) || attachment.StorageObject == nil {
		t.Fatalf("winning completion was lost: attachment=%#v err=%v", attachment, err)
	}
	opened, err := store.Open(ctx, attachment.StorageObject.BlobObject(), 3)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Body.Close()
	content, err := io.ReadAll(opened.Body)
	if err != nil || string(content) != "one" {
		t.Fatalf("wrong attempt bytes=%q err=%v", content, err)
	}
}
