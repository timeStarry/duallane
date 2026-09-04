package migrations

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
)

// A migration name is part of the persisted schema_migrations contract. Keep
// the accepted shape deliberately narrower than a general SQL filename so a
// misplaced file cannot silently become a schema change.
var canonicalNamePattern = regexp.MustCompile(`^[0-9]{3}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$`)

// File describes one canonical migration without copying its SQL contents.
type File struct {
	Name   string
	Path   string
	Number int
}

// IsCanonicalName reports whether name is a supported numbered migration
// filename. The version range is intentionally the complete three-digit
// range; the existing history starts at 001 and future migrations may use
// the remaining range.
func IsCanonicalName(name string) bool {
	return canonicalNamePattern.MatchString(name)
}

// Discover returns canonical migration files in lexical filename order.
// Non-migration files are ignored, while a canonical-looking non-regular file
// is rejected so a directory or symlink cannot be mistaken for SQL content.
func Discover(directory string) ([]File, error) {
	if directory == "" {
		return nil, fmt.Errorf("migration directory is required")
	}

	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read migration directory: %w", err)
	}

	files := make([]File, 0, len(entries))
	numbers := make(map[int]string)
	for _, entry := range entries {
		name := entry.Name()
		if !IsCanonicalName(name) {
			continue
		}
		if !entry.Type().IsRegular() {
			return nil, fmt.Errorf("migration %q is not a regular file", name)
		}

		number, err := strconv.Atoi(name[:3])
		if err != nil {
			return nil, fmt.Errorf("migration %q has an invalid number: %w", name, err)
		}
		if previous, exists := numbers[number]; exists {
			return nil, fmt.Errorf("duplicate migration number %03d in %q and %q", number, previous, name)
		}
		numbers[number] = name
		files = append(files, File{
			Name:   name,
			Path:   filepath.Join(directory, name),
			Number: number,
		})
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].Name < files[j].Name
	})
	return files, nil
}
