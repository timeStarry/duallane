import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const NODE_ENTRY = path.join(REPO_ROOT, "apps/web/server/index.mjs");
const FIXTURE_ROOT = path.join(REPO_ROOT, "scripts/backend/testdata/p2p");
const LOCAL_HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 3_000;
// Prefer a Linux-native checkout in WSL; mounted-filesystem cold imports are slow.
const STARTUP_TIMEOUT_MS = 30_000;
const WEBSOCKET_TIMEOUT_MS = 3_000;
const NO_FRAME_TIMEOUT_MS = 150;
const TOTAL_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const COMPARABLE_RESPONSE_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
});
const REPORTABLE_FIELDS = new Set([
  "status", "body", "error", "code", "message", "statusCode", "ok", "service",
  "lane", "appVersion", "iceServers", "urls", "username", "credential",
  "credentialType", "roomId", "inviteLink", "maxPeers", "expiresAt", "peerCount",
  "type", "event", "peerId", "peers", "id", "v", "channel", "nonce",
  "ciphertext", "from", "receivedAt"
]);
const activeProcesses = new Set();
let activeRun = null;
let interrupted = false;

class ParityFailure extends Error {
  constructor(scope, caseName, reason) {
    super(`${scope}/${caseName}: ${reason}`);
    this.scope = scope;
    this.caseName = caseName;
    this.reason = reason;
  }
}

function fail(scope, caseName, reason) {
  throw new ParityFailure(scope, caseName, reason);
}

function parseArguments(argv) {
  let binary = process.env.DUALLANE_P2P_BINARY || "";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      printUsage();
      process.exit(0);
    }
    if (argument === "--go-binary") {
      binary = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (argument.startsWith("--go-binary=")) {
      binary = argument.slice("--go-binary=".length);
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error("unknown option");
    }
    if (binary) {
      throw new Error("more than one Go binary was supplied");
    }
    binary = argument;
  }

  if (!binary) {
    throw new Error("a Go P2P binary is required via --go-binary or DUALLANE_P2P_BINARY");
  }
  if (binary.includes("://")) {
    throw new Error("the Go P2P binary must be a local path");
  }
  if (!path.isAbsolute(binary)) {
    throw new Error("the Go P2P binary must be an absolute local path");
  }
  if (process.platform === "win32" && !binary.toLowerCase().endsWith(".exe")) {
    throw new Error("Node and Go must run on the same OS; invoke the harness inside WSL for a Linux binary");
  }
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(binary)) {
    throw new Error("Node and Go must run on the same OS; use a POSIX Go binary path");
  }
  return { binary };
}

function printUsage() {
  console.log("Usage: node scripts/backend/p2p-parity.mjs --go-binary <absolute-path>");
  console.log("       DUALLANE_P2P_BINARY=<absolute-path> node scripts/backend/p2p-parity.mjs");
}

async function loadFixtures() {
  const [httpText, websocketText] = await Promise.all([
    readFile(path.join(FIXTURE_ROOT, "http.json"), "utf8"),
    readFile(path.join(FIXTURE_ROOT, "websocket.json"), "utf8")
  ]);
  let http;
  let websocket;
  try {
    http = JSON.parse(httpText);
    websocket = JSON.parse(websocketText);
  } catch {
    throw new Error("P2P parity fixture JSON is invalid");
  }
  if (http?.version !== 1 || !Array.isArray(http.cases) || websocket?.version !== 1) {
    throw new Error("P2P parity fixture version or shape is invalid");
  }
  return { httpCases: http.cases, websocket };
}

async function allocateLocalPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOCAL_HOST, port: 0 }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("could not allocate a local port");
  }
  return port;
}

function localBaseUrl(port) {
  const url = `http://${LOCAL_HOST}:${port}`;
  assertLocalUrl(new URL(url), port);
  return url;
}

function localWebSocketUrl(baseUrl, roomId) {
  const url = new URL(`/ws/p2p/${encodeURIComponent(roomId)}`, baseUrl);
  url.protocol = "ws:";
  assertLocalUrl(url);
  return url.toString();
}

function assertLocalUrl(url, expectedPort = undefined) {
  if (url.hostname !== LOCAL_HOST || !["http:", "ws:"].includes(url.protocol)) {
    throw new Error("P2P parity accepts localhost HTTP/WebSocket targets only");
  }
  if (expectedPort !== undefined && Number(url.port) !== expectedPort) {
    throw new Error("P2P parity target port is not the allocated ephemeral port");
  }
}

