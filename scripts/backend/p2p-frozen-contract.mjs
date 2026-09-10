import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedProcess, stopOwnedProcess } from "../../e2e/support/owned-process.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const BACKEND_ROOT = path.join(REPO_ROOT, "apps/backend");
const FIXTURE_ROOT = path.join(REPO_ROOT, "scripts/backend/testdata/p2p");
const OBSERVATION_FILE = path.join(FIXTURE_ROOT, "node-observations.json");
const LOCAL_HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 3_000;
const STARTUP_TIMEOUT_MS = 30_000;
const WEBSOCKET_TIMEOUT_MS = 3_000;
const NO_FRAME_TIMEOUT_MS = 150;
const TOTAL_TIMEOUT_MS = 90_000;
const BUILD_TIMEOUT_MS = 180_000;
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
const REQUIRED_COUNTS = Object.freeze({ http: 20, websocket: 19 });
const EXPECTED_HTTP_CASES = 21;
const EXPECTED_WS_OBSERVATIONS = 22;
const EXPECTED_HTTP_EXTRAS = Object.freeze(["health"]);
const EXPECTED_WS_EXTRAS = Object.freeze([
  "leave-close",
  "room-full-close",
  "room-not-found-close"
]);
const activeProcesses = new Set();
let activeRun = null;
let interrupted = false;
let signalCleanupFailure = null;

function combineCleanupFailure(primary, cleanup, label) {
  if (primary && cleanup) return new AggregateError([primary, cleanup], `${label} failed during execution and owned cleanup`);
  return primary || cleanup;
}

class ContractFailure extends Error {
  constructor(scope, caseName, reason) {
    super(`${scope}/${caseName}: ${reason}`);
    this.scope = scope;
    this.caseName = caseName;
    this.reason = reason;
  }
}

function fail(scope, caseName, reason) {
  throw new ContractFailure(scope, caseName, reason);
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
  if (binary && binary.includes("://")) {
    throw new Error("the Go P2P binary must be a local path");
  }
  if (binary && !path.isAbsolute(binary)) {
    throw new Error("the Go P2P binary must be an absolute local path");
  }
  if (binary && process.platform === "win32" && !binary.toLowerCase().endsWith(".exe")) {
    throw new Error("the Go P2P binary must be a Windows executable on Windows");
  }
  if (binary && process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(binary)) {
    throw new Error("the Go P2P binary must be a POSIX path on this runner");
  }
  return { binary };
}

