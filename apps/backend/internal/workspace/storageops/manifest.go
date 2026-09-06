package storageops

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

const MaxManifestBytes int64 = 8 * 1024 * 1024

// DecodeManifest parses one strict, bounded JSON manifest. Unknown fields and
// trailing values are rejected so an older operator cannot silently ignore a
// newer safety field.
func DecodeManifest(reader io.Reader) (Manifest, error) {
	if reader == nil {
		return Manifest{}, fmt.Errorf("%w: manifest reader is required", ErrInvalidManifest)
	}
	limited := io.LimitReader(reader, MaxManifestBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return Manifest{}, fmt.Errorf("%w: manifest cannot be read", ErrInvalidManifest)
	}
	if int64(len(data)) > MaxManifestBytes {
		return Manifest{}, fmt.Errorf("%w: manifest is too large", ErrInvalidManifest)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("%w: manifest JSON is invalid", ErrInvalidManifest)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Manifest{}, fmt.Errorf("%w: manifest has trailing values", ErrInvalidManifest)
	}
	return manifest, nil
}

// LoadManifest opens a local private manifest. It intentionally does not
// create or repair the parent directory.
func LoadManifest(path string) (Manifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return Manifest{}, fmt.Errorf("%w: manifest cannot be opened", ErrInvalidManifest)
	}
	defer file.Close()
	return DecodeManifest(file)
}
