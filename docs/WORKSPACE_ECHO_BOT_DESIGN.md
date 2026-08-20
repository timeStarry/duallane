# Workspace Echo Bot Design

## 1. Document Status

- Product name: `回声`
- Internal module name: `Echo Bot`
- Status: implemented in v0.15, extended in v0.15.1
- Scope: Shared Space / Workspace audited relay lane
- Related system bot: `信标` (personal file and content transfer assistant)

This document records the implemented product behavior, trust boundaries, reusable interaction infrastructure, domain model, permissions, protocol contract, and acceptance criteria for the Workspace `回声` bot in v0.15.

`回声` is implemented as a consumer of reusable Workspace card, command, workflow, permission, audit, and realtime components. It does not introduce a private message format or a second authorization path that only works for this bot.

### 1.1 Implementation Status

The v0.15 implementation includes the protected `回声` identity, reusable direct conversations, registered slash commands, revisioned guided workflows, typed interactive cards and actions, requirement and solicitation persistence, voting, idempotent delivery, permission-filtered realtime updates, audit metadata, owner management surfaces, and the chat-composer command/workflow UI. v0.15.1 adds owner-triggered version update publication through `/release <version>`, immutable detailed usage-guide snapshots, and resumable delivery to every active human member in the current space.

Echo commands are user-visible in direct conversations with `回声`. The command framework and client recognizer also enforce an addressed-mention context, but the v0.15 Echo identity remains direct-only and cannot join ordinary groups. Workflow start, continue, and cancel operations are authenticated, context-bound, rate-limited, audited, idempotent where applicable, and protected by revision compare-and-swap rules.

The following remain outside the v0.15 Echo scope: AI-generated decisions, automatic prioritization, external issue-tracker synchronization, cross-space aggregation, anonymous voting, arbitrary remote card UI, Echo participation in group chats, workflow attachments, and deadline reminder scheduling. The separate custom Agent Bot platform does not change Echo's server-managed identity or deterministic behavior.

## 2. Product Positioning

`回声` is a built-in Workspace bot for publishing requirement solicitations, collecting votes, receiving private requirements and feedback, returning processing status, and broadcasting detailed version usage guides.

The aerospace communication naming family is:

| Bot | User-facing purpose | Visibility |
| --- | --- | --- |
| `信标` | Personal file and content transfer | Current user only |
| `回声` | Requirement solicitation and feedback processing | Public solicitation or submitter-and-owner restricted content |

The name `回声` represents a signal that is sent, received, and answered. The visible identity is `回声` with the secondary label `需求与反馈助手` and an official `BOT` badge.

`回声` is not an AI assistant. It does not freely generate decisions, approve requirements, or infer product policy. Initial behavior is deterministic and driven by registered commands, guided workflows, card actions, domain rules, and explicit owner decisions.

## 3. Goals

- Give space owners a consistent way to publish public requirement solicitations.
- Deliver the same solicitation to all eligible members without creating an unmanaged all-member group.
- Let members vote through structured, accessible, realtime-updated cards.
- Let members privately submit requirements, suggestions, and problem feedback.
- Let space owners process submissions through explicit states and responses.
- Let owners list and filter all collected and implemented requirements.
- Establish reusable card and command infrastructure for future Workspace features.
- Let authorized owners broadcast a registered version guide that tells members what changed and where to use it.
- Preserve Workspace RBAC, retention, quota, audit, event filtering, and log-redaction invariants.

## 4. Non-Goals

The first release does not include:

- AI-generated requirement analysis or automatic decisions.
- Automatic approval, rejection, prioritization, or implementation claims.
- User-created or third-party code executing as `回声`; custom Agent Bots use a separate platform and identity model.
- Echo participation in group chats.
- External issue tracker, webhook, or project-management synchronization.
- Cross-space solicitation or aggregation.
- Cross-space or deployment-wide release broadcasts; “all members” means active human members of the current space at publication time.
- Anonymous and operationally untraceable voting.
- Arbitrary HTML, JavaScript, remote UI, or custom CSS cards.
- A general low-code card layout language.
- Full-text search beyond the Workspace search scope available at implementation time.

## 5. Product Actors

### 5.1 Space Owner

The space owner can:

