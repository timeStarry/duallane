import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const MEDIA_MIB = 1024 * 1024;
const MEDIA_HARD_MAX_BYTES = 50 * MEDIA_MIB;
const MEDIA_REMOTE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain",
]);
const MEDIA_EXTENSIONS = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"],
  ["application/pdf", "pdf"], ["image/svg+xml", "svg"], ["text/plain", "txt"],
  ["text/markdown", "md"], ["text/csv", "csv"], ["text/html", "html"], ["text/css", "css"],
  ["text/javascript", "js"], ["application/javascript", "js"], ["text/xml", "xml"],
  ["application/xml", "xml"], ["application/json", "json"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
]);
const MEDIA_OFFICE_PARTS = new Map([
  ["docx", "word/document.xml"], ["xlsx", "xl/workbook.xml"], ["pptx", "ppt/presentation.xml"],
]);
const MEDIA_ERROR_MESSAGES = {
  "media.disabled": "Public media retrieval is not enabled.",
  "media.invalid_options": "Media retrieval limits are invalid.",
  "media.invalid_url": "The media URL is invalid.",
  "media.destination_denied": "The media destination is not permitted.",
  "media.dns_failed": "The media destination could not be resolved.",
  "media.network": "The media connection failed.",
  "media.timeout": "Media retrieval timed out.",
  "media.cancelled": "Media retrieval was cancelled.",
  "media.redirect_limit": "The media redirect limit was reached.",
  "media.response_invalid": "The media response is invalid.",
  "media.http_error": "The media server refused the request.",
  "media.encoding_unsupported": "Compressed media responses are not supported.",
  "media.too_large": "The media exceeds the byte limit.",
  "artifact.invalid_bytes": "The artifact must contain non-empty bytes.",
  "artifact.too_large": "The artifact exceeds the byte limit.",
  "artifact.unsupported_type": "The artifact format is not supported.",
  "artifact.type_mismatch": "The artifact bytes do not match the declared format.",
};

export class MediaPolicyError extends Error {
  constructor(code, options = {}) {
    super(MEDIA_ERROR_MESSAGES[code] || "Media validation failed.");
    this.name = "MediaPolicyError";
    this.code = Object.hasOwn(MEDIA_ERROR_MESSAGES, code) ? code : "media.response_invalid";
    this.retryable = options.retryable === true;
    if (Number.isInteger(options.status)) this.status = options.status;
  }
}

function mediaLimit(value, fallback, maximum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new MediaPolicyError("media.invalid_options");
  }
  return result;
}

function mediaUtf8(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

// This validates the bounded container envelope, not document safety or content.
// No entry is decompressed, rendered, followed, or executed by the SDK.
function mediaOfficeEnvelope(bytes, extension) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) return false;
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (count < 2 || count > 2048 || bytes.readUInt16LE(end + 8) !== count || centralStart + centralSize !== end) return false;
  const names = new Set();
  const ranges = [];
  let offset = centralStart;
  let expanded = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return false;
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const local = bytes.readUInt32LE(offset + 42);
    if (entryEnd > end || nameLength < 1 || nameLength > 1024 || flags & 0x41 || ![0, 8].includes(method) ||
        (method === 0 && compressed !== size) ||
        bytes.readUInt16LE(offset + 34) !== 0 || (mode & 0xf000) === 0xa000) return false;
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = mediaUtf8(nameBytes);
    if (!name || name.startsWith("/") || /[\\:\u0000]/u.test(name) ||
        name.split("/").some((part) => part === "." || part === "..") || names.has(name)) return false;
    expanded += size;
    if (expanded > MEDIA_HARD_MAX_BYTES || compressed > MEDIA_HARD_MAX_BYTES ||
        size === 0xffffffff || local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50) return false;
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > centralStart || localNameLength !== nameLength ||
        bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method ||
        !bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)) return false;
    if (!(flags & 8) && (bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) return false;
    ranges.push([local, dataStart + compressed]);
    names.add(name);
    offset = entryEnd;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) return false;
  return offset === end && names.has("[Content_Types].xml") && names.has(MEDIA_OFFICE_PARTS.get(extension));
}

