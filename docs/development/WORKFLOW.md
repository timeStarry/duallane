# Development Workflow

## 1. Work Intake

Every change begins with a reviewable problem statement. An issue or PR must
identify:

- the user or operator affected;
- current and expected observable behavior;
- acceptance criteria and explicit non-goals;
- the trust lane and affected data;
- compatibility, migration, deployment, and rollback concerns;
- evidence for a bug, such as steps, logs without secrets, a failing test, or a
  screenshot with private data removed.

If the request is ambiguous, inspect the current product contract and code first.
Ask for a decision only when reasonable interpretations materially change data,
security, user behavior, or rollout.

## 2. Branch Policy

Never implement directly on `main`.

1. Fetch and branch from the current `origin/main`.
2. Use one short-lived branch for one coherent change.
3. Rebase or merge the latest `origin/main` before final validation according to
   maintainer preference; never rewrite another contributor's work.
4. Delete merged branches after the change is verified.

Branch names use lowercase kebab case:

| Prefix | Purpose | Example |
| --- | --- | --- |
| `feat/` | User-visible capability | `feat/topic-notifications` |
| `fix/` | Defect correction | `fix/mobile-image-layout` |
| `docs/` | Documentation only | `docs/contributor-handbook` |
| `refactor/` | Behavior-preserving restructuring | `refactor/message-composer` |
| `test/` | Test-only coverage or infrastructure | `test/gateway-reconnect` |
| `chore/` | Tooling or maintenance | `chore/refresh-lockfile` |
| `release/` | Release preparation | `release/v0.15.6` |
| `codex/` | Branch created by Codex | `codex/bot-settings-layout` |

Do not force-push `main` or a shared branch. Do not bundle unrelated fixes to
avoid opening another PR.

## 3. Bug-Fix Workflow

A bug fix is not complete when the symptom disappears once.

1. Reproduce the failure using the smallest realistic path and record the
   environment, input, and expected result.
2. Narrow the failure to its owning layer. Check equivalent surfaces such as
   direct/group/topic chat, desktop/mobile, local/S3 storage, and initial/realtime
   data only when they share the affected contract.
3. Add a focused regression test that fails for the original reason. For a visual
   defect, capture a deterministic Playwright case or document why automation is
   impractical.
4. Fix the root cause without relaxing validation, authorization, audit, or
   compatibility guarantees.
5. Verify error, retry, cancellation, duplicate, stale, and concurrent paths that
   are relevant to the root cause.
6. State the root cause and regression evidence in the PR.

Emergency fixes still use a branch and PR. Urgency can shorten discussion, not
remove regression evidence or the authorized merge step.

## 4. Commits

- Use an imperative summary that explains the outcome, for example
  `Fix topic composer mention serialization`.
- Keep each commit internally coherent and buildable when practical.
- Separate generated or dependency-lock changes from unrelated source edits.
- Do not commit `.env`, tokens, private URLs, production data, test artifacts,
  screenshots with personal information, or temporary debug output.
- Do not use commits to hide formatting churn, copied assets, or broad refactors.

History may be cleaned before review, but never rewrite commits other people are
actively using without agreement.

## 5. Pull Requests

Every change to `main` requires a pull request. Use
`.github/pull_request_template.md` and include:

- purpose, scope, and non-goals;
- behavior and contract changes;
- security, privacy, data, quota, audit, and compatibility analysis;
- exact commands run and their results;
- screenshots or recordings for visible UI changes at desktop and mobile sizes;
- migration, rollout, health-check, and rollback steps where applicable;
- remaining risks and deliberate follow-up work.

Draft PRs are appropriate for early design or risky migrations. Mark a PR ready
only when its description is current, required checks pass, and no known blocker
is hidden in follow-up prose.

Only GitHub user **`timestarry`** may perform the final merge into `main`.
Contributors, reviewers, automation, and coding agents must not merge, enable
auto-merge, bypass branch protection, or use an alternate push path to place a
commit on `main`. Repository branch protection should enforce this policy; this
document remains binding if hosting settings are temporarily weaker.

The maintainer decides merge strategy. A release or production deployment is a
separate authorized action after merge.

Recommended GitHub rules for `main` are:

- require a pull request and Code Owner review;
- dismiss stale approval after new commits and require resolved conversations;
- require the repository's test, lint, and build checks once CI publishes them;
- block force pushes and branch deletion;
- restrict direct pushes and merge-capable roles to `timestarry` without a general
  administrator bypass.

`.github/CODEOWNERS` assigns the repository to `@timestarry`. CODEOWNERS alone
does not enforce merge authority; repository rulesets and collaborator roles must
also match this policy.

## 6. Review Standard

Review correctness before style:

1. trust-lane, authorization, privacy, quota, audit, and data-loss risks;
2. incorrect behavior, races, retries, idempotency, and compatibility regressions;
3. missing tests and weak failure-path evidence;
4. accessibility, responsive behavior, and consistency with shared UI patterns;
5. maintainability, naming, duplication, and documentation drift.

Feedback should cite the concrete file, behavior, and failure mode. Resolve
discussion in code or record a clear decision; do not silently dismiss a known
risk.

## 7. Ownership And Handoff

- Before parallel work, assign file or module ownership and avoid overlapping
  edits. Shared worktrees require contributors to preserve changes they did not
  create.
- A handoff states changed files, contract decisions, validation completed,
  validation not run, active processes, and remaining blockers.
- Do not leave development servers, watchers, or temporary credentials running
  without saying so.
- Generated artifacts, local databases, uploaded fixtures, and screenshots remain
  untracked unless the repository intentionally owns them.

## 8. Documentation Changes

Update documentation in the same PR when a change affects setup, configuration,
public behavior, API/event shape, schema, permissions, visual patterns, release
operations, or user-facing location guidance. Do not use future-tense design
language for behavior that is already shipped.
