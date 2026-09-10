import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

type SyntheticKeyOptions = {
  isComposing: boolean;
  keyCode: number;
  key?: string;
  shiftKey?: boolean;
};

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
}

async function dispatchSyntheticKey(input: Locator, options: SyntheticKeyOptions) {
  return input.evaluate((element, keyOptions) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      code: "Enter",
      key: keyOptions.key ?? "Enter",
      shiftKey: Boolean(keyOptions.shiftKey)
    });
    Object.defineProperty(event, "isComposing", { configurable: true, value: keyOptions.isComposing });
    Object.defineProperty(event, "keyCode", { configurable: true, value: keyOptions.keyCode });
    Object.defineProperty(event, "which", { configurable: true, value: keyOptions.keyCode });
    return { dispatched: element.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
  }, options);
}

async function dispatchSafariImeEnter(input: Locator) {
  return input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      code: "Enter",
      key: "Enter"
    });
    Object.defineProperty(event, "isComposing", { configurable: true, value: false });
    Object.defineProperty(event, "keyCode", { configurable: true, value: 229 });
    Object.defineProperty(event, "which", { configurable: true, value: 229 });
    return { dispatched: element.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
  });
}

test("Workspace chat and topic editors keep IME confirmation out of send and mention actions", async ({ page, browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  try {
    await enterWorkspaceAsSeededOwner(page);

    const inviteResponse = await page.request.post("/api/workspace/invites", {
      data: { defaultRole: "member", maxUses: 1 }
    });
    expect(inviteResponse.status()).toBe(201);
    const invite = (await inviteResponse.json() as { invite: { code: string } }).invite;
    const acceptResponse = await memberPage.request.post(
      `/api/workspace/invites/${encodeURIComponent(invite.code)}/accept`,
      {
        data: {
          githubId: `workspace-ime-${suffix}`,
          githubLogin: `workspace-ime-${suffix}`,
          email: `workspace-ime-${suffix}@example.test`,
          displayName: `IME 成员 ${suffix}`
        }
      }
    );
    expect(acceptResponse.status()).toBe(201);
    const member = (await acceptResponse.json() as { user: { id: string } }).user;

    const groupTitle = `IME 回归群 ${suffix}`;
    const groupResponse = await page.request.post("/api/workspace/conversations", {
      data: { type: "group", title: groupTitle, memberIds: [member.id] }
    });
    expect(groupResponse.status()).toBe(201);
    const group = (await groupResponse.json() as { conversation: { id: string } }).conversation;

    await page.goto(`/workspace/chat/${group.id}`);
    const chat = page.getByRole("region", { name: groupTitle });
    await expect(chat).toBeVisible();
    const chatInput = chat.getByLabel("输入消息");
    const workspaceMessageWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/workspace/messages")) {
        workspaceMessageWrites.push(request.url());
      }
    });

    const composingText = `workspace-ime-composing-${suffix}`;
    await chatInput.fill(composingText);
    const composingKey = await dispatchSyntheticKey(chatInput, { isComposing: true, keyCode: 13 });
    expect(composingKey).toEqual({ dispatched: true, defaultPrevented: false });
    await expect(chatInput).toHaveText(composingText);
    expect(workspaceMessageWrites).toHaveLength(0);

    const safariKey = await dispatchSafariImeEnter(chatInput);
    expect(safariKey).toEqual({ dispatched: true, defaultPrevented: false });
    await expect(chatInput).toHaveText(composingText);
    expect(workspaceMessageWrites).toHaveLength(0);

    const shiftText = `workspace-ime-shift-${suffix}`;
    await chatInput.fill(shiftText);
    const shiftKey = await dispatchSyntheticKey(chatInput, { isComposing: false, keyCode: 13, shiftKey: true });
    expect(shiftKey).toEqual({ dispatched: false, defaultPrevented: true });
    await expect(chatInput).toHaveText(shiftText);
    expect(workspaceMessageWrites).toHaveLength(0);

    const ordinaryText = `workspace-ime-ordinary-${suffix}`;
    await chatInput.fill(ordinaryText);
    const ordinaryResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    const ordinaryKey = await dispatchSyntheticKey(chatInput, { isComposing: false, keyCode: 13 });
    expect(ordinaryKey).toEqual({ dispatched: false, defaultPrevented: true });
    expect((await ordinaryResponse).status()).toBe(201);
    await expect(chatInput).toHaveText("");
    expect(workspaceMessageWrites).toHaveLength(1);

    await chatInput.fill("@");
    const mentionPicker = page.getByRole("dialog", { name: "提及成员" });
    await expect(mentionPicker).toBeVisible();
    const mentionKey = await dispatchSafariImeEnter(chatInput);
    expect(mentionKey).toEqual({ dispatched: true, defaultPrevented: false });
    await expect(chatInput).toHaveText("@");
    await expect(mentionPicker).toBeVisible();
    await expect(chat.locator(".workspace-editor-token.mention")).toHaveCount(0);
    expect(workspaceMessageWrites).toHaveLength(1);

    const topicTitle = `IME 话题 ${suffix}`;
    const topicSource = `#[${topicTitle}](验证 IME 确认不会发送话题消息)`;
    await chatInput.fill(topicSource);
    const topicCreateResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/messages") && response.request().method() === "POST"
    );
    await chat.locator("form.workspace-composer button.workspace-send-button").click();
    expect((await topicCreateResponse).status()).toBe(201);

    const topicsResponse = await page.request.get(`/api/workspace/conversations/${encodeURIComponent(group.id)}/topics`);
    expect(topicsResponse.status()).toBe(200);
    const topics = (await topicsResponse.json() as {
      topics: Array<{ id: string; title: string }>;
    }).topics;
    const topic = topics.find((candidate) => candidate.title === topicTitle);
    expect(topic).toBeTruthy();

    await memberPage.goto(`/workspace/topics/${topic!.id}`);
    const memberTopic = memberPage.getByRole("region", { name: `话题 ${topicTitle}` });
    await expect(memberTopic).toBeVisible();
    await memberTopic.getByRole("button", { name: "加入话题", exact: true }).click();
    await expect(memberTopic.getByRole("button", { name: "退出话题", exact: true })).toBeVisible();

    await page.goto(`/workspace/topics/${topic!.id}`);
    const topicRegion = page.getByRole("region", { name: `话题 ${topicTitle}` });
    await expect(topicRegion).toBeVisible();
    const topicInput = topicRegion.getByLabel("输入消息");
    const topicMessageWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/workspace\/topics\/[^/]+\/messages$/.test(request.url())) {
        topicMessageWrites.push(request.url());
      }
    });

    await topicInput.fill("@");
    const topicMentionMenu = topicRegion.locator(".workspace-topic-mention-menu");
    await expect(topicMentionMenu).toBeVisible();
    const topicImeKey = await dispatchSafariImeEnter(topicInput);
    expect(topicImeKey).toEqual({ dispatched: true, defaultPrevented: false });
    await expect(topicInput).toHaveText("@");
    await expect(topicMentionMenu).toBeVisible();
    await expect(topicRegion.locator(".workspace-editor-token.mention")).toHaveCount(0);
    expect(topicMessageWrites).toHaveLength(0);

    const topicText = `topic-ime-ordinary-${suffix}`;
    await topicInput.fill(topicText);
    const topicMessageResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/workspace/topics/${topic!.id}/messages`) && response.request().method() === "POST"
    );
    const topicOrdinaryKey = await dispatchSyntheticKey(topicInput, { isComposing: false, keyCode: 13 });
    expect(topicOrdinaryKey).toEqual({ dispatched: false, defaultPrevented: true });
    expect((await topicMessageResponse).status()).toBe(201);
    expect(topicMessageWrites).toHaveLength(1);
  } finally {
    await memberContext.close();
  }
});
