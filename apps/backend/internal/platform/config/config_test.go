package config

import (
	"testing"
	"time"
)

func TestLoadDefaultsAndBuildMetadata(t *testing.T) {
	cfg, err := LoadFrom(func(key string) (string, bool) {
		values := map[string]string{
			"DUALLANE_APP_VERSION": "0.15.5-go",
			"DUALLANE_GIT_COMMIT":  "abc123",
		}
		value, ok := values[key]
		return value, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AppVersion != "0.15.5-go" || cfg.Commit != "abc123" {
		t.Fatalf("build metadata = %#v", cfg)
	}
	if cfg.RoomTTL != DefaultRoomTTL || cfg.EmptyRoomGrace != DefaultEmptyRoomGrace || cfg.MaxFrameBytes != DefaultMaxFrameBytes {
		t.Fatalf("defaults = %#v", cfg)
	}
	if len(cfg.STUNURLs) != 1 || cfg.STUNURLs[0] != DefaultSTUNURL {
		t.Fatalf("stun defaults = %#v", cfg.STUNURLs)
	}
}

func TestLoadParsesP2POverridesAndExactOrigin(t *testing.T) {
	values := map[string]string{
		"HOST":                         "127.0.0.1",
		"PORT":                         "9000",
		"PUBLIC_BASE_URL":              "https://duallane.example",
		"DUALLANE_APP_VERSION":         "v1",
		"DUALLANE_P2P_ROOM_TTL_MS":     "3600000",
		"DUALLANE_EMPTY_ROOM_GRACE_MS": "0",
		"DUALLANE_P2P_MAX_FRAME_BYTES": "65536",
		"DUALLANE_TURN_TTL_SECONDS":    "600",
		"DUALLANE_TURN_URLS":           "turn:one, turns:two",
	}
	cfg, err := LoadFrom(func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddress() != "127.0.0.1:9000" || cfg.RoomTTL != time.Hour || cfg.EmptyRoomGrace != 0 || cfg.MaxFrameBytes != 65536 {
		t.Fatalf("overrides = %#v", cfg)
	}
	if len(cfg.TURNURLs) != 2 || cfg.TURNURLs[1] != "turns:two" {
		t.Fatalf("turn urls = %#v", cfg.TURNURLs)
	}
}

func TestLoadRejectsUnsafeConfiguration(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"bad port":   {"PORT": "0"},
		"bad origin": {"PUBLIC_BASE_URL": "https://user:secret@example"},
		"bad frame":  {"DUALLANE_P2P_MAX_FRAME_BYTES": "512"},
		"bad ttl":    {"DUALLANE_P2P_ROOM_TTL_MS": "-1"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := LoadFrom(func(key string) (string, bool) {
				value, ok := values[key]
				return value, ok
			})
			if err == nil {
				t.Fatal("LoadFrom() accepted invalid configuration")
			}
		})
	}
}

func TestP2PTurnTTLConfigurationTransition(t *testing.T) {
	for _, test := range []struct {
		name    string
		raw     string
		present bool
		want    time.Duration
	}{
		{name: "unset", want: 600 * time.Second},
		{name: "blank", raw: "  ", present: true, want: 600 * time.Second},
		{name: "minimum", raw: "1", present: true, want: time.Second},
		{name: "maximum", raw: "86400", present: true, want: 24 * time.Hour},
		{name: "zero", raw: "0", present: true},
		{name: "negative", raw: "-1", present: true},
		{name: "malformed", raw: "invalid", present: true},
		{name: "fraction", raw: "1.5", present: true},
		{name: "over maximum", raw: "86401", present: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := LoadFrom(func(key string) (string, bool) {
				if key == "DUALLANE_TURN_TTL_SECONDS" {
					return test.raw, test.present
				}
				return "", false
			})
			if test.want == 0 {
				if err == nil {
					t.Fatal("invalid configured TTL silently fell back")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.TURNTTL != test.want {
				t.Fatalf("TTL = %v, want %v", cfg.TURNTTL, test.want)
			}
		})
	}
}
