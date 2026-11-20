import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { DualLaneAgentClient, buildMessageContent, messageText, messageMention, messageAttachment,
  createTaskToolServer, type AgentEvent, type AgentTaskClient } from "../packages/agent-sdk/src/index.js";
import { buildAgentInteractiveCard } from "../packages/agent-sdk/src/task-tools.js";

type JsonRecord = Record<string, unknown>;

type BotProjection = {
  id: string;
  botUserId: string;
  name: string;
};

const accessPolicyPreset = {
  version: 2,
  discovery: { audience: "owner_only", memberIds: [] },
  direct: { audience: "owner_only", memberIds: [] },
  groups: {
    audience: "current_members",
    memberIds: [],
    allowBotTriggers: false,
    allowedBotIds: [],
  },
} as const;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function arrayOfRecords(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value.map((entry, index) => asRecord(entry, `${label}[${index}]`));
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function jsonRequest(
  request: APIRequestContext,
  method: "GET" | "POST" | "PATCH",
  path: string,
  data?: JsonRecord
): Promise<JsonRecord> {
  const response = await request.fetch(path, {
    method,
    ...(data ? { data } : {}),
  });
  expect(response.ok(), `${method} ${path} returned ${response.status()}`).toBeTruthy();
  return asRecord(await response.json(), `${method} ${path} response`);
}

async function bootstrap(page: Page): Promise<JsonRecord> {
  const response = await page.request.get("/api/v1/bootstrap");
  if (response.status() === 404) {
    return jsonRequest(page.request, "GET", "/api/workspace/bootstrap");
  }
  expect(response.ok(), `GET /api/v1/bootstrap returned ${response.status()}`).toBeTruthy();
  return asRecord(await response.json(), "bootstrap response");
}

async function createSyntheticBot(page: Page, name: string): Promise<string> {
  const response = await page.request.post("/api/v1/bots", { data: { name } });
  expect(response.status(), `create ${name}`).toBe(201);
  const payload = asRecord(await response.json(), `create ${name} response`);
  return requiredString(payload.botId, `legacy botId for ${name}`);
}

async function findOwnedBot(page: Page, botId: string): Promise<BotProjection> {
  const payload = await jsonRequest(page.request, "GET", "/api/workspace/bots");
  const bots = arrayOfRecords(payload.bots, "owned bots");
  const bot = bots.find((candidate) => candidate.id === botId);
  if (!bot) throw new Error(`owned bot ${botId} was not returned by /api/workspace/bots`);
  return {
    id: requiredString(bot.id, "bot config id"),
    botUserId: requiredString(bot.botUserId, "bot public user id"),
    name: requiredString(bot.name, "bot name"),
  };
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const audit = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const visibleInteractive = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), textarea, [role="switch"], [role="combobox"]'
      )
    ).filter((element) => {
      let current: HTMLElement | null = element;
      while (current) {
        const styles = window.getComputedStyle(current);
        if (
          styles.display === "none" ||
          styles.visibility === "hidden" ||
          Number(styles.opacity) === 0 ||
          styles.pointerEvents === "none"
        ) {
          return false;
        }
        current = current.parentElement;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const outOfBounds = visibleInteractive.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.left >= -1 && rect.right <= viewportWidth + 1) return [];
      return [
        `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") ||
          element.textContent?.trim().slice(0, 24) || ""}] left=${rect.left.toFixed(1)} right=${rect.right.toFixed(1)}`,
      ];
    });
    return { viewportWidth, scrollWidth, outOfBounds };
  });

  expect(audit.scrollWidth, `${label}: document does not overflow horizontally`).toBeLessThanOrEqual(
    audit.viewportWidth
  );
  expect(audit.outOfBounds, `${label}: visible controls stay inside the viewport`).toEqual([]);
}

async function waitForPatchBody(page: Page, pathnamePart: string): Promise<JsonRecord> {
  const request = await page.waitForRequest((candidate) => {
    if (candidate.method() !== "PATCH") return false;
    try {
      return new URL(candidate.url()).pathname.includes(pathnamePart);
    } catch {
      return false;
    }
  });
  return asRecord(request.postDataJSON(), `PATCH ${pathnamePart} body`);
}

async function signInOwner(page: Page, baseURL: string): Promise<string> {
  await page.goto(`${baseURL}/`);
  await expect(page.getByTestId("home-card-workspace")).toBeVisible();
  await page.getByTestId("home-card-workspace").click();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.getByRole("button", { name: "使用 GitHub 登录共享空间" }).click();
  await expect(page.getByRole("heading", { name: "共享空间" })).toBeVisible();

  await page.getByRole("button", { name: "设置中心" }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "个人", exact: true }).click();
  await settings.getByRole("button", { name: "生成邀请码" }).click();
  const code = (await settings.getByTestId("generated-invite-code").textContent())?.trim() || "";
  expect(code.length, "owner invite code").toBeGreaterThan(4);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  return code;
}

async function joinMember(page: Page, baseURL: string, inviteCode: string, memberLabel: string): Promise<void> {
  await page.goto(`${baseURL}/?invite=${encodeURIComponent(inviteCode)}`);
  await page.getByPlaceholder("可选：测试成员昵称（双窗口联调推荐使用）").fill(memberLabel);
  await page.getByRole("button", { name: "通过邀请码直接加入（开发环境快捷入口）" }).click();
  // The unauthenticated entry has the same heading. Wait for the server to
  // recognize the issued human cookie before using this context's APIs.
  await expect.poll(async () => (await page.request.get(new URL("/api/workspace/bootstrap", baseURL).href)).status(),
    { timeout: 15_000, message: "invited member is authenticated by the actual Go service" }).toBe(200);
  await expect(page.getByRole("main", { name: "DualLane 工作台", exact: true })).toBeVisible();
}

async function createGroup(page: Page, title: string, memberLabel: string): Promise<string> {
  await page.getByRole("button", { name: "新建群组" }).click();
  const dialog = page.getByRole("dialog", { name: "新建群聊", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("群组名称", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: new RegExp(escapedRegExp(memberLabel)) }).click();

  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== "POST") return false;
    try {
      return new URL(response.url()).pathname === "/api/v1/conversations/groups";
    } catch {
      return false;
    }
  }, { timeout: 15000 });
  await dialog.getByRole("button", { name: "创建群组" }).click();
  const response = await responsePromise;
  expect(response.ok(), `create group returned ${response.status()}`).toBeTruthy();
  const payload = asRecord(await response.json(), "create group response");
  const conversation = asRecord(payload.conversation ?? payload, "created group");
  const groupId = requiredString(conversation.id, "created group id");
  await expect(dialog).toBeHidden();
  return groupId;
}