- Publish, close, and withdraw public solicitations.
- View aggregate voting results and authorized voter details.
- Receive all member submissions through `回声`.
- Mark submissions as collected, implemented, or rejected.
- Add a response when changing status.
- List and filter all requirement records.
- Publish a registered version update guide to every active human member with `/release <version>`.

Owner-only behavior must be enforced through capabilities rather than hard-coded UI role checks.

### 5.2 Regular Member

A regular member can:

- See and open `回声`.
- Receive active public solicitations.
- Vote or change a vote while a solicitation permits it.
- Submit a requirement, suggestion, or problem report.
- View their own submissions and status history.
- Receive status updates from `回声`.

### 5.3 Auditor

The current auditor role remains reserved and read-only. It may see the public identity of `回声` and public solicitation content, but it does not gain voting, submission, owner processing, or private-content access merely because the bot exists.

### 5.4 Echo Bot

`回声` is a server-managed `bot` user. It can deliver server-authorized bot messages but cannot authenticate as an interactive user.

## 6. Bot Identity And Anti-Impersonation

`回声` uses the same protected system-bot identity model as `信标`:

- Stable, reserved internal user ID.
- `users.kind = 'bot'`.
- Idempotent initialization in the default space.
- No invite consumption.
- No GitHub OAuth identity binding.
- No password, API credential, browser session, or interactive login.
- Explicit rejection from OAuth binding and Workspace session issuance.
- No removal, role change, member visibility edit, rename, avatar change, or group membership through normal member-management APIs.

The official `BOT` badge is derived only from the server-projected `kind: "bot"` value. It must appear in member search, direct-chat selection, conversation lists, conversation headers, message authors, and card source labels.

A human using the name `回声`, the same avatar, or the text `BOT` must not receive the official badge. Clients cannot submit or modify authoritative bot identity fields.

## 7. Conversation And Delivery Model

Each eligible user has one reusable direct conversation with `回声`.

- The conversation key is deterministic per space, user, and bot.
- Reopening `回声` returns the existing conversation.
- Different users cannot read one another's bot conversation.
- `回声` is globally visible without per-user visibility grant rows.
- `回声` cannot be added to ordinary groups.

Public solicitation does not require a shared all-member conversation. One solicitation resource is created, then a card referencing that resource is delivered into each eligible user's `回声` conversation.

Version updates use the same isolated delivery model. One immutable publication snapshot and one delivery row per active human member are created atomically, then an `echo.release` card is delivered into each member's existing or newly created `回声` conversation. Members added after publication do not receive historical release broadcasts automatically.

This model provides:

- A single source of truth for solicitation state and votes.
- Isolated user command and feedback history.
- Existing conversation membership enforcement for message access.
- No duplicated vote state in copied message JSON.

An active solicitation may be delivered to a newly joined eligible member according to its delivery policy. The default is to deliver all still-open solicitations.

## 8. Visibility And Privacy

Content is classified by resource, not only by the bot conversation containing a card.

### 8.1 Public Solicitation

All eligible members can see:

- Solicitation title and description.
- Options and current aggregate counts according to result policy.
- Publisher identity.
- Open, closed, or withdrawn status.
- Their own current vote.

Detailed voter identities are owner-only by default. A future policy may expose them, but this cannot be inferred by the client.

### 8.2 Private Requirement Or Feedback

By default, a submission is visible only to:

- The submitting member.
- Space owners with the explicit processing capability.
- The internal service components required to persist and deliver it.

Other members and administrators do not gain access automatically. Audit records contain metadata and stable result codes, not the requirement body or attachment contents.

Publishing a private submission as a public item requires a separate owner action and an explicit public projection. Submitter identity remains hidden unless policy and user consent allow disclosure.

### 8.3 Trust-Lane Boundary

All `回声` content belongs to the server-retained Workspace lane. It must not change or weaken the P2P private lane contract, and P2P plaintext must never be copied into Workspace message, card, command, workflow, audit, or log storage.

## 9. Reusable Interaction Architecture

`回声` is built on three reusable layers:

1. **Message protocol layer**: card references, fallback summaries, message previews, and realtime card updates.
2. **Interaction execution layer**: registered commands, card actions, guided workflows, idempotency, authorization, rate limits, and audit decisions.
3. **Domain layer**: Echo solicitations, options, votes, submissions, status history, and notification rules.

Card actions and slash commands must converge on the same domain application services. A button and an equivalent command cannot maintain separate permission or transition logic.

