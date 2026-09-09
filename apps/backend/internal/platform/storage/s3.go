package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	platformmetrics "github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
)

const (
	defaultS3Region         = "us-east-1"
	defaultS3ContentType    = "application/octet-stream"
	s3UnavailableCode       = "file.storage_unavailable"
	s3UnavailableMessage    = "文件存储暂时不可用"
	s3BucketPatternMaxBytes = 63
	s3ObjectKeyMaxBytes     = 1024
)

var s3BucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

// S3Config contains only the private object-store connection settings. Public
// delivery endpoints and presigning belong to the HTTP delivery boundary, not
// to BlobStore.
type S3Config struct {
	Endpoint  string
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
}

// S3BlobStore implements BlobStore against an S3-compatible private bucket.
// It intentionally exposes no provider client, signed URL, bucket key, or
// credential data through its public methods.
type S3BlobStore struct {
	bucket   string
	client   s3API
	observer *operationObserver
}

// S3BlobStoreOptions adds optional, privacy-safe operation observation while
// keeping S3Config limited to provider connection settings.
type S3BlobStoreOptions struct {
	Config S3Config
	ObservationOptions
}

var _ BlobStore = (*S3BlobStore)(nil)

type s3API interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
	HeadBucket(context.Context, *s3.HeadBucketInput, ...func(*s3.Options)) (*s3.HeadBucketOutput, error)
	ListObjectsV2(context.Context, *s3.ListObjectsV2Input, ...func(*s3.Options)) (*s3.ListObjectsV2Output, error)
	ListMultipartUploads(context.Context, *s3.ListMultipartUploadsInput, ...func(*s3.Options)) (*s3.ListMultipartUploadsOutput, error)
	AbortMultipartUpload(context.Context, *s3.AbortMultipartUploadInput, ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error)
}

// AssertReady verifies that the configured private bucket is reachable using
// the same authenticated client used for object operations.
func (s *S3BlobStore) AssertReady(ctx context.Context) error {
	if err := s.valid(); err != nil {
		return err
	}
	if _, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)}); err != nil {
		return s3ProviderError("inspect bucket", err)
	}
	return nil
}

// NewS3BlobStore validates the Node-compatible S3 settings and creates a
// path-style, SigV4-authenticated client. The bucket remains private because
// no ACL or public delivery configuration is sent by this adapter.
func NewS3BlobStore(config S3Config) (*S3BlobStore, error) {
	return NewS3BlobStoreWithOptions(S3BlobStoreOptions{Config: config})
}

// NewS3BlobStoreWithOptions constructs an S3 store with optional operation
// observation. The concrete S3BlobStore continues to expose its optional
// maintenance and legacy-reader capabilities.
func NewS3BlobStoreWithOptions(options S3BlobStoreOptions) (*S3BlobStore, error) {
	normalized, err := normalizeS3Config(options.Config)
	if err != nil {
		return nil, err
	}
	credentials := aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{
			AccessKeyID:     normalized.AccessKey,
			SecretAccessKey: normalized.SecretKey,
			Source:          "workspace-s3-static",
		}, nil
	})
	awsConfig := aws.Config{
		Region:       normalized.Region,
		Credentials:  credentials,
		BaseEndpoint: aws.String(normalized.Endpoint),
	}
	client := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		options.UsePathStyle = true
		// Some S3-compatible gateways reject optional checksum headers on
		// requests or responses, matching the Node adapter's settings.
		options.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		options.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	return &S3BlobStore{bucket: normalized.Bucket, client: client, observer: newOperationObserver(options.ObservationOptions)}, nil
}

func normalizeS3Config(config S3Config) (S3Config, error) {
	endpoint := strings.TrimSpace(config.Endpoint)
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" || (parsed.Path != "" && parsed.Path != "/") || !isHTTPURL(parsed.Scheme) {
		return S3Config{}, invalidS3ConfigError()
	}
	if parsed.Path == "/" {
		parsed.Path = ""
	}
	endpoint = strings.TrimSuffix(parsed.String(), "/")
	region := strings.TrimSpace(config.Region)
	if region == "" {
		region = defaultS3Region
	}
	bucket := strings.TrimSpace(config.Bucket)
	if len(bucket) > s3BucketPatternMaxBytes || !s3BucketPattern.MatchString(bucket) {
		return S3Config{}, invalidS3ConfigError()
	}
	accessKey := strings.TrimSpace(config.AccessKey)
	secretKey := strings.TrimSpace(config.SecretKey)
	if accessKey == "" || secretKey == "" {
		return S3Config{}, invalidS3ConfigError()
	}
	return S3Config{Endpoint: endpoint, Region: region, Bucket: bucket, AccessKey: accessKey, SecretKey: secretKey}, nil
}

