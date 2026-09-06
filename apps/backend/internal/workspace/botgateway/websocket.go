package botgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const (
	DefaultWebSocketReadLimit         int64 = 32 * 1024
	DefaultWebSocketPollInterval            = 2 * time.Second
	DefaultWebSocketHeartbeatInterval       = 30 * time.Second
	DefaultWebSocketWriteTimeout            = 5 * time.Second
)

// ErrShutdownCleanupFailed reports that one or more durable connection
// cleanup callbacks failed. The error intentionally carries no provider,
// token, bot, or connection details; callers may log this sentinel as a
// content-free shutdown failure and retain the underlying failure only inside
// the owning gateway's private diagnostics.
var ErrShutdownCleanupFailed = errors.New("bot gateway shutdown cleanup failed")

// WebSocketGateway is the narrow runtime surface used by the transport. It
// deliberately exposes no repository or live broadcast hook: replay remains
// the durable source of truth and the handler polls it for events produced by
// other processes.
type WebSocketGateway interface {
	Authenticate(ctx context.Context, rawAuthorization string, options TokenAuthOptions) (*Auth, error)
	ValidateAuth(ctx context.Context, value *Auth) (*Auth, error)
	RegisterConnection(ctx context.Context, value *Auth, registration ConnectionRegistration) (func(context.Context) error, error)
	Heartbeat(ctx context.Context, value *Auth, nonce string) (HeartbeatResult, error)
	Replay(ctx context.Context, value *Auth, input ReplayInput) (ReplayResult, error)
	Acknowledge(ctx context.Context, value *Auth, input AcknowledgeInput) (AcknowledgeResult, error)
}

type WebSocketHandlerOptions struct {
	RootContext       context.Context
	Gateway           WebSocketGateway
	SpaceID           string
	OriginPatterns    []string
	ReadLimit         int64
	PollInterval      time.Duration
	HeartbeatInterval time.Duration
	WriteTimeout      time.Duration
}

type WebSocketHandler struct {
	rootContext       context.Context
	cancelRoot        context.CancelFunc
	gateway           WebSocketGateway
	spaceID           string
	originPatterns    []string
	readLimit         int64
	pollInterval      time.Duration
	heartbeatInterval time.Duration
	writeTimeout      time.Duration

	admissionMu     sync.Mutex
	admissionClosed bool
	activeHandlers  int
	handlersDone    chan struct{}
	cleanupFailed   bool
}

func NewWebSocketHandler(options WebSocketHandlerOptions) *WebSocketHandler {
	rootContext := options.RootContext
	if rootContext == nil {
		rootContext = context.Background()
	}
	rootContext, cancelRoot := context.WithCancel(rootContext)
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	readLimit := options.ReadLimit
	if readLimit <= 0 {
		readLimit = DefaultWebSocketReadLimit
	}
	pollInterval := options.PollInterval
	if pollInterval <= 0 {
		pollInterval = DefaultWebSocketPollInterval
	}
	heartbeatInterval := options.HeartbeatInterval
	if heartbeatInterval <= 0 {
		heartbeatInterval = DefaultWebSocketHeartbeatInterval
	}
	writeTimeout := options.WriteTimeout
	if writeTimeout <= 0 {
		writeTimeout = DefaultWebSocketWriteTimeout
	}
	return &WebSocketHandler{
		rootContext: rootContext,
		cancelRoot:  cancelRoot,
		gateway:     options.Gateway, spaceID: spaceID, originPatterns: append([]string(nil), options.OriginPatterns...),
		readLimit: readLimit, pollInterval: pollInterval, heartbeatInterval: heartbeatInterval, writeTimeout: writeTimeout,
		handlersDone: closedChannel(),
	}
}