function printUsage() {
  console.log("Usage: node scripts/backend/p2p-frozen-contract.mjs");
  console.log("       node scripts/backend/p2p-frozen-contract.mjs --go-binary <absolute-path>");
  console.log("       DUALLANE_P2P_BINARY=<absolute-path> node scripts/backend/p2p-frozen-contract.mjs");
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} JSON is invalid or unavailable`);
  }
}

async function loadFixtures() {
  const [http, websocket] = await Promise.all([
    readJson(path.join(FIXTURE_ROOT, "http.json"), "P2P HTTP fixture"),
    readJson(path.join(FIXTURE_ROOT, "websocket.json"), "P2P WebSocket fixture")
  ]);
  if (http?.version !== 1 || !Array.isArray(http.cases) || websocket?.version !== 1) {
    throw new Error("P2P fixture version or shape is invalid");
  }
  if (http.cases.length !== EXPECTED_HTTP_CASES) {
    throw new Error("P2P HTTP fixture coverage changed without a contract review");
  }
  const names = http.cases.map((entry) => entry?.name);
  if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) {
    throw new Error("P2P HTTP fixture names must be unique");
  }
  for (const entry of http.cases) {
    if (!entry.path?.startsWith("/") || entry.path.includes("#") || entry.projection === "status") {
      throw new Error("P2P HTTP fixtures must be local, content-bearing observations");
    }
  }
  return { httpCases: http.cases, websocket };
}

function validateObservationEntries(entries, suite) {
  if (!Array.isArray(entries) || new Set(entries.map((entry) => entry?.name)).size !== entries.length) {
    throw new Error(`frozen ${suite} observations must have unique names`);
  }
  if (entries.some((entry) => !entry || typeof entry.name !== "string" || !Object.hasOwn(entry, "value"))) {
    throw new Error(`frozen ${suite} observations are malformed`);
  }
}

async function loadFrozenObservations() {
  const frozen = await readJson(OBSERVATION_FILE, "frozen P2P Node observation");
  if (frozen?.schemaVersion !== 1 || frozen?.source?.lastRegenerableCommit !== "8d346a04317d0d3396293caca14ca1c65c7b5163") {
    throw new Error("frozen P2P observation provenance is invalid");
  }
  validateObservationEntries(frozen.http, "HTTP");
  validateObservationEntries(frozen.websocket, "WebSocket");
  if (frozen.http.length !== frozen.observationCounts?.http || frozen.websocket.length !== frozen.observationCounts?.websocket) {
    throw new Error("frozen P2P observation counts are inconsistent");
  }
  const observationSha256 = createHash("sha256")
    .update(JSON.stringify({ http: frozen.http, websocket: frozen.websocket }), "utf8")
    .digest("hex");
  if (observationSha256 !== frozen.observationSha256) {
    throw new Error("frozen P2P observation integrity check failed");
  }
  if (frozen.observationCounts.http !== EXPECTED_HTTP_CASES || frozen.observationCounts.websocket !== EXPECTED_WS_OBSERVATIONS) {
    throw new Error("frozen P2P observation coverage changed without a contract review");
  }
  if (frozen.requiredObservationCounts?.http !== REQUIRED_COUNTS.http || frozen.requiredObservationCounts?.websocket !== REQUIRED_COUNTS.websocket) {
    throw new Error("the required 20 HTTP / 19 WebSocket P2P coverage is not declared");
  }
  if (JSON.stringify(frozen.documentedExtras?.http) !== JSON.stringify(EXPECTED_HTTP_EXTRAS) || JSON.stringify(frozen.documentedExtras?.websocket) !== JSON.stringify(EXPECTED_WS_EXTRAS)) {
    throw new Error("P2P close observations are not documented as retained extras");
  }
  const actualNames = new Set(frozen.websocket.map((entry) => entry.name));
  for (const name of EXPECTED_WS_EXTRAS) {
    if (!actualNames.has(name)) throw new Error(`frozen P2P observation is missing ${name}`);
  }
  return frozen;
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("could not allocate a local port");
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
    throw new Error("P2P frozen contract accepts localhost targets only");
  }
  if (expectedPort !== undefined && Number(url.port) !== expectedPort) {
    throw new Error("P2P frozen contract target is not the allocated port");
  }
}

function buildChildEnvironment({ baseUrl, port, dataDir }) {
  const environment = {};
  const inheritedKeys = process.platform === "win32"
    ? ["PATH", "TEMP", "TMP", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "TZ"]
    : ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TZ"];
  for (const key of inheritedKeys) {
    if (typeof process.env[key] === "string" && process.env[key].length > 0) environment[key] = process.env[key];
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
    DUALLANE_APP_VERSION: "go-candidate",
    DUALLANE_GIT_COMMIT: "parity-fixture",
    DUALLANE_DATA_DIR: dataDir,
    NO_PROXY: `${LOCAL_HOST},localhost`
  });
  return environment;
}

function launchProcess(binary, environment) {
  const child = spawnOwnedProcess(binary, [], {
    cwd: REPO_ROOT,
    env: environment,
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true
  });
  const state = { child, spawnError: null };
  child.once("error", (error) => { state.spawnError = error; });
  activeProcesses.add(state);
  return state;
}

function processHasExited(state) {
  return state.spawnError || state.child.exitCode !== null || state.child.signalCode !== null;
}

async function stopProcess(state) {
  if (!state) return;
  state.stopping ??= terminateProcess(state).then(() => activeProcesses.delete(state));
  await state.stopping;
}

async function terminateProcess(state) {
  if (state.spawnError && !state.child.pid) return;
  // The group may still own compiler children after its leader has exited.
  // Reuse the shared owner-aware cleanup and propagate any failure.
  await stopOwnedProcess(state.child, 1_500);
  if (!processHasExited(state)) throw new Error("owned P2P process did not exit");
}

async function stopAllProcesses() {
  await Promise.all([...activeProcesses].map((state) => stopProcess(state)));
}

function remainingTime(deadline, limit) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error("contract run deadline exceeded");
    error.code = "P2P_RUN_TIMEOUT";
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
    clear() { clearTimeout(timer); }
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithTimeout(url, options, timeoutMs, runSignal = undefined) {
  const controller = new AbortController();
  const abortFromRun = () => controller.abort();
  if (runSignal) {
    if (runSignal.aborted) controller.abort();
    else runSignal.addEventListener("abort", abortFromRun, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, redirect: "error", signal: controller.signal });
    return { response, text: await readBoundedText(response) };
  } finally {
    clearTimeout(timer);
    runSignal?.removeEventListener("abort", abortFromRun);
  }
}

async function readBoundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        const error = new Error("response body exceeded the bound");
        error.code = "P2P_RESPONSE_TOO_LARGE";
        throw error;
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildGeneratedBody(generator, scope, caseName) {
  if (!generator || typeof generator !== "object" || Array.isArray(generator)) fail(scope, caseName, "generated body specification is invalid");
  const { prefix, repeat, suffix, count } = generator;
  if (typeof prefix !== "string" || typeof repeat !== "string" || typeof suffix !== "string" ||
      !Number.isSafeInteger(count) || count < 0 || repeat.length === 0) {
    fail(scope, caseName, "generated body specification is invalid");
  }
  if (Buffer.byteLength(prefix) + Buffer.byteLength(suffix) + Buffer.byteLength(repeat) * count > MAX_REQUEST_BYTES) {
    fail(scope, caseName, "generated body exceeded the runner bound");
  }
  return `${prefix}${repeat.repeat(count)}${suffix}`;
}

function expandFixturePath(pathValue, state, scope, caseName) {
  if (typeof pathValue !== "string" || !pathValue.startsWith("/") || pathValue.includes("#")) fail(scope, caseName, "fixture path is not local");
  return pathValue.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    const roomId = state.rooms[key];
    if (!roomId) fail(scope, caseName, "fixture referenced an uncaptured room");
    return encodeURIComponent(roomId);
  });
}

async function requestJson(baseUrl, fixture, state, deadline, scope, runSignal) {
  const url = new URL(expandFixturePath(fixture.path, state, scope, fixture.name), baseUrl);
  assertLocalUrl(url, Number(new URL(baseUrl).port));
  const options = { method: fixture.method, headers: fixture.headers || {} };
  if (Object.hasOwn(fixture, "body")) options.body = fixture.body;
  else if (Object.hasOwn(fixture, "bodyGenerator")) options.body = buildGeneratedBody(fixture.bodyGenerator, scope, fixture.name);
  let result;
  try {
    result = await fetchWithTimeout(url, options, remainingTime(deadline, REQUEST_TIMEOUT_MS), runSignal);
  } catch (error) {
    if (error?.code === "P2P_RESPONSE_TOO_LARGE") fail(scope, fixture.name, "response body exceeded the bound");
    fail(scope, fixture.name, "request failed or timed out");
  }
  let json = null;
  if (result.text.length > 0) {
    try { json = JSON.parse(result.text); } catch { json = null; }
  }
  const headers = {};
  for (const name of Object.keys(COMPARABLE_RESPONSE_HEADERS)) headers[name] = result.response.headers.get(name);
  return { status: result.response.status, json, headers };
}

function isRoomID(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value); }
function isTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.endsWith("Z"); }
function isPeerID(value) { return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value); }

function assertResponseShape(fixture, response, scope) {
  if (["health", "ice", "created", "room-status", "error", "parser-error"].includes(fixture.projection) && response.json === null) fail(scope, fixture.name, "expected a JSON response");
  if (fixture.projection === "status") fail(scope, fixture.name, "status-only projection is not allowed");
  if (fixture.projection === "health" && (response.json?.ok !== true || response.json?.service !== "duallane" || response.json?.lane !== "ready" || typeof response.json?.appVersion !== "string")) fail(scope, fixture.name, "health shape did not match");
  if (fixture.projection === "ice" && !Array.isArray(response.json?.iceServers)) fail(scope, fixture.name, "ICE shape did not match");
  if (["created", "room-status"].includes(fixture.projection)) {
    if (!isRoomID(response.json?.roomId) || !isTimestamp(response.json?.expiresAt) || response.json?.maxPeers !== 2) fail(scope, fixture.name, "room shape did not match");
    if (fixture.projection === "created") {
      let invite;
      try { invite = new URL(response.json.inviteLink); } catch { fail(scope, fixture.name, "invite link was not a URL"); }
      if (invite.protocol !== "http:" || invite.hash || invite.search || !/^\/direct\/[A-Za-z0-9_-]{22}$/.test(invite.pathname)) fail(scope, fixture.name, "invite link shape did not match");
    } else if (!Number.isInteger(response.json.peerCount) || response.json.peerCount < 0 || response.json.peerCount > 2) {
      fail(scope, fixture.name, "room status shape did not match");
    }
  }
  if (fixture.projection === "error" && typeof response.json?.error !== "string") fail(scope, fixture.name, "error shape did not match");
  if (fixture.projection === "parser-error") {
    const expected = fixture.errorContract;
    if (!expected || typeof expected !== "object" || Array.isArray(expected) || JSON.stringify(Object.keys(response.json).sort()) !== JSON.stringify(Object.keys(expected).sort())) fail(scope, fixture.name, "parser error fields did not match");
    for (const [key, value] of Object.entries(expected)) if (response.json[key] !== value) fail(scope, fixture.name, "parser error contract did not match");
  }
}

function projectHttpResponse(response, normalizer) {
  return { status: response.status, headers: response.headers, body: normalizer.normalize(response.json) };
}

function createNormalizer() {
  const ids = { room: new Map(), peer: new Map() };
  const next = { room: 1, peer: 1 };
  const normalizeID = (value, kind) => {
    if (!ids[kind].has(value)) {
      ids[kind].set(value, `<${kind}-${next[kind]}>`);
      next[kind] += 1;
    }
    return ids[kind].get(value);
  };
  function normalizeInviteLink(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^(.*\/direct\/)([^/]+)$/);
      if (!match) return value;
      const room = normalizeID(decodeURIComponent(match[2]), "room");
      const authority = url.hostname === LOCAL_HOST && url.port ? `${url.protocol}//${url.hostname}:<port>` : url.origin;
      return `${authority}${match[1].slice(match[1].indexOf("/"))}${encodeURIComponent(room)}`;
    } catch {
      return value;
    }
  }
  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "roomId" && typeof child === "string") output[key] = normalizeID(child, "room");
      else if ((key === "peerId" || key === "id") && typeof child === "string") output[key] = normalizeID(child, "peer");
      else if (["expiresAt", "receivedAt"].includes(key)) output[key] = "<timestamp>";
      else if (key === "inviteLink" && typeof child === "string") output[key] = normalizeInviteLink(child);
      else if (key === "appVersion") output[key] = "<release-version>";
      else output[key] = normalize(child);
    }
    return output;
  }
  return { normalize };
}

