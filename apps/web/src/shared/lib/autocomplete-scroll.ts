import { useEffect, useLayoutEffect, useRef } from "react";

type AutocompleteViewport = {
  getBoundingClientRect(): Pick<DOMRect, "top">;
  clientTop: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

type AutocompleteOption = {
  getBoundingClientRect(): Pick<DOMRect, "top" | "bottom">;
};

/** Reveal only within the menu; scrollIntoView can also move the chat/page. */
export function revealAutocompleteOption(
  viewport: AutocompleteViewport,
  option: AutocompleteOption
): void {
  if (viewport.clientHeight <= 0) return;
  const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop;
  const viewportBottom = viewportTop + viewport.clientHeight;
  const optionRect = option.getBoundingClientRect();
  let delta = 0;
  if (optionRect.top < viewportTop || optionRect.bottom - optionRect.top > viewport.clientHeight) {
    delta = optionRect.top - viewportTop;
  } else if (optionRect.bottom > viewportBottom) {
    delta = optionRect.bottom - viewportBottom;
  }
  if (delta !== 0) {
    viewport.scrollTop = Math.max(
      0,
      Math.min(viewport.scrollHeight - viewport.clientHeight, viewport.scrollTop + delta)
    );
  }
}

const useMenuLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useAutocompleteScroll({
  activeIndex,
  optionCount,
  listKey,
}: {
  activeIndex: number;
  optionCount: number;
  listKey: string | null;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useMenuLayoutEffect(() => {
    const list = listRef.current;
    if (!list || listKey === null || optionCount <= 0) return;
    const index = ((activeIndex % optionCount) + optionCount) % optionCount;
    const option = list.querySelector<HTMLElement>(`[data-autocomplete-index="${index}"]`);
    if (option) revealAutocompleteOption(list, option);
  }, [activeIndex, listKey, optionCount]);
  return listRef;
}
