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

At document creation these 0.17.0 gates, PR and deployment are pending. The
completed 0.16.2 record is prerequisite evidence, not a substitute for them.
