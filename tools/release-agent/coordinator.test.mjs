import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleReleaseBridge } from "./bridge.mjs";
import { approvalCard, approvalNamespace, createCometChannel } from "./channel.mjs";
import { createReleaseCoordinator } from "./coordinator.mjs";
import { dispatchReleaseAgent } from "./comet-dispatch.mjs";
import { openReleaseStore } from "./store.mjs";

const address = { spaceId: "space", botId: "comet", ownerUserId: "owner", ownerConversationId: "direct", groupConversationId: "group" };
const patch = { repo: "main", number: 34, base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40) };
const accepted = { decision: "accept", reason: "返回列表时仍有未读", repositories: ["main"], estimatedMinutes: 5, acceptance: ["两条未读保持到实际展示"] };
const candidate = { summary: "修复未读回执", changes: [patch], goWeb: { version: "1.2.4" }, ota: null, native: false, evidence: ["未读断言通过"] };

function groupRequest({ id = "message-src", actor = "member", text = "@Comet DL需求：会话列表打开后未读消失", kind = "human", conversationId = "group" } = {}) {
  return { protocol: "duallane.agent.request", version: 1, taskId: `task-${id}`, conversation: { id: conversationId, type: "group" },
    event: { type: "message.created", conversationId, payload: { messageId: id, actorUserId: actor } },
    triggerMessage: { id, authorKind: kind, authorId: actor, conversationId, plainText: text } };
}

function confirmation(ticket, { actor = "owner", action = "confirm", cardId = ticket.cardId, conversationId = "direct", fingerprint = ticket.approval.fingerprint } = {}) {
  return { protocol: "duallane.agent.request", version: 1, taskId: "card-task", conversation: { id: conversationId, type: "direct" },
    event: { type: "card.action", conversationId, payload: { actorUserId: actor, botId: "comet", cardId, actionId: action, clientActionId: "click-id",
      data: { namespace: approvalNamespace, ticketId: ticket.id, fingerprint, nonce: ticket.approval.nonce } } } };
}

function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dl-release-agent-test-"));
  const config = { channel: address, budgetMinutes: 20, approvalMinutes: 10, maxDailyTickets: 10, mode: "pilot", ...overrides.config };
  let instant = 100_000;
  const now = () => instant;
  let store = openReleaseStore(directory, { now });
  const notifications = [];
  const receipts = [];
  const channel = {
    async sendGroup(ticket, text, key) {
      notifications.push({ text, key, conversationId: ticket.source.conversationId, reply: ticket.source.messageId });
      return { messageId: "group-receipt" };
    },
    async sendApproval(ticket, key) {
      receipts.push({ card: approvalCard(ticket), key, ticketId: ticket.id });
      return { messageId: "direct-receipt", cardId: `card-${ticket.id}` };
    },
    ...overrides.channel,
  };
  const development = { async evaluate() { return accepted; }, async develop() { return candidate; }, ...overrides.development };
  const production = { async captureBaseline() { return { goWeb: { version: "1.2.3" }, ota: null }; },
    async inspect() { return { ready: true }; }, async release() { throw Error("release must be mocked"); }, ...overrides.production };
  const harness = {
    config, notifications, receipts, channel, production,
    get store() { return store; },
    dispatch: (request, extra) => handleReleaseBridge(request, { config, store, now, authorizeOwner: async () => {}, ...extra }),
    worker: () => createReleaseCoordinator({ config, store, channel, development, production, now }),
    advance: (ms) => { instant += ms; },
    reopen() {
      store.close();
      store = openReleaseStore(directory, { now });
    },
    async prepare(message) {
      await harness.dispatch(message ?? groupRequest());
      let count = 0;
      while (await harness.worker().tick()) {
        if (++count > 12) throw Error("unexpected work cycle");
      }
      return store.list().find((ticket) => ticket.source.messageId === (message?.triggerMessage.id ?? "message-src"));
    },
  };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return harness;
}

