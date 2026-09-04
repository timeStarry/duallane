package media

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"mime"
	"strings"
	"sync"
)

const (
	KindAvatar      Kind = "avatar"
	KindCustomEmote Kind = "custom_emote"
)

const (
	AvatarMaxInputBytes          int64 = 5 * 1024 * 1024
	CustomEmoteMaxInputBytes     int64 = 10 * 1024 * 1024
	MaxInputPixels               int64 = 40 * 1024 * 1024
	AvatarMaxInputEdge                 = 8192
	CustomEmoteMaxInputEdge            = 4096
	CustomEmoteMaxFrames               = 180
	CustomEmoteMaxDurationMS     int64 = 30 * 1000
	MaxOutputBytes               int64 = 2 * 1024 * 1024
	DefaultTargetSize                  = 256
	FallbackTargetSize                 = 192
	AvatarQuality                      = 82
	StaticEmoteQuality                 = 82
	AnimatedEmoteQuality               = 76
	FallbackQuality                    = 62
	DefaultProcessingConcurrency       = 2
	DefaultVipsConcurrency             = 1
	DefaultVipsCacheMemoryBytes  int   = 64 * 1024 * 1024
)

// Kind chooses the compatibility policy applied by Processor.Process.
type Kind string

// Source identifies the declared request media type and processing policy.
// MIMEType is advisory for sniffing compatibility: it must be allowlisted,
// while the actual format is determined from the bytes.
type Source struct {
	Kind     Kind
	MIMEType string
}

// ProcessedUpload is the normalized object metadata consumed by Workspace
// avatar and custom-emote services. Content is always newly encoded WebP.
type ProcessedUpload struct {
	Content            []byte
	DetectedMIMEType   string
	NormalizedMIMEType string
	Label              string
	ByteSize           int64
	Width              int
	Height             int
	FrameCount         int
	DurationMS         int64
	SHA256             string
}

// Result is an alias kept for callers that prefer a media-oriented name.
type Result = ProcessedUpload

// Limits bounds both the cheap header inspection and the libvips operation.
// MaxInputPixels is a total decoded pixel budget for an animation, rather
// than merely a per-frame budget, to prevent a frame-count amplification.
type Limits struct {
	MaxInputBytes     int64
	MaxInputPixels    int64
	MaxInputEdge      int
	MaxFrames         int
	MaxDurationMS     int64
	MaxOutputBytes    int64
	TargetSize        int
	FallbackSize      int
	StaticQuality     int
	AnimatedQuality   int
	FallbackQuality   int
	Cover             bool
	PreserveAnimation bool
}

// Options controls a process-wide govips-backed Processor. Zero values select
// the documented compatibility defaults.
type Options struct {
	Avatar                   Limits
	CustomEmote              Limits
	MaxProcessingConcurrency int
	VipsConcurrency          int
	VipsCacheMemoryBytes     int
}

// DefaultOptions returns independent copies of the two built-in policies.
func DefaultOptions() Options {
	return Options{
		Avatar:                   defaultAvatarLimits(),
		CustomEmote:              defaultCustomEmoteLimits(),
		MaxProcessingConcurrency: DefaultProcessingConcurrency,
		VipsConcurrency:          DefaultVipsConcurrency,
		VipsCacheMemoryBytes:     DefaultVipsCacheMemoryBytes,
	}
}

func defaultAvatarLimits() Limits {
	return Limits{
		MaxInputBytes:     AvatarMaxInputBytes,
		MaxInputPixels:    MaxInputPixels,
		MaxInputEdge:      AvatarMaxInputEdge,
		MaxFrames:         CustomEmoteMaxFrames,
		MaxDurationMS:     CustomEmoteMaxDurationMS,
		TargetSize:        DefaultTargetSize,
		StaticQuality:     AvatarQuality,
		AnimatedQuality:   AvatarQuality,
		Cover:             true,
		PreserveAnimation: false,
	}
}

func defaultCustomEmoteLimits() Limits {
	return Limits{
		MaxInputBytes:     CustomEmoteMaxInputBytes,
		MaxInputPixels:    MaxInputPixels,
		MaxInputEdge:      CustomEmoteMaxInputEdge,
		MaxFrames:         CustomEmoteMaxFrames,
		MaxDurationMS:     CustomEmoteMaxDurationMS,
		MaxOutputBytes:    MaxOutputBytes,
		TargetSize:        DefaultTargetSize,
		FallbackSize:      FallbackTargetSize,
		StaticQuality:     StaticEmoteQuality,
		AnimatedQuality:   AnimatedEmoteQuality,
		FallbackQuality:   FallbackQuality,
		Cover:             false,
		PreserveAnimation: true,
	}
}

