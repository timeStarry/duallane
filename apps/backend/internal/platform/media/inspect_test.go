package media

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestInspectValidFormats(t *testing.T) {
	jpegBytes := encodeJPEG(t, 3, 2)
	pngBytes := encodePNG(t, 4, 3)
	gifBytes := encodeGIF(t, 2, 2, []int{7})
	bmpBytes := encodeBMP(5, 4, 24, false)
	staticWebP := syntheticWebP(webPChunk{"VP8 ", vp8Payload(6, 5)})

	tests := []struct {
		name   string
		input  []byte
		format string
		width  uint64
		height uint64
	}{
		{name: "jpeg", input: jpegBytes, format: "jpeg", width: 3, height: 2},
		{name: "png", input: pngBytes, format: "png", width: 4, height: 3},
		{name: "gif", input: gifBytes, format: "gif", width: 2, height: 2},
		{name: "bmp", input: bmpBytes, format: "bmp", width: 5, height: 4},
		{name: "webp", input: staticWebP, format: "webp", width: 6, height: 5},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			header, err := inspectImage(test.input)
			if err != nil {
				t.Fatalf("inspectImage() error = %v", err)
			}
			if header.format != test.format || header.width != test.width || header.height != test.height {
				t.Fatalf("header = %#v, want %s %dx%d", header, test.format, test.width, test.height)
			}
			if header.frameCount != 1 {
				t.Fatalf("static frame count = %d, want 1", header.frameCount)
			}
			if test.format != "gif" && header.durationMS != 0 {
				t.Fatalf("static duration = %d, want 0", header.durationMS)
			}
		})
	}
}

func TestInspectAnimatedMetadata(t *testing.T) {
	gifHeader, err := inspectImage(encodeGIF(t, 2, 2, []int{7, 13}))
	if err != nil {
		t.Fatalf("inspect GIF: %v", err)
	}
	if gifHeader.frameCount != 2 || gifHeader.durationMS != 200 {
		t.Fatalf("GIF metadata = frames %d duration %d, want 2/200", gifHeader.frameCount, gifHeader.durationMS)
	}

	animatedWebP := syntheticWebP(
		webPChunk{"VP8X", vp8xPayload(2, 2, true)},
		webPChunk{"ANMF", anmfPayload(8, 6, 500)},
		webPChunk{"ANMF", anmfPayload(4, 3, 1250)},
	)
	webpHeader, err := inspectImage(animatedWebP)
	if err != nil {
		t.Fatalf("inspect animated WebP: %v", err)
	}
	if webpHeader.frameCount != 2 || webpHeader.durationMS != 1750 {
		t.Fatalf("WebP metadata = frames %d duration %d, want 2/1750", webpHeader.frameCount, webpHeader.durationMS)
	}
	if webpHeader.frameWidth != 8 || webpHeader.frameHeight != 6 {
		t.Fatalf("WebP frame metadata = %dx%d, want 8x6", webpHeader.frameWidth, webpHeader.frameHeight)
	}
}

func TestInspectRejectsMalformedAndTruncatedImages(t *testing.T) {
	validWebP := syntheticWebP(webPChunk{"VP8 ", vp8Payload(1, 1)})
	declaredTooLarge := append([]byte(nil), validWebP...)
	binary.LittleEndian.PutUint32(declaredTooLarge[4:8], uint32(len(declaredTooLarge)-8+1))

	cases := map[string][]byte{
		"unknown":                []byte("not an image"),
		"truncated jpeg":         {0xff, 0xd8, 0xff},
		"truncated png":          []byte("\x89PNG\r\n\x1a\n"),
		"empty gif":              append([]byte("GIF89a"), make([]byte, 7)...),
		"truncated bmp":          []byte("BM"),
		"declared webp size":     declaredTooLarge,
		"animated webp no frame": syntheticWebP(webPChunk{"VP8X", vp8xPayload(2, 2, true)}),
		"static webp with frame": syntheticWebP(
			webPChunk{"VP8X", vp8xPayload(2, 2, false)},
			webPChunk{"ANMF", anmfPayload(2, 2, 10)},
		),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := inspectImage(input); !errors.Is(err, errMalformedImage) {
				t.Fatalf("inspectImage() error = %v, want malformed image", err)
			}
		})
	}

	unsupportedBMP := encodeBMP(2, 2, 16, false)
	if _, err := inspectImage(unsupportedBMP); !errors.Is(err, errMalformedImage) {
		t.Fatalf("16-bit BMP error = %v, want malformed image", err)
	}
}