function buildChildEnvironment({ baseUrl, port, dataDir, implementation }) {
  const environment = {};
  const inheritedKeys = process.platform === "win32"
    ? ["PATH", "TEMP", "TMP", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "TZ"]
    : ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TZ"];
  for (const key of inheritedKeys) {
    if (typeof process.env[key] === "string" && process.env[key].length > 0) {
      environment[key] = process.env[key];
    }
  }

  Object.assign(environment, {
    HOST: LOCAL_HOST,
    PORT: String(port),
    PUBLIC_BASE_URL: baseUrl,
    TRUST_PROXY: "false",
    WORKSPACE_ENABLED: "false",
    DUALLANE_STUN_URLS: "stun:one.example, stun:two.example",
    DUALLANE_TURN_URLS: "turn:one.example, turns:two.example",
    DUALLANE_TURN_SHARED_SECRET: "",
    DUALLANE_TURN_USERNAME: "synthetic-turn-user",
    DUALLANE_TURN_CREDENTIAL: "synthetic-turn-credential",
    DUALLANE_EMPTY_ROOM_GRACE_MS: "0",
    DUALLANE_P2P_ROOM_TTL_MS: "7200000",
    DUALLANE_P2P_MAX_FRAME_BYTES: "65536",
    DUALLANE_APP_VERSION: implementation === "node" ? "node-characterization" : "go-candidate",
    DUALLANE_GIT_COMMIT: "parity-fixture",
    DUALLANE_DATA_DIR: dataDir,
    NO_PROXY: `${LOCAL_HOST},localhost`
  });

  if (implementation === "node") {
    Object.assign(environment, {
      NODE_ENV: "test",
      SERVE_STATIC: "false",
      WORKSPACE_FRONTEND_URL: baseUrl
    });
  }
  return environment;
}

function launchSpec(implementation, binary, environment) {
  if (implementation === "node") {
    return {
      command: process.execPath,
      args: [NODE_ENTRY],
      environment
    };
  }

  return { command: binary, args: [], environment };
}

function launchProcess(implementation, binary, environment) {
  const spec = launchSpec(implementation, binary, environment);
  const child = spawn(spec.command, spec.args, {
    cwd: REPO_ROOT,
    env: spec.environment,
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true
  });
  const state = { child, spawnError: null };
  child.once("error", (error) => {
    state.spawnError = error;
  });
  activeProcesses.add(state);
  return state;
}

function processHasExited(state) {
  return state.spawnError || state.child.exitCode !== null || state.child.signalCode !== null;
}

