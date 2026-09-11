import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Runs production App and routes with synthetic HTTP/WebSocket. Observation is
// confined to this Vite fixture; it does not replace state or domain handlers.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../../../../../.private-test-results/created-conversation-races/", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const probe = createPortProbe();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
assert(![5173, 5198, 5199].includes(port));
const server = await createServer({ root, cacheDir: "node_modules/.vite-created-conversation-races", server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false }, logLevel: "error", plugins: [{
  name: "observe-conversation-commit", enforce: "pre",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").endsWith("/src/App.tsx")) return;
    const marker = "  const workspacePrependScrollRef = useRef<{";
    assert(source.includes(marker), "Conversation commit observation point exists");
    return source.replace(marker, `  useEffect(() => {
      window.dispatchEvent(new CustomEvent("duallane-test:conversation-commit", { detail: {
        selectedId: workspaceSelectedConversationId,
        ids: workspaceConversations.map((conversation) => conversation.id),
        sessionEpoch: workspaceSessionEpochRef.current,
        accessEpoch: workspaceAccessEpochRef.current,
        userId: workspaceBootstrap?.auth.currentUser.id,
        canRead: workspaceCanReadConversationsRef.current,
        status: workspaceStatus
      } }));
    });
${marker}`);
  }
}] });
await server.listen();
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const now = "2026-09-11T08:00:00Z";
const members = ["创建者甲", "成员乙", "新会话身份"].map((displayName, i) => ({ id: `u${i + 1}`, githubLogin: `create-race-${i + 1}`, displayName, kind: "human", role: i === 1 ? "member" : "owner", joinedAt: now, capabilities: { canStartDirectConversation: true, canJoinGroups: true } }));
const conversation = (id, type = "group", title = "原有会话") => ({ id, spaceId: "s1", type, title, avatarEmoji: type === "group" ? "🧭" : null, retentionCount: 1000, createdAt: now, latestMessages: [], messageCount: 0, memberCount: 2, unreadCount: 0, notificationLevel: "all", members: members.slice(0, 2), capabilities: { canSendMessage: true, canUploadFile: true, canManageMembers: type === "group" } });
const results = { passed: [], errors: [], note: "Production App, synthetic identity/HTTP/WebSocket; no actual server creation or authorization proof." };
const snapshot = page => page.evaluate(() => window.conversationCommits.at(-1));
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function setup({ holdPost = false, postFailure = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => results.errors.push(error.message));
  await page.addInitScript(() => {
    window.conversationCommits = [];
    window.addEventListener("duallane-test:conversation-commit", event => window.conversationCommits.push(event.detail));
  });
  let actor = members[0], revoked = false, current = [conversation("c1")], nextHeldList = false, liveSocket, seq = 0;
  let releaseOldList, releasePost, oldListWaiting = false, postWaiting = false, oldListFinished = false, postFinished = false, listReads = 0;
  const releases = [];
  await page.routeWebSocket("**/ws/workspace", socket => {
    liveSocket = socket;
    socket.onMessage(() => socket.send(JSON.stringify({ version: 1, type: "ready", currentSeq: seq, replayCount: 0, hasMore: false })));
  });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    let data = { settings: {}, preferences: {}, collections: [], groups: [], emotes: [], topics: [], files: [], members, pins: [], messages: [], hasMore: false }, status = 200;
    if (path.endsWith("/bootstrap")) data = {
      auth: { mode: "github", inviteOnly: true, currentUser: actor }, space: { id: "s1", name: "创建竞态验收", slug: "create-race", createdBy: "u1", createdAt: now }, policy: { dailyQuotaBytes: 1000000, messageRetentionCount: 1000, memberVisibilityBasis: "direct_contacts" },
      permissions: { canCreateMemberInvite: !revoked, canManageMemberVisibility: !revoked, canReadConversations: !revoked, canCreateGroup: !revoked, canCreateDirect: !revoked, canUpload: !revoked, canDownload: !revoked }, members, conversations: current, files: [], invites: [], inviteSummary: {}, eventCursor: seq
    };
    else if (path.endsWith("/conversations") && method === "POST") {
      const request = route.request().postDataJSON();
      const created = conversation("created", request.type, request.title || "成员乙");
      current = [...current, created];
      data = { conversation: created }; status = 201;
      if (holdPost) {
        postWaiting = true;
        await new Promise(resolve => { releasePost = resolve; releases.push(resolve); });
        if (postFailure) { status = 503; data = { error: { code: "internal.error", message: "旧身份创建结果应忽略" } }; }
      }
    } else if (path.endsWith("/conversations")) {
      listReads++;
      data = { conversations: structuredClone(current) };
      if (nextHeldList) {
        nextHeldList = false; oldListWaiting = true;
        await new Promise(resolve => { releaseOldList = resolve; releases.push(resolve); });
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
        oldListFinished = true; return;
      }
    } else if (path.endsWith("/read")) data = { conversation: current.find(item => path.includes(`/${item.id}/`)) || current[0] };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path.endsWith("/conversations") && method === "POST") postFinished = true;
  });
  await page.goto(`http://127.0.0.1:${port}/workspace/chat/c1`);
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect.poll(() => Boolean(liveSocket)).toBe(true);
  const emit = (type, payload) => liveSocket.send(JSON.stringify({ version: 1, type: "event", event: { id: `fixture-${++seq}`, seq, spaceId: "s1", type, createdAt: now, payload } }));
  return {
    page, snapshot: () => snapshot(page), reads: () => listReads,
    async create(type) {
      await page.getByTitle("新建", { exact: true }).click();
      const label = type === "group" ? "创建群聊" : "发起私聊";
      await page.locator(".workspace-create-menu").getByRole("menuitem", { name: label, exact: true }).click();
      const panel = page.getByRole("region", { name: label, exact: true });
      if (type === "group") {
        await panel.getByLabel("群聊名称").fill("新建竞态群聊");
        await panel.getByRole("button", { name: "使用 🧭 作为群头像" }).click();
        await panel.getByRole("button", { name: /成员乙/ }).click();
        await panel.getByRole("button", { name: "创建群聊", exact: true }).click();
      } else await panel.getByRole("button", { name: /成员乙/ }).click();
      if (holdPost) await expect.poll(() => postWaiting).toBe(true);
      else await expect.poll(() => postFinished).toBe(true);
    },
    async holdOldList() { nextHeldList = true; emit("conversation.updated", { conversationId: "c1" }); await expect.poll(() => oldListWaiting).toBe(true); },
    async releaseOldList() { releaseOldList(); await expect.poll(() => oldListFinished).toBe(true); await settle(page); },
    async releasePost() { releasePost(); await expect.poll(() => postFinished).toBe(true); await settle(page); },
    async removeCreatedAuthoritatively() { current = [conversation("c1")]; const reads = listReads; emit("conversation.updated", { conversationId: "c1" }); await expect.poll(() => listReads).toBeGreaterThan(reads); },
    async revokeAccess() {
      revoked = true; actor = { ...members[0], role: "auditor" }; current = [];
      emit("workspace.member_updated", { userId: "u1", member: actor });
      await expect.poll(async () => (await snapshot(page)).canRead).toBe(false);
    },
    async newSession() {
      await page.locator(".workspace-user-trigger").click();
      await page.getByRole("menuitem", { name: "返回入口", exact: true }).click();
      await expect(page).toHaveURL(`http://127.0.0.1:${port}/`);
      actor = members[2]; current = [{ ...conversation("c1"), members: [members[2], members[1]] }];
      await page.getByRole("button", { name: /进入共享空间/ }).click();
      await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
      await expect.poll(async () => (await snapshot(page)).userId).toBe("u3");
    },
    async close() { releases.forEach(release => release()); await page.close(); }
  };
}

