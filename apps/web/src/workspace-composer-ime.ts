export type WorkspaceComposerKeyboardEvent = Pick<KeyboardEvent, "key" | "isComposing" | "keyCode">;

/**
 * Safari can dispatch compositionend before the Enter keydown and report
 * isComposing as false. UI Events reserves keyCode 229 for keydowns processed
 * by an IME, so keep that legacy signal as the compatibility fallback.
 */
export function isImeCompositionEnter(event: WorkspaceComposerKeyboardEvent) {
  return event.key === "Enter" && (event.isComposing || event.keyCode === 229);
}
