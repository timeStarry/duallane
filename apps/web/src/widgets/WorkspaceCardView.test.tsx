import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiV1 } from "@/shared/lib/api-v1";
import {
  projectWorkspaceCard, readWorkspaceCardReferences, type WorkspaceCardReference,
} from "@/shared/lib/workspace-cards";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { WorkspaceCardBody, WorkspaceCardView } from "./WorkspaceCardView";

const reference: WorkspaceCardReference = {
  cardId: "card-test", cardType: "feishu.adaptive.v1", schemaVersion: 1, fallbackText: "安全的降级文本",
};
const resolution = () => ({
  type: "card", id: "card-test", block: { type: "card", ...reference }, status: "active", revision: 7,
  actions: ["confirm", "cancel"],
  payload: {
    format: "duallane.feishu-card.v1", header: { title: "接入测试卡片", tone: "shared" },
    elements: [
      { type: "text", format: "markdown", text: "请 **确认** 这次测试" },
      { type: "divider" },
      { type: "note", parts: [{ format: "plain", text: "**保持原样** <script>alert(1)</script>" }] },
      { type: "columns", columns: [{ width: "weighted", weight: 1, elements: [{ type: "text", format: "plain", text: "可见列" }] }] },
      { type: "actions", buttons: [
        { type: "button", label: "确认", actionId: "confirm", style: "primary", data: { action: "business-data", private: "server-only" } },
        { type: "button", label: "取消", actionId: "cancel", style: "default", data: {} },
      ] },
    ],
  },
});
beforeEach(() => {
  useWorkspaceStore.setState({
    currentUser: null, authStatus: "unauthenticated", isPreviewMode: false,
    cardRevisions: {}, messagesByConv: {}, members: {}, conversations: {}, activeConversationId: null,
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("actual Workspace card consumer", () => {
  it("reads canonical references without trusting embedded payloads or duplicating references", () => {
    const raw = { type: "card", ...reference, payload: resolution().payload };
    expect(readWorkspaceCardReferences({ blocks: [{ type: "text", text: "伴随文本" }, raw, raw] })).toEqual([reference]);
    expect(readWorkspaceCardReferences({ blocks: [{ ...raw, schemaVersion: -1 }, { type: "card_fallback", ...reference }] })).toEqual([]);
  });

  it("projects real normalized Go elements and renders body, fixed buttons and escaped plain content", () => {
    const card = projectWorkspaceCard(reference, resolution());
    expect(card).not.toBeNull();
    const html = renderToStaticMarkup(<WorkspaceCardBody card={card!} onAction={() => undefined} />);
    expect(html).toContain("接入测试卡片");
    expect(html).toMatch(/<strong[^>]*>确认<\/strong>/);
    expect(html).toContain("可见列");
    expect(html).toContain("**保持原样**");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain(">确认</button>");
    expect(html).toContain(">取消</button>");
    expect(JSON.stringify(card)).not.toContain("server-only");
    expect(JSON.stringify(card)).not.toContain("business-data");
  });

  it("fails closed for future versions, mismatched identities, unknown controls and deep payloads", () => {
    expect(projectWorkspaceCard({ ...reference, schemaVersion: 2 }, resolution())).toBeNull();
    expect(projectWorkspaceCard(reference, { ...resolution(), id: "another-private-card" })).toBeNull();
    expect(projectWorkspaceCard(reference, { ...resolution(), payload: { ...resolution().payload, elements: [{ type: "iframe", url: "javascript:alert(1)" }] } })).toBeNull();
    let nested: unknown[] = [];
    for (let i = 0; i < 12; i++) nested = [{ type: "columns", columns: [{ elements: nested }] }];
    expect(projectWorkspaceCard(reference, { ...resolution(), payload: { ...resolution().payload, elements: nested } })).toBeNull();
  });

  it("renders unavailable actions disabled and locks all buttons after acknowledgement or expiry", () => {
    const card = projectWorkspaceCard(reference, { ...resolution(), actions: [] })!;
    expect((renderToStaticMarkup(<WorkspaceCardBody card={card} onAction={() => undefined} />).match(/disabled=""/g) || []).length).toBe(2);
    const active = projectWorkspaceCard(reference, resolution())!;
    expect((renderToStaticMarkup(<WorkspaceCardBody card={active} locked onAction={() => undefined} />).match(/disabled=""/g) || []).length).toBe(2);
    expect(renderToStaticMarkup(<WorkspaceCardBody card={{ ...active, status: "expired" }} onAction={() => undefined} />)).toContain("卡片已过期");
  });

  it("does not expose stored card content or request it in an unauthenticated/preview render", () => {
    const fetch = vi.spyOn(apiV1, "resolveCard");
    const html = renderToStaticMarkup(<WorkspaceCardView reference={reference} />);
    expect(html).toContain(reference.fallbackText);
    expect(html).not.toContain("接入测试卡片");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps canonical references in the actual store, invalidates by monotonic revision and clears on recall", () => {
    const store = useWorkspaceStore.getState();
    store.applyRealtimeEvent({ type: "message.created", payload: { message: {
      id: "message-card", conversationId: "group-card", authorId: "bot-test", kind: "bot",
      plainText: reference.fallbackText, content: { blocks: [{ type: "card", ...reference }] },
    } } });
    const message = useWorkspaceStore.getState().messagesByConv["group-card"]?.[0];
    expect(message?.cardReferences).toEqual([reference]);
    expect(message?.card).toBeUndefined();
    store.applyRealtimeEvent({ type: "card.updated", payload: { cardId: reference.cardId, revision: 9, status: "active", payload: { title: "not a document" } } });
    store.applyRealtimeEvent({ type: "card.updated", payload: { cardId: reference.cardId, revision: 8 } });
    expect(useWorkspaceStore.getState().cardRevisions[reference.cardId]).toBe(9);
    expect(useWorkspaceStore.getState().messagesByConv["group-card"]?.[0]?.card).toBeUndefined();
    store.applyRealtimeEvent({ type: "message.recalled", payload: { message: {
      id: "message-card", conversationId: "group-card", recalledAt: "2026-11-18T03:00:00Z",
    } } });
    expect(useWorkspaceStore.getState().messagesByConv["group-card"]?.[0]?.cardReferences).toBeUndefined();
  });

  it("sends an explicit retry with the exact same operation key, empty input and original revision", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ action: { ok: true, replayed: calls.length > 1, revision: 7 } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
    await apiV1.invokeCardAction(reference.cardId, "confirm", {}, 7, "original-action-key");
    await apiV1.invokeCardAction(reference.cardId, "confirm", {}, 7, "original-action-key");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      actionId: "confirm", clientActionId: "original-action-key", expectedRevision: 7, input: {},
    });
  });
});
