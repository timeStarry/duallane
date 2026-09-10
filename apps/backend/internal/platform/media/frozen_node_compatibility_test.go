package media

// The corpus is captured from the historical Node owner. Compressed payloads
// are exact bytes, not regenerated fixtures; the Go test only uses govips and
// bounds every decompression before handing bytes to the production processor.

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"io"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"
)

const (
	frozenNodeCorpusVersion  = 1
	frozenNodeCorpusSHA256   = "0795d77a0f0cd82fafbc87fe83125242f22da2f2fe7a838dc4d4a8bb7b918ef6"
	frozenPixelGrid          = 7
	frozenMaxColorMeanAbs    = 32.0
	frozenMaxAlphaMeanAbs    = 16.0
	frozenMaxAlphaAbs        = 16
	frozenMaxExpandedBytes   = 16 * 1024 * 1024
	frozenMaxCompressedBytes = 16 * 1024 * 1024
)

type frozenNodeCorpus struct {
	Version    int                  `json:"version"`
	Provenance frozenNodeProvenance `json:"provenance"`
	Results    []frozenNodeCase     `json:"results"`
}

type frozenNodeProvenance struct {
	HistoricalCommit        string `json:"historicalCommit"`
	CompatibilityScriptBlob string `json:"compatibilityScriptBlob"`
	CompatibilityTestBlob   string `json:"compatibilityTestBlob"`
	CaseSpecBlob            string `json:"caseSpecBlob"`
	SourceTree              string `json:"sourceTree"`
	Node                    string `json:"node"`
	Sharp                   string `json:"sharp"`
}

type frozenNodeCase struct {
	Spec         frozenNodeSpec        `json:"spec"`
	ID           string                `json:"id"`
	Kind         string                `json:"kind"`
	Fixture      string                `json:"fixture"`
	InputBytes   int                   `json:"inputBytes"`
	InputSHA256  string                `json:"inputSHA256"`
	Input        frozenNodeBytes       `json:"input"`
	Accepted     bool                  `json:"accepted"`
	OutputBytes  int                   `json:"outputBytes"`
	OutputSHA256 string                `json:"outputSHA256"`
	Output       *frozenNodeBytes      `json:"output"`
	NodeInput    *frozenNodeInput      `json:"nodeInput"`
	OutputInfo   *frozenNodeOutputInfo `json:"outputInfo"`
	Error        *frozenNodeError      `json:"error"`
}

type frozenNodeSpec struct {
	Kind string `json:"kind"`
	MIME string `json:"mime"`
}

type frozenNodeBytes struct {
	Encoding string `json:"encoding"`
	Data     string `json:"data"`
	Length   int    `json:"length"`
	Byte     uint8  `json:"byte"`
	SHA256   string `json:"sha256"`
}

type frozenNodeInput struct {
	DetectedMIMEType string `json:"detectedMimeType"`
	FrameCount       int    `json:"frameCount"`
	DurationMS       int64  `json:"durationMs"`
}

type frozenNodeOutputInfo struct {
	Width      int   `json:"width"`
	Height     int   `json:"height"`
	Pages      int   `json:"pages"`
	PageHeight int   `json:"pageHeight"`
	Delay      []int `json:"delay"`
}

type frozenNodeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Status  int    `json:"status"`
}

type frozenExpectedCase struct {
	ID       string
	Kind     Kind
	MIME     string
	Accepted bool
	Code     string
	Message  string
	Status   int
}

