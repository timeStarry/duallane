import { Check, Search, Users, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { WorkspaceAvatar } from "../../WorkspaceAvatar";
import { Button, IconButton } from "../../ui/primitives";
import "./member-picker.css";

export type MemberPickerCandidate = {
  id: string;
  displayName: string;
  secondaryText?: string;
  avatarUrl?: string | null;
  disabledReason?: string;
};

export type MemberPickerSubmission = {
  scopeKey: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  isAvailable: (id: string) => boolean;
};

export type MemberPickerDialogProps = {
  open: boolean;
  /** Include actor, conversation and the permission/navigation scope. */
  scopeKey: string;
  groupName: string;
  candidates: readonly MemberPickerCandidate[];
  existingMemberIds?: readonly string[];
  returnFocus?: HTMLElement | null;
  onClose: (reason: "cancel" | "complete" | "scope-change") => void;
  /** Use the existing single-member protocol; this UI does not imply atomic batching.
   * Before each write check isCurrent/isAvailable; after awaiting check isCurrent.
   * Reflect successes in existingMemberIds and reject with a user-facing error. */
  onConfirm: (ids: readonly string[], context: MemberPickerSubmission) => Promise<void>;
};

export function MemberPickerDialog({ open, ...props }: MemberPickerDialogProps) {
  return open ? <MemberPickerSession {...props} /> : null;
}

function MemberPickerSession(props: Omit<MemberPickerDialogProps, "open">) {
  const id = useId();
  const [openingScope] = useState(props.scopeKey);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectionNotice, setSelectionNotice] = useState("");
  const [viewportStyle, setViewportStyle] = useState<CSSProperties>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(false);
  const dismissed = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const focusTarget = useRef<HTMLElement | null>(null);

  const candidates = useMemo(() => {
    const existing = new Set(props.existingMemberIds);
    return [...new Map(props.candidates.filter((member) => !existing.has(member.id)).map((member) => [member.id, member])).values()];
  }, [props.candidates, props.existingMemberIds]);
  const availableIds = useMemo(() => new Set(candidates.filter((member) => !member.disabledReason).map((member) => member.id)), [candidates]);
  const selected = selectedIds.filter((memberId) => availableIds.has(memberId));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCandidates = candidates.filter((member) => `${member.displayName} ${member.secondaryText ?? ""}`.toLocaleLowerCase().includes(normalizedQuery));

  const isAvailable = (memberId: string) => !latest.current.existingMemberIds?.includes(memberId)
    && latest.current.candidates.some((member) => member.id === memberId && !member.disabledReason);
  const restoreFocus = () => {
    // A modal makes the background inert until close() has run.
    const target = focusTarget.current;
    if (target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true });
  };
  const close = (reason: "cancel" | "complete" | "scope-change") => {
    if (dismissed.current || (pending.current && reason === "cancel")) return;
    dismissed.current = true;
    pending.current?.abort();
    dialogRef.current?.close();
    restoreFocus();
    latest.current.onClose(reason);
  };

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    alive.current = true;
    focusTarget.current = props.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const updateViewport = () => {
      const viewport = window.visualViewport;
      setViewportStyle({
        "--member-picker-viewport-height": `${viewport?.height ?? innerHeight}px`,
        "--member-picker-viewport-width": `${viewport?.width ?? innerWidth}px`,
        "--member-picker-viewport-top": `${viewport?.offsetTop ?? 0}px`,
        "--member-picker-viewport-left": `${viewport?.offsetLeft ?? 0}px`
      } as CSSProperties);
    };
    updateViewport();
    dialog.showModal();
    // Opening the member list should not immediately cover it with a phone keyboard.
    headingRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      alive.current = false;
      pending.current?.abort();
      dialog.close();
      restoreFocus();
      window.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, []);

  useLayoutEffect(() => {
    if (props.scopeKey !== openingScope) close("scope-change");
  }, [props.scopeKey, openingScope]);

  useEffect(() => {
    const valid = selectedIds.filter((memberId) => availableIds.has(memberId));
    if (valid.length === selectedIds.length) return;
    setSelectedIds(valid);
    // During sequential submission, successful members also leave the candidate list.
    if (!pending.current) setSelectionNotice("成员列表已更新，已移除无法继续邀请的选择。");
  }, [availableIds, selectedIds]);

  const submit = async () => {
    if (pending.current || dismissed.current || props.scopeKey !== openingScope) return;
    const ids = selectedIds.filter(isAvailable);
    if (!ids.length) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    setSelectionNotice("");
    const isCurrent = () => alive.current && !dismissed.current && !controller.signal.aborted
      && pending.current === controller && latest.current.scopeKey === openingScope;
    try {
      await latest.current.onConfirm(ids, { scopeKey: openingScope, signal: controller.signal, isCurrent, isAvailable });
      if (isCurrent()) close("complete");
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error && reason.message ? reason.message : "邀请失败，请重试。");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (alive.current && !dismissed.current) setBusy(false);
      }
    }
  };

  if (props.scopeKey !== openingScope) return null;
  return <dialog ref={dialogRef} className="dl-member-picker" style={viewportStyle} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={(event) => { event.preventDefault(); close("cancel"); }} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close("cancel"); return; }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    const first = controls[0];
    const last = controls.at(-1);
    // Native modality keeps the background inert; wrap boundary Tab presses too,
    // rather than sending focus into browser chrome between the last/first control.
    if (!first) { event.preventDefault(); headingRef.current?.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <header className="dl-member-picker-header">
      <div>
        <h2 ref={headingRef} tabIndex={-1} id={`${id}-title`}>邀请成员</h2>
        <p id={`${id}-description`}>选择要加入「{props.groupName}」的成员</p>
      </div>
      <IconButton label="取消邀请" disabled={busy} onClick={() => close("cancel")}><X size={20} aria-hidden="true" /></IconButton>
    </header>
    <div className="dl-member-picker-search">
      <Search size={18} aria-hidden="true" />
      <input ref={searchRef} type="search" aria-label="搜索成员" aria-controls={`${id}-members`} autoComplete="off" placeholder="搜索姓名" value={query} disabled={busy} onChange={(event) => setQuery(event.currentTarget.value)} />
      {query && <IconButton label="清除搜索" disabled={busy} onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={18} aria-hidden="true" /></IconButton>}
    </div>
    <p className="dl-member-picker-results" role="status">{busy ? "正在邀请，请稍候…" : normalizedQuery ? `找到 ${visibleCandidates.length} 位成员` : `${availableIds.size} 位成员可邀请`}</p>
    <div id={`${id}-members`} className="dl-member-picker-list dl-scroll-area" role="group" tabIndex={-1} aria-label="可邀请成员" aria-busy={busy}>
      {visibleCandidates.length === 0 ? <div className="dl-member-picker-empty"><Users size={24} aria-hidden="true" /><p>{normalizedQuery ? "没有找到匹配的成员" : "当前没有可邀请的成员"}</p><span>{normalizedQuery ? "试试其他姓名，或清除搜索查看全部成员。" : "新成员加入空间后，可在这里邀请他们。"}</span></div> : visibleCandidates.map((member, index) => <label key={member.id} className="dl-member-picker-row" data-selected={selected.includes(member.id)} data-disabled={Boolean(member.disabledReason)}>
        <input type="checkbox" checked={selected.includes(member.id)} disabled={busy || Boolean(member.disabledReason)} aria-labelledby={`${id}-member-${index}`} aria-describedby={member.disabledReason || member.secondaryText ? `${id}-detail-${index}` : undefined} onChange={(event) => {
          if (pending.current || !isAvailable(member.id)) return;
          const checked = event.currentTarget.checked;
          setSelectedIds((current) => checked ? [...new Set([...current, member.id])] : current.filter((value) => value !== member.id));
          setSelectionNotice("");
        }} />
        <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
        <span className="dl-member-picker-identity"><strong id={`${id}-member-${index}`}>{member.displayName}</strong>{(member.disabledReason || member.secondaryText) && <small id={`${id}-detail-${index}`}>{member.disabledReason || member.secondaryText}</small>}</span>
        <span className="dl-member-picker-check" aria-hidden="true">{selected.includes(member.id) && <Check size={14} />}</span>
      </label>)}
    </div>
    <footer className="dl-member-picker-footer">
      {error && <p className="dl-member-picker-error" role="alert">{error}</p>}
      {selectionNotice && <p className="dl-member-picker-notice" role="status">{selectionNotice}</p>}
      <div className="dl-member-picker-actions">
        <span className="dl-member-picker-count" aria-live="polite" aria-atomic="true">已选 <strong>{selected.length}</strong> 人</span>
        <Button onClick={() => close("cancel")} disabled={busy}>取消</Button>
        <Button variant="primary" onClick={() => void submit()} busy={busy} disabled={!selected.length}>{busy ? "邀请中" : error ? "重试邀请" : "邀请成员"}</Button>
      </div>
    </footer>
  </dialog>;
}