/** Validate an opaque artifact envelope; this does not render or sanitize documents. */
export function validateArtifactBytes(rawBytes, declaredMimeType, options = {}) {
  const maxBytes = mediaLimit(options.maxBytes, 25 * MEDIA_MIB, MEDIA_HARD_MAX_BYTES);
  if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength === 0) {
    throw new MediaPolicyError("artifact.invalid_bytes");
  }
  if (rawBytes.byteLength > maxBytes) throw new MediaPolicyError("artifact.too_large");
  const bytes = Buffer.from(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const mimeType = String(declaredMimeType || "").split(";", 1)[0].trim().toLowerCase();
  const extension = MEDIA_EXTENSIONS.get(mimeType);
  if (!extension || (options.source === "https" && !MEDIA_REMOTE_TYPES.has(mimeType))) {
    throw new MediaPolicyError("artifact.unsupported_type");
  }
  let matches = false;
  if (mimeType === "image/png") {
    matches = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
      bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  } else if (mimeType === "image/jpeg") {
    matches = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  } else if (mimeType === "image/gif") {
    matches = bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) &&
      bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes[bytes.length - 1] === 0x3b;
  } else if (mimeType === "image/webp") {
    matches = bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) &&
      bytes.readUInt32LE(4) + 8 === bytes.length;
  } else if (mimeType === "application/pdf") {
    matches = bytes.length >= 14 && /^%PDF-[12]\.\d/u.test(bytes.toString("ascii", 0, 8)) &&
      /%%EOF\s*$/u.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString("ascii"));
  } else if (MEDIA_OFFICE_PARTS.has(extension)) {
    matches = mediaOfficeEnvelope(bytes, extension);
  } else {
    const text = mediaUtf8(bytes);
    matches = text !== null;
    if (matches && mimeType === "image/svg+xml") matches = /^(?:\s|<\?xml[^?]*\?>)*<svg(?:\s|>)/u.test(text);
    if (matches && mimeType === "application/json") {
      try { JSON.parse(text); } catch { matches = false; }
    }
    if (matches && options.source === "https") {
      // A remote HTML error/login page is not a text attachment.
      matches = !/^\s*(?:<!doctype\s+html|<html|<script|<svg|<\?xml)/iu.test(text);
    }
  }
  if (!matches) throw new MediaPolicyError("artifact.type_mismatch");
  return { mimeType, byteSize: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), extension };
}

function mediaIpv4Public(address) {
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function mediaIpv6Words(address) {
  if (address.includes(".") || address.includes("%")) return null;
  const halves = address.toLowerCase().split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right].map((part) => parseInt(part, 16));
}

function mediaPublicAddress(address) {
  if (typeof address !== "string" || address.length > 64) return false;
  const family = net.isIP(address);
  if (family === 4) return mediaIpv4Public(address);
  if (family !== 6) return false;
  const words = mediaIpv6Words(address);
  // Only ordinary global unicast, excluding protocol, transition and documentation ranges.
  // This deliberately rejects mapped/NAT64/6to4/Teredo even when their embedded IPv4 is public.
  return words !== null && (words[0] & 0xe000) === 0x2000 &&
    !(words[0] === 0x2001 && words[1] < 0x200) &&
    !(words[0] === 0x2001 && words[1] === 0xdb8) && words[0] !== 0x2002 &&
    !(words[0] === 0x3fff && (words[1] & 0xf000) === 0);
}

function mediaDestination(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new MediaPolicyError("media.invalid_url"); }
  if (typeof rawUrl !== "string" || rawUrl.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(rawUrl)) {
    throw new MediaPolicyError("media.invalid_url");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) {
    throw new MediaPolicyError("media.destination_denied");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (!hostname || hostname.endsWith(".") || (!net.isIP(hostname) && !hostname.includes("."))) {
    throw new MediaPolicyError("media.destination_denied");
  }
  url.hash = "";
  return { url, hostname };
}

function mediaAbortError(signal) {
  return signal.reason instanceof MediaPolicyError ? signal.reason : new MediaPolicyError("media.cancelled");
}

function mediaAwaitSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(mediaAbortError(signal));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function mediaResolveAddress(hostname, signal, resolver) {
  if (signal.aborted) throw mediaAbortError(signal);
  let addresses;
  try {
    const family = net.isIP(hostname);
    if (family) {
      addresses = [{ address: hostname, family }];
    } else if (resolver) {
      const resolveFamily = async (version) => {
        try {
          const records = await (version === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname));
          return records.map((address) => ({ address, family: version }));
        } catch (error) {
          if (["ENODATA", "ENOTFOUND"].includes(error.code)) return [];
          throw error;
        }
      };
      addresses = (await mediaAwaitSignal(Promise.all([resolveFamily(4), resolveFamily(6)]), signal)).flat();
    } else {
      addresses = await mediaAwaitSignal(dns.lookup(hostname, { all: true, verbatim: true }), signal);
    }
  } catch (error) {
    if (signal.aborted) throw mediaAbortError(signal);
    if (error instanceof MediaPolicyError) throw error;
    throw new MediaPolicyError("media.dns_failed", { retryable: true });
  }
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 64 ||
      addresses.some((entry) => !mediaPublicAddress(entry.address) || net.isIP(entry.address) !== entry.family)) {
    throw new MediaPolicyError("media.destination_denied");
  }
  return addresses[0];
}

function mediaSameAddress(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (actual === expected) return true;
  if (net.isIP(expected) === 4 && actual === `::ffff:${expected}`) return true;
  return net.isIP(actual) === 6 && net.isIP(expected) === 6 &&
    String(mediaIpv6Words(actual)) === String(mediaIpv6Words(expected));
}

function mediaRequest(destination, pinned, limits, signal) {
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let settled = false;
    let secure = false;
    let connectionTimer;
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0, proxyEnv: {} });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(result);
      response?.destroy();
      request?.destroy();
      agent.destroy();
    };
    const onAbort = () => finish(mediaAbortError(signal));
    if (signal.aborted) return finish(mediaAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      request = https.request(destination.url, {
        method: "GET", agent, rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        family: pinned.family,
        lookup: (_hostname, opts, callback) => {
          const cb = typeof opts === "function" ? opts : callback;
          if (opts?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        },
        headers: {
          Accept: [...MEDIA_REMOTE_TYPES].join(", "),
          "Accept-Encoding": "identity",
          "User-Agent": "DualLane-Media/1",
        },
      }, (incoming) => {
        response = incoming;
        incoming.on("error", () => finish(new MediaPolicyError("media.network", { retryable: true })));
        if (settled) return incoming.destroy();
        if (!secure || !mediaSameAddress(incoming.socket?.remoteAddress, pinned.address)) {
          return finish(new MediaPolicyError("media.destination_denied"));
        }
        const status = incoming.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = incoming.headers.location;
          if (typeof location !== "string" || !location) return finish(new MediaPolicyError("media.response_invalid"));
          return finish(null, { redirect: location });
        }
        if (status !== 200) return finish(new MediaPolicyError("media.http_error", { status, retryable: status >= 500 || status === 429 }));
        const encoding = incoming.headers["content-encoding"];
        if (encoding && String(encoding).toLowerCase() !== "identity") return finish(new MediaPolicyError("media.encoding_unsupported"));
        const type = incoming.headers["content-type"];
        if (typeof type !== "string" || !MEDIA_REMOTE_TYPES.has(type.split(";", 1)[0].trim().toLowerCase())) {
          return finish(new MediaPolicyError("artifact.unsupported_type"));
        }
        const lengthHeader = incoming.headers["content-length"];
        let declaredLength;
        if (lengthHeader !== undefined) {
          if (typeof lengthHeader !== "string" || !/^\d+$/u.test(lengthHeader)) return finish(new MediaPolicyError("media.response_invalid"));
          declaredLength = Number(lengthHeader);
          if (!Number.isSafeInteger(declaredLength) || declaredLength > limits.maxBytes) return finish(new MediaPolicyError("media.too_large"));
        }
        const chunks = [];
        let received = 0;
        incoming.on("data", (chunk) => {
          if (settled) return;
          if (!(chunk instanceof Uint8Array)) return finish(new MediaPolicyError("media.response_invalid"));
          received += chunk.byteLength;
          if (received > limits.maxBytes) return finish(new MediaPolicyError("media.too_large"));
          chunks.push(chunk);
        });
        incoming.on("aborted", () => finish(new MediaPolicyError("media.network", { retryable: true })));
        incoming.on("end", () => {
          if (settled) return;
          if (incoming.complete !== true || (declaredLength !== undefined && received !== declaredLength)) {
            return finish(new MediaPolicyError("media.response_invalid"));
          }
          finish(null, { bytes: Buffer.concat(chunks, received), mimeType: type });
        });
      });
      request.on("socket", (socket) => {
        socket.once("secureConnect", () => {
          if (!socket.authorized || !mediaSameAddress(socket.remoteAddress, pinned.address)) {
            return finish(new MediaPolicyError("media.destination_denied"));
          }
          secure = true;
          clearTimeout(connectionTimer);
        });
      });
      request.on("error", () => finish(new MediaPolicyError("media.network", { retryable: true })));
      connectionTimer = setTimeout(() => finish(new MediaPolicyError("media.timeout", { retryable: true })), limits.connectTimeoutMs);
      request.end();
    } catch {
      finish(new MediaPolicyError("media.network", { retryable: true }));
    }
  });
}

