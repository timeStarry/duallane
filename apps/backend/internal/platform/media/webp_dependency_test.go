package media

import (
	"bytes"
	"encoding/binary"
	"image"
	"testing"

	_ "golang.org/x/image/webp"
)

func TestWebPDependencyRejectsVP8AlphaCanvasMismatchWithoutPanic(t *testing.T) {
	// The production WebP path uses govips/libvips, which does not invoke
	// golang.org/x/image/webp. Importing x/image/webp for registration and
	// calling image.Decode is therefore the narrowest direct exercise of the
	// affected dependency in this media package.
	input := malformedVP8AlphaCanvasMismatch()

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("WebP decoder panicked on a VP8/canvas mismatch: %v", recovered)
		}
	}()

	decoded, format, err := image.Decode(bytes.NewReader(input))
	if err == nil {
		// Before the upstream fix, decoding could return a 2x2 YCbCr image with
		// a 1x1 alpha plane. Touching the final pixel makes that old mismatch
		// observable as a panic instead of hiding it behind a nil error.
		bounds := decoded.Bounds()
		_ = decoded.At(bounds.Max.X-1, bounds.Max.Y-1)
		t.Fatalf("image.Decode accepted malformed WebP as format %q: bounds=%v", format, bounds)
	}
}

func malformedVP8AlphaCanvasMismatch() []byte {
	// Regression for GO-2026-5061 (https://pkg.go.dev/vuln/GO-2026-5061),
	// fixed by Go CL 787681 (https://go.dev/cl/787681).
	// This is a deterministic 2x2 VP8 keyframe payload. The surrounding
	// VP8X canvas is deliberately 1x1 and advertises alpha, while the ALPH
	// chunk carries exactly one canvas alpha sample.
	const vp8Payload = "" +
		"\xd0\x01\x00\x9d\x01\x2a\x02\x00\x02\x00\x02\x00" +
		"\x34\x25\xa0\x02\x74\xba\x01\xf8\x00\x03\xb0" +
		"\x00\xfe\xf0\xc4\x0b\xff\x20\xb9\x61\x75\xc8\xd7\xff" +
		"\x20\x3f\xe4\x07\xfc\x80\xff\xf8\xf2\x00\x00\x00"

	vp8x := webPDependencyChunk("VP8X", []byte{
		0x10, // Alpha flag; canvas remains authoritative for alpha dimensions.
		0, 0, 0,
		0, 0, 0, // Canvas width minus one: 0 (width = 1).
		0, 0, 0, // Canvas height minus one: 0 (height = 1).
	})
	alpha := webPDependencyChunk("ALPH", []byte{0, 0xff})
	vp8 := webPDependencyChunk("VP8 ", []byte(vp8Payload))

	riffSize := 4 + len(vp8x) + len(alpha) + len(vp8)
	output := make([]byte, 8+riffSize)
	copy(output[:4], "RIFF")
	binary.LittleEndian.PutUint32(output[4:8], uint32(riffSize))
	copy(output[8:12], "WEBP")
	offset := 12
	for _, chunk := range [][]byte{vp8x, alpha, vp8} {
		copy(output[offset:], chunk)
		offset += len(chunk)
	}
	return output
}

func webPDependencyChunk(kind string, payload []byte) []byte {
	padding := len(payload) & 1
	chunk := make([]byte, 8+len(payload)+padding)
	copy(chunk[:4], kind)
	binary.LittleEndian.PutUint32(chunk[4:8], uint32(len(payload)))
	copy(chunk[8:], payload)
	return chunk
}
