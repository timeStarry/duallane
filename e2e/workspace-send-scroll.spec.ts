import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";

test.describe.configure({ timeout: 150_000 });
type Scope = "direct" | "group" | "topic";

async function fixture(page: Page, browser: Browser, scope: Scope) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录", exact: true }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  const suffix = randomUUID().slice(0, 8);
  const peer = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const inviteResponse = await page.request.post("/api/workspace/invites", { data: { defaultRole: "member", maxUses: 1 } });
  expect(inviteResponse.status()).toBe(201);
  const { invite } = await inviteResponse.json();
  const accepted = await peer.request.post(`/api/workspace/invites/${invite.code}/accept`, {
    data: { githubId: `scroll-${suffix}`, githubLogin: `scroll-${suffix}`, email: `scroll-${suffix}@example.test`, displayName: `滚动成员 ${suffix}` }
  });
  expect(accepted.status()).toBe(201);
  const { user } = await accepted.json();
  const created = await page.request.post("/api/workspace/conversations", {
    data: scope === "direct" ? { type: "direct", targetUserId: user.id } : { type: "group", title: `发送滚动 ${suffix}`, memberIds: [user.id] }
  });
  expect(created.status()).toBe(201);
  const { conversation } = await created.json();
  let topicId = "";
  if (scope === "topic") {
    const response = await page.request.post(`/api/workspace/conversations/${conversation.id}/topics`, { data: { title: `滚动话题 ${suffix}`, description: "发送与阅读状态回归", idempotencyKey: randomUUID() } });
    expect(response.status()).toBe(201);
    topicId = (await response.json()).topic.id;
    expect((await peer.request.post(`/api/workspace/topics/${topicId}/join`, { data: {} })).ok()).toBe(true);
  }
  const endpoint = topicId ? `/api/workspace/topics/${topicId}/messages` : "/api/workspace/messages";
  async function send(request: APIRequestContext, text: string, replyToMessageId?: string) {
    const response = await request.post(endpoint, { data: { conversationId: conversation.id, clientMessageId: randomUUID(), replyToMessageId, content: { format: "duallane.message+json;v=1", plainText: text, blocks: [{ type: "text", text }] } } });
    expect(response.status()).toBe(201);
    return (await response.json()).message as { id: string };
  }
  const first = await send(page.request, `最早的引用目标 ${suffix}`);
  for (let index = 0; index < 115; index += 1) await send(page.request, `历史消息 ${index} ${suffix}`);
  const latestText = `加载前的最新消息 ${suffix}`;
  const last = await send(page.request, latestText, first.id);
  return {
    conversationId: conversation.id, endpoint, first, last, latestText, send, peer,
    path: topicId ? `/workspace/topics/${topicId}` : `/workspace/chat/${conversation.id}`,
    async dispose() { await peer.close(); await page.request.delete(`/api/workspace/members/${user.id}`); }
  };
}

async function bottomGap(list: Locator) {
  return list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
}

async function readHistory(page: Page, list: Locator) {
  await list.hover();
  await page.mouse.wheel(0, -650);
  await expect.poll(() => bottomGap(list)).toBeGreaterThan(250);
  await waitForScrollToSettle(list);
}

async function waitForScrollToSettle(list: Locator) {
  await expect.poll(() => list.evaluate(async element => {
    const top = element.scrollTop;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return Math.abs(top - element.scrollTop);
  })).toBeLessThan(1);
}

