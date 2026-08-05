import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyWorkspaceMarkdownFormat,
  applyWorkspaceReactionOptimistic,
  getWorkspaceSingleImageAttachment,
  shouldApplyWorkspaceReactionResponse
} from "./App";
import {
  WorkspaceAvatar,
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

  it("drops images, raw HTML, tables and unsafe links", () => {
    const html = renderToStaticMarkup(
      <WorkspaceMarkdown>
        {"![图片](https://example.test/a.png)\n\n<script>alert(1)</script>\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[安全](https://example.test/path) [危险](javascript:alert(1))"}
      </WorkspaceMarkdown>
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.test/path"');
    expect(html).toContain('rel="noopener noreferrer"');
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