func isHTTPURL(scheme string) bool {
	return scheme == "http" || scheme == "https"
}

func invalidS3ConfigError() *Error {
	return newError("storage.config_invalid", "对象存储配置无效", 500, errors.New("object storage configuration is invalid"))
}

func (s *S3BlobStore) valid() error {
	if s == nil || strings.TrimSpace(s.bucket) == "" || s.client == nil {
		return internalError("workspace S3 storage", errors.New("S3 client is required"))
	}
	return nil
}

func (s *S3BlobStore) Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (stored StoredObject, err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	var counted *countedReader
	if observer != nil && source != nil {
		counted = &countedReader{source: source}
		source = counted
	}
	defer func() {
		var bytes int64
		if counted != nil {
			bytes = counted.bytes
		}
		outcome := platformmetrics.ObjectOutcomeFailure
		if err == nil {
			outcome = platformmetrics.ObjectOutcomeSuccess
		}
		observer.observe(platformmetrics.ObjectOperationPut, outcome, bytes)
	}()
	if err := s.valid(); err != nil {
		return StoredObject{}, err
	}
	if err := validateByteSize(expectedSize, true); err != nil {
		return StoredObject{}, err
	}
	expectedSHA256, err = validateExpectedHash(expectedSHA256)
	if err != nil {
		return StoredObject{}, err
	}
	if err := validateS3ObjectKey(key, expectedSHA256); err != nil {
		return StoredObject{}, err
	}
	if source == nil {
		return StoredObject{}, newError("upload.invalid_content", "上传内容不能为空", 400, errors.New("source is nil"))
	}
	head, headErr := s.headObject(ctx, key)
	if headErr == nil && expectedSHA256 != "" {
		if !s3HeadMatches(head, expectedSize, expectedSHA256) {
			return StoredObject{}, s3ObjectConflictError()
		}
		return StoredObject{Object: s3ObjectFromHead(key, expectedSHA256, expectedSize, head), Reused: true}, nil
	}
	if headErr != nil && !isS3NotFound(headErr) {
		return StoredObject{}, s3ProviderError("inspect object", headErr)
	}
	staged, stageErr := stageS3Upload(ctx, source, expectedSize, expectedSHA256)
	if stageErr != nil {
		return StoredObject{}, stageErr
	}
	defer staged.cleanup()

	putInput := &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(key),
		Body:          staged.file,
		ContentLength: aws.Int64(expectedSize),
		ContentType:   aws.String(defaultS3ContentType),
		Metadata: map[string]string{
			"duallane-size": strconv.FormatInt(expectedSize, 10),
		},
	}
	if expectedSHA256 != "" {
		putInput.IfNoneMatch = aws.String("*")
		putInput.Metadata["duallane-sha256"] = expectedSHA256
	}
	if _, err := s.client.PutObject(ctx, putInput); err != nil {
		if expectedSHA256 != "" && isS3ConditionalFailure(err) {
			return s.resolveConditionalPut(ctx, key, expectedSize, expectedSHA256)
		}
		return StoredObject{}, s3ProviderError("put object", err)
	}

	head, headErr = s.headObject(ctx, key)
	if headErr != nil {
		return StoredObject{}, s.cleanupAfterPutError(ctx, key, s3ProviderError("verify object", headErr))
	}
	if !s3HeadMatches(head, expectedSize, expectedSHA256) {
		return StoredObject{}, s.cleanupAfterPutError(ctx, key, s3StorageMismatchError())
	}
	return StoredObject{Object: Object{Key: key, SHA256: staged.digest, ByteSize: expectedSize}, Reused: false}, nil
}

