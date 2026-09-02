# UI/UX Standards

These rules govern implementation quality. The detailed Workspace visual and
interaction contracts remain authoritative and are linked below.

## 1. Design Direction

DualLane is a communication and operations tool. Its interface should feel calm,
direct, information-dense, and dependable.

- Preserve the product's existing visual language instead of adding a second
  theme or generic dashboard style.
- Use hierarchy, spacing, alignment, typography, and dividers before decoration.
- Do not turn page sections into floating cards or nest cards inside cards.
- Avoid oversized marketing headings, decorative gradients, blurred orbs, and
  ornament that competes with conversation content.
- Cards are for repeated entities, dialogs, previews, and genuinely bounded tools.
  Keep corner radii at 8px or below unless an existing component specifies less.
- Color communicates state or identity and must not be the only signal.

Before frontend work, read:

- [Visual system](../WORKSPACE_VISUAL_SYSTEM_DESIGN.md)
- [Screen and component specification](../WORKSPACE_SCREEN_COMPONENT_SPEC.md)
- [UI interaction design](../WORKSPACE_UI_INTERACTION_DESIGN.md)
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
- Do not scale font size with viewport width. Letter spacing remains `0` unless an
  existing identity mark requires otherwise.

## 3. Components And Controls

- Reuse shared primitives and interaction patterns before creating a local copy.
  A component that looks the same but behaves differently is a defect.
- Use icon buttons for familiar compact tools, segmented controls for modes,
  switches or checkboxes for binary settings, inputs/steppers for numeric values,
  menus for option sets, and tabs for peer views.
- Use Lucide icons already installed by the project. Do not hand-draw equivalent
  SVGs. Icon-only controls need an accessible name and a visible tooltip when the
  action is not universally obvious.
- Primary, secondary, quiet, and destructive actions must be visually distinct.
  Destructive irreversible actions require explicit confirmation and should not
  occupy the normal action cluster.
- Touch targets for primary and repeated mobile actions are at least 44 by 44 CSS
  pixels. Do not rely on hover to reveal necessary actions.
- Native controls must receive the same typography, border, focus, disabled, and
  error treatment as project components.

## 4. Forms And Settings

- Use one label, one control, optional concise help, and colocated validation per
  setting. Do not repeat the setting description as a decorative card title.
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
- At 390×844, the page must have no horizontal scrolling, overlapping controls,
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
and 390×844 mobile viewports. Review:

- alignment, spacing, type hierarchy, wrapping, contrast, and component reuse;
- loading, empty, populated, long-content, error, disabled, and destructive states;
- keyboard focus and primary screen-reader labels;
- absence of layout shift, overlap, clipping, and horizontal overflow;
- consistency with the neighboring page and shared interaction pattern.

Automated screenshots support review; they do not replace using the workflow.