async function runHttpFixtures(baseUrl, fixtures, deadline, scope, normalizer, runSignal) {
  const state = { rooms: {} };
  const observations = [];
  for (const fixture of fixtures) {
    if (!fixture || typeof fixture.name !== "string" || typeof fixture.method !== "string" || typeof fixture.path !== "string") fail(scope, "fixtures", "HTTP fixture entry is malformed");
    const response = await requestJson(baseUrl, fixture, state, deadline, scope, runSignal);
    if (response.status !== fixture.expectedStatus) fail(scope, fixture.name, "expected status did not match");
    for (const [header, value] of Object.entries(COMPARABLE_RESPONSE_HEADERS)) if (response.headers[header] !== value) fail(scope, fixture.name, "security response header did not match");
    assertResponseShape(fixture, response, scope);
    if (fixture.captureRoom) {
      if (!isRoomID(response.json?.roomId)) fail(scope, fixture.name, "captured room ID did not match");
      state.rooms[fixture.captureRoom] = response.json.roomId;
    }
    observations.push({ name: fixture.name, value: projectHttpResponse(response, normalizer) });
  }
  return { state, observations };
}

function timeoutError() {
  const error = new Error("timeout");
  error.code = "P2P_TIMEOUT";
  return error;
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

function createSocketClient(url, scope, caseName, deadline) {
  if (typeof WebSocket !== "function") fail(scope, caseName, "WebSocket API is unavailable");
  const socket = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let closed = false;
  let closeCode = null;
  let failure = null;
  let openResolve;
  let openReject;
  const opened = new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; });
  let closeResolve;
  const closedPromise = new Promise((resolve) => { closeResolve = resolve; });
  const rejectWaiters = (error) => {
    while (waiters.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  const rejectFrames = (error) => { failure ??= error; queue.length = 0; rejectWaiters(error); };
  socket.addEventListener("open", () => openResolve());
  socket.addEventListener("error", () => { const error = new Error("WebSocket transport error"); openReject(error); rejectFrames(error); });
  socket.addEventListener("close", (event) => { closed = true; if (Number.isInteger(event.code)) closeCode = event.code; closeResolve(); rejectWaiters(new Error("WebSocket closed")); });
  socket.addEventListener("message", (event) => {
    if (failure) return;
    if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_RESPONSE_BYTES) { rejectFrames(new Error("WebSocket frame was not bounded text")); return; }
    let frame;
    try { frame = JSON.parse(event.data); } catch { rejectFrames(new Error("WebSocket frame was not JSON")); return; }
    const waiter = waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(frame); }
    else if (queue.length < 64) queue.push(frame);
    else rejectFrames(new Error("WebSocket observation queue exceeded the bound"));
  });
  const open = async () => { try { await withTimeout(opened, remainingTime(deadline, WEBSOCKET_TIMEOUT_MS)); } catch { fail(scope, caseName, "WebSocket did not open"); } };
  const next = async (timeoutMs = WEBSOCKET_TIMEOUT_MS) => {
    if (failure) throw failure;
    if (queue.length) return queue.shift();
    if (closed) throw new Error("WebSocket closed");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(timeoutError());
      }, remainingTime(deadline, timeoutMs));
      waiters.push({ resolve, reject, timer });
    });
  };
  const waitClosed = async () => { if (!closed) await withTimeout(closedPromise, remainingTime(deadline, WEBSOCKET_TIMEOUT_MS)).catch(() => fail(scope, caseName, "WebSocket did not close within the bound")); };
  const dispose = async () => {
    if (closed) return;
    try { socket.close(1000, "frozen contract complete"); } catch { /* peer may already have closed */ }
    await withTimeout(closedPromise, 500).catch(() => {});
  };
  return {
    socket,
    open,
    next,
    send(value) { if (closed) throw new Error("WebSocket is closed"); socket.send(JSON.stringify(value)); },
    waitClosed,
    closeCode: () => closeCode,
    dispose
  };
}

