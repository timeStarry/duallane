import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  ExternalLink,
  FilterX,
  Inbox,
  Plus,
  RefreshCw,
  Search,
  UserRound,
  UsersRound,
  X
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { createWorkspaceJsonHeaders } from "./workspace-http";

type RequirementPhase = "proposal" | "formal" | "archived";
type RequirementStatus = "pending_review" | "planned" | "in_progress" | "delivered" | "archived";
type ArchiveOutcome = "implemented" | "rejected" | "duplicate" | "withdrawn" | "cancelled";
type RequirementType = "requirement" | "suggestion" | "problem";

type EchoRequirement = {
  id: string;
  publicId: string;
  submitterUserId: string;
  submitterDisplayName?: string | null;
  submitterGithubLogin?: string | null;
  type: RequirementType;
  title: string;
  detail: string;
  scenario: string;
  expectedResult: string;
  relatedLink?: string | null;
  phase: RequirementPhase;
  status: RequirementStatus;
  archiveOutcome?: ArchiveOutcome | null;
  duplicateOfPublicId?: string | null;
  revision: number;
  response?: string | null;
  createdAt: string;
  updatedAt: string;
};

type EchoHistoryItem = {
  id: string;
  fromPhase?: RequirementPhase | null;
  fromStatus?: RequirementStatus | null;
  toPhase: RequirementPhase;
  toStatus: RequirementStatus;
  response?: string | null;
  actorUserId: string;
  revision: number;
  createdAt: string;
};

type EchoStats = {
  total: number;
  byPhase: Partial<Record<RequirementPhase, number>>;
  byStatus: Partial<Record<RequirementStatus, number>>;
};

type EchoFilters = {
  phase: "" | RequirementPhase;
  status: "" | RequirementStatus;
  archiveOutcome: "" | ArchiveOutcome;
  type: "" | RequirementType;
  submitterUserId: string;
  createdFrom: string;
  createdTo: string;
};

type EchoSolicitationStatus = "draft" | "open" | "closed" | "withdrawn";
type EchoSolicitation = {
  publicId: string;
  title: string;
  description: string;
  question: string;
  options: Array<{ id: string; label: string; position: number }>;
  choiceMode: "single" | "multiple";
  minSelections: number;
  maxSelections: number;
  allowVoteChange: boolean;
  resultVisibility: "aggregate" | "owner";
  deliveryPolicy: "all_active_members" | "none";
  status: EchoSolicitationStatus;
  deadline?: string | null;
  revision: number;
  counts?: Record<string, number> | null;
  selectedOptionIds?: string[];
  voteCount?: number | null;
  ownerProjection?: { deliverySummary?: Record<string, number>; canViewVoters?: boolean } | null;
};

type EchoDelivery = { id: string; recipientUserId: string; recipientDisplayName?: string | null; status: string; attemptCount: number; lastErrorCode?: string | null; deliveredAt?: string | null; updatedAt: string };
type EchoVote = { voterUserId: string; voterDisplayName?: string | null; optionIds: string[]; createdAt: string; updatedAt: string };

type NoticeTone = "success" | "warning" | "info";

const EMPTY_FILTERS: EchoFilters = {
  phase: "",
  status: "",
  archiveOutcome: "",
  type: "",
  submitterUserId: "",
  createdFrom: "",
  createdTo: ""
};