func TestFrozenHistoricalNodeMediaCompatibility(t *testing.T) {
	corpus := loadFrozenNodeCorpus(t)
	expected := frozenExpectedCases()
	if len(corpus.Results) != len(expected) {
		t.Fatalf("frozen media case count = %d, want %d", len(corpus.Results), len(expected))
	}

	processor, err := NewProcessor(DefaultOptions())
	if err != nil {
		t.Fatalf("start native media processor for frozen compatibility gate: %v", err)
	}
	byID := make(map[string]frozenNodeCase, len(corpus.Results))
	for _, testCase := range corpus.Results {
		if _, exists := byID[testCase.ID]; exists {
			t.Fatalf("duplicate frozen media case %q", testCase.ID)
		}
		byID[testCase.ID] = testCase
	}

	accepted, rejected, pixelChecks := 0, 0, 0
	for _, want := range expected {
		want := want
		t.Run(want.ID, func(t *testing.T) {
			frozen, ok := byID[want.ID]
			if !ok {
				t.Fatalf("frozen media case %q is missing", want.ID)
			}
			if frozen.Kind != string(want.Kind) || frozen.Spec.Kind != string(want.Kind) || frozen.Spec.MIME != want.MIME {
				t.Fatalf("frozen source = kind=%q spec.kind=%q mime=%q, want kind=%q mime=%q", frozen.Kind, frozen.Spec.Kind, frozen.Spec.MIME, want.Kind, want.MIME)
			}
			if frozen.Accepted != want.Accepted {
				t.Fatalf("frozen Node accepted = %t, want %t", frozen.Accepted, want.Accepted)
			}
			input := decodeFrozenNodeBytes(t, frozen.Input, frozen.InputBytes)
			if got := hashBytes(input); got != frozen.InputSHA256 {
				t.Fatalf("frozen input SHA-256 = %s, want %s", got, frozen.InputSHA256)
			}

			result, err := processor.Process(context.Background(), input, Source{Kind: want.Kind, MIMEType: want.MIME})
			if want.Accepted {
				accepted++
				if err != nil {
					t.Fatalf("Process() rejected historical accepted input: %v", err)
				}
				checkFrozenAcceptedResult(t, frozen, result)
				pixelChecks++
				checkFrozenPixels(t, frozen, result.Content)
				return
			}

			rejected++
			if err == nil {
				t.Fatalf("Process() accepted historical rejected input")
			}
			var mediaErr *Error
			if !errors.As(err, &mediaErr) {
				t.Fatalf("Process() error type = %T, want *Error", err)
			}
			if mediaErr.Code != want.Code || mediaErr.Message != want.Message || mediaErr.StatusCode != want.Status {
				t.Fatalf("Process() error = %s/%q/%d, want %s/%q/%d", mediaErr.Code, mediaErr.Message, mediaErr.StatusCode, want.Code, want.Message, want.Status)
			}
			if frozen.Error == nil || frozen.Error.Code != mediaErr.Code || frozen.Error.Message != mediaErr.Message || frozen.Error.Status != mediaErr.StatusCode {
				t.Fatalf("frozen Node error = %#v, Go error = %s/%q/%d", frozen.Error, mediaErr.Code, mediaErr.Message, mediaErr.StatusCode)
			}
		})
	}

	if accepted != 16 || rejected != 12 || pixelChecks != 16 {
		t.Fatalf("frozen media summary = accepted %d rejected %d pixelChecks %d, want 16/12/16", accepted, rejected, pixelChecks)
	}
	for _, want := range expected {
		if _, ok := byID[want.ID]; !ok {
			t.Errorf("unexpected frozen media corpus omission: %s", want.ID)
		}
	}
}

func loadFrozenNodeCorpus(t *testing.T) frozenNodeCorpus {
	t.Helper()
	path := filepath.Join("testdata", "frozen-node-media.json")
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read frozen Node media corpus: %v", err)
	}
	if got := hashBytes(encoded); got != frozenNodeCorpusSHA256 {
		t.Fatalf("frozen Node media corpus SHA-256 = %s, want %s", got, frozenNodeCorpusSHA256)
	}
	var corpus frozenNodeCorpus
	if err := json.Unmarshal(encoded, &corpus); err != nil {
		t.Fatalf("decode frozen Node media corpus: %v", err)
	}
	if corpus.Version != frozenNodeCorpusVersion {
		t.Fatalf("frozen Node media corpus version = %d, want %d", corpus.Version, frozenNodeCorpusVersion)
	}
	wantProvenance := frozenNodeProvenance{
		HistoricalCommit:        "6ebc0f6858d67cf2be516d19ecf062c3ae75b505",
		CompatibilityScriptBlob: "d2d11da7ad3f744d8f05ab569a4b711ae738aa39",
		CompatibilityTestBlob:   "ce294c050691e223af7809837075467d2e7a06ff",
		CaseSpecBlob:            "b03321b971ab70398c35849bc87d56066bfb73b2",
		SourceTree:              "e0320b01229400c2c4b9fbf80d8fca1c883f29dd",
		Node:                    "22.23.2",
		Sharp:                   "0.35.3",
	}
	if corpus.Provenance != wantProvenance {
		t.Fatalf("frozen Node media provenance = %#v, want %#v", corpus.Provenance, wantProvenance)
	}
	return corpus
}