async function waitForProcessExit(state, timeoutMs) {
  if (processHasExited(state)) {
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    state.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    state.child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopProcess(state) {
  if (!state) {
    return;
  }
  // Signal handling and finally blocks may request cleanup concurrently.
  state.stopping ??= terminateProcess(state).finally(() => activeProcesses.delete(state));
  await state.stopping;
}

async function terminateProcess(state) {
  if (processHasExited(state)) {
    return;
  }

  try {
    if (process.platform !== "win32" && Number.isInteger(state.child.pid)) {
      process.kill(-state.child.pid, "SIGTERM");
    } else {
      state.child.kill("SIGTERM");
    }
  } catch {
    // The process may have exited between the status check and the signal.
  }
  await waitForProcessExit(state, 1_500);
  if (processHasExited(state)) {
    return;
  }

  try {
    if (process.platform === "win32" && Number.isInteger(state.child.pid)) {
      const killer = spawn("taskkill.exe", ["/PID", String(state.child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      const killerState = { child: killer, spawnError: null };
      killer.once("error", (error) => { killerState.spawnError = error; });
      await waitForProcessExit(killerState, 1_500);
      if (!processHasExited(killerState)) killer.kill();
    } else if (Number.isInteger(state.child.pid)) {
      process.kill(-state.child.pid, "SIGKILL");
    }
  } catch {
    // Cleanup is best effort after the bounded graceful wait.
  }
  await waitForProcessExit(state, 1_500);
}

async function stopAllProcesses() {
  await Promise.all([...activeProcesses].map((state) => stopProcess(state)));
}

function remainingTime(deadline, limit) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error("parity run deadline exceeded");
    error.code = "PARITY_RUN_TIMEOUT";
    throw error;
  }
  return Math.min(remaining, limit);
}

function createRunContext() {
  const controller = new AbortController();
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  return {
    controller,
    signal: controller.signal,
    deadline,
    clear() {
      clearTimeout(timer);
    }
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithTimeout(url, options, timeoutMs, runSignal = undefined) {
  const controller = new AbortController();
  const abortFromRun = () => controller.abort();
  if (runSignal) {
    if (runSignal.aborted) {
      controller.abort();
    } else {
      runSignal.addEventListener("abort", abortFromRun, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: controller.signal
    });
    const text = await readBoundedText(response);
    return { response, text };
  } finally {
    clearTimeout(timer);
    runSignal?.removeEventListener("abort", abortFromRun);
  }
}

async function readBoundedText(response) {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      // fetch's AbortSignal also aborts body reads; avoid a listener per chunk.
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        const error = new Error("response body exceeded the bound");
        error.code = "PARITY_RESPONSE_TOO_LARGE";
        throw error;
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestJson(baseUrl, fixture, state, deadline, scope, runSignal) {
  const pathValue = expandFixturePath(fixture.path, state, scope, fixture.name);
  const url = new URL(pathValue, baseUrl);
  assertLocalUrl(url, Number(new URL(baseUrl).port));
  const options = {
    method: fixture.method,
    headers: fixture.headers || {}
  };
  if (Object.prototype.hasOwnProperty.call(fixture, "body")) {
    options.body = fixture.body;
  } else if (Object.prototype.hasOwnProperty.call(fixture, "bodyGenerator")) {
    options.body = buildGeneratedBody(fixture.bodyGenerator, scope, fixture.name);
  }

  let response;
  let text;
  try {
    const result = await fetchWithTimeout(url, options, remainingTime(deadline, REQUEST_TIMEOUT_MS), runSignal);
    response = result.response;
    text = result.text;
  } catch (error) {
    if (error?.code === "PARITY_RESPONSE_TOO_LARGE") {
      fail(scope, fixture.name, "response body exceeded the bound");
    }
    fail(scope, fixture.name, "request failed or timed out");
  }

  let json = null;
  if (typeof text === "string" && text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const headers = {};
  for (const headerName of Object.keys(COMPARABLE_RESPONSE_HEADERS)) {
    headers[headerName] = response.headers.get(headerName);
  }
  return { status: response.status, json, headers };
}

function buildGeneratedBody(generator, scope, caseName) {
  if (!generator || typeof generator !== "object" || Array.isArray(generator)) {
    fail(scope, caseName, "generated request body specification is invalid");
  }
  const prefix = generator.prefix;
  const repeatedValue = generator.repeat;
  const suffix = generator.suffix;
  const count = generator.count;
  if (typeof prefix !== "string" || typeof repeatedValue !== "string" || typeof suffix !== "string" ||
      !Number.isSafeInteger(count) || count < 0 || repeatedValue.length === 0) {
    fail(scope, caseName, "generated request body specification is invalid");
  }
  const bodyBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix) + Buffer.byteLength(repeatedValue) * count;
  if (bodyBytes > MAX_REQUEST_BYTES) {
    fail(scope, caseName, "generated request body exceeded the runner bound");
  }
  return `${prefix}${repeatedValue.repeat(count)}${suffix}`;
}

function expandFixturePath(pathValue, state, scope, caseName) {
  if (typeof pathValue !== "string" || !pathValue.startsWith("/") || pathValue.includes("#")) {
    fail(scope, caseName, "fixture path is not a local path");
  }
  return pathValue.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    const roomId = state.rooms[key];
    if (!roomId) {
      fail(scope, caseName, "fixture referenced an uncaptured room");
    }
    return encodeURIComponent(roomId);
  });
}

function assertExpectedStatus(fixture, response, scope) {
  if (response.status !== fixture.expectedStatus) {
    fail(scope, fixture.name, "expected status did not match the fixture");
  }
}

function isRoomID(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value);
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.endsWith("Z");
}

function isPeerID(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value);
}

function assertRoomResponseShape(response, scope, caseName, kind) {
  if (!isRoomID(response.json?.roomId) || !isTimestamp(response.json?.expiresAt) || response.json?.maxPeers !== 2) {
    fail(scope, caseName, `${kind} response identity or timestamp format did not match`);
  }
  if (kind === "created") {
    let invite;
    try {
      invite = new URL(response.json.inviteLink);
    } catch {
      fail(scope, caseName, "created-room invite link was not a URL");
    }
    if (invite.protocol !== "http:" || invite.hash || invite.search || !/^\/direct\/[A-Za-z0-9_-]{22}$/.test(invite.pathname)) {
      fail(scope, caseName, "created-room invite link shape did not match");
    }
  }
}

function assertResponseShape(fixture, response, scope) {
  if (["health", "ice", "created", "room-status", "error", "parser-error"].includes(fixture.projection) && response.json === null) {
    fail(scope, fixture.name, "expected a JSON response");
  }
  if (fixture.projection === "status") {
    fail(scope, fixture.name, "status-only projection is not allowed for parity evidence");
  }
  if (fixture.projection === "health") {
    if (response.json?.ok !== true || response.json?.service !== "duallane" || response.json?.lane !== "ready" || typeof response.json?.appVersion !== "string") {
      fail(scope, fixture.name, "health response shape did not match");
    }
  } else if (fixture.projection === "ice") {
    if (!Array.isArray(response.json?.iceServers)) {
      fail(scope, fixture.name, "ICE response shape did not match");
    }
  } else if (fixture.projection === "created") {
    assertRoomResponseShape(response, scope, fixture.name, "created");
  } else if (fixture.projection === "room-status") {
    if (!Number.isInteger(response.json?.peerCount) || response.json.peerCount < 0 || response.json.peerCount > 2) {
      fail(scope, fixture.name, "room-status response shape did not match");
    }
    assertRoomResponseShape(response, scope, fixture.name, "status");
  } else if (fixture.projection === "error") {
    if (typeof response.json?.error !== "string") {
      fail(scope, fixture.name, "error response shape did not match");
    }
  } else if (fixture.projection === "parser-error") {
    const expected = fixture.errorContract;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      fail(scope, fixture.name, "parser-error fixture contract is missing");
    }
    const actualKeys = Object.keys(response.json).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (stableStringify(actualKeys) !== stableStringify(expectedKeys)) {
      fail(scope, fixture.name, "parser-error fields did not match the fixed contract");
    }
    for (const [key, value] of Object.entries(expected)) {
      if (response.json[key] !== value) {
        fail(scope, fixture.name, "parser-error field did not match the fixed contract");
      }
    }
  }
}

function assertResponseHeaders(fixture, response, scope) {
  for (const [headerName, expectedValue] of Object.entries(COMPARABLE_RESPONSE_HEADERS)) {
    if (response.headers?.[headerName] !== expectedValue) {
      fail(scope, fixture.name, "security response header did not match the contract");
    }
  }
}

function createNormalizer() {
  const ids = {
    room: new Map(),
    peer: new Map()
  };
  const nextNumbers = {
    room: 1,
    peer: 1
  };

  function normalizeID(value, kind) {
    if (!ids[kind].has(value)) {
      ids[kind].set(value, `<${kind}-${nextNumbers[kind]}>`);
      nextNumbers[kind] += 1;
    }
    return ids[kind].get(value);
  }

  function normalizeInviteLink(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^(.*\/direct\/)([^/]+)$/);
      if (!match) {
        return value;
      }
      url.pathname = `${match[1]}${normalizeID(decodeURIComponent(match[2]), "room")}`;
      return url.toString();
    } catch {
      return value;
    }
  }

  function normalize(value) {
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item));
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const normalized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === "roomId" && typeof childValue === "string") {
        normalized[childKey] = normalizeID(childValue, "room");
      } else if ((childKey === "peerId" || childKey === "id") && typeof childValue === "string") {
        normalized[childKey] = normalizeID(childValue, "peer");
      } else if (["expiresAt", "receivedAt"].includes(childKey)) {
        normalized[childKey] = "<timestamp>";
      } else if (childKey === "inviteLink" && typeof childValue === "string") {
        normalized[childKey] = normalizeInviteLink(childValue);
      } else if (childKey === "appVersion") {
        normalized[childKey] = "<release-version>";
      } else {
        normalized[childKey] = normalize(childValue);
      }
    }
    return normalized;
  }

  return { normalize };
}