## 10. Generic Card Message Component

### 10.1 Message Block

The existing versioned Workspace message protocol is extended with a card reference block:

```ts
type CardBlock = {
  type: "card";
  cardId: string;
  cardType: string;
  schemaVersion: number;
  fallbackText: string;
};
```

- `cardId` is a server-generated card instance identifier.
- `cardType` identifies a registered renderer and projector.
- `schemaVersion` identifies the card contract version.
- `fallbackText` supports notifications, previews, search, accessibility fallback, and older clients.

The message stores the reference and readable summary. Mutable domain state such as vote counts and requirement status is not copied into immutable message content.

### 10.2 Card Instance

A generic card instance contains only infrastructure-level metadata:

- ID, type, and schema version.
- Resource type and resource ID.
- Current revision.
- Creator and timestamps.
- Visibility policy identifier.
- Active, invalidated, or expired state.

Domain-specific records remain in domain tables. The generic card store must not become an unvalidated JSON database for every feature.

### 10.3 Card Registry

Each supported `cardType + schemaVersion` is registered with:

- Input and public-projection validation.
- Resource projector.
- Plain-text fallback generator.
- Allowed action definitions.
- Frontend renderer.
- Unsupported-version behavior.

Initial Echo card types:

| Card type | Purpose |
| --- | --- |
| `echo.solicitation` | Public solicitation and voting |
| `echo.request` | Requirement details and owner processing |
| `echo.request-status` | Submitter-facing status notification |
| `echo.request-list` | Owner list and filtering result |

Future features may register task, approval, schedule, file-summary, or other bot cards without changing the base message component.

### 10.4 Rendering Rules

All cards share a common frame for source identity, title, status, content, metadata, actions, loading, error, expired, and permission-denied states.

Renderers must:

- Render text as text or through the existing safe Markdown path.
- Never render arbitrary HTML, JavaScript, inline event handlers, remote components, or custom CSS.
- Use the application icon registry and design tokens.
- Enforce payload byte, depth, array, and text limits.
- Preserve responsive layout and keyboard accessibility.
- Render `fallbackText` for unknown or unsupported card versions.
- Never leave a blank message or crash the message list for an unknown block.

The v0.15 client uses registered typed React components, not a general low-code card DSL.

### 10.5 Mutable State And Realtime Updates

Messages remain immutable while their referenced resources may change.

After a vote or status transition:

1. The domain transaction commits.
2. The resource and card revision increase.
3. A permission-filtered Workspace event is written.
4. Eligible clients receive the updated public projection or invalidate and refetch it.
5. Clients ignore responses and events older than the current revision.

Generic event types:

```text
card.created
card.updated
card.invalidated
```

Events must not expose raw domain records to unauthorized subscribers.

## 11. Generic Card Action Component

Card actions use one authenticated execution endpoint and a registered handler:

```json
{
  "version": 1,
  "clientActionId": "act_local_uuid",
  "cardId": "card_xxx",
  "actionId": "vote",
  "expectedRevision": 7,
  "input": {
    "optionIds": ["option_a"]
  }
}
```

The server resolves the handler from the stored card type and registered action. It does not trust the client to supply resource type, actor, role, target status, vote totals, or bot identity.

The common action pipeline must:

1. Validate protocol version and action input schema.
2. Derive the actor from the authenticated Workspace session.
3. Validate active space and conversation membership.
4. Load the card and linked resource.
5. Recompute resource visibility for the actor.
6. Validate that the action is valid for the current resource state.
7. Check the required capability.
8. Compare `expectedRevision` and reject stale writes.
9. Deduplicate with `clientActionId`.
10. Execute the domain service in a transaction.
11. Write audit and realtime events where required.
12. Return the latest actor-specific public card projection.

Button visibility is a presentation hint, not authorization.

## 12. Generic Bot Command Component

### 12.1 Registration

Bots register commands through a common registry:

```ts
type BotCommandDefinition = {
  botId: string;
  name: string;
  aliases?: string[];
  version: number;
  allowedContexts: Array<"bot_direct" | "group_mention">;
  requiredCapability?: string;
  argumentSchema: unknown;
  handler: string;
  auditAction?: string;
};
```

Echo initially registers:

```text
/help
/cancel
/publish
/release <version>
/need
/feedback
/list
/view
/collect
/implement
/reject
```

