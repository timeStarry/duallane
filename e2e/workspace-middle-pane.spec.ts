import { expect, test, type Page } from "@playwright/test";

// Real App and layout/gesture components, synthetic HTTP and realtime data.
// Server authorization and send persistence are covered by the Go flow tests.
const now = "2026-09-12T08:00:00Z";
const members = ["林遥", "程一"].map((displayName, i) => ({ id: `u${i + 1}`, githubLogin: `pane-${i + 1}`, displayName, kind: "human", role: i ? "member" : "owner", joinedAt: now, capabilities: { canStartDirectConversation: true, canJoinGroups: true } }));
const messages = ["调整布局时保留当前对话。", "每个选中项都应清楚可辨。"].map((text, i) => ({ id: `m${i}`, conversationId: "c1", authorId: members[i].id, authorName: members[i].displayName, authorKind: "human", kind: "user", plainText: text, content: { format: "blocks", plainText: text, blocks: [{ type: "text", text }] }, createdAt: now, attachments: [], reactions: [] }));
const conversations = ["c1", "c2"].map((id, i) => ({ id, spaceId: "s1", type: i ? "direct" : "group", title: i ? "程一" : "中栏与阅读体验", retentionCount: 1000, createdAt: now, latestMessages: messages.map(message => ({ ...message, conversationId: id })), messageCount: 2, memberCount: 2, unreadCount: 0, notificationLevel: "all", members, capabilities: { canSendMessage: true, canUploadFile: true, canManageMembers: !i } }));
const topic = { id: "t1", conversationId: "c1", title: "讨论中栏与阅读体验", description: "共用消息与导航", createdBy: "u1", creator: members[0], status: "open", joined: true, canJoin: false, allowSyncToGroup: true, revision: 1, participantCount: 2, notificationLevel: "all", createdAt: now, updatedAt: now };
const bootstrap = { auth: { mode: "github", inviteOnly: true, currentUser: members[0] }, space: { id: "s1", name: "双轨设计", slug: "pane", createdBy: "u1", createdAt: now }, policy: { dailyQuotaBytes: 1000000, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" }, permissions: { canCreateMemberInvite: true, canManageMemberVisibility: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true }, members, conversations, files: [], invites: [], inviteSummary: {}, eventCursor: 0 };

async function fixture(page: Page) {
  await page.routeWebSocket("**/ws/workspace", socket => socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false }))));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = { settings: {}, preferences: {}, collections: [], groups: [], emotes: [], topics: [topic], files: [], members, pins: [], messages: [], hasMore: false };
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
}

async function openChat(page: Page) {
  await page.goto("/workspace/chat/c1");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator(".workspace-composer")).toBeVisible();
}

async function dragTo(page: Page, delta: number, commit = true) {
  const handle = page.getByRole("separator", { name: "调整中栏宽度" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 6 });
  if (commit) await page.mouse.up();
}

test("中栏拖动、键盘调宽、取消与本机恢复保留编辑器，响应式不挤走正文", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await fixture(page);
  await openChat(page);
  const resizer = page.getByRole("separator", { name: "调整中栏宽度" });
  const editor = page.locator('.workspace-composer [contenteditable="true"]');
  await editor.fill("还未发送的草稿");
  await editor.evaluate(element => { (window as unknown as { originalEditor: Element }).originalEditor = element; });
  await expect(resizer).toHaveAttribute("aria-valuenow", "288");
  await dragTo(page, 80);
  await expect(resizer).toHaveAttribute("aria-valuenow", "368");
  await expect.poll(() => page.locator(".workspace-rail-content").evaluate(element => element.getBoundingClientRect().width)).toBe(368);
  await expect(editor).toHaveText("还未发送的草稿");
  expect(await editor.evaluate(element => (window as unknown as { originalEditor: Element }).originalEditor === element)).toBe(true);
  await dragTo(page, 45, false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(resizer).toHaveAttribute("aria-valuenow", "368");
  await dragTo(page, -60, false);
  await resizer.dispatchEvent("pointercancel");
  await page.mouse.up();
  await expect(resizer).toHaveAttribute("aria-valuenow", "368");
  await dragTo(page, -45, false);
  await page.setViewportSize({ width: 760, height: 960 });
  await expect(resizer).toHaveCount(0);
  await page.mouse.up();
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(resizer).toHaveAttribute("aria-valuenow", "368");
  await expect(page.locator(".workspace-product-shell")).not.toHaveClass(/resizing-object-list/);
  expect(await page.evaluate(() => localStorage.getItem("duallane-workspace-list-width"))).toBe("368");
  await resizer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(resizer).toHaveAttribute("aria-valuenow", "384");
  await page.keyboard.press("Home");
  await expect(resizer).toHaveAttribute("aria-valuenow", "240");
  await page.keyboard.press("End");
  await expect(resizer).toHaveAttribute("aria-valuenow", "420");
  await page.locator('.workspace-main button[title="查看详情"]').click();
  await expect(page.locator(".workspace-context")).toBeVisible();
  for (const width of [1101, 1100, 761, 760, 320, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    if (width > 760) {
      await expect(resizer).toBeVisible();
      await expect.poll(() => page.locator(".workspace-main").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(320);
    } else await expect(resizer).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(editor).toHaveText("还未发送的草稿");
  }
  await expect(resizer).toHaveAttribute("aria-valuenow", "420");
  const nav = page.getByRole("navigation", { name: "共享空间视图" });
  await page.getByRole("button", { name: "收起中栏", exact: true }).click();
  await expect(resizer).toHaveCount(0);
  await page.getByRole("button", { name: "展开中栏", exact: true }).click();
  await expect(resizer).toHaveAttribute("aria-valuenow", "420");
  for (const name of ["文件", "成员"]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(resizer).toHaveCount(0);
    await expect(page.locator(".workspace-rail-toggle")).toBeDisabled();
  }
  await nav.getByRole("button", { name: "聊天", exact: true }).click();
  await expect(editor).toHaveText("还未发送的草稿");
  await page.reload();
  await expect(resizer).toHaveAttribute("aria-valuenow", "420");
  await page.screenshot({ path: testInfo.outputPath("middle-pane-desktop.png") });
  await resizer.dblclick();
  await expect(resizer).toHaveAttribute("aria-valuenow", "288");
  expect(await page.evaluate(() => localStorage.getItem("duallane-workspace-list-width"))).toBeNull();
});

test("浏览器拒绝布局存储时仍能调宽并恢复默认", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    Storage.prototype.getItem = function (key) { if (key === "duallane-workspace-list-width") throw new DOMException("Blocked", "SecurityError"); return get.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (key === "duallane-workspace-list-width") throw new DOMException("Blocked", "SecurityError"); set.call(this, key, value); };
    Storage.prototype.removeItem = function (key) { if (key === "duallane-workspace-list-width") throw new DOMException("Blocked", "SecurityError"); remove.call(this, key); };
  });
  await fixture(page);
  await openChat(page);
  const resizer = page.getByRole("separator", { name: "调整中栏宽度" });
  await expect(resizer).toHaveAttribute("aria-valuenow", "288");
  await dragTo(page, 50);
  await expect(resizer).toHaveAttribute("aria-valuenow", "338");
  await resizer.press("Enter");
  await expect(resizer).toHaveAttribute("aria-valuenow", "288");
  await page.reload();
  await expect(resizer).toHaveAttribute("aria-valuenow", "288");
});

