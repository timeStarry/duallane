package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/media"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
)

type imageProcessorFunc func(context.Context, []byte, media.Source) (media.ProcessedUpload, error)

func TestReactionCatalogAdapterKeepsHiddenRemovalCompatibility(t *testing.T) {
	items := []emotes.CatalogItem{{ID: "heart", Kind: "unicode", Label: "Heart", Value: "♥"}}
	catalog, err := emotes.NewCatalog([]emotes.CatalogPack{
		{ID: "visible", Label: "Visible", Items: items},
		{ID: "qq", Label: "Hidden", Items: items},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		key            string
		visible, known bool
	}{
		{"visible:heart", true, true}, {"qq:heart", false, true}, {"forged:heart", false, false},
	} {
		adapter := catalogBuiltinEmoteSource{catalog: catalog}
		visible, err := adapter.IsVisibleReactionEmote(context.Background(), test.key)
		if err != nil || visible != test.visible {
			t.Fatalf("visible %s = %t, %v", test.key, visible, err)
		}
		known, err := adapter.IsKnownReactionEmote(context.Background(), test.key)
		if err != nil || known != test.known {
			t.Fatalf("known %s = %t, %v", test.key, known, err)
		}
	}
}

func (f imageProcessorFunc) Process(ctx context.Context, input []byte, source media.Source) (media.ProcessedUpload, error) {
	return f(ctx, input, source)
}

func TestEmoteProcessorPreservesNormalizedMetadata(t *testing.T) {
	want := media.ProcessedUpload{
		Content: []byte("normalized"), DetectedMIMEType: "image/gif", NormalizedMIMEType: "image/webp",
		ByteSize: 10, Width: 256, Height: 128, FrameCount: 3, DurationMS: 300, SHA256: "digest",
	}
	adapter := emoteMediaProcessor{processor: imageProcessorFunc(func(_ context.Context, input []byte, source media.Source) (media.ProcessedUpload, error) {
		if string(input) != "source" || source.Kind != media.KindCustomEmote || source.MIMEType != "image/gif" {
			t.Fatalf("processor input=%q source=%+v", input, source)
		}
		return want, nil
	})}
	got, err := adapter.Process(context.Background(), []byte("source"), emotes.UploadSource{MIMEType: "image/gif", FileName: "private.gif"})
	if err != nil || !reflect.DeepEqual(got, emotes.ProcessedUpload(want)) {
		t.Fatalf("result=%+v err=%v", got, err)
	}
}

func TestEmoteProcessorPreservesSafeErrorsAndCancellation(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		code   string
		status int
	}{
		{"validation", &media.Error{Code: emotes.CodeEmoteInputTooLarge, Message: emotes.MessageEmoteInputTooLarge, StatusCode: 413, Cause: errors.New("private decoder detail")}, emotes.CodeEmoteInputTooLarge, 413},
		{"unavailable", &media.Error{Code: media.CodeProcessingUnavailable, StatusCode: 503, Cause: errors.New("private library path")}, emotes.CodeEmoteProcessingUnavailable, 503},
		{"canceled", context.Canceled, "", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			adapter := emoteMediaProcessor{processor: imageProcessorFunc(func(context.Context, []byte, media.Source) (media.ProcessedUpload, error) {
				return media.ProcessedUpload{}, test.err
			})}
			_, err := adapter.Process(context.Background(), nil, emotes.UploadSource{})
			if test.code == "" {
				if !errors.Is(err, test.err) {
					t.Fatalf("error=%v", err)
				}
				return
			}
			var domainErr *emotes.Error
			if !errors.As(err, &domainErr) || domainErr.Code != test.code || domainErr.StatusCode != test.status || domainErr.Cause != nil {
				t.Fatalf("public error=%#v", err)
			}
		})
	}
}
