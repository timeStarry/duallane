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

test("a filtered timeout never returns a cursor beyond unhandled events", async () => {
  const instance = client(async () => json({ events: [{ eventId: "other", sequence: 20, conversationId: "other" }] }));
  const result = await instance.pollNextEvent({ afterSequence: 5, conversationId: "selected", timeoutMs: 1000 });
  assert.equal(result.timeout, true);
  assert.equal(result.lastSequence, 5);
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
