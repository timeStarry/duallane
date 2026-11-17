import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DualLaneAgentClient, DUALLANE_AGENT_SDK_VERSION } from "../src/index.js";
import { buildAgentInteractiveCard, createTaskToolServer } from "../src/task-tools.js";
import { createDualLaneMcpServer } from "../src/mcp.js";
import { saveAgentProfile } from "../src/profile-store.js";

const token = `dl_bot_${"c".repeat(32)}`;
const record = () => ({ id: "synthetic-task", conversationId: "synthetic-conversation", triggerMessageId: "synthetic-trigger", expiresAt: new Date(Date.now() + 60_000).toISOString() });
const actions = ["confirm", "cancel", "submit", "refresh"];
const cardInput = () => ({ title: "Synthetic review", markdown: "Choose a fixed action", buttons: actions.map((actionId) => ({ actionId, label: actionId, value: { action: "business-action", action_id: "business-id", nested: { selected: true } } })) });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function assertConverterButtonValues(card) {
  const buttons = card.elements.find((element) => element.tag === "action").actions;
  assert.equal(buttons.length, 4);
  for (const [index, button] of buttons.entries()) {
    // Go's converter rejects every other top-level button.value key.
    assert.deepEqual(Object.keys(button.value).sort(), ["action_id", "data"]);
    assert.equal(button.value.action_id, actions[index]);
    assert.deepEqual(button.value.data, cardInput().buttons[index].value);
    assert.equal(Object.hasOwn(button.value, "action"), false);
  }
}

test("fixed card actions use the converter's action_id/data envelope without promoting business keys", () => {
  assertConverterButtonValues(buildAgentInteractiveCard(cardInput()));
  const minimal = buildAgentInteractiveCard({ title: "Minimal", buttons: [{ actionId: "confirm", label: "OK" }] });
  assert.deepEqual(minimal.elements.at(-1).actions[0].value, { action_id: "confirm" });
  assert.throws(() => buildAgentInteractiveCard({ buttons: [{ actionId: "run_shell", label: "No" }] }), { code: "card.invalid_action" });
  assert.throws(() => buildAgentInteractiveCard({ buttons: [{ actionId: "confirm", label: "A" }, { actionId: "confirm", label: "B" }] }), { code: "card.invalid_action" });
});

test("button data remains a JSON object within 4096 UTF-8 bytes and is captured without later mutation", () => {
  const build = (value) => buildAgentInteractiveCard({ buttons: [{ actionId: "submit", label: "Submit", value }] });
  const overhead = Buffer.byteLength(JSON.stringify({ text: "" }));
  assert.ok(build({ text: "x".repeat(4096 - overhead) }));
  assert.throws(() => build({ text: "x".repeat(4097 - overhead) }), { code: "card.invalid_input" });
  assert.throws(() => build({ text: "图".repeat(1400) }), { code: "card.invalid_input" });
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [null, [], "text", 1, true, cyclic, { integer: 1n }, new Date(), { toJSON() { return []; } }]) assert.throws(() => build(value), { code: "card.invalid_input" });
  const data = { action: "business", action_id: "business-id", nested: { value: 1 } };
  const built = build(data); data.nested.value = 2;
  assert.equal(built.elements.at(-1).actions[0].value.data.nested.value, 1);
});

