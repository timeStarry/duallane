package media

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestProcessRejectsBeforeNativeDecode(t *testing.T) {
	options := DefaultOptions()
	processor := &Processor{options: options, slots: make(chan struct{}, 1)}

	cases := []struct {
		name   string
		input  []byte
		source Source
		code   string
	}{
		{
			name:   "unknown kind",
			input:  []byte("x"),
			source: Source{Kind: Kind("unknown"), MIMEType: "image/png"},
			code:   CodeInvalidSource,
		},
		{
			name:   "avatar MIME",
			input:  []byte("x"),
			source: Source{Kind: KindAvatar, MIMEType: "text/plain"},
			code:   "avatar.unsupported_format",
		},
		{
			name:   "emote MIME",
			input:  []byte("x"),
			source: Source{Kind: KindCustomEmote, MIMEType: "text/plain"},
			code:   "emote.invalid_format",
		},
		{
			name:   "avatar empty",
			input:  nil,
			source: Source{Kind: KindAvatar, MIMEType: "image/png"},
			code:   "avatar.invalid_size",
		},
		{
			name:   "emote empty",
			input:  nil,
			source: Source{Kind: KindCustomEmote, MIMEType: "image/png"},
			code:   "emote.invalid_content",
		},
		{
			name:   "avatar malformed",
			input:  []byte("not an image"),
			source: Source{Kind: KindAvatar, MIMEType: "image/png"},
			code:   "avatar.invalid_image",
		},
		{
			name:   "emote malformed",
			input:  []byte("not an image"),
			source: Source{Kind: KindCustomEmote, MIMEType: "image/png"},
			code:   "emote.decode_failed",
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := processor.Process(context.Background(), test.input, test.source)
			if code := errorCode(err); code != test.code {
				t.Fatalf("Process() error code = %q, want %q (error=%v)", code, test.code, err)
			}
		})
	}

	smallOptions := DefaultOptions()
	smallOptions.Avatar.MaxInputBytes = 1
	smallOptions.CustomEmote.MaxInputBytes = 1
	smallProcessor := &Processor{options: smallOptions, slots: make(chan struct{}, 1)}
	for _, test := range []struct {
		name   string
		source Source
		code   string
	}{
		{name: "avatar input size", source: Source{Kind: KindAvatar, MIMEType: "image/png"}, code: "avatar.invalid_size"},
		{name: "emote input size", source: Source{Kind: KindCustomEmote, MIMEType: "image/png"}, code: "emote.input_too_large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := smallProcessor.Process(context.Background(), []byte("xx"), test.source)
			if code := errorCode(err); code != test.code {
				t.Fatalf("Process() error code = %q, want %q (error=%v)", code, test.code, err)
			}
		})
	}
}

