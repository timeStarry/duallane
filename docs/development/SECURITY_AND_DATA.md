# Security And Data Requirements

## 1. Trust Model

| Lane | Server may handle | Server must not do |
| --- | --- | --- |
| P2P private lane | Session metadata and validated secure relay envelopes needed to connect peers | Persist or log plaintext messages/files, receive `#k=` secrets, or imply durable recovery |
| Workspace relay lane | Authenticated and authorized messages, files, metadata, audit records, retention state, and realtime projections | Bypass RBAC/quota/retention, expose one actor's content to another, or log sensitive content |

Every feature identifies its lane before implementation. A shared helper may be
used across lanes only if it does not change either lane's data handling promise.
Tests must prove the boundary where regression would be severe.

## 2. Authentication And Authorization

- Authentication proves actor identity. Every resource operation separately
  checks current membership, role, ownership, visibility, conversation scope, or
  Bot grant on the server.
- Client-hidden controls are usability only, never authorization.
- Denied responses reveal the minimum safe information. Do not confirm that a
  private user, conversation, Bot, file, object, or invite exists.
- Session, OAuth, Bot token, setup-code, and invite flows enforce expiry, one-time
  use where required, audience, user/space/Bot binding, and replay rejection.
- Tokens are accepted in their defined header or cookie transport only. Never put
  tokens in URLs, prompts, chat messages, telemetry, or public integration files.
- Workspace endpoints retain the existing disabled behavior unless
  `WORKSPACE_ENABLED=true` exactly.

## 3. Validation, Quotas, And Abuse Boundaries

- Validate type, length, count, size, syntax, and domain state at the server
  boundary. Normalize only when the contract defines the normalization.
- Reject a transfer quota or declared-size violation before receiving the body.
  Deduplication does not waive transferred-byte accounting.
- Preserve per-file format, size, animation-complexity, collection, rate, and
  storage limits. A limit change requires contract, UI, and boundary tests.
- Rate limits and idempotency must be actor-scoped and durable where restart would
  otherwise defeat the protection.
- Rejected sensitive actions create a content-free audit row when required, without
  copying the rejected payload into logs or audit details.

## 4. Audit, Logging, And Errors

- Audit records describe actor, action, target identity, outcome, safe metadata,
  and time. They do not store message bodies, file bytes, tokens, invite secrets,
  authorization codes, or unnecessary personal data.
- Preserve Fastify redaction and security headers. Adding a header exception or
  log field requires a threat analysis and focused test.
- Application logs are operational, not an alternate message store. Avoid raw
  request bodies and signed object URLs; log stable request/error identifiers.
- Public errors use stable codes and safe details. Stack traces, SQL, filesystem
  paths, bucket keys, hashes, and credentials remain server-side and redacted.

## 5. Workspace Persistence And Retention

- Write Workspace data only after authorization and validation. Apply retention,
  recall, deletion, and legal/operator policies through the owning service.
- A logical deletion must define what remains for audit, idempotency, reply
  integrity, subscription detachment, and storage reference counting.
- Database migrations are additive and recoverable. Backfills are idempotent,
  bounded, observable, and safe to resume.
- Do not copy production data into tests or screenshots. Fixtures use synthetic
  identities and content.

## 6. Binary Objects

Workspace attachments, avatars, and custom emotes share the content-addressed
object registry:

- SHA-256 plus byte size identifies the canonical physical object;
- logical entities retain their own authorization and metadata;
- equal bytes reuse one active deployment object without weakening upload checks;
- deletion releases a logical reference; only the final-reference cleanup may
  delete the physical object;
- digest locking prevents upload/cleanup races;
- delivery must authorize the logical resource before opening its object;
- object IDs, hashes, bucket keys, and internal paths are not client contracts;
- legacy objects remain readable only during the documented migration window.

Backups, object-store version history, and application static assets are outside
the active-object uniqueness promise. P2P content never enters this object store.
See [the content-addressed storage runbook](../WORKSPACE_CONTENT_ADDRESSED_STORAGE.md).

## 7. Browser And Frontend Security

- Treat all rendered names, messages, filenames, card content, and remote metadata
  as untrusted. Use React/text APIs or an approved sanitizer; never insert raw HTML.
- Preserve CSP and same-origin assumptions. New external origins require explicit
  configuration and review.
- The `#k=` fragment stays in the browser. Strip or avoid it before analytics,
  navigation to servers, screenshots, and error reporting.
- Clipboard actions clearly describe the copied value and never mix secrets with
  public setup instructions.
- Object and file previews use authorized endpoints or scoped signed access as the
  storage contract defines; do not make a private bucket public to fix rendering.

## 8. Security Review Triggers

Call out a dedicated security/data review in the PR for changes to:

- authentication, authorization, membership, roles, invites, sessions, Bot tokens,
  OAuth, or setup codes;
- P2P envelopes, key handling, invite fragments, signaling, or privacy copy;
- uploads, downloads, storage keys, signed URLs, quotas, retention, deletion, or
  content-addressed references;
- audit events, request logging, redaction, security headers, notifications, or
  realtime audience selection;
- migrations, backfills, cleanup jobs, deployment secrets, or recovery tooling.

The review describes assets, actors, trust boundaries, abuse/failure cases,
mitigations, test evidence, rollout, and rollback.

