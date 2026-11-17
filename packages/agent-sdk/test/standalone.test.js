import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { largePngFixture } from "../test-support/large-artifact-fixture.js";
import test from "node:test";

const sdkRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(sdkRoot, "../..");
const publicPath = "apps/web/public/integrations";

function withBundleFixture(run) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duallane-bundle-test-"));
  const sdk = path.join(fixture, "packages/agent-sdk");
  fs.mkdirSync(sdk, { recursive: true });
  try {
    for (const name of ["package.json", "src", "bin", "scripts"]) {
      fs.cpSync(path.join(sdkRoot, name), path.join(sdk, name), { recursive: true });
    }
    run(fixture, sdk);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

test("published standalone runtimes are fresh, executable, and match their integrity manifests", () => {
  withBundleFixture((fixture, sdk) => {
    const built = spawnSync(process.execPath, [path.join(sdk, "scripts/bundle-standalone.mjs")], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdk, "package.json"), "utf8")).version;
    let stableBytes;
    for (const prefix of ["", "v2/"]) {
      const relative = `${publicPath}/${prefix}duallane-agent.mjs`;
      const runtime = path.join(repoRoot, relative);
      const bytes = fs.readFileSync(runtime);
      assert.deepEqual(bytes, fs.readFileSync(path.join(fixture, relative)), "publish the bundle regenerated from SDK sources");
      if (stableBytes) assert.deepEqual(bytes, stableBytes);
      stableBytes = bytes;
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, publicPath, prefix, "duallane-agent.manifest.json"), "utf8"));
      assert.equal(manifest.version, sdkVersion);
      assert.equal(manifest.byteSize, bytes.byteLength);
      assert.equal(manifest.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
      for (const flag of ["--version", "--help"]) {
        const result = spawnSync(process.execPath, [runtime, flag], { encoding: "utf8", timeout: 5_000 });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(sdkVersion));
      }
    }
  });
});

test("the bundler rejects invalid JavaScript before replacing a published runtime", () => {
  withBundleFixture((fixture, sdk) => {
    const published = path.join(fixture, publicPath, "duallane-agent.mjs");
    fs.mkdirSync(path.dirname(published), { recursive: true });
    fs.writeFileSync(published, "previous verified runtime");
    fs.appendFileSync(path.join(sdk, "src/daemon.js"), "\nconst invalid = ;\n");
    const built = spawnSync(process.execPath, [path.join(sdk, "scripts/bundle-standalone.mjs")], { encoding: "utf8" });
    assert.equal(built.status, 1);
    assert.match(built.stderr, /Bundled runtime syntax check failed/u);
    assert.equal(fs.readFileSync(published, "utf8"), "previous verified runtime");
    assert.equal(fs.existsSync(path.join(fixture, publicPath, "duallane-agent.manifest.json")), false);
    assert.equal(fs.existsSync(path.join(fixture, publicPath, "v2/duallane-agent.mjs")), false);
  });
});

test("published standalone parser preserves a multi-megabyte inline PNG", async () => {
  const runtime = await import(pathToFileURL(path.join(repoRoot, publicPath, "duallane-agent.mjs")));
  const png = largePngFixture();
  const result = runtime.parseAgentBridgeResult(JSON.stringify({ protocol: "duallane.agent.result", version: 1,
    status: "completed", text: "Fixture", artifacts: [{ id: "large", source: "inline", fileName: "large.png",
      mimeType: "image/png", encoding: "base64", data: png.toString("base64") }] }), { validateBytes: runtime.validateArtifactBytes });
  assert.deepEqual(result.artifacts[0].bytes, png);
});
