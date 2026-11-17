import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentTaskRuntime, readAgentTaskSummary, recoverAgentTaskOwner, requestAgentTaskControl } from "../src/task-runtime.js";
import { validateArtifactBytes } from "../src/media.js";
import { invokeDaemonAgentTurn } from "../src/daemon.js";
import { DualLaneAgentClient } from "../src/index.js";

function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "duallane-task-"));
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const calls = { invoke: 0, uploads: [], sends: [] }, published = [];
  const client = {
    async listConversations() { return { conversations: ["c", "other"].map((id) => ({ id, type: "group", allowContext: true, allowSend: true, allowTrigger: true })) }; },
    async getContext(conversationId) { return { messages: [{ id: "trigger", authorKind: "human", plainText: "request" }, ...published.filter((item) => item.conversationId === conversationId)] }; },
    async uploadFile(input) { calls.uploads.push(input); return { attachment: { id: `attachment-${calls.uploads.length}` } }; },
    async sendMessage(input) { calls.sends.push(input); const id = `message-${calls.sends.length}`; published.push({ id, conversationId: input.conversationId, authorKind: "bot", plainText: input.text || "artifact", content: input.content }); return { message: { id } }; },
    async readAttachment(input) { const uploaded = calls.uploads[Number(input.attachmentId.split("-").at(-1)) - 1]; if (!uploaded) throw Object.assign(new Error("denied"), { code: "file.not_found", statusCode: 404 }); return { bytes: uploaded.bytes, mimeType: uploaded.mimeType }; },
    ...overrides.client,
  };
  const options = { stateDir: directory, origin: "https://example.com", botId: "bot", client,
    scopes: ["messages:read_context", "files:write"], validateBytes: validateArtifactBytes,
    retryDelayMs: 1, maxAttempts: 1,
    async invoke() { calls.invoke++; return "answer"; }, ...overrides, client };
  const runtime = createAgentTaskRuntime(options);
  return { directory, options, runtime, calls, published,
    async cleanup() { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
const event = (id = "event", conversationId = "c") => ({ eventId: id, sequence: 1, type: "message.created", conversationId, payload: { messageId: "trigger" } });
const document = (extra = {}) => JSON.stringify({ protocol: "duallane.agent.result", version: 1, status: "completed", text: "report", artifacts: [
  { id: "report", source: "inline", fileName: "report.txt", mimeType: "text/plain", encoding: "utf8", data: "synthetic document" }], ...extra });

test("durable acceptance precedes work; duplicates survive restart without another invocation", async () => {
  const f = fixture();
  try {
    const accepted = f.runtime.accept(event());
    assert.equal(f.calls.invoke, 0);
    assert.equal(readAgentTaskSummary(f.options).tasks[0].state, "received");
    assert.equal(f.runtime.accept(event()).duplicate, true);
    await f.runtime.close();
    const resumed = createAgentTaskRuntime(f.options);
    try {
      resumed.start(); await resumed.idle();
      assert.equal(f.calls.invoke, 1); assert.equal(f.calls.sends.length, 1);
      assert.equal(resumed.getTask(accepted.taskId).state, "completed");
      assert.equal(resumed.accept(event()).duplicate, true);
    } finally { await resumed.close(); }
  } finally { await f.cleanup(); }
});

test("one Bot/origin has one local owner and private state files", async () => {
  const f = fixture();
  try {
    assert.throws(() => createAgentTaskRuntime(f.options), { code: "runtime.owner_busy" });
    f.runtime.accept(event());
    if (process.platform !== "win32") {
      for (const dir of fs.readdirSync(f.directory)) for (const file of fs.readdirSync(path.join(f.directory, dir))) {
        assert.equal(fs.statSync(path.join(f.directory, dir, file)).mode & 0o077, 0);
      }
    }
  } finally { await f.cleanup(); }
});

test("reprojected message text reuses the durable task while a changed source is rejected", async () => {
  const f = fixture();
  try {
    const original = event();
    original.payload = { messageId: "trigger", text: "accepted text", textComplete: true };
    const { taskId } = f.runtime.accept(original);
    const replay = { ...original, payload: { ...original.payload, text: "edited text" } };
    assert.equal(f.runtime.accept(replay).duplicate, true);
    assert.equal(f.runtime.getTask(taskId).event.payload.text, "accepted text");
    assert.throws(() => f.runtime.accept({ ...replay, payload: { ...replay.payload, messageId: "another-message" } }), { code: "task.event_conflict" });
    assert.throws(() => f.runtime.accept({ ...replay, conversationId: "other" }), { code: "task.event_conflict" });
    f.runtime.start(); await f.runtime.idle();
    await f.runtime.close();
    const resumed = createAgentTaskRuntime(f.options);
    try {
      assert.equal(resumed.accept(replay).duplicate, true);
      resumed.start(); await resumed.idle();
      assert.equal(f.calls.invoke, 1); assert.equal(f.calls.sends.length, 1);
    } finally { await resumed.close(); }
  } finally { await f.cleanup(); }
});

test("failed send resumes from the uploaded receipt without regenerating or reuploading", async () => {
  let failures = 1;
  const f = fixture({ async invoke() { f.calls.invoke++; return document(); },
    client: { async sendMessage(input) {
      f.calls.sends.push(input);
      if (input.content && failures--) throw Object.assign(new Error("private server details"), { code: "network.unavailable", retryable: true });
      return { message: { id: `message-${f.calls.sends.length}` } };
    } } });
  try {
    const { taskId } = f.runtime.accept(event()); f.runtime.start(); await f.runtime.idle();
    assert.equal(f.runtime.getTask(taskId).state, "failed");
    assert.equal(f.calls.uploads.length, 1);
    assert.match(f.calls.sends.at(-1).text, /network.unavailable/u);
    assert.doesNotMatch(f.calls.sends.at(-1).text, /private server details/u);
    f.runtime.retry(taskId); await f.runtime.idle();
    assert.equal(f.runtime.getTask(taskId).state, "completed");
    assert.equal(f.calls.uploads.length, 1); assert.equal(f.calls.invoke, 1);
    const attempts = f.calls.sends.filter((input) => input.content);
    assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey);
  } finally { await f.cleanup(); }
});

test("unknown upload outcome is not blindly retried or counted as completion", async () => {
  const f = fixture({ async invoke() { return document(); }, maxAttempts: 3,
    client: { async uploadFile(input) { f.calls.uploads.push(input); throw Object.assign(new Error("secret"), { code: "network.timeout", retryable: true }); } } });
  try {
    const { taskId } = f.runtime.accept(event()); f.runtime.start(); await f.runtime.idle();
    const task = f.runtime.getTask(taskId);
    assert.equal(task.state, "failed"); assert.equal(task.error.code, "upload.outcome_unknown");
    assert.equal(f.calls.uploads.length, 1); assert.throws(() => f.runtime.retry(taskId), { code: "upload.outcome_unknown" });
    assert.equal(f.calls.sends.some((input) => input.content), false);
  } finally { await f.cleanup(); }
});

test("Go quota rejection remains a definite failure and can retry after quota recovery", async () => {
  let quotaAvailable = false, completions = 0, reservations = 0;
  const client = new DualLaneAgentClient({ url: "https://example.com", token: `dl_bot_${"q".repeat(32)}`,
    async fetch(url, init) {
      let body;
      if (String(url).endsWith("/attachments")) {
        assert.equal(init.method, "POST"); reservations++;
        body = { upload: quotaAvailable
          ? { status: "reserved", id: "transfer-1", attachment: { id: "attachment-1", status: "pending" }, upload: { id: "transfer-1", mode: "single", partSize: 18, partCount: 1 } }
          : { status: "rejected", usedToday: 100, remainingBytes: 0, dailyQuotaBytes: 100 } };
      } else if (String(url).endsWith("/uploads/transfer-1/content")) {
        assert.equal(init.method, "PUT"); completions++;
        body = { ok: true, upload: { status: "completed" }, attachment: { id: "attachment-1", status: "available" } };
      } else assert.fail(`unexpected gateway request: ${url}`);
      return new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
    } });
  const f = fixture({ async invoke() { f.calls.invoke++; return document(); }, client: {
    reserveUpload: (input) => client.reserveUpload(input),
    completeUploadContent: (...args) => client.completeUploadContent(...args),
    getUploadStatus: (id) => client.getUploadStatus(id),
  } });
  try {
    const { taskId } = f.runtime.accept(event()); f.runtime.start(); await f.runtime.idle();
    const rejected = f.runtime.getTask(taskId);
    assert.equal(rejected.state, "failed");
    assert.equal(rejected.error.code, "quota.insufficient");
    assert.equal(rejected.artifacts[0].state, "generated");
    assert.equal(completions, 0);
    quotaAvailable = true; f.runtime.retry(taskId); await f.runtime.idle();
    assert.equal(f.runtime.getTask(taskId).state, "completed");
    assert.equal(reservations, 2); assert.equal(completions, 1); assert.equal(f.calls.invoke, 1);
  } finally { await f.cleanup(); }
});

test("same conversation remains serial while independent conversations use bounded parallelism", async () => {
  const releases = new Map(), started = [];
  const f = fixture({ maxConcurrency: 2, invoke(request) { started.push(request.event.eventId); return new Promise((resolve) => releases.set(request.event.eventId, resolve)); } });
  try {
    f.runtime.accept(event("a")); f.runtime.accept(event("b")); f.runtime.accept(event("c", "other")); f.runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["a", "c"]);
    releases.get("a")("first"); releases.get("c")("third");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["a", "c", "b"]);
    releases.get("b")("second"); await f.runtime.idle();
  } finally { await f.cleanup(); }
});

