package files

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	// DefaultUploadMaintenanceInterval is a worker hint. NewService does not
	// start a timer or perform a background mutation.
	DefaultUploadMaintenanceInterval = 5 * time.Minute
	// DefaultUploadMaintenanceTimeout bounds one explicitly requested sweep.
	DefaultUploadMaintenanceTimeout = 30 * time.Second
	// DefaultUploadMaintenanceObjectTimeout bounds each physical cleanup call.
	DefaultUploadMaintenanceObjectTimeout = 15 * time.Second
	// DefaultUploadMaintenanceBatchSize bounds database and storage pages.
	DefaultUploadMaintenanceBatchSize = 100
	// DefaultUploadMaintenanceRetries is the default retry count after the
	// first database or physical-storage attempt.
	DefaultUploadMaintenanceRetries = 2
	// MaxUploadMaintenanceAttemptCursors bounds opaque provider cursors kept
	// between cycles. A provider must never be able to grow this map without
	// limit by returning a new upload ID on every page.
	MaxUploadMaintenanceAttemptCursors = 256
)

// UploadMaintenanceCursor is a keyset cursor ordered by transfer activity and
// ID. A worker retains it across bounded cycles until a page reaches the end;
// only then does the next cycle wrap to the beginning.
type UploadMaintenanceCursor struct {
	ActivityAt time.Time
	ID         string
}

// UploadMaintenancePage is the repository page consumed by the maintenance
// worker. Records include both stale reservations and old terminal uploads.
type UploadMaintenancePage struct {
	Records []StaleUploadRecord
	Next    *UploadMaintenanceCursor
}

// UploadMaintenanceOptions controls one bounded sweep. IncludeTerminalArtifacts
// enables cleanup of old stage/attempt objects belonging to already terminal
// uploads; stale reservations are always rechecked and terminalized first.
type UploadMaintenanceOptions struct {
	Now           time.Time
	BatchSize     int
	Timeout       time.Duration
	ObjectTimeout time.Duration
	// MaxRetries is the number of retries after the first attempt. Zero uses
	// DefaultUploadMaintenanceRetries; a negative value disables retries.
	MaxRetries               int
	Cursor                   *UploadMaintenanceCursor
	IncludeTerminalArtifacts bool
	AttemptCursors           map[string]string
}

// UploadMaintenanceResult reports work completed by one sweep. Errors are
// returned separately while the worker can still inspect partial progress.
type UploadMaintenanceResult struct {
	Scanned                  int
	StaleReservationsFailed  int
	TerminalUploadsInspected int
	ObjectsDeleted           int
	ObjectFailures           int
	Errors                   int
	Next                     *UploadMaintenanceCursor
	AttemptCursors           map[string]string
}

func normalizeUploadMaintenanceLimit(limit int) int {
	if limit <= 0 {
		return DefaultUploadMaintenanceBatchSize
	}
	if limit > DefaultUploadMaintenanceBatchSize {
		return DefaultUploadMaintenanceBatchSize
	}
	return limit
}

type maintenancePlan struct {
	uploadID     string
	userID       string
	attachmentID string
	byteSize     int64
	parts        []UploadPartRecord
	failed       bool
	terminal     bool
}