func normalizeOptions(options Options) (Options, error) {
	defaults := DefaultOptions()
	if options.Avatar == (Limits{}) {
		options.Avatar = defaults.Avatar
	} else if err := mergeLimits(&options.Avatar, defaults.Avatar); err != nil {
		return Options{}, err
	}
	if options.CustomEmote == (Limits{}) {
		options.CustomEmote = defaults.CustomEmote
	} else if err := mergeLimits(&options.CustomEmote, defaults.CustomEmote); err != nil {
		return Options{}, err
	}
	if options.MaxProcessingConcurrency == 0 {
		options.MaxProcessingConcurrency = defaults.MaxProcessingConcurrency
	}
	if options.VipsConcurrency == 0 {
		options.VipsConcurrency = defaults.VipsConcurrency
	}
	if options.VipsCacheMemoryBytes == 0 {
		options.VipsCacheMemoryBytes = defaults.VipsCacheMemoryBytes
	}
	if options.MaxProcessingConcurrency < 1 || options.MaxProcessingConcurrency > 64 {
		return Options{}, invalidLimitsError(errors.New("processing concurrency outside 1..64"))
	}
	if options.VipsConcurrency < 1 || options.VipsConcurrency > 64 {
		return Options{}, invalidLimitsError(errors.New("vips concurrency outside 1..64"))
	}
	if options.VipsCacheMemoryBytes < 0 {
		return Options{}, invalidLimitsError(errors.New("vips cache memory is negative"))
	}
	return options, nil
}

func mergeLimits(value *Limits, defaults Limits) error {
	if value.MaxInputBytes == 0 {
		value.MaxInputBytes = defaults.MaxInputBytes
	}
	if value.MaxInputPixels == 0 {
		value.MaxInputPixels = defaults.MaxInputPixels
	}
	if value.MaxInputEdge == 0 {
		value.MaxInputEdge = defaults.MaxInputEdge
	}
	if value.MaxFrames == 0 {
		value.MaxFrames = defaults.MaxFrames
	}
	if value.MaxDurationMS == 0 {
		value.MaxDurationMS = defaults.MaxDurationMS
	}
	if value.TargetSize == 0 {
		value.TargetSize = defaults.TargetSize
	}
	if value.StaticQuality == 0 {
		value.StaticQuality = defaults.StaticQuality
	}
	if value.AnimatedQuality == 0 {
		value.AnimatedQuality = defaults.AnimatedQuality
	}
	if value.FallbackSize == 0 && defaults.FallbackSize > 0 {
		value.FallbackSize = defaults.FallbackSize
	}
	if value.FallbackQuality == 0 && defaults.FallbackQuality > 0 {
		value.FallbackQuality = defaults.FallbackQuality
	}
	if value.MaxOutputBytes == 0 && defaults.MaxOutputBytes > 0 {
		value.MaxOutputBytes = defaults.MaxOutputBytes
	}
	if defaults.Cover {
		value.Cover = true
	}
	if defaults.PreserveAnimation {
		value.PreserveAnimation = true
	}
	if value.MaxInputBytes < 1 || value.MaxInputPixels < 1 || value.MaxInputEdge < 1 || value.MaxFrames < 1 || value.MaxDurationMS < 0 || value.TargetSize < 1 || value.StaticQuality < 1 || value.StaticQuality > 100 || value.AnimatedQuality < 1 || value.AnimatedQuality > 100 {
		return invalidLimitsError(errors.New("image limits contain a non-positive or out-of-range value"))
	}
	if value.MaxOutputBytes < 0 || value.FallbackSize < 0 || value.FallbackQuality < 0 || value.FallbackQuality > 100 {
		return invalidLimitsError(errors.New("output limits are invalid"))
	}
	if value.MaxOutputBytes > 0 && (value.FallbackSize == 0 || value.FallbackQuality == 0) {
		return invalidLimitsError(errors.New("bounded output requires a fallback encoding"))
	}
	return nil
}

func (o Options) limits(kind Kind) (Limits, bool) {
	switch kind {
	case KindAvatar:
		return o.Avatar, true
	case KindCustomEmote:
		return o.CustomEmote, true
	default:
		return Limits{}, false
	}
}

func allowedMIME(kind Kind, value string) bool {
	switch kind {
	case KindAvatar:
		return value == "image/jpeg" || value == "image/png" || value == "image/webp"
	case KindCustomEmote:
		return value == "image/jpeg" || value == "image/png" || value == "image/webp" || value == "image/gif" || value == "image/bmp"
	default:
		return false
	}
}

