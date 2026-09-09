package main

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

const (
	providerDriverUnknown = "unknown"
	providerDriverLocal   = "local"
	providerDriverS3      = "s3"

	providerStatusReady         = "ready"
	providerStatusBlocked       = "blocked"
	providerStatusFailed        = "failed"
	providerStatusNotApplicable = "not_applicable"
	providerStatusNotChecked    = "not_checked"

	providerCodeNotApplicable    = "provider_not_applicable"
	providerCodeDatabaseNotReady = "database_not_ready"
	providerCodeConfigInvalid    = "provider_config_invalid"
	providerCodeCheckFailed      = "provider_check_failed"
)

var (
	errProviderConfig = errors.New("provider configuration is invalid")
	errProviderCheck  = errors.New("provider observation failed")
)

// providerReport is the command's outer provider observation. The database
// snapshot deliberately retains its Provider=not_checked field: PostgreSQL
// cannot prove provider state, so this separate field exists only when the
// operator explicitly requests the bounded provider read.
type providerReport struct {
	Driver   string `json:"driver"`
	Status   string `json:"status"`
	Code     string `json:"code,omitempty"`
	ReadOnly bool   `json:"readOnly"`
}

func observeConfiguredProvider(ctx context.Context) (providerReport, error) {
	report := providerReport{
		Driver:   providerDriverUnknown,
		Status:   providerStatusFailed,
		Code:     providerCodeConfigInvalid,
		ReadOnly: true,
	}
	if ctx == nil {
		report.Code = providerCodeCheckFailed
		return report, errProviderCheck
	}
	if err := ctx.Err(); err != nil {
		report.Code = providerCodeCheckFailed
		return report, err
	}

	driver := strings.ToLower(strings.TrimSpace(os.Getenv(config.WorkspaceStorageDriverEnv)))
	if driver == "" {
		driver = providerDriverLocal
	}
	switch driver {
	case providerDriverLocal:
		return providerReport{
			Driver:   providerDriverLocal,
			Status:   providerStatusNotApplicable,
			Code:     providerCodeNotApplicable,
			ReadOnly: true,
		}, nil
	case providerDriverS3:
		report.Driver = providerDriverS3
		store, err := configuredS3Store()
		if err != nil {
			return report, err
		}
		observed, err := store.CheckMultipartQuiescence(ctx)
		switch observed.Code {
		case storage.MultipartQuiescenceReadyCode:
			return providerReport{
				Driver:   providerDriverS3,
				Status:   providerStatusReady,
				Code:     storage.MultipartQuiescenceReadyCode,
				ReadOnly: true,
			}, nil
		case storage.MultipartQuiescenceBlockedCode:
			// An upload is a safe, observed blocker rather than an observer
			// failure. CheckMultipartQuiescence also returns an error for this
			// state; its fixed code is intentionally not propagated as raw text.
			return providerReport{
				Driver:   providerDriverS3,
				Status:   providerStatusBlocked,
				Code:     storage.MultipartQuiescenceBlockedCode,
				ReadOnly: true,
			}, nil
		default:
			if errors.Is(err, context.Canceled) {
				return providerReport{
					Driver:   providerDriverS3,
					Status:   providerStatusFailed,
					Code:     providerCodeCheckFailed,
					ReadOnly: true,
				}, context.Canceled
			}
			if errors.Is(err, context.DeadlineExceeded) {
				return providerReport{
					Driver:   providerDriverS3,
					Status:   providerStatusFailed,
					Code:     providerCodeCheckFailed,
					ReadOnly: true,
				}, context.DeadlineExceeded
			}
			return providerReport{
				Driver:   providerDriverS3,
				Status:   providerStatusFailed,
				Code:     providerCodeCheckFailed,
				ReadOnly: true,
			}, errProviderCheck
		}
	default:
		report.Driver = providerDriverUnknown
		return report, errProviderConfig
	}
}

func configuredS3Store() (*storage.S3BlobStore, error) {
	credentialsPath := strings.TrimSpace(os.Getenv(config.WorkspaceS3CredentialsFileEnv))
	if !regularNonSymlink(credentialsPath) {
		return nil, errProviderConfig
	}
	credentials, err := config.LoadS3Credentials(credentialsPath)
	if err != nil {
		return nil, errProviderConfig
	}
	store, err := storage.NewS3BlobStore(storage.S3Config{
		Endpoint:  strings.TrimSpace(os.Getenv(config.WorkspaceS3EndpointEnv)),
		Region:    strings.TrimSpace(os.Getenv(config.WorkspaceS3RegionEnv)),
		Bucket:    strings.TrimSpace(os.Getenv(config.WorkspaceS3BucketEnv)),
		AccessKey: credentials.AccessKey,
		SecretKey: credentials.SecretKey,
	})
	if err != nil {
		return nil, errProviderConfig
	}
	return store, nil
}

// regularNonSymlink is a pre-open check for the private credential file. It
// is intentionally not described as a race-proof root-file guarantee: the
// existing config loader remains the single parser and its bounded read.
func regularNonSymlink(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	return info.Mode().IsRegular()
}
