# Frozen candidate network isolation — 2026-09-10

## Actual release and recovery evidence

PR #4 passed all four jobs in [CI run 34374480609](https://github.com/timeStarry/duallane/actions/runs/34374480609)
for head `380bfd6e59d58c2e5f2e2971b35d502d630e91fb`. The maintainer-authorized
normal merge produced `62ac338332ea41b7edaeb5eba698dc6df3070e15` with the same
tree. Production pulled that exact clean `origin/main` and ran the official
first-cutover entry point using root, the existing local daemon, and
`--release-profile go-full --prepare-go-permissions`.

The exact Go images built and passed identity checks. The one-shot migration
completed; a later read-only check confirmed 33 migrations, ending in
`033_workspace_command_result_finalization.sql`. After fencing Node and
draining, the coordinator verified the quiescent PostgreSQL backup and copied
1,574 files in 1,126 directories, totaling 316,562,584 bytes. Source and backup
hashes matched before and after tightening local ownership/modes. The UID/GID
65532 synthetic create/rename/read/delete canary passed and cleaned up.

The P2P passive candidate then failed `candidate network alias is not isolated`.
The coordinator removed its owned candidate/network, fenced before recovery,
and restored the captured immutable Node API/Web images with their original
restart policies. PostgreSQL retained the same container and authoritative
volume; no old database or object bytes were restored. The private verified
backups, additive schema and intentional 65532 permission changes remain.
The retained root-compatible Node owner can use these tightened permissions.

Recovery passed all 13 direct gateway checks and the independent external
HTTPS/WSS Node 0.15.5 check. The replacement Node API/Web containers were
healthy, with the original image IDs and release revision
`a186de9e971398e29fa7d4b8d2254685e5445eb2`. The unrelated proxy stayed running;
the Docker daemon was not restarted. Go production ownership did not activate.

## Root cause and narrow fix

The canonical frozen Go activation JSON contains `networks: {default: null}`
for P2P, Workspace, worker and Web. The candidate overlay previously added a
`candidate` network by ordinary mapping merge. For P2P/Web this retained the
default production network. Their `docker compose run --use-aliases` then
published the upstream alias on both networks, correctly failing the guard.

Existing disposable fixtures explicitly selected candidate-only P2P/Web
networks before the overlay was applied, so their passing isolation check did
not cover this canonical production JSON round trip.

Only P2P/Web candidate `networks` now use Compose `!override`, supported by the
already-required Compose version. These two candidates have only the isolated
candidate network. Workspace/worker retain the default network for PostgreSQL;
their upstream aliases continue to be attached only on the isolated network
by the existing coordinator. The active composition is unchanged.

Do not remove the runtime alias guard, disable TLS, weaken private candidate
health/read-only behavior, expose a candidate port, or alter production ingress.
No application, API, schema, dependency, data path or provider behavior changes.

## Acceptance and continuation

Lead validation completed on WSL/Linux: all 62 deployment and passive-candidate
tests passed with zero skips (147.98 seconds). A separate real Docker check
used the actual canonical configuration and a pre-existing immutable P2P image:
the reconstructed old overlay leaked the default-network alias; the fixed
overlay exposed it only on the candidate network. Both assertions passed with
no ports, mounts, build, pull or production access. Its two owned containers
and two owned networks were verified and removed. Latest-head actual-file
round-trip regression and CI results belong in the associated PR.

- Resolve the actual three release Compose files with synthetic inputs and
  empty dotenv; freeze their canonical JSON, then apply the actual candidate
  overlay. Verify all four network/alias policies and read-only data mounts.
- Reconstruct the old non-override overlay in a private temporary file and
  prove the original default-network leak is detected.
- Run focused deployment/candidate guards and the full latest-head CI before
  normal authorized merge. Record completed checks in the associated PR;
  earlier PR results are not a substitute for the new gate.
- Pull the new exact main commit and retry only through the official release
  entry point. Recheck current authority, backups and permissions; do not reuse
  an earlier in-memory release state or bypass preparation/recovery guards.

Until a real activation succeeds, the capability ledger remains `parity` with
Node as production owner. Node removal is deferred to a later version. Neither
the local full-byte backup nor this recovery proves every S3 object or real
OAuth/provider/business flow; those acceptance limits remain explicit.