function projectHttpResponse(response, normalizer) {
  return {
    status: response.status,
    headers: response.headers,
    body: normalizer.normalize(response.json)
  };
}

async function waitForHealth(state, baseUrl, run, scope) {
  const startupDeadline = Math.min(run.deadline, Date.now() + STARTUP_TIMEOUT_MS);
  while (true) {
    run.signal.throwIfAborted();
    if (processHasExited(state)) {
      fail(scope, "startup", "process exited before health became ready");
    }
    if (Date.now() >= startupDeadline) {
      fail(scope, "startup", "process did not become ready within the startup bound");
    }
    const healthUrl = new URL("/api/health", baseUrl);
    try {
      const result = await fetchWithTimeout(healthUrl, {}, Math.min(500, startupDeadline - Date.now()), run.signal);
      if (result.response.status === 200) {
        return;
      }
    } catch {
      // Startup is polled until the bounded deadline.
    }
    await delay(Math.min(100, startupDeadline - Date.now()));
  }
}

async function runHttpFixtures(baseUrl, fixtures, deadline, scope, normalizer, runSignal) {
  const state = { rooms: {} };
  const observations = [];
  for (const fixture of fixtures) {
    if (!fixture || typeof fixture.name !== "string" || typeof fixture.method !== "string" || typeof fixture.path !== "string") {
      fail(scope, "fixtures", "HTTP fixture entry is malformed");
    }
    const response = await requestJson(baseUrl, fixture, state, deadline, scope, runSignal);
    assertExpectedStatus(fixture, response, scope);
    assertResponseHeaders(fixture, response, scope);
    assertResponseShape(fixture, response, scope);
    if (fixture.captureRoom) {
      const roomId = response.json?.roomId;
      if (!/^[A-Za-z0-9_-]{22}$/.test(roomId)) {
        fail(scope, fixture.name, "created room ID did not match the contract");
      }
      state.rooms[fixture.captureRoom] = roomId;
    }
    addObservation(observations, fixture.name, projectHttpResponse(response, normalizer), scope);
  }
  return { state, observations };
}

