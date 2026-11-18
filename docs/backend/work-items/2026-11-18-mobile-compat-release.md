# Mobile compatibility and card-consumer release

## Contract

App 1.2.2 accompanies Android 1.1.0. SDK admission remains 1.2.1; human mobile
sessions do not become Bot SDK clients. Workspace remains server-authorized and
Go-owned; no P2P persistence, quota bypass or database schema change is intended.

The mobile release distinguishes APK version, OTA version, lowest supported
native code and the OTA compatibility floor. The new supported floor defaults
to zero and is enabled explicitly only after signed packages and compatibility
OTA are verified. Older clients receive actionable upgrade guidance while
update downloads and recovery remain reachable. A known floor survives an
offline check; an explicit server rollback can clear it.

Old native sockets cannot gain new Kotlin headers through JS alone. During
migration, declared old clients are rejected at the business boundary, while
undeclared legacy background sockets retain compatibility below the first native
declaration baseline (10100). A minimum at or above 10100 requires a native
declaration for authenticated human Bearer business HTTP/WS; Cookie Web sessions
and public recovery are excluded. This makes the strict all-native migration an
explicit rollout choice, not an accidental rejection of otherwise compatible
old shells. Public declarations
are compatibility metadata, never an authentication substitute. Do not claim
full device attestation or native improvements delivered through OTA.

Both current client renderers must resolve canonical card references through
the authorized card endpoint and project only registered card types. Fixed
Feishu actions use empty input, expected revision and actor-scoped idempotency.
Revision summaries invalidate payloads; unknown/unsupported or inaccessible
cards degrade safely. No operation is replayed automatically after response loss.

## Validation and rollout

- Relevant unit/component tests, type/lint/build, Go quality and PostgreSQL gates.
- Actual SDK → Go card converter → production client body/buttons/action receipt
  and revision/authorization-loss acceptance; synthetic data only.
- Mobile old-native/new-OTA APK discovery, required-upgrade gate, safe recovery,
  nonempty drafts and in-flight write protection; Android package smoke gates.
- PR review and CI before merge; guarded main-checkout deployment using the
  latest successful 1.2.1/schema37 recovery baseline. No bare Compose activation.
- Public package/OTA metadata is activated only after immutable artifact checks.
  Raising the supported floor is a separate final rollout step; rollback keeps
  the download route and explicitly lowers/disables the floor.

Final evidence belongs in the PR. Existing user files and real Comet operations
are preserved, and no prior failed card operation is a test replay input.
