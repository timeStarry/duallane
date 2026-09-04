package realtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceEvents "github.com/timestarry/duallane/apps/backend/internal/workspace/events"
)

const (
	DefaultMaxFrameBytes     int64 = 4 * 1024
	DefaultPollInterval            = 2 * time.Second
	DefaultHeartbeatInterval       = 30 * time.Second
	DefaultIOTimeout               = 5 * time.Second
	ProtocolVersion                = 1
)

type ActorResolver interface {
	ResolveActor(context.Context, *http.Request) (*auth.Actor, error)
}

type EventService interface {
	Replay(context.Context, workspaceEvents.ReplayInput) (workspaceEvents.ReplayResult, error)
}

type HandlerOptions struct {
	RootContext       context.Context
	ActorResolver     ActorResolver
	Events            EventService
	Hub               *Hub
	MaxFrameBytes     int64
	PollInterval      time.Duration
	HeartbeatInterval time.Duration
	IOTimeout         time.Duration
}

type Handler struct {
	rootContext       context.Context
	actorResolver     ActorResolver
	events            EventService
	hub               *Hub
	maxFrameBytes     int64
	pollInterval      time.Duration
	heartbeatInterval time.Duration
	ioTimeout         time.Duration
}

func NewHandler(options HandlerOptions) *Handler {
	rootContext := options.RootContext
	if rootContext == nil {
		rootContext = context.Background()
	}
	maxFrameBytes := options.MaxFrameBytes
	if maxFrameBytes <= 0 {
		maxFrameBytes = DefaultMaxFrameBytes
	}
	pollInterval := options.PollInterval
	if pollInterval <= 0 {
		pollInterval = DefaultPollInterval
	}
	heartbeatInterval := options.HeartbeatInterval
	if heartbeatInterval <= 0 {
		heartbeatInterval = DefaultHeartbeatInterval
	}
	ioTimeout := options.IOTimeout
	if ioTimeout <= 0 {
		ioTimeout = DefaultIOTimeout
	}
	hub := options.Hub
	if hub == nil {
		hub = NewHub()
	}
	return &Handler{
		rootContext: rootContext, actorResolver: options.ActorResolver, events: options.Events, hub: hub,
		maxFrameBytes: maxFrameBytes, pollInterval: pollInterval,
		heartbeatInterval: heartbeatInterval, ioTimeout: ioTimeout,
	}
}

type inbound struct {
	hello   *hello
	invalid bool
	err     error
}

type hello struct {
	lastSeq int64
}

type socketError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorFrame struct {
	Version int         `json:"version"`
	Type    string      `json:"type"`
	Error   socketError `json:"error"`
}

type readyFrame struct {
	Version     int    `json:"version"`
	Type        string `json:"type"`
	SpaceID     string `json:"spaceId"`
	CurrentSeq  int64  `json:"currentSeq"`
	ReplayFrom  int64  `json:"replayFrom"`
	ReplayCount int    `json:"replayCount"`
	HasMore     bool   `json:"hasMore"`
}

type eventFrame struct {
	Version int                   `json:"version"`
	Type    string                `json:"type"`
	Event   workspaceEvents.Event `json:"event"`
}

