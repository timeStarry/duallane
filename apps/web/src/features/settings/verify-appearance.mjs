import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Production App with synthetic identity/HTTP/WebSocket responses. This proves
// appearance interactions and geometry, not real authentication or logout APIs.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = fileURLToPath(new URL("../../../../../.private-test-results/appearance-refinement/", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const probe = createPortProbe();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
assert(![5173, 5198].includes(port));
const server = await createServer({ root, cacheDir: "node_modules/.vite-appearance-review", server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
await mkdir(artifacts, { recursive: true });
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const now = "2026-09-11T08:00:00Z";
const members = [{ id: "appearance-owner", githubLogin: "appearance-fixture", displayName: "外观验收成员", kind: "human", role: "owner", joinedAt: now }];
const conversations = [{ id: "appearance-chat", spaceId: "appearance-space", type: "group", title: "外观验收", retentionCount: 1000, createdAt: now, messageCount: 0, memberCount: 1, unreadCount: 0, notificationLevel: "all", members, latestMessages: [], capabilities: { canSendMessage: true, canUploadFile: true, canManageMembers: true } }];
const bootstrap = { auth: { mode: "github", inviteOnly: true, currentUser: members[0] }, space: { id: "appearance-space", name: "双轨外观验收", slug: "appearance", createdBy: members[0].id, createdAt: now }, policy: { dailyQuotaBytes: 1073741824, usedTodayBytes: 0, remainingQuotaBytes: 1073741824, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" }, permissions: { canCreateMemberInvite: true, canCreatePrivilegedInvite: true, canManageMemberVisibility: true, canManageEmailSettings: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true, canViewOperationRecords: true }, members, conversations, files: [], invites: [], inviteSummary: {}, eventCursor: 0 };
const errors = [];
const results = { matrix: [], interaction: [], logout: [], note: "Formal App; synthetic identity and transport; no real logout request performed." };

async function setup(width) {
  const context = await browser.newContext({ viewport: { width, height: width > 760 ? 960 : 844 }, isMobile: width <= 760, hasTouch: width <= 760, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem("duallane-appearance")) localStorage.setItem("duallane-appearance", JSON.stringify({ version: 1, themeId: "original", mode: "light", density: "comfortable", motion: "reduced", transparency: "opaque" }));
  });
  await page.routeWebSocket("**/ws/workspace", socket => socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false }))));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    assert(!url.pathname.endsWith("/logout"), "Visual verification must not invoke logout");
    let data = { settings: {}, preferences: {}, entries: [], collections: [], groups: [], favorites: [], recent: [], emotes: [], topics: [], files: [], members, pins: [], messages: [], hasMore: false };
    if (url.pathname.endsWith("/bootstrap")) data = bootstrap;
    else if (url.pathname.endsWith("/conversations")) data = { conversations };
    else if (url.pathname.endsWith("/me/emote-settings")) data = { settings: { autoHideMessages: true, autoHideMessageTypes: ["image", "emote", "long"], clickImageEmoteToSend: false, replyAutoMention: true, enabledPackIds: ["classic"], minimumEnabled: 1, availablePacks: [{ id: "classic", label: "经典表情" }] } };
    else if (url.pathname.endsWith("/me/notifications")) data = { notifications: { enabled: false, emailSource: "github", emailVerified: true, githubEmail: "synthetic@example.test", immediateEnabled: false, digestEnabled: false, mailAvailable: true } };
    else if (url.pathname.endsWith("/me/ntfy")) data = { ntfy: { enabled: false } };
    else if (url.pathname.endsWith("/emote-library")) data = { entries: [], collections: [], favorites: [], recent: [], emotes: [], usage: { itemCount: 0, subscribedItemCount: 0, totalBytes: 0, subscribedTotalBytes: 0, collectionCount: 0, subscribedCollectionCount: 0, overLimit: false }, limits: { maxItems: 100, maxTotalBytes: 10485760, maxInputBytes: 1048576, maxCollections: 10, maxCollectionItems: 100, maxBatchItems: 10 } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(origin + "/workspace/account/appearance");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator(".dl-theme-card")).toHaveCount(5);
  const themes = await page.evaluate(async () => Object.entries((await import("/src/ui/theme/tokens.ts")).THEMES).map(([id, theme]) => ({ id, name: theme.name })));
  return { context, page, themes };
}

