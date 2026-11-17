import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  classifyChatLink,
  parseChatMarkdownAST,
  renderChatMarkdown,
  splitTrailingUrlPunctuation,
  TRUSTED_EXTERNAL_DOMAINS,
} from "./chat-markdown";
import {
  analyzeLongMessage,
  useDisplayPrefsStore,
} from "./display-prefs";
import {
  RECENT_EMOJIS_V1_STORAGE_KEY,
  resolveBuiltinEmojiId,
  useRecentEmojisStore,
} from "./recent-emojis-v1";
import {
  computeGlobalAlertUnreadCount,
  formatConversationPreviewText,
  parseBootstrapPayload,
  useWorkspaceStore,
} from "@/entities/workspace/store";
import { buildSidebarMessagePreview } from "@/widgets/ConversationSidebar";
import { MessageRichContent } from "@/widgets/EmoteSystem";
import { apiV1 } from "@/shared/lib/api-v1";

describe("Chat Markdown AST, Auto-Linker & Off-Site Link Classifier", () => {
  it("renders block-level fenced code, headings, blockquotes, lists, and GFM pipe tables cleanly", () => {
    const md = [
      "# 发布清单",
      "> 请全员核对上线窗口",
      "- 检查数据库迁移",
      "- 验证实时通道",
      "1. 灰度节点",
      "2. 全量发布",
      "",
      "| 模块 | 状态 | 耗时 |",
      "| :--- | :---: | ---: |",
      "| Web | **通过** | `12ms` |",
      "",
      "```ts",
      "const ok: boolean = true;",
      "```",
    ].join("\n");

    const ast = parseChatMarkdownAST(md);
    expect(ast.map((b) => b.type)).toEqual([
      "heading",
      "blockquote",
      "ul",
      "ol",
      "table",
      "code",
    ]);

    const html = renderToStaticMarkup(<>{renderChatMarkdown(md, "workspace")}</>);
    expect(html).toContain("<h1");
    expect(html).toContain("发布清单");
    expect(html).toContain("<blockquote");
    expect(html).toContain("请全员核对上线窗口");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("<table");
    expect(html).toContain('<strong class="font-bold">通过</strong>');
    expect(html).toContain("const ok: boolean = true;");
    expect(html).toContain("复制");
  });

  it("renders inline formatting, @所有人 pill, Markdown links, bare URLs, and built-in emotes without XSS", () => {
    const sample =
      "@所有人 请查看 **重点说明**、*斜体*、~~旧方案~~、`pnpm test`、[Rust 文档](https://doc.rust-lang.org) 以及 <script>alert(1)</script> [恶意](javascript:alert(1))";
    const html = renderToStaticMarkup(<>{renderChatMarkdown(sample, "workspace")}</>);

    expect(html).toContain("@所有人");
    expect(html).toContain("<strong");
    expect(html).toContain("重点说明");
    expect(html).toContain("<em");
    expect(html).toContain("<del");
    expect(html).toContain("pnpm test");
    expect(html).toContain('href="https://doc.rust-lang.org/"');
    // Zero XSS: raw HTML escaped and javascript: scheme rejected
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('href="javascript:');
  });

  it("strips unbalanced trailing CJK and English punctuation on bare URLs while keeping balanced parens", () => {
    expect(splitTrailingUrlPunctuation("https://github.com/org/repo。")).toEqual({
      cleanUrl: "https://github.com/org/repo",
      trailing: "。",
    });
    expect(splitTrailingUrlPunctuation("(https://github.com/org/repo)" ).cleanUrl).toBe(
      "(https://github.com/org/repo)"
    );
    expect(splitTrailingUrlPunctuation("https://github.com/org/repo)")).toEqual({
      cleanUrl: "https://github.com/org/repo",
      trailing: ")",
    });
    expect(
      splitTrailingUrlPunctuation("https://en.wikipedia.org/wiki/Rust_(programming_language)）。")
    ).toEqual({
      cleanUrl: "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      trailing: "）。",
    });

    const rendered = renderToStaticMarkup(
      <>
        {renderChatMarkdown(
          "详见（https://en.wikipedia.org/wiki/Rust_(programming_language)），收到请回复！",
          "p2p"
        )}
      </>
    );
    expect(rendered).toContain(
      'href="https://en.wikipedia.org/wiki/Rust_(programming_language)"'
    );
    expect(rendered).toContain("rel=\"noopener noreferrer\"");
  });

  it("classifies same-origin, trusted whitelist domains (https only), and untrusted/risky external URLs", () => {
    const origin = "https://duallane.tsio.top";

    // Same-origin
    expect(classifyChatLink("https://duallane.tsio.top/workspace?invite=123", origin).kind).toBe(
      "same-origin"
    );
    expect(classifyChatLink("/workspace/emotes/shared/abc12345", origin).kind).toBe("same-origin");

    // Every trusted external domain & dot-boundary subdomain over https:
    for (const domain of TRUSTED_EXTERNAL_DOMAINS) {
      expect(classifyChatLink(`https://${domain}/path`, "https://chat.local").kind).toBe(
        "trusted-external"
      );
      expect(classifyChatLink(`https://sub.${domain}/path`, "https://chat.local").kind).toBe(
        "trusted-external"
      );
    }

    // Plain http: on whitelisted domain is NOT trusted-external
    expect(classifyChatLink("http://github.com/org/repo", origin).kind).toBe(
      "untrusted-external"
    );

    // Lookalike non-dot-boundary domain is untrusted
    expect(classifyChatLink("https://evilgithub.com/login", origin).kind).toBe(
      "untrusted-external"
    );

    // Risk flags: raw IP, userinfo @, punycode xn--
    const rawIp = classifyChatLink("https://192.168.1.25/admin", origin);
    expect(rawIp.kind).toBe("untrusted-external");
    expect(rawIp.riskFlags.isRawIp).toBe(true);

    const userInfo = classifyChatLink("https://github.com@evil.example.com/phish", origin);
    expect(userInfo.kind).toBe("untrusted-external");
    expect(userInfo.riskFlags.hasUserInfo).toBe(true);

    const puny = classifyChatLink("https://xn--80ak6aa92e.com/", origin);
    expect(puny.kind).toBe("untrusted-external");
    expect(puny.riskFlags.isPunycode).toBe(true);

    // Unsafe protocols rejected
    expect(classifyChatLink("javascript:alert(1)", origin).valid).toBe(false);
    expect(classifyChatLink("data:text/html,<script>alert(1)</script>", origin).valid).toBe(false);
  });

  it("renders MessageRichContent block.type === 'link' via ChatSafeLink", () => {
    const html = renderToStaticMarkup(
      <MessageRichContent
        msg={{
          id: "m_link_1",
          conversationId: "c1",
          senderId: "u1",
          senderName: "Alice",
          plainText: "外链",
          blocks: [{ type: "link", url: "https://unknown-site.example/doc", label: "外部文档" }],
          createdAt: "2026-11-16T00:00:00Z",
          reactions: {},
        }}
      />
    );
    expect(html).toContain('href="https://unknown-site.example/doc"');
    expect(html).toContain("外部文档");
  });
});

