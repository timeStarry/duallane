# Storage Operator

Read [Security and data](../development/SECURITY_AND_DATA.md),
[Runtime and operations](OPERATIONS.md), and the
[content-addressed storage contract](../WORKSPACE_CONTENT_ADDRESSED_STORAGE.md)
before operating on Workspace storage. P2P content is never an input.

## Current Executable Surface

`apps/backend/cmd/storage` provides candidate **read-only** `plan` and `verify`
commands, plus the separately scoped `provision` command below. Neither `plan`
nor `verify` performs backfill, migration, provisioning, legacy deletion, quota
changes, or a writer handoff. They reject `--apply`. Use a
read-only database account and read-only object credentials where possible.
No production execution is implied by a passing candidate test.

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

`duallane-storage provision` is a separate, explicitly invoked bucket-control
command. It never runs during Workspace/worker startup or passive health checks.
With no `--apply`, it only reads bucket existence, policy, versioning, CORS and
multipart lifecycle settings and reports the planned changes. Supply existing
Workspace S3 environment configuration and a private credentials file:

```sh
duallane-storage provision --s3-credentials-file /run/secrets/workspace-s3 \
  --public-base-url https://your-workspace.example --timeout 30s
```

An operator-approved `--apply` enables versioning, restricts CORS to GET/HEAD
from the chosen HTTPS origin and configures seven-day incomplete multipart
cleanup. Like the existing Node provisioner, apply replaces the complete CORS
and lifecycle configurations, including unrelated rules. Inspect/export the
current bucket configuration and approve those replacements before applying.
Apply re-reads the configured values; partial failures produce a safe report
and nonzero exit, without an automatic rollback or a database/owner change.

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

This is a bucket-only tool: it uses the private S3 endpoint, not the Node signed
delivery configuration's public endpoint. It does not certify Node/Go application
configuration, signed delivery, gateway CORS or worker readiness. `versioning`
starts as `not_checked`; plan records the actual provider status (which may be
empty for a never-enabled bucket), and apply reports `Enabled` only after
revalidation. Inspect action outcomes and the exit status after a partial error.

## Permission transition runbook: Node root to Go `65532`

This section is a deployment gate and rehearsal procedure, not an instruction
to mutate a production volume. Node remains the active Workspace storage
owner until an explicitly approved handoff. There must be one authoritative
writer for the database/object registry and the bytes it references.

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

Node's existing dedupe `verify` also updates verification timestamps; this Go
read-only diagnostic deliberately does not. It is not a substitute for a
mutating finalization gate. Legacy-only or invalid references block canonical
verification and require the separately reviewed migration path.

## Developer Evidence

Run unit/race plus `postgres_integration` tests for `internal/workspace/storageops`
and `cmd/storage` with `TEST_DATABASE_URL` pointing at disposable PostgreSQL.
Tests cover the real command, local and HTTP S3 providers, bounded catalog
failure, no-write behavior, cancellation and secret-safe flag errors.
`scripts/backend/storage-operator-contract.mjs` generates a synthetic fixture
through the actual Node storage owner. Run Go `verify` against the returned
manifest/object-root and remove only that generated fixture directory afterward.
This fixture proves canonical-byte compatibility, not production owner safety.

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