The generic component handles parsing and execution mechanics. Echo handlers own requirement-domain behavior.

### 12.2 Recognition Context

A slash-prefixed message is recognized as a command only in:

- A direct conversation with the target bot.
- An addressed group-mention context supported by both the bot policy and conversation membership.

Slash-prefixed text in ordinary human conversations remains normal message content.

For `回声` itself, v0.15 exposes only the first context because the protected Echo identity has a direct-only conversation policy. The mention rule is retained in the reusable command framework for bots that are allowed in groups.

### 12.3 Parsing Rules

The parser must:

- Match only registered commands.
- Apply documented whitespace, newline, Unicode, and case normalization.
- Support a limited quoted-argument grammar where needed.
- Limit total length, argument count, and argument size.
- Return help for unknown commands.
- Never interpret shell, SQL, template, expression, path, or dynamic-code syntax.
- Never derive handler names, database columns, or file paths from raw input.

### 12.4 Command Envelope

After parsing, execution uses a typed command envelope:

```json
{
  "version": 1,
  "clientCommandId": "cmd_local_uuid",
  "botId": "bot_echo",
  "command": "list",
  "arguments": {
    "status": "implemented"
  }
}
```

The execution component owns authentication, context validation, capability checks, idempotency, rate limiting, audit decisions, and stable error mapping before invoking a domain handler.

Equivalent UI and command operations share one domain service. For example, an `已实现` card action and `/implement REQ-0012` both invoke the same requirement transition function.

`/release` is owner-only. It accepts one semantic version with an optional leading `v`, and rejects versions that do not have a registered detailed usage guide. A repeated publication of the same version resolves to the original publication and retries outstanding deliveries without creating a second broadcast.

## 13. Generic Guided Workflow Component

Commands such as `/publish` and `/need` may start a multi-step guided workflow.

Infrastructure-level workflow state contains:

- Workflow type and version.
- Bot, user, space, and conversation IDs.
- Current step and revision.
- Created, updated, and expiry timestamps.
- Active, completed, cancelled, or expired status.

Business fields are validated by the registered workflow schema. Workflow state is temporary coordination state, not the long-term source of truth. Final confirmation creates domain records in a transaction.

Rules:

- One foreground workflow per user and bot conversation by default.
- A conflicting command asks the user to continue or cancel the active flow.
- `/cancel` affects only the actor's own active workflow.
- Expired workflows reject further input.
- Each step uses a revision to reject duplicate or out-of-order submissions.
- Active flows either survive restart or fail with an explicit recoverable state.
- Final submission repeats membership, capability, resource, and input validation.

## 14. Command And Action Security

### 14.1 Server Trust Boundary

The server never trusts client-supplied:

- Actor or bot identity.
- Role or capability.
- Official `BOT` status.
- Resource visibility.
- Current demand or solicitation state.
- Vote totals or publisher identity.
- Bot message author fields.
- Audit actor, result, or target fields.

Normal `message.create` requests cannot create `kind: 'bot'` messages. Bot messages are created only through internal, registered bot delivery services.

### 14.2 Capability Model

The framework checks capabilities rather than hard-coding role names. Initial Echo capabilities include:

```text
echo.solicitation.publish
echo.solicitation.close
echo.vote.create
echo.request.submit
echo.request.read_own
echo.request.list_all
echo.request.transition
echo.vote.read_details
```

Initial policy grants owner processing capabilities only to the space owner. Future policy changes do not require rewriting command handlers.

Authorization is repeated at execution and final workflow confirmation. A role check performed when rendering a card or starting a workflow is insufficient.

### 14.3 Idempotency, Concurrency, And Rate Limits

- Message creation continues to use `clientMessageId`.
- Commands use `clientCommandId`.
- Card actions use `clientActionId`.
- Mutable resources use revision-based optimistic concurrency.
- Database uniqueness enforces one active vote per voter and solicitation.
- Broadcast creation and delivery are idempotent and resumable.
- Rate limits apply by actor, bot, command/action type, and space.
- Broadcast operations have stricter limits and maximum audience checks.
- Retries cannot duplicate broadcasts, votes, transitions, or notifications.

### 14.4 Audit And Logging

The framework may record:

- Command or action name and version.
- Card type.
- Target resource ID.
- Success, failure, or rejection.
- Stable reason or error code.

It must not record:

