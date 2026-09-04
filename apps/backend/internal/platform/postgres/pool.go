package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	DefaultPoolMaxConnections int32 = 10
	MaximumPoolConnections    int32 = 100
	DefaultPoolMaxLifetime          = 30 * time.Minute
	DefaultPoolMaxIdleTime          = 5 * time.Minute
	DefaultPoolHealthCheck          = 30 * time.Second
)

// PoolOptions contains only process-local resource limits. Connection
// credentials remain in the DSN and must never be logged by callers.
type PoolOptions struct {
	MaxConnections int32
}

func PoolConfig(dsn string, options PoolOptions) (*pgxpool.Config, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, errors.New("DATABASE_URL or PGHOST is required")
	}
	maxConnections := options.MaxConnections
	if maxConnections == 0 {
		maxConnections = DefaultPoolMaxConnections
	}
	if maxConnections < 1 || maxConnections > MaximumPoolConnections {
		return nil, fmt.Errorf("DATABASE_POOL_MAX must be between 1 and %d", MaximumPoolConnections)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse PostgreSQL pool configuration: %w", err)
	}
	config.MaxConns = maxConnections
	config.MinConns = 0
	config.MaxConnLifetime = DefaultPoolMaxLifetime
	config.MaxConnIdleTime = DefaultPoolMaxIdleTime
	config.HealthCheckPeriod = DefaultPoolHealthCheck
	return config, nil
}

// OpenPool creates and verifies a bounded native pgx pool. The caller owns the
// pool and must close it during graceful shutdown.
func OpenPool(ctx context.Context, dsn string, options PoolOptions) (*pgxpool.Pool, error) {
	config, err := PoolConfig(dsn, options)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open PostgreSQL pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("verify PostgreSQL pool: %w", err)
	}
	return pool, nil
}

func OpenPoolFromEnv(ctx context.Context) (*pgxpool.Pool, error) {
	dsn, err := ResolveDSN(os.LookupEnv)
	if err != nil {
		return nil, err
	}
	maxConnections, err := ResolvePoolMax(os.LookupEnv)
	if err != nil {
		return nil, err
	}
	return OpenPool(ctx, dsn, PoolOptions{MaxConnections: maxConnections})
}

func ResolvePoolMax(lookup func(string) (string, bool)) (int32, error) {
	if lookup == nil {
		return 0, errors.New("environment lookup is required")
	}
	raw, ok := lookup("DATABASE_POOL_MAX")
	if !ok || strings.TrimSpace(raw) == "" {
		return DefaultPoolMaxConnections, nil
	}
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 32)
	if err != nil || value < 1 || value > int64(MaximumPoolConnections) {
		return 0, fmt.Errorf("DATABASE_POOL_MAX must be between 1 and %d", MaximumPoolConnections)
	}
	return int32(value), nil
}