const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem("duallane-appearance")));
const themeButton = (page, name) => page.getByRole("button", { name: name + "主题", exact: true });
async function selectTheme(page, theme) {
  await themeButton(page, theme.name).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-family", theme.id);
  await expect(themeButton(page, theme.name)).toHaveAttribute("aria-pressed", "true");
  assert.equal((await stored(page)).themeId, theme.id);
  try {
    await expect.poll(() => themeButton(page, theme.name).evaluate(element => {
      const rect = element.getBoundingClientRect(), viewport = element.closest(".dl-theme-options").getBoundingClientRect();
      return rect.left >= viewport.left - 1 && rect.right <= viewport.right + 1;
    })).toBe(true);
  } catch (error) {
    const state = await geometry(page);
    await page.screenshot({ path: `${artifacts}/failure-selection-${theme.id}-${state.width}.png` });
    await writeFile(`${artifacts}/failure-selection.json`, JSON.stringify({ theme: theme.id, preferences: await stored(page), ...state }, null, 2));
    throw error;
  }
}
async function geometry(page) {
  return page.evaluate(() => {
    const pane = document.querySelector(".dl-settings-pane");
    const strip = document.querySelector(".dl-theme-options");
    const selected = strip.querySelector('[aria-pressed="true"]');
    const stripRect = strip.getBoundingClientRect(), selectedRect = selected.getBoundingClientRect();
    return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, paneWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth, stripWidth: strip.clientWidth, stripScrollWidth: strip.scrollWidth, selectedWidth: selectedRect.width, selectedLeft: selectedRect.left - stripRect.left, selectedRight: stripRect.right - selectedRect.right };
  });
}
async function checkButton(button, label) {
  await expect(button).toBeVisible();
  await button.scrollIntoViewIfNeeded();
  const shape = await button.evaluate(element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return { width: r.width, height: r.height, radii: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius].map(parseFloat), color: s.color, background: s.backgroundColor }; });
  assert(shape.width >= 44 && shape.height >= 44, `${label}: 44px target ${JSON.stringify(shape)}`);
  assert.deepEqual(shape.radii, [10, 10, 10, 10], label + ": control radius");
  return shape;
}
async function checkLogout(page, width, themeId, mode) {
  if (width <= 760) {
    await page.getByRole("button", { name: "返回个人设置", exact: true }).click();
    await expect(page.locator(".dl-personal-settings")).toHaveAttribute("data-settings-section", "home");
  }
  const logout = page.getByRole("button", { name: "退出登录", exact: true });
  await page.mouse.move(0, 0);
  const shape = await checkButton(logout, "settings logout");
  await logout.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(logout).toBeFocused();
  assert(await logout.evaluate(element => element.matches(":focus-visible") && parseFloat(getComputedStyle(element).outlineWidth) >= 2), "Logout has visible keyboard focus");
  if (width > 760) {
    await logout.hover();
    const hover = await logout.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, filter: style.filter }; });
    assert(hover.background !== shape.background || hover.filter !== "none", "Logout hover feedback");
  }
  const inView = await logout.evaluate(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth; });
  assert(inView, "Logout must remain reachable inside viewport");
  results.logout.push({ viewportWidth: width, themeId, mode, ...shape });
  if (["beige", "minimal"].includes(themeId)) await page.screenshot({ path: `${artifacts}/logout-${themeId}-${mode}-${width}.png` });
  if (width <= 760) await page.locator('[data-settings-category="appearance"]').click();
}