test("pins intake to exact human trigger, preserves private lanes and survives replay", async (t) => {
  const h = setup(t);
  assert.equal(await h.dispatch(groupRequest({ text: "普通群聊" })), null);
  assert.equal(await h.dispatch(groupRequest({ conversationId: "another-group" })), null);
  await h.dispatch(groupRequest({ kind: "bot" }));
  await h.dispatch(groupRequest({ text: "DL需求 https://example.com/r#k=synthetic" }));
  const mismatched = groupRequest();
  mismatched.triggerMessage.authorId = "other-human";
  await h.dispatch(mismatched);
  assert.equal(h.store.list().length, 0);
  const request = groupRequest();
  request.triggerMessage.replyToMessageId = "source-quote";
  const quoteReads = [];
  const answer = await h.dispatch(request, { readQuote: async (_request, id) => { quoteReads.push(id); return "旧回执"; } });
  h.reopen();
  assert.deepEqual(await h.dispatch(groupRequest({ text: "DL需求 已编辑的内容" })), answer);
  assert.deepEqual(quoteReads, ["source-quote"]);
  assert.equal(h.store.list().length, 1);
  const ticket = h.store.list()[0];
  assert.equal(ticket.text, "会话列表打开后未读消失");
  assert.equal(ticket.context, "旧回执");
  assert.equal(h.store.listAudit(ticket.id)[0].result, "queued");
});

test("pilot delivers group result and one owner card, authorizes a single confirmation", async (t) => {
  const h = setup(t);
  const prepared = await h.prepare();
  assert.equal(prepared.state, "awaiting_approval");
  assert.equal(prepared.text, null);
  assert.equal(h.notifications[0].reply, "message-src");
  assert.equal(h.notifications[0].conversationId, "group");
  assert.equal(h.receipts.length, 1);
  assert.match(h.receipts[0].card.fallbackText, /试运行/u);
  h.reopen();
  assert.match((await h.dispatch(confirmation(prepared, { actor: "other" }))).text, /权限/u);
  assert.match((await h.dispatch(confirmation(prepared, { cardId: "wrong-card" }))).text, /失效/u);
  assert.match((await h.dispatch(confirmation(prepared, { fingerprint: "other-candidate" }))).text, /失效/u);
  assert.equal(h.store.get(prepared.id).state, "awaiting_approval");
  const action = confirmation(prepared);
  const replies = await Promise.all([h.dispatch(action), h.dispatch(action)]);
  assert.equal(replies.filter(({ text }) => text.includes("已记录")).length, 1);
  assert.equal(h.store.get(prepared.id).state, "pilot_confirmed");
  assert.equal(await h.worker().releaseTick(), false);
});

test("an expired approval or a new mode cannot reuse an old card", async (t) => {
  const h = setup(t);
  const ticket = await h.prepare();
  h.advance(600_000);
  assert.match((await h.dispatch(confirmation(ticket))).text, /过期/u);
  assert.equal(h.store.get(ticket.id).state, "expired");
  const next = await h.prepare(groupRequest({ id: "another-ticket" }));
  h.config.mode = "production";
  assert.match((await h.dispatch(confirmation(next))).text, /过期/u);
  assert.equal(h.store.get(next.id).state, "expired");
});

test("ordinary Comet traffic continues while the pilot config is invalid", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dl-pilot-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  writeFileSync(config, "{invalid");
  assert.equal(await dispatchReleaseAgent(groupRequest({ text: "普通群聊" }), config), null);
  assert.match((await dispatchReleaseAgent(groupRequest(), config)).text, /暂不可用/u);
});

test("a click that expires in the current owner check cannot authorize a release", async (t) => {
  const h = setup(t, { config: { mode: "production" } });
  const ticket = await h.prepare();
  const result = await h.dispatch(confirmation(ticket), { authorizeOwner: async () => h.advance(600_000) });
  assert.match(result.text, /过期/u);
  assert.equal(h.store.get(ticket.id).state, "expired");
});

