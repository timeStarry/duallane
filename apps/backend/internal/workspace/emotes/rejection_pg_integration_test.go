//go:build postgres_integration

package emotes

import (
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

func TestPGEmoteRejectedPlacementRollsBackDomainWrites(t *testing.T) {
	fixture := newPGEmoteIntegrationFixture(t)
	_, err := fixture.service.Upload(fixture.ctx, UploadInput{
		ActorID: "usr_emote_owner", Source: UploadSource{Type: "upload", FileName: "synthetic.png", MIMEType: "image/png"},
		Content: strings.NewReader("synthetic emote"), CollectionID: "missing-collection", AddToLibrary: true,
	})
	var domainErr *Error
	if !errors.As(err, &domainErr) || domainErr.Code != CodeEmoteCollectionNotFound {
		t.Fatalf("placement error = %v", err)
	}
	for _, table := range []string{"workspace_custom_emotes", "workspace_events", "workspace_emote_library_entries"} {
		if count := pgEmoteCount(t, fixture, "SELECT COUNT(*) FROM "+table); count != 0 {
			t.Errorf("rejected placement retained %d rows in %s", count, table)
		}
	}
	if count := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM workspace_storage_objects WHERE deleted_at IS NULL`); count != 0 {
		t.Errorf("rejected placement retained %d live objects", count)
	}
	if count := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'emote.create' AND result = 'rejected' AND reason = $1`, CodeEmoteCollectionNotFound); count != 1 {
		t.Errorf("rejection audit count = %d", count)
	}
	if err := filepath.WalkDir(fixture.root, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			t.Error("rejected placement retained unreferenced physical bytes")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
