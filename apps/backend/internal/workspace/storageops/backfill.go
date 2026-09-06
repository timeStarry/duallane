package storageops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

const defaultBackfillPageSize = 32

// The cleanup window is intentionally bounded. It remains a variable so the
// focused lease-lifecycle test can model an aged run without sleeping for the
// production five-second window.
var mutationCleanupTimeout = 5 * time.Second

type BackfillOptions struct {
	Journal             BackfillJournal
	Store               BackfillStore
	Guard               MutationGuard
	RunID               string
	ManifestFingerprint string
	PageSize            int
	Now                 func() time.Time
}

type BackfillReport struct {
	Run     BackfillRun
	Summary BackfillSummary
	Status  string
}

// RunBackfill processes one bounded page at a time. It intentionally does not
// own a scheduler, CLI flag, owner transition, quota ledger, audit stream, or
// event stream. Those concerns remain with the parent coordinator and the
// existing Workspace service owner.
func RunBackfill(ctx context.Context, options BackfillOptions) (report BackfillReport, err error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := validateBackfillOptions(options); err != nil {
		return report, err
	}
	if options.PageSize == 0 {
		options.PageSize = defaultBackfillPageSize
	}
	now := options.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}

	lease, err := options.Guard.Acquire(ctx, MutationAcquireRequest{
		RunID:               options.RunID,
		Operation:           BackfillOperation,
		ManifestFingerprint: strings.TrimSpace(options.ManifestFingerprint),
	})
	if err != nil {
		return report, backfillError("storageops.mutation_acquire_failed", err)
	}
	released := false
	release := func(primary error) error {
		if released {
			return primary
		}
		released = true
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), mutationCleanupTimeout)
		defer cleanupCancel()
		releaseErr := options.Guard.Release(cleanupCtx, lease)
		if releaseErr == nil {
			return primary
		}
		return backfillError("storageops.mutation_release_failed", errors.Join(primary, releaseErr))
	}
	defer func() {
		err = release(err)
	}()

	if err := validateLease(lease, options.RunID); err != nil {
		return report, err
	}
	if err := assertLease(ctx, options.Guard, lease); err != nil {
		return report, err
	}

	run, err := options.Journal.BeginOrResume(ctx, BackfillRunRequest{
		RunID:               options.RunID,
		ManifestFingerprint: strings.TrimSpace(options.ManifestFingerprint),
		FenceTokenHash:      FenceTokenHash(lease.Token),
	})
	if err != nil {
		return report, err
	}
	report.Run = run
	if run.State == "completed" {
		report, err = readBackfillReport(ctx, options.Journal, report)
		return report, err
	}
	if run.State != "running" {
		return report, backfillError("storageops.backfill_state_invalid", nil)
	}

	for {
		if err := assertLease(ctx, options.Guard, lease); err != nil {
			return report, err
		}
		page, pageErr := options.Journal.ListPage(ctx, run.ID, run.Phase, run.Cursor, options.PageSize)
		if pageErr != nil {
			return failBackfill(ctx, options, lease, run, report, pageErr, now())
		}
		if len(page.Items) == 0 {
			if run.Phase == BackfillPhaseRoot {
				if err := assertLease(ctx, options.Guard, lease); err != nil {
					return report, err
				}
				run, err = options.Journal.EnsureCloneItems(ctx, run, now())
				if err != nil {
					return failBackfill(ctx, options, lease, run, report, err, now())
				}
				report.Run = run
				continue
			}
			if err := assertLease(ctx, options.Guard, lease); err != nil {
				return report, err
			}
			run, err = options.Journal.Complete(ctx, run, now())
			if err != nil {
				return failBackfill(ctx, options, lease, run, report, err, now())
			}
			report.Run = run
			report, err = readBackfillReport(ctx, options.Journal, report)
			return report, err
		}

		for _, item := range page.Items {
			if err := assertLease(ctx, options.Guard, lease); err != nil {
				return report, err
			}
			result, itemErr := processBackfillItem(ctx, options.Store, options.Journal, options.Guard, lease, item, now())
			if itemErr != nil {
				return failItemBackfill(ctx, options, lease, run, report, item, itemErr, now())
			}
			if err := assertLease(ctx, options.Guard, lease); err != nil {
				return report, err
			}
			if err := options.Journal.MarkItemCompleted(ctx, item, result, now()); err != nil {
				return failItemBackfill(ctx, options, lease, run, report, item, err, now())
			}
		}

		if err := assertLease(ctx, options.Guard, lease); err != nil {
			return report, err
		}
		last := page.Items[len(page.Items)-1]
		run, err = options.Journal.Advance(ctx, run, BackfillCursor{Kind: last.Kind, ResourceID: last.ResourceID}, int64(len(page.Items)), now())
		if err != nil {
			return failBackfill(ctx, options, lease, run, report, err, now())
		}
		report.Run = run
	}
}