func decodeFrozenNodeBytes(t *testing.T, frozen frozenNodeBytes, expectedLength int) []byte {
	t.Helper()
	if frozen.SHA256 == "" {
		t.Fatal("frozen byte entry has no SHA-256")
	}
	if expectedLength < 0 || expectedLength > frozenMaxExpandedBytes {
		t.Fatalf("frozen bytes length %d is outside bounded expansion", expectedLength)
	}
	if frozen.Length > 0 && frozen.Length != expectedLength {
		t.Fatalf("frozen byte length metadata = %d, want %d", frozen.Length, expectedLength)
	}
	var decoded []byte
	switch frozen.Encoding {
	case "base64":
		if len(frozen.Data) > ((frozenMaxCompressedBytes+2)/3)*4 {
			t.Fatalf("frozen base64 payload is outside bounded input: %d characters", len(frozen.Data))
		}
		var err error
		decoded, err = base64.StdEncoding.DecodeString(frozen.Data)
		if err != nil {
			t.Fatalf("decode frozen base64: %v", err)
		}
	case "gzip+base64":
		if len(frozen.Data) > ((frozenMaxCompressedBytes+2)/3)*4 {
			t.Fatalf("frozen gzip base64 payload is outside bounded input: %d characters", len(frozen.Data))
		}
		compressed, err := base64.StdEncoding.DecodeString(frozen.Data)
		if err != nil {
			t.Fatalf("decode frozen gzip base64: %v", err)
		}
		if len(compressed) > frozenMaxCompressedBytes {
			t.Fatalf("frozen compressed bytes length %d is outside bounded input", len(compressed))
		}
		reader, err := gzip.NewReader(bytes.NewReader(compressed))
		if err != nil {
			t.Fatalf("open frozen gzip: %v", err)
		}
		decoded, err = io.ReadAll(io.LimitReader(reader, frozenMaxExpandedBytes+1))
		closeErr := reader.Close()
		if err != nil {
			t.Fatalf("expand frozen gzip: %v", err)
		}
		if closeErr != nil {
			t.Fatalf("close frozen gzip: %v", closeErr)
		}
		if len(decoded) > frozenMaxExpandedBytes {
			t.Fatalf("frozen gzip expanded beyond bounded input: %d", len(decoded))
		}
	case "repeat":
		if frozen.Length < 0 || frozen.Length > frozenMaxExpandedBytes {
			t.Fatalf("frozen repeated input length %d is outside bounded expansion", frozen.Length)
		}
		decoded = make([]byte, frozen.Length)
		for index := range decoded {
			decoded[index] = frozen.Byte
		}
	default:
		t.Fatalf("unknown frozen byte encoding %q", frozen.Encoding)
	}
	if len(decoded) != expectedLength {
		t.Fatalf("frozen bytes length = %d, want %d", len(decoded), expectedLength)
	}
	if got := hashBytes(decoded); got != frozen.SHA256 {
		t.Fatalf("frozen bytes SHA-256 = %s, want %s", got, frozen.SHA256)
	}
	return decoded
}

