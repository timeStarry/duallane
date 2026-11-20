import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { DualLaneAgentClient } from "../src/index.js";

const token = `dl_bot_${"z".repeat(32)}`;
const client = (fetch, options = {}) => new DualLaneAgentClient({ url: "https://gateway.example", token, fetch, ...options });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("gateway deadline covers fetch and a stalled response body", async () => {
  for (const fetch of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } })]) {
    await assert.rejects(client(fetch, { requestTimeoutMs: 15 }).getMe(), (e) => e.code === "network.timeout" && e.retryable && !e.cause);
  }
});

test("HTML or malformed JSON success is not a successful operation", async () => {
  for (const response of [new Response("<html>proxy</html>"), new Response("{", { headers: { "content-type": "application/json" } })]) {
    await assert.rejects(client(async () => response).getMe(), (e) => e.code === "gateway.invalid_response");
  }
});

test("gateway rejects redirected credentials and redacts arbitrary errors", async () => {
  await assert.rejects(client(async (_url, init) => {
    assert.equal(init.redirect, "error");
    throw new Error(`private/path ${token}`);
  }).getMe(), (e) => !JSON.stringify(e).includes(token) && !e.cause && !e.message.includes("private"));
  for (const status of [401, 403, 502]) {
    await assert.rejects(client(async () => json({ error: { code: "auth.denied", message: token } }, status)).getMe(), (e) => e.statusCode === status && e.retryable === (status === 502) && !e.message.includes(token));
  }
});

test("polling leaves admission and ACK explicit and does not persist filtered events", async () => {
  const requests = [];
  const instance = client(async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("/updates")) return json({ events: [
      { eventId: "e1", sequence: 1, conversationId: "other" },
      { eventId: "e2", sequence: 2, conversationId: "selected" },
    ] });
    return json({ acknowledged: true });
  });
  const result = await instance.pollNextEvent({ conversationId: "selected" });
  assert.equal(result.event.eventId, "e2");
  assert.equal(result.requiresAck, true);
  assert.equal(instance.lastSequence, 0);
  assert.equal(requests.length, 1);
  await instance.acknowledge({ eventId: "e2", sequence: 2 });
  assert.equal(instance.lastSequence, 0);
});

test("explicit polling ACK failure does not advance the cursor", async () => {
  const instance = client(async (url) => String(url).includes("/updates")
    ? json({ events: [{ eventId: "e1", sequence: 1 }] })
    : json({ error: { code: "gateway.unavailable" } }, 503));
  await assert.rejects(instance.pollNextEvent({ ack: true }));
  assert.equal(instance.lastSequence, 0);
});

test("polling follows empty and filtered pages without checkpointing scan progress", async () => {
  const offsets = [];
  const instance = client(async (url) => {
    const after = Number(url.searchParams.get("afterSequence"));
    offsets.push(after);
    if (after === 7) return json({ events: [], hasMore: true, currentSequence: 16000, resumeSequence: 804 });
    if (after === 804) return json({
      events: [{ eventId: "other", sequence: 890, conversationId: "other" }],
      hasMore: true, currentSequence: 16000, resumeSequence: 960,
    });
    assert.equal(after, 960);
    return json({
      events: [{ eventId: "first", sequence: 1046, conversationId: "selected" }, { eventId: "second", sequence: 1060, conversationId: "selected" }],
      currentSequence: 16000, resumeSequence: 16000,
    });
  });
  const result = await instance.pollNextEvent({ afterSequence: 7, conversationId: "selected", onCursorAdvance: assert.fail });
  assert.deepEqual(offsets, [7, 804, 960]);
  assert.equal(result.event.eventId, "first");
  assert.equal(result.requiresAck, true);
  assert.equal(result.lastSequence, 7);
  assert.equal(instance.lastSequence, 0);
});

