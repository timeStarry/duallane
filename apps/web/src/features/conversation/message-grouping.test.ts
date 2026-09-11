import { describe, expect, it } from "vitest";
import type { WorkspaceConversationMessage } from "./contracts";
import { getMessageGroupPositions } from "./message-grouping";

const message = (index: number, patch: Partial<WorkspaceConversationMessage> = {}): WorkspaceConversationMessage => ({
  id: `m${index}`, author: "林遥", authorId: "u1", authorKind: "human", self: true,
  body: `短消息 ${index}`, at: "12:00", createdAt: new Date(2026, 8, 11, 12, index).toISOString(), ...patch
});

describe("continuous message surfaces", () => {
  it("gives a run only two outer rounded edges while keeping isolated messages whole", () => {
    expect(getMessageGroupPositions([])).toEqual([]);
    expect(getMessageGroupPositions([message(0)])).toEqual(["single"]);
    expect(getMessageGroupPositions([message(0), message(1), message(2), message(3, { authorId: "u2" })]))
      .toEqual(["start", "middle", "end", "single"]);
  });

  it("uses stable author identity, never a matching display name", () => {
    expect(getMessageGroupPositions([message(0), message(1, { authorId: "u2" })])).toEqual(["single", "single"]);
    expect(getMessageGroupPositions([message(0), message(1, { author: "新昵称" })])).toEqual(["start", "end"]);
    expect(getMessageGroupPositions([message(0, { authorId: undefined }), message(1, { authorId: undefined })])).toEqual(["single", "single"]);
    expect(getMessageGroupPositions([message(0), message(1, { self: false })])).toEqual(["single", "single"]);
    expect(getMessageGroupPositions([message(0), message(1, { authorKind: "bot" })])).toEqual(["single", "single"]);
  });

  it("breaks both edges around replies, hidden entries, recalled messages and system notices", () => {
    const boundaries: Partial<WorkspaceConversationMessage>[] = [
      { replyTo: { messageId: "original", author: "成员", body: "被回复的内容" } },
      { replyToMessageId: "outside-current-history" },
      { hiddenByCurrentUser: true }, { recalledAt: "2026-09-11T04:00:00Z" }, { authorKind: "system" }
    ];
    for (const boundary of boundaries) {
      expect(getMessageGroupPositions([message(0), message(1), message(2, boundary), message(3), message(4)]))
        .toEqual(["start", "end", "single", "start", "end"]);
    }
  });

  it("starts a new group after an unread divider, including within a same-author run", () => {
    const messages = [message(0), message(1), message(2), message(3)];
    expect(getMessageGroupPositions(messages, 2)).toEqual(["start", "end", "start", "end"]);
    expect(getMessageGroupPositions(messages, 0)).toEqual(["start", "middle", "middle", "end"]);
  });

  it("keeps the five-minute window but splits dates, reversed time and unknown timestamps", () => {
    expect(getMessageGroupPositions([message(0), message(5)])).toEqual(["start", "end"]);
    expect(getMessageGroupPositions([message(0), message(6)])).toEqual(["single", "single"]);
    expect(getMessageGroupPositions([message(1), message(0)])).toEqual(["single", "single"]);
    for (const createdAt of [undefined, "invalid"]) expect(getMessageGroupPositions([message(0), message(1, { createdAt })])).toEqual(["single", "single"]);
    expect(getMessageGroupPositions([
      message(0, { createdAt: new Date(2026, 8, 11, 23, 59).toISOString() }),
      message(1, { createdAt: new Date(2026, 8, 12, 0, 0).toISOString() })
    ])).toEqual(["single", "single"]);
  });

  it("updates edges after append, hide and restore without changing message identities", () => {
    const original = [message(0), message(1), message(2)];
    expect(getMessageGroupPositions(original.slice(0, 2))).toEqual(["start", "end"]);
    expect(getMessageGroupPositions(original)).toEqual(["start", "middle", "end"]);
    expect(getMessageGroupPositions(original.map((entry, index) => index === 1 ? { ...entry, hiddenByCurrentUser: true } : entry))).toEqual(["single", "single", "single"]);
    expect(getMessageGroupPositions(original)).toEqual(["start", "middle", "end"]);
    expect(original.map((entry) => entry.id)).toEqual(["m0", "m1", "m2"]);
  });
});
