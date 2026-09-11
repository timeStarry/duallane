import { useCallback, useSyncExternalStore } from "react";
import type { WorkspaceComposerDocument } from "../../WorkspaceComposerEditor";
import type { WorkspaceTopicMessage } from "../../WorkspaceTopics";
import type { WorkspaceComposerAttachment } from "../conversation/message-model";

export type TopicPendingMessage = WorkspaceTopicMessage & {
  submission: { draftRevision: number; syncToGroup: boolean; preserveDraft?: boolean };
};

export type TopicSession = {
  conversationId?: string;
  draft: WorkspaceComposerDocument;
  draftRevision: number;
  replyToMessageId: string;
  syncToGroup: boolean;
  pending: Record<string, TopicPendingMessage>;
  scrollTop: number | null;
  nearBottom: boolean;
};

export function emptyTopicDraft(): WorkspaceComposerDocument {
  return { source: "", blocks: [{ type: "text", text: "" }] };
}

/** Owned by one authenticated App session. Nothing here enters browser storage. */
export function createWorkspaceTopicSessionStore() {
  const sessions = new Map<string, TopicSession>();
  const listeners = new Map<string, Set<() => void>>();
  const deliveries = new Set<string>();
  const deliveryKey = (topicId: string, clientMessageId: string) => `${topicId}\u0000${clientMessageId}`;
  function get(topicId: string): TopicSession {
    let session = sessions.get(topicId);
    if (!session) {
      session = { draft: emptyTopicDraft(), draftRevision: 0, replyToMessageId: "", syncToGroup: false, pending: {}, scrollTop: null, nearBottom: true };
      sessions.set(topicId, session);
    }
    return session;
  }
  function update(topicId: string, change: (current: TopicSession) => TopicSession) {
    const current = get(topicId);
    const next = change(current);
    if (next === current) return;
    sessions.set(topicId, next);
    listeners.get(topicId)?.forEach((listener) => listener());
  }
  return {
    get,
    update,
    bindConversation(topicId: string, conversationId: string) {
      update(topicId, (current) => current.conversationId === conversationId ? current : { ...current, conversationId });
    },
    removeConversation(conversationId: string, onCancelAttachments: (attachments: WorkspaceComposerAttachment[]) => void) {
      const removed: string[] = [];
      for (const [topicId, session] of sessions) {
        if (session.conversationId !== conversationId && !Object.values(session.pending).some((message) => message.conversationId === conversationId)) continue;
        const attachments = Object.values(session.pending).flatMap((message) => message.pendingAttachments ?? []);
        onCancelAttachments(attachments);
        attachments.forEach((attachment) => { if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl); });
        Object.keys(session.pending).forEach((id) => deliveries.delete(deliveryKey(topicId, id)));
        sessions.delete(topicId);
        removed.push(topicId);
      }
      removed.forEach((topicId) => listeners.get(topicId)?.forEach((listener) => listener()));
      return removed;
    },
    clear() {
      const previews = new Set([...sessions.values()].flatMap((session) =>
        Object.values(session.pending).flatMap((message) => message.pendingAttachments?.flatMap((attachment) => attachment.previewUrl ? [attachment.previewUrl] : []) ?? [])
      ));
      previews.forEach((preview) => URL.revokeObjectURL(preview));
      sessions.clear();
      deliveries.clear();
      listeners.forEach((topicListeners) => topicListeners.forEach((listener) => listener()));
    },
    hasUnsaved() {
      return [...sessions.values()].some((session) => Boolean(
        session.draft.source.trim() || session.replyToMessageId || Object.keys(session.pending).length ||
        session.draft.blocks.some((block) => block.type !== "text" || block.text.trim())
      ));
    },
    edit(topicId: string, patch: Partial<Pick<TopicSession, "draft" | "replyToMessageId" | "syncToGroup">>) {
      update(topicId, (current) => {
        const changed = (patch.draft !== undefined && JSON.stringify(patch.draft) !== JSON.stringify(current.draft)) ||
          (patch.replyToMessageId !== undefined && patch.replyToMessageId !== current.replyToMessageId) ||
          (patch.syncToGroup !== undefined && patch.syncToGroup !== current.syncToGroup);
        return changed ? { ...current, ...patch, draftRevision: current.draftRevision + 1 } : current;
      });
    },
    enqueue(topicId: string, message: TopicPendingMessage) {
      const clientMessageId = message.clientMessageId;
      if (!clientMessageId || message.topicId !== topicId) return false;
      const current = get(topicId);
      if (current.pending[clientMessageId] || current.draftRevision !== message.submission.draftRevision) return false;
      update(topicId, (session) => ({
        ...session,
        conversationId: message.conversationId ?? session.conversationId,
        pending: { ...session.pending, [clientMessageId]: message },
        draft: message.submission.preserveDraft ? session.draft : emptyTopicDraft(),
        replyToMessageId: "",
        syncToGroup: false,
        draftRevision: session.draftRevision + 1
      }));
      return true;
    },
    claimDelivery(topicId: string, clientMessageId: string) {
      const key = deliveryKey(topicId, clientMessageId);
      const message = get(topicId).pending[clientMessageId];
      if (!message || deliveries.has(key)) return null;
      deliveries.add(key);
      return message;
    },
    finishDelivery(topicId: string, clientMessageId: string) {
      deliveries.delete(deliveryKey(topicId, clientMessageId));
    },
    acknowledge(topicId: string, clientMessageId: string, _draftRevision?: number) {
      update(topicId, (current) => {
        if (!current.pending[clientMessageId]) return current;
        const { [clientMessageId]: _sent, ...pending } = current.pending;
        return { ...current, pending };
      });
    },
    subscribe(topicId: string, listener: () => void) {
      let topicListeners = listeners.get(topicId);
      if (!topicListeners) { topicListeners = new Set(); listeners.set(topicId, topicListeners); }
      topicListeners.add(listener);
      return () => { topicListeners.delete(listener); };
    }
  };
}

export type WorkspaceTopicSessionStore = ReturnType<typeof createWorkspaceTopicSessionStore>;

export function useTopicSession(store: WorkspaceTopicSessionStore, topicId: string) {
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(topicId, listener), [store, topicId]),
    useCallback(() => store.get(topicId), [store, topicId])
  );
}
