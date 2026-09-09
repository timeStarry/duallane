// Synthetic Node authority for one text block and the final block join.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { markdownToPlainText } from "../../apps/web/server/services/markdown.mjs";

const root = new URL("../../", import.meta.url);
const fixtureURL = new URL("apps/backend/internal/workspace/messages/testdata/markdown-summary.json", root);
const markdownPath = "apps/web/server/services/markdown.mjs";
const workspacePath = "apps/web/server/services/workspace.mjs";
const normalizeSource = (source) => source.replace(/\r\n?/g, "\n");
const digest = (source) => createHash("sha256").update(source).digest("hex");
const workspaceSource = normalizeSource(await readFile(new URL(workspacePath, root), "utf8"));

// Execute the actual private oracle functions, without importing the Workspace
// service (database, media and other unrelated runtime dependencies). Fail if
// their top-level declaration shape changes; never maintain a copied algorithm.
function functionSource(name) {
  const matches = [...workspaceSource.matchAll(new RegExp(`^function ${name}\\([^]*?^}`, "gm"))];
  assert.equal(matches.length, 1, `cannot extract Node ${name}`);
  return matches[0][0];
}
const oracleFunctions = ["buildPlainText", "fallbackTextSummary", "publicString"].map(functionSource);
const buildPlainText = compileFunction(
  `${oracleFunctions.join("\n\n")}\nreturn buildPlainText;`, ["markdownToPlainText"]
)(markdownToPlainText);

const examples = [
  ["empty", ""],
  ["plain", "hello 世界 😀"],
  ["leading space", " alpha"],
  ["trailing space", "alpha "],
  ["both boundaries", " \t**alpha**\n"],
  ["only whitespace", " \t\r\n "],
  ["JS BOM whitespace", "\ufeffalpha\ufeff"],
  ["JS separators", "\u2028alpha\u2029"],
  ["NBSP interior", "a\u00a0b"],
  ["NEXT LINE is not JS whitespace", "\u0085alpha\u0085"],
  ["ordinary underscore", "a_b"],
  ["formatting", "**bold** *italic* __strong__ _em_ ~~gone~~ ~single~"],
  ["unmatched markers", "left *open and a_b then `open"],
  ["escaped punctuation", String.raw`\*literal\* \_word\_ \[label\] \\`],
  ["entities", "&amp; &lt; &gt; &quot; &copy; &#65; &#x1F600;"],
  ["entity single decoding", String.raw`\&amp; &amp;lt; &notit; &copy &#0; &#128;`],
  ["inline link", "[label](https://x.test)"],
  ["formatted link", "[**bold** and `code`](https://x.test \"title\")"],
  ["reference link", "[label][ref]\n\n[ref]: https://x.test \"title\""],
  ["collapsed reference", "[ref][] and [ref]\n\n[ref]: https://x.test"],
  ["definition only fallback", "[ref]: https://x.test"],
  ["undefined reference", "[label][missing]"],
  ["URL autolink literal guard", "<https://x.test/a_b>"],
  ["email autolink literal guard", "<user@example.test>"],
  ["bare GFM autolinks", "https://x.test/a_b www.example.test user@example.test"],
  ["ATX heading", "## heading **bold** ##"],
  ["setext heading", "heading\n======="],
  ["quote and list", "> quoted\n\n- first\n- second"],
  ["nested quote", "> outer\n>\n> > inner\n>\n> tail"],
  ["nested list", "- outer\n  - inner\n  - last\n- end"],
  ["loose list", "1. first\n\n   second paragraph\n\n2. last"],
  ["task list", "- [x] done\n- [ ] todo\n- [X] also done"],
  ["thematic break", "---"],
  ["thematic breaks in text", "above\n\n***\n\nbelow"],
  ["soft and hard breaks", "one\ntwo  \nthree\\\nfour"],
  ["blank line collapse", "a\n\n\n\nb"],
  ["CR normalization", "a\r\nb\rc"],
  ["inline code", "`a_b *literal* &amp;`"],
  ["inline code multiline", "`` a\nb ``"],
  ["fenced Go code", "```go\nx := 1\n```"],
  ["fenced literal code", "~~~txt\na_b **x** &amp;\n~~~"],
  ["empty code fallback", "```\n```"],
  ["indented code disabled", "    **bold** and [label](https://x.test)"],
  ["indented continuation", "first\n\n    **second**\n    third"],
  ["inline HTML literal", " **bold** <span>raw</span> "],
  ["multiline HTML literal", "<div\nclass=\"x\">**text**</div>"],
  ["HTML comment removed", "before <!-- comment --> after"],
  ["HTML comment only fallback", "<!-- comment -->"],
  ["image literal", "before ![alt](https://x.test/a.png) **after**"],
  ["image reference omitted", "before ![alt][img] after\n\n[img]: https://x.test/a.png"],
  ["image reference only fallback", "![alt][img]\n\n[img]: https://x.test/a.png"],
  ["table literal", "| a | b |\n|---|---|\n| c | d |"],
  ["table literal boundaries", " \n| a | b |\n| :--- | ---: |\n| c | d |\n "],
  ["unclosed fence literal", "```go\na_b **x**"],
  ["short closing fence literal", "````js\na_b\n```"],
  ["mixed fence literal", "~~~js\na_b\n```"],
  ["quoted unclosed fence", "> ```go\n> a_b"],
  ["literal fallback preserves markers", "*** <tag> **x**"],
  ["null input character", "a\u0000b"]
];
const joinedExamples = [
  ["adjacent boundaries", ["alpha ", " beta"]],
  ["whitespace separator", ["alpha", " \t\n", "beta"]],
  ["outer trim only", [" alpha ", " beta "]],
  ["formatting across blocks stays separate", ["**left", "right**"]],
  ["literal fallback boundaries", ["alpha ", " <tag> ", " beta"]]
];