test("polling advances only through certified sync and checkpoints only the acknowledged event", async () => {
  const offsets = [];
  const syncStates = [];
  const checkpoints = [];
  const instance = client(async (url, init) => {
    if (init.method === "POST") {
      assert.deepEqual(JSON.parse(init.body), { sequence: 1050, eventId: "evt" });
      assert.equal(instance.lastSequence, 0);
      return json({ acknowledged: true, eventId: "evt", sequence: 1050 });
    }
    const after = Number(url.searchParams.get("afterSequence"));
    offsets.push(after);
    if (after === 10) return json({
      events: [], syncRequired: true, reason: "replay_window_exceeded",
      currentSequence: 4000, resumeSequence: 999,
    });
    assert.equal(after, 999);
    return json({ events: [{ eventId: "evt", sequence: 1050 }], currentSequence: 4000, resumeSequence: 4000 });
  });
  const result = await instance.pollNextEvent({
    afterSequence: 10, ack: true,
    onSyncRequired: (state) => syncStates.push(state),
    onCursorAdvance: (sequence) => checkpoints.push(sequence),
  });
  assert.deepEqual(offsets, [10, 999]);
  assert.deepEqual(syncStates, [{ currentSequence: 4000, resumeSequence: 999, reason: "replay_window_exceeded" }]);
  assert.deepEqual(checkpoints, [1050]);
  assert.equal(result.lastSequence, 1050);
});

test("polling surfaces unsafe sync without jumping to the space head or resetting an ahead cursor", async () => {
  for (const res of [
    { reason: "replay_window_exceeded", currentSequence: 4000 },
    { reason: "replay_window_exceeded", currentSequence: 4000, resumeSequence: 4001 },
    { reason: "cursor_ahead", currentSequence: 4000, resumeSequence: 1000 },
  ]) {
    let requests = 0;
    const syncStates = [];
    const instance = client(async (url) => {
      requests += 1;
      assert.equal(url.searchParams.get("afterSequence"), "10");
      return json({ events: [], syncRequired: true, ...res });
    });
    await assert.rejects(instance.pollNextEvent({
      afterSequence: 10,
      onSyncRequired: (state) => syncStates.push(state),
      onCursorAdvance: assert.fail,
    }), { code: "gateway.sync_required" });
    assert.equal(requests, 1);
    assert.deepEqual(syncStates, [{ currentSequence: 4000, reason: res.reason }]);
    assert.equal(instance.lastSequence, 0);
  }
});

test("binary uploads declare their exact length before transfer", async () => {
  const instance = client(async (_url, init) => {
    assert.equal(init.headers["content-length"], "3");
    return json({ attachment: { id: "file1" } });
  });
  await instance.uploadFile({ conversationId: "c1", fileName: "x.txt", bytes: Buffer.from("abc") });
});

test("authorized inbound content uses scoped IDs, rejects excess bytes and has no credential redirect", async () => {
  const instance = client(async (url, init) => {
    assert.equal(String(url), "https://gateway.example/api/bot/v2/conversations/c1/attachments/a1/content?messageId=m1&mode=content");
    assert.equal(init.redirect, "error");
    return new Response("abcd", { headers: { "content-type": "text/plain" } });
  });
  await assert.rejects(instance.readAttachment({ conversationId: "c1", attachmentId: "a1", messageId: "m1", maxBytes: 3 }), (e) => e.code === "gateway.response_too_large");
});

test("an empty ACK response is rejected and cannot commit an event", async () => {
  await assert.rejects(client(async () => json({})).acknowledge({ eventId: "e1", sequence: 1 }), (e) => e.code === "gateway.ack_rejected");
});

test("ACK receipts for another event or sequence are rejected", async () => {
  for (const receipt of [
    { acknowledged: true, eventId: "e2", sequence: 1 },
    { acknowledged: true, eventId: "e1", sequence: 2 },
  ]) {
    const instance = client(async () => json(receipt));
    await assert.rejects(instance.acknowledge({ eventId: "e1", sequence: 1 }), (e) => e.code === "gateway.ack_rejected");
    assert.equal(instance.lastSequence, 0);
  }
});

