package p2p

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	p2pmetrics "github.com/timestarry/duallane/apps/backend/internal/p2p/metrics"
	platformconfig "github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/httpserver"
)

const (
	createRoomBodyLimit = 1 * 1024 * 1024
	roomIDMaxLength     = 128
)

type HandlerOptions struct {
	Config  platformconfig.P2PConfig
	Manager *Manager
	Metrics *p2pmetrics.Metrics
	Logger  *slog.Logger
}

type Handler struct {
	config  platformconfig.P2PConfig
	manager *Manager
	metrics *p2pmetrics.Metrics
	logger  *slog.Logger
	routes  http.Handler
}

func NewHandler(options HandlerOptions) *Handler {
	cfg := options.Config
	if cfg.Host == "" {
		cfg.Host = platformconfig.DefaultHost
	}
	if cfg.Port == 0 {
		cfg.Port = platformconfig.DefaultPort
	}
	if cfg.AppVersion == "" {
		cfg.AppVersion = platformconfig.DefaultAppVersion
	}
	if cfg.RoomTTL == 0 {
		cfg.RoomTTL = platformconfig.DefaultRoomTTL
	}
	if cfg.RoomTTL < 0 {
		cfg.RoomTTL = platformconfig.DefaultRoomTTL
	}
	if cfg.MaxFrameBytes < 1024 || cfg.MaxFrameBytes > platformconfig.MaxConfiguredFrameBytes {
		cfg.MaxFrameBytes = platformconfig.DefaultMaxFrameBytes
	}
	if len(cfg.STUNURLs) == 0 {
		cfg.STUNURLs = []string{platformconfig.DefaultSTUNURL}
	}
	if cfg.TURNTTL == 0 {
		cfg.TURNTTL = platformconfig.DefaultTurnTTL
	}
	if cfg.TURNTTL < 0 {
		cfg.TURNTTL = platformconfig.DefaultTurnTTL
	}
	manager := options.Manager
	if manager == nil {
		manager = NewManager(ManagerOptions{
			RoomTTL:        cfg.RoomTTL,
			EmptyRoomGrace: cfg.EmptyRoomGrace,
		})
	}
	collector := options.Metrics
	if collector == nil {
		collector = p2pmetrics.New()
	}
	h := &Handler{
		config:  cfg,
		manager: manager,
		metrics: collector,
		logger:  options.Logger,
	}
	h.routes = h.buildRoutes()
	h.metrics.SetRooms(h.manager.RoomCount())
	return h
}

func (h *Handler) Routes() http.Handler {
	return h.routes
}

func (h *Handler) Manager() *Manager {
	return h.manager
}

func (h *Handler) Metrics() *p2pmetrics.Metrics {
	return h.metrics
}

func (h *Handler) Close() {
	if h == nil || h.manager == nil {
		return
	}
	h.manager.Close()
	h.metrics.SetRooms(0)
}

func (h *Handler) buildRoutes() http.Handler {
	router := chi.NewRouter()
	router.Use(httpserver.SecurityHeaders)
	router.Use(h.metricsMiddleware)
	router.Post("/api/p2p/rooms", h.createRoom)
	router.Get("/api/p2p/ice-servers", h.iceServers)
	router.Get("/api/p2p/rooms/{roomId}", h.roomStatus)
	router.Get("/ws/p2p/{roomId}", h.websocket)
	router.Get("/api/health", h.health)
	router.Get("/metrics", h.metrics.Handler().ServeHTTP)
	return router
}

func (h *Handler) metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		route := "unmatched"
		if routeContext := chi.RouteContext(r.Context()); routeContext != nil && routeContext.RoutePattern() != "" {
			route = routeContext.RoutePattern()
		}
		h.metrics.ObserveRequest(r.Method, route, recorder.statusCode(), time.Since(started))
	})
}

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, struct {
		OK         bool   `json:"ok"`
		Service    string `json:"service"`
		Lane       string `json:"lane"`
		AppVersion string `json:"appVersion"`
	}{
		OK:         true,
		Service:    "duallane",
		Lane:       "ready",
		AppVersion: h.config.AppVersion,
	})
}

