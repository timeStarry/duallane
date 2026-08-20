import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const publicRoot = path.join(repoRoot, "apps", "web", "public", "integrations");

describe("versioned Agent integration assets", () => {
  it("publishes every stable and v1 Prompt without embedded credentials", async () => {
    const paths = [
      "duallane-channel.md",
      "openclaw/duallane-channel.md",
      "hermes/duallane-channel.md",
      "v1/duallane-channel.md",
      "v1/openclaw/duallane-channel.md",
      "v1/hermes/duallane-channel.md"
    ];
    for (const relativePath of paths) {
      const content = await readFile(path.join(publicRoot, relativePath), "utf8");
      expect(content.length).toBeGreaterThan(100);
      expect(content).not.toMatch(/dl_bot_[A-Za-z0-9_-]{16,}/u);
      expect(content).not.toMatch(/[?&#](?:token|bot_token)=/iu);
    }
  });

  it("keeps the v1 SHA-256 manifest synchronized with immutable Prompt bytes", async () => {
    const manifest = JSON.parse(await readFile(path.join(publicRoot, "v1", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 1, sdkVersion: "0.15.0", algorithm: "sha256" });
    for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
      const content = await readFile(path.join(publicRoot, "v1", relativePath));
      expect(createHash("sha256").update(content).digest("hex")).toBe(expectedHash);
    }
  });

  it("configures ETag, Last-Modified validation, and distinct stable/versioned cache lifetimes", async () => {
    const nginx = await readFile(path.join(repoRoot, "deploy", "nginx", "default.conf"), "utf8");
    const versioned = nginx.match(/location ~ \^\/integrations\/v\[0-9\]\+\/ \{([\s\S]*?)\n  \}/u)?.[1] ?? "";
    const stable = nginx.match(/location \/integrations\/ \{([\s\S]*?)\n  \}/u)?.[1] ?? "";
    expect(nginx).not.toMatch(/^\s*last_modified\s+/mu);
    expect(versioned).toContain("etag on;");
    expect(versioned).toContain("if_modified_since exact;");
    expect(versioned).toContain("expires 1y;");
    expect(stable).toContain("etag on;");
    expect(stable).toContain("if_modified_since exact;");
    expect(stable).toContain("expires 5m;");
  });
});