test("cross-turn artifact references require same conversation and currently visible source receipt", async () => {
  let reference;
  const f = fixture({ scopes: ["messages:read_context", "files:write", "files:read_content"], async invoke(request) {
    if (!reference) return document();
    return document({ artifacts: [{ id: "reuse", source: "artifact", artifactId: reference }] });
  } });
  try {
    const first = f.runtime.accept(event("first")); f.runtime.start(); await f.runtime.idle();
    reference = f.runtime.getTask(first.taskId).artifacts[0].artifactId;
    const second = f.runtime.accept(event("second")); await f.runtime.idle();
    assert.equal(f.runtime.getTask(second.taskId).state, "completed");
    assert.equal(f.calls.uploads.length, 1);
    const foreign = f.runtime.accept(event("foreign", "other")); await f.runtime.idle();
    assert.equal(f.runtime.getTask(foreign.taskId).error.code, "artifact.reference_denied");
    f.published.length = 0;
    const revoked = f.runtime.accept(event("revoked")); await f.runtime.idle();
    assert.equal(f.runtime.getTask(revoked.taskId).error.code, "artifact.reference_denied");
  } finally { await f.cleanup(); }
});

test("cancellation during publication authorization fences both text and artifact side effects", async () => {
  for (const artifactResult of [false, true]) {
    let checks = 0, release, reached;
    const authorized = new Promise((resolve) => { reached = resolve; });
    const f = fixture({ async invoke() { return artifactResult ? document() : "answer"; }, client: {
      async listConversations() {
        if (++checks === 2) { reached(); await new Promise((resolve) => { release = resolve; }); }
        return { conversations: [{ id: "c", type: "group", allowContext: true, allowSend: true, allowTrigger: true }] };
      },
    } });
    try {
      const { taskId } = f.runtime.accept(event()); f.runtime.start(); await authorized;
      f.runtime.cancel(taskId); release(); await f.runtime.idle();
      assert.equal(f.calls.sends.length, 0); assert.equal(f.calls.uploads.length, 0);
      assert.equal(f.runtime.getTask(taskId).state, "cancelled");
    } finally { await f.cleanup(); }
  }
});

