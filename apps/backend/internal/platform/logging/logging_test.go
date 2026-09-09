package logging

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestNewFiltersPrivateAttributes(t *testing.T) {
	var output bytes.Buffer
	logger := New(Options{Service: "p2p", Version: "v1", Writer: &output})
	logger.Info("frame rejected",
		slog.String("error_code", "invalid_envelope"),
		slog.String("request_id", "req-123"),
		slog.String("ciphertext", "private-ciphertext"),
		slog.String("room_id", "private-room"),
	)
	value := output.String()
	if !strings.Contains(value, `"error_code":"invalid_envelope"`) || !strings.Contains(value, `"request_id":"req-123"`) {
		t.Fatalf("safe fields missing from log = %s", value)
	}
	if strings.Contains(value, "private-ciphertext") || strings.Contains(value, "private-room") {
		t.Fatalf("private fields leaked into log = %s", value)
	}
}
