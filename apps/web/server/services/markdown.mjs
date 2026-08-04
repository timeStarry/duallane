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

function removeUnsupportedSummaryNodes() {
  return (tree) => {
    const visit = (node) => {
      if (!Array.isArray(node?.children)) {
        return;
      }
      node.children = node.children
        .filter((child) => !unsupportedSummaryNodes.has(child?.type))
        .map((child) => {
          visit(child);
          return child;
        });
    };
    visit(tree);
  };
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(removeUnsupportedSummaryNodes)
  .use(stripMarkdown);

export function markdownToPlainText(value) {
  const source = typeof value === "string" ? value : "";
  if (!source) {
    return "";
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