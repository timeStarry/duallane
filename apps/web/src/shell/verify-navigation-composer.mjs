import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Actual App and shared composer with synthetic identity/transport. This checks
// layout and interaction, not server authorization or message persistence.
const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = fileURLToPath(new URL("../../../../.private-test-results/navigation-composer/", import.meta.url));
const require = createRequire(new URL("../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const probe = createPortProbe();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
assert(![5173, 5198].includes(port));
const server = await createServer({ root, cacheDir: "node_modules/.vite-navigation-composer", server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
await mkdir(artifacts, { recursive: true });
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const now = "2026-09-11T08:00:00Z";
const members = ["林遥", "程一"].map((displayName, i) => ({ id: `u${i + 1}`, githubLogin: `layout-${i + 1}`, displayName, kind: "human", role: i ? "member" : "owner", joinedAt: now, capabilities: { canStartDirectConversation: true, canJoinGroups: true } }));
const messages = ["留出稳定的导航位置，让每个入口始终容易找到。", "输入器独立悬浮，周围与会话背景自然连接。"].map((text, i) => ({ id: `m${i}`, conversationId: "c1", authorId: members[i].id, authorName: members[i].displayName, authorKind: "human", kind: "user", plainText: text, content: { format: "blocks", plainText: text, blocks: [{ type: "text", text }] }, createdAt: now, attachments: [], reactions: [] }));
const conversations = ["c1", "c2"].map((id, i) => ({ id, spaceId: "s1", type: i ? "direct" : "group", title: i ? "程一" : "导航与输入区验收", retentionCount: 1000, createdAt: now, latestMessages: messages.map(message => ({ ...message, conversationId: id })), messageCount: 2, memberCount: 2, unreadCount: 0, notificationLevel: "all", members, capabilities: { canSendMessage: true, canUploadFile: true, canManageMembers: !i } }));
const topic = { id: "t1", conversationId: "c1", title: "讨论输入器与阅读体验", description: "正式共享话题，使用同一个消息输入器。", createdBy: "u1", creator: members[0], status: "open", joined: true, canJoin: false, allowSyncToGroup: true, revision: 1, participantCount: 2, notificationLevel: "all", createdAt: now, updatedAt: now };
const bootstrap = { auth: { mode: "github", inviteOnly: true, currentUser: members[0] }, space: { id: "s1", name: "双轨设计", slug: "layout", createdBy: "u1", createdAt: now }, policy: { dailyQuotaBytes: 1000000, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" }, permissions: { canCreateMemberInvite: true, canManageMemberVisibility: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true }, members, conversations, files: [], invites: [], inviteSummary: {}, eventCursor: 0 };
const results = { navigation: [], composer: [], errors: [], safeAreaEmulation: "not requested", note: "Formal App with synthetic identity/HTTP/WebSocket; no real message or authentication API validation." };
const navPositions = page => page.locator(".workspace-primary-navigation .dl-selection").evaluateAll(buttons => buttons.map(button => { const rect = button.getBoundingClientRect(); return { label: button.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }));

async function checkNavigation(page, width, themeId, mode) {
  if (width > 760) {
    const original = await navPositions(page);
    const toggle = page.locator(".workspace-rail-toggle");
    const box = await toggle.boundingBox();
    assert(box.width >= 44 && box.height >= 44);
    await toggle.focus();
    await expect(toggle).toBeFocused();
    assert(await toggle.evaluate(element => element.matches(":focus-visible")), "Collapse control preserves keyboard focus");
    for (const collapsed of [false, true]) {
      for (const label of ["文件", "成员"]) {
        await page.getByRole("navigation", { name: "共享空间视图" }).getByRole("button", { name: label, exact: true }).click();
        await expect(toggle).toBeDisabled();
        await expect(toggle).toBeVisible();
        assert.deepEqual(await navPositions(page), original, `${label}: all destinations retain their exact positions`);
        assert.deepEqual(await toggle.boundingBox(), box, `${label}: collapse slot geometry is stable`);
        assert.equal(await toggle.getAttribute("aria-controls"), null, "Disabled control does not reference absent middle list");
        const previousClass = await page.locator(".workspace-product-shell").getAttribute("class");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        assert.equal(await page.locator(".workspace-product-shell").getAttribute("class"), previousClass, "Disabled collapse cannot change layout state");
      }
      await page.getByRole("navigation", { name: "共享空间视图" }).getByRole("button", { name: "聊天", exact: true }).click();
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute("aria-expanded", String(!collapsed));
      assert.deepEqual(await navPositions(page), original);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", String(collapsed));
      assert.deepEqual(await navPositions(page), original, "Collapsing chat also keeps destination positions");
    }
    results.navigation.push({ viewportWidth: width, themeId, mode, positions: original });
  } else {
    const snapshots = [];
    for (const path of ["files", "members"]) {
      await page.goto(origin + "/workspace/" + path);
      await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
      await expect(page.locator(".workspace-rail-toggle")).toBeHidden();
      await expect(page.locator(".workspace-primary-navigation .dl-selection")).toHaveCount(6);
      snapshots.push(await navPositions(page));
    }
    assert.deepEqual(snapshots[0], snapshots[1], "Mobile navigation retains its six destinations without a collapse column");
    results.navigation.push({ viewportWidth: width, themeId, mode, positions: snapshots[0] });
  }
  if (themeId === "beige") await page.screenshot({ path: `${artifacts}/navigation-${themeId}-${mode}-${width}.png` });
}

async function setMaterial(page, transparency) {
  await page.evaluate(transparency => {
    const key = "duallane-appearance", oldValue = localStorage.getItem(key);
    const newValue = JSON.stringify({ ...JSON.parse(oldValue), transparency });
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue, storageArea: localStorage }));
  }, transparency);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--material-blur"))).toBe(transparency === "opaque" ? "0px" : "16px");
}

try {
  for (const width of [1440, 390, 320]) for (const themeId of ["original", "grove", "dusk", "beige", "minimal"]) for (const mode of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: width > 760 ? 960 : 844 }, isMobile: width <= 760, hasTouch: width <= 760, reducedMotion: "reduce" });
    page.on("pageerror", error => results.errors.push(error.message));
    let safeArea = 0;
    if (width <= 760) {
      const cdp = await page.context().newCDPSession(page);
      try { await cdp.send("Emulation.setSafeAreaInsets", { insets: { top: 0, left: 0, right: 0, bottom: 24 } }); safeArea = 24; results.safeAreaEmulation = "24px bottom inset"; }
      catch (error) {
        if (!String(error).includes("wasn't found")) throw error;
        results.safeAreaEmulation = "Installed Chromium cannot emulate nonzero safe-area insets; geometry uses its actual 0px inset. Cutout-device verification remains separate.";
      }
      finally { await cdp.detach(); }
    }
    await page.addInitScript(({ themeId, mode }) => {
      if (!localStorage.getItem("duallane-appearance")) localStorage.setItem("duallane-appearance", JSON.stringify({ version: 1, themeId, mode, density: "comfortable", motion: "reduced", transparency: "auto" }));
    }, { themeId, mode });
    await page.routeWebSocket("**/ws/workspace", socket => socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false }))));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let data = { settings: {}, preferences: {}, collections: [], groups: [], emotes: [], topics: [topic], files: [], members, pins: [], messages: [], hasMore: false };
      if (path.endsWith("/bootstrap")) data = bootstrap;
      else if (path.endsWith("/conversations")) data = { conversations };
      else if (path.includes("/topics/t1")) {
        if (path.endsWith("/messages")) data = { messages: messages.map(message => ({ ...message, topicId: topic.id, author: members.find(member => member.id === message.authorId) })) };
        else if (path.endsWith("/members")) data = { members: members.map(member => ({ ...member, userId: member.id })) };
        else if (path.endsWith("/projections")) data = { projections: [] };
        else if (path.endsWith("/read")) data = { topicId: topic.id, unreadCount: 0 };
        else data = { topic };
      } else if (path.endsWith("/messages")) data = { messages: conversations[path.includes("/c2/") ? 1 : 0].latestMessages, hasMore: false };
      else if (path.endsWith("/conversations/c1") || path.endsWith("/read")) data = { conversation: conversations[path.includes("/c2/") ? 1 : 0] };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    try {
      await page.goto(origin + "/workspace/chat/c1");
      await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
      await checkNavigation(page, width, themeId, mode);
      for (const [surface, path] of [["group", "chat/c1"], ["direct", "chat/c2"], ["topic", "topics/t1"]]) {
        await page.goto(origin + "/workspace/" + path);
        await expect(page.locator(".workspace-composer")).toBeVisible();
        await expect(page.locator(".workspace-message")).toHaveCount(2);
        for (const transparency of ["auto", "opaque"]) {
          await setMaterial(page, transparency);
          const shape = await page.evaluate(() => {
            const dock = document.querySelector(".workspace-composer-dock"), composer = dock.querySelector(".workspace-composer");
            const d = getComputedStyle(dock), c = getComputedStyle(composer), dr = dock.getBoundingClientRect(), cr = composer.getBoundingClientRect();
            return { dock: { background: d.backgroundColor, image: d.backgroundImage, shadow: d.boxShadow, blur: d.backdropFilter, paddingBottom: parseFloat(d.paddingBottom), bottom: dr.bottom }, composer: { background: c.backgroundColor, shadow: c.boxShadow, radius: c.borderRadius, x: cr.x, right: cr.right, bottom: cr.bottom }, viewportWidth: innerWidth, viewportHeight: innerHeight, pageWidth: document.documentElement.scrollWidth };
          });
          assert.equal(shape.dock.background, "rgba(0, 0, 0, 0)", `${surface}: only composer body has a colored surface`);
          assert.equal(shape.dock.image, "none");
          assert.equal(shape.dock.shadow, "none");
          assert.equal(shape.dock.blur, "none");
          assert.notEqual(shape.composer.background, "rgba(0, 0, 0, 0)");
          assert.notEqual(shape.composer.shadow, "none");
          assert.equal(shape.composer.radius, "16px");
          assert(shape.pageWidth <= width && shape.composer.x >= 0 && shape.composer.right <= width, "No page/composer overflow");
          assert(shape.dock.bottom <= shape.viewportHeight + 1, "Dock remains inside viewport");
          assert(shape.dock.bottom - shape.composer.bottom >= (width <= 760 ? Math.max(12, safeArea) : 20) - 1, "Floating composer retains bottom and safe-area clearance");
          results.composer.push({ themeId, mode, surface, transparency, safeArea, ...shape });
        }
        if (["beige", "minimal"].includes(themeId)) await page.screenshot({ path: `${artifacts}/${surface}-${themeId}-${mode}-${width}.png` });
      }
    } catch (error) { await page.screenshot({ path: `${artifacts}/failure-${themeId}-${mode}-${width}.png` }); throw error; }
    finally { await page.close(); }
  }
  assert.deepEqual(results.errors, []);
  console.log(`Navigation/composer passed: ${results.navigation.length} stable-navigation cases, ${results.composer.length} group/direct/topic theme-material cases, mobile bottom clearance, no page errors. Synthetic transport only. ${results.safeAreaEmulation}`);
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
