import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyWorkspaceMarkdownFormat,
  applyWorkspaceReactionOptimistic,
  buildWorkspaceMessageBlocks,
  getWorkspaceSingleImageAttachment,
  isWorkspaceTextOverAttachmentLimit,
  serializeWorkspaceMessageForCopy,
  shouldCollapseWorkspaceMessageText,
  workspaceConversationPreview,
  workspaceReplyPreview,
  WorkspaceStructuredMessage,
  shouldApplyWorkspaceReactionResponse
} from "./App";
import {
  WorkspaceAvatar,
  getWorkspaceAvatarAttemptUrl,
  sanitizeWorkspaceAvatarUrl,
  workspaceAvatarInitial
} from "./WorkspaceAvatar";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";

describe("workspace avatar", () => {
  it("accepts only canonical GitHub avatar origins", () => {
    expect(sanitizeWorkspaceAvatarUrl("https://avatars.githubusercontent.com/u/1?v=4"))
      .toBe("https://avatars.githubusercontent.com/u/1?v=4");
    expect(sanitizeWorkspaceAvatarUrl("http://avatars.githubusercontent.com/u/1")).toBe("");
    expect(sanitizeWorkspaceAvatarUrl("https://avatars.githubusercontent.com.evil.test/u/1")).toBe("");
    expect(sanitizeWorkspaceAvatarUrl("https://user@avatars.githubusercontent.com/u/1")).toBe("");
    expect(sanitizeWorkspaceAvatarUrl("https://avatars.githubusercontent.com:444/u/1")).toBe("");
    expect(sanitizeWorkspaceAvatarUrl("not a url")).toBe("");
  });

  it("accepts controlled same-origin system avatar assets", () => {
    expect(sanitizeWorkspaceAvatarUrl("/assets/beacon-avatar.png")).toBe("/assets/beacon-avatar.png");
    expect(sanitizeWorkspaceAvatarUrl("/assets/../private.png")).toBe("");
    const html = renderToStaticMarkup(
      <WorkspaceAvatar name="信标" avatarUrl="/assets/beacon-avatar.png" />
    );
    expect(html).toContain('src="/assets/beacon-avatar.png"');
    expect(sanitizeWorkspaceAvatarUrl("/api/workspace/avatars/usr-1/version-1"))
      .toBe("/api/workspace/avatars/usr-1/version-1");
    expect(sanitizeWorkspaceAvatarUrl("/api/workspace/avatars/usr_owner/version-1"))
      .toBe("/api/workspace/avatars/usr_owner/version-1");
  });

  it("renders a stable initial when no safe avatar exists", () => {
    expect(workspaceAvatarInitial(" Alice")).toBe("A");
    expect(workspaceAvatarInitial("")).toBe("?");
    const html = renderToStaticMarkup(
      <WorkspaceAvatar name="Alice" avatarUrl="https://example.test/avatar.png" />
    );
    expect(html).toContain("Alice 的头像");
    expect(html).toContain(">A</span>");
    expect(html).not.toContain("<img");
  });

  it("retries same-origin custom avatars with a cache-busting URL", () => {
    const url = "/api/workspace/avatars/usr_owner/version-1";
    expect(getWorkspaceAvatarAttemptUrl(url, "retry token")).toBe(`${url}?retry=retry%20token`);
    expect(getWorkspaceAvatarAttemptUrl("https://avatars.githubusercontent.com/u/1?v=4", "retry"))
      .toBe("https://avatars.githubusercontent.com/u/1?v=4");
  });
});

