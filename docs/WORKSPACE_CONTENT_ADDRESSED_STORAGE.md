# Workspace Content-Addressed Storage Runbook

## Scope

Migration `025_workspace_content_addressed_storage.sql` adds a shared object
registry and nullable references for attachments, profile avatars, and custom
emotes. Logical quota, visibility, and authorization remain attached to each
Workspace resource. A shared byte object does not grant access to another
resource that references the same digest.

The local and S3 drivers use the same canonical key, which contains no user ID,
file name, MIME type, or Workspace ID:

```text
workspace/objects/sha256/<first-two-hex-digits>/<64-hex-sha256>
```

Runtime reads pass the registry row `object_key` to the object store. The store
rejects a key that does not exactly match the canonical key for the row digest.

## Before Starting

- Apply all migrations and create database plus storage backups.
- Keep application canonical-first, legacy-fallback reads deployed throughout
  the compatibility window.
- For S3, complete provisioning and the existing feature-prefix migration
  before deduplication. Keep the bucket private.
- Choose one 8-64 character run ID and reuse it for all phases and retries.

Reports are written below
`/app/data/workspace-storage-dedupe-reports/<run-id>-<mode>.json`. The directory
uses mode `0700` and each report uses mode `0600`. Reports contain internal
resource IDs, digests, sizes, and actions, but no original file names, legacy
storage keys, credentials, or signed URLs.

## 1. Backfill

Backfill fully hashes each eligible legacy source, idempotently ensures the
canonical local or S3 object, creates one registry row per unique digest, and
binds the logical resource reference. It retains all legacy bytes.
Retained custom-emote roots are included even when their creator has marked the
root removed, because cross-user clones or historical messages can still refer
to them. Every resolvable `source_custom_emote_id` clone is then bound directly
to the root object. A missing source or source cycle fails with a stable record
instead of silently leaving a clone on legacy-only storage.

```bash
WORKSPACE_STORAGE_DEDUPE_RUN_ID=dedupe-YYYYMMDD \
WORKSPACE_STORAGE_DEDUPE_MODE=backfill \
docker compose -f docker-compose.yml -f docker-compose.production.yml \
  --profile storage-dedupe run --rm storage-dedupe
```

Rerun backfill with the same run ID after any interruption. Do not advance
until the report is `completed` and normal attachment, avatar, and custom-emote
health checks pass through the deployed application.

## 2. Verify

Verify loads each bound registry row and performs a complete canonical read,
byte-size check, and SHA-256 comparison. It does not read legacy bytes, so it
remains repeatable after finalization.

```bash
WORKSPACE_STORAGE_DEDUPE_RUN_ID=dedupe-YYYYMMDD \
WORKSPACE_STORAGE_DEDUPE_MODE=verify \
docker compose -f docker-compose.yml -f docker-compose.production.yml \
  --profile storage-dedupe run --rm storage-dedupe
```

Review the private report and repeat deployment health checks. Do not run
finalize merely because backfill completed; canonical delivery must be healthy
for the active storage driver first.

## 3. Finalize

Finalize first verifies the entire canonical inventory. If any object fails,
no legacy object is deleted. Only after every object verifies does it delete
legacy local and/or S3 objects one by one. Deletion is idempotent, so an
interruption during cleanup can be resumed safely with the same command.

```bash
WORKSPACE_STORAGE_DEDUPE_RUN_ID=dedupe-YYYYMMDD \
WORKSPACE_STORAGE_DEDUPE_MODE=finalize \
docker compose -f docker-compose.yml -f docker-compose.production.yml \
  --profile storage-dedupe run --rm storage-dedupe
```

Run `verify` again after finalize. Preserve the pre-cutover database and storage
backups for the rollback window even though live legacy bytes have been removed.

## Recovery And Rollback

All phases are deterministic and idempotent. Correct the reported storage or
database availability issue, then rerun the failed phase with the same run ID.
The report's failed record contains only an internal resource kind and ID.

Before finalize, rollback is a deployment rollback because legacy bytes remain.
After finalize, restore the coordinated pre-finalize database and storage
backups; restoring only one side can leave references pointing at unavailable
bytes. Keep canonical-first, legacy-fallback code until the rollback retention
window closes.

The registry's low-level delete API is not an authorization or reference-count
policy. Live writes must use the digest-locked registry helper to acquire and
bind objects, release references, and delete physical bytes only after the last
attachment, avatar, and custom-emote reference is gone.
