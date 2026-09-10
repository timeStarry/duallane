package migrations

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Queryer is the minimal query surface required by SchemaChecker. Query itself
// accepts an arbitrary SQL string, so this interface is not a technical
// read-only or SQL-safety boundary. SchemaChecker restricts its own calls to
// the fixed metadata SELECTs below; a PostgreSQL adapter can additionally
// enforce a database read-only transaction around each call.
type Queryer interface {
	Query(ctx context.Context, query string, args ...any) (Rows, error)
}

var (
	ErrSchemaCompatibility       = errors.New("schema compatibility check failed")
	ErrMissingMigrations         = errors.New("required migrations are missing")
	ErrUnknownMigrations         = errors.New("applied migrations are unknown")
	ErrCompatibleMigrationSchema = errors.New("compatible migration schema is incompatible")
)

// SchemaChecker verifies the schema_migrations contract without changing the
// database. Set Directory to derive the required names from the canonical
// migration directory, or set RequiredNames in a caller that already owns the
// discovered canonical set. The two sources cannot be mixed.
type SchemaChecker struct {
	Queryer                   Queryer
	Directory                 string
	RequiredNames             []string
	AllowReleaseCompatibility bool
}

type CompatibilityReport struct {
	RequiredNames   []string
	AppliedCount    int
	MissingNames    []string
	UnknownNames    []string
	UnknownCount    int
	CompatibleNames []string
	CompatibleCount int
}

// Check issues only the fixed schema metadata SELECTs used by the current
// runner, then compares the returned history with the canonical migration
// names. It does not acquire the migration advisory lock because no mutation
// or migration batch is performed during a long-running process readiness
// check. Queryer implementations must provide any database-level read-only
// transaction guarantee; the interface alone cannot prevent arbitrary SQL.
func (c SchemaChecker) Check(ctx context.Context) (CompatibilityReport, error) {
	var report CompatibilityReport
	if ctx == nil {
		return report, fmt.Errorf("%w: context is required", ErrSchemaCompatibility)
	}
	if c.Queryer == nil {
		return report, fmt.Errorf("%w: database queryer is required", ErrSchemaCompatibility)
	}

	required, err := c.requiredNames()
	if err != nil {
		return report, err
	}
	report.RequiredNames = required
	var policy CompatibilityPolicy
	if c.AllowReleaseCompatibility {
		policy, err = EmbeddedReleaseCompatibilityPolicy()
		if err != nil {
			return report, errors.Join(ErrSchemaCompatibility, err)
		}
	}

	if err := inspectSchemaMigrations(ctx, c.Queryer); err != nil {
		return report, err
	}
	applied, err := readAppliedReadOnly(ctx, c.Queryer)
	if err != nil {
		return report, err
	}
	report.AppliedCount = len(applied)

	requiredSet := make(map[string]struct{}, len(required))
	for _, name := range required {
		requiredSet[name] = struct{}{}
	}
	appliedSet := make(map[string]struct{}, len(applied))
	compatibilityBaseline := c.AllowReleaseCompatibility && isCanonicalReleaseCompatibilityBaseline(required)
	var compatibleApplied []string
	for _, name := range applied {
		appliedSet[name] = struct{}{}
		if _, ok := requiredSet[name]; ok {
			if c.AllowReleaseCompatibility && policy.allows(name) {
				compatibleApplied = append(compatibleApplied, name)
			}
			continue
		}
		if compatibilityBaseline && policy.allows(name) {
			report.CompatibleCount++
			report.CompatibleNames = append(report.CompatibleNames, name)
			compatibleApplied = append(compatibleApplied, name)
			continue
		}
		report.UnknownCount++
		// Unknown values may have been written by a damaged or hostile caller.
		// Only canonical names are safe to return as diagnostic detail.
		if IsCanonicalName(name) {
			report.UnknownNames = append(report.UnknownNames, name)
		}
	}
	for _, name := range required {
		if _, ok := appliedSet[name]; !ok {
			report.MissingNames = append(report.MissingNames, name)
		}
	}
	sort.Strings(report.UnknownNames)
	sort.Strings(report.CompatibleNames)
	if len(compatibleApplied) > 0 {
		if err := inspectCompatibleMigrationSchema(ctx, c.Queryer, compatibleApplied); err != nil {
			return report, err
		}
	}

	var issues []error
	if len(report.MissingNames) > 0 {
		issues = append(issues, fmt.Errorf("%w: %d required migration(s) are not applied", ErrMissingMigrations, len(report.MissingNames)))
	}
	if report.UnknownCount > 0 {
		issues = append(issues, fmt.Errorf("%w: %d applied migration(s) are not in the canonical set", ErrUnknownMigrations, report.UnknownCount))
	}
	if len(issues) > 0 {
		issues = append([]error{ErrSchemaCompatibility, ErrMigrationHistory}, issues...)
		return report, errors.Join(issues...)
	}
	return report, nil
}