function timeoutError() {
  const error = new Error("timeout");
  error.code = "PARITY_TIMEOUT";
  return error;
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createSocketClient(url, scope, caseName, deadline) {
  if (typeof WebSocket !== "function") {
    fail(scope, caseName, "Node WebSocket API is unavailable");
  }
  const socket = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let closed = false;
  let closeCode = null;
  let failure = null;
  let openResolve;
  let openReject;
  const opened = new Promise((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });
  let closeResolve;
  const closedPromise = new Promise((resolve) => {
    closeResolve = resolve;
  });

  const rejectWaiters = (error) => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  const rejectFrames = (error) => {
    failure ??= error;
    queue.length = 0;
    rejectWaiters(error);
  };

  socket.addEventListener("open", () => openResolve());
  socket.addEventListener("error", () => {
    const error = new Error("WebSocket transport error");
    openReject(error);
    rejectFrames(error);
  });
  socket.addEventListener("close", (event) => {
    closed = true;
    if (Number.isInteger(event.code)) {
      closeCode = event.code;
    }
    closeResolve();
    rejectWaiters(new Error("WebSocket closed"));
  });
  socket.addEventListener("message", (event) => {
    if (failure) return;
    if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_RESPONSE_BYTES) {
      rejectFrames(new Error("WebSocket frame was not bounded text"));
      return;
    }
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      rejectFrames(new Error("WebSocket frame was not JSON"));
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else if (queue.length < 64) {
      queue.push(frame);
    } else {
      rejectFrames(new Error("WebSocket observation queue exceeded the bound"));
    }
  });

  const open = async () => {
    try {
      await withTimeout(opened, remainingTime(deadline, WEBSOCKET_TIMEOUT_MS));
    } catch {
      fail(scope, caseName, "WebSocket did not open");
    }
  };

  const next = async (timeoutMs = WEBSOCKET_TIMEOUT_MS) => {
    if (failure) throw failure;
    if (queue.length > 0) {
      return queue.shift();
    }
    if (closed) {
      throw new Error("WebSocket closed");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(timeoutError());
      }, remainingTime(deadline, timeoutMs));
      waiters.push({ resolve, reject, timer });
    });
  };

  const waitClosed = async () => {
    if (closed) {
      return;
    }
    await withTimeout(closedPromise, remainingTime(deadline, WEBSOCKET_TIMEOUT_MS)).catch(() => {
      fail(scope, caseName, "WebSocket did not close within the bound");
    });
  };

  const dispose = async () => {
    if (closed) {
      return;
    }
    try {
      socket.close(1000, "parity complete");
    } catch {
      // The peer may already have closed while the fixture was finishing.
    }
    await withTimeout(closedPromise, 500).catch(() => {});
  };

  return {
    socket,
    open,
    next,
    send(value) {
      if (closed) {
        throw new Error("WebSocket is closed");
      }
      socket.send(JSON.stringify(value));
    },
    waitClosed,
    closeCode() {
      return closeCode;
    },
    dispose
  };
}

function assertFrame(frame, expected, scope, caseName) {
  if (!frame || typeof frame !== "object" || frame.type !== expected.type || (expected.event && frame.event !== expected.event)) {
    fail(scope, caseName, "WebSocket system frame did not match");
  }
  if (frame.type === "system") {
    if (frame.event === "joined" && !isPeerID(frame.peerId)) {
      fail(scope, caseName, "joined frame peer ID format did not match");
    }
    if (frame.peerId !== undefined && !isPeerID(frame.peerId)) {
      fail(scope, caseName, "system frame peer ID format did not match");
    }
    if (frame.peers !== undefined) {
      if (!Array.isArray(frame.peers) || frame.peers.length > 2 || frame.peers.some((peer) => !isPeerID(peer?.id))) {
        fail(scope, caseName, "system frame peer list format did not match");
      }
      const peerIDs = frame.peers.map((peer) => peer.id);
      if (new Set(peerIDs).size !== peerIDs.length) {
        fail(scope, caseName, "system frame peer list contained duplicate IDs");
      }
    }
  } else if (frame.type === "secure") {
    if (!isPeerID(frame.from?.id) || !isTimestamp(frame.receivedAt)) {
      fail(scope, caseName, "secure relay identity or timestamp format did not match");
    }
  }
}

function addObservation(observations, name, value, scope) {
  if (observations.some((entry) => entry.name === name)) {
    fail(scope, name, "duplicate observation name");
  }
  observations.push({ name, value });
}

