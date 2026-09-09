import assert from "node:assert/strict";

const target = new URL(process.argv[2] || "http://127.0.0.1:8788");
assert.equal(process.argv[3], "--synthetic-candidate", "explicit synthetic candidate opt-in is required");
assert.equal(target.protocol, "http:");
assert.equal(target.hostname, "127.0.0.1");
assert.ok(target.port && target.pathname === "/" && !target.search && !target.hash && !target.username && !target.password);

let checks = 0;
async function request(path, status, options = {}) {
  const response = await fetch(new URL(path, target), { ...options, redirect: "manual", signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, status, `candidate route ${path} status`);
  // Both the application and gateway enforce these headers. Duplicate
  // identical values are safe; any weaker or unexpected value still fails.
  assert.ok(response.headers.get("x-content-type-options")?.split(",").every((value) => value.trim() === "nosniff"));
  assert.ok(response.headers.get("referrer-policy")?.split(",").every((value) => value.trim() === "no-referrer"));
  assert.ok(response.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
  checks++;
  return response;
}

assert.equal((await (await request("/api/health", 200)).json()).ok, true);
assert.match(await (await request("/", 200)).text(), /<html/);
assert.equal((await (await request("/api/workspace/bootstrap", 401)).json()).error.code, "auth.required");
await request("/ws/workspace", 426);
await new Promise((resolve, reject) => {
  const socketURL = new URL("/ws/workspace", target);
  socketURL.protocol = "ws:";
  const socket = new WebSocket(socketURL);
  const frames = [];
  const timer = setTimeout(() => {
    socket.close();
    reject(new Error("WebSocket authentication boundary timed out"));
  }, 5000);
  // The protocol authenticates the first hello after the HTTP upgrade. No
  // ready/event frame may precede the content-free error and policy close.
  socket.addEventListener("open", () => socket.send(JSON.stringify({ version: 1, type: "hello", lastSeq: 0 })));
  socket.addEventListener("message", (event) => {
    try { frames.push(JSON.parse(event.data)); } catch (error) { clearTimeout(timer); socket.close(); reject(error); }
  });
  socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket handshake failed")); });
  socket.addEventListener("close", (event) => {
    clearTimeout(timer);
    try {
      assert.equal(event.code, 1008, "unauthenticated WebSocket policy close");
      assert.equal(frames.length, 1);
      assert.equal(frames[0].version, 1);
      assert.equal(frames[0].type, "error");
      assert.equal(frames[0].error.code, "auth.required");
      assert.deepEqual(Object.keys(frames[0]).sort(), ["error", "type", "version"]);
      assert.deepEqual(Object.keys(frames[0].error).sort(), ["code", "message"]);
      checks++;
      resolve();
    } catch (error) { reject(error); }
  });
});
for (const privatePath of ["/readyz", "/healthz", "/metrics"]) await request(privatePath, 404);

// P2P synthetic room state is transient and belongs only to this candidate.
// No chat/file payload, secret fragment or Workspace data is sent.
const created = await (await request("/api/p2p/rooms", 201, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxPeers: 2 }),
})).json();
assert.ok(typeof created.roomId === "string" && /^[A-Za-z0-9_-]+$/.test(created.roomId));
await request(`/api/p2p/rooms/${created.roomId}`, 200);
process.stdout.write(`candidate gateway smoke: ${checks} checks PASS\n`);
