# Production preflight remediation — 2026-09-09

## Contract and ownership

The merged Go candidate remains at `parity`; Node remains the production
writer and claimer. This work fixes a release-verification compatibility defect
and records the remaining host permission gate. It does not remove Node or
claim a completed cutover. The pending product release remains `0.16.0`.

The maintainer authorized remediation, either a binding change or a deployment
script fix, and historical image cleanup. The selected code change preserves
the existing listener rather than requiring a wildcard bind. Final merge still
belongs to the maintainer; production remains exact clean `origin/main` through
the guarded entry point.

The lead owns integration, documentation, split commits, independent validation
and serialized host operations. One `luna-worker` owns the bounded smoke/binding
implementation and focused tests; a second reviews the permission-transition
constraints read-only. No worker may mutate production or the Git index.

## Reproduction and acceptance

The preflight observed a Web port explicitly bound to a host interface. Both
`release_run_gateway_smoke` and the standalone smoke URL validator accepted only
loopback, so that valid deployment could not finish activation or recovery
verification. The original standalone command failed at `input` with
`invalid_base_url`, zero completed checks, before any request.

Acceptance requires:

- deriving the target from the unique, verified current Web container binding;
- accepting supported literal addresses only when the checking host actually
  owns them, while preserving loopback/wildcard behavior;
- rejecting foreign private/public addresses, arbitrary names, malformed input,
  redirects, credential-bearing URLs and ambiguous Docker bindings;
- preserving bounded, anonymous, content-free HTTP, static-asset and WebSocket
  checks, exact release-label verification and the existing recovery order.

## Security and data review

The affected surface is operator verification, not a P2P or Workspace business
API. No database, object, audit, quota, session, message or worker behavior is
changed. P2P plaintext and invite fragments remain outside the server.

The threat is allowing a smoke target to point to an unrelated server that
could falsely satisfy a release gate or receive diagnostic traffic. Docker
binding discovery remains tied to exact container ownership and release labels;
host-interface membership is an additional restriction, not a private-network
allowlist or a free-form URL override. Tests use synthetic interface addresses,
not production configuration. Neither credentials nor response bodies are
printed, and redirects remain forbidden. A privileged host operator capable of
changing Docker or host interfaces remains inside the existing operator trust
boundary.

There is no reason to weaken Nginx/Caddy headers, expose private readiness or
metrics, change application bindings, disable local mirror writes, or make
credential files group/world-readable for this correction.

## Host remediation evidence and limits

The maintainer-authorized cleanup removed ten obsolete DualLane test images and
three unreferenced older public images by exact IDs, without force. All running
and stopped container references were excluded; current production, migration,
storage, proxy and DualLane rollback images were retained. No container, volume,
backup, daemon setting or source checkout was deleted. Observed free space rose
from approximately 4.9 GiB to 10.0 GiB. Private operator evidence retains the
individual IDs and available public registry recovery references outside Git.

The credential file was `0600` but owned by the host deployment identity, not
Go UID 65532; an actual UID-65532 access check failed. The local mirror root was
readable but not writable by that UID while mirror writes were enabled. A live
read-only inventory found no unreadable business object; the one unreadable
file was a historical migration report outside the blob subtree. This is not
an offline inventory, full-byte verification or permission migration.

The available host login requires interactive administrator authentication for
privileged operations. No password was requested in chat, and Docker host-root
mounts were not used to bypass that boundary. Production permissions remain
unchanged pending the [storage permission gate](../STORAGE_OPERATOR.md).
The maintainer can execute scoped `sudo` commands manually. Read-only
administrator prechecks may establish that execution path, but the separate
offline maintenance/recovery workflow is still unimplemented and unvalidated;
this correction does not claim that administrator authentication alone unblocks
the Go release.

## Validation and next gates

The lead reproduced the input rejection against an actual non-loopback WSL
interface on base `3afbb2f79a76768170be0c2fddd61f8dc167c075`, with zero network
checks completed. In a clean native Linux validation checkout of that base,
Node `22.23.2` / pnpm `10.30.3` completed `pnpm install --frozen-lockfile`,
`pnpm lint`, `pnpm build` and `pnpm test`: SDK 8 passed; Web 732 passed and 2
PostgreSQL-only cases skipped by the ordinary suite, 134.75 seconds for Web.
These are explicit baseline results, not results for an unfinished patch.
The production database was not used by any test.

The lead independently validated code commit
`87518edd0e1fb0db78a5bc73d174eaf5dea48538` on native Linux with Node `22.23.2`
and pnpm `10.30.3`:

- `pnpm lint`, `pnpm build`, and `pnpm test` passed on the patch. SDK: 8 passed;
  Web: 82 files / 732 tests passed, 2 PostgreSQL-only tests skipped, 115.34 seconds.
  The build retained the existing large-chunk warning.
- `node --test scripts/backend/local-gateway-binding.test.mjs
  scripts/backend/gateway-readonly-smoke.test.mjs
  scripts/backend/release-activation.test.mjs
  scripts/backend/production-deploy.test.mjs`: 78 passed, no skips. This includes
  the copied shell-helper fixture using loopback and an actual host IPv4 address.
- With `DUALLANE_RELEASE_DRAIN_COMPOSE_ROUNDTRIP=1`, the `release-cleanup`,
  `release-go-restore`, `release-trap-status`, `release-compose-snapshot`,
  `release-external-files`, `release-drain-config`, `release-node-authority` and
  `release-volume-authority` Node test files produced 65 passes and one skip.
  The real Docker Compose config roundtrip passed. The unreadable-file case was
  skipped because this local validation identity was root.
- In an isolated development-only worktree on the target host, Node `22.22.0`
  under the unprivileged deployment account ran `local-gateway-binding`,
  `gateway-readonly-smoke` and `release-external-files`: 20 passed, no skips,
  including that unreadable-file case. These tests used synthetic files and
  data, not production credentials or the production database.
- The new standalone checker passed all 13 anonymous checks against the running
  Node `0.15.5` gateway's existing host-interface binding. The actual Web
  container/image identity and full revision were checked separately before
  the smoke. Production source, permissions, listener and running owners were
  not changed by this check. No Go cutover or authenticated business-flow
  acceptance is implied by this result.

No database, Go runtime, browser flow, Compose definition or image build input
changed in this correction. Full Go/PostgreSQL, image and browser CI remain
separate evidence; local frontend build is not a production image build. A
successful public health request does not constitute a Go release gate.

Before production: maintainer merges the validated correction; the authorized
host administrator resolves the credential/deployment-reader and quiescent
mirror permissions without weakening private modes; full authority, backup,
fencing, drain, candidate and recovery gates pass; then the coordinator builds
and activates the exact merged commit. Keep Node and its recovery material for
the rollback window. Any permission, provider, authority or smoke failure is a
stop condition, not permission to bypass the guarded workflow.

The maintainer subsequently enabled root-key access. The
[root cutover continuation](2026-09-09-root-cutover-preparation.md) records the
explicit offline preparation mode and its new validation evidence. The checks
above remain evidence for the earlier binding-only correction.
