import { describe, expect, it } from "vitest";
import type { WorkspaceContentBlock, WorkspaceMessage } from "./message-model";
import { workspaceMessagesForChat, type WorkspaceMessageProjectionInput } from "./message-projection";

function message(overrides: Partial<WorkspaceMessageProjectionInput> = {}): WorkspaceMessageProjectionInput {
  return {
    id: "message-a",
    conversationId: "group-a",
    authorId: "member-a",
    authorName: "林遥",
    authorAvatarUrl: "/avatar-a",
    authorKind: "human",
    kind: "user",
    content: { format: "duallane.message+json;v=1", plainText: "讨论内容", blocks: [{ type: "text", text: "讨论内容" }] },
    plainText: "讨论内容",
    createdAt: "2026-09-11T10:00:00Z",
    attachments: [],
    reactions: [],
    ...overrides
  };
}

describe("shared workspace message projection", () => {
  it("preserves every structured block, attachment, reaction and pin for group and topic snapshots", () => {
    const blocks: WorkspaceContentBlock[] = [
      { type: "text", text: "讨论 " },
      { type: "mention", userId: "member-b", label: "陈序" },
      { type: "link", url: "https://example.test/design", label: "设计" },
      { type: "emoji", shortcode: "custom:wave" },
      { type: "attachment", attachmentId: "photo" },
      { type: "emote_collection", shareId: "share-a" },
      { type: "topic_reference", topicId: "topic-b", title: "另一话题" },
      { type: "card", cardId: "card-a", cardType: "interactive", schemaVersion: 1, fallbackText: "投票" }
    ];
    const source = message({
      content: { format: "duallane.message+json;v=1", plainText: "讨论内容", blocks },
      attachments: [{ id: "photo", fileName: "参考图.png", mimeType: "image/png", byteSize: 1024, status: "available", visibility: "conversation" }],
      reactions: [{ emoteKey: "emoji:wave", count: 1, reactedByCurrentUser: true, users: [{ id: "member-a", displayName: "林遥", createdAt: "2026-09-11T10:01:00Z" }] }],
      pin: { pinnedByUserId: "member-a", pinnedAt: "2026-09-11T10:02:00Z", canUnpin: true }
    });
    const [group] = workspaceMessagesForChat([source], "member-b");
    const [topic] = workspaceMessagesForChat([{ ...source, topicId: "topic-a" }], "member-b");
    expect(topic).toEqual(group);
    expect(group.content).toBe(source.content);
    expect(group.attachments).toBe(source.attachments);
    expect(group.reactions).toBe(source.reactions);
    expect(group.pin).toBe(source.pin);
    expect(group).toMatchObject({ author: "林遥", authorAvatarUrl: "/avatar-a", fileName: "参考图.png", body: "讨论内容", lane: "workspace", self: false });
  });

  it("uses consistent self, system and peer identities with both server author shapes", () => {
    expect(workspaceMessagesForChat([message()], "member-a")[0].author).toBe("你");
    expect(workspaceMessagesForChat([message({ kind: "system" })], "member-a")[0])
      .toMatchObject({ author: "系统", authorKind: "system" });
    expect(workspaceMessagesForChat([message({ authorKind: "system" })], "member-b")[0].author).toBe("系统");
    const legacy = message({ authorName: undefined, authorAvatarUrl: undefined, author: { displayName: "陈序", githubLogin: "chen", avatarUrl: "/avatar-b" } });
    expect(workspaceMessagesForChat([legacy], "member-b")[0]).toMatchObject({ author: "陈序", authorAvatarUrl: "/avatar-b" });
    expect(workspaceMessagesForChat([message({ authorName: undefined, authorGithubLogin: "lin" })], "member-b")[0].author).toBe("lin");
    expect(workspaceMessagesForChat([message({ authorName: undefined, author: { displayName: "", githubLogin: "chen" } })], "member-b")[0].author).toBe("chen");
    expect(workspaceMessagesForChat([message({ authorName: undefined })], "member-b")[0].author).toBe("成员");
  });

  it("keeps failed delivery and pending image state without replacing message identity", () => {
    const pendingAttachments = [{ id: "staged-photo", file: new File(["photo"], "photo.png", { type: "image/png" }), previewUrl: "blob:photo", state: "failed" as const, progress: 45, failureReason: "上传失败" }];
    const source = message({ id: "pending:client-a", clientMessageId: "client-a", localState: "failed", failureReason: "请重试", pendingAttachments });
    const [projected] = workspaceMessagesForChat([source], "member-a");
    expect(projected).toMatchObject({ id: "pending:client-a", author: "你", self: true, localState: "failed", failureReason: "请重试" });
    expect(projected.pendingAttachments).toBe(pendingAttachments);
  });

  it("resolves replies in the snapshot and preserves unloaded source IDs for history lookup", () => {
    const source = message();
    const reply = message({ id: "reply", replyToMessageId: source.id });
    expect(workspaceMessagesForChat([source, reply], "member-a")[1]).toMatchObject({
      replyToMessageId: source.id,
      replyTo: { messageId: source.id, author: "林遥", body: "讨论内容" }
    });
    const [unresolved] = workspaceMessagesForChat([reply], "member-a");
    expect(unresolved.replyToMessageId).toBe(source.id);
    expect(unresolved.replyTo).toEqual({ messageId: source.id, author: "", body: "查看引用消息" });
    expect(workspaceMessagesForChat([source], "member-a")[0].replyTo).toBeUndefined();
  });

  it("replaces hidden and recalled reply bodies with status copy", () => {
    const hidden = message({ id: "hidden", hiddenByCurrentUser: true, plainText: "隐藏正文" });
    const recalled = message({ id: "recalled", recalledAt: "2026-09-11T10:01:00Z", recallReason: "内容有误", plainText: "撤回前正文" });
    const projected = workspaceMessagesForChat([
      hidden,
      recalled,
      message({ id: "reply-hidden", replyToMessageId: hidden.id }),
      message({ id: "reply-recalled", replyToMessageId: recalled.id })
    ], "member-b");
    expect(projected[0].hiddenByCurrentUser).toBe(true);
    expect(projected[1]).toMatchObject({ recalledAt: recalled.recalledAt, recallReason: "内容有误" });
    expect(projected[2].replyTo).toEqual({ messageId: hidden.id, author: "", body: "已隐藏的消息" });
    expect(projected[3].replyTo).toEqual({ messageId: recalled.id, author: "", body: "已撤回的消息" });
  });

  it("supports legacy topic DTOs and invalid timestamps while preserving plaintext fallback without mutation", () => {
    const source = message({
      conversationId: undefined,
      kind: undefined,
      attachments: undefined,
      reactions: undefined,
      createdAt: "invalid",
      content: { format: "duallane.message+json;v=1", plainText: "正文", blocks: [] },
      plainText: "正文"
    });
    const [projected] = workspaceMessagesForChat([source], "member-b");
    expect(projected).toMatchObject({ at: "", attachments: [], reactions: [], content: { blocks: [{ type: "text", text: "正文" }] } });
    expect(source.content.blocks).toEqual([]);
  });

  it("accepts canonical workspace messages directly and preserves their order", () => {
    const canonical: WorkspaceMessage = {
      id: "first", conversationId: "group-a", authorId: "member-a", authorKind: "human", kind: "user",
      plainText: "正文", content: { format: "duallane.message+json;v=1", plainText: "正文", blocks: [{ type: "text", text: "正文" }] },
      createdAt: "2026-09-11T10:01:00Z", attachments: [], reactions: []
    };
    const projected = workspaceMessagesForChat([canonical, { ...canonical, id: "second", createdAt: "2026-09-11T10:00:00Z" }], "member-b");
    expect(projected.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(projected[0].at).toMatch(/^\d{2}:\d{2}$/);
  });
});
