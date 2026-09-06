package media

import (
	"context"
	"errors"
	"image"
	"image/color"
	"math"

	"github.com/davidbyttow/govips/v2/vips"
)

func newProcessor(options Options) (*Processor, error) {
	options, err := normalizeOptions(options)
	if err != nil {
		return nil, err
	}
	startupOnce.Do(func() {
		// Native diagnostic text can include paths and attacker-controlled image
		// metadata. Keep it off stdout/stderr; callers receive typed safe errors
		// and the owning domain records content-free rejection audits.
		vips.LoggingSettings(func(string, vips.LogLevel, string) {}, vips.LogLevelError)
		startupErr = vips.Startup(&vips.Config{
			ConcurrencyLevel: options.VipsConcurrency,
			MaxCacheMem:      options.VipsCacheMemoryBytes,
			MaxCacheSize:     32,
			MaxCacheFiles:    0,
		})
	})
	if startupErr != nil {
		return nil, unavailableError(startupErr)
	}
	return &Processor{
		options: options,
		slots:   make(chan struct{}, options.MaxProcessingConcurrency),
	}, nil
}

func (p *Processor) process(ctx context.Context, input []byte, source Source) (ProcessedUpload, error) {
	if p == nil {
		return ProcessedUpload{}, unavailableError(errors.New("processor is nil"))
	}
	if err := ctx.Err(); err != nil {
		return ProcessedUpload{}, err
	}
	limits, ok := p.options.limits(source.Kind)
	if !ok {
		return ProcessedUpload{}, mediaError(CodeInvalidSource, "媒体处理类型无效", 400, errors.New("unknown media kind"))
	}
	mimeType, ok := normalizeMIME(source.MIMEType)
	if !ok || !allowedMIME(source.Kind, mimeType) {
		return ProcessedUpload{}, supportedFormatError(source.Kind, errors.New("declared MIME type is not allowlisted"))
	}
	if len(input) == 0 {
		return ProcessedUpload{}, invalidContentError(source.Kind, errors.New("empty input"))
	}
	if int64(len(input)) > limits.MaxInputBytes {
		return ProcessedUpload{}, inputTooLargeError(source.Kind, errors.New("input byte limit exceeded"))
	}
	info, inspectErr := inspectImage(input)
	if inspectErr != nil {
		return ProcessedUpload{}, decodeFailedError(source.Kind, inspectErr)
	}
	if !formatAllowed(source.Kind, info.format) {
		if source.Kind == KindAvatar {
			return ProcessedUpload{}, decodeFailedError(source.Kind, errors.New("format is not accepted for avatars"))
		}
		return ProcessedUpload{}, supportedFormatError(source.Kind, errors.New("format is not accepted"))
	}
	if err := info.validate(source.Kind, limits); err != nil {
		return ProcessedUpload{}, err
	}
	if err := p.acquire(ctx); err != nil {
		return ProcessedUpload{}, err
	}
	defer p.release()

	firstSize := limits.TargetSize
	quality := limits.StaticQuality
	if info.frameCount > 1 {
		quality = limits.AnimatedQuality
	}
	encoded, err := p.encode(ctx, input, source.Kind, info, limits, firstSize, quality)
	if err != nil {
		return ProcessedUpload{}, err
	}
	if limits.MaxOutputBytes > 0 && int64(len(encoded.content)) > limits.MaxOutputBytes {
		if limits.FallbackSize <= 0 || limits.FallbackQuality <= 0 {
			return ProcessedUpload{}, outputTooLargeError(source.Kind, errors.New("output byte limit exceeded"))
		}
		encoded, err = p.encode(ctx, input, source.Kind, info, limits, limits.FallbackSize, limits.FallbackQuality)
		if err != nil {
			return ProcessedUpload{}, err
		}
		if int64(len(encoded.content)) > limits.MaxOutputBytes {
			return ProcessedUpload{}, outputTooLargeError(source.Kind, errors.New("fallback output byte limit exceeded"))
		}
	}
	if err := ctx.Err(); err != nil {
		return ProcessedUpload{}, err
	}
	frameCount := encoded.frameCount
	durationMS := encoded.durationMS
	if frameCount < 1 {
		frameCount = 1
	}
	return ProcessedUpload{
		Content:            encoded.content,
		DetectedMIMEType:   formatMIME(info.format),
		NormalizedMIMEType: "image/webp",
		ByteSize:           int64(len(encoded.content)),
		Width:              encoded.width,
		Height:             encoded.height,
		FrameCount:         frameCount,
		DurationMS:         durationMS,
		SHA256:             hashBytes(encoded.content),
	}, nil
}

func formatAllowed(kind Kind, format string) bool {
	switch kind {
	case KindAvatar:
		return format == "jpeg" || format == "png" || format == "webp"
	case KindCustomEmote:
		return format == "jpeg" || format == "png" || format == "webp" || format == "gif" || format == "bmp"
	default:
		return false
	}
}

