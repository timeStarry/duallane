// Shared HTTP boundary: credentials stay on the configured gateway origin.
export function optionalGatewayResult(error, fallback = null) {
  if (error?.code === "sdk.upgrade_required") throw error;
  return fallback;
}

export function sdkUpgradeInfo(input = {}, origin) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const base = new URL(origin);
  const integrationUrl = (value, fallback, allowed) => {
    try {
      const parsed = new URL(value || fallback, base);
      if (parsed.origin === base.origin && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && allowed.includes(parsed.pathname)) return parsed.href;
    } catch { /* Only fixed, same-origin upgrade resources are trusted. */ }
    return new URL(fallback, base).href;
  };
  const version = (value) => /^1\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/u.test(value || "") ? value : "1.2.0";
  return Object.freeze({
    minimumSdkVersion: version(input.minimumSdkVersion), latestSdkVersion: version(input.latestSdkVersion),
    runtimeManifestUrl: integrationUrl(input.runtimeManifestUrl, "/integrations/duallane-agent.manifest.json", ["/integrations/duallane-agent.manifest.json", "/integrations/v2/duallane-agent.manifest.json"]),
    docsUrl: integrationUrl(input.docsUrl, "/integrations/v2/duallane-channel.md", ["/integrations/duallane-channel.md", "/integrations/v2/duallane-channel.md"]),
    skillUrl: integrationUrl(input.skillUrl, "/integrations/duallane-agent/SKILL.md", ["/integrations/duallane-agent/SKILL.md"]),
  });
}

export function gatewayTransportError(code, statusCode = 0, retryable = false, upgrade) {
  const error = new Error("DualLane gateway request failed");
  error.name = "DualLaneAgentError";
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  error.retryable = code === "sdk.upgrade_required" ? false : retryable;
  if (code === "sdk.upgrade_required") {
    error.message = "DualLane Agent SDK upgrade required";
    if (upgrade) error.upgrade = upgrade;
  }
  return error;
}

export async function readGatewayBytes(response, maxBytes = 4 * 1024 * 1024) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw gatewayTransportError("gateway.response_too_large");
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw gatewayTransportError("gateway.response_too_large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw gatewayTransportError("gateway.response_too_large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readGatewayJson(response) {
  const type = response.headers?.get?.("content-type") || "";
  if (!/\bapplication\/(?:[a-z0-9.+-]*\+)?json\b/iu.test(type)) {
    await response.body?.cancel?.().catch(() => {});
    if (!response.ok) return {};
    throw gatewayTransportError("gateway.invalid_response", response.status, true);
  }
  try {
    const data = response.body || response.arrayBuffer
      ? JSON.parse((await readGatewayBytes(response)).toString("utf8"))
      : await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch (error) {
    if (error?.code === "gateway.response_too_large") throw error;
    if (!response.ok) return {};
    throw gatewayTransportError("gateway.invalid_response", response.status, true);
  }
}

export async function requestGateway({ fetchImpl, url, init, timeoutMs = 35_000, signal, read = readGatewayJson }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError("requestTimeoutMs is invalid");
  }
  const controller = new AbortController();
  let rejectDeadline;
  let timedOut = false;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const abort = () => {
    controller.abort();
    rejectDeadline(gatewayTransportError("sdk.aborted"));
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(gatewayTransportError("network.timeout", 0, true));
  }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw gatewayTransportError("sdk.aborted");
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        const data = await readGatewayJson(response);
        const code = response.status === 426 ? "sdk.upgrade_required" : /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(data?.error?.code || "")
          ? data.error.code : "gateway.request_failed";
        throw gatewayTransportError(code, response.status, response.status === 429 || response.status >= 500,
          code === "sdk.upgrade_required" ? sdkUpgradeInfo(data.error, url) : undefined);
      }
      return await read(response);
    })()]);
  } catch (error) {
    if (timedOut) throw gatewayTransportError("network.timeout", 0, true);
    if (signal?.aborted) throw gatewayTransportError("sdk.aborted");
    if (error?.name === "DualLaneAgentError") throw error;
    // Never retain a fetch cause, URL, response body, or arbitrary server message.
    throw gatewayTransportError("network.unavailable", 0, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
