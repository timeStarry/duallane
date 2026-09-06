package emotes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type pgQueryer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// PGRepository is the native PostgreSQL adapter. It owns only emote SQL and
// never exposes a general query method to application code.
type PGRepository struct {
	pool      *pgxpool.Pool
	idFactory IDFactory
}

func NewPGRepository(pool *pgxpool.Pool, idFactories ...IDFactory) *PGRepository {
	idFactory := IDFactory(func() (string, error) {
		id, err := uuid.NewRandom()
		if err != nil {
			return "", err
		}
		return id.String(), nil
	})
	if len(idFactories) > 0 && idFactories[0] != nil {
		idFactory = idFactories[0]
	}
	return &PGRepository{pool: pool, idFactory: idFactory}
}

func (r *PGRepository) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return internalError("ping workspace emote database", errors.New("workspace postgres pool is required"))
	}
	if err := r.pool.Ping(ctx); err != nil {
		return internalError("ping workspace emote database", err)
	}
	return nil
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin workspace emote transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin workspace emote transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin workspace emote transaction", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()
	if err := callback(&pgTx{tx: tx, repository: r}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return internalError("commit workspace emote transaction", err)
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup workspace emote actor", errors.New("workspace postgres pool is required"))
	}
	return lookupActor(ctx, r.pool, spaceID, userID)
}

func lookupActor(ctx context.Context, queryer pgQueryer, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	err := queryer.QueryRow(ctx, `
		SELECT u.id, u.github_id, u.github_login, u.email, u.display_name,
			u.nickname, u.avatar_url, u.search_discoverable, u.kind,
			sm.role, sm.joined_at
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName,
		&nickname, &avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &actor.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	actor.GitHubID = stringValue(githubID)
	actor.Email = stringValue(email)
	actor.Nickname = stringValue(nickname)
	actor.AvatarURL = stringValue(avatarURL)
	actor.JoinedAt = actor.JoinedAt.UTC()
	return &actor, nil
}

func (r *PGRepository) GetSettings(ctx context.Context, userID string) (SettingsRecord, error) {
	if r == nil || r.pool == nil {
		return SettingsRecord{}, internalError("read workspace emote settings", errors.New("workspace postgres pool is required"))
	}
	return getSettings(ctx, r.pool, userID)
}

func getSettings(ctx context.Context, queryer pgQueryer, userID string) (SettingsRecord, error) {
	var record SettingsRecord
	err := queryer.QueryRow(ctx, `
		SELECT enabled_pack_ids_json, click_image_emote_to_send, reply_auto_mention
		FROM workspace_emote_preferences WHERE user_id = $1
	`, userID).Scan(&record.EnabledPackIDsJSON, &record.ClickImageEmoteToSend, &record.ReplyAutoMention)
	if errors.Is(err, pgx.ErrNoRows) {
		return record, nil
	}
	return record, err
}

const customEmoteSelect = `
	SELECT id, user_id, source_type, source_attachment_id, source_custom_emote_id,
		source_emote_key, original_file_name, original_mime_type, label,
		normalized_mime_type, byte_size, width, height, frame_count, duration_ms,
		sha256, storage_key, storage_object_id, sort_order, created_at, removed_at
	FROM workspace_custom_emotes
`

func scanCustomEmote(row pgx.Row) (*CustomEmoteRecord, error) {
	var record CustomEmoteRecord
	var sourceAttachmentID, sourceCustomID, sourceKey, originalName, originalMIME, normalizedMIME, digest, storageKey, storageObjectID *string
	err := row.Scan(&record.ID, &record.UserID, &record.SourceType, &sourceAttachmentID, &sourceCustomID,
		&sourceKey, &originalName, &originalMIME, &record.Label, &normalizedMIME, &record.ByteSize,
		&record.Width, &record.Height, &record.FrameCount, &record.DurationMS, &digest,
		&storageKey, &storageObjectID, &record.SortOrder, &record.CreatedAt, &record.RemovedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.SHA256 = stringValue(digest)
	record.SourceAttachmentID = stringValue(sourceAttachmentID)
	record.SourceCustomEmoteID = stringValue(sourceCustomID)
	record.SourceEmoteKey = stringValue(sourceKey)
	record.OriginalFileName = stringValue(originalName)
	record.OriginalMIMEType = stringValue(originalMIME)
	record.NormalizedMIMEType = stringValue(normalizedMIME)
	record.StorageKey = stringValue(storageKey)
	record.StorageObjectID = stringValue(storageObjectID)
	record.CreatedAt = record.CreatedAt.UTC()
	if record.RemovedAt != nil {
		removed := record.RemovedAt.UTC()
		record.RemovedAt = &removed
	}
	return &record, nil
}

func (r *PGRepository) GetCustomEmote(ctx context.Context, emoteID string) (*CustomEmoteRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace emote", errors.New("workspace postgres pool is required"))
	}
	return getCustomEmote(ctx, r.pool, emoteID)
}

func getCustomEmote(ctx context.Context, queryer pgQueryer, emoteID string) (*CustomEmoteRecord, error) {
	return scanCustomEmote(queryer.QueryRow(ctx, customEmoteSelect+` WHERE id = $1`, strings.TrimSpace(emoteID)))
}

func (r *PGRepository) ListCustomEmotes(ctx context.Context, userID string, includeRemoved bool) ([]CustomEmoteRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace emotes", errors.New("workspace postgres pool is required"))
	}
	return listCustomEmotes(ctx, r.pool, userID, includeRemoved)
}

func listCustomEmotes(ctx context.Context, queryer pgQueryer, userID string, includeRemoved bool) ([]CustomEmoteRecord, error) {
	query := customEmoteSelect + ` WHERE user_id = $1`
	if !includeRemoved {
		query += ` AND removed_at IS NULL`
	}
	query += ` ORDER BY sort_order ASC, created_at ASC, id ASC`
	rows, err := queryer.Query(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CustomEmoteRecord, 0)
	for rows.Next() {
		var record CustomEmoteRecord
		var sourceAttachmentID, sourceCustomID, sourceKey, originalName, originalMIME, normalizedMIME, digest, storageKey, storageObjectID *string
		if err := rows.Scan(&record.ID, &record.UserID, &record.SourceType, &sourceAttachmentID, &sourceCustomID,
			&sourceKey, &originalName, &originalMIME, &record.Label, &normalizedMIME, &record.ByteSize,
			&record.Width, &record.Height, &record.FrameCount, &record.DurationMS, &digest,
			&storageKey, &storageObjectID, &record.SortOrder, &record.CreatedAt, &record.RemovedAt); err != nil {
			return nil, err
		}
		record.SHA256 = stringValue(digest)
		record.SourceAttachmentID, record.SourceCustomEmoteID = stringValue(sourceAttachmentID), stringValue(sourceCustomID)
		record.SourceEmoteKey, record.OriginalFileName, record.OriginalMIMEType = stringValue(sourceKey), stringValue(originalName), stringValue(originalMIME)
		record.NormalizedMIMEType, record.StorageKey, record.StorageObjectID = stringValue(normalizedMIME), stringValue(storageKey), stringValue(storageObjectID)
		record.CreatedAt = record.CreatedAt.UTC()
		if record.RemovedAt != nil {
			removed := record.RemovedAt.UTC()
			record.RemovedAt = &removed
		}
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *PGRepository) FindCustomEmoteByDigest(ctx context.Context, userID, digest string) (*CustomEmoteRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find workspace emote by digest", errors.New("workspace postgres pool is required"))
	}
	return findCustomEmoteByDigest(ctx, r.pool, userID, digest)
}

func findCustomEmoteByDigest(ctx context.Context, queryer pgQueryer, userID, digest string) (*CustomEmoteRecord, error) {
	return scanCustomEmote(queryer.QueryRow(ctx, customEmoteSelect+` WHERE user_id = $1 AND sha256 = $2 ORDER BY removed_at NULLS FIRST, created_at DESC LIMIT 1`, userID, digest))
}

func (r *PGRepository) FindBuiltinEmote(ctx context.Context, userID, emoteKey string) (*CustomEmoteRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find builtin workspace emote", errors.New("workspace postgres pool is required"))
	}
	return findBuiltinEmote(ctx, r.pool, userID, emoteKey)
}

func findBuiltinEmote(ctx context.Context, queryer pgQueryer, userID, emoteKey string) (*CustomEmoteRecord, error) {
	return scanCustomEmote(queryer.QueryRow(ctx, customEmoteSelect+` WHERE user_id = $1 AND source_emote_key = $2 ORDER BY removed_at NULLS FIRST, created_at DESC LIMIT 1`, userID, emoteKey))
}

func (r *PGRepository) ListLibraryEntries(ctx context.Context, userID string) ([]LibraryEntryRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace emote library", errors.New("workspace postgres pool is required"))
	}
	return listLibraryEntries(ctx, r.pool, userID)
}

func listLibraryEntries(ctx context.Context, queryer pgQueryer, userID string) ([]LibraryEntryRecord, error) {
	rows, err := queryer.Query(ctx, `
		SELECT id, user_id, entry_type, emote_id, collection_id, sort_order, created_at
		FROM workspace_emote_library_entries WHERE user_id = $1
		ORDER BY sort_order ASC, created_at ASC, id ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]LibraryEntryRecord, 0)
	for rows.Next() {
		var record LibraryEntryRecord
		var emoteID, collectionID *string
		if err := rows.Scan(&record.ID, &record.UserID, &record.EntryType, &emoteID, &collectionID, &record.SortOrder, &record.CreatedAt); err != nil {
			return nil, err
		}
		record.EmoteID, record.CollectionID = stringValue(emoteID), stringValue(collectionID)
		record.CreatedAt = record.CreatedAt.UTC()
		result = append(result, record)
	}
	return result, rows.Err()
}

