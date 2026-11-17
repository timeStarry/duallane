import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DualLaneAgentClient, buildMessageContent, parseMessageContent, messageText, messageMention, messageAttachment, messageLink } from "../src/index.js";
import { createTaskScopedClient } from "../src/task-client.js";
import { createTaskToolServer, createTaskToolBroker, createTaskBrokerMcpAdapter, DUALLANE_TASK_TOOLS } from "../src/task-tools.js";
import { createAgentTaskRuntime } from "../src/task-runtime.js";
import { createDualLaneMcpServer } from "../src/mcp.js";
import { saveAgentProfile } from "../src/profile-store.js";
import { invokeDaemonAgentTurn } from "../src/daemon.js";

const taskToken = `dl_bot_${"f".repeat(32)}`;
const liveTask = () => ({ id: "server-task", conversationId: "conversation", triggerMessageId: "trigger", expiresAt: new Date(Date.now() + 60_000).toISOString() });
const taskResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const runFile = promisify(execFile);

test("mixed message builders retain stable mentions and resources; unsupported read blocks are explicit", () => {
  const content = buildMessageContent([messageText("@plain-text "), messageMention("bot-b", "B"), messageAttachment("image"), messageAttachment("document"), messageLink("https://public.example/image", "来源")]);
  assert.equal(content.blocks[0].type, "text");
  assert.equal(content.blocks[1].userId, "bot-b");
  assert.deepEqual(parseMessageContent(content).blocks, content.blocks);
  assert.equal(parseMessageContent(content).complete, true);
  assert.throws(() => messageMention("../bot"), { code: "message.invalid_reference" });
  assert.throws(() => messageLink("javascript:alert(1)"), { code: "message.invalid_link" });
  const read = parseMessageContent({ ...content, blocks: [...content.blocks, { type: "future-poll", secret: "ignored" }] });
  assert.equal(read.complete, false);
  assert.deepEqual(read.unsupportedBlockTypes, ["future-poll"]);
  assert.throws(() => buildMessageContent(read), { code: "message.unsupported_block" });
  const current = buildMessageContent([{ type: "emote_collection", shareId: "share" }, { type: "topic_reference", topicId: "topic", title: "Title" }, { type: "emoji", shortcode: "custom:emote-1" }]);
  assert.equal(parseMessageContent(current).complete, true);
});

test("task clients reauthorize each operation, attach task only in headers, and retain pagination coverage", async () => {
  const task = liveTask(), requests = [];
  let denied = false;
  const client = new DualLaneAgentClient({ url: "https://gateway.example", token: taskToken, fetch: async (url, init) => {
    const parsed = new URL(url); requests.push({ parsed, init });
    assert.equal(init.headers.authorization, `Bearer ${taskToken}`);
    assert.equal(parsed.href.includes(taskToken), false);
    if (parsed.pathname.includes("/tasks/")) return denied ? taskResponse({ error: { code: "task.revoked" } }, 403) : taskResponse({ task });
    assert.equal(init.headers["x-duallane-task"], task.id);
    return taskResponse({ messages: [{ id: "old", conversationId: task.conversationId }], nextCursor: "opaque+cursor", hasMore: true, coverage: { truncated: true, since: "2026-11-01", until: "2026-11-17" } });
  } });
  const scoped = client.forTask(task);
  try {
    const page = await scoped.searchMessages(task.conversationId, { query: "部署", before: "opaque+cursor", limit: 4 });
    assert.equal(page.hasMore, true); assert.equal(page.coverage.truncated, true);
    const request = requests.at(-1);
    assert.equal(request.parsed.searchParams.get("before"), "opaque+cursor");
    assert.equal(request.parsed.searchParams.get("query"), "部署");
    assert.equal(request.parsed.searchParams.get("limit"), "4");
    assert.throws(() => scoped.sendMessage({ conversationId: "another", text: "no" }), { code: "task.conversation_mismatch" });
    const before = requests.length; denied = true;
    await assert.rejects(scoped.listHistory(task.conversationId), { code: "task.revoked" });
    assert.equal(requests.length, before + 1, "revoked task never reaches the history endpoint");
  } finally { scoped.close(); }
});

test("task budgets bound calls, cumulative results, deadlines and closed sessions", async () => {
  const task = liveTask(); let calls = 0, clock = Date.now();
  const direct = { async getTask() { return { task }; }, async listHistory() { calls++; return { messages: [], hasMore: false, coverage: {} }; } };
  const scoped = createTaskScopedClient(direct, task, { maxCalls: 1 });
  await scoped.listHistory();
  await assert.rejects(scoped.listHistory(), { code: "context.budget_exhausted" });
  assert.equal(calls, 1); scoped.close();
  await assert.rejects(scoped.listHistory(), { code: "task.cancelled" });
  const bytes = createTaskScopedClient(direct, task, { maxResultBytes: 5 });
  await assert.rejects(bytes.listHistory(), { code: "context.budget_exhausted" }); bytes.close();
  const expired = createTaskScopedClient(direct, task, { now: () => clock, timeoutMs: 20 });
  clock += 21;
  await assert.rejects(expired.listHistory(), { code: "task.expired" }); expired.close();
});

