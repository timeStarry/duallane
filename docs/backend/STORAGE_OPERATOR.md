# Storage Operator

Read [Security and data](../development/SECURITY_AND_DATA.md),
[Runtime and operations](OPERATIONS.md), and the
[content-addressed storage contract](../WORKSPACE_CONTENT_ADDRESSED_STORAGE.md)
before operating on Workspace storage. P2P content is never an input.

## Current Executable Surface

`apps/backend/cmd/storage` provides **read-only** `plan` and `verify`
commands, plus the separately scoped `provision` command below. Neither `plan`
nor `verify` performs backfill, migration, provisioning, legacy deletion, quota
changes, or a writer handoff. They reject `--apply`. Use a
read-only database account and read-only object credentials where possible.
No production execution is implied by a passing candidate test.

## Retained Offline Compatibility Tools

These are retained one-shot Node compatibility tools, not request handlers,
continuous processes, Go startup hooks, or a complete Go replacement. The
exact 0.17 production evidence is recorded in the
[bridge/release record](work-items/2026-09-10-chat-0170-after-bridge.md). The
table records executable operator boundaries, not authorization to replace or
run alongside the Go owner.

| Capability | Retained Node command and behavior | Go executable/ownership status |
| --- | --- | --- |
| Schema migration | No Node-compat migration command is retained. Canonical SQL remains at `apps/web/server/migrations`; the current `apps/backend/cmd/migrate` service is the explicit Go one-shot runner. | Go owns the online migration runner; it is not invoked by application startup. Never add a second Node migrator. |
| S3 migration and archive | `pnpm --filter @duallane/node-compat-tools storage:migrate` is an explicitly invoked offline operator with `backfill` or `verify`. Its inventory uploads active attachment/avatar records and treats unconsumed local keys as run-specific archive records. | Go `storage plan` and `storage verify` can produce/read evidence; there is no Go S3 migration executor. |
| Canonical backfill | `pnpm --filter @duallane/node-compat-tools storage:dedupe` with `WORKSPACE_STORAGE_DEDUPE_MODE=backfill` creates/reuses canonical objects and binds attachment, avatar, and emote references while retaining legacy bytes. | `internal/workspace/storageops.RunBackfill` plus `PGJournal` is a coordinator-supplied candidate library only; it has no executable, scheduler, owner transition, or Compose service. |
| Verification | Node-compat `storage:migrate` supports `verify`; `storage:dedupe` supports `verify` and records its operator report. | `duallane-storage plan` and `duallane-storage verify` are read-only checks for PostgreSQL and local/S3 bytes; they do not perform mutating verification or change runtime ownership. |
| Legacy finalization | Node-compat `storage:dedupe` with `WORKSPACE_STORAGE_DEDUPE_MODE=finalize` verifies the inventory and then deletes legacy objects under the reviewed object lock. | No Go finalize command exists. The Go backfill library cannot delete legacy bytes or close the compatibility window. |
| S3 provisioning | `pnpm --filter @duallane/node-compat-tools storage:provision` provisions and verifies the private bucket controls when separately authorized. | No provisioning is attached to Go startup, health checks, or default Compose startup. |

The corresponding current Compose services are opt-in: `storage-provision` and
`storage-migrate` use profile `storage-migration`, while `storage-dedupe` uses
profile `storage-dedupe`; each uses the `tools/node-compat` image and is
`restart: "no"`. The default `migrate` service is the Go one-shot runner and
does not invoke any `storage:*` command. Do not change these profiles or add
them to default startup as part of a compatibility rehearsal.

Before any retained Node-compat storage command, obtain explicit operator approval,
take and verify the required database/object-volume or bucket backup, drain
and fence Node API writers, Go Workspace/worker writers, upload finalizers,
and other storage maintenance, and identify one database/object authority and
one active owner. Do not run these commands concurrently with Go writers or
against a live shared authority. Use a stable run ID when the command supports
resumption. `finalize` is destructive legacy deletion, not a routine action to
run while the compatibility window remains open: explicitly close the legacy
compatibility window first, verify an independent, recoverable backup and its
restore path, and record the decision. After deletion, any rollback that
depends on the deleted legacy bytes is no longer available; recovery requires
that independent backup and the matching database/object authority. A window
still being open is not permission to finalize.

