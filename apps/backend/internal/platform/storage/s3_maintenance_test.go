package storage

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type multipartFixture struct {
	key       string
	uploadID  string
	initiated time.Time
}

type multipartFixtureServer struct {
	mu      sync.Mutex
	uploads []multipartFixture
	aborted []string
}

func (s *multipartFixtureServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Query().Has("uploads") {
		s.list(w, r)
		return
	}
	if r.Method == http.MethodDelete && r.URL.Query().Get("uploadId") != "" {
		s.abort(w, r)
		return
	}
	http.Error(w, "not found", http.StatusNotFound)
}

func (s *multipartFixtureServer) list(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := append([]multipartFixture(nil), s.uploads...)
	filtered := items[:0]
	for _, item := range items {
		if strings.HasPrefix(item.key, r.URL.Query().Get("prefix")) {
			filtered = append(filtered, item)
		}
	}
	items = filtered
	sort.Slice(items, func(left, right int) bool {
		if items[left].key == items[right].key {
			return items[left].uploadID < items[right].uploadID
		}
		return items[left].key < items[right].key
	})
	markerKey := r.URL.Query().Get("key-marker")
	markerID := r.URL.Query().Get("upload-id-marker")
	start := 0
	for start < len(items) && (items[start].key < markerKey || (items[start].key == markerKey && items[start].uploadID <= markerID)) {
		start++
	}
	max := 1000
	if value := r.URL.Query().Get("max-uploads"); value != "" {
		_, _ = fmt.Sscanf(value, "%d", &max)
	}
	if max < 1 {
		max = 1
	}
	end := start + max
	truncated := end < len(items)
	if end > len(items) {
		end = len(items)
	}
	var body strings.Builder
	body.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>duallane</Bucket>`)
	body.WriteString(`<KeyMarker>` + url.QueryEscape(markerKey) + `</KeyMarker><UploadIdMarker>` + url.QueryEscape(markerID) + `</UploadIdMarker>`)
	body.WriteString(`<NextKeyMarker>`)
	if truncated {
		body.WriteString(items[end-1].key)
	}
	body.WriteString(`</NextKeyMarker><NextUploadIdMarker>`)
	if truncated {
		body.WriteString(items[end-1].uploadID)
	}
	body.WriteString(`</NextUploadIdMarker><MaxUploads>`)
	body.WriteString(fmt.Sprintf("%d", max))
	body.WriteString(`</MaxUploads><IsTruncated>`)
	if truncated {
		body.WriteString("true")
	} else {
		body.WriteString("false")
	}
	body.WriteString(`</IsTruncated>`)
	for _, item := range items[start:end] {
		body.WriteString(`<Upload><Key>` + item.key + `</Key><UploadId>` + item.uploadID + `</UploadId><Initiated>` + item.initiated.UTC().Format(time.RFC3339) + `</Initiated></Upload>`)
	}
	body.WriteString(`</ListMultipartUploadsResult>`)
	w.Header().Set("Content-Type", "application/xml")
	_, _ = w.Write([]byte(body.String()))
}

func (s *multipartFixtureServer) abort(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := r.URL.Query().Get("uploadId")
	s.aborted = append(s.aborted, id)
	remaining := s.uploads[:0]
	for _, item := range s.uploads {
		if item.uploadID != id {
			remaining = append(remaining, item)
		}
	}
	s.uploads = remaining
	w.WriteHeader(http.StatusNoContent)
}

func (s *multipartFixtureServer) abortedIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.aborted...)
}

func TestS3MultipartMaintenanceUsesWorkspacePrefixAgeAndCursor(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	server := &multipartFixtureServer{uploads: []multipartFixture{
		{key: "workspace/uploads/old-a/attempts/object", uploadID: "mpu-a", initiated: now.Add(-8 * 24 * time.Hour)},
		{key: "workspace/uploads/new/attempts/object", uploadID: "mpu-new", initiated: now.Add(-time.Hour)},
		{key: "workspace/uploads/old-b/attempts/object", uploadID: "mpu-b", initiated: now.Add(-9 * 24 * time.Hour)},
		{key: "other/private", uploadID: "mpu-other", initiated: now.Add(-30 * 24 * time.Hour)},
	}}
	httpServer := httptest.NewServer(server)
	t.Cleanup(httpServer.Close)
	store, err := NewS3BlobStore(s3TestConfig(httpServer.URL))
	if err != nil {
		t.Fatal(err)
	}
	cutoff := now.Add(-7 * 24 * time.Hour)
	first, err := store.AbortStaleMultipartUploads(context.Background(), cutoff, "", 1)
	if err != nil {
		t.Fatalf("first multipart maintenance: %v", err)
	}
	if first.Scanned != 1 || first.Aborted != 0 || first.NextCursor == "" {
		t.Fatalf("first multipart result: %#v", first)
	}
	second, err := store.AbortStaleMultipartUploads(context.Background(), cutoff, first.NextCursor, 1)
	if err != nil {
		t.Fatalf("second multipart maintenance: %v", err)
	}
	if second.Aborted != 1 || second.NextCursor == "" {
		t.Fatalf("second multipart result: %#v", second)
	}
	third, err := store.AbortStaleMultipartUploads(context.Background(), cutoff, second.NextCursor, 1)
	if err != nil {
		t.Fatalf("third multipart maintenance: %v", err)
	}
	if third.Aborted != 1 || third.NextCursor != "" {
		t.Fatalf("third multipart result: %#v", third)
	}
	if got := server.abortedIDs(); len(got) != 2 || got[0] != "mpu-a" || got[1] != "mpu-b" {
		t.Fatalf("aborted multipart IDs = %#v", got)
	}
}

type interruptedMultipartAPI struct {
	s3API
	listCalls  int
	abortCalls []string
	page       *s3.ListMultipartUploadsOutput
	cancel     context.CancelFunc
}

func (api *interruptedMultipartAPI) ListMultipartUploads(context.Context, *s3.ListMultipartUploadsInput, ...func(*s3.Options)) (*s3.ListMultipartUploadsOutput, error) {
	api.listCalls++
	return api.page, nil
}

func (api *interruptedMultipartAPI) AbortMultipartUpload(_ context.Context, input *s3.AbortMultipartUploadInput, _ ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error) {
	api.abortCalls = append(api.abortCalls, *input.UploadId)
	if *input.UploadId == "mpu-b" {
		api.cancel()
		return nil, context.Canceled
	}
	return &s3.AbortMultipartUploadOutput{}, nil
}

func TestS3MultipartCancellationRetainsLastFinishedCursor(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	before := time.Now().UTC()
	api := &interruptedMultipartAPI{cancel: cancel, page: &s3.ListMultipartUploadsOutput{
		IsTruncated: aws.Bool(true), NextKeyMarker: aws.String("workspace/c"), NextUploadIdMarker: aws.String("mpu-c"),
		Uploads: []types.MultipartUpload{
			{Key: aws.String("workspace/a"), UploadId: aws.String("mpu-a"), Initiated: &before},
			{Key: aws.String("workspace/b"), UploadId: aws.String("mpu-b"), Initiated: &before},
			{Key: aws.String("workspace/c"), UploadId: aws.String("mpu-c"), Initiated: &before},
		},
	}}
	store := &S3BlobStore{bucket: "duallane", client: api}
	result, err := store.AbortStaleMultipartUploads(ctx, before, "", 100)
	if !errors.Is(err, context.Canceled) || result.Aborted != 1 {
		t.Fatalf("partial abort = %#v, %v", result, err)
	}
	key, id, err := decodeMultipartCursor(result.NextCursor)
	if err != nil || key != "workspace/a" || id != "mpu-a" {
		t.Fatalf("unfinished upload skipped by cursor: %q %q %v", key, id, err)
	}
	if len(api.abortCalls) != 2 {
		t.Fatalf("I/O started after cancellation: %v", api.abortCalls)
	}
	if _, err := store.AbortStaleMultipartUploads(ctx, before, result.NextCursor, 100); !errors.Is(err, context.Canceled) || api.listCalls != 1 {
		t.Fatalf("cancelled call made new list request: %d %v", api.listCalls, err)
	}
}
