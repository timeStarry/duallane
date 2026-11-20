import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadAgentProfile, saveAgentProfile } from "../src/profile-store.js";

test("CLI filtered waits do not ACK, and rejected explicit ACK cannot checkpoint", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-cli-ack-"));
  const calls = [];
  let syncRequired = false;
  const gateway = http.createServer((request, response) => {
    calls.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url.includes("/updates")) {
      if (syncRequired) {
        response.end(JSON.stringify({ events: [], syncRequired: true, currentSequence: 1000, reason: "replay_window_exceeded" }));
        return;
      }
      response.end(JSON.stringify({ events: [
        { eventId: "e1", sequence: 1, conversationId: "other", type: "message.created", payload: {} },
        { eventId: "e2", sequence: 2, conversationId: "selected", type: "message.created", payload: {} },
      ] }));
    } else if (request.url.includes("/events/ack")) {
      response.writeHead(503); response.end(JSON.stringify({ error: { code: "test.unavailable" } }));
    } else response.end("{}");
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/duallane-agent.mjs", import.meta.url)), ...args], {
      env: { ...process.env, DUALLANE_AGENT_CONFIG_DIR: directory }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI fixture timed out")); }, 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  try {
    saveAgentProfile("default", { url: `http://127.0.0.1:${gateway.address().port}`, token: `dl_bot_${"q".repeat(32)}`, scopes: ["messages:read_trigger"], lastSequence: 0 }, { configDir: directory });
    const waited = await run(["wait", "--transport", "poll", "--conversation", "selected", "--timeout", "5"]);
    assert.equal(waited.code, 0, waited.stderr);
    const result = JSON.parse(waited.stdout);
    assert.equal(result.event.eventId, "e2");
    assert.equal(result.requiresAck, true);
    assert.equal(calls.some((route) => route.includes("/events/ack")), false);
    assert.equal(loadAgentProfile("default", { configDir: directory }).lastSequence, 0);
    const rejected = await run(["updates", "--ack"]);
    assert.equal(rejected.code, 1);
    assert.equal(loadAgentProfile("default", { configDir: directory }).lastSequence, 0);
    syncRequired = true;
    calls.length = 0;
    const unsafe = await run(["updates"]);
    assert.equal(unsafe.code, 0, unsafe.stderr);
    assert.equal(JSON.parse(unsafe.stdout).syncRequired, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /afterSequence=0&/u);
    assert.equal(loadAgentProfile("default", { configDir: directory }).lastSequence, 0);
  } finally {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
