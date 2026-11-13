import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DualLaneCardKitDocument } from "@duallane/protocol";
import { parseBootstrapPayload } from "@/entities/workspace/store";
import { apiV1 } from "@/shared/lib/api-v1";
import {
  decryptP2PPayload,
  deriveAesKey,
  encryptP2PPayload,
  generateRoomKeyString,
} from "@/shared/lib/p2p-lane";
import { applyVibrancyTokensToRoot } from "@/shared/theme/vibrancy";
import { DualLaneCardKit } from "@/widgets/DualLaneCardKit";

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
});
