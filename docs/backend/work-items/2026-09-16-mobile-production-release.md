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

- The production release at the start of this task was 0.19.2, commit
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
- Production 0.19.3 completed successfully on 2026-09-17 (local date), at the
  exact PR17 merge commit above. All four application containers were healthy;
  the guarded gateway smoke passed all 13 checks. The new verified snapshot is
  `backups/production/duallane-20260916T160548Z-dbd41969f995.recovery.go-compose.snapshot.json`.
  The snapshot and three sidecars are root-owned regular mode-0600 files. Its
  reader verified schema 34, version 0.19.3 and the exact commit.
- [PR18](https://github.com/timeStarry/duallane/pull/18) merged the 0.20.0
  activation at `ce7f1619c61dc515e50c6bc16a6d63cae0369536`. The merge tree is
  identical to tested head `7bae680ecd635f8f1f3a8e983b76b2d663049782`.
  All four jobs in
  [CI run 35118197248](https://github.com/timeStarry/duallane/actions/runs/35118197248)
  passed. Local pnpm tests/lint/build, 34 focused Node checks, and Go 1.26.8 /
  PostgreSQL 17.11 full-package race/integration tests plus vet also passed.
- The final real-image rehearsal used the actual production 0.19.3 images,
  verified by their original config digests after transfer. It passed with
  `DUALLANE_RELEASE_COORDINATOR_EXPECT_SCHEMA_034_TO_035=true`: schema 34 to 35,
  successful 0.20.0 activation and gateway smoke, then exact production bridge
  image recovery on the same disposable database. An independent read-only
  probe confirmed that the recovered database still had all 35 migrations,
  including 035. Final historical fixture recovery and owned-resource cleanup
  passed; all 13 pre-existing test-host containers retained their identities and
  running states. The complete test returned exit 0, 1/1 passed, no skips, in
  632.775 seconds.

## Build transport during this activation

The server could not reach the default Go module proxy, so the guarded builds
used the existing `DUALLANE_GO_BUILD_PROXY=https://goproxy.cn,direct` and
`DUALLANE_DEBIAN_BUILD_MIRROR=https://mirrors.ustc.edu.cn` inputs. Go checksum
verification, pinned base images and package versions were retained.

The pinned pnpm 10.30.3 downloader could wait indefinitely for a response body
after receiving headers. A temporary CONNECT transport, restricted to
`registry.npmjs.org:443`, closed connections after 30 seconds of inactivity or
180 seconds total so the original downloader could retry. TLS remained end to
end. Only `docker compose build` received the predefined proxy build arguments;
the Dockerfiles, lockfile, application runtime environment, daemon and production
network configuration were unchanged. A running Workspace container was checked
to confirm the build proxy was absent. The guarded coordinator retained the
same candidate, schema, authority, fence, drain, smoke and snapshot checks.

The temporary download helpers were stopped after validation and deployment;
all four production application containers were checked to have no build proxy
configuration and no restarts.

## Final production activation

The guarded 0.20.0 deployment completed with exit 0 on 2026-09-17 (local date),
using the exact merge commit `ce7f1619c61dc515e50c6bc16a6d63cae0369536` and
the successful 0.19.3 snapshot above. The new successful snapshot is
`backups/production/duallane-20260916T162556Z-ce7f1619c61d.recovery.go-compose.snapshot.json`.
It and all three sidecars are root-owned regular mode-0600 files; the snapshot
reader verified schema 35, version 0.20.0 and the exact commit. The authoritative
PostgreSQL and object-store identities were retained.

All four application containers were healthy with the expected version/revision.
The production image IDs are:

| Service | Image ID |
| --- | --- |
| P2P | `sha256:959ad79e17da91e2295100f7123891997cf867043c7753b88ed388d36f39e53e` |
| Workspace, worker, migrate | `sha256:07439bbc5b13f83e3ebff75e3f1003025b506443eb3de39226b345ddd8261163` |
| Web | `sha256:60f126e586b832d2642f307ad0344acf789ecc17450eb2e2e59e98e48bc4002a` |

The guarded gateway smoke passed all 13 checks. Additional HTTPS checks used
the production domain/SNI and verified certificate through the existing tailnet
gateway. They confirmed the 0.20.0 health response, anonymous Workspace denial,
mobile release policy, protocol compatibility and the exact published APK URL.
Latest/minimum remain 0.1.0 / code 1 with recommendation `none`.

A fresh PKCE start request successfully reached the mobile flow repository,
returned the correct HTTPS authorization origin with `no-store`, and redirected
to GitHub with the configured HTTPS callback. The mobile-flow cookie retained
Secure and HttpOnly. The probe did not follow the GitHub account login or mint
a user session; its pending flow expires within ten minutes. No flow value,
OAuth state, cookie, credential or production user data was retained in the
verification report. Real-account login, physical-device background notifications
and OTA remain outside this verification.

The public APK/AAB asset sizes and SHA-256 values were rechecked against the
tested files. This documentation-only evidence update does not require another
runtime deployment or change the deployed commit above.
