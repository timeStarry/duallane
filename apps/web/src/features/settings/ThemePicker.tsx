import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "../../ui/primitives";
import { THEMES, type ColorMode, type ThemeId } from "../../ui/theme";

export function ThemePicker({ value, mode, onValueChange }: {
  value: ThemeId;
  mode: ColorMode;
  onValueChange: (value: ThemeId) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; left: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [edges, setEdges] = useState({ previous: false, next: false });
  const reveal = (button: HTMLButtonElement | null) => {
    const element = strip.current;
    if (!element || !button) return;
    const bounds = element.getBoundingClientRect();
    const target = button.getBoundingClientRect();
    // Align to the card's snap point; a minimal "nearest" offset can snap back
    // to the previous card and leave the newly focused choice clipped.
    if (target.left < bounds.left + 6 || target.right > bounds.right - 6) {
      element.scrollLeft += target.left - bounds.left - 6;
    }
  };
  const updateEdges = () => {
    const element = strip.current;
    if (!element) return;
    const previous = element.scrollLeft > 1;
    const next = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdges((current) => current.previous === previous && current.next === next ? current : { previous, next });
  };
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(element);
    updateEdges();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    reveal(strip.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? null);
  }, [value]);

  const move = (direction: number) => {
    const element = strip.current;
    if (element) element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: "auto" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".dl-theme-card")];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
      Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
    buttons[target]?.focus({ preventScroll: true });
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    // Touch/pen keep native scrolling and vertical page gestures. Mouse capture
    // starts only after movement, leaving ordinary clicks and focus untouched.
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, left: event.currentTarget.scrollLeft, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    if (event.buttons !== 1) { finishDrag(); return; }
    const distance = event.clientX - current.x;
    if (!current.moved && Math.abs(distance) <= 6) return;
    if (!current.moved) {
      current.moved = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = current.left - distance;
  };
  const finishDrag = () => { drag.current = null; setDragging(false); };

  return <section className="workspace-settings-detail dl-theme-section">
    <div className="dl-theme-heading"><h3>主题</h3><div className="dl-theme-navigation">
      <IconButton label="向前浏览主题" disabled={!edges.previous} onClick={() => move(-1)}><ChevronLeft size={18} aria-hidden="true" /></IconButton>
      <IconButton label="向后浏览主题" disabled={!edges.next} onClick={() => move(1)}><ChevronRight size={18} aria-hidden="true" /></IconButton>
    </div></div>
    <div ref={strip} className="dl-theme-options" role="group" aria-label="主题" data-dragging={dragging || undefined}
      onScroll={updateEdges} onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
      onPointerLeave={() => { if (!drag.current?.moved) finishDrag(); }}
      onClickCapture={(event) => {
        if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); }
      }}>
      {(Object.keys(THEMES) as ThemeId[]).map((themeId) => {
        const theme = THEMES[themeId];
        const colors = theme[mode];
        return <button type="button" className="dl-theme-card" key={themeId} aria-label={`${theme.name}主题`} aria-pressed={value === themeId}
          onClick={() => onValueChange(themeId)} onFocus={(event) => {
            if (!drag.current) reveal(event.currentTarget);
          }}>
          <span className="dl-theme-preview" aria-hidden="true" style={{ "--preview-bg": colors.bg, "--preview-surface": colors.surface, "--preview-soft": colors.soft, "--preview-accent": colors.shared, "--preview-direct": colors.direct } as CSSProperties}>
            <span className="dl-theme-preview-rail"><i /><i /><i /></span>
            <span className="dl-theme-preview-main"><span className="dl-theme-preview-header" /><span className="dl-theme-preview-message" /><span className="dl-theme-preview-message" /><span className="dl-theme-preview-composer" /></span>
          </span>
          <span className="dl-theme-card-caption"><strong>{theme.name}</strong><span className="dl-theme-card-check" aria-hidden="true"><Check size={14} /></span></span>
        </button>;
      })}
    </div>
  </section>;
}