/** Retrieve public media with no ambient credentials, proxy, or caller-supplied headers. */
export async function fetchPublicMedia(rawUrl, options = {}) {
  if (options.enabled !== true) throw new MediaPolicyError("media.disabled");
  const limits = {
    maxBytes: mediaLimit(options.maxBytes, 10 * MEDIA_MIB, MEDIA_HARD_MAX_BYTES),
    timeoutMs: mediaLimit(options.timeoutMs, 15000, 60000),
    connectTimeoutMs: mediaLimit(options.connectTimeoutMs, 5000, 15000),
    maxRedirects: options.maxRedirects === undefined ? 3 : options.maxRedirects,
  };
  if (!Number.isInteger(limits.maxRedirects) || limits.maxRedirects < 0 || limits.maxRedirects > 3 ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new MediaPolicyError("media.invalid_options");
  }
  let resolver;
  if (options.dnsServers !== undefined) {
    if (!Array.isArray(options.dnsServers) || options.dnsServers.length < 1 || options.dnsServers.length > 3 ||
        options.dnsServers.some((server) => typeof server !== "string" || !mediaPublicAddress(server))) {
      throw new MediaPolicyError("media.invalid_options");
    }
    // This is operator configuration, not an input from a bridge result or chat.
    // A separate resolver prevents changing the process-global DNS configuration.
    try {
      resolver = new dns.Resolver({ timeout: Math.min(limits.timeoutMs, limits.connectTimeoutMs), tries: 1 });
      resolver.setServers([...options.dnsServers]);
    } catch {
      throw new MediaPolicyError("media.invalid_options");
    }
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(new MediaPolicyError("media.cancelled"));
  const onResolverAbort = () => resolver?.cancel();
  controller.signal.addEventListener("abort", onResolverAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new MediaPolicyError("media.timeout", { retryable: true })), limits.timeoutMs);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  try {
    let destination = mediaDestination(rawUrl);
    for (let redirectCount = 0; ; redirectCount += 1) {
      const pinned = await mediaResolveAddress(destination.hostname, controller.signal, resolver);
      const result = await mediaRequest(destination, pinned, limits, controller.signal);
      if (result.redirect !== undefined) {
        if (redirectCount >= limits.maxRedirects) throw new MediaPolicyError("media.redirect_limit");
        let next;
        try { next = new URL(result.redirect, destination.url).href; } catch { throw new MediaPolicyError("media.invalid_url"); }
        if (/[\u0000-\u0020\u007f\\]/u.test(result.redirect)) throw new MediaPolicyError("media.invalid_url");
        destination = mediaDestination(next);
        continue;
      }
      const verified = validateArtifactBytes(result.bytes, result.mimeType, { maxBytes: limits.maxBytes, source: "https" });
      return {
        bytes: result.bytes, mimeType: verified.mimeType,
        fileName: `media.${verified.extension}`, byteSize: verified.byteSize, sha256: verified.sha256,
        source: { kind: "https", origin: destination.url.origin, redirectCount },
      };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    controller.signal.removeEventListener("abort", onResolverAbort);
    resolver?.cancel();
  }
}
