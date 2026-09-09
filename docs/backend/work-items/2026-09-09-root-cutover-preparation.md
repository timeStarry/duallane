# Root-assisted first-cutover preparation — 2026-09-09

## Scope and authorization

The maintainer authorized the local key to log in to `server` as root and asked
the lead to continue full Go deployment validation without manual sudo commands.
The lead verified that connection and the same local Docker daemon. No sudoers,
password or SSH security setting was changed. This authorization selects remote
transport for the existing production checkout; it does not authorize an agent
merge into `main` or an alternate deployment entry point.

PR #3 at `be994fb00aac6e4c71ad334a2237a4b6885b3181` had all four CI jobs pass;
it was still unmerged at this continuation's start. Production remained clean
main `3afbb2f79a76768170be0c2fddd61f8dc167c075`, serving Node 0.15.5 with healthy
API, Web and PostgreSQL. The privilege check opened but did not read or print
the S3 credential; data and credential ownership remained unchanged.

The lead owns integration, image/container rehearsal, documentation and split
commits. One `luna-worker` implements the bounded filesystem primitive and its
tests. A second independently reviews the coordinator ordering and recovery
conditions. A third extends the disposable Docker recovery rehearsal. The lead
reviews, corrects and verifies the integrated result. Workers do not operate
production or the Git index.

## Observable behavior and data contract

The opt-in `--prepare-go-permissions` mode on `deploy.sh` prepares a root-owned
Node deployment for Go UID 65532. It preserves the current physical volume,
object bytes, keys, database and S3 authority. Node stays retained for recovery;
no P2P plaintext, message, quota, audit, authentication, worker or API contract
changes. The default flow is unchanged. The pending release remains 0.16.0.

Acceptance requires verified private backups before metadata mutation, no
concurrent mounted writer, exact authority and immutable images, a real Go-UID
canary, passive readiness before activation, and same-authority Node recovery
after both success and injected failure in disposable environments. Production
activation still requires maintainer merge and exact-main checks.

## Threat and recovery review

Assets are the private S3 credential, authoritative local object bytes,
PostgreSQL metadata, old-owner recovery material and unrelated host services.
The trusted actor is the authorized root host coordinator. CLI arguments do not
grant an unprivileged process root access, nor make a manifest into a fence.
No host-root or Docker-socket mount is added to Go or helper containers.

The credential transition precedes external-file fingerprint capture so normal
integrity validation remains meaningful. Old Node must be root-compatible;
changing modes on a running data volume is forbidden. Filesystem mutation runs
only after the coordinator's stop/drain and backup gates; the primitive also
checks live Docker mounts before mutation. Symlinks, hardlinks, cross-device
paths, live writers and unsupported layouts fail closed. Operator-controlled
paths and the host daemon remain inside the privileged trust boundary; this
does not claim protection against a malicious root changing the host mid-run.

Data permissions tighten to private Go ownership without changing business
bytes. A full private copy and metadata manifest remain recoverable evidence,
not an automatic rollback target. Node recovery stays on the same current
volume so it cannot discard Go writes. A partial metadata conversion can be
read by root Node; failed authority or drain still prevents its restart. The
synthetic canary has no network and no PostgreSQL/provider environment, and
only its exact owned container may be removed.

The mode has an explicit maintenance outage before candidate readiness. Its
PostgreSQL archive listing is not a restore rehearsal; filesystem full hashes
are not registry/S3 parity. Production logic, provider and recovery acceptance
must remain distinct from synthetic test success.

## Validation and remaining gates

Implementation was split into `19cb8a2` (filesystem primitive and tests),
`cd7dbe2` (coordinator/canary/rehearsal/CI) and `3f825f3` (existing deployment
contract updated for the explicit maintenance window). No runtime implementation,
dependency, Dockerfile or Compose definition changed. The retained Node Dockerfile
copies server tests, so the test-only change is still an image-context change.

Lead-run checks on Linux/WSL, using Node 22.23.2 and pnpm 10.30.3:

- `node --test scripts/backend/release-storage-permissions.test.mjs
  scripts/backend/release-permission-stage.test.mjs`: 21 passed, no skips.
  This includes a real credential CLI process, partial ownership-change
  failure, backup-directory fsync failure, immutable original evidence,
  full-tree conversion, pre-mutation volume metadata drift, no-writer guards,
  private credentials and canary ownership/cleanup guards.
- The deployment regression set (`production-deploy`, `release-activation`,
  `release-cleanup`, `release-go-restore`, `release-trap-status`,
  `release-compose-snapshot`, `release-external-files`, `release-drain-config`,
  `release-drain-run`, `release-node-authority`, `release-volume-authority`,
  `local-gateway-binding`, `gateway-readonly-smoke`, `release-permission-stage`):
  176 passed, two skipped in 171.01 seconds. The skips are the explicit Compose
  roundtrip opt-in and the unprivileged unreadable-file case under root.