func validateBackfillOptions(options BackfillOptions) error {
	if options.Journal == nil {
		return backfillError("storageops.journal_required", nil)
	}
	if options.Store == nil {
		return backfillError("storageops.store_required", nil)
	}
	if options.Guard == nil {
		return backfillError("storageops.mutation_guard_required", nil)
	}
	if strings.TrimSpace(options.RunID) == "" {
		return backfillError("storageops.run_id_required", nil)
	}
	if strings.TrimSpace(options.ManifestFingerprint) == "" {
		return backfillError("storageops.manifest_fingerprint_required", nil)
	}
	if options.PageSize < 0 || options.PageSize > 1000 {
		return backfillError("storageops.page_size_invalid", nil)
	}
	return nil
}

func assertLease(ctx context.Context, guard MutationGuard, lease MutationLease) error {
	if err := guard.Assert(ctx, lease); err != nil {
		return backfillError("storageops.mutation_assert_failed", err)
	}
	return nil
}

func processBackfillItem(ctx context.Context, store BackfillStore, journal BackfillJournal, guard MutationGuard, lease MutationLease, item BackfillItem, at time.Time) (BackfillResult, error) {
	if item.Phase == BackfillPhaseClone {
		if item.Kind != "customEmote" {
			return BackfillResult{}, backfillError("storageops.clone_kind_invalid", nil)
		}
		if err := assertLease(ctx, guard, lease); err != nil {
			return BackfillResult{}, err
		}
		return journal.BindClone(ctx, item, at)
	}
	if item.Phase != BackfillPhaseRoot {
		return BackfillResult{}, backfillError("storageops.item_phase_invalid", nil)
	}

	if strings.TrimSpace(item.ExistingStorageObjectID) != "" {
		registered, err := journal.LoadObject(ctx, item.ExistingStorageObjectID)
		if err != nil {
			return BackfillResult{}, err
		}
		candidate := objectFromCanonical(registered, item.ContentType)
		opened, openErr := store.Open(ctx, storage.Object{
			Key:         candidate.ObjectKey,
			SHA256:      candidate.SHA256,
			ByteSize:    candidate.ByteSize,
			ContentType: candidate.ContentType,
		}, storage.DefaultMaxObjectBytes)
		if openErr == nil {
			if err := verifyCanonicalObject(ctx, opened, candidate); err != nil {
				return BackfillResult{}, err
			}
			if err := assertLease(ctx, guard, lease); err != nil {
				return BackfillResult{}, err
			}
			return journal.AcquireAndBind(ctx, item, candidate, at)
		}
		if !isStorageMissing(openErr) {
			return BackfillResult{}, backfillError("storageops.canonical_open_failed", openErr)
		}
		inspection, inspectErr := store.InspectLegacy(ctx, item)
		if inspectErr != nil {
			return BackfillResult{}, backfillError("storageops.legacy_inspect_failed", inspectErr)
		}
		if err := validateLegacyInspection(item, inspection, registered.SHA256); err != nil {
			return BackfillResult{}, err
		}
		return putLegacyAndBind(ctx, store, journal, guard, lease, item, inspection, at)
	}

	inspection, err := store.InspectLegacy(ctx, item)
	if err != nil {
		return BackfillResult{}, backfillError("storageops.legacy_inspect_failed", err)
	}
	if err := validateLegacyInspection(item, inspection, ""); err != nil {
		return BackfillResult{}, err
	}
	return putLegacyAndBind(ctx, store, journal, guard, lease, item, inspection, at)
}

