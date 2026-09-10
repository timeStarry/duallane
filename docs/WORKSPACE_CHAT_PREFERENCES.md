# Workspace Chat Preferences

The personal Chat settings page uses the existing authenticated
`GET /api/workspace/me/emote-settings` and partial-update
`PUT /api/workspace/me/emote-settings` contract. Go Workspace is the production
owner; retained Node implements the same contract for development and rollback
compatibility. No second production writer is introduced.

## Automatic Hiding (0.17.0)

The `settings` response adds:

| Field | Type | Default | Semantics |
| --- | --- | --- | --- |
| `autoHideMessages` | boolean | `false` | Master switch for personal display only |
| `autoHideMessageTypes` | array of `image`, `emote`, `long` | all three | Selected categories; empty is valid |

Omitted update fields retain their prior value, including the category list
when the master switch is turned off. Duplicate categories are normalized;
unsupported categories, non-string entries, null, and invalid field types are
rejected with HTTP 400 and `emote.invalid_settings`. Identity comes from the
authenticated human session, never from a request-supplied user ID.

Client state is keyed by that user ID. Pending initial settings do not mount
message media; switching actors invalidates the previous settings screen and
its outstanding saves. A failed initial read uses the disabled display default,
never another actor's preferences; the settings screen offers an explicit retry.
Failed refreshes within the same actor retain that actor's last loaded settings.

Preferences remain in `workspace_emote_preferences` with additive schema 034.
Existing rows default to the disabled state. Applying the migration does not
rewrite any message or `message_hidden_states` row. Existing setting writers
that omit the new columns retain them on conflict. Roll back application code
without dropping the additive columns; older clients ignore the new fields.
Run the single canonical migrator before starting the new Workspace version.

The existing content-free `emote.settings.update` audit and actor-scoped
`emote.settings.updated` event are retained. Message retention, quotas,
authorization, notifications and message deletion/hide APIs are unchanged.

See [the interaction contract](WORKSPACE_UI_INTERACTION_DESIGN.md#28-personal-automatic-message-hiding-017)
for classification, reveal behavior and the distinction from a privacy filter.
The executable field schema is
[`workspace-emotes.yaml`](../apps/backend/api/workspace-emotes.yaml).

## Verification And Boundaries

- Go service/HTTP and real PostgreSQL tests cover defaults, strict input,
  persisted updates, actor separation and partial-update concurrency.
- Retained Node characterization fixtures are regenerated from the actual
  Node implementation, not inferred from Go output.
- Frontend regression tests cover image/emote/long-text classification,
  Markdown literals, existing collapse thresholds and lazy reveal.
- Browser tests cover the default-off switch, conditional multi-select,
  persistence, failed-save rollback, local reveal, actor isolation and realtime
  refresh without persisting message hides, plus actor changes with failed
  settings loads and late save responses.
- Native macOS input-method behavior requires a real macOS/manual check.
  Synthetic browser composition events validate application handlers but do
  not prove every operating-system/browser/IME combination.

No production rollout, Node removal, migration ownership change, new storage
category or external provider integration is part of this feature.
