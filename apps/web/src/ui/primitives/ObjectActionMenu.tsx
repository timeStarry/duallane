import { X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { canOpenObjectActions, measurePopup, trackPopupScroll, type PopupAnchor } from "./popup";

export type ObjectAction = { id: string; label: string; icon?: ReactNode; disabled?: boolean; disabledReason?: string; danger?: boolean; onSelect: () => void };
export type ObjectActionMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: PopupAnchor | null;
  actions: ObjectAction[];
  label: string;
  summary?: ReactNode;
  presentation?: "auto" | "menu" | "sheet";
  returnFocus?: HTMLElement | null;
  fallbackFocus?: HTMLElement | null;
};

export function ObjectActionMenu({ open, onOpenChange, anchor, actions, label, summary, presentation = "auto", returnFocus, fallbackFocus }: ObjectActionMenuProps) {
  const id = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches);
  const [position, setPosition] = useState<React.CSSProperties>({ left: 12, top: 12 });
  const sheet = presentation === "sheet" || (presentation === "auto" && compact);
  const restore = useCallback(() => {
    const target = returnFocus ?? (anchor instanceof HTMLElement ? anchor : null);
    if (target?.isConnected) target.focus({ preventScroll: true });
    else if (fallbackFocus?.isConnected) fallbackFocus.focus({ preventScroll: true });
  }, [anchor, returnFocus, fallbackFocus]);
  const close = useCallback((restoreFocus = true) => {
    // A modal dialog keeps background controls inert until it closes.
    // Close before returning focus, including Escape and the sheet back button.
    dialogRef.current?.close();
    closeRef.current(false);
    if (restoreFocus) restore();
  }, [restore]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    if (sheet && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
    const update = () => {
      if (!sheet && anchor && menuRef.current) setPosition(measurePopup(anchor, menuRef.current));
    };
    update();
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      dialogRef.current?.close();
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, sheet, anchor]);
  useEffect(() => {
    if (!open) return;
    const trackingAnchor = anchor instanceof HTMLElement ? anchor : returnFocus;
    let scrollIntentUntil = 0;
    const dismissForScroll = trackPopupScroll(trackingAnchor, () => performance.now() < scrollIntentUntil);
    const recordScrollIntent = (event: Event) => {
      if (sheet || (event.target instanceof Node && menuRef.current?.contains(event.target))) return;
      if (event instanceof KeyboardEvent && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      // Include the native scroll/inertia that follows the input. Merely
      // opening a menu or an API response never starts this intent window.
      scrollIntentUntil = performance.now() + 900;
    };
    window.dispatchEvent(new CustomEvent("duallane:object-menu-open", { detail: id }));
    const otherMenu = (event: Event) => { if (event instanceof CustomEvent && event.detail !== id) close(false); };
    const outside = (event: PointerEvent) => {
      if (sheet || event.composedPath().includes(menuRef.current as EventTarget) || (anchor instanceof HTMLElement && event.composedPath().includes(anchor))) return;
      // Focusable outside targets keep the focus they are about to receive.
      close(!(event.target instanceof Element && event.target.closest("button,a,input,select,textarea,[tabindex]")));
    };
    const scroll = (event: Event) => {
      if (sheet || (event.target instanceof Node && menuRef.current?.contains(event.target))) return;
      if (trackingAnchor && !trackingAnchor.isConnected || dismissForScroll(event)) { close(false); return; }
      // A prepend or live update can legitimately move a row by more than a
      // rounding pixel. Keep its action target and follow a button anchor;
      // right-click menus retain their original pointer position.
      if (anchor instanceof HTMLElement && menuRef.current) setPosition(measurePopup(anchor, menuRef.current));
    };
    window.addEventListener("duallane:object-menu-open", otherMenu);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("wheel", recordScrollIntent, { passive: true, capture: true });
    document.addEventListener("touchmove", recordScrollIntent, { passive: true, capture: true });
    document.addEventListener("keydown", recordScrollIntent, true);
    return () => { window.removeEventListener("duallane:object-menu-open", otherMenu); document.removeEventListener("pointerdown", outside); document.removeEventListener("scroll", scroll, true); document.removeEventListener("wheel", recordScrollIntent, true); document.removeEventListener("touchmove", recordScrollIntent, true); document.removeEventListener("keydown", recordScrollIntent, true); };
  }, [open, anchor, returnFocus, sheet, id, close]);
  useLayoutEffect(() => {
    if (open && document.activeElement === document.body) menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
  }, [open, actions]);

  if (!open || !anchor) return null;
  const menu = <div ref={menuRef} role="menu" aria-label={label} className={`dl-action-menu dl-scroll-area ${sheet ? "dl-action-menu-sheet" : ""}`} style={sheet ? undefined : position} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab" && !sheet) { close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }}>
    {actions.map((action, index) => <button key={action.id} type="button" role="menuitem" tabIndex={-1} disabled={action.disabled} aria-describedby={action.disabledReason ? `${id}-reason-${index}` : undefined} className="dl-action-item" data-danger={action.danger || undefined} data-separated={action.danger && !actions[index - 1]?.danger || undefined} onClick={() => {
      if (action.disabled) return;
      // Close the surface synchronously before the caller starts a confirmation.
      dialogRef.current?.close();
      close();
      action.onSelect();
      if (fallbackFocus) queueMicrotask(() => { if (document.activeElement === document.body && fallbackFocus.isConnected) fallbackFocus.focus({ preventScroll: true }); });
    }}>{action.icon}<span><span>{action.label}</span>{action.disabledReason && <small id={`${id}-reason-${index}`}>{action.disabledReason}</small>}</span></button>)}
    {!actions.length && <p className="dl-field-description">当前没有可用操作</p>}
  </div>;
  return createPortal(sheet ? <dialog ref={dialogRef} className="dl-action-sheet" aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }}>
    <header><div><h2 id={`${id}-title`}>{label}</h2>{summary && <div className="dl-action-summary">{summary}</div>}</div><IconButton label="关闭操作面板" onClick={() => close()}><X size={18} /></IconButton></header>
    {menu}
  </dialog> : menu, anchor instanceof HTMLElement ? anchor.closest("dialog[open]") ?? document.body : document.body);
}

