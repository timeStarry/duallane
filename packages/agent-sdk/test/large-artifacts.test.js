import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseAgentBridgeResult } from "../src/bridge-protocol.js";
import { invokeDaemonAgentTurn } from "../src/daemon.js";
import { validateArtifactBytes } from "../src/media.js";
import { createAgentTaskRuntime } from "../src/task-runtime.js";
import { largePngFixture, verifyLargePngFixture } from "../test-support/large-artifact-fixture.js";

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const descriptor = (bytes, patch = {}) => ({ id: "binary", source: "inline", fileName: "binary.bin", mimeType: "application/octet-stream", encoding: "base64", data: bytes.toString("base64"), ...patch });
const result = (artifacts) => JSON.stringify({ protocol: "duallane.agent.result", version: 1, status: "completed", text: "Deterministic regression output", artifacts });

test("a complete 3.58 MB PNG decodes and validates without a regex stack overflow", () => {
  const png = largePngFixture();
  assert.deepEqual(verifyLargePngFixture(png), { width: 1024, height: 1165, byteSize: png.length });
  assert.ok(png.length > 3_500_000 && png.length < 3_700_000);
  const encoded = result([descriptor(png, { fileName: "large.png", mimeType: "image/png", byteSize: png.length, sha256: digest(png) })]);
  assert.ok(Buffer.byteLength(encoded) > 4_700_000);
  const parsed = parseAgentBridgeResult(encoded, { validateBytes: validateArtifactBytes });
  assert.deepEqual(parsed.artifacts[0].bytes, png);
  assert.equal(parsed.artifacts[0].sha256, digest(png));
});

test("legacy inline base64 accepts a complete large PNG with byte-for-byte identity", () => {
  const png = largePngFixture();
  const raw = `A legacy image\n<duallane-file name="large.png" mime="image/png" encoding="base64">\n${png.toString("base64")}\n</duallane-file>`;
  const parsed = parseAgentBridgeResult(raw, { validateBytes: validateArtifactBytes });
  assert.equal(parsed.text, "A legacy image");
  assert.equal(parsed.artifacts.length, 1);
  assert.deepEqual(parsed.artifacts[0].bytes, png);
  assert.equal(parsed.artifacts[0].sha256, digest(png));
});

test("SVG envelope validation handles 25 MiB whitespace and repeated XML declarations without recursion", () => {
  const svg = Buffer.from(" ".repeat(MAX_ARTIFACT_BYTES - 7) + "<svg />");
  assert.equal(svg.length, MAX_ARTIFACT_BYTES);
  assert.equal(validateArtifactBytes(svg, "image/svg+xml").sha256, digest(svg));
  const declarations = Buffer.from('<?xml version="1.0"?>\n'.repeat(150_000) + '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(validateArtifactBytes(declarations, "image/svg+xml").sha256, digest(declarations));
  for (const invalid of ['<?xml version="1?0"?><svg/>', '<?xml version="1.0"?<svg/>', '<?xml?><svgg/>', ' '.repeat(3_600_000) + '<html/>']) {
    assert.throws(() => validateArtifactBytes(Buffer.from(invalid), "image/svg+xml"), { code: "artifact.type_mismatch" });
  }
});

test("canonical binary near 25 MiB and at the exact limit preserves every byte for each padding form", () => {
  const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  for (const length of [MAX_ARTIFACT_BYTES - 2, MAX_ARTIFACT_BYTES - 1, MAX_ARTIFACT_BYTES]) {
    const input = bytes.subarray(0, length);
    const parsed = parseAgentBridgeResult(result([descriptor(input)]));
    assert.equal(parsed.artifacts[0].bytes.length, length);
    assert.deepEqual(parsed.artifacts[0].bytes, input);
    assert.equal(parsed.artifacts[0].sha256, digest(input));
  }
});

test("over-limit base64 bytes fail with the bounded artifact error", () => {
  // MAX+1 shares an encoded length with MAX; checking only string length is insufficient.
  for (const length of [MAX_ARTIFACT_BYTES + 1, MAX_ARTIFACT_BYTES + 3]) {
    assert.throws(() => parseAgentBridgeResult(result([descriptor(Buffer.alloc(length, 0x61))])), { code: "artifact.too_large" });
  }
});

test("strict base64 rejects illegal alphabets, malformed padding and noncanonical tail bits", () => {
  const base = descriptor(Buffer.from([0]));
  for (const data of ["%AAA", "AA A", "AA\nA", "AA\tA", "AA_A", "AA-A", "ＡAAA", "AA", "AAA", "A===", "AA=A", "=AAA", "AAAA=", "AA===", "AB==", "/x==", "AAF="]) {
    assert.throws(() => parseAgentBridgeResult(result([{ ...base, data }])), { code: "artifact.invalid_base64" }, data);
  }
  // Invalid bytes near the end must not be hidden behind a huge valid prefix.
  const valid = Buffer.alloc(3_600_000, 0x61).toString("base64");
  for (const index of [0, Math.floor(valid.length / 2), valid.length - 1]) {
    const data = valid.slice(0, index) + "!" + valid.slice(index + 1);
    assert.throws(() => parseAgentBridgeResult(result([{ ...base, data }])), { code: "artifact.invalid_base64" });
  }
  for (const [data, bytes] of [["AA==", [0]], ["/w==", [255]], ["AAE=", [0, 1]], ["AAAA", [0, 0, 0]]]) {
    assert.deepEqual(parseAgentBridgeResult(result([{ ...base, data }])).artifacts[0].bytes, Buffer.from(bytes));
  }
});

test("multiple large artifacts respect the exact 50 MiB cumulative limit and six-item cap", () => {
  const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES, 0x5a);
  const artifact = descriptor(bytes);
  {
    const parsed = parseAgentBridgeResult(result([{ ...artifact, id: "first" }, { ...artifact, id: "second" }]));
    assert.equal(parsed.artifacts.reduce((total, item) => total + item.bytes.length, 0), 50 * 1024 * 1024);
    for (const item of parsed.artifacts) assert.deepEqual(item.bytes, bytes);
  }
  assert.throws(() => parseAgentBridgeResult(result([
    { ...artifact, id: "first" }, { ...artifact, id: "second" }, descriptor(Buffer.from([1]), { id: "overage" }),
  ])), { code: "artifact.too_large" });
  const small = descriptor(Buffer.from([1]));
  assert.equal(parseAgentBridgeResult(result(Array.from({ length: 6 }, (_, index) => ({ ...small, id: `item-${index}` })))).artifacts.length, 6);
  assert.throws(() => parseAgentBridgeResult(result(Array.from({ length: 7 }, (_, index) => ({ ...small, id: `item-${index}` })))), { code: "artifact.count_limit" });
});