const compatibleMigrationColumnsSQL = `SELECT column_name, data_type, is_nullable, COALESCE(column_default, '')
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'workspace_emote_preferences'
  AND column_name IN ('auto_hide_messages', 'auto_hide_message_types_json')
ORDER BY column_name`

type compatibleSchemaColumn struct {
	Name     string
	DataType string
	Nullable string
	Default  string
}

func inspectCompatibleMigrationSchema(ctx context.Context, queryer Queryer, applied []string) error {
	allowed := map[string]struct{}{
		ReleaseCompatibilityMigrationName: {},
	}
	for _, name := range applied {
		if _, ok := allowed[name]; !ok {
			return errors.Join(ErrSchemaCompatibility, ErrCompatibleMigrationSchema)
		}
	}

	var columns []compatibleSchemaColumn
	err := readCompatibilityRows(ctx, queryer, compatibleMigrationColumnsSQL, "compatible migration columns", func(rows Rows) error {
		for rows.Next() {
			var column compatibleSchemaColumn
			if err := rows.Scan(&column.Name, &column.DataType, &column.Nullable, &column.Default); err != nil {
				return err
			}
			columns = append(columns, column)
		}
		return nil
	})
	if err != nil {
		return err
	}

	expected := map[string]compatibleSchemaColumn{
		"auto_hide_messages": {
			Name:     "auto_hide_messages",
			DataType: "boolean",
			Nullable: "NO",
			Default:  "false",
		},
		"auto_hide_message_types_json": {
			Name:     "auto_hide_message_types_json",
			DataType: "text",
			Nullable: "NO",
			Default:  `'["image","emote","long"]'::text`,
		},
	}
	if len(columns) != len(expected) {
		return errors.Join(ErrSchemaCompatibility, ErrCompatibleMigrationSchema)
	}
	for _, actual := range columns {
		want, ok := expected[actual.Name]
		if !ok || actual.DataType != want.DataType || !strings.EqualFold(actual.Nullable, want.Nullable) || normalizeColumnDefault(actual.Default) != normalizeColumnDefault(want.Default) {
			return errors.Join(ErrSchemaCompatibility, ErrCompatibleMigrationSchema)
		}
		delete(expected, actual.Name)
	}
	if len(expected) != 0 {
		return errors.Join(ErrSchemaCompatibility, ErrCompatibleMigrationSchema)
	}
	return nil
}

func normalizeColumnDefault(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
}