- Full raw command text.
- Requirement or feedback body.
- Private card fields.
- Attachment contents or storage keys.
- OAuth, Session, cookie, or action secrets.

Fastify log redaction remains unchanged. New command and card endpoints must not log unredacted request bodies.

## 15. Echo Solicitation Workflow

### 15.1 Publishing

An owner starts a public solicitation with `/publish`. The guided workflow collects:

- Title and description.
- Voting question.
- Options.
- Single- or multiple-choice mode.
- Maximum selections for multiple choice.
- Whether votes may be changed.
- Deadline.
- Result visibility policy.
- Delivery policy for new members.

The owner reviews a confirmation summary and explicitly confirms publication. The separate owner management surface can also create a draft before publishing it.

Publication creates one solicitation resource and idempotent delivery records for eligible members. Delivery failures are retryable and visible to the owner without duplicating successful deliveries.

### 15.2 Solicitation State

```text
draft -> open -> closed
draft -> withdrawn
open -> withdrawn
```

- `draft`: visible only to its owner author.
- `open`: delivered and accepting votes.
- `closed`: visible but no longer accepts votes.
- `withdrawn`: displays a withdrawn state and rejects actions.

Deadline closure must be enforced by the server even if the visible card has not refreshed.

### 15.3 Voting

- One effective vote per eligible user and solicitation.
- Single choice accepts exactly one option.
- Multiple choice enforces configured minimum and maximum selection counts.
- A vote may be changed only while open and when policy permits.
- Vote updates use idempotency and resource revision checks.
- Aggregate counts are server-computed.
- Owner-only voter details use a separate authorized projection.
- Existing emoji reactions are not used as votes.

Reactions remain lightweight message expressions. Votes have distinct option, eligibility, deadline, privacy, uniqueness, audit, and revision semantics.

## 16. Echo Requirement And Feedback Workflow

### 16.1 Submission

Members start with:

```text
/need
/feedback
```

The guided workflow collects:

- Type: requirement, suggestion, or problem feedback.
- Title.
- Detailed description.
- Usage scenario.
- Expected result.
- Optional related link.

Before submission, `回声` displays a confirmation step. Confirmation creates a stable identifier such as `REQ-2026-0012` and delivers an owner-facing `echo.request` card. Workflow attachments remain a later enhancement; a command with staged message attachments is rejected by the client without discarding either the command draft or the attachments.

### 16.2 Requirement State Machine

```text
proposal/pending_review -> formal/planned -> formal/in_progress -> formal/delivered
formal/delivered -> archived/implemented
proposal or formal -> archived/rejected|duplicate|withdrawn|cancelled
```

External labels:

| State | Label | Meaning |
| --- | --- | --- |
| `proposal / pending_review` | 待审核 | Submitted and awaiting owner decision |
| `formal / planned` | 已计划 | Entered into the formal requirement pool |
| `formal / in_progress` | 进行中 | Explicitly marked as being processed |
| `formal / delivered` | 已交付 | Delivery has been confirmed but remains active history |
| `archived / implemented` | 已实现 | Delivered work has been archived as implemented |
| `archived / rejected` | 已驳回 | Not accepted or no longer planned |
| `archived / duplicate|withdrawn|cancelled` | 重复提案 / 已撤回 / 已取消 | Archived with the recorded terminal outcome |

An owner may add a response to every transition. Rejection requires a reason. Implementation may include a version, date, or release note.

Each transition:

- Uses the shared domain transition service.
- Persists immutable status history.
- Emits a permission-filtered event.
- Sends an `echo.request-status` card to the submitter.
- Writes audit metadata without the private body.

Terminal records are not silently deleted.

### 16.3 Owner Commands

```text
/list
/list pending
/list collected
/list implemented
/list rejected
/view REQ-2026-0012
/collect REQ-2026-0012
/implement REQ-2026-0012
/reject REQ-2026-0012
```

`/list` supports authorization-aware pagination and filters. The command returns a bounded structured result rendered by the Echo interaction surface; `echo.request-list` remains a registered typed card for delivered list projections.

Unauthorized users receive a stable permission response. Rejected sensitive attempts produce audit rows without echoing protected resource details.

## 17. Version Update Publication

### 17.1 Registered Usage Guides

The homepage changelog remains a concise public summary. Echo release publication uses a separately registered guide whose version, release date, title, and summary must match the homepage release facts. Every detailed item additionally contains:

