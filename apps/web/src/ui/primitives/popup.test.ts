import { afterEach, describe, expect, it, vi } from "vitest";
import { popupPosition, trackPopupScroll } from "./popup";

describe("popup viewport placement", () => {
  it("keeps a right-bottom menu inside the visible viewport", () => {
    const result = popupPosition({ left: 380, top: 820, bottom: 820, width: 0 }, { width: 256, height: 320 }, { left: 0, top: 0, width: 390, height: 844 });
    expect(result.left).toBe(122);
    expect(result.top).toBe(494);
    expect(result.left + (result.width ?? 0)).toBeLessThanOrEqual(378);
  });
  it("matches select width while respecting a narrow or zoomed viewport", () => {
    const result = popupPosition({ left: 34, top: 100, bottom: 144, width: 360 }, { width: 260, height: 400 }, { left: 20, top: 40, width: 240, height: 360 }, true);
    expect(result.width).toBe(216);
    expect(result.left).toBe(32);
    expect(result.maxHeight).toBeLessThanOrEqual(336);
  });
});

describe("popup scroll policies", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fixture() {
    class ElementStub {
      parentElement: ElementStub | null = null;
      scrollLeft = 0;
      scrollTop = 0;
      top = 100;
      getBoundingClientRect() { return { left: 20, top: this.top }; }
    }
    vi.stubGlobal("HTMLElement", ElementStub);
    vi.stubGlobal("window", { scrollX: 0, scrollY: 0 });
    const list = new ElementStub();
    const anchor = new ElementStub();
    anchor.parentElement = list;
    return { list, anchor, event: { target: list } as unknown as Event };
  }

  it("preserves the default Select policy and ignores queued unchanged scroll events", () => {
    const { list, anchor, event } = fixture();
    const dismiss = trackPopupScroll(anchor as unknown as HTMLElement);
    anchor.top += 36;
    expect(dismiss(event)).toBe(false);
    list.scrollTop += 40;
    expect(dismiss(event)).toBe(true);
    expect(dismiss(event)).toBe(false);
  });

  it("keeps object menus through large layout compensation but dismisses a subsequent user scroll", () => {
    const { list, anchor, event } = fixture();
    let userScroll = false;
    const dismiss = trackPopupScroll(anchor as unknown as HTMLElement, () => userScroll);
    list.scrollTop += 240;
    anchor.top += 36;
    expect(dismiss(event)).toBe(false);
    userScroll = true;
    expect(dismiss(event)).toBe(false);
    list.scrollTop += 40;
    expect(dismiss(event)).toBe(true);
  });
});
