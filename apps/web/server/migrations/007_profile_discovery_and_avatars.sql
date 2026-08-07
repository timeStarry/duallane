ALTER TABLE users ADD COLUMN github_avatar_url TEXT;
ALTER TABLE users ADD COLUMN avatar_storage_key TEXT;
ALTER TABLE users ADD COLUMN avatar_version TEXT;
ALTER TABLE users ADD COLUMN avatar_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN search_discoverable BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users
SET github_avatar_url = avatar_url
WHERE kind = 'human' AND avatar_url IS NOT NULL;

