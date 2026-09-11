import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Bell, BellOff, Check, Info, LogOut, MessageSquare, X } from "lucide-react";
import { Button, IconButton, SegmentedControl } from "../../ui/primitives";
import "./details.css";

type NotificationLevel = "all" | "mentions" | "muted";
type TopicDetailsData = {
  id: string;
  title: string;
  description?: string;
  descriptionPreview?: string;
  status: "open" | "closed" | "archived";
  joined: boolean;
  canJoin: boolean;
  participantCount: number;
  creator: { displayName: string };
  createdAt: string;
  notificationLevel?: NotificationLevel;
};
type Action = () => void | Promise<void>;
export type TopicDetailsProps = {
  /** Include the current actor/session as well as topic identity. */
  scopeKey: string;
  topic: TopicDetailsData;
  groupTitle?: string;
  canJoin: boolean;
  canLeave: boolean;
  canClose: boolean;
  canArchive: boolean;
  busyAction?: string | null;
  onOpenConversation: Action;
  onJoin: Action;
  onLeave: Action;
  onNotificationChange: (level: NotificationLevel) => void | Promise<void>;
  onCloseTopic: Action;
  onArchiveTopic: Action;
};

export function TopicDetails(props: TopicDetailsProps) {
  const [openScope, setOpenScope] = useState<string | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const scopeRef = useRef(props.scopeKey);
  scopeRef.current = props.scopeKey;
  const open = openScope === props.scopeKey;
  useEffect(() => { setOpenScope(null); }, [props.scopeKey]);
  const close = () => {
    const scope = props.scopeKey;
    const trigger = triggerRef.current?.querySelector("button");
    setOpenScope(null);
    window.requestAnimationFrame(() => { if (scopeRef.current === scope && trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  };
  return <>
    <span className="dl-topic-details-trigger" ref={triggerRef} key={`trigger:${props.scopeKey}`}><Button variant="quiet" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpenScope(props.scopeKey)} leadingIcon={<Info size={18} aria-hidden="true" />}>话题详情</Button></span>
    {open && <TopicDetailsPanel key={`panel:${props.scopeKey}`} {...props} onDismiss={close} />}
  </>;
}

function TopicDetailsPanel({ topic, groupTitle, canJoin, canLeave, canClose, canArchive, busyAction, onOpenConversation, onJoin, onLeave, onNotificationChange, onCloseTopic, onArchiveTopic, onDismiss }: TopicDetailsProps & { onDismiss: () => void }) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const busy = Boolean(busyAction || pending);
  useEffect(() => {
    mounted.current = true;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { mounted.current = false; dialog?.close(); };
  }, []);
  async function invoke(name: string, action: Action) {
    if (pendingRef.current || busyAction) return;
    pendingRef.current = true; setPending(name); setError("");
    try { await action(); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "操作失败，请重试。"); }
    finally { pendingRef.current = false; if (mounted.current) setPending(""); }
  }
  const actionBusy = (name: string) => busyAction === name || pending === name;
  const isOpen = topic.status === "open";
  const showJoin = canJoin && topic.canJoin && !topic.joined && isOpen;
  const showLeave = canLeave && topic.joined && isOpen;
  const showClose = canClose && isOpen;
  const showArchive = canArchive && topic.status !== "archived";
  const date = new Date(topic.createdAt);
  const createdAt = Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  return createPortal(<dialog ref={dialogRef} className="dl-topic-details" aria-labelledby={headingId} onCancel={(event) => { event.preventDefault(); onDismiss(); }} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")].filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    // Native dialogs can move focus to browser chrome at either end; keep the
    // details layer's keyboard cycle inside its current, enabled controls.
    if (first && last && (!controls.includes(document.activeElement as HTMLElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last))) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onDismiss();
  }}>
    <header className="dl-topic-details-header"><h2 id={headingId}>话题详情</h2><IconButton label="关闭话题详情" autoFocus onClick={onDismiss}><X size={20} aria-hidden="true" /></IconButton></header>
    <div className="dl-topic-details-body">
      <section className="dl-topic-details-overview"><h3>{topic.title}</h3><span className="dl-topic-details-status">{isOpen ? "进行中" : topic.status === "closed" ? "已关闭" : "已归档"}</span>
        <p>{topic.description || topic.descriptionPreview || (topic.joined ? "暂无话题描述。" : "加入后查看话题正文。")}</p>
        <dl><div><dt>创建者</dt><dd>{topic.creator.displayName}</dd></div>{createdAt && <div><dt>创建时间</dt><dd>{createdAt}</dd></div>}<div><dt>参与成员</dt><dd>{topic.participantCount} 人</dd></div></dl>
        <Button className="dl-topic-details-parent" variant="quiet" disabled={busy} leadingIcon={<MessageSquare size={17} aria-hidden="true" />} onClick={() => { onDismiss(); void onOpenConversation(); }}>{groupTitle || "所属群聊"}</Button>
      </section>
      {topic.joined && <section><h3>话题提醒</h3><SegmentedControl label="话题提醒" hideLabel value={topic.notificationLevel ?? "all"} disabled={busy} options={[
        { value: "all", label: "全部", icon: <Bell size={16} aria-hidden="true" /> },
        { value: "mentions", label: "仅提及", icon: <Bell size={16} aria-hidden="true" /> },
        { value: "muted", label: "免打扰", icon: <BellOff size={16} aria-hidden="true" /> }
      ]} onValueChange={(level) => { if (level === "all" || level === "mentions" || level === "muted") void invoke("notification", () => onNotificationChange(level)); }} /></section>}
      {(showJoin || showLeave) && <section><h3>参与</h3><div className="dl-topic-details-actions">
        {showJoin && <Button variant="primary" disabled={busy} busy={actionBusy("join")} leadingIcon={<Check size={17} aria-hidden="true" />} onClick={() => void invoke("join", onJoin)}>加入话题</Button>}
        {showLeave && <Button variant="danger" disabled={busy} busy={actionBusy("leave")} leadingIcon={<LogOut size={17} aria-hidden="true" />} onClick={() => void invoke("leave", onLeave)}>退出话题</Button>}
      </div></section>}
      {(showClose || showArchive) && <section><h3>管理</h3><div className="dl-topic-details-actions">
        {showClose && <Button disabled={busy} busy={actionBusy("close")} leadingIcon={<MessageSquare size={17} aria-hidden="true" />} onClick={() => void invoke("close", onCloseTopic)}>关闭话题</Button>}
        {showArchive && <Button disabled={busy} busy={actionBusy("archive")} leadingIcon={<Archive size={17} aria-hidden="true" />} onClick={() => void invoke("archive", onArchiveTopic)}>归档话题</Button>}
      </div></section>}
      {error && <p className="dl-field-error" role="alert">{error}</p>}
    </div>
  </dialog>, document.body);
}
