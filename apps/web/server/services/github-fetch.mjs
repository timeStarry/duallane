import { fetch as undiciFetch, ProxyAgent } from "undici";

const GITHUB_HOSTS = new Set(["github.com", "api.github.com"]);

export function createGitHubFetch(options = {}) {
  if (options.fetchImpl) {
    return {
      fetch: options.fetchImpl,
      close: async () => {}
    };
  }

  const proxyUrl = normalizeGitHubProxyUrl(options.proxyUrl);
  if (!proxyUrl) {
    return {
      fetch: globalThis.fetch.bind(globalThis),
      close: async () => {}
    };
  }

  const dispatcher = (options.dispatcherFactory ?? ((url) => new ProxyAgent(url)))(proxyUrl);
  const fetchWithDispatcher = options.fetchWithDispatcher ?? undiciFetch;
  return {
    fetch(input, init = {}) {
      const target = normalizeGitHubTarget(input);
      return fetchWithDispatcher(target, { ...init, dispatcher });
    },
    async close() {
      await dispatcher.close();
    }
  };
}

export function normalizeGitHubProxyUrl(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error("GITHUB_PROXY_URL must be a valid HTTP proxy URL");
  }
  if (
    parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || !parsed.hostname
    || !parsed.port
  ) {
    throw new Error("GITHUB_PROXY_URL must be an unauthenticated HTTP proxy URL with an explicit port");
  }
  return parsed.toString();
}

function normalizeGitHubTarget(input) {
  let target;
  try {
    target = new URL(input instanceof URL || typeof input === "string" ? input : input.url);
  } catch {
    throw new Error("GitHub request URL is invalid");
  }
  if (target.protocol !== "https:" || !GITHUB_HOSTS.has(target.hostname) || target.username || target.password) {
    throw new Error("GitHub proxy requests are restricted to approved HTTPS hosts");
  }
  return target;
}