type encodedImage struct {
	content    []byte
	width      int
	height     int
	frameCount int
	durationMS int64
}

func (p *Processor) encode(ctx context.Context, input []byte, kind Kind, info imageHeader, limits Limits, size, quality int) (encodedImage, error) {
	if err := ctx.Err(); err != nil {
		return encodedImage{}, err
	}
	imageRef, err := loadImage(input, info, limits)
	if err != nil {
		return encodedImage{}, decodeFailedError(kind, err)
	}
	defer imageRef.Close()

	frameCount := imageRef.Pages()
	if frameCount < 1 {
		frameCount = 1
	}
	pageHeight := imageRef.PageHeight()
	if pageHeight <= 0 || pageHeight > imageRef.Height() {
		pageHeight = imageRef.Height()
	}
	durationMS, delays, err := imageAnimationMetadata(imageRef, frameCount)
	if err != nil {
		return encodedImage{}, processFailedError(kind, err)
	}
	if limits.PreserveAnimation && frameCount == 1 && info.frameCount == 1 {
		// libvips does not expose a delay array for a single-page GIF, while
		// Sharp includes its GCE delay in the compatibility metadata.
		durationMS = info.durationMS
	}
	if limits.PreserveAnimation && info.frameCount > 1 && frameCount < 2 {
		return encodedImage{}, processFailedError(kind, errors.New("animated input was not decoded as multiple pages"))
	}
	if err := validateDecodedImage(kind, limits, imageRef.Width(), pageHeight, frameCount, durationMS); err != nil {
		return encodedImage{}, err
	}
	if err := autorotate(imageRef); err != nil {
		return encodedImage{}, processFailedError(kind, err)
	}
	if err := ctx.Err(); err != nil {
		return encodedImage{}, err
	}
	if limits.Cover {
		if err := imageRef.Thumbnail(size, size, vips.InterestingCentre); err != nil {
			return encodedImage{}, processFailedError(kind, err)
		}
	} else {
		width := imageRef.Width()
		height := imageRef.PageHeight()
		if height <= 0 || height > imageRef.Height() {
			height = imageRef.Height()
		}
		if width <= 0 || height <= 0 {
			return encodedImage{}, processFailedError(kind, errors.New("image has zero dimensions"))
		}
		scale := math.Min(float64(size)/float64(width), float64(size)/float64(height))
		if scale < 1 {
			if err := imageRef.Resize(scale, vips.KernelLanczos3); err != nil {
				return encodedImage{}, processFailedError(kind, err)
			}
		}
	}
	if len(delays) > 1 {
		if err := imageRef.SetPageDelay(delays); err != nil {
			return encodedImage{}, processFailedError(kind, err)
		}
		if err := imageRef.SetLoop(0); err != nil {
			return encodedImage{}, processFailedError(kind, err)
		}
	}
	if err := imageRef.RemoveMetadata(); err != nil {
		return encodedImage{}, processFailedError(kind, err)
	}
	if err := imageRef.RemoveICCProfile(); err != nil {
		return encodedImage{}, processFailedError(kind, err)
	}
	if err := imageRef.RemoveOrientation(); err != nil {
		return encodedImage{}, processFailedError(kind, err)
	}
	output, outputMetadata, err := imageRef.ExportWebp(&vips.WebpExportParams{
		Quality:         quality,
		Lossless:        false,
		NearLossless:    false,
		ReductionEffort: 4,
		StripMetadata:   true,
	})
	if err != nil {
		return encodedImage{}, processFailedError(kind, err)
	}
	outputInfo, err := inspectImage(output)
	if err != nil || outputInfo.format != "webp" {
		if err == nil {
			err = errors.New("normalized output is not WebP")
		}
		return encodedImage{}, processFailedError(kind, err)
	}
	if limits.PreserveAnimation && info.frameCount > 1 && outputInfo.frameCount != frameCount {
		return encodedImage{}, processFailedError(kind, errors.New("normalized output lost animation frames"))
	}
	if !limits.PreserveAnimation && outputInfo.frameCount != 1 {
		return encodedImage{}, processFailedError(kind, errors.New("normalized output is unexpectedly animated"))
	}
	var width, height int
	if outputMetadata != nil {
		width = outputMetadata.Width
		height = outputMetadata.Height
	}
	if width <= 0 {
		width = imageRef.Width()
	}
	if height <= 0 {
		height = imageRef.Height()
	}
	if frameCount > 1 {
		if pageHeight = imageRef.PageHeight(); pageHeight > 0 {
			height = pageHeight
		}
	}
	if outputInfo.width > 0 {
		width = int(outputInfo.width)
	}
	if outputInfo.height > 0 {
		height = int(outputInfo.height)
	}
	outputDurationMS := outputInfo.durationMS
	if limits.PreserveAnimation && info.frameCount == 1 {
		// A single-frame GIF may carry a GCE delay. The normalized static WebP
		// cannot retain that delay, but the compatibility metadata still does.
		outputDurationMS = durationMS
	}
	return encodedImage{
		content: output, width: width, height: height,
		frameCount: outputInfo.frameCount, durationMS: outputDurationMS,
	}, nil
}

