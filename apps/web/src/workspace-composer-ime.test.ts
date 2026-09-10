import { describe, expect, it } from "vitest";
import { isImeCompositionEnter, type WorkspaceComposerKeyboardEvent } from "./workspace-composer-ime";

function enterEvent(overrides: Partial<WorkspaceComposerKeyboardEvent> = {}): WorkspaceComposerKeyboardEvent {
  return { key: "Enter", isComposing: false, keyCode: 13, ...overrides };
}

describe("Workspace composer IME Enter guard", () => {
  it("ignores Enter while the keyboard event reports an active composition", () => {
    expect(isImeCompositionEnter(enterEvent({ isComposing: true }))).toBe(true);
  });

  it("ignores Safari's Enter keydown after compositionend when keyCode is 229", () => {
    const compositionEnded = true;
    const keydown = enterEvent({ isComposing: !compositionEnded, keyCode: 229 });

    expect(isImeCompositionEnter(keydown)).toBe(true);
  });

  it("allows the ordinary Enter that follows the IME confirmation", () => {
    expect(isImeCompositionEnter(enterEvent({ keyCode: 229 }))).toBe(true);
    expect(isImeCompositionEnter(enterEvent())).toBe(false);
  });

  it("does not swallow ordinary Shift+Enter", () => {
    const shiftEnter = { ...enterEvent(), shiftKey: true };

    expect(isImeCompositionEnter(shiftEnter)).toBe(false);
  });

  it("leaves the IME commit's default action uncanceled", () => {
    let preventDefaultCalls = 0;
    const keydown = {
      ...enterEvent({ isComposing: true }),
      preventDefault: () => { preventDefaultCalls += 1; }
    };
    const shouldForward = !isImeCompositionEnter(keydown);
    if (shouldForward) keydown.preventDefault();

    expect(shouldForward).toBe(false);
    expect(preventDefaultCalls).toBe(0);
  });
});