function assertFrame(frame, expected, scope, caseName) {
  if (!frame || typeof frame !== "object" || frame.type !== expected.type || (expected.event && frame.event !== expected.event)) fail(scope, caseName, "WebSocket system frame did not match");
  if (frame.type === "system") {
    if (frame.event === "joined" && !isPeerID(frame.peerId)) fail(scope, caseName, "joined peer ID did not match");
    if (frame.peerId !== undefined && !isPeerID(frame.peerId)) fail(scope, caseName, "system peer ID did not match");
    if (frame.peers !== undefined) {
      if (!Array.isArray(frame.peers) || frame.peers.length > 2 || frame.peers.some((peer) => !isPeerID(peer?.id))) fail(scope, caseName, "system peer list did not match");
      const ids = frame.peers.map((peer) => peer.id);
      if (new Set(ids).size !== ids.length) fail(scope, caseName, "system peer list contained duplicates");
    }
  } else if (frame.type === "secure" && (!isPeerID(frame.from?.id) || !isTimestamp(frame.receivedAt))) {
    fail(scope, caseName, "secure relay identity or timestamp did not match");
  }
}

function recordFrame(observations, name, frame, normalizer, scope) {
  if (observations.some((entry) => entry.name === name)) fail(scope, name, "duplicate observation name");
  observations.push({ name, value: normalizer.normalize(frame) });
}

