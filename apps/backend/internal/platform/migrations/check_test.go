package migrations

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSchemaCheckerReadsCompatibleHistoryWithoutWrites(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = [][]any{{"001_first.sql"}, {"002_second.sql"}}

	report, err := (SchemaChecker{
		Queryer:       tx,
		RequiredNames: []string{"002_second.sql", "001_first.sql"},
	}).Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.AppliedCount != 2 || len(report.MissingNames) != 0 || report.UnknownCount != 0 {
		t.Fatalf("unexpected compatibility report: %#v", report)
	}
	if len(tx.execCalls) != 0 {
		t.Fatalf("schema check executed %d write statements", len(tx.execCalls))
	}
	wantQueries := []string{columnsSQL, primaryKeySQL, appliedSQL}
	if !equalStrings(tx.queryCalls, wantQueries) {
		t.Fatalf("schema check queries = %#v, want fixed metadata SELECTs", tx.queryCalls)
	}
}

func TestSchemaCheckerDerivesRequiredNamesFromCanonicalDirectory(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = [][]any{{"001_first.sql"}, {"002_second.sql"}}

	report, err := (SchemaChecker{
		Queryer:   tx,
		Directory: writeMigrations(t, "002_second.sql", "001_first.sql"),
	}).Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !equalStrings(report.RequiredNames, []string{"001_first.sql", "002_second.sql"}) {
		t.Fatalf("required names = %#v", report.RequiredNames)
	}
}

func TestSchemaCheckerReportsMissingAndUnknownHistoryWithoutUnsafeNames(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = [][]any{{"001_first.sql"}, {"999_future.sql"}, {"SELECT secret FROM credentials"}}

	report, err := (SchemaChecker{
		Queryer:       tx,
		RequiredNames: []string{"001_first.sql", "002_second.sql"},
	}).Check(context.Background())
	if err == nil || !errors.Is(err, ErrMissingMigrations) || !errors.Is(err, ErrUnknownMigrations) || !errors.Is(err, ErrMigrationHistory) {
		t.Fatalf("error = %v, want missing and unknown history errors", err)
	}
	if !equalStrings(report.MissingNames, []string{"002_second.sql"}) {
		t.Fatalf("missing names = %#v", report.MissingNames)
	}
	if report.UnknownCount != 2 || !equalStrings(report.UnknownNames, []string{"999_future.sql"}) {
		t.Fatalf("unknown report = %#v", report)
	}
	if strings.Contains(err.Error(), "credentials") || strings.Contains(err.Error(), "SELECT") {
		t.Fatalf("unsafe history detail leaked in error: %v", err)
	}
	if len(tx.execCalls) != 0 {
		t.Fatalf("schema check executed %d write statements", len(tx.execCalls))
	}
}

func TestSchemaCheckerRejectsUnsupportedSchemaWithoutWrites(t *testing.T) {
	t.Parallel()
	tests := map[string]func(*fakeTx){
		"wrong columns": func(tx *fakeTx) {
			tx.schemaColumns = [][]any{{"name", "text", "NO"}}
		},
		"wrong primary key": func(tx *fakeTx) {
			tx.primaryKey = [][]any{{"applied_at"}}
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			tx := newFakeTx()
			mutate(tx)
			_, err := (SchemaChecker{
				Queryer:       tx,
				RequiredNames: []string{"001_first.sql"},
			}).Check(context.Background())
			if err == nil || !errors.Is(err, ErrUnsupportedSchema) || !errors.Is(err, ErrSchemaCompatibility) {
				t.Fatalf("error = %v, want unsupported schema", err)
			}
			if len(tx.execCalls) != 0 {
				t.Fatalf("schema check executed %d write statements", len(tx.execCalls))
			}
		})
	}
}

func TestSchemaCheckerSuppressesQueryErrors(t *testing.T) {
	t.Parallel()
	queryer := errorQueryer{err: errors.New("postgres://secret@example.test/db SELECT secret")}
	_, err := (SchemaChecker{
		Queryer:       queryer,
		RequiredNames: []string{"001_first.sql"},
	}).Check(context.Background())
	if err == nil || !errors.Is(err, ErrSchemaCompatibility) {
		t.Fatalf("error = %v, want schema compatibility error", err)
	}
	if strings.Contains(err.Error(), "postgres://") || strings.Contains(err.Error(), "SELECT secret") {
		t.Fatalf("database error leaked: %v", err)
	}
}

type errorQueryer struct {
	err error
}

func (q errorQueryer) Query(context.Context, string, ...any) (Rows, error) {
	return nil, q.err
}
