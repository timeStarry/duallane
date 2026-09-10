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

func TestSchemaCheckerRemainsStrictByDefaultForReviewed034(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = appendMigrationRows(canonicalReleaseCompatibilityBaseline[:], ReleaseCompatibilityMigrationName)

	report, err := (SchemaChecker{
		Queryer:       tx,
		RequiredNames: canonicalReleaseCompatibilityBaseline[:],
	}).Check(context.Background())
	if err == nil || !errors.Is(err, ErrUnknownMigrations) {
		t.Fatalf("error = %v, want strict unknown-migration rejection", err)
	}
	if report.UnknownCount != 1 || report.CompatibleCount != 0 {
		t.Fatalf("unexpected strict report: %#v", report)
	}
	if len(tx.execCalls) != 0 {
		t.Fatalf("schema check executed %d write statements", len(tx.execCalls))
	}
}

func TestSchemaCheckerAllowsOnlyReviewed034WithOptIn(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = appendMigrationRows(canonicalReleaseCompatibilityBaseline[:], ReleaseCompatibilityMigrationName)

	report, err := (SchemaChecker{
		Queryer:                   tx,
		RequiredNames:             canonicalReleaseCompatibilityBaseline[:],
		AllowReleaseCompatibility: true,
	}).Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.UnknownCount != 0 || report.CompatibleCount != 1 || !equalStrings(report.CompatibleNames, []string{ReleaseCompatibilityMigrationName}) {
		t.Fatalf("unexpected opt-in report: %#v", report)
	}
	if len(tx.execCalls) != 0 {
		t.Fatalf("schema check executed %d write statements", len(tx.execCalls))
	}
	if !equalStrings(tx.queryCalls, []string{columnsSQL, primaryKeySQL, appliedSQL, compatibleMigrationColumnsSQL}) {
		t.Fatalf("queries = %#v, want fixed read-only metadata queries", tx.queryCalls)
	}
}

func TestSchemaCheckerOptInKeepsCleanBaselineValidWithout034(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = appendMigrationRows(canonicalReleaseCompatibilityBaseline[:])

	report, err := (SchemaChecker{
		Queryer:                   tx,
		RequiredNames:             canonicalReleaseCompatibilityBaseline[:],
		AllowReleaseCompatibility: true,
	}).Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.UnknownCount != 0 || report.CompatibleCount != 0 || len(report.MissingNames) != 0 {
		t.Fatalf("unexpected clean-baseline report: %#v", report)
	}
	if !equalStrings(tx.queryCalls, []string{columnsSQL, primaryKeySQL, appliedSQL}) {
		t.Fatalf("queries = %#v, want baseline metadata queries only", tx.queryCalls)
	}
}

func TestSchemaCheckerKeeps034RequiredWhenCanonicalSetIncludesIt(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	required := append(append([]string(nil), canonicalReleaseCompatibilityBaseline[:]...), ReleaseCompatibilityMigrationName)
	tx.applied = appendMigrationRows(canonicalReleaseCompatibilityBaseline[:])

	report, err := (SchemaChecker{
		Queryer:                   tx,
		RequiredNames:             required,
		AllowReleaseCompatibility: true,
	}).Check(context.Background())
	if err == nil || !errors.Is(err, ErrMissingMigrations) {
		t.Fatalf("error = %v, want missing required 034", err)
	}
	if !equalStrings(report.MissingNames, []string{ReleaseCompatibilityMigrationName}) || report.CompatibleCount != 0 || report.UnknownCount != 0 {
		t.Fatalf("unexpected required-034 report: %#v", report)
	}
}

func TestSchemaCheckerRejectsFutureOrRenamedCompatibleHistory(t *testing.T) {
	t.Parallel()
	tests := []string{
		"035_future_workspace_change.sql",
		"034_workspace_chat_auto_hide_renamed.sql",
	}
	for _, name := range tests {
		name := name
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			tx := newFakeTx()
			tx.applied = appendMigrationRows(canonicalReleaseCompatibilityBaseline[:], name)
			report, err := (SchemaChecker{
				Queryer:                   tx,
				RequiredNames:             canonicalReleaseCompatibilityBaseline[:],
				AllowReleaseCompatibility: true,
			}).Check(context.Background())
			if err == nil || !errors.Is(err, ErrUnknownMigrations) {
				t.Fatalf("error = %v, want unknown migration rejection", err)
			}
			if report.UnknownCount != 1 || report.CompatibleCount != 0 || !equalStrings(report.UnknownNames, []string{name}) {
				t.Fatalf("unexpected report: %#v", report)
			}
		})
	}
}

func TestSchemaCheckerRejectsApplied034WithIncompatibleColumns(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = appendMigrationRows(canonicalReleaseCompatibilityBaseline[:], ReleaseCompatibilityMigrationName)
	tx.compatibleColumns[1][3] = "true"

	_, err := (SchemaChecker{
		Queryer:                   tx,
		RequiredNames:             canonicalReleaseCompatibilityBaseline[:],
		AllowReleaseCompatibility: true,
	}).Check(context.Background())
	if err == nil || !errors.Is(err, ErrCompatibleMigrationSchema) || !errors.Is(err, ErrSchemaCompatibility) {
		t.Fatalf("error = %v, want incompatible compatible-migration schema", err)
	}
	if len(tx.execCalls) != 0 {
		t.Fatalf("schema check executed %d write statements", len(tx.execCalls))
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

func appendMigrationRows(names []string, extra ...string) [][]any {
	rows := make([][]any, 0, len(names)+len(extra))
	for _, name := range names {
		rows = append(rows, []any{name})
	}
	for _, name := range extra {
		rows = append(rows, []any{name})
	}
	return rows
}

type errorQueryer struct {
	err error
}

func (q errorQueryer) Query(context.Context, string, ...any) (Rows, error) {
	return nil, q.err
}
