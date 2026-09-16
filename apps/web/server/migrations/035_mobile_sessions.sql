-- Android OAuth exchanges and refresh families. Tokens are stored as SHA-256 only.
CREATE TABLE mobile_oauth_flows (
 id TEXT PRIMARY KEY, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, client_state TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, code_hash TEXT UNIQUE, user_id TEXT REFERENCES users(id), consumed_at TIMESTAMPTZ
);
CREATE TABLE mobile_session_families (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
);
CREATE TABLE mobile_refresh_tokens (
 token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES mobile_session_families(id) ON DELETE CASCADE,
 consumed_at TIMESTAMPTZ
);
CREATE TABLE mobile_access_tokens (
 token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES mobile_session_families(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE mobile_auth_rate_limits (
 subject_hash TEXT NOT NULL, window_start TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL,
 PRIMARY KEY(subject_hash,window_start)
);
CREATE INDEX mobile_oauth_expiry_idx ON mobile_oauth_flows(expires_at);
CREATE INDEX mobile_access_family_idx ON mobile_access_tokens(family_id);
CREATE INDEX mobile_refresh_family_idx ON mobile_refresh_tokens(family_id);
