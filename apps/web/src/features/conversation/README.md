# Shared Workspace conversation view

`WorkspaceChatPanel` is the single conversation renderer used by the group-chat
adapter in `App.tsx` and the topic adapter in `WorkspaceTopics.tsx`. It owns the
header, message list, sender/date grouping, reply previews, delivery/failure
states, object-action menu and the production `WorkspaceComposerEditor`.
Each ordinary message retains three direct regions: avatar, content and actions.
The shared stylesheet owns sender backgrounds and action placement.

`message-grouping.ts` derives `single/start/middle/end` edges from adjacent source
messages according to the [message-surface and grouping contract](../../../../../docs/design/ui-ux-rewrite/DESIGN_SYSTEM.md#消息表面与连续短消息).
Group boundaries never wrap or re-key rows: individual message actions and DOM
identity survive regrouping. Missing reply originals still retain their source ID.

`contracts.ts` defines a minimal `WorkspaceConversationMessage` display shape.
Domain-specific messages can extend it through `WorkspaceChatPanelProps<TMessage>`.
The view does not fetch data, authorize commands, persist content or clear drafts.
The calling domain owns those operations and must preserve its own request,
conversation, membership and draft-revision guards.

The complete Workspace adapter supplies the same structured-content renderer,
auto-hide policy, pending attachments, reactions and full emote picker to groups
and topics. `message-model.ts`, `message-projection.ts`, `message-content.ts` and
`message-commands.ts` are shared by both: topics cannot introduce a reduced block
list or a second renderer. `TopicChatRuntime` binds the real upload/submit services
to the topic scope, while the topic session owns membership, per-message delivery,
read position and sync. Echo interactions still depend on actual Bot membership.
Neither renderer imports `App.tsx`; the dependency direction
is from domain adapter into the shared view. `ConversationIdentity` also owns the
existing avatar identity/Bot badge and mention picker. App compatibility exports
for image-emote and upload-progress helpers delegate to `conversation-utils.ts`.

## Supported capabilities

Callbacks are capability declarations. Omit `onStageFiles`, `onToggleReaction`,
`onTogglePin`, `onRecall`, `onHideMessage` or `onFavoriteEmote` when the corresponding
domain operation is unsupported. The view does not render placeholder commands.
Reaction selection additionally requires `renderEmotePicker`; a composer without
that slot does not expose an emote-picker button. `getMessageActions(message,
defaults)` is a pure projection that can narrow real defaults or add real domain
commands, such as topic sync. Local IDs never receive the server-backed hide action.
Replacing a pending object's ID with a confirmed ID closes its old menu and restores
focus to the list, rather than retaining an action bound to the removed object.

`ReactionPickerPopover` portals the existing emote picker out of the history
scroller and reuses the shared viewport placement policy. Bottom messages open
upwards when below-space is insufficient; narrow viewports constrain width and
height while the emote grid scrolls internally. Opening, selecting and Escape
preserve the reading position; selection and Escape return focus to the source.
The same wrapper serves direct actions and the menu/sheet entry in every adapter.

`readOnly` and `composerDisabled` stop editing/sending and guard interactive composer
tools. `composerDisabledReason` explains that state. `sendDisabled` represents an explicit submission block, not whether another
message is uploading. Each submission captures and releases only its current
draft; per-client-message delivery claims prevent duplicate sends while allowing
the next message. Late responses only settle their own pending item. `hideComposer` plus `emptyState` supports
an unjoined topic without rendering history or a misleading invitation to send.

`banner` adds a header-context row. `composerContext` adds the active send target or
supported sync setting above the same editor. `renderMessageMeta` adds a domain
status beside author/time without creating an extra message-grid region.
`composerEditorRef` exposes focus through the existing editor handle. Delayed image
emote completion restores focus only within the same scope/handle and only while
the editor still owns focus; it cannot steal focus from another conversation.

## Verification

Run from the repository root:

```sh
node apps/web/src/features/conversation/verify-conversation.mjs
node apps/web/src/ui/patterns/verify-message-surfaces.mjs
node apps/web/src/ui/patterns/verify-workspace-history.mjs
node apps/web/src/ui/patterns/verify-p2p-objects.mjs
```

The component fixture imports the actual production renderer at 1440/390/320 px
and checks grouping, dates, replies, native text, capability-dependent menus,
failed retry, local-ID replacement, scope/focus, delayed image-send completion,
editable drafts during submission, read-only tools, banner/composer geometry and
unjoined visibility. It asserts that the renderer makes no domain API requests.
Changing the unread boundary also verifies that existing message nodes survive.
The surface matrix checks group edges, row spacing, independent hover and sender
colors in all registered theme/mode combinations at desktop and narrow mobile widths.
The history fixture imports the actual group adapter through App with controlled
API responses, including live appends while an initial history page is pending
or fails. It follows visible message bodies when pagination changes group headers.
The P2P fixture ensures helper extraction preserves its existing
private conversation behavior and no-content-persistence boundary. These fixtures
do not replace the real Go Workspace/topic authorization and concurrency tests.

The Go-backed `e2e/workspace-reaction-picker.spec.ts` covers group/topic bottom
messages at 1440/390/320 px, real reaction submission, viewport bounds and hit
testing, reading position, keyboard focus, delayed pack settings, window resizing,
and right-click/long-press on an expanded message taller than the viewport.
Run it with the disposable Workspace environment described in the repository's
[testing guide](../../../../../docs/development/TESTING_AND_RELEASE.md#3-browser-tests).
