import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

type Group = { id: string; title: string; type: string };
type Topic = { id: string; title: string; conversationId: string; revision: number };

async function signIn(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  const response = await page.request.get("/api/workspace/conversations");
  expect(response.ok()).toBe(true);
  const { conversations } = await response.json() as { conversations: Group[] };
  const group = conversations.find((conversation) => conversation.type === "group");
  expect(group).toBeTruthy();
  return group!;
}

async function createViaApi(page: Page, group: Group, title: string) {
  const response = await page.request.post(`/api/workspace/conversations/${group.id}/topics`, { data: { title, description: `${title} 的初始正文`, allowSyncToGroup: true, idempotencyKey: randomUUID() } });
  expect(response.ok()).toBe(true);
  return (await response.json() as { topic: Topic }).topic;
}

async function openTopicFromRail(page: Page, title: string) {
  await page.locator(".workspace-primary-navigation").getByRole("button", { name: "话题", exact: true }).click();
  await page.locator(".workspace-topic-row").filter({ hasText: title }).click();
  await expect(page.locator(".workspace-chat-header")).toContainText(title);
}

test("explicit topic form retries one structured creation without moving the group draft", async ({ page }) => {
  const group = await signIn(page);
  await page.goto(`/workspace/chat/${group.id}`);
  const groupDraft = `群草稿-${randomUUID()}`;
  await page.getByRole("textbox", { name: "输入消息" }).fill(groupDraft);
  await page.locator(".workspace-primary-navigation").getByRole("button", { name: "话题", exact: true }).click();
  await page.locator(".workspace-topic-rail").getByRole("button", { name: "新建话题", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建话题", exact: true });
  await dialog.getByRole("radio", { name: group.title, exact: true }).click();
  const title = `显式创建-${randomUUID().slice(0, 8)}`;
  const description = "正文包含 ) 和 #[保持原文](内容)，不会另建话题。";
  await dialog.getByLabel("标题", { exact: true }).fill(title);
  await dialog.getByLabel("正文", { exact: true }).fill(description);
  const attempts: Record<string, unknown>[] = [];
  await page.route(`**/api/workspace/conversations/${group.id}/topics`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      // The server commits, but the browser cannot confirm the result. Retrying
      // must reuse the attempt key rather than create a second topic/card.
      expect((await route.fetch()).ok()).toBe(true);
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "测试：临时不可用" } }) });
    }
    else await route.continue();
  });
  await dialog.getByRole("button", { name: "创建并进入话题" }).click();
  await expect(dialog.getByRole("alert")).toContainText("临时不可用");
  await expect(dialog.getByLabel("正文", { exact: true })).toHaveValue(description);
  await dialog.getByRole("button", { name: "创建并进入话题" }).click();
  await expect(page).toHaveURL(/\/workspace\/topics\/top_/);
  await expect(page.locator(".workspace-chat-header")).toContainText(title);
  await expect(page.locator(".dl-topic-target")).toContainText(title);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[0]).toMatchObject({ title, description });
  expect(attempts[0]).not.toHaveProperty("source");
  const topicId = new URL(page.url()).pathname.split("/").at(-1)!;
  const messageResponse = await page.request.get(`/api/workspace/topics/${topicId}/messages`);
  expect((await messageResponse.json()).messages).toHaveLength(1);
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveText("");
  await page.locator(".dl-topic-banner").getByRole("button", { name: group.title, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveText(groupDraft);
});