// Shutdown closes admission, cancels the handler-owned root, and waits for
// every admitted handler to finish its socket close and durable cleanup. The
// caller controls the wait deadline; no business connection registry is
// created here.
func (h *WebSocketHandler) Shutdown(ctx context.Context) error {
	if h == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var cancelRoot context.CancelFunc
	h.admissionMu.Lock()
	if !h.admissionClosed {
		h.admissionClosed = true
		cancelRoot = h.cancelRoot
	}
	if h.handlersDone == nil {
		h.handlersDone = closedChannel()
	}
	done := h.handlersDone
	h.admissionMu.Unlock()
	if cancelRoot != nil {
		cancelRoot()
	}
	select {
	case <-done:
		h.admissionMu.Lock()
		cleanupFailed := h.cleanupFailed
		h.admissionMu.Unlock()
		if cleanupFailed {
			return ErrShutdownCleanupFailed
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func closedChannel() chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}

func (h *WebSocketHandler) admit() bool {
	h.admissionMu.Lock()
	defer h.admissionMu.Unlock()
	if h.admissionClosed {
		return false
	}
	if h.activeHandlers == 0 {
		h.handlersDone = make(chan struct{})
	}
	h.activeHandlers++
	return true
}

func (h *WebSocketHandler) release() {
	h.admissionMu.Lock()
	defer h.admissionMu.Unlock()
	if h.activeHandlers == 0 {
		return
	}
	h.activeHandlers--
	if h.activeHandlers == 0 {
		if h.handlersDone != nil {
			close(h.handlersDone)
		}
	}
}

func (h *WebSocketHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.gateway == nil {
		http.Error(response, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	if !h.admit() {
		http.Error(response, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	defer h.release()
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		OriginPatterns:  h.originPatterns,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer func() { _ = connection.CloseNow() }()
	connection.SetReadLimit(h.readLimit)

	requestContext, cancelRequest := context.WithCancel(request.Context())
	defer cancelRequest()
	operationContext, cancelOperation := context.WithCancel(requestContext)
	defer cancelOperation()
	stopRoot := context.AfterFunc(h.rootContext, cancelOperation)
	defer stopRoot()
	if h.rootContext.Err() != nil {
		closeWebSocket(connection, websocket.StatusServiceRestart, "service restarting")
		return
	}
	if err := websocketAuthorization(request.Header.Get("Authorization")); err != nil {
		closeWebSocket(connection, websocket.StatusPolicyViolation, "bot authentication required")
		return
	}
	handshakeContext, cancelHandshake := context.WithTimeout(operationContext, h.writeTimeout)
	defer cancelHandshake()
	authValue, err := h.gateway.Authenticate(handshakeContext, request.Header.Get("Authorization"), TokenAuthOptions{SpaceID: h.spaceID})
	if err != nil {
		closeWebSocket(connection, websocket.StatusPolicyViolation, "bot authentication required")
		return
	}
	nonce := uuid.New().String()
	cleanup, err := h.gateway.RegisterConnection(handshakeContext, authValue, ConnectionRegistration{
		AdapterVersion: boundedHeader(request.Header.Get("X-DualLane-Adapter-Version"), 128),
		Nonce:          nonce,
	})
	if err != nil {
		if h.rootContext.Err() != nil {
			closeWebSocket(connection, websocket.StatusServiceRestart, "service restarting")
			return
		}
		closeWebSocket(connection, closeCodeForError(err, websocket.StatusInternalError), closeReasonForError(err, "connection unavailable"))
		return
	}
	defer func() {
		// Root shutdown cancels operationContext so the transport can leave its
		// read loop and close handshake promptly. Cleanup is a durable projection
		// write and must get an independent bounded context or the connection
		// lease can remain connected after a graceful shutdown.
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), h.writeTimeout)
		defer cleanupCancel()
		if err := cleanup(cleanupContext); err != nil {
			// Keep only an aggregated status on the transport. The callback may
			// contain provider or token details that must not escape shutdown.
			h.admissionMu.Lock()
			h.cleanupFailed = true
			h.admissionMu.Unlock()
		}
	}()

	h.run(requestContext, operationContext, connection, authValue, nonce)
}

func (h *WebSocketHandler) run(readBaseContext, operationBaseContext context.Context, connection *websocket.Conn, authValue *Auth, nonce string) {
	runContext, cancel := context.WithCancel(operationBaseContext)
	defer cancel()
	readContext, cancelRead := context.WithCancel(readBaseContext)
	writer := &webSocketWriter{context: runContext, connection: connection, timeout: h.writeTimeout}
	readResults := make(chan webSocketReadResult, 1)
	var readers sync.WaitGroup
	startRead := func() {
		readers.Add(1)
		go func() {
			defer readers.Done()
			typ, payload, err := connection.Read(readContext)
			readResults <- webSocketReadResult{typ: typ, payload: payload, err: err}
		}()
	}
	defer func() {
		// A normal read/writer/context return must not leave the accepted socket
		// or its one owned reader behind. CloseNow unblocks Read; the wait makes
		// the ownership boundary explicit before ServeHTTP runs cleanup.
		cancelRead()
		_ = connection.CloseNow()
		readers.Wait()
	}()
	startRead()

	poll := time.NewTicker(h.pollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(h.heartbeatInterval)
	defer heartbeat.Stop()

	helloReceived := false
	cursor := int64(0)
	for {
		select {
		case <-h.rootContext.Done():
			closeWebSocket(connection, websocket.StatusServiceRestart, "service restarting")
			return
		case <-runContext.Done():
			if h.rootContext.Err() != nil {
				closeWebSocket(connection, websocket.StatusServiceRestart, "service restarting")
			}
			return
		case result := <-readResults:
			if h.rootContext.Err() != nil {
				closeWebSocket(connection, websocket.StatusServiceRestart, "service restarting")
				return
			}
			if result.err != nil {
				return
			}
			if result.typ != websocket.MessageText && result.typ != websocket.MessageBinary {
				current, err := h.gateway.ValidateAuth(runContext, authValue)
				if err != nil {
					closeWebSocket(connection, closeCodeForError(err, websocket.StatusPolicyViolation), closeReasonForError(err, "bot token revoked"))
					return
				}
				authValue = current
				if err := writer.errorFrame(invalidMessageError()); err != nil {
					return
				}
				startRead()
				continue
			}
			nextCursor, nextAuth, keepOpen := h.handleMessage(runContext, writer, authValue, nonce, cursor, &helloReceived, result.payload)
			if h.rootContext.Err() != nil {
				closeWebSocket(connection, websocket.StatusServiceRestart, "service restarting")
				return
			}
			if nextAuth != nil {
				authValue = nextAuth
			}
			cursor = nextCursor
			if !keepOpen {
				return
			}
			startRead()
		case <-heartbeat.C:
			if h.rootContext.Err() != nil {
				closeWebSocket(connection, websocket.StatusServiceRestart, "service restarting")
				return
			}
			current, err := h.gateway.ValidateAuth(runContext, authValue)
			if err != nil {
				closeWebSocket(connection, closeCodeForError(err, websocket.StatusPolicyViolation), closeReasonForError(err, "bot token revoked"))
				return
			}
			authValue = current
			if err := writer.ping(); err != nil {
				return
			}
		case <-poll.C:
			if runContext.Err() != nil {
				if h.rootContext.Err() != nil {
					closeWebSocket(connection, websocket.StatusServiceRestart, "service restarting")
				}
				return
			}
			if !helloReceived {
				continue
			}
			current, _, next, keepOpen, err := h.pollReplay(runContext, writer, authValue, cursor)
			if err != nil {
				if isInvalidToken(err) {
					closeWebSocket(connection, websocket.StatusPolicyViolation, "bot token revoked")
					return
				}
				if writer.errorFrame(err) != nil {
					return
				}
				continue
			}
			authValue = current
			cursor = next
			if !keepOpen {
				return
			}
		}
	}
}

type webSocketReadResult struct {
	typ     websocket.MessageType
	payload []byte
	err     error
}

type webSocketWriter struct {
	context    context.Context
	mu         sync.Mutex
	connection *websocket.Conn
	timeout    time.Duration
}

func (w *webSocketWriter) write(value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return internalError("encode bot gateway WebSocket message", err)
	}
	ctx, cancel := context.WithTimeout(w.context, w.timeout)
	defer cancel()
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.connection.Write(ctx, websocket.MessageText, payload)
}

func (w *webSocketWriter) ping() error {
	ctx, cancel := context.WithTimeout(w.context, w.timeout)
	defer cancel()
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.connection.Ping(ctx)
}

func (w *webSocketWriter) errorFrame(err error) error {
	value := publicGatewayError(err)
	return w.write(map[string]any{"version": Version, "type": "error", "error": value})
}

func (h *WebSocketHandler) handleMessage(ctx context.Context, writer *webSocketWriter, authValue *Auth, nonce string, cursor int64, helloReceived *bool, payload []byte) (int64, *Auth, bool) {
	current, err := h.gateway.ValidateAuth(ctx, authValue)
	if err != nil {
		closeWebSocket(writer.connection, closeCodeForError(err, websocket.StatusPolicyViolation), closeReasonForError(err, "bot token revoked"))
		return cursor, authValue, false
	}
	authValue = current
	fields, err := decodeObject(payload)
	if err != nil {
		return cursor, authValue, writer.errorFrame(invalidMessageError()) == nil
	}
	typ := rawString(fields["type"])
	if !*helloReceived {
		if typ != "hello" || !rawVersion(fields["version"]) {
			return cursor, authValue, writer.errorFrame(invalidHelloError()) == nil
		}
		// Node sets helloReceived before it calls replay. A valid hello with a
		// bad cursor therefore leaves the socket in the post-hello state and
		// reports gateway.invalid_sequence rather than gateway.invalid_hello.
		*helloReceived = true
		lastSequence, sequenceErr := optionalSequence(fields, "lastSequence", "lastSeq")
		if sequenceErr != nil {
			return cursor, authValue, writer.errorFrame(sequenceErr) == nil
		}
		result, err := h.gateway.Replay(ctx, authValue, ReplayInput{LastSequence: lastSequence})
		if err != nil {
			if isInvalidToken(err) {
				closeWebSocket(writer.connection, websocket.StatusPolicyViolation, "bot token revoked")
				return cursor, authValue, false
			}
			return cursor, authValue, writer.errorFrame(err) == nil
		}
		if result.SyncRequired {
			if err := writer.write(map[string]any{"version": Version, "type": "sync_required", "currentSequence": result.CurrentSequence, "reason": result.Reason}); err != nil {
				return cursor, authValue, false
			}
			return result.CurrentSequence, authValue, true
		}
		if err := writer.write(map[string]any{"version": Version, "type": "ready", "currentSequence": result.CurrentSequence, "replayCount": len(result.Events), "hasMore": result.HasMore}); err != nil {
			return cursor, authValue, false
		}
		cursor = lastSequence
		for _, event := range result.Events {
			if err := writer.write(map[string]any{"version": Version, "type": "event", "event": event}); err != nil {
				return cursor, authValue, false
			}
			if event.Sequence > cursor {
				cursor = event.Sequence
			}
		}
		return cursor, authValue, true
	}

	switch typ {
	case "heartbeat":
		result, err := h.gateway.Heartbeat(ctx, authValue, nonce)
		if err != nil {
			if isInvalidToken(err) {
				closeWebSocket(writer.connection, websocket.StatusPolicyViolation, "bot token revoked")
				return cursor, authValue, false
			}
			return cursor, authValue, writer.errorFrame(err) == nil
		}
		id := json.RawMessage("null")
		if raw, ok := fields["id"]; ok {
			canonical, canonicalErr := nodeParsedJSON(raw)
			if canonicalErr == nil {
				id = canonical
			}
		}
		if err := writer.write(map[string]any{"version": Version, "type": "heartbeat", "id": id, "timestamp": result.Timestamp}); err != nil {
			return cursor, authValue, false
		}
		return cursor, authValue, true
	case "ack":
		ack, decodeErr := decodeAcknowledge(fields)
		if decodeErr != nil {
			return cursor, authValue, writer.errorFrame(decodeErr) == nil
		}
		result, err := h.gateway.Acknowledge(ctx, authValue, ack)
		if err != nil {
			if isInvalidToken(err) {
				closeWebSocket(writer.connection, websocket.StatusPolicyViolation, "bot token revoked")
				return cursor, authValue, false
			}
			return cursor, authValue, writer.errorFrame(err) == nil
		}
		var eventID any = result.EventID
		if result.EventID == "" {
			eventID = nil
		}
		if err := writer.write(map[string]any{"version": Version, "type": "ack", "acknowledged": result.Acknowledged, "eventId": eventID, "sequence": result.Sequence}); err != nil {
			return cursor, authValue, false
		}
		return cursor, authValue, true
	default:
		return cursor, authValue, writer.errorFrame(invalidMessageError()) == nil
	}
}

func (h *WebSocketHandler) pollReplay(ctx context.Context, writer *webSocketWriter, authValue *Auth, cursor int64) (*Auth, ReplayResult, int64, bool, error) {
	current, err := h.gateway.ValidateAuth(ctx, authValue)
	if err != nil {
		return authValue, ReplayResult{}, cursor, false, err
	}
	result, err := h.gateway.Replay(ctx, current, ReplayInput{LastSequence: cursor})
	if err != nil {
		return current, ReplayResult{}, cursor, true, err
	}
	if result.SyncRequired {
		if err := writer.write(map[string]any{"version": Version, "type": "sync_required", "currentSequence": result.CurrentSequence, "reason": result.Reason}); err != nil {
			return current, result, cursor, false, err
		}
		return current, result, result.CurrentSequence, true, nil
	}
	for _, event := range result.Events {
		if err := writer.write(map[string]any{"version": Version, "type": "event", "event": event}); err != nil {
			return current, result, cursor, false, err
		}
		if event.Sequence > cursor {
			cursor = event.Sequence
		}
	}
	return current, result, cursor, true, nil
}

func decodeObject(payload []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	var value map[string]json.RawMessage
	if err := decoder.Decode(&value); err != nil || value == nil {
		return nil, errors.New("gateway message is not an object")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("gateway message has trailing data")
	}
	return value, nil
}

func rawString(value json.RawMessage) string {
	var result string
	if len(value) == 0 || json.Unmarshal(value, &result) != nil {
		return ""
	}
	return result
}

func rawVersion(value json.RawMessage) bool {
	if len(value) == 0 {
		return false
	}
	var parsed any
	if json.Unmarshal(value, &parsed) != nil {
		return false
	}
	number, ok := parsed.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0) && number == Version
}

func optionalSequence(fields map[string]json.RawMessage, names ...string) (int64, error) {
	for _, name := range names {
		raw, exists := fields[name]
		if !exists || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			continue
		}
		value, ok := gatewaySafeInteger(raw)
		if !ok {
			return 0, invalidSequenceError()
		}
		return value, nil
	}
	return 0, nil
}

func decodeAcknowledge(fields map[string]json.RawMessage) (AcknowledgeInput, error) {
	result := AcknowledgeInput{EventID: nodeTrimSpace(rawString(fields["eventId"]))}
	raw, present := fields["sequence"]
	if !present {
		// Node passes undefined to Number(undefined), which is NaN and fails
		// normalizeSequence. Do not collapse a missing field into null/zero.
		return AcknowledgeInput{}, invalidSequenceError()
	}
	sequence, ok := gatewaySafeInteger(raw)
	if !ok {
		return AcknowledgeInput{}, invalidSequenceError()
	}
	result.Sequence = sequence
	if result.EventID == "" && result.Sequence <= 0 {
		return AcknowledgeInput{}, NewError(CodeInvalidAck, MessageInvalidAck, 400)
	}
	return result, nil
}

func gatewaySafeInteger(raw json.RawMessage) (int64, bool) {
	number, ok := gatewayNodeNumber(raw)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) || number < 0 || number > float64((1<<53)-1) {
		return 0, false
	}
	return int64(number), true
}

func gatewayNodeNumber(raw json.RawMessage) (float64, bool) {
	var value any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return 0, false
	}
	switch value := value.(type) {
	case nil:
		return 0, true
	case bool:
		if value {
			return 1, true
		}
		return 0, true
	case float64:
		return value, true
	case string:
		return gatewayNodeNumberString(value)
	case []any:
		return gatewayNodeNumberString(gatewayNodeArrayString(value))
	default:
		return math.NaN(), true
	}
}

