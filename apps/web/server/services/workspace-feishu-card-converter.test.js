import { describe, expect, it } from "vitest";
import {
  FEISHU_CARD_TYPE,
  convertFeishuCard,
  validateConvertedFeishuCard
} from "./workspace-feishu-card-converter.mjs";

function exampleCard() {
  return {
    config: { version: "1.0", wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "发布确认" }, template: "blue" },
    elements: [
      { tag: "markdown", content: "查看 [公开说明](https://example.com/help)" },
      { tag: "hr" },
      { tag: "note", elements: [{ tag: "plain_text", content: "操作将被审计" }] },
      {
        tag: "action",
        actions: [{ tag: "button", text: { tag: "plain_text", content: "确认" }, type: "primary", value: { action_id: "confirm", data: { source: "review" } } }]
      },
      {
        tag: "column_set",
        columns: [
          { tag: "column", width: "weighted", weight: 1, elements: [{ tag: "div", text: { tag: "plain_text", content: "左侧" } }] },
          { tag: "column", width: "auto", elements: [{ tag: "div", text: { tag: "lark_md", content: "右侧" } }] }
        ]
      }
    ]
  };
}

describe("controlled Feishu card conversion", () => {
  it("maps the supported subset to the canonical Workspace payload", () => {
    const converted = convertFeishuCard(exampleCard());
    expect(converted).toMatchObject({
      cardType: FEISHU_CARD_TYPE,
      schemaVersion: 1,
      fallbackText: "发布确认",
      payload: {
        format: "duallane.feishu-card.v1",
        config: { version: "1.0", wideScreen: true },
        header: { title: "发布确认", tone: "info" }
      }
    });
    expect(converted.payload.elements[3]).toEqual({
      type: "actions",
      buttons: [{ type: "button", label: "确认", actionId: "confirm", style: "primary", data: { source: "review" } }]
    });
    expect(validateConvertedFeishuCard(converted.payload)).toEqual(converted.payload);
  });

  it.each([
    [{ elements: [{ tag: "div", text: { tag: "plain_text", content: "<script>alert(1)</script>" } }] }, "card.unsafe_content"],
    [{ elements: [{ tag: "markdown", content: "[internal](https://127.0.0.1/admin)" }] }, "card.private_url"],
    [{ elements: [{ tag: "markdown", content: "[internal](https://localhost./admin)" }] }, "card.private_url"],
    [{ elements: [{ tag: "markdown", content: "[internal](https://[::ffff:127.0.0.1]/admin)" }] }, "card.private_url"],
    [{ elements: [{ tag: "markdown", content: "[cleartext](http://example.com/)" }] }, "card.url_forbidden"],
    [{ elements: [{ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "运行" }, value: { action_id: "run_script" } }] }] }, "card.unknown_action"],
    [{ elements: [{ tag: "action", actions: [
      { tag: "button", text: { tag: "plain_text", content: "确认" }, value: { action_id: "confirm" } },
      { tag: "button", text: { tag: "plain_text", content: "再次确认" }, value: { action_id: "confirm" } }
    ] }] }, "card.feishu_duplicate_action"],
    [{ elements: [{ tag: "img", img_key: "remote" }] }, "card.feishu_unknown_element"],
    [{ style: { color: "red" }, elements: [{ tag: "hr" }] }, "card.feishu_unknown_field"]
  ])("rejects unsafe or unsupported input %#", (input, code) => {
    expect(() => convertFeishuCard(input)).toThrow(expect.objectContaining({ code }));
  });

  it("enforces card depth, node, text, and serialized payload limits", () => {
    expect(() => convertFeishuCard({ elements: [{ tag: "div", text: { tag: "plain_text", content: "x".repeat(13 * 1024) } }] }))
      .toThrow(expect.objectContaining({ code: "card.text_too_large" }));
    expect(() => convertFeishuCard({ elements: Array.from({ length: 81 }, () => ({ tag: "hr" })) }))
      .toThrow(expect.objectContaining({ code: "card.payload_too_complex" }));
  });

  it("rejects malformed canonical payloads with a stable validation error", () => {
    expect(() => validateConvertedFeishuCard({ format: "duallane.feishu-card.v1", config: {}, header: null, elements: "not-an-array" }))
      .toThrow(expect.objectContaining({ code: "card.feishu_elements_required" }));
  });
});