- `bash -n` for both changed shell scripts and `git diff --check`: passed.
- Go 1.26.8 `go test -count=1 ./internal/platform/storage`: passed. These unit
  tests are not a production S3-provider or real UID mirror-write proof.
- At `0002317`, the compiled storage test binary also ran under real UID/GID
  `65532:65532` with cleared groups and no-new-privileges: all 14 selected
  `TestHybrid`, `TestLocal` and `TestS3Blob` cases passed. Local filesystem cases
  use real temporary files; S3 uses an in-process synthetic provider and hybrid
  writes use test doubles. This does not prove the live provider or the combined
  production S3-primary/local-mirror path.
- In a clean native WSL validation checkout, `pnpm lint` and `pnpm build`
  completed at `cd7dbe2`. The existing large-chunk warning remains. The first
  full test run found one old static deployment-order assertion; it was
  updated in `3f825f3` to require the explicit fence/drain/prepare block and
  still require candidates before activation. The full `pnpm test` rerun at
  `3f825f3` passed: SDK 8; Web 732, with two PostgreSQL environment skips
  (132.97 seconds).

The new real-Docker success scenario initially reached smoke/capture but
exceeded the old six-minute coordinator-test budget. Permission scenarios now
have the same bounded ten-minute coordinator/twelve-minute outer budget as the
longer Go-upgrade rehearsal; production timeouts are unchanged. Overlapping
validation processes also collided on the existing commit-scoped candidate
names: the failure scenario correctly refused to count the other run's
candidates as cleaned. Run this Docker gate serially, from a native Linux
checkout, with no other same-commit candidate rehearsal. No unowned container
was removed. These failed attempts are not recovery acceptance. Exact final
Docker outcomes and fresh CI status are tracked in
[PR #3](https://github.com/timeStarry/duallane/pull/3), not inferred from the
earlier binding-only CI.

At code commit `000231710f69d67058435d85a00f21cd7ff6961f`, all four jobs in
[CI run 34368253855](https://github.com/timeStarry/duallane/actions/runs/34368253855)
passed: Go quality/PostgreSQL, Node quality/image build/Chromium, Go Workspace
Chromium/privacy and Go P2P Chromium/privacy/transfer. Later evidence-only
documentation updates do not substitute for the PR's latest check status.

### Disposable image inputs

The lead used existing local immutable images, with no registry pull or
production configuration. Go runtime source is `205f470f09852c9f36aeac37926b710e0f267940`
(0.16.0); retained Node fixtures are `37ae06131a7bb38e6d2e77599f48aabc78e0492e`
(0.15.5). These prove the current coordinator against those runtime artifacts,
not an exact new production build. From the tested native Linux development
checkout, on its disposable Docker daemon, run one process at a time:

```bash
export DUALLANE_RELEASE_COORDINATOR_DOCKER_TEST=true
export DUALLANE_RELEASE_COORDINATOR_NODE_IMAGE=sha256:e5e42b53d293a942ba8e541b34d9ea7bfa83990e1619272ad057858d300c2c6f
export DUALLANE_RELEASE_COORDINATOR_NODE_WEB_IMAGE=sha256:46d94eb4a6befc0af8bc3c3765fbe0512099cf88863a38c9e20e903c79d2327b
export DUALLANE_RELEASE_COORDINATOR_GO_IMAGE=sha256:e7828cbd42627a3e4607744d13ca9ae9909d21ec2ef016ba5b33cfd8003b6853
export DUALLANE_RELEASE_COORDINATOR_P2P_IMAGE=sha256:7ff62e9ee93462628a802a880023ba389b07d5a229016a25787ef87fc16cb1dc
export DUALLANE_RELEASE_COORDINATOR_WEB_IMAGE=sha256:2d6ce9232c7405c864c0cd354698bdc3c0e987d33bafd4404940f72e7a25905f
export DUALLANE_RELEASE_COORDINATOR_POSTGRES_IMAGE=sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73
node --test --test-name-pattern='root-only permission preparation' \
  scripts/backend/release-coordinator.docker.test.mjs
```

The independent main-owned coordinator/canary review found no additional
blocking issue. Lead review corrected draft backup-path/deadline defects,
replaced truncating metadata updates with an immutable original manifest and
atomic phase file, added directory fsync before mutation, pinned fresh physical
volume identity, and verified those paths rather than relying on the worker's
completion report.

Until the revised PR is merged and the guarded production run passes, the
capability ledger remains `parity` and production ownership remains Node.
