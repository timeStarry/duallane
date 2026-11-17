# Agent platform v1: authorization, context and tool boundaries

Status: implementation in progress; no production activation or final acceptance
claimed. Authorized by the maintainer on 2026-11-17 together with the previously
unreleased large-artifact fix from PR26. App/SDK target: 1.2.0.

## Observable scope

- A creator can keep directory discovery and direct chat owner-only while allowing
  current humans in an approved group to use the Bot. Joining requires creator
  consent and group-manager approval; either role alone cannot widen the other.
- A trusted delivered message creates a bounded task. Bot delegation inherits the
  actual human requester, conversation, ancestor validity and shared root budget.
  Bot-source triggers are off until explicitly allowlisted. Stable Bot IDs and
  member/user IDs are distinct.
- Exact messages, bounded history/search, members, authorized attachments and mixed
  message output form one JS/CLI/MCP task-tool contract. Content stays in the
  triggering conversation. Full source-to-other-destination forwarding is deferred.
- Own-task message edits and card updates use versions, provenance and one outer
  transaction with budget/idempotency/audit. A repeated reference grants no new
  ownership. Unknown write outcomes retain operation identity for reconciliation.
- Task cancellation or invalidation stops new work; previously committed output
  remains. Short thinking leases expire after renewal stops. Generic state-event
  subscriptions, gap resync, threads and management tools remain future work.

Workspace alone owns persisted tasks/provenance; P2P is unchanged and persists no
content. Migration037 stores references/hashes/counters, not prompt histories or
attachment bytes. Nullable V2 policies leave legacy behavior in place. Explicit
V2 saves conservatively mirror legacy discovery as private; rollback must never
reconstruct previous public grants.

## Required two-release rollout

The existing production 1.1.1 schema36 image has no immutable authorization for
migration037. Direct activation is intentionally rejected. Follow the established
schema bridge procedure; do not modify production history or bypass the guard.

1. Freeze and review the exact migration037 SHA-256. Prepare a normal schema36
   bridge PR carrying only its compatibility declaration, preserving the prior
   undeployed artifact fix. Keep037 outside the canonical migration directory and
   keep new task/policy handlers unwired. The bridge remains functional on36 and
   safely handles37 without claiming any new V2 policy as broad legacy access.
2. Validate the bridge and exact immutable images; merge as the maintainer account
   through normal PR/CI. Deploy from `/home/timestarry/duallane` with the latest
   verified snapshot and `deploy/production/deploy.sh --expected-commit` plus
   `--release-profile go-full --go-upgrade --previous-release-snapshot`.
3. Capture the successful bridge recovery snapshot. The activation PR restores
   exactly037 and wires the new capability. Prove36→37 and exact bridge-image
   recovery on the same disposable database before production activation.
4. Deploy the activation from exact `origin/main` using the bridge snapshot;
   verify all four application health states, public boundary/static runtime,
   task authorization, file publication, group approvals and SDK tool calls.

A pre037 1.1.1 image is not a safe direct rollback after037. Use the reviewed
schema37-compatible bridge recovery snapshot and pinned images; keep schema37
intact. A database restore is a separate destructive recovery operation requiring
an explicit incident plan and accounting for writes since the backup. Prefer a
forward fix when it preserves data. Retain all private backups/sidecars mode0600.

## Validation ledger

Completed on the implementation tree:

- Go1.26.11 `make verify`: generated contracts, all unit/race tests, vet,
  staticcheck, vulnerability scan and command builds passed.
- Full disposable PostgreSQL/race run: all business packages passed; startup
  composition initially exposed missing037 schema inspection. After adding the
  exact read-only inspector, migrations, Workspace/worker composition, V1 and
  Agent Gateway passed the focused race matrix (including new lock/slow-upload,
  card-reference/provenance and private-Bot group-identity regressions).
- SDK142/142 on Node22.22.0 and Node24.19.0; Web399/399; lint/types/build passed.
- Skill official validator passed using existing Python/PyYAML; schema release
  compatibility/upgrade guards32/32 passed on Linux Node22. No gates were weakened.
- Desktop1280 and phone390×844 permission screenshots inspected: no horizontal
  overflow; existing Go Workspace messages/uploads/downloads acceptance passed.

Agent browser acceptance also passed: independent owner/member, exact source Bot
IDs, desktop/390px policy save, status-only group approval/rejection, real mention
candidate and denied private-DM creation. The current Workspace browser gate now
includes this spec alongside the original message/file/responsive acceptance.

Pending: full PR CI, immutable-image bridge→activation
and recovery rehearsal, production deployment/acceptance. No production activation
is claimed by these local results.

Fixtures are synthetic. No production chat content, private Agent profile or
failed real task is copied into tests. Updating an installed external runtime or
replaying its historical task requires separately applicable operator authority.
