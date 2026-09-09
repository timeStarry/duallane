import test from "node:test";
import assert from "node:assert/strict";
import { convertFeishuCard } from "../../apps/web/server/services/workspace-feishu-card-converter.mjs";

const privateURLCases = [
  ["dotted-short-form", "127.1"],
  ["decimal-form", "2130706433"],
  ["hex-form", "0x7f000001"],
  ["octal-dotted-form", "0177.0.0.1"],
  ["public-mapped-ipv6", "[::ffff:8.8.8.8]"]
];

for (const [name, host] of privateURLCases) {
  test(`Node Feishu raw URL rejects ${name}`, () => {
    const raw = String.raw`{"elements":[{"tag":"markdown","content":"[synthetic](https://${host}/boundary)"}]}`;
    assert.throws(() => convertFeishuCard(JSON.parse(raw)), (error) => error?.code === "card.private_url");
  });
}

test("Node Feishu raw JSON keeps duplicate-key order, lone UTF-16 units, and ECMAScript trim", () => {
  const raw = String.raw`{"header":{"title":{"tag":"plain_text","content":"\ud800 title \u0085"}},"elements":[{"tag":"action","actions":[{"tag":"button","text":"\ud800 label","value":{"action_id":"confirm","data":{"z":"first","0":"zero","z":"last","a":"first","surrogate":"\ud800"}}}]}]}`;
  const result = convertFeishuCard(JSON.parse(raw));
  const expectedPayload = String.raw`{"format":"duallane.feishu-card.v1","config":{"version":"1.0","wideScreen":false},"header":{"title":"\ud800 title `
    + "\u0085"
    + String.raw`","tone":"neutral"},"elements":[{"type":"actions","buttons":[{"type":"button","label":"\ud800 label","actionId":"confirm","style":"default","data":{"0":"zero","z":"last","a":"first","surrogate":"\ud800"}}]}]}`;
  assert.equal(JSON.stringify(result.payload), expectedPayload);
  assert.equal(result.fallbackText, "\ud800 title \u0085");
});

test("Node Feishu raw JSON preserves lone UTF-16 units in markdown text and fallback", () => {
  const raw = String.raw`{"elements":[{"tag":"markdown","content":"\ud800 markdown"}]}`;
  const result = convertFeishuCard(JSON.parse(raw));
  assert.equal(JSON.stringify(result.payload.elements[0].text), String.raw`"\ud800 markdown"`);
  assert.equal(result.fallbackText, "\ud800 markdown");
});

for (const value of ["1e999", "-1e999"]) {
  test(`Node Feishu raw JSON rejects non-finite button data ${value}`, () => {
    const raw = String.raw`{"elements":[{"tag":"action","actions":[{"tag":"button","text":"synthetic","value":{"action_id":"confirm","data":{"number":${value}}}}]}]}`;
    assert.throws(() => convertFeishuCard(JSON.parse(raw)), (error) => error?.code === "card.invalid_payload");
  });
}

test("Node Feishu raw JSON preserves validation priority before non-finite data", () => {
  const raw = String.raw`{"elements":[{"tag":"action","actions":[{"tag":"button","text":"<script>synthetic</script>","value":{"action_id":"confirm","data":{"number":1e999}}}]}]}`;
  assert.throws(() => convertFeishuCard(JSON.parse(raw)), (error) => error?.code === "card.unsafe_content");
});

test("Node Feishu raw JSON accepts a public HTTPS URL", () => {
  const raw = String.raw`{"elements":[{"tag":"markdown","content":"[synthetic](https://example.com/docs)"}]}`;
  const result = convertFeishuCard(JSON.parse(raw));
  assert.equal(result.payload.elements[0].text, "[synthetic](https://example.com/docs)");
});