func (r *PGRepository) ListCollections(ctx context.Context, userID string) ([]CollectionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace emote collections", errors.New("workspace postgres pool is required"))
	}
	return listCollections(ctx, r.pool, userID)
}

const collectionSelect = `
	SELECT c.id, c.user_id, c.name, c.source_collection_id, c.original_creator_user_id,
		COALESCE(u.nickname, u.github_login, u.display_name, u.id), c.revision,
		c.created_at, c.updated_at, s.source_collection_id, s.status, s.source_revision, s.last_synced_at
	FROM workspace_emote_collections c
	INNER JOIN users u ON u.id = c.original_creator_user_id
	LEFT JOIN workspace_emote_collection_subscriptions s ON s.collection_id = c.id
`

func scanCollection(row pgx.Row) (*CollectionRecord, error) {
	var record CollectionRecord
	var sourceID, subscriptionSourceID, status *string
	err := row.Scan(&record.ID, &record.UserID, &record.Name, &sourceID, &record.OriginalCreatorID,
		&record.OriginalCreatorName, &record.Revision, &record.CreatedAt, &record.UpdatedAt,
		&subscriptionSourceID, &status, &record.SubscriptionSourceRevision, &record.SubscriptionLastSyncedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.SourceCollectionID = stringValue(sourceID)
	record.SubscriptionSourceCollectionID = stringValue(subscriptionSourceID)
	record.SubscriptionStatus = stringValue(status)
	record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
	if record.SubscriptionLastSyncedAt != nil {
		value := record.SubscriptionLastSyncedAt.UTC()
		record.SubscriptionLastSyncedAt = &value
	}
	return &record, nil
}

func listCollections(ctx context.Context, queryer pgQueryer, userID string) ([]CollectionRecord, error) {
	rows, err := queryer.Query(ctx, collectionSelect+` WHERE c.user_id = $1 ORDER BY c.updated_at DESC, c.created_at DESC, c.id ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CollectionRecord, 0)
	for rows.Next() {
		var record CollectionRecord
		var sourceID, subscriptionSourceID, status *string
		if err := rows.Scan(&record.ID, &record.UserID, &record.Name, &sourceID, &record.OriginalCreatorID,
			&record.OriginalCreatorName, &record.Revision, &record.CreatedAt, &record.UpdatedAt,
			&subscriptionSourceID, &status, &record.SubscriptionSourceRevision, &record.SubscriptionLastSyncedAt); err != nil {
			return nil, err
		}
		record.SourceCollectionID, record.SubscriptionStatus = stringValue(sourceID), stringValue(status)
		record.SubscriptionSourceCollectionID = stringValue(subscriptionSourceID)
		record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
		if record.SubscriptionLastSyncedAt != nil {
			value := record.SubscriptionLastSyncedAt.UTC()
			record.SubscriptionLastSyncedAt = &value
		}
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *PGRepository) GetCollection(ctx context.Context, userID, collectionID string) (*CollectionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace emote collection", errors.New("workspace postgres pool is required"))
	}
	return getCollection(ctx, r.pool, userID, collectionID)
}

func (r *PGRepository) GetCollectionByID(ctx context.Context, collectionID string) (*CollectionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace emote collection", errors.New("workspace postgres pool is required"))
	}
	return getCollectionByID(ctx, r.pool, collectionID)
}

func getCollection(ctx context.Context, queryer pgQueryer, userID, collectionID string) (*CollectionRecord, error) {
	return scanCollection(queryer.QueryRow(ctx, collectionSelect+` WHERE c.user_id = $1 AND c.id = $2`, userID, collectionID))
}

func getCollectionByID(ctx context.Context, queryer pgQueryer, collectionID string) (*CollectionRecord, error) {
	return scanCollection(queryer.QueryRow(ctx, collectionSelect+` WHERE c.id = $1`, strings.TrimSpace(collectionID)))
}

func (r *PGRepository) ListCollectionItems(ctx context.Context, collectionID string) ([]CollectionItemRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace emote collection items", errors.New("workspace postgres pool is required"))
	}
	return listCollectionItems(ctx, r.pool, collectionID)
}

func listCollectionItems(ctx context.Context, queryer pgQueryer, collectionID string) ([]CollectionItemRecord, error) {
	rows, err := queryer.Query(ctx, `
		SELECT collection_id, emote_id, sort_order, added_at
		FROM workspace_emote_collection_items WHERE collection_id = $1
		ORDER BY sort_order ASC, added_at ASC, emote_id ASC
	`, collectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CollectionItemRecord, 0)
	for rows.Next() {
		var item CollectionItemRecord
		if err := rows.Scan(&item.CollectionID, &item.EmoteID, &item.SortOrder, &item.AddedAt); err != nil {
			return nil, err
		}
		item.AddedAt = item.AddedAt.UTC()
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *PGRepository) MutableCollectionIDsForEmote(ctx context.Context, userID, emoteID string) ([]string, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list mutable emote collections", errors.New("workspace postgres pool is required"))
	}
	return mutableCollectionIDsForEmote(ctx, r.pool, userID, emoteID)
}

func mutableCollectionIDsForEmote(ctx context.Context, queryer pgQueryer, userID, emoteID string) ([]string, error) {
	rows, err := queryer.Query(ctx, `
		SELECT c.id
		FROM workspace_emote_collection_items ci
		INNER JOIN workspace_emote_collections c ON c.id = ci.collection_id AND c.user_id = $1
		LEFT JOIN workspace_emote_collection_subscriptions s ON s.collection_id = c.id AND s.status = 'active'
		WHERE ci.emote_id = $2 AND s.id IS NULL
		ORDER BY c.id ASC
	`, userID, emoteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func (r *PGRepository) IsEmoteSubscriptionReadOnly(ctx context.Context, userID, emoteID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check emote subscription", errors.New("workspace postgres pool is required"))
	}
	return isEmoteSubscriptionReadOnly(ctx, r.pool, userID, emoteID)
}

func (r *PGRepository) IsEmoteLocallyPlaced(ctx context.Context, userID, emoteID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check local emote placement", errors.New("workspace postgres pool is required"))
	}
	return isEmoteLocallyPlaced(ctx, r.pool, userID, emoteID)
}

func isEmoteSubscriptionReadOnly(ctx context.Context, queryer pgQueryer, userID, emoteID string) (bool, error) {
	var result bool
	err := queryer.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM workspace_emote_collection_subscription_items si
			INNER JOIN workspace_emote_collection_subscriptions s ON s.id = si.subscription_id
			WHERE si.target_emote_id = $1 AND s.subscriber_user_id = $2 AND s.status = 'active'
		)
	`, emoteID, userID).Scan(&result)
	return result, err
}

func isEmoteLocallyPlaced(ctx context.Context, queryer pgQueryer, userID, emoteID string) (bool, error) {
	var result bool
	err := queryer.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM workspace_emote_library_entries
			WHERE user_id = $1 AND emote_id = $2
			UNION ALL
			SELECT 1
			FROM workspace_emote_collection_items ci
			INNER JOIN workspace_emote_collections c ON c.id = ci.collection_id AND c.user_id = $1
			LEFT JOIN workspace_emote_collection_subscriptions s
				ON s.collection_id = c.id AND s.status = 'active'
			WHERE ci.emote_id = $2 AND s.id IS NULL
		)
	`, userID, emoteID).Scan(&result)
	return result, err
}

func (r *PGRepository) GetCollectionSubscription(ctx context.Context, collectionID string) (*CollectionSubscriptionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace emote collection subscription", errors.New("workspace postgres pool is required"))
	}
	return getCollectionSubscription(ctx, r.pool, collectionID)
}

func (r *PGRepository) GetCollectionSubscriptionByID(ctx context.Context, subscriptionID string) (*CollectionSubscriptionRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace emote collection subscription", errors.New("workspace postgres pool is required"))
	}
	return getCollectionSubscriptionByID(ctx, r.pool, subscriptionID)
}

func scanCollectionSubscription(row pgx.Row) (*CollectionSubscriptionRecord, error) {
	var record CollectionSubscriptionRecord
	err := row.Scan(&record.ID, &record.CollectionID, &record.SubscriberUserID, &record.SourceCollectionID,
		&record.SourceOwnerUserID, &record.Status, &record.SourceRevision, &record.LastSyncedAt,
		&record.DetachedAt, &record.CreatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
	if record.LastSyncedAt != nil {
		value := record.LastSyncedAt.UTC()
		record.LastSyncedAt = &value
	}
	if record.DetachedAt != nil {
		value := record.DetachedAt.UTC()
		record.DetachedAt = &value
	}
	return &record, nil
}

func getCollectionSubscription(ctx context.Context, queryer pgQueryer, collectionID string) (*CollectionSubscriptionRecord, error) {
	return scanCollectionSubscription(queryer.QueryRow(ctx, `
		SELECT id, collection_id, subscriber_user_id, source_collection_id, source_owner_user_id,
			status, source_revision, last_synced_at, detached_at, created_at, updated_at
		FROM workspace_emote_collection_subscriptions WHERE collection_id = $1
	`, strings.TrimSpace(collectionID)))
}

func getCollectionSubscriptionByID(ctx context.Context, queryer pgQueryer, subscriptionID string) (*CollectionSubscriptionRecord, error) {
	return scanCollectionSubscription(queryer.QueryRow(ctx, `
		SELECT id, collection_id, subscriber_user_id, source_collection_id, source_owner_user_id,
			status, source_revision, last_synced_at, detached_at, created_at, updated_at
		FROM workspace_emote_collection_subscriptions WHERE id = $1
	`, strings.TrimSpace(subscriptionID)))
}

func (r *PGRepository) ListSubscriptionItems(ctx context.Context, subscriptionID string) ([]CollectionSubscriptionItemRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace emote subscription items", errors.New("workspace postgres pool is required"))
	}
	return listSubscriptionItems(ctx, r.pool, subscriptionID)
}

func listSubscriptionItems(ctx context.Context, queryer pgQueryer, subscriptionID string) ([]CollectionSubscriptionItemRecord, error) {
	rows, err := queryer.Query(ctx, `
		SELECT subscription_id, source_emote_id, target_emote_id, source_sort_order, created_at, updated_at
		FROM workspace_emote_collection_subscription_items
		WHERE subscription_id = $1 ORDER BY source_sort_order ASC, source_emote_id ASC
	`, strings.TrimSpace(subscriptionID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CollectionSubscriptionItemRecord, 0)
	for rows.Next() {
		var item CollectionSubscriptionItemRecord
		if err := rows.Scan(&item.SubscriptionID, &item.SourceEmoteID, &item.TargetEmoteID, &item.SourceSortOrder, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.CreatedAt, item.UpdatedAt = item.CreatedAt.UTC(), item.UpdatedAt.UTC()
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *PGRepository) GetShare(ctx context.Context, shareID string) (*ShareRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace emote share", errors.New("workspace postgres pool is required"))
	}
	return getShare(ctx, r.pool, shareID)
}

func getShare(ctx context.Context, queryer pgQueryer, shareID string) (*ShareRecord, error) {
	var record ShareRecord
	err := queryer.QueryRow(ctx, `
		SELECT s.id, COALESCE(s.collection_id, ''), s.shared_by_user_id,
			COALESCE(su.nickname, su.github_login, su.display_name, su.id),
			s.original_creator_user_id,
			COALESCE(ou.nickname, ou.github_login, ou.display_name, ou.id),
			s.snapshot_name, s.fingerprint, s.item_count, s.created_at, s.revoked_at
		FROM workspace_emote_collection_shares s
		INNER JOIN users su ON su.id = s.shared_by_user_id
		INNER JOIN users ou ON ou.id = s.original_creator_user_id
		WHERE s.id = $1
	`, strings.TrimSpace(shareID)).Scan(&record.ID, &record.SourceCollectionID, &record.SharedByID,
		&record.SharedByName, &record.OriginalCreatorID, &record.OriginalCreatorName, &record.Name,
		&record.Fingerprint, &record.ItemCount, &record.CreatedAt, &record.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.CreatedAt = record.CreatedAt.UTC()
	if record.RevokedAt != nil {
		value := record.RevokedAt.UTC()
		record.RevokedAt = &value
	}
	return &record, nil
}

func (r *PGRepository) ListShareItems(ctx context.Context, shareID string) ([]ShareItemRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace emote share items", errors.New("workspace postgres pool is required"))
	}
	return listShareItems(ctx, r.pool, shareID)
}

func listShareItems(ctx context.Context, queryer pgQueryer, shareID string) ([]ShareItemRecord, error) {
	rows, err := queryer.Query(ctx, `
		SELECT share_id, emote_id, sort_order
		FROM workspace_emote_collection_share_items WHERE share_id = $1
		ORDER BY sort_order ASC, emote_id ASC
	`, shareID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ShareItemRecord, 0)
	for rows.Next() {
		var item ShareItemRecord
		if err := rows.Scan(&item.ShareID, &item.EmoteID, &item.SortOrder); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *PGRepository) EmoteVisibleTo(ctx context.Context, spaceID, actorID, emoteID string) (bool, error) {
	if r == nil || r.pool == nil {
		return false, internalError("check workspace emote visibility", errors.New("workspace postgres pool is required"))
	}
	return emoteVisibleTo(ctx, r.pool, spaceID, actorID, emoteID)
}

func emoteVisibleTo(ctx context.Context, queryer pgQueryer, spaceID, actorID, emoteID string) (bool, error) {
	var visible bool
	err := queryer.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM message_custom_emotes mce
			INNER JOIN messages m ON m.id = mce.message_id AND m.space_id = $1
			INNER JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
			WHERE mce.custom_emote_id = $3 AND cm.user_id = $2 AND cm.removed_at IS NULL
			  AND m.deleted_at IS NULL
		)
	`, spaceID, actorID, emoteID).Scan(&visible)
	return visible, err
}

