import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isWorkspaceEmoteCollectionReadOnly,
  shouldShowWorkspaceEmoteSourceSubscription,
  workspaceEmoteLibraryTotalItemCount
} from "./App";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(sourceDir, "App.tsx"), "utf8").replace(/\r\n/g, "\n");
const stylesSource = readFileSync(join(sourceDir, "styles.css"), "utf8").replace(/\r\n/g, "\n");

describe("workspace emote collection subscriptions", () => {
  it("uses the server readOnly projection as the content editing boundary", () => {
    expect(isWorkspaceEmoteCollectionReadOnly(null)).toBe(false);
    expect(isWorkspaceEmoteCollectionReadOnly({ sourceSubscription: null })).toBe(false);
    expect(isWorkspaceEmoteCollectionReadOnly({ sourceSubscription: { readOnly: false } })).toBe(false);
    expect(isWorkspaceEmoteCollectionReadOnly({ sourceSubscription: { readOnly: true } })).toBe(true);
  });

  it("keeps detached snapshots visible even when they are no longer eligible", () => {
    expect(shouldShowWorkspaceEmoteSourceSubscription({ eligible: false, status: "off" })).toBe(false);
    expect(shouldShowWorkspaceEmoteSourceSubscription({ eligible: true, status: "synced" })).toBe(true);
    expect(shouldShowWorkspaceEmoteSourceSubscription({ eligible: false, status: "detached" })).toBe(true);
  });

  it("combines local and subscribed counts without charging subscribed items as local", () => {
    expect(workspaceEmoteLibraryTotalItemCount({ itemCount: 12, subscribedItemCount: 8 })).toBe(20);
    expect(workspaceEmoteLibraryTotalItemCount({ itemCount: 12 })).toBe(12);
    expect(appSource).toContain("本地 {library.usage.itemCount} 张");
    expect(appSource).toContain("订阅 {library.usage.subscribedItemCount ?? 0} 张");
    expect(appSource).toContain("formatBytes(library.limits.maxTotalBytes)");
  });

  it("sends the explicit opt-in on whole-collection import only when the share allows it", () => {
    const previewStart = appSource.indexOf("function WorkspaceSharedEmoteCollectionPage(");
    const previewEnd = appSource.indexOf("function WorkspaceSharedEmoteCollectionDialog(", previewStart);
    const previewSource = appSource.slice(previewStart, previewEnd);

    expect(previewSource).toContain("const [subscribeToSourceChanges, setSubscribeToSourceChanges] = useState(false);");
    expect(previewSource).toContain("share.canSubscribeToSourceChanges === true");
    expect(previewSource).toContain("{ asCollection: true, subscribeToSourceChanges }");
    expect(previewSource).toContain("? { emoteIds, asCollection: false }");
    expect(previewSource).toContain('label="订阅原作者更新"');
  });

  it("updates subscriptions through the collection route and blocks every collection-content mutation", () => {
    const managerStart = appSource.indexOf("function WorkspaceEmoteManagerDialog(");
    const managerEnd = appSource.indexOf("function EmoteLibraryTile(", managerStart);
    const managerSource = appSource.slice(managerStart, managerEnd);

    expect(managerSource).toContain("/source-subscription`");
    expect(managerSource).toContain('{ method: "PUT", body: JSON.stringify({ enabled }) }');
    expect(managerSource).toContain('selectedSourceSubscription.status === "detached"');
    expect(managerSource).toContain("原合集已删除，当前内容作为快照保留。");
    expect(managerSource).toContain("disabled={busy || selectedCollectionReadOnly}");
    expect(managerSource).toContain("organizing={organizing && !selectedCollectionReadOnly}");
    expect(managerSource).toContain("WORKSPACE_EMOTE_LIBRARY_CHANGED_EVENT, refreshLibrary");
    expect(appSource).toContain('event.type === "emote.library.updated"');
    expect(appSource).toContain('event.targetType === "user"');
    expect(appSource).toContain('"emote.subscription_read_only": "订阅中的合集为只读，请先关闭订阅再修改。"');

    for (const mutation of [
      "renameCollection",
      "renameEmote",
      "moveCollectionItem",
      "moveCollectionItemTo",
      "addExistingToCollection",
      "removeCollectionItem"
    ]) {
      const functionStart = managerSource.indexOf(`async function ${mutation}`);
      expect(functionStart, mutation).toBeGreaterThan(-1);
      expect(managerSource.slice(functionStart, functionStart + 280), mutation).toContain("contentEditingBlocked(");
    }
  });

  it("keeps the opt-in and management controls touch-safe and responsive", () => {
    expect(stylesSource).toMatch(/\.workspace-shared-emote-import-options > \.workspace-setting-switch\s*\{[^}]*min-height:\s*52px;/s);
    expect(stylesSource).toContain(".workspace-emote-subscription-panel.detached");
    expect(stylesSource).toContain(".workspace-emote-readonly-note");
    expect(stylesSource).toMatch(/@media \(max-width: 760px\)[\s\S]*\.workspace-shared-emote-import-options\s*\{\s*display:\s*grid;/);
  });
});
