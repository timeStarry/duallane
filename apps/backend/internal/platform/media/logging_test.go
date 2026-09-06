package media

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"os"
	"os/exec"
	"testing"
	"time"
)

// A fresh process is required: startupOnce and the native logging handler are
// process-global, and a prior test must not hide default startup diagnostics.
func TestNativeMediaDoesNotWriteRawDiagnostics(t *testing.T) {
	const helper = "DUALLANE_TEST_NATIVE_LOG_CHILD"
	if os.Getenv(helper) == "true" {
		processor, err := NewProcessor(Options{})
		if err != nil {
			t.Fatal(err)
		}
		var input bytes.Buffer
		if err := png.Encode(&input, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
			t.Fatal(err)
		}
		if _, err := processor.ProcessCustomEmote(context.Background(), input.Bytes(), "image/png"); err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNativeMediaDoesNotWriteRawDiagnostics$")
	command.Env = append(os.Environ(), helper+"=true")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("native child failed: %v\n%s", err, output)
	}
	if len(output) != 0 {
		t.Fatalf("native processor emitted unfiltered diagnostics: %s", output)
	}
}
