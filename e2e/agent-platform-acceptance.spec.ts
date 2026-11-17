import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { DualLaneAgentClient, buildMessageContent, messageText, messageMention, messageAttachment,
  type AgentEvent, type AgentTaskClient } from "../packages/agent-sdk/src/index.js";

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
  await expect(page.getByRole("heading", { name: "共享空间" })).toBeVisible();
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
    for (const version of [undefined, "1.1.3", "invalid", "1.2.0-beta.1", "2.0.0"]) {
      const response = await fetch(new URL("/api/bot-gateway/v1/me", baseURL!), {
        headers: { authorization: `Bearer ${credential}`, ...(version === undefined ? {} : { "X-DualLane-SDK-Version": version }) },
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      expect(response.status, `SDK declaration ${version ?? "missing"} must be rejected`).toBe(426);
      const error = asRecord(asRecord(await response.json(), "upgrade response").error, "upgrade requirement");
      expect(error.code).toBe("sdk.upgrade_required");
      expect(error.minimumSdkVersion).toBe("1.2.0"); expect(error.latestSdkVersion).toBe("1.2.0");
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