test("SDK, task MCP, operator MCP and CLI card sends and updates share the strict converter envelope", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-card-contract-"));
  const task = record(), writes = [], errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers["x-duallane-sdk-version"], DUALLANE_AGENT_SDK_VERSION);
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      response.setHeader("content-type", "application/json");
      if (request.url.endsWith(`/tasks/${task.id}`)) { response.end(JSON.stringify({ task })); return; }
      if (request.url.includes("/capabilities")) { response.end(JSON.stringify({ features: { taskCardUpdate: true } })); return; }
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.format, "feishu-card"); assertConverterButtonValues(body.feishuCard);
      if (request.method === "PATCH") assert.equal(body.expectedRevision, 1);
      writes.push({ method: request.method, body });
      response.end(JSON.stringify({ card: { id: "synthetic-card", revision: 2 }, message: { id: "synthetic-message" } }));
    } catch (error) { errors.push(error); response.writeHead(400).end(JSON.stringify({ error: { code: "card.feishu_action_input_forbidden" } })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new DualLaneAgentClient({ url, token });
  const scoped = client.forTask(task);
  const input = cardInput();
  try {
    saveAgentProfile("default", { url, token }, { configDir: directory });
    const built = buildAgentInteractiveCard(input);
    await scoped.sendFeishuCard({ conversationId: task.conversationId, card: built });
    await scoped.updateFeishuCard("synthetic-card", { card: built, expectedRevision: 1 });
    const tools = createTaskToolServer(scoped);
    await tools.callTool("duallane_send_card", input, "send");
    await tools.callTool("duallane_update_card", { ...input, cardId: "synthetic-card", expectedRevision: 1 }, "update");
    const mcp = createDualLaneMcpServer({ configDir: directory });
    await mcp.callTool("duallane_send_card", { ...input, conversationId: task.conversationId, taskId: task.id });
    await mcp.callTool("duallane_update_card", { ...input, cardId: "synthetic-card", expectedRevision: 1, taskId: task.id });
    const cli = fileURLToPath(new URL("../bin/duallane-agent.mjs", import.meta.url));
    const run = (args) => promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, DUALLANE_AGENT_CONFIG_DIR: directory }, windowsHide: true, timeout: 10_000 });
    await run(["send-card", task.conversationId, "--card-json", JSON.stringify(input), "--task-id", task.id]);
    await run(["update-card", "synthetic-card", "--card-json", JSON.stringify(input), "--expected-revision", "1", "--task-id", task.id]);
    assert.deepEqual(errors, []); assert.equal(writes.length, 8);
    assert.equal(writes.filter((write) => write.method === "POST").length, 4);
    assert.equal(writes.filter((write) => write.method === "PATCH").length, 4);
  } finally { scoped.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("strict Go unknown-field 422 rejects only this attempt, preserving an earlier same-key commit", async () => {
  const task = record(); let writes = 0;
  const client = new DualLaneAgentClient({ url: "https://synthetic.example", token, taskId: task.id, fetch: async (url, init) => {
    if (new URL(url).pathname.includes("/operations/")) return json({ status: "committed", result: { card: { id: "earlier-card" } }, humanRead: false });
    writes++; return json({ error: { code: "card.feishu_unknown_field", message: token } }, 422);
  } });
  for (const write of [
    () => client.sendFeishuCard({ conversationId: task.conversationId, card: {}, clientMessageId: "existing-key" }),
    () => client.updateFeishuCard("synthetic-card", { card: {}, expectedRevision: 1 }),
  ]) {
    let failure;
    try { await write(); } catch (error) { failure = error; }
    assert.ok(failure); assert.equal(failure.code, "card.feishu_unknown_field"); assert.equal(failure.statusCode, 422); assert.equal(failure.attemptOutcome, "rejected");
    assert.equal(failure.retryable, false); assert.equal(failure.safeToRetry, false); assert.equal(failure.operation.taskId, task.id);
    assert.equal(failure.not_committed, undefined); assert.ok(!JSON.stringify(failure).includes(token));
    const result = await client.getOperation(task.id, failure.operation.operation, failure.operation.key);
    assert.equal(result.status, "committed"); assert.equal(result.result.card.id, "earlier-card");
  }
  assert.equal(writes, 2);
});

test("uncertain card writes and unknown card codes never become definite rejection or blind retry permission", async () => {
  const cases = [
    async () => { throw new Error("private network details"); },
    () => new Promise(() => {}),
    async () => new Response("malformed", { status: 200, headers: { "content-type": "application/json" } }),
    async () => new Response("proxy", { status: 400, headers: { "content-type": "text/html" } }),
    async () => json({ error: { code: "card.feishu_action_input_forbidden" } }, 503),
    async () => json({ error: { code: "card.future_validation" } }, 400),
    async () => json({ error: { code: "card.future_validation" } }, 422),
    async () => json({ error: { code: "card.action_unavailable" } }, 400),
  ];
  for (const fetch of cases) {
    let writes = 0;
    const client = new DualLaneAgentClient({ url: "https://synthetic.example", token, taskId: "synthetic-task", requestTimeoutMs: 20, fetch: (...args) => { writes++; return fetch(...args); } });
    await assert.rejects(client.sendFeishuCard({ conversationId: "synthetic-conversation", card: {}, clientMessageId: "synthetic-key" }), (error) => {
      assert.equal(error.attemptOutcome, "unknown"); assert.equal(error.safeToRetry, false);
      assert.deepEqual(error.operation, { taskId: "synthetic-task", operation: "card.send", key: "synthetic-key" }); return true;
    });
    assert.equal(writes, 1);
  }
});

test("task/operator MCP and CLI preserve per-attempt rejection without resubmitting a cached tool write", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-card-rejection-"));
  const task = record(); let writes = 0;
  const server = http.createServer(async (request, output) => {
    output.setHeader("content-type", "application/json");
    if (request.url.endsWith(`/tasks/${task.id}`)) { output.end(JSON.stringify({ task })); return; }
    if (request.url.includes("/capabilities")) { output.end(JSON.stringify({ features: { taskCardUpdate: true } })); return; }
    for await (const _chunk of request) { /* Drain only synthetic test input. */ }
    writes++; output.writeHead(400).end(JSON.stringify({ error: { code: "card.feishu_action_input_forbidden" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new DualLaneAgentClient({ url, token }), scoped = client.forTask(task);
  const assertRejected = (error) => {
    assert.equal(error.attemptOutcome, "rejected"); assert.equal(error.safeToRetry, false);
    assert.equal(error.operation.operation, "card.send");
  };
  try {
    saveAgentProfile("default", { url, token }, { configDir: directory });
    const tools = createTaskToolServer(scoped), input = cardInput();
    const call = { jsonrpc: "2.0", id: "synthetic-operation", method: "tools/call", params: { name: "duallane_send_card", arguments: input } };
    for (let index = 0; index < 2; index++) {
      const result = await tools.handleJsonRpc(call);
      assert.equal(result.result.isError, true); assertRejected(JSON.parse(result.result.content[0].text).error);
    }
    assert.equal(writes, 1);
    const operator = createDualLaneMcpServer({ configDir: directory });
    const result = await operator.handleJsonRpc({ ...call, params: { name: "duallane_send_card", arguments: { ...input, taskId: task.id, conversationId: task.conversationId } } });
    assert.equal(result.result.isError, true);
    const error = JSON.parse(result.result.content[0].text).error;
    assertRejected(error); assert.equal(error.retryable, false);
    const cli = fileURLToPath(new URL("../bin/duallane-agent.mjs", import.meta.url));
    await assert.rejects(promisify(execFile)(process.execPath, [cli, "send-card", task.conversationId, "--card-json", JSON.stringify(input), "--task-id", task.id], {
      env: { ...process.env, DUALLANE_AGENT_CONFIG_DIR: directory }, windowsHide: true, timeout: 10_000,
    }), (failure) => {
      assert.equal(failure.code, 1); assertRejected(JSON.parse(failure.stderr.trim().split(/\r?\n/u).at(-1))); return true;
    });
    assert.equal(writes, 3);
  } finally { scoped.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
});