async function dependencyVersion(name) {
  const require = createRequire(new URL(markdownPath, root));
  let directory = path.dirname(require.resolve(name));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === name) return manifest.version;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `cannot find installed version of ${name}`);
    directory = parent;
  }
}

const fixture = {
  schemaVersion: 1,
  oracle: {
    source: markdownPath,
    sourceSHA256: digest(normalizeSource(await readFile(new URL(markdownPath, root), "utf8"))),
    workspaceSource: workspacePath,
    functions: Object.fromEntries(oracleFunctions.map((source, index) => [
      ["buildPlainText", "fallbackTextSummary", "publicString"][index], digest(source)
    ])),
    dependencies: Object.fromEntries(await Promise.all(
      ["mdast-util-to-string", "remark-gfm", "remark-parse", "strip-markdown", "unified"]
        .map(async (name) => [name, await dependencyVersion(name)])
    ))
  },
  cases: examples.map(([name, source]) => ({
    name, source, expected: buildPlainText([{ type: "text", text: source }])
  })),
  joins: joinedExamples.map(([name, sources]) => ({
    name, sources,
    expected: buildPlainText(sources.map((text) => ({ type: "text", text }))).trim()
  }))
};
const mode = process.argv[2] || "--check";
assert(process.argv.length <= 3 && ["--write", "--check"].includes(mode),
  "usage: node scripts/backend/workspace-markdown-contract.mjs --write|--check");
if (mode === "--write") {
  await mkdir(path.dirname(fileURLToPath(fixtureURL)), { recursive: true });
  await writeFile(fixtureURL, `${JSON.stringify(fixture, null, 2)}\n`);
} else {
  assert.deepEqual(JSON.parse(await readFile(fixtureURL, "utf8")), fixture,
    "Node Markdown fixture is stale; inspect the oracle change before running --write");
}
console.log(JSON.stringify({ status: "PASS", mode, cases: fixture.cases.length,
  joins: fixture.joins.length, node: process.versions.node }));
