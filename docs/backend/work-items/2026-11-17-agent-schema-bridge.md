# Agent schema36 bridge (App1.1.3 / SDK1.1.2)

Status: prepared, validation and production deployment pending. The maintainer
requested shipping the Agent platform foundation with the previously unreleased
artifact fix. PR26 is merged; Agent activation is tracked in PR27.

The production1.1.1 schema36 image does not authorize037. This independent bridge
keeps canonical migrations001–036, declares only the reviewed037 digest and
includes strict read-only columns/constraints/index inspection. Future SQL remains
under migration testdata and is never discovered by the production runner. No new
Agent business handlers or policy controls are enabled in this bridge.

The bridge also removes read/startup policy normalization and diagnostic grant
creation. Looking at a Bot must not recreate disabled trigger/context access,
including when recovering from a later V2 activation. A real PG regression checks
a revoked grant stays revoked after console diagnostics.

Reviewed037 SHA256:
`5003a7f2c6dcc32f336a3b20f4730fa8c6e5208d6551ae7ffe460c45eca21b03`.
Historical1/2/3-entry policy authority remains unchanged. A schema35 image cannot
claim037; a historical schema36 policy without the declaration still rejects it.

Required gates: Go verify and disposable PG/race; Node schema guards; Web tests,
lint/build and browser regression; PR CI; exact immutable-image36→37 activation
and bridge recovery on the same disposable database. Results pending below.

Deploy this bridge only from `/home/timestarry/duallane` after the maintainer
account merges its green PR. Use exact `origin/main`, expected commit and latest
verified private Go snapshot with the guarded Go-to-Go entry point. Capture and
verify a new schema36 recovery snapshot. Only then may PR27 migrate037, using
that bridge snapshot. Do not alter production migration history or bypass guards.
Recover the later activation with the exact reviewed bridge images on schema37;
the pre-bridge1.1.1 image is not an authorized037 rollback. Database restore is a
separate incident action and must account for intervening writes.
