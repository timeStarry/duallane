# O2O Private Direct Product Design

> Current AppV1 uses end-to-end encrypted WebSocket relay only. This replaces the
> earlier WebRTC-first/fallback transport plan. The browser-only invitation key,
> server no-content-persistence boundary, and separation from Workspace remain
> binding. Earlier UI specifications and retained browser tests are historical
> where they require WebRTC or a local transcript-save flow.

## 1. Product Definition

**External name:** 私密直连

**English working name:** One-to-One Direct / O2O Private Direct

私密直连是 DualLane 的临时一对一通道。它适合两个人快速交换消息或文件，不需要登录，不创建长期账号关系，服务器不保存会话内容。

The product promise is narrow and concrete:

> A private one-to-one session where browsers encrypt messages and files before server relay, and the server does not store conversation content.

This lane is for temporary exchange. It is not a group chat, not a cloud archive, and not a workspace replacement.

## 2. Target Users And Situations

Target users:

- Two people who need a quick private session without account setup.
- Friends or partners exchanging temporary information.
- A user sending a file directly to one trusted person.
- Self-hosted operators who want a private lane distinct from server-retained shared spaces.

Best-fit situations:

- "Send this file to you now."
- "Let's talk briefly without creating a room."
- "This does not need to be kept in a shared history."
- "I only need one other person in this session."

Poor-fit situations:

- Long-running group discussion.
- Files that need later recovery from the server.
- Shared history for multiple people.
- Administrative or accountable operations.

## 3. Trust Model

The private direct lane has a different trust model from shared spaces:

- No login is required.
- Invite links include browser-only secrets in `#k=` fragments.
- The server must not receive invite-link secret fragments.
- The server manages short-lived room/presence metadata and relays validated secure envelopes.
- WebSocket relay carries browser-encrypted content only, never plaintext chat or file payloads.
- Message and file content must not be persisted by the server.
- Room keys, messages, drafts, and received files stay in browser memory; they are not written to IndexedDB or local storage.
- A recipient may explicitly download a received file. The current UI does not save or export transcripts.

Safe external copy:

- "服务器不保存会话内容。"
- "邀请链接里的密钥只留在浏览器。"
- "消息和文件在浏览器端加密，服务器只转发密文。"
- "退出房间后，本页中的会话内容会清除。"

Avoid stronger claims unless implemented and verified:

- Do not claim independent peer identity verification: possession of the complete invite link grants the shared encryption key.
- Do not claim that network relays can never see encrypted traffic metadata.
- Do not claim that content bypasses the server or uses a WebRTC direct connection.
- Do not claim permanent recoverability.

## 4. Core Flow

1. User chooses **私密直连** from the entry screen.
2. Browser generates a random 32-byte key and creates a two-person room.
3. The waiting/chat surface opens and presents the complete invite link.
4. User shares that link outside DualLane, including its browser-only `#k=` fragment.
5. The other person opens the link; the browser validates/imports the key before connecting.
6. Both browsers connect to the room's Go WebSocket relay.
7. Text, file metadata, file chunks, and delivery acknowledgements are AES-GCM encrypted before relay and decrypted only in the receiving browser.
8. A recipient may explicitly download a received file.
9. Returning to the conversation list preserves the active room and draft in the same running page.
10. Explicitly leaving closes the socket, removes the fragment from the current URL, and clears the local key, messages, draft, and file Blob references.

## 5. User-Facing Surfaces

Entry card:

- Label: `私密直连`
- Short copy: `无需登录，和一个人临时聊天或传文件。服务器不保存会话内容。`
- Primary action: `开始直连`

Entry behavior:

- Starting private direct creates the room immediately; no separate display-name form.
- The sender name is the current member's display name when available, otherwise `直连节点`.

Waiting screen:

- Invite link copy action.
- Connection status.
- Clear warning that the complete link must be shared.
- Short explanation that the secret part after `#k=` is only used in the browser.

Chat screen:

- Trust-mode badge: `私密直连`
- Peer status.
- Message list.
- Composer.
- File picker.
- Transfer progress.
- Explicit leave-room action.
- Honest delivery state: waiting for peer, sending encrypted content, sent, acknowledged, or failed.

Leave and failure behavior:

- Leaving clears this browser's in-memory session without a transcript-save prompt.
- Closed sockets show a disconnected state; the UI does not automatically reconnect or restore the previous transcript.
- Room-not-found, room-full, and key-mismatch states give safe recovery guidance.

## 6. Expected Member Experience

The private direct lane should feel fast and focused:

- Continuous invite, waiting, and chat surface.
- No settings panels unless needed for recovery.
- No account language.
- No workspace or admin terminology.
- Clear connection state when connecting, waiting, connected, disconnected, or failed.

If a user tries to do something outside this lane's strengths, suggest shared spaces without implying failure:

- Large file copy: `大文件更适合上传到共享空间，便于稍后重新下载。`
- Persistent group need: `多人共享和长期保留可使用共享空间。`
- Offline recipient: `直连需要双方同时在线。需要稍后查看的内容可放入共享空间。`

## 7. Functional Requirements

Current AppV1 requirements:

- Create one-to-one direct rooms.
- Join by invite link.
- Enforce the one-to-one participant limit.
- Exchange text messages through end-to-end encrypted WebSocket envelopes.
- Transfer files through the same encrypted relay, with an 8 MiB per-file browser-memory limit.
- Keep file names, metadata, chunks, and acknowledgements inside encrypted envelopes.
- Never send the fragment key in HTTP requests, socket URLs, telemetry, or logs.
- Reject malformed keys before opening the room socket; a different valid key cannot decrypt the peer's content.
- Show connection and transfer state.
- Leave the room and clear its local session state.
- Offer explicit download of received files, without automatic transcript persistence.
- Keep server-side content persistence out of the private lane.

Later:

- Opt-in local transcript export.
- Key verification.
- Any future WebRTC/ICE/TURN transport requires a separate design and acceptance update.
- Resume-friendly file transfer if feasible without changing the trust model.

## 8. Non-Functional Requirements

- Works on desktop and mobile widths.
- Handles socket closure and explicit rejoining clearly without promising automatic recovery.
- Does not log plaintext message or file content.
- Does not send `#k=` fragments to backend APIs.
- Keeps Go logging redaction intact.
- Keeps server-side room/presence state short-lived and separate from Workspace storage.
- Uses HTTPS/WSS in production; relay availability is required for communication.

## 9. Validation Checklist

- Create a session and join from a second browser profile.
- Confirm invite-link `#k=` fragment is not sent to backend APIs.
- Send text messages.
- Transfer files.
- Test peer disconnect and safe connection-loss copy.
- Leave the room and verify local state and the current URL fragment are cleared.
- Verify no private direct message/file content appears in PostgreSQL, logs, or shared-space tables.
- Verify all chat/file WebSocket frames are validated encrypted envelopes, including when WebRTC APIs are unavailable.
- Verify malformed keys never open a room socket and different valid keys cannot decrypt each other.
- Verify reading older messages is not interrupted by incoming messages and IME confirmation does not send prematurely.

The current browser gates are documented in
[Testing and release](development/TESTING_AND_RELEASE.md#3-browser-tests).
Legacy WebRTC recovery and transcript-save cases describe retired behavior and
are not evidence for the current transport.
