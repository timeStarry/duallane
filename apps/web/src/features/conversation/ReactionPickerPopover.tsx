import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { popupPosition, trackPopupScroll, type PopupAnchor } from "../../ui/primitives/popup";

/** A message tool must escape the history scroller's clipping and stacking context. */
export function ReactionPickerPopover({ anchor, placementAnchor, messageId, onDismiss, children }: {
  anchor: HTMLElement | null;
  placementAnchor: PopupAnchor | null;
  messageId: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!anchor || !popup) return;
    const update = () => {
      if (!anchor.isConnected) { dismissRef.current(); return; }
      // Measure the stylesheet's preferred size, not a previous viewport's
      // constrained size. Resizing back must restore the full emote grid.
      const { width, maxHeight } = popup.style;
      popup.style.width = "";
      popup.style.maxHeight = "";
      const preferredSize = { width: popup.offsetWidth, height: popup.scrollHeight };
      const visual = window.visualViewport;
      const viewport = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? innerWidth, height: visual?.height ?? innerHeight };
      const source = placementAnchor ?? anchor;
      const rect = source instanceof HTMLElement ? source.getBoundingClientRect() : { left: source.x, top: source.y, bottom: source.y, width: 0 };
      const clampY = (y: number) => Math.max(viewport.top + 12, Math.min(y, viewport.top + viewport.height - 12));
      // Long-press anchors can be whole messages taller than the viewport.
      // Their visible upper edge is a usable point; their offscreen bottom is not.
      const rectangle = { left: rect.left + rect.width - preferredSize.width, top: clampY(rect.top), bottom: clampY(rect.bottom), width: rect.width };
      if (rect.bottom - rect.top > viewport.height / 2) rectangle.bottom = rectangle.top;
      const next = popupPosition(rectangle, preferredSize, viewport);
      next.top = Math.max(viewport.top + 12, Math.min(next.top, viewport.top + viewport.height - 12 - Math.min(preferredSize.height, next.maxHeight)));
      popup.style.width = width;
      popup.style.maxHeight = maxHeight;
      setPosition(next);
    };
    update();
    // Menu-to-picker transitions first close their modal sheet and restore the
    // message trigger. Move focus afterwards without scrolling the message.
    // The dialog survives asynchronous pack settings; a disabled pack's tab
    // may be removed after opening and must not take keyboard focus with it.
    const focusFrame = requestAnimationFrame(() => popup.querySelector<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true }));
    let scrollIntentUntil = 0;
    const dismissForScroll = trackPopupScroll(anchor, () => performance.now() < scrollIntentUntil);
    const recordScrollIntent = (event: Event) => {
      if (event.target instanceof Node && popup.contains(event.target)) return;
      if (event instanceof KeyboardEvent && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      scrollIntentUntil = performance.now() + 900;
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popup.contains(event.target)) return;
      if (dismissForScroll(event)) dismissRef.current();
      else update();
    };
    const resize = new ResizeObserver(update);
    resize.observe(anchor);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("wheel", recordScrollIntent, { passive: true, capture: true });
    document.addEventListener("touchmove", recordScrollIntent, { passive: true, capture: true });
    document.addEventListener("keydown", recordScrollIntent, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      resize.disconnect();
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("wheel", recordScrollIntent, true);
      document.removeEventListener("touchmove", recordScrollIntent, true);
      document.removeEventListener("keydown", recordScrollIntent, true);
    };
  }, [anchor, placementAnchor]);

  return createPortal(<div ref={popupRef} className="workspace-reaction-popover" style={position} data-reaction-picker-message-id={messageId}>
    {children}
  </div>, anchor?.closest("dialog[open]") ?? document.body);
}
