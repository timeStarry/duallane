# Object actions

`useObjectActionScope(scopeKey, objectIds, fallbackRef)` creates one gesture
controller per list. Include actor and active view in the scope key. Pass only
currently available object IDs; disappearing targets close and return focus to
the connected fallback when focus would otherwise be lost.

Attach `bindObject(id)` to the object's interaction area. Normal buttons, links,
inputs, editable content, media controls and `[data-native-context]` retain native
interactions. A primary object button may opt in with `data-object-action-root`;
an existing text selection still takes precedence. Render a sibling more button
with `openFromTrigger(id, event.currentTarget)`, never a button inside a button.

Render one `ObjectActionMenu` with `menuProps`, the current object's label and
domain-owned actions. The domain retains capabilities, disabled reasons,
confirmation, and authorized execution. Workspace conversation, file and member
lists consume this pattern; the message adapter in
`features/conversation/useMessageActions.ts` uses the same controller.
P2P `ChatPanel` uses a separate `p2p:<roomId>` scope. It offers only body copy,
existing failed-message retries, and file actions permitted by the current
transfer status and direction. Copy feedback is component memory; it adds no
content storage or server request. Native body selection remains available.

From the repository root:

```sh
node apps/web/src/ui/patterns/verify-object-scope.mjs
node apps/web/src/ui/patterns/verify-workspace-objects.mjs
node apps/web/src/ui/patterns/verify-p2p-objects.mjs
node apps/web/src/ui/patterns/verify-workspace-history.mjs
```

These scripts start and stop a temporary Vite server and Chromium. The first
covers gestures, native interactions, focus, invalidation, and constant listener
count with 100 added objects. The second mounts the actual App with synthetic
API/WS responses at 1440, 900, 390 and 320 px. It checks hit areas, overlap,
conversation details, file permission/status/quota guards, download reservation
dispatch, failed upload removal, member capability gates, and private-chat
navigation. It verifies client behavior; real Go end-to-end tests remain the
authority for persistence and server authorization.

The P2P verifier temporarily exports the real private `ChatPanel` from a Vite
plugin, without adding a production export. Synthetic callbacks check explicit
copy/retry/receive/reject/save dispatch, ownership/state gates, native text,
scope changes, removed-object focus and mobile long press at 1440/390/320 px.
It asserts no API requests and no message-body storage. It uses port 5196 so it
can run while the real P2P end-to-end harness owns 5173.

The history verifier mounts the actual App with a delayed page response. Its
three cases cover keeping the menu and reading anchor stable when browser scroll
anchoring has already compensated a prepend, preserving a user's updated scroll
position while the request is pending, and ignoring scroll compensation from a
late response for another conversation. A real wheel movement still dismisses
the menu. It uses port 5196 and should run separately from the P2P verifier.
