-- Echo v0.15 domain completion. 017 was already released with a global
-- public-id constraint and a smaller idempotency/history schema. Rebuild the
-- three related tables so this migration upgrades both that schema and the
-- expanded 017 schema used by fresh test databases. The copy keeps all
-- existing rows while deriving phase/status from the legacy state labels.
DROP INDEX IF EXISTS echo_requirements_space_state_idx;
DROP INDEX IF EXISTS echo_requirements_submitter_idx;
DROP INDEX IF EXISTS echo_requirement_history_requirement_idx;
DROP INDEX IF EXISTS echo_requirement_idempotency_requirement_idx;

ALTER TABLE echo_requirements RENAME TO echo_requirements_legacy;
ALTER TABLE echo_requirement_status_history RENAME TO echo_requirement_status_history_legacy;
ALTER TABLE echo_requirement_idempotency RENAME TO echo_requirement_idempotency_legacy;

CREATE TABLE echo_requirements_v021 (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  submitter_user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('requirement', 'suggestion', 'problem')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  scenario TEXT NOT NULL,
  expected_result TEXT NOT NULL,
  related_link TEXT,
  state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'collected', 'in_progress', 'implemented', 'rejected')),
  phase TEXT NOT NULL DEFAULT 'proposal' CHECK (phase IN ('proposal', 'formal', 'archived')),
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'planned', 'in_progress', 'delivered', 'archived')),
  archive_outcome TEXT CHECK (archive_outcome IS NULL OR archive_outcome IN ('implemented', 'rejected', 'duplicate', 'withdrawn', 'cancelled')),
  duplicate_of_public_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  response TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (space_id, public_id)
);

INSERT INTO echo_requirements_v021 (
  id, public_id, space_id, submitter_user_id, type, title, detail, scenario,
  expected_result, related_link, state, phase, status, archive_outcome,
  duplicate_of_public_id, revision, response, created_at, updated_at
)
SELECT id, public_id, space_id, submitter_user_id, type, title, detail, scenario,
  expected_result, related_link, state,
  CASE WHEN state IN ('collected', 'in_progress', 'implemented') THEN 'formal'
    WHEN state = 'rejected' THEN 'archived' ELSE 'proposal' END,
  CASE WHEN state = 'collected' THEN 'planned'
    WHEN state = 'in_progress' THEN 'in_progress'
    WHEN state = 'implemented' THEN 'delivered'
    WHEN state = 'rejected' THEN 'archived'
    ELSE 'pending_review' END,
  CASE WHEN state = 'rejected' THEN 'rejected' ELSE NULL END,
  NULL, revision, response, created_at, updated_at
FROM echo_requirements_legacy;

CREATE TABLE echo_requirement_status_history_v021 (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES echo_requirements_v021(id) ON DELETE CASCADE,
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('submitted', 'collected', 'in_progress', 'implemented', 'rejected')),
  to_state TEXT NOT NULL CHECK (to_state IN ('submitted', 'collected', 'in_progress', 'implemented', 'rejected')),
  from_phase TEXT,
  from_status TEXT,
  to_phase TEXT,
  to_status TEXT,
  response TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (requirement_id, revision),
  CHECK ((revision = 1 AND from_state IS NULL) OR (revision > 1 AND from_state IS NOT NULL))
);

INSERT INTO echo_requirement_status_history_v021 (
  id, requirement_id, from_state, to_state, from_phase, from_status,
  to_phase, to_status, response, actor_user_id, revision, idempotency_key,
  created_at
)
SELECT id, requirement_id, from_state, to_state,
  CASE WHEN from_state IN ('collected', 'in_progress', 'implemented') THEN 'formal'
    WHEN from_state = 'rejected' THEN 'archived' ELSE NULL END,
  CASE WHEN from_state = 'collected' THEN 'planned'
    WHEN from_state = 'in_progress' THEN 'in_progress'
    WHEN from_state = 'implemented' THEN 'delivered'
    WHEN from_state = 'rejected' THEN 'archived'
    ELSE NULL END,
  CASE WHEN to_state IN ('collected', 'in_progress', 'implemented') THEN 'formal'
    WHEN to_state = 'rejected' THEN 'archived' ELSE 'proposal' END,
  CASE WHEN to_state = 'collected' THEN 'planned'
    WHEN to_state = 'in_progress' THEN 'in_progress'
    WHEN to_state = 'implemented' THEN 'delivered'
    WHEN to_state = 'rejected' THEN 'archived'
    ELSE 'pending_review' END,
  response, actor_user_id, revision, idempotency_key, created_at
FROM echo_requirement_status_history_legacy;

CREATE TABLE echo_requirement_idempotency_v021 (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('submit', 'transition')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  requirement_id TEXT NOT NULL REFERENCES echo_requirements_v021(id) ON DELETE CASCADE,
  resulting_state TEXT NOT NULL CHECK (resulting_state IN ('submitted', 'collected', 'in_progress', 'implemented', 'rejected')),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
  result_json TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, actor_user_id, operation, idempotency_key)
);

INSERT INTO echo_requirement_idempotency_v021 (
  space_id, actor_user_id, operation, idempotency_key, request_hash,
  requirement_id, resulting_state, resulting_revision, result_json, created_at
)
SELECT r.space_id, i.actor_user_id, i.operation, i.idempotency_key,
  i.request_hash, i.requirement_id, i.resulting_state, i.resulting_revision,
  NULL, i.created_at
FROM echo_requirement_idempotency_legacy i
INNER JOIN echo_requirements_v021 r ON r.id = i.requirement_id;

DROP TABLE echo_requirement_status_history_legacy;
DROP TABLE echo_requirement_idempotency_legacy;
DROP TABLE echo_requirements_legacy;

ALTER TABLE echo_requirements_v021 RENAME TO echo_requirements;
ALTER TABLE echo_requirement_status_history_v021 RENAME TO echo_requirement_status_history;
ALTER TABLE echo_requirement_idempotency_v021 RENAME TO echo_requirement_idempotency;

CREATE INDEX echo_requirements_space_state_idx
  ON echo_requirements (space_id, state, created_at DESC, id DESC);

CREATE INDEX echo_requirements_submitter_idx
  ON echo_requirements (space_id, submitter_user_id, created_at DESC, id DESC);

CREATE INDEX echo_requirement_history_requirement_idx
  ON echo_requirement_status_history (requirement_id, revision ASC);

CREATE INDEX echo_requirement_idempotency_requirement_idx
  ON echo_requirement_idempotency (requirement_id);

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