test("cancellation after a reservation receipt prevents content transfer and publication", async () => {
  let release, reached, completions = 0;
  const reserved = new Promise((resolve) => { reached = resolve; });
  const f = fixture({ async invoke() { return document(); }, client: {
    async reserveUpload() { reached(); await new Promise((resolve) => { release = resolve; }); return { upload: { id: "reservation" } }; },
    async completeUploadContent() { completions++; return { attachment: { id: "unexpected" } }; },
    async getUploadStatus() { throw new Error("not needed"); },
  } });
  try {
    const { taskId } = f.runtime.accept(event()); f.runtime.start(); await reserved;
    f.runtime.cancel(taskId); release(); await f.runtime.idle();
    assert.equal(completions, 0); assert.equal(f.calls.sends.length, 0);
    assert.equal(f.runtime.getTask(taskId).artifacts[0].uploadId, "reservation");
    assert.equal(f.runtime.getTask(taskId).state, "cancelled");
  } finally { await f.cleanup(); }
});

test("definitive completion quota rejection keeps its error and permits a safe explicit retry", async () => {
  let completions = 0, statusReads = 0;
  const f = fixture({ async invoke() { return document(); }, client: {
    async reserveUpload() { return { upload: { id: "reservation" } }; },
    async completeUploadContent() {
      if (++completions === 1) throw Object.assign(new Error("safe rejection"), { code: "file.transfer_quota_exceeded", statusCode: 429 });
      return { attachment: { id: "successful" } };
    },
    async getUploadStatus() { statusReads++; return { upload: { status: "reserved" } }; },
  } });
  try {
    const { taskId } = f.runtime.accept(event()); f.runtime.start(); await f.runtime.idle();
    assert.equal(f.runtime.getTask(taskId).error.code, "file.transfer_quota_exceeded");
    assert.equal(f.runtime.getTask(taskId).artifacts[0].state, "reserved");
    f.runtime.retry(taskId); await f.runtime.idle();
    assert.equal(f.runtime.getTask(taskId).state, "completed");
    assert.equal(completions, 2); assert.equal(statusReads, 0);
  } finally { await f.cleanup(); }
});

