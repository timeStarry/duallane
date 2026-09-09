// Command permission-probe performs a one-shot, read-only filesystem
// permission rehearsal for a Go Workspace candidate. It intentionally does
// not open PostgreSQL, create directories, or expose any storage mutation.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

const (
	probeSchema            = "duallane.runtime-permission/v1"
	probeVersion           = 1
	probeDataRoot          = "/app/data/workspace-files"
	probeSecretRoot        = "/run/secrets"
	probeMaxBytes    int64 = 2 * 1024 * 1024
	probeManifestMax       = 64 * 1024
	probeTimeout           = 2 * time.Second
	probeReadChunk         = 32 * 1024
)

type fixtureManifest struct {
	Version   int         `json:"version"`
	Canonical objectSpec  `json:"canonical"`
	Legacy    objectSpec  `json:"legacy"`
	Secret    *secretSpec `json:"secret,omitempty"`
}

type objectSpec struct {
	Key      string `json:"key"`
	SHA256   string `json:"sha256"`
	ByteSize int64  `json:"byteSize"`
}

type secretSpec struct {
	Path     string `json:"path"`
	SHA256   string `json:"sha256"`
	ByteSize int64  `json:"byteSize"`
}

type permissionReport struct {
	Schema    string       `json:"schema"`
	Version   int          `json:"version"`
	Status    string       `json:"status"`
	ErrorCode string       `json:"errorCode,omitempty"`
	UID       int          `json:"uid"`
	GID       int          `json:"gid"`
	Root      checkResult  `json:"root"`
	Canonical checkResult  `json:"canonical"`
	Legacy    checkResult  `json:"legacy"`
	Secret    *checkResult `json:"secret,omitempty"`
}

type checkResult struct {
	Status    string `json:"status"`
	ErrorCode string `json:"errorCode,omitempty"`
	ByteSize  int64  `json:"byteSize,omitempty"`
}

type probeFailure struct {
	code  string
	cause error
}

func (e *probeFailure) Error() string {
	if e == nil {
		return ""
	}
	return e.code
}

func (e *probeFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, output, diagnostic io.Writer) int {
	flags := flag.NewFlagSet("duallane-permission-probe", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	manifestPath := flags.String("manifest", "", "read-only synthetic manifest")
	if err := flags.Parse(args); err != nil {
		fmt.Fprintln(diagnostic, "permission-probe: invalid arguments")
		return 2
	}
	if *manifestPath == "" || flags.NArg() != 0 {
		fmt.Fprintln(diagnostic, "permission-probe: --manifest is required")
		return 2
	}

	uid, gid := processIDs()
	baseReport := permissionReport{
		Schema:    probeSchema,
		Version:   probeVersion,
		Status:    "failed",
		UID:       uid,
		GID:       gid,
		Root:      notRunResult(),
		Canonical: notRunResult(),
		Legacy:    notRunResult(),
	}
	manifest, err := loadManifest(*manifestPath)
	if err != nil {
		baseReport.ErrorCode = safeErrorCode(err)
		if encodeErr := encodeReport(output, baseReport); encodeErr != nil {
			fmt.Fprintln(diagnostic, "permission-probe: report_failed")
			return 2
		}
		fmt.Fprintln(diagnostic, "permission-probe: manifest_invalid")
		return 2
	}

	report := probeManifest(manifest, probeDataRoot, probeSecretRoot)
	if err := encodeReport(output, report); err != nil {
		fmt.Fprintln(diagnostic, "permission-probe: report_failed")
		return 2
	}
	if report.Status != "passed" {
		fmt.Fprintln(diagnostic, "permission-probe: probe_failed")
		return 1
	}
	return 0
}

func encodeReport(output io.Writer, report permissionReport) error {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(true)
	return encoder.Encode(report)
}

func loadManifest(path string) (fixtureManifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return fixtureManifest{}, &probeFailure{code: "probe.manifest_unreadable", cause: err}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fixtureManifest{}, &probeFailure{code: "probe.manifest_unreadable", cause: err}
	}
	if !info.Mode().IsRegular() || info.Size() > probeManifestMax {
		return fixtureManifest{}, &probeFailure{code: "probe.manifest_invalid"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	contents, err := readBytes(ctx, file, info.Size(), probeManifestMax)
	if err != nil {
		return fixtureManifest{}, &probeFailure{code: "probe.manifest_unreadable", cause: err}
	}
	decoder := json.NewDecoder(strings.NewReader(string(contents)))
	decoder.DisallowUnknownFields()
	var manifest fixtureManifest
	if err := decoder.Decode(&manifest); err != nil {
		return fixtureManifest{}, &probeFailure{code: "probe.manifest_invalid", cause: err}
	}
	// A manifest is exactly one JSON document. Decode once more so a valid
	// document followed by another document or non-whitespace garbage cannot
	// be accepted as a valid synthetic fixture.
	var trailing struct{}
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("trailing manifest document")
		}
		return fixtureManifest{}, &probeFailure{code: "probe.manifest_invalid", cause: err}
	}
	if err := validateManifest(manifest); err != nil {
		return fixtureManifest{}, err
	}
	return manifest, nil
}

