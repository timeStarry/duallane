import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Formal App + synthetic transport. Geometry and contrast are checked on actual
// message content and controls, rather than on an empty styled container.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const server = await createServer({ root, cacheDir: "node_modules/.vite-message-surfaces", server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const artifacts = fileURLToPath(new URL("../../../../../.private-test-results/message-surfaces/", import.meta.url));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch();
const now = "2026-09-11T08:00:00Z";
const members = ["林遥", "程一"].map((displayName, i) => ({ id: `u${i + 1}`, displayName, githubLogin: `person${i + 1}`, kind: "human", role: i ? "member" : "owner", joinedAt: now, capabilities: { canStartDirectConversation: true, canJoinGroups: true } }));
const messages = [
  { author: 0, text: "把话题留在群聊的上下文里。" },
  { author: 0, text: "我的连续消息，也应保持同样的底色。" },
  { author: 0, text: "首尾保留圆角，中间平直衔接。" },
  { author: 0, text: "每一条仍然能够独立回复。" },
  { author: 1, text: "同意，回复、提及和发送的操作习惯都保持一致。" },
  { author: 1, text: "长内容不应该被右侧操作遮住：" + "共享消息行和清晰的信息层级。".repeat(7) },
  { author: 0, text: "可以通过更多菜单继续操作。" }
].map(({ author, text }, i) => ({ id: `m${i}`, conversationId: "c1", authorId: members[author].id, authorName: members[author].displayName, authorKind: "human", kind: "user", plainText: text, content: { format: "duallane.message+json;v=1", plainText: text, blocks: [{ type: "text", text }] }, createdAt: new Date(Date.parse(now) + i * 1000).toISOString(), attachments: [], reactions: [] }));
const conversation = { id: "c1", spaceId: "s1", type: "group", title: "会话视觉验收", retentionCount: 1000, createdAt: now, latestMessages: messages, messageCount: messages.length, members, memberCount: 2, unreadCount: 0, notificationLevel: "all", capabilities: { canSendMessage: true, canUploadFile: true, canManageMembers: true } };
const bootstrap = { auth: { mode: "github", inviteOnly: true, currentUser: members[0] }, space: { id: "s1", name: "双轨设计", slug: "surfaces", createdBy: "u1", createdAt: now }, policy: { dailyQuotaBytes: 1000000, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" }, permissions: { canCreateMemberInvite: true, canManageMemberVisibility: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true }, members, conversations: [conversation], files: [], invites: [], inviteSummary: {}, eventCursor: 0 };
const errors = [];
let checked = 0;
try {
  for (const themeId of ["original", "grove", "dusk", "beige", "minimal"]) for (const mode of ["light", "dark"]) for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width <= 760, hasTouch: width <= 760, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ themeId, mode }) => localStorage.setItem("duallane-appearance", JSON.stringify({ version: 1, themeId, mode, density: "comfortable", motion: "reduced", transparency: "opaque" })), { themeId, mode });
    await page.routeWebSocket("**/ws/workspace", socket => socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false }))));
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      let data = { settings: {}, preferences: {}, collections: [], favorites: [], recent: [], emotes: [], groups: [], topics: [], files: [], members, messages: [], pins: [], hasMore: false };
      if (url.pathname.endsWith("/bootstrap")) data = bootstrap;
      else if (url.pathname.endsWith("/conversations")) data = { conversations: [conversation] };
      else if (url.pathname.endsWith("/messages")) data = { messages, hasMore: false };
      else if (url.pathname.endsWith("/read")) data = { conversation };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    try {
      await page.goto(origin + "/workspace/chat/c1");
      await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
      await expect(page.locator("article.workspace-message")).toHaveCount(7);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const own = page.locator('[data-message-id="m1"]');
      const other = page.locator('[data-message-id="m5"]');
      const colors = await page.evaluate(() => {
        const own = document.querySelector('[data-message-id="m1"]');
        const other = document.querySelector('[data-message-id="m5"]');
        return { own: getComputedStyle(own).backgroundColor, other: getComputedStyle(other).backgroundColor };
      });
      assert.notEqual(colors.own, colors.other, `${themeId}/${mode}/${width}: self and peer surfaces must differ at rest`);
      assert.notEqual(colors.own, "rgba(0, 0, 0, 0)");
      await expect(own).toHaveClass(/grouped/);
      const edges = await page.locator('article.workspace-message').evaluateAll(rows => rows.map(row => {
        const rect = row.getBoundingClientRect(), style = getComputedStyle(row);
        return { position: row.dataset.messageGroup, top: rect.top, bottom: rect.bottom, radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(parseFloat) };
      }));
      assert.deepEqual(edges.map(edge => edge.position), ['start', 'middle', 'middle', 'end', 'start', 'end', 'single']);
      for (let index = 0; index < edges.length; index++) {
        const { position, radii } = edges[index];
        const roundTop = position === 'start' || position === 'single';
        const roundBottom = position === 'end' || position === 'single';
        assert(radii.slice(0, 2).every(radius => roundTop ? radius > 0 : radius === 0), 'only group starts have rounded top edges');
        assert(radii.slice(2).every(radius => roundBottom ? radius > 0 : radius === 0), 'only group ends have rounded bottom edges');
        if (index > 0) assert(Math.abs(edges[index].top - edges[index - 1].bottom - (position === 'start' || position === 'single' ? 12 : 0)) < 0.1, 'continuous rows touch and distinct groups keep 12px spacing');
      }
      if (width > 760) {
        const first = page.locator('[data-message-id="m0"]');
        const neighborColor = await first.evaluate(row => getComputedStyle(row).backgroundColor);
        const beforeWidth = await own.locator('.workspace-message-content').evaluate(row => row.getBoundingClientRect().width);
        await own.hover();
        assert.notEqual(await own.evaluate(row => getComputedStyle(row).backgroundColor), colors.own);
        assert.equal(await first.evaluate(row => getComputedStyle(row).backgroundColor), neighborColor, 'hover only affects one message');
        assert.equal(await own.locator('.workspace-message-content').evaluate(row => row.getBoundingClientRect().width), beforeWidth);
      }
      for (const row of [own, other]) {
        if (width > 760) await row.hover();
        const geometry = await row.evaluate(element => {
          const row = element.getBoundingClientRect();
          const content = element.querySelector('.workspace-message-content').getBoundingClientRect();
          const actions = element.querySelector('.workspace-message-actions');
          const bounds = actions.getBoundingClientRect();
          const controls = [...actions.querySelectorAll('button')].filter(button => button.getClientRects().length > 0).map(button => { const r = button.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
          return { background: getComputedStyle(actions).backgroundColor, position: getComputedStyle(actions).position, row: { top: row.top, bottom: row.bottom, right: row.right }, contentRight: content.right, actionsLeft: bounds.left, controls };
        });
        assert.equal(geometry.background, 'rgba(0, 0, 0, 0)', 'actions inherit the message surface without an opaque toolbar');
        assert.notEqual(geometry.position, 'absolute', 'actions occupy a real row column');
        assert(geometry.contentRight <= geometry.actionsLeft + 1, 'toolbar never covers text');
        for (const control of geometry.controls) {
          const minTarget = width <= 760 ? 44 : 30;
          assert(control.width >= minTarget - 0.01 && control.height >= minTarget - 0.01, `preserve control hit targets: ${themeId}/${mode}/${width} ${JSON.stringify(control)}`);
          assert(control.y >= geometry.row.top - 1 && control.bottom <= geometry.row.bottom + 1, 'controls stay within their own row height');
          assert(control.right <= geometry.row.right + 1, 'controls stay inside message width');
        }
      }
      await own.getByTitle("更多消息操作", { exact: true }).click();
      const menu = page.getByRole(width > 760 ? "menu" : "dialog", { name: "消息操作", exact: true });
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(own.getByTitle("更多消息操作", { exact: true })).toBeFocused();
      await page.locator('.workspace-message-list').evaluate(list => { list.scrollTop = 0; });
      if (width > 760) await own.hover();
      await page.screenshot({ path: `${artifacts}/${themeId}-${mode}-${width}.png` });
      checked += 1;
    } finally { await page.close(); }
  }
  assert.deepEqual(errors, []);
  console.log(`Message surfaces passed: ${checked} production App theme/viewport cases; seamless group edges, group spacing, isolated hover, author distinction, embedded toolbar, nonoverlap, targets and menu focus.`);
} finally { await browser.close(); await server.close(); }
