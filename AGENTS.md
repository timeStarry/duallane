# DualLane Codex Instructions

## Project Invariants
- DualLane has two trust lanes: the P2P private lane and the audited workspace relay lane.
- P2P message and file content must not be persisted by the server.
- P2P server code may relay only validated secure envelopes, not plaintext chat payloads.
- Invite link `#k=` fragments are browser-only secrets and must not be sent to backend APIs.
- Workspace is disabled by default unless `WORKSPACE_ENABLED=true`.
- Workspace changes must preserve RBAC, quota enforcement, message retention, and audit logging.
- Do not weaken Fastify log redaction or security headers without explicit justification.

## Commands
- Install: `pnpm install`
- Dev: `pnpm dev`
- Type/lint: `pnpm lint`
- Tests: `pnpm test`
- Build: `pnpm build`

## Required Validation
- For frontend-only changes, run `pnpm lint` and `pnpm build`.
- For service logic changes, run `pnpm test` and `pnpm lint`.
- For P2P, workspace, quota, audit, auth, database, or deployment changes, run `pnpm test`, `pnpm lint`, and `pnpm build`.
- For Docker or Nginx changes, also run `docker compose config` and build the affected image when available.

## Review Focus
- Check that no P2P plaintext content reaches server persistence or logs.
- Check that workspace APIs remain blocked by default.
- Check that quota rejection happens before transfer.
- Check that rejected sensitive operations write audit rows.
- Keep changes scoped; do not refactor unrelated UI or assets.

## Implementation Discipline
- Read `README.md`, `DESIGN.md`, and the smallest relevant code path before editing.
- Prefer existing project patterns over new abstractions.
- Add focused tests for changed backend behavior.
- Keep UI copy consistent with the current privacy claims; avoid stronger security claims unless the implementation proves them.
- Do not modify imported emote assets unless the task is specifically about emote packs.