func gatewayNodeNumberString(value string) (float64, bool) {
	value = nodeTrimSpace(value)
	if value == "" {
		return 0, true
	}
	if value == "Infinity" || value == "+Infinity" {
		return math.Inf(1), true
	}
	if value == "-Infinity" {
		return math.Inf(-1), true
	}
	if len(value) > 2 && value[0] != '+' && value[0] != '-' {
		base := 0
		digits := value[2:]
		switch value[:2] {
		case "0x", "0X":
			base = 16
		case "0b", "0B":
			base = 2
		case "0o", "0O":
			base = 8
		}
		if base != 0 {
			parsed, err := strconv.ParseUint(digits, base, 64)
			if err != nil {
				return math.NaN(), true
			}
			return float64(parsed), true
		}
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return math.NaN(), true
	}
	return parsed, true
}

func gatewayNodeArrayString(values []any) string {
	var builder strings.Builder
	for index, value := range values {
		if index > 0 {
			builder.WriteByte(',')
		}
		switch value := value.(type) {
		case nil:
			// Array.prototype.join renders null and undefined as an empty item.
		case []any:
			builder.WriteString(gatewayNodeArrayString(value))
		case map[string]any:
			builder.WriteString("[object Object]")
		case string:
			builder.WriteString(value)
		case bool:
			if value {
				builder.WriteString("true")
			} else {
				builder.WriteString("false")
			}
		case float64:
			builder.WriteString(strconv.FormatFloat(value, 'g', -1, 64))
		}
	}
	return builder.String()
}

