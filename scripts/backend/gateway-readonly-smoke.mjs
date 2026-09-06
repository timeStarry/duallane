import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOTAL_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_WS_FRAME_BYTES = 16 * 1024;
const MAX_WS_FRAMES = 8;
const MAX_ASSET_REFERENCES = 64;
const MAX_ICE_SERVERS = 64;

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const PROFILE_NAMES = Object.freeze(["node-default", "go-full"]);
const PROFILE_CONTRACTS = new Set(PROFILE_NAMES);

const WORKSPACE_HELLO = JSON.stringify({ version: 1, type: "hello", lastSeq: 0 });
const WS_HANDSHAKE_KEY = Buffer.alloc(16, 0x5a).toString("base64");

export const GATEWAY_SMOKE_LIMITS = Object.freeze({
  totalTimeoutMs: TOTAL_TIMEOUT_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  maxHTMLBytes: MAX_HTML_BYTES,
  maxJSONBytes: MAX_JSON_BYTES,
  maxAssetBytes: MAX_ASSET_BYTES,
  maxWebSocketFrameBytes: MAX_WS_FRAME_BYTES,
  maxWebSocketFrames: MAX_WS_FRAMES,
  maxAssetReferences: MAX_ASSET_REFERENCES
});

export const GATEWAY_SMOKE_PROFILES = PROFILE_NAMES;

export class GatewaySmokeError extends Error {
  constructor(code, stage) {
    super(code);
    this.name = "GatewaySmokeError";
    this.code = code;
    this.stage = stage;
  }
}

function smokeError(code, stage) {
  return new GatewaySmokeError(code, stage);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.slice(1).every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}

function normalizeBaseURL(value) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw smokeError("invalid_base_url", "input");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw smokeError("invalid_base_url", "input");
  }
  if (
    parsed.protocol !== "http:" ||
    !isLoopbackHostname(parsed.hostname) ||
    !parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw smokeError("invalid_base_url", "input");
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw smokeError("invalid_base_url", "input");
  }
  return parsed;
}

function normalizeExpectedVersion(value) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw smokeError("invalid_expected_version", "input");
  }
  return value;
}

function normalizeFullCommit(value) {
  if (typeof value !== "string" || !FULL_COMMIT_PATTERN.test(value)) {
    throw smokeError("invalid_full_commit", "input");
  }
  return value;
}

function normalizeProfile(value) {
  if (typeof value !== "string" || !PROFILE_CONTRACTS.has(value)) {
    throw smokeError("invalid_profile", "input");
  }
  return value;
}

function normalizeWorkspaceEnabled(value, profile) {
  if (typeof value !== "boolean") throw smokeError("invalid_workspace_enabled", "input");
  if (profile === "go-full" && value !== true) throw smokeError("go_workspace_must_be_enabled", "input");
  return value;
}

function normalizeOptions(options) {
  if (!isRecord(options)) throw smokeError("invalid_options", "input");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw smokeError("fetch_unavailable", "input");
  if (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== "function")) {
    throw smokeError("invalid_signal", "input");
  }
  return {
    baseURL: normalizeBaseURL(options.baseURL),
    expectedVersion: normalizeExpectedVersion(options.expectedVersion),
    fullCommit: normalizeFullCommit(options.fullCommit),
    profile: normalizeProfile(options.profile),
    workspaceEnabled: normalizeWorkspaceEnabled(options.workspaceEnabled, options.profile),
    fetchImpl,
    WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
    signal: options.signal
  };
}

function createRunContext(parentSignal) {
  const controller = new AbortController();
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let timedOut = false;
  let externallyAborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TOTAL_TIMEOUT_MS);
  timer.unref?.();

  let onParentAbort;
  if (parentSignal) {
    onParentAbort = () => {
      externallyAborted = true;
      controller.abort();
    };
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    remainingMs() {
      return Math.max(0, deadline - Date.now());
    },
    abortCode() {
      if (timedOut) return "total_timeout";
      if (externallyAborted) return "aborted";
      return "request_timeout";
    },
    close() {
      clearTimeout(timer);
      if (parentSignal && onParentAbort) parentSignal.removeEventListener("abort", onParentAbort);
    }
  };
}

async function cancelResponse(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is already being discarded. Never surface provider details.
  }
}

