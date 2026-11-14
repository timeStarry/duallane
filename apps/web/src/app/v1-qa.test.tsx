import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DESIGN_TOKENS } from "@duallane/design-tokens";
import type { DualLaneCardKitDocument } from "@duallane/protocol";
import { parseBootstrapPayload, useWorkspaceStore } from "@/entities/workspace/store";
import { buildDevPreviewFixture } from "@/entities/workspace/demo-fixture";
import { apiV1 } from "@/shared/lib/api-v1";
import {
  decryptP2PPayload,
  deriveAesKey,
  encryptP2PPayload,
  extractP2PRoomFromUrl,
  generateRoomKeyString,
} from "@/shared/lib/p2p-lane";
import { useLaneStore } from "@/entities/lane/store";
import { applyVibrancyTokensToRoot } from "@/shared/theme/vibrancy";
import { DualLaneCardKit } from "@/widgets/DualLaneCardKit";
import { PrimaryRail } from "@/widgets/PrimaryRail";
import { ConversationSidebar } from "@/widgets/ConversationSidebar";
import { TimelinePane } from "@/widgets/TimelinePane";
import { TooltipProvider } from "@/shared/ui";

function hexLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = hexLuminance(fgHex);
  const l2 = hexLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("DualLane v1.0 QA Acceptance Suite", () => {
  it("encrypts and decrypts P2P AES-256-GCM messages in memory without mutating plaintext", async () => {
    const keyStr = await generateRoomKeyString();
    const { key, fingerprint } = await deriveAesKey(keyStr);
    expect(fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){3}$/);

    const secretMessage = "机密消息：#k= 仅驻留内存，绝不发往服务端";
    const envelope = await encryptP2PPayload(key, secretMessage);
    expect(envelope).not.toContain(secretMessage);

    const decrypted = await decryptP2PPayload(key, envelope);
    expect(decrypted).toBe(secretMessage);
  });

  it("parses Go /api/workspace/bootstrap envelope accurately", () => {
    const parsed = parseBootstrapPayload({
      auth: {
        mode: "github",
        inviteOnly: true,
        currentUser: {
          id: "usr_1",
          nickname: "TimeStarry",
          githubLogin: "timestarry",
          role: "owner",
        },
      },
      policy: {
        dailyQuotaBytes: 1000,
        usedTodayBytes: 250,
      },
      members: [
        { id: "usr_1", nickname: "TimeStarry", role: "owner" },
        { id: "usr_bot_1", displayName: "Echo Bot", role: "bot" },
      ],
      conversations: [
        {
          id: "conv_saved_1",
          type: "saved",
          title: "个人空间",
          unreadCount: 0,
          memberIds: ["usr_1"],
        },
        {
          id: "conv_grp_1",
          type: "group",
          title: "核心研发群",
          unreadCount: 3,
          pinnedMessageIds: ["msg_pin_1"],
          memberIds: ["usr_1", "usr_bot_1"],
          lastMessage: { plainText: "v1.0 重构完成", createdAt: "2026-11-14T00:00:00Z" },
        },
      ],
      eventCursor: 42,
    });

    expect(parsed.currentUser?.id).toBe("usr_1");
    expect(parsed.currentUser?.displayName).toBe("TimeStarry");
    expect(parsed.quotaUsedBytes).toBe(250);
    expect(parsed.quotaLimitBytes).toBe(1000);
    expect(parsed.conversations["conv_saved_1"]?.kind).toBe("saved");
    expect(parsed.conversations["conv_saved_1"]?.title).toBe("我的收藏");
    expect(parsed.conversations["conv_grp_1"]?.lastMessageText).toBe("v1.0 重构完成");
    expect(parsed.eventCursor).toBe(42);
  });

  it("renders DualLane Card Kit v1 blocks cleanly", () => {
    const card: DualLaneCardKitDocument = {
      version: 1,
      cardId: "card_qa_1",
      cardType: "approval.v1",
      status: "active",
      revision: 2,
      fallbackText: "发布审批",
      blocks: [
        { type: "header", title: "v1.0 质量验收审批", subtitle: "全链路架构核验", badge: "进行中", tone: "shared" },
        { type: "markdown", content: "所有 Go / Web / SDK 门禁已通过。" },
        {
          type: "fields",
          items: [
            { label: "分支", value: "feat/v1.0-architecture", short: true },
            { label: "迁移", value: "036_v1_clean_architecture.sql", short: true },
          ],
        },
        {
          type: "poll",
          pollId: "poll_qa",
          totalVotes: 4,
          options: [
            { id: "pass", label: "通过验收", votes: 4, selected: true },
            { id: "hold", label: "暂缓", votes: 0 },
          ],
        },
        { type: "divider" },
        {
          type: "actions",
          elements: [
            { type: "button", actionId: "confirm_release", label: "确认签收", style: "primary" },
          ],
        },
      ],
    };

    const html = renderToStaticMarkup(<DualLaneCardKit card={card} onAction={() => {}} />);
    expect(html).toContain("v1.0 质量验收审批");
    expect(html).toContain("feat/v1.0-architecture");
    expect(html).toContain("通过验收");
    expect(html).toContain("确认签收");
  });

  it("formats Workspace & v1 REST requests to match Go httpapi contracts", async () => {
    expect(apiV1.getGitHubStartUrl("INV-123")).toBe("/api/auth/github/start?invite=INV-123");
    expect(apiV1.getGitHubStartUrl("")).toBe("/api/auth/github/start");

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, currentSeq: 10, events: [] }), { status: 200 });
    }) as typeof fetch;

    try {
      await apiV1.sync(9);
      await apiV1.sendMessage("conv_1", "你好 DualLane", { clientMessageId: "cli_fixed" });
      await apiV1.invokeCardAction("card_1", "approve", { comment: "LGTM" }, 3);

      expect(calls[0]?.url).toBe("/api/v1/sync?sinceSeq=9");
      expect(calls[1]?.url).toBe("/api/workspace/messages");
      expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
        conversationId: "conv_1",
        clientMessageId: "cli_fixed",
        replyToMessageId: "",
        content: {
          format: "duallane.message+json;v=1",
          plainText: "你好 DualLane",
          blocks: [{ type: "text", text: "你好 DualLane" }],
        },
      });
      expect(calls[2]?.url).toBe("/api/workspace/cards/card_1/actions");
      const cardBody = JSON.parse(String(calls[2]?.init?.body));
      expect(cardBody.actionId).toBe("approve");
      expect(cardBody.expectedRevision).toBe(3);
      expect(cardBody.input).toEqual({ comment: "LGTM" });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("applies vibrancy tokens cleanly when DOM document exists", () => {
    if (typeof document !== "undefined") {
      applyVibrancyTokensToRoot("dark", "indigo", "glass", false);
      expect(document.documentElement.dataset.themeMode).toBe("dark");
      expect(document.documentElement.style.getPropertyValue("--dl-bg")).toBeTruthy();
    } else {
      expect(() => applyVibrancyTokensToRoot("dark", "indigo", "glass", false)).not.toThrow();
    }
  });

  it("enforces WCAG AA contrast ratios (>= 4.5:1) across Light and Dark dual-lane tokens", () => {
    const light = DESIGN_TOKENS.modes.light;
    const dark = DESIGN_TOKENS.modes.dark;

    // Body text & muted secondary text on surface
    expect(contrastRatio(light.text, light.surface)).toBeGreaterThanOrEqual(12);
    expect(contrastRatio(light.muted, light.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.text, dark.surface)).toBeGreaterThanOrEqual(12);
    expect(contrastRatio(dark.muted, dark.surface)).toBeGreaterThanOrEqual(4.5);

    // Dual-lane bubble text (onShared / onDirect) in both Light & Dark modes (>= 4.5:1 WCAG AA)
    expect(contrastRatio(light.onShared, light.shared)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.onDirect, light.direct)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.onShared, dark.shared)).toBeGreaterThanOrEqual(7.0);
    expect(contrastRatio(dark.onDirect, dark.direct)).toBeGreaterThanOrEqual(6.5);
  });

  it("renders PrimaryRail, ConversationSidebar, and TimelinePane with vector icons, consecutive message grouping, and floating hover bar", () => {
    const fixture = buildDevPreviewFixture();
    const prevInitial = { ...useWorkspaceStore.getInitialState() };
    const snapshot = {
      isPreviewMode: true,
      authStatus: "authenticated" as const,
      currentUser: fixture.currentUser,
      quotaUsedBytes: fixture.quotaUsedBytes,
      quotaLimitBytes: fixture.quotaLimitBytes,
      members: fixture.members,
      conversations: fixture.conversations,
      conversationOrder: fixture.conversationOrder,
      messagesByConv: fixture.messagesByConv,
      activeConversationId: fixture.activeConversationId,
      threadsByRootId: fixture.threadsByRootId,
      drafts: fixture.drafts,
    };
    Object.assign(useWorkspaceStore.getInitialState(), snapshot);
    useWorkspaceStore.setState(snapshot);

    try {
      const railHtml = renderToStaticMarkup(
        <TooltipProvider>
          <PrimaryRail />
        </TooltipProvider>
      );
      const sidebarHtml = renderToStaticMarkup(
        <TooltipProvider>
          <ConversationSidebar />
        </TooltipProvider>
      );
      const timelineHtml = renderToStaticMarkup(
        <TooltipProvider>
          <TimelinePane />
        </TooltipProvider>
      );

      // Crisp SVG icons rendered instead of raw OS chrome emojis
      expect(railHtml).toContain("<svg");
      expect(railHtml).not.toContain("🏢");
      expect(railHtml).not.toContain("⚙️");

      // Conversation hierarchy: Saved Messages pinned first, [草稿] preview, @ mention & adaptive unread badge
      expect(sidebarHtml).toContain("我的收藏");
      expect(sidebarHtml).toContain("[草稿]");
      expect(sidebarHtml).toContain("text-dl-on-shared");

      // Timeline UX: adaptive bubble text contrast, floating action pill (-top-3.5), multi-line textarea, grouped messages
      expect(timelineHtml).toContain("text-dl-on-shared");
      expect(timelineHtml).not.toContain("bg-dl-lane-shared text-white");
      expect(timelineHtml).toContain("-top-3.5");
      expect(timelineHtml).toContain("<textarea");
      expect(timelineHtml).toContain("3 条线程回复");
    } finally {
      Object.assign(useWorkspaceStore.getInitialState(), prevInitial);
      useWorkspaceStore.setState(prevInitial);
    }
  });

  it("rejects HTML SPA fallback responses instead of silently returning {} and normalizes search arrays", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response("<!doctype html><html><body>SPA fallback</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as typeof fetch;

    try {
      await expect(apiV1.search("测试")).rejects.toMatchObject({
        code: "response.invalid_json",
      });
    } finally {
      globalThis.fetch = origFetch;
    }

    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    try {
      const normalized = await apiV1.search("测试");
      expect(normalized).toEqual({ messages: [], files: [] });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("extracts P2P roomId and #k= fragment key from both /direct/:roomId and /r/:roomId", () => {
    expect(
      extractP2PRoomFromUrl({
        pathname: "/direct/AbCdEf123456",
        hash: "#k=test_secret_key_material",
      })
    ).toEqual({
      roomId: "AbCdEf123456",
      keyStr: "test_secret_key_material",
    });

    expect(
      extractP2PRoomFromUrl({
        pathname: "/r/room_xyz",
        hash: "#k=another_key",
      })
    ).toEqual({
      roomId: "room_xyz",
      keyStr: "another_key",
    });
  });

  it("maps Go Workspace projection DTO fields (displayTitle, latestMessages, authorName, reaction arrays)", () => {
    const parsed = parseBootstrapPayload({
      auth: {
        currentUser: { id: "usr_owner", nickname: "Owner", role: "owner" },
      },
      conversations: [
        {
          id: "conv_go_1",
          type: "group",
          displayTitle: "Go 后端契约联调群",
          lastMessagePlainText: "来自 Go 投影的最新摘要",
          lastMessageAt: "2026-11-14T02:00:00Z",
          memberIds: ["usr_owner", "usr_peer"],
          latestMessages: [
            {
              id: "msg_go_1",
              conversationId: "conv_go_1",
              authorId: "usr_peer",
              authorName: "对端成员",
              plainText: "实时投影消息",
              createdAt: "2026-11-14T02:00:00Z",
              reactions: [{ emoteKey: "🔥", count: 2, reactedByCurrentUser: true }],
            },
          ],
        },
      ],
    });

    expect(parsed.conversations["conv_go_1"]?.title).toBe("Go 后端契约联调群");
    expect(parsed.conversations["conv_go_1"]?.lastMessageText).toBe("来自 Go 投影的最新摘要");
    const msg = parsed.messagesByConv["conv_go_1"]?.[0];
    expect(msg?.senderName).toBe("对端成员");
    expect(msg?.reactions["🔥"]).toEqual({ count: 2, reactedByMe: true });
  });

  it("renders explicit P2P peer status and honest per-message delivery feedback (waiting vs delivered)", () => {
    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    const prevLaneInitial = { ...useLaneStore.getInitialState() };

    try {
      const laneWaiting = { ...prevLaneInitial, activeLane: "p2p" as const };
      Object.assign(useLaneStore.getInitialState(), laneWaiting);
      useLaneStore.setState(laneWaiting);

      const wsWaiting = {
        ...prevWsInitial,
        p2pRoom: {
          roomId: "RmWait01",
          keyFingerprint: "AA:BB:CC:DD",
          connectedPeers: 1,
          remotePeerCount: 0,
          status: "waiting_peer" as const,
          shareUrl: "http://127.0.0.1:5173/direct/RmWait01#k=secret",
        },
        p2pMessages: [
          {
            id: "p2p_q1",
            senderName: "我",
            isOwn: true,
            text: "这条消息还在等待对端上线",
            createdAt: "2026-11-14T03:00:00Z",
            deliveryStatus: "queued" as const,
            reactions: {},
          },
        ],
      };
      Object.assign(useWorkspaceStore.getInitialState(), wsWaiting);
      useWorkspaceStore.setState(wsWaiting);

      const waitingHtml = renderToStaticMarkup(
        <TooltipProvider>
          <TimelinePane />
        </TooltipProvider>
      );
      expect(waitingHtml).toContain("等待对端加入 · 仅本机在线 1/2");
      expect(waitingHtml).toContain("等待对端加入");
      expect(waitingHtml).not.toContain("对端已收");

      const wsConnected = {
        ...wsWaiting,
        p2pRoom: {
          ...wsWaiting.p2pRoom,
          connectedPeers: 2,
          remotePeerCount: 1,
          status: "peer_connected" as const,
        },
        p2pMessages: [
          {
            ...wsWaiting.p2pMessages[0]!,
            deliveryStatus: "delivered" as const,
          },
        ],
      };
      Object.assign(useWorkspaceStore.getInitialState(), wsConnected);
      useWorkspaceStore.setState(wsConnected);

      const connectedHtml = renderToStaticMarkup(
        <TooltipProvider>
          <TimelinePane />
        </TooltipProvider>
      );
      expect(connectedHtml).toContain("对端已连接 · 2/2 在线");
      expect(connectedHtml).toContain("对端已收");
    } finally {
      Object.assign(useWorkspaceStore.getInitialState(), prevWsInitial);
      useWorkspaceStore.setState(prevWsInitial);
      Object.assign(useLaneStore.getInitialState(), prevLaneInitial);
      useLaneStore.setState(prevLaneInitial);
    }
  });
});
