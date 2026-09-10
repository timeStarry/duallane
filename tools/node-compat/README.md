# Node compatibility storage operators

This directory is a deliberately isolated, offline operator fence for the
retained Node storage compatibility tools. It is not the online API, a worker,
or a startup hook, and it is not the Go mutating CLI. Nothing here changes the
active production owner or authorizes a Node/Go dual-writer deployment.

The three commands are explicit one-shot operations:

- `storage:migrate` backfills/verifies the feature-scoped S3 objects and
  run-specific archive objects.
- `storage:dedupe` runs `backfill`, `verify`, or the separately destructive
  `finalize` phase for canonical content-addressed objects.
- `storage:provision` provisions and verifies the private S3 bucket controls.

Importing any module in this package performs no database, object-store, or
filesystem mutation. There are no package lifecycle hooks, listeners, worker
loops, or background timers. Running one of the three entrypoint files is still
an operator-authorized action: `storage:dedupe` backfill/finalize and
`storage:provision` can mutate their explicitly configured authority.

Before an authorized run, follow `docs/backend/STORAGE_OPERATOR.md`: identify
the exact database/object authority and target, obtain the required approval,
back up and verify it, and fence Node/Go API writers, workers, upload
finalizers, and other storage maintenance. Keep the run ID stable when a phase
is resumed. Never point tests or a rehearsal at production data.

The database adapter in this package intentionally does not run migrations or
seed data. Canonical SQL remains at
`apps/web/server/migrations`; it is not copied into this package and is not
automatically executed by these operators. Shared application assets remain at
`apps/web/shared`.

Run from this directory only after dependencies have been supplied by the
operator's isolated environment:

```sh
pnpm storage:migrate
pnpm storage:dedupe
pnpm storage:provision
```

The environment variables and mode defaults remain compatible with the
retained Node commands. The reports are written below the configured data root
with the existing private `0700` directory / `0600` file contract. Do not put
credentials, database URLs, or production report contents in source control,
process arguments, or logs.

The repository root owns workspace dependency installation and the lockfile.
After this package is connected to the workspace, install from the repository
root with `pnpm install --frozen-lockfile`; do not run a separate package
install or rewrite the lockfile globally. The runtime image executes the
direct Node entrypoints and does not require pnpm at runtime.
