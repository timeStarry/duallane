import { describe, expect, it } from "vitest";
import type { WorkspaceTopicMessage } from "../../WorkspaceTopics";
import { topicMessagesForChat } from "./chat-adapter";
import { getMessageGroupPositions } from "../conversation/message-grouping";

const message: WorkspaceTopicMessage = {
  id: "message-a", topicId: "topic-a", authorId: "member-a", authorKind: "human",
  author: { id: "member-a", displayName: "林遥", avatarUrl: "/avatar-a" },
  plainText: "**讨论** @陈序 :smile:", createdAt: "2026-09-11T10:00:00Z",
  content: { format: "duallane.message+json;v=1", plainText: "**讨论** @陈序 :smile:", blocks: [
    { type: "text", text: "**讨论** " }, { type: "mention", userId: "member-b", label: "陈序" },
    { type: "link", url: "https://example.test/design", label: "设计" }, { type: "emoji", shortcode: "smile" }
  ] }
};

describe("topic to shared chat projection", () => {
  it("uses the complete shared projection and consistent author identity", () => {
    const [projected] = topicMessagesForChat([message], "member-a");
    expect(projected).toMatchObject({ id: message.id, author: "你", authorAvatarUrl: "/avatar-a", self: true, lane: "workspace", body: message.plainText });
    expect(projected.content!.blocks).toBe(message.content.blocks);
    expect(projected.pin).toBeUndefined();
    expect(projected.attachments).toEqual([]);
    expect(projected.reactions).toEqual([]);
    expect(topicMessagesForChat([message], "member-b")[0].self).toBe(false);
  });

  it("resolves replies only within the supplied topic snapshot and preserves failed delivery identity", () => {
    const reply = { ...message, id: "pending:client-a", clientMessageId: "client-a", replyToMessageId: message.id, localState: "failed" as const, failureReason: "请重试" };
    const projected = topicMessagesForChat([message, reply], "member-a");
    expect(projected[1]).toMatchObject({ id: "pending:client-a", localState: "failed", failureReason: "请重试", replyTo: { messageId: message.id, author: "林遥", body: message.plainText } });
    expect(topicMessagesForChat([reply], "member-a")[0].replyTo).toMatchObject({ messageId: message.id, body: "查看引用消息" });
  });

  it("uses the existing plaintext fallback and tolerates an invalid display timestamp", () => {
    const source = { ...message, createdAt: "invalid", content: { ...message.content, blocks: [] } };
    const [projected] = topicMessagesForChat([source], "member-a");
    expect(projected.at).toBe("");
    expect(projected.content!.blocks).toEqual([{ type: "text", text: message.plainText }]);
    expect(source.content.blocks).toEqual([]);
  });

  it("keeps an unresolved reply separate with the original target available for history lookup", () => {
    const projected = topicMessagesForChat([
      message,
      { ...message, id: "reply", replyToMessageId: "outside-snapshot" },
      { ...message, id: "following" }
    ], "member-a");
    expect(projected[1].replyToMessageId).toBe("outside-snapshot");
    expect(projected[1].replyTo).toMatchObject({ messageId: "outside-snapshot", body: "查看引用消息" });
    expect(getMessageGroupPositions(projected)).toEqual(["single", "single", "single"]);
  });
});
