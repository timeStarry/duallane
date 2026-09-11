# UI/UX Standards

These rules govern implementation quality. The current UI/UX contract is the
[final specification index](../design/ui-ux-rewrite/README.md), which assigns one
owner to each visual, interaction and layout rule. It includes all adopted
post-prototype revisions. Production code is implemented on the current branch;
complete acceptance and release remain separate. Historical prototypes, stage
records and older Workspace visual defaults never override the current contract.
Security, data, accessibility and domain capability requirements remain binding.
Rewrite implementation also follows the
[delivery and refinement contract](../design/ui-ux-rewrite/DELIVERY.md): use the
Demo as a design reference, refine against real tasks and constraints, and deliver
production components, a workbench using those same components, and architecture
documentation that matches the code.

## 1. Design Direction

DualLane is a communication and operations tool. Its interface should feel calm,
direct, information-dense, and dependable.

- The rewrite ships one complete visual language across all reachable pages.
  Theme families and light/dark modes parameterize the same components; do not
  retain an old-language fallback or implement separate pages per theme.
- Use hierarchy, spacing, alignment, typography, and dividers before decoration.
- Do not turn page sections into floating cards or nest cards inside cards.
- Avoid oversized marketing headings, decorative gradients, blurred orbs, and
  ornament that competes with conversation content.
- Cards are for repeated entities, dialogs, previews, and bounded tools.
  Use the role-based radii defined only in the
  [design system](../design/ui-ux-rewrite/DESIGN_SYSTEM.md).
- Color communicates state or identity and must not be the only signal.

Before frontend work, read:

- [Complete redesign and theme contract](../design/ui-ux-rewrite/README.md)
- [Current visual and component rules](../design/ui-ux-rewrite/DESIGN_SYSTEM.md)
- [Current layout and flow rules](../design/ui-ux-rewrite/EXPERIENCE.md)
- [Current object actions and settings rules](../design/ui-ux-rewrite/CONTEXT_AND_SETTINGS.md)
- [State and feedback design](../WORKSPACE_STATE_FEEDBACK_DESIGN.md)
- [Mobile and accessibility](../WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md)

## 2. Information Architecture And Layout

- Put the user's primary task first. Settings use flat, titled groups and dividers;
  chat keeps conversation, composer, and context in their expected positions.
- Match type scale to context. Reserve large display type for true product entry
  surfaces, not compact settings panels, cards, or toolbars.
- Use the established spacing and width tokens. Align labels, controls, help text,
  status, and actions to a consistent grid.
- Long URLs, tokens, names, errors, and localized text must wrap or truncate with
  an accessible way to inspect the full value. They must never force page overflow.
- Stable UI such as toolbars, avatars, buttons, counters, media, and skeletons has
  explicit dimensions so loading and hover states do not shift layout.
- Do not force every page into the conversation grid. Only chat and topics retain
  a collapsible middle list; files and members have one main collection. Desktop
  details use a 360px sidebar with its own body scroll, while mobile details are a
  full page. No selected object means no previous conversation details.
- Keep peer management tasks at one level: Bot profile, connection, authorization
  and credentials are chapters; Echo requirements and solicitations are peer tabs.
  Tab changes preserve drafts and avoid nested competing content scroll regions.
- Main navigation exposes five everyday destinations to ordinary members and adds
  space management for owner/admin. Navigation visibility does not grant access;
  existing space deep links still use server-authorized summaries or safe errors.
- Do not scale font size with viewport width. Letter spacing remains `0` unless an
  existing identity mark requires otherwise.

## 3. Components And Controls

- Reuse shared primitives and interaction patterns before creating a local copy.
  A component that looks the same but behaves differently is a defect.
- Use icon buttons for familiar compact tools, segmented controls for modes,
  switches or checkboxes for binary settings, inputs/steppers for numeric values,
  menus for option sets, and tabs for peer views.
- Fixed single-choice preferences and filters with at most four short labels use
  the inset segmented control: one rounded track and a subtly raised selected
  surface. Long labels, explanatory choices and growing option sets use Select.
  Insufficient single-row width falls back to Select while preserving value and
  focus. Do not force navigation-tab indicators onto preference controls.
- Use Lucide icons already installed by the project. Do not hand-draw equivalent
  SVGs. Icon-only controls need an accessible name and a visible tooltip when the
  action is not universally obvious.
- Primary, secondary, quiet, and destructive actions must be visually distinct.
  Destructive irreversible actions require explicit confirmation and should not
  occupy the normal action cluster.
- Touch targets for primary and repeated mobile actions are at least 44 by 44 CSS
  pixels. Do not rely on hover to reveal necessary actions.
- Center icon buttons with `inline-flex`; list/card modes use the shared
  segmented selector with icons and labels. Exact geometry and file-grid sizing
  belong to the design system; narrower viewports must remain usable without overflow.
