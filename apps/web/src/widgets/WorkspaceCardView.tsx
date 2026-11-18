import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { ApiClientError, apiV1 } from "@/shared/lib/api-v1";
import { renderChatMarkdown } from "@/shared/lib/chat-markdown";
import {
  projectWorkspaceCard, type WorkspaceCardDocument, type WorkspaceCardReference,
} from "@/shared/lib/workspace-cards";
import { Button } from "@/shared/ui";

type Attempt = { actionId: string; revision: number; clientActionId: string };

/** The same registry projection is used by the real Timeline and its renderer. */
export function WorkspaceCardBody({ card, locked = false, onAction }: {
  card: WorkspaceCardDocument; locked?: boolean; onAction: (actionId: string) => void;
}) {
  const disabled = locked || card.status !== "active";
  return <div className="dl-glass-elevated w-full max-w-md min-w-0 space-y-3 overflow-hidden rounded-2xl border border-dl-border-hairline p-3.5 [overflow-wrap:anywhere]">
    {card.blocks.map((block, index) => {
      if (block.type === "header") return <header key={index} className="space-y-1">
        <h4 className="text-sm font-semibold text-dl-text-primary">{block.title}</h4>
        {block.subtitle && <p className="text-xs text-dl-text-tertiary">{block.subtitle}</p>}
      </header>;
      if (block.type === "markdown") return <div key={index} className="text-sm leading-relaxed text-dl-text-primary whitespace-pre-wrap">
        {block.plainText ? block.content : renderChatMarkdown(block.content, "workspace", card.cardId + ":" + index)}
      </div>;
      if (block.type === "divider") return <hr key={index} className="border-dl-border-hairline" />;
      if (block.type === "actions") return <div key={index} className="flex flex-wrap gap-2">
        {block.elements.filter((button) => button.type === "button").map((button) =>
          <Button key={button.actionId} type="button" size="sm"
            variant={button.style === "primary" ? "primary" : button.style === "danger" ? "danger" : "secondary"}
            disabled={disabled || button.disabled} onClick={() => onAction(button.actionId)}>
            {button.label}
          </Button>)}
      </div>;
      return null;
    })}
    {card.status !== "active" && <p className="border-t border-dl-border-hairline pt-2 text-[11px] text-dl-text-tertiary">
      {card.status === "expired" ? "卡片已过期" : "卡片已失效"}
    </p>}
  </div>;
}

export function WorkspaceCardView({ reference }: { reference: WorkspaceCardReference }) {
  const actorId = useWorkspaceStore((state) => state.currentUser?.id);
  const authenticated = useWorkspaceStore((state) => state.authStatus === "authenticated");
  const preview = useWorkspaceStore((state) => state.isPreviewMode);
  if (!actorId || !authenticated || preview) {
    return <section aria-label="助手交互卡片" className="text-sm text-dl-text-secondary whitespace-pre-wrap">{reference.fallbackText}</section>;
  }
  return <AuthorizedWorkspaceCard key={actorId + ":" + reference.cardId} reference={reference} actorId={actorId} />;
}

function AuthorizedWorkspaceCard({ reference, actorId }: { reference: WorkspaceCardReference; actorId: string }) {
  const revision = useWorkspaceStore((state) => state.cardRevisions[reference.cardId] || 0);
  const [reload, setReload] = useState(0);
  const [load, setLoad] = useState<{ key: string; card: WorkspaceCardDocument | null }>({ key: "", card: null });
  const [notice, setNotice] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [sending, setSending] = useState(false);
  const [acknowledgedRevision, setAcknowledgedRevision] = useState(0);
  const attempt = useRef<Attempt | null>(null);
  const busy = useRef(false), mounted = useRef(true);
  const { cardId, cardType, schemaVersion, fallbackText } = reference;
  const queryKey = [actorId, cardId, cardType, schemaVersion, fallbackText, revision, reload].join("\u0000");
  const loading = load.key !== queryKey;
  const card = loading ? null : load.card;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void apiV1.resolveCard(cardId).then((response) => {
      if (cancelled) return;
      const resolved = projectWorkspaceCard({ cardId, cardType, schemaVersion, fallbackText }, response.card);
      setLoad({ key: queryKey, card: resolved && resolved.revision >= revision ? resolved : null });
    }).catch(() => { if (!cancelled) setLoad({ key: queryKey, card: null }); });
    return () => { cancelled = true; };
  }, [cardId, cardType, schemaVersion, fallbackText, revision, queryKey]);

  const submit = async (actionId: string) => {
    if (busy.current || !card || card.status !== "active") return;
    const request = attempt.current ?? {
      actionId, revision: card.revision, clientActionId: "act_" + crypto.randomUUID(),
    };
    if (request.actionId !== actionId) return;
    attempt.current = request; busy.current = true; setSending(true); setNotice("");
    try {
      // The card's saved business data is authoritative. Client input stays empty.
      const response = await apiV1.invokeCardAction(cardId, request.actionId, {}, request.revision, request.clientActionId);
      if (!mounted.current) return;
      const outcome = response.action;
      if (!outcome || typeof outcome !== "object" || !("ok" in outcome) || outcome.ok !== true) {
        throw new Error("Card action receipt is unconfirmed");
      }
      attempt.current = null;
      setUnknown(false);
      setAcknowledgedRevision(request.revision);
      setNotice("操作已提交，等待助手更新");
      setReload((value) => value + 1);
    } catch (error) {
      if (!mounted.current) return;
      const uncertain = !(error instanceof ApiClientError) || error.status === 0 || error.status >= 500;
      setUnknown(uncertain);
      if (uncertain) {
        setNotice("操作结果尚未确认。重试会沿用原操作编号，请勿重复发起新操作。");
      } else {
        attempt.current = null;
        setNotice([401, 403, 404].includes(error.status)
          ? "当前无法使用此卡片，请确认会话权限" : "卡片状态已变化，请刷新后核对");
        setReload((value) => value + 1);
      }
    } finally {
      if (mounted.current) { busy.current = false; setSending(false); }
    }
  };
  return <section aria-label="助手交互卡片" data-card-id={cardId} className="min-w-0 max-w-full">
    {card ? <WorkspaceCardBody card={card} locked={unknown || sending || card.revision <= acknowledgedRevision}
      onAction={(actionId) => { void submit(actionId); }} /> : <div className="rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle p-3.5 text-sm whitespace-pre-wrap">
      <div>{fallbackText || "卡片暂不可用"}</div>
      <p role="status" className="mt-1 text-xs text-dl-text-tertiary">{loading ? "正在读取卡片…" : "无法显示此卡片，内容或权限可能已变化"}</p>
      {!loading && <Button type="button" variant="ghost" size="sm" onClick={() => setReload((value) => value + 1)}>重新读取卡片</Button>}
    </div>}
    {notice && <p role="status" className="mt-1 text-xs text-dl-text-tertiary">{notice}</p>}
    {unknown && <Button type="button" variant="secondary" size="sm" className="mt-2"
      disabled={sending || !card || card.status !== "active"}
      onClick={() => { if (attempt.current) void submit(attempt.current.actionId); }}>重试同一操作</Button>}
  </section>;
}
