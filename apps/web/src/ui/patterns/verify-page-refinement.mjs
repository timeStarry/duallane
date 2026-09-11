import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Real App and production CSS; the synthetic API proves client behavior, not Go authorization.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const server = await createServer({ root, cacheDir: "node_modules/.vite-page-refinement", server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false }, logLevel: "error" });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const artifacts = fileURLToPath(new URL("../../../../../.private-test-results/page-refinement/", import.meta.url));
await mkdir(artifacts, { recursive: true });
const errors = [];
const now = "2026-09-11T08:00:00Z";
const person = (id, displayName, role = "member", joinable = true) => ({ id, displayName, githubLogin: id, kind: "human", role, joinedAt: now, capabilities: { canStartDirectConversation: true, canJoinGroups: joinable, canManage: true } });
const initialMembers = [person("u1", "林遥", "owner"), ...Array.from({ length: 19 }, (_, index) => person(`existing-${index}`, `会话成员 ${index + 1}`)), person("a", "安宁"), person("b", "林予"), person("long", "跨端体验与协作设计的长名称成员"), person("disabled", "不可加入的服务助手", "member", false)];
const initialFiles = [
  { id: "pdf", fileName: "跨端统一设计规范.pdf", mimeType: "application/pdf" },
  ...Array.from({ length: 8 }, (_, index) => ({ id: `image-${index}`, fileName: `设计参考与交流图片 ${index + 1}.png`, mimeType: "image/png" }))
].map((file) => ({ ...file, byteSize: 1024, status: "available", visibility: "space", uploaderId: "u1", uploaderName: "林遥", createdAt: now, capabilities: { canDownload: true, canRemove: true } }));

async function mount(width, role = "owner") {
  const members = structuredClone(initialMembers);
  members[0].role = role;
  let group = { id: "c1", spaceId: "s1", type: "group", title: "设计讨论与跨端体验", retentionCount: 1000, createdAt: now, messageCount: 0, memberCount: 20, lastMessagePlainText: "统一设计语言与真实交互评审。", unreadCount: 0, notificationLevel: "all", members: members.slice(0, 20), latestMessages: [], capabilities: { canSendMessage: true, canManageMembers: role === "owner" } };
  const managed = role === "owner";
  const permissions = { canCreateMemberInvite: managed, canCreatePrivilegedInvite: managed, canManageMemberVisibility: managed, canManageEmailSettings: managed, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true, canViewOperationRecords: managed };
  const bootstrap = () => ({ auth: { mode: "github", inviteOnly: true, currentUser: members[0] }, space: { id: "s1", name: "清晰双轨体验空间", slug: "refinement", createdBy: "u1", createdAt: now }, policy: { dailyQuotaBytes: 1000000, usedTodayBytes: 0, remainingQuotaBytes: 1000000, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" }, permissions, members, conversations: [group], files: initialFiles, invites: [], inviteSummary: { total: 0, active: 0, history: 0, acceptedUses: 0, availableUses: 0 }, eventCursor: 0 });
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width <= 760, isMobile: width <= 760, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  const memberWrites = [];
  let rejectedB = false;
  await page.routeWebSocket("**/ws/workspace", (socket) => socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: 0, replayCount: 0, hasMore: false }))));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith("/preview")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#e5edef"/><rect x="70" y="80" width="460" height="240" rx="12" fill="#8cabb1"/><path d="M100 290L250 130L380 240L450 170L530 320H100Z" fill="#417d87"/></svg>' });
    let data = { settings: {}, preferences: {}, collections: [], groups: [], emotes: [], topics: [], files: initialFiles, members, pins: [], messages: [], hasMore: false };
    if (url.pathname.endsWith("/bootstrap")) data = bootstrap();
    else if (url.pathname.endsWith("/conversations")) data = { conversations: [group] };
    else if (url.pathname.endsWith("/read")) data = { conversation: group };
    else if (url.pathname.endsWith("/emote-library")) data = { collections: [], favorites: [], recent: [], emotes: [] };
    else if (url.pathname.includes("/member-visibility/")) data = { visibility: { basis: "direct_contacts", viewerUserId: url.pathname.split("/").at(-1), automaticUserIds: ["u1"], grantedUserIds: ["a"], visibleUserIds: ["u1", "a"] } };
    else if (url.pathname === "/api/workspace/groups/c1/members" && request.method() === "POST") {
      const { userId } = request.postDataJSON();
      memberWrites.push(userId);
      if (userId === "b" && !rejectedB) { rejectedB = true; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "邀请暂时失败，请重试" }) }); }
      const member = members.find((candidate) => candidate.id === userId);
      assert(member && member.capabilities.canJoinGroups && !group.members.some((candidate) => candidate.id === userId), "only available new members may be submitted");
      group = { ...group, members: [...group.members, member], memberCount: group.members.length + 1 };
      data = { conversation: group };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(origin + "/workspace/chat/c1");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  return { page, memberWrites };
}

