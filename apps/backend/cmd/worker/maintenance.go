package main

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

// uploadMaintenanceService keeps the worker composition testable without
// exposing worker state or PostgreSQL details from the files package.
type uploadMaintenanceService interface {
	RunUploadMaintenance(context.Context, files.UploadMaintenanceOptions) (files.UploadMaintenanceResult, error)
}

// maintenanceRunner owns cursors for one worker process. Cursors are not
// persisted as user data: PostgreSQL remains the cross-process arbiter while
// these values only prevent one process from restarting at page one every
// bounded cycle.
type maintenanceRunner struct {
	uploads uploadMaintenanceService
	store   platformstorage.BlobStore
	now     func() time.Time

	mu              sync.Mutex
	uploadCursor    *files.UploadMaintenanceCursor
	attemptCursors  map[string]string
	multipartCursor string
}

func newMaintenanceRunner(service *files.Service, store platformstorage.BlobStore) *maintenanceRunner {
	return &maintenanceRunner{uploads: service, store: store, now: time.Now}
}

func (runner *maintenanceRunner) processors() []workerProcessor {
	processors := []workerProcessor{{
		name: "upload_storage_maintenance", interval: files.DefaultUploadMaintenanceInterval,
		process: runner.processUploads,
	}}
	if _, ok := runner.store.(platformstorage.MultipartMaintenance); ok {
		// Each family owns a separate goroutine and budget. Slow staging I/O
		// must not starve provider multipart cleanup for every subsequent cycle.
		processors = append(processors, workerProcessor{
			name: "multipart_maintenance", interval: platformstorage.DefaultMultipartMaintenanceInterval,
			process: runner.processMultipart,
		})
	}
	return processors
}

func (runner *maintenanceRunner) processUploads(ctx context.Context) (processResult, error) {
	if runner == nil || runner.uploads == nil {
		return processResult{}, errors.New("workspace maintenance service is required")
	}
	if ctx == nil {
		return processResult{}, context.Canceled
	}
	if err := ctx.Err(); err != nil {
		return processResult{}, err
	}

	cycleCtx, cancel := context.WithTimeout(ctx, files.DefaultUploadMaintenanceTimeout)
	defer cancel()
	now := time.Now().UTC()
	if runner.now != nil {
		now = runner.now().UTC()
	}
	cursor, attemptCursors := runner.uploadState()
	uploadResult, uploadErr := runner.uploads.RunUploadMaintenance(cycleCtx, files.UploadMaintenanceOptions{
		Now:                      now,
		BatchSize:                files.DefaultUploadMaintenanceBatchSize,
		Timeout:                  files.DefaultUploadMaintenanceTimeout,
		ObjectTimeout:            files.DefaultUploadMaintenanceObjectTimeout,
		IncludeTerminalArtifacts: true,
		Cursor:                   cursor,
		AttemptCursors:           attemptCursors,
	})
	runner.updateUploadState(uploadResult, attemptCursors)

	result := processResult{
		Claimed: uploadResult.Scanned,
		Failed:  uploadResult.Errors + uploadResult.ObjectFailures,
	}
	var cycleErr error
	if uploadErr != nil {
		cycleErr = uploadErr
		if result.Failed == 0 {
			result.Failed = 1
		}
	}

	if err := cycleCtx.Err(); err != nil {
		return result, errors.Join(cycleErr, err)
	}
	return result, cycleErr
}

func (runner *maintenanceRunner) processMultipart(ctx context.Context) (processResult, error) {
	if ctx == nil {
		return processResult{}, context.Canceled
	}
	if err := ctx.Err(); err != nil {
		return processResult{}, err
	}
	if runner == nil {
		return processResult{}, errors.New("workspace maintenance service is required")
	}
	maintenance, ok := runner.store.(platformstorage.MultipartMaintenance)
	if !ok {
		return processResult{}, nil
	}
	now := time.Now().UTC()
	if runner.now != nil {
		now = runner.now().UTC()
	}
	result, err := runner.runMultipart(ctx, maintenance, now)
	return processResult{Claimed: result.Scanned, Failed: multipartFailures(result, err)}, err
}

func (runner *maintenanceRunner) uploadState() (*files.UploadMaintenanceCursor, map[string]string) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return cloneWorkerCursor(runner.uploadCursor), cloneWorkerAttemptCursors(runner.attemptCursors)
}

