import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRouteView } from "../app-route";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

function navigation(view: WorkspaceRouteView, railCollapsed = false, canManageSpace = true) {
  return renderToStaticMarkup(<WorkspaceNavigation view={view} railCollapsed={railCollapsed} canManageSpace={canManageSpace} onNavigate={vi.fn()} onToggleRail={vi.fn()} />);
}

describe("workspace navigation collapse slot", () => {
  it.each(["files", "members", "account", "space"] as const)("keeps the collapse control disabled without referencing an absent middle list in %s", (view) => {
    const html = navigation(view);
    const toggle = html.match(/<button\b[^>]*workspace-rail-toggle[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('disabled=""');
    expect(toggle).toContain('aria-label="当前视图没有中栏"');
    expect(toggle).not.toContain("aria-controls");
    expect(toggle).not.toContain("aria-expanded");
    expect(html.indexOf("workspace-rail-toggle")).toBeLessThan(html.indexOf("dl-selection"));
  });

  it.each(["chat", "topics"] as const)("retains the existing collapsed/expanded semantics for %s", (view) => {
    for (const collapsed of [false, true]) {
      const toggle = navigation(view, collapsed).match(/<button\b[^>]*workspace-rail-toggle[^>]*>/)?.[0];
      expect(toggle).toContain(`aria-expanded="${!collapsed}"`);
      expect(toggle).toContain('aria-controls="workspace-object-list"');
      expect(toggle).not.toContain("disabled");
    }
  });

  it("retains role-based space navigation visibility", () => {
    expect(navigation("files", false, false)).not.toContain("<span>空间</span>");
    expect(navigation("files")).toContain("<span>空间</span>");
  });
});
