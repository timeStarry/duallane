# Comet requirement and release workflow

Comet is the chat entry point for the two DualLane repositories. A registered
Workspace group member can send `@Comet DL需求：…` or `@Comet DL反馈：…`.
Comet acknowledges the durable ticket in a reply to the original message. The
coordinator evaluates the request, prepares and checks changes in a disposable
checkout, and sends the owner a private candidate card. These are external
operator tools for the Agent SDK. They have no product startup hook and make
no changes to the Go Workspace service or its database.

## Boundaries

- Intake binds the exact authorized human message, its author and its group.
  A replay preserves the original ticket. An explicitly quoted same-conversation
  message can supply a short excerpt through the scoped task broker. Credentials,
  `#k=` links and attachment bytes stay out of the ticket. Raw working input is
  cleared from the record when work ends. Restrict access to the state directory,
  including SQLite WAL files and backups.
- Delayed group replies use the ticket's original message ID. The controller
  checks Comet's current permissions and the owner DM before delivery. The pilot
  uses the existing legacy bot policy, which supports authorized operator sends.
  A policy requiring a task for every write blocks the delayed or private sends
  until a scoped service delivery capability exists.
- The model supplies bounded structured evaluation and anchored edits. The Codex
  adapter disables shell, web search, plugins, apps and subagents. The development
  controller validates paths, owns Git operations and keeps Git metadata outside
  its checkouts. Independent verification runs against the immutable candidate.
  Point custom verification adapters at an isolated executor. Mere environment
  filtering does not secure candidate code executing on a credentialed host.
- The evaluator may accept, decline, request evidence or identify a duplicate.
  Set `budgetMinutes` and `maxDailyTickets` in private configuration. Private
  content and model transcripts are excluded from generated GitHub PR text.
  Acceptance and development run with time and output limits.
- A card is immutable for one candidate and one mode. Approval binds its ID,
  owner, DM, expiry, nonce, candidate digest and, for production, release
  baselines. The server supplies the card actor after its membership and revision
  checks. The coordinator changes state once in SQLite. A pilot confirmation
  cannot authorize production.

## Run the pilot

Use Node.js 22.13 or newer. Keep a stable checkout of the reviewed tool version.
Give the existing Comet bridge access to a private JSON configuration file. Use
the values returned by the trusted bot profile and `listConversations` for the
space, Bot identity and the allowed group. Pin the DM whose server DTO has
`type: "direct"`, `isOwnerDirect: true` and `allowSend: true`. Use the stable
Workspace ID of the maintainer for `ownerUserId`.

```json
{
  "mode": "pilot",
  "channel": {
    "origin": "https://duallane.example.com",
    "profile": "default",
    "spaceId": "spc_example",
    "botId": "bot_comet",
    "ownerUserId": "usr_owner",
    "ownerConversationId": "conv_owner_direct",
    "groupConversationId": "conv_authorized_group"
  },
  "stateDirectory": "/home/operator/private/comet-release/state",
  "workDirectory": "/home/operator/private/comet-release/work",
  "artifactDirectory": "/home/operator/private/comet-release/artifacts",
  "budgetMinutes": 90,
  "maxDailyTickets": 8,
  "approvalMinutes": 1440,
  "allowDraftPush": false,
  "commands": {
    "evaluate": {"file": "/usr/bin/node", "args": ["/opt/duallane/tools/release-agent/codex-stage.mjs", "/usr/local/bin/codex", "/home/operator/.codex"], "timeoutMs": 180000},
    "develop": {"file": "/usr/bin/node", "args": ["/opt/duallane/tools/release-agent/codex-stage.mjs", "/usr/local/bin/codex", "/home/operator/.codex"], "timeoutMs": 600000},
    "verify": {"file": "/opt/operator/bin/isolated-duallane-verifier", "args": [], "timeoutMs": 900000}
  }
}
```

Stage commands take one versioned JSON object on stdin and return one object on
stdout. `duallane.release-agent.evaluate` returns `decision`, `reason`,
`repositories`, `estimatedMinutes` and `acceptance`. The latter three apply to
acceptance. `duallane.release-agent.develop` runs from the job checkout and
supplies edited files and `summary`. `duallane.release-agent.verify` runs from a
second checkout and receives `repository`, `base`, `head`, `tree`, `acceptance`
and `releaseKind`. Return `passed: true` and `evidence` after the required gates
pass. An Android OTA verifier builds `android/app/src/main/assets/www`. The
coordinator packages the checked files, records per-file digests and computes
the ZIP digest. Custom model commands can receive model credentials through
their explicit `environment` mapping. Keep all chat, Git and release secrets
outside that mapping. `allowDraftPush: true` uses the separately provisioned
`DUALLANE_DEV_GITHUB_TOKEN` to push only a work branch and create a draft PR.
Use a repository-scoped short-lived credential. Without it, the pilot preserves
local candidate commits and trees for inspection.

