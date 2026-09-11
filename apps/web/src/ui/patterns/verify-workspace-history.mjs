import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Actual App with a controlled history response. This verifies reading position
// and menu stability; real Go tests retain message/pin authorization coverage.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false }, logLevel: "error", plugins: [{
  name: "observe-history-commit", enforce: "pre",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").endsWith("/src/App.tsx")) return;
    // A background conversation has no visible loading indicator. Observe its
    // real React commit in this fixture so response delivery alone cannot pass.
    const marker = "  const workspacePrependScrollRef = useRef<{";
    if (!source.includes(marker)) throw new Error("History commit observation point missing");
    return `import { useLayoutEffect as useHistoryCommitObserver } from "react";\n` + source.replace(marker, `  useHistoryCommitObserver(() => {
      window.dispatchEvent(new CustomEvent("duallane-test:history-layout-commit", { detail: {
        currentId: workspaceSelectedConversationId,
        count: workspaceMessageListRef.current?.querySelectorAll("article.workspace-message").length
      } }));
    }, [workspaceConversations, workspaceSelectedConversationId]);
    useEffect(() => {
      window.dispatchEvent(new CustomEvent("duallane-test:history-commit", { detail: {
        currentId: workspaceSelectedConversationId,
        counts: Object.fromEntries(workspaceConversations.map((conversation) => [conversation.id, conversation.latestMessages.length])),
        top: workspaceMessageListRef.current?.scrollTop
      } }));
    }, [workspaceConversations, workspaceSelectedConversationId]);
${marker}`);
  }
}] });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const now = "2026-09-11T08:00:00Z";
const user = { id: "u1", displayName: "历史回归", kind: "human", role: "owner", joinedAt: now };
const message = (index, conversationId = "c1") => {
  const text = `history-${index}` + (index < 25 && index % 3 === 0 ? "\n历史内容用于验证变高的分页。".repeat(8) : "");
  return { id: `${conversationId}-m${index}`, conversationId, authorId: "u1", authorName: user.displayName, authorKind: "human", kind: "user", content: { format: "blocks", plainText: text, blocks: [{ type: "text", text }] }, plainText: text, createdAt: new Date(Date.parse(now) + index * 1000).toISOString(), attachments: [], reactions: [] };
};
const latest = Array.from({ length: 20 }, (_, index) => message(index + 25));
const older = Array.from({ length: 40 }, (_, index) => message(index - 15));
const conversations = ["c1", "c2"].map((id) => ({ id, spaceId: "s1", type: "group", title: id === "c1" ? "分页会话" : "另一个会话", retentionCount: 1000, createdAt: now, messageCount: id === "c1" ? 60 : 20, memberCount: 1, notificationLevel: "all", members: [user], latestMessages: id === "c1" ? latest : latest.map((entry, index) => message(index + 25, "c2")), capabilities: { canSendMessage: true, canManageMembers: true } }));
const bootstrap = { auth: { mode: "github", inviteOnly: true, currentUser: user }, space: { id: "s1", name: "历史定位测试", slug: "history", createdBy: "u1", createdAt: now }, policy: { dailyQuotaBytes: 1000000, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" }, permissions: { canCreateMemberInvite: true, canCreatePrivilegedInvite: true, canManageMemberVisibility: true, canManageEmailSettings: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true, canViewOperationRecords: true }, members: [user], conversations, files: [], invites: [], inviteSummary: { total: 0, active: 0, history: 0, acceptedUses: 0, availableUses: 0 }, eventCursor: 0 };
const errors = [];
async function setup({ historyFailure = false, scrollTop = 170, interleaveHistory = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ interleaveHistory }) => {
    window.historyCommits = [];
    window.addEventListener("duallane-test:history-commit", (event) => window.historyCommits.push(event.detail));
    if (!interleaveHistory) return;
    // Deliver the already parsed HTTP response immediately after the realtime
    // append's DOM commit, before its passive effects. This is a valid network
    // completion ordering, held here without changing production React effects.
    const json = Response.prototype.json;
    Response.prototype.json = async function () {
      const data = await json.call(this);
      if (!this.url.includes("/c1/messages?before=")) return data;
      return new Promise((resolve) => { window.releaseHistoryJson = () => resolve(data); });
    };
    window.addEventListener("duallane-test:history-layout-commit", (event) => {
      if (event.detail.currentId === "c1" && event.detail.count === 21 && window.releaseHistoryJson) {
        window.releaseHistoryJson();
        window.releaseHistoryJson = null;
        window.historyInterleaved = true;
      }
    });
  }, { interleaveHistory });
  let releaseHistory;
  let waiting = false;
  let completed = false;
  let liveSocket;
  await page.routeWebSocket("**/ws/workspace", (socket) => {
    liveSocket = socket;
    socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false })));
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let data = { settings: {}, preferences: {}, collections: [], groups: [], emotes: [], topics: [], files: [], members: [user], pins: [], messages: [], hasMore: false };
    if (url.pathname.endsWith("/bootstrap")) data = bootstrap;
    else if (url.pathname.endsWith("/conversations")) data = { conversations };
    else if (url.pathname.endsWith("/messages")) {
      const conversationId = url.pathname.includes("/c2/") ? "c2" : "c1";
      if (url.searchParams.has("before") && conversationId === "c1" && (!completed || historyFailure)) {
        if (!completed) {
          waiting = true;
          await new Promise((resolve) => { releaseHistory = resolve; });
          completed = true;
        }
        if (historyFailure) {
          // A retry still fails in this scenario. Returning [] after the first
          // 503 would falsely report exhausted history and remove its control.
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "internal.error", message: "Synthetic history failure" } }) });
          return;
        }
        data = { messages: older, hasMore: false };
      } else data = { messages: url.searchParams.has("before") ? [] : conversations.find((conversation) => conversation.id === conversationId).latestMessages, hasMore: false };
    } else if (url.pathname.endsWith("/emote-library")) data = { collections: [], favorites: [], recent: [], emotes: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(origin + "/workspace/chat/c1");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator("article.workspace-message")).toHaveCount(20);
  const list = page.locator(".workspace-message-list");
  await list.evaluate((element, top) => { element.scrollTop = top; }, scrollTop);
  await expect.poll(() => waiting).toBe(true);
  return {
    page, list, release: () => releaseHistory(), target: page.locator('article[data-message-id="c1-m26"]'),
    append: () => liveSocket.send(JSON.stringify({ version: 1, type: "event", event: {
      id: "append-45", spaceId: "s1", seq: 1, type: "message.created", conversationId: "c1", createdAt: now,
      payload: { message: { ...message(45), authorId: "u2", authorName: "另一位成员" } }
    } }))
  };
}

