/* global URL, window, document, console */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

// Production AppV1/components and store, synthetic authorized data; no Go/model claim.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const output = fileURLToPath(new URL("../../../../.private-test-results/chat-navigation/", import.meta.url));
await fs.mkdir(output, { recursive: true });
const errors = [];
try {
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: width === 1280 ? 850 : 844 }, reducedMotion: "reduce" });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ settings: {}, commands: [], threads: [], preferences: {} }) }));
    await page.goto(origin + "/workspace?preview=1");
    await page.locator('section[aria-label="共享空间对话"]').waitFor({ state: "attached" });
    await page.evaluate(async () => {
      const { useWorkspaceStore: ws } = await import("/src/entities/workspace/store.ts");
      const { useLaneStore: lane } = await import("/src/entities/lane/store.ts");
      const members = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`member-${i}`, { id: `member-${i}`, displayName: `成员${String(i).padStart(2, "0")}`, role: i === 0 ? "owner" : "member" }]));
      const message = (id, conversationId = "chat-a") => ({ id, conversationId, kind: "user", senderId: "member-1", senderName: "成员01", plainText: `验收消息 ${id}，用于验证真实消息列表中的滚动定位。`, createdAt: "2026-11-17T06:00:00Z", reactions: {}, status: "sent" });
      const conversations = Object.fromEntries(["chat-a", "chat-b"].map((id) => [id, { id, kind: "group", title: id === "chat-a" ? "导航验收群" : "另一个群", unreadCount: 0, mentionCount: 0, memberIds: Object.keys(members), pinnedMessageIds: [] }]));
      ws.setState({ isPreviewMode: true, currentUser: members["member-0"], members, conversations, conversationOrder: Object.keys(conversations), activeConversationId: "chat-a", conversationEntry: null,
        messagesByConv: { "chat-a": Array.from({ length: 80 }, (_, i) => message(`message-${i}`)), "chat-b": [message("other", "chat-b")] }, drafts: {}, highlightedMessageId: null });
      lane.setState({ activeLane: "workspace", entryView: "workspace", mobileView: "chat", inspectorOpen: false });
      window.chatFixture = { ws, lane, message, append(id) {
        ws.getState().applyRealtimeEvent({ type: "message.created", conversationId: "chat-a", payload: { message: { id, conversationId: "chat-a", authorId: "member-1", authorName: "成员01", authorKind: "human", kind: "user", plainText: `新的验收消息 ${id}`, createdAt: "2026-11-17T06:01:00Z", content: { format: "blocks", plainText: `新的验收消息 ${id}`, blocks: [] }, reactions: [], attachments: [] } } });
      } };
    });
    const timeline = page.getByTestId("workspace-timeline-scroll");
    const bottomDistance = () => timeline.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(bottomDistance).toBeLessThan(3);
    const composer = page.getByRole("combobox");
    await composer.fill("@");
    const menu = page.getByTestId("mention-autocomplete-popover");
    await expect(menu).toBeVisible();
    const before = await timeline.evaluate((el) => el.scrollTop);
    for (let i = 0; i < 34; i++) {
      await composer.press("ArrowDown");
      const selected = menu.getByRole("option", { selected: true });
      await expect(selected).toHaveCount(1);
      assert.equal(await selected.evaluate((el) => {
        const option = el.getBoundingClientRect(), list = el.closest('[role="listbox"]').getBoundingClientRect();
        return option.top >= list.top && option.bottom <= list.bottom;
      }), true, `active mention visible at ${width}/${i}`);
      await expect(composer).toBeFocused();
    }
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.ok(Math.abs(await timeline.evaluate((el) => el.scrollTop) - before) <= 1, "menu must not scroll timeline");
    await page.screenshot({ path: output + `mentions-${width}.png` });
    await composer.press("Escape"); await composer.fill("");
    // Leave, receive real-shaped events while inactive, return to latest with a stable unread anchor.
    await timeline.evaluate((el) => { el.scrollTop = 0; });
    await page.evaluate(() => { const { ws, append } = window.chatFixture; ws.getState().selectConversation("chat-b"); for (let i = 0; i < 15; i++) append(`new-${i}`); ws.getState().selectConversation("chat-a"); });
    await expect.poll(bottomDistance).toBeLessThan(3);
    const banner = page.getByTestId("return-unread-banner");
    await expect(banner).toHaveText("15 条新消息");
    await page.screenshot({ path: output + `unread-${width}.png` });
    await banner.click();
    const firstUnread = timeline.locator('[data-message-id="new-0"]');
    await expect.poll(() => firstUnread.evaluate((el) => {
      const parent = el.closest('[data-testid="workspace-timeline-scroll"]');
      return Math.abs(el.getBoundingClientRect().top - parent.getBoundingClientRect().top - 12);
    })).toBeLessThan(3);
    await expect(banner).toHaveCount(0);
    await page.getByTestId("scroll-to-bottom-btn").click();
    await expect.poll(bottomDistance).toBeLessThan(3);
    // Re-entry through lane controls also acknowledges unread exactly once.
    await page.evaluate(() => { const f = window.chatFixture; f.lane.getState().setActiveLane("p2p"); });
    await page.evaluate(() => { const f = window.chatFixture; f.append("lane-new-1"); f.append("lane-new-2"); });
    await page.evaluate(() => window.chatFixture.lane.getState().setActiveLane("workspace"));
    await expect(banner).toHaveText("2 条新消息");
    await expect.poll(() => page.evaluate(() => window.chatFixture.ws.getState().conversations["chat-a"].unreadCount)).toBe(0);
    await page.getByRole("button", { name: "关闭新消息提示" }).click();
    await page.evaluate(() => window.chatFixture.lane.getState().setActiveLane("p2p"));
    await page.evaluate(() => window.chatFixture.lane.getState().setActiveLane("workspace"));
    await expect(banner).toHaveCount(0);
    // Mobile list leaves the same selected ID mounted; it must still accumulate unread.
    if (width < 761) {
      await page.evaluate(() => { const f = window.chatFixture; f.lane.getState().setMobileView("list"); f.append("mobile-new"); });
      assert.equal(await page.evaluate(() => window.chatFixture.ws.getState().conversations["chat-a"].unreadCount), 1);
      await page.evaluate(() => { const f = window.chatFixture; f.ws.getState().selectConversation("chat-a"); f.lane.getState().setMobileView("chat"); });
      await expect.poll(bottomDistance).toBeLessThan(3);
      await expect(banner).toHaveText("1 条新消息");
      await page.getByRole("button", { name: "关闭新消息提示" }).click();
    }
    // A cached tail is stale: do not anchor until the selected history load resolves.
    let releaseHistory;
    let historyRequested = false;
    await page.route("**/conversations/chat-a/messages*", async (route) => {
      historyRequested = true;
      await new Promise((resolve) => { releaseHistory = resolve; });
      const messages = Array.from({ length: 83 }, (_, i) => ({ id: i < 80 ? `cached-${i}` : `async-new-${i - 80}`,
        conversationId: "chat-a", authorId: "member-1", authorName: "成员01", authorKind: "human", kind: "user",
        plainText: `异步加载消息 ${i}`, createdAt: "2026-11-17T06:02:00Z", reactions: [], attachments: [] }));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages }) });
    });
    await page.evaluate(() => {
      const f = window.chatFixture; f.ws.getState().selectConversation("chat-b");
      f.ws.setState((s) => ({ isPreviewMode: false, conversations: { ...s.conversations, "chat-a": { ...s.conversations["chat-a"], unreadCount: 3 } },
        messagesByConv: { ...s.messagesByConv, "chat-a": Array.from({ length: 80 }, (_, i) => f.message(`cached-${i}`)) } }));
      f.ws.getState().selectConversation("chat-a");
    });
    await expect.poll(() => historyRequested).toBe(true);
    await expect(banner).toBeDisabled();
    releaseHistory();
    await expect(banner).toBeEnabled();
    await expect.poll(bottomDistance).toBeLessThan(3);
    await banner.click();
    await expect.poll(() => timeline.locator('[data-message-id="async-new-0"]').evaluate((el) => {
      const list = el.closest('[data-testid="workspace-timeline-scroll"]');
      return el.getBoundingClientRect().top >= list.getBoundingClientRect().top && el.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom;
    })).toBe(true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.close();
    console.log(`PASS chat navigation ${width}px`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await server.close(); }