func (s *Service) RunUploadMaintenance(ctx context.Context, options UploadMaintenanceOptions) (UploadMaintenanceResult, error) {
	if s == nil || s.repo == nil {
		return UploadMaintenanceResult{}, internalError("run workspace upload maintenance", errors.New("repository is required"))
	}
	if ctx == nil {
		return UploadMaintenanceResult{}, internalError("run workspace upload maintenance", errors.New("context is required"))
	}
	now := options.Now
	if now.IsZero() {
		now = s.nowUTC()
	}
	now = now.UTC()
	batchSize := normalizeUploadMaintenanceLimit(options.BatchSize)
	runTimeout := options.Timeout
	if runTimeout <= 0 {
		runTimeout = DefaultUploadMaintenanceTimeout
	}
	objectTimeout := options.ObjectTimeout
	if objectTimeout <= 0 {
		objectTimeout = DefaultUploadMaintenanceObjectTimeout
	}
	if options.MaxRetries == 0 {
		options.MaxRetries = DefaultUploadMaintenanceRetries
	} else if options.MaxRetries < 0 {
		options.MaxRetries = 0
	}
	runCtx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	result := UploadMaintenanceResult{
		Next:           cloneUploadMaintenanceCursor(options.Cursor),
		AttemptCursors: cloneAttemptCursors(options.AttemptCursors),
	}
	if err := runCtx.Err(); err != nil {
		return result, err
	}
	cutoff := now.Add(-s.staleUploadAge)
	page, err := s.listUploadMaintenancePage(runCtx, cutoff, options.Cursor, batchSize, options.IncludeTerminalArtifacts)
	if err != nil {
		return result, normalizeRepositoryError(err)
	}
	result.Scanned = len(page.Records)
	if len(page.Records) == 0 {
		// An empty page is the end-of-keyspace marker. A nil Next therefore
		// deliberately wraps the next cycle back to the first page.
		result.Next = cloneUploadMaintenanceCursor(page.Next)
	}
	var firstErr error
	recordError := func(value error) {
		if value == nil {
			return
		}
		result.Errors++
		if firstErr == nil {
			firstErr = value
		}
	}
	for _, candidate := range page.Records {
		if err := runCtx.Err(); err != nil {
			recordError(err)
			break
		}
		plan, planErr := s.confirmUploadMaintenance(runCtx, candidate, cutoff, now, options.IncludeTerminalArtifacts, options.MaxRetries)
		if planErr != nil {
			recordError(normalizeRepositoryError(planErr))
			if runCtx.Err() != nil {
				break
			}
			// A failed candidate was attempted. Advance past it so a single
			// transient row cannot starve later records in this keyset.
			result.Next = maintenanceCursorFor(candidate)
			continue
		}
		if !plan.failed && !plan.terminal {
			if runCtx.Err() != nil {
				break
			}
			result.Next = maintenanceCursorFor(candidate)
			continue
		}
		if plan.failed {
			result.StaleReservationsFailed++
		}
		if plan.terminal {
			result.TerminalUploadsInspected++
		}
		deleted, failures, nextAttemptCursor, cleanupErr := s.cleanupMaintenanceArtifacts(
			runCtx, plan, cutoff, objectTimeout, options.MaxRetries, result.AttemptCursors[plan.uploadID],
		)
		result.ObjectsDeleted += deleted
		result.ObjectFailures += failures
		if nextAttemptCursor == "" {
			rememberAttemptCursor(result.AttemptCursors, plan.uploadID, "")
		} else {
			rememberAttemptCursor(result.AttemptCursors, plan.uploadID, nextAttemptCursor)
		}
		if cleanupErr != nil {
			recordError(cleanupErr)
		}
		if cleanupErr == nil && plan.terminal && s.blobStore != nil && runCtx.Err() == nil {
			// Keep the part rows until all physical staging keys have been
			// handled. A later cycle can then re-read legacy part metadata when
			// storage cleanup is partial or unavailable. The final delete is
			// still guarded by the upload lock and a fresh terminal/age check.
			if err := s.finalizeTerminalUploadParts(runCtx, plan, cutoff, options.MaxRetries); err != nil {
				recordError(normalizeRepositoryError(err))
			}
		}
		if runCtx.Err() != nil {
			break
		}
		// Physical failures are retryable, but the candidate has still been
		// attempted. Keep moving through the page while the cycle budget is
		// available; attempt cursors resume provider pages after wrap.
		result.Next = maintenanceCursorFor(candidate)
	}
	if runCtx.Err() == nil && len(page.Records) > 0 && result.Next != nil {
		// If every record in this page was attempted, use the repository's
		// keyset successor. When the page has no successor this becomes nil,
		// which is the explicit wrap marker.
		last := page.Records[len(page.Records)-1]
		if result.Next.ActivityAt.Equal(transferActivity(last.Transfer)) && result.Next.ID == last.Transfer.ID {
			result.Next = cloneUploadMaintenanceCursor(page.Next)
		}
	}
	if firstErr != nil {
		return result, firstErr
	}
	if err := runCtx.Err(); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Service) listUploadMaintenancePage(ctx context.Context, before time.Time, after *UploadMaintenanceCursor, limit int, includeTerminal bool) (UploadMaintenancePage, error) {
	if repository, ok := s.repo.(UploadMaintenanceRepository); ok {
		page, err := repository.ListUploadMaintenancePage(ctx, s.space(), before, after, limit, includeTerminal)
		if err != nil {
			return UploadMaintenancePage{}, err
		}
		return page, nil
	}
	legacy, err := s.repo.ListStaleUploads(ctx, s.space(), before)
	if err != nil {
		return UploadMaintenancePage{}, err
	}
	items := make([]StaleUploadRecord, 0, len(legacy))
	for _, item := range legacy {
		if item.Transfer.Status != string(TransferReserved) || item.Attachment.Status != string(AttachmentPending) {
			continue
		}
		if after != nil && !maintenanceRecordAfter(item, after) {
			continue
		}
		items = append(items, item)
	}
	sort.Slice(items, func(left, right int) bool { return maintenanceRecordLess(items[left], items[right]) })
	if len(items) > limit {
		items = items[:limit]
	}
	page := UploadMaintenancePage{Records: items}
	if len(items) == limit && len(legacy) > len(items) {
		page.Next = maintenanceCursorFor(items[len(items)-1])
	}
	return page, nil
}

