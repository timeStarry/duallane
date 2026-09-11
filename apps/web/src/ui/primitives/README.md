# DualLane production primitives

Visual and semantic rules are defined once in the
[design system](../../../../../docs/design/ui-ux-rewrite/DESIGN_SYSTEM.md):
[navigation versus value selection](../../../../../docs/design/ui-ux-rewrite/DESIGN_SYSTEM.md#导航选中态与分段单选),
[control geometry](../../../../../docs/design/ui-ux-rewrite/DESIGN_SYSTEM.md#开关与图标按钮的实际居中),
and [message surfaces](../../../../../docs/design/ui-ux-rewrite/DESIGN_SYSTEM.md#消息表面与连续短消息).
This README documents the production API and verification entry points; the
historical prototype is neither a runtime dependency nor a second specification.

Import from `ui/primitives`; that entry imports the owning CSS once. Components
consume the semantic variables installed by `ui/theme`. They do not own account,
conversation, permission, persistence, or request state. A caller must calculate
current capabilities and continue server-side authorization at execution time.

| Export | Controlled contract | Integration responsibility |
| --- | --- | --- |
| `Button` / `IconButton` | Normal button props; `variant`, `lane`, `busy`, optional `leadingIcon`; icon buttons require `label` | Default `type="button"`; submit is explicit. Busy blocks duplicate interaction. IconButton supplies its accessible name and tooltip and uses the shared centering structure. |
| `Switch` | `checked`, `onCheckedChange`, required `label`; button props and optional `description` | Geometry comes from the shared primitive CSS. A supplied `name` creates a checked-only successful hidden form field, default value `on`; disabled/unchecked fields are excluded. |
| `SelectionItem` | `selected`, `placement="side"` or `"bottom"`, button props/ref | Visual foundation for navigation and Tabs, not a preference radio. Caller supplies `aria-current` for navigation; Tabs supplies its own tab semantics. |
| `SegmentedControl` | `value`, `onValueChange`, `label`, fixed `options`; optional icons, accessible labels, `name`, `description`, `disabled`, `hideLabel` | Implements the design system's segmented-radio contract and measured Select fallback. Choosing the current value does not repeat the callback. The controlled value, form field and owned focus survive a responsive presentation change. |
| `ViewModeSwitch` | `value="list"` or `"grid"`, `onValueChange`; optional `label`, `disabled`, `className` | A named SegmentedControl adapter for local list/card presentation; it does not change the file scope or navigate. |
| `Tabs` | `value`, `onValueChange`, `label`, `items`, optional orientation | Local peer panels use SelectionItem and automatic keyboard activation. Panels stay mounted while hidden so their draft state survives switching. URL navigation remains the caller's route/link responsibility. |
| `Select` | `value`, `onValueChange`, `options`, `label`; optional `name`, `description`, `error`, `disabled`, `loading`, `placeholder` | Project-rendered listbox and mobile selection page. The caller explicitly uses Select for long, explanatory or growing collections; an accidentally short response does not change that decision. Form `name` serializes the controlled value. |
| `Slider` | `value`, `onValueChange`, `label`, numeric `min/max/step`, optional `unit/disabled/description` | Native range input plus exact entry. Exact entry commits on blur/Enter; invalid and off-step input leaves controlled data unchanged. An unchanged continuous value from a crop gesture is not rejected merely by focusing its exact input. |
| `ObjectActionMenu` | `open`, `onOpenChange`, `anchor`, `actions`, `label`; optional `summary/presentation/returnFocus/fallbackFocus` | One desktop object menu or mobile modal sheet. Action props are current capabilities; opening never writes. Disabled actions explain why. A `danger` flag styles an action but does not replace the caller's explicit confirmation. |
| `useObjectActions` | Stable object or conversation scope ID | Returns `bind`, `openFromTrigger`, and `menuProps`. Share one controller per conversation/list, not per message. If an adapter uses a conversation scope, it separately owns the current message ID and closes when that object disappears. |

## Object action composition

```tsx
const actions = useObjectActions(conversationId);
<article tabIndex={0} {...actions.bind}>
  <p data-native-context>{messageText}</p>
  <IconButton label="更多消息操作" onClick={(event) => actions.openFromTrigger(event.currentTarget)}>
    <Ellipsis aria-hidden="true" />
  </IconButton>
</article>
<ObjectActionMenu {...actions.menuProps} label="消息操作" actions={availableActions} />
```

Mark the actual message text/rich body with `data-native-context`. Links, editable
fields and native media already retain their browser operations. Never put the
attribute on the entire action surface: it would remove the intended right-click
and long-press entry. Do not disable global selection, touch panning or context
menus. Gesture timing, cancellation, native-context preservation and command
semantics follow [object actions](../../../../../docs/design/ui-ux-rewrite/CONTEXT_AND_SETTINGS.md).
The shared controller consumes the opening long-press release click before it can
hit the new sheet; the next fresh press remains usable immediately.

Menus and Select popups portal to the nearest open native dialog when their
anchor is inside one, otherwise to the document body. Positions use the visual
viewport, clamp at the edges and bound internal scrolling. A queued scroll event
from before opening does not close a newly opened surface. Object menus only
dismiss for deliberate ancestor scrolling: wheel, touch, scrolling keys or a
scrollbar press. Pagination, browser anchoring and programmatic layout changes
preserve the same valid object, following button anchors while retaining pointer
anchors. Menu keyboard navigation does not create background-scroll intent.
Select retains its own ancestor-offset and anchor-movement dismissal policy.
Object menus restore
their trigger; supply `fallbackFocus` for a stable editor/main pane when an action
can remove the trigger. A domain callback opening a confirmation owns the new
dialog focus and the eventual logical return target.

Select's current mobile long-list threshold lives in [Select.tsx](Select.tsx),
not a prototype breakpoint or a copied page selector. Desktop short-list
selection remains select-only; mobile long selection uses a titled native modal dialog and the visual viewport
size, so the search keyboard does not cover the last reachable option. The title
receives initial focus to avoid summoning a keyboard merely by opening the list.
Search matches names and descriptions; the field preserves text-editing keys and
IME composition, while arrows and Enter navigate/commit. Back and Escape close
without committing and restore the trigger. Current value, highlight and search
query are separate states. Live options may remove/disable the highlighted entry;
only a currently present enabled option can commit. Empty, no-result, updating and
error states remain in the same page, including when the list shrinks below the
opening threshold. Resizing does not exchange the active page for another surface.

## Workbench and checks

The development-only `/__design` route imports
[`Workbench.tsx`](../workbench/Workbench.tsx). Its synthetic actions cannot write
domain data; its theme controls use the real device-local appearance store. The
standalone [harness](../workbench/harness.html) also loads application styles and
React Strict Mode. It is excluded from the production root entry.

From the repository root:

```powershell
corepack pnpm --filter @duallane/web exec vitest run src/ui/primitives/popup.test.ts
node apps/web/src/ui/workbench/verify.mjs
node apps/web/src/ui/primitives/verify-segmented-control.mjs
node apps/web/src/ui/primitives/verify-view-mode.mjs
```

The browser script starts and closes a temporary Vite instance. Set
`DESIGN_SCREENSHOT_DIR` to an external output directory to retain review images.
It covers visible switch geometry, Select commit/cancel/disabled/keyboard,
range validation, Tab draft retention, menu and confirmation focus, theme/window
combinations, and mobile long-press release/movement through Chromium CDP. It also
checks searchable mobile selection, no results, long labels, disabled choices,
IME Enter, cancellation/focus and live option removal without accidental commits.
If Firefox/WebKit executables are already installed, the script runs short-list
and full-page selection checks there too; otherwise it reports them as unavailable.

The segmented and view-mode fixtures import production components, exercise
their real width measurement and keyboard behavior, and inspect actual target
geometry. Consumer fixtures such as
[member filters](../../features/members/verify-member-filters.mjs) and
[topic details](../../features/topics/verify-details-and-mode.mjs) cover popup
semantics, focus return and responsive composition using synthetic data.

Current consumers include personal settings, main chat object actions, Echo
requirements/workflows, Bot discovery, topic composer and avatar cropping.
Production domain and integration suites remain separate gates. Chromium touch
emulation is not iOS/Android hardware or screen-reader certification. Full browser
and assistive-technology acceptance and the remaining shared business patterns
must be covered by the product gates. Desktop short-list selection is select-only;
search is provided by the mobile long-list selection page.
