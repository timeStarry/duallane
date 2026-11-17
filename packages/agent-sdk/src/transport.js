// Shared HTTP boundary: credentials stay on the configured gateway origin.
export function gatewayTransportError(code, statusCode = 0, retryable = false) {
  const error = new Error("DualLane gateway request failed");
  error.name = "DualLaneAgentError";
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  error.retryable = retryable;
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
        const code = /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(data?.error?.code || "")
          ? data.error.code : "gateway.request_failed";
        throw gatewayTransportError(code, response.status, response.status === 429 || response.status >= 500);
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
