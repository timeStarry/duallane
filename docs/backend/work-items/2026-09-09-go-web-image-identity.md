# Explicit Go Web release image — 2026-09-09

## Reproduction and root cause

After all four CI jobs passed for PR #3, the maintainer explicitly authorized
the lead to merge verified PRs related to this deployment and continue the
rollout. PR #3 merged normally as `8c1fda18797ab76b29556f13ae4583a156a8712b`;
the merge tree is identical to its verified head. Production pulled that exact
`origin/main` in the authorized production checkout.

The guarded first Go cutover built all images successfully on Docker Compose
5.1.0, then refused with `could not resolve the built Go web image identity`.
The existing Node API/Web remained running and healthy: this refusal preceded
the Go migration, Node fence and data-volume permission conversion. The earlier
credential preparation had completed with a verified private backup and
unchanged bytes/inode/0600; it was not automatically undone.

The Go override specified `web.build` but no `web.image`. Compose built an
implicit project/service tag (`duallane-web` on this host), while its resolved
JSON omitted `services.web.image`. The release helper deliberately requires an
explicit image reference to inspect and pin before activation. The built image
had the correct release labels; the missing resolved reference caused the
failure. Existing synthetic/disposable fixtures supplied image overrides and
therefore did not expose this real-file configuration gap.

## Change and invariants

The Go-only composition now explicitly sets:

```yaml
image: duallane-go-web:${DUALLANE_GIT_COMMIT:?full release commit is required}
```

This names the artifact that the existing identity gate must resolve; it does
not relax the gate or invent a fallback from a running container. The existing
full-commit/version checks and immutable image pinning remain mandatory.

No Dockerfile, application source, dependency, schema, port, gateway route,
permission, worker or data authority changes. The default Node composition is
unchanged. P2P content remains unpersisted, Workspace authorization and quota
behavior remain unchanged, and retained Node recovery uses its captured immutable
images. Node removal is explicitly deferred to a later version.

## Validation contract

The focused regression must parse the actual base, production and Go production
Compose files with synthetic inputs, without starting containers or using
production configuration. It must verify explicit release image references and
build metadata for the Go profile, default Node isolation, and rejection of the
original missing-image case. CI must execute this check, not silently count an
environmental skip as acceptance. The lead reviews the worker-owned test and
workflow changes; exact test and CI results are recorded in the associated PR.

Lead validation: both actual Compose tests passed on WSL/Linux using Node
22.23.2, with zero skips (4.99 seconds). This includes the reconstructed
pre-fix negative case, without altering the shared checkout. The lead also
isolated the subprocess environment to host/Docker essentials plus synthetic
values and supplied an explicit empty dotenv file so a caller's application
secrets or Compose dotenv selection cannot enter the fixture. All 13 existing
CI/native-asset/Go-worker guard tests passed. `git diff --check` passed.
Full application, PostgreSQL and browser gates remain the new PR's CI gate;
the earlier PR #3 result is not substituted for that check.

The previously built Web image is evidence of the successful Dockerfile build,
not proof for the new merged release identity. Build the new exact-main release
through the official entry point after validation and merge.

## Host preparation and retries

The root-key transport is the maintainer's task-specific exception to the usual
same-host transport rule. It does not change the production path, local daemon,
clean exact-main, lock, writer fencing or recovery requirements.

The existing deployment lock was an empty regular 0600 file owned by the old
ordinary-account coordinator. Root's create-mode open was denied. The lead
verified its identity, acquired its existing inode's exclusive nonblocking flock
through a read descriptor, changed that same inode's ownership to root, and
rechecked its identity/mode. No lock was removed or replaced and no alternate
lock was used. Future releases use the privileged coordinator required to read
the prepared credential.

A stalled base-image download was safely canceled at the exact build client;
the official error handler stopped the builder and a retry completed those
layers. The default Go proxy then timed out. The successful build used the
existing command-scoped inputs below after reachability checks:

```text
DUALLANE_GO_BUILD_PROXY=https://goproxy.cn,direct
DUALLANE_DEBIAN_BUILD_MIRROR=https://mirrors.ustc.edu.cn
```

The Dockerfile already allowlists this Debian mirror. Dependency versions,
TLS verification, Go checksums and APT signature verification remained enabled.
No production `.env`, daemon configuration, public bind, global Git trust or SSH
security setting was changed. No additional historical images were deleted.

Until an actual guarded activation succeeds, the ownership ledger remains
`parity` with Node as the production owner. A successful image build or this
configuration fix alone is not deployment or business/provider acceptance.
