import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createCardKitBuilder, DualLaneBotV2, verifyWebhookSignature } from "../src/v2.js";

test("createCardKitBuilder produces valid Card Kit v1 document", () => {
  const doc = createCardKitBuilder("card_demo", "approval")
    .header("部署审批", { subtitle: "v1.0.0", badge: "待审批", tone: "warning" })
    .markdown("确认发布到生产环境？")
    .fields([{ label: "分支", value: "feat/v1.0-architecture", short: true }])
    .divider()
    .actions([{ type: "button", actionId: "approve", label: "批准", style: "primary" }])
    .build();

  assert.equal(doc.version, 1);
  assert.equal(doc.cardId, "card_demo");
  assert.equal(doc.blocks.length, 5);
  assert.equal(doc.fallbackText, "部署审批");
});

test("verifyWebhookSignature validates HMAC-SHA256 signatures", () => {
  const secret = "whsec_test_123";
  const body = JSON.stringify({ event: "message.created", text: "hi" });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

  assert.equal(verifyWebhookSignature(body, `t=${ts},v1=${sig}`, secret), true);
  assert.equal(verifyWebhookSignature(body, `t=${ts},v1=deadbeef`, secret), false);
});

test("DualLaneBotV2.streamReply sends initial message and flushes PATCH edits", async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message: { id: "msg_stream_1" } }),
    };
  };

  const bot = new DualLaneBotV2({ baseUrl: "https://duallane.local", token: "dlb_test", fetchImpl: mockFetch });
  async function* gen() {
    yield "Hello ";
    yield "DualLane!";
  }

  const res = await bot.streamReply("conv_1", gen(), { flushIntervalMs: 0 });
  assert.equal(res.messageId, "msg_stream_1");
  assert.equal(res.text, "Hello DualLane!");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[calls.length - 1].method, "PATCH");
  assert.equal(calls[calls.length - 1].url, "https://duallane.local/api/bot/v2/messages/msg_stream_1");
  assert.equal(calls[calls.length - 1].body.plainText, "Hello DualLane!");
});
