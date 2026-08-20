import { AlertCircle, ArrowRight, Bot, Check, Hash, ListChecks, MapPin, Megaphone, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { createWorkspaceJsonHeaders } from "./workspace-http";

export type WorkspaceCardBlock = {
  type: "card";
  cardId: string;
  cardType: string;
  schemaVersion: number;
  fallbackText: string;
};

const SUPPORTED_WORKSPACE_CARD_KEYS = new Set([
  "workspace.topic-created@1",
  "workspace.topic-message-synced@1",
  "echo.solicitation@1",
  "echo.request@1",
  "echo.request-status@1",
  "echo.request-list@1",
  "echo.release@1"
]);

export function supportsWorkspaceInteractiveCard(block: WorkspaceCardBlock) {
  return SUPPORTED_WORKSPACE_CARD_KEYS.has(`${block.cardType}@${block.schemaVersion}`);
}

export type WorkspaceCardProjection = {
  block: WorkspaceCardBlock;
  payload: Record<string, unknown>;
  status: "active" | "invalidated" | "expired";
  revision: number;
  actions: string[];
};

type WorkspaceCardFallbackProjection = {
  type: "card_fallback";
  reason: string;
  block: WorkspaceCardBlock;
  fallbackText: string;
  status: "active" | "invalidated" | "expired";
  revision: number;
};

export function WorkspaceInteractiveCard({
  block,
  onOpenTopic,
  revisionSignal = 0
}: {
  block: WorkspaceCardBlock;
  onOpenTopic?: (topicId: string) => void;
  revisionSignal?: number;
}) {
  const [card, setCard] = useState<WorkspaceCardProjection | null>(null);
  const [fallback, setFallback] = useState<WorkspaceCardFallbackProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setFallback(null);
    void fetch(`/api/workspace/cards/${encodeURIComponent(block.cardId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "卡片不可访问或已失效" : "卡片加载失败");
        return await response.json() as { card: WorkspaceCardProjection | WorkspaceCardFallbackProjection };
      })
      .then((result) => {
        if (cancelled) return;
        if (isCardFallbackProjection(result.card)) {
          setCard(null);
          setFallback(result.card);
        } else {
          setCard(result.card);
          setFallback(null);
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "卡片加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [block.cardId, revisionSignal, reloadVersion]);

  if (loading) {
    return (
      <div className="workspace-interactive-card loading" aria-busy="true" aria-label={`正在加载 ${block.fallbackText}`}>
        <span className="workspace-card-loading-icon" />
        <span className="workspace-card-loading-lines"><i /><i /></span>
      </div>
    );
  }

  if (fallback) {
    return (
      <div className="workspace-card-fallback" role="status">
        <strong>{fallback.fallbackText || block.fallbackText}</strong>
        <small>此卡片暂不支持交互</small>
      </div>
    );
  }

  if (!card || error) {
    return (
      <div className="workspace-interactive-card unavailable" role="status">
        <AlertCircle size={18} aria-hidden="true" />
        <span><strong>{block.fallbackText}</strong><small>{error || "此卡片暂不可用"}</small></span>
        <button className="icon-button" type="button" title="重新加载卡片" onClick={() => setReloadVersion((version) => version + 1)}>
          <RefreshCw size={15} />
        </button>
      </div>
    );
  }

  if (card.block.cardType === "workspace.topic-created" || card.block.cardType === "workspace.topic-message-synced") {
    return <WorkspaceTopicCard card={card} onOpenTopic={onOpenTopic} />;
  }
  if (card.block.cardType === "echo.release") {
    return <WorkspaceEchoReleaseCard card={card} />;
  }
  if (card.block.cardType.startsWith("echo.")) {
    return <WorkspaceEchoCard card={card} onRefresh={() => setReloadVersion((version) => version + 1)} />;
  }

  return (
    <div className="workspace-interactive-card generic" role="group" aria-label={card.block.fallbackText}>
      <Bot size={18} aria-hidden="true" />
      <span><strong>{card.block.fallbackText}</strong><small>{card.status === "active" ? "结构化消息" : cardStatusLabel(card.status)}</small></span>
    </div>
  );
}

export function WorkspaceEchoReleaseCard({ card }: { card: WorkspaceCardProjection }) {
  const payload = card.payload;
  const version = stringValue(payload.version);
  const title = stringValue(payload.title) || card.block.fallbackText;
  const summary = stringValue(payload.summary);
  const sections = arrayOfObjects(payload.sections);
  const releasedAt = formatReleaseDate(stringValue(payload.releasedAt));
  return (
    <article className={`workspace-interactive-card echo echo-release${card.status === "active" ? "" : " unavailable"}`} role="group" aria-label={`DualLane v${version} 版本更新 ${title}`}>
      <header className="workspace-release-card-header">
        <span className="workspace-card-kind-icon"><Megaphone size={18} aria-hidden="true" /></span>
        <span className="workspace-card-copy">
          <small>版本更新{version ? ` · v${version}` : ""}{releasedAt ? ` · ${releasedAt}` : ""}</small>
          <strong>{title}</strong>
          {summary && <span>{summary}</span>}
        </span>
      </header>
      <div className="workspace-release-sections">
        {sections.map((section, sectionIndex) => (
          <section key={`${stringValue(section.title)}-${sectionIndex}`}>
            <h4>{stringValue(section.title)}</h4>
            <div>
              {arrayOfObjects(section.items).map((item, itemIndex) => (
                <div className="workspace-release-item" key={`${stringValue(item.title)}-${itemIndex}`}>
                  <strong>{stringValue(item.title)}</strong>
                  <p>{stringValue(item.description)}</p>
                  <span className="workspace-release-location"><MapPin size={14} aria-hidden="true" /><span>{stringValue(item.location)}</span></span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}

function WorkspaceTopicCard({
  card,
  onOpenTopic
}: {
  card: WorkspaceCardProjection;
  onOpenTopic?: (topicId: string) => void;
}) {
  const payload = card.payload;
  const topicId = stringValue(payload.topicId);
  const title = stringValue(payload.title) || card.block.fallbackText.replace(/^#/, "");
  const description = stringValue(payload.descriptionPreview) || stringValue(payload.messagePreview);
  const participantCount = numberValue(payload.participantCount);
  const status = stringValue(payload.status);
  const synced = card.block.cardType === "workspace.topic-message-synced";
  return (
    <div className={`workspace-interactive-card topic${card.status === "active" ? "" : " unavailable"}`} role="group" aria-label={`${synced ? "群聊同步话题" : "群聊话题"} ${title}`}>
      <span className="workspace-card-kind-icon"><Hash size={18} aria-hidden="true" /></span>
      <span className="workspace-card-copy">
        <small>{synced ? "来自话题" : "群聊话题"}</small>
        <strong>#{title}</strong>
        {description && <span>{description}</span>}
        <em>{participantCount === null ? "" : `${participantCount} 人参与`}{status ? `${participantCount === null ? "" : " · "}${topicStatusLabel(status)}` : ""}</em>
      </span>
      {topicId && card.status === "active" && onOpenTopic && (
        <button className="workspace-card-open" type="button" onClick={() => onOpenTopic(topicId)}>
          打开话题
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function WorkspaceEchoCard({ card, onRefresh }: { card: WorkspaceCardProjection; onRefresh: () => void }) {
  const [payload, setPayload] = useState(card.payload);
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>(stringArray(card.payload.selectedOptionIds));
  const [action, setAction] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setPayload(card.payload);
    setSelectedOptionIds(stringArray(card.payload.selectedOptionIds));
    setAction("");
    setError("");
  }, [card.payload, card.revision]);

  const publicId = stringValue(payload.publicId);
  const title = stringValue(payload.title) || card.block.fallbackText;
  const state = stringValue(payload.status) || stringValue(payload.state) || stringValue(payload.phase);
  const summary = stringValue(payload.summary) || stringValue(payload.description) || stringValue(payload.response);
  const itemCount = Array.isArray(payload.items) ? payload.items.length : null;
  const kind = card.block.cardType.includes("solicitation") ? "需求征集" : card.block.cardType.includes("list") ? "需求列表" : "需求反馈";
  const isSolicitation = card.block.cardType === "echo.solicitation";
  const isRequirement = card.block.cardType === "echo.request" || card.block.cardType === "echo.request-status";
  const status = stringValue(payload.status) || stringValue(payload.state);
  const options = arrayOfObjects(payload.options);
  const choiceMode = stringValue(payload.choiceMode) || "single";
  const requirementAction = status === "pending_review"
    ? { id: "collect", label: "转为正式需求" }
    : status === "planned"
      ? { id: "start", label: "开始处理" }
      : status === "in_progress"
        ? { id: "implement", label: "标记已交付" }
        : null;

  async function runSolicitationVote() {
    if (!publicId || action || !selectedOptionIds.length || !card.actions.includes("vote")) return;
    setAction("vote"); setError("");
    try {
      await runWorkspaceCardAction(card, "vote", {
        optionIds: selectedOptionIds
      });
      onRefresh();
    } catch (caught) { setError(cardErrorMessage(caught)); }
    finally { setAction(""); }
  }

  async function runRequirementTransition(actionId: string) {
    if (!publicId || action || !card.actions.includes(actionId)) return;
    setAction(actionId); setError("");
    try {
      await runWorkspaceCardAction(card, actionId, {});
      onRefresh();
    } catch (caught) { setError(cardErrorMessage(caught)); }
    finally { setAction(""); }
  }

  return (
    <div className={`workspace-interactive-card echo${card.status === "active" ? "" : " unavailable"}`} role="group" aria-label={`${kind} ${title}`}>
      <span className="workspace-card-kind-icon"><ListChecks size={18} aria-hidden="true" /></span>
      <span className="workspace-card-copy">
        <small>{kind}{publicId ? ` · ${publicId}` : ""}</small>
        <strong>{title}</strong>
        {summary && <span>{summary}</span>}
        <em>{itemCount === null ? echoStateLabel(state) : `${itemCount} 条记录`}</em>
      </span>
      {isSolicitation && status === "open" && card.actions.includes("vote") && (
        <div className="workspace-card-choice-list" aria-label={stringValue(payload.question) || "选择投票选项"}>
          {options.map((option) => {
            const optionId = stringValue(option.id);
            const chosen = selectedOptionIds.includes(optionId);
            const count = numberValue(option.count);
            return <label key={optionId} className={chosen ? "selected" : ""}>
              <input type={choiceMode === "multiple" ? "checkbox" : "radio"} name={`echo-${publicId}`} checked={chosen} onChange={() => {
                setSelectedOptionIds((current) => choiceMode === "multiple"
                  ? chosen ? current.filter((id) => id !== optionId) : [...current, optionId]
                  : [optionId]);
              }} />
              <span>{stringValue(option.label)}</span>{count !== null && <em>{count}</em>}
            </label>;
          })}
          <button className="secondary compact" type="button" disabled={Boolean(action) || !selectedOptionIds.length} onClick={() => void runSolicitationVote()}>{action === "vote" ? "正在提交" : <><Check size={14} />提交投票</>}</button>
        </div>
      )}
      {isRequirement && requirementAction && card.actions.includes(requirementAction.id) && (
        <div className="workspace-card-inline-actions" aria-label="需求处理">
          <button type="button" className="secondary compact" disabled={Boolean(action)} onClick={() => void runRequirementTransition(requirementAction.id)}>{action === requirementAction.id ? "正在更新" : requirementAction.label}</button>
        </div>
      )}
      {error && <p className="workspace-card-action-error" role="alert">{error}</p>}
    </div>
  );
}

async function cardJson<T>(path: string, options: RequestInit) {
  const response = await fetch(path, { ...options, headers: createWorkspaceJsonHeaders({ headers: options.headers, body: options.body }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.error?.message === "string" ? payload.error.message : "操作未完成，请稍后重试");
  return payload as T;
}

async function runWorkspaceCardAction(card: WorkspaceCardProjection, actionId: string, input: Record<string, unknown>) {
  const invocationId = clientActionId(actionId);
  return cardJson<{ action: { revision: number; replayed: boolean; result: Record<string, unknown> } }>(
    `/api/workspace/cards/${encodeURIComponent(card.block.cardId)}/actions`,
    {
      method: "POST",
      body: JSON.stringify({
        actionId,
        input,
        expectedRevision: card.revision,
        clientActionId: invocationId
      })
    }
  );
}

function clientActionId(action: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `echo-card:${action}:${random}`;
}

function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function arrayOfObjects(value: unknown) { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function cardErrorMessage(error: unknown) { return error instanceof Error ? error.message : "操作未完成，请稍后重试"; }

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isCardFallbackProjection(value: WorkspaceCardProjection | WorkspaceCardFallbackProjection): value is WorkspaceCardFallbackProjection {
  return "type" in value && value.type === "card_fallback";
}

function cardStatusLabel(status: WorkspaceCardProjection["status"]) {
  return status === "expired" ? "卡片已过期" : "卡片已失效";
}

function topicStatusLabel(status: string) {
  return status === "open" ? "进行中" : status === "closed" ? "已关闭" : status === "archived" ? "已归档" : status;
}

function echoStateLabel(state: string) {
  const labels: Record<string, string> = {
    pending_review: "待处理",
    planned: "已计划",
    in_progress: "进行中",
    delivered: "已交付",
    archived: "已归档",
    draft: "草稿",
    open: "征集中",
    closed: "已结束",
    withdrawn: "已撤回"
  };
  return labels[state] || state || "状态已更新";
}

function formatReleaseDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}