func boundedHeader(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) > max {
		return ""
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return ""
		}
	}
	return value
}

func websocketAuthorization(value string) error {
	// Service.Authenticate intentionally supports raw dl_bot_ tokens for
	// internal callers. The public WebSocket transport is narrower and mirrors
	// Node's extractBearerToken boundary: only the HTTP Bearer envelope may
	// cross this boundary.
	if strings.HasPrefix(value, "dl_bot_") {
		return invalidTokenError()
	}
	_, err := ExtractBearerToken(value)
	return err
}

func publicGatewayError(err error) *Error {
	var value *Error
	if errors.As(err, &value) {
		return value.Public()
	}
	return internalError("encode bot gateway error", err).Public()
}

func isInvalidToken(err error) bool {
	var value *Error
	return errors.As(err, &value) && value.Code == CodeInvalidToken
}

func closeCodeForError(err error, fallback websocket.StatusCode) websocket.StatusCode {
	if isInvalidToken(err) {
		return websocket.StatusPolicyViolation
	}
	return fallback
}

func closeReasonForError(err error, fallback string) string {
	if isInvalidToken(err) {
		return "bot token revoked"
	}
	return fallback
}

func closeWebSocket(connection *websocket.Conn, code websocket.StatusCode, reason string) {
	if connection == nil {
		return
	}
	_ = connection.Close(code, reason)
}

var _ http.Handler = (*WebSocketHandler)(nil)

func invalidHelloError() *Error {
	return NewError(CodeInvalidHello, MessageInvalidHello, 400)
}

func invalidMessageError() *Error {
	return NewError(CodeInvalidMessage, MessageInvalidMessage, 400)
}