func TestImageHeaderValidationEnforcesAllDecodeBudgets(t *testing.T) {
	limits := defaultCustomEmoteLimits()

	cases := []struct {
		name   string
		header imageHeader
		code   string
	}{
		{
			name:   "canvas edge",
			header: staticImageHeader("png", uint64(limits.MaxInputEdge+1), 1),
			code:   "emote.dimensions_exceeded",
		},
		{
			name: "frame edge",
			header: imageHeader{
				format: "gif", width: 2, height: 2, frameWidth: uint64(limits.MaxInputEdge + 1), frameHeight: 1,
				frameCount: 1, totalFramePixels: uint64(limits.MaxInputEdge + 1),
			},
			code: "emote.dimensions_exceeded",
		},
		{
			name: "pixel budget",
			header: imageHeader{
				format: "png", width: 11, height: 11, frameWidth: 11, frameHeight: 11,
				frameCount: 1, totalFramePixels: 121,
			},
			code: "emote.dimensions_exceeded",
		},
		{
			name: "frame count",
			header: imageHeader{
				format: "gif", width: 1, height: 1, frameWidth: 1, frameHeight: 1,
				frameCount: limits.MaxFrames + 1, totalFramePixels: uint64(limits.MaxFrames + 1),
			},
			code: "emote.animation_too_complex",
		},
		{
			name: "duration",
			header: imageHeader{
				format: "gif", width: 1, height: 1, frameWidth: 1, frameHeight: 1,
				frameCount: 1, durationMS: limits.MaxDurationMS + 1, totalFramePixels: 1,
			},
			code: "emote.animation_too_complex",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			caseLimits := limits
			if test.name == "pixel budget" {
				caseLimits.MaxInputPixels = 100
			}
			err := test.header.validate(KindCustomEmote, caseLimits)
			if err == nil || err.Code != test.code {
				t.Fatalf("validate() error = %#v, want %s", err, test.code)
			}
		})
	}

	if err := (imageHeader{width: 1, height: 1, frameCount: 0}).validate(KindAvatar, defaultAvatarLimits()); err == nil || err.Code != "avatar.invalid_image" {
		t.Fatalf("invalid avatar header error = %#v, want avatar.invalid_image", err)
	}
}

func TestDecodeBMPHonorsOrientationAndAlphaCompatibility(t *testing.T) {
	for _, topDown := range []bool{false, true} {
		input := encodeBMP(2, 2, 32, topDown)
		header, err := inspectImage(input)
		if err != nil {
			t.Fatalf("inspect BMP (topDown=%t): %v", topDown, err)
		}
		decoded, err := decodeBMP(input, *header.bmp)
		if err != nil {
			t.Fatalf("decode BMP (topDown=%t): %v", topDown, err)
		}
		first := color.NRGBAModel.Convert(decoded.At(0, 0)).(color.NRGBA)
		if first != (color.NRGBA{R: 30, G: 20, B: 10, A: 255}) {
			t.Fatalf("first pixel (topDown=%t) = %#v", topDown, first)
		}
	}
}

func TestNormalizeMIMEAndHashAreStable(t *testing.T) {
	mimeType, ok := normalizeMIME(" IMAGE/PNG ")
	if !ok || mimeType != "image/png" {
		t.Fatalf("normalizeMIME() = %q, %t", mimeType, ok)
	}
	if _, ok := normalizeMIME("image/png; charset=binary"); ok {
		t.Fatal("normalizeMIME accepted MIME parameters")
	}
	if _, ok := normalizeMIME("image/png; invalid"); ok {
		t.Fatal("normalizeMIME accepted malformed media type")
	}
	if got := hashBytes([]byte("media")); got != "721c9525ade2ea8903d343ef25cf68b9bf4ab0aad56bb7b01fbe48d09bc7fcf4" {
		t.Fatalf("hashBytes() = %q", got)
	}
}

func TestOptionsRejectUnsafeBounds(t *testing.T) {
	if _, err := normalizeOptions(Options{MaxProcessingConcurrency: 65}); err == nil || err.(*Error).Code != CodeInvalidLimits {
		t.Fatalf("unsafe processing concurrency error = %v", err)
	}
	if _, err := normalizeOptions(Options{VipsConcurrency: 0, VipsCacheMemoryBytes: -1}); err == nil || err.(*Error).Code != CodeInvalidLimits {
		t.Fatalf("negative cache error = %v", err)
	}
	if _, err := normalizeOptions(Options{CustomEmote: Limits{FallbackQuality: 101}}); err == nil || err.(*Error).Code != CodeInvalidLimits {
		t.Fatalf("invalid output quality error = %v", err)
	}
}

func encodePNG(t *testing.T, width, height int) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := png.Encode(&output, solidImage(width, height)); err != nil {
		t.Fatalf("encode PNG: %v", err)
	}
	return output.Bytes()
}

func encodeJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := jpeg.Encode(&output, solidImage(width, height), &jpeg.Options{Quality: 80}); err != nil {
		t.Fatalf("encode JPEG: %v", err)
	}
	return output.Bytes()
}

