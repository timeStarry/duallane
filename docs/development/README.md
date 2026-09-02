# DualLane Development Guide

This directory is the progressive-disclosure handbook for contributors and
coding agents. `AGENTS.md` is the mandatory root. Start here after reading it,
then open only the standards required by the change.

## Choose The Relevant Guide

| Guide | Use it for |
| --- | --- |
| [Workflow](WORKFLOW.md) | Issues, branches, bug fixes, commits, pull requests, review, ownership, and handoff |
| [Architecture](ARCHITECTURE.md) | Technology choices, repository layout, dependency direction, service boundaries, migrations, and decisions |
| [Code standards](CODE_STANDARDS.md) | TypeScript, React, Fastify, SQL, storage, API/event contracts, CSS, dependencies, and test code |
| [UI/UX standards](UI_UX_STANDARDS.md) | Information architecture, layout, components, states, mobile behavior, accessibility, and visual review |
| [Security and data](SECURITY_AND_DATA.md) | Trust lanes, identity, authorization, audit, secrets, quotas, retention, uploads, and content-addressed storage |
| [Testing and release](TESTING_AND_RELEASE.md) | Validation matrix, Playwright, PostgreSQL, versions, release notes, deployment, health checks, and rollback |

## Product And Protocol Sources

Development standards explain how to make a change. Product and protocol
documents define what the product should do:

- [`DESIGN.md`](../../DESIGN.md) defines the split-lane product and system model.
- [Workspace design index](../WORKSPACE_DESIGN_INDEX.md) routes to Workspace
  product, protocol, data, visual, accessibility, and acceptance documents.
- [P2P product design](../O2O_PRODUCT_DESIGN.md) defines the private direct lane.
- [`README.md`](../../README.md) provides setup, runtime, and operator context.

When implementation, tests, and documents disagree, do not silently choose one.
Preserve `AGENTS.md` invariants, identify the mismatch in the issue or PR, and
update the authoritative contract with the code when the intended behavior is
confirmed.

## Progressive Disclosure Rules

- Keep root `AGENTS.md` short enough to read for every task. Put durable details
  in the owning document and link to them.
- Put cross-project engineering policy here. Put user behavior and protocol
  contracts in the existing domain design documents.
- Put operational procedures beside their scripts or in a dedicated runbook, and
  link them from [Testing and release](TESTING_AND_RELEASE.md).
- A rule should have one canonical definition. Other documents link to it rather
  than copying paragraphs that can drift.
- Examples must reflect executable commands, real paths, and current APIs. Remove
  obsolete guidance in the same PR that changes the behavior.

## New Contributor Path

1. Complete [README: Start developing](../../README.md#start-developing).
2. Read [Architecture](ARCHITECTURE.md) and the design document for the lane you
   will modify.
3. Read [Workflow](WORKFLOW.md), create a short-lived branch, and write acceptance
   criteria before implementation.
4. Load the code, UI/UX, and security standards that match the task.
5. Use [Testing and release](TESTING_AND_RELEASE.md) to choose the required gate
   before opening a pull request.

