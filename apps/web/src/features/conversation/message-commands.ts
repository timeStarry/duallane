import type { WorkspaceMessage, WorkspaceReactionGroup } from "./message-model";

type JsonTransport = <T>(path: string, options?: RequestInit) => Promise<T>;

/** The object command contract is independent of where a message is displayed.
 * The server resolves its conversation/topic and checks current access. */
export function createWorkspaceMessageCommands(json: JsonTransport) {
  return {
    recall(messageId: string) {
      return json<{ message: WorkspaceMessage }>(`/api/workspace/messages/${encodeURIComponent(messageId)}/recall`, { method: "POST" });
    },
    setHidden(messageId: string, hidden: boolean) {
      return json(`/api/workspace/messages/${encodeURIComponent(messageId)}/hidden`, { method: hidden ? "PUT" : "DELETE" });
    },
    setPinned(conversationId: string, messageId: string, pinned: boolean) {
      return json(`/api/workspace/groups/${encodeURIComponent(conversationId)}/pins${pinned ? "" : `/${encodeURIComponent(messageId)}`}`, {
        method: pinned ? "POST" : "DELETE",
        ...(pinned ? { body: JSON.stringify({ messageId }) } : {})
      });
    },
    setReaction(messageId: string, emoteKey: string, reacted: boolean) {
      return json<{ messageId: string; reactions: WorkspaceReactionGroup[] }>(`/api/workspace/messages/${encodeURIComponent(messageId)}/reactions${reacted ? "" : `/${encodeURIComponent(emoteKey)}`}`, {
        method: reacted ? "POST" : "DELETE",
        ...(reacted ? { body: JSON.stringify({ emoteKey }) } : {})
      });
    }
  };
}
