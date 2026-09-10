# Production release tooling

The 0.18 `deploy.sh` path is Go-to-Go only. It requires a clean `main`
checkout, a full `--expected-commit`, verified release metadata, the
authoritative PostgreSQL volume, and a verified logical backup. It rejects
`node-default`, `--bootstrap`, and `--prepare-go-permissions`; it does not
provide a current-tree first-install or permission-bootstrap command.

An existing 0.17 installation's first migration and permission preparation
must be completed from the retained 0.17 checkout and its approved runbook.
That historical procedure is not recreated in this tree.

The coordinator never reverses a migration or restores PostgreSQL
automatically.

The root `docker-compose.yml` extends `docker-compose.go-production.yml` and is
Go-only by default. It has no online `api` service. Production uses
`--release-profile go-full --go-upgrade --previous-release-snapshot`; historical
release-helper/immutable-image material remains only for exact old-image
recovery and synthetic tests, not as a current Node Compose profile.

For the next upgrade, use the private base snapshot
`backups/production/duallane-20260910T080211Z-8d346a04317d.recovery.go-compose.snapshot.json`
and its `.compose.json`, `.external.json`, and `.volumes.json` sidecars. The
base is the 0.17 Go release at
`8d346a04317d0d3396293caca14ca1c65c7b5163`; rollback never targets schema 34
on 0.16.1 or a stale database copy.

The Go candidate rehearsal additionally uses the fixed
`deploy/production/go-candidate.compose.yml` overlay. The script creates one
commit-scoped bridge network with exact ownership labels, attaches P2P and Web
only to that network, and keeps Workspace/worker on the PostgreSQL default
network plus that candidate network. P2P, Workspace, worker, and Web remain
alive together until Web health is proven. Each candidate has exact
profile/commit/project/service ownership labels; an existing name is removed
only after all labels match, and a collision with another project fails
closed. Workspace/worker are started
without Compose `--use-aliases`; the script adds and verifies their upstream
aliases only on the owned candidate network, so `workspace` is never exposed
as a DNS alias on the PostgreSQL/default network. The script removes only the
exact owned candidate containers and network; it never wildcard-removes a
network and refuses an existing network with mismatched labels.

## Parent-owned Go interface

The Go production override must make `docker compose config --format json`
prove all of the following before `go-full` can proceed:

- services `p2p`, `workspace`, `worker`, `web`, `migrate`, and `postgres` exist;
- `p2p`, `workspace`, and `worker` have the parent-provided read-only
  `/usr/local/bin/duallane-healthcheck` healthcheck;
- Workspace and worker wait for healthy PostgreSQL and completed `migrate`;
- Web waits for healthy P2P and Workspace;
- P2P has no PostgreSQL or Workspace dependency;
- Workspace, worker, and migrate use the same resolved image reference (the
  post-build image-ID equality check is a separate release gate);
- resolved Workspace and worker configuration contains exactly
  `WORKSPACE_ENABLED=true`; and
- `migrate` remains a one-shot service with `restart: "no"`.

After building, the Go image gate resolves the common reference to a canonical
local image ID and checks revision/version labels on that ID, not on a mutable
tag. A mode-0600 Compose override pins Workspace, worker, and migrate to the
verified ID for all subsequent candidate and active starts. The private recovery
record retains that identity and the unique release-run label. A later tag move
cannot select a different migration binary.

Migration uses create-without-start. The script refuses any existing migration
container, then checks the created container's project/service/run ownership,
stopped state and actual image ID before starting it. It waits for a zero exit,
rechecks the image ID and removes only the exact, reverified owned container.
Invalid IDs or foreign ownership never trigger guessed-name deletion. An error
after execution does not imply database rollback; retain the backup and inspect
the migration history before retrying. Active Workspace and worker image IDs
must also match the verified image.

For unpublished Go candidates, `deploy.sh` passes and then verifies the
effective container environment:

```text
Workspace: WORKSPACE_ENABLED=true
           WORKSPACE_CANDIDATE_HEALTH_ONLY=true
Worker:    WORKSPACE_ENABLED=true
           WORKER_VALIDATE_ONLY=true
```

The worker candidate inherits the resolved provider, maintenance, and Echo
configuration. `WORKER_VALIDATE_ONLY=true` must hard-stop worker `Start`/tick
and claim paths without hiding invalid configuration; the deployment tooling
does not replace those settings with `false`.

