# Restore legacy S3 avatar reads

## Scope and ownership

Go Workspace owns the routed avatar capability. Restore display of existing
custom avatars under the existing authenticated endpoint, without changing
membership/visibility rules, public URLs, canonical writes, quota, retention,
audit, events, schema, object bytes or deployment settings. P2P is unaffected.
Node code, images, offline operators and recovery materials remain retained.

The maintainer's existing task authorization covers related fixes, ordinary
verified PR merges and guarded production deployment from the designated
checkout. It does not authorize protection bypass, storage finalization,
bucket exposure, session fabrication or user-content replacement.

## Reproduction and root cause

Read-only observations on 2026-09-10 against Go 0.16.0, deployed commit
`76e579f6887f3abcfe4cee45a4eaf3929c3ea6ae`, established:

- A bounded 30-minute gateway sample contained 211 avatar HTTP 404 responses
  for the five current legacy-only custom avatars, and three HTTP 200
  responses for the one current canonical custom avatar.
- All six corresponding local files still existed. The five legacy files
  totaled 18,068 bytes; the canonical file was 2,104 bytes.
- Read-only S3 HEAD returned 404 for all five unprefixed legacy keys and 200
  for all five actual Node-prefixed keys. The canonical key returned 200.
- No object bytes were read by this HEAD check. It proves presence and path
  mismatch, not full byte integrity or complete storage inventory acceptance.
- The bounded validator used an exact retained image only as an SDK runtime,
  with a read-only credential mount, no database or content mount, no server,
  no workers, no host ports and no mutations. Its owned container was removed.

Node's legacy avatar adapter derives `workspace/profile-avatars/<user>/<version>.webp`
for S3 while retaining `profile-avatars/<user>/<version>.webp` in the database
and local store. Go passed only the latter to the generic legacy reader. With
the unchanged production local-read fallback disabled, this requests a missing
S3 key. Canonical avatars use a shared layout and were unaffected.

The prior unit reader accepted the same key the Go service supplied, so it
could not expose the Node/S3 layout mismatch. The fix requires an independently
checked Node key fixture plus real Go S3 adapter coverage.

The hotfix preserves existing canonical metadata behavior and the generic
hybrid reader's missing-only policy. A hybrid configuration where the prefixed
S3 object is missing and the raw S3 key is forbidden still fails closed before
reading the raw local copy. Provider-aware local-only fallback and additional
canonical metadata hardening are separate work, not promised by this release.
Production has local-read fallback disabled and all five prefixed objects exist.

## Validation and release boundary

Use synthetic local/S3/hybrid regression tests, negative-path and authorization
tests, the Node key oracle and the repository's Go/Node/Chromium CI gates.
Record exact commands, red/green reproduction and final reviewed head in the
PR. Passing tests do not establish production deployment or browser acceptance.

Release 0.16.1 is a compatible patch. No database or storage migration is needed.
After verified normal merge, use the official Go-to-Go upgrade with the prior
successful private snapshot and all sidecars. Do not repeat first-cutover
permission preparation, enable Node, replace containers with bare Compose, or
change S3/local fallback settings to conceal the defect. Recovery preserves
the previous exact Go images and current database/object authority; it cannot
be described as fixing the old version's avatar defect.

After deployment verify immutable runtime identity, service health, public
gateway boundaries and fresh avatar responses from a normally authenticated
browser. Recheck the real failed-avatar request class. Never create a production
session through SQL to replace the user's login. Full Workspace business,
provider delivery and whole-store byte acceptance remain separate gates.

## Parallel work

The implementation luna-worker owns only the avatar service and focused Go
tests. A second luna-worker independently reviews storage/auth failure paths
and adjacent legacy-reader behavior without modifying it. The lead owns the
Node key oracle/fixture, CI integration, release notes, documentation, independent
verification, serialized split commits, PR and authorized rollout.