async function openGroupInspector(page: Page, title: string): Promise<ReturnType<Page["getByRole"]>> {
  const conversationList = page.getByRole("complementary", { name: "共享空间对话列表" });
  await conversationList.getByRole("button", { name: new RegExp(escapedRegExp(title)) }).click();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .click();
  const inspector = page.getByRole("complementary", { name: "对话右侧检查器" });
  await expect(inspector).toBeVisible();
  const settingsTab = inspector.getByRole("radio", { name: "成员与设置", exact: true });
  if (await settingsTab.count()) await settingsTab.click();
  return inspector;
}

test.describe("Agent platform permissions and group-request acceptance", () => {
  test("saves the v2 owner-only/current-members policy on desktop and 390px, then approves and rejects group requests", async ({
    browser,
    baseURL,
  }, testInfo: TestInfo) => {
    test.setTimeout(120_000);
    const runId = `${Date.now()}-${testInfo.workerIndex}`;
    const groupTitle = `agent-platform-${runId}`;
    const memberLabel = `Agent 平台验收成员 ${runId}`;
    const targetName = `Agent target ${runId}`;
    const sourceName = `Agent source ${runId}`;
    const rejectedName = `Agent rejected ${runId}`;

    const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const memberContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    ownerContext.setDefaultTimeout(10000);
    memberContext.setDefaultTimeout(10000);
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      const inviteCode = await signInOwner(owner, baseURL!);
      await joinMember(member, baseURL!, inviteCode, memberLabel);
      const groupId = await createGroup(owner, groupTitle, memberLabel);

      const targetConfigId = await createSyntheticBot(member, targetName);
      const sourceConfigId = await createSyntheticBot(member, sourceName);
      const rejectedConfigId = await createSyntheticBot(member, rejectedName);
      const target = await findOwnedBot(member, targetConfigId);
      const source = await findOwnedBot(member, sourceConfigId);
      const rejected = await findOwnedBot(member, rejectedConfigId);
      // The new two-sided request path requires an explicit V2 group audience;
      // seed the second synthetic Bot through the same narrow policy before
      // exercising the reject branch.
      await jsonRequest(
        member.request,
        "PATCH",
        `/api/workspace/bots/${encodeURIComponent(rejected.id)}/settings`,
        { accessPolicy: accessPolicyPreset, allowGroup: true }
      );

      // The public mention identity and the persisted source-policy identity are
      // intentionally different. The latter must never be inferred from the former.
      const memberBootstrap = await bootstrap(member);
      const bootstrapMembers = arrayOfRecords(memberBootstrap.members, "member bootstrap members");
      const sourceMember = bootstrapMembers.find((candidate) => candidate.id === source.botUserId);
      expect(sourceMember, "source Bot is visible to its owner").toBeDefined();
      expect(sourceMember?.botId, "source Bot exposes its configured id to its owner").toBe(source.id);
      expect(sourceMember?.id, "mention identity remains the public user id").toBe(source.botUserId);
      expect(sourceMember?.id).not.toBe(source.id);

      await member.reload();
      await member.getByRole("button", { name: "机器人与集成" }).click();
      const settings = member.getByRole("dialog", { name: "设置", exact: true });
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "机器人", exact: true }).click();
      await expect(settings.getByRole("button", { name: target.name, exact: true })).toBeVisible();
      await settings.getByRole("button", { name: target.name, exact: true }).click();
      await settings.getByRole("tab", { name: "权限与会话", exact: true }).click();

      const policy = settings.getByTestId("bot-access-policy");
      await expect(policy).toBeVisible();
      await expect(policy.getByRole("button", { name: /启用“私有助手，指定群共享”/ })).toBeVisible();

      const policyPatchPromise = waitForPatchBody(member, `/api/workspace/bots/${target.id}/settings`);
      await policy.getByRole("button", { name: /启用“私有助手，指定群共享”/ }).click();
      const policyPatch = await policyPatchPromise;
      expect(policyPatch).toEqual({ accessPolicy: accessPolicyPreset });
      await expect(policy).toContainText("仅创建者可私聊");
      await expect(policy).toContainText("已批准群内当前成员可使用");

      const savedSettings = await jsonRequest(
        member.request,
        "GET",
        `/api/workspace/bots/${encodeURIComponent(target.id)}/settings`
      );
      const savedPolicy = asRecord(
        asRecord(savedSettings.settings, "saved Bot settings").accessPolicy,
        "saved access policy"
      );
      expect(savedPolicy.version).toBe(2);
      expect(asRecord(savedPolicy.discovery, "saved discovery policy").audience).toBe("owner_only");
      expect(asRecord(savedPolicy.direct, "saved direct policy").audience).toBe("owner_only");
      const savedGroups = asRecord(savedPolicy.groups, "saved group policy");
      expect(savedGroups.audience).toBe("current_members");
      expect(savedGroups.allowBotTriggers).toBe(false);
      // The Go projection omits empty arrays in JSON; absence is equivalent to
      // an empty allowlist and must not be interpreted as a broader audience.
      expect(savedGroups.allowedBotIds ?? []).toEqual([]);

      const triggerSwitch = policy.getByRole("switch", { name: "允许其他 Bot 触发" });
      await expect(triggerSwitch).toHaveAttribute("aria-checked", "false");
      await triggerSwitch.click();
      const sourceButton = policy.getByRole("button", { name: `${source.name}：未允许`, exact: true });
      await expect(sourceButton).toBeVisible();
      const sourcePatchPromise = waitForPatchBody(member, `/api/workspace/bots/${target.id}/settings`);
      await sourceButton.click();
      const sourcePatch = await sourcePatchPromise;
      const sourcePolicy = asRecord(sourcePatch.accessPolicy, "Bot source policy");
      const sourceGroups = asRecord(sourcePolicy.groups, "Bot source groups policy");
      expect(sourceGroups.allowedBotIds).toEqual([source.id]);
      expect(sourceGroups.allowedBotIds).not.toContain(source.botUserId);
      await expect(policy.getByRole("button", { name: `${source.name}：已允许`, exact: true })).toHaveAttribute("aria-pressed", "true");
      const persistedSources = await jsonRequest(member.request, "GET", `/api/workspace/bots/${target.id}/settings`);
      expect(asRecord(asRecord(persistedSources.settings, "persisted source settings").accessPolicy, "persisted source policy").groups).toMatchObject({ allowedBotIds: [source.id] });

      await member.screenshot({ path: testInfo.outputPath("agent-platform-permissions-desktop.png") });
      await member.setViewportSize({ width: 390, height: 844 });
      await expect(policy).toBeVisible();
      await assertNoHorizontalOverflow(member, "390px Bot permission settings");
      await member.screenshot({ path: testInfo.outputPath("agent-platform-permissions-390.png") });
      await member.keyboard.press("Escape");
      await expect(settings).toBeHidden();

      // B can submit the owner-side request, but the ordinary member never gets
      // a management projection for the pending request.
      const currentTargetSettings = await jsonRequest(member.request, "GET", `/api/workspace/bots/${target.id}/settings`);
      await jsonRequest(member.request, "PATCH", `/api/workspace/bots/${target.id}/settings`, {
        accessPolicy: asRecord(currentTargetSettings.settings, "current target settings").accessPolicy,
        allowGroup: true,
      });
      const pendingTarget = await jsonRequest(
        member.request,
        "PATCH",
        `/api/workspace/bots/${target.id}/group-policies/${groupId}`,
        { status: "active", allowTrigger: true, allowContext: false, maxMessages: 20 }
      );
      expect(asRecord(pendingTarget.policy, "target pending policy").status).toBe("pending");
      const memberRequests = await jsonRequest(
        member.request,
        "GET",
        `/api/v1/conversations/${groupId}/bot-requests`
      );
      expect(memberRequests.canManage).toBe(false);
      expect(memberRequests.requests).toEqual([]);

      await owner.reload();
      const ownerInspector = await openGroupInspector(owner, groupTitle);
      const requests = ownerInspector.getByTestId("group-bot-requests");
      await expect(requests).toBeVisible();
      await expect(requests).toContainText(target.name);
      await expect(requests).toContainText("仅读取触发消息");
      await expect(requests).toContainText("不会授予机器人私聊权限");

      const approvePatchPromise = waitForPatchBody(owner, `/api/workspace/bots/${target.id}/group-policies/${groupId}`);
      await requests.getByRole("button", { name: "批准", exact: true }).click();
      const approvePatch = await approvePatchPromise;
      expect(approvePatch).toEqual({ status: "active" });
      await expect(requests).toContainText(`已批准「${target.name}」加入当前群聊`);

      const ownerAfterApproval = await bootstrap(owner);
      const approvedConversation = arrayOfRecords(ownerAfterApproval.conversations, "owner conversations").find(
        (conversation) => conversation.id === groupId
      );
      expect(approvedConversation?.memberIds).toContain(target.botUserId);
      const forbiddenDirect = await owner.request.post("/api/workspace/conversations", { data: { type: "direct", targetUserId: target.botUserId } });
      expect(forbiddenDirect.status()).toBe(400);
      expect(await forbiddenDirect.json()).toMatchObject({ error: { code: "conversation.invalid_target" } });

      // The approved private Bot is available as a group mention even though its
      // directory and direct-chat audience remain owner-only.
      await ownerInspector.getByRole("button", { name: "关闭检查器" }).click().catch(() => undefined);
      await owner
        .getByRole("complementary", { name: "共享空间对话列表" })
        .getByRole("button", { name: new RegExp(escapedRegExp(groupTitle)) })
        .click();
      const composer = owner.getByRole("combobox", { name: `发送消息到 ${groupTitle}`, exact: true });
      await composer.fill("@");
      const mentionDialog = owner.getByRole("listbox", { name: "选择要提及的成员", exact: true });
      await expect(mentionDialog).toBeVisible();
      await expect(mentionDialog.getByRole("option", { name: new RegExp(escapedRegExp(target.name)) })).toBeVisible();
      await owner.keyboard.press("Escape");

      const pendingRejected = await jsonRequest(
        member.request,
        "PATCH",
        `/api/workspace/bots/${rejected.id}/group-policies/${groupId}`,
        { status: "active", allowTrigger: true, allowContext: false, maxMessages: 20 }
      );
      expect(asRecord(pendingRejected.policy, "rejected pending policy").status).toBe("pending");

      await owner.reload();
      const rejectInspector = await openGroupInspector(owner, groupTitle);
      const rejectRequests = rejectInspector.getByTestId("group-bot-requests");
      await expect(rejectRequests).toBeVisible();
      await expect(rejectRequests).toContainText(rejected.name);
      const rejectPatchPromise = waitForPatchBody(owner, `/api/workspace/bots/${rejected.id}/group-policies/${groupId}`);
      await rejectRequests.getByRole("button", { name: "拒绝", exact: true }).click();
      const rejectPatch = await rejectPatchPromise;
      expect(rejectPatch).toEqual({ status: "rejected" });
      await expect(rejectRequests).toContainText(`已拒绝「${rejected.name}」的入群请求`);

      const ownerAfterReject = await bootstrap(owner);
      const rejectedConversation = arrayOfRecords(ownerAfterReject.conversations, "owner conversations after reject").find(
        (conversation) => conversation.id === groupId
      );
      expect(rejectedConversation?.memberIds).not.toContain(rejected.botUserId);
    } finally {
      await Promise.all([ownerContext.close(), memberContext.close()]);
    }
  });
});