for (const scope of ["direct", "group", "topic"] as const) {
  test(`${scope} active text and pending attachment return to latest while incoming messages preserve history`, async ({ page, browser }) => {
    await page.setViewportSize({ width: scope === "topic" ? 390 : 1440, height: 844 });
    const data = await fixture(page, browser, scope);
    let releaseUpload = () => {};
    try {
      await page.goto(data.path);
      const panel = page.locator(".workspace-chat-panel");
      const list = panel.locator(".workspace-message-list");
      const editor = panel.getByRole("textbox", { name: "输入消息", exact: true });
      await expect(panel.locator(`[data-message-id="${data.last.id}"]`)).toBeVisible();
      await expect.poll(() => bottomGap(list)).toBeLessThanOrEqual(1);
      if (scope === "topic") {
        // An explicit latest action must supersede an outstanding reply lookup.
        let releaseAround!: () => void;
        let aroundSeen!: () => void;
        const aroundGate = new Promise<void>(resolve => { releaseAround = resolve; });
        const aroundStarted = new Promise<void>(resolve => { aroundSeen = resolve; });
        const aroundPattern = `**${data.endpoint}?around=*`;
        await page.route(aroundPattern, async route => {
          const response = await route.fetch();
          aroundSeen(); await aroundGate; await route.fulfill({ response });
        });
        try {
          await panel.locator(`[data-message-id="${data.last.id}"] .workspace-reply-jump`).click();
          await aroundStarted;
          await readHistory(page, list);
          await panel.getByRole("button", { name: "回到最新消息", exact: true }).click();
          const response = page.waitForResponse(value => value.url().includes(`around=${data.first.id}`));
          releaseAround(); await response;
          await expect.poll(() => bottomGap(list)).toBeLessThanOrEqual(1);
          await expect(panel.locator(`[data-message-id="${data.first.id}"]`)).toHaveCount(0);
        } finally { releaseAround(); await page.unroute(aroundPattern); }
      }
      // Opening an unloaded reply exercises the separate around-history window.
      await panel.locator(`[data-message-id="${data.last.id}"] .workspace-reply-jump`).click();
      await expect(panel.locator(`[data-message-id="${data.first.id}"]`)).toBeInViewport();
      await waitForScrollToSettle(list);
      const beforeIncoming = await list.evaluate(element => element.scrollTop);
      const incoming = await data.send(data.peer.request, "阅读历史期间收到的消息");
      await expect(panel.locator(`[data-message-id="${incoming.id}"]`)).toHaveCount(1);
      await expect.poll(() => list.evaluate((element, top) => Math.abs(element.scrollTop - top), beforeIncoming)).toBeLessThan(3);

      let releaseSend!: () => void;
      const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
      let sendSeen!: () => void;
      const sending = new Promise<void>(resolve => { sendSeen = resolve; });
      await page.route(`**${data.endpoint}`, async route => {
        if (route.request().method() !== "POST") { await route.continue(); return; }
        sendSeen(); await sendGate; await route.continue();
      });
      try {
        await editor.fill("从历史主动发送的新消息");
        await editor.press("Enter");
        await sending;
        await expect(panel.locator(".message-local-state.sending")).toBeVisible();
        await expect.poll(() => bottomGap(list)).toBeLessThanOrEqual(1);
        await expect(panel.locator(`[data-message-id="${data.last.id}"]`)).toHaveCount(1);
        await expect(editor).toHaveText("");
      } finally { releaseSend(); }
      await expect(panel.locator(".message-local-state.sending")).toHaveCount(0);
      await page.unroute(`**${data.endpoint}`);

      await readHistory(page, list);
      await editor.fill("附件后台发送");
      await panel.getByLabel("添加附件", { exact: true }).setInputFiles({ name: "scroll-proof.txt", mimeType: "text/plain", buffer: Buffer.from(randomUUID()) });
      let uploadSeen!: () => void;
      const uploading = new Promise<void>(resolve => { uploadSeen = resolve; });
      const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
      await page.route("**/api/workspace/files/uploads/*/content", async route => { uploadSeen(); await uploadGate; await route.continue(); });
      await editor.press("Enter");
      await uploading;
      await expect(panel.locator(".message-local-state.uploading")).toBeVisible();
      await expect.poll(() => bottomGap(list)).toBeLessThanOrEqual(1);
      await editor.fill("上传期间的新草稿");
      await readHistory(page, list);
      const beforeReceipt = await list.evaluate(element => element.scrollTop);
      releaseUpload();
      await expect(panel.locator(".message-local-state.uploading")).toHaveCount(0);
      await expect(panel.locator(".message-local-state.sending")).toHaveCount(0);
      await expect.poll(() => list.evaluate((element, top) => Math.abs(element.scrollTop - top), beforeReceipt)).toBeLessThan(3);
      await expect(editor).toHaveText("上传期间的新草稿");
    } finally {
      releaseUpload();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await data.dispose();
    }
  });
}

