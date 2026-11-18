import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DualLaneAgentClient, buildMessageContent, messageText, type AgentEvent, type AgentTaskClient } from "../packages/agent-sdk/src/index.js";
import { buildAgentInteractiveCard } from "../packages/agent-sdk/src/task-tools.js";
import { LiteWebSocket } from "../packages/agent-sdk/src/ws-lite.js";

type Json = Record<string, unknown>;
const mobileURL = "http://127.0.0.1:5196/assets/www/";
const nativeHeader = "X-DualLane-Native-Version-Code";
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected response object");
  return value as Json;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected nonempty identifier");
  return value;
}
type BridgeAction = { input: Json; status: number; body: Json };

// This adapter simulates only the Android host transport. App, Go auth, card
// storage/CAS, SDK task authorization and WebSocket frames are production code.
// It does not prove APK installation, JNI, Android permissions or native WebView.
async function attachHumanHost(page: Page, owner: BrowserContext, origin: string, nativeVersionCode = 10055) {
  const actions: BridgeAction[] = [];
  const requests: string[] = [];
  const installerCalls: Array<{ operation: string; url: string; sha256: string; version: string }> = [];
  const sockets = new Map<string, LiteWebSocket>();
  let socketOpened = false;
  const deliver = async (id: string, kind: string, payload: string) => {
    if (!page.isClosed()) await page.evaluate(({ id, kind, payload }) => {
      const host = window as unknown as { __duallaneOnWsEvent?: (id: string, kind: string, payload: string) => void };
      host.__duallaneOnWsEvent?.(id, kind, payload);
    }, { id, kind, payload }).catch(() => {});
  };
  await page.route("**/*", async (route) => {
    // No GitHub release fallback or other Internet traffic in this harness.
    if (new URL(route.request().url()).origin === new URL(mobileURL).origin) await route.continue();
    else await route.fulfill({ status: 404, body: "" });
  });
  await page.exposeBinding("__mobileHumanHTTP", async (_source, method: string, pathname: string, rawHeaders: string, body: string) => {
    if (!pathname.startsWith("/api/") || pathname.startsWith("/api/bot-gateway/") || pathname.includes("://")) {
      throw new Error("Host adapter accepts only human API paths");
    }
    const proposed = record(JSON.parse(rawHeaders || "{}"));
    requests.push(pathname);
    const headers: Record<string, string> = { [nativeHeader]: String(nativeVersionCode) };
    for (const [name, value] of Object.entries(proposed)) {
      if (["content-type", nativeHeader.toLowerCase()].includes(name.toLowerCase()) && typeof value === "string") headers[name] = value;
    }
    // The cookie remains in Playwright's Node-side human context. A snapshot's
    // authenticated:true is never accepted as server authentication.
    const response = await owner.request.fetch(new URL(pathname, origin).href, {
      method, headers, ...(body ? { data: body } : {}), maxRedirects: 0, timeout: 15_000,
    });
    const bodyText = await response.text();
    if (method === "POST" && /^\/api\/workspace\/cards\/[^/]+\/actions$/u.test(pathname)) {
      actions.push({ input: record(JSON.parse(body)), status: response.status(), body: record(JSON.parse(bodyText)) });
    }
    return { ok: response.ok(), status: response.status(), bodyText, headers: response.headers() };
  });
  await page.exposeBinding("__mobileHumanSocket", async (_source, operation: string, id: string, value: string) => {
    if (operation === "close") { sockets.get(id)?.close(); sockets.delete(id); return; }
    if (operation === "send") { if (sockets.get(id)?.readyState === 1) sockets.get(id)!.send(value); return; }
    if (value !== "/ws/workspace") throw new Error("Only the actual human workspace socket is allowed");
    const endpoint = new URL(value, origin); endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const cookie = (await owner.cookies(origin)).map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const socket = new LiteWebSocket(endpoint.href, { headers: { Cookie: cookie, Origin: new URL(origin).origin, [nativeHeader]: String(nativeVersionCode) } });
    sockets.set(id, socket);
    socket.on("open", () => { socketOpened = true; void deliver(id, "open", ""); });
    socket.on("message", (data: unknown) => { void deliver(id, "message", String(data)); });
    socket.on("close", () => { void deliver(id, "close", ""); });
    socket.on("error", () => { void deliver(id, "error", "workspace socket failed"); });
  });
  await page.exposeBinding("__mobileFakeInstaller", async (_source, operation: string, url: string, sha256: string, version: string) => {
    installerCalls.push({ operation, url, sha256, version });
    // Deliberately no Android action: these are adapter contract receipts.
    return { ok: true, status: operation === "download" ? "permission_requested" : "installer_started" };
  });
  await page.addInitScript(({ origin, nativeVersionCode }) => {
    type HostWindow = Window & {
      __mobileHumanHTTP: (method: string, path: string, headers: string, body: string) => Promise<unknown>;
      __mobileHumanSocket: (operation: string, id: string, value: string) => Promise<void>;
      __mobileFakeInstaller: (operation: string, url: string, sha256: string, version: string) => Promise<unknown>;
      __duallaneResolveCall?: (id: string, ok: boolean, payload: string) => void;
      DualLaneNative?: unknown;
    };
    const host = window as unknown as HostWindow;
    const noop = () => {};
    host.DualLaneNative = {
      getBootstrapInfo: () => JSON.stringify({ authenticated: true, apiOrigin: origin, appVersion: "1.1.0", nativeVersion: nativeVersionCode === 10055 ? "1.0.14" : "1.0.12", versionCode: nativeVersionCode, platform: "android", systemTheme: "light", otaActive: true }),
      httpRequest: (id: string, method: string, path: string, headers: string, body: string) => {
        void host.__mobileHumanHTTP(method, path, headers, body).then(
          (response) => host.__duallaneResolveCall?.(id, true, JSON.stringify(response)),
          () => host.__duallaneResolveCall?.(id, false, JSON.stringify({ message: "test host transport failed" })),
        );
      },
      wsConnect: (id: string, path: string) => { void host.__mobileHumanSocket("connect", id, path); },
      wsSend: (id: string, data: string) => { void host.__mobileHumanSocket("send", id, data); },
      wsClose: (id: string) => { void host.__mobileHumanSocket("close", id, ""); },
      downloadAndInstallApk: (id: string, url: string, sha256: string, version: string) => {
        void host.__mobileFakeInstaller("download", url, sha256, version).then((response) => host.__duallaneResolveCall?.(id, true, JSON.stringify(response)));
      },
      installPendingApk: (id: string) => {
        void host.__mobileFakeInstaller("resume", "", "", "").then((response) => host.__duallaneResolveCall?.(id, true, JSON.stringify(response)));
      },
      haptic: noop, shareText: noop, copyText: noop, syncSystemBars: noop, setCanGoBack: noop,
      syncNotificationContext: noop, clearConversationNotification: noop, prefetchMedia: noop, markBundleHealthy: noop,
      getBackgroundPushStatus: () => JSON.stringify({ keepAliveEnabled: false, notificationsGranted: true, ignoringBatteryOptimizations: true }),
    };
  }, { origin, nativeVersionCode });
  return { actions, requests, installerCalls, socketOpened: () => socketOpened, close: () => { for (const socket of sockets.values()) socket.close(); sockets.clear(); } };
}