export function WorkspaceEchoRequirements({
  onBack,
  onNotice
}: {
  onBack: () => void;
  onNotice: (tone: NoticeTone, message: string) => void;
}) {
  const [requirements, setRequirements] = useState<EchoRequirement[]>([]);
  const [stats, setStats] = useState<EchoStats | null>(null);
  const [filters, setFilters] = useState<EchoFilters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selectedPublicId, setSelectedPublicId] = useState("");
  const [selected, setSelected] = useState<EchoRequirement | null>(null);
  const [history, setHistory] = useState<EchoHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);

  const queryString = useMemo(() => buildRequirementQuery(filters, offset), [filters, offset]);
  const submitters = useMemo(() => {
    const values = new Map<string, string>();
    for (const requirement of requirements) {
      values.set(requirement.submitterUserId, requirement.submitterDisplayName || requirement.submitterGithubLogin || requirement.submitterUserId);
    }
    return [...values.entries()].sort((left, right) => left[1].localeCompare(right[1], "zh-CN"));
  }, [requirements]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      echoJson<{ requirements: EchoRequirement[] }>(`/api/workspace/echo/requirements?${queryString}`),
      offset === 0 ? echoJson<{ stats: EchoStats }>("/api/workspace/echo/requirements/stats") : Promise.resolve(null)
    ])
      .then(([listResult, statsResult]) => {
        if (cancelled) return;
        setRequirements((current) => offset === 0 ? listResult.requirements : mergeRequirements(current, listResult.requirements));
        setHasMore(listResult.requirements.length === 50);
        if (statsResult) setStats(statsResult.stats);
        setError("");
      })
      .catch((caught) => {
        if (!cancelled) setError(echoErrorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [offset, queryString, refreshVersion]);

  useEffect(() => {
    if (!selectedPublicId) {
      setSelected(null);
      setHistory([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void Promise.all([
      echoJson<{ requirement: EchoRequirement }>(`/api/workspace/echo/requirements/${encodeURIComponent(selectedPublicId)}`),
      echoJson<{ history: EchoHistoryItem[] }>(`/api/workspace/echo/requirements/${encodeURIComponent(selectedPublicId)}/history`)
    ])
      .then(([detailResult, historyResult]) => {
        if (cancelled) return;
        setSelected(detailResult.requirement);
        setHistory(historyResult.history);
      })
      .catch((caught) => {
        if (!cancelled) {
          onNotice("warning", echoErrorMessage(caught));
          setSelectedPublicId("");
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [onNotice, refreshVersion, selectedPublicId]);

  function updateFilter<Key extends keyof EchoFilters>(key: Key, value: EchoFilters[Key]) {
    setFilters((current) => ({ ...current, [key]: value }));
    setOffset(0);
  }

  function reload() {
    setOffset(0);
    setRefreshVersion((version) => version + 1);
  }

  return (
    <section className={`workspace-echo-page${selectedPublicId ? " detail-open" : ""}`} aria-label="回声需求管理">
      <header className="workspace-echo-header">
        <button className="icon-button" type="button" title="返回空间设置" onClick={onBack}><ArrowLeft size={17} /></button>
        <span className="workspace-echo-heading-icon" aria-hidden="true"><ClipboardList size={19} /></span>
        <div><p className="eyebrow">回声</p><h2>需求列表</h2><span>查看提案、正式需求和归档结果</span></div>
        <button className="icon-button" type="button" title="刷新需求" disabled={loading} onClick={reload}><RefreshCw size={16} /></button>
      </header>

      <WorkspaceEchoSolicitations onNotice={onNotice} />

      <div className="workspace-echo-stats" aria-label="需求统计">
        <EchoStat label="全部" value={stats?.total} icon={<Inbox size={16} />} />
        <EchoStat label="待审核" value={stats?.byStatus.pending_review} icon={<Clock3 size={16} />} />
        <EchoStat label="推进中" value={(stats?.byStatus.planned ?? 0) + (stats?.byStatus.in_progress ?? 0)} icon={<RefreshCw size={16} />} />
        <EchoStat label="已交付" value={stats?.byStatus.delivered} icon={<CheckCircle2 size={16} />} />
      </div>

      <div className="workspace-echo-filters" aria-label="筛选需求">
        <label><span>阶段</span><select value={filters.phase} onChange={(event) => updateFilter("phase", event.target.value as EchoFilters["phase"])}><option value="">全部</option><option value="proposal">需求提案</option><option value="formal">正式需求</option><option value="archived">归档需求</option></select></label>
        <label><span>状态</span><select value={filters.status} onChange={(event) => updateFilter("status", event.target.value as EchoFilters["status"])}><option value="">全部</option><option value="pending_review">待审核</option><option value="planned">已计划</option><option value="in_progress">进行中</option><option value="delivered">已交付</option><option value="archived">已归档</option></select></label>
        <label><span>结果</span><select value={filters.archiveOutcome} onChange={(event) => updateFilter("archiveOutcome", event.target.value as EchoFilters["archiveOutcome"])}><option value="">全部</option><option value="implemented">已实现</option><option value="rejected">已驳回</option><option value="duplicate">重复提案</option><option value="withdrawn">已撤回</option><option value="cancelled">已取消</option></select></label>
        <label><span>类型</span><select value={filters.type} onChange={(event) => updateFilter("type", event.target.value as EchoFilters["type"])}><option value="">全部</option><option value="requirement">需求</option><option value="suggestion">建议</option><option value="problem">问题</option></select></label>
        <label><span>提交者</span><select value={filters.submitterUserId} onChange={(event) => updateFilter("submitterUserId", event.target.value)}><option value="">全部</option>{submitters.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label><span>开始日期</span><input type="date" value={filters.createdFrom} onChange={(event) => updateFilter("createdFrom", event.target.value)} /></label>
        <label><span>结束日期</span><input type="date" value={filters.createdTo} onChange={(event) => updateFilter("createdTo", event.target.value)} /></label>
        <button className="workspace-echo-clear-filter" type="button" disabled={!hasActiveFilters(filters)} onClick={() => { setFilters(EMPTY_FILTERS); setOffset(0); }}><FilterX size={15} />清除</button>
      </div>

      <div className="workspace-echo-body">
        <div className="workspace-echo-list" aria-busy={loading && offset === 0}>
          {loading && offset === 0 ? <EchoListSkeleton /> : error ? (
            <div className="workspace-echo-empty" role="alert"><Search size={22} /><strong>无法读取需求</strong><span>{error}</span><button className="secondary compact" type="button" onClick={reload}>重试</button></div>
          ) : requirements.length === 0 ? (
            <div className="workspace-echo-empty"><Inbox size={22} /><strong>没有匹配的需求</strong><span>调整筛选条件后再查看。</span></div>
          ) : (
            <>
              {requirements.map((requirement) => (
                <button key={requirement.id} type="button" className={selectedPublicId === requirement.publicId ? "workspace-echo-row active" : "workspace-echo-row"} aria-current={selectedPublicId === requirement.publicId ? "true" : undefined} onClick={() => setSelectedPublicId(requirement.publicId)}>
                  <span className={`workspace-echo-state-marker ${requirement.phase}`} aria-hidden="true" />
                  <span className="workspace-echo-row-copy"><span><em>{requirement.publicId}</em><small>{requirementTypeLabel(requirement.type)}</small></span><strong>{requirement.title}</strong><span><UserRound size={12} />{requirement.submitterDisplayName || requirement.submitterGithubLogin || "成员"}<time>{formatEchoDate(requirement.createdAt)}</time></span></span>
                  <span className={`workspace-echo-status ${requirement.status}`}>{requirementStatusLabel(requirement)}</span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              ))}
              {hasMore && <button className="workspace-echo-load-more" type="button" disabled={loading} onClick={() => setOffset((value) => value + 50)}>{loading ? "加载中" : "加载更多"}</button>}
            </>
          )}
        </div>

        <div className="workspace-echo-detail">
          {detailLoading ? <EchoDetailSkeleton /> : selected ? (
            <EchoRequirementDetail
              requirement={selected}
              history={history}
              onClose={() => setSelectedPublicId("")}
              onChanged={(updated) => {
                setSelected(updated);
                setRequirements((current) => current.map((item) => item.id === updated.id ? updated : item));
                setRefreshVersion((version) => version + 1);
              }}
              onNotice={onNotice}
            />
          ) : (
            <div className="workspace-echo-detail-empty"><ClipboardList size={27} /><strong>选择一条需求</strong><span>在这里查看完整内容、处理历史和下一步操作。</span></div>
          )}
        </div>
      </div>
    </section>
  );
}

function WorkspaceEchoSolicitations({ onNotice }: { onNotice: (tone: NoticeTone, message: string) => void }) {
  const [items, setItems] = useState<EchoSolicitation[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState<{ publicId: string; deliveries: EchoDelivery[]; votes: EchoVote[] } | null>(null);
  const [draft, setDraft] = useState({ title: "", description: "", question: "", options: ["", ""], choiceMode: "single" as "single" | "multiple", allowVoteChange: true, resultVisibility: "aggregate" as "aggregate" | "owner", deliveryPolicy: "all_active_members" as "all_active_members" | "none", deadline: "" });

  const load = () => {
    setLoading(true);
    void echoJson<{ solicitations: EchoSolicitation[] }>("/api/workspace/echo/solicitations?limit=50")
      .then((result) => setItems(result.solicitations))
      .catch((caught) => onNotice("warning", echoErrorMessage(caught)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // Owner-only panel is mounted once per settings visit.

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const options = draft.options.map((option) => option.trim()).filter(Boolean);
    setBusy("create");
    try {
      const result = await echoJson<{ solicitation: EchoSolicitation }>("/api/workspace/echo/solicitations", { method: "POST", body: JSON.stringify({ ...draft, options, deadline: draft.deadline ? new Date(draft.deadline).toISOString() : undefined, idempotencyKey: echoClientId("solicitation-create") }) });
      setItems((current) => [result.solicitation, ...current.filter((item) => item.publicId !== result.solicitation.publicId)]);
      setExpanded(false);
      setDraft({ title: "", description: "", question: "", options: ["", ""], choiceMode: "single", allowVoteChange: true, resultVisibility: "aggregate", deliveryPolicy: "all_active_members", deadline: "" });
      onNotice("success", "征集草稿已创建，请确认后发布。");
    } catch (caught) { onNotice("warning", echoErrorMessage(caught)); }
    finally { setBusy(""); }
  }

  async function transition(item: EchoSolicitation, action: "publish" | "close" | "withdraw") {
    if (busy) return;
    setBusy(`${action}:${item.publicId}`);
    try {
      const result = await echoJson<{ solicitation: EchoSolicitation }>(`/api/workspace/echo/solicitations/${encodeURIComponent(item.publicId)}/${action}`, { method: "POST", body: JSON.stringify({ expectedRevision: item.revision, idempotencyKey: echoClientId(`solicitation-${action}`) }) });
      setItems((current) => current.map((currentItem) => currentItem.publicId === item.publicId ? result.solicitation : currentItem));
      onNotice("success", action === "publish" ? "征集已发布。" : action === "close" ? "征集已关闭。" : "征集已撤回。");
    } catch (caught) { onNotice("warning", echoErrorMessage(caught)); }
    finally { setBusy(""); }
  }

  async function openDetail(item: EchoSolicitation) {
    setBusy(`detail:${item.publicId}`);
    try {
      const [deliveries, votes] = await Promise.all([
        echoJson<{ deliveries: EchoDelivery[] }>(`/api/workspace/echo/solicitations/${encodeURIComponent(item.publicId)}/deliveries`),
        echoJson<{ votes: EchoVote[] }>(`/api/workspace/echo/solicitations/${encodeURIComponent(item.publicId)}/votes`)
      ]);
      setDetail({ publicId: item.publicId, deliveries: deliveries.deliveries, votes: votes.votes });
    } catch (caught) { onNotice("warning", echoErrorMessage(caught)); }
    finally { setBusy(""); }
  }

  async function retryDeliveries(publicId: string) {
    if (busy) return;
    setBusy(`retry:${publicId}`);
    try {
      await echoJson(`/api/workspace/echo/solicitations/${encodeURIComponent(publicId)}/deliveries/retry`, { method: "POST", body: JSON.stringify({ idempotencyKey: echoClientId("solicitation-retry") }) });
      const current = items.find((item) => item.publicId === publicId);
      if (current) await openDetail(current);
      onNotice("success", "已请求重新投递，状态将在刷新后更新。");
    } catch (caught) { onNotice("warning", echoErrorMessage(caught)); }
    finally { setBusy(""); }
  }

  return <section className="workspace-echo-solicitations" aria-labelledby="echo-solicitations-heading">
    <header><div><p className="eyebrow">公开征集</p><h3 id="echo-solicitations-heading">面向所有成员的投票</h3></div><button className="secondary compact" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><Plus size={15} />新建征集</button></header>
    {expanded && <form className="workspace-echo-solicitation-form" onSubmit={(event) => void createDraft(event)}>
      <label><span>标题</span><input required maxLength={120} value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
      <label><span>说明</span><textarea required maxLength={10000} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
      <label><span>投票问题</span><input required maxLength={2000} value={draft.question} onChange={(event) => setDraft((current) => ({ ...current, question: event.target.value }))} /></label>
      <div className="workspace-echo-option-grid">{draft.options.map((option, index) => <label key={index}><span>选项 {index + 1}</span><input required value={option} maxLength={256} onChange={(event) => setDraft((current) => ({ ...current, options: current.options.map((value, itemIndex) => itemIndex === index ? event.target.value : value) }))} /></label>)}</div>
      <button className="workspace-echo-add-option" type="button" disabled={draft.options.length >= 20} onClick={() => setDraft((current) => ({ ...current, options: [...current.options, ""] }))}>添加选项</button>
      <div className="workspace-echo-solicitation-policy"><label><span>投票方式</span><select value={draft.choiceMode} onChange={(event) => setDraft((current) => ({ ...current, choiceMode: event.target.value as "single" | "multiple" }))}><option value="single">单选</option><option value="multiple">多选</option></select></label><label><span>截止时间</span><input type="datetime-local" value={draft.deadline} onChange={(event) => setDraft((current) => ({ ...current, deadline: event.target.value }))} /></label><label><input type="checkbox" checked={draft.allowVoteChange} onChange={(event) => setDraft((current) => ({ ...current, allowVoteChange: event.target.checked }))} />允许改票</label><label><input type="checkbox" checked={draft.resultVisibility === "aggregate"} onChange={(event) => setDraft((current) => ({ ...current, resultVisibility: event.target.checked ? "aggregate" : "owner" }))} />展示汇总结果</label></div>
      <div className="workspace-echo-solicitation-form-actions"><button className="secondary" type="button" onClick={() => setExpanded(false)}>取消</button><button className="primary" type="submit" disabled={busy === "create"}>{busy === "create" ? "正在创建" : "创建预览"}</button></div>
    </form>}
    <div className="workspace-echo-solicitation-list" aria-busy={loading}>{loading ? <p className="saved-empty">正在加载征集。</p> : items.length === 0 ? <p className="saved-empty">尚未创建公开征集。</p> : items.map((item) => <article key={item.publicId}><div><span><em>{item.publicId}</em><small>{solicitationStatusLabel(item.status)}</small></span><strong>{item.title}</strong><p>{item.question}</p><small>{item.ownerProjection?.deliverySummary ? `投递 ${Object.values(item.ownerProjection.deliverySummary).reduce((sum, value) => sum + value, 0)} 人` : "尚未投递"}</small></div><div className="workspace-echo-solicitation-actions">{item.status === "draft" && <button className="primary compact" type="button" disabled={Boolean(busy)} onClick={() => void transition(item, "publish")}>{busy === `publish:${item.publicId}` ? "发布中" : "发布"}</button>}{item.status === "open" && <button className="secondary compact" type="button" disabled={Boolean(busy)} onClick={() => void transition(item, "close")}>{busy === `close:${item.publicId}` ? "关闭中" : "关闭"}</button>}{(item.status === "draft" || item.status === "open") && <button className="secondary compact danger-action" type="button" disabled={Boolean(busy)} onClick={() => void transition(item, "withdraw")}>撤回</button>}<button className="icon-button" type="button" title="查看投票和投递明细" disabled={Boolean(busy)} onClick={() => void openDetail(item)}><UsersRound size={15} /></button></div></article>)}</div>
    {detail && <div className="workspace-echo-solicitation-detail" role="region" aria-label={`${detail.publicId} 投递和投票明细`}><header><strong>{detail.publicId} 明细</strong><span><button className="secondary compact" type="button" disabled={Boolean(busy)} onClick={() => void retryDeliveries(detail.publicId)}>{busy === `retry:${detail.publicId}` ? "重试中" : "重试投递"}</button><button className="icon-button" type="button" title="关闭明细" onClick={() => setDetail(null)}><X size={15} /></button></span></header><div><section><h4>投递状态</h4>{detail.deliveries.length ? <ul>{detail.deliveries.map((delivery) => <li key={delivery.id}><span>{delivery.recipientDisplayName || delivery.recipientUserId}</span><small>{delivery.status}{delivery.attemptCount > 1 ? ` · 已尝试 ${delivery.attemptCount} 次` : ""}{delivery.lastErrorCode ? ` · ${delivery.lastErrorCode}` : ""}</small></li>)}</ul> : <p>暂无投递记录。</p>}</section><section><h4>投票明细</h4>{detail.votes.length ? <ul>{detail.votes.map((vote) => <li key={vote.voterUserId}><span>{vote.voterDisplayName || vote.voterUserId}</span><small>{vote.optionIds.join("、")}</small></li>)}</ul> : <p>暂无成员投票。</p>}</section></div></div>}
  </section>;
}

function EchoRequirementDetail({
  requirement,
  history,
  onClose,
  onChanged,
  onNotice
}: {
  requirement: EchoRequirement;
  history: EchoHistoryItem[];
  onClose: () => void;
  onChanged: (requirement: EchoRequirement) => void;
  onNotice: (tone: NoticeTone, message: string) => void;
}) {
  const [transition, setTransition] = useState<"" | "planned" | "in_progress" | "delivered" | ArchiveOutcome>("");
  const [response, setResponse] = useState("");
  const [duplicateOfPublicId, setDuplicateOfPublicId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTransition("");
    setResponse("");
    setDuplicateOfPublicId("");
  }, [requirement.publicId]);

  async function submitTransition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transition || busy) return;
    const target = transitionPayload(transition);
    setBusy(true);
    try {
      const result = await echoJson<{ requirement: EchoRequirement }>(`/api/workspace/echo/requirements/${encodeURIComponent(requirement.publicId)}/transition`, {
        method: "POST",
        body: JSON.stringify({
          ...target,
          expectedRevision: requirement.revision,
          idempotencyKey: echoClientId("transition"),
          response: response.trim() || undefined,
          duplicateOfPublicId: transition === "duplicate" ? duplicateOfPublicId.trim().toUpperCase() : undefined
        })
      });
      onChanged(result.requirement);
      setTransition("");
      setResponse("");
      setDuplicateOfPublicId("");
      onNotice("success", "需求状态已更新");
    } catch (caught) {
      onNotice("warning", echoErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const actions = availableTransitions(requirement);
  return (
    <article className="workspace-echo-detail-content">
      <header><button className="icon-button mobile-only" type="button" title="返回需求列表" onClick={onClose}><ArrowLeft size={16} /></button><div><span><em>{requirement.publicId}</em><small>{requirementTypeLabel(requirement.type)}</small></span><h3>{requirement.title}</h3><p>{requirement.submitterDisplayName || requirement.submitterGithubLogin || "成员"} · {formatEchoTimestamp(requirement.createdAt)}</p></div><button className="icon-button desktop-only" type="button" title="关闭详情" onClick={onClose}><X size={16} /></button></header>
      <div className="workspace-echo-detail-scroll">
        <section aria-labelledby="echo-requirement-content"><h4 id="echo-requirement-content">需求内容</h4><p>{requirement.detail}</p></section>
        {requirement.scenario && <section><h4>使用场景</h4><p>{requirement.scenario}</p></section>}
        {requirement.expectedResult && <section><h4>期望结果</h4><p>{requirement.expectedResult}</p></section>}
        {requirement.relatedLink && <a className="workspace-echo-related-link" href={requirement.relatedLink} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />查看相关链接</a>}
        {requirement.response && <section className="workspace-echo-owner-response"><h4>空间主人回复</h4><p>{requirement.response}</p></section>}
        {requirement.duplicateOfPublicId && <p className="workspace-echo-duplicate">重复于 {requirement.duplicateOfPublicId}</p>}

        <section className="workspace-echo-history" aria-labelledby="echo-requirement-history"><h4 id="echo-requirement-history">处理历史</h4><ol>{history.map((item) => <li key={item.id}><span /><div><strong>{requirementStatusText(item.toPhase, item.toStatus)}</strong>{item.response && <p>{item.response}</p>}<time>{formatEchoTimestamp(item.createdAt)}</time></div></li>)}</ol></section>
      </div>

      {actions.length > 0 && (
        <form className="workspace-echo-transition" onSubmit={(event) => void submitTransition(event)}>
          <label><span>下一步</span><select value={transition} onChange={(event) => setTransition(event.target.value as typeof transition)}><option value="">选择操作</option>{actions.map((action) => <option key={action} value={action}>{transitionLabel(action)}</option>)}</select></label>
          {transition === "duplicate" && <label><span>重复提案编号</span><input value={duplicateOfPublicId} onChange={(event) => setDuplicateOfPublicId(event.target.value)} placeholder="REQ-2026-0001" required pattern="REQ-\d{4}-\d{4}" /></label>}
          {(transition === "rejected" || transition === "duplicate" || transition === "withdrawn" || transition === "cancelled") && <label className="workspace-echo-transition-response"><span>处理说明</span><textarea value={response} onChange={(event) => setResponse(event.target.value)} maxLength={4000} required={transition === "rejected"} placeholder="向提交者说明处理结果" /></label>}
          <button className="primary" type="submit" disabled={!transition || busy || (transition === "duplicate" && !duplicateOfPublicId.trim())}>{busy ? "正在更新" : "确认更新"}</button>
        </form>
      )}
    </article>
  );
}

function EchoStat({ label, value, icon }: { label: string; value?: number; icon: React.ReactNode }) {
  return <div>{icon}<span><small>{label}</small><strong>{value ?? 0}</strong></span></div>;
}

function EchoListSkeleton() {
  return <div className="workspace-echo-list-skeleton" aria-label="正在加载需求">{Array.from({ length: 7 }, (_, index) => <span key={index}><i /><b /><em /></span>)}</div>;
}

function EchoDetailSkeleton() {
  return <div className="workspace-echo-detail-skeleton" aria-busy="true"><span /><span /><div /><div /></div>;
}

function buildRequirementQuery(filters: EchoFilters, offset: number) {
  const params = new URLSearchParams({ limit: "50", offset: String(offset) });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

function mergeRequirements(current: EchoRequirement[], next: EchoRequirement[]) {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of next) map.set(item.id, item);
  return [...map.values()];
}

function hasActiveFilters(filters: EchoFilters) {
  return Object.values(filters).some(Boolean);
}

function availableTransitions(requirement: EchoRequirement): Array<"planned" | "in_progress" | "delivered" | ArchiveOutcome> {
  if (requirement.phase === "archived") return [];
  const next: Array<"planned" | "in_progress" | "delivered" | ArchiveOutcome> = [];
  if (requirement.phase === "proposal") next.push("planned");
  if (requirement.phase === "formal" && requirement.status === "planned") next.push("in_progress", "delivered");
  if (requirement.phase === "formal" && requirement.status === "in_progress") next.push("delivered");
  if (requirement.phase === "formal" && requirement.status === "delivered") next.push("implemented");
  next.push("rejected", "duplicate", "withdrawn", "cancelled");
  return next;
}

function transitionPayload(transition: "planned" | "in_progress" | "delivered" | ArchiveOutcome) {
  if (["planned", "in_progress", "delivered"].includes(transition)) return { toPhase: "formal", toStatus: transition };
  return { toPhase: "archived", toStatus: "archived", archiveOutcome: transition };
}

function transitionLabel(transition: "planned" | "in_progress" | "delivered" | ArchiveOutcome) {
  const labels: Record<string, string> = { planned: "转为正式需求", in_progress: "开始处理", delivered: "标记已交付", implemented: "归档为已实现", rejected: "驳回提案", duplicate: "标记重复提案", withdrawn: "归档为已撤回", cancelled: "归档为已取消" };
  return labels[transition];
}

function requirementTypeLabel(type: RequirementType) {
  return type === "requirement" ? "需求" : type === "suggestion" ? "建议" : "问题";
}

function requirementStatusLabel(requirement: EchoRequirement) {
  return requirement.archiveOutcome ? archiveOutcomeLabel(requirement.archiveOutcome) : requirementStatusText(requirement.phase, requirement.status);
}

function requirementStatusText(phase: RequirementPhase, status: RequirementStatus) {
  if (phase === "proposal") return "待审核";
  if (phase === "archived") return "已归档";
  return status === "planned" ? "已计划" : status === "in_progress" ? "进行中" : status === "delivered" ? "已交付" : "正式需求";
}

function archiveOutcomeLabel(outcome: ArchiveOutcome) {
  const labels: Record<ArchiveOutcome, string> = { implemented: "已实现", rejected: "已驳回", duplicate: "重复提案", withdrawn: "已撤回", cancelled: "已取消" };
  return labels[outcome];
}

function solicitationStatusLabel(status: EchoSolicitationStatus) {
  return status === "draft" ? "草稿" : status === "open" ? "征集中" : status === "closed" ? "已结束" : "已撤回";
}

function formatEchoDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function formatEchoTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function echoClientId(prefix: string) {
  const value = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${value}`;
}

async function echoJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, headers: createWorkspaceJsonHeaders(options) });
  if (!response.ok) {
    let message = "操作失败，请稍后重试";
    try {
      const payload = await response.json() as { error?: { message?: string } };
      message = payload.error?.message || message;
    } catch {
      // Keep the stable fallback.
    }
    throw new Error(message);
  }
  return await response.json() as T;
}

function echoErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "操作失败，请稍后重试";
}
