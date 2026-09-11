import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Real App/router/components, synthetic identity and transport. This does not
// establish that any membership, notification or moderation API is authorized.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../../../../../.private-test-results/topic-details-app/", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const probe = createPortProbe();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
assert(![5173, 5198].includes(port));
const server = await createServer({ root, cacheDir: "node_modules/.vite-topic-details-app", server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const now = "2026-09-11T08:00:00Z";
const members = ["林遥", "程一"].map((displayName, i) => ({ id: `u${i + 1}`, githubLogin: `details-${i + 1}`, displayName, kind: "human", role: i ? "member" : "owner", joinedAt: now, capabilities: { canStartDirectConversation: true, canJoinGroups: true } }));
const text = "阅读和输入保持连续，通知和管理可以在详情里按需打开。";
const message = { id: "m1", conversationId: "c1", topicId: "t1", authorId: "u2", authorName: "程一", authorKind: "human", author: members[1], kind: "user", plainText: text, content: { format: "blocks", plainText: text, blocks: [{ type: "text", text }] }, createdAt: now, attachments: [], reactions: [] };
const conversation = { id: "c1", spaceId: "s1", type: "group", title: "跨端设计讨论", retentionCount: 1000, createdAt: now, latestMessages: [], messageCount: 0, memberCount: 2, unreadCount: 0, notificationLevel: "all", members, capabilities: { canSendMessage: true, canUploadFile: true, canManageMembers: true } };
const bootstrap = { auth: { mode: "github", inviteOnly: true, currentUser: members[0] }, space: { id: "s1", name: "双轨设计", slug: "details", createdBy: "u1", createdAt: now }, policy: { dailyQuotaBytes: 1000000, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" }, permissions: { canCreateMemberInvite: true, canManageMemberVisibility: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true }, members, conversations: [conversation], files: [], invites: [], inviteSummary: {}, eventCursor: 0 };
const results = { layouts: [], errors: [], note: "Formal App and route, synthetic identity/HTTP/WebSocket; no real server API validation." };
try {
  for (const width of [1440, 390, 320]) for (const long of [false, true]) {
    const themeId = width === 1440 ? "beige" : "minimal", mode = width === 390 ? "dark" : "light";
    const topic = { id: "t1", conversationId: "c1", title: long ? "跨端阅读与输入体验的长期讨论：让一个非常长的话题标题也能保留清楚的导航和完整操作" : "阅读与输入体验", description: long ? "这是一段用于检验详情独立滚动的完整话题描述。\n".repeat(28) : "主会话专注于阅读和输入，通知、参与和管理动作按需展开。", createdBy: "u1", creator: members[0], status: "open", joined: true, canJoin: false, allowSyncToGroup: true, revision: 1, participantCount: 2, notificationLevel: "all", createdAt: now, updatedAt: now };
    const page = await browser.newPage({ viewport: { width, height: width > 760 ? 960 : 844 }, isMobile: width <= 760, hasTouch: width <= 760, reducedMotion: "reduce" });
    page.on("pageerror", error => results.errors.push(error.message));
    await page.addInitScript(({ themeId, mode }) => localStorage.setItem("duallane-appearance", JSON.stringify({ version: 1, themeId, mode, density: "comfortable", motion: "reduced", transparency: "auto" })), { themeId, mode });
    await page.routeWebSocket("**/ws/workspace", socket => socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false }))));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let data = { settings: {}, preferences: {}, collections: [], groups: [], emotes: [], topics: [topic], files: [], members, pins: [], messages: [], hasMore: false };
      if (path.endsWith("/bootstrap")) data = bootstrap;
      else if (path.endsWith("/conversations")) data = { conversations: [conversation] };
      else if (path.includes("/topics/t1")) {
        if (path.endsWith("/messages")) data = { messages: [message] };
        else if (path.endsWith("/members")) data = { members: members.map(member => ({ ...member, userId: member.id })) };
        else if (path.endsWith("/projections")) data = { projections: [] };
        else if (path.endsWith("/read")) data = { topicId: topic.id, unreadCount: 0 };
        else data = { topic };
      } else if (path.endsWith("/conversations/c1") || path.endsWith("/read")) data = { conversation };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    try {
      await page.goto(`http://127.0.0.1:${port}/workspace/topics/t1`);
      await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
      const trigger = page.getByRole("button", { name: "话题详情", exact: true });
      const dialog = page.getByRole("dialog", { name: "话题详情", exact: true });
      const composer = page.locator('.workspace-composer [role="textbox"]');
      await expect(trigger).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".dl-topic-toolbar")).toHaveCount(0);
      await expect(composer).toBeVisible();
      await composer.fill("打开详情之后继续编辑的草稿");
      const geometry = await page.locator(".dl-topic-banner").evaluate(element => {
        const rect = element.getBoundingClientRect(), button = element.querySelector('.dl-topic-details-trigger button').getBoundingClientRect();
        return { viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, height: rect.height, width: rect.width, trigger: { left: button.left, right: button.right, width: button.width, height: button.height } };
      });
      assert(geometry.pageWidth <= width);
      assert(geometry.trigger.width >= 44 && geometry.trigger.height >= 44 && geometry.trigger.left >= 0 && geometry.trigger.right <= width);
      const composerBefore = await page.locator(".workspace-composer").boundingBox();
      assert(composerBefore.y + composerBefore.height <= (width > 760 ? 960 : 844));
      const suffix = `${width}-${long ? "long" : "regular"}`;
      await page.screenshot({ path: `${output}/default-${suffix}.png` });
      await trigger.click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading", { name: topic.title, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "关闭话题详情", exact: true })).toBeFocused();
      await page.screenshot({ path: `${output}/open-${suffix}.png` });
      const body = dialog.locator(".dl-topic-details-body");
      const scroll = await body.evaluate(element => { element.scrollTop = element.scrollHeight; return { top: element.scrollTop, height: element.clientHeight, contentHeight: element.scrollHeight }; });
      if (long) assert(scroll.top > 0);
      await expect(dialog.getByRole("button", { name: "归档话题", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(composer).toHaveText("打开详情之后继续编辑的草稿");
      assert.deepEqual(await page.locator(".workspace-composer").boundingBox(), composerBefore);
      results.layouts.push({ ...geometry, themeId, mode, long, scroll });
    } finally { await page.close(); }
  }
  assert.deepEqual(results.errors, []);
  console.log(`Formal App topic details passed: ${results.layouts.length} default/open layouts, long title, independent scrolling, focus return and composer draft preservation.`);
} finally { await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2)); await browser.close(); await server.close(); }
