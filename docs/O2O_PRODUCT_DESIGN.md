# O2O Private Direct Product Design

## 1. Product Definition

**External name:** 私密直连

**English working name:** One-to-One Direct / O2O Private Direct

私密直连是 DualLane 的临时一对一通道。它适合两个人快速交换消息或文件，不需要登录，不创建长期账号关系，服务器不保存会话内容。

The product promise is narrow and concrete:

> A private one-to-one session where the server helps two browsers find each other but does not store the conversation content.

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
- The server may relay validated signaling data.
- WebSocket fallback may carry encrypted envelopes only, never plaintext chat payloads.
- Message and file content must not be persisted by the server.
- Local save is user-controlled and happens only in the browser or exported local files.

Safe external copy:

- "服务器不保存会话内容。"
- "邀请链接里的密钥只留在浏览器。"
- "会话结束后，可选择是否保存到本机。"

Avoid stronger claims unless implemented and verified:

- Do not claim full end-to-end encryption with identity verification.
- Do not claim that network relays can never see encrypted traffic metadata.
- Do not claim permanent recoverability.

## 4. Core Flow

1. User chooses **私密直连** from the entry screen.
2. User enters a display name.
3. User starts a session.
4. Browser creates session key material and an invite link.
5. User shares the full invite link outside DualLane.
6. The other person opens the link.
7. Both browsers establish a WebRTC DataChannel when possible.
8. The chat surface opens for messages and file transfer.
9. If direct connection fails, the app may use encrypted WebSocket fallback where available.
10. When the session ends, users choose whether to save the transcript locally.

## 5. User-Facing Surfaces

Entry card:

- Label: `私密直连`
- Short copy: `无需登录，和一个人临时聊天或传文件。服务器不保存会话内容。`
- Primary action: `开始直连`

Setup screen:

- Display name input.
- Start button.
- Brief privacy note.

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
- End session action.

End screen:

- Text: `本次直连已结束。`
- Primary action: `保存到本机`
- Secondary action: `不保存并关闭`

## 6. Expected Member Experience

The private direct lane should feel fast and focused:

- One screen per step.
- No settings panels unless needed for recovery.
- No account language.
- No workspace or admin terminology.
- Clear connection state when waiting, connected, reconnecting, failed, or ended.

If a user tries to do something outside this lane's strengths, suggest shared spaces without implying failure:

- Large file copy: `大文件更适合上传到共享空间，便于稍后重新下载。`
- Persistent group need: `多人共享和长期保留可使用共享空间。`
- Offline recipient: `直连需要双方同时在线。需要稍后查看的内容可放入共享空间。`

## 7. Functional Requirements

MVP:

- Create one-to-one direct rooms.
- Join by invite link.
- Enforce the one-to-one participant limit.
- Exchange text messages over WebRTC DataChannel.
- Transfer files over WebRTC DataChannel.
- Encrypt fallback envelopes if WebSocket fallback is used.
- Show connection and transfer state.
- End session.
- Offer local save at session end.
- Keep server-side content persistence out of the private lane.

Later:

- Better local transcript export.
- Key verification.
- Optional TURN configuration with careful copy.
- Resume-friendly file transfer if feasible without changing the trust model.

## 8. Non-Functional Requirements

- Works on desktop and mobile widths.
- Handles reloads and reconnect attempts clearly.
- Does not log plaintext message or file content.
- Does not send `#k=` fragments to backend APIs.
- Keeps Fastify log redaction intact.
- Keeps server-side signaling state short-lived.

## 9. Validation Checklist

- Create a session and join from a second browser profile.
- Confirm invite-link `#k=` fragment is not sent to backend APIs.
- Send text messages.
- Transfer files.
- Test peer disconnect and reconnect copy.
- End the session and verify local-save prompt.
- Verify no private direct message/file content appears in SQLite, logs, or shared-space tables.
- Verify WebSocket fallback carries encrypted envelopes only.