func (r *PGRepository) EmoteUsage(ctx context.Context, userID, ignoredSubscriptionID string) (EmoteUsage, error) {
	if r == nil || r.pool == nil {
		return EmoteUsage{}, internalError("read workspace emote usage", errors.New("workspace postgres pool is required"))
	}
	return emoteUsage(ctx, r.pool, userID, ignoredSubscriptionID)
}

func emoteUsage(ctx context.Context, queryer pgQueryer, userID, ignoredSubscriptionID string) (EmoteUsage, error) {
	rows, err := queryer.Query(ctx, `
		SELECT e.id, COALESCE(e.byte_size, 0),
			EXISTS (
				SELECT 1
				FROM workspace_emote_collection_subscription_items si
				INNER JOIN workspace_emote_collection_subscriptions s ON s.id = si.subscription_id
				WHERE si.target_emote_id = e.id AND s.subscriber_user_id = $1
				  AND s.status = 'active' AND s.id <> $2
			),
			EXISTS (
				SELECT 1 FROM workspace_emote_library_entries le
				WHERE le.user_id = $1 AND le.emote_id = e.id
				UNION ALL
				SELECT 1
				FROM workspace_emote_collection_items ci
				INNER JOIN workspace_emote_collections c ON c.id = ci.collection_id AND c.user_id = $1
				LEFT JOIN workspace_emote_collection_subscriptions s
				  ON s.collection_id = c.id AND s.status = 'active' AND s.id <> $2
				WHERE ci.emote_id = e.id AND s.id IS NULL
			)
		FROM workspace_custom_emotes e
		WHERE e.user_id = $1 AND e.removed_at IS NULL
	`, userID, ignoredSubscriptionID)
	if err != nil {
		return EmoteUsage{}, err
	}
	defer rows.Close()
	var usage EmoteUsage
	for rows.Next() {
		var id string
		var bytes int64
		var subscribed, local bool
		if err := rows.Scan(&id, &bytes, &subscribed, &local); err != nil {
			return EmoteUsage{}, err
		}
		usage.AllTotalBytes += bytes
		if subscribed && !local {
			usage.SubscribedItemCount++
			usage.SubscribedTotalBytes += bytes
		} else {
			usage.ItemCount++
			usage.TotalBytes += bytes
		}
	}
	if err := rows.Err(); err != nil {
		return EmoteUsage{}, err
	}
	if err := queryer.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END), 0)
		FROM workspace_emote_collections c
		LEFT JOIN workspace_emote_collection_subscriptions s ON s.collection_id = c.id
		WHERE c.user_id = $1
	`, userID).Scan(&usage.CollectionCount, &usage.SubscribedCollectionCount); err != nil {
		return EmoteUsage{}, err
	}
	usage.TotalItemCount = usage.ItemCount + usage.SubscribedItemCount
	usage.OverLimit = usage.TotalBytes > MaxTotalBytes
	return usage, nil
}

func (r *PGRepository) GetStorageObject(ctx context.Context, objectID string, includeDeleted bool) (*StorageObjectRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read workspace emote storage object", errors.New("workspace postgres pool is required"))
	}
	return getStorageObject(ctx, r.pool, objectID, includeDeleted)
}

func getStorageObject(ctx context.Context, queryer pgQueryer, objectID string, includeDeleted bool) (*StorageObjectRecord, error) {
	query := `SELECT id, sha256, object_key, byte_size, COALESCE(content_type, ''), created_at, verified_at, deleted_at FROM workspace_storage_objects WHERE id = $1`
	if !includeDeleted {
		query += ` AND deleted_at IS NULL`
	}
	var record StorageObjectRecord
	err := queryer.QueryRow(ctx, query, objectID).Scan(&record.ID, &record.SHA256, &record.ObjectKey, &record.ByteSize, &record.ContentType, &record.CreatedAt, &record.VerifiedAt, &record.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.CreatedAt = record.CreatedAt.UTC()
	if record.VerifiedAt != nil {
		value := record.VerifiedAt.UTC()
		record.VerifiedAt = &value
	}
	if record.DeletedAt != nil {
		value := record.DeletedAt.UTC()
		record.DeletedAt = &value
	}
	return &record, nil
}

func (r *PGRepository) StorageObjectReferenceCount(ctx context.Context, objectID string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count workspace emote storage references", errors.New("workspace postgres pool is required"))
	}
	return storageObjectReferenceCount(ctx, r.pool, objectID)
}

func storageObjectReferenceCount(ctx context.Context, queryer pgQueryer, objectID string) (int64, error) {
	var count int64
	err := queryer.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM attachments WHERE storage_object_id = $1) +
			(SELECT COUNT(*) FROM users WHERE avatar_storage_object_id = $1) +
			(SELECT COUNT(*) FROM workspace_custom_emotes WHERE storage_object_id = $1)
	`, objectID).Scan(&count)
	return count, err
}

