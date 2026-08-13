import { describe, expect, it } from "vitest";
import {
  parseWorkspaceTopicSyntax,
  WORKSPACE_TOPIC_BODY_MAX_BYTES,
  WORKSPACE_TOPIC_BODY_MAX_CODE_POINTS,
  WORKSPACE_TOPIC_TITLE_MAX_CODE_POINTS
} from "./workspace-topic-parser.mjs";

describe("Workspace topic syntax parser", () => {
  it("parses a valid topic at the first non-whitespace position", () => {
    expect(parseWorkspaceTopicSyntax("  #[设置页优化](希望将设置拆成四个分组。)  "))
      .toEqual({ title: "设置页优化", description: "希望将设置拆成四个分组。" });
  });

  it("preserves multiline body content and balances nested parentheses", () => {
    expect(parseWorkspaceTopicSyntax("#[括号](第一行\n第二行 (含有一组括号)\n第三行)"))
      .toEqual({ title: "括号", description: "第一行\n第二行 (含有一组括号)\n第三行" });
  });

  it("does not parse ordinary links, images, or middle-of-message syntax", () => {
    for (const source of [
      "[普通链接](https://example.test)",
      "![图片](https://example.test/image.png)",
      "前置文字 #[标题](正文)",
      "\n\t普通文字 #[标题](正文)"
    ]) {
      expect(parseWorkspaceTopicSyntax(source)).toBeNull();
    }
  });

  it("rejects incomplete or unbalanced syntax", () => {
    for (const source of [
      "#[标题](正文",
      "#[标题](正文))",
      "#[标题](正文 (未闭合)",
      "#[标题]正文",
      "#[标题](正文)尾随文本"
    ]) {
      expect(parseWorkspaceTopicSyntax(source)).toBeNull();
    }
  });

  it("rejects empty and invalid titles", () => {
    expect(parseWorkspaceTopicSyntax("#[](正文)")).toBeNull();
    expect(parseWorkspaceTopicSyntax("#[含有\n换行](正文)")).toBeNull();
    expect(parseWorkspaceTopicSyntax("#[含有[方括号](正文)")).toBeNull();
    expect(parseWorkspaceTopicSyntax("#[   ](正文)")).toBeNull();
    expect(parseWorkspaceTopicSyntax(`#[${"字".repeat(WORKSPACE_TOPIC_TITLE_MAX_CODE_POINTS + 1)}](正文)`)).toBeNull();
  });

  it("rejects empty and over-limit bodies", () => {
    expect(parseWorkspaceTopicSyntax("#[标题](   )")).toBeNull();
    expect(parseWorkspaceTopicSyntax(`#[标题](${"字".repeat(WORKSPACE_TOPIC_BODY_MAX_CODE_POINTS + 1)})`)).toBeNull();

    const byteHeavyBody = "😀".repeat(Math.ceil(WORKSPACE_TOPIC_BODY_MAX_BYTES / 4) + 1);
    expect(Buffer.byteLength(byteHeavyBody, "utf8")).toBeGreaterThan(WORKSPACE_TOPIC_BODY_MAX_BYTES);
    expect(parseWorkspaceTopicSyntax(`#[标题](${byteHeavyBody})`)).toBeNull();
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    const title = "😀".repeat(WORKSPACE_TOPIC_TITLE_MAX_CODE_POINTS);
    expect(parseWorkspaceTopicSyntax(`#[${title}](正文)`)).toEqual({ title, description: "正文" });
  });

  it("returns null without coercing non-string input", () => {
    expect(parseWorkspaceTopicSyntax(null)).toBeNull();
    expect(parseWorkspaceTopicSyntax({})).toBeNull();
  });
});
