export type WorkspaceConversationMessageLike = {
  id: string;
  clientMessageId?: string | null;
  createdAt?: string | null;
  recalledAt?: string | null;
  deletedAt?: string | null;
  hiddenByCurrentUser?: boolean;
  attachments?: readonly WorkspaceConversationAttachmentLike[];
};

export type WorkspaceConversationAttachmentLike = {
  id: string;
  status?: string;
};

export type WorkspaceMessageWindowMergeContext<T extends WorkspaceConversationMessageLike> = {
  baselineMessages?: readonly T[];
  requestRevision?: number;
  currentRevision?: number;
  requestGeneration?: number;
  latestGeneration?: number;
  preserveLoadedHistory?: boolean;
  authoritativeWindow?: boolean;
  preservePostRequestMessages?: boolean;
  preserveOlderReadingHistory?: boolean;
};

export type WorkspaceConversationMessageRequestKind =
  | "list"
  | "messages"
  | "around"
  | "read"
  | "history";

export function isWorkspaceConversationListResponseCurrent(
  requestToken: number,
  latestToken: number
) {
  return requestToken === latestToken;
}

export function isWorkspaceConversationAccessCurrent(
  requestAccessEpoch: number,
  latestAccessEpoch: number
) {
  return requestAccessEpoch === latestAccessEpoch;
}

export function isWorkspaceBootstrapResponseCurrent(
  requestSessionEpoch: number,
  latestSessionEpoch: number,
  requestGeneration: number,
  latestGeneration: number
) {
  return requestSessionEpoch === latestSessionEpoch && requestGeneration === latestGeneration;
}

export function shouldAdvanceWorkspaceConversationHistoryEpoch(
  kind: WorkspaceConversationMessageRequestKind,
  invalidatesHistory: boolean
) {
  return invalidatesHistory && (kind === "messages" || kind === "around");
}

type MessageWindowRelation =
  | "incoming-older"
  | "incoming-newer"
  | "incoming-contained"
  | "incoming-contains"
  | "overlap"
  | "disjoint";

function messageKey(message: WorkspaceConversationMessageLike) {
  return message.id || (message.clientMessageId ? `client:${message.clientMessageId}` : "");
}

function messageIndex<T extends WorkspaceConversationMessageLike>(messages: readonly T[]) {
  return new Map(messages.map((message, index) => [messageKey(message), index]));
}

function messageWindowRelation<T extends WorkspaceConversationMessageLike>(
  local: readonly T[],
  incoming: readonly T[]
): MessageWindowRelation {
  if (local.length === 0 || incoming.length === 0) {
    return "disjoint";
  }
  const localIndexes = messageIndex(local);
  const incomingIndexes = messageIndex(incoming);
  const commonKeys = incoming
    .map(messageKey)
    .filter((key) => key && localIndexes.has(key));
  if (commonKeys.length === 0) {
    return "disjoint";
  }

  const incomingLastKey = messageKey(incoming[incoming.length - 1]);
  const incomingLastLocalIndex = localIndexes.get(incomingLastKey);
  if (incomingLastLocalIndex !== undefined && incomingLastLocalIndex < local.length - 1) {
    return "incoming-older";
  }

  const localLastKey = messageKey(local[local.length - 1]);
  const localLastIncomingIndex = incomingIndexes.get(localLastKey);
  if (localLastIncomingIndex !== undefined && localLastIncomingIndex < incoming.length - 1) {
    return "incoming-newer";
  }

  if (local.length > incoming.length && commonKeys.length === incoming.length) {
    return "incoming-contained";
  }
  if (incoming.length > local.length && commonKeys.length === local.length) {
    return "incoming-contains";
  }
  return "overlap";
}

function mergeAttachmentViews(
  localAttachments: readonly WorkspaceConversationAttachmentLike[],
  incomingAttachments: readonly WorkspaceConversationAttachmentLike[]
) {
  const permissionFields = ["canDownload", "canPreview", "canRemove"] as const;
  return incomingAttachments.map((incomingAttachment) => {
    const localAttachment = localAttachments.find((attachment) => attachment.id === incomingAttachment.id);
    if (!localAttachment) return incomingAttachment;
    const status = localAttachment.status === "removed" || incomingAttachment.status === "removed"
      ? "removed"
      : localAttachment.status;
    const mergedAttachment = { ...incomingAttachment, ...localAttachment, status } as WorkspaceConversationAttachmentLike & Record<string, unknown>;
    for (const field of permissionFields) {
      const localPermission = (localAttachment as Record<string, unknown>)[field];
      const incomingPermission = (incomingAttachment as Record<string, unknown>)[field];
      if (typeof localPermission === "boolean" && typeof incomingPermission === "boolean") {
        mergedAttachment[field] = localPermission && incomingPermission;
      } else if (typeof incomingPermission === "boolean") {
        mergedAttachment[field] = incomingPermission;
      } else if (typeof localPermission === "boolean") {
        mergedAttachment[field] = localPermission;
      }
    }
    return mergedAttachment;
  });
}

