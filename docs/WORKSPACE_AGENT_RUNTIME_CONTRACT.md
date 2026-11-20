# Agent runtime, tasks, and artifacts

Status: SDK/App 1.2 foundation implemented, validation and production activation pending. This contract
extends the [Bot platform requirements](WORKSPACE_AGENT_BOT_PLATFORM_REQUIREMENTS.md).
It does not authorize production activation or changes to an installed Agent.

## Behavior and ownership

This is a Workspace feature. P2P never enters this pipeline. A trigger identifies
one user request; receiving it is distinct from completing the work or publishing
an attachment. A model statement such as "sent" is not a delivery receipt.

| Capability | Authority and responsibility | Required evidence |
| --- | --- | --- |
| Trigger/context | Server filters events and grants; SDK anchors the exact trigger message | Missing explicit IDs fail; history is never substituted |
| Model/tools | Operator-installed command bridge owns model execution and its sandbox | Versioned input/output; bounded execution; no credentials in input |
| Public media | Explicitly enabled SDK HTTPS fetcher | Public pinned DNS, every redirect checked, bounded validated bytes |
| Incoming files | Server authorizes each logical attachment; SDK supplies bounded multimodal input | File scope plus current conversation/context authorization |
| Generated artifacts | Bridge exports actual bytes through the result protocol | Completion, declared type, signature/size, task-bound identity |
| Cross-turn reuse | Private SDK artifact index, scoped to origin/Bot/conversation | Reauthorize, enforce expiry, reference exact artifact ID |
| Publication | SDK uploads and sends; server enforces quota and idempotency | Persist returned attachment/message IDs independently |
| Delivery/task health | Transport reports delivery; SDK reports business stages | ACK never means model, upload, or publication success |
| Updates | Official runtime, user bridge/policy and supervisor are separate | Version + digest + compatibility, preserve local modifications |

## Trust boundaries

The server remains authoritative for Bot scopes, membership, context grants,
attachment visibility, transfer quota, retention and audit. Local caches never
grant access after server authorization is withdrawn. Bot tokens are never sent
to a model, remote media origin, output artifact, log, or chat message.

An installed bridge is trusted executable configuration. Conversation content,
model output, URLs, names and attachment bytes are untrusted data. The generic SDK
does not pretend that a prompt or `--sandbox` label isolates an arbitrary command.
The bridge must enforce group read-only and confidentiality policy independently;
messages cannot change executable configuration or grant capabilities. No built-in
Codex/Claude switch or special-case SVG behavior is added.

## Bridge protocol v1

The existing `{ event, context, conversation }` stdin fields remain available.
Structured bridges additionally receive `protocol: "duallane.agent.request"`,
`version: 1`, a stable task ID, an explicitly resolved `triggerMessage`, declared
capabilities and authorized input/artifact references. Input is finite JSON.
References are scoped IDs, never arbitrary filesystem paths or credential URLs.

A structured stdout result is one JSON document:

```json
{
  "protocol": "duallane.agent.result",
  "version": 1,
  "status": "completed",
  "text": "Here is the requested image.",
  "artifacts": [
    {
      "id": "image-1",
      "source": "inline",
      "fileName": "image.png",
      "mimeType": "image/png",
      "encoding": "base64",
      "data": "..."
    }
  ]
}
```

Sources are `inline` (actual exported bytes), `https` (an explicitly requested
public-media fetch), or `artifact` (a prior scoped artifact ID). Unknown versions,
sources, malformed base64, uncompleted results and excess output fail explicitly.
Text, bitmap, vector, document and retrieved-media results share the artifact
contract. A URL in Markdown remains a link; it is not automatically fetched.
Inline Base64 uses the standard RFC 4648 alphabet, required padding and canonical
unused trailing bits; whitespace, URL-safe substitutions and malformed encodings
are rejected. Validation uses a linear scan with constant stack space, and checks
decoded size before allocation: 25 MiB per bridge artifact and 50 MiB cumulatively.
The structured stdout limit remains 70 MiB and the artifact count remains six.
Legacy stdout text and inline file tags are a bounded compatibility adapter.
Local-path tags do not authorize filesystem reads in the new task pipeline.

## Task and publication lifecycle

Task identity derives from origin, Bot identity and event ID. The SDK accepts an
event into a private durable inbox before transport ACK or cursor advancement.
It does not store credentials. Tasks progress through received, running,
generated, uploading, sending, completed, failed or cancelled. Per-artifact
upload and publication receipts survive process restart. Stable operation keys
prevent a retried message from producing another visible message.

One local consumer owns a Bot/origin at a time. A conversation is serial; global
concurrency and queue size are bounded. Transport duplicates join the existing
task. Recoverable network failures use bounded retries; authorization failures
pause/refuse rather than retry around the policy. Incomplete model execution is
never interpreted as a successful result. A lost response can cause a repeated
external model invocation; the SDK cannot promise exactly-once model execution.