func (s *S3BlobStore) resolveConditionalPut(ctx context.Context, key string, expectedSize int64, expectedSHA256 string) (StoredObject, error) {
	head, err := s.headObject(ctx, key)
	if err == nil && s3HeadMatches(head, expectedSize, expectedSHA256) {
		return StoredObject{Object: s3ObjectFromHead(key, expectedSHA256, expectedSize, head), Reused: true}, nil
	}
	if err != nil && !isS3NotFound(err) {
		return StoredObject{}, s3ProviderError("resolve concurrent object", err)
	}
	return StoredObject{}, s3ObjectConflictError()
}

func (s *S3BlobStore) Open(ctx context.Context, object Object, maxBytes int64) (opened OpenedObject, err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	defer func() {
		opened, err = observer.observeOpened(ctx, opened, err)
	}()
	return s.open(ctx, object, maxBytes)
}

func (s *S3BlobStore) open(ctx context.Context, object Object, maxBytes int64) (OpenedObject, error) {
	if err := s.valid(); err != nil {
		return OpenedObject{}, err
	}
	if err := validateByteSize(object.ByteSize, true); err != nil {
		return OpenedObject{}, err
	}
	if err := validateReaderLimit(maxBytes, object.ByteSize); err != nil {
		return OpenedObject{}, err
	}
	expectedSHA256, err := validateExpectedHash(object.SHA256)
	if err != nil {
		return OpenedObject{}, err
	}
	if err := validateS3ObjectKey(object.Key, expectedSHA256); err != nil {
		return OpenedObject{}, err
	}
	head, err := s.headObject(ctx, object.Key)
	if err != nil {
		if isS3NotFound(err) {
			return OpenedObject{}, s3StorageMissingError()
		}
		return OpenedObject{}, s3ProviderError("inspect object", err)
	}
	if !s3HeadSizeMatches(head, object.ByteSize) {
		return OpenedObject{}, s3StorageMismatchError()
	}
	metadataDigest, metadataErr := s3HeadDigest(head)
	if metadataErr != nil {
		return OpenedObject{}, s3StorageMismatchError()
	}
	if expectedSHA256 != "" && metadataDigest != "" && metadataDigest != expectedSHA256 {
		return OpenedObject{}, s3StorageMismatchError()
	}
	if expectedSHA256 == "" {
		expectedSHA256 = metadataDigest
	}
	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(object.Key)})
	if err != nil {
		if isS3NotFound(err) {
			return OpenedObject{}, s3StorageMissingError()
		}
		return OpenedObject{}, s3ProviderError("get object", err)
	}
	if result == nil || result.Body == nil {
		return OpenedObject{}, s3StorageMissingError()
	}
	if result.ContentLength != nil && *result.ContentLength != object.ByteSize {
		_ = result.Body.Close()
		return OpenedObject{}, s3StorageMismatchError()
	}
	contentType := object.ContentType
	if contentType == "" && head.ContentType != nil {
		contentType = *head.ContentType
	}
	return OpenedObject{
		Object: Object{Key: object.Key, SHA256: expectedSHA256, ByteSize: object.ByteSize, ContentType: contentType},
		Body:   newS3VerifiedReadCloser(ctx, result.Body, object.ByteSize, expectedSHA256),
	}, nil
}

func (s *S3BlobStore) Delete(ctx context.Context, object Object) (err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	defer func() {
		outcome := platformmetrics.ObjectOutcomeFailure
		if err == nil {
			outcome = platformmetrics.ObjectOutcomeSuccess
		}
		observer.observe(platformmetrics.ObjectOperationDelete, outcome, object.ByteSize)
	}()
	return s.delete(ctx, object)
}

func (s *S3BlobStore) delete(ctx context.Context, object Object) error {
	if err := s.valid(); err != nil {
		return err
	}
	expectedSHA256, err := validateExpectedHash(object.SHA256)
	if err != nil {
		return err
	}
	if err := validateS3ObjectKey(object.Key, expectedSHA256); err != nil {
		return err
	}
	if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(object.Key)}); err != nil && !isS3NotFound(err) {
		return s3ProviderError("delete object", err)
	}
	return nil
}

