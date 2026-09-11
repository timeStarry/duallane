import type { RefObject } from "react";
import { useObjectActionScope } from "../../ui/patterns";

/** Conversation naming only; all object surfaces share gesture and focus rules. */
export function useMessageActions(scopeKey: string, messageIds: readonly string[], fallbackFocus?: RefObject<HTMLElement | null>) {
  const scope = useObjectActionScope(scopeKey, messageIds, fallbackFocus);
  return {
    messageId: scope.targetId,
    bindMessage: scope.bindObject,
    menuProps: scope.menuProps,
    openFromTrigger: scope.openFromTrigger
  };
}