The Go workspace and worker entrypoints do not spawn Node or invoke these
offline scripts; the Go storage diagnostic is manually invoked and does not
attach itself to runtime or worker startup. This is an entrypoint contract,
not a claim that every Go package has been whole-program audited. Retain the
Node-compat package and its rollback authority until the handoff and
same-authority rollback gates in this document are independently accepted.

Build from `apps/backend` with `go build -o storage ./cmd/storage`. Supply
`DATABASE_URL` through the operator's private environment; do not put its value
in reports, PRs, process arguments or shell history. Commands below assume that
environment is already configured and use placeholders only for non-secret
paths:

```sh
./storage plan --target postgres --migrations-dir /checkout/apps/web/server/migrations
./storage verify --target postgres --migrations-dir /checkout/apps/web/server/migrations \
  --store local --object-root /data/workspace-files --timeout 5m
./storage verify --target postgres --migrations-dir /checkout/apps/web/server/migrations \
  --store s3 --s3-credentials-file /run/secrets/workspace-s3 --timeout 5m
```

S3 endpoint, region and bucket may use the existing Workspace S3 environment
variables. Optional `--schema` selects one explicit PostgreSQL schema;
`--pool-max` defaults to two. `--space-id` and `--daily-quota-bytes` identify the
quota evidence policy. Do not infer a deployment's policy from CLI defaults.

For the Go Workspace process, `DUALLANE_DATA_DIR` is the business/data mount
root, while the local blob root is `filepath.Join(DataDir, "workspace-files")`.
For example, a container mount at `/app/data` must expose local canonical and
legacy bytes below `/app/data/workspace-files`; `/app/data` itself is not the
blob root. The permission probe follows this same mapping: its synthetic data
volume is mounted at `/app/data`, and its canonical/legacy checks open the
`/app/data/workspace-files` subtree. The synthetic rehearsal does not by itself
prove that an existing Node volume has been copied or reconciled correctly.

## S3 Bucket Provisioning

`storage:provision` in `tools/node-compat` is a separate, explicitly invoked
bucket-control operation. It never runs during Workspace/worker startup or
passive health checks. After the operator has approved the target, backed it up,
and fenced writers, run it from the isolated environment with the existing
Workspace S3 variables and private credentials file:

```sh
pnpm --filter @duallane/node-compat-tools storage:provision
```

The operation enables versioning, restricts CORS to GET/HEAD from the chosen
HTTPS origin, and configures seven-day incomplete multipart cleanup. It replaces
the complete CORS and lifecycle configurations, including unrelated rules;
inspect/export the current bucket configuration and approve that replacement
before running it. Partial failures produce a safe report and nonzero exit,
without an automatic rollback or a database/owner change.

An unsupported CORS API reports `gateway` fallback. Unsupported lifecycle
configuration reports `application` cleanup and, only during apply, verifies
multipart permissions using a bounded, zero-byte create/list/abort canary. Abort
has an independent five-second cleanup context even after cancellation. Cleanup
failure is an error. The default plan never creates or aborts a multipart upload.
Fallback reports do not enable missing gateway/worker behavior by themselves.

`privatePolicy: verified` means only that `GetBucketPolicy` did not contain an
anonymous Allow principal; unproven `Allow.NotPrincipal` and malformed nonempty
policy documents fail closed. It is **not** an ACL, Public Access Block or complete
bucket-access assessment; prove those separately for the provider. Credentials,
endpoint URLs, policy bodies and raw provider errors are excluded from reports.
No external S3 provisioning is implied by the synthetic candidate tests.

This is a bucket-only offline tool: it uses the private S3 endpoint, not an
online delivery route. It does not certify Go application configuration, signed
delivery, gateway CORS or worker readiness. Inspect action outcomes and the exit
status after a partial error.

## Historical 0.17 permission transition: Node root to Go `65532`