// ListUploadAttemptObjects lists one request-owned prefix only. The prefix is
// constructed from a validated upload ID rather than accepted from a caller,
// which prevents this maintenance capability from becoming a bucket scan.
func (s *S3BlobStore) ListUploadAttemptObjects(ctx context.Context, uploadID string, before time.Time, cursor string, limit int) (page UploadAttemptObjectPage, err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	defer func() {
		outcome := platformmetrics.ObjectOutcomeFailure
		if err == nil {
			outcome = platformmetrics.ObjectOutcomeSuccess
		}
		observer.observe(platformmetrics.ObjectOperationCleanup, outcome, 0)
	}()
	if err := s.valid(); err != nil {
		return UploadAttemptObjectPage{}, err
	}
	prefix, err := uploadAttemptPrefix(uploadID)
	if err != nil {
		return UploadAttemptObjectPage{}, err
	}
	limit = normalizeMaintenanceLimit(limit)
	input := &s3.ListObjectsV2Input{
		Bucket:  aws.String(s.bucket),
		Prefix:  aws.String(prefix),
		MaxKeys: aws.Int32(int32(limit)),
	}
	if cursor != "" {
		input.ContinuationToken = aws.String(cursor)
	}
	providerPage, err := s.client.ListObjectsV2(ctx, input)
	if err != nil {
		return UploadAttemptObjectPage{}, s3ProviderError("list upload attempts", err)
	}
	if providerPage == nil {
		return UploadAttemptObjectPage{}, s3ProviderError("list upload attempts", errors.New("S3 list response is nil"))
	}
	result := UploadAttemptObjectPage{Objects: make([]UploadAttemptObject, 0, len(providerPage.Contents))}
	for _, item := range providerPage.Contents {
		if item.Key == nil {
			return UploadAttemptObjectPage{}, s3ProviderError("list upload attempts", errors.New("S3 object key is missing"))
		}
		key, keyErr := validateUploadAttemptObjectKey(uploadID, *item.Key)
		if keyErr != nil {
			return UploadAttemptObjectPage{}, keyErr
		}
		modified := time.Time{}
		if item.LastModified != nil {
			modified = item.LastModified.UTC()
		}
		if !before.IsZero() && modified.IsZero() {
			return UploadAttemptObjectPage{}, s3ProviderError("list upload attempts", errors.New("S3 object timestamp is missing"))
		}
		if !before.IsZero() && modified.After(before) {
			continue
		}
		size := int64(0)
		if item.Size != nil {
			size = *item.Size
		}
		result.Objects = append(result.Objects, UploadAttemptObject{Key: key, LastModified: modified, ByteSize: size})
	}
	if providerPage.IsTruncated != nil && *providerPage.IsTruncated {
		if providerPage.NextContinuationToken == nil || strings.TrimSpace(*providerPage.NextContinuationToken) == "" {
			return UploadAttemptObjectPage{}, s3ProviderError("list upload attempts", errors.New("S3 continuation token is missing"))
		}
		result.NextCursor = *providerPage.NextContinuationToken
	}
	return result, nil
}

// DeleteUploadAttemptObject revalidates the exact upload prefix before using
// the normal idempotent object delete operation.
func (s *S3BlobStore) DeleteUploadAttemptObject(ctx context.Context, uploadID, key string) (err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	defer func() {
		outcome := platformmetrics.ObjectOutcomeFailure
		if err == nil {
			outcome = platformmetrics.ObjectOutcomeSuccess
		}
		observer.observe(platformmetrics.ObjectOperationCleanup, outcome, 0)
	}()
	key, err = validateUploadAttemptObjectKey(uploadID, key)
	if err != nil {
		return err
	}
	return s.delete(ctx, Object{Key: key})
}