func TestProcessCancellationFailsClosed(t *testing.T) {
	processor := &Processor{options: DefaultOptions(), slots: make(chan struct{}, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := processor.Process(ctx, []byte("x"), Source{Kind: KindAvatar, MIMEType: "image/png"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Process() error = %v, want context.Canceled", err)
	}
}

func TestPublicErrorNeverExposesCause(t *testing.T) {
	processor := &Processor{options: DefaultOptions(), slots: make(chan struct{}, 1)}
	_, err := processor.Process(context.Background(), []byte("not an image"), Source{Kind: KindAvatar, MIMEType: "image/png"})
	var mediaErr *Error
	if !errors.As(err, &mediaErr) {
		t.Fatalf("Process() error = %T, want *Error", err)
	}
	public := mediaErr.Public()
	if public == mediaErr || public.Cause != nil || public.Code != mediaErr.Code || public.Message != mediaErr.Message {
		t.Fatalf("Public() = %#v, want independent safe copy", public)
	}
	encoded, err := json.Marshal(mediaErr)
	if err != nil {
		t.Fatalf("marshal public error: %v", err)
	}
	if string(encoded) != `{"code":"avatar.invalid_image","message":"头像图片无法解析"}` {
		t.Fatalf("serialized error = %s", encoded)
	}
}

func TestProcessorNormalizesStaticPNGWhenLibvipsIsAvailable(t *testing.T) {
	processor := newTestProcessor(t)
	result, err := processor.Process(context.Background(), encodePNG(t, 4, 2), Source{Kind: KindAvatar, MIMEType: "image/png"})
	if err != nil {
		t.Fatalf("Process() error = %v", err)
	}
	if result.DetectedMIMEType != "image/png" || result.NormalizedMIMEType != "image/webp" {
		t.Fatalf("MIME metadata = %#v", result)
	}
	if result.Width != 256 || result.Height != 256 || result.FrameCount != 1 || result.DurationMS != 0 {
		t.Fatalf("avatar metadata = %#v, want 256x256 static", result)
	}
	if result.ByteSize != int64(len(result.Content)) || result.SHA256 != hashBytes(result.Content) {
		t.Fatalf("content metadata is inconsistent: %#v", result)
	}
	output, err := inspectImage(result.Content)
	if err != nil || output.format != "webp" || output.frameCount != 1 {
		t.Fatalf("normalized output header = %#v, error=%v", output, err)
	}
}

func TestProcessorDoesNotUpscaleCustomEmote(t *testing.T) {
	processor := newTestProcessor(t)
	result, err := processor.Process(context.Background(), encodePNG(t, 4, 2), Source{Kind: KindCustomEmote, MIMEType: "image/png"})
	if err != nil {
		t.Fatalf("Process() error = %v", err)
	}
	if result.Width != 4 || result.Height != 2 {
		t.Fatalf("custom emote was enlarged: %dx%d", result.Width, result.Height)
	}
	webpResult, err := processor.Process(context.Background(), result.Content, Source{Kind: KindCustomEmote, MIMEType: "image/webp"})
	if err != nil {
		t.Fatalf("reprocess static WebP: %v", err)
	}
	if webpResult.DetectedMIMEType != "image/webp" || webpResult.FrameCount != 1 {
		t.Fatalf("static WebP result = %#v", webpResult)
	}
}

func TestProcessorPreservesAnimatedGIFMetadata(t *testing.T) {
	processor := newTestProcessor(t)
	result, err := processor.Process(context.Background(), encodeGIF(t, 8, 4, []int{7, 13}), Source{Kind: KindCustomEmote, MIMEType: "image/gif"})
	if err != nil {
		t.Fatalf("Process() error = %v", err)
	}
	if result.DetectedMIMEType != "image/gif" || result.FrameCount != 2 || result.DurationMS != 200 {
		t.Fatalf("animated metadata = %#v, want GIF/2/200", result)
	}
	output, err := inspectImage(result.Content)
	if err != nil {
		t.Fatalf("inspect normalized animation: %v", err)
	}
	if output.format != "webp" || output.frameCount != 2 || output.durationMS != 200 {
		t.Fatalf("normalized animation header = %#v", output)
	}
	if result.Width > DefaultTargetSize || result.Height > DefaultTargetSize {
		t.Fatalf("normalized animation exceeds target: %dx%d", result.Width, result.Height)
	}
	webpResult, err := processor.Process(context.Background(), result.Content, Source{Kind: KindCustomEmote, MIMEType: "image/webp"})
	if err != nil {
		t.Fatalf("reprocess animated WebP: %v", err)
	}
	if webpResult.DetectedMIMEType != "image/webp" || webpResult.FrameCount != 2 || webpResult.DurationMS != 200 {
		t.Fatalf("animated WebP result = %#v", webpResult)
	}
}

func TestProcessorPreservesSingleFrameGIFDelayMetadata(t *testing.T) {
	processor := newTestProcessor(t)
	result, err := processor.Process(context.Background(), encodeGIF(t, 8, 4, []int{13}), Source{Kind: KindCustomEmote, MIMEType: "image/gif"})
	if err != nil {
		t.Fatalf("Process() error = %v", err)
	}
	if result.FrameCount != 1 || result.DurationMS != 130 {
		t.Fatalf("single-frame GIF metadata = %#v, want 1/130", result)
	}
}

func TestProcessorAcceptsCompatibilityBMP(t *testing.T) {
	processor := newTestProcessor(t)
	result, err := processor.Process(context.Background(), encodeBMP(8, 4, 24, false), Source{Kind: KindCustomEmote, MIMEType: "image/bmp"})
	if err != nil {
		t.Fatalf("Process() error = %v", err)
	}
	if result.DetectedMIMEType != "image/bmp" || result.NormalizedMIMEType != "image/webp" || result.Width != 8 || result.Height != 4 {
		t.Fatalf("BMP result = %#v", result)
	}
}

func newTestProcessor(t *testing.T) *Processor {
	t.Helper()
	processor, err := NewProcessor(DefaultOptions())
	if err != nil {
		var mediaErr *Error
		if errors.As(err, &mediaErr) && mediaErr.Code == CodeProcessingUnavailable {
			t.Skipf("libvips unavailable: %v", mediaErr.Message)
		}
		t.Fatalf("NewProcessor() error = %v", err)
	}
	return processor
}

func errorCode(err error) string {
	var mediaErr *Error
	if errors.As(err, &mediaErr) {
		return mediaErr.Code
	}
	return strings.TrimSpace(errString(err))
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