type pgTx struct {
	tx         pgx.Tx
	repository *PGRepository
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID)
}

func (t *pgTx) GetSettings(ctx context.Context, userID string) (SettingsRecord, error) {
	return getSettings(ctx, t.tx, userID)
}

func (t *pgTx) ListCustomEmotes(ctx context.Context, userID string, includeRemoved bool) ([]CustomEmoteRecord, error) {
	return listCustomEmotes(ctx, t.tx, userID, includeRemoved)
}

func (t *pgTx) GetCustomEmote(ctx context.Context, emoteID string) (*CustomEmoteRecord, error) {
	return getCustomEmote(ctx, t.tx, emoteID)
}

func (t *pgTx) FindCustomEmoteByDigest(ctx context.Context, userID, digest string) (*CustomEmoteRecord, error) {
	return findCustomEmoteByDigest(ctx, t.tx, userID, digest)
}

func (t *pgTx) FindBuiltinEmote(ctx context.Context, userID, emoteKey string) (*CustomEmoteRecord, error) {
	return findBuiltinEmote(ctx, t.tx, userID, emoteKey)
}

func (t *pgTx) ListLibraryEntries(ctx context.Context, userID string) ([]LibraryEntryRecord, error) {
	return listLibraryEntries(ctx, t.tx, userID)
}