- A short user-facing change title.
- A plain-language explanation of the new feature, setting, or behavior change.
- An explicit location path showing where to use or configure it.

Operational-only changes may state that no setting is required and name the unchanged user entry points. Storage keys, hashes, internal object IDs, migration details, and other implementation metadata are never included in the card payload.

### 17.2 Publication And Delivery

An owner publishes a guide with:

```text
/release 0.15.1
```

Publication atomically stores an immutable guide snapshot and creates a pending delivery for every active human member in the current space. The command then attempts immediate delivery through each member's private Echo conversation. Temporary failures remain durable and are retried by the existing Echo recovery worker; successful recipients never receive a duplicate message.

The unique `(space, version)` publication boundary makes a repeated command idempotent even when it uses a different command invocation ID. Changing the registered guide later does not rewrite cards that were already published. Publishing a correction requires a new version.

### 17.3 Authorization And Audit

Only the space owner may run `/release`. Command execution still applies the shared context, membership, rate-limit, idempotency, and request-metadata checks. Publication audit rows contain the version, actor, result, and stable reason only; they do not contain the guide body or member delivery contents.

## 18. Notifications

`回声` sends notifications for:

- New solicitation publication.
- Solicitation closure or withdrawal.
- Requirement submission confirmation.
- Requirement collection, implementation, or rejection.
- Registered version update publication.

Scheduled approaching-deadline reminders are not part of v0.15.

Public solicitation and release notifications go to eligible active members. Requirement updates go only to the submitter and authorized owners.

Notification delivery respects conversation notification settings. Delivery IDs and event IDs prevent duplicate notifications during retry or reconnect replay.

## 19. Domain Data Direction

The v0.15 schema is implemented through versioned migrations while keeping infrastructure and Echo domain responsibilities separated.

Generic infrastructure records include:

- Card instances and revisions.
- Card action idempotency records.
- Bot command execution records.
- Guided workflow sessions.
- Broadcast delivery records.

Echo domain records include:

- Solicitations.
- Solicitation options.
- Votes and vote selections.
- Requirements and feedback.
- Requirement status history.
- Version update publications with immutable guide snapshots.
- Per-recipient version update delivery state.

Generic tables contain infrastructure metadata and references. Echo tables contain validated business state. Message content contains card references and readable fallback text.

Retention behavior must be explicit:

- Message retention can remove old message references.
- Domain record retention is separate and must not be accidentally governed only by conversation message count.
- Audit retention remains independent.
- Attachment lifecycle follows existing Workspace attachment rules.

## 20. API Contract

The implemented routes follow the existing Fastify and Workspace service patterns. Their contract provides:

- Resolve cards visible to the current actor.
- Execute a registered card action.
- Execute a registered bot command.
- Continue or cancel a guided workflow.
- List authorized card or domain projections where needed.

Handlers validate request shape and delegate. Authorization, transitions, idempotency, broadcast decisions, and audit behavior belong in services, not route handlers or React components.

Stable error codes distinguish:

- Unsupported card or command version.
- Unknown card type or command.
- Invalid arguments or action input.
- Permission denied.
- Resource not visible.
- Resource no longer actionable.
- Stale revision.
- Idempotency conflict.
- Workflow expired or conflicted.
- Rate limit exceeded.
- Version guide unavailable for publication.

Errors must not reveal the existence or contents of private resources to unauthorized actors.

## 21. Frontend Requirements

- Render cards through the common card registry and frame.
- Keep card dimensions stable during loading and action submission.
- Disable only the action currently in flight; do not freeze unrelated messages.
- Reconcile optimistic state with revisions and realtime events.
- Render unsupported cards through `fallbackText`.
- Display official bot identity consistently.
- Provide accessible names, focus states, keyboard operation, and screen-reader status updates.
- Keep long titles, option labels, statuses, and error text within mobile and desktop bounds.
- Do not place nested decorative cards inside card messages.
- Do not expose internal terms such as RBAC, event sequence, or audit log to regular users.
- Render `echo.release` as a readable single-column guide with version, date, grouped changes, and a location for every item.

The frontend must not contain authoritative role checks, state transitions, vote totals, or card visibility rules.

## 22. Operational Requirements

