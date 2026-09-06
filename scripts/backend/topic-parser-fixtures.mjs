import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseWorkspaceTopicSyntax } from "../../apps/web/server/services/workspace-topic-parser.mjs";

const fixtureURL = new URL("../../apps/backend/internal/workspace/topics/testdata/parser-node.json", import.meta.url);
const examples = [
  ["balanced", ["  #[资料页](先讨论 (通知)，再讨论链接。)  "]],
  ["multiple text blocks", ["#[资料", "页](正文)"]],
  ["missing close", ["#[标题](正文"]],
  ["non-leading", ["prefix #[标题](正文)"]],
  ["trailing text", ["#[标题](正文) text"]],
  ["empty body", ["#[标题]( \n )"]],
  ["BOM", ["\ufeff#[\ufeff标题\ufeff](\ufeff正文\ufeff)\ufeff"]],
  ["NEXT LINE prefix is not whitespace", ["\u0085#[标题](正文)"]],
  ["NEXT LINE retained", ["#[\u0085标题\u0085](\u0085正文\u0085)"]],
  ["line separator", ["\u2028#[标题](正文)\u2029"]],
  ["title brackets", ["#[[标题]](正文)"]],
  ["title newline", ["#[标\n题](正文)"]],
  ["40 astral title", ["#[", ["😀", 40], "](正文)"]],
  ["41 astral title", ["#[", ["😀", 41], "](正文)"]],
  ["30000 body", ["#[标题](", ["a", 30000], ")"]],
  ["30001 body", ["#[标题](", ["a", 30001], ")"]],
  ["raw body bound before trim", ["#[标题](", [" ", 30000], "a)"]],
  ["exact byte bound", ["#[标题](", ["😀", 25600], ")"]],
  ["byte overflow", ["#[标题](", ["😀", 25601], ")"]],
  ["empty marker", ["#[]()"]]
];

const fixtures = examples.map(([name, parts]) => {
  const source = parts.map(part => Array.isArray(part) ? part[0].repeat(part[1]) : part).join("");
  const intent = parseWorkspaceTopicSyntax(source);
  return { name, parts, expected: intent ? {
    title: intent.title,
    descriptionSHA256: createHash("sha256").update(intent.description).digest("hex")
  } : null };
});

if (process.argv.includes("--write")) {
  await writeFile(fixtureURL, `${JSON.stringify(fixtures, null, 2)}\n`);
} else {
  assert.deepEqual(JSON.parse(await readFile(fixtureURL, "utf8")), fixtures);
}
console.log(JSON.stringify({ status: "PASS", cases: fixtures.length, oracle: "Node parseWorkspaceTopicSyntax" }));