func (t *pgTx) ListCollections(ctx context.Context, userID string) ([]CollectionRecord, error) {
	return listCollections(ctx, t.tx, userID)
}

func (t *pgTx) GetCollection(ctx context.Context, userID, collectionID string) (*CollectionRecord, error) {
	return getCollection(ctx, t.tx, userID, collectionID)
}

func (t *pgTx) GetCollectionByID(ctx context.Context, collectionID string) (*CollectionRecord, error) {
	return getCollectionByID(ctx, t.tx, collectionID)
}

func (t *pgTx) ListCollectionItems(ctx context.Context, collectionID string) ([]CollectionItemRecord, error) {
	return listCollectionItems(ctx, t.tx, collectionID)
}

func (t *pgTx) MutableCollectionIDsForEmote(ctx context.Context, userID, emoteID string) ([]string, error) {
	return mutableCollectionIDsForEmote(ctx, t.tx, userID, emoteID)
}

func (t *pgTx) IsEmoteSubscriptionReadOnly(ctx context.Context, userID, emoteID string) (bool, error) {
	return isEmoteSubscriptionReadOnly(ctx, t.tx, userID, emoteID)
}

func (t *pgTx) IsEmoteLocallyPlaced(ctx context.Context, userID, emoteID string) (bool, error) {
	return isEmoteLocallyPlaced(ctx, t.tx, userID, emoteID)
}

func (t *pgTx) GetCollectionSubscription(ctx context.Context, collectionID string) (*CollectionSubscriptionRecord, error) {
	return getCollectionSubscription(ctx, t.tx, collectionID)
}

func (t *pgTx) GetCollectionSubscriptionByID(ctx context.Context, subscriptionID string) (*CollectionSubscriptionRecord, error) {
	return getCollectionSubscriptionByID(ctx, t.tx, subscriptionID)
}

func (t *pgTx) ListSubscriptionItems(ctx context.Context, subscriptionID string) ([]CollectionSubscriptionItemRecord, error) {
	return listSubscriptionItems(ctx, t.tx, subscriptionID)
}

func (t *pgTx) GetShare(ctx context.Context, shareID string) (*ShareRecord, error) {
	return getShare(ctx, t.tx, shareID)
}

func (t *pgTx) ListShareItems(ctx context.Context, shareID string) ([]ShareItemRecord, error) {
	return listShareItems(ctx, t.tx, shareID)
}

func (t *pgTx) EmoteVisibleTo(ctx context.Context, spaceID, actorID, emoteID string) (bool, error) {
	return emoteVisibleTo(ctx, t.tx, spaceID, actorID, emoteID)
}

func (t *pgTx) EmoteUsage(ctx context.Context, userID, ignoredSubscriptionID string) (EmoteUsage, error) {
	return emoteUsage(ctx, t.tx, userID, ignoredSubscriptionID)
}

func (t *pgTx) GetStorageObject(ctx context.Context, objectID string, includeDeleted bool) (*StorageObjectRecord, error) {
	return getStorageObject(ctx, t.tx, objectID, includeDeleted)
}

func (t *pgTx) StorageObjectReferenceCount(ctx context.Context, objectID string) (int64, error) {
	return storageObjectReferenceCount(ctx, t.tx, objectID)
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return errors.New("workspace emote lock key is required")
	}
	_, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

