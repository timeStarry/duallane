package postgres

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
)

// Open opens and verifies one native pgx connection for the one-shot migration
// command. A single connection is enough because Runner serializes one
// transaction at a time and avoids an extra pool for a short-lived process.
func Open(ctx context.Context, dsn string) (*pgx.Conn, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, errors.New("DATABASE_URL or PGHOST is required")
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("open PostgreSQL connection: %w", err)
	}
	return conn, nil
}

// OpenFromEnv preserves the current DATABASE_URL and PG* connection settings.
// The caller owns the returned connection and must close it.
func OpenFromEnv(ctx context.Context) (*pgx.Conn, error) {
	dsn, err := ResolveDSN(os.LookupEnv)
	if err != nil {
		return nil, err
	}
	return Open(ctx, dsn)
}

// NewMigrationBeginner adapts one native pgx connection to the runner's
// driver-neutral transaction surface.
func NewMigrationBeginner(conn *pgx.Conn) migrations.Beginner {
	return pgxBeginner{conn: conn}
}

type pgxBeginner struct {
	conn *pgx.Conn
}

func (b pgxBeginner) Begin(ctx context.Context) (migrations.Tx, error) {
	if b.conn == nil {
		return nil, errors.New("PostgreSQL connection is required")
	}
	tx, err := b.conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return pgxTx{tx: tx}, nil
}

type pgxTx struct {
	tx pgx.Tx
}

func (t pgxTx) Exec(ctx context.Context, query string, args ...any) error {
	_, err := t.tx.Exec(ctx, query, args...)
	return err
}

func (t pgxTx) Query(ctx context.Context, query string, args ...any) (migrations.Rows, error) {
	rows, err := t.tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return pgxRows{rows: rows}, nil
}

func (t pgxTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t pgxTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

type pgxRows struct {
	rows pgx.Rows
}

func (r pgxRows) Next() bool {
	return r.rows.Next()
}

func (r pgxRows) Scan(dest ...any) error {
	return r.rows.Scan(dest...)
}

func (r pgxRows) Err() error {
	return r.rows.Err()
}

func (r pgxRows) Close() {
	r.rows.Close()
}

// ResolveDSN returns DATABASE_URL when present, otherwise constructs a
// PostgreSQL URL from the libpq-compatible PG* settings. lookup is injectable
// so configuration tests do not mutate process-wide environment variables.
func ResolveDSN(lookup func(string) (string, bool)) (string, error) {
	if lookup == nil {
		return "", errors.New("environment lookup is required")
	}
	if dsn, ok := lookup("DATABASE_URL"); ok && strings.TrimSpace(dsn) != "" {
		return strings.TrimSpace(dsn), nil
	}

	host := strings.TrimSpace(value(lookup, "PGHOST"))
	if host == "" {
		return "", errors.New("DATABASE_URL or PGHOST is required")
	}
	port := strings.TrimSpace(value(lookup, "PGPORT"))
	if port == "" {
		port = "5432"
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", errors.New("PGPORT must be between 1 and 65535")
	}

	database := strings.TrimSpace(value(lookup, "PGDATABASE"))
	if strings.ContainsAny(database, "/\r\n") {
		return "", errors.New("PGDATABASE contains unsupported characters")
	}
	user := rawValue(lookup, "PGUSER")
	password := rawValue(lookup, "PGPASSWORD")

	connectionURL := url.URL{Scheme: "postgres"}
	query := connectionURL.Query()
	if strings.HasPrefix(host, "/") {
		// libpq accepts a Unix socket directory in host. Keep it a query
		// value because it is not a TCP hostname.
		query.Set("host", host)
	} else {
		connectionURL.Host = net.JoinHostPort(host, port)
	}
	if database != "" {
		connectionURL.Path = "/" + database
	}
	if user != "" {
		if password == "" {
			connectionURL.User = url.User(user)
		} else {
			connectionURL.User = url.UserPassword(user, password)
		}
	}
	query.Set("sslmode", sslMode(lookup))
	connectionURL.RawQuery = query.Encode()
	return connectionURL.String(), nil
}

func value(lookup func(string) (string, bool), key string) string {
	raw, _ := lookup(key)
	return strings.TrimSpace(raw)
}

func rawValue(lookup func(string) (string, bool), key string) string {
	raw, _ := lookup(key)
	return raw
}

func sslMode(lookup func(string) (string, bool)) string {
	if mode := value(lookup, "PGSSLMODE"); mode != "" {
		return mode
	}
	if strings.EqualFold(value(lookup, "DATABASE_SSL"), "true") {
		if strings.EqualFold(value(lookup, "DATABASE_SSL_REJECT_UNAUTHORIZED"), "false") {
			return "require"
		}
		return "verify-full"
	}
	return "disable"
}
