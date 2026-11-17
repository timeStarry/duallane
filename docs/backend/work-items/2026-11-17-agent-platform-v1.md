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

All Agent connections require a compatible stable 1.x SDK, minimum 1.2.0,
regardless of whether a Bot has opted into V2 policy. Setup, authenticated HTTP
and WebSocket reject missing, invalid, old or incompatible SDK declarations with
426 `sdk.upgrade_required`. Existing policy/profile retention does not authorize
old runtime admission. Verified updating preserves credentials and bridge policy;
the version declaration is not authentication and cannot grant task access.

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
- Real SDK-to-Go HTTP acceptance passed on disposable data: delivered triggers,
  task creation, bounded history/search, members, mixed file/mention publication,
  attachment bytes, conditional edits/conflicts, operation receipts, card updates
  and cancelled-task rejection. No mocked SDK transport or production credentials.
- Mandatory SDK admission follow-up: SDK153/153, Web399/399, lint/build and the
  Go1.26.11 full quality gate passed. Regression coverage includes HTTP/WS426,
  terminal upgrade pauses, safe update guidance and preserving child-written
  pause state during daemon startup. Final PostgreSQL/CI/image acceptance is
  required again before activating this follow-up.
- Bridge PR28 is online as1.1.3/schema36. The isolated immutable Go-only
  rehearsal passed36→37 activation and exact1.1.3 image recovery on the same
  schema37 database, including private sidecars and unchanged volume authority.
  Repeat with the final merged activation images after the SDK admission change.

Bridge PR28 is merged at `74523762e53a030382beebf47f4daa5249b57aff` and
production1.1.3 passed the guarded deployment and26 gateway checks. It includes
the previously undeployed artifact fix from PR26. The successful schema36
recovery snapshot is `duallane-20261117T131946Z-74523762e53a.recovery.go-compose.snapshot.json`.

The shared validation host has an independently observed pre-existing OpenResty
crash loop (more than119,000 prior restarts). The isolated Docker rehearsal may
explicitly pin that one full container ID through
`DUALLANE_AGENT_SCHEMA_UNSTABLE_BASELINE_CONTAINER_ID`; its existing identity,
image and restart policy must remain unchanged. All other pre-existing running
containers retain strict lifecycle checks. This exception neither operates on
that container nor changes production deployment guards.

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

## Go-only immutable-image rehearsal

`scripts/backend/agent-schema-upgrade.docker.test.mjs` does not require the retired
Node images. Its default CI run checks fixture contracts and skips the real
Docker lifecycle until explicitly selected on Linux with seven local image IDs.
Set `DUALLANE_AGENT_SCHEMA_UPGRADE_DOCKER_TEST=true` and the immutable
`DUALLANE_AGENT_SCHEMA_OLD_{WORKSPACE,P2P,WEB}_IMAGE`,
`DUALLANE_AGENT_SCHEMA_TARGET_{WORKSPACE,P2P,WEB}_IMAGE` and
`DUALLANE_AGENT_SCHEMA_POSTGRES_IMAGE` values, then run `node --test` on that file.

Only an empty synthetic baseline uses fixture bootstrap. The target upgrade
executes the existing production upgrade helper unchanged: authority, migration,
fence/drain, readiness, gateway smoke, snapshot and exact old-Go recovery. The
fixture derives the old schema inventory from the old immutable image, checks
actual PostgreSQL remains37 after recovery, preserves its container/volume and
verifies every pre-existing active container is unchanged. All created resources
are owned by a fresh project/run label and removed only after identity checks.
No production env, snapshot contents or application data enter this rehearsal.