func (t *pgTx) UpsertSettings(ctx context.Context, userID, enabledPackIDsJSON string, clickImageEmoteToSend, replyAutoMention bool, at time.Time) error {
	if !json.Valid([]byte(enabledPackIDsJSON)) {
		return errors.New("emote settings are not valid JSON")
	}
	_, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_emote_preferences (
			user_id, enabled_pack_ids_json, click_image_emote_to_send, reply_auto_mention, updated_at
		) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (user_id) DO UPDATE SET
			enabled_pack_ids_json = EXCLUDED.enabled_pack_ids_json,
			click_image_emote_to_send = EXCLUDED.click_image_emote_to_send,
			reply_auto_mention = EXCLUDED.reply_auto_mention,
			updated_at = EXCLUDED.updated_at
	`, userID, enabledPackIDsJSON, clickImageEmoteToSend, replyAutoMention, at.UTC())
	return err
}

func (t *pgTx) AcquireStorageObject(ctx context.Context, record StorageObjectRecord) (*StorageObjectRecord, error) {
	if record.ID == "" || record.SHA256 == "" || record.ObjectKey == "" || record.ByteSize < 0 {
		return nil, errors.New("workspace emote storage object fields are required")
	}
	var result StorageObjectRecord
	err := t.tx.QueryRow(ctx, `
		INSERT INTO workspace_storage_objects (
			id, sha256, object_key, byte_size, content_type, created_at, verified_at, deleted_at
		) VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, NULL)
		ON CONFLICT (sha256) DO UPDATE SET
			content_type = COALESCE(workspace_storage_objects.content_type, EXCLUDED.content_type),
			deleted_at = NULL
		RETURNING id, sha256, object_key, byte_size, COALESCE(content_type, ''), created_at, verified_at, deleted_at
	`, record.ID, record.SHA256, record.ObjectKey, record.ByteSize, record.ContentType, record.CreatedAt.UTC(), record.VerifiedAt).Scan(
		&result.ID, &result.SHA256, &result.ObjectKey, &result.ByteSize, &result.ContentType,
		&result.CreatedAt, &result.VerifiedAt, &result.DeletedAt)
	if err != nil {
		return nil, err
	}
	if result.ID != record.ID || result.SHA256 != record.SHA256 || result.ObjectKey != record.ObjectKey || result.ByteSize != record.ByteSize {
		return nil, fmt.Errorf("workspace emote storage identity conflict")
	}
	result.CreatedAt = result.CreatedAt.UTC()
	return &result, nil
}

func (t *pgTx) BindStorageObject(ctx context.Context, emoteID, storageObjectID string) error {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_custom_emotes SET storage_object_id = $2
		WHERE id = $1
	`, emoteID, storageObjectID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("workspace emote does not exist")
	}
	return nil
}

func (t *pgTx) InsertCustomEmote(ctx context.Context, record CustomEmoteRecord) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_custom_emotes (
			id, user_id, source_type, source_attachment_id, source_custom_emote_id,
			source_emote_key, original_file_name, original_mime_type, label,
			normalized_mime_type, byte_size, width, height, frame_count, duration_ms,
			sha256, storage_key, storage_object_id, sort_order, created_at, removed_at
		) VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
			NULLIF($8, ''), $9, NULLIF($10, ''), $11, $12, $13, $14, $15, NULLIF($16, ''),
			NULLIF($17, ''), NULLIF($18, ''), $19, $20, $21)
		ON CONFLICT (id) DO NOTHING
	`, record.ID, record.UserID, record.SourceType, record.SourceAttachmentID, record.SourceCustomEmoteID,
		record.SourceEmoteKey, record.OriginalFileName, record.OriginalMIMEType, record.Label, record.NormalizedMIMEType,
		record.ByteSize, record.Width, record.Height, record.FrameCount, record.DurationMS, record.SHA256,
		record.StorageKey, record.StorageObjectID, record.SortOrder, record.CreatedAt.UTC(), record.RemovedAt)
	if err != nil {
		return false, err
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) RestoreCustomEmote(ctx context.Context, userID, emoteID string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_custom_emotes SET removed_at = NULL
		WHERE id = $1 AND user_id = $2
	`, emoteID, userID)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) EnsureLibraryEntry(ctx context.Context, entry LibraryEntryRecord) (bool, error) {
	if entry.EntryType != "emote" && entry.EntryType != "collection" {
		return false, errors.New("workspace emote library entry type is invalid")
	}
	var sortOrder int64
	if entry.SortOrder < 0 {
		sortOrder = -1
	} else {
		sortOrder = entry.SortOrder
	}
	err := t.tx.QueryRow(ctx, `
		WITH next_order AS (
			SELECT CASE WHEN $5::bigint < 0 THEN COALESCE(MIN(sort_order), 0) - 1 ELSE $5::bigint END AS value
			FROM workspace_emote_library_entries WHERE user_id = $1
		)
		INSERT INTO workspace_emote_library_entries (
			id, user_id, entry_type, emote_id, collection_id, sort_order, created_at
		) VALUES ($2, $1, $3, NULLIF($4, ''), NULLIF($6, ''), (SELECT value FROM next_order), $7)
		ON CONFLICT DO NOTHING
		RETURNING 1
	`, entry.UserID, entry.ID, entry.EntryType, entry.EmoteID, sortOrder, entry.CollectionID, entry.CreatedAt.UTC()).Scan(new(int))
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (t *pgTx) DeleteLibraryEntry(ctx context.Context, userID, emoteID, collectionID string) (bool, error) {
	var result pgconn.CommandTag
	var err error
	if strings.TrimSpace(emoteID) != "" {
		result, err = t.tx.Exec(ctx, `DELETE FROM workspace_emote_library_entries WHERE user_id = $1 AND emote_id = $2`, userID, emoteID)
	} else {
		result, err = t.tx.Exec(ctx, `DELETE FROM workspace_emote_library_entries WHERE user_id = $1 AND collection_id = $2`, userID, collectionID)
	}
	return result.RowsAffected() > 0, err
}

func (t *pgTx) DeleteCollectionEmoteLinks(ctx context.Context, userID, emoteID string) error {
	_, err := t.tx.Exec(ctx, `
		DELETE FROM workspace_emote_collection_items ci
		USING workspace_emote_collections c
		WHERE ci.collection_id = c.id AND c.user_id = $1 AND ci.emote_id = $2
	`, userID, emoteID)
	return err
}

func (t *pgTx) MarkCustomEmoteRemoved(ctx context.Context, userID, emoteID string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_custom_emotes SET removed_at = COALESCE(removed_at, $3)
		WHERE id = $1 AND user_id = $2
	`, emoteID, userID, at.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) UpdateCustomEmoteLabel(ctx context.Context, userID, emoteID, label string) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_custom_emotes SET label = $3
		WHERE id = $1 AND user_id = $2 AND removed_at IS NULL
	`, emoteID, userID, label)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) DeleteUnreferencedEmote(ctx context.Context, emoteID string) (*CustomEmoteRecord, bool, error) {
	row, err := getCustomEmoteForUpdate(ctx, t.tx, emoteID)
	if err != nil || row == nil {
		return row, false, err
	}
	referenced, err := customEmoteReferenced(ctx, t.tx, emoteID)
	if err != nil {
		return nil, false, err
	}
	if referenced {
		return row, false, nil
	}
	result, err := t.tx.Exec(ctx, `DELETE FROM workspace_custom_emotes WHERE id = $1`, emoteID)
	if err != nil {
		return nil, false, err
	}
	return row, result.RowsAffected() == 1, nil
}

func getCustomEmoteForUpdate(ctx context.Context, queryer pgQueryer, emoteID string) (*CustomEmoteRecord, error) {
	return scanCustomEmote(queryer.QueryRow(ctx, customEmoteSelect+` WHERE id = $1 FOR UPDATE`, emoteID))
}