func (s *Service) confirmUploadMaintenance(ctx context.Context, candidate StaleUploadRecord, cutoff, now time.Time, includeTerminal bool, maxRetries int) (maintenancePlan, error) {
	var plan maintenancePlan
	operation := func() error {
		plan = maintenancePlan{}
		return s.repo.WithTx(ctx, func(tx Tx) error {
			if tx == nil {
				return errors.New("maintenance transaction is required")
			}
			if candidate.Transfer.Status == string(TransferReserved) {
				if err := lockKeys(ctx, tx, quotaLockKey(s.space(), candidate.Transfer.UserID, now), uploadLockKey(candidate.Transfer.ID)); err != nil {
					return err
				}
			} else {
				if err := tx.Lock(ctx, uploadLockKey(candidate.Transfer.ID)); err != nil {
					return err
				}
			}
			current, err := tx.GetTransfer(ctx, s.space(), candidate.Transfer.UserID, candidate.Transfer.ID, TransferUpload)
			if err != nil {
				return err
			}
			if current == nil || strings.TrimSpace(current.ID) == "" {
				return nil
			}
			activity := transferActivity(*current)
			if current.Status == string(TransferReserved) {
				// The candidate query is only a hint. This is the decisive check,
				// performed after the upload advisory lock is held.
				if !activity.Before(cutoff) || current.AttachmentID == nil || strings.TrimSpace(*current.AttachmentID) == "" {
					return nil
				}
				attachment, getErr := tx.GetAttachment(ctx, s.space(), *current.AttachmentID)
				if getErr != nil {
					return getErr
				}
				if attachment == nil || attachment.Status != string(AttachmentPending) || attachment.UploadTransferID != current.ID {
					return nil
				}
				parts, listErr := tx.ListUploadParts(ctx, current.ID)
				if listErr != nil {
					return listErr
				}
				changed, failErr := tx.FailUpload(ctx, s.space(), current.UserID, current.ID, attachment.ID, "stale upload reservation", now)
				if failErr != nil {
					return failErr
				}
				if !changed {
					return nil
				}
				payload, marshalErr := json.Marshal(map[string]any{"attachmentId": attachment.ID, "status": string(AttachmentFailed)})
				if marshalErr != nil {
					return marshalErr
				}
				if err := s.writeEvent(ctx, tx, EventInput{Type: "attachment.failed", ActorID: current.UserID, ConversationID: pointerValue(attachment.ConversationID), TargetType: attachmentTargetType, TargetID: attachment.ID, PayloadJSON: payload}, now); err != nil {
					return err
				}
				if err := s.writeAudit(ctx, tx, nil, auth.RequestMeta{}, AuditInput{Action: "file.upload.failed", TargetType: attachmentTargetType, TargetID: attachment.ID, ActorUserID: current.UserID, Result: "failure", Reason: "stale upload reservation"}, now); err != nil {
					return err
				}
				plan = maintenancePlan{uploadID: current.ID, userID: current.UserID, attachmentID: attachment.ID, byteSize: current.ByteSize, parts: parts, failed: true}
				return nil
			}
			if !includeTerminal || !isTerminalUploadStatus(current.Status) || !activity.Before(cutoff) {
				return nil
			}
			// Preserve legacy part numbers for physical staging cleanup before
			// the later transactional delete removes this retry metadata.
			// The transfer was re-read while holding its upload lock, so a fresh
			// reserved upload cannot be mistaken for this cleanup target.
			parts, listErr := tx.ListUploadParts(ctx, current.ID)
			if listErr != nil {
				return listErr
			}
			plan = maintenancePlan{uploadID: current.ID, userID: current.UserID, byteSize: current.ByteSize, parts: parts, terminal: true}
			if current.AttachmentID != nil {
				plan.attachmentID = strings.TrimSpace(*current.AttachmentID)
			}
			return nil
		})
	}
	err := retryMaintenance(ctx, maxRetries, operation)
	return plan, err
}

