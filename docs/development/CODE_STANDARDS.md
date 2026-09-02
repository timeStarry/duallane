# Code Standards

## 1. General

- Follow the nearest established pattern and repository formatter/linter.
- Use clear domain names. Avoid abbreviations that hide identity, scope, revision,
  or unit semantics.
- Keep functions focused and make side effects visible at their call sites.
- Add an abstraction only when it enforces a boundary, removes meaningful
  duplication, or isolates a volatile dependency.
- Delete dead code and temporary diagnostics. Do not leave commented-out branches
  or speculative extension points.
- Comments document invariants, protocol reasoning, lock order, compatibility, or
  surprising constraints. They do not narrate obvious assignments.
- Prefer ASCII in source and identifiers. User-facing Chinese copy and documents
  may use their established character set.

## 2. TypeScript And React

- Preserve strict TypeScript. Do not use `any`, broad type assertions,
  `@ts-ignore`, or optional chaining to conceal an invalid state.
- Model public state with explicit types and discriminated unions. Parse untrusted
  JSON before treating it as a domain object.
- Components should expose semantic props rather than raw internal state setters.
- Derive render state where possible. Do not copy props into state without a
  documented synchronization rule.
- Effects are for external synchronization. Include complete dependencies, cancel
  stale work, and ensure cleanup cannot suppress the Strict Mode rerun.
- Use stable keys and invocation IDs. Async results must confirm they still belong
  to the active user, route, conversation, or request.
- Preserve keyboard, focus, selection, and draft behavior when extracting or
  reusing composers and dialogs.
- Avoid introducing another global state mechanism unless existing React context,
  route state, API cache, and events cannot express the lifecycle.

## 3. Node, Fastify, And Services

- Use native ESM and the existing `.mjs` conventions in server code.
- Validate request params, query, body, content type, and size at the boundary.
- Authentication identifies the actor. Authorization separately proves access to
  the specific space, conversation, Bot, file, or object.
- Return stable domain errors and intentional HTTP codes. Unexpected errors are
  logged through the redacted logger and return a generic response.
- Pass request metadata to sensitive mutations for audit. Never log tokens,
  cookies, invite fragments, plaintext P2P content, message bodies, or file data.
- Await or deliberately supervise every promise. Background work needs an owner,
  retry policy, and observable failure path.
- Use injected clocks, IDs, storage, and database adapters in tests rather than
  environment-dependent globals.

## 4. SQL, Transactions, And Concurrency

- Use parameterized SQL and explicit column names. Do not construct column names
  from request data without a strict server-owned allowlist.
- Keep authorization checks that protect a write inside the transaction when
  concurrent changes could invalidate them.
- Increment revisions only for effective domain changes. Compare expected
  revisions or affected-row counts and return a stable `409` on conflict.
- Idempotency keys are scoped to the actor and operation. Store enough request
  identity to distinguish replay from conflicting reuse.
- Define lock keys and acquisition order for shared resources such as content
  digests, active workflows, and subscriptions.
- Publish realtime events and audit records consistently with transaction commit.
  Consumers must not observe committed events for rolled-back state.
- Time, byte counts, sizes, and limits use explicit units in names and contracts.

## 5. Files And Content-Addressed Storage

- Enforce permission, declared size, transfer quota, media validation, and safety
  limits before or during upload as defined by the owning service.
- Hash the actual bytes. New Workspace objects use the canonical
  `workspace/objects/sha256/<prefix>/<digest>` key through the registry API.
- Logical records reference storage objects; copying a logical attachment must not
  duplicate bytes.
- Release a logical reference first. Delete physical content only after a
  reference check under the digest lock, and keep cleanup idempotent.
- Reads prefer a valid canonical object and use a documented legacy fallback only
  for migration compatibility. Verify digest and size during migration and repair.
- Client responses expose authorized download behavior, never internal object IDs,
  hashes, bucket credentials, or storage keys.

## 6. APIs, Events, And SDKs

- Use consistent resource naming and response envelopes in the existing API
  family. Boolean actions do not replace meaningful resource state.
- Validate enums and reject unknown values; do not silently coerce a future
  protocol field into a different meaning.
- Error bodies expose a stable code and safe actionable details. They do not expose
  SQL, stack traces, secrets, or existence across an authorization boundary.
- Realtime events have a stable type, authorized target, revision/order signal
  where required, and the minimum safe payload.
- Changes to Agent Gateway behavior must update its public Skill/manifest, SDK,
  protocol tests, and compatibility notes together.

## 7. CSS And Assets

- Extend existing tokens, page shells, form rows, buttons, dialogs, and breakpoints.
  Avoid isolated magic colors, spacing scales, and one-off component dialects.
- Scope styles to the owning surface and keep selectors shallow. Do not use
  `!important` to repair an ownership or specificity problem.
- Reserve stable dimensions for icons, toolbars, media, grids, and loading states
  so dynamic content does not shift or overlap the layout.
- Use the installed Lucide icon library for familiar actions. Include an
  accessible label and tooltip for icon-only or unfamiliar controls.
- Optimize repository-owned assets and document their source/license. Do not add
  large binaries or generated screenshots to source control without a clear need.

Detailed presentation rules live in [UI/UX standards](UI_UX_STANDARDS.md).

## 8. Dependencies And Configuration

- Prefer platform and existing package capabilities. A new runtime dependency
  needs a concrete maintenance, security, bundle-size, and licensing rationale.
- Pin through the workspace lockfile and commit intentional lockfile changes.
- Configuration has one documented environment variable, a safe default, startup
  validation, and a test. Secrets never receive checked-in defaults.
- Feature gates must fail closed. Workspace remains disabled unless
  `WORKSPACE_ENABLED=true` exactly.
- Avoid environment-specific URLs or credentials in source, tests, Skills, and
  public documentation.

## 9. Tests As Code

- Test observable behavior and contracts, not private implementation shape.
- Give regression tests a name that identifies the scenario and expected result.
- Keep tests deterministic: control clocks and IDs, await events, and avoid fixed
  sleeps or dependence on public services.
- Exercise failure and rollback paths for sensitive mutations, not only success.
- The SQLite test double must preserve the PostgreSQL semantics the test relies on;
  database-sensitive behavior also needs PostgreSQL coverage.
- Keep fixtures minimal, non-sensitive, and locally owned. Clean temporary files,
  database rows, servers, and browser contexts.

Use [Testing and release](TESTING_AND_RELEASE.md) to select the required suite.
