import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Exercise the real App with synthetic identity and transport. All API requests
// and Workspace sockets are intercepted; this fixture never changes server data.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../../../../../.private-test-results/member-filters/", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const probe = createPortProbe();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = await createServer({ root, cacheDir: "node_modules/.vite-member-filters", server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const now = "2026-09-11T08:00:00Z";
const members = [
  { id: "u1", displayName: "筛选空间主人", githubLogin: "filter-owner", kind: "human", role: "owner" },
  { id: "u2", displayName: "筛选普通成员", githubLogin: "filter-member", kind: "human", role: "member" },
  { id: "u3", displayName: "筛选机器人", githubLogin: "filter-bot", kind: "bot", role: "member" },
  { id: "u4", displayName: "筛选系统成员", githubLogin: "filter-system", kind: "system", role: "member" }
].map(member => ({ ...member, joinedAt: now, capabilities: { canStartDirectConversation: false, canJoinGroups: false } }));
const results = { layouts: [], errors: [], note: "Formal App with synthetic HTTP/WebSocket; role and type filters are local only." };

try {
  for (const width of [1440, 390, 320]) for (const role of ["owner", "member"]) {
    const page = await browser.newPage({ viewport: { width, height: width === 1440 ? 960 : 844 }, isMobile: width <= 760, hasTouch: width <= 760, reducedMotion: "reduce" });
    page.on("pageerror", error => results.errors.push(error.message));
    const currentUser = members[role === "owner" ? 0 : 1];
    const bootstrap = {
      auth: { mode: "github", inviteOnly: true, currentUser },
      space: { id: "s1", name: "筛选验收空间", slug: "filters", createdBy: "u1", createdAt: now },
      policy: { dailyQuotaBytes: 1000000, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" },
      permissions: { canCreateMemberInvite: false, canCreatePrivilegedInvite: role === "owner", canReadConversations: true, canCreateGroup: false, canCreateDirect: false, canUpload: false, canDownload: false },
      members, conversations: [], files: [], invites: [], inviteSummary: {}, eventCursor: 0
    };
    await page.addInitScript(({ dark }) => localStorage.setItem("duallane-appearance", JSON.stringify({ version: 1, themeId: dark ? "minimal" : "beige", mode: dark ? "dark" : "light", density: "comfortable", motion: "reduced", transparency: "auto" })), { dark: width === 390 });
    await page.routeWebSocket("**/ws/workspace", socket => socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false }))));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const data = path.endsWith("/bootstrap") ? bootstrap : { settings: {}, preferences: {}, conversations: [], collections: [], groups: [], emotes: [], topics: [], files: [], members, pins: [], messages: [], hasMore: false };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    try {
      await page.goto(`http://127.0.0.1:${port}/workspace/members`);
      await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
      const list = page.getByRole("list", { name: "成员列表", exact: true });
      await expect(list.getByRole("listitem")).toHaveCount(4);
      const trigger = page.getByRole("button", { name: "筛选", exact: true });
      await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
      await trigger.click();
      const popup = page.getByRole("dialog", { name: "成员筛选", exact: true });
      const types = popup.getByRole("radiogroup", { name: "按类型筛选", exact: true });
      const allTypes = types.getByRole("radio", { name: "全部类型", exact: true });
      await expect(types.getByRole("radio")).toHaveCount(4);
      await expect(popup.getByRole("combobox")).toHaveCount(0);
      const roles = popup.getByRole("menu", { name: "按角色筛选", exact: true });
      if (role === "owner") {
        const allRoles = roles.getByRole("menuitemradio", { name: "全部角色", exact: true });
        await expect(allRoles).toBeFocused();
        await expect(roles.getByRole("menuitemradio")).toHaveCount(5);
        await page.keyboard.press("ArrowDown");
        await expect(roles.getByRole("menuitemradio", { name: "主人", exact: true })).toBeFocused();
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await expect(roles.getByRole("menuitemradio", { name: "预留角色", exact: true })).toHaveAttribute("aria-checked", "true");
        await expect(list.getByRole("listitem")).toHaveCount(0);
        await allRoles.click();
        await page.keyboard.press("Tab");
      } else {
        await expect(roles).toHaveCount(0);
      }
      await expect(allTypes).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(types.getByRole("radio", { name: "成员", exact: true })).toHaveAttribute("aria-checked", "true");
      await expect(list.getByRole("listitem")).toHaveCount(2);
      await page.keyboard.press("ArrowRight");
      await expect(types.getByRole("radio", { name: "机器人", exact: true })).toHaveAttribute("aria-checked", "true");
      await expect(list.getByRole("listitem")).toHaveCount(1);
      await expect(list).toContainText("筛选机器人");
      await page.keyboard.press("End");
      await expect(list).toContainText("筛选系统成员");
      await page.keyboard.press("Home");
      await expect(allTypes).toHaveAttribute("aria-checked", "true");
      await expect(list.getByRole("listitem")).toHaveCount(4);
      const geometry = await popup.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, pageWidth: document.documentElement.scrollWidth, options: [...element.querySelectorAll('[role="radio"]')].map(button => { const rect = button.getBoundingClientRect(); return { top: rect.top, width: rect.width, height: rect.height }; }) };
      });
      assert(geometry.left >= 0 && geometry.right <= width && geometry.width <= width - 32);
      assert(geometry.pageWidth <= width && geometry.scrollWidth <= geometry.clientWidth);
      assert(geometry.options.every(option => option.width >= 44 && option.height >= 44 && option.top === geometry.options[0].top));
      await page.screenshot({ path: `${output}/${role}-${width}.png` });
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.getByRole("heading", { name: role === "owner" ? "空间成员" : "可联系成员", exact: true }).click();
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();
      results.layouts.push({ width, role, ...geometry });
    } finally { await page.close(); }
  }
  assert.deepEqual(results.errors, []);
  console.log(`Member filters passed: ${results.layouts.length} owner/member layouts, single-row radio geometry, keyboard filtering and focus return.`);
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