func customEmoteReferenced(ctx context.Context, queryer pgQueryer, emoteID string) (bool, error) {
	var referenced bool
	err := queryer.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM workspace_emote_library_entries WHERE emote_id = $1
			UNION ALL SELECT 1 FROM workspace_emote_collection_items WHERE emote_id = $1
			UNION ALL SELECT 1 FROM message_custom_emotes WHERE custom_emote_id = $1
			UNION ALL SELECT 1 FROM workspace_custom_emotes WHERE source_custom_emote_id = $1
			UNION ALL SELECT 1 FROM workspace_emote_collection_share_items WHERE emote_id = $1
			UNION ALL SELECT 1 FROM workspace_emote_collection_subscription_items WHERE source_emote_id = $1
		)
	`, emoteID).Scan(&referenced)
	return referenced, err
}

func (t *pgTx) InsertCollection(ctx context.Context, record CollectionRecord) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_emote_collections (
			id, user_id, name, source_collection_id, original_creator_user_id,
			created_at, updated_at, revision
		) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, $7, $8)
	`, record.ID, record.UserID, record.Name, record.SourceCollectionID, record.OriginalCreatorID,
		record.CreatedAt.UTC(), record.UpdatedAt.UTC(), positiveRevision(record.Revision))
	return err
}

func (t *pgTx) ListSubscriptionsBySource(ctx context.Context, sourceCollectionID, status string) ([]CollectionSubscriptionRecord, error) {
	status = strings.TrimSpace(status)
	if status != "active" && status != "off" {
		return nil, errors.New("workspace emote subscription status is invalid")
	}
	rows, err := t.tx.Query(ctx, `
		SELECT id, collection_id, subscriber_user_id, source_collection_id, source_owner_user_id,
			status, source_revision, last_synced_at, detached_at, created_at, updated_at
		FROM workspace_emote_collection_subscriptions
		WHERE source_collection_id = $1 AND status = $2
		ORDER BY created_at ASC, id ASC
	`, strings.TrimSpace(sourceCollectionID), status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CollectionSubscriptionRecord, 0)
	for rows.Next() {
		var record CollectionSubscriptionRecord
		if err := rows.Scan(&record.ID, &record.CollectionID, &record.SubscriberUserID, &record.SourceCollectionID,
			&record.SourceOwnerUserID, &record.Status, &record.SourceRevision, &record.LastSyncedAt,
			&record.DetachedAt, &record.CreatedAt, &record.UpdatedAt); err != nil {
			return nil, err
		}
		record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
		if record.LastSyncedAt != nil {
			value := record.LastSyncedAt.UTC()
			record.LastSyncedAt = &value
		}
		if record.DetachedAt != nil {
			value := record.DetachedAt.UTC()
			record.DetachedAt = &value
		}
		result = append(result, record)
	}
	return result, rows.Err()
}

func (t *pgTx) UpsertCollectionSubscription(ctx context.Context, record CollectionSubscriptionRecord) (bool, error) {
	if record.ID == "" || record.CollectionID == "" || record.SubscriberUserID == "" || record.SourceCollectionID == "" || record.SourceOwnerUserID == "" {
		return false, errors.New("workspace emote subscription fields are required")
	}
	if record.Status != "active" && record.Status != "off" && record.Status != "detached" {
		return false, errors.New("workspace emote subscription status is invalid")
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = record.UpdatedAt
	}
	if record.UpdatedAt.IsZero() {
		record.UpdatedAt = record.CreatedAt
	}
	result, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_emote_collection_subscriptions (
			id, collection_id, subscriber_user_id, source_collection_id, source_owner_user_id,
			status, source_revision, last_synced_at, detached_at, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (collection_id) DO UPDATE SET
			subscriber_user_id = EXCLUDED.subscriber_user_id,
			source_collection_id = EXCLUDED.source_collection_id,
			source_owner_user_id = EXCLUDED.source_owner_user_id,
			status = EXCLUDED.status,
			source_revision = EXCLUDED.source_revision,
			last_synced_at = EXCLUDED.last_synced_at,
			detached_at = EXCLUDED.detached_at,
			updated_at = EXCLUDED.updated_at
	`, record.ID, record.CollectionID, record.SubscriberUserID, record.SourceCollectionID,
		record.SourceOwnerUserID, record.Status, record.SourceRevision, timePointerValue(record.LastSyncedAt),
		timePointerValue(record.DetachedAt), record.CreatedAt.UTC(), record.UpdatedAt.UTC())
	return result.RowsAffected() == 1, err
}

func timePointerValue(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC()
}

func (t *pgTx) UpdateCollectionSubscription(ctx context.Context, subscriptionID, status string, sourceRevision int64, lastSyncedAt, detachedAt *time.Time, at time.Time) (bool, error) {
	if status != "active" && status != "off" && status != "detached" {
		return false, errors.New("workspace emote subscription status is invalid")
	}
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_emote_collection_subscriptions
		SET status = $2, source_revision = $3, last_synced_at = $4, detached_at = $5, updated_at = $6
		WHERE id = $1
	`, strings.TrimSpace(subscriptionID), status, sourceRevision, timePointerValue(lastSyncedAt), timePointerValue(detachedAt), at.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) DeleteCollectionItems(ctx context.Context, collectionID string) error {
	_, err := t.tx.Exec(ctx, `DELETE FROM workspace_emote_collection_items WHERE collection_id = $1`, strings.TrimSpace(collectionID))
	return err
}

func (t *pgTx) DeleteSubscriptionItems(ctx context.Context, subscriptionID string) error {
	_, err := t.tx.Exec(ctx, `DELETE FROM workspace_emote_collection_subscription_items WHERE subscription_id = $1`, strings.TrimSpace(subscriptionID))
	return err
}

func (t *pgTx) InsertSubscriptionItem(ctx context.Context, item CollectionSubscriptionItemRecord) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_emote_collection_subscription_items (
			subscription_id, source_emote_id, target_emote_id, source_sort_order, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6)
	`, item.SubscriptionID, item.SourceEmoteID, item.TargetEmoteID, item.SourceSortOrder, item.CreatedAt.UTC(), item.UpdatedAt.UTC())
	return err
}

func (t *pgTx) UpdateCollectionFromSource(ctx context.Context, userID, collectionID, name, sourceCollectionID, originalCreatorID string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_emote_collections
		SET name = $3, source_collection_id = $4, original_creator_user_id = $5,
			revision = revision + 1, updated_at = $6
		WHERE id = $1 AND user_id = $2
	`, strings.TrimSpace(collectionID), strings.TrimSpace(userID), name, strings.TrimSpace(sourceCollectionID), strings.TrimSpace(originalCreatorID), at.UTC())
	return result.RowsAffected() == 1, err
}

func positiveRevision(value int64) int64 {
	if value <= 0 {
		return 1
	}
	return value
}

