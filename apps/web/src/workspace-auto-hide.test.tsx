import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { classifyAutoHiddenContent, DEFAULT_AUTO_HIDE_PREFERENCES, isWorkspaceDisplayBlock, normalizeAutoHidePreferences, shouldCollapseWorkspaceMessageText, WorkspaceAutoHiddenContent } from "./workspace-auto-hide";

const classifyText = (text: string) => classifyAutoHiddenContent({ blocks: [{ type: "text", text }] });

describe("personal automatic message hiding", () => {
  it("defaults off for old servers and retains an empty selection", () => {
    expect(normalizeAutoHidePreferences({})).toEqual(DEFAULT_AUTO_HIDE_PREFERENCES);
    expect(normalizeAutoHidePreferences({ autoHideMessages: true, autoHideMessageTypes: [] }))
      .toEqual({ autoHideMessages: true, autoHideMessageTypes: [] });
  });

  it("classifies rendered Markdown images, references, and mixed content", () => {
    expect(classifyText("before ![a](https://example.test/a.png) after")).toEqual(["image"]);
    expect(classifyText("![a][photo]\n\n[photo]: https://example.test/a.png")).toEqual(["image"]);
    expect(classifyText("[a](https://example.test/a.png)")).toEqual([]);
    expect(classifyText("![a](javascript:alert)")).toEqual([]);
    expect(classifyText("`![a](https://example.test/a.png)`")).toEqual([]);
    expect(classifyText("~~~\n![a](https://example.test/a.png)\n~~~")).toEqual([]);
    expect(classifyText("\\![a](https://example.test/a.png)")).toEqual([]);
  });

  it("distinguishes images from emotes and ordinary files", () => {
    expect(classifyAutoHiddenContent({ blocks: [{ type: "emoji", shortcode: "custom:synthetic" }] })).toEqual(["emote"]);
    expect(classifyText("mixed [feishu:ok] 😀")).toEqual(["emote"]);
    expect(classifyText("`[feishu:ok] 😀` [unknown:ok]")).toEqual([]);
    expect(classifyText("~~~\n[feishu:ok] 😀\n~~~")).toEqual([]);
    expect(classifyText("🇨🇳 1️⃣")).toEqual(["emote"]);
    expect(classifyText("![😀](https://example.test/a.png)")).toEqual(["image"]);
    const blocks = [{ type: "attachment", attachmentId: "file" }];
    expect(classifyAutoHiddenContent({ blocks, attachments: [{ id: "file", mimeType: "image/png", status: "available" }] })).toEqual(["image"]);
    expect(classifyAutoHiddenContent({ blocks, attachments: [{ id: "file", mimeType: "application/pdf", status: "available" }] })).toEqual([]);
    expect(classifyAutoHiddenContent({ blocks, attachments: [{ id: "file", mimeType: "image/png", status: "removed" }] })).toEqual([]);
  });

  it("uses the existing Unicode and line thresholds including legacy text", () => {
    expect(classifyText("字".repeat(700))).toEqual([]);
    expect(classifyText("字".repeat(701))).toEqual(["long"]);
    expect(shouldCollapseWorkspaceMessageText([{ type: "text", text: "𠮷".repeat(700) }])).toBe(false);
    expect(classifyText(Array(10).fill("line").join("\n"))).toEqual([]);
    expect(classifyText(Array(11).fill("line").join("\r\n"))).toEqual(["long"]);
    expect(classifyAutoHiddenContent({ blocks: [], fallbackText: "字".repeat(701) })).toEqual(["long"]);
  });

  it("matches the renderer fallback for unknown blocks as plain text", () => {
    expect(isWorkspaceDisplayBlock({ type: "card" })).toBe(true);
    expect(isWorkspaceDisplayBlock({ type: "future_block" })).toBe(false);
    expect(classifyAutoHiddenContent({ blocks: [{ type: "future_block" }], fallbackText: "😀" })).toEqual(["emote"]);
    expect(classifyAutoHiddenContent({ blocks: [{ type: "future_block" }], fallbackText: "字".repeat(701) })).toEqual(["long"]);
    expect(classifyAutoHiddenContent({ blocks: [{ type: "future_block" }], fallbackText: "![a](https://example.test/a.png)" })).toEqual([]);
    expect(classifyAutoHiddenContent({ blocks: [], fallbackText: "![a](https://example.test/a.png)" })).toEqual([]);
  });

  it("does not mount hidden media or child effects until revealed", () => {
    function Content() { throw new Error("hidden content must not mount"); return null; }
    const html = renderToStaticMarkup(<WorkspaceAutoHiddenContent preferences={{ autoHideMessages: true, autoHideMessageTypes: ["image"] }} blocks={[{ type: "text", text: "![a](https://example.test/a.png)" }]}><Content /></WorkspaceAutoHiddenContent>);
    expect(html).toContain("已自动隐藏");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<img");
    const pending = renderToStaticMarkup(<WorkspaceAutoHiddenContent preferences={null} blocks={[]}><Content /></WorkspaceAutoHiddenContent>);
    expect(pending).toContain('aria-busy="true"');
  });

  it("shows unselected categories and all content when disabled", () => {
    for (const preferences of [DEFAULT_AUTO_HIDE_PREFERENCES, { autoHideMessages: true, autoHideMessageTypes: [] }, { autoHideMessages: true, autoHideMessageTypes: ["long"] as const }]) {
      const html = renderToStaticMarkup(<WorkspaceAutoHiddenContent preferences={{ ...preferences, autoHideMessageTypes: [...preferences.autoHideMessageTypes] }} blocks={[{ type: "text", text: "😀" }]}><span>visible</span></WorkspaceAutoHiddenContent>);
      expect(html).toContain("visible");
      expect(html).not.toContain("已自动隐藏");
    }
  });
});