func (h *Handler) createRoom(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))), "application/json") {
		writeError(w, http.StatusBadRequest, "maxPeers must be 2 for p2p rooms")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, createRoomBodyLimit)
	if r.ContentLength > createRoomBodyLimit {
		writeParserError(w, http.StatusRequestEntityTooLarge, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
		return
	}
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeParserError(w, http.StatusRequestEntityTooLarge, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
		} else {
			writeParserError(w, http.StatusBadRequest, "FST_ERR_CTP_INVALID_JSON_BODY", "Body is not valid JSON but content-type is set to 'application/json'")
		}
		return
	}
	if len(rawBody) == 0 {
		writeParserError(w, http.StatusBadRequest, "FST_ERR_CTP_EMPTY_JSON_BODY", "Body cannot be empty when content-type is set to 'application/json'")
		return
	}
	if !json.Valid(rawBody) {
		writeParserError(w, http.StatusBadRequest, "FST_ERR_CTP_INVALID_JSON_BODY", "Body is not valid JSON but content-type is set to 'application/json'")
		return
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(rawBody, &body); err != nil || body == nil {
		writeError(w, http.StatusBadRequest, "maxPeers must be 2 for p2p rooms")
		return
	}
	var maxPeers float64
	if raw, ok := body["maxPeers"]; !ok || json.Unmarshal(raw, &maxPeers) != nil || maxPeers != MaxRoomPeers {
		writeError(w, http.StatusBadRequest, "maxPeers must be 2 for p2p rooms")
		return
	}
	baseURL := h.config.PublicBaseURL
	if baseURL == "" {
		baseURL = requestBaseURL(r, h.config.TrustProxy)
	}
	room, err := h.manager.Create(baseURL)
	if err != nil {
		if errors.Is(err, ErrRoomLimit) {
			writeError(w, http.StatusServiceUnavailable, "room capacity unavailable")
			return
		}
		writeError(w, http.StatusInternalServerError, "room unavailable")
		return
	}
	h.metrics.SetRooms(h.manager.RoomCount())
	writeJSON(w, http.StatusCreated, room)
}

func (h *Handler) roomStatus(w http.ResponseWriter, r *http.Request) {
	roomID := chi.URLParam(r, "roomId")
	if len(roomID) == 0 || len(roomID) > roomIDMaxLength {
		writeError(w, http.StatusNotFound, "room not found")
		return
	}
	room, ok := h.manager.Status(roomID)
	if !ok {
		writeError(w, http.StatusNotFound, "room not found")
		return
	}
	writeJSON(w, http.StatusOK, room)
}

func (h *Handler) iceServers(w http.ResponseWriter, _ *http.Request) {
	servers := make([]iceServer, 0, len(h.config.STUNURLs)+1)
	for _, rawURL := range h.config.STUNURLs {
		if strings.TrimSpace(rawURL) != "" {
			servers = append(servers, iceServer{URLs: rawURL})
		}
	}
	turnURLs := make([]string, 0, len(h.config.TURNURLs))
	for _, rawURL := range h.config.TURNURLs {
		if strings.TrimSpace(rawURL) != "" {
			turnURLs = append(turnURLs, strings.TrimSpace(rawURL))
		}
	}
	if len(turnURLs) > 0 {
		turn := iceServer{URLs: turnURLs}
		if h.config.TURNSharedSecret != "" {
			turn.Username, turn.Credential = turnCredential(h.config.TURNSharedSecret, h.config.TURNTTL)
		} else if h.config.TURNUsername != "" && h.config.TURNCredential != "" {
			turn.Username = h.config.TURNUsername
			turn.Credential = h.config.TURNCredential
		}
		if turn.Username != "" && turn.Credential != "" {
			servers = append(servers, turn)
		}
	}
	writeJSON(w, http.StatusOK, struct {
		ICEServers []iceServer `json:"iceServers"`
	}{ICEServers: servers})
}

