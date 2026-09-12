import { afterEach, describe, expect, it, vi } from "vitest";
import { measurePopup, popupPosition, trackPopupScroll } from "./popup";

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

  it.each([
    { top: 1600, bottom: 1644 },
    { top: -700, bottom: -656 },
    { top: -200, bottom: 1500 }
  ])("keeps a menu visible when a retained anchor is outside the viewport: $top / $bottom", ({ top, bottom }) => {
    const viewport = { left: 20, top: 40, width: 800, height: 600 };
    const result = popupPosition({ left: 300, top, bottom, width: 44 }, { width: 256, height: 320 }, viewport);
    expect(result.top).toBeGreaterThanOrEqual(52);
    expect(result.top + Math.min(320, result.maxHeight)).toBeLessThanOrEqual(628);
    expect(result.maxHeight).toBeGreaterThan(0);
  });

  it("uses the visible edge of an oversized message rather than a 44px menu slit", () => {
    const result = popupPosition({ left: 80, top: -200, bottom: 1500, width: 500 }, { width: 256, height: 320 }, { left: 0, top: 0, width: 800, height: 600 });
    expect(result.maxHeight).toBeGreaterThanOrEqual(320);
    expect(result.top + 320).toBeLessThanOrEqual(588);
  });

  it("bounds a tall menu in a short visual viewport so its own content can scroll", () => {
    const result = popupPosition({ left: 850, top: 780, bottom: 824, width: 44 }, { width: 256, height: 720 }, { left: 80, top: 160, width: 220, height: 240 });
    expect(result.left).toBe(92);
    expect(result.width).toBe(196);
    expect(result.top).toBeGreaterThanOrEqual(172);
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(388);
  });

  it.each([0, 16, 24, 48])("never returns negative dimensions in a %ipx visual viewport", (size) => {
    const result = popupPosition({ left: 800, top: 1600, bottom: 1644, width: 44 }, { width: 256, height: 320 }, { left: 40, top: 80, width: size, height: size });
    expect(result.maxHeight).toBeGreaterThanOrEqual(0);
    expect(result.width).toBeGreaterThanOrEqual(0);
    expect(result.top).toBeGreaterThanOrEqual(80);
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(80 + size);
    expect(result.left + (result.width ?? 0)).toBeLessThanOrEqual(40 + size);
  });
});

describe("popup DOM measurement", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("includes the border box when placing an unconstrained menu above its anchor", () => {
    class ElementStub {
      getBoundingClientRect() { return { left: 100, top: 540, bottom: 584, width: 44 }; }
    }
    vi.stubGlobal("HTMLElement", ElementStub);
    vi.stubGlobal("window", { visualViewport: { offsetLeft: 40, offsetTop: 80, width: 600, height: 480 } });
    const popup = { offsetWidth: 256, offsetHeight: 100, clientHeight: 98, scrollHeight: 200 } as HTMLElement;
    const result = measurePopup(new ElementStub() as unknown as HTMLElement, popup);
    expect(result.top).toBe(332);
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