func (s *Service) finalizeTerminalUploadParts(ctx context.Context, plan maintenancePlan, cutoff time.Time, maxRetries int) error {
	if s == nil || s.repo == nil {
		return internalError("cleanup terminal workspace upload parts", errors.New("repository is required"))
	}
	if normalizeUploadID(plan.uploadID) == "" || strings.TrimSpace(plan.userID) == "" {
		return internalError("cleanup terminal workspace upload parts", errors.New("terminal upload identity is invalid"))
	}
	return retryMaintenance(ctx, maxRetries, func() error {
		return s.repo.WithTx(ctx, func(tx Tx) error {
			if tx == nil {
				return errors.New("maintenance transaction is required")
			}
			if err := tx.Lock(ctx, uploadLockKey(plan.uploadID)); err != nil {
				return err
			}
			current, err := tx.GetTransfer(ctx, s.space(), plan.userID, plan.uploadID, TransferUpload)
			if err != nil {
				return err
			}
			if current == nil || !isTerminalUploadStatus(current.Status) || !transferActivity(*current).Before(cutoff) {
				return nil
			}
			return tx.DeleteUploadParts(ctx, current.ID)
		})
	})
}

func (s *Service) cleanupMaintenanceArtifacts(ctx context.Context, plan maintenancePlan, cutoff time.Time, objectTimeout time.Duration, maxRetries int, attemptCursor string) (int, int, string, error) {
	if s == nil || s.blobStore == nil {
		return 0, 0, "", nil
	}
	uploadID := normalizeUploadID(plan.uploadID)
	if uploadID == "" {
		return 0, 1, "", internalError("clean workspace upload artifacts", errors.New("maintenance upload ID is invalid"))
	}
	deleted := 0
	failures := 0
	var firstErr error
	keys := maintenanceStagingKeys(uploadID, plan.parts, plan.byteSize)
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return deleted, failures, attemptCursor, err
		}
		err := retryMaintenance(ctx, maxRetries, func() error {
			return withMaintenanceObjectTimeoutErr(ctx, objectTimeout, func(objectCtx context.Context) error {
				return s.blobStore.Delete(objectCtx, platformstorage.Object{Key: key})
			})
		})
		if err != nil {
			failures++
			if firstErr == nil {
				firstErr = normalizeStorageError(err)
			}
			continue
		}
		deleted++
	}

	maintenance, ok := s.blobStore.(platformstorage.UploadAttemptMaintenance)
	if !ok {
		return deleted, failures, "", firstErr
	}
	page, err := withMaintenanceObjectTimeout(ctx, objectTimeout, func(objectCtx context.Context) (platformstorage.UploadAttemptObjectPage, error) {
		return maintenance.ListUploadAttemptObjects(objectCtx, uploadID, cutoff, attemptCursor, DefaultUploadMaintenanceBatchSize)
	})
	if err != nil {
		failures++
		if firstErr == nil {
			firstErr = normalizeStorageError(err)
		}
		// Keep the opaque marker when listing fails. Dropping it would force
		// every cycle back to the provider's first page and can starve later
		// attempts indefinitely.
		return deleted, failures, attemptCursor, firstErr
	}
	for _, object := range page.Objects {
		if err := ctx.Err(); err != nil {
			return deleted, failures, attemptCursor, err
		}
		if !object.LastModified.IsZero() && object.LastModified.After(cutoff) {
			continue
		}
		err := retryMaintenance(ctx, maxRetries, func() error {
			return withMaintenanceObjectTimeoutErr(ctx, objectTimeout, func(objectCtx context.Context) error {
				return maintenance.DeleteUploadAttemptObject(objectCtx, uploadID, object.Key)
			})
		})
		if err != nil {
			failures++
			if firstErr == nil {
				firstErr = normalizeStorageError(err)
			}
			continue
		}
		deleted++
	}
	return deleted, failures, page.NextCursor, firstErr
}

