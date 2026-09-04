package migrations

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeBeginner struct {
	tx  *fakeTx
	err error
}

func (b *fakeBeginner) Begin(context.Context) (Tx, error) {
	if b.err != nil {
		return nil, b.err
	}
	return b.tx, nil
}

type fakeTx struct {
	schemaColumns [][]any
	primaryKey    [][]any
	applied       [][]any
	execCalls     []fakeExec
	queryCalls    []string
	rollbackCalls int
	commitCalls   int
	failExecPart  string
	commitErr     error
}

type fakeExec struct {
	query string
	args  []any
}

func newFakeTx() *fakeTx {
	return &fakeTx{
		schemaColumns: [][]any{
			{"name", "text", "NO"},
			{"applied_at", "timestamp with time zone", "NO"},
		},
		primaryKey: [][]any{{"name"}},
	}
}

func (tx *fakeTx) Exec(_ context.Context, query string, args ...any) error {
	tx.execCalls = append(tx.execCalls, fakeExec{query: query, args: args})
	if tx.failExecPart != "" && strings.Contains(query, tx.failExecPart) {
		return errors.New("synthetic execution failure")
	}
	return nil
}

func (tx *fakeTx) Query(_ context.Context, query string, _ ...any) (Rows, error) {
	tx.queryCalls = append(tx.queryCalls, query)
	switch query {
	case columnsSQL:
		return &fakeRows{rows: tx.schemaColumns}, nil
	case primaryKeySQL:
		return &fakeRows{rows: tx.primaryKey}, nil
	case appliedSQL:
		return &fakeRows{rows: tx.applied}, nil
	default:
		return nil, fmt.Errorf("unexpected query %q", query)
	}
}

func (tx *fakeTx) Commit(context.Context) error {
	tx.commitCalls++
	return tx.commitErr
}

func (tx *fakeTx) Rollback(context.Context) error {
	tx.rollbackCalls++
	return nil
}

type fakeRows struct {
	rows    [][]any
	current []any
	index   int
}

func (rows *fakeRows) Next() bool {
	if rows.index >= len(rows.rows) {
		return false
	}
	rows.current = rows.rows[rows.index]
	rows.index++
	return true
}

func (rows *fakeRows) Scan(dest ...any) error {
	if len(dest) != len(rows.current) {
		return fmt.Errorf("Scan received %d destinations for %d values", len(dest), len(rows.current))
	}
	for index, value := range rows.current {
		target, ok := dest[index].(*string)
		if !ok {
			return fmt.Errorf("unsupported scan destination %T", dest[index])
		}
		typed, ok := value.(string)
		if !ok {
			return fmt.Errorf("unsupported fake row value %T", value)
		}
		*target = typed
	}
	return nil
}

func (rows *fakeRows) Err() error {
	return nil
}

func (rows *fakeRows) Close() {}

