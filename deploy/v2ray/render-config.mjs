import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUTPUT_PATH = "/config/config.json";
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_SUBSCRIPTION_BYTES = 4 * 1024 * 1024;
const MAX_OUTBOUNDS = 64;
const SUPPORTED_METHODS = new Set([
  "aes-128-gcm",
  "aes-256-gcm",
  "chacha20-poly1305"
]);

export function parseShadowsocksUri(value) {
  if (typeof value !== "string" || !value.startsWith("ss://")) {
    throw new Error("invalid Shadowsocks URI");
  }

  const withoutFragment = value.slice(5).split("#", 1)[0];
  const [payload, query = ""] = withoutFragment.split("?", 2);
  if (new URLSearchParams(query).has("plugin")) {
    throw new Error("Shadowsocks plugins are not supported");
  }

  const separator = payload.lastIndexOf("@");
  let credentials;
  let authority;
  if (separator >= 0) {
    credentials = decodeBase64(decodeURIComponent(payload.slice(0, separator)));
    authority = payload.slice(separator + 1).replace(/\/$/, "");
  } else {
    const decoded = decodeBase64(payload);
    const legacySeparator = decoded.lastIndexOf("@");
    if (legacySeparator < 0) {
      throw new Error("invalid Shadowsocks URI");
    }
    credentials = decoded.slice(0, legacySeparator);
    authority = decoded.slice(legacySeparator + 1);
  }

  const credentialSeparator = credentials.indexOf(":");
  if (credentialSeparator <= 0 || credentialSeparator === credentials.length - 1) {
    throw new Error("invalid Shadowsocks credentials");
  }
  const method = credentials.slice(0, credentialSeparator).toLowerCase();
  const password = credentials.slice(credentialSeparator + 1);
  if (!SUPPORTED_METHODS.has(method)) {
    throw new Error("unsupported Shadowsocks method");
  }

  let endpoint;
  try {
    endpoint = new URL(`tcp://${authority}`);
  } catch {
    throw new Error("invalid Shadowsocks endpoint");
  }
  const port = Number(endpoint.port);
  if (!endpoint.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid Shadowsocks endpoint");
  }

  return {
    address: endpoint.hostname,
    port,
    method,
    password
  };
}

export function parseSubscription(body) {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_SUBSCRIPTION_BYTES) {
    throw new Error("invalid subscription response");
  }

  const trimmed = body.trim();
  const decoded = trimmed.includes("://") ? trimmed : decodeBase64(trimmed);
  const nodes = [];
  const seen = new Set();
  for (const line of decoded.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (!candidate.startsWith("ss://")) {
      continue;
    }
    try {
      const node = parseShadowsocksUri(candidate);
      const key = JSON.stringify([node.address, node.port, node.method, node.password]);
      if (!seen.has(key)) {
        seen.add(key);
        nodes.push(node);
      }
    } catch {
      // A subscription may mix protocols or plugin-based nodes that V2Ray cannot use.
    }
    if (nodes.length >= MAX_OUTBOUNDS) {
      break;
    }
  }

  if (nodes.length === 0) {
    throw new Error("subscription has no compatible Shadowsocks nodes");
  }
  return nodes;
}

export function buildV2RayConfig(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("at least one proxy node is required");
  }
  const proxyOutbounds = nodes.map((node, index) => ({
    tag: `github-proxy-${String(index + 1).padStart(2, "0")}`,
    protocol: "shadowsocks",
    settings: {
      servers: [{
        address: node.address,
        port: node.port,
        method: node.method,
        password: node.password
      }]
    }
  }));

  return {
    log: { loglevel: "warning" },
    inbounds: [{
      tag: "github-http",
      listen: "0.0.0.0",
      port: 10809,
      protocol: "http",
      settings: {}
    }],
    outbounds: [
      ...proxyOutbounds,
      { tag: "direct", protocol: "freedom", settings: {} },
      { tag: "block", protocol: "blackhole", settings: {} }
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [
        {
          type: "field",
          inboundTag: ["github-http"],
          domain: ["full:github.com", "full:api.github.com"],
          balancerTag: "github-balancer"
        },
        {
          type: "field",
          inboundTag: ["github-http"],
          outboundTag: "block"
        }
      ],
      balancers: [{
        tag: "github-balancer",
        selector: ["github-proxy-"],
        strategy: { type: "leastPing" },
        fallbackTag: proxyOutbounds[0].tag
      }]
    },
    observatory: {
      subjectSelector: ["github-proxy-"],
      probeURL: "https://api.github.com/",
      probeInterval: "30s",
      enableConcurrency: true
    }
  };
}

export async function renderConfig(options = {}) {
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const subscriptionUrl = await resolveSubscriptionUrl(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeout.unref?.();

  let response;
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)(subscriptionUrl, {
      headers: { "user-agent": "DualLane-V2Ray-Config/1.0" },
      signal: controller.signal
    });
  } catch {
    throw new Error("subscription request failed");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`subscription request returned HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SUBSCRIPTION_BYTES) {
    throw new Error("subscription response is too large");
  }
  const body = await response.text();
  const nodes = parseSubscription(body);
  const config = buildV2RayConfig(nodes);

  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return { nodeCount: nodes.length, outputPath };
}

async function resolveSubscriptionUrl(options) {
  let value = options.subscriptionUrl ?? process.env.V2RAY_SUBSCRIPTION_URL;
  const subscriptionFile = options.subscriptionFile ?? process.env.V2RAY_SUBSCRIPTION_FILE;
  if (!value && subscriptionFile) {
    try {
      value = (await readFile(subscriptionFile, "utf8")).trim();
    } catch {
      throw new Error("subscription secret file cannot be read");
    }
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("subscription URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("subscription URL must be an HTTPS URL without credentials or fragments");
  }
  return parsed.toString();
}

function decodeBase64(value) {
  const normalized = value.replace(/\s/gu, "").replace(/-/gu, "+").replace(/_/gu, "/");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    throw new Error("invalid base64 data");
  }
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${"=".repeat(padding)}`, "base64").toString("utf8");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  renderConfig()
    .then(({ nodeCount }) => {
      console.log(JSON.stringify({ event: "v2ray_config_rendered", nodeCount }));
    })
    .catch((error) => {
      console.error(`V2Ray config rendering failed: ${error.message}`);
      process.exitCode = 1;
    });
}
