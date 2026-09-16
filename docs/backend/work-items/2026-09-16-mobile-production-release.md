# Android service activation and internal package distribution

## Authorization and scope

On 2026-09-16 the maintainer authorized reviewing, fixing and merging main PR16
and mobile PR1, then requested production server deployment and APK distribution.
Mobile PR2 fixes the configured-service login and status bar. The maintainer
explicitly authorized SSH for this deployment because the task runs on Windows.
This is a task-scoped transport exception: production still runs only from
`/home/timestarry/duallane`, using that server's local Docker daemon and the
guarded coordinator. It does not change the permanent host rules.

Workspace owns the new mobile authentication records. The P2P privacy contract,
existing database and object-store authority, quotas, audit, retention and
single-writer rules remain unchanged. No production data enters rehearsals.

## Verified starting point

- The active production release is 0.19.2, commit
  `182a6bf95b5ec8eba2974852590dd3541ec6ca50`, with schema 34.
- The previous successful private snapshot is
  `backups/production/duallane-20260912T101017Z-182a6bf95b5e.recovery.go-compose.snapshot.json`.
  Its matching Compose, external-file and volume sidecars are present as
  root-owned regular mode-0600 files. The snapshot reader verified its metadata.
- Main PR16 adds `035_mobile_sessions.sql`. Its reviewed SHA-256 is
  `479d042a0a5f4d07886d3557901b5d8152b8714fe9dfeeceddfba94121e58061`.
  The previous immutable image has no authorization for this expansion.

## Two-release sequence

1. Publish 0.19.3 as a schema-34 bridge through a normal PR. Keep the reviewed
   upload-recovery and web OAuth fixes. Temporarily move 035 outside the canonical
   migration directory and defer the MobileService and public release-policy
   handler wiring. Existing mobile handlers return a content-free 503 before
   reading or mutating a mobile table. Mobile implementation tests explicitly
   apply the deferred SQL only to disposable test schemas.
2. Embed the exact reviewed 035 compatibility declaration. Preserve the historical
   033-to-034 policy and reject undeclared or altered expansions. Read-only
   Workspace/worker checks must support the bridge on both schema 34 and the
   reviewed schema 35 without permitting missing required migrations.
3. Run applicable code, PostgreSQL, image and coordinator gates. Deploy the bridge
   with the existing verified snapshot and record a new successful snapshot.
4. Restore exactly the reviewed 035 SQL to the canonical directory and mobile
   handler wiring as 0.20.0 in a separate PR. Preserve all bridge compatibility
   code. Prove a real 34-to-35 Go upgrade and exact bridge-image rollback on the
   same disposable database before production expansion.
5. Deploy 0.20.0 with the bridge's new successful snapshot. Verify exact image
   identities, private active readiness, public health/auth boundaries, mobile
   release policy and download URL, and redacted startup/migration failures.

Both releases use `--release-profile go-full --go-upgrade` with an exact
`--expected-commit` and the immediately preceding successful private snapshot.
No migration guard, snapshot, history row, permission boundary or rollback
authority may be edited to make an otherwise unsupported upgrade pass.

## Package distribution

The tested mobile tree is `c3decaf4f16a6dff4182114c1ddf3b73f89a2557`, merged at
`b53bc219d7ed2c473561ead301886c2498855fbf`. The
[internal prerelease](https://github.com/timeStarry/duallane-mobile/releases/tag/internal-0.1.0-20260916)
contains the previously tested APK, AAB and SHA256SUMS. Remote sizes and digests
match the local files. The APK SHA-256 is
`ae50ee357ea73205080a0fa44304442398911969537b4d4ee307bfe588706dda`.
Its actual embedded service origin is `https://duallane.tsio.top`.

This is an internal test-signed package, not a stable signing identity. It does
not claim real-account OAuth, physical-device background notifications or OTA
acceptance. Different CI signing identities require uninstall/reinstall; the
release notes explain the resulting loss of local app state.

## Validation and activation record

- The 0.19.3 bridge was merged through
  [PR17](https://github.com/timeStarry/duallane/pull/17) at
  `dbd41969f9952523b1ca570773c7857c2f9b4341`.
  All four required jobs in
  [CI run 35115555945](https://github.com/timeStarry/duallane/actions/runs/35115555945)
  passed. The real immutable-image coordinator rehearsal also passed, including
  the complete upgrade and exact-image recovery cycle on disposable data.
- The separate 0.20.0 change restores the reviewed 035 SQL to the canonical
  migration directory byte for byte, retains the bridge fixture and compatibility
  checks, and reconnects the mobile authentication and public release-policy
  handlers. Mobile PostgreSQL tests now use the canonical migration runner.
- Bridge production activation is in progress. The 0.20.0 release still requires
  its own validation, the real schema-34-to-35 upgrade and exact bridge-image
  rollback rehearsal, a successful bridge production snapshot, and final public
  mobile API verification. No service activation is claimed by this record.

Append exact deployment and validation evidence only after each operation
completes successfully. Package distribution alone is not service activation.
