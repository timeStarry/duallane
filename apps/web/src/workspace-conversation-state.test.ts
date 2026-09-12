import { describe, expect, it } from "vitest";
import {
  isWorkspaceBootstrapResponseCurrent,
  isWorkspaceConversationAccessCurrent,
  isWorkspaceConversationListResponseCurrent,
  mergeWorkspaceMessageWindow,
  shouldAdvanceWorkspaceConversationHistoryEpoch,
  type WorkspaceConversationMessageLike
} from "./workspace-conversation-state";

type TestAttachment = NonNullable<WorkspaceConversationMessageLike["attachments"]>[number] & {
  canDownload?: boolean;
  canPreview?: boolean;
};
type TestMessage = Omit<WorkspaceConversationMessageLike, "attachments"> & {
  attachments: TestAttachment[];
  reactions: string[];
};

function message(id: string, overrides: Partial<TestMessage> = {}): TestMessage {
  return {
    id,
    createdAt: "2026-09-07T00:00:00.000Z",
    attachments: [],
    reactions: [],
    ...overrides
  };
}

function messageWindow(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, offset) => message(`history-${String(first + offset).padStart(2, "0")}`));
}

function messageIds(messages: readonly TestMessage[]) {
  return messages.map((item) => item.id);
}

describe("workspace conversation message windows", () => {
  it("rejects a list response after conversation access is revoked", () => {
    expect(isWorkspaceConversationAccessCurrent(7, 7)).toBe(true);
    expect(isWorkspaceConversationAccessCurrent(7, 8)).toBe(false);
  });

  it("accepts only the current bootstrap session and request generation", () => {
    expect(isWorkspaceBootstrapResponseCurrent(4, 4, 9, 9)).toBe(true);
    expect(isWorkspaceBootstrapResponseCurrent(4, 4, 8, 9)).toBe(false);
    expect(isWorkspaceBootstrapResponseCurrent(3, 4, 9, 9)).toBe(false);
  });

  it("ignores a superseded whole-list response before it can remove current conversations", () => {
    const firstRequestToken = 11;
    const latestRequestToken = 12;
    let currentConversationIds = ["conversation-a"];

    const applyListResponse = (requestToken: number, responseIds: string[]) => {
      if (!isWorkspaceConversationListResponseCurrent(requestToken, latestRequestToken)) {
        return;
      }
      currentConversationIds = responseIds;
    };

    applyListResponse(firstRequestToken, []);
    expect(currentConversationIds).toEqual(["conversation-a"]);

    applyListResponse(latestRequestToken, ["conversation-b"]);
    expect(currentConversationIds).toEqual(["conversation-b"]);
  });

  it("lets authoritative requests advance history without making pagination do so", () => {
    expect(shouldAdvanceWorkspaceConversationHistoryEpoch("history", false)).toBe(false);
    expect(shouldAdvanceWorkspaceConversationHistoryEpoch("history", true)).toBe(false);
    expect(shouldAdvanceWorkspaceConversationHistoryEpoch("messages", true)).toBe(true);
    expect(shouldAdvanceWorkspaceConversationHistoryEpoch("around", true)).toBe(true);
  });

  it("does not let a late old 20-message DTO replace the newer local 20-message window", () => {
    const local = messageWindow(8, 27);
    const lateResponse = messageWindow(2, 21);

    expect(messageIds(mergeWorkspaceMessageWindow(local, lateResponse))).toEqual(messageIds(local));
    expect(mergeWorkspaceMessageWindow(local, lateResponse).length).toBe(20);
  });

  it("uses overlapping IDs rather than timestamps to recognize an older window", () => {
    const local = messageWindow(8, 27);
    const lateResponse = messageWindow(2, 21);

    expect(new Set(local.map((item) => item.createdAt)).size).toBe(1);
    expect(messageIds(mergeWorkspaceMessageWindow(local, lateResponse))).toEqual(messageIds(local));
  });

  it("preserves a local unhide when an older response says the message is hidden", () => {
    const baseline = [message("history-08", { hiddenByCurrentUser: true })];
    const local = [message("history-08", { hiddenByCurrentUser: false })];
    const oldIncoming = [message("history-08", { hiddenByCurrentUser: true })];

    const merged = mergeWorkspaceMessageWindow(local, oldIncoming, {
      baselineMessages: baseline,
      requestRevision: 7,
      currentRevision: 8
    });

    expect(merged[0]?.hiddenByCurrentUser).toBe(false);
  });

  it("preserves message state changed after a request while applying no stale revival", () => {
    const baseline = messageWindow(2, 21);
    const local = messageWindow(8, 27);
    local[0] = message("history-08", {
      hiddenByCurrentUser: true,
      reactions: ["local-reaction"],
      attachments: [{ id: "attachment-08", status: "removed", canDownload: false, canPreview: false }]
    });
    const lateResponse = messageWindow(2, 21).map((item) => item.id === "history-08"
      ? message(item.id, { attachments: [{ id: "attachment-08", status: "available", canDownload: true, canPreview: true }] })
      : item);

    const merged = mergeWorkspaceMessageWindow(local, lateResponse, {
      baselineMessages: baseline,
      requestRevision: 7,
      currentRevision: 8
    });
    const message08 = merged.find((item) => item.id === "history-08");

    expect(messageIds(merged)).toEqual(messageIds(local));
    expect(message08?.hiddenByCurrentUser).toBe(true);
    expect(message08?.reactions).toEqual(["local-reaction"]);
    expect(message08?.attachments).toEqual([{
      id: "attachment-08",
      status: "removed",
      canDownload: false,
      canPreview: false
    }]);
  });

  it("accepts an explicit restrictive state for an unchanged overlapping message", () => {
    const baseline = messageWindow(2, 21);
    const local = messageWindow(8, 27);
    const lateResponse = messageWindow(2, 21).map((item) => item.id === "history-08"
      ? message(item.id, { hiddenByCurrentUser: true })
      : item);

    const merged = mergeWorkspaceMessageWindow(local, lateResponse, {
      baselineMessages: baseline,
      requestRevision: 7,
      currentRevision: 8
    });

    expect(merged.find((item) => item.id === "history-08")?.hiddenByCurrentUser).toBe(true);
  });

  it("keeps already loaded history beyond the 20-message conversation-list window", () => {
    const local = messageWindow(1, 40);
    const incoming = messageWindow(21, 40);

    const merged = mergeWorkspaceMessageWindow(local, incoming, { preserveLoadedHistory: true });

    expect(merged.length).toBe(40);
    expect(messageIds(merged)).toEqual(messageIds(local));
  });

  it("accepts a newer authoritative window and never creates an unbounded union", () => {
    const local = messageWindow(8, 27);
    const incoming = messageWindow(18, 37);

    const merged = mergeWorkspaceMessageWindow(local, incoming, {
      baselineMessages: local,
      requestRevision: 4,
      currentRevision: 4,
      preserveLoadedHistory: false
    });

    expect(merged.length).toBe(20);
    expect(messageIds(merged)).toEqual(messageIds(incoming));
  });

  it("keeps loaded history while appending a known continuous newer suffix", () => {
    const local = messageWindow(1, 60);
    const incoming = messageWindow(42, 61);

    const merged = mergeWorkspaceMessageWindow(local, incoming, { preserveLoadedHistory: true });

    expect(merged.length).toBe(61);
    expect(messageIds(merged)).toEqual(messageIds(messageWindow(1, 61)));
  });

  it("replaces the list for an around request instead of retaining unrelated context", () => {
    const local = messageWindow(1, 60);
    const around = messageWindow(42, 61);

    const merged = mergeWorkspaceMessageWindow(local, around, {
      baselineMessages: local,
      requestRevision: 12,
      currentRevision: 12,
      preserveLoadedHistory: false,
      authoritativeWindow: true
    });

    expect(messageIds(merged)).toEqual(messageIds(around));
  });

  it("allows an authoritative retention-shrunk window to remove omitted history", () => {
    const local = messageWindow(1, 20);
    const incoming = messageWindow(2, 20);

    const merged = mergeWorkspaceMessageWindow(local, incoming, {
      baselineMessages: local,
      requestRevision: 12,
      currentRevision: 12,
      preserveLoadedHistory: false,
      authoritativeWindow: true
    });

    expect(messageIds(merged)).toEqual(messageIds(incoming));
    expect(merged.some((item) => item.id === "history-01")).toBe(false);
  });

  it("does not overwrite a current reaction or attachment permission during an authoritative refresh", () => {
    const baseline = messageWindow(42, 61);
    const local = baseline.map((item) => item.id === "history-50"
      ? message(item.id, {
          reactions: ["local-reaction"],
          attachments: [{ id: "attachment-50", status: "available", canDownload: false, canPreview: false }]
        })
      : item);
    const incoming = messageWindow(42, 61).map((item) => item.id === "history-50"
      ? message(item.id, {
          reactions: [],
          attachments: [{ id: "attachment-50", status: "available", canDownload: true, canPreview: true }]
        })
      : item);

    const merged = mergeWorkspaceMessageWindow(local, incoming, {
      baselineMessages: baseline,
      requestRevision: 12,
      currentRevision: 13,
      preserveLoadedHistory: false,
      authoritativeWindow: true
    });
    const message50 = merged.find((item) => item.id === "history-50");

    expect(message50?.reactions).toEqual(["local-reaction"]);
    expect(message50?.attachments).toEqual([{
      id: "attachment-50",
      status: "available",
      canDownload: false,
      canPreview: false
    }]);
  });

  it("retains an actively read older window only for an automatic latest refresh", () => {
    const older = [message("older", { createdAt: "2026-09-07T00:00:00.000Z" })];
    const latest = [message("latest", { createdAt: "2026-09-07T00:10:00.000Z" })];
    expect(messageIds(mergeWorkspaceMessageWindow(older, latest, {
      authoritativeWindow: true,
      preserveOlderReadingHistory: true
    }))).toEqual(["older", "latest"]);
    expect(messageIds(mergeWorkspaceMessageWindow(older, latest, {
      authoritativeWindow: true
    }))).toEqual(["latest"]);
  });

  it("does not restore omitted latest rows or obsolete attachment state while retaining reading history", () => {
    const older = message("older", { createdAt: "2026-09-07T00:00:00.000Z" });
    const baseline = [older, message("first", { createdAt: "2026-09-07T00:10:00.000Z" }),
      message("omitted", { createdAt: "2026-09-07T00:11:00.000Z" }),
      message("changed", { createdAt: "2026-09-07T00:12:00.000Z", attachments: [{ id: "file", status: "available", canDownload: true }] })];
    const local = baseline.map(item => item.id === "changed" ? {
      ...item, hiddenByCurrentUser: true, recalledAt: "2026-09-07T00:13:00.000Z",
      attachments: [{ id: "file", status: "removed", canDownload: false }]
    } : item);
    const merged = mergeWorkspaceMessageWindow(local, [baseline[1], baseline[3]], {
      baselineMessages: baseline, requestRevision: 1, currentRevision: 2,
      authoritativeWindow: true, preserveOlderReadingHistory: true
    });
    expect(messageIds(merged)).toEqual(["older", "first", "changed"]);
    expect(merged[2]).toMatchObject({ hiddenByCurrentUser: true, recalledAt: "2026-09-07T00:13:00.000Z", attachments: [{ id: "file", status: "removed", canDownload: false }] });
    expect(mergeWorkspaceMessageWindow(local, [], { authoritativeWindow: true, preserveOlderReadingHistory: true })).toEqual([]);
  });

  it("applies an authoritative recall without restoring narrowed attachment permissions", () => {
    const baseline = [message("history-50", {
      attachments: [{ id: "attachment-50", status: "available", canDownload: true, canPreview: true }]
    })];
    const local = [message("history-50", {
      reactions: ["local-reaction"],
      attachments: [{ id: "attachment-50", status: "available", canDownload: false, canPreview: false }]
    })];
    const incoming = [message("history-50", {
      recalledAt: "2026-09-07T00:01:00.000Z",
      attachments: [{ id: "attachment-50", status: "available", canDownload: true, canPreview: true }]
    })];

    const merged = mergeWorkspaceMessageWindow(local, incoming, {
      baselineMessages: baseline,
      requestRevision: 4,
      currentRevision: 5,
      authoritativeWindow: true,
      preserveLoadedHistory: false
    });

    expect(merged[0]?.recalledAt).toBe("2026-09-07T00:01:00.000Z");
    expect(merged[0]?.reactions).toEqual([]);
    expect(merged[0]?.attachments).toEqual([{
      id: "attachment-50",
      status: "available",
      canDownload: false,
      canPreview: false
    }]);
  });

  it("keeps an incoming attachment permission narrowing when local state was otherwise updated", () => {
    const baseline = [message("history-50", {
      attachments: [{ id: "attachment-50", status: "available", canDownload: true, canPreview: true }]
    })];
    const local = [message("history-50", {
      reactions: ["local-reaction"],
      attachments: [{ id: "attachment-50", status: "available", canDownload: true, canPreview: true }]
    })];
    const incoming = [message("history-50", {
      attachments: [{ id: "attachment-50", status: "removed", canDownload: false, canPreview: false }]
    })];

    const merged = mergeWorkspaceMessageWindow(local, incoming, {
      baselineMessages: baseline,
      requestRevision: 4,
      currentRevision: 5,
      authoritativeWindow: true,
      preserveLoadedHistory: false
    });

    expect(merged[0]?.reactions).toEqual(["local-reaction"]);
    expect(merged[0]?.attachments).toEqual([{
      id: "attachment-50",
      status: "removed",
      canDownload: false,
      canPreview: false
    }]);
  });

  it("handles a removed attachment that is new to the incoming DTO without reviving local state", () => {
    const baseline = [message("history-50", {
      attachments: [{ id: "attachment-old", status: "available", canDownload: false, canPreview: false }]
    })];
    const local = [message("history-50", {
      attachments: [{ id: "attachment-old", status: "available", canDownload: false, canPreview: false }]
    })];
    const incoming = [message("history-50", {
      attachments: [{ id: "attachment-new", status: "removed", canDownload: true, canPreview: true }]
    })];

    const merged = mergeWorkspaceMessageWindow(local, incoming, {
      baselineMessages: baseline,
      requestRevision: 4,
      currentRevision: 5,
      authoritativeWindow: true,
      preserveLoadedHistory: false
    });

    expect(merged[0]?.attachments).toEqual([{
      id: "attachment-new",
      status: "removed",
      canDownload: true,
      canPreview: true
    }]);
  });

  it("does not re-add a message omitted by a newer overlapping response", () => {
    const local = messageWindow(8, 27);
    const incoming = messageWindow(9, 28);

    const merged = mergeWorkspaceMessageWindow(local, incoming, {
      baselineMessages: local,
      requestRevision: 4,
      currentRevision: 4,
      preserveLoadedHistory: false
    });

    expect(messageIds(merged)).toEqual(messageIds(incoming));
    expect(merged.some((item) => item.id === "history-08")).toBe(false);
  });

  it("ignores a response from an older request generation", () => {
    const local = messageWindow(8, 27);
    const lateResponse = messageWindow(2, 21);

    const merged = mergeWorkspaceMessageWindow(local, lateResponse, {
      baselineMessages: local,
      requestGeneration: 3,
      latestGeneration: 4
    });

    expect(messageIds(merged)).toEqual(messageIds(local));
  });

  it("does not clear the local window for a stale empty response", () => {
    const local = messageWindow(8, 27);

    const merged = mergeWorkspaceMessageWindow(local, [], {
      baselineMessages: local,
      requestGeneration: 3,
      latestGeneration: 4
    });

    expect(messageIds(merged)).toEqual(messageIds(local));
  });

  it("keeps a message added after the request when a same-generation response is empty", () => {
    const local = [message("history-01")];

    const merged = mergeWorkspaceMessageWindow(local, [], {
      baselineMessages: [],
      requestRevision: 7,
      currentRevision: 8,
      requestGeneration: 3,
      latestGeneration: 3,
      authoritativeWindow: true,
      preservePostRequestMessages: true
    });

    expect(messageIds(merged)).toEqual(["history-01"]);
  });

  it("keeps messages appended after an authoritative refresh request", () => {
    const baseline = messageWindow(1, 20);
    const local = [...baseline, message("history-21")];
    const incoming = messageWindow(1, 20);

    const merged = mergeWorkspaceMessageWindow(local, incoming, {
      baselineMessages: baseline,
      requestRevision: 7,
      currentRevision: 8,
      authoritativeWindow: true,
      preserveLoadedHistory: false,
      preservePostRequestMessages: true
    });

    expect(messageIds(merged)).toEqual(messageIds(messageWindow(1, 21)));
  });

  it("keeps a confirmed send newer than a disjoint latest snapshot without appending older history", () => {
    const baseline = [message("around", { createdAt: "2026-09-07T00:00:00.000Z" })];
    const local = [...baseline,
      message("older-page", { createdAt: "2026-09-06T23:59:00.000Z" }),
      message("confirmed", { createdAt: "2026-09-07T00:11:00.000Z" })];
    const incoming = [message("latest", { createdAt: "2026-09-07T00:10:00.000Z" })];
    const merged = mergeWorkspaceMessageWindow(local, incoming, {
      baselineMessages: baseline, requestRevision: 1, currentRevision: 2,
      authoritativeWindow: true, preservePostRequestMessages: true
    });
    expect(messageIds(merged)).toEqual(["latest", "confirmed"]);
  });
});
