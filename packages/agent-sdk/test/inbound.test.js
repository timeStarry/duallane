import assert from "node:assert/strict";
import test from "node:test";
import { prepareAgentInputs } from "../src/inbound.js";
import { validateArtifactBytes } from "../src/media.js";
import { officeEnvelopeFixture } from "../test-support/office-envelope-fixture.js";

function fixture() {
  const message = { id: "m1", content: { blocks: [{ type: "attachment", attachmentId: "a1" }] } };
  return { event: { conversationId: "c1" }, conversation: { id: "c1" }, triggerMessage: message, context: { messages: [message] }, scopes: ["messages:read_context", "files:read_content"] };
}

test("only an authorized trigger attachment becomes bounded untrusted model input", async () => {
  const input = fixture();
  const calls = [];
  input.context.messages.push({ id: "history", content: { blocks: [{ type: "attachment", attachmentId: "private" }] } });
  const result = await prepareAgentInputs({ ...input, client: { readAttachment: async (request) => {
    calls.push(request); return { bytes: Buffer.from("reference text"), mimeType: "text/plain" };
  } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messageId, "m1");
  assert.equal(result[0].data, "reference text");
  assert.equal(result[0].trust, "untrusted-attachment");
});

test("scope, source message, and conversation mismatch do not read bytes", async () => {
  const client = { readAttachment: async () => assert.fail("unauthorized fetch") };
  const missingScope = await prepareAgentInputs({ ...fixture(), client, scopes: [] });
  assert.equal(missingScope[0].code, "input.attachment_scope_required");
  assert.deepEqual(await prepareAgentInputs({ ...fixture(), client, context: { messages: [] } }), []);
  assert.deepEqual(await prepareAgentInputs({ ...fixture(), client, conversation: { id: "other" } }), []);
});

test("revoked attachments expose only a stable unavailable code", async () => {
  const result = await prepareAgentInputs({ ...fixture(), client: { readAttachment: async () => {
    throw Object.assign(new Error("secret/path token private text"), { code: "bot.context_denied" });
  } } });
  assert.equal(result[0].status, "unavailable");
  assert.equal(result[0].code, "bot.context_denied");
  assert.doesNotMatch(JSON.stringify(result), /secret|token|private/);
});

test("preview mode uses its independent scope and bounded text response", async () => {
  const result = await prepareAgentInputs({ ...fixture(), scopes: ["messages:read_context", "files:read_preview"], client: { readAttachment: async (request) => {
    assert.equal(request.mode, "preview"); assert.equal(request.maxBytes, 65536);
    return { bytes: Buffer.from("preview"), mimeType: "text/plain" };
  } } });
  assert.equal(result[0].encoding, "utf8");
});

test("invalid attachment bytes consume the shared transfer budget", async () => {
  const input = fixture();
  input.triggerMessage.content.blocks.push({ type: "attachment", attachmentId: "a2" });
  let reads = 0;
  await assert.rejects(prepareAgentInputs({ ...input, client: { readAttachment: async () => {
    reads += 1; return { bytes: Buffer.alloc(10 * 1024 * 1024), mimeType: "image/png" };
  } } }), (error) => error.code === "input.attachment_limit");
  assert.equal(reads, 1);
});

test("authorized Markdown and Office attachments round-trip as untrusted inputs without expanding public URL formats", async () => {
  const document = officeEnvelopeFixture();
  const officeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  for (const [bytes, mimeType, encoding, kind] of [
    [Buffer.from("# 已授权的说明\n\n内容"), "text/markdown", "utf8", "text"],
    [document, officeType, "base64", "document"],
  ]) {
    const inputs = await prepareAgentInputs({ ...fixture(), client: { async readAttachment() { return { bytes, mimeType }; } } });
    assert.equal(inputs[0].status, "available"); assert.equal(inputs[0].trust, "untrusted-attachment");
    assert.equal(inputs[0].encoding, encoding); assert.equal(inputs[0].kind, kind);
    assert.deepEqual(Buffer.from(inputs[0].data, encoding), bytes);
    assert.throws(() => validateArtifactBytes(bytes, mimeType, { source: "https" }), { code: "artifact.unsupported_type" });
  }
  const invalid = await prepareAgentInputs({ ...fixture(), client: { async readAttachment() { return { bytes: Buffer.from("not an office file"), mimeType: officeType }; } } });
  assert.equal(invalid[0].status, "unavailable"); assert.equal(invalid[0].code, "artifact.type_mismatch");
  assert.equal(invalid[0].data, undefined);
});