Gateway replay reprojects the current authorized trigger text. Once a message
event is durably accepted, a replay for the same event and source message joins
that task and preserves its accepted event snapshot and receipts, even if the
message was edited. At execution, an authorized context read may supply the
current text. A different source message, conversation or event type is a
conflict; an edit does not implicitly schedule another model invocation.

User-visible failures identify a safe stage and stable code, with an explicit
retry route. Partial success preserves already published items. Logs and doctor
summaries contain stage/count/error codes, never message text, model stderr,
paths, tokens or source URLs. Transport health and business health are separate.

### Gateway replay and resume

The gateway captures the committed space sequence before each bounded scan.
Discovery pages over potential Bot events after the supplied checkpoint. A new
delivery is eligible within the replay window measured from its source event. Previously
queued deliveries keep their recorded expiry. Replay checks the Bot's current
scope, the sender and conversation, and the current trigger before delivery.
Unrelated space traffic and settled expiry or revocation never suppress live
pending records. Admission limits can defer new discoveries while existing
queued work drains. Retries reuse the same Bot delivery and event identity.
An ACK for the same Bot and event is idempotent.

For HTTP `/api/bot/v2/updates`, `currentSequence` reports the captured space
head for diagnostics. After handling all returned events, clients can use
`resumeSequence` as the next `afterSequence` for that scan. `hasMore` can
be true on an empty page. If admission is temporarily full, the resume position
can stay at the requested checkpoint until capacity becomes available. The
WebSocket connection uses the same scan rules internally.

Managed SDK listeners checkpoint only after durable intake and a matching ACK.
A `syncRequired` response or `sync_required` frame with a certified
`resumeSequence` can continue when the queue has no live deliveries in the
settled range. A server head alone gives no resume authority. An ahead cursor or
sync without a safe position requires explicit recovery. The requested
checkpoint is the lower bound for replay, including intentional setup baselines.

## Media and attachment policy

Public-media fetch is opt-in operator policy and does not expand the model's
sandbox. It accepts HTTPS only, rejects URL credentials and non-public addresses,
pins the validated DNS address, and rechecks every redirect. No Authorization,
Cookie, Referer or runtime proxy credential is forwarded. Deadlines, redirect
counts and streamed-byte limits are enforced before allocation or upload.
Compressed responses and unsupported or mismatched MIME/signatures fail closed.
Provenance stores a sanitized source without query/fragment credentials.

Incoming attachment content requires a dedicated Bot endpoint; the human session
endpoint is not a substitute. The server checks file scope, source message,
conversation membership and grant on every read, and accounts transfer quota.
Metadata, bounded text preview and supported image bytes are separate capabilities.
SDK preparation uses a bounded allowlist; archives, executables and unsupported
formats are not interpreted. Model bridges receive content as untrusted input.

Artifacts bind task/event/source-message/conversation to type, size, digest,
expiry, upload and message receipts. On POSIX, the SDK enforces mode 0600 files
in a private directory. On Windows it inherits the profile directory's ACL;
operators must keep that directory restricted to their account. Storage has finite
byte/count limits and expiry; it is not a second permanent conversation archive.
Cross-turn references require current server authorization and matching scope.
Expiry/removal fails explicitly; the model must not guess an old local pathname.

## Compatibility and rollout

The universal command bridge remains the supported architecture. New SDK
capabilities receive a new SDK version; the application version is independent.
The published manifest identifies protocol compatibility, byte size and digest.
Same-version different bytes are reported as drift. Auto-update does not replace
an unregistered or locally modified executable or touch bridge/policy/supervisor
files. Credentials are reused; updating never requires automatic re-pairing.

App 1.2 enforces SDK admission for every Bot, independently of access-policy
version. All setup, Bot HTTP and WebSocket requests declare
`X-DualLane-SDK-Version`. Admission accepts compatible stable versions in the
1.x series starting at 1.2.2. The floor follows published SDK releases,
including patches. Older SDKs must upgrade.
Missing/invalid/older/incompatible declarations return 426
`sdk.upgrade_required` with safe upgrade locations. The runtime stops retries
and requires a verified update while preserving its profile, bridge and policy.
The declaration is public compatibility metadata, never identity or authority;
current authentication, scopes, task and object checks remain mandatory.
Human Session APIs, public downloads, health checks and P2P do not use this gate.
WebSocket adapters may declare the same version through the public subprotocol
`duallane-agent-sdk-1.2.2`. Conflicts and duplicate declarations fail closed.
Bot authentication remains mandatory and credentials never move to URLs.

