import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

type ConversationScope = "group" | "topic";
type Group = { id: string; title: string };
type Topic = { id: string; title: string };

async function sendMessage(page: Page, groupId: string, topicId: string | undefined, text: string) {
  const response = await page.request.post(topicId ? `/api/workspace/topics/${topicId}/messages` : "/api/workspace/messages", {
    data: {
      conversationId: groupId, ...(topicId ? { topicId } : {}), clientMessageId: randomUUID(),
      content: { format: "duallane.message+json;v=1", plainText: text, blocks: [{ type: "text", text }] }
    }
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { message: { id: string } }).message.id;
}

async function signIn(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录", exact: true }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("aria-busy", "false");
}

async function createConversation(page: Page, browser: Browser, scope: ConversationScope) {
  const suffix = randomUUID().slice(0, 8);
  const memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  let memberId = "";
  try {
    const invited = await page.request.post("/api/workspace/invites", { data: { defaultRole: "member", maxUses: 1 } });
    expect(invited.status()).toBe(201);
    const { invite } = await invited.json() as { invite: { code: string } };
    const accepted = await memberContext.request.post(`/api/workspace/invites/${encodeURIComponent(invite.code)}/accept`, {
      data: { githubId: `reaction-picker-${suffix}`, githubLogin: `reaction-picker-${suffix}`, email: `reaction-picker-${suffix}@example.test`, displayName: `回应测试成员 ${suffix}` }
    });
    expect(accepted.status()).toBe(201);
    memberId = (await accepted.json() as { user: { id: string } }).user.id;
    const created = await page.request.post("/api/workspace/conversations", {
      data: { type: "group", title: `回应浮层 ${suffix}`, memberIds: [memberId] }
    });
    expect(created.status()).toBe(201);
    const { conversation: group } = await created.json() as { conversation: Group };
    let topic: Topic | undefined;
    if (scope === "topic") {
      const topicResponse = await page.request.post(`/api/workspace/conversations/${group.id}/topics`, {
        data: { title: `话题回应 ${suffix}`, description: "回应浮层的独立测试话题", allowSyncToGroup: true, idempotencyKey: randomUUID() }
      });
      expect(topicResponse.status()).toBe(201);
      topic = (await topicResponse.json() as { topic: Topic }).topic;
    }
    const messageIds: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      messageIds.push(await sendMessage(page, group.id, topic?.id, `连续消息 ${index + 1}`));
    }
    return {
      groupId: group.id,
      topicId: topic?.id,
      path: topic ? `/workspace/topics/${topic.id}` : `/workspace/chat/${group.id}`,
      regionName: topic ? `话题 ${topic.title}` : group.title,
      messageIds,
      async dispose() {
        if (memberId) await page.request.delete(`/api/workspace/members/${memberId}`);
      }
    };
  } catch (error) {
    if (memberId) await page.request.delete(`/api/workspace/members/${memberId}`);
    throw error;
  } finally {
    await memberContext.close();
  }
}

async function waitForStableBox(target: Locator) {
  await expect(target).toBeVisible();
  await expect.poll(() => target.evaluate(async element => {
    let before = element.getBoundingClientRect();
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const after = element.getBoundingClientRect();
      if (after.width <= 0 || after.height <= 0 || ["x", "y", "width", "height"].some(key =>
        Math.abs(before[key as "x" | "y" | "width" | "height"] - after[key as "x" | "y" | "width" | "height"]) >= 0.25
      )) return false;
      before = after;
    }
    return true;
  })).toBe(true);
}

async function inspectPicker(picker: Locator) {
  await waitForStableBox(picker);
  return picker.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    // Insets keep the probes inside rounded corners while still detecting
    // clipping by the conversation's scroll container and composer.
    const points = [
      [rect.left + 12, rect.top + 12], [rect.right - 12, rect.top + 12],
      [rect.left + 12, rect.bottom - 12], [rect.right - 12, rect.bottom - 12],
      [rect.left + rect.width / 2, rect.top + rect.height / 2]
    ];
    return {
      box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: { left, top, right: left + (viewport?.width ?? innerWidth), bottom: top + (viewport?.height ?? innerHeight) },
      hitTests: points.map(([x, y]) => ({ x, y, inside: element.contains(document.elementFromPoint(x, y)) }))
    };
  });
}