async function geometry(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal page overflow");
  const icons = await page.locator(".icon-button").evaluateAll((buttons) => buttons.filter((button) => button.checkVisibility() && button.querySelector(":scope > svg")).map((button) => {
    const box = button.getBoundingClientRect(), svg = button.querySelector(":scope > svg").getBoundingClientRect();
    return { label: button.getAttribute("title") || button.getAttribute("aria-label"), x: Math.abs(box.x + box.width / 2 - svg.x - svg.width / 2), y: Math.abs(box.y + box.height / 2 - svg.y - svg.height / 2), width: box.width, height: box.height };
  }));
  assert(icons.every((icon) => icon.x <= 1 && icon.y <= 1), `icons centered: ${JSON.stringify(icons)}`);
  return icons;
}
async function screenshot(page, name, width) {
  await geometry(page);
  await page.screenshot({ path: `${artifacts}/${name}-${width}.png` });
}
async function details(page, width) {
  if (width <= 760) await page.locator(".workspace-main").getByRole("button", { name: "详情", exact: true }).click();
  else if (!(await page.locator(".workspace-context").isVisible())) await page.locator(".workspace-main").getByTitle("查看详情", { exact: true }).click();
  await expect(page.locator(".workspace-context")).toBeVisible();
}

try {
  for (const width of [1440, 900, 390, 320].filter((width) => !process.env.PAGE_REFINEMENT_WIDTH || width === Number(process.env.PAGE_REFINEMENT_WIDTH))) {
    console.log(`Checking page refinement at ${width}px`);
    const { page, memberWrites } = await mount(width);
    try {
      await details(page, width);
      await screenshot(page, "overview", width);
      if (width > 760) {
        await page.locator(".workspace-context").getByTitle("收起详情", { exact: true }).click();
        await expect(page.locator(".workspace-context")).toHaveCount(0);
        const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
        await composer.fill("折叠中栏也应保留的消息草稿");
        await page.getByRole("button", { name: "收起中栏", exact: true }).click();
        await expect(page.locator(".workspace-product-shell")).toHaveClass(/rail-collapsed/);
        await expect(composer).toContainText("折叠中栏也应保留的消息草稿");
        await page.getByRole("button", { name: "展开中栏", exact: true }).click();
        await expect(page.locator(".workspace-product-shell")).not.toHaveClass(/rail-collapsed/);
        await expect(composer).toContainText("折叠中栏也应保留的消息草稿");
        await details(page, width);
      }
      const context = page.locator(".workspace-context");
      await context.getByRole("tab", { name: "成员", exact: true }).click();
      await expect(context.locator(".context-member")).toHaveCount(20);
      await expect(context.getByText("安宁", { exact: true })).toHaveCount(0);
      const body = context.locator(".workspace-context-body");
      const beforeHeader = await context.locator(".workspace-context-header").boundingBox();
      const pageScroll = await page.evaluate(() => window.scrollY);
      await body.hover();
      await page.mouse.wheel(0, 400);
      await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      assert.equal(await page.evaluate(() => window.scrollY), pageScroll, "side pane scroll does not move the page");
      assert.equal((await context.locator(".workspace-context-header").boundingBox()).y, beforeHeader.y, "side pane header remains fixed");
      await body.evaluate((element) => { element.scrollTop = 0; });
      await screenshot(page, "conversation-members", width);
      const invite = context.getByRole("button", { name: "邀请成员", exact: true });
      await invite.click();
      const picker = page.getByRole("dialog", { name: "邀请成员", exact: true });
      await expect(picker).toBeVisible();
      await expect(picker.getByRole("checkbox", { name: "林遥", exact: true })).toHaveCount(0);
      await expect(picker.getByRole("checkbox", { name: "不可加入的服务助手", exact: true })).toHaveCount(0);
      await picker.getByRole("searchbox", { name: "搜索成员" }).fill("安宁");
      await picker.getByRole("checkbox", { name: "安宁", exact: true }).check();
      await picker.getByRole("searchbox", { name: "搜索成员" }).fill("林予");
      await picker.getByRole("checkbox", { name: "林予", exact: true }).check();
      await picker.getByRole("button", { name: "清除搜索" }).click();
      await screenshot(page, "member-picker", width);
      await picker.getByRole("button", { name: "取消", exact: true }).click();
      assert.deepEqual(memberWrites, [], "cancel does not POST");
      await expect(invite).toBeFocused();
      await invite.click();
      await picker.getByRole("checkbox", { name: "安宁", exact: true }).check();
      await picker.getByRole("checkbox", { name: "林予", exact: true }).check();
      await picker.getByRole("button", { name: "邀请成员", exact: true }).click();
      await expect(picker.getByRole("alert")).toContainText("其余选择已保留");
      await expect(picker.getByRole("checkbox", { name: "安宁", exact: true })).toHaveCount(0);
      await expect(picker.getByRole("checkbox", { name: "林予", exact: true })).toBeChecked();
      assert.deepEqual(memberWrites, ["a", "b"]);
      await picker.getByRole("button", { name: "重试邀请" }).click();
      await expect(page.locator(".dl-member-picker")).toHaveCount(0);
      await expect(context.locator(".context-member")).toHaveCount(22);
      assert.deepEqual(memberWrites, ["a", "b", "b"], "retry excludes previously successful member");

      await page.goto(origin + "/workspace/files");
      await expect(page.getByRole("textbox", { name: "查找文件", exact: true })).toHaveCount(1);
      await expect(page.locator(".workspace-rail-content .workspace-file-table")).toHaveCount(0);
      await expect(page.locator(".dl-file-object")).toHaveCount(9);
      await expect(page.locator(".workspace-context")).toHaveCount(0);
      await screenshot(page, "files-list", width);
      await page.locator(".dl-file-object").first().locator("[data-object-action-root]").click();
      const fileDetails = page.getByRole("complementary", { name: "文件详情", exact: true });
      await expect(fileDetails).toBeVisible();
      await expect(fileDetails).toBeInViewport({ ratio: 0.9 });
      await expect(fileDetails.locator(".workspace-context-title")).toHaveText("文件信息");
      await expect(fileDetails.locator(".workspace-file-detail-head")).toContainText("跨端统一设计规范.pdf");
      await expect(fileDetails.getByRole("tablist", { name: "会话详情", exact: true })).toHaveCount(0);
      await screenshot(page, "file-details", width);
      await fileDetails.getByTitle(width <= 760 ? "返回文件" : "收起详情", { exact: true }).click();
      await expect(fileDetails).not.toBeVisible();
      await page.locator(".workspace-main .dl-file-category-control").getByRole("radio", { name: "图片", exact: true }).click();
      await page.getByRole("radio", { name: "卡片视图", exact: true }).click();
      await expect(page.locator(".media-grid .media-card")).toHaveCount(8);
      await screenshot(page, "files-gallery", width);
      await page.getByRole("radio", { name: "列表视图", exact: true }).click();
      await expect(page.locator(".media-grid")).toHaveCount(0);
      await expect(page.locator(".dl-file-object")).toHaveCount(8);
      await geometry(page);

      await page.getByRole("navigation", { name: "共享空间视图" }).getByRole("button", { name: "成员", exact: true }).click();
      await expect(page).toHaveURL(/\/workspace\/members$/);
      await expect(page.getByRole("textbox", { name: "查找成员", exact: true })).toHaveCount(1);
      await expect(page.locator(".workspace-rail-content .dl-member-object")).toHaveCount(0);
      await expect(page.locator(".dl-member-object")).toHaveCount(initialMembers.length);
      await expect(page.locator(".workspace-context")).toHaveCount(0);
      await screenshot(page, "members", width);
      await page.goto(origin + "/workspace/space");
      await page.getByRole("tab", { name: "权限", exact: true }).click();
      await expect(page.locator(".workspace-role-row")).toHaveCount(initialMembers.length);
      await screenshot(page, "space-roles", width);
      await page.getByRole("tab", { name: "可见范围", exact: true }).click();
      await expect(page.locator(".workspace-visibility-row").first()).toBeVisible();
      await screenshot(page, "space-visibility", width);
    } catch (error) {
      await page.screenshot({ path: `${artifacts}/failure-${width}.png` });
      await writeFile(`${artifacts}/failure-${width}.txt`, await page.locator("body").innerText());
      throw error;
    } finally { await page.close(); }

    const { page: memberPage } = await mount(width, "member");
    try {
      await memberPage.goto(origin + "/workspace");
      const navigation = memberPage.getByRole("navigation", { name: "共享空间视图" });
      await expect(navigation.getByRole("button", { name: "空间", exact: true })).toHaveCount(0);
      if (width > 760) {
        await memberPage.locator("#workspace-user-menu-trigger").click();
        const account = memberPage.getByRole("menu", { name: "账号菜单" });
        await expect(account).toBeVisible();
        for (const label of ["文件", "账号设置", "个人设置", "空间", "外观", "主题"]) await expect(account.getByRole("menuitem", { name: label, exact: true })).toHaveCount(0);
        await screenshot(memberPage, "member-account-menu", width);
      } else {
        // Phone account actions deliberately live under the visible Personal destination.
        await expect(navigation.getByRole("button")).toHaveCount(5);
        await navigation.getByRole("button", { name: "个人", exact: true }).click();
        await expect(memberPage.getByRole("navigation", { name: "个人设置分类" })).toBeVisible();
        const logout = memberPage.getByRole("button", { name: "退出登录", exact: true });
        await logout.scrollIntoViewIfNeeded();
        await expect(logout).toBeInViewport();
        await expect(logout).toBeEnabled();
        const box = await logout.boundingBox();
        assert(box.width >= 44 && box.height >= 44);
        await screenshot(memberPage, "member-personal", width);
      }
    } finally { await memberPage.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("Page refinement passed: real App at 1440/900/390/320; centered icons, independent context scrolling, scoped searchable multi-member invitation/partial failure/retry/cancel, preserved composer while folding, member navigation/account-menu simplification, single file/member lookup, empty selection hides stale context, selected file opens file details, gallery/list layout, roles and visibility screenshots.");
} finally { await browser.close(); await server.close(); }