async function awaitWithAbort(promise, signal, stage) {
  if (signal.aborted) throw smokeError("request_timeout", stage);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(smokeError("request_timeout", stage));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedBody(response, maxBytes, signal, stage) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined && declaredLength !== "") {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      await cancelResponse(response);
      throw smokeError("invalid_content_length", stage);
    }
    if (length > maxBytes) {
      await cancelResponse(response);
      throw smokeError("body_too_large", stage);
    }
  }

  if (!response.body) return new Uint8Array();
  if (typeof response.body.getReader !== "function") {
    await cancelResponse(response);
    throw smokeError("body_reader_unavailable", stage);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let finished = false;
  try {
    while (true) {
      if (signal.aborted) throw smokeError("request_timeout", stage);
      const result = await readWithAbort(reader, signal, stage);
      if (result.done) {
        finished = true;
        break;
      }
      const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
      total += chunk.byteLength;
      if (total > maxBytes) throw smokeError("body_too_large", stage);
      chunks.push(chunk);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the safe smoke failure.
    }
    if (error instanceof GatewaySmokeError) throw error;
    if (signal.aborted) throw smokeError("request_timeout", stage);
    throw smokeError("body_read_failed", stage);
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // Nothing else can safely be done with a partially-read body.
      }
    }
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readWithAbort(reader, signal, stage) {
  if (signal.aborted) throw smokeError("request_timeout", stage);
  let onAbort;
  const abort = new Promise((_, reject) => {
    onAbort = () => reject(smokeError("request_timeout", stage));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), abort]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function decodeUTF8(bytes, stage) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw smokeError("invalid_utf8", stage);
  }
}

function parseJSON(bytes, stage) {
  try {
    return JSON.parse(decodeUTF8(bytes, stage));
  } catch (error) {
    if (error instanceof GatewaySmokeError) throw error;
    throw smokeError("invalid_json", stage);
  }
}

function routeURL(baseURL, pathname, stage) {
  let target;
  try {
    target = new URL(pathname, baseURL);
  } catch {
    throw smokeError("invalid_route", stage);
  }
  if (
    target.origin !== baseURL.origin ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw smokeError("unsafe_route", stage);
  }
  return target;
}