function mergedHiddenState(
  local: WorkspaceConversationMessageLike,
  incoming: WorkspaceConversationMessageLike,
  baseline?: WorkspaceConversationMessageLike
) {
  const localHidden = local.hiddenByCurrentUser === true;
  const baselineHidden = baseline?.hiddenByCurrentUser === true;
  const localHiddenChanged = baseline === undefined || localHidden !== baselineHidden;
  return localHiddenChanged
    ? local.hiddenByCurrentUser
    : incoming.hiddenByCurrentUser ?? local.hiddenByCurrentUser;
}

function mergePreservedLocalMessage<T extends WorkspaceConversationMessageLike>(
  local: T,
  incoming: T,
  baseline?: T
) {
  if (incoming.recalledAt || incoming.deletedAt) {
    const next = {
      ...local,
      ...incoming,
      hiddenByCurrentUser: mergedHiddenState(local, incoming, baseline)
    } as T;
    if (local.attachments && incoming.attachments) {
      next.attachments = mergeAttachmentViews(local.attachments, incoming.attachments);
    }
    return next;
  }

  const next = {
    ...local,
    hiddenByCurrentUser: mergedHiddenState(local, incoming, baseline)
  } as T;
  if (local.attachments && incoming.attachments) {
    return {
      ...next,
      attachments: mergeAttachmentViews(local.attachments, incoming.attachments)
    } as T;
  }
  return next;
}

function mergeKeepingLocalWindow<T extends WorkspaceConversationMessageLike>(
  local: readonly T[],
  incoming: readonly T[],
  options: WorkspaceMessageWindowMergeContext<T>,
  relation: MessageWindowRelation,
  preserveAllLocal: boolean
) {
  const incomingByKey = new Map(incoming.map((message) => [messageKey(message), message]));
  const baselineByKey = new Map((options.baselineMessages ?? []).map((message) => [messageKey(message), message]));
  const preserveLoadedHistory = options.preserveLoadedHistory !== false &&
    local.length > incoming.length && relation !== "disjoint";
  return local
    .filter((message) => {
      if (incomingByKey.has(messageKey(message))) return true;
      if (preserveAllLocal || preserveLoadedHistory || !options.baselineMessages) return true;
      return !baselineByKey.has(messageKey(message));
    })
    .map((message) => {
      const incomingMessage = incomingByKey.get(messageKey(message));
      if (!incomingMessage) return message;
      const baselineMessage = baselineByKey.get(messageKey(message));
      const changedAfterRequest = !options.baselineMessages ||
        !baselineByKey.has(messageKey(message)) ||
        baselineMessage !== message;
      return preserveAllLocal || changedAfterRequest
        ? mergePreservedLocalMessage(message, incomingMessage, baselineMessage)
        : incomingMessage;
    });
}

function mergeLoadedHistoryWithNewerWindow<T extends WorkspaceConversationMessageLike>(
  local: readonly T[],
  incoming: readonly T[],
  options: WorkspaceMessageWindowMergeContext<T>,
  relation: MessageWindowRelation
) {
  const incomingIndexes = messageIndex(incoming);
  const localIndexes = messageIndex(local);
  const localLastKey = messageKey(local[local.length - 1]);
  const localLastIncomingIndex = incomingIndexes.get(localLastKey);
  if (localLastIncomingIndex === undefined) {
    return null;
  }
  const incomingPrefix = incoming.slice(0, localLastIncomingIndex + 1);
  if (!incomingPrefix.every((message) => localIndexes.has(messageKey(message)))) {
    return null;
  }

  const mergedLocal = mergeKeepingLocalWindow(local, incoming, options, relation, false);
  const mergedKeys = new Set(mergedLocal.map(messageKey));
  const incomingSuffix = incoming
    .slice(localLastIncomingIndex + 1)
    .filter((message) => !mergedKeys.has(messageKey(message)));
  return [...mergedLocal, ...incomingSuffix];
}

function mergeIncomingWindow<T extends WorkspaceConversationMessageLike>(
  local: readonly T[],
  incoming: readonly T[],
  options: WorkspaceMessageWindowMergeContext<T>,
  preserveChangedLocalState: boolean
) {
  if (!preserveChangedLocalState) {
    return [...incoming];
  }
  const localByKey = new Map(local.map((message) => [messageKey(message), message]));
  const baselineByKey = new Map((options.baselineMessages ?? []).map((message) => [messageKey(message), message]));
  return incoming.map((incomingMessage) => {
    const localMessage = localByKey.get(messageKey(incomingMessage));
    if (!localMessage) return incomingMessage;
    const baselineMessage = baselineByKey.get(messageKey(incomingMessage));
    const changedAfterRequest = !options.baselineMessages ||
      !baselineByKey.has(messageKey(incomingMessage)) ||
      baselineMessage !== localMessage;
    return changedAfterRequest
      ? mergePreservedLocalMessage(localMessage, incomingMessage, baselineMessage)
      : incomingMessage;
  });
}

