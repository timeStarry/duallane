import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentBridgeRequest, parseAgentBridgeResult, resolveAgentTrigger, safeAgentError } from "../src/bridge-protocol.js";
import { validateArtifactBytes } from "../src/media.js";

const human = { id: "message-1", authorKind: "human", plainText: "make an image" };
const bot = { id: "message-2", authorKind: "bot", plainText: "old response" };

test("exact trigger is anchored before a later Bot response and shared by bridge input", () => {
  const event = { eventId: "e", conversationId: "c", payload: { messageId: human.id } };
  const request = buildAgentBridgeRequest({ taskId: "t", event, context: { messages: [human, bot] }, conversation: { id: "c" } });
  assert.equal(request.triggerMessage.id, human.id);
  assert.equal(request.protocol, "duallane.agent.request");
  assert.equal(request.capabilities.localPathOutput, false);
  assert.deepEqual(request.event, event);
});

test("missing explicit trigger never substitutes other history or payload text", () => {
  assert.throws(() => resolveAgentTrigger({ payload: { messageId: "missing", text: "truncated" } }, { messages: [human, bot] }), { code: "input.trigger_unavailable" });
  assert.throws(() => resolveAgentTrigger({ payload: { messageId: bot.id } }, { messages: [human, bot] }), { code: "input.trigger_unavailable" });
});

test("read-trigger-only events require the server's exact complete-text marker", () => {
  const event = { payload: { messageId: "specific", text: "bounded complete request", textComplete: true } };
  assert.deepEqual(resolveAgentTrigger(event, null), { id: "specific", authorKind: "human", plainText: "bounded complete request" });
  assert.throws(() => resolveAgentTrigger({ payload: { ...event.payload, textComplete: false } }, null), { code: "input.trigger_unavailable" });
  assert.throws(() => resolveAgentTrigger({ type: "command.invoked", payload: { argsComplete: false } }, null), { code: "input.trigger_truncated" });
  assert.equal(resolveAgentTrigger({ type: "card.action", payload: { messageId: "card-source" } }, null), null);
});

test("legacy events fall back only to human/user messages", () => {
  assert.equal(resolveAgentTrigger({ payload: {} }, { messages: [human, bot] }).id, human.id);
  assert.throws(() => resolveAgentTrigger({}, { messages: [bot] }), { code: "input.trigger_unavailable" });
  assert.equal(resolveAgentTrigger({ payload: { text: "bounded trigger" } }, { messages: [bot] }).plainText, "bounded trigger");
  assert.equal(resolveAgentTrigger({ type: "command.invoked" }, null), null);
});

const result = (patch = {}) => JSON.stringify({ protocol: "duallane.agent.result", version: 1, status: "completed", text: "document", artifacts: [], ...patch });

test("structured results require explicit completion and matching protocol/task", () => {
  assert.throws(() => parseAgentBridgeResult(result({ status: "running" })), { code: "bridge.incomplete" });
  assert.throws(() => parseAgentBridgeResult(result({ version: 2 })), { code: "bridge.protocol_unsupported" });
  assert.throws(() => parseAgentBridgeResult(result({ taskId: "other" }), { taskId: "actual" }), { code: "bridge.task_mismatch" });
  assert.throws(() => parseAgentBridgeResult(result({ status: "cancelled" })), { code: "bridge.cancelled" });
});

test("artifacts validate names, canonical base64, digest, MIME and limits", () => {
  const artifact = { id: "a", source: "inline", fileName: "report.txt", mimeType: "text/plain", encoding: "base64", data: Buffer.from("hello").toString("base64") };
  const parsed = parseAgentBridgeResult(result({ artifacts: [artifact] }), { validateBytes: validateArtifactBytes });
  assert.equal(parsed.artifacts[0].bytes.toString(), "hello");
  for (const [patch, code] of [[{ fileName: "../secret" }, "artifact.invalid_name"], [{ data: "%%%%" }, "artifact.invalid_base64"], [{ sha256: "bad" }, "artifact.digest_mismatch"], [{ byteSize: 999 }, "artifact.size_mismatch"]]) {
    assert.throws(() => parseAgentBridgeResult(result({ artifacts: [{ ...artifact, ...patch }] })), { code });
  }
  assert.throws(() => parseAgentBridgeResult(result({ artifacts: [artifact, artifact] })), { code: "artifact.invalid_id" });
  assert.throws(() => parseAgentBridgeResult(result({ artifacts: [{ ...artifact, mimeType: "image/png" }] }), { validateBytes: validateArtifactBytes }));
});

test("legacy text and inline document tags remain bounded; path tags are explicit denial", () => {
  const parsed = parseAgentBridgeResult('report\n<duallane-file name="report.md"># hello</duallane-file>', { validateBytes: validateArtifactBytes });
  assert.equal(parsed.text, "report");
  assert.equal(parsed.artifacts[0].bytes.toString(), "# hello");
  assert.throws(() => parseAgentBridgeResult("[[DUALLANE_FILE: C:/private/file.txt]]"), { code: "artifact.local_path_denied" });
  assert.equal(parseAgentBridgeResult("![link](https://example.com/image.png)").artifacts.length, 0);
});

test("error projections exclude raw exception text and reject unsafe codes", () => {
  const error = new Error("private prompt token=secret path=/private"); error.code = "private value";
  assert.deepEqual(safeAgentError(error, "sending"), { code: "task.failed", stage: "sending", retryable: false });
});