func validateManifest(manifest fixtureManifest) error {
	if manifest.Version != probeVersion {
		return &probeFailure{code: "probe.manifest_invalid", cause: errors.New("manifest version")}
	}
	if err := validateObjectSpec(manifest.Canonical, true); err != nil {
		return &probeFailure{code: "probe.manifest_invalid", cause: err}
	}
	if err := validateObjectSpec(manifest.Legacy, false); err != nil {
		return &probeFailure{code: "probe.manifest_invalid", cause: err}
	}
	if manifest.Secret != nil {
		if err := validateSecretSpec(*manifest.Secret); err != nil {
			return &probeFailure{code: "probe.manifest_invalid", cause: err}
		}
	}
	return nil
}

func validateObjectSpec(spec objectSpec, canonical bool) error {
	if err := validateRelativeKey(spec.Key); err != nil {
		return err
	}
	digest, err := storage.NormalizeSHA256(spec.SHA256)
	if err != nil || strings.TrimSpace(spec.SHA256) != digest {
		return errors.New("object digest")
	}
	if spec.ByteSize < 0 || spec.ByteSize > probeMaxBytes+1 {
		return errors.New("object size")
	}
	if canonical {
		return storage.ValidateCanonicalKey(spec.Key, digest)
	}
	if strings.HasPrefix(strings.ReplaceAll(spec.Key, "\\", "/"), storage.CanonicalObjectPrefix) {
		return errors.New("legacy key is canonical")
	}
	return nil
}

func validateSecretSpec(spec secretSpec) error {
	const prefix = probeSecretRoot + "/"
	normalized := strings.ReplaceAll(spec.Path, "\\", "/")
	if !strings.HasPrefix(normalized, prefix) {
		return errors.New("secret path")
	}
	relative := strings.TrimPrefix(normalized, prefix)
	if relative == "" || strings.Contains(relative, "/") || strings.Contains(relative, "\x00") || relative == "." || relative == ".." {
		return errors.New("secret path")
	}
	digest, err := storage.NormalizeSHA256(spec.SHA256)
	if err != nil || strings.TrimSpace(spec.SHA256) != digest {
		return errors.New("secret digest")
	}
	if spec.ByteSize < 0 || spec.ByteSize > probeMaxBytes {
		return errors.New("secret size")
	}
	return nil
}

func validateRelativeKey(key string) error {
	normalized := strings.ReplaceAll(key, "\\", "/")
	if strings.TrimSpace(normalized) == "" || strings.ContainsRune(normalized, '\x00') || strings.HasPrefix(normalized, "/") || (len(normalized) >= 2 && normalized[1] == ':') {
		return errors.New("object key")
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return errors.New("object key")
		}
	}
	return nil
}

func probeManifest(manifest fixtureManifest, dataRoot, secretRoot string) permissionReport {
	uid, gid := processIDs()
	report := permissionReport{
		Schema:    probeSchema,
		Version:   probeVersion,
		Status:    "failed",
		UID:       uid,
		GID:       gid,
		Root:      notRunResult(),
		Canonical: notRunResult(),
		Legacy:    notRunResult(),
	}

	store, err := openLocalStore(dataRoot)
	if err != nil {
		report.Root = resultForError(err)
	} else {
		report.Root = checkResult{Status: "passed"}
		report.Canonical = probeCanonical(store, manifest.Canonical)
		report.Legacy = probeLegacy(store, manifest.Legacy)
	}
	if manifest.Secret != nil {
		relative := strings.TrimPrefix(strings.ReplaceAll(manifest.Secret.Path, "\\", "/"), probeSecretRoot+"/")
		report.Secret = pointerResult(probeSecret(secretRoot, relative, *manifest.Secret))
	}

	if report.Root.Status == "passed" && report.Canonical.Status == "passed" && report.Legacy.Status == "passed" && (report.Secret == nil || report.Secret.Status == "passed") {
		report.Status = "passed"
	} else {
		report.ErrorCode = "probe.failed"
	}
	return report
}

func openLocalStore(root string) (*storage.LocalBlobStore, error) {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	return storage.OpenExistingLocalBlobStore(ctx, root)
}

func probeCanonical(store *storage.LocalBlobStore, spec objectSpec) checkResult {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	opened, err := store.Open(ctx, storage.Object{Key: spec.Key, SHA256: spec.SHA256, ByteSize: spec.ByteSize}, probeMaxBytes)
	if err != nil {
		return resultForError(err)
	}
	if err := verifyOpened(ctx, opened, spec); err != nil {
		return resultForError(err)
	}
	return checkResult{Status: "passed", ByteSize: spec.ByteSize}
}

