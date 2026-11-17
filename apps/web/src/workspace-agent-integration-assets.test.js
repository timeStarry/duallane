import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const publicRoot = path.join(repoRoot, "apps", "web", "public", "integrations");

describe("versioned Agent integration assets", () => {
  it("publishes stable and v2 universal runtimes and manifests without embedded credentials", async () => {
    const paths = [
      "duallane-agent.mjs",
      "duallane-agent.manifest.json",
      "v2/duallane-agent.mjs",
      "v2/duallane-agent.manifest.json"
    ];
    for (const relativePath of paths) {
      const content = await readFile(path.join(publicRoot, relativePath), "utf8");
      expect(content.length).toBeGreaterThan(100);
      expect(content).not.toMatch(/dl_bot_[A-Za-z0-9_-]{16,}/u);
      expect(content).not.toMatch(/[?&#](?:token|bot_token)=/iu);
    }
  });

  it("binds both runtime manifests to the independently versioned SDK and exact public bytes", async () => {
    const sdkPackage = JSON.parse(await readFile(path.join(repoRoot, "packages", "agent-sdk", "package.json"), "utf8"));
    const backendModel = await readFile(path.join(repoRoot, "apps", "backend", "internal", "v1", "model.go"), "utf8");
    const advertisedSDKVersion = backendModel.match(/const LatestAgentSDKVersion = "([^"]+)"/u)?.[1];
    expect(advertisedSDKVersion).toBe(sdkPackage.version);
    const publications = [];
    for (const prefix of ["", "v2"]) {
      const directory = path.join(publicRoot, prefix);
      const manifest = JSON.parse(await readFile(path.join(directory, "duallane-agent.manifest.json"), "utf8"));
      const content = await readFile(path.join(directory, "duallane-agent.mjs"));
      expect(manifest).toMatchObject({
        name: sdkPackage.name,
        version: sdkPackage.version,
        downloadPath: "/integrations/duallane-agent.mjs"
      });
      expect(manifest.minNodeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.sha256).toBe(createHash("sha256").update(content).digest("hex"));
      expect(manifest.byteSize).toBe(content.byteLength);
      publications.push({ manifest, content });
    }
    expect(publications[1].manifest).toEqual(publications[0].manifest);
    expect(publications[1].content).toEqual(publications[0].content);
  });

  it("revalidates mutable runtimes and manifests before the immutable historical documentation route", async () => {
    const nginx = (await readFile(path.join(repoRoot, "deploy", "candidate", "nginx.conf"), "utf8")).replace(/\r\n/g, "\n");
    const regexLocations = [...nginx.matchAll(/^([ \t]+)location ~ (\S+) \{([\s\S]*?)^\1\}/gmu)];
    const versioned = regexLocations.find(([, , expression]) => expression === "^/integrations/v[0-9]+/")?.[3] ?? "";
    const stable = nginx.match(/^([ \t]+)location \/integrations\/ \{([\s\S]*?)^\1\}/mu)?.[2] ?? "";
    expect(nginx).not.toMatch(/^\s*last_modified\s+/mu);
    expect(versioned).toContain("etag on;");
    expect(versioned).toContain("if_modified_since exact;");
    expect(versioned).toContain("expires 1y;");
    expect(stable).toContain("etag on;");
    expect(stable).toContain("if_modified_since exact;");
    expect(stable).toContain("expires 5m;");

    // Nginx uses the first matching regex location after its prefix lookup.
    expect(nginx).not.toMatch(/location \^~ \/integrations\//u);
    const route = (requestPath) => regexLocations.find(([, , expression]) => new RegExp(expression, "u").test(requestPath))?.[3];
    for (const prefix of ["", "v2/", "v3/"]) {
      for (const file of ["duallane-agent.mjs", "duallane-agent.manifest.json"]) {
        const runtime = route(`/integrations/${prefix}${file}`);
        expect(runtime).toBeDefined();
        expect(runtime).toContain("etag on;");
        expect(runtime).toContain("if_modified_since exact;");
        expect(runtime).toContain("expires -1;");
        expect(runtime).not.toContain("expires 1y;");
        // A location-level add_header would replace the server security set.
        expect(runtime).not.toMatch(/\badd_header\b/u);
      }
    }
    expect(route("/integrations/v1/duallane-channel.md")).toContain("expires 1y;");
    for (const current of ["/integrations/v2/duallane-channel.md", "/integrations/duallane-agent/SKILL.md"]) {
      expect(route(current)).toContain("expires -1;");
      expect(route(current)).not.toMatch(/\badd_header\b/u);
    }
  });
});