func checkFrozenAcceptedResult(t *testing.T, frozen frozenNodeCase, result ProcessedUpload) {
	t.Helper()
	if frozen.Output == nil || frozen.OutputInfo == nil || frozen.NodeInput == nil {
		t.Fatal("accepted frozen Node case has incomplete output metadata")
	}
	if result.DetectedMIMEType != frozen.NodeInput.DetectedMIMEType {
		t.Fatalf("detected MIME = %q, want historical Node %q", result.DetectedMIMEType, frozen.NodeInput.DetectedMIMEType)
	}
	if result.NormalizedMIMEType != "image/webp" {
		t.Fatalf("normalized MIME = %q, want image/webp", result.NormalizedMIMEType)
	}
	if result.FrameCount != frozen.NodeInput.FrameCount || result.DurationMS != frozen.NodeInput.DurationMS {
		t.Fatalf("animation metadata = frames=%d duration=%d, want frames=%d duration=%d", result.FrameCount, result.DurationMS, frozen.NodeInput.FrameCount, frozen.NodeInput.DurationMS)
	}
	if result.ByteSize != int64(len(result.Content)) || len(result.Content) == 0 {
		t.Fatalf("Go output byte metadata = %d/%d, want non-empty consistent output", result.ByteSize, len(result.Content))
	}
	if result.SHA256 != hashBytes(result.Content) {
		t.Fatalf("Go output SHA-256 metadata = %s, want %s", result.SHA256, hashBytes(result.Content))
	}
	if result.ByteSize > 0 && frozen.Spec.Kind == string(KindCustomEmote) && result.ByteSize > MaxOutputBytes {
		t.Fatalf("Go output exceeds custom-emote limit: %d > %d", result.ByteSize, MaxOutputBytes)
	}

	nodeOutput := decodeFrozenNodeBytes(t, *frozen.Output, frozen.OutputBytes)
	if got := hashBytes(nodeOutput); got != frozen.OutputSHA256 {
		t.Fatalf("historical Node output SHA-256 = %s, want %s", got, frozen.OutputSHA256)
	}
	if frozen.OutputBytes != len(nodeOutput) {
		t.Fatalf("historical Node output bytes = %d, want %d", len(nodeOutput), frozen.OutputBytes)
	}
	if header, err := inspectImage(result.Content); err != nil || header.format != "webp" {
		t.Fatalf("Go normalized output header = %#v, error=%v", header, err)
	}
}

type frozenDecodedImage struct {
	image      image.Image
	width      int
	height     int
	pages      int
	pageHeight int
	delay      []int
	metadata   frozenMetadataFlags
}

type frozenMetadataFlags struct {
	Exif       bool
	ICC        bool
	IPTC       bool
	XMP        bool
	TIFFTag    bool
	HasProfile bool
}

func decodeFrozenImage(t *testing.T, encoded []byte, pages int) frozenDecodedImage {
	t.Helper()
	params := vips.NewImportParams()
	params.FailOnError.Set(true)
	if pages > 0 {
		params.NumPages.Set(pages)
	}
	ref, err := vips.LoadImageFromBuffer(encoded, params)
	if err != nil {
		t.Fatalf("decode normalized WebP pixels with govips: %v", err)
	}
	defer ref.Close()
	decoded, err := ref.ToGoImage()
	if err != nil {
		t.Fatalf("convert normalized WebP pixels with govips: %v", err)
	}
	pageCount := ref.Pages()
	if pageCount < 1 {
		pageCount = 1
	}
	pageHeight := ref.PageHeight()
	if pageHeight <= 0 || pageHeight > ref.Height() {
		pageHeight = ref.Height() / pageCount
	}
	delays, delayErr := ref.PageDelay()
	if delayErr != nil || pageCount == 1 {
		delays = nil
	}
	return frozenDecodedImage{
		image:      decoded,
		width:      ref.Width(),
		height:     ref.Height(),
		pages:      pageCount,
		pageHeight: pageHeight,
		delay:      delays,
		metadata: frozenMetadataFlags{
			Exif:       ref.HasExif(),
			ICC:        ref.HasICCProfile(),
			IPTC:       ref.HasIPTC(),
			XMP:        len(ref.GetBlob("xmp-data")) > 0,
			TIFFTag:    ref.GetString("tifftag") != "",
			HasProfile: ref.HasProfile(),
		},
	}
}