- A member row has one visible more-actions trigger backed by the same object
  actions as right-click and long press. Member invitation search/multi-selection
  must preserve capability checks and partial-result semantics: serial use of the
  existing single-member API is not an atomic batch operation.
- Native controls must receive the same typography, border, focus, disabled, and
  error treatment as project components.

## 4. Forms And Settings

- Use one label, one control, optional concise help, and colocated validation per
  setting. Do not repeat the setting description as a decorative card title.
- Separate editable profile fields, save/cancel actions and read-only identity.
  Settings use a stable category/content layout on desktop and a page hierarchy
  on mobile; place channel, frequency, address and verification controls in their
  actual dependency order. Align help and save feedback across equivalent rows.
- Theme options preview the real theme tokens in a miniature product view with
  a visible selected state and keyboard focus. Theme, display mode, density,
  motion and transparency stay independent; preview never remounts conversation
  state or depends on copied Demo markup/styles.
- Settings that follow the established auto-save model save after a deliberate
  value change and expose `正在保存`, `已保存`, `保存失败`, and `重试` states without
  moving surrounding content.
- Token creation, rotation, revocation, connection tests, permission grants, data
  deletion, and account/Bot deactivation remain explicit commands.
- Disable submit only when the action is invalid or in flight; explain recoverable
  validation next to the control.
- Preserve user input on network or conflict errors. Restore logical focus after a
  dialog closes or a retry completes.
- Never place secret tokens in URLs, prompts, analytics, logs, or generic clipboard
  instructions. Display one-time secrets only where the protocol permits it.

## 5. Chat And Conversation Parity

Direct, group, Bot, and topic conversations share the same mental model. Reuse
the same message row, avatar, rich-content renderer, composer, mention handling,
attachment preview, send lifecycle, focus behavior, and error feedback wherever
the domain contract is equivalent.

A specialized conversation may add context, but it must not regress behavior
already fixed in the primary chat path. Validate at least:

- text, mention-only, reply, multiline, emoji, image, file, and card content;
- optimistic send, retry, duplicate response, failure, reconnect, and realtime
  reconciliation;
- composer height, focus, draft retention, send-button state, and absence of page
  flashes or layout resets;
- avatar fallback, timestamps, grouping, long content, media aspect ratio, and
  message actions.

Fork a shared component only when the domain behavior truly differs, and document
the reason and parity tests.

## 6. States And Feedback

Every asynchronous surface implements its full lifecycle:

- initial loading with stable layout;
- useful empty state with the next valid action;
- success or current data;
- recoverable inline error with retry;
- unauthorized/forbidden behavior without leaking existence;
- disabled or unavailable state with a reason;
- stale/conflict handling that preserves unsaved work;
- terminal states for revoked, deleted, expired, or detached resources.

Do not use visible text to explain obvious interface mechanics or styling. Copy
should tell the user what happened, what remains true, and what action is possible.
Use notifications for outcomes, not as a substitute for persistent state.

## 7. Responsive Requirements

- Design from content constraints, then verify both desktop and mobile. The
  existing compact breakpoint around 760px is the default reference; do not add
  arbitrary neighboring breakpoints without evidence.
- At 390×844 and 320px width, the page must have no horizontal scrolling, overlapping controls,
  clipped text, inaccessible action, or content hidden behind the keyboard/safe
  area.
- On mobile, stack permissions, session grants, URLs, tokens, and errors in a
  single column. Keep primary actions in the first relevant viewport.
- Conversation panes must retain readable message width while media uses bounded
  aspect ratios and `max-width: 100%` behavior.
- Test narrow and wide content, not only a short English fixture.

## 8. Accessibility

- Use semantic landmarks, headings in order, real buttons/inputs, and associated
  labels. Do not simulate controls with unlabelled `div` elements.
- All workflows are keyboard operable. Focus indicators remain visible; dialogs
  trap focus, support Escape when safe, and restore focus to the opener.
- Announce async status and validation with appropriate live regions without
  repeatedly interrupting screen readers.
- Meet WCAG 2.2 AA contrast for text and meaningful controls. Disabled state must
  remain understandable.
- Images have meaningful alt text or an empty alt when decorative. Media controls
  and file actions expose names and states.
- Motion respects `prefers-reduced-motion`; no essential state depends on animation.

## 9. Visual Review Gate

For visible changes, the PR includes deterministic evidence at relevant desktop
and 390×844 / 320px mobile viewports. Review:

- alignment, spacing, type hierarchy, wrapping, contrast, and component reuse;
- loading, empty, populated, long-content, error, disabled, and destructive states;
- keyboard focus and primary screen-reader labels;
- absence of layout shift, overlap, clipping, and horizontal overflow;
- consistency with the neighboring page and shared interaction pattern.

Automated screenshots support review; they do not replace using the workflow.
Label synthetic component/page fixtures separately from real Go integration
results. A passed screenshot script does not close the full role, device, failure
or assistive-technology matrix; keep unverified cases explicit in the ledger.

