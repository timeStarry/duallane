# Isolated Go candidate stack

This Compose file is a validation candidate only. It has its own Compose
project name, PostgreSQL volume, Workspace data volume, network, images, and
loopback-only Web port. Compose derives the volume names from the candidate
project; no volume-name override is accepted. It must never be pointed at production volumes,
production secrets, or the production Compose project.

The candidate starts one-shot `migrate` from the same Workspace image used by
`workspace` and `worker`. `CANDIDATE_WORKSPACE_ENABLED` defaults to the exact
`true` value; any other value is rejected by the static guard before a stack
can be considered valid. Notification, email, and maintenance worker
processors are disabled by default. Maintenance and Echo recovery use explicit
candidate-only `CANDIDATE_MAINTENANCE_WORKER_ENABLED=true` and
`CANDIDATE_ECHO_WORKER_ENABLED=true` opt-ins. Neither enables email/ntfy sending.
P2P has no PostgreSQL, storage, OAuth, SMTP, Workspace, or runtime volume
configuration and is not dependent on the database.

The gateway keeps the existing `11m` `/api/` transport cap, including
`/api/p2p/`. P2P's application-level JSON parser still enforces its separate
1 MiB bound and returns its JSON 413 contract; Nginx must not preempt it with
an HTML 413 page.

Run the static guard and Compose config check from the repository root:

```text
node scripts/backend/candidate-compose.test.mjs
docker compose --project-name duallane-candidate --env-file deploy/candidate/.env.example -f deploy/candidate/compose.yaml config --quiet
```

Choose an unused `CANDIDATE_WEB_PORT` before a future rehearsal. Web is always
published on `127.0.0.1`; there is no bind-address override. The example
PostgreSQL password is synthetic and must be replaced for any disposable
environment. The commands above intentionally do not start containers or pull
images. A future rehearsal must build the candidate images first and use only
the candidate project name.

After the isolated stack is healthy, run the bounded gateway smoke check
against its chosen loopback port (this example uses the default port):

```text
node scripts/backend/candidate-gateway-smoke.mjs http://127.0.0.1:8788 --synthetic-candidate
```

It verifies HTTP health, frontend delivery, unauthenticated Workspace denial,
the WebSocket hello authentication error and policy close, and public denial
of `/readyz`, `/healthz`, and `/metrics`. It also creates one transient P2P room
without sending chat/file content. Use it only against this synthetic candidate,
never production. Passing this smoke check is not authenticated browser parity,
worker delivery verification, a rollback rehearsal, or permission to deploy.

The Go runtime images include the read-only
`/usr/local/bin/duallane-healthcheck` helper. It accepts one literal-loopback
HTTP URL, allows only the fixed health paths, performs a bounded GET, requires
HTTP 200 and the path-specific JSON contract, and emits no response body or
secret. It does not depend on `wget` or a health subcommand in a serving binary.

Use Docker BuildKit so the per-Dockerfile build-context allowlists apply.
`CANDIDATE_GOPROXY` optionally selects a public Go module proxy for image builds
when the default proxy is unreachable; checksums remain enabled. Never put
credentials in this build argument. It is not runtime configuration.

`CANDIDATE_DEBIAN_MIRROR` selects the Go images' signed Debian package
source when the default `http://deb.debian.org` cannot be reached. The only
alternatives accepted by the Dockerfile are `https://deb.debian.org` and
`https://mirrors.ustc.edu.cn`. HTTPS is bootstrapped with the CA bundle from
the Go build image; TLS verification and Debian APT signatures stay enabled.
This argument is public, build-only configuration, never a secret-bearing URL.

Default Go/Web base images are pinned by registry digest; key runtime Debian
packages are version-pinned. APT transitive dependencies still depend on the
signed repository state, so these pins do not imply byte-for-byte reproducible
images. Record the built image IDs, complete source commit, package inventory,
and build arguments in rehearsal evidence. Candidate image tags are convenient
local names, not immutable identities.

The public `/api/health` projection remains a liveness contract and may be
healthy while Workspace is disabled. The current Go `/readyz` projection can
return HTTP 200 with `"state":"disabled"`; candidate orchestration therefore
checks both the status and the state, and requires the private response to
contain `"ok":true,"state":"ready"`. The guard also rejects a non-exact
Workspace gate. No health probe may run migrations, seed data, write files, or
expose dependency details.
