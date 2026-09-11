import { useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type RefObject } from "react";
import { useObjectActions, type ObjectActionMenuProps } from "../primitives";
import { canOpenObjectActions } from "../primitives/popup";

export type ObjectActionScope = {
  targetId: string;
  bindObject: (id: string) => HTMLAttributes<HTMLElement>;
  openFromTrigger: (id: string, trigger: HTMLElement) => void;
  menuProps: Pick<ObjectActionMenuProps, "open" | "onOpenChange" | "anchor" | "returnFocus" | "presentation" | "fallbackFocus">;
};

/** One gesture controller per list; rows only receive React event bindings.
 * Domain adapters still own capabilities, confirmation and authorized execution. */
export function useObjectActionScope(scopeKey: string, objectIds: readonly string[], fallbackFocus?: RefObject<HTMLElement | null>): ObjectActionScope {
  const controller = useObjectActions(scopeKey);
  const [target, setTarget] = useState({ scopeKey, id: "" });
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const availableIds = useMemo(() => new Set(objectIds), [objectIds]);
  const targetId = target.scopeKey === scopeKey ? target.id : "";

  useLayoutEffect(() => {
    const scopeChanged = target.scopeKey !== scopeKey;
    const removed = targetId !== "" && !availableIds.has(targetId);
    if (!scopeChanged && !removed) return;
    controller.cancelPending();
    controller.menuProps.onOpenChange(false);
    setTarget({ scopeKey, id: "" });
    if (!removed) return;
    // A removed object may unmount the menu before its own close handler runs.
    // Do not steal focus from a real control or a newly entered scope.
    queueMicrotask(() => {
      const fallback = fallbackFocus?.current;
      if (currentScope.current === scopeKey && document.activeElement === document.body && fallback?.isConnected) fallback.focus({ preventScroll: true });
    });
  }, [availableIds, controller.cancelPending, controller.menuProps, fallbackFocus, scopeKey, target.scopeKey, targetId]);

  const bindObject = (id: string): HTMLAttributes<HTMLElement> => ({
    ...controller.bind,
    tabIndex: 0,
    onContextMenu: (event) => {
      if (!availableIds.has(id)) return;
      const eligible = canOpenObjectActions(event.target, event.currentTarget);
      controller.bind.onContextMenu?.(event);
      if (eligible && event.defaultPrevented) setTarget({ scopeKey, id });
    },
    onPointerDown: (event) => {
      if (!availableIds.has(id)) return;
      if (event.pointerType === "touch" && event.isPrimary && event.button === 0 && canOpenObjectActions(event.target, event.currentTarget)) setTarget({ scopeKey, id });
      controller.bind.onPointerDown?.(event);
    },
    onKeyDown: (event) => {
      if (!availableIds.has(id)) return;
      const eligible = canOpenObjectActions(event.target, event.currentTarget);
      controller.bind.onKeyDown?.(event);
      if (eligible && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && event.defaultPrevented) setTarget({ scopeKey, id });
    }
  });

  return {
    targetId,
    bindObject,
    menuProps: { ...controller.menuProps, open: controller.menuProps.open && availableIds.has(targetId), fallbackFocus: fallbackFocus?.current },
    openFromTrigger: (id, trigger) => {
      if (!availableIds.has(id)) return;
      setTarget({ scopeKey, id });
      controller.openFromTrigger(trigger);
    }
  };
}