This section records the retained 0.17 first-cutover gate and rehearsal
procedure; it is not a current 0.18 command path. The current 0.18 tree uses
the Go-to-Go snapshot procedure in [Runtime and operations](OPERATIONS.md).
For a separate old Node-owned installation, perform first migration and
permission preparation from the retained 0.17 checkout and runbook. There is
no current-tree bootstrap or `--prepare-go-permissions` command. There must be
one authoritative writer for the registry and the bytes it references.

The target permission posture preserves private storage: data directories are
normally `0700`, regular object and legacy files are normally `0600`, and the
active Go process owns the files it must write as UID/GID `65532:65532`. Do not
make private data world-readable to avoid proving the transition.

### Pre-deployment gate

Complete each item against an immutable candidate image and an explicitly
identified data authority. A health-only candidate is a read-only observer; it
is not the owner handoff.

1. Record the current Node owner, database/schema revision, local volume name
   and object root (if used), S3 bucket/prefix (if used), active workers, and
   outstanding uploads/jobs. Drain and fence Node API writers, storage
   maintenance, workers, and upload finalizers before taking the copy. A
   candidate health check does not prove that the old writers are quiescent.

2. Inspect the candidate container configuration without changing it:

   ```sh
   docker inspect <candidate-container> --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}'
   docker inspect <candidate-container> --format '{{json .Mounts}}'
   ```

   For the health-only rehearsal, expect the process identity to be
   `65532:65532`, a read-only root filesystem, and a read-only data mount. An
   active Go writer requires a separately approved read-write data mount after
   the old writer is fenced. A read-only root filesystem does not make a
   mounted volume read-only.

3. Do not treat an image-layer ownership change as a volume migration. For
   example, `chown 65532:65532 /app/data` while building the image changes only
   the image layer. When an existing named volume is mounted at `/app/data`,
   its existing files and ownership remain unchanged. The image build cannot
   repair, normalize, or validate that old named volume.

4. Prove effective access with the permission probe using only its synthetic,
   uniquely labelled non-production Docker volumes. The script is a rehearsal
   of the actual UID, mode, bounded canonical/legacy reads, and rejection
   boundaries; it does not inspect or modify a production volume:

   ```sh
   node scripts/backend/runtime-permissions.mjs --docker \
     --image <immutable-candidate-image> \
     --init-image <explicit-shell-helper-image>
   ```

   The probe must finish with the expected root-owned denial cases and
   `65532:65532` positive cases, including the `0600` secret case where the
   target identity is the owner. The runner mounts the data volume at
   `/app/data` and creates all blob fixtures below `/app/data/workspace-files`;
   the root-data-denied case keeps the parent `/app/data` root-owned `0700`.
   All fixture mounts disable image copy-up, and initialization explicitly sets
   root or Go ownership; the chosen helper image cannot silently change the
   expected permission case through its baked-in directory ownership.
   The explicit shell helper image is used only by the root synthetic init
   container. It may be the same Debian Go workspace image as the candidate
   when that image provides `/bin/sh`; a separate helper image is optional.
   The runner does not infer persistent-volume policy from image declaration
   metadata. After each container is created, it verifies the effective
   `Mounts` and rejects any unexpected RW mount (for example,
   `container_unexpected_rw_mount:/var/lib/postgresql/data`). Both containers
   are synthetic, network-free, labelled resources.
   Boundary data is generated in the container;
   do not pass multi-megabyte base64 through Docker environment or argument
   lists. The runner has bounded Docker command timeouts and rejects oversized
   environment/argument payloads.

5. Separately prove the actual staged local copy with the probe binary in a
   candidate container. Mount the manifest and staged business/data root
   read-only and do not print file contents or secret values. The probe opens
   the physical blob root at `/app/data/workspace-files` below that mount:

   ```sh
   docker exec --user 65532:65532 <candidate-container> \
     duallane-permission-probe --manifest /run/permission-probe/manifest.json
   ```

   The manifest must enumerate only synthetic or operator-approved test
   entries and must not contain secrets. A successful `storage verify` remains
   a separate database/object-integrity gate; the probe demonstrates effective
   filesystem access under UID `65532`, not registry authorization or a
   complete migration.