func (t *pgTx) UpdateCollectionName(ctx context.Context, userID, collectionID, name string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_emote_collections
		SET name = $3, revision = revision + 1, updated_at = $4
		WHERE id = $1 AND user_id = $2
	`, collectionID, userID, name, at.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) DeleteCollection(ctx context.Context, userID, collectionID string) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		DELETE FROM workspace_emote_collections WHERE id = $1 AND user_id = $2
	`, collectionID, userID)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) InsertCollectionItem(ctx context.Context, item CollectionItemRecord) (bool, error) {
	var sortOrder int64
	if item.SortOrder < 0 {
		sortOrder = -1
	} else {
		sortOrder = item.SortOrder
	}
	err := t.tx.QueryRow(ctx, `
		WITH next_order AS (
			SELECT CASE WHEN $3::bigint < 0 THEN COALESCE(MAX(sort_order), -1) + 1 ELSE $3::bigint END AS value
			FROM workspace_emote_collection_items WHERE collection_id = $1
		)
		INSERT INTO workspace_emote_collection_items (collection_id, emote_id, sort_order, added_at)
		VALUES ($1, $2, (SELECT value FROM next_order), $4)
		ON CONFLICT DO NOTHING
		RETURNING 1
	`, item.CollectionID, item.EmoteID, sortOrder, item.AddedAt.UTC()).Scan(new(int))
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (t *pgTx) DeleteCollectionItem(ctx context.Context, collectionID, emoteID string) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		DELETE FROM workspace_emote_collection_items WHERE collection_id = $1 AND emote_id = $2
	`, collectionID, emoteID)
	return result.RowsAffected() == 1, err
}

func (t *pgTx) UpdateCollectionRevision(ctx context.Context, userID, collectionID string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_emote_collections
		SET revision = revision + 1, updated_at = $3
		WHERE id = $1 AND user_id = $2
	`, collectionID, userID, at.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) ReorderLibraryEntry(ctx context.Context, userID, entryID string, sortOrder int64) error {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_emote_library_entries SET sort_order = $3
		WHERE id = $1 AND user_id = $2
	`, entryID, userID, sortOrder)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("workspace emote library entry does not exist")
	}
	return nil
}

func (t *pgTx) ReorderCollectionItem(ctx context.Context, collectionID, emoteID string, sortOrder int64) error {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_emote_collection_items SET sort_order = $3
		WHERE collection_id = $1 AND emote_id = $2
	`, collectionID, emoteID, sortOrder)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("workspace emote collection item does not exist")
	}
	return nil
}

func (t *pgTx) FindActiveShareByFingerprint(ctx context.Context, collectionID, userID, fingerprint string) (*ShareRecord, error) {
	var shareID string
	err := t.tx.QueryRow(ctx, `
		SELECT id FROM workspace_emote_collection_shares
		WHERE collection_id = $1 AND shared_by_user_id = $2 AND fingerprint = $3 AND revoked_at IS NULL
		ORDER BY created_at DESC, id DESC LIMIT 1
	`, collectionID, userID, fingerprint).Scan(&shareID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return getShare(ctx, t.tx, shareID)
}

func (t *pgTx) InsertShare(ctx context.Context, record ShareRecord) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_emote_collection_shares (
			id, collection_id, shared_by_user_id, original_creator_user_id,
			snapshot_name, fingerprint, item_count, created_at, revoked_at
		) VALUES ($1, NULLIF($2, ''), $3, $4, $5, $6, $7, $8, NULL)
	`, record.ID, record.SourceCollectionID, record.SharedByID, record.OriginalCreatorID,
		record.Name, record.Fingerprint, record.ItemCount, record.CreatedAt.UTC())
	return err
}

func (t *pgTx) InsertShareItem(ctx context.Context, item ShareItemRecord) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_emote_collection_share_items (share_id, emote_id, sort_order)
		VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING
	`, item.ShareID, item.EmoteID, item.SortOrder)
	return err
}

func (t *pgTx) RevokeShare(ctx context.Context, userID, shareID string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_emote_collection_shares
		SET revoked_at = COALESCE(revoked_at, $3)
		WHERE id = $1 AND shared_by_user_id = $2
	`, shareID, userID, at.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) DeleteShareItems(ctx context.Context, shareID string) error {
	_, err := t.tx.Exec(ctx, `DELETE FROM workspace_emote_collection_share_items WHERE share_id = $1`, shareID)
	return err
}

func (t *pgTx) MarkStorageObjectDeleted(ctx context.Context, objectID string, at time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `
		UPDATE workspace_storage_objects SET deleted_at = COALESCE(deleted_at, $2)
		WHERE id = $1 AND deleted_at IS NULL
	`, objectID, at.UTC())
	return result.RowsAffected() == 1, err
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" || strings.TrimSpace(input.Result) == "" || input.CreatedAt.IsZero() {
		return errors.New("workspace emote audit fields are required")
	}
	if input.ID == "" {
		id, err := t.newID()
		if err != nil {
			return err
		}
		input.ID = id
	}
	meta := (auth.RequestMeta{RequestID: input.RequestID, IPAddress: input.IPAddress, UserAgent: input.UserAgent}).Safe()
	_, err := t.tx.Exec(ctx, `
		INSERT INTO audit_logs (
			id, space_id, actor_user_id, actor_github_login, action, target_type,
			target_id, result, reason, ip_address, user_agent, request_id, created_at
		) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8,
			NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)
	`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action,
		input.TargetType, input.TargetID, input.Result, input.Reason, meta.IPAddress, meta.UserAgent,
		meta.RequestID, input.CreatedAt.UTC())
	return err
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) error {
	if strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Type) == "" || input.CreatedAt.IsZero() {
		return errors.New("workspace emote event fields are required")
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	if !json.Valid(input.PayloadJSON) {
		return errors.New("workspace emote event payload is not valid JSON")
	}
	if input.ID == "" {
		id, err := t.newID()
		if err != nil {
			return err
		}
		input.ID = id
	}
	var sequence int64
	if err := t.tx.QueryRow(ctx, `
		INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, 2)
		ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1
		RETURNING next_seq - 1
	`, input.SpaceID).Scan(&sequence); err != nil {
		return err
	}
	_, err := t.tx.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULL, NULLIF($6, ''), NULLIF($7, ''), $8, $9)
	`, input.ID, input.SpaceID, sequence, input.Type, input.ActorID, input.TargetType,
		input.TargetID, string(input.PayloadJSON), input.CreatedAt.UTC())
	return err
}

func (t *pgTx) newID() (string, error) {
	if t == nil || t.repository == nil || t.repository.idFactory == nil {
		return "", errors.New("workspace emote id factory is required")
	}
	id, err := t.repository.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("workspace emote id factory returned an empty id")
	}
	return id, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

var _ Repository = (*PGRepository)(nil)
var _ Tx = (*pgTx)(nil)
