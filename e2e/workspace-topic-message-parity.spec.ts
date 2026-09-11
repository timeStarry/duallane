import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

test.describe.configure({ timeout: 150_000 });

type Group = { id: string; title: string; type: string };
type Topic = { id: string; title: string; conversationId: string };
type Message = {
  id: string;
  topicId?: string | null;
  clientMessageId?: string;
  replyToMessageId?: string | null;
  plainText: string;
  content: { blocks: Array<{ type: string; attachmentId?: string; shortcode?: string; text?: string }> };
  attachments: Array<{ id: string; fileName: string; status: string }>;
};
type Settings = {
  enabledPackIds: string[];
  clickImageEmoteToSend: boolean;
  replyAutoMention: boolean;
  autoHideMessages: boolean;
  autoHideMessageTypes: string[];
};
type SendPayload = {
  conversationId: string;
  topicId: string;
  clientMessageId: string;
  replyToMessageId: string | null;
  content: { plainText: string; blocks: Array<{ type: string; attachmentId?: string }> };
};

async function signIn(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录", exact: true }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("aria-busy", "false");
  const response = await page.request.get("/api/workspace/conversations");
  expect(response.ok()).toBe(true);
  const { conversations } = await response.json() as { conversations: Group[] };
  const group = conversations.find((entry) => entry.type === "group");
  expect(group).toBeTruthy();
  return group!;
}

