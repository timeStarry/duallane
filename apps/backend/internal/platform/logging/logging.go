package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
)

// Options describes safe process metadata. Callers should use stable codes and
// identifiers only; request bodies, room IDs, ciphertext, and user content are
// intentionally not accepted as logging fields.
type Options struct {
	Service string
	Version string
	Commit  string
	Writer  io.Writer
	Level   slog.Level
}

// New returns a JSON logger with a narrow allowlist of operational fields.
// The allowlist is enforced at the handler boundary so an accidental unknown
// attribute cannot turn logs into a private-content store.
func New(options Options) *slog.Logger {
	writer := options.Writer
	if writer == nil {
		writer = os.Stderr
	}
	base := slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: options.Level})
	logger := slog.New(&safeHandler{handler: base})
	attrs := make([]any, 0, 3)
	if options.Service != "" {
		attrs = append(attrs, slog.String("service", options.Service))
	}
	if options.Version != "" {
		attrs = append(attrs, slog.String("version", options.Version))
	}
	if options.Commit != "" {
		attrs = append(attrs, slog.String("commit", options.Commit))
	}
	return logger.With(attrs...)
}

var allowedKeys = map[string]struct{}{
	"service":          {},
	"version":          {},
	"commit":           {},
	"component":        {},
	"route":            {},
	"method":           {},
	"request_id":       {},
	"status":           {},
	"error_code":       {},
	"duration_ms":      {},
	"peer_count":       {},
	"room_count":       {},
	"connection_count": {},
	"accepted":         {},
	"rejected":         {},
	"reason":           {},
	"result":           {},
	"shutdown":         {},
}

type safeHandler struct {
	handler slog.Handler
}

func (h *safeHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.handler.Enabled(ctx, level)
}

func (h *safeHandler) Handle(ctx context.Context, record slog.Record) error {
	safe := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	record.Attrs(func(attr slog.Attr) bool {
		if isAllowed(attr) {
			safe.AddAttrs(attr)
		}
		return true
	})
	return h.handler.Handle(ctx, safe)
}

func (h *safeHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	filtered := make([]slog.Attr, 0, len(attrs))
	for _, attr := range attrs {
		if isAllowed(attr) {
			filtered = append(filtered, attr)
		}
	}
	return &safeHandler{handler: h.handler.WithAttrs(filtered)}
}

func (h *safeHandler) WithGroup(name string) slog.Handler {
	return &safeHandler{handler: h.handler.WithGroup(name)}
}

func isAllowed(attr slog.Attr) bool {
	if attr.Equal(slog.Attr{}) || attr.Value.Kind() == slog.KindGroup {
		return false
	}
	_, ok := allowedKeys[attr.Key]
	return ok
}
