import { describe, expect, it, vi } from "vitest";
import { createGitHubFetch, normalizeGitHubProxyUrl } from "./github-fetch.mjs";

describe("GitHub fetch", () => {
  it("keeps an injected fetch implementation ahead of proxy configuration", async () => {
    const response = new Response("injected");
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const dispatcherFactory = vi.fn();
    const client = createGitHubFetch({
      fetchImpl,
      proxyUrl: "not-a-valid-proxy",
      dispatcherFactory
    });

    await expect(client.fetch("https://github.com/login/oauth/access_token")).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(dispatcherFactory).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-url",
    "https://v2ray:10809",
    "http://user:password@v2ray:10809",
    "http://v2ray:10809/path",
    "http://v2ray"
  ])("rejects unsafe proxy configuration: %s", (proxyUrl) => {
    expect(() => normalizeGitHubProxyUrl(proxyUrl)).toThrow("GITHUB_PROXY_URL");
  });

  it("passes approved GitHub requests through one shared dispatcher", async () => {
    const dispatcher = { close: vi.fn().mockResolvedValue(undefined) };
    const dispatcherFactory = vi.fn().mockReturnValue(dispatcher);
    const fetchWithDispatcher = vi.fn().mockResolvedValue(new Response("ok"));
    const client = createGitHubFetch({
      proxyUrl: "http://v2ray:10809",
      dispatcherFactory,
      fetchWithDispatcher
    });

    await client.fetch("https://github.com/login/oauth/access_token", { method: "POST" });
    await client.fetch(new URL("https://api.github.com/user"));

    expect(dispatcherFactory).toHaveBeenCalledWith("http://v2ray:10809/");
    expect(fetchWithDispatcher).toHaveBeenNthCalledWith(
      1,
      new URL("https://github.com/login/oauth/access_token"),
      expect.objectContaining({ method: "POST", dispatcher })
    );
    expect(fetchWithDispatcher).toHaveBeenNthCalledWith(
      2,
      new URL("https://api.github.com/user"),
      expect.objectContaining({ dispatcher })
    );
    await client.close();
    expect(dispatcher.close).toHaveBeenCalledOnce();
  });

  it.each([
    "http://github.com/login/oauth/access_token",
    "https://github.example/login/oauth/access_token",
    "https://user:secret@api.github.com/user"
  ])("rejects requests outside the GitHub HTTPS boundary: %s", async (target) => {
    const client = createGitHubFetch({
      proxyUrl: "http://v2ray:10809",
      dispatcherFactory: () => ({ close: async () => {} }),
      fetchWithDispatcher: vi.fn()
    });
    expect(() => client.fetch(target)).toThrow("restricted to approved HTTPS hosts");
  });
});