test("offline lock recovery removes a crashed empty acquisition gate but refuses live owners and claimants", async () => {
  const f = fixture();
  try {
    assert.throws(() => recoverAgentTaskOwner(f.options, { confirmStopped: true }), { code: "runtime.owner_busy" });
    await f.runtime.close();
    const directory = path.join(f.directory, fs.readdirSync(f.directory)[0]);
    const gate = path.join(directory, "owner-acquisition");
    fs.mkdirSync(gate, { mode: 0o700 });
    assert.throws(() => createAgentTaskRuntime(f.options), { code: "runtime.owner_busy" });
    assert.throws(() => recoverAgentTaskOwner(f.options), { code: "runtime.offline_confirmation_required" });
    assert.deepEqual(recoverAgentTaskOwner(f.options, { confirmStopped: true }), { recovered: true });
    const resumed = createAgentTaskRuntime(f.options); await resumed.close();
    fs.mkdirSync(gate, { mode: 0o700 });
    const claimant = path.join(gate, "claimant.json");
    fs.writeFileSync(claimant, JSON.stringify({ pid: process.pid, nonce: "live" }), { mode: 0o600 });
    assert.throws(() => recoverAgentTaskOwner(f.options, { confirmStopped: true }), { code: "runtime.owner_busy" });
    assert.equal(fs.existsSync(claimant), true);
  } finally { await f.cleanup(); }
});

