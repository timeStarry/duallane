package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultHost              = "0.0.0.0"
	DefaultPort              = 8787
	DefaultAppVersion        = "0.0.0"
	DefaultRoomTTL           = 2 * time.Hour
	DefaultEmptyRoomGrace    = 10 * time.Second
	DefaultTurnTTL           = 10 * time.Minute
	DefaultMaxFrameBytes     = 64 * 1024
	DefaultSTUNURL           = "stun:stun.l.google.com:19302"
	MaxConfiguredFrameBytes  = 256 * 1024
	MaxConfiguredRoomTTL     = 24 * time.Hour
	MaxConfiguredGracePeriod = 24 * time.Hour
)

// P2PConfig contains only settings owned by the private-lane process. In
// particular, it deliberately has no database, object-store, or Workspace
// credentials.
type P2PConfig struct {
	Host             string
	Port             int
	PublicBaseURL    string
	TrustProxy       bool
	AppVersion       string
	Commit           string
	RoomTTL          time.Duration
	EmptyRoomGrace   time.Duration
	MaxFrameBytes    int64
	STUNURLs         []string
	TURNURLs         []string
	TURNSharedSecret string
	TURNTTL          time.Duration
	TURNUsername     string
	TURNCredential   string
}

// Load reads the process environment and fails closed on invalid values that
// would make the service impossible to address or expose unsafe limits.
func Load() (P2PConfig, error) {
	return LoadFrom(os.LookupEnv)
}

// LoadFrom is injectable so configuration parsing can be tested without
// mutating process-wide environment variables.
func LoadFrom(lookup func(string) (string, bool)) (P2PConfig, error) {
	if lookup == nil {
		return P2PConfig{}, errors.New("configuration lookup is required")
	}

	appVersion := valueOr(lookup, "DUALLANE_APP_VERSION", "")
	if appVersion == "" {
		appVersion = valueOr(lookup, "APP_VERSION", DefaultAppVersion)
	}
	cfg := P2PConfig{
		Host:             valueOr(lookup, "HOST", DefaultHost),
		Port:             DefaultPort,
		PublicBaseURL:    strings.TrimSpace(valueOr(lookup, "PUBLIC_BASE_URL", "")),
		TrustProxy:       valueOr(lookup, "TRUST_PROXY", "false") == "true",
		AppVersion:       appVersion,
		Commit:           valueOr(lookup, "DUALLANE_GIT_COMMIT", "unknown"),
		RoomTTL:          DefaultRoomTTL,
		EmptyRoomGrace:   DefaultEmptyRoomGrace,
		MaxFrameBytes:    DefaultMaxFrameBytes,
		STUNURLs:         parseURLList(valueOr(lookup, "DUALLANE_STUN_URLS", ""), []string{DefaultSTUNURL}),
		TURNURLs:         parseURLList(valueOr(lookup, "DUALLANE_TURN_URLS", ""), nil),
		TURNSharedSecret: strings.TrimSpace(valueOr(lookup, "DUALLANE_TURN_SHARED_SECRET", "")),
		TURNTTL:          DefaultTurnTTL,
		TURNUsername:     strings.TrimSpace(valueOr(lookup, "DUALLANE_TURN_USERNAME", "")),
		TURNCredential:   strings.TrimSpace(valueOr(lookup, "DUALLANE_TURN_CREDENTIAL", "")),
	}

	if raw, ok := lookup("PORT"); ok && strings.TrimSpace(raw) != "" {
		port, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || port < 1 || port > 65535 {
			return P2PConfig{}, fmt.Errorf("PORT must be between 1 and 65535")
		}
		cfg.Port = port
	}
	if raw, ok := lookup("DUALLANE_P2P_ROOM_TTL_MS"); ok && strings.TrimSpace(raw) != "" {
		value, err := parseBoundedMilliseconds(raw, time.Millisecond, MaxConfiguredRoomTTL)
		if err != nil {
			return P2PConfig{}, fmt.Errorf("DUALLANE_P2P_ROOM_TTL_MS: %w", err)
		}
		cfg.RoomTTL = value
	}
	if raw, ok := lookup("DUALLANE_EMPTY_ROOM_GRACE_MS"); ok && strings.TrimSpace(raw) != "" {
		value, err := parseBoundedMilliseconds(raw, time.Millisecond, MaxConfiguredGracePeriod)
		if err != nil {
			return P2PConfig{}, fmt.Errorf("DUALLANE_EMPTY_ROOM_GRACE_MS: %w", err)
		}
		cfg.EmptyRoomGrace = value
	}
	if raw, ok := lookup("DUALLANE_P2P_MAX_FRAME_BYTES"); ok && strings.TrimSpace(raw) != "" {
		value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil || value < 1024 || value > MaxConfiguredFrameBytes {
			return P2PConfig{}, fmt.Errorf("DUALLANE_P2P_MAX_FRAME_BYTES must be between 1024 and %d", MaxConfiguredFrameBytes)
		}
		cfg.MaxFrameBytes = value
	}
	if raw, ok := lookup("DUALLANE_TURN_TTL_SECONDS"); ok && strings.TrimSpace(raw) != "" {
		seconds, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil || seconds < 1 || seconds > int64((24*time.Hour)/time.Second) {
			return P2PConfig{}, errors.New("DUALLANE_TURN_TTL_SECONDS must be between 1 and 86400")
		}
		cfg.TURNTTL = time.Duration(seconds) * time.Second
	}

	if err := cfg.Validate(); err != nil {
		return P2PConfig{}, err
	}
	return cfg, nil
}

