import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Select, Switch } from "../../ui/primitives";
import { userFacingErrorMessage } from "../../user-facing-error";
import { contextGrantTargets, grantSubmission, initialGrantDraft, type BotContextGrant, type BotGrantJson, type BotGrantNavigationGuard, type BotGrantOwner, type BotGrantSettings, type BotGroupPolicy, type ContextGrantDraft, type ContextGrantTarget, type GrantConversation } from "./context-grants";
import "./context-grants.css";

export function BotContextGrants({ bot, settings, policies, hasContextScope, json, onPolicyUpdated, registerNavigationGuard }: {
  bot: BotGrantOwner; settings: BotGrantSettings; policies: readonly BotGroupPolicy[]; hasContextScope: boolean;
  json: BotGrantJson; onPolicyUpdated: (policy: BotGroupPolicy) => void;
  registerNavigationGuard?: (guard: BotGrantNavigationGuard | null) => void;
}) {
  const headingId = useId();
  const [conversations, setConversations] = useState<GrantConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ContextGrantDraft>({ allowTrigger: false, allowContext: false, maxMessages: "50" });
  const [confirmed, setConfirmed] = useState<Record<string, BotContextGrant>>({});
  const [deniedTargets, setDeniedTargets] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const scope = useRef({ active: true, botId: bot.id });
  const pending = useRef<Promise<boolean> | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scope.current = { active: true, botId: bot.id }; return () => { scope.current.active = false; }; }, [bot.id]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError("");
    void json<{ conversations: GrantConversation[] }>("/api/workspace/conversations").then(result => {
      if (!cancelled) setConversations(Array.isArray(result.conversations) ? result.conversations : []);
    }).catch(failure => { if (!cancelled) { setConversations([]); setLoadError(userFacingErrorMessage(failure, "可见会话暂时无法加载")); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bot.id, json, revision]);
  const targets = useMemo(() => contextGrantTargets(bot, settings, conversations, policies).map(target => {
    const grant = confirmed[target.id];
    const projected = target.kind === "direct" && grant ? { ...target, ...grant, known: true } : target;
    return deniedTargets.includes(target.id) ? { ...projected, readOnlyReason: "权限或会话状态已变化，当前只读。请重新加载后检查。" } : projected;
  }), [bot, settings, conversations, policies, confirmed, deniedTargets]);
  const selected = targets.find(target => target.id === selectedId) ?? null;
  const canEdit = Boolean(selected && !selected.readOnlyReason && !loading && !loadError);
  const dirty = editing && Boolean(selected) && (!selected!.known || JSON.stringify(draft) !== JSON.stringify(initialGrantDraft(selected!, settings.context?.maxMessages)));
  const current = () => scope.current.active && scope.current.botId === bot.id;

  const cancel = useCallback(() => {
    if (pending.current) return false;
    setEditing(false); setError(""); return true;
  }, []);
  const save = (): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (!selected || !canEdit || !current()) return Promise.resolve(false);
    let submission: ReturnType<typeof grantSubmission>;
    try { submission = grantSubmission(bot.id, selected, draft); }
    catch (failure) { setError(userFacingErrorMessage(failure, "授权设置无效")); return Promise.resolve(false); }
    setSaving(true); setError(""); setStatus("");
    const target = selected;
    pending.current = json<{ grant?: BotContextGrant; policy?: BotGroupPolicy }>(submission.path, { method: "PATCH", body: JSON.stringify(submission.body) }).then(result => {
      if (!current()) return false;
      if (target.kind === "direct") {
        if (!result.grant || result.grant.botId !== bot.id || result.grant.conversationId !== target.id) throw new Error("授权响应不匹配，请重新加载后检查。");
        setConfirmed(previous => ({ ...previous, [target.id]: result.grant! }));
      } else {
        if (!result.policy || result.policy.conversationId !== target.id) throw new Error("授权响应不匹配，请重新加载后检查。");
        onPolicyUpdated(result.policy);
      }
      setEditing(false); setStatus("本会话授权已保存。Token 权限仍独立生效。");
      queueMicrotask(() => { if (current() && document.activeElement === document.body) detailRef.current?.focus({ preventScroll: true }); });
      return true;
    }).catch(failure => {
      if (current()) {
        setError(userFacingErrorMessage(failure, "授权保存失败，请重试"));
        if (typeof failure === "object" && failure !== null && "status" in failure && (failure.status === 403 || failure.status === 404)) setDeniedTargets(previous => [...new Set([...previous, target.id])]);
      }
      return false;
    })
      .finally(() => { pending.current = null; if (current()) setSaving(false); });
    return pending.current;
  };
  const latestSave = useRef(save);
  latestSave.current = save;
  useEffect(() => {
    registerNavigationGuard?.(dirty ? { message: "本会话授权还有未提交的修改。放弃只清除本次编辑，不改变已保存的 Bot 授权。", confirmLabel: "放弃授权修改并离开", save: () => latestSave.current(), discard: cancel } : null);
    return () => registerNavigationGuard?.(null);
  }, [dirty, cancel, registerNavigationGuard]);
  const choose = (id: string) => { if (dirty || pending.current) return; setSelectedId(id); setEditing(false); setError(""); setStatus(""); };
  const startEditing = (target: ContextGrantTarget) => { setDraft(initialGrantDraft(target, settings.context?.maxMessages)); setEditing(true); setError(""); setStatus(""); };

  return <section className="workspace-bot-section dl-bot-context" aria-labelledby={headingId} aria-busy={loading || saving}>
    <div className="workspace-bot-section-intro"><h3 id={headingId}>会话上下文授权</h3><p>每次只修改一个会话。允许触发与读取上下文分别控制；不会授予完整历史或其他会话权限。</p></div>
    <p className="dl-bot-context-note">范围：当前可见的 Bot 所有者私聊，以及服务返回的现有群授权。群授权需由仍在群内的空间主人或管理员管理，且必须是此 Bot 的所有者。</p>
    <p className="dl-bot-context-note">实际上下文还受 Bot 消息、时间窗口、字符与 Token 上限、消息保留规则和 Token 的 <code>messages:read_context</code> Scope 限制。{!hasContextScope && "当前没有可用 Token 具备此 Scope；保存会话授权不会自动扩大 Token 权限。"}</p>
    {loadError && <div role="alert"><p>{loadError}</p><Button onClick={() => setRevision(value => value + 1)}>重新加载可见会话</Button></div>}
    {!loadError && <Select label="授权会话" value={selectedId} onValueChange={choose} disabled={loading || dirty || saving} loading={loading} placeholder={loading ? "正在加载可见会话" : "选择一个会话"} options={targets.map(target => ({ value: target.id, label: `${target.kind === "direct" ? "私聊" : "群聊"} · ${target.title}`, description: target.readOnlyReason || (target.known ? "可查看当前授权" : "当前授权状态未返回") }))} />}
    {!loading && !loadError && targets.length === 0 && <p className="dl-bot-context-note">暂无可配置会话。先从聊天中打开与自己 Bot 的私聊；本页不会创建会话或自动批准群授权。</p>}
    {selected && <div ref={detailRef} tabIndex={-1} className="dl-bot-context-detail">
      <h4>{selected.title}</h4>
      {selected.known ? <dl className="dl-bot-context-summary"><div><dt>允许触发</dt><dd>{selected.allowTrigger ? "开启" : "关闭"}</dd></div><div><dt>读取上下文</dt><dd>{selected.allowContext ? "开启" : "关闭"}</dd></div><div><dt>消息数量上限</dt><dd>{selected.maxMessages ?? `沿用 Bot 上限（${settings.context?.maxMessages ?? 50} 条）`}</dd></div></dl> : <p className="dl-bot-context-note">当前授权状态未返回。现有接口不提供私聊授权查询；下方是本次拟提交设置，不代表已保存值。提交成功后才显示服务器确认的授权，重新进入此页仍需重新确认。</p>}
      {selected.readOnlyReason && <p role="status" className="dl-bot-context-note">{selected.readOnlyReason}</p>}
      {deniedTargets.includes(selected.id) && <Button disabled={saving} onClick={() => { cancel(); setDeniedTargets([]); setRevision(value => value + 1); }}>重新检查会话权限</Button>}
      {!editing && canEdit && <Button onClick={() => startEditing(selected)}>{selected.known ? "修改本会话授权" : "设置私聊授权"}</Button>}
      {editing && <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={saving || !canEdit}>
          <legend>本次拟提交设置</legend>
          <Switch label="允许触发" description="允许该会话中符合 Bot 触发规则的事件；不会自动开放上下文。" checked={draft.allowTrigger} onCheckedChange={allowTrigger => setDraft(previous => ({ ...previous, allowTrigger }))} />
          <Switch label="允许读取上下文" description="允许外部 Agent 按本会话及 Token 的有效范围读取有限消息。" checked={draft.allowContext} onCheckedChange={allowContext => setDraft(previous => ({ ...previous, allowContext }))} />
          <label className="dl-bot-context-limit"><span>本会话最多读取消息数</span><input type="number" min={1} max={200} step={1} value={draft.maxMessages} onChange={event => setDraft(previous => ({ ...previous, maxMessages: event.target.value }))} /><small>1–200 条；实际读取仍取所有限制的交集。</small></label>
          <Button variant="quiet" onClick={() => setDraft(previous => ({ ...previous, allowTrigger: false, allowContext: false }))}>关闭本会话触发和上下文</Button>
          <p className="dl-bot-context-note">关闭仅在点击“保存本会话授权”后生效。保留聊天和群成员关系，不撤销 Token；已经传给 Agent 的内容无法通过此开关收回。</p>
        </fieldset>
        <div className="dl-bot-context-actions"><Button onClick={cancel} disabled={saving}>取消修改</Button><Button type="submit" variant="primary" busy={saving} disabled={!canEdit}>{error ? "重试保存本会话授权" : "保存本会话授权"}</Button></div>
      </form>}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status" aria-live="polite">{status}</p>}
    </div>}
  </section>;
}