async function requestGET(context, options, pathname, stage, maxBytes, extraHeaders = {}) {
  const remaining = context.remainingMs();
  if (remaining <= 0 || context.signal.aborted) throw smokeError(context.abortCode(), stage);

  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  context.signal.addEventListener("abort", abortRequest, { once: true });
  const timeout = setTimeout(() => requestController.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
  timeout.unref?.();
  let response;
  try {
    const fetchPromise = Promise.resolve().then(() => options.fetchImpl(routeURL(options.baseURL, pathname, stage), {
      method: "GET",
      headers: { accept: "application/json, text/html, */*", ...extraHeaders },
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      signal: requestController.signal
    }));
    fetchPromise.then((lateResponse) => {
      if (requestController.signal.aborted) void cancelResponse(lateResponse);
    }, () => {});
    response = await awaitWithAbort(fetchPromise, requestController.signal, stage);
    if (!response || typeof response.status !== "number" || !response.headers) {
      throw smokeError("invalid_response", stage);
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponse(response);
      throw smokeError("redirect_rejected", stage);
    }
    const body = await readBoundedBody(response, maxBytes, requestController.signal, stage);
    return { status: response.status, headers: response.headers, body };
  } catch (error) {
    if (error instanceof GatewaySmokeError) throw error;
    if (requestController.signal.aborted) throw smokeError(context.abortCode(), stage);
    throw smokeError("request_failed", stage);
  } finally {
    clearTimeout(timeout);
    context.signal.removeEventListener("abort", abortRequest);
    if (response && response.status >= 300 && response.status < 400) await cancelResponse(response);
  }
}

async function requestJSON(context, options, pathname, stage, maxBytes = MAX_JSON_BYTES, extraHeaders = {}) {
  const response = await requestGET(context, options, pathname, stage, maxBytes, extraHeaders);
  return { ...response, payload: parseJSON(response.body, stage) };
}

async function readNodeResponseBody(response, maxBytes, signal, stage) {
  const declaredLength = response.headers["content-length"];
  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      response.destroy();
      throw smokeError(length > maxBytes ? "body_too_large" : "invalid_content_length", stage);
    }
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      if (signal.aborted) throw smokeError("request_timeout", stage);
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        response.destroy();
        throw smokeError("body_too_large", stage);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    response.destroy();
    if (error instanceof GatewaySmokeError) throw error;
    if (signal.aborted) throw smokeError("request_timeout", stage);
    throw smokeError("body_read_failed", stage);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function requestHTTPUpgrade(context, options, pathname, stage, maxBytes) {
  const remaining = context.remainingMs();
  if (remaining <= 0 || context.signal.aborted) throw smokeError(context.abortCode(), stage);
  const target = routeURL(options.baseURL, pathname, stage);
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  context.signal.addEventListener("abort", abortRequest, { once: true });
  const timeout = setTimeout(() => requestController.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
  timeout.unref?.();

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const request = httpRequest({
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/gu, ""),
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: {
          accept: "application/json, */*",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": WS_HANDSHAKE_KEY
        }
      }, (response) => {
        void readNodeResponseBody(response, maxBytes, requestController.signal, stage)
          .then((body) => finish(resolve, { status: response.statusCode ?? 0, headers: response.headers, body }))
          .catch((error) => finish(reject, error));
      });
      const onAbort = () => {
        request.destroy();
        finish(reject, smokeError(context.abortCode(), stage));
      };
      requestController.signal.addEventListener("abort", onAbort, { once: true });
      request.once("error", () => {
        requestController.signal.removeEventListener("abort", onAbort);
        if (requestController.signal.aborted) finish(reject, smokeError(context.abortCode(), stage));
        else finish(reject, smokeError("request_failed", stage));
      });
      request.once("upgrade", (_response, socket) => {
        socket.destroy();
        finish(reject, smokeError("ws_upgrade_without_client", stage));
      });
      request.once("close", () => requestController.signal.removeEventListener("abort", onAbort));
      request.end();
    });
  } catch (error) {
    if (error instanceof GatewaySmokeError) throw error;
    if (requestController.signal.aborted) throw smokeError(context.abortCode(), stage);
    throw smokeError("request_failed", stage);
  } finally {
    clearTimeout(timeout);
    context.signal.removeEventListener("abort", abortRequest);
  }
}

function requireStatus(response, expectedStatus, stage) {
  if (response.status !== expectedStatus) throw smokeError("unexpected_status", stage);
}

function requireErrorCode(payload, expectedCode, stage) {
  if (!isRecord(payload) || !isRecord(payload.error) || payload.error.code !== expectedCode) {
    throw smokeError("unexpected_error_contract", stage);
  }
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isHTMLResponse(headers) {
  const contentType = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  return contentType === "text/html";
}

function classifyPrivateEntry(response, homeResponse, profile, stage) {
  if (response.status === 404) return "not_exposed/404";
  if (
    profile === "node-default" &&
    response.status === 200 &&
    isHTMLResponse(response.headers) &&
    equalBytes(response.body, homeResponse.body)
  ) {
    return "not_exposed/SPA";
  }
  throw smokeError("private_entry_exposed", stage);
}

function localAssetReferences(html, baseURL, stage) {
  const references = new Set();
  const tagPattern = /<(?:script|link|img|source|video|audio)\b[^>]*?(?:src|href)\s*=\s*(["'])(.*?)\1/giu;
  for (const match of html.matchAll(tagPattern)) {
    const raw = match[2].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("javascript:")) continue;
    let target;
    try {
      target = new URL(raw, baseURL);
    } catch {
      throw smokeError("invalid_asset_reference", stage);
    }
    if (target.origin !== baseURL.origin) continue;
    if (target.username || target.password || target.hash) throw smokeError("unsafe_asset_reference", stage);
    if (!target.pathname.startsWith("/")) throw smokeError("unsafe_asset_reference", stage);
    references.add(`${target.pathname}${target.search}`);
    if (references.size > MAX_ASSET_REFERENCES) throw smokeError("asset_reference_limit", stage);
  }
  if (references.size === 0) throw smokeError("no_local_assets", stage);
  return [...references];
}

function verifyReleaseIdentity(payload, expectedVersion, stage) {
  if (!isRecord(payload) || payload.ok !== true || payload.service !== "duallane" || payload.lane !== "ready") {
    throw smokeError("health_contract_mismatch", stage);
  }
  if (payload.appVersion !== expectedVersion) throw smokeError("health_version_mismatch", stage);

  // The public Node and Go health contracts expose the HTTP app version, not
  // the image revision. The caller must have independently verified the
  // supplied full commit against the exact immutable container/image labels;
  // this read-only gateway probe must not invent a public commit field.
  return "not-exposed";
}

function parseHomeAssetReferences(body, baseURL, stage) {
  const html = decodeUTF8(body, stage);
  if (!/<html\b/iu.test(html)) throw smokeError("home_not_html", stage);
  return localAssetReferences(html, baseURL, stage);
}

function validateICEServers(payload, stage) {
  if (!isRecord(payload) || !Array.isArray(payload.iceServers) || payload.iceServers.length > MAX_ICE_SERVERS) {
    throw smokeError("ice_contract_mismatch", stage);
  }
  for (const server of payload.iceServers) {
    if (!isRecord(server) || !(typeof server.urls === "string" || Array.isArray(server.urls))) {
      throw smokeError("ice_contract_mismatch", stage);
    }
  }
}

function addSocketListener(socket, type, handler) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(type, handler);
    return () => socket.removeEventListener?.(type, handler);
  }
  if (typeof socket.on === "function") {
    socket.on(type, handler);
    return () => socket.off?.(type, handler);
  }
  const property = `on${type}`;
  const previous = socket[property];
  socket[property] = handler;
  return () => {
    if (socket[property] === handler) socket[property] = previous ?? null;
  };
}