Implementation order: transport/authorization regressions; structured task and
artifact foundations; bounded media and incoming attachments; recovery/observability;
publication manifests and integration documentation. Each stage records tests
before the next depends on it. Changes go through review and CI. Existing live
Comet service and production deployment remain unchanged until separately selected.

## Acceptance matrix

- Exact trigger amid queued human and Bot messages; missing ID and legacy events.
- Incoming event to bridge to bytes to upload to visible message receipt.
- Model, fetch, upload and send failure with safe user feedback.
- Duplicate events, process interruption, partial upload/send, same-conversation
  ordering, bounded cross-conversation work and a competing consumer.
- HTTPS private/mixed DNS, rebinding, redirect, credential, timeout, size and
  content-type rejection; no permission widening.
- Incoming image/text, scope denial, revoked context and cross-conversation read.
- Cross-turn resend, reuse, expiry, deletion and mismatched artifact identity.
- Disconnect/recovery, 401/403 pause, transient failure bounds and HTML success.
- HTTP and WebSocket replay across unrelated events, with paging, expiry,
  revocation, and stable delivery identity on repeated ACK.
- Digest drift, corrupt downloads, incompatible protocol and local-policy survival.

Synthetic integration proves the complete control flow without production data.
A real-model test and an authorized live channel test are separate evidence; one
must not be claimed on the strength of the other.

## Verification and activation boundary

The implementation is covered by SDK synthetic integration (actual child-process
bridge execution, durable tasks, transport/ACK and updater recovery), Go route and
service tests, and disposable PostgreSQL authorization/quota tests. These checks
do not establish that a particular model bridge understands every input type or
has exported the intended model artifact. Record the final repository and CI
results in the PR.

The development network currently resolves public media hosts to reserved
fake-IP addresses. The public-media policy correctly refuses those addresses;
a real public download remains an operator-network acceptance step. No private
address exception is allowed to make that check pass.

Before selecting this runtime for a live Agent, use an isolated credential
profile and authorized test conversation to verify image/text input, generated
attachment publication, public-media retrieval and cross-turn reuse with that
Agent's actual bridge. Keep its command, group policy and supervisor separate
from the official runtime. The implementation does not update the installed
Comet service or activate an application release.

## Task authorization and on-demand context (1.2)

An opt-in V2 access policy makes all conversation business operations task-bound.
A task is created only from an authorized delivered `message.created` event. The
server binds the token, Bot, conversation, exact input version and current human
requester; a Bot child inherits the original requester and root budgets. A task
reference is not a credential. Omitting it cannot restore a V2 Bot's broad Token
business authority. Legacy policy is retained until an owner explicitly opts in;
the minimum SDK admission requirement still applies to those Bots.

The initial SDK context has at most twelve recent messages. Exact message reads,
keyset history/search and members are exposed consistently in JS, CLI and task
MCP. Queries return scope/coverage, truncation and pagination. Conversation grants,
owner history window, current membership/visibility and cumulative budgets all
apply; a missing result is not proof of absence outside that range. Ordinary
messages only: private topics/threads and recalled/hidden messages are excluded.
Attachment content additionally needs file scope plus current context consent.

Root limits are thirty minutes, 64 content reads, 32 MiB read bytes, 24 writes,
12 children and depth six. The server is authoritative. Input edit/recall, current
authorization changes, cancellation and expiry invalidate further operations.
SDK polls task state; generic state-event subscriptions and snapshot resync are
not implemented (`stateEvents=false`). Thinking stops renewing on task termination
and expires after its short lease; cancellation does not retract committed output.

Only the trusted control layer holds the Bot Token. The command bridge attaches a
loopback task-tool broker/MCP adapter; models receive schemas and logical IDs,
not operator tools or credentials. The bridge still owns OS sandboxing, model
history isolation and actual image/search/generation capabilities. The supplied
[connection Skill](../apps/web/public/integrations/duallane-agent/SKILL.md) documents
that split and must be loaded at integration (or its equivalent versioned
contract on a host without Skills).

Writes stay in the triggering conversation. Message edits require an opaque
expected version and current-task provenance; mixed content must be explicitly
replaced in full. Card updates require revision and the original `card.send`
receipt for that task; quoting a card does not transfer ownership. Conflicts are
not automatically overwritten. Operation-result queries distinguish committed
from unknown without treating transport ACK or timeout as publication evidence.

SDK 1.2.1 maps fixed card buttons to `value.action_id` and nests their optional
business object in `value.data` on send and update. Data keys cannot override
the selected action. Go retains the strict unknown-field/action/size boundary.
Card-write error `attemptOutcome` describes only the attempted request: recognized
strict-converter HTTP400/422 rejection is `rejected`; transport loss, invalid replies
and unrecognized failures remain `unknown`. Both retain `safeToRetry: false`.
An attempt rejection does not prove its operation key has never committed;
operation queries still return only committed receipts or conservative unknown.
