import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppearanceModeSelector } from "./AppearanceSettings";

describe("appearance display mode", () => {
  it.each(["light", "dark", "system"] as const)("exposes one selected keyboard entry and all three choices for %s", (value) => {
    const html = renderToStaticMarkup(<AppearanceModeSelector value={value} onValueChange={vi.fn()} />);
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    for (const label of ["浅色", "深色", "跟随系统"]) expect(html).toContain(label);
    expect(html).not.toContain('role="tab"');
  });
});
