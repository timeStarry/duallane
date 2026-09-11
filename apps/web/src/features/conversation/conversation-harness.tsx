import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceChatPanel, type WorkspaceConversationMessage } from "./WorkspaceChatPanel";
import type { WorkspaceComposerDocument } from "../../WorkspaceComposerEditor";
import { initializeAppearance } from "../../ui/theme";
import "../../styles.css";

const messages: WorkspaceConversationMessage[] = [
  { id: "other", author: "安宁", authorId: "a", authorKind: "human", body: "这是另一位成员的消息", at: "12:00", createdAt: "2026-09-11T04:00:00Z" },
  { id: "grouped", author: "安宁", authorId: "a", authorKind: "human", body: "同一个人的连续消息", at: "12:01", createdAt: "2026-09-11T04:01:00Z" },
  { id: "self", author: "林予", authorId: "self", authorKind: "human", body: "自己的消息", self: true, at: "12:03", createdAt: "2026-09-11T04:03:00Z" },
  { id: "reply", author: "安宁", authorId: "a", authorKind: "human", body: "包含引用的回复", at: "12:04", createdAt: "2026-09-11T04:04:00Z", replyTo: { messageId: "self", author: "林予", body: "自己的消息" } },
  { id: "failed", author: "林予", authorId: "self", authorKind: "human", body: "失败后仍保留的原消息", self: true, at: "12:05", createdAt: "2026-09-11T04:05:00Z", localState: "failed", failureReason: "网络中断，请重试原消息" }
];

function Harness() {
  const [mode, setMode] = useState<"group" | "topic" | "readOnly" | "unjoined">("group");
  const [sendBusy, setSendBusy] = useState(false);
  const [draft, setDraft] = useState<WorkspaceComposerDocument>({ source: "保留的草稿", blocks: [{ type: "text", text: "保留的草稿" }] });
  const [replyId, setReplyId] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [scope, setScope] = useState("conversation:a");
  const [replacedId, setReplacedId] = useState("");
  const [unreadBoundary, setUnreadBoundary] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const completeImage = useRef<(() => void) | null>(null);
  const record = (event: string) => setEvents((current) => [...current, event]);
  const readOnly = mode === "readOnly" || mode === "unjoined";
  useEffect(() => {
    const control = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: typeof mode; busy?: boolean; scope?: string; resolveImage?: boolean; replaceId?: string; unreadBoundary?: boolean }>).detail;
      if (detail.mode) setMode(detail.mode);
      if (detail.busy !== undefined) setSendBusy(detail.busy);
      if (detail.scope) setScope(detail.scope);
      if (detail.resolveImage) completeImage.current?.();
      if (detail.replaceId) setReplacedId(detail.replaceId);
      if (detail.unreadBoundary !== undefined) setUnreadBoundary(detail.unreadBoundary);
    };
    window.addEventListener("test:conversation", control);
    return () => window.removeEventListener("test:conversation", control);
  }, []);
  return <main style={{ height: "100dvh", overflow: "hidden" }}>
    <output id="conversation-test-state" hidden>{JSON.stringify({ mode, sendBusy, draft: draft.source, events, scope })}</output>
    <WorkspaceChatPanel scopeKey={scope} title="统一会话组件" subtitle={mode === "group" ? "群聊" : "话题讨论"} currentUserId="self" conversationType="group"
      trailingAction={<button type="button" onClick={() => record("details")}>查看详情</button>}
      banner={mode !== "group" ? <div style={{ padding: 12 }}># 跨端交互讨论</div> : undefined}
      composerContext={mode === "topic" ? <div style={{ paddingBottom: 8 }}>发送到本话题</div> : undefined}
      emptyState={mode === "unjoined" ? <div className="empty-state">加入后参与讨论</div> : undefined}
      hideComposer={mode === "unjoined"} readOnly={readOnly} sendDisabled={sendBusy} composerDisabledReason={readOnly ? "本话题当前只读" : undefined}
      unreadAnchorMessageId="other" unreadAnchorCount={unreadBoundary ? 1 : 0}
      messages={mode === "unjoined" ? [] : messages.map((message) => message.id === replacedId ? { ...message, id: `confirmed-${message.id}`, localState: undefined, failureReason: undefined } : message)} renderMessageContent={(message) => <div className="workspace-message-body" data-native-context>{message.body}</div>}
      messageListRef={list} onMessageListScroll={() => undefined} draft={draft.source} draftDocument={draft} onDraft={setDraft}
      onSend={(event) => { event.preventDefault(); record(`send:${draft.source}`); }}
      onReply={setReplyId} replyTarget={messages.find((message) => message.id === replyId)} onCancelReply={() => setReplyId("")}
      onJumpToMessage={(id) => record(`jump:${id}`)} onCopyMessage={(message) => record(`copy:${message.id}`)} onRetryMessage={(id) => record(`retry:${id}`)}
      mentionMembers={[{ id: "a", displayName: "安宁" }]}
      onStageFiles={mode === "group" ? (files) => record(`files:${files.length}`) : undefined}
      clickImageEmoteToSend
      renderEmotePicker={mode === "group" ? (props) => <div role="dialog" aria-label="合成表情选择"><button type="button" onClick={() => props.onSelect({ kind: "image", id: "image", label: "合成图片表情", token: "[custom:image]", customId: "image", src: "/fixture.png" }, "custom")}>选择合成图片表情</button></div> : undefined}
      onSendImageEmote={mode === "group" ? async () => {
        record("image-start");
        await new Promise<void>((resolve) => { completeImage.current = resolve; });
        record("image-consumed");
      } : undefined}
      onHideMessage={mode === "group" ? (id) => record(`hide:${id}`) : undefined}
      onTogglePin={mode === "group" ? (message) => record(`pin:${message.id}`) : undefined}
      onRecall={mode === "group" ? (message) => record(`recall:${message.id}`) : undefined}
      getMessageActions={(message, defaults) => mode === "topic" && !message.localState ? [...defaults, { id: "sync", label: "同步到群聊", onSelect: () => record(`sync:${message.id}`) }] : defaults}
    />
  </main>;
}

initializeAppearance();
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