6. Check the S3 credential file independently of the object verification.
   From the candidate container, inspect metadata and attempt only an open as
   the real Go identity; never print the file:

   ```sh
   docker exec --user 65532:65532 <candidate-container> sh -c \
     'stat -c "%u:%g %a" /run/secrets/workspace-s3 && test -r /run/secrets/workspace-s3 && exec 3< /run/secrets/workspace-s3'
   ```

   Require the actual file to be mode `0600` and to have an owner/group that
   makes it readable by the Go process (normally `65532:65532`, subject to the
   approved secret backend contract). A compose-file `mode: 0600` declaration
   alone is not proof of the mounted file's UID/GID or readability. If the
   check fails, stop the rehearsal; do not weaken the mode or log the secret.
   This gate is independent even when S3 is the primary store and the local
   mirror/fallback is disabled.

### Deployment-reader and mirror-write prerequisites

The credential has two distinct readers: the Go process under UID 65532 and
the trusted host deployment identity. The latter reads the source file when
`release-external-files.mjs` captures and verifies its fingerprint. A `0600`
file owned by UID 65532 does not automatically remain readable by an unrelated
unprivileged deployment account. Prove both readers before starting the release;
do not finish a host ownership change and discover this only after migration.
An authorized administrator or approved secret-backend arrangement is required
when the host account cannot satisfy both checks. Preserve `0600`; do not add
group/world read bits, disable fingerprint validation, run the active Go service
as root, or mount the host root/Docker socket into a helper to bypass missing
administrator authentication. Never ask an operator to paste a password into
a task, PR or log.

If the operator can run `sudo` interactively, provide scoped commands for that
terminal and identify whether each is a read-only precheck or an offline change.
A successful `sudo -v` there does not grant another terminal or agent session
administrator access. Do not request a broad passwordless rule. A privileged
deployment identity also needs its own verified Git checkout access, required
tools, local Docker context and release lock; do not assume the unprivileged
account's shell or Docker configuration carries over. Changing the identity is
not a substitute for the offline storage and same-authority recovery gates.

Local read fallback and local mirror writes are independent settings. With
`WORKSPACE_STORAGE_LOCAL_READ_FALLBACK=false` and
`WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE=true`, successful legacy reads still do
not prove that Go can create, replace or clean mirror objects. Verify the
configured write paths and directory ownership as the actual Go UID in the
approved isolated/quiescent rehearsal, as well as full legacy readability.
Do not disable mirroring or change its authority merely to pass readiness.

Ad hoc permission preparation is not a supported mid-script repair hook. The
historical first cutover froze recovery from an actually running Node API and
Web before building; pre-stopping the old owner could not reconstruct that
state. Never forge the snapshot or source internal release helpers as an
alternate entry point. If an old installation needs an outage or staged
authority switch, define and validate that separate maintenance/recovery
sequence from the retained 0.17 checkout. A failed proof leaves ownership with
the old installation; it is not an invitation to run a bare Compose replacement
or revive two writers.

If an independent maintenance workflow returns Node to service before the Go
release, prove that subsequent Node mirror writes still leave Go-readable bytes
and Go-writable directories. Root-owned files or newly created private
directories can invalidate an earlier permission proof. A one-time successful
copy followed by unrestricted old-owner writes is not a stable cutover gate.

### Historical same-volume first-cutover preparation

The exact first-cutover command is intentionally not reproduced here. It
belongs to the retained 0.17 checkout and runbook; the current 0.18
`deploy.sh` rejects `--prepare-go-permissions`, `--bootstrap`, and Node-default
forms. The historical mode required the old Node API to be running as root
without dropped capabilities while the trusted coordinator compared database,
volume, and S3 authority. Go services and the canary remained UID/GID
`65532:65532`.

The mode deliberately introduces an outage before passive candidate readiness:

1. Capture the genuinely running Node state. For S3, back up and verify the
   private source credential before changing its owner to `65532:65532`, keeping
   `0600` and identical bytes/inode. Freeze both Node recovery and Go activation
   external-file fingerprints only after this transition. A failed later release
   keeps the prepared credential owner; the host deployment reader must remain
   privileged. No frozen fingerprint is rewritten to ignore drift.
2. Build immutable candidates and run the existing migration/authority gates.
   Mark the application as needing guarded recovery before fencing Node and
   observing the fresh runtime drain. Do not return Node to service between
   permission preparation and Go activation.