function normalizeSocketCloseEvent(first, second) {
  if (isRecord(first)) return first;
  return { code: first, reason: second };
}

async function socketDataToBytes(data) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === "function") return new Uint8Array(await data.arrayBuffer());
  return new TextEncoder().encode(String(data ?? ""));
}

function isForbiddenWorkspaceFrame(frame, stage) {
  if (!isRecord(frame) || typeof frame.type !== "string") throw smokeError("invalid_ws_frame", stage);
  if (frame.type !== "error") {
    throw smokeError("workspace_ws_unauthorized_ready", stage);
  }
  if (frame.error?.code !== "auth.required") {
    throw smokeError("unexpected_ws_error", stage);
  }
}

function closeSocket(socket) {
  try {
    if (typeof socket.close === "function") socket.close(1000, "smoke complete");
    else socket.terminate?.();
  } catch {
    try {
      socket.terminate?.();
    } catch {
      // Socket cleanup is best effort and never leaks details into the report.
    }
  }
}

function probeWebSocket(context, options, contract, stage) {
  const WebSocketImpl = options.WebSocketImpl;
  if (typeof WebSocketImpl !== "function") return Promise.reject(smokeError("ws_client_unavailable", stage));
  const wsURL = routeURL(options.baseURL, "/ws/workspace", stage);
  wsURL.protocol = "ws:";

  return new Promise((resolve, reject) => {
    let socket;
    let opened = false;
    let settled = false;
    let closing = false;
    let frameCount = 0;
    const pendingFrames = new Set();
    const cleanups = [];
    const timer = setTimeout(() => {
      finishFailure("ws_timeout");
    }, Math.min(REQUEST_TIMEOUT_MS, context.remainingMs()));
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      while (cleanups.length > 0) cleanups.pop()();
    };
    const finishSuccess = () => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket(socket);
      resolve();
    };
    const finishFailure = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket(socket);
      reject(smokeError(code, stage));
    };
    const abort = () => finishFailure(context.abortCode());
    context.signal.addEventListener("abort", abort, { once: true });

    const onOpen = () => {
      opened = true;
      try {
        socket.send(WORKSPACE_HELLO);
      } catch {
        finishFailure("ws_send_failed");
      }
    };
    const validateMessage = async (event) => {
      const data = event?.data ?? event;
      if (typeof data === "string" && Buffer.byteLength(data, "utf8") > MAX_WS_FRAME_BYTES) {
        throw smokeError("ws_frame_too_large", stage);
      }
      if (data && typeof data.size === "number" && data.size > MAX_WS_FRAME_BYTES) {
        throw smokeError("ws_frame_too_large", stage);
      }
      const bytes = await socketDataToBytes(data);
      if (bytes.byteLength > MAX_WS_FRAME_BYTES) throw smokeError("ws_frame_too_large", stage);
      const frame = parseJSON(bytes, stage);
      isForbiddenWorkspaceFrame(frame, stage);
    };
    const onMessage = (event) => {
      if (settled || closing) {
        finishFailure("ws_frame_after_close");
        return;
      }
      frameCount += 1;
      if (frameCount > MAX_WS_FRAMES) {
        finishFailure("ws_frame_limit");
        return;
      }
      const pending = Promise.resolve().then(() => validateMessage(event));
      pendingFrames.add(pending);
      pending.then(
        () => pendingFrames.delete(pending),
        (error) => {
          pendingFrames.delete(pending);
          finishFailure(error instanceof GatewaySmokeError ? error.code : "invalid_ws_frame");
        }
      );
    };
    const onError = () => {
      // A WebSocket API does not expose the HTTP rejection status. Let the
      // bounded HTTP Upgrade probe classify a pre-upgrade refusal.
      if (!opened) finishFailure("ws_handshake_rejected");
      else finishFailure("ws_transport_failed");
    };
    const acceptClose = (first, second) => {
      const event = normalizeSocketCloseEvent(first, second);
      const code = Number(event.code);
      if (contract.websocketCloseCodes.includes(code)) {
        finishSuccess();
        return;
      }
      if (!opened) {
        finishFailure("ws_handshake_rejected");
        return;
      }
      finishFailure("ws_unexpected_close");
    };
    const onClose = (first, second) => {
      if (settled) return;
      closing = true;
      const pending = [...pendingFrames];
      if (pending.length === 0) {
        acceptClose(first, second);
        return;
      }
      Promise.allSettled(pending).then(() => acceptClose(first, second));
    };

    try {
      socket = new WebSocketImpl(wsURL);
      cleanups.push(addSocketListener(socket, "open", onOpen));
      cleanups.push(addSocketListener(socket, "message", onMessage));
      cleanups.push(addSocketListener(socket, "error", onError));
      cleanups.push(addSocketListener(socket, "close", onClose));
    } catch {
      finishFailure("ws_handshake_rejected");
    }
  });
}