func probeLegacy(store *storage.LocalBlobStore, spec objectSpec) checkResult {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	reader, ok := interface{}(store).(storage.LegacyReader)
	if !ok {
		return resultForError(&probeFailure{code: "probe.legacy_reader_unavailable"})
	}
	opened, err := reader.OpenLegacy(ctx, spec.Key, probeMaxBytes)
	if err != nil {
		return resultForError(err)
	}
	if err := verifyOpened(ctx, opened, spec); err != nil {
		return resultForError(err)
	}
	return checkResult{Status: "passed", ByteSize: spec.ByteSize}
}

func probeSecret(rootPath, relative string, spec secretSpec) checkResult {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return resultForError(err)
	}
	defer root.Close()
	info, err := root.Lstat(relative)
	if err != nil {
		return resultForError(err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return resultForError(&probeFailure{code: "probe.symlink_rejected"})
	}
	body, err := root.Open(relative)
	if err != nil {
		return resultForError(err)
	}
	defer body.Close()
	info, err = body.Stat()
	if err != nil {
		return resultForError(err)
	}
	if !info.Mode().IsRegular() || info.Size() != spec.ByteSize || info.Size() > probeMaxBytes {
		return resultForError(&probeFailure{code: "file.storage_too_large"})
	}
	if err := readAndVerifyBody(ctx, body, spec.ByteSize, spec.SHA256); err != nil {
		return resultForError(err)
	}
	return checkResult{Status: "passed", ByteSize: spec.ByteSize}
}

func verifyOpened(ctx context.Context, opened storage.OpenedObject, spec objectSpec) error {
	if opened.Body == nil || opened.ByteSize != spec.ByteSize || opened.SHA256 != spec.SHA256 {
		if opened.Body != nil {
			_ = opened.Body.Close()
		}
		return &probeFailure{code: "probe.object_metadata_mismatch"}
	}
	defer opened.Body.Close()
	return readAndVerifyBody(ctx, opened.Body, spec.ByteSize, spec.SHA256)
}

func readAndVerifyBody(ctx context.Context, body io.Reader, expectedSize int64, expectedSHA256 string) error {
	if body == nil || expectedSize < 0 || expectedSize > probeMaxBytes {
		return &probeFailure{code: "file.storage_too_large"}
	}
	digest, err := storage.NormalizeSHA256(expectedSHA256)
	if err != nil {
		return &probeFailure{code: "probe.object_metadata_mismatch", cause: err}
	}
	hash := sha256.New()
	buffer := make([]byte, probeReadChunk)
	var count int64
	zeroReads := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		read, readErr := body.Read(buffer)
		if err := ctx.Err(); err != nil {
			return err
		}
		if read > 0 {
			zeroReads = 0
			count += int64(read)
			if count > expectedSize || count > probeMaxBytes {
				return &probeFailure{code: "file.storage_too_large"}
			}
			_, _ = hash.Write(buffer[:read])
		} else if readErr == nil {
			zeroReads++
			if zeroReads > 100 {
				return &probeFailure{code: "probe.no_progress"}
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return readErr
		}
	}
	if count != expectedSize {
		return &probeFailure{code: "probe.object_size_mismatch"}
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return &probeFailure{code: "probe.object_hash_mismatch"}
	}
	return nil
}

func readBytes(ctx context.Context, reader io.Reader, expectedSize, maxBytes int64) ([]byte, error) {
	if expectedSize < 0 || expectedSize > maxBytes {
		return nil, &probeFailure{code: "probe.input_too_large"}
	}
	result := make([]byte, 0, expectedSize)
	buffer := make([]byte, probeReadChunk)
	var count int64
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		read, readErr := reader.Read(buffer)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if read > 0 {
			count += int64(read)
			if count > maxBytes {
				return nil, &probeFailure{code: "probe.input_too_large"}
			}
			result = append(result, buffer[:read]...)
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return result, nil
			}
			return nil, readErr
		}
	}
}

func resultForError(err error) checkResult {
	code := safeErrorCode(err)
	status := "failed"
	switch {
	case code == "permission_denied":
		status = "permission_denied"
	case code == "file.storage_too_large" || code == "storage.invalid_key" || code == "storage.object_invalid_key" || code == "file.storage_mismatch" || code == "probe.symlink_rejected":
		status = "rejected"
	case code == "context.deadline_exceeded" || code == "context.canceled":
		status = "timeout"
	}
	return checkResult{Status: status, ErrorCode: code}
}

func safeErrorCode(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, os.ErrPermission) {
		return "permission_denied"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "context.deadline_exceeded"
	}
	if errors.Is(err, context.Canceled) {
		return "context.canceled"
	}
	var storageErr *storage.Error
	if errors.As(err, &storageErr) && storageErr.Code != "" {
		return storageErr.Code
	}
	var failure *probeFailure
	if errors.As(err, &failure) && failure.code != "" {
		return failure.code
	}
	return "probe.internal_error"
}

func notRunResult() checkResult {
	return checkResult{Status: "not_run"}
}

func pointerResult(value checkResult) *checkResult {
	return &value
}