test("actual command bridge carries a 3.58 MB PNG through parser, durable task, upload and send once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "duallane-large-artifact-"));
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const png = largePngFixture(), expectedDigest = digest(png);
  const exported = path.join(directory, "result.json");
  const command = path.join(directory, "bridge.mjs");
  fs.writeFileSync(exported, result([descriptor(png, { fileName: "large.png", mimeType: "image/png" })]));
  fs.writeFileSync(command, `import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";
let input="";for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input);if(request.triggerMessage.id!=="trigger")process.exit(2);
await new Promise((resolve,reject)=>{const source=fs.createReadStream(path.join(path.dirname(fileURLToPath(import.meta.url)),"result.json"));source.on("error",reject);process.stdout.on("error",reject);source.pipe(process.stdout);source.on("end",resolve);});
`);
  const calls = { invoke: 0, upload: 0, send: 0 };
  let runtime;
  try {
    runtime = createAgentTaskRuntime({ stateDir: directory, origin: "https://fixture.example", botId: "fixture-bot",
      scopes: ["messages:read_context", "files:write", "messages:send"], validateBytes: validateArtifactBytes, maxAttempts: 1,
      client: {
        async listConversations() { return { conversations: [{ id: "conversation", allowContext: true, allowSend: true, allowTrigger: true }] }; },
        async getContext() { return { messages: [{ id: "trigger", authorKind: "human", plainText: "Return the fixture PNG" }] }; },
        async uploadFile(input) {
          calls.upload++;
          assert.equal(input.mimeType, "image/png"); assert.deepEqual(input.bytes, png); assert.equal(digest(input.bytes), expectedDigest);
          return { attachment: { id: "fixture-attachment" } };
        },
        async sendMessage(input) {
          calls.send++;
          assert.equal(input.content.blocks.at(-1).attachmentId, "fixture-attachment");
          return { message: { id: "fixture-message" } };
        },
      },
      invoke: (request, { signal }) => {
        calls.invoke++;
        return invokeDaemonAgentTurn({ customCmd: `"${process.execPath}" "${command}"`, workdir: directory, request, signal, timeoutMs: 10_000 });
      },
    });
    const event = { eventId: "large-event", sequence: 1, type: "message.created", conversationId: "conversation", payload: { messageId: "trigger" } };
    const { taskId } = runtime.accept(event);
    runtime.start(); await runtime.idle();
    const task = runtime.getTask(taskId);
    assert.equal(task.state, "completed", JSON.stringify(task.error));
    assert.equal(task.attempts, 1); assert.equal(task.generated, true);
    assert.equal(task.artifacts[0].sha256, expectedDigest);
    assert.equal(task.artifacts[0].attachmentId, "fixture-attachment");
    assert.equal(task.artifacts[0].messageId, "fixture-message");
    assert.equal(runtime.accept(event).duplicate, true);
    await runtime.idle();
    assert.deepEqual(calls, { invoke: 1, upload: 1, send: 1 });
  } finally {
    await runtime?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
