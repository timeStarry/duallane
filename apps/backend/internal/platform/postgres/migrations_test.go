package postgres

import (
	"context"
	"net/url"
	"testing"
)

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestResolveDSNPrefersDatabaseURL(t *testing.T) {
	t.Parallel()
	got, err := ResolveDSN(lookup(map[string]string{
		"DATABASE_URL": " postgres://user:pass@example.test/db ",
		"PGHOST":       "ignored.example.test",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if got != "postgres://user:pass@example.test/db" {
		t.Fatalf("ResolveDSN() = %q", got)
	}
}

func TestResolveDSNBuildsFromPGEnvironment(t *testing.T) {
	t.Parallel()
	got, err := ResolveDSN(lookup(map[string]string{
		"PGHOST":                           "db.example.test",
		"PGPORT":                           "5433",
		"PGDATABASE":                       "duallane",
		"PGUSER":                           "worker",
		"PGPASSWORD":                       "secret@value",
		"DATABASE_SSL":                     "true",
		"DATABASE_SSL_REJECT_UNAUTHORIZED": "false",
	}))
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "postgres" || parsed.Host != "db.example.test:5433" || parsed.Path != "/duallane" {
		t.Fatalf("unexpected connection URL: %q", got)
	}
	if parsed.User.Username() != "worker" {
		t.Fatalf("unexpected username: %q", parsed.User.Username())
	}
	password, _ := parsed.User.Password()
	if password != "secret@value" {
		t.Fatalf("unexpected password: %q", password)
	}
	if parsed.Query().Get("sslmode") != "require" {
		t.Fatalf("unexpected sslmode: %q", parsed.Query().Get("sslmode"))
	}
}

func TestResolveDSNRejectsMissingOrInvalidHostSettings(t *testing.T) {
	t.Parallel()
	if _, err := ResolveDSN(lookup(nil)); err == nil {
		t.Fatal("ResolveDSN succeeded without connection settings")
	}
	if _, err := ResolveDSN(lookup(map[string]string{"PGHOST": "db", "PGPORT": "0"})); err == nil {
		t.Fatal("ResolveDSN accepted an invalid port")
	}
}

func TestNewMigrationBeginnerRejectsNilConnection(t *testing.T) {
	t.Parallel()
	beginner := NewMigrationBeginner(nil)
	if _, err := beginner.Begin(context.Background()); err == nil {
		t.Fatal("nil PostgreSQL connection was accepted")
	}
}
