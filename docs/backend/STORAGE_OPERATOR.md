# Storage Operator

Read [Security and data](../development/SECURITY_AND_DATA.md),
[Runtime and operations](OPERATIONS.md), and the
[content-addressed storage contract](../WORKSPACE_CONTENT_ADDRESSED_STORAGE.md)
before operating on Workspace storage. P2P content is never an input.

## Current Executable Surface

`apps/backend/cmd/storage` provides candidate **read-only** `plan` and `verify`
commands. Neither command performs backfill, migration, provisioning, legacy
deletion, quota changes, or a writer handoff. `--apply` is rejected. Use a
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
  --store s3 --s3-credentials-file /run/secrets/workspace-s3.json --timeout 5m
```

S3 endpoint, region and bucket may use the existing Workspace S3 environment
variables. Optional `--schema` selects one explicit PostgreSQL schema;
`--pool-max` defaults to two. `--space-id` and `--daily-quota-bytes` identify the
quota evidence policy. Do not infer a deployment's policy from CLI defaults.

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