async function createTopic(page: Page, group: Group, label: string) {
  const title = `${label}-${randomUUID().slice(0, 8)}`;
  const response = await page.request.post(`/api/workspace/conversations/${group.id}/topics`, {
    data: { title, description: `${title} 的初始正文`, allowSyncToGroup: true, idempotencyKey: randomUUID() }
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { topic: Topic }).topic;
}

function topicRegion(page: Page, topic: Topic) {
  return page.getByRole("region", { name: `话题 ${topic.title}`, exact: true });
}

function messageRow(page: Page, topic: Topic, id: string) {
  return topicRegion(page, topic).locator(`article.workspace-message[data-message-id="${id}"]`);
}

async function enterTopic(page: Page, topic: Topic) {
  await page.goto(`/workspace/topics/${topic.id}`);
  await expect(topicRegion(page, topic).locator(".workspace-chat-header")).toContainText(topic.title);
}

async function sendTopic(page: Page, topic: Topic) {
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/workspace/topics/${topic.id}/messages`) && response.request().method() === "POST"
  );
  await topicRegion(page, topic).getByTitle("发送消息", { exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const { message } = await response.json() as { message: Message };
  expect(message.topicId).toBe(topic.id);
  await expect(messageRow(page, topic, message.id)).toBeVisible();
  await expect(topicRegion(page, topic).getByRole("textbox", { name: "输入消息", exact: true })).toHaveText("");
  return message;
}

async function chooseAction(page: Page, row: Locator, name: string, desktopContextMenu = false) {
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  if (desktopContextMenu) {
    // Use the row's reserved edge, outside media's native context-menu region.
    await row.click({ button: "right", position: { x: 4, y: 4 } });
  } else {
    await row.getByRole("button", { name: "更多消息操作", exact: true }).click();
  }
  const menu = page.getByRole("menu", { name: "消息操作", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name, exact: true }).click();
}

async function expectLoadedImage(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

async function selectBuiltinImageEmote(page: Page, topic: Topic) {
  await topicRegion(page, topic).getByTitle("插入表情", { exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择表情", exact: true });
  await picker.getByRole("tab", { name: "飞书", exact: true }).click();
  await picker.getByRole("button", { name: "OK", exact: true }).click();
  await expect(topicRegion(page, topic).locator(".workspace-editor-token.emote img")).toHaveCount(1);
  await topicRegion(page, topic).locator(".workspace-chat-header").click();
}

async function expectExcludedFromParent(page: Page, group: Group, messageIds: string[]) {
  const response = await page.request.get(`/api/workspace/conversations/${group.id}/messages?limit=100`);
  expect(response.ok()).toBe(true);
  const { messages } = await response.json() as { messages: Message[] };
  expect(messages.filter((message) => messageIds.includes(message.id))).toEqual([]);
}

for (const width of [1440, 390]) {
  test(`topic messages share full content and actions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const group = await signIn(page);
    const settingsResponse = await page.request.get("/api/workspace/me/emote-settings");
    expect(settingsResponse.ok()).toBe(true);
    const { settings } = await settingsResponse.json() as { settings: Settings };
    const settingsToRestore = {
      enabledPackIds: settings.enabledPackIds,
      clickImageEmoteToSend: settings.clickImageEmoteToSend,
      replyAutoMention: settings.replyAutoMention,
      autoHideMessages: settings.autoHideMessages,
      autoHideMessageTypes: settings.autoHideMessageTypes
    };
    let customEmoteId = "";
    const uploadRequests: Array<{ visibility: string; conversationId?: string }> = [];
    const trackUploads = (request: Request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/workspace/files/uploads/reserve")) {
        uploadRequests.push(request.postDataJSON());
      }
    };
    page.on("request", trackUploads);
    try {
      expect((await page.request.put("/api/workspace/me/emote-settings", {
        data: { enabledPackIds: ["emoji", "feishu"], clickImageEmoteToSend: false, replyAutoMention: false, autoHideMessages: false }
      })).ok()).toBe(true);
      const topic = await createTopic(page, group, `完整消息-${width}`);
      await enterTopic(page, topic);
      const region = topicRegion(page, topic);
      const editor = region.getByRole("textbox", { name: "输入消息", exact: true });
      const imageBytes = await readFile("apps/web/public/favicon-32x32.png");
      if (width === 390) {
        await editor.evaluate((element, bytes) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
          element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
        }, Array.from(imageBytes));
      } else {
        await region.getByLabel("添加附件", { exact: true }).setInputFiles({ name: `topic-photo-${width}.png`, mimeType: "image/png", buffer: imageBytes });
      }
      const staged = region.getByLabel("待发送附件", { exact: true });
      await expect(staged.locator("img")).toBeVisible();
      const imageName = (await staged.locator("strong").textContent())!;
      expect(uploadRequests).toHaveLength(0);
      const imageMessage = await sendTopic(page, topic);
      expect(uploadRequests).toHaveLength(1);
      expect(uploadRequests[0]).toMatchObject({ visibility: "private_staging" });
      expect(uploadRequests[0]).not.toHaveProperty("conversationId");
      expect(imageMessage.attachments).toHaveLength(1);
      expect(imageMessage.content.blocks).toContainEqual({ type: "attachment", attachmentId: imageMessage.attachments[0].id });
      const previewButton = messageRow(page, topic, imageMessage.id).getByRole("button", { name: `预览图片 ${imageName}`, exact: true });
      await expectLoadedImage(previewButton.locator("img.message-image-preview"));
      await expect(messageRow(page, topic, imageMessage.id).locator(".structured-message.image-only")).toBeVisible();
      await previewButton.click();
      const viewer = page.getByRole("dialog", { name: imageName, exact: true });
      await expect(viewer).toBeVisible();
      await expectLoadedImage(viewer.locator(".workspace-image-viewer-canvas img"));
      await viewer.getByRole("button", { name: "放大图片", exact: true }).click();
      await expect(viewer.getByRole("button", { name: "125%", exact: true })).toBeVisible();
      await viewer.getByTitle("关闭预览", { exact: true }).click();
      await expect(viewer).toHaveCount(0);
      await expect(previewButton).toBeFocused();

      const fileName = `topic-notes-${width}-${randomUUID().slice(0, 6)}.txt`;
      await region.getByLabel("添加附件", { exact: true }).setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("话题中的独立文件\n保留正常文件卡片。") });
      const fileMessage = await sendTopic(page, topic);
      await expect(messageRow(page, topic, fileMessage.id).getByRole("button", { name: `查看文件 ${fileName}`, exact: true })).toBeEnabled();
      expect(uploadRequests).toHaveLength(2);
      expect(uploadRequests.every((request) => request.visibility === "private_staging" && !request.conversationId)).toBe(true);

      await selectBuiltinImageEmote(page, topic);
      const builtinMessage = await sendTopic(page, topic);
      await expectLoadedImage(messageRow(page, topic, builtinMessage.id).locator("img.message-emote-image"));

      await region.getByTitle("插入表情", { exact: true }).click();
      const picker = page.getByRole("dialog", { name: "选择表情", exact: true });
      await picker.getByRole("tab", { name: "收藏", exact: true }).click();
      await expect(picker.getByLabel("批量上传收藏表情", { exact: true })).toHaveCount(1);
      const emoteResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/workspace/me/emotes") && response.request().method() === "POST");
      await picker.getByLabel("批量上传收藏表情", { exact: true }).setInputFiles({ name: `topic-emote-${width}-${randomUUID().slice(0, 6)}.png`, mimeType: "image/png", buffer: imageBytes });
      const emoteResponse = await emoteResponsePromise;
      expect(emoteResponse.status()).toBe(201);
      const { emote } = await emoteResponse.json() as { emote: { id: string; label: string } };
      customEmoteId = emote.id;
      await picker.getByRole("button", { name: emote.label, exact: true }).click();
      await expect(region.locator(".workspace-editor-token.emote img")).toHaveCount(1);
      await region.locator(".workspace-chat-header").click();
      const customMessage = await sendTopic(page, topic);
      expect(customMessage.content.blocks).toContainEqual({ type: "emoji", shortcode: `custom:${customEmoteId}` });
      await expectLoadedImage(messageRow(page, topic, customMessage.id).locator("img.workspace-custom-emote-image"));

      await chooseAction(page, messageRow(page, topic, imageMessage.id), "回复", width === 1440);
      await expect(region.locator(".composer-reply")).toContainText(imageMessage.plainText);
      const mixedText = `**话题中同样支持混合内容 ${width}**`;
      await editor.fill(mixedText);
      await selectBuiltinImageEmote(page, topic);
      const mixedMessage = await sendTopic(page, topic);
      expect(mixedMessage.replyToMessageId).toBe(imageMessage.id);
      const mixedRow = messageRow(page, topic, mixedMessage.id);
      await expect(mixedRow.locator(".workspace-markdown strong")).toHaveText(`话题中同样支持混合内容 ${width}`);
      await expectLoadedImage(mixedRow.locator("img.message-emote-image"));
      await expect(mixedRow.locator(".workspace-reply-jump")).toContainText(imageMessage.plainText);

      await chooseAction(page, mixedRow, "添加表情回复", width === 1440);
      const reactionPicker = page.getByRole("dialog", { name: "选择消息表情回复", exact: true });
      await reactionPicker.getByRole("tab", { name: "飞书", exact: true }).click();
      await reactionPicker.getByRole("button", { name: "OK", exact: true }).click();
      await expect(mixedRow.getByRole("button", { name: /OK，你/ })).toHaveAttribute("aria-pressed", "true");
      await chooseAction(page, messageRow(page, topic, fileMessage.id), "设为常驻消息", width === 1440);
      await expect(messageRow(page, topic, fileMessage.id).locator(".workspace-message-pin-indicator")).toHaveText("常驻");
      await chooseAction(page, messageRow(page, topic, builtinMessage.id), "隐藏消息", width === 1440);
      await expect(region.locator(".workspace-hidden-message-run")).toContainText("已隐藏 1 条消息");

      await editor.fill(`待撤回内容-${width}`);
      const recalledMessage = await sendTopic(page, topic);
      await chooseAction(page, messageRow(page, topic, recalledMessage.id), "撤回消息", width === 1440);
      await page.getByRole("dialog", { name: "确认操作", exact: true }).getByRole("button", { name: "确认操作", exact: true }).click();
      await expect(messageRow(page, topic, recalledMessage.id).locator(".workspace-recalled-message")).toContainText("撤回了一条消息");
      await expect(messageRow(page, topic, recalledMessage.id)).not.toContainText(`待撤回内容-${width}`);

      await page.reload();
      await expect(region.locator(".workspace-hidden-message-run")).toContainText("已隐藏 1 条消息");
      await expect(mixedRow.getByRole("button", { name: /OK，你/ })).toHaveAttribute("aria-pressed", "true");
      await expect(messageRow(page, topic, fileMessage.id).locator(".workspace-message-pin-indicator")).toHaveText("常驻");
      await expect(messageRow(page, topic, recalledMessage.id).locator(".workspace-recalled-message")).toContainText("撤回了一条消息");
      await expectLoadedImage(messageRow(page, topic, customMessage.id).locator("img.workspace-custom-emote-image"));
      await region.locator(".workspace-hidden-message-run").getByRole("button", { name: "恢复", exact: true }).click();
      await expect(region.locator(".workspace-hidden-message-run")).toHaveCount(0);
      await expectLoadedImage(messageRow(page, topic, builtinMessage.id).locator("img.message-emote-image"));
      await chooseAction(page, messageRow(page, topic, fileMessage.id), "取消常驻", width === 1440);
      await expect(messageRow(page, topic, fileMessage.id).locator(".workspace-message-pin-indicator")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`topic-message-parity-${width}.png`) });

      const topicIds = [imageMessage, fileMessage, builtinMessage, customMessage, mixedMessage, recalledMessage].map((message) => message.id);
      await expectExcludedFromParent(page, group, topicIds);
      await region.locator(".dl-topic-banner").getByRole("button", { name: group.title, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/workspace/chat/${group.id}$`));
      for (const id of topicIds) await expect(page.locator(`article.workspace-message[data-message-id="${id}"]`)).toHaveCount(0);
      await expect(page.getByRole("button", { name: `预览图片 ${imageName}`, exact: true })).toHaveCount(0);
    } finally {
      page.off("request", trackUploads);
      await page.request.put("/api/workspace/me/emote-settings", { data: settingsToRestore });
      if (customEmoteId) await page.request.delete(`/api/workspace/me/emotes/${customEmoteId}`);
    }
  });
}

test("a failed topic send reuses its uploaded file and client ID without clearing newer drafts after navigation", async ({ page }) => {
  const group = await signIn(page);
  const topic = await createTopic(page, group, "附件重试");
  const otherTopic = await createTopic(page, group, "重试期间切换");
  await enterTopic(page, topic);
  const region = topicRegion(page, topic);
  const source = `原始消息-${randomUUID().slice(0, 8)}`;
  await region.getByRole("textbox", { name: "输入消息", exact: true }).fill(source);
  await region.getByLabel("添加附件", { exact: true }).setInputFiles({ name: "retry-topic-photo.png", mimeType: "image/png", buffer: await readFile("apps/web/public/favicon-32x32.png") });
  let reserveCount = 0;
  let contentUploadCount = 0;
  const trackUploads = (request: Request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/workspace/files/uploads/reserve")) reserveCount += 1;
    if (request.method() === "PUT" && /\/api\/workspace\/files\/uploads\/[^/]+\/content$/.test(request.url())) contentUploadCount += 1;
  };
  page.on("request", trackUploads);
  const attempts: SendPayload[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let retrySeen!: () => void;
  const retryRequested = new Promise<void>((resolve) => { retrySeen = resolve; });
  await page.route(`**/api/workspace/topics/${topic.id}/messages`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      // Attachment upload has succeeded; only message submission fails.
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "internal.error", message: "测试：话题发送暂时失败" } }) });
    } else {
      retrySeen();
      await gate;
      await route.continue();
    }
  });
  try {
    await region.getByTitle("发送消息", { exact: true }).click();
    const failed = region.locator("article.workspace-message").filter({ has: page.locator(".message-local-state.failed") });
    await expect(failed).toContainText("话题发送暂时失败");
    await expect(failed.getByRole("button", { name: "重试发送", exact: true })).toBeEnabled();
    expect(reserveCount).toBe(1);
    expect(contentUploadCount).toBe(1);
    expect(attempts[0].content.blocks.filter((block) => block.type === "attachment")).toHaveLength(1);
    await failed.getByRole("button", { name: "重试发送", exact: true }).click();
    await retryRequested;
    await region.getByRole("textbox", { name: "输入消息", exact: true }).fill("本话题的新草稿");
    await page.locator(".workspace-topic-row").filter({ hasText: otherTopic.title }).click();
    const otherEditor = topicRegion(page, otherTopic).getByRole("textbox", { name: "输入消息", exact: true });
    await otherEditor.fill("另一话题的新草稿");
    await page.locator(".workspace-topic-row").filter({ hasText: topic.title }).click();
    await expect(region.getByRole("textbox", { name: "输入消息", exact: true })).toHaveText("本话题的新草稿");
    const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/workspace/topics/${topic.id}/messages`) && response.request().method() === "POST" && response.status() === 201);
    release();
    expect((await responsePromise).status()).toBe(201);
    await expect(region.getByRole("textbox", { name: "输入消息", exact: true })).toHaveText("本话题的新草稿");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]).toMatchObject({ conversationId: group.id, topicId: topic.id, content: { plainText: source } });
    expect(reserveCount).toBe(1);
    expect(contentUploadCount).toBe(1);
    const response = await page.request.get(`/api/workspace/topics/${topic.id}/messages`);
    expect(response.ok()).toBe(true);
    const { messages } = await response.json() as { messages: Message[] };
    const delivered = messages.filter((message) => message.clientMessageId === attempts[0].clientMessageId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].attachments).toHaveLength(1);
    await expect(region.getByRole("textbox", { name: "输入消息", exact: true })).toHaveText("本话题的新草稿");
    await expect(region.locator(".message-local-state.failed")).toHaveCount(0);
    await expectLoadedImage(messageRow(page, topic, delivered[0].id).locator("img.message-image-preview"));
    await expectExcludedFromParent(page, group, [delivered[0].id]);
    await page.locator(".workspace-topic-row").filter({ hasText: otherTopic.title }).click();
    await expect(otherEditor).toHaveText("另一话题的新草稿");
  } finally {
    release();
    page.off("request", trackUploads);
    await page.unroute(`**/api/workspace/topics/${topic.id}/messages`);
  }
});