function expectUnclipped(geometry: Awaited<ReturnType<typeof inspectPicker>>) {
  const detail = JSON.stringify(geometry);
  expect(geometry.box.left, detail).toBeGreaterThanOrEqual(geometry.viewport.left);
  expect(geometry.box.top, detail).toBeGreaterThanOrEqual(geometry.viewport.top);
  expect(geometry.box.right, detail).toBeLessThanOrEqual(geometry.viewport.right);
  expect(geometry.box.bottom, detail).toBeLessThanOrEqual(geometry.viewport.bottom);
  expect(geometry.hitTests.every(point => point.inside), detail).toBe(true);
}

async function openPicker(page: Page, row: Locator, width: number) {
  const trigger = row.getByRole("button", { name: width >= 760 ? "添加表情回复" : "更多消息操作", exact: true });
  await trigger.click();
  if (width < 760) {
    const menu = page.getByRole("menu", { name: "消息操作", exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "添加表情回复", exact: true }).click();
  }
  return trigger;
}

async function verifyDelayedSettingsFocus(page: Page, row: Locator) {
  const picker = page.getByRole("dialog", { name: "选择消息表情回复", exact: true });
  await openPicker(page, row, 1440);
  await picker.getByRole("tab", { name: "Emoji", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let responseHeld = false;
  const pattern = "**/api/workspace/me/emote-settings";
  await page.route(pattern, async route => {
    const response = await route.fetch();
    const payload = await response.json() as { settings: { enabledPackIds: string[] } };
    responseHeld = true;
    await gate;
    await route.fulfill({ response, json: { ...payload, settings: { ...payload.settings, enabledPackIds: ["feishu"] } } });
  });
  try {
    const trigger = await openPicker(page, row, 1440);
    await expect.poll(() => responseHeld).toBe(true);
    await expect(picker).toBeFocused();
    await expect(picker.getByRole("tab", { name: "Emoji", exact: true })).toBeVisible();
    release();
    await expect(picker.getByRole("tab", { name: "Emoji", exact: true })).toHaveCount(0);
    await expect(picker.getByRole("tab", { name: "飞书", exact: true })).toBeVisible();
    await expect.poll(() => picker.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    release();
    await page.unroute(pattern);
  }
}

async function verifyTopAndResize(page: Page, region: Locator, testInfo: TestInfo) {
  const messageId = await region.locator("article.workspace-message").nth(2).getAttribute("data-message-id");
  expect(messageId).not.toBeNull();
  const row = region.locator(`article.workspace-message[data-message-id="${messageId}"]`);
  await row.evaluate(element => element.scrollIntoView({ block: "start" }));
  await row.hover();
  const trigger = await openPicker(page, row, 1440);
  const picker = page.getByRole("dialog", { name: "选择消息表情回复", exact: true });
  const geometry = await inspectPicker(picker);
  const anchor = await trigger.boundingBox();
  expect(anchor).not.toBeNull();
  expectUnclipped(geometry);
  expect(geometry.box.top).toBeGreaterThanOrEqual(anchor!.y + anchor!.height + 4);
  await page.setViewportSize({ width: 1440, height: 420 });
  expectUnclipped(await inspectPicker(picker));
  await page.screenshot({ path: testInfo.outputPath("reaction-group-1440-short-window.png") });
  await page.setViewportSize({ width: 1440, height: 844 });
  expectUnclipped(await inspectPicker(picker));
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

async function verifyLongMessageContext(page: Page, conversation: Awaited<ReturnType<typeof createConversation>>, width: number, testInfo: TestInfo) {
  const text = Array.from({ length: 90 }, (_, index) => `长消息第 ${index + 1} 段`).join("\n\n");
  const messageId = await sendMessage(page, conversation.groupId, conversation.topicId, text);
  await page.goto(conversation.path);
  await expect(page.locator(".workspace-shell")).toHaveAttribute("aria-busy", "false");
  const region = page.getByRole("region", { name: conversation.regionName, exact: true });
  const row = region.locator(`article.workspace-message[data-message-id="${messageId}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "展开全文", exact: true }).click();
  await expect(row.getByRole("button", { name: "收起", exact: true })).toBeVisible();
  await row.evaluate(element => element.scrollIntoView({ block: "center" }));
  await waitForStableBox(row);
  const point = await row.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const list = element.closest(".workspace-message-list")!.getBoundingClientRect();
    const x = Math.max(rect.left, list.left) + 6;
    const y = (Math.max(rect.top, list.top) + Math.min(rect.bottom, list.bottom)) / 2;
    return { x, y, rowTop: rect.top, rowBottom: rect.bottom, rowHeight: rect.height, targetsRow: element.contains(document.elementFromPoint(x, y)) };
  });
  expect(point.rowHeight).toBeGreaterThan(844);
  expect(point.rowTop).toBeLessThan(0);
  expect(point.rowBottom).toBeGreaterThan(844);
  expect(point.targetsRow).toBe(true);
  const list = region.locator(".workspace-message-list");
  const scrollTop = await list.evaluate(element => element.scrollTop);
  const menu = page.getByRole("menu", { name: "消息操作", exact: true });
  if (width >= 760) {
    await page.mouse.click(point.x, point.y, { button: "right" });
  } else {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
      await expect(menu).toBeVisible();
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await session.detach();
    }
  }
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "添加表情回复", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择消息表情回复", exact: true });
  const geometry = await inspectPicker(picker);
  expectUnclipped(geometry);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(scrollTop);
  await testInfo.attach("long-message-context-geometry", { body: JSON.stringify({ ...geometry, point }), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath(`reaction-long-${width}.png`) });
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(scrollTop);
}

for (const width of [1440, 390, 320]) {
  test.describe(`${width}px reaction picker`, () => {
    test.use({ hasTouch: width < 760 });
    for (const scope of ["group", "topic"] as const) {
      test(`${scope} bottom message reaction picker stays usable at ${width}px`, async ({ page, browser }, testInfo) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: width === 1440 ? "dark" : "light" });
        await signIn(page);
        const settingsResponse = await page.request.get("/api/workspace/me/emote-settings");
        expect(settingsResponse.ok()).toBe(true);
        const { settings } = await settingsResponse.json() as { settings: { enabledPackIds: string[] } };
        let conversation: Awaited<ReturnType<typeof createConversation>> | undefined;
        try {
          expect((await page.request.put("/api/workspace/me/emote-settings", {
            data: { enabledPackIds: ["emoji", "feishu"] }
          })).ok()).toBe(true);
          conversation = await createConversation(page, browser, scope);
          await page.goto(conversation.path);
          const region = page.getByRole("region", { name: conversation.regionName, exact: true });
          const list = region.locator(".workspace-message-list");
          const lastId = conversation.messageIds.at(-1)!;
          const row = region.locator(`article.workspace-message[data-message-id="${lastId}"]`);
          await expect(row).toBeVisible();
          await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
          await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
          await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
          if (width >= 760) await row.hover();
          const scrollTop = await list.evaluate(element => element.scrollTop);
          expect(scrollTop).toBeGreaterThan(0);
          const anchor = await row.getByRole("button", { name: width >= 760 ? "添加表情回复" : "更多消息操作", exact: true }).boundingBox();
          expect(anchor).not.toBeNull();
          const trigger = await openPicker(page, row, width);
          const picker = page.getByRole("dialog", { name: "选择消息表情回复", exact: true });
          const geometry = await inspectPicker(picker);
          await testInfo.attach("bottom-reaction-picker-geometry", { body: JSON.stringify({ ...geometry, anchor, scrollTop }), contentType: "application/json" });
          expectUnclipped(geometry);
          expect(geometry.box.bottom).toBeLessThanOrEqual(anchor!.y - 4);
          await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(scrollTop);

          await page.screenshot({ path: testInfo.outputPath(`reaction-${scope}-${width}.png`) });

          await page.keyboard.press("Escape");
          await expect(picker).toHaveCount(0);
          await expect(trigger).toBeFocused();
          await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(scrollTop);

          await openPicker(page, row, width);
          await picker.getByRole("tab", { name: "飞书", exact: true }).click();
          const grid = picker.locator(".emote-builtin-grid");
          await expect.poll(() => grid.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
          await grid.hover();
          await page.mouse.wheel(0, 400);
          await expect.poll(() => grid.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
          await expect(picker).toBeVisible();
          expectUnclipped(await inspectPicker(picker));
          await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(scrollTop);
          const submitted = page.waitForResponse(response => response.url().endsWith(`/api/workspace/messages/${lastId}/reactions`) && response.request().method() === "POST");
          await picker.getByRole("button", { name: "OK", exact: true }).click();
          expect((await submitted).ok()).toBe(true);
          await expect(picker).toHaveCount(0);
          await expect(row.getByRole("button", { name: /OK，你/ })).toHaveAttribute("aria-pressed", "true");
          await expect(trigger).toBeFocused();

          if (scope === "group" && width === 1440) {
            await verifyDelayedSettingsFocus(page, row);
            await verifyTopAndResize(page, region, testInfo);
          }
          await verifyLongMessageContext(page, conversation, width, testInfo);
        } finally {
          await conversation?.dispose();
          await page.request.put("/api/workspace/me/emote-settings", { data: { enabledPackIds: settings.enabledPackIds } });
        }
      });
    }
  });
}