test("real SDK task HTTP roundtrip reads history, publishes mixed files, edits with CAS and rejects cancelled authority", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const runId = randomUUID();
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  ownerContext.setDefaultTimeout(10_000);
  const owner = await ownerContext.newPage();
  let client: DualLaneAgentClient | undefined;
  let scoped: AgentTaskClient | undefined;
  let botId: string | undefined;
  let tokenId: string | undefined;
  // Setup/human messages use the Session API. Bot business operations use the
  // real SDK; explicit raw requests below only prove the version gate rejects.
  const human = async (method: "GET" | "POST" | "PATCH", pathname: string, data?: JsonRecord): Promise<JsonRecord> => {
    const response = await owner.request.fetch(new URL(pathname, baseURL!).href, { method, ...(data ? { data } : {}), timeout: 10_000 });
    expect(response.ok(), `${method} ${pathname}: ${response.status()}`).toBeTruthy();
    return asRecord(await response.json(), "synthetic human response");
  };
  try {
    await signInOwner(owner, baseURL!);
    const boot = await human("GET", "/api/v1/bootstrap");
    const ownerMember = asRecord(asRecord(boot.auth, "owner auth").currentUser, "owner identity");
    const ownerId = requiredString(ownerMember.id, "owner user id");
    const created = await human("POST", "/api/v1/bots", { name: `SDK acceptance ${runId}` });
    botId = requiredString(created.botId, "created Bot id");
    const owned = await human("GET", "/api/workspace/bots");
    const bot = arrayOfRecords(owned.bots, "owned Bots").find((candidate) => candidate.id === botId);
    if (!bot) throw new Error("synthetic Bot is missing");
    const botUserId = requiredString(bot.botUserId, "Bot user id");
    await human("PATCH", `/api/workspace/bots/${botId}/settings`, {
      accessPolicy: { ...accessPolicyPreset, groups: { ...accessPolicyPreset.groups, audience: "owner_only" } },
      allowDirect: true, allowGroup: false, maxContextMessages: 20, maxContextChars: 20_000,
      includeAttachmentMetadata: true, allowAttachmentPreview: true,
    });
    const direct = await human("POST", "/api/workspace/conversations", { type: "direct", targetUserId: botUserId });
    const conversationId = requiredString(asRecord(direct.conversation ?? direct, "Bot direct conversation").id, "Bot conversation id");
    await human("PATCH", `/api/workspace/bots/${botId}/context-grants/${conversationId}`, { allowTrigger: true, allowContext: true, maxMessages: 20 });
    const issued = await human("POST", `/api/workspace/bots/${botId}/tokens`, {
      scopes: ["messages:read_trigger", "messages:read_context", "messages:send", "files:read_metadata", "files:read_content", "files:write", "cards:write"],
    });
    // Never attach the token response, log credentials or persist a profile.
    tokenId = requiredString(asRecord(issued.tokenRecord, "issued token record").id, "issued token id");
    const credential = requiredString(issued.token, "issued Bot credential");
    for (const version of [undefined, "1.1.3", "1.2.0", "1.2.1", "invalid", "1.2.0-beta.1", "2.0.0"]) {
      const response = await fetch(new URL("/api/bot-gateway/v1/me", baseURL!), {
        headers: { authorization: `Bearer ${credential}`, ...(version === undefined ? {} : { "X-DualLane-SDK-Version": version }) },
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      expect(response.status, `SDK declaration ${version ?? "missing"} must be rejected`).toBe(426);
      const error = asRecord(asRecord(await response.json(), "upgrade response").error, "upgrade requirement");
      expect(error.code).toBe("sdk.upgrade_required");
      expect(error.minimumSdkVersion).toBe("1.2.2"); expect(error.latestSdkVersion).toBe("1.2.2");
      expect(error.runtimeManifestUrl).toBe("/integrations/duallane-agent.manifest.json");
      expect(error.docsUrl).toBe("/integrations/v2/duallane-channel.md"); expect(error.skillUrl).toBe("/integrations/duallane-agent/SKILL.md");
    }
    client = new DualLaneAgentClient({ url: baseURL!, token: credential, requestTimeoutMs: 10_000 });
    expect(asRecord((await client.getMe()).bot, "current SDK Bot identity").id).toBe(botId);
    const capabilities = await client.getCapabilities(conversationId);
    expect(capabilities.taskRequired).toBe(true);
    expect(asRecord(capabilities.features, "server features").taskAuthorization).toBe(true);
    await assert.rejects(client.sendMessage({ conversationId, text: "must require task", clientMessageId: `unscoped-${runId}` }),
      (error: unknown) => asRecord(error, "unscoped error").code === "task.authorization_required");

    const historyText = `sdk-history-${runId}`;
    const postHuman = (text: string, key: string) => human("POST", "/api/workspace/messages", {
      conversationId, clientMessageId: `${key}-${runId}`, content: buildMessageContent([messageText(text)]),
    });
    const history = await postHuman(historyText, "history");
    const historyId = requiredString(asRecord(history.message ?? history, "historical message").id, "historical message id");
    const triggerText = `sdk-trigger-${runId}`;
    const sentTrigger = await postHuman(triggerText, "trigger");
    const triggerId = requiredString(asRecord(sentTrigger.message ?? sentTrigger, "trigger message").id, "trigger message id");
    let delivered: AgentEvent | undefined;
    let afterSequence = 0;
    await expect.poll(async () => {
      const update = await client!.getUpdates({ afterSequence, limit: 50, timeoutMs: 10_000 });
      delivered = update.events.find((event) => event.type === "message.created" && event.conversationId === conversationId && event.payload.messageId === triggerId);
      for (const event of update.events) afterSequence = Math.max(afterSequence, event.sequence);
      return Boolean(delivered);
    }, { timeout: 10_000, message: "real SDK receives the precise human trigger", intervals: [100, 250, 500] }).toBe(true);
    if (!delivered) throw new Error("trigger delivery missing");
    const activation = await client.createTask({ eventId: delivered.eventId });
    expect(activation.task.conversationId).toBe(conversationId);
    expect(activation.task.triggerMessageId).toBe(triggerId);
    scoped = client.forTask(activation.task, { timeoutMs: 60_000 });
    const exact = await scoped.getMessage(triggerId);
    expect(exact.message.plainText).toBe(triggerText);
    const page = await scoped.searchMessages(conversationId, { query: historyText, limit: 5 });
    expect(page.messages.map((message) => message.id)).toContain(historyId);
    expect(page.coverage).toHaveProperty("since");
    expect(typeof page.hasMore).toBe("boolean");
    const members = await scoped.listMembers(conversationId);
    expect(members.members.map((member) => member.id)).toEqual(expect.arrayContaining([ownerId, botUserId]));

    const bytes = Buffer.from(`synthetic attachment ${runId}\n`, "utf8");
    const reservation = await scoped.reserveUpload({ conversationId, fileName: `sdk-${runId}.txt`, mimeType: "text/plain", byteSize: bytes.length });
    const uploadId = requiredString(reservation.upload.id, "reserved upload id");
    const completed = await scoped.completeUploadContent(uploadId, bytes, "text/plain");
    const attachmentId = requiredString(completed.attachment?.id, "completed attachment id");
    const content = buildMessageContent([messageText("SDK 首发 "), messageMention(ownerId, "验收创建者"), messageAttachment(attachmentId)]);
    const published = await scoped.sendMessage({ conversationId, content, clientMessageId: `mixed-${runId}`, idempotencyKey: `mixed-${runId}` });
    const messageId = requiredString(published.message.id, "mixed message id");
    const beforeEdit = await scoped.getMessage(messageId);
    const version = requiredString(beforeEdit.message.version, "message CAS version");
    expect(arrayOfRecords(asRecord(beforeEdit.message.content, "mixed content").blocks, "mixed blocks").map((block) => block.type)).toEqual(["text", "mention", "attachment"]);
    const replacement = buildMessageContent([messageText("SDK 已修订 "), messageMention(ownerId, "验收创建者"), messageAttachment(attachmentId)]);
    const edited = await scoped.editMessage(messageId, { content: replacement, expectedVersion: version });
    expect(edited.message.id).toBe(messageId);
    await assert.rejects(scoped.editMessage(messageId, { plainText: "stale overwrite must fail", expectedVersion: version }),
      (error: unknown) => asRecord(error, "CAS error").statusCode === 409);
    const afterEdit = await scoped.getMessage(messageId);
    expect(afterEdit.message.version).not.toBe(version);
    // Display labels are canonicalized from current membership by Go. The
    // stable mention/resource identities and full block set must survive CAS.
    const editedBlocks = arrayOfRecords(asRecord(afterEdit.message.content, "edited content").blocks, "edited blocks");
    expect(editedBlocks).toHaveLength(3);
    expect(editedBlocks).toMatchObject([{ type: "text", text: "SDK 已修订 " }, { type: "mention", userId: ownerId }, { type: "attachment", attachmentId }]);
    const readBack = await scoped.readAttachment({ conversationId, messageId, attachmentId, mode: "content", maxBytes: bytes.length });
    expect(Buffer.from(readBack.bytes).equals(bytes)).toBe(true);
    const receipt = await scoped.getOperation("message.send", `mixed-${runId}`);
    expect(receipt.status).toBe("committed");
    if (receipt.status !== "committed") throw new Error("publication receipt missing");
    expect(receipt.humanRead).toBe(false);
    expect(asRecord(receipt.result.message, "committed message").id).toBe(messageId);
    const editKey = requiredString(edited.operation?.key, "edit operation key");
    expect((await scoped.getOperation("message.edit", editKey)).status).toBe("committed");

    const taskFeatures = asRecord((await scoped.getCapabilities()).features, "task features");
    if (taskFeatures.taskCardUpdate === true) {
      const card = await scoped.sendFeishuCard({ conversationId, clientMessageId: `card-${runId}`, idempotencyKey: `card-${runId}`,
        card: { header: { title: { tag: "plain_text", content: "SDK 验收卡片" } }, elements: [{ tag: "markdown", content: "初始状态" }] } });
      const record = asRecord(card.card, "created card");
      const cardId = requiredString(record.id, "created card id");
      const revised = await scoped.updateFeishuCard(cardId, { expectedRevision: Number(record.revision),
        card: { header: { title: { tag: "plain_text", content: "SDK 验收卡片" } }, elements: [{ tag: "markdown", content: "已更新" }] } });
      expect(asRecord(revised.card, "updated card").revision).toBe(Number(record.revision) + 1);
      expect((await scoped.getOperation("card.update", requiredString(asRecord(revised.operation, "card operation").key, "card operation key"))).status).toBe("committed");
    }
    expect((await client.cancelAgentTask(activation.task.id)).cancelled).toBe(true);
    await assert.rejects(scoped.getMessage(triggerId), (error: unknown) => asRecord(error, "cancelled task error").code === "task.invalidated");
    await assert.rejects(scoped.sendMessage({ conversationId, text: "cancelled publish must fail", clientMessageId: `cancelled-${runId}` }),
      (error: unknown) => asRecord(error, "cancelled publish error").code === "task.invalidated");
  } finally {
    scoped?.close(); client?.stop();
    if (botId && tokenId) await owner.request.post(new URL(`/api/workspace/bots/${botId}/tokens/${tokenId}/revoke`, baseURL!).href, { timeout: 10_000 }).catch(() => undefined);
    await ownerContext.close();
  }
});

test("real SDK interactive Feishu cards render in Timeline, acknowledge actions and preserve CAS, unknown outcomes and membership", async ({ browser, baseURL }, testInfo: TestInfo) => {
  test.setTimeout(180_000);
  const runId = randomUUID();
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  ownerContext.setDefaultTimeout(10_000);
  memberContext.setDefaultTimeout(10_000);
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  const groupTitle = `SDK card group ${runId}`;
  const memberLabel = `SDK card member ${runId}`;
  let client: DualLaneAgentClient | undefined;
  let scoped: AgentTaskClient | undefined;
  let droppedClient: DualLaneAgentClient | undefined;
  let droppedScoped: AgentTaskClient | undefined;
  let botId: string | undefined;
  let tokenId: string | undefined;
  const human = async (method: "GET" | "POST" | "PATCH", pathname: string, data?: JsonRecord): Promise<JsonRecord> => {
    const response = await owner.request.fetch(new URL(pathname, baseURL!).href, {
      method,
      ...(data ? { data } : {}),
      timeout: 10_000,
    });
    expect(response.ok(), `${method} ${pathname}: ${response.status()}`).toBeTruthy();
    return asRecord(await response.json(), "synthetic human response");
  };
  try {
    const inviteCode = await signInOwner(owner, baseURL!);
    await joinMember(member, baseURL!, inviteCode, memberLabel);
    const memberBoot = await jsonRequest(member.request, "GET", "/api/workspace/bootstrap");
    const memberId = requiredString(asRecord(asRecord(memberBoot.auth, "card member auth").currentUser, "card member identity").id, "card member id");
    const boot = await human("GET", "/api/v1/bootstrap");
    const ownerMember = asRecord(asRecord(boot.auth, "owner auth").currentUser, "owner identity");
    const ownerId = requiredString(ownerMember.id, "owner user id");
    const created = await human("POST", "/api/v1/bots", { name: `SDK card acceptance ${runId}` });
    botId = requiredString(created.botId, "created Bot id");
    const owned = await human("GET", "/api/workspace/bots");
    const bot = arrayOfRecords(owned.bots, "owned Bots").find((candidate) => candidate.id === botId);
    if (!bot) throw new Error("synthetic card Bot is missing");
    const botUserId = requiredString(bot.botUserId, "Bot user id");
    await human("PATCH", `/api/workspace/bots/${encodeURIComponent(botId)}/settings`, {
      accessPolicy: accessPolicyPreset,
      allowDirect: true,
      allowGroup: true,
      maxContextMessages: 20,
      maxContextChars: 20_000,
      includeAttachmentMetadata: true,
      allowAttachmentPreview: true,
    });
    const group = await human("POST", "/api/v1/conversations/groups", { title: groupTitle, memberIds: [memberId] });
    const conversationId = requiredString(asRecord(group.conversation ?? group, "card group conversation").id, "card group id");
    const joinedBot = await human("PATCH", `/api/workspace/bots/${encodeURIComponent(botId)}/group-policies/${encodeURIComponent(conversationId)}`, {
      status: "active", allowTrigger: true, allowContext: true, maxMessages: 20,
    });
    expect(asRecord(joinedBot.policy, "card Bot group admission").status).toBe("active");
    const issued = await human("POST", `/api/workspace/bots/${encodeURIComponent(botId)}/tokens`, {
      scopes: ["messages:read_trigger", "messages:read_context", "messages:send", "cards:write", "cards:act"],
    });
    tokenId = requiredString(asRecord(issued.tokenRecord, "issued token record").id, "issued token id");
    const credential = requiredString(issued.token, "issued Bot credential");

    client = new DualLaneAgentClient({ url: baseURL!, token: credential, requestTimeoutMs: 10_000 });
    expect(asRecord((await client.getMe()).bot, "current SDK Bot identity").id).toBe(botId);
    const triggerText = `sdk-card-trigger-${runId}`;
    const trigger = await human("POST", "/api/workspace/messages", {
      conversationId,
      clientMessageId: `card-trigger-${runId}`,
      content: buildMessageContent([messageMention(botUserId, requiredString(bot.name, "card Bot name")), messageText(` ${triggerText}`)]),
    });
    const triggerId = requiredString(asRecord(trigger.message ?? trigger, "trigger message").id, "trigger message id");
    let delivered: AgentEvent | undefined;
    let afterSequence = 0;
    await expect.poll(async () => {
      const update = await client!.getUpdates({ afterSequence, limit: 50, timeoutMs: 10_000 });
      delivered = update.events.find((event) => event.type === "message.created" && event.conversationId === conversationId && event.payload.messageId === triggerId);
      for (const event of update.events) afterSequence = Math.max(afterSequence, event.sequence);
      return Boolean(delivered);
    }, { timeout: 15_000, message: "real SDK receives the synthetic card trigger", intervals: [100, 250, 500] }).toBe(true);
    if (!delivered) throw new Error("card trigger delivery missing");
    const activation = await client.createTask({ eventId: delivered.eventId });
    scoped = client.forTask(activation.task, { timeoutMs: 150_000 });
    const capabilities = await scoped.getCapabilities();
    expect(asRecord(capabilities.features, "card capabilities").taskCardUpdate).toBe(true);

    const initialInput = {
      title: `合成交互卡片 ${runId}`,
      markdown: "请选择一个合成操作",
      tone: "blue",
      buttons: [
        { actionId: "confirm", label: "确认", style: "primary", value: { decision: "approve", runId, action: "business-only", action_id: "business-id" } },
        { actionId: "cancel", label: "取消", style: "danger" },
      ],
    } as const;
    const initialCard = buildAgentInteractiveCard(initialInput);
    const initialElements = arrayOfRecords((initialCard as JsonRecord).elements, "interactive card elements");
    const actionElement = initialElements.find((element) => element.tag === "action");
    if (!actionElement) throw new Error("interactive card action element missing");
    const actionButtons = arrayOfRecords(actionElement.actions, "interactive card buttons");
    expect(actionButtons).toHaveLength(2);
    expect(actionButtons[0].value).toEqual({ action_id: "confirm", data: initialInput.buttons[0].value });
    expect(actionButtons[1].value).toEqual({ action_id: "cancel" });

    const sent = await scoped.sendFeishuCard({
      conversationId,
      clientMessageId: `interactive-card-${runId}`,
      idempotencyKey: `interactive-card-${runId}`,
      fallbackText: `交互卡片 ${runId}`,
      card: initialCard,
    });
    const sentCard = asRecord(sent.card, "sent interactive card");
    const cardId = requiredString(sentCard.id, "interactive card id");
    expect(Number(sentCard.revision)).toBe(1);
    const storedButtons = (card: JsonRecord): JsonRecord[] => {
      const elements = arrayOfRecords(asRecord(card.payload, "stored card payload").elements, "stored card elements");
      const actions = elements.find((element) => element.type === "actions");
      if (!actions) throw new Error("stored card actions missing");
      return arrayOfRecords(actions.buttons, "stored card buttons");
    };
    expect(storedButtons(sentCard)).toMatchObject([
      { actionId: "confirm", data: initialInput.buttons[0].value },
      { actionId: "cancel", data: {} },
    ]);
    const sentMessage = asRecord(sent.message, "sent interactive card message");
    const sentMessageId = requiredString(sentMessage.id, "sent card message id");

    const cardPath = `/api/workspace/cards/${encodeURIComponent(cardId)}`;
    const actionPath = `${cardPath}/actions`;
    const renderedCard = (page: Page) => page.getByRole("region", { name: "助手交互卡片", exact: true })
      .and(page.locator(`[data-card-id="${cardId}"]`));
    const openCardConversation = async (page: Page) => {
      await page.reload();
      await expect(page.getByRole("main", { name: "DualLane 工作台", exact: true })).toBeVisible();
      const returnToList = page.getByRole("button", { name: "返回对话列表", exact: true });
      if (await returnToList.isVisible()) await returnToList.click();
      await page.getByRole("complementary", { name: "共享空间对话列表" })
        .getByRole("button", { name: new RegExp(escapedRegExp(groupTitle)) }).click();
      await expect(renderedCard(page)).toBeVisible();
    };
    const clickCardAction = async (page: Page, label: string, actionId: string, revision: number, actorId: string, savedData: JsonRecord): Promise<string> => {
      const card = renderedCard(page);
      const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" &&
        new URL(response.url()).pathname === actionPath);
      await card.getByRole("button", { name: label, exact: true }).click();
      const response = await responsePromise;
      expect(response.status(), `actual Timeline ${actionId} action`).toBe(200);
      const request = asRecord(response.request().postDataJSON(), "Timeline card action request");
      const clientActionId = requiredString(request.clientActionId, "Timeline client action id");
      expect(clientActionId).toMatch(/^act_[a-f0-9-]{36}$/u);
      // Business data remains server-owned; the real renderer sends no data or
      // arbitrary button payload as action input.
      expect(request).toEqual({ actionId, clientActionId, expectedRevision: revision, input: {} });
      const receipt = asRecord(asRecord(await response.json(), "Timeline action response").action, "Timeline action receipt");
      expect(receipt).toMatchObject({ ok: true, replayed: false, revision, result: { accepted: true, actionId } });
      await expect(card).toContainText("操作已提交，等待助手更新");
      await expect(card.getByRole("button", { name: label, exact: true })).toBeDisabled();
      // Exercise the server's same-operation replay without inventing another
      // key. This is synthetic test traffic, never a replay of a real task.
      const replayResponse = await page.request.post(actionPath, { data: request });
      expect(replayResponse.status()).toBe(200);
      expect(asRecord(asRecord(await replayResponse.json(), "replayed action response").action, "replayed action receipt"))
        .toMatchObject({ ok: true, replayed: true, revision });
      let callback: AgentEvent | undefined;
      await expect.poll(async () => {
        const updates = await client!.getUpdates({ afterSequence, limit: 50, timeoutMs: 10_000 });
        callback = updates.events.find((event) => event.type === "card.action" && event.payload.cardId === cardId &&
          event.payload.clientActionId === clientActionId);
        for (const event of updates.events) afterSequence = Math.max(afterSequence, event.sequence);
        return Boolean(callback);
      }, { timeout: 15_000, intervals: [100, 250, 500], message: `real SDK receives ${actionId} callback from Timeline` }).toBe(true);
      expect(callback?.payload).toMatchObject({ cardId, actionId, clientActionId, actorUserId: actorId, data: savedData });
      const afterAction = await jsonRequest(page.request, "GET", cardPath);
      expect(Number(asRecord(afterAction.card, "card after accepted action").revision)).toBe(revision);
      return clientActionId;
    };

    // Render the actual SDK/Go-created message through AppV1's conversation
    // loader, card-reference resolver and Timeline renderer (no fixture view).
    await openCardConversation(owner);
    await expect(renderedCard(owner)).toContainText(initialInput.title);
    await expect(renderedCard(owner)).toContainText(initialInput.markdown);
    await expect(renderedCard(owner).getByRole("button", { name: "确认", exact: true })).toBeEnabled();
    await expect(renderedCard(owner).getByRole("button", { name: "取消", exact: true })).toBeEnabled();
    await owner.screenshot({ path: testInfo.outputPath("sdk-card-timeline-desktop.png") });
    const confirmActionId = await clickCardAction(owner, "确认", "confirm", 1, ownerId, initialInput.buttons[0].value);

    const updatedInput = {
      title: `合成交互卡片 ${runId}`,
      markdown: "状态：已确认",
      tone: "green",
      buttons: [
        { actionId: "confirm", label: "再次确认", style: "primary", value: { decision: "confirm", runId } },
        { actionId: "cancel", label: "取消", style: "danger" },
      ],
    } as const;
    const updatedCard = buildAgentInteractiveCard(updatedInput);
    const revised = await scoped.updateFeishuCard(cardId, {
      expectedRevision: Number(sentCard.revision),
      fallbackText: `交互卡片已更新 ${runId}`,
      card: updatedCard,
    });
    const revisedCard = asRecord(revised.card, "updated interactive card");
    expect(revisedCard.id).toBe(cardId);
    expect(Number(revisedCard.revision)).toBe(2);
    expect(storedButtons(revisedCard)).toMatchObject([
      { actionId: "confirm", data: updatedInput.buttons[0].value },
      { actionId: "cancel", data: {} },
    ]);
    // A real card.updated frame invalidates the projection already mounted in
    // the owner's Timeline; revision 2 unlocks the acknowledged revision 1.
    await expect(renderedCard(owner)).toContainText(updatedInput.markdown);
    await expect(renderedCard(owner).getByRole("button", { name: "再次确认", exact: true })).toBeEnabled();
    await openCardConversation(member);
    await expect(renderedCard(member)).toContainText(updatedInput.markdown);
    await expect(renderedCard(member).getByRole("button", { name: "再次确认", exact: true })).toBeEnabled();
    await expect(renderedCard(member).getByRole("button", { name: "取消", exact: true })).toBeEnabled();
    await assertNoHorizontalOverflow(member, "390px actual SDK card Timeline");
    await member.screenshot({ path: testInfo.outputPath("sdk-card-timeline-390.png") });
    const cancelActionId = await clickCardAction(member, "取消", "cancel", 2, memberId, {});
    expect(cancelActionId).not.toBe(confirmActionId);
    const cardTools = createTaskToolServer(scoped);
    const toolUpdate = asRecord(await cardTools.callTool("duallane_update_card", {
      ...updatedInput, cardId, expectedRevision: 2, markdown: "状态：任务工具已确认",
    }, `interactive-update-${runId}`), "task-tool card update");
    const toolUpdatedCard = asRecord(toolUpdate.card, "task-tool updated card");
    const currentCardRevision = Number(toolUpdatedCard.revision);
    expect(currentCardRevision).toBe(3);
    expect(storedButtons(toolUpdatedCard)).toMatchObject([
      { actionId: "confirm", data: updatedInput.buttons[0].value },
      { actionId: "cancel", data: {} },
    ]);
    await expect(renderedCard(owner)).toContainText("状态：任务工具已确认");
    await expect(renderedCard(member)).toContainText("状态：任务工具已确认");
    await expect(renderedCard(member).getByRole("button", { name: "取消", exact: true })).toBeEnabled();

    let revisionError: { code?: unknown; statusCode?: unknown; attemptOutcome?: unknown; safeToRetry?: unknown } | undefined;
    await assert.rejects(
      scoped.updateFeishuCard(cardId, {
        expectedRevision: 99,
        fallbackText: `未来版本不应写入 ${runId}`,
        card: updatedCard,
      }),
      (error: unknown) => {
        revisionError = error as typeof revisionError;
        return true;
      }
    );
    expect(revisionError?.statusCode).toBe(409);
    expect(revisionError?.code).toBe("card.revision_conflict");
    expect(revisionError?.safeToRetry).toBe(false);
    const cardAfterRevisionReject = await jsonRequest(owner.request, "GET", `/api/workspace/cards/${encodeURIComponent(cardId)}`);
    expect(Number(asRecord(cardAfterRevisionReject.card, "card after revision rejection").revision)).toBe(currentCardRevision);

    // Task history is anchored before these outputs; observe new delivery as
    // the authorized human without widening the SDK's history window.
    const liveMessagesPath = `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`;
    const beforeMalformedHistory = await jsonRequest(owner.request, "GET", liveMessagesPath);
    const malformedFallback = `malformed-old-builder-${runId}`;
    const malformedKey = `malformed-card-${runId}`;
    const malformedCard = {
      header: { title: { tag: "plain_text", content: "旧构造器" }, template: "blue" },
      elements: [{ tag: "action", actions: [{
        tag: "button",
        text: { tag: "plain_text", content: "确认" },
        type: "primary",
        // This is the pre-contract shape. The strict converter must reject the
        // arbitrary value.action field and must not persist a partial card.
        value: { action: "confirm", runId },
      }] }],
    };
    let malformedError: { code?: unknown; statusCode?: unknown; attemptOutcome?: unknown; safeToRetry?: unknown; operation?: unknown } | undefined;
    await assert.rejects(
      scoped.sendCard({
        conversationId,
        clientMessageId: `${malformedKey}-message`,
        idempotencyKey: malformedKey,
        fallbackText: malformedFallback,
        format: "feishu-card",
        feishuCard: malformedCard,
      }),
      (error: unknown) => {
        malformedError = error as typeof malformedError;
        return true;
      }
    );
    expect(malformedError?.code).toBe("card.feishu_unknown_field");
    expect(malformedError?.statusCode).toBe(422);
    expect(malformedError?.safeToRetry).toBe(false);
    expect(malformedError?.attemptOutcome).toBe("rejected");
    const malformedOperation = await scoped.getOperation("card.send", malformedKey);
    expect(asRecord(malformedOperation, "malformed operation receipt").status).toBe("unknown");
    expect(asRecord(malformedOperation, "malformed operation receipt").safeToRetry).toBe(false);
    // This rejected attempt does not erase a prior committed use of its key.
    const committedKey = `interactive-card-${runId}`;
    await assert.rejects(scoped.sendFeishuCard({
      conversationId, clientMessageId: committedKey, idempotencyKey: committedKey, card: malformedCard,
    }), (error: unknown) => {
      const rejected = asRecord(error, "same-key validation rejection");
      expect(rejected.statusCode).toBe(422);
      expect(rejected.attemptOutcome).toBe("rejected");
      return true;
    });
    const previousCommit = asRecord(await scoped.getOperation("card.send", committedKey), "earlier committed operation");
    expect(previousCommit.status).toBe("committed");
    expect(asRecord(asRecord(previousCommit.result, "earlier result").card, "earlier card").id).toBe(cardId);
    const afterMalformedHistory = await jsonRequest(owner.request, "GET", liveMessagesPath);
    const malformedMessages = arrayOfRecords(afterMalformedHistory.messages, "history after malformed card").filter(
      (message) => message.plainText === malformedFallback
    );
    expect(malformedMessages).toEqual([]);
    expect(arrayOfRecords(afterMalformedHistory.messages, "messages after rejection").map((message) => message.id).sort())
      .toEqual(arrayOfRecords(beforeMalformedHistory.messages, "messages before rejection").map((message) => message.id).sort());
    const cardAfterMalformed = await jsonRequest(owner.request, "GET", `/api/workspace/cards/${encodeURIComponent(cardId)}`);
    expect(Number(asRecord(cardAfterMalformed.card, "card after malformed card").revision)).toBe(currentCardRevision);
    expect(arrayOfRecords(beforeMalformedHistory.messages, "history before malformed card").some((message) => message.id === sentMessageId)).toBe(true);

    let droppedPosts = 0;
    let dropped = false;
    const realFetch = globalThis.fetch.bind(globalThis);
    const dropResponseFetch: typeof fetch = async (input, init) => {
      const requestURL = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const isCardPost = String(init?.method ?? "GET").toUpperCase() === "POST" && new URL(requestURL).pathname === "/api/bot-gateway/v1/cards";
      if (isCardPost) droppedPosts += 1;
      const response = await realFetch(input, init);
      if (!dropped && isCardPost) {
        dropped = true;
        await response.arrayBuffer();
        throw new Error("synthetic response dropped after the Go server committed");
      }
      return response;
    };
    droppedClient = new DualLaneAgentClient({ url: baseURL!, token: credential, fetch: dropResponseFetch, requestTimeoutMs: 10_000 });
    droppedScoped = droppedClient.forTask(activation.task, { timeoutMs: 60_000 });
    const taskTools = createTaskToolServer(droppedScoped, { capabilities });
    const availableTools = await taskTools.getTools();
    expect(availableTools.map((tool) => tool.name)).toContain("duallane_send_card");
    expect(availableTools.map((tool) => tool.name)).toContain("duallane_query_operation");
    const droppedInput = {
      title: `未知回执卡片 ${runId}`,
      markdown: "服务端已处理但响应不可见",
      buttons: [{ actionId: "confirm", label: "确认", value: { synthetic: runId } }],
    };
    const droppedRPC = await taskTools.handleJsonRpc({
      jsonrpc: "2.0",
      id: "dropped-card-operation",
      method: "tools/call",
      params: { name: "duallane_send_card", arguments: droppedInput },
    });
    const droppedResult = asRecord(asRecord(droppedRPC, "dropped card tool response").result, "dropped card tool result");
    expect(droppedResult.isError).toBe(true);
    const droppedContent = arrayOfRecords(droppedResult.content, "dropped card tool content");
    const droppedEnvelope = asRecord(JSON.parse(requiredString(droppedContent[0].text, "dropped card tool error")), "dropped card tool envelope");
    const droppedError = asRecord(droppedEnvelope.error, "dropped card tool error details");
    expect(droppedError.code).toBe("network.unavailable");
    expect(droppedError.attemptOutcome).toBe("unknown");
    expect(droppedError.safeToRetry).toBe(false);
    const droppedOperation = asRecord(droppedError.operation, "dropped card operation reference");
    expect(droppedOperation.operation).toBe("card.send");
    const committed = await taskTools.callTool("duallane_query_operation", {
      operation: "card.send",
      key: requiredString(droppedOperation.key, "dropped card operation key"),
    });
    const committedRecord = asRecord(committed, "committed dropped card operation");
    expect(committedRecord.status).toBe("committed");
    expect(committedRecord.humanRead).toBe(false);
    const committedResult = asRecord(committedRecord.result, "committed dropped card result");
    const committedCard = asRecord(committedResult.card, "committed dropped card");
    const committedMessage = asRecord(committedResult.message, "committed dropped card message");
    const committedCardId = requiredString(committedCard.id, "committed dropped card id");
    const committedMessageId = requiredString(committedMessage.id, "committed dropped card message id");
    expect(Number(committedCard.revision)).toBe(1);
    const retryRPC = await taskTools.handleJsonRpc({
      jsonrpc: "2.0",
      id: "dropped-card-operation",
      method: "tools/call",
      params: { name: "duallane_send_card", arguments: droppedInput },
    });
    const retryResult = asRecord(asRecord(retryRPC, "repeated dropped card tool response").result, "repeated dropped card tool result");
    const retryContent = arrayOfRecords(retryResult.content, "repeated dropped card tool content");
    const retryEnvelope = asRecord(JSON.parse(requiredString(retryContent[0].text, "repeated dropped card tool error")), "repeated dropped card tool envelope");
    expect(asRecord(retryEnvelope.error, "repeated dropped card error").attemptOutcome).toBe("unknown");
    expect(droppedPosts).toBe(1);
    const committedHistory = await jsonRequest(owner.request, "GET", liveMessagesPath);
    const committedMessages = arrayOfRecords(committedHistory.messages, "history after dropped card");
    expect(committedMessages.filter((message) => message.id === committedMessageId)).toHaveLength(1);
    const committedCardRead = await jsonRequest(owner.request, "GET", `/api/workspace/cards/${encodeURIComponent(committedCardId)}`);
    expect(Number(asRecord(committedCardRead.card, "committed dropped card read").revision)).toBe(1);

    // Revoke actual group membership. The Go authorization boundary must deny
    // both projection and action; reload must remove the private message/card.
    const removal = await owner.request.delete(`/api/v1/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(memberId)}`);
    expect(removal.status()).toBe(200);
    const forbiddenProjection = await member.request.get(cardPath);
    expect(forbiddenProjection.status()).toBe(404);
    expect(await forbiddenProjection.json()).toMatchObject({ error: { code: "card.not_found" } });
    const forbiddenAction = await member.request.post(actionPath, { data: {
      actionId: "confirm", clientActionId: `act_${randomUUID()}`, expectedRevision: currentCardRevision, input: {},
    } });
    expect(forbiddenAction.status()).toBe(404);
    expect(await forbiddenAction.json()).toMatchObject({ error: { code: "card.not_found" } });
    await member.reload();
    await expect(member.getByRole("main", { name: "DualLane 工作台", exact: true })).toBeVisible();
    const returnToList = member.getByRole("button", { name: "返回对话列表", exact: true });
    if (await returnToList.isVisible()) await returnToList.click();
    await expect(member.getByRole("complementary", { name: "共享空间对话列表" })
      .getByRole("button", { name: new RegExp(escapedRegExp(groupTitle)) })).toHaveCount(0);
    await expect(renderedCard(member)).toHaveCount(0);
    const afterMembershipLoss = await jsonRequest(owner.request, "GET", cardPath);
    expect(Number(asRecord(afterMembershipLoss.card, "card after member removal").revision)).toBe(currentCardRevision);
  } finally {
    droppedScoped?.close(); droppedClient?.stop();
    scoped?.close(); client?.stop();
    if (botId && tokenId) await owner.request.post(new URL(`/api/workspace/bots/${encodeURIComponent(botId)}/tokens/${encodeURIComponent(tokenId)}/revoke`, baseURL!).href, { timeout: 10_000 }).catch(() => undefined);
    await memberContext.close();
    await ownerContext.close();
  }
});
