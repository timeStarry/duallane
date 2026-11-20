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
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const output = fileURLToPath(new URL("../../../../.private-test-results/chat-navigation/", import.meta.url));
await fs.mkdir(output, { recursive: true });
const errors = [];
try {
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: width === 1280 ? 850 : 844 }, reducedMotion: "reduce" });
    await page.bringToFront();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ settings: {}, commands: [], threads: [], preferences: {} }) }));
    const acknowledged = [];
    let releaseRead;
    await page.route("**/api/v1/conversations/*/read", async (route) => {
      const marker = route.request().postDataJSON();
      acknowledged.push(marker);
      if (marker.messageId === "async-new-0") await new Promise((resolve) => { releaseRead = resolve; });
      await route.fulfill({ json: { ok: true, lastReadMessageId: marker.messageId, unreadCount: 0,
        lastReadSeq: marker.messageId === "async-new-0" ? 85 : 86 } });
    });
    await page.goto(origin + "/workspace?preview=1");
    await page.locator('section[aria-label="共享空间对话"]').waitFor({ state: "attached" });
    await page.evaluate(async () => {
      const { useWorkspaceStore: ws } = await import("/src/entities/workspace/store.ts");
      const { useLaneStore: lane } = await import("/src/entities/lane/store.ts");
      const members = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`member-${i}`, { id: `member-${i}`, displayName: `成员${String(i).padStart(2, "0")}`, role: i === 0 ? "owner" : "member" }]));
      const message = (id, conversationId = "chat-a") => ({ id, conversationId, kind: "user", senderId: "member-1", senderName: "成员01", plainText: `验收消息 ${id}，用于验证真实消息列表中的滚动定位。`, createdAt: "2026-11-17T06:00:00Z", reactions: {}, status: "sent" });
      const conversations = Object.fromEntries(["chat-a", "chat-b"].map((id) => [id, { id, kind: "group", title: id === "chat-a" ? "导航验收群" : "另一个群", unreadCount: 0, mentionCount: 0, memberIds: Object.keys(members), pinnedMessageIds: [] }]));
      ws.setState({ isPreviewMode: true, connectionStatus: "connected", currentUser: members["member-0"], members, conversations, conversationOrder: Object.keys(conversations), activeConversationId: "chat-a", conversationEntry: null, liveIncomingIdsByConv: {},
        messagesByConv: { "chat-a": Array.from({ length: 80 }, (_, i) => message(`message-${i}`)), "chat-b": [message("other", "chat-b")] }, drafts: {}, highlightedMessageId: null });
      lane.setState({ activeLane: "workspace", entryView: "workspace", mobileView: "chat", inspectorOpen: false });
      ws.getState().selectConversation("chat-a");
      window.chatFixture = { ws, lane, message, append(id, overrides = {}, type = "message.created") {
        ws.getState().applyRealtimeEvent({ type, conversationId: "chat-a", payload: { message: { id, conversationId: "chat-a", authorId: "member-1", authorName: "成员01", authorKind: "human", kind: "user", plainText: `新的验收消息 ${id}`, createdAt: "2026-11-17T06:01:00Z", content: { format: "blocks", plainText: `新的验收消息 ${id}`, blocks: [] }, reactions: [], attachments: [], ...overrides } } });
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
    // A history window expanded by 55 rows used to put 55 on this exact badge.
    const bottomButton = page.getByTestId("scroll-to-bottom-btn");
    await timeline.evaluate((el) => { el.scrollTop = 0; });
    await expect(bottomButton).toHaveText("回到底部");
    await page.evaluate(() => {
      const { ws, message, append } = window.chatFixture;
      ws.setState((s) => ({ messagesByConv: { ...s.messagesByConv, "chat-a": [
        ...Array.from({ length: 55 }, (_, i) => message(`older-${i}`)), ...s.messagesByConv["chat-a"],
      ] } }));
      append("message-79");
      append("system", { kind: "system" });
      append("self", { authorId: "member-0" });
      append("hidden", { hiddenByCurrentUser: true });
      append("topic-only", { topicId: "topic-a" });
      append("thread-only", { threadRootId: "message-79", alsoSendToChannel: false });
    });
    await expect(bottomButton).toHaveText("回到底部");
    await page.evaluate(() => {
      const { append } = window.chatFixture;
      append("live-1"); append("live-1"); append("live-2");
      append("live-3"); append("live-3", { recalledAt: "2026-11-17T06:01:30Z" }, "message.recalled");
    });
    await expect(bottomButton).toHaveText("回到底部2");
    await expect(timeline.getByRole("separator", { name: "以下为新消息" })).toHaveCount(1);
    await page.screenshot({ path: output + `unread-bottom-${width}.png` });
    assert.equal(await page.evaluate(() => window.chatFixture.ws.getState().conversations["chat-a"].unreadCount), 2);
    await bottomButton.click();
    await expect.poll(bottomDistance).toBeLessThan(3);
    await expect.poll(() => page.evaluate(() => window.chatFixture.ws.getState().conversations["chat-a"].unreadCount)).toBe(0);
    // Leave, receive real-shaped events while inactive, return to latest with a stable unread anchor.
    await timeline.evaluate((el) => { el.scrollTop = 0; });
    await page.evaluate(() => { const { ws, append } = window.chatFixture; ws.getState().selectConversation("chat-b"); for (let i = 0; i < 15; i++) append(`new-${i}`); ws.getState().selectConversation("chat-a"); });
    await expect.poll(bottomDistance).toBeLessThan(3);
    const banner = page.getByTestId("return-unread-banner");
    await expect(banner).toHaveText("15 条新消息");
    await page.screenshot({ path: output + `unread-${width}.png` });
    await banner.click();
    const firstUnread = timeline.locator('[data-message-id="new-0"]');
    const divider = timeline.getByRole("separator", { name: "以下为新消息" });
    await expect.poll(() => divider.evaluate((el) => {
      const parent = el.closest('[data-testid="workspace-timeline-scroll"]');
      const bounds = el.getBoundingClientRect();
      const viewport = parent.getBoundingClientRect();
      return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    })).toBe(true);
    assert.equal(await firstUnread.evaluate((el) => el.previousElementSibling?.textContent), "以下为新消息");
    await page.screenshot({ path: output + `unread-divider-${width}.png` });
    await expect(banner).toHaveCount(0);
    if (await bottomButton.isVisible()) await bottomButton.click();
    await expect.poll(bottomDistance).toBeLessThan(3);
    await expect.poll(() => page.evaluate(() => window.chatFixture.ws.getState().conversations["chat-a"].unreadCount)).toBe(0);
    // Re-entry through lane controls also acknowledges unread exactly once.
    await page.evaluate(() => { const f = window.chatFixture; f.lane.getState().setActiveLane("p2p"); });
    await page.evaluate(() => { const f = window.chatFixture; f.append("lane-new-1"); f.append("lane-new-2"); });
    await page.evaluate(() => window.chatFixture.lane.getState().setActiveLane("workspace"));
    await expect(banner).toHaveText("2 条新消息");
    await expect.poll(bottomDistance).toBeLessThan(3);
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
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (width !== 1280) {
      await page.close();
      console.log(`PASS chat navigation ${width}px`);
      continue;
    }
    // A cached tail is stale: do not anchor until the selected history load resolves.
    let releaseHistory;
    const pendingHistory = new Promise((resolve) => { releaseHistory = resolve; });
    let historyRequested = false;
    const historyURL = "**/conversations/chat-a/messages*";
    await page.route(historyURL, async (route) => {
      historyRequested = true;
      await pendingHistory;
      const messages = Array.from({ length: 83 }, (_, i) => ({ id: i < 80 ? `cached-${i}` : `async-new-${i - 80}`,
        conversationId: "chat-a", authorId: "member-1", authorName: "成员01", authorKind: "human", kind: "user",
        plainText: `异步加载消息 ${i}`, createdAt: "2026-11-17T06:02:00Z",
        creationSeq: i === 80 ? 85 : i + 1, reactions: [], attachments: [] }));
      await route.fulfill({ json: { messages } });
    });
    await page.evaluate(() => {
      const f = window.chatFixture; f.ws.getState().selectConversation("chat-b");
      f.ws.setState((s) => ({ isPreviewMode: false, conversations: { ...s.conversations, "chat-a": { ...s.conversations["chat-a"],
        unreadCount: 3, firstUnreadMessageId: "async-new-0", lastReadMessageId: "cached-79", lastReadSeq: 80,
        lastMessageAt: "2026-11-17T06:02:00Z" } },
        messagesByConv: { ...s.messagesByConv, "chat-a": Array.from({ length: 80 }, (_, i) => f.message(`cached-${i}`)) } }));
      f.ws.getState().selectConversation("chat-a");
    });
    await expect.poll(() => historyRequested).toBe(true);
    await expect(banner).toBeDisabled();
    assert.deepEqual(acknowledged, []);
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      window.dispatchEvent(new window.Event("blur"));
      window.chatFixture.append("after-enter", { createdAt: "2026-11-17T06:03:00Z", creationSeq: 84 });
    });
    const historyResponse = page.waitForResponse(historyURL);
    releaseHistory();
    await (await historyResponse).finished();
    await expect.poll(() => page.evaluate(() => {
      const { conversationEntry, messagesByConv } = window.chatFixture.ws.getState();
      return {
        history: conversationEntry.history,
        firstUnread: conversationEntry.firstUnreadMessageId,
        tail: messagesByConv["chat-a"].slice(-4).map((message) => message.id),
      };
    }), { timeout: 10000 }).toEqual({ history: "ready", firstUnread: "async-new-0", tail: ["async-new-0", "async-new-1", "async-new-2", "after-enter"] });
    await expect(banner).toBeEnabled();
    await expect(banner).toHaveText("3 条新消息");
    await expect(timeline.locator('[data-message-id="after-enter"]')).toHaveCount(1);
    await expect.poll(bottomDistance).toBeLessThan(3);
    await banner.click();
    await expect.poll(() => timeline.locator('[data-message-id="async-new-0"]').evaluate((el) => {
      const list = el.closest('[data-testid="workspace-timeline-scroll"]');
      return el.getBoundingClientRect().top >= list.getBoundingClientRect().top && el.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom;
    })).toBe(true);
    assert.deepEqual(acknowledged, []);
    await page.evaluate(() => {
      delete document.hasFocus;
      window.dispatchEvent(new window.Event("focus"));
    });
    if (await bottomButton.isVisible()) await bottomButton.click();
    // The highest creation sequence can belong to a row before the visible tail.
    await expect.poll(() => acknowledged).toEqual([{ messageId: "async-new-0" }]);
    // A message delivered while the acknowledgement is pending must remain unread.
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      window.dispatchEvent(new window.Event("blur"));
      window.chatFixture.append("after-read-request", { createdAt: "2026-11-17T06:04:00Z", creationSeq: 86 });
    });
    releaseRead();
    await expect.poll(() => page.evaluate(() => {
      const conversation = window.chatFixture.ws.getState().conversations["chat-a"];
      return [conversation.lastReadMessageId, conversation.unreadCount, conversation.firstUnreadMessageId];
    })).toEqual(["async-new-0", 1, "after-read-request"]);
    await page.evaluate(() => {
      delete document.hasFocus;
      window.dispatchEvent(new window.Event("focus"));
    });
    await expect.poll(() => acknowledged).toEqual([{ messageId: "async-new-0" }, { messageId: "after-read-request" }]);
    await expect.poll(() => page.evaluate(() => window.chatFixture.ws.getState().conversations["chat-a"].unreadCount)).toBe(0);

    await page.evaluate(() => {
      const { ws } = window.chatFixture;
      ws.getState().selectConversation("chat-b");
      ws.setState((s) => ({ isPreviewMode: true, conversations: { ...s.conversations, "chat-a": {
        ...s.conversations["chat-a"], unreadCount: 150, firstUnreadMessageId: "outside-window", lastReadMessageId: "older-than-window", lastReadSeq: 0,
      } } }));
      ws.getState().selectConversation("chat-a");
    });
    await expect(banner).toHaveText("150 条新消息 · 当前可回看 85 条");
    await banner.click();
    await expect(timeline.getByRole("separator", { name: "当前可回看的新消息" })).toBeVisible();
    await page.close();
    console.log(`PASS chat navigation ${width}px`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await server.close(); }
