import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { Button, IconButton, SelectionItem, Switch } from "../../ui/primitives";
import type { WorkspaceTopic, WorkspaceTopicConversation } from "../../WorkspaceTopics";
import type { NavigationGuard } from "../../shell/useNavigationGuard";
import { createTopic, topicCreatePayload, validateTopicCreate } from "./create-topic";
import "./topics.css";

export type RegisterTopicNavigationGuard = (guard: NavigationGuard | null) => void;

export function TopicCreateButton({ conversations, conversationId, canCreate, onCreated, registerNavigationGuard }: {
  conversations: WorkspaceTopicConversation[];
  conversationId?: string;
  canCreate: boolean;
  onCreated: (topic: WorkspaceTopic) => void;
  registerNavigationGuard?: RegisterTopicNavigationGuard;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const eligible = conversations.filter((group) => group.canCreate !== false);
  return <>
    <span className="dl-topic-create-trigger" ref={triggerRef}><Button disabled={!canCreate || eligible.length === 0} onClick={() => setOpen(true)} title={!canCreate ? "当前身份不能创建话题" : eligible.length ? undefined : "加入可发送消息的群聊后创建话题"}><Plus size={16} />新建话题</Button></span>
    {open && <TopicCreateDialog conversations={eligible} conversationId={conversationId} registerNavigationGuard={registerNavigationGuard} onClose={(restoreFocus = true) => { setOpen(false); if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.querySelector("button")?.focus()); }} onCreated={onCreated} />}
  </>;
}

function TopicCreateDialog({ conversations, conversationId, onClose, onCreated, registerNavigationGuard }: {
  conversations: WorkspaceTopicConversation[]; conversationId?: string; onClose: (restoreFocus?: boolean) => void; onCreated: (topic: WorkspaceTopic) => void;
  registerNavigationGuard?: RegisterTopicNavigationGuard;
}) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const busyRef = useRef(false);
  const completedRef = useRef(false);
  const mountedRef = useRef(true);
  const [groupId, setGroupId] = useState(conversationId || conversations[0]?.id || "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [allowSyncToGroup, setAllowSyncToGroup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const initialGroupId = useRef(groupId);
  const dirty = Boolean(title || description || groupId !== initialGroupId.current || !allowSyncToGroup);
  useEffect(() => { mountedRef.current = true; const dialog = dialogRef.current; dialog?.showModal(); return () => { mountedRef.current = false; dialog?.close(); }; }, []);
  useEffect(() => {
    registerNavigationGuard?.(dirty || busy ? {
      title: "放弃新建话题？",
      message: "新话题尚未完成创建。放弃后将清除这次表单；创建请求仍在处理中时不能离开。",
      confirmLabel: "放弃创建并离开",
      completed: () => completedRef.current,
      discard: () => {
        if (busyRef.current) return false;
        registerNavigationGuard?.(null);
        onClose(false);
        return true;
      }
    } : null);
    return () => registerNavigationGuard?.(null);
  }, [busy, dirty, onClose, registerNavigationGuard]);
  function close(restoreFocus = true) { registerNavigationGuard?.(null); onClose(restoreFocus); }
  function requestClose() {
    if (busyRef.current) return;
    if (dirty) setConfirmDiscard(true); else close();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    const fields = { conversationId: groupId, title, description, allowSyncToGroup };
    const validation = validateTopicCreate(fields);
    if (validation) { setError(validation); return; }
    const fingerprint = JSON.stringify([groupId, topicCreatePayload(fields, "")]);
    if (attemptRef.current?.fingerprint !== fingerprint) attemptRef.current = { fingerprint, key: `topic-form-${crypto.randomUUID()}` };
    busyRef.current = true; setBusy(true); setError("");
    try {
      const topic = await createTopic(fields, attemptRef.current.key);
      completedRef.current = true;
      if (mountedRef.current) { close(false); onCreated(topic); }
    }
    catch (caught) { if (mountedRef.current) setError(caught instanceof Error ? caught.message : "创建失败，请重试。"); }
    finally { busyRef.current = false; if (mountedRef.current) setBusy(false); }
  }
  return createPortal(<dialog ref={dialogRef} className="dl-topic-create-dialog" aria-labelledby={headingId} onCancel={(event) => { event.preventDefault(); requestClose(); }}>
    <header><div><p>发起独立讨论</p><h2 id={headingId}>新建话题</h2></div><IconButton label="关闭新建话题" disabled={busy} onClick={requestClose}><X size={18} /></IconButton></header>
    <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <fieldset className="dl-topic-create-groups" disabled={busy}><legend>所属群聊</legend>
        {conversationId ? <p>{conversations.find((group) => group.id === conversationId)?.title || "当前群聊"}</p> : <div role="radiogroup" aria-label="所属群聊">{conversations.map((group, index) => <SelectionItem key={group.id} selected={groupId === group.id} role="radio" aria-checked={groupId === group.id} tabIndex={groupId === group.id ? 0 : -1} disabled={busy} onClick={() => setGroupId(group.id)} onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? conversations.length - 1 : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + conversations.length) % conversations.length;
          setGroupId(conversations[next].id);
          (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next])?.focus();
        }}>{group.title}</SelectionItem>)}</div>}
      </fieldset>
      <label><span id={`${headingId}-title-label`}>标题</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} placeholder="这次想讨论什么" aria-labelledby={`${headingId}-title-label`} aria-describedby={`${headingId}-title-help`} /></label>
      <small id={`${headingId}-title-help`}>1–40 个字符，不含方括号或换行。</small>
      <label><span id={`${headingId}-body-label`}>正文</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} rows={6} placeholder="补充背景、问题或需要讨论的内容" aria-labelledby={`${headingId}-body-label`} /></label>
      <label className="dl-topic-create-sync"><span><strong>允许同步到群聊</strong><small>成员仍需明确选择同步；话题消息默认只留在话题中。</small></span><Switch label="允许同步到群聊" checked={allowSyncToGroup} disabled={busy} onCheckedChange={setAllowSyncToGroup} /></label>
      <p className="dl-topic-create-help">创建后你将加入话题，所属群会显示话题卡片。原群聊草稿留在原处。也可继续使用 #[标题](正文) 快捷语法。</p>
      {error && <p className="dl-field-error" role="alert">{error}</p>}
      {confirmDiscard ? <div className="dl-topic-create-discard" role="alert"><p>放弃这次尚未提交的话题？</p><Button onClick={() => setConfirmDiscard(false)}>继续编辑</Button><Button variant="danger" onClick={() => close()}>放弃创建</Button></div> : <footer><Button disabled={busy} onClick={requestClose}>取消</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? "正在创建…" : "创建并进入话题"}</Button></footer>}
    </form>
  </dialog>, document.body);
}
