CREATE TABLE echo_requirements (
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
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  response TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
  ,UNIQUE (space_id, public_id)
);

CREATE INDEX echo_requirements_space_state_idx
  ON echo_requirements (space_id, state, created_at DESC, id DESC);

CREATE INDEX echo_requirements_submitter_idx
  ON echo_requirements (space_id, submitter_user_id, created_at DESC, id DESC);

CREATE TABLE echo_requirement_sequences (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  sequence_year INTEGER NOT NULL CHECK (sequence_year >= 2000 AND sequence_year <= 9999),
  next_number INTEGER NOT NULL CHECK (next_number > 0 AND next_number <= 10000),
  PRIMARY KEY (space_id, sequence_year)
);

CREATE TABLE echo_requirement_status_history (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES echo_requirements(id) ON DELETE CASCADE,
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('submitted', 'collected', 'in_progress', 'implemented', 'rejected')),
  to_state TEXT NOT NULL CHECK (to_state IN ('submitted', 'collected', 'in_progress', 'implemented', 'rejected')),
  response TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (requirement_id, revision),
  CHECK ((revision = 1 AND from_state IS NULL) OR (revision > 1 AND from_state IS NOT NULL))
);

CREATE INDEX echo_requirement_history_requirement_idx
  ON echo_requirement_status_history (requirement_id, revision ASC);

CREATE TABLE echo_requirement_idempotency (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('submit', 'transition')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  requirement_id TEXT NOT NULL REFERENCES echo_requirements(id) ON DELETE CASCADE,
  resulting_state TEXT NOT NULL CHECK (resulting_state IN ('submitted', 'collected', 'in_progress', 'implemented', 'rejected')),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
  result_json TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, actor_user_id, operation, idempotency_key)
);

CREATE INDEX echo_requirement_idempotency_requirement_idx
  ON echo_requirement_idempotency (requirement_id);