// AbortStaleMultipartUploads mirrors the Node cleanup contract with one
// provider page per call. It never accepts a caller-provided generic prefix;
// only in-progress uploads whose keys begin with workspace/ are considered.
func (s *S3BlobStore) AbortStaleMultipartUploads(ctx context.Context, before time.Time, cursor string, limit int) (result MultipartMaintenanceResult, err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	defer func() {
		outcome := platformmetrics.ObjectOutcomeFailure
		if err == nil {
			outcome = platformmetrics.ObjectOutcomeSuccess
		}
		observer.observe(platformmetrics.ObjectOperationMultipartAbort, outcome, 0)
	}()
	if err := ctx.Err(); err != nil {
		return MultipartMaintenanceResult{NextCursor: cursor}, err
	}
	if err := s.valid(); err != nil {
		return MultipartMaintenanceResult{}, err
	}
	if before.IsZero() {
		return MultipartMaintenanceResult{}, newError("storage.maintenance_time_invalid", "存储维护时间无效", 500, errors.New("multipart cutoff is required"))
	}
	keyMarker, uploadIDMarker, err := decodeMultipartCursor(cursor)
	if err != nil {
		return MultipartMaintenanceResult{}, err
	}
	limit = normalizeMaintenanceLimit(limit)
	input := &s3.ListMultipartUploadsInput{
		Bucket:     aws.String(s.bucket),
		Prefix:     aws.String("workspace/"),
		MaxUploads: aws.Int32(int32(limit)),
	}
	if keyMarker != "" {
		input.KeyMarker = aws.String(keyMarker)
		input.UploadIdMarker = aws.String(uploadIDMarker)
	}
	page, err := s.client.ListMultipartUploads(ctx, input)
	if err != nil {
		return MultipartMaintenanceResult{}, s3ProviderError("list stale multipart uploads", err)
	}
	if page == nil {
		return MultipartMaintenanceResult{}, s3ProviderError("list stale multipart uploads", errors.New("S3 multipart list response is nil"))
	}
	result = MultipartMaintenanceResult{Scanned: len(page.Uploads), NextCursor: cursor}
	var firstErr error
	for _, upload := range page.Uploads {
		if err := ctx.Err(); err != nil {
			return result, errors.Join(firstErr, err)
		}
		if upload.Key == nil || upload.UploadId == nil || !strings.HasPrefix(*upload.Key, "workspace/") || upload.Initiated == nil || upload.Initiated.After(before) {
			if upload.Key != nil && upload.UploadId != nil {
				result.NextCursor = encodeMultipartCursor(*upload.Key, *upload.UploadId)
			}
			continue
		}
		_, abortErr := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: aws.String(s.bucket), Key: upload.Key, UploadId: upload.UploadId})
		if abortErr != nil {
			if ctx.Err() != nil {
				// Retry the unfinished record on the next cycle, not the next
				// provider page. The provider marker skips every row in this page.
				return result, errors.Join(firstErr, s3ProviderError("abort stale multipart upload", abortErr))
			}
			if firstErr == nil {
				firstErr = s3ProviderError("abort stale multipart upload", abortErr)
			}
			result.NextCursor = encodeMultipartCursor(*upload.Key, *upload.UploadId)
			continue
		}
		result.Aborted++
		result.NextCursor = encodeMultipartCursor(*upload.Key, *upload.UploadId)
	}
	result.NextCursor = ""
	if page.IsTruncated != nil && *page.IsTruncated {
		if page.NextKeyMarker == nil || strings.TrimSpace(*page.NextKeyMarker) == "" {
			return result, s3ProviderError("list stale multipart uploads", errors.New("S3 multipart key marker is missing"))
		}
		result.NextCursor = encodeMultipartCursor(stringValue(page.NextKeyMarker), stringValue(page.NextUploadIdMarker))
	}
	if firstErr != nil {
		return result, firstErr
	}
	return result, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (s *S3BlobStore) headObject(ctx context.Context, key string) (*s3.HeadObjectOutput, error) {
	return s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
}

func s3HeadMatches(head *s3.HeadObjectOutput, expectedSize int64, expectedSHA256 string) bool {
	if !s3HeadSizeMatches(head, expectedSize) {
		return false
	}
	if expectedSHA256 == "" {
		return true
	}
	digest, err := s3HeadDigest(head)
	return err == nil && digest == expectedSHA256
}

func s3HeadSizeMatches(head *s3.HeadObjectOutput, expectedSize int64) bool {
	return head != nil && head.ContentLength != nil && *head.ContentLength == expectedSize
}

func s3HeadDigest(head *s3.HeadObjectOutput) (string, error) {
	if head == nil {
		return "", errors.New("head response is nil")
	}
	raw := strings.TrimSpace(head.Metadata["duallane-sha256"])
	if raw == "" {
		return "", nil
	}
	return NormalizeSHA256(raw)
}

func s3ObjectFromHead(key, digest string, size int64, head *s3.HeadObjectOutput) Object {
	contentType := ""
	if head != nil && head.ContentType != nil {
		contentType = *head.ContentType
	}
	return Object{Key: key, SHA256: digest, ByteSize: size, ContentType: contentType}
}

