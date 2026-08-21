import { describe, expect, it } from "vitest";
import {
  advanceWorkspaceTopicRefreshSignal,
  isTopicMessageListNearBottom,
  mergeWorkspaceTopicMessages,
  shouldAcknowledgeTopicMessages,
  topicRefreshVersionForConversation,
  topicRefreshVersionForList,
  topicRefreshVersionForTopic,
  workspaceTopicMobilePane,
  type WorkspaceTopicMember,
  type WorkspaceTopicRefreshSignal
} from "./WorkspaceTopics";

const refreshSignal: WorkspaceTopicRefreshSignal = {
  version: 7,
  listVersion: 7,
  topicVersions: { "topic-1": 7 },
  conversationVersions: { "conversation-1": 7 }
};

describe("workspace topic UI behavior", () => {
  it("merges background snapshots without replacing unchanged message rows", () => {
    const first = {
      id: "message-1",
      topicId: "topic-1",
      authorId: "user-1",
      authorKind: "human" as const,
      author: { id: "user-1", displayName: "成员" },
      content: { format: "duallane.message+json;v=1", plainText: "第一条", blocks: [{ type: "text" as const, text: "第一条" }] },
      plainText: "第一条",
      createdAt: "2026-08-21T00:00:00.000Z"
    };
    const second = { ...first, id: "message-2", plainText: "第二条", content: { ...first.content, plainText: "第二条", blocks: [{ type: "text" as const, text: "第二条" }] }, createdAt: "2026-08-21T00:01:00.000Z" };
    const current = [first];
    expect(mergeWorkspaceTopicMessages(current, [first])).toBe(current);
    expect(mergeWorkspaceTopicMessages(current, [first, second])).toEqual([first, second]);
  });

  it("shows the mobile rail until a topic is selected", () => {
    expect(workspaceTopicMobilePane("")).toBe("list");
    expect(workspaceTopicMobilePane("topic-1")).toBe("main");
  });

  it("targets refreshes to the affected topic and conversation", () => {
    expect(topicRefreshVersionForTopic(refreshSignal, "topic-1")).toBe(7);
    expect(topicRefreshVersionForTopic(refreshSignal, "topic-2")).toBe(0);
    expect(topicRefreshVersionForList(refreshSignal)).toBe(7);
    expect(topicRefreshVersionForConversation(refreshSignal, "conversation-1")).toBe(7);
    expect(topicRefreshVersionForConversation(refreshSignal, "conversation-2")).toBe(0);
  });

  it("retains every relevant scope across batched events", () => {
    const topicOne = advanceWorkspaceTopicRefreshSignal(refreshSignal, {
      topicId: "topic-2",
      conversationId: "conversation-2",
      affectsList: true
    });
    const topicTwoProjection = advanceWorkspaceTopicRefreshSignal(topicOne, {
      topicId: "topic-3",
      conversationId: "conversation-3",
      affectsList: false
    });

    expect(topicRefreshVersionForTopic(topicTwoProjection, "topic-1")).toBe(7);
    expect(topicRefreshVersionForTopic(topicTwoProjection, "topic-2")).toBe(8);
    expect(topicRefreshVersionForTopic(topicTwoProjection, "topic-3")).toBe(9);
    expect(topicRefreshVersionForConversation(topicTwoProjection, "conversation-2")).toBe(8);
    expect(topicRefreshVersionForConversation(topicTwoProjection, "conversation-3")).toBe(0);
    expect(topicRefreshVersionForList(topicTwoProjection)).toBe(8);
  });

  it("does not mark or scroll messages while hidden or while reading history", () => {
    expect(shouldAcknowledgeTopicMessages({ initialLoad: true, documentVisible: false, nearBottom: true })).toBe(false);
    expect(shouldAcknowledgeTopicMessages({ initialLoad: false, documentVisible: true, nearBottom: false })).toBe(false);
    expect(shouldAcknowledgeTopicMessages({ initialLoad: true, documentVisible: true, nearBottom: false })).toBe(true);
    expect(shouldAcknowledgeTopicMessages({ initialLoad: false, documentVisible: true, nearBottom: true })).toBe(true);
  });

  it("detects whether the message viewport is near the latest message", () => {
    expect(isTopicMessageListNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 240 })).toBe(true);
    expect(isTopicMessageListNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 240 })).toBe(false);
  });

  it("uses the server member identifier contract", () => {
    const member: WorkspaceTopicMember = { userId: "user-1", displayName: "成员" };
    expect(member.userId).toBe("user-1");
  });
});