describe("workspace Markdown composer formatting", () => {
  it("wraps selected inline content and keeps the original text selected", () => {
    expect(applyWorkspaceMarkdownFormat("hello", 0, 5, "bold")).toEqual({
      value: "**hello**",
      selectionStart: 2,
      selectionEnd: 7
    });
  });

  it("inserts editable placeholders for an empty selection", () => {
    expect(applyWorkspaceMarkdownFormat("", 0, 0, "italic")).toEqual({
      value: "*斜体文本*",
      selectionStart: 1,
      selectionEnd: 5
    });
  });

  it("formats multiline lists, links and code blocks", () => {
    expect(applyWorkspaceMarkdownFormat("alpha\nbeta", 0, 10, "ordered-list").value)
      .toBe("1. alpha\n2. beta");
    expect(applyWorkspaceMarkdownFormat("站点", 0, 2, "link")).toEqual({
      value: "[站点](https://)",
      selectionStart: 5,
      selectionEnd: 13
    });
    expect(applyWorkspaceMarkdownFormat("code", 0, 4, "code-block")).toEqual({
      value: "~~~\ncode\n~~~",
      selectionStart: 4,
      selectionEnd: 8
    });
  });

  it("keeps Markdown and incomplete links in raw text blocks", () => {
    expect(buildWorkspaceMessageBlocks("[链接文本](https://)")).toEqual([{
      type: "text",
      text: "[链接文本](https://)"
    }]);
    expect(buildWorkspaceMessageBlocks("~~~python\nmain() {}\n~~~")).toEqual([{
      type: "text",
      text: "~~~python\nmain() {}\n~~~"
    }]);
    expect(buildWorkspaceMessageBlocks("访问 https://example.test/files?id=42 查看文件")).toEqual([{
      type: "text",
      text: "访问 https://example.test/files?id=42 查看文件"
    }]);
  });
});

describe("workspace Reaction response ordering", () => {
  it("ignores an HTTP result after a newer realtime aggregate arrives", () => {
    expect(shouldApplyWorkspaceReactionResponse(41, 40)).toBe(false);
    expect(shouldApplyWorkspaceReactionResponse(40, 40)).toBe(true);
  });
});