The Windows deployment can invoke `development-wsl-verify.mjs` through
`wsl.exe -d <distribution> --exec <linux-node> <linux-script> <verify-config>`.
Use the live clone's Windows working directory so WSL starts inside the
disposable candidate. The verifier config specifies absolute Linux tool
and offline cache directories. Use `nodeDirectory`, `pnpmDirectory`,
`goDirectory`, `pnpmStoreDirectory` and `goModuleCache`. Prewarm the caches
from the trusted lockfiles and Go sums. The verifier binds the toolchains
and caches read-only, gives the test process a private home and runs it
with a loopback-only network namespace.

```sh
node tools/release-agent/cli.mjs check /absolute/private/config.json
node tools/release-agent/cli.mjs run /absolute/private/config.json
node tools/release-agent/cli.mjs status /absolute/private/config.json
node tools/release-agent/cli.mjs audit /absolute/private/config.json DL-id
```

In the existing custom Comet bridge, pass the versioned request and the
operator's absolute configuration path to `dispatchReleaseAgent`. Send a
returned result through the bridge's normal encoder. A `null` result continues
to the existing conversation handler. On Windows the pilot installer inserts
that dispatch and starts a separate queue worker under the current account.
It verifies the bridge entry point and saves a private backup of the original.
The existing Comet bot listener continues handling incoming events. When the
server requires a newer SDK, use a reviewed tool checkout with that SDK and
repeat the channel check using the existing profile.

```powershell
& .\tools\release-agent\install-windows-pilot.ps1 -ConfigPath $configPath -BridgePath $cometBridgePath
```

Restore the original bridge from the installer receipt and stop the
`DualLane-Comet-Release-Agent-Pilot` task to roll back local activation. Preserve
the private ticket state if it will be needed for recovery or audit.

## Enable an approved production controller

Enable production only after testing intake, draft creation and card replay in
the pilot. Use a separate trusted release process and operator configuration.
The CLI `release` role handles approved tickets; the `run` role handles intake,
development and chat delivery. Give `release` read-only GitHub access to the
required checks, access to the private approval store, and the minimum release
credentials. In the coordinator config, `production.goInspectCommand` supplies
the healthy Go commit, version and recovery snapshot digest through a read-only
operator command. Its credential can only inspect and belongs in the coordinator
config. The deployment command and credential belong in the release config.
The existing repository maintainer merges the verified PRs in
GitHub. The executor checks the merge actor, PR base and head, exact `main` tip,
reviewed tree, required workflows and unchanged baselines. It waits for merge
and pending CI. Reissue approval after drift.

Set `production.origin` to the same trusted HTTPS origin as `channel.origin`.
For Go/Web, configure `production.goCommand` with an absolute SSH program and
fixed arguments invoking an operator-installed copy of `operator/go-web.mjs`
on `timestarry@server`. It checks the previous healthy images and private
snapshot, advances the production checkout with `git pull --ff-only`, and
calls the repository's guarded deployment script with the exact approved SHA.
For OTA, set `production.otaProfile` to a separately paired operator profile.
The current OTA endpoint can replace the release in one request. Before setting
`production.otaAuthority` to `exclusive`, designate this controller as the
sole writer and route manual OTA and APK publication through that same operator
authority. If other administrators or tools can still publish concurrently,
keep automatic OTA in pilot mode until a server-side conditional write is
available. A local process lock cannot serialize those other writers.
The executor verifies the original and downloaded normalized archives, retains
the previous verified OTA bytes, and checks APK identity and the minimum native
version code. APK signing and native minimum-version changes require maintainer
handling. The existing draft native signing workflow is the next step for a
manual Android candidate.

Both release recipes share one state fence. An uncertain or partial release
blocks later writes until an operator inspects live health, image labels,
snapshot and OTA metadata. Never repeat an operation with an unknown outcome.
Once the interrupted process is stopped and its result is reconciled, record
the decision with `node tools/release-agent/cli.mjs acknowledge-interruption
<config> <id> <revision>`. Submit a fresh candidate and approval when a new
write is needed.

## Validation

Run `pnpm test:release-agent` for the durable intake, dual-repository fixture,
approval, routing, release ordering and reconciliation checks. The tests use
local Git repositories, synthetic chat events and stubbed release transports.
On Windows, set `DUALLANE_RELEASE_TEST_WSL_CONFIG` to the Linux verifier config
path to include the isolation smoke test. It asserts that candidate scripts
can reach the checkout and offline cache and that sibling files, host mounts
and chat credentials are outside the sandbox.
`node tools/release-agent/cli.mjs check <config>` verifies the two real Comet
routes without sending a message.
