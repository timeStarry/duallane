ALTER TABLE workspace_emote_collections
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

DROP INDEX workspace_custom_emotes_user_sha_idx;
DROP INDEX workspace_custom_emotes_user_builtin_idx;

CREATE INDEX workspace_custom_emotes_user_sha_lookup_idx
  ON workspace_custom_emotes (user_id, sha256);

CREATE INDEX workspace_custom_emotes_user_builtin_lookup_idx
  ON workspace_custom_emotes (user_id, source_emote_key);

CREATE TABLE workspace_emote_collection_subscriptions (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL UNIQUE REFERENCES workspace_emote_collections(id) ON DELETE CASCADE,
  subscriber_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_collection_id TEXT NOT NULL,
  source_owner_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'off', 'detached')),
  source_revision INTEGER NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  detached_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX workspace_emote_collection_subscriptions_source_idx
  ON workspace_emote_collection_subscriptions (source_collection_id, status, updated_at);

CREATE INDEX workspace_emote_collection_subscriptions_user_idx
  ON workspace_emote_collection_subscriptions (subscriber_user_id, status, updated_at);

CREATE TABLE workspace_emote_collection_subscription_items (
  subscription_id TEXT NOT NULL REFERENCES workspace_emote_collection_subscriptions(id) ON DELETE CASCADE,
  source_emote_id TEXT NOT NULL,
  target_emote_id TEXT NOT NULL REFERENCES workspace_custom_emotes(id),
  source_sort_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (subscription_id, source_emote_id),
  UNIQUE (subscription_id, target_emote_id)
);

CREATE INDEX workspace_emote_collection_subscription_items_target_idx
  ON workspace_emote_collection_subscription_items (target_emote_id, subscription_id);
