import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// The real App with synthetic API responses; this checks client wiring, not server authorization.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const now = "2026-09-11T08:00:00Z";
const members = [
  { id: "u1", displayName: "林遥", kind: "human", role: "owner", joinedAt: now, capabilities: { canStartDirectConversation: true } },
  { id: "u2", displayName: "陈序与设计协作小组的长名称测试", kind: "human", role: "member", joinedAt: now, capabilities: { canStartDirectConversation: true } },
  { id: "u3", displayName: "只读观察者", kind: "human", role: "auditor", joinedAt: now, capabilities: { canStartDirectConversation: false } }
];
const conversations = [
  { id: "c1", spaceId: "s1", type: "group", title: "设计讨论与跨端组件评审的长会话名称", retentionCount: 1000, createdAt: now, lastActivityAt: now, messageCount: 0, memberCount: 3, lastMessagePlainText: "新的统一交互已准备好。", lastMessageAt: now, unreadCount: 2, notificationLevel: "all", members, latestMessages: [], capabilities: { canSendMessage: true, canManageMembers: true } },
  { id: "c2", spaceId: "s1", type: "direct", title: "陈序", retentionCount: 1000, createdAt: now, messageCount: 0, members: members.slice(0, 2), latestMessages: [], capabilities: { canSendMessage: true } }
];
const commonFile = { mimeType: "application/pdf", byteSize: 1024, status: "available", visibility: "space", uploaderId: "u1", uploaderName: "林遥", createdAt: now };
const files = [
  { ...commonFile, id: "f1", fileName: "跨端交互设计与统一主题规范的长文件名称.pdf", capabilities: { canDownload: true, canRemove: true } },
  { ...commonFile, id: "f2", fileName: "权限受限.pdf", capabilities: { canDownload: false, canRemove: false } },
  { ...commonFile, id: "f3", fileName: "等待完成.pdf", status: "pending", capabilities: { canRemove: false } },
  { ...commonFile, id: "f4", fileName: "超过配额.pdf", byteSize: 999999, capabilities: { canRemove: false } },
  { ...commonFile, id: "f5", fileName: "失败上传.pdf", status: "failed", localUpload: { state: "failed", scope: "space", file: {}, failureReason: "网络已中断" } }
];
const bootstrap = { auth: { mode: "github", inviteOnly: true, currentUser: members[0] }, space: { id: "s1", name: "对象交互测试空间", slug: "objects", createdBy: "u1", createdAt: now }, policy: { dailyQuotaBytes: 10000, usedTodayBytes: 0, remainingQuotaBytes: 10000, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" }, permissions: { canCreateMemberInvite: true, canCreatePrivilegedInvite: true, canManageMemberVisibility: true, canManageEmailSettings: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true, canViewOperationRecords: true }, members, conversations, files, invites: [], inviteSummary: { total: 0, active: 0, history: 0, acceptedUses: 0, availableUses: 0 }, eventCursor: 0 };
const errors = [];
const writes = [];
async function mount(width, pathname) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width <= 760, isMobile: width <= 760, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  await page.routeWebSocket("**/ws/workspace", (socket) => socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false }))));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") writes.push({ method: request.method(), path: url.pathname });
    let data = { settings: {}, preferences: {}, collections: [], groups: [], emotes: [], topics: [], files, members, pins: [], messages: [], hasMore: false };
    if (url.pathname.endsWith("/bootstrap")) data = bootstrap;
    else if (url.pathname.endsWith("/conversations")) data = request.method() === "POST" ? { conversation: conversations[1] } : { conversations };
    else if (url.pathname.endsWith("/read")) data = { conversation: { ...conversations.find((conversation) => url.pathname.includes(`/${conversation.id}/`)), unreadCount: 0 } };
    else if (url.pathname.endsWith("/emote-library")) data = { collections: [], favorites: [], recent: [], emotes: [] };
    else if (url.pathname.endsWith("/downloads/reserve")) data = { status: "rejected" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(origin + pathname);
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  return page;
}