func loadImage(input []byte, info imageHeader, limits Limits) (*vips.ImageRef, error) {
	if info.format == "bmp" {
		if info.bmp == nil {
			return nil, errors.New("BMP header is missing")
		}
		decoded, err := decodeBMP(input, *info.bmp)
		if err != nil {
			return nil, err
		}
		return vips.NewImageFromGoImage(decoded)
	}
	params := vips.NewImportParams()
	params.FailOnError.Set(true)
	if limits.PreserveAnimation {
		params.NumPages.Set(info.frameCount)
	} else {
		params.NumPages.Set(1)
	}
	return vips.LoadImageFromBuffer(input, params)
}

func imageAnimationMetadata(imageRef *vips.ImageRef, frameCount int) (int64, []int, error) {
	if frameCount <= 1 {
		return 0, nil, nil
	}
	delays, err := imageRef.PageDelay()
	if err != nil {
		return 0, nil, err
	}
	if len(delays) != frameCount {
		return 0, nil, errors.New("animation delay count does not match frame count")
	}
	var duration int64
	for _, delay := range delays {
		if delay < 0 || duration > math.MaxInt64-int64(delay) {
			return 0, nil, errors.New("invalid animation delay")
		}
		duration += int64(delay)
	}
	return duration, delays, nil
}

func validateDecodedImage(kind Kind, limits Limits, width, height, frameCount int, durationMS int64) *Error {
	if width <= 0 || height <= 0 || width > limits.MaxInputEdge || height > limits.MaxInputEdge {
		return dimensionsExceededError(kind, errors.New("decoded dimensions exceed limit"))
	}
	if frameCount < 1 || frameCount > limits.MaxFrames || durationMS < 0 || durationMS > limits.MaxDurationMS {
		return animationTooComplexError(kind, errors.New("decoded animation exceeds limit"))
	}
	pixels, ok := checkedMul(uint64(width), uint64(height))
	if !ok || pixels > uint64(limits.MaxInputPixels) {
		return dimensionsExceededError(kind, errors.New("decoded pixel budget exceeded"))
	}
	total, ok := checkedMul(pixels, uint64(frameCount))
	if !ok || total > uint64(limits.MaxInputPixels) {
		return dimensionsExceededError(kind, errors.New("animated decoded pixel budget exceeded"))
	}
	return nil
}

func autorotate(imageRef *vips.ImageRef) error {
	switch imageRef.Orientation() {
	case 2:
		if err := imageRef.Flip(vips.DirectionHorizontal); err != nil {
			return err
		}
		return imageRef.RemoveOrientation()
	case 3, 6, 8:
		return imageRef.AutoRotate()
	case 4:
		if err := imageRef.Flip(vips.DirectionVertical); err != nil {
			return err
		}
		return imageRef.RemoveOrientation()
	case 5:
		if err := imageRef.Flip(vips.DirectionHorizontal); err != nil {
			return err
		}
		if err := imageRef.Rotate(vips.Angle270); err != nil {
			return err
		}
		return imageRef.RemoveOrientation()
	case 7:
		if err := imageRef.Flip(vips.DirectionHorizontal); err != nil {
			return err
		}
		if err := imageRef.Rotate(vips.Angle90); err != nil {
			return err
		}
		return imageRef.RemoveOrientation()
	default:
		return imageRef.RemoveOrientation()
	}
}

func decodeBMP(input []byte, header bmpHeader) (image.Image, error) {
	if header.width <= 0 || header.height <= 0 || header.bytesPerPixel != 3 && header.bytesPerPixel != 4 {
		return nil, errors.New("unsupported BMP layout")
	}
	if header.width > math.MaxInt/4 || header.height > math.MaxInt/(header.width*4) {
		return nil, errors.New("BMP pixel allocation overflow")
	}
	decoded := image.NewNRGBA(image.Rect(0, 0, header.width, header.height))
	for outputY := 0; outputY < header.height; outputY++ {
		sourceY := outputY
		if !header.topDown {
			sourceY = header.height - 1 - outputY
		}
		rowOffset := header.pixelOffset + uint64(sourceY)*header.rowStride
		for x := 0; x < header.width; x++ {
			sourceOffset := rowOffset + uint64(x*header.bytesPerPixel)
			if sourceOffset+uint64(header.bytesPerPixel) > uint64(len(input)) {
				return nil, errors.New("truncated BMP pixels")
			}
			pixel := input[sourceOffset:]
			alpha := uint8(255)
			if header.bytesPerPixel == 4 && pixel[3] != 0 {
				alpha = pixel[3]
			}
			decoded.SetNRGBA(x, outputY, color.NRGBA{R: pixel[2], G: pixel[1], B: pixel[0], A: alpha})
		}
	}
	return decoded, nil
}