func validateS3ObjectKey(key, digest string) error {
	if strings.TrimSpace(key) == "" || strings.ContainsRune(key, '\x00') || len(key) > s3ObjectKeyMaxBytes {
		return newError("storage.object_invalid_key", "存储对象路径无效", 500, errors.New("object key is invalid"))
	}
	normalized := strings.ReplaceAll(key, "\\", "/")
	if strings.HasPrefix(normalized, "/") || isAbsoluteObjectKey(normalized) {
		return newError("storage.object_invalid_key", "存储对象路径无效", 500, errors.New("absolute object key"))
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == ".." {
			return newError("storage.object_invalid_key", "存储对象路径无效", 500, errors.New("traversal object key"))
		}
	}
	if isCanonicalKey(key) {
		if digest == "" {
			return newError("storage.object_invalid_key", "存储对象路径无效", 500, errors.New("canonical object requires digest"))
		}
		if err := ValidateCanonicalKey(key, digest); err != nil {
			return err
		}
	}
	return nil
}

func s3ObjectConflictError() *Error {
	return newError("storage.object_conflict", "存储对象登记冲突", 409, errors.New("object identity conflict"))
}

func s3StorageMissingError() *Error {
	return newError("file.storage_missing", "文件内容不可用", 404, errors.New("object is missing"))
}

func s3StorageMismatchError() *Error {
	return newError("file.storage_mismatch", "文件内容不可用", 500, errors.New("object content mismatch"))
}

func s3ProviderError(operation string, cause error) *Error {
	if cause == nil {
		cause = errors.New("S3 provider operation failed")
	}
	return newError(s3UnavailableCode, s3UnavailableMessage, 503, fmt.Errorf("%s: %w", operation, cause))
}

func (s *S3BlobStore) cleanupAfterPutError(ctx context.Context, key string, original *Error) *Error {
	cleanupErr := s.deleteKey(ctx, key)
	if cleanupErr != nil {
		original.Cause = errors.Join(original.Cause, cleanupErr)
	}
	return original
}

func (s *S3BlobStore) deleteKey(ctx context.Context, key string) error {
	if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)}); err != nil && !isS3NotFound(err) {
		return s3ProviderError("cleanup object", err)
	}
	return nil
}

func s3APIErrorCode(err error) string {
	var value interface{ ErrorCode() string }
	if errors.As(err, &value) {
		return value.ErrorCode()
	}
	return ""
}

func s3HTTPStatus(err error) int {
	var value interface{ HTTPStatusCode() int }
	if errors.As(err, &value) {
		return value.HTTPStatusCode()
	}
	return 0
}

func isS3NotFound(err error) bool {
	if err == nil {
		return false
	}
	switch s3APIErrorCode(err) {
	case "NoSuchKey", "NoSuchBucket", "NotFound", "NotFoundError", "NoSuchObject":
		return true
	}
	return s3HTTPStatus(err) == 404
}

func isS3ConditionalFailure(err error) bool {
	if err == nil {
		return false
	}
	switch s3APIErrorCode(err) {
	case "PreconditionFailed", "ConditionalRequestConflict":
		return true
	}
	status := s3HTTPStatus(err)
	return status == 409 || status == 412
}

type s3UploadStage struct {
	file   *os.File
	digest string
}

func stageS3Upload(ctx context.Context, source io.Reader, expectedSize int64, expectedSHA256 string) (*s3UploadStage, error) {
	file, err := os.CreateTemp("", "duallane-s3-upload-*")
	if err != nil {
		return nil, internalError("stage S3 object", err)
	}
	stage := &s3UploadStage{file: file}
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(file.Name())
	}
	written, digest, copyErr := copyAndHash(ctx, file, source, expectedSize)
	if copyErr != nil {
		cleanup()
		return nil, copyErr
	}
	if written != expectedSize {
		cleanup()
		return nil, newError("upload.size_mismatch", "上传内容大小与预留不一致", 400, errors.New("source size mismatch"))
	}
	if expectedSHA256 != "" && digest != expectedSHA256 {
		cleanup()
		return nil, newError("upload.hash_mismatch", "上传内容校验失败", 400, errDigestMismatch)
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return nil, internalError("flush staged S3 object", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return nil, internalError("rewind staged S3 object", err)
	}
	stage.digest = digest
	return stage, nil
}