// verifyCanonicalObject consumes the bounded canonical stream to EOF before a
// registry bind. Some providers verify their digest only while the response
// body is fully read, so opening and closing alone is not proof of identity.
func verifyCanonicalObject(ctx context.Context, opened storage.OpenedObject, expected BackfillObject) error {
	readLimit, sizeErr := canonicalReadLimit(expected.ByteSize)
	if sizeErr != nil {
		if opened.Body != nil {
			_ = opened.Body.Close()
		}
		return sizeErr
	}
	if opened.Body == nil {
		return backfillError("storageops.canonical_body_missing", nil)
	}
	digest := sha256.New()
	read, readErr := io.Copy(digest, io.LimitReader(opened.Body, readLimit))
	closeErr := opened.Body.Close()
	if readErr != nil {
		return backfillError("storageops.canonical_read_failed", readErr)
	}
	if closeErr != nil {
		return backfillError("storageops.canonical_close_failed", closeErr)
	}
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return backfillError("storageops.canonical_read_failed", err)
		}
	}
	if read != expected.ByteSize {
		return backfillError("storageops.canonical_size_mismatch", nil)
	}
	normalized, err := storage.NormalizeSHA256(expected.SHA256)
	if err != nil {
		return backfillError("storageops.canonical_digest_invalid", err)
	}
	if hex.EncodeToString(digest.Sum(nil)) != normalized {
		return backfillError("storageops.canonical_digest_mismatch", nil)
	}
	if opened.Object.Key != "" && opened.Object.Key != expected.ObjectKey {
		return backfillError("storageops.canonical_key_mismatch", nil)
	}
	if opened.Object.ByteSize != 0 && opened.Object.ByteSize != expected.ByteSize {
		return backfillError("storageops.canonical_size_mismatch", nil)
	}
	if expectedType := strings.TrimSpace(expected.ContentType); expectedType != "" && opened.Object.ContentType != "" && !strings.EqualFold(expectedType, strings.TrimSpace(opened.Object.ContentType)) {
		return backfillError("storageops.canonical_content_type_mismatch", nil)
	}
	return nil
}

func canonicalReadLimit(expectedByteSize int64) (int64, error) {
	if expectedByteSize < 0 || expectedByteSize > storage.DefaultMaxObjectBytes {
		return 0, backfillError("storageops.canonical_size_invalid", nil)
	}
	return expectedByteSize + 1, nil
}

func putLegacyAndBind(ctx context.Context, store BackfillStore, journal BackfillJournal, guard MutationGuard, lease MutationLease, item BackfillItem, inspection LegacyInspection, at time.Time) (BackfillResult, error) {
	digest, err := storage.NormalizeSHA256(inspection.SHA256)
	if err != nil {
		return BackfillResult{}, backfillError("storageops.legacy_digest_invalid", err)
	}
	key, err := storage.CanonicalObjectKey(digest)
	if err != nil {
		return BackfillResult{}, backfillError("storageops.canonical_key_invalid", err)
	}
	opened, err := store.OpenLegacy(ctx, item)
	if err != nil {
		return BackfillResult{}, backfillError("storageops.legacy_open_failed", err)
	}
	if opened.Body == nil {
		return BackfillResult{}, backfillError("storageops.legacy_body_missing", nil)
	}
	if err := assertLease(ctx, guard, lease); err != nil {
		_ = opened.Body.Close()
		return BackfillResult{}, err
	}
	stored, putErr := store.Put(ctx, key, opened.Body, inspection.ByteSize, digest)
	closeErr := opened.Body.Close()
	if putErr != nil {
		return BackfillResult{}, backfillError("storageops.canonical_put_failed", putErr)
	}
	if closeErr != nil {
		return BackfillResult{}, backfillError("storageops.legacy_close_failed", closeErr)
	}
	if stored.Object.ByteSize != inspection.ByteSize {
		return BackfillResult{}, backfillError("storageops.canonical_size_invalid", nil)
	}
	if err := assertLease(ctx, guard, lease); err != nil {
		return BackfillResult{}, err
	}
	return journal.AcquireAndBind(ctx, item, BackfillObject{
		ID:          "wso_" + digest,
		SHA256:      digest,
		ObjectKey:   key,
		ByteSize:    inspection.ByteSize,
		ContentType: item.ContentType,
	}, at)
}