async function checkGeometry(page, selector) {
  const geometry = await page.locator(selector).evaluateAll((rows) => rows.map((row) => {
    const bounds = row.getBoundingClientRect(), more = row.querySelector(".dl-object-more").getBoundingClientRect();
    const primary = row.querySelector("[data-object-action-root]");
    return { bounds: bounds.toJSON(), more: more.toJSON(), primaryRight: primary.getBoundingClientRect().right, nextLeft: primary.nextElementSibling.getBoundingClientRect().left, viewport: innerWidth, nestedButtons: row.querySelectorAll("button button").length };
  }));
  for (const { bounds, more, primaryRight, nextLeft, viewport, nestedButtons } of geometry) {
    assert.equal(nestedButtons, 0); assert.ok(more.width >= 44 && more.height >= 44, "44px more target");
    assert.ok(more.right <= viewport && more.left >= 0, "more stays in viewport");
    assert.ok(more.right <= bounds.right + 1, "more stays in row");
    assert.ok(primaryRight <= nextLeft + 1, "primary content does not overlap quick actions");
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "page has no horizontal overflow");
}

try {
  for (const width of [1440, 900, 390, 320]) {
    console.log(`Checking Workspace objects at ${width}px`);
    const page = await mount(width, "/workspace");
    await checkGeometry(page, ".dl-conversation-object");
    const conversation = page.locator(".dl-conversation-object").first();
    await conversation.getByTitle("更多会话操作").click();
    const menu = page.getByRole("menu", { name: "会话操作" });
    await expect(menu).toBeVisible(); await menu.getByRole("menuitem", { name: "查看会话详情", exact: true }).click();
    await expect(page).toHaveURL(/\/workspace\/chat\/c1$/);
    await expect(page.locator(".workspace-context")).toBeVisible();
    if (width > 760) await page.locator(".workspace-context").getByTitle("收起详情", { exact: true }).click();
    await page.goto(origin + "/workspace/files");
    await expect(page.locator(".dl-file-object")).toHaveCount(5);
    await checkGeometry(page, ".dl-file-object");
    for (const [fileName, reason] of [["权限受限.pdf", "你当前不能下载此文件"], ["等待完成.pdf", "文件正在上传，完成后可下载"], ["超过配额.pdf", "额度不足"]]) {
      const row = page.locator(".dl-file-object").filter({ has: page.getByText(fileName, { exact: true }) });
      await row.getByTitle("更多文件操作").click();
      const download = page.getByRole("menuitem", { name: /下载文件/ });
      await expect(download).toBeDisabled(); await expect(download).toContainText(reason);
      await expect(page.getByRole("menuitem", { name: "移除文件", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape"); await expect(row.getByTitle("更多文件操作")).toBeFocused();
    }
    const firstFile = page.locator(".dl-file-object").first();
    await firstFile.locator("[data-object-action-root]").press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "移除文件", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "下载文件", exact: true }).click();
    assert.ok(writes.some((write) => write.path === "/api/workspace/files/f1/downloads/reserve"));
    const failed = page.locator(".dl-file-object").filter({ has: page.getByText("失败上传.pdf", { exact: true }) });
    await failed.getByTitle("更多文件操作").click();
    await expect(page.getByRole("menuitem", { name: "重试上传", exact: true })).toBeEnabled();
    await page.getByRole("menuitem", { name: "移除本地上传记录", exact: true }).click();
    await expect(failed).toHaveCount(0); await expect(page.locator(".workspace-file-table")).toBeFocused();
    await page.goto(origin + "/workspace/members");
    await expect(page.locator(".dl-member-object")).toHaveCount(3);
    await checkGeometry(page, ".dl-member-object");
    for (const name of [members[0].displayName, members[2].displayName]) {
      const row = page.locator(".dl-member-object").filter({ has: page.getByText(name, { exact: true }) });
      await row.getByTitle("更多成员操作").click();
      await expect(page.getByRole("menuitem", { name: "发起私聊", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    const contact = page.locator(".dl-member-object").filter({ has: page.getByText(members[1].displayName, { exact: true }) });
    await contact.getByTitle("更多成员操作").click();
    await page.getByRole("menuitem", { name: "发起私聊", exact: true }).click();
    await expect(page).toHaveURL(/\/workspace\/chat\/c2$/);
    await expect(page.getByRole("menu", { name: "成员操作" })).toHaveCount(0);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("Workspace objects passed: real App at 1440/900/390/320, 44px targets/no overlap, conversation details, file permissions/status/quota/reservation/local removal, member capabilities/private-chat navigation.");
} finally { await browser.close(); await server.close(); }
