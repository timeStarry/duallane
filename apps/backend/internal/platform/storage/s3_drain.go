package storage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const (
	// MultipartQuiescenceReadyCode means the provider returned a complete,
	// non-truncated page with no in-progress multipart uploads.
	MultipartQuiescenceReadyCode = "storage.multipart_quiescent"
	// MultipartQuiescenceBlockedCode means the provider returned at least one
	// in-progress upload. The count is bounded by MaxUploads=1.
	MultipartQuiescenceBlockedCode = "storage.multipart_not_quiescent"
	// MultipartQuiescenceFailedCode means the observation did not prove an
	// empty provider state. It covers provider errors and incomplete pages.
	MultipartQuiescenceFailedCode = "storage.multipart_check_failed"

	// The response for one upload should be small. This cap applies to both
	// successful XML and provider error bodies, including SDK drain paths.
	s3MultipartQuiescenceResponseLimit int64 = 64 * 1024
	s3MultipartQuiescenceTimeout             = 2 * time.Second
)

var (
	errMultipartResponseTooLarge   = errors.New("multipart response exceeds bounded limit")
	errMultipartResponseIncomplete = errors.New("multipart response is incomplete")
	errMultipartResponseNoProgress = errors.New("multipart response made no read progress")
	errMultipartUploadsPresent     = errors.New("multipart uploads are present")
	errMultipartObservationFailed  = errors.New("multipart quiescence observation failed")
)

// MultipartQuiescenceReport is deliberately content-free. It contains no
// bucket, endpoint, object key, upload ID, provider body, or provider error.
// A ready report is identified by Code; ReadOnly is always true and is not a
// writer fence or a promise that another process cannot start an upload.
type MultipartQuiescenceReport struct {
	UploadCount int    `json:"uploadCount"`
	Code        string `json:"code"`
	ReadOnly    bool   `json:"readOnly"`
}

// multipartQuiescenceError keeps provider details out of Error() and from
// accidental JSON/log formatting. Context cancellation/deadline is retained
// only through Unwrap so callers can preserve cancellation semantics.
type multipartQuiescenceError struct {
	code  string
	cause error
}

func (e *multipartQuiescenceError) Error() string {
	if e == nil {
		return ""
	}
	return e.code
}

func (e *multipartQuiescenceError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// CheckMultipartQuiescence performs one bounded, read-only provider
// observation over the configured private bucket. It intentionally does not
// filter by a caller-provided prefix: a release drain must observe the whole
// configured bucket, while MaxUploads=1 keeps both provider work and result
// disclosure bounded. A nil error is returned only for a complete empty page.
func (s *S3BlobStore) CheckMultipartQuiescence(ctx context.Context) (MultipartQuiescenceReport, error) {
	report := MultipartQuiescenceReport{
		Code:     MultipartQuiescenceFailedCode,
		ReadOnly: true,
	}
	if ctx == nil {
		return report, newMultipartQuiescenceError(nil)
	}
	if err := ctx.Err(); err != nil {
		return report, newMultipartQuiescenceError(err)
	}

	checkCtx, cancel := context.WithTimeout(ctx, s3MultipartQuiescenceTimeout)
	defer cancel()
	if err := checkCtx.Err(); err != nil {
		return report, newMultipartQuiescenceError(err)
	}
	if err := s.valid(); err != nil {
		return report, newMultipartQuiescenceError(nil)
	}

	boundedClient := newBoundedS3HTTPClient(s3HTTPClient(s.client), s3MultipartQuiescenceResponseLimit)
	page, listErr := s.client.ListMultipartUploads(
		checkCtx,
		&s3.ListMultipartUploadsInput{
			Bucket:     aws.String(s.bucket),
			MaxUploads: aws.Int32(1),
		},
		func(options *s3.Options) {
			options.HTTPClient = boundedClient
			options.RetryMaxAttempts = 1
		},
	)
	bodyErr := boundedClient.finish()
	if err := checkCtx.Err(); err != nil {
		return report, newMultipartQuiescenceError(err)
	}
	if bodyErr != nil {
		return report, newMultipartQuiescenceError(bodyErr)
	}
	if listErr != nil {
		return report, newMultipartQuiescenceError(listErr)
	}
	if page == nil || page.IsTruncated == nil {
		return report, newMultipartQuiescenceError(errMultipartResponseIncomplete)
	}

	if len(page.Uploads) > 0 {
		report.UploadCount = 1
	}
	if *page.IsTruncated {
		return report, newMultipartQuiescenceError(errMultipartResponseIncomplete)
	}
	if report.UploadCount > 0 {
		report.Code = MultipartQuiescenceBlockedCode
		return report, &multipartQuiescenceError{
			code:  MultipartQuiescenceBlockedCode,
			cause: errMultipartUploadsPresent,
		}
	}
	report.Code = MultipartQuiescenceReadyCode
	return report, nil
}

func newMultipartQuiescenceError(cause error) error {
	if errors.Is(cause, context.Canceled) {
		return &multipartQuiescenceError{code: MultipartQuiescenceFailedCode, cause: context.Canceled}
	}
	if errors.Is(cause, context.DeadlineExceeded) {
		return &multipartQuiescenceError{code: MultipartQuiescenceFailedCode, cause: context.DeadlineExceeded}
	}
	return &multipartQuiescenceError{code: MultipartQuiescenceFailedCode, cause: errMultipartObservationFailed}
}

type s3OptionsProvider interface {
	Options() s3.Options
}

func s3HTTPClient(client s3API) s3.HTTPClient {
	provider, ok := client.(s3OptionsProvider)
	if !ok {
		return nil
	}
	return provider.Options().HTTPClient
}

// boundedS3HTTPClient is installed only for this one ListMultipartUploads
// call. The underlying S3 client still owns endpoint resolution and SigV4;
// this wrapper only bounds and audits response-body consumption.
type boundedS3HTTPClient struct {
	base   s3.HTTPClient
	limit  int64
	bodies []*boundedS3ResponseBody
}

func newBoundedS3HTTPClient(base s3.HTTPClient, limit int64) *boundedS3HTTPClient {
	return &boundedS3HTTPClient{base: base, limit: limit}
}

func (c *boundedS3HTTPClient) Do(request *http.Request) (*http.Response, error) {
	if request == nil {
		return nil, errMultipartResponseIncomplete
	}
	base := c.base
	if base == nil {
		base = http.DefaultClient
	}
	response, err := base.Do(request)
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		return response, err
	}
	if response == nil || response.Body == nil {
		return nil, errMultipartResponseIncomplete
	}
	body := &boundedS3ResponseBody{source: response.Body, limit: c.limit}
	c.bodies = append(c.bodies, body)
	response.Body = body
	return response, nil
}