func normalizeMIME(value string) (string, bool) {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" {
		return "", false
	}
	mediaType, params, err := mime.ParseMediaType(value)
	if err != nil || len(params) != 0 {
		return "", false
	}
	return strings.ToLower(strings.TrimSpace(mediaType)), true
}

func formatMIME(format string) string {
	switch format {
	case "jpeg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	case "bmp":
		return "image/bmp"
	default:
		return ""
	}
}

func codeFor(kind Kind, suffix string) string {
	switch kind {
	case KindAvatar:
		return "avatar." + suffix
	case KindCustomEmote:
		return "emote." + suffix
	default:
		return "media." + suffix
	}
}

func validationError(kind Kind, suffix, message string, status int, cause error) *Error {
	return mediaError(codeFor(kind, suffix), message, status, cause)
}

func supportedFormatError(kind Kind, cause error) *Error {
	suffix := "unsupported_format"
	message := "头像仅支持 JPEG、PNG 或 WebP"
	if kind == KindCustomEmote {
		suffix = "invalid_format"
		message = "仅支持 JPEG、PNG、WebP、GIF 或 BMP 图片"
	}
	return validationError(kind, suffix, message, 400, cause)
}

func inputTooLargeError(kind Kind, cause error) *Error {
	suffix := "input_too_large"
	message := "表情原图不能超过 10 MiB"
	status := 413
	if kind == KindAvatar {
		suffix = "invalid_size"
		message = "头像文件大小应在 5 MiB 以内"
		status = 400
	}
	return validationError(kind, suffix, message, status, cause)
}

func invalidContentError(kind Kind, cause error) *Error {
	suffix := "invalid_content"
	message := "表情图片不能为空"
	if kind == KindAvatar {
		suffix = "invalid_size"
		message = "头像文件大小与请求不一致"
	}
	return validationError(kind, suffix, message, 400, cause)
}

func decodeFailedError(kind Kind, cause error) *Error {
	suffix := "decode_failed"
	message := "图片无法解析"
	if kind == KindAvatar {
		suffix = "invalid_image"
		message = "头像图片无法解析"
	}
	return validationError(kind, suffix, message, 400, cause)
}

func dimensionsExceededError(kind Kind, cause error) *Error {
	message := "图片尺寸过大"
	if kind == KindAvatar {
		message = "头像图片尺寸或格式无效"
		return validationError(kind, "invalid_image", message, 400, cause)
	}
	return validationError(kind, "dimensions_exceeded", message, 400, cause)
}

func animationTooComplexError(kind Kind, cause error) *Error {
	return validationError(kind, "animation_too_complex", "动图帧数或时长超出限制", 400, cause)
}

func processFailedError(kind Kind, cause error) *Error {
	message := "图片处理失败"
	suffix := "process_failed"
	if kind == KindAvatar {
		message = "头像处理失败"
		suffix = "processing_failed"
	}
	return validationError(kind, suffix, message, 500, cause)
}

func outputTooLargeError(kind Kind, cause error) *Error {
	return validationError(kind, "output_too_large", "压缩后的图片仍然过大", 400, cause)
}

func hashBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

// Processor is the concrete govips-backed implementation declared in
// processor.go. Keeping its public methods here documents the narrow boundary
// independently of the native dependency.
type Processor struct {
	options Options
	slots   chan struct{}
}

// NewProcessor initializes libvips once for the process and returns a bounded
// processor. It fails closed when the native runtime is unavailable.
func NewProcessor(options Options) (*Processor, error) {
	return newProcessor(options)
}

// Process normalizes an image according to source.Kind.
func (p *Processor) Process(ctx context.Context, input []byte, source Source) (ProcessedUpload, error) {
	return p.process(ctx, input, source)
}

// ProcessAvatar is a convenience wrapper for profile avatar callers.
func (p *Processor) ProcessAvatar(ctx context.Context, input []byte, mimeType string) (ProcessedUpload, error) {
	return p.Process(ctx, input, Source{Kind: KindAvatar, MIMEType: mimeType})
}

// ProcessCustomEmote is a convenience wrapper for custom-emote callers.
func (p *Processor) ProcessCustomEmote(ctx context.Context, input []byte, mimeType string) (ProcessedUpload, error) {
	return p.Process(ctx, input, Source{Kind: KindCustomEmote, MIMEType: mimeType})
}

func (p *Processor) acquire(ctx context.Context) error {
	select {
	case p.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *Processor) release() {
	<-p.slots
}

var startupOnce sync.Once
var startupErr error
