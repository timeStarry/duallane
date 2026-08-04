import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildV2RayConfig,
  parseShadowsocksUri,
  parseSubscription,
  renderConfig
} from "../../../deploy/v2ray/render-config.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("V2Ray subscription renderer", () => {
  it("parses SIP002 and legacy Shadowsocks URIs", () => {
    expect(parseShadowsocksUri(makeShadowsocksUri("edge.example", 8388, "secret:with-colon"))).toEqual({
      address: "edge.example",
      port: 8388,
      method: "aes-256-gcm",
      password: "secret:with-colon"
    });

    const legacy = Buffer.from("aes-256-gcm:legacy-secret@legacy.example:443").toString("base64url");
    expect(parseShadowsocksUri(`ss://${legacy}#legacy`)).toEqual({
      address: "legacy.example",
      port: 443,
      method: "aes-256-gcm",
      password: "legacy-secret"
    });
  });

  it("keeps only unique compatible Shadowsocks nodes", () => {
    const supported = makeShadowsocksUri("one.example", 8388, "one");
    const unsupportedCredentials = Buffer.from("rc4-md5:two").toString("base64url");
    const subscription = [
      supported,
      supported,
      `ss://${unsupportedCredentials}@two.example:8388`,
      `${makeShadowsocksUri("plugin.example", 8388, "three").split("#", 1)[0]}?plugin=obfs-local#node`,
      "vmess://ignored"
    ].join("\n");

    expect(parseSubscription(Buffer.from(subscription).toString("base64"))).toHaveLength(1);
  });

  it("routes only GitHub OAuth hosts through a least-ping balancer", () => {
    const config = buildV2RayConfig([
      { address: "one.example", port: 8388, method: "aes-256-gcm", password: "one" },
      { address: "two.example", port: 443, method: "aes-256-gcm", password: "two" }
    ]);

    expect(config.inbounds[0]).toMatchObject({ listen: "0.0.0.0", port: 10809, protocol: "http" });
    expect(config.routing.rules[0]).toMatchObject({
      domain: ["full:github.com", "full:api.github.com"],
      balancerTag: "github-balancer"
    });
    expect(config.routing.rules[1].outboundTag).toBe("block");
    expect(config.routing.balancers[0]).toMatchObject({
      selector: ["github-proxy-"],
      strategy: { type: "leastPing" },
      fallbackTag: "github-proxy-01"
    });
  });

  it("fetches from a secret file and writes an atomic private config", async () => {
    const directory = await makeTemporaryDirectory();
    const secretPath = path.join(directory, "subscription-url");
    const outputPath = path.join(directory, "config", "config.json");
    await writeFile(secretPath, "https://subscription.example/private-token\n", { mode: 0o600 });
    const subscription = Buffer.from(makeShadowsocksUri("edge.example", 8388, "node-secret")).toString("base64");
    const observedUrls = [];

    const result = await renderConfig({
      subscriptionFile: secretPath,
      outputPath,
      fetchImpl: async (url) => {
        observedUrls.push(url);
        return new Response(subscription);
      }
    });

    expect(result.nodeCount).toBe(1);
    expect(observedUrls).toEqual(["https://subscription.example/private-token"]);
    const saved = JSON.parse(await readFile(outputPath, "utf8"));
    expect(saved.outbounds[0].settings.servers[0]).toMatchObject({
      address: "edge.example",
      password: "node-secret"
    });
    if (process.platform !== "win32") {
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects insecure subscription URLs before fetching", async () => {
    const fetchImpl = () => {
      throw new Error("must not fetch");
    };
    await expect(renderConfig({
      subscriptionUrl: "http://subscription.example/token",
      outputPath: "unused.json",
      fetchImpl
    })).rejects.toThrow("must be an HTTPS URL");
  });
});

function makeShadowsocksUri(host, port, password) {
  const credentials = Buffer.from(`aes-256-gcm:${password}`).toString("base64url");
  return `ss://${credentials}@${host}:${port}#node`;
}

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-v2ray-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
