import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AGENT_DIRECT_FILE_MAX_BYTES, normalizeFileBytes, readBoundedFile } from "../src/file-input.js";
import { DualLaneAgentClient } from "../src/index.js";
import { createDualLaneMcpServer } from "../src/mcp.js";
import { saveAgentProfile } from "../src/profile-store.js";
import { largePngFixture } from "../test-support/large-artifact-fixture.js";

const tooLarge = (error) => error.code === "artifact.too_large" && !(error instanceof RangeError);
const token = `dl_bot_${"q".repeat(32)}`;

test("direct upload budgets binary and UTF-8 bytes before networking", async () => {
  let requests = 0;
  const client = new DualLaneAgentClient({ url: "https://gateway.example", token, fetch: async () => { requests++; throw new Error("must not send"); } });
  const large = new Uint8Array(AGENT_DIRECT_FILE_MAX_BYTES + 1);
  await assert.rejects(client.sendFile({ conversationId: "c", bytes: large }), tooLarge);
  await assert.rejects(client.completeUploadContent("upload", large), tooLarge);
  const largeText = "界".repeat(Math.floor(AGENT_DIRECT_FILE_MAX_BYTES / 3) + 1);
  await assert.rejects(client.sendFile({ conversationId: "c", bytes: largeText }), tooLarge);
  assert.equal(requests, 0);
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(normalizeFileBytes(bytes), bytes, "accepted binary does not need another allocation");
  assert.equal(normalizeFileBytes("界").toString(), "界");
  assert.throws(() => normalizeFileBytes("text", { allowText: false }), { code: "artifact.invalid_data" });
});

test("file input refuses oversized files before reading and detects growth with a bounded read", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-file-bound-"));
  const file = path.join(directory, "synthetic.bin");
  const originalRead = fs.readSync;
  try {
    fs.writeFileSync(file, "abc");
    assert.equal(readBoundedFile(file).toString(), "abc");
    fs.truncateSync(file, AGENT_DIRECT_FILE_MAX_BYTES + 1);
    fs.readSync = () => assert.fail("oversized files must be rejected before any content read");
    assert.throws(() => readBoundedFile(file), tooLarge);
    fs.readSync = originalRead;
    fs.writeFileSync(file, "abc");
    let grew = false, readBytes = 0;
    fs.readSync = (fd, buffer, offset, length, position) => {
      if (!grew) { grew = true; fs.appendFileSync(file, "0123456789"); }
      const count = originalRead(fd, buffer, offset, length, position);
      readBytes += count;
      return count;
    };
    assert.throws(() => readBoundedFile(file), { code: "artifact.input_changed" });
    assert.equal(readBytes, 4, "growth reads only the declared size plus one byte");
    fs.readSync = originalRead;
    assert.throws(() => readBoundedFile(directory), (error) => error.code.startsWith("artifact.") && !error.message.includes(directory));
  } finally { fs.readSync = originalRead; fs.rmSync(directory, { recursive: true, force: true }); }
});

test("MCP rejects malformed or oversized file inputs and preserves a real large PNG byte-for-byte", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-mcp-file-bound-"));
  let requests = 0;
  const png = largePngFixture();
  saveAgentProfile("default", { url: "https://gateway.example", token, scopes: ["files:write", "messages:send"] }, { configDir: directory });
  const server = createDualLaneMcpServer({ configDir: directory, fetch: async (_url, init) => {
    requests++;
    assert.equal(Buffer.from(init.body).equals(png), true);
    return new Response(JSON.stringify({ attachment: { id: "image" }, message: { id: "reply" } }), { status: 201, headers: { "content-type": "application/json" } });
  } });
  const input = { conversationId: "c", fileName: "image.png", mimeType: "image/png" };
  try {
    for (const data of ["Zg==%%%%", "Zh==", "Zm9=", "Zg=", "Zm\n9v", "____", "Zg==="]) {
      await assert.rejects(server.callTool("duallane_send_file", { ...input, contentBase64: data }), { code: "artifact.invalid_base64" });
    }
    assert.equal(requests, 0);
    const result = await server.callTool("duallane_send_file", { ...input, contentBase64: `data:image/png;base64,${png.toString("base64")}` });
    assert.equal(result.attachment.id, "image"); assert.equal(requests, 1);
    const file = path.join(directory, "too-large.bin"); fs.writeFileSync(file, "x"); fs.truncateSync(file, AGENT_DIRECT_FILE_MAX_BYTES + 1);
    await assert.rejects(server.callTool("duallane_send_file", { ...input, filePath: file }), tooLarge);
    await assert.rejects(server.callTool("duallane_send_file", { ...input, contentText: "界".repeat(Math.floor(AGENT_DIRECT_FILE_MAX_BYTES / 3) + 1) }), tooLarge);
    await assert.rejects(server.callTool("duallane_send_file", { ...input, contentBase64: "A".repeat(Math.ceil(AGENT_DIRECT_FILE_MAX_BYTES / 3) * 4 + 4) }), tooLarge);
    assert.equal(requests, 1, "no rejected input reaches the gateway");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("CLI send-file rejects an oversized local file before loading credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dl-cli-file-bound-"));
  const file = path.join(directory, "oversized.bin");
  try {
    fs.writeFileSync(file, "x"); fs.truncateSync(file, AGENT_DIRECT_FILE_MAX_BYTES + 1);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/duallane-agent.mjs", import.meta.url)), "send-file", "c", file], {
      env: { ...process.env, DUALLANE_AGENT_CONFIG_DIR: directory }, encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /allowed byte limit/u);
    assert.doesNotMatch(result.stderr, /not configured/u);
    assert.equal(result.stderr.includes(directory), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