async function expectNoFrame(client, scope, caseName, deadline) {
  try { await client.next(Math.min(NO_FRAME_TIMEOUT_MS, remainingTime(deadline, NO_FRAME_TIMEOUT_MS))); }
  catch (error) { if (error?.code === "P2P_TIMEOUT") return; fail(scope, caseName, "unexpected WebSocket closure while checking rejection"); }
  fail(scope, caseName, "rejected frame was relayed to the other peer");
}

async function runWebSocketFixtures(baseUrl, httpState, fixture, deadline, scope, normalizer) {
  const observations = [];
  const sockets = [];
  const primaryRoom = httpState.rooms.primary;
  const websocketRoom = httpState.rooms.websocket;
  if (!primaryRoom || !websocketRoom) fail(scope, "setup", "HTTP fixtures did not provide WebSocket rooms");
  try {
    const first = createSocketClient(localWebSocketUrl(baseUrl, websocketRoom), scope, "first-join", deadline); sockets.push(first);
    await first.open();
    let frame = await first.next(); assertFrame(frame, { type: "system", event: "joined" }, scope, "first-joined"); recordFrame(observations, "first-joined", frame, normalizer, scope);
    frame = await first.next(); assertFrame(frame, { type: "system", event: "peer-list" }, scope, "first-peer-list"); recordFrame(observations, "first-peer-list", frame, normalizer, scope);

    const second = createSocketClient(localWebSocketUrl(baseUrl, websocketRoom), scope, "second-join", deadline); sockets.push(second);
    await second.open();
    frame = await second.next(); assertFrame(frame, { type: "system", event: "joined" }, scope, "second-joined"); recordFrame(observations, "second-joined", frame, normalizer, scope);
    frame = await first.next(); assertFrame(frame, { type: "system", event: "peer-joined" }, scope, "peer-joined"); recordFrame(observations, "first-peer-joined", frame, normalizer, scope);
    frame = await first.next(); assertFrame(frame, { type: "system", event: "peer-list" }, scope, "first-peer-list-after-second"); recordFrame(observations, "first-peer-list-after-second", frame, normalizer, scope);
    frame = await second.next(); assertFrame(frame, { type: "system", event: "peer-list" }, scope, "second-peer-list"); recordFrame(observations, "second-peer-list", frame, normalizer, scope);

    first.send(fixture.plaintext);
    frame = await first.next(); assertFrame(frame, { type: "system", event: "invalid-message" }, scope, "plaintext-rejected"); recordFrame(observations, "plaintext-rejected", frame, normalizer, scope);
    await expectNoFrame(second, scope, "plaintext-not-relayed", deadline);
    first.send(fixture.secure);
    frame = await second.next();
    if (frame?.type !== "secure" || frame.v !== 1 || frame.channel !== fixture.secure.channel || frame.nonce !== fixture.secure.nonce || frame.ciphertext !== fixture.secure.ciphertext || Object.hasOwn(frame, "unknown")) fail(scope, "secure-relay", "secure relay did not preserve its allowlisted fields");
    assertFrame(frame, { type: "secure" }, scope, "secure-relay"); recordFrame(observations, "secure-relay", frame, normalizer, scope);
    first.send(fixture.invalidEnvelope);
    frame = await first.next(); assertFrame(frame, { type: "system", event: "invalid-message" }, scope, "invalid-envelope-rejected"); recordFrame(observations, "invalid-envelope-rejected", frame, normalizer, scope);
    await expectNoFrame(second, scope, "invalid-envelope-not-relayed", deadline);
    first.send(fixture.leave);
    frame = await second.next(); assertFrame(frame, { type: "system", event: "peer-left" }, scope, "peer-left"); recordFrame(observations, "peer-left", frame, normalizer, scope);
    frame = await second.next(); assertFrame(frame, { type: "system", event: "peer-list" }, scope, "peer-list-after-leave"); recordFrame(observations, "peer-list-after-leave", frame, normalizer, scope);
    await first.waitClosed();
    if (first.closeCode() !== 1005) fail(scope, "leave-close", "leave close status did not match the empty close frame");
    recordFrame(observations, "leave-close", { code: first.closeCode() }, normalizer, scope);

    const fullFirst = createSocketClient(localWebSocketUrl(baseUrl, primaryRoom), scope, "full-first", deadline); sockets.push(fullFirst);
    await fullFirst.open();
    frame = await fullFirst.next(); assertFrame(frame, { type: "system", event: "joined" }, scope, "full-first-joined"); recordFrame(observations, "full-first-joined", frame, normalizer, scope);
    frame = await fullFirst.next(); assertFrame(frame, { type: "system", event: "peer-list" }, scope, "full-first-peer-list-initial"); recordFrame(observations, "full-first-peer-list-initial", frame, normalizer, scope);
    const fullSecond = createSocketClient(localWebSocketUrl(baseUrl, primaryRoom), scope, "full-second", deadline); sockets.push(fullSecond);
    await fullSecond.open();
    frame = await fullSecond.next(); assertFrame(frame, { type: "system", event: "joined" }, scope, "full-second-joined"); recordFrame(observations, "full-second-joined", frame, normalizer, scope);
    frame = await fullFirst.next(); assertFrame(frame, { type: "system", event: "peer-joined" }, scope, "full-first-peer-joined"); recordFrame(observations, "full-first-peer-joined", frame, normalizer, scope);
    frame = await fullFirst.next(); assertFrame(frame, { type: "system", event: "peer-list" }, scope, "full-first-peer-list-after-second"); recordFrame(observations, "full-first-peer-list-after-second", frame, normalizer, scope);
    frame = await fullSecond.next(); assertFrame(frame, { type: "system", event: "peer-list" }, scope, "full-second-peer-list"); recordFrame(observations, "full-second-peer-list", frame, normalizer, scope);
    const fullThird = createSocketClient(localWebSocketUrl(baseUrl, primaryRoom), scope, "full-third", deadline); sockets.push(fullThird);
    await fullThird.open();
    frame = await fullThird.next(); assertFrame(frame, { type: "system", event: "room-full" }, scope, "room-full"); recordFrame(observations, "room-full", frame, normalizer, scope);
    await fullThird.waitClosed();
    if (fullThird.closeCode() !== 1005) fail(scope, "room-full-close", "room-full close status did not match the empty close frame");
    recordFrame(observations, "room-full-close", { code: fullThird.closeCode() }, normalizer, scope);

    const missing = createSocketClient(localWebSocketUrl(baseUrl, fixture.missingRoomId), scope, "missing-room", deadline); sockets.push(missing);
    await missing.open();
    frame = await missing.next(); assertFrame(frame, { type: "system", event: "room-not-found" }, scope, "room-not-found"); recordFrame(observations, "room-not-found", frame, normalizer, scope);
    await missing.waitClosed();
    if (missing.closeCode() !== 1005) fail(scope, "room-not-found-close", "room-not-found close status did not match the empty close frame");
    recordFrame(observations, "room-not-found-close", { code: missing.closeCode() }, normalizer, scope);
  } finally {
    for (const client of sockets.reverse()) await client.dispose();
  }
  return observations;
}