func (c P2PConfig) Validate() error {
	if strings.TrimSpace(c.Host) == "" {
		return errors.New("HOST must not be empty")
	}
	if c.Port < 1 || c.Port > 65535 {
		return errors.New("PORT must be between 1 and 65535")
	}
	if c.AppVersion == "" {
		return errors.New("APP_VERSION must not be empty")
	}
	if c.RoomTTL <= 0 || c.RoomTTL > MaxConfiguredRoomTTL {
		return errors.New("P2P room TTL is outside the supported range")
	}
	if c.EmptyRoomGrace < 0 || c.EmptyRoomGrace > MaxConfiguredGracePeriod {
		return errors.New("P2P empty-room grace is outside the supported range")
	}
	if c.MaxFrameBytes < 1024 || c.MaxFrameBytes > MaxConfiguredFrameBytes {
		return fmt.Errorf("P2P frame limit must be between 1024 and %d", MaxConfiguredFrameBytes)
	}
	if c.TURNTTL <= 0 || c.TURNTTL > 24*time.Hour {
		return errors.New("TURN credential TTL is outside the supported range")
	}
	if c.PublicBaseURL != "" {
		u, err := url.Parse(c.PublicBaseURL)
		if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("PUBLIC_BASE_URL must be an absolute origin without query, fragment, or user info")
		}
	}
	return nil
}

func (c P2PConfig) ListenAddress() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

func valueOr(lookup func(string) (string, bool), key, fallback string) string {
	value, ok := lookup(key)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

func parseBoundedMilliseconds(raw string, unit time.Duration, max time.Duration) (time.Duration, error) {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value < 0 {
		return 0, errors.New("must be a non-negative integer")
	}
	if value > int64(max/unit) {
		return 0, fmt.Errorf("must not exceed %d", max/unit)
	}
	return time.Duration(value) * unit, nil
}

func parseURLList(value string, fallback []string) []string {
	if strings.TrimSpace(value) == "" {
		return append([]string(nil), fallback...)
	}
	items := make([]string, 0, 2)
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			items = append(items, item)
		}
	}
	if len(items) == 0 {
		return append([]string(nil), fallback...)
	}
	return items
}