try {
  // A network completion can land between a live append's commit and passive
  // effects. That older commit must not consume the pending prepend's anchor.
  {
    const { page, list, release, append } = await setup({ interleaveHistory: true });
    await list.hover({ position: { x: 40, y: 180 } });
    await page.mouse.wheel(0, -500);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
    const body = page.locator('[data-message-id="c1-m25"] .workspace-message-text');
    const before = await body.boundingBox();
    release();
    await expect.poll(() => page.evaluate(() => typeof window.releaseHistoryJson)).toBe("function");
    append();
    await expect.poll(() => page.evaluate(() => window.historyInterleaved)).toBe(true);
    await expect(page.locator("article.workspace-message")).toHaveCount(61);
    await expect.poll(async () => Math.abs((await body.boundingBox()).y - before.y)).toBeLessThanOrEqual(1);
    await page.close();
  }
  // An initial 20-row window must not drop its visible head on a live append,
  // even while pagination is pending or fails. Assert the body, not scrollTop.
  for (const historyFailure of [false, true]) {
    const { page, list, release, append } = await setup({ historyFailure });
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    const target = page.locator('[data-message-id="c1-m25"] .workspace-message-text');
    const before = await target.boundingBox();
    append();
    await expect(page.locator("article.workspace-message")).toHaveCount(21);
    await expect.poll(async () => Math.abs((await target.boundingBox()).y - before.y)).toBeLessThanOrEqual(1);
    release();
    if (historyFailure) await expect(page.getByText("Synthetic history failure", { exact: true })).toBeVisible();
    else await expect(page.locator("article.workspace-message")).toHaveCount(61);
    await expect.poll(async () => Math.abs((await target.boundingBox()).y - before.y)).toBeLessThanOrEqual(1);
    await page.close();
  }
  // A menu opens while an older-page request is pending. Native scroll anchoring
  // may compensate first; application compensation must never apply twice.
  {
    const { page, list, release, target } = await setup();
    await target.getByTitle("更多消息操作").click();
    const menu = page.getByRole("menu", { name: "消息操作" });
    await expect(menu).toBeVisible();
    const before = await target.boundingBox();
    release();
    await expect(page.locator("article.workspace-message")).toHaveCount(60);
    await expect(menu).toBeVisible();
    await expect.poll(async () => Math.abs((await target.boundingBox()).y - before.y)).toBeLessThanOrEqual(1);
    await expect(menu.getByRole("menuitem", { name: "设为常驻消息", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape"); await expect(target.getByTitle("更多消息操作")).toBeFocused();
    // An actual wheel movement must still dismiss an open menu.
    await target.getByTitle("更多消息操作").click();
    await list.hover({ position: { x: 40, y: 260 } });
    await page.mouse.wheel(0, 150);
    await expect(menu).toHaveCount(0);
    await page.close();
  }
  // Real pin regression: opening the second row at the very top triggers
  // pagination. The previous first row loses its author header when grouped;
  // the menu's row can move even though the first visible body is preserved.
  {
    const { page, release, target } = await setup({ scrollTop: 0 });
    await target.getByTitle("更多消息操作").click();
    const menu = page.getByRole("menu", { name: "消息操作" });
    await expect(menu).toBeVisible();
    const body = page.locator('[data-message-id="c1-m25"] .workspace-message-text');
    const before = await body.boundingBox();
    release();
    await expect(page.locator("article.workspace-message")).toHaveCount(60);
    await expect.poll(async () => Math.abs((await body.boundingBox()).y - before.y)).toBeLessThanOrEqual(1);
    await expect(menu.getByRole("menuitem", { name: "设为常驻消息", exact: true })).toBeEnabled();
    await page.keyboard.press("End"); await expect(menu).toBeVisible();
    await page.keyboard.press("Home"); await expect(menu.getByRole("menuitem", { name: "回复", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(target.getByTitle("更多消息操作")).toBeFocused();
    await page.close();
  }
  // Capture the latest user position at response time, not the request's start.
  {
    const { page, list, release } = await setup();
    await list.hover({ position: { x: 40, y: 200 } });
    const start = await list.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, 80);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(start);
    const target = page.locator('article[data-message-id="c1-m32"]');
    const before = await target.boundingBox();
    release();
    await expect(page.locator("article.workspace-message")).toHaveCount(60);
    await expect.poll(async () => Math.abs((await target.boundingBox()).y - before.y)).toBeLessThanOrEqual(1);
    await page.close();
  }
  // A late response for another conversation may update its cache only.
  {
    const { page, release } = await setup();
    await page.locator("button.conversation").filter({ hasText: "另一个会话" }).click();
    await expect(page).toHaveURL(/\/workspace\/chat\/c2$/);
    await expect(page.locator('article[data-message-id="c2-m44"]')).toBeVisible();
    const list = page.locator(".workspace-message-list");
    const before = await list.evaluate((element) => element.scrollTop);
    release();
    await expect.poll(() => page.evaluate(() => window.historyCommits.some((commit) => commit.currentId === "c2" && commit.counts.c1 === 60))).toBe(true);
    await expect(page.locator('article[data-message-id^="c1-"]')).toHaveCount(0);
    const consumed = await page.evaluate(() => window.historyCommits.find((commit) => commit.currentId === "c2" && commit.counts.c1 === 60));
    assert.equal(consumed.top, before);
    assert.equal(await list.evaluate((element) => element.scrollTop), before);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("Workspace history passed: actual App preserves menu/reading anchor across native+programmatic prepend, real wheel dismisses, latest in-flight user position preserved, late other-conversation response cannot alter current scroll.");
} finally { await browser.close(); await server.close(); }