func (s *s3UploadStage) cleanup() {
	if s == nil || s.file == nil {
		return
	}
	_ = s.file.Close()
	_ = os.Remove(s.file.Name())
}

type s3VerifiedReadCloser struct {
	readMu    sync.Mutex
	stateMu   sync.Mutex
	ctx       context.Context
	body      io.ReadCloser
	expected  int64
	digest    string
	count     int64
	hash      hash.Hash
	terminal  error
	closed    bool
	closeOnce sync.Once
	closeErr  error
}

func newS3VerifiedReadCloser(ctx context.Context, body io.ReadCloser, expected int64, digest string) io.ReadCloser {
	return &s3VerifiedReadCloser{ctx: ctx, body: body, expected: expected, digest: digest, hash: sha256.New()}
}

func (r *s3VerifiedReadCloser) Read(p []byte) (int, error) {
	if r == nil {
		return 0, io.ErrClosedPipe
	}
	r.readMu.Lock()
	defer r.readMu.Unlock()

	r.stateMu.Lock()
	if r.terminal != nil {
		err := r.terminal
		r.stateMu.Unlock()
		return 0, err
	}
	if r.closed {
		r.stateMu.Unlock()
		return 0, io.ErrClosedPipe
	}
	ctx := r.ctx
	body := r.body
	r.stateMu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return 0, r.fail(s3ProviderError("read object", err))
	}
	n, err := body.Read(p)

	r.stateMu.Lock()
	allowed := n
	overLimit := false
	if r.terminal != nil {
		allowed = boundedReadCount(n, r.expected-r.count)
	} else if n > 0 {
		remaining := r.expected - r.count
		if remaining < int64(n) {
			allowed = boundedReadCount(n, remaining)
			overLimit = true
		}
		if allowed > 0 {
			_, _ = r.hash.Write(p[:allowed])
			r.count += int64(allowed)
		}
	}
	terminal := r.terminal
	r.stateMu.Unlock()

	if terminal != nil {
		return allowed, terminal
	}
	if overLimit {
		return allowed, r.fail(s3StorageMismatchError())
	}
	if err == nil {
		return allowed, nil
	}
	if errors.Is(err, io.EOF) {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return allowed, r.fail(s3ProviderError("read object", ctxErr))
		}
		r.stateMu.Lock()
		if r.terminal != nil {
			terminal := r.terminal
			r.stateMu.Unlock()
			return allowed, terminal
		}
		valid := r.count == r.expected && (r.digest == "" || hex.EncodeToString(r.hash.Sum(nil)) == r.digest)
		if valid {
			r.terminal = io.EOF
			r.stateMu.Unlock()
			return allowed, io.EOF
		}
		r.stateMu.Unlock()
		return allowed, r.fail(s3StorageMismatchError())
	}
	return allowed, r.fail(s3ProviderError("read object", err))
}

func boundedReadCount(n int, remaining int64) int {
	if n <= 0 || remaining <= 0 {
		return 0
	}
	if int64(n) > remaining {
		return int(remaining)
	}
	return n
}

func (r *s3VerifiedReadCloser) closeBody() error {
	if r == nil {
		return nil
	}
	r.closeOnce.Do(func() {
		if r.body != nil {
			r.closeErr = r.body.Close()
		}
	})
	return r.closeErr
}

func (r *s3VerifiedReadCloser) fail(err error) error {
	if r == nil {
		return err
	}
	r.stateMu.Lock()
	if r.terminal != nil {
		terminal := r.terminal
		r.stateMu.Unlock()
		return terminal
	}
	r.terminal = err
	r.closed = true
	r.stateMu.Unlock()
	_ = r.closeBody()
	return err
}

func (r *s3VerifiedReadCloser) Close() error {
	if r == nil {
		return nil
	}
	r.stateMu.Lock()
	if r.closed {
		r.stateMu.Unlock()
		return nil
	}
	r.closed = true
	if r.terminal == nil {
		r.terminal = io.ErrClosedPipe
	}
	r.stateMu.Unlock()
	if err := r.closeBody(); err != nil {
		return s3ProviderError("close object", err)
	}
	return nil
}