3. Take an additional quiescent PostgreSQL archive, verify its archive listing,
   and checksum it. This is archive readability evidence, not a full database
   restore rehearsal. Retain the original pre-migration backup too.
4. Resolve the existing local Docker volume. Reject active writable named/bind
   mounts, symlinks, hardlinks, special files, cross-device entries, drift and
   unsupported daemon/volume layouts. Copy all bytes plus original metadata to
   a new private backup, then fully verify that backup and unchanged source
   before any data-volume ownership/mode change. The bounded operator primitive
   refuses more than 20,000 entries, 8 GiB of file bytes or a five-minute
   operation budget; credentials have a separate 1 MiB cap. These limits
   cannot be raised through CLI flags. The immutable `manifest.json` records
   verified original metadata and full hashes before mutation. Atomic
   `phase.json` updates and `report.json` describe the outcome without
   overwriting that original evidence.
5. Tighten only filesystem metadata on that same offline volume: owner
   `65532:65532`, directories `0700`, files `0600`. Recheck complete byte hashes
   and metadata; no business bytes, registry rows or object keys change. Then
   run a network-free immutable-image canary as the real Go UID, creating,
   replacing and deleting only its private synthetic temporary files.
6. Check passive candidates, then repeat normal authority/fence/drain gates
   before Go activation. All failures after fencing use the existing guarded
   Node recovery path against the same current physical volume and credential.

This is an explicit **offline metadata conversion with a verified backup**,
not a staged-volume swap or a live recursive `chown`. It preserves the same
Node/Go storage authority, including Go writes after activation. The separate
staged-copy procedure below still applies if a deployment changes volumes.
Neither the backup nor its original ownership is automatically restored on an
application failure. Partial tightening remains readable to the retained root
Node; a subsequent Go attempt must repeat the offline gate because Node may
have created new root-owned entries. If fencing or authority is ambiguous,
leave writers stopped for operator review rather than attempting a stale-copy
recovery. Forced interruption can leave private recovery material or a synthetic
canary directory; inspect ownership before cleanup, never delete by a guessed
prefix. Keep all backup/recovery artifacts outside Git and public logs.

The filesystem backup proves byte preservation, not database-to-object registry
consistency or S3-provider compatibility. Those storage verification and online
business gates remain separate. The implementation and its validation state
are recorded in the [root cutover work item](work-items/2026-09-09-root-cutover-preparation.md).

### Offline quiescent copy

Take a snapshot or copy only after the old writers and upload finalizers are
drained and fenced. The operation must be performed by an approved operator
with the source and destination volumes explicitly identified; this runbook
does not provide a live-volume copy command. Keep the original source
unchanged as a recoverable backup, and keep the destination isolated until its
inventory and permission proofs pass.

The copy gate must demonstrate, without changing source bytes:

- every canonical object has the expected full size and SHA-256 digest;
- the legacy inventory needed for fallback is present and readable;
- object paths do not escape the configured root and symlinks are rejected;
- directory/file ownership and private modes are intentional for the future
  Go identity; and
- the database/object-registry verification and the filesystem verification
  describe the same staged authority.

Do not run automatic `chmod` or `chown` against a live or shared named volume.
If a separately staged copy needs ownership preparation, do it as a reviewed,
offline operation while all writers are fenced, record the before/after
metadata, and rerun the read-only probe and storage verification. A failed
proof leaves Node as owner; it does not trigger an in-place permission repair.

Keep legacy bytes and fallback enabled through the compatibility window. The
canonical addressed-storage contract requires complete inventory and
verification before legacy deletion; deleting or changing the source during a
permission rehearsal invalidates rollback evidence.

### Handoff and rollback authority

After the staged checks pass, route the active Go writer only after the Node
writer and all competing workers are fenced. Any read-write local mirror,
fallback, or cleanup operation is part of that single-owner handoff. Candidate
health mode and `OpenExisting` must not provision, chmod, chown, or otherwise
repair the volume.

The rollback target is the same authoritative volume/object authority that Go
has been writing. In particular, once Go has written to a staged destination,
Node rollback must mount that destination (and use the matching database/S3
authority); it must not simply remount the stale original copy. Mounting the
stale original would lose Go writes and can make the database/object registry
and bytes disagree, so it is not a valid rollback.

