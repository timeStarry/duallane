import { Children, Fragment, isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { renderMessageParts } from "./emotes";

const disallowedElements = ["table", "thead", "tbody", "tr", "th", "td"];
const disableIndentedCode: Plugin = function () {
  const data = this.data() as ReturnType<typeof this.data> & { micromarkExtensions?: unknown[] };
  const extensions = (data.micromarkExtensions ??= []);
  (extensions as unknown[]).push({ disable: { null: ["codeIndented"] } });
};

function renderMarkdownChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child, index) => {
    if (typeof child === "string") {
      return <Fragment key={index}>{renderMessageParts(child)}</Fragment>;
    }
    if (isValidElement<{ children?: ReactNode }>(child) && child.props.children) {
      return child;
    }
    return child;
  });
}

function safeLinkUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}

function WorkspaceMarkdownImage({ alt, src }: { alt?: string; src?: string }) {
  const [failed, setFailed] = useState(false);
  const label = alt?.trim() || "图片";
  if (!src || failed) {
    return <span className="workspace-markdown-image-fallback">{label}</span>;
  }
  return (
    <span className="workspace-markdown-image-frame">
      <img
        src={src}
        alt={label}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

export function WorkspaceMarkdown({ children }: { children: string }) {
  const prepared = prepareWorkspaceMarkdown(children);
  if (prepared.plain) {
    return <div className="workspace-markdown workspace-markdown-plain">{renderPlainSource(prepared.source)}</div>;
  }
  return (
    <div className="workspace-markdown">
      <ReactMarkdown
      disallowedElements={disallowedElements}
      remarkPlugins={[disableIndentedCode, remarkGfm]}
      skipHtml
      unwrapDisallowed={false}
      urlTransform={safeLinkUrl}
      components={{
        a: ({ children: label, href }) => (
          <a href={href} rel="noopener noreferrer" target="_blank">
            {renderMarkdownChildren(label)}
          </a>
        ),
        blockquote: ({ children: content }) => <blockquote>{renderMarkdownChildren(content)}</blockquote>,
        code: ({ children: content, className }) => <code className={className}>{content}</code>,
        del: ({ children: content }) => <del>{renderMarkdownChildren(content)}</del>,
        em: ({ children: content }) => <em>{renderMarkdownChildren(content)}</em>,
        h1: ({ children: content }) => <h3>{renderMarkdownChildren(content)}</h3>,
        h2: ({ children: content }) => <h3>{renderMarkdownChildren(content)}</h3>,
        h3: ({ children: content }) => <h3>{renderMarkdownChildren(content)}</h3>,
        h4: ({ children: content }) => <h4>{renderMarkdownChildren(content)}</h4>,
        h5: ({ children: content }) => <h4>{renderMarkdownChildren(content)}</h4>,
        h6: ({ children: content }) => <h4>{renderMarkdownChildren(content)}</h4>,
        hr: () => <hr className="workspace-markdown-divider" />,
        img: ({ alt, src }) => <WorkspaceMarkdownImage alt={alt} src={src} />,
        li: ({ children: content }) => <li>{renderMarkdownChildren(content)}</li>,
        ol: ({ children: content }) => <ol>{renderMarkdownChildren(content)}</ol>,
        p: ({ children: content }) => <p>{renderMarkdownChildren(content)}</p>,
        pre: ({ children: content }) => <pre>{content}</pre>,
        strong: ({ children: content }) => <strong>{renderMarkdownChildren(content)}</strong>,
        ul: ({ children: content }) => <ul>{renderMarkdownChildren(content)}</ul>
      }}
    >
      {prepared.source}
      </ReactMarkdown>
    </div>
  );
}

export function prepareWorkspaceMarkdown(source: string) {
  const normalized = source.replace(/\r\n?/g, "\n");
  if (hasUnclosedFence(normalized) || containsUnsupportedMarkdown(normalized) || normalized.split("\n").some((line) => /^ {4}/.test(line))) {
    return { source: normalized, plain: true };
  }
  const lines = normalized.split("\n");
  const tableLines = new Set<number>();
  for (let index = 1; index < lines.length; index += 1) {
    if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index])) {
      tableLines.add(index - 1);
      tableLines.add(index);
      if (index + 1 < lines.length && lines[index + 1].includes("|")) tableLines.add(index + 1);
    }
  }
  const escaped = lines.map((line, index) => {
    let value = tableLines.has(index) ? line.replace(/\|/g, "\\|") : line;
    value = value.replace(/<(?=\/?[A-Za-z][^>]*>)/g, "\\<");
    return value;
  }).join("\n");
  return { source: escaped, plain: false };
}

function hasUnclosedFence(source: string) {
  let fence = "";
  for (const line of source.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    if (!fence) fence = match[1];
    else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = "";
  }
  return Boolean(fence);
}

function renderPlainSource(source: string) {
  return renderMessageParts(source);
}

function containsUnsupportedMarkdown(source: string) {
  return /<\/?[A-Za-z][^>]*>/.test(source) ||
    /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(source);
}