test("task tools reject operator/path/scope arguments and reconcile duplicate writes without another side effect", async () => {
  const task = liveTask(); let writes = 0, checks = 0;
  const scoped = createTaskScopedClient({ async getTask() { checks++; return { task }; }, async sendMessage(input) {
    writes++; assert.ok(input.idempotencyKey.startsWith("tool-"));
    return { message: { id: "sent", conversationId: task.conversationId } };
  } }, task);
  const tools = createTaskToolServer(scoped);
  try {
    assert.equal(JSON.stringify(DUALLANE_TASK_TOOLS).includes("filePath"), false);
    await assert.rejects(tools.callTool("duallane_unbind"), { code: "tool.not_available" });
    await assert.rejects(tools.callTool("duallane_history", { profile: "admin" }), { code: "tool.invalid_arguments" });
    await assert.rejects(tools.callTool("duallane_history", { conversationId: "other" }), { code: "tool.invalid_arguments" });
    const input = { content: buildMessageContent([messageMention("bot-b", "B"), messageText("请继续")]) };
    assert.equal((await tools.callTool("duallane_send_message", input, "request-1")).message.id, "sent");
    assert.equal((await tools.callTool("duallane_send_message", input, "request-1")).message.id, "sent");
    assert.equal(writes, 1); assert.ok(checks >= 2);
    await assert.rejects(tools.callTool("duallane_send_message", { text: "different" }, "request-1"), { code: "tool.idempotency_conflict" });
    assert.equal(writes, 1);
  } finally { scoped.close(); }
});

test("unknown task tool write outcome is not blindly repeated", async () => {
  let writes = 0; const task = liveTask();
  const scoped = createTaskScopedClient({ async getTask() { return { task }; }, async sendMessage() { writes++; throw Object.assign(new Error(), { code: "network.timeout" }); } }, task);
  const tools = createTaskToolServer(scoped);
  try {
    await assert.rejects(tools.callTool("duallane_send_message", { text: "hello" }, "same"), { code: "network.timeout" });
    await assert.rejects(tools.callTool("duallane_send_message", { text: "hello" }, "same"), { code: "network.timeout" });
    assert.equal(writes, 1);
  } finally { scoped.close(); }
});

test("loopback broker rejects browser/foreign/unauthenticated access and closes with its task", async () => {
  const task = liveTask();
  const scoped = createTaskScopedClient({ async getTask() { return { task }; }, async getCapabilities() { return { features: {} }; }, async listMembers() { return { members: [{ id: "bot-b", kind: "bot" }] }; } }, task);
  const broker = await createTaskToolBroker(scoped);
  const url = broker.environment.DUALLANE_TASK_BROKER_URL;
  const key = broker.environment.DUALLANE_TASK_BROKER_KEY;
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "duallane_list_members", arguments: {} } };
  try {
    assert.equal(JSON.stringify(broker.descriptor).includes(key), false);
    assert.equal(JSON.stringify(broker.descriptor).includes(taskToken), false);
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call) })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, origin: "https://evil.example" }, body: JSON.stringify(call) })).status, 403);
    const adapter = createTaskBrokerMcpAdapter({ url, key });
    const result = await adapter.handleJsonRpc(call);
    assert.equal(result.result.structuredContent.members[0].id, "bot-b");
    assert.throws(() => createTaskBrokerMcpAdapter({ url: "http://example.com/task-tools", key }), { code: "task.broker_unavailable" });
  } finally { broker.close(); scoped.close(); }
  await assert.rejects(fetch(url, { method: "POST" }));
});

