import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import stripMarkdown from "strip-markdown";
import { unified } from "unified";

const unsupportedSummaryNodes = new Set([
  "image",
  "imageReference",
  "table"
]);

function preserveThematicBreaks() {
  return (tree) => {
    const visit = (node) => {
      if (!Array.isArray(node?.children)) {
        return;
      }
      node.children = node.children.map((child) => {
        if (child?.type === "thematicBreak") {
          return {
            type: "paragraph",
            children: [{ type: "text", value: "[分割线]" }]
          };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

function normalizeSummaryNodes() {
  return (tree) => {
    const visit = (node) => {
      if (!Array.isArray(node?.children)) {
        return;
      }
      node.children = node.children
        .filter((child) => !unsupportedSummaryNodes.has(child?.type))
        .map((child) => {
          if (child?.type === "code") {
            return {
              type: "paragraph",
              children: [{ type: "text", value: typeof child.value === "string" ? child.value : "" }]
            };
          }
          visit(child);
          return child;
        });
    };
    visit(tree);
  };
}

function disableIndentedCode() {
  const data = this.data();
  const extensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  extensions.push({ disable: { null: ["codeIndented"] } });
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(disableIndentedCode)
  .use(remarkGfm)
  .use(preserveThematicBreaks)
  .use(normalizeSummaryNodes)
  .use(stripMarkdown);

export function markdownToPlainText(value) {
  const source = typeof value === "string" ? value : "";
  if (!source) {
    return "";
  }
  if (hasUnclosedFence(source) || containsUnsupportedMarkdown(source)) {
    return normalizeLiteralSummary(source);
  }
  const tree = markdownProcessor.parse(source);
  const stripped = markdownProcessor.runSync(tree);
  const plainText = (stripped.children ?? [])
    .map((child) => toString(child, { includeImageAlt: false }).trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const leadingSpace = /^\s/.test(source) && plainText ? " " : "";
  const trailingSpace = /\s$/.test(source) && plainText ? " " : "";
  return leadingSpace + plainText + trailingSpace;
}

function hasUnclosedFence(source) {
  let fence = "";
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    if (!fence) fence = match[1];
    else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = "";
  }
  return Boolean(fence);
}

function containsUnsupportedMarkdown(source) {
  return /!\[[^\]\n]*\]\([^)\n]*\)/.test(source) ||
    /<\/?[A-Za-z][^>]*>/.test(source) ||
    /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(source);
}

function normalizeLiteralSummary(source) {
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
