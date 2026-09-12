export type PopupAnchor = HTMLElement | { x: number; y: number };
export type PopupPosition = { left: number; top: number; maxHeight: number; width?: number };

export function popupPosition(anchor: { left: number; top: number; bottom: number; width: number }, popup: { width: number; height: number }, viewport: { left: number; top: number; width: number; height: number }, matchWidth = false): PopupPosition {
  const gap = 6;
  const inset = 12;
  const insetX = Math.min(inset, Math.max(0, viewport.width / 2));
  const insetY = Math.min(inset, Math.max(0, viewport.height / 2));
  const availableHeight = Math.max(0, viewport.height - insetY * 2);
  const minY = viewport.top + insetY;
  const maxY = minY + availableHeight;
  const clampY = (value: number) => Math.max(minY, Math.min(value, maxY));
  const width = Math.min(matchWidth ? Math.max(anchor.width, popup.width) : popup.width, Math.max(0, viewport.width - insetX * 2));
  // A programmatic history scroll may retain the object while moving its
  // anchor off screen. Use its visible edge; a tall message is a point anchor.
  const anchorTop = clampY(anchor.top);
  const anchorBottom = anchor.bottom - anchor.top > viewport.height / 2 ? anchorTop : clampY(anchor.bottom);
  const below = maxY - anchorBottom - gap;
  const above = anchorTop - minY - gap;
  const useAbove = below < Math.min(popup.height, 240) && above > below;
  const maxHeight = Math.min(availableHeight, Math.max(44, useAbove ? above : below));
  const height = Math.min(popup.height, maxHeight);
  const preferredTop = useAbove ? anchorTop - gap - height : anchorBottom + gap;
  return {
    left: Math.max(viewport.left + insetX, Math.min(anchor.left, viewport.left + viewport.width - insetX - width)),
    top: Math.max(minY, Math.min(preferredTop, maxY - height)),
    maxHeight,
    width
  };
}

export function measurePopup(anchor: PopupAnchor, element: HTMLElement, matchWidth = false): PopupPosition {
  const rectangle = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
  const viewport = window.visualViewport;
  const height = element.scrollHeight + element.offsetHeight - element.clientHeight;
  return popupPosition(rectangle, { width: element.offsetWidth, height }, { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight }, matchWidth);
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
