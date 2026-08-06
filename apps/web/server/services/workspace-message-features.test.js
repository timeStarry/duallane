import { describe, expect, it } from "vitest";
import { sanitizeGitHubAvatarUrl, sanitizeWorkspaceAvatarUrl } from "./avatar.mjs";
import {
  getReactionEmote,
  isVisibleReactionEmoteKey,
  listVisibleReactionKeys,
  publicReactionEmote
} from "./emote-catalog.mjs";
import { markdownToPlainText } from "./markdown.mjs";
import {
  BEACON_IDENTITY,
  getConversationPolicyCapabilities,
  getSystemIdentityConversationCapabilities,
  SYSTEM_IDENTITY_CONVERSATION_POLICIES
} from "./system-identities.mjs";

describe("GitHub avatar projection", () => {
  it("allows only HTTPS avatars.githubusercontent.com URLs without credentials or ports", () => {
    expect(sanitizeGitHubAvatarUrl(" https://avatars.githubusercontent.com/u/42?v=4 "))
      .toBe("https://avatars.githubusercontent.com/u/42?v=4");
    for (const value of [
      "http://avatars.githubusercontent.com/u/42",
      "https://avatars.githubusercontent.com.evil.test/u/42",
      "https://user@avatars.githubusercontent.com/u/42",
      "https://avatars.githubusercontent.com:444/u/42",
      "data:image/png;base64,abc",
      "not a url"
    ]) {
      expect(sanitizeGitHubAvatarUrl(value)).toBe("");
    }
  });

  it("allows only controlled same-origin Workspace asset paths", () => {
    expect(sanitizeWorkspaceAvatarUrl("/assets/beacon-avatar.png")).toBe("/assets/beacon-avatar.png");
    expect(sanitizeWorkspaceAvatarUrl("/assets/../secret.png")).toBe("");
    expect(sanitizeWorkspaceAvatarUrl("/uploads/user-content.png")).toBe("");
  });
});

describe("system identity conversation policy", () => {
  it("keeps bot identity separate from group participation capability", () => {
    expect(getSystemIdentityConversationCapabilities(BEACON_IDENTITY)).toEqual({
      canStartDirectConversation: true,
      canJoinGroups: false
    });
    expect(getConversationPolicyCapabilities(SYSTEM_IDENTITY_CONVERSATION_POLICIES.GROUP_CAPABLE)).toEqual({
      canStartDirectConversation: true,
      canJoinGroups: true
    });
  });
});

describe("workspace Markdown summaries", () => {
  it("strips formatting while preserving readable block boundaries", () => {
    expect(markdownToPlainText("**粗体**、*斜体* 与 [链接](https://example.test)"))
      .toBe("粗体、斜体 与 链接");
    expect(markdownToPlainText("> 引用\n\n- 第一项\n- 第二项"))
      .toBe("引用\n第一项\n第二项");
    expect(markdownToPlainText(" 前置 **内容** "))
      .toBe(" 前置 内容 ");
  });

  it("does not include Markdown image alt text or raw syntax", () => {
    expect(markdownToPlainText("正文 ![秘密替代文本](https://example.test/a.png)"))
      .toBe("正文");
    const tick = String.fromCharCode(96);
    expect(markdownToPlainText("## 标题\n\n" + tick + "code" + tick)).toBe("标题\ncode");
  });

  it("keeps fenced code as meaningful message text", () => {
    expect(markdownToPlainText("~~~python\nimport stdio\nmain() {}\n~~~"))
      .toBe("import stdio\nmain() {}");
  });

  it("projects thematic breaks as a meaningful conversation summary", () => {
    expect(markdownToPlainText("---")).toBe("[分割线]");
    expect(markdownToPlainText("上半段\n\n***\n\n下半段")).toBe("上半段\n[分割线]\n下半段");
  });
});

describe("shared Reaction emote catalog", () => {
  it("accepts visible stable keys and keeps hidden packs historical-only", () => {
    expect(isVisibleReactionEmoteKey("feishu:ok")).toBe(true);
    expect(publicReactionEmote("feishu:ok")).toMatchObject({
      emoteKey: "feishu:ok",
      kind: "image",
      label: expect.any(String),
      src: expect.any(String)
    });
    expect(getReactionEmote("douyin:laughwithtears")).toMatchObject({
      packId: "douyin",
      visible: false
    });
    expect(isVisibleReactionEmoteKey("douyin:laughwithtears")).toBe(false);
    expect(listVisibleReactionKeys()).toContain("feishu:ok");
    expect(listVisibleReactionKeys()).not.toContain("douyin:laughwithtears");
    expect(getReactionEmote("missing:nope")).toBeNull();
  });
});