test("timeout scan hints remain transient and never advance a filtered caller", async () => {
  const filtered = client(async () => json({
    events: [{ eventId: "other", sequence: 20, conversationId: "other" }],
    currentSequence: 90, resumeSequence: 60,
  }));
  const unfiltered = client(async () => json({ events: [], currentSequence: 90, resumeSequence: 60 }));
  const [selected, empty] = await Promise.all([
    filtered.pollNextEvent({ afterSequence: 5, conversationId: "selected", timeoutMs: 1000 }),
    unfiltered.pollNextEvent({ afterSequence: 5, timeoutMs: 1000 }),
  ]);
  assert.equal(selected.timeout, true);
  assert.equal(selected.lastSequence, 5);
  assert.equal(selected.resumeSequence, undefined);
  assert.equal(empty.timeout, true);
  assert.equal(empty.lastSequence, 5);
  assert.equal(empty.resumeSequence, 60);
  assert.equal(unfiltered.lastSequence, 0);
});

test("idle polling reserves time for the gateway response inside both deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const requests = [];
  const instance = client(async (url, init) => {
    const after = Number(url.searchParams.get("afterSequence"));
    const hold = Number(url.searchParams.get("timeout"));
    requests.push({ after, hold });
    if (hold) await new Promise((resolve) => setTimeout(resolve, hold * 1000 + 80));
    assert.equal(init.signal.aborted, false);
    return json({ events: [], currentSequence: 90, resumeSequence: 60 });
  }, { requestTimeoutMs: 1350 });

  const pending = instance.pollNextEvent({ afterSequence: 5, timeoutMs: 1450 });
  assert.deepEqual(requests, [{ after: 5, hold: 1 }]);
  t.mock.timers.tick(1080);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, [{ after: 5, hold: 1 }, { after: 60, hold: 0 }]);
  t.mock.timers.tick(370);
  assert.deepEqual(await pending, { timeout: true, lastSequence: 5, transport: "poll", resumeSequence: 60 });
  assert.equal(instance.lastSequence, 0);
  assert.equal(requests.length, 2);
});

test("polling distinguishes an exhausted overall deadline from a request timeout", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const stalled = () => new Promise(() => {});
  const elapsed = client(stalled).pollNextEvent({ timeoutMs: 100 });
  t.mock.timers.tick(100);
  assert.deepEqual(await elapsed, { timeout: true, lastSequence: 0, transport: "poll" });

  const request = client(stalled, { requestTimeoutMs: 80 }).pollNextEvent({ timeoutMs: 160 });
  const rejected = assert.rejects(request, { code: "network.timeout" });
  t.mock.timers.tick(80);
  await rejected;
});

test("aborting idle polling during the retry delay stops the scan immediately", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const controller = new AbortController();
  const offsets = [];
  const instance = client(async (url) => {
    offsets.push(Number(url.searchParams.get("afterSequence")));
    return json({ events: [], currentSequence: 90, resumeSequence: 60 });
  });
  const pending = instance.pollNextEvent({ afterSequence: 5, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(offsets, [5, 60]);
  controller.abort();
  assert.deepEqual(await pending, { timeout: true, lastSequence: 5, transport: "poll" });
  assert.deepEqual(offsets, [5, 60]);
});

test("rejecting an HTML error stops the response stream", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(client(async () => new Response(body, { status: 502, headers: { "content-type": "text/html" } })).getMe());
  assert.equal(cancelled, true);
});

test("real fetch refuses a redirect without sending credentials to its target", async () => {
  let leakedRequests = 0;
  const receiver = http.createServer((_request, response) => { leakedRequests += 1; response.end("unexpected"); });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const gateway = http.createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${receiver.address().port}/capture` }); response.end();
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  try {
    const instance = new DualLaneAgentClient({ url: `http://127.0.0.1:${gateway.address().port}`, token });
    await assert.rejects(instance.getMe(), (e) => e.code === "network.unavailable");
    assert.equal(leakedRequests, 0);
  } finally {
    gateway.closeAllConnections(); receiver.closeAllConnections();
    await Promise.all([new Promise((resolve) => gateway.close(resolve)), new Promise((resolve) => receiver.close(resolve))]);
  }
});