test("actual mobile App consumes Go/SDK cards through a simulated authenticated native host", async ({ browser, baseURL }, testInfo) => {
  test.skip(!process.env.DUALLANE_MOBILE_E2E_ROOT, "Explicit optional mobile checkout required");
  test.setTimeout(180_000);
  const owner = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ownerPage = await owner.newPage();
  const page = await mobile.newPage();
  const runId = randomUUID();
  const botName = `Mobile SDK ${runId}`;
  let client: DualLaneAgentClient | undefined;
  let scoped: AgentTaskClient | undefined;
  let botId = "";
  let tokenId = "";
  let host: Awaited<ReturnType<typeof attachHumanHost>> | undefined;
  const human = async (method: string, pathname: string, data?: Json) => {
    const response = await owner.request.fetch(new URL(pathname, baseURL!).href, { method, ...(data ? { data } : {}) });
    expect(response.ok(), `${method} ${pathname} status=${response.status()}`).toBe(true);
    return record(await response.json());
  };
  try {
    await ownerPage.goto(`${baseURL}/`);
    await ownerPage.getByTestId("home-card-workspace").click();
    await ownerPage.getByRole("button", { name: "使用 GitHub 登录共享空间" }).click();
    await expect.poll(async () => (await owner.request.get(new URL("/api/workspace/bootstrap", baseURL!).href)).status()).toBe(200);
    const boot = await human("GET", "/api/workspace/bootstrap");
    const ownerId = text(record(record(boot.auth).currentUser).id);
    botId = text((await human("POST", "/api/v1/bots", { name: botName })).botId);
    const bots = (await human("GET", "/api/workspace/bots")).bots as Json[];
    const bot = bots.find((entry) => entry.id === botId);
    if (!bot) throw new Error("Synthetic mobile Bot is missing");
    await human("PATCH", `/api/workspace/bots/${botId}/settings`, {
      accessPolicy: { version: 2, discovery: { audience: "owner_only", memberIds: [] }, direct: { audience: "owner_only", memberIds: [] }, groups: { audience: "owner_only", memberIds: [], allowBotTriggers: false, allowedBotIds: [] } },
      allowDirect: true, allowGroup: false, maxContextMessages: 20, maxContextChars: 20_000,
    });
    const direct = await human("POST", "/api/workspace/conversations", { type: "direct", targetUserId: text(bot.botUserId) });
    const conversationId = text(record(direct.conversation ?? direct).id);
    await human("PATCH", `/api/workspace/bots/${botId}/context-grants/${conversationId}`, { allowTrigger: true, allowContext: true, maxMessages: 20 });
    const issued = await human("POST", `/api/workspace/bots/${botId}/tokens`, { scopes: ["messages:read_trigger", "messages:read_context", "messages:send", "cards:write", "cards:act"] });
    tokenId = text(record(issued.tokenRecord).id);
    // Only Node's SDK receives this credential; the mobile host is human-only.
    client = new DualLaneAgentClient({ url: baseURL!, token: text(issued.token), requestTimeoutMs: 10_000 });
    const trigger = await human("POST", "/api/workspace/messages", { conversationId, clientMessageId: `mobile-trigger-${runId}`, content: buildMessageContent([messageText(`mobile-card-${runId}`)]) });
    const triggerId = text(record(trigger.message ?? trigger).id);
    let sequence = 0;
    let event: AgentEvent | undefined;
    await expect.poll(async () => {
      const updates = await client!.getUpdates({ afterSequence: sequence, limit: 50, timeoutMs: 10_000 });
      event = updates.events.find((entry) => entry.type === "message.created" && entry.payload.messageId === triggerId);
      for (const entry of updates.events) sequence = Math.max(sequence, entry.sequence);
      return Boolean(event);
    }, { timeout: 15_000 }).toBe(true);
    if (!event) throw new Error("Mobile trigger not delivered");
    scoped = client.forTask((await client.createTask({ eventId: event.eventId })).task, { timeoutMs: 150_000 });
    const makeCard = (markdown: string) => buildAgentInteractiveCard({ title: "移动端真实链路卡片", markdown, tone: "blue", buttons: [
      { actionId: "confirm", label: "确认", style: "primary", value: { decision: "approve", runId } },
      { actionId: "cancel", label: "取消", style: "danger" },
    ] });
    const sent = await scoped.sendFeishuCard({ conversationId, clientMessageId: `mobile-card-${runId}`, idempotencyKey: `mobile-card-${runId}`, fallbackText: "移动端交互卡片", card: makeCard("请选择移动端操作") });
    const cardId = text(record(sent.card).id);
    host = await attachHumanHost(page, owner, baseURL!);
    await page.goto(mobileURL);
    await expect(page.getByRole("heading", { name: "消息", exact: true })).toBeVisible();
    await page.getByText(botName, { exact: true }).first().click();
    const card = page.getByRole("region", { name: "助手交互卡片", exact: true }).and(page.locator(`[data-card-id="${cardId}"]`));
    await expect(card).toContainText("请选择移动端操作");
    await expect.poll(() => host!.socketOpened(), { message: "actual Go workspace socket connected" }).toBe(true);
    const click = async (label: string, actionId: string, revision: number) => {
      const index = host!.actions.length;
      await card.getByRole("button", { name: label, exact: true }).click();
      await expect.poll(() => host!.actions.length).toBe(index + 1);
      const captured = host!.actions[index];
      expect(captured.status).toBe(200);
      expect(captured.input).toEqual({ actionId, clientActionId: expect.stringMatching(/^act_[a-f0-9-]{36}$/u), expectedRevision: revision, input: {} });
      expect(record(captured.body.action)).toMatchObject({ ok: true, replayed: false, revision, result: { accepted: true, actionId } });
      await expect(card).toContainText("操作已提交，等待助手更新");
      await expect(card.getByRole("button", { name: label, exact: true })).toBeDisabled();
      let callback: AgentEvent | undefined;
      await expect.poll(async () => {
        const updates = await client!.getUpdates({ afterSequence: sequence, limit: 50, timeoutMs: 10_000 });
        callback = updates.events.find((entry) => entry.type === "card.action" && entry.payload.clientActionId === captured.input.clientActionId);
        for (const entry of updates.events) sequence = Math.max(sequence, entry.sequence);
        return Boolean(callback);
      }, { timeout: 15_000 }).toBe(true);
      expect(callback?.payload).toMatchObject({ cardId, actionId, actorUserId: ownerId, data: actionId === "confirm" ? { decision: "approve", runId } : {} });
      expect(Number(record((await human("GET", `/api/workspace/cards/${cardId}`)).card).revision)).toBe(revision);
      return text(captured.input.clientActionId);
    };
    const firstKey = await click("确认", "confirm", 1);
    const revised = await scoped.updateFeishuCard(cardId, { expectedRevision: 1, card: makeCard("真实 Go 更新到第二版"), fallbackText: "已更新移动端卡片" });
    expect(record(revised.card).revision).toBe(2);
    // No page reload: a real card.updated frame must refresh the mounted App.
    await expect(card).toContainText("真实 Go 更新到第二版");
    await expect(card.getByRole("button", { name: "取消", exact: true })).toBeEnabled();
    expect(await click("取消", "cancel", 2)).not.toBe(firstKey);
    await page.screenshot({ path: testInfo.outputPath("actual-mobile-sdk-card-390.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Actual server auth loss, never a mocked 403. A newly rendered revision
    // rejects the stale human context once and never automatically replays it.
    await scoped.updateFeishuCard(cardId, { expectedRevision: 2, card: makeCard("请重新验证权限"), fallbackText: "权限验收卡片" });
    await expect(card).toContainText("请重新验证权限");
    await expect(card.getByRole("button", { name: "确认", exact: true })).toBeEnabled();
    const savedCookies = await owner.cookies();
    try {
      await owner.clearCookies();
      const index = host.actions.length;
      await card.getByRole("button", { name: "确认", exact: true }).click();
      await expect.poll(() => host!.actions.length).toBe(index + 1);
      expect(host.actions[index].status).toBe(401);
      await expect(card).toContainText("当前无法使用此卡片，请确认会话权限");
      await expect(card.getByRole("button", { name: "重试同一操作", exact: true })).toHaveCount(0);
      await page.waitForTimeout(1_000);
      expect(host.actions).toHaveLength(index + 1);
    } finally { await owner.addCookies(savedCookies); }
  } finally {
    host?.close();
    scoped?.close(); client?.stop();
    if (botId && tokenId) await owner.request.post(new URL(`/api/workspace/bots/${botId}/tokens/${tokenId}/revoke`, baseURL!).href).catch(() => {});
    await mobile.close(); await owner.close();
  }
});

test("actual Go APK policy forces an old host to update despite a newer OTA App", async ({ browser, baseURL }, testInfo) => {
  test.skip(!process.env.DUALLANE_MOBILE_E2E_ROOT || !process.env.DUALLANE_TEST_APK_PATH, "Explicit mobile checkout and public reference APK required");
  test.setTimeout(120_000);
  const owner = await browser.newContext({ baseURL });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ownerPage = await owner.newPage();
  const page = await mobile.newPage();
  let published = false;
  let host: Awaited<ReturnType<typeof attachHumanHost>> | undefined;
  const endpoint = (pathname: string) => new URL(pathname, baseURL!).href;
  const adminPath = "/api/v1/admin/mobile-release";
  const readRelease = async () => {
    const response = await owner.request.get(endpoint(adminPath));
    expect(response.status()).toBe(200);
    return record(record(await response.json()).release);
  };
  try {
    // Use only this explicit public build, never an arbitrary user APK.
    const apk = await readFile(process.env.DUALLANE_TEST_APK_PATH!);
    const sha256 = createHash("sha256").update(apk).digest("hex");
    expect(sha256).toBe("6934ddab736b6b0fd507d1a3e8721f2999ca83cadb480ee8ed8b42131c7d419e");
    await ownerPage.goto(`${baseURL}/`);
    await ownerPage.getByTestId("home-card-workspace").click();
    await ownerPage.getByRole("button", { name: "使用 GitHub 登录共享空间" }).click();
    await expect.poll(async () => (await owner.request.get(endpoint("/api/workspace/bootstrap"))).status()).toBe(200);
    const upload = await owner.request.put(endpoint(`${adminPath}/apk?version=1.0.14&versionCode=10055&minNativeVersionCode=10051`), {
      headers: { "Content-Type": "application/vnd.android.package-archive" }, data: apk, timeout: 45_000,
    });
    expect(upload.status(), "actual public signed APK accepted by Go").toBe(200);
    published = true;
    expect(record(record(await upload.json()).release)).toMatchObject({ apkVersion: "1.0.14", versionCode: 10055, sha256 });
    const metadata = { enabled: true, version: "1.0.14", versionCode: 10055, minimumSupportedNativeVersionCode: 10054, title: "合成强更验收", notes: "公开 APK，仅用于隔离验收" };
    const changed = await owner.request.put(endpoint(adminPath), { data: metadata });
    expect(changed.status()).toBe(200);
    const beforeRejectedEdits = await readRelease();
    expect(beforeRejectedEdits.minimumSupportedNativeVersionCode).toBe(10054);
    for (const data of [{ ...metadata, versionCode: 10100 }, { ...metadata, minimumSupportedNativeVersionCode: 10100 }]) {
      expect((await owner.request.put(endpoint(adminPath), { data })).status()).toBe(400);
      expect(await readRelease(), "rejected edit preserves release metadata").toEqual(beforeRejectedEdits);
    }
    const forgedUpload = await owner.request.put(endpoint(`${adminPath}/apk?version=1.1.0&versionCode=10100`), {
      headers: { "Content-Type": "application/vnd.android.package-archive" }, data: apk, timeout: 45_000,
    });
    expect(forgedUpload.status()).toBe(400);
    expect(await readRelease()).toEqual(beforeRejectedEdits);

    const oldHeaders = { [nativeHeader]: "10051" };
    const denied = await owner.request.get(endpoint("/api/v1/bootstrap"), { headers: oldHeaders });
    expect(denied.status()).toBe(426);
    expect(record(record(await denied.json()).error)).toMatchObject({ code: "mobile.native_upgrade_required", minimumSupportedNativeVersionCode: 10054, latestNativeVersionCode: 10055 });
    expect((await owner.request.get(endpoint("/api/v1/bootstrap"), { headers: { [nativeHeader]: "10055" } })).status()).toBe(200);
    // Missing native declaration remains compatible with ordinary web clients.
    expect((await owner.request.get(endpoint("/api/v1/bootstrap"))).status()).toBe(200);
    const policy = await owner.request.get(endpoint("/api/v1/mobile/native-policy"), { headers: oldHeaders });
    expect(policy.status()).toBe(200);
    const latest = await owner.request.get(endpoint("/api/v1/mobile/releases/latest"), { headers: oldHeaders });
    expect(latest.status()).toBe(200);
    const release = record(record(await latest.json()).release);
    expect(release).toMatchObject({ minimumSupportedNativeVersionCode: 10054, versionCode: 10055, apkVersion: "1.0.14", sha256 });
    const downloadURL = new URL(text(release.downloadUrl), baseURL!);
    expect(downloadURL.origin).toBe(new URL(baseURL!).origin);
    const downloaded = await owner.request.get(downloadURL.href, { headers: oldHeaders });
    expect(downloaded.status()).toBe(200);
    expect(createHash("sha256").update(await downloaded.body()).digest("hex")).toBe(sha256);

    host = await attachHumanHost(page, owner, baseURL!, 10051);
    await page.goto(mobileURL);
    const gate = page.getByTestId("required-native-update");
    await expect(gate).toBeVisible();
    await expect(gate).toContainText("安装新版后继续使用");
    await expect(page.getByRole("heading", { name: "消息", exact: true })).toHaveCount(0);
    expect(host.requests).not.toContain("/api/v1/bootstrap");
    expect(host.socketOpened()).toBe(false);
    await gate.getByRole("button", { name: "下载并安装更新", exact: true }).click();
    await expect.poll(() => host!.installerCalls.length).toBe(1);
    expect(host.installerCalls[0]).toEqual({ operation: "download", url: downloadURL.href, sha256, version: "1.0.14" });
    await gate.getByRole("button", { name: "继续安装更新", exact: true }).click();
    await expect.poll(() => host!.installerCalls.length).toBe(2);
    expect(host.installerCalls[1].operation).toBe("resume");
    // A fake installer receipt cannot lift the gate or pretend a native upgrade
    // happened. The immutable host metadata is still below the actual policy.
    await expect(gate).toBeVisible();
    await expect(page.getByRole("heading", { name: "消息", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("actual-go-old-host-forced-update-390.png") });
  } finally {
    host?.close();
    if (published) {
      const reset = await owner.request.put(endpoint(adminPath), { data: { enabled: true, minimumSupportedNativeVersionCode: 0 } });
      expect(reset.status(), "restore isolated policy for subsequent tests").toBe(200);
    }
    await mobile.close(); await owner.close();
  }
});
