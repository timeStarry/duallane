import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceComposerDocument } from "../../WorkspaceComposerEditor";
import type { WorkspaceComposerAttachment } from "./message-model";
import {
  createWorkspaceLongMessageAttachment,
  isWorkspaceTextOverAttachmentLimit,
  prepareWorkspaceMessageContent,
  workspaceDraftWithReplyMention,
  workspaceComposerDocumentToContentBlocks
} from "./message-content";

function textDocument(source: string): WorkspaceComposerDocument {
  return { source, blocks: [{ type: "text", text: source }] };
}

function attachment(id: string): WorkspaceComposerAttachment {
  return { id, file: new File([id], `${id}.png`, { type: "image/png" }), state: "queued", progress: 0 };
}

afterEach(() => vi.useRealTimers());

describe("shared workspace message content", () => {
  it("adds a reply mention for a current peer while preserving existing rich content", () => {
    const original = textDocument("**接着讨论**");
    const options = { enabled: true, currentUserId: "self", replyAuthorId: "peer", members: [{ id: "peer", displayName: "陈序" }] };
    const next = workspaceDraftWithReplyMention(original, options);
    expect(next).toEqual({ source: "@陈序 **接着讨论**", blocks: [{ type: "mention", userId: "peer", label: "陈序" }, { type: "text", text: " " }, ...original.blocks] });
    expect(workspaceDraftWithReplyMention(next, options)).toBe(next);
    expect(original.source).toBe("**接着讨论**");
  });

  it("does not auto-mention self, former members, system authors or when the setting is off", () => {
    const original = textDocument("");
    const options = { enabled: true, currentUserId: "self", replyAuthorId: "peer", members: [{ id: "peer", displayName: "陈序" }] };
    expect(workspaceDraftWithReplyMention(original, { ...options, enabled: false })).toBe(original);
    expect(workspaceDraftWithReplyMention(original, { ...options, replyAuthorId: "self" })).toBe(original);
    expect(workspaceDraftWithReplyMention(original, { ...options, members: [] })).toBe(original);
    expect(workspaceDraftWithReplyMention(original, { ...options, members: [{ id: "peer", displayName: "系统", kind: "system" }] })).toBe(original);
    expect(workspaceDraftWithReplyMention(original, options).source).toBe("@陈序 ");
  });
  it("preserves built-in image tokens and Unicode emoji around mentions", () => {
    const document: WorkspaceComposerDocument = {
      source: "看 [bili:smile]🙂 @林遥 收到",
      blocks: [
        { type: "text", text: "看 " },
        { type: "emote", token: "[bili:smile]", item: { kind: "image", id: "smile", label: "微笑", token: "[bili:smile]", src: "/emotes/smile.png" } },
        { type: "emote", token: "🙂", item: { kind: "unicode", id: "smile", label: "微笑", value: "🙂" } },
        { type: "text", text: " " },
        { type: "mention", userId: "member-a", label: "林遥" },
        { type: "text", text: " 收到" }
      ]
    };
    const original = structuredClone(document);
    expect(prepareWorkspaceMessageContent(document, [])).toEqual({
      body: document.source,
      blocks: [
        { type: "text", text: "看 [bili:smile]🙂 " },
        { type: "mention", userId: "member-a", label: "林遥" },
        { type: "text", text: " 收到" }
      ],
      attachments: []
    });
    expect(document).toEqual(original);
  });

  it("encodes custom image emotes as canonical emoji blocks without merging across them", () => {
    const document: WorkspaceComposerDocument = {
      source: "前[custom:wave]后",
      blocks: [
        { type: "text", text: "前" },
        { type: "emote", token: "[custom:wave]", item: { kind: "image", id: "wave", customId: "owned-emote", label: "挥手", token: "[custom:wave]", src: "/emotes/custom-wave.png" } },
        { type: "text", text: "" },
        { type: "text", text: "后" }
      ]
    };
    expect(workspaceComposerDocumentToContentBlocks(document)).toEqual([
      { type: "text", text: "前" },
      { type: "emoji", shortcode: "custom:owned-emote" },
      { type: "text", text: "后" }
    ]);
  });

  it("allows exact limits and checks Unicode code points and UTF-8 bytes independently", () => {
    expect(isWorkspaceTextOverAttachmentLimit("a".repeat(30_000))).toBe(false);
    expect(isWorkspaceTextOverAttachmentLimit("a".repeat(30_001))).toBe(true);
    expect(isWorkspaceTextOverAttachmentLimit("🙂".repeat(25_600))).toBe(false);
    expect(isWorkspaceTextOverAttachmentLimit("🙂".repeat(25_601))).toBe(true);
  });

  it("creates a TXT attachment containing the complete original source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 11, 17, 30, 12));
    const source = "## 长消息\n" + "🙂".repeat(25_601);
    const generated = createWorkspaceLongMessageAttachment(source);
    expect(generated).toMatchObject({
      state: "queued", progress: 0, generatedFromLongMessage: true, generatedSource: source
    });
    expect(generated.id).toMatch(/^long-message-/);
    expect(generated.file.name).toBe("长消息-20260911-173012.txt");
    expect(generated.file.type).toBe("text/plain");
    expect(await generated.file.text()).toBe(source);
    expect(generated.file.size).toBe(new TextEncoder().encode(source).byteLength);
  });

  it("retains staged files while replacing long text blocks with a TXT summary", async () => {
    const source = "x".repeat(30_001);
    const staged = [attachment("photo")];
    const result = prepareWorkspaceMessageContent(textDocument(source), staged);
    expect(result).not.toBeNull();
    expect(result?.blocks).toEqual([]);
    expect(result?.body).toBe(`[长消息] ${result?.attachments[1].file.name}`);
    expect(result?.attachments[0]).toBe(staged[0]);
    expect(await result?.attachments[1].file.text()).toBe(source);
    expect(staged).toHaveLength(1);
  });

  it("reuses the matching generated TXT at the ten-attachment limit for retries", () => {
    const source = "x".repeat(30_001);
    const generated = createWorkspaceLongMessageAttachment(source);
    const staged = [...Array.from({ length: 9 }, (_, index) => attachment(String(index))), generated];
    const result = prepareWorkspaceMessageContent(textDocument(source), staged);
    expect(result?.attachments).toHaveLength(10);
    expect(result?.attachments[9]).toBe(generated);
    expect(result?.body).toBe(`[长消息] ${generated.file.name}`);
  });

  it("keeps the original staged files when long text needs an unavailable attachment slot", () => {
    const source = "x".repeat(30_001);
    const staged = Array.from({ length: 10 }, (_, index) => attachment(String(index)));
    expect(() => prepareWorkspaceMessageContent(textDocument(source), staged))
      .toThrow("长消息需要转换为 TXT，请先移除一个附件");
    expect(staged).toHaveLength(10);
    expect(staged.every((entry) => entry.state === "queued" && !entry.generatedFromLongMessage)).toBe(true);
    expect(() => prepareWorkspaceMessageContent(textDocument("正常消息"), [...staged, attachment("extra")]))
      .toThrow("每条消息最多添加 10 个文件");
  });

  it("generates a new TXT when the source changed instead of reusing stale content", () => {
    const previous = createWorkspaceLongMessageAttachment("a".repeat(30_001));
    const source = "b".repeat(30_001);
    const result = prepareWorkspaceMessageContent(textDocument(source), [previous]);
    expect(result?.attachments).toHaveLength(2);
    expect(result?.attachments[1].generatedSource).toBe(source);
    expect(result?.attachments[1].id).not.toBe(previous.id);
  });

  it("skips empty drafts and preserves attachment-only messages with readable filenames", () => {
    expect(prepareWorkspaceMessageContent(textDocument("  \n"), [])).toBeNull();
    const staged = [attachment("photo"), attachment("diagram")];
    expect(prepareWorkspaceMessageContent(textDocument("  \n"), staged)).toEqual({
      body: "[文件] photo.png、diagram.png", blocks: [], attachments: staged
    });
  });
});