async function assertDataDirectoryEmpty(dataDir, scope) {
  let entries;
  try { entries = await readdir(dataDir); } catch { fail(scope, "privacy-storage", "P2P data directory could not be inspected"); }
  if (entries.length > 0) fail(scope, "privacy-storage", "P2P runtime created persistent data artifacts");
}

async function runImplementation({ binary, port, fixtures, run, tempRoot }) {
  const baseUrl = localBaseUrl(port);
  const dataDir = await mkdtemp(path.join(tempRoot, "go-data-"));
  const state = launchProcess(binary, buildChildEnvironment({ baseUrl, port, dataDir }));
  const normalizer = createNormalizer();
  let result = null;
  let primaryError = null;
  try {
    const startupDeadline = Math.min(run.deadline, Date.now() + STARTUP_TIMEOUT_MS);
    while (true) {
      run.signal.throwIfAborted();
      if (processHasExited(state)) fail("go", "startup", "Go P2P process exited before health became ready");
      if (Date.now() >= startupDeadline) fail("go", "startup", "Go P2P process did not become ready within the bound");
      try {
        const result = await fetchWithTimeout(new URL("/api/health", baseUrl), {}, Math.min(500, startupDeadline - Date.now()), run.signal);
        if (result.response.status === 200) break;
      } catch {
        // Poll until the bounded startup deadline.
      }
      await delay(Math.min(100, startupDeadline - Date.now()));
    }
    const http = await runHttpFixtures(baseUrl, fixtures.httpCases, run.deadline, "go", normalizer, run.signal);
    const websocket = await runWebSocketFixtures(baseUrl, http.state, fixtures.websocket, run.deadline, "go", normalizer);
    result = { http: http.observations, websocket };
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try {
    await stopProcess(state);
    await assertDataDirectoryEmpty(dataDir, "go");
  } catch (error) {
    cleanupError = error;
  }
  try {
    await rm(dataDir, { recursive: true, force: true });
  } catch (error) {
    cleanupError = combineCleanupFailure(cleanupError, error, "P2P data-directory cleanup");
  }
  const error = combineCleanupFailure(primaryError, cleanupError, "P2P Go contract");
  if (error) {
    throw error;
  }
  return result;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function valueKind(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function differencePaths(left, right, current = "response") {
  if (valueKind(left) !== valueKind(right)) return [`${current} type differs`];
  if (Array.isArray(left)) {
    if (left.length !== right.length) return [`${current} length differs`];
    return left.flatMap((value, index) => differencePaths(value, right[index], `${current}[${index}]`));
  }
  if (left && typeof left === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (stableStringify(leftKeys) !== stableStringify(rightKeys)) return [`${current} keys differ`];
    return leftKeys.flatMap((key) => differencePaths(left[key], right[key], `${current}.${REPORTABLE_FIELDS.has(key) ? key : "<field>"}`));
  }
  if (left !== right) return [`${current} value differs`];
  return [];
}

function compareObservations(frozenResult, goResult) {
  const mismatches = [];
  for (const suite of ["http", "websocket"]) {
    const frozenMap = new Map(frozenResult[suite].map((entry) => [entry.name, entry.value]));
    const goMap = new Map(goResult[suite].map((entry) => [entry.name, entry.value]));
    for (const name of new Set([...frozenMap.keys(), ...goMap.keys()])) {
      if (!frozenMap.has(name) || !goMap.has(name)) { mismatches.push(`${suite}/${name}: observation missing from one implementation`); continue; }
      if (stableStringify(frozenMap.get(name)) !== stableStringify(goMap.get(name))) {
        mismatches.push(`${suite}/${name}: ${differencePaths(frozenMap.get(name), goMap.get(name)).slice(0, 5).join("; ") || "projection differs"}`);
      }
    }
  }
  return mismatches;
}

async function buildGoBinary(buildRoot) {
  const name = process.platform === "win32" ? "p2p-frozen-contract.exe" : "p2p-frozen-contract";
  const binary = path.join(buildRoot, name);
  const child = spawnOwnedProcess("go", ["build", "-buildvcs=false", "-o", binary, "./cmd/p2p"], {
    cwd: BACKEND_ROOT,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true
  });
  const state = { child, spawnError: null };
  child.once("error", (error) => { state.spawnError = error; });
  activeProcesses.add(state);
  let timedOut = false;
  let timer;
  let settled = false;
  const buildPromise = new Promise((resolve, reject) => {
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.once("error", () => {
      if (timedOut) return;
      settle(reject, new Error("Go P2P binary build failed"));
    });
    child.once("exit", (code) => {
      if (timedOut) return;
      settle(code === 0 ? resolve : reject, code === 0 ? undefined : new Error("Go P2P binary build failed"));
    });
    timer = setTimeout(() => {
      timedOut = true;
      void (async () => {
        let cleanupError = null;
        try {
          await stopProcess(state);
        } catch (error) {
          cleanupError = error;
        }
        const timeoutError = new Error("Go P2P binary build exceeded the bound");
        timeoutError.code = "P2P_BUILD_TIMEOUT";
        settle(reject, combineCleanupFailure(timeoutError, cleanupError, "Go P2P build cleanup"));
      })();
    }, BUILD_TIMEOUT_MS);
  });
  let primaryError = null;
  try {
    await buildPromise;
  } catch (error) {
    primaryError = error;
  } finally {
    clearTimeout(timer);
  }
  let cleanupError = null;
  try {
    await stopProcess(state);
  } catch (error) {
    cleanupError = error;
  }
  const error = combineCleanupFailure(primaryError, cleanupError, "Go P2P build");
  if (error) {
    throw error;
  }
  return binary;
}

async function runContract(binary) {
  const [fixtures, frozen] = await Promise.all([loadFixtures(), loadFrozenObservations()]);
  const fixtureNames = fixtures.httpCases.map((entry) => entry.name);
  if (stableStringify(fixtureNames) !== stableStringify(frozen.http.map((entry) => entry.name))) {
    throw new Error("frozen P2P HTTP observations do not cover the fixture set exactly");
  }
  const run = createRunContext();
  const tempRoot = await mkdtemp(path.join(tmpdir(), "duallane-p2p-frozen-"));
  activeRun = run;
  let result = null;
  let primaryError = null;
  try {
    const port = await allocateLocalPort();
    const goResult = await runImplementation({ binary, port, fixtures, run, tempRoot });
    const mismatches = compareObservations(frozen, goResult);
    if (mismatches.length > 0) {
      for (const mismatch of mismatches) console.error(`Frozen Go P2P contract mismatch: ${mismatch}`);
      throw new Error("frozen Go P2P contract mismatch");
    }
    result = goResult;
  } catch (error) {
    primaryError = error;
  }
  run.clear();
  activeRun = null;
  let cleanupError = signalCleanupFailure;
  signalCleanupFailure = null;
  try {
    await stopAllProcesses();
  } catch (error) {
    cleanupError = combineCleanupFailure(cleanupError, error, "P2P child-process cleanup");
  }
  try {
    await rm(tempRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError = combineCleanupFailure(cleanupError, error, "P2P temporary-root cleanup");
  }
  const error = combineCleanupFailure(primaryError, cleanupError, "P2P frozen contract");
  if (error) {
    throw error;
  }
  return result;
}

function safeFailureMessage(error) {
  return error?.code === "P2P_TIMEOUT" || error?.code === "P2P_RUN_TIMEOUT" ? "operation timed out" : "runner or transport error";
}

function handleSignal() {
  interrupted = true;
  activeRun?.controller.abort();
  void stopAllProcesses().catch((error) => {
    signalCleanupFailure = error;
    process.exitCode = 1;
    process.stderr.write("P2P frozen contract owned-process cleanup failed\n");
  });
}

function reportFailure(error) {
  if (interrupted) {
    console.error("P2P frozen contract interrupted: bounded child-process and temporary-data cleanup attempted");
    process.exitCode = 130;
  } else if (error instanceof ContractFailure) {
    console.error(`P2P frozen contract failed: ${error.scope}/${error.caseName}: ${error.reason}`);
    process.exitCode = 1;
  } else if (error?.message === "frozen Go P2P contract mismatch") {
    console.error("P2P frozen contract failed: frozen Node observation mismatch requires review");
    process.exitCode = 1;
  } else if (error?.code === "P2P_RUN_TIMEOUT" || error?.code === "P2P_BUILD_TIMEOUT") {
    console.error("P2P frozen contract failed: time bound exceeded");
    process.exitCode = 1;
  } else if (error instanceof AggregateError) {
    console.error("P2P frozen contract failed: owned cleanup did not complete");
    process.exitCode = 1;
  } else {
    console.error(`P2P frozen contract failed: ${safeFailureMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  let argumentsValue;
  try { argumentsValue = parseArguments(process.argv.slice(2)); }
  catch (error) {
    console.error(`P2P frozen contract usage error: ${error.message}`);
    printUsage();
    process.exitCode = 2;
    return;
  }
  let buildRoot = null;
  let result = null;
  let primaryError = null;
  try {
    buildRoot = await mkdtemp(path.join(tmpdir(), "duallane-p2p-build-"));
    const binary = argumentsValue.binary || await buildGoBinary(buildRoot);
    result = await runContract(binary);
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = signalCleanupFailure;
  signalCleanupFailure = null;
  try {
    await stopAllProcesses();
  } catch (error) {
    cleanupError = combineCleanupFailure(cleanupError, error, "P2P child-process cleanup");
  }
  if (buildRoot) {
    try {
      await rm(buildRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError = combineCleanupFailure(cleanupError, error, "P2P build-root cleanup");
    }
  }
  if (interrupted && !primaryError) primaryError = new Error("P2P frozen contract interrupted");
  const error = combineCleanupFailure(primaryError, cleanupError, "P2P frozen contract");
  if (error) {
    reportFailure(error);
    return;
  }
  console.log(`Frozen Go P2P contract passed (${result.http.length} HTTP, ${result.websocket.length} WebSocket observations; required core 20/19 retained)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  await main();
}

export {
  buildChildEnvironment,
  compareObservations,
  createNormalizer,
  createSocketClient,
  loadFixtures,
  loadFrozenObservations,
  parseArguments,
  safeFailureMessage
};
