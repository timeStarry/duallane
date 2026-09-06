# Production release tooling

`deploy.sh` has exactly two release profiles:

- `node-default` is the default and preserves the existing Node `api`/`web`/
  `migrate` order.
- `go-full` is opt-in with `--release-profile go-full`. It is a whole-backend
  handoff, not a mixed-owner rollout: the existing Node `api` is stopped and
  confirmed not running before Go Workspace or worker containers start.

The script still requires a clean `main` checkout, a full
`--expected-commit`, the authoritative PostgreSQL volume, and a verified
logical backup. It never reverses a migration or restores PostgreSQL
automatically.

`node-default` resolves only `docker-compose.yml` and
`docker-compose.production.yml`. `go-full` additionally resolves
`docker-compose.go-production.yml` and enables only the `rollback` Compose
profile so the overlaid Node `api` remains available for rollback without
being started as part of the Go release.

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

- services `api`, `p2p`, `workspace`, `worker`, `web`, `migrate`, and `postgres`
  exist;
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
Before selecting `go-full`, the operator must identify the exact legacy data
volume and complete an offline, read-only permission inventory for the entire
tree, including objects written by the current root-running Node API. The
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
aborts before the Node API is stopped or any Go writer is handed ownership.
Passing this candidate check is evidence for the checked state only; it does
not waive the full-tree operator inventory or prove future root-owned Node
writes will be readable by Go.

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
starts a captured old `api` as part of this success path. A missing container,
failed start, or failed required healthcheck is a hard recovery failure.

If Docker restarts during a failed release, the script waits for the daemon and
restores all captured running containers in dependency order after rollback;
replacement IDs created by rollback are preferred. A missing container, failed
start, or failed required healthcheck is a hard recovery failure; it is not
hidden by cleanup error handling.

If application replacement fails, `go-full` first stops and confirms all new Go
services are not running, then retags captured images and restores the previous
Node application state. Rollback restores application images only and never
issues a down migration or database restore. Edge replacement is last, after
backend readiness. Rollback reconstruction uses the base Node Compose files,
not the Go override; if Compose replaces the captured Node IDs, the replacement
IDs are recorded so a later Docker-daemon recovery does not try to resurrect
removed containers. The current fixed `go-full` profile is intentionally
Node-to-Go first-cutover only and refuses an already active Go owner; a
durable Go-to-Go upgrade protocol is not claimed by this tooling.

`node-default` also refuses to proceed when a running `p2p`, `workspace`, or
`worker` container belonging to the production Compose project is detected.
This prevents an implicit Node release from creating a second Go owner; use a
future explicit owner-transition procedure instead.

The fake-Docker test harness is synthetic and isolated. It must be run before
any real operator invocation; no test uses the production `.env`, SSH, a real
container, or a real database.
