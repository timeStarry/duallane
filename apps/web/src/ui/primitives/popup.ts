export type PopupAnchor = HTMLElement | { x: number; y: number };
export type PopupPosition = { left: number; top: number; maxHeight: number; width?: number };

export function popupPosition(anchor: { left: number; top: number; bottom: number; width: number }, popup: { width: number; height: number }, viewport: { left: number; top: number; width: number; height: number }, matchWidth = false): PopupPosition {
  const gap = 6;
  const inset = 12;
  const width = Math.min(matchWidth ? Math.max(anchor.width, popup.width) : popup.width, Math.max(0, viewport.width - inset * 2));
  const below = viewport.top + viewport.height - inset - anchor.bottom - gap;
  const above = anchor.top - viewport.top - inset - gap;
  const useAbove = below < Math.min(popup.height, 240) && above > below;
  const maxHeight = Math.max(44, useAbove ? above : below);
  return {
    left: Math.max(viewport.left + inset, Math.min(anchor.left, viewport.left + viewport.width - inset - width)),
    top: useAbove ? Math.max(viewport.top + inset, anchor.top - gap - Math.min(popup.height, maxHeight)) : Math.max(viewport.top + inset, anchor.bottom + gap),
    maxHeight: Math.min(maxHeight, viewport.height - inset * 2),
    width
  };
}

export function measurePopup(anchor: PopupAnchor, element: HTMLElement, matchWidth = false): PopupPosition {
  const rectangle = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
  const viewport = window.visualViewport;
  return popupPosition(rectangle, { width: element.offsetWidth, height: element.scrollHeight }, { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight }, matchWidth);
}

export function isNativeContent(target: EventTarget | null, actionRoot?: Element): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, a, [contenteditable]:not([contenteditable=false]), audio, video, [data-native-context]")) return true;
  const button = target.closest("button");
  if (!button) return false;
  // Only an explicitly marked object button opts in. Nested inputs/links and
  // native content above always keep their normal operations.
  return !button.hasAttribute("data-object-action-root") || button.disabled || button.getAttribute("aria-disabled") === "true" || Boolean(actionRoot && !actionRoot.contains(button));
}

export function canOpenObjectActions(target: EventTarget | null, actionRoot: Element): boolean {
  if (isNativeContent(target, actionRoot)) return false;
  const selection = actionRoot.ownerDocument.getSelection();
  return !selection || selection.isCollapsed;
}

export function captureAncestorScroll(anchor: HTMLElement | null | undefined): Map<HTMLElement, { left: number; top: number }> {
  const positions = new Map<HTMLElement, { left: number; top: number }>();
  for (let element = anchor; element; element = element.parentElement) positions.set(element, { left: element.scrollLeft, top: element.scrollTop });
  return positions;
}

export function trackPopupScroll(anchor: HTMLElement | null | undefined, isUserScroll?: () => boolean): (event: Event) => boolean {
  const positions = captureAncestorScroll(anchor);
  let rectangle = anchor?.getBoundingClientRect();
  let windowPosition = { left: window.scrollX, top: window.scrollY };
  return (event) => {
    let changed = false;
    if (event.target instanceof HTMLElement) {
      const previous = positions.get(event.target);
      changed = Boolean(previous && (event.target.scrollLeft !== previous.left || event.target.scrollTop !== previous.top));
      if (previous) positions.set(event.target, { left: event.target.scrollLeft, top: event.target.scrollTop });
    } else {
      changed = window.scrollX !== windowPosition.left || window.scrollY !== windowPosition.top;
      windowPosition = { left: window.scrollX, top: window.scrollY };
    }
    if (!changed) return false;
    const current = anchor?.getBoundingClientRect();
    // Prepending older messages compensates scrollTop to preserve the reading
    // anchor. Fractional layout rounding can move it by less than one CSS pixel.
    // That compensation must not dismiss the action the user just opened.
    const moved = !rectangle || !current || Math.abs(current.left - rectangle.left) > 1 || Math.abs(current.top - rectangle.top) > 1;
    rectangle = current;
    // Object menus distinguish deliberate scrolling from pagination, browser
    // anchoring and live layout changes. Other popup consumers retain the
    // existing anchor-movement policy unless they explicitly provide intent.
    return isUserScroll ? isUserScroll() : moved;
  };
}