async function keyboardAndMouse(page, themes) {
  const strip = page.getByRole("group", { name: "主题", exact: true });
  await selectTheme(page, themes[0]);
  await page.locator(".dl-settings-pane").evaluate(element => { element.scrollTop = 0; });
  await themeButton(page, themes[0].name).focus();
  await page.keyboard.press("End");
  await expect(themeButton(page, themes.at(-1).name)).toBeFocused();
  assert.equal((await stored(page)).themeId, themes[0].id, "End moves focus without selecting");
  await expect.poll(() => themeButton(page, themes.at(-1).name).evaluate(element => { const r = element.getBoundingClientRect(), p = element.closest('.dl-theme-options').getBoundingClientRect(); return r.left >= p.left - 1 && r.right <= p.right + 1; })).toBe(true);
  await page.keyboard.press("ArrowLeft");
  await expect(themeButton(page, themes.at(-2).name)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  assert.equal((await stored(page)).themeId, themes.at(-1).id);
  await page.keyboard.press("Home");
  await expect(themeButton(page, themes[0].name)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "向前浏览主题", exact: true })).toBeDisabled();
  const forward = page.getByRole("button", { name: "向后浏览主题", exact: true });
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(20);
  assert.equal((await stored(page)).themeId, themes[0].id, "Browse arrow does not select");
  await page.getByRole("button", { name: "向前浏览主题", exact: true }).click();
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeLessThanOrEqual(1);
  const box = await strip.boundingBox();
  await page.mouse.move(box.x + box.width - 45, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 60, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(30);
  assert.equal((await stored(page)).themeId, themes[0].id, "Mouse drag must not select a theme");
  // No intervening pointerdown: keyboard activation must bypass suppression of
  // the synthetic click following a drag.
  await themeButton(page, themes.at(-1).name).focus();
  await page.keyboard.press("Enter");
  assert.equal((await stored(page)).themeId, themes.at(-1).id, "Enter remains available immediately after dragging");
  await selectTheme(page, themes[0]);
  await page.mouse.move(box.x + box.width - 45, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x - 20, box.y + 60, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(30);
  await expect(strip).not.toHaveAttribute("data-dragging", "true");
  assert.equal((await stored(page)).themeId, themes[0].id, "Releasing outside the strip must not select a theme");
  for (const theme of themes.filter(item => ["beige", "minimal"].includes(item.id))) {
    await selectTheme(page, theme);
    const preferences = await stored(page);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme-family", theme.id);
    await expect(themeButton(page, theme.name)).toHaveAttribute("aria-pressed", "true");
    assert.deepEqual(await stored(page), preferences, "Reload preserves every independent appearance preference");
  }
  results.interaction.push({ kind: "keyboard-mouse-reload", dragOutsideRelease: true, clickAfterDrag: true, enterAfterDrag: true, themes: ["beige", "minimal"] });
}

async function swipe(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
    for (let step = 1; step <= 12; step++) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
}
async function touchScroll(page, themes) {
  await selectTheme(page, themes[0]);
  const pane = page.locator(".dl-settings-pane");
  await pane.evaluate(element => { element.scrollTop = 0; });
  const strip = page.locator(".dl-theme-options");
  const box = await strip.boundingBox();
  const before = await strip.evaluate(element => element.scrollLeft);
  await swipe(page, { x: box.x + box.width - 25, y: box.y + 65 }, { x: box.x + 20, y: box.y + 65 });
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(before + 20);
  assert.equal((await stored(page)).themeId, themes[0].id, "Native horizontal swipe must not select");
  const top = await pane.evaluate(element => element.scrollTop);
  const current = await strip.boundingBox();
  await swipe(page, { x: current.x + current.width / 2, y: current.y + current.height - 20 }, { x: current.x + current.width / 2, y: current.y + 15 });
  await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(top + 15);
  assert.equal((await stored(page)).themeId, themes[0].id, "Vertical swipe over strip must not select");
  results.interaction.push({ kind: "native-touch-horizontal-and-vertical", horizontal: await strip.evaluate(element => element.scrollLeft), vertical: await pane.evaluate(element => element.scrollTop) });
  await page.screenshot({ path: `${artifacts}/touch-scroll-390.png` });
}

async function checkEntryMode(page, width) {
  await page.goto(origin + "/");
  const group = page.getByRole("radiogroup", { name: "外观模式", exact: true });
  await group.getByRole("radio", { name: "使用深色模式", exact: true }).click();
  await expect(group.getByRole("radio", { name: "使用深色模式", exact: true })).toHaveAttribute("aria-checked", "true");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const mode = await group.boundingBox();
  const brand = await page.locator(".entry-brand").boundingBox();
  assert(mode.x >= 0 && mode.x + mode.width <= width);
  assert(mode.x + mode.width <= brand.x || mode.x >= brand.x + brand.width || mode.y + mode.height <= brand.y || mode.y >= brand.y + brand.height, "Mode selector must not cover the entry brand");
  for (const radio of await group.getByRole("radio").all()) {
    const box = await radio.boundingBox();
    assert(box.width >= 44 && box.height >= 44);
  }
  await page.screenshot({ path: `${artifacts}/entry-mode-${width}.png`, fullPage: true });
  if (width <= 760) {
    await page.getByRole("button", { name: /关于 DualLane/ }).click();
    const aboutMode = await group.boundingBox();
    const about = await page.locator(".about-header").boundingBox();
    assert(aboutMode.y + aboutMode.height <= about.y, "Mode selector must not cover the About header");
    await page.goto(origin + "/");
    await page.getByRole("button", { name: /私密通道.*一对一直连/ }).click();
    const p2pMode = await group.boundingBox();
    const header = await page.locator(".p2p-shell > .topbar").boundingBox();
    assert(p2pMode.y + p2pMode.height <= header.y, "Mode selector must not cover the P2P header");
    await expect(page.getByPlaceholder("会话显示名称")).toBeVisible();
  }
  results.interaction.push({ kind: "entry-mode-layout", width, targets: 44, headerOverlap: false });
}

try {
  for (const width of [1440, 390, 320]) {
    const { context, page, themes } = await setup(width);
    try {
      for (const mode of ["light", "dark"]) {
        await page.getByRole("radiogroup", { name: "显示模式", exact: true }).getByRole("radio", { name: mode === "light" ? "浅色" : "深色", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
        for (const theme of themes) {
          await selectTheme(page, theme);
          await page.locator(".dl-settings-pane").evaluate(element => { element.scrollTop = 0; });
          await expect(page.locator(".dl-theme-card-caption small, .dl-theme-card-caption em")).toHaveCount(0);
          assert.deepEqual(await page.locator(".dl-theme-card-caption").allTextContents(), themes.map(item => item.name), "Theme captions contain titles only");
          const measured = await geometry(page);
          assert(measured.pageWidth <= width && measured.paneScrollWidth <= measured.paneWidth + 1, `No page or pane overflow: ${JSON.stringify(measured)}`);
          assert(measured.stripScrollWidth > measured.stripWidth, "Theme strip owns horizontal overflow");
          assert(measured.selectedLeft >= -1 && measured.selectedRight >= -1, `Selected theme is visible: ${JSON.stringify(measured)}`);
          results.matrix.push({ viewportWidth: width, themeId: theme.id, mode, ...measured });
          await page.screenshot({ path: `${artifacts}/appearance-${theme.id}-${mode}-${width}.png` });
          await checkLogout(page, width, theme.id, mode);
        }
      }
      if (width === 1440) {
        await keyboardAndMouse(page, themes);
        await page.goto(origin + "/workspace/chat/appearance-chat");
        await page.locator(".workspace-user-trigger").click();
        const logout = page.getByRole("menuitem", { name: "退出共享空间", exact: true });
        await checkButton(logout, "account menu logout");
        await logout.focus();
        await expect(logout).toBeFocused();
        await logout.hover();
        assert.equal(await logout.evaluate(element => getComputedStyle(element).color), await page.evaluate(() => { const sample = document.createElement('span'); sample.style.color = 'var(--danger)'; document.body.append(sample); const value = getComputedStyle(sample).color; sample.remove(); return value; }));
        await page.screenshot({ path: `${artifacts}/account-menu-1440.png` });
        await page.keyboard.press("Escape");
      }
      if (width === 390) await touchScroll(page, themes);
      await checkEntryMode(page, width);
      console.log(`Appearance verified at ${width}px: 5 themes × light/dark, settings logout and responsive strip.`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, [], "No production page errors");
  console.log(`Appearance passed: ${results.matrix.length} theme/viewport cases; ${results.logout.length} logout shape/focus checks; mouse, keyboard, reload and native touch. Synthetic transport only.`);
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify({ ...results, errors }, null, 2));
  await browser.close();
  await server.close();
}
