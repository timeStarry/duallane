# DualLane Workspace Enablement Loop

Use this loop for audited relay lane work: GitHub OAuth, invite-only accounts, RBAC, conversations, groups, messages, files, transfer ledger, retention, and audits.

## Current Baseline
- Workspace is intentionally disabled by default.
- `/api/workspace/*` must return the under-development response unless `WORKSPACE_ENABLED=true`.
- The development database seed exists only to support controlled local testing.

## Procedure
1. Confirm whether the task is behind the workspace gate or changes the gate itself.
2. Keep `WORKSPACE_ENABLED=false` as the default unless the task explicitly changes release posture.
3. Implement one capability at a time:
   - auth or invite
   - RBAC
   - conversation/message
   - file/quota
   - audit/admin UI
4. For every write path, define:
   - actor identity
   - required role or membership
   - persistence target
   - audit event
   - rejection behavior
5. Add service tests before or with the implementation.
6. Run `pnpm test`, `pnpm lint`, and `pnpm build`.

## Required Checks
- Unauthenticated or unauthorized users cannot access relay data.
- Rejected operations do not partially persist business data.
- Rejected sensitive operations write audit rows where appropriate.
- Quota checks are backend-owned.
- Retention cleanup does not delete audit logs.

## Done
- The capability works only under the intended gate and permissions.
- Tests cover allowed and rejected paths.
- The UI does not imply workspace is production-ready before the gate and auth model are complete.
