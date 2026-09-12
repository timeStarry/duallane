import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const WIDTH_KEY = "duallane-workspace-list-width";
const MIN_WIDTH = 240;
const MAX_WIDTH = 420;

function loadWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH ? value : null;
  } catch { return null; }
}

function saveWidth(value: number | null) {
  try {
    if (value === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(value));
  } catch { /* Layout remains usable when browser storage is unavailable. */ }
}

/** The shared middle pane is a device layout preference, never conversation data. */
export function WorkspaceShell({ mobilePane, contextVisible, railCollapsed, hasObjectList = true, children }: {
  mobilePane: "list" | "main" | "details";
  contextVisible: boolean;
  railCollapsed?: boolean;
  hasObjectList?: boolean;
  children: ReactNode;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const [preferredWidth, setPreferredWidth] = useState(loadWidth);
  const [size, setSize] = useState({ container: 0, viewport: 0 });
  const drag = useRef<{ pointer: number; startX: number; startWidth: number; previous: number | null; width: number; target: HTMLElement } | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const element = shell.current;
    if (!element) return;
    const measure = () => setSize({ container: element.clientWidth, viewport: window.innerWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  const defaultWidth = size.viewport > 1100 ? 288 : 260;
  const maxWidth = Math.min(MAX_WIDTH, Math.max(0, size.container - 72 - (contextVisible && size.viewport > 1100 ? 360 : 0) - 320));
  const minWidth = Math.min(MIN_WIDTH, maxWidth);
  const clamp = (value: number) => Math.round(Math.min(maxWidth, Math.max(minWidth, value)));
  const width = size.container ? clamp(preferredWidth ?? defaultWidth) : defaultWidth;
  const resizable = size.viewport > 760 && hasObjectList && !railCollapsed;

  const finishDrag = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.target.hasPointerCapture(current.pointer)) current.target.releasePointerCapture(current.pointer);
    setDragging(false);
    const value = commit ? current.width : current.previous;
    setPreferredWidth(value);
    if (commit) saveWidth(value);
  };

  useEffect(() => {
    if (!resizable) finishDrag(false);
    const cancel = () => finishDrag(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) { event.preventDefault(); cancel(); }
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("blur", cancel); window.removeEventListener("keydown", onKey); };
  }, [resizable]);

  const changeWidth = (value: number | null) => {
    const next = value === null ? null : clamp(value);
    setPreferredWidth(next);
    saveWidth(next);
  };

  return <div ref={shell} style={{ "--workspace-object-list-width": `${width}px` } as CSSProperties}
    className={`workspace-product-shell mobile-pane-${mobilePane}${contextVisible ? "" : " context-hidden"}${railCollapsed ? " rail-collapsed" : ""}${hasObjectList ? "" : " object-list-hidden"}${dragging ? " resizing-object-list" : ""}`}>
    {children}
    {resizable && <div className="workspace-list-resizer" role="separator" tabIndex={0}
      aria-label="调整中栏宽度" aria-orientation="vertical" aria-controls="workspace-object-list"
      aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width} aria-valuetext={`${width} 像素`}
      title="拖动调整中栏宽度；双击恢复默认。方向键调整，Home / End 最窄 / 最宽。"
      onDoubleClick={() => changeWidth(null)}
      onKeyDown={(event) => {
        if (drag.current) return;
        const next = event.key === "ArrowLeft" ? width - 16 : event.key === "ArrowRight" ? width + 16 : event.key === "Home" ? minWidth : event.key === "End" ? maxWidth : undefined;
        if (next !== undefined) { event.preventDefault(); changeWidth(next); }
        else if (event.key === "Enter") { event.preventDefault(); changeWidth(null); }
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, startX: event.clientX, startWidth: width, previous: preferredWidth, width, target: event.currentTarget };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) return;
        current.width = clamp(current.startWidth + event.clientX - current.startX);
        setPreferredWidth(current.width);
      }}
      onPointerUp={(event) => { if (drag.current?.pointer === event.pointerId) finishDrag(true); }}
      onPointerCancel={() => finishDrag(false)}
      onLostPointerCapture={() => finishDrag(false)}
    />}
  </div>;
}