Before switching back, fence Go API/worker writers, drain in-flight uploads and
maintenance, and verify the rollback owner can read the current authority as
well as the current schema/data contract. Only then may Node be started and
routed. If the deployment cannot start Node against the same authority, stop
at a quiescent outage or perform a separately reviewed, bidirectional
reconciliation/copyback while both writers are fenced; do not automate a
stale-copy rollback.

Before legacy finalization, the compatibility window permits a coordinated
owner rollback while legacy fallback remains available. After legacy bytes or
their registry rows are finalized/deleted, recovery is a coordinated database
and storage restore, never a one-sided volume swap. Record the exact authority,
owner, fence, verification report, and rollback decision for each handoff.

## Guarantees And Limits

The database adapter uses one repeatable-read, read-only transaction for
migration history, canonical objects, logical references and upload quota
evidence. It issues no migration or business writes. Whole-catalog snapshots
fail explicitly above 100,000 objects, 100,000 combined resource references or
100,000 quota rows; this diagnostic is not an unbounded migration executor.
Manifest-file input is limited to 8 MiB and rejects unknown fields/trailing JSON.

Local verification opens an existing root without creating directories or
changing permissions. Canonical keys are derived from their digest; symlink
paths and escapes are rejected. S3 verification uses bucket/object reads, never
uploads, deletes, multipart aborts or provider configuration. Each verified
object must match byte size and a full-stream SHA-256. Interruption stops further
objects and closes the current body. The command has a bounded deadline (30
seconds by default, at most five minutes) and handles termination signals.

Reports are private metadata: counts, opaque IDs, field paths and safe codes,
not file content, original names, provider errors or credentials. A clean
manifest does **not** prove runtime fencing or backup restoration. In particular,
`mutationReady` remains false even if a file claims that writers are fenced.
Mutations require a separately acquired, live exclusive guard and the approved
backup/rollback procedure.

The retained offline Node dedupe `verify` also updates verification timestamps; this Go
read-only diagnostic deliberately does not. It is not a substitute for a
mutating finalization gate. Legacy-only or invalid references block canonical
verification and require the separately reviewed migration path.

## Developer Evidence

Run unit/race plus `postgres_integration` tests for `internal/workspace/storageops`
and `cmd/storage` with `TEST_DATABASE_URL` pointing at disposable PostgreSQL.
Tests cover the real command, local and HTTP S3 providers, bounded catalog
failure, no-write behavior, cancellation and secret-safe flag errors.
The historical Node storage fixture generator was retired with the online
implementation. Current command tests use synthetic manifests, exact digest
and byte-size assertions, and real disposable PostgreSQL; they do not claim
to regenerate Node observations. For historical file/emote byte compatibility,
use the frozen legacy gates in [Validation](VALIDATION.md#actual-node-legacy-emote-compatibility).
The retained offline operators have separate package tests, including the
explicit `NODE_COMPAT_TEST_POSTGRES=true` adapter test. None of these tests
proves production writer fencing or authorizes finalization.

## Candidate Backfill Library

`internal/workspace/storageops.RunBackfill` and `PGJournal` implement the
candidate mutation library, not an enabled CLI command. Migration `032` adds
run/item journals without modifying historical migrations. Each canonical
object acquire, logical-reference bind and item completion share one database
transaction; run/item revisions and captured source/reference metadata reject
stale work. Recovery requires the coordinator to supply a newly acquired live
fence, the old observed fence hash and matching run revision. A manifest or
caller-supplied boolean never substitutes for that coordinator.

Processing uses bounded keyset pages, roots before clone chains, full-byte
digest/size verification and independent cancellation cleanup. Only validated
canonical bytes may be created; this library cannot delete legacy bytes or
alter quota/audit/event ledgers. Its logical-byte report counts every completed
reference, including clones; unique bytes count each digest once. These are
operator report values, not mutations to user quota.

The CLI continues to reject `--apply` until live writer admission, exclusive
ownership and recovery are composed and independently tested. A passing
journal test alone does not authorize using this library against production.