async function probeHTTPWebSocketRejection(context, options, contract, stage) {
  const response = await requestHTTPUpgrade(context, options, "/ws/workspace", stage, MAX_JSON_BYTES);
  if (contract.websocketHTTPStatuses.includes(response.status)) return;
  if (response.status === 101) throw smokeError("ws_upgrade_without_client", stage);
  throw smokeError("unexpected_ws_http_status", stage);
}

async function checkWorkspaceWebSocket(context, options, contract, stage) {
  if (typeof options.WebSocketImpl === "function") {
    try {
      await probeWebSocket(context, options, contract, stage);
      return;
    } catch (error) {
      if (!(error instanceof GatewaySmokeError) || error.code !== "ws_handshake_rejected") throw error;
    }
  }
  await probeHTTPWebSocketRejection(context, options, contract, stage);
}

function workspaceContractFor(enabled) {
  return enabled
    ? {
        bootstrapStatus: 401,
        bootstrapCode: "auth.required",
        websocketCloseCodes: [1008],
        websocketHTTPStatuses: [401, 403, 426]
      }
    : {
        bootstrapStatus: 503,
        bootstrapCode: "workspace.disabled",
        websocketCloseCodes: [1013],
        websocketHTTPStatuses: [426, 503]
      };
}

function successStage(stage, count = 1) {
  return { stage, status: "PASS", count };
}

function failureStage(stage) {
  return { stage, status: "FAIL" };
}

function safeReport(stages, error) {
  const report = {
    status: error ? "FAIL" : "PASS",
    count: stages.reduce((total, stage) => total + (Number.isInteger(stage.count) ? stage.count : 0), 0),
    stages
  };
  if (error) {
    report.error = {
      stage: error.stage ?? stages.at(-1)?.stage ?? "unknown",
      code: error instanceof GatewaySmokeError ? error.code : "smoke_failed"
    };
  }
  return report;
}

