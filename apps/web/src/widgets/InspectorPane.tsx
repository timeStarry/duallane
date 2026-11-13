import React, { useEffect, useState } from "react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { Avatar, Button, IconButton, Switch } from "@/shared/ui";

export function InspectorPane() {
  const {
    activeLane,
    inspectorOpen,
    inspectorTab,
    inspectorThreadRootId,
    inspectorFile,
    closeInspector,
  } = useLaneStore();
  const {
    activeConversationId,
    conversations,
    messagesByConv,
    members,
    threadsByRootId,
    loadThread,
    sendThreadReply,
    jumpToMessage,
    togglePinMessage,
  } = useWorkspaceStore();

  const [replyText, setReplyText] = useState("");
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (inspectorOpen && inspectorTab === "thread" && inspectorThreadRootId) {
      void loadThread(inspectorThreadRootId).catch(() => {});
    }
  }, [inspectorOpen, inspectorTab, inspectorThreadRootId, loadThread]);

  if (!inspectorOpen || activeLane !== "workspace") {
    return null;
  }

  const activeConv = activeConversationId ? conversations[activeConversationId] : undefined;
  const messages = activeConversationId ? messagesByConv[activeConversationId] || [] : [];

  const handleThreadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspectorThreadRootId || !replyText.trim()) return;
    setSending(true);
    try {
      await sendThreadReply(inspectorThreadRootId, replyText.trim(), alsoSendToChannel);
      setReplyText("");
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="dl-glass-chrome flex h-full w-[340px] shrink-0 flex-col border-l border-dl-border-hairline">
      <div className="flex items-center justify-between border-b border-dl-border-hairline px-4 py-3">
        <h2 className="text-sm font-semibold text-dl-text-primary">
          {inspectorTab === "thread"
            ? "话题线程"
            : inspectorTab === "file"
            ? "文件预览"
            : "对话详情"}
        </h2>
        <IconButton variant="ghost" onClick={closeInspector} label="关闭检查器">
          ✕
        </IconButton>
      </div>

      {inspectorTab === "thread" && inspectorThreadRootId && (
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {(() => {
              const thread = threadsByRootId[inspectorThreadRootId];
              const localRoot = messages.find((m) => m.id === inspectorThreadRootId);
              const rootText = thread?.root?.plainText || localRoot?.plainText || "正在加载线程…";
              const replies = thread?.replies || [];
              return (
                <>
                  <div className="dl-glass-elevated rounded-2xl border border-dl-border-hairline p-3">
                    <div className="text-[11px] font-medium text-dl-lane-shared mb-1">根消息</div>
                    <div className="text-sm text-dl-text-primary whitespace-pre-wrap">{rootText}</div>
                  </div>
                  <div className="text-[11px] text-dl-text-tertiary px-1">
                    {replies.length} 条线程回复
                  </div>
                  {replies.map((reply) => (
                    <div
                      key={reply.id}
                      className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-3 space-y-1"
                    >
                      <div className="text-[11px] font-medium text-dl-text-secondary">
                        {members[reply.senderId]?.displayName || reply.senderId}
                      </div>
                      <div className="text-sm text-dl-text-primary whitespace-pre-wrap">
                        {reply.plainText}
                      </div>
                    </div>
                  ))}
                </>
              );
            })()}
          </div>

          <form
            onSubmit={handleThreadSubmit}
            className="border-t border-dl-border-hairline p-3 space-y-2.5"
          >
            <div className="flex items-center justify-between text-xs text-dl-text-secondary">
              <span>同时发送到主对话</span>
              <Switch checked={alsoSendToChannel} onCheckedChange={setAlsoSendToChannel} />
            </div>
            <div className="flex items-center gap-2">
              <input
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="在线程中回复…"
                className="flex-1 rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/60 px-3 py-1.5 text-sm text-dl-text-primary focus:outline-none"
              />
              <Button type="submit" size="sm" variant="primary" busy={sending} disabled={!replyText.trim()}>
                回复
              </Button>
            </div>
          </form>
        </div>
      )}

      {inspectorTab === "details" && activeConv && (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div>
            <div className="text-xs font-semibold text-dl-text-secondary mb-2">
              置顶消息 ({activeConv.pinnedMessageIds.length})
            </div>
            {activeConv.pinnedMessageIds.length === 0 ? (
              <div className="text-xs text-dl-text-tertiary">暂无置顶消息</div>
            ) : (
              <div className="space-y-2">
                {activeConv.pinnedMessageIds.map((id) => {
                  const msg = messages.find((m) => m.id === id);
                  return (
                    <div
                      key={id}
                      className="rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/50 p-2.5 text-xs space-y-1.5"
                    >
                      <div className="text-dl-text-primary line-clamp-2">
                        {msg?.plainText || `消息 #${id}`}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => jumpToMessage(activeConv.id, id)}
                        >
                          定位
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => void togglePinMessage(activeConv.id, id)}
                        >
                          取消置顶
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold text-dl-text-secondary mb-2">
              成员列表 ({activeConv.memberIds.length})
            </div>
            <div className="space-y-1.5">
              {activeConv.memberIds.map((id) => {
                const m = members[id];
                return (
                  <div key={id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
                    <Avatar name={m?.displayName || id} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-dl-text-primary">
                        {m?.displayName || id}
                      </div>
                      <div className="text-[11px] text-dl-text-tertiary">
                        {m?.role === "bot" ? "机器人" : m?.role === "owner" ? "所有者" : "成员"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {inspectorTab === "file" && inspectorFile && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="dl-glass-elevated rounded-2xl border border-dl-border-hairline p-4 text-center space-y-2">
            <div className="text-3xl">📎</div>
            <div className="text-sm font-semibold text-dl-text-primary break-all">
              {inspectorFile.fileName}
            </div>
            <div className="text-xs text-dl-text-tertiary">{inspectorFile.mimeType}</div>
          </div>

          {inspectorFile.sourceMessageId && inspectorFile.conversationId && (
            <Button
              variant="primary"
              size="sm"
              className="w-full"
              onClick={() =>
                jumpToMessage(inspectorFile.conversationId!, inspectorFile.sourceMessageId!)
              }
            >
              在对话中定位原消息
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
