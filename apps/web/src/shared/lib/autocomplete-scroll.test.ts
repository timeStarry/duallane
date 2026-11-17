import { describe, expect, it } from "vitest";
import { revealAutocompleteOption } from "./autocomplete-scroll";

function viewport(scrollTop = 0) {
  return {
    getBoundingClientRect: () => ({ top: 100 }),
    clientTop: 1,
    clientHeight: 200,
    scrollHeight: 800,
    scrollTop,
  };
}

const option = (top: number, bottom: number) => ({ getBoundingClientRect: () => ({ top, bottom }) });

describe("autocomplete keyboard scrolling", () => {
  it("leaves a fully visible option and menu position untouched", () => {
    const menu = viewport(200);
    revealAutocompleteOption(menu, option(101, 145));
    expect(menu.scrollTop).toBe(200);
    revealAutocompleteOption(menu, option(257, 301));
    expect(menu.scrollTop).toBe(200);
  });

  it("reveals the nearest lower edge, including a partially clipped option", () => {
    const menu = viewport(120);
    revealAutocompleteOption(menu, option(280, 324));
    expect(menu.scrollTop).toBe(143);
  });

  it("reveals the nearest upper edge when moving back up", () => {
    const menu = viewport(300);
    revealAutocompleteOption(menu, option(80, 124));
    expect(menu.scrollTop).toBe(279);
  });

  it("supports wrapping from the final option to the first and back", () => {
    const menu = viewport(600);
    revealAutocompleteOption(menu, option(-499, -455));
    expect(menu.scrollTop).toBe(0);
    revealAutocompleteOption(menu, option(857, 901));
    expect(menu.scrollTop).toBe(600);
  });

  it("aligns an option taller than the viewport at its beginning", () => {
    const menu = viewport(200);
    revealAutocompleteOption(menu, option(150, 400));
    expect(menu.scrollTop).toBe(249);
  });

  it("ignores an unmeasurable closed menu and bounds scrolling to its extent", () => {
    const closedMenu = { ...viewport(100), clientHeight: 0 };
    revealAutocompleteOption(closedMenu, option(450, 494));
    expect(closedMenu.scrollTop).toBe(100);
    const menu = viewport(590);
    revealAutocompleteOption(menu, option(300, 350));
    expect(menu.scrollTop).toBe(600);
  });
});