test("cross-turn reads reject recalled or detached references and revoked/deleted server access", async () => {
  for (const mutation of ["detached", "recalled", "deleted", "scope"]) {
    let reference;
    const f = fixture({ scopes: ["messages:read_context", "files:write", "files:read_content"],
      async invoke() { return reference ? document({ artifacts: [{ id: "reuse", source: "artifact", artifactId: reference }] }) : document(); } });
    try {
      const first = f.runtime.accept(event("first")); f.runtime.start(); await f.runtime.idle();
      reference = f.runtime.getTask(first.taskId).artifacts[0].artifactId;
      if (mutation === "detached") f.published[0].content = { blocks: [] };
      if (mutation === "recalled") f.published[0].recalledAt = new Date().toISOString();
      if (["deleted", "scope"].includes(mutation)) f.options.client.readAttachment = async () => {
        throw Object.assign(new Error("private forbidden details"), { code: mutation === "scope" ? "bot.scope_required" : "file.not_found", statusCode: mutation === "scope" ? 403 : 404 });
      };
      const next = f.runtime.accept(event("next")); await f.runtime.idle();
      assert.equal(f.runtime.getTask(next.taskId).state, "failed", mutation);
      assert.equal(f.calls.sends.filter((input) => input.content).length, 1, mutation);
      assert.equal(f.calls.uploads.length, 1, mutation);
    } finally { await f.cleanup(); }
  }
});

test("current authorized prior artifact bytes enter the bridge under the shared input budget", async () => {
  let round = 0;
  const f = fixture({ scopes: ["messages:read_context", "files:write", "files:read_content"],
    async invoke(request) {
      if (++round === 1) return document();
      const prior = request.inputs.find((input) => input.artifactId);
      assert.ok(prior); assert.equal(prior.trust, "untrusted-attachment");
      assert.equal(Buffer.from(prior.data, "base64").toString(), "synthetic document");
      assert.ok(request.inputs.reduce((sum, input) => sum + (input.byteSize || 0), 0) <= 10 * 1024 * 1024);
      return "modified based on authorized reference";
    } });
  try {
    f.runtime.accept(event("first")); f.runtime.start(); await f.runtime.idle();
    const next = f.runtime.accept(event("next")); await f.runtime.idle();
    assert.equal(f.runtime.getTask(next.taskId).state, "completed");
  } finally { await f.cleanup(); }
});

test("a lost completion response reconciles the durable reservation without retransferring bytes", async () => {
  let reserved = 0, completed = 0, inspected = 0;
  const f = fixture({ async invoke() { return document(); }, client: {
    async reserveUpload() { reserved++; return { upload: { id: "upload-1" } }; },
    async completeUploadContent() { completed++; throw Object.assign(new Error("lost response"), { retryable: true }); },
    async getUploadStatus(uploadId) { inspected++; assert.equal(uploadId, "upload-1"); return { upload: { status: "completed", attachment: { id: "attachment-existing" } } }; },
  } });
  try {
    const { taskId } = f.runtime.accept(event()); f.runtime.start(); await f.runtime.idle();
    assert.equal(f.runtime.getTask(taskId).state, "completed");
    assert.deepEqual([reserved, completed, inspected], [1, 1, 1]);
    assert.equal(f.calls.sends[0].content.blocks.at(-1).attachmentId, "attachment-existing");
  } finally { await f.cleanup(); }
});

test("restart during completion only reconciles status and never repeats a reservation or transfer", async () => {
  let inspected = 0;
  const f = fixture({ async invoke() { return document(); }, client: {
    async reserveUpload() { return { upload: { id: "known-upload" } }; },
    async completeUploadContent() { throw Object.assign(new Error("lost response"), { retryable: true }); },
    async getUploadStatus() { inspected++; return { upload: inspected === 1 ? { status: "reserved" } : { status: "completed", attachment: { id: "recovered-attachment" } } }; },
  } });
  try {
    const { taskId } = f.runtime.accept(event()); f.runtime.start(); await f.runtime.idle();
    assert.equal(f.runtime.getTask(taskId).error.code, "upload.status_pending");
    await f.runtime.close();
    const resumed = createAgentTaskRuntime({ ...f.options, client: { ...f.options.client,
      async reserveUpload() { throw new Error("must not reserve again"); },
      async completeUploadContent() { throw new Error("must not transfer again"); },
    } });
    try {
      resumed.retry(taskId); resumed.start(); await resumed.idle();
      assert.equal(resumed.getTask(taskId).state, "completed"); assert.equal(inspected, 2);
    } finally { await resumed.close(); }
  } finally { await f.cleanup(); }
});