type syncRequiredFrame struct {
	Version    int    `json:"version"`
	Type       string `json:"type"`
	SpaceID    string `json:"spaceId"`
	CurrentSeq int64  `json:"currentSeq"`
	Reason     string `json:"reason"`
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.actorResolver == nil || h.events == nil {
		http.Error(response, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
		return
	}
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	connection.SetReadLimit(h.maxFrameBytes)
	ctx, cancel := context.WithCancel(request.Context())
	defer func() {
		cancel()
		_ = connection.CloseNow()
	}()

	wakeup, unsubscribe := h.hub.Subscribe()
	defer unsubscribe()
	incoming := make(chan inbound, 1)
	go h.readLoop(ctx, connection, incoming)
	poll := time.NewTicker(h.pollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(h.heartbeatInterval)
	defer heartbeat.Stop()

	writer := &socketWriter{connection: connection, timeout: h.ioTimeout}
	actorID := ""
	lastDeliveredSeq := int64(0)
	for {
		select {
		case <-h.rootContext.Done():
			_ = writer.close(websocket.StatusServiceRestart, "service restarting")
			return
		case message := <-incoming:
			if message.err != nil {
				return
			}
			if message.invalid {
				if err := writer.write(ctx, errorFrame{Version: ProtocolVersion, Type: "error", Error: socketError{Code: "realtime.invalid", Message: "实时同步请求无效"}}); err != nil {
					return
				}
				continue
			}
			actor, resolveErr := h.actorResolver.ResolveActor(ctx, request)
			if resolveErr != nil || actor == nil || actor.ID == "" {
				if resolveErr == nil {
					resolveErr = auth.NewError(auth.CodeRequired, auth.MessageRequired, http.StatusUnauthorized)
				}
				_ = writer.write(ctx, publicErrorFrame(resolveErr))
				_ = writer.close(websocket.StatusPolicyViolation, "workspace access changed")
				return
			}
			result, replayErr := h.events.Replay(ctx, workspaceEvents.ReplayInput{ActorID: actor.ID, LastSeq: message.hello.lastSeq})
			if replayErr != nil {
				_ = writer.write(ctx, publicErrorFrame(replayErr))
				_ = writer.close(closeStatus(replayErr), "workspace access changed")
				return
			}
			if result.SyncRequired {
				if err := writer.write(ctx, syncFrame(result)); err != nil {
					return
				}
				actorID = ""
				continue
			}
			if err := writer.write(ctx, readyFrame{
				Version: ProtocolVersion, Type: "ready", SpaceID: workspaceEvents.DefaultSpaceID,
				CurrentSeq: result.CurrentSeq, ReplayFrom: result.ReplayFrom,
				ReplayCount: result.ReplayCount, HasMore: result.HasMore,
			}); err != nil {
				return
			}
			if err := writer.writeEvents(ctx, result.Events); err != nil {
				return
			}
			actorID = actor.ID
			lastDeliveredSeq = deliveredCursor(message.hello.lastSeq, result)
		case <-wakeup:
			if actorID != "" && !h.deliverCatchUp(ctx, writer, actorID, &lastDeliveredSeq) {
				return
			}
		case <-poll.C:
			if actorID != "" && !h.deliverCatchUp(ctx, writer, actorID, &lastDeliveredSeq) {
				return
			}
		case <-heartbeat.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, h.ioTimeout)
			err := connection.Ping(pingCtx)
			pingCancel()
			if err != nil {
				_ = writer.close(websocket.StatusGoingAway, "heartbeat timeout")
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (h *Handler) readLoop(ctx context.Context, connection *websocket.Conn, output chan<- inbound) {
	for {
		messageType, raw, err := connection.Read(ctx)
		if err != nil {
			select {
			case output <- inbound{err: err}:
			case <-ctx.Done():
			}
			return
		}
		if messageType != websocket.MessageText {
			select {
			case output <- inbound{invalid: true}:
			case <-ctx.Done():
				return
			}
			continue
		}
		parsed, err := decodeHello(raw)
		message := inbound{hello: parsed, invalid: err != nil}
		select {
		case output <- message:
		case <-ctx.Done():
			return
		}
	}
}

func (h *Handler) deliverCatchUp(ctx context.Context, writer *socketWriter, actorID string, lastDeliveredSeq *int64) bool {
	result, err := h.events.Replay(ctx, workspaceEvents.ReplayInput{ActorID: actorID, LastSeq: *lastDeliveredSeq})
	if err != nil {
		_ = writer.write(ctx, publicErrorFrame(err))
		_ = writer.close(closeStatus(err), "workspace access changed")
		return false
	}
	if result.SyncRequired {
		if writer.write(ctx, syncFrame(result)) != nil {
			return false
		}
		*lastDeliveredSeq = result.CurrentSeq
		return true
	}
	if writer.writeEvents(ctx, result.Events) != nil {
		return false
	}
	*lastDeliveredSeq = deliveredCursor(*lastDeliveredSeq, result)
	if result.HasMore {
		return writer.write(ctx, syncRequiredFrame{
			Version: ProtocolVersion, Type: "sync.required", SpaceID: workspaceEvents.DefaultSpaceID,
			CurrentSeq: result.CurrentSeq, Reason: workspaceEvents.SyncReasonReplayLimit,
		}) == nil
	}
	return true
}

func deliveredCursor(previous int64, result workspaceEvents.ReplayResult) int64 {
	if len(result.Events) == 0 {
		if result.CurrentSeq > previous {
			return result.CurrentSeq
		}
		return previous
	}
	last := result.Events[len(result.Events)-1].Seq
	if last > previous {
		return last
	}
	return previous
}

func syncFrame(result workspaceEvents.ReplayResult) syncRequiredFrame {
	return syncRequiredFrame{
		Version: ProtocolVersion, Type: "sync.required", SpaceID: workspaceEvents.DefaultSpaceID,
		CurrentSeq: result.CurrentSeq, Reason: result.Reason,
	}
}

func decodeHello(raw []byte) (*hello, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var envelope struct {
		Type    string          `json:"type"`
		Version json.RawMessage `json:"version"`
		LastSeq json.RawMessage `json:"lastSeq"`
	}
	if err := decoder.Decode(&envelope); err != nil || envelope.Type != "hello" {
		return nil, errors.New("invalid hello")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("invalid hello")
	}
	if len(envelope.Version) > 0 && string(envelope.Version) != "null" {
		version, err := parseJSONInteger(envelope.Version)
		if err != nil || version != ProtocolVersion {
			return nil, errors.New("invalid version")
		}
	}
	lastSeq := int64(0)
	if len(envelope.LastSeq) > 0 && string(envelope.LastSeq) != "null" {
		value, err := parseJSONInteger(envelope.LastSeq)
		if err != nil {
			return nil, errors.New("invalid cursor")
		}
		lastSeq = value
	}
	if lastSeq < 0 {
		lastSeq = 0
	}
	return &hello{lastSeq: lastSeq}, nil
}

func parseJSONInteger(raw []byte) (int64, error) {
	value := string(raw)
	if value == "" || value[0] == '"' {
		return 0, errors.New("not a number")
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, errors.New("not an integer")
	}
	return parsed, nil
}

func publicErrorFrame(err error) errorFrame {
	frame := errorFrame{Version: ProtocolVersion, Type: "error", Error: socketError{Code: "internal.error", Message: "服务暂时不可用"}}
	var authError *auth.Error
	if errors.As(err, &authError) {
		frame.Error = socketError{Code: authError.Code, Message: authError.Message}
		return frame
	}
	var eventError *workspaceEvents.Error
	if errors.As(err, &eventError) {
		frame.Error = socketError{Code: eventError.Code, Message: eventError.Message}
	}
	return frame
}

func closeStatus(err error) websocket.StatusCode {
	var authError *auth.Error
	var eventError *workspaceEvents.Error
	if errors.As(err, &authError) && authError.StatusCode < http.StatusInternalServerError {
		return websocket.StatusPolicyViolation
	}
	if errors.As(err, &eventError) && eventError.StatusCode < http.StatusInternalServerError {
		return websocket.StatusPolicyViolation
	}
	return websocket.StatusInternalError
}

type socketWriter struct {
	mu         sync.Mutex
	connection *websocket.Conn
	timeout    time.Duration
}

func (w *socketWriter) write(ctx context.Context, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	writeCtx, cancel := context.WithTimeout(ctx, w.timeout)
	defer cancel()
	return w.connection.Write(writeCtx, websocket.MessageText, payload)
}

func (w *socketWriter) writeEvents(ctx context.Context, values []workspaceEvents.Event) error {
	for _, event := range values {
		if err := w.write(ctx, eventFrame{Version: ProtocolVersion, Type: "event", Event: event}); err != nil {
			return err
		}
	}
	return nil
}

func (w *socketWriter) close(status websocket.StatusCode, reason string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.connection.Close(status, reason)
}