After Docker health is green, the script executes the image helper inside the
candidate and checks only its exit status:

```text
duallane-healthcheck http://127.0.0.1:8787/readyz --expect-mode=candidate-health-only
duallane-healthcheck http://127.0.0.1:8787/readyz --expect-mode=validate-only
```

The helper must require HTTP 200, `ok: true`, `state: "ready"`, and the
requested mode. Candidate containers have no published host port. The script
does not treat a manifest field as proof that a candidate is passive; runtime
flags, the actual health result, and parent-owned runtime tests are required.

P2P candidates use the internal `/api/health` healthcheck and have no database,
storage, Workspace, OAuth, SMTP, or provider secrets. Replacing the single
P2P process interrupts in-memory direct sessions; the release output records
that expected interruption.

## Legacy local-data permission preflight

The Go Workspace and worker containers deliberately run as `65532:65532`.
Before selecting `go-full`, the operator must identify the exact authoritative
data volume and complete an offline, read-only permission inventory for the
entire tree, including objects written by the former root-running 0.17 owner. The
inventory must prove that this UID can traverse directories and read every
legacy object that the Go compatibility reader may open. Record the volume
identity, image/release used for the check, and the result with the release
evidence; do not infer full-tree readability from the volume root alone.

If the inventory finds unreadable objects, any ownership or mode repair requires
an explicit operator approval and an offline maintenance window. The operator
must use an explicit, reviewed object/ownership plan and repeat the complete
UID `65532:65532` read check afterward. `deploy.sh` never runs `chmod` or
`chown`, never changes an unknown live volume, and never relaxes the active Go
container's user. A blind recursive ownership change is not an acceptable
preflight.

The unpublished Workspace candidate mounts the same data volume and its
readiness path must exercise the non-mutating existing-store open as
`65532:65532`. A permission/readiness failure removes only that candidate and
aborts before any Go writer is handed ownership. Passing this candidate check is
evidence for the checked state only; it does not waive the full-tree operator
inventory.

## Recovery contract

Before image builds or application replacement, the script records a
mode-0600 state file containing only service names, container IDs, image IDs and
refs, running/status/health state, and the selected profile. It snapshots every
known long-running application service, including optional `v2ray` when
present. `migrate` is never automatically restarted during recovery.

If Docker restarts during a successful release, the script waits for the daemon,
restores only captured services that were running before the release but are
outside the selected profile and were not deliberately fenced for the handoff,
then verifies every health-required service in the selected profile. It never
starts a captured retired Node service as part of this success path. A missing
container, failed start, or failed required healthcheck is a hard recovery
failure.

If Docker restarts during a failed release, the script waits for the daemon and
restores all captured running containers in dependency order after rollback;
replacement IDs created by rollback are preferred. A missing container, failed
start, or failed required healthcheck is a hard recovery failure; it is not
hidden by cleanup error handling.

Before stopping a writer or claimer, the helper records the exact Docker
container identity and its original restart policy in the mode-0600 recovery
record. It then applies `restart=no`, inspects that policy, stops the exact
identity, and confirms the container is not running. A partial or failed fence
is never treated as recoverable. A completed fence may restore only the
explicitly selected known-good owner; failed Go owners remain stopped with
`restart=no` and are not revived by daemon recovery. The identity must be the
canonical 64-character lowercase Docker ID, and both Compose ownership labels
(`com.docker.compose.project` and the target service) are rechecked before any
update, stop, or recovery operation. This slice supports one container per
owner; multiple matches fail closed. Daemon recovery skips a completed fenced
Go owner and fails closed on an incomplete fence.

If application replacement fails, `go-full` first stops and confirms all new Go
services are not running, then restores the previous verified Go image IDs and
the same database/storage authority. Rollback restores application images only
and never issues a down migration or database restore. Edge replacement is
last, after backend readiness. The four current owners (`p2p`, `workspace`,
`worker`, and `web`) are re-identified and fenced on every rollback retry,
including owners not yet recreated. A candidate rehearsal or test result does
not authorize deployment or a ledger transition.

The current tree has no Node online rollback Compose. Historical
`release-helper.sh` and immutable old images are retained only for the exact
0.17 recovery procedure; that procedure must use its retained checkout/runbook
and must not be started beside Go.

The fake-Docker test harness is synthetic and isolated. It must be run before
any real operator invocation; no test uses the production `.env`, SSH, a real
container, or a real database.
