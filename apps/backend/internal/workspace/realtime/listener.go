package realtime

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	EventNotificationChannel = "duallane_workspace_events"
	defaultReconnectMinimum  = 100 * time.Millisecond
	defaultReconnectMaximum  = 5 * time.Second
)

type ListenerOptions struct {
	Pool             *pgxpool.Pool
	Hub              *Hub
	Logger           *slog.Logger
	ReconnectMinimum time.Duration
	ReconnectMaximum time.Duration
}

// PGListener turns LISTEN/NOTIFY messages into content-free wake-up hints. It
// reconnects independently of request serving; socket polling still recovers
// committed events while this listener or a notification is unavailable.
type PGListener struct {
	pool             *pgxpool.Pool
	hub              *Hub
	logger           *slog.Logger
	reconnectMinimum time.Duration
	reconnectMaximum time.Duration
}

func NewPGListener(options ListenerOptions) *PGListener {
	minimum := options.ReconnectMinimum
	if minimum <= 0 {
		minimum = defaultReconnectMinimum
	}
	maximum := options.ReconnectMaximum
	if maximum <= 0 {
		maximum = defaultReconnectMaximum
	}
	if maximum < minimum {
		maximum = minimum
	}
	return &PGListener{
		pool: options.Pool, hub: options.Hub, logger: options.Logger,
		reconnectMinimum: minimum, reconnectMaximum: maximum,
	}
}

func (l *PGListener) Run(ctx context.Context) error {
	if l == nil || l.pool == nil || l.hub == nil {
		return errors.New("workspace event listener dependencies are required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	backoff := l.reconnectMinimum
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		err := l.listen(ctx)
		if err == nil || ctx.Err() != nil {
			return nil
		}
		if l.logger != nil {
			l.logger.Warn("workspace event listener reconnecting", slog.String("error_code", "listener_unavailable"))
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		backoff *= 2
		if backoff > l.reconnectMaximum {
			backoff = l.reconnectMaximum
		}
	}
}

func (l *PGListener) listen(ctx context.Context) error {
	connection, err := l.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, "LISTEN "+EventNotificationChannel); err != nil {
		return err
	}
	// Close the startup race between the last poll and successful LISTEN.
	l.hub.Notify()
	for {
		if _, err := connection.Conn().WaitForNotification(ctx); err != nil {
			return err
		}
		l.hub.Notify()
	}
}
