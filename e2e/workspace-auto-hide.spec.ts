import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

async function login(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
}

test("chat auto-hide preferences persist and reveal locally without persisting message hides or affecting other members", async ({ page, browser }) => {
  await login(page);
  const original = (await (await page.request.get("/api/workspace/me/emote-settings")).json()).settings;
  const suffix = randomUUID().slice(0, 8);
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  let memberId: string | undefined;
  try {
    const inviteResponse = await page.request.post("/api/workspace/invites", { data: { defaultRole: "member", maxUses: 1 } });
    expect(inviteResponse.status()).toBe(201);
    const { invite } = await inviteResponse.json();
    const memberResponse = await memberPage.request.post(`/api/workspace/invites/${invite.code}/accept`, {
      data: { githubId: `auto-hide-${suffix}`, githubLogin: `auto-hide-${suffix}`, email: `auto-hide-${suffix}@example.test`, displayName: `显示测试成员 ${suffix}` }
    });
    expect(memberResponse.status()).toBe(201);
    memberId = (await memberResponse.json()).user.id;
    const groupResponse = await page.request.post("/api/workspace/conversations", { data: { type: "group", title: `消息显示 ${suffix}`, memberIds: [memberId] } });
    expect(groupResponse.status()).toBe(201);
    const groupId = (await groupResponse.json()).conversation.id;
    expect((await page.request.put("/api/workspace/me/emote-settings", { data: { autoHideMessages: false, autoHideMessageTypes: ["image", "emote", "long"] } })).status()).toBe(200);

    await page.goto("/workspace/account/chat");
    const toggle = page.getByRole("switch", { name: /在聊天中自动隐藏消息/ });
    const choices = page.getByRole("group", { name: "自动隐藏的消息类型" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(choices).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toBeEnabled();
    for (const label of ["图片", "表情", "长消息"]) await expect(choices.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.DUALLANE_UI_REVIEW_DIR) await page.screenshot({ path: `${process.env.DUALLANE_UI_REVIEW_DIR}/auto-hide-settings-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (process.env.DUALLANE_UI_REVIEW_DIR) await page.screenshot({ path: `${process.env.DUALLANE_UI_REVIEW_DIR}/auto-hide-settings-desktop.png` });

    // Selection survives an off/on cycle and reload; failures roll the UI back.
    await choices.getByRole("button", { name: "表情", exact: true }).click();
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(choices).toHaveCount(0);
    await expect(toggle).toBeEnabled();
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toBeEnabled();
    await expect(choices.getByRole("button", { name: "表情", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.route("**/api/workspace/me/emote-settings", async (route) => {
      if (route.request().method() === "PUT") return route.fulfill({ status: 500, json: { error: { code: "internal.error", message: "保存失败" } } });
      await route.continue();
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toBeEnabled();
    await page.unroute("**/api/workspace/me/emote-settings");
    await choices.getByRole("button", { name: "表情", exact: true }).click();
    await expect(toggle).toBeEnabled();

    const rows: Record<string, string> = {};
    for (const [kind, text] of Object.entries({ plain: `普通消息 ${suffix}`, image: "![图片](https://auto-hide.example.test/image.png)", emote: "[feishu:ok]", long: "长".repeat(701) })) {
      const response = await page.request.post("/api/workspace/messages", { data: { conversationId: groupId, clientMessageId: randomUUID(), content: { format: "duallane.message+json;v=1", blocks: [{ type: "text", text }], plainText: text } } });
      expect(response.status()).toBe(201);
      rows[kind] = (await response.json()).message.id;
    }
    let imageLoads = 0;
    await page.route("https://auto-hide.example.test/**", async (route) => { imageLoads++; await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#236d78"/></svg>' }); });
    await page.goto(`/workspace/chat/${groupId}`);
    const row = (kind: string) => page.locator(`article.workspace-message[data-message-id="${rows[kind]}"]`);
    for (const kind of ["image", "emote", "long"]) await expect(row(kind).getByRole("button", { name: "展开消息", exact: true })).toBeVisible();
    await expect(row("plain")).toContainText(`普通消息 ${suffix}`);
    expect(imageLoads).toBe(0);
    await row("image").getByRole("button", { name: "展开消息", exact: true }).click();
    await expect(row("image").getByRole("img", { name: "图片", exact: true })).toBeVisible();
    await expect.poll(() => imageLoads).toBe(1);
    await row("image").getByRole("button", { name: "收起", exact: true }).click();
    await expect(row("image").locator(".workspace-markdown-image-frame img")).toHaveCount(0);
    const history = (await (await page.request.get(`/api/workspace/conversations/${groupId}/messages`)).json()).messages;
    expect(history.filter((message: { hiddenByCurrentUser?: boolean }) => message.hiddenByCurrentUser)).toEqual([]);

    await memberPage.goto(`/workspace/chat/${groupId}`);
    await expect(memberPage.locator(`article[data-message-id="${rows.emote}"] .message-emote-image`)).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "展开消息", exact: true })).toHaveCount(0);

    const topicTitle = `折叠话题 ${suffix}`;
    const topicSource = `#[${topicTitle}](😀)`;
    expect((await page.request.post("/api/workspace/messages", { data: { conversationId: groupId, clientMessageId: randomUUID(), content: { format: "duallane.message+json;v=1", blocks: [{ type: "text", text: topicSource }], plainText: topicSource } } })).status()).toBe(201);
    const { topics } = await (await page.request.get(`/api/workspace/conversations/${groupId}/topics`)).json();
    const topic = topics.find((candidate: { title: string }) => candidate.title === topicTitle);
    expect(topic).toBeTruthy();
    await page.goto(`/workspace/topics/${topic.id}`);
    const topicBody = page.locator(".workspace-topic-page article.workspace-message").first();
    await expect(topicBody.getByRole("button", { name: "展开消息", exact: true })).toBeVisible();
    await topicBody.getByRole("button", { name: "展开消息", exact: true }).click();
    await expect(topicBody.locator(".message-body")).toContainText("😀");
    await page.goto(`/workspace/chat/${groupId}`);
    await expect(row("emote").getByRole("button", { name: "展开消息", exact: true })).toBeVisible();
    await row("plain").getByTitle("隐藏消息", { exact: true }).click();
    await expect(page.locator(".workspace-hidden-message-run")).toContainText("已隐藏 1 条消息");

    // Turning off through another session's API refreshes the open chat via its actor-only event.
    expect((await page.request.put("/api/workspace/me/emote-settings", { data: { autoHideMessages: false } })).status()).toBe(200);
    await expect(row("emote").locator(".message-emote-image")).toBeVisible();
    await expect(page.getByRole("button", { name: "展开消息", exact: true })).toHaveCount(0);
    await expect(row("plain")).toHaveCount(0);
    await page.locator(".workspace-hidden-message-run").getByRole("button", { name: "恢复", exact: true }).click();
    await expect(row("plain")).toContainText(`普通消息 ${suffix}`);
  } finally {
    expect((await page.request.put("/api/workspace/me/emote-settings", { data: { autoHideMessages: original.autoHideMessages ?? false, autoHideMessageTypes: original.autoHideMessageTypes ?? ["image", "emote", "long"] } })).status()).toBe(200);
    if (memberId) await page.request.delete(`/api/workspace/members/${memberId}`);
    await memberContext.close();
  }
});

test("a changed session cannot inherit preferences or a late settings save from the previous actor", async ({ page, context, browser }) => {
  let requestSync: (() => void) | undefined;
  await context.routeWebSocket(/\/ws\/workspace$/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => socket.send(message));
    // Exercise the real sync-required/bootstrap recovery path, not a fabricated domain event.
    requestSync = () => server.send(JSON.stringify({ version: 1, type: "hello", lastSeq: Number.MAX_SAFE_INTEGER }));
  });
  await login(page);
  const ownerContext = await browser.newContext({ storageState: await context.storageState() });
  const owner = ownerContext.request;
  const original = (await (await owner.get("/api/workspace/me/emote-settings")).json()).settings;
  const memberContext = await browser.newContext();
  const suffix = randomUUID().slice(0, 8);
  let memberId: string | undefined;
  let releaseSave!: () => void;
  let saveStarted!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const saving = new Promise<void>((resolve) => { saveStarted = resolve; });
  let releaseLoads!: () => void;
  let loadsStarted!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoads = resolve; });
  const loading = new Promise<void>((resolve) => { loadsStarted = resolve; });
  let changedActor = false;
  try {
    const { invite } = await (await owner.post("/api/workspace/invites", { data: { defaultRole: "member", maxUses: 1 } })).json();
    const accepted = await memberContext.request.post(`/api/workspace/invites/${invite.code}/accept`, { data: { githubId: `preferences-race-${suffix}`, githubLogin: `preferences-race-${suffix}`, email: `preferences-race-${suffix}@example.test`, displayName: `设置竞态成员 ${suffix}` } });
    expect(accepted.status()).toBe(201);
    memberId = (await accepted.json()).user.id;
    const { conversation } = await (await owner.post("/api/workspace/conversations", { data: { type: "group", title: `设置隔离 ${suffix}`, memberIds: [memberId] } })).json();
    const { message } = await (await owner.post("/api/workspace/messages", { data: {
      conversationId: conversation.id, clientMessageId: randomUUID(),
      content: { format: "duallane.message+json;v=1", blocks: [{ type: "text", text: "[feishu:ok]" }], plainText: "[feishu:ok]" }
    } })).json();
    expect((await owner.put("/api/workspace/me/emote-settings", { data: { autoHideMessages: false, autoHideMessageTypes: ["emote"] } })).status()).toBe(200);
    await page.goto("/workspace/account/chat");
    const toggle = page.getByRole("switch", { name: /在聊天中自动隐藏消息/ });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.route("**/api/workspace/me/emote-settings", async (route) => {
      if (route.request().method() === "PUT") {
        const response = await route.fetch();
        saveStarted();
        await saveGate;
        await route.fulfill({ response });
      } else if (changedActor) {
        loadsStarted();
        await loadGate;
        await route.fulfill({ status: 500, json: { error: { code: "internal.error", message: "设置读取失败" } } });
      } else await route.continue();
    });
    await toggle.click();
    await saving;
    changedActor = true;
    await context.addCookies(await memberContext.cookies());
    await expect.poll(() => Boolean(requestSync)).toBe(true);
    requestSync!();
    await loading;
    await expect(toggle).toHaveCount(0);
    releaseLoads();
    await expect(page.locator('[aria-labelledby="workspace-auto-hide-title"]')).toHaveAttribute("aria-busy", "false");
    await expect(toggle).toHaveCount(0);
    changedActor = false;
    await page.getByRole("button", { name: "重试加载聊天设置", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const lateSave = page.waitForResponse((response) => response.url().endsWith("/api/workspace/me/emote-settings") && response.request().method() === "PUT");
    releaseSave();
    await lateSave;
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // SPA navigation keeps the in-memory state under test; a full reload would conceal the race.
    await page.evaluate((id) => { history.pushState({}, "", `/workspace/chat/${id}`); dispatchEvent(new PopStateEvent("popstate")); }, conversation.id);
    const row = page.locator(`article.workspace-message[data-message-id="${message.id}"]`);
    await expect(row.locator(".message-emote-image")).toBeVisible();
    await expect(row.getByRole("button", { name: "展开消息", exact: true })).toHaveCount(0);
  } finally {
    releaseSave();
    releaseLoads();
    expect((await owner.put("/api/workspace/me/emote-settings", { data: { autoHideMessages: original.autoHideMessages ?? false, autoHideMessageTypes: original.autoHideMessageTypes ?? ["image", "emote", "long"] } })).status()).toBe(200);
    if (memberId) await owner.delete(`/api/workspace/members/${memberId}`);
    await memberContext.close();
    await ownerContext.close();
  }
});