export type ObjectActionsController = {
  bind: Pick<HTMLAttributes<HTMLElement>, "onContextMenu" | "onKeyDown" | "onPointerDown" | "onClickCapture">;
  openFromTrigger: (trigger: HTMLElement) => void;
  cancelPending: () => void;
  menuProps: Pick<ObjectActionMenuProps, "open" | "onOpenChange" | "anchor" | "returnFocus" | "presentation">;
};

export function useObjectActions(objectId: string): ObjectActionsController {
  const [state, setState] = useState<{ objectId: string; open: boolean; anchor: PopupAnchor | null; trigger: HTMLElement | null; touch: boolean }>({ objectId, open: false, anchor: null, trigger: null, touch: false });
  const candidate = useRef<{ pointerId: number; x: number; y: number; target: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppress = useRef<{ target: HTMLElement; until: number } | null>(null);
  const cancel = useCallback(() => { if (candidate.current) clearTimeout(candidate.current.timer); candidate.current = null; }, []);
  const show = useCallback((target: HTMLElement, anchor: PopupAnchor, touch = false) => { cancel(); setState({ objectId, open: true, anchor, trigger: target, touch }); }, [cancel, objectId]);
  useEffect(() => {
    const move = (event: PointerEvent) => { const current = candidate.current; if (current && current.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) cancel(); };
    const second = (event: PointerEvent) => {
      if (candidate.current && candidate.current.pointerId !== event.pointerId) cancel();
      // A new physical press is a deliberate interaction with the open sheet.
      // The click synthesized from the original long press has no new pointerdown.
      if (suppress.current) suppress.current = null;
    };
    const releaseClick = (event: MouseEvent) => {
      if (!suppress.current || suppress.current.until <= Date.now() || event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerdown", second, { passive: true });
    document.addEventListener("click", releaseClick, true);
    document.addEventListener("pointerup", cancel);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("scroll", cancel, true);
    document.addEventListener("visibilitychange", cancel);
    window.addEventListener("blur", cancel);
    return () => { cancel(); document.removeEventListener("pointermove", move); document.removeEventListener("pointerdown", second); document.removeEventListener("click", releaseClick, true); document.removeEventListener("pointerup", cancel); document.removeEventListener("pointercancel", cancel); document.removeEventListener("scroll", cancel, true); document.removeEventListener("visibilitychange", cancel); window.removeEventListener("blur", cancel); };
  }, [objectId, cancel]);
  return {
    cancelPending: cancel,
    openFromTrigger: (trigger) => show(trigger, trigger),
    menuProps: { open: state.open && state.objectId === objectId, onOpenChange: (open) => setState((current) => ({ ...current, open })), anchor: state.anchor, returnFocus: state.trigger, presentation: state.touch ? "sheet" : "auto" },
    bind: {
      onContextMenu: (event) => {
        if (suppress.current && suppress.current.until > Date.now() && suppress.current.target.contains(event.target as Node)) { event.preventDefault(); return; }
        if (!canOpenObjectActions(event.target, event.currentTarget)) return;
        event.preventDefault();
        show(event.currentTarget, { x: event.clientX, y: event.clientY });
      },
      onKeyDown: (event) => { if (canOpenObjectActions(event.target, event.currentTarget) && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) { event.preventDefault(); show(event.currentTarget, event.currentTarget); } },
      onPointerDown: (event) => {
        if (event.pointerType !== "touch" || !event.isPrimary || event.button !== 0 || !canOpenObjectActions(event.target, event.currentTarget)) return;
        cancel();
        const target = event.currentTarget;
        const timer = setTimeout(() => {
          if (!target.isConnected) return;
          suppress.current = { target, until: Date.now() + 900 };
          show(target, target, true);
        }, 450);
        candidate.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, target, timer };
      },
      onClickCapture: (event) => {
        if (suppress.current && suppress.current.until > Date.now() && suppress.current.target.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); suppress.current = null; }
      }
    }
  };
}
