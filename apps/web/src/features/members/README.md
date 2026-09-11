# Member invitation picker

`MemberPickerDialog` owns selection and dialog behavior. Its caller owns the
Workspace permission checks and the existing `POST groups/:id/members { userId }`
protocol. The picker never writes data itself or implies an atomic batch API.

Pass the complete candidate list with `disabledReason` for unavailable members;
`existingMemberIds` are excluded. Search preserves selections outside its visible
results. Live removals, membership changes and disabled candidates are removed
from selection; the confirmation boundary validates again.

`onConfirm(ids, context)` is exclusive until it resolves or rejects. For sequential
requests, check `context.isCurrent()` and `context.isAvailable(id)` before each
request, and `context.isCurrent()` again before applying any response. Pass
`context.signal` to the request. Successful additions must update
`existingMemberIds`; on partial failure, reject with a user-facing `Error` so the
remaining selection stays available for retry. Aborting a request does not imply
that the server rolled back a completed addition.

Use `scopeKey` to include the actor/session epoch, group, permission and navigation
scope. A changed key, external close or unmount invalidates and aborts the old
submission; changing the key does not open a picker for the new group. `onClose`
reports cancel, completion or scope invalidation. The supplied `returnFocus`
element (or original focused trigger) is restored after the native dialog closes.
Cancel and selection controls stay disabled during submission, while external
scope invalidation remains available.

Run from the repository root:

```sh
node apps/web/src/features/members/verify-member-picker.mjs
```

The script starts and closes an isolated Vite server and uses synthetic identities
only. Chromium, Firefox and WebKit cover 1440/390/320 px layouts, keyboard traversal,
native modal focus containment/restoration, 44 px controls, search and long names,
reduced viewport height, exclusion/disabled states, multi-select, partial success,
failure/retry and availability/scope changes during requests. Late-response checks
wait for the old request to be consumed, rather than relying on a timeout.
Screenshots are written to ignored `.private-test-results/member-picker/`.
Set `MEMBER_PICKER_ENGINE` to an engine name for focused local iteration; the
default executes all three engines. This fixture proves the component contract;
the application integration still requires its existing Workspace server checks.
