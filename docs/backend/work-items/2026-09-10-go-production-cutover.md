# Go production cutover — 2026-09-10

## Outcome and scope

The authorized official deployment completed successfully for **0.16.0**,
commit `76e579f6887f3abcfe4cee45a4eaf3929c3ea6ae`, using `go-full` in
`/home/timestarry/duallane` and its local Docker daemon. Activation completed
around 2026-09-09 16:45 UTC (2026-09-10 00:45 Asia/Shanghai).

Go P2P, Workspace and worker are healthy production owners behind Nginx. The
one-shot Go migrator completed and was removed by the coordinator. The retained
Node API is stopped with restart disabled, not a duplicate writer/claimer.
This is `routed` acceptance, not final `active`/`complete` acceptance or Node
removal. Authenticated business/provider checks remain explicitly outstanding.

The maintainer authorized related PR merges after validation and authorized
root-key transport for this task. The lead used ordinary exact-head PR merges,
not administrator overrides, protection bypasses or direct pushes to main.
That task-specific authorization does not change general repository policy.

## Release provenance

- [PR #3](https://github.com/timeStarry/duallane/pull/3): production preflight,
  coordinated offline permission preparation and recovery, merged `8c1fda1`.
- [PR #4](https://github.com/timeStarry/duallane/pull/4): explicit Go Web image
  identity; verified head `380bfd6`, merge `62ac338`, identical trees.
- [PR #5](https://github.com/timeStarry/duallane/pull/5): canonical frozen
  candidate network isolation; verified head
  `f0ebfd84dd9674da11c9173ca5b92fdbcec4e5d1`, merge `76e579f`, identical trees.

The latest source gate was [CI run 34377034821](https://github.com/timeStarry/duallane/actions/runs/34377034821):
all four jobs passed, including application tests/lint/build/Chromium, Go
test/race/analysis/build/PostgreSQL and native/legacy storage compatibility,
Go Workspace browser/privacy and Go P2P browser/privacy/transfer. Lead local
evidence included 62 deployment/passive checks (zero skips, 147.98 seconds),
four actual Compose contracts (zero skips, 12.87 seconds), and a real disposable
Docker reproduction of the candidate alias leak and its fixed isolation.

| Service/artifact | Exact production image ID |
| --- | --- |
| P2P | `sha256:dced00cda53d5490d56be8a036cabb56297f2b4dda40d2119b71cd0f2fc6591b` |
| Workspace, worker, migrate | `sha256:75ae801e051983ef1e97a8c362a4598b246e4ba2359d5b054d515010deae1d6c` |
| Web | `sha256:0105852ecc1431727ab01b42bbdf379336bc093bdaf9d549071297ca0352601b` |

Actual image/container labels matched version 0.16.0 and the complete release
commit. The live Web publishes only the unchanged `100.99.0.5:8787` binding.
P2P/Workspace/worker publish no host ports; P2P has no persistence mounts or
Workspace database/storage credentials. Go runs as 65532:65532 and Web as
101:101, all with read-only root filesystems.

## Data, ownership and recovery

The authoritative PostgreSQL container and volume
`duallane-postgres-restored-20260810` did not change. The schema contains 33
migrations, ending at `033_workspace_command_result_finalization.sql`.
Go reuses `duallane_duallane-data`, the existing S3 credential/bucket/endpoint
and local mirror; S3 remains primary, local mirror writes remain enabled and
local read fallback remains disabled. Workspace background workers are disabled;
the dedicated worker preserves the former Node worker-enable configuration.

The coordinator fenced Node, verified bounded drain observations, made a
quiescent PostgreSQL dump and verified its archive/checksum before local
permission preparation. It copied and verified 1,574 files across 1,126
directories (316,562,584 bytes), preserving file bytes while tightening owner
and modes. The synthetic UID/GID 65532 create/rename/read/delete canary passed
with owned cleanup. All four unpublished passive candidates passed before Go
activation; Web was replaced last. No bare Compose activation was used.

Private production artifacts share this basename:

```text
backups/production/duallane-20260909T164247Z-76e579f6887f
```

The `.dump` and `.recovery.quiescent.dump` checksums were reverified after
deployment. The base Go recovery artifact is
`.recovery.go-compose.snapshot.json`; its `.compose.json`, `.external.json`
and `.volumes.json` sidecars are retained alongside it. All four are regular
mode-0600 files. Independent read-only verification passed the snapshot,
external-file fingerprints, physical-volume authority and retained Node
recovery authority. Private artifact contents must never be committed.

The [preceding guarded refusal](2026-09-10-candidate-network-isolation.md)
exercised actual Node recovery after the same additive migrations and permission
conversion: exact old images/restart policies, unchanged PostgreSQL/storage and
passing direct/public gateway checks. No stale database or object bytes were
restored. That recovery evidence does not authorize an unguarded later rollback;
new writes must remain on their current authority.

Root's earlier optional Git index refresh had changed the index owner. While
holding the existing deployment lock, the lead restored only that verified
regular index inode to the checkout owner, preserving mode and bytes. This
release used process-local `GIT_OPTIONAL_LOCKS=0` and exact-directory Git trust;
the checkout remained clean and its index remained ordinary-user owned. No
global Git, Docker daemon, SSH or gateway setting changed. The official 4 GB
BuildKit cache cap reclaimed rebuildable cache; about 9 GB remained free.
Retained Node images/code and private recovery backups were not removed.

## Passing online evidence and limits

- The official local gateway smoke passed all 13 checks, including exact
  version health, static assets, anonymous Workspace denial, private-path 404s
  and Workspace WebSocket authentication denial.
- Independent public HTTPS checks passed for `https://duallane.tsio.top`:
  security headers, two referenced assets, version 0.16.0, ICE response,
  unauthenticated HTTP/WSS denial and private endpoint non-exposure.
- A bounded live P2P probe created only one transient room and two anonymous
  connections. Joins, peer lists, opaque secure-envelope relay, rejection of
  synthetic plaintext/invalid nonce without observed relay, peer departure and
  own connection cleanup/empty-room verification passed (1,001 ms). The earlier
  Node baseline passed the same probe. No invite fragment, real user content,
  room/peer ID, cookie or token was printed. This is not WebRTC or E2E crypto proof.
- Initial runtime inspection confirmed all four services healthy with zero
  restarts, exact images, correct worker separation and unchanged authority.
  A second check at 16:53 UTC (about eight minutes after activation) reconfirmed
  those invariants and the public HTTPS/WSS checks. The bounded Go log sample
  contained no warning/error entries; the worker had 18 informational entries.
  This short observation is not a sustained soak or load test.

Not passed/not run in production:

- Real OAuth/session and authenticated Workspace reads, synthetic messages,
  reconnect/replay, upload/download, quota, media and extended workflows need
  the maintainer's normal browser login and a dedicated test conversation.
  The observed browser was still on the login page. No SQL sessions were minted
  and no real-recipient test notifications were sent.
- Actual email/ntfy/Bot provider delivery and longer resource/claimer observation
  remain separate acceptance. Healthy workers are not provider delivery proof.
- The pre-cutover canonical storage verifier refused before scanning bytes:
  779 legacy-only references had no canonical object ID, and the then-current
  Node schema had 29 migrations. Read-only metadata found no dangling non-null
  canonical references. The later schema upgrade does not backfill those IDs.
  This refusal is not missing-file proof, nor full S3/legacy byte acceptance.
  The local backup hash/canary evidence above must not be presented as a full
  S3 verification. No backfill, finalize or object cleanup was performed.

## Next operator/development steps

Develop routed capabilities in Go; keep Node edits limited to rollback and
offline compatibility. Complete the authenticated/provider and observation
gates before advancing status. Remove Node only in the separately validated
later release requested by the maintainer.

The next application deployment is **Go-to-Go** and requires the last successful
private snapshot plus `--release-profile go-full --go-upgrade`, as specified in
[Operations](../OPERATIONS.md#guarded-go-activation-and-upgrade-inputs). Do not
rerun first-cutover preparation or Node-default deployment against active Go.
Documentation-only commits do not change this deployed image identity.