func (c *boundedS3HTTPClient) finish() error {
	var firstErr error
	for _, body := range c.bodies {
		if err := body.finish(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

type boundedS3ResponseBody struct {
	source   io.ReadCloser
	limit    int64
	consumed int64
	eof      bool
	overflow bool
	readErr  error
	closed   bool
	closeErr error
}

func (b *boundedS3ResponseBody) Read(p []byte) (int, error) {
	if b == nil || b.source == nil {
		return 0, errMultipartResponseIncomplete
	}
	if len(p) == 0 {
		return 0, nil
	}
	if b.overflow {
		return 0, errMultipartResponseTooLarge
	}
	if b.readErr != nil && !errors.Is(b.readErr, io.EOF) {
		return 0, b.readErr
	}
	if b.eof {
		return 0, io.EOF
	}

	if b.consumed >= b.limit {
		var extra [1]byte
		n, err := b.source.Read(extra[:])
		if n > 0 {
			b.overflow = true
			b.readErr = errMultipartResponseTooLarge
			return 0, errMultipartResponseTooLarge
		}
		if err != nil {
			b.recordReadError(err)
			return 0, err
		}
		b.readErr = errMultipartResponseNoProgress
		return 0, errMultipartResponseNoProgress
	}

	readLimit := int64(len(p))
	if remaining := b.limit - b.consumed; readLimit > remaining {
		readLimit = remaining
	}
	n, err := b.source.Read(p[:int(readLimit)])
	if n > 0 {
		b.consumed += int64(n)
	}
	if err != nil {
		b.recordReadError(err)
	}
	if n == 0 && err == nil {
		b.readErr = errMultipartResponseNoProgress
		return 0, errMultipartResponseNoProgress
	}
	return n, err
}

func (b *boundedS3ResponseBody) recordReadError(err error) {
	if errors.Is(err, io.EOF) {
		b.eof = true
		b.readErr = io.EOF
		return
	}
	b.readErr = err
}

func (b *boundedS3ResponseBody) Close() error {
	if b == nil || b.closed {
		if b == nil {
			return nil
		}
		return b.closeErr
	}
	b.closed = true
	b.closeErr = b.source.Close()
	return b.closeErr
}

func (b *boundedS3ResponseBody) finish() error {
	if b == nil {
		return errMultipartResponseIncomplete
	}
	if !b.closed {
		_, drainErr := io.Copy(io.Discard, b)
		closeErr := b.Close()
		if err := b.bodyError(); err != nil {
			return err
		}
		if drainErr != nil {
			return drainErr
		}
		if !b.eof {
			return errMultipartResponseIncomplete
		}
		return closeErr
	}
	if err := b.bodyError(); err != nil {
		return err
	}
	if !b.eof {
		return errMultipartResponseIncomplete
	}
	return b.closeErr
}

func (b *boundedS3ResponseBody) bodyError() error {
	if b.overflow {
		return errMultipartResponseTooLarge
	}
	if b.readErr != nil && !errors.Is(b.readErr, io.EOF) {
		return b.readErr
	}
	return nil
}
