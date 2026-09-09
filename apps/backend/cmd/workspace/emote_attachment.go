package main

import (
	"context"
	"errors"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

type attachmentContentOpener interface {
	OpenAttachmentContent(context.Context, files.OpenAttachmentInput) (storage.OpenedObject, error)
}

// Keep authorization, legacy fallback and bounded reads in the files domain.
// A favorite is an inline read, not a quota-consuming download reservation.
type emoteAttachmentReader struct{ files attachmentContentOpener }

var _ emotes.AttachmentContentReader = emoteAttachmentReader{}

func (adapter emoteAttachmentReader) OpenAttachmentContent(ctx context.Context, input emotes.AttachmentContentInput) (storage.OpenedObject, error) {
	opened, err := adapter.files.OpenAttachmentContent(ctx, files.OpenAttachmentInput{
		ActorID: input.ActorID, AttachmentID: input.AttachmentID, MaxBytes: input.MaxBytes, Meta: input.Meta,
	})
	if err != nil {
		var domainErr *files.Error
		if errors.As(err, &domainErr) && domainErr != nil {
			// Only the public contract crosses the boundary; provider causes do not.
			return storage.OpenedObject{}, emotes.NewError(domainErr.Code, domainErr.Message, domainErr.StatusCode)
		}
		return storage.OpenedObject{}, err
	}
	return opened, nil
}
