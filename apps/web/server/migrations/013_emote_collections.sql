ALTER TABLE workspace_custom_emotes ADD COLUMN removed_at TIMESTAMPTZ;

CREATE TABLE workspace_emote_collections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_collection_id TEXT REFERENCES workspace_emote_collections(id) ON DELETE SET NULL,
  original_creator_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX workspace_emote_collections_user_idx
  ON workspace_emote_collections (user_id, updated_at DESC);

CREATE TABLE workspace_emote_library_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('emote', 'collection')),
  emote_id TEXT REFERENCES workspace_custom_emotes(id) ON DELETE CASCADE,
  collection_id TEXT REFERENCES workspace_emote_collections(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (entry_type = 'emote' AND emote_id IS NOT NULL AND collection_id IS NULL) OR
    (entry_type = 'collection' AND collection_id IS NOT NULL AND emote_id IS NULL)
  )
);

CREATE UNIQUE INDEX workspace_emote_library_user_emote_idx
  ON workspace_emote_library_entries (user_id, emote_id)
  WHERE emote_id IS NOT NULL;

CREATE UNIQUE INDEX workspace_emote_library_user_collection_idx
  ON workspace_emote_library_entries (user_id, collection_id)
  WHERE collection_id IS NOT NULL;

CREATE INDEX workspace_emote_library_user_order_idx
  ON workspace_emote_library_entries (user_id, sort_order, created_at);

CREATE TABLE workspace_emote_collection_items (
  collection_id TEXT NOT NULL REFERENCES workspace_emote_collections(id) ON DELETE CASCADE,
  emote_id TEXT NOT NULL REFERENCES workspace_custom_emotes(id),
  sort_order INTEGER NOT NULL,
  added_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (collection_id, emote_id)
);

CREATE INDEX workspace_emote_collection_items_order_idx
  ON workspace_emote_collection_items (collection_id, sort_order, added_at);

CREATE TABLE workspace_emote_collection_shares (
  id TEXT PRIMARY KEY,
  collection_id TEXT REFERENCES workspace_emote_collections(id) ON DELETE SET NULL,
  shared_by_user_id TEXT NOT NULL REFERENCES users(id),
  original_creator_user_id TEXT NOT NULL REFERENCES users(id),
  snapshot_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX workspace_emote_collection_shares_collection_idx
  ON workspace_emote_collection_shares (collection_id, created_at DESC);

CREATE TABLE workspace_emote_collection_share_items (
  share_id TEXT NOT NULL REFERENCES workspace_emote_collection_shares(id) ON DELETE CASCADE,
  emote_id TEXT NOT NULL REFERENCES workspace_custom_emotes(id),
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (share_id, emote_id)
);

CREATE INDEX workspace_emote_collection_share_items_order_idx
  ON workspace_emote_collection_share_items (share_id, sort_order);

CREATE TABLE message_emote_collection_shares (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL REFERENCES workspace_emote_collection_shares(id),
  PRIMARY KEY (message_id, share_id)
);

INSERT INTO workspace_emote_library_entries (
  id, user_id, entry_type, emote_id, collection_id, sort_order, created_at
)
SELECT
  'legacy-' || id,
  user_id,
  'emote',
  id,
  NULL,
  sort_order,
  created_at
FROM workspace_custom_emotes;