try {
  for (const type of ["group", "direct"]) {
    const fixture = await setup(), { page } = fixture;
    try {
      await fixture.holdOldList();
      await fixture.create(type);
      await expect(page).toHaveURL(/\/workspace\/chat\/created$/);
      const region = page.getByRole("region", { name: type === "group" ? "新建竞态群聊" : "成员乙", exact: true });
      await expect(region).toBeVisible();
      await fixture.releaseOldList();
      await page.screenshot({ path: `${output}/${type}-after-stale-list.png` });
      assert.equal((await fixture.snapshot()).selectedId, "created", "A pre-create list cannot deselect the just-created conversation");
      await expect(page).toHaveURL(/\/workspace\/chat\/created$/);
      await expect(region).toBeVisible();
      if (type === "group") await expect(region.locator(".workspace-chat-header .workspace-group-avatar")).toHaveText("🧭");
      await expect.poll(fixture.reads).toBeGreaterThan(1);
      await fixture.removeCreatedAuthoritatively();
      await expect.poll(async () => (await fixture.snapshot()).ids.includes("created")).toBe(false);
      await expect(page).toHaveURL(/\/workspace\/chat\/c1$/);
      results.passed.push(`${type}: stale list ignored; fresh authoritative removal honored`);
    } finally { await fixture.close(); }
  }
  for (const type of ["group", "direct"]) for (const invalidation of ["access", "session"]) for (const postFailure of [false, true]) {
    const fixture = await setup({ holdPost: true, postFailure }), { page } = fixture;
    try {
      const before = await fixture.snapshot();
      await fixture.create(type);
      if (invalidation === "access") await fixture.revokeAccess(); else await fixture.newSession();
      const invalidated = await fixture.snapshot();
      assert(invalidated[invalidation === "access" ? "accessEpoch" : "sessionEpoch"] > before[invalidation === "access" ? "accessEpoch" : "sessionEpoch"]);
      const route = page.url(), reads = fixture.reads();
      await fixture.releasePost();
      const after = await fixture.snapshot();
      assert.equal(page.url(), route, "Stale creation cannot navigate in the new identity/access context");
      assert(!after.ids.includes("created"));
      assert.equal(after.selectedId, invalidated.selectedId);
      assert.equal(fixture.reads(), reads, "Ignored create result must not schedule a new identity's refresh");
      await expect(page.getByText("旧身份创建结果应忽略", { exact: true })).toHaveCount(0);
      results.passed.push(`${type}: ${invalidation} invalidates late ${postFailure ? "failure" : "success"}`);
    } finally { await fixture.close(); }
  }
  assert.deepEqual(results.errors, []);
  console.log(`Created conversation race regression passed: ${results.passed.length} scenarios, actual App with synthetic transport.`);
} finally { await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2)); await browser.close(); await server.close(); }