test("over-budget request refuses on the original path before branch creation", async (t) => {
  const h = setup(t, { development: { async evaluate() { return { ...accepted, estimatedMinutes: 100 }; },
    async develop() { assert.fail("budget refusal should not run an implementation"); } } });
  const ticket = await h.prepare();
  assert.equal(ticket.state, "decline");
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].text, /预算/u);
  assert.equal(h.notifications[0].reply, "message-src");
});

test("waits for maintainer merge and locks all release retries after an uncertain side effect", async (t) => {
  let ready = false;
  let releaseCalls = 0;
  const h = setup(t, { config: { mode: "production" }, production: {
    async inspect() { return ready ? { ready: true } : { ready: false, reason: "merge_pending" }; },
    async release(_item, { baseline, onPhase }) {
      releaseCalls += 1;
      assert.equal(baseline.goWeb.version, "1.2.3");
      await onPhase({ phase: "go-web", state: "started" });
      await onPhase({ phase: "go-web", state: "uncertain" });
      return { status: "uncertain", reason: "go.receipt_missing", completed: [] };
    },
  } });
  const first = await h.prepare();
  await h.dispatch(confirmation(first));
  assert.equal(await h.worker().releaseTick(), false);
  assert.equal(releaseCalls, 0);
  ready = true;
  assert.equal(await h.worker().releaseTick(), true);
  assert.equal(h.store.get(first.id).state, "release_attention");
  h.reopen();
  const second = await h.prepare(groupRequest({ id: "second-request" }));
  await h.dispatch(confirmation(second));
  assert.equal(await h.worker().releaseTick(), false);
  assert.equal(h.store.get(second.id).state, "approved");
  assert.equal(releaseCalls, 1);
});

test("release approval must stay valid through slow read-only checks until the first write", async (t) => {
  let advancesInInspection = true;
  const h = setup(t, { config: { mode: "production" }, production: {
    async inspect() {
      if (advancesInInspection) h.advance(600_000);
      return { ready: true };
    },
    async release(_candidate, { onPhase }) {
      assert.equal(advancesInInspection, false);
      h.advance(600_000);
      await onPhase({ phase: "go-web", state: "started" });
      assert.fail("production write followed an expired approval");
    },
  } });
  const first = await h.prepare();
  await h.dispatch(confirmation(first));
  await h.worker().releaseTick();
  assert.equal(h.store.get(first.id).state, "expired");
  advancesInInspection = false;
  const second = await h.prepare(groupRequest({ id: "slow-production-preflight" }));
  await h.dispatch(confirmation(second));
  await h.worker().releaseTick();
  assert.equal(h.store.get(second.id).state, "expired");
  assert.deepEqual(h.store.get(second.id).phases, []);
});

test("checks current Comet identity and server-declared owner DM before sending", async () => {
  let owner = true;
  const writes = [];
  const client = { async getMe() { return { bot: { id: "comet", name: "Comet" }, spaceId: "space", scopes: ["messages:send"] }; },
    async listConversations() { return { conversations: [{ id: "direct", type: "direct", allowSend: true, isOwnerDirect: owner }] }; },
    async getCapabilities() { return { taskRequired: false }; }, async sendMessage(input) { writes.push(input); return { message: { id: "sent" } }; } };
  const channel = createCometChannel({ config: { channel: address }, client });
  assert.deepEqual(await channel.notifyOwner("试运行通过", "finished-1"), { messageId: "sent" });
  assert.equal(writes[0].conversationId, "direct");
  assert.equal(writes[0].clientMessageId, writes[0].idempotencyKey);
  owner = false;
  await assert.rejects(channel.notifyOwner("试运行通过", "finished-2"), { code: "release_agent.conversation_denied" });
  assert.equal(writes.length, 1);
});