test("topic routes preserve separate drafts and replies and opening an existing topic never retargets group text", async ({ page }) => {
  const group = await signIn(page);
  const suffix = randomUUID().slice(0, 7);
  const a = await createViaApi(page, group, `草稿甲-${suffix}`);
  const b = await createViaApi(page, group, `草稿乙-${suffix}`);
  await page.goto(`/workspace/chat/${group.id}`);
  await page.getByRole("textbox", { name: "输入消息" }).fill("留在所属群的草稿");
  await page.getByTitle("打开话题", { exact: true }).click();
  await page.getByRole("listbox", { name: "打开已有话题" }).getByRole("option").filter({ hasText: a.title }).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/topics/${a.id}$`));
  const composer = page.getByRole("textbox", { name: "输入消息" });
  await expect(composer).toHaveText("");
  await composer.fill("甲的草稿");
  const message = page.locator(".workspace-topic-page .workspace-message").first();
  await message.focus();
  await message.press("Shift+F10");
  await page.getByRole("menu", { name: "消息操作" }).getByRole("menuitem", { name: "回复", exact: true }).click();
  await page.getByRole("switch", { name: "同步到群聊", exact: true }).click();
  await openTopicFromRail(page, b.title);
  await expect(composer).toHaveText("");
  await expect(page.locator(".composer-reply")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "同步到群聊", exact: true })).toHaveAttribute("aria-checked", "false");
  await composer.fill("乙的草稿");
  await openTopicFromRail(page, a.title);
  await expect(composer).toHaveText("甲的草稿");
  await expect(page.locator(".composer-reply")).toContainText(a.title);
  await expect(page.getByRole("switch", { name: "同步到群聊", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.locator(".dl-topic-banner").getByRole("button", { name: group.title, exact: true }).click();
  await expect(composer).toHaveText("留在所属群的草稿");
  await openTopicFromRail(page, b.title);
  await expect(composer).toHaveText("乙的草稿");
});

test("late topic send preserves newer input and a closed topic retains a read-only draft", async ({ page }) => {
  const group = await signIn(page);
  const topic = await createViaApi(page, group, `发送隔离-${randomUUID().slice(0, 7)}`);
  await page.goto(`/workspace/topics/${topic.id}`);
  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.fill("本次发送的正文");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requestSeen!: () => void;
  const requested = new Promise<void>((resolve) => { requestSeen = resolve; });
  await page.route(`**/api/workspace/topics/${topic.id}/messages`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    requestSeen(); await gate; await route.continue();
  });
  await page.getByTitle("发送消息", { exact: true }).click();
  await requested;
  await composer.fill("发送期间写下的新草稿");
  release();
  await expect(page.locator(".workspace-topic-page .workspace-message").filter({ hasText: "本次发送的正文" })).toHaveCount(1);
  await expect(page.locator(".message-local-state.sending")).toHaveCount(0);
  await expect(composer).toHaveText("发送期间写下的新草稿");
  await page.getByRole("button", { name: "话题详情", exact: true }).click();
  await page.getByRole("dialog", { name: "话题详情", exact: true }).getByRole("button", { name: "关闭话题", exact: true }).click();
  await page.getByRole("button", { name: "关闭话题详情", exact: true }).click();
  await expect(page.locator(".workspace-topic-status")).toHaveText("已关闭");
  await expect(composer).toHaveAttribute("contenteditable", "false");
  await expect(composer).toHaveText("发送期间写下的新草稿");
  await expect(page.getByTitle("发送消息", { exact: true })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "同步到群聊", exact: true })).toBeDisabled();
});

test("new topic form protects browser back and discards only after explicit confirmation", async ({ page }) => {
  await signIn(page);
  const navigation = page.locator(".workspace-primary-navigation");
  await navigation.getByRole("button", { name: "文件", exact: true }).click();
  await navigation.getByRole("button", { name: "话题", exact: true }).click();
  await page.locator(".workspace-topic-rail").getByRole("button", { name: "新建话题", exact: true }).click();
  const form = page.getByRole("dialog", { name: "新建话题", exact: true });
  await form.getByLabel("标题", { exact: true }).fill("尚未创建的话题");
  await page.goBack();
  const confirmation = page.getByRole("dialog", { name: "放弃新建话题？", exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "继续留在这里" }).click();
  await expect(page).toHaveURL(/\/workspace\/topics$/);
  await expect(form.getByLabel("标题", { exact: true })).toHaveValue("尚未创建的话题");
  await page.goBack();
  await confirmation.getByRole("button", { name: "放弃创建并离开" }).click();
  await expect(page).toHaveURL(/\/workspace\/files$/);
  await expect(form).toHaveCount(0);
});

test("a completed topic creation clears an outstanding back intent and opens the new topic", async ({ page }) => {
  const group = await signIn(page);
  const navigation = page.locator(".workspace-primary-navigation");
  await navigation.getByRole("button", { name: "文件", exact: true }).click();
  await navigation.getByRole("button", { name: "话题", exact: true }).click();
  await page.locator(".workspace-topic-rail").getByRole("button", { name: "新建话题", exact: true }).click();
  const form = page.getByRole("dialog", { name: "新建话题", exact: true });
  const title = `创建返回竞争-${randomUUID().slice(0, 7)}`;
  await form.getByRole("radio", { name: group.title, exact: true }).click();
  await form.getByLabel("标题", { exact: true }).fill(title);
  await form.getByLabel("正文", { exact: true }).fill("提交后尝试返回，成功响应仍然进入正确话题。");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requestSeen!: () => void;
  const requested = new Promise<void>((resolve) => { requestSeen = resolve; });
  await page.route(`**/api/workspace/conversations/${group.id}/topics`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    requestSeen(); await gate; await route.continue();
  });
  await form.getByRole("button", { name: "创建并进入话题" }).click();
  await requested;
  await page.goBack();
  const confirmation = page.getByRole("dialog", { name: "放弃新建话题？", exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "放弃创建并离开" }).click();
  await expect(confirmation.getByRole("alert")).toContainText("操作尚未结束");
  release();
  await expect(page).toHaveURL(/\/workspace\/topics\/top_/);
  await expect(page.locator(".workspace-chat-header")).toContainText(title);
  await expect(confirmation).toHaveCount(0);
  await expect(form).toHaveCount(0);
});
