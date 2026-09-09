import { networkInterfaces as defaultNetworkInterfaces } from "node:os";

export const GATEWAY_CONTAINER_PORT = "8080/tcp";

const IPV4_PATTERN = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/u;
const PORT_PATTERN = /^(?:[1-9][0-9]{0,4})$/u;

export class LocalGatewayBindingError extends Error {
  constructor(code) {
    super(code);
    this.name = "LocalGatewayBindingError";
    this.code = code;
  }
}

function invalid(code) {
  throw new LocalGatewayBindingError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCanonicalIPv4(value) {
  if (typeof value !== "string" || !IPV4_PATTERN.test(value)) return null;
  const octets = value.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets;
}

function isLoopbackIPv4(value) {
  return parseCanonicalIPv4(value)?.[0] === 127;
}

function readInterfaceIPv4Addresses(provider) {
  let interfaces;
  try {
    interfaces = typeof provider === "function" ? provider() : provider;
  } catch {
    invalid("local_interfaces_unavailable");
  }
  if (!isRecord(interfaces)) invalid("local_interfaces_invalid");

  const addresses = new Set();
  for (const entries of Object.values(interfaces)) {
    if (entries === null) continue;
    if (!Array.isArray(entries)) invalid("local_interfaces_invalid");
    for (const entry of entries) {
      if (!isRecord(entry) || !["IPv4", 4].includes(entry.family)) continue;
      if (parseCanonicalIPv4(entry.address)) addresses.add(entry.address);
    }
  }
  return addresses;
}

function localInterfaceProvider(options) {
  if (!isRecord(options)) invalid("local_options_invalid");
  const provider = options.networkInterfaces ?? defaultNetworkInterfaces;
  if (typeof provider !== "function" && !isRecord(provider)) invalid("local_interfaces_invalid");
  return provider;
}

function isIntrinsicLocalAddress(value) {
  return value === "localhost" || value === "[::1]" || value === "::1" || isLoopbackIPv4(value);
}

/**
 * Return whether a canonical literal is safe to use as this host's gateway
 * destination. Non-loopback IPv4 addresses are accepted only when the exact
 * address is present in the current OS network-interface inventory.
 */
export function isLocalGatewayAddress(value, options = {}) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (isIntrinsicLocalAddress(value)) return true;
  if (!parseCanonicalIPv4(value)) return false;
  return readInterfaceIPv4Addresses(localInterfaceProvider(options)).has(value);
}

function requirePort(value) {
  if (typeof value !== "string" || !PORT_PATTERN.test(value)) invalid("invalid_gateway_port");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid("invalid_gateway_port");
  return port;
}

function requirePublishedBinding(ports) {
  if (!isRecord(ports)) invalid("invalid_gateway_ports");
  const bindings = ports[GATEWAY_CONTAINER_PORT];
  if (!Array.isArray(bindings) || bindings.length !== 1) invalid("invalid_gateway_binding_count");
  const binding = bindings[0];
  if (!isRecord(binding)) invalid("invalid_gateway_binding");
  if (typeof binding.HostIp !== "string" || binding.HostIp.length === 0 || binding.HostIp.trim() !== binding.HostIp) {
    invalid("invalid_gateway_host");
  }
  return { host: binding.HostIp, port: requirePort(binding.HostPort) };
}

function resolvePublishedHost(host, options) {
  if (host === "localhost") invalid("invalid_gateway_host");
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  if (host === "::1") return "[::1]";
  if (!isLocalGatewayAddress(host, options)) invalid("invalid_gateway_host");
  return host;
}

function formatURLHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function rawAuthority(value) {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return null;
  const start = schemeEnd + 3;
  const suffix = value.slice(start);
  const end = suffix.search(/[\/?#]/u);
  return suffix.slice(0, end < 0 ? suffix.length : end);
}

/**
 * Normalize a gateway URL after validating its host against the same local
 * address predicate used for Docker's published binding.
 */
export function normalizeLocalGatewayURL(value, options = {}) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    invalid("invalid_gateway_url");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid("invalid_gateway_url");
  }
  if (
    parsed.protocol !== "http:" ||
    !parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    rawAuthority(value) !== parsed.host
  ) {
    invalid("invalid_gateway_url");
  }
  requirePort(parsed.port);
  if (!isLocalGatewayAddress(parsed.hostname, options)) invalid("invalid_gateway_url");
  return parsed;
}

/**
 * Resolve one exact Docker port binding to a host-only HTTP origin. The
 * binding is never accepted as an arbitrary URL and wildcard binds remain
 * mapped to loopback for the read-only probe.
 */
export function resolveLocalGatewayURL(ports, options = {}) {
  const binding = requirePublishedBinding(ports);
  const host = resolvePublishedHost(binding.host, options);
  const parsed = normalizeLocalGatewayURL(`http://${formatURLHost(host)}:${binding.port}/`, options);
  return parsed.origin;
}