type iceServer struct {
	URLs       any    `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

func (h *Handler) websocket(w http.ResponseWriter, r *http.Request) {
	roomID := chi.URLParam(r, "roomId")
	if len(roomID) == 0 || len(roomID) > roomIDMaxLength {
		writeError(w, http.StatusNotFound, "room not found")
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(h.config.MaxFrameBytes)
	var rawConn net.Conn
	if recorder, ok := w.(*statusRecorder); ok {
		rawConn = recorder.hijacked
	}
	peer := &websocketPeer{conn: conn, rawConn: rawConn}
	peerID, err := h.manager.Join(roomID, peer)
	if err != nil {
		h.metrics.RejectFrame(roomErrorReason(err))
		if errors.Is(err, ErrRoomNotFound) {
			_ = sendPeer(peer, marshalSystem("room-not-found", "", nil))
		} else if errors.Is(err, ErrRoomFull) {
			_ = sendPeer(peer, marshalSystem("room-full", "", nil))
		}
		closePeersWithReason([]*peerState{{conn: peer}}, closeCodeForRoomError(err), "room unavailable")
		return
	}
	h.metrics.AddConnection(1)
	h.metrics.SetRooms(h.manager.RoomCount())
	defer func() {
		h.manager.Leave(roomID, peerID, false)
		h.metrics.AddConnection(-1)
		h.metrics.SetRooms(h.manager.RoomCount())
		closePeersWithReason([]*peerState{{conn: peer}}, int(websocket.StatusNormalClosure), "")
	}()

	for {
		messageType, raw, readErr := conn.Read(r.Context())
		if readErr != nil {
			if websocket.CloseStatus(readErr) == websocket.StatusMessageTooBig {
				h.metrics.RejectFrame("message_too_large")
			}
			return
		}
		if messageType != websocket.MessageText && messageType != websocket.MessageBinary {
			h.metrics.RejectFrame("invalid_type")
			_ = sendPeer(peer, marshalSystem("invalid-message", "", nil))
			continue
		}
		message, parseErr := ParseClientMessage(raw)
		if parseErr != nil {
			h.metrics.RejectFrame(envelopeErrorReason(parseErr))
			_ = sendPeer(peer, marshalSystem("invalid-message", "", nil))
			continue
		}
		switch message.Kind {
		case ClientMessageLeave:
			h.manager.Leave(roomID, peerID, true)
			closePeersWithReason([]*peerState{{conn: peer}}, int(websocket.StatusNoStatusRcvd), "")
			return
		case ClientMessageSecure:
			if h.manager.Relay(roomID, peerID, message.Envelope) {
				h.metrics.RelayEnvelope()
			}
		}
	}
}

type websocketPeer struct {
	mu      sync.Mutex
	conn    *websocket.Conn
	rawConn net.Conn
}

func (p *websocketPeer) Send(ctx context.Context, payload []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conn.Write(ctx, websocket.MessageText, payload)
}

func (p *websocketPeer) Close(code int, reason string) error {
	if code < 1000 || code > 4999 {
		code = int(websocket.StatusInternalError)
	}
	return p.conn.Close(websocket.StatusCode(code), reason)
}

func (p *websocketPeer) CloseNow() error {
	if p.rawConn != nil {
		_ = p.rawConn.Close()
	}
	return p.conn.CloseNow()
}

type statusRecorder struct {
	http.ResponseWriter
	status   int
	hijacked net.Conn
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(body)
}

func (r *statusRecorder) statusCode() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("websocket upgrade is unavailable")
	}
	conn, reader, err := hijacker.Hijack()
	if err == nil {
		r.hijacked = conn
	}
	return conn, reader, err
}

func (r *statusRecorder) Flush() {
	flusher, ok := r.ResponseWriter.(http.Flusher)
	if ok {
		if r.status == 0 {
			r.WriteHeader(http.StatusOK)
		}
		flusher.Flush()
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, struct {
		Error string `json:"error"`
	}{Error: message})
}

// Keep the active Node parser's fixed public object, never a raw decoder error.
func writeParserError(w http.ResponseWriter, status int, code, message string) {
	label := "Bad Request"
	if status == http.StatusRequestEntityTooLarge {
		label = "Payload Too Large"
	}
	writeJSON(w, status, struct {
		StatusCode int    `json:"statusCode"`
		Code       string `json:"code"`
		Error      string `json:"error"`
		Message    string `json:"message"`
	}{StatusCode: status, Code: code, Error: label, Message: message})
}

func requestBaseURL(r *http.Request, trustProxy bool) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-Proto"); forwarded != "" {
			forwardedScheme := strings.TrimSpace(strings.Split(forwarded, ",")[0])
			if forwardedScheme == "http" || forwardedScheme == "https" {
				scheme = forwardedScheme
			}
		}
	}
	if scheme != "http" && scheme != "https" {
		scheme = "http"
	}
	host := r.Host
	if host == "" {
		host = "127.0.0.1"
	}
	return (&url.URL{Scheme: scheme, Host: host}).String()
}

func turnCredential(secret string, ttl time.Duration) (string, string) {
	return makeTURNCredential(secret, ttl, time.Now())
}

func roomErrorReason(err error) string {
	if errors.Is(err, ErrRoomFull) {
		return "room_full"
	}
	if errors.Is(err, ErrRoomNotFound) {
		return "room_not_found"
	}
	return "other"
}

func envelopeErrorReason(err error) string {
	if errors.Is(err, ErrInvalidMessage) {
		return "invalid_json"
	}
	if errors.Is(err, ErrInvalidEnvelope) {
		return "invalid_envelope"
	}
	return "other"
}

func closeCodeForRoomError(err error) int {
	if errors.Is(err, ErrRoomFull) || errors.Is(err, ErrRoomNotFound) {
		// Node ws.close() sends an empty close frame. coder/websocket uses
		// StatusNoStatusRcvd to request that wire shape, not to send code 1005.
		return int(websocket.StatusNoStatusRcvd)
	}
	return int(websocket.StatusTryAgainLater)
}