func validateLegacyInspection(item BackfillItem, inspection LegacyInspection, existingDigest string) error {
	digest, err := storage.NormalizeSHA256(inspection.SHA256)
	if err != nil {
		return backfillError("storageops.legacy_digest_invalid", err)
	}
	if expected := strings.TrimSpace(item.ExpectedSHA256); expected != "" {
		normalized, normalizeErr := storage.NormalizeSHA256(expected)
		if normalizeErr != nil || normalized != digest {
			return backfillError("storageops.legacy_digest_mismatch", normalizeErr)
		}
	}
	if expected := strings.TrimSpace(existingDigest); expected != "" {
		normalized, normalizeErr := storage.NormalizeSHA256(expected)
		if normalizeErr != nil || normalized != digest {
			return backfillError("storageops.legacy_digest_mismatch", normalizeErr)
		}
	}
	if item.ExpectedByteSize != nil && *item.ExpectedByteSize != inspection.ByteSize {
		return backfillError("storageops.legacy_size_mismatch", nil)
	}
	if inspection.ByteSize < 0 || inspection.ByteSize > storage.DefaultMaxObjectBytes {
		return backfillError("storageops.legacy_size_invalid", nil)
	}
	return nil
}

func objectFromCanonical(object CanonicalObject, contentType string) BackfillObject {
	return BackfillObject{
		ID:          object.ID,
		SHA256:      object.SHA256,
		ObjectKey:   object.ObjectKey,
		ByteSize:    object.ByteSize,
		ContentType: contentType,
	}
}

func isStorageMissing(err error) bool {
	var physical *storage.Error
	return errors.As(err, &physical) && physical != nil && physical.Code == "file.storage_missing"
}

func failItemBackfill(ctx context.Context, options BackfillOptions, lease MutationLease, run BackfillRun, report BackfillReport, item BackfillItem, itemErr error, at time.Time) (BackfillReport, error) {
	if assertErr := assertLease(ctx, options.Guard, lease); assertErr == nil {
		_ = options.Journal.MarkItemFailed(ctx, item, BackfillErrorCode(itemErr), at)
		return failBackfill(ctx, options, lease, run, report, itemErr, at)
	}
	return report, itemErr
}

func failBackfill(ctx context.Context, options BackfillOptions, lease MutationLease, run BackfillRun, report BackfillReport, cause error, at time.Time) (BackfillReport, error) {
	if assertErr := assertLease(ctx, options.Guard, lease); assertErr != nil {
		return report, cause
	}
	failed, failErr := options.Journal.Fail(ctx, run, BackfillErrorCode(cause), at)
	if failErr == nil {
		report.Run = failed
		if summary, summaryErr := options.Journal.Summary(ctx, run.ID); summaryErr == nil {
			report.Summary = summary
		}
	}
	return report, cause
}

func readBackfillReport(ctx context.Context, journal BackfillJournal, report BackfillReport) (BackfillReport, error) {
	summary, err := journal.Summary(ctx, report.Run.ID)
	if err != nil {
		return report, err
	}
	report.Summary = summary
	report.Status = summary.State
	return report, nil
}
