package storage

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestS3AttemptMaintenanceValidatesProviderPrefixAgeAndCursor(t *testing.T) {
	const prefix = "workspace/uploads/attempt-review/attempts/"
	for _, test := range []struct {
		name, contents, continuation string
		wantError                    bool
	}{
		{"old and fresh", `<Contents><Key>` + prefix + `old</Key><LastModified>2026-09-05T12:00:00Z</LastModified><Size>1</Size></Contents><Contents><Key>` + prefix + `fresh</Key><LastModified>2026-09-06T12:01:00Z</LastModified><Size>1</Size></Contents>`, `<IsTruncated>true</IsTruncated><NextContinuationToken>next-page</NextContinuationToken>`, false},
		{"cross upload", `<Contents><Key>workspace/uploads/other/attempts/old</Key><LastModified>2026-09-05T12:00:00Z</LastModified></Contents>`, "", true},
		{"unknown age", `<Contents><Key>` + prefix + `old</Key></Contents>`, "", true},
		{"missing continuation", "", `<IsTruncated>true</IsTruncated>`, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Query().Get("list-type") != "2" || r.URL.Query().Get("prefix") != prefix || r.URL.Query().Get("max-keys") != "2" || r.URL.Query().Get("continuation-token") != "previous-page" {
					t.Errorf("unexpected narrow list request: method=%s", r.Method)
				}
				w.Header().Set("Content-Type", "application/xml")
				_, _ = w.Write([]byte(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` + test.contents + test.continuation + `</ListBucketResult>`))
			}))
			defer server.Close()
			store, err := NewS3BlobStore(s3TestConfig(server.URL))
			if err != nil {
				t.Fatal(err)
			}
			page, err := store.ListUploadAttemptObjects(context.Background(), "attempt-review", time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC), "previous-page", 2)
			if test.wantError {
				if err == nil {
					t.Fatal("invalid provider metadata was accepted")
				}
				return
			}
			if err != nil || len(page.Objects) != 1 || page.Objects[0].Key != prefix+"old" || page.NextCursor != "next-page" {
				t.Fatalf("page=%+v err=%v", page, err)
			}
		})
	}
}

func TestS3AttemptMaintenanceRejectsCrossUploadDeleteBeforeIO(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer server.Close()
	store, err := NewS3BlobStore(s3TestConfig(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	err = store.DeleteUploadAttemptObject(context.Background(), "one", "workspace/uploads/two/attempts/secret")
	if err == nil || called || !strings.Contains(errorCode(t, err), "invalid_key") {
		t.Fatalf("cross-upload delete: called=%v err=%v", called, err)
	}
}