test("topic images and message operations require current topic membership", async ({ page, browser }) => {
  await signIn(page);
  const suffix = randomUUID().slice(0, 8);
  const memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  const memberPage = await memberContext.newPage();
  let memberId = "";
  try {
    const inviteResponse = await page.request.post("/api/workspace/invites", { data: { defaultRole: "member", maxUses: 1 } });
    expect(inviteResponse.status()).toBe(201);
    const { invite } = await inviteResponse.json() as { invite: { code: string } };
    const accept = await memberPage.request.post(`/api/workspace/invites/${encodeURIComponent(invite.code)}/accept`, {
      data: { githubId: `topic-content-${suffix}`, githubLogin: `topic-content-${suffix}`, email: `topic-content-${suffix}@example.test`, displayName: `话题隔离成员 ${suffix}` }
    });
    expect(accept.status()).toBe(201);
    memberId = (await accept.json() as { user: { id: string } }).user.id;
    expect((await memberPage.request.put("/api/workspace/me/emote-settings", { data: { replyAutoMention: true } })).ok()).toBe(true);
    const groupResponse = await page.request.post("/api/workspace/conversations", { data: { type: "group", title: `内容隔离群-${suffix}`, memberIds: [memberId] } });
    expect(groupResponse.status()).toBe(201);
    const { conversation: group } = await groupResponse.json() as { conversation: Group };
    const topic = await createTopic(page, group, "受成员权限保护的图片");
    await enterTopic(page, topic);
    await topicRegion(page, topic).getByLabel("添加附件", { exact: true }).setInputFiles({ name: "members-only-topic.png", mimeType: "image/png", buffer: await readFile("apps/web/public/favicon-32x32.png") });
    const imageMessage = await sendTopic(page, topic);
    const imageId = imageMessage.attachments[0].id;
    await enterTopic(memberPage, topic);
    const memberRegion = topicRegion(memberPage, topic);
    const expectDenied = async () => {
      for (const response of await Promise.all([
        memberPage.request.get(`/api/workspace/topics/${topic.id}/messages`),
        memberPage.request.get(`/api/workspace/files/${imageId}/preview`),
        memberPage.request.post(`/api/workspace/files/${imageId}/downloads/reserve`),
        memberPage.request.post(`/api/workspace/messages/${imageMessage.id}/reactions`, { data: { emoteKey: "feishu:ok" } })
      ])) expect([403, 404]).toContain(response.status());
    };
    await expect(memberRegion.getByText("加入后参与讨论", { exact: true })).toBeVisible();
    await expect(memberRegion.getByRole("textbox", { name: "输入消息", exact: true })).toHaveCount(0);
    await expectDenied();
    await memberRegion.getByRole("button", { name: "加入话题", exact: true }).click();
    await expectLoadedImage(messageRow(memberPage, topic, imageMessage.id).locator("img.message-image-preview"));
    expect((await memberPage.request.get(`/api/workspace/files/${imageId}/preview`)).status()).toBe(200);
    await chooseAction(memberPage, messageRow(memberPage, topic, imageMessage.id), "回复");
    await expect(memberRegion.locator(".workspace-editor-token.mention")).toHaveText("@timeStarry");
    await memberRegion.getByRole("textbox", { name: "输入消息", exact: true }).fill("");
    await memberRegion.getByTitle("取消回复", { exact: true }).click();
    await memberRegion.getByRole("button", { name: "话题详情", exact: true }).click();
    const details = memberPage.getByRole("dialog", { name: "话题详情", exact: true });
    await details.getByRole("button", { name: "退出话题", exact: true }).click();
    await details.getByRole("button", { name: "关闭话题详情", exact: true }).click();
    await expect(memberRegion.getByText("加入后参与讨论", { exact: true })).toBeVisible();
    await expectDenied();
    await expectExcludedFromParent(memberPage, group, [imageMessage.id]);
    expect((await page.request.get(`/api/workspace/files/${imageId}/preview`)).status()).toBe(200);
  } finally {
    if (memberId) await page.request.delete(`/api/workspace/members/${memberId}`).catch(() => null);
    await memberContext.close();
  }
});