func maintenanceStagingKeys(uploadID string, parts []UploadPartRecord, byteSize int64) []string {
	keys := []string{stagingContentKey(uploadID), stagingAssembledKey(uploadID)}
	partNumbers := make(map[int]struct{}, len(parts))
	for _, part := range parts {
		if part.PartNumber > 0 && part.PartNumber <= UploadPartLimit {
			partNumbers[part.PartNumber] = struct{}{}
		}
	}
	if _, count, err := uploadContract(byteSize); err == nil {
		for partNumber := 1; partNumber <= count; partNumber++ {
			partNumbers[partNumber] = struct{}{}
		}
	}
	ordered := make([]int, 0, len(partNumbers))
	for partNumber := range partNumbers {
		ordered = append(ordered, partNumber)
	}
	sort.Ints(ordered)
	for _, partNumber := range ordered {
		keys = append(keys, stagingPartKey(uploadID, partNumber))
	}
	return keys
}

func retryMaintenance(ctx context.Context, maxRetries int, operation func() error) error {
	if operation == nil {
		return errors.New("maintenance operation is required")
	}
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := operation()
		if err == nil {
			return nil
		}
		if attempt >= maxRetries || ctx.Err() != nil {
			return err
		}
		delay := time.Duration(attempt+1) * 25 * time.Millisecond
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func withMaintenanceObjectTimeout[T any](ctx context.Context, timeout time.Duration, operation func(context.Context) (T, error)) (T, error) {
	var zero T
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	if operation == nil {
		return zero, errors.New("maintenance operation is required")
	}
	if timeout <= 0 {
		timeout = DefaultUploadMaintenanceObjectTimeout
	}
	objectCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return operation(objectCtx)
}

func withMaintenanceObjectTimeoutErr(ctx context.Context, timeout time.Duration, operation func(context.Context) error) error {
	_, err := withMaintenanceObjectTimeout(ctx, timeout, func(objectCtx context.Context) (struct{}, error) {
		return struct{}{}, operation(objectCtx)
	})
	return err
}

func transferActivity(transfer TransferRecord) time.Time {
	if transfer.LastActivityAt != nil && !transfer.LastActivityAt.IsZero() {
		return transfer.LastActivityAt.UTC()
	}
	return transfer.CreatedAt.UTC()
}

func maintenanceCursorFor(record StaleUploadRecord) *UploadMaintenanceCursor {
	return &UploadMaintenanceCursor{ActivityAt: transferActivity(record.Transfer), ID: record.Transfer.ID}
}

func maintenanceRecordLess(left, right StaleUploadRecord) bool {
	leftAt, rightAt := transferActivity(left.Transfer), transferActivity(right.Transfer)
	if leftAt.Equal(rightAt) {
		return left.Transfer.ID < right.Transfer.ID
	}
	return leftAt.Before(rightAt)
}

func maintenanceRecordAfter(record StaleUploadRecord, cursor *UploadMaintenanceCursor) bool {
	if cursor == nil {
		return true
	}
	activity := transferActivity(record.Transfer)
	return activity.After(cursor.ActivityAt) || (activity.Equal(cursor.ActivityAt) && record.Transfer.ID > cursor.ID)
}

func isTerminalUploadStatus(status string) bool {
	switch status {
	case string(TransferCompleted), string(TransferFailed), string(TransferReleased):
		return true
	default:
		return false
	}
}

func cloneAttemptCursors(source map[string]string) map[string]string {
	if len(source) == 0 {
		return make(map[string]string)
	}
	keys := make([]string, 0, len(source))
	for key, value := range source {
		if strings.TrimSpace(key) == "" || value == "" {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(keys) > MaxUploadMaintenanceAttemptCursors {
		keys = keys[len(keys)-MaxUploadMaintenanceAttemptCursors:]
	}
	result := make(map[string]string, len(keys))
	for _, key := range keys {
		result[key] = source[key]
	}
	return result
}

func rememberAttemptCursor(target map[string]string, uploadID, cursor string) {
	if target == nil {
		return
	}
	if strings.TrimSpace(uploadID) == "" || cursor == "" {
		delete(target, uploadID)
		return
	}
	if _, exists := target[uploadID]; !exists && len(target) >= MaxUploadMaintenanceAttemptCursors {
		keys := make([]string, 0, len(target))
		for key := range target {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		if len(keys) > 0 {
			delete(target, keys[0])
		}
	}
	target[uploadID] = cursor
}

func cloneUploadMaintenanceCursor(cursor *UploadMaintenanceCursor) *UploadMaintenanceCursor {
	if cursor == nil {
		return nil
	}
	copy := *cursor
	copy.ActivityAt = copy.ActivityAt.UTC()
	return &copy
}
