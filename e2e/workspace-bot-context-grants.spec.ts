import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";

test("Bot owner explicitly grants bounded private and group context without expanding Token scopes", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const suffix = randomUUID().slice(0, 8);
  let botId = "";
  let memberId = "";
  let memberContext: BrowserContext | null = null;
  try {
    await page.goto("/workspace");
    await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const createBot = await page.request.post("/api/workspace/bots", { data: { name: `上下文验收 ${suffix}` } });
    expect(createBot.status()).toBe(201);
    const { bot } = await createBot.json() as { bot: { id: string; botUserId: string } };
    botId = bot.id;
    expect((await page.request.patch(`/api/workspace/bots/${botId}/settings`, { data: { visibilityPolicy: "space_members", allowGroup: true, requireOwnerApproval: false } })).status()).toBe(200);
    const directResponse = await page.request.post("/api/workspace/conversations", { data: { type: "direct", targetUserId: bot.botUserId } });
    expect(directResponse.status()).toBe(201);
    const directId = (await directResponse.json() as { conversation: { id: string } }).conversation.id;

    memberContext = await browser.newContext();
    const inviteResponse = await page.request.post("/api/workspace/invites", { data: { defaultRole: "member", maxUses: 1 } });
    expect(inviteResponse.status()).toBe(201);
    const inviteCode = (await inviteResponse.json() as { invite: { code: string } }).invite.code;
    const acceptResponse = await memberContext.request.post(`/api/workspace/invites/${inviteCode}/accept`, { data: { githubId: `grant-member-${suffix}`, githubLogin: `grant-member-${suffix}`, email: `grant-member-${suffix}@example.test`, displayName: `授权成员 ${suffix}` } });
    expect(acceptResponse.status()).toBe(201);
    memberId = (await acceptResponse.json() as { user: { id: string } }).user.id;
    const groupTitle = `上下文群 ${suffix}`;
    const groupResponse = await page.request.post("/api/workspace/conversations", { data: { type: "group", title: groupTitle, memberIds: [memberId] } });
    expect(groupResponse.status()).toBe(201);
    const groupId = (await groupResponse.json() as { conversation: { id: string } }).conversation.id;
    expect((await page.request.patch(`/api/workspace/bots/${botId}/group-policies/${groupId}`, { data: { status: "active", allowTrigger: true, allowContext: false, maxMessages: 8 } })).status()).toBe(200);
    const pendingTitle = `待批准群 ${suffix}`;
    const pendingResponse = await page.request.post("/api/workspace/conversations", { data: { type: "group", title: pendingTitle, memberIds: [memberId] } });
    expect(pendingResponse.status()).toBe(201);
    const pendingId = (await pendingResponse.json() as { conversation: { id: string } }).conversation.id;
    expect((await page.request.patch(`/api/workspace/bots/${botId}/group-policies/${pendingId}`, { data: { status: "pending", allowTrigger: false, allowContext: false } })).status()).toBe(200);

    const limitedResponse = await page.request.post(`/api/workspace/bots/${botId}/tokens`, { data: { scopes: ["messages:read_trigger", "messages:send"] } });
    expect(limitedResponse.status()).toBe(201);
    const limitedToken = (await limitedResponse.json() as { token: string }).token;
    const contextResponse = await page.request.post(`/api/workspace/bots/${botId}/tokens`, { data: { scopes: ["messages:read_context"] } });
    expect(contextResponse.status()).toBe(201);
    const contextToken = (await contextResponse.json() as { token: string }).token;
    for (let index = 0; index < 5; index += 1) {
      const text = `授权范围消息 ${suffix} ${index}`;
      expect((await page.request.post("/api/workspace/messages", { data: { conversationId: directId, clientMessageId: randomUUID(), content: { format: "duallane.message+json;v=1", blocks: [{ type: "text", text }], plainText: text } } })).status()).toBe(201);
    }
    expect((await page.request.get(`/api/bot-gateway/v1/conversations/${directId}/context`, { headers: { authorization: `Bearer ${contextToken}` } })).status()).toBe(403);

    await page.goto("/workspace/account/bot");
    await page.getByRole("tab", { name: "授权", exact: true }).click();
    const panel = page.getByRole("region", { name: "会话上下文授权", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole("combobox", { name: "授权会话" }).click();
    await page.getByRole("option", { name: /^私聊 · 与 Bot 的所有者私聊/ }).click();
    await expect(panel.getByText(/当前授权状态未返回。现有接口不提供私聊授权查询/)).toBeVisible();
    await panel.getByRole("button", { name: "设置私聊授权", exact: true }).click();
    const grantPath = `/api/workspace/bots/${botId}/context-grants/${directId}`;
    let privateWrites = 0;
    page.on("request", request => { if (request.method() === "PATCH" && request.url().endsWith(grantPath)) privateWrites += 1; });
    await panel.getByRole("switch", { name: "允许触发", exact: true }).click();
    await panel.getByRole("switch", { name: "允许读取上下文", exact: true }).click();
    await panel.getByRole("spinbutton", { name: "本会话最多读取消息数" }).fill("3");
    expect(privateWrites).toBe(0);
    await page.route(`**${grantPath}`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "test.unavailable", message: "暂时无法保存授权" } }) }));
    await panel.getByRole("button", { name: "保存本会话授权", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("暂时无法保存授权");
    await expect(panel.getByRole("spinbutton", { name: "本会话最多读取消息数" })).toHaveValue("3");
    await expect(panel.getByRole("switch", { name: "允许读取上下文", exact: true })).toHaveAttribute("aria-checked", "true");
    await page.unroute(`**${grantPath}`);
    const saved = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(grantPath));
    await panel.getByRole("button", { name: "重试保存本会话授权", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(panel.getByRole("status")).toHaveText("本会话授权已保存。Token 权限仍独立生效。");

    const deniedScope = await page.request.get(`/api/bot-gateway/v1/conversations/${directId}/context`, { headers: { authorization: `Bearer ${limitedToken}` } });
    expect(deniedScope.status()).toBe(403);
    expect(await deniedScope.json()).toMatchObject({ error: { code: "bot.scope_denied" } });
    const boundedContext = await page.request.get(`/api/bot-gateway/v1/conversations/${directId}/context?limit=100`, { headers: { authorization: `Bearer ${contextToken}` } });
    expect(boundedContext.status()).toBe(200);
    const context = await boundedContext.json() as { limits: { maxMessages: number }; messages: unknown[] };
    expect(context.limits.maxMessages).toBe(3);
    expect(context.messages).toHaveLength(3);
    expect((await memberContext.request.patch(grantPath, { data: { allowContext: true, maxMessages: 200 } })).status()).toBe(403);

    await panel.getByRole("button", { name: "修改本会话授权", exact: true }).click();
    await panel.getByRole("button", { name: "关闭本会话触发和上下文", exact: true }).click();
    const closed = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(grantPath));
    await panel.getByRole("button", { name: "保存本会话授权", exact: true }).click();
    expect(await (await closed).json()).toMatchObject({ grant: { allowTrigger: false, allowContext: false, maxMessages: 3 } });
    expect((await page.request.get(`/api/bot-gateway/v1/conversations/${directId}/context`, { headers: { authorization: `Bearer ${contextToken}` } })).status()).toBe(403);

    await panel.getByRole("combobox", { name: "授权会话" }).click();
    await page.getByRole("option", { name: new RegExp(`^群聊 · ${groupTitle}`) }).click();
    await panel.getByRole("button", { name: "修改本会话授权", exact: true }).click();
    await panel.getByRole("switch", { name: "允许读取上下文", exact: true }).click();
    await panel.getByRole("spinbutton", { name: "本会话最多读取消息数" }).fill("4");
    const groupSaved = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/group-policies/${groupId}`));
    await panel.getByRole("button", { name: "保存本会话授权", exact: true }).click();
    expect(await (await groupSaved).json()).toMatchObject({ policy: { status: "active", allowTrigger: true, allowContext: true, contextMaxMessages: 4 } });
    await expect(panel.getByRole("status")).toHaveText("本会话授权已保存。Token 权限仍独立生效。");
    await page.reload();
    await page.getByRole("tab", { name: "授权", exact: true }).click();
    await panel.getByRole("combobox", { name: "授权会话" }).click();
    await page.getByRole("option", { name: new RegExp(`^群聊 · ${groupTitle}`) }).click();
    await expect(panel.locator(".dl-bot-context-summary")).toContainText("4");
    await panel.getByRole("combobox", { name: "授权会话" }).click();
    await page.getByRole("option", { name: new RegExp(`^群聊 · ${pendingTitle}`) }).click();
    await expect(panel.getByText(/此群授权尚未生效或已移除/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "修改本会话授权", exact: true })).toHaveCount(0);
    const policies = await (await page.request.get(`/api/workspace/bots/${botId}/group-policies`)).json() as { policies: Array<{ conversationId: string; status: string }> };
    expect(policies.policies.find(policy => policy.conversationId === pendingId)?.status).toBe("pending");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    if (botId) {
      const deleting = await page.request.delete(`/api/workspace/bots/${botId}`).catch(() => null);
      if (deleting?.ok()) await page.request.post(`/api/workspace/bots/${botId}/delete/confirm`).catch(() => null);
    }
    if (memberId) await page.request.delete(`/api/workspace/members/${memberId}`).catch(() => null);
    await memberContext?.close();
  }
});