test("retry backoff preserves conversation order and expiry removes artifact bytes", async () => {
  let time = 10_000, first = true; const order = [];
  const f = fixture({ now: () => time, maxAttempts: 2, retryDelayMs: 50, retentionMs: 60_000,
    async invoke(request) { order.push(request.event.eventId); if (first) { first = false; throw Object.assign(new Error("offline"), { retryable: true }); } return document(); } });
  try {
    f.runtime.accept(event("first")); f.runtime.accept(event("second")); f.runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["first"]);
    time += 50; await new Promise((resolve) => setTimeout(resolve, 55)); await f.runtime.idle();
    assert.deepEqual(order, ["first", "first", "second"]);
    time += 60_001; f.runtime.accept(event("third"), { completed: true });
    const files = fs.readdirSync(path.join(f.directory, fs.readdirSync(f.directory)[0]));
    assert.equal(files.some((name) => name.endsWith(".blob")), false);
  } finally { await f.cleanup(); }
});

test("storage limits, expiry and operator retry controls are bounded", async () => {
  let time = 1000, fail = true;
  const f = fixture({ now: () => time, retentionMs: 60_000, maxTasks: 1,
    async invoke() { if (fail) throw new Error("private path"); return "ok"; } });
  try {
    const { taskId } = f.runtime.accept(event());
    assert.throws(() => f.runtime.accept(event("next")), { code: "runtime.queue_full" });
    f.runtime.start(); await f.runtime.idle(); fail = false;
    requestAgentTaskControl(f.options, taskId, "retry");
    await new Promise((resolve) => setTimeout(resolve, 30)); await f.runtime.idle();
    assert.equal(f.runtime.getTask(taskId).state, "completed");
    time += 60_001;
    const next = f.runtime.accept(event("next")); await f.runtime.idle();
    assert.equal(f.runtime.getTask(taskId), null); assert.equal(f.runtime.getTask(next.taskId).state, "completed");
  } finally { await f.cleanup(); }
});

test("actual command process participates in event to artifact upload and message receipt", async () => {
  const f = fixture();
  try {
    await f.runtime.close();
    const bridge = path.join(f.directory, "bridge.mjs");
    fs.writeFileSync(bridge, `let input=''; for await (const chunk of process.stdin) input+=chunk; const request=JSON.parse(input); if(request.triggerMessage.id!=='trigger') process.exit(2); process.stdout.write(${JSON.stringify(document())});`);
    const runtime = createAgentTaskRuntime({ ...f.options, invoke: (request, { signal }) => invokeDaemonAgentTurn({
      customCmd: `"${process.execPath}" "${bridge}"`, workdir: f.directory, request, signal, timeoutMs: 5000 }) });
    try {
      const { taskId } = runtime.accept(event()); runtime.start(); await runtime.idle();
      assert.equal(runtime.getTask(taskId).state, "completed");
      assert.equal(f.calls.uploads[0].bytes.toString(), "synthetic document");
      assert.equal(f.calls.sends[0].content.blocks.at(-1).attachmentId, "attachment-1");
      assert.equal(f.calls.sends[0].replyToMessageId, "trigger");
    } finally { await runtime.close(); }
  } finally { await f.cleanup(); }
});

test("command timeout and stderr failure never return private output", async () => {
  const f = fixture();
  try {
    const bridge = path.join(f.directory, "fail.mjs");
    fs.writeFileSync(bridge, "process.stderr.write('private-token-and-path'); process.exitCode=1;");
    const args = { customCmd: `"${process.execPath}" "${bridge}"`, workdir: f.directory, request: { event: event() }, timeoutMs: 1000 };
    await assert.rejects(() => invokeDaemonAgentTurn(args), (error) => error.code === "bridge.failed" && !error.message.includes("private"));
    fs.writeFileSync(bridge, "setInterval(()=>{},1000)");
    await assert.rejects(() => invokeDaemonAgentTurn({ ...args, timeoutMs: 100 }), { code: "bridge.timeout" });
  } finally { await f.cleanup(); }
});