test("a topic accepts the next text message while an earlier image uploads in the background", async ({ page }) => {
  const group = await signIn(page);
  const topic = await createTopic(page, group, "后台上传继续聊天");
  await enterTopic(page, topic);
  const region = topicRegion(page, topic);
  const editor = region.getByRole("textbox", { name: "输入消息", exact: true });
  const source = `图片消息-${randomUUID().slice(0, 8)}`;
  await editor.fill(source);
  await region.getByLabel("添加附件", { exact: true }).setInputFiles({ name: "background-topic.png", mimeType: "image/png", buffer: await readFile("apps/web/public/favicon-32x32.png") });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let uploadSeen!: () => void;
  const uploading = new Promise<void>((resolve) => { uploadSeen = resolve; });
  await page.route("**/api/workspace/files/uploads/*/content", async (route) => {
    uploadSeen();
    await gate;
    await route.continue();
  });
  try {
    await region.getByTitle("发送消息", { exact: true }).click();
    await uploading;
    await expect(editor).toHaveText("");
    await expect(region.locator(".message-local-state.uploading")).toBeVisible();
    await editor.fill("图片尚未上传完，这条文字已经可以发送");
    await expect(region.getByTitle("发送消息", { exact: true })).toBeEnabled();
    const textMessage = await sendTopic(page, topic);
    expect(textMessage.attachments).toHaveLength(0);
    await expect(region.locator(".message-local-state.uploading")).toBeVisible();
    await editor.fill("下一条仍在编辑");
    const imageResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/workspace/topics/${topic.id}/messages`) && response.request().method() === "POST" && (response.request().postDataJSON() as SendPayload).content.plainText === source);
    release();
    const imageResponse = await imageResponsePromise;
    expect(imageResponse.status()).toBe(201);
    const { message } = await imageResponse.json() as { message: Message };
    await expectLoadedImage(messageRow(page, topic, message.id).locator("img.message-image-preview"));
    await expect(editor).toHaveText("下一条仍在编辑");
    await expect(messageRow(page, topic, textMessage.id)).toBeVisible();
    await expectExcludedFromParent(page, group, [message.id, textMessage.id]);
  } finally {
    release();
    await page.unroute("**/api/workspace/files/uploads/*/content");
  }
});

test("a new staged file after a failed topic send becomes a new message instead of silently retrying the old payload", async ({ page }) => {
  const group = await signIn(page);
  const topic = await createTopic(page, group, "失败消息与新附件独立");
  await enterTopic(page, topic);
  const region = topicRegion(page, topic);
  const attempts: SendPayload[] = [];
  await page.route(`**/api/workspace/topics/${topic.id}/messages`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "internal.error", message: "测试：原消息发送失败" } }) });
    else await route.continue();
  });
  try {
    await region.getByRole("textbox", { name: "输入消息", exact: true }).fill("原消息仍可显式重试");
    await region.getByLabel("添加附件", { exact: true }).setInputFiles({ name: "original.txt", mimeType: "text/plain", buffer: Buffer.from("第一份文件") });
    await region.getByTitle("发送消息", { exact: true }).click();
    const failed = region.locator("article.workspace-message").filter({ has: page.locator(".message-local-state.failed") });
    await expect(failed).toContainText("原消息发送失败");
    await expect(region.getByRole("textbox", { name: "输入消息", exact: true })).toHaveText("");
    await region.getByLabel("添加附件", { exact: true }).setInputFiles({ name: "new-file.txt", mimeType: "text/plain", buffer: Buffer.from("独立的新文件") });
    const newMessage = await sendTopic(page, topic);
    expect(newMessage.attachments.map((attachment) => attachment.fileName)).toEqual(["new-file.txt"]);
    expect(attempts[1].clientMessageId).not.toBe(attempts[0].clientMessageId);
    await expect(failed.getByRole("button", { name: "重试发送", exact: true })).toBeEnabled();
    const retryResponse = page.waitForResponse((response) => response.url().endsWith(`/api/workspace/topics/${topic.id}/messages`) && response.request().method() === "POST");
    await failed.getByRole("button", { name: "重试发送", exact: true }).click();
    expect((await retryResponse).status()).toBe(201);
    expect(attempts[2]).toEqual(attempts[0]);
    await expect(region.locator(".message-local-state.failed")).toHaveCount(0);
  } finally {
    await page.unroute(`**/api/workspace/topics/${topic.id}/messages`);
  }
});

async function holdFirstTwoUploads(page: Page) {
  const reservedNames: string[] = [];
  const uploadIds: string[] = [];
  const messageAttempts: SendPayload[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let twoSeen!: () => void;
  const uploading = new Promise<void>((resolve) => { twoSeen = resolve; });
  const trackRequests = (request: Request) => {
    if (request.method() !== "POST") return;
    if (request.url().endsWith("/api/workspace/files/uploads/reserve")) reservedNames.push(request.postDataJSON().fileName);
    if (/\/api\/workspace\/topics\/[^/]+\/messages$/.test(request.url())) messageAttempts.push(request.postDataJSON());
  };
  page.on("request", trackRequests);
  await page.route("**/api/workspace/files/uploads/*/content", async (route) => {
    uploadIds.push(new URL(route.request().url()).pathname.split("/").at(-2)!);
    if (uploadIds.length === 2) twoSeen();
    if (uploadIds.length <= 2) await gate;
    await route.continue().catch(() => undefined);
  });
  return {
    uploading, reservedNames, uploadIds, messageAttempts, release,
    waitForCancellation() {
      return Promise.all(uploadIds.map((id) => page.waitForResponse((response) =>
        response.url().endsWith(`/api/workspace/files/uploads/${id}/fail`) && response.request().method() === "POST"
      )));
    },
    async dispose() {
      release();
      page.off("request", trackRequests);
      await page.unroute("**/api/workspace/files/uploads/*/content");
    }
  };
}

test("cancelling a topic attachment batch aborts active files and never starts queued files", async ({ page }) => {
  const group = await signIn(page);
  const topic = await createTopic(page, group, "取消整个附件批次");
  await enterTopic(page, topic);
  const region = topicRegion(page, topic);
  const uploads = await holdFirstTwoUploads(page);
  try {
    await region.getByLabel("添加附件", { exact: true }).setInputFiles([1, 2, 3, 4].map((index) => ({
      name: `cancelled-topic-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from(`取消附件 ${index}`)
    })));
    await region.getByTitle("发送消息", { exact: true }).click();
    await uploads.uploading;
    const pending = region.locator("article.workspace-message").filter({ has: page.locator(".message-local-state.uploading") });
    await expect(pending).toBeVisible();
    expect(uploads.reservedNames).toHaveLength(2);
    const cancellations = uploads.waitForCancellation();
    await pending.getByRole("button", { name: "取消", exact: true }).click();
    await expect(pending).toHaveCount(0);
    uploads.release();
    for (const response of await cancellations) expect(response.ok()).toBe(true);

    // A completed subsequent send is the observable settling barrier for both
    // aborted workers; it also proves cancelling the batch leaves chat usable.
    await region.getByRole("textbox", { name: "输入消息", exact: true }).fill("取消附件后仍可正常发送");
    const following = await sendTopic(page, topic);
    expect(uploads.reservedNames.sort()).toEqual(["cancelled-topic-1.txt", "cancelled-topic-2.txt"]);
    expect(uploads.uploadIds).toHaveLength(2);
    expect(uploads.messageAttempts).toHaveLength(1);
    expect(uploads.messageAttempts[0].clientMessageId).toBe(following.clientMessageId);
    const response = await page.request.get(`/api/workspace/topics/${topic.id}/messages`);
    expect(response.ok()).toBe(true);
    const { messages } = await response.json() as { messages: Message[] };
    expect(messages.flatMap((message) => message.attachments)).toEqual([]);
    expect(messages.filter((message) => message.clientMessageId?.startsWith("topic-web:"))).toHaveLength(1);
  } finally {
    await uploads.dispose();
  }
});