- Workspace remains disabled unless `WORKSPACE_ENABLED=true`.
- Echo initialization is idempotent and safe on repeated deployment.
- Broadcast delivery is bounded, resumable, and observable.
- Failed deliveries can retry without duplicating successful deliveries.
- Metrics should cover command/action success, rejection, latency, broadcast progress, and delivery failures without content labels.
- Logs must use IDs and stable codes rather than private text.
- Rollback must be able to disable Echo interactions without disabling ordinary Workspace messaging.
- Unknown Echo cards remain readable through fallback summaries after rollback.
- A release guide must be registered and checked against the homepage release facts before its version can be published.

## 23. Acceptance Criteria

### Identity And Visibility

1. All eligible active members can see `回声` with an official server-derived `BOT` badge.
2. A human cannot impersonate the official badge through name, avatar, or API input.
3. `回声` cannot authenticate, receive a Session, be removed, or join an ordinary group.

### Public Solicitation

4. An authorized owner can create, preview, publish, close, and withdraw a solicitation.
5. Publication creates one source resource and idempotently delivers it to all eligible members.
6. New eligible members receive open solicitations according to delivery policy.
7. Votes enforce eligibility, option rules, uniqueness, deadline, edit policy, idempotency, and concurrency.
8. Aggregate counts update through permission-filtered realtime events.

### Requirements And Feedback

9. A member can submit a requirement or feedback through a command and guided workflow.
10. The submission is visible only to its submitter and authorized owners by default.
11. Owners can list, view, collect, implement, and reject authorized submissions.
12. Card actions and equivalent commands produce identical transition and permission behavior.
13. Submitters receive status cards with complete status history and owner responses.

### Version Updates

14. Only an authorized owner can publish a registered version guide with `/release <version>`.
15. Publication snapshots the guide and targets every active human member in the current space.
16. Every change item describes where the member can use or configure it.
17. Repeating the same version does not duplicate publication, delivery rows, cards, messages, or notifications.
18. Failed deliveries can recover without changing the published guide or duplicating successful deliveries.

### Generic Infrastructure

19. Unknown card types or versions render readable fallback text.
20. Cards cannot inject HTML, scripts, remote UI, arbitrary styles, or unregistered actions.
21. Commands are recognized only in allowed bot contexts and never execute shell, SQL, or dynamic code.
22. Card actions, commands, and workflow steps are authenticated, authorized, idempotent, rate-limited, and revision-safe.
23. Ordinary message creation cannot forge bot authorship or authoritative card state.
24. Existing reactions continue to work independently and are not used as business votes.

### Trust And Operations

25. Private requirements do not appear in unauthorized APIs, events, notifications, audit bodies, or logs.
26. P2P plaintext never reaches Workspace card, command, workflow, message, audit, or log persistence.
27. Existing Workspace RBAC, quota, retention, security headers, and log redaction remain effective.
28. Full project tests, lint, build, migration review, and responsive browser verification pass before release.

## 24. Implementation Structure

The v0.15 Workspace integration provides:

- Versioned structured message content using `duallane.message+json;v=1`.
- Server canonicalization and readable `plainText` summaries.
- Human, bot, and system author kinds.
- Conversation membership and capability checks.
- Idempotent user message creation.
- Permission-filtered realtime events.
- Reactions as separate records and actions.
- Workspace audit and Fastify log-redaction foundations.
- Typed card reference blocks, a registered card projector/action pipeline, and readable fallback behavior.
- Registered command execution and revisioned workflow sessions with persistent idempotency and rate-limit records.
- Echo requirement, status-history, solicitation, option, vote, idempotency, and delivery records.
- Echo version publication snapshots and per-member resumable delivery records.
- Protected Echo identity initialization, reusable direct-conversation delivery, and permission-filtered card refresh events.
- React renderers for Echo cards including detailed release guides, owner management views, and composer-level command/workflow interaction states.

Structured messages now accept registered `card` references alongside text, mention, link, emoji, attachment, and emote-collection blocks. Immutable messages retain a readable summary while mutable card and domain state is projected through the card registry at its current revision.

The implementation is kept in two coherent layers:

1. Reusable Workspace interactive-message infrastructure with focused compatibility and security tests.
2. Echo domain services, card registrations, commands, workflows, permissions, and product UI.

This separation allows later card-based messages to reuse the same protocol and safety boundary without depending on Echo domain code.