func writeMigrations(t *testing.T, names ...string) string {
	t.Helper()
	directory := t.TempDir()
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("SELECT "+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return directory
}

func TestRunnerAppliesPendingFilesInLexicalOrder(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	beginner := &fakeBeginner{tx: tx}
	timestamp := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	runner := Runner{
		Beginner:  beginner,
		Directory: writeMigrations(t, "002_second.sql", "001_first.sql"),
		Now:       func() time.Time { return timestamp },
	}

	result, err := runner.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Discovered != 2 || result.Applied != 2 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if want := []string{"001_first.sql", "002_second.sql"}; !equalStrings(result.AppliedNames, want) {
		t.Fatalf("applied names = %#v, want %#v", result.AppliedNames, want)
	}
	if tx.commitCalls != 1 || tx.rollbackCalls != 0 {
		t.Fatalf("commit=%d rollback=%d, want one commit and no rollback", tx.commitCalls, tx.rollbackCalls)
	}
	if len(tx.execCalls) != 6 {
		t.Fatalf("got %d Exec calls, want lock/table/2*(sql+record)", len(tx.execCalls))
	}
	if tx.execCalls[0].query != advisoryLockSQL || len(tx.execCalls[0].args) != 1 || tx.execCalls[0].args[0] != AdvisoryLockIdentity {
		t.Fatalf("unexpected advisory lock call: %#v", tx.execCalls[0])
	}
	if !strings.Contains(tx.execCalls[2].query, "001_first.sql") || !strings.Contains(tx.execCalls[4].query, "002_second.sql") {
		t.Fatalf("migrations were not executed in lexical order: %#v", tx.execCalls)
	}
	if tx.execCalls[3].query != insertSQL || tx.execCalls[5].query != insertSQL {
		t.Fatalf("migration records were not inserted after SQL: %#v", tx.execCalls)
	}
	if got, ok := tx.execCalls[3].args[1].(time.Time); !ok || !got.Equal(timestamp) {
		t.Fatalf("unexpected applied_at argument: %#v", tx.execCalls[4].args)
	}
}

func TestRunnerLeavesBatchRolledBackOnMigrationFailure(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.failExecPart = "002_second.sql"
	runner := Runner{
		Beginner:  &fakeBeginner{tx: tx},
		Directory: writeMigrations(t, "001_first.sql", "002_second.sql"),
	}

	result, err := runner.Run(context.Background())
	if err == nil {
		t.Fatal("Run succeeded despite migration failure")
	}
	if result.Applied != 1 {
		t.Fatalf("Applied = %d, want 1 before failed second statement", result.Applied)
	}
	if tx.commitCalls != 0 || tx.rollbackCalls != 1 {
		t.Fatalf("commit=%d rollback=%d, want no commit and one rollback", tx.commitCalls, tx.rollbackCalls)
	}
	for _, call := range tx.execCalls {
		if call.query == insertSQL && len(call.args) > 0 && call.args[0] == "002_second.sql" {
			t.Fatal("failed migration was recorded")
		}
	}
}

func TestRunnerRejectsRenamedAppliedMigration(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = [][]any{{"001_old_name.sql"}}
	runner := Runner{
		Beginner:  &fakeBeginner{tx: tx},
		Directory: writeMigrations(t, "001_new_name.sql"),
	}

	_, err := runner.Run(context.Background())
	if !errors.Is(err, ErrMigrationHistory) {
		t.Fatalf("error = %v, want ErrMigrationHistory", err)
	}
	if tx.commitCalls != 0 || tx.rollbackCalls != 1 {
		t.Fatalf("commit=%d rollback=%d, want no commit and one rollback", tx.commitCalls, tx.rollbackCalls)
	}
}

func TestRunnerRejectsHistoryGap(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = [][]any{{"002_second.sql"}}
	runner := Runner{
		Beginner:  &fakeBeginner{tx: tx},
		Directory: writeMigrations(t, "001_first.sql", "002_second.sql"),
	}

	_, err := runner.Run(context.Background())
	if !errors.Is(err, ErrMigrationHistory) {
		t.Fatalf("error = %v, want ErrMigrationHistory", err)
	}
}

func TestRunnerRejectsDuplicateAppliedNames(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = [][]any{{"001_first.sql"}, {"001_first.sql"}}
	runner := Runner{
		Beginner:  &fakeBeginner{tx: tx},
		Directory: writeMigrations(t, "001_first.sql"),
	}

	_, err := runner.Run(context.Background())
	if !errors.Is(err, ErrMigrationHistory) {
		t.Fatalf("error = %v, want ErrMigrationHistory", err)
	}
}

func TestRunnerRejectsUnsupportedSchema(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.schemaColumns = [][]any{{"name", "text", "NO"}}
	runner := Runner{
		Beginner:  &fakeBeginner{tx: tx},
		Directory: writeMigrations(t, "001_first.sql"),
	}

	_, err := runner.Run(context.Background())
	if !errors.Is(err, ErrUnsupportedSchema) {
		t.Fatalf("error = %v, want ErrUnsupportedSchema", err)
	}
}

func TestValidateHistoryRejectsNonCanonicalAndMissingNames(t *testing.T) {
	t.Parallel()
	files := []File{{Name: "001_first.sql"}, {Name: "002_second.sql"}}
	tests := []map[string]struct{}{
		{"not_canonical": {}},
		{"001_missing.sql": {}},
	}
	for _, applied := range tests {
		if err := validateHistory(files, applied); !errors.Is(err, ErrMigrationHistory) {
			t.Fatalf("validateHistory(%#v) = %v, want ErrMigrationHistory", applied, err)
		}
	}
}

func TestRunnerCanRecordAlreadyAppliedPrefixWithoutReapplying(t *testing.T) {
	t.Parallel()
	tx := newFakeTx()
	tx.applied = [][]any{{"001_first.sql"}}
	runner := Runner{
		Beginner:  &fakeBeginner{tx: tx},
		Directory: writeMigrations(t, "001_first.sql", "002_second.sql"),
	}

	result, err := runner.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied != 1 || len(result.AppliedNames) != 1 || result.AppliedNames[0] != "002_second.sql" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
