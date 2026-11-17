import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DualLaneAgentClient, buildMessageContent, messageText, messageMention } from "../src/index.js";
import { createTaskToolServer, buildAgentInteractiveCard } from "../src/task-tools.js";
import { createDualLaneMcpServer } from "../src/mcp.js";
import { saveAgentProfile } from "../src/profile-store.js";

const token = `dl_bot_${"a".repeat(32)}`;
const version = "b".repeat(64);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const task = () => ({ id: "task", conversationId: "conversation", triggerMessageId: "trigger", expiresAt: new Date(Date.now() + 60_000).toISOString() });

function fixture() {
  const record = task(), requests = [];
  let conflict = false, revoked = false, features = { conditionalMessageEdit: true, taskCardUpdate: true };
  const client = new DualLaneAgentClient({ url: "https://gateway.example", token, fetch: async (url, init) => {
    const route = new URL(url).pathname;
    requests.push({ route, init, body: init.body ? JSON.parse(init.body) : undefined });
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    if (route === `/api/bot/v2/tasks/${record.id}`) return revoked ? response({ error: { code: "task.revoked" } }, 403) : response({ task: record });
    assert.equal(init.headers["x-duallane-task"], record.id);
    if (route.endsWith("/capabilities")) return response({ features });
    if (route.includes("/operations/")) return response(route.endsWith("/missing") ? { status: "unknown", safeToRetry: false } : { status: "committed", result: { message: { id: "sent" } }, humanRead: false });
    if (init.method === "GET") return response({ message: { id: "own", conversationId: record.conversationId, version } });
    if (conflict) return response({ error: { code: "message.version_conflict" } }, 409);
    return response({ message: { id: "sent", version }, card: { id: "card", revision: 3 } });
  } });
  return { record, requests, client, scoped: client.forTask(record), conflict() { conflict = true; }, revoke() { revoked = true; }, features(value) { features = value; } };
}

test("conditional edits read a missing version once, preserve plainText, and never overwrite conflicts", async () => {
  const f = fixture();
  try {
    const id = "m".repeat(128);
    const sent = await f.scoped.editMessage(id, "updated");
    assert.deepEqual(sent.operation, { taskId: f.record.id, operation: "message.edit", key: `edit_${hash(`${id}:${version}`)}` });
    assert.equal(sent.operation.key.length, 69);
    assert.equal(f.requests.filter((r) => r.route.endsWith(`/messages/${id}`) && r.init.method === "GET").length, 1);
    assert.deepEqual(f.requests.at(-1).body, { plainText: "updated", expectedVersion: version });
    const content = buildMessageContent([messageMention("member", "M"), messageText("replacement")]);
    await f.scoped.editMessage(id, { content, expectedVersion: version });
    assert.deepEqual(f.requests.at(-1).body, { content, expectedVersion: version });
    f.conflict();
    const before = f.requests.length;
    await assert.rejects(f.scoped.editMessage(id, { plainText: "conflicting", expectedVersion: version }), (error) => error.statusCode === 409 && error.operation.key === sent.operation.key);
    assert.equal(f.requests.slice(before).filter((r) => r.init.method === "PATCH").length, 1);
    assert.equal(f.requests.slice(before).filter((r) => r.route.includes("/messages/") && r.init.method === "GET").length, 0);
  } finally { f.scoped.close(); }
});

test("operation coordination is task bound, read only, and cannot bypass revocation", async () => {
  const f = fixture();
  try {
    const committed = await f.scoped.getOperation("message.edit", `edit_${hash("own:" + version)}`);
    assert.equal(committed.status, "committed"); assert.equal(committed.humanRead, false);
    assert.deepEqual(await f.scoped.getOperation("message.send", "missing"), { status: "unknown", safeToRetry: false });
    assert.ok(f.requests.every((r) => r.init.method === "GET"));
    const before = f.requests.length; f.revoke();
    await assert.rejects(f.scoped.getOperation("message.send", "missing"), { code: "task.revoked" });
    assert.equal(f.requests.length, before + 1);
  } finally { f.scoped.close(); }
});

test("legacy text editing remains compatible and structured editing requires a task", async () => {
  const requests = [];
  const client = new DualLaneAgentClient({ url: "https://gateway.example", token, fetch: async (_url, init) => { requests.push(JSON.parse(init.body)); return response({ message: { id: "old" } }); } });
  await client.editMessage("old", " legacy ");
  assert.deepEqual(requests, [{ plainText: "legacy" }]);
  await assert.rejects(client.editMessage("old", { plainText: "conditional", expectedVersion: version }), { code: "task.context_required" });
  await assert.rejects(client.editMessage("old", { content: buildMessageContent([messageText("replace")]) }), { code: "task.context_required" });
  assert.equal(requests.length, 1);
});

