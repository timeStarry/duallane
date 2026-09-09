package storage

import (
	"context"
	"errors"
	"io"
	"reflect"
	"sync"

	platformmetrics "github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
)

// ObjectObserver is the narrow, privacy-safe storage observation seam. It
// accepts only fixed operation/outcome categories and a byte count; keys,
// URLs, provider errors, and object metadata are intentionally unavailable.
type ObjectObserver interface {
	ObserveObject(platformmetrics.Service, platformmetrics.ObjectOperation, platformmetrics.ObjectOutcome, int64)
}

// ObservationOptions binds one observer to a process-local service label.
// Configure it only on the outermost concrete store. A HybridBlobStore emits
// one logical observation for its delegated operation, so its primary and
// local stores should not also be configured with the same observer.
type ObservationOptions struct {
	Observer ObjectObserver
	Service  platformmetrics.Service
}

type operationObserver struct {
	observer ObjectObserver
	service  platformmetrics.Service
}

func newOperationObserver(options ObservationOptions) *operationObserver {
	if isNilObjectObserver(options.Observer) {
		return nil
	}
	return &operationObserver{observer: options.Observer, service: options.Service}
}

func isNilObjectObserver(observer ObjectObserver) bool {
	if observer == nil {
		return true
	}
	value := reflect.ValueOf(observer)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

func (o *operationObserver) observe(operation platformmetrics.ObjectOperation, outcome platformmetrics.ObjectOutcome, bytes int64) {
	if o == nil || isNilObjectObserver(o.observer) {
		return
	}
	if bytes < 0 {
		bytes = 0
	}
	o.observer.ObserveObject(o.service, operation, outcome, bytes)
}

// observeOpened records handle acquisition separately from stream
// verification. An Open success never implies that the caller consumed or
// hash-verified the returned body; that result is recorded only at EOF or a
// terminal read/close failure by observedReadCloser.
func (o *operationObserver) observeOpened(ctx context.Context, opened OpenedObject, err error) (OpenedObject, error) {
	if o == nil {
		return opened, err
	}
	if err != nil || opened.Body == nil {
		o.observe(platformmetrics.ObjectOperationOpen, platformmetrics.ObjectOutcomeFailure, 0)
		return opened, err
	}
	o.observe(platformmetrics.ObjectOperationOpen, platformmetrics.ObjectOutcomeSuccess, 0)
	if ctx == nil {
		ctx = context.Background()
	}
	opened.Body = &observedReadCloser{ctx: ctx, body: opened.Body, observer: o}
	return opened, nil
}

type countedReader struct {
	source io.Reader
	bytes  int64
}

func (r *countedReader) Read(p []byte) (int, error) {
	n, err := r.source.Read(p)
	if n > 0 {
		r.bytes += int64(n)
	}
	return n, err
}

// observedReadCloser serializes Read calls with readMu while keeping stateMu
// short-lived. Close deliberately does not acquire readMu: it must be able to
// call the provider body's Close and interrupt a blocked Read. It emits
// exactly one verify observation: EOF is success, any read
// error/cancellation or close before EOF is failure.
type observedReadCloser struct {
	readMu   sync.Mutex
	stateMu  sync.Mutex
	ctx      context.Context
	body     io.ReadCloser
	observer *operationObserver
	bytes    int64
	closed   bool
	finished bool
	terminal error
}

func (r *observedReadCloser) Read(p []byte) (int, error) {
	if r == nil {
		return 0, io.ErrClosedPipe
	}
	r.readMu.Lock()
	defer r.readMu.Unlock()
	r.stateMu.Lock()
	if r.closed {
		r.stateMu.Unlock()
		return 0, io.ErrClosedPipe
	}
	if r.finished {
		err := r.terminal
		r.stateMu.Unlock()
		return 0, err
	}
	ctx := r.ctx
	body := r.body
	r.stateMu.Unlock()
	if err := ctx.Err(); err != nil {
		r.finish(platformmetrics.ObjectOutcomeFailure, err)
		return 0, err
	}
	n, err := body.Read(p)
	r.stateMu.Lock()
	if n > 0 {
		r.bytes += int64(n)
	}
	if r.terminal != nil {
		terminal := r.terminal
		r.stateMu.Unlock()
		return n, terminal
	}
	r.stateMu.Unlock()
	if err == nil {
		return n, nil
	}
	if errors.Is(err, io.EOF) {
		if ctxErr := ctx.Err(); ctxErr != nil {
			r.finish(platformmetrics.ObjectOutcomeFailure, ctxErr)
			return n, ctxErr
		}
		r.finish(platformmetrics.ObjectOutcomeSuccess, io.EOF)
		return n, io.EOF
	}
	r.finish(platformmetrics.ObjectOutcomeFailure, err)
	return n, err
}

func (r *observedReadCloser) finish(outcome platformmetrics.ObjectOutcome, terminal error) {
	if r == nil {
		return
	}
	r.stateMu.Lock()
	if r.finished {
		r.stateMu.Unlock()
		return
	}
	r.finished = true
	r.terminal = terminal
	bytes := r.bytes
	observer := r.observer
	r.stateMu.Unlock()
	observer.observe(platformmetrics.ObjectOperationVerify, outcome, bytes)
}

func (r *observedReadCloser) Close() error {
	if r == nil {
		return nil
	}
	r.stateMu.Lock()
	if r.closed {
		r.stateMu.Unlock()
		return nil
	}
	r.closed = true
	shouldObserve := !r.finished
	if shouldObserve {
		r.finished = true
		r.terminal = io.ErrClosedPipe
	}
	bytes := r.bytes
	observer := r.observer
	body := r.body
	r.stateMu.Unlock()
	closeErr := error(nil)
	if body == nil {
		closeErr = nil
	} else {
		// Close is intentionally outside readMu/stateMu: provider bodies use
		// Close to interrupt a blocked Read.
		closeErr = body.Close()
	}
	if shouldObserve {
		observer.observe(platformmetrics.ObjectOperationVerify, platformmetrics.ObjectOutcomeFailure, bytes)
	}
	return closeErr
}