describe("Sidebar Preview, Notification Levels, Display Prefs & v1 Profile/Remark Contracts", () => {
  it("formats conversation preview with sender prefix, recalled guard, emote labels & muted unread exclusion", () => {
    expect(formatConversationPreviewText("你好 @__duallane_echo_1 [bili:doge]")).toBe(
      "你好 @Bot [doge]"
    );

    const members = {
      u_me: { id: "u_me", displayName: "我本人", role: "owner" as const },
      u_peer: { id: "u_peer", displayName: "小张（备注）", role: "member" as const },
    };

    expect(
      buildSidebarMessagePreview(
        {
          id: "g1",
          kind: "group",
          title: "研发群",
          unreadCount: 2,
          mentionCount: 0,
          pinnedMessageIds: [],
          memberIds: ["u_me", "u_peer"],
          lastMessageText: "发布完成",
          lastMessageSenderId: "u_peer",
          lastMessageSenderName: "张伟",
        },
        "u_me",
        members
      )
    ).toBe("小张（备注）: 发布完成");

    expect(
      buildSidebarMessagePreview(
        {
          id: "g1",
          kind: "group",
          title: "研发群",
          unreadCount: 0,
          mentionCount: 0,
          pinnedMessageIds: [],
          memberIds: ["u_me", "u_peer"],
          lastMessageText: "消息已撤回",
          lastMessageSenderId: "u_me",
        },
        "u_me",
        members
      )
    ).toBe("消息已撤回");

    expect(
      buildSidebarMessagePreview(
        {
          id: "d1",
          kind: "direct",
          title: "小张",
          unreadCount: 0,
          mentionCount: 0,
          pinnedMessageIds: [],
          memberIds: ["u_me", "u_peer"],
          lastMessageText: "明早对齐",
          lastMessageSenderId: "u_me",
        },
        "u_me",
        members
      )
    ).toBe("我: 明早对齐");

    // Global unread excludes muted conversations unless mentionCount > 0
    const alertTotal = computeGlobalAlertUnreadCount({
      c_normal: {
        id: "c_normal",
        kind: "group",
        title: "普通群",
        unreadCount: 4,
        mentionCount: 0,
        pinnedMessageIds: [],
        memberIds: [],
        notificationLevel: "all",
      },
      c_muted_no_mention: {
        id: "c_muted_no_mention",
        kind: "group",
        title: "免打扰水群",
        unreadCount: 19,
        mentionCount: 0,
        pinnedMessageIds: [],
        memberIds: [],
        notificationLevel: "muted",
      },
      c_muted_with_mention: {
        id: "c_muted_with_mention",
        kind: "group",
        title: "免打扰但被@群",
        unreadCount: 8,
        mentionCount: 2,
        pinnedMessageIds: [],
        memberIds: [],
        notificationLevel: "muted",
      },
    });
    expect(alertTotal).toBe(6);
  });

  it("parses lastMessageSenderId, lastMessageSenderName, and notificationLevel from bootstrap", () => {
    const parsed = parseBootstrapPayload({
      auth: {
        currentUser: { id: "u1", nickname: "Alice", role: "owner" },
      },
      members: [
        { id: "u1", nickname: "Alice", role: "owner" },
        { id: "u2", nickname: "Bob", remark: "老鲍", role: "member" },
      ],
      conversations: [
        {
          id: "conv_1",
          kind: "group",
          title: "架构组",
          unreadCount: 3,
          mentionCount: 0,
          notificationLevel: "muted",
          lastMessagePlainText: "早上好",
          lastMessageSenderId: "u2",
          lastMessageSenderName: "Bob",
          memberIds: ["u1", "u2"],
        },
      ],
    });
    const conv = parsed.conversations["conv_1"];
    expect(conv?.notificationLevel).toBe("muted");
    expect(conv?.lastMessageSenderId).toBe("u2");
    expect(conv?.lastMessageSenderName).toBe("老鲍");
    expect(parsed.members["u2"]?.remark).toBe("老鲍");
    expect(parsed.members["u2"]?.nickname).toBe("Bob");
  });

  it("analyzes long messages (> 12 lines or > 600 chars) and updates member remark across direct chats", async () => {
    expect(analyzeLongMessage("短消息").isLong).toBe(false);
    const fourteenLines = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 行内容`).join("\n");
    const longRes = analyzeLongMessage(fourteenLines);
    expect(longRes.isLong).toBe(true);
    expect(longRes.lineCount).toBe(14);
    expect(longRes.previewText.split("\n").length).toBe(6);

    useDisplayPrefsStore.getState().updateDisplayPref({ collapseLongMessagesByDefault: true });
    expect(useDisplayPrefsStore.getState().collapseLongMessagesByDefault).toBe(true);
    useDisplayPrefsStore.getState().updateDisplayPref({ collapseLongMessagesByDefault: false });

    // Preview mode member remark updates direct conversation title immediately
    useWorkspaceStore.setState({
      isPreviewMode: true,
      currentUser: { id: "u1", displayName: "Alice", role: "owner" },
      members: {
        u1: { id: "u1", displayName: "Alice", role: "owner" },
        u2: { id: "u2", displayName: "Bob", nickname: "Bob", role: "member" },
      },
      conversations: {
        d_bob: {
          id: "d_bob",
          kind: "direct",
          title: "Bob",
          unreadCount: 0,
          mentionCount: 0,
          pinnedMessageIds: [],
          memberIds: ["u1", "u2"],
        },
      },
    });
    await useWorkspaceStore.getState().setMemberRemark("u2", "后端负责人 Bob");
    expect(useWorkspaceStore.getState().members["u2"]?.displayName).toBe("后端负责人 Bob");
    expect(useWorkspaceStore.getState().conversations["d_bob"]?.title).toBe("后端负责人 Bob");

    await useWorkspaceStore.getState().setMemberRemark("u2", "");
    expect(useWorkspaceStore.getState().members["u2"]?.displayName).toBe("Bob");
    expect(useWorkspaceStore.getState().conversations["d_bob"]?.title).toBe("Bob");
  });

  it("tracks recent 8 built-in emojis in MRU order and formats profile/remark/notification REST calls", async () => {
    expect(resolveBuiltinEmojiId("👍")).toBe("thumbs-up");
    expect(resolveBuiltinEmojiId("emoji:thumbsup")).toBe("thumbs-up");
    expect(resolveBuiltinEmojiId("emoji:fire")).toBe("fire");
    useRecentEmojisStore.getState().recordEmoji("👍");
    useRecentEmojisStore.getState().recordEmoji("🔥");
    expect(useRecentEmojisStore.getState().recentIds.slice(0, 2)).toEqual([
      "fire",
      "thumbs-up",
    ]);
    expect(RECENT_EMOJIS_V1_STORAGE_KEY).toBe("dl_recent_emojis_v1");

    const calls: Array<{ url: string; method: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method || "GET" });
      return new Response(
        JSON.stringify({
          ok: true,
          notifications: { enabled: true, immediateEnabled: true, digestEnabled: false },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      await apiV1.updateMyProfile({ nickname: "新昵称" });
      await apiV1.setMemberRemark("usr_2", "同事备注");
      await apiV1.setMemberRemark("usr_2", "   ");
      await apiV1.updateConversationNotification("conv_9", "muted");
      await apiV1.getMyNotifications();
      await apiV1.updateMyNotifications({
        enabled: true,
        immediateEnabled: true,
        digestEnabled: false,
      });

      expect(calls).toEqual([
        { url: "/api/workspace/me/profile", method: "PATCH" },
        { url: "/api/workspace/members/usr_2/remark", method: "PUT" },
        { url: "/api/workspace/members/usr_2/remark", method: "DELETE" },
        { url: "/api/workspace/conversations/conv_9/notification", method: "PATCH" },
        { url: "/api/workspace/me/notifications", method: "GET" },
        { url: "/api/workspace/me/notifications", method: "PATCH" },
      ]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
