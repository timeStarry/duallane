import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DUALLANE_AGENT_SDK_VERSION } from "../src/index.js";

test("CLI version and update checks inspect content drift in the selected runtime", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-cli-update-"));
  const target = path.join(directory, "duallane-agent.mjs");
  const oldBytes = `//${"old".repeat(400)}\n`;
  const published = Buffer.from(`//${"new".repeat(400)}\n`);
  fs.writeFileSync(target, oldBytes);
  const gateway = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ version: DUALLANE_AGENT_SDK_VERSION,
      sha256: crypto.createHash("sha256").update(published).digest("hex"), byteSize: published.length,
      compatibility: { gatewayVersion: 1, bridgeProtocolVersion: 1 } }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  try {
    for (const [command, targetFlag] of [["version", "--script"], ["update", "--target"]]) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/duallane-agent.mjs", import.meta.url)), command,
          "--check", "--url", `http://127.0.0.1:${gateway.address().port}`, targetFlag, target], {
          env: { ...process.env, DUALLANE_AGENT_CONFIG_DIR: directory }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("CLI fixture timed out")); }, 10_000);
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).sameVersionDrift, true);
      assert.equal(JSON.parse(result.stdout).updateAvailable, true);
      assert.equal(fs.readFileSync(target, "utf8"), oldBytes);
    }
  } finally {
    gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