describe("restricted workspace Markdown", () => {
  it("renders supported formatting and keeps emote parsing out of code", () => {
    const html = renderToStaticMarkup(
      <WorkspaceMarkdown>
        {"**粗体** *斜体* ~~删除~~ [feishu:ok]\n\n`[feishu:ok]`\n\n> 引用\n\n- 一项"}
      </WorkspaceMarkdown>
    );
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<del>删除</del>");
    expect(html).toContain("message-emote-image");
    expect(html).toContain("<code>[feishu:ok]</code>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ul>");
  });

  it("shows unsupported Markdown as literal source and removes unsafe links", () => {
    const html = renderToStaticMarkup(
      <WorkspaceMarkdown>
        {"![图片](https://example.test/a.png)\n\n<script>alert(1)</script>\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[安全](https://example.test/path) [危险](javascript:alert(1))"}
      </WorkspaceMarkdown>
    );
    expect(html).not.toContain('<img src="https://example.test/a.png"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<table");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("![图片](https://example.test/a.png)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("| A | B |");
    expect(html).toContain("[安全](https://example.test/path)");
  });

  it("keeps indented text literal and falls back for an unclosed fence", () => {
    const indented = renderToStaticMarkup(<WorkspaceMarkdown>{"    普通缩进\n下一行"}</WorkspaceMarkdown>);
    expect(indented).not.toContain("<code>");
    expect(indented).toContain("    普通缩进");
    const unclosed = renderToStaticMarkup(<WorkspaceMarkdown>{"```ts\nconst value = 1"}</WorkspaceMarkdown>);
    expect(unclosed).not.toContain("<pre>");
    expect(unclosed).toContain("```ts");
  });

  it("autolinks a literal URL without replacing its original text", () => {
    const url = "https://example.test/files?id=42";
    const html = renderToStaticMarkup(
      <WorkspaceMarkdown>{`访问 ${url} 查看文件`}</WorkspaceMarkdown>
    );
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(`>${url}</a>`);
    expect(html).toContain(`访问 <a`);
    expect(html).toContain(`</a> 查看文件`);
  });
});

describe("workspace message presentation helpers", () => {
  const image = {
    id: "att-image",
    status: "available",
    mimeType: "image/png",
    fileName: "shot.png"
  };

  it("classifies only one available image attachment as image-only", () => {
    expect(getWorkspaceSingleImageAttachment(
      [{ type: "attachment", attachmentId: image.id }],
      [image]
    )).toBe(image);
    expect(getWorkspaceSingleImageAttachment(
      [{ type: "text" }, { type: "attachment", attachmentId: image.id }],
      [image]
    )).toBeNull();
    expect(getWorkspaceSingleImageAttachment(
      [{ type: "attachment", attachmentId: image.id }],
      [{ ...image, mimeType: "application/pdf" }]
    )).toBeNull();
    expect(getWorkspaceSingleImageAttachment(
      [{ type: "attachment", attachmentId: image.id }],
      [{ ...image, status: "failed" }]
    )).toBeNull();
  });

  it("copies raw blocks and applies long-message thresholds without dropping Markdown", () => {
    expect(serializeWorkspaceMessageForCopy({
      body: "fallback",
      content: { blocks: [
        { type: "text", text: "**粗体** " },
        { type: "mention", userId: "usr_alice", label: "Alice" },
        { type: "link", label: "站点", url: "https://example.test" }
      ] },
      attachments: []
    })).toBe("**粗体** @Alice[站点](https://example.test)");
    expect(shouldCollapseWorkspaceMessageText([{ type: "text", text: "a".repeat(701) }])).toBe(true);
    expect(shouldCollapseWorkspaceMessageText([{ type: "text", text: "短消息" }])).toBe(false);
    expect(isWorkspaceTextOverAttachmentLimit("字".repeat(30_001))).toBe(true);
    expect(isWorkspaceTextOverAttachmentLimit("短消息")).toBe(false);
  });

  it("prefixes group previews with the projected author only for user messages", () => {
    const message = {
      authorName: "Alice",
      kind: "user" as const,
      plainText: "今天的进度"
    };
    const baseConversation = {
      lastMessagePlainText: "今天的进度",
      latestMessages: [message],
      memberCount: 3,
      members: []
    };

    expect(workspaceConversationPreview({
      ...baseConversation,
      type: "group"
    })).toBe("Alice：今天的进度");
    expect(workspaceConversationPreview({
      ...baseConversation,
      type: "direct"
    })).toBe("今天的进度");
    expect(workspaceConversationPreview({
      ...baseConversation,
      type: "group",
      latestMessages: [{ ...message, kind: "system", authorName: "系统" }]
    })).toBe("今天的进度");
  });

  it("does not expose hidden messages in conversation or reply previews", () => {
    const visible = { authorName: "Alice", kind: "user" as const, plainText: "可见消息" };
    const hidden = { authorName: "Bob", kind: "user" as const, plainText: "隐藏正文", hiddenByCurrentUser: true };
    expect(workspaceConversationPreview({
      type: "group",
      lastMessagePlainText: "可见消息",
      latestMessages: [visible, hidden],
      memberCount: 3,
      members: []
    })).toBe("Alice：可见消息");
    expect(workspaceReplyPreview(hidden)).toEqual({ author: "", body: "已隐藏的消息" });
    expect(workspaceReplyPreview(visible)).toEqual({ author: "Alice", body: "可见消息" });
  });

  it("renders message text before a compact multi-image grid and regular files", () => {
    const html = renderToStaticMarkup(
      <WorkspaceStructuredMessage
        message={{
          id: "message-layout",
          author: "当前用户",
          body: "正文",
          lane: "workspace",
          at: "15:04",
          content: {
            blocks: [
              { type: "text", text: "正文" },
              { type: "attachment", attachmentId: "image-1" },
              { type: "attachment", attachmentId: "image-2" },
              { type: "attachment", attachmentId: "document-1" }
            ]
          },
          attachments: [
            { id: "image-1", fileName: "一.png", mimeType: "image/png", byteSize: 10, status: "available" },
            { id: "image-2", fileName: "二.webp", mimeType: "image/webp", byteSize: 20, status: "available" },
            { id: "document-1", fileName: "说明.pdf", mimeType: "application/pdf", byteSize: 30, status: "available" }
          ]
        }}
      />
    );

    expect(html.indexOf("message-content-flow")).toBeLessThan(html.indexOf("message-image-grid multiple"));
    expect(html.indexOf("message-image-grid multiple")).toBeLessThan(html.indexOf("message-file-list"));
    expect(html.match(/message-image-tile/g)).toHaveLength(2);
    expect(html).not.toContain("message-file-card image");
  });

  it("marks a single image emote message for enlarged rendering", () => {
    const html = renderToStaticMarkup(
      <WorkspaceStructuredMessage
        message={{
          id: "message-single-emote",
          author: "当前用户",
          body: "[bili:like]",
          lane: "workspace",
          at: "15:04",
          content: {
            blocks: [{ type: "text", text: "[bili:like]" }]
          }
        }}
      />
    );

    expect(html).toContain("message-content-flow workspace-message-text emote-only");
    expect(html).toContain("message-emote-image");
  });

  it("renders emote collection shares as in-place preview buttons", () => {
    const html = renderToStaticMarkup(
      <WorkspaceStructuredMessage
        message={{
          id: "message-emote-collection",
          author: "当前用户",
          body: "[表情合集] 猫猫",
          lane: "workspace",
          at: "15:04",
          content: {
            blocks: [{
              type: "emote_collection",
              shareId: "share-1",
              share: {
                id: "share-1",
                name: "猫猫",
                itemCount: 3,
                sharePath: "/workspace/emotes/shared/share-1",
                createdAt: "2026-08-13T00:00:00.000Z",
                originalCreator: { id: "user-1", displayName: "Alice" },
                sharedBy: { id: "user-2", displayName: "Bob" },
                canRevoke: false,
                revokedAt: null,
                covers: []
              }
            }]
          },
          attachments: []
        }}
      />
    );

    expect(html).toContain('<button class="workspace-emote-share-card" type="button">');
    expect(html).not.toContain('href="/workspace/emotes/shared/share-1"');
  });

  it("optimistically adds, merges and removes current-user reactions", () => {
    const currentUser = {
      id: "usr_current",
      displayName: "当前用户",
      githubLogin: "current",
      createdAt: "2026-08-04T00:00:00.000Z"
    };
    const first = applyWorkspaceReactionOptimistic([], "feishu:ok", currentUser);
    expect(first).toEqual([{
      emoteKey: "feishu:ok",
      count: 1,
      reactedByCurrentUser: true,
      users: [currentUser]
    }]);

    const merged = applyWorkspaceReactionOptimistic([{
      emoteKey: "feishu:ok",
      count: 1,
      reactedByCurrentUser: false,
      users: [{
        id: "usr_alice",
        displayName: "Alice",
        createdAt: "2026-08-03T00:00:00.000Z"
      }]
    }], "feishu:ok", currentUser);
    expect(merged[0].count).toBe(2);
    expect(merged[0].reactedByCurrentUser).toBe(true);
    expect(merged[0].users.map((user) => user.id)).toEqual(["usr_alice", "usr_current"]);

    expect(applyWorkspaceReactionOptimistic(first, "feishu:ok", currentUser)).toEqual([]);
  });

  it("declares stable shell loading state and shape-matched Skeleton variants", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.tsx"), "utf8");
    const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
    expect(source).toContain('data-app-state={');
    expect(source).toContain('aria-busy={workspaceStatus === "idle" || workspaceStatus === "loading"}');
    for (const variant of ["conversation", "message", "file", "member", "setting"]) {
      expect(source).toContain('"' + variant + '"');
    }
    expect(source).toContain("<WorkspaceShellSkeleton />");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(".workspace-skeleton-row");
  });
});
