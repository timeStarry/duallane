import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DESIGN_TOKENS } from "@duallane/design-tokens";
import type { DualLaneCardKitDocument } from "@duallane/protocol";
import { parseBootstrapPayload, useWorkspaceStore } from "@/entities/workspace/store";
import { buildDevPreviewFixture } from "@/entities/workspace/demo-fixture";
import { apiV1 } from "@/shared/lib/api-v1";
import {
  createSafeP2PBlobUrl,
  decryptP2PPayload,
  deriveAesKey,
  encryptP2PPayload,
  extractP2PRoomFromUrl,
  generateRoomKeyString,
  hasP2PRoomInUrl,
  safeInlineImageMime,
} from "@/shared/lib/p2p-lane";
import {
  inferEntryViewFromLocation,
  inferLaneFromLocation,
  inferMobileViewFromLocation,
  useLaneStore,
} from "@/entities/lane/store";
import { AppV1 } from "@/app/AppV1";
import { WorkbenchV1 } from "@/app/WorkbenchV1";
import { applyVibrancyTokensToRoot } from "@/shared/theme/vibrancy";
import { DualLaneCardKit } from "@/widgets/DualLaneCardKit";
import { PrimaryRail } from "@/widgets/PrimaryRail";
import { ConversationSidebar } from "@/widgets/ConversationSidebar";
import { InspectorPane } from "@/widgets/InspectorPane";
import { SpaceAdminConsole } from "@/widgets/SpaceAdminConsole";
import { TimelinePane } from "@/widgets/TimelinePane";
import { BrandLogo, TooltipProvider } from "@/shared/ui";

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

    // Semantic status colors (success, warning, danger) against surface (>= 4.5:1 WCAG AA)
    expect(contrastRatio(light.warning, light.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.danger, light.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.warning, dark.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.danger, dark.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("enforces strict Base64URL #k= validation, URL detection, and XSS-safe P2P Blob MIME handling", async () => {
    await expect(deriveAesKey("invalid+base64/chars==")).rejects.toThrow();
    await expect(deriveAesKey("short")).rejects.toThrow();

    expect(hasP2PRoomInUrl({ pathname: "/direct/Rm123", hash: "#k=abc" })).toBe(true);
    expect(hasP2PRoomInUrl({ pathname: "/", hash: "#k=abc" })).toBe(true);
    expect(hasP2PRoomInUrl({ pathname: "/workspace", hash: "" })).toBe(false);

    expect(safeInlineImageMime("image/png")).toBe(true);
    expect(safeInlineImageMime("image/jpeg")).toBe(true);
    expect(safeInlineImageMime("image/webp")).toBe(true);
    expect(safeInlineImageMime("image/svg+xml")).toBe(false);
    expect(safeInlineImageMime("text/html")).toBe(false);

    const svgBytes = new TextEncoder().encode("<svg onload='alert(1)'></svg>");
    const blobUrl = createSafeP2PBlobUrl(svgBytes, "image/svg+xml");
    expect(blobUrl.startsWith("blob:")).toBe(true);
    URL.revokeObjectURL(blobUrl);
  });

  it("uploads Workspace files (single & chunked) and omits empty text blocks on attachment-only messages", async () => {
    const calls: Array<{ url: string; method: string; headers?: HeadersInit; body?: unknown }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method || "GET", headers: init?.headers, body: init?.body });
      if (url === "/api/workspace/files/uploads/reserve") {
        const req = JSON.parse(String(init?.body));
        if (req.byteSize > 10) {
          return new Response(
            JSON.stringify({
              status: "reserved",
              attachment: { id: "att_chunked", fileName: req.fileName, mimeType: req.mimeType, byteSize: req.byteSize },
              upload: { id: "up_chunked", mode: "chunked", partSize: 8, partCount: 2 },
            }),
            { status: 201 }
          );
        }
        return new Response(
          JSON.stringify({
            status: "reserved",
            attachment: { id: "att_single", fileName: req.fileName, mimeType: req.mimeType, byteSize: req.byteSize },
            upload: { id: "up_single", mode: "single", partSize: 4096, partCount: 1 },
          }),
          { status: 201 }
        );
      }
      if (url.startsWith("/api/workspace/files/uploads/up_single/content")) {
        return new Response(
          JSON.stringify({
            usedToday: 5,
            attachment: { id: "att_single", fileName: "note.txt", mimeType: "text/plain", byteSize: 5 },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/parts/")) {
        return new Response(JSON.stringify({ part: { partNumber: 1 } }), { status: 200 });
      }
      if (url.endsWith("/complete")) {
        return new Response(
          JSON.stringify({
            usedToday: 17,
            attachment: { id: "att_chunked", fileName: "diagram.png", mimeType: "image/png", byteSize: 12 },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ message: { id: "msg_att_1" } }), { status: 201 });
    }) as typeof fetch;

    try {
      const smallFile = new File(["hello"], "note.txt", { type: "text/plain" });
      const singleAtt = await apiV1.uploadWorkspaceFile("conv_1", smallFile);
      expect(singleAtt.id).toBe("att_single");
      expect(singleAtt.downloadUrl).toBe("/api/workspace/files/att_single/download");
      expect(singleAtt.url).toBe("/api/workspace/files/att_single/download");

      const largeFile = new File(["0123456789AB"], "diagram.png", { type: "image/png" });
      const chunkedAtt = await apiV1.uploadWorkspaceFile("conv_1", largeFile);
      expect(chunkedAtt.id).toBe("att_chunked");
      expect(chunkedAtt.url).toBe("/api/workspace/files/att_chunked/preview");
      expect(calls.some((c) => c.url === "/api/workspace/files/uploads/up_chunked/parts/1")).toBe(true);
      expect(calls.some((c) => c.url === "/api/workspace/files/uploads/up_chunked/parts/2")).toBe(true);
      expect(calls.some((c) => c.url === "/api/workspace/files/uploads/up_chunked/complete")).toBe(true);

      await apiV1.sendMessage("conv_1", "", {
        clientMessageId: "cli_att_only",
        attachmentIds: ["att_chunked"],
      });
      const msgCall = calls.find((c) => c.url === "/api/workspace/messages");
      expect(JSON.parse(String(msgCall?.body))).toEqual({
        conversationId: "conv_1",
        clientMessageId: "cli_att_only",
        replyToMessageId: "",
        content: {
          format: "duallane.message+json;v=1",
          plainText: "[文件]",
          blocks: [{ type: "attachment", attachmentId: "att_chunked" }],
        },
      });
    } finally {
      globalThis.fetch = origFetch;
    }
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

      // Crisp SVG icons & Liquid Vibrancy Panes brand mark rendered instead of raw OS chrome emojis or "DL" text placeholder
      expect(railHtml).toContain("<svg");
      expect(railHtml).toContain('data-brand-mark="vibrancy-panes"');
      expect(railHtml).not.toContain(">DL<");
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

  it("renders BrandLogo Liquid Vibrancy Panes optical geometry across detail, 16px compact, tile, and monochrome modes", () => {
    expect(DESIGN_TOKENS.modes.dark.direct).toBe("#fb923c");

    const detailHtml = renderToStaticMarkup(<BrandLogo size={36} withTile label="DualLane" />);
    expect(detailHtml).toContain('data-brand-mark="vibrancy-panes"');
    expect(detailHtml).toContain('data-optical-mode="detail"');
    expect(detailHtml).toContain('aria-label="DualLane"');
    expect(detailHtml).toContain('stroke-width="2"');
    expect(detailHtml).toContain("#F97316");
    expect(detailHtml).toContain("#0EA5E9");

    const compactHtml = renderToStaticMarkup(<BrandLogo size={16} />);
    expect(compactHtml).toContain('data-optical-mode="compact"');
    expect(compactHtml).toContain('stroke-width="0"');

    const monoHtml = renderToStaticMarkup(<BrandLogo size={24} monochrome />);
    expect(monoHtml).toContain('fill="currentColor"');
    expect(monoHtml).not.toContain("<linearGradient");
  });

  it("excludes system messages and duplicate projections from unread badges during group creation and recall", async () => {
    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    const origWindow = globalThis.window;
    const origWebSocket = globalThis.WebSocket;

    class FakeWorkspaceSocket {
      static instances: FakeWorkspaceSocket[] = [];
      private listeners: Record<string, Array<(ev: { data: string }) => void>> = {};
      url: string;
      constructor(url: string) {
        this.url = url;
        FakeWorkspaceSocket.instances.push(this);
      }
      addEventListener(type: string, cb: (ev: { data: string }) => void) {
        this.listeners[type] = this.listeners[type] || [];
        this.listeners[type]!.push(cb);
      }
      send() {}
      close() {}
      emitFrame(frame: unknown) {
        const data = JSON.stringify(frame);
        for (const cb of this.listeners.message || []) {
          cb({ data });
        }
      }
    }

    vi.spyOn(apiV1, "getBootstrap").mockResolvedValue({
      auth: {
        enabled: true,
        currentUser: { id: "usr_member_b", nickname: "晓明", role: "member" },
      },
      members: [
        { id: "usr_owner_a", nickname: "群主", role: "owner" },
        { id: "usr_member_b", nickname: "晓明", role: "member" },
      ],
      conversations: [
        { id: "conv_saved_b", type: "saved", title: "个人空间", unreadCount: 0 },
      ],
      eventCursor: 10,
    });

    try {
      (globalThis as unknown as { window: unknown }).window = {
        location: { protocol: "http:", host: "127.0.0.1:5173", search: "" },
      };
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWorkspaceSocket;

      await useWorkspaceStore.getState().bootstrapWorkspace();
      const ws = FakeWorkspaceSocket.instances.at(-1)!;
      expect(ws).toBeTruthy();

      // 1. Owner creates group: conversation.created + message.created(system) arrive in same batch
      ws.emitFrame({
        type: "event",
        event: {
          seq: 11,
          type: "conversation.created",
          conversationId: "conv_new_grp",
          payload: {
            conversation: {
              id: "conv_new_grp",
              type: "group",
              title: "新群未读测试",
              unreadCount: 0,
              latestMessages: [
                {
                  id: "msg_sys_1",
                  conversationId: "conv_new_grp",
                  kind: "system",
                  plainText: "群主 创建了群聊「新群未读测试」",
                  createdAt: "2026-11-14T05:00:00Z",
                },
              ],
            },
          },
        },
      });
      ws.emitFrame({
        type: "event",
        event: {
          seq: 12,
          type: "message.created",
          conversationId: "conv_new_grp",
          payload: {
            conversationId: "conv_new_grp",
            message: {
              id: "msg_sys_1",
              conversationId: "conv_new_grp",
              kind: "system",
              plainText: "群主 创建了群聊「新群未读测试」",
              createdAt: "2026-11-14T05:00:00Z",
            },
            conversation: {
              id: "conv_new_grp",
              type: "group",
              title: "新群未读测试",
              unreadCount: 0,
            },
          },
        },
      });

      expect(useWorkspaceStore.getState().conversations["conv_new_grp"]?.unreadCount).toBe(0);
      expect(useWorkspaceStore.getState().messagesByConv["conv_new_grp"]).toHaveLength(1);

      // 2. Owner sends 1 human message -> 2 visible rows (1 system + 1 user), unreadCount MUST be 1 (not 3!)
      ws.emitFrame({
        type: "event",
        event: {
          seq: 13,
          type: "message.created",
          conversationId: "conv_new_grp",
          payload: {
            conversationId: "conv_new_grp",
            message: {
              id: "msg_user_1",
              conversationId: "conv_new_grp",
              kind: "user",
              authorId: "usr_owner_a",
              authorName: "群主",
              plainText: "第一条真实群消息",
              createdAt: "2026-11-14T05:00:05Z",
            },
            conversation: {
              id: "conv_new_grp",
              type: "group",
              title: "新群未读测试",
              unreadCount: 1,
            },
          },
        },
      });

      expect(useWorkspaceStore.getState().messagesByConv["conv_new_grp"]).toHaveLength(2);
      expect(useWorkspaceStore.getState().conversations["conv_new_grp"]?.unreadCount).toBe(1);

      // 3. Even without server conversation payload, system messages and recalls never inflate unreadCount
      ws.emitFrame({
        type: "event",
        event: {
          seq: 14,
          type: "message.created",
          conversationId: "conv_new_grp",
          payload: {
            conversationId: "conv_new_grp",
            message: {
              id: "msg_sys_2",
              conversationId: "conv_new_grp",
              kind: "system",
              plainText: "群主 修改了群名称",
              createdAt: "2026-11-14T05:00:08Z",
            },
          },
        },
      });
      expect(useWorkspaceStore.getState().conversations["conv_new_grp"]?.unreadCount).toBe(1);

      ws.emitFrame({
        type: "event",
        event: {
          seq: 15,
          type: "message.recalled",
          conversationId: "conv_new_grp",
          payload: {
            conversationId: "conv_new_grp",
            message: {
              id: "msg_user_1",
              conversationId: "conv_new_grp",
              kind: "user",
              authorId: "usr_owner_a",
              plainText: "消息已撤回",
              createdAt: "2026-11-14T05:00:05Z",
            },
          },
        },
      });
      expect(useWorkspaceStore.getState().conversations["conv_new_grp"]?.unreadCount).toBe(1);
    } finally {
      vi.restoreAllMocks();
      (globalThis as unknown as { window: unknown }).window = origWindow;
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = origWebSocket;
      Object.assign(useWorkspaceStore.getInitialState(), prevWsInitial);
      useWorkspaceStore.setState(prevWsInitial);
    }
  });

  it("hides Workspace-only rail controls and quota pill when browsing as an unauthenticated P2P guest", () => {
    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    const prevLaneInitial = { ...useLaneStore.getInitialState() };

    try {
      const guestLane = { ...prevLaneInitial, activeLane: "p2p" as const };
      Object.assign(useLaneStore.getInitialState(), guestLane);
      useLaneStore.setState(guestLane);

      const guestWs = {
        ...prevWsInitial,
        isPreviewMode: false,
        authStatus: "unauthenticated" as const,
        currentUser: null,
        connectionStatus: "offline" as const,
      };
      Object.assign(useWorkspaceStore.getInitialState(), guestWs);
      useWorkspaceStore.setState(guestWs);

      const railHtml = renderToStaticMarkup(
        <TooltipProvider>
          <PrimaryRail />
        </TooltipProvider>
      );
      expect(railHtml).not.toContain('aria-label="机器人与集成"');
      expect(railHtml).not.toContain(">0%<");
      expect(railHtml).toContain(">访<");
      expect(railHtml).toContain('data-testid="dual-lane-deck-switch"');
      expect(railHtml).toContain('data-active-lane="p2p"');
      expect(railHtml).toContain('data-front-card="p2p"');
      expect(railHtml).toContain(">直连<");
    } finally {
      Object.assign(useWorkspaceStore.getInitialState(), prevWsInitial);
      useWorkspaceStore.setState(prevWsInitial);
      Object.assign(useLaneStore.getInitialState(), prevLaneInitial);
      useLaneStore.setState(prevLaneInitial);
    }
  });

  it("consolidates lane switching onto top-left DualLaneDeckSwitch with front/back crystal card layering and cross-lane status badges", () => {
    const fixture = buildDevPreviewFixture();
    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    const prevLaneInitial = { ...useLaneStore.getInitialState() };

    try {
      const wsSnapshot = {
        ...prevWsInitial,
        isPreviewMode: true,
        authStatus: "authenticated" as const,
        currentUser: fixture.currentUser,
        conversations: fixture.conversations,
        conversationOrder: fixture.conversationOrder,
        p2pRoom: {
          roomId: "RoomDeck01",
          keyFingerprint: "A1B2-C3D4",
          connectedPeers: 2,
          remotePeerCount: 1,
          status: "peer_connected" as const,
          shareUrl: "http://localhost:5173/direct/RoomDeck01#k=k_test",
        },
      };
      Object.assign(useWorkspaceStore.getInitialState(), wsSnapshot);
      useWorkspaceStore.setState(wsSnapshot);

      // 1. Workspace active: blue workspace card on top (rendered after amber back card), P2P live dot shown
      const wsLane = { ...prevLaneInitial, activeLane: "workspace" as const };
      Object.assign(useLaneStore.getInitialState(), wsLane);
      useLaneStore.setState(wsLane);

      const wsRailHtml = renderToStaticMarkup(
        <TooltipProvider>
          <PrimaryRail />
        </TooltipProvider>
      );
      expect(wsRailHtml).toContain('data-testid="dual-lane-deck-switch"');
      expect(wsRailHtml).toContain('data-front-card="workspace"');
      expect(wsRailHtml).toContain('data-card-lane="workspace" data-card-depth="front"');
      expect(wsRailHtml).toContain('data-card-lane="p2p" data-card-depth="back"');
      expect(wsRailHtml.indexOf('data-card-lane="p2p"')).toBeLessThan(
        wsRailHtml.indexOf('data-card-lane="workspace"')
      );
      expect(wsRailHtml).toContain('data-testid="deck-p2p-active-dot"');
      expect(wsRailHtml).toContain(">空间<");

      // 2. P2P active: amber direct card on top (rendered after blue back card), Workspace unread badge shown
      const p2pLane = { ...prevLaneInitial, activeLane: "p2p" as const };
      Object.assign(useLaneStore.getInitialState(), p2pLane);
      useLaneStore.setState(p2pLane);

      const p2pRailHtml = renderToStaticMarkup(
        <TooltipProvider>
          <PrimaryRail />
        </TooltipProvider>
      );
      expect(p2pRailHtml).toContain('data-front-card="p2p"');
      expect(p2pRailHtml).toContain('data-card-lane="p2p" data-card-depth="front"');
      expect(p2pRailHtml).toContain('data-card-lane="workspace" data-card-depth="back"');
      expect(p2pRailHtml.indexOf('data-card-lane="workspace"')).toBeLessThan(
        p2pRailHtml.indexOf('data-card-lane="p2p"')
      );
      expect(p2pRailHtml).toContain('data-testid="deck-workspace-unread-dot"');
      expect(p2pRailHtml).toContain(">直连<");
    } finally {
      Object.assign(useWorkspaceStore.getInitialState(), prevWsInitial);
      useWorkspaceStore.setState(prevWsInitial);
      Object.assign(useLaneStore.getInitialState(), prevLaneInitial);
      useLaneStore.setState(prevLaneInitial);
    }
  });

  it("enforces stealth governance: ordinary members see zero admin entry points or privileged peer labels, while owner/admin see SpaceAdminConsole entry", () => {
    const fixture = buildDevPreviewFixture();
    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    const prevLaneInitial = { ...useLaneStore.getInitialState() };

    try {
      // 1. Ordinary member: NO "空间治理台" button on PrimaryRail, NO "空间所有者"/"管理员" peer labels in InspectorPane, and <SpaceAdminConsole /> renders empty
      const memberLane = {
        ...prevLaneInitial,
        activeLane: "workspace" as const,
        inspectorOpen: true,
        inspectorTab: "details" as const,
        adminConsoleOpen: true,
      };
      Object.assign(useLaneStore.getInitialState(), memberLane);
      useLaneStore.setState(memberLane);

      const memberWs = {
        ...prevWsInitial,
        isPreviewMode: false,
        authStatus: "authenticated" as const,
        currentUser: { id: "usr_member_1", displayName: "普通成员晓明", role: "member" as const },
        members: {
          ...fixture.members,
          usr_member_1: { id: "usr_member_1", displayName: "普通成员晓明", role: "member" as const },
        },
        conversations: fixture.conversations,
        conversationOrder: fixture.conversationOrder,
        activeConversationId: "conv_arch",
      };
      Object.assign(useWorkspaceStore.getInitialState(), memberWs);
      useWorkspaceStore.setState(memberWs);

      const memberRailHtml = renderToStaticMarkup(
        <TooltipProvider>
          <PrimaryRail />
        </TooltipProvider>
      );
      expect(memberRailHtml).not.toContain('aria-label="空间治理台"');

      const memberInspectorHtml = renderToStaticMarkup(<InspectorPane />);
      expect(memberInspectorHtml).toContain(">空间成员<");
      expect(memberInspectorHtml).not.toContain("空间所有者");
      expect(memberInspectorHtml).not.toContain(">管理员<");

      const leakedConsoleHtml = renderToStaticMarkup(<SpaceAdminConsole />);
      expect(leakedConsoleHtml).toBe("");

      // 2. Owner/Admin: sees "空间治理台" entry on PrimaryRail, while everyday InspectorPane STILL avoids flaunting peer hierarchy
      const ownerWs = {
        ...memberWs,
        currentUser: fixture.currentUser, // role: "owner"
      };
      Object.assign(useWorkspaceStore.getInitialState(), ownerWs);
      useWorkspaceStore.setState(ownerWs);

      const ownerRailHtml = renderToStaticMarkup(
        <TooltipProvider>
          <PrimaryRail />
        </TooltipProvider>
      );
      expect(ownerRailHtml).toContain('aria-label="空间治理台"');

      const ownerInspectorHtml = renderToStaticMarkup(<InspectorPane />);
      expect(ownerInspectorHtml).toContain(">空间成员<");
      expect(ownerInspectorHtml).not.toContain("空间所有者");
      expect(ownerInspectorHtml).not.toContain(">管理员<");
    } finally {
      Object.assign(useWorkspaceStore.getInitialState(), prevWsInitial);
      useWorkspaceStore.setState(prevWsInitial);
      Object.assign(useLaneStore.getInitialState(), prevLaneInitial);
      useLaneStore.setState(prevLaneInitial);
    }
  });

  it("hydrates group creator nickname from conversation.members under directory isolation and never displays raw usr_* IDs", () => {
    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    const prevLaneInitial = { ...useLaneStore.getInitialState() };

    try {
      // Simulate Go directory visibility isolation: top-level bootstrap.members only has usr_member_b,
      // while shared group conversation.members includes usr_owner's masked Member record.
      const parsed = parseBootstrapPayload({
        auth: {
          enabled: true,
          currentUser: { id: "usr_member_b", nickname: "测试成员B", role: "member" },
        },
        members: [{ id: "usr_member_b", nickname: "测试成员B", role: "member" }],
        conversations: [
          {
            id: "conv_isolated_grp",
            type: "group",
            title: "隔离目录昵称测试群",
            memberIds: ["usr_owner", "usr_member_b", "usr_unknown_ghost"],
            members: [
              { id: "usr_owner", nickname: "timeStarry", role: "member" },
              { id: "usr_member_b", nickname: "测试成员B", role: "member" },
            ],
          },
        ],
      });

      expect(parsed.members["usr_owner"]?.displayName).toBe("timeStarry");

      const laneSnapshot = {
        ...prevLaneInitial,
        activeLane: "workspace" as const,
        inspectorOpen: true,
        inspectorTab: "details" as const,
      };
      Object.assign(useLaneStore.getInitialState(), laneSnapshot);
      useLaneStore.setState(laneSnapshot);

      const wsSnapshot = {
        ...prevWsInitial,
        authStatus: "authenticated" as const,
        currentUser: parsed.currentUser,
        members: parsed.members,
        conversations: parsed.conversations,
        conversationOrder: parsed.conversationOrder,
        activeConversationId: "conv_isolated_grp",
      };
      Object.assign(useWorkspaceStore.getInitialState(), wsSnapshot);
      useWorkspaceStore.setState(wsSnapshot);

      const inspectorHtml = renderToStaticMarkup(<InspectorPane />);
      expect(inspectorHtml).toContain("timeStarry");
      expect(inspectorHtml).toContain("测试成员B");
      expect(inspectorHtml).not.toContain("usr_owner");
      expect(inspectorHtml).not.toContain("usr_unknown_ghost");
    } finally {
      Object.assign(useWorkspaceStore.getInitialState(), prevWsInitial);
      useWorkspaceStore.setState(prevWsInitial);
      Object.assign(useLaneStore.getInitialState(), prevLaneInitial);
      useLaneStore.setState(prevLaneInitial);
    }
  });

  it("restores activeLane and entryView from URLs and keeps Home Entry Portal pure & uncluttered", () => {
    expect(inferLaneFromLocation({ pathname: "/direct", search: "" })).toBe("p2p");
    expect(inferMobileViewFromLocation({ pathname: "/direct" })).toBe("list");
    expect(inferLaneFromLocation({ pathname: "/direct/Rm123", search: "" })).toBe("p2p");
    expect(inferMobileViewFromLocation({ pathname: "/direct/Rm123" })).toBe("chat");
    expect(inferLaneFromLocation({ pathname: "/r/Rm123", search: "" })).toBe("p2p");
    expect(inferLaneFromLocation({ pathname: "/workspace", search: "" })).toBe("workspace");
    expect(inferLaneFromLocation({ pathname: "/", search: "?lane=p2p" })).toBe("p2p");
    expect(inferEntryViewFromLocation({ pathname: "/", search: "" })).toBe("entry");
    expect(inferEntryViewFromLocation({ pathname: "/workspace", search: "" })).toBe("workspace");
    expect(inferEntryViewFromLocation({ pathname: "/", search: "?invite=INV-1" })).toBe("workspace");
    expect(inferEntryViewFromLocation({ pathname: "/", search: "?error=access_denied" })).toBe(
      "workspace"
    );

    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    const prevLaneInitial = { ...useLaneStore.getInitialState() };
    try {
      const homeLane = {
        ...prevLaneInitial,
        activeLane: "workspace" as const,
        entryView: "entry" as const,
      };
      Object.assign(useLaneStore.getInitialState(), homeLane);
      useLaneStore.setState(homeLane);

      const homeWs = {
        ...prevWsInitial,
        isPreviewMode: false,
        authStatus: "unauthenticated" as const,
        workspaceAvailability: "disabled" as const,
        currentUser: null,
        p2pRoom: null,
      };
      Object.assign(useWorkspaceStore.getInitialState(), homeWs);
      useWorkspaceStore.setState(homeWs);

      // 1. "/" Entry Portal stays serene & pure: two choice cards + theme switcher, ZERO login inputs or service warnings
      const homeHtml = renderToStaticMarkup(<AppV1 />);
      expect(homeHtml).toContain('data-testid="home-card-direct"');
      expect(homeHtml).toContain('data-testid="home-card-workspace"');
      expect(homeHtml).toContain("选择沟通方式");
      expect(homeHtml).toContain("开始临时会话");
      expect(homeHtml).toContain("进入共享空间");
      expect(homeHtml).not.toContain("空间邀请码");
      expect(homeHtml).not.toContain("共享空间服务当前未启用");

      // 2. "/workspace" Sign-In View renders focused login card with back button
      const wsLoginLane = { ...homeLane, entryView: "workspace" as const };
      Object.assign(useLaneStore.getInitialState(), wsLoginLane);
      useLaneStore.setState(wsLoginLane);

      const wsLoginHtml = renderToStaticMarkup(<AppV1 />);
      expect(wsLoginHtml).toContain("登录后进入共享空间");
      expect(wsLoginHtml).toContain("使用 GitHub 登录共享空间");
      expect(wsLoginHtml).toContain("返回选择");
    } finally {
      Object.assign(useWorkspaceStore.getInitialState(), prevWsInitial);
      useWorkspaceStore.setState(prevWsInitial);
      Object.assign(useLaneStore.getInitialState(), prevLaneInitial);
      useLaneStore.setState(prevLaneInitial);
    }
  });

  it("supports peer-equal group settings (rename, avatar, pin conversation, invite, leave) for ordinary members", async () => {
    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    const prevLaneInitial = { ...useLaneStore.getInitialState() };
    const origFetch = globalThis.fetch;

    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const body = init?.body ? String(init.body) : undefined;
      calls.push({ url, method, body });

      if (url === "/api/v1/conversations/conv_grp_peer" && method === "PATCH") {
        const parsed = JSON.parse(body || "{}");
        return new Response(
          JSON.stringify({
            conversation: {
              id: "conv_grp_peer",
              kind: "group",
              title: parsed.title ?? "产品共创群",
              avatarUrl: parsed.avatar ?? parsed.avatarUrl ?? "🚀",
              memberIds: ["usr_owner", "usr_member_peer"],
              members: [
                { id: "usr_owner", displayName: "Owner", role: "member" },
                { id: "usr_member_peer", displayName: "普通群友", role: "member" },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url === "/api/v1/conversations/conv_grp_peer/members" && method === "POST") {
        return new Response(
          JSON.stringify({
            conversation: {
              id: "conv_grp_peer",
              kind: "group",
              title: "新群名",
              avatarUrl: "🚀",
              memberIds: ["usr_owner", "usr_member_peer", "usr_friend_c"],
              members: [
                { id: "usr_owner", displayName: "Owner", role: "member" },
                { id: "usr_member_peer", displayName: "普通群友", role: "member" },
                { id: "usr_friend_c", displayName: "新成员C", role: "member" },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url === "/api/v1/preferences" && method === "PUT") {
        return new Response(body || "{}", { status: 200 });
      }
      if (url === "/api/v1/conversations/conv_grp_peer/leave" && method === "POST") {
        return new Response(JSON.stringify({ ok: true, conversationId: "conv_grp_peer" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const laneSnapshot = {
        ...prevLaneInitial,
        activeLane: "workspace" as const,
        inspectorOpen: true,
        inspectorTab: "details" as const,
      };
      Object.assign(useLaneStore.getInitialState(), laneSnapshot);
      useLaneStore.setState(laneSnapshot);

      const wsSnapshot = {
        ...prevWsInitial,
        isPreviewMode: false,
        authStatus: "authenticated" as const,
        currentUser: { id: "usr_member_peer", displayName: "普通群友", role: "member" as const },
        members: {
          usr_owner: { id: "usr_owner", displayName: "Owner", role: "member" as const },
          usr_member_peer: {
            id: "usr_member_peer",
            displayName: "普通群友",
            role: "member" as const,
          },
          usr_friend_c: { id: "usr_friend_c", displayName: "新成员C", role: "member" as const },
        },
        conversations: {
          conv_saved: {
            id: "conv_saved",
            kind: "saved" as const,
            title: "我的收藏",
            unreadCount: 0,
            mentionCount: 0,
            pinnedMessageIds: [],
            memberIds: ["usr_member_peer"],
          },
          conv_other: {
            id: "conv_other",
            kind: "group" as const,
            title: "日常群",
            unreadCount: 0,
            mentionCount: 0,
            pinnedMessageIds: [],
            memberIds: ["usr_owner", "usr_member_peer"],
          },
          conv_grp_peer: {
            id: "conv_grp_peer",
            kind: "group" as const,
            title: "产品共创群",
            unreadCount: 0,
            mentionCount: 0,
            pinnedMessageIds: [],
            memberIds: ["usr_owner", "usr_member_peer"],
          },
        },
        conversationOrder: ["conv_saved", "conv_other", "conv_grp_peer"],
        pinnedConversationIds: [],
        userPreferences: {},
        activeConversationId: "conv_grp_peer",
      };
      Object.assign(useWorkspaceStore.getInitialState(), wsSnapshot);
      useWorkspaceStore.setState(wsSnapshot);

      // Header exposes clear "群聊设置" entry and Inspector exposes full peer-equal group controls
      const timelineHeaderHtml = renderToStaticMarkup(
        <TooltipProvider>
          <TimelinePane />
        </TooltipProvider>
      );
      expect(timelineHeaderHtml).toContain('aria-label="群聊设置"');
      expect(timelineHeaderHtml).not.toContain("支持置顶与线程讨论");

      const inspectorHtml = renderToStaticMarkup(<InspectorPane />);
      expect(inspectorHtml).toContain("群聊设置");
      expect(inspectorHtml).toContain('aria-label="群聊名称"');
      expect(inspectorHtml).toContain("上传群头像图片");
      expect(inspectorHtml).toContain('aria-label="置顶会话"');
      expect(inspectorHtml).toContain("邀请成员");
      expect(inspectorHtml).toContain("退出群聊");

      // Execute peer-equal mutations as ordinary member
      await useWorkspaceStore
        .getState()
        .updateGroupProfile("conv_grp_peer", { title: "新群名", avatar: "🚀" });
      expect(useWorkspaceStore.getState().conversations["conv_grp_peer"]?.title).toBe("新群名");
      expect(useWorkspaceStore.getState().conversations["conv_grp_peer"]?.avatarEmoji).toBe("🚀");

      await useWorkspaceStore.getState().togglePinConversation("conv_grp_peer");
      expect(useWorkspaceStore.getState().pinnedConversationIds).toContain("conv_grp_peer");
      Object.assign(useWorkspaceStore.getInitialState(), useWorkspaceStore.getState());

      // Pinned conversation sorts right after "我的收藏" and ahead of unpinned conversations
      const sidebarHtml = renderToStaticMarkup(
        <TooltipProvider>
          <ConversationSidebar />
        </TooltipProvider>
      );
      expect(sidebarHtml.indexOf("我的收藏")).toBeLessThan(sidebarHtml.indexOf("新群名"));
      expect(sidebarHtml.indexOf("新群名")).toBeLessThan(sidebarHtml.indexOf("日常群"));
      expect(sidebarHtml).toContain('aria-label="已置顶会话"');
      expect(sidebarHtml).toContain("🚀");

      await useWorkspaceStore.getState().inviteGroupMembers("conv_grp_peer", ["usr_friend_c"]);
      expect(useWorkspaceStore.getState().conversations["conv_grp_peer"]?.memberIds).toContain(
        "usr_friend_c"
      );

      await useWorkspaceStore.getState().leaveGroup("conv_grp_peer");
      expect(useWorkspaceStore.getState().conversations["conv_grp_peer"]).toBeUndefined();
      const writeRoutes = calls
        .filter((c) => c.method !== "GET")
        .map((c) => `${c.method} ${c.url}`);
      expect(writeRoutes).toEqual([
        "PATCH /api/v1/conversations/conv_grp_peer",
        "PUT /api/v1/preferences",
        "POST /api/v1/conversations/conv_grp_peer/members",
        "POST /api/v1/conversations/conv_grp_peer/leave",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      Object.assign(useWorkspaceStore.getInitialState(), prevWsInitial);
      useWorkspaceStore.setState(prevWsInitial);
      Object.assign(useLaneStore.getInitialState(), prevLaneInitial);
      useLaneStore.setState(prevLaneInitial);
    }
  });

  it("renders inline image messages cleanly without redundant download strips while keeping file download buttons for non-image attachments", () => {
    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    const prevLaneInitial = { ...useLaneStore.getInitialState() };

    try {
      // 1. Workspace timeline: image/png vs application/pdf
      const wsLane = { ...prevLaneInitial, activeLane: "workspace" as const };
      Object.assign(useLaneStore.getInitialState(), wsLane);
      useLaneStore.setState(wsLane);

      const wsState = {
        ...prevWsInitial,
        authStatus: "authenticated" as const,
        currentUser: { id: "usr_me", displayName: "我", role: "member" as const },
        conversations: {
          conv_media: {
            id: "conv_media",
            kind: "group" as const,
            title: "媒体测试群",
            unreadCount: 0,
            mentionCount: 0,
            pinnedMessageIds: [],
            memberIds: ["usr_me"],
          },
        },
        conversationOrder: ["conv_media"],
        activeConversationId: "conv_media",
        messagesByConv: {
          conv_media: [
            {
              id: "msg_img_1",
              conversationId: "conv_media",
              senderId: "usr_me",
              senderName: "我",
              plainText: "[文件]",
              createdAt: "2026-11-14T10:00:00Z",
              status: "sent" as const,
              reactions: {},
              attachments: [
                {
                  id: "att_img_1",
                  fileName: "photo.png",
                  mimeType: "image/png",
                  byteSize: 20480,
                  url: "/api/workspace/files/att_img_1/preview",
                  downloadUrl: "/api/workspace/files/att_img_1/download",
                },
              ],
            },
            {
              id: "msg_pdf_1",
              conversationId: "conv_media",
              senderId: "usr_me",
              senderName: "我",
              plainText: "[文件]",
              createdAt: "2026-11-14T10:01:00Z",
              status: "sent" as const,
              reactions: {},
              attachments: [
                {
                  id: "att_pdf_1",
                  fileName: "spec.pdf",
                  mimeType: "application/pdf",
                  byteSize: 102400,
                  url: "/api/workspace/files/att_pdf_1/download",
                  downloadUrl: "/api/workspace/files/att_pdf_1/download",
                },
              ],
            },
          ],
        },
      };
      Object.assign(useWorkspaceStore.getInitialState(), wsState);
      useWorkspaceStore.setState(wsState);

      const wsHtml = renderToStaticMarkup(
        <TooltipProvider>
          <TimelinePane />
        </TooltipProvider>
      );
      expect(wsHtml).toContain('aria-label="预览图片 photo.png"');
      expect(wsHtml).not.toContain('aria-label="下载 photo.png"');
      expect(wsHtml).not.toContain('aria-label="查看附件 photo.png"');
      expect(wsHtml).toContain('aria-label="查看附件 spec.pdf"');
      expect(wsHtml).toContain('aria-label="下载 spec.pdf"');

      // 2. P2P timeline: image/webp vs application/zip
      const p2pLane = { ...prevLaneInitial, activeLane: "p2p" as const };
      Object.assign(useLaneStore.getInitialState(), p2pLane);
      useLaneStore.setState(p2pLane);

      const p2pState = {
        ...wsState,
        p2pRoom: {
          roomId: "RmImg01",
          keyFingerprint: "11:22:33:44",
          connectedPeers: 2,
          remotePeerCount: 1,
          status: "peer_connected" as const,
          shareUrl: "http://127.0.0.1:5173/direct/RmImg01#k=secret",
        },
        p2pMessages: [
          {
            id: "p2p_img_1",
            senderName: "我",
            isOwn: true,
            text: "",
            createdAt: "2026-11-14T10:02:00Z",
            deliveryStatus: "delivered" as const,
            reactions: {},
            attachment: {
              fileName: "shot.webp",
              mimeType: "image/webp",
              byteSize: 8192,
              blobUrl: "blob:http://127.0.0.1:5173/fake-webp",
            },
          },
          {
            id: "p2p_zip_1",
            senderName: "我",
            isOwn: true,
            text: "",
            createdAt: "2026-11-14T10:03:00Z",
            deliveryStatus: "delivered" as const,
            reactions: {},
            attachment: {
              fileName: "archive.zip",
              mimeType: "application/zip",
              byteSize: 65536,
              blobUrl: "blob:http://127.0.0.1:5173/fake-zip",
            },
          },
        ],
      };
      Object.assign(useWorkspaceStore.getInitialState(), p2pState);
      useWorkspaceStore.setState(p2pState);

      const p2pHtml = renderToStaticMarkup(
        <TooltipProvider>
          <TimelinePane />
        </TooltipProvider>
      );
      expect(p2pHtml).toContain('aria-label="预览图片 shot.webp"');
      expect(p2pHtml).not.toContain('aria-label="下载 shot.webp"');
      expect(p2pHtml).toContain('aria-label="下载 archive.zip"');
    } finally {
      Object.assign(useWorkspaceStore.getInitialState(), prevWsInitial);
      useWorkspaceStore.setState(prevWsInitial);
      Object.assign(useLaneStore.getInitialState(), prevLaneInitial);
      useLaneStore.setState(prevLaneInitial);
    }
  });

  it("upgrades 主题色 with color swatches and drives --dl-shared, --dl-accent, and --dl-focus with WCAG AA contrast", () => {
    // 1. Every theme accent has swatch + WCAG AA (>= 4.5:1) foreground contrast in both Light and Dark modes
    for (const [id, spec] of Object.entries(DESIGN_TOKENS.accents)) {
      expect(spec.swatch, `${id} swatch`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(contrastRatio(spec.onLight, spec.light), `${id} light contrast`).toBeGreaterThanOrEqual(
        4.5
      );
      expect(contrastRatio(spec.onDark, spec.dark), `${id} dark contrast`).toBeGreaterThanOrEqual(
        4.5
      );
    }

    // 2. CSS custom properties propagate the selected theme color across shared lane, primary accent, and focus ring
    const origDocument = globalThis.document;
    const vars = new Map<string, string>();
    const fakeRoot = {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (k: string, v: string) => {
          vars.set(k, v);
        },
        getPropertyValue: (k: string) => vars.get(k) || "",
      },
    };
    try {
      (globalThis as unknown as { document: unknown }).document = { documentElement: fakeRoot };
      applyVibrancyTokensToRoot("light", "emerald", "glass", false);
      expect(vars.get("--dl-shared")).toBe(DESIGN_TOKENS.accents.emerald.light);
      expect(vars.get("--dl-accent")).toBe(DESIGN_TOKENS.accents.emerald.light);
      expect(vars.get("--dl-focus")).toBe(DESIGN_TOKENS.accents.emerald.light);
      expect(vars.get("--dl-on-shared")).toBe(DESIGN_TOKENS.accents.emerald.onLight);
      expect(vars.get("--dl-on-accent")).toBe(DESIGN_TOKENS.accents.emerald.onLight);

      applyVibrancyTokensToRoot("dark", "indigo", "solid", false);
      expect(vars.get("--dl-shared")).toBe(DESIGN_TOKENS.accents.indigo.dark);
      expect(vars.get("--dl-accent")).toBe(DESIGN_TOKENS.accents.indigo.dark);
      expect(vars.get("--dl-on-shared")).toBe(DESIGN_TOKENS.accents.indigo.onDark);
    } finally {
      (globalThis as unknown as { document: unknown }).document = origDocument;
    }

    // 3. Theme selector renders circular color swatches on options
    const workbenchHtml = renderToStaticMarkup(<WorkbenchV1 />);
    expect(workbenchHtml).toContain('aria-label="主题色"');
    expect(workbenchHtml).toContain('data-testid="theme-swatch-azure"');
    expect(workbenchHtml).toContain('data-testid="theme-swatch-indigo"');
    expect(workbenchHtml).toContain('data-testid="theme-swatch-emerald"');
    expect(workbenchHtml).toContain('data-testid="theme-swatch-copper"');
    expect(workbenchHtml).toContain('data-testid="theme-swatch-graphite"');
  });

  it("single-shot v1 bootstrap skips waterfall round-trips and hydrates cached shell instantly", async () => {
    const prevWsInitial = { ...useWorkspaceStore.getInitialState() };
    useWorkspaceStore.setState(prevWsInitial);
    const origWindow = (globalThis as unknown as { window?: unknown }).window;
    const memStorage = new Map<string, string>();
    const fakeLocalStorage = {
      getItem: (k: string) => memStorage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memStorage.set(k, v);
      },
      removeItem: (k: string) => {
        memStorage.delete(k);
      },
    };

    const ensureSavedSpy = vi.spyOn(apiV1, "ensureSavedConversation");
    const getPrefsSpy = vi.spyOn(apiV1, "getPreferences");
    const syncSpy = vi.spyOn(apiV1, "sync");
    vi.spyOn(apiV1, "listMessages").mockResolvedValue({
      messages: [
        {
          id: "msg_fast_1",
          authorId: "usr_fast_1",
          authorNickname: "星辰",
          plainText: "秒开首屏",
          createdAt: "2026-11-14T10:00:00Z",
        },
      ],
    });
    vi.spyOn(apiV1, "getBootstrap").mockResolvedValue({
      auth: {
        enabled: true,
        currentUser: { id: "usr_fast_1", displayName: "星辰", role: "owner" },
      },
      policy: { dailyQuotaBytes: 2147483648, usedTodayBytes: 4096 },
      preferences: { pinnedConversationIds: ["conv_grp_fast"] },
      members: [{ id: "usr_fast_1", displayName: "星辰", role: "owner" }],
      conversations: [
        {
          id: "conv_saved_fast",
          type: "saved",
          title: "个人空间",
          displayTitle: "我的收藏",
          unreadCount: 0,
          memberIds: ["usr_fast_1"],
          pinnedMessageIds: [],
        },
        {
          id: "conv_grp_fast",
          type: "group",
          title: "极速协作群",
          displayTitle: "极速协作群",
          unreadCount: 2,
          memberIds: ["usr_fast_1"],
          pinnedMessageIds: [],
          lastMessagePlainText: "秒开首屏",
        },
      ],
      eventCursor: 88,
    });

    try {
      (globalThis as unknown as { window: unknown }).window = {
        location: { protocol: "https:", host: "duallane.tsio.top", pathname: "/workspace", search: "" },
        localStorage: fakeLocalStorage,
      };

      // 1. Cold load: single /api/v1/bootstrap resolves everything with zero waterfall round-trips
      await useWorkspaceStore.getState().bootstrapWorkspace();
      expect(useWorkspaceStore.getState().authStatus).toBe("authenticated");
      expect(useWorkspaceStore.getState().pinnedConversationIds).toEqual(["conv_grp_fast"]);
      expect(ensureSavedSpy).not.toHaveBeenCalled();
      expect(getPrefsSpy).not.toHaveBeenCalled();
      expect(syncSpy).not.toHaveBeenCalled();
      expect(memStorage.has("duallane:v1:shell-snapshot:v1")).toBe(true);

      // 2. Warm reload on /workspace: hydrates cached shell synchronously BEFORE network resolves
      useWorkspaceStore.setState(prevWsInitial);
      let resolveSlowBootstrap!: (val: Record<string, unknown>) => void;
      vi.spyOn(apiV1, "getBootstrap").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSlowBootstrap = resolve;
          })
      );

      const pendingBootstrap = useWorkspaceStore.getState().bootstrapWorkspace();
      expect(useWorkspaceStore.getState().authStatus).toBe("authenticated");
      expect(useWorkspaceStore.getState().connectionStatus).toBe("reconnecting");
      expect(useWorkspaceStore.getState().conversations.conv_grp_fast?.title).toBe("极速协作群");

      resolveSlowBootstrap({
        auth: {
          enabled: true,
          currentUser: { id: "usr_fast_1", displayName: "星辰", role: "owner" },
        },
        preferences: { pinnedConversationIds: ["conv_grp_fast"] },
        members: [{ id: "usr_fast_1", displayName: "星辰", role: "owner" }],
        conversations: [
          { id: "conv_saved_fast", type: "saved", title: "个人空间", memberIds: ["usr_fast_1"] },
          { id: "conv_grp_fast", type: "group", title: "极速协作群", memberIds: ["usr_fast_1"] },
        ],
        eventCursor: 89,
      });
      await pendingBootstrap;
      expect(useWorkspaceStore.getState().connectionStatus).toBe("connected");

      // 3. Logout wipes cached shell snapshot immediately
      vi.spyOn(apiV1, "logout").mockResolvedValue({ ok: true });
      await useWorkspaceStore.getState().logout();
      expect(memStorage.has("duallane:v1:shell-snapshot:v1")).toBe(false);
    } finally {
      (globalThis as unknown as { window: unknown }).window = origWindow;
      vi.restoreAllMocks();
    }
  });
});
