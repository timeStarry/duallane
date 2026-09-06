package main

import (
	"context"
	"errors"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/platform/media"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
)

type imageProcessor interface {
	Process(context.Context, []byte, media.Source) (media.ProcessedUpload, error)
}

// Domain services own authorization and audit; this adapter only translates
// the native processor's typed result and safe error contract.
type emoteMediaProcessor struct{ processor imageProcessor }

var _ emotes.MediaProcessor = emoteMediaProcessor{}

func (adapter emoteMediaProcessor) Process(ctx context.Context, input []byte, source emotes.UploadSource) (emotes.ProcessedUpload, error) {
	result, err := adapter.processor.Process(ctx, input, media.Source{Kind: media.KindCustomEmote, MIMEType: source.MIMEType})
	if err != nil {
		var mediaErr *media.Error
		if errors.As(err, &mediaErr) {
			if mediaErr.Code == media.CodeProcessingUnavailable {
				return emotes.ProcessedUpload{}, emotes.NewError(emotes.CodeEmoteProcessingUnavailable, emotes.MessageEmoteProcessingUnavailable, 503)
			}
			if strings.HasPrefix(mediaErr.Code, "emote.") {
				return emotes.ProcessedUpload{}, emotes.NewError(mediaErr.Code, mediaErr.Message, mediaErr.StatusCode)
			}
		}
		return emotes.ProcessedUpload{}, err
	}
	return emotes.ProcessedUpload(result), nil
}
