-- Echo v0.15 domain completion. 017 owns the base requirement tables; these
-- columns keep old state labels readable while exposing the phase/status
-- contract to new clients.
ALTER TABLE echo_requirements
  ADD COLUMN phase TEXT NOT NULL DEFAULT 'proposal'
    CHECK (phase IN ('proposal', 'formal', 'archived'));

ALTER TABLE echo_requirements
  ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'planned', 'in_progress', 'delivered', 'archived'));

ALTER TABLE echo_requirements
  ADD COLUMN archive_outcome TEXT
    CHECK (archive_outcome IS NULL OR archive_outcome IN ('implemented', 'rejected', 'duplicate', 'withdrawn', 'cancelled'));

ALTER TABLE echo_requirements
  ADD COLUMN duplicate_of_public_id TEXT;

UPDATE echo_requirements
SET phase = CASE
      WHEN state IN ('collected', 'in_progress', 'implemented') THEN 'formal'
      WHEN state = 'rejected' THEN 'archived'
      ELSE 'proposal'
    END,
    status = CASE
      WHEN state = 'collected' THEN 'planned'
      WHEN state = 'in_progress' THEN 'in_progress'
      WHEN state = 'implemented' THEN 'delivered'
      WHEN state = 'rejected' THEN 'archived'
      ELSE 'pending_review'
    END,
    archive_outcome = CASE WHEN state = 'rejected' THEN 'rejected' ELSE NULL END
WHERE phase = 'proposal' AND status = 'pending_review';

ALTER TABLE echo_requirement_status_history
  ADD COLUMN from_phase TEXT;

ALTER TABLE echo_requirement_status_history
  ADD COLUMN from_status TEXT;

ALTER TABLE echo_requirement_status_history
  ADD COLUMN to_phase TEXT;

ALTER TABLE echo_requirement_status_history
  ADD COLUMN to_status TEXT;

CREATE INDEX echo_requirements_space_phase_status_idx
  ON echo_requirements (space_id, phase, status, updated_at DESC, id DESC);

CREATE TABLE echo_solicitation_sequences (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  sequence_year INTEGER NOT NULL CHECK (sequence_year >= 2000 AND sequence_year <= 9999),
  next_number INTEGER NOT NULL CHECK (next_number > 0 AND next_number <= 10000),
  PRIMARY KEY (space_id, sequence_year)
);

CREATE TABLE echo_solicitations (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  question TEXT NOT NULL,
  choice_mode TEXT NOT NULL CHECK (choice_mode IN ('single', 'multiple')),
  min_selections INTEGER NOT NULL DEFAULT 1 CHECK (min_selections >= 1),
  max_selections INTEGER NOT NULL DEFAULT 1 CHECK (max_selections >= 1),
  allow_vote_change BOOLEAN NOT NULL DEFAULT TRUE,
  result_visibility TEXT NOT NULL DEFAULT 'aggregate' CHECK (result_visibility IN ('aggregate', 'owner')),
  delivery_policy TEXT NOT NULL DEFAULT 'all_active_members' CHECK (delivery_policy IN ('all_active_members', 'none')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'withdrawn')),
  deadline TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  UNIQUE (space_id, public_id),
  UNIQUE (space_id, owner_user_id, idempotency_key),
  CHECK (max_selections >= min_selections),
  CHECK (choice_mode = 'single' AND min_selections = 1 AND max_selections = 1 OR choice_mode = 'multiple')
);

CREATE INDEX echo_solicitations_space_status_idx
  ON echo_solicitations (space_id, status, updated_at DESC, id DESC);

CREATE TABLE echo_solicitation_options (
  id TEXT PRIMARY KEY,
  solicitation_id TEXT NOT NULL REFERENCES echo_solicitations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE (solicitation_id, position),
  UNIQUE (solicitation_id, id)
);

CREATE TABLE echo_solicitation_votes (
  id TEXT PRIMARY KEY,
  solicitation_id TEXT NOT NULL REFERENCES echo_solicitations(id) ON DELETE CASCADE,
  voter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selection_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (solicitation_id, voter_user_id)
);

CREATE INDEX echo_solicitation_votes_solicitation_idx
  ON echo_solicitation_votes (solicitation_id, updated_at DESC);

CREATE TABLE echo_solicitation_idempotency (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'publish', 'close', 'withdraw', 'vote')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  solicitation_id TEXT NOT NULL REFERENCES echo_solicitations(id) ON DELETE CASCADE,
  result_json TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, actor_user_id, operation, idempotency_key)
);

CREATE TABLE echo_solicitation_deliveries (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  solicitation_id TEXT NOT NULL REFERENCES echo_solicitations(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (solicitation_id, recipient_user_id)
);

CREATE INDEX echo_solicitation_deliveries_status_idx
  ON echo_solicitation_deliveries (solicitation_id, status, updated_at);
