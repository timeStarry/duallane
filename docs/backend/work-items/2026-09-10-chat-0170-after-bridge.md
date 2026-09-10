# Chat 0.17.0 after the compatibility bridge

## Scope and prerequisites

The maintainer accepted 0.16.1 and authorized later releases and separate Node
retirement. PR #8's unshipped chat features are restored on a branch from
the deployed [0.16.2 bridge](2026-09-10-schema-034-bridge.md), merge
`c15d5569ccc5f8a169b3ef2e8e6952c76e84b1fd`. Reversing the temporary feature
deferral preserves the original implementation history; the published 0.16.2
release entry and immutable compatibility policy remain intact.

Observable changes:

- Personal Chat settings add a default-off automatic-hiding switch with image,
  emote and long-message choices, shown only while enabled. Empty selection is
  valid; switching off preserves choices. Hidden display can be revealed locally.
- Enter used to confirm IME composition does not invoke shared send handlers;
  ordinary Enter and modifier-key behavior remain covered by regressions.
- Topic reply and group-sync actions use accessible icon buttons and retain
  their pressed/disabled state and mobile target sizes.

The [chat preferences contract](../../WORKSPACE_CHAT_PREFERENCES.md) owns the
API, actor isolation, classification and persistence details. The feature only
changes personal Workspace display preferences, not other members' messages,
manual hide rows, retention, quotas, authorization or provider routing. P2P's
shared input guard changes no server content/storage promise. There is no new
service, dependency, database authority or background owner.

## Data and rollback

Canonical migration `034_workspace_chat_auto_hide.sql` adds two columns with
disabled-by-default behavior. Its SHA-256 must remain
`b5c6ed855f9ca76a06f14ac590a8dd96fdec9cd2ec88c75dc5814990669658cb`, matching
the deployed bridge's immutable policy. The 0.17 checker must require 034 as
canonical; the bridge exception must not make required migration history
optional. Missing, unknown and structurally corrupt state remains rejected.

The only selected production rollback target is the healthy 0.16.2 image set
and its verified private recovery snapshot. Do not use 0.16.1 on schema 034,
rewrite recovery metadata, drop the additive columns or restore stale data.
The guarded coordinator performs SQL compatibility verification before the
single migrator, passive candidates, old-owner fencing/drain, activation and
gateway-last replacement. Node runtime retirement is a separate release.

## Review and evidence gates

Bounded luna-workers own canonical-034 migration regressions, actual-image
cross-schema rehearsal metadata, and restored release data/actual Node goldens.
The lead reviews integration, runs the current-source gates and exact-image
rehearsal, records evidence, prepares split commits/PR, and performs the
authorized guarded production deployment after validation.

The rehearsal must derive the old snapshot schema from the actual immutable
old image, not the newer checkout. New migration execution and new snapshot
capture still use the current canonical directory. Both captured image/schema
pairs are checked; an operator-supplied schema number is not evidence.

Required current evidence: frontend/Node tests, lint/build, full Go quality and
PostgreSQL gates, actual Node characterization freshness, complete applicable
browser suites and desktop/mobile inspection, release/Compose contracts,
target image builds, expanded-schema old/new/old Go recovery on the same
disposable database, and online version/health/authority checks. Record failures
and unavailable checks distinctly from passes. Synthetic composition events do
not establish native macOS/browser/IME acceptance. Do not use production
messages, credentials or real-recipient test notifications as fixtures.

## Completed release evidence

[PR #10](https://github.com/timeStarry/duallane/pull/10) was normally merged by
`timeStarry` on 2026-09-10 after review and all four CI jobs passed. Merge
`8d346a04317d0d3396293caca14ca1c65c7b5163` has the exact tree of tested head
`6ebc0f6858d67cf2be516d19ecf062c3ae75b505`.

The lead's clean Linux checkout passed frozen install, actual Node golden
freshness, SDK8 and Web747 tests (2 explicit PostgreSQL-only skips), lint/build,
full Go verify/PostgreSQL gates, Node Chromium27, Go Workspace21 and Go P2P5.
Release contracts passed105 with7 explicitly unselected optional Docker tests;
actual Compose contracts passed4. Actual target images built, immutable33→34
SQL comparison passed, and real expanded-schema upgrade/old-Go rollback with
unchanged database/data authority and owned cleanup passed (199.36 seconds).
The old images were imported from production and raw config SHA-256 verified
against production identities; containerd manifest IDs are not config IDs.

Failures remain part of the evidence: the first local Go Workspace run passed17
and failed4 (two initial-login waits, topic reveal, About navigation/reload).
Those4 and then all21 passed in fresh isolated fixtures without changes to
source, assertions, retries or timeouts. The cause is unproven; the CI Go suite
passed initially. General CI initially hit the unchanged Docker spawn deadline;
the exact fixture passed locally and one normal same-head job rerun passed the
complete gate. Neither is described as a demonstrated code fix.

Desktop/mobile synthetic settings and reply/sync icon layouts were inspected.
An unchanged pre-existing desktop topic-header grid can clip the title/stretch
the status badge; it is not claimed fixed. Native macOS IME remains unverified.

The official production-directory Go upgrade completed at the merged revision.
Schema34 is present, all four application containers are healthy/non-root/
read-only-rootfs with zero restarts and restart-always. Node is stopped with
restart disabled. PostgreSQL identity, S3 primary/local mirror, data volume and
Web binding are unchanged. No Docker restart or unrelated-container cleanup.

Production image IDs:

- P2P: `sha256:3f06acd46b95d1ccfad1125a34034df853d01fd10307b1f01237c3ecf6d706e7`.
- Workspace/worker/migrate: `sha256:428c8b4df7fb3dc413977f0e48e4211e648f7362b6f855513c2c156168bf496e`.
- Web: `sha256:3d6898731c93b4ea3253ca5893f550a303815dee1d58a3f2098def4b3874ddb6`.

Official13-stage gateway smoke and independent TLS public version/assets/ICE,
security headers, anonymous401/WSS1008 denial and private-endpoint404 checks
passed. Active readiness, backup SHA-256, private snapshot/external/volume
manifests and old→new authority comparison passed. Exact0.16.2 rollback images
remain available. Short redacted log observation found no warn/error entries.
Logged-in production UI was not verified because browser control failed twice;
no user preferences or messages were modified.

The next upgrade must use the private successful snapshot under
`backups/production/duallane-20260910T080211Z-8d346a04317d.recovery.go-compose.snapshot.json`
and its verified sidecars. Do not publish private contents. Deployment log:
`backups/production/chat-0170-8d346a0-deploy-zUvdZH.log`. Node retirement is a
separate release and is not implied complete by this record.