func (runner *maintenanceRunner) updateUploadState(result files.UploadMaintenanceResult, previous map[string]string) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.uploadCursor = cloneWorkerCursor(result.Next)
	if result.AttemptCursors != nil {
		runner.attemptCursors = cloneWorkerAttemptCursors(result.AttemptCursors)
	} else {
		runner.attemptCursors = cloneWorkerAttemptCursors(previous)
	}
}

func (runner *maintenanceRunner) runMultipart(ctx context.Context, maintenance platformstorage.MultipartMaintenance, now time.Time) (platformstorage.MultipartMaintenanceResult, error) {
	if err := ctx.Err(); err != nil {
		return platformstorage.MultipartMaintenanceResult{}, err
	}
	runner.mu.Lock()
	cursor := runner.multipartCursor
	runner.mu.Unlock()
	objectCtx, cancel := context.WithTimeout(ctx, platformstorage.DefaultMaintenanceObjectTimeout)
	result, err := maintenance.AbortStaleMultipartUploads(
		objectCtx,
		now.Add(-platformstorage.DefaultMultipartMaintenanceAge),
		cursor,
		platformstorage.DefaultMaintenanceBatchSize,
	)
	cancel()
	runner.mu.Lock()
	if err == nil || result.Scanned > 0 || result.NextCursor != "" {
		// Empty is the provider's end-of-keyspace marker. Retaining a non-empty
		// marker across cycles is what prevents early multipart objects from
		// monopolizing the bounded worker budget.
		runner.multipartCursor = result.NextCursor
	}
	runner.mu.Unlock()
	return result, err
}

func multipartFailures(result platformstorage.MultipartMaintenanceResult, err error) int {
	if err == nil {
		return 0
	}
	if result.Scanned-result.Aborted > 0 {
		return result.Scanned - result.Aborted
	}
	return 1
}

func cloneWorkerCursor(cursor *files.UploadMaintenanceCursor) *files.UploadMaintenanceCursor {
	if cursor == nil {
		return nil
	}
	copy := *cursor
	copy.ActivityAt = copy.ActivityAt.UTC()
	return &copy
}

func cloneWorkerAttemptCursors(source map[string]string) map[string]string {
	if len(source) == 0 {
		return make(map[string]string)
	}
	result := make(map[string]string, len(source))
	for key, value := range source {
		if key != "" && value != "" {
			result[key] = value
		}
	}
	if len(result) <= files.MaxUploadMaintenanceAttemptCursors {
		return result
	}
	// The files package applies the authoritative bound to the service result;
	// this second copy keeps worker-owned state bounded even when a test double
	// returns an oversized map.
	keys := make([]string, 0, len(result))
	for key := range result {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for len(result) > files.MaxUploadMaintenanceAttemptCursors {
		delete(result, keys[0])
		keys = keys[1:]
	}
	return result
}

func newMaintenanceBlobStore(ctx context.Context, runtimeConfig config.WorkspaceConfig) (platformstorage.BlobStore, error) {
	newLocal := func() (*platformstorage.LocalBlobStore, error) {
		if runtimeConfig.WorkerValidateOnly {
			return platformstorage.OpenExistingLocalBlobStore(ctx, runtimeConfig.LocalStorageRoot())
		}
		return platformstorage.NewLocalBlobStore(runtimeConfig.LocalStorageRoot())
	}
	if runtimeConfig.StorageDriver != "s3" {
		return newLocal()
	}
	credentials, err := config.LoadS3Credentials(runtimeConfig.S3CredentialsFile)
	if err != nil {
		return nil, err
	}
	primary, err := platformstorage.NewS3BlobStore(platformstorage.S3Config{
		Endpoint: runtimeConfig.S3Endpoint, Region: runtimeConfig.S3Region, Bucket: runtimeConfig.S3Bucket,
		AccessKey: credentials.AccessKey, SecretKey: credentials.SecretKey,
	})
	if err != nil {
		return nil, err
	}
	readyCtx, cancelReady := context.WithTimeout(ctx, platformstorage.DefaultMaintenanceObjectTimeout)
	defer cancelReady()
	if err := primary.AssertReady(readyCtx); err != nil {
		return nil, err
	}
	if !runtimeConfig.LocalReadFallback && !runtimeConfig.LocalMirrorWrite {
		return primary, nil
	}
	local, err := newLocal()
	if err != nil {
		return nil, err
	}
	return platformstorage.NewHybridBlobStore(platformstorage.HybridBlobStoreOptions{
		Primary: primary, Local: local, LocalReadFallback: runtimeConfig.LocalReadFallback,
		LocalMirrorWrite: runtimeConfig.LocalMirrorWrite,
	})
}