function recordFrame(observations, name, frame, normalizer, scope) {
  addObservation(observations, name, normalizer.normalize(frame), scope);
}

async function expectNoFrame(client, scope, caseName, deadline) {
  try {
    await client.next(Math.min(NO_FRAME_TIMEOUT_MS, remainingTime(deadline, NO_FRAME_TIMEOUT_MS)));
  } catch (error) {
    if (error?.code === "PARITY_TIMEOUT") {
      return;
    }
    fail(scope, caseName, "unexpected WebSocket closure while checking rejection");
  }
  fail(scope, caseName, "rejected frame was relayed to the other peer");
}

async function runWebSocketFixtures(baseUrl, httpState, fixture, deadline, scope, normalizer) {
  const observations = [];
  const sockets = [];
  const primaryRoom = httpState.rooms.primary;
  const websocketRoom = httpState.rooms.websocket;
  if (!primaryRoom || !websocketRoom) {
    fail(scope, "setup", "HTTP fixtures did not provide the WebSocket rooms");
  }

  try {
    const first = createSocketClient(localWebSocketUrl(baseUrl, websocketRoom), scope, "first-join", deadline);
    sockets.push(first);
    await first.open();
    const firstJoined = await first.next();
    assertFrame(firstJoined, { type: "system", event: "joined" }, scope, "first-joined");
    recordFrame(observations, "first-joined", firstJoined, normalizer, scope);
    const firstPresence = await first.next();
    assertFrame(firstPresence, { type: "system", event: "peer-list" }, scope, "first-peer-list");
    recordFrame(observations, "first-peer-list", firstPresence, normalizer, scope);

    const second = createSocketClient(localWebSocketUrl(baseUrl, websocketRoom), scope, "second-join", deadline);
    sockets.push(second);
    await second.open();
    const secondJoined = await second.next();
    assertFrame(secondJoined, { type: "system", event: "joined" }, scope, "second-joined");
    recordFrame(observations, "second-joined", secondJoined, normalizer, scope);
    const firstPeerJoined = await first.next();
    assertFrame(firstPeerJoined, { type: "system", event: "peer-joined" }, scope, "peer-joined");
    recordFrame(observations, "first-peer-joined", firstPeerJoined, normalizer, scope);
    const firstPeerList = await first.next();
    assertFrame(firstPeerList, { type: "system", event: "peer-list" }, scope, "first-peer-list-after-second");
    recordFrame(observations, "first-peer-list-after-second", firstPeerList, normalizer, scope);
    const secondPeerList = await second.next();
    assertFrame(secondPeerList, { type: "system", event: "peer-list" }, scope, "second-peer-list");
    recordFrame(observations, "second-peer-list", secondPeerList, normalizer, scope);

    first.send(fixture.plaintext);
    const plaintextRejected = await first.next();
    assertFrame(plaintextRejected, { type: "system", event: "invalid-message" }, scope, "plaintext-rejected");
    recordFrame(observations, "plaintext-rejected", plaintextRejected, normalizer, scope);
    await expectNoFrame(second, scope, "plaintext-not-relayed", deadline);

    first.send(fixture.secure);
    const relayed = await second.next();
    if (relayed?.type !== "secure" || relayed.v !== 1 || relayed.channel !== fixture.secure.channel || relayed.nonce !== fixture.secure.nonce || relayed.ciphertext !== fixture.secure.ciphertext || Object.prototype.hasOwnProperty.call(relayed, "unknown")) {
      fail(scope, "secure-relay", "secure envelope relay did not preserve the allowlisted fields");
    }
    assertFrame(relayed, { type: "secure" }, scope, "secure-relay");
    recordFrame(observations, "secure-relay", relayed, normalizer, scope);

    first.send(fixture.invalidEnvelope);
    const envelopeRejected = await first.next();
    assertFrame(envelopeRejected, { type: "system", event: "invalid-message" }, scope, "invalid-envelope-rejected");
    recordFrame(observations, "invalid-envelope-rejected", envelopeRejected, normalizer, scope);
    await expectNoFrame(second, scope, "invalid-envelope-not-relayed", deadline);

    first.send(fixture.leave);
    const peerLeft = await second.next();
    assertFrame(peerLeft, { type: "system", event: "peer-left" }, scope, "peer-left");
    recordFrame(observations, "peer-left", peerLeft, normalizer, scope);
    const peerListAfterLeave = await second.next();
    assertFrame(peerListAfterLeave, { type: "system", event: "peer-list" }, scope, "peer-list-after-leave");
    recordFrame(observations, "peer-list-after-leave", peerListAfterLeave, normalizer, scope);
    await first.waitClosed();
    if (first.closeCode() !== 1005) fail(scope, "leave-close", "close status did not match the empty Node close frame");
    recordFrame(observations, "leave-close", { code: first.closeCode() }, normalizer, scope);

    const fullFirst = createSocketClient(localWebSocketUrl(baseUrl, primaryRoom), scope, "full-first", deadline);
    sockets.push(fullFirst);
    await fullFirst.open();
    const fullFirstJoined = await fullFirst.next();
    assertFrame(fullFirstJoined, { type: "system", event: "joined" }, scope, "full-first-joined");
    recordFrame(observations, "full-first-joined", fullFirstJoined, normalizer, scope);
    const fullFirstInitialList = await fullFirst.next();
    assertFrame(fullFirstInitialList, { type: "system", event: "peer-list" }, scope, "full-first-peer-list-initial");
    recordFrame(observations, "full-first-peer-list-initial", fullFirstInitialList, normalizer, scope);
    const fullSecond = createSocketClient(localWebSocketUrl(baseUrl, primaryRoom), scope, "full-second", deadline);
    sockets.push(fullSecond);
    await fullSecond.open();
    const fullSecondJoined = await fullSecond.next();
    assertFrame(fullSecondJoined, { type: "system", event: "joined" }, scope, "full-second-joined");
    recordFrame(observations, "full-second-joined", fullSecondJoined, normalizer, scope);
    const fullFirstPeerJoined = await fullFirst.next();
    assertFrame(fullFirstPeerJoined, { type: "system", event: "peer-joined" }, scope, "full-first-peer-joined");
    recordFrame(observations, "full-first-peer-joined", fullFirstPeerJoined, normalizer, scope);
    const fullFirstSecondList = await fullFirst.next();
    assertFrame(fullFirstSecondList, { type: "system", event: "peer-list" }, scope, "full-first-peer-list-after-second");
    recordFrame(observations, "full-first-peer-list-after-second", fullFirstSecondList, normalizer, scope);
    const fullSecondList = await fullSecond.next();
    assertFrame(fullSecondList, { type: "system", event: "peer-list" }, scope, "full-second-peer-list");
    recordFrame(observations, "full-second-peer-list", fullSecondList, normalizer, scope);
    const fullThird = createSocketClient(localWebSocketUrl(baseUrl, primaryRoom), scope, "full-third", deadline);
    sockets.push(fullThird);
    await fullThird.open();
    const fullRejected = await fullThird.next();
    assertFrame(fullRejected, { type: "system", event: "room-full" }, scope, "room-full");
    recordFrame(observations, "room-full", fullRejected, normalizer, scope);
    await fullThird.waitClosed();
    if (fullThird.closeCode() !== 1005) fail(scope, "room-full-close", "close status did not match the empty Node close frame");
    recordFrame(observations, "room-full-close", { code: fullThird.closeCode() }, normalizer, scope);

    const missing = createSocketClient(localWebSocketUrl(baseUrl, fixture.missingRoomId), scope, "missing-room", deadline);
    sockets.push(missing);
    await missing.open();
    const missingFrame = await missing.next();
    assertFrame(missingFrame, { type: "system", event: "room-not-found" }, scope, "room-not-found");
    recordFrame(observations, "room-not-found", missingFrame, normalizer, scope);
    await missing.waitClosed();
    if (missing.closeCode() !== 1005) fail(scope, "room-not-found-close", "close status did not match the empty Node close frame");
    recordFrame(observations, "room-not-found-close", { code: missing.closeCode() }, normalizer, scope);
  } finally {
    for (const client of sockets.reverse()) {
      await client.dispose();
    }
  }
  return observations;
}

