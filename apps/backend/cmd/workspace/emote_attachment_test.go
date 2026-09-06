package main

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

type emoteAttachmentOpenerStub struct {
	input  files.OpenAttachmentInput
	ctx    context.Context
	opened storage.OpenedObject
	err    error
}

func (s *emoteAttachmentOpenerStub) OpenAttachmentContent(ctx context.Context, input files.OpenAttachmentInput) (storage.OpenedObject, error) {
	s.ctx, s.input = ctx, input
	return s.opened, s.err
}

func TestEmoteAttachmentAdapterPreservesAuthorizedReadAndStream(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body := io.NopCloser(strings.NewReader("synthetic-image"))
	defer body.Close()
	opener := &emoteAttachmentOpenerStub{opened: storage.OpenedObject{Body: body, Object: storage.Object{ByteSize: 15, ContentType: "image/png"}}}
	input := emotes.AttachmentContentInput{ActorID: "actor", AttachmentID: "attachment", MaxBytes: 32, Meta: auth.RequestMeta{}}
	opened, err := (emoteAttachmentReader{files: opener}).OpenAttachmentContent(ctx, input)
	if err != nil || opened.Body != body || opened.ByteSize != 15 || opened.ContentType != "image/png" {
		t.Fatalf("stream projection changed: %v", err)
	}
	want := files.OpenAttachmentInput{ActorID: input.ActorID, AttachmentID: input.AttachmentID, MaxBytes: input.MaxBytes, Meta: input.Meta}
	if opener.ctx != ctx || !reflect.DeepEqual(opener.input, want) {
		t.Fatal("authorized actor, limit, metadata or cancellation context changed")
	}
}

func TestEmoteAttachmentAdapterPreservesSafeDomainErrors(t *testing.T) {
	for _, status := range []int{400, 403, 404, 413, 500} {
		err := &files.Error{Code: "file.test_rejected", Message: "safe message", StatusCode: status, Cause: errors.New("private-provider-detail")}
		opener := &emoteAttachmentOpenerStub{err: err}
		_, got := (emoteAttachmentReader{files: opener}).OpenAttachmentContent(context.Background(), emotes.AttachmentContentInput{})
		var public *emotes.Error
		if !errors.As(got, &public) || public.Code != err.Code || public.Message != err.Message || public.StatusCode != status {
			t.Fatalf("domain status %d changed: %v", status, got)
		}
		if strings.Contains(got.Error(), "private-provider-detail") || errors.Is(got, err.Cause) {
			t.Fatal("provider cause crossed public adapter boundary")
		}
	}
	for _, err := range []error{context.Canceled, context.DeadlineExceeded, errors.New("unexpected")} {
		_, got := (emoteAttachmentReader{files: &emoteAttachmentOpenerStub{err: err}}).OpenAttachmentContent(context.Background(), emotes.AttachmentContentInput{})
		if !errors.Is(got, err) {
			t.Fatal("non-domain error or cancellation was replaced")
		}
	}
}