export async function run(options = {}) {
  let normalized;
  try {
    normalized = normalizeOptions(options);
  } catch (error) {
    return safeReport([failureStage("input")], error);
  }

  const context = createRunContext(normalized.signal);
  const stages = [];
  let currentStage = "home";
  let assetReferences = [];
  let homeResponse;
  try {
    currentStage = "home";
    homeResponse = await requestGET(context, normalized, "/", currentStage, MAX_HTML_BYTES);
    requireStatus(homeResponse, 200, currentStage);
    assetReferences = parseHomeAssetReferences(homeResponse.body, normalized.baseURL, currentStage);
    stages.push(successStage(currentStage));

    currentStage = "assets";
    for (const reference of assetReferences) {
      const asset = await requestGET(context, normalized, reference, currentStage, MAX_ASSET_BYTES);
      requireStatus(asset, 200, currentStage);
    }
    stages.push(successStage(currentStage, assetReferences.length));

    currentStage = "health";
    const health = await requestJSON(context, normalized, "/api/health", currentStage);
    requireStatus(health, 200, currentStage);
    const publicCommit = verifyReleaseIdentity(health.payload, normalized.expectedVersion, currentStage);
    stages.push({ ...successStage(currentStage), publicCommit });

    currentStage = "ice";
    const ice = await requestJSON(context, normalized, "/api/p2p/ice-servers", currentStage);
    requireStatus(ice, 200, currentStage);
    validateICEServers(ice.payload, currentStage);
    stages.push(successStage(currentStage));

    const workspaceContract = workspaceContractFor(normalized.workspaceEnabled);
    currentStage = "workspace-bootstrap";
    const bootstrap = await requestJSON(context, normalized, "/api/workspace/bootstrap", currentStage);
    requireStatus(bootstrap, workspaceContract.bootstrapStatus, currentStage);
    requireErrorCode(bootstrap.payload, workspaceContract.bootstrapCode, currentStage);
    stages.push(successStage(currentStage));

    currentStage = "private-entries";
    const privateExposure = new Set();
    for (const pathname of ["/readyz", "/healthz", "/metrics"]) {
      const privateResponse = await requestGET(context, normalized, pathname, currentStage, MAX_JSON_BYTES);
      privateExposure.add(classifyPrivateEntry(privateResponse, homeResponse, normalized.profile, currentStage));
    }
    stages.push({
      ...successStage(currentStage, 3),
      exposure: privateExposure.has("not_exposed/SPA") ? "not_exposed/SPA" : "not_exposed/404"
    });

    currentStage = "workspace-ws";
    await checkWorkspaceWebSocket(context, normalized, workspaceContract, currentStage);
    stages.push(successStage(currentStage));
    return safeReport(stages);
  } catch (error) {
    const safeError = error instanceof GatewaySmokeError ? error : smokeError("smoke_failed", currentStage);
    stages.push(failureStage(currentStage));
    return safeReport(stages, safeError);
  } finally {
    context.close();
  }
}

function parseCLI(argv) {
  const values = {};
  const names = new Map([
    ["--base-url", "baseURL"],
    ["--expected-version", "expectedVersion"],
    ["--full-commit", "fullCommit"],
    ["--profile", "profile"],
    ["--workspace-enabled", "workspaceEnabled"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") return { help: true };
    const key = names.get(name);
    if (!key || index + 1 >= argv.length || values[key] !== undefined) throw smokeError("invalid_cli", "input");
    values[key] = argv[++index];
  }
  if (Object.keys(values).length !== names.size) throw smokeError("invalid_cli", "input");
  if (values.workspaceEnabled !== "true" && values.workspaceEnabled !== "false") {
    throw smokeError("invalid_workspace_enabled", "input");
  }
  values.workspaceEnabled = values.workspaceEnabled === "true";
  return values;
}

async function main() {
  let options;
  try {
    options = parseCLI(process.argv.slice(2));
    if (options.help) {
      process.stderr.write("gateway-readonly-smoke --base-url URL --expected-version VERSION --full-commit SHA --profile node-default|go-full --workspace-enabled true|false\n");
      return;
    }
  } catch (error) {
    const report = safeReport([failureStage("input")], error);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
    return;
  }
  const report = await run(options);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "PASS") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) await main();
