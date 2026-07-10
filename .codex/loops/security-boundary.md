# DualLane Security Boundary Loop

Use this loop for changes to P2P signaling, encryption-adjacent code, WebSocket payloads, logging, security headers, workspace authorization, quotas, audit logs, database schema, or any code that affects trust boundaries.

## Security Invariants
- P2P message and file content must not be persisted by the server.
- The P2P WebSocket server must reject plaintext chat payloads.
- Only validated secure envelopes may be relayed through signaling.
- Invite link `#k=` fragments must remain browser-only.
- Workspace APIs must remain disabled unless `WORKSPACE_ENABLED=true`.
- Workspace write paths must enforce membership or role checks before persistence.
- Quota rejections must happen before transfer and write audit rows.
- Sensitive request data must remain redacted from logs.

## Procedure
1. Write down the relevant security invariant before editing.
2. Read the implementation and the matching tests.
3. Make the narrowest change that preserves the invariant.
4. Add a regression test for the invariant, not only the happy path.
5. Check for logging, persistence, and response-body leaks.
6. Run `pnpm test`, `pnpm lint`, and `pnpm build`.
7. If validation fails twice without progress, stop and report the blocker.

## Test Focus
- P2P: secure envelope validation, plaintext rejection, room capacity, room cleanup.
- Workspace: default gate, membership rejection, audit rows, retention behavior.
- Quota: invalid sizes, over-limit rejection, used quota calculation.
- Logs: no query strings, cookies, authorization headers, request bodies, or response bodies.

## Done
- The invariant is preserved by code and tests.
- Required validation passes or the exact blocker is documented.
- The final summary states what was protected, not just what changed.
