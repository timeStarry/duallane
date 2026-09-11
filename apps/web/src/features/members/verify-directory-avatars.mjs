import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createPortProbe } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// The full production App is mounted with isolated synthetic account projections.
// This checks rendered content geometry; it does not stand in for Go authorization.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const probe = createPortProbe();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = await createServer({ root, cacheDir: "node_modules/.vite-directory-avatar", server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
const baseline = process.argv.includes("--baseline");
const artifacts = fileURLToPath(new URL("../../../../../.private-test-results/directory-avatars/", import.meta.url));
await mkdir(artifacts, { recursive: true });
const now = "2026-09-11T08:00:00Z";
const person = (id, displayName, extra = {}) => ({ id, displayName, githubLogin: id, kind: "human", role: "member", joinedAt: now, capabilities: { canStartDirectConversation: true, canJoinGroups: true, canManage: true }, ...extra });
const members = [
  person("owner", "林遥", { role: "owner" }),
  person("latin", "Alex Chen"),
  person("long", "跨端体验与协作设计的长名称成员需要保持头像和文字分别对齐"),
  person("picture", "周予", { avatarUrl: "/api/workspace/avatars/picture/avatar-test" }),
  person("usr_system_echo", "回声", { kind: "bot", avatarUrl: "/assets/echo-avatar.svg", description: "需求与反馈助手" }),
  person("usr_system_beacon", "信标", { kind: "bot", avatarUrl: "/assets/beacon-avatar.png", description: "文件传输助手" })
];
const permissions = { canCreateMemberInvite: true, canCreatePrivilegedInvite: true, canManageMemberVisibility: true, canManageEmailSettings: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true, canViewOperationRecords: true };
const bootstrap = { auth: { mode: "github", inviteOnly: true, currentUser: members[0] }, space: { id: "s1", name: "清晰双轨体验空间", slug: "avatar-check", createdBy: "owner", createdAt: now }, policy: { dailyQuotaBytes: 1000000, usedTodayBytes: 0, remainingQuotaBytes: 1000000, messageRetentionCount: 1000 }, permissions, members, conversations: [], files: [], invites: [], inviteSummary: { total: 0, active: 0, history: 0, acceptedUses: 0, availableUses: 0 }, eventCursor: 0 };
const geometry = [];
const errors = [];
try {
  for (const width of [1440, 390, 320]) for (const themeId of ["original", "grove", "dusk"]) for (const mode of ["light", "dark"]) {
    if (baseline && (width !== 390 || themeId !== "original" || mode !== "light")) continue;
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width <= 760, isMobile: width <= 760, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.stack || error.message));
    await page.addInitScript(({ themeId, mode }) => localStorage.setItem("duallane-appearance", JSON.stringify({ version: 1, themeId, mode, density: "comfortable", motion: "reduced", transparency: "opaque" })), { themeId, mode });
    await page.routeWebSocket("**/ws/workspace", socket => socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false }))));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes("/avatars/")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#d7e4e0"/><circle cx="50" cy="36" r="18" fill="#38786a"/><path d="M18 92a32 32 0 0 1 64 0" fill="#38786a"/></svg>' });
      let data = { settings: {}, preferences: {}, collections: [], groups: [], emotes: [], topics: [], files: [], members, pins: [], messages: [], hasMore: false };
      if (path.endsWith("/bootstrap")) data = bootstrap;
      else if (path.endsWith("/conversations")) data = { conversations: [] };
      else if (path.endsWith("/emote-library")) data = { collections: [], favorites: [], recent: [], emotes: [] };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(`http://127.0.0.1:${port}/workspace/members`);
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const rows = page.locator(".workspace-member-main");
    await expect(rows).toHaveCount(members.length);
    await page.locator('.workspace-member-main .workspace-avatar img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    const measured = await rows.evaluateAll(elements => elements.map(element => {
      const avatar = element.querySelector('.workspace-avatar');
      const frame = avatar.getBoundingClientRect();
      const image = avatar.querySelector('img');
      let content;
      if (image) content = image.getBoundingClientRect();
      else { const range = document.createRange(); range.selectNodeContents(avatar); content = range.getBoundingClientRect(); }
      const target = element.getBoundingClientRect();
      return { name: element.querySelector('strong').textContent, kind: image ? 'image' : 'text', display: getComputedStyle(avatar).display,
        avatarWidth: frame.width, avatarHeight: frame.height, contentWidth: content.width, contentHeight: content.height,
        dx: (content.left + content.right - frame.left - frame.right) / 2, dy: (content.top + content.bottom - frame.top - frame.bottom) / 2,
        targetWidth: target.width, targetHeight: target.height };
    }));
    geometry.push({ width, themeId, mode, measured });
    await page.screenshot({ path: `${artifacts}/${baseline ? 'before-' : ''}members-${width}-${themeId}-${mode}.png` });
    if (!baseline) {
      for (const item of measured) {
        assert.equal(item.display, 'grid', `avatar layout is not overridden: ${item.name}`);
        assert(Math.abs(item.dx) <= 1, `content horizontal center ${item.name}: ${item.dx}px`);
        assert(Math.abs(item.dy) <= 1, `content vertical center ${item.name}: ${item.dy}px`);
        assert(item.targetWidth >= 44 && item.targetHeight >= 44, `member target remains 44px: ${item.name}`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no overflow at ${width}`);
      // A different consumer still uses the shared avatar's original layout.
      await rows.filter({ hasText: '林遥' }).click();
      const detailAvatar = page.locator('.workspace-context-profile .workspace-avatar');
      await expect(detailAvatar).toBeVisible();
      assert.equal(await detailAvatar.evaluate(el => getComputedStyle(el).display), 'grid');
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${artifacts}/${baseline ? 'before-' : ''}geometry.json`, JSON.stringify(geometry, null, 2));
  console.log(JSON.stringify({ baseline, combinations: geometry.length, maxTextDx: Math.max(...geometry.flatMap(result => result.measured.filter(row => row.kind === 'text').map(row => Math.abs(row.dx)))), maxTextDy: Math.max(...geometry.flatMap(result => result.measured.filter(row => row.kind === 'text').map(row => Math.abs(row.dy)))), artifacts }));
} finally { await browser.close(); await server.close(); }