async function runImplementation({ implementation, binary, port, fixtures, run, tempRoot }) {
  const baseUrl = localBaseUrl(port);
  const dataDir = await mkdtemp(path.join(tempRoot, `${implementation}-data-`));
  const environment = buildChildEnvironment({ baseUrl, port, dataDir, implementation });
  const state = launchProcess(implementation, binary, environment);
  const normalizer = createNormalizer();
  try {
    await waitForHealth(state, baseUrl, run, implementation);
    const httpResult = await runHttpFixtures(baseUrl, fixtures.httpCases, run.deadline, implementation, normalizer, run.signal);
    const websocketObservations = await runWebSocketFixtures(baseUrl, httpResult.state, fixtures.websocket, run.deadline, implementation, normalizer);
    return {
      http: httpResult.observations,
      websocket: websocketObservations
    };
  } finally {
    await stopProcess(state);
    try {
      await assertDataDirectoryEmpty(dataDir, implementation);
    } finally {
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function assertDataDirectoryEmpty(dataDir, scope) {
  let entries;
  try {
    entries = await readdir(dataDir);
  } catch {
    fail(scope, "privacy-storage", "P2P data directory could not be inspected");
  }
  if (entries.length > 0) {
    fail(scope, "privacy-storage", "P2P runtime created persistent data artifacts");
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function valueKind(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function differencePaths(left, right, pathValue = "response") {
  if (valueKind(left) !== valueKind(right)) {
    return [`${pathValue} type differs (${valueKind(left)} vs ${valueKind(right)})`];
  }
  if (Array.isArray(left)) {
    if (left.length !== right.length) {
      return [`${pathValue} length differs (${left.length} vs ${right.length})`];
    }
    return left.flatMap((value, index) => differencePaths(value, right[index], `${pathValue}[${index}]`));
  }
  if (left && typeof left === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (stableStringify(leftKeys) !== stableStringify(rightKeys)) {
      return [`${pathValue} keys differ`];
    }
    return leftKeys.flatMap((key) => differencePaths(left[key], right[key], `${pathValue}.${REPORTABLE_FIELDS.has(key) ? key : "<field>"}`));
  }
  if (left !== right) {
    return [`${pathValue} value differs (${valueKind(left)} vs ${valueKind(right)})`];
  }
  return [];
}

function compareObservations(nodeResult, goResult) {
  const mismatches = [];
  for (const suite of ["http", "websocket"]) {
    const nodeMap = new Map(nodeResult[suite].map((entry) => [entry.name, entry.value]));
    const goMap = new Map(goResult[suite].map((entry) => [entry.name, entry.value]));
    const names = new Set([...nodeMap.keys(), ...goMap.keys()]);
    for (const name of names) {
      if (!nodeMap.has(name) || !goMap.has(name)) {
        mismatches.push(`${suite}/${name}: observation missing from one implementation`);
        continue;
      }
      if (stableStringify(nodeMap.get(name)) !== stableStringify(goMap.get(name))) {
        const differences = differencePaths(nodeMap.get(name), goMap.get(name));
        mismatches.push(`${suite}/${name}: ${differences.slice(0, 5).join("; ") || "projection differs"}`);
      }
    }
  }
  return mismatches;
}

async function runComparison(binary) {
  const run = createRunContext();
  let tempRoot = null;
  activeRun = run;
  try {
    const fixtures = await loadFixtures();
    const port = await allocateLocalPort();
    tempRoot = await mkdtemp(path.join(tmpdir(), "duallane-p2p-parity-"));
    const nodeResult = await runImplementation({
      implementation: "node",
      binary,
      port,
      fixtures,
      run,
      tempRoot
    });
    console.log(`P2P parity: Node characterization passed (${nodeResult.http.length} HTTP, ${nodeResult.websocket.length} WebSocket observations)`);

    const goResult = await runImplementation({
      implementation: "go",
      binary,
      port,
      fixtures,
      run,
      tempRoot
    });
    console.log(`P2P parity: Go characterization passed (${goResult.http.length} HTTP, ${goResult.websocket.length} WebSocket observations)`);
    const mismatches = compareObservations(nodeResult, goResult);
    if (mismatches.length > 0) {
      for (const mismatch of mismatches) {
        console.error(`P2P parity mismatch requiring review: ${mismatch}`);
      }
      throw new Error("Node-vs-Go P2P parity mismatch");
    }
    console.log(`P2P parity passed: ${goResult.http.length} HTTP and ${goResult.websocket.length} WebSocket observations matched`);
  } finally {
    run.clear();
    activeRun = null;
    await stopAllProcesses();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function main() {
  let argumentsValue;
  try {
    argumentsValue = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`P2P parity usage error: ${error.message}`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    await runComparison(argumentsValue.binary);
  } catch (error) {
    await stopAllProcesses();
    if (interrupted) {
      console.error("P2P parity interrupted: bounded child-process and temporary-data cleanup attempted");
      process.exitCode = 130;
    } else {
      if (error instanceof ParityFailure) {
        console.error(`P2P parity failed: ${error.scope}/${error.caseName}: ${error.reason}`);
      } else if (error?.message === "Node-vs-Go P2P parity mismatch") {
        console.error("P2P parity failed: contract mismatch requires a compatibility decision");
      } else if (error?.code === "PARITY_RUN_TIMEOUT") {
        console.error("P2P parity failed: time bound exceeded");
      } else {
        console.error(`P2P parity failed: ${safeFailureMessage(error)}`);
      }
      process.exitCode = 1;
    }
  }
}

function safeFailureMessage(error) {
  // Unknown transport/filesystem messages may include paths, URLs or content.
  return error?.code === "PARITY_TIMEOUT" ? "operation timed out" : "runner or transport error";
}

function handleSignal() {
  interrupted = true;
  activeRun?.controller.abort();
  void stopAllProcesses();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  await main();
}

export { buildChildEnvironment, compareObservations, createNormalizer, createSocketClient, parseArguments, safeFailureMessage };
