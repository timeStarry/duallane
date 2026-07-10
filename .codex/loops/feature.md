# DualLane Feature Loop

Use this loop for ordinary product work: UI polish, small API additions, emote behavior, layout fixes, copy changes, and low-risk local refactors.

## Entry Criteria
- The task does not alter P2P privacy, secure envelope parsing, workspace authorization, quota accounting, audit logging, database schema, Docker, or Nginx.
- The expected change can be scoped to a small set of files.

## Procedure
1. Read `README.md`, `DESIGN.md`, and the smallest relevant implementation path.
2. Identify the current behavior, the requested behavior, and the files likely to change.
3. Make the smallest implementation that matches existing patterns.
4. Add or update focused tests when behavior changes.
5. Run validation:
   - Frontend-only: `pnpm lint` and `pnpm build`.
   - Backend/service logic: `pnpm test` and `pnpm lint`.
6. Summarize changed files, validation results, and remaining risks.

## Guardrails
- Do not weaken lane separation language.
- Do not introduce public registration, multi-party P2P, or workspace enablement unless explicitly requested.
- Do not touch emote asset files unless the feature requires it.
- Do not broaden the scope into unrelated cleanup.

## Done
- The requested behavior works.
- Required validation commands pass or failures are explained.
- Any residual risk is specific and actionable.