test("中栏右键与键盘操作不切换会话，选中项在五套明暗主题都有独立底色", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await fixture(page);
  await openChat(page);
  const rows = page.locator(".workspace-conversation-list .conversation");
  await expect(page.locator(".dl-conversation-object .dl-object-more")).toHaveCount(0);
  const other = rows.nth(1);
  await other.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "会话操作" })).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/c1$/);
  await page.keyboard.press("Escape");
  await expect(other).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "打开会话", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/c2$/);
  await other.focus();
  await page.keyboard.press("ContextMenu");
  await page.getByRole("menuitem", { name: "查看会话详情", exact: true }).click();
  await expect(page.locator(".workspace-context")).toBeVisible();
  for (const themeId of ["original", "grove", "dusk", "beige", "minimal"]) for (const mode of ["light", "dark"]) {
    await page.evaluate(({ themeId, mode }) => {
      const key = "duallane-appearance", oldValue = localStorage.getItem(key);
      const newValue = JSON.stringify({ version: 1, themeId, mode, density: "comfortable", motion: "reduced", transparency: "auto" });
      localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue, storageArea: localStorage }));
    }, { themeId, mode });
    await expect(page.locator("html")).toHaveAttribute("data-theme-family", themeId);
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    const selected = page.locator(".workspace-conversation-list .conversation.active");
    const color = await selected.evaluate(element => getComputedStyle(element).backgroundColor);
    const background = await page.locator(".workspace-rail-content").evaluate(element => getComputedStyle(element).backgroundColor);
    expect(color).not.toBe(background);
    const contrast = await selected.evaluate(element => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const luminance = (color: string) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return rgb.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      };
      const levels = [luminance(getComputedStyle(element).backgroundColor), luminance(getComputedStyle(element.querySelector("small")!).color)].sort((a, b) => b - a);
      return (levels[0] + .05) / (levels[1] + .05);
    });
    expect(contrast, `${themeId}/${mode}: selected preview text contrast`).toBeGreaterThanOrEqual(4.5);
    await rows.nth(0).hover();
    expect(await rows.nth(0).evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(color);
    await selected.hover();
    expect(await selected.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(color);
    if (themeId === "minimal") await page.screenshot({ path: testInfo.outputPath(`middle-pane-${mode}.png`) });
    await page.goto("/workspace/topics/t1");
    await expect(page.locator(".workspace-topic-row.active")).toBeVisible();
    expect(await page.locator(".workspace-topic-row.active").evaluate(element => getComputedStyle(element).backgroundColor)).toBe(color);
    await page.goto("/workspace/chat/c2");
    await expect(rows.nth(1)).toHaveClass(/active/);
  }
});

for (const width of [390, 320]) test(`中栏在 ${width}px 通过长按操作，取消不误开会话`, async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.clock.install();
    await fixture(page);
    await page.goto("/workspace");
    const row = page.locator(".workspace-conversation-list .conversation").nth(1);
    await expect(row).toBeVisible();
    await expect(page.getByRole("separator", { name: "调整中栏宽度" })).toHaveCount(0);
    await expect(page.locator(".dl-conversation-object .dl-object-more")).toHaveCount(0);
    const box = (await row.boundingBox())!;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
    await page.clock.runFor(500);
    await expect(page.getByRole("dialog", { name: "会话操作" })).toBeVisible();
    // Keep holding after recognition, beyond the former 900ms suppression
    // window. Releasing this same finger must not click the new sheet backdrop.
    await page.clock.runFor(1200);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await expect(page.getByRole("dialog", { name: "会话操作" })).toBeVisible();
    await expect(page).toHaveURL(/\/workspace$/);
    await page.screenshot({ path: testInfo.outputPath(`middle-pane-menu-${width}.png`) });
    await page.getByRole("button", { name: "关闭操作面板", exact: true }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    await row.click();
    await expect(page).toHaveURL(/\/workspace\/chat\/c2$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`middle-pane-mobile-${width}.png`) });
  } finally { await context.close(); }
});