function preservePostRequestMessages<T extends WorkspaceConversationMessageLike>(
  local: readonly T[],
  options: WorkspaceMessageWindowMergeContext<T>
) {
  const baselineKeys = new Set((options.baselineMessages ?? []).map(messageKey));
  return local.filter((message) => !baselineKeys.has(messageKey(message)));
}

function appendPostRequestMessages<T extends WorkspaceConversationMessageLike>(
  merged: readonly T[],
  local: readonly T[],
  incoming: readonly T[],
  options: WorkspaceMessageWindowMergeContext<T>
) {
  if (incoming.length === 0) {
    return preservePostRequestMessages(local, options);
  }
  const localIndexes = messageIndex(local);
  const incomingKeys = new Set(incoming.map(messageKey));
  const baselineKeys = new Set((options.baselineMessages ?? []).map(messageKey));
  const incomingLastLocalIndex = localIndexes.get(messageKey(incoming[incoming.length - 1]));
  if (incomingLastLocalIndex === undefined) {
    // Around-history and the latest window can be disjoint. A send confirmed
    // after this request is still newer than its snapshot even without an
    // overlapping ID; unrelated older history must not be appended here.
    const newestIncomingTime = Date.parse(incoming[incoming.length - 1].createdAt ?? "");
    const concurrentSuffix = local.filter((message) => {
      const key = messageKey(message);
      return !baselineKeys.has(key) && !incomingKeys.has(key) &&
        Date.parse(message.createdAt ?? "") >= newestIncomingTime;
    });
    return [...merged, ...concurrentSuffix];
  }
  const concurrentSuffix = local.slice(incomingLastLocalIndex + 1).filter((message) => {
    const key = messageKey(message);
    return !baselineKeys.has(key) && !incomingKeys.has(key);
  });
  return [...merged, ...concurrentSuffix];
}

// Keep this small function separate from the React store so the ordering
// contract can be tested without mounting the application. Normal refreshes
// retain overlapping history; an automatic latest recovery can additionally
// keep the current older window if the user has resumed reading it.
export function mergeWorkspaceMessageWindow<T extends WorkspaceConversationMessageLike>(
  local: readonly T[],
  incoming: readonly T[],
  options: WorkspaceMessageWindowMergeContext<T> = {}
) {
  const relation = messageWindowRelation(local, incoming);
  const responseIsStale = options.requestGeneration !== undefined &&
    options.latestGeneration !== undefined &&
    options.latestGeneration > options.requestGeneration;
  const localRevisionChanged = options.requestRevision !== undefined &&
    options.currentRevision !== undefined &&
    options.currentRevision !== options.requestRevision;
  const preservePostRequest = options.preservePostRequestMessages ?? !options.authoritativeWindow;

  if (responseIsStale) {
    return mergeKeepingLocalWindow(local, incoming, options, relation, true);
  }
  if (incoming.length === 0) {
    return localRevisionChanged && preservePostRequest
      ? preservePostRequestMessages(local, options)
      : [];
  }
  if (local.length === 0) return [...incoming];
  if (options.authoritativeWindow) {
    const merged = mergeIncomingWindow(local, incoming, options, localRevisionChanged);
    const latestWindow = localRevisionChanged && preservePostRequest
      ? appendPostRequestMessages(merged, local, incoming, options)
      : merged;
    if (options.preserveOlderReadingHistory) {
      // Automatic return-to-latest may finish after the reader scrolls away.
      // Retain only current rows older than this authoritative latest window;
      // omissions within it still expire, and removed local rows stay removed.
      const oldestIncomingTime = Date.parse(incoming[0].createdAt ?? "");
      const latestKeys = new Set(latestWindow.map(messageKey));
      const olderHistory = local.filter((message) =>
        !latestKeys.has(messageKey(message)) &&
        Date.parse(message.createdAt ?? "") < oldestIncomingTime
      );
      return [...olderHistory, ...latestWindow];
    }
    return latestWindow;
  }
  if (
    relation === "incoming-newer" &&
    options.preserveLoadedHistory !== false &&
    local.length > incoming.length
  ) {
    const merged = mergeLoadedHistoryWithNewerWindow(local, incoming, options, relation);
    if (merged) return merged;
  }
  if (
    relation === "incoming-older" ||
    (relation === "incoming-contained" && options.preserveLoadedHistory !== false) ||
    (options.preserveLoadedHistory !== false && local.length > incoming.length && relation !== "disjoint")
  ) {
    return mergeKeepingLocalWindow(local, incoming, options, relation, false);
  }

  return mergeIncomingWindow(local, incoming, options, localRevisionChanged);
}