test("actual command bridge consumes task tools while its model child receives no transport credentials", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-command-task-tools-"));
  const task = liveTask();
  const scoped = createTaskScopedClient({ async getTask() { return { task }; }, async getCapabilities() { return { features: {} }; }, async listMembers() { return { members: [{ id: "bot-b" }] }; } }, task);
  const broker = await createTaskToolBroker(scoped);
  const command = path.join(directory, "bridge.mjs");
  const toolsUrl = new URL("../src/task-tools.js", import.meta.url).href;
  fs.writeFileSync(command, `import {spawnSync} from 'node:child_process';import{createTaskBrokerMcpAdapter}from ${JSON.stringify(toolsUrl)};
let text='';for await(const part of process.stdin)text+=part;const request=JSON.parse(text);
if(text.includes(process.env.DUALLANE_TASK_BROKER_KEY)||process.env.DUALLANE_BOT_TOKEN||process.env.DUALLANE_TOKEN)process.exit(2);
const tools=createTaskBrokerMcpAdapter();const result=await tools.handleJsonRpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'duallane_list_members',arguments:{}}});
if(result.result.structuredContent.members[0].id!=='bot-b')process.exit(3);
const env={...process.env};delete env.DUALLANE_TASK_BROKER_URL;delete env.DUALLANE_TASK_BROKER_KEY;delete env.DUALLANE_BOT_TOKEN;delete env.DUALLANE_TOKEN;
const model=spawnSync(process.execPath,['-e',"if(Object.keys(process.env).some(k=>['DUALLANE_TASK_BROKER_KEY','DUALLANE_TASK_BROKER_URL','DUALLANE_BOT_TOKEN','DUALLANE_TOKEN'].includes(k)))process.exit(4)"],{env,windowsHide:true});
if(model.status!==0)process.exit(4);
process.stdout.write(JSON.stringify({protocol:'duallane.agent.result',version:1,status:'completed',text:'Verified scoped tools and isolated model environment',artifacts:[]}));`);
  try {
    const result = await invokeDaemonAgentTurn({ customCmd: `"${process.execPath}" "${command}"`, workdir: directory,
      request: { event: { conversationId: task.conversationId, type: "message.created" }, toolSession: broker.descriptor },
      toolEnvironment: { ...broker.environment, DUALLANE_BOT_TOKEN: taskToken }, timeoutMs: 10_000 });
    assert.equal(JSON.parse(result).status, "completed");
    assert.equal(result.includes(broker.environment.DUALLANE_TASK_BROKER_KEY), false);
  } finally { broker.close(); scoped.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("runtime obtains the exact server trigger, small context and real task-scoped model tools", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-task-tools-runtime-"));
  const task = liveTask(), sent = []; let calls = 0;
  const client = new DualLaneAgentClient({ url: "https://gateway.example", token: taskToken, fetch: async (url, init) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/capabilities")) return taskResponse({ features: { taskAuthorization: true }, taskRequired: true });
    if (route.endsWith("/tasks") || route.endsWith(`/tasks/${task.id}`)) return taskResponse({ task });
    if (route.endsWith("/conversations")) return taskResponse({ conversations: [{ id: task.conversationId, allowTrigger: true, allowSend: true, allowContext: true, taskRequired: true }] });
    assert.equal(init.headers["x-duallane-task"], task.id);
    if (route.endsWith("/context")) {
      assert.equal(new URL(url).searchParams.get("limit"), "12");
      return taskResponse({ messages: Array.from({ length: 12 }, (_, id) => ({ id: `neighbor-${id}`, authorKind: "human", plainText: "bounded neighbor" })) });
    }
    if (route.endsWith(`/messages/${task.triggerMessageId}`)) return taskResponse({ message: { id: task.triggerMessageId, conversationId: task.conversationId, authorKind: "human", plainText: "查找历史并提及 B" } });
    if (route.endsWith("/messages") && init.method === "GET") return taskResponse({ messages: [{ id: "historical", plainText: "检索结果" }], hasMore: true, nextCursor: "opaque", coverage: { truncated: true } });
    if (route.endsWith("/messages") && init.method === "POST") { sent.push(JSON.parse(init.body)); return taskResponse({ message: { id: "published", conversationId: task.conversationId } }); }
    throw Error(`Unexpected synthetic endpoint ${route}`);
  } });
  const runtime = createAgentTaskRuntime({ stateDir: directory, origin: "https://gateway.example", botId: "bot", client,
    scopes: ["messages:read_context", "messages:send"], maxAttempts: 1,
    async invoke(request, { toolEnvironment }) {
      calls++;
      assert.equal(request.triggerMessage.id, task.triggerMessageId);
      assert.ok(request.context.messages.length <= 12);
      assert.equal(request.toolSession.scope.taskId, task.id);
      const serialized = JSON.stringify(request);
      assert.equal(serialized.includes(taskToken), false);
      assert.equal(serialized.includes(toolEnvironment.DUALLANE_TASK_BROKER_KEY), false);
      const adapter = createTaskBrokerMcpAdapter({ url: toolEnvironment.DUALLANE_TASK_BROKER_URL, key: toolEnvironment.DUALLANE_TASK_BROKER_KEY });
      const result = await adapter.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "duallane_search_messages", arguments: { query: "历史" } } });
      assert.equal(result.result.structuredContent.hasMore, true);
      assert.equal(result.result.structuredContent.messages[0].id, "historical");
      return JSON.stringify({ protocol: "duallane.agent.result", version: 1, status: "completed", content: buildMessageContent([messageMention("bot-b", "B"), messageText("请看历史")]), artifacts: [] });
    } });
  try {
    const event = { eventId: "event", sequence: 1, type: "message.created", conversationId: task.conversationId, payload: { messageId: task.triggerMessageId } };
    const receipt = runtime.accept(event); runtime.start(); await runtime.idle();
    assert.equal(runtime.getTask(receipt.taskId).state, "completed");
    assert.equal(sent.length, 1); assert.equal(sent[0].content.blocks[0].type, "mention");
    assert.equal(runtime.accept(event).duplicate, true); await runtime.idle(); assert.equal(calls, 1);
  } finally { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("remote revocation aborts a running model bridge and fences publication", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-task-revocation-"));
  const task = liveTask(); let revoked = false, aborted = false, sent = 0;
  const base = { async listConversations() { return { conversations: [{ id: task.conversationId, allowContext: false, taskRequired: true }] }; },
    async getCapabilities() { return { features: { taskAuthorization: true }, taskRequired: true }; },
    async createTask() { return { task }; }, async getTask() { if (revoked) throw Object.assign(new Error(), { code: "task.revoked", statusCode: 403 }); return { task }; },
    async getMessage() { return { message: { id: task.triggerMessageId, authorKind: "human", plainText: "long job" } }; },
    async sendMessage() { sent++; return { message: { id: "never" } }; } };
  base.forTask = (record) => createTaskScopedClient(base, record);
  const runtime = createAgentTaskRuntime({ stateDir: directory, origin: "https://fixture.example", botId: "bot", client: base, maxAttempts: 1, authorizationPollMs: 100,
    async invoke(_request, { signal }) {
      revoked = true;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error(), { code: "bridge.cancelled" })); }, { once: true }));
    } });
  try {
    const receipt = runtime.accept({ eventId: "event", sequence: 1, type: "message.created", conversationId: task.conversationId, payload: { messageId: task.triggerMessageId } });
    runtime.start(); await runtime.idle();
    assert.equal(aborted, true); assert.equal(sent, 0); assert.equal(runtime.getTask(receipt.taskId).state, "cancelled");
  } finally { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("task-required policy and capability failures cannot downgrade into legacy model execution", async () => {
  for (const [taskRequired, statusCode, allowed] of [[false, 404, true], [true, 404, false], [false, 403, false], [false, 503, false]]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-task-downgrade-"));
    let invoked = 0, sent = 0;
    const runtime = createAgentTaskRuntime({ stateDir: directory, origin: "https://fixture.example", botId: "bot", maxAttempts: 1,
      client: { async listConversations() { return { conversations: [{ id: "conversation", allowContext: false, taskRequired }] }; },
        async getCapabilities() { throw Object.assign(new Error(), { statusCode, code: "gateway.request_failed" }); },
        async sendMessage() { sent++; return { message: { id: "sent" } }; } },
      async invoke() { invoked++; return "legacy response"; } });
    try {
      const receipt = runtime.accept({ eventId: "event", sequence: 1, type: "message.created", conversationId: "conversation", payload: { messageId: "trigger", text: "exact trigger", textComplete: true } });
      runtime.start(); await runtime.idle();
      assert.equal(invoked, allowed ? 1 : 0); assert.equal(sent, allowed ? 1 : 0);
      assert.equal(runtime.getTask(receipt.taskId).state, allowed ? "completed" : "failed");
    } finally { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test("operator CLI and MCP preserve structured content and require explicit tasks for historical tools", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-task-cli-"));
  const task = liveTask(), published = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url.endsWith(`/tasks/${task.id}`)) { response.end(JSON.stringify({ task })); return; }
    if (request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      published.push({ content: JSON.parse(raw).content, task: request.headers["x-duallane-task"] });
      response.end(JSON.stringify({ message: { id: "sent", conversationId: task.conversationId } })); return;
    }
    response.end(JSON.stringify({ messages: [], hasMore: false, coverage: {} }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  saveAgentProfile("default", { url: origin, token: taskToken }, { configDir: directory });
  const content = buildMessageContent([messageMention("bot-b", "B"), messageText("continue")]);
  try {
    const cli = fileURLToPath(new URL("../bin/duallane-agent.mjs", import.meta.url));
    const result = await runFile(process.execPath, [cli, "send", task.conversationId, "--content-json", JSON.stringify(content), "--task-id", task.id], {
      env: { ...process.env, DUALLANE_AGENT_CONFIG_DIR: directory }, windowsHide: true, timeout: 10_000 });
    assert.equal(JSON.parse(result.stdout).message.id, "sent");
    const mcp = createDualLaneMcpServer({ configDir: directory });
    await mcp.callTool("duallane_send_message", { conversationId: task.conversationId, content, taskId: task.id });
    await assert.rejects(mcp.callTool("duallane_history", {}), { code: "task.context_required" });
    assert.equal(published.length, 2);
    for (const item of published) { assert.equal(item.task, task.id); assert.deepEqual(item.content, content); }
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
});