test("task card/edit tools follow current features and fixed actions, with bounded update keys", async () => {
  const f = fixture(), tools = createTaskToolServer(f.scoped);
  try {
    const names = (await tools.getTools()).map((tool) => tool.name);
    assert.ok(names.includes("duallane_edit_message")); assert.ok(names.includes("duallane_update_card")); assert.ok(names.includes("duallane_query_operation"));
    const card = { title: "Review", markdown: "Done", buttons: [{ actionId: "confirm", label: "OK", value: { action: "arbitrary", id: "1" } }] };
    assert.equal(buildAgentInteractiveCard(card).elements.at(-1).actions[0].value.action, "confirm");
    assert.throws(() => buildAgentInteractiveCard({ ...card, buttons: [{ actionId: "run_shell", label: "No" }] }), { code: "card.invalid_action" });
    await assert.rejects(tools.callTool("duallane_update_card", { cardId: "card", ...card }, "no-revision"), { code: "tool.invalid_arguments" });
    const id = "c".repeat(128);
    const updated = await tools.callTool("duallane_update_card", { cardId: id, expectedRevision: 2, ...card }, "update");
    assert.deepEqual(updated.operation, { taskId: f.record.id, operation: "card.update", key: `card_${hash(`${id}:2`)}` });
    assert.equal(f.requests.at(-1).body.expectedRevision, 2);
    const before = f.requests.filter((r) => r.init.method === "PATCH").length;
    await tools.callTool("duallane_update_card", { cardId: id, expectedRevision: 2, ...card }, "update");
    assert.equal(f.requests.filter((r) => r.init.method === "PATCH").length, before);
    f.features({});
    assert.equal((await tools.getTools()).some((tool) => tool.name === "duallane_update_card"), false);
    await assert.rejects(tools.callTool("duallane_edit_message", { messageId: "own", plainText: "x" }, "edit"), { code: "tool.not_available" });
    await assert.rejects(tools.callTool("duallane_update_card", { cardId: id, expectedRevision: 2, ...card, profile: "other" }, "profile"), { code: "tool.invalid_arguments" });
  } finally { f.scoped.close(); }
});

test("unknown task write exposes its reference for query without resubmitting", async () => {
  const f = fixture(); let writes = 0;
  const tools = createTaskToolServer({ ...f.scoped, async sendMessage() { writes++; throw Object.assign(new Error("timeout"), { code: "network.timeout" }); } });
  try {
    const message = { jsonrpc: "2.0", id: "write", method: "tools/call", params: { name: "duallane_send_message", arguments: { text: "hello" } } };
    const failed = await tools.handleJsonRpc(message);
    const reference = JSON.parse(failed.result.content[0].text).error.operation;
    assert.equal(reference.operation, "message.send");
    assert.equal((await tools.callTool("duallane_query_operation", { operation: reference.operation, key: reference.key })).status, "committed");
    await tools.handleJsonRpc(message);
    assert.equal(writes, 1);
  } finally { f.scoped.close(); }
});

test("operator CLI and MCP align conditional edits, card updates and operation queries", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-conditional-cli-"));
  const record = task(), writes = [];
  const server = http.createServer(async (request, output) => {
    output.setHeader("content-type", "application/json");
    if (request.url.endsWith(`/tasks/${record.id}`)) { output.end(JSON.stringify({ task: record })); return; }
    assert.equal(request.headers["x-duallane-task"], record.id);
    if (request.url.includes("/capabilities")) { output.end(JSON.stringify({ features: { conditionalMessageEdit: true, taskCardUpdate: true } })); return; }
    if (request.url.includes("/operations/")) { output.end(JSON.stringify({ status: "unknown", safeToRetry: false })); return; }
    if (request.method === "GET") { output.end(JSON.stringify({ message: { id: "own", version, conversationId: record.conversationId } })); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    writes.push({ method: request.method, body: JSON.parse(raw) });
    output.end(JSON.stringify({ message: { id: "own", version }, card: { id: "card", revision: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  saveAgentProfile("default", { url: `http://127.0.0.1:${server.address().port}`, token }, { configDir: directory });
  const cli = fileURLToPath(new URL("../bin/duallane-agent.mjs", import.meta.url));
  const run = (args) => promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, DUALLANE_AGENT_CONFIG_DIR: directory }, windowsHide: true, timeout: 10_000 });
  try {
    const content = buildMessageContent([messageMention("member", "M"), messageText("replacement")]);
    await run(["edit", "own", "--content-json", JSON.stringify(content), "--expected-version", version, "--task-id", record.id]);
    const mcp = createDualLaneMcpServer({ configDir: directory });
    await mcp.callTool("duallane_edit_message", { taskId: record.id, messageId: "own", plainText: "plain" });
    const card = { title: "Card", markdown: "Body", buttons: [{ actionId: "refresh", label: "Refresh" }] };
    await run(["update-card", "card", "--card-json", JSON.stringify(card), "--expected-revision", "1", "--task-id", record.id]);
    await mcp.callTool("duallane_update_card", { taskId: record.id, cardId: "card", expectedRevision: 1, ...card });
    assert.deepEqual(JSON.parse((await run(["operation", record.id, "message.send", "missing"])).stdout), { status: "unknown", safeToRetry: false });
    assert.deepEqual(await mcp.callTool("duallane_query_operation", { taskId: record.id, operation: "message.send", key: "missing" }), { status: "unknown", safeToRetry: false });
    assert.equal(writes.length, 4);
    assert.deepEqual(writes[0].body.content, content);
    assert.deepEqual(writes[1].body, { plainText: "plain", expectedVersion: version });
    assert.equal(writes[2].body.expectedRevision, 1); assert.equal(writes[3].body.expectedRevision, 1);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
});