test("parent group removal revokes the current topic and clears hidden drafts and queued uploads", async ({ page, browser }, testInfo) => {
  await signIn(page);
  const suffix = randomUUID().slice(0, 8);
  const memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 960 } });
  const memberPage = await memberContext.newPage();
  let memberId = "";
  let uploads: Awaited<ReturnType<typeof holdFirstTwoUploads>> | null = null;
  try {
    const inviteResponse = await page.request.post("/api/workspace/invites", { data: { defaultRole: "member", maxUses: 1 } });
    expect(inviteResponse.status()).toBe(201);
    const { invite } = await inviteResponse.json() as { invite: { code: string } };
    const accepted = await memberPage.request.post(`/api/workspace/invites/${encodeURIComponent(invite.code)}/accept`, {
      data: { githubId: `topic-revocation-${suffix}`, githubLogin: `topic-revocation-${suffix}`, email: `topic-revocation-${suffix}@example.test`, displayName: `话题撤权成员 ${suffix}` }
    });
    expect(accepted.status()).toBe(201);
    memberId = (await accepted.json() as { user: { id: string } }).user.id;
    const groupResponse = await page.request.post("/api/workspace/conversations", { data: { type: "group", title: `话题撤权群-${suffix}`, memberIds: [memberId] } });
    expect(groupResponse.status()).toBe(201);
    const { conversation: group } = await groupResponse.json() as { conversation: Group };
    const hiddenTopic = await createTopic(page, group, "撤权时隐藏的上传");
    const currentTopic = await createTopic(page, group, "撤权时正在编辑");
    for (const topic of [hiddenTopic, currentTopic]) {
      expect((await memberPage.request.post(`/api/workspace/topics/${topic.id}/join`, { data: {} })).ok()).toBe(true);
    }
    const existingBody = `仅群成员可见的现有内容-${suffix}`;
    const seedResponse = await page.request.post(`/api/workspace/topics/${currentTopic.id}/messages`, { data: {
      conversationId: group.id, topicId: currentTopic.id, clientMessageId: randomUUID(),
      content: { format: "duallane.message+json;v=1", plainText: existingBody, blocks: [{ type: "text", text: existingBody }] }
    } });
    expect(seedResponse.status()).toBe(201);
    const existing = (await seedResponse.json() as { message: Message }).message;

    await enterTopic(memberPage, hiddenTopic);
    uploads = await holdFirstTwoUploads(memberPage);
    const hiddenRegion = topicRegion(memberPage, hiddenTopic);
    await hiddenRegion.getByLabel("添加附件", { exact: true }).setInputFiles([1, 2, 3].map((index) => ({
      name: `revoked-topic-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from(`撤权前排队附件 ${index}`)
    })));
    await hiddenRegion.getByTitle("发送消息", { exact: true }).click();
    await uploads.uploading;
    await hiddenRegion.getByRole("textbox", { name: "输入消息", exact: true }).fill("隐藏话题尚未发送的新草稿");
    await memberPage.locator(".workspace-topic-row").filter({ hasText: currentTopic.title }).click();
    const currentRegion = topicRegion(memberPage, currentTopic);
    await expect(messageRow(memberPage, currentTopic, existing.id)).toContainText(existingBody);
    await currentRegion.getByRole("textbox", { name: "输入消息", exact: true }).fill("当前话题尚未发送的新草稿");
    await currentRegion.getByLabel("添加附件", { exact: true }).setInputFiles({ name: "current-unsent.txt", mimeType: "text/plain", buffer: Buffer.from("未提交附件") });
    const cancellations = uploads.waitForCancellation();
    expect((await page.request.delete(`/api/workspace/groups/${group.id}/members/${memberId}`)).ok()).toBe(true);
    await expect(memberPage.getByRole("heading", { name: "无法打开话题", exact: true })).toBeVisible();
    await expect(memberPage.getByRole("textbox", { name: "输入消息", exact: true })).toHaveCount(0);
    await expect(memberPage.getByText(existingBody, { exact: true })).toHaveCount(0);
    uploads.release();
    for (const response of await cancellations) expect(response.ok()).toBe(true);
    for (const topic of [hiddenTopic, currentTopic]) {
      expect([403, 404]).toContain((await memberPage.request.get(`/api/workspace/topics/${topic.id}/messages`)).status());
    }
    expect(uploads.reservedNames.sort()).toEqual(["revoked-topic-1.txt", "revoked-topic-2.txt"]);
    expect(uploads.uploadIds).toHaveLength(2);
    expect(uploads.messageAttempts).toHaveLength(0);

    // Restore authorization without reloading this document, so the following
    // assertions inspect the same App/session store that held both old drafts.
    expect((await page.request.post(`/api/workspace/groups/${group.id}/members`, { data: { userId: memberId } })).ok()).toBe(true);
    for (const topic of [hiddenTopic, currentTopic]) {
      expect((await memberPage.request.post(`/api/workspace/topics/${topic.id}/join`, { data: {} })).ok()).toBe(true);
    }
    // A real group edit publishes the complete refreshed conversation snapshot.
    expect((await page.request.patch(`/api/workspace/groups/${group.id}`, { data: { title: `${group.title} 已恢复` } })).ok()).toBe(true);
    const restoredList = await memberPage.request.get("/api/workspace/topics/mine");
    expect(restoredList.ok()).toBe(true);
    expect((await restoredList.json() as { topics: Topic[] }).topics.map((topic) => topic.id)).toEqual(expect.arrayContaining([hiddenTopic.id, currentTopic.id]));
    await memberPage.getByRole("button", { name: "返回话题列表", exact: true }).click();
    await expect(memberPage).toHaveURL(/\/workspace\/topics$/);
    await expect(memberPage.locator(".workspace-topic-rail")).toBeVisible();
    for (const topic of [hiddenTopic, currentTopic]) {
      await memberPage.locator(".workspace-topic-row").filter({ hasText: topic.title }).click();
      const region = topicRegion(memberPage, topic);
      await expect(region.getByRole("textbox", { name: "输入消息", exact: true })).toHaveText("");
      await expect(region.locator(".message-local-state")).toHaveCount(0);
      await expect(region.getByText("current-unsent.txt", { exact: true })).toHaveCount(0);
      await expect(region.getByTitle("发送消息", { exact: true })).toBeDisabled();
    }
    expect(uploads.reservedNames).toHaveLength(2);
    expect(uploads.uploadIds).toHaveLength(2);
    expect(uploads.messageAttempts).toHaveLength(0);
    const response = await page.request.get(`/api/workspace/topics/${hiddenTopic.id}/messages`);
    expect(response.ok()).toBe(true);
    expect((await response.json() as { messages: Message[] }).messages.filter((message) => message.clientMessageId?.startsWith("topic-web:"))).toHaveLength(0);
  } catch (error) {
    await testInfo.attach("member-page-state", { body: JSON.stringify({ url: memberPage.url(), text: await memberPage.locator("body").innerText() }), contentType: "application/json" });
    throw error;
  } finally {
    await uploads?.dispose();
    if (memberId) await page.request.delete(`/api/workspace/members/${memberId}`).catch(() => null);
    await memberContext.close();
  }
});
