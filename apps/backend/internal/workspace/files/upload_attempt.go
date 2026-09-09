package files

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

// Attempt objects belong to exactly one request. Slow client bodies never hold
// a database lock and cannot overwrite another attempt's verified bytes.
func newUploadAttemptKey(uploadID string) (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", internalError("create upload attempt", err)
	}
	return fmt.Sprintf("workspace/uploads/%s/attempts/%s", uploadID, id.String()), nil
}

func (s *Service) cleanupUploadAttempt(ctx context.Context, key string) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), storageMutationTimeout)
	defer cancel()
	_ = s.blobStore.Delete(cleanupCtx, platformstorage.Object{Key: key})
}

func (s *Service) cleanupUnboundPart(ctx context.Context, uploadID string, partNumber int) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), storageMutationTimeout)
	defer cancel()
	_ = s.repo.WithTx(cleanupCtx, func(tx Tx) error {
		if err := tx.Lock(cleanupCtx, uploadLockKey(uploadID)); err != nil {
			return err
		}
		existing, err := tx.GetUploadPart(cleanupCtx, uploadID, partNumber)
		if err != nil || existing != nil {
			return err
		}
		// Publication and cleanup share the lock. A committed retry's part is
		// never removed just because this particular transaction failed.
		return s.blobStore.Delete(cleanupCtx, platformstorage.Object{Key: stagingPartKey(uploadID, partNumber)})
	})
}

func (s *Service) cleanupTerminalUploadStaging(ctx context.Context, actorID, uploadID string, parts []UploadPartRecord, size int64) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), storageMutationTimeout)
	defer cancel()
	_ = s.repo.WithTx(cleanupCtx, func(tx Tx) error {
		if err := tx.Lock(cleanupCtx, uploadLockKey(uploadID)); err != nil {
			return err
		}
		transfer, err := tx.GetTransfer(cleanupCtx, s.space(), actorID, uploadID, TransferUpload)
		if err != nil || (transfer != nil && transfer.Status == string(TransferReserved)) {
			return err
		}
		return s.cleanupUploadStaging(cleanupCtx, uploadID, parts, size)
	})
}
