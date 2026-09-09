//go:build postgres_integration

package avatars

import (
	"context"
	"io"
	"testing"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

type wrongMetadataAvatarStore struct{ platformstorage.BlobStore }

func (s wrongMetadataAvatarStore) Put(ctx context.Context, key string, body io.Reader, size int64, digest string) (platformstorage.StoredObject, error) {
	stored, err := s.BlobStore.Put(ctx, key, body, size, digest)
	stored.ByteSize++
	return stored, err
}

func TestPGAvatarBadPutMetadataCannotDeleteAnotherUsersObject(t *testing.T) {
	fixture := newPGAvatarIntegrationFixture(t)
	if _, err := fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{ActorID: "usr_avatar_owner", MIMEType: "image/png", Content: []byte("owner-source")}); err != nil {
		t.Fatal(err)
	}
	owner, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, "usr_avatar_owner")
	if err != nil || owner == nil || owner.StorageObject == nil {
		t.Fatalf("owner avatar = %#v, err = %v", owner, err)
	}
	fixture.service.blobStore = wrongMetadataAvatarStore{BlobStore: fixture.store}
	if _, err := fixture.service.SetOwnAvatar(fixture.ctx, SetOwnAvatarInput{ActorID: "usr_avatar_member", MIMEType: "image/png", Content: []byte("member-source")}); err == nil {
		t.Fatal("invalid metadata was accepted")
	}
	opened, err := fixture.store.Open(fixture.ctx, owner.StorageObject.BlobObject(), AvatarMaxOutputBytes)
	if err != nil {
		t.Fatalf("another user's canonical object was deleted: %v", err)
	}
	_ = opened.Body.Close()
	member, err := fixture.repo.GetCurrentAvatar(fixture.ctx, DefaultSpaceID, "usr_avatar_member")
	if err != nil || member == nil || member.StorageObjectID != "" {
		t.Fatalf("rejected avatar acquired a reference: %#v, err = %v", member, err)
	}
}