func (c SchemaChecker) requiredNames() ([]string, error) {
	if c.Directory != "" && len(c.RequiredNames) > 0 {
		return nil, fmt.Errorf("%w: set either migration directory or required names", ErrSchemaCompatibility)
	}

	var names []string
	if c.Directory != "" {
		files, err := Discover(c.Directory)
		if err != nil {
			return nil, fmt.Errorf("%w: canonical migration set is unavailable", ErrSchemaCompatibility)
		}
		names = make([]string, 0, len(files))
		for _, file := range files {
			names = append(names, file.Name)
		}
	} else {
		names = append([]string(nil), c.RequiredNames...)
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("%w: canonical migration set is empty", ErrSchemaCompatibility)
	}

	sort.Strings(names)
	for index, name := range names {
		if !IsCanonicalName(name) {
			return nil, fmt.Errorf("%w: required migration set contains an unsupported name", ErrSchemaCompatibility)
		}
		if index > 0 && names[index-1] == name {
			return nil, fmt.Errorf("%w: required migration set contains duplicates", ErrSchemaCompatibility)
		}
	}
	return names, nil
}

func inspectSchemaMigrations(ctx context.Context, queryer Queryer) error {
	var columns []schemaColumn
	err := readCompatibilityRows(ctx, queryer, columnsSQL, "schema_migrations columns", func(rows Rows) error {
		for rows.Next() {
			var column schemaColumn
			if err := rows.Scan(&column.Name, &column.DataType, &column.Nullable); err != nil {
				return err
			}
			columns = append(columns, column)
		}
		return nil
	})
	if err != nil {
		return err
	}
	expectedColumns := []schemaColumn{
		{Name: "name", DataType: "text", Nullable: "NO"},
		{Name: "applied_at", DataType: "timestamp with time zone", Nullable: "NO"},
	}
	if len(columns) != len(expectedColumns) {
		return unsupportedSchemaError()
	}
	for index, expected := range expectedColumns {
		actual := columns[index]
		if actual.Name != expected.Name || actual.DataType != expected.DataType || !strings.EqualFold(actual.Nullable, expected.Nullable) {
			return unsupportedSchemaError()
		}
	}

	var primaryKeyColumns []string
	err = readCompatibilityRows(ctx, queryer, primaryKeySQL, "schema_migrations primary key", func(rows Rows) error {
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return err
			}
			primaryKeyColumns = append(primaryKeyColumns, name)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(primaryKeyColumns) != 1 || primaryKeyColumns[0] != "name" {
		return unsupportedSchemaError()
	}
	return nil
}

func readAppliedReadOnly(ctx context.Context, queryer Queryer) ([]string, error) {
	var names []string
	seen := make(map[string]struct{})
	err := readCompatibilityRows(ctx, queryer, appliedSQL, "schema_migrations history", func(rows Rows) error {
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return err
			}
			if _, exists := seen[name]; exists {
				return errDuplicateAppliedMigration
			}
			seen[name] = struct{}{}
			names = append(names, name)
		}
		return nil
	})
	if errors.Is(err, errDuplicateAppliedMigration) {
		return nil, errors.Join(ErrSchemaCompatibility, fmt.Errorf("%w: applied migration history is not unique", ErrMigrationHistory))
	}
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	return names, nil
}

var errDuplicateAppliedMigration = errors.New("duplicate applied migration")

func readCompatibilityRows(ctx context.Context, queryer Queryer, query, operation string, scan func(Rows) error) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%w: %s query cancelled", ErrSchemaCompatibility, operation)
	}
	rows, err := queryer.Query(ctx, query)
	if err != nil {
		return fmt.Errorf("%w: %s query failed", ErrSchemaCompatibility, operation)
	}
	if rows == nil {
		return fmt.Errorf("%w: %s query returned no rows handle", ErrSchemaCompatibility, operation)
	}
	defer rows.Close()
	if err := scan(rows); err != nil {
		if errors.Is(err, errDuplicateAppliedMigration) {
			return err
		}
		return fmt.Errorf("%w: %s result is invalid", ErrSchemaCompatibility, operation)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("%w: %s result is invalid", ErrSchemaCompatibility, operation)
	}
	return nil
}

func unsupportedSchemaError() error {
	return errors.Join(ErrSchemaCompatibility, fmt.Errorf("%w: schema_migrations structure is incompatible", ErrUnsupportedSchema))
}
