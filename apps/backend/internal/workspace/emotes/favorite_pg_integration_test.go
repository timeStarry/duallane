//go:build postgres_integration

package emotes

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// favoriteMutationProbeRepository lets the integration test pause after the
// favorite transaction acquires the canonical-object lock. It also changes
// the source projection after the pre-transaction read, proving that the
// mutation refreshes the source before it copies metadata.
type favoriteMutationProbeRepository struct {
	Repository
	source FavoriteSourceRepository

	objectLockKey     string
	objectLocked      chan struct{}
	releaseObjectLock chan struct{}
	objectLockOnce    sync.Once
	releaseOnce       sync.Once

	beforeFirstCustomEmoteRead func() error
	customEmoteReadOnce        sync.Once
	customEmoteReadErr         error
}

func (r *favoriteMutationProbeRepository) GetVisibleFavoriteMessage(ctx context.Context, spaceID, actorID, messageID string) (*FavoriteMessageRecord, error) {
	return r.source.GetVisibleFavoriteMessage(ctx, spaceID, actorID, messageID)
}

func (r *favoriteMutationProbeRepository) GetFavoriteMessageAttachment(ctx context.Context, spaceID, messageID, attachmentID string) (*FavoriteAttachmentRecord, error) {
	return r.source.GetFavoriteMessageAttachment(ctx, spaceID, messageID, attachmentID)
}

func (r *favoriteMutationProbeRepository) GetCustomEmote(ctx context.Context, emoteID string) (*CustomEmoteRecord, error) {
	row, err := r.Repository.GetCustomEmote(ctx, emoteID)
	if err != nil {
		return nil, err
	}
	r.customEmoteReadOnce.Do(func() {
		if r.beforeFirstCustomEmoteRead != nil {
			r.customEmoteReadErr = r.beforeFirstCustomEmoteRead()
		}
	})
	if r.customEmoteReadErr != nil {
		return nil, r.customEmoteReadErr
	}
	return row, nil
}

func (r *favoriteMutationProbeRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	return r.Repository.WithTx(ctx, func(tx Tx) error {
		return callback(&favoriteMutationProbeTx{Tx: tx, repository: r})
	})
}

type favoriteMutationProbeTx struct {
	Tx
	repository *favoriteMutationProbeRepository
}

func (tx *favoriteMutationProbeTx) Lock(ctx context.Context, key string) error {
	if err := tx.Tx.Lock(ctx, key); err != nil {
		return err
	}
	if key != tx.repository.objectLockKey {
		return nil
	}
	tx.repository.objectLockOnce.Do(func() { close(tx.repository.objectLocked) })
	<-tx.repository.releaseObjectLock
	return nil
}

func (r *favoriteMutationProbeRepository) releaseObjectLockForTest() {
	r.releaseOnce.Do(func() { close(r.releaseObjectLock) })
}