func encodeGIF(t *testing.T, width, height int, delays []int) []byte {
	t.Helper()
	frames := make([]*image.Paletted, len(delays))
	for index := range frames {
		frame := image.NewPaletted(image.Rect(0, 0, width, height), color.Palette{
			color.Black,
			color.RGBA{R: uint8(20 + index), G: 40, B: 60, A: 255},
		})
		for pixel := range frame.Pix {
			frame.Pix[pixel] = uint8(index % 2)
		}
		frames[index] = frame
	}
	var output bytes.Buffer
	if err := gif.EncodeAll(&output, &gif.GIF{Image: frames, Delay: delays, LoopCount: 0}); err != nil {
		t.Fatalf("encode GIF: %v", err)
	}
	return output.Bytes()
}

func solidImage(width, height int) image.Image {
	imageValue := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			imageValue.SetRGBA(x, y, color.RGBA{R: 100, G: 120, B: 140, A: 255})
		}
	}
	return imageValue
}

func encodeBMP(width, height, bitsPerPixel int, topDown bool) []byte {
	bytesPerPixel := bitsPerPixel / 8
	rowStride := (width*bytesPerPixel + 3) / 4 * 4
	dataSize := rowStride * height
	output := make([]byte, 54+dataSize)
	copy(output[:2], []byte("BM"))
	binary.LittleEndian.PutUint32(output[2:6], uint32(len(output)))
	binary.LittleEndian.PutUint32(output[10:14], 54)
	binary.LittleEndian.PutUint32(output[14:18], 40)
	binary.LittleEndian.PutUint32(output[18:22], uint32(width))
	signedHeight := height
	if topDown {
		signedHeight = -height
	}
	binary.LittleEndian.PutUint32(output[22:26], uint32(int32(signedHeight)))
	binary.LittleEndian.PutUint16(output[26:28], 1)
	binary.LittleEndian.PutUint16(output[28:30], uint16(bitsPerPixel))
	binary.LittleEndian.PutUint32(output[34:38], uint32(dataSize))
	for sourceY := 0; sourceY < height; sourceY++ {
		row := 54 + sourceY*rowStride
		for x := 0; x < width; x++ {
			pixel := row + x*bytesPerPixel
			if bytesPerPixel >= 1 {
				output[pixel] = 10
			}
			if bytesPerPixel >= 2 {
				output[pixel+1] = 20
			}
			if bytesPerPixel >= 3 {
				output[pixel+2] = 30
			}
			if bytesPerPixel >= 4 {
				output[pixel+3] = 0
			}
		}
	}
	return output
}

type webPChunk struct {
	kind    string
	payload []byte
}

func syntheticWebP(chunks ...webPChunk) []byte {
	riffSize := uint64(4)
	for _, chunk := range chunks {
		riffSize += uint64(8 + len(chunk.payload))
		if len(chunk.payload)%2 != 0 {
			riffSize++
		}
	}
	output := make([]byte, 8+int(riffSize))
	copy(output[:4], []byte("RIFF"))
	binary.LittleEndian.PutUint32(output[4:8], uint32(riffSize))
	copy(output[8:12], []byte("WEBP"))
	offset := 12
	for _, chunk := range chunks {
		copy(output[offset:offset+4], []byte(chunk.kind))
		binary.LittleEndian.PutUint32(output[offset+4:offset+8], uint32(len(chunk.payload)))
		offset += 8
		copy(output[offset:offset+len(chunk.payload)], chunk.payload)
		offset += len(chunk.payload)
		if len(chunk.payload)%2 != 0 {
			offset++
		}
	}
	return output
}

func vp8Payload(width, height uint16) []byte {
	payload := make([]byte, 10)
	payload[3], payload[4], payload[5] = 0x9d, 0x01, 0x2a
	binary.LittleEndian.PutUint16(payload[6:8], width)
	binary.LittleEndian.PutUint16(payload[8:10], height)
	return payload
}

func vp8xPayload(width, height uint32, animated bool) []byte {
	payload := make([]byte, 10)
	if animated {
		payload[0] = 0x02
	}
	width--
	height--
	payload[4] = byte(width)
	payload[5] = byte(width >> 8)
	payload[6] = byte(width >> 16)
	payload[7] = byte(height)
	payload[8] = byte(height >> 8)
	payload[9] = byte(height >> 16)
	return payload
}

func anmfPayload(width, height uint32, duration uint32) []byte {
	payload := make([]byte, 16)
	width--
	height--
	payload[6] = byte(width)
	payload[7] = byte(width >> 8)
	payload[8] = byte(width >> 16)
	payload[9] = byte(height)
	payload[10] = byte(height >> 8)
	payload[11] = byte(height >> 16)
	payload[12] = byte(duration)
	payload[13] = byte(duration >> 8)
	payload[14] = byte(duration >> 16)
	return payload
}