func checkFrozenPixels(t *testing.T, frozen frozenNodeCase, goOutput []byte) {
	t.Helper()
	nodeOutput := decodeFrozenNodeBytes(t, *frozen.Output, frozen.OutputBytes)
	node := decodeFrozenImage(t, nodeOutput, frozen.OutputInfo.Pages)
	goHeader, err := inspectImage(goOutput)
	if err != nil {
		t.Fatalf("inspect Go normalized output for pixel comparison: %v", err)
	}
	goImage := decodeFrozenImage(t, goOutput, goHeader.frameCount)

	nodePageHeight := frozen.OutputInfo.PageHeight
	if nodePageHeight <= 0 {
		nodePageHeight = frozen.OutputInfo.Height / maxPositive(frozen.OutputInfo.Pages)
	}
	if node.width != frozen.OutputInfo.Width || node.height != frozen.OutputInfo.Height || node.pages != frozen.OutputInfo.Pages || node.pageHeight != nodePageHeight {
		t.Fatalf("decoded historical Node output = %dx%d pages=%d pageHeight=%d, want %dx%d pages=%d pageHeight=%d", node.width, node.height, node.pages, node.pageHeight, frozen.OutputInfo.Width, frozen.OutputInfo.Height, frozen.OutputInfo.Pages, nodePageHeight)
	}
	if goImage.width != node.width || goImage.pages != node.pages || goImage.pageHeight != node.pageHeight {
		t.Fatalf("decoded Go output = %dx%d pages=%d pageHeight=%d, want width=%d pages=%d pageHeight=%d", goImage.width, goImage.height, goImage.pages, goImage.pageHeight, node.width, node.pages, node.pageHeight)
	}
	if !equalFrozenInts(node.delay, frozen.OutputInfo.Delay) {
		t.Fatalf("frozen Node frame delays = %v, decoded Node delays = %v", frozen.OutputInfo.Delay, node.delay)
	}
	if !equalFrozenInts(node.delay, goImage.delay) {
		t.Fatalf("normalized frame delays differ: Node=%v Go=%v", node.delay, goImage.delay)
	}
	if node.metadata != (frozenMetadataFlags{}) || goImage.metadata != (frozenMetadataFlags{}) {
		t.Fatalf("normalized output retains metadata: Node=%+v Go=%+v", node.metadata, goImage.metadata)
	}

	var colorAbs, alphaAbs int
	maxColorAbs, maxAlphaAbs := 0, 0
	sampleCount := 0
	for page := 0; page < node.pages; page++ {
		for gy := 0; gy < frozenPixelGrid; gy++ {
			for gx := 0; gx < frozenPixelGrid; gx++ {
				x := roundedSampleCoordinate(gx, node.width)
				y := roundedSampleCoordinate(gy, node.pageHeight)
				nodePixel := frozenPixelAt(node, x, page*node.pageHeight+y)
				goPixel := frozenPixelAt(goImage, x, page*goImage.pageHeight+y)
				for channel := 0; channel < 3; channel++ {
					difference := absInt(int(nodePixel[channel]) - int(goPixel[channel]))
					colorAbs += difference
					if difference > maxColorAbs {
						maxColorAbs = difference
					}
				}
				alphaDifference := absInt(int(nodePixel[3]) - int(goPixel[3]))
				alphaAbs += alphaDifference
				if alphaDifference > maxAlphaAbs {
					maxAlphaAbs = alphaDifference
				}
				sampleCount++
			}
		}
	}
	colorMeanAbs := float64(colorAbs) / float64(sampleCount*3)
	alphaMeanAbs := float64(alphaAbs) / float64(sampleCount)
	if colorMeanAbs > frozenMaxColorMeanAbs || alphaMeanAbs > frozenMaxAlphaMeanAbs || maxAlphaAbs > frozenMaxAlphaAbs {
		t.Fatalf("7x7-per-frame pixel difference: samples=%d colorMeanAbs=%.3f alphaMeanAbs=%.3f maxColorAbs=%d maxAlphaAbs=%d; thresholds color<=%.1f alphaMean<=%.1f alphaMax<=%d", sampleCount, colorMeanAbs, alphaMeanAbs, maxColorAbs, maxAlphaAbs, frozenMaxColorMeanAbs, frozenMaxAlphaMeanAbs, frozenMaxAlphaAbs)
	}
}

func frozenPixelAt(decoded frozenDecodedImage, x, y int) [4]uint8 {
	converted := color.NRGBAModel.Convert(decoded.image.At(x, y)).(color.NRGBA)
	return [4]uint8{converted.R, converted.G, converted.B, converted.A}
}

func roundedSampleCoordinate(index, size int) int {
	if size <= 1 {
		return 0
	}
	return int(math.Round(float64(index*(size-1)) / float64(frozenPixelGrid-1)))
}