test("a delayed send receipt cannot scroll a newly selected conversation", async ({ page, browser }) => {
  const data = await fixture(page, browser, "group");
  let release!: () => void;
  try {
    const created = await page.request.post("/api/workspace/conversations", { data: { type: "direct", targetUserId: (await data.peer.request.get("/api/workspace/bootstrap").then(response => response.json())).auth.currentUser.id } });
    expect(created.ok()).toBe(true);
    const { conversation: other } = await created.json();
    for (let index = 0; index < 45; index += 1) {
      expect((await page.request.post("/api/workspace/messages", { data: { conversationId: other.id, clientMessageId: randomUUID(), content: { format: "duallane.message+json;v=1", plainText: `另一会话 ${index}`, blocks: [{ type: "text", text: `另一会话 ${index}` }] } } })).ok()).toBe(true);
    }
    await page.goto(data.path);
    const panel = page.locator(".workspace-chat-panel");
    const editor = panel.getByRole("textbox", { name: "输入消息", exact: true });
    await expect(editor).toBeVisible();
    let seen!: () => void;
    const started = new Promise<void>(resolve => { seen = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/workspace/messages", async route => { seen(); await gate; await route.continue(); });
    await editor.fill("延迟回执属于原会话");
    await editor.press("Enter");
    await started;
    await page.locator(".workspace-conversation-list .conversation").filter({ hasText: other.displayTitle }).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/chat/${other.id}$`));
    const list = panel.locator(".workspace-message-list");
    await editor.fill("另一会话的新草稿");
    await readHistory(page, list);
    const top = await list.evaluate(element => element.scrollTop);
    const receipt = page.waitForResponse(response => response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST");
    release();
    expect((await receipt).status()).toBe(201);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => list.evaluate((element, previousTop) => Math.abs(element.scrollTop - previousTop), top)).toBeLessThan(3);
    await expect(editor).toHaveText("另一会话的新草稿");
    await expect(page).toHaveURL(new RegExp(`/workspace/chat/${other.id}$`));
  } finally { release?.(); await page.unrouteAll({ behavior: "ignoreErrors" }); await data.dispose(); }
});

test("a delayed automatic latest window preserves history the sender resumes reading", async ({ page, browser }) => {
  const data = await fixture(page, browser, "group");
  let releaseLatest = () => {};
  let releaseSend = () => {};
  try {
    await page.goto(data.path);
    const panel = page.locator(".workspace-chat-panel");
    const list = panel.locator(".workspace-message-list");
    const editor = panel.getByRole("textbox", { name: "输入消息", exact: true });
    await panel.locator(`[data-message-id="${data.last.id}"] .workspace-reply-jump`).click();
    await expect(panel.locator(`[data-message-id="${data.first.id}"]`)).toBeInViewport();
    await waitForScrollToSettle(list);
    let latestSeen!: () => void;
    const latestStarted = new Promise<void>(resolve => { latestSeen = resolve; });
    const latestGate = new Promise<void>(resolve => { releaseLatest = resolve; });
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
    const latestPattern = `**/api/workspace/conversations/${data.conversationId}/messages?limit=40`;
    await page.route(latestPattern, async route => {
      const response = await route.fetch();
      latestSeen(); await latestGate; await route.fulfill({ response });
    });
    await page.route("**/api/workspace/messages", async route => { await sendGate; await route.continue(); });
    await editor.fill("提交后继续阅读历史");
    await editor.press("Enter");
    await latestStarted;
    await expect.poll(() => bottomGap(list)).toBeLessThanOrEqual(1);
    await readHistory(page, list);
    const anchor = await list.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const row = Array.from(element.querySelectorAll<HTMLElement>("[data-message-id]")).find(item => item.getBoundingClientRect().top >= bounds.top + 30)!;
      return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top };
    });
    await editor.fill("新阅读位置的草稿");
    // The POST may settle before the older latest GET snapshot is delivered.
    releaseSend();
    await expect(panel.locator(".message-local-state.sending")).toHaveCount(0);
    await expect(panel.getByText("提交后继续阅读历史", { exact: true })).toHaveCount(1);
    const response = page.waitForResponse(value => value.url().endsWith(`/conversations/${data.conversationId}/messages?limit=40`));
    releaseLatest(); await response;
    await expect(panel.locator(`[data-message-id="${data.last.id}"]`)).toHaveCount(1);
    const anchoredRow = panel.locator(`[data-message-id="${anchor.id}"]`);
    await expect(anchoredRow).toBeInViewport();
    await expect.poll(() => anchoredRow.evaluate((element, top) => Math.abs(element.getBoundingClientRect().top - top), anchor.top)).toBeLessThan(3);
    await expect(panel.getByText("提交后继续阅读历史", { exact: true })).toHaveCount(1);
    await expect(editor).toHaveText("新阅读位置的草稿");
  } finally {
    releaseLatest(); releaseSend();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await data.dispose();
  }
});
