package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"testing"
)

func TestStripWebPMetadataRemovesAncillaryChunksAndFeatureBits(t *testing.T) {
	vp8x := vp8xPayload(8, 8, true)
	vp8x[0] = 0x3e // ICC, alpha, EXIF, XMP and animation flags.
	input := syntheticWebP(
		webPChunk{kind: "VP8X", payload: vp8x},
		webPChunk{kind: "ICCP", payload: []byte("synthetic profile")},
		webPChunk{kind: "EXIF", payload: []byte("synthetic exif")},
		webPChunk{kind: "XMP ", payload: []byte("synthetic xmp")},
		webPChunk{kind: "JUNK", payload: []byte("synthetic unknown")},
		webPChunk{kind: "ANIM", payload: make([]byte, 6)},
		webPChunk{kind: "ANMF", payload: anmfPayload(8, 8, 125)},
	)

	output, err := stripWebPMetadata(input)
	if err != nil {
		t.Fatalf("stripWebPMetadata() error = %v", err)
	}
	chunks, err := parseWebPContainer(output)
	if err != nil {
		t.Fatalf("parse sanitized WebP: %v", err)
	}
	var gotKinds []string
	for _, chunk := range chunks {
		gotKinds = append(gotKinds, chunk.kind)
		if chunk.kind == "VP8X" {
			if got := chunk.payload[0]; got != (webpVP8XAlphaFlag | webpVP8XAnimationFlag) {
				t.Fatalf("VP8X feature flags = %#x, want alpha+animation only", got)
			}
		}
		if chunk.kind == "ICCP" || chunk.kind == "EXIF" || chunk.kind == "XMP " || chunk.kind == "JUNK" {
			t.Fatalf("privacy chunk %q survived sanitization", chunk.kind)
		}
	}
	wantKinds := []string{"VP8X", "ANIM", "ANMF"}
	if !equalStrings(gotKinds, wantKinds) {
		t.Fatalf("sanitized chunks = %#v, want %#v", gotKinds, wantKinds)
	}
}

func TestStripWebPMetadataPreservesStaticImagePayload(t *testing.T) {
	imagePayload := vp8Payload(6, 5)
	input := syntheticWebP(
		webPChunk{kind: "VP8 ", payload: imagePayload},
		webPChunk{kind: "EXIF", payload: []byte("private metadata")},
	)
	original := append([]byte(nil), input...)

	output, err := stripWebPMetadata(input)
	if err != nil {
		t.Fatalf("stripWebPMetadata() error = %v", err)
	}
	chunks, err := parseWebPContainer(output)
	if err != nil {
		t.Fatalf("parse sanitized WebP: %v", err)
	}
	if len(chunks) != 1 || chunks[0].kind != "VP8 " || !bytes.Equal(chunks[0].payload, imagePayload) {
		t.Fatalf("sanitized static chunks = %#v, want unchanged VP8 payload only", chunks)
	}
	if !bytes.Equal(input, original) {
		t.Fatal("stripWebPMetadata mutated its input")
	}
}

func TestStripWebPMetadataRejectsMalformedOrTrailingContainer(t *testing.T) {
	valid := syntheticWebP(webPChunk{kind: "VP8 ", payload: vp8Payload(1, 1)})
	cases := []struct {
		name  string
		input []byte
	}{
		{name: "truncated chunk", input: valid[:len(valid)-1]},
		{name: "trailing bytes", input: append(append([]byte(nil), valid...), 0x01)},
		{name: "bad riff size", input: badRIFFSize(valid, uint32(len(valid)-8+1))},
		{name: "empty container", input: syntheticWebP()},
		{name: "short VP8X", input: syntheticWebP(webPChunk{kind: "VP8X", payload: make([]byte, 9)})},
		{name: "long VP8X", input: syntheticWebP(webPChunk{kind: "VP8X", payload: make([]byte, 11)})},
		{name: "nonzero VP8X reserved bytes", input: webpWithVP8XReservedByte()},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := stripWebPMetadata(test.input); !errors.Is(err, errWebPPrivacyContainer) {
				t.Fatalf("stripWebPMetadata() error = %v, want malformed container", err)
			}
		})
	}
}

func TestStripWebPMetadataRegeneratesOddRIFFPadding(t *testing.T) {
	input := syntheticWebP(
		webPChunk{kind: "VP8 ", payload: vp8Payload(6, 5)},
		webPChunk{kind: "EXIF", payload: []byte("odd")},
		webPChunk{kind: "ANIM", payload: []byte{1, 2, 3, 4, 5}},
	)
	output, err := stripWebPMetadata(input)
	if err != nil {
		t.Fatalf("stripWebPMetadata() error = %v", err)
	}
	chunks, err := parseWebPContainer(output)
	if err != nil {
		t.Fatalf("parse sanitized odd-padded WebP: %v", err)
	}
	if got := len(chunks); got != 2 || chunks[0].kind != "VP8 " || chunks[1].kind != "ANIM" || len(chunks[1].payload) != 5 {
		t.Fatalf("sanitized odd-padded chunks = %#v, want VP8 + five-byte ANIM", chunks)
	}
	if output[len(output)-1] != 0 {
		t.Fatalf("sanitized odd-padded output has nonzero regenerated pad byte %#x", output[len(output)-1])
	}
}

func TestProcessorOutputsMetadataFreeStaticAndAnimatedWebP(t *testing.T) {
	processor := newTestProcessor(t)
	cases := []struct {
		name   string
		input  []byte
		source Source
		pages  int
		delay  int64
	}{
		{
			name:   "static",
			input:  encodePNG(t, 16, 12),
			source: Source{Kind: KindCustomEmote, MIMEType: "image/png"},
			pages:  1,
		},
		{
			name:   "animated",
			input:  encodeGIF(t, 8, 4, []int{7, 13}),
			source: Source{Kind: KindCustomEmote, MIMEType: "image/gif"},
			pages:  2,
			delay:  200,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			result, err := processor.Process(context.Background(), test.input, test.source)
			if err != nil {
				t.Fatalf("Process() error = %v", err)
			}
			chunks, err := parseWebPContainer(result.Content)
			if err != nil {
				t.Fatalf("parse normalized WebP: %v", err)
			}
			for _, chunk := range chunks {
				if _, ok := webpStructuralChunks[chunk.kind]; !ok {
					t.Fatalf("normalized output contains non-structural chunk %q", chunk.kind)
				}
			}
			header, err := inspectImage(result.Content)
			if err != nil {
				t.Fatalf("inspect normalized WebP: %v", err)
			}
			if header.frameCount != test.pages || header.durationMS != test.delay {
				t.Fatalf("normalized animation = frames %d duration %d, want %d/%d", header.frameCount, header.durationMS, test.pages, test.delay)
			}
		})
	}
}

func badRIFFSize(input []byte, size uint32) []byte {
	output := append([]byte(nil), input...)
	binary.LittleEndian.PutUint32(output[4:8], size)
	return output
}

func webpWithVP8XReservedByte() []byte {
	payload := vp8xPayload(1, 1, false)
	payload[1] = 1
	return syntheticWebP(webPChunk{kind: "VP8X", payload: payload}, webPChunk{kind: "VP8 ", payload: vp8Payload(1, 1)})
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