func assertPGFavoriteObjectLockHeld(t *testing.T, fixture *pgEmoteIntegrationFixture, objectID string) {
	t.Helper()
	probeCtx, cancel := context.WithTimeout(fixture.ctx, 5*time.Second)
	defer cancel()
	connection, err := fixture.pool.Acquire(probeCtx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()
	var available bool
	if err := connection.QueryRow(probeCtx, `
		SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))
	`, workspaceStorageObjectLockKey(objectID)).Scan(&available); err != nil {
		t.Fatal(err)
	}
	if available {
		t.Fatal("favorite transaction did not hold the shared canonical-object lock")
	}
}

func TestPGFavoriteFromMessageAttachmentAndCustomReference(t *testing.T) {
	fixture := newPGEmoteIntegrationFixture(t)
	const (
		owner        = "usr_emote_owner"
		member       = "usr_emote_member"
		conversation = "conv_favorite"
		message      = "msg_favorite_attachment"
		attachment   = "att_favorite"
	)
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO conversations (id, space_id, type, title, created_by, created_at)
		VALUES ($1, $2, 'group', 'Favorite source', $3, $4)
	`, conversation, DefaultSpaceID, owner, fixture.now)
	for _, userID := range []string{owner, member} {
		mustExecPGEmote(t, fixture.ctx, fixture.conn, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ($1, $2, $3)
		`, conversation, userID, fixture.now)
	}
	attachmentBytes := []byte("favorite attachment")
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES ($1, $2, $3, $4, 'human', 'user', $5, 'duallane.message+json;v=1', '{"blocks":[]}', 'attachment', $6)
	`, message, DefaultSpaceID, conversation, owner, "favorite-message-1", fixture.now)
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO attachments (
			id, space_id, uploader_id, conversation_id, visibility, status,
			file_name, mime_type, byte_size, storage_key, created_at, completed_at
		) VALUES ($1, $2, $3, $4, 'conversation', 'available', $5, 'image/png', $6,
			$7, $8, $8)
	`, attachment, DefaultSpaceID, owner, conversation, "favorite.png", len(attachmentBytes), "workspace/spc_default/att_favorite/favorite.png", fixture.now)
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO message_attachments (message_id, attachment_id) VALUES ($1, $2)
	`, message, attachment)

	reader := &favoriteAttachmentReaderStub{data: attachmentBytes}
	var sequence atomic.Int64
	ids := []string{
		"22222222-2222-2222-2222-222222222222",
		"33333333-3333-3333-3333-333333333333",
	}
	service := NewService(ServiceOptions{
		Repository: fixture.service.Repository(), BlobStore: fixture.store, Catalog: fixture.service.Catalog(),
		Processor: fakeProcessor{}, AttachmentContentReader: reader, SpaceID: DefaultSpaceID,
		Now: func() time.Time { return fixture.now },
		IDFactory: func() (string, error) {
			index := int(sequence.Add(1)) - 1
			if index >= len(ids) {
				return fmt.Sprintf("44444444-4444-4444-4444-%012d", index), nil
			}
			return ids[index], nil
		},
	})

	created, err := service.FavoriteFromMessage(fixture.ctx, FavoriteFromMessageInput{
		ActorID: member, MessageID: message, AttachmentID: attachment,
		Meta: auth.RequestMeta{RequestID: "favorite-pg-attachment"},
	})
	if err != nil {
		t.Fatalf("PG attachment favorite: %v", err)
	}
	if created == nil || created.SourceType != "attachment" || created.OriginalFileName != "favorite.png" {
		t.Fatalf("PG attachment projection: %#v", created)
	}
	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM workspace_custom_emotes WHERE id = $1 AND user_id = $2 AND source_type = 'attachment' AND source_attachment_id = $3`, created.ID, member, attachment); got != 1 {
		t.Fatalf("PG attachment row count = %d", got)
	}
	if got := pgEmoteCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'emote.create' AND request_id = 'favorite-pg-attachment' AND result = 'success'`); got != 1 {
		t.Fatalf("PG attachment audit count = %d", got)
	}

	customSourceContent := "custom source bytes"
	customSource, err := service.Upload(fixture.ctx, UploadInput{
		ActorID: owner,
		Source:  UploadSource{MIMEType: "image/png", FileName: "custom-source.png"},
		Content: strings.NewReader(customSourceContent),
		Meta:    auth.RequestMeta{RequestID: "favorite-pg-custom-source"},
	})
	if err != nil {
		t.Fatalf("PG custom source upload: %v", err)
	}

	customMessage := "msg_favorite_custom"
	customContent := fmt.Sprintf(`{"blocks":[{"type":"emoji","shortcode":"custom:%s"}]}`, customSource.ID)
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES ($1, $2, $3, $4, 'human', 'user', $5, 'duallane.message+json;v=1', $6, 'custom', $7)
	`, customMessage, DefaultSpaceID, conversation, owner, "favorite-message-2", customContent, fixture.now)
	mustExecPGEmote(t, fixture.ctx, fixture.conn, `
		INSERT INTO message_custom_emotes (message_id, custom_emote_id) VALUES ($1, $2)
	`, customMessage, customSource.ID)

	var objectID string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT storage_object_id FROM workspace_custom_emotes WHERE id = $1
	`, customSource.ID).Scan(&objectID); err != nil {
		t.Fatal(err)
	}
	if objectID == "" {
		t.Fatal("PG custom source has no canonical storage object")
	}
	probeSourceRepository, ok := fixture.service.Repository().(FavoriteSourceRepository)
	if !ok {
		t.Fatal("PG emote repository does not implement favorite source reads")
	}
	probeRepository := &favoriteMutationProbeRepository{
		Repository: fixture.service.Repository(), source: probeSourceRepository,
		objectLockKey: workspaceStorageObjectLockKey(objectID),
		objectLocked:  make(chan struct{}), releaseObjectLock: make(chan struct{}),
		beforeFirstCustomEmoteRead: func() error {
			_, err := fixture.pool.Exec(fixture.ctx, `
				UPDATE workspace_custom_emotes SET label = $2 WHERE id = $1
			`, customSource.ID, "fresh source label")
			return err
		},
	}
	defer probeRepository.releaseObjectLockForTest()
	probeService := NewService(ServiceOptions{
		Repository: probeRepository, BlobStore: fixture.store, Catalog: fixture.service.Catalog(), SpaceID: DefaultSpaceID,
		Now:       func() time.Time { return fixture.now },
		IDFactory: func() (string, error) { return "44444444-4444-4444-4444-444444444444", nil },
	})
	type favoriteCall struct {
		result *CustomEmote
		err    error
	}
	favoriteCalls := make(chan favoriteCall, 1)
	go func() {
		result, err := probeService.FavoriteFromMessage(fixture.ctx, FavoriteFromMessageInput{
			ActorID: member, MessageID: customMessage, CustomEmoteID: customSource.ID,
			Meta: auth.RequestMeta{RequestID: "favorite-pg-custom"},
		})
		favoriteCalls <- favoriteCall{result: result, err: err}
	}()
	select {
	case <-probeRepository.objectLocked:
	case <-time.After(5 * time.Second):
		t.Fatal("favorite did not reach the canonical-object lock")
	}
	assertPGFavoriteObjectLockHeld(t, fixture, objectID)
	cleanupDone := make(chan error, 1)
	go func() {
		cleanupDone <- fixture.service.cleanupObjectIfUnreferenced(fixture.ctx, objectID)
	}()
	probeRepository.releaseObjectLockForTest()
	favoriteResult := <-favoriteCalls
	referenced, err := favoriteResult.result, favoriteResult.err
	if err != nil {
		t.Fatalf("PG custom reference favorite: %v", err)
	}
	select {
	case err := <-cleanupDone:
		if err != nil {
			t.Fatalf("PG cleanup after favorite lock release: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("PG cleanup did not finish after favorite committed")
	}
	if referenced == nil || referenced.ID == created.ID || referenced.ID == customSource.ID || referenced.SourceType != "custom" || referenced.Label != "fresh source label" || referenced.ByteSize == nil || *referenced.ByteSize != int64(len(customSourceContent)) {
		t.Fatalf("PG custom reference projection: %#v", referenced)
	}
	if got := pgEmoteCount(t, fixture, `
		SELECT COUNT(*) FROM workspace_custom_emotes
		WHERE id = $1 AND user_id = $2 AND source_type = 'custom'
		  AND source_custom_emote_id = $3 AND storage_object_id IS NOT NULL
	`, referenced.ID, member, customSource.ID); got != 1 {
		t.Fatalf("PG custom reference row count = %d", got)
	}

	replay, err := probeService.FavoriteFromMessage(fixture.ctx, FavoriteFromMessageInput{
		ActorID: member, MessageID: customMessage, CustomEmoteID: customSource.ID,
	})
	if err != nil || replay.ID != referenced.ID {
		t.Fatalf("PG custom replay = %#v, err=%v", replay, err)
	}

	if _, err := service.Remove(fixture.ctx, owner, customSource.ID, auth.RequestMeta{RequestID: "favorite-pg-custom-source-remove"}); err != nil {
		t.Fatalf("PG remove custom source: %v", err)
	}
	if got := pgEmoteCount(t, fixture, `
		SELECT COUNT(*) FROM workspace_custom_emotes WHERE id = $1 AND removed_at IS NOT NULL
	`, customSource.ID); got != 1 {
		t.Fatalf("PG removed custom source rows = %d", got)
	}
	if got := pgEmoteCount(t, fixture, `
		SELECT COUNT(*) FROM workspace_storage_objects WHERE id = $1 AND deleted_at IS NULL
	`, objectID); got != 1 {
		t.Fatalf("PG shared object was cleaned after source removal: %d", got)
	}
	if got := pgEmoteCount(t, fixture, `
		SELECT
			(SELECT COUNT(*) FROM attachments WHERE storage_object_id = $1) +
			(SELECT COUNT(*) FROM users WHERE avatar_storage_object_id = $1) +
			(SELECT COUNT(*) FROM workspace_custom_emotes WHERE storage_object_id = $1)
	`, objectID); got != 2 {
		t.Fatalf("PG shared custom object reference count after source removal = %d, want 2", got)
	}
	delivery, err := service.ReadContent(fixture.ctx, ReadContentInput{ActorID: member, EmoteID: referenced.ID})
	if err != nil {
		t.Fatalf("PG favorite target read after source removal: %v", err)
	}
	content, readErr := io.ReadAll(delivery.Body)
	closeErr := delivery.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != customSourceContent {
		t.Fatalf("PG favorite target content after source removal = %q, readErr=%v, closeErr=%v", content, readErr, closeErr)
	}
}
