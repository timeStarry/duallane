package postgres

import (
	"testing"
	"time"
)

func TestPoolConfigAppliesBoundedOperationalDefaults(t *testing.T) {
	config, err := PoolConfig("postgres://user:password@db.example/duallane", PoolOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if config.MaxConns != DefaultPoolMaxConnections || config.MinConns != 0 {
		t.Fatalf("connection limits = max:%d min:%d", config.MaxConns, config.MinConns)
	}
	if config.MaxConnLifetime != 30*time.Minute || config.MaxConnIdleTime != 5*time.Minute || config.HealthCheckPeriod != 30*time.Second {
		t.Fatalf("pool lifecycle = lifetime:%s idle:%s health:%s", config.MaxConnLifetime, config.MaxConnIdleTime, config.HealthCheckPeriod)
	}
}

func TestPoolConfigHonorsExplicitMaximum(t *testing.T) {
	config, err := PoolConfig("postgres://db.example/duallane", PoolOptions{MaxConnections: 2})
	if err != nil {
		t.Fatal(err)
	}
	if config.MaxConns != 2 {
		t.Fatalf("MaxConns = %d, want 2", config.MaxConns)
	}
}

func TestResolvePoolMaxDefaultsAndRejectsUnsafeValues(t *testing.T) {
	value, err := ResolvePoolMax(lookup(nil))
	if err != nil || value != DefaultPoolMaxConnections {
		t.Fatalf("default = %d, %v", value, err)
	}
	value, err = ResolvePoolMax(lookup(map[string]string{"DATABASE_POOL_MAX": " 17 "}))
	if err != nil || value != 17 {
		t.Fatalf("configured = %d, %v", value, err)
	}
	for _, raw := range []string{"0", "101", "1.5", "invalid"} {
		if _, err := ResolvePoolMax(lookup(map[string]string{"DATABASE_POOL_MAX": raw})); err == nil {
			t.Fatalf("accepted DATABASE_POOL_MAX=%q", raw)
		}
	}
}