func maxPositive(value int) int {
	if value < 1 {
		return 1
	}
	return value
}

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func equalFrozenInts(left, right []int) bool {
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

func frozenExpectedCases() []frozenExpectedCase {
	return []frozenExpectedCase{
		{ID: "avatar-jpeg-orientation", Kind: KindAvatar, MIME: "image/jpeg", Accepted: true},
		{ID: "avatar-png-transparency", Kind: KindAvatar, MIME: "image/png", Accepted: true},
		{ID: "avatar-webp-centre", Kind: KindAvatar, MIME: "image/webp", Accepted: true},
		{ID: "emote-jpeg-static", Kind: KindCustomEmote, MIME: "image/jpeg", Accepted: true},
		{ID: "emote-png-transparency", Kind: KindCustomEmote, MIME: "image/png", Accepted: true},
		{ID: "emote-webp-static", Kind: KindCustomEmote, MIME: "image/webp", Accepted: true},
		{ID: "emote-gif-static", Kind: KindCustomEmote, MIME: "image/gif", Accepted: true},
		{ID: "emote-gif-animated", Kind: KindCustomEmote, MIME: "image/gif", Accepted: true},
		{ID: "emote-webp-animated", Kind: KindCustomEmote, MIME: "image/webp", Accepted: true},
		{ID: "emote-bmp-24-bottom-up", Kind: KindCustomEmote, MIME: "image/bmp", Accepted: true},
		{ID: "emote-bmp-32-top-down-alpha", Kind: KindCustomEmote, MIME: "image/bmp", Accepted: true},
		{ID: "emote-png-declared-jpeg", Kind: KindCustomEmote, MIME: "image/jpeg", Accepted: true},
		{ID: "emote-bmp-declared-png", Kind: KindCustomEmote, MIME: "image/png", Accepted: true},
		{ID: "avatar-gif-declared-png", Kind: KindAvatar, MIME: "image/png", Code: "avatar.invalid_image", Message: "头像图片尺寸或格式无效", Status: 400},
		{ID: "avatar-truncated-png", Kind: KindAvatar, MIME: "image/png", Code: "avatar.invalid_image", Message: "头像图片无法解析", Status: 400},
		{ID: "emote-truncated-gif", Kind: KindCustomEmote, MIME: "image/gif", Code: "emote.decode_failed", Message: "图片无法解析", Status: 400},
		{ID: "emote-truncated-webp", Kind: KindCustomEmote, MIME: "image/webp", Code: "emote.decode_failed", Message: "图片无法解析", Status: 400},
		{ID: "emote-unsupported-mime", Kind: KindCustomEmote, MIME: "image/svg+xml", Code: "emote.invalid_format", Message: "仅支持 JPEG、PNG、WebP、GIF 或 BMP 图片", Status: 400},
		{ID: "avatar-input-over-limit", Kind: KindAvatar, MIME: "image/png", Code: "avatar.invalid_size", Message: "头像文件大小应在 5 MiB 以内", Status: 400},
		{ID: "emote-input-over-limit", Kind: KindCustomEmote, MIME: "image/png", Code: "emote.input_too_large", Message: "表情原图不能超过 10 MiB", Status: 413},
		{ID: "emote-edge-over-limit", Kind: KindCustomEmote, MIME: "image/png", Code: "emote.dimensions_exceeded", Message: "图片尺寸过大", Status: 400},
		{ID: "avatar-pixels-over-limit", Kind: KindAvatar, MIME: "image/png", Code: "avatar.invalid_image", Message: "头像图片无法解析", Status: 400},
		{ID: "emote-frames-over-limit", Kind: KindCustomEmote, MIME: "image/gif", Code: "emote.animation_too_complex", Message: "动图帧数或时长超出限制", Status: 400},
		{ID: "emote-duration-over-limit", Kind: KindCustomEmote, MIME: "image/gif", Code: "emote.animation_too_complex", Message: "动图帧数或时长超出限制", Status: 400},
		{ID: "emote-output-over-owner-limit", Kind: KindCustomEmote, MIME: "image/gif", Code: "emote.output_too_large", Message: "压缩后的表情仍然过大", Status: 400},
		{ID: "emote-output-within-owner-limit", Kind: KindCustomEmote, MIME: "image/png", Accepted: true},
		{ID: "emote-frames-at-limit", Kind: KindCustomEmote, MIME: "image/gif", Accepted: true},
		{ID: "emote-duration-at-limit", Kind: KindCustomEmote, MIME: "image/gif", Accepted: true},
	}
}
