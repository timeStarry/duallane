package media

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// TestMediaCompatibilityProbe is activated by scripts/backend/media-compatibility.mjs.
// Keeping the probe in this package lets the script exercise the concrete
// Processor without adding a production command or a second media adapter.
// The normal Go package suite leaves it inactive when no manifest is supplied.
func TestMediaCompatibilityProbe(t *testing.T) {
	manifestPath := os.Getenv("DUALLANE_MEDIA_COMPATIBILITY_MANIFEST")
	outputPath := os.Getenv("DUALLANE_MEDIA_COMPATIBILITY_OUTPUT")
	if manifestPath == "" || outputPath == "" {
		return
	}

	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("read compatibility manifest: %v", err)
	}
	var manifest compatibilityManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("decode compatibility manifest: %v", err)
	}
	processor, err := NewProcessor(DefaultOptions())
	if err != nil {
		t.Fatalf("start media processor: %v", err)
	}
	processors := map[int64]*Processor{0: processor}

	report := compatibilityReport{Version: manifest.Version, Cases: make([]compatibilityCaseResult, 0, len(manifest.Cases))}
	for _, fixture := range manifest.Cases {
		result := compatibilityCaseResult{ID: fixture.ID}
		input, readErr := os.ReadFile(fixture.InputPath)
		if readErr != nil {
			t.Fatalf("read compatibility fixture %q: %v", fixture.ID, readErr)
		}
		caseProcessor := processor
		if fixture.OutputMaxBytes > 0 {
			caseProcessor = processors[fixture.OutputMaxBytes]
			if caseProcessor == nil {
				options := DefaultOptions()
				if fixture.Kind == string(KindCustomEmote) {
					options.CustomEmote.MaxOutputBytes = fixture.OutputMaxBytes
				}
				caseProcessor, err = NewProcessor(options)
				if err != nil {
					t.Fatalf("start bounded media processor for %q: %v", fixture.ID, err)
				}
				processors[fixture.OutputMaxBytes] = caseProcessor
			}
		}
		processed, processErr := caseProcessor.Process(context.Background(), input, Source{
			Kind:     Kind(fixture.Kind),
			MIMEType: fixture.MIME,
		})
		if processErr != nil {
			result.Accepted = false
			result.Error = safeCompatibilityError(processErr)
			report.Cases = append(report.Cases, result)
			continue
		}

		if fixture.OutputPath == "" {
			t.Fatalf("accepted compatibility fixture %q has no output path", fixture.ID)
		}
		if err := os.WriteFile(fixture.OutputPath, processed.Content, 0o600); err != nil {
			t.Fatalf("write compatibility output %q: %v", fixture.ID, err)
		}
		outputHeader, inspectErr := inspectImage(processed.Content)
		if inspectErr != nil {
			t.Fatalf("inspect normalized output %q: %v", fixture.ID, inspectErr)
		}
		result.Accepted = true
		result.Output = &compatibilityOutput{
			DetectedMIMEType:   processed.DetectedMIMEType,
			NormalizedMIMEType: processed.NormalizedMIMEType,
			ByteSize:           processed.ByteSize,
			Width:              processed.Width,
			Height:             processed.Height,
			FrameCount:         processed.FrameCount,
			DurationMS:         processed.DurationMS,
			SHA256:             processed.SHA256,
			Format:             outputHeader.format,
			HeaderWidth:        outputHeader.width,
			HeaderHeight:       outputHeader.height,
			FrameWidth:         outputHeader.frameWidth,
			FrameHeight:        outputHeader.frameHeight,
			HeaderFrameCount:   outputHeader.frameCount,
			HeaderDurationMS:   outputHeader.durationMS,
		}
		report.Cases = append(report.Cases, result)
	}

	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("encode compatibility report: %v", err)
	}
	if err := os.WriteFile(outputPath, encoded, 0o600); err != nil {
		t.Fatalf("write compatibility report: %v", err)
	}
}

type compatibilityManifest struct {
	Version int                      `json:"version"`
	Cases   []compatibilityCaseInput `json:"cases"`
}

type compatibilityCaseInput struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	MIME           string `json:"mime"`
	OutputMaxBytes int64  `json:"outputMaxBytes"`
	InputPath      string `json:"inputPath"`
	OutputPath     string `json:"outputPath"`
}

type compatibilityReport struct {
	Version int                       `json:"version"`
	Cases   []compatibilityCaseResult `json:"cases"`
}

type compatibilityCaseResult struct {
	ID       string               `json:"id"`
	Accepted bool                 `json:"accepted"`
	Error    *compatibilityError  `json:"error,omitempty"`
	Output   *compatibilityOutput `json:"output,omitempty"`
}

type compatibilityError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Status  int    `json:"status"`
}

type compatibilityOutput struct {
	DetectedMIMEType   string `json:"detectedMimeType"`
	NormalizedMIMEType string `json:"normalizedMimeType"`
	ByteSize           int64  `json:"byteSize"`
	Width              int    `json:"width"`
	Height             int    `json:"height"`
	FrameCount         int    `json:"frameCount"`
	DurationMS         int64  `json:"durationMS"`
	SHA256             string `json:"sha256"`
	Format             string `json:"format"`
	HeaderWidth        uint64 `json:"headerWidth"`
	HeaderHeight       uint64 `json:"headerHeight"`
	FrameWidth         uint64 `json:"frameWidth"`
	FrameHeight        uint64 `json:"frameHeight"`
	HeaderFrameCount   int    `json:"headerFrameCount"`
	HeaderDurationMS   int64  `json:"headerDurationMS"`
}

func safeCompatibilityError(err error) *compatibilityError {
	var mediaErr *Error
	if errors.As(err, &mediaErr) {
		return &compatibilityError{Code: mediaErr.Code, Message: mediaErr.Message, Status: mediaErr.StatusCode}
	}
	return &compatibilityError{Code: "internal.error", Message: "媒体处理失败", Status: 500}
}
