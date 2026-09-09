# Backend Work Item And Handoff Record

Use this record when a backend task needs explicit ownership, dependency,
parallel-work, migration, or rollout coordination. It is on demand, not a
mandatory form for a tiny documentation or test change. Delete sections that do
not apply. A small task may use only the one-line contract and the handoff
summary at the end.

Start with the [backend development agent guide](../AGENT_GUIDE.md). This record
captures decisions and evidence; it does not replace canonical architecture
documents or grant authority to merge, deploy, or change production ownership.

## One-line contract for small work

`Behavior: ...; owned paths: ...; non-goals: ...; check: ...; result: PASS / FAIL / SKIP / NOT RUN.`

## 1. Capability and ownership

- Task:
- Capability:
- Current owner and status (`planned` / `parity` / `routed` / `active` / `complete`):
- Target owner and status:
- Lead/integrator:
- Assigned worker(s) and role(s):
- Trust lane (P2P private / Workspace relay / operational):
- Authoritative context read:

## 2. Observable contract

### Acceptance behavior

- Describe the observable result and acceptance check.

### Explicit non-goals

- State behavior and files deliberately excluded from this task.

### Compatibility and dependency contracts

- Public HTTP, WebSocket, cookie, event, SDK, schema, object, or job behavior:
- Existing implementation or route that must remain compatible:
- Dependencies/predecessor outputs required before work starts:
- Outputs required by the next worker or integrator:

## 3. Read/write ownership

| Role | Exact files/modules to read | Exact files/modules to write | No-touch or reserved paths |
| --- | --- | --- | --- |
| Lead/integrator |  |  |  |
| Worker |  |  |  |

- Shared integration surfaces reserved to one integrator:
  `cmd/*`, router/gateway route tables, `go.mod`/`go.sum`, schema/migrations,
  shared generated contracts, and repository/backend index files.
- Active implementation owner for each writer/claimer/scheduler/migration role:
- Approved replicas and their lease/fencing/idempotency rules (if any):
- Parallel work is allowed only when:

## 4. Data and consistency impact

- Data, schema, object, job, or audit rows read:
- Data, schema, object, job, or audit rows written:
- Transaction boundary and lock/order requirements:
- Idempotency, revision, retry, cancellation, and duplicate behavior:
- P2P no-persistence or Workspace authorization/quota/retention effects:
- Safe logging, metrics, error, and audit projection:

## 5. Validation and evidence

Use the [replayable evidence record](../VALIDATION.md#replayable-evidence-record)
for commits, timestamps, environment, commands, status, coverage, and safe
artifacts. `NOT RUN` and `SKIP` supply no coverage. Keep credentials and private
data out of this record.

| Evidence | Exact command or observation | Result (`PASS` / `FAIL` / `SKIP` / `NOT RUN`) | Environment or evidence link |
| --- | --- | --- | --- |
| Focused test/check |  |  |  |
| Contract/parity evidence |  |  |  |
| Security/privacy/data review |  |  |  |
| Independent lead validation |  |  |  |

- Checks intentionally not run and why:
- Evidence still required before acceptance:

## 6. Commit boundary and integration

- Worker patch boundary (exact paths):
- Integrator-owned paths:
- Intended split commits and their exact path sets:
- Shared-tree index owner:
- Staging/commit order:
- No concurrent `git add`, commit, interactive staging, branch switch, reset,
  cleanup, or equivalent index/worktree operation:

## 7. Rollout authorization and rollback

- Route, writer, job claimer, migration runner, or configuration change:
- Preconditions for activation:
- Authorized rollout operator/decision:
- Observation window and success signal:
- Rollback owner, fence/drain steps, and known-good owner:
- Schema/object/data compatibility and recovery limits:
- Existing explicit approval reference and authorized actions (none by default):

## 8. Handoff summary

- Exact changed paths:
- Contract decisions made:
- Tests/checks run and results:
- Tests/checks not run and why:
- Active servers, watchers, secret references (never values), or temporary resources:
- Remaining risks/blockers:
- Lead review of the actual diff completed: yes / no
- Lead acceptance: accepted / changes requested / blocked
